export declare function collectNpmRegistryProvenanceProperties(packument: any, version: any): any[];
/**
 * Extract advanced PyPI provenance and publishing properties from registry metadata.
 *
 * @param {object} projectBody PyPI JSON body
 * @param {string | undefined} version package version
 * @returns {object[]} custom properties
 */
export declare function collectPypiRegistryProvenanceProperties(projectBody: object, version: string | undefined): object[];
/**
 * Extract Cargo/crates.io release, publisher, and provenance-adjacent properties.
 *
 * @param {object} crateBody crates.io `/api/v1/crates/{name}` response body
 * @param {string | undefined} version crate version
 * @param {object} [ownersBody] crates.io `/api/v1/crates/{name}/owners` response body
 * @returns {object[]} custom properties
 */
export declare function collectCargoRegistryProvenanceProperties(crateBody: object, version: string | undefined, ownersBody?: object): object[];
//# sourceMappingURL=registryProvenance.d.ts.map