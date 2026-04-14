/**
 * Filter and enhance BOM post generation.
 *
 * @param {Object} bomNSData BOM with namespaces object
 * @param {Object} options CLI options
 *
 * @returns {Object} Modified bomNSData
 */
export function postProcess(bomNSData: Object, options: Object): Object;
/**
 * Apply additional metadata based on components
 *
 * @param {Object} bomJson BOM JSON Object
 * @param {Object} options CLI options
 *
 * @returns {Object} Filtered BOM JSON
 */
export function applyMetadata(bomJson: Object, options: Object): Object;
/**
 * Apply definitions.standards based on options
 *
 * @param {Object} bomJson BOM JSON Object
 * @param {Object} options CLI options
 *
 * @returns {Object} Filtered BOM JSON
 */
export function applyStandards(bomJson: Object, options: Object): Object;
/**
 * Filter BOM based on options
 *
 * @param {Object} bomJson BOM JSON Object
 * @param {Object} options CLI options
 *
 * @returns {Object} Filtered BOM JSON
 */
export function filterBom(bomJson: Object, options: Object): Object;
/**
 * Clean up
 */
export function cleanupEnv(_options: any): void;
/**
 * Removes the cdxgen temporary directory if it was created inside the system
 * temp directory (as indicated by `CDXGEN_TMP_DIR`). No-ops when the variable
 * is unset or points outside the system temp directory.
 *
 * @returns {void}
 */
export function cleanupTmpDir(): void;
/**
 * Annotate the document with annotator
 *
 * @param {Object} bomJson BOM JSON Object
 * @param {Object} options CLI options
 *
 * @returns {Object} Annotated BOM JSON
 */
export function annotate(bomJson: Object, options: Object): Object;
//# sourceMappingURL=postgen.d.ts.map