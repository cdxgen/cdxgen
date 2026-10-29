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
 * Remember the version a stage already resolved for a tool, such as the JVM
 * build tool pregen provisioned. The version shows in `metadata.tools` only if
 * the tool is executed; the first version recorded wins.
 *
 * @param {string} name Tool name as it will be invoked (a bare name or a path)
 * @param {string} version Resolved version
 */
export declare function recordToolVersion(name: string, version: string): void;
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
 * Clear the registry. The server calls it between scans through the run-state
 * reset; tests call it directly.
 *
 * @returns {void}
 */
export declare function resetExecutedTools(): void;
