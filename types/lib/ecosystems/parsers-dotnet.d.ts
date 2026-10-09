/**
 * Apply a version to a NuGet component so that the `version` field and the purl
 * always agree.
 *
 * A .NET manifest can state a version that is not a version: an MSBuild property
 * such as `$(JsonVersion)`, a range such as `[3.13.3,4.0)`, a wildcard such as
 * `2.0.*`, or nothing at all. Such a declaration cannot go into a purl, so a
 * component that kept it in `version` while its purl carried none described one
 * package two ways. A scanner range matching on the versionless purl then reports
 * every advisory published against the package name.
 *
 * The declaration is not lost: callers record it as `cdx:nuget:declared_version_range`.
 *
 * @param {Object} pkg Component to update in place. `name` must already be set.
 * @param {String} [version] Version as stated or resolved, concrete or not
 *
 * @returns {Object} The same component
 */
export declare function applyNugetVersion(pkg: Object, version?: string): Object;
/**
 * Compare two NuGet versions: up to four numeric release parts (missing parts
 * read as 0), then the prerelease label, with a release sorting after its own
 * prereleases. Build metadata after `+` is ignored, as NuGet ignores it.
 *
 * @param {string} a Version
 * @param {string} b Version
 * @returns {number} Negative, zero or positive, like a sort comparator
 */
export declare function compareNugetVersions(a: string, b: string): number;
/**
 * Whether a NuGet version range allows a version. A bare version is a minimum
 * (`1.0` means at least 1.0); brackets are inclusive and parentheses exclusive
 * (`[1.0]`, `[1.0,2.0)`, `(,2.0]`). An empty or unparseable range allows
 * anything.
 *
 * @param {string} range Range as a nuspec or lock file states it
 * @param {string} version Version to test
 * @returns {boolean} True when the range allows the version
 */
export declare function nugetRangeAllows(range: string, version: string): boolean;
/**
 * Choose the installed version a declared dependency resolves to: the lowest
 * installed version the range allows, as NuGet picks the lowest applicable
 * version; else the only installed version, which is what binding redirects
 * unify a dependency onto. Undefined when nothing installed can be named.
 *
 * @param {string} range Declared range
 * @param {string[]} installedVersions Versions installed for the package
 * @returns {string|undefined} The chosen version
 */
export declare function resolveInstalledNugetVersion(range: string, installedVersions?: string[]): string | undefined;
/**
 * The project directory a .NET manifest belongs to. Restore output records its
 * project file; otherwise project.assets.json sits in the project's `obj/`,
 * and lock files, packages.config and project files sit in the project
 * directory itself.
 *
 * @param {string} manifestFile Manifest path
 * @param {string} [projectPath] Project file the manifest names, when it does
 * @returns {string} Project directory
 */
export declare function dotnetManifestProjectDir(manifestFile: string, projectPath?: string): string;
/**
 * Index the MSBuild properties that props files define, by the directory each
 * file sits in and across the whole scan, so the candidates for every project
 * come from one read of each file.
 *
 * @param {string[]} propsFiles Props files of the scan
 * @returns {{byDir: Object, treeWide: Object}} Property values per directory and
 *          across the scan, each a map of property name to values
 */
export declare function indexPropsProperties(propsFiles?: string[]): {
    byDir: Object;
    treeWide: Object;
};
/**
 * The candidate values of MSBuild properties that can apply to a project file,
 * from the props files beside it and above it: the nearest directory that
 * defines a property wins, as the nearest Directory.Build.props is the one
 * MSBuild imports. A property no such directory defines falls back to the
 * values the whole scan's props files give it, which a caller only trusts when
 * there is exactly one.
 *
 * @param {string} projFile Project file
 * @param {{byDir: Object, treeWide: Object}} propsIndex Index built by {@link indexPropsProperties}
 * @returns {Object} Map of property name to candidate values
 */
export declare function projectPropertyCandidates(projFile: string, propsIndex?: {
    byDir: Object;
    treeWide: Object;
}): Object;
/**
 * The version of each package that every manifest of a scan agrees on, keyed by
 * lowercased package id. A package that two manifests give different versions
 * is left out: without knowing which project a declaration belongs to, picking
 * one of them would be a guess.
 *
 * @param {Object[]} pkgList Components collected from the scan's manifests
 * @returns {Object} Map of lowercased package id to version
 */
export declare function agreedNugetVersions(pkgList?: Object[]): Object;
/**
 * Method to parse .nupkg files
 *
 * @param {String} nupkgFile .nupkg file
 * @returns {Object} Object containing package list and dependencies
 */
export declare function parseNupkg(nupkgFile: string): Object;
/**
 * Method to parse .nuspec files
 *
 * @param {String} nupkgFile .nupkg file
 * @param {String} nuspecData Raw nuspec data
 * @returns {Object} Object containing package list and dependencies
 */
export declare function parseNuspecData(nupkgFile: string, nuspecData: string): Object;
/**
 * Parse a C# packages.config XML file and return a list of NuGet package components.
 *
 * @param {string} pkgData Raw XML string of a packages.config file
 * @param {string} pkgFile Path to the packages.config file, used for evidence properties
 * @param {Object} pkgNameVersions Package name - version map of versions already resolved
 *        from more precise manifests (project.assets.json / packages.lock.json), used to
 *        backfill templated or missing versions
 * @returns {Object[]} Array of NuGet package objects with purl, name, and version
 */
