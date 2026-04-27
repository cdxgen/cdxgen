/**
 * Extract advanced npm provenance and publishing properties from registry metadata.
 *
 * @param {object} packument npm packument body
 * @param {string | undefined} version package version
 * @returns {object[]} custom properties
 */
export function collectNpmRegistryProvenanceProperties(packument: object, version: string | undefined): object[];
/**
 * Extract advanced PyPI provenance and publishing properties from registry metadata.
 *
 * @param {object} projectBody PyPI JSON body
 * @param {string | undefined} version package version
 * @returns {object[]} custom properties
 */
export function collectPypiRegistryProvenanceProperties(projectBody: object, version: string | undefined): object[];
//# sourceMappingURL=registryProvenance.d.ts.map