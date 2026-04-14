export namespace circleCiParser {
    let id: string;
    let patterns: string[];
    /**
     * @param {string[]} files Matched config file paths
     * @param {Object} options CLI options
     * @returns {{ workflows: Object[], components: Object[], services: Object[], properties: Object[], dependencies: Object[] }}
     */
    function parse(files: string[], options: Object): {
        workflows: Object[];
        components: Object[];
        services: Object[];
        properties: Object[];
        dependencies: Object[];
    };
}
//# sourceMappingURL=circleCi.d.ts.map