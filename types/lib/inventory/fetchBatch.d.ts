/**
 * Batched registry HTTP, via `cdxrs fetch` when it is available and a JS pool
 * otherwise.
 *
 * The registry metadata functions in `lib/ecosystems/ecosystems.js` know every
 * URL they are going to need before they need any of them, but fetch them one
 * at a time with an `await` in a `for` body. That is the cost this module
 * removes: the URLs are handed off in a single batch, fetched concurrently with
 * a shared per-host rate policy, and returned as a map that the existing loops
 * read instead of the network.
 *
 * There is one policy layer (`fetchRate.js`, mirrored by the Rust `rate.rs`)
 * and two transports. When the `cdxrs` binary is available it is preferred,
 * because it brings an on-disk conditional cache (D26) the JS pool does not
 * have. When it is absent, disabled, or unusable, the JS pool runs every
 * request through `cdxgenAgent` so the secure-mode host allowlist, the
 * activity recorder and the test cassette interceptor all still apply.
 *
 * Two properties are deliberate and load-bearing:
 *
 * 1. **No field derivation happens here or in Rust.** Both transports return
 *    registry documents verbatim; every `p.description`, `p.license`,
 *    provenance property and SPDX lookup is still computed by the same
 *    JavaScript that computes it on the serial path. Neither transport can
 *    therefore produce a different SBOM — both can only produce the same one
 *    sooner. An earlier design derived fields in Rust and diverged from the
 *    JS on all three registries it covered.
 *
 * 2. **Fallback is per URL, not per run.** A URL that the batch could not
 *    resolve for a transport reason is simply absent from the map, and the
 *    caller's own `cdxgenAgent.get` runs for it exactly as before. A URL that
 *    resolved to a definite HTTP error is recorded as such, so the caller does
 *    not re-request it only to get the same 404.
 */
/**
 * Whether requests to a host are paused.
 *
 * @param {string|null} host Hostname.
 * @returns {boolean}
 */
export declare function isHostCircuitOpen(host: string | null): boolean;
/**
 * Pause requests to a host, for at least {@link DEFAULT_CIRCUIT_OPEN_MS} or for
 * as long as the server asked. Warns once per pause.
 *
 * @param {string} host Hostname.
 * @param {{delayMs?: number|null, cause?: string, quiet?: boolean}} [details]
 *   Server-supplied delay, a short description of what happened, and whether
 *   to pause without a warning or a degradation record (for failures that are
 *   not the host's doing, such as a dry run or an allowlist block).
 * @returns {void}
 */
export declare function openHostCircuit(host: string, { delayMs, cause, quiet }?: {
    delayMs?: number | null;
    cause?: string;
    quiet?: boolean;
}): void;
/**
 * Clear every paused host. Tests only.
 *
 * @returns {void}
 */
export declare function resetHostCircuits(): void;
/**
 * @returns {Object|null} Stats from the last batch (requests, unique, ok,
 *   failures, cacheHits, elapsedMs, peakConcurrency), or null.
 */
export declare function lastBatchStats(): Object | null;
/**
 * Whether batched fetching through cdxrs is available.
 *
 * Memoized because the probe spawns the binary, and this is consulted once per
 * metadata function rather than once per run.
 *
 * @returns {boolean} True when `cdxrs fetch` can be used.
 */
export declare function batchFetchAvailable(): boolean;
/**
 * Reset the memoized availability probe and the JS batcher's in-flight map.
 * Tests only.
 */
export declare function resetBatchFetchAvailability(): void;
export type BatchEntry = {
    /**
     * Whether a body was obtained.
     */
    ok: boolean;
    /**
     * Parsed response body when `ok`.
     */
    body?: any;
    /**
     * HTTP status, when the server produced one.
     */
    status?: number;
    /**
     * True when the status is a final answer (a 4xx
     * other than 429) and re-requesting it in JS would be pointless.
     */
    definite?: boolean;
};
/**
 * Fetch a batch of registry URLs concurrently.
 *
 * Dispatches to the Rust subprocess when it is available (it brings the D26
 * on-disk cache), and to the JS pool otherwise. Both transports return a map
 * keyed by URL with the same entry shape, so callers do not know — and do not
 * need to know — which one ran.
 *
 * @param {Array<{url: string, accept?: string, authRealm?: string, responseType?: ("json"|"text"|"buffer"), headers?: Object}>} requests
 *   URLs to fetch. Duplicates are fine; they are coalesced.
 * @param {Object} [options]
 * @param {number} [options.timeoutMs] Override the Rust batch timeout.
 * @returns {Promise<Map<string, BatchEntry>>} Map keyed by URL. Empty when
 *   prefetching is disabled (cassette replay) or the request list is empty;
 *   never empty for "no binary", which is the whole point of the JS pool.
 */
