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
 * have. When it is absent, disabled, or unusable, and whenever a dry run,
 * secure mode or a host allowlist is in force, the JS pool runs every request
 * through `cdxgenAgent` so those policies, the activity recorder and the test
 * cassette interceptor all still apply.
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
 *    resolve for a transport reason is left to the caller, whose own request
 *    goes through {@link gatedGet} and the same per-host gate. A URL the server
 *    answered with an error status, after the batch's retries, is recorded as
 *    such, so the caller does not ask again only to get the same answer, and a
 *    404 or 410 is remembered for the rest of the run.
 */

import { createHash } from "node:crypto";

import {
  BLOCKED_HOST_ERROR_CODE,
  cdxgenAgent,
  DEBUG_MODE,
  DRY_RUN_ERROR_CODE,
  isDryRun,
  isSecureMode,
  readEnvironmentVariable,
} from "../core/activity.js";
import { isLedgerEnabled, recordDegradation } from "../core/buildLedger.js";
import { registerRunReset } from "../core/runState.js";
import { resolveCacheDir } from "./cacheDir.js";
import { cdxrsAvailable, runCdxrs } from "./cdxrs.js";
import {
  credentialsFor,
  DEFAULT_GLOBAL_CONCURRENCY,
  makeSemaphore,
  policyFor,
  RateLimiter,
} from "./fetchRate.js";

/** Envelope version understood by this bridge; must match Rust's. */
const BATCH_SCHEMA_VERSION = 1;

/**
 * Timeout for one batch. Registry I/O for a large project legitimately takes
 * minutes on a cold cache, so this is far longer than the bridge default; both
 * the Rust subprocess and each JS request bound themselves on their own.
 */
const DEFAULT_BATCH_TIMEOUT_MS = 600_000;

/**
 * Maximum retry attempts for a transient failure (5xx, 429, transport errors).
 * Matches the Rust client's `MAX_RETRIES` so the two transports have the same
 * retry budget.
 */
const MAX_RETRIES = 3;

/**
 * Cap for exponential backoff, including jitter. Matches `rate.rs`/`client.rs`.
 */
const BACKOFF_CAP_MS = 30_000;

let _availabilityChecked = false;
let _available = false;

// ---------------------------------------------------------------------------
// JS batcher state.
//
// The in-flight map deduplicates concurrent requests for the same URL *across*
// batches: two `prefetchJson` calls that overlap in time and share a URL share
// a single HTTP request. The per-batch deduplication (identical URLs in the
// same request list) is handled by the `seen` Set before dispatch. Together
// these guarantee one request per unique URL under concurrency, which the
// serial path got for free from `await`-in-a-loop and which the in-memory
// `responseCache` cannot provide because it is populated only after a response
// arrives (and is disabled entirely under `CDXGEN_NO_CACHE`).
// ---------------------------------------------------------------------------

/** @type {Map<string, Promise<BatchEntry>>} Keyed by `${url}|${accept}|${authRealm}`. */
const _inFlight = new Map();

/** @type {Map<string, {sem: ReturnType<typeof makeSemaphore>, limiter: RateLimiter}>} */
const _hostSemaphores = new Map();

/** @type {Map<string, RateLimiter>} Kept for the external-delay count; cleared on reset. */
const _hostLimiters = new Map();

const _globalSemaphore = makeSemaphore(DEFAULT_GLOBAL_CONCURRENCY);

/**
 * Hosts that rate-limit by client IP and escalate the block when it keeps
 * receiving requests. Maven Central's documented blocks grow to as long as 30
 * days for sustained over-use, so a 429 from any of these pauses every further
 * request to that host instead of being retried.
 */
const CIRCUIT_BREAKER_HOSTS = new Map([
  ["repo1.maven.org", "maven-central"],
  ["repo.maven.apache.org", "maven-central"],
  ["search.maven.org", "maven-search"],
  ["central.sonatype.com", "maven-search"],
]);

/** How long a paused host stays paused when the server sends no Retry-After. */
const DEFAULT_CIRCUIT_OPEN_MS = 10 * 60 * 1000;

/** Host to the time its pause ends. */
const _openCircuits = new Map();

/**
 * Requests a host may answer with HTTP 429, after their retries, before it is
 * paused. Maven Central and its search are paused on the first.
 */
const RATE_LIMITED_REQUESTS_BEFORE_PAUSE = 3;

/** Host to the number of its requests that ended in HTTP 429 this run. */
const _rateLimitedRequests = new Map();

/**
 * Requests that answered 404 or 410, so that no later pass of the same run asks
 * again. Keyed by {@link missKey}, with the time the entry lapses, so that a
 * process that never resets its run state still sees new releases.
 */
const _definiteMisses = new Map();
const DEFINITE_MISS_TTL_MS = 60 * 60 * 1000;

registerRunReset("fetch:misses-and-rate-limits", () => {
  _definiteMisses.clear();
  _rateLimitedRequests.clear();
});

/**
 * Whether requests to a host are paused.
 *
 * @param {string|null} host Hostname.
 * @returns {boolean}
 */
