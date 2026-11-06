import { spawnSync } from "node:child_process";
import {
  constants,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "poku";

import { canonicalizeJson } from "./bomSigner.js";
import {
  assertJssKeyMatchesAlgorithm,
  countersignJss,
  generateJssKeyPair,
  removeJssSignatures,
  selectJssAlgorithmForKey,
  signJss,
  signJssBom,
  UNSUPPORTED_JSS_ALGORITHMS,
  verifyJss,
  verifyJssBom,
} from "./jssSigner.js";

const SAMPLE = {
  statement: "Hello signed world!",
  otherProperties: ["home", "food"],
};

// Recommendation ITU-T X.590 (10/2023) Appendix II Ed25519 key pair.
const APPENDIX_II_PRIVATE_KEY = createPrivateKey(
  "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIDnZ5bPmXnB3OfU/5fNVfxfr7iRZtqH06AZ3b6c6liTL\n-----END PRIVATE KEY-----\n",
);
const APPENDIX_II_PUBLIC_KEY_B64 =
  "MCowBQYDK2VwAyEAubMonBfU9pvIbj5RCiWQLD45Jvu6mKr+kQXjvjW8ZkU";
const APPENDIX_II_PUBLIC_KEY = createPublicKey({
  key: Buffer.from(APPENDIX_II_PUBLIC_KEY_B64, "base64"),
  format: "der",
  type: "spki",
});
// Clause 7.1.6 and clause 7.2.6 example signature values.
const CLAUSE_716_VALUE =
  "F1Sj4VcZlSt5GO3Bcu4izpCklj9DbKDNvc2Trpdznfqgv9HMPUGVtefMsHfTqel-dN20lUXsdoeD8PpVr1ssCg";
const CLAUSE_726_VALUE =
  "b_7Xu5qmpCGx7f0VneTUuFxGOcck3Fk5duNlRzDo-ifG1faoK3-xV_xc62DyHnPIgAGDbbSOlKf9kaxs_qAjBA";
// The placeholder entry of clauses 7.1.1, 7.1.7 and 7.2.1.
const PLACEHOLDER_ENTRY = {
  hash_algorithm: "-- some hashing algorithm --",
  algorithm: "-- some signing algorithm --",
  public_key: "-- some public key --",
  value: "-- some existing digital signature --",
};

// Independent of the module: the IANA name to node digest, and the JOSE
// primitive per Table 1 / JWA (RFC 7518) sections 3.3-3.5, RFC 8037.
const IANA_TO_NODE = {
  "sha-256": "sha256",
  "sha-384": "sha384",
  "sha-512": "sha512",
  "sha3-256": "sha3-256",
};
const JOSE = {
  RS256: { hash: "sha256", kind: "pkcs1" },
  RS384: { hash: "sha384", kind: "pkcs1" },
  RS512: { hash: "sha512", kind: "pkcs1" },
  PS256: { hash: "sha256", kind: "pss", salt: 32 },
  PS384: { hash: "sha384", kind: "pss", salt: 48 },
  PS512: { hash: "sha512", kind: "pss", salt: 64 },
  ES256: { hash: "sha256", kind: "ec" },
  ES384: { hash: "sha384", kind: "ec" },
  ES512: { hash: "sha512", kind: "ec" },
  Ed25519: { hash: null, kind: "ed" },
  Ed448: { hash: null, kind: "ed" },
};

const joseKey = (algorithm, key) => {
  const { kind, salt } = JOSE[algorithm];
  if (kind === "pkcs1") {
    return { key, padding: constants.RSA_PKCS1_PADDING };
  }
  if (kind === "pss") {
    return { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: salt };
  }
  if (kind === "ec") {
    return { key, dsaEncoding: "ieee-p1363" };
  }
  return key;
};

/** The clause 7.1.5 hash of a view, as the lowercase hex text clause 7.1.6 signs. */
const hexMessage = (view, hashAlgorithm) =>
  Buffer.from(
    createHash(IANA_TO_NODE[hashAlgorithm])
      .update(canonicalizeJson(view), "utf8")
      .digest("hex"),
    "utf8",
  );

/** Build a signed object without the module: sign `entry` (no value) over `{...content, signatures: [entry]}`. */
function forge(content, entry, privateKey, primitive = entry.algorithm) {
  const message = hexMessage(
    { ...content, signatures: [entry] },
    entry.hash_algorithm,
  );
  const value = sign(
    JOSE[primitive].hash,
    message,
    joseKey(primitive, privateKey),
  ).toString("base64url");
  return { ...content, signatures: [{ ...entry, value }] };
}

const spkiB64 = (publicKey) =>
  publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64")
    .replace(/=+$/u, "");

const ALGORITHMS = Object.keys(JOSE);

const hasOpenssl =
  spawnSync("openssl", ["version"], { encoding: "utf8" }).status === 0;
if (!hasOpenssl) {
  console.log(
    "Note: openssl is not on PATH; the OpenSSL cross-checks of JSS signatures are skipped.",
  );
}

/** Run openssl in a fresh directory; returns the exit status. */
function openssl(files, args) {
  const dir = mkdtempSync(join(tmpdir(), "cdxgen-jss-openssl-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content);
    }
    return spawnSync("openssl", args, { cwd: dir, encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("JSS signing per ITU-T X.590", () => {
  it("reproduces the X.590 clause 7.1 canonicalization and hash", () => {
    // Clause 7.1.4 gives the JCS form and clause 7.1.5 its sha-256 hash.
    const jcs = canonicalizeJson({
      ...SAMPLE,
      signatures: [
        {
          hash_algorithm: "sha-256",
          algorithm: "Ed25519",
          public_key: APPENDIX_II_PUBLIC_KEY_B64,
        },
      ],
    });
    assert.strictEqual(
      jcs,
      '{"otherProperties":["home","food"],"signatures":[{"algorithm":"Ed25519","hash_algorithm":"sha-256","public_key":"MCowBQYDK2VwAyEAubMonBfU9pvIbj5RCiWQLD45Jvu6mKr+kQXjvjW8ZkU"}],"statement":"Hello signed world!"}',
    );
    assert.strictEqual(
      createHash("sha256").update(jcs, "utf8").digest("hex"),
      "e005ae762a01723f3b58fa8edb2b2cc3b126ca087077189072cfd9a27e6079d5",
    );
  });

  it("reproduces the clause 7.1.6 value byte for byte and assembles clause 7.1.7", () => {
    // Clause 7.1.1 starts from a document with an existing signature;
    // clause 7.1.2 removes it, clause 7.1.7 restores it first.
    const signed = signJss(
      { ...SAMPLE, signatures: [PLACEHOLDER_ENTRY] },
      {
        algorithm: "Ed25519",
        privateKey: APPENDIX_II_PRIVATE_KEY,
        hashAlgorithm: "sha-256",
      },
    );
    assert.deepStrictEqual(signed.signatures, [
      PLACEHOLDER_ENTRY,
      {
        hash_algorithm: "sha-256",
        algorithm: "Ed25519",
        public_key: APPENDIX_II_PUBLIC_KEY_B64,
        value: CLAUSE_716_VALUE,
      },
    ]);
  });

  it("verifies the clause 7.1.7 document with the Appendix II public key", () => {
    const clause717 = {
      ...SAMPLE,
      signatures: [
        PLACEHOLDER_ENTRY,
        {
          hash_algorithm: "sha-256",
          algorithm: "Ed25519",
          public_key: APPENDIX_II_PUBLIC_KEY_B64,
          value: CLAUSE_716_VALUE,
        },
      ],
    };
    const verdict = verifyJss(clause717, { publicKey: APPENDIX_II_PUBLIC_KEY });
    assert.ok(verdict.valid, JSON.stringify(verdict.results));
    assert.strictEqual(verdict.trusted, true);
    assert.strictEqual(verdict.results[1].status, "verified");
    assert.strictEqual(verdict.results[0].status, "untrusted");
    // With --require-all semantics the placeholder entry fails the document.
    assert.strictEqual(
      verifyJss(clause717, {
        publicKey: APPENDIX_II_PUBLIC_KEY,
        requireAll: true,
      }).valid,
      false,
    );
  });

  it("reproduces the clause 7.2.6 countersignature value and verifies clause 7.2.7", () => {
    const countersigned = countersignJss(
      { ...SAMPLE, signatures: [PLACEHOLDER_ENTRY] },
      {
        algorithm: "Ed25519",
        privateKey: APPENDIX_II_PRIVATE_KEY,
        hashAlgorithm: "sha-256",
      },
    );
    assert.deepStrictEqual(countersigned.signatures, [
      {
        ...PLACEHOLDER_ENTRY,
        signature: {
          hash_algorithm: "sha-256",
          algorithm: "Ed25519",
          public_key: APPENDIX_II_PUBLIC_KEY_B64,
          value: CLAUSE_726_VALUE,
        },
      },
    ]);
    const verdict = verifyJss(countersigned, {
      publicKey: APPENDIX_II_PUBLIC_KEY,
    });
    assert.ok(verdict.valid, JSON.stringify(verdict.results));
    const counter = verdict.results.find((result) => result.depth === 1);
    assert.strictEqual(counter.status, "verified");
    assert.strictEqual(counter.path, "signatures[0].signature");
    // The countersignature covers the countersigned entry's value.
    const tampered = structuredClone(countersigned);
    tampered.signatures[0].value = "-- another digital signature --";
    const tamperedVerdict = verifyJss(tampered, {
      publicKey: APPENDIX_II_PUBLIC_KEY,
    });
    assert.strictEqual(tamperedVerdict.valid, false);
    assert.strictEqual(
      tamperedVerdict.results.find((result) => result.depth === 1).status,
      "failed",
    );
  });

  it("cross-checks the clause 7.1.6 vector with openssl", () => {
    if (!hasOpenssl) {
      console.log("Skipped: openssl is not on PATH.");
      return;
    }
    const result = openssl(
      {
        "pub.pem": APPENDIX_II_PUBLIC_KEY.export({
          type: "spki",
          format: "pem",
        }),
        "msg.txt":
          "e005ae762a01723f3b58fa8edb2b2cc3b126ca087077189072cfd9a27e6079d5",
        "sig.bin": Buffer.from(CLAUSE_716_VALUE, "base64url"),
      },
      [
        "pkeyutl",
        "-verify",
        "-rawin",
        "-pubin",
        "-inkey",
        "pub.pem",
        "-in",
        "msg.txt",
        "-sigfile",
        "sig.bin",
      ],
    );
    assert.strictEqual(result.status, 0, result.stderr);
  });

  for (const algorithm of ALGORITHMS) {
    it(`signs ${algorithm} so that node:crypto verifies it independently`, () => {
      const { privateKey, publicKey } = generateJssKeyPair(algorithm);
      const signed = signJss(SAMPLE, { algorithm, privateKey });
      const entry = signed.signatures.at(-1);
      assert.strictEqual(entry.algorithm, algorithm);
      assert.strictEqual(entry.public_key, spkiB64(publicKey));
      const { value, ...unsigned } = entry;
      const message = hexMessage(
        { ...SAMPLE, signatures: [unsigned] },
        entry.hash_algorithm,
      );
      const signature = Buffer.from(value, "base64url");
      assert.ok(
        verify(
          JOSE[algorithm].hash,
          message,
          joseKey(algorithm, publicKey),
          signature,
        ),
        `${algorithm} verifies with the JOSE hash over the hex message`,
      );
      if (JOSE[algorithm].hash && JOSE[algorithm].hash !== "sha256") {
        assert.strictEqual(
          verify("sha256", message, joseKey(algorithm, publicKey), signature),
          false,
          `${algorithm} does not use SHA-256 inside the primitive`,
        );
      }
      if (algorithm.startsWith("ES")) {
        const size = { ES256: 64, ES384: 96, ES512: 132 }[algorithm];
        assert.strictEqual(signature.length, size, "P1363 r||s size");
      }
      const verdict = verifyJss(signed, { publicKey });
      assert.ok(verdict.valid, JSON.stringify(verdict.results));
      // A module-independent forgery of the same entry verifies too.
      const forged = forge(SAMPLE, unsigned, privateKey);
      assert.ok(verifyJss(forged, { publicKey }).valid);
    });

    it(`detects tampering under ${algorithm}`, () => {
      const { privateKey, publicKey } = generateJssKeyPair(algorithm);
      const signed = signJss(SAMPLE, { algorithm, privateKey });
      const tampered = structuredClone(signed);
      tampered.statement = "Hello tampered world!";
      assert.strictEqual(verifyJss(tampered, { publicKey }).valid, false);
    });
  }

  for (const algorithm of ["Ed25519", "Ed448", "RS256", "RS512", "PS256"]) {
    it(`cross-checks ${algorithm} with openssl`, () => {
      if (!hasOpenssl) {
        console.log(`Skipped ${algorithm}: openssl is not on PATH.`);
        return;
      }
      const { privateKey, publicKey } = generateJssKeyPair(algorithm);
      const signed = signJss(SAMPLE, { algorithm, privateKey });
      const { value, ...unsigned } = signed.signatures[0];
      const files = {
        "pub.pem": publicKey.export({ type: "spki", format: "pem" }),
        "msg.txt": hexMessage(
          { ...SAMPLE, signatures: [unsigned] },
          unsigned.hash_algorithm,
        ),
        "sig.bin": Buffer.from(value, "base64url"),
      };
      const hash = JOSE[algorithm].hash;
      const args = algorithm.startsWith("Ed")
        ? [
            "pkeyutl",
            "-verify",
            "-rawin",
            "-pubin",
            "-inkey",
            "pub.pem",
            "-in",
            "msg.txt",
            "-sigfile",
            "sig.bin",
          ]
        : [
            "dgst",
            `-${hash}`,
            ...(algorithm.startsWith("PS")
              ? [
                  "-sigopt",
                  "rsa_padding_mode:pss",
                  "-sigopt",
                  "rsa_pss_saltlen:digest",
                ]
              : []),
            "-verify",
            "pub.pem",
            "-signature",
            "sig.bin",
            "msg.txt",
          ];
      const result = openssl(files, args);
      assert.strictEqual(result.status, 0, `${result.stdout}${result.stderr}`);
    });
  }

  it("refuses a key that does not fit the algorithm label (each family)", () => {
    const ed25519 = generateKeyPairSync("ed25519");
    const ed448 = generateKeyPairSync("ed448");
    const p256 = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const secp256k1 = generateKeyPairSync("ec", { namedCurve: "secp256k1" });
    const rsa1024 = generateKeyPairSync("rsa", { modulusLength: 1024 });
    const rsaPss = generateKeyPairSync("rsa-pss", { modulusLength: 2048 });
    const rsaPssSha256 = generateKeyPairSync("rsa-pss", {
      modulusLength: 2048,
      hashAlgorithm: "sha256",
      mgf1HashAlgorithm: "sha256",
      saltLength: 32,
    });
    const cases = [
      ["RS256", ed25519],
      ["RS256", rsa1024],
      ["RS256", rsaPss],
      ["PS256", p256],
      ["PS256", rsa1024],
      ["PS512", rsaPssSha256],
      ["ES512", p256],
      ["ES256", secp256k1],
      ["ES256", ed25519],
      ["Ed25519", rsaPss],
      ["Ed25519", ed448],
      ["Ed448", ed25519],
    ];
    for (const [algorithm, pair] of cases) {
      assert.throws(
        () => signJss(SAMPLE, { algorithm, privateKey: pair.privateKey }),
        /requires/u,
        `${algorithm} with ${pair.publicKey.asymmetricKeyType}`,
      );
      assert.throws(() =>
        assertJssKeyMatchesAlgorithm(algorithm, pair.publicKey),
      );
    }
    // A restricted rsa-pss key fits the PS algorithm it is restricted to.
    assertJssKeyMatchesAlgorithm("PS256", rsaPssSha256.publicKey);
    const signed = signJss(SAMPLE, {
      algorithm: "PS256",
      privateKey: rsaPssSha256.privateKey,
    });
    assert.ok(verifyJss(signed, { publicKey: rsaPssSha256.publicKey }).valid);
  });

  it("fails verification of a mislabelled entry (each family)", () => {
    const ed25519 = generateKeyPairSync("ed25519");
    const p256 = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    // [label, real primitive, key]
    const cases = [
      ["RS256", "Ed25519", ed25519],
      ["ES512", "ES256", p256],
      ["Ed448", "Ed25519", ed25519],
      ["PS256", "RS256", rsa],
      ["ES256", "RS256", rsa],
    ];
    for (const [label, primitive, pair] of cases) {
      const forged = forge(
        SAMPLE,
        {
          hash_algorithm: "sha-256",
          algorithm: label,
          public_key: spkiB64(pair.publicKey),
        },
        pair.privateKey,
        primitive,
      );
      const verdict = verifyJss(forged, { publicKey: pair.publicKey });
      assert.strictEqual(verdict.valid, false, `${label} over ${primitive}`);
      assert.strictEqual(verdict.results[0].status, "failed");
    }
  });

  it("allows only the IANA sha-2 and sha-3 hash names", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    for (const hashAlgorithm of [
      "md5",
      "sha1",
      "sha-1",
      "sha256",
      "SHA-256",
      "sha-224",
      "toString",
      "__proto__",
    ]) {
      assert.throws(
        () =>
          signJss(SAMPLE, {
            algorithm: "Ed25519",
            privateKey,
            hashAlgorithm,
          }),
        /Unsupported JSS hash_algorithm/u,
        hashAlgorithm,
      );
    }
    for (const weak of ["md5", "sha1"]) {
      const entry = {
        hash_algorithm: weak,
        algorithm: "Ed25519",
        public_key: spkiB64(publicKey),
      };
      const message = Buffer.from(
        createHash(weak)
          .update(canonicalizeJson({ ...SAMPLE, signatures: [entry] }))
          .digest("hex"),
      );
      const forged = {
        ...SAMPLE,
        signatures: [
          {
            ...entry,
            value: sign(null, message, privateKey).toString("base64url"),
          },
        ],
      };
      const verdict = verifyJss(forged, { publicKey });
      assert.strictEqual(verdict.valid, false, weak);
      assert.match(verdict.results[0].reason, /hash_algorithm/u);
    }
    for (const hashAlgorithm of ["sha3-256", "sha3-384", "sha3-512"]) {
      const signed = signJss(SAMPLE, {
        algorithm: "Ed25519",
        privateKey,
        hashAlgorithm,
      });
      assert.ok(verifyJss(signed, { publicKey }).valid, hashAlgorithm);
    }
  });

  it("does not trust the embedded key without allowEmbeddedKey", () => {
    const attacker = generateKeyPairSync("ed25519");
    const victim = generateKeyPairSync("ed25519");
    const forged = signJss(
      { ...SAMPLE, statement: "pwned" },
      { algorithm: "Ed25519", privateKey: attacker.privateKey },
    );
    assert.throws(() => verifyJss(forged), /trusted publicKey/u);
    assert.throws(() => verifyJssBom(forged), /trusted publicKey/u);
    assert.strictEqual(
      verifyJss(forged, { publicKey: victim.publicKey }).valid,
      false,
    );
    const integrity = verifyJss(forged, { allowEmbeddedKey: true });
    assert.strictEqual(integrity.valid, true);
    assert.strictEqual(integrity.trusted, false);
    assert.strictEqual(integrity.results[0].status, "integrity-only");
    assert.strictEqual(integrity.results[0].trusted, false);
    // A tampered document fails the integrity-only check as well.
    const tampered = { ...forged, statement: "pwned again" };
    assert.strictEqual(
      verifyJss(tampered, { allowEmbeddedKey: true }).valid,
      false,
    );
  });

  it("verifies with whichever of several trusted keys signed the entry", () => {
    const first = generateKeyPairSync("ed25519");
    const second = generateKeyPairSync("ed25519");
    const signed = signJss(SAMPLE, {
      algorithm: "Ed25519",
      privateKey: second.privateKey,
    });
    const verdict = verifyJss(signed, {
      publicKeys: [first.publicKey, second.publicKey],
    });
    assert.ok(verdict.valid);
    assert.strictEqual(verdict.results[0].keyIndex, 1);
    assert.deepStrictEqual(verdict.keysMatched, [false, true]);
    assert.strictEqual(
      verifyJss(signed, {
        publicKeys: [first.publicKey, second.publicKey],
        requireAll: true,
        requireEveryKey: true,
      }).valid,
      false,
      "with requireEveryKey every trusted key must verify an entry",
    );
  });

  it("keeps existing signatures valid when appending (clauses 7.1.2, 7.1.7)", () => {
    const first = generateKeyPairSync("ed25519");
    const second = generateKeyPairSync("ec", { namedCurve: "secp384r1" });
    const once = signJss(SAMPLE, {
      algorithm: "Ed25519",
      privateKey: first.privateKey,
    });
    const twice = signJss(once, {
      algorithm: "ES384",
      privateKey: second.privateKey,
    });
    assert.strictEqual(twice.signatures.length, 2);
    assert.deepStrictEqual(twice.signatures[0], once.signatures[0]);
    assert.ok(verifyJss(twice, { publicKey: first.publicKey }).valid);
    assert.ok(verifyJss(twice, { publicKey: second.publicKey }).valid);
    assert.ok(
      verifyJss(twice, {
        publicKeys: [first.publicKey, second.publicKey],
        requireAll: true,
        requireEveryKey: true,
      }).valid,
    );
    // Order does not matter (clause 8.1.1).
    const reversed = { ...twice, signatures: [...twice.signatures].reverse() };
    assert.ok(verifyJss(reversed, { publicKey: first.publicKey }).valid);
  });

  it("fails when an entry naming a trusted key does not verify", () => {
    const trusted = generateKeyPairSync("ed25519");
    const signed = signJss(
      signJss(SAMPLE, {
        algorithm: "Ed25519",
        privateKey: trusted.privateKey,
      }),
      {
        algorithm: "Ed25519",
        privateKey: trusted.privateKey,
        hashAlgorithm: "sha-256",
      },
    );
    signed.signatures[1].value = signed.signatures[0].value;
    const verdict = verifyJss(signed, { publicKey: trusted.publicKey });
    assert.strictEqual(verdict.valid, false);
    assert.strictEqual(verdict.results[0].status, "verified");
    assert.strictEqual(verdict.results[1].status, "failed");
    assert.strictEqual(verdict.results[1].claimsTrustedKey, true);
  });

  it("authenticates signature metadata such as signee and revoked", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    // A conformant signer that covers clause 6.3 metadata.
    const signed = forge(
      SAMPLE,
      {
        hash_algorithm: "sha-256",
        algorithm: "Ed25519",
        public_key: spkiB64(publicKey),
        signee: "ACME",
        valid_until: "2030-01-01T00:00:00Z",
      },
      privateKey,
    );
    assert.ok(verifyJss(signed, { publicKey }).valid, "metadata is covered");
    for (const change of [
      (entry) => {
        entry.signee = "Attacker Corp";
      },
      (entry) => {
        entry.revoked = true;
      },
      (entry) => {
        delete entry.valid_until;
      },
    ]) {
      const tampered = structuredClone(signed);
      change(tampered.signatures[0]);
      assert.strictEqual(verifyJss(tampered, { publicKey }).valid, false);
    }
    // An injected countersignature is reported as failed, not ignored.
    const injected = structuredClone(signed);
    injected.signatures[0].signature = {
      hash_algorithm: "sha-256",
      algorithm: "Ed25519",
      public_key: spkiB64(publicKey),
      value: injected.signatures[0].value,
    };
    const verdict = verifyJss(injected, { publicKey });
    assert.strictEqual(verdict.results[0].status, "verified");
    assert.strictEqual(verdict.results[1].status, "failed");
    assert.strictEqual(verdict.valid, false);
  });

  it("verifies a thumbprint entry (no public_key) with the caller key", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const thumbprint = createHash("sha256")
      .update(publicKey.export({ type: "spki", format: "der" }))
      .digest("base64url");
    const signed = forge(
      SAMPLE,
      { hash_algorithm: "sha-256", algorithm: "Ed25519", thumbprint },
      privateKey,
    );
    const verdict = verifyJss(signed, { publicKey });
    assert.ok(verdict.valid, JSON.stringify(verdict.results));
    const other = generateKeyPairSync("ed25519");
    assert.strictEqual(
      verifyJss(signed, { publicKey: other.publicKey }).valid,
      false,
    );
  });

  it("rejects a non-canonical signature value", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const signed = signJss(SAMPLE, { algorithm: "Ed25519", privateKey });
    signed.signatures[0].value = `${signed.signatures[0].value.slice(0, 10)}!${signed.signatures[0].value.slice(10)}`;
    const verdict = verifyJss(signed, { publicKey });
    assert.strictEqual(verdict.valid, false);
    assert.match(verdict.results[0].reason, /canonical base64url/u);
  });

  it("refuses every X.590 XMSS and LMS name, HMAC, and non-vocabulary names", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    assert.strictEqual(UNSUPPORTED_JSS_ALGORITHMS.length, 8);
    for (const algorithm of UNSUPPORTED_JSS_ALGORITHMS) {
      assert.throws(
        () => signJss(SAMPLE, { algorithm, privateKey }),
        /not supported: quantum-safe XMSS\/LMS/u,
        algorithm,
      );
    }
    for (const algorithm of ["HS256", "HS384", "HS512"]) {
      assert.throws(
        () => signJss(SAMPLE, { algorithm, privateKey }),
        /HMAC algorithms SHOULD NOT be used/u,
      );
    }
    for (const algorithm of ["RS1536", "RS2048", "none", "EdDSA"]) {
      assert.throws(
        () => signJss(SAMPLE, { algorithm, privateKey }),
        /Unsupported JSS algorithm/u,
        algorithm,
      );
    }
  });

  it("selects the algorithm from the key", () => {
    const pick = (type, options) =>
      selectJssAlgorithmForKey(generateKeyPairSync(type, options).privateKey);
    assert.strictEqual(pick("ec", { namedCurve: "prime256v1" }), "ES256");
    assert.strictEqual(pick("ec", { namedCurve: "secp384r1" }), "ES384");
    assert.strictEqual(pick("ec", { namedCurve: "secp521r1" }), "ES512");
    assert.strictEqual(pick("rsa", { modulusLength: 2048 }), "RS256");
    assert.strictEqual(pick("rsa-pss", { modulusLength: 2048 }), "PS256");
    assert.strictEqual(pick("ed25519"), "Ed25519");
    assert.strictEqual(pick("ed448"), "Ed448");
    assert.throws(() => pick("x25519"), /No JSS algorithm/u);
    assert.throws(
      () => pick("ec", { namedCurve: "secp256k1" }),
      /No JSS algorithm/u,
    );
  });
});

