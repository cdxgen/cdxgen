/**
 * JSON Signature Scheme (JSS) signing and verification for CycloneDX 2.0.
 *
 * Implemented from Recommendation ITU-T X.590 (10/2023), "JSON signature
 * scheme". Clause citations below refer to that text:
 *
 * - clause 6.2.1: the signature object members (`hash_algorithm`,
 *   `algorithm`, `public_key`, `value`, the countersignature `signature`)
 *   and, in its footnote, that one of `public_key`, `public_cert_chain`,
 *   `cert_url` or `thumbprint` is present;
 * - clause 6.2.2 and Table 1: the algorithm vocabulary;
 * - clause 7.1.2: existing signatures are temporarily removed;
 * - clause 7.1.3: the new signature object (without its value) is added;
 * - clause 7.1.4: the entire JSON object is canonicalized with JCS
 *   [IETF RFC 8785];
 * - clause 7.1.5: the JCS version is hashed with `hash_algorithm`, and the
 *   hash is presented in (lowercase) hex;
 * - clause 7.1.6: that hash is signed with `algorithm` and the result is
 *   base64URL-encoded;
 * - clause 7.1.7: pre-existing signatures are restored at the start of the
 *   list and the new entry is appended with its `value`;
 * - clause 7.2: a countersignature is a signature object nested in the
 *   `signature` member of the signature it countersigns. The countersigned
 *   entry keeps its `value` in the signed view (7.2.1, 7.2.3, 7.2.4) and the
 *   other entries are removed (7.2.2);
 * - clause 8.1: verification keeps only the entry under verification
 *   (8.1.1), removes its `value` (8.1.2), takes the key from the entry or a
 *   trusted source (8.1.3), canonicalizes (8.1.4), hashes (8.1.5) and
 *   validates (8.1.6).
 *
 * The signed message. The clause 7.1.6 example value
 * (`F1Sj4V...`) and the clause 7.2.6 countersignature value (`b_7Xu5...`)
 * are reproduced byte for byte only when the message given to the signing
 * primitive is the UTF-8 text of the lowercase hex hash of clause 7.1.5
 * (and 7.2.5). Ed25519 and Ed448 sign that message directly. RS*, PS* and
 * ES* pass the same message to the JOSE primitive named in Table 1 (JWA
 * [IETF RFC 7518] sections 3.3 to 3.5), which hashes it again with its own
 * SHA-2 digest; clause 6.2.1 `hash_algorithm` notes that the signing
 * process "sometimes uses an internal hashing algorithm". X.590 has no
 * RSA or ECDSA example, so that part follows from the text and the Ed25519
 * vectors rather than from a published vector.
 *
 * Trust. Clause 8.1.3 allows the key to be parsed from the entry or fetched
 * from a trusted source, and clause 8.1.6 leaves "public key lookup methods"
 * to policy. An embedded key with no trust anchor proves integrity only, so
 * {@link verifyJss} requires caller-supplied trusted keys and uses the
 * embedded key only with the explicit `allowEmbeddedKey` option, whose
 * results carry `trusted: false`.
 *
 * The signature object shape is also fixed by the pinned draft schema,
 * #/$defs/cyclonedx-jss_X590_2023_10-2.0/$defs/signatureObject. The
 * `public_key` value is the base64 form of the DER SubjectPublicKeyInfo
 * without the PEM armor (clause 6.2.1); the clause 7.1 examples store it
 * without base64 padding, which the schema pattern also allows.
 */

import {
  constants,
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  generateKeyPairSync,
  KeyObject,
} from "node:crypto";

import {
  BOM_20_ROOT_MEMBERS,
  canonicalizeJson,
  MAX_SIGNATURE_ENTRIES,
} from "./bomSigner.js";

/**
 * Quantum-safe algorithm names from X.590 Table 1 (clause 6.2.2) that
 * node:crypto cannot provide: every XMSS (IETF RFC 8391 section 5.3) and
 * LMS (IETF RFC 8554 section 5.1) value of the table.
 */
export const UNSUPPORTED_JSS_ALGORITHMS = Object.freeze([
  "XMSS-SHA2_10_256",
  "XMSS-SHA2_16_256",
  "XMSS-SHA2_20_256",
  "LMS_SHA256_M32_H5",
  "LMS_SHA256_M32_H10",
  "LMS_SHA256_M32_H15",
  "LMS_SHA256_M32_H20",
  "LMS_SHA256_M32_H25",
]);

// Clause 6.2.2: JWA defines HS256, HS384 and HS512, but they "SHOULD NOT be
// used" and the sharing of their keys is out of scope, so JSS here refuses
// them.
const HMAC_ALGORITHMS = Object.freeze(["HS256", "HS384", "HS512"]);

/**
 * The clause 6.2.1 `hash_algorithm` values accepted, by their IANA Named
 * Information Hash Algorithm Registry names, mapped to the node:crypto
 * digest. Anything else (md5, sha1, sha-224, unknown names) is refused when
 * signing and fails verification: clause 6.2.1 asks for a "current and
 * widely accepted hashing algorithm" defined in the IANA registry.
 */
export const JSS_HASH_ALGORITHMS = Object.freeze(
  Object.assign(Object.create(null), {
    "sha-256": "sha256",
    "sha-384": "sha384",
    "sha-512": "sha512",
    "sha3-256": "sha3-256",
    "sha3-384": "sha3-384",
    "sha3-512": "sha3-512",
  }),
);

// JWA [IETF RFC 7518] sections 3.3 and 3.5: a key of size 2048 bits or
// larger MUST be used with RS* and PS*.
const MIN_RSA_MODULUS_BITS = 2048;

const HASH_BYTES = Object.freeze({ sha256: 32, sha384: 48, sha512: 64 });

