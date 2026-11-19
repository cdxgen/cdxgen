/**
 * Per-host rate policy for batched registry fetches.
 *
 * This is the single source of truth for the JS transport's concurrency and
 * minimum-interval decisions. Every number is shared with the Rust transport
 * (`cdxgen-plugins-bin/thirdparty/cdxrs/src/fetch/rate.rs`); a change to one
 * side must be reflected in the other, and `fetchRate.poku.js` pins them so a
 * drift is visible. crates.io and package.elm-lang.org are routed so that their
 * requests never reach the Rust transport, which makes this table the one that
 * governs them in practice — their rows are mirrored there regardless, because
 * two tables that disagree are a bug waiting for the routing to change.
 *
 * Why a per-host table rather than a single global interval: a single-registry
 * project — which is to say, almost every npm project — has exactly one host,
 * so a conservative per-host cap *is* the global cap. Applying crates.io's
 * one-per-second policy to every host would cap an npm run at one request a
 * second, orders of magnitude slower than that registry asks for. Hosts that
 * publish a limit get an interval; hosts that do not are bounded by the
 * per-host concurrency cap alone, and by whatever `Retry-After` they send.
 */
export type Credentials = ("anonymous" | "authenticated");
export type HostPolicy = {
    /**
     * Minimum gap between requests, in milliseconds.
     */
    minInterval: number;
    /**
     * Maximum requests in flight to this host.
     */
    maxConcurrency: number;
};
/**
 * Concurrency allowed for a host with no published limit. Registries that are
 * CDN-fronted document store fronts (npm, PyPI, RubyGems, NuGet, pub.dev) sit
 * here; the global cap is what bounds them.
 */
export declare const DEFAULT_HOST_CONCURRENCY = 16;
/**
 * Global cap on in-flight requests across every host. Per-host caps cannot
 * sum past this; a 16-way global batch saturates a large npm run without
 * putting any single host above its published allowance.
 */
export declare const DEFAULT_GLOBAL_CONCURRENCY = 16;
/**
 * Resolve the credential class for a host based on the environment.
 *
 * Only token presence is considered, never its value. A host we hold no token
 * for keeps the anonymous budget even if some other host has one. Today only
 * GitHub tokens are honoured, matching the Rust client.
 *
 * @param {string} host The hostname to classify.
 * @returns {Credentials}
 */
export declare function credentialsFor(host: string): Credentials;
/**
 * Resolve the published policy for a host, or the CDN default.
 *
 * @param {string} host The hostname.
 * @param {Credentials} [credentials] Credential class; defaults to what the
 *   environment would actually send to this host.
 * @returns {HostPolicy}
 */
export declare function policyFor(host: string, credentials?: Credentials): HostPolicy;
/**
 * The table of published policies, exposed for the parity test. The shape is
 * stable: changing an entry is a policy change that must be mirrored in
 * `rate.rs`.
 */
export declare const PUBLISHED_HOST_POLICIES: {
    host: string;
    anonInterval: number;
    anonConcurrency: number;
    authInterval: number;
    authConcurrency: number;
}[];
/**
 * Create a minimum-interval gate for one host.
 *
 * `wait()` queues the caller so that successive calls are at least
 * `minInterval` apart. `externalDelay()` pushes the gate out by a server-side
 * back-off (`Retry-After`, `X-RateLimit-Reset`) and is counted.
 */
export declare class RateLimiter {
    _minInterval: number;
    _nextAvailable: number;
    _externalDelays: number;
    /**
     * @param {number} minInterval Minimum gap between requests, in milliseconds.
     */
    constructor(minInterval: number);
    /**
     * Wait until this host's gate opens, then reserve the next slot. Callers
     * that arrive while the gate is closed queue up rather than all being
     * released together.
     *
     * @returns {Promise<void>}
     */
    wait(): Promise<void>;
    /**
     * Record a server-imposed delay and push the gate out to at least now plus
     * the delay. The caller is still responsible for actually waiting before it
     * retries; recording alone does not sleep.
     *
     * @param {number} delayMs Delay in milliseconds.
     */
    externalDelay(delayMs: number): void;
    /** @returns {number} How many times this host asked us to slow down. */
    get externalDelayCount(): number;
    /** @returns {boolean} Whether the gate is open, so the next caller would not wait. */
    get isOpen(): boolean;
}
/**
 * Create a counting semaphore with a FIFO wait queue. Used both for the global
 * concurrency cap and the per-host cap.
 *
 * @param {number} limit Maximum simultaneous holders.
 * @returns {{acquire: () => Promise<() => void>}} An `acquire` function that
 *   resolves once a slot is free, with a `release` function as its value.
 */
export declare function makeSemaphore(limit: number): {
    acquire: () => Promise<() => void>;
};
//# sourceMappingURL=fetchRate.d.ts.map