/**
 * Filter and enhance BOM post generation.
 *
 * At CycloneDX 2.0 the returned `bomNSData` carries two documents:
 * `bomJson` is the rendered 2.0 document (what library users, the server and
 * the writer see), and `internalBomJson` is the 1.x-shaped model the audit,
 * evinse, display and SPDX-export readers use. `internalBomJson` is never
 * serialized; `refreshRenderedBom` re-renders `bomJson` from it after any
 * later mutation. At 1.x `internalBomJson` is unset.
 *
 * @param {Object} bomNSData BOM with namespaces object
 * @param {Object} options CLI options
 * @param {string} [filePath] Source path used for formulation and metadata context
 *
 * @returns {Promise<Object>} Modified bomNSData
 */
export declare function postProcess(bomNSData: Object, options: Object, filePath?: string): Promise<Object>;
/**
 * Apply additional metadata based on components
 *
 * @param {Object} bomJson BOM JSON Object
 * @param {Object} options CLI options
 *
 * @returns {Object} Filtered BOM JSON
 */
export declare function applyMetadata(bomJson: Object, options: Object): Object;
/**
 * Apply definitions.standards based on options
 *
 * @param {Object} bomJson BOM JSON Object
 * @param {Object} options CLI options
 *
 * @returns {Object} Filtered BOM JSON
 */
export declare function applyStandards(bomJson: Object, options: Object): Object;
/**
 * Move the build-time-only components out of `components[]`, which describes
 * the delivered assembly, and hand them to the formulation section, which is
 * where CycloneDX describes how the assembly was produced.
 *
 * Their bom-refs stay valid because the formulation components live in the same
 * document, so the dependency graph is left intact. `formulation` exists from
 * CycloneDX 1.5, so an older document keeps them in `components[]` with their
 * `cdx:cargo:hostOnly` marker rather than losing them.
 *
 * @param {Object} bomJson BOM JSON object
 * @param {Object} options CLI options
 *
 * @returns {Object[]} The components removed from `components[]`
 */
export declare function extractBuildOnlyComponents(bomJson: Object, options: Object): Object[];
/**
 * Re-apply the `--required-only` filter once the evidence stage has attached
 * occurrence and callstack data.
 *
 * A manifest can only say that a dependency is optional; the evidence says
 * whether it is reached. A component the analyzers observed in the sources is
 * promoted to `required` so it survives the filter, while an optional component
 * with no observed usage is dropped as before. A component scoped `excluded` -
 * a dev or test dependency - keeps that scope: an occurrence inside the test
 * sources is not evidence that it ships.
 *
 * @param {Object} bomJson BOM JSON object carrying evidence
 * @param {Object} options CLI options
 *
 * @returns {Object} Filtered BOM JSON
 */
export declare function applyEvidenceBasedFilter(bomJson: Object, options: Object): Object;
/**
 * Filter BOM based on options
 *
 * @param {Object} bomJson BOM JSON Object
 * @param {Object} options CLI options
 *
 * @returns {Object} Filtered BOM JSON
 */
export declare function filterBom(bomJson: Object, options: Object): Object;
/**
 * Clean up
 */
export declare function cleanupEnv(_options: any): void;
/**
 * Removes the cdxgen temporary directory if it was created inside the system
 * temp directory (as indicated by `CDXGEN_TMP_DIR`). No-ops when the variable
 * is unset or points outside the system temp directory.
 *
 * @returns {void}
 */
export declare function cleanupTmpDir(): void;
/**
 * Annotate the document with annotator
 *
 * @param {Object} bomJson BOM JSON Object
 * @param {Object} options CLI options
 *
 * @returns {Object} Annotated BOM JSON
 */
export declare function annotate(bomJson: Object, options: Object): Object;
//# sourceMappingURL=postgen.d.ts.map