export function isHostCircuitOpen(host) {
  if (!host) {
    return false;
  }
  const until = _openCircuits.get(host.toLowerCase());
  if (until === undefined) {
    return false;
  }
  if (until > Date.now()) {
    return true;
  }
  _openCircuits.delete(host.toLowerCase());
  return false;
}

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
export function openHostCircuit(host, { delayMs, cause, quiet } = {}) {
  if (!host) {
    return;
  }
  const key = host.toLowerCase();
  const wasOpen = isHostCircuitOpen(key);
  const until = Date.now() + Math.max(delayMs || 0, DEFAULT_CIRCUIT_OPEN_MS);
  _openCircuits.set(key, Math.max(until, _openCircuits.get(key) || 0));
  if (wasOpen || quiet) {
    return;
  }
  const minutes = Math.ceil((_openCircuits.get(key) - Date.now()) / 60000);
  const what = cause || "rate limited this machine";
  const breaker = CIRCUIT_BREAKER_HOSTS.get(key);
  if (breaker === "maven-search") {
    console.warn(
      `${host} ${what}, so jar identification by hash skips it for the next ${minutes} minute(s). Set SEARCH_MAVEN_ORG=false to turn these lookups off.`,
    );
  } else if (breaker === "maven-central") {
    console.warn(
      `${host} ${what}, so cdxgen will not contact it for the next ${minutes} minute(s) and Maven metadata comes from local caches only. Set MAVEN_CENTRAL_URL to a mirror or repository manager, for example https://maven-central.storage-download.googleapis.com/maven2/, to keep license enrichment working.`,
    );
  } else {
    console.warn(
      `${host} ${what}, so cdxgen will not contact it for the next ${minutes} minute(s). The components it would describe keep the metadata found locally.`,
    );
  }
  recordPolicyDegradationOnce("policy.rate-limited", {
    ecosystem: "generic",
    impact: "licenses",
    detail: `${host} ${what}, so further requests to it were skipped.`,
  });
}

/**
 * Clear every paused host. Tests only.
 *
 * @returns {void}
 */
export function resetHostCircuits() {
  _openCircuits.clear();
  _rateLimitedRequests.clear();
}

/**
 * The error a request to a paused host fails with, shaped like an HTTP 429 so
 * callers treat it the way they treat the response that opened the circuit.
 *
 * @param {string} host Hostname.
 * @returns {Error}
 */
function hostCircuitOpenError(host) {
  const err = new Error(
    `Response code 429 (requests to ${host} are paused after it rate limited this run)`,
  );
  err.name = "HTTPError";
  err.code = "CDXGEN_HOST_CIRCUIT_OPEN";
  err.statusCode = 429;
  err.response = { statusCode: 429, headers: {} };
  return err;
}

/**
 * Open the circuit for a breaker host that answered 429.
 *
 * @param {string|null} host Hostname.
 * @param {number|undefined} status HTTP status.
 * @param {Object} [headers] Response headers.
 * @returns {boolean} True when the circuit was opened.
 */
function tripOnRateLimit(host, status, headers) {
  if (
    status !== 429 ||
    !host ||
    !CIRCUIT_BREAKER_HOSTS.has(host.toLowerCase())
  ) {
    return false;
  }
  openHostCircuit(host, {
    delayMs: parseRetryAfter({ headers }),
    cause: "answered HTTP 429 (rate limited)",
  });
  return true;
}

/**
 * Count a request to a host that ended in HTTP 429 once its retries ran out,
 * and pause the host once it has refused several. Breaker hosts are paused on
 * the first by {@link tripOnRateLimit}.
 *
 * @param {string|null} host Hostname.
 * @param {Object} [headers] Response headers, for the server's back-off.
 * @returns {void}
 */
function noteRateLimited(host, headers) {
  if (!host || CIRCUIT_BREAKER_HOSTS.has(host.toLowerCase())) {
    return;
  }
  const key = host.toLowerCase();
  const count = (_rateLimitedRequests.get(key) || 0) + 1;
  _rateLimitedRequests.set(key, count);
  if (count >= RATE_LIMITED_REQUESTS_BEFORE_PAUSE) {
    openHostCircuit(host, {
      delayMs: parseRetryAfter({ headers }),
      cause: `answered HTTP 429 (rate limited) to ${count} requests`,
    });
  }
}

/**
 * The key a definite miss is remembered under: the URL, and the credential it
 * was asked with, since a private document can be missing to an anonymous
 * request only. A credential enters the key as a digest, never as itself.
 *
 * @param {string} url Request URL.
 * @param {{authRealm?: string, headers?: Object}} [request] Request details.
 * @returns {string}
 */
function missKey(url, { authRealm, headers } = {}) {
  const authorization = headers?.Authorization || headers?.authorization;
  const credential = authorization
    ? createHash("sha256").update(String(authorization)).digest("hex")
    : "";
  return `${url}|${authRealm || ""}|${credential}`;
}

/**
 * The status a request answered with when it was last asked this run, if that
 * was 404 or 410.
 *
 * @param {string} key Key from {@link missKey}.
 * @returns {number|undefined}
 */
function rememberedMiss(key) {
  const miss = _definiteMisses.get(key);
  if (!miss) {
    return undefined;
  }
  if (miss.until > Date.now()) {
    return miss.status;
  }
  _definiteMisses.delete(key);
  return undefined;
}

/**
 * Remember a 404 or 410 for the rest of the run.
 *
 * @param {string} key Key from {@link missKey}.
 * @param {number|undefined} status HTTP status.
 * @returns {void}
 */
function rememberIfMissing(key, status) {
  if (status === 404 || status === 410) {
    _definiteMisses.set(key, { status, until: Date.now() + DEFINITE_MISS_TTL_MS });
  }
}

/**
 * Statistics from the most recent batch, or null when no batch has run.
 *
 * Exposed so a test can assert that the Rust path was *used*, not merely
 * available: a silent fallback to the JS agent would otherwise make a parity
 * comparison compare the JS path with itself and pass.
 */
let _lastStats = null;

