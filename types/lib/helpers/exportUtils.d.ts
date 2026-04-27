/**
 * Normalize the requested export formats.
 *
 * @param {string|string[]|undefined|null} format Raw format value
 * @returns {string[]} Normalized export formats
 */
export function normalizeOutputFormats(format: string | string[] | undefined | null): string[];
/**
 * Derive the SPDX output path from a base output path.
 *
 * @param {string} outputPath Output path
 * @returns {string} SPDX output path
 */
export function deriveSpdxOutputPath(outputPath: string): string;
/**
 * Derive the CycloneDX output path from a base output path.
 *
 * @param {string} outputPath Output path
 * @returns {string} CycloneDX output path
 */
export function deriveCycloneDxOutputPath(outputPath: string): string;
/**
 * Determine the final output plan for the requested export formats.
 *
 * @param {object} options CLI options
 * @returns {{ formats: Set<string>, outputs: Record<string, string>, explicitFormat: boolean }} Output plan
 */
export function createOutputPlan(options: object): {
    formats: Set<string>;
    outputs: Record<string, string>;
    explicitFormat: boolean;
};
/**
 * Return the output directory for a planned export path.
 *
 * @param {string} outputPath Output path
 * @returns {string} Output directory
 */
export function getOutputDirectory(outputPath: string): string;
//# sourceMappingURL=exportUtils.d.ts.map