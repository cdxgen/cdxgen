export const HBOM_AUDIT_CATEGORIES = Object.freeze([
  "hbom-security",
  "hbom-performance",
  "hbom-compliance",
]);

export const HOST_TOPOLOGY_AUDIT_CATEGORIES = Object.freeze(["host-topology"]);

export const DEFAULT_HBOM_AUDIT_CATEGORIES = HBOM_AUDIT_CATEGORIES.join(",");

export const BOM_AUDIT_CATEGORY_ALIASES = Object.freeze({
  "ai-inventory": ["ai-agent", "mcp-server"],
  hbom: [...HBOM_AUDIT_CATEGORIES],
  host: [...HBOM_AUDIT_CATEGORIES, ...HOST_TOPOLOGY_AUDIT_CATEGORIES],
});

function uniqueNonEmptyCategories(categories) {
  return [...new Set((categories || []).filter(Boolean))];
}

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