/**
 * @returns {Object|null} Stats from the last batch (requests, unique, ok,
 *   failures, cacheHits, elapsedMs, peakConcurrency), or null.
 */
export function lastBatchStats() {
  return _lastStats;
}

/**
 * Whether batched fetching through cdxrs is available.
 *
 * Memoized because the probe spawns the binary, and this is consulted once per
 * metadata function rather than once per run.
 *
 * @returns {boolean} True when `cdxrs fetch` can be used.
 */
export function batchFetchAvailable() {
  if (_availabilityChecked) {
    return _available;
  }
  _availabilityChecked = true;
  _available = cdxrsAvailable("fetch").available === true;
  return _available;
}

/**
 * Reset the memoized availability probe and the JS batcher's in-flight map.
 * Tests only.
 */
export function resetBatchFetchAvailability() {
  _availabilityChecked = false;
  _available = false;
  _lastStats = null;
  _inFlight.clear();
  _hostSemaphores.clear();
  _hostLimiters.clear();
}

/**
 * The outcome recorded for a single URL in a batch.
 *
 * @typedef {Object} BatchEntry
 * @property {boolean} ok Whether a body was obtained.
 * @property {*} [body] Parsed response body when `ok`.
 * @property {number} [status] HTTP status, when the server produced one.
 * @property {boolean} [definite] True when the status is a final answer (a 4xx
 *   other than 429) and re-requesting it in JS would be pointless.
 */

/**
 * Build the cdxrs fetch arguments for cache control.
 *
 * JS is the authority for the cache directory, so `--cache-dir` is always
 * passed when a directory resolves. `--no-cache` and `--cache-ttl` are passed
 * only when the user opts in.
 *
 * @returns {string[]} Extra args for `cdxrs fetch`.
 */
function buildCacheArgs() {
  const args = [];
  if (
    readEnvironmentVariable("CDXGEN_NO_CACHE") === "true" ||
    readEnvironmentVariable("CDXGEN_NO_CACHE") === "1"
  ) {
    args.push("--no-cache");
    return args;
  }
  const dir = resolveCacheDir();
  if (dir) {
    args.push("--cache-dir", dir);
  }
  if (readEnvironmentVariable("CDXGEN_CACHE_TTL") != null) {
    const ttl = Number.parseInt(
      readEnvironmentVariable("CDXGEN_CACHE_TTL"),
      10,
    );
    if (Number.isFinite(ttl) && ttl >= 0) {
      args.push("--cache-ttl", String(ttl));
    }
  }
  return args;
}

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
export async function prefetchJson(requests, options = {}) {
  const empty = new Map();
  if (!Array.isArray(requests) || !requests.length) {
    return empty;
  }
  if (!prefetchEnabled()) {
    return empty;
  }

  // The URL is the correlation id: callers look results up by the URL they
  // were going to request anyway, so there is no separate id to keep in sync.
  const seen = new Set();
  const unique = [];
  for (const request of requests) {
    if (!request?.url || seen.has(request.url)) {
      continue;
    }
    seen.add(request.url);
    unique.push(request);
  }
  if (!unique.length) {
    return empty;
  }

  // A paused host is not asked again, and neither is a document that answered
  // 404 or 410 earlier in the run. Those URLs fail at once and definitely, so
  // callers do not retry them on their own either.
  const answered = new Map();
  const runnable = [];
  for (const request of unique) {
    const missing = rememberedMiss(missKey(request.url, request));
    if (missing) {
      answered.set(request.url, { ok: false, status: missing, definite: true });
    } else if (isHostCircuitOpen(extractHost(request.url))) {
      answered.set(request.url, { ok: false, status: 429, definite: true });
    } else {
      runnable.push(request);
    }
  }
  if (!runnable.length) {
    return answered;
  }
  const results =
    cdxrsMayFetch() &&
    batchFetchAvailable() &&
    runnable.every(cdxrsCanServe)
      ? await rustBatchFetch(runnable, options)
      : await jsBatchFetch(runnable);
  for (const request of runnable) {
    rememberIfMissing(
      missKey(request.url, request),
      results.get(request.url)?.status,
    );
  }
  for (const [url, entry] of answered) {
    results.set(url, entry);
  }
  return results;
}

/**
 * Whether cdxrs may make this run's requests at all.
 *
 * cdxrs opens its own connections, so the rules cdxgenAgent applies to every
 * request would not reach them: a dry run makes no request, secure mode allows
 * only HTTPS and follows no redirect, and `CDXGEN_ALLOWED_HOSTS` names the only
 * hosts that may be contacted. While any of them is in force the JS pool makes
 * every request, through cdxgenAgent.
 *
 * @returns {boolean}
 */
function cdxrsMayFetch() {
  return (
    !isDryRun &&
    !isSecureMode &&
    !readEnvironmentVariable("CDXGEN_ALLOWED_HOSTS")
  );
}

/**
 * Whether cdxrs can serve a request without losing part of it.
 *
 * The protocol carries a URL, an `accept` value and an opaque `authRealm`, and
 * types a result body as JSON. Two kinds of request therefore have no faithful
 * representation in it and run on the JS pool instead:
 *
 * - a non-JSON `responseType`, since the envelope has nowhere to put HTML;
 * - request-specific `headers`, since cdxrs derives its own Authorization from
 *   `GITHUB_TOKEN` and would silently drop any other credential, turning an
 *   authenticated lookup into an anonymous one;
 * - anything addressed to a host whose rate policy only one transport knows.
 *   crates.io's crawler policy allows one request per second with no
 *   parallelism, and package.elm-lang.org has a JS-only allowance because
 *   rate.rs carries no row for it. Both transports keep separate gates, so a
 *   batch split across the two would issue twice the agreed rate; the JS pool
 *   owns these hosts so there is one gate to reason about.
 *
 * The pool applies the same global and per-host concurrency and rate policy, so
 * the batching win is unaffected; only the on-disk cache is skipped.
 *
 * @param {{url?: string, responseType?: string, headers?: Object}} request
 * @returns {boolean}
 */
