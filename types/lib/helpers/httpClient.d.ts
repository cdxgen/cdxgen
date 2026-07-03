/**
 * Resolve the default HTTP request timeout, honoring the validated
 * CDXGEN_HTTP_TIMEOUT_MS environment variable when set to a positive integer.
 *
 * @returns {number} Timeout in milliseconds
 */
export function getDefaultHttpTimeoutMs(): number;
export function resolveTimeout(timeout: any): any;
/**
 * Determine whether the in-memory HTTP response cache is disabled via the
 * CDXGEN_NO_CACHE environment variable. Evaluated per request so tests and
 * callers can toggle it at runtime.
 *
 * @returns {boolean} True when caching should be skipped.
 */
export function isCacheDisabled(): boolean;
/**
 * Clear the in-memory HTTP response cache. Primarily useful for tests.
 *
 * @returns {void}
 */
export function clearHttpCache(): void;
/**
 * Create a `got`-compatible HTTP client bound to the supplied defaults.
 *
 * @param {Object} [defaults] Default request options merged into every call.
 * @returns {Function} Callable client exposing `get`/`post`/`put`/`head`,
 *   `extend`, `defaults` and `hooks`.
 */
export function createHttpClient(defaults?: Object): Function;
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
 *   (only `limit` is honoured), `https.rejectUnauthorized` and `context`.
 * - `beforeRequest`, `afterResponse` and `beforeError` hooks with the same
 *   calling conventions cdxgen uses today. These hooks continue to power
 *   cdxgen's dry-run enforcement, host allow-listing, network-activity
 *   recording and HTTP trace logging.
 * - An in-memory GET response cache (enabled by default, disabled by setting
 *   the `CDXGEN_NO_CACHE` environment variable) that replaces the got + Keyv
 *   cache cdxgen previously relied on.
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
export class HTTPError extends Error {
    /**
     * @param {Object} response Response object produced by this client.
     * @param {Object} options Merged request options for the failed request.
     */
    constructor(response: Object, options: Object);
    response: Object;
    options: Object;
    code: string;
}
/**
 * Error thrown for transport-level failures (DNS, connection reset, timeouts).
 * Carries the merged request `options` so `beforeError` hooks can inspect the
 * request context.
 */
export class RequestError extends Error {
    /**
     * @param {Error} cause Underlying error thrown by undici.
     * @param {Object} options Merged request options for the failed request.
     */
    constructor(cause: Error, options: Object);
    options: Object;
    code: any;
    cause: Error;
}
//# sourceMappingURL=httpClient.d.ts.map