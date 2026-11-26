/** Set of purl types supported by the predictive audit (cargo, npm, pypi). */
declare const SUPPORTED_PURL_TYPES: Set<string>;
/**
 * Determine whether a CycloneDX component scope should be treated as required.
 *
 * Missing scope is treated as required to match the main BOM filtering flow.
 *
 * @param {string | undefined} scope component scope
 * @returns {boolean} true when the component is required for predictive audit selection
 */
export declare function isRequiredComponentScope(scope: string | undefined): boolean;
/**
 * Ask the public registries whether the names marked as private exist there.
 *
 * A private name the public registry holds is the dependency-confusion
 * setup: a resolver that finds no private copy falls back to whatever public
 * package claims the name. Each marked component of a BOM is asked about
 * once per name, and the answer is recorded on it as
 * `cdx:<type>:publicRegistry`: `true` when the public registry holds the
 * name, `false` when it answered that it does not, and no property when it
 * did not answer (a transport failure, another error status, or offline
 * mode, when nothing is asked at all). The rules that report the confusion
 * fire on `true` alone, so an unanswered name is never reported as taken and
 * never passes as free: the returned counts state how many were unanswered.
 *
 * @param {{ source: string, bomJson: object }[]} inputBoms loaded input BOMs whose
 *   components already carry the private-namespace mark
 * @param {{ offline?: boolean }} [options] `offline` asks nothing
 * @returns {Promise<{ matched: number, onPublicRegistry: number, notOnPublicRegistry: number, unknown: number }>} the counts
 */
export declare function checkPrivateNamesOnPublicRegistry(inputBoms: {
    source: string;
    bomJson: object;
}[], { offline }?: {
    offline?: boolean;
}): Promise<{
    matched: number;
    onPublicRegistry: number;
    notOnPublicRegistry: number;
    unknown: number;
}>;
/**
 * Count what a direct audit can ask the registries about a BOM, and how many
 * of those components a registry has answered.
 *
 * A component is eligible when its purl is one the lookups read (npm, PyPI,
 * Cargo) and names a version. It is answered when it carries a property only
 * a registry lookup writes; the rest were never looked up, are served from a
 * private index the public registry does not hold, or the lookup failed, and
 * the report says how many they are instead of letting the rules that read
 * registry metadata pass over them in silence.
 *
 * @param {object} bomJson CycloneDX BOM
 * @returns {{ components: number, eligible: number, answered: number, withoutMetadata: number }} the counts
 */
export declare function registryCoverage(bomJson: object): {
    components: number;
    eligible: number;
    answered: number;
    withoutMetadata: number;
};
/**
 * Enrich input BOM components with registry provenance/trusted-publishing
 * metadata so audit target filtering can exclude trusted packages even when the
 * input BOM was generated without --bom-audit.
 *
 * With `forDirectAudit`, the properties the direct audit's registry rules read
 * (package age, release recency, version presence, deprecation, yank, native
 * code) are copied back as well, and a component that already carries
 * trusted-publishing properties is looked up too.
 *
 * @param {{ source: string, bomJson: object }[]} inputBoms loaded input BOMs
 * @param {{ forDirectAudit?: boolean }} [options] what to copy back
 * @returns {Promise<void>}
 */
export declare function enrichInputBomsWithRegistryMetadata(inputBoms: {
    source: string;
    bomJson: object;
}[], { forDirectAudit }?: {
    forDirectAudit?: boolean;
}): Promise<void>;
/**
 * Normalize package names for safe matching and grouping.
 *
 * @param {string | undefined} packageName package name
 * @returns {string} normalized package name
 */
export declare function normalizePackageName(packageName: string | undefined): string;
/**
 * Extract npm and PyPI package-url targets from a CycloneDX BOM.
 *
 * @param {object} bomJson CycloneDX BOM
 * @param {string} sourceName source BOM path or label
 * @param {number | object | undefined} [options] selector options
 * @returns {{ targets: object[], skipped: object[] }} extracted targets and skipped components
 */
export declare function extractPurlTargetsFromBom(bomJson: object, sourceName: string, options?: number | object | undefined): {
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
export declare function collectAuditTargets(inputBoms: {
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
export { SUPPORTED_PURL_TYPES };
//# sourceMappingURL=targets.d.ts.map