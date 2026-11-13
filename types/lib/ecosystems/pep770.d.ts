/**
 * Discover and parse embedded SBOMs from installed distribution metadata
 * directories and wheel files, per PEP 770. Returns merged components,
 * dependencies, and citations ready for post-processing.
 *
 * Embedded components are returned as dependencies *of* the distribution that
 * supplied them, never as orphan top-level siblings. An embedded SBOM is
 * stronger than cdxgen's inference; the upstream component wins on conflict,
 * which the merge (trimComponents) records by unioning rather than discarding.
 *
 * @param {Object} input Discovery inputs
 * @param {string[]} [input.metadataFiles] Installed `*.dist-info/METADATA` paths
 * @param {string[]} [input.whlFiles] Wheel file paths
 * @returns {Promise<{components: Object[], dependencies: Object[], citations: Object[]}>}
 */
export declare function collectEmbeddedSboms({ metadataFiles, whlFiles, }?: {
    metadataFiles?: string[];
    whlFiles?: string[];
}): Promise<{
    components: Object[];
    dependencies: Object[];
    citations: Object[];
}>;
/**
 * Test-only export exposing internal helpers and constants for unit testing.
 *
 * Underscore-prefixed to signal that it is not part of the public API.
 *
 * @type {{ MAX_EMBEDDED_SBOM_BYTES: number, MAX_EMBEDDED_ELEMENTS: number, MAX_EMBEDDED_ELEMENTS_PER_DISTRIBUTION: number, buildEmbeddedCitation: Function, distInfoStem: Function, parseEmbeddedSbom: Function, rebaseDependencies: Function, pypiBomRef: Function, distNameVersionFromMetadata: Function }}
 */
export declare const _internals: {
    MAX_EMBEDDED_SBOM_BYTES: number;
    MAX_EMBEDDED_ELEMENTS: number;
    MAX_EMBEDDED_ELEMENTS_PER_DISTRIBUTION: number;
    buildEmbeddedCitation: Function;
    distInfoStem: Function;
    parseEmbeddedSbom: Function;
    rebaseDependencies: Function;
    pypiBomRef: Function;
    distNameVersionFromMetadata: Function;
};
//# sourceMappingURL=pep770.d.ts.map