export declare function parseCsPkgData(pkgData: string, pkgFile: string, pkgNameVersions?: Object): Object[];
/**
 * Parse a Directory.Packages.props file and return the package versions it declares
 * centrally via NuGet Central Package Management.
 *
 * @param {String} propsFile Path to a Directory.Packages.props file
 *
 * @returns {Object} Map of lowercased package id to version. NuGet package ids are
 *          case-insensitive, so callers must lowercase before looking up.
 */
export declare function parseDirectoryPackagesProps(propsFile: string): Object;
/**
 * Method to collect the versions declared by NuGet Central Package Management for a
 * given project file, by walking up to the nearest Directory.Packages.props.
 *
 * MSBuild imports the first Directory.Packages.props found while walking up from the
 * project directory, and that file is often at the repository root - above the
 * directory cdxgen was invoked with. The walk therefore deliberately continues past
 * the scan root rather than stopping at it.
 *
 * @param {String} projFile Path to a .csproj like project file
 * @param {Object} cache Optional per-scan cache keyed by props file path, so that a
 *        repository with many projects parses each props file once
 *
 * @returns {Object} Map of lowercased package id to version. Empty when the project
 *          does not use central package management.
 */
export declare function getCentralPackageVersions(projFile: string, cache?: Object): Object;
/**
 * Method to find all text nodes in PropertyGroup elements in .props files.
 *
 * @param {String} propsFiles .props files in this project
 *
 * @returns {Object} Containing text nodes from PropertyGroup elements and their values
 */
export declare function getPropertyGroupTextNodes(propsFiles: string): Object;
/**
 * Look up a package version in a name - version map. NuGet package ids are
 * case-insensitive, so a map may be keyed by the id as written or lowercased.
 *
 * @param {Object} versions Map of package id to version
 * @param {string} name Package id
 * @returns {string|undefined} The version, or undefined when the map has none
 */
export declare function lookupNugetVersion(versions: Object, name: string): string | undefined;
/**
 * Method to parse .csproj like xml files
 *
 * A version the project file does not state is taken, in order, from the
 * versions this project restored, from central package management, and last
 * from a version the whole scan agrees on. Two projects of one tree routinely
 * restore different versions of a package, so a version taken from another
 * project would describe a package this project does not use.
 *
 * @param {String} csProjData Raw data
 * @param {String} projFile File name
 * @param {Object} pkgNameVersions Versions this project restored (its project.assets.json,
 *        packages.lock.json or packages.config), keyed by package id or lowercased id
 * @param {Boolean} msbuildInstalled Whether msbuild is available to resolve properties
 * @param {Object} pkgVersionLabelCandidates Candidate values for msbuild version properties,
 *        from the props files that can apply to this project
 * @param {Object} centralVersions Versions declared centrally in Directory.Packages.props,
 *        keyed by lowercased package id. See {@link getCentralPackageVersions}.
 * @param {Object} fallbackVersions Versions every project of the scan agrees on, keyed by
 *        lowercased package id, used only when nothing closer states one
 * @param {Object} restoredNames Package ids as this project's restore output spells them,
 *        keyed by lowercased id. NuGet ids are case-insensitive, so a reference spelled
 *        differently names the same package and takes the restored spelling.
 *
 * @returns {Object} Containing parent component, package, and dependencies
 */
export declare function parseCsProjData(csProjData: string, projFile: string, pkgNameVersions?: Object, msbuildInstalled?: boolean, pkgVersionLabelCandidates?: Object, centralVersions?: Object, fallbackVersions?: Object, restoredNames?: Object): Object;
/**
 * Whether a file of a NuGet package is an assembly a consuming project can
 * reference: a .dll, .exe, or .so under lib/, ref/, or runtimes/.
 *
 * @param {string} packageFile Path of the file inside the package, as project.assets.json lists it
 * @returns {boolean} true for a referenced assembly
 */
export declare function isReferencedDotnetPackageFile(packageFile: string): boolean;
/**
 * Parse a .NET project.assets.json file and return the package list and dependency tree.
 *
 * Extracts NuGet packages and their transitive dependency relationships from the
 * `libraries` and `targets` sections of a project.assets.json file produced by
 * the .NET restore process.
 *
 * @param {string} csProjData Raw JSON string of the project.assets.json file
 * @param {string} assetsJsonFile Path to the project.assets.json file, used for evidence properties
 * @returns {{ pkgList: Object[], dependenciesList: Object[], projectPath: (string|undefined) }}
 *          `projectPath` is the project file the restore output belongs to, as restore recorded it
 */
export declare function parseCsProjAssetsData(csProjData: string, assetsJsonFile: string): {
    pkgList: Object[];
    dependenciesList: Object[];
    projectPath: (string | undefined);
};
/**
 * Parse a .NET packages.lock.json file and return the package list, dependency tree,
 * and list of direct/root dependencies.
 *
 * @param {string} csLockData Raw JSON string of the packages.lock.json file
 * @param {string} pkgLockFile Path to the packages.lock.json file, used for evidence properties
 * @returns {{ pkgList: Object[], dependenciesList: Object[], rootList: Object[] }}
 */
export declare function parseCsPkgLockData(csLockData: string, pkgLockFile: string): {
    pkgList: Object[];
    dependenciesList: Object[];
    rootList: Object[];
};
/**
 * Parse a Paket dependency manager lock file (paket.lock) and return the package list
 * and dependency tree.
 *
 * @param {string} paketLockData Raw text contents of the paket.lock file
 * @param {string} pkgLockFile Path to the paket.lock file, used for evidence properties
 * @returns {{ pkgList: Object[], dependenciesList: Object[] }}
 */
export declare function parsePaketLockData(paketLockData: string, pkgLockFile: string): {
    pkgList: Object[];
    dependenciesList: Object[];
};
//# sourceMappingURL=parsers-dotnet.d.ts.map