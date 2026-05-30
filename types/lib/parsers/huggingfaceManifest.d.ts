/**
 * Parse YAML frontmatter from a local Hugging Face README/model card.
 *
 * @param {string} raw README contents
 * @returns {object|undefined} parsed frontmatter object
 */
export function parseHuggingFaceReadmeFrontmatter(raw: string): object | undefined;
/**
 * Check whether parsed README frontmatter looks like a Hugging Face model card.
 *
 * @param {object|undefined} cardData parsed frontmatter
 * @returns {boolean} true when Hugging Face model-card keys are present
 */
export function hasHuggingFaceCardSignals(cardData: object | undefined): boolean;
/**
 * Infer a Hugging Face repo id from a fixture directory name such as namespace--name.
 *
 * @param {string} filePath manifest file path inside the repository fixture
 * @returns {string|undefined} inferred namespace/name repository id
 */
export function repoIdFromFixtureDirectory(filePath: string): string | undefined;
/**
 * Create a CycloneDX component reference for a related Hugging Face asset.
 *
 * @param {string} modelRef model, dataset, or space reference
 * @param {{ includeDatasetPurl?: boolean }} [options={}] pedigree reference options
 * @returns {{ "bom-ref": string, group: string, name: string, purl?: string, type: string }|undefined} component reference
 */
export function createHuggingFaceComponentReference(modelRef: string, _options?: {}): {
    "bom-ref": string;
    group: string;
    name: string;
    purl?: string;
    type: string;
} | undefined;
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
export function createHuggingFaceDatasetReference(dataset: object | string, options?: {
    componentProperties?: Array<{
        name: string;
        value: string;
    }>;
    componentScope?: string;
    componentSource?: string;
    componentTags?: string[];
    urlSanitizer?: (url: string | undefined) => string | undefined;
}): {
    assetType: "dataset";
    bomRef: string;
    component: {
        "bom-ref": string;
        data: Array<object>;
        description?: string;
        externalReferences?: Array<object>;
        group: string;
        name: string;
        properties?: Array<object>;
        purl?: string;
        scope?: string;
        tags?: string[];
        type: "data";
    };
    description?: string;
    externalReferences?: Array<object>;
    group: string;
    modelId: string;
    name: string;
    provider: "huggingface";
    purl?: string;
    ref: {
        ref: string;
    };
} | undefined;
/**
 * Create a CycloneDX model card from local or remote Hugging Face manifest data.
 *
 * @param {object} [cardData={}] parsed model-card frontmatter
 * @param {object} [config={}] parsed config.json data
 * @param {(dataset: object|string) => object|undefined} [addDatasetReference] optional dataset reference mapper
 * @param {{ urlSanitizer?: (url: string|undefined) => string|undefined }} [options={}] dataset normalization options
 * @returns {object|undefined} sanitized CycloneDX model card
 */
export function createHuggingFaceModelCard(cardData?: object, config?: object, addDatasetReference?: (dataset: object | string) => object | undefined, options?: {
    urlSanitizer?: (url: string | undefined) => string | undefined;
}): object | undefined;
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
export function createHuggingFacePedigree(cardData?: object, adapterConfig?: object, quantization: string | undefined, options?: {
    createPedigreeModelReference?: (modelRef: string) => object | undefined;
}): object | undefined;
export const HUGGING_FACE_MODEL_CARD_PATTERNS: string[];
export const HUGGING_FACE_CONFIG_PATTERNS: string[];
export const HUGGING_FACE_ADAPTER_PATTERNS: string[];
//# sourceMappingURL=huggingfaceManifest.d.ts.map