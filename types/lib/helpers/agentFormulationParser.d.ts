export namespace agentFormulationParser {
    export let id: string;
    export { AGENT_FILE_PATTERNS as patterns };
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
        services: any[];
    };
}
declare const AGENT_FILE_PATTERNS: string[];
export {};
//# sourceMappingURL=agentFormulationParser.d.ts.map