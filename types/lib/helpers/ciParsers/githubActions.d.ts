/**
 * Parse a single GitHub Actions workflow file and return formulation-shaped data.
 *
 * Reads and parses the YAML, then walks every job and step to produce:
 * - **workflows** – CycloneDX formulation workflow objects with tasks
 * - **components** – action references (`pkg:github/…`) and run-step processes
 * - **dependencies** – workflow→job and job→action/step edges
 *
 * @param {string} f - Absolute path to a workflow YAML file.
 * @param {Object} options - CLI options
 * @returns {{ workflows: Object[], components: Object[], dependencies: Object[] }}
 */
export function parseWorkflowFile(f: string, options: Object): {
    workflows: Object[];
    components: Object[];
    dependencies: Object[];
};
export namespace githubActionsParser {
    let id: string;
    let patterns: string[];
    /**
     * @param {string[]} files Matched workflow file paths
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
//# sourceMappingURL=githubActions.d.ts.map