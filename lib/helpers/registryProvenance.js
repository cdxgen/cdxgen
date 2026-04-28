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

function parseTimestamp(value) {
  if (!value || typeof value !== "string") {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

function sortReleaseEntries(entries) {
  return entries.sort((left, right) => left.timestamp - right.timestamp);
}

function median(numbers) {
  if (!numbers.length) {
    return undefined;
  }
  const sorted = [...numbers].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[midpoint - 1] + sorted[midpoint]) / 2;
  }
  return sorted[midpoint];
}

function normalizeIdentity(value) {
  if (!value) {
    return undefined;
  }
  return String(value).trim().toLowerCase();
}

function uniqueIdentities(values) {
  return [
    ...new Set(values.map((value) => normalizeIdentity(value)).filter(Boolean)),
  ];
}

function isDisjointIdentitySet(leftSet, rightSet) {
  if (!leftSet.length || !rightSet.length) {
    return false;
  }
  return leftSet.every(
    (leftValue) => !rightSet.some((rightValue) => rightValue === leftValue),
  );
}

function identityOverlapMetrics(leftSet, rightSet) {
  if (!leftSet.length || !rightSet.length) {
    return {};
  }
  const rightValues = new Set(rightSet);
  const overlapCount = leftSet.filter((leftValue) =>
    rightValues.has(leftValue),
  ).length;
  const unionCount = new Set([...leftSet, ...rightSet]).size;
  return {
    overlapCount,
    overlapRatio: unionCount > 0 ? overlapCount / unionCount : undefined,
    partialDrift:
      overlapCount > 0 &&
      overlapCount < unionCount &&
      (overlapCount < leftSet.length || overlapCount < rightSet.length),
  };
}

function extractMaintainerIdentities(maintainers) {
  if (!Array.isArray(maintainers)) {
    return [];
  }
  const identities = [];
  for (const maintainer of maintainers) {
    if (typeof maintainer === "string") {
      identities.push(maintainer);
      continue;
    }
    identities.push(maintainer?.name, maintainer?.email);
  }
  return uniqueIdentities(identities);
}

function releaseGapMetrics(releaseEntries, currentVersion) {
  const sortedEntries = sortReleaseEntries([...releaseEntries]);
  const currentIndex = sortedEntries.findIndex(
    (entry) => entry.version === currentVersion,
  );
  if (currentIndex < 1) {
    return {};
  }
  const currentGapDays =
    (sortedEntries[currentIndex].timestamp -
      sortedEntries[currentIndex - 1].timestamp) /
    (1000 * 60 * 60 * 24);
  const priorGapDays = [];
  for (let index = 1; index < currentIndex; index += 1) {
    priorGapDays.push(
      (sortedEntries[index].timestamp - sortedEntries[index - 1].timestamp) /
        (1000 * 60 * 60 * 24),
    );
  }
  return {
    baselineDays: median(priorGapDays),
    currentGapDays,
    sampleSize: priorGapDays.length,
  };
}

function compressedCadenceMetrics(gapMetrics) {
  const baselineDays = gapMetrics?.baselineDays;
  const currentGapDays = gapMetrics?.currentGapDays;
  const sampleSize = gapMetrics?.sampleSize;
  if (
    baselineDays === undefined ||
    currentGapDays === undefined ||
    sampleSize === undefined ||
    sampleSize < 3 ||
    baselineDays <= 0 ||
    currentGapDays <= 0
  ) {
    return {};
  }
  const compressionRatio = currentGapDays / baselineDays;
  return {
    compressedCadence:
      baselineDays >= 21 && currentGapDays <= 14 && compressionRatio <= 0.33,
    compressionRatio,
  };
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

function collectPathValues(value, pathSegments) {
  if (value === undefined || value === null) {
    return [];
  }
  if (!pathSegments.length) {
    if (Array.isArray(value)) {
      return value.flatMap((entry) => collectPathValues(entry, []));
    }
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectPathValues(entry, pathSegments));
  }
  const [currentSegment, ...remainingSegments] = pathSegments;
  return collectPathValues(value?.[currentSegment], remainingSegments);
}

