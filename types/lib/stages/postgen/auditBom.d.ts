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
export function getBomAuditDryRunSupportSummary(options?: {}): Promise<{
    fullCount: number;
    noCount: number;
    partialCount: number;
    totalRules: number;
}>;
export function formatDryRunSupportSummary(summary: any): string;
/**
 * Audit BOM formulation section using JSONata-powered rule engine
 * @param {Object} bomJson - Generated CycloneDX BOM
 * @param {Object} options - CLI options
 * @returns {Promise<Array>} Array of audit findings
 */
export function auditBom(bomJson: Object, options: Object): Promise<any[]>;
/**
 * Format findings for console output with color-coded severity
 */
export function renderBomAuditConsoleReport(findings: any): string;
/**
 * Format findings for console output with color-coded severity
 */
export function formatConsoleOutput(findings: any): string;
/**
 * Convert findings to CycloneDX annotations
 */
export function formatAnnotations(findings: any, bomJson: any): any;
/**
 * Check if any findings meet the severity threshold for secure mode failure
 */
export function hasCriticalFindings(findings: any, options: any): any;
//# sourceMappingURL=auditBom.d.ts.map