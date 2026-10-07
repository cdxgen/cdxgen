/**
 * Behaviour tests for the JS batch pool: deduplication, Retry-After handling,
 * and the peak-concurrency stat.
 *
 * These exercise `prefetchJson` against a local HTTP double so the assertions
 * are about what actually went out on the wire, not what the call site
 * thinks it asked for. They run with `CDXGEN_RS_DISABLE=fetch` so the Rust
 * subprocess is out of the picture and the JS pool is the transport.
 *
 * The secure-mode test lives in `fetchBatch.securemode.poku.js` because it
 * mutates `CDXGEN_ALLOWED_HOSTS`, which poku's concurrent test scheduling
 * would leak into these tests.
 *
 * poku 4.x fires `it()` calls inside a `describe` as fire-and-forget promises,
 * so each `it` is explicitly awaited to keep these state-sharing tests
 * sequential.
 */
import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import process from "node:process";

import { describe, it } from "poku";

import {
  lastBatchStats,
  prefetchJson,
  resetBatchFetchAvailability,
  withHostRateLimit,
} from "./fetchBatch.js";

async function startServer(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url, method: req.method, headers: req.headers });
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function withEnv(env, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

// All tests share module-level batcher state (semaphores, in-flight map, peak
// counter), so they must run sequentially. Each `it` is awaited to enforce
// that within this describe block.
await describe("JS batch pool", async () => {
  await it("issues one request per unique URL within a batch", async () => {
    const server = await startServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ name: req.url.slice(1) }));
    });
    try {
      await withEnv({ CDXGEN_RS_DISABLE: "fetch" }, async () => {
        resetBatchFetchAvailability();
        const result = await prefetchJson([
          { url: `${server.url}/a` },
          { url: `${server.url}/a` },
          { url: `${server.url}/a` },
          { url: `${server.url}/b` },
        ]);
        assert.strictEqual(result.size, 2);
        assert.strictEqual(result.get(`${server.url}/a`).ok, true);
      });
      assert.strictEqual(server.requests.length, 2);
    } finally {
      await server.stop();
      resetBatchFetchAvailability();
    }
  });

  await it("issues one request per unique URL under CDXGEN_NO_CACHE=true", async () => {
    const server = await startServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ name: req.url.slice(1) }));
    });
    try {
      await withEnv(
        { CDXGEN_RS_DISABLE: "fetch", CDXGEN_NO_CACHE: "true" },
        async () => {
          resetBatchFetchAvailability();
          await prefetchJson([
            { url: `${server.url}/x` },
            { url: `${server.url}/x` },
            { url: `${server.url}/x` },
          ]);
        },
      );
      assert.strictEqual(server.requests.length, 1);
    } finally {
      await server.stop();
      resetBatchFetchAvailability();
    }
  });

  await it("retries a 429 with Retry-After rather than immediately", async () => {
    let attempts = 0;
    const server = await startServer((_req, res) => {
      attempts += 1;
      if (attempts === 1) {
        res.writeHead(429, { "Retry-After": "1" });
        res.end("{}");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    try {
      await withEnv({ CDXGEN_RS_DISABLE: "fetch" }, async () => {
        resetBatchFetchAvailability();
        const started = Date.now();
        const result = await prefetchJson([{ url: `${server.url}/limited` }]);
        const elapsed = Date.now() - started;
        assert.strictEqual(result.get(`${server.url}/limited`).ok, true);
        assert.ok(
          elapsed >= 900,
          `Retry-After was not honoured: ${elapsed} ms`,
        );
      });
      assert.strictEqual(server.requests.length, 2);
    } finally {
      await server.stop();
      resetBatchFetchAvailability();
    }
  });

  await it("retries a 429 whose body is an HTML page", async () => {
    let attempts = 0;
    const server = await startServer((_req, res) => {
      attempts += 1;
      if (attempts === 1) {
        // CDNs answer a rate limit with HTML, whatever the client asked for.
        res.writeHead(429, { "content-type": "text/html", "Retry-After": "0" });
        res.end("<html><body>You are being rate limited</body></html>");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    try {
      await withEnv({ CDXGEN_RS_DISABLE: "fetch" }, async () => {
        resetBatchFetchAvailability();
        const result = await prefetchJson([{ url: `${server.url}/html` }]);
        assert.strictEqual(result.get(`${server.url}/html`).ok, true);
      });
      assert.strictEqual(server.requests.length, 2);
    } finally {
      await server.stop();
      resetBatchFetchAvailability();
    }
  });

  await it("reports peakConcurrency from the wire, not the configured limit", async () => {
    const server = await startServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      }, 30);
    });
    try {
      await withEnv({ CDXGEN_RS_DISABLE: "fetch" }, async () => {
        resetBatchFetchAvailability();
        const urls = Array.from({ length: 40 }, (_, i) => ({
          url: `${server.url}/p${i}`,
        }));
        await prefetchJson(urls);
        const stats = lastBatchStats();
        assert.ok(stats, "no stats recorded");
        assert.strictEqual(stats.requests, 40);
        assert.strictEqual(stats.ok, 40);
        assert.ok(
          stats.peakConcurrency > 1,
          `peakConcurrency too low: ${stats.peakConcurrency}`,
        );
        assert.ok(
          stats.peakConcurrency <= 16,
          `peakConcurrency exceeded the global cap: ${stats.peakConcurrency}`,
        );
      });
    } finally {
      await server.stop();
      resetBatchFetchAvailability();
    }
  });

  await it("reports peakConcurrency per batch, not for the process", async () => {
    const server = await startServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      }, 30);
    });
    try {
      await withEnv({ CDXGEN_RS_DISABLE: "fetch" }, async () => {
        resetBatchFetchAvailability();
        // A wide batch first, so a process-wide high-water mark would be well
        // above 1 by the time the second batch runs.
        await prefetchJson(
          Array.from({ length: 40 }, (_, i) => ({
            url: `${server.url}/wide${i}`,
          })),
        );
        assert.ok(
          lastBatchStats().peakConcurrency > 1,
          "the wide batch did not fan out, so this test proves nothing",
        );
        // One URL can only ever be one request in flight. Reporting the
        // previous batch's peak here is what made this statistic unable to
        // evidence that any given batch fanned out.
        await prefetchJson([{ url: `${server.url}/solo` }]);
        const stats = lastBatchStats();
        assert.strictEqual(stats.requests, 1);
        assert.strictEqual(
          stats.peakConcurrency,
          1,
          `single-URL batch reported peakConcurrency ${stats.peakConcurrency}`,
        );
      });
    } finally {
      await server.stop();
      resetBatchFetchAvailability();
    }
  });
});

