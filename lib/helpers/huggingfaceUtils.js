import { PackageURL } from "packageurl-js";

import {
  sanitizeBomPropertyValue,
  sanitizeBomUrl,
} from "./propertySanitizer.js";

const normalizeArray = (value) => {
  if (Array.isArray(value)) {
    return value;
  }
  if (value === undefined || value === null) {
    return [];
  }
  return [value];
};

export const HF_BASE_URL = "https://huggingface.co";
export const HUGGING_FACE_ANCESTOR_RELATIONS = new Set([
  "adapter",
  "distilled",
  "distillation",
  "finetune",
  "fine-tune",
  "fine_tune",
  "merge",
  "merged",
  "quantized",
]);

export const HUGGING_FACE_DATASET_REPOSITORY_URL = `${HF_BASE_URL}/datasets`;
export const HUGGING_FACE_SPACE_REPOSITORY_URL = `${HF_BASE_URL}/spaces`;

export function repositoryUrlForHuggingFaceAssetType(assetType) {
  if (assetType === "dataset") {
    return HUGGING_FACE_DATASET_REPOSITORY_URL;
  }
  if (assetType === "space") {
    return HUGGING_FACE_SPACE_REPOSITORY_URL;
  }
  return HF_BASE_URL;
}

export function assetTypeFromHuggingFaceRepositoryUrl(repositoryUrl) {
  const normalizedRepositoryUrl = String(repositoryUrl || "")
    .trim()
    .replace(/\/+$/u, "");
  if (!normalizedRepositoryUrl || normalizedRepositoryUrl === HF_BASE_URL) {
    return "model";
  }
  if (normalizedRepositoryUrl === HUGGING_FACE_DATASET_REPOSITORY_URL) {
    return "dataset";
  }
  if (normalizedRepositoryUrl === HUGGING_FACE_SPACE_REPOSITORY_URL) {
    return "space";
  }
  return "model";
}

/**
 * Normalize a Hugging Face repository identifier to the canonical namespace/name form.
 *
 * @param {string} repoId Hugging Face repository id candidate
 * @returns {string|undefined} normalized repository id
 */
export function sanitizeHuggingFaceRepoId(repoId) {
  const trimmed = String(repoId || "").trim();
  let start = 0;
  let end = trimmed.length;
  while (start < end && trimmed[start] === "/") {
    start += 1;
  }
  while (end > start && trimmed[end - 1] === "/") {
    end -= 1;
  }
  const normalized = trimmed.slice(start, end);
  if (!/^[^\s/]+\/[^\s/]+$/u.test(normalized)) {
    return undefined;
  }
  const segments = normalized.split("/");
  if (
    segments.some((segment) => {
      try {
        const decoded = decodeURIComponent(segment);
        return (
          !decoded ||
          decoded === "." ||
          decoded === ".." ||
          decoded.includes("/") ||
          decoded.includes("\\")
        );
      } catch {
        return true;
      }
    })
  ) {
    return undefined;
  }
  return normalized;
}

const encodePathSegment = (segment) => {
  if (segment === ".") {
    return "%2E";
  }
  if (segment === "..") {
    return "%2E%2E";
  }
  return encodeURIComponent(segment);
};

/**
 * Encode Hugging Face path segments while preserving path separators.
 *
 * @param {string} value path-like repository identifier
 * @returns {string} encoded path segments
 */
export function encodeHuggingFacePathSegments(value) {
  return String(value || "")
    .split("/")
    .filter(Boolean)
    .map((segment) => encodePathSegment(segment))
    .join("/");
}

/**
 * Convert a Hugging Face asset reference to a canonical web path.
 *
 * @param {string} assetType asset type such as model, dataset, or space
 * @param {string} repoId Hugging Face repository id
 * @returns {string|undefined} canonical path under huggingface.co
 */
export function toHuggingFaceAssetPath(assetType, repoId) {
  const normalizedRepoId = sanitizeHuggingFaceRepoId(repoId);
  if (!normalizedRepoId) {
    return undefined;
  }
  const encodedRepoId = encodeHuggingFacePathSegments(normalizedRepoId);
  switch (assetType) {
    case "dataset":
      return `datasets/${encodedRepoId}`;
    case "space":
      return `spaces/${encodedRepoId}`;
    default:
      return encodedRepoId;
  }
}

/**
 * Convert a Hugging Face asset reference to a canonical web URL.
 *
 * @param {string} assetType asset type such as model, dataset, or space
 * @param {string} repoId Hugging Face repository id
 * @returns {string|undefined} canonical URL under huggingface.co
 */
export function toHuggingFaceAssetUrl(assetType, repoId) {
  const assetPath = toHuggingFaceAssetPath(assetType, repoId);
  return assetPath ? `${HF_BASE_URL}/${assetPath}` : undefined;
}

/**
 * Convert a Hugging Face repo reference to a package URL.
 *
 * @param {string} repoId Hugging Face repository id
 * @param {string} [version] optional revision or sha
 * @param {string} [repositoryUrl] optional registry URL override
 * @returns {string|undefined} normalized Hugging Face purl
 */
export function toHuggingFacePurl(repoId, version, repositoryUrl) {
  const normalizedRepoId = sanitizeHuggingFaceRepoId(repoId);
  if (!normalizedRepoId) {
    return undefined;
  }
  const [namespace, name] = normalizedRepoId.split("/");
  let normalizedVersion;
  if (version) {
    const trimmedVersion = String(version).trim();
    try {
      normalizedVersion = decodeURIComponent(trimmedVersion).toLowerCase();
    } catch {
      normalizedVersion = trimmedVersion.toLowerCase();
    }
  }
  const sanitizedRepositoryUrl = sanitizeBomUrl(repositoryUrl);
  const normalizedRepositoryUrl = sanitizedRepositoryUrl?.replace(/\/+$/u, "");
  const qualifiers =
    normalizedRepositoryUrl && normalizedRepositoryUrl !== HF_BASE_URL
      ? { repository_url: normalizedRepositoryUrl }
      : undefined;
  let purlString = new PackageURL(
    "huggingface",
    namespace,
    name,
    normalizedVersion,
    qualifiers,
  ).toString();
  if (qualifiers?.repository_url) {
    purlString = purlString.replace(
      /([?&]repository_url=)[^&]+/u,
      `$1${encodeURIComponent(qualifiers.repository_url)}`,
    );
  }
  return purlString;
}

/**
 * Normalize a direct Hugging Face URL or purl into a repo reference.
 *
 * @param {string} value direct URL, API URL, or purl
 * @returns {{ assetType: string, repoId: string, version?: string }|undefined} normalized reference
 */
export function normalizeHuggingFaceReference(value) {
  if (!value) {
    return undefined;
  }
  const normalizedValue = String(value || "").trim();
  if (!normalizedValue) {
    return undefined;
  }
  if (normalizedValue.startsWith("pkg:huggingface/")) {
    try {
      const purl = PackageURL.fromString(normalizedValue);
      const repoId = sanitizeHuggingFaceRepoId(
        `${purl.namespace}/${purl.name}`,
      );
      if (repoId) {
        return {
          assetType: assetTypeFromHuggingFaceRepositoryUrl(
            purl.qualifiers?.repository_url,
          ),
          repoId,
          ...(purl.version ? { version: purl.version } : {}),
        };
      }
    } catch {
      // Fall through to the remaining parsers.
    }
  }
  const directTypedMatch = normalizedValue.match(
    /^(models|datasets|spaces)\/([^/\s]+\/[^/\s]+)(?:\/revision\/([^/\s?#]+))?$/u,
  );
  if (directTypedMatch) {
    return {
      assetType:
        directTypedMatch[1] === "datasets"
          ? "dataset"
          : directTypedMatch[1] === "spaces"
            ? "space"
            : "model",
      repoId: sanitizeHuggingFaceRepoId(directTypedMatch[2]),
      ...(directTypedMatch[3]
        ? { version: decodeURIComponent(directTypedMatch[3]) }
        : {}),
    };
  }
  const looksLikeFilesystemPath =
    /^(?:\/|\.{1,2}(?:\/|$)|~\/|[a-z]:[\\/])/iu.test(normalizedValue) ||
    normalizedValue.includes("\\");
  const directRepoId = looksLikeFilesystemPath
    ? undefined
    : sanitizeHuggingFaceRepoId(normalizedValue);
  if (directRepoId) {
    return { assetType: "model", repoId: directRepoId };
  }
  try {
    const parsed = new URL(normalizedValue);
    if (parsed.hostname !== "huggingface.co") {
      return undefined;
    }
    const pathSegments = parsed.pathname.split("/").filter(Boolean);
    let assetType = "model";
    if (pathSegments[0] === "api") {
      if (pathSegments[1] === "datasets") {
        assetType = "dataset";
      } else if (pathSegments[1] === "spaces") {
        assetType = "space";
      }
      pathSegments.splice(0, 2);
    } else if (pathSegments[0] === "datasets") {
      assetType = "dataset";
      pathSegments.shift();
    } else if (pathSegments[0] === "spaces") {
      assetType = "space";
      pathSegments.shift();
    } else if (pathSegments[0] === "models") {
      pathSegments.shift();
    }
    if (pathSegments.length < 2) {
      return undefined;
    }
    const repoId = sanitizeHuggingFaceRepoId(
      `${pathSegments[0]}/${pathSegments[1]}`,
    );
    if (!repoId) {
      return undefined;
    }
    let version;
    if (pathSegments[2] === "revision" && pathSegments[3]) {
      version = decodeURIComponent(pathSegments[3]);
    }
    return {
      assetType,
      repoId,
      ...(version ? { version } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Normalize a Hugging Face dataset descriptor into reusable fields.
 *
 * @param {object|string} dataset dataset reference from model-card metadata
 * @param {{ urlSanitizer?: (url: string|undefined) => string|undefined }} [options={}] dataset normalization options
 * @returns {{
 *   assetType: "dataset",
 *   bomRef: string,
 *   description?: string,
 *   group: string,
 *   name: string,
 *   repoId: string,
 *   url: string,
 * }|undefined} normalized dataset metadata
 */
export function normalizeHuggingFaceDataset(dataset, options = {}) {
  if (!dataset) {
    return undefined;
  }
  const urlSanitizer =
    typeof options.urlSanitizer === "function"
      ? options.urlSanitizer
      : sanitizeBomUrl;
  let normalized;
  let description;
  let rawUrl;
  if (typeof dataset === "string") {
    normalized = normalizeHuggingFaceReference(
      dataset.startsWith("datasets/") ? dataset : `datasets/${dataset}`,
    );
  } else {
    const datasetName =
      dataset.name || dataset.id || dataset.type || dataset.path || undefined;
    normalized = datasetName
      ? normalizeHuggingFaceReference(
          String(datasetName).includes("/")
            ? `datasets/${String(datasetName).replace(/^datasets\//u, "")}`
            : datasetName,
        )
      : undefined;
    description = [dataset.config, dataset.split].filter(Boolean).join(" / ");
    rawUrl = dataset.url;
  }
  if (!normalized?.repoId) {
    return undefined;
  }
  const [group, name] = normalized.repoId.split("/");
  const bomRef = toHuggingFacePurl(
    normalized.repoId,
    normalized.version,
    repositoryUrlForHuggingFaceAssetType("dataset"),
  );
  const sanitizedUrl = urlSanitizer(rawUrl);
  return {
    assetType: "dataset",
    bomRef,
    description: sanitizeBomPropertyValue(
      "cdx:huggingface:datasetDescription",
      description,
    ),
    group,
    name,
    purl: bomRef,
    repoId: normalized.repoId,
    url: sanitizedUrl || toHuggingFaceAssetUrl("dataset", normalized.repoId),
  };
}

/**
 * Create an inline CycloneDX dataset object from Hugging Face model-card metadata.
 *
 * @param {object|string} dataset dataset reference from model-card metadata
 * @param {{ urlSanitizer?: (url: string|undefined) => string|undefined }} [options={}] dataset normalization options
 * @returns {{ contents?: { url: string }, description?: string, name: string, type: string }|undefined} inline dataset object
 */
export function createInlineHuggingFaceDataset(dataset, options = {}) {
  if (!dataset) {
    return undefined;
  }
  if (typeof dataset === "string") {
    const normalized = normalizeHuggingFaceDataset(dataset, options);
    return normalized
      ? {
          type: "dataset",
          name: normalized.repoId,
          contents: normalized.url ? { url: normalized.url } : undefined,
        }
      : { type: "dataset", name: dataset };
  }
  const normalized = normalizeHuggingFaceDataset(dataset, options);
  const datasetName =
    dataset.name || dataset.id || dataset.type || dataset.path || undefined;
  return {
    type: "dataset",
    name: normalized?.repoId || datasetName,
    contents: normalized?.url ? { url: normalized.url } : undefined,
    description: normalized?.description,
  };
}

/**
 * Convert Hugging Face model-index entries into CycloneDX performance metrics.
 *
 * @param {Array<object>} [modelIndex=[]] model-index entries from model-card metadata
 * @returns {Array<{ slice?: string, type: string, value: string }>} CycloneDX performance metrics
 */
export function createPerformanceMetrics(modelIndex = []) {
  const metrics = [];
  for (const entry of normalizeArray(modelIndex)) {
    for (const result of normalizeArray(entry?.results)) {
      for (const metric of normalizeArray(result?.metrics)) {
        if (!metric?.type && !metric?.name) {
          continue;
        }
        metrics.push({
          type: metric.type || metric.name,
          value:
            metric.value === undefined || metric.value === null
              ? ""
              : String(metric.value),
          slice:
            [result?.dataset?.name, result?.dataset?.split]
              .filter(Boolean)
              .join(" / ") || undefined,
        });
      }
    }
  }
  return metrics.filter((metric) => metric.value);
}

/**
 * Derive a human-readable quantization label from a Hugging Face quantization config.
 *
 * @param {object|string} quantizationConfig Hugging Face quantization configuration
 * @returns {string|undefined} normalized quantization label
 */
export function quantizationValueFromConfig(quantizationConfig) {
  if (!quantizationConfig) {
    return undefined;
  }
  if (typeof quantizationConfig === "string") {
    return quantizationConfig;
  }
  const bits =
    quantizationConfig.bits ||
    (quantizationConfig.load_in_4bit ? 4 : undefined) ||
    (quantizationConfig.load_in_8bit ? 8 : undefined);
  const values = [
    quantizationConfig.quant_method,
    quantizationConfig.quantization_method,
    quantizationConfig.quant_type,
    bits ? `${bits}-bit` : undefined,
  ].filter(Boolean);
  return values.length ? values.join(" ") : undefined;
}