function cdxrsCanServe(request) {
  if (request.responseType && request.responseType !== "json") {
    return false;
  }
  if (isSingleGateHost(extractHost(request.url))) {
    return false;
  }
  return !request.headers || !Object.keys(request.headers).length;
}

/**
 * Whether a hostname belongs to crates.io, including its index and CDN hosts.
 *
 * @param {string|null} host Hostname, or null when the URL did not parse.
 * @returns {boolean}
 */
export function isCratesHost(host) {
  if (!host) {
    return false;
  }
  const lower = host.toLowerCase();
  return lower === "crates.io" || lower.endsWith(".crates.io");
}

/**
 * Whether a host's rate policy lives in the JS table alone and therefore needs
 * every request to pass through the one gate the JS pool holds.
 *
 * @param {string|null} host Hostname, or null when the URL did not parse.
 * @returns {boolean}
 */
export function isSingleGateHost(host) {
  if (!host) {
    return false;
  }
  return isCratesHost(host) || host.toLowerCase() === "package.elm-lang.org";
}

/**
 * Most URLs sent to one `cdxrs fetch` run. The envelope comes back as a single
 * JSON string and V8 caps strings at ~512 MB, while a full npm packument is a
 * few hundred KB on average and tens of MB for the largest packages. One run
 * per workspace therefore outgrew the limit on large pnpm workspaces (issue
 * 4393); runs of this size stay far below it for any realistic mix.
 */
const RUST_FETCH_CHUNK_SIZE = 250;

/**
 * Run the batch through the `cdxrs fetch` subprocess and translate its
 * envelope into the shared result shape.
 *
 * The URLs go out in chunks of {@link RUST_FETCH_CHUNK_SIZE}, one run at a time
 * so each host still sees a single rate gate. A chunk whose envelope is still
 * too large to deliver is split in half and retried, which is cheap because
 * the first attempt filled the cdxrs disk cache. A chunk that fails for any
 * other reason falls back to the JS pool on its own, so one bad run never
 * costs the rest of the batch its Rust fetch.
 *
 * @param {Array<{url: string, accept?: string, authRealm?: string}>} unique
 *   Already deduplicated by URL.
 * @param {Object} options Options with `timeoutMs`.
 * @returns {Promise<Map<string, BatchEntry>>}
 */
async function rustBatchFetch(unique, options) {
  const pending = [];
  for (let i = 0; i < unique.length; i += RUST_FETCH_CHUNK_SIZE) {
    pending.push(unique.slice(i, i + RUST_FETCH_CHUNK_SIZE));
  }
  const results = new Map();
  const chunkStats = [];
  while (pending.length) {
    const chunk = pending.shift();
    const outcome = await rustFetchChunk(chunk, options);
    if (outcome.reason === "stdout-too-large" && chunk.length > 1) {
      const middle = Math.ceil(chunk.length / 2);
      pending.unshift(chunk.slice(0, middle), chunk.slice(middle));
      continue;
    }
    if (!outcome.results) {
      // Not "binary absent" (that never reaches here), so fall through to the
      // JS pool rather than returning nothing: a transient cdxrs crash must
      // not take this chunk's concurrency with it.
      for (const [url, entry] of await jsBatchFetch(chunk)) {
        results.set(url, entry);
      }
      chunkStats.push(_lastStats);
      continue;
    }
    for (const [url, entry] of outcome.results) {
      results.set(url, entry);
    }
    chunkStats.push(outcome.stats);
  }
  _lastStats = combineBatchStats(chunkStats);
  if (DEBUG_MODE && _lastStats) {
    const s = _lastStats;
    console.log(
      `cdxrs fetch: ${s.requests} url(s), ${s.unique} unique, ${s.ok} ok, ${s.failures} failed, ${s.cacheHits} cached, peak concurrency ${s.peakConcurrency}, ${s.elapsedMs} ms`,
    );
  }
  return results;
}

/**
 * Add up the stats of the runs that served one batch. Numeric fields sum
 * because the runs are sequential, except peak concurrency, which is the
 * widest run. Per-host entries under `hosts` are combined the same way.
 *
 * @param {Array<Object|null|undefined>} parts Stats from each run.
 * @returns {Object|null} Combined stats, or null when no run reported any.
 */
function combineBatchStats(parts) {
  const reported = parts.filter(Boolean);
  if (!reported.length) {
    return null;
  }
  if (reported.length === 1) {
    return reported[0];
  }
  const combined = addStats({}, reported);
  const hosts = {};
  for (const part of reported) {
    for (const [host, entry] of Object.entries(part.hosts || {})) {
      hosts[host] = addStats(hosts[host] || {}, [entry]);
    }
  }
  if (Object.keys(hosts).length) {
    combined.hosts = hosts;
  }
  return combined;
}

function addStats(target, parts) {
  for (const part of parts) {
    for (const [key, value] of Object.entries(part)) {
      if (typeof value !== "number") {
        continue;
      }
      target[key] =
        key === "peakConcurrency"
          ? Math.max(target[key] || 0, value)
          : (target[key] || 0) + value;
    }
  }
  return target;
}

