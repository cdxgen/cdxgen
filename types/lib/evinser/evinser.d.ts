/**
 * Function to create the db for the libraries referred in the sbom.
 *
 * @param {Object} options Command line options
 */
export declare function prepareDB(options: Object): Promise<{
    sequelize: {
        close: () => boolean;
    };
    Namespaces: Object;
    Usages: Object;
    DataFlows: Object;
} | undefined>;
/**
 * Collect Maven jar namespace mappings for the purls found in the SBOM.
 *
 * If a previously generated `bom.json.map` is present in `dirPath` it is reused;
 * otherwise the maven command is invoked to collect the jar dependencies. Each
 * resolved purl is recorded in the `purlsJars` map and persisted in the
 * `Namespaces` model.
 *
 * @param {string} dirPath Project directory scanned by evinse
 * @param {Object<string, string>} purlsJars Map populated with purl -> jar file path
 * @param {Object} Namespaces Sequelize-like Namespaces model used to persist pom and namespaces
 * @param {object} options CLI options
 * @returns {Promise<void>}
 */
export declare function catalogMavenDeps(dirPath: string, purlsJars: Record<string, string>, Namespaces: Object, options?: object): Promise<void>;
/**
 * Collect Gradle cache jar namespace mappings for the purls found in the SBOM.
 *
 * Invokes the gradle command to collect all jars (including from the cache) and
 * records each resolved purl in the `purlsJars` map and the `Namespaces` model.
 *
 * @param {string} dirPath Project directory scanned by evinse
 * @param {Object<string, string>} purlsJars Map populated with purl -> jar file path
 * @param {Object} Namespaces Sequelize-like Namespaces model used to persist pom and namespaces
 * @returns {Promise<void>}
 */
export declare function catalogGradleDeps(dirPath: string, purlsJars: Record<string, string>, Namespaces: Object): Promise<void>;
/**
 * Generate a usage slice for the given purl and persist it in the Usages model.
 *
 * Delegates to {@link createSlice} to produce the slice file, then stores the
 * file contents in the `Usages` model keyed by purl. Any temporary directory
 * created under the cdxgen temp root is cleaned up afterwards.
 *
 * @param {string} purl Package URL to slice
 * @param {Object<string, string>} purlsJars Map of purl -> jar/file path
 * @param {Object} Usages Sequelize-like Usages model used to persist slice data
 * @param {object} options CLI options
 * @returns {Promise<Object|undefined>} The created or found Usages record
 */
export declare function createAndStoreSlice(purl: string, purlsJars: Record<string, string>, Usages: Object, options?: object): Promise<Object | undefined>;
/**
 * Name the option a slice type reads its output path from.
 *
 * The CLI flags are hyphenated (`--data-flow-slices-file`) and yargs hands them
 * over camel-cased, so a slice type containing a hyphen cannot be turned into
 * its option name by concatenation alone.
 *
 * @param {string} sliceType Slice type such as `usages` or `data-flow`
 * @returns {string} Matching option name
 */
export declare function sliceFileOption(sliceType: string): string;
/**
 * Run atom/sourcekitten/dosai to produce a usage or data-flow slice file for a purl or language.
 *
 * Accepts either a package url (resolved to a language via {@link purlToLanguage})
 * or an explicit language string. The chosen language is normalised to the
 * canonical atom language name and the requested slice type (`usages`,
 * `data-flow`, `reachables`, or `semantics`) is generated into a temporary
 * directory.
 *
 * @param {string|string[]} purlOrLanguages Package URL or language name (or array whose first entry is used)
 * @param {string} filePath Path to the source file, jar, or project directory to slice
 * @param {string} [sliceType="usages"] Slice type: `usages`, `data-flow`, `reachables`, or `semantics`
 * @param {object} [options={}] CLI options controlling slice generation
 * @returns {Promise<Object>} Result map with `slicesFile`, `atomFile`, `openapiSpecFile`, `semanticsSlicesFile`, `tempDir`, and `tempDirOwned`
 */
