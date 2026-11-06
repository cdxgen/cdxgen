/**
 * Longest exclude or include pattern cdxgen accepts from an untrusted source,
 * such as a server request or a config file in the scanned directory.
 */
export declare const UNTRUSTED_GLOB_PATTERN_MAX_LENGTH = 512;
/**
 * Most patterns a list of untrusted exclude or include patterns may stand
 * for once brace expressions are expanded. Every expanded pattern is matched
 * against every file the scan walks, so the total, not the length of the
 * list as written, is what decides the cost.
 */
export declare const UNTRUSTED_GLOB_EXPANSION_BUDGET = 128;
/**
 * Count, from above, how many patterns a glob's brace expressions expand to,
 * following the brace-expansion package that minimatch uses:
 *
 * - alternatives in `{a,b}` add up, and groups side by side or inside one
 *   another multiply;
 * - a range such as `{1..9}`, `{a..z}` or `{0..100..5}` counts its members;
 * - a group with no comma of its own but a list inside it, such as
 *   `{{a,b}c}`, is expanded and each result is braced and expanded again,
 *   so it counts as its contents, unless its text holds `..` and a result
 *   could become a range of any size.
 *
 * brace-expansion reads braces that form neither a list nor a range in ways
 * that depend on the rest of the pattern, so a group that is neither, a
 * closing brace with no group open, a group left open, and the `..` case
 * above all count as more than `cap`. Patterns that list alternatives or
 * ranges, such as `{test,tests}` or `*.{js,ts}`, get the exact count, or one
 * slightly above it where a letter range such as `{Z..c}` spans the `\` that
 * brace-expansion leaves out. `\` escapes the next character. The count stops growing at
 * `cap + 1` and each character is read once, so a pattern that would expand
 * to millions costs no more to count than its length.
 *
 * @param {string} pattern glob pattern
 * @param {number} [cap] largest count of interest
 * @returns {number} upper bound on the number of expanded patterns, at most
 *   `cap + 1`
 */
export declare function globBraceExpansionCount(pattern: string, cap?: number): number;
/**
 * Split exclude or include patterns from an untrusted source into the ones
 * cdxgen uses and the ones it refuses. Patterns are taken in order while
 * they fit the expansion budget, so a list cannot multiply the work of a
 * scan by brace expansion or sheer number.
 *
 * @param {unknown} patterns a pattern, a list of patterns, or nothing
 * @param {Object} [options] bound options
 * @param {boolean} [options.allowBraces=true] refuse every pattern with a
 *   brace when false
 * @param {number} [options.budget] expanded patterns allowed in all
 * @param {number} [options.used=0] expanded patterns earlier lists have
 *   already taken from the budget
 * @returns {{accepted: string[], refused: {pattern: string, reason: string}[], expansions: number}}
 *   the patterns to use, the ones refused with the reason, and the expanded
 *   patterns the accepted ones use
 */
export declare function boundUntrustedGlobPatterns(patterns: unknown, { allowBraces, budget, used, }?: {
    allowBraces?: boolean;
    budget?: number;
    used?: number;
}): {
    accepted: string[];
    refused: {
        pattern: string;
        reason: string;
    }[];
    expansions: number;
};
//# sourceMappingURL=globPatterns.d.ts.map