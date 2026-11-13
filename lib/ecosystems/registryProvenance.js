// One registry document answers for every locked version of a package, so a
// value read from it is repeated on each of those components. Values longer
// than these limits are dropped to keep the BOM proportional to the lockfile.
// Joined lists (e.g. the digests of every file of a PyPI release) get more room.
const MAX_PROPERTY_VALUE_LENGTH = 4096;
const MAX_JOINED_PROPERTY_VALUE_LENGTH = 16384;

function appendProperty(
  properties,
  name,
  value,
  maxLength = MAX_PROPERTY_VALUE_LENGTH,
) {
  if (!name || value === undefined || value === null || value === "") {
    return;
  }
  const text = typeof value === "string" ? value : String(value);
  if (text.length > maxLength) {
    return;
  }
  properties.push({ name, value: text });
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

function heapPush(heap, value, isBefore) {
  heap.push(value);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = (index - 1) >> 1;
    if (!isBefore(heap[index], heap[parent])) {
      break;
    }
    [heap[index], heap[parent]] = [heap[parent], heap[index]];
    index = parent;
  }
}

function heapPop(heap, isBefore) {
  const top = heap[0];
  const last = heap.pop();
  if (heap.length) {
    heap[0] = last;
    let index = 0;
    for (;;) {
      const left = 2 * index + 1;
      const right = left + 1;
      let next = index;
      if (left < heap.length && isBefore(heap[left], heap[next])) {
        next = left;
      }
      if (right < heap.length && isBefore(heap[right], heap[next])) {
        next = right;
      }
      if (next === index) {
        break;
      }
      [heap[index], heap[next]] = [heap[next], heap[index]];
      index = next;
    }
  }
  return top;
}

const isGreater = (left, right) => left > right;
const isLess = (left, right) => left < right;

/**
 * Median of every prefix of a list: element k is the median of the first k
 * numbers, so element 0 is undefined. The lower half is kept in a max-heap and
 * the upper half in a min-heap, which costs n log n for all prefixes together
 * instead of a sort per prefix.
 *
 * @param {number[]} numbers values in the order they join the prefix
 * @returns {(number|undefined)[]} numbers.length + 1 medians
 */
