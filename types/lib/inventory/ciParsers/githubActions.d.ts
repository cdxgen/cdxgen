/**
 * Parse a single GitHub Actions workflow file into workflow, component, and dependency data.
 *
 * @param {string} f Absolute path to a workflow YAML file
 * @param {Object} options CLI options
 * @param {string} [rootDir] Scanned project root. When given, the workflow
 * path is recorded relative to it.
 * @returns {{ workflows: Object[], components: Object[], dependencies: Object[] }}
 */
export declare function parseWorkflowFile(f: string, options: Object, rootDir?: string): {
    workflows: Object[];
    components: Object[];
    dependencies: Object[];
};
/**
 * GitHub Actions formulation parser.
 *
 * Matches `.github/workflows/*.yml` and `*.yaml` files and converts them into
 * CycloneDX formulation workflow objects, with referenced actions as components.
 *
 * Parser contract: `parse(files, options, context)` returns
 * `{ workflows, components, services, properties, dependencies }`.
 */
export declare const githubActionsParser: {
    id: string;
    patterns: string[];
    /**
     * @param {string[]} files Matched workflow file paths
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
//# sourceMappingURL=githubActions.d.ts.map