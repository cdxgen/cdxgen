/**
 * IDE configuration entries describing where each IDE stores its extensions.
 * Each entry contains the IDE name and an array of candidate extension
 * directory paths for Windows, macOS, and Linux (including remote/server
 * environments).
 *
 * The paths use platform-specific logic via `homedir()` and common
 * environment variables.
 */
export function getIdeExtensionDirs(): {
    name: string;
    dirs: any[];
}[];
/**
 * Discover all existing IDE extension directories on the current system.
 *
 * @returns {Array<{name: string, dir: string}>} Array of objects with IDE name
 *   and the existing directory path.
 */
export function discoverIdeExtensionDirs(): Array<{
    name: string;
    dir: string;
}>;
/**
 * Parse a `.vsixmanifest` XML string and extract extension metadata.
 *
 * @param {string} manifestData Raw XML content of a `.vsixmanifest` file
 * @returns {Object|undefined} Object with { publisher, name, version, displayName, description, platform } or undefined on failure
 */
export function parseVsixManifest(manifestData: string): Object | undefined;
/**
 * Parse a VS Code extension's `package.json` and extract metadata.
 *
 * @param {string|Object} packageJsonData Either raw JSON string or parsed object
 * @param {string} [srcPath] Optional path to the source directory for evidence
 * @returns {Object|undefined} Object with { publisher, name, version, displayName, description, platform } or undefined
 */
export function parseVsixPackageJson(packageJsonData: string | Object, srcPath?: string): Object | undefined;
/**
 * Convert parsed extension metadata into a CycloneDX component object.
 *
 * @param {Object} extInfo Object with { publisher, name, version, displayName, description, platform, srcPath }
 * @param {string} [ideName] Optional IDE name for properties
 * @returns {Object|undefined} CycloneDX component object or undefined
 */
export function toComponent(extInfo: Object, ideName?: string): Object | undefined;
/**
 * Parse a `.vsix` file (ZIP archive) and extract the extension metadata.
 *
 * @param {string} vsixFile Absolute path to the `.vsix` file
 * @returns {Promise<Object|undefined>} CycloneDX component object or undefined
 */
export function parseVsixFile(vsixFile: string): Promise<Object | undefined>;
/**
 * Parse a single installed extension directory (already extracted).
 * Looks for `package.json` (preferred) and `.vsixmanifest`.
 *
 * @param {string} extDir Absolute path to the extension directory (e.g. `~/.vscode/extensions/ms-python.python-2023.1.0`)
 * @param {string} [ideName] Optional IDE name
 * @returns {Object|undefined} CycloneDX component object or undefined
 */
export function parseInstalledExtensionDir(extDir: string, ideName?: string): Object | undefined;
/**
 * Attempt to extract extension metadata from a directory name following the
 * pattern `publisher.name-version`.
 *
 * @param {string} extDir Absolute path to extension directory
 * @param {string} [ideName] IDE name
 * @returns {Object|undefined} CycloneDX component or undefined
 */
export function parseExtensionDirName(extDir: string, ideName?: string): Object | undefined;
/**
 * Collect all installed extensions from a set of IDE extension directories.
 *
 * @param {Array<{name: string, dir: string}>} ideDirs Array of { name, dir } from discoverIdeExtensionDirs
 * @returns {Object[]} Array of CycloneDX component objects
 */
export function collectInstalledExtensions(ideDirs: Array<{
    name: string;
    dir: string;
}>): Object[];
/**
 * The purl type for VS Code extensions as defined by the packageurl spec.
 */
export const VSCODE_EXTENSION_PURL_TYPE: "vscode-extension";
//# sourceMappingURL=vsixutils.d.ts.map