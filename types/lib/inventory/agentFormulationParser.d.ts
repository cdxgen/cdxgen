/**
 * Discover AI agent instruction and skill files that can hide MCP/runtime
 * surfaces from package-only inventory. Only regular files inside
 * `context.rootDir`, the scanned root, are read; a symbolic link is never
 * followed.
 */
export declare const agentFormulationParser: {
    id: string;
    patterns: string[];
    parse(files: any, _options?: {}, context?: {}): {
        components: {
            "bom-ref": string;
            name: any;
            properties: {
                name: string;
                value: any;
            }[];
            type: string;
        }[];
        services: any[];
    };
};
//# sourceMappingURL=agentFormulationParser.d.ts.map