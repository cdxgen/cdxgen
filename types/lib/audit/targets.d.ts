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
 * @returns {{ targets: object[], skipped: object[] }} extracted targets and skipped components
 */
export function extractPurlTargetsFromBom(bomJson: object, sourceName: string): {
    targets: object[];
    skipped: object[];
};
/**
 * Merge targets across many BOMs by purl.
 *
 * @param {{ source: string, bomJson: object }[]} inputBoms input BOMs
 * @param {number | undefined} maxTargets optional upper bound for target count
 * @returns {{ targets: object[], skipped: object[] }} merged targets and skipped components
 */
export function collectAuditTargets(inputBoms: {
    source: string;
    bomJson: object;
}[], maxTargets: number | undefined): {
    targets: object[];
    skipped: object[];
};
export const SUPPORTED_PURL_TYPES: Set<string>;
//# sourceMappingURL=targets.d.ts.map