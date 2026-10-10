/**
 * Whether a tool's combined output names a rate limit from its repository.
 * The answer text is treated as untrusted: only fixed substrings are looked
 * for, nothing from the output is kept.
 *
 * @param {string} output Combined stdout and stderr of one invocation.
 * @param {string} tool One of maven, gradle, sbt, mill, scala-cli.
 * @returns {boolean} True when the output names an HTTP 429 answer.
 */
export declare function detectBuildToolRateLimit(output: string, tool: string): boolean;
/**
 * Whether a tool was already found rate limited in this scan, so the caller
 * can skip its remaining invocations.
 *
 * @param {string} tool One of maven, gradle, sbt, mill, scala-cli.
 * @returns {boolean}
 */
export declare function isBuildToolRateLimited(tool: string): boolean;
/**
 * Read a completed invocation's output for a rate limit. When one is found,
 * the tool is remembered for the scan, one hint naming the tool's mirror
 * setting is printed, and the `build.rate-limited` degradation is recorded.
 * The first invocation that shows the rate limit is the one recorded; later
 * ones add nothing, because the same answer ends them all.
 *
 * @param {string} tool One of maven, gradle, sbt, mill, scala-cli.
 * @param {string|undefined} output Combined output, as commandOutputText
 *   returns it for a spawn result.
 * @param {Object} [context] Call-site facts for the degradation event.
 * @param {string} [context.command] The redacted command that was attempted.
 * @param {number} [context.exitCode] The invocation's exit status.
 * @returns {boolean} True when this output names a rate limit.
 */
export declare function noteBuildToolRateLimit(tool: string, output: string | undefined, context?: {
    command?: string;
    exitCode?: number;
}): boolean;
//# sourceMappingURL=buildToolRateLimit.d.ts.map