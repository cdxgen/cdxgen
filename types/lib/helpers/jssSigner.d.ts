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
import { KeyObject } from "node:crypto";
/**
 * Quantum-safe algorithm names from X.590 Table 1 (clause 6.2.2) that
 * node:crypto cannot provide: every XMSS (IETF RFC 8391 section 5.3) and
 * LMS (IETF RFC 8554 section 5.1) value of the table.
 */
export declare const UNSUPPORTED_JSS_ALGORITHMS: readonly string[];
/**
 * The clause 6.2.1 `hash_algorithm` values accepted, by their IANA Named
 * Information Hash Algorithm Registry names, mapped to the node:crypto
 * digest. Anything else (md5, sha1, sha-224, unknown names) is refused when
 * signing and fails verification: clause 6.2.1 asks for a "current and
 * widely accepted hashing algorithm" defined in the IANA registry.
 */
export declare const JSS_HASH_ALGORITHMS: any;
/** JSS algorithm names this module signs and verifies. */
export declare const JSS_SIGNATURE_ALGORITHMS: readonly (string | string[] | null)[];
/**
 * Whether this runtime's crypto provides Ed448. Bun links BoringSSL, which
 * has no Ed448, so key generation and key loading fail there with an
 * OpenSSL error; this check turns that into a clear message.
 *
 * @returns {boolean} true when Ed448 keys can be created
 */
export declare function isEd448Available(): boolean;
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
export declare function assertJssKeyMatchesAlgorithm(algorithm: string, key: KeyObject): void;
/**
 * Picks the JSS algorithm for a key: ES256, ES384 or ES512 by curve, RS256
 * for rsa, PS256 for rsa-pss, Ed25519 or Ed448 for those key types.
 *
 * @param {KeyObject} key - Public or private key
 * @returns {string} JSS algorithm name
 * @throws {Error} For a key type no JSS algorithm here supports
 */
export declare function selectJssAlgorithmForKey(key: KeyObject): string;
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
export declare function signJss(document: object, { algorithm, privateKey, hashAlgorithm }?: {
    algorithm: string;
    privateKey: KeyObject | string | Buffer;
    hashAlgorithm?: string;
}): object;
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
export declare function countersignJss(document: object, { algorithm, privateKey, hashAlgorithm, index }?: {
    algorithm: string;
    privateKey: KeyObject | string | Buffer;
    hashAlgorithm?: string;
    index?: number;
}): object;
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
export declare function verifyJss(document: object, options?: {
    publicKey?: KeyObject | string | Buffer;
    publicKeys?: Array<KeyObject | string | Buffer>;
    allowEmbeddedKey?: boolean;
    requireAll?: boolean;
    requireEveryKey?: boolean;
}): {
    valid: boolean;
    trusted: boolean;
    reasons: string[];
    keysMatched: boolean[];
    results: Array<{
        index: number;
        depth: number;
        path: string;
        algorithm: any;
        hashAlgorithm: any;
        status: string;
        valid: boolean;
        trusted: boolean;
        claimsTrustedKey: boolean;
        keyIndex: (number | undefined);
        reason: (string | undefined);
    }>;
};
/**
 * Remove every JSS signature from a CycloneDX 2.0 BOM: the root and the
 * nested members {@link signJssBom} signs. Members are only touched where
 * they carry `signatures`. The input is not mutated.
 *
 * @param {object} bom20 - CycloneDX 2.0 document
 * @returns {{bom: object, removed: number}} The unsigned document and the number of signature entries removed
 */
export declare function removeJssSignatures(bom20: object): {
    bom: object;
    removed: number;
};
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
export declare function signJssBom(bom20: object, options?: {
    deep?: boolean;
    allowInvalidatingSignatures?: boolean;
}): object;
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
export declare function verifyJssBom(bom20: object, options?: {
    deep?: boolean;
    requireAll?: boolean;
    allowNestedOnly?: boolean;
}): {
    valid: boolean;
    trusted: boolean;
    errors: string[];
    root: (object | null);
    results: any[];
    nested: Array<{
        path: string;
        valid: boolean;
        trusted: boolean;
        reasons: string[];
        results: any[];
    }>;
};
/**
 * Generate a JSS key pair for an algorithm (used by --generate-key-and-sign).
 *
 * @param {string} algorithm - JSS algorithm name
 * @returns {{privateKey: KeyObject, publicKey: KeyObject}}
 */
export declare function generateJssKeyPair(algorithm: string): {
    privateKey: KeyObject;
    publicKey: KeyObject;
};
//# sourceMappingURL=jssSigner.d.ts.map