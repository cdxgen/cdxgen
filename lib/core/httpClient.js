import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import process from "node:process";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

import {
  Agent,
  EnvHttpProxyAgent,
  interceptors,
  request as undiciRequest,
} from "undici";

// Environment variables here are read with raw `process.env` rather than
// `readEnvironmentVariable`: that helper lives in activity.js, which imports
// this module, so routing these through it would form an import cycle.

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
  const hookNames = [
    "beforeRequest",
    "beforeNetwork",
    "afterResponse",
    "beforeError",
  ];
  const merged = {};
  for (const name of hookNames) {
    merged[name] = [...(base?.[name] || []), ...(override?.[name] || [])];
  }
  return merged;
}

// Default per-request timeout (ms). undici (unlike got) applies no request
// timeout by default, so an unresponsive host would hang a scan indefinitely.
// 15s is generous for metadata/registry lookups; raise it for slow networks or
// large downloads via CDXGEN_HTTP_TIMEOUT_MS. Capped at 1h so a typo cannot
// effectively disable the timeout.
const DEFAULT_HTTP_TIMEOUT_MS = 15000;
const MAX_HTTP_TIMEOUT_MS = 3600000;

/**
 * Resolve the default HTTP request timeout, honoring the validated
 * CDXGEN_HTTP_TIMEOUT_MS environment variable when set to a positive integer.
 *
 * @returns {number} Timeout in milliseconds
 */
export function getDefaultHttpTimeoutMs() {
  const raw = process.env.CDXGEN_HTTP_TIMEOUT_MS;
  if (raw === undefined || raw === "") {
    return DEFAULT_HTTP_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return DEFAULT_HTTP_TIMEOUT_MS;
  }
  return Math.min(parsed, MAX_HTTP_TIMEOUT_MS);
}

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
 * Decompress a response body buffer according to its `Content-Encoding`. undici
 * performs no automatic decompression, so we replicate the behaviour `got` gave
 * us for `gzip`, `deflate` and `br` encoded responses. Multiple, comma-separated
 * encodings are applied in reverse order. Unknown encodings and decompression
 * failures fall back to returning the buffer untouched.
 *
 * @param {Buffer} rawBody Raw response bytes.
 * @param {string} [contentEncoding] Value of the Content-Encoding header.
 * @returns {Buffer} Decompressed (or original) buffer.
 */
function decompressBody(rawBody, contentEncoding) {
  if (!contentEncoding || rawBody.length === 0) {
    return rawBody;
  }
  const encodings = contentEncoding
    .split(",")
    .map((encoding) => encoding.trim().toLowerCase())
    .filter(Boolean);
  let buffer = rawBody;
  for (const encoding of encodings.reverse()) {
    try {
      if (encoding === "gzip" || encoding === "x-gzip") {
        buffer = gunzipSync(buffer);
      } else if (encoding === "deflate") {
        buffer = inflateSync(buffer);
      } else if (encoding === "br") {
        buffer = brotliDecompressSync(buffer);
      } else if (encoding === "identity") {
        // no-op
      } else {
        // Unknown encoding; leave the buffer as-is.
        return buffer;
      }
    } catch {
      // Decompression failed (e.g. body was not actually encoded); return what
      // we have so callers can attempt to parse it.
      return buffer;
    }
  }
  return buffer;
}

/**
 * Read and decode an undici response body according to the requested
 * `responseType`.
 *
 * An error response often carries a body in another format than the one asked
 * for, such as the HTML page a CDN sends with a 429. Its JSON body is decoded
 * when it parses and kept as text otherwise, so the caller sees the status
 * rather than a parse error.
 *
 * @param {Object} undiciResponse Response returned by `undici.request`.
 * @param {string} [responseType] One of `"json"`, `"buffer"` or `"text"`.
 * @returns {Promise<{body: any, rawBody: Buffer}>} Decoded body and raw bytes.
 */
