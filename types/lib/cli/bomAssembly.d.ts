/**
 * Determines whether the `node_modules` directory should be scanned for the
 * current run. Scanning is always performed in deep mode or when no project
 * type is selected; otherwise the selected types must include at least one of
 * the requested base project types.
 *
 * @param {object} options CLI options
 * @param {string[]} baseProjectTypes Base project types that require the scan
 * @returns {boolean} True when `node_modules` should be included in the scan
 */
export declare const shouldIncludeNodeModulesDir: (options?: object, baseProjectTypes?: string[]) => boolean;
/**
 * Regex source string that matches hex digests of common lengths
 * (32, 40, 64, 96, or 128 characters) used for integrity validation.
 *
 * @type {string}
 */
export declare const HASH_PATTERN: string;
/**
 * Creates a default parent component based on the directory name.
 *
 * @param {String} path Directory or file name
 * @param {String} type Package type
 * @param {Object} options CLI options
 * @returns component object
 */
export declare const createDefaultParentComponent: (path: string, type?: string, options?: Object) => {
    group: any;
    name: any;
    version: string;
    type: string;
};
/**
 * Builds the parent (metadata.component) for the BOM from the
 * `--project-name`/`--project-version`/`--project-group` CLI options,
 * constructing a purl and bom-ref. Returns the caller-supplied
 * `options.parentComponent` unchanged when present.
 *
 * @param {object} options CLI options
 * @returns {object|undefined} Parent component object, or undefined when no
 *   project name/version is available
 */
export declare const determineParentComponent: (options: object) => object | undefined;
/**
 * Assembles the `metadata.tools` block, including the cdxgen tool entry and,
 * for spec versions prior to 1.5, the legacy tools array. For spec version
 * 1.6+ the author field is converted to the authors array.
 *
 * @param {object} options CLI options
 * @param {object} [context={}] Additional context carrying existing components
 * @returns {{ components?: object[], tools?: object[] }} Object containing the
 *   tools array (1.4) or a components array with tool components (1.5+)
 */
export declare const addToolsSection: (options: object, context?: object) => {
    components?: object[];
    tools?: object[];
};
/**
 * Renders a component's group/name@version as a simple display string.
 *
 * @param {object} comp Component object
 * @returns {string} `group/name@version`, `name@version`, or `name`
 */
export declare const componentToSimpleFullName: (comp: object) => string;
/**
 * Strips transient keys (`evidence`, `_integrity`, `license`, `qualifiers`,
 * `repository`, `homepage`) from a parent component while preserving licenses
 * and external references (bug #1519). External references whose URL is not a
 * valid IRI reference are dropped.
 *
 * @param {object} comp Parent component to clean in place
 * @returns {object} The cleaned parent component
 */
export declare const cleanParentComponent: (comp: object) => object;
/**
 * Builds the `metadata.authors` array from `options.author`, which may be a
 * single string or an array of author strings. Entries shorter than two
 * characters are ignored.
 *
 * @param {object} options CLI options
 * @returns {object[]} Author objects of the form `{ name }`
 */
export declare const addAuthorsSection: (options: object) => object[];
/**
 * Method to generate metadata.lifecycles section. We assume that we operate during "build"
 * most of the time and under "post-build" for containers.
 *
 * @param {Object} options
 * @returns {Array} Lifecycles array
 */
export declare const addLifecyclesSection: (options: Object) => any[];
/**
 * Function to create metadata block
 *
 * @param {Object} [parentComponent] Component the BOM describes
 * @param {Object} [options] CLI options
 * @param {Object} [context] Generator context. `context.metadataProperties`
 *   holds facts of a manifest that has no component to carry them, such as the
 *   platform data of a composer.lock whose composer.json names no project.
 */
export declare function addMetadata(parentComponent?: Object, options?: Object, context?: Object): {
    timestamp: string;
    tools: {
        components?: object[];
        tools?: object[];
    };
    authors: object[];
    supplier: undefined;
};
/**
 * Method to create external references
 *
 * @param {Array | Object} opkg
 * @returns {Array}
 */
