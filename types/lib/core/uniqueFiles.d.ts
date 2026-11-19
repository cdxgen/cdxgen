/**
 * Keep one path for every file among the matched paths.
 *
 * The scanned tree can hold any number of symbolic and hard links to one file,
 * each under a name the discovery patterns match. Reading once per path would
 * let the number of links multiply the work and the size of the BOM, so each
 * file is read once. A path that is not a symbolic link is preferred, so that
 * the result is recorded under the name of the file itself.
 *
 * @param {string[]} files Matched file paths
 * @returns {string[]} One path per file, in the order the files were first seen
 */
export declare function uniqueFiles(files: string[]): string[];
//# sourceMappingURL=uniqueFiles.d.ts.map