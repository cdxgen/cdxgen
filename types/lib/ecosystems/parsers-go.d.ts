/**
 * The licence notices of a module that is already on this machine, from the
 * directory `go list` reported, from the project's `vendor/` tree, or from the
 * module cache. Reading them costs no network round trip, so they answer
 * before pkg.go.dev is asked. Every notice of the first directory holding
 * one is returned, as pkg.go.dev reads every notice of a module.
 *
 * The directory `go list` reported is always read. The vendor tree and the
 * module cache stand in for pkg.go.dev, so they are read only when licences
 * are being fetched. Their directories are built from a module path and
 * version read from modules.txt or go.sum, so a path or version the Go
 * toolchain would reject, such as one with a `..` element, is not looked up:
 * Go never writes such a directory, and joining it could leave the tree. A
 * directory inside the project that a link leads out of it is skipped, and a
 * notice larger than 1 MiB is not read.
 *
 * @param {string} name Full module path
 * @param {string} [version] Module version, for the module cache layout
 * @param {Object} [options] Options
 * @param {string} [options.dir] The module's directory, as `go list` reports it
 * @param {string} [options.projectRoot] Project root holding a `vendor/` tree
 * @param {string} [options.vendorPath] The path the module is vendored under,
 *   when it differs from `name`: Go vendors a replaced module under the path
 *   it replaces
 * @param {Map<string, Object>} [options.noticeDirs] The directories whose
 *   notices this scan has read, by real path, with the module each was read
 *   for. Replace directives and vendored links can lead any number of modules
 *   to one directory; only the first module gets its notices as they are, and
 *   the others get them marked `shared`, so their text is embedded once
 * @returns {{fileName: string, text: string, shared?: boolean}[]} The
 *   notices, in file name order; empty when none is held locally
 */
export declare function readLocalGoLicenses(name: string, version?: string, options?: {
    dir?: string;
    projectRoot?: string;
    vendorPath?: string;
    noticeDirs?: Map<string, Object>;
}): {
    fileName: string;
    text: string;
    shared?: boolean;
}[];
/**
 * The text of the first licence notice {@link readLocalGoLicenses} finds.
 *
 * @param {string} name Full module path
 * @param {string} [version] Module version, for the module cache layout
 * @param {Object} [options] The options {@link readLocalGoLicenses} takes
 * @returns {string|undefined} The notice text, or undefined when none is held
 *   locally
 */
export declare function readLocalGoLicense(name: string, version?: string, options?: Object): string | undefined;
/**
 * Order two Go module versions by semantic version precedence, as Go's semver
 * package does: a pre-release, pseudo-versions included, sorts before its
 * release, and build metadata such as `+incompatible` does not count.
 *
 * @param {string} a A module version
 * @param {string} b Another module version
 * @returns {number} Negative, zero or positive as `a` sorts before, with or
 *   after `b`
 */
export declare function compareGoVersions(a: string, b: string): number;
/**
 * Builds a Go package component object containing purl, bom-ref, integrity hash,
 * and optionally license and VCS external reference information.
 *
 * @param {string} group Package group (module path prefix, may be empty)
 * @param {string} name Package name (full module path when group is empty)
 * @param {string} version Package version string
 * @param {string} hash Integrity hash (e.g. "sha256-…"), used as _integrity
 * @param {Object} [options] Options
 * @param {boolean} [options.skipRegistryLookups] Leave the licence and VCS
 *   URL unset instead of asking pkg.go.dev. Used for the main module, which
 *   no registry holds.
 * @param {string} [options.dir] The module's directory, as `go list` reports
 *   it, where a local licence notice is read first
 * @param {string} [options.projectRoot] Project root holding a `vendor/` tree
 *   the module may be vendored in
 * @param {string} [options.vendorPath] The path the module is vendored under,
 *   when it differs from `name`
 * @returns {Promise<Object>} Component object ready for inclusion in a BOM package list
 */
export declare function getGoPkgComponent(group: string, name: string, version: string, hash: string, options?: {
    skipRegistryLookups?: boolean;
    dir?: string;
    projectRoot?: string;
    vendorPath?: string;
}): Promise<Object>;
/**
 * Method to parse go.mod files
 *
 * @param {String} goModData Contents of go.mod file
 * @param {Object} gosumMap Data from go.sum files
 *
 * @returns {Object} Object containing parent component, rootList, packages
 *   list, and the replace directives as `replacements`
 */
export declare function parseGoModData(goModData: string, gosumMap: Object): Object;
/**
 * Parses a Go modules text file (e.g. vendor/modules.txt) and returns a list of
 * Go package components. Cross-references the go.sum map for integrity hashes and
 * sets scope and confidence based on hash availability.
 *
 * Only the modules the vendor tree holds become components: a module line
 * followed by its `##` annotations or its packages. `go mod vendor` also
 * records every replace directive of go.mod at the end of the file, as a
 * module line with nothing after it, so the consumer can tell that the
 * replacement had no effect; those lines name no vendored module.
 *
 * @param {string} txtFile Path to the modules.txt file
 * @param {Object} gosumMap Map of "module@version" keys to sha256 hash values from go.sum
 * @param {Object} [options] Options
 * @param {Map<string, Object>} [options.noticeDirs] The licence notice
 *   directories this scan has read, shared with the other Go parsers of the
 *   scan (see {@link readLocalGoLicenses})
 * @returns {Promise<Object[]>} List of Go package component objects with evidence
 */