export declare function prefetchJson(requests: Array<{
    url: string;
    accept?: string;
    authRealm?: string;
    responseType?: ("json" | "text" | "buffer");
    headers?: Object;
}>, options?: {
    timeoutMs?: number;
}): Promise<Map<string, BatchEntry>>;
/**
 * Whether a hostname belongs to crates.io, including its index and CDN hosts.
 *
 * @param {string|null} host Hostname, or null when the URL did not parse.
 * @returns {boolean}
 */
export declare function isCratesHost(host: string | null): boolean;
/**
 * Whether a host's rate policy lives in the JS table alone and therefore needs
 * every request to pass through the one gate the JS pool holds.
 *
 * @param {string|null} host Hostname, or null when the URL did not parse.
 * @returns {boolean}
 */
export declare function isSingleGateHost(host: string | null): boolean;
/**
 * Record the run-level policy or connectivity condition carried by a caught
 * fetch error, if it names one. Shared by the batch retry loop and by the
 * serial enrichment paths that catch and swallow the same typed errors.
 *
 * @param {Error} err Error caught from a `cdxgenAgent` request.
 * @returns {void}
 */
export declare function recordPolicyDegradationFromError(err: Error): void;
/**
 * Run a caller's own request under the same per-host gate the batch pool uses.
 *
 * Not every registry lookup goes through the pool: a caller that misses the
 * prefetch, or runs with prefetching disabled, issues `cdxgenAgent.get`
 * directly. Those requests reach the same host and count against the same
 * published budget, so they have to queue behind the same limiter rather than
 * a second one — crates.io's one-request-per-second policy is not honoured by
 * two independent gates that each allow one per second.
 *
 * The per-host semaphore and limiter are module state, so this shares one gate
 * per host for the life of the process.
 *
 * A host paused by its circuit breaker fails at once with a 429-shaped error,
 * and a 429 from a breaker host pauses it.
 *
 * With `deferGate`, `issue` receives request options carrying a
 * `beforeNetwork` hook and must pass them to `cdxgenAgent`. The rate limiter
 * then runs only when the request misses the response cache, so a cached
 * answer does not wait for a slot. Without it, the limiter runs before
 * `issue`, as before.
 *
 * @template T
 * @param {string} url The URL about to be requested.
 * @param {(gate: Object) => Promise<T>} issue Issues the request and resolves its result.
 * @param {{deferGate?: boolean}} [opts]
 * @returns {Promise<T>} Whatever `issue` resolves to.
 */
export declare function withHostRateLimit<T>(url: string, issue: (gate: Object) => Promise<T>, { deferGate }?: {
    deferGate?: boolean;
}): Promise<T>;
/**
 * Read a prefetched response, or signal that the caller should fetch it itself.
 *
 * @param {Map<string, BatchEntry>} prefetched Result of {@link prefetchJson}.
 * @param {string} url The URL the caller is about to request.
 * @returns {{body: *}|undefined} A response-shaped object when the body is
 *   available, or `undefined` when the caller should issue its own request.
 * @throws {Error} When the batch established a definite HTTP error for this
 *   URL, so that the caller's existing `catch` treats it exactly as it treats a
 *   failed `cdxgenAgent.get`.
 */
export declare function prefetchedResponse(prefetched: Map<string, BatchEntry>, url: string): {
    body: any;
} | undefined;
/**
 * Whether batched prefetching should be attempted at all.
 *
 * The JS pool is always available (it is plain JavaScript through
 * `cdxgenAgent`), so this is true for every real run. The single exception is
 * cassette replay: the cassette interceptor lives inside undici inside this
 * process, and the golden harness asserts exact request ordering and counts.
 * The batch pool reorders requests by design, so it is disabled under replay
 * to keep the golden cassettes stable. `CDXGEN_RS_DISABLE=fetch` and
 * `--no-rust` disable only the Rust subprocess; the JS pool still runs, which
 * is the point of this round.
 *
 * @returns {boolean} True when prefetching is allowed.
 */
export declare function prefetchEnabled(): boolean;
//# sourceMappingURL=fetchBatch.d.ts.map