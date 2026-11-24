/**
 * Cassette-backed metadata function tests.
 *
 * Exercises the seven get*Metadata functions through the cassette replay
 * layer — every HTTP request is served from a committed cassette file, and
 * any unmatched request throws CassetteMissError.  These tests pass with
 * outbound network **blocked**, proving the cassette layer is the real
 * single network seam.
 *
 * Run:  node contrib/cassette-metadata-tests.js
 * Run with network blocked:
 *   CDXGEN_NO_CACHE=1 node contrib/cassette-metadata-tests.js
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { startReplay, CassetteMissError } from "./cassette.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const CASSETTES_DIR = path.join(REPO_ROOT, "test", "repotests", "_cassettes");

// The cassettes were recorded against Maven Central, so the requests must not
// be moved to a mirror.
delete process.env.MAVEN_CENTRAL_MIRROR;

let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => {
      passed++;
      console.log(`  [PASS] ${name}`);
    })
    .catch((err) => {
      failed++;
      console.error(`  [FAIL] ${name}`);
      console.error(`         ${err.message}`);
    });
}

/**
 * Run a function with a cassette in replay mode, then stop.
 * The cassette is the only source of HTTP responses — if the function
 * makes a request not in the cassette, CassetteMissError is thrown.
 */
async function withCassette(cassetteName, fn) {
  const cassettePath = path.join(CASSETTES_DIR, cassetteName);
  const controller = startReplay(cassettePath);
  try {
    const result = await fn(controller);
    // Enforce, rather than assume, that the cassette did the work. Several of
    // these functions resolve metadata from a local source before reaching the
    // network — getMvnMetadata reads ~/.m2 and ~/.gradle first — and all of
    // them swallow request errors internally. Without these two assertions a
    // test stays green while the cassette goes completely unused, which is how
    // the whole layer rots into decoration.
    assert.ok(
      controller.hitCount > 0,
      `${cassetteName}: zero cassette hits — the function resolved without the cassette (local cache?), so this test proves nothing`,
    );
    assert.equal(
      controller.missCount,
      0,
      `${cassetteName}: ${controller.missCount} cassette miss(es) — a request escaped toward the live network and the error was swallowed internally`,
    );
    return result;
  } finally {
    controller.stop();
  }
}

