/**
 * The on-disk response cache of the JS batch pool.
 *
 * cdxrs keeps registry JSON on disk between runs. The requests it cannot carry
 * run on the JS pool instead: crates.io and package.elm-lang.org, which have
 * one rate gate in JS; the GitHub API, whose quota headers cdxrs does not
 * report; HTML pages such as pkg.go.dev and podspecs; and POMs. Without a disk
 * cache of their own, the most tightly limited hosts were asked again on every
 * run. All of them are kept here, in the cdxrs layout and under the same rules:
 *
 * - `<cacheDir>/cdxrs-fetch/<host>/<hash>.json`, written atomically, mode 0600,
 *   with the URL redacted;
 * - keyed by URL, method, `Accept` and the auth realm, hashed as cdxrs hashes
 *   them, so a JSON entry either side writes serves the other. A text body adds
 *   its type to the key, so cdxrs never reads it as JSON;
 * - fresh for `CDXGEN_CACHE_TTL` seconds (24 hours by default, 0 for never);
 *   a stale entry with an ETag or Last-Modified is revalidated, and is served
 *   when the server fails;
 * - loopback hosts are not cached unless `CDXGEN_CACHE_LOOPBACK=1`;
 * - least recently used entries are removed past 256 MB.
 *
 * Two rules are the JS pool's own. A release POM never changes once published,
 * so it does not expire. A 404 or 410 is kept for the same TTL, or for 24
 * hours when the TTL is 0, under a key of its own that cdxrs never reads.
 *
 * Requests that carry their own headers, such as a registry token, are never
 * cached here, and nothing is read or written during a dry run, for a host
 * outside `CDXGEN_ALLOWED_HOSTS`, or over plain HTTP in secure mode, so the
 * cache never answers a request the policy would have refused. The directory
 * is cdxgen's own, and its files are written as cdxrs writes them, without an
 * activity record per entry.
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  isAllowedHttpHost,
  isDryRun,
  isSecureMode,
  readEnvironmentVariable,
} from "../core/activity.js";
import { fetchCacheDir, resolveCacheDir } from "./cacheDir.js";

/** Matches `CACHE_SCHEMA_VERSION` in cdxrs. */
const CACHE_SCHEMA_VERSION = 2;

/** Matches cdxrs's `DEFAULT_CACHE_TTL_SECS`. */
const DEFAULT_CACHE_TTL_SECS = 24 * 60 * 60;

/** Matches cdxrs's `DEFAULT_MAX_CACHE_BYTES`. */
const MAX_CACHE_BYTES = 256 * 1024 * 1024;

/** Bytes written between byte-ceiling passes, as cdxrs computes it. */
const ENFORCEMENT_SLACK_BYTES = Math.max(MAX_CACHE_BYTES / 8, 8 * 1024 * 1024);

/** A temp file older than this is a crashed writer's. */
const ORPHAN_TEMP_MIN_AGE_SECS = 60 * 60;

let bytesSinceEnforcement = 0;
let writeSequence = 0;
/** Host directories swept for expired entries by this process. */
const sweptHostDirs = new Set();

/**
 * @typedef {Object} DiskCacheKey
 * @property {string} url Request URL.
 * @property {string} [accept] `Accept` header.
 * @property {string} [authRealm] Identity of the credential, never itself.
 * @property {string} [responseType] `json`, `text` or `buffer`.
 */

/**
 * @typedef {Object} DiskCacheEntry
 * @property {number} v Schema version.
 * @property {string} url Redacted URL.
 * @property {string} method Always `GET`.
 * @property {number} status HTTP status.
 * @property {string|null} etag ETag validator.
 * @property {string|null} last_modified Last-Modified validator.
 * @property {number} fetched_at Unix seconds when fetched or revalidated.
 * @property {*} body Response body.
 * @property {boolean} [immutable] Never expires.
 */

/**
 * Seconds since the epoch.
 *
 * @returns {number}
 */
function unixNow() {
  return Math.floor(Date.now() / 1000);
}

/**
 * The TTL for successful responses, in seconds; 0 means they never expire.
 *
 * @returns {number}
 */
function cacheTtlSecs() {
  const raw = readEnvironmentVariable("CDXGEN_CACHE_TTL");
  if (raw == null || raw === "") {
    return DEFAULT_CACHE_TTL_SECS;
  }
  const ttl = Number.parseInt(raw, 10);
  return Number.isFinite(ttl) && ttl >= 0 ? ttl : DEFAULT_CACHE_TTL_SECS;
}