export declare function addExternalReferences(opkg: any[] | Object): any[];
/**
 * For all modules in the specified package, creates a list of
 * component objects from each one.
 *
 * @param {Object} options CLI options
 * @param {Object} allImports All imports
 * @param {Object} pkg Package object
 * @param {string} ptype Package type
 * @returns {Object[]} Array of component objects
 */
export declare function listComponents(options: Object, allImports: Object, pkg: Object, ptype?: string): Object[];
/**
 * Component types that never receive an ecosystem purl.
 *
 * @type {string[]}
 */
export declare const NON_PURL_TYPES: string[];
/**
 * Property-name prefix used to key npm bin-command import evidence
 * (`cdx:npm:bin/`).
 *
 * @type {string}
 */
export declare const NPM_BIN_IMPORT_PREFIX: string;
/**
 * Returns all non-empty property values for a given property name on a package.
 *
 * @param {object} pkg Package/component object with an optional `properties` array
 * @param {string} propertyName Property name to match
 * @returns {string[]} Matching property values as strings
 */
export declare function getPackagePropertyValues(pkg: object, propertyName: string): string[];
/**
 * Splits a comma-separated property value into a trimmed, non-empty string array.
 *
 * @param {string} value Comma-separated value
 * @returns {string[]} Trimmed list entries
 */
export declare function splitPackagePropertyList(value: string): string[];
/**
 * Collects the set of bin command names an npm package exposes, derived from
 * the `bin` field and the `cdx:npm:bin` / `cdx:npm:binPaths` properties.
 *
 * @param {object} pkg Package object
 * @returns {Set<string>} Bin command names
 */
export declare function getPackageBinCommandNames(pkg: object): Set<string>;
/**
 * Checks whether any bin command of a package appears in the analyzer import
 * evidence (keyed under `cdx:npm:bin/`).
 *
 * @param {object} allImports Map of import names to usage counts
 * @param {object} pkg Package object
 * @returns {boolean} True when at least one bin command is imported
 */
export declare function hasNpmBinCommandEvidence(allImports: object, pkg: object): boolean;
/**
 * Given the specified package, create a CycloneDX component and add it to the list.
 */
export declare function addComponent(options: any, allImports: any, pkg: any, ptype: any, compMap: any, isRootPkg?: boolean): void;
/**
 * If the author has described the module as a 'framework', the take their
 * word for it, otherwise, identify the module as a 'library'.
 */
export declare function determinePackageType(pkg: any): any;
/**
 * Uses the SHA1 shasum (if present) otherwise utilizes Subresource Integrity
 * of the package with support for multiple hashing algorithms.
 */
export declare function processHashes(pkg: any, component: any): void;
/**
 * Adds a hash to component.
 *
 * Registries hand out digests in hex or in the base64 form npm uses for
 * `integrity`, and both are accepted. A digest that is neither, or that decodes
 * to the wrong length for its algorithm, is dropped rather than copied through:
 * CycloneDX constrains `hash.content` to a hex digest, so emitting it anyway
 * fails schema validation for the whole document over one bad package.
 */
export declare function addComponentHash(alg: any, digest: any, component: any): void;
/**
 * Normalize a digest to the lower-case hex form CycloneDX requires.
 *
 * @param {string} alg Hash algorithm name
 * @param {string} digest Digest in hex or base64
 * @returns {string|undefined} Hex digest, or undefined when it cannot be trusted
 */
export declare function normalizeHashContent(alg: string, digest: string): string | undefined;
/**
 * Return the BOM in json format including any namespace mapping
 *
 * @param {Object} options Options
 * @param {Object} pkgInfo Package information
 * @param {string} ptype Package type
 * @param {Object} context Context
 *
 * @returns {Object} BOM with namespace mapping
 */
export declare const buildBomNSData: (options: Object, pkgInfo: Object, ptype: string, context: Object) => Object;
/**
 * Function to create bom string for Android apps using blint
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Object|undefined} BOM object
 */
export declare function createAndroidBom(path: string, options: Object): Object | undefined;
/**
 * Function to create bom string for binaries using blint
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Object|undefined} BOM object
 */
export declare function createBinaryBom(path: string, options: Object): Object | undefined;
/**
 * Identify the requested AI inventory project types.
 *
 * @param {Object} options Parse options from the cli
 * @returns {string[]} Requested AI inventory types
 */
