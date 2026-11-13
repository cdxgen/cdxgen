import crypto from "node:crypto";

import { escapeControlCharacters } from "../core/text.js";

/**
 * JSF algorithm identifiers and the key material each one requires.
 *
 * The algorithm named in a signature block is chosen by whoever produced the
 * document, so it is only honoured when the key supplied by the signer or the
 * verifier is exactly the type listed here.
 */
const JSF_ALGORITHMS = new Map([
  ["RS256", { keyType: "rsa", hash: "sha256" }],
  ["RS384", { keyType: "rsa", hash: "sha384" }],
  ["RS512", { keyType: "rsa", hash: "sha512" }],
  ["PS256", { keyType: "rsa-pss", hash: "sha256" }],
  ["PS384", { keyType: "rsa-pss", hash: "sha384" }],
  ["PS512", { keyType: "rsa-pss", hash: "sha512" }],
  [
    "ES256",
    {
      keyType: "ec",
      hash: "sha256",
      curve: "prime256v1",
      order:
        0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n,
    },
  ],
  [
    "ES384",
    {
      keyType: "ec",
      hash: "sha384",
      curve: "secp384r1",
      order:
        0xffffffffffffffffffffffffffffffffffffffffffffffffc7634d81f4372ddf581a0db248b0a77aecec196accc52973n,
    },
  ],
  [
    "ES512",
    {
      keyType: "ec",
      hash: "sha512",
      curve: "secp521r1",
      order:
        0x01fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffa51868783bf2f966b7fcc0148f709a5d03bb5c9b8899c47aebb6fb71e91386409n,
    },
  ],
  ["Ed25519", { keyType: "ed25519", hash: null }],
  ["Ed448", { keyType: "ed448", hash: null }],
  ["HS256", { keyType: "secret", hash: "sha256" }],
  ["HS384", { keyType: "secret", hash: "sha384" }],
  ["HS512", { keyType: "secret", hash: "sha512" }],
]);

const SIGNATURE_MODES = ["replace", "signers", "chain"];

const NESTED_TARGETS = ["components", "services", "annotations"];

/**
 * Largest number of entries accepted in a `signers` or `chain` signature.
 * Every entry is checked against the whole signed object, so the bound keeps
 * the cost of verifying a document proportional to its size.
 */
export const MAX_SIGNATURE_ENTRIES = 32;

/**
 * Members the CycloneDX 1.4 to 1.7 schemas define at the root of a BOM, plus
 * `specFormat`, which an early 2.0 draft used in place of `bomFormat`. A JSF
 * root signature is only accepted on an object made of these members, so a
 * signed component, service, or annotation cannot pass as a signed BOM.
 */
export const BOM_ROOT_MEMBERS = Object.freeze([
  "$schema",
  "bomFormat",
  "specFormat",
  "specVersion",
  "serialNumber",
  "version",
  "metadata",
  "components",
  "services",
  "externalReferences",
  "dependencies",
  "compositions",
  "vulnerabilities",
  "annotations",
  "formulation",
  "declarations",
  "definitions",
  "citations",
  "properties",
  "signature",
]);

/**
 * Members the CycloneDX 2.0 draft schema defines at the root of a document.
 * A JSS root signature (lib/helpers/jssSigner.js) is only accepted on an
 * object made of these members.
 */
export const BOM_20_ROOT_MEMBERS = Object.freeze([
  "$schema",
  "$comment",
  "specFormat",
  "specVersion",
  "serialNumber",
  "version",
  "metadata",
  "inventories",
  "dependencies",
  "compositions",
  "vulnerabilities",
  "threats",
  "risks",
  "controls",
  "annotations",
  "formulation",
  "declarations",
  "definitions",
  "blueprints",
  "profiles",
  "citations",
  "perspectives",
  "properties",
  "externalReferences",
  "signatures",
]);

const BOM_ROOT_MEMBER_SET = new Set(BOM_ROOT_MEMBERS);

// Members that identify a BOM. Components, services, and annotations never hold
// them, so a nested object carrying one is refused for signing and verification.
const BOM_IDENTITY_MEMBERS = ["bomFormat", "specFormat", "specVersion"];

const MAX_LISTED_MEMBERS = 10;

// DER layouts tried when checking whether raw bytes are really a key.
const DER_KEY_LAYOUTS = [
  [crypto.createPublicKey, "spki"],
  [crypto.createPublicKey, "pkcs1"],
  [crypto.createPrivateKey, "pkcs8"],
  [crypto.createPrivateKey, "pkcs1"],
  [crypto.createPrivateKey, "sec1"],
];

/**
 * Renders a value taken from a document for a message. JSON can make any field
 * an object or array, and interpolating those directly can throw. Control and
 * line-break characters in the value are written as `\u` escapes, so printing
 * the message cannot rewrite the terminal line or start a new one.
 *
 * @param {any} value - Value to render
 * @returns {string} - Printable text
 */
