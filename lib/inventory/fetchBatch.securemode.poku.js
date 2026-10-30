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

import { prefetchJson, resetBatchFetchAvailability } from "./fetchBatch.js";

it("blocks a disallowed host during a batch without issuing the request", async () => {
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