// X.590 Table 1 (clause 6.2.2) restricted to what node:crypto implements.
// `nodeHash` is the digest inside the JOSE primitive (Table 1 names it for
// every RS*, PS* and ES* entry); `defaultHash` is the clause 6.2.1
// `hash_algorithm` used when the caller names none.
const JSS_ALGORITHMS = new Map(
  [
    ["RS256", "rsa", ["rsa"], "sha256", "sha-256"],
    ["RS384", "rsa", ["rsa"], "sha384", "sha-384"],
    ["RS512", "rsa", ["rsa"], "sha512", "sha-512"],
    ["PS256", "rsa-pss", ["rsa", "rsa-pss"], "sha256", "sha-256"],
    ["PS384", "rsa-pss", ["rsa", "rsa-pss"], "sha384", "sha-384"],
    ["PS512", "rsa-pss", ["rsa", "rsa-pss"], "sha512", "sha-512"],
    ["ES256", "ec", ["ec"], "sha256", "sha-256", "prime256v1"],
    ["ES384", "ec", ["ec"], "sha384", "sha-384", "secp384r1"],
    ["ES512", "ec", ["ec"], "sha512", "sha-512", "secp521r1"],
    ["Ed25519", "eddsa", ["ed25519"], null, "sha-512"],
    ["Ed448", "eddsa", ["ed448"], null, "sha-512"],
  ].map(([name, family, keyTypes, nodeHash, defaultHash, curve]) => [
    name,
    Object.freeze({ family, keyTypes, nodeHash, defaultHash, curve }),
  ]),
);

/** JSS algorithm names this module signs and verifies. */
export const JSS_SIGNATURE_ALGORITHMS = Object.freeze([
  ...JSS_ALGORITHMS.keys(),
]);

const CURVE_ALGORITHMS = Object.freeze({
  prime256v1: "ES256",
  secp384r1: "ES384",
  secp521r1: "ES512",
});

/** Nested CycloneDX 2.0 members that carry `signatures` and are signed. */
const NESTED_SIGNATURE_TARGETS = Object.freeze([
  "inventories",
  "compositions",
  "annotations",
]);

const BOM_ROOT_MEMBER_SET = new Set(BOM_20_ROOT_MEMBERS);
const BOM_IDENTITY_MEMBERS = ["bomFormat", "specFormat", "specVersion"];

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const printable = (value) => {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return `<${typeof value}>`;
  }
};

const stripPadding = (text) => {
  let end = text.length;
  while (end > 0 && text[end - 1] === "=") {
    end--;
  }
  return text.slice(0, end);
};

let ed448Available;

/**
 * Whether this runtime's crypto provides Ed448. Bun links BoringSSL, which
 * has no Ed448, so key generation and key loading fail there with an
 * OpenSSL error; this check turns that into a clear message.
 *
 * @returns {boolean} true when Ed448 keys can be created
 */
export function isEd448Available() {
  if (ed448Available === undefined) {
    try {
      generateKeyPairSync("ed448");
      ed448Available = true;
    } catch {
      ed448Available = false;
    }
  }
  return ed448Available;
}

function algorithmSpec(algorithm) {
  const spec =
    typeof algorithm === "string" ? JSS_ALGORITHMS.get(algorithm) : undefined;
  if (spec) {
    if (algorithm === "Ed448" && !isEd448Available()) {
      throw new Error(
        "JSS algorithm Ed448 is not available in this runtime, whose crypto library has no Ed448 (Bun uses BoringSSL). Use Ed25519 or an ES* algorithm, or run under Node.js or Deno.",
      );
    }
    return spec;
  }
  if (UNSUPPORTED_JSS_ALGORITHMS.includes(algorithm)) {
    throw new Error(
      `JSS algorithm ${algorithm} is not supported: quantum-safe XMSS/LMS signing is not available in node:crypto.`,
    );
  }
  if (HMAC_ALGORITHMS.includes(algorithm)) {
    throw new Error(
      `JSS algorithm ${algorithm} is not supported: X.590 clause 6.2.2 says HMAC algorithms SHOULD NOT be used, and cdxgen does not sign or verify them for JSS.`,
    );
  }
  throw new Error(
    `Unsupported JSS algorithm: ${printable(algorithm)}. Supported algorithms: ${JSS_SIGNATURE_ALGORITHMS.join(", ")}.`,
  );
}

function nodeHashFor(hashAlgorithm) {
  if (
    typeof hashAlgorithm !== "string" ||
    !Object.hasOwn(JSS_HASH_ALGORITHMS, hashAlgorithm)
  ) {
    throw new Error(
      `Unsupported JSS hash_algorithm: ${printable(hashAlgorithm)}. Supported: ${Object.keys(JSS_HASH_ALGORITHMS).join(", ")}.`,
    );
  }
  return JSS_HASH_ALGORITHMS[hashAlgorithm];
}

function describeKey(key) {
  if (!(key instanceof KeyObject)) {
    return "not a key";
  }
  if (key.type === "secret") {
    return "a shared secret";
  }
  const details = key.asymmetricKeyDetails || {};
  if (details.namedCurve) {
    return `${key.asymmetricKeyType} (${details.namedCurve})`;
  }
  if (details.modulusLength) {
    return `${key.asymmetricKeyType} (${details.modulusLength} bits)`;
  }
  return String(key.asymmetricKeyType);
}

function describeRequirement(spec) {
  if (spec.curve) {
    return `an ec (${spec.curve}) key`;
  }
  if (spec.family === "rsa" || spec.family === "rsa-pss") {
    return `an ${spec.keyTypes.join(" or ")} key of at least ${MIN_RSA_MODULUS_BITS} bits`;
  }
  return `an ${spec.keyTypes[0]} key`;
}

/**
 * Checks that a key fits a JSS algorithm, the binding X.590 Table 1 (clause
 * 6.2.2) defines through JWA [IETF RFC 7518] sections 3.3 to 3.5 and
 * [IETF RFC 8037]: RS* need an rsa key, PS* an rsa or rsa-pss key, both of
 * at least 2048 bits; ES256, ES384 and ES512 need an ec key on P-256, P-384
 * and P-521 exactly; Ed25519 and Ed448 need that key type. Sign and verify
 * both call it, so a mislabelled entry fails before any signature math.
 *
 * @param {string} algorithm - JSS algorithm name
 * @param {KeyObject} key - Public or private key
 * @throws {Error} When the key does not fit the algorithm
 */
