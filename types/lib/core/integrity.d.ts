/**
 * Parse an integrity string into its hashes. A token that is not
 * `<algorithm>-<base64>`, names an algorithm other than sha1, sha256, sha384
 * or sha512, or has a malformed digest is skipped, and `?options` after the
 * digest are ignored.
 *
 * @param {string} str Integrity string, possibly holding several hashes
 * @returns {{algorithm: string, digest: string}[]} The valid hashes, in order
 */
export declare function parseIntegrity(str: string): {
    algorithm: string;
    digest: string;
}[];
/**
 * Compute the integrity string of some data.
 *
 * @param {string|Buffer|Uint8Array} data Content to hash (strings as UTF-8)
 * @param {string} [algorithm] Hash algorithm, sha512 by default
 * @returns {string} `<algorithm>-<base64 digest>`
 */
export declare function integrityOf(data: string | Buffer | Uint8Array, algorithm?: string): string;
//# sourceMappingURL=integrity.d.ts.map