/**
 * Collapse the components that stand for one Scala library.
 *
 * A build tool such as sbt reports a library as `group:name@version` with the
 * Scala binary suffix moved into `cdx:scala:compilerVersion`. The jars a scan
 * finds on disk name the same library again, and not in the same way: with the
 * suffix (`cats-core_3`), without a repository, or, for a jar without a Maven
 * descriptor, only as the staged file name `<group>.<artifact>-<version>.jar`,
 * which a filename-based guess splits at the wrong dot
 * (`pkg:maven/cpg2-protos/io.appthreat.cpg2-protos_3`). Each of those is merged
 * into the component the build tool reported. A staged jar of another version
 * of a reported library, such as a stale build, keeps its own component but is
 * renamed to the coordinates the reported library has.
 *
 * Spellings of the same coordinates merge only when they were built for the
 * same Scala binary version, so the `_2.12` and `_2.13` artifacts of one
 * library stay two components. Components that no reported library accounts
 * for are left as they are.
 *
 * @param {Object[]} components BOM components
 * @param {Object[]} dependencies BOM dependencies
 * @returns {{components: Object[], dependencies: Object[], purlMap: Map<string, string>}}
 *   The collapsed components, the dependencies with references to merged
 *   components pointed at the component that remains, and the purl each
 *   merged or renamed component now has, keyed by the purl it had
 */
export declare function mergeScalaDuplicateComponents(components: Object[], dependencies: Object[]): {
    components: Object[];
    dependencies: Object[];
    purlMap: Map<string, string>;
};
/**
 * Key the jar namespace map by the purls the components have after
 * {@link mergeScalaDuplicateComponents}, so a merged or renamed jar still
 * finds its namespaces. A purl that already has an entry keeps it, with the
 * namespaces of the merged entry added.
 *
 * @param {Object} mapping Jar namespace map keyed by purl
 * @param {Map<string, string>} purlMap New purl keyed by old purl
 * @returns {Object} The re-keyed map
 */
export declare function rekeyNamespaceMapping(mapping: Object, purlMap: Map<string, string>): Object;
//# sourceMappingURL=scalaDedupe.d.ts.map