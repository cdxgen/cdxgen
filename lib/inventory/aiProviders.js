/**
 * Providers that create the models they serve, so the provider name can
 * stand for the model producer (the supplier of an AI SBOM model
 * component). Hosting, routing and local runtimes such as ollama, groq,
 * together, fireworks, openrouter, replicate, aws-bedrock, azure-openai,
 * huggingface and local serve models other organisations made, so they are
 * not producers and leave the supplier unset.
 */
export const MODEL_CREATOR_PROVIDERS = new Set([
  "anthropic",
  "cohere",
  "dashscope",
  "deepseek",
  "gemini",
  "google",
  "meta",
  "mistral",
  "openai",
  "xai",
  "zhipu",
]);

/**
 * Return the provider name when the provider is a first-party model creator.
 *
 * @param {string} provider Provider name reported by a collector
 * @returns {string|undefined} The trimmed provider name, or undefined for a
 *   hosting, routing or local provider
 */
export function modelCreatorSupplierName(provider) {
  if (typeof provider !== "string") {
    return undefined;
  }
  const name = provider.trim();
  return MODEL_CREATOR_PROVIDERS.has(name.toLowerCase()) ? name : undefined;
}
