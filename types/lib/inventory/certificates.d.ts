export declare function toLowerHex(value: any): any;
export declare function normalizeSerialHex(value: any): string | undefined;
export declare function serialDecimalToHex(value: any): string | undefined;
/**
 * Split PEM text into labelled blocks without decoding them. Only the label
 * line and the matching END line matter; the caller decides which labels to
 * parse. Bounded by block count and total decoded size.
 *
 * @param {string} text file contents
 * @returns {{label: string, body: string}[]} blocks in file order
 */
export declare function splitPemBlocks(text: string): {
    label: string;
    body: string;
}[];
/**
 * Decode the CERTIFICATE blocks of a PEM bundle (RFC 7468) into DER buffers.
 * `TRUSTED CERTIFICATE` blocks (OpenSSL aux data after the DER) are not
 * decoded here; the trustinspector plugin parses their trust/reject lists.
 *
 * @param {string} text PEM file contents
 * @returns {Buffer[]} DER buffers in file order
 */
export declare function pemCertificateDerBlocks(text: string): Buffer[];
export declare function privateKeyPemFormat(text: any): "DSA" | "EC" | "ENCRYPTED-PKCS8" | "OPENSSH" | "PKCS8" | "RSA" | undefined;
/**
 * A PEM public key (RFC 7468 PUBLIC KEY label) also classifies a matched
 * file as key material rather than a certificate.
 *
 * @param {string} text file contents
 * @returns {boolean} true when a PUBLIC KEY block is present
 */
export declare function hasPemPublicKey(text: string): boolean;
/**
 * Walk a certificate DER far enough to learn what the platform parsers may
 * not report: the SubjectPublicKeyInfo (for the SPKI hash and key algorithm
 * OID), the outer signature algorithm OID, the X.509 version, the subject and
 * issuer name DER (byte equality = self-issued), and the SKI/AKI key
 * identifiers (RFC 5280 sections 4.1, 4.2.1.1, 4.2.1.2). Malformed input
 * yields undefined; nothing throws.
 *
 * @param {Buffer} der certificate DER, at most MAX_CERT_DER_BYTES
 * @returns {object|undefined} parsed fields
 */
export declare function parseCertificateDer(der: Buffer): object | undefined;
/**
 * Name a key algorithm the way the BOM model requires: the post-quantum table
 * first, then classical names derived from the SPKI OID and key size, never
 * the platform's own name for an algorithm it may not know. Names agree with
 * trustinspector's (`RSA-2048`, `ECDSA-P256`, `Ed25519`, `ML-DSA-65`);
 * unknown algorithms keep their dotted OID.
 *
 * @param {object} context `{oid, curveOid, bits}` from the DER walk or report
 * @returns {string|undefined} key name such as `ML-DSA-65`, `RSA-2048`, `ECDSA-P256`
 */
/**
 * The family name for a key algorithm component: like
 * {@link keyAlgorithmName} but without the key-size suffix, so every key
 * size sharing an OID (RSA-1024 and RSA-2048, ECDSA P-256 and P-384)
 * references the same single algorithm component. Post-quantum names are
 * already family names (`ML-DSA-65`).
 *
 * @param {string} oid SPKI algorithm OID
 * @returns {string|undefined} family name such as `RSA`, `ECDSA`, `ML-DSA-65`
 */
export declare function keyAlgorithmFamilyName(oid: string): string | undefined;
export declare function keyAlgorithmName(context: any): any;
/**
 * Name a signature algorithm: the post-quantum table, then Go's classical
 * names, then the dotted OID. Never "0" or "unknown".
 *
 * @param {object} context `{oid}` or a trusted producer name
 * @returns {string|undefined} signature name such as `ML-DSA-65`, `SHA256-RSA`
 */
export declare function signatureAlgorithmName(context: object): string | undefined;
/**
 * Metadata for an algorithm component: primitive, parameter set and NIST
 * quantum security level from the post-quantum table; classical algorithms
 * carry level 0, which is a fact, not a policy.
 *
 * @param {string} oid dotted algorithm OID
 * @param {string} kind `"signature"` or `"kem"`/key use
 * @returns {object} `{primitive, parameterSetIdentifier, nistQuantumSecurityLevel}` when known
 */
export declare function algorithmComponentMetadata(oid: string): object;
export declare function commonNameFromDn(dn: any): string | undefined;
/**
 * Normalise a trustinspector material (report-1 or report-2) into a
 * certificate record. Returns undefined for non-certificate kinds.
 *
 * @param {object} material trustinspector material
 * @param {object} [context] `{locationRoot}` to relativise container paths
 * @returns {object|undefined} record
 */
export declare function certRecordFromTrustInspector(material: object, context?: object): object | undefined;
/**
 * Build a certificate record from a parsed certificate (Node fallback path).
 * The DER walk supplies the SPKI, algorithm OIDs, version and key
 * identifiers; the X509Certificate supplies names, validity and, on runtimes
 * that expose them, the signature algorithm. Fields the platform cannot
 * provide (key usage bits, path length) stay unset and are documented as
 * fallback limits.
 *
 * @param {Buffer} der certificate DER
 * @param {object} context `{location, sourceType, pem}`
 * @returns {object|undefined} record
 */
