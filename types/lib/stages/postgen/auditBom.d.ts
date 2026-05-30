/**
 * Detect whether a BOM looks like an HBOM inventory.
 *
 * @param {object} bomJson CycloneDX BOM
 * @returns {boolean} True when the BOM appears to represent hardware inventory
 */
export function isHbomLikeBom(bomJson: object): boolean;
/**
 * Detect whether a BOM looks like an OBOM/runtime inventory.
 *
 * @param {object} bomJson CycloneDX BOM
 * @returns {boolean} True when the BOM appears to represent operations/runtime data
 */
export function isObomLikeBom(bomJson: object): boolean;
/**
 * Summarize dry-run support across active BOM audit rules.
 *
 * @param {Object} [options={}] audit configuration options
 * @returns {Promise<{ fullCount: number, noCount: number, partialCount: number, totalRules: number }>} dry-run summary
 */
export function getBomAuditDryRunSupportSummary(options?: Object): Promise<{
    fullCount: number;
    noCount: number;
    partialCount: number;
    totalRules: number;
}>;
/**
 * Format BOM audit dry-run support as a console-friendly summary line.
 *
 * @param {{ fullCount: number, noCount: number, partialCount: number, totalRules: number }} summary dry-run support summary
 * @returns {string} formatted summary text
 */
export function formatDryRunSupportSummary(summary: {
    fullCount: number;
    noCount: number;
    partialCount: number;
    totalRules: number;
}): string;
/**
 * Audit BOM formulation section using JSONata-powered rule engine
 * @param {Object} bomJson - Generated CycloneDX BOM
 * @param {Object} options - CLI options
 * @returns {Promise<Array>} Array of audit findings
 */
export function auditBom(bomJson: Object, options: Object): Promise<any[]>;
/**
 * Format findings into a console report table.
 *
 * @param {Array} findings audit findings
 * @returns {string} console report table
 */
export function renderBomAuditConsoleReport(findings: any[]): string;
/**
 * Print BOM audit findings to the console.
 *
 * @param {Array} findings audit findings
 * @returns {string} rendered console output
 */
export function formatConsoleOutput(findings: any[]): string;
/**
 * Convert BOM audit findings to CycloneDX annotations.
 *
 * @param {Array} findings audit findings
 * @param {Object} bomJson generated CycloneDX BOM
 * @returns {Array} CycloneDX annotations
 */
export function formatAnnotations(findings: any[], bomJson: Object): any[];
/**
 * Check if any findings meet the severity threshold for secure mode failure
 */
export function hasCriticalFindings(findings: any, options: any): any;
//# sourceMappingURL=auditBom.d.ts.map