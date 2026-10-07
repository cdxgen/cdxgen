import { join } from "node:path";
import process from "node:process";

import esmock from "esmock";
import { assert, it } from "poku";
import sinon from "sinon";

// package-lock enrichment against a stubbed agent, so the assertions are about
// the exact requests made. The npm fixture holds a workspace, a link, a file
// dependency, a git dependency and a scope that .npmrc maps to another
// registry; none of them can be asked about on the default registry.

it("parsePkgLock asks the registry only for packages it can hold", async () => {
  const previousFetchLicense = process.env.FETCH_LICENSE;
  const previousNpmUrl = process.env.NPM_URL;
  const previousRsDisable = process.env.CDXGEN_RS_DISABLE;
  process.env.FETCH_LICENSE = "true";
  process.env.CDXGEN_RS_DISABLE = "fetch";
  const documents = {
    "http://127.0.0.1:1/left-pad": {
      license: "REMOTE-NPM",
      versions: {},
    },
    "http://127.0.0.1:1/nolic": { name: "nolic" },
    "http://npm.acme.invalid/@acme/private": {
      license: "ACME-REMOTE",
      versions: {},
    },
  };
  const requested = [];
  const agentGet = sinon.stub().callsFake(async (url) => {
    requested.push(url);
    return { statusCode: 200, body: documents[url] || {} };
  });
  try {
    const { resetBatchFetchAvailability } = await import(
      "../inventory/fetchBatch.js"
    );
    resetBatchFetchAvailability();
    const { parsePkgLock } = await esmock(
      "./parsers-js.js",
      {},
      {
        "../core/httpClient.js": {
          createHttpClient: sinon.stub().returns({ get: agentGet }),
        },
      },
    );
    process.env.NPM_URL = "http://127.0.0.1:1/";
    const { pkgList } = await parsePkgLock(
      join(
        import.meta.dirname,
        "../../test/data/registry-stub/npm/package-lock.json",
      ),
    );
    assert.deepStrictEqual(requested.sort(), [
      "http://127.0.0.1:1/left-pad",
      "http://127.0.0.1:1/nolic",
      "http://npm.acme.invalid/@acme/private",
    ]);
    const find = (name, version) =>
      pkgList.filter((p) => p.name === name && p.version === version);
    // The public packages are enriched from the stub registry.
    assert.strictEqual(find("left-pad", "1.3.0")[0].license, "REMOTE-NPM");
    assert.strictEqual(find("nolic", "1.0.0")[0].license, undefined);
    // The mapped scope is enriched from its own registry.
    assert.strictEqual(find("private", "2.0.0")[0].license, "ACME-REMOTE");
    // The project, the workspace member, the file and git sources keep the
    // data the lockfile gave them and were never asked about.
    assert.strictEqual(find("root", "1.0.0")[0].license, undefined);
    for (const local of find("localdep", "0.0.1")) {
      assert.strictEqual(local.license, "ISC");
    }
    for (const ws of find("my-ws", "0.1.0")) {
      assert.strictEqual(ws.license, "Apache-2.0");
    }
    assert.strictEqual(find("gitdep", "1.0.0")[0].license, "MIT");
  } finally {
    for (const [name, value] of Object.entries({
      FETCH_LICENSE: previousFetchLicense,
      NPM_URL: previousNpmUrl,
      CDXGEN_RS_DISABLE: previousRsDisable,
    })) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});
