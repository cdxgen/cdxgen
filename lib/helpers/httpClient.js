import { Buffer } from "node:buffer";
import process from "node:process";

import { Agent, interceptors, request as undiciRequest } from "undici";

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
  constructor(response, options) {
    super(
      `Response code ${response.statusCode} (${response.statusMessage || "Request failed"})`,
    );
    this.name = "HTTPError";
    this.response = response;
    this.options = options;
    this.code = "ERR_NON_2XX_3XX_RESPONSE";
  }
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
  constructor(cause, options) {
    super(cause.message);
    this.name = "RequestError";
    this.options = options;
    this.code = cause.code;
    this.cause = cause;
  }
}

/**
 * Merge two option objects one level deep. `headers`, `hooks` and `context`
 * are merged recursively so per-call overrides do not discard the client
 * defaults.
 *
 * @param {Object} base Base (default) options.
 * @param {Object} override Per-call options.
 * @returns {Object} Merged options object.
 */
function mergeOptions(base = {}, override = {}) {
  const merged = { ...base, ...override };
  merged.headers = mergeHeaders(base.headers, override.headers);
  merged.context = { ...(base.context || {}), ...(override.context || {}) };
  merged.hooks = mergeHooks(base.hooks, override.hooks);
  return merged;
}

/**
 * Merge two header objects, skipping `undefined` values so callers can pass
 * `headers: undefined` without clobbering the client defaults.
 *
 * @param {Object} [base] Default headers.
 * @param {Object} [override] Per-call headers.
 * @returns {Object} Merged headers.
 */
function mergeHeaders(base = {}, override = {}) {
  const headers = { ...(base || {}) };
  for (const [key, value] of Object.entries(override || {})) {
    if (value !== undefined) {
      headers[key] = value;
    }
  }
  return headers;
}

/**
 * Concatenate hook arrays from the defaults and per-call options so both run.
 *
 * @param {Object} [base] Default hooks.
 * @param {Object} [override] Per-call hooks.
 * @returns {Object} Merged hooks with `beforeRequest`, `afterResponse` and
 *   `beforeError` arrays.
 */
function mergeHooks(base = {}, override = {}) {
  const hookNames = ["beforeRequest", "afterResponse", "beforeError"];
  const merged = {};
  for (const name of hookNames) {
    merged[name] = [...(base?.[name] || []), ...(override?.[name] || [])];
  }
  return merged;
}

/**
 * Translate a `got`-style timeout option into a single total-request timeout in
 * milliseconds understood by an `AbortSignal`. A plain number is used verbatim.
 * A phase object (e.g. `{ connect, send, response }`) is reduced to the sum of
 * its phases, which provides a sensible upper bound for the whole request.
 *
 * @param {number|Object} [timeout] `got`-style timeout option.
 * @returns {number|undefined} Total timeout in milliseconds, or `undefined`.
 */
export function resolveTimeout(timeout) {
  if (timeout === undefined || timeout === null) {
    return undefined;
  }
  if (typeof timeout === "number") {
    return timeout;
  }
  if (typeof timeout === "object") {
    if (typeof timeout.request === "number") {
      return timeout.request;
    }
    const phases = [
      timeout.connect,
      timeout.secureConnect,
      timeout.send,
      timeout.response,
      timeout.socket,
    ].filter((value) => typeof value === "number");
    if (phases.length) {
      return phases.reduce((total, value) => total + value, 0);
    }
  }
  return undefined;
}

/**
 * Read and decode an undici response body according to the requested
 * `responseType`.
 *
 * @param {Object} undiciResponse Response returned by `undici.request`.
 * @param {string} [responseType] One of `"json"`, `"buffer"` or `"text"`.
 * @returns {Promise<{body: any, rawBody: Buffer}>} Decoded body and raw bytes.
 */
async function readBody(undiciResponse, responseType) {
  const arrayBuffer = await undiciResponse.body.arrayBuffer();
  const rawBody = Buffer.from(arrayBuffer);
  let body;
  if (responseType === "buffer") {
    body = rawBody;
  } else if (responseType === "json") {
    const text = rawBody.toString("utf-8");
    body = text.length ? JSON.parse(text) : undefined;
  } else {
    body = rawBody.toString("utf-8");
  }
  return { body, rawBody };
}

