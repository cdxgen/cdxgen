export { summarizeAiInventory } from "../inventory/aiInventory.js";
export { createAndroidBom, createBinaryBom, dedupeBom, listComponents, } from "./bomAssembly.js";
export { createAsarBom, createCaxaBom, createChromeExtensionBom, createNodejsBom, createVscodeExtensionBom, } from "./jsBom.js";
export { createJarBom, createJavaBom } from "./jvmBom.js";
export { createCloudBuildBom, createCryptoCertsBom, createCsharpBom, createGitHubBom, createHelmBom, createJenkinsBom, createPerlBom, createPHPBom, createPixiBom, createPythonBom, createRBom, createRubyBom, createTerraformBom, } from "./managedBom.js";
export { createClojureBom, createCocoaBom, createCppBom, createCrystalBom, createDartBom, createElixirBom, createElmBom, createErlangBom, createGleamBom, createGoBom, createHaskellBom, createJuliaBom, createLuaBom, createNimBom, createNixBom, createOCamlBom, createRustBom, createSpackBom, createSwiftBom, createZigBom, } from "./nativeBom.js";
/**
 * Function to create obom string for the current OS using osquery
 *
 * @param {string} _path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} Promise resolving to BOM object
 */
export declare function createOSBom(_path: string, options: Object): Promise<Object>;
/**
 * Function to create bom string for docker compose
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} Promise resolving to BOM object
 */
export declare function createContainerSpecLikeBom(path: string, options: Object): Promise<Object>;
/**
 * Function to create bom string for all languages
 *
 * @param {string[]} pathList list of to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} Promise resolving to BOM object
 */
/**
 * Join non-zero counts into a phase summary.
 *
 * Each entry carries its own plural form rather than having one appended, so
 * nouns like "shared library" read correctly.
 *
 * @param {Array<[number, string, string]>} entries Count, singular, and plural
 * @returns {string} Summary such as "412 OS packages, 3 services"
 */
export declare function summarizeCounts(entries: Array<[number, string, string]>): string;
/**
 * Summarize components by purl type, so a scan reports "412 npm, 88 pypi"
 * rather than an anonymous total.
 *
 * @param {object[]} components Components carrying purls
 * @returns {string} Comma-separated counts, busiest type first
 */
export declare function summarizePurlTypes(components: object[]): string;
/**
 * Generates BOMs across multiple project types and/or paths, then merges and
 * deduplicates the results into a single BOM namespace data object. Handles
 * OCI/container inventory, per-path scans, formulation accumulation, and
 * parent-component reconciliation.
 *
 * @param {string|string[]} pathList Comma-separated string or array of paths
 * @param {object} options CLI options
 * @returns {Promise<object>} Promise resolving to a deduplicated BOM namespace
 *   data object (components, dependencies, bomJson, parentComponent, etc.)
 */
export declare function createMultiXBom(pathList: string | string[], options: object): Promise<object>;
/**
 * Function to create a dynamic SBOM by executing a command and tracing the
 * shared libraries it loads at runtime via instrumentation.
 *
 * Components receive scope=required, evidence.identity[].methods[].technique=
 * instrumentation, and confidence 0.8 (version known) or 0.5 (version unknown).
 *
 * @param {string} path - Target path (used as working directory fallback)
 * @param {Object} options - CLI options; must include options.traceCmd
 * @returns {Promise<Object>} Promise resolving to BOM data object
 */
export declare function createDynamicBom(path: string, options: Object): Promise<Object>;
/**
 * Remove the temporary directory an image or archive export created
 * (`docker-images-*` under the temporary directory), with every layer in it.
 * The sub-paths the multi-type scan removes are only part of it, and a
 * 1.5 GB image export used to stay behind for every scan. A directory the
 * user named, such as an OCI directory scanned in place, is never removed,
 * and debug mode keeps the export for inspection.
 *
 * @param {Object|undefined} exportData result of exportImage or exportArchive
 */
export declare function removeImageExport(exportData: Object | undefined): void;
/**
 * Function to create bom string for various languages
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object|undefined>} Promise resolving to BOM object, or undefined if path is not readable
 */
export declare function createXBom(path: string, options: Object): Promise<Object | undefined>;
/**
 * Function to create a hardware BOM for the current host.
 *
 * @param {string} _path Source path (unused for live host HBOM generation)
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} Promise resolving to BOM object
 */
export declare function createHBom(_path: string, options: Object): Promise<Object>;
/**
 * Function to create bom string for various languages
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} Promise resolving to BOM object
 */
/**
 * Generate a BOM for one path, letting a deferred fail-on-error abort return
 * the empty BOM the flag promises rather than unwinding past the reports.
 *
 * @param {string} path Source path.
 * @param {Object} options CLI options.
 * @returns {Promise<Object>} BOM NS data.
 */
export declare function createBom(path: string, options: Object): Promise<Object>;
/**
 * Method to submit the generated bom to dependency-track or cyclonedx server
 *
 * @param {Object} args CLI args
 * @param {Object} bomContents BOM Json
 * @return {Promise<{ token: string } | undefined>} a promise with a token (if request was successful) or undefined (in case of invalid arguments)
 * @throws {Error} if the request fails
 */
export declare function submitBom(args: Object, bomContents: Object): Promise<{
    token: string;
} | undefined>;
//# sourceMappingURL=index.d.ts.map