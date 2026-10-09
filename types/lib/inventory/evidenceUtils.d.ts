/**
 * Build a CycloneDX occurrence evidence object from a location string.
 *
 * @param {string} location Location string such as a file path or `file#line`
 * @param {Object} [details] Extra fields (e.g. line, offset) merged into the occurrence; empty values are skipped
 * @returns {Object|undefined} Occurrence evidence object with a location, or undefined when the location is empty
 */
export declare function createOccurrenceEvidence(location: string, details?: Object): Object | undefined;
/**
 * Parse a location string into a CycloneDX occurrence with file/line/offset fields.
 *
 * Recognizes `file#line`, `file:line:offset`, and `file:line` forms; other
 * strings are kept as a plain location occurrence.
 *
 * @param {string} location Location string to parse
 * @param {Object} [details] Extra fields merged into the occurrence
 * @returns {Object|undefined} Occurrence evidence object, or undefined when the location is empty
 */
export declare function parseOccurrenceEvidenceLocation(location: string, details?: Object): Object | undefined;
/**
 * Format an occurrence evidence object back into a location string.
 *
 * @param {Object} occurrence Occurrence evidence object with location, and optional line/offset
 * @returns {string} Location string in `file:line:offset`, `file#line`, or plain `file` form; empty when no location
 */
export declare function formatOccurrenceEvidence(occurrence: Object): string;
/**
 * Collect bom-refs from metadata.tools entries.
 *
 * @param {Object[]|Object} tools CycloneDX metadata.tools section
 * @param {Function} predicate Optional filter function
 * @returns {string[]} Unique tool bom-refs
 */
export declare function extractToolRefs(tools: Object[] | Object, predicate: Function): string[];
/**
 * Attach evidence.identity.tools references to the supplied subjects.
 *
 * @param {Object|Object[]} subjects Component or service objects
 * @param {string[]} toolRefs Tool bom-refs
 * @returns {Object|Object[]} The same mutated subject(s)
 */
export declare function attachIdentityTools(subjects: Object | Object[], toolRefs: string[]): Object | Object[];
/**
 * Enrich .NET package components with occurrence evidence and imported module/method
 * information from a dosai dependency slices file.
 *
 * Each dosai record names its package by purl, resolved in the project of the
 * record's file, and is attached to the component of that version (see
 * {@link resolveDosaiComponentPurl}). The DLL files of each package
 * (`internal:PackageFiles`) only fill in for a record whose purl names no
 * component, and only when the DLL belongs to one component or the record's
 * location says which: two versions of a package ship the same DLL names.
 *
 * The fallback is needed because dosai names a `System.*` assembly it cannot
 * map to a package with a framework purl (`pkg:nuget/System.Runtime`), as it
 * does whenever the tree has lock files but no restore output: the DLL of
 * System.Data.SQLite.Core is still the package's. A DLL that only a package's
 * build-time folders carry is not listed in `internal:PackageFiles`, so it
 * credits no package with the project's framework calls (issue 4441).
 *
 * @param {Object[]} pkgList Array of .NET package component objects to enrich
 * @param {string} slicesFile Path to the dosai dependency slices JSON file
 * @param {Object} [options] Options
 * @param {string} [options.srcPath] Directory dosai analyzed, which its relative locations
 *        and the components' relative manifest paths are relative to
 * @returns {Object[]} The enriched package list (same array, mutated in place)
 */
export declare function addEvidenceForDotnet(pkgList: Object[], slicesFile: string, options?: {
    srcPath?: string;
}): Object[];
/**
 * Convert OS query results
 *
 * @param {string} queryCategory Query category
 * @param {Object} queryObj Query Object from the queries.json configuration
 * @param {Array} results Query Results
 * @param {Boolean} enhance Optionally enhance results by invoking additional package manager commands
 */
export declare function convertOSQueryResults(queryCategory: string, queryObj: Object, results: any[], enhance?: boolean, osPackageListers?: undefined): {
    name: string;
    group: string;
    version: string;
    description: any;
    publisher: string;
    "bom-ref": string;
    scope: any;
    type: any;
}[];
//# sourceMappingURL=evidenceUtils.d.ts.map