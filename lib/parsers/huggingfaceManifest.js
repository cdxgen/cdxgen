import { basename, dirname } from "node:path";

import YAML from "yaml";

import {
  createInlineHuggingFaceDataset,
  createPerformanceMetrics,
  HUGGING_FACE_ANCESTOR_RELATIONS,
  normalizeHuggingFaceDataset,
  normalizeHuggingFaceReference,
  repositoryUrlForHuggingFaceAssetType,
  toHuggingFacePurl,
} from "../helpers/huggingfaceUtils.js";
import {
  sanitizeBomPropertyValue,
  sanitizeBomUrl,
  sanitizeStructuredValueForBom,
} from "../helpers/propertySanitizer.js";

export const HUGGING_FACE_MODEL_CARD_PATTERNS = ["README.md", "**/README.md"];
export const HUGGING_FACE_CONFIG_PATTERNS = ["config.json", "**/config.json"];
export const HUGGING_FACE_ADAPTER_PATTERNS = [
  "adapter_config.json",
  "**/adapter_config.json",
];

const HUGGING_FACE_CARD_KEYS = new Set([
  "base_model",
  "base_model_relation",
  "co2_eq_emissions",
  "datasets",
  "eval_results",
  "finetuned_from",
  "language",
  "language_bcp47",
  "library_name",
  "license",
  "model-index",
  "model_index",
  "models",
  "pipeline_tag",
  "sdk",
  "task_categories",
  "task_ids",
  "tags",
  "widget",
]);

const normalizeArray = (value) =>
  Array.isArray(value) ? value : value === undefined ? [] : [value];

const dedupeStrings = (values) => [
  ...new Set(values.map((value) => String(value || "").trim()).filter(Boolean)),
];

const appendUniqueProperty = (properties, name, value) => {
  const sanitizedValue = sanitizeBomPropertyValue(name, value);
  if (
    sanitizedValue === undefined ||
    sanitizedValue === null ||
    sanitizedValue === ""
  ) {
    return;
  }
  const normalizedValue = String(sanitizedValue);
  if (
    properties.some(
      (property) =>
        property?.name === name && property?.value === normalizedValue,
    )
  ) {
    return;
  }
  properties.push({ name, value: normalizedValue });
};

const huggingFaceModelTask = (cardData = {}) =>
  cardData.pipeline_tag ||
  normalizeArray(cardData["model-index"] || cardData.model_index)
    .flatMap((entry) => normalizeArray(entry?.results))
    .find((entry) => entry?.task?.type)?.task?.type;

const HUGGING_FACE_TASK_IO_FORMATS = {
  "automatic-speech-recognition": { input: "audio", output: "text" },
  conversational: { input: "text", output: "text" },
  "feature-extraction": { input: "text", output: "vector" },
  "fill-mask": { input: "text", output: "text" },
  "image-classification": { input: "image", output: "text" },
  "image-segmentation": { input: "image", output: "image" },
  "image-text-to-text": { input: "image", output: "text" },
  "image-to-image": { input: "image", output: "image" },
  "image-to-text": { input: "image", output: "text" },
  "question-answering": { input: "text", output: "text" },
  summarization: { input: "text", output: "text" },
  translation: { input: "text", output: "text" },
  "text-generation": { input: "text", output: "text" },
  "text-to-audio": { input: "text", output: "audio" },
  "text-to-image": { input: "text", output: "image" },
  "text2text-generation": { input: "text", output: "text" },
  "token-classification": { input: "text", output: "text" },
};

const inferModelIoParameters = (cardData, task) => {
  cardData = cardData || {};
  const widgetExamples = normalizeArray(cardData.widget);
  const mappedFormats = task
    ? HUGGING_FACE_TASK_IO_FORMATS[String(task).toLowerCase()]
    : undefined;
  if (mappedFormats) {
    return mappedFormats;
  }
  for (const widget of widgetExamples) {
    if (widget?.messages?.length || widget?.text || widget?.sentences?.length) {
      return { input: "text", output: "text" };
    }
    if (widget?.src) {
      return {
        input: "image",
        output: widget?.output?.text ? "text" : "image",
      };
    }
    if (widget?.table || widget?.structured_data) {
      return { input: "structured-data", output: "text" };
    }
  }
  return {};
};

