/**
 * Full npm package name (`@scope/name` or `name`) of a component or manifest.
 *
 * @param {{group?: string, name?: string}} pkg Component or parsed manifest
 * @returns {string} The package name npm installs it under
 */
export declare function npmPackageName({ group, name }: {
    group?: string;
    name?: string;
}): string;
/**
 * Full npm package name of an npm purl.
 *
 * @param {string} purl Package URL
 * @returns {string|undefined} `@scope/name` or `name`; undefined for a purl that is not npm or does not parse
 */
export declare function npmPackageNameOfPurl(purl: string): string | undefined;
/**
 * Directory a package-lock component is installed in.
 *
 * `internal:LocalNodeModulesPath` holds the arborist location, relative to the
 * root of the tree: `node_modules/a/node_modules/b` for a nested copy and
 * `packages/web/node_modules/b` for a copy under a workspace member. The
 * component's `internal:SrcFile` names a `package-lock.json` in the directory
 * that holds the location's first `node_modules` segment, so the install
 * directory is that location's `node_modules/...` part resolved against the
 * SrcFile's directory. A location without a `node_modules` segment (a
 * workspace member itself) and an absolute location (pnpm metadata found by
 * searching node_modules) name no install a file resolves to.
 *
 * @param {Object} pkg Package component
 * @returns {string|undefined} Absolute install directory
 */
export declare function npmInstallDirectory(pkg: Object): string | undefined;
/**
 * References the given root components depend on directly.
 *
 * @param {Array<{ref: string, dependsOn?: string[]}>} dependencies Dependency tree
 * @param {Iterable<string>} rootRefs bom-refs of the project and its workspace members
 * @returns {Set<string>} bom-refs of their direct dependencies
 */
export declare function directDependencyRefs(dependencies: Array<{
    ref: string;
    dependsOn?: string[];
}>, rootRefs: Iterable<string>): Set<string>;
/**
 * The direct dependencies that apply to a project file, nearest first.
 *
 * A file inside an npm workspace member (a component with
 * `cdx:npm:isWorkspace=true` and its directory in `cdx:npm:resolvedPath`,
 * relative to the project) depends first on what that member declares, then
 * on what the project root declares, since Node.js finds the root's hoisted
 * copies from inside a member too. Any other file depends on the root's.
 *
 * @param {Object[]} components Components or package list
 * @param {Object[]} dependencies Dependency tree
 * @param {string[]} rootRefs bom-refs of the project and the sub-components it lists
 * @returns {function(string): Set<string>[]} Lookup from a file name, relative to the project, to sets of bom-refs
 */
export declare function createDirectDependencyLookup(components: Object[], dependencies: Object[], rootRefs: string[]): Function;
/**
 * bom-refs of a parent component and the sub-components it lists, which are
 * the roots whose direct dependencies a project's own files use.
 *
 * @param {Object} parentComponent Parent (metadata) component
 * @returns {string[]} bom-refs
 */
export declare function projectRootRefs(parentComponent: Object): string[];
/**
 * Decide which installed versions of an npm package a project file uses.
 *
 * Only package names with more than one version in `pkgList` are decided; a
 * file uses the single version of any other package. For the rest, the file
 * uses:
 *
 * 1. the copy Node.js resolves from the file's directory, when the lock file
 *    records install locations (package-lock.json): the first
 *    `<dir>/node_modules/<name>` holding one of the versions, walking up from
 *    the file;
 * 2. otherwise the versions the file's workspace member, or else the project,
 *    depends on directly (see `createDirectDependencyLookup`);
 * 3. otherwise every version, since nothing tells them apart.
 *
 * @param {Object[]} pkgList Package components, duplicates per install location included
 * @param {Object} [context] Project facts
 * @param {string} [context.srcDir] Directory the file names are relative to
 * @param {Object[]} [context.dependencies] Dependency tree
 * @param {string[]} [context.rootRefs] bom-refs of the project and the sub-components it lists
 * @returns {{isAmbiguous: function(Object): boolean, allows: function(Object, string): boolean}} Chooser
 */
export declare function createNpmVersionChooser(pkgList: Object[], context?: {
    srcDir?: string;
    dependencies?: Object[];
    rootRefs?: string[];
}): {
    isAmbiguous: Function;
    (Object: any): boolean;
    allows: Function;
    (Object: any, string: any): boolean;
};
/**
 * Keep each npm occurrence only on the versions the project file uses.
 *
 * evinse credits a slice record to every component of the record's package,
 * one per installed version. For a package with several versions in the BOM,
 * an occurrence in file F stays on a version when the input BOM's own import
 * evidence (seeded before any slice is read) puts that version in F; when the
 * BOM credits none of the versions in F, or several, the versions F's
 * workspace member or else the project depends on directly are kept (see
 * `createDirectDependencyLookup`); failing both, all stay.
 *
 * @param {Object} purlLocationMap purl -> Set of occurrence keys, changed in place
 * @param {Object} purlSymbolMap purl -> occurrence key -> symbol, changed in place
 * @param {Object} seededLocationMap purl -> Set of occurrence keys the input BOM carried
 * @param {Object} bomJson Input BOM, for its components, dependencies and metadata component
 * @returns {Set<string>} purls left with no occurrence, whose input occurrences belong to another version
 */
export declare function keepResolvedNpmVersions(purlLocationMap: Object, purlSymbolMap: Object, seededLocationMap: Object, bomJson: Object): Set<string>;
//# sourceMappingURL=npmVersionResolution.d.ts.map