export function assertJssKeyMatchesAlgorithm(algorithm, key) {
  const spec = algorithmSpec(algorithm);
  let matches =
    key instanceof KeyObject &&
    key.type !== "secret" &&
    spec.keyTypes.includes(key.asymmetricKeyType);
  const details = matches ? key.asymmetricKeyDetails || {} : {};
  if (matches && spec.curve) {
    matches = details.namedCurve === spec.curve;
  }
  if (matches && (spec.family === "rsa" || spec.family === "rsa-pss")) {
    matches = (details.modulusLength || 0) >= MIN_RSA_MODULUS_BITS;
  }
  // An rsa-pss key may restrict its parameters (IETF RFC 4055); they must
  // allow the Table 1 digest, MGF1 with the same digest, and a salt the size
  // of the digest (JWA section 3.5).
  if (matches && key.asymmetricKeyType === "rsa-pss") {
    matches =
      (details.hashAlgorithm === undefined ||
        details.hashAlgorithm === spec.nodeHash) &&
      (details.mgf1HashAlgorithm === undefined ||
        details.mgf1HashAlgorithm === spec.nodeHash) &&
      (details.saltLength === undefined ||
        details.saltLength <= HASH_BYTES[spec.nodeHash]);
  }
  if (!matches) {
    throw new Error(
      `JSS algorithm ${algorithm} requires ${describeRequirement(spec)}, but the key is ${describeKey(key)}.`,
    );
  }
}

/**
 * Picks the JSS algorithm for a key: ES256, ES384 or ES512 by curve, RS256
 * for rsa, PS256 for rsa-pss, Ed25519 or Ed448 for those key types.
 *
 * @param {KeyObject} key - Public or private key
 * @returns {string} JSS algorithm name
 * @throws {Error} For a key type no JSS algorithm here supports
 */
export function selectJssAlgorithmForKey(key) {
  const type = key?.asymmetricKeyType;
  if (type === "ec") {
    const curve = key.asymmetricKeyDetails?.namedCurve;
    if (Object.hasOwn(CURVE_ALGORITHMS, curve)) {
      return CURVE_ALGORITHMS[curve];
    }
  } else if (type === "rsa") {
    return "RS256";
  } else if (type === "rsa-pss") {
    return "PS256";
  } else if (type === "ed25519") {
    return "Ed25519";
  } else if (type === "ed448") {
    return "Ed448";
  }
  throw new Error(
    `No JSS algorithm supports this key (${describeKey(key)}). Use an rsa, rsa-pss, ec (P-256, P-384, P-521), ed25519 or ed448 key.`,
  );
}

/** The base64 (unpadded, as in the X.590 clause 7.1 examples) DER SPKI. */
function spkiBase64(publicKey) {
  return stripPadding(
    publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  );
}

/** Parse a `public_key` value (padded or unpadded base64 DER SPKI). */
function parseSpkiBase64(value) {
  const text = stripPadding(value.replace(/\s+/g, ""));
  const der = Buffer.from(text, "base64");
  if (stripPadding(der.toString("base64")) !== text) {
    throw new Error("The public_key is not canonical base64.");
  }
  return createPublicKey({ key: der, format: "der", type: "spki" });
}

function toPublicKey(key) {
  if (key instanceof KeyObject) {
    if (key.type === "secret") {
      throw new Error(
        "A shared secret cannot verify JSS signatures; pass a public key.",
      );
    }
    return key.type === "private" ? createPublicKey(key) : key;
  }
  return createPublicKey(key);
}

function toPrivateKey(key) {
  if (key instanceof KeyObject) {
    if (key.type !== "private") {
      throw new Error(
        `JSS signing needs a private key, not a ${key.type} key.`,
      );
    }
    return key;
  }
  if (key === undefined || key === null) {
    throw new Error("JSS signing needs a private key.");
  }
  try {
    return createPrivateKey(key);
  } catch (err) {
    throw new Error(`Unable to load the JSS signing key: ${err.message}`);
  }
}

/**
 * The bytes handed to the signing primitive: the UTF-8 text of the lowercase
 * hex hash of the JCS form (clauses 7.1.5 and 7.1.6; the clause 7.1.6 and
 * 7.2.6 example values verify only over this message).
 */
function signedMessage(jcs, hashAlgorithm) {
  const digest = createHash(nodeHashFor(hashAlgorithm))
    .update(jcs, "utf8")
    .digest("hex");
  return Buffer.from(digest, "utf8");
}

function primitiveOptions(spec, key) {
  if (spec.family === "rsa") {
    // JWA section 3.3: RSASSA-PKCS1-v1_5 with the Table 1 SHA-2 digest.
    return { key, padding: constants.RSA_PKCS1_PADDING };
  }
  if (spec.family === "rsa-pss") {
    // JWA section 3.5: MGF1 uses the signing digest (node's default) and the
    // salt is the size of the digest output.
    return {
      key,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
    };
  }
  if (spec.family === "ec") {
    // JWA section 3.4: the signature is the fixed-size R || S pair.
    return { key, dsaEncoding: "ieee-p1363" };
  }
  // Ed25519/Ed448 ([IETF RFC 8037], [IETF RFC 8032]) sign the message itself.
  return key;
}

function decodeValue(value) {
  if (typeof value !== "string" || !value.length) {
    throw new Error("The signature value is missing (X.590 clause 8.1.2).");
  }
  const text = stripPadding(value);
  const bytes = Buffer.from(text, "base64url");
  if (bytes.toString("base64url") !== text) {
    throw new Error("The signature value is not canonical base64url.");
  }
  return bytes;
}