/**
 * Run one chunk through `cdxrs fetch`.
 *
 * @param {Array<{url: string, accept?: string, authRealm?: string}>} chunk
 * @param {Object} options Options with `timeoutMs`.
 * @returns {Promise<{results?: Map<string, BatchEntry>, stats?: Object, reason?: string}>}
 *   `results` when the run succeeded; otherwise the reason it did not.
 */
async function rustFetchChunk(chunk, options) {
  const payload = { requests: [] };
  for (const request of chunk) {
    payload.requests.push({
      id: request.url,
      url: request.url,
      ...(request.accept ? { accept: request.accept } : {}),
      ...(request.authRealm ? { authRealm: request.authRealm } : {}),
    });
  }

  const { ok, stdout, reason } = await runCdxrs("fetch", {
    content: JSON.stringify(payload),
    timeoutMs: options.timeoutMs || DEFAULT_BATCH_TIMEOUT_MS,
    args: buildCacheArgs(),
  });
  if (!ok) {
    if (DEBUG_MODE && reason !== "disabled" && reason !== "binary-not-found") {
      console.log(
        reason === "stdout-too-large" && chunk.length > 1
          ? `cdxrs fetch output for ${chunk.length} url(s) is too large; retrying in two halves.`
          : `cdxrs fetch unavailable (${reason}); falling back to the JS batch pool.`,
      );
    }
    return { reason };
  }

  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch (_err) {
    return { reason: "malformed-envelope" };
  }
  if (envelope?.schemaVersion !== BATCH_SCHEMA_VERSION) {
    // A binary from a different generation of this protocol is not something
    // to guess at. Fall back rather than misread its output.
    if (DEBUG_MODE) {
      console.log(
        `cdxrs fetch envelope version ${envelope?.schemaVersion} != ${BATCH_SCHEMA_VERSION}; falling back to the JS batch pool.`,
      );
    }
    return { reason: "version-mismatch" };
  }

  const results = new Map();
  for (const result of envelope.results || []) {
    if (!result?.id) {
      continue;
    }
    if (result.ok) {
      results.set(result.id, { ok: true, body: result.body });
      continue;
    }
    // 4xx other than 429 is the registry's final answer. Anything else — a
    // timeout, a connection reset, an offline cache miss — is worth one more
    // try through the JS agent, which has its own proxy and auth handling.
    const status =
      typeof result.status === "number" ? result.status : undefined;
    // cdxrs has already honoured Retry-After. A breaker host that still says
    // 429 is paused, and the caller must not ask it again.
    const tripped = tripOnRateLimit(extractHost(result.id), status, {});
    if (status === 429 && !tripped) {
      noteRateLimited(extractHost(result.id), {});
    }
    const definite =
      tripped || (status >= 400 && status < 500 && status !== 429);
    results.set(result.id, { ok: false, status, definite });
  }
  return { results, stats: envelope.stats || null };
}

/**
 * Resolve or create the per-host semaphore and rate limiter.
 *
 * @param {string} host Lowercased hostname.
 * @returns {{sem: ReturnType<typeof makeSemaphore>, limiter: RateLimiter}}
 */
function getHostControls(host) {
  let entry = _hostSemaphores.get(host);
  if (!entry) {
    const policy = policyFor(host, credentialsFor(host));
    entry = {
      sem: makeSemaphore(policy.maxConcurrency),
      limiter: new RateLimiter(policy.minInterval),
    };
    _hostSemaphores.set(host, entry);
    _hostLimiters.set(host, entry.limiter);
  }
  return entry;
}

/**
 * Extract the hostname from a URL, returning null when the URL cannot be
 * parsed. Matching `client.rs::extract_host`.
 *
 * @param {string} url
 * @returns {string|null}
 */
function extractHost(url) {
  try {
    return new URL(url).hostname;
  } catch (_err) {
    return null;
  }
}

/**
 * Resolve an Authorization header to attach for this URL's host, if any.
 *
 * Mirrors the Rust client: only GitHub hosts get the token, and only when
 * `GITHUB_TOKEN` is set. The value is never logged.
 *
 * @param {string} host
 * @returns {{Authorization: string}|undefined}
 */
function resolveAuthHeader(host) {
  if (!host) {
    return undefined;
  }
  const lower = host.toLowerCase();
  const isGitHub =
    lower === "api.github.com" ||
    lower === "github.com" ||
    lower.endsWith(".github.com");
  if (isGitHub && readEnvironmentVariable("GITHUB_TOKEN")) {
    return {
      Authorization: `Bearer ${readEnvironmentVariable("GITHUB_TOKEN")}`,
    };
  }
  return undefined;
}

/**
 * Build the `cdxgenAgent.get` options for one request.
 *
 * @param {Object} request The batch request.
 * @param {string} host The request host, for auth resolution.
 * @returns {Object} Options for `cdxgenAgent.get`.
 */
function buildAgentOptions(request, host) {
  const options = {
    responseType: request.responseType || "json",
  };
  const headers = { ...(request.headers || {}) };
  if (request.accept) {
    headers.Accept = request.accept;
  }
  // A credential the caller attached to this request is the specific one; the
  // ambient GITHUB_TOKEN is the fallback. Letting the fallback win would send a
  // token the caller did not choose, silently ignoring an explicitly supplied
  // one such as `--forge-token`.
  const auth = headers.Authorization ? undefined : resolveAuthHeader(host);
  if (auth) {
    headers.Authorization = auth.Authorization;
  }
  if (Object.keys(headers).length) {
    options.headers = headers;
  }
  return options;
}

