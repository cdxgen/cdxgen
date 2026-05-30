import process from "node:process";

import {
  createHuggingFaceComponentReference,
  createHuggingFaceDatasetReference,
  createHuggingFaceModelCard,
} from "../../parsers/huggingfaceManifest.js";
import {
  detectAiModelVariants,
  normalizeDetectedVariants,
} from "../aiModelVariants.js";
import {
  encodeHuggingFacePathSegments,
  HF_BASE_URL,
  HUGGING_FACE_ANCESTOR_RELATIONS,
  quantizationValueFromConfig,
  repositoryUrlForHuggingFaceAssetType,
  sanitizeHuggingFaceRepoId,
  toHuggingFaceAssetPath,
  toHuggingFaceAssetUrl,
  toHuggingFacePurl,
} from "../huggingfaceUtils.js";
import { sanitizeStructuredValueForBom } from "../propertySanitizer.js";
import {
  cdxgenAgent,
  getLicenses,
  isDryRun,
  recordActivity,
} from "../utils.js";

const CACHE_MISS = Symbol("huggingface-cache-miss");
const HUGGING_FACE_CACHE_TTL_MS =
  Number.parseInt(process.env.CDXGEN_HUGGINGFACE_CACHE_TTL_MS || "", 10) ||
  5 * 60 * 1000;
const HUGGING_FACE_CACHE_MAX_ENTRIES =
  Number.parseInt(process.env.CDXGEN_HUGGINGFACE_CACHE_MAX_ENTRIES || "", 10) ||
  256;
const HUGGING_FACE_REQUEST_TIMEOUT = {
  lookup: 1000,
  connect: 5000,
  secureConnect: 5000,
  socket: 10000,
  send: 10000,
  response: 10000,
};
const HUGGING_FACE_ACCESS_TOKEN =
  process.env.HF_TOKEN ||
  process.env.HUGGING_FACE_HUB_TOKEN ||
  process.env.HUGGINGFACE_TOKEN;
const HUGGING_FACE_MODEL_EXPAND_KEYS = [
  "pipeline_tag",
  "private",
  "gated",
  "downloads",
  "likes",
  "lastModified",
  "author",
  "cardData",
  "config",
  "createdAt",
  "disabled",
  "downloadsAllTime",
  "inferenceProviderMapping",
  "library_name",
  "model-index",
  "safetensors",
  "sha",
  "siblings",
  "spaces",
  "tags",
];
const HUGGING_FACE_DATASET_EXPAND_KEYS = [
  "private",
  "downloads",
  "gated",
  "likes",
  "lastModified",
  "author",
  "cardData",
  "citation",
  "createdAt",
  "description",
  "disabled",
  "downloadsAllTime",
  "paperswithcode_id",
  "sha",
  "tags",
];
const HUGGING_FACE_SPACE_EXPAND_KEYS = [
  "sdk",
  "likes",
  "private",
  "lastModified",
  "author",
  "cardData",
  "datasets",
  "disabled",
  "createdAt",
  "models",
  "runtime",
  "sha",
  "subdomain",
  "tags",
];

const createExpiringCache = () => {
  const entries = new Map();
  const deleteExpiredEntries = (now = Date.now()) => {
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= now) {
        entries.delete(key);
      }
    }
  };
  return {
    clear() {
      entries.clear();
    },
    get(key) {
      deleteExpiredEntries();
      const entry = entries.get(key);
      if (!entry) {
        return { hit: false, value: undefined };
      }
      entries.delete(key);
      entries.set(key, entry);
      return {
        hit: true,
        value: entry.value === CACHE_MISS ? undefined : entry.value,
      };
    },
    set(key, value) {
      deleteExpiredEntries();
      entries.delete(key);
      entries.set(key, {
        expiresAt: Date.now() + HUGGING_FACE_CACHE_TTL_MS,
        value: value === undefined ? CACHE_MISS : value,
      });
      while (entries.size > HUGGING_FACE_CACHE_MAX_ENTRIES) {
        entries.delete(entries.keys().next().value);
      }
    },
  };
};

const responseCache = createExpiringCache();
const payloadCache = createExpiringCache();

export {
  normalizeHuggingFaceReference,
  toHuggingFacePurl,
} from "../huggingfaceUtils.js";

/**
 * Clear the in-process Hugging Face caches used for remote metadata lookup.
 */
export function resetHuggingFaceRemoteCaches() {
  responseCache.clear();
  payloadCache.clear();
}

const normalizeLicenseFilePath = (licensePath) =>
  String(licensePath || "")
    .trim()
    .replace(/^\/+?/u, "")
    .replaceAll(/\/+?/gu, "/");

const apiPathForType = (assetType, repoId) => {
  const encodedRepoId = encodeHuggingFacePathSegments(repoId);
  switch (assetType) {
    case "dataset":
      return `datasets/${encodedRepoId}`;
    case "space":
      return `spaces/${encodedRepoId}`;
    default:
      return `models/${encodedRepoId}`;
  }
};

