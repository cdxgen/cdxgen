/**
 * Collects and evaluates signals indicating the presence/use of AI coding agents, assistants, or LLMs.
 *
 * @param {string} dir Root directory of the project
 * @param {Object} [options] Evaluation options
 * @param {number} [options.gitMaxCount] Maximum number of git commits to inspect
 *
 * @returns {Object} The evaluation result containing overall status, tool breakdowns, and properties
 */
export function collectAiProvenance(dir: string, options?: {
    gitMaxCount?: number | undefined;
}): Object;
//# sourceMappingURL=aiProvenanceCollector.d.ts.map