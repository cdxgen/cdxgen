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
export type DiskCacheKey = {
    /**
     * Request URL.
     */
    url: string;
    /**
     * `Accept` header.
     */
    accept?: string;
    /**
     * Identity of the credential, never itself.
     */
    authRealm?: string;
    /**
     * `json`, `text` or `buffer`.
     */
    responseType?: string;
};
export type DiskCacheEntry = {
    /**
     * Schema version.
     */
    v: number;
    /**
     * Redacted URL.
     */
    url: string;
    /**
     * Always `GET`.
     */
    method: string;
    /**
     * HTTP status.
     */
    status: number;
    /**
     * ETag validator.
     */
    etag: string | null;
    /**
     * Last-Modified validator.
     */
    last_modified: string | null;
    /**
     * Unix seconds when fetched or revalidated.
     */
    fetched_at: number;
    /**
     * Response body.
     */
    body: any;
    /**
     * Never expires.
     */
    immutable?: boolean;
};
/**
 * Hash of a cache key, as cdxrs computes it for a JSON response.
 *
 * @param {DiskCacheKey} key Cache key.
 * @param {{miss?: boolean}} [opts] Whether this is the key of a recorded miss.
 * @returns {string}
 */
export declare function diskCacheKeyHash(key: DiskCacheKey, { miss }?: {
    miss?: boolean;
}): string;
/**
 * Whether the disk cache may serve or store a request.
 *
 * @param {{url: string, headers?: Object, responseType?: string}} request
 * @returns {boolean}
 */
export declare function diskCacheable(request: {
    url: string;
    headers?: Object;
    responseType?: string;
}): boolean;
export type DiskCacheLookup = {
    /**
     * `fresh` and `miss` are
     * answers; `stale` needs revalidation; `none` means nothing is stored.
     */
    state: "fresh" | "stale" | "miss" | "none";
    /**
     * The stored entry.
     */
    entry?: DiskCacheEntry;
};
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
export declare function diskCacheGet(key: DiskCacheKey): DiskCacheLookup;
/**
 * Store a successful response.
 *
 * @param {DiskCacheKey} key Cache key.
 * @param {{statusCode: number, headers?: Object, body: *}} response Response.
 * @returns {void}
 */
export declare function diskCachePut(key: DiskCacheKey, response: {
    statusCode: number;
    headers?: Object;
    body: any;
}): void;
/**
 * Record that a request answered 404 or 410, and forget any body stored for it.
 *
 * @param {DiskCacheKey} key Cache key.
 * @param {number} status HTTP status.
 * @returns {void}
 */
export declare function diskCachePutMiss(key: DiskCacheKey, status: number): void;
/**
 * Mark a stale entry fresh again after a 304.
 *
 * @param {DiskCacheKey} key Cache key.
 * @param {DiskCacheEntry} entry The stale entry.
 * @param {Object} [headers] Headers of the 304, which may carry new validators.
 * @returns {void}
 */
export declare function diskCacheRefresh(key: DiskCacheKey, entry: DiskCacheEntry, headers?: Object): void;
/**
 * Forget which host directories were swept. Tests only.
 *
 * @returns {void}
 */
export declare function resetDiskCacheState(): void;
//# sourceMappingURL=fetchDiskCache.d.ts.map