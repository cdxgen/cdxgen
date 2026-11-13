/**
 * Parse a single file and return its imports/exports as isolated objects,
 * without mutating shared state. Intended for parallel execution.
 *
 * @param {string} src Project root
 * @param {string} file Absolute file path
 * @returns {{imports: Object, exports: Object}}
 */
export declare const parseFileASTTreeCollected: (src: string, file: string) => {
    imports: Object;
    exports: Object;
};
/**
 * Capability categories analyzed in Chromium browser-extension sources, such
 * as file access, device access, network, bluetooth, and fingerprinting.
 */
export declare const CHROMIUM_EXTENSION_CAPABILITY_CATEGORIES: string[];
/**
 * Capability categories analyzed in plain JavaScript/TypeScript sources, such
 * as child-process execution, code generation, dynamic fetch, and dynamic import.
 */
export declare const JS_CAPABILITY_CATEGORIES: string[];
/**
 * Babel-parse a JavaScript source and flag suspicious execution, network, and
 * obfuscation indicators such as child-process calls, fetch usage, and long
 * base64 strings.
 *
 * @param {string} source JavaScript source code to analyze.
 * @returns {{executionIndicators: string[], networkIndicators: string[], obfuscationIndicators: string[], indicators: string[]}} Suspicious indicator findings (empty arrays when the source cannot be parsed).
 */
export declare function analyzeSuspiciousJsSource(source: string): {
    executionIndicators: string[];
    networkIndicators: string[];
    obfuscationIndicators: string[];
    indicators: string[];
};
/**
 * Find all imports and exports
 */
export declare const findJSImportsExports: (src: any, deep: any) => Promise<{
    allImports: {};
    allExports: {};
}>;
/**
 * Detect suspicious obfuscation, execution, and network indicators in a single
 * JavaScript/TypeScript source file using Babel AST analysis. A file larger
 * than 4 MiB is not parsed and yields only the `oversized-file` obfuscation
 * indicator.
 *
 * @param {string} filePath Source file path
 * @returns {{executionIndicators: string[], indicators: string[], networkIndicators: string[], obfuscationIndicators: string[]}}
 */
export declare const analyzeSuspiciousJsFile: (filePath: string) => {
    executionIndicators: string[];
    indicators: string[];
    networkIndicators: string[];
    obfuscationIndicators: string[];
};
/**
 * AST-scan JavaScript source for runtime capability usage including child
 * process execution, eval/code generation, dynamic fetch, and dynamic import.
 *
 * @param {string} source JavaScript source code to analyze.
 * @returns {{capabilities: string[], hasDynamicFetch: boolean, hasDynamicImport: boolean, hasEval: boolean, indicatorMap: Object<string, string[]>}} Capability analysis result (empty when the source cannot be parsed).
 */
export declare function analyzeJsCapabilitiesSource(source: string): {
    capabilities: string[];
    hasDynamicFetch: boolean;
    hasDynamicImport: boolean;
    hasEval: boolean;
    indicatorMap: Record<string, string[]>;
};
/**
 * Read a JavaScript/TypeScript file from disk and return its capability
 * analysis, converting it to parseable code first.
 *
 * @param {string} filePath Path to the JS/TS file to analyze.
 * @returns {{capabilities: string[], hasDynamicFetch: boolean, hasDynamicImport: boolean, hasEval: boolean, indicatorMap: Object<string, string[]>}|undefined} Capability analysis result, or undefined when the file cannot be read.
 */
export declare const analyzeJsCapabilitiesFile: (filePath: string) => {
    capabilities: string[];
    hasDynamicFetch: boolean;
    hasDynamicImport: boolean;
    hasEval: boolean;
    indicatorMap: Record<string, string[]>;
} | undefined;
/**
 * AST-scan JavaScript source for cryptographic algorithm and library usage,
 * detecting calls to Node.js `crypto`, WebCrypto, JWT/JOSE libraries, and
 * literal algorithm references.
 *
 * @param {string} source JavaScript source code to analyze.
 * @returns {{algorithms: Object[], libraries: string[]}} Detected crypto algorithms and library names (empty arrays when the source cannot be parsed).
 */
export declare function analyzeJsCryptoSource(source: string): {
    algorithms: Object[];
    libraries: string[];
};
/**
 * Read a JavaScript/TypeScript file from disk and return detected
 * cryptographic algorithms and libraries.
 *
 * @param {string} filePath Path to the JS/TS file to analyze.
 * @returns {{algorithms: Object[], libraries: string[]}|undefined} Crypto analysis result, or undefined when the file cannot be read.
 */
export declare const analyzeJsCryptoFile: (filePath: string) => {
    algorithms: Object[];
    libraries: string[];
} | undefined;
/**
 * Walk a source tree aggregating cryptographic inventory (algorithms and
 * libraries) across all JavaScript/TypeScript files found.
 *
 * @param {string} src Path to the source directory to scan.
 * @param {boolean} [deep=false] When true, includes node_modules and nested directories.
 * @returns {Promise<{algorithms: Object[], libraries: string[]}>} Aggregated crypto inventory (empty arrays when no files are found).
 */
export declare const detectJsCryptoInventory: (src: string, deep?: boolean) => Promise<{
    algorithms: Object[];
    libraries: string[];
}>;
/**
 * Detect browser-extension capability signals from source code using Babel AST analysis.
 *
 * @param {string} src Path to the extension source directory
 * @param {boolean} deep When true, includes node_modules and nested directories
 * @returns {{capabilities: string[], indicators: Object<string, string[]>}}
 * `indicators` is keyed by capability category name and contains arrays of
 * detected signal strings (for example property chains and call names).
 */
export declare const detectExtensionCapabilities: (src: string, deep?: boolean) => {
    capabilities: string[];
    indicators: Record<string, string[]>;
};
/**
 * Detect MCP server inventory from Python source using import and decorator heuristics.
 *
 * @param {string} src Absolute or relative path to the project source directory
 * @param {boolean} deep When true, also scans nested paths more aggressively
 * @returns {{components: Object[], dependencies: Object[], services: Object[]}}
 */
export declare const detectPythonMcpInventory: (src: string, deep?: boolean) => {
    components: Object[];
    dependencies: Object[];
    services: Object[];
};
/**
 * Detect MCP server inventory from JavaScript/TypeScript source using AST analysis.
 *
 * @param {string} src Absolute or relative path to the project source directory
 * @param {boolean} deep When true, also scans nested paths more aggressively
 * @returns {{components: Object[], dependencies: Object[], services: Object[]}}
 */
export declare const detectMcpInventory: (src: string, deep?: boolean) => {
    components: Object[];
    dependencies: Object[];
    services: Object[];
};
//# sourceMappingURL=analyzer.d.ts.map