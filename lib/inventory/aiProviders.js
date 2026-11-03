/**
 * Organisations that create AI models, keyed by the short creator id cdxgen
 * uses internally. The value is the full organisation name written to the
 * `manufacturer` of a model component, since the minimum elements guidance
 * asks for full names rather than acronyms or product names.
 */
export const MODEL_CREATOR_NAMES = new Map([
  ["alibaba", "Alibaba Cloud"],
  ["anthropic", "Anthropic"],
  ["cohere", "Cohere"],
  ["deepseek", "DeepSeek"],
  ["google", "Google"],
  ["meta", "Meta"],
  ["mistral", "Mistral AI"],
  ["openai", "OpenAI"],
  ["xai", "xAI"],
  ["zhipu", "Zhipu AI"],
]);

/**
 * Providers that are a creator's own SDK or API, mapped to that creator.
 * Hosting, routing and local providers such as groq, together, fireworks,
 * openrouter, replicate, aws-bedrock, azure-openai, vertex-ai, huggingface
 * and ollama serve models other organisations made, so they are absent.
 */
const CREATOR_OWN_PROVIDERS = new Map([
  ["anthropic", "anthropic"],
  ["cohere", "cohere"],
  ["dashscope", "alibaba"],
  ["deepseek", "deepseek"],
  ["gemini", "google"],
  ["google", "google"],
  ["meta", "meta"],
  ["mistral", "mistral"],
  ["openai", "openai"],
  ["xai", "xai"],
  ["zhipu", "zhipu"],
]);

// Creators whose own API serves only the models they made, so any model
// called through that API is theirs even when its name is not recognised.
// OpenAI-compatible clients, Google (Vertex Model Garden) and DashScope also
// serve models from other creators, so they are not in this set.
const SINGLE_CATALOGUE_CREATORS = new Set([
  "anthropic",
  "cohere",
  "deepseek",
  "mistral",
  "xai",
  "zhipu",
]);

/**
 * Local runtimes and inference servers. They serve whatever tag or served
 * model name the user chose, so a model they run names no creator.
 */
export const LOCAL_MODEL_RUNTIMES = new Set([
  "gpt4all",
  "jan",
  "llama.cpp",
  "llamafile",
  "lm-studio",
  "local",
  "local-inference",
  "mlc",
  "ollama",
  "vllm",
  "xinference",
]);

// Provider prefixes of model routes such as the litellm `groq/llama3-8b`
// form, mapped to the provider the route names. Matching is case-sensitive
// because the routes are lowercase while some Hugging Face organisations
// share the name in another case (Groq, Anthropic, Cohere). Prefixes that are
// also real lowercase Hub organisations (openai, google, databricks,
// cerebras, huggingface) are left out.
const MODEL_ROUTE_PROVIDERS = new Map([
  ["anthropic", "anthropic"],
  ["azure", "azure-openai"],
  ["azure_ai", "azure-ai"],
  ["bedrock", "aws-bedrock"],
  ["codestral", "mistral"],
  ["cohere", "cohere"],
  ["cohere_chat", "cohere"],
  ["dashscope", "dashscope"],
  ["deepseek", "deepseek"],
  ["fireworks_ai", "fireworks"],
  ["friendliai", "friendliai"],
  ["gemini", "gemini"],
  ["groq", "groq"],
  ["hosted_vllm", "vllm"],
  ["llamafile", "llamafile"],
  ["lm_studio", "lm-studio"],
  ["mistral", "mistral"],
  ["moonshot", "moonshot"],
  ["nvidia_nim", "nvidia-nim"],
  ["ollama", "ollama"],
  ["ollama_chat", "ollama"],
  ["openrouter", "openrouter"],
  ["perplexity", "perplexity"],
  ["replicate", "replicate"],
  ["sagemaker", "aws-sagemaker"],
  ["sambanova", "sambanova"],
  ["together_ai", "together"],
  ["vertex_ai", "vertex-ai"],
  ["watsonx", "watsonx"],
  ["xai", "xai"],
  ["xinference", "xinference"],
]);

