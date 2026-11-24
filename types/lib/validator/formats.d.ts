/**
 * The JSON Schema string formats the pre-compiled CycloneDX validators assert
 * (`date`, `date-time` and `uri`), plus the two small helpers the generated
 * code calls (`equal` and `ucs2length`). They are written from the RFCs and
 * every check is a bounded pass over the input with no backtracking regular
 * expression. `idn-email` lives in `lib/parsers/email.js`.
 */
/**
 * RFC 3339 `full-date` (section 5.6): `YYYY-MM-DD` naming a real day.
 *
 * @param {string} str Candidate value
 * @returns {boolean} True for a valid calendar date
 */
export declare function isValidDate(str: string): boolean;
/**
 * RFC 3339 `date-time` (section 5.6). The separator is `T`, `t` or a single
 * space, as section 5.6 permits.
 *
 * @param {string} str Candidate value
 * @returns {boolean} True for a valid date-time
 */
export declare function isValidDateTime(str: string): boolean;
/**
 * RFC 3986 `URI` (section 3): `scheme ":" hier-part ["?" query] ["#" fragment]`.
 * A relative reference has no scheme and is rejected, and so is a bare scheme
 * with an empty hier-part, which names nothing.
 *
 * @param {string} str Candidate value
 * @returns {boolean} True for a valid URI
 */
export declare function isValidUri(str: string): boolean;
/**
 * The number of Unicode code points in a string, which is how JSON Schema
 * counts `minLength` and `maxLength` (a surrogate pair is one character).
 *
 * @param {string} str Text to measure
 * @returns {number} Code point count
 */
export declare function ucs2length(str: string): number;
/**
 * Deep equality of two parsed JSON values, used by the `const` and `enum`
 * keywords.
 *
 * @param {*} a First value
 * @param {*} b Second value
 * @returns {boolean} True when both hold the same JSON data
 */
export declare function equal(a: any, b: any): boolean;
//# sourceMappingURL=formats.d.ts.map