function normalizeCollectedValues(values) {
  const normalizedValues = [];
  for (const value of values) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    if (typeof value === "string") {
      normalizedValues.push(value);
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      normalizedValues.push(String(value));
    }
  }
  return uniqueStrings(normalizedValues);
}

function collectNestedValues(value, paths) {
  const collectedValues = [];
  for (const path of paths) {
    collectedValues.push(...collectPathValues(value, path));
  }
  return normalizeCollectedValues(collectedValues);
}

function appendJoinedProperty(properties, name, values) {
  appendProperty(properties, name, uniqueStrings(values).join(", "));
}

function collectProvenanceDigests(value) {
  return collectNestedValues(value, [
    ["digest"],
    ["hash"],
    ["sha256"],
    ["sha512"],
    ["integrity"],
    ["hashes", "sha256"],
    ["hashes", "sha512"],
    ["subject", "digest", "sha256"],
    ["subject", "digest", "sha512"],
    ["statement", "subject", "digest", "sha256"],
    ["statement", "subject", "digest", "sha512"],
    ["bundle", "subject", "digest", "sha256"],
    ["bundle", "subject", "digest", "sha512"],
  ]);
}

function collectProvenanceKeyIds(value) {
  return collectNestedValues(value, [
    ["keyid"],
    ["keyId"],
    ["publicKeyId"],
    ["verificationKeyId"],
    ["signingKeyId"],
    ["signatures", "keyid"],
    ["signatures", "keyId"],
    ["verificationMaterial", "publicKey", "keyid"],
    ["verificationMaterial", "publicKey", "keyId"],
    ["verificationMaterial", "certificate", "keyid"],
    ["verificationMaterial", "certificate", "keyId"],
  ]);
}

function collectProvenanceSignatures(value) {
  return collectNestedValues(value, [
    ["signature"],
    ["sig"],
    ["signatures", "sig"],
    ["signatures", "signature"],
  ]);
}

