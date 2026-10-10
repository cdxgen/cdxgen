import process from "node:process";

import { assert, it } from "poku";

import {
  batchFetchAvailable,
  lastBatchStats,
  prefetchEnabled,
  prefetchedResponse,
  prefetchJson,
  resetBatchFetchAvailability,
} from "./fetchBatch.js";

/** Run `fn` with env vars set, restoring them afterwards. */
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

it("prefetchJson returns an empty map for an empty or invalid request list", async () => {
  assert.strictEqual((await prefetchJson([])).size, 0);
  assert.strictEqual((await prefetchJson(undefined)).size, 0);
  assert.strictEqual((await prefetchJson([{}, { url: "" }])).size, 0);
});

it("CDXGEN_RS_DISABLE=fetch disables the Rust subprocess but not the JS batcher", async () => {
  await withEnv({ CDXGEN_RS_DISABLE: "fetch" }, async () => {
    resetBatchFetchAvailability();
    // The Rust probe reports unavailable, but prefetching as a whole is still
    // on: the JS pool runs every request through cdxgenAgent. Removing the
    // serial path from the common case is the point of this round.
    assert.strictEqual(batchFetchAvailable(), false);
    assert.strictEqual(prefetchEnabled(), true);
  });
  resetBatchFetchAvailability();
});

it("prefetchEnabled is false under cassette replay even when the binary exists", async () => {
  await withEnv({ CDXGEN_CASSETTE_REPLAY: "true" }, () => {
    resetBatchFetchAvailability();
    // Replay intercepts undici inside this process; a subprocess would bypass
    // it and reach the live network while the cassette went unused.
    assert.strictEqual(prefetchEnabled(), false);
  });
  resetBatchFetchAvailability();
});

it("prefetchedResponse asks the caller to fetch when nothing was prefetched", () => {
  assert.strictEqual(prefetchedResponse(new Map(), "https://x/y"), undefined);
  assert.strictEqual(prefetchedResponse(undefined, "https://x/y"), undefined);
});

it("prefetchedResponse returns a response-shaped object for a hit", () => {
  const prefetched = new Map([
    ["https://x/y", { ok: true, body: { name: "left-pad" } }],
  ]);
  const res = prefetchedResponse(prefetched, "https://x/y");
  assert.deepStrictEqual(res, { body: { name: "left-pad" } });
});

it("prefetchedResponse throws for a definite HTTP error so the caller's catch runs", () => {
  const prefetched = new Map([
    ["https://x/missing", { ok: false, status: 404, definite: true }],
  ]);
  let threw;
  try {
    prefetchedResponse(prefetched, "https://x/missing");
  } catch (err) {
    threw = err;
  }
  assert.ok(threw, "a definite 404 must throw, as cdxgenAgent.get would");
  assert.strictEqual(threw.statusCode, 404);
});

it("prefetchedResponse falls back to the caller for a transport failure only", () => {
  // A timeout or reset is worth one more try through the JS agent, which has
  // its own proxy and auth handling. A 5xx or a 429 is the server's answer
  // after the batch's own retries, so asking again at once only adds load.
  const prefetched = new Map([
    ["https://x/y", { ok: false, status: undefined, definite: false }],
    ["https://x/z", { ok: false, status: 503, definite: false }],
    ["https://x/rate", { ok: false, status: 429, definite: false }],
  ]);
  assert.strictEqual(prefetchedResponse(prefetched, "https://x/y"), undefined);
  assert.throws(
    () => prefetchedResponse(prefetched, "https://x/z"),
    (err) => err.statusCode === 503 && err.response.statusCode === 503,
  );
  // A 429 is never mistaken for a missing document.
  assert.throws(
    () => prefetchedResponse(prefetched, "https://x/rate"),
    (err) => err.statusCode === 429,
  );
});

it("lastBatchStats is null until a batch runs", () => {
  resetBatchFetchAvailability();
  assert.strictEqual(lastBatchStats(), null);
});