/**
 * Refuses values that JCS (IETF RFC 8785 sections 3.2.2.3 and 3.2.2.2)
 * cannot represent: numbers that are not finite and strings holding an
 * unpaired UTF-16 surrogate. JSON.stringify would silently turn the first
 * into null and escape the second, giving a canonical form other JCS
 * implementations reject.
 *
 * @param {*} value - Value about to be canonicalized
 * @param {string} [path] - JSON path for the error message
 * @throws {Error} For a value JCS cannot represent
 */
function assertJcsRepresentable(value, path = "$") {
  const stack = [[value, path]];
  while (stack.length) {
    const [current, where] = stack.pop();
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        throw new Error(
          `JCS cannot represent the number at ${where} (${current}).`,
        );
      }
    } else if (typeof current === "string") {
      if (!current.isWellFormed()) {
        throw new Error(
          `JCS cannot represent the string at ${where}: it holds an unpaired UTF-16 surrogate.`,
        );
      }
    } else if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index--) {
        stack.push([current[index], `${where}[${index}]`]);
      }
    } else if (current !== null && typeof current === "object") {
      for (const key of Object.keys(current)) {
        if (!key.isWellFormed()) {
          throw new Error(
            `JCS cannot represent a member name under ${where}: it holds an unpaired UTF-16 surrogate.`,
          );
        }
        stack.push([current[key], `${where}.${key}`]);
      }
    }
  }
}

/**
 * Returns a function producing the JCS text of `{ ...content, signatures:
 * [entry] }`, canonicalizing the content once (clause 7.1.4, 8.1.4).
 */
function viewSerializer(content) {
  assertJcsRepresentable(content);
  const before = [];
  const after = [];
  for (const name of Object.keys(content).sort()) {
    const member = canonicalizeJson(content[name]);
    if (member !== undefined) {
      (name < "signatures" ? before : after).push(
        `${JSON.stringify(name)}:${member}`,
      );
    }
  }
  return (entry) => {
    assertJcsRepresentable(entry, "$.signatures");
    return `{${[...before, `"signatures":[${canonicalizeJson(entry)}]`, ...after].join(",")}}`;
  };
}

function withoutValueAndCountersignature(entry) {
  // Clause 8.1.2 removes the value. A nested `signature` was added after
  // this entry was signed (clauses 7.2.3, 7.2.7), so it is not part of what
  // this entry covers; it is verified on its own (clause 7.2).
  const { value: _value, signature: _countersignature, ...rest } = entry;
  return rest;
}

function readSignatures(document) {
  if (!isPlainObject(document)) {
    throw new Error(
      "JSS signs and verifies JSON objects only (X.590 clause 7).",
    );
  }
  const { signatures } = document;
  if (signatures === undefined) {
    return [];
  }
  if (!Array.isArray(signatures)) {
    throw new Error("The signatures member must be a list (X.590 clause 6).");
  }
  return signatures;
}

/**
 * Flattens each root entry and its countersignature chain (clause 7.2) into
 * the list of signature objects to verify.
 */
function signatureChain(entry) {
  const chain = [entry];
  let current = entry;
  while (isPlainObject(current) && current.signature !== undefined) {
    current = current.signature;
    chain.push(current);
    if (chain.length > MAX_SIGNATURE_ENTRIES) {
      throw new Error(
        `A countersignature chain holds at most ${MAX_SIGNATURE_ENTRIES} signature objects.`,
      );
    }
  }
  return chain;
}

/**
 * The single signature object of the signed view for depth `depth` of a
 * chain: the ancestors keep their values (clauses 7.2.1, 7.2.4), the object
 * under verification loses its value and any later countersignature.
 */
function chainView(chain, depth) {
  let node = withoutValueAndCountersignature(chain[depth]);
  for (let index = depth - 1; index >= 0; index--) {
    node = { ...chain[index], signature: node };
  }
  return node;
}

function signEntry(serialize, entry, hashAlgorithm, spec, key) {
  const message = signedMessage(serialize(entry), hashAlgorithm);
  // Clause 7.1.6: base64URL without padding (node's base64url has none).
  return cryptoSign(
    spec.nodeHash,
    message,
    primitiveOptions(spec, key),
  ).toString("base64url");
}

function prepareSigning(algorithm, privateKey, hashAlgorithm) {
  const spec = algorithmSpec(algorithm);
  const hashName = hashAlgorithm ?? spec.defaultHash;
  nodeHashFor(hashName);
  const key = toPrivateKey(privateKey);
  assertJssKeyMatchesAlgorithm(algorithm, key);
  const entry = {
    hash_algorithm: hashName,
    algorithm,
    public_key: spkiBase64(createPublicKey(key)),
  };
  return { spec, hashName, key, entry };
}

/**
 * Sign a JSON object with JSS (X.590 clause 7.1). Existing entries stay
 * valid: they are removed while the new entry is computed (clause 7.1.2)
 * and restored ahead of it (clause 7.1.7). The input is not mutated.
 *
 * @param {object} document - The JSON object to sign
 * @param {object} options
 * @param {string} options.algorithm - JSS algorithm name (clause 6.2.2)
 * @param {KeyObject|string|Buffer} options.privateKey - Private key (KeyObject or PEM)
 * @param {string} [options.hashAlgorithm] - Clause 6.2.1 hash; one of {@link JSS_HASH_ALGORITHMS}
 * @returns {object} A new object carrying the `signatures` array
 */
export function signJss(
  document,
  { algorithm, privateKey, hashAlgorithm } = {},
) {
  const existing = readSignatures(document);
  if (existing.length >= MAX_SIGNATURE_ENTRIES) {
    throw new Error(
      `Cannot append another JSS signature: at most ${MAX_SIGNATURE_ENTRIES} are supported.`,
    );
  }
  const { spec, hashName, key, entry } = prepareSigning(
    algorithm,
    privateKey,
    hashAlgorithm,
  );
  // Clause 7.1.2: temporarily remove existing signatures.
  const { signatures: _existing, ...rest } = document;
  // Clauses 7.1.3-7.1.6: add the entry without its value, canonicalize,
  // hash, sign the hex hash and base64URL-encode.
  const value = signEntry(viewSerializer(rest), entry, hashName, spec, key);
  // Clause 7.1.7: existing signatures first, the new entry appended.
  return { ...rest, signatures: [...existing, { ...entry, value }] };
}

