import { readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, relative } from "node:path";

import {
  ggufFileTypeName,
  parseGgufFilename,
  readGgufMetadata,
} from "../parsers/gguf.js";
import {
  createHuggingFaceDatasetReference,
  createHuggingFaceModelCard,
  createHuggingFacePedigree,
  HUGGING_FACE_ADAPTER_PATTERNS,
  HUGGING_FACE_CONFIG_PATTERNS,
  HUGGING_FACE_MODEL_CARD_PATTERNS,
  hasHuggingFaceCardSignals,
  parseHuggingFaceReadmeFrontmatter,
  repoIdFromFixtureDirectory,
} from "../parsers/huggingfaceManifest.js";
import { parseOllamaModelfile } from "../parsers/ollama.js";
import {
  detectAiModelVariants,
  normalizeDetectedVariants,
} from "./aiModelVariants.js";
import {
  normalizeHuggingFaceReference,
  quantizationValueFromConfig,
  repositoryUrlForHuggingFaceAssetType,
  toHuggingFaceAssetUrl,
  toHuggingFacePurl,
} from "./huggingfaceUtils.js";
import {
  sanitizeBomPropertyValue,
  sanitizeBomUrl,
  sanitizeStructuredValueForBom,
} from "./propertySanitizer.js";
import { getAllFiles, getLicenses } from "./utils.js";

// -----------------------------------------------------------------------------
// Section: source patterns, provider fingerprints, and low-level constants
// -----------------------------------------------------------------------------

const JS_SOURCE_PATTERNS = ["**/*.{js,jsx,cjs,mjs,ts,tsx,mts,cts,vue,svelte}"];
const PYTHON_SOURCE_PATTERNS = ["**/*.{py,pyw}"];
const NOTEBOOK_SOURCE_PATTERNS = ["**/*.ipynb"];
const SHELL_WRAPPER_PATTERNS = ["**/*.{sh,bash,zsh,command}"];
const PROMPT_CONFIG_PATTERNS = [
  "**/*.{prompt,prompt.txt,prompt.md}",
  "**/{prompt,prompts,agents,ai,assistant,instructions}/**/*.{md,txt,json,jsonc,yaml,yml,toml}",
  "**/*{prompt,prompts,instruction,instructions,assistant,system,persona,agent,model}*.{md,txt,json,jsonc,yaml,yml,toml}",
];
const MODEFILE_PATTERNS = ["Modelfile", "**/Modelfile", "**/Modelfile.*"];
const GGUF_PATTERNS = ["**/*.gguf"];
const IGNORE_SOURCE_FILE_PATTERN =
  /(^|\/|\\)(__tests__|fixtures?|examples?|samples?)($|\/|\\)|(^|\/|\\)(test|spec|mock|setup-jest|conftest|sitecustomize)\.(js|ts|tsx|py)$|(?<!vite\.|vue\.)(conf|config)\.(js|ts|tsx)$/iu;
