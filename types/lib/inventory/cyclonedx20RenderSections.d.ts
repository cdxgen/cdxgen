/**
 * Render the CycloneDX 2.0 sections that sit beside the inventory:
 * compositions, annotations, citations, vulnerabilities and formulation.
 * Each converter restores an entry readCycloneDx20 kept as a shadow while
 * the entry is unchanged.
 */
/**
 * Render compositions (#/$defs/cyclonedx-composition-2.0/$defs/composition,
 * required `[kind, aggregate, targets]`). The composition's own 1.x
 * `bom-ref` (cdxgen sets it to the subject's bom-ref) is not carried, so it
 * cannot collide with the subject's refId.
 */
export declare function renderCompositions(compositions: any, inventory: any, carried: any, stats: any): any[] | undefined;
/**
 * Render annotations (#/$defs/cyclonedx-annotation-2.0/$defs/annotation,
 * required `[subjects, annotator, timestamp, text]`). Subjects are checked
 * against the declared refIds once the whole document exists
 * (see resolveAnnotationSubjects).
 */
export declare function renderAnnotations(annotations: any, stats: any): any[] | undefined;
/**
 * Render citations (#/$defs/cyclonedx-citation-2.0/$defs/citation).
 * `attributedTo` is a refLinkType, so it names a declared object's refId; the
 * cdxgen tool's bom-ref becomes exactly that refId. A citation may carry
 * `attributedTo`, `process` or both, so only the ref rename and the
 * expression rewrite are targeted.
 */
export declare function renderCitations(citations: any, usesInventory: any, stats: any): any[] | undefined;
/**
 * Render vulnerabilities: `bom-ref` → `refId`, `cwes` → `weaknesses`, the
 * tools object, credits as 2.0 organizations and contacts and the proof of
 * concept's attachments. Members 2.0 has no field for are counted; `affects`
 * references are resolved once every refId is known (resolveAffectsRefs).
 */
export declare function renderVulnerabilities(vulnerabilities: any, stats: any): any[] | undefined;
/**
 * formulation → workflows/tasks/triggers with refId renames. The 2.0 formula
 * allows only refId, properties and workflows
 * (#/$defs/cyclonedx-formulation-2.0/$defs/formula), so the 1.x
 * formula.components move to definitions.components (upstream's
 * valid-formulation-2.0.json declares them there too) and are collected in
 * `stats.formulaComponents`.
 */
export declare function convertFormulation(formulation: any, stats: any): any;
//# sourceMappingURL=cyclonedx20RenderSections.d.ts.map