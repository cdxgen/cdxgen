/**
 * Hardware components at 2.0 (cdxgen/cdxgen#4755). What each `cdx:hbom:*`
 * property means in the 2.0 draft is owned by @cdxgen/cdx-hbom, whose
 * optional `./cdx20` export provides `toCdx20HardwareComponent(component,
 * {partyRefId, includeSensitiveIdentifiers, identifierPolicy})`. The caller
 * loads it (lib/inventory/hbomLoader.js: hardwareRenderContext) and passes
 * it, with those options, to renderCycloneDx20 in the render context, so the
 * render stays a pure function of its arguments.
 *
 * The renderer converts the component as usual and then takes only these
 * members from the mapper's result, each checked against the pinned schema:
 *
 * - `identifiers`: only groups asserted by the party the renderer passed
 *   (the one its own identifiers use, which it declares when referenced).
 *   Their identities are appended to that party's group, or added as a new
 *   group, so a purl identity is never replaced. Only identities with a
 *   scheme from the identityScheme enum (or a custom `{name}`) and a
 *   non-empty value are taken.
 * - `classification` (#/$defs/cyclonedx-physical-2.0/$defs/classification):
 *   `category`, `subcategory`, and `codes` that are taxonomyCode objects
 *   (`{standard, value}`); a bare string code is dropped and counted.
 * - a manufacturer party, when the generic conversion produced none.
 *
 * Every `cdx:hbom:*` property stays: the hbom audit rules read them.
 */
/** True when the 1.x component carries at least one cdx:hbom:* property. */
export declare function isHardwareComponent(component: any): any;
/**
 * Add the hardware mapper's 2.0 members to a converted hardware component.
 * Without a mapper, or for a component without cdx:hbom:* properties, the
 * converted component is returned unchanged. The mapper gets a clone of the
 * 1.x component, the asserting party refId the generic identifiers use (so
 * its identifiers resolve to the party the renderer declares) and the
 * identifier options of the render context (`stats.hardwareOptions`).
 *
 * @param {object} component The 1.x component
 * @param {object} converted Its generic 2.0 conversion, extended in place
 * @param {object} stats Render counters with the optional `hardwareMapper`
 * @returns {object} The converted component
 */
export declare function applyHardwareMapping(component: object, converted: object, stats: object): object;
//# sourceMappingURL=cyclonedx20RenderHardware.d.ts.map