/**
 * Convert a body into the `[body, headers]` pair to hand to undici. When the
 * `json` option is present it is serialized and a JSON `content-type` is added
 * unless the caller already set one.
 *
 * @param {Object} options Merged request options.
 * @returns {{body: (string|Buffer|undefined), headers: Object}} Request body
 *   and (possibly augmented) headers.
 */
function resolveRequestBody(options) {
  const headers = { ...(options.headers || {}) };
  if (options.json !== undefined) {
    const hasContentType = Object.keys(headers).some(
      (key) => key.toLowerCase() === "content-type",
    );
    if (!hasContentType) {
      headers["content-type"] = "application/json";
    }
    return { body: JSON.stringify(options.json), headers };
  }
  return { body: options.body, headers };
}

// In-memory cache of successful GET responses, mirroring the HTTP cache cdxgen
// historically kept via got + Keyv. Repeated metadata/license lookups during a
// scan are served from here instead of hitting the network again. Set the
// CDXGEN_NO_CACHE environment variable to "true" or "1" to disable it.
const responseCache = new Map();

/**
 * Determine whether the in-memory HTTP response cache is disabled via the
 * CDXGEN_NO_CACHE environment variable. Evaluated per request so tests and
 * callers can toggle it at runtime.
 *
 * @returns {boolean} True when caching should be skipped.
 */
export function isCacheDisabled() {
  const value = process.env.CDXGEN_NO_CACHE;
  return value === "true" || value === "1";
}

/**
 * Clear the in-memory HTTP response cache. Primarily useful for tests.
 *
 * @returns {void}
 */
export function clearHttpCache() {
  responseCache.clear();
}

/**
 * Build the cache key for a request. Only the method and normalized URL are
 * used, matching got's default cache key behaviour.
 *
 * @param {string} method Uppercased HTTP method.
 * @param {URL} url Request URL.
 * @returns {string} Cache key.
 */
function cacheKeyFor(method, url) {
  return `${method}:${url.toString()}`;
}

// The maximum number of redirects to follow when `followRedirect` is enabled.
const MAX_REDIRECTIONS = 10;

// Reusable pooled dispatchers. undici composes redirect handling as an
// interceptor (there is no per-request `maxRedirections` option in undici v7),
// so we pre-build the small set of dispatcher variants we need instead of
// allocating a fresh Agent per request (which would defeat connection pooling).
const defaultAgent = new Agent();
const redirectDispatcher = defaultAgent.compose(
  interceptors.redirect({ maxRedirections: MAX_REDIRECTIONS }),
);
const insecureAgent = new Agent({ connect: { rejectUnauthorized: false } });
const insecureRedirectDispatcher = insecureAgent.compose(
  interceptors.redirect({ maxRedirections: MAX_REDIRECTIONS }),
);

/**
 * Pick the undici dispatcher matching the request's redirect and TLS
 * verification preferences.
 *
 * @param {boolean} followRedirect Whether HTTP redirects should be followed.
 * @param {boolean} insecure Whether TLS certificate verification is disabled.
 * @returns {import("undici").Dispatcher} The dispatcher to use for the request.
 */
function selectDispatcher(followRedirect, insecure) {
  if (insecure) {
    return followRedirect ? insecureRedirectDispatcher : insecureAgent;
  }
  return followRedirect ? redirectDispatcher : defaultAgent;
}

/**
 * Perform a single HTTP request and return a `got`-like response object,
 * running the configured hooks along the way.
 *
 * @param {Object} mergedOptions Fully merged request options including `url`.
 * @returns {Promise<Object>} Response object with `statusCode`, `headers`,
 *   `body`, `rawBody`, `url` and `request.options`.
 */
