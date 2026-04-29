const NPM_PROVENANCE_URL_PROPERTY = "cdx:npm:provenanceUrl";
const NPM_TRUSTED_PUBLISHING_PROPERTY = "cdx:npm:trustedPublishing";
const PYPI_PROVENANCE_URL_PROPERTY = "cdx:pypi:provenanceUrl";
const PYPI_TRUSTED_PUBLISHING_PROPERTY = "cdx:pypi:trustedPublishing";
const CARGO_PROVENANCE_URL_PROPERTY = "cdx:cargo:provenanceUrl";
const CARGO_TRUSTED_PUBLISHING_PROPERTY = "cdx:cargo:trustedPublishing";

export const NPM_PROVENANCE_EVIDENCE_PROPERTIES = [
  NPM_PROVENANCE_URL_PROPERTY,
  "cdx:npm:provenanceDigest",
  "cdx:npm:provenanceKeyId",
  "cdx:npm:provenancePredicateType",
  "cdx:npm:provenanceSignature",
  "cdx:npm:artifactIntegrity",
  "cdx:npm:artifactShasum",
];
export const PYPI_PROVENANCE_EVIDENCE_PROPERTIES = [
  PYPI_PROVENANCE_URL_PROPERTY,
  "cdx:pypi:provenanceDigest",
  "cdx:pypi:provenanceKeyId",
  "cdx:pypi:provenancePredicateType",
  "cdx:pypi:provenanceSignature",
  "cdx:pypi:artifactDigestSha256",
  "cdx:pypi:artifactDigestBlake2b256",
  "cdx:pypi:artifactDigestMd5",
];
export const CARGO_PROVENANCE_EVIDENCE_PROPERTIES = [
  CARGO_PROVENANCE_URL_PROPERTY,
  "cdx:cargo:provenanceDigest",
  "cdx:cargo:provenanceKeyId",
  "cdx:cargo:provenancePredicateType",
  "cdx:cargo:provenanceSignature",
  "cdx:cargo:artifactDigestSha256",
];
export const REGISTRY_PROVENANCE_EVIDENCE_PROPERTIES = [
  ...NPM_PROVENANCE_EVIDENCE_PROPERTIES,
  ...PYPI_PROVENANCE_EVIDENCE_PROPERTIES,
  ...CARGO_PROVENANCE_EVIDENCE_PROPERTIES,
];
export const TRUSTED_PUBLISHING_PROPERTIES = [
  NPM_TRUSTED_PUBLISHING_PROPERTY,
  PYPI_TRUSTED_PUBLISHING_PROPERTY,
  CARGO_TRUSTED_PUBLISHING_PROPERTY,
];

export const REGISTRY_PROVENANCE_ICON = "🛡";

/**
 * Return a component property value by name.
 *
 * @param {object} component CycloneDX component
 * @param {string} propertyName Property name to look up
 * @returns {string | undefined} Property value if present
 */
export function getComponentPropertyValue(component, propertyName) {
  return component?.properties?.find((prop) => prop?.name === propertyName)
    ?.value;
}

/**
 * Return a property value by name from a raw properties array.
 *
 * @param {object[]} properties CycloneDX properties array
 * @param {string} propertyName Property name to look up
 * @returns {string | undefined} Property value if present
 */
export function getPropertyValue(properties, propertyName) {
  return properties?.find((prop) => prop?.name === propertyName)?.value;
}

/**
 * Check whether any of the supplied properties exist and carry a value.
 *
 * @param {object[]} properties CycloneDX properties array
 * @param {string[]} propertyNames Property names to test
 * @returns {boolean} True when any named property has a non-empty value
 */
export function hasAnyPropertyValue(properties, propertyNames) {
  return propertyNames.some((propertyName) =>
    Boolean(getPropertyValue(properties, propertyName)),
  );
}

