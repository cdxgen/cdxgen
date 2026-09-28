import crypto from "node:crypto";

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
  ["ES256", { keyType: "ec", hash: "sha256", curve: "prime256v1" }],
  ["ES384", { keyType: "ec", hash: "sha384", curve: "secp384r1" }],
  ["ES512", { keyType: "ec", hash: "sha512", curve: "secp521r1" }],
  ["Ed25519", { keyType: "ed25519", hash: null }],
  ["Ed448", { keyType: "ed448", hash: null }],
  ["HS256", { keyType: "secret", hash: "sha256" }],
  ["HS384", { keyType: "secret", hash: "sha384" }],
  ["HS512", { keyType: "secret", hash: "sha512" }],
]);

const SIGNATURE_MODES = ["replace", "signers", "chain"];

const NESTED_TARGETS = ["components", "services", "annotations"];

// DER layouts tried when checking whether raw bytes are really a key.
const DER_KEY_LAYOUTS = [
  [crypto.createPublicKey, "spki"],
  [crypto.createPublicKey, "pkcs1"],
  [crypto.createPrivateKey, "pkcs8"],
  [crypto.createPrivateKey, "pkcs1"],
  [crypto.createPrivateKey, "sec1"],
];

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
function canonicalize(value) {
  if (typeof value?.toJSON === "function") {
    value = value.toJSON();
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item) ?? "null").join(",")}]`;
  }
  const members = [];
  for (const key of Object.keys(value).sort()) {
    const member = canonicalize(value[key]);
    if (member !== undefined) {
      members.push(`${JSON.stringify(key)}:${member}`);
    }
  }
  return `{${members.join(",")}}`;
}

function getAlgorithm(alg) {
  const spec = typeof alg === "string" ? JSF_ALGORITHMS.get(alg) : undefined;
  if (!spec) {
    const name =
      typeof alg === "string" ? alg : `<${alg === null ? "null" : typeof alg}>`;
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

function computeSignature(canonicalData, key, spec) {
  const data = Buffer.from(canonicalData, "utf8");
  if (spec.keyType === "secret") {
    return crypto.createHmac(spec.hash, key).update(data).digest();
  }
  return crypto.sign(spec.hash, data, signatureOptions(key, spec));
}

function signatureMatches(canonicalData, key, spec, signature) {
  const data = Buffer.from(canonicalData, "utf8");
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
  if (
    !Array.isArray(entries) ||
    !entries.length ||
    !entries.every(isPlainObject)
  ) {
    throw new Error(`The ${form} array must contain signature objects.`);
  }
  return { form, entries, wrapper };
}

function withoutValue(entry) {
  const { value: _value, ...rest } = entry;
  return rest;
}

/**
 * Builds the object whose canonical form is signed for entry `index`.
 *
 * Following JSF, only the `value` of the entry being processed is removed.
 * Other `signers` are removed entirely, while a `chain` entry keeps every
 * earlier entry (including its value) and drops the later ones.
 */
function jsfSignedView(content, form, entries, wrapper, index) {
  if (form === "single") {
    return { ...content, signature: withoutValue(entries[index]) };
  }
  const kept =
    form === "signers"
      ? [withoutValue(entries[index])]
      : [...entries.slice(0, index), withoutValue(entries[index])];
  return { ...content, signature: { ...wrapper, [form]: kept } };
}

function candidateViews(content, parsed, index) {
  const views = [
    jsfSignedView(content, parsed.form, parsed.entries, parsed.wrapper, index),
  ];
  // Appending a signers or chain entry to a single signature moves that
  // signature into position 0 of the new array. It was signed in the single
  // signature form, which is equivalent there because nothing precedes it.
  if (
    parsed.form !== "single" &&
    index === 0 &&
    !Object.keys(parsed.wrapper).length
  ) {
    views.push(jsfSignedView(content, "single", parsed.entries, {}, 0));
  }
  return views;
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

function verifyEntry(content, parsed, index, key) {
  const entry = parsed.entries[index];
  const spec = getAlgorithm(entry.algorithm);
  const signature = decodeSignatureValue(entry.value);
  if (
    Object.hasOwn(entry, "excludes") ||
    Object.hasOwn(parsed.wrapper, "excludes")
  ) {
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
  return candidateViews(content, parsed, index).some((view) =>
    signatureMatches(canonicalize(view), key, spec, signature),
  );
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
  if (parsed.form === "single") {
    return { form: mode, entries: parsed.entries, wrapper: {} };
  }
  if (parsed.form !== mode) {
    throw new Error("Cannot mix signature chains and multi-signers.");
  }
  return parsed;
}

function addSignature(target, key, spec, template, layout) {
  const { signature: _existing, ...content } = target;
  const entry = structuredClone(template);
  const entries = [...layout.entries, entry];
  const index = entries.length - 1;
  const view = jsfSignedView(
    content,
    layout.form,
    entries,
    layout.wrapper,
    index,
  );
  entry.value = computeSignature(canonicalize(view), key, spec).toString(
    "base64url",
  );
  target.signature =
    layout.form === "single"
      ? entry
      : { ...layout.wrapper, [layout.form]: entries };
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
 * @param {Object} bomJson - CycloneDX BOM Object
 * @param {Object} options - Signing options
 * @param {string|Buffer|Object|crypto.KeyObject} options.privateKey - Private key (PEM or KeyObject), or the shared secret for HS* algorithms
 * @param {string} [options.algorithm] - JSF algorithm identifier (default RS512). It must match the key type.
 * @param {Object} [options.publicKeyJwk] - JWK of the signing key's public key to embed
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
  const spec = getAlgorithm(algorithm);
  const signingKey = loadSigningKey(privateKey, algorithm, spec);
  const template = { algorithm };
  const publicKey = embeddablePublicKey(publicKeyJwk, signingKey, algorithm);
  if (publicKey) {
    template.publicKey = publicKey;
  }
  if (keyId !== null && keyId !== undefined && keyId !== "") {
    template.keyId = String(keyId);
  }

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
    for (const item of items) {
      if (isPlainObject(item)) {
        plan.push([item, signatureLayout(item, mode)]);
      }
    }
  }
  const rootLayout = signatureLayout(bomJson, mode);
  for (const [item, layout] of plan) {
    addSignature(item, signingKey, spec, template, layout);
  }
  addSignature(bomJson, signingKey, spec, template, rootLayout);
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
 * @param {Object} node - The BOM or granular object to verify
 * @param {string|Buffer|Object|crypto.KeyObject} publicKey - Verification key. Strings and Buffers are parsed as public keys; use loadSharedSecret() for HMAC.
 * @param {Object} [options]
 * @param {string[]} [options.reasons] - Receives a description of every signature that did not match
 * @returns {boolean|Object} - Matching signature object if valid. False otherwise.
 */
export function verifyNode(node, publicKey, options = {}) {
  if (!isPlainObject(node) || node.signature === undefined) {
    return false;
  }
  const key = loadVerificationKey(publicKey);
  const reasons = Array.isArray(options.reasons) ? options.reasons : undefined;
  let parsed;
  try {
    parsed = readSignatureEntries(node.signature);
  } catch (err) {
    reasons?.push(err.message);
    return false;
  }
  const { signature: _signature, ...content } = node;
  for (let index = 0; index < parsed.entries.length; index++) {
    const label = parsed.form === "single" ? "" : `${parsed.form}[${index}]: `;
    try {
      if (verifyEntry(content, parsed, index, key)) {
        return parsed.entries[index];
      }
      reasons?.push(
        `${label}The ${parsed.entries[index].algorithm} signature value does not match the signed content.`,
      );
    } catch (err) {
      reasons?.push(`${label}${err.message}`);
    }
  }
  return false;
}

/**
 * Verifies a BOM's top-level signature, as well as nested components, services,
 * and annotations. Returns the root match only if the root signature is valid
 * AND every signed nested element is valid for the same key.
 *
 * @param {Object} bom - CycloneDX BOM Object
 * @param {string|Buffer|Object|crypto.KeyObject} publicKey - Verification key (see verifyNode)
 * @param {Object} [options] - Same options as verifyNode
 * @returns {boolean|Object} - Signature object if valid. False otherwise.
 */
export function verifyBom(bom, publicKey, options = {}) {
  if (!bom?.signature) {
    return false;
  }
  const key = loadVerificationKey(publicKey);
  const rootMatch = verifyNode(bom, key, options);
  if (!rootMatch) {
    return false;
  }
  for (const field of NESTED_TARGETS) {
    if (!Array.isArray(bom[field])) {
      continue;
    }
    for (const item of bom[field]) {
      if (item?.signature && !verifyNode(item, key, options)) {
        return false;
      }
    }
  }
  return rootMatch;
}