/**
 * Countersign a JSS signature (X.590 clause 7.2): the new signature object
 * goes into the `signature` member at the end of the countersignature chain
 * of `signatures[index]`, and covers the document plus that entry and its
 * chain, values included. Other entries are left out of the signed view
 * (clause 7.2.2) and restored ahead of the countersigned entry (clause
 * 7.2.7). The input is not mutated.
 *
 * @param {object} document - The signed JSON object
 * @param {object} options
 * @param {string} options.algorithm - JSS algorithm name (clause 6.2.2)
 * @param {KeyObject|string|Buffer} options.privateKey - Private key (KeyObject or PEM)
 * @param {string} [options.hashAlgorithm] - Clause 6.2.1 hash
 * @param {number} [options.index] - Entry to countersign; required when there are several
 * @returns {object} A new object carrying the countersigned `signatures` array
 */
export function countersignJss(
  document,
  { algorithm, privateKey, hashAlgorithm, index } = {},
) {
  const existing = readSignatures(document);
  if (!existing.length) {
    throw new Error("There is no JSS signature to countersign.");
  }
  // With several entries the caller must say which one is countersigned.
  const target = index ?? (existing.length === 1 ? 0 : undefined);
  if (!Number.isInteger(target) || target < 0 || target >= existing.length) {
    throw new Error(
      `Name the JSS signature to countersign: the document has ${existing.length} entries.`,
    );
  }
  if (!isPlainObject(existing[target])) {
    throw new Error("The countersigned entry is not a JSS signature object.");
  }
  const chain = signatureChain(existing[target]);
  if (chain.length >= MAX_SIGNATURE_ENTRIES) {
    throw new Error(
      `Cannot countersign: a chain holds at most ${MAX_SIGNATURE_ENTRIES} signature objects.`,
    );
  }
  const { spec, hashName, key, entry } = prepareSigning(
    algorithm,
    privateKey,
    hashAlgorithm,
  );
  const attach = (countersignature) => {
    let node = countersignature;
    for (let depth = chain.length - 1; depth >= 0; depth--) {
      node = { ...chain[depth], signature: node };
    }
    return node;
  };
  const { signatures: _existing, ...rest } = document;
  // Clauses 7.2.2-7.2.6: only the countersigned entry, which keeps its
  // value, with the new object (without value) nested in it.
  const value = signEntry(
    viewSerializer(rest),
    attach(entry),
    hashName,
    spec,
    key,
  );
  // Clause 7.2.7: the other entries first, then the countersigned one.
  return {
    ...rest,
    signatures: [
      ...existing.filter((_entry, position) => position !== target),
      attach({ ...entry, value }),
    ],
  };
}

function loadTrustedKeys({ publicKey, publicKeys } = {}) {
  const inputs = [];
  if (publicKey !== undefined && publicKey !== null) {
    inputs.push(publicKey);
  }
  if (Array.isArray(publicKeys)) {
    inputs.push(...publicKeys);
  } else if (publicKeys !== undefined && publicKeys !== null) {
    inputs.push(publicKeys);
  }
  return inputs.map((input) => {
    const key = toPublicKey(input);
    return { key, der: key.export({ type: "spki", format: "der" }) };
  });
}

function requireTrust(trustedKeys, allowEmbeddedKey) {
  if (!trustedKeys.length && !allowEmbeddedKey) {
    throw new Error(
      "JSS verification needs a trusted publicKey (or publicKeys). Pass allowEmbeddedKey: true for an integrity-only check with the keys embedded in the document.",
    );
  }
}

/**
 * Checks one signature object of a chain against the trusted keys.
 *
 * Status values: `verified` (a trusted key verifies it), `failed` (it names
 * a trusted key in `public_key` and does not verify with it, or it is
 * malformed and names a trusted key), `untrusted` (no trusted key verifies
 * it and it does not name one), `integrity-only` (only its embedded key
 * verifies it, with `allowEmbeddedKey`).
 */
