export function normalizeBomAuditCategories(categories: any): any[];
export function expandBomAuditCategories(categories: any): any[];
export function availableBomAuditCategories(rules: any): any[];
export function validateBomAuditCategories(categories: any, rules: any): {
    categories: any[];
    expandedCategories: any[];
    validCategories: any[];
};
export const HBOM_AUDIT_CATEGORIES: readonly string[];
export const DEFAULT_HBOM_AUDIT_CATEGORIES: string;
export const BOM_AUDIT_CATEGORY_ALIASES: Readonly<{
    "ai-inventory": string[];
    hbom: string[];
}>;
//# sourceMappingURL=auditCategories.d.ts.map