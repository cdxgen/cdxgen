import { join } from "node:path";
import process from "node:process";

import esmock from "esmock";
import { assert, it } from "poku";
import sinon from "sinon";

import {
  buildCargoCacheComponent,
  enrichCargoCacheComponent,
} from "../cli/nativeBom.js";
import { resetCargoCacheState } from "./cargoCache.js";

// A crate whose manifest states its licence only through `license-file` is
// described from that file, and a crate present only as a `.crate` archive in
// the registry cache is read from the archive, without extracting it; neither
// goes to crates.io. The assertions are on the exact requests a stubbed agent
// records. The fixtures hold a real extracted manifest with a licence file and
// a real .crate archive from the crates.io registry cache.

const FIXTURE = join(import.meta.dirname, "../../test/data/cargo-local-first");
const CRATE_FILE = join(
  FIXTURE,
  "registry/cache/index.crates.io-1949cf8c6b5b557f/rustls-webpki-0.103.13.crate",
);

it("local crates answer from their licence files and archives", async () => {
  const previousFetchLicense = process.env.FETCH_LICENSE;
  const previousCargoHome = process.env.CARGO_HOME;
  const previousCratesUrl = process.env.RUST_CRATES_URL;
  const previousRsDisable = process.env.CDXGEN_RS_DISABLE;
  process.env.FETCH_LICENSE = "true";
  process.env.CDXGEN_RS_DISABLE = "fetch";
  process.env.CARGO_HOME = FIXTURE;
  const requested = [];
  const agentGet = sinon.stub().callsFake(async (url) => {
    requested.push(url);
    return {
      statusCode: 200,
      body: {
        crate: { description: "remote crate", newest_version: "9.9.9" },
        versions: [
          { num: "1.0.0", license: "REMOTE-CRATE", id: 1, dl_path: "/dl" },
        ],
      },
    };
  });
  try {
    const { resetBatchFetchAvailability } = await import(
      "../inventory/fetchBatch.js"
    );
    resetBatchFetchAvailability();
    resetCargoCacheState();
    const { getCratesMetadata } = await esmock(
      "./ecosystems.js",
      {},
      {
        "../core/httpClient.js": {
          createHttpClient: sinon.stub().returns({ get: agentGet }),
        },
      },
    );

    process.env.RUST_CRATES_URL = "http://127.0.0.1:1/crates/";
    // The licence-file crate, the archive-only crate, and a crate the machine
    // does not hold at all.
    const ring = { group: "", name: "ring", version: "0.16.20" };
    const webpki = { group: "", name: "rustls-webpki", version: "0.103.13" };
    const serde = { group: "", name: "serde", version: "1.0.0" };
    const result = await getCratesMetadata([ring, webpki, serde]);
    assert.deepStrictEqual(requested, ["http://127.0.0.1:1/crates/serde"]);
    const byName = new Map(result.map((p) => [p.name, p]));
    // ring states its licence only through `license-file`; the notice itself
    // describes it.
    assert.strictEqual(byName.get("ring").license, undefined);
    assert.ok(
      byName
        .get("ring")
        .licenses?.some(
          (alicense) =>
            alicense.license?.name === "CUSTOM" &&
            alicense.license?.text?.content?.includes("*ring*"),
        ),
    );
    // The archive-only crate is described from its own manifest.
    assert.strictEqual(byName.get("rustls-webpki").license, "ISC");
    assert.strictEqual(
      byName.get("rustls-webpki").description,
      "Web PKI X.509 Certificate Verification.",
    );
    // The crate nothing local holds was enriched by the registry.
    assert.strictEqual(byName.get("serde").license, "REMOTE-CRATE");

    // A .crate archive the scan itself walks over is read the same way, so it
    // is not sent to crates.io either.
    const component = buildCargoCacheComponent(CRATE_FILE);
    assert.ok(
      component,
      "the fixture archive must parse as name-version.crate",
    );
    await enrichCargoCacheComponent(CRATE_FILE, component);
    assert.strictEqual(component.license, "ISC");
    requested.length = 0;
    await getCratesMetadata([component]);
    assert.deepStrictEqual(requested, []);
  } finally {
    resetCargoCacheState();
    for (const [name, value] of Object.entries({
      FETCH_LICENSE: previousFetchLicense,
      CARGO_HOME: previousCargoHome,
      RUST_CRATES_URL: previousCratesUrl,
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
