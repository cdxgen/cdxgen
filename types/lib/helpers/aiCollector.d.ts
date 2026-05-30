/**
 * Collect AI-related inventory from JavaScript and TypeScript sources.
 *
 * @param {string} discoveryPath directory or file being analyzed
 * @param {Object} [options={}] collection options
 * @returns {{ components: Object[], dependencies: Object[], services: Object[] }} AI inventory
 */
export function collectJsAiInventory(discoveryPath: string, options?: Object): {
    components: Object[];
    dependencies: Object[];
    services: Object[];
};
/**
 * Collect AI inventory from local Hugging Face repository metadata files.
 *
 * @param {string} discoveryPath directory or file being analyzed
 * @param {Object} [options={}] collection options
 * @returns {{ components: Object[], dependencies: Object[], services: Object[] }} AI inventory
 */
export function collectHuggingFaceRepoAiInventory(discoveryPath: string, options?: Object): {
    components: Object[];
    dependencies: Object[];
    services: Object[];
};
/**
 * Collect AI-related inventory from Python sources.
 *
 * @param {string} discoveryPath directory or file being analyzed
 * @param {Object} [options={}] collection options
 * @returns {{ components: Object[], dependencies: Object[], services: Object[] }} AI inventory
 */
export function collectPythonAiInventory(discoveryPath: string, options?: Object): {
    components: Object[];
    dependencies: Object[];
    services: Object[];
};
/**
 * Collect AI-related inventory from notebook sources.
 *
 * @param {string} discoveryPath directory or file being analyzed
 * @param {Object} [options={}] collection options
 * @returns {{ components: Object[], dependencies: Object[], services: Object[] }} AI inventory
 */
export function collectNotebookAiInventory(discoveryPath: string, options?: Object): {
    components: Object[];
    dependencies: Object[];
    services: Object[];
};
/**
 * Collect AI-related inventory from prompt and agent configuration files.
 *
 * @param {string} discoveryPath directory or file being analyzed
 * @param {Object} [options={}] collection options
 * @returns {{ components: Object[], dependencies: Object[], services: Object[] }} AI inventory
 */
export function collectPromptConfigAiInventory(discoveryPath: string, options?: Object): {
    components: Object[];
    dependencies: Object[];
    services: Object[];
};
//# sourceMappingURL=aiCollector.d.ts.map