/**
 * Parse a server-supplied back-off, in milliseconds.
 *
 * `Retry-After` may be seconds or an HTTP-date; `X-RateLimit-Reset` /
 * `RateLimit-Reset` is a Unix timestamp. Returns null when no recognised
 * header is present, so the caller can fall back to exponential backoff.
 * Ported from `client.rs::parse_retry_after`.
 *
 * @param {Object} response The `cdxgenAgent` response or HTTPError response.
 * @returns {number|null} Delay in milliseconds, or null.
 */
function parseRetryAfter(response) {
  const headers = response?.headers || {};
  const retryAfter = headers["retry-after"] || headers["Retry-After"];
  if (retryAfter) {
    const trimmed = String(retryAfter).trim();
    const seconds = Number.parseInt(trimmed, 10);
    if (Number.isFinite(seconds) && trimmed === String(seconds)) {
      return seconds * 1000;
    }
    // HTTP-date form.
    const target = Date.parse(trimmed);
    if (Number.isFinite(target)) {
      const delay = target - Date.now();
      return delay > 0 ? delay : 0;
    }
  }
  // GitHub sends the reset timestamp rather than Retry-After.
  for (const name of ["x-ratelimit-reset", "ratelimit-reset"]) {
    const value = headers[name];
    if (value === undefined) {
      continue;
    }
    const ts = Number.parseInt(String(value).trim(), 10);
    if (!Number.isFinite(ts)) {
      continue;
    }
    const now = Math.floor(Date.now() / 1000);
    if (ts > now) {
      return (ts - now) * 1000;
    }
    // A small value (< 1h) is a delta, a large one is an absolute timestamp.
    if (ts < 3600) {
      return ts * 1000;
    }
  }
  return null;
}

/**
 * Exponential backoff with full jitter, capped at {@link BACKOFF_CAP_MS}.
 * Matches `client.rs::exponential_backoff`.
 *
 * @param {number} attempt 1-based attempt number.
 * @returns {number} Delay in milliseconds.
 */
function exponentialBackoffMs(attempt) {
  const shift = Math.min(attempt, 8);
  const baseMs = 100 * (1 << shift);
  const jitter = Math.floor(Math.random() * (baseMs + 1));
  return Math.min(baseMs + jitter, BACKOFF_CAP_MS);
}

/**
 * Issue one request through `cdxgenAgent`, with bounded retries for transient
 * failures and server-supplied back-offs.
 *
 * The caller already holds the global and per-host permits; this function
 * consults the per-host rate limiter on every attempt (including retries) and
 * pushes the gate out when the server asks us to slow down, matching the
 * Rust client's retry loop.
 *
 * @param {Object} request The batch request.
 * @param {RateLimiter} limiter The per-host rate limiter.
 * @returns {Promise<BatchEntry>}
 */
async function issueWithRetries(request, limiter) {
  const host = extractHost(request.url);
  const options = {
    ...buildAgentOptions(request, host),
    // The limiter is consulted only when the request is about to reach the
    // network; a response already in the cache does not wait for a slot.
    hooks: { beforeNetwork: [() => limiter.wait()] },
  };
  let attempt = 0;
  while (true) {
    attempt++;
    if (isHostCircuitOpen(host)) {
      return { ok: false, status: 429, definite: true };
    }
    let result;
    try {
      const res = await cdxgenAgent.get(request.url, options);
      result = {
        retryable: false,
        delay: null,
        entry: { ok: true, body: res.body, status: res.statusCode },
      };
    } catch (err) {
      result = classifyAgentError(err);
      if (
        tripOnRateLimit(host, err?.response?.statusCode, err?.response?.headers)
      ) {
        return { ok: false, status: 429, definite: true };
      }
    }
    if (result.retryable && attempt <= MAX_RETRIES) {
      const delay =
        result.delay !== null && result.delay !== undefined
          ? result.delay
          : exponentialBackoffMs(attempt);
      // A server-supplied delay wins over our own backoff and is recorded
      // against the host bucket so the next attempt respects it too.
      if (result.delay !== null && result.delay !== undefined) {
        limiter.externalDelay(delay);
      }
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      continue;
    }
    if (result.entry.status === 429) {
      noteRateLimited(host, result.headers);
    }
    return result.entry;
  }
}

/** Policy and connectivity degradations already recorded this run; these describe the run, not one URL. */
const recordedPolicyDegradations = new Set();
registerRunReset("fetch:policy-records", () =>
  recordedPolicyDegradations.clear(),
);

/**
 * Record a run-level policy or connectivity degradation once per process. A
 * batch touches many URLs, but "dry-run blocked the network", "a host was not
 * permitted" and "the network is unreachable" are properties of the run, so
 * only the first occurrence is recorded and the report reads one line, not
 * one per URL.
 *
 * @param {string} remediationId Remediation id from data/remediations.json
 * @param {Object} fields Ledger event fields
 * @returns {void}
 */
function recordPolicyDegradationOnce(remediationId, fields) {
  if (!isLedgerEnabled() || recordedPolicyDegradations.has(remediationId)) {
    return;
  }
  recordedPolicyDegradations.add(remediationId);
  recordDegradation(remediationId, fields);
}

/**
 * Record the run-level policy or connectivity condition carried by a caught
 * fetch error, if it names one. Shared by the batch retry loop and by the
 * serial enrichment paths that catch and swallow the same typed errors.
 *
 * @param {Error} err Error caught from a `cdxgenAgent` request.
 * @returns {void}
 */
