/**
 * Normalize a list of detected AI model variant labels into a unique string array.
 *
 * @param {unknown[]} [variants=[]] detected variant candidates
 * @returns {string[]} normalized variant labels
 */
export function normalizeDetectedVariants(variants?: unknown[]): string[];
/**
 * Detect normalized AI model variant labels from names, metadata, and notes.
 *
 * @param {{
 *   description?: string,
 *   metadata?: unknown[],
 *   modelName?: string,
 *   notes?: unknown[],
 *   quantization?: string,
 *   relation?: string,
 *   tags?: unknown[],
 * }} [signals] variant detection signals
 * @returns {string[]} normalized variant labels
 */
export function detectAiModelVariants(signals?: {
    description?: string;
    metadata?: unknown[];
    modelName?: string;
    notes?: unknown[];
    quantization?: string;
    relation?: string;
    tags?: unknown[];
}): string[];
//# sourceMappingURL=aiModelVariants.d.ts.map