function collectProvenancePredicateTypes(value) {
  return collectNestedValues(value, [
    ["predicateType"],
    ["predicate_type"],
    ["statement", "predicateType"],
    ["bundle", "predicateType"],
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
  const versionPublishTimes = Object.entries(packument?.time || {})
    .filter(
      ([entryName, entryValue]) =>
        !["created", "modified"].includes(entryName) &&
        typeof entryValue === "string" &&
        parseTimestamp(entryValue) !== undefined,
    )
    .map(([entryName, entryValue]) => ({
      timestamp: parseTimestamp(entryValue),
      version: entryName,
    }));
  const currentPublishTimestamp = parseTimestamp(publishTime);
  const priorReleaseEntry = sortReleaseEntries(
    versionPublishTimes.filter(
      (entry) =>
        entry.version !== version &&
        currentPublishTimestamp !== undefined &&
        entry.timestamp < currentPublishTimestamp,
    ),
  ).pop();
  const priorVersionBody = priorReleaseEntry
    ? packument?.versions?.[priorReleaseEntry.version]
    : undefined;
  const currentMaintainerSet = uniqueIdentities([
    ...extractMaintainerIdentities(versionBody?.maintainers),
    versionBody?._npmUser?.name,
    versionBody?._npmUser?.email,
    versionBody?.publisher?.name,
    versionBody?.publisher?.email,
  ]);
  const priorMaintainerSet = uniqueIdentities([
    ...extractMaintainerIdentities(priorVersionBody?.maintainers),
    priorVersionBody?._npmUser?.name,
    priorVersionBody?._npmUser?.email,
    priorVersionBody?.publisher?.name,
    priorVersionBody?.publisher?.email,
  ]);
  const maintainerSetDrift = isDisjointIdentitySet(
    currentMaintainerSet,
    priorMaintainerSet,
  );
  const gapMetrics = releaseGapMetrics(versionPublishTimes, version);
  const overlapMetrics = identityOverlapMetrics(
    currentMaintainerSet,
    priorMaintainerSet,
  );
  const cadenceMetrics = compressedCadenceMetrics(gapMetrics);
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
  const provenanceDigests = collectProvenanceDigests(provenanceCandidate);
  const provenanceKeyIds = collectProvenanceKeyIds(provenanceCandidate);
  const provenanceSignatures = collectProvenanceSignatures(provenanceCandidate);
  const provenancePredicateTypes =
    collectProvenancePredicateTypes(provenanceCandidate);
  const priorPublisherName =
    priorVersionBody?._npmUser?.name || priorVersionBody?.publisher?.name;
  const publisherDrift =
    publisherName &&
    priorPublisherName &&
    publisherName.trim().toLowerCase() !==
      priorPublisherName.trim().toLowerCase();

  appendProperty(
    properties,
    "cdx:npm:packageCreatedTime",
    packument?.time?.created,
  );
  appendProperty(
    properties,
    "cdx:npm:lastModifiedTime",
    packument?.time?.modified,
  );
  appendProperty(properties, "cdx:npm:publishTime", publishTime);
  appendProperty(properties, "cdx:npm:publisher", publisherName);
  appendProperty(properties, "cdx:npm:publisherEmail", publisherEmail);
  appendProperty(
    properties,
    "cdx:npm:maintainerSet",
    currentMaintainerSet.join(", "),
  );
  appendProperty(
    properties,
    "cdx:npm:priorMaintainerSet",
    priorMaintainerSet.join(", "),
  );
  appendProperty(
    properties,
    "cdx:npm:maintainerSetCount",
    currentMaintainerSet.length,
  );
  appendProperty(
    properties,
    "cdx:npm:priorMaintainerSetCount",
    priorMaintainerSet.length,
  );
  appendProperty(
    properties,
    "cdx:npm:maintainerOverlapCount",
    overlapMetrics.overlapCount,
  );
  appendProperty(
    properties,
    "cdx:npm:maintainerOverlapRatio",
    overlapMetrics.overlapRatio?.toFixed(2),
  );
  if (maintainerSetDrift) {
    appendProperty(properties, "cdx:npm:maintainerSetDrift", "true");
  }
  if (overlapMetrics.partialDrift) {
    appendProperty(properties, "cdx:npm:maintainerSetPartialDrift", "true");
  }
  appendProperty(
    properties,
    "cdx:npm:versionCount",
    versionPublishTimes.length,
  );
  appendProperty(
    properties,
    "cdx:npm:releaseGapDays",
    gapMetrics.currentGapDays?.toFixed(2),
  );
  appendProperty(
    properties,
    "cdx:npm:releaseGapBaselineDays",
    gapMetrics.baselineDays?.toFixed(2),
  );
  appendProperty(
    properties,
    "cdx:npm:releaseGapSampleSize",
    gapMetrics.sampleSize,
  );
  appendProperty(
    properties,
    "cdx:npm:releaseCadenceCompressionRatio",
    cadenceMetrics.compressionRatio?.toFixed(2),
  );
  appendProperty(
    properties,
    "cdx:npm:priorVersion",
    priorReleaseEntry?.version,
  );
  appendProperty(
    properties,
    "cdx:npm:priorPublishTime",
    priorReleaseEntry
      ? packument?.time?.[priorReleaseEntry.version]
      : undefined,
  );
  appendProperty(properties, "cdx:npm:priorPublisher", priorPublisherName);
  if (publisherDrift) {
    appendProperty(properties, "cdx:npm:publisherDrift", "true");
  }
  if (cadenceMetrics.compressedCadence) {
    appendProperty(properties, "cdx:npm:compressedCadence", "true");
  }
  if (hasTrustedPublishingEvidence(provenanceCandidate)) {
    appendProperty(properties, "cdx:npm:trustedPublishing", "true");
  }
  appendProperty(
    properties,
    "cdx:npm:artifactIntegrity",
    versionBody?.dist?.integrity,
  );
  appendProperty(
    properties,
    "cdx:npm:artifactShasum",
    versionBody?.dist?.shasum,
  );
  appendProperty(properties, "cdx:npm:provenanceUrl", provenanceUrl);
  appendJoinedProperty(
    properties,
    "cdx:npm:provenanceDigest",
    provenanceDigests,
  );
  appendJoinedProperty(properties, "cdx:npm:provenanceKeyId", provenanceKeyIds);
  appendJoinedProperty(
    properties,
    "cdx:npm:provenanceSignature",
    provenanceSignatures,
  );
  appendJoinedProperty(
    properties,
    "cdx:npm:provenancePredicateType",
    provenancePredicateTypes,
  );
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
  const releaseEntries = [];
  for (const [releaseVersion, releaseFilesForVersion] of Object.entries(
    projectBody?.releases || {},
  )) {
    if (
      !Array.isArray(releaseFilesForVersion) ||
      !releaseFilesForVersion.length
    ) {
      continue;
    }
    const releaseUploadTimes = uniqueStrings(
      releaseFilesForVersion.map(
        (file) =>
          file?.upload_time_iso_8601 || file?.upload_time || file?.uploadTime,
      ),
    );
    const earliestUploadTime = releaseUploadTimes
      .map((uploadTime) => ({
        raw: uploadTime,
        timestamp: parseTimestamp(uploadTime),
      }))
      .filter((entry) => entry.timestamp !== undefined)
      .sort((left, right) => left.timestamp - right.timestamp)[0];
    if (!earliestUploadTime) {
      continue;
    }
    releaseEntries.push({
      publishers: uniqueStrings(
        releaseFilesForVersion.map(
          (file) => file?.uploader || file?.uploaded_by,
        ),
      ),
      timestamp: earliestUploadTime.timestamp,
      uploadTime: earliestUploadTime.raw,
      version: releaseVersion,
    });
  }
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
    releaseFiles.map(
      (file) =>
        normalizeProvenanceUrl(file?.provenance) ||
        normalizeProvenanceUrl(file?.attestations) ||
        normalizeProvenanceUrl(file?.provenance_url) ||
        normalizeProvenanceUrl(file?.attestation_url),
    ),
  );
  const artifactDigestSha256 = uniqueStrings(
    releaseFiles.map((file) => file?.digests?.sha256 || file?.sha256_digest),
  );
  const artifactDigestBlake2b256 = uniqueStrings(
    releaseFiles.map((file) => file?.digests?.blake2b_256 || file?.blake2b_256),
  );
  const artifactDigestMd5 = uniqueStrings(
    releaseFiles.map((file) => file?.digests?.md5 || file?.md5_digest),
  );
  const provenanceDigests = uniqueStrings(
    releaseFiles.flatMap((file) =>
      collectProvenanceDigests(
        file?.provenance ||
          file?.attestations ||
          file?.provenance_url ||
          file?.attestation_url,
      ),
    ),
  );
  const provenanceKeyIds = uniqueStrings(
    releaseFiles.flatMap((file) =>
      collectProvenanceKeyIds(file?.provenance || file?.attestations),
    ),
  );
  const provenanceSignatures = uniqueStrings(
    releaseFiles.flatMap((file) =>
      collectProvenanceSignatures(file?.provenance || file?.attestations),
    ),
  );
  const provenancePredicateTypes = uniqueStrings(
    releaseFiles.flatMap((file) =>
      collectProvenancePredicateTypes(file?.provenance || file?.attestations),
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
  const currentPublishTimestamp = parseTimestamp(uploadTimes[0]);
  const priorReleaseEntry = sortReleaseEntries(
    releaseEntries.filter(
      (entry) =>
        entry.version !== version &&
        currentPublishTimestamp !== undefined &&
        entry.timestamp < currentPublishTimestamp,
    ),
  ).pop();
  const currentUploaders = uniqueStrings(uploaders);
  const currentUploaderSet = uniqueIdentities(currentUploaders);
  const priorUploaderSet = uniqueIdentities(
    priorReleaseEntry?.publishers || [],
  );
  const uploaderSetDrift = isDisjointIdentitySet(
    currentUploaderSet,
    priorUploaderSet,
  );
  const gapMetrics = releaseGapMetrics(releaseEntries, version);
  const overlapMetrics = identityOverlapMetrics(
    currentUploaderSet,
    priorUploaderSet,
  );
  const cadenceMetrics = compressedCadenceMetrics(gapMetrics);
  const publisherDrift =
    currentUploaders.length > 0 &&
    priorReleaseEntry?.publishers?.length > 0 &&
    currentUploaders.every(
      (currentUploader) =>
        !priorReleaseEntry.publishers.some(
          (previousUploader) =>
            previousUploader.toLowerCase() === currentUploader.toLowerCase(),
        ),
    );

  appendProperty(
    properties,
    "cdx:pypi:packageCreatedTime",
    sortReleaseEntries([...releaseEntries])[0]?.uploadTime,
  );
  appendProperty(properties, "cdx:pypi:publishTime", uploadTimes[0]);
  appendProperty(properties, "cdx:pypi:versionCount", releaseEntries.length);
  appendProperty(properties, "cdx:pypi:publisher", uploaders.join(", "));
  appendProperty(
    properties,
    "cdx:pypi:uploaderSet",
    currentUploaderSet.join(", "),
  );
  appendProperty(
    properties,
    "cdx:pypi:priorUploaderSet",
    priorUploaderSet.join(", "),
  );
  appendProperty(
    properties,
    "cdx:pypi:uploaderSetCount",
    currentUploaderSet.length,
  );
  appendProperty(
    properties,
    "cdx:pypi:priorUploaderSetCount",
    priorUploaderSet.length,
  );
  appendProperty(
    properties,
    "cdx:pypi:uploaderOverlapCount",
    overlapMetrics.overlapCount,
  );
  appendProperty(
    properties,
    "cdx:pypi:uploaderOverlapRatio",
    overlapMetrics.overlapRatio?.toFixed(2),
  );
  if (uploaderSetDrift) {
    appendProperty(properties, "cdx:pypi:uploaderSetDrift", "true");
  }
  if (overlapMetrics.partialDrift) {
    appendProperty(properties, "cdx:pypi:uploaderSetPartialDrift", "true");
  }
  appendProperty(
    properties,
    "cdx:pypi:releaseGapDays",
    gapMetrics.currentGapDays?.toFixed(2),
  );
  appendProperty(
    properties,
    "cdx:pypi:releaseGapBaselineDays",
    gapMetrics.baselineDays?.toFixed(2),
  );
  appendProperty(
    properties,
    "cdx:pypi:releaseGapSampleSize",
    gapMetrics.sampleSize,
  );
  appendProperty(
    properties,
    "cdx:pypi:releaseCadenceCompressionRatio",
    cadenceMetrics.compressionRatio?.toFixed(2),
  );
  appendProperty(
    properties,
    "cdx:pypi:priorVersion",
    priorReleaseEntry?.version,
  );
  appendProperty(
    properties,
    "cdx:pypi:priorPublishTime",
    priorReleaseEntry?.uploadTime,
  );
  appendProperty(
    properties,
    "cdx:pypi:priorPublisher",
    priorReleaseEntry?.publishers?.join(", "),
  );
  if (publisherDrift) {
    appendProperty(properties, "cdx:pypi:publisherDrift", "true");
  }
  if (cadenceMetrics.compressedCadence) {
    appendProperty(properties, "cdx:pypi:compressedCadence", "true");
  }
  if (uploaderVerified) {
    appendProperty(properties, "cdx:pypi:uploaderVerified", "true");
  }
  if (trustedPublishing) {
    appendProperty(properties, "cdx:pypi:trustedPublishing", "true");
  }
  appendJoinedProperty(
    properties,
    "cdx:pypi:artifactDigestSha256",
    artifactDigestSha256,
  );
  appendJoinedProperty(
    properties,
    "cdx:pypi:artifactDigestBlake2b256",
    artifactDigestBlake2b256,
  );
  appendJoinedProperty(
    properties,
    "cdx:pypi:artifactDigestMd5",
    artifactDigestMd5,
  );
  appendProperty(properties, "cdx:pypi:provenanceUrl", provenanceUrls[0]);
  appendJoinedProperty(
    properties,
    "cdx:pypi:provenanceDigest",
    provenanceDigests,
  );
  appendJoinedProperty(
    properties,
    "cdx:pypi:provenanceKeyId",
    provenanceKeyIds,
  );
  appendJoinedProperty(
    properties,
    "cdx:pypi:provenanceSignature",
    provenanceSignatures,
  );
  appendJoinedProperty(
    properties,
    "cdx:pypi:provenancePredicateType",
    provenancePredicateTypes,
  );
  return properties;
}
