export namespace mcpConfigParser {
    export let id: string;
    export { MCP_CONFIG_PATTERNS as patterns };
    export function parse(files: any, _options?: {}): {
        components: {
            "bom-ref": string;
            name: any;
            properties: {
                name: string;
                value: any;
            }[];
            type: string;
        }[];
        services: {
            "bom-ref": string;
            authenticated: boolean | undefined;
            endpoints: any[];
            group: string;
            name: any;
            properties: {
                name: string;
                value: any;
            }[];
            version: string;
        }[];
    };
}
declare const MCP_CONFIG_PATTERNS: string[];
export {};
//# sourceMappingURL=mcpConfigParser.d.ts.map