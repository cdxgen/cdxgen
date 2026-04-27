/**
 * Check whether a file name conforms to pylock naming.
 *
 * @param {string} lockFilePath lock file path
 * @returns {boolean} true if this is a pylock file
 */
export function isPyLockFile(lockFilePath: string): boolean;
/**
 * Check whether a parsed toml object follows pylock format.
 *
 * @param {object} lockTomlObj parsed toml object
 * @returns {boolean} true if object appears to be pylock data
 */
export function isPyLockObject(lockTomlObj: object): boolean;
/**
 * Get package entries from py lock data in a format-agnostic way.
 *
 * @param {object} lockTomlObj parsed toml object
 * @returns {Array<object>} package entries
 */
export function getPyLockPackages(lockTomlObj: object): Array<object>;
/**
 * Convert top-level pylock keys to custom cdx properties.
 *
 * @param {object} lockTomlObj parsed toml object
 * @returns {Array<object>} custom properties
 */
export function collectPyLockTopLevelProperties(lockTomlObj: object): Array<object>;
/**
 * Convert package-level pylock keys to custom cdx properties.
 *
 * @param {object} pkg pylock package entry
 * @returns {Array<object>} custom properties
 */
export function collectPyLockPackageProperties(pkg: object): Array<object>;
/**
 * Build file components from pylock source entries.
 *
 * @param {object} pkg pylock package entry
 * @param {string} lockFile lock file path
 * @returns {Array<object>} file components
 */
export function collectPyLockFileComponents(pkg: object, lockFile: string): Array<object>;
/**
 * Check whether index points to the default pypi registry.
 *
 * @param {string} indexUrl index URL from pylock
 * @returns {boolean} true for default pypi
 */
export function isDefaultPypiRegistry(indexUrl: string): boolean;
//# sourceMappingURL=pylockutils.d.ts.map