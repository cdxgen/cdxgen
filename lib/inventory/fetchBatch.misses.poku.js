/**
 * What the batch pool remembers within a run: documents that answered 404 or
 * 410, and hosts that keep answering 429.
 *
 * A loopback registry records every request that arrives. The file changes
 * CDXGEN_RS_DISABLE and pauses the loopback host, so it holds one sequential
 * test.
 */
import { createServer } from "node:http";
import process from "node:process";

import { assert, it } from "poku";
import sinon from "sinon";

import { resetRunState } from "../core/runState.js";
import {
  gatedGet,
  isHostCircuitOpen,
  prefetchedResponse,
  prefetchJson,
  resetBatchFetchAvailability,
  resetHostCircuits,
} from "./fetchBatch.js";

it("misses are asked once per run, and a host that keeps refusing is paused", async () => {
  const previousRsDisable = process.env.CDXGEN_RS_DISABLE;
  process.env.CDXGEN_RS_DISABLE = "fetch";
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(req.url);
    if (req.url.startsWith("/gone")) {
      res.writeHead(410, { "content-type": "application/json" });
      return res.end("{}");
    }
    if (req.url.startsWith("/busy")) {
      res.writeHead(503, { "content-type": "application/json" });
      return res.end("{}");
    }
    if (req.url.startsWith("/limited")) {
      res.writeHead(429, { "content-type": "text/html", "retry-after": "0" });
      return res.end("<html>slow down</html>");
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const warn = sinon.stub(console, "warn");
  try {
    resetBatchFetchAvailability();
    resetHostCircuits();
    resetRunState();

    // A 404 in a batch is not asked for again by a later batch or by a
    // caller's own request.
    const first = await prefetchJson([{ url: `${base}/missing` }]);
    assert.deepStrictEqual(hits, ["/missing"]);
    assert.strictEqual(first.get(`${base}/missing`).status, 404);
    const second = await prefetchJson([{ url: `${base}/missing` }]);
    assert.deepStrictEqual(
      hits,
      ["/missing"],
      "a later pass asked again for a document that answered 404",
    );
    assert.strictEqual(second.get(`${base}/missing`).definite, true);
    await assert.rejects(
      gatedGet(`${base}/missing`, { responseType: "json" }),
      (err) => err.statusCode === 404,
    );
    // A 410 met by a caller's own request is remembered the same way.
    await assert.rejects(gatedGet(`${base}/gone`), (err) =>
      [err.statusCode, err.response?.statusCode].includes(410),
    );
    await assert.rejects(gatedGet(`${base}/gone`));
    assert.deepStrictEqual(hits, ["/missing", "/gone"]);
    // The memo lasts for the run only.
    resetRunState();
    await assert.rejects(gatedGet(`${base}/missing`));
    assert.deepStrictEqual(hits, ["/missing", "/gone", "/missing"]);

    // A 5xx after the batch's retries is the answer for this pass: the
    // caller's catch runs instead of a fifth request.
    hits.length = 0;
    const busy = await prefetchJson([{ url: `${base}/busy` }]);
    assert.strictEqual(hits.length, 4);
    assert.throws(
      () => prefetchedResponse(busy, `${base}/busy`),
      (err) => err.response?.statusCode === 503,
    );

    // Three requests that end in 429 pause the host, with one warning.
    hits.length = 0;
    await prefetchJson([
      { url: `${base}/limited/1` },
      { url: `${base}/limited/2` },
      { url: `${base}/limited/3` },
    ]);
    assert.ok(isHostCircuitOpen("127.0.0.1"), "the host was not paused");
    const asked = hits.length;
    const later = await prefetchJson([{ url: `${base}/limited/4` }]);
    assert.strictEqual(later.get(`${base}/limited/4`).status, 429);
    await assert.rejects(gatedGet(`${base}/limited/5`));
    assert.strictEqual(hits.length, asked, "a paused host was asked again");
    const warnings = warn.args
      .map((args) => String(args[0]))
      .filter((message) => message.includes("127.0.0.1"));
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /429/);
  } finally {
    warn.restore();
    resetHostCircuits();
    resetRunState();
    await new Promise((resolve) => server.close(resolve));
    if (previousRsDisable === undefined) {
      delete process.env.CDXGEN_RS_DISABLE;
    } else {
      process.env.CDXGEN_RS_DISABLE = previousRsDisable;
    }
  }
});
