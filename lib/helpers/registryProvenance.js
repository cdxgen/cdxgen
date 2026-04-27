function appendProperty(properties, name, value) {
  if (!name || value === undefined || value === null || value === "") {
    return;
  }
  properties.push({
    name,
    value: typeof value === "string" ? value : String(value),
  });
}

function uniqueStrings(values) {
  return [
    ...new Set(values.filter(Boolean).map((value) => String(value).trim())),
  ];
}

function extractNestedValue(obj, paths) {
  for (const path of paths) {
    let current = obj;
    for (const segment of path) {
      current = current?.[segment];
      if (current === undefined || current === null) {
        break;
      }
    }
    if (current !== undefined && current !== null && current !== "") {
      return current;
    }
  }
  return undefined;
}

function normalizeProvenanceUrl(value) {
  if (!value) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  return extractNestedValue(value, [
    ["url"],
    ["provenanceUrl"],
    ["attestationUrl"],
    ["bundle", "url"],
    ["provenance", "url"],
    ["attestations", "url"],
  ]);
}

function hasTrustedPublishingEvidence(value) {
  if (!value) {
    return false;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return /(trusted|oidc|attestation|provenance)/i.test(value);
  }
  if (Array.isArray(value)) {
    return value.some((entry) => hasTrustedPublishingEvidence(entry));
  }
  return Boolean(
    normalizeProvenanceUrl(value) ||
      extractNestedValue(value, [
        ["trustedPublishing"],
        ["trusted_publishing"],
        ["isTrustedPublishing"],
        ["verifiedPublisher"],
        ["oidc"],
        ["predicateType"],
      ]),
  );
}

/**
 * Extract advanced npm provenance and publishing properties from registry metadata.
 *
 * @param {object} packument npm packument body
 * @param {string | undefined} version package version
 * @returns {object[]} custom properties
 */
export function collectNpmRegistryProvenanceProperties(packument, version) {
  const properties = [];
  const versionBody = version ? packument?.versions?.[version] : undefined;
  const publishTime = version ? packument?.time?.[version] : undefined;
  const publisherName =
    versionBody?._npmUser?.name ||
    versionBody?.publisher?.name ||
    packument?.maintainers?.[0]?.name;
  const publisherEmail =
    versionBody?._npmUser?.email ||
    versionBody?.publisher?.email ||
    packument?.maintainers?.[0]?.email;
  const provenanceCandidate =
    versionBody?.dist?.provenance ||
    versionBody?.provenance ||
    versionBody?.dist?.attestations ||
    versionBody?.attestations;
  const provenanceUrl = normalizeProvenanceUrl(provenanceCandidate);

  appendProperty(properties, "cdx:npm:publishTime", publishTime);
  appendProperty(properties, "cdx:npm:publisher", publisherName);
  appendProperty(properties, "cdx:npm:publisherEmail", publisherEmail);
  if (hasTrustedPublishingEvidence(provenanceCandidate)) {
    appendProperty(properties, "cdx:npm:trustedPublishing", "true");
  }
  appendProperty(properties, "cdx:npm:provenanceUrl", provenanceUrl);
  return properties;
}

/**
 * Extract advanced PyPI provenance and publishing properties from registry metadata.
 *
 * @param {object} projectBody PyPI JSON body
 * @param {string | undefined} version package version
 * @returns {object[]} custom properties
 */
export function collectPypiRegistryProvenanceProperties(projectBody, version) {
  const properties = [];
  const releaseFiles = Array.isArray(projectBody?.releases?.[version])
    ? projectBody.releases[version]
    : Array.isArray(projectBody?.urls)
      ? projectBody.urls
      : [];
  const uploadTimes = uniqueStrings(
    releaseFiles.map(
      (file) =>
        file?.upload_time_iso_8601 || file?.upload_time || file?.uploadTime,
    ),
  );
  const uploaders = uniqueStrings(
    releaseFiles.map((file) => file?.uploader || file?.uploaded_by),
  );
  const provenanceUrls = uniqueStrings(
    releaseFiles.map((file) =>
      normalizeProvenanceUrl(
        file?.provenance ||
          file?.attestations ||
          file?.provenance_url ||
          file?.attestation_url,
      ),
    ),
  );
  const trustedPublishing = releaseFiles.some((file) =>
    hasTrustedPublishingEvidence(
      file?.provenance ||
        file?.attestations ||
        file?.trusted_publishing ||
        file?.uploaded_via ||
        file?.uploaded_using ||
        file?.provenance_url,
    ),
  );
  const uploaderVerified = releaseFiles.some(
    (file) =>
      file?.uploader_verified === true || file?.uploaderVerified === true,
  );

  appendProperty(properties, "cdx:pypi:publishTime", uploadTimes[0]);
  appendProperty(properties, "cdx:pypi:publisher", uploaders.join(", "));
  if (uploaderVerified) {
    appendProperty(properties, "cdx:pypi:uploaderVerified", "true");
  }
  if (trustedPublishing) {
    appendProperty(properties, "cdx:pypi:trustedPublishing", "true");
  }
  appendProperty(properties, "cdx:pypi:provenanceUrl", provenanceUrls[0]);
  return properties;
}
