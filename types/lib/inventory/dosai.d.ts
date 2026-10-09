/**
 * Translate cdxgen --exclude globs into dosai --exclude globs.
 *
 * Dosai is an evidence analyzer, so the translation follows the exclude
 * filter cdxgen already applies to atom evidence slices
 * (`globPatternsToAtomIgnoreRegex`): a relative pattern matches at any depth,
 * and an absolute pattern is anchored to the scanned directory. Dosai itself
 * uses gitignore conventions, where a pattern with a slash is anchored, so
 * relative patterns get a leading "**\/". Like the atom filter, and unlike
 * cdxgen's file discovery, excluding a directory also excludes everything
 * beneath it.
 *
 * Brace groups and numeric ranges are expanded, and comma separated lists are
 * split, since dosai reads both as literal text. Character classes, extglobs,
 * escapes, negation, and patterns that step outside the scanned directory
 * have no dosai equivalent; they are reported as skipped rather than passed
 * on as literals that match nothing. So is any pattern that still carries a
 * character outside a small allowlist, such as a literal brace group or a
 * shell metacharacter. Dosai matches case-sensitively on Linux.
 *
 * @param {string[]} excludes cdxgen exclude globs
 * @param {string} srcPath Absolute directory dosai scans
 * @returns {{patterns: string[], skipped: string[], truncated: number}} Translated patterns, dropped patterns, and how many were left out by the cap
 */
export declare function toDosaiExcludePatterns(excludes: string[], srcPath: string): {
    patterns: string[];
    skipped: string[];
    truncated: number;
};
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
 * Read a dosai methods report of any size.
 *
 * A report that fits in one JavaScript string is parsed whole. A larger one is
 * read in bounded runs, keeping the requested sections, the CallGraph nodes and
 * edges that PackageReachability references, and the MethodCalls accepted by
 * `keepMethodCall` (none when it is omitted). Nothing cdxgen reads is lost.
 *
 * @param {string} reportFile Path to the dosai methods JSON
 * @param {Object} [options] Options
 * @param {string[]} [options.sections] Sections to keep from a large report (default: every section cdxgen reads)
 * @param {Function} [options.keepMethodCall] Predicate choosing the MethodCalls to keep from a large report
 * @param {number} [options.maxTextBytes] Largest report parsed whole, for tests
 * @returns {Object|undefined} Parsed report, or undefined when missing or invalid
 */
export declare function readDosaiMethodsReport(reportFile: string, options?: {
    sections?: string[];
    keepMethodCall?: Function;
    maxTextBytes?: number;
}): Object | undefined;
/**
 * Read a dosai data-flow report of any size.
 *
 * A report that fits in one JavaScript string is parsed whole. A larger one
 * keeps Metadata, Slices, PackageReachability, and the Nodes those reference.
 *
 * @param {string} reportFile Path to the dosai data-flow JSON
 * @param {Object} [options] Options
 * @param {number} [options.maxTextBytes] Largest report parsed whole, for tests
 * @returns {Object|undefined} Parsed report, or undefined when missing or invalid
 */
export declare function readDosaiDataFlowReport(reportFile: string, options?: {
    maxTextBytes?: number;
}): Object | undefined;
/**
 * Whether a dosai run ended because it ran out of time.
 *
 * dosai has no limit of its own: cdxgen's spawn timeout
 * (CDXGEN_TIMEOUT_MS) stops the process, which reaches the caller only as an
 * ETIMEDOUT error looking like any other failure (issue 4438).
 *
 * @param {Object} result spawnSync result
 * @returns {boolean} true when the run was stopped by the spawn timeout
 */
export declare function dosaiRunTimedOut(result: Object): boolean;
/**
 * How a dosai run was stopped before it could finish, if it was.
 *
 * Besides the spawn timeout, a run is stopped when its console output outgrows
 * CDXGEN_MAX_BUFFER (ENOBUFS) or a signal ends it, such as the kernel's
 * out-of-memory killer. A stopped run can leave its slice half written.
 *
 * @param {Object} result spawnSync result
 * @returns {"timeout"|"buffer"|"signal"|undefined} Why the run was stopped, or undefined when it ended by itself
 */
export declare function dosaiRunStopReason(result: Object): "timeout" | "buffer" | "signal" | undefined;
/**
 * Whether the dosai run that should have written a file was stopped (by the
 * time limit, the output buffer limit, or a signal) and already reported so.
 *
 * @param {string} outputFile Output file passed to the dosai run
 * @returns {boolean} true when the run was stopped
 */
