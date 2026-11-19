/**
 * Secure-mode test for the JS batch pool.
 *
 * Lives in its own file because it mutates `CDXGEN_ALLOWED_HOSTS`, which
 * poku's concurrent test scheduling would leak into sibling tests in the same
 * file. Running in a separate process keeps the policy mutation isolated.
 */
import { createServer } from "node:http";
import process from "node:process";

import { strict as assert, it } from "poku";

import {
  prefetchJson,
  resetBatchFetchAvailability,
  withHostRateLimit,
} from "./fetchBatch.js";
import { DEFAULT_GLOBAL_CONCURRENCY } from "./fetchRate.js";

// The tests share the allowlist and the batcher's module state, so each `it`
// is awaited to keep them sequential.
await it("blocks a disallowed host during a batch without issuing the request", async () => {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}`;

  const previous = {
    CDXGEN_RS_DISABLE: process.env.CDXGEN_RS_DISABLE,
    CDXGEN_ALLOWED_HOSTS: process.env.CDXGEN_ALLOWED_HOSTS,
  };
  process.env.CDXGEN_RS_DISABLE = "fetch";
  // Restrict to a host the test server is NOT on. The batch must not be a hole
  // in the allowlist: every request still flows through cdxgenAgent's
  // beforeRequest hook, which enforces CDXGEN_ALLOWED_HOSTS.
  process.env.CDXGEN_ALLOWED_HOSTS = "example.com";
  resetBatchFetchAvailability();
  try {
    const result = await prefetchJson([{ url: `${url}/blocked` }]);
    assert.strictEqual(result.size, 1);
    const entry = result.get(`${url}/blocked`);
    assert.ok(entry, "entry missing");
    assert.strictEqual(
      entry.ok,
      false,
      "a blocked host must not be reported as a success",
    );
    // The request must not have reached the server — the batch is not a hole
    // in CDXGEN_ALLOWED_HOSTS.
    assert.strictEqual(
      requests.length,
      0,
      "secure mode was bypassed by the batch",
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    resetBatchFetchAvailability();
  }
});

await it("a batch queued for a serial host leaves the global permits to other hosts", async () => {
  const previous = {
    CDXGEN_RS_DISABLE: process.env.CDXGEN_RS_DISABLE,
    CDXGEN_ALLOWED_HOSTS: process.env.CDXGEN_ALLOWED_HOSTS,
  };
  process.env.CDXGEN_RS_DISABLE = "fetch";
  // crates.io is not allowed, so the batch below is refused by the allowlist
  // once it leaves the queue, and nothing here reaches the network.
  process.env.CDXGEN_ALLOWED_HOSTS = "example.com";
  resetBatchFetchAvailability();
  let finish;
  const unfinished = new Promise((resolve) => {
    finish = resolve;
  });
  // One request holds crates.io's only permit. The gate is deferred and never
  // consulted, so only the semaphores are exercised.
  const inFlight = withHostRateLimit(
    "https://crates.io/api/v1/crates/held",
    () => unfinished,
    { deferGate: true },
  );
  // A batch wider than the global cap queues behind it.
  const batch = prefetchJson(
    Array.from({ length: DEFAULT_GLOBAL_CONCURRENCY + 1 }, (_, i) => ({
      url: `https://crates.io/api/v1/crates/crate${i}`,
    })),
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const outcome = await Promise.race([
      withHostRateLimit(
        "https://registry.npmjs.org/left-pad",
        async () => "answered",
        { deferGate: true },
      ),
      new Promise((resolve) => setTimeout(resolve, 250, "stalled")),
    ]);
    assert.strictEqual(
      outcome,
      "answered",
      "a request to another host waited for crates.io's queue",
    );
  } finally {
    finish();
    await inFlight;
    await batch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    resetBatchFetchAvailability();
  }
});