async function readBody(undiciResponse, responseType) {
  const arrayBuffer = await undiciResponse.body.arrayBuffer();
  let rawBody = Buffer.from(arrayBuffer);
  // undici (unlike got) does not transparently decompress response bodies, so
  // honor the Content-Encoding header ourselves. Some registries (e.g. the
  // nuget registration5-gz-semver2 endpoint) always return gzip-encoded JSON.
  rawBody = decompressBody(
    rawBody,
    undiciResponse.headers?.["content-encoding"],
  );
  let body;
  if (responseType === "buffer") {
    body = rawBody;
  } else if (responseType === "json") {
    const text = rawBody.toString("utf-8");
    if (!text.length) {
      body = undefined;
    } else if (undiciResponse.statusCode >= 400) {
      try {
        body = JSON.parse(text);
      } catch (_err) {
        body = text;
      }
    } else {
      body = JSON.parse(text);
    }
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
//
// Entries expire after an hour and the cache is bounded in size, least
// recently used first, so a long-running server neither serves stale registry
// documents nor grows without limit.
const responseCache = new Map();
const RESPONSE_CACHE_TTL_MS = 60 * 60 * 1000;
const RESPONSE_CACHE_MAX_BYTES = 512 * 1024 * 1024;
let responseCacheLimits = {
  ttlMs: RESPONSE_CACHE_TTL_MS,
  maxBytes: RESPONSE_CACHE_MAX_BYTES,
};
let responseCacheBytes = 0;

/**
 * Approximate the memory a cached response holds. The raw bytes are kept,
 * plus the decoded body for text and JSON responses.
 *
 * @param {Object} response Response object.
 * @returns {number} Size in bytes.
 */
function cachedResponseBytes(response) {
  const raw = response?.rawBody?.length || 0;
  return response?.body === response?.rawBody ? raw : raw * 3;
}

/**
 * Read a cached response, dropping it when it has expired and marking it as
 * recently used otherwise.
 *
 * @param {string} key Cache key.
 * @returns {Object|undefined} The cached response.
 */
function cacheGet(key) {
  const entry = responseCache.get(key);
  if (!entry) {
    return undefined;
  }
  responseCache.delete(key);
  if (entry.expiresAt <= Date.now()) {
    responseCacheBytes -= entry.bytes;
    return undefined;
  }
  responseCache.set(key, entry);
  return entry.response;
}

/**
 * Store a response, evicting the least recently used entries beyond the size
 * bound.
 *
 * @param {string} key Cache key.
 * @param {Object} response Response object.
 * @returns {void}
 */
function cacheSet(key, response) {
  const bytes = cachedResponseBytes(response);
  if (bytes > responseCacheLimits.maxBytes) {
    return;
  }
  const previous = responseCache.get(key);
  if (previous) {
    responseCache.delete(key);
    responseCacheBytes -= previous.bytes;
  }
  responseCache.set(key, {
    response,
    bytes,
    expiresAt: Date.now() + responseCacheLimits.ttlMs,
  });
  responseCacheBytes += bytes;
  for (const [oldestKey, oldest] of responseCache) {
    if (responseCacheBytes <= responseCacheLimits.maxBytes) {
      break;
    }
    responseCache.delete(oldestKey);
    responseCacheBytes -= oldest.bytes;
  }
}

/**
 * Override the response cache bounds. Returns the previous bounds so tests can
 * restore them. Not part of the public API.
 *
 * @param {{ttlMs?: number, maxBytes?: number}} limits New bounds.
 * @returns {{ttlMs: number, maxBytes: number}} Previous bounds.
 */
export function _setHttpCacheLimits(limits) {
  const previous = responseCacheLimits;
  responseCacheLimits = { ...responseCacheLimits, ...limits };
  return previous;
}

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
  responseCacheBytes = 0;
}

// ---------------------------------------------------------------------------
// Test cassette interceptor — the single network seam.
//
// `createHttpClient()` is the only factory that produces HTTP clients in the
// entire cdxgen codebase (confirmed by grep).  By intercepting inside
// `doRequest`, every outbound request — whether from `cdxgenAgent` in utils.js,
// the OCI image manager, or the source analyzer — flows through one choke
// point.  The golden test harness installs an interceptor that either replays
// a recorded response (cassette) or throws a loud `CassetteMissError` so an
// unmatched request can never silently reach the live network in CI.
//
// In record mode the interceptor returns `null`, letting the real request
// proceed; a wrapper around the returned promise captures the response for
// later commit to the cassette file.
// ---------------------------------------------------------------------------

/**
 * Error thrown when a cassette replay session encounters a request with no
 * matching recorded interaction.  This is loud-by-design: a silent fall-
 * through to the live network would make offline golden tests meaningless.
 */
export class CassetteMissError extends Error {
  /**
   * @param {string} method HTTP method.
   * @param {string} url Request URL.
   */
  constructor(method, url) {
    super(
      `Cassette miss: no recorded response for ${method} ${url}. Record with UPDATE_GOLDEN=1 or CDXGEN_CASSETTE_MODE=record.`,
    );
    this.name = "CassetteMissError";
    this.method = method;
    this.url = url;
  }
}

/**
 * Currently-installed interceptor function, or null when no interceptor is
 * active (normal cdxgen operation).
 * @type {((req: Object) => Promise<Object|null>) | null}
 */
let httpInterceptor = null;

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
export function setHttpInterceptor(fn) {
  httpInterceptor = fn;
}

/**
 * Remove the currently-installed HTTP interceptor, restoring normal network
 * behaviour.
 *
 * @returns {void}
 */
export function clearHttpInterceptor() {
  httpInterceptor = null;
}

/**
 * Build the cache key for a request.
 *
 * Besides the method and URL, the key carries the response type, which
 * changes how the same bytes are decoded, and a digest of every request
 * header. A response fetched with one credential is therefore never served to
 * a request made with another credential or with none, and a JSON request
 * never receives a text body. Header values only enter the key as a SHA-256
 * digest, so no credential is held in it.
 *
 * @param {string} method Uppercased HTTP method.
 * @param {URL} url Request URL.
 * @param {Object} [headers] Request headers as sent.
 * @param {string} [responseType] Requested body decoding.
 * @returns {string} Cache key.
 */
function cacheKeyFor(method, url, headers = {}, responseType = undefined) {
  const headerEntries = Object.entries(headers || {})
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([name, value]) => [
      name.toLowerCase(),
      Array.isArray(value) ? value.join(", ") : String(value),
    ])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const headerDigest = headerEntries.length
    ? createHash("sha256").update(JSON.stringify(headerEntries)).digest("hex")
    : "";
  return `${method}:${responseType || "text"}:${url.toString()}:${headerDigest}`;
}

