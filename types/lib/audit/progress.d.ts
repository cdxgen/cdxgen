/**
 * Build a human-readable label for an audit target.
 *
 * @param {object} target audit target
 * @returns {string} formatted target label
 */
export function formatTargetLabel(target: object): string;
/**
 * Decide if interactive progress should be shown.
 *
 * @param {object} [options] progress options
 * @returns {boolean} true when spinner-style progress is appropriate
 */
export function shouldRenderProgress(options?: object): boolean;
/**
 * Create a dependency-free progress renderer for cdx-audit.
 *
 * Progress is always written to stderr so JSON/stdout reports remain clean.
 *
 * @param {object} [options] progress options
 * @returns {{ onProgress: Function, stop: Function }} progress controller
 */
export function createProgressTracker(options?: object): {
    onProgress: Function;
    stop: Function;
};
//# sourceMappingURL=progress.d.ts.map