export declare function createSlice(purlOrLanguages: string | string[], filePath: string, sliceType?: string, options?: object): Promise<Object>;
/**
 * Map a package URL type to an analysis language (java, python, js, …).
 *
 * @param {string} purl Package URL to inspect
 * @param {string} [filePath] Optional file path used to distinguish jar vs java for maven purls
 * @returns {string|undefined} Resolved language name or `undefined` when the purl type is unsupported
 */
export declare function purlToLanguage(purl: string, filePath?: string): string | undefined;
/**
 * Seed purl-location and import maps from SBOM component evidence.
 *
 * Walks the supplied components reading `internal:ImportedModules` (or
 * `internal:Namespaces` for php/ruby) and `evidence.occurrences` properties
 * to construct lookup maps used during slice analysis.
 *
 * @param {Object[]} components CycloneDX components from the input SBOM
 * @param {string} language Application language used to select the import property name
 * @returns {{ purlLocationMap: Object<string, Set>, purlImportsMap: Object<string, string[]> }} Seeded purl location and import maps
 */
export declare function initFromSbom(components: Object[], language: string): {
    purlLocationMap: Record<string, Set<any>>;
    purlImportsMap: Record<string, string[]>;
};
/**
 * Function to analyze the project
 *
 * @param {Object} dbObjMap DB and model instances
 * @param {Object} options Command line options
 */
export declare function analyzeProject(dbObjMap: Object, options: Object): Promise<{
    purlLocationMap: Record<string, Set<any>>;
    servicesMap: {};
    dataFlowFrames: {};
    userDefinedTypesMap: {};
    componentPropertiesMap?: undefined;
    metadataProperties?: undefined;
    atomFile?: undefined;
    usagesSlicesFile?: undefined;
    dataFlowSlicesFile?: undefined;
    reachablesSlicesFile?: undefined;
    semanticsSlicesFile?: undefined;
    tempDir?: undefined;
    tempDirOwned?: undefined;
    cryptoComponents?: undefined;
    aiComponents?: undefined;
    cryptoGeneratePurls?: undefined;
    openapiSpecFile?: undefined;
} | {
    purlLocationMap: any;
    dataFlowFrames: any;
    componentPropertiesMap: any;
    metadataProperties: any;
    cryptoComponents: any;
    cryptoGeneratePurls: any;
    servicesMap: {};
    userDefinedTypesMap: {};
    atomFile?: undefined;
    usagesSlicesFile?: undefined;
    dataFlowSlicesFile?: undefined;
    reachablesSlicesFile?: undefined;
    semanticsSlicesFile?: undefined;
    tempDir?: undefined;
    tempDirOwned?: undefined;
    aiComponents?: undefined;
    openapiSpecFile?: undefined;
} | {
    componentPropertiesMap?: undefined;
    metadataProperties?: undefined;
    usagesSlicesFile: any;
    dataFlowSlicesFile: any;
    semanticsSlicesFile: any;
    purlLocationMap: Record<string, Set<any>>;
    servicesMap: {};
    dataFlowFrames: {};
    tempDir: any;
    tempDirOwned: any;
    userDefinedTypesMap: {};
    cryptoComponents: any[];
    aiComponents: any[];
    cryptoGeneratePurls: {};
    atomFile?: undefined;
    reachablesSlicesFile?: undefined;
    openapiSpecFile?: undefined;
} | {
    componentPropertiesMap?: undefined;
    metadataProperties?: undefined;
    atomFile: any;
    usagesSlicesFile: any;
    dataFlowSlicesFile: any;
    reachablesSlicesFile: any;
    semanticsSlicesFile: any;
    purlLocationMap: Record<string, Set<any>>;
    servicesMap: {};
    dataFlowFrames: {};
    tempDir: any;
    tempDirOwned: any;
    userDefinedTypesMap: {};
    cryptoComponents: any[];
    aiComponents: any;
    cryptoGeneratePurls: {};
    openapiSpecFile: any;
}>;
/**
 * Parse atom object slices into usages, user-defined types, services, and purl-location evidence.
 *
 * Iterates over the `objectSlices` and `userDefinedTypes` of an atom usage slice,
 * delegating to {@link parseSliceUsages} to record purl locations and imports.
 * Services are detected first from an OpenAPI spec (when present) and then from
 * usage slices or user-defined types as fallbacks.
 *
 * @param {string} language Application language
 * @param {Object} usageSlice Parsed atom usage slice object
 * @param {Object} dbObjMap DB models handle containing Namespaces and Usages models
 * @param {Object} [servicesMap={}] Map populated with detected service definitions
 * @param {Object<string, Set>} [purlLocationMap={}] Map populated with purl -> source locations
 * @param {Object<string, string[]>} [purlImportsMap={}] Map populated with purl -> imported modules
 * @param {string} [openapiSpecFile=undefined] Optional path to an OpenAPI spec used for service detection
 * @returns {Promise<Object>} Map with `purlLocationMap`, `servicesMap`, and `userDefinedTypesMap`
 */
