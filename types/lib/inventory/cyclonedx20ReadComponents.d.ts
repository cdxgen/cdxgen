/**
 * Reader converters for CycloneDX 2.0 components
 * (#/$defs/cyclonedx-component-2.0/$defs/component) back to 1.x components
 * and, for `type: service`, 1.x services. Each frozen spec is the allowlist
 * of the members 1.x carries; everything else is reported as a loss.
 */
/**
 * A 2.0 component (not a service) → a 1.x component, or undefined when its
 * type has no 1.x equivalent (a loss).
 *
 * @param {object} ctx Reader context
 * @param {object} component 2.0 component
 * @param {string} pointer JSON pointer of `component`
 * @returns {object|undefined} 1.x component
 */
export declare function reverseComponent(ctx: object, component: object, pointer: string): object | undefined;
/**
 * A 2.0 component of type `service` → a 1.x service.
 *
 * @param {object} ctx Reader context
 * @param {object} component 2.0 service component
 * @param {string} pointer JSON pointer of `component`
 * @returns {object} 1.x service
 */
export declare function reverseService(ctx: object, component: object, pointer: string): object;
/**
 * Resolve a componentEntry (component, componentReference or
 * component-choice) to a concrete component. A reference resolves against
 * every declared component; a choice keeps its first resolvable member.
 *
 * @param {object} ctx Reader context (with `componentIndex`)
 * @param {object} entry 2.0 componentEntry
 * @param {string} pointer JSON pointer of `entry`
 * @returns {{component: object, pointer: string}|undefined}
 */
export declare function resolveComponentEntry(ctx: object, entry: object, pointer: string, depth?: number): {
    component: object;
    pointer: string;
} | undefined;
/**
 * Read one top-level component entry (an inventory entry, subject, tool,
 * definitions component, formula component or annotator) into 1.x, as a
 * component or a service. `needsShadow` is set when the 1.x value does not
 * render back to the same 2.0 entry; a caller that keeps the entry passes the
 * result to keepComponentShadow.
 *
 * @param {object} ctx Reader context
 * @param {object} entry 2.0 componentEntry
 * @param {string} pointer JSON pointer of `entry`
 * @returns {{internal: object, isService: boolean, refId?: string, entry: object, needsShadow: boolean}|undefined}
 */
export declare function readComponentEntry(ctx: object, entry: object, pointer: string): {
    internal: object;
    isService: boolean;
    refId?: string;
    entry: object;
    needsShadow: boolean;
} | undefined;
/**
 * Note a kept component entry for the shadows. Entries read inside a section
 * entry that is itself restored whole (annotations, vulnerabilities) are not
 * noted, since the renderer never converts them.
 *
 * @param {object} ctx Reader context
 * @param {object} read Result of readComponentEntry
 */
export declare function keepComponentShadow(ctx: object, read: object): void;
/**
 * Register the component shadows. Kept entries whose 1.x values are
 * identical share a key; when any of them needs a shadow, all of them are
 * registered in document order, which is the order the renderer converts
 * them in, so each gets its own original back.
 *
 * @param {object} ctx Reader context
 */
export declare function flushComponentShadows(ctx: object): void;
//# sourceMappingURL=cyclonedx20ReadComponents.d.ts.map