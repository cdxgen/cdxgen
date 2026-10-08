import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import esmock from "esmock";
import { assert, it } from "poku";

// The deno lock parse follows the shared metadata gate, so the provenance
// fetch --bom-audit turns on reaches jsr, and a jsr document is requested
// only for a component that still misses a field that document supplies.
// Whatever the installed-manifest mining filled is never asked for again,
// and when provenance is wanted both documents are still requested. The
// assertions are on the exact requests a stubbed agent records. The
// environment it changes is process-wide, so the cases run one after the
// other inside a single it.

const DENO_LOCK = {
  version: "5",
  specifiers: {
    "jsr:@filled/pkg@1": "1.0.0",
    "jsr:@bare/lib@1": "1.0.0",
  },
  jsr: {
    "@filled/pkg@1.0.0": {
      integrity: "a".repeat(64),
    },
    "@bare/lib@1.0.0": {
      integrity: "b".repeat(64),
    },
  },
};

// The installed manifest of @filled/pkg, as deno lays it out under
// node_modules for jsr packages. It names the licence, the description and
// the repository, so the mining round fills every field the jsr documents
// would supply.
const INSTALLED_MANIFEST = {
  name: "@jsr/filled__pkg",
  version: "1.0.0",
  license: "Apache-2.0",
  description: "Everything the manifest can say",
  repository: { type: "git", url: "git+https://github.com/acme/pkg.git" },
};

async function loadDenoModule(requested, getNpmMetadataCalls) {
  const fakeAgent = {
    get: async (url) => {
      requested.push(url);
      if (url.endsWith("/versions/1.0.0")) {
        return { body: { license: "MIT" } };
      }
      return {
        body: {
          description: "from the jsr package document",
          githubRepository: { owner: "acme", name: "lib" },
        },
      };
    },
  };
  return await esmock("./denoutils.js", {
    "../core/activity.js": { cdxgenAgent: fakeAgent },
    "../inventory/fetchBatch.js": {
      prefetchEnabled: () => false,
      gatedGet: (url, options) => fakeAgent.get(url, options),
    },
    "./ecosystems.js": {
      getNpmMetadata: async (pkgList) => {
        getNpmMetadataCalls.push(pkgList.length);
        return pkgList;
      },
    },
  });
}

await it("jsr documents are requested through the shared gate, only for missing fields", async () => {
  const names = [
    "FETCH_LICENSE",
    "GO_FETCH_VCS",
    "CDXGEN_FETCH_PKG_METADATA",
    "DENO_DIR",
  ];
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  const root = mkdtempSync(join(tmpdir(), "cdxgen-deno-jsr-"));
  try {
    const project = join(root, "project");
    mkdirSync(project);
    writeFileSync(join(project, "deno.lock"), JSON.stringify(DENO_LOCK));
    const jsrPkgDir = join(project, "node_modules", "@jsr", "filled__pkg");
    mkdirSync(jsrPkgDir, { recursive: true });
    writeFileSync(
      join(jsrPkgDir, "package.json"),
      JSON.stringify(INSTALLED_MANIFEST),
    );
    mkdirSync(join(root, "deno-cache"), { recursive: true });

    // The registry documents are asked for only what the installed manifest
    // left open.
    for (const name of names) {
      delete process.env[name];
    }
    process.env.DENO_DIR = join(root, "deno-cache");
    process.env.FETCH_LICENSE = "true";
    {
      const requested = [];
      const getNpmMetadataCalls = [];
      const mod = await loadDenoModule(requested, getNpmMetadataCalls);
      const { pkgList } = await mod.parseDenoLock(join(project, "deno.lock"), {
        projectRoot: project,
      });
      // The gate is open: jsr's npm-mirror group (both packages) went
      // through one lookup round, and only the package the manifest mining
      // could not answer is asked for its documents.
      assert.deepStrictEqual(getNpmMetadataCalls, [2]);
      assert.deepStrictEqual(requested.sort(), [
        "https://api.jsr.io/scopes/bare/packages/lib",
        "https://api.jsr.io/scopes/bare/packages/lib/versions/1.0.0",
      ]);
      const byName = new Map(pkgList.map((p) => [p.name, p]));
      // The mined manifest's fields survive; the bare package took the
      // registry's answers.
      assert.strictEqual(byName.get("filled__pkg")?.license, "Apache-2.0");
      assert.strictEqual(
        byName.get("filled__pkg")?.description,
        "Everything the manifest can say",
      );
      assert.strictEqual(byName.get("bare__lib")?.license, "MIT");
      assert.strictEqual(
        byName.get("bare__lib")?.description,
        "from the jsr package document",
      );
    }

    // With registry provenance wanted, as under --bom-audit, both documents
    // are requested even for the package the local data already describes,
    // and its own fields survive the round.
    delete process.env.FETCH_LICENSE;
    process.env.CDXGEN_FETCH_PKG_METADATA = "true";
    {
      const requested = [];
      const getNpmMetadataCalls = [];
      const mod = await loadDenoModule(requested, getNpmMetadataCalls);
      const { pkgList } = await mod.parseDenoLock(join(project, "deno.lock"), {
        projectRoot: project,
      });
      assert.ok(
        getNpmMetadataCalls.length >= 1,
        "the shared gate did not reach the registry",
      );
      assert.deepStrictEqual(requested.sort(), [
        "https://api.jsr.io/scopes/bare/packages/lib",
        "https://api.jsr.io/scopes/bare/packages/lib/versions/1.0.0",
        "https://api.jsr.io/scopes/filled/packages/pkg",
        "https://api.jsr.io/scopes/filled/packages/pkg/versions/1.0.0",
      ]);
      const filled = pkgList.find((p) => p.name === "filled__pkg");
      assert.strictEqual(filled?.license, "Apache-2.0");
      assert.strictEqual(
        filled?.description,
        "Everything the manifest can say",
      );
    }
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    rmSync(root, { force: true, recursive: true });
  }
});