function checkSignatureObject(item, serialize, view, trustedKeys, options) {
  const result = {
    algorithm: isPlainObject(item) ? item.algorithm : undefined,
    hashAlgorithm: isPlainObject(item) ? item.hash_algorithm : undefined,
    status: "untrusted",
    valid: false,
    trusted: false,
    claimsTrustedKey: false,
    keyIndex: undefined,
    reason: undefined,
  };
  if (!isPlainObject(item)) {
    result.status = "failed";
    result.reason = "Not a JSS signature object (X.590 clause 8.1.2).";
    return result;
  }
  // Which trusted key does the entry name? The embedded key is decoded and
  // its DER compared byte for byte with each trusted key, so a re-encoded
  // copy of a trusted key (padding, line breaks, whitespace) still counts as
  // naming it. A public_key that does not decode to a key names no trusted
  // key; the entry is untrusted (the X.590 clause 7.1.6 example carries such
  // a placeholder signer), or failed under allowEmbeddedKey.
  const embedded = item.public_key;
  let candidates = trustedKeys.map((trusted, keyIndex) => ({
    ...trusted,
    keyIndex,
  }));
  if (embedded !== undefined) {
    let embeddedDer;
    try {
      if (typeof embedded !== "string") {
        throw new Error("The public_key must be a string.");
      }
      embeddedDer = parseSpkiBase64(embedded).export({
        type: "spki",
        format: "der",
      });
    } catch (err) {
      result.status = options.allowEmbeddedKey ? "failed" : "untrusted";
      result.reason = `The public_key is not a usable public key: ${err.message}`;
      return result;
    }
    candidates = candidates.filter((trusted) =>
      trusted.der.equals(embeddedDer),
    );
    result.claimsTrustedKey = candidates.length > 0;
  }
  try {
    const spec = algorithmSpec(item.algorithm);
    nodeHashFor(item.hash_algorithm);
    const signature = decodeValue(item.value);
    let message;
    const messageBytes = () => {
      message ??= signedMessage(serialize(view), item.hash_algorithm);
      return message;
    };
    const reasons = [];
    for (const candidate of candidates) {
      try {
        assertJssKeyMatchesAlgorithm(item.algorithm, candidate.key);
        if (
          cryptoVerify(
            spec.nodeHash,
            messageBytes(),
            primitiveOptions(spec, candidate.key),
            signature,
          )
        ) {
          return {
            ...result,
            status: "verified",
            valid: true,
            trusted: true,
            keyIndex: candidate.keyIndex,
          };
        }
        reasons.push(
          `The ${item.algorithm} signature does not verify with trusted key #${candidate.keyIndex + 1}: the signed content or signature metadata changed, or a different key made it.`,
        );
      } catch (err) {
        reasons.push(err.message);
      }
    }
    if (
      !result.claimsTrustedKey &&
      options.allowEmbeddedKey &&
      embedded !== undefined
    ) {
      const key = parseSpkiBase64(item.public_key);
      assertJssKeyMatchesAlgorithm(item.algorithm, key);
      const ok = cryptoVerify(
        spec.nodeHash,
        messageBytes(),
        primitiveOptions(spec, key),
        signature,
      );
      return {
        ...result,
        status: ok ? "integrity-only" : "failed",
        valid: ok,
        reason: ok
          ? "Verified with the key embedded in the entry, which no trusted key vouches for."
          : "The signature does not verify with its embedded public_key.",
      };
    }
    if (result.claimsTrustedKey) {
      result.status = "failed";
    }
    result.reason =
      [...new Set(reasons)].join(" ") ||
      (embedded !== undefined
        ? "Signed by a key that is not one of the trusted keys."
        : "No trusted key verifies this entry.");
    return result;
  } catch (err) {
    result.status =
      result.claimsTrustedKey || options.allowEmbeddedKey
        ? "failed"
        : "untrusted";
    result.reason = err?.message || String(err);
    return result;
  }
}

/**
 * Verify the JSS signatures of a JSON object (X.590 clauses 8.1 and 7.2).
 *
 * Each entry is verified on its own view: the other entries are removed
 * (clause 8.1.1) and the entry loses only its `value` (clause 8.1.2) and any
 * nested countersignature, so every other member (`signee`, `valid_until`,
 * `revoked`, ...) is covered. Each countersignature in an entry's `signature`
 * chain is verified on the clause 7.2 view and reported with `depth` > 0.
 *
 * Trust comes from the caller (clause 8.1.3 "fetch it from a trusted
 * source"). An entry whose `public_key` is a trusted key is checked with that
 * key only; an entry without `public_key` (thumbprint, certificate chain,
 * certificate URL) is checked with every trusted key. The embedded key is
 * used only with `allowEmbeddedKey`, and such results carry
 * `trusted: false`.
 *
 * Policy: with trusted keys, the object verifies when at least one
 * signature object verifies with a trusted key and no signature object that
 * names a trusted key fails. With `requireAll`, every signature object must
 * verify with a trusted key, and with `requireEveryKey` every trusted key
 * must verify one of them. With `allowEmbeddedKey` and no trusted keys,
 * every signature object must verify with its embedded key, and the result
 * is `trusted: false`.
 *
 * @param {object} document - The signed JSON object
 * @param {object} options
 * @param {KeyObject|string|Buffer} [options.publicKey] - A trusted public key
 * @param {Array<KeyObject|string|Buffer>} [options.publicKeys] - Trusted public keys
 * @param {boolean} [options.allowEmbeddedKey] - Fall back to each entry's embedded public_key for an integrity-only check (results are `trusted: false`)
 * @param {boolean} [options.requireAll] - Every signature object must verify with a trusted key
 * @param {boolean} [options.requireEveryKey] - With requireAll, every trusted key must verify a signature object
 * @returns {{valid: boolean, trusted: boolean, reasons: string[], keysMatched: boolean[], results: Array<{index: number, depth: number, path: string, algorithm: any, hashAlgorithm: any, status: string, valid: boolean, trusted: boolean, claimsTrustedKey: boolean, keyIndex: (number|undefined), reason: (string|undefined)}>}}
 * @throws {Error} When neither a trusted key nor allowEmbeddedKey is given
 */
export function verifyJss(document, options = {}) {
  const trustedKeys = loadTrustedKeys(options);
  const allowEmbeddedKey = Boolean(options.allowEmbeddedKey);
  requireTrust(trustedKeys, allowEmbeddedKey);
  const report = {
    valid: false,
    trusted: false,
    reasons: [],
    keysMatched: trustedKeys.map(() => false),
    results: [],
  };
  let signatures;
  try {
    signatures = readSignatures(document);
    if (!signatures.length) {
      throw new Error("The object has no JSS signatures.");
    }
    if (signatures.length > MAX_SIGNATURE_ENTRIES) {
      throw new Error(
        `The signatures list has ${signatures.length} entries; at most ${MAX_SIGNATURE_ENTRIES} are supported.`,
      );
    }
  } catch (err) {
    report.reasons.push(err.message);
    return report;
  }
  const { signatures: _removed, ...rest } = document;
  let serialize;
  try {
    serialize = viewSerializer(rest);
  } catch (err) {
    report.reasons.push(err.message);
    return report;
  }
  let total = 0;
  for (const [index, entry] of signatures.entries()) {
    let chain;
    try {
      chain = signatureChain(entry);
    } catch (err) {
      report.results.push({
        index,
        depth: 0,
        path: `signatures[${index}]`,
        algorithm: entry?.algorithm,
        hashAlgorithm: entry?.hash_algorithm,
        status: "failed",
        valid: false,
        trusted: false,
        claimsTrustedKey: false,
        keyIndex: undefined,
        reason: err.message,
      });
      continue;
    }
    total += chain.length;
    if (total > MAX_SIGNATURE_ENTRIES) {
      report.reasons.push(
        `The object holds more than ${MAX_SIGNATURE_ENTRIES} signature objects.`,
      );
      return report;
    }
    for (let depth = 0; depth < chain.length; depth++) {
      const result = checkSignatureObject(
        chain[depth],
        serialize,
        chainView(chain, depth),
        trustedKeys,
        { allowEmbeddedKey },
      );
      if (result.keyIndex !== undefined) {
        report.keysMatched[result.keyIndex] = true;
      }
      report.results.push({
        index,
        depth,
        path: `signatures[${index}]${".signature".repeat(depth)}`,
        ...result,
      });
    }
  }
  const { results } = report;
  if (trustedKeys.length) {
    // A countersignature vouches for the signature it is attached to, so one
    // that no trusted key verifies is a claim the reader cannot check. It
    // fails the verdict like an entry that names a trusted key and does not
    // verify; the caller passes the countersigner's key to accept it.
    const failedClaim = results.some(
      (result) =>
        result.status !== "verified" &&
        (result.claimsTrustedKey || result.depth > 0),
    );
    for (const result of results) {
      if (result.depth > 0 && result.status !== "verified") {
        report.reasons.push(
          `The countersignature at ${result.path} does not verify with a trusted key; pass the countersigner's public key to accept it.`,
        );
      }
    }
    report.valid = options.requireAll
      ? results.every((result) => result.status === "verified") &&
        (!options.requireEveryKey || report.keysMatched.every(Boolean))
      : results.some((result) => result.status === "verified") && !failedClaim;
    report.trusted = report.valid;
  } else {
    report.valid = results.every((result) => result.valid);
  }
  return report;
}

