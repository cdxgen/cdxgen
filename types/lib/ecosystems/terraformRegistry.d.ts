/**
 * Enrich Terraform components in place. Never throws; a failed lookup leaves
 * the component exactly as the offline pass produced it.
 *
 * @param {object[]} pkgList Components to enrich
 * @returns {Promise<object[]>} The same package list
 */
export declare function getTerraformRegistryMetadata(pkgList: object[]): Promise<object[]>;
//# sourceMappingURL=terraformRegistry.d.ts.map