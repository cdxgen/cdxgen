/**
 * Resolve a benchmark alias (case-insensitive). Returns null when unknown.
 *
 * @param {string} alias
 * @returns {object | null}
 */
export function resolveBenchmark(alias: string): object | null;
/**
 * List all known benchmark aliases in a stable display order.
 *
 * @returns {Array<object>}
 */
export function listBenchmarks(): Array<object>;
/**
 * Evaluate one rule against the BOM and return a Finding-shaped object.
 *
 * Rules are pure synchronous functions, but we wrap them in try/catch so one
 * bad rule cannot fail the entire run.
 *
 * @param {object} rule
 * @param {object} bomJson
 * @returns {object} Finding
 */
export function evaluateRule(rule: object, bomJson: object): object;
/**
 * Evaluate every rule in the catalog, or a filtered subset.
 *
 * @param {object} bomJson CycloneDX BOM
 * @param {object} [opts]
 * @param {Array<string>} [opts.categories] Filter to these category values.
 * @param {Array<string>} [opts.benchmarks] Only run rules from these benchmark aliases.
 * @returns {Array<object>} Findings (one per rule)
 */
export function evaluateAll(bomJson: object, opts?: {
    categories?: string[] | undefined;
    benchmarks?: string[] | undefined;
}): Array<object>;
/**
 * Produce a scorecard for a single benchmark against a set of already-evaluated
 * findings. Scoring rules:
 *   - pass      counts as 1 / 1.
 *   - fail      counts as 0 / 1.
 *   - manual    is excluded from the percentage but counted separately.
 *
 * This mirrors how OWASP SCVS publishes results: automatable controls score a
 * percentage, manual controls are reported so reviewers can address them.
 *
 * @param {object} benchmark Result of resolveBenchmark
 * @param {Array<object>} findings Full set of findings from evaluateAll
 * @returns {object}
 */
export function scoreBenchmark(benchmark: object, findings: Array<object>): object;
/**
 * Build scorecards for each requested benchmark. When no benchmarks are
 * specified, returns scorecards for every built-in benchmark alias.
 *
 * @param {Array<object>} findings
 * @param {Array<string>} [requestedAliases]
 * @returns {Array<object>}
 */
export function buildBenchmarkReports(findings: Array<object>, requestedAliases?: Array<string>): Array<object>;
import { getAllComplianceRules } from "./complianceRules.js";
import { getCraRules } from "./complianceRules.js";
import { getScvsRules } from "./complianceRules.js";
export { getAllComplianceRules, getCraRules, getScvsRules };
//# sourceMappingURL=complianceEngine.d.ts.map