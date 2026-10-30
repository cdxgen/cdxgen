export declare function getDirectAiInventoryType(path: any, options: any): string | undefined;
/**
 * Main Node.js/npm BOM generator. Parses manifests, lockfiles, and import
 * evidence to assemble components, dependencies, formulation data, AI inventory,
 * and the parent component for a Node.js project.
 *
 * @param {string} path Path to the project
 * @param {object} options CLI options
 * @returns {Promise<object>} Promise resolving to a BOM namespace data object
 */
export declare function createNodejsBom(path: string, options: object): Promise<object>;
/**
 * Regex matching `.wasm` import paths in analyzer output, including optional
 * query/fragment suffixes.
 *
 * @type {RegExp}
 */
export declare const WASM_IMPORT_PATTERN: RegExp;
/**
 * Adds generic wasm components from discovered source imports.
 *
 * @param {Array<Object>} pkgList Node.js package list
 * @param {Object} allImports analyzer imports map
 * @returns {Array<Object>} pkgList enriched with wasm components
 */
export declare const addWasmComponentsFromImports: (pkgList: Array<Object>, allImports: Object) => Array<Object>;
/**
 * Function to create bom string for caxa SEA binaries
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} Promise resolving to BOM object
 */
export declare function createCaxaBom(path: string, options: Object): Promise<Object>;
/**
 * Function to create BOM for VS Code / IDE extensions.
 * Supports two modes:
 * 1. Directory scan: Discovers `.vsix` files and installed extension directories
 * 2. IDE discovery: Automatically finds extensions installed by known IDEs
 *
 * @param {string} path to the project or directory to scan
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} Promise resolving to BOM object
 */
export declare function createVscodeExtensionBom(path: string, options: Object): Promise<Object>;
/**
 * Create a BOM that catalogs agentic CLI tools installed for the current user
 * (for example Kiro CLI, zcode, opencode, and Claude Code), along with the
 * agents, plugins, and providers they define.
 *
 * The scan is read-only and value-redacting: it records tool versions where a
 * declarative source exists, plus structural counts, but never reads
 * credentials, transcripts, session logs, or telemetry.
 *
 * @param {string} path Positional input. A host scan does not read a project
 *   tree, so an explicit path other than the current directory is rejected
 *   rather than silently ignored.
 * @param {Object} options Parse options from the CLI
 * @returns {Promise<Object>} Promise resolving to BOM data
 */
export declare function createAgenticBom(path: string, options: Object): Promise<Object>;
/**
 * Function to create BOM for Electron ASAR archives.
 *
 * @param {string} path to a single archive or a directory to scan
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} Promise resolving to BOM object
 */
export declare function createAsarBom(path: string, options: Object): Promise<Object>;
/**
 * Function to create BOM for installed Chrome and Chromium-based browser extensions.
 *
 * @param {string} path to the project path or a directly provided extension path
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} Promise resolving to BOM object
 */
export declare function createChromeExtensionBom(path: string, options: Object): Promise<Object>;
/**
 * Analyze an extracted extension directory for bundled dependencies.
 * Looks for npm lock files, node_modules, package.json files, minified JS,
 * and runs the babel-based analyzer on the source.
 *
 * @param {string} extDir Path to the extracted extension directory
 * @param {Object} options CLI options
 * @returns {Promise<{pkgList: Object[], dependencies: Object[]}>}
 */
export declare function analyzeExtensionDir(extDir: string, options: Object): Promise<{
    pkgList: Object[];
    dependencies: Object[];
}>;
/**
 * Run deep analysis on installed extension subdirectories within a parent
 * extensions directory. Each subdirectory represents an installed extension.
 *
 * @param {string} extensionsDir Parent directory containing extension subdirs
 * @param {Object} options CLI options
 * @param {Object[]} pkgList Mutable array to push discovered components into
 * @param {Object[]} dependencies Mutable array to merge dependencies into
 */
export declare function analyzeInstalledExtensionDirs(extensionsDir: string, options: Object, pkgList: Object[], dependencies: Object[]): Promise<void>;
//# sourceMappingURL=jsBom.d.ts.map