/**
 * The TTL for a recorded 404 or 410, in seconds. A miss always expires, so a
 * document published later is found.
 *
 * @returns {number}
 */
function missTtlSecs() {
  return cacheTtlSecs() || DEFAULT_CACHE_TTL_SECS;
}

/**
 * The cdxrs cache key hash: SHA-256 over the schema version and each field
 * length-prefixed, with a distinct marker for an absent field, truncated to
 * 16 bytes. Fields past the four cdxrs uses only ever make a key cdxrs does
 * not read.
 *
 * @param {Array<string|undefined>} fields Key fields, in order.
 * @returns {string} 32 hex characters.
 */
function hashKeyFields(fields) {
  const hash = createHash("sha256");
  const version = Buffer.alloc(4);
  version.writeUInt32LE(CACHE_SCHEMA_VERSION);
  hash.update(version);
  for (const field of fields) {
    const length = Buffer.alloc(8);
    if (field === undefined || field === null) {
      length.writeBigUInt64LE(0xffffffffffffffffn);
      hash.update(length);
      continue;
    }
    const bytes = Buffer.from(field, "utf-8");
    length.writeBigUInt64LE(BigInt(bytes.length));
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest("hex").slice(0, 32);
}

/**
 * Hash of a cache key, as cdxrs computes it for a JSON response.
 *
 * @param {DiskCacheKey} key Cache key.
 * @param {{miss?: boolean}} [opts] Whether this is the key of a recorded miss.
 * @returns {string}
 */
export function diskCacheKeyHash(key, { miss = false } = {}) {
  const fields = [key.url, "GET", key.accept, key.authRealm];
  const responseType = key.responseType || "json";
  if (responseType !== "json") {
    fields.push(`response-type:${responseType}`);
  }
  if (miss) {
    fields.push("miss");
  }
  return hashKeyFields(fields);
}

/**
 * A URL without credentials, query or fragment, as cdxrs stores it.
 *
 * @param {string} url URL.
 * @returns {string}
 */
function redactUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch (_err) {
    return "<unparseable url>";
  }
}

/**
 * Whether a host is a loopback address, which is not cached by default: test
 * doubles there are keyed by ports that are never reused.
 *
 * @param {string} hostname Hostname.
 * @returns {boolean}
 */
function isLoopbackHost(hostname) {
  if (readEnvironmentVariable("CDXGEN_CACHE_LOOPBACK") === "1") {
    return false;
  }
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    host === "localhost" ||
    host === "::1" ||
    (host.startsWith("127.") && host.split(".").length === 4)
  );
}

/**
 * Whether a release POM, which a repository never changes once published.
 *
 * @param {string} url Request URL.
 * @returns {boolean}
 */
function isReleasePom(url) {
  const pathname = new URL(url).pathname;
  return pathname.endsWith(".pom") && !pathname.includes("-SNAPSHOT");
}

/**
 * Whether the disk cache may serve or store a request.
 *
 * @param {{url: string, headers?: Object, responseType?: string}} request
 * @returns {boolean}
 */
export function diskCacheable(request) {
  const value = readEnvironmentVariable("CDXGEN_NO_CACHE");
  if (value === "true" || value === "1" || isDryRun) {
    return false;
  }
  if (request.responseType === "buffer") {
    return false;
  }
  if (request.headers && Object.keys(request.headers).length) {
    return false;
  }
  let url;
  try {
    url = new URL(request.url);
  } catch (_err) {
    return false;
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    return false;
  }
  if (isSecureMode && url.protocol !== "https:") {
    return false;
  }
  if (!isAllowedHttpHost(url.hostname) || isLoopbackHost(url.hostname)) {
    return false;
  }
  return Boolean(resolveCacheDir());
}

/**
 * The file a key's entry lives in.
 *
 * @param {DiskCacheKey} key Cache key.
 * @param {{miss?: boolean}} [opts] Whether this is the key of a recorded miss.
 * @returns {string|undefined}
 */
