/**
 * Merges two CycloneDX dependency arrays into a single deduplicated list.
 * For each unique ref, the dependsOn and provides sets from both arrays are
 * combined. Self-referential entries pointing to the parent component are
 * removed from all dependsOn and provides lists.
 *
 * @param {Object[]} dependencies First array of dependency objects
 * @param {Object[]} newDependencies Second array of dependency objects to merge
 * @param {Object} parentComponent Parent component whose bom-ref is used to filter self-references
 * @returns {Object[]} Merged and deduplicated array of dependency objects
 */
export declare function mergeDependencies(dependencies: Object[], newDependencies: Object[], parentComponent?: Object): Object[];
/**
 * Marks npm @types packages as excluded from runtime scope.
 *
 * @param {Object[]} components CycloneDX component objects
 * @returns {Object[]} The same component array with scopes updated in place
 */
export declare function markNpmTypesPackagesAsExcluded(components?: Object[]): Object[];
/**
 * Propagates required scope through a dependency graph.
 *
 * If component A has `scope: "required"` and dependency metadata says A depends
 * on B, B is also runtime-relevant. Keep packages optional when lockfile/parser
 * metadata explicitly identifies them as development, optional, or peer-only.
 *
 * @param {Object[]} components CycloneDX component objects
 * @param {Object[]} dependencies CycloneDX dependency entries
 * @returns {Object[]} The same component array with scopes updated in place
 */
export declare function propagateRequiredScopeFromDependencies(components?: Object[], dependencies?: Object[]): Object[];
/**
 * Scopes the dependencies of type-only npm packages as optional.
 *
 * A package imported only for its TypeScript types, like an `@types` package,
 * is erased at compile time, and so is what it depends on unless a runtime
 * package depends on it too. A component below a type-only package becomes
 * optional when no dependency path from a root of the graph reaches it without
 * passing through a type-only package. A component that already has a scope,
 * from its manifest or from usage evidence, keeps it.
 *
 * @param {Object[]} components CycloneDX component objects
 * @param {Object[]} dependencies CycloneDX dependency entries
 * @returns {Object[]} The same component array with scopes updated in place
 */
export declare function markTypeOnlyDependenciesOptional(components?: Object[], dependencies?: Object[]): Object[];
/**
 * Append an entry to a list unless an entry with the same key is already in
 * it. The keys of each list are kept in an index, so the check costs the same
 * however long the list grows, where scanning the list per append would be
 * quadratic. The list must only be changed by appending: a list whose length
 * differs from the last call, because other code appended to it, is indexed
 * again.
 *
 * @param {Object[]} list List to append to, changed in place
 * @param {(entry: Object) => string} keyOf Key of an entry
 * @param {Object} entry Entry to append
 * @returns {boolean} true when the entry was appended
 */
export declare function appendUnique(list: Object[], keyOf: (entry: Object) => string, entry: Object): boolean;
/**
 * Append a `{ name, value }` property unless the same name and value pair is
 * already in the list. Empty values are not appended. The check goes through
 * `appendUnique()`, so it does not scan the list on every call.
 *
 * @param {Object[]} properties Property list, changed in place
 * @param {string} name Property name
 * @param {*} value Property value, converted to a string
 * @returns {void}
 */
export declare function appendUniqueProperty(properties: Object[], name: string, value: any): void;
/**
 * Merge CycloneDX services using bom-ref or group/name/version identity.
 *
 * @param {Object[]|Object} services Existing service list
 * @param {Object[]|Object} newServices New service list
 * @returns {Object[]} Merged and deduplicated services
 */
export declare function mergeServices(services: Object[] | Object, newServices: Object[] | Object): Object[];
/**
 * Trim duplicate components by retaining all the properties
 *
 * @param {Array} components Components
 *
 * @returns {Array} Filtered components
 */
export declare function trimComponents(components: any[]): any[];
/**
 * Filter out invalid cryptographic-asset components from a component list.
 * Removes algorithm components without a valid cryptoProperties.oid and
 * certificate components without cryptoProperties.algorithmProperties.
 *
 * @param {Object[] | undefined | null} components Array of CycloneDX components
 * @returns {Object[]} Filtered array with invalid crypto components removed
 */
export declare function filterInvalidCryptoComponents(components: Object[] | undefined | null): Object[];
/**
 * Method to check if a given dependency tree is partial or not.
 *
 * @param {Array} dependencies List of dependencies
 * @param {Number} componentsCount Number of components
 * @returns {Boolean} True if the dependency tree lacks any non-root parents without children. False otherwise.
 */
export declare function isPartialTree(dependencies: any[], componentsCount?: number): boolean;
/**
 * Re-compute and set the scope based on the dependency tree
 *
 * @param {Array} pkgList List of components
 * @param {Array} dependencies List of dependencies
 *
 * @returns {Array} Updated list
 */
export declare function recomputeScope(pkgList: any[], dependencies: any[]): any[];
//# sourceMappingURL=depsUtils.d.ts.map