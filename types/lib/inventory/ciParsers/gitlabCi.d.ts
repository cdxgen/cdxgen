/**
 * GitLab CI formulation parser.
 *
 * Matches `.gitlab-ci.yml` files and converts them into CycloneDX formulation
 * workflow objects. Each GitLab job becomes a task; script lines become steps.
 *
 * Parser contract: `parse(files, options, context)` returns
 * `{ workflows, components, services, properties, dependencies }`.
 */
export declare const gitlabCiParser: {
    id: string;
    patterns: string[];
    /**
     * @param {string[]} files Matched CI config file paths
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
//# sourceMappingURL=gitlabCi.d.ts.map