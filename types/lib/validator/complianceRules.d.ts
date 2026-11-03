/**
 * Internal compliance rule catalog for cdx-validate.
 *
 * Implements OWASP SCVS (Software Component Verification Standard) controls
 * and selected EU Cyber Resilience Act (CRA) SBOM expectations as plain
 * JavaScript evaluators. Controls that are not automatable from a static
 * CycloneDX BOM (for example, process or organizational controls) are still
 * modelled so that benchmark reports can surface them as "manual review
 * required" items with a stable identifier.
 *
 * Each rule exports:
 *   id            - Stable short identifier (e.g. "SCVS-1.1").
 *   name          - Human readable short name.
 *   description   - Long description (wording taken from the source standard).
 *   standard      - Source standard key: "SCVS", "CRA" or "CISA".
 *   standardRefs  - Array of canonical control identifiers.
 *   category      - Grouping used by --categories.
 *   severity      - Severity emitted for a failing automatable rule.
 *   scvsLevels    - For SCVS rules, the levels (L1/L2/L3) that require the
 *                   control. Non-SCVS rules use an empty array.
 *   automatable   - True when evaluate() returns a deterministic pass/fail
 *                   from the BOM alone. False means the rule is emitted as
 *                   severity "info" / status "manual" so downstream tooling
 *                   can track coverage.
 *   evaluate      - Function(bomJson) => RuleResult.
 *
 * RuleResult shape:
 *   {
 *     status: "pass" | "fail" | "manual",
 *     message: string,              // human readable summary
 *     mitigation?: string,
 *     locations?: Array<{ bomRef?, purl?, file? }>,
 *     evidence?: Record<string, any>
 *   }
 */
/**
 * Returns the full catalog of compliance rules (SCVS + CRA + CISA).
 *
 * @returns {Array<object>}
 */
export declare function getAllComplianceRules(): Array<object>;
/**
 * Returns only SCVS rules.
 *
 * @returns {Array<object>}
 */
export declare function getScvsRules(): Array<object>;
/**
 * Returns only CRA rules.
 *
 * @returns {Array<object>}
 */
export declare function getCraRules(): Array<object>;
/**
 * Returns only CISA 2026 minimum elements rules.
 *
 * @returns {Array<object>}
 */
export declare function getCisaRules(): Array<object>;
/**
 * Returns only the CISA and G7 AI SBOM element rules.
 *
 * @returns {Array<object>}
 */
export declare function getCisaAiRules(): Array<object>;
/**
 * Test-only export exposing internal helper functions for unit tests.
 * Double-underscore prefixed to discourage external use.
 *
 * @type {Object}
 */
export declare const __test: Object;
//# sourceMappingURL=complianceRules.d.ts.map