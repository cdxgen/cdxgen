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
 * The name a public registry knows a component by, read from its purl and,
 * when the purl does not parse, from its group and name.
 *
 * An npm scope always carries its `@` (`@acme`), whichever spelling the purl
 * or the group used. Only npm, PyPI and Cargo components have one.
 *
 * @param {Object} component CycloneDX component
 * @returns {{ type: string, scope: string | undefined, name: string, fullName: string } | undefined}
 *   the registry name, or undefined for another type or no name
 */
export declare function componentRegistryName(component: Object): {
    type: string;
    scope: string | undefined;
    name: string;
    fullName: string;
} | undefined;
/**
 * Whether a configured private namespace or name prefix names a component.
 *
 * - npm: a prefix that names a scope (`@acme`) matches that scope exactly,
 *   and so does a bare prefix (`acme`) for a scoped package. A prefix with a
 *   scope and a name part (`@acme/internal-`) matches the full name at a
 *   separator boundary. A bare prefix matches an unscoped name exactly or at
 *   a separator boundary (`-`, `_`, `.`, `/`): `acme` matches `acme` and
 *   `acme-client`, never `acmecorp` or `@acmecorp/x`.
 * - PyPI: both sides are compared after PEP 503 normalisation, at a
 *   separator boundary: `acme` matches `acme_internal` and `Acme.Tools`.
 * - Cargo: both sides are compared with `_` read as `-`, at a separator
 *   boundary, as crates.io compares names.
 *
 * @param {string} prefix configured prefix
 * @param {{ type: string, scope?: string, name: string, fullName: string }} registryName
 *   see {@link componentRegistryName}
 * @returns {boolean} whether the prefix names the component
 */
export declare function matchesPrivateNamespace(prefix: string, registryName: {
    type: string;
    scope?: string;
    name: string;
    fullName: string;
}): boolean;
/**
 * Mark the components whose name a caller has declared private.
 *
 * A private namespace or name prefix that shows up on a public registry is
 * the classic dependency-confusion setup: the build resolves the public
 * package because the private registry holds no copy. Components of the
 * npm, PyPI and Cargo purl types whose registry name a configured prefix
 * names (see {@link matchesPrivateNamespace}) carry a
 * `cdx:<eco>:privateNamespace` property whose value is the matched prefix.
 * The INT-017 to INT-019 rules report a marked component only once the
 * public registry has said it holds the name (`cdx:<eco>:publicRegistry`),
 * which this function does not ask about.
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