const createModelCardProperties = (cardData = {}) => {
  const properties = [];
  for (const language of dedupeStrings(normalizeArray(cardData.language))) {
    appendUniqueProperty(properties, "cdx:huggingface:language", language);
  }
  for (const language of dedupeStrings(cardData.language_bcp47 || [])) {
    appendUniqueProperty(properties, "cdx:huggingface:languageBcp47", language);
  }
  appendUniqueProperty(
    properties,
    "cdx:huggingface:maskToken",
    cardData.mask_token,
  );
  appendUniqueProperty(
    properties,
    "cdx:huggingface:widgetExampleCount",
    normalizeArray(cardData.widget).length || undefined,
  );
  appendUniqueProperty(
    properties,
    "cdx:huggingface:gatedFieldCount",
    cardData.extra_gated_fields
      ? Object.keys(cardData.extra_gated_fields).length
      : undefined,
  );
  appendUniqueProperty(
    properties,
    "cdx:huggingface:gatedPromptCustomized",
    cardData.extra_gated_prompt ? "true" : undefined,
  );
  return properties;
};

const createEnvironmentalConsiderations = (cardData = {}) => {
  const emissions = cardData.co2_eq_emissions;
  if (emissions === undefined || emissions === null) {
    return undefined;
  }
  const properties = [];
  if (typeof emissions === "number") {
    appendUniqueProperty(
      properties,
      "cdx:huggingface:co2EmissionsGrams",
      emissions,
    );
  } else {
    appendUniqueProperty(
      properties,
      "cdx:huggingface:co2EmissionsGrams",
      emissions.emissions,
    );
    appendUniqueProperty(
      properties,
      "cdx:huggingface:co2Source",
      emissions.source,
    );
    appendUniqueProperty(
      properties,
      "cdx:huggingface:co2TrainingType",
      emissions.training_type,
    );
    appendUniqueProperty(
      properties,
      "cdx:huggingface:co2Geo",
      emissions.geographical_location,
    );
    appendUniqueProperty(
      properties,
      "cdx:huggingface:co2HardwareUsed",
      emissions.hardware_used,
    );
  }
  return properties.length ? { properties } : undefined;
};

const toDatasetComponentData = (normalizedDataset) => ({
  type: "dataset",
  name: normalizedDataset.repoId,
  contents: normalizedDataset.url ? { url: normalizedDataset.url } : undefined,
  description: normalizedDataset.description,
});

/**
 * Parse YAML frontmatter from a local Hugging Face README/model card.
 *
 * @param {string} raw README contents
 * @returns {object|undefined} parsed frontmatter object
 */
export function parseHuggingFaceReadmeFrontmatter(raw) {
  const match = String(raw || "").match(
    /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u,
  );
  if (!match?.[1]) {
    return undefined;
  }
  try {
    return YAML.parse(match[1], { strict: true, uniqueKeys: true });
  } catch {
    return undefined;
  }
}

/**
 * Check whether parsed README frontmatter looks like a Hugging Face model card.
 *
 * @param {object|undefined} cardData parsed frontmatter
 * @returns {boolean} true when Hugging Face model-card keys are present
 */
export function hasHuggingFaceCardSignals(cardData) {
  return Boolean(
    cardData &&
      Object.keys(cardData).some((key) => HUGGING_FACE_CARD_KEYS.has(key)),
  );
}

/**
 * Infer a Hugging Face repo id from a fixture directory name such as namespace--name.
 *
 * @param {string} filePath manifest file path inside the repository fixture
 * @returns {string|undefined} inferred namespace/name repository id
 */
export function repoIdFromFixtureDirectory(filePath) {
  const directoryName = basename(dirname(filePath));
  if (/^[^/]+--[^/]+$/u.test(directoryName)) {
    return directoryName.replace("--", "/");
  }
  if (/^[^/]+__[^/]+$/u.test(directoryName)) {
    return directoryName.replace("__", "/");
  }
  return undefined;
}

/**
 * Create a CycloneDX component reference for a related Hugging Face asset.
 *
 * @param {string} modelRef model, dataset, or space reference
 * @param {{ includeDatasetPurl?: boolean }} [options={}] pedigree reference options
 * @returns {{ "bom-ref": string, group: string, name: string, purl?: string, type: string }|undefined} component reference
 */
