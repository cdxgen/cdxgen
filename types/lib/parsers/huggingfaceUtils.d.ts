/**
 * Base URL for the Hugging Face Hub.
 *
 * @type {string}
 */
export declare const HF_BASE_URL: string;
/**
 * Relation labels that indicate a Hugging Face pedigree "ancestors" link, as
 * opposed to sibling "variants". Includes adapter, finetune, merge, and
 * quantization relation spellings.
 *
 * @type {Set<string>}
 */
export declare const HUGGING_FACE_ANCESTOR_RELATIONS: Set<string>;
/**
 * Canonical Hugging Face datasets repository URL.
 *
 * @type {string}
 */
export declare const HUGGING_FACE_DATASET_REPOSITORY_URL: string;
/**
 * Canonical Hugging Face spaces repository URL.
 *
 * @type {string}
 */
export declare const HUGGING_FACE_SPACE_REPOSITORY_URL: string;
/**
 * Map a Hugging Face asset type to its canonical Hub repository URL.
 *
 * @param {string} assetType One of "dataset", "space", or "model".
 * @returns {string|undefined} The repository URL for the asset type, or the
 *   base Hub URL for models/unknown types.
 */
export declare function repositoryUrlForHuggingFaceAssetType(assetType: string): string | undefined;
/**
 * Infer the Hugging Face asset type (model, dataset, or space) from a
 * repository URL.
 *
 * @param {string} repositoryUrl The Hugging Face repository URL to inspect.
 * @returns {string|undefined} The inferred asset type ("model", "dataset", or
 *   "space").
 */
export declare function assetTypeFromHuggingFaceRepositoryUrl(repositoryUrl: string): string | undefined;
/**
 * Normalize a Hugging Face repository identifier to the canonical namespace/name form.
 *
 * @param {string} repoId Hugging Face repository id candidate
 * @returns {string|undefined} normalized repository id
 */
export declare function sanitizeHuggingFaceRepoId(repoId: string): string | undefined;
/**
 * Encode Hugging Face path segments while preserving path separators.
 *
 * @param {string} value path-like repository identifier
 * @returns {string} encoded path segments
 */
export declare function encodeHuggingFacePathSegments(value: string): string;
/**
 * Convert a Hugging Face asset reference to a canonical web path.
 *
 * @param {string} assetType asset type such as model, dataset, or space
 * @param {string} repoId Hugging Face repository id
 * @returns {string|undefined} canonical path under huggingface.co
 */
export declare function toHuggingFaceAssetPath(assetType: string, repoId: string): string | undefined;
/**
 * Convert a Hugging Face asset reference to a canonical web URL.
 *
 * @param {string} assetType asset type such as model, dataset, or space
 * @param {string} repoId Hugging Face repository id
 * @returns {string|undefined} canonical URL under huggingface.co
 */
export declare function toHuggingFaceAssetUrl(assetType: string, repoId: string): string | undefined;
/**
 * Build the supplier entity for a Hugging Face namespace: the namespace as
 * the name and its organisation or user page as the url. The url is left
 * out when the namespace has characters a Hub account name cannot have.
 *
 * @param {string} namespace Hugging Face organisation or user name
 * @returns {{ name: string, url?: string[] }|undefined} supplier entity
 */
export declare function toHuggingFaceSupplier(namespace: string): {
    name: string;
    url?: string[];
} | undefined;
/**
 * Convert a Hugging Face repo reference to a package URL.
 *
 * @param {string} repoId Hugging Face repository id
 * @param {string} [version] optional revision or sha
 * @param {string} [repositoryUrl] optional registry URL override
 * @returns {string|undefined} normalized Hugging Face purl
 */
export declare function toHuggingFacePurl(repoId: string, version?: string, repositoryUrl?: string): string | undefined;
/**
 * Normalize a direct Hugging Face URL or purl into a repo reference.
 *
 * @param {string} value direct URL, API URL, or purl
 * @param {object} [parseOptions] parsing options
 * @param {boolean} [parseOptions.explicitOnly=false] resolve only unambiguous
 *   references (`pkg:huggingface/...` purls and huggingface.co URLs) so that
 *   ambiguous `owner/repo`-shaped values keep their filesystem-path meaning
 *   until an AI inventory type is explicitly selected
 * @returns {{ assetType: string, repoId: string, version?: string }|undefined} normalized reference
 */
export declare function normalizeHuggingFaceReference(value: string, parseOptions?: {
    explicitOnly?: boolean;
}): {
    assetType: string;
    repoId: string;
    version?: string;
} | undefined;
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
export declare function normalizeHuggingFaceDataset(dataset: object | string, options?: {
    urlSanitizer?: (url: string | undefined) => string | undefined;
}): {
    assetType: "dataset";
    bomRef: string;
    description?: string;
    group: string;
    name: string;
    repoId: string;
    url: string;
} | undefined;
/**
 * Create an inline CycloneDX dataset object from Hugging Face model-card metadata.
 *
 * @param {object|string} dataset dataset reference from model-card metadata
 * @param {{ urlSanitizer?: (url: string|undefined) => string|undefined }} [options={}] dataset normalization options
 * @returns {{ contents?: { url: string }, description?: string, name: string, type: string }|undefined} inline dataset object
 */
export declare function createInlineHuggingFaceDataset(dataset: object | string, options?: {
    urlSanitizer?: (url: string | undefined) => string | undefined;
}): {
    contents?: {
        url: string;
    };
    description?: string;
    name: string;
    type: string;
} | undefined;
/**
 * Convert Hugging Face model-index entries into CycloneDX performance metrics.
 *
 * @param {Array<object>} [modelIndex=[]] model-index entries from model-card metadata
 * @returns {Array<{ slice?: string, type: string, value: string }>} CycloneDX performance metrics
 */
export declare function createPerformanceMetrics(modelIndex?: Array<object>): Array<{
    slice?: string;
    type: string;
    value: string;
}>;
/**
 * Derive a human-readable quantization label from a Hugging Face quantization config.
 *
 * @param {object|string} quantizationConfig Hugging Face quantization configuration
 * @returns {string|undefined} normalized quantization label
 */
export declare function quantizationValueFromConfig(quantizationConfig: object | string): string | undefined;
//# sourceMappingURL=huggingfaceUtils.d.ts.map