// The maximum number of redirects to follow when `followRedirect` is enabled.
const MAX_REDIRECTIONS = 10;

// Bun ships its own bundled implementation of the `undici` module which, as of
// Bun 1.2, does not expose the `Agent.prototype.compose` composition API nor the
// `interceptors.redirect` interceptor that undici v7 uses for redirect handling
// (see cdxgen issue #4245). Detect the Bun runtime so we can fall back to plain
// dispatchers and follow redirects manually instead of crashing at module load.
const isBun = typeof globalThis.Bun !== "undefined";

// Reusable pooled dispatchers. On Node.js, undici composes redirect handling as
// an interceptor (there is no per-request `maxRedirections` option in undici v7),
// so we pre-build the small set of dispatcher variants we need instead of
// allocating a fresh Agent per request (which would defeat connection pooling).
// On Bun, `compose`/`interceptors.redirect` are unavailable, so the redirect
// dispatchers are just the plain agents and redirects are handled in
// `requestWithRedirects` below.
// Whether standard proxy environment variables are set. When they are, requests
// must be routed through the proxy. Because this client always passes an
// explicit per-request `dispatcher`, it overrides Node's global (potentially
// proxy-aware) dispatcher, so we have to build proxy-aware dispatchers here or
// HTTP_PROXY/HTTPS_PROXY/NO_PROXY (documented in docs/ENV.md) are silently
// ignored. `EnvHttpProxyAgent` reads those variables itself, including NO_PROXY
// bypass handling, per request.
function hasProxyEnv() {
  return Boolean(
    process.env.HTTP_PROXY ||
      process.env.http_proxy ||
      process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      process.env.ALL_PROXY ||
      process.env.all_proxy,
  );
}

// Build a base dispatcher, honoring proxy environment variables when present.
// `EnvHttpProxyAgent` is unavailable in Bun's bundled undici, so fall back to a
// plain Agent there (matching pre-existing behaviour: no proxy support on Bun).
function createBaseAgent(agentOptions = {}) {
  if (hasProxyEnv() && typeof EnvHttpProxyAgent === "function" && !isBun) {
    try {
      return new EnvHttpProxyAgent(agentOptions);
    } catch {
      // Fall through to a plain Agent if the proxy agent cannot be constructed.
    }
  }
  return new Agent(agentOptions);
}