function hasBomIdentity(bom) {
  return (
    (bom.specFormat === "CycloneDX" || bom.bomFormat === "CycloneDX") &&
    typeof bom.specVersion === "string" &&
    bom.specVersion !== ""
  );
}

function hasSignatureEntries(item) {
  return (
    isPlainObject(item) &&
    Array.isArray(item.signatures) &&
    item.signatures.length > 0
  );
}

function nestedTargets(bom) {
  const targets = [];
  const add = (path, item) => targets.push({ path, item });
  if (Array.isArray(bom.inventories)) {
    bom.inventories.forEach((inventory, index) => {
      add(`inventories[${index}]`, inventory);
      if (Array.isArray(inventory?.components)) {
        inventory.components.forEach((component, componentIndex) => {
          add(`inventories[${index}].components[${componentIndex}]`, component);
        });
      }
    });
  }
  for (const member of ["compositions", "annotations"]) {
    if (Array.isArray(bom[member])) {
      bom[member].forEach((item, index) => {
        add(`${member}[${index}]`, item);
      });
    }
  }
  return targets;
}

/**
 * Remove every JSS signature from a CycloneDX 2.0 BOM: the root and the
 * nested members {@link signJssBom} signs. Members are only touched where
 * they carry `signatures`. The input is not mutated.
 *
 * @param {object} bom20 - CycloneDX 2.0 document
 * @returns {{bom: object, removed: number}} The unsigned document and the number of signature entries removed
 */
export function removeJssSignatures(bom20) {
  let removed = 0;
  const strip = (item) => {
    if (!isPlainObject(item) || !Object.hasOwn(item, "signatures")) {
      return item;
    }
    const { signatures, ...rest } = item;
    removed += Array.isArray(signatures) ? signatures.length : 1;
    return rest;
  };
  const bom = strip(bom20);
  if (Array.isArray(bom.inventories)) {
    bom.inventories = bom.inventories.map((inventory) => {
      const unsigned = strip(inventory);
      return isPlainObject(unsigned) && Array.isArray(unsigned.components)
        ? { ...unsigned, components: unsigned.components.map(strip) }
        : unsigned;
    });
  }
  for (const member of ["compositions", "annotations"]) {
    if (Array.isArray(bom[member])) {
      bom[member] = bom[member].map(strip);
    }
  }
  return { bom, removed };
}

/**
 * Sign a CycloneDX 2.0 BOM: the root document plus, with `deep`, the nested
 * members the draft schema gives a `signatures` member to (inventories, the
 * components inside an inventory, compositions and annotations). Nested
 * members are signed first and the root last, so the root signature covers
 * them.
 *
 * Existing root entries stay valid when only the root is signed (clause
 * 7.1.2). Signing nested members changes content that existing root entries
 * cover (clause 7.1.4 canonicalizes the whole object), so `deep` signing of
 * a BOM that already carries root signatures is refused unless
 * `allowInvalidatingSignatures` is set.
 *
 * @param {object} bom20 - Rendered CycloneDX 2.0 document
 * @param {object} options - Passed to {@link signJss}
 * @param {boolean} [options.deep] - Also sign nested members (default true)
 * @param {boolean} [options.allowInvalidatingSignatures] - Sign nested members even though existing root signatures will no longer verify
 * @returns {object} The signed document
 */
export function signJssBom(bom20, options = {}) {
  const {
    deep = true,
    allowInvalidatingSignatures = false,
    ...signOptions
  } = options;
  if (!isPlainObject(bom20)) {
    throw new Error("The BOM must be a JSON object.");
  }
  if (!deep) {
    return signJss(bom20, signOptions);
  }
  if (hasSignatureEntries(bom20) && !allowInvalidatingSignatures) {
    throw new Error(
      "Signing nested members would change content that the existing root JSS signature(s) cover, so they would no longer verify. Sign the root only, or remove the existing signatures first.",
    );
  }
  const signItem = (item) =>
    isPlainObject(item) ? signJss(item, signOptions) : item;
  let signed = bom20;
  if (Array.isArray(signed.inventories)) {
    signed = {
      ...signed,
      inventories: signed.inventories.map((inventory) => {
        if (!isPlainObject(inventory)) {
          return inventory;
        }
        // Inside out: components first, then the inventory (which covers
        // the signed components), the root last.
        return signItem(
          Array.isArray(inventory.components)
            ? { ...inventory, components: inventory.components.map(signItem) }
            : inventory,
        );
      }),
    };
  }
  for (const member of NESTED_SIGNATURE_TARGETS.slice(1)) {
    if (Array.isArray(signed[member])) {
      signed = { ...signed, [member]: signed[member].map(signItem) };
    }
  }
  return signJss(signed, signOptions);
}

