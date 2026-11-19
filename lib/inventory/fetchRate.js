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

import { readEnvironmentVariable } from "../core/activity.js";

/**
 * Whether a credential will be sent to the host.
 *
 * GitHub is the reason this exists: 60 requests an hour anonymously against
 * 5000 with a token is not a difference of degree. Applying the anonymous
 * budget to a token-bearing client throws away the point of having set
 * `GITHUB_TOKEN`.
 *
 * @typedef {("anonymous"|"authenticated")} Credentials
 */

/**
 * The policy for one host: the minimum gap between two requests and the
 * maximum number in flight.
 *
 * @typedef {Object} HostPolicy
 * @property {number} minInterval Minimum gap between requests, in milliseconds.
 * @property {number} maxConcurrency Maximum requests in flight to this host.
 */

/**
 * Hosts that publish a rate limit, and what they publish.
 *
 * Columns: host, anonymous interval (ms), anonymous concurrency, authenticated
 * interval (ms), authenticated concurrency. A host whose limit does not change
 * with a credential repeats the same pair.
 *
 * Suffix match is used so `index.crates.io` inherits `crates.io`.
 */
const HOST_POLICIES = [
  // crates.io's crawler policy asks for at most one request per second, made
  // serially. It is a condition of use rather than a throughput hint, so the
  // interval is a full second and the concurrency is 1: with more than one
  // request in flight the gate would still average a second apiece but would
  // deliver them in bursts, which is the thing the policy rules out. The
  // budget is per IP and does not improve with a token.
  {
    host: "crates.io",
    anonInterval: 1000,
    anonConcurrency: 1,
    authInterval: 1000,
    authConcurrency: 1,
  },
  // GitHub: 60 req/h anonymous, 5000 req/h authenticated. The limit is an
  // hourly budget rather than a rate, so a batch of a few hundred lookups is
  // well inside it once a token is present.
  {
    host: "api.github.com",
    anonInterval: 250,
    anonConcurrency: 4,
    authInterval: 0,
    authConcurrency: 8,
  },
  {
    host: "github.com",
    anonInterval: 250,
    anonConcurrency: 4,
    authInterval: 0,
    authConcurrency: 8,
  },
  // GitLab: 2000 req/min authenticated against 500 unauthenticated.
  {
    host: "gitlab.com",
    anonInterval: 250,
    anonConcurrency: 4,
    authInterval: 0,
    authConcurrency: 8,
  },
  {
    host: "pkg.go.dev",
    anonInterval: 250,
    anonConcurrency: 4,
    authInterval: 250,
    authConcurrency: 4,
  },
  // package.elm-lang.org publishes no limit: its robots.txt carries no
  // `Crawl-delay` and the registry has no terms of use or documented API. What
  // it does have is a single community-run origin rather than a CDN, so it is
  // held to the same gentle allowance as the other unpublished host in this
  // table instead of the CDN default. Like crates.io, its requests are kept off
  // the Rust transport to leave one gate in charge; rate.rs still carries the
  // same row so the two tables state one policy.
  // Maven Central publishes no numeric limit. What it publishes instead is a
  // policy: consumption limits are enforced against aggregate traffic, the
  // thresholds are unpublished and moving downward, and the named offenders are
  // "CI/CD platforms, security scanners, and other services that generate
  // outsized traffic" — which is cdxgen's exact job description. A block is an
  // escalating ban of up to 30 days, not a per-request 429, so the cost of
  // being slightly too fast is losing Maven resolution for a month rather than
  // retrying a second later. That asymmetry, not a published number, is what
  // sets these rows.
  //
  // repo1 is the artifact store: Cloudflare-fronted (`cf-cache-status` on every
  // response), and a POM fetch that hits the edge cache never reaches Sonatype.
  // It gets a real allowance — 100 ms and 8 in flight, so ~10 req/s sustained —
  // which is half the CDN default and orders of magnitude below anything that
  // would show up in the top few percent of Central's traffic.
  {
    host: "repo1.maven.org",
    anonInterval: 100,
    anonConcurrency: 8,
    authInterval: 100,
    authConcurrency: 8,
  },
  // The search API is the opposite: a Solr query against the origin, one
  // request per unknown jar hash, cacheable by nobody. cdxgen already treats it
  // as fragile — a single timeout or 429 disables jar search for the rest of
  // the run — so the gate is a serial 500 ms (~2 req/s). A jar sweep stays
  // usable while staying far below anything worth throttling.
  {
    host: "search.maven.org",
    anonInterval: 500,
    anonConcurrency: 1,
    authInterval: 500,
    authConcurrency: 1,
  },
  {
    host: "central.sonatype.com",
    anonInterval: 500,
    anonConcurrency: 1,
    authInterval: 500,
    authConcurrency: 1,
  },
  {
    host: "package.elm-lang.org",
    anonInterval: 250,
    anonConcurrency: 4,
    authInterval: 250,
    authConcurrency: 4,
  },
];