const defaultAgent = createBaseAgent();
const insecureAgent = createBaseAgent({
  connect: { rejectUnauthorized: false },
});
const redirectDispatcher = isBun
  ? defaultAgent
  : defaultAgent.compose(
      interceptors.redirect({ maxRedirections: MAX_REDIRECTIONS }),
    );
const insecureRedirectDispatcher = isBun
  ? insecureAgent
  : insecureAgent.compose(
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

// HTTP status codes that represent a redirect with a `location` header.
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

/**
 * Issue an undici request, following redirects manually when running under Bun.
 *
 * On Node.js the redirect-following interceptor baked into the dispatcher does
 * the work, so this simply forwards to `undiciRequest`. On Bun (where the
 * interceptor API is unavailable) we loop on 3xx responses, draining each
 * intermediate body and resolving relative `location` headers, up to
 * `MAX_REDIRECTIONS` hops.
 *
 * @param {URL} url Request URL.
 * @param {Object} requestOptions Options passed to `undiciRequest`.
 * @param {boolean} followRedirect Whether redirects should be followed.
 * @returns {Promise<Object>} The final undici response.
 */
async function requestWithRedirects(url, requestOptions, followRedirect) {
  if (!isBun || !followRedirect) {
    return await undiciRequest(url, requestOptions);
  }
  let currentUrl = url;
  let redirections = 0;
  while (true) {
    const response = await undiciRequest(currentUrl, requestOptions);
    const location = response.headers?.location;
    if (
      !REDIRECT_STATUS_CODES.has(response.statusCode) ||
      !location ||
      redirections >= MAX_REDIRECTIONS
    ) {
      return response;
    }
    // Drain the intermediate response body so the connection can be reused.
    try {
      await response.body.dump();
    } catch {
      // Ignore drain failures; the socket will be discarded.
    }
    currentUrl = new URL(location, currentUrl);
    redirections += 1;
    // 303, and 301/302 for anything other than GET/HEAD, must switch to GET
    // without a body, matching how undici's redirect interceptor behaves.
    const method = (requestOptions.method || "GET").toUpperCase();
    if (
      response.statusCode === 303 ||
      ((response.statusCode === 301 || response.statusCode === 302) &&
        method !== "GET" &&
        method !== "HEAD")
    ) {
      requestOptions.method = "GET";
      requestOptions.body = undefined;
    }
  }
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

  // --- Test cassette layer (single network seam) ---
  // When an interceptor is installed (see setHttpInterceptor), it is the
  // authority for every request: a replay hit short-circuits the network
  // call; an unmatched request throws a loud CassetteMissError so offline
  // tests never silently reach the live network.  Returns null in
  // pass-through (record) mode to let the real request proceed.
  if (httpInterceptor) {
    const cassetteResponse = await httpInterceptor({
      method: (options.method || "GET").toUpperCase(),
      url,
      headers: options.headers || {},
      body: options.body,
      responseType: options.responseType,
      options,
    });
    if (cassetteResponse) {
      return cassetteResponse;
    }
  }

  // beforeRequest hooks may mutate options (e.g. set context) or throw to abort
  // the request (dry-run mode). Return values are ignored, matching how cdxgen
  // uses these hooks with got.
  for (const hook of options.hooks?.beforeRequest || []) {
    await hook(options);
  }

  const { body, headers } = resolveRequestBody(options);
  const method = (options.method || "GET").toUpperCase();

  // Serve cacheable GET requests from the in-memory cache when enabled. A
  // request opts out with `cache: false`, as token exchanges do.
  const cacheable =
    method === "GET" && options.cache !== false && !isCacheDisabled();
  const cacheKey = cacheable
    ? cacheKeyFor(method, url, headers, options.responseType)
    : undefined;
  if (cacheable) {
    const cached = cacheGet(cacheKey);
    if (cached) {
      return cached;
    }
  }

  // Runs only when the request is about to reach the network, so a caller
  // that rate-limits a host does not wait for a response already cached.
  for (const hook of options.hooks?.beforeNetwork || []) {
    await hook(options);
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
    undiciResponse = await requestWithRedirects(
      url,
      requestOptions,
      followRedirect,
    );
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
    cacheSet(cacheKey, finalResponse);
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
