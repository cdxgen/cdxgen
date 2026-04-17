import crypto from "node:crypto";

/**
 * Lightweight, deterministic JSON Canonicalizer (similar to RFC 8785).
 * Required by JSF to ensure the signature payload remains identical across systems.
 *
 * @param {any} value - The JSON object/value to canonicalize
 * @returns {string} - Canonicalized JSON string
 */
function canonicalize(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  let str = "{";
  for (let i = 0; i < keys.length; i++) {
    if (i > 0) str += ",";
    str += `${JSON.stringify(keys[i])}:${canonicalize(value[keys[i]])}`;
  }
  str += "}";
  return str;
}

/**
 * Creates a JSF-compliant signature block.
 *
 * @param {Object} payload - The object to sign (e.g., BOM, component)
 * @param {string|Buffer|crypto.KeyObject} privateKey - The signing key
 * @param {string} alg - JSF algorithm identifier
 * @param {Object} [publicKeyJwk] - Optional JWK representation of the public key
 * @param {string} keyId - Key ID
 *
 * @returns {Object} - JSF signature block
 */
function createSignatureBlock(
  payload,
  privateKey,
  alg,
  publicKeyJwk = null,
  keyId = null,
) {
  // Exclude existing signatures from the canonicalized payload as per JSF
  const { signature, ...dataToSign } = payload;
  const canonicalData = canonicalize(dataToSign);

  let hashAlg;
  const signOptions = { key: privateKey };

  // Handle HMAC (Symmetric)
  if (alg.startsWith("HS")) {
    const hash = alg.replace("HS", "sha");
    const value = crypto
      .createHmac(hash, privateKey)
      .update(canonicalData, "utf8")
      .digest("base64url");
    const block = { algorithm: alg, value };
    if (publicKeyJwk) {
      block.publicKey = publicKeyJwk;
    }
    if (keyId) {
      block.keyId = keyId;
    }
    return block;
  }

  // Handle Asymmetric Algorithms
  if (alg.startsWith("RS")) {
    hashAlg = alg.replace("RS", "SHA");
  } else if (alg.startsWith("PS")) {
    hashAlg = alg.replace("PS", "SHA");
    signOptions.padding = crypto.constants.RSA_PKCS1_PSS_PADDING;
    signOptions.saltLength = crypto.constants.RSA_PSS_SALTLEN_AUTO;
  } else if (alg.startsWith("ES")) {
    hashAlg = alg.replace("ES", "SHA");
    // Standard JWA format requires IEEE P1363 (R || S) instead of ASN.1 DER
    signOptions.dsaEncoding = "ieee-p1363";
  } else if (alg === "Ed25519" || alg === "Ed448") {
    // Native EdDSA algorithms do not require a separate hash algorithm definition
    hashAlg = null;
  } else {
    throw new Error(`Unsupported JSF algorithm: ${alg}`);
  }
  const sigBuffer = crypto.sign(
    hashAlg,
    Buffer.from(canonicalData, "utf8"),
    signOptions,
  );
  const block = { algorithm: alg, value: sigBuffer.toString("base64url") };
  if (publicKeyJwk) {
    block.publicKey = publicKeyJwk;
  }
  if (keyId) {
    block.keyId = keyId;
  }
  return block;
}

/**
 * Appends or replaces a signature on a target object based on the configured mode.
 */
function addSignature(target, sigBlock, mode) {
  if (!target.signature) {
    target.signature = sigBlock;
    return;
  }
  if (mode === "chain") {
    if (target.signature.chain) {
      target.signature.chain.push(sigBlock);
    } else if (target.signature.signers) {
      throw new Error("Cannot mix signature chains and multi-signers.");
    } else {
      target.signature = { chain: [target.signature, sigBlock] };
    }
  } else if (mode === "signers") {
    if (target.signature.signers) {
      target.signature.signers.push(sigBlock);
    } else if (target.signature.chain) {
      throw new Error("Cannot mix signature chains and multi-signers.");
    } else {
      target.signature = { signers: [target.signature, sigBlock] };
    }
  } else {
    target.signature = sigBlock;
  }
}

/**
 * Recursively applies signatures to the BOM and its granular components.
 *
 * @param {Object} bomJson - CycloneDX BOM Object
 * @param {Object} options - Signing options { privateKey, algorithm, mode, ... }
 * @returns {Object} - Signed BOM Object
 */
