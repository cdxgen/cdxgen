/**
 * Find dangerous Unicode characters and return their details.
 *
 * @param {string} text string to inspect
 * @returns {{ char: string, codePoint: string, index: number, kind: string }[]} matches
 */
export function findDangerousUnicodeMatches(text: string): {
    char: string;
    codePoint: string;
    index: number;
    kind: string;
}[];
/**
 * Scan a text blob for dangerous Unicode characters and summarize where they appear.
 *
 * @param {string} text text to inspect
 * @param {{ syntax?: "markdown" | "text" | "yaml" }} [options] scan options
 * @returns {{
 *   codePoints: string[],
 *   commentCodePoints: string[],
 *   contexts: string[],
 *   hasHiddenUnicode: boolean,
 *   inComments: boolean,
 *   lineNumbers: number[],
 *   matches: { char: string, codePoint: string, index: number, kind: string, lineNumber: number, inComment: boolean }[],
 * }} scan result
 */
export function scanTextForHiddenUnicode(text: string, options?: {
    syntax?: "markdown" | "text" | "yaml";
}): {
    codePoints: string[];
    commentCodePoints: string[];
    contexts: string[];
    hasHiddenUnicode: boolean;
    inComments: boolean;
    lineNumbers: number[];
    matches: {
        char: string;
        codePoint: string;
        index: number;
        kind: string;
        lineNumber: number;
        inComment: boolean;
    }[];
};
//# sourceMappingURL=unicodeScan.d.ts.map