export function recordPolicyDegradationFromError(err) {
  if (err?.code === DRY_RUN_ERROR_CODE) {
    recordPolicyDegradationOnce("policy.dry-run", {
      ecosystem: "generic",
      impact: "none",
      detail: `Dry-run mode blocked a registry request: ${err.message}`,
    });
  } else if (err?.code === BLOCKED_HOST_ERROR_CODE) {
    recordPolicyDegradationOnce("policy.host-blocked", {
      ecosystem: "generic",
      impact: "licenses",
      detail: `A registry request was blocked by policy: ${err.message}`,
    });
  } else if (err?.name === "RequestError") {
    recordPolicyDegradationOnce("policy.offline", {
      ecosystem: "generic",
      impact: "licenses",
      detail:
        "A registry request failed with a transport error, so registry metadata and license enrichment may be missing.",
    });
  }
}

/**
 * Classify an error thrown by `cdxgenAgent.get` into a retry decision and the
 * batch entry to record when retries are exhausted.
 *
 * @param {Error} err
 * @returns {{retryable: boolean, delay: number|null, entry: BatchEntry}}
 */
function classifyAgentError(err) {
  recordPolicyDegradationFromError(err);
  // Secure-mode and dry-run blocks must not be retried, and the caller's own
  // fallback `cdxgenAgent.get` will surface the same error. Recording this as
  // non-definite lets the caller's catch run exactly as it would on the serial
  // path.
  if (err?.options?.context?.activityBlocked) {
    return {
      retryable: false,
      delay: null,
      entry: { ok: false, status: undefined, definite: false },
    };
  }
  const status = err?.response?.statusCode;
  const headers = err?.response?.headers;
  if (status === 429) {
    return {
      retryable: true,
      delay: parseRetryAfter({ headers }),
      headers,
      entry: { ok: false, status, definite: false },
    };
  }
  if (status >= 500 && status < 600) {
    return {
      retryable: true,
      delay: null,
      entry: { ok: false, status, definite: false },
    };
  }
  if (status >= 400 && status < 500) {
    return {
      retryable: false,
      delay: null,
      entry: { ok: false, status, definite: true },
    };
  }
  // Transport error (timeout, connection reset). The name check mirrors how
  // httpClient.js distinguishes its two error classes.
  if (err?.name === "RequestError") {
    return {
      retryable: true,
      delay: null,
      entry: { ok: false, status: undefined, definite: false },
    };
  }
  // Unknown error shape: do not retry, let the caller's fallback decide.
  return {
    retryable: false,
    delay: null,
    entry: { ok: false, status, definite: false },
  };
}

/**
 * Fetch one URL with global + per-host concurrency control.
 *
 * Permits are held for the whole retry sequence, including back-off sleeps, so
 * a host that is asking us to slow down does not get four more slots opened
 * against it in the meantime. The in-flight counter is incremented after both
 * permits are acquired, so the peak it records is real HTTP concurrency rather
 * than tasks queued behind the semaphores; it matches the Rust client's
 * `InFlightGuard`.
 *
 * @param {Object} request
 * @param {{inFlight: number, peak: number}} gauge Batch-scoped concurrency
 *   gauge. Scoped to one batch rather than to the module so that the peak a
 *   batch reports describes that batch: a process-wide high-water mark would
 *   report the widest batch so far for every batch after it, including a
 *   single-URL one, and so could not evidence that any given batch fanned out.
 * @returns {Promise<BatchEntry>}
 */
async function fetchOne(request, gauge) {
  const host = extractHost(request.url);
  if (!host) {
    return { ok: false, status: undefined, definite: false };
  }
  const controls = getHostControls(host);
  const releaseGlobal = await _globalSemaphore.acquire();
  const releaseHost = await controls.sem.acquire();
  gauge.inFlight += 1;
  if (gauge.inFlight > gauge.peak) {
    gauge.peak = gauge.inFlight;
  }
  try {
    return await issueWithRetries(request, controls.limiter);
  } finally {
    gauge.inFlight -= 1;
    releaseHost();
    releaseGlobal();
  }
}

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
export async function withHostRateLimit(url, issue, { deferGate } = {}) {
  const host = extractHost(url);
  if (!host) {
    return await issue({});
  }
  if (isHostCircuitOpen(host)) {
    throw hostCircuitOpenError(host);
  }
  const controls = getHostControls(host);
  const releaseGlobal = await _globalSemaphore.acquire();
  const releaseHost = await controls.sem.acquire();
  try {
    let gate = {};
    if (deferGate) {
      gate = { hooks: { beforeNetwork: [() => controls.limiter.wait()] } };
    } else {
      await controls.limiter.wait();
    }
    return await issue(gate);
  } catch (err) {
    const status = err?.response?.statusCode;
    if (
      !tripOnRateLimit(host, status, err?.response?.headers) &&
      status === 429
    ) {
      noteRateLimited(host, err.response.headers);
    }
    throw err;
  } finally {
    releaseHost();
    releaseGlobal();
  }
}

/**
 * Request a URL the batch did not answer, the way the pool would have: behind
 * the per-host gate, failing at once for a document that already answered 404
 * or 410 this run, and remembering such an answer for the next pass.
 *
 * This is the fallback every metadata function uses after a prefetch. Without
 * it, a URL the batch left open went straight to the network with no rate gate,
 * and the same miss was asked again on every pass.
 *
 * @param {string} url URL to request.
 * @param {Object} [options] `cdxgenAgent.get` options.
 * @returns {Promise<Object>} The response.
 * @throws {Error} The request's own error, or a 404-shaped error for a
 *   remembered miss, so the caller's `catch` runs as it would for the network.
 */
