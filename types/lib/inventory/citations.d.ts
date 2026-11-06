/**
 * Build a schema-valid CycloneDX 1.7 citation object.
 *
 * Either `pointers` or `expressions` must be supplied (mutually exclusive), and
 * either `attributedTo` or `process` must be supplied. The caller is expected to
 * pass the bom-ref of an entity that actually exists in the BOM; this helper
 * does not fabricate refs.
 *
 * @param {Object} input Citation fields
 * @param {string[]} [input.pointers] JSON Pointer strings (RFC 6901) targeting the attributed fields
 * @param {string[]} [input.expressions] JSONPath strings (RFC 9535) targeting the attributed fields
 * @param {string} [input.attributedTo] bom-ref of the component/service/tool/entity that supplied the data
 * @param {string} [input.process] bom-ref of a formulation process that produced the data
 * @param {string} [input.bomRef] Optional bom-ref for the citation itself
 * @param {string} [input.note] Free-form context or quality note
 * @param {string} [input.timestamp] ISO-8601 timestamp; defaults to now. Pass
 *   `citationTimestamp(bomJson)` so repeated renders of one BOM agree.
 * @returns {Object|null} A citation object, or null when the required oneOf/anyOf pairs are not satisfied
 */
export declare function createCitation({ pointers, expressions, attributedTo, process, bomRef, note, timestamp, }?: {
    pointers?: string[];
    expressions?: string[];
    attributedTo?: string;
    process?: string;
    bomRef?: string;
    note?: string;
    timestamp?: string;
}): Object | null;
/**
 * Merge two citation arrays, dropping exact duplicates. When two citations share
 * an identity but differ in note/bom-ref, the first one wins and the second is
 * discarded to keep the array small and stable.
 *
 * @param {Object[]} existing Citations already present on the BOM
 * @param {Object[]} additions Citations produced by a collector
 * @returns {Object[]} De-duplicated citation array
 */
export declare function mergeCitations(existing?: Object[], additions?: Object[]): Object[];
/**
 * Collect the bom-refs of all tool components recorded under metadata.tools.
 * Tool components are the natural attribution target for data that cdxgen
 * itself produced or resolved.
 *
 * @param {Object} bomJson CycloneDX BOM
 * @returns {string[]} bom-ref strings, in document order
 */
export declare function collectToolBomRefs(bomJson: Object): string[];
/**
 * Resolve the bom-ref of the cdxgen tool component, if present. This is the
 * canonical attribution target for inventory that cdxgen collected itself.
 *
 * The tool component named "cdxgen" wins; a bare bom-ref (legacy array-style
 * tools) counts when it is cdxgen's own npm purl. A helper whose bom-ref only
 * mentions cdxgen, such as a cdxgen-plugins-bin tool like trustinspector, is
 * never the cdxgen tool.
 *
 * @param {Object} bomJson CycloneDX BOM
 * @returns {string|undefined} bom-ref of the cdxgen tool, or undefined
 */
export declare function findCdxgenToolBomRef(bomJson: Object): string | undefined;
/**
 * The timestamp every citation on a document shares. Deriving it from the
 * document rather than the clock keeps two renders of one BOM identical, the
 * same rule the annotator follows.
 *
 * @param {Object} bomJson CycloneDX BOM
 * @returns {string} ISO-8601 timestamp
 */
export declare function citationTimestamp(bomJson: Object): string;
/**
 * Attach a citations array to the BOM root, but only when the spec version can
 * carry it. At 1.6 and below the field is not allowed and the downgrade path
 * strips it; this guard keeps callers from emitting data that would immediately
 * be removed.
 *
 * @param {Object} bomJson CycloneDX BOM (mutated)
 * @param {Object[]} citations Citations to attach
 * @param {Object} options CLI options (for specVersion)
 * @returns {Object} The mutated BOM
 */
export declare function attachCitations(bomJson: Object, citations: Object[], options?: Object): Object;
/**
 * Build a citation that attributes the BOM's component inventory to the cdxgen
 * tool. This is the baseline provenance statement: cdxgen collected the
 * components, so the inventory is attributed to cdxgen's tool component.
 *
 * @param {Object} bomJson CycloneDX BOM (read for the tool bom-ref)
 * @param {Object} [context] Extra context
 * @param {string} [context.note] Optional note appended to the attribution
 * @returns {Object|null} A citation, or null when no cdxgen tool is referenced
 */
export declare function buildInventoryCitation(bomJson: Object, context?: {
    note?: string;
}): Object | null;
//# sourceMappingURL=citations.d.ts.map