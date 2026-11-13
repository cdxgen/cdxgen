/**
 * CircleCI formulation parser.
 *
 * Matches `.circleci/config.yml` and `.circleci/config.yaml` and converts them
 * into CycloneDX formulation workflow objects. Referenced orbs are captured as
 * components.
 *
 * Parser contract: `parse(files, options, context)` returns
 * `{ workflows, components, services, properties, dependencies }`.
 */
export declare const circleCiParser: {
    id: string;
    patterns: string[];
    /**
     * @param {string[]} files Matched config file paths
     * @param {Object} options CLI options
     * @param {{ rootDir?: string }} [context] Scanned project root
     * @returns {{ workflows: Object[], components: Object[], services: Object[], properties: Object[], dependencies: Object[] }}
     */
    parse(files: string[], options: Object, context?: {
        rootDir?: string;
    }): {
        workflows: Object[];
        components: Object[];
        services: Object[];
        properties: Object[];
        dependencies: Object[];
    };
};
//# sourceMappingURL=circleCi.d.ts.map