export async function gatedGet(url, options = {}) {
  const key = missKey(url, options);
  const missing = rememberedMiss(key);
  if (missing) {
    throw httpStatusError(url, missing, {}, "already answered this run");
  }
  try {
    return await withHostRateLimit(
      url,
      (gate) =>
        cdxgenAgent.get(url, {
          ...options,
          hooks: {
            ...options.hooks,
            beforeNetwork: [
              ...(options.hooks?.beforeNetwork || []),
              ...(gate.hooks?.beforeNetwork || []),
            ],
          },
        }),
      { deferGate: true },
    );
  } catch (err) {
    rememberIfMissing(key, err?.response?.statusCode ?? err?.statusCode);
    throw err;
  }
}

/**
 * Dedupe key for an in-flight request: the URL, plus everything that changes
 * which response the caller gets back. That is the headers which change what
 * the server returns, and the decode mode, which changes how the same bytes are
 * handed over — two callers wanting one URL as JSON and as text cannot share a
 * promise. Raw credential values are never part of the key; `authRealm` is an
 * opaque label the caller chooses.
 *
 * @param {Object} request
 * @returns {string}
 */
function inFlightKey(request) {
  return [
    request.url,
    request.accept || "",
    request.authRealm || "",
    request.responseType || "json",
  ].join("|");
}

/**
 * Run the batch through the JS pool: every request goes through
 * `cdxgenAgent`, so the secure-mode host allowlist, the activity recorder and
 * the test cassette interceptor all still apply.
 *
 * @param {Array<{url: string, accept?: string, authRealm?: string, responseType?: ("json"|"text"|"buffer"), headers?: Object}>} unique
 *   Already deduplicated by URL.
 * @returns {Promise<Map<string, BatchEntry>>}
 */
async function jsBatchFetch(unique) {
  const started = Date.now();
  let ok = 0;
  let failures = 0;
  const results = new Map();
  // Concurrency is counted per batch. A request served from another batch's
  // in-flight promise is counted against that batch, not this one.
  const gauge = { inFlight: 0, peak: 0 };
  const tasks = unique.map(async (request) => {
    const key = inFlightKey(request);
    // Cross-batch in-flight dedupe. If another batch already has this URL in
    // flight, await its promise rather than issuing a second request. The
    // entry is removed when the promise settles, so a later request for the
    // same URL (after completion) goes through `responseCache` or, under
    // `CDXGEN_NO_CACHE`, issues a fresh request — which is correct.
    let promise = _inFlight.get(key);
    if (!promise) {
      promise = fetchOne(request, gauge);
      _inFlight.set(key, promise);
      // Remove on settle so the map does not grow unbounded and a later,
      // non-overlapping request for the same URL is not served a stale
      // in-flight promise.
      const clear = () => {
        const current = _inFlight.get(key);
        if (current === promise) {
          _inFlight.delete(key);
        }
      };
      promise.then(clear, clear);
    }
    const entry = await promise;
    if (entry.ok) {
      ok += 1;
    } else {
      failures += 1;
    }
    results.set(request.url, entry);
  });
  await Promise.all(tasks);

  _lastStats = {
    requests: unique.length,
    unique: unique.length,
    ok,
    failures,
    cacheHits: 0,
    elapsedMs: Date.now() - started,
    peakConcurrency: gauge.peak,
  };
  if (DEBUG_MODE) {
    const s = _lastStats;
    console.log(
      `js batch: ${s.requests} url(s), ${s.ok} ok, ${s.failures} failed, peak concurrency ${s.peakConcurrency}, ${s.elapsedMs} ms`,
    );
  }
  return results;
}

/**
 * An error shaped like the agent's `HTTPError`, for an HTTP answer the batch
 * or the miss memo already holds.
 *
 * @param {string} url Request URL.
 * @param {number} status HTTP status.
 * @param {Object} [headers] Response headers.
 * @param {string} [detail] Why no request was made.
 * @returns {Error}
 */
function httpStatusError(url, status, headers = {}, detail = undefined) {
  const err = new Error(
    `Request failed with status code ${status}${detail ? ` (${detail})` : ""}`,
  );
  err.name = "HTTPError";
  err.statusCode = status;
  err.response = { statusCode: status, headers, url };
  return err;
}

/**
 * Read a prefetched response, or signal that the caller should fetch it itself.
 *
 * @param {Map<string, BatchEntry>} prefetched Result of {@link prefetchJson}.
 * @param {string} url The URL the caller is about to request.
 * @returns {{body: *}|undefined} A response-shaped object when the body is
 *   available, or `undefined` when the caller should issue its own request.
 * @throws {Error} When the server answered with an error status, so that the
 *   caller's existing `catch` treats it exactly as it treats a failed
 *   `cdxgenAgent.get`. A 5xx or a 429 is the answer after the batch's own
 *   retries, and asking once more at once would only add to the load. Only a
 *   transport failure, with no status, is left to the caller to retry.
 */
export function prefetchedResponse(prefetched, url) {
  const entry = prefetched?.get(url);
  if (!entry) {
    return undefined;
  }
  if (entry.ok) {
    return { body: entry.body };
  }
  if (entry.status !== undefined) {
    throw httpStatusError(url, entry.status, entry.headers);
  }
  return undefined;
}

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
export function prefetchEnabled() {
  if (readEnvironmentVariable("CDXGEN_CASSETTE_REPLAY") === "true") {
    return false;
  }
  return true;
}
