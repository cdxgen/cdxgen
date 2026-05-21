export function isDosaiDotnetLanguage(language: any): boolean;
export function readDosaiJsonFile(jsonFile: any): any;
export function runDosaiCommand(command: any, src: any, outputFile: any, options?: {}): boolean;
export function createDosaiMethodsSlice(src: any, outputFile: any, options?: {}): boolean;
export function createDosaiDataFlowSlice(src: any, outputFile: any, options?: {}): boolean;
export function createDosaiCryptoAnalysis(src: any, outputFile: any, options?: {}): boolean;
export function analyzeDosaiCrypto(src: any, options?: {}): any;
export function buildPurlAliasMap(components?: any[]): Map<any, any>;
export function resolveComponentPurl(purl: any, purlAliasMap: any): any;
export function collectDosaiPurlEvidence(methodsSlice: any, components?: any[]): {
    purlLocationMap: {};
    purlModulesMap: {};
    purlMethodsMap: {};
};
export function collectDosaiDataFlowFrames(dataFlowResult: any, components?: any[]): {};
export function collectDosaiServicesFromMethods(methodsSlice: any, servicesMap?: {}): {};
export function normalizeDosaiServiceMap(servicesMap?: {}): {
    name: string;
    endpoints: any[];
    authenticated: any;
    "x-trust-boundary": any;
    properties: any;
}[];
//# sourceMappingURL=dosai.d.ts.map