/**
 * Verify the JSS signatures of a CycloneDX 2.0 BOM, root and nested, with
 * the same policy {@link verifyBomSignatures} applies to JSF:
 *
 * - the root must carry `specFormat` (or `bomFormat`) "CycloneDX" and
 *   `specVersion`, and only members CycloneDX defines at the root;
 * - the root signatures verify as {@link verifyJss} defines; with
 *   `requireAll`, every root signature object verifies with a trusted key
 *   and every trusted key verifies one of them;
 * - with `deep` (default), every signed inventory, inventory component,
 *   composition and annotation verifies the same way (without the
 *   every-key rule) and carries none of `bomFormat`, `specFormat`,
 *   `specVersion`;
 * - a BOM without root signatures fails unless `allowNestedOnly` is set;
 *   then `deep` must be on and every nested member must be signed.
 *
 * @param {object} bom20 - Signed CycloneDX 2.0 document
 * @param {object} options - Trust options passed to {@link verifyJss}
 * @param {boolean} [options.deep] - Also verify nested signatures (default true)
 * @param {boolean} [options.requireAll] - Every signature object must verify with a trusted key
 * @param {boolean} [options.allowNestedOnly] - Accept a BOM without root signatures when every nested member is signed
 * @returns {{valid: boolean, trusted: boolean, errors: string[], root: (object|null), results: Array, nested: Array<{path: string, valid: boolean, trusted: boolean, reasons: string[], results: Array}>}}
 * @throws {Error} When neither a trusted key nor allowEmbeddedKey is given
 */
export function verifyJssBom(bom20, options = {}) {
  const deep = options.deep !== false;
  const allowNestedOnly = Boolean(options.allowNestedOnly);
  const requireAll = Boolean(options.requireAll);
  const trustOptions = {
    publicKey: options.publicKey,
    publicKeys: options.publicKeys,
    allowEmbeddedKey: Boolean(options.allowEmbeddedKey),
    requireAll,
  };
  requireTrust(loadTrustedKeys(trustOptions), trustOptions.allowEmbeddedKey);
  const report = {
    valid: false,
    trusted: false,
    errors: [],
    root: null,
    results: [],
    nested: [],
  };
  if (!isPlainObject(bom20)) {
    report.errors.push("The BOM must be a JSON object.");
    return report;
  }
  if (!hasBomIdentity(bom20)) {
    report.errors.push(
      'The signed object is not a CycloneDX BOM: its root needs specFormat "CycloneDX" and a specVersion.',
    );
  }
  const unexpected = Object.keys(bom20).filter(
    (name) => !BOM_ROOT_MEMBER_SET.has(name),
  );
  if (unexpected.length) {
    report.errors.push(
      `The BOM has members that CycloneDX does not define at the root of a BOM: ${unexpected.slice(0, 10).map(printable).join(", ")}.`,
    );
  }
  const nestedOnly = !hasSignatureEntries(bom20);
  if (!nestedOnly) {
    report.root = verifyJss(bom20, {
      ...trustOptions,
      requireEveryKey: requireAll,
    });
    report.results = report.root.results;
    if (requireAll) {
      const unmatched = report.root.keysMatched.flatMap((matched, index) =>
        matched ? [] : [`#${index + 1}`],
      );
      if (unmatched.length) {
        report.errors.push(
          `No root signature verifies with key ${unmatched.join(", ")}, so a signature expected from that key is missing.`,
        );
      }
    }
  } else if (
    bom20.signatures !== undefined &&
    !Array.isArray(bom20.signatures)
  ) {
    report.errors.push("The root signatures member must be a list.");
  } else if (!allowNestedOnly) {
    report.errors.push(
      "The BOM has no root signature, so no signature covers the BOM as a whole.",
    );
  } else if (!deep) {
    report.errors.push(
      "The BOM has no root signature, and nested signatures were not checked.",
    );
  }
  if (deep) {
    const unsigned = [];
    for (const { path, item } of nestedTargets(bom20)) {
      if (!hasSignatureEntries(item)) {
        unsigned.push(path);
        continue;
      }
      const identity = BOM_IDENTITY_MEMBERS.filter((name) =>
        Object.hasOwn(item, name),
      );
      if (identity.length) {
        report.errors.push(
          `${path} carries ${identity.join(", ")}, which only the root of a BOM may hold.`,
        );
      }
      report.nested.push({ path, ...verifyJss(item, trustOptions) });
    }
    if (nestedOnly && allowNestedOnly) {
      if (!report.nested.length) {
        report.errors.push("The BOM has no signatures.");
      }
      if (unsigned.length) {
        report.errors.push(
          `${unsigned.length} nested members are not signed, starting with ${unsigned[0]}.`,
        );
      }
    }
  }
  report.valid =
    !report.errors.length &&
    (report.root ? report.root.valid : allowNestedOnly && deep) &&
    report.nested.every((item) => item.valid);
  report.trusted =
    report.valid &&
    (report.root ? report.root.trusted : true) &&
    report.nested.every((item) => item.trusted);
  return report;
}

/**
 * Generate a JSS key pair for an algorithm (used by --generate-key-and-sign).
 *
 * @param {string} algorithm - JSS algorithm name
 * @returns {{privateKey: KeyObject, publicKey: KeyObject}}
 */
export function generateJssKeyPair(algorithm) {
  const spec = algorithmSpec(algorithm);
  if (spec.family === "rsa" || spec.family === "rsa-pss") {
    return generateKeyPairSync("rsa", { modulusLength: 3072 });
  }
  if (spec.family === "ec") {
    return generateKeyPairSync("ec", { namedCurve: spec.curve });
  }
  return generateKeyPairSync(spec.keyTypes[0]);
}
