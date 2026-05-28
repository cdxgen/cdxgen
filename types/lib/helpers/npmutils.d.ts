/**
 * Marks an npm component as development-only.
 *
 * @param {object} pkg Component object to annotate
 * @returns {void}
 */
export function setNpmDevelopmentProperty(pkg: object): void;
/**
 * Marks an npm component as optional.
 *
 * @param {object} pkg Component object to annotate
 * @returns {void}
 */
export function setNpmOptionalProperty(pkg: object): void;
/**
 * Marks an npm component as a peer dependency.
 *
 * @param {object} pkg Component object to annotate
 * @returns {void}
 */
export function setNpmPeerProperty(pkg: object): void;
/**
 * Helper function to create a properly encoded workspace PURL
 *
 * @param {string} packageName - Package name (e.g., "@babel/core")
 * @param {string} version - Package version
 * @returns {string} Encoded PURL string
 */
export function createNpmWorkspacePurl(packageName: string, version: string): string;
/**
 * Finds a matching npm workspace PURL for the supplied package name.
 *
 * @param {string[] | undefined} workspacePackages Array of workspace package PURLs
 * @param {string} packageName Package name to match against
 * @returns {string | undefined} Matching workspace package PURL, if any
 */
export function findMatchingNpmWorkspace(workspacePackages: string[] | undefined, packageName: string): string | undefined;
/**
 * Classifies an npm dependency specifier by source type.
 *
 * @param {string | undefined | null} spec npm dependency specifier
 * @returns {{ type: string, value: string } | undefined} Classified manifest source, if supported
 */
export function classifyNpmManifestSource(spec: string | undefined | null): {
    type: string;
    value: string;
} | undefined;
/**
 * Collects unique manifest-declared npm dependency sources from incoming edges.
 *
 * @param {object} node Arborist node
 * @returns {{ type: string, value: string }[]} Unique manifest source entries
 */
export function collectNpmManifestSources(node: object): {
    type: string;
    value: string;
}[];
/**
 * Hydrates sparse npm package metadata from the installed package.json in deep mode.
 * Existing metadata on the Arborist node wins over on-disk values.
 *
 * @param {object} node Arborist node
 * @param {object} [options={}] CLI options
 * @returns {{ nodePackage: object, diskPkg: object | undefined, packageJsonPath: string | undefined }} Hydrated package metadata and the source package.json context
 */
export function hydrateNpmNodePackage(node: object, options?: object): {
    nodePackage: object;
    diskPkg: object | undefined;
    packageJsonPath: string | undefined;
};
/**
 * Helper to check if a package is imported only for TypeScript types.
 */
export function isPkgTypeOnlyImport(allImports: any, group: any, name: any): boolean;
//# sourceMappingURL=npmutils.d.ts.map