await describe("crates.io rate policy", async () => {
  await it("serialises direct requests one second apart", async () => {
    // crates.io's crawler policy allows one request per second with no
    // parallelism. This exercises the gate a prefetch miss goes through, so
    // the guarantee does not depend on the batch pool having run.
    const starts = [];
    const ends = [];
    const issue = async (index) => {
      starts.push(Date.now());
      // A request with real duration: overlapping calls would show up as an
      // end timestamp later than the next start.
      await new Promise((resolve) => setTimeout(resolve, 20));
      ends.push(Date.now());
      return index;
    };
    const begun = Date.now();
    const results = await Promise.all([
      withHostRateLimit("https://crates.io/api/v1/crates/serde", () =>
        issue(0),
      ),
      withHostRateLimit("https://crates.io/api/v1/crates/rand", () => issue(1)),
    ]);
    assert.deepEqual(results.sort(), [0, 1]);
    assert.equal(starts.length, 2);

    // No parallelism: the first request finished before the second began.
    assert.ok(
      ends[0] <= starts[1],
      `requests overlapped: first ended ${ends[0]}, second started ${starts[1]}`,
    );
    // One per second. A small tolerance absorbs timer granularity.
    const gap = starts[1] - starts[0];
    assert.ok(
      gap >= 950,
      `expected at least ~1s between requests, got ${gap}ms`,
    );
    assert.ok(
      Date.now() - begun >= 950,
      "two gated requests must take at least a second in total",
    );
  });
});
