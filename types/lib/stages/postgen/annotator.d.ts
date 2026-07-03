/**
 * Method to determine the type of the BOM.
 *
 * @param {Object} bomJson BOM JSON Object
 *
 * @returns {String} Type of the bom such as sbom, cbom, obom, ml-bom etc
 */
export function findBomType(bomJson: Object): string;
/**
 * Create the textual representation of the metadata section.
 *
 * @param {Object} bomJson BOM JSON Object
 *
 * @returns {String | undefined} Textual representation of the metadata
 */
export function textualMetadata(bomJson: Object): string | undefined;
/**
 * Build a human-readable summary of AI authorship provenance and human-oversight
 * rigor from the BOM's root `properties`. Returns an empty string when no
 * cdx:ai:codegen provenance was detected.
 *
 * @param {Object} bomJson CycloneDX BOM
 * @returns {string} Summary sentence(s), or "" when no AI provenance is present
 */
export function summarizeAiProvenance(bomJson: Object): string;
/**
 * Extract interesting tags from the component attribute
 *
 * @param {Object} component CycloneDX component
 * @param {String} bomType BOM type
 * @param {String} parentComponentType Parent component type
 *
 * @returns {Array | undefined} Array of string tags
 */
export function extractTags(component: Object, bomType?: string, parentComponentType?: string): any[] | undefined;
//# sourceMappingURL=annotator.d.ts.map