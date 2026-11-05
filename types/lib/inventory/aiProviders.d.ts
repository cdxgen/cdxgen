/**
 * Organisations that create AI models, keyed by the short creator id cdxgen
 * uses internally. The value is the full organisation name written to the
 * `manufacturer` of a model component, since the minimum elements guidance
 * asks for full names rather than acronyms or product names.
 */
export declare const MODEL_CREATOR_NAMES: Map<string, string>;
/**
 * Local runtimes and inference servers. They serve whatever tag or served
 * model name the user chose, so a model they run names no creator.
 */
export declare const LOCAL_MODEL_RUNTIMES: Set<string>;
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
export declare function splitModelReference(modelId: string): {
    name: string;
    nonHub: boolean;
    route?: string;
    routeProvider?: string;
};
/**
 * Name the creator of a model from its name alone, when only one creator
 * publishes under that name.
 *
 * @param {string} modelName Model name without route or namespace
 * @returns {string|undefined} Creator id
 */
export declare function modelCreatorFromName(modelName: string): string | undefined;
/**
 * Resolve a creator spelling, such as a Hugging Face organisation or a
 * GGUF general.organization value, to a known creator id.
 *
 * @param {string} name Organisation name or namespace
 * @returns {string|undefined} Creator id, or undefined when unknown
 */
export declare function modelCreatorFromOrganization(name: string): string | undefined;
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
export declare function resolveModelCreator(modelId: string, context?: {
    provider?: string;
    fileProviders?: Iterable<string>;
    runtimes?: Iterable<string>;
}): string | undefined;
/**
 * Build the CycloneDX organisational entity for a creator id.
 *
 * @param {string} creator Creator id
 * @returns {{ name: string }|undefined} Manufacturer entity
 */
export declare function modelCreatorEntity(creator: string): {
    name: string;
} | undefined;
//# sourceMappingURL=aiProviders.d.ts.map