const expandQueryForType = (assetType) => {
  const expandKeys =
    assetType === "dataset"
      ? HUGGING_FACE_DATASET_EXPAND_KEYS
      : assetType === "space"
        ? HUGGING_FACE_SPACE_EXPAND_KEYS
        : HUGGING_FACE_MODEL_EXPAND_KEYS;
  return new URLSearchParams(
    expandKeys.map((key) => ["expand", key]),
  ).toString();
};

const resolveHuggingFaceAccessToken = (options = {}) =>
  options.huggingFaceAccessToken ||
  options.huggingFaceToken ||
  HUGGING_FACE_ACCESS_TOKEN;

const resolveHuggingFaceRevision = (options = {}) => {
  const revision =
    options.huggingFaceRevision ||
    options.version ||
    options.revision ||
    "HEAD";
  return String(revision || "HEAD").trim() || "HEAD";
};

const toTrustedHuggingFaceUrl = (candidate) => {
  if (typeof candidate !== "string") {
    return undefined;
  }
  const trimmed = candidate.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    if (!/^https?:$/iu.test(parsed.protocol)) {
      return undefined;
    }
    if (parsed.username || parsed.password) {
      return undefined;
    }
    if (
      parsed.hostname !== "huggingface.co" &&
      !parsed.hostname.endsWith(".huggingface.co")
    ) {
      return undefined;
    }
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/u, "");
  } catch {
    return undefined;
  }
};

const selectLicenseFileUrl = (payload, assetType, repoId) => {
  const cardData = payload?.cardData || {};
  for (const candidate of [
    cardData?.license_link,
    cardData?.licenseLink,
    cardData?.license_url,
    cardData?.licenseUrl,
    payload?.licenseUrl,
    payload?.license_url,
  ]) {
    const trustedUrl = toTrustedHuggingFaceUrl(candidate);
    if (trustedUrl) {
      return trustedUrl;
    }
  }
  const licenseSibling = normalizeArray(payload?.siblings).find((sibling) => {
    const siblingPath = normalizeLicenseFilePath(
      sibling?.rfilename || sibling?.path || sibling?.name,
    );
    return /(?:^|\/)(?:licen[cs]e|copying|copyright)(?:\.[^/]+)?$/iu.test(
      siblingPath,
    );
  });
  const licensePath = normalizeLicenseFilePath(
    licenseSibling?.rfilename || licenseSibling?.path || licenseSibling?.name,
  );
  if (!licensePath) {
    return undefined;
  }
  const revision = payload?.sha || "main";
  const assetPath = toHuggingFaceAssetPath(assetType, repoId);
  if (!assetPath) {
    return undefined;
  }
  return `${HF_BASE_URL}/${assetPath}/resolve/${encodeURIComponent(revision)}/${encodeHuggingFacePathSegments(licensePath)}`;
};

const createExternalReference = (type, url, comment) => {
  const sanitizedUrl =
    toTrustedHuggingFaceUrl(url) || sanitizeStructuredValueForBom(url);
  if (!sanitizedUrl || typeof sanitizedUrl !== "string") {
    return undefined;
  }
  const reference = { type, url: sanitizedUrl };
  if (comment) {
    reference.comment = comment;
  }
  return reference;
};

const createGenericExternalReference = (type, candidate, comment) => {
  if (typeof candidate !== "string") {
    return undefined;
  }
  const trimmed = candidate.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    const reference = { type, url: parsed.toString() };
    if (comment) {
      reference.comment = comment;
    }
    return reference;
  } catch {
    return undefined;
  }
};

const uniqueExternalReferences = (references) => [
  ...new Map(
    references
      .filter(Boolean)
      .map((reference) => [`${reference.type}:${reference.url}`, reference]),
  ).values(),
];

const selectLicenseValue = (payload) => {
  const cardData = payload?.cardData || {};
  return (
    payload?.license ||
    cardData?.license ||
    cardData?.license_name ||
    cardData?.licenseName
  );
};

const normalizeLicenseValue = (licenseValue) => {
  if (typeof licenseValue !== "string") {
    return licenseValue;
  }
  const normalized = licenseValue.trim();
  if (!normalized) {
    return normalized;
  }
  return normalized.toUpperCase();
};

const toLicenseSpec = (payload, assetType, repoId) => {
  const type = normalizeLicenseValue(selectLicenseValue(payload));
  const url = selectLicenseFileUrl(payload, assetType, repoId);
  if (!type && !url) {
    return undefined;
  }
  return [{ type, url }];
};

const toComponentType = (assetType) => {
  switch (assetType) {
    case "dataset":
      return "data";
    case "space":
      return "application";
    default:
      return "machine-learning-model";
  }
};