/**
 * Concurrency allowed for a host with no published limit. Registries that are
 * CDN-fronted document store fronts (npm, PyPI, RubyGems, NuGet, pub.dev) sit
 * here; the global cap is what bounds them.
 */
export const DEFAULT_HOST_CONCURRENCY = 16;

/**
 * Global cap on in-flight requests across every host. Per-host caps cannot
 * sum past this; a 16-way global batch saturates a large npm run without
 * putting any single host above its published allowance.
 */
export const DEFAULT_GLOBAL_CONCURRENCY = 16;

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
export function credentialsFor(host) {
  const lower = host.toLowerCase();
  const isGitHub =
    lower === "api.github.com" ||
    lower === "github.com" ||
    lower.endsWith(".github.com");
  if (isGitHub && readEnvironmentVariable("GITHUB_TOKEN")) {
    return "authenticated";
  }
  return "anonymous";
}

/**
 * Resolve the published policy for a host, or the CDN default.
 *
 * @param {string} host The hostname.
 * @param {Credentials} [credentials] Credential class; defaults to what the
 *   environment would actually send to this host.
 * @returns {HostPolicy}
 */
export function policyFor(host, credentials) {
  const lower = (host || "").toLowerCase();
  const cred = credentials || credentialsFor(host);
  for (const candidate of HOST_POLICIES) {
    const matches =
      lower === candidate.host || lower.endsWith(`.${candidate.host}`);
    if (!matches) {
      continue;
    }
    if (cred === "authenticated") {
      return {
        minInterval: candidate.authInterval,
        maxConcurrency: candidate.authConcurrency,
      };
    }
    return {
      minInterval: candidate.anonInterval,
      maxConcurrency: candidate.anonConcurrency,
    };
  }
  return { minInterval: 0, maxConcurrency: DEFAULT_HOST_CONCURRENCY };
}

/**
 * The table of published policies, exposed for the parity test. The shape is
 * stable: changing an entry is a policy change that must be mirrored in
 * `rate.rs`.
 */
export const PUBLISHED_HOST_POLICIES = HOST_POLICIES.map((entry) => ({
  ...entry,
}));

/**
 * Create a minimum-interval gate for one host.
 *
 * `wait()` queues the caller so that successive calls are at least
 * `minInterval` apart. `externalDelay()` pushes the gate out by a server-side
 * back-off (`Retry-After`, `X-RateLimit-Reset`) and is counted.
 */
export class RateLimiter {
  /**
   * @param {number} minInterval Minimum gap between requests, in milliseconds.
   */
  constructor(minInterval) {
    this._minInterval = minInterval;
    this._nextAvailable = 0;
    this._externalDelays = 0;
  }

  /**
   * Wait until this host's gate opens, then reserve the next slot. Callers
   * that arrive while the gate is closed queue up rather than all being
   * released together.
   *
   * @returns {Promise<void>}
   */
  async wait() {
    const now = Date.now();
    // The slot is reserved synchronously, before any await, so concurrent
    // callers each take a distinct slot instead of all reading the same gate.
    const slot = Math.max(this._nextAvailable, now);
    this._nextAvailable = slot + this._minInterval;
    const delay = slot - now;
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  /**
   * Record a server-imposed delay and push the gate out to at least now plus
   * the delay. The caller is still responsible for actually waiting before it
   * retries; recording alone does not sleep.
   *
   * @param {number} delayMs Delay in milliseconds.
   */
  externalDelay(delayMs) {
    this._externalDelays += 1;
    const target = Date.now() + delayMs;
    if (target > this._nextAvailable) {
      this._nextAvailable = target;
    }
  }

  /** @returns {number} How many times this host asked us to slow down. */
  get externalDelayCount() {
    return this._externalDelays;
  }

  /** @returns {boolean} Whether the gate is open, so the next caller would not wait. */
  get isOpen() {
    return this._nextAvailable <= Date.now();
  }
}

/**
 * Create a counting semaphore with a FIFO wait queue. Used both for the global
 * concurrency cap and the per-host cap.
 *
 * @param {number} limit Maximum simultaneous holders.
 * @returns {{acquire: () => Promise<() => void>}} An `acquire` function that
 *   resolves once a slot is free, with a `release` function as its value.
 */
export function makeSemaphore(limit) {
  let available = Math.max(1, limit);
  const waiters = [];
  return {
    async acquire() {
      if (available > 0) {
        available -= 1;
        return release;
      }
      await new Promise((resolve) => waiters.push(resolve));
      return release;
    },
  };
  function release() {
    const next = waiters.shift();
    if (next) {
      next();
    } else {
      available += 1;
    }
  }
}
