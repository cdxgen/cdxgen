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
export function formatConsoleOutput(findings: any): "" | undefined;
/**
 * Convert findings to CycloneDX annotations
 */
export function formatAnnotations(findings: any, bomJson: any): any;
/**
 * Check if any findings meet the severity threshold for secure mode failure
 */
export function hasCriticalFindings(findings: any, options: any): any;
//# sourceMappingURL=auditBom.d.ts.map