/**
 * Read a CycloneDX 2.0 document into the 1.x-shaped internal model. The
 * public entry point is re-exported from cyclonedx20.js.
 *
 * Where definitions.components entries go (2.0 records no membership, so the
 * rule is fixed and deterministic, applied in document order):
 *
 * 0. An entry whose refId a formula lists in its
 *    `cdx:formulation:componentRefs` property (a JSON array of refIds, which
 *    renderCycloneDx20 writes for a subject-less document) is a component of
 *    every formula that lists it.
 * 1. An entry whose refId a formula references (a `ref` member, such as a
 *    resource reference, anywhere in its tree) is a component of the first
 *    such formula. Other strings that happen to equal the refId, such as a
 *    task type, do not count.
 * 2. In a document with inventories, an entry a componentReference the
 *    reader resolves points to (from an inventory, a tool, an annotator, a
 *    vulnerability or another definitions component) stays in definitions
 *    (kept for 2.0 output); its content reaches 1.x through the referencing
 *    entries.
 * 3. In a document with inventories, any other entry is a formula component
 *    when the document has a formulation (the renderer moves 1.x
 *    formula.components there), and otherwise stays in definitions with a
 *    loss: 1.x has no home for it.
 * 4. In a document without inventories (the renderer puts a subject-less
 *    document's components there), any other entry is a root component.
 *    Entries without a refId follow the same rules and are never dropped.
 * 5. Before all of these, an entry whose type 1.x does not have (`material`)
 *    stays in definitions with a loss.
 */
/**
 * Read a 2.0 document into the internal 1.x-shaped model. Never throws on a
 * schema-valid 2.0 document. Objects nested deeper than MAX_READ_DEPTH are
 * left out, each with a loss. The returned model carries the internal model
 * mark (markInternalModel), which loadBomForAnalysis checks. Every member the reader sees but cannot carry
 * into 1.x is reported in `losses` as `{pointer, reason}`, where `pointer` is
 * an RFC 6901 JSON pointer into the input. Objects whose 1.x form would not
 * render back to the same 2.0 object are kept under the internal sections
 * key, so renderCycloneDx20 restores them while they are unchanged.
 *
 * @param {object} bom20 BOM in the 2.0 shape
 * @returns {{internalBom: object, losses: Array<{pointer: string, reason: string}>}}
 */
export declare function readCycloneDx20(bom20: object): {
    internalBom: object;
    losses: Array<{
        pointer: string;
        reason: string;
    }>;
};
//# sourceMappingURL=cyclonedx20Read.d.ts.map