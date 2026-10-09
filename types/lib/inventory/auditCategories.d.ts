/** Frozen list of hardware-bill-of-materials (HBOM) audit categories. */
export declare const HBOM_AUDIT_CATEGORIES: readonly string[];
/** Frozen list of cryptographic-bill-of-materials (CBOM) audit categories. */
export declare const CBOM_AUDIT_CATEGORIES: readonly string[];
/** Frozen list of host-topology audit categories. */
export declare const HOST_TOPOLOGY_AUDIT_CATEGORIES: readonly string[];
/** Frozen list of Golem (Go Evinse) audit categories. */
export declare const GOLEM_AUDIT_CATEGORIES: readonly string[];
/** Frozen list of Scala Evinse (scalasem) audit categories. */
export declare const SCALA_AUDIT_CATEGORIES: readonly string[];
/** Frozen list of Cargo (Rust) audit categories. */
export declare const CARGO_AUDIT_CATEGORIES: readonly string[];
/**
 * Frozen list of audit categories that never activate on their own. These
 * rule packs serve a specific feature (`--introspect` for build-fidelity) and
 * stay inactive unless the caller explicitly requests the category, so a
 * default `--bom-audit` run - which evaluates every loaded rule - cannot pick
 * them up.
 */
export declare const OPT_IN_BOM_AUDIT_CATEGORIES: readonly string[];
/** Frozen list of AI-bill-of-materials audit categories. */
export declare const AI_BOM_AUDIT_CATEGORIES: readonly string[];
/** Comma-separated default HBOM category string used when none is specified. */
export declare const DEFAULT_HBOM_AUDIT_CATEGORIES: string;
/**
 * Frozen map of category alias names to their expanded concrete category lists.
 * Used by `expandBomAuditCategories` to resolve shorthand aliases.
 */
export declare const BOM_AUDIT_CATEGORY_ALIASES: Readonly<{
    "ai-inventory": string[];
    aibom: string[];
    "ai-bom": string[];
    "ai-provenance": string[];
    "ai-oversight": string[];
    cargo: string[];
    cbom: string[];
    "crypto-bom": string[];
    golem: string[];
    hbom: string[];
    rust: string[];
    scala: string[];
    host: string[];
}>;
/**
 * Normalize a category string or array into a deduplicated array of trimmed,
 * non-empty category names.
 *
 * @param {string|string[]} categories Comma-separated string or array of categories.
 * @returns {string[]} Deduplicated, trimmed category names.
 */
export declare function normalizeBomAuditCategories(categories: string | string[]): string[];
/**
 * Expand category aliases into their concrete category lists, returning a
 * deduplicated array of resolved categories.
 *
 * @param {string|string[]} categories Comma-separated string or array of categories or aliases.
 * @returns {string[]} Deduplicated, fully expanded category names.
 */
export declare function expandBomAuditCategories(categories: string | string[]): string[];
/**
 * Collect the sorted set of unique categories present in the loaded audit rules.
 *
 * @param {Array<{category?: string}>} rules Loaded audit rule objects.
 * @returns {string[]} Sorted unique category names found in the rules.
 */
export declare function availableBomAuditCategories(rules: Array<{
    category?: string;
}>): string[];
/**
 * Validate that every requested category is a known category or alias,
 * throwing an Error listing the valid options otherwise.
 *
 * @param {string|string[]} categories Comma-separated string or array of categories to validate.
 * @param {Array<{category?: string}>} rules Loaded audit rule objects to derive valid categories from.
 * @returns {{categories: string[], expandedCategories: string[], validCategories: string[]}} Normalized, expanded, and valid category lists.
 */
export declare function validateBomAuditCategories(categories: string | string[], rules: Array<{
    category?: string;
}>): {
    categories: string[];
    expandedCategories: string[];
    validCategories: string[];
};
/**
 * Determine the default BOM audit categories for the current CLI invocation.
 *
 * OBOM-focused runs should default to the runtime-specific rule pack unless the
 * user explicitly requests other categories.
 *
 * @param {object} options CLI options
 * @param {string} [commandPath] Invoked command path or name
 * @returns {string | undefined} Default category string, if any
 */
export declare function getDefaultBomAuditCategories(options: object, commandPath?: string): string | undefined;
//# sourceMappingURL=auditCategories.d.ts.map