function entryPath(key, opts) {
  const root = resolveCacheDir();
  if (!root) {
    return undefined;
  }
  const host = new URL(key.url).hostname;
  // A host name is a single path segment; anything else is not written.
  if (!host || host.includes("/") || host.includes("\\") || host === "..") {
    return undefined;
  }
  return path.join(
    fetchCacheDir(root),
    host,
    `${diskCacheKeyHash(key, opts)}.json`,
  );
}

/**
 * Read and parse one entry, dropping it when it cannot be read.
 *
 * @param {string} file Entry file.
 * @returns {DiskCacheEntry|undefined}
 */
function readEntry(file) {
  let entry;
  try {
    entry = JSON.parse(readFileSync(file, "utf-8"));
  } catch (err) {
    if (err?.code !== "ENOENT") {
      rmSync(file, { force: true });
    }
    return undefined;
  }
  return entry?.v === CACHE_SCHEMA_VERSION ? entry : undefined;
}

/**
 * Whether an entry is still fresh.
 *
 * @param {DiskCacheEntry} entry Entry.
 * @param {number} ttl TTL in seconds; 0 for never expiring.
 * @returns {boolean}
 */
function isFresh(entry, ttl) {
  if (entry.immutable || ttl === 0) {
    return true;
  }
  return unixNow() - (entry.fetched_at || 0) <= ttl;
}

/**
 * Move an entry to the front of the eviction order without changing it.
 *
 * @param {string} file Entry file.
 * @returns {void}
 */
function touch(file) {
  try {
    const now = new Date();
    utimesSync(file, now, now);
  } catch (_err) {
    // Only the eviction order suffers.
  }
}

/**
 * @typedef {Object} DiskCacheLookup
 * @property {"fresh"|"stale"|"miss"|"none"} state `fresh` and `miss` are
 *   answers; `stale` needs revalidation; `none` means nothing is stored.
 * @property {DiskCacheEntry} [entry] The stored entry.
 */

/**
 * Look a request up.
 *
 * @param {DiskCacheKey} key Cache key.
 * @returns {DiskCacheLookup}
 */
export function diskCacheGet(key) {
  const file = entryPath(key);
  if (!file) {
    return { state: "none" };
  }
  sweepHostDirOnce(path.dirname(file));
  const entry = readEntry(file);
  if (entry) {
    if (isFresh(entry, cacheTtlSecs())) {
      touch(file);
      return { state: "fresh", entry };
    }
    if (entry.etag || entry.last_modified) {
      return { state: "stale", entry };
    }
  }
  const missFile = entryPath(key, { miss: true });
  const miss = missFile ? readEntry(missFile) : undefined;
  if (miss && isFresh(miss, missTtlSecs())) {
    return { state: "miss", entry: miss };
  }
  return { state: "none" };
}

/**
 * Write an entry atomically, readable by its owner only.
 *
 * @param {string} file Entry file.
 * @param {DiskCacheEntry} entry Entry.
 * @returns {void}
 */
function writeEntry(file, entry) {
  const dir = path.dirname(file);
  try {
    mkdirSync(dir, { recursive: true });
    const data = JSON.stringify(entry);
    writeSequence += 1;
    const temp = `${file.slice(0, -".json".length)}.tmp.${process.pid}.${writeSequence}`;
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeSync(fd, data);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, file);
    bytesSinceEnforcement += Buffer.byteLength(data);
  } catch (_err) {
    // The cache is an optimisation; a failed write costs one request later.
    return;
  }
  if (bytesSinceEnforcement >= ENFORCEMENT_SLACK_BYTES) {
    bytesSinceEnforcement = 0;
    enforceByteCeiling();
  }
}

/**
 * Store a successful response.
 *
 * @param {DiskCacheKey} key Cache key.
 * @param {{statusCode: number, headers?: Object, body: *}} response Response.
 * @returns {void}
 */
export function diskCachePut(key, response) {
  const file = entryPath(key);
  if (!file) {
    return;
  }
  writeEntry(file, {
    v: CACHE_SCHEMA_VERSION,
    url: redactUrl(key.url),
    method: "GET",
    status: response.statusCode,
    etag: response.headers?.etag || null,
    last_modified: response.headers?.["last-modified"] || null,
    fetched_at: unixNow(),
    body: response.body,
    ...(response.statusCode === 200 && isReleasePom(key.url)
      ? { immutable: true }
      : {}),
  });
  const missFile = entryPath(key, { miss: true });
  if (missFile) {
    rmSync(missFile, { force: true });
  }
}

