import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import esmock from "esmock";
import { assert, it } from "poku";
import sinon from "sinon";

// A long-lived server must not answer one scan from another scan's registry
// memos: a release published between two requests would never be seen, and
// the memory would never be returned. Each request below looks the same npm
// package up, so the registry stub sees it once per request. The environment
// changes are process-wide, so this file holds one sequential test.

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

it("each server request starts with empty registry memos", async () => {
  const previous = {
    CDXGEN_RS_DISABLE: process.env.CDXGEN_RS_DISABLE,
    CDXGEN_GIT_ALLOWED_HOSTS: process.env.CDXGEN_GIT_ALLOWED_HOSTS,
  };
  process.env.CDXGEN_RS_DISABLE = "fetch";
  process.env.CDXGEN_GIT_ALLOWED_HOSTS = "127.0.0.1";
  const hits = [];
  const registry = createServer((req, res) => {
    hits.push(req.url);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        name: "left-pad",
        description: "from the registry",
        versions: { "1.3.0": { license: "WTFPL" } },
      }),
    );
  });
  const registryUrl = `http://127.0.0.1:${await listen(registry)}/`;
  const srcDir = mkdtempSync(join(tmpdir(), "cdxgen-server-runstate-"));
  let cdxgenServer;
  try {
    const { getNpmMetadata } = await import("../ecosystems/ecosystems.js");
    const createBom = sinon.stub().callsFake(async () => {
      const [pkg] = await getNpmMetadata(
        [{ name: "left-pad", version: "1.3.0" }],
        registryUrl,
      );
      return { bomJson: { components: [pkg] } };
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

    assert.strictEqual(await get(port, path), 200);
    // Positive control: the registry stub records the lookup.
    assert.deepStrictEqual(hits, ["/left-pad"]);
    assert.strictEqual(await get(port, path), 200);
    assert.deepStrictEqual(
      hits,
      ["/left-pad", "/left-pad"],
      "the second request was answered from the first request's memos",
    );
    assert.strictEqual(createBom.callCount, 2);
  } finally {
    await new Promise((resolve) =>
      cdxgenServer ? cdxgenServer.close(resolve) : resolve(),
    );
    await new Promise((resolve) => registry.close(resolve));
    rmSync(srcDir, { force: true, recursive: true });
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});
