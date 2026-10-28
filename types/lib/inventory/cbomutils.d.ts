/**
 * Method to collect crypto and ssl libraries from the OS.
 *
 * @param {Object} options
 * @returns osPkgsList Array of OS crypto packages
 */
export declare function collectOSCryptoLibs(options: Object, executeOsQueryFn: any): any[];
/**
 * Build cryptographic-asset components by running source-level JS crypto
 * detection over the given directory.
 *
 * @param {string} src Path to the source directory to scan.
 * @param {object} [options] Collection options forwarded to the detector and evidence normalizer.
 * @param {boolean} [options.deep] When true, perform a deep scan including nested directories.
 * @returns {Promise<Object[]>} Sorted array of cryptographic-asset component objects.
 */
export declare function collectSourceCryptoComponents(src: string, options?: {
    deep?: boolean;
}): Promise<Object[]>;
/**
 * Build cryptographic-asset components from dosai crypto analysis output,
 * mapping detected algorithms, operations, and key materials into CycloneDX
 * components.
 *
 * @param {string} src Path to the source directory used for evidence attribution.
 * @param {object} [options] Collection options forwarded to the analyzer and evidence normalizer.
 * @returns {Promise<Object[]>} Sorted array of cryptographic-asset component objects (empty when dosai produces no output).
 */
export declare function collectDosaiCryptoComponents(src: string, options?: object): Promise<Object[]>;
/**
 * Find crypto algorithm in the given code snippet
 *
 * cleanStr fuses the snippet's identifiers into one lowercase string
 * (`prepare_for_save(iv` becomes `prepareforsaveiv`), so a plain substring
 * test reads short algorithm names inside unrelated identifiers (`rsa` in
 * `for_save`). A name therefore matches only where a cleanStr word begins:
 * the snippet's start, right after any character cleanStr strips or keeps as
 * a separator, or at a lowercase-to-uppercase change in the original text
 * (`SHA256withRSA`, `HmacSHA256`, `PBKDF2WithHmacSHA256`,
 * `generateRsaKeyPair`). Boundaries are computed from the original string
 * before it is lowercased, so case changes survive the cleanStr fusion.
 * Letter/digit changes do not start a word: they added no match on any
 * reviewed form or corpus snippet, while splitting every digit-bearing
 * identifier (`md5`, `base64`) into false word starts. Fused forms the names
 * themselves are written in still match: `algorithms.AES(key)` and
 * `AESGCM(key)` yield `aes`, `AES-256-GCM` yields `aes256-GCM`,
 * `createHash("sha256")` yields `sha-256`. All-uppercase fused forms
 * (`HMACSHA256`) still hide every name but the run's first.
 *
 * @param {string} code Code snippet
 * @returns {Array} Arary of crypto algorithm objects with oid and description
 */
export declare function findCryptoAlgos(code: string): any[];
//# sourceMappingURL=cbomutils.d.ts.map