/**
 * Check whether a file name conforms to pylock naming.
 *
 * @param {string} lockFilePath lock file path
 * @returns {boolean} true if this is a pylock file
 */
export declare function isPyLockFile(lockFilePath: string): boolean;
/**
 * Check whether a parsed toml object follows pylock format.
 *
 * @param {object} lockTomlObj parsed toml object
 * @returns {boolean} true if object appears to be pylock data
 */
export declare function isPyLockObject(lockTomlObj: object): boolean;
/**
 * Get package entries from py lock data in a format-agnostic way.
 *
 * @param {object} lockTomlObj parsed toml object
 * @returns {Array<object>} package entries
 */
export declare function getPyLockPackages(lockTomlObj: object): Array<object>;
/**
 * Convert top-level pylock keys to custom cdx properties.
 *
 * @param {object} lockTomlObj parsed toml object
 * @returns {Array<object>} custom properties
 */
export declare function collectPyLockTopLevelProperties(lockTomlObj: object): Array<object>;
/**
 * Convert package-level pylock keys to custom cdx properties.
 *
 * @param {object} pkg pylock package entry
 * @returns {Array<object>} custom properties
 */
export declare function collectPyLockPackageProperties(pkg: object): Array<object>;
/**
 * Build file components from pylock source entries.
 *
 * @param {object} pkg pylock package entry
 * @param {string} lockFile lock file path
 * @returns {Array<object>} file components
 */
export declare function collectPyLockFileComponents(pkg: object, lockFile: string): Array<object>;
/**
 * Check whether index points to the default pypi registry.
 *
 * @param {string} indexUrl index URL from pylock
 * @returns {boolean} true for default pypi
 */
export declare function isDefaultPypiRegistry(indexUrl: string): boolean;
/**
 * Normalize a pylock package index URL for comparison and reporting.
 * Credentials, query and fragment are dropped, so the result is safe to emit.
 *
 * @param {string} indexUrl package index URL
 * @returns {string|undefined} normalized registry URL
 */
export declare function normalizePyLockRegistry(indexUrl: string): string | undefined;
/**
 * Collect dependency names and scopes from a pylock package entry.
 *
 * @param {object} pkg pylock package entry
 * @returns {{ name: string, scope: string }[]} dependency relationships
 */
export declare function collectPyLockDependencyRelationships(pkg: object): {
    name: string;
    scope: string;
}[];
//# sourceMappingURL=pylockutils.d.ts.map