/**
 * Reader converters for the CycloneDX 2.0 document sections other than the
 * inventories: metadata, compositions, annotations, vulnerabilities,
 * citations and formulation. Each frozen spec is the allowlist of the
 * members 1.x carries; everything else is a loss. Every converted section
 * entry is kept as a shadow, so a read-then-render round trip restores the
 * 2.0 members the 1.x model has no field for while the entry is unchanged.
 */
/**
 * metadata → 1.x metadata without `component` (the inventory subject) and
 * `tools` (read separately, so each tool component has its own shadow).
 *
 * @param {object} ctx Reader context
 * @param {object} metadata 2.0 metadata
 * @returns {object} 1.x metadata
 */
export declare function readMetadata(ctx: object, metadata: object): object;
/**
 * compositions → 1.x compositions.
 *
 * @param {object} ctx Reader context
 * @param {Array} compositions 2.0 compositions
 * @param {Map<string, string|undefined>} inventorySubjects inventory refId →
 *   subject refId
 * @returns {Array|undefined} 1.x compositions
 */
export declare function readCompositions(ctx: object, compositions: any[], inventorySubjects: Map<string, string | undefined>): any[] | undefined;
/** annotations → 1.x annotations. */
export declare function readAnnotations(ctx: any, annotations: any): any[] | undefined;
/** vulnerabilities → 1.x vulnerabilities. */
export declare function readVulnerabilities(ctx: any, vulnerabilities: any): any[] | undefined;
/** A 2.0 citation JSONPath expression → its 1.x form. */
export declare function reverseCitationExpression(expression: any): any;
/** citations → 1.x citations. */
export declare function readCitations(ctx: any, citations: any): any[] | undefined;
/**
 * formulation → 1.x formulas without their components (the reader puts the
 * formula components back from definitions afterwards).
 *
 * @param {object} ctx Reader context
 * @param {Array} formulation 2.0 formulation
 * @returns {Array|undefined} 1.x formulas
 */
export declare function readFormulation(ctx: object, formulation: any[]): any[] | undefined;
//# sourceMappingURL=cyclonedx20ReadSections.d.ts.map