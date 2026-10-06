import process from "node:process";

import esmock from "esmock";
import { assert, it } from "poku";
import sinon from "sinon";

// Maven Central escalates IP blocks when requests keep arriving, so a 429 from
// it pauses the host instead of being retried. The agent is stubbed because
// the breaker keys on Maven Central's real hostnames.

it("a 429 from Maven Central pauses every further request to it", async () => {
  const previousRsDisable = process.env.CDXGEN_RS_DISABLE;
  process.env.CDXGEN_RS_DISABLE = "fetch";
  const calls = [];
  const get = sinon.stub().callsFake((url) => {
    calls.push(url);
    if (url.startsWith("https://repo1.maven.org/")) {
      const err = new Error("Response code 429 (Too Many Requests)");
      err.name = "HTTPError";
      err.response = { statusCode: 429, headers: { "retry-after": "1" } };
      return Promise.reject(err);
    }
    return Promise.resolve({ statusCode: 200, body: { ok: true } });
  });
  const warn = sinon.stub(console, "warn");
  const clock = sinon.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
  try {
    const fetchBatch = await esmock(
      "./fetchBatch.js",
      {},
      {
        "../core/httpClient.js": {
          createHttpClient: sinon.stub().returns({ get }),
        },
      },
    );
    fetchBatch.resetBatchFetchAvailability();
    fetchBatch.resetHostCircuits();
    const pom = (n) =>
      `https://repo1.maven.org/maven2/org/example/lib${n}/1.0/lib${n}-1.0.pom`;

    // The first 429 is final: no retry, and the host is paused.
    const first = await fetchBatch.prefetchJson([
      { url: pom(1), responseType: "text" },
    ]);
    assert.deepStrictEqual(first.get(pom(1)), {
      ok: false,
      status: 429,
      definite: true,
    });
    assert.deepStrictEqual(calls, [pom(1)]);
    assert.ok(fetchBatch.isHostCircuitOpen("repo1.maven.org"));

    // Later batches and single requests to the paused host never go out.
    const second = await fetchBatch.prefetchJson([
      { url: pom(2), responseType: "text" },
      { url: "https://registry.npmjs.org/left-pad", responseType: "json" },
    ]);
    assert.strictEqual(second.get(pom(2)).definite, true);
    assert.strictEqual(
      second.get("https://registry.npmjs.org/left-pad").ok,
      true,
    );
    await assert.rejects(
      fetchBatch.withHostRateLimit(pom(3), () => get(pom(3))),
      (err) =>
        err.code === "CDXGEN_HOST_CIRCUIT_OPEN" && err.statusCode === 429,
    );
    assert.deepStrictEqual(calls, [
      pom(1),
      "https://registry.npmjs.org/left-pad",
    ]);

    // One warning, naming the mirror setting.
    const warnings = warn.args
      .map((args) => String(args[0]))
      .filter((message) => message.includes("repo1.maven.org"));
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /MAVEN_CENTRAL_URL/);

    // The pause ends, so a long-running server recovers.
    clock.tick(11 * 60 * 1000);
    assert.ok(!fetchBatch.isHostCircuitOpen("repo1.maven.org"));

    // A pause the host is not responsible for is silent.
    const warningsBefore = warn.callCount;
    fetchBatch.openHostCircuit("central.sonatype.com", {
      cause: "did not answer",
      quiet: true,
    });
    assert.ok(fetchBatch.isHostCircuitOpen("central.sonatype.com"));
    assert.strictEqual(warn.callCount, warningsBefore);

    // A 429 seen by a caller's own request opens the circuit too.
    fetchBatch.resetHostCircuits();
    await assert.rejects(
      fetchBatch.withHostRateLimit(pom(4), () => get(pom(4))),
      (err) => err.response?.statusCode === 429,
    );
    assert.ok(fetchBatch.isHostCircuitOpen("repo1.maven.org"));
  } finally {
    clock.restore();
    warn.restore();
    if (previousRsDisable === undefined) {
      delete process.env.CDXGEN_RS_DISABLE;
    } else {
      process.env.CDXGEN_RS_DISABLE = previousRsDisable;
    }
  }
});

it("withHostRateLimit can defer its rate gate to the network call", async () => {
  const fetchBatch = await import("./fetchBatch.js");
  let gateOptions;
  const result = await fetchBatch.withHostRateLimit(
    "https://crates.io/api/v1/crates/serde",
    (gate) => {
      gateOptions = gate;
      return Promise.resolve("done");
    },
    { deferGate: true },
  );
  assert.strictEqual(result, "done");
  assert.strictEqual(gateOptions.hooks.beforeNetwork.length, 1);
  // Without deferGate the gate runs before issue, which receives no hook.
  await fetchBatch.withHostRateLimit(
    "https://crates.io/api/v1/crates/rand",
    (gate) => {
      gateOptions = gate;
      return Promise.resolve();
    },
  );
  assert.deepStrictEqual(gateOptions, {});
});
