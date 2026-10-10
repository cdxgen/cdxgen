/**
 * A tiny, `got`-compatible HTTP client built on top of undici.
 *
 * cdxgen historically relied on the `got` library. `got` keeps a per-request
 * HTTP cache backed by an EventEmitter which, during large `--deep` scans that
 * issue thousands of parallel license/metadata lookups, leaks "error" listeners
 * and floods the console with `MaxListenersExceededWarning` messages. undici
 * uses a pooled dispatcher and does not exhibit this behaviour.
 *
 * This module intentionally implements only the subset of the `got` surface
 * that cdxgen consumes:
 *
 * - Callable form: `client(url, options)` and the verb helpers `client.get`,
 *   `client.post`, `client.put` and `client.head`.
 * - `client.extend(defaults)` to derive a new client with merged defaults.
 * - Request options: `method`, `headers`, `body`, `json`, `responseType`
 *   (`"json"` | `"buffer"` | `"text"`), `throwHttpErrors`, `followRedirect`,
 *   `timeout` (number of milliseconds or a `got`-style phase object), `retry`
 *   (accepted for API compatibility; no automatic retries are performed),
 *   `https.rejectUnauthorized` and `context`.
 * - `beforeRequest`, `afterResponse` and `beforeError` hooks with the same
 *   calling conventions cdxgen uses today. These hooks continue to power
 *   cdxgen's dry-run enforcement, host allow-listing, network-activity
 *   recording and HTTP trace logging.
 * - Automatic response decompression (`gzip`, `deflate`, `br`) driven by the
 *   `Content-Encoding` header, matching `got`'s transparent decoding.
 * - Proxy support via the standard `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`
 *   environment variables (through undici's `EnvHttpProxyAgent`).
 * - An in-memory GET response cache that replaces the got + Keyv cache cdxgen
 *   previously relied on. A request opts out with `cache: false`.
 * - Response objects exposing `statusCode`, `headers`, `body`, `rawBody`,
 *   `url` and `request.options`.
 * - A lazily-resolved `.json()` method on the returned promise, mirroring
 *   `got`'s `client(url).json()` usage.
 *
 * @module httpClient
 */
/**
 * Error thrown when the server responds with a non 2xx/3xx status code and
 * `throwHttpErrors` has not been disabled. Shaped like `got`'s `HTTPError` so
 * that existing `error.response.statusCode` and `error.options.context` checks
 * keep working.
 */
export declare class HTTPError extends Error {
    response: Object;
    options: Object;
    code: string;
    /**
     * @param {Object} response Response object produced by this client.
     * @param {Object} options Merged request options for the failed request.
     */
    constructor(response: Object, options: Object);
}
/**
 * Error thrown for transport-level failures (DNS, connection reset, timeouts).
 * Carries the merged request `options` so `beforeError` hooks can inspect the
 * request context.
 */
export declare class RequestError extends Error {
    options: Object;
    code: any;
    cause: Error;
    /**
     * @param {Error} cause Underlying error thrown by undici.
     * @param {Object} options Merged request options for the failed request.
     */
    constructor(cause: Error, options: Object);
}
/**
 * Resolve the default HTTP request timeout, honoring the validated
 * CDXGEN_HTTP_TIMEOUT_MS environment variable when set to a positive integer.
 *
 * @returns {number} Timeout in milliseconds
 */
export declare function getDefaultHttpTimeoutMs(): number;
/**
 * Translate a `got`-style timeout option into a single total-request timeout in
 * milliseconds suitable for `AbortSignal.timeout`. A plain number is used
 * verbatim. A phase object (e.g. `{ connect, send, response }`, or `{ request }`)
 * is reduced to the sum of its numeric phases, which provides a sensible upper
 * bound for the whole request.
 *
 * @param {number|Object} [timeout] `got`-style timeout option.
 * @returns {number|undefined} Total timeout in milliseconds, or `undefined`.
 */
export declare function resolveTimeout(timeout?: number | Object): number | undefined;
/**
 * Override the response cache bounds. Returns the previous bounds so tests can
 * restore them. Not part of the public API.
 *
 * @param {{ttlMs?: number, maxBytes?: number}} limits New bounds.
 * @returns {{ttlMs: number, maxBytes: number}} Previous bounds.
 */
export declare function _setHttpCacheLimits(limits: {
    ttlMs?: number;
    maxBytes?: number;
}): {
    ttlMs: number;
    maxBytes: number;
};
/**
 * Clear the in-memory HTTP response cache. Primarily useful for tests.
 *
 * @returns {void}
 */
export declare function clearHttpCache(): void;
/**
 * Error thrown when a cassette replay session encounters a request with no
 * matching recorded interaction.  This is loud-by-design: a silent fall-
 * through to the live network would make offline golden tests meaningless.
 */
export declare class CassetteMissError extends Error {
    method: string;
    url: string;
    /**
     * @param {string} method HTTP method.
     * @param {string} url Request URL.
     */
    constructor(method: string, url: string);
}
/**
 * Install an HTTP interceptor that acts as the single network seam for test
 * cassettes.  The interceptor receives a request descriptor and must return
 * either a `got`-like response object (replay hit) or `null` (pass-through /
 * record mode).
 *
 * @param {(req: { method: string, url: URL, headers: Object, body: *, responseType?: string, options: Object }) => Promise<Object|null>} fn
 *   Interceptor function.
 * @returns {void}
 */
export declare function setHttpInterceptor(fn: (req: {
    method: string;
    url: URL;
    headers: Object;
    body: any;
    responseType?: string;
    options: Object;
}) => Promise<Object | null>): void;
/**
 * Remove the currently-installed HTTP interceptor, restoring normal network
 * behaviour.
 *
 * @returns {void}
 */
export declare function clearHttpInterceptor(): void;
/**
 * Create a `got`-compatible HTTP client bound to the supplied defaults.
 *
 * @param {Object} [defaults] Default request options merged into every call.
 * @returns {Function} Callable client exposing `get`/`post`/`put`/`head`,
 *   `extend`, `defaults` and `hooks`.
 */
export declare function createHttpClient(defaults?: Object): Function;
//# sourceMappingURL=httpClient.d.ts.map