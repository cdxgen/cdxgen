export namespace communityAiConfigParser {
    export let id: string;
    export { COMMUNITY_AI_PATTERNS as patterns };
    export function parse(files: any, _options?: {}): {
        components: {
            "bom-ref": string;
            name: any;
            properties: {
                name: string;
                value: any;
            }[];
            type: string;
            version: string | undefined;
        }[];
        services: {
            "bom-ref": string;
            group: any;
            name: any;
            properties: {
                name: string;
                value: any;
            }[];
            version: string;
        }[];
    };
}
declare const COMMUNITY_AI_PATTERNS: string[];
export {};
//# sourceMappingURL=communityAiConfigParser.d.ts.map