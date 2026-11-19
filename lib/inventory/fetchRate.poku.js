import process from "node:process";

import { assert, describe, it } from "poku";

import {
  credentialsFor,
  DEFAULT_GLOBAL_CONCURRENCY,
  DEFAULT_HOST_CONCURRENCY,
  makeSemaphore,
  PUBLISHED_HOST_POLICIES,
  policyFor,
  RateLimiter,
} from "./fetchRate.js";

/**
 * Pin the shared policy numbers so a change to the JS side is visible against
 * the Rust side (`cdxgen-plugins-bin/thirdparty/cdxrs/src/fetch/rate.rs`).
 * Where the two would disagree, they are wrong; these constants are the
 * contract between the two transports.
 *
 * Every row matches. crates.io and package.elm-lang.org are still kept off the
 * Rust transport at the routing layer, so that a single gate enforces their
 * policy — but "rate.rs never sees this host" is not a licence for the two
 * tables to disagree about what the policy is. A row that drifts is a bug
 * waiting for the day the routing changes, so the table is mirrored for those
 * hosts too and this test covers them like any other.
 */
describe("fetchRate policy parity with rate.rs", () => {
  it("exposes the default host and global concurrency caps", () => {
    assert.strictEqual(DEFAULT_HOST_CONCURRENCY, 16);
    assert.strictEqual(DEFAULT_GLOBAL_CONCURRENCY, 16);
  });

  it("matches the Rust HOST_POLICIES table", () => {
    // Columns in rate.rs: (host, anon_ms, anon_conc, auth_ms, auth_conc).
    const expected = [
      // crates.io's requests never reach the Rust transport (see
      // `cdxrsCanServe`), so in practice this table is the one that governs
      // them — but rate.rs carries the same row, so the two cannot drift.
      {
        host: "crates.io",
        anonInterval: 1000,
        anonConcurrency: 1,
        authInterval: 1000,
        authConcurrency: 1,
      },
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
      {
        host: "repo1.maven.org",
        anonInterval: 100,
        anonConcurrency: 8,
        authInterval: 100,
        authConcurrency: 8,
      },
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
      // package.elm-lang.org is routed like crates.io: kept on the JS
      // transport, mirrored in rate.rs anyway.
      {
        host: "package.elm-lang.org",
        anonInterval: 250,
        anonConcurrency: 4,
        authInterval: 250,
        authConcurrency: 4,
      },
    ];
    assert.deepStrictEqual(
      PUBLISHED_HOST_POLICIES,
      expected,
      "HOST_POLICIES drifted from rate.rs — update both sides",
    );
  });

  it("gates the Maven search API harder than the Maven artifact store", () => {
    // Two different Sonatype services with two different costs: repo1 answers
    // from a CDN edge, the Solr search API answers from the origin. A single
    // Maven row would have to pick one of them and be wrong about the other.
    const repo = policyFor("repo1.maven.org", "anonymous");
    assert.strictEqual(repo.minInterval, 100);
    assert.strictEqual(repo.maxConcurrency, 8);
    for (const host of ["search.maven.org", "central.sonatype.com"]) {
      const search = policyFor(host, "anonymous");
      assert.strictEqual(search.minInterval, 500);
      assert.strictEqual(search.maxConcurrency, 1);
    }
  });

  it("keeps the Maven budget per-IP: a token does not raise it", () => {
    for (const host of [
      "repo1.maven.org",
      "search.maven.org",
      "central.sonatype.com",
    ]) {
      assert.deepStrictEqual(
        policyFor(host, "authenticated"),
        policyFor(host, "anonymous"),
      );
    }
  });

  it("applies crates.io's one-request-per-second crawler policy serially", () => {
    // A second between requests and no parallelism: concurrency above 1 would
    // keep the average but deliver bursts, which the policy rules out.
    const p = policyFor("crates.io", "anonymous");
    assert.strictEqual(p.minInterval, 1000);
    assert.strictEqual(p.maxConcurrency, 1);
  });

  it("applies suffix match so index.crates.io inherits crates.io", () => {
    const p = policyFor("index.crates.io", "anonymous");
    assert.strictEqual(p.minInterval, 1000);
    assert.strictEqual(p.maxConcurrency, 1);
  });

  it("gives an authenticated GitHub client more concurrency than anonymous", () => {
    // 60 req/h anonymous against 5000 with a token: applying the anonymous
    // budget to a token-bearing client throws away the point of the token.
    const anon = policyFor("api.github.com", "anonymous");
    const auth = policyFor("api.github.com", "authenticated");
    assert.strictEqual(anon.maxConcurrency, 4);
    assert.strictEqual(anon.minInterval, 250);
    assert.strictEqual(auth.maxConcurrency, 8);
    assert.strictEqual(auth.minInterval, 0);
  });

  it("leaves crates.io unchanged when authenticated (per-IP, not per-token)", () => {
    assert.deepStrictEqual(
      policyFor("crates.io", "authenticated"),
      policyFor("crates.io", "anonymous"),
    );
  });

  it("does not throttle CDN-fronted registries", () => {
    for (const host of ["registry.npmjs.org", "pypi.org", "rubygems.org"]) {
      const p = policyFor(host, "anonymous");
      assert.strictEqual(p.minInterval, 0, `${host} got an interval`);
      assert.strictEqual(p.maxConcurrency, DEFAULT_HOST_CONCURRENCY);
    }
  });

  it("does not match a host that merely contains a published substring", () => {
    // A registry that impersonates crates.io by containing its name must not
    // inherit its budget. This is the trap that suffix-match-on-substring
    // falls into; the dot-prefixed suffix match avoids it.
    assert.strictEqual(
      policyFor("crates.io.evil.example", "anonymous").minInterval,
      0,
    );
  });
});