export declare function parseGoModulesTxt(txtFile: string, gosumMap: Object, options?: {
    noticeDirs?: Map<string, Object>;
}): Promise<Object[]>;
/**
 * Parse go list output
 *
 * Each row is printed by the template in createGoBom:
 * `Path|Version|Indirect|GoMod|GoVersion|Main|Time|Deprecated|GoModSum|Dir|Sum|
 * Replace.Path|Replace.Version|Replace.Sum`. Rows from older templates end
 * after `Dir`.
 *
 * A replaced module is reported as the module Go builds (see
 * {@link goReplacement}), with the checksum of the replacement. A go.work
 * workspace makes every member a main module, so the parent is the main
 * module in `options.mainModuleDir`, and the other members are returned as
 * `workspaceModules`.
 *
 * @param {string} rawOutput Output from go list invocation
 * @param {Object} gosumMap go.sum data
 * @param {Object} [options] Options
 * @param {string} [options.mainModuleDir] Directory `go list` ran in, whose
 *   main module is the parent component
 * @param {Map<string, Object>} [options.noticeDirs] The licence notice
 *   directories this scan has read, shared with the other Go parsers of the
 *   scan (see {@link readLocalGoLicenses})
 * @returns Object with parent component, list of packages, and the other main
 *   modules of a workspace
 */
export declare function parseGoListDep(rawOutput: string, gosumMap: Object, options?: {
    mainModuleDir?: string;
    noticeDirs?: Map<string, Object>;
}): Promise<{
    parentComponent: {};
    pkgList: Object[];
    workspaceModules: Object[];
}>;
/**
 * Parse go mod graph
 *
 * `go mod graph` names every module by the path and version its requirement
 * names, whatever replaces it. A replaced module is mapped to the module Go
 * builds: from the components `go list` reported, which record what they
 * replace, or else from the replace directives of go.mod.
 *
 * @param {string} rawOutput Output from go mod graph invocation
 * @param {string} goModFile go.mod file
 * @param {Object} gosumMap Hashes from gosum for lookups
 * @param {Array} epkgList Existing package list
 * @param {Object} parentComponent Current parent component
 *
 * @returns Object containing List of packages and dependencies
 */
export declare function parseGoModGraph(rawOutput: string, goModFile: string, gosumMap: Object, epkgList?: any[], parentComponent?: Object): Promise<{
    pkgList: any[];
    dependenciesList: {
        ref: string;
        dependsOn: any[];
    }[];
    parentComponent: any;
    rootList: any;
}>;
/**
 * Parse go mod why output.
 *
 * @param {string} rawOutput Output from go mod why
 * @returns {string|undefined} package name or none
 */
export declare function parseGoModWhy(rawOutput: string): string | undefined;
/**
 * Reports whether `go mod why -m` output says the main module does not need
 * the module. go prints `(main module does not need module X)`, or
 * `(main module does not need to vendor module X)` with `-vendor`, and exits
 * with status 0 either way.
 *
 * @param {string} rawOutput Output from go mod why
 * @returns {boolean} True when go reports the module as not needed
 */
export declare function isGoModWhyNotNeeded(rawOutput: string): boolean;
/**
 * Read the `module@version` to hash map out of go.sum contents, without
 * building components or touching the network.
 *
 * @param {string} gosumData Content of go.sum
 * @returns {Object} Map of `module@version` keys to the `sha256-…` checksum of
 *   the module content, for every version go.sum holds one for
 */
export declare function parseGosumHashes(gosumData: string): Object;
/**
 * Parse go sum data
 * @param {string} gosumData Content of go.sum
 * @returns package list
 */
export declare function parseGosumData(gosumData: string): Promise<Object[]>;
/**
 * Parses the contents of a Gopkg.lock or Gopkg.toml file (dep tool format) and
 * returns a list of Go package components. Optionally fetches license information
 * for each package when FETCH_LICENSE is enabled.
 *
 * @param {string} gopkgData Raw string contents of the Gopkg lock/toml file
 * @returns {Promise<Object[]>} List of Go package component objects
 */
export declare function parseGopkgData(gopkgData: string): Promise<Object[]>;
/**
 * Parses the output of `go version -m` (build info) and returns a list of Go
 * package components for each "dep" line, including name, version, and integrity hash.
 *
 * A dependency that a replace directive swapped out is printed as its `dep`
 * line followed by a `=>` line naming the replacement (runtime/debug
 * BuildInfo.String). The replacement is what the binary holds, so it is
 * reported as {@link goReplacement} describes, with the replacement's
 * checksum.
 *
 * @param {string} buildInfoData Raw string output from `go version -m`
 * @returns {Promise<Object[]>} List of Go package component objects
 */
export declare function parseGoVersionData(buildInfoData: string): Promise<Object[]>;
//# sourceMappingURL=parsers-go.d.ts.map