export function signBom(bomJson, options = {}) {
  const {
    privateKey,
    algorithm = "RS512",
    publicKeyJwk = null,
    keyId = null,
    mode = "replace", // Supports: 'replace', 'chain', 'signers'
    signComponents = true,
    signServices = true,
    signAnnotations = true,
  } = options;

  if (!privateKey) {
    throw new Error("privateKey is required for signing");
  }
  if (signComponents && Array.isArray(bomJson.components)) {
    for (const comp of bomJson.components) {
      addSignature(
        comp,
        createSignatureBlock(comp, privateKey, algorithm, publicKeyJwk, keyId),
        mode,
      );
    }
  }
  if (signServices && Array.isArray(bomJson.services)) {
    for (const svc of bomJson.services) {
      addSignature(
        svc,
        createSignatureBlock(svc, privateKey, algorithm, publicKeyJwk, keyId),
        mode,
      );
    }
  }
  if (signAnnotations && Array.isArray(bomJson.annotations)) {
    for (const ann of bomJson.annotations) {
      addSignature(
        ann,
        createSignatureBlock(ann, privateKey, algorithm, publicKeyJwk, keyId),
        mode,
      );
    }
  }
  addSignature(
    bomJson,
    createSignatureBlock(bomJson, privateKey, algorithm, publicKeyJwk, keyId),
    mode,
  );
  return bomJson;
}

/**
 * Validates a single JSF signature block against the payload.
 *
 * @param {Object} payload - The payload to verify
 * @param {string|crypto.KeyObject} publicKey - The public key corresponding to the signature
 * @param {Object} sigBlock Signature
 *
 * @returns {boolean|Object} - Signature block if signature is valid. False otherwise.
 */
function verifySignatureBlock(payload, publicKey, sigBlock) {
  const { signature, ...dataToVerify } = payload;
  const canonicalData = canonicalize(dataToVerify);

  const { algorithm: alg, value } = sigBlock;

  if (alg.startsWith("HS")) {
    const hash = alg.replace("HS", "sha");
    const expected = crypto
      .createHmac(hash, publicKey)
      .update(canonicalData, "utf8")
      .digest("base64url");
    const isValid = expected === value;
    return isValid ? sigBlock : false;
  }

  const verifyOptions = { key: publicKey };
  let hashAlg;

  if (alg.startsWith("RS")) {
    hashAlg = alg.replace("RS", "SHA");
  } else if (alg.startsWith("PS")) {
    hashAlg = alg.replace("PS", "SHA");
    verifyOptions.padding = crypto.constants.RSA_PKCS1_PSS_PADDING;
    verifyOptions.saltLength = crypto.constants.RSA_PSS_SALTLEN_AUTO;
  } else if (alg.startsWith("ES")) {
    hashAlg = alg.replace("ES", "SHA");
    verifyOptions.dsaEncoding = "ieee-p1363";
  } else if (alg === "Ed25519" || alg === "Ed448") {
    hashAlg = null;
  } else {
    console.warn(`${alg} is unknown.`);
    return false;
  }

  const isValid = crypto.verify(
    hashAlg,
    Buffer.from(canonicalData, "utf8"),
    verifyOptions,
    Buffer.from(value, "base64url"),
  );
  return isValid ? sigBlock : false;
}

/**
 * Verifies the integrity of a specific element node (e.g., BOM root, Component, Service, Annotation).
 * Resolves standard JSF signatures, multisignature (signers), and chains.
 *
 * @param {Object} node - The BOM or granular object to verify
 * @param {string|crypto.KeyObject} publicKey - The public key corresponding to the signature
 * @returns {boolean|Object} - Signature block if signature is valid. False otherwise.
 */
export function verifyNode(node, publicKey) {
  if (!node?.signature) {
    return false;
  }
  const sigTarget = node.signature;
  if (sigTarget.signers) {
    for (const sig of sigTarget.signers) {
      const match = verifySignatureBlock(node, publicKey, sig);
      if (match) {
        return match;
      }
    }
    return false;
  }
  if (sigTarget.chain) {
    for (const sig of sigTarget.chain) {
      const match = verifySignatureBlock(node, publicKey, sig);
      if (match) {
        return match;
      }
    }
    return false;
  }
  return verifySignatureBlock(node, publicKey, sigTarget);
}

/**
 * Verifies the integrity of a BOM's top-level signature, as well as nested components, services, and annotations.
 * Returns true only if the root signature is valid AND all signed nested elements are valid.
 *
 * @param {Object} bom - CycloneDX BOM Object
 * @param {string|crypto.KeyObject} publicKey - The public key corresponding to the signature
 * @returns {boolean|Object} - Signature block if signature is valid. False otherwise.
 */
export function verifyBom(bom, publicKey) {
  if (!bom?.signature) {
    return false;
  }
  const rootMatch = verifyNode(bom, publicKey);
  if (!rootMatch) {
    return false;
  }
  if (Array.isArray(bom.components)) {
    for (const comp of bom.components) {
      if (comp.signature && !verifyNode(comp, publicKey)) {
        return false;
      }
    }
  }
  if (Array.isArray(bom.services)) {
    for (const svc of bom.services) {
      if (svc.signature && !verifyNode(svc, publicKey)) {
        return false;
      }
    }
  }
  if (Array.isArray(bom.annotations)) {
    for (const ann of bom.annotations) {
      if (ann.signature && !verifyNode(ann, publicKey)) {
        return false;
      }
    }
  }
  return rootMatch;
}