export declare function dosaiRunWasStopped(outputFile: string): boolean;
/**
 * Run a dosai subcommand ("methods", "dataflows", or "crypto") against a source
 * tree and write its JSON output to the given file.
 *
 * @param {string} command Dosai subcommand to execute
 * @param {string} src Source directory to analyze
 * @param {string} outputFile Path where the dosai JSON output is written
 * @param {Object} [options] Options carrying dosaiCommand, dataFlowPatterns, patternPacks, or exclude globs
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
 * @param {Object} [options] Options passed to {@link buildDosaiPurlAliasMap} (`srcPath`)
 * @returns {Map<string, string>} Map of component purls, carrying the version-free identity index
 */
export declare function buildPurlAliasMap(components?: Object[], options?: Object): Map<string, string>;
/**
 * Resolve a dosai purl to the canonical component purl, by version, and for a
 * package the BOM holds in several versions by the record's location.
 *
 * @param {string} purl Purl from a dosai report
 * @param {Map<string, string>} purlAliasMap Alias map built by buildPurlAliasMap
 * @param {string} [location] Source location of the dosai record
 * @returns {string|undefined} Canonical component purl, the input purl when the BOM has no such package,
 *          or undefined when empty or ambiguous
 */
export declare function resolveComponentPurl(purl: string, purlAliasMap: Map<string, string>, location?: string): string | undefined;
/**
 * Copy one dosai PackageReachability fact onto a component as properties.
 *
 * The occurrence/location consumers of PackageReachability read SourceLocations, EdgeIds,
 * and NodeIds only, so dosai's Confidence, EvidenceKinds, ReachabilityKind, and
 * ConfidenceReasons never reached the BOM: an unbuilt tree (Low confidence, unresolved
 * evidence) was indistinguishable from a package that really is only imported. These
 * properties carry that distinction to BOM consumers. They use the consumer-facing
 * `cdx:dosai:reachability:*` namespace - not `internal:`, which is cdxgen's private
 * bookkeeping namespace stripped or ignored by downstream tooling.
 *
 * @param {Object} component BOM component object (mutated; properties created on demand)
 * @param {Object} reachability dosai PackageReachability entry
 */
export declare function addDosaiReachabilityProperties(component: Object, reachability: Object): void;
/**
 * Attach dosai PackageReachability confidence facts to matching BOM components.
 *
 * @param {Object} methodsSlice Parsed dosai methods slice JSON
 * @param {Object[]} [components] BOM components used to resolve purl aliases and mutate
 * @param {Object} [options] Options
 * @param {string} [options.srcPath] Directory dosai analyzed; a package the BOM holds in several
 *        versions is matched by the project of the record's file
 * @returns {number} Number of distinct components enriched
 */
export declare function applyDosaiReachabilityEvidence(methodsSlice: Object, components?: Object[], options?: {
    srcPath?: string;
}): number;
/**
 * Map a dosai methods slice to per-purl occurrence evidence.
 *
 * Extracts source locations, imported modules, and called methods from the
 * Dependencies and PackageReachability sections of the slice.
 *
 * @param {Object} methodsSlice Parsed dosai methods slice JSON
 * @param {Object[]} [components] BOM components used to resolve purl aliases
 * @param {Object} [options] Options
 * @param {string} [options.srcPath] Directory dosai analyzed; a package the BOM holds in several
 *        versions is matched by the project of the record's file
 * @returns {Object} Object with purlLocationMap, purlModulesMap, and purlMethodsMap keyed by purl
 */
export declare function collectDosaiPurlEvidence(methodsSlice: Object, components?: Object[], options?: {
    srcPath?: string;
}): Object;
/**
 * Extract data-flow call frames per component purl from a dosai data-flow result.
 *
 * Frames are derived from slice and PackageReachability node ids, and grouped
 * under every purl referenced by each flow (source, sink, and intermediate).
 *
 * @param {Object} dataFlowResult Parsed dosai data-flow slice JSON
 * @param {Object[]} [components] BOM components used to resolve purl aliases
 * @param {Object} [options] Options
 * @param {string} [options.srcPath] Directory dosai analyzed; a package the BOM holds in several
 *        versions is matched by the project of the record's file
 * @returns {Object} Map of canonical purl to arrays of call-stack frame objects
 */
export declare function collectDosaiDataFlowFrames(dataFlowResult: Object, components?: Object[], options?: {
    srcPath?: string;
}): Object;
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