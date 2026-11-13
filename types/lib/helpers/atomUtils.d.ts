/**
 * Whether atom may paste a value into a shell command line as it is. Paths
 * and names of the scanned project are not trusted input: they come from its
 * config file and its directory names.
 *
 * @param {string} value Path, file name or option value handed to atom
 * @returns {boolean} true when no shell would interpret any part of the value
 */
export declare function isAtomShellSafe(value: string): boolean;
/**
 * Whether atom would start its Ruby frontend for the given atom arguments.
 *
 * @param {string[]} args Arguments passed to atom
 * @returns {boolean} true when the `-l` value names a Ruby language
 */
export declare function isAtomRubyRun(args: string[]): boolean;
/**
 * Convert cdxgen's glob-style exclude patterns to a Scala/Java regex string.
 *
 * @param {string[]} patterns Glob patterns from cdxgen's `--exclude` option
 * @returns {string|undefined} Scala-compatible regex or undefined when empty
 */
export declare function globPatternsToAtomIgnoreRegex(patterns?: string[]): string | undefined;
export declare function isPathExcludedByGlobPatterns(filePath: any, patterns?: any[]): boolean;
export declare function filterAtomSlicesByExcludePatterns(sliceData: any, patterns?: any[]): any;
/**
 * Build additional environment variables for Atom from cdxgen CLI options.
 *
 * @param {Object} options CLI options
 * @param {string} language Atom language name
 * @returns {Object} Environment variables to pass to Atom
 */
export declare function buildAtomCommandEnv(options?: Object, language?: string): Object;
//# sourceMappingURL=atomUtils.d.ts.map