export declare function parseObjectSlices(language: string, usageSlice: Object, dbObjMap: Object, servicesMap?: Object, purlLocationMap?: Record<string, Set<any>>, purlImportsMap?: Record<string, string[]>, openapiSpecFile?: string): Promise<Object>;
/**
 * The implementation of this function is based on the logic proposed in the atom slices specification
 * https://github.com/AppThreat/atom/blob/main/specification/docs/slices.md#use
 *
 * @param {string} language Application language
 * @param {Object} userDefinedTypesMap User Defined types in the application
 * @param {Array} slice Usages array for each objectSlice
 * @param {Object} dbObjMap DB Models
 * @param {Object} purlLocationMap Object to track locations where purls are used
 * @param {Object} purlImportsMap Object to track package urls and their import aliases
 * @returns
 */
export declare function parseSliceUsages(language: string, userDefinedTypesMap: Object, slice: any[], dbObjMap: Object, purlLocationMap: Object, purlImportsMap: Object): Promise<void>;
/**
 * Method to parse semantic slice data. Currently supported for swift and scala languages.
 *
 * @param {String} language Project language.
 * @param {Array} components Components from the input SBOM
 * @param {Object} semanticsSlice Semantic slice data
 * @returns {Object} Parsed metadata
 */
export declare function parseSemanticSlices(language: string, components: any[], semanticsSlice: Object): Object;
/**
 * Decide whether a type name should be ignored during slice analysis.
 *
 * Returns `true` for placeholder/builtin/unresolved names and for language
 * specific primitives and JDK/runtime packages. User-defined types recorded in
 * `userDefinedTypesMap` are also considered filterable.
 *
 * @param {string} language Application language
 * @param {Object<string, boolean>} userDefinedTypesMap Known user-defined type names
 * @param {string} typeFullName Full type name to test
 * @returns {boolean} `true` when the type should be filtered out
 */
export declare function isFilterableType(language: string, userDefinedTypesMap: Record<string, boolean>, typeFullName: string): boolean;
/**
 * Extract service and endpoint definitions from an OpenAPI spec file.
 *
 * Parses the JSON spec and, for every operation under `paths`, records a
 * service entry keyed by the URL pattern and HTTP method into `servicesMap`.
 *
 * @param {string} _language Application language (unused; reserved for future use)
 * @param {string} openapiSpecFile Path to the OpenAPI JSON spec file
 * @param {Object} servicesMap Map populated with detected services
 * @returns {void}
 */
export declare function detectServicesFromOpenAPI(_language: string, openapiSpecFile: string, servicesMap: Object): void;
/**
 * Method to detect services from annotation objects in the usage slice
 *
 * @param {string} language Application language
 * @param {Array} slice Usages array for each objectSlice
 * @param {Object} servicesMap Existing service map
 */
export declare function detectServicesFromUsages(language: string, slice: any[], servicesMap?: Object): never[] | undefined;
/**
 * Method to detect services from user defined types in the usage slice
 *
 * @param {string} language Application language
 * @param {Array} userDefinedTypes User defined types
 * @param {Object} servicesMap Existing service map
 */
