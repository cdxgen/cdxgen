/**
 * Returns the full catalog of compliance rules (SCVS + CRA).
 *
 * @returns {Array<object>}
 */
export function getAllComplianceRules(): Array<object>;
/**
 * Returns only SCVS rules.
 *
 * @returns {Array<object>}
 */
export function getScvsRules(): Array<object>;
/**
 * Returns only CRA rules.
 *
 * @returns {Array<object>}
 */
export function getCraRules(): Array<object>;
export namespace __test {
    export { componentLicenseId };
    export { inventoryComponents };
    export { looksLikeSpdx };
    export { collectReferencedRefs };
    export { compLabel };
}
/**
 * Extract the first SPDX-ish license id from a CycloneDX component's licenses
 * block. Returns null when no license is declared.
 *
 * @param {object} comp CycloneDX component
 * @returns {string | null}
 */
declare function componentLicenseId(comp: object): string | null;
/**
 * Collect libraries/frameworks/applications worth evaluating for inventory
 * checks. Crypto-assets and data types are excluded because they are tracked
 * with different schemas in CycloneDX.
 *
 * @param {object} bomJson
 * @returns {Array<object>}
 */
declare function inventoryComponents(bomJson: object): Array<object>;
/**
 * Validate that a license expression is syntactically a known SPDX identifier
 * or an expression built from SPDX operators. This is a best-effort check
 * that tokenises the expression first — avoiding backtracking-heavy regex
 * alternations — and then validates each token with a simple character-class
 * pattern.
 *
 * @param {string} expr
 * @returns {boolean}
 */
declare function looksLikeSpdx(expr: string): boolean;
/**
 * Build a Set of all bom-refs declared anywhere in the BOM so that we can
 * detect orphan components that are not reachable from the dependency tree.
 *
 * @param {object} bomJson
 * @returns {Set<string>}
 */
declare function collectReferencedRefs(bomJson: object): Set<string>;
/**
 * Format a component identifier for console messages.
 *
 * @param {object} comp
 * @returns {string}
 */
declare function compLabel(comp: object): string;
export {};
//# sourceMappingURL=complianceRules.d.ts.map