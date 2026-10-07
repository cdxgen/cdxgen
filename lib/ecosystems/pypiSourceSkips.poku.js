import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import esmock from "esmock";
import { assert, it } from "poku";
import sinon from "sinon";

// PyPI enrichment of a uv lock against a stubbed agent, so the assertions are
// about the exact requests made. The fixture holds a virtual workspace root, a
// private-index package, a git package and an editable install; none of them
// is on PyPI.

it("parsePyLockData asks PyPI only for packages it can hold", async () => {
  const previousFetchLicense = process.env.FETCH_LICENSE;
  const previousPypiUrl = process.env.PYPI_URL;
  const previousRsDisable = process.env.CDXGEN_RS_DISABLE;
  process.env.FETCH_LICENSE = "true";
  process.env.CDXGEN_RS_DISABLE = "fetch";
  const requested = [];
  const agentGet = sinon.stub().callsFake(async (url) => {
    requested.push(url);
    return {
      statusCode: 200,
      body: {
        info: {
          name: "leftpad",
          version: "9.9.9",
          license: "MIT",
          summary: "remote",
          classifiers: [],
        },
        releases: {},
        urls: [],
      },
    };
  });
  const httpClientMock = {
    "../core/httpClient.js": {
      createHttpClient: sinon.stub().returns({ get: agentGet }),
    },
  };
  try {
    const { resetBatchFetchAvailability } = await import(
      "../inventory/fetchBatch.js"
    );
    resetBatchFetchAvailability();
    process.env.PYPI_URL = "http://127.0.0.1:1/pypi/";
    const uvLock = join(
      import.meta.dirname,
      "../../test/data/registry-stub/py/uv.lock",
    );
    const { parsePyLockData } = await esmock(
      "./parsers-python.js",
      {},
      httpClientMock,
    );
    const { pkgList } = await parsePyLockData(
      readFileSync(uvLock, "utf-8"),
      uvLock,
    );
    // The virtual root, the private-index package, the git package and the
    // editable install were never asked about.
    assert.deepStrictEqual(requested, []);
    const byName = new Map(pkgList.map((p) => [p.name, p]));
    assert.strictEqual(byName.get("demo").license, undefined);
    assert.strictEqual(byName.get("privpkg").license, undefined);
    assert.strictEqual(byName.get("gitpkg").license, undefined);
    assert.strictEqual(byName.get("localpkg").license, undefined);
    assert.strictEqual(
      byName
        .get("privpkg")
        .properties.some((prop) => prop.name === "cdx:pypi:registry"),
      true,
    );

    // A package PyPI holds is still enriched.
    const { getPyMetadata } = await esmock(
      "./ecosystems.js",
      {},
      httpClientMock,
    );
    const [enriched] = await getPyMetadata(
      [{ name: "leftpad", version: "1.0.0" }],
      false,
    );
    assert.deepStrictEqual(requested, [
      "http://127.0.0.1:1/pypi/leftpad/1.0.0/json",
    ]);
    assert.deepStrictEqual(enriched.license, ["MIT"]);
  } finally {
    for (const [name, value] of Object.entries({
      FETCH_LICENSE: previousFetchLicense,
      PYPI_URL: previousPypiUrl,
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
