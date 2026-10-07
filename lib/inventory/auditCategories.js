import { shouldRunPredictiveBomAudit } from "../core/env.js";

/** Frozen list of hardware-bill-of-materials (HBOM) audit categories. */
export const HBOM_AUDIT_CATEGORIES = Object.freeze([
  "hbom-security",
  "hbom-performance",
  "hbom-compliance",
]);

/** Frozen list of cryptographic-bill-of-materials (CBOM) audit categories. */
export const CBOM_AUDIT_CATEGORIES = Object.freeze([
  "cbom-security",
  "cbom-compliance",
]);

/** Frozen list of host-topology audit categories. */
export const HOST_TOPOLOGY_AUDIT_CATEGORIES = Object.freeze(["host-topology"]);

/** Frozen list of Golem (Go Evinse) audit categories. */
export const GOLEM_AUDIT_CATEGORIES = Object.freeze([
  "golem-security",
  "golem-performance",
  "golem-compliance",
]);

/** Frozen list of Scala Evinse (scalasem) audit categories. */
export const SCALA_AUDIT_CATEGORIES = Object.freeze([
  "scala-security",
  "scala-compliance",
]);

/** Frozen list of Cargo (Rust) audit categories. */
export const CARGO_AUDIT_CATEGORIES = Object.freeze([
  "cargo-security",
  "cargo-compliance",
]);

/**
 * Frozen list of audit categories that never activate on their own. These
 * rule packs serve a specific feature (`--introspect` for build-fidelity) and
 * stay inactive unless the caller explicitly requests the category, so a
 * default `--bom-audit` run - which evaluates every loaded rule - cannot pick
 * them up.
 */
export const OPT_IN_BOM_AUDIT_CATEGORIES = Object.freeze(["build-fidelity"]);

/** Frozen list of AI-bill-of-materials audit categories. */
export const AI_BOM_AUDIT_CATEGORIES = Object.freeze([
  "ai-governance",
  "ai-security",
  "ai-performance",
]);

/** Comma-separated default HBOM category string used when none is specified. */
export const DEFAULT_HBOM_AUDIT_CATEGORIES = HBOM_AUDIT_CATEGORIES.join(",");

/**
 * Frozen map of category alias names to their expanded concrete category lists.
 * Used by `expandBomAuditCategories` to resolve shorthand aliases.
 */
export const BOM_AUDIT_CATEGORY_ALIASES = Object.freeze({
  "ai-inventory": ["ai-agent", "mcp-server"],
  aibom: [...AI_BOM_AUDIT_CATEGORIES, "ai-agent", "mcp-server"],
  "ai-bom": [...AI_BOM_AUDIT_CATEGORIES, "ai-agent", "mcp-server"],
  "ai-provenance": ["ai-provenance", "ai-oversight"],
  "ai-oversight": ["ai-oversight"],
  cargo: [...CARGO_AUDIT_CATEGORIES],
  cbom: [...CBOM_AUDIT_CATEGORIES],
  "crypto-bom": [...CBOM_AUDIT_CATEGORIES],
  golem: [...GOLEM_AUDIT_CATEGORIES],
  hbom: [...HBOM_AUDIT_CATEGORIES],
  rust: [...CARGO_AUDIT_CATEGORIES],
  scala: [...SCALA_AUDIT_CATEGORIES],
  host: [...HBOM_AUDIT_CATEGORIES, ...HOST_TOPOLOGY_AUDIT_CATEGORIES],
});

function uniqueNonEmptyCategories(categories) {
  return [...new Set((categories || []).filter(Boolean))];
}

/**
 * Normalize a category string or array into a deduplicated array of trimmed,
 * non-empty category names.
 *
 * @param {string|string[]} categories Comma-separated string or array of categories.
 * @returns {string[]} Deduplicated, trimmed category names.
 */
export function normalizeBomAuditCategories(categories) {
  if (Array.isArray(categories)) {
    return uniqueNonEmptyCategories(
      categories.map((category) => String(category).trim()).filter(Boolean),
    );
  }
  if (typeof categories !== "string") {
    return [];
  }
  return uniqueNonEmptyCategories(
    categories
      .split(",")
      .map((category) => category.trim())
      .filter(Boolean),
  );
}

