/**
 * Record an external tool cdxgen executed. The first version seen wins unless
 * it was unknown, so an enriched probe never overwrites a concrete version
 * with `undefined` and a later concrete version fills an earlier gap.
 *
 * @param {string} name Tool name as invoked (a bare name or a path)
 * @param {string|undefined} version Version when cheaply known
 */
export declare function recordExecutedTool(name: string, version?: string | undefined): void;
/**
 * Snapshot of the tools recorded so far, sorted by name so the assembled
 * `metadata.tools` diff stays stable between runs.
 *
 * @returns {Array<{name: string, version: (string|undefined)}>} Sorted tool records
 */
export declare function getExecutedTools(): Array<{
  name: string;
  version: string | undefined;
}>;
/**
 * Clear the registry. Intended for tests; a production run never resets its
 * own registry.
 *
 * @returns {void}
 */
export declare function resetExecutedTools(): void;
