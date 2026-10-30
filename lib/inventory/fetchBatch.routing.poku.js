/**
 * Which transport a batch is dispatched to.
 *
 * The cdxrs envelope types a result body as JSON, so a batch asking for text
 * or bytes has to run on the JS pool even when the binary is available. These
 * tests stub the bridge so both branches can be observed without a real
 * binary on disk.
 *
 * They live in their own file, and inside an awaited `describe`, because they
 * mutate CDXGEN_RS_DISABLE and GITHUB_TOKEN and reset the memoized availability
 * probe. poku fires `it` calls as fire-and-forget promises, so without both
 * they would leak into each other and into the other fetchBatch suites.
 */
import { createServer } from "node:http";
import process from "node:process";

import esmock from "esmock";
import { strict as assert, describe, it } from "poku";

async function startServer(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

/**
 * Load fetchBatch with the cdxrs bridge stubbed out as available, recording
 * every subprocess invocation it would make.
 */
async function loadWithStubbedCdxrs(calls) {
  return await esmock("./fetchBatch.js", {
    "./cdxrs.js": {
      cdxrsAvailable: () => ({ available: true }),
      cdxrsDisabled: () => false,
      runCdxrs: async (subcommand, opts) => {
        calls.push({ subcommand, opts });
        return { ok: true, stdout: JSON.stringify({ results: [] }) };
      },
    },
  });
}

describe("batch transport selection", async () => {
  await it("a text batch bypasses cdxrs and is served by the JS pool", async () => {
    const previous = process.env.CDXGEN_RS_DISABLE;
    delete process.env.CDXGEN_RS_DISABLE;
    const { server, base } = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>hello</html>");
    });
    const calls = [];
    try {
      const mod = await loadWithStubbedCdxrs(calls);
      mod.resetBatchFetchAvailability();
      assert.equal(mod.batchFetchAvailable(), true);
      const fetched = await mod.prefetchJson([
        { responseType: "text", url: `${base}/page` },
      ]);
      // The subprocess was never asked, and the body arrived unparsed.
      assert.equal(calls.length, 0);
      assert.equal(fetched.get(`${base}/page`).body, "<html>hello</html>");
    } finally {
      server.close();
      if (previous === undefined) {
        delete process.env.CDXGEN_RS_DISABLE;
      } else {
        process.env.CDXGEN_RS_DISABLE = previous;
      }
    }
  });

  await it("a JSON batch still goes to cdxrs when the binary is available", async () => {
    const previous = process.env.CDXGEN_RS_DISABLE;
    delete process.env.CDXGEN_RS_DISABLE;
    const calls = [];
    try {
      const mod = await loadWithStubbedCdxrs(calls);
      mod.resetBatchFetchAvailability();
      await mod.prefetchJson([{ url: "https://registry.invalid/left-pad" }]);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].subcommand, "fetch");
    } finally {
      if (previous === undefined) {
        delete process.env.CDXGEN_RS_DISABLE;
      } else {
        process.env.CDXGEN_RS_DISABLE = previous;
      }
    }
  });

  await it("a crates.io batch bypasses cdxrs so one gate owns its rate limit", async () => {
    const previous = process.env.CDXGEN_RS_DISABLE;
    delete process.env.CDXGEN_RS_DISABLE;
    const calls = [];
    try {
      const mod = await loadWithStubbedCdxrs(calls);
      mod.resetBatchFetchAvailability();
      assert.equal(mod.batchFetchAvailable(), true);
      // The request is plain JSON with no custom header, so only the host
      // keeps it off the Rust transport. It fails to connect, which is fine:
      // what is asserted is that the subprocess was never asked.
      await mod.prefetchJson([
        { url: "https://crates.io/api/v1/crates/serde" },
      ]);
      assert.equal(calls.length, 0);
    } finally {
      if (previous === undefined) {
        delete process.env.CDXGEN_RS_DISABLE;
      } else {
        process.env.CDXGEN_RS_DISABLE = previous;
      }
    }
  });

  await it("an elm registry batch bypasses cdxrs, which has no policy for it", async () => {
    const previous = process.env.CDXGEN_RS_DISABLE;
    delete process.env.CDXGEN_RS_DISABLE;
    const calls = [];
    try {
      const mod = await loadWithStubbedCdxrs(calls);
      mod.resetBatchFetchAvailability();
      assert.equal(mod.batchFetchAvailable(), true);
      await mod.prefetchJson([
        {
          url: "https://package.elm-lang.org/packages/elm/http/2.0.0/elm.json",
        },
      ]);
      assert.equal(calls.length, 0);
    } finally {
      if (previous === undefined) {
        delete process.env.CDXGEN_RS_DISABLE;
      } else {
        process.env.CDXGEN_RS_DISABLE = previous;
      }
    }
  });

  await it("one non-crates URL in a batch still reaches cdxrs", async () => {
    // The guard is per request; a batch with no crates.io URL is unaffected.
    const previous = process.env.CDXGEN_RS_DISABLE;
    delete process.env.CDXGEN_RS_DISABLE;
    const calls = [];
    try {
      const mod = await loadWithStubbedCdxrs(calls);
      mod.resetBatchFetchAvailability();
      await mod.prefetchJson([{ url: "https://registry.invalid/serde" }]);
      assert.equal(calls.length, 1);
    } finally {
      if (previous === undefined) {
        delete process.env.CDXGEN_RS_DISABLE;
      } else {
        process.env.CDXGEN_RS_DISABLE = previous;
      }
    }
  });

  await it("a batch carrying its own credential bypasses cdxrs and keeps that credential", async () => {
    const previousDisable = process.env.CDXGEN_RS_DISABLE;
    const previousToken = process.env.GITHUB_TOKEN;
    delete process.env.CDXGEN_RS_DISABLE;
    process.env.GITHUB_TOKEN = "ambient-token-that-must-not-win";
    const seen = [];
    const { server, base } = await startServer((req, res) => {
      seen.push(req.headers.authorization);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const calls = [];
    try {
      const mod = await loadWithStubbedCdxrs(calls);
      mod.resetBatchFetchAvailability();
      await mod.prefetchJson([
        { headers: { Authorization: "Bearer caller-token" }, url: `${base}/x` },
      ]);
      // cdxrs has no field for a caller-supplied credential and derives its own
      // from GITHUB_TOKEN, so it must not be handed this request at all.
      assert.equal(calls.length, 0);
      assert.deepEqual(seen, ["Bearer caller-token"]);
    } finally {
      server.close();
      for (const [name, value] of [
        ["CDXGEN_RS_DISABLE", previousDisable],
        ["GITHUB_TOKEN", previousToken],
      ]) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    }
  });
});

