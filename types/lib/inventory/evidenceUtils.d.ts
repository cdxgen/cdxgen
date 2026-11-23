export declare const FILENAME_LABEL = "Filename ";
export declare const DECLARATION_OCCURRENCES_PROPERTY = "cdx:evidence:occurrences:declaration";
/**
 * Locations a component's declaration-occurrence property names.
 *
 * @param {Object} component Component with optional declaration property
 * @returns {Set<string>} The declared locations, empty when the component
 *   carries no declaration occurrences
 */
export declare function declarationOccurrenceLocations(component: Object): Set<string>;
/**
 * The occurrences of a component that name use sites in the analyzed sources,
 * which are all of them unless the component carries the declaration property.
 *
 * @param {Object} component Component with optional occurrence evidence
 * @returns {Object[]} Occurrences that are not declaration sites
 */
export declare function usageOccurrences(component: Object): Object[];
/**
 * Give the components no analyzer observed in the sources the manifests that
 * declare them as their occurrence evidence, marked as declaration sites with
 * {@link DECLARATION_OCCURRENCES_PROPERTY}.
 *
 * One rule for every ecosystem (discussion 4565): a consumer that reads
 * occurrences gets a location to point at for a declared component nothing
 * imports - a native NuGet asset, a CSS-only or CLI-only npm dependency -
 * while a component with observed usage keeps its use sites unchanged. A
 * component whose usage arrives later (the evinse pass, a re-run) drops the
 * filler, so the occurrences keep meaning use sites wherever there are any.
 *
 * The pass fills the gaps of a usage analysis: a BOM in which no component
 * carries usage evidence - the manifest-only scans - states nothing about
 * usage and keeps its shape. A file component is skipped, since its SrcFile is
 * the artifact itself rather than a declaration.
 *
 * @param {Object[]} components BOM components, sub-components included; changed in place
 * @returns {void}
 */
export declare function addDeclarationOccurrences(components: Object[]): void;
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
 * Attach evidence.identity.tools references to the supplied subjects. Only
 * the first MAX_IDENTITY_TOOL_REFS references are considered, and of those
 * only strings of up to MAX_IDENTITY_TOOL_REF_LENGTH characters are attached.
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
export declare function convertOSQueryResults(queryCategory: string, queryObj: Object, results: any[], enhance?: boolean, osPackageListers?: undefined): any[];
/**
 * Convert the packages of an apk installed database into components.
 *
 * The packages are named as the container scan names an Alpine, Wolfi or
 * Chainguard package, and grouped with the other OS package categories under
 * `cdx:osquery:category` = `apk_packages`. Beyond what an osquery package row
 * gives, an apk record knows its licence and home page, which become
 * `licenses` and a `website` external reference.
 *
 * @param {Object[]} packages Packages from readApkInstalledDb()
 * @returns {Object[]} Components
 */
export declare function convertApkPackages(packages: Object[]): Object[];
/**
 * Convert the rows of the `ai_agent_skills` query into components.
 *
 * A skill installed on the host is what the `ai-skill` project scan finds in a
 * repository, so it is a `file` component with the same `cdx:file:kind` and
 * `cdx:skill:*` properties, and no purl: a skill has no package identity. Its
 * bom-ref is the SHA-256 of its SKILL.md rather than the path, which is under a
 * home directory, and where it was found is an occurrence. The same skill
 * found under several roots, such as a plugin marketplace checkout and the
 * plugin cache, is one component with one occurrence for each.
 *
 * @param {Object[]} results Rows of `ai_agent_skills` joined with `hash`
 * @returns {Object[]} Components
 */
export declare function convertAgentSkillRows(results: Object[]): Object[];
//# sourceMappingURL=evidenceUtils.d.ts.map