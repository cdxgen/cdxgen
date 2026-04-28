/**
 * Determine whether a CycloneDX component scope should be treated as required.
 *
 * Missing scope is treated as required to match the main BOM filtering flow.
 *
 * @param {string | undefined} scope component scope
 * @returns {boolean} true when the component is required for predictive audit selection
 */
export function isRequiredComponentScope(scope: string | undefined): boolean;
/**
 * Normalize package names for safe matching and grouping.
 *
 * @param {string | undefined} packageName package name
 * @returns {string} normalized package name
 */
export function normalizePackageName(packageName: string | undefined): string;
/**
 * Extract npm and PyPI package-url targets from a CycloneDX BOM.
 *
 * @param {object} bomJson CycloneDX BOM
 * @param {string} sourceName source BOM path or label
 * @param {number | object | undefined} [options] selector options
 * @returns {{ targets: object[], skipped: object[] }} extracted targets and skipped components
 */
export function extractPurlTargetsFromBom(bomJson: object, sourceName: string, options?: number | object | undefined): {
    targets: object[];
    skipped: object[];
};
/**
 * Merge targets across many BOMs by purl.
 *
 * @param {{ source: string, bomJson: object }[]} inputBoms input BOMs
 * @param {number | object | undefined} [options] selector options or a legacy maxTargets value
 * @returns {{
 *   skipped: object[],
 *   stats: {
 *     availableTargets: number,
 *     nonRequiredTargets: number,
 *     requiredTargets: number,
 *     trustedTargets: number,
 *     trustedTargetsExcluded: number,
 *     truncatedTargets: number,
 *   },
 *   targets: object[],
 * }} merged targets and skipped components
 */
export function collectAuditTargets(inputBoms: {
    source: string;
    bomJson: object;
}[], options?: number | object | undefined): {
    skipped: object[];
    stats: {
        availableTargets: number;
        nonRequiredTargets: number;
        requiredTargets: number;
        trustedTargets: number;
        trustedTargetsExcluded: number;
        truncatedTargets: number;
    };
    targets: object[];
};
export const SUPPORTED_PURL_TYPES: Set<string>;
//# sourceMappingURL=targets.d.ts.map