/**
 * List the CycloneDX JSON documents a jar carries under META-INF/sbom.
 *
 * @param {string} extractedDir Directory the jar was extracted into
 * @returns {string[]} Absolute paths of the embedded SBOM candidates
 */
export declare function findEmbeddedSbomFiles(extractedDir: string): string[];
/**
 * Read and validate an embedded CycloneDX JSON document.
 *
 * The document must be a JSON object whose bomFormat is CycloneDX. It is read
 * only up to {@link MAX_EMBEDDED_SBOM_BYTES}, and its metadata is never
 * returned: the scan's own metadata describes the scan, and an embedded
 * document has no business replacing it.
 *
 * @param {string} sbomFile Path of the extracted SBOM resource
 * @returns {Object|null} `{ components, dependencies }`, or null when the file
 *   is not a readable CycloneDX document
 */
export declare function readEmbeddedSbomFile(sbomFile: string): Object | null;
/**
 * Record on each component where it came from, following the `internal:SrcFile`
 * convention every other component read from another BOM or artifact uses, with
 * the evidence method naming the SBOM resource inside the jar.
 *
 * @param {Object[]} components Components taken from the embedded document
 * @param {string} jarFile Path of the jar the SBOM was embedded in
 * @param {string} sbomFile Path of the extracted SBOM resource
 * @param {string} jarBasename Basename of the jar, for readable evidence values
 * @returns {Object[]} The same components with provenance attached
 */
export declare function decorateEmbeddedSbomComponents(components: Object[], jarFile: string, sbomFile: string, jarBasename: string): Object[];
//# sourceMappingURL=embeddedSbom.d.ts.map