/**
 * Expand category aliases into their concrete category lists, returning a
 * deduplicated array of resolved categories.
 *
 * @param {string|string[]} categories Comma-separated string or array of categories or aliases.
 * @returns {string[]} Deduplicated, fully expanded category names.
 */
export function expandBomAuditCategories(categories) {
  const normalizedCategories = normalizeBomAuditCategories(categories);
  const expandedCategories = [];
  for (const category of normalizedCategories) {
    if (BOM_AUDIT_CATEGORY_ALIASES[category]?.length) {
      expandedCategories.push(...BOM_AUDIT_CATEGORY_ALIASES[category]);
      continue;
    }
    expandedCategories.push(category);
  }
  return uniqueNonEmptyCategories(expandedCategories);
}

/**
 * Collect the sorted set of unique categories present in the loaded audit rules.
 *
 * @param {Array<{category?: string}>} rules Loaded audit rule objects.
 * @returns {string[]} Sorted unique category names found in the rules.
 */
export function availableBomAuditCategories(rules) {
  return uniqueNonEmptyCategories(
    (rules || []).map((rule) => rule?.category).filter(Boolean),
  ).sort();
}

function formatBomAuditCategoryOption(category) {
  const aliasedCategories = BOM_AUDIT_CATEGORY_ALIASES[category];
  if (!aliasedCategories?.length) {
    return category;
  }
  return `${category} (alias for ${aliasedCategories.join(",")})`;
}

/**
 * Validate that every requested category is a known category or alias,
 * throwing an Error listing the valid options otherwise.
 *
 * @param {string|string[]} categories Comma-separated string or array of categories to validate.
 * @param {Array<{category?: string}>} rules Loaded audit rule objects to derive valid categories from.
 * @returns {{categories: string[], expandedCategories: string[], validCategories: string[]}} Normalized, expanded, and valid category lists.
 */
export function validateBomAuditCategories(categories, rules) {
  const normalizedCategories = normalizeBomAuditCategories(categories);
  const validCategories = availableBomAuditCategories(rules);
  const allowedCategories = new Set([
    ...validCategories,
    ...Object.keys(BOM_AUDIT_CATEGORY_ALIASES),
  ]);
  const invalidCategories = normalizedCategories.filter(
    (category) => !allowedCategories.has(category),
  );
  if (invalidCategories.length) {
    const validCategoryOptions = [...allowedCategories]
      .sort()
      .map((category) => formatBomAuditCategoryOption(category));
    throw new Error(
      `Unknown BOM audit categor${invalidCategories.length === 1 ? "y" : "ies"}: ${invalidCategories.join(", ")}. Valid categories: ${validCategoryOptions.join(", ")}.`,
    );
  }
  return {
    categories: normalizedCategories,
    expandedCategories: expandBomAuditCategories(normalizedCategories),
    validCategories,
  };
}

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
export function getDefaultBomAuditCategories(options, commandPath) {
  const normalizedCommandPath = `${commandPath || ""}`.toLowerCase();
  const defaultHbomCategories = options?.includeRuntime
    ? `${DEFAULT_HBOM_AUDIT_CATEGORIES},host-topology`
    : DEFAULT_HBOM_AUDIT_CATEGORIES;
  if (normalizedCommandPath.includes("hbom")) {
    return defaultHbomCategories;
  }
  const projectTypes = Array.isArray(options?.projectType)
    ? options.projectType
    : typeof options?.projectType === "string"
      ? options.projectType.split(",")
      : [];
  const normalizedProjectTypes = projectTypes
    .map((projectType) => `${projectType || ""}`.trim().toLowerCase())
    .filter(Boolean);
  if (
    normalizedProjectTypes.length &&
    normalizedProjectTypes.every((projectType) =>
      ["hbom", "hardware"].includes(projectType),
    )
  ) {
    return defaultHbomCategories;
  }
  if (!shouldRunPredictiveBomAudit(options, commandPath)) {
    return "obom-runtime";
  }
  return undefined;
}
