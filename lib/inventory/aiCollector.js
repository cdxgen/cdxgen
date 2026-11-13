import { lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";

import {
  readRegularTextFile,
  readScanFileText,
  realPathWithin,
} from "../core/boundedFile.js";
import { getAllFiles } from "../core/fs.js";
import {
  sanitizeBomEndpointUrl,
  sanitizeBomPropertyValue,
  sanitizeBomUrl,
  sanitizeStructuredValueForBom,
} from "../core/propertySanitizer.js";
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
import {
  normalizeHuggingFaceReference,
  quantizationValueFromConfig,
  repositoryUrlForHuggingFaceAssetType,
  toHuggingFaceAssetUrl,
  toHuggingFacePurl,
  toHuggingFaceSupplier,
} from "../parsers/huggingfaceUtils.js";
import { parseOllamaModelfile } from "../parsers/ollama.js";
import { readOnnxHeader } from "../parsers/onnx.js";
import { readSafetensorsHeader } from "../parsers/safetensors.js";
import {
  detectAiModelVariants,
  normalizeDetectedVariants,
} from "./aiModelVariants.js";
import {
  modelCreatorEntity,
  modelCreatorFromOrganization,
  resolveModelCreator,
  splitModelReference,
} from "./aiProviders.js";
import { getLicenses } from "./spdx.js";

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
const SAFETENSORS_PATTERNS = ["**/*.safetensors"];
const ONNX_PATTERNS = ["**/*.onnx"];
// PyTorch pickle-based checkpoints. Loading these executes arbitrary code, so
// they are inventoried and flagged rather than parsed. The `.pth` extension is
// intentionally excluded: in the wild it is overwhelmingly the Python
// path-configuration file (site-packages shims), not a PyTorch checkpoint.
const PICKLE_MODEL_PATTERNS = ["**/*.{bin,pt,ckpt}"];
// Directories whose contents are never real model artifacts. Filtering these
// keeps the expensive `**/*.bin` walk from surfacing dependency payloads.
const MODEL_ARTIFACT_IGNORE_DIRS = [
  "site-packages",
  "node_modules",
  "vendor",
  "dist-packages",
  ".venv",
  "venv",
];
// A real checkpoint is not a few bytes. Anything smaller is a shim or stub.
const MIN_PICKLE_MODEL_BYTES = 4096;

/**
 * Whether a discovered artifact path sits inside a dependency payload
 * directory. Weights vendored under a dependency tree belong to that
 * dependency, not to the project being scanned.
 *
 * @param {string} filePath Discovered file path
 * @returns {boolean} true when the path should be skipped
 */
const isVendoredArtifactPath = (filePath) => {
  const normalized = String(filePath).replaceAll("\\", "/");
  return MODEL_ARTIFACT_IGNORE_DIRS.some((segment) =>
    normalized.includes(`/${segment}/`),
  );
};
const GGUF_MIN_ALIGNMENT = 4;
const GGUF_MAX_ALIGNMENT = 1024 * 1024;
// Tested against full paths. The config exceptions follow IGNORE_FILE_PATTERN
// in analyzer.js, with the app exception anchored to a path separator instead
// of the start of a file name.
const IGNORE_SOURCE_FILE_PATTERN =
  /(^|\/|\\)(__tests__|fixtures?|examples?|samples?)($|\/|\\)|(^|\/|\\)(test|spec|mock|setup-jest|conftest|sitecustomize)\.([cm]?[jt]sx?|py)$|(?<!vite\.|vue\.|svelte\.|astro\.|(?:^|\/|\\)app\.)(conf|config)\.[cm]?[jt]sx?$/iu;
const HOST_PROVIDER_PATTERNS = [
  ["openai", /(?:^|\.)openai\.com$/iu],
  ["anthropic", /(?:^|\.)anthropic\.com$/iu],
  // Only the Gemini API host. Other googleapis.com hosts serve Cloud Storage,
  // Vertex AI (matched below) and unrelated Google APIs.
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
  // Regional Vertex AI endpoints join the region with a hyphen, as in
  // us-central1-aiplatform.googleapis.com.
  ["vertex-ai", /(?:^|[.-])aiplatform\.googleapis\.com$/iu],
  ["xai", /(?:^|\.)x\.ai$/iu],
  [
    "aws-bedrock",
    /(?:^|\.)bedrock(?:-runtime)?(?:\.[a-z0-9-]+)?\.amazonaws\.com$/iu,
  ],
  ["openrouter", /(?:^|\.)openrouter\.ai$/iu],
  ["cerebras", /(?:^|\.)cerebras\.ai$/iu],
  ["sambanova", /(?:^|\.)sambanova\.ai$/iu],
  ["moonshot", /(?:^|\.)moonshot\.(?:cn|ai)$/iu],
  ["zhipu", /(?:^|\.)bigmodel\.cn$/iu],
  ["dashscope", /(?:^|\.)dashscope(?:-intl)?\.aliyuncs\.com$/iu],
  ["nvidia-nim", /(?:^|\.)api\.nvidia\.com$/iu],
  ["baseten", /(?:^|\.)baseten\.co$/iu],
  ["novita", /(?:^|\.)novita\.ai$/iu],
  ["deepinfra", /(?:^|\.)deepinfra\.com$/iu],
  ["ollama", /(?:^|\.)ollama\.com$/iu],
];
// Local inference servers are distinguished by their conventional loopback
// port rather than by hostname, since they all bind to localhost. When the
// port is unknown, the endpoint is labeled `local-inference` and marked for
// review instead of being guessed as any single tool.
const LOCAL_INFERENCE_PORTS = new Map([
  ["1234", "lm-studio"],
  ["8000", "vllm"],
  ["8080", "llamafile"],
  ["1337", "jan"],
  ["4891", "gpt4all"],
  ["11434", "ollama"],
]);
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
    pattern: /^cohere-ai$|^cohere$/u,
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
  // Agent frameworks and SDKs from the 2025-2026 wave. These identify the
  // orchestration layer a project builds on, which is often more meaningful for
  // an AI-BOM than the underlying provider SDK alone. Patterns accept both the
  // registry package name (hyphenated) and the imported module name
  // (underscored) because Python import statements normalize hyphens to
  // underscores.
  {
    pattern:
      /^claude[-_]agent[-_]sdk$|^@anthropic-ai\/claude-agent-sdk$|^claude[-_]code[-_]sdk$/u,
    framework: "claude-agent-sdk",
    provider: "anthropic",
    serviceName: "Anthropic API",
  },
  { pattern: /^google[-_]adk$|^@google\/adk$/u, framework: "google-adk" },
  {
    pattern: /^pydantic[-_]ai(?:[-_]slim)?$|^pydantic[-_]graph$/u,
    framework: "pydantic-ai",
  },
  {
    pattern: /^strands[-_]agents(?:[-_]tools|[-_]builder)?$/u,
    framework: "strands-agents",
  },
  { pattern: /^agno$|^phidata$/u, framework: "agno" },
  {
    pattern:
      /^agent[-_]framework(?:[-_]core|[-_]azure[-_]ai|[-_]copilotstudio)?$/u,
    framework: "microsoft-agent-framework",
  },
  { pattern: /^semantic[-_]kernel$/u, framework: "semantic-kernel" },
  { pattern: /^deepagents$/u, framework: "deepagents" },
  {
    pattern: /^smolagents$/u,
    framework: "smolagents",
    provider: "huggingface",
  },
  { pattern: /^dspy(?:[-_]ai)?$/u, framework: "dspy" },
  { pattern: /^haystack[-_]ai$|^farm[-_]haystack$/u, framework: "haystack" },
  { pattern: /^instructor$/u, framework: "instructor" },
  { pattern: /^browser[-_]use$/u, framework: "browser-use" },
  {
    pattern: /^openai[-_]agents$/u,
    framework: "openai-agents",
    provider: "openai",
    serviceName: "OpenAI API",
  },
  { pattern: /^crewai(?:[-_]tools)?$/u, framework: "crewai" },
  // Note: OpenAI Swarm is intentionally not matched by a bare `swarm` name.
  // On npm/PyPI `swarm` refers to unrelated projects (Ethereum Swarm, Docker
  // Swarm tooling); OpenAI Swarm is installed from Git, not under that name.
  // Provider SDKs and OpenAI-compatible gateway clients for the wider set of
  // inference providers now in common use.
  {
    pattern: /^@ai-sdk\/xai$|^langchain[-_]xai$|^xai[-_]sdk$/u,
    provider: "xai",
    serviceName: "xAI Grok API",
  },
  {
    pattern:
      /^@aws-sdk\/client-bedrock-runtime$|^langchain[-_]aws$|^@langchain\/aws$/u,
    provider: "aws-bedrock",
    serviceName: "AWS Bedrock",
  },
  {
    pattern: /^openrouter$|^@openrouter\/ai-sdk-provider$/u,
    provider: "openrouter",
    serviceName: "OpenRouter API",
  },
  {
    pattern:
      /^@cerebras\/cerebras[_-]cloud[_-]sdk$|^cerebras[-_]cloud[-_]sdk$/u,
    provider: "cerebras",
    serviceName: "Cerebras API",
  },
  {
    pattern: /^dashscope$/u,
    provider: "dashscope",
    serviceName: "Alibaba DashScope API",
  },
  { pattern: /^zhipuai$/u, provider: "zhipu", serviceName: "Zhipu GLM API" },
];
const serializeAiService = (service) => ({
  "bom-ref": service["bom-ref"],
  group: service.group,
  name: service.name,
  provider: service.provider,
  version: service.version,
  endpoints: Array.from(service.endpoints)
    .map((endpoint) => sanitizeBomEndpointUrl(endpoint))
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

// `import x from "y"`, `import "y"` and `require("y")`. The specifier list
// must start with a non-blank character and is followed by one blank before
// `from`, so a run of blanks is not tried once per position.
const QUOTED_IMPORT_PATTERN =
  /(?:import\s+(?:[^\s"'`].*?\sfrom\s+)?|require\(\s*)["'`]([^"'`]+)["'`]/uy;
// `from x import y` and `import x, y as z`.
const MODULE_IMPORT_PATTERN =
  /from\s+([A-Za-z0-9_.-]+)\s+import\b|import[ \t]+([A-Za-z0-9_.,\- \t]+)/uy;
// Blanks at the start of a line, without crossing into the next one.
const LINE_INDENT_PATTERN = /[^\S\n]*/uy;

/**
 * Find import statements that start a line, JavaScript and Python alike.
 * Each pattern is tried once, at the first non-blank character of each line,
 * so the work is linear in the size of the source.
 *
 * @param {string} raw Source text
 * @returns {{index: number, names: string[]}[]} Imported module names with
 *   the offset of their statement, quoted specifiers first
 */
const extractImportNames = (raw) => {
  const quotedImports = [];
  const moduleImports = [];
  let lineStart = 0;
  while (lineStart < raw.length) {
    const newline = raw.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? raw.length : newline;
    LINE_INDENT_PATTERN.lastIndex = lineStart;
    LINE_INDENT_PATTERN.exec(raw);
    const statementStart = LINE_INDENT_PATTERN.lastIndex;
    if (
      raw.startsWith("import", statementStart) ||
      raw.startsWith("require(", statementStart)
    ) {
      QUOTED_IMPORT_PATTERN.lastIndex = statementStart;
      const match = QUOTED_IMPORT_PATTERN.exec(raw);
      if (match) {
        quotedImports.push({ index: statementStart, names: [match[1]] });
      }
    }
    if (
      raw.startsWith("import", statementStart) ||
      raw.startsWith("from", statementStart)
    ) {
      MODULE_IMPORT_PATTERN.lastIndex = statementStart;
      const match = MODULE_IMPORT_PATTERN.exec(raw);
      const modules = !match
        ? []
        : match[1]
          ? [match[1]]
          : String(match[2] || "")
              .split(",")
              .map((entry) => entry.trim().split(/\sas\s/u)[0])
              .filter(Boolean);
      if (modules.length) {
        moduleImports.push({ index: statementStart, names: modules });
      }
    }
    lineStart = lineEnd + 1;
  }
  return quotedImports.concat(moduleImports);
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

// Locations already recorded on each occurrence target, so a target named
// many times is checked in constant time per mention. The index is rebuilt
// when the list was changed without it.
const occurrenceLocations = new WeakMap();

const appendOccurrenceEntry = (target, occurrence) => {
  target.occurrences = target.occurrences || [];
  let index = occurrenceLocations.get(target);
  if (!index || index.count !== target.occurrences.length) {
    index = {
      count: target.occurrences.length,
      locations: new Set(target.occurrences.map((entry) => entry.location)),
    };
    occurrenceLocations.set(target, index);
  }
  if (!index.locations.has(occurrence.location)) {
    index.locations.add(occurrence.location);
    target.occurrences.push(occurrence);
    index.count += 1;
  }
};

const appendOccurrence = (target, location) =>
  appendOccurrenceEntry(target, { location });

const DETECTED_VARIANTS_NOTE_PREFIX = "Detected variants: ";

const mergePedigreeVariants = (pedigree, variants = []) => {
  const normalizedVariants = normalizeDetectedVariants(variants);
  if (!pedigree && !normalizedVariants.length) {
    return pedigree;
  }
  const nextPedigree = pedigree ? { ...pedigree } : {};
  // Notes hold "; "-separated entries. The variants of every sighting are
  // folded into the one "Detected variants" entry, so the notes stay the same
  // size however often a model is mentioned.
  const notes = nextPedigree.notes
    ? String(nextPedigree.notes).split("; ")
    : [];
  const variantNoteIndex = notes.findIndex((note) =>
    note.startsWith(DETECTED_VARIANTS_NOTE_PREFIX),
  );
  const mergedVariants = normalizeDetectedVariants([
    ...(variantNoteIndex === -1
      ? []
      : notes[variantNoteIndex]
          .slice(DETECTED_VARIANTS_NOTE_PREFIX.length)
          .split(", ")),
    ...normalizedVariants,
  ]);
  if (mergedVariants.length) {
    const variantNote = `${DETECTED_VARIANTS_NOTE_PREFIX}${mergedVariants.join(", ")}`;
    if (variantNoteIndex === -1) {
      notes.push(variantNote);
    } else {
      notes[variantNoteIndex] = variantNote;
    }
  }
  if (notes.length) {
    nextPedigree.notes = [...new Set(notes)].join("; ");
  }
  return Object.keys(nextPedigree).length ? nextPedigree : undefined;
};

// Line starts of the text last numbered. Callers number many matches of one
// file in a row, so the table is built once per file and each lookup is a
// binary search.
let lineStartsText;
let lineStarts = [0];

const lineNumberForIndex = (text, index) => {
  if (text !== lineStartsText) {
    lineStartsText = text;
    lineStarts = [0];
    let newline = text.indexOf("\n");
    while (newline !== -1) {
      lineStarts.push(newline + 1);
      newline = text.indexOf("\n", newline + 1);
    }
  }
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (lineStarts[middle] <= index) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low + 1;
};

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
    const hostMatch = HOST_PROVIDER_PATTERNS.find(([, pattern]) =>
      pattern.test(parsed.hostname),
    )?.[0];
    if (hostMatch) {
      return hostMatch;
    }
    // Local inference servers all bind to loopback, so disambiguate by the
    // conventional port. An unknown local port is labeled generically rather
    // than guessed as Ollama.
    if (isLocalAiHostname(parsed.hostname)) {
      return LOCAL_INFERENCE_PORTS.get(parsed.port) || "local-inference";
    }
    return undefined;
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

// The largest source, model card, Modelfile or JSON configuration read.
const MAX_AI_TEXT_FILE_BYTES = 8 * 1024 * 1024;

/**
 * Read a text file the AI inventory matched. It must resolve inside the scan
 * root, links included, be a regular file and be no larger than
 * MAX_AI_TEXT_FILE_BYTES. A file given as the scan path itself has no root
 * and is read wherever its own links lead.
 *
 * @param {string} filePath Matched path
 * @param {string} [rootDir] Scan root; undefined for a file scanned directly
 * @returns {string|undefined} The text, or undefined
 */
const readAiTextFile = (filePath, rootDir) => {
  if (rootDir) {
    return readScanFileText(filePath, MAX_AI_TEXT_FILE_BYTES, rootDir);
  }
  try {
    return readRegularTextFile(realpathSync(filePath), MAX_AI_TEXT_FILE_BYTES);
  } catch {
    return undefined;
  }
};

/**
 * The root the reads of one scan stay inside: the scanned directory, or none
 * when a single file was given.
 *
 * @param {string} discoveryPath Scan path
 * @returns {string|undefined} The root
 */
const scanRootOf = (discoveryPath) =>
  isDirectDiscoveryFile(discoveryPath) ? undefined : discoveryPath;

/**
 * Whether a file found under the scan root resolves inside it. A link that
 * stays inside is kept, such as a Hugging Face snapshot file that links to
 * ../../blobs in a scanned cache or model directory; one that leads out is
 * not, so neither its text nor its model header is read.
 *
 * @param {string} filePath Matched path
 * @param {string} discoveryPath Scan root
 * @returns {boolean} True when the file stays inside
 */
const keepInsideScan = (filePath, discoveryPath) =>
  Boolean(realPathWithin(filePath, discoveryPath));

const parseJsonObject = (filePath, rootDir) => {
  const text = readAiTextFile(filePath, rootDir);
  if (text === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(text);
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

// Quantization methods that are distinct from the container format. These often
// appear in a model or file name and are useful for hardware-fit review.
const QUANTIZATION_METHOD_PATTERNS = [
  ["gptq", /\bgptq\b/iu],
  ["awq", /\bawq\b/iu],
  ["exl2", /\bexl2\b/iu],
  ["exl3", /\bexl3\b/iu],
  ["aqlm", /\baqlm\b/iu],
  // Marlin is a GPTQ/AWQ kernel that appears as a suffix (gptq-marlin) or a
  // quant_method value, so require that shape rather than the bare word, which
  // is also an ordinary name.
  ["marlin", /(?:gptq|awq)[-_]?marlin|[-_]marlin\b|^marlin$/iu],
  ["bitsandbytes", /\bbnb\b|bitsandbytes/iu],
];

/**
 * Detect a non-GGUF quantization method from a model name, file name, or an
 * explicit `quantization_config.quant_method` value.
 *
 * @param {string} candidate Model name, file name, or quant method string
 * @returns {string|undefined} Normalized quantization method label
 */
const quantizationMethodFromText = (candidate) => {
  const normalized = String(candidate || "");
  if (!normalized) {
    return undefined;
  }
  for (const [method, pattern] of QUANTIZATION_METHOD_PATTERNS) {
    if (pattern.test(normalized)) {
      return method;
    }
  }
  return undefined;
};

// Matches the Hugging Face sharded-weights suffix, e.g.
// `model-00001-of-00003.safetensors`. Grouping by the de-sharded stem lets a
// multi-file checkpoint be modeled as one component instead of one per shard.
const SAFETENSORS_SHARD_PATTERN = /-\d{5}-of-\d{5}$/u;

/**
 * Compute the de-sharded model stem for a safetensors file name.
 *
 * @param {string} fileName safetensors base name (without extension)
 * @returns {{ stem: string, isShard: boolean }} de-sharded stem and shard flag
 */
const deshardedStem = (fileName) => {
  const isShard = SAFETENSORS_SHARD_PATTERN.test(fileName);
  return {
    stem: fileName.replace(SAFETENSORS_SHARD_PATTERN, ""),
    isShard,
  };
};

/**
 * Read the model identity a sibling `config.json` declares, when present, so a
 * safetensors artifact attaches to the repository model rather than a filename.
 *
 * @param {string} directoryPath Directory containing the safetensors file
 * @param {string} [rootDir] Scan root the config must resolve inside
 * @returns {string|undefined} Model identity from `_name_or_path`
 */
const modelIdentityFromSiblingConfig = (directoryPath, rootDir) => {
  const config = parseJsonObject(join(directoryPath, "config.json"), rootDir);
  const nameOrPath = config?._name_or_path;
  if (typeof nameOrPath === "string" && nameOrPath.trim()) {
    return nameOrPath.trim();
  }
  return undefined;
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

const normalizeGgufAlignment = (value) => {
  const numericValue =
    typeof value === "string"
      ? (() => {
          const normalizedValue = value.trim();
          if (!/^\d+$/.test(normalizedValue)) {
            return Number.NaN;
          }
          return Number(normalizedValue);
        })()
      : Number(value);
  if (!Number.isInteger(numericValue)) {
    return undefined;
  }
  if (numericValue < GGUF_MIN_ALIGNMENT || numericValue > GGUF_MAX_ALIGNMENT) {
    return undefined;
  }
  return numericValue;
};

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
    normalizeGgufAlignment(metadata["general.alignment"]),
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
        IGNORE_SOURCE_FILE_PATTERN.test(normalizedFilePath) ||
        !keepInsideScan(filePath, discoveryPath)
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
      if (keepInsideScan(filePath, discoveryPath)) {
        files.add(filePath);
      }
    }
  }
  return Array.from(files).sort();
};

/**
 * Keep one path per model artifact file. Symbolic and hard links to a file
 * name the same bytes, and reading and reporting each of them would multiply
 * the work and the BOM by the number of links. A path that is not a symbolic
 * link is kept over a link to the same file; otherwise the first path in
 * order is kept. A path that cannot be stat'ed, such as a dangling link, is
 * dropped, and a file system that reports no inode keeps every path. Call it
 * after a loop's own filters, so a second name the loop would skip never
 * hides the one it keeps.
 *
 * @param {string[]} filePaths Matched paths that passed the loop's filters
 * @returns {string[]} Paths with one entry per file, sorted
 */
const uniqueArtifactFiles = (filePaths) => {
  const chosenByFile = new Map();
  for (const filePath of filePaths) {
    let key;
    let isLink;
    try {
      const stats = statSync(filePath, { bigint: true });
      key = stats.ino ? `${stats.dev}:${stats.ino}` : `path:${filePath}`;
      isLink = lstatSync(filePath).isSymbolicLink();
    } catch {
      continue;
    }
    const chosen = chosenByFile.get(key);
    if (!chosen || (chosen.isLink && !isLink)) {
      chosenByFile.set(key, { filePath, isLink });
    }
  }
  return Array.from(chosenByFile.values(), (entry) => entry.filePath).sort();
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

// Longest producer name a model file may declare about itself.
const MAX_DECLARED_PRODUCER_LENGTH = 128;

/**
 * Trim and bound a producer name a model file declares about itself, such as
 * the GGUF general.organization field. The value is file-controlled free text.
 *
 * @param {unknown} value Declared producer
 * @returns {string|undefined} Usable producer name
 */
const declaredProducerName = (value) => {
  if (typeof value !== "string") {
    return undefined;
  }
  const name = value.trim();
  if (!name || name.length > MAX_DECLARED_PRODUCER_LENGTH) {
    return undefined;
  }
  return name;
};

/**
 * Build the manufacturer of a model, the organisation that created it.
 *
 * A producer the model file declares about itself wins, written with the
 * creator's full name when it is a known creator and as declared otherwise.
 * A Hub repository credits its namespace only when the namespace is the
 * creator's own organisation (meta-llama, mistralai, Qwen), because
 * re-packagers such as TheBloke, unsloth or mlx-community publish models
 * other organisations made. A model that source code calls by name uses the
 * creator id the caller resolved.
 *
 * @param {{ hubNamespace?: string, modelCreator?: string, producer?: unknown }} sources
 *   Creator evidence for the model
 * @returns {{ name: string }|undefined} Manufacturer entity
 */
const modelManufacturer = ({ hubNamespace, modelCreator, producer }) => {
  const declared = declaredProducerName(producer);
  if (declared) {
    return (
      modelCreatorEntity(modelCreatorFromOrganization(declared)) || {
        name: declared,
      }
    );
  }
  if (hubNamespace) {
    return modelCreatorEntity(modelCreatorFromOrganization(hubNamespace));
  }
  return modelCreatorEntity(modelCreator);
};

const normalizeComponentIdentity = ({
  assetType,
  modelCreator,
  modelId,
  producer,
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
  // A litellm route such as groq/llama3-8b or a Google resource name such as
  // models/gemini-1.5-flash has the shape of a Hub repository id but is not
  // one, so its first segment is never taken as a Hub namespace.
  const repoId =
    normalizedAssetType === "model" &&
    splitModelReference(normalizedModelId).nonHub
      ? undefined
      : normalizeHuggingFaceReference(typedModelId);
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
    // The Hub namespace is the account that published the repository, so it
    // is the supplier. Its Hub page is the supplier url only when the model
    // came from the Hub; a routed id such as meta-llama/Llama-3-70b on
    // together keeps the name.
    const hubSupplier = toHuggingFaceSupplier(group);
    return {
      bomRef: purl,
      group,
      manufacturer:
        normalizedAssetType === "model"
          ? modelManufacturer({ hubNamespace: group, producer })
          : undefined,
      name,
      purl,
      supplier:
        hubSupplier && normalizedProvider.toLowerCase() !== "huggingface"
          ? { name: hubSupplier.name }
          : hubSupplier,
    };
  }
  return {
    bomRef: stableAiBomRef(
      normalizedAssetType,
      normalizedProvider,
      normalizedModelId,
    ),
    group: normalizedProvider,
    // Hosting, routing and local providers stay in group and
    // cdx:ai:provider; only the creator is the manufacturer.
    manufacturer:
      normalizedAssetType === "model"
        ? modelManufacturer({ modelCreator, producer })
        : undefined,
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
      // The organisation that created the model is the manufacturer. The
      // Hugging Face namespace that published the repository is the
      // supplier.
      manufacturer: identity.manufacturer,
      supplier: identity.supplier,
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
  if (data.quantizationMethod) {
    addUniqueProperty(
      component.properties,
      "cdx:ai:quantizationMethod",
      data.quantizationMethod,
    );
  }
  if (data.unsafeDeserialization) {
    addUniqueProperty(
      component.properties,
      "cdx:ai:unsafeDeserialization",
      "true",
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

// A plausible model id: 2-160 characters with no whitespace, starting with an
// alphanumeric (or the `@` of a scoped id such as Cloudflare's `@cf/...`) and
// otherwise limited to name, scope, version, and registry punctuation.
// Markdown prose around an inline `` `model:` `` label fails these checks, so
// documentation such as "editing the `model:` field. Run `kiro-cli chat
// --list-models`" does not become a model.
const MODEL_ID_CHARS_PATTERN = /^@?[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/u;
const MODEL_ID_MIN_LENGTH = 2;
const MODEL_ID_MAX_LENGTH = 160;

const isPlausibleModelId = (value) => {
  const normalized = String(value || "").trim();
  return (
    normalized.length >= MODEL_ID_MIN_LENGTH &&
    normalized.length <= MODEL_ID_MAX_LENGTH &&
    MODEL_ID_CHARS_PATTERN.test(normalized)
  );
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
    if (!normalized || normalized.startsWith("http") || normalized === "auto") {
      return false;
    }
    return isPlausibleModelId(normalized);
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
    .filter(
      (entry) =>
        // URL-derived references are already anchored to a real host, while
        // quoted `repo_id`/`model` captures suffer the same backtick-as-quote
        // ambiguity as model assignments, so they must look like an id too.
        entry.sourceUrl ||
        (isPlausibleModelId(entry.value) &&
          !splitModelReference(entry.value).nonHub),
    )
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
  for (const occurrence of occurrences) {
    appendOccurrenceEntry(subject.evidence, occurrence);
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
  const isKnownComponent = componentsByKey.has(key);
  const component = ensureModelComponent(componentsByKey, key, seed);
  // The same model can be seen first in a file that names no creator and
  // later in one that does, so a later seed fills a missing manufacturer.
  if (isKnownComponent && !component.manufacturer) {
    const { manufacturer } = normalizeComponentIdentity(seed);
    if (manufacturer) {
      component.manufacturer = manufacturer;
    }
  }
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
    quantizationMethod: seed.quantizationMethod,
    reviewNeeded: seed.reviewNeeded,
    runtime: seed.runtime,
    source: seed.source,
    unsafeDeserialization: seed.unsafeDeserialization,
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
  const scanRoot = scanRootOf(discoveryPath);
  const componentsByKey = new Map();
  const servicesByKey = new Map();
  const dependencyMap = new Map();
  const sourceFiles = getSourceFiles(
    discoveryPath,
    config.patterns || [],
    options,
  );
  for (const filePath of sourceFiles) {
    const raw = readAiTextFile(filePath, scanRoot);
    if (raw === undefined) {
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
      // Only a provider the file declares through an SDK import or AI host
      // may agree with the creator. The fallback guessed from the model name
      // stays in group and cdx:ai:provider.
      const declaredProvider = Array.from(fileSignals.providers)[0];
      const provider =
        declaredProvider ||
        splitModelReference(modelId).routeProvider ||
        providerFromModelName(modelId);
      const component = createModelComponent(
        componentsByKey,
        {
          assetType: "model",
          confidence: "medium",
          kind: "model",
          modelCreator: resolveModelCreator(modelId, {
            fileProviders: fileSignals.providers,
            provider: declaredProvider,
            runtimes: fileSignals.runtimes,
          }),
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
  const scanRoot = scanRootOf(discoveryPath);
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
    const raw = readAiTextFile(filePath, scanRoot);
    if (raw === undefined) {
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
  for (const filePath of uniqueArtifactFiles(
    getMatchingFiles(discoveryPath, GGUF_PATTERNS, options),
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
        // general.organization is the creator the file declares, so it is
        // the manufacturer even when it is not a known creator.
        producer: metadata["general.organization"],
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

  const safetensorsGroups = new Map();
  for (const filePath of uniqueArtifactFiles(
    getMatchingFiles(discoveryPath, SAFETENSORS_PATTERNS, options).filter(
      (filePath) => !isVendoredArtifactPath(filePath),
    ),
  )) {
    const header = readSafetensorsHeader(filePath);
    if (!header) {
      continue;
    }
    const fileComponent = createAiFileComponent(
      componentsByKey,
      discoveryPath,
      filePath,
      "model-artifact-file",
      ["safetensors"],
    );
    addUniqueProperty(
      fileComponent.properties,
      "cdx:safetensors:tensorCount",
      header.tensorCount || undefined,
    );
    if (header.dtypes.length) {
      addUniqueProperty(
        fileComponent.properties,
        "cdx:safetensors:dtypes",
        header.dtypes.join(","),
      );
    }
    const directoryPath = dirname(filePath);
    const { stem, isShard } = deshardedStem(basename(filePath, ".safetensors"));
    // Group shards of the same checkpoint (and co-located single files) so a
    // multi-file model is one component. The sibling config identity, when
    // present, keeps the group aligned with the model the HF parser found.
    const groupKey = `${directoryPath}::${stem}`;
    let group = safetensorsGroups.get(groupKey);
    if (!group) {
      group = {
        directoryPath,
        stem,
        isShard,
        // The first matching file on the sorted discovery list. Occurrence
        // evidence must point at a path that exists, so a sharded group cites
        // its first shard rather than a synthesized `<stem>.safetensors`.
        firstFilePath: filePath,
        fileRefs: [],
        totalParameters: 0,
        dtypes: new Set(),
        quantMethod: undefined,
      };
      safetensorsGroups.set(groupKey, group);
    }
    group.isShard = group.isShard || isShard;
    group.fileRefs.push(fileComponent["bom-ref"]);
    group.totalParameters += header.totalParameters || 0;
    for (const dtype of header.dtypes) {
      group.dtypes.add(dtype);
    }
    group.quantMethod =
      group.quantMethod ||
      quantizationMethodFromText(header.metadata?.quant_method) ||
      quantizationMethodFromText(basename(filePath));
  }
  // A directory can hold several distinct checkpoints (for example
  // `model.safetensors` alongside `adapter_model.safetensors`). They share one
  // sibling config.json, so resolve the config identity only for the group that
  // carries the primary weights and let the others keep their own stem.
  const groupsByDirectory = new Map();
  for (const group of safetensorsGroups.values()) {
    const peers = groupsByDirectory.get(group.directoryPath) || [];
    peers.push(group);
    groupsByDirectory.set(group.directoryPath, peers);
  }
  for (const group of safetensorsGroups.values()) {
    const peers = groupsByDirectory.get(group.directoryPath) || [];
    const isPrimaryGroup =
      peers.length === 1 ||
      group.stem === "model" ||
      group.stem === "pytorch_model" ||
      group.isShard;
    const siblingIdentity = isPrimaryGroup
      ? modelIdentityFromSiblingConfig(group.directoryPath, scanRoot)
      : undefined;
    const modelId = siblingIdentity || group.stem;
    const component = createModelComponent(
      componentsByKey,
      {
        artifactFormat: "safetensors",
        confidence: siblingIdentity ? "high" : "medium",
        modelFamily: modelFamilyFromName(modelId),
        modelId,
        parameterCount: group.totalParameters || undefined,
        provider: siblingIdentity?.includes("/") ? "huggingface" : "local",
        quantizationMethod: group.quantMethod,
        reviewNeeded: true,
        source: "local-artifact",
        tags: ["safetensors", "local-model"],
        variants: group.isShard ? ["sharded"] : undefined,
      },
      relativeOccurrenceLocation(discoveryPath, group.firstFilePath),
    );
    if (group.dtypes.size) {
      addUniqueProperty(
        component.properties,
        "cdx:safetensors:dtypes",
        Array.from(group.dtypes).sort().join(","),
      );
    }
    // Two groups can still resolve to the same model component (for example a
    // repository whose config identity matches its stem), so merge the artifact
    // edges instead of replacing them.
    const existingRefs = dependencyMap.get(component["bom-ref"]) || new Set();
    for (const fileRef of group.fileRefs) {
      existingRefs.add(fileRef);
    }
    dependencyMap.set(component["bom-ref"], existingRefs);
  }

  for (const filePath of uniqueArtifactFiles(
    getMatchingFiles(discoveryPath, ONNX_PATTERNS, options).filter(
      (filePath) => !isVendoredArtifactPath(filePath),
    ),
  )) {
    const fileComponent = createAiFileComponent(
      componentsByKey,
      discoveryPath,
      filePath,
      "model-artifact-file",
      ["onnx"],
    );
    const modelId = basename(filePath, ".onnx");
    const component = createModelComponent(
      componentsByKey,
      {
        artifactFormat: "onnx",
        confidence: "high",
        modelFamily: modelFamilyFromName(modelId),
        modelId,
        provider: "local",
        reviewNeeded: true,
        source: "local-artifact",
        tags: ["onnx", "local-model"],
      },
      relativeOccurrenceLocation(discoveryPath, filePath),
    );
    // The protobuf header is read by offset without loading the graph, so
    // producer and opset provenance is cheap even for large models.
    const onnxHeader = readOnnxHeader(filePath);
    if (onnxHeader) {
      if (onnxHeader.irVersion) {
        addUniqueProperty(
          component.properties,
          "cdx:onnx:irVersion",
          String(onnxHeader.irVersion),
        );
      }
      // Producer names are tool identifiers such as "pytorch"; they name the
      // exporter rather than any user or environment detail.
      if (onnxHeader.producerName) {
        addUniqueProperty(
          component.properties,
          "cdx:onnx:producer",
          onnxHeader.producerName,
        );
      }
      if (onnxHeader.producerVersion) {
        addUniqueProperty(
          component.properties,
          "cdx:onnx:producerVersion",
          onnxHeader.producerVersion,
        );
      }
      if (onnxHeader.opsets.length) {
        addUniqueProperty(
          component.properties,
          "cdx:onnx:opsets",
          onnxHeader.opsets
            .map((opset) => `${opset.domain || "ai.onnx"}:${opset.version}`)
            .join(","),
        );
      }
    }
    dependencyMap.set(
      fileComponent["bom-ref"],
      new Set([component["bom-ref"]]),
    );
  }

  // Only treat these as model artifacts when the name looks model-like and
  // the file is large enough to be a real checkpoint. Dependency payload
  // directories are skipped entirely.
  const isPickleModelArtifact = (filePath) => {
    if (isVendoredArtifactPath(filePath)) {
      return false;
    }
    if (
      !/(model|weights|pytorch|checkpoint|ckpt|adapter|lora|diffusion|embed)/u.test(
        basename(filePath).toLowerCase(),
      )
    ) {
      return false;
    }
    try {
      return statSync(filePath).size >= MIN_PICKLE_MODEL_BYTES;
    } catch {
      return false;
    }
  };
  for (const filePath of uniqueArtifactFiles(
    getMatchingFiles(discoveryPath, PICKLE_MODEL_PATTERNS, options).filter(
      isPickleModelArtifact,
    ),
  )) {
    const lowerName = basename(filePath).toLowerCase();
    const fileComponent = createAiFileComponent(
      componentsByKey,
      discoveryPath,
      filePath,
      "model-artifact-file",
      ["pytorch-pickle"],
    );
    const modelId = basename(filePath).replace(/\.[^.]+$/u, "");
    const component = createModelComponent(
      componentsByKey,
      {
        artifactFormat: "pytorch-pickle",
        confidence: "medium",
        modelFamily: modelFamilyFromName(modelId),
        modelId,
        provider: "local",
        quantizationMethod: quantizationMethodFromText(lowerName),
        reviewNeeded: true,
        source: "local-artifact",
        tags: ["pytorch", "pickle", "local-model"],
        // Loading a pickle checkpoint can execute arbitrary code; surface this
        // so security audit rules can flag untrusted model artifacts.
        unsafeDeserialization: true,
      },
      relativeOccurrenceLocation(discoveryPath, filePath),
    );
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
  const scanRoot = scanRootOf(discoveryPath);
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
    const raw = readAiTextFile(filePath, scanRoot);
    if (raw === undefined) {
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
    const config = parseJsonObject(filePath, scanRoot);
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
    const adapterConfig = parseJsonObject(filePath, scanRoot);
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