export function displayValue(value) {
  if (typeof value === "string") {
    return escapeControlCharacters(value);
  }
  try {
    return escapeControlCharacters(JSON.stringify(value) ?? String(value));
  } catch {
    return `<${typeof value}>`;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function listMembers(names) {
  const shown = names.slice(0, MAX_LISTED_MEMBERS).map(displayValue);
  if (names.length > MAX_LISTED_MEMBERS) {
    shown.push(`and ${names.length - MAX_LISTED_MEMBERS} more`);
  }
  return shown.join(", ");
}

// A BOM names its format with bomFormat (CycloneDX 1.x) or specFormat (2.0).
function hasBomIdentity(bom) {
  return (
    (bom.bomFormat === "CycloneDX" || bom.specFormat === "CycloneDX") &&
    ((typeof bom.specVersion === "string" && bom.specVersion !== "") ||
      typeof bom.specVersion === "number")
  );
}

function unexpectedRootMembers(bom) {
  return Object.keys(bom).filter((name) => !BOM_ROOT_MEMBER_SET.has(name));
}

function bomIdentityMembers(item) {
  return BOM_IDENTITY_MEMBERS.filter((name) => Object.hasOwn(item, name));
}

/**
 * Deterministic JSON canonicalizer following RFC 8785 (JCS), which JSF uses to
 * produce the signed data. Values are serialized the way JSON.stringify would
 * see them, so an in-memory object and its parsed JSON form canonicalize
 * identically.
 *
 * @param {any} value - The JSON object/value to canonicalize
 * @returns {string|undefined} - Canonicalized JSON string, or undefined for values JSON omits
 */
export function canonicalizeJson(value) {
  if (typeof value?.toJSON === "function") {
    value = value.toJSON();
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJson(item) ?? "null").join(",")}]`;
  }
  const members = [];
  for (const key of Object.keys(value).sort()) {
    const member = canonicalizeJson(value[key]);
    if (member !== undefined) {
      members.push(`${JSON.stringify(key)}:${member}`);
    }
  }
  return `{${members.join(",")}}`;
}

/**
 * Returns a function that produces the UTF-8 bytes of the canonical form of
 * `{ ...content, signature }` for any signature value, canonicalizing the
 * content members only once. Canonical members are ordered by name, so the
 * `signature` member always sits between the members whose names sort before
 * it and those that sort after it.
 *
 * @param {Object} content - The signed object without its signature member
 * @returns {function(Object): Buffer} - Signed bytes for the given signature member
 */
function signedViewSerializer(content) {
  if (typeof content.toJSON === "function") {
    return (signature) =>
      Buffer.from(canonicalizeJson({ ...content, signature }), "utf8");
  }
  const before = [];
  const after = [];
  for (const name of Object.keys(content).sort()) {
    const member = canonicalizeJson(content[name]);
    if (member !== undefined) {
      (name < "signature" ? before : after).push(
        `${JSON.stringify(name)}:${member}`,
      );
    }
  }
  const head = Buffer.from(
    before.length ? `{${before.join(",")},` : "{",
    "utf8",
  );
  const tail = Buffer.from(after.length ? `,${after.join(",")}}` : "}", "utf8");
  return (signature) =>
    Buffer.concat([
      head,
      Buffer.from(`"signature":${canonicalizeJson(signature)}`, "utf8"),
      tail,
    ]);
}

function getAlgorithm(alg) {
  const spec = typeof alg === "string" ? JSF_ALGORITHMS.get(alg) : undefined;
  if (!spec) {
    const name =
      typeof alg === "string"
        ? displayValue(alg)
        : `<${alg === null ? "null" : typeof alg}>`;
    throw new Error(
      `Unsupported JSF algorithm: ${name}. Supported algorithms: ${[...JSF_ALGORITHMS.keys()].join(", ")}.`,
    );
  }
  return spec;
}

function describeRequirement(spec) {
  if (spec.keyType === "secret") {
    return "a shared secret";
  }
  if (spec.keyType === "rsa-pss") {
    return "an rsa or rsa-pss key";
  }
  if (spec.curve) {
    return `an ec (${spec.curve}) key`;
  }
  return `an ${spec.keyType} key`;
}

function describeKey(key) {
  if (key.type === "secret") {
    return "a shared secret";
  }
  const curve = key.asymmetricKeyDetails?.namedCurve;
  return curve
    ? `${key.asymmetricKeyType} (${curve})`
    : String(key.asymmetricKeyType);
}

function assertKeyMatchesAlgorithm(key, alg, spec) {
  let matches;
  if (spec.keyType === "secret" || key.type === "secret") {
    matches = spec.keyType === "secret" && key.type === "secret";
  } else if (spec.keyType === "rsa-pss") {
    matches = ["rsa", "rsa-pss"].includes(key.asymmetricKeyType);
  } else if (spec.keyType === "ec") {
    matches =
      key.asymmetricKeyType === "ec" &&
      key.asymmetricKeyDetails?.namedCurve === spec.curve;
  } else {
    matches = key.asymmetricKeyType === spec.keyType;
  }
  if (!matches) {
    throw new Error(
      `Algorithm ${alg} requires ${describeRequirement(spec)}, but the key is ${describeKey(key)}.`,
    );
  }
}

function parsesAsKey(create, input) {
  try {
    create(input);
    return true;
  } catch (err) {
    return err?.code === "ERR_MISSING_PASSPHRASE";
  }
}

function isJwkText(material) {
  try {
    const parsed = JSON.parse(material.toString("utf8"));
    return isPlainObject(parsed) && typeof parsed.kty === "string";
  } catch {
    return false;
  }
}

function looksLikeAsymmetricKey(material) {
  if (typeof material === "string" || Buffer.isBuffer(material)) {
    if (material.includes("-----BEGIN ") || isJwkText(material)) {
      return true;
    }
  }
  if (
    parsesAsKey(crypto.createPrivateKey, material) ||
    parsesAsKey(crypto.createPublicKey, material)
  ) {
    return true;
  }
  if (Buffer.isBuffer(material)) {
    return DER_KEY_LAYOUTS.some(([create, type]) =>
      parsesAsKey(create, { key: material, format: "der", type }),
    );
  }
  return false;
}

/**
 * Wraps shared-secret material for HMAC (HS256, HS384, HS512) signing or
 * verification.
 *
 * HMAC is only ever used with a key produced by this function (or any secret
 * KeyObject). Public and private keys are refused, so a document cannot switch
 * a verifier to HMAC and use its public key as the secret.
 *
 * @param {string|Buffer|crypto.KeyObject} material - Secret bytes, a UTF-8 string, or a secret KeyObject
 * @returns {crypto.KeyObject} - A secret KeyObject
 */
export function loadSharedSecret(material) {
  if (material instanceof crypto.KeyObject) {
    if (material.type !== "secret") {
      throw new Error(
        "HMAC signatures need a shared secret, but an asymmetric key was supplied.",
      );
    }
    return material;
  }
  if (typeof material !== "string" && !Buffer.isBuffer(material)) {
    throw new TypeError(
      "The shared secret must be a string, a Buffer, or a secret KeyObject.",
    );
  }
  if (looksLikeAsymmetricKey(material)) {
    throw new Error(
      "The shared secret looks like a public or private key. HMAC signatures must use a separate shared secret.",
    );
  }
  const bytes =
    typeof material === "string" ? Buffer.from(material, "utf8") : material;
  if (!bytes.length) {
    throw new Error("The shared secret is empty.");
  }
  return crypto.createSecretKey(bytes);
}

/**
 * Loads the key used to verify signatures.
 *
 * Strings and Buffers are always parsed as asymmetric keys (a private key is
 * reduced to its public half). To verify HMAC signatures, pass the result of
 * {@link loadSharedSecret} instead.
 *
 * @param {string|Buffer|Object|crypto.KeyObject} key - PEM text, a createPublicKey() input, or a KeyObject
 * @returns {crypto.KeyObject} - A public or secret KeyObject
 */
export function loadVerificationKey(key) {
  if (key instanceof crypto.KeyObject) {
    return key.type === "private" ? crypto.createPublicKey(key) : key;
  }
  try {
    return crypto.createPublicKey(key);
  } catch (err) {
    throw new Error(`Unable to load the verification key: ${err.message}`);
  }
}

function loadSigningKey(privateKey, alg, spec) {
  let key;
  if (spec.keyType === "secret") {
    key = loadSharedSecret(privateKey);
  } else if (privateKey instanceof crypto.KeyObject) {
    key = privateKey;
  } else {
    try {
      key = crypto.createPrivateKey(privateKey);
    } catch (err) {
      throw new Error(`Unable to load the signing key: ${err.message}`);
    }
  }
  assertKeyMatchesAlgorithm(key, alg, spec);
  if (spec.keyType !== "secret" && key.type !== "private") {
    throw new Error(
      `Signing with ${alg} needs a private key, but a ${key.type} key was supplied.`,
    );
  }
  return key;
}

/**
 * Generates a PEM key pair suitable for the given JSF algorithm.
 *
 * @param {string} algorithm - JSF algorithm identifier
 * @returns {{ publicKey: string, privateKey: string }} - PEM encoded SPKI public key and PKCS#8 private key
 */
export function generateSigningKeyPair(algorithm) {
  const spec = getAlgorithm(algorithm);
  const encoding = {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  };
  switch (spec.keyType) {
    case "secret":
      throw new Error(
        `${algorithm} uses a shared secret, so there is no key pair to generate.`,
      );
    case "rsa":
    case "rsa-pss":
      return crypto.generateKeyPairSync("rsa", {
        modulusLength: 4096,
        ...encoding,
      });
    case "ec":
      return crypto.generateKeyPairSync("ec", {
        namedCurve: spec.curve,
        ...encoding,
      });
    default:
      return crypto.generateKeyPairSync(spec.keyType, encoding);
  }
}

function signatureOptions(key, spec) {
  const options = { key };
  if (spec.keyType === "rsa-pss") {
    options.padding = crypto.constants.RSA_PKCS1_PSS_PADDING;
    // JWA fixes the PSS salt length to the digest length.
    options.saltLength = crypto.constants.RSA_PSS_SALTLEN_DIGEST;
  } else if (spec.keyType === "ec") {
    // Standard JWA format requires IEEE P1363 (R || S) instead of ASN.1 DER
    options.dsaEncoding = "ieee-p1363";
  }
  return options;
}

/**
 * Returns the ECDSA signature (r || s) with s in the lower half of the curve
 * order. (r, s) and (r, n - s) both verify, so emitting only the low form gives
 * each signature a single encoding.
 */
function toLowS(signature, order) {
  const size = signature.length / 2;
  const s = BigInt(`0x${signature.subarray(size).toString("hex")}`);
  if (s <= order >> 1n) {
    return signature;
  }
  const lowS = Buffer.from(
    (order - s).toString(16).padStart(size * 2, "0"),
    "hex",
  );
  return Buffer.concat([signature.subarray(0, size), lowS]);
}

function computeSignature(data, key, spec) {
  if (spec.keyType === "secret") {
    return crypto.createHmac(spec.hash, key).update(data).digest();
  }
  const signature = crypto.sign(spec.hash, data, signatureOptions(key, spec));
  return spec.order ? toLowS(signature, spec.order) : signature;
}

function signatureMatches(data, key, spec, signature) {
  if (spec.keyType === "secret") {
    const expected = crypto.createHmac(spec.hash, key).update(data).digest();
    return (
      signature.length === expected.length &&
      crypto.timingSafeEqual(signature, expected)
    );
  }
  return crypto.verify(spec.hash, data, signatureOptions(key, spec), signature);
}

// KeyObject.equals() on keys of different types leaves an OpenSSL error queued,
// which the next unrelated key operation in the process then throws. Compare
// the key types first so a hostile embedded key cannot disturb later checks.
function isSameKey(a, b) {
  return (
    a.type === b.type &&
    a.asymmetricKeyType === b.asymmetricKeyType &&
    a.asymmetricKeyDetails?.namedCurve === b.asymmetricKeyDetails?.namedCurve &&
    a.equals(b)
  );
}

function publicKeyFromJwk(jwk) {
  if (!isPlainObject(jwk)) {
    throw new Error("The signature publicKey must be a JWK object.");
  }
  return crypto.createPublicKey({ key: jwk, format: "jwk" });
}

function embeddablePublicKey(publicKeyJwk, signingKey, alg) {
  if (!publicKeyJwk) {
    return undefined;
  }
  if (signingKey.type === "secret") {
    throw new Error(
      `${alg} signatures use a shared secret, so a public key cannot be embedded.`,
    );
  }
  const derived = crypto.createPublicKey(signingKey);
  if (!isSameKey(publicKeyFromJwk(publicKeyJwk), derived)) {
    throw new Error(
      "The public key to embed in the signature does not belong to the signing key.",
    );
  }
  // Export from the derived key so that only public members are ever embedded.
  return derived.export({ format: "jwk" });
}

/**
 * Splits a JSF signature property into its signature objects.
 *
 * @returns {{ form: "single"|"signers"|"chain", entries: Object[], wrapper: Object }}
 */
function readSignatureEntries(signature) {
  if (!isPlainObject(signature)) {
    throw new Error("The signature must be a JSON object.");
  }
  const hasSigners = Object.hasOwn(signature, "signers");
  const hasChain = Object.hasOwn(signature, "chain");
  if (hasSigners && hasChain) {
    throw new Error("A signature cannot contain both signers and chain.");
  }
  if (!hasSigners && !hasChain) {
    return { form: "single", entries: [signature], wrapper: {} };
  }
  const form = hasSigners ? "signers" : "chain";
  const { [form]: entries, ...wrapper } = signature;
  const wrapperMembers = Object.keys(wrapper);
  if (wrapperMembers.includes("excludes")) {
    throw new Error("Signatures that use JSF excludes are not supported.");
  }
  if (wrapperMembers.length) {
    throw new Error(
      `A ${form} signature may only hold the ${form} array, but it also holds ${listMembers(wrapperMembers)}.`,
    );
  }
  if (
    !Array.isArray(entries) ||
    !entries.length ||
    !entries.every(isPlainObject)
  ) {
    throw new Error(`The ${form} array must contain signature objects.`);
  }
  if (entries.length > MAX_SIGNATURE_ENTRIES) {
    throw new Error(
      `The ${form} array has ${entries.length} entries; at most ${MAX_SIGNATURE_ENTRIES} are supported.`,
    );
  }
  return { form, entries, wrapper };
}

function withoutValue(entry) {
  const { value: _value, ...rest } = entry;
  return rest;
}

/**
 * Builds the signature member that is signed for entry `index`.
 *
 * Following JSF, only the `value` of the entry being processed is removed.
 * Other `signers` are removed entirely, while a `chain` entry keeps every
 * earlier entry (including its value) and drops the later ones.
 */
function jsfSignedSignature(form, entries, wrapper, index) {
  if (form === "single") {
    return withoutValue(entries[index]);
  }
  const kept =
    form === "signers"
      ? [withoutValue(entries[index])]
      : [...entries.slice(0, index), withoutValue(entries[index])];
  return { ...wrapper, [form]: kept };
}

function candidateSignatures(parsed, index) {
  const signatures = [
    jsfSignedSignature(parsed.form, parsed.entries, parsed.wrapper, index),
  ];
  // Appending a signers or chain entry to a single signature moves that
  // signature into the new array. It was signed in the single signature form,
  // which asserts the same thing as a signers entry at any position, and as a
  // chain entry at position 0, where nothing precedes it.
  if (
    (parsed.form === "signers" || (parsed.form === "chain" && index === 0)) &&
    !Object.keys(parsed.wrapper).length
  ) {
    signatures.push(jsfSignedSignature("single", parsed.entries, {}, index));
  }
  return signatures;
}

/**
 * Parses a node's signature and returns a function that builds the signed bytes
 * of an entry. The node content is canonicalized once, on first use.
 *
 * @param {Object} node - A signed BOM, component, service, or annotation
 * @returns {{ parsed: Object, signedData: function(number): Buffer[] }}
 */
function prepareSignedNode(node) {
  const parsed = readSignatureEntries(node.signature);
  const { signature: _signature, ...content } = node;
  let serialize;
  return {
    parsed,
    signedData(index) {
      serialize ??= signedViewSerializer(content);
      return candidateSignatures(parsed, index).map(serialize);
    },
  };
}

function decodeSignatureValue(value) {
  if (typeof value !== "string" || !value.length) {
    throw new Error("The signature value is missing.");
  }
  const signature = Buffer.from(value, "base64url");
  if (signature.toString("base64url") !== value) {
    throw new Error("The signature value is not canonical base64url.");
  }
  return signature;
}

/**
 * Checks one signature entry with one key. `signedData` returns the bytes the
 * entry may cover; it is only called once the entry and key are compatible.
 */
function verifyEntry(entry, key, signedData) {
  const spec = getAlgorithm(entry.algorithm);
  const signature = decodeSignatureValue(entry.value);
  if (Object.hasOwn(entry, "excludes")) {
    throw new Error("Signatures that use JSF excludes are not supported.");
  }
  assertKeyMatchesAlgorithm(key, entry.algorithm, spec);
  if (entry.publicKey !== undefined) {
    if (key.type === "secret") {
      throw new Error("HMAC signatures must not embed a public key.");
    }
    if (!isSameKey(publicKeyFromJwk(entry.publicKey), key)) {
      throw new Error(
        "The embedded publicKey does not match the verification key.",
      );
    }
  }
  return signedData().some((data) =>
    signatureMatches(data, key, spec, signature),
  );
}

function mismatchReason(entry) {
  return `The ${displayValue(entry.algorithm)} signature does not verify with this key: the signed content changed, or a different key made it.`;
}

/**
 * Checks every entry of a node's signature against the trusted keys.
 *
 * @param {Object} node - The signed object
 * @param {crypto.KeyObject[]} keys - Loaded verification keys
 * @param {Object} [options]
 * @param {boolean} [options.requireAll] - The node verifies only when every entry does
 * @param {boolean} [options.requireEveryKey] - With requireAll, every key must also verify at least one entry
 * @param {boolean} [options.firstMatch] - Stop at the first entry that verifies
 * @returns {{ form: string|undefined, verified: boolean, match: Object|null, reasons: string[], entries: Object[], keysMatched: boolean[] }}
 *   `reasons` explains a signature that could not be read; each entry carries its own reasons.
 *   `keysMatched[i]` tells whether `keys[i]` verified at least one entry.
 */
function checkNode(node, keys, options = {}) {
  const result = {
    form: undefined,
    verified: false,
    match: null,
    reasons: [],
    entries: [],
    keysMatched: keys.map(() => false),
  };
  let prepared;
  try {
    prepared = prepareSignedNode(node);
  } catch (err) {
    result.reasons.push(err.message);
    return result;
  }
  const { parsed } = prepared;
  result.form = parsed.form;
  for (const [index, entry] of parsed.entries.entries()) {
    const reasons = [];
    let verified = false;
    // The signed bytes of one entry are built at most once and released before
    // the next entry, so memory stays proportional to the node size.
    let data;
    const signedData = () => {
      data ??= prepared.signedData(index);
      return data;
    };
    for (const [keyIndex, key] of keys.entries()) {
      try {
        if (verifyEntry(entry, key, signedData)) {
          verified = true;
          result.keysMatched[keyIndex] = true;
          if (!options.requireAll) {
            break;
          }
          continue;
        }
        reasons.push(mismatchReason(entry));
      } catch (err) {
        reasons.push(err.message);
      }
    }
    result.entries.push({
      index,
      algorithm: entry.algorithm,
      keyId: entry.keyId,
      verified,
      reasons: verified ? [] : [...new Set(reasons)],
    });
    if (verified && !result.match) {
      result.match = entry;
      if (options.firstMatch) {
        break;
      }
    }
  }
  result.verified = options.requireAll
    ? result.entries.length === parsed.entries.length &&
      result.entries.every((entry) => entry.verified) &&
      (!options.requireEveryKey || result.keysMatched.every(Boolean))
    : Boolean(result.match);
  return result;
}

function entryReasons(result) {
  if (result.reasons.length) {
    return result.reasons;
  }
  return result.entries.flatMap((entry) =>
    entry.reasons.map((reason) =>
      result.form === "single"
        ? reason
        : `${result.form}[${entry.index}]: ${reason}`,
    ),
  );
}

function nestedLabel(field, index, item) {
  let name = index;
  if (isPlainObject(item)) {
    name =
      item["bom-ref"] ||
      item.name ||
      (Array.isArray(item.subjects) && item.subjects.length
        ? item.subjects
        : index);
  }
  return `${field}[${index}] '${displayValue(name)}'`;
}

function signatureLayout(target, mode) {
  const existing = target.signature;
  if (mode === "replace" || existing === undefined) {
    return {
      form: mode === "replace" ? "single" : mode,
      entries: [],
      wrapper: {},
    };
  }
  const parsed = readSignatureEntries(existing);
  if (parsed.form !== "single" && parsed.form !== mode) {
    throw new Error("Cannot mix signature chains and multi-signers.");
  }
  if (parsed.entries.length >= MAX_SIGNATURE_ENTRIES) {
    throw new Error(
      `Cannot append another ${mode} entry: a signature holds at most ${MAX_SIGNATURE_ENTRIES} entries.`,
    );
  }
  return parsed.form === "single"
    ? { form: mode, entries: parsed.entries, wrapper: {} }
    : parsed;
}

function addSignature(target, key, spec, template, layout) {
  const { signature: _existing, ...content } = target;
  const entry = structuredClone(template);
  const entries = [...layout.entries, entry];
  const index = entries.length - 1;
  const signedData = signedViewSerializer(content)(
    jsfSignedSignature(layout.form, entries, layout.wrapper, index),
  );
  entry.value = computeSignature(signedData, key, spec).toString("base64url");
  target.signature =
    layout.form === "single"
      ? entry
      : { ...layout.wrapper, [layout.form]: entries };
}

function signatureTemplate(algorithm, publicKey, keyId) {
  const template = { algorithm };
  if (publicKey) {
    template.publicKey = publicKey;
  }
  if (keyId !== null && keyId !== undefined && keyId !== "") {
    template.keyId = String(keyId);
  }
  return template;
}

/**
 * Applies JSF signatures to the BOM and, optionally, its components, services,
 * and annotations.
 *
 * Nested elements are signed by default. When a `signers` or `chain` signature
 * is appended to a BOM that already has a root signature, nested elements are
 * skipped by default, because changing them would invalidate the existing root
 * signature; explicitly requesting nested signing in that case is an error.
 *
 * The BOM root must carry `bomFormat` (or `specFormat`) and `specVersion`, and
 * only members that CycloneDX defines at the root. A nested element that
 * carries `bomFormat`, `specFormat`, or `specVersion` is refused. Verification
 * rejects signatures over either shape.
 *
 * @param {Object} bomJson - CycloneDX BOM Object
 * @param {Object} options - Signing options
 * @param {string|Buffer|Object|crypto.KeyObject} options.privateKey - Private key (PEM or KeyObject), or the shared secret for HS* algorithms
 * @param {string} [options.algorithm] - JSF algorithm identifier (default RS512). It must match the key type.
 * @param {Object} [options.publicKeyJwk] - JWK of the signing key's public key to embed
 * @param {boolean} [options.embedPublicKey] - Embed the public key derived from the signing key when publicKeyJwk is not given. Ignored for HS* algorithms and for keys without a JWK form, such as rsa-pss.
 * @param {boolean} [options.embedPublicKeyNested] - Also embed the public key in nested signatures (default true)
 * @param {string} [options.keyId] - Key ID to embed
 * @param {string} [options.mode] - 'replace' (default), 'signers', or 'chain'
 * @param {boolean} [options.signComponents] - Sign each component
 * @param {boolean} [options.signServices] - Sign each service
 * @param {boolean} [options.signAnnotations] - Sign each annotation
 * @returns {Object} - Signed BOM Object
 */
export function signBom(bomJson, options = {}) {
  const {
    privateKey,
    algorithm = "RS512",
    publicKeyJwk = null,
    embedPublicKeyNested = true,
    keyId = null,
    mode = "replace",
  } = options;

  if (!privateKey) {
    throw new Error("privateKey is required for signing");
  }
  if (!SIGNATURE_MODES.includes(mode)) {
    throw new Error(
      `Unsupported signature mode: ${mode}. Use one of ${SIGNATURE_MODES.join(", ")}.`,
    );
  }
  if (!isPlainObject(bomJson)) {
    throw new Error("The BOM must be a JSON object.");
  }
  if (!hasBomIdentity(bomJson)) {
    throw new Error(
      'Only a CycloneDX BOM can be signed: its root needs bomFormat (or specFormat) "CycloneDX" and a specVersion.',
    );
  }
  const unexpected = unexpectedRootMembers(bomJson);
  if (unexpected.length) {
    throw new Error(
      `The BOM has members that CycloneDX does not define at the root of a BOM: ${listMembers(unexpected)}. Remove them before signing.`,
    );
  }
  const spec = getAlgorithm(algorithm);
  const signingKey = loadSigningKey(privateKey, algorithm, spec);
  let publicKey = embeddablePublicKey(publicKeyJwk, signingKey, algorithm);
  if (!publicKey && options.embedPublicKey && signingKey.type !== "secret") {
    try {
      publicKey = crypto.createPublicKey(signingKey).export({ format: "jwk" });
    } catch {
      // Some key types, such as rsa-pss, have no JWK form and are not embedded.
      publicKey = undefined;
    }
  }
  const rootTemplate = signatureTemplate(algorithm, publicKey, keyId);
  const nestedTemplate = signatureTemplate(
    algorithm,
    embedPublicKeyNested ? publicKey : undefined,
    keyId,
  );

  const appending = mode !== "replace" && bomJson.signature !== undefined;
  const requested = {
    components: options.signComponents,
    services: options.signServices,
    annotations: options.signAnnotations,
  };
  // Work out every signature layout before signing anything, so a rejected
  // request leaves the BOM untouched.
  const plan = [];
  for (const field of NESTED_TARGETS) {
    const items = Array.isArray(bomJson[field]) ? bomJson[field] : [];
    const enabled =
      requested[field] === undefined ? !appending : Boolean(requested[field]);
    if (!enabled || !items.length) {
      continue;
    }
    if (appending) {
      throw new Error(
        `Cannot sign ${field} while appending a ${mode} signature, because that changes content covered by the existing root signature. Sign the root only (for example, --no-sign-${field}).`,
      );
    }
    for (const [index, item] of items.entries()) {
      if (!isPlainObject(item)) {
        continue;
      }
      const identity = bomIdentityMembers(item);
      if (identity.length) {
        throw new Error(
          `Cannot sign ${nestedLabel(field, index, item)}: it carries ${identity.join(", ")}, which only the root of a BOM may hold.`,
        );
      }
      plan.push([item, signatureLayout(item, mode)]);
    }
  }
  const rootLayout = signatureLayout(bomJson, mode);
  for (const [item, layout] of plan) {
    addSignature(item, signingKey, spec, nestedTemplate, layout);
  }
  addSignature(bomJson, signingKey, spec, rootTemplate, rootLayout);
  return bomJson;
}

/**
 * Verifies the signature of a single node (e.g., BOM root, Component, Service,
 * Annotation). Handles single signatures, multi-signatures (signers), and
 * signature chains, and returns the first signature object that matches the key.
 *
 * A signature only matches when its declared algorithm fits the key type, its
 * embedded publicKey (if any) is the verification key, and its value covers the
 * node content plus the signature metadata as JSF defines.
 *
 * This checks one object only. To verify a BOM, use {@link verifyBomSignatures}
 * or {@link verifyBom}, which also require the signed root to be a BOM.
 *
 * @param {Object} node - The BOM or granular object to verify
 * @param {string|Buffer|Object|crypto.KeyObject} publicKey - Verification key. Strings and Buffers are parsed as public keys; use loadSharedSecret() for HMAC.
 * @param {Object} [options]
 * @param {string[]} [options.reasons] - When no signature matches, receives the reason each entry was rejected
 * @returns {boolean|Object} - Matching signature object if valid. False otherwise.
 */
export function verifyNode(node, publicKey, options = {}) {
  if (!isPlainObject(node) || node.signature === undefined) {
    return false;
  }
  const key = loadVerificationKey(publicKey);
  const result = checkNode(node, [key], { firstMatch: true });
  if (result.match) {
    return result.match;
  }
  if (Array.isArray(options.reasons)) {
    options.reasons.push(...entryReasons(result));
  }
  return false;
}

/**
 * Verifies the signatures of a BOM against one or more trusted keys and reports
 * the outcome for every signature entry.
 *
 * The BOM verifies when:
 * - its root carries `bomFormat` (or `specFormat`) "CycloneDX" and
 *   `specVersion`, and only members that CycloneDX defines at the root of a BOM;
 * - its root signature verifies, meaning at least one entry verifies with one
 *   of the keys. With `requireAll`, every entry must verify with one of the
 *   keys, and every key must verify at least one entry;
 * - with `deep`, every signed component, service, and annotation verifies the
 *   same way and carries none of `bomFormat`, `specFormat`, and `specVersion`.
 *
 * A BOM without a root signature fails unless `allowNestedOnly` is set. Then
 * every component, service, and annotation must carry a signature that
 * verifies, and `notices` lists the members that no signature covers.
 *
 * Parse untrusted BOM text with `parseStrictJson()` from
 * `lib/parsers/strictJson.js` before calling this function, so that the
 * verified values are the values every JSON parser reads.
 *
 * @param {Object} bom - CycloneDX BOM Object
 * @param {Array<string|Buffer|Object|crypto.KeyObject>|string|Buffer|Object|crypto.KeyObject} keys - Trusted verification keys (see verifyNode)
 * @param {Object} [options]
 * @param {boolean} [options.deep] - Also verify nested signatures (default true)
 * @param {boolean} [options.allowNestedOnly] - Accept a BOM without a root signature when every nested element is signed
 * @param {boolean} [options.requireAll] - Require every entry of each signature to verify, and every key to verify an entry of the root signature
 * @returns {{ verified: boolean, errors: string[], notices: string[], root: Object|null, nested: Object[] }}
 *   `root` and each `nested` item hold `label`, `form`, `verified`, `match` (the first verified entry),
 *   `reasons` (why the signature could not be read), `entries` (`index`, `algorithm`, `keyId`, `verified`, `reasons`),
 *   and `keysMatched` (whether each key verified an entry).
 */
export function verifyBomSignatures(bom, keys, options = {}) {
  const deep = options.deep !== false;
  const allowNestedOnly = Boolean(options.allowNestedOnly);
  const requireAll = Boolean(options.requireAll);
  const trustedKeys = (Array.isArray(keys) ? keys : [keys]).map((key) =>
    loadVerificationKey(key),
  );
  if (!trustedKeys.length) {
    throw new Error("At least one verification key is required.");
  }
  const report = {
    verified: false,
    errors: [],
    notices: [],
    root: null,
    nested: [],
  };
  if (!isPlainObject(bom)) {
    report.errors.push("The BOM must be a JSON object.");
    return report;
  }
  if (!hasBomIdentity(bom)) {
    report.errors.push(
      'The signed object is not a CycloneDX BOM: its root needs bomFormat (or specFormat) "CycloneDX" and a specVersion.',
    );
  }
  const unexpected = unexpectedRootMembers(bom);
  if (unexpected.length) {
    report.errors.push(
      `The BOM has members that CycloneDX does not define at the root of a BOM: ${listMembers(unexpected)}.`,
    );
  }
  const nestedOnly = bom.signature === undefined;
  if (!nestedOnly) {
    report.root = {
      label: "BOM",
      ...checkNode(bom, trustedKeys, { requireAll, requireEveryKey: true }),
    };
    const unmatched = report.root.keysMatched.flatMap((matched, index) =>
      matched ? [] : [`#${index + 1}`],
    );
    if (requireAll && report.root.form && unmatched.length) {
      report.errors.push(
        `No entry of the root signature verifies with key ${unmatched.join(", ")}, so a signature expected from that key is missing.`,
      );
    }
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
    let signedCount = 0;
    for (const field of NESTED_TARGETS) {
      const items = bom[field];
      if (items === undefined) {
        continue;
      }
      if (!Array.isArray(items)) {
        if (nestedOnly) {
          report.errors.push(`${field} is not an array of signed objects.`);
        }
        continue;
      }
      const unsigned = [];
      for (const [index, item] of items.entries()) {
        const label = nestedLabel(field, index, item);
        if (!isPlainObject(item) || item.signature === undefined) {
          unsigned.push(label);
          continue;
        }
        signedCount++;
        const identity = bomIdentityMembers(item);
        if (identity.length) {
          report.errors.push(
            `${label} carries ${identity.join(", ")}, which only the root of a BOM may hold.`,
          );
        }
        report.nested.push({
          label,
          ...checkNode(item, trustedKeys, { requireAll }),
        });
      }
      if (nestedOnly && unsigned.length) {
        report.errors.push(
          `${unsigned.length} of ${items.length} ${field} are not signed, starting with ${unsigned[0]}.`,
        );
      }
    }
    if (nestedOnly && allowNestedOnly) {
      if (!signedCount) {
        report.errors.push("The BOM has no signatures.");
      }
      const uncovered = Object.keys(bom).filter(
        (name) => !NESTED_TARGETS.includes(name),
      );
      report.notices.push(
        uncovered.length
          ? `Without a root signature, no signature covers ${listMembers(uncovered)}, or which components, services, and annotations the BOM lists and in what order.`
          : "Without a root signature, no signature covers which components, services, and annotations the BOM lists or in what order.",
      );
    }
  }
  report.verified =
    !report.errors.length &&
    (report.root ? report.root.verified : allowNestedOnly && deep) &&
    report.nested.every((item) => item.verified);
  return report;
}

