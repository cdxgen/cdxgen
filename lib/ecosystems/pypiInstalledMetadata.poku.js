import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import esmock from "esmock";
import { assert, it } from "poku";
import sinon from "sinon";

// The installed dist-info METADATA files answer before PyPI: a lockfile entry
// whose installed distribution names its licence is not asked about, and the
// installation never becomes a component of its own. The assertions are on the
// exact requests a stubbed agent records.

const FIXTURE = join(import.meta.dirname, "../../test/data/registry-stub/py");

it("installed METADATA enriches the lockfile entries it matches", async () => {
  const previousFetchLicense = process.env.FETCH_LICENSE;
  const previousPypiUrl = process.env.PYPI_URL;
  const previousRsDisable = process.env.CDXGEN_RS_DISABLE;
  process.env.FETCH_LICENSE = "true";
  process.env.CDXGEN_RS_DISABLE = "fetch";
  process.env.PYPI_URL = "http://127.0.0.1:1/pypi/";
  const requested = [];
  const agentGet = sinon.stub().callsFake(async (url) => {
    requested.push(url);
    return {
      statusCode: 200,
      body: {
        info: {
          name: "certifi",
          version: "2026.7.22",
          summary: "from the registry",
          license: "",
          classifiers: ["License :: OSI Approved :: MIT License"],
        },
        releases: {},
      },
    };
  });
  try {
    const { resetBatchFetchAvailability } = await import(
      "../inventory/fetchBatch.js"
    );
    resetBatchFetchAvailability();
    const { parseBdistMetadata } = await esmock(
      "./ecosystems.js",
      {},
      {
        "../core/httpClient.js": {
          createHttpClient: sinon.stub().returns({ get: agentGet }),
        },
      },
    );
    const { parsePyLockData } = await esmock(
      "./parsers-python.js",
      {},
      {
        "../core/httpClient.js": {
          createHttpClient: sinon.stub().returns({ get: agentGet }),
        },
      },
    );

    // The METADATA file of the installed attrs distribution, as the scan
    // itself reads it.
    const installedMetadata = [
      parseBdistMetadata(
        join(
          FIXTURE,
          "venv/lib/python3.12/site-packages/attrs-25.3.0.dist-info/METADATA",
        ),
      )[0],
    ];
    assert.strictEqual(installedMetadata[0].name, "attrs");

    const lockData = readFileSync(join(FIXTURE, "uv-installed.lock"), "utf-8");
    const { pkgList } = await parsePyLockData(
      lockData,
      join(FIXTURE, "uv-installed.lock"),
      undefined,
      { installedMetadata },
    );
    // attrs answered from its installation; certifi has no installation here,
    // so the registry is asked about it. The virtual, private, git and
    // editable sources stay unasked.
    assert.deepStrictEqual(requested.sort(), [
      "http://127.0.0.1:1/pypi/certifi/2026.7.22/json",
    ]);
    const byName = new Map(pkgList.map((p) => [p.name, p]));
    assert.deepStrictEqual(byName.get("attrs").license, ["MIT"]);
    assert.strictEqual(
      byName.get("attrs").description,
      "Classes Without Boilerplate",
    );
    assert.ok(byName.get("attrs").licenses?.length);
    // The public package without an installation was enriched by the registry.
    assert.deepStrictEqual(byName.get("certifi").license, ["MIT"]);
    assert.strictEqual(byName.get("certifi").description, "from the registry");
    // The installation enriched the entry; it added no component.
    assert.strictEqual(pkgList.filter((p) => p.name === "attrs").length, 1);
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
