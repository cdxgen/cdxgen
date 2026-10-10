/**
 * `cdxgen cache` subcommand — inspect and purge the metadata fetch cache that
 * cdxrs and the JS batch pool share.
 *
 * This module operates directly on the filesystem because JS is the authority
 * for the cache directory. The cache layout is:
 *   <cacheDir>/cdxrs-fetch/<host>/<hash>.json
 */
/**
 * Gather statistics about the fetch cache.
 *
 * @returns {Object} Cache info: directory, entryCount, totalBytes,
 *   perHost breakdown, oldestMtime, newestMtime.
 */
export declare function cacheInfo(): Object;
/**
 * Remove all entries from the fetch cache.
 *
 * @returns {Object} Result with removedCount, freedBytes, directory.
 */
export declare function cacheClear(): Object;
/**
 * Run the cache subcommand and print results.
 *
 * @param {"info"|"clear"} action What to do.
 * @returns {Promise<number>} Exit code.
 */
export declare function runCacheCommand(action: "info" | "clear"): Promise<number>;
//# sourceMappingURL=cacheCommands.d.ts.map