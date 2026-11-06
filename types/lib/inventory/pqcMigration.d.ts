/**
 * Post-quantum migration risk for cryptographic assets (cdxgen/cdxgen#4592).
 *
 * The facts come from data/pqc-migration.json: the classes of NIST IR 8547
 * (final, October 2026) Tables 2, 4 and 8 and section 4.1.3, plus FIPS 186-5
 * for DSA, each with its members (algorithm families, OIDs and normalised
 * names), the transition the source states and the rationale text. This
 * module classifies a component and builds the risk entry; it adds no fact of
 * its own.
 *
 * Classification of an algorithm asset (cryptoProperties.assetType
 * `algorithm`), first match wins. A hybrid combiner (primitive `combiner`) is
 * not classified: IR 8547 section 3.2.1 approves a composite scheme with one
 * approved input, so the OID of one input does not decide it.
 *
 * 1. `algorithmProperties.algorithmFamily`. A quantum-safe family (SHA-2,
 *    SHA-3, AES, ML-KEM, …) is safe, except its 112-bit members (SHA-224,
 *    SHA-512/224, SHA3-224), which are recognised by OID or name.
 * 2. `cryptoProperties.oid` (rsaEncryption, id-ecPublicKey, the RSA, ECDSA,
 *    EdDSA and DSA signature OIDs, X25519/X448, DH, …).
 * 3. The component name, lower case with only letters and digits kept
 *    ("SHA-512/224" is `sha512224`), then resolveAlgorithmFamily(name). A
 *    name that resolves to a hash family but names a DSA, RSA or ECDSA
 *    signature ("SHA256withDSA", "dsa-with-sha256", "RSA-SHA-512") is that
 *    signature algorithm, not its digest.
 *
 * A class whose members have a key family (rsa, ff, ec) is checked against
 * the minimum key size of IR 8547 Tables 2 and 4 (112 bits of classical
 * strength: RSA and finite-field 2048, elliptic curve 224). An algorithm with
 * a known smaller key, and a public or private key asset
 * (`related-crypto-material`) whose size is smaller, is classed
 * `below-minimum-strength` instead. The key size of an algorithm comes from
 * the first of these that gives a plausible key size (at least 512 for rsa
 * and ff, 160 to 571 for ec): a trailing number in its name ("RSA-1024")
 * unless it follows a hash token ("RSASSA-PSS-SHA-512",
 * "sha512WithRSAEncryption-512"), an RFC 7919 group name ("ffdhe2048"), its
 * `parameterSetIdentifier` (a digest size such as "256" on an RSA signature
 * is not a key size) or the bit size in its curve name. A key asset is
 * checked with its own size against the base class of its algorithm, so a
 * 4096-bit key of an algorithm named "RSA-1024" is not reported again.
 *
 * The likelihood and impact levels are the fixed per-class rating the data
 * file records. No confidence is emitted (the rating is not a measurement)
 * and no organisational fact is invented: no owner, status or responses.
 */
/** Prefix of every risk refId this module derives. */
export declare const PQC_RISK_REF_ID_PREFIX = "risk-pqc-";
/**
 * A name in lower case with only ASCII letters and digits kept, the form the
 * `names` tables of data/pqc-migration.json use.
 *
 * @param {string} name Algorithm or key name
 * @returns {string} The compact name, empty for no name
 */
export declare function compactAlgorithmName(name: string): string;
/**
 * Classify one cryptographic-asset component. Algorithm assets get their
 * IR 8547 class; key assets are classified only when their size is below the
 * IR 8547 minimum (the algorithm asset carries the quantum risk).
 *
 * @param {object} component A component with cryptoProperties
 * @param {Map<string, object>} [algorithmsByRef] Components by bom-ref, to
 *   resolve a key's `algorithmRef`
 * @returns {{className: string, keyFamily?: string, keySize?: number, minimumKeySize?: number}|undefined}
 *   The class, or undefined when the asset is quantum-safe or unclassified
 */
export declare function classifyPqcCryptoAsset(component: object, algorithmsByRef?: Map<string, object>): {
    className: string;
    keyFamily?: string;
    keySize?: number;
    minimumKeySize?: number;
} | undefined;
/**
 * Build the risks.risks[] entries for the quantum-vulnerable and weak
 * cryptographic assets of a 1.x-shaped internal BOM: one per asset with a
 * bom-ref (an asset without one could not be referenced from `affects`), in
 * component order, unique by refId.
 *
 * @param {object} internalBom The internal model
 * @returns {object[]} Risk entries shaped for the draft's
 *   #/$defs/cyclonedx-risk-2.0/$defs/risk; empty when nothing is at risk
 */
export declare function collectPqcRisks(internalBom: object): object[];
//# sourceMappingURL=pqcMigration.d.ts.map