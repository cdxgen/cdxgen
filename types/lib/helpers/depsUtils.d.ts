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
export function mergeDependencies(dependencies: Object[], newDependencies: Object[], parentComponent?: Object): Object[];
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
export function propagateRequiredScopeFromDependencies(components?: Object[], dependencies?: Object[]): Object[];
/**
 * Merge CycloneDX services using bom-ref or group/name/version identity.
 *
 * @param {Object[]|Object} services Existing service list
 * @param {Object[]|Object} newServices New service list
 * @returns {Object[]} Merged and deduplicated services
 */
export function mergeServices(services: Object[] | Object, newServices: Object[] | Object): Object[];
/**
 * Trim duplicate components by retaining all the properties
 *
 * @param {Array} components Components
 *
 * @returns {Array} Filtered components
 */
export function trimComponents(components: any[]): any[];
/**
 * Filter out invalid cryptographic-asset components from a component list.
 * Removes algorithm components without a valid cryptoProperties.oid and
 * certificate components without cryptoProperties.algorithmProperties.
 *
 * @param {Object[] | undefined | null} components Array of CycloneDX components
 * @returns {Object[]} Filtered array with invalid crypto components removed
 */
export function filterInvalidCryptoComponents(components: Object[] | undefined | null): Object[];
//# sourceMappingURL=depsUtils.d.ts.map