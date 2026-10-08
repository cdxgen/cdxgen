import { join } from "node:path";
import process from "node:process";

import esmock from "esmock";
import { assert, it } from "poku";
import sinon from "sinon";

// The registry is asked only about the fields the project, the lockfile or an
// installed manifest left open, and a licence one of them already gave is
// never replaced. The assertions are on the exact requests a stubbed agent
// records.

const FIXTURE = join(import.meta.dirname, "../../test/data/registry-stub/npm");

it("npm enrichment keeps local answers and skips complete packages", async () => {
  const previousFetchLicense = process.env.FETCH_LICENSE;
  const previousNpmUrl = process.env.NPM_URL;
  const previousRsDisable = process.env.CDXGEN_RS_DISABLE;
  process.env.FETCH_LICENSE = "true";
  const previousFetchPkgMetadata = process.env.CDXGEN_FETCH_PKG_METADATA;
  process.env.CDXGEN_RS_DISABLE = "fetch";
  delete process.env.CDXGEN_FETCH_PKG_METADATA;
  const requested = [];
  const agentGet = sinon.stub().callsFake(async (url) => {
    requested.push(url);
    if (url.endsWith("/nolic")) {
      return { statusCode: 200, body: { name: "nolic" } };
    }
    return {
      statusCode: 200,
      body: { license: "REMOTE-NPM", description: "remote", versions: {} },
    };
  });
  try {
    const { resetBatchFetchAvailability } = await import(
      "../inventory/fetchBatch.js"
    );
    resetBatchFetchAvailability();
    const { parsePkgLock, parsePkgJson } = await esmock(
      "./parsers-js.js",
      {},
      {
        "../core/httpClient.js": {
          createHttpClient: sinon.stub().returns({ get: agentGet }),
        },
      },
    );

    // The lockfile answers the licence of every package it holds. left-pad
    // and nolic still lack a description, so they are asked about; the entry
    // that already states its licence, description and repository is not.
    process.env.NPM_URL = "http://127.0.0.1:1/npm/";
    const { pkgList } = await parsePkgLock(join(FIXTURE, "package-lock.json"));
    assert.deepStrictEqual(requested.sort(), [
      "http://127.0.0.1:1/npm/left-pad",
      "http://127.0.0.1:1/npm/nolic",
      // The scope the fixture's .npmrc maps elsewhere is asked there, for the
      // description its lockfile entry does not carry.
      "http://npm.acme.invalid/@acme/private",
    ]);
    const find = (name, version) =>
      pkgList.filter((p) => p.name === name && p.version === version);
    assert.strictEqual(find("left-pad", "1.3.0")[0].license, "MIT");
    assert.strictEqual(find("nolic", "1.0.0")[0].license, "BSD-3-Clause");
    const complete = find("completepkg", "2.0.0")[0];
    assert.strictEqual(complete.license, "Apache-2.0");
    assert.strictEqual(
      complete.description,
      "A package whose lockfile entry says everything",
    );

    // An installed manifest that says everything is not asked about at all.
    // A fresh registry base keeps the in-run document cache out of the way.
    requested.length = 0;
    process.env.NPM_URL = "http://127.0.0.1:1/npm2/";
    const [padded] = await parsePkgJson(
      join(FIXTURE, "node_modules/left-pad/package.json"),
    );
    assert.deepStrictEqual(requested, []);
    assert.strictEqual(padded.license, "MIT");
    assert.strictEqual(padded.description, "String left pad");

    // A manifest with only the licence is still asked about, for the fields
    // it lacks, and keeps the licence the manifest gave.
    const [nolicPkg] = await parsePkgJson(
      join(FIXTURE, "node_modules/nolic/package.json"),
    );
    assert.deepStrictEqual(requested, ["http://127.0.0.1:1/npm2/nolic"]);
    assert.strictEqual(nolicPkg.license, "BSD-3-Clause");

    // When registry provenance is wanted, as under --bom-audit, a manifest
    // that says everything is still asked about, for the provenance no local
    // file holds, and its own fields survive the round.
    requested.length = 0;
    process.env.NPM_URL = "http://127.0.0.1:1/npm3/";
    process.env.CDXGEN_FETCH_PKG_METADATA = "true";
    const [audited] = await parsePkgJson(
      join(FIXTURE, "node_modules/left-pad/package.json"),
    );
    assert.deepStrictEqual(requested, ["http://127.0.0.1:1/npm3/left-pad"]);
    assert.strictEqual(audited.license, "MIT");
    assert.strictEqual(audited.description, "String left pad");
  } finally {
    for (const [name, value] of Object.entries({
      FETCH_LICENSE: previousFetchLicense,
      NPM_URL: previousNpmUrl,
      CDXGEN_RS_DISABLE: previousRsDisable,
      CDXGEN_FETCH_PKG_METADATA: previousFetchPkgMetadata,
    })) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});