describe("JSS signing of CycloneDX 2.0 BOMs", () => {
  const bom = () => ({
    specFormat: "CycloneDX",
    specVersion: "2.0",
    inventories: [
      {
        components: [
          { type: "library", name: "a" },
          { type: "library", name: "b" },
        ],
      },
    ],
    annotations: [{ text: "note" }],
  });

  it("refuses deep signing that would invalidate root signatures", () => {
    const first = generateKeyPairSync("ed25519");
    const second = generateKeyPairSync("ed25519");
    const signed = signJssBom(bom(), {
      algorithm: "Ed25519",
      privateKey: first.privateKey,
    });
    assert.throws(
      () =>
        signJssBom(signed, {
          algorithm: "Ed25519",
          privateKey: second.privateKey,
        }),
      /would no longer verify/u,
    );
    const appended = signJssBom(signed, {
      algorithm: "Ed25519",
      privateKey: second.privateKey,
      deep: false,
    });
    assert.ok(
      verifyJssBom(appended, { publicKey: first.publicKey }).valid,
      "the first signer's root and nested signatures stay valid",
    );
    assert.ok(
      verifyJssBom(appended, { publicKey: second.publicKey, deep: false })
        .valid,
    );
    const invalidated = signJssBom(signed, {
      algorithm: "Ed25519",
      privateKey: second.privateKey,
      allowInvalidatingSignatures: true,
    });
    const verdict = verifyJssBom(invalidated, {
      publicKeys: [first.publicKey, second.publicKey],
    });
    assert.strictEqual(
      verdict.root.results.find((result) => result.index === 0).status,
      "failed",
    );
    assert.strictEqual(verdict.valid, false);
  });

  it("applies the JSF policy for deep, requireAll and allowNestedOnly", () => {
    const owner = generateKeyPairSync("ed25519");
    const supplier = generateKeyPairSync("ed25519");
    const document = bom();
    document.inventories[0].components[0] = signJss(
      document.inventories[0].components[0],
      { algorithm: "Ed25519", privateKey: supplier.privateKey },
    );
    const signed = signJss(document, {
      algorithm: "Ed25519",
      privateKey: owner.privateKey,
    });
    assert.strictEqual(
      verifyJssBom(signed, { publicKey: owner.publicKey }).valid,
      false,
      "deep: the supplier's nested signature needs the supplier key",
    );
    assert.ok(
      verifyJssBom(signed, { publicKey: owner.publicKey, deep: false }).valid,
    );
    assert.ok(
      verifyJssBom(signed, {
        publicKeys: [owner.publicKey, supplier.publicKey],
      }).valid,
    );
    assert.strictEqual(
      verifyJssBom(signed, {
        publicKeys: [owner.publicKey, supplier.publicKey],
        requireAll: true,
      }).valid,
      false,
      "as with JSF, requireAll needs every key to verify a root signature",
    );
    const { bom: unsigned, removed } = removeJssSignatures(signed);
    assert.strictEqual(removed, 2);
    assert.strictEqual(
      unsigned.inventories[0].components[1].signatures,
      undefined,
    );
    assert.strictEqual(
      Object.hasOwn(unsigned.inventories[0], "signatures"),
      false,
      "members without signatures are not given an empty list",
    );
    const nestedOnly = signJssBom(unsigned, {
      algorithm: "Ed25519",
      privateKey: owner.privateKey,
    });
    delete nestedOnly.signatures;
    assert.strictEqual(
      verifyJssBom(nestedOnly, { publicKey: owner.publicKey }).valid,
      false,
    );
    assert.ok(
      verifyJssBom(nestedOnly, {
        publicKey: owner.publicKey,
        allowNestedOnly: true,
      }).valid,
    );
    assert.strictEqual(
      verifyJssBom(nestedOnly, {
        publicKey: owner.publicKey,
        allowNestedOnly: true,
        deep: false,
      }).valid,
      false,
    );
  });

  it("refuses a signed component presented as a BOM", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const component = signJss(
      { type: "library", name: "a" },
      { algorithm: "Ed25519", privateKey },
    );
    const verdict = verifyJssBom(component, { publicKey });
    assert.strictEqual(verdict.valid, false);
    assert.match(verdict.errors.join(" "), /not a CycloneDX BOM/u);
  });

  it("signs a rendered CycloneDX 2.0 BOM, root and nested", async () => {
    const { createBom } = await import("../cli/index.js");
    const { postProcess } = await import("../stages/postgen/postgen.js");
    const options = { projectType: ["js"], specVersion: "2.0" };
    const bomNSData = await createBom(
      join("test", "data", "svelte-precision"),
      options,
    );
    await postProcess(
      bomNSData,
      options,
      join("test", "data", "svelte-precision"),
    );
    const { privateKey, publicKey } = generateJssKeyPair("Ed25519");
    const signed = signJssBom(bomNSData.bomJson, {
      algorithm: "Ed25519",
      privateKey,
    });
    const verdict = verifyJssBom(signed, { publicKey, requireAll: true });
    assert.ok(verdict.valid, JSON.stringify(verdict.errors));
    assert.ok(verdict.nested.length > 0, "nested members are signed too");
    const { default: validate20 } = await import(
      "../validator/generated/validate-2.0.mjs"
    );
    assert.ok(validate20(signed), "the signed BOM validates");
    const tampered = structuredClone(signed);
    tampered.inventories[0].components[0].name = "tampered";
    assert.strictEqual(verifyJssBom(tampered, { publicKey }).valid, false);
  });
});