// Google API resource collections that hold a model name, as in
// `models/gemini-1.5-flash` or `tunedModels/my-model`.
const GOOGLE_MODEL_COLLECTIONS = new Set(["models", "tunedModels"]);

// Model name prefixes that only one creator publishes under. A prefix, not a
// substring, so a community fine-tune such as openhermes-2.5-mistral-7b is
// not credited to Mistral AI. The OpenAI entries name its model lines,
// because a bare gpt prefix also covers open-weight families from other
// creators (gpt-j, gpt-neo, gpt-neox, gpt-sw3, gpt4all).
const MODEL_NAME_CREATOR_PREFIXES = [
  ["chatgpt", "openai"],
  ["claude", "anthropic"],
  ["codestral", "mistral"],
  ["command-r", "cohere"],
  ["dall-e", "openai"],
  ["deepseek", "deepseek"],
  ["gemini", "google"],
  ["gemma", "google"],
  ["glm", "zhipu"],
  ["gpt-3", "openai"],
  ["gpt-4", "openai"],
  ["gpt-5", "openai"],
  ["gpt-audio", "openai"],
  ["gpt-image", "openai"],
  ["gpt-oss", "openai"],
  ["gpt-realtime", "openai"],
  ["gpt2", "openai"],
  ["grok", "xai"],
  ["llama", "meta"],
  ["meta-llama", "meta"],
  ["mistral", "mistral"],
  ["mixtral", "mistral"],
  ["qwen", "alibaba"],
  ["text-embedding-3", "openai"],
  ["text-embedding-ada", "openai"],
];

// Spellings of a creator's name, compared after lowercasing and dropping
// everything but letters and digits. They cover the creator ids, the full
// names, the creators' own Hugging Face organisations and the way GGUF
// converters write general.organization ("Meta Llama", "Mistralai").
const MODEL_CREATOR_ALIASES = new Map([
  ["alibaba", "alibaba"],
  ["alibabacloud", "alibaba"],
  ["qwen", "alibaba"],
  ["anthropic", "anthropic"],
  ["cohere", "cohere"],
  ["cohereforai", "cohere"],
  ["coherelabs", "cohere"],
  ["deepseek", "deepseek"],
  ["deepseekai", "deepseek"],
  ["google", "google"],
  ["googledeepmind", "google"],
  ["facebook", "meta"],
  ["meta", "meta"],
  ["metallama", "meta"],
  ["mistral", "mistral"],
  ["mistralai", "mistral"],
  ["openai", "openai"],
  ["xai", "xai"],
  ["xaiorg", "xai"],
  ["thudm", "zhipu"],
  ["zaiorg", "zhipu"],
  ["zhipu", "zhipu"],
  ["zhipuai", "zhipu"],
]);

const normalizeProviderId = (provider) =>
  typeof provider === "string" ? provider.trim().toLowerCase() : "";

const aliasKey = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/gu, "");

/**
 * Split a model reference written in source code into the route provider it
 * names, if any, and the model name a creator lookup should read.
 *
 * `groq/llama3-8b-8192` names the groq route and the model `llama3-8b-8192`.
 * `models/gemini-1.5-flash`, `tunedModels/x` and
 * `projects/p/locations/l/publishers/google/models/gemini-1.5-pro` are Google
 * API resource names, and the model is the part after the last `models`
 * segment. Neither form is a Hugging Face repository id.
 *
 * @param {string} modelId Model reference as written in the source
 * @returns {{ name: string, nonHub: boolean, route?: string, routeProvider?: string }}
 *   The model name, whether the reference is not a Hub repository id, and the
 *   route and its provider when one is named
 */
