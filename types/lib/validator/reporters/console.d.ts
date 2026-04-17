/**
 * Produce a human-readable summary of findings.
 *
 * @param {Array<object>} findings
 * @param {object} [options]
 * @returns {string}
 */
export function formatFindings(findings: Array<object>, options?: object): string;
/**
 * Produce a scorecard table for benchmark reports.
 *
 * @param {Array<object>} reports
 * @returns {string}
 */
export function formatBenchmarks(reports: Array<object>): string;
/**
 * Produce a compact one-line summary for CI logs.
 *
 * @param {object} summary
 * @returns {string}
 */
export function formatSummary(summary: object): string;
/**
 * Render the full report as a single string.
 *
 * @param {object} report Output of validateBomAdvanced().
 * @returns {string}
 */
export function render(report: object): string;
//# sourceMappingURL=console.d.ts.map