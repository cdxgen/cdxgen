/**
 * Reset all OS package resolver caches. Exported for unit tests only.
 */
export declare function _resetOsInfoCache(): void;
/**
 * Resolves a file path to its owning OS package manager package, including a
 * correctly computed purl with distro qualifiers derived from /etc/os-release.
 *
 * @param {string} filePath - Absolute path to the library file
 * @returns {{ name: string, version: string, arch: string, type: string, epoch?: string, purl: string } | undefined}
 */
export declare function resolvePackageForFile(filePath: string): {
    name: string;
    version: string;
    arch: string;
    type: string;
    epoch?: string;
    purl: string;
} | undefined;
/**
 * Find the OS package component that provides a given file, by searching the
 * `internal:PkgProvides` property of each package in the OS package list.
 *
 * @param {string} afile Filename or path to look up (matched case-insensitively)
 * @param {Object[]} osPkgsList Array of OS package component objects to search
 * @returns {Object|undefined} The matching OS package component, or undefined if not found
 */
export declare function getOSPackageForFile(afile: string, osPkgsList: Object[]): Object | undefined;
/**
 * Collect all executable files from the given list of binary paths
 *
 * @param basePath Base directory
 * @param binPaths {Array[String]} Paths containing potential binaries
 * @param excludePaths {Array[String]} Container-relative paths that should be excluded from the result set
 * @return {Array[String]} List of executables
 */
export declare function collectExecutables(basePath: any, binPaths: any, excludePaths?: any): any;
/**
 * Collect all shared library files from the given list of paths
 *
 * @param basePath Base directory
 * @param libPaths {Array[String]} Paths containing potential libraries
 * @param ldConf {String} Config file used by ldconfig to locate additional paths
 * @param ldConfDirPattern {String} Config directory that can contain more .conf files for ldconfig
 * @param excludePaths {Array[String]} Container-relative paths that should be excluded from the result set
 * @param extraLibGlobs {Array[String]} Extra container-relative globs for files
 *   the default paths miss, such as libphp*.so under Apache's modules
 *   directory. The existing globs are unchanged; this adds candidates only.
 *
 * @return {Array[String]} List of executables
 */
export declare function collectSharedLibs(basePath: any, libPaths: any, ldConf: string, ldConfDirPattern: string, excludePaths?: any, extraLibGlobs?: any): any;
/**
 * The most native extension candidates one scan returns.
 *
 * @type {number}
 */
export declare const MAX_NATIVE_EXTENSIONS: number;
/**
 * Collect native extension modules under a root file system that the library
 * collector does not see, leaving out paths a package database owns and paths
 * already collected. Symlinks are not followed, so a link pointing out of the
 * root is never listed.
 *
 * @param {string} basePath extracted root file system
 * @param {string[]} [excludePaths] root-relative paths to leave out
 * @returns {string[]} root-relative paths, sorted, capped at MAX_NATIVE_EXTENSIONS
 */
export declare function collectNativeExtensions(basePath: string, excludePaths?: string[]): string[];
/**
 * Mark language packages that an OS package installed. Alpine's py3-brotli
 * ships a Brotli-1.1.0.dist-info that a Python scan reports as
 * pkg:pypi/brotli@1.1.0, but a distro fixes it by backporting under the same
 * upstream version, so a PyPI advisory range keeps matching after the fix. The
 * `cdx:os:installedBy` property names the OS package that owns the
 * installation record, so a consumer can judge the component by that package
 * instead.
 *
 * A component is marked only when every installation record it was read from
 * belongs to an OS package: a copy that pip put in a virtual environment
 * beside the distro's is not the distro's to fix. Run it after duplicates
 * merge, so that a merged component carries all of its records.
 *
 * @param {Object[]} components BOM components, mutated in place
 * @param {Map<string, string>|undefined} ownerByPath root-relative file path to
 *   owning OS package bom-ref
 * @param {string} [rootDir] extracted root, stripped from absolute source paths
 * @returns {number} how many components were marked
 */
export declare function markOsInstalledLanguagePackages(components: Object[], ownerByPath: Map<string, string> | undefined, rootDir?: string): number;
//# sourceMappingURL=osPackageResolver.d.ts.map