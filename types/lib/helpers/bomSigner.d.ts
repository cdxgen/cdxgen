import crypto from "node:crypto";
/**
 * Renders a value taken from a document for a message. JSON can make any field
 * an object or array, and interpolating those directly can throw.
 *
 * @param {any} value - Value to render
 * @returns {string} - Printable text
 */
export declare function displayValue(value: any): string;
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
export declare function loadSharedSecret(material: string | Buffer | crypto.KeyObject): crypto.KeyObject;
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
export declare function loadVerificationKey(key: string | Buffer | Object | crypto.KeyObject): crypto.KeyObject;
/**
 * Generates a PEM key pair suitable for the given JSF algorithm.
 *
 * @param {string} algorithm - JSF algorithm identifier
 * @returns {{ publicKey: string, privateKey: string }} - PEM encoded SPKI public key and PKCS#8 private key
 */
export declare function generateSigningKeyPair(algorithm: string): {
    publicKey: string;
    privateKey: string;
};
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
export declare function signBom(bomJson: Object, options?: {
    privateKey: string | Buffer | Object | crypto.KeyObject;
    algorithm?: string;
    publicKeyJwk?: Object;
    keyId?: string;
    mode?: string;
    signComponents?: boolean;
    signServices?: boolean;
    signAnnotations?: boolean;
}): Object;
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
 * @param {string[]} [options.reasons] - When no signature matches, receives the reason each entry was rejected
 * @returns {boolean|Object} - Matching signature object if valid. False otherwise.
 */
export declare function verifyNode(node: Object, publicKey: string | Buffer | Object | crypto.KeyObject, options?: {
    reasons?: string[];
}): boolean | Object;
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
export declare function verifyBom(bom: Object, publicKey: string | Buffer | Object | crypto.KeyObject, options?: Object): boolean | Object;
/**
 * Checks every signature entry of a node against a set of trusted keys. An
 * entry is verified when one of the keys verifies that entry.
 *
 * `cdx-sign` uses this before appending to a signature chain, because the new
 * chain entry vouches for every earlier entry.
 *
 * @param {Object} node - The BOM or granular object whose signature is checked
 * @param {Array<string|Buffer|Object|crypto.KeyObject>} [keys] - Trusted verification keys (see verifyNode)
 * @returns {Array<{ index: number, algorithm: any, keyId: any, verified: boolean, reasons: string[] }>} - One result per signature entry; empty for an unsigned node
 */
export declare function checkSignatureEntries(node: Object, keys?: Array<string | Buffer | Object | crypto.KeyObject>): Array<{
    index: number;
    algorithm: any;
    keyId: any;
    verified: boolean;
    reasons: string[];
}>;
//# sourceMappingURL=bomSigner.d.ts.map