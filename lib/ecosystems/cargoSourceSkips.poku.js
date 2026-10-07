import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import esmock from "esmock";
import { assert, it } from "poku";
import sinon from "sinon";

// crates.io enrichment of a Cargo.lock against a stubbed agent, so the
// assertions are about the exact requests made. The fixture holds the
// workspace's own crate, a path crate, a git crate, an alternate-registry
// crate and one crates.io crate; only the last can be asked about.

it("parseCargoData asks crates.io only for the crate it holds", async () => {
  const previousFetchLicense = process.env.FETCH_LICENSE;
  const previousCratesUrl = process.env.RUST_CRATES_URL;
  const previousCargoHome = process.env.CARGO_HOME;
  const previousRsDisable = process.env.CDXGEN_RS_DISABLE;
  process.env.FETCH_LICENSE = "true";
  process.env.CDXGEN_RS_DISABLE = "fetch";
  // An empty Cargo home, so the answer comes from the stub and not from
  // whatever this machine happens to have compiled.
  process.env.CARGO_HOME = mkdtempSync(join(tmpdir(), "cdxgen-cargo-"));
  const requested = [];
  const agentGet = sinon.stub().callsFake(async (url) => {
    requested.push(url);
    if (url.endsWith("/owners")) {
      return { statusCode: 200, body: { users: [] } };
    }
    return {
      statusCode: 200,
      body: {
        crate: { description: "remote crate", newest_version: "1.0.0" },
        versions: [
          {
            num: "1.0.0",
            license: "REMOTE-CRATE",
            id: 7,
            dl_path: "/api/v1/crates/serde/1.0.0/download",
          },
        ],
      },
    };
  });
  try {
    const { resetBatchFetchAvailability } = await import(
      "../inventory/fetchBatch.js"
    );
    const { resetCargoCacheState } = await import("./cargoCache.js");
    resetBatchFetchAvailability();
    resetCargoCacheState();
    const { parseCargoData } = await esmock(
      "./parsers-rust.js",
      {},
      {
        "../core/httpClient.js": {
          createHttpClient: sinon.stub().returns({ get: agentGet }),
        },
      },
    );
    process.env.RUST_CRATES_URL = "http://127.0.0.1:1/api/v1/crates/";
    const pkgList = await parseCargoData(
      join(import.meta.dirname, "../../test/data/registry-stub/Cargo.lock"),
    );
    assert.deepStrictEqual(requested, [
      "http://127.0.0.1:1/api/v1/crates/serde",
    ]);
    const byName = new Map(pkgList.map((p) => [p.name, p]));
    // The crates.io crate is enriched from the stub.
    assert.strictEqual(byName.get("serde").license, "REMOTE-CRATE");
    // The project itself, the path, git and alternate-registry crates keep
    // the lockfile's answers and were never asked about.
    assert.strictEqual(byName.get("myapp").license, undefined);
    assert.strictEqual(byName.get("mylocal").license, undefined);
    assert.strictEqual(byName.get("gitcrate").license, undefined);
    assert.strictEqual(byName.get("altcrate").license, undefined);
  } finally {
    for (const [name, value] of Object.entries({
      FETCH_LICENSE: previousFetchLicense,
      RUST_CRATES_URL: previousCratesUrl,
      CARGO_HOME: previousCargoHome,
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
