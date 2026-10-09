/**
 * Build a lowercase type/namespace/name lookup key for a purl.
 *
 * Falls back to a stripped, lowercased form of the raw string when the purl
 * cannot be parsed.
 *
 * @param {string} purl Package URL string
 * @returns {string|undefined} Normalized key, or undefined when the input is empty or not a string
 */
export declare function normalizeDosaiPurlKey(purl: string): string | undefined;
/**
 * Append a value to the Set stored under a key in a map, creating the Set when absent.
 *
 * @param {Object} map Map of key to Set of values, mutated in place
 * @param {string} key Map key (usually a purl)
 * @param {string} value Value to add; no-op when key or value is falsy
 * @returns {void}
 */
export declare function addDosaiSetValue(map: Object, key: string, value: string): void;
/**
 * Format a `file#line` location string from a dosai node or location item.
 *
 * @param {Object} item Dosai node, edge, or location object carrying Path/FileName and LineNumber fields
 * @returns {string|undefined} Location string with a `#line` suffix when available, or undefined when no file is known
 */
export declare function dosaiLocation(item: Object): string | undefined;
/**
 * Format the `file#line` location of a dosai MethodCalls row, relative to the
 * scanned directory like dosai's source rows.
 *
 * A call site found in assembly IL names its file through the PDB. dosai 5
 * writes it relative to the scan root and leaves Path out when the file has
 * no place in the tree; dosai 4 writes the PDB path as it is: absolute for a
 * local build, `/_/` for a deterministic one (owasp-dep-scan/dosai#79). An
 * absolute path under the scanned directory is made relative to it, and any
 * other build path, or a missing one, gives way to the file name, as for call
 * graph edges, so both versions list a call site found in source and in IL
 * once. Where no sequence point covers a call, the row names the assembly and
 * its line is an IL offset, which is no source location.
 *
 * @param {Object} methodCall Dosai MethodCalls row
 * @param {string} [srcPath] Directory dosai analyzed
 * @returns {string|undefined} Location string, or undefined when the row names no source file
 */
export declare function dosaiCallSiteLocation(methodCall: Object, srcPath?: string): string | undefined;
/**
 * Return a validated source location for .NET source extensions, from a call graph node.
 *
 * @param {Object} node Dosai call graph node object
 * @returns {string|undefined} Location string, or undefined unless the file is .cs/.vb/.fs/.fsx/.r with a positive line number
 */
export declare function dosaiSourceLocationFromNode(node: Object): string | undefined;
/**
 * Return a validated source location for .NET source extensions, from a location object.
 *
 * @param {Object} location Dosai location object carrying Path/FileName and LineNumber fields
 * @returns {string|undefined} Location string, or undefined unless the file is .cs/.vb/.fs/.fsx/.r with a positive line number
 */
export declare function dosaiSourceLocation(location: Object): string | undefined;
/**
 * Build a purl alias map from BOM components.
 *
 * Maps each component purl to itself, and indexes the components by their
 * version-free identity, so a dosai-reported purl can be reconciled by version
 * (see {@link resolveDosaiComponentPurl}). Two versions of one package are two
 * components, and nothing here picks one of them on a name alone.
 *
 * @param {Object[]} [components] Component objects with purl fields
 * @param {Object} [options] Options
 * @param {string} [options.srcPath] Directory dosai analyzed, which its relative locations
 *        and the BOM's relative manifest paths are relative to
 * @returns {Map<string, string>} Map of purl to canonical component purl, carrying the identity index
 */
export declare function buildDosaiPurlAliasMap(components?: Object[], options?: {
    srcPath?: string;
}): Map<string, string>;
/**
 * Choose among the components that share a file name (two versions of a
 * package ship the same DLLs): the only one, else the one whose project
 * directory is nearest the record's location.
 *
 * @param {Iterable<string>} purls Candidate component purls
 * @param {Map<string, string>} purlAliasMap Alias map built by buildDosaiPurlAliasMap
 * @param {string} [location] Source location of the dosai record (`path` or `path#line`)
 * @returns {string|undefined} The component purl, or undefined when it cannot be told
 */
export declare function pickDosaiComponentByLocation(purls: Iterable<string>, purlAliasMap: Map<string, string>, location?: string): string | undefined;
/**
 * Resolve a dosai-reported purl to a BOM component purl.
 *
 * The exact purl wins, then the same package at the same version (ids compare
 * case-insensitively). A versionless purl, or a version the BOM does not hold,
 * maps to the package's only component when it has one. When the BOM holds
 * several versions, the record's location picks the version of the project
 * that file belongs to; without a location that settles it the purl maps to
 * nothing rather than to an arbitrary version (issue dosai#72).
 *
 * @param {string} purl Purl reported by dosai
 * @param {Map<string, string>} purlAliasMap Alias map built by buildDosaiPurlAliasMap
 * @param {string} [location] Source location of the dosai record (`path` or `path#line`)
 * @returns {string|undefined} Canonical component purl, the input purl when the BOM has no
 *          component of that package, or undefined when empty or ambiguous
 */
export declare function resolveDosaiComponentPurl(purl: string, purlAliasMap: Map<string, string>, location?: string): string | undefined;
//# sourceMappingURL=dosaiParsers.d.ts.map