/**
 * Epoch milliseconds of an ISO 8601 date or date-time, or undefined when the
 * value is not one. A date and time without a zone is read as UTC.
 *
 * @param {unknown} value timestamp
 * @returns {number | undefined} epoch milliseconds
 */
export declare function parseTimeMillis(value: unknown): number | undefined;
/**
 * Parse a certificate notValidAfter value.
 *
 * @param {*} value timestamp or date-only string
 * @returns {number|undefined} epoch milliseconds, or undefined when the value
 *   does not parse
 */
export declare function parseCertificateEndMillis(value: any): number | undefined;
export declare function loadRules(rulesDir: any): Promise<any[]>;
/**
 * Evaluate a single rule against the BOM using JSONata
 * @param {Object} rule - Parsed rule object
 * @param {Object} bomJson - Full CycloneDX BOM object
 * @param {Object} [baseOptions] - Helpers for the rules, such as `getBomWithOras`
 * @returns {Promise<Array>} Array of matched findings
 */
export declare function evaluateRule(rule: Object, bomJson: Object, baseOptions?: Object): Promise<any[]>;
/**
 * Evaluate all rules against a BOM
 */
export declare function evaluateRules(rules: any, bomJson: any, options?: {}): Promise<any[]>;
//# sourceMappingURL=ruleEngine.d.ts.map