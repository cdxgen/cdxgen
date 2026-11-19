import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import esmock from "esmock";
import { assert, it } from "poku";
import sinon from "sinon";

import {
  isBuildToolRateLimited,
  noteBuildToolRateLimit,
} from "../inventory/buildToolRateLimit.js";

// Which repositories answer HTTP 429 follows from the project a request
// scans. A request whose build tool met one must not stop that build tool for
// the requests of other clients that the server handles at the same time.

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: "GET" },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

it("a rate limit one server request met does not stop the build tool of another", async () => {
  const gradle429 = readFileSync(
    join(
      import.meta.dirname,
      "..",
      "..",
      "test",
      "data",
      "jvm-rate-limits",
      "gradle-429.txt",
    ),
    "utf-8",
  );
  const srcDir = mkdtempSync(join(tmpdir(), "cdxgen-server-ratelimit-"));
  let cdxgenServer;
  let limitedScanNoted;
  const limitedScanWaiting = new Promise((resolve) => {
    limitedScanNoted = resolve;
  });
  let finishLimitedScan;
  const otherScanDone = new Promise((resolve) => {
    finishLimitedScan = resolve;
  });
  try {
    const seen = {};
    const createBom = sinon.stub();
    // The first request's build tool meets a rate limit, and the request then
    // stays open, as it does while its BOM is uploaded.
    createBom.onFirstCall().callsFake(async () => {
      noteBuildToolRateLimit("gradle", gradle429);
      limitedScanNoted();
      await otherScanDone;
      seen.limitedScan = isBuildToolRateLimited("gradle");
      return { bomJson: { components: [] } };
    });
    createBom.onSecondCall().callsFake(async () => {
      seen.otherScan = isBuildToolRateLimited("gradle");
      return { bomJson: { components: [] } };
    });
    const http = await import("node:http");
    const { start } = await esmock("./server.js", {
      "../cli/index.js": { createBom, submitBom: sinon.stub() },
      "../stages/postgen/postgen.js": { postProcess: async (data) => data },
      "node:http": {
        ...http,
        default: {
          ...http.default,
          createServer: (app) => {
            cdxgenServer = http.default.createServer(app);
            return cdxgenServer;
          },
        },
      },
    });
    // start() refuses port 0, so a free port is found first.
    const probe = createServer();
    const port = await listen(probe);
    await new Promise((resolve) => probe.close(resolve));
    start({ serverHost: "127.0.0.1", serverPort: port });
    await new Promise((resolve) => cdxgenServer.once("listening", resolve));
    const path = `/sbom?path=${encodeURIComponent(srcDir)}`;

    const limitedRequest = get(port, path);
    await limitedScanWaiting;
    assert.strictEqual(await get(port, path), 200);
    assert.strictEqual(
      seen.otherScan,
      false,
      "the second request found gradle stopped by the first request's rate limit",
    );
    finishLimitedScan();
    assert.strictEqual(await limitedRequest, 200);
    // Positive control: the first request keeps what it found out itself.
    assert.strictEqual(seen.limitedScan, true);
    assert.strictEqual(createBom.callCount, 2);
  } finally {
    // A failed assertion must not leave the first request open.
    finishLimitedScan();
    await new Promise((resolve) =>
      cdxgenServer ? cdxgenServer.close(resolve) : resolve(),
    );
    rmSync(srcDir, { force: true, recursive: true });
  }
});
