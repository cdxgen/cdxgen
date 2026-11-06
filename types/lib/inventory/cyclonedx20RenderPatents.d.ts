/**
 * Render-side conversion of 1.x patents, patent families and patent
 * assertions (#/$defs/cyclonedx-patent-2.0). The members are the same; the
 * 1.x `bom-ref` becomes `refId`, and organizations and contacts take the
 * 2.0 common shapes.
 */
/**
 * Convert 1.x definitions.patents: patents and patent families.
 *
 * @param {object[]} patents 1.x patents and patent families
 * @param {object} stats Render counters
 * @returns {object[]|undefined} 2.0 patents
 */
export declare function convertPatents(patents: object[], stats: object): object[] | undefined;
/**
 * Convert 1.x patentAssertions
 * (#/$defs/cyclonedx-patent-2.0/$defs/patentAssertions): the asserter is an
 * organization, a contact or a refLinkType string.
 *
 * @param {object[]} assertions 1.x patent assertions
 * @param {object} stats Render counters
 * @returns {object[]|undefined} 2.0 patent assertions, or undefined when
 *   none is left
 */
export declare function convertPatentAssertions(assertions: object[], stats: object): object[] | undefined;
//# sourceMappingURL=cyclonedx20RenderPatents.d.ts.map