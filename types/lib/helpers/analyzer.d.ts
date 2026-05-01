export const CHROMIUM_EXTENSION_CAPABILITY_CATEGORIES: string[];
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
export function detectExtensionCapabilities(src: string, deep?: boolean): {
    capabilities: string[];
    indicators: {
        [x: string]: string[];
    };
};
export function detectMcpInventory(src: string, deep?: boolean): {
    components: Object[];
    dependencies: Object[];
    services: Object[];
};
//# sourceMappingURL=analyzer.d.ts.map