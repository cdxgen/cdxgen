/**
 * Custom lightweight replacement for the bin-links getPaths function.
 * Calculates all possible symbolic links or shims that would be created.
 *
 * @param {Object} options Options object
 * @param {string} options.path Path to the package directory
 * @param {Object} options.pkg The parsed package.json object
 * @param {boolean} [options.global] Whether this is a global install
 * @param {boolean} [options.top] Whether this is the top-level package being installed
 * @returns {string[]} An array of potential link target file paths
 */
export default function getPaths({ path, pkg, global, top }: {
    path: string;
    pkg: Object;
    global?: boolean | undefined;
    top?: boolean | undefined;
}): string[];
//# sourceMappingURL=bin-links.d.ts.map