export function normalizeBomAuditCategories(categories: any): any[];
export function expandBomAuditCategories(categories: any): any[];
export function availableBomAuditCategories(rules: any): any[];
export function validateBomAuditCategories(categories: any, rules: any): {
    categories: any[];
    expandedCategories: any[];
    validCategories: any[];
};
export const HBOM_AUDIT_CATEGORIES: readonly string[];
export const CBOM_AUDIT_CATEGORIES: readonly string[];
export const HOST_TOPOLOGY_AUDIT_CATEGORIES: readonly string[];
export const GOLEM_AUDIT_CATEGORIES: readonly string[];
export const AI_BOM_AUDIT_CATEGORIES: readonly string[];
export const DEFAULT_HBOM_AUDIT_CATEGORIES: string;
export const BOM_AUDIT_CATEGORY_ALIASES: Readonly<{
    "ai-inventory": string[];
    aibom: string[];
    "ai-bom": string[];
    cbom: string[];
    "crypto-bom": string[];
    golem: string[];
    hbom: string[];
    host: string[];
}>;
//# sourceMappingURL=auditCategories.d.ts.map