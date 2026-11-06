/**
 * Render-side conversion of the 1.x definitions standards and the root
 * `declarations` (#/$defs/cyclonedx-standard-2.0 and
 * #/$defs/cyclonedx-declaration-2.0). Their members keep their names; the
 * 1.x `bom-ref` becomes `refId`, organizations and contacts take the 2.0
 * common shapes, attachments the 2.0 attachment, and a 1.x JSF `signature`
 * is counted and left out (see countSignatureDrop).
 */
/**
 * Convert 1.x definitions.standards
 * (#/$defs/cyclonedx-standard-2.0/$defs/standards). Requirement `parent`
 * and level `requirements` are refLinkType values; the refIds keep the
 * bom-ref values, so they still resolve.
 *
 * @param {object[]} standards 1.x standards
 * @param {object} stats Render counters
 * @returns {object[]|undefined} 2.0 standards
 */
export declare function convertStandards(standards: object[], stats: object): object[] | undefined;
/**
 * Render the root `declarations`
 * (#/$defs/cyclonedx-declaration-2.0/$defs/declarations).
 *
 * @param {object} declarations 1.x declarations
 * @param {object} stats Render counters
 * @returns {object|undefined} 2.0 declarations
 */
export declare function renderDeclarations(declarations: object, stats: object): object | undefined;
//# sourceMappingURL=cyclonedx20RenderDefinitions.d.ts.map