const toDescription = (payload) =>
  payload?.description ||
  payload?.cardData?.model_description ||
  payload?.cardData?.summary ||
  payload?.cardData?.description;

const normalizeArray = (value) =>
  Array.isArray(value) ? value : value === undefined ? [] : [value];

const toFiniteNumber = (value) => {
  const normalizedValue =
    typeof value === "string"
      ? Number(value.replaceAll(/,/gu, ""))
      : Number(value);
  return Number.isFinite(normalizedValue) ? normalizedValue : undefined;
};

const formatCompactCount = (value) => {
  const normalizedValue = toFiniteNumber(value);
  return normalizedValue === undefined
    ? undefined
    : new Intl.NumberFormat("en-US", {
        maximumFractionDigits: normalizedValue >= 10 ? 0 : 1,
        notation: "compact",
      }).format(normalizedValue);
};

const formatByteSize = (value) => {
  const normalizedValue = toFiniteNumber(value);
  if (normalizedValue === undefined || normalizedValue < 0) {
    return undefined;
  }
  if (normalizedValue < 1024) {
    return `${normalizedValue} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let size = normalizedValue;
  let unitIndex = -1;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${Number(size.toFixed(size >= 10 ? 0 : 1))} ${units[unitIndex]}`;
};

const appendUniqueProperty = (properties, name, value) => {
  if (value === undefined || value === null || value === "") {
    return;
  }
  if (
    !properties.some(
      (property) =>
        property?.name === name && property?.value === String(value),
    )
  ) {
    properties.push({ name, value: String(value) });
  }
};

const flattenDatasetInfoEntries = (datasetInfo) => {
  if (!datasetInfo) {
    return [];
  }
  if (Array.isArray(datasetInfo)) {
    return datasetInfo;
  }
  if (typeof datasetInfo === "object") {
    return Object.values(datasetInfo);
  }
  return [];
};

const extractDatasetStats = (payload) => {
  const datasetInfoEntries = flattenDatasetInfoEntries(
    payload?.cardData?.dataset_info ||
      payload?.cardData?.datasetInfo ||
      payload?.dataset_info ||
      payload?.datasetInfo,
  );
  const splitEntries = datasetInfoEntries.flatMap((entry) =>
    flattenDatasetInfoEntries(entry?.splits),
  );
  const rowCount = [
    toFiniteNumber(payload?.cardData?.dataset_size),
    toFiniteNumber(payload?.dataset_size),
    toFiniteNumber(payload?.cardData?.num_rows),
    toFiniteNumber(payload?.num_rows),
    splitEntries.reduce(
      (sum, split) =>
        sum +
        (toFiniteNumber(split?.num_examples) ??
          toFiniteNumber(split?.num_rows) ??
          0),
      0,
    ) || undefined,
  ].find((value) => value !== undefined);
  const sizeBytes = [
    toFiniteNumber(payload?.cardData?.size_in_bytes),
    toFiniteNumber(payload?.cardData?.dataset_size),
    toFiniteNumber(payload?.size_in_bytes),
    toFiniteNumber(payload?.dataset_size),
    toFiniteNumber(payload?.cardData?.download_size),
    toFiniteNumber(payload?.download_size),
  ].find((value) => value !== undefined);
  const splitCount =
    splitEntries.length ||
    flattenDatasetInfoEntries(payload?.cardData?.splits).length ||
    undefined;
  return {
    rowCount,
    sizeBytes,
    splitCount,
  };
};

const datasetDescriptionFromStats = (payload) => {
  const descriptionParts = [toDescription(payload)];
  const datasetStats = extractDatasetStats(payload);
  const sizeParts = [
    datasetStats.rowCount !== undefined
      ? `${new Intl.NumberFormat("en-US").format(datasetStats.rowCount)} rows`
      : undefined,
    datasetStats.splitCount !== undefined
      ? `${datasetStats.splitCount} split(s)`
      : undefined,
    formatByteSize(datasetStats.sizeBytes),
  ].filter(Boolean);
  if (sizeParts.length) {
    descriptionParts.push(`Dataset size: ${sizeParts.join(", ")}`);
  }
  return descriptionParts.filter(Boolean).join(". ");
};

const extractSafetensorMetadata = (payload) => {
  const totalParameters =
    toFiniteNumber(payload?.cardData?.parameters) ||
    toFiniteNumber(payload?.config?.num_parameters) ||
    toFiniteNumber(payload?.safetensors?.total) ||
    Object.values(payload?.safetensors?.parameters || {}).reduce(
      (sum, value) => sum + (toFiniteNumber(value) || 0),
      0,
    ) ||
    undefined;
  const tensorTypes = Object.entries(payload?.safetensors?.parameters || {})
    .filter(([, value]) => toFiniteNumber(value) !== undefined)
    .sort(
      (left, right) =>
        (toFiniteNumber(right[1]) || 0) - (toFiniteNumber(left[1]) || 0),
    )
    .map(([tensorType]) => String(tensorType));
  return {
    parameterCount: totalParameters,
    parameterCountLabel: totalParameters
      ? `${formatCompactCount(totalParameters)} params`
      : undefined,
    tensorTypes: [...new Set(tensorTypes)],
  };
};

const createRemoteEvidence = (
  field,
  concludedValue,
  assetType,
  repoId,
  sourceUrl,
  revision,
) => ({
  identity: [
    {
      field,
      confidence: 0.7,
      concludedValue,
      methods: [
        {
          technique: "other",
          confidence: 0.7,
          value: `${assetType} metadata from Hugging Face API for ${repoId}${revision ? ` @ ${revision}` : ""}`,
        },
        ...(sourceUrl
          ? [
              {
                technique: "other",
                confidence: 0.7,
                value: sourceUrl,
              },
            ]
          : []),
        {
          technique: "source-code-analysis",
          confidence: 0.6,
          value: `huggingface:${assetType}:${repoId}`,
        },
      ],
    },
  ],
});

const createPedigreeModelReference = (modelRef) => {
  return createHuggingFaceComponentReference(modelRef, {
    includeDatasetPurl: false,
  });
};

const createDatasetReference = (dataset) => {
  const datasetReference = createHuggingFaceDatasetReference(dataset, {
    componentScope: "excluded",
    componentSource: "huggingface-api",
    componentTags: ["ai", "dataset", "huggingface"],
    urlSanitizer: toTrustedHuggingFaceUrl,
  });
  return datasetReference
    ? {
        component: {
          ...datasetReference.component,
          scope: "excluded",
        },
        ref: datasetReference.ref,
      }
    : undefined;
};

const createModelReference = (modelRef) => {
  const reference = createHuggingFaceComponentReference(modelRef, {
    includeDatasetPurl: false,
  });
  return reference
    ? {
        component: {
          ...reference,
          properties: [
            { name: "cdx:ai:provider", value: "huggingface" },
            { name: "cdx:ai:kind", value: "model" },
            { name: "cdx:ai:source", value: "huggingface-space-metadata" },
          ],
          tags: ["ai", "huggingface", "model"],
        },
        ref: reference["bom-ref"],
      }
    : undefined;
};

const createHuggingFaceExternalReferences = (
  payload,
  assetType,
  repoId,
  relatedSpaces = [],
) =>
  uniqueExternalReferences([
    {
      type: "distribution",
      url: toHuggingFaceAssetUrl(assetType, repoId),
    },
    createExternalReference(
      "license",
      selectLicenseFileUrl(payload, assetType, repoId),
    ),
    createGenericExternalReference(
      "citation",
      payload?.doi?.id ? `https://doi.org/${payload.doi.id}` : undefined,
    ),
    ...normalizeArray(payload?.arxivIds).map((arxivId) =>
      createGenericExternalReference(
        "citation",
        `https://arxiv.org/abs/${String(arxivId).trim()}`,
      ),
    ),
    ...relatedSpaces
      .slice(0, 5)
      .map((spaceRepoId) =>
        createGenericExternalReference(
          "website",
          toHuggingFaceAssetUrl("space", spaceRepoId),
          "Related Hugging Face Space",
        ),
      ),
  ]);

const toModelCard = (payload, addDatasetReference) => {
  const modelCard =
    createHuggingFaceModelCard(
      {
        ...(payload?.cardData || {}),
        pipeline_tag: payload?.pipeline_tag || payload?.cardData?.pipeline_tag,
      },
      payload?.config,
      addDatasetReference,
      { urlSanitizer: toTrustedHuggingFaceUrl },
    ) || {};
  const safetensorMetadata = extractSafetensorMetadata(payload);
  const modelCardProperties = [...normalizeArray(modelCard.properties)];
  appendUniqueProperty(
    modelCardProperties,
    "cdx:ai:safetensors:parameterCount",
    safetensorMetadata.parameterCount,
  );
  appendUniqueProperty(
    modelCardProperties,
    "cdx:ai:safetensors:parameterCountLabel",
    safetensorMetadata.parameterCountLabel,
  );
  for (const tensorType of safetensorMetadata.tensorTypes) {
    appendUniqueProperty(
      modelCardProperties,
      "cdx:ai:safetensors:tensorType",
      tensorType,
    );
  }
  if (modelCardProperties.length) {
    modelCard.properties = modelCardProperties;
  }
  return Object.keys(modelCard).length
    ? sanitizeStructuredValueForBom(modelCard)
    : undefined;
};

const fetchHuggingFacePayload = async (assetType, repoId, _options = {}) => {
  const normalizedRepoId = sanitizeHuggingFaceRepoId(repoId);
  if (!normalizedRepoId) {
    return undefined;
  }
  const normalizedAssetType = ["dataset", "space"].includes(assetType)
    ? assetType
    : "model";
  const revision = resolveHuggingFaceRevision(_options);
  const accessToken = resolveHuggingFaceAccessToken(_options);
  const useCache = !accessToken;
  const cacheKey = `${normalizedAssetType}:${normalizedRepoId}:${revision}`;
  if (useCache) {
    const cachedPayload = payloadCache.get(cacheKey);
    if (cachedPayload.hit) {
      return cachedPayload.value;
    }
  }
  const targetUrl = `${HF_BASE_URL}/api/${apiPathForType(normalizedAssetType, normalizedRepoId)}/revision/${encodeURIComponent(revision)}?${expandQueryForType(normalizedAssetType)}`;
  if (isDryRun) {
    recordActivity({
      kind: "network",
      networkIntent: "metadata-fetch",
      reason: "Dry run mode blocks outbound network access (metadata-fetch).",
      status: "blocked",
      target: targetUrl,
    });
    if (useCache) {
      payloadCache.set(cacheKey, undefined);
    }
    return undefined;
  }
  try {
    const response = await cdxgenAgent.get(targetUrl, {
      headers: accessToken
        ? { Authorization: `Bearer ${accessToken}` }
        : undefined,
      responseType: "json",
      timeout: HUGGING_FACE_REQUEST_TIMEOUT,
    });
    if (!response?.body) {
      if (useCache) {
        payloadCache.set(cacheKey, undefined);
      }
      return undefined;
    }
    const payload = response.body;
    if (useCache) {
      payloadCache.set(cacheKey, payload);
    }
    return payload;
  } catch {
    if (useCache) {
      payloadCache.set(cacheKey, undefined);
    }
    return undefined;
  }
};

const resolvePedigreeComponent = async (
  modelRef,
  options,
  ancestryTrail = new Set(),
) => {
  const reference = createPedigreeModelReference(modelRef);
  if (!reference?.["bom-ref"]) {
    return undefined;
  }
  if (
    reference.type !== "machine-learning-model" ||
    ancestryTrail.has(reference["bom-ref"])
  ) {
    return reference;
  }
  const nextAncestryTrail = new Set(ancestryTrail);
  nextAncestryTrail.add(reference["bom-ref"]);
  const payload = await fetchHuggingFacePayload(
    "model",
    `${reference.group}/${reference.name}`,
    {
      ...options,
      huggingFaceRevision: undefined,
      revision: undefined,
      version: undefined,
    },
  );
  if (!payload) {
    return reference;
  }
  const quantization =
    quantizationValueFromConfig(payload?.config?.quantization_config) ||
    quantizationValueFromConfig(payload?.quantization_config) ||
    payload?.cardData?.quantization;
  const pedigree = await toPedigree(
    payload,
    quantization,
    detectPayloadVariants(payload, quantization),
    options,
    nextAncestryTrail,
  );
  if (pedigree) {
    reference.pedigree = pedigree;
  }
  return reference;
};

const toPedigree = async (
  payload,
  quantization,
  variants = [],
  options = {},
  ancestryTrail = new Set(),
) => {
  const cardData = payload?.cardData || {};
  const relation = cardData.base_model_relation;
  const relatedModels = await Promise.all(
    normalizeArray(cardData.base_model)
      .concat(normalizeArray(cardData.base_models))
      .map((modelRef) =>
        resolvePedigreeComponent(modelRef, options, ancestryTrail),
      ),
  );
  const filteredRelatedModels = relatedModels.filter(Boolean);
  if (!filteredRelatedModels.length) {
    return undefined;
  }
  const pedigreeKey =
    !relation ||
    HUGGING_FACE_ANCESTOR_RELATIONS.has(String(relation).toLowerCase())
      ? "ancestors"
      : "variants";
  const pedigree = {
    [pedigreeKey]: [
      ...new Map(
        filteredRelatedModels.map((component) => [
          component["bom-ref"],
          component,
        ]),
      ).values(),
    ],
  };
  const notes = [
    relation ? `Hugging Face relation: ${relation}` : undefined,
    quantization ? `Quantization: ${quantization}` : undefined,
    variants.length ? `Detected variants: ${variants.join(", ")}` : undefined,
  ].filter(Boolean);
  if (notes.length) {
    pedigree.notes = notes.join("; ");
  }
  return pedigree;
};

const toProperties = (assetType, payload) => {
  const properties = [
    { name: "cdx:ai:provider", value: "huggingface" },
    { name: "cdx:ai:source", value: "huggingface-api" },
  ];
  if (assetType === "model") {
    properties.push({ name: "cdx:ai:kind", value: "model" });
  } else if (assetType === "dataset") {
    properties.push({ name: "cdx:ai:kind", value: "dataset" });
  } else if (assetType === "space") {
    properties.push({ name: "cdx:ai:kind", value: "space" });
  }
  const pipelineTag = payload?.pipeline_tag || payload?.cardData?.pipeline_tag;
  if (pipelineTag) {
    properties.push({ name: "cdx:ai:modality", value: String(pipelineTag) });
  }
  const parameterCount =
    payload?.cardData?.parameters || payload?.config?.num_parameters;
  if (parameterCount !== undefined && parameterCount !== null) {
    properties.push({
      name: "cdx:ai:parameterCount",
      value: String(parameterCount),
    });
  }
  const contextWindow =
    payload?.config?.max_position_embeddings ||
    payload?.cardData?.context_length;
  if (contextWindow !== undefined && contextWindow !== null) {
    properties.push({
      name: "cdx:ai:contextWindow",
      value: String(contextWindow),
    });
  }
  const quantization =
    quantizationValueFromConfig(payload?.config?.quantization_config) ||
    quantizationValueFromConfig(payload?.quantization_config) ||
    payload?.cardData?.quantization;
  if (quantization) {
    properties.push({
      name: "cdx:ai:quantization",
      value: String(quantization),
    });
  }
  appendUniqueProperty(
    properties,
    "cdx:huggingface:downloads",
    payload?.downloads,
  );
  appendUniqueProperty(
    properties,
    "cdx:huggingface:downloadsAllTime",
    payload?.downloadsAllTime,
  );
  appendUniqueProperty(properties, "cdx:huggingface:likes", payload?.likes);
  appendUniqueProperty(
    properties,
    "cdx:huggingface:likesRecent",
    payload?.likesRecent,
  );
  appendUniqueProperty(properties, "cdx:huggingface:gated", payload?.gated);
  appendUniqueProperty(properties, "cdx:huggingface:private", payload?.private);
  appendUniqueProperty(
    properties,
    "cdx:huggingface:disabled",
    payload?.disabled,
  );
  appendUniqueProperty(
    properties,
    "cdx:huggingface:createdAt",
    payload?.createdAt,
  );
  appendUniqueProperty(
    properties,
    "cdx:huggingface:lastModified",
    payload?.lastModified,
  );
  appendUniqueProperty(
    properties,
    "cdx:huggingface:fileCount",
    normalizeArray(payload?.siblings).length || undefined,
  );
  appendUniqueProperty(
    properties,
    "cdx:huggingface:gatedFieldCount",
    payload?.cardData?.extra_gated_fields
      ? Object.keys(payload.cardData.extra_gated_fields).length
      : undefined,
  );
  appendUniqueProperty(
    properties,
    "cdx:huggingface:gatedPromptCustomized",
    payload?.cardData?.extra_gated_prompt ? "true" : undefined,
  );
  if (assetType === "model") {
    appendUniqueProperty(
      properties,
      "cdx:huggingface:libraryName",
      payload?.library_name || payload?.cardData?.library_name,
    );
    appendUniqueProperty(
      properties,
      "cdx:huggingface:spaceCount",
      normalizeArray(payload?.spaces).length || undefined,
    );
    appendUniqueProperty(
      properties,
      "cdx:huggingface:inferenceProviderCount",
      normalizeArray(payload?.inferenceProviderMapping).length || undefined,
    );
    for (const mapping of normalizeArray(payload?.inferenceProviderMapping)) {
      appendUniqueProperty(
        properties,
        "cdx:huggingface:inferenceProvider",
        mapping?.provider,
      );
      appendUniqueProperty(
        properties,
        "cdx:huggingface:inferenceTask",
        mapping?.task,
      );
      appendUniqueProperty(
        properties,
        "cdx:huggingface:inferenceStatus",
        mapping?.status,
      );
    }
  } else if (assetType === "dataset") {
    appendUniqueProperty(
      properties,
      "cdx:huggingface:previewable",
      payload?.previewable,
    );
    appendUniqueProperty(
      properties,
      "cdx:huggingface:papersWithCodeId",
      payload?.paperswithcode_id || payload?.cardData?.paperswithcode_id,
    );
    appendUniqueProperty(
      properties,
      "cdx:huggingface:citationDetected",
      payload?.citation ? "true" : undefined,
    );
    appendUniqueProperty(
      properties,
      "cdx:huggingface:viewer",
      payload?.cardData?.viewer,
    );
    for (const taskCategory of normalizeArray(
      payload?.cardData?.task_categories,
    )) {
      appendUniqueProperty(
        properties,
        "cdx:huggingface:taskCategory",
        taskCategory,
      );
    }
    for (const taskId of normalizeArray(payload?.cardData?.task_ids)) {
      appendUniqueProperty(properties, "cdx:huggingface:taskId", taskId);
    }
    for (const language of normalizeArray(payload?.cardData?.language)) {
      appendUniqueProperty(properties, "cdx:huggingface:language", language);
    }
    for (const language of normalizeArray(payload?.cardData?.language_bcp47)) {
      appendUniqueProperty(
        properties,
        "cdx:huggingface:languageBcp47",
        language,
      );
    }
  } else if (assetType === "space") {
    appendUniqueProperty(properties, "cdx:huggingface:sdk", payload?.sdk);
    appendUniqueProperty(
      properties,
      "cdx:huggingface:subdomain",
      payload?.subdomain,
    );
    appendUniqueProperty(
      properties,
      "cdx:huggingface:runtimeStage",
      payload?.runtime?.stage,
    );
    appendUniqueProperty(
      properties,
      "cdx:huggingface:sdkVersion",
      payload?.runtime?.sdkVersion,
    );
    appendUniqueProperty(
      properties,
      "cdx:huggingface:runtimeHardwareCurrent",
      payload?.runtime?.hardware?.current,
    );
    appendUniqueProperty(
      properties,
      "cdx:huggingface:runtimeHardwareRequested",
      payload?.runtime?.hardware?.requested,
    );
    appendUniqueProperty(
      properties,
      "cdx:huggingface:modelCount",
      normalizeArray(payload?.models).length || undefined,
    );
    appendUniqueProperty(
      properties,
      "cdx:huggingface:datasetCount",
      normalizeArray(payload?.datasets).length || undefined,
    );
  }
  for (const variant of detectPayloadVariants(payload, quantization)) {
    properties.push({
      name: "cdx:ai:variant",
      value: String(variant),
    });
  }
  return properties;
};

const detectPayloadVariants = (payload, quantization) =>
  normalizeDetectedVariants(
    detectAiModelVariants({
      description: toDescription(payload),
      metadata: [payload?.cardData?.library_name],
      modelName: payload?.id,
      quantization,
      relation: payload?.cardData?.base_model_relation,
      tags: [
        ...normalizeArray(payload?.tags),
        ...normalizeArray(payload?.cardData?.tags),
      ],
    }),
  );

/**
 * Check whether remote Hugging Face metadata resolution is enabled.
 *
 * @param {Object} [options={}] CLI options
 * @returns {boolean} true when remote resolution is enabled
 */
export const isHuggingFaceRemoteEnabled = (options = {}) =>
  Boolean(
    options?.aiHuggingFaceRemote ||
      options?.resolveHuggingFaceRemote ||
      process.env.CDXGEN_HUGGINGFACE_REMOTE === "true",
  );

/**
 * Resolve a Hugging Face model, dataset, or space into a BOM component.
 *
 * @param {string} assetType asset type such as model or dataset
 * @param {string} repoId Hugging Face repository id
 * @param {Object} [options={}] fetch and header overrides
 * @returns {Promise<Object|undefined>} resolved BOM component
 */
export async function fetchHuggingFaceAssetInventory(
  assetType,
  repoId,
  options = {},
) {
  const normalizedRepoId = sanitizeHuggingFaceRepoId(repoId);
  if (!normalizedRepoId) {
    return undefined;
  }
  const normalizedAssetType = ["dataset", "space"].includes(assetType)
    ? assetType
    : "model";
  const revision = resolveHuggingFaceRevision(options);
  const accessToken = resolveHuggingFaceAccessToken(options);
  const useCache = !accessToken;
  const cacheKey = `${normalizedAssetType}:${normalizedRepoId}:${revision}`;
  if (useCache) {
    const cachedInventory = responseCache.get(cacheKey);
    if (cachedInventory.hit) {
      return cachedInventory.value;
    }
  }
  try {
    const payload = await fetchHuggingFacePayload(
      normalizedAssetType,
      normalizedRepoId,
      options,
    );
    if (!payload) {
      if (useCache) {
        responseCache.set(cacheKey, undefined);
      }
      return undefined;
    }
    const slashIndex = normalizedRepoId.indexOf("/");
    const quantization =
      quantizationValueFromConfig(payload?.config?.quantization_config) ||
      quantizationValueFromConfig(payload?.quantization_config) ||
      payload?.cardData?.quantization;
    const safetensorMetadata = extractSafetensorMetadata(payload);
    const purl = toHuggingFacePurl(
      normalizedRepoId,
      payload?.sha || (revision !== "HEAD" ? revision : payload?.lastModified),
      repositoryUrlForHuggingFaceAssetType(normalizedAssetType),
    );
    const variants =
      normalizedAssetType === "model"
        ? detectPayloadVariants(payload, quantization)
        : [];
    const ancestryRoot =
      purl || toHuggingFaceAssetUrl(normalizedAssetType, normalizedRepoId);
    const relatedComponents = [];
    const datasetDependencyRefs = new Set();
    const modelDependencyRefs = new Set();
    const externalReferences = createHuggingFaceExternalReferences(
      payload,
      normalizedAssetType,
      normalizedRepoId,
      normalizeArray(payload?.spaces),
    );
    const component = {
      "bom-ref": purl,
      type: toComponentType(normalizedAssetType),
      group: normalizedRepoId.slice(0, slashIndex),
      name: normalizedRepoId.slice(slashIndex + 1),
      version:
        payload?.sha ||
        (revision !== "HEAD" ? revision : payload?.lastModified),
      purl,
      description:
        normalizedAssetType === "dataset"
          ? datasetDescriptionFromStats(payload)
          : toDescription(payload),
      externalReferences,
      licenses: getLicenses({
        license: toLicenseSpec(payload, normalizedAssetType, normalizedRepoId),
      }),
      evidence: createRemoteEvidence(
        "purl",
        purl,
        normalizedAssetType,
        normalizedRepoId,
        `${HF_BASE_URL}/api/${apiPathForType(normalizedAssetType, normalizedRepoId)}/revision/${encodeURIComponent(revision)}`,
        revision,
      ),
      modelCard:
        normalizedAssetType === "model"
          ? toModelCard(payload, (dataset) => {
              const datasetReference = createDatasetReference(dataset);
              if (!datasetReference) {
                return undefined;
              }
              relatedComponents.push(datasetReference.component);
              datasetDependencyRefs.add(datasetReference.component["bom-ref"]);
              return datasetReference.ref;
            })
          : undefined,
      pedigree:
        normalizedAssetType === "model"
          ? await toPedigree(
              payload,
              quantization,
              variants,
              options,
              new Set([ancestryRoot]),
            )
          : undefined,
      data:
        normalizedAssetType === "dataset"
          ? [
              {
                type: "dataset",
                name: normalizedRepoId,
                contents: {
                  url: toHuggingFaceAssetUrl(
                    normalizedAssetType,
                    normalizedRepoId,
                  ),
                },
                description: datasetDescriptionFromStats(payload),
              },
            ]
          : undefined,
      properties: toProperties(normalizedAssetType, payload),
      tags: [
        ...new Set([
          "ai",
          "huggingface",
          normalizedAssetType,
          ...variants,
          ...normalizeArray(payload?.tags).filter(
            (tag) => typeof tag === "string",
          ),
          ...normalizeArray(payload?.cardData?.tags).filter(
            (tag) => typeof tag === "string",
          ),
        ]),
      ],
    };
    if (normalizedAssetType === "dataset") {
      component.scope = "excluded";
    }
    if (safetensorMetadata.parameterCount !== undefined) {
      component.properties.push({
        name: "cdx:ai:parameterCount",
        value: String(safetensorMetadata.parameterCount),
      });
    }
    if (normalizedAssetType === "space") {
      for (const model of normalizeArray(payload?.models)) {
        const modelReference = createModelReference(model);
        if (!modelReference) {
          continue;
        }
        relatedComponents.push(modelReference.component);
        modelDependencyRefs.add(modelReference.ref);
      }
      for (const dataset of normalizeArray(payload?.datasets)) {
        const datasetReference = createDatasetReference(dataset);
        if (!datasetReference) {
          continue;
        }
        relatedComponents.push(datasetReference.component);
        datasetDependencyRefs.add(datasetReference.component["bom-ref"]);
      }
    }
    const inventory = {
      components: [
        component,
        ...new Map(
          relatedComponents.map((entry) => [entry["bom-ref"], entry]),
        ).values(),
      ],
      dependencies: datasetDependencyRefs.size
        ? [
            {
              ref: component["bom-ref"],
              dependsOn: Array.from(
                new Set([
                  ...Array.from(datasetDependencyRefs),
                  ...Array.from(modelDependencyRefs),
                ]),
              ).sort(),
            },
          ]
        : modelDependencyRefs.size
          ? [
              {
                ref: component["bom-ref"],
                dependsOn: Array.from(modelDependencyRefs).sort(),
              },
            ]
          : [],
      primaryComponent: component,
    };
    if (useCache) {
      responseCache.set(cacheKey, inventory);
    }
    return inventory;
  } catch {
    if (useCache) {
      responseCache.set(cacheKey, undefined);
    }
    return undefined;
  }
}

/**
 * Resolve a Hugging Face asset to the primary CycloneDX component only.
 *
 * @param {string} assetType asset type such as model or dataset
 * @param {string} repoId Hugging Face repository id
 * @param {Object} [options={}] fetch and header overrides
 * @returns {Promise<Object|undefined>} primary resolved component
 */
export async function fetchHuggingFaceAssetMetadata(
  assetType,
  repoId,
  options = {},
) {
  const inventory = await fetchHuggingFaceAssetInventory(
    assetType,
    repoId,
    options,
  );
  return inventory?.primaryComponent;
}