describe("credentialsFor", () => {
  const previousToken = process.env.GITHUB_TOKEN;
  it("classifies GitHub hosts as authenticated only when a token is present", () => {
    delete process.env.GITHUB_TOKEN;
    assert.strictEqual(credentialsFor("api.github.com"), "anonymous");
    assert.strictEqual(credentialsFor("github.com"), "anonymous");
    assert.strictEqual(credentialsFor("crates.io"), "anonymous");
    process.env.GITHUB_TOKEN = "ghp_test";
    try {
      assert.strictEqual(credentialsFor("api.github.com"), "authenticated");
      assert.strictEqual(credentialsFor("github.com"), "authenticated");
      assert.strictEqual(credentialsFor("sub.github.com"), "authenticated");
      // A GitHub token must not raise anyone else's budget.
      assert.strictEqual(credentialsFor("crates.io"), "anonymous");
    } finally {
      if (previousToken === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = previousToken;
      }
    }
  });
});

describe("RateLimiter", () => {
  it("spreads successive waits by minInterval", async () => {
    const limiter = new RateLimiter(40);
    const started = Date.now();
    await limiter.wait();
    await limiter.wait();
    await limiter.wait();
    // First is free; the next two are 40 ms apart, so >= 60 ms with slack.
    assert.ok(
      Date.now() - started >= 60,
      `interval not enforced: ${Date.now() - started} ms`,
    );
  });

  it("does not sleep when minInterval is zero", async () => {
    const limiter = new RateLimiter(0);
    const started = Date.now();
    for (let i = 0; i < 20; i++) {
      await limiter.wait();
    }
    assert.ok(Date.now() - started < 50, "unthrottled limiter slept");
  });

  it("records and applies an external delay", async () => {
    const limiter = new RateLimiter(0);
    limiter.externalDelay(80);
    assert.strictEqual(limiter.externalDelayCount, 1);
    const started = Date.now();
    await limiter.wait();
    assert.ok(
      Date.now() - started >= 60,
      "external delay did not push the gate",
    );
  });

  it("is open until a slot is reserved or the host asks for a delay", async () => {
    // The interval is a minute and the clock is moved forward by hand, so a
    // slow or busy machine cannot use up the interval between two checks.
    const limiter = new RateLimiter(60_000);
    assert.strictEqual(limiter.isOpen, true);
    await limiter.wait();
    assert.strictEqual(limiter.isOpen, false, "the interval was not owed");
    const realNow = Date.now;
    const later = realNow() + 61_000;
    Date.now = () => later;
    try {
      assert.strictEqual(limiter.isOpen, true, "the interval did not end");
    } finally {
      Date.now = realNow;
    }
    const delayed = new RateLimiter(0);
    assert.strictEqual(delayed.isOpen, true);
    delayed.externalDelay(60_000);
    assert.strictEqual(delayed.isOpen, false, "the delay was not owed");
    // A host with no interval owes nothing once it was asked.
    const unthrottled = new RateLimiter(0);
    await unthrottled.wait();
    assert.strictEqual(unthrottled.isOpen, true);
  });
});

describe("makeSemaphore", () => {
  it("bounds concurrent holders and queues the rest", async () => {
    const sem = makeSemaphore(2);
    let inFlight = 0;
    let peak = 0;
    const task = async () => {
      const release = await sem.acquire();
      inFlight += 1;
      if (inFlight > peak) {
        peak = inFlight;
      }
      await new Promise((r) => setTimeout(r, 10));
      inFlight -= 1;
      release();
    };
    await Promise.all(Array.from({ length: 8 }, task));
    assert.strictEqual(peak, 2, "semaphore leaked past its limit");
  });

  it("clamps a zero limit to one rather than deadlocking", async () => {
    const sem = makeSemaphore(0);
    const release = await sem.acquire();
    release();
    // Reaching this line means acquire resolved rather than hanging forever.
    assert.ok(true);
  });
});