export declare function getRequestedAiInventoryTypes(options: Object): string[];
/**
 * Returns the AI inventory types excluded via `--exclude-type`.
 *
 * @param {object} options CLI options
 * @returns {string[]} Excluded AI inventory types
 */
export declare function getExcludedAiInventoryTypes(options: object): string[];
/**
 * Removes the excluded AI inventory types from the included list.
 *
 * @param {string[]} includedAiInventoryTypes Types selected for collection
 * @param {string[]} excludedAiInventoryTypes Types excluded by the user
 * @returns {string[]} Filtered list of AI inventory types
 */
export declare function filterIncludedAiInventoryTypes(includedAiInventoryTypes: string[], excludedAiInventoryTypes: string[]): string[];
/**
 * Determine which AI inventory types should be collected for a scan.
 *
 * This combines explicit project-type opt-ins with BOM audit category-driven
 * opt-ins, then removes any explicitly excluded inventory types.
 *
 * @param {Object} options Parse options from the CLI
 * @returns {string[]} AI inventory types to collect
 */
export declare function getIncludedAiInventoryTypes(options: Object): string[];
/**
 * Returns the single AI inventory type when exactly one project type alias is
 * selected, otherwise undefined.
 *
 * @param {object} options CLI options
 * @returns {string|undefined} The exact AI inventory type or undefined
 */
export declare function getExactAiInventoryType(options: object): string | undefined;
/**
 * Determine whether MCP source-code analysis should run for the current scan.
 *
 * @param {string[]} includedAiInventoryTypes AI inventory types selected for collection
 * @returns {boolean} True when MCP inventory collection is enabled
 */
export declare function shouldDetectMcpInventory(includedAiInventoryTypes: string[]): boolean;
/**
 * Collects sorted, unique relative file names for AI inventory subjects whose
 * `cdx:file:kind` property matches one of the given kinds.
 *
 * @param {object[]} subjects Component or service subjects to inspect
 * @param {string} discoveryPath Base path used to compute relative file names
 * @param {Set<string>} kindSet Accepted kind values
 * @returns {string[]} Sorted unique relative file names
 */
export declare function summarizeAiInventoryNames(subjects: object[], discoveryPath: string, kindSet: Set<string>): string[];
/**
 * Collects sorted unique service names from an AI inventory services list.
 *
 * @param {object[]} services Services with a `name` property
 * @returns {string[]} Sorted unique service names
 */
export declare function summarizeAiInventoryServiceNames(services: object[]): string[];
/**
 * Formats one padded summary line for the AI inventory console output.
 *
 * @param {string} label Left-aligned label (padded to 20 chars)
 * @param {number} count Item count
 * @param {string[]} nameList Optional list of names to append in parentheses
 * @returns {string} The formatted summary line
 */
export declare function formatAiInventorySummaryLine(label: string, count: number, nameList: string[]): string;
/**
 * Prints a human-readable AI inventory summary to stderr, including counts and
 * names for instruction files, skill files, MCP configs, and MCP services.
 * Returns without printing when the inventory is empty.
 *
 * @param {object} aiInventory AI inventory object with components and services
 * @param {string} discoveryPath Base path used to compute relative file names
 * @returns {void}
 */
export declare function emitAiInventorySummary(aiInventory: object, discoveryPath: string): void;
/**
 * Dedupe components
 *
 * @param {Object} options Options
 * @param {Array} components Components
 * @param {Object} parentComponent Parent component
 * @param {Array} dependencies Dependencies
 * @param {Array} [metadataProperties] Properties for the metadata block, from
 *   generators whose manifest has no component to carry them
 *
 * @returns {Object} Object including BOM Json
 */
export declare function dedupeBom(options: Object, components: any[], parentComponent: Object, dependencies: any[], metadataProperties?: any[]): Object;
/**
 * Checks whether the user explicitly selected a project type alias that
 * belongs to the given base project type.
 *
 * @param {object} options CLI options
 * @param {string} baseProjectType Base project type to check against
 * @returns {boolean} True when an explicit alias selection matches
 */
export declare const hasExplicitProjectTypeSelection: (options: object, baseProjectType: string) => boolean;
//# sourceMappingURL=bomAssembly.d.ts.map