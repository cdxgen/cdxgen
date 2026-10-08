import { join } from "node:path";
import process from "node:process";

import esmock from "esmock";
import { assert, it } from "poku";

// The bun lock parse follows the shared metadata gate, so the provenance
// fetch --bom-audit turns on reaches the npm registry round; with no gate
// open, nothing is requested. The assertions are on the calls a stubbed
// registry round records and on the parsed components. The environment it
// changes is process-wide, so the cases run one after the other inside a
// single it.

const FIXTURE = join(import.meta.dirname, "../../test/data/bun/bun.lock");

async function loadBunModule(getNpmMetadataCalls) {
  return await esmock("./bunutils.js", {
    "./ecosystems.js": {
      getNpmMetadata: async (pkgList) => {
        getNpmMetadataCalls.push(pkgList.length);
        return pkgList;
      },
    },
  });
}

await it("the bun lock enrichment follows the shared metadata gate", async () => {
  const names = ["FETCH_LICENSE", "GO_FETCH_VCS", "CDXGEN_FETCH_PKG_METADATA"];
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  try {
    // With registry provenance wanted, as under --bom-audit, the registry
    // round runs although neither licence nor VCS fetching is on.
    for (const name of names) {
      delete process.env[name];
    }
    process.env.CDXGEN_FETCH_PKG_METADATA = "true";
    {
      const calls = [];
      const mod = await loadBunModule(calls);
      const { pkgList } = await mod.parseBunLock(FIXTURE);
      assert.deepStrictEqual(calls, [13]);
      assert.ok(pkgList.length === 13, "the lockfile still parsed");
    }
    // With no gate open, the registry round never runs.
    delete process.env.CDXGEN_FETCH_PKG_METADATA;
    {
      const calls = [];
      const mod = await loadBunModule(calls);
      const { pkgList } = await mod.parseBunLock(FIXTURE);
      assert.deepStrictEqual(calls, []);
      assert.ok(pkgList.length === 13, "the lockfile still parsed");
    }
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});