/**
 * Flattens a {@link verifyBomSignatures} report into the reasons it did not
 * verify: policy errors first, then each rejected root entry, then each
 * rejected nested entry prefixed with the element it belongs to.
 *
 * @param {Object} report - Result of verifyBomSignatures
 * @returns {string[]} - Reasons, empty when the report verified
 */
export function signatureReportReasons(report) {
  const reasons = [...report.errors];
  if (report.root && !report.root.verified) {
    reasons.push(...entryReasons(report.root));
  }
  for (const item of report.nested) {
    if (!item.verified) {
      reasons.push(
        ...entryReasons(item).map((reason) => `${item.label}: ${reason}`),
      );
    }
  }
  return reasons;
}

/**
 * Verifies a BOM's top-level signature, as well as nested components, services,
 * and annotations, with one key. Returns the root match only if the BOM verifies
 * as {@link verifyBomSignatures} defines with `deep` enabled.
 *
 * @param {Object} bom - CycloneDX BOM Object
 * @param {string|Buffer|Object|crypto.KeyObject} publicKey - Verification key (see verifyNode)
 * @param {Object} [options] - Same options as verifyNode
 * @returns {boolean|Object} - Signature object if valid. False otherwise.
 */
export function verifyBom(bom, publicKey, options = {}) {
  if (!isPlainObject(bom) || !bom.signature) {
    return false;
  }
  const report = verifyBomSignatures(bom, [publicKey]);
  if (report.verified) {
    return report.root.match;
  }
  if (Array.isArray(options.reasons)) {
    options.reasons.push(...signatureReportReasons(report));
  }
  return false;
}

/**
 * Checks every signature entry of a node against a set of trusted keys. An
 * entry is verified when one of the keys verifies that entry.
 *
 * `cdx-sign` uses this before appending a `signers` or `chain` entry, to check
 * that the content still carries the earlier signatures.
 *
 * @param {Object} node - The BOM or granular object whose signature is checked
 * @param {Array<string|Buffer|Object|crypto.KeyObject>} [keys] - Trusted verification keys (see verifyNode)
 * @returns {Array<{ index: number, algorithm: any, keyId: any, verified: boolean, reasons: string[] }>} - One result per signature entry; empty for an unsigned node
 */
export function checkSignatureEntries(node, keys = []) {
  if (!isPlainObject(node) || node.signature === undefined) {
    return [];
  }
  const trustedKeys = keys.map((key) => loadVerificationKey(key));
  const result = checkNode(node, trustedKeys);
  if (result.reasons.length) {
    return [
      {
        index: 0,
        algorithm: undefined,
        keyId: undefined,
        verified: false,
        reasons: result.reasons,
      },
    ];
  }
  return result.entries;
}
