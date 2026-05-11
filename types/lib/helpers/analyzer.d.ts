export function analyzeSuspiciousJsSource(source: any): {
    executionIndicators: any[];
    indicators: any[];
    networkIndicators: any[];
    obfuscationIndicators: any[];
};
export function analyzeJsCapabilitiesSource(source: any): {
    capabilities: string[];
    hasDynamicFetch: boolean;
    hasDynamicImport: boolean;
    hasEval: boolean;
    indicatorMap: {};
};
export function analyzeJsCryptoSource(source: any): {
    algorithms: any[];
    libraries: any[];
};
export const CHROMIUM_EXTENSION_CAPABILITY_CATEGORIES: string[];
export const JS_CAPABILITY_CATEGORIES: string[];
export function findJSImportsExports(src: any, deep: any): Promise<{
    allImports: {};
    allExports: {};
}>;
export function analyzeSuspiciousJsFile(filePath: string): {
    executionIndicators: string[];
    indicators: string[];
    networkIndicators: string[];
    obfuscationIndicators: string[];
};
export function analyzeJsCapabilitiesFile(filePath: any): {
    capabilities: string[];
    hasDynamicFetch: boolean;
    hasDynamicImport: boolean;
    hasEval: boolean;
    indicatorMap: {};
};
export function analyzeJsCryptoFile(filePath: any): {
    algorithms: any[];
    libraries: any[];
};
export function detectJsCryptoInventory(src: any, deep?: boolean): Promise<{
    algorithms: any[];
    libraries: any[];
}>;
export function detectExtensionCapabilities(src: string, deep?: boolean): {
    capabilities: string[];
    indicators: {
        [x: string]: string[];
    };
};
export function detectPythonMcpInventory(src: string, deep?: boolean): {
    components: Object[];
    dependencies: Object[];
    services: Object[];
};
export function detectMcpInventory(src: string, deep?: boolean): {
    components: Object[];
    dependencies: Object[];
    services: Object[];
};
//# sourceMappingURL=analyzer.d.ts.map