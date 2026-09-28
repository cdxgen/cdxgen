import assert from "node:assert";
import crypto from "node:crypto";

import { describe, it } from "poku";

import {
  checkSignatureEntries,
  displayValue,
  generateSigningKeyPair,
  loadSharedSecret,
  loadVerificationKey,
  signBom,
  verifyBom,
  verifyNode,
} from "./bomSigner.js";

const pemPair = (type, options = {}) =>
  crypto.generateKeyPairSync(type, {
    ...options,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

const rsaKeys = pemPair("rsa", { modulusLength: 2048 });
const otherRsaKeys = pemPair("rsa", { modulusLength: 2048 });
const rsaPssKeys = pemPair("rsa-pss", { modulusLength: 2048 });
const ecKeys = pemPair("ec", { namedCurve: "prime256v1" });
const ec384Keys = pemPair("ec", { namedCurve: "secp384r1" });
const ec521Keys = pemPair("ec", { namedCurve: "secp521r1" });
const ed25519Keys = pemPair("ed25519");
const ed448Keys = pemPair("ed448");
const hmacSecret = crypto.randomBytes(64);

// A post-quantum key when this Node.js build supports one, otherwise another
// key type that is equally foreign to every JSF algorithm name.
let foreignKeys;
let foreignKeyType;
try {
  foreignKeys = pemPair("ml-dsa-65");
  foreignKeyType = "ml-dsa-65";
} catch {
  foreignKeys = pemPair("x25519");
  foreignKeyType = "x25519";
}

const ALGORITHM_KEYS = {
  RS256: rsaKeys,
  RS384: rsaKeys,
  RS512: rsaKeys,
  PS256: rsaKeys,
  PS384: rsaKeys,
  PS512: rsaKeys,
  ES256: ecKeys,
  ES384: ec384Keys,
  ES512: ec521Keys,
  Ed25519: ed25519Keys,
  Ed448: ed448Keys,
};

const DIGESTS = {
  256: "sha256",
  384: "sha384",
  512: "sha512",
};

const generateMockBom = () => ({
  bomFormat: "CycloneDX",
  specVersion: "1.6",
  components: [{ type: "library", name: "cdxgen", version: "1.0.0" }],
  services: [{ name: "acme-service", endpoints: ["https://appthreat.com"] }],
  annotations: [{ subject: "ref-1", annotator: { name: "System" } }],
});

const rootOnly = {
  signComponents: false,
  signServices: false,
  signAnnotations: false,
};

const roundTrip = (value) => JSON.parse(JSON.stringify(value));

// Independent RFC 8785 canonicalizer for building and checking documents the
// way any JSF implementation would.
function jcs(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(jcs).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${jcs(value[key])}`)
    .join(",")}}`;
}

const withoutValue = ({ value: _value, ...rest }) => rest;

function withoutSignature(node) {
  const { signature: _signature, ...content } = node;
  return content;
}

function rawSign(data, alg, key) {
  const bytes = Buffer.from(data, "utf8");
  const size = alg.slice(2);
  if (alg.startsWith("HS")) {
    return crypto.createHmac(DIGESTS[size], key).update(bytes).digest();
  }
  if (alg.startsWith("Ed")) {
    return crypto.sign(null, bytes, key);
  }
  if (alg.startsWith("ES")) {
    return crypto.sign(DIGESTS[size], bytes, {
      key,
      dsaEncoding: "ieee-p1363",
    });
  }
  if (alg.startsWith("PS")) {
    return crypto.sign(DIGESTS[size], bytes, {
      key,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    });
  }
  return crypto.sign(DIGESTS[size], bytes, key);
}

// Builds a single JSF signature exactly as a third party would, so tests can
// hand the verifier documents that cdxgen itself refuses to produce.
function forgeSingle(node, block, key, rawAlg = block.algorithm) {
  const content = withoutSignature(node);
  const value = rawSign(
    jcs({ ...content, signature: block }),
    rawAlg,
    key,
  ).toString("base64url");
  return { ...content, signature: { ...block, value } };
}

// Builds a signature in the format of cdxgen 12.2.0 - 12.8.4, which left the
// whole signature property out of the signed data.
function forgeContentOnly(node, block, key, rawAlg = block.algorithm) {
  const content = withoutSignature(node);
  const value = rawSign(jcs(content), rawAlg, key).toString("base64url");
  return { ...content, signature: { ...block, value } };
}

function jsfVerifies(data, entry, publicKey) {
  const alg = entry.algorithm;
  const size = alg.slice(2);
  const bytes = Buffer.from(data, "utf8");
  const signature = Buffer.from(entry.value, "base64url");
  if (alg.startsWith("Ed")) {
    return crypto.verify(null, bytes, publicKey, signature);
  }
  if (alg.startsWith("ES")) {
    return crypto.verify(
      DIGESTS[size],
      bytes,
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      signature,
    );
  }
  if (alg.startsWith("PS")) {
    return crypto.verify(
      DIGESTS[size],
      bytes,
      {
        key: publicKey,
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
      },
      signature,
    );
  }
  return crypto.verify(DIGESTS[size], bytes, publicKey, signature);
}

function reasonsFor(node, key, options = {}) {
  const reasons = [];
  const match = verifyNode(node, key, { ...options, reasons });
  return { match, reasons };
}

describe("bomSigner round trips", () => {
  for (const [alg, keys] of Object.entries(ALGORITHM_KEYS)) {
    it(`${alg} signs the root and nested elements and survives JSON serialization`, () => {
      const signed = roundTrip(
        signBom(generateMockBom(), {
          privateKey: keys.privateKey,
          algorithm: alg,
          keyId: `${alg}-key`,
        }),
      );
      assert.strictEqual(signed.signature.algorithm, alg);
      assert.strictEqual(signed.signature.keyId, `${alg}-key`);
      for (const field of ["components", "services", "annotations"]) {
        assert.strictEqual(signed[field][0].signature.algorithm, alg);
      }
      assert.strictEqual(verifyBom(signed, keys.publicKey), signed.signature);
    });
  }

  for (const alg of ["HS256", "HS384", "HS512"]) {
    it(`${alg} signs and verifies with a shared secret`, () => {
      const signed = roundTrip(
        signBom(generateMockBom(), { privateKey: hmacSecret, algorithm: alg }),
      );
      assert.strictEqual(signed.signature.algorithm, alg);
      assert.ok(verifyBom(signed, loadSharedSecret(hmacSecret)));
      assert.strictEqual(
        verifyBom(signed, loadSharedSecret(crypto.randomBytes(64))),
        false,
        "A different secret must not verify",
      );
    });
  }

  it("accepts KeyObjects and derives the public key from a private key", () => {
    const privateKey = crypto.createPrivateKey(ed25519Keys.privateKey);
    const signed = signBom(generateMockBom(), {
      privateKey,
      algorithm: "Ed25519",
    });
    assert.ok(verifyBom(signed, crypto.createPublicKey(ed25519Keys.publicKey)));
    assert.ok(verifyBom(signed, ed25519Keys.privateKey));
    assert.ok(verifyBom(signed, privateKey));
  });

  it("PS signatures use a salt as long as the digest, as JWA requires", () => {
    for (const alg of ["PS256", "PS384", "PS512"]) {
      const signed = signBom(generateMockBom(), {
        privateKey: rsaKeys.privateKey,
        algorithm: alg,
        ...rootOnly,
      });
      const data = jcs({
        ...withoutSignature(signed),
        signature: withoutValue(signed.signature),
      });
      assert.ok(jsfVerifies(data, signed.signature, rsaKeys.publicKey), alg);
    }
  });

  it("PS algorithms accept rsa-pss keys", () => {
    const signed = signBom(generateMockBom(), {
      privateKey: rsaPssKeys.privateKey,
      algorithm: "PS256",
    });
    assert.ok(verifyBom(signed, rsaPssKeys.publicKey));
  });

  it("verification fails with the wrong key", () => {
    const signed = signBom(generateMockBom(), {
      privateKey: rsaKeys.privateKey,
      algorithm: "RS512",
    });
    assert.strictEqual(verifyBom(signed, otherRsaKeys.publicKey), false);
    const { reasons } = reasonsFor(signed, otherRsaKeys.publicKey);
    assert.deepStrictEqual(reasons, [
      "The RS512 signature does not verify with this key: the signed content changed, or a different key made it.",
    ]);
  });

  it("detects content tampering in the root and in nested elements", () => {
    const signed = signBom(generateMockBom(), {
      privateKey: ecKeys.privateKey,
      algorithm: "ES256",
    });
    const rootTamper = structuredClone(signed);
    rootTamper.specVersion = "1.7";
    assert.strictEqual(verifyBom(rootTamper, ecKeys.publicKey), false);
    const nestedTamper = structuredClone(signed);
    nestedTamper.components[0].version = "6.6.6";
    assert.strictEqual(
      verifyNode(nestedTamper.components[0], ecKeys.publicKey),
      false,
    );
    assert.strictEqual(verifyBom(nestedTamper, ecKeys.publicKey), false);
  });

  it("canonicalizes in-memory values the way JSON serialization sees them", () => {
    const bom = generateMockBom();
    bom.metadata = {
      timestamp: new Date("2026-01-02T03:04:05.000Z"),
      skipped: undefined,
      score: Number.NaN,
      list: [undefined, 1],
    };
    const signed = signBom(bom, {
      privateKey: ed25519Keys.privateKey,
      algorithm: "Ed25519",
    });
    assert.ok(verifyBom(signed, ed25519Keys.publicKey));
    assert.ok(verifyBom(roundTrip(signed), ed25519Keys.publicKey));
  });

  it("stores a numeric keyId as a string", () => {
    const signed = signBom(generateMockBom(), {
      privateKey: ed25519Keys.privateKey,
      algorithm: "Ed25519",
      keyId: 2026,
      ...rootOnly,
    });
    assert.strictEqual(signed.signature.keyId, "2026");
    assert.ok(verifyNode(signed, ed25519Keys.publicKey));
  });
});

describe("bomSigner binds the declared algorithm to the key", () => {
  it(`refuses to label a ${foreignKeyType} signature as Ed25519`, () => {
    assert.throws(
      () =>
        signBom(generateMockBom(), {
          privateKey: foreignKeys.privateKey,
          algorithm: "Ed25519",
        }),
      new RegExp(
        `Algorithm Ed25519 requires an ed25519 key, but the key is ${foreignKeyType}`,
      ),
    );
  });

  const signingMismatches = [
    ["Ed25519", ed448Keys, /requires an ed25519 key, but the key is ed448/],
    ["Ed448", ed25519Keys, /requires an ed448 key, but the key is ed25519/],
    ["ES256", rsaKeys, /requires an ec \(prime256v1\) key, but the key is rsa/],
    [
      "ES256",
      ec384Keys,
      /requires an ec \(prime256v1\) key, but the key is ec \(secp384r1\)/,
    ],
    ["ES512", ecKeys, /requires an ec \(secp521r1\) key/],
    ["RS256", ecKeys, /requires an rsa key, but the key is ec/],
    ["RS256", rsaPssKeys, /requires an rsa key, but the key is rsa-pss/],
    ["PS256", ed25519Keys, /requires an rsa or rsa-pss key/],
  ];
  for (const [alg, keys, message] of signingMismatches) {
    it(`refuses to sign ${alg} with the wrong key type`, () => {
      const bom = generateMockBom();
      const before = structuredClone(bom);
      assert.throws(
        () => signBom(bom, { privateKey: keys.privateKey, algorithm: alg }),
        message,
      );
      assert.deepStrictEqual(bom, before, "A refused request changes nothing");
    });
  }

  it("refuses to use a public or private key as an HMAC secret when signing", () => {
    for (const material of [
      rsaKeys.privateKey,
      rsaKeys.publicKey,
      Buffer.from(rsaKeys.publicKey),
      crypto.createPrivateKey(rsaKeys.privateKey),
    ]) {
      assert.throws(
        () =>
          signBom(generateMockBom(), {
            privateKey: material,
            algorithm: "HS256",
          }),
        /HMAC signatures|looks like a public or private key/,
      );
    }
  });

  it("refuses a shared secret or a public key for asymmetric signing", () => {
    assert.throws(
      () =>
        signBom(generateMockBom(), {
          privateKey: crypto.createSecretKey(hmacSecret),
          algorithm: "RS256",
        }),
      /requires an rsa key, but the key is a shared secret/,
    );
    assert.throws(
      () =>
        signBom(generateMockBom(), {
          privateKey: crypto.createPublicKey(rsaKeys.publicKey),
          algorithm: "RS256",
        }),
      /needs a private key, but a public key was supplied/,
    );
    assert.throws(
      () =>
        signBom(generateMockBom(), {
          privateKey: "not a key",
          algorithm: "RS256",
        }),
      /Unable to load the signing key/,
    );
  });

  it(`rejects a ${foreignKeyType} signature labelled Ed25519`, () => {
    if (foreignKeyType !== "ml-dsa-65") {
      // x25519 cannot sign, so the relabelled signature cannot be built.
      return;
    }
    const forged = forgeSingle(
      generateMockBom(),
      { algorithm: "Ed25519" },
      foreignKeys.privateKey,
      "Ed25519",
    );
    assert.ok(
      Buffer.from(forged.signature.value, "base64url").length > 64,
      "The value is an ML-DSA signature",
    );
    const { match, reasons } = reasonsFor(forged, foreignKeys.publicKey);
    assert.strictEqual(match, false);
    assert.deepStrictEqual(reasons, [
      "Algorithm Ed25519 requires an ed25519 key, but the key is ml-dsa-65.",
    ]);
  });

  it("rejects Ed25519 and Ed448 labels swapped after signing", () => {
    const signed = signBom(generateMockBom(), {
      privateKey: ed25519Keys.privateKey,
      algorithm: "Ed25519",
      ...rootOnly,
    });
    signed.signature.algorithm = "Ed448";
    const { match, reasons } = reasonsFor(signed, ed25519Keys.publicKey);
    assert.strictEqual(match, false);
    assert.match(reasons[0], /requires an ed448 key, but the key is ed25519/);
  });

  it("rejects algorithm names that are not JSF identifiers", () => {
    for (const algorithm of [
      "none",
      "EdDSA",
      "RS1",
      "toString",
      "__proto__",
      "constructor",
      123,
      { name: "RS256" },
      null,
    ]) {
      const node = {
        name: "x",
        signature: { algorithm, value: "AAAA" },
      };
      const { match, reasons } = reasonsFor(node, rsaKeys.publicKey);
      assert.strictEqual(match, false);
      assert.match(reasons[0], /Unsupported JSF algorithm/);
    }
    assert.throws(
      () =>
        signBom(generateMockBom(), {
          privateKey: rsaKeys.privateKey,
          algorithm: "none",
        }),
      /Unsupported JSF algorithm: none/,
    );
  });
});

describe("bomSigner rejects HMAC algorithm confusion", () => {
  // Anyone holding the published public key can compute these values.
  const publicKeyEncodings = {
    "PEM text": rsaKeys.publicKey,
    "PEM text without the trailing newline": rsaKeys.publicKey.trimEnd(),
    "DER bytes": crypto
      .createPublicKey(rsaKeys.publicKey)
      .export({ type: "spki", format: "der" }),
    "JWK text": JSON.stringify(
      crypto.createPublicKey(rsaKeys.publicKey).export({ format: "jwk" }),
    ),
  };

  for (const [label, secret] of Object.entries(publicKeyEncodings)) {
    it(`rejects an HS256 signature keyed with the public key as ${label}`, () => {
      const bom = generateMockBom();
      bom.components.push({ type: "library", name: "backdoor" });
      // Both the JSF layout and the layout of earlier cdxgen releases.
      for (const forge of [forgeSingle, forgeContentOnly]) {
        const forged = forge(bom, { algorithm: "HS256" }, secret);
        const { match, reasons } = reasonsFor(forged, rsaKeys.publicKey);
        assert.strictEqual(match, false);
        assert.match(
          reasons[0],
          /Algorithm HS256 requires a shared secret, but the key is rsa/,
        );
        assert.strictEqual(verifyBom(forged, rsaKeys.publicKey), false);
      }
    });
  }

  it("never treats a string or Buffer verification key as an HMAC secret", () => {
    const secret = "correct horse battery staple";
    const signed = signBom(generateMockBom(), {
      privateKey: secret,
      algorithm: "HS256",
      ...rootOnly,
    });
    assert.throws(
      () => verifyNode(signed, secret),
      /Unable to load the verification key/,
    );
    assert.throws(
      () => verifyNode(signed, Buffer.from(secret)),
      /Unable to load the verification key/,
    );
    assert.ok(verifyNode(signed, loadSharedSecret(secret)));
  });

  it("rejects an asymmetric signature checked against a shared secret", () => {
    const signed = signBom(generateMockBom(), {
      privateKey: rsaKeys.privateKey,
      algorithm: "RS256",
      ...rootOnly,
    });
    const { match, reasons } = reasonsFor(signed, loadSharedSecret(hmacSecret));
    assert.strictEqual(match, false);
    assert.match(
      reasons[0],
      /requires an rsa key, but the key is a shared secret/,
    );
  });

  it("loadSharedSecret refuses key material and empty secrets", () => {
    for (const material of [
      ...Object.values(publicKeyEncodings),
      rsaKeys.privateKey,
      crypto
        .createPrivateKey(ecKeys.privateKey)
        .export({ type: "pkcs8", format: "der" }),
      crypto.createPrivateKey(ecKeys.privateKey),
    ]) {
      assert.throws(
        () => loadSharedSecret(material),
        /looks like a public or private key|asymmetric key was supplied/,
      );
    }
    assert.throws(() => loadSharedSecret(""), /The shared secret is empty/);
    assert.throws(() => loadSharedSecret(42), TypeError);
    assert.strictEqual(loadSharedSecret(hmacSecret).type, "secret");
  });

  it("refuses to embed a public key in an HMAC signature", () => {
    assert.throws(
      () =>
        signBom(generateMockBom(), {
          privateKey: hmacSecret,
          algorithm: "HS256",
          publicKeyJwk: crypto
            .createPublicKey(rsaKeys.publicKey)
            .export({ format: "jwk" }),
        }),
      /use a shared secret, so a public key cannot be embedded/,
    );
    const forged = forgeSingle(
      generateMockBom(),
      {
        algorithm: "HS256",
        publicKey: crypto
          .createPublicKey(rsaKeys.publicKey)
          .export({ format: "jwk" }),
      },
      hmacSecret,
    );
    const { match, reasons } = reasonsFor(forged, loadSharedSecret(hmacSecret));
    assert.strictEqual(match, false);
    assert.match(reasons[0], /HMAC signatures must not embed a public key/);
  });

  it("loadVerificationKey reduces private keys to public keys", () => {
    const key = loadVerificationKey(rsaKeys.privateKey);
    assert.strictEqual(key.type, "public");
    assert.ok(key.equals(crypto.createPublicKey(rsaKeys.publicKey)));
    assert.throws(
      () => loadVerificationKey("garbage"),
      /Unable to load the verification key/,
    );
  });
});

describe("bomSigner protects the signature metadata", () => {
  const signedWithMetadata = () =>
    signBom(generateMockBom(), {
      privateKey: ed25519Keys.privateKey,
      algorithm: "Ed25519",
      keyId: "release-key",
      publicKeyJwk: crypto
        .createPublicKey(ed25519Keys.publicKey)
        .export({ format: "jwk" }),
    });

  it("signs the metadata exactly as JSF defines", () => {
    const signed = signedWithMetadata();
    const data = jcs({
      ...withoutSignature(signed),
      signature: withoutValue(signed.signature),
    });
    assert.ok(jsfVerifies(data, signed.signature, ed25519Keys.publicKey));
    assert.ok(verifyBom(signed, ed25519Keys.publicKey));
  });

  const tampers = {
    "keyId rewritten": (sig) => {
      sig.keyId = "attacker-chosen";
    },
    "keyId removed": (sig) => {
      delete sig.keyId;
    },
    "publicKey replaced": (sig) => {
      sig.publicKey = crypto
        .createPublicKey(ed448Keys.publicKey)
        .export({ format: "jwk" });
    },
    "publicKey removed": (sig) => {
      delete sig.publicKey;
    },
    "property added": (sig) => {
      sig.certificatePath = ["MIIB"];
    },
    "value padded": (sig) => {
      sig.value = `${sig.value}=`;
    },
    "value with trailing junk": (sig) => {
      sig.value = `${sig.value}!`;
    },
  };
  for (const [label, tamper] of Object.entries(tampers)) {
    it(`rejects a signature whose ${label} after signing`, () => {
      const signed = signedWithMetadata();
      tamper(signed.signature);
      assert.strictEqual(verifyNode(signed, ed25519Keys.publicKey), false);
    });
  }

  it("embeds only the public members of the signing key", () => {
    const privateJwk = crypto
      .createPrivateKey(ecKeys.privateKey)
      .export({ format: "jwk" });
    assert.ok(privateJwk.d, "The input JWK carries the private scalar");
    const signed = signBom(generateMockBom(), {
      privateKey: ecKeys.privateKey,
      algorithm: "ES256",
      publicKeyJwk: { ...privateJwk, use: "sig" },
      ...rootOnly,
    });
    assert.deepStrictEqual(
      signed.signature.publicKey,
      crypto.createPublicKey(ecKeys.publicKey).export({ format: "jwk" }),
    );
    assert.ok(verifyNode(signed, ecKeys.publicKey));
  });

  it("refuses to embed a public key that does not belong to the signing key", () => {
    assert.throws(
      () =>
        signBom(generateMockBom(), {
          privateKey: rsaKeys.privateKey,
          algorithm: "RS256",
          publicKeyJwk: crypto
            .createPublicKey(otherRsaKeys.publicKey)
            .export({ format: "jwk" }),
        }),
      /does not belong to the signing key/,
    );
  });

  it("rejects a valid signature whose embedded publicKey names another key", () => {
    const forged = forgeSingle(
      generateMockBom(),
      {
        algorithm: "RS256",
        publicKey: crypto
          .createPublicKey(otherRsaKeys.publicKey)
          .export({ format: "jwk" }),
      },
      rsaKeys.privateKey,
    );
    const { match, reasons } = reasonsFor(forged, rsaKeys.publicKey);
    assert.strictEqual(match, false);
    assert.match(reasons[0], /embedded publicKey does not match/);
  });

  it("a foreign embedded publicKey does not disturb the next signer", () => {
    const bom = generateMockBom();
    const hostile = forgeSingle(
      bom,
      {
        algorithm: "Ed25519",
        publicKey: crypto
          .createPublicKey(ed448Keys.publicKey)
          .export({ format: "jwk" }),
      },
      ed25519Keys.privateKey,
    ).signature;
    const genuine = signBom(structuredClone(bom), {
      privateKey: ed25519Keys.privateKey,
      algorithm: "Ed25519",
      publicKeyJwk: crypto
        .createPublicKey(ed25519Keys.publicKey)
        .export({ format: "jwk" }),
      mode: "signers",
      ...rootOnly,
    }).signature.signers[0];
    const node = { ...bom, signature: { signers: [hostile, genuine] } };
    const { match, reasons } = reasonsFor(node, ed25519Keys.publicKey);
    assert.strictEqual(match, genuine);
    assert.deepStrictEqual(reasons, [], "No reasons are reported on a match");
    const [first, second] = checkSignatureEntries(node, [
      ed25519Keys.publicKey,
    ]);
    assert.match(first.reasons[0], /embedded publicKey does not match/);
    assert.strictEqual(second.verified, true);
    assert.ok(crypto.createPrivateKey(ed25519Keys.privateKey));
  });

  it("rejects signatures that use JSF excludes", () => {
    const forged = forgeSingle(
      generateMockBom(),
      { algorithm: "Ed25519", excludes: ["components"] },
      ed25519Keys.privateKey,
    );
    const { match, reasons } = reasonsFor(forged, ed25519Keys.publicKey);
    assert.strictEqual(match, false);
    assert.match(reasons[0], /JSF excludes are not supported/);
  });
});

describe("bomSigner multi-signatures (signers)", () => {
  const twoSigners = () => {
    const bom = generateMockBom();
    signBom(bom, {
      privateKey: rsaKeys.privateKey,
      algorithm: "RS512",
      keyId: "builder",
      mode: "signers",
    });
    signBom(bom, {
      privateKey: ecKeys.privateKey,
      algorithm: "ES256",
      keyId: "qa",
      mode: "signers",
    });
    return bom;
  };

  it("writes the JSF signers form from the first signature", () => {
    const bom = generateMockBom();
    signBom(bom, {
      privateKey: rsaKeys.privateKey,
      algorithm: "RS512",
      mode: "signers",
    });
    assert.strictEqual(bom.signature.signers.length, 1);
    assert.strictEqual(bom.components[0].signature.signers.length, 1);
  });

  it("verifies each signer independently, as JSF defines", () => {
    const bom = twoSigners();
    assert.strictEqual(bom.signature.signers.length, 2);
    // The second signer only signed the root, so nested signatures still
    // belong to the builder alone.
    assert.strictEqual(bom.components[0].signature.signers.length, 1);
    assert.strictEqual(verifyBom(bom, rsaKeys.publicKey).keyId, "builder");
    assert.strictEqual(verifyNode(bom, ecKeys.publicKey).keyId, "qa");
    const content = withoutSignature(bom);
    const [builder, qa] = bom.signature.signers;
    assert.ok(
      jsfVerifies(
        jcs({ ...content, signature: { signers: [withoutValue(builder)] } }),
        builder,
        rsaKeys.publicKey,
      ),
    );
    assert.ok(
      jsfVerifies(
        jcs({ ...content, signature: { signers: [withoutValue(qa)] } }),
        qa,
        ecKeys.publicKey,
      ),
    );
  });

  it("keeps each signer valid when the other is removed or the order changes", () => {
    const reordered = twoSigners();
    reordered.signature.signers.reverse();
    assert.ok(verifyNode(reordered, rsaKeys.publicKey));
    assert.ok(verifyNode(reordered, ecKeys.publicKey));
    const reduced = twoSigners();
    reduced.signature.signers.pop();
    assert.ok(verifyNode(reduced, rsaKeys.publicKey));
    assert.strictEqual(verifyNode(reduced, ecKeys.publicKey), false);
  });

  it("rejects a signer whose metadata changes", () => {
    const bom = twoSigners();
    bom.signature.signers[1].keyId = "builder";
    assert.strictEqual(verifyNode(bom, ecKeys.publicKey), false);
    assert.ok(verifyNode(bom, rsaKeys.publicKey));
  });

  it("keeps an existing single signature valid when a co-signer is added", () => {
    const bom = generateMockBom();
    signBom(bom, {
      privateKey: rsaKeys.privateKey,
      algorithm: "RS512",
      keyId: "builder",
    });
    signBom(bom, {
      privateKey: ecKeys.privateKey,
      algorithm: "ES256",
      keyId: "auditor",
      mode: "signers",
    });
    assert.deepStrictEqual(
      bom.signature.signers.map((s) => s.keyId),
      ["builder", "auditor"],
    );
    assert.strictEqual(verifyBom(bom, rsaKeys.publicKey).keyId, "builder");
    assert.strictEqual(verifyNode(bom, ecKeys.publicKey).keyId, "auditor");
    // Signers are independent, so the promoted signature verifies in any
    // position, as long as the wrapper carries nothing else.
    bom.signature.signers.reverse();
    assert.strictEqual(verifyNode(bom, rsaKeys.publicKey).keyId, "builder");
    assert.strictEqual(verifyNode(bom, ecKeys.publicKey).keyId, "auditor");
    bom.signature.extensions = ["x"];
    assert.strictEqual(verifyNode(bom, rsaKeys.publicKey), false);
  });
});

describe("bomSigner signature chains", () => {
  const builderThenApprover = () => {
    const bom = generateMockBom();
    signBom(bom, {
      privateKey: rsaKeys.privateKey,
      algorithm: "RS256",
      keyId: "builder",
      mode: "chain",
    });
    signBom(bom, {
      privateKey: ed25519Keys.privateKey,
      algorithm: "Ed25519",
      keyId: "approver",
      mode: "chain",
    });
    return bom;
  };

  it("signs every earlier chain entry, as JSF defines", () => {
    const bom = builderThenApprover();
    const content = withoutSignature(bom);
    const [builder, approver] = bom.signature.chain;
    assert.ok(
      jsfVerifies(
        jcs({ ...content, signature: { chain: [withoutValue(builder)] } }),
        builder,
        rsaKeys.publicKey,
      ),
    );
    assert.ok(
      jsfVerifies(
        jcs({
          ...content,
          signature: { chain: [builder, withoutValue(approver)] },
        }),
        approver,
        ed25519Keys.publicKey,
      ),
    );
    assert.strictEqual(verifyBom(bom, rsaKeys.publicKey).keyId, "builder");
    assert.strictEqual(
      verifyNode(bom, ed25519Keys.publicKey).keyId,
      "approver",
    );
  });

  it("detects a reordered chain", () => {
    const bom = builderThenApprover();
    bom.signature.chain.reverse();
    assert.strictEqual(verifyNode(bom, rsaKeys.publicKey), false);
    assert.strictEqual(verifyNode(bom, ed25519Keys.publicKey), false);
  });

  it("detects a chain whose earlier entry was removed or replaced", () => {
    const dropped = builderThenApprover();
    dropped.signature.chain.shift();
    assert.strictEqual(verifyNode(dropped, ed25519Keys.publicKey), false);

    // An attacker re-signs the same content with their own key and splices
    // that entry in front of the approver's.
    const replaced = builderThenApprover();
    const impostor = signBom(withoutSignature(replaced), {
      privateKey: otherRsaKeys.privateKey,
      algorithm: "RS256",
      keyId: "builder",
      mode: "chain",
      ...rootOnly,
    });
    replaced.signature.chain[0] = impostor.signature.chain[0];
    assert.ok(verifyNode(replaced, otherRsaKeys.publicKey));
    assert.strictEqual(verifyNode(replaced, ed25519Keys.publicKey), false);
  });

  it("detects a changed earlier entry value", () => {
    const bom = builderThenApprover();
    bom.signature.chain[0].keyId = "someone-else";
    assert.strictEqual(verifyNode(bom, rsaKeys.publicKey), false);
    assert.strictEqual(verifyNode(bom, ed25519Keys.publicKey), false);
  });

  it("keeps a single signature valid when it becomes the first chain entry", () => {
    const bom = generateMockBom();
    signBom(bom, {
      privateKey: rsaKeys.privateKey,
      algorithm: "RS512",
      keyId: "builder",
    });
    signBom(bom, {
      privateKey: ecKeys.privateKey,
      algorithm: "ES256",
      keyId: "approver",
      mode: "chain",
    });
    assert.strictEqual(bom.signature.chain.length, 2);
    assert.strictEqual(verifyBom(bom, rsaKeys.publicKey).keyId, "builder");
    assert.strictEqual(verifyNode(bom, ecKeys.publicKey).keyId, "approver");
    // In a chain the promoted form only holds at position 0.
    const reordered = structuredClone(bom);
    reordered.signature.chain.reverse();
    assert.strictEqual(verifyNode(reordered, rsaKeys.publicKey), false);
    assert.strictEqual(verifyNode(reordered, ecKeys.publicKey), false);
    // Wrapper-level members turn the promoted form off.
    bom.signature.extensions = ["x"];
    assert.strictEqual(verifyNode(bom, rsaKeys.publicKey), false);
  });

  it("verifies mixed-algorithm lists with either key without throwing", () => {
    const chain = generateMockBom();
    signBom(chain, {
      privateKey: ec384Keys.privateKey,
      algorithm: "ES384",
      mode: "chain",
    });
    signBom(chain, {
      privateKey: ed448Keys.privateKey,
      algorithm: "Ed448",
      mode: "chain",
    });
    signBom(chain, {
      privateKey: hmacSecret,
      algorithm: "HS512",
      mode: "chain",
    });
    for (const key of [
      ec384Keys.publicKey,
      ed448Keys.publicKey,
      loadSharedSecret(hmacSecret),
    ]) {
      assert.ok(verifyNode(chain, key));
    }
    const { match, reasons } = reasonsFor(chain, ed25519Keys.publicKey);
    assert.strictEqual(match, false);
    assert.strictEqual(reasons.length, 3);
    assert.match(reasons[0], /^chain\[0\]: Algorithm ES384 requires/);
  });
});

describe("bomSigner signing modes", () => {
  it("skips nested elements by default when appending to a signed BOM", () => {
    const bom = generateMockBom();
    signBom(bom, { privateKey: rsaKeys.privateKey, algorithm: "RS512" });
    const nestedBefore = structuredClone(bom.components[0].signature);
    signBom(bom, {
      privateKey: ecKeys.privateKey,
      algorithm: "ES256",
      mode: "chain",
    });
    assert.deepStrictEqual(bom.components[0].signature, nestedBefore);
    assert.ok(verifyBom(bom, rsaKeys.publicKey));
    assert.ok(verifyNode(bom, ecKeys.publicKey));
  });

  for (const flag of ["signComponents", "signServices", "signAnnotations"]) {
    it(`refuses ${flag} while appending, leaving the BOM unchanged`, () => {
      const bom = generateMockBom();
      signBom(bom, { privateKey: rsaKeys.privateKey, algorithm: "RS512" });
      const before = structuredClone(bom);
      assert.throws(
        () =>
          signBom(bom, {
            privateKey: ecKeys.privateKey,
            algorithm: "ES256",
            mode: "signers",
            [flag]: true,
          }),
        /changes content covered by the existing root signature/,
      );
      assert.deepStrictEqual(bom, before);
    });
  }

  it("signs nested elements by default for a first signers or chain signature", () => {
    for (const mode of ["signers", "chain"]) {
      const bom = signBom(generateMockBom(), {
        privateKey: ed25519Keys.privateKey,
        algorithm: "Ed25519",
        mode,
      });
      assert.strictEqual(bom.components[0].signature[mode].length, 1);
      assert.ok(verifyBom(bom, ed25519Keys.publicKey));
    }
  });

  it("replace mode re-signs everything", () => {
    const bom = signBom(generateMockBom(), {
      privateKey: rsaKeys.privateKey,
      algorithm: "RS512",
      mode: "chain",
    });
    signBom(bom, { privateKey: ecKeys.privateKey, algorithm: "ES256" });
    assert.strictEqual(bom.signature.algorithm, "ES256");
    assert.strictEqual(bom.components[0].signature.algorithm, "ES256");
    assert.ok(verifyBom(bom, ecKeys.publicKey));
    assert.strictEqual(verifyNode(bom, rsaKeys.publicKey), false);
  });

  it("refuses to mix signers and chains or to use an unknown mode", () => {
    const bom = signBom(generateMockBom(), {
      privateKey: rsaKeys.privateKey,
      algorithm: "RS512",
      mode: "signers",
    });
    assert.throws(
      () =>
        signBom(bom, {
          privateKey: ecKeys.privateKey,
          algorithm: "ES256",
          mode: "chain",
        }),
      /Cannot mix signature chains and multi-signers/,
    );
    assert.throws(
      () =>
        signBom(generateMockBom(), {
          privateKey: rsaKeys.privateKey,
          mode: "append",
        }),
      /Unsupported signature mode: append/,
    );
    assert.throws(
      () => signBom(generateMockBom(), {}),
      /privateKey is required/,
    );
  });
});

describe("bomSigner handles malformed signatures without throwing", () => {
  const malformed = {
    "a string": "abc",
    "an array": [{ algorithm: "RS256", value: "AAAA" }],
    "a signers string": { signers: "abc" },
    "an empty signers array": { signers: [] },
    "a chain of strings": { chain: ["abc"] },
    "both signers and chain": {
      signers: [{ algorithm: "RS256", value: "AAAA" }],
      chain: [{ algorithm: "RS256", value: "AAAA" }],
    },
    "a missing value": { algorithm: "RS256" },
    "a numeric value": { algorithm: "RS256", value: 42 },
    "a non-base64url value": { algorithm: "RS256", value: "***" },
  };
  for (const [label, signature] of Object.entries(malformed)) {
    it(`returns false for ${label}`, () => {
      const node = { name: "x", signature };
      const { match, reasons } = reasonsFor(node, rsaKeys.publicKey);
      assert.strictEqual(match, false);
      assert.ok(reasons.length > 0);
      assert.strictEqual(
        verifyBom({ ...generateMockBom(), signature }, rsaKeys.publicKey),
        false,
      );
    });
  }

  it("returns false for unsigned nodes", () => {
    assert.strictEqual(verifyNode(generateMockBom(), rsaKeys.publicKey), false);
    assert.strictEqual(verifyNode(null, rsaKeys.publicKey), false);
    assert.strictEqual(verifyBom({}, rsaKeys.publicKey), false);
  });
});

describe("bomSigner rejects the signature format of cdxgen 12.2.0 - 12.8.4", () => {
  // Those releases left the whole signature property out of the signed data,
  // so their signatures never covered the algorithm, keyId, publicKey, or
  // earlier chain entries. Such BOMs must be re-signed.
  it("rejects a single signature that does not cover its metadata", () => {
    const old = forgeContentOnly(
      generateMockBom(),
      { algorithm: "RS512", keyId: "builder" },
      rsaKeys.privateKey,
    );
    const { match, reasons } = reasonsFor(old, rsaKeys.publicKey);
    assert.strictEqual(match, false);
    assert.deepStrictEqual(reasons, [
      "The RS512 signature does not verify with this key: the signed content changed, or a different key made it.",
    ]);
  });

  it("rejects chain entries that do not cover earlier entries", () => {
    const bom = generateMockBom();
    const content = jcs(bom);
    const chain = [
      { algorithm: "Ed25519", keyId: "builder" },
      { algorithm: "RS256", keyId: "approver" },
    ].map((entry, index) => ({
      ...entry,
      value: rawSign(
        content,
        entry.algorithm,
        [ed25519Keys, rsaKeys][index].privateKey,
      ).toString("base64url"),
    }));
    const old = { ...bom, signature: { chain } };
    assert.strictEqual(verifyNode(old, ed25519Keys.publicKey), false);
    assert.strictEqual(verifyNode(old, rsaKeys.publicKey), false);
  });

  it("re-signing an old BOM produces a signature that verifies", () => {
    const old = forgeContentOnly(
      generateMockBom(),
      { algorithm: "RS512" },
      rsaKeys.privateKey,
    );
    const resigned = signBom(roundTrip(old), {
      privateKey: rsaKeys.privateKey,
      algorithm: "RS512",
    });
    assert.ok(verifyBom(resigned, rsaKeys.publicKey));
  });
});

describe("checkSignatureEntries", () => {
  const chainOf = () => {
    const bom = generateMockBom();
    signBom(bom, {
      privateKey: rsaKeys.privateKey,
      algorithm: "RS256",
      keyId: "builder",
    });
    signBom(bom, {
      privateKey: ed25519Keys.privateKey,
      algorithm: "Ed25519",
      keyId: "approver",
      mode: "chain",
    });
    return bom;
  };

  it("reports which entries each trusted key verifies", () => {
    const bom = chainOf();
    const builderOnly = checkSignatureEntries(bom, [rsaKeys.publicKey]);
    assert.deepStrictEqual(
      builderOnly.map(({ index, keyId, verified }) => ({
        index,
        keyId,
        verified,
      })),
      [
        { index: 0, keyId: "builder", verified: true },
        { index: 1, keyId: "approver", verified: false },
      ],
    );
    assert.match(builderOnly[1].reasons[0], /requires an ed25519 key/);
    const both = checkSignatureEntries(bom, [
      rsaKeys.publicKey,
      ed25519Keys.publicKey,
    ]);
    assert.ok(both.every((result) => result.verified));
  });

  it("does not verify a fabricated entry", () => {
    const bom = generateMockBom();
    bom.signature = {
      chain: [
        {
          algorithm: "RS256",
          keyId: "secure-builder-ci",
          value: crypto.randomBytes(256).toString("base64url"),
        },
      ],
    };
    const [result] = checkSignatureEntries(bom, [rsaKeys.publicKey]);
    assert.strictEqual(result.verified, false);
    assert.strictEqual(result.keyId, "secure-builder-ci");
    assert.match(result.reasons[0], /does not verify with this key/);
  });

  it("verifies nothing without keys and handles unsigned or malformed nodes", () => {
    const results = checkSignatureEntries(chainOf());
    assert.strictEqual(results.length, 2);
    assert.ok(results.every((r) => !r.verified && !r.reasons.length));
    assert.deepStrictEqual(
      checkSignatureEntries(generateMockBom(), [rsaKeys.publicKey]),
      [],
    );
    const [malformed] = checkSignatureEntries(
      { name: "x", signature: { chain: "abc" } },
      [rsaKeys.publicKey],
    );
    assert.strictEqual(malformed.verified, false);
    assert.match(malformed.reasons[0], /must contain signature objects/);
  });
});

describe("verifyBom reasons", () => {
  it("names the nested element whose signature belongs to another key", () => {
    const bom = generateMockBom();
    signBom(bom, { privateKey: rsaKeys.privateKey, algorithm: "RS512" });
    signBom(bom, {
      privateKey: ecKeys.privateKey,
      algorithm: "ES256",
      mode: "signers",
    });
    const reasons = [];
    assert.strictEqual(verifyBom(bom, ecKeys.publicKey, { reasons }), false);
    assert.deepStrictEqual(reasons, [
      "components[0] 'cdxgen': Algorithm RS512 requires an rsa key, but the key is ec (prime256v1).",
    ]);
    assert.ok(verifyNode(bom, ecKeys.publicKey));
  });
});

describe("displayValue", () => {
  it("renders document values without throwing", () => {
    assert.strictEqual(displayValue("builder"), "builder");
    assert.strictEqual(displayValue(42), "42");
    assert.strictEqual(displayValue(undefined), "undefined");
    assert.strictEqual(displayValue({ toString: "x" }), '{"toString":"x"}');
    assert.strictEqual(displayValue(10n), "<bigint>");
  });

  it("keeps verifyBom from throwing on hostile nested names", () => {
    const bom = generateMockBom();
    bom.components[0].name = { toString: "x", valueOf: "y" };
    signBom(bom, { privateKey: rsaKeys.privateKey, algorithm: "RS512" });
    signBom(bom, {
      privateKey: ecKeys.privateKey,
      algorithm: "ES256",
      mode: "signers",
    });
    const reasons = [];
    assert.strictEqual(verifyBom(bom, ecKeys.publicKey, { reasons }), false);
    assert.match(
      reasons[0],
      /^components\[0\] '\{"toString":"x","valueOf":"y"\}':/,
    );
  });
});

describe("generateSigningKeyPair", () => {
  for (const alg of [
    "RS256",
    "PS512",
    "ES256",
    "ES384",
    "ES512",
    "Ed25519",
    "Ed448",
  ]) {
    it(`creates a key pair that signs ${alg}`, () => {
      const { privateKey, publicKey } = generateSigningKeyPair(alg);
      const signed = signBom(generateMockBom(), { privateKey, algorithm: alg });
      assert.ok(verifyBom(signed, publicKey));
    });
  }

  it("has no key pair for HMAC or unknown algorithms", () => {
    assert.throws(() => generateSigningKeyPair("HS256"), /shared secret/);
    assert.throws(
      () => generateSigningKeyPair("ML-DSA-65"),
      /Unsupported JSF algorithm/,
    );
  });
});
