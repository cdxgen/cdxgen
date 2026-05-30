/**
 * Clear the in-process Hugging Face caches used for remote metadata lookup.
 */
export function resetHuggingFaceRemoteCaches(): void;
/**
 * Resolve a Hugging Face model, dataset, or space into a BOM component.
 *
 * @param {string} assetType asset type such as model or dataset
 * @param {string} repoId Hugging Face repository id
 * @param {Object} [options={}] fetch and header overrides
 * @returns {Promise<Object|undefined>} resolved BOM component
 */
export function fetchHuggingFaceAssetInventory(assetType: string, repoId: string, options?: Object): Promise<Object | undefined>;
/**
 * Resolve a Hugging Face asset to the primary CycloneDX component only.
 *
 * @param {string} assetType asset type such as model or dataset
 * @param {string} repoId Hugging Face repository id
 * @param {Object} [options={}] fetch and header overrides
 * @returns {Promise<Object|undefined>} primary resolved component
 */
export function fetchHuggingFaceAssetMetadata(assetType: string, repoId: string, options?: Object): Promise<Object | undefined>;
export function isHuggingFaceRemoteEnabled(options?: Object): boolean;
export { normalizeHuggingFaceReference, toHuggingFacePurl } from "../huggingfaceUtils.js";
//# sourceMappingURL=huggingface.d.ts.map