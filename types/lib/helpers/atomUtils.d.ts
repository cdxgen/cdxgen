/**
 * Convert cdxgen's glob-style exclude patterns to a Scala/Java regex string.
 *
 * @param {string[]} patterns Glob patterns from cdxgen's `--exclude` option
 * @returns {string|undefined} Scala-compatible regex or undefined when empty
 */
export function globPatternsToAtomIgnoreRegex(patterns?: string[]): string | undefined;
export function isPathExcludedByGlobPatterns(filePath: any, patterns?: any[]): boolean;
export function filterAtomSlicesByExcludePatterns(sliceData: any, patterns?: any[]): any;
/**
 * Build additional environment variables for Atom from cdxgen CLI options.
 *
 * @param {Object} options CLI options
 * @param {string} language Atom language name
 * @returns {Object} Environment variables to pass to Atom
 */
export function buildAtomCommandEnv(options?: Object, language?: string): Object;
//# sourceMappingURL=atomUtils.d.ts.map