import crypto from "node:crypto";
/**
 * Largest number of entries accepted in a `signers` or `chain` signature.
 * Every entry is checked against the whole signed object, so the bound keeps
 * the cost of verifying a document proportional to its size.
 */
export declare const MAX_SIGNATURE_ENTRIES = 32;
/**
 * Members the CycloneDX 1.4 to 1.7 schemas define at the root of a BOM, plus
 * `specFormat`, which an early 2.0 draft used in place of `bomFormat`. A JSF
 * root signature is only accepted on an object made of these members, so a
 * signed component, service, or annotation cannot pass as a signed BOM.
 */
export declare const BOM_ROOT_MEMBERS: readonly string[];
/**
 * Members the CycloneDX 2.0 draft schema defines at the root of a document.
 * A JSS root signature (lib/helpers/jssSigner.js) is only accepted on an
 * object made of these members.
 */
export declare const BOM_20_ROOT_MEMBERS: readonly string[];
/**
 * Renders a value taken from a document for a message. JSON can make any field
 * an object or array, and interpolating those directly can throw. Control and
 * line-break characters in the value are written as `\u` escapes, so printing
 * the message cannot rewrite the terminal line or start a new one.
 *
 * @param {any} value - Value to render
 * @returns {string} - Printable text
 */
export declare function displayValue(value: any): string;
/**
 * Deterministic JSON canonicalizer following RFC 8785 (JCS), which JSF uses to
 * produce the signed data. Values are serialized the way JSON.stringify would
 * see them, so an in-memory object and its parsed JSON form canonicalize
 * identically.
 *
 * @param {any} value - The JSON object/value to canonicalize
 * @returns {string|undefined} - Canonicalized JSON string, or undefined for values JSON omits
 */
export declare function canonicalizeJson(value: any): string | undefined;
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
export declare function signBom(bomJson: Object, options?: {
    privateKey: string | Buffer | Object | crypto.KeyObject;
    algorithm?: string;
    publicKeyJwk?: Object;
    embedPublicKey?: boolean;
    embedPublicKeyNested?: boolean;
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
 * This checks one object only. To verify a BOM, use {@link verifyBomSignatures}
 * or {@link verifyBom}, which also require the signed root to be a BOM.
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
export declare function verifyBomSignatures(bom: Object, keys: Array<string | Buffer | Object | crypto.KeyObject> | string | Buffer | Object | crypto.KeyObject, options?: {
    deep?: boolean;
    allowNestedOnly?: boolean;
    requireAll?: boolean;
}): {
    verified: boolean;
    errors: string[];
    notices: string[];
    root: Object | null;
    nested: Object[];
};
/**
 * Flattens a {@link verifyBomSignatures} report into the reasons it did not
 * verify: policy errors first, then each rejected root entry, then each
 * rejected nested entry prefixed with the element it belongs to.
 *
 * @param {Object} report - Result of verifyBomSignatures
 * @returns {string[]} - Reasons, empty when the report verified
 */
export declare function signatureReportReasons(report: Object): string[];
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
export declare function verifyBom(bom: Object, publicKey: string | Buffer | Object | crypto.KeyObject, options?: Object): boolean | Object;
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
export declare function checkSignatureEntries(node: Object, keys?: Array<string | Buffer | Object | crypto.KeyObject>): Array<{
    index: number;
    algorithm: any;
    keyId: any;
    verified: boolean;
    reasons: string[];
}>;
//# sourceMappingURL=bomSigner.d.ts.map