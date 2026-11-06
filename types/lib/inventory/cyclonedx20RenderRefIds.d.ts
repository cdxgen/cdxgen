/**
 * Reference integrity of a rendered CycloneDX 2.0 document: every refId is
 * unique (the 2.0 refIdType rule "Every `refId` shall be unique within the
 * document", which JSON Schema cannot check), and dependency and
 * vulnerability references resolve to a declared refId or a BOM-Link.
 */
/**
 * Make every refId unique. The roots are walked in order, so the earliest
 * root keeps a repeated refId; pass the inventories before metadata so the
 * subject of a self-scan keeps its members when it repeats the refId of the
 * tool. A later declaration with an already declared refId becomes:
 *
 * - a componentReference or partyReference `{ref}` when it sits in a slot
 *   that accepts one and an earlier declaration of the same kind already
 *   holds every member it has (nothing is lost);
 * - nothing, in the definitions registry, under the same condition (counted
 *   as already declared), and also when an inventory declares the refId
 *   with other members (the members only the registry entry had are
 *   counted as dropped);
 * - unchanged, when neither it nor an earlier declaration sits in a
 *   component or party slot (counted);
 * - otherwise the same object under a new refId `<refId>-dup-<n>`, so no data
 *   is lost and references to the refId keep resolving to the first
 *   declaration.
 *
 * @param {Array<{section: string, value: *}>} roots Rendered sections, the
 *   definitions root marked with `section: "definitions"`
 * @param {object} stats Render counters
 */
export declare function dedupeRefIds(roots: Array<{
    section: string;
    value: any;
}>, stats: object): void;
/**
 * Keep only dependency references that resolve: an entry whose `ref` names
 * nothing declared is dropped, and so is each such `dependsOn` and
 * `provides` member. An emptied `dependsOn` stays, since an empty list says
 * the component has no dependencies.
 *
 * @param {object[]|undefined} dependencies Rendered dependencies
 * @param {Set<string>} declared Every declared refId
 * @param {object} stats Render counters
 * @returns {object[]|undefined} The dependencies left, or undefined
 */
export declare function resolveDependencyRefs(dependencies: object[] | undefined, declared: Set<string>, stats: object): object[] | undefined;
/**
 * Drop vulnerability `affects` entries whose `ref` resolves to nothing, and
 * an `affects` list left empty.
 *
 * @param {object[]|undefined} vulnerabilities Rendered vulnerabilities
 * @param {Set<string>} declared Every declared refId
 * @param {object} stats Render counters
 */
export declare function resolveAffectsRefs(vulnerabilities: object[] | undefined, declared: Set<string>, stats: object): void;
//# sourceMappingURL=cyclonedx20RenderRefIds.d.ts.map