export function splitModelReference(modelId) {
  const value = String(modelId || "").trim();
  const segments = value.split("/");
  if (segments.length < 2 || segments.some((segment) => !segment)) {
    return { name: value, nonHub: false };
  }
  if (GOOGLE_MODEL_COLLECTIONS.has(segments[0])) {
    return { name: segments.slice(1).join("/"), nonHub: true };
  }
  const publishersIndex = segments.indexOf("publishers");
  const modelsIndex = segments.lastIndexOf("models");
  if (publishersIndex >= 0 && modelsIndex > publishersIndex) {
    return { name: segments.slice(modelsIndex + 1).join("/"), nonHub: true };
  }
  const routeProvider = MODEL_ROUTE_PROVIDERS.get(segments[0]);
  if (routeProvider) {
    return {
      name: segments.slice(1).join("/"),
      nonHub: true,
      route: segments[0],
      routeProvider,
    };
  }
  return { name: value, nonHub: false };
}

/**
 * Name the creator of a model from its name alone, when only one creator
 * publishes under that name.
 *
 * @param {string} modelName Model name without route or namespace
 * @returns {string|undefined} Creator id
 */
export function modelCreatorFromName(modelName) {
  const normalized = String(modelName || "")
    .trim()
    .toLowerCase();
  for (const [prefix, creator] of MODEL_NAME_CREATOR_PREFIXES) {
    if (normalized.startsWith(prefix)) {
      return creator;
    }
  }
  return /^o[134](?:$|[-:])/u.test(normalized) ? "openai" : undefined;
}

/**
 * Resolve a creator spelling, such as a Hugging Face organisation or a
 * GGUF general.organization value, to a known creator id.
 *
 * @param {string} name Organisation name or namespace
 * @returns {string|undefined} Creator id, or undefined when unknown
 */
export function modelCreatorFromOrganization(name) {
  return MODEL_CREATOR_ALIASES.get(aliasKey(name));
}

/**
 * Pick the creator of a model that source code calls by name.
 *
 * The provider of such a model is the SDK, AI host or route the code uses,
 * which names the client rather than the model: the openai SDK is the usual
 * client for self-hosted Llama or DeepSeek servers, and a file may use
 * several SDKs. So the creator is the one the model name names, when the
 * provider is that creator, is a hosting or routing service, or the file
 * also uses the creator's own SDK or host. A different creator's SDK leaves
 * it unset. A model name that names no creator is credited only to a
 * provider whose own API serves nothing but its own models. A local runtime
 * serves whatever tag the user created, so it names no creator, and neither
 * does a file that only uses a local runtime.
 *
 * @param {string} modelId Model reference as written in the source
 * @param {{ provider?: string, fileProviders?: Iterable<string>, runtimes?: Iterable<string> }} [context]
 *   The provider the code declares through an SDK import, AI host or dosai
 *   report (never a guess from the model name), every provider the file
 *   references, and the runtimes it uses
 * @returns {string|undefined} Creator id
 */
export function resolveModelCreator(modelId, context = {}) {
  const reference = splitModelReference(modelId);
  const provider = normalizeProviderId(
    reference.routeProvider || context.provider,
  );
  if (LOCAL_MODEL_RUNTIMES.has(provider)) {
    return undefined;
  }
  if (
    !provider &&
    [...(context.runtimes || [])].some((runtime) =>
      LOCAL_MODEL_RUNTIMES.has(normalizeProviderId(runtime)),
    )
  ) {
    return undefined;
  }
  const nameCreator = modelCreatorFromName(reference.name);
  const providerCreator = CREATOR_OWN_PROVIDERS.get(provider);
  if (!nameCreator) {
    return SINGLE_CATALOGUE_CREATORS.has(providerCreator)
      ? providerCreator
      : undefined;
  }
  if (!providerCreator || providerCreator === nameCreator) {
    return nameCreator;
  }
  for (const fileProvider of context.fileProviders || []) {
    if (
      CREATOR_OWN_PROVIDERS.get(normalizeProviderId(fileProvider)) ===
      nameCreator
    ) {
      return nameCreator;
    }
  }
  return undefined;
}

/**
 * Build the CycloneDX organisational entity for a creator id.
 *
 * @param {string} creator Creator id
 * @returns {{ name: string }|undefined} Manufacturer entity
 */
export function modelCreatorEntity(creator) {
  const name = MODEL_CREATOR_NAMES.get(creator);
  return name ? { name } : undefined;
}
