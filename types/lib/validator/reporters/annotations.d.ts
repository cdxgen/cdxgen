/**
 * Render a set of findings into CycloneDX annotations.
 *
 * @param {Array<object>} findings Finding objects emitted by the validator or auditBom engine.
 * @param {object} bomJson Full CycloneDX BOM (needed for annotator/subject wiring).
 * @returns {Array<object>} CycloneDX annotation objects.
 */
export function buildAnnotations(findings: Array<object>, bomJson: object): Array<object>;
/**
 * Produce a new BOM object with findings embedded as annotations. The caller
 * is responsible for writing the result to disk.
 *
 * @param {object} bomJson
 * @param {Array<object>} findings
 * @returns {object}
 */
export function renderBom(bomJson: object, findings: Array<object>): object;
/**
 * Convenience wrapper matching the signature of the other reporters. The
 * second argument expects `{ bomJson }` because annotations are BOM-shaped,
 * not report-shaped.
 *
 * @param {object} report Output of validateBomAdvanced().
 * @param {object} options
 * @param {object} options.bomJson The BOM to annotate.
 * @returns {string} JSON string of the annotated BOM.
 */
export function render(report: object, options?: {
    bomJson: object;
}): string;
//# sourceMappingURL=annotations.d.ts.map