/**
 * Determine whether a raw properties array includes trusted publishing metadata.
 *
 * @param {object[]} properties CycloneDX properties array
 * @returns {boolean} True when trusted publishing is recorded for npm, PyPI, or Cargo
 */
export function hasTrustedPublishingProperties(properties) {
  return TRUSTED_PUBLISHING_PROPERTIES.some(
    (propertyName) => getPropertyValue(properties, propertyName) === "true",
  );
}

/**
 * Determine whether a raw properties array includes direct registry provenance evidence.
 *
 * @param {object[]} properties CycloneDX properties array
 * @returns {boolean} True when direct provenance evidence is present
 */
export function hasRegistryProvenanceEvidenceProperties(properties) {
  return hasAnyPropertyValue(
    properties,
    REGISTRY_PROVENANCE_EVIDENCE_PROPERTIES,
  );
}

/**
 * Determine whether a component includes trusted publishing metadata.
 *
 * @param {object} component CycloneDX component
 * @returns {boolean} True when trusted publishing is recorded for npm, PyPI, or Cargo
 */
export function hasComponentTrustedPublishing(component) {
  return hasTrustedPublishingProperties(component?.properties);
}

/**
 * Determine whether a component includes direct registry provenance evidence.
 *
 * @param {object} component CycloneDX component
 * @returns {boolean} True when provenance URL, digests, signatures, or key IDs exist
 */
export function hasComponentRegistryProvenanceEvidence(component) {
  return hasRegistryProvenanceEvidenceProperties(component?.properties);
}

/**
 * Determine whether a component includes registry provenance metadata.
 *
 * @param {object} component CycloneDX component
 * @returns {boolean} True when provenance or trusted publishing metadata exists
 */
export function hasComponentRegistryProvenance(component) {
  return (
    hasComponentTrustedPublishing(component) ||
    hasComponentRegistryProvenanceEvidence(component)
  );
}

/**
 * Filter components to those carrying trusted publishing metadata.
 *
 * @param {object[]} components BOM components
 * @returns {object[]} Trusted-publishing-backed components
 */
export function getTrustedComponents(components) {
  if (!Array.isArray(components)) {
    return [];
  }
  return components.filter((component) =>
    hasComponentTrustedPublishing(component),
  );
}

/**
 * Filter components to those carrying direct registry provenance evidence.
 *
 * @param {object[]} components BOM components
 * @returns {object[]} Provenance-backed components
 */
export function getProvenanceComponents(components) {
  if (!Array.isArray(components)) {
    return [];
  }
  return components.filter((component) =>
    hasComponentRegistryProvenanceEvidence(component),
  );
}

/**
 * Count components with trusted publishing metadata by registry ecosystem.
 *
 * @param {object[]} components BOM components
 * @returns {{cargo: number, npm: number, pypi: number, total: number}} Trusted publishing counts
 */
export function getTrustedPublishingComponentCounts(components) {
  const counts = {
    cargo: 0,
    npm: 0,
    pypi: 0,
    total: 0,
  };
  if (!Array.isArray(components)) {
    return counts;
  }
  for (const component of components) {
    const npmTrustedPublishing =
      getComponentPropertyValue(component, NPM_TRUSTED_PUBLISHING_PROPERTY) ===
      "true";
    const pypiTrustedPublishing =
      getComponentPropertyValue(component, PYPI_TRUSTED_PUBLISHING_PROPERTY) ===
      "true";
    const cargoTrustedPublishing =
      getComponentPropertyValue(
        component,
        CARGO_TRUSTED_PUBLISHING_PROPERTY,
      ) === "true";
    if (npmTrustedPublishing) {
      counts.npm += 1;
    }
    if (pypiTrustedPublishing) {
      counts.pypi += 1;
    }
    if (cargoTrustedPublishing) {
      counts.cargo += 1;
    }
    if (
      npmTrustedPublishing ||
      pypiTrustedPublishing ||
      cargoTrustedPublishing
    ) {
      counts.total += 1;
    }
  }
  return counts;
}