export async function main() {
  console.log("=== Cassette-backed metadata function tests ===\n");
  console.log("(All HTTP served from cassettes — outbound network blocked)\n");

  // Point every package cache at an empty directory before cdxgen is loaded.
  // getMvnMetadata answers from ~/.m2, the Gradle cache, and the Coursier
  // cache before it asks the network, so on a machine that has built a Java
  // project the cassette would go unused and the hit-count check would fail
  // for reasons that have nothing to do with the code. The golden runner
  // isolates the caches the same way.
  const scratchHome = mkdtempSync(path.join(tmpdir(), "cdxgen-cassette-home-"));
  for (const cacheVar of [
    "HOME",
    "USERPROFILE",
    "LOCALAPPDATA",
    "GRADLE_USER_HOME",
    "GRADLE_CACHE_DIR",
    "COURSIER_CACHE",
    "MAVEN_CACHE_DIR",
  ]) {
    process.env[cacheVar] = scratchHome;
  }
  process.on("exit", () => {
    rmSync(scratchHome, { recursive: true, force: true });
  });

  const utils = await import(
    path.join(REPO_ROOT, "lib", "ecosystems", "utils.js")
  );

  // Clear the in-memory metadata cache so each test starts fresh.
  // metadata_cache is a module-level Map inside utils.js.
  // We clear it by re-importing — but since ESM caches modules, we instead
  // rely on each test using distinct package names.

  await test("getNpmMetadata (cassette: metadata_npm.json)", async () => {
    const result = await withCassette("metadata_npm.json", async (ctrl) => {
      // Await before asserting. The count can only be meaningful once the
      // function has finished: any `await` before its first request — the
      // batched prefetch, for one — defers the request past this line, so
      // asserting on the in-flight count tests the implementation's internal
      // ordering rather than whether the cassette was used.
      const r = await utils.getNpmMetadata([
        { name: "left-pad", version: "1.3.0" },
      ]);
      assert.ok(ctrl.hitCount > 0, "cassette should have recorded hits");
      return r;
    });
    assert.ok(result.length > 0, "expected at least one result");
    const pkg = result[0];
    assert.ok(
      pkg.license || pkg.description,
      "npm metadata was not enriched (no license or description)",
    );
  });

  await test("getMvnMetadata (cassette: metadata_mvn.json)", async () => {
    const result = await withCassette("metadata_mvn.json", async () => {
      return utils.getMvnMetadata(
        [
          {
            group: "org.ow2.asm",
            name: "asm",
            version: "9.5",
            purl: "pkg:maven/org.ow2.asm/asm@9.5",
          },
        ],
        {},
        true,
      );
    });
    assert.ok(result.length > 0, "expected at least one result");
    const pkg = result[0];
    assert.ok(
      pkg.license || pkg.description,
      "maven metadata was not enriched (no license or description)",
    );
  });

  await test("getPyMetadata (cassette: metadata_py.json)", async () => {
    const result = await withCassette("metadata_py.json", async () => {
      return utils.getPyMetadata([{ name: "flask", version: "2.0.0" }], true);
    });
    assert.ok(result.length > 0, "expected at least one result");
    const pkg = result[0];
    assert.ok(
      pkg.author || pkg.license || pkg.description,
      "pypi metadata was not enriched (no author, license, or description)",
    );
  });

  await test("getCratesMetadata (cassette: metadata_crates.json)", async () => {
    const result = await withCassette("metadata_crates.json", async () => {
      return utils.getCratesMetadata([{ name: "serde", version: "1.0.193" }]);
    });
    assert.ok(result.length > 0, "expected at least one result");
    const pkg = result[0];
    assert.ok(
      pkg.description || pkg.license,
      "crates metadata was not enriched (no description or license)",
    );
    assert.ok(
      pkg.properties?.some((p) => p.name === "cdx:cargo:crate_id"),
      "crates metadata missing cdx:cargo:crate_id property",
    );
  });

  await test("getNugetMetadata (cassette: metadata_nuget.json)", async () => {
    const result = await withCassette("metadata_nuget.json", async () => {
      return utils.getNugetMetadata(
        [{ name: "Newtonsoft.Json", version: "13.0.3" }],
        [],
      );
    });
    // getNugetMetadata returns { pkgList, dependencies }
    const pkgList = result?.pkgList || result;
    assert.ok(
      Array.isArray(pkgList) && pkgList.length > 0,
      "nuget metadata should return a non-empty pkgList",
    );
  });

  await test("getRepoLicense (cassette: metadata_repolicense.json)", async () => {
    const result = await withCassette("metadata_repolicense.json", async () => {
      return utils.getRepoLicense("https://github.com/pallets/flask", undefined);
    });
    assert.ok(
      result && (result.id || result.name),
      `github license lookup returned no result: ${JSON.stringify(result)}`,
    );
  });

  await test("getGoPkgLicense (cassette: metadata_gopkglicense.json)", async () => {
    const result = await withCassette("metadata_gopkglicense.json", async () => {
      return utils.getGoPkgLicense({
        group: "",
        name: "github.com/gin-gonic/gin",
      });
    });
    assert.ok(
      Array.isArray(result) && result.length > 0,
      `go pkg license lookup returned no result: ${JSON.stringify(result)}`,
    );
  });

  // Negative test: a cassette miss is loud, not silent.
  await test("cassette miss throws CassetteMissError (not silent network)", async () => {
    // Use cdxgenAgent directly — the get*Metadata functions swallow errors
    // internally (catch and push unenriched package), so they would not
    // propagate CassetteMissError. A direct HTTP call proves the interceptor
    // blocks unmatched requests.
    await assert.rejects(
      () =>
        withCassette("metadata_npm.json", async () => {
          return utils.cdxgenAgent.get("https://registry.npmjs.org/nonexistent-pkg-xyz-test");
        }),
      (err) => {
        assert.ok(
          err instanceof CassetteMissError,
          `Expected CassetteMissError, got ${err.constructor.name}: ${err.message}`,
        );
        return true;
      },
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

// Auto-run when invoked directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
