export function renderSarifReport(report: any, options?: {}): string;
/**
 * Render an audit report as pretty JSON.
 *
 * @param {object} report aggregate report
 * @returns {string} JSON output
 */
export function renderJsonReport(report: object): string;
/**
 * Render an audit report for terminal output.
 *
 * @param {object} report aggregate report
 * @param {object} options render options
 * @returns {string} console report text
 */
export function renderConsoleReport(report: object, options?: object): string;
/**
 * Render the requested report format.
 *
 * @param {string} reportType format name
 * @param {object} report aggregate report
 * @param {object} options render options
 * @returns {string} rendered report
 */
export function renderAuditReport(reportType: string, report: object, options?: object): string;
/**
 * Convert predictive audit results into CycloneDX annotations.
 *
 * @param {object} report aggregate audit report
 * @param {object} bomJson root CycloneDX BOM
 * @param {object} [options] annotation options
 * @returns {object[]} annotations
 */
export function formatPredictiveAnnotations(report: object, bomJson: object, options?: object): object[];
//# sourceMappingURL=reporters.d.ts.map