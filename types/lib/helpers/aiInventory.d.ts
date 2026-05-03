export function inventoryPropertyValue(subject: any, name: any): any;
export function optionIncludesAiInventoryProjectType(optionValue: any, type: any): boolean;
export function inventoryTypesForSubject(subject: any): any[];
export function matchesAiInventoryType(subject: any, type: any): boolean;
export function matchesAiInventoryExcludeType(subject: any, type: any): boolean;
export function filterInventorySubjectsByTypes(subjects: any, types: any): any;
export function filterInventoryDependencies(dependencies: any, components: any, services: any): any;
export function collectAiInventory(discoveryPath: any, options: any, types: any): {
    components: any[];
    dependencies: any;
    services: Object[];
};
export function summarizeAiInventory(inventory: any): {
    instructionCount: any;
    mcpConfigCount: any;
    mcpServiceCount: any;
    skillCount: any;
};
export const AI_INVENTORY_PROJECT_TYPES: string[];
export const AI_INSTRUCTION_FILE_KINDS: Set<string>;
export const AI_SKILL_FILE_KIND: "skill-file";
export const MCP_CONFIG_FILE_KIND: "mcp-config";
//# sourceMappingURL=aiInventory.d.ts.map