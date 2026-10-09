/**
 * Code a project carries inside its own tree under a license of its own: a
 * copied library, an imported test suite. Such a directory holds its own
 * license file, and the license differs from the project's.
 *
 * Layer 3: reads license files under the scan root.
 */
/**
 * Whether a file name is a license file: `LICENSE`, `LICENCE` or `COPYING`,
 * bare, with a text extension, or with a suffix naming the license
 * (`LICENSE-MIT`).
 *
 * @param {string} name File name
 * @returns {boolean}
 */
export declare function isLicenseFileName(name: string): boolean;
/**
 * Find the directories of a project that carry code under a license other
 * than the project's.
 *
 * @param {string} root Project scan root
 * @param {Object} options CLI options (exclusions)
 * @param {string[]} [excludeDirs] Directories already known to hold
 *   dependencies (submodules, fetched sources, build trees), not searched
 * @returns {{components: Object[], dirs: string[]}} A component per vendored
 *   directory, and the directories
 */
export declare function findVendoredCode(root: string, options?: Object, excludeDirs?: string[]): {
    components: Object[];
    dirs: string[];
};
//# sourceMappingURL=vendoredCode.d.ts.map