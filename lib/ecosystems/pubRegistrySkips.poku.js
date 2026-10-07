import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import esmock from "esmock";
import { assert, it } from "poku";
import sinon from "sinon";

// pub.dev enrichment of a pubspec.lock against a stubbed agent, so the
// assertions are about the exact requests made. The fixture holds two sdk
// packages, a path package, a git package and one hosted package that names
// its own registry; only the hosted one can be asked about, and only at the
// registry it names.

it("parsePubLockData asks the package's own registry and nothing else", async () => {
  const previousFetchLicense = process.env.FETCH_LICENSE;
  const previousPubDevUrl = process.env.PUB_DEV_URL;
  const previousRsDisable = process.env.CDXGEN_RS_DISABLE;
  process.env.FETCH_LICENSE = "true";
  process.env.CDXGEN_RS_DISABLE = "fetch";
  const requested = [];
  const agentGet = sinon.stub().callsFake(async (url) => {
    requested.push(url);
    if (url.endsWith("/score")) {
      return { statusCode: 200, body: { tags: ["license:mit"] } };
    }
    return { statusCode: 200, body: { pubspec: { description: "remote" } } };
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
    const { parsePubLockData } = await esmock(
      "./parsers-misc.js",
      {},
      httpClientMock,
    );
    const pubLock = join(
      import.meta.dirname,
      "../../test/data/registry-stub/dart/pubspec.lock",
    );
    const { pkgList } = await parsePubLockData(
      readFileSync(pubLock, "utf-8"),
      pubLock,
    );
    // The private hosted package is asked at the registry its lockfile names,
    // once, for the package document alone.
    assert.deepStrictEqual(requested, [
      "https://pub.acme.invalid/api/packages/privhosted/versions/3.0.0",
    ]);
    const byName = new Map(pkgList.map((p) => [p.name, p]));
    // The sdk, path and git packages keep the lockfile's answers.
    assert.strictEqual(byName.get("flutter").license, undefined);
    assert.strictEqual(byName.get("sky_engine").license, undefined);
    assert.strictEqual(byName.get("mypath").license, undefined);
    assert.strictEqual(byName.get("mygit").license, undefined);
    assert.strictEqual(byName.get("privhosted").description, "remote");

    // A hosted package with no recorded registry still goes to pub.dev, for
    // the package document and the score that names the licence.
    const { getDartMetadata } = await esmock(
      "./ecosystems.js",
      {},
      httpClientMock,
    );
    process.env.PUB_DEV_URL = "http://127.0.0.1:1/dart";
    const [intl] = await getDartMetadata([
      { name: "intl", version: "0.19.0", properties: [] },
    ]);
    assert.deepStrictEqual(requested, [
      "https://pub.acme.invalid/api/packages/privhosted/versions/3.0.0",
      "http://127.0.0.1:1/dart/api/packages/intl/versions/0.19.0",
      "http://127.0.0.1:1/dart/api/packages/intl/versions/0.19.0/score",
    ]);
    assert.strictEqual(intl.license, "MIT");
  } finally {
    for (const [name, value] of Object.entries({
      FETCH_LICENSE: previousFetchLicense,
      PUB_DEV_URL: previousPubDevUrl,
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
