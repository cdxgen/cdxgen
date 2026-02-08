/**
 * Function to create the db for the libraries referred in the sbom.
 *
 * @param {Object} options Command line options
 */
export function prepareDB(options: any): Promise<{
    sequelize: any;
    Namespaces: {
        db: any;
        tableName: any;
        init(): Promise<any>;
        findByPk(purl: any): Promise<any>;
        findOrCreate(options: any): Promise<any>;
        findAll(options: any): Promise<any>;
    };
    Usages: {
        db: any;
        tableName: any;
        init(): Promise<any>;
        findByPk(purl: any): Promise<any>;
        findOrCreate(options: any): Promise<any>;
        findAll(options: any): Promise<any>;
    };
    DataFlows: {
        db: any;
        tableName: any;
        init(): Promise<any>;
        findByPk(purl: any): Promise<any>;
        findOrCreate(options: any): Promise<any>;
        findAll(options: any): Promise<any>;
    };
}>;
export function catalogMavenDeps(dirPath: any, purlsJars: any, Namespaces: any, options?: {}): Promise<void>;
export function catalogGradleDeps(dirPath: any, purlsJars: any, Namespaces: any): Promise<void>;
export function createAndStoreSlice(purl: any, purlsJars: any, Usages: any, options?: {}): Promise<any>;
export function createSlice(purlOrLanguages: any, filePath: any, sliceType?: string, options?: {}): Promise<{
    tempDir?: undefined;
    slicesFile?: undefined;
    atomFile?: undefined;
    openapiSpecFile?: undefined;
    semanticsSlicesFile?: undefined;
} | {
    tempDir: any;
    slicesFile: any;
    atomFile?: undefined;
    openapiSpecFile?: undefined;
    semanticsSlicesFile?: undefined;
} | {
    tempDir: any;
    slicesFile: any;
    atomFile: any;
    openapiSpecFile: any;
    semanticsSlicesFile: any;
}>;
export function purlToLanguage(purl: any, filePath: any): string;
export function initFromSbom(components: any, language: any): {
    purlLocationMap: {};
    purlImportsMap: {};
};
/**
 * Function to analyze the project
 *
 * @param {Object} dbObjMap DB and model instances
 * @param {Object} options Command line options
 */
export function analyzeProject(dbObjMap: any, options: any): Promise<{
    atomFile: any;
    usagesSlicesFile: any;
    dataFlowSlicesFile: any;
    reachablesSlicesFile: any;
    semanticsSlicesFile: any;
    purlLocationMap: {};
    servicesMap: {};
    dataFlowFrames: {};
    tempDir: any;
    userDefinedTypesMap: {};
    cryptoComponents: any[];
    cryptoGeneratePurls: {};
    openapiSpecFile: any;
}>;
export function parseObjectSlices(language: any, usageSlice: any, dbObjMap: any, servicesMap?: {}, purlLocationMap?: {}, purlImportsMap?: {}, openapiSpecFile?: any): Promise<{}>;
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
export function parseSliceUsages(language: string, userDefinedTypesMap: any, slice: any[], dbObjMap: any, purlLocationMap: any, purlImportsMap: any): Promise<void>;
/**
 * Method to parse semantic slice data. Currently supported for swift and scala languages.
 *
 * @param {String} language Project language.
 * @param {Array} components Components from the input SBOM
 * @param {Object} semanticsSlice Semantic slice data
 * @returns {Object} Parsed metadata
 */
export function parseSemanticSlices(language: string, components: any[], semanticsSlice: any): any;
export function isFilterableType(language: any, userDefinedTypesMap: any, typeFullName: any): boolean;
export function detectServicesFromOpenAPI(_language: any, openapiSpecFile: any, servicesMap: any): void;
/**
 * Method to detect services from annotation objects in the usage slice
 *
 * @param {string} language Application language
 * @param {Array} slice Usages array for each objectSlice
 * @param {Object} servicesMap Existing service map
 */
export function detectServicesFromUsages(language: string, slice: any[], servicesMap?: any): any[];
/**
 * Method to detect services from user defined types in the usage slice
 *
 * @param {string} language Application language
 * @param {Array} userDefinedTypes User defined types
 * @param {Object} servicesMap Existing service map
 */
export function detectServicesFromUDT(language: string, userDefinedTypes: any[], servicesMap: any): void;
export function constructServiceName(_language: any, slice: any): string;
export function extractEndpoints(language: any, code: any): any;
/**
 * Method to create the SBOM with evidence file called evinse file.
 *
 * @param {Object} sliceArtefacts Various artefacts from the slice operation
 * @param {Object} options Command line options
 * @returns
 */
export function createEvinseFile(sliceArtefacts: any, options: any): any;
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
export function collectDataFlowFrames(language: string, userDefinedTypesMap: any, dataFlowSlice: any, dbObjMap: any, _purlLocationMap: any, purlImportsMap: any): Promise<{}>;
/**
 * Method to convert reachable slice into usable callstack frames and crypto components
 *
 * Implemented based on the logic proposed here - https://github.com/AppThreat/atom/blob/main/specification/docs/slices.md#data-flow-slice
 *
 * @param {string} _language Application language
 * @param {Object} reachablesSlice Reachables slice object from atom
 */
export function collectReachableFrames(_language: string, reachablesSlice: any): {
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
export function framePicker(dfFrames: any[]): any;
/**
 * Method to simplify types. For example, arrays ending with [] could be simplified.
 *
 * @param {string} typeFullName Full name of the type to simplify
 * @returns Simplified type string
 */
export function simplifyType(typeFullName: string): string;
export function getClassTypeFromSignature(language: any, typeFullName: any): string;
//# sourceMappingURL=evinser.d.ts.map