function prefixMedians(numbers) {
  const lower = [];
  const upper = [];
  const medians = [undefined];
  for (const value of numbers) {
    if (!lower.length || value <= lower[0]) {
      heapPush(lower, value, isGreater);
    } else {
      heapPush(upper, value, isLess);
    }
    if (lower.length > upper.length + 1) {
      heapPush(upper, heapPop(lower, isGreater), isLess);
    } else if (upper.length > lower.length) {
      heapPush(lower, heapPop(upper, isLess), isGreater);
    }
    medians.push(
      lower.length > upper.length ? lower[0] : (lower[0] + upper[0]) / 2,
    );
  }
  return medians;
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

// Both comparisons take the right-hand list's Set when the caller already has
// one, so comparing against a shared prior release costs only the size of the
// left-hand list.
function isDisjointIdentitySet(
  leftSet,
  rightSet,
  rightValues = new Set(rightSet),
) {
  if (!leftSet.length || !rightSet.length) {
    return false;
  }
  return leftSet.every((leftValue) => !rightValues.has(leftValue));
}

function identityOverlapMetrics(
  leftSet,
  rightSet,
  rightValues = new Set(rightSet),
) {
  if (!leftSet.length || !rightSet.length) {
    return {};
  }
  const overlapCount = leftSet.filter((leftValue) =>
    rightValues.has(leftValue),
  ).length;
  const leftOnly = new Set(
    leftSet.filter((leftValue) => !rightValues.has(leftValue)),
  );
  const unionCount = rightValues.size + leftOnly.size;
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

/**
 * A list of identities as the collectors compare and emit it: the normalized
 * unique values in first-seen order, a Set to probe and the joined text.
 *
 * @param {Array<string|undefined>} values identities in any spelling
 * @returns {{joined: string, list: string[], lookup: Set<string>}}
 */
function identitySet(values) {
  const list = uniqueIdentities(values);
  return { joined: list.join(", "), list, lookup: new Set(list) };
}

const npmMaintainerSets = new WeakMap();

/**
 * The maintainer identities of one npm version entry, built once per entry.
 * When many locked versions share one publish time, a single older release is
 * the prior release of all of them, and building its set per call would cost
 * the number of locked versions times the length of its maintainer list.
 *
 * @param {object|undefined} versionBody `versions[<version>]` of a packument
 * @returns {{joined: string, list: string[], lookup: Set<string>}}
 */
function npmMaintainerSet(versionBody) {
  const cacheable = versionBody && typeof versionBody === "object";
  let maintainerSet = cacheable
    ? npmMaintainerSets.get(versionBody)
    : undefined;
  if (!maintainerSet) {
    maintainerSet = identitySet([
      ...extractMaintainerIdentities(versionBody?.maintainers),
      versionBody?._npmUser?.name,
      versionBody?._npmUser?.email,
      versionBody?.publisher?.name,
      versionBody?.publisher?.email,
    ]);
    if (cacheable) {
      npmMaintainerSets.set(versionBody, maintainerSet);
    }
  }
  return maintainerSet;
}

const pypiUploaderSets = new WeakMap();

/**
 * The uploader identities of one cached PyPI release entry, built once per
 * entry for the same reason as {@link npmMaintainerSet}. `lowercase` keeps
 * the publishers lower-cased but otherwise as listed, which is what the
 * publisher drift check compares, and `publishers` is their text as listed.
 *
 * @param {object|undefined} releaseEntry entry of the cached release history
 * @returns {{joined: string, list: string[], lookup: Set<string>, lowercase: Set<string>, publishers: string}}
 */
function pypiUploaderSet(releaseEntry) {
  let uploaderSet = releaseEntry
    ? pypiUploaderSets.get(releaseEntry)
    : undefined;
  if (!uploaderSet) {
    const publishers = releaseEntry?.publishers || [];
    uploaderSet = {
      ...identitySet(publishers),
      lowercase: new Set(
        publishers.map((publisher) => publisher.toLowerCase()),
      ),
      publishers: publishers.join(", "),
    };
    if (releaseEntry) {
      pypiUploaderSets.set(releaseEntry, uploaderSet);
    }
  }
  return uploaderSet;
}

// One cache per ecosystem: each collector reads a different part of the
// document, so a history built by one must never answer another.
const releaseHistories = {
  cargo: new WeakMap(),
  npm: new WeakMap(),
  pypi: new WeakMap(),
};

/**
 * Sort the releases by publish time and derive, for every position, the gap
 * metrics that depend only on the earlier releases.
 *
 * @param {object[]} releaseEntries release entries, each with `timestamp` and
 *   `version`; sorted in place
 * @returns {object} sorted entries, first index per version, gaps and medians
 */
function buildReleaseHistory(releaseEntries) {
  const sortedEntries = sortReleaseEntries(releaseEntries);
  const indexByVersion = new Map();
  const gapDays = [];
  sortedEntries.forEach((entry, index) => {
    if (!indexByVersion.has(entry.version)) {
      indexByVersion.set(entry.version, index);
    }
    if (index > 0) {
      gapDays.push(
        (entry.timestamp - sortedEntries[index - 1].timestamp) /
          (1000 * 60 * 60 * 24),
      );
    }
  });
  return {
    baselineDays: prefixMedians(gapDays),
    gapDays,
    indexByVersion,
    sortedEntries,
  };
}

/**
 * Release history of a registry document, built once and cached against the
 * document. The metadata loops hand the same document to the collector for
 * every locked version of a package, so building it per call would parse and
 * sort the whole history again for each one: the cost would be the product of
 * the versions the project locks and the releases the registry lists, both of
 * which the scanned project controls.
 *
 * @param {"cargo"|"npm"|"pypi"} ecosystem collector the history is built for
 * @param {object} registryDocument registry document the entries come from
 * @param {Function} buildReleaseEntries returns the document's release entries
 * @returns {object} see {@link buildReleaseHistory}
 */
function cachedReleaseHistory(
  ecosystem,
  registryDocument,
  buildReleaseEntries,
) {
  const cache = releaseHistories[ecosystem];
  const cacheable = registryDocument && typeof registryDocument === "object";
  let history = cacheable ? cache.get(registryDocument) : undefined;
  if (!history) {
    history = buildReleaseHistory(buildReleaseEntries());
    if (cacheable) {
      cache.set(registryDocument, history);
    }
  }
  return history;
}

function releaseGapMetrics(history, currentVersion) {
  const currentIndex = history.indexByVersion.get(currentVersion);
  if (currentIndex === undefined || currentIndex < 1) {
    return {};
  }
  return {
    baselineDays: history.baselineDays[currentIndex - 1],
    currentGapDays: history.gapDays[currentIndex - 1],
    sampleSize: currentIndex - 1,
  };
}

/**
 * The latest release published before the given time, other than the current
 * version itself. Among releases with the same time, the one listed last in
 * the document wins, as before.
 */
function findPriorRelease(history, currentVersion, currentPublishTimestamp) {
  if (currentPublishTimestamp === undefined) {
    return undefined;
  }
  const { sortedEntries } = history;
  let low = 0;
  let high = sortedEntries.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sortedEntries[middle].timestamp < currentPublishTimestamp) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  for (let index = low - 1; index >= 0; index -= 1) {
    if (sortedEntries[index].version !== currentVersion) {
      return sortedEntries[index];
    }
  }
  return undefined;
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
  appendProperty(
    properties,
    name,
    uniqueStrings(values).join(", "),
    MAX_JOINED_PROPERTY_VALUE_LENGTH,
  );
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
  const history = cachedReleaseHistory("npm", packument, () =>
    Object.entries(packument?.time || {})
      .filter(
        ([entryName, entryValue]) =>
          !["created", "modified"].includes(entryName) &&
          typeof entryValue === "string" &&
          parseTimestamp(entryValue) !== undefined,
      )
      .map(([entryName, entryValue]) => ({
        timestamp: parseTimestamp(entryValue),
        version: entryName,
      })),
  );
  const currentPublishTimestamp = parseTimestamp(publishTime);
  const priorReleaseEntry = findPriorRelease(
    history,
    version,
    currentPublishTimestamp,
  );
  const priorVersionBody = priorReleaseEntry
    ? packument?.versions?.[priorReleaseEntry.version]
    : undefined;
  const currentMaintainers = npmMaintainerSet(versionBody);
  const priorMaintainers = npmMaintainerSet(priorVersionBody);
  const currentMaintainerSet = currentMaintainers.list;
  const priorMaintainerSet = priorMaintainers.list;
  const maintainerSetDrift = isDisjointIdentitySet(
    currentMaintainerSet,
    priorMaintainerSet,
    priorMaintainers.lookup,
  );
  const gapMetrics = releaseGapMetrics(history, version);
  const overlapMetrics = identityOverlapMetrics(
    currentMaintainerSet,
    priorMaintainerSet,
    priorMaintainers.lookup,
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
    currentMaintainers.joined,
    MAX_JOINED_PROPERTY_VALUE_LENGTH,
  );
  appendProperty(
    properties,
    "cdx:npm:priorMaintainerSet",
    priorMaintainers.joined,
    MAX_JOINED_PROPERTY_VALUE_LENGTH,
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
    history.sortedEntries.length,
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

function pypiReleaseEntries(projectBody) {
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
  return releaseEntries;
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
  const history = cachedReleaseHistory("pypi", projectBody, () =>
    pypiReleaseEntries(projectBody),
  );
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
  const priorReleaseEntry = findPriorRelease(
    history,
    version,
    currentPublishTimestamp,
  );
  const currentUploaders = uniqueStrings(uploaders);
  const currentUploaderSet = uniqueIdentities(currentUploaders);
  const priorUploaders = pypiUploaderSet(priorReleaseEntry);
  const priorUploaderSet = priorUploaders.list;
  const uploaderSetDrift = isDisjointIdentitySet(
    currentUploaderSet,
    priorUploaderSet,
    priorUploaders.lookup,
  );
  const gapMetrics = releaseGapMetrics(history, version);
  const overlapMetrics = identityOverlapMetrics(
    currentUploaderSet,
    priorUploaderSet,
    priorUploaders.lookup,
  );
  const cadenceMetrics = compressedCadenceMetrics(gapMetrics);
  const priorPublishers = priorUploaders.lowercase;
  const publisherDrift =
    currentUploaders.length > 0 &&
    priorPublishers.size > 0 &&
    currentUploaders.every(
      (currentUploader) => !priorPublishers.has(currentUploader.toLowerCase()),
    );

  appendProperty(
    properties,
    "cdx:pypi:packageCreatedTime",
    history.sortedEntries[0]?.uploadTime,
  );
  appendProperty(properties, "cdx:pypi:publishTime", uploadTimes[0]);
  appendProperty(
    properties,
    "cdx:pypi:versionCount",
    history.sortedEntries.length,
  );
  appendProperty(
    properties,
    "cdx:pypi:publisher",
    uploaders.join(", "),
    MAX_JOINED_PROPERTY_VALUE_LENGTH,
  );
  appendProperty(
    properties,
    "cdx:pypi:uploaderSet",
    currentUploaderSet.join(", "),
    MAX_JOINED_PROPERTY_VALUE_LENGTH,
  );
  appendProperty(
    properties,
    "cdx:pypi:priorUploaderSet",
    priorUploaders.joined,
    MAX_JOINED_PROPERTY_VALUE_LENGTH,
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
    priorUploaders.publishers,
    MAX_JOINED_PROPERTY_VALUE_LENGTH,
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

/**
 * Extract Cargo/crates.io release, publisher, and provenance-adjacent properties.
 *
 * @param {object} crateBody crates.io `/api/v1/crates/{name}` response body
 * @param {string | undefined} version crate version
 * @param {object} [ownersBody] crates.io `/api/v1/crates/{name}/owners` response body
 * @returns {object[]} custom properties
 */
export function collectCargoRegistryProvenanceProperties(
  crateBody,
  version,
  ownersBody,
) {
  const properties = [];
  const versions = Array.isArray(crateBody?.versions) ? crateBody.versions : [];
  const currentVersionBody =
    versions.find((entry) => entry?.num === version) || versions[0];
  if (!currentVersionBody) {
    return properties;
  }
  const history = cachedReleaseHistory("cargo", crateBody, () =>
    versions
      .map((entry) => ({
        publishers: uniqueStrings([
          entry?.published_by?.login,
          entry?.published_by?.name,
        ]),
        timestamp: parseTimestamp(entry?.created_at || entry?.updated_at),
        version: entry?.num,
        rawTime: entry?.created_at || entry?.updated_at,
      }))
      .filter((entry) => entry.version && entry.timestamp !== undefined),
  );
  const currentPublishTimestamp = parseTimestamp(
    currentVersionBody?.created_at || currentVersionBody?.updated_at,
  );
  const priorReleaseEntry = findPriorRelease(
    history,
    currentVersionBody?.num,
    currentPublishTimestamp,
  );
  const gapMetrics = releaseGapMetrics(history, currentVersionBody?.num);
  const cadenceMetrics = compressedCadenceMetrics(gapMetrics);
  const currentPublisherSet = uniqueIdentities([
    currentVersionBody?.published_by?.login,
    currentVersionBody?.published_by?.name,
  ]);
  const priorPublisherSet = uniqueIdentities(
    priorReleaseEntry?.publishers || [],
  );
  const overlapMetrics = identityOverlapMetrics(
    currentPublisherSet,
    priorPublisherSet,
  );
  const publisherDrift = isDisjointIdentitySet(
    currentPublisherSet,
    priorPublisherSet,
  );
  const ownerSet = uniqueIdentities(
    (ownersBody?.users || []).flatMap((owner) => [owner?.login, owner?.name]),
  );
  const trustpubCandidate =
    currentVersionBody?.trustpub_data ||
    currentVersionBody?.trustpubData ||
    crateBody?.crate?.trustpub_data ||
    crateBody?.crate?.trustpubData ||
    crateBody?.versions?.find((entry) => entry?.trustpub_data)?.trustpub_data;
  const provenanceUrl = normalizeProvenanceUrl(trustpubCandidate);
  const provenanceDigests = collectProvenanceDigests(trustpubCandidate);
  const provenanceKeyIds = collectProvenanceKeyIds(trustpubCandidate);
  const provenanceSignatures = collectProvenanceSignatures(trustpubCandidate);
  const provenancePredicateTypes =
    collectProvenancePredicateTypes(trustpubCandidate);

  appendProperty(
    properties,
    "cdx:cargo:packageCreatedTime",
    history.sortedEntries[0]?.rawTime,
  );
  appendProperty(
    properties,
    "cdx:cargo:publishTime",
    currentVersionBody?.created_at || currentVersionBody?.updated_at,
  );
  appendProperty(
    properties,
    "cdx:cargo:versionCount",
    history.sortedEntries.length,
  );
  appendProperty(
    properties,
    "cdx:cargo:publisher",
    currentVersionBody?.published_by?.login ||
      currentVersionBody?.published_by?.name,
  );
  appendProperty(
    properties,
    "cdx:cargo:priorPublisher",
    priorReleaseEntry?.publishers?.join(", "),
    MAX_JOINED_PROPERTY_VALUE_LENGTH,
  );
  appendProperty(
    properties,
    "cdx:cargo:publisherSet",
    currentPublisherSet.join(", "),
    MAX_JOINED_PROPERTY_VALUE_LENGTH,
  );
  appendProperty(
    properties,
    "cdx:cargo:publisherSetCount",
    currentPublisherSet.length,
  );
  appendProperty(
    properties,
    "cdx:cargo:ownerSet",
    ownerSet.join(", "),
    MAX_JOINED_PROPERTY_VALUE_LENGTH,
  );
  appendProperty(properties, "cdx:cargo:ownerSetCount", ownerSet.length);
  appendProperty(
    properties,
    "cdx:cargo:publisherOverlapCount",
    overlapMetrics.overlapCount,
  );
  appendProperty(
    properties,
    "cdx:cargo:publisherOverlapRatio",
    overlapMetrics.overlapRatio?.toFixed(2),
  );
  appendProperty(
    properties,
    "cdx:cargo:priorVersion",
    priorReleaseEntry?.version,
  );
  appendProperty(
    properties,
    "cdx:cargo:priorPublishTime",
    priorReleaseEntry?.rawTime,
  );
  appendProperty(
    properties,
    "cdx:cargo:releaseGapDays",
    gapMetrics.currentGapDays?.toFixed(2),
  );
  appendProperty(
    properties,
    "cdx:cargo:releaseGapBaselineDays",
    gapMetrics.baselineDays?.toFixed(2),
  );
  appendProperty(
    properties,
    "cdx:cargo:releaseGapSampleSize",
    gapMetrics.sampleSize,
  );
  appendProperty(
    properties,
    "cdx:cargo:releaseCadenceCompressionRatio",
    cadenceMetrics.compressionRatio?.toFixed(2),
  );
  appendProperty(
    properties,
    "cdx:cargo:artifactDigestSha256",
    currentVersionBody?.checksum,
  );
  appendProperty(properties, "cdx:cargo:edition", currentVersionBody?.edition);
  appendProperty(properties, "cdx:cargo:hasLib", currentVersionBody?.has_lib);
  appendJoinedProperty(
    properties,
    "cdx:cargo:binNames",
    Array.isArray(currentVersionBody?.bin_names)
      ? currentVersionBody.bin_names
      : [],
  );
  appendProperty(
    properties,
    "cdx:cargo:crateSize",
    currentVersionBody?.crate_size,
  );
  if (currentVersionBody?.yanked === true) {
    appendProperty(properties, "cdx:cargo:yanked", "true");
  }
  if (publisherDrift) {
    appendProperty(properties, "cdx:cargo:publisherDrift", "true");
  }
  if (overlapMetrics.partialDrift) {
    appendProperty(properties, "cdx:cargo:publisherSetPartialDrift", "true");
  }
  if (cadenceMetrics.compressedCadence) {
    appendProperty(properties, "cdx:cargo:compressedCadence", "true");
  }
  if (
    crateBody?.crate?.trustpub_only === true ||
    hasTrustedPublishingEvidence(trustpubCandidate)
  ) {
    appendProperty(properties, "cdx:cargo:trustedPublishing", "true");
  }
  appendProperty(properties, "cdx:cargo:provenanceUrl", provenanceUrl);
  appendJoinedProperty(
    properties,
    "cdx:cargo:provenanceDigest",
    provenanceDigests,
  );
  appendJoinedProperty(
    properties,
    "cdx:cargo:provenanceKeyId",
    provenanceKeyIds,
  );
  appendJoinedProperty(
    properties,
    "cdx:cargo:provenanceSignature",
    provenanceSignatures,
  );
  appendJoinedProperty(
    properties,
    "cdx:cargo:provenancePredicateType",
    provenancePredicateTypes,
  );
  return properties;
}
