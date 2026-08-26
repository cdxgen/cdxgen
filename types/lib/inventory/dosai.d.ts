/**
 * Check whether a language is a .NET language supported by dosai analysis.
 *
 * @param {string} language Project type or language name
 * @returns {boolean} True when the language maps to a supported .NET/dotnet identifier
 */
export declare function isDosaiDotnetLanguage(language: string): boolean;
/**
 * Read and parse a dosai JSON output file.
 *
 * @param {string} jsonFile Path to the dosai JSON file
 * @returns {Object|undefined} Parsed JSON content, or undefined when missing or invalid
 */
export declare function readDosaiJsonFile(jsonFile: string): Object | undefined;
/**
 * Run a dosai subcommand ("methods", "dataflows", or "crypto") against a source
 * tree and write its JSON output to the given file.
 *
 * @param {string} command Dosai subcommand to execute
 * @param {string} src Source directory to analyze
 * @param {string} outputFile Path where the dosai JSON output is written
 * @param {Object} [options] Options carrying dosaiCommand, dataFlowPatterns, or patternPacks overrides
 * @returns {boolean} True when the command succeeded and produced the output file, false otherwise
 */
export declare function runDosaiCommand(command: string, src: string, outputFile: string, options?: Object): boolean;
/**
 * Produce the dosai methods (call graph) slice for a source tree.
 *
 * @param {string} src Source directory to analyze
 * @param {string} outputFile Path where the methods slice JSON is written
 * @param {Object} [options] Options forwarded to runDosaiCommand
 * @returns {boolean} True when the slice was produced successfully
 */
export declare function createDosaiMethodsSlice(src: string, outputFile: string, options?: Object): boolean;
/**
 * Produce the dosai data-flow slice for a source tree.
 *
 * @param {string} src Source directory to analyze
 * @param {string} outputFile Path where the data-flow slice JSON is written
 * @param {Object} [options] Options carrying dataFlowPatterns or patternPacks overrides
 * @returns {boolean} True when the slice was produced successfully
 */
export declare function createDosaiDataFlowSlice(src: string, outputFile: string, options?: Object): boolean;
/**
 * Produce the dosai crypto analysis output for a source tree.
 *
 * @param {string} src Source directory to analyze
 * @param {string} outputFile Path where the crypto analysis JSON is written
 * @param {Object} [options] Options forwarded to runDosaiCommand
 * @returns {boolean} True when the analysis was produced successfully
 */
export declare function createDosaiCryptoAnalysis(src: string, outputFile: string, options?: Object): boolean;
/**
 * Run dosai crypto analysis in a temporary directory and return the parsed result.
 *
 * @param {string} src Source directory to analyze
 * @param {Object} [options] Options forwarded to createDosaiCryptoAnalysis
 * @returns {Object|undefined} Parsed crypto analysis JSON, or undefined when the analysis fails
 */
export declare function analyzeDosaiCrypto(src: string, options?: Object): Object | undefined;
/**
 * Persist the combined native dosai report to options.semanticsSlicesFile.
 *
 * Mirrors the rusi/golem persistence contract (analyzeRusiProject /
 * analyzeGolemProject on branch feat/rusi-persist-report): when a semantics-
 * slices path is provided, the FULL native report is written there and kept so
 * downstream tools (depscan) can consume the complete methods + data-flow
 * facts that cdxgen only projects a subset of into the SBOM evidence. dotnet
 * does not otherwise use the semantics slice (atom is never run for dotnet),
 * so the path is free to carry the combined dosai report. Returns the resolved
 * durable path when something was persisted, otherwise undefined.
 */
export declare function persistDosaiSemanticsReport(options: any, methodsSlice: any, dataFlowSlice: any): any;
/**
 * Build a purl alias map for a list of components.
 *
 * @param {Object[]} [components] Component objects with purl fields
 * @returns {Map<string, string>} Map of exact purls and normalized type/namespace/name keys to canonical purls
 */
export declare function buildPurlAliasMap(components?: Object[]): Map<string, string>;
/**
 * Resolve a possibly-aliased purl to the canonical component purl.
 *
 * @param {string} purl Purl from a dosai report
 * @param {Map<string, string>} purlAliasMap Alias map built by buildPurlAliasMap
 * @returns {string|undefined} Canonical component purl, the input purl when unaliased, or undefined when empty
 */
export declare function resolveComponentPurl(purl: string, purlAliasMap: Map<string, string>): string | undefined;
/**
 * Map a dosai methods slice to per-purl occurrence evidence.
 *
 * Extracts source locations, imported modules, and called methods from the
 * Dependencies and PackageReachability sections of the slice.
 *
 * @param {Object} methodsSlice Parsed dosai methods slice JSON
 * @param {Object[]} [components] BOM components used to resolve purl aliases
 * @returns {Object} Object with purlLocationMap, purlModulesMap, and purlMethodsMap keyed by purl
 */
export declare function collectDosaiPurlEvidence(methodsSlice: Object, components?: Object[]): Object;
/**
 * Extract data-flow call frames per component purl from a dosai data-flow result.
 *
 * Frames are derived from slice and PackageReachability node ids, and grouped
 * under every purl referenced by each flow (source, sink, and intermediate).
 *
 * @param {Object} dataFlowResult Parsed dosai data-flow slice JSON
 * @param {Object[]} [components] BOM components used to resolve purl aliases
 * @returns {Object} Map of canonical purl to arrays of call-stack frame objects
 */
export declare function collectDosaiDataFlowFrames(dataFlowResult: Object, components?: Object[]): Object;
/**
 * Consume dosai's AiComponents[] inventory (schema 4.0.0): model identifiers,
 * on-disk model artifacts with hashes, MCP tools, prompts (redacted), and agents
 * become CycloneDX machine-learning-model / data components with modelCard data.
 *
 * @param {Object} methodsSlice Parsed dosai methods slice JSON
 * @param {Array} [components] Component list to mutate in place
 * @returns {Array} The updated component list
 */
export declare function collectDosaiAiComponents(methodsSlice: Object, components?: any[]): any[];
/**
 * Consume dosai's first-class Services[] inventory (schema 4.0.0) directly: richer
 * than deriving services from ApiEndpoints alone — stable bom-refs, trust zones,
 * data classifications, providers, and per-service evidence occurrences.
 *
 * @param {Object} methodsSlice Parsed dosai methods slice JSON
 * @param {Object} [servicesMap] Map of service key to service definition, mutated in place
 * @returns {Object} The updated services map
 */
export declare function collectDosaiServiceComponents(methodsSlice: Object, servicesMap?: Object): Object;
/**
 * Infer service and endpoint definitions from a dosai methods slice.
 *
 * Sanitizes API endpoint routes, derives stable service names, and records
 * `cdx:dosai:*` properties (http method, auth requirements, claim counts) per
 * service in the supplied map, mutating it in place.
 *
 * @param {Object} methodsSlice Parsed dosai methods slice JSON
 * @param {Object} [servicesMap] Map of service name to service definition, mutated in place
 * @returns {Object} The updated services map
 */
export declare function collectDosaiServicesFromMethods(methodsSlice: Object, servicesMap?: Object): Object;
/**
 * Normalize a services map into a sorted array of CycloneDX service objects.
 *
 * @param {Object} [servicesMap] Map of service name to service definition with Set-backed endpoints
 * @returns {Object[]} Array of service objects with sorted endpoint arrays and properties
 */
export declare function normalizeDosaiServiceMap(servicesMap?: Object): Object[];
//# sourceMappingURL=dosai.d.ts.map