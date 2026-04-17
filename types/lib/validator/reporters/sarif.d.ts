/**
 * Render a validation report as SARIF.
 *
 * @param {object} report Output of validateBomAdvanced().
 * @param {object} [options]
 * @param {string} [options.toolName]    Override driver name.
 * @param {string} [options.toolVersion] Driver version to embed.
 * @param {boolean} [options.includeManual] Include manual-review findings (default false).
 * @returns {string}
 */
export function render(report: object, options?: {
    toolName?: string | undefined;
    toolVersion?: string | undefined;
    includeManual?: boolean | undefined;
}): string;
//# sourceMappingURL=sarif.d.ts.map