export function createHuggingFaceComponentReference(modelRef, _options = {}) {
  const reference = normalizeHuggingFaceReference(modelRef);
  if (!reference?.repoId) {
    return undefined;
  }
  const [group, name] = reference.repoId.split("/");
  const purl = toHuggingFacePurl(
    reference.repoId,
    reference.version,
    repositoryUrlForHuggingFaceAssetType(reference.assetType),
  );
  return {
    "bom-ref": purl,
    type:
      reference.assetType === "dataset"
        ? "data"
        : reference.assetType === "space"
          ? "application"
          : "machine-learning-model",
    group,
    name,
    purl,
  };
}

/**
 * Create a reusable dataset reference and optional component for Hugging Face model-card datasets.
 *
 * @param {object|string} dataset dataset reference from model-card metadata
 * @param {{
 *   componentProperties?: Array<{ name: string, value: string }>,
 *   componentScope?: string,
 *   componentSource?: string,
 *   componentTags?: string[],
 *   urlSanitizer?: (url: string|undefined) => string|undefined,
 * }} [options={}] dataset normalization and component options
 * @returns {{
 *   assetType: "dataset",
 *   bomRef: string,
 *   component: {
 *     "bom-ref": string,
 *     data: Array<object>,
 *     description?: string,
 *     externalReferences?: Array<object>,
 *     group: string,
 *     name: string,
 *     properties?: Array<object>,
 *     purl?: string,
 *     scope?: string,
 *     tags?: string[],
 *     type: "data",
 *   },
 *   description?: string,
 *   externalReferences?: Array<object>,
 *   group: string,
 *   modelId: string,
 *   name: string,
 *   provider: "huggingface",
 *   purl?: string,
 *   ref: { ref: string },
 * }|undefined} dataset reference and component metadata
 */
export function createHuggingFaceDatasetReference(dataset, options = {}) {
  const normalizedDataset = normalizeHuggingFaceDataset(dataset, {
    urlSanitizer:
      typeof options.urlSanitizer === "function"
        ? options.urlSanitizer
        : sanitizeBomUrl,
  });
  if (!normalizedDataset) {
    return undefined;
  }
  const externalReferences = normalizedDataset.url
    ? [{ type: "distribution", url: normalizedDataset.url }]
    : undefined;
  const purl = toHuggingFacePurl(
    normalizedDataset.repoId,
    undefined,
    repositoryUrlForHuggingFaceAssetType("dataset"),
  );
  const component = {
    "bom-ref": purl,
    type: "data",
    group: normalizedDataset.group,
    name: normalizedDataset.name,
    purl,
    scope: options.componentScope,
    description: normalizedDataset.description,
    externalReferences,
    data: [toDatasetComponentData(normalizedDataset)],
    properties: options.componentProperties,
    tags: options.componentTags,
  };
  if (options.componentSource && !component.properties?.length) {
    component.properties = [
      { name: "cdx:ai:provider", value: "huggingface" },
      { name: "cdx:ai:kind", value: "dataset" },
      { name: "cdx:ai:source", value: options.componentSource },
    ];
  }
  return {
    assetType: "dataset",
    bomRef: normalizedDataset.bomRef,
    component,
    description: normalizedDataset.description,
    externalReferences,
    group: normalizedDataset.group,
    modelId: normalizedDataset.repoId,
    name: normalizedDataset.name,
    provider: "huggingface",
    purl,
    ref: { ref: purl },
  };
}

/**
 * Create a CycloneDX model card from local or remote Hugging Face manifest data.
 *
 * @param {object} [cardData={}] parsed model-card frontmatter
 * @param {object} [config={}] parsed config.json data
 * @param {(dataset: object|string) => object|undefined} [addDatasetReference] optional dataset reference mapper
 * @param {{ urlSanitizer?: (url: string|undefined) => string|undefined }} [options={}] dataset normalization options
 * @returns {object|undefined} sanitized CycloneDX model card
 */
