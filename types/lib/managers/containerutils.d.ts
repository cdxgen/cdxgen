/**
 * Method to get all dirs matching a name
 *
 * @param {string} dirPath Root directory for search
 * @param {string} dirName Directory name
 * @param {boolean} hidden Include hidden directories and files. Default: false
 * @param {boolean} recurse Recurse. Default: false
 */
export declare const getDirs: (dirPath: string, dirName: string, hidden?: boolean, recurse?: boolean) => string[];
/**
 * Recursively walk `srcpath` and return all subdirectory paths whose basename
 * matches `dirName` (the root path is included when it matches). The walk does
 * not descend into a match: every returned directory is scanned recursively,
 * so a match nested inside another one would only repeat that scan.
 *
 * @param {string} srcpath Root directory to start the walk from.
 * @param {string} dirName Basename that a directory must end with to be kept.
 * @returns {string[]} Matching directory paths.
 */
export declare const getOnlyDirs: (srcpath: string, dirName: string) => string[];
/**
 * Walk a directory tree once and collect all subdirectories whose basename
 * matches any of the target names. Returns a map from name to array of paths.
 * A directory that lies inside a match of the same name is not collected:
 * every returned directory is scanned recursively, so a nested match would
 * only repeat that scan.
 *
 * Replaces multiple {@link getOnlyDirs} calls that each walk the same tree.
 *
 * @param {string} srcpath Root directory for search
 * @param {string[]} dirNames Target directory names to collect
 * @returns {Record<string, string[]>} Map of dirName to matching paths
 */
export declare const getOnlyDirsMulti: (srcpath: string, dirNames: string[]) => Record<string, string[]>;
//# sourceMappingURL=containerutils.d.ts.map