/**
 * Load fetchBatch with a cdxrs bridge whose fetch answers are decided by
 * `respond`, recording the ids each run was asked for.
 */
async function loadWithScriptedCdxrs(runs, respond) {
  return await esmock("./fetchBatch.js", {
    "./cdxrs.js": {
      cdxrsAvailable: () => ({ available: true }),
      cdxrsDisabled: () => false,
      runCdxrs: async (_subcommand, opts) => {
        const ids = JSON.parse(opts.content).requests.map((r) => r.id);
        runs.push(ids);
        return respond(ids, runs.length);
      },
    },
  });
}

function envelopeFor(ids) {
  return {
    ok: true,
    stdout: JSON.stringify({
      schemaVersion: 1,
      results: ids.map((id) => ({ id, ok: true, body: { id } })),
      stats: {
        requests: ids.length,
        unique: ids.length,
        ok: ids.length,
        failures: 0,
        cacheHits: 1,
        revalidated: 0,
        elapsedMs: 10,
        peakConcurrency: Math.min(ids.length, 16),
        hosts: {
          "registry.invalid": {
            requests: ids.length,
            failures: 0,
            cacheHits: 1,
            rateLimited: 0,
          },
        },
      },
    }),
  };
}

describe("cdxrs fetch chunking (issue 4393)", async () => {
  const urls = (n, base = "https://registry.invalid") =>
    Array.from({ length: n }, (_, i) => ({ url: `${base}/pkg-${i}` }));

  await it("splits a workspace-sized batch into bounded cdxrs runs", async () => {
    const previous = process.env.CDXGEN_RS_DISABLE;
    delete process.env.CDXGEN_RS_DISABLE;
    const runs = [];
    try {
      const mod = await loadWithScriptedCdxrs(runs, envelopeFor);
      mod.resetBatchFetchAvailability();
      const fetched = await mod.prefetchJson(urls(600));
      assert.deepEqual(
        runs.map((ids) => ids.length),
        [250, 250, 100],
      );
      assert.equal(fetched.size, 600);
      assert.deepEqual(fetched.get("https://registry.invalid/pkg-599"), {
        ok: true,
        body: { id: "https://registry.invalid/pkg-599" },
      });
      // Sequential runs: counts and time add up, concurrency is the widest run.
      assert.deepEqual(mod.lastBatchStats(), {
        requests: 600,
        unique: 600,
        ok: 600,
        failures: 0,
        cacheHits: 3,
        revalidated: 0,
        elapsedMs: 30,
        peakConcurrency: 16,
        hosts: {
          "registry.invalid": {
            requests: 600,
            failures: 0,
            cacheHits: 3,
            rateLimited: 0,
          },
        },
      });
    } finally {
      if (previous === undefined) {
        delete process.env.CDXGEN_RS_DISABLE;
      } else {
        process.env.CDXGEN_RS_DISABLE = previous;
      }
    }
  });

  await it("halves a chunk whose envelope is too large instead of leaving cdxrs", async () => {
    const previous = process.env.CDXGEN_RS_DISABLE;
    delete process.env.CDXGEN_RS_DISABLE;
    const runs = [];
    try {
      // Any run of more than 60 URLs is "too large", so 250 → 125 → 63 → 32.
      const mod = await loadWithScriptedCdxrs(runs, (ids) =>
        ids.length > 60
          ? { ok: false, reason: "stdout-too-large" }
          : envelopeFor(ids),
      );
      mod.resetBatchFetchAvailability();
      const fetched = await mod.prefetchJson(urls(250));
      assert.equal(fetched.size, 250);
      for (const [, entry] of fetched) {
        assert.equal(entry.ok, true);
      }
      // Every URL was eventually served by exactly one successful cdxrs run.
      const served = runs.filter((ids) => ids.length <= 60).flat();
      assert.equal(served.length, 250);
      assert.equal(new Set(served).size, 250);
      assert.ok(runs.every((ids) => ids.length >= 31));
    } finally {
      if (previous === undefined) {
        delete process.env.CDXGEN_RS_DISABLE;
      } else {
        process.env.CDXGEN_RS_DISABLE = previous;
      }
    }
  });

  await it("sends only a failed chunk to the JS pool", async () => {
    const previous = process.env.CDXGEN_RS_DISABLE;
    delete process.env.CDXGEN_RS_DISABLE;
    const hits = [];
    const { server, base } = await startServer((req, res) => {
      hits.push(req.url);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ via: "js" }));
    });
    const runs = [];
    try {
      const mod = await loadWithScriptedCdxrs(runs, (ids, n) =>
        n === 2 ? { ok: false, reason: "timeout" } : envelopeFor(ids),
      );
      mod.resetBatchFetchAvailability();
      const fetched = await mod.prefetchJson(urls(300, base));
      assert.deepEqual(
        runs.map((ids) => ids.length),
        [250, 50],
      );
      assert.equal(fetched.size, 300);
      // The first 250 came from cdxrs; only the 50 in the timed-out run were
      // refetched by the JS pool.
      assert.equal(hits.length, 50);
      assert.deepEqual(fetched.get(`${base}/pkg-0`).body, {
        id: `${base}/pkg-0`,
      });
      assert.deepEqual(fetched.get(`${base}/pkg-299`).body, { via: "js" });
    } finally {
      server.close();
      if (previous === undefined) {
        delete process.env.CDXGEN_RS_DISABLE;
      } else {
        process.env.CDXGEN_RS_DISABLE = previous;
      }
    }
  });

  await it("gives a single oversized URL to the JS pool", async () => {
    const previous = process.env.CDXGEN_RS_DISABLE;
    delete process.env.CDXGEN_RS_DISABLE;
    const { server, base } = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ via: "js" }));
    });
    const runs = [];
    try {
      const mod = await loadWithScriptedCdxrs(runs, () => ({
        ok: false,
        reason: "stdout-too-large",
      }));
      mod.resetBatchFetchAvailability();
      const fetched = await mod.prefetchJson(urls(1, base));
      assert.equal(runs.length, 1);
      assert.deepEqual(fetched.get(`${base}/pkg-0`).body, { via: "js" });
    } finally {
      server.close();
      if (previous === undefined) {
        delete process.env.CDXGEN_RS_DISABLE;
      } else {
        process.env.CDXGEN_RS_DISABLE = previous;
      }
    }
  });
});
