import process from "node:process";

import esmock from "esmock";
import { assert, it } from "poku";
import sinon from "sinon";

import * as runState from "../core/runState.js";
import * as fetchRate from "./fetchRate.js";

// The scanned content names the hosts a run looks up, and a server performs
// many runs in one process. A name no host can have is refused before anything
// is kept under it, and a host's gate is forgotten between runs once it has
// opened. The agent is stubbed, so nothing is sent and no gate is waited at,
// and the limiter is wrapped to count the gates that are made. The file
// changes CDXGEN_NO_CACHE and CDXGEN_RS_DISABLE, so it holds one sequential
// test.

it("hosts named by scanned content are not kept past their run", async () => {
  const previous = {
    CDXGEN_NO_CACHE: process.env.CDXGEN_NO_CACHE,
    CDXGEN_RS_DISABLE: process.env.CDXGEN_RS_DISABLE,
  };
  process.env.CDXGEN_NO_CACHE = "true";
  process.env.CDXGEN_RS_DISABLE = "fetch";
  const calls = [];
  const get = sinon.stub().callsFake((url) => {
    calls.push(url);
    return Promise.resolve({ statusCode: 200, body: "spec" });
  });
  const gates = [];
  try {
    class CountedLimiter extends fetchRate.RateLimiter {
      constructor(minInterval) {
        super(minInterval);
        gates.push(this);
      }
    }
    const fetchBatch = await esmock(
      "./fetchBatch.js",
      {
        "./fetchRate.js": { ...fetchRate, RateLimiter: CountedLimiter },
        // The copy under test registers with the run state this test resets.
        "../core/runState.js": { ...runState },
      },
      {
        "../core/httpClient.js": {
          createHttpClient: sinon.stub().returns({ get }),
        },
      },
    );
    fetchBatch.resetBatchFetchAvailability();
    fetchBatch.resetHostCircuits();
    runState.resetRunState();
    const podspec = (name) => `https://pods.example/${name}.podspec`;

    // Positive control: a host gets one gate, which its requests share.
    await fetchBatch.prefetchJson([
      { url: podspec("a"), responseType: "text" },
    ]);
    await fetchBatch.gatedGet(podspec("b"), { responseType: "text" });
    assert.deepStrictEqual(calls, [podspec("a"), podspec("b")]);
    assert.strictEqual(gates.length, 1);

    // A name longer than DNS allows gets no gate and no request, from a batch
    // or from a caller's own request, and the error does not repeat it.
    const endless = `https://${"a".repeat(256)}/Pod.podspec`;
    const batch = await fetchBatch.prefetchJson([
      { url: endless, responseType: "text" },
    ]);
    assert.deepStrictEqual(batch.get(endless), {
      ok: false,
      status: undefined,
      definite: false,
    });
    await assert.rejects(
      fetchBatch.gatedGet(endless, { responseType: "text" }),
      (err) => /host name/.test(err.message) && err.message.length < 100,
    );
    assert.strictEqual(calls.length, 2, "a host that cannot exist was asked");
    assert.strictEqual(gates.length, 1, "a host that cannot exist got a gate");
    // A name of the longest length DNS allows is not refused.
    const longest = `https://${"a".repeat(255)}/Pod.podspec`;
    await fetchBatch.gatedGet(longest, { responseType: "text" });
    assert.strictEqual(calls.length, 3);
    assert.strictEqual(gates.length, 2);

    // Between runs a gate that has opened is forgotten: the next request to
    // the host makes a new one.
    runState.resetRunState();
    await fetchBatch.gatedGet(podspec("c"), { responseType: "text" });
    assert.strictEqual(gates.length, 3, "an open gate outlived its run");

    // One that is still closed is kept, so the delay the host asked for holds
    // in the next run too.
    gates[2].externalDelay(60_000);
    runState.resetRunState();
    await fetchBatch.gatedGet(podspec("d"), { responseType: "text" });
    assert.strictEqual(gates.length, 3, "a closed gate was forgotten");
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});
