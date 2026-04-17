/**
 * Run structural + compliance validation against a parsed BOM.
 *
 * @param {object} bomJson Parsed CycloneDX JSON BOM.
 * @param {object} [options]
 * @param {boolean} [options.schema]            Run JSON-Schema validation (default true).
 * @param {boolean} [options.deep]              Run purl/ref/metadata deep checks (default true).
 * @param {Array<string>} [options.benchmarks]  Aliases to include in the scorecards (default: all).
 * @param {Array<string>} [options.categories]  Restrict compliance rules to these categories.
 * @param {string} [options.minSeverity]        Minimum severity for returned findings.
 * @param {boolean} [options.includeManual]     Include manual-review findings (default true).
 * @param {boolean} [options.includePass]       Include passing findings (default false).
 * @param {string} [options.publicKey]          If set, verify the BOM signature.
 * @returns {{
 *   schemaValid: boolean,
 *   deepValid: boolean,
 *   signatureVerified: boolean | null,
 *   signatureDetails: object | null,
 *   findings: Array<object>,
 *   allFindings: Array<object>,
 *   benchmarks: Array<object>,
 *   summary: object
 * }}
 */
export function validateBomAdvanced(bomJson: object, options?: {
    schema?: boolean | undefined;
    deep?: boolean | undefined;
    benchmarks?: string[] | undefined;
    categories?: string[] | undefined;
    minSeverity?: string | undefined;
    includeManual?: boolean | undefined;
    includePass?: boolean | undefined;
    publicKey?: string | undefined;
}): {
    schemaValid: boolean;
    deepValid: boolean;
    signatureVerified: boolean | null;
    signatureDetails: object | null;
    findings: Array<object>;
    allFindings: Array<object>;
    benchmarks: Array<object>;
    summary: object;
};
/**
 * Decide whether a report should trigger a non-zero CLI exit.
 *
 * @param {object} report
 * @param {object} opts
 * @param {string} [opts.failSeverity] Severity level at or above which failing findings are considered a failure (default "high").
 * @param {boolean} [opts.strict]      When true, failing on any `fail` status regardless of severity, and a failing schema/deep validation also counts.
 * @param {boolean} [opts.requireSignature] Require a valid signature when verification was requested.
 * @returns {{ shouldFail: boolean, reason: string | null }}
 */
export function shouldFail(report: object, opts?: {
    failSeverity?: string | undefined;
    strict?: boolean | undefined;
    requireSignature?: boolean | undefined;
}): {
    shouldFail: boolean;
    reason: string | null;
};
export namespace SEVERITY_ORDER {
    let info: number;
    let low: number;
    let medium: number;
    let high: number;
    let critical: number;
}
export { buildBenchmarkReports, evaluateAll } from "./complianceEngine.js";
//# sourceMappingURL=index.d.ts.map