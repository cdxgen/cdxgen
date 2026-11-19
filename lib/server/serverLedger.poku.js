import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import esmock from "esmock";
import { assert, it } from "poku";
import sinon from "sinon";

import { getLedgerEvents, recordDegradation } from "../core/buildLedger.js";

// A long-lived server must not judge one client's project by the build events
// of an earlier client's scan. The scan of the first directory below records
// a degradation, and the scan of the second directory follows once it has
// ended. The environment changes are process-wide, so this file holds one
// sequential test.

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
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve(JSON.parse(body)));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

it("each server request starts with an empty build ledger", async () => {
  const previous = {
    CDXGEN_INTROSPECT: process.env.CDXGEN_INTROSPECT,
    CDXGEN_INTROSPECT_LEDGER: process.env.CDXGEN_INTROSPECT_LEDGER,
  };
  process.env.CDXGEN_INTROSPECT = "true";
  delete process.env.CDXGEN_INTROSPECT_LEDGER;
  const brokenDir = mkdtempSync(join(tmpdir(), "cdxgen-server-ledger-"));
  const healthyDir = mkdtempSync(join(tmpdir(), "cdxgen-server-ledger-"));
  let cdxgenServer;
  try {
    const createBom = sinon.stub().callsFake(async (srcDir) => {
      if (srcDir === brokenDir) {
        recordDegradation("js.lockfile-version", {
          ecosystem: "npm",
          impact: "transitive-deps",
        });
      }
      return { bomJson: {} };
    });
    // What the reflection of a request would read.
    const postProcess = async () => ({
      bomJson: {
        remediationIds: getLedgerEvents().map((event) => event.remediationId),
      },
    });
    const http = await import("node:http");
    const { start } = await esmock("./server.js", {
      "../cli/index.js": { createBom, submitBom: sinon.stub() },
      "../stages/postgen/postgen.js": { postProcess },
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
    const scan = (dir) => get(port, `/sbom?path=${encodeURIComponent(dir)}`);

    // Positive control: the scan that recorded the degradation reads it.
    assert.deepStrictEqual(await scan(brokenDir), {
      remediationIds: ["js.lockfile-version"],
    });
    assert.deepStrictEqual(
      await scan(healthyDir),
      { remediationIds: [] },
      "a scan read the events of an earlier scan",
    );
    assert.strictEqual(createBom.callCount, 2);
  } finally {
    await new Promise((resolve) =>
      cdxgenServer ? cdxgenServer.close(resolve) : resolve(),
    );
    rmSync(brokenDir, { force: true, recursive: true });
    rmSync(healthyDir, { force: true, recursive: true });
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});
