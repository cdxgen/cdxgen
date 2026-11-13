/**
 * ANSI-aware text measurement, stripping, and wrapping helpers.
 *
 * Layer 0: this module imports nothing outside `lib/core`. It is the shared
 * home for the width/wrap primitives that `lib/inventory/table.js` (layer 2)
 * and `lib/core/ui.js` (layer 0) both need, so neither has to reach across a
 * layer boundary for them.
 */
/** String source of a regex matching ANSI escape sequences (CSI forms). */
declare const ANSI_PATTERN = "\\u001B\\[[0-?]*[ -/]*[@-~]";
/** Global regex constructed from {@link ANSI_PATTERN}, used to strip ANSI escapes. */
declare const ANSI_REGEX: RegExp;
/** Regex matching Unicode combining mark characters (the `\p{Mark}` category). */
declare const COMBINING_MARK_REGEX: RegExp;
/**
 * Write the control and line-break characters of untrusted text (Unicode Cc,
 * U+2028 and U+2029) as JSON `\u` escapes, so that printing it to a terminal
 * cannot move the cursor, rewrite a line, or start a new one.
 *
 * @param {string} input Text taken from a document or another untrusted source
 * @returns {string} The text with control characters escaped
 */
export declare const escapeControlCharacters: (input: string) => string;
/**
 * Strip ANSI escape sequences from a string.
 *
 * @param {string} input Input possibly containing ANSI escapes
 * @returns {string} Visible text only
 */
export declare const stripAnsi: (input: string) => string;
/**
 * Detect full-width East-Asian-Wide and emoji code points so they occupy two
 * cells instead of one. The ranges mirror the EastAsianWidth+F/EV definitions
 * used by mainstream terminal width libraries.
 *
 * @param {number} codePoint Code point to test
 * @returns {boolean} True when the code point is double-width
 */
export declare const isFullWidthCodePoint: (codePoint: number) => boolean;
/**
 * Measure the visible cell width of a string, accounting for ANSI escapes,
 * combining marks, and full-width code points.
 *
 * @param {string} input Input to measure
 * @returns {number} Visible width in terminal cells
 */
export declare const stringWidth: (input: string) => number;
/**
 * Pad/align text to a target visible width.
 *
 * @param {string} text Text to align
 * @param {number} width Target cell width
 * @param {"left"|"right"|"center"} [alignment="left"] Alignment
 * @returns {string} Padded text
 */
export declare const alignText: (text: string, width: number, alignment?: "left" | "right" | "center") => string;
/**
 * Split a single line into ANSI and non-ANSI tokens, preserving the escape
 * sequences so wrappers can re-emit them attached to the right chunk.
 *
 * @param {string} line Input line
 * @returns {{isAnsi: boolean, value: string}[]} Tokens in order
 */
export declare const splitAnsiTokens: (line: string) => {
    isAnsi: boolean;
    value: string;
}[];
/**
 * Wrap a single line by character count, keeping ANSI sequences attached to
 * the current chunk.
 *
 * @param {string} line Input line (no embedded newlines)
 * @param {number} width Target cell width
 * @returns {string[]} Wrapped lines
 */
export declare const wrapLineByChars: (line: string, width: number) => string[];
/**
 * Wrap a single line by word boundaries, falling back to character wrapping
 * for words longer than the width.
 *
 * @param {string} line Input line
 * @param {number} width Target cell width
 * @returns {string[]} Wrapped lines
 */
export declare const wrapLineByWords: (line: string, width: number) => string[];
export { ANSI_PATTERN, ANSI_REGEX, COMBINING_MARK_REGEX };
//# sourceMappingURL=text.d.ts.map