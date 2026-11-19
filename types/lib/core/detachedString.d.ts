/**
 * Copies of strings that do not keep the text they were cut from alive.
 *
 * Layer 0: this module imports nothing.
 *
 * V8 returns a view into the parent string from `slice()`, `substring()`,
 * `split()` and `trim()` once the result is 13 characters or longer, so a short
 * value kept on a component holds the whole file it was cut from in memory
 * until the scan ends. Parsers of untrusted files copy every value they keep.
 */
/**
 * A copy of a string, as a string of its own. The copy goes through a Buffer;
 * utf16le keeps every UTF-16 code unit as it is, lone surrogates included.
 *
 * @param {string} value Text, often cut out of a larger text
 * @returns {string} The same text without a reference to the text it came from
 */
export declare function detachString(value: string): string;
/**
 * The first `limit` code units of a string, as a string of its own.
 *
 * @param {string} value Text
 * @param {number} limit Largest length kept
 * @returns {string} The text, cut at `limit`, detached from `value`
 */
export declare function truncateDetached(value: string, limit: number): string;
//# sourceMappingURL=detachedString.d.ts.map