export declare function certRecordFromDer(der: Buffer, context?: object): object | undefined;
export declare function toWellFormedText(value: any): string | undefined;
/**
 * Normalise one certificate of the chain a server presented in a TLS ≤ 1.2
 * handshake, as safer-exec's crypto result relays it (leaf first). The entry
 * carries no DER: identity is the two SHA-256 digests, and the server's
 * ordering is untrusted input, so the record carries no issuer edges and no
 * SKI/AKI. Fields safer-exec already classified per PLAN section 2.5
 * (selfSigned, keyName, signatureAlgorithm) are taken as given; `role` is
 * re-derived from them with the same rule as the DER path.
 *
 * @param {object} entry safer-exec CertChainEntry
 * @param {object} [context] `{host}` the safer-exec `host:port` the chain was
 *   presented to; the occurrence `tls://<host>` is omitted without it
 * @returns {object|undefined} record, or undefined when the entry has no
 *   usable certificate hash
 */
export declare function certRecordFromObservedChainEntry(entry: object, context?: object): object | undefined;
/**
 * Pairwise issuer linking over records parsed in one collection
 * (`certRecordFromDer` output). A verified edge needs the signature to check;
 * an uncheckable signature over chained names and key identifiers goes to
 * issuersUnverified. A certificate seen more than once is linked once and
 * its other sightings get the same result. Capped at ISSUER_LINK_LIMIT
 * certificates and ISSUER_VERIFY_LIMIT signature checks; past either cap the
 * remaining records stay unlinked.
 *
 * @param {object[]} records records from certRecordFromDer
 */
export declare function linkFallbackIssuers(records: object[]): void;
/**
 * Relativise a host path against a scan root so producers agree on
 * locations: `/tmp/x/rootfs/etc/ssl` with root `/tmp/x/rootfs` becomes
 * `/etc/ssl` (PLAN section 4.4, G18).
 *
 * @param {string} location host or already-relative path
 * @param {string} [root] scan root to strip
 * @returns {string} normalised container-style path
 */
export declare function containerRelativePath(location: string, root?: string): string;
/**
 * Collects certificate records from any producer, deduplicates them by
 * certificate SHA-256 and builds the shared component model: one certificate
 * component per certificate, one public-key component per SPKI, algorithm
 * components, and verified issuer `dependsOn` edges.
 */
export declare class CertificateCollector {
    recordsBySha: Map<any, any>;
    locationsBySha: Map<any, any>;
    pins: any[];
    constructor();
    addRecord(record: any): void;
    addRecords(records: any): void;
    addTrustInspectorMaterials(materials: any, context: any): void;
    addPin({ spkiSha256, location }: {
        location: any;
        spkiSha256: any;
    }): void;
    /**
     * Build the shared model. Deterministic: components and dependency lists
     * are sorted, and no map iteration order reaches the output.
     *
     * @returns {{components: object[], dependencies: object[]}}
     */
    build(): {
        components: object[];
        dependencies: object[];
    };
}
/**
 * The file a certificate occurrence lives in. A Kubernetes secret occurrence
 * is `<file>#data.tls.crt` (or `#stringData.ca.crt`); the file path is what
 * internal:SrcFile records.
 *
 * @param {string} location occurrence location
 * @returns {string} file path without the secret key fragment
 */
export declare function srcFileOfLocation(location: string): string;
/**
 * Index built certificate components by occurrence location, so a keystore
 * file can be linked to the certificates it holds with one lookup. A scan of
 * every component per keystore would be quadratic in a root filesystem made
 * of thousands of one-certificate keystore files.
 *
 * @param {object[]} components built components, certificates included
 * @param {(location: string) => string} [normalizeLocation] location normaliser, applied to every occurrence
 * @returns {Map<string, string[]>} sorted certificate bom-refs per location
 */
export declare function certificateRefsByLocation(components: object[], normalizeLocation?: (location: string) => string): Map<string, string[]>;
/**
 * Merge already-built certificate/public-key components that describe the
 * same asset (same bom-ref), unioning occurrences and properties. Used at the
 * final assembly step where producer component lists meet.
 *
 * @param {object[]} components component list, possibly with crypto duplicates
 * @returns {object[]} component list with certificate duplicates merged
 */
export declare function mergeDuplicateCryptoComponents(components: object[]): object[];
export declare function kubernetesTlsSecretRecords(yamlText: any, { file }?: {}): object[];
export declare function androidNetworkSecurityConfigPins(xmlText: any, { file }?: {}): any[];
/**
 * Classify a matched file by its content: certificates (PEM bundle or DER),
 * a PEM private-key header, a GPG key, a PEM public key, or a keystore
 * container the fallback cannot read. Nothing is decoded beyond what the
 * header lines and a bounded DER walk reveal.
 *
 * @param {Buffer} bytes file contents (already size-capped by the caller)
 * @returns {object} one of `{kind:"certificates", ders}`,
 *   `{kind:"private-key", format}`, `{kind:"gpg"}`, `{kind:"public-key"}`,
 *   `{kind:"keystore", format}` or `{kind:"unknown"}`
 */
export declare function classifyCryptoFile(bytes: Buffer): object;
//# sourceMappingURL=certificates.d.ts.map