const HOST_PROVIDER_PATTERNS = [
  ["openai", /(?:^|\.)openai\.com$/iu],
  ["anthropic", /(?:^|\.)anthropic\.com$/iu],
  ["google", /(?:^|\.)googleapis\.com$/iu],
  ["google", /(?:^|\.)generativelanguage\.googleapis\.com$/iu],
  ["azure-openai", /(?:^|\.)openai\.azure\.com$/iu],
  ["huggingface", /(?:^|\.)huggingface\.co$/iu],
  ["mistral", /(?:^|\.)mistral\.ai$/iu],
  ["cohere", /(?:^|\.)cohere\.ai$/iu],
  ["deepseek", /(?:^|\.)deepseek\.com$/iu],
  ["groq", /(?:^|\.)groq\.com$/iu],
  ["fireworks", /(?:^|\.)fireworks\.ai$/iu],
  ["together", /(?:^|\.)together\.xyz$/iu],
  ["replicate", /(?:^|\.)replicate\.com$/iu],
  ["perplexity", /(?:^|\.)perplexity\.ai$/iu],
  ["vertex-ai", /(?:^|\.)aiplatform\.googleapis\.com$/iu],
  ["ollama", /(?:^|\.)ollama\.com$/iu],
  ["ollama", /(?:^|\.)localhost$/iu],
  ["ollama", /(?:^|\.)127\.0\.0\.1$/iu],
];
const AI_PACKAGE_REGISTRY = [
  { pattern: /^openai$/u, provider: "openai", serviceName: "OpenAI API" },
  {
    pattern: /^@anthropic-ai\/sdk$/u,
    provider: "anthropic",
    serviceName: "Anthropic API",
  },
  {
    pattern: /^@google\/genai$/u,
    provider: "google",
    serviceName: "Google Generative AI API",
  },
  {
    pattern: /^@google-ai\/generativelanguage$/u,
    provider: "google",
    serviceName: "Google Generative AI API",
  },
  {
    pattern: /^@azure\/openai$/u,
    provider: "azure-openai",
    serviceName: "Azure OpenAI API",
  },
  {
    pattern: /^@huggingface\/inference$/u,
    provider: "huggingface",
    serviceName: "Hugging Face Inference API",
  },
  {
    pattern: /^@huggingface\/transformers$/u,
    provider: "huggingface",
    runtime: "transformers.js",
  },
  { pattern: /^langchain$/u, framework: "langchain" },
  { pattern: /^@langchain\//u, framework: "langchain" },
  { pattern: /^langgraph$/u, framework: "langgraph" },
  { pattern: /^@langchain\/langgraph$/u, framework: "langgraph" },
  { pattern: /^ai$/u, framework: "vercel-ai-sdk" },
  { pattern: /^@ai-sdk\//u, framework: "vercel-ai-sdk" },
  {
    pattern: /^@openai\/agents(?:-core)?$/u,
    framework: "openai-agents",
    provider: "openai",
    serviceName: "OpenAI API",
  },
  { pattern: /^mastra$/u, framework: "mastra" },
  { pattern: /^ollama$/u, provider: "ollama", runtime: "ollama" },
  { pattern: /^node-llama-cpp$/u, runtime: "llama.cpp" },
  { pattern: /^@mlc-ai\//u, runtime: "mlc" },
  { pattern: /^groq-sdk$|^groq$/u, provider: "groq", serviceName: "Groq API" },
  {
    pattern: /^cohere-ai$/u,
    provider: "cohere",
    serviceName: "Cohere API",
  },
  {
    pattern: /^@mistralai\/mistralai$/u,
    provider: "mistral",
    serviceName: "Mistral API",
  },
  {
    pattern: /^@deepseek\/openai$/u,
    provider: "deepseek",
    serviceName: "DeepSeek API",
  },
  {
    pattern: /^google-generativeai$|^google-genai$/u,
    provider: "google",
    serviceName: "Google Generative AI API",
  },
  {
    pattern: /^anthropic$/u,
    provider: "anthropic",
    serviceName: "Anthropic API",
  },
  {
    pattern: /^transformers$|^sentence-transformers$/u,
    runtime: "transformers",
  },
  { pattern: /^langchain_/u, framework: "langchain" },
  { pattern: /^llama-index(?:-|$)/u, framework: "llama-index" },
  { pattern: /^litellm$/u, framework: "litellm" },
  { pattern: /^autogen(?:-agentchat)?$/u, framework: "autogen" },
  { pattern: /^vllm$/u, runtime: "vllm" },
  {
    pattern: /^together$|^together-ai$/u,
    provider: "together",
    serviceName: "Together API",
  },
  {
    pattern: /^fireworks-ai$/u,
    provider: "fireworks",
    serviceName: "Fireworks AI API",
  },
  {
    pattern: /^replicate$/u,
    provider: "replicate",
    serviceName: "Replicate API",
  },
  {
    pattern: /^perplexity(?:ai)?$/u,
    provider: "perplexity",
    serviceName: "Perplexity API",
  },
];
const serializeAiService = (service) => ({
  "bom-ref": service["bom-ref"],
  group: service.group,
  name: service.name,
  provider: service.provider,
  version: service.version,
  endpoints: Array.from(service.endpoints)
    .map((endpoint) => sanitizeBomUrl(endpoint))
    .filter(Boolean)
    .sort(),
  properties: service.properties,
  tags: Array.from(service.tags).sort(),
  evidence: service.occurrences.length
    ? { occurrences: service.occurrences }
    : undefined,
});
const TEXT_AI_INVENTORY_CONFIGS = {
  javascript: { patterns: JS_SOURCE_PATTERNS },
  notebook: {
    fileKind: "notebook-file",
    patterns: NOTEBOOK_SOURCE_PATTERNS,
    tags: ["notebook"],
  },
  promptConfig: {
    fileKind: "prompt-config-file",
    patterns: [...SHELL_WRAPPER_PATTERNS, ...PROMPT_CONFIG_PATTERNS],
    tags: ["prompt-config"],
  },
  python: { patterns: PYTHON_SOURCE_PATTERNS },
};

// -----------------------------------------------------------------------------
// Section: generic component, service, and text-scanning helpers
// -----------------------------------------------------------------------------

const addUniqueProperty = (properties, name, value) => {
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

const linePrefixForIndex = (raw, index) => {
  const lineStart = raw.lastIndexOf("\n", index - 1) + 1;
  return raw.slice(lineStart, index).trim();
};

const extractImportNames = (raw) => {
  const imports = [];
  for (const match of raw.matchAll(
    /(?:import\s+(?:.+?\s+from\s+)?|require\(\s*)["'`]([^"'`]+)["'`]/gu,
  )) {
    if (linePrefixForIndex(raw, match.index) !== "") {
      continue;
    }
    imports.push({ index: match.index, names: [match[1]] });
  }
  for (const match of raw.matchAll(
    /from\s+([A-Za-z0-9_.-]+)\s+import\b|import\s+([A-Za-z0-9_.,\s-]+)/gu,
  )) {
    if (linePrefixForIndex(raw, match.index) !== "") {
      continue;
    }
    const modules = match[1]
      ? [match[1]]
      : String(match[2] || "")
          .split(",")
          .map((entry) => entry.trim().split(/\s+as\s+/u)[0])
          .filter(Boolean);
    if (modules.length) {
      imports.push({ index: match.index, names: modules });
    }
  }
  return imports;
};

const createFileSignals = () => ({
  fileRef: undefined,
  frameworks: new Set(),
  modelRefs: new Set(),
  providers: new Set(),
  runtimes: new Set(),
  serviceRefs: new Set(),
});

const relativeOccurrenceLocation = (discoveryPath, filePath, lineNumber) => {
  const relativePath = relative(discoveryPath, filePath) || basename(filePath);
  return lineNumber ? `${relativePath}#L${lineNumber}` : relativePath;
};

const appendOccurrence = (target, location) => {
  target.occurrences = target.occurrences || [];
  if (!target.occurrences.some((entry) => entry.location === location)) {
    target.occurrences.push({ location });
  }
};

const mergePedigreeVariants = (pedigree, variants = []) => {
  const normalizedVariants = normalizeDetectedVariants(variants);
  if (!pedigree && !normalizedVariants.length) {
    return pedigree;
  }
  const nextPedigree = pedigree ? { ...pedigree } : {};
  const notes = [];
  if (nextPedigree.notes) {
    notes.push(String(nextPedigree.notes));
  }
  if (normalizedVariants.length) {
    notes.push(`Detected variants: ${normalizedVariants.join(", ")}`);
  }
  if (notes.length) {
    nextPedigree.notes = [...new Set(notes)].join("; ");
  }
  return Object.keys(nextPedigree).length ? nextPedigree : undefined;
};

const lineNumberForIndex = (text, index) =>
  text.slice(0, index).split("\n").length;

const isLocalAiHostname = (hostname) => {
  const normalized = String(hostname || "").toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized.endsWith(".localhost")
  );
};

const hostProviderFromValue = (urlValue) => {
  try {
    const parsed = new URL(urlValue);
    return (
      HOST_PROVIDER_PATTERNS.find(([, pattern]) =>
        pattern.test(parsed.hostname),
      )?.[0] || undefined
    );
  } catch {
    return undefined;
  }
};

const modelFamilyFromName = (modelName) => {
  const normalized = String(modelName || "").toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized.includes("claude")) {
    return "claude";
  }
  if (normalized.includes("gpt") || /^o[13](?:$|[-:])/u.test(normalized)) {
    return "gpt";
  }
  if (normalized.includes("gemini")) {
    return "gemini";
  }
  if (normalized.includes("llama")) {
    return "llama";
  }
  if (normalized.includes("mistral")) {
    return "mistral";
  }
  if (normalized.includes("command")) {
    return "command";
  }
  if (normalized.includes("deepseek")) {
    return "deepseek";
  }
  if (normalized.includes("qwen")) {
    return "qwen";
  }
  return normalized.split(/[/:,\-]/u)[0] || undefined;
};

const providerFromModelName = (modelName) => {
  const normalized = String(modelName || "").toLowerCase();
  if (normalized.includes("claude")) {
    return "anthropic";
  }
  if (normalized.includes("gpt") || /^o[13](?:$|[-:])/u.test(normalized)) {
    return "openai";
  }
  if (normalized.includes("gemini")) {
    return "google";
  }
  if (normalized.includes("mistral")) {
    return "mistral";
  }
  if (normalized.includes("deepseek")) {
    return "deepseek";
  }
  if (normalized.includes("llama")) {
    return "meta";
  }
  return undefined;
};

const parseJsonObject = (filePath) => {
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return undefined;
  }
};

const stableAiBomRef = (assetType, provider, identifier) =>
  `cdxgen:ai:${assetType}:${provider}:${String(identifier || "").replaceAll(/[^a-zA-Z0-9._:-]+/gu, "-")}`;

// -----------------------------------------------------------------------------
// Section: Hugging Face pedigree, dataset, and model-card helpers
// -----------------------------------------------------------------------------

const providerEntityForName = (providerName) =>
  providerName ? { name: String(providerName) } : undefined;

const legacyQuantizationValueFromFilename = (fileName) => {
  const normalizedFileName = String(fileName || "").trim();
  if (!normalizedFileName.toLowerCase().endsWith(".gguf")) {
    return undefined;
  }
  const segments = basename(normalizedFileName, ".gguf").split(".");
  return segments.length > 1 ? segments.at(-1) : undefined;
};

const quantizationValueFromFilename = (fileName) => {
  const parsedFileName = parseGgufFilename(fileName);
  if (parsedFileName?.encoding) {
    return parsedFileName.encoding;
  }
  return legacyQuantizationValueFromFilename(fileName);
};

const createExternalReference = (type, url, comment) => {
  const sanitizedUrl = sanitizeBomUrl(url);
  if (!sanitizedUrl) {
    return undefined;
  }
  const externalReference = {
    type,
    url: sanitizedUrl,
  };
  if (comment) {
    externalReference.comment = comment;
  }
  return externalReference;
};

const uniqueExternalReferences = (references) => [
  ...new Map(
    references.filter(Boolean).map((ref) => [`${ref.type}:${ref.url}`, ref]),
  ).values(),
];

const createGgufExternalReferences = (metadata = {}) =>
  uniqueExternalReferences([
    createExternalReference("website", metadata["general.url"]),
    createExternalReference("vcs", metadata["general.repo_url"]),
    createExternalReference(
      "website",
      metadata["general.source.url"],
      "GGUF source metadata",
    ),
    createExternalReference(
      "vcs",
      metadata["general.source.repo_url"],
      "GGUF source repository",
    ),
    createExternalReference("license", metadata["general.license.link"]),
    createExternalReference(
      "citation",
      metadata["general.doi"]
        ? `https://doi.org/${metadata["general.doi"]}`
        : undefined,
    ),
    createExternalReference(
      "citation",
      metadata["general.source.doi"]
        ? `https://doi.org/${metadata["general.source.doi"]}`
        : undefined,
      "GGUF source DOI",
    ),
  ]);

const createGgufBaseModelReference = (metadata, index) => {
  const baseKey = `general.base_model.${index}`;
  const repoUrl = metadata[`${baseKey}.repo_url`];
  const name = metadata[`${baseKey}.name`];
  const organization = metadata[`${baseKey}.organization`];
  const version = metadata[`${baseKey}.version`];
  const referenceUrl = metadata[`${baseKey}.url`];
  const huggingFaceReference = normalizeHuggingFaceReference(repoUrl);
  const externalReferences = uniqueExternalReferences([
    createExternalReference("website", referenceUrl),
    createExternalReference("vcs", repoUrl),
    createExternalReference(
      "citation",
      metadata[`${baseKey}.doi`]
        ? `https://doi.org/${metadata[`${baseKey}.doi`]}`
        : undefined,
    ),
  ]);
  if (huggingFaceReference?.assetType === "model") {
    return {
      "bom-ref": toHuggingFacePurl(huggingFaceReference.repoId),
      type: "machine-learning-model",
      group: huggingFaceReference.repoId.split("/")[0],
      name: huggingFaceReference.repoId.split("/")[1],
      purl: toHuggingFacePurl(huggingFaceReference.repoId),
      version,
      externalReferences,
    };
  }
  if (!name && !repoUrl) {
    return undefined;
  }
  const referenceName = name || repoUrl || `gguf-base-model-${index}`;
  return {
    "bom-ref": stableAiBomRef(
      "model",
      organization || "gguf-base-model",
      referenceName,
    ),
    type: "machine-learning-model",
    group: organization,
    name: referenceName,
    version,
    externalReferences,
  };
};

const createGgufPedigree = (metadata = {}) => {
  const baseModelIndexes = new Set();
  const baseModelCount = Number(metadata["general.base_model.count"]);
  if (Number.isInteger(baseModelCount) && baseModelCount > 0) {
    for (let index = 0; index < baseModelCount; index++) {
      baseModelIndexes.add(index);
    }
  }
  for (const key of Object.keys(metadata)) {
    const match = /^general\.base_model\.(\d+)\./u.exec(key);
    if (match) {
      baseModelIndexes.add(Number.parseInt(match[1], 10));
    }
  }
  const ancestors = Array.from(baseModelIndexes)
    .sort((left, right) => left - right)
    .map((index) => createGgufBaseModelReference(metadata, index))
    .filter(Boolean);
  if (!ancestors.length) {
    return undefined;
  }
  return { ancestors };
};

const ggufStringArray = (value) =>
  Array.isArray(value)
    ? value.map((entry) => String(entry || "").trim()).filter(Boolean)
    : [];

const ggufTokenizerSignals = (metadata = {}) => ({
  addedTokenCount: ggufStringArray(metadata["tokenizer.ggml.added_tokens"])
    .length,
  bosTokenId: metadata["tokenizer.ggml.bos_token_id"],
  chatTemplateDetected:
    typeof metadata["tokenizer.chat_template"] === "string" &&
    metadata["tokenizer.chat_template"].trim().length > 0,
  chatTemplateLength:
    typeof metadata["tokenizer.chat_template"] === "string"
      ? metadata["tokenizer.chat_template"].length
      : undefined,
  eosTokenId: metadata["tokenizer.ggml.eos_token_id"],
  huggingFaceTokenizer:
    typeof metadata["tokenizer.huggingface.json"] === "string" &&
    metadata["tokenizer.huggingface.json"].trim().length > 0,
  mergeCount: ggufStringArray(metadata["tokenizer.ggml.merges"]).length,
  paddingTokenId: metadata["tokenizer.ggml.padding_token_id"],
  scoreCount: Array.isArray(metadata["tokenizer.ggml.scores"])
    ? metadata["tokenizer.ggml.scores"].length
    : undefined,
  separatorTokenId: metadata["tokenizer.ggml.separator_token_id"],
  tokenCount: ggufStringArray(metadata["tokenizer.ggml.tokens"]).length,
  tokenizerModel: metadata["tokenizer.ggml.model"],
  tokenTypeCount: Array.isArray(metadata["tokenizer.ggml.token_type"])
    ? metadata["tokenizer.ggml.token_type"].length
    : undefined,
  unknownTokenId: metadata["tokenizer.ggml.unknown_token_id"],
});

const inferGgufModelTask = (metadata, parsedFileName) => {
  const tags = ggufStringArray(metadata["general.tags"]).map((tag) =>
    tag.toLowerCase(),
  );
  const fineTune = String(metadata["general.finetune"] || "").toLowerCase();
  if (
    tags.includes("text-generation") ||
    fineTune.includes("chat") ||
    fineTune.includes("instruct") ||
    fineTune.includes("coding") ||
    fineTune.includes("code") ||
    ggufTokenizerSignals(metadata).chatTemplateDetected
  ) {
    return "text-generation";
  }
  if (
    tags.includes("embedding") ||
    tags.includes("embeddings") ||
    String(parsedFileName?.baseName || "")
      .toLowerCase()
      .includes("embed")
  ) {
    return "feature-extraction";
  }
  return undefined;
};

const createInlineDatasetReference = (datasetValue) => {
  const normalizedDatasetValue = String(datasetValue || "").trim();
  if (!normalizedDatasetValue) {
    return undefined;
  }
  const sanitizedUrl = sanitizeBomUrl(normalizedDatasetValue);
  if (sanitizedUrl) {
    const huggingFaceReference = normalizeHuggingFaceReference(sanitizedUrl);
    return {
      type: "dataset",
      name: huggingFaceReference?.repoId || sanitizedUrl,
      contents: {
        url: sanitizedUrl,
      },
    };
  }
  return {
    type: "dataset",
    name: normalizedDatasetValue,
  };
};

const dedupeModelCardDatasets = (datasets) => [
  ...new Map(
    datasets
      .filter(Boolean)
      .map((dataset) => [dataset.contents?.url || dataset.name, dataset]),
  ).values(),
];

const createGgufModelCard = (metadata, parsedFileName) => {
  const architectureFamily = metadata["general.architecture"];
  const modelArchitecture = metadata["general.basename"];
  const datasets = dedupeModelCardDatasets(
    ggufStringArray(metadata["general.datasets"]).map(
      createInlineDatasetReference,
    ),
  );
  const task = inferGgufModelTask(metadata, parsedFileName);
  const tokenizerSignals = ggufTokenizerSignals(metadata);
  const modelCard = {
    modelParameters: {},
  };
  if (architectureFamily) {
    modelCard.modelParameters.architectureFamily = architectureFamily;
  }
  if (modelArchitecture) {
    modelCard.modelParameters.modelArchitecture = modelArchitecture;
  }
  if (task) {
    modelCard.modelParameters.task = task;
  }
  if (datasets.length) {
    modelCard.modelParameters.datasets = datasets;
  }
  if (
    tokenizerSignals.tokenizerModel ||
    tokenizerSignals.chatTemplateDetected
  ) {
    modelCard.modelParameters.inputs = [{ format: "text" }];
    modelCard.modelParameters.outputs = [{ format: "text" }];
  }
  return Object.values(modelCard.modelParameters).some(Boolean)
    ? sanitizeStructuredValueForBom(modelCard)
    : undefined;
};

const contextWindowFromGgufMetadata = (metadata = {}) => {
  const architecture = String(metadata["general.architecture"] || "").trim();
  if (
    architecture &&
    metadata[`${architecture}.context_length`] !== undefined
  ) {
    return metadata[`${architecture}.context_length`];
  }
  if (metadata["general.context_length"] !== undefined) {
    return metadata["general.context_length"];
  }
  for (const [key, value] of Object.entries(metadata)) {
    if (key.endsWith(".context_length")) {
      return value;
    }
  }
  return undefined;
};

const ggufModelIdFromFilename = (parsedFileName, filePath) => {
  const segments = [];
  if (parsedFileName?.sidecar) {
    segments.push(parsedFileName.sidecar);
  }
  if (parsedFileName?.baseName) {
    segments.push(parsedFileName.baseName);
  }
  if (parsedFileName?.sizeLabel) {
    segments.push(parsedFileName.sizeLabel);
  }
  if (parsedFileName?.fineTune) {
    segments.push(parsedFileName.fineTune);
  }
  if (parsedFileName?.type) {
    segments.push(parsedFileName.type);
  }
  if (segments.length) {
    return segments.join("-");
  }
  return basename(filePath, extname(filePath));
};

const applyGgufProperties = (
  subject,
  metadata,
  parsedFileName,
  includeArtifactDetails,
) => {
  const tokenizerSignals = ggufTokenizerSignals(metadata);
  addUniqueProperty(
    subject.properties,
    "cdx:gguf:basename",
    metadata["general.basename"] || parsedFileName?.baseName,
  );
  addUniqueProperty(
    subject.properties,
    "cdx:gguf:sizeLabel",
    metadata["general.size_label"] || parsedFileName?.sizeLabel,
  );
  addUniqueProperty(
    subject.properties,
    "cdx:gguf:finetune",
    metadata["general.finetune"] || parsedFileName?.fineTune,
  );
  addUniqueProperty(
    subject.properties,
    "cdx:gguf:quantizationVersion",
    metadata["general.quantization_version"],
  );
  addUniqueProperty(
    subject.properties,
    "cdx:gguf:quantizedBy",
    metadata["general.quantized_by"],
  );
  addUniqueProperty(
    subject.properties,
    "cdx:gguf:sidecar",
    parsedFileName?.sidecar,
  );
  addUniqueProperty(subject.properties, "cdx:gguf:type", parsedFileName?.type);
  addUniqueProperty(
    subject.properties,
    "cdx:gguf:tokenizerModel",
    tokenizerSignals.tokenizerModel,
  );
  addUniqueProperty(
    subject.properties,
    "cdx:gguf:tokenizerTokenCount",
    tokenizerSignals.tokenCount,
  );
  addUniqueProperty(
    subject.properties,
    "cdx:gguf:tokenizerScoreCount",
    tokenizerSignals.scoreCount,
  );
  addUniqueProperty(
    subject.properties,
    "cdx:gguf:tokenizerTokenTypeCount",
    tokenizerSignals.tokenTypeCount,
  );
  addUniqueProperty(
    subject.properties,
    "cdx:gguf:tokenizerMergeCount",
    tokenizerSignals.mergeCount,
  );
  addUniqueProperty(
    subject.properties,
    "cdx:gguf:tokenizerAddedTokenCount",
    tokenizerSignals.addedTokenCount,
  );
  addUniqueProperty(
    subject.properties,
    "cdx:gguf:huggingFaceTokenizer",
    tokenizerSignals.huggingFaceTokenizer ? "true" : undefined,
  );
  addUniqueProperty(
    subject.properties,
    "cdx:gguf:chatTemplateDetected",
    tokenizerSignals.chatTemplateDetected ? "true" : undefined,
  );
  addUniqueProperty(
    subject.properties,
    "cdx:gguf:chatTemplateLength",
    tokenizerSignals.chatTemplateLength,
  );
  addUniqueProperty(
    subject.properties,
    "cdx:gguf:bosTokenId",
    tokenizerSignals.bosTokenId,
  );
  addUniqueProperty(
    subject.properties,
    "cdx:gguf:eosTokenId",
    tokenizerSignals.eosTokenId,
  );
  addUniqueProperty(
    subject.properties,
    "cdx:gguf:unknownTokenId",
    tokenizerSignals.unknownTokenId,
  );
  addUniqueProperty(
    subject.properties,
    "cdx:gguf:separatorTokenId",
    tokenizerSignals.separatorTokenId,
  );
  addUniqueProperty(
    subject.properties,
    "cdx:gguf:paddingTokenId",
    tokenizerSignals.paddingTokenId,
  );
  for (const language of ggufStringArray(metadata["general.languages"])) {
    addUniqueProperty(subject.properties, "cdx:gguf:language", language);
  }
  addUniqueProperty(
    subject.properties,
    "cdx:gguf:datasetCount",
    ggufStringArray(metadata["general.datasets"]).length || undefined,
  );
  if (!includeArtifactDetails) {
    return;
  }
  addUniqueProperty(
    subject.properties,
    "cdx:gguf:formatVersion",
    metadata["gguf.version"],
  );
  addUniqueProperty(
    subject.properties,
    "cdx:gguf:tensorCount",
    metadata["gguf.tensorCount"],
  );
  addUniqueProperty(
    subject.properties,
    "cdx:gguf:metadataCount",
    metadata["gguf.metadataCount"],
  );
  addUniqueProperty(
    subject.properties,
    "cdx:gguf:alignment",
    metadata["general.alignment"],
  );
  addUniqueProperty(
    subject.properties,
    "cdx:gguf:shard",
    parsedFileName?.shard,
  );
  addUniqueProperty(
    subject.properties,
    "cdx:gguf:shardIndex",
    parsedFileName?.shardIndex,
  );
  addUniqueProperty(
    subject.properties,
    "cdx:gguf:shardCount",
    parsedFileName?.shardCount,
  );
};

const extractHuggingFaceArtifactDetails = (sourceUrl) => {
  if (!sourceUrl) {
    return {};
  }
  try {
    const parsed = new URL(sourceUrl);
    const fileName = basename(parsed.pathname);
    const artifactFormat = fileName.toLowerCase().endsWith(".gguf")
      ? "gguf"
      : undefined;
    const parsedGgufFileName = parseGgufFilename(fileName);
    return {
      artifactFormat,
      quantization:
        parsedGgufFileName?.encoding || quantizationValueFromFilename(fileName),
      sourceUrl,
    };
  } catch {
    return {};
  }
};

const dependencyListFromMap = (dependencyMap) =>
  Array.from(dependencyMap.entries()).map(([ref, dependsOn]) => ({
    ref,
    dependsOn: Array.from(dependsOn).sort(),
  }));

const buildAiInventoryResult = (
  componentsByKey,
  servicesByKey,
  dependencyMap,
) => {
  const components = Array.from(componentsByKey.values()).map((component) => {
    applyOccurrenceEvidence(component, component?.evidence?.occurrences || []);
    return component;
  });
  const services = Array.from(servicesByKey.values()).map((service) => {
    syncServiceProperties(service);
    return serializeAiService(service);
  });
  const dependencies = dependencyListFromMap(dependencyMap);
  for (const service of services) {
    const source = servicesByKey.get(`${service.group}:${service.name}`);
    const dependsOn = new Set([
      ...Array.from(source?.modelRefs || []),
      ...Array.from(source?.fileRefs || []),
    ]);
    if (dependsOn.size) {
      dependencies.push({
        ref: service["bom-ref"],
        dependsOn: Array.from(dependsOn).sort(),
      });
    }
  }
  return { components, dependencies, services };
};

const classifyImport = (importName) =>
  AI_PACKAGE_REGISTRY.find((entry) => entry.pattern.test(importName));

const getSourceFiles = (discoveryPath, patterns, options) => {
  const files = new Set();
  const directFileMatches = getDirectDiscoveryFileMatches(
    discoveryPath,
    patterns,
  );
  for (const filePath of directFileMatches) {
    const normalizedFilePath = String(filePath || "");
    if (
      normalizedFilePath.includes("/node_modules/") ||
      normalizedFilePath.includes("\\node_modules\\") ||
      IGNORE_SOURCE_FILE_PATTERN.test(normalizedFilePath)
    ) {
      continue;
    }
    files.add(filePath);
  }
  if (isDirectDiscoveryFile(discoveryPath)) {
    return Array.from(files).sort();
  }
  for (const pattern of patterns) {
    for (const filePath of getAllFiles(discoveryPath, pattern, options) || []) {
      const normalizedFilePath = String(filePath || "");
      if (
        normalizedFilePath.includes("/node_modules/") ||
        normalizedFilePath.includes("\\node_modules\\") ||
        IGNORE_SOURCE_FILE_PATTERN.test(normalizedFilePath)
      ) {
        continue;
      }
      files.add(filePath);
    }
  }
  return Array.from(files).sort();
};

const getMatchingFiles = (discoveryPath, patterns, options) => {
  const files = new Set();
  for (const filePath of getDirectDiscoveryFileMatches(
    discoveryPath,
    patterns,
  )) {
    files.add(filePath);
  }
  if (isDirectDiscoveryFile(discoveryPath)) {
    return Array.from(files).sort();
  }
  for (const pattern of patterns) {
    for (const filePath of getAllFiles(discoveryPath, pattern, options) || []) {
      files.add(filePath);
    }
  }
  return Array.from(files).sort();
};

const isDirectDiscoveryFile = (discoveryPath) => {
  try {
    return statSync(discoveryPath).isFile();
  } catch {
    return false;
  }
};

const getDirectDiscoveryFileMatches = (discoveryPath, patterns) => {
  if (!isDirectDiscoveryFile(discoveryPath)) {
    return [];
  }
  const normalizedPath = String(discoveryPath || "");
  const filename = basename(normalizedPath);
  const extension = extname(normalizedPath).toLowerCase();
  if (
    patterns.includes("Modelfile") &&
    (filename === "Modelfile" || filename.startsWith("Modelfile."))
  ) {
    return [normalizedPath];
  }
  if (patterns.includes("**/*.gguf") && extension === ".gguf") {
    return [normalizedPath];
  }
  if (
    patterns.some((pattern) =>
      pattern.includes("*.{js,jsx,cjs,mjs,ts,tsx,mts,cts,vue,svelte}"),
    ) &&
    [
      ".js",
      ".jsx",
      ".cjs",
      ".mjs",
      ".ts",
      ".tsx",
      ".mts",
      ".cts",
      ".vue",
      ".svelte",
    ].includes(extension)
  ) {
    return [normalizedPath];
  }
  if (
    patterns.some((pattern) => pattern.includes("*.{py,pyw}")) &&
    [".py", ".pyw"].includes(extension)
  ) {
    return [normalizedPath];
  }
  if (patterns.includes("**/*.ipynb") && extension === ".ipynb") {
    return [normalizedPath];
  }
  return [];
};

const defaultServiceNameForProvider = (provider) =>
  AI_PACKAGE_REGISTRY.find(
    (entry) => entry.provider === provider && entry.serviceName,
  )?.serviceName || `${provider || "ai"}-service`;

const fileBomRef = (discoveryPath, filePath) =>
  `urn:file:ai:${(relative(discoveryPath, filePath) || basename(filePath)).replaceAll(/[^a-zA-Z0-9._:/-]+/gu, "-")}`;

const createAiFileComponent = (
  componentsByKey,
  discoveryPath,
  filePath,
  kind,
  tags = [],
) => {
  const key = `file:${relative(discoveryPath, filePath) || basename(filePath)}`;
  if (!componentsByKey.has(key)) {
    const location = relativeOccurrenceLocation(discoveryPath, filePath);
    componentsByKey.set(key, {
      "bom-ref": fileBomRef(discoveryPath, filePath),
      type: "file",
      name: basename(filePath),
      evidence: { occurrences: [{ location }] },
      properties: [
        { name: "cdx:file:kind", value: kind },
        { name: "cdx:ai:kind", value: kind },
        { name: "cdx:ai:source", value: "source-code-analysis" },
      ],
      tags: ["ai", kind, ...tags],
    });
  }
  return componentsByKey.get(key);
};

const normalizeComponentIdentity = ({
  assetType,
  modelId,
  provider,
  version,
}) => {
  const normalizedAssetType = ["dataset", "space"].includes(assetType)
    ? assetType
    : "model";
  const normalizedModelId = String(modelId || "").trim();
  const normalizedProvider = String(provider || "ai").trim();
  const typedModelId =
    normalizedAssetType === "dataset"
      ? `datasets/${normalizedModelId.replace(/^datasets\//u, "")}`
      : normalizedAssetType === "space"
        ? `spaces/${normalizedModelId.replace(/^spaces\//u, "")}`
        : normalizedModelId;
  const repoId = normalizeHuggingFaceReference(typedModelId);
  if (
    repoId?.assetType === normalizedAssetType &&
    repoId?.repoId?.includes("/")
  ) {
    const [group, name] = repoId.repoId.split("/");
    const purl = toHuggingFacePurl(
      repoId.repoId,
      repoId.version || version,
      repositoryUrlForHuggingFaceAssetType(normalizedAssetType),
    );
    return {
      bomRef: purl,
      group,
      name,
      purl,
    };
  }
  return {
    bomRef: stableAiBomRef(
      normalizedAssetType,
      normalizedProvider,
      normalizedModelId,
    ),
    group: normalizedProvider,
    name: normalizedModelId,
  };
};

const ensureModelComponent = (componentsByKey, key, seed) => {
  if (!componentsByKey.has(key)) {
    const identity = normalizeComponentIdentity(seed);
    const type =
      seed.assetType === "dataset"
        ? "data"
        : seed.assetType === "space"
          ? "application"
          : "machine-learning-model";
    componentsByKey.set(key, {
      "bom-ref": identity.bomRef,
      type,
      group: identity.group,
      name: identity.name,
      purl: identity.purl,
      description: seed.description,
      version: seed.version,
      licenses: seed.licenses,
      externalReferences: seed.externalReferences || [],
      evidence: { occurrences: [] },
      modelCard: seed.modelCard
        ? sanitizeStructuredValueForBom(seed.modelCard)
        : undefined,
      pedigree: seed.pedigree,
      properties: [],
      tags: ["ai"],
    });
  }
  return componentsByKey.get(key);
};

const ensureService = (servicesByKey, provider, serviceName) => {
  const normalizedProvider = provider || "ai";
  const resolvedServiceName =
    serviceName || defaultServiceNameForProvider(normalizedProvider);
  const key = `${normalizedProvider}:${resolvedServiceName}`;
  if (!servicesByKey.has(key)) {
    servicesByKey.set(key, {
      "bom-ref": `urn:service:ai:${normalizedProvider}:${String(
        serviceName || `${normalizedProvider}-service`,
      ).replaceAll(/[^a-zA-Z0-9._:-]+/gu, "-")}`,
      group: normalizedProvider,
      name: resolvedServiceName,
      provider: providerEntityForName(normalizedProvider),
      version: "observed",
      endpoints: new Set(),
      modelRefs: new Set(),
      modelIds: new Set(),
      modelFamilies: new Set(),
      frameworks: new Set(),
      runtimes: new Set(),
      sdkImports: new Set(),
      fileRefs: new Set(),
      occurrences: [],
      properties: [],
      tags: new Set(["ai"]),
    });
  }
  return servicesByKey.get(key);
};

const syncComponentProperties = (component, data = {}) => {
  if (data.provider) {
    addUniqueProperty(component.properties, "cdx:ai:provider", data.provider);
  }
  if (data.kind) {
    addUniqueProperty(component.properties, "cdx:ai:kind", data.kind);
  }
  if (data.modelFamily) {
    addUniqueProperty(
      component.properties,
      "cdx:ai:modelFamily",
      data.modelFamily,
    );
  }
  if (data.artifactFormat) {
    addUniqueProperty(
      component.properties,
      "cdx:ai:artifactFormat",
      data.artifactFormat,
    );
  }
  if (data.runtime) {
    addUniqueProperty(component.properties, "cdx:ai:runtime", data.runtime);
  }
  if (data.quantization) {
    addUniqueProperty(
      component.properties,
      "cdx:ai:quantization",
      data.quantization,
    );
  }
  for (const variant of data.variants || []) {
    addUniqueProperty(component.properties, "cdx:ai:variant", variant);
  }
  if (data.parameterCount !== undefined) {
    addUniqueProperty(
      component.properties,
      "cdx:ai:parameterCount",
      data.parameterCount,
    );
  }
  if (data.contextWindow !== undefined) {
    addUniqueProperty(
      component.properties,
      "cdx:ai:contextWindow",
      data.contextWindow,
    );
  }
  if (data.modality) {
    addUniqueProperty(component.properties, "cdx:ai:modality", data.modality);
  }
  if (data.source) {
    addUniqueProperty(component.properties, "cdx:ai:source", data.source);
  }
  if (data.confidence) {
    addUniqueProperty(
      component.properties,
      "cdx:ai:confidence",
      data.confidence,
    );
  }
  if (data.reviewNeeded) {
    addUniqueProperty(component.properties, "cdx:ai:reviewNeeded", "true");
  }
};

const aiModelVariantsFromSeed = (seed = {}) =>
  detectAiModelVariants({
    description: seed.description,
    metadata: [
      seed.artifactFormat,
      seed.modelFamily,
      seed.runtime,
      seed.source,
      seed.modelCard?.modelParameters?.task,
      ...(seed.modelCard?.modelParameters?.datasets || []).map(
        (dataset) => dataset?.name || dataset?.ref,
      ),
    ],
    modelName: [seed.modelId, seed.name],
    notes: [seed.pedigree?.notes],
    quantization: seed.quantization,
    relation:
      String(seed.pedigree?.notes || "")
        .match(/Hugging Face relation:\s*([^;]+)/u)?.[1]
        ?.trim() || seed.relation,
    tags: seed.tags,
  });

const syncServiceProperties = (service) => {
  service.properties = [];
  addUniqueProperty(service.properties, "cdx:ai:kind", "inference-service");
  addUniqueProperty(
    service.properties,
    "cdx:ai:source",
    "source-code-analysis",
  );
  const sortedFamilies = Array.from(service.modelFamilies).sort();
  const sortedModelIds = Array.from(service.modelIds).sort();
  const endpoints = Array.from(service.endpoints);
  const remoteEndpoints = [];
  const localEndpoints = [];
  for (const endpoint of endpoints) {
    try {
      const parsed = new URL(endpoint);
      if (isLocalAiHostname(parsed.hostname)) {
        localEndpoints.push(endpoint);
      } else {
        remoteEndpoints.push(endpoint);
      }
    } catch {
      // Ignore malformed endpoints captured from source strings.
    }
  }
  for (const modelId of sortedModelIds) {
    addUniqueProperty(service.properties, "cdx:ai:modelId", modelId);
  }
  for (const modelFamily of sortedFamilies) {
    addUniqueProperty(service.properties, "cdx:ai:modelFamily", modelFamily);
  }
  addUniqueProperty(
    service.properties,
    "cdx:ai:modelCount",
    String(sortedModelIds.length),
  );
  addUniqueProperty(
    service.properties,
    "cdx:ai:modelSelection",
    sortedModelIds.length ? "explicit" : "implicit",
  );
  addUniqueProperty(
    service.properties,
    "cdx:ai:deployment",
    remoteEndpoints.length
      ? "remote"
      : localEndpoints.length
        ? "local"
        : "implicit",
  );
  addUniqueProperty(
    service.properties,
    "cdx:ai:transportSecurity",
    remoteEndpoints.some((endpoint) => endpoint.startsWith("http://"))
      ? "insecure-http"
      : remoteEndpoints.length
        ? "https"
        : localEndpoints.length
          ? "local-only"
          : "unknown",
  );
  if (service.runtimes.size) {
    addUniqueProperty(
      service.properties,
      "cdx:ai:runtime",
      Array.from(service.runtimes).sort().join(","),
    );
  }
  addUniqueProperty(
    service.properties,
    "cdx:ai:confidence",
    sortedModelIds.length || service.endpoints.size ? "high" : "medium",
  );
  if (
    service.group === "ollama" ||
    Array.from(service.endpoints).some((endpoint) =>
      endpoint.includes("localhost"),
    )
  ) {
    addUniqueProperty(service.properties, "cdx:ai:reviewNeeded", "true");
  }
};

const appendImportSignals = (
  importName,
  occurrence,
  fileSignals,
  servicesByKey,
) => {
  const classification = classifyImport(importName);
  if (!classification) {
    return;
  }
  if (classification.framework) {
    fileSignals.frameworks.add(classification.framework);
  }
  if (classification.provider) {
    fileSignals.providers.add(classification.provider);
    const service = ensureService(
      servicesByKey,
      classification.provider,
      classification.serviceName,
    );
    service.sdkImports.add(importName);
    service.tags.add(classification.provider);
    appendOccurrence(
      service,
      occurrence.fileName
        ? `${occurrence.fileName}${occurrence.lineNumber ? `#L${occurrence.lineNumber}` : ""}`
        : importName,
    );
    fileSignals.serviceRefs.add(service["bom-ref"]);
    if (fileSignals.fileRef) {
      service.fileRefs.add(fileSignals.fileRef);
    }
  }
  if (classification.runtime) {
    fileSignals.runtimes.add(classification.runtime);
  }
};

const scanUrlMatches = (
  raw,
  filePath,
  discoveryPath,
  fileSignals,
  servicesByKey,
) => {
  for (const match of raw.matchAll(/https?:\/\/[^\s"'`)<]+/gu)) {
    const urlValue = sanitizeBomUrl(match[0]);
    if (!urlValue) {
      continue;
    }
    const provider = hostProviderFromValue(urlValue);
    if (!provider) {
      continue;
    }
    fileSignals.providers.add(provider);
    const service = ensureService(servicesByKey, provider, undefined);
    service.endpoints.add(urlValue);
    if (fileSignals.fileRef) {
      service.fileRefs.add(fileSignals.fileRef);
    }
    fileSignals.serviceRefs.add(service["bom-ref"]);
    appendOccurrence(
      service,
      relativeOccurrenceLocation(
        discoveryPath,
        filePath,
        lineNumberForIndex(raw, match.index),
      ),
    );
  }
};

const extractModelAssignments = (raw) => {
  const values = [];
  const patterns = [
    /\bmodel(?:Id|Name)?\s*[:=]\s*["'`]([^"'`\n]{2,160})["'`]/gu,
    /\b(?:model|model_name|model_id)\s*=\s*["'`]([^"'`\n]{2,160})["'`]/gu,
    /\b(?:model|model_name|model_id)\s*:\s*([A-Za-z0-9._:/-]{2,160})\b/gu,
    /pipeline\s*\(\s*["'`][^"'`]+["'`]\s*,\s*["'`]([^"'`\n]{2,160})["'`]/gu,
    /InferenceClient\s*\(\s*["'`]([^"'`\n]{2,160})["'`]/gu,
    /\b(?:from_pretrained|AutoModel(?:For\w+)?)\s*\(\s*["'`]([^"'`\n]{2,160})["'`]/gu,
  ];
  for (const pattern of patterns) {
    for (const match of raw.matchAll(pattern)) {
      values.push({ index: match.index, value: match[1] });
    }
  }
  return values.filter((entry) => {
    const normalized = String(entry.value || "").trim();
    return (
      normalized && !normalized.startsWith("http") && normalized !== "auto"
    );
  });
};

const extractHuggingFaceReferences = (raw) => {
  const refs = [];
  const patterns = [
    /https?:\/\/huggingface\.co\/(datasets\/|spaces\/)?([^/"'`?#\s]+\/[^/"'`?#\s]+)(?:\/resolve\/[^"'`?#\s]+\/([^"'`?#\s]+))?/gu,
    /\b(?:repo_?id|model)\s*[:=]\s*["'`]([^"'`\n]+\/[^"'`\n]+)["'`]/gu,
  ];
  for (const pattern of patterns) {
    for (const match of raw.matchAll(pattern)) {
      refs.push({
        index: match.index,
        artifact: match[3],
        sourceUrl: match[0]?.startsWith("http") ? match[0] : undefined,
        value:
          match[2] !== undefined ? `${match[1] || ""}${match[2]}` : match[1],
      });
    }
  }
  return refs
    .map((entry) => {
      const reference = normalizeHuggingFaceReference(entry.value);
      return {
        artifact: entry.artifact,
        index: entry.index,
        reference,
        sourceUrl: entry.sourceUrl,
      };
    })
    .filter((entry) => entry.reference?.repoId);
};

const applyOccurrenceEvidence = (subject, occurrences) => {
  if (!occurrences?.length) {
    return;
  }
  subject.evidence = subject.evidence || {};
  subject.evidence.occurrences = subject.evidence.occurrences || [];
  for (const occurrence of occurrences) {
    if (
      !subject.evidence.occurrences.some(
        (entry) => entry.location === occurrence.location,
      )
    ) {
      subject.evidence.occurrences.push(occurrence);
    }
  }
};

const createModelComponent = (componentsByKey, seed, occurrenceLocation) => {
  const variants = normalizeDetectedVariants([
    ...(seed.variants || []),
    ...aiModelVariantsFromSeed(seed),
  ]);
  const normalizedAssetType = ["dataset", "space"].includes(seed.assetType)
    ? seed.assetType
    : "model";
  const key = `${normalizedAssetType}:${seed.provider || "ai"}:${seed.modelId}`;
  const component = ensureModelComponent(componentsByKey, key, seed);
  syncComponentProperties(component, {
    artifactFormat: seed.artifactFormat,
    confidence: seed.confidence,
    contextWindow: seed.contextWindow,
    kind: normalizedAssetType,
    modality: seed.modality,
    modelFamily: seed.modelFamily,
    parameterCount: seed.parameterCount,
    provider: seed.provider,
    quantization: seed.quantization,
    reviewNeeded: seed.reviewNeeded,
    runtime: seed.runtime,
    source: seed.source,
  });
  if (occurrenceLocation) {
    appendOccurrence(component.evidence, occurrenceLocation);
  }
  if (seed.tags?.length) {
    component.tags = [
      ...new Set([...(component.tags || []), ...seed.tags, ...variants]),
    ];
  }
  if (seed.externalReferences?.length) {
    component.externalReferences = [
      ...new Map(
        [
          ...(component.externalReferences || []),
          ...seed.externalReferences,
        ].map((reference) => [`${reference.type}:${reference.url}`, reference]),
      ).values(),
    ];
  }
  if (seed.licenses?.length && !component.licenses?.length) {
    component.licenses = seed.licenses;
  }
  if (!component.modelCard && seed.modelCard) {
    component.modelCard = sanitizeStructuredValueForBom(seed.modelCard);
  }
  const mergedPedigree = mergePedigreeVariants(
    component.pedigree || seed.pedigree,
    variants,
  );
  if (mergedPedigree) {
    component.pedigree = mergedPedigree;
  }
  if (!component.description && seed.description) {
    component.description = seed.description;
  }
  if (!component.version && seed.version) {
    component.version = seed.version;
  }
  return component;
};

// -----------------------------------------------------------------------------
// Section: artifact collectors (Modelfile and GGUF)
// -----------------------------------------------------------------------------

const attachModelToServices = (servicesByKey, modelComponent, signals) => {
  const providers = signals.providers.size
    ? Array.from(signals.providers)
    : [modelComponent.group].filter(Boolean);
  for (const provider of providers) {
    const service = ensureService(servicesByKey, provider, undefined);
    service.modelRefs.add(modelComponent["bom-ref"]);
    service.modelIds.add(modelComponent.name);
    const family = modelFamilyFromName(modelComponent.name);
    if (family) {
      service.modelFamilies.add(family);
    }
    for (const framework of signals.frameworks) {
      service.frameworks.add(framework);
      service.tags.add(framework);
    }
    for (const runtime of signals.runtimes) {
      service.runtimes.add(runtime);
    }
    if (signals.fileRef) {
      service.fileRefs.add(signals.fileRef);
    }
    signals.serviceRefs.add(service["bom-ref"]);
  }
};

const collectTextAiInventory = (discoveryPath, options = {}, config = {}) => {
  const componentsByKey = new Map();
  const servicesByKey = new Map();
  const dependencyMap = new Map();
  const sourceFiles = getSourceFiles(
    discoveryPath,
    config.patterns || [],
    options,
  );
  for (const filePath of sourceFiles) {
    let raw = "";
    try {
      raw = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }
    const fileKey = relative(discoveryPath, filePath) || basename(filePath);
    const fileSignals = createFileSignals();
    if (config.fileKind) {
      fileSignals.fileRef = createAiFileComponent(
        componentsByKey,
        discoveryPath,
        filePath,
        config.fileKind,
        config.tags,
      )["bom-ref"];
    }
    scanUrlMatches(raw, filePath, discoveryPath, fileSignals, servicesByKey);
    for (const match of extractImportNames(raw)) {
      for (const importName of match.names) {
        appendImportSignals(
          importName,
          {
            fileName: fileKey,
            lineNumber: lineNumberForIndex(raw, match.index),
          },
          fileSignals,
          servicesByKey,
        );
      }
    }
    for (const match of extractModelAssignments(raw)) {
      const modelId = String(match.value || "").trim();
      const provider =
        Array.from(fileSignals.providers)[0] || providerFromModelName(modelId);
      const component = createModelComponent(
        componentsByKey,
        {
          assetType: "model",
          confidence: "medium",
          kind: "model",
          modelFamily: modelFamilyFromName(modelId),
          modelId,
          provider,
          reviewNeeded: provider === "ollama",
          runtime: Array.from(fileSignals.runtimes)[0],
          source: "source-code-analysis",
          tags: [...fileSignals.frameworks],
        },
        relativeOccurrenceLocation(
          discoveryPath,
          filePath,
          lineNumberForIndex(raw, match.index),
        ),
      );
      fileSignals.modelRefs.add(component["bom-ref"]);
      attachModelToServices(servicesByKey, component, fileSignals);
    }
    for (const match of extractHuggingFaceReferences(raw)) {
      const occurrenceLocation = relativeOccurrenceLocation(
        discoveryPath,
        filePath,
        lineNumberForIndex(raw, match.index),
      );
      const assetType = match.reference.assetType;
      const [group, name] = match.reference.repoId.split("/");
      const artifactDetails = extractHuggingFaceArtifactDetails(
        match.sourceUrl,
      );
      const component = createModelComponent(
        componentsByKey,
        {
          assetType,
          artifactFormat: artifactDetails.artifactFormat,
          confidence: "high",
          externalReferences: [
            {
              type: "distribution",
              url:
                artifactDetails.sourceUrl ||
                toHuggingFaceAssetUrl(assetType, match.reference.repoId),
            },
          ],
          modelFamily:
            assetType === "model" ? modelFamilyFromName(name) : undefined,
          modelId: match.reference.repoId,
          provider: "huggingface",
          quantization: artifactDetails.quantization,
          source: "source-code-analysis",
          tags: ["huggingface", assetType],
          version: match.reference.version,
        },
        occurrenceLocation,
      );
      component.group = group;
      component.name = name;
      fileSignals.modelRefs.add(component["bom-ref"]);
      attachModelToServices(servicesByKey, component, fileSignals);
    }
    if (fileSignals.fileRef) {
      const fileDeps = new Set([
        ...fileSignals.modelRefs,
        ...fileSignals.serviceRefs,
      ]);
      if (fileDeps.size) {
        dependencyMap.set(fileSignals.fileRef, fileDeps);
      }
    }
  }
  return { componentsByKey, dependencyMap, servicesByKey };
};

const collectConfiguredTextAiInventory = (discoveryPath, options, config) => {
  const { componentsByKey, dependencyMap, servicesByKey } =
    collectTextAiInventory(discoveryPath, options, config);
  return buildAiInventoryResult(componentsByKey, servicesByKey, dependencyMap);
};

// -----------------------------------------------------------------------------
// Section: inventory collectors
// -----------------------------------------------------------------------------

/**
 * Collect AI-related inventory from JavaScript and TypeScript sources.
 *
 * @param {string} discoveryPath directory or file being analyzed
 * @param {Object} [options={}] collection options
 * @returns {{ components: Object[], dependencies: Object[], services: Object[] }} AI inventory
 */
export function collectJsAiInventory(discoveryPath, options = {}) {
  const { componentsByKey, dependencyMap, servicesByKey } =
    collectTextAiInventory(
      discoveryPath,
      options,
      TEXT_AI_INVENTORY_CONFIGS.javascript,
    );
  for (const filePath of getMatchingFiles(
    discoveryPath,
    MODEFILE_PATTERNS,
    options,
  )) {
    let raw = "";
    try {
      raw = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }
    const parsed = parseOllamaModelfile(raw);
    if (!parsed.from) {
      continue;
    }
    const modelId = parsed.from.replace(/^FROM\s+/iu, "").trim();
    const fileComponent = createAiFileComponent(
      componentsByKey,
      discoveryPath,
      filePath,
      "model-config-file",
      ["ollama", "modelfile"],
    );
    const component = createModelComponent(
      componentsByKey,
      {
        artifactFormat: "modelfile",
        confidence: "high",
        licenses: getLicenses({ license: parsed.license }),
        modelFamily: modelFamilyFromName(modelId),
        modelId,
        provider: normalizeHuggingFaceReference(modelId)
          ? "huggingface"
          : "ollama",
        reviewNeeded: true,
        runtime: "ollama",
        source: "local-config",
        tags: ["ollama", "modelfile"],
      },
      relativeOccurrenceLocation(discoveryPath, filePath),
    );
    dependencyMap.set(
      fileComponent["bom-ref"],
      new Set([component["bom-ref"]]),
    );
    attachModelToServices(servicesByKey, component, {
      fileRef: fileComponent["bom-ref"],
      frameworks: new Set(),
      modelRefs: new Set([component["bom-ref"]]),
      providers: new Set(["ollama"]),
      runtimes: new Set(["ollama"]),
      serviceRefs: new Set(),
    });
  }
  for (const filePath of getMatchingFiles(
    discoveryPath,
    GGUF_PATTERNS,
    options,
  )) {
    let metadata;
    try {
      metadata = readGgufMetadata(filePath);
    } catch {
      continue;
    }
    const fileComponent = createAiFileComponent(
      componentsByKey,
      discoveryPath,
      filePath,
      "model-artifact-file",
      ["gguf"],
    );
    const parsedFileName = parseGgufFilename(filePath);
    const contextWindow = contextWindowFromGgufMetadata(metadata);
    const quantization =
      ggufFileTypeName(metadata["general.file_type"]) ||
      parsedFileName?.encoding ||
      quantizationValueFromFilename(filePath);
    applyGgufProperties(fileComponent, metadata, parsedFileName, true);
    const component = createModelComponent(
      componentsByKey,
      {
        artifactFormat: "gguf",
        confidence: "high",
        contextWindow,
        description: metadata["general.description"],
        externalReferences: createGgufExternalReferences(metadata),
        licenses: getLicenses({ license: metadata["general.license"] }),
        modelCard: createGgufModelCard(metadata, parsedFileName),
        modelFamily: modelFamilyFromName(
          metadata["general.name"] ||
            metadata["general.basename"] ||
            ggufModelIdFromFilename(parsedFileName, filePath),
        ),
        modelId:
          metadata["general.name"] ||
          ggufModelIdFromFilename(parsedFileName, filePath),
        parameterCount: metadata["general.parameter_count"],
        pedigree: createGgufPedigree(metadata),
        provider: metadata["general.organization"] || "local",
        quantization,
        reviewNeeded: true,
        runtime: "llama.cpp",
        source: "local-artifact",
        tags: [
          "gguf",
          "local-model",
          ...(Array.isArray(metadata["general.tags"])
            ? metadata["general.tags"]
            : []
          ).filter(Boolean),
          parsedFileName?.sidecar,
          parsedFileName?.type,
        ].filter(Boolean),
        variants:
          parsedFileName?.type === "LoRA"
            ? ["adapter"]
            : parsedFileName?.sidecar
              ? [parsedFileName.sidecar]
              : undefined,
        version: metadata["general.version"] || parsedFileName?.version,
      },
      relativeOccurrenceLocation(discoveryPath, filePath),
    );
    applyGgufProperties(component, metadata, parsedFileName, false);
    dependencyMap.set(
      fileComponent["bom-ref"],
      new Set([component["bom-ref"]]),
    );
  }

  return buildAiInventoryResult(componentsByKey, servicesByKey, dependencyMap);
}

/**
 * Collect AI inventory from local Hugging Face repository metadata files.
 *
 * @param {string} discoveryPath directory or file being analyzed
 * @param {Object} [options={}] collection options
 * @returns {{ components: Object[], dependencies: Object[], services: Object[] }} AI inventory
 */
export function collectHuggingFaceRepoAiInventory(discoveryPath, options = {}) {
  const componentsByKey = new Map();
  const dependencyMap = new Map();
  const repoMetadata = new Map();
  const rememberRepoEntry = (filePath) => {
    const directoryPath = dirname(filePath);
    if (!repoMetadata.has(directoryPath)) {
      repoMetadata.set(directoryPath, {
        adapterConfig: undefined,
        cardData: undefined,
        config: undefined,
        files: new Set(),
      });
    }
    repoMetadata.get(directoryPath).files.add(filePath);
    return repoMetadata.get(directoryPath);
  };

  for (const filePath of getMatchingFiles(
    discoveryPath,
    HUGGING_FACE_MODEL_CARD_PATTERNS,
    options,
  )) {
    let raw = "";
    try {
      raw = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }
    const cardData = parseHuggingFaceReadmeFrontmatter(raw);
    if (!hasHuggingFaceCardSignals(cardData)) {
      continue;
    }
    rememberRepoEntry(filePath).cardData = cardData;
  }

  for (const filePath of getMatchingFiles(
    discoveryPath,
    HUGGING_FACE_CONFIG_PATTERNS,
    options,
  )) {
    const config = parseJsonObject(filePath);
    if (
      !config?.model_type &&
      !config?.architectures &&
      !config?.quantization_config &&
      !config?.max_position_embeddings
    ) {
      continue;
    }
    rememberRepoEntry(filePath).config = config;
  }

  for (const filePath of getMatchingFiles(
    discoveryPath,
    HUGGING_FACE_ADAPTER_PATTERNS,
    options,
  )) {
    const adapterConfig = parseJsonObject(filePath);
    if (!adapterConfig?.base_model_name_or_path && !adapterConfig?.peft_type) {
      continue;
    }
    rememberRepoEntry(filePath).adapterConfig = adapterConfig;
  }

  for (const [directoryPath, metadata] of repoMetadata.entries()) {
    const repoId =
      normalizeHuggingFaceReference(metadata.cardData?.modelId)?.repoId ||
      normalizeHuggingFaceReference(metadata.cardData?.model_id)?.repoId ||
      normalizeHuggingFaceReference(metadata.cardData?.id)?.repoId ||
      normalizeHuggingFaceReference(metadata.config?._name_or_path)?.repoId ||
      repoIdFromFixtureDirectory(Array.from(metadata.files)[0]);
    const modelId = repoId || basename(directoryPath);
    const quantization =
      quantizationValueFromConfig(metadata.config?.quantization_config) ||
      metadata.cardData?.quantization ||
      metadata.cardData?.quantization_config;
    const modelOccurrenceLocation = relativeOccurrenceLocation(
      discoveryPath,
      Array.from(metadata.files)[0],
    );
    const modelCard = createHuggingFaceModelCard(
      metadata.cardData,
      metadata.config,
      (dataset) => {
        const datasetReference = createHuggingFaceDatasetReference(dataset, {
          componentSource: "local-huggingface-metadata",
          componentTags: ["ai", "dataset", "huggingface"],
          urlSanitizer: sanitizeBomUrl,
        });
        if (!datasetReference) {
          return undefined;
        }
        const datasetComponent = ensureModelComponent(
          componentsByKey,
          `dataset:${datasetReference.modelId}`,
          {
            assetType: "dataset",
            description: datasetReference.description,
            externalReferences: datasetReference.externalReferences,
            modelId: datasetReference.modelId,
            provider: datasetReference.provider,
          },
        );
        datasetComponent.group = datasetReference.group;
        datasetComponent.name = datasetReference.name;
        datasetComponent.purl = datasetReference.purl;
        datasetComponent.data = datasetReference.component.data;
        datasetComponent.tags = [
          ...new Set([
            ...(datasetComponent.tags || []),
            "ai",
            "dataset",
            "huggingface",
          ]),
        ];
        datasetComponent.properties =
          datasetReference.component.properties || [];
        applyOccurrenceEvidence(datasetComponent, [
          { location: modelOccurrenceLocation },
        ]);
        if (!dependencyMap.has(modelId)) {
          dependencyMap.set(modelId, new Set());
        }
        dependencyMap.get(modelId).add(datasetComponent["bom-ref"]);
        return datasetReference.ref;
      },
      { urlSanitizer: sanitizeBomUrl },
    );
    const pedigree = createHuggingFacePedigree(
      metadata.cardData,
      metadata.adapterConfig,
      quantization,
    );
    const variants = detectAiModelVariants({
      description:
        metadata.cardData?.model_description || metadata.cardData?.description,
      metadata: [
        metadata.adapterConfig?.peft_type,
        metadata.cardData?.library_name,
      ],
      modelName: modelId,
      notes: [pedigree?.notes],
      quantization,
      relation:
        metadata.cardData?.base_model_relation ||
        metadata.adapterConfig?.base_model_relation ||
        (metadata.adapterConfig?.base_model_name_or_path
          ? "adapter"
          : undefined),
      tags: metadata.cardData?.tags,
    });
    const component = createModelComponent(
      componentsByKey,
      {
        assetType: "model",
        confidence: "high",
        contextWindow: metadata.config?.max_position_embeddings,
        description:
          metadata.cardData?.model_description ||
          metadata.cardData?.description,
        externalReferences: repoId
          ? [{ type: "distribution", url: `https://huggingface.co/${repoId}` }]
          : [],
        licenses: getLicenses({ license: metadata.cardData?.license }),
        modelCard,
        modelFamily: modelFamilyFromName(modelId),
        modelId,
        pedigree,
        provider: "huggingface",
        quantization,
        variants,
        runtime: metadata.cardData?.library_name,
        source: "local-huggingface-metadata",
        tags: ["huggingface", "model-repo", ...(metadata.cardData?.tags || [])],
      },
      modelOccurrenceLocation,
    );
    if (dependencyMap.has(modelId)) {
      dependencyMap.set(component["bom-ref"], dependencyMap.get(modelId));
      dependencyMap.delete(modelId);
    }
    for (const filePath of metadata.files) {
      appendOccurrence(
        component.evidence,
        relativeOccurrenceLocation(discoveryPath, filePath),
      );
    }
  }

  return buildAiInventoryResult(componentsByKey, new Map(), dependencyMap);
}

/**
 * Collect AI-related inventory from Python sources.
 *
 * @param {string} discoveryPath directory or file being analyzed
 * @param {Object} [options={}] collection options
 * @returns {{ components: Object[], dependencies: Object[], services: Object[] }} AI inventory
 */
export function collectPythonAiInventory(discoveryPath, options = {}) {
  return collectConfiguredTextAiInventory(
    discoveryPath,
    options,
    TEXT_AI_INVENTORY_CONFIGS.python,
  );
}

/**
 * Collect AI-related inventory from notebook sources.
 *
 * @param {string} discoveryPath directory or file being analyzed
 * @param {Object} [options={}] collection options
 * @returns {{ components: Object[], dependencies: Object[], services: Object[] }} AI inventory
 */
export function collectNotebookAiInventory(discoveryPath, options = {}) {
  return collectConfiguredTextAiInventory(
    discoveryPath,
    options,
    TEXT_AI_INVENTORY_CONFIGS.notebook,
  );
}

/**
 * Collect AI-related inventory from prompt and agent configuration files.
 *
 * @param {string} discoveryPath directory or file being analyzed
 * @param {Object} [options={}] collection options
 * @returns {{ components: Object[], dependencies: Object[], services: Object[] }} AI inventory
 */
export function collectPromptConfigAiInventory(discoveryPath, options = {}) {
  return collectConfiguredTextAiInventory(
    discoveryPath,
    options,
    TEXT_AI_INVENTORY_CONFIGS.promptConfig,
  );
}
