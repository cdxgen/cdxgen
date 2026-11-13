/**
 * Jenkins formulation parser.
 *
 * Matches `Jenkinsfile` and `Jenkinsfile.*` at any directory depth and converts
 * declarative pipeline syntax into CycloneDX formulation workflow objects.
 *
 * Parser contract: `parse(files, options, context)` returns
 * `{ workflows, components, services, properties, dependencies }`.
 */
export declare const jenkinsParser: {
    id: string;
    patterns: string[];
    /**
     * @param {string[]} files Matched Jenkinsfile paths
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
//# sourceMappingURL=jenkins.d.ts.map