async function doRequest(mergedOptions) {
  const options = mergedOptions;
  const url =
    options.url instanceof URL ? options.url : new URL(String(options.url));
  options.url = url;

  // beforeRequest hooks may mutate options (e.g. set context) or throw to abort
  // the request (dry-run mode). Return values are ignored, matching how cdxgen
  // uses these hooks with got.
  for (const hook of options.hooks?.beforeRequest || []) {
    await hook(options);
  }

  const { body, headers } = resolveRequestBody(options);
  const method = (options.method || "GET").toUpperCase();

  // Serve cacheable GET requests from the in-memory cache when enabled.
  const cacheable = method === "GET" && !isCacheDisabled();
  const cacheKey = cacheable ? cacheKeyFor(method, url) : undefined;
  if (cacheable && responseCache.has(cacheKey)) {
    return responseCache.get(cacheKey);
  }

  const timeoutMs = resolveTimeout(options.timeout);
  const signal = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined;

  const followRedirect = options.followRedirect !== false;
  const insecure = options.https?.rejectUnauthorized === false;
  const requestOptions = {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : body,
    dispatcher: selectDispatcher(followRedirect, insecure),
    signal,
  };

  let undiciResponse;
  try {
    undiciResponse = await undiciRequest(url, requestOptions);
  } catch (err) {
    const requestError = new RequestError(err, options);
    for (const hook of options.hooks?.beforeError || []) {
      await hook(requestError);
    }
    throw requestError;
  }

  const { body: decodedBody, rawBody } = await readBody(
    undiciResponse,
    options.responseType,
  );

  const response = {
    statusCode: undiciResponse.statusCode,
    headers: undiciResponse.headers,
    body: decodedBody,
    rawBody,
    url: url.toString(),
    request: { options },
  };

  const throwHttpErrors = options.throwHttpErrors !== false;
  if (throwHttpErrors && response.statusCode >= 400) {
    const httpError = new HTTPError(response, options);
    for (const hook of options.hooks?.beforeError || []) {
      await hook(httpError);
    }
    throw httpError;
  }

  let finalResponse = response;
  for (const hook of options.hooks?.afterResponse || []) {
    finalResponse = (await hook(finalResponse)) || finalResponse;
  }

  // Only successful responses are cached, matching HTTP cache semantics.
  if (cacheable && finalResponse.statusCode < 400) {
    responseCache.set(cacheKey, finalResponse);
  }
  return finalResponse;
}

/**
 * Kick off a request and return a promise augmented with a lazy `.json()`
 * helper, mirroring `got`'s `client(url).json()` convenience.
 *
 * @param {Object} mergedOptions Fully merged request options including `url`.
 * @returns {Promise<Object> & {json: function(): Promise<any>}} Response promise.
 */
function requestWithHelpers(mergedOptions) {
  const promise = doRequest(mergedOptions);
  promise.json = () =>
    promise.then((response) => {
      if (typeof response.body === "string") {
        return response.body.length ? JSON.parse(response.body) : undefined;
      }
      if (Buffer.isBuffer(response.body)) {
        const text = response.body.toString("utf-8");
        return text.length ? JSON.parse(text) : undefined;
      }
      return response.body;
    });
  return promise;
}

/**
 * Create a `got`-compatible HTTP client bound to the supplied defaults.
 *
 * @param {Object} [defaults] Default request options merged into every call.
 * @returns {Function} Callable client exposing `get`/`post`/`put`/`head`,
 *   `extend`, `defaults` and `hooks`.
 */
export function createHttpClient(defaults = {}) {
  const clientDefaults = {
    ...defaults,
    headers: { ...(defaults.headers || {}) },
    hooks: mergeHooks(defaults.hooks),
    context: { ...(defaults.context || {}) },
  };

  const client = (url, options = {}) =>
    requestWithHelpers(mergeOptions(clientDefaults, { ...options, url }));

  const verb =
    (method) =>
    (url, options = {}) =>
      requestWithHelpers(
        mergeOptions(clientDefaults, { ...options, method, url }),
      );

  client.get = verb("GET");
  client.post = verb("POST");
  client.put = verb("PUT");
  client.head = verb("HEAD");
  client.delete = verb("DELETE");

  /**
   * Derive a new client whose defaults are this client's defaults merged with
   * the supplied options.
   *
   * @param {Object} [moreDefaults] Additional defaults to merge.
   * @returns {Function} A new client instance.
   */
  client.extend = (moreDefaults = {}) =>
    createHttpClient(mergeOptions(clientDefaults, moreDefaults));

  // Expose the resolved defaults and hooks the same way got does, so existing
  // code and tests can reach `client.defaults.options.hooks` and `client.hooks`.
  client.defaults = { options: clientDefaults };
  client.hooks = clientDefaults.hooks;

  return client;
}