export declare function detectServicesFromUDT(language: string, userDefinedTypes: any[], servicesMap: Object): void;
/**
 * Derive a service name from a slice's fullName or file name.
 *
 * Uses the portion of `slice.fullName` before the first `:` (dots replaced with
 * hyphens), falling back to the file basename. A `-service` suffix is appended
 * when not already present.
 *
 * @param {string} _language Application language (unused; reserved for future use)
 * @param {Object} slice Object slice containing `fullName` and/or `fileName`
 * @returns {string} Constructed service name
 */
export declare function constructServiceName(_language: string, slice: Object): string;
/**
 * Extract HTTP endpoint paths from source code annotations for a given language.
 *
 * Examines the supplied code snippet for framework-specific routing annotations
 * (e.g. Spring `@*Mapping`, Express `app.`/`route`, Rails route verbs) and
 * returns the matched endpoint path strings.
 *
 * @param {string} language Application language such as `java`, `js`, or `ruby`
 * @param {string} code Source code snippet to inspect
 * @returns {string[]|undefined} Array of endpoint paths or `undefined` when none are found
 */
export declare function extractEndpoints(language: string, code: string): string[] | undefined;
/**
 * Method to create the SBOM with evidence file called evinse file.
 *
 * @param {Object} sliceArtefacts Various artefacts from the slice operation
 * @param {Object} options Command line options
 * @returns
 */
export declare function createEvinseFile(sliceArtefacts: Object, options: Object): any;
/**
 * Method to convert dataflow slice into usable callstack frames
 * Implemented based on the logic proposed here - https://github.com/AppThreat/atom/blob/main/specification/docs/slices.md#data-flow-slice
 *
 * @param {string} language Application language
 * @param {Object} userDefinedTypesMap User Defined types in the application
 * @param {Object} dataFlowSlice Data flow slice object from atom
 * @param {Object} dbObjMap DB models
 * @param {Object} _purlLocationMap Object to track locations where purls are used
 * @param {Object} purlImportsMap Object to track package urls and their import aliases
 */
export declare function collectDataFlowFrames(language: string, userDefinedTypesMap: Object, dataFlowSlice: Object, dbObjMap: Object, _purlLocationMap: Object, purlImportsMap: Object): Promise<{}>;
/**
 * Method to convert reachable slice into usable callstack frames and crypto components
 *
 * Implemented based on the logic proposed here - https://github.com/AppThreat/atom/blob/main/specification/docs/slices.md#data-flow-slice
 *
 * @param {string} _language Application language
 * @param {Object} reachablesSlice Reachables slice object from atom
 */
export declare function collectReachableFrames(_language: string, reachablesSlice: Object): {
    dataFlowFrames: {};
    cryptoComponents: {
        type: string;
        name: any;
        "bom-ref": any;
        description: any;
        cryptoProperties: {
            assetType: string;
            oid: any;
        };
    }[];
    cryptoGeneratePurls: {};
};
/**
 * Method to pick a callstack frame as an evidence. This method is required since CycloneDX 1.5 accepts only a single frame as evidence.
 *
 * @param {Array} dfFrames Data flow frames
 * @returns
 */
export declare function framePicker(dfFrames: any[]): any[] | undefined;
/**
 * Method to simplify types. For example, arrays ending with [] could be simplified.
 *
 * @param {string} typeFullName Full name of the type to simplify
 * @returns Simplified type string
 */
export declare function simplifyType(typeFullName: string): string;
/**
 * Reduce a full type signature to its enclosing class type for a given language.
 *
 * Strips method, call, and member qualifiers from the signature using language
 * specific rules (e.g. java method selectors, javascript `::`/`new`/`await`,
 * python module/body suffixes) and returns the simplified class type via
 * {@link simplifyType}.
 *
 * @param {string} language Application language
 * @param {string} typeFullName Full type signature to reduce
 * @returns {string|undefined} Enclosing class type or `undefined` when it cannot be resolved
 */
export declare function getClassTypeFromSignature(language: string, typeFullName: string): string | undefined;
//# sourceMappingURL=evinser.d.ts.map