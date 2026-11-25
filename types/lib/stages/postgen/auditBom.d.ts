/**
 * Detect whether a BOM looks like an HBOM inventory.
 *
 * @param {object} bomJson CycloneDX BOM
 * @returns {boolean} True when the BOM appears to represent hardware inventory
 */
export declare function isHbomLikeBom(bomJson: object): boolean;
/**
 * Detect whether a BOM looks like an OBOM/runtime inventory.
 *
 * @param {object} bomJson CycloneDX BOM
 * @returns {boolean} True when the BOM appears to represent operations/runtime data
 */
export declare function isObomLikeBom(bomJson: object): boolean;
/**
 * Summarize dry-run support across active BOM audit rules.
 *
 * @param {Object} [options={}] audit configuration options
 * @returns {Promise<{ fullCount: number, noCount: number, partialCount: number, totalRules: number }>} dry-run summary
 */
export declare function getBomAuditDryRunSupportSummary(options?: Object): Promise<{
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
export declare function formatDryRunSupportSummary(summary: {
    fullCount: number;
    noCount: number;
    partialCount: number;
    totalRules: number;
}): string;
/**
 * Ensure the BOM carries cdx:ai:codegen properties at the document root
 * (`bomJson.properties`). If they are already present (for example, generated
 * with `-t ai-provenance`) the BOM is left untouched. Otherwise the target
 * directory is scanned and any detected properties are merged into the root
 * `properties` array.
 *
 * @param {Object} bomJson Generated CycloneDX BOM (mutated in place)
 * @param {Object} options CLI options
 */
export declare function ensureAiProvenanceProperties(bomJson: Object, options?: Object): void;
/**
 * Ensure the BOM carries cdx:ai:oversight properties at the document root
 * (`bomJson.properties`). If they are already present or AI codegen was not
 * detected, the BOM is left untouched.
 *
 * @param {Object} bomJson Generated CycloneDX BOM (mutated in place)
 * @param {Object} options CLI options
 */
export declare function ensureAiOversightProperties(bomJson: Object, options?: Object): Promise<void>;
/**
 * Mark the components whose name a caller has declared private.
 *
 * A private namespace or name prefix that shows up on a public registry is
 * the classic dependency-confusion setup: the build resolves the public
 * package because the private registry holds no copy. Components of the
 * npm, PyPI and Cargo purl types whose full name starts with one of the
 * configured prefixes carry a `cdx:<eco>:privateNamespace` property whose
 * value is the matched prefix, and the INT-017 to INT-019 rules report them.
 *
 * The prefixes match by prefix only, exactly as dep-scan's audit matched
 * them: `myorg` matches both the npm scope `@myorg` and a PyPI name that
 * starts with `myorg`.
 *
 * @param {Object} bomJson CycloneDX BOM (mutated in place)
 * @param {Object} options audit options with bomAuditPrivateNamespace
 * @returns {number} count of components marked
 */
export declare function applyPrivateNamespaceProperties(bomJson: Object, options?: Object): number;
/**
 * Audit BOM formulation section using JSONata-powered rule engine
 * @param {Object} bomJson - Generated CycloneDX BOM
 * @param {Object} options - CLI options
 * @returns {Promise<Array>} Array of audit findings
 */
export declare function auditBom(bomJson: Object, options: Object): Promise<any[]>;
/**
 * Format findings into a console report table.
 *
 * @param {Array} findings audit findings
 * @returns {string} console report table
 */
export declare function renderBomAuditConsoleReport(findings: any[]): string;
/**
 * Print BOM audit findings to the console.
 *
 * @param {Array} findings audit findings
 * @returns {string} rendered console output
 */
export declare function formatConsoleOutput(findings: any[]): string;
/**
 * Convert BOM audit findings to CycloneDX annotations.
 *
 * @param {Array} findings audit findings
 * @param {Object} bomJson generated CycloneDX BOM
 * @returns {Array} CycloneDX annotations
 */
export declare function formatAnnotations(findings: any[], bomJson: Object): any[];
/**
 * Check if any findings meet the severity threshold for secure mode failure
 */
export declare function hasCriticalFindings(findings: any, options: any): any;
//# sourceMappingURL=auditBom.d.ts.map