/**
 * Record that a request answered 404 or 410, and forget any body stored for it.
 *
 * @param {DiskCacheKey} key Cache key.
 * @param {number} status HTTP status.
 * @returns {void}
 */
export function diskCachePutMiss(key, status) {
  const file = entryPath(key, { miss: true });
  if (!file) {
    return;
  }
  writeEntry(file, {
    v: CACHE_SCHEMA_VERSION,
    url: redactUrl(key.url),
    method: "GET",
    status,
    etag: null,
    last_modified: null,
    fetched_at: unixNow(),
    body: null,
  });
  const bodyFile = entryPath(key);
  if (bodyFile) {
    rmSync(bodyFile, { force: true });
  }
}

/**
 * Mark a stale entry fresh again after a 304.
 *
 * @param {DiskCacheKey} key Cache key.
 * @param {DiskCacheEntry} entry The stale entry.
 * @param {Object} [headers] Headers of the 304, which may carry new validators.
 * @returns {void}
 */
export function diskCacheRefresh(key, entry, headers = {}) {
  const file = entryPath(key);
  if (!file) {
    return;
  }
  writeEntry(file, {
    ...entry,
    etag: headers.etag || entry.etag,
    last_modified: headers["last-modified"] || entry.last_modified,
    fetched_at: unixNow(),
  });
}

/**
 * Remove a host directory's expired entries, once per process, as cdxrs does
 * before its first read there.
 *
 * @param {string} hostDir Host directory.
 * @returns {void}
 */
function sweepHostDirOnce(hostDir) {
  if (sweptHostDirs.has(hostDir)) {
    return;
  }
  sweptHostDirs.add(hostDir);
  const ttl = cacheTtlSecs();
  const now = unixNow();
  let names;
  try {
    names = readdirSync(hostDir);
  } catch (_err) {
    return;
  }
  for (const name of names) {
    const file = path.join(hostDir, name);
    let stat;
    try {
      stat = statSync(file);
    } catch (_err) {
      continue;
    }
    const ageSecs = now - Math.floor(stat.mtimeMs / 1000);
    if (name.includes(".tmp.")) {
      if (ageSecs > ORPHAN_TEMP_MIN_AGE_SECS) {
        rmSync(file, { force: true });
      }
      continue;
    }
    // Recent use moves the mtime forward, so only an older file can be
    // worth reading. The entry's own fetch time decides.
    if (!name.endsWith(".json") || ageSecs <= missTtlSecs()) {
      continue;
    }
    const entry = readEntry(file);
    if (!entry || entry.immutable || entry.etag || entry.last_modified) {
      continue;
    }
    const entryTtl = entry.status >= 400 ? missTtlSecs() : ttl;
    if (!isFresh(entry, entryTtl)) {
      rmSync(file, { force: true });
    }
  }
}

/**
 * Evict the least recently used entries until the cache is within its ceiling.
 *
 * @returns {void}
 */
function enforceByteCeiling() {
  const root = resolveCacheDir();
  if (!root) {
    return;
  }
  const files = [];
  let total = 0;
  const fetchDir = fetchCacheDir(root);
  let hosts;
  try {
    hosts = readdirSync(fetchDir);
  } catch (_err) {
    return;
  }
  for (const host of hosts) {
    let names;
    try {
      names = readdirSync(path.join(fetchDir, host));
    } catch (_err) {
      continue;
    }
    for (const name of names) {
      const file = path.join(fetchDir, host, name);
      try {
        const stat = statSync(file);
        if (stat.isFile()) {
          files.push({ file, size: stat.size, mtimeMs: stat.mtimeMs });
          total += stat.size;
        }
      } catch (_err) {
        // A concurrent eviction removed it.
      }
    }
  }
  if (total <= MAX_CACHE_BYTES) {
    return;
  }
  files.sort((a, b) => a.mtimeMs - b.mtimeMs || a.file.localeCompare(b.file));
  for (const { file, size } of files) {
    if (total <= MAX_CACHE_BYTES) {
      break;
    }
    rmSync(file, { force: true });
    total -= size;
  }
}

/**
 * Forget which host directories were swept. Tests only.
 *
 * @returns {void}
 */
export function resetDiskCacheState() {
  sweptHostDirs.clear();
  bytesSinceEnforcement = 0;
}
