import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import esmock from "esmock";
import { assert, it } from "poku";

// The registries a deno.lock parse asks about its npm packages, with the real
// getNpmMetadata deciding who is asked where. The assertions are on the exact
// requests a stubbed gate records. The environment it changes is process-wide,
// so the cases run one after the other inside a single it.

const DENO_LOCK = {
  version: "5",
  specifiers: {
    "npm:chalk@^5.3.0": "5.6.2",
    "npm:@acme/private@1": "1.0.0",
    "npm:@other/lib@1": "1.0.0",
  },
  npm: {
    "chalk@5.6.2": { integrity: "sha512-AAAA" },
    "@acme/private@1.0.0": { integrity: "sha512-BBBB" },
    "@other/lib@1.0.0": { integrity: "sha512-CCCC" },
  },
};

async function requestsFor(project, isSecureMode) {
  const requested = [];
  const { parseDenoLock } = await esmock(
    "./denoutils.js",
    {},
    {
      "../core/activity.js": { isSecureMode },
      "../inventory/fetchBatch.js": {
        prefetchEnabled: () => false,
        gatedGet: async (url) => {
          requested.push(url);
          return { body: { license: "MIT" } };
        },
      },
    },
  );
  await parseDenoLock(join(project, "deno.lock"), { projectRoot: project });
  return requested.sort();
}

await it("a registry .npmrc names is not asked about deno.lock packages in secure mode", async () => {
  const names = [
    "FETCH_LICENSE",
    "CDXGEN_FETCH_PKG_METADATA",
    "NPM_URL",
    "DENO_DIR",
  ];
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  const project = mkdtempSync(join(tmpdir(), "cdxgen-deno-npmrc-"));
  try {
    for (const name of names) {
      delete process.env[name];
    }
    process.env.FETCH_LICENSE = "true";
    process.env.NPM_URL = "https://npm.operator.invalid/";
    process.env.DENO_DIR = join(project, "deno-cache");
    writeFileSync(join(project, "deno.lock"), JSON.stringify(DENO_LOCK));

    // Without .npmrc the registry the operator configured is the one asked.
    assert.deepStrictEqual(await requestsFor(project, false), [
      "https://npm.operator.invalid/@acme/private",
      "https://npm.operator.invalid/@other/lib",
      "https://npm.operator.invalid/chalk",
    ]);

    writeFileSync(
      join(project, ".npmrc"),
      "registry=https://npm.project.invalid/\n@acme:registry=https://npm.acme.invalid/\n",
    );
    assert.deepStrictEqual(await requestsFor(project, false), [
      "https://npm.acme.invalid/@acme/private",
      "https://npm.project.invalid/@other/lib",
      "https://npm.project.invalid/chalk",
    ]);

    // No host the project names is asked, and the scopes it serves from them
    // are not sent to the operator's registry either.
    assert.deepStrictEqual(await requestsFor(project, true), [
      "https://npm.operator.invalid/chalk",
    ]);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    rmSync(project, { force: true, recursive: true });
  }
});
