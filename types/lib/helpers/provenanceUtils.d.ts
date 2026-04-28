/**
 * Return a component property value by name.
 *
 * @param {object} component CycloneDX component
 * @param {string} propertyName Property name to look up
 * @returns {string | undefined} Property value if present
 */
export function getComponentPropertyValue(component: object, propertyName: string): string | undefined;
/**
 * Return a property value by name from a raw properties array.
 *
 * @param {object[]} properties CycloneDX properties array
 * @param {string} propertyName Property name to look up
 * @returns {string | undefined} Property value if present
 */
export function getPropertyValue(properties: object[], propertyName: string): string | undefined;
/**
 * Check whether any of the supplied properties exist and carry a value.
 *
 * @param {object[]} properties CycloneDX properties array
 * @param {string[]} propertyNames Property names to test
 * @returns {boolean} True when any named property has a non-empty value
 */
export function hasAnyPropertyValue(properties: object[], propertyNames: string[]): boolean;
/**
 * Determine whether a raw properties array includes trusted publishing metadata.
 *
 * @param {object[]} properties CycloneDX properties array
 * @returns {boolean} True when trusted publishing is recorded for npm or PyPI
 */
export function hasTrustedPublishingProperties(properties: object[]): boolean;
/**
 * Determine whether a raw properties array includes direct registry provenance evidence.
 *
 * @param {object[]} properties CycloneDX properties array
 * @returns {boolean} True when direct provenance evidence is present
 */
export function hasRegistryProvenanceEvidenceProperties(properties: object[]): boolean;
/**
 * Determine whether a component includes trusted publishing metadata.
 *
 * @param {object} component CycloneDX component
 * @returns {boolean} True when trusted publishing is recorded for npm or PyPI
 */
export function hasComponentTrustedPublishing(component: object): boolean;
/**
 * Determine whether a component includes direct registry provenance evidence.
 *
 * @param {object} component CycloneDX component
 * @returns {boolean} True when provenance URL, digests, signatures, or key IDs exist
 */
export function hasComponentRegistryProvenanceEvidence(component: object): boolean;
/**
 * Determine whether a component includes registry provenance metadata.
 *
 * @param {object} component CycloneDX component
 * @returns {boolean} True when provenance or trusted publishing metadata exists
 */
export function hasComponentRegistryProvenance(component: object): boolean;
/**
 * Filter components to those carrying trusted publishing metadata.
 *
 * @param {object[]} components BOM components
 * @returns {object[]} Trusted-publishing-backed components
 */
export function getTrustedComponents(components: object[]): object[];
/**
 * Filter components to those carrying direct registry provenance evidence.
 *
 * @param {object[]} components BOM components
 * @returns {object[]} Provenance-backed components
 */
export function getProvenanceComponents(components: object[]): object[];
/**
 * Count components with trusted publishing metadata by registry ecosystem.
 *
 * @param {object[]} components BOM components
 * @returns {{npm: number, pypi: number, total: number}} Trusted publishing counts
 */
export function getTrustedPublishingComponentCounts(components: object[]): {
    npm: number;
    pypi: number;
    total: number;
};
export const NPM_PROVENANCE_EVIDENCE_PROPERTIES: string[];
export const PYPI_PROVENANCE_EVIDENCE_PROPERTIES: string[];
export const REGISTRY_PROVENANCE_EVIDENCE_PROPERTIES: string[];
export const TRUSTED_PUBLISHING_PROPERTIES: string[];
export const REGISTRY_PROVENANCE_ICON: "\uD83D\uDEE1";
//# sourceMappingURL=provenanceUtils.d.ts.map