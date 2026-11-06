/**
 * CycloneDX specification version compatibility.
 *
 * A BOM assembled in memory always carries the richest shape cdxgen knows how
 * to produce. Emitting it at an older specification version therefore means
 * removing elements that version does not define, and reshaping the ones it
 * models differently — CycloneDX forbids additional properties, so a stray
 * field fails schema validation outright.
 *
 * The reshaping is not purely subtractive. `evidence.identity` is a single
 * object up to 1.5 and an array from 1.6, and `metadata.tools` flips from a
 * `tools` object to component/service arrays at 2.0, so downgrades and upgrades
 * both rewrite structure rather than just delete keys.
 *
 * This module is the single home for that logic. It is applied to generated
 * BOMs by the postgen stage and to existing BOMs by `cdx-convert --to`, so both
 * paths produce byte-identical output for the same target version.
 */
/**
 * Restrict a BOM to the component types the caller asked for.
 *
 * Dependencies referencing pruned components are dropped so the graph never
 * points at a `bom-ref` that no longer exists.
 *
 * @param {Object} bomJson CycloneDX BOM, mutated in place
 * @param {Object} options CLI options carrying `componentType`
 * @returns {Object} The mutated BOM
 */
export declare function applyComponentTypeFilter(bomJson: Object, options: Object): Object;
/**
 * Reshape a BOM so it is valid at the requested specification version.
 *
 * Component types the target version does not define are filtered out first,
 * then root-level version-only fields are stripped, then the document is walked
 * key by key to downgrade (below 2.0) or upgrade (2.0 and above) each subject.
 * The BOM's `specVersion` and `$schema` are rewritten last.
 *
 * The target version is taken from `options.specVersion` when set, falling back
 * to the BOM's own `specVersion`. A malformed explicit version is left alone
 * rather than guessed at.
 *
 * @param {Object} bomJson CycloneDX BOM, mutated in place
 * @param {Object} options CLI options carrying the requested `specVersion`
 * @returns {Object} The mutated BOM
 */
export declare function applySpecVersionCompatibility(bomJson: Object, options: Object): Object;
/**
 * Collect the set of field paths present in a BOM.
 *
 * Array nesting does not extend the path, so the result describes which fields
 * a document carries rather than where they sit. That keeps a comparison
 * between two BOMs meaningful across a compatibility pass, which both drops
 * array entries and reshapes fields whose cardinality changed between spec
 * versions — `evidence.identity` reads the same whether it holds one object or
 * an array of them.
 *
 * @param {Object} subject BOM or BOM fragment
 * @param {string} [prefix] Path accumulated so far
 * @param {Set<string>} [paths] Accumulator
 * @returns {Set<string>} Field paths, e.g. `components.evidence.identity`
 */
export declare function collectFieldPaths(subject: Object, prefix?: string, paths?: Set<string>): Set<string>;
/**
 * Report which field paths a compatibility pass removed.
 *
 * @param {Object} sourceBomJson BOM before normalization
 * @param {Object} normalizedBomJson BOM after normalization
 * @returns {string[]} Sorted field paths that no longer appear
 */
export declare function diffRemovedFieldPaths(sourceBomJson: Object, normalizedBomJson: Object): string[];
/**
 * Count the leaf values of a JSON document as `path=value` strings, using
 * the dotted, index-free paths of collectFieldPaths. Array order is ignored,
 * so two documents that differ only in member order give the same counts,
 * but a repeated entry counts once per occurrence. Empty arrays and objects
 * count as leaves.
 *
 * @param {*} subject JSON value
 * @param {string} [prefix] Path so far
 * @param {Map<string, number>} [leaves] Accumulator
 * @returns {Map<string, number>} Occurrences of each `path=value` string
 */
export declare function collectLeafValues(subject: any, prefix?: string, leaves?: Map<string, number>): Map<string, number>;
/**
 * Report the leaf values of `sourceBomJson` that `convertedBomJson` lacks,
 * ignoring member order (see collectLeafValues). A value the source holds
 * more often than the output is reported once for every missing occurrence,
 * so dropping one of two identical entries counts.
 *
 * @param {Object} sourceBomJson BOM before conversion
 * @param {Object} convertedBomJson BOM after conversion
 * @returns {string[]} Sorted `path=value` strings missing from the output,
 *   repeated per missing occurrence
 */
export declare function diffMissingLeafValues(sourceBomJson: Object, convertedBomJson: Object): string[];
//# sourceMappingURL=specVersionCompat.d.ts.map