export function createHuggingFaceModelCard(
  cardData = {},
  config = {},
  addDatasetReference = undefined,
  options = {},
) {
  const inlineDatasetFactory = (dataset) =>
    createInlineHuggingFaceDataset(dataset, {
      urlSanitizer:
        typeof options.urlSanitizer === "function"
          ? options.urlSanitizer
          : sanitizeBomUrl,
    });
  const task = huggingFaceModelTask(cardData);
  const datasets = [
    ...normalizeArray(cardData.datasets),
    ...normalizeArray(cardData.eval_results).map((result) => result?.dataset),
    ...normalizeArray(cardData["model-index"]).flatMap((entry) =>
      normalizeArray(entry?.results).map((result) => result?.dataset),
    ),
  ]
    .map((dataset) => {
      if (typeof addDatasetReference !== "function") {
        return inlineDatasetFactory(dataset);
      }
      return addDatasetReference(dataset) || inlineDatasetFactory(dataset);
    })
    .filter((dataset) => dataset?.name || dataset?.ref);
  const performanceMetrics = createPerformanceMetrics(
    cardData["model-index"] || cardData.model_index,
  );
  const ioParameters = inferModelIoParameters(cardData, task);
  const useCases = dedupeStrings([
    task,
    ...normalizeArray(cardData.tags).filter((tag) =>
      /chat|classification|embedding|generation|question|retrieval|summarization|translation/iu.test(
        String(tag),
      ),
    ),
  ]);
  const modelCardProperties = createModelCardProperties(cardData);
  const environmentalConsiderations =
    createEnvironmentalConsiderations(cardData);
  const modelCard = {};
  const modelParameters = {
    task,
    architectureFamily: config.model_type || cardData.library_name,
    modelArchitecture: normalizeArray(config.architectures)[0],
  };
  if (datasets.length) {
    modelParameters.datasets = [
      ...new Map(
        datasets.map((dataset) => [dataset.ref?.ref || dataset.name, dataset]),
      ).values(),
    ];
  }
  if (ioParameters.input) {
    modelParameters.inputs = [{ format: ioParameters.input }];
  }
  if (ioParameters.output) {
    modelParameters.outputs = [{ format: ioParameters.output }];
  }
  if (Object.values(modelParameters).some(Boolean)) {
    modelCard.modelParameters = modelParameters;
  }
  if (performanceMetrics.length) {
    modelCard.quantitativeAnalysis = { performanceMetrics };
  }
  if (useCases.length || environmentalConsiderations) {
    modelCard.considerations = {};
    if (useCases.length) {
      modelCard.considerations.useCases = useCases;
    }
    if (environmentalConsiderations) {
      modelCard.considerations.environmentalConsiderations =
        environmentalConsiderations;
    }
  }
  if (modelCardProperties.length) {
    modelCard.properties = modelCardProperties;
  }
  return Object.keys(modelCard).length
    ? sanitizeStructuredValueForBom(modelCard)
    : undefined;
}

/**
 * Create pedigree lineage from Hugging Face model-card and adapter manifest metadata.
 *
 * @param {object} [cardData={}] parsed README frontmatter
 * @param {object} [adapterConfig={}] parsed adapter config
 * @param {string|undefined} quantization detected quantization label
 * @param {{
 *   createPedigreeModelReference?: (modelRef: string) => object|undefined,
 * }} [options={}] pedigree reference options
 * @returns {object|undefined} CycloneDX pedigree object
 */
export function createHuggingFacePedigree(
  cardData,
  adapterConfig,
  quantization,
  options = {},
) {
  cardData = cardData || {};
  adapterConfig = adapterConfig || {};
  const relation =
    cardData.base_model_relation ||
    adapterConfig.base_model_relation ||
    (adapterConfig.base_model_name_or_path ? "adapter" : undefined);
  const createPedigreeModelReference =
    typeof options.createPedigreeModelReference === "function"
      ? options.createPedigreeModelReference
      : createHuggingFaceComponentReference;
  const relatedModels = [
    ...normalizeArray(cardData.base_model),
    ...normalizeArray(cardData.base_models),
    ...normalizeArray(cardData.finetuned_from),
    ...normalizeArray(adapterConfig.base_model_name_or_path),
  ]
    .map((modelRef) => createPedigreeModelReference(modelRef))
    .filter(Boolean);
  if (!relatedModels.length) {
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
        relatedModels.map((component) => [component["bom-ref"], component]),
      ).values(),
    ],
  };
  const notes = [
    relation ? `Hugging Face relation: ${relation}` : undefined,
    quantization ? `Quantization: ${quantization}` : undefined,
  ].filter(Boolean);
  if (notes.length) {
    pedigree.notes = notes.join("; ");
  }
  return pedigree;
}
