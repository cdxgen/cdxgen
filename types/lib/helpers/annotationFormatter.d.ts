/**
 * Format annotation properties as a markdown table for CycloneDX annotations.
 *
 * @param {{ name: string, value: string }[]} properties annotation properties
 * @returns {string} markdown table text
 */
export function propertiesToMarkdownTable(properties: {
    name: string;
    value: string;
}[]): string;
/**
 * Build production-ready markdown annotation text.
 *
 * @param {string} message leading message text
 * @param {{ name: string, value: string }[]} properties annotation properties
 * @param {string[]} [details] optional detail lines shown before the table
 * @returns {string} annotation text
 */
export function buildAnnotationText(message: string, properties: {
    name: string;
    value: string;
}[], details?: string[]): string;
//# sourceMappingURL=annotationFormatter.d.ts.map