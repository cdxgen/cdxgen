/**
 * Read a property value from an inventory subject.
 *
 * @param {Object} subject component or service
 * @param {string} name property name
 * @returns {string|undefined} matching property value
 */
export function inventoryPropertyValue(subject: Object, name: string): string | undefined;
/**
 * Determine whether CLI project type options include an AI inventory selector.
 *
 * @param {string|string[]|undefined} optionValue raw CLI option value
 * @param {string} type AI inventory type
 * @returns {boolean} true when the requested type is enabled
 */
export function optionIncludesAiInventoryProjectType(optionValue: string | string[] | undefined, type: string): boolean;
/**
 * Classify an inventory subject into AI inventory types.
 *
 * @param {Object} subject component or service
 * @returns {string[]} matching inventory types
 */
export function inventoryTypesForSubject(subject: Object): string[];
/**
 * Check whether a subject belongs to a specific AI inventory type.
 *
 * @param {Object} subject component or service
 * @param {string} type AI inventory type
 * @returns {boolean} true when the subject matches
 */
export function matchesAiInventoryType(subject: Object, type: string): boolean;
/**
 * Check whether a subject should be excluded by an AI inventory type filter.
 *
 * @param {Object} subject component or service
 * @param {string} type AI inventory type
 * @returns {boolean} true when the subject matches the exclusion
 */
export function matchesAiInventoryExcludeType(subject: Object, type: string): boolean;
/**
 * Filter components or services by requested AI inventory types.
 *
 * @param {Object[]} subjects inventory subjects
 * @param {string[]} types allowed AI inventory types
 * @returns {Object[]} filtered subjects
 */
export function filterInventorySubjectsByTypes(subjects: Object[], types: string[]): Object[];
/**
 * Filter dependency edges to include only retained AI inventory subjects.
 *
 * @param {Object[]} dependencies dependency edges
 * @param {Object[]} components retained components
 * @param {Object[]} services retained services
 * @returns {Object[]} filtered dependency edges
 */
export function filterInventoryDependencies(dependencies: Object[], components: Object[], services: Object[]): Object[];
/**
 * Collect AI inventory subjects and dependency edges for the requested types.
 *
 * @param {string} discoveryPath directory or file being analyzed
 * @param {Object} options collection options
 * @param {string[]} types requested inventory types
 * @returns {{ components: Object[], dependencies: Object[], services: Object[] }} AI inventory
 */
export function collectAiInventory(discoveryPath: string, options: Object, types: string[]): {
    components: Object[];
    dependencies: Object[];
    services: Object[];
};
/**
 * Summarize collected AI inventory counts for reporting.
 *
 * @param {{ components?: Object[], services?: Object[] }} inventory collected AI inventory
 * @returns {{
 *   aiComponentCount: number,
 *   aiServiceCount: number,
 *   instructionCount: number,
 *   mcpConfigCount: number,
 *   skillComponentCount: number,
 * }} summary counts
 */
export function summarizeAiInventory(inventory: {
    components?: Object[];
    services?: Object[];
}): {
    aiComponentCount: number;
    aiServiceCount: number;
    instructionCount: number;
    mcpConfigCount: number;
    skillComponentCount: number;
};
export const AI_INVENTORY_PROJECT_TYPES: string[];
export const AI_INSTRUCTION_FILE_KINDS: Set<string>;
export const AI_SKILL_FILE_KIND: "skill-file";
export const MCP_CONFIG_FILE_KIND: "mcp-config";
//# sourceMappingURL=aiInventory.d.ts.map