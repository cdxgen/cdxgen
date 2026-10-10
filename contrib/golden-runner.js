/**
 * Golden SBOM test runner.
 *
 * Discovers scenarios under `test/repotests/`, runs `createBom` for each, installs
 * the cassette replay layer for offline coverage, normalizes the output, and
 * compares against committed golden files.
 *
 * Usage:
 *   pnpm run test:golden             # compare (fail on mismatch)
 *   UPDATE_GOLDEN=1 pnpm run test:golden  # regenerate + print summary
 *
 * Scenario manifest format (`test/repotests/<project>/golden.manifest.json`):
 *
 * ```json
 * {
 *   "description": "human-readable note",
 *   "fixture": ".",               // relative path to fixture dir (default ".")
 *   "scenarios": [
 *     {
 *       "name": "default",        // encodes the flags
 *       "projectType": ["npm"],   // cdxgen project type(s)
 *       "options": {},            // additional createBom options
 *       "network": false,         // needs a cassette (default false)
 *       "env": {},                // env vars set for the scenario only
 *       "registry": {             // serve a local registry double instead of a
 *         "fixture": "npm.json",  //   cassette; see test/repotests/_registries/
 *         "env": ["NPM_URL"]      //   env vars pointed at it (trailing slash
 *       }                         //   added for *_URL vars that need one)
 *     }
 *   ]
 * }
 * ```
 *
 * Golden files live at `test/repotests/<project>/expected/<scenario>.json`.
 * Cassettes live at `test/repotests/_cassettes/<project>_<scenario>.json`.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { normalizeBom, serializeBom } from "./sbom-normalize.js";
import { diffBoms } from "./sbom-diff.js";
import { startCassette, CassetteMissError } from "./cassette.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const REPOTESTS_DIR = path.join(REPO_ROOT, "test", "repotests");
const CASSETTES_DIR = path.join(REPOTESTS_DIR, "_cassettes");

// Pin CocoaPods full-scan off. The justification is determinism, not
// convenience: `pod spec` adds a `internal:SrcFile` property whose value is a local
// filesystem path, so a golden generated on a machine with CocoaPods installed
// would never match one generated without it. Pinning makes the lockfile the
// sole input.
//
// This is not hiding a crash. `buildObjectForCocoaPod` used to throw when `pod`
// was absent (`.stdout.trim()` on an empty spawn result); that is fixed at the
// source in lib/ecosystems/utils.js, and the scenario now scans cleanly with
// COCOA_FULL_SCAN=true on a machine with no `pod` binary.
process.env.COCOA_FULL_SCAN = process.env.COCOA_FULL_SCAN || "false";

// Neutralize every ambient package cache before cdxgen is loaded.
//
// Several enrichers read the developer's local caches and add data that is not
// derivable from the fixture: `findLocalMvnArtifact` hashes jars found in
// `~/.m2/repository` and the Gradle cache, and `enrichGemsFromLocalCache` globs
// `GEM_HOME/**/specifications/**/*.gemspec` for licenses and required-version
// properties. Whether that data appears depends on which artifacts happen to be
// on the machine, so goldens recorded on a warm cache can never match a cold CI
// runner — exactly the failure seen in run 30415853843, where maven-smoke and
// ruby-smoke carried hashes the runner could not reproduce.
//
// Pointing every cache at one empty scratch directory makes the fixture the sole
// input, so the same bytes come out on a warm laptop and a cold runner alike.
// `homedir()` is resolved from HOME on POSIX and USERPROFILE on Windows, so both
// are set. The cost is that hash/licence enrichment from local caches is not
// covered by the golden corpus; covering it would require vendoring real
// artifacts into a fixture, which is tracked separately.
const GOLDEN_SCRATCH_HOME = mkdtempSync(path.join(tmpdir(), "cdxgen-golden-home-"));
for (const cacheVar of [
  "HOME",
  "USERPROFILE",
  "GEM_HOME",
  "CDXGEN_GEM_HOME",
  "GEM_PATH",
  "BUNDLE_PATH",
  "GRADLE_USER_HOME",
  "GRADLE_CACHE_DIR",
  "MAVEN_CACHE_DIR",
  "COURSIER_CACHE",
  "XDG_CACHE_HOME",
  "GOMODCACHE",
  "GOPATH",
  "NUGET_PACKAGES",
  "CDXGEN_CACHE_DIR",
]) {
  process.env[cacheVar] = GOLDEN_SCRATCH_HOME;
}
// These name further local repositories (-Dmaven.repo.local, a settings file
// passed with -s, Gradle's shared read-only cache), so they are unset rather
// than redirected.
for (const repoVar of [
  "MVN_ARGS",
  "MAVEN_ARGS",
  "MAVEN_OPTS",
  "GRADLE_RO_DEP_CACHE",
]) {
  delete process.env[repoVar];
}

/**
 * Dynamically import createBom lazily so the runner can report discovery
 * errors before loading the full cdxgen module graph.
 */
async function getCreateBom() {
  const mod = await import(path.join(REPO_ROOT, "lib", "cli", "index.js"));
  return mod.createBom;
}

/**
 * Discover all golden scenario manifests under test/repotests/.
 * @returns {{ project: string, manifestPath: string, manifest: Object }[]}
 */
export function discoverScenarios() {
  const found = [];
  if (!existsSync(REPOTESTS_DIR)) {
    return found;
  }
  for (const entry of readdirSync(REPOTESTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("_") || entry.name.startsWith(".")) {
      continue;
    }
    const manifestPath = path.join(
      REPOTESTS_DIR,
      entry.name,
      "golden.manifest.json",
    );
    if (!existsSync(manifestPath)) {
      continue;
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    found.push({ project: entry.name, manifestPath, manifest });
  }
  return found;
}

const REGISTRIES_DIR = path.join(REPOTESTS_DIR, "_registries");

/**
 * Start a local registry double serving a recorded set of responses.
 *
 * A cassette cannot cover a scenario that fetches through the `cdxrs` binary:
 * replay intercepts undici inside this process, and a subprocess does not
 * participate. Serving the same recorded bodies over a real socket on localhost
 * covers both paths with one fixture, which is what makes a `FETCH_LICENSE`
 * scenario meaningful under `test:rs-disable` — that comparison is the only
 * thing standing between a Rust fetch regression and a shipped SBOM.
 *
 * Unrouted paths answer 404. That is deliberate and deterministic: an enricher
 * asking for something the fixture does not describe must produce the same
 * (absent) result on every machine.
 *
 * @param {string} fixtureName File under test/repotests/_registries/.
 * @returns {Promise<{url: string, requests: string[], stop: () => Promise<void>}>}
 */
async function startRegistryDouble(fixtureName) {
  const fixturePath = path.join(REGISTRIES_DIR, fixtureName);
  if (!existsSync(fixturePath)) {
    throw new Error(`registry fixture not found: ${fixturePath}`);
  }
  const routes = JSON.parse(readFileSync(fixturePath, "utf-8"));
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    const body = routes[req.url];
    if (body === undefined) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * Apply env vars, returning a restore function.
 *
 * @param {Object} env Map of variable to value; `undefined` deletes.
 * @returns {() => void} Restores the previous values.
 */
function applyEnv(env) {
  const previous = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

/** Registry env vars that must carry a trailing slash. */
const TRAILING_SLASH_VARS = new Set(["NPM_URL", "RUST_CRATES_URL", "PYPI_URL"]);

/**
 * Registry env vars whose API lives under a fixed path prefix, so pointing
 * them at a registry double means appending that prefix to the socket URL.
 * The ruby ones override the whole endpoint base, API path included.
 */
const ENV_VAR_PATH_SUFFIXES = {
  RUBYGEMS_V2_URL: "/api/v2/rubygems/",
  RUBYGEMS_V1_URL: "/api/v1/gems/",
  RUBYGEMS_V1_VERSIONS_URL: "/api/v1/versions/",
};

/**
 * Run a single scenario and return the normalized BOM.
 *
 * @param {string} project Project directory name.
 * @param {Object} scenario Scenario definition from the manifest.
 * @param {Object} manifest Full manifest object.
 * @returns {Promise<{ normalized: Object, cassetteHits: number, cassetteMisses: number }>}
 */
export async function runScenario(project, scenario, manifest) {
  const createBom = await getCreateBom();
  const fixtureRel = manifest.fixture || ".";
  const fixtureDir = path.join(REPOTESTS_DIR, project, fixtureRel);

  const cassetteName = scenario.cassette || `${project}_${scenario.name}.json`;
  const cassettePath = path.join(CASSETTES_DIR, cassetteName);
  const useCassette = scenario.network === true;

  // In record mode (UPDATE_GOLDEN=1 with a network scenario), use record.
  // Otherwise replay.
  const recordMode =
    process.env.UPDATE_GOLDEN === "1" &&
    useCassette &&
    process.env.CDXGEN_CASSETTE_MODE !== "replay";

  let cassetteController = null;
  let cassetteHits = 0;
  let cassetteMisses = 0;

  // A scenario may declare a local registry double and/or extra env vars. Both
  // are torn down in the `finally` below so one scenario cannot leak its
  // configuration into the next.
  let registry = null;
  const scenarioEnv = { ...(scenario.env || {}) };
  if (scenario.registry) {
    registry = await startRegistryDouble(scenario.registry.fixture);
    for (const key of scenario.registry.env || []) {
      scenarioEnv[key] = ENV_VAR_PATH_SUFFIXES[key]
        ? `${registry.url}${ENV_VAR_PATH_SUFFIXES[key]}`
        : TRAILING_SLASH_VARS.has(key)
          ? `${registry.url}/`
          : registry.url;
    }
  }
  const restoreEnv = applyEnv(scenarioEnv);

  if (useCassette) {
    const mode = recordMode ? "record" : "replay";
    cassetteController = startCassette(mode, cassettePath);
  }

  try {
    const options = {
      projectType: scenario.projectType || [],
      multiProject: false,
      installDeps: false,
      outputFormat: "json",
      specVersion: "1.7",
      ...scenario.options,
    };

    const result = await createBom(fixtureDir, options);
    const bom = result?.bomJson || result;
    if (!bom || typeof bom !== "object") {
      throw new Error(`createBom returned no BOM object for ${project}/${scenario.name}`);
    }

    const normalized = normalizeBom(bom, {
      projectRoot: fixtureDir,
    });

    cassetteHits = cassetteController?.hitCount || 0;
    cassetteMisses = cassetteController?.missCount || 0;

    // In record mode, stop flushes the cassette.
    if (cassetteController) {
      cassetteController.stop();
    }

    // When a registry-double scenario runs with the Rust fetch path enabled and
    // available, that path must actually have been used. Without this check a
    // silent fallback to the JS agent would make `test:rs-disable` compare the
    // JS path with itself and report "identical" — which is precisely how an
    // earlier Rust fetch implementation shipped with an invalid-CycloneDX bug
    // behind a green 27/27.
    if (registry) {
      const { batchFetchAvailable, lastBatchStats } = await import(
        path.join(REPO_ROOT, "lib", "inventory", "fetchBatch.js")
      );
      const disabled = (process.env.CDXGEN_RS_DISABLE || "")
        .split(",")
        .map((s) => s.trim())
        .some((s) => s === "all" || s === "fetch");
      if (!disabled && !batchFetchAvailable() && process.env.CDXGEN_REQUIRE_CDXRS === "1") {
        throw new Error(
          `${project}/${scenario.name}: CDXGEN_REQUIRE_CDXRS=1 but cdxrs fetch is not available; ` +
            "the Rust path cannot be covered by this run",
        );
      }
      if (!disabled && batchFetchAvailable()) {
        const stats = lastBatchStats();
        if (!stats || !(stats.requests > 0)) {
          throw new Error(
            `${project}/${scenario.name}: cdxrs fetch is available but no batch ran ` +
              `(stats: ${JSON.stringify(stats)}); the Rust path was not exercised`,
          );
        }
      }
    }
    if (registry && registry.requests.length === 0 && scenario.registry?.expectRequests !== false) {
      // A registry double that was never asked for anything means the scenario
      // is not exercising the enrichment it claims to; that would make the
      // whole comparison vacuous.
      throw new Error(
        `${project}/${scenario.name}: the registry double received no requests`,
      );
    }
    return { normalized, cassetteHits, cassetteMisses };
  } finally {
    restoreEnv();
    if (registry) {
      await registry.stop();
    }
    if (cassetteController) {
      // Ensure stop is called even on error (stop is idempotent — it just
      // clears the interceptor).
      try {
        cassetteController.stop();
      } catch {
        // already stopped
      }
    }
  }
}

/**
 * Get the expected golden file path for a scenario.
 */
export function goldenFilePath(project, scenarioName) {
  return path.join(REPOTESTS_DIR, project, "expected", `${scenarioName}.json`);
}

/**
 * Read a golden file. Returns null if it doesn't exist yet.
 */
export function readGolden(project, scenarioName) {
  const p = goldenFilePath(project, scenarioName);
  if (!existsSync(p)) {
    return null;
  }
  return JSON.parse(readFileSync(p, "utf-8"));
}

/**
 * Write a golden file (creating the directory if needed).
 */
export function writeGolden(project, scenarioName, normalized) {
  const p = goldenFilePath(project, scenarioName);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, serializeBom(normalized));
}

/**
 * Run all golden scenarios and report results.
 *
 * @returns {Promise<{ passed: number, failed: number, updated: number, total: number, results: Object[] }>}
 */
export async function runAll() {
  const updateMode = process.env.UPDATE_GOLDEN === "1";
  const scenarios = discoverScenarios();

  if (scenarios.length === 0) {
    console.error("FATAL: no golden scenarios found under test/repotests/. The runner must find non-zero scenarios.");
    return {
      passed: 0,
      failed: 1,
      updated: 0,
      total: 0,
      results: [],
    };
  }

  const createBom = await getCreateBom();
  let total = 0;
  let passed = 0;
  let failed = 0;
  let updated = 0;
  const results = [];

  for (const { project, manifest } of scenarios) {
    for (const scenario of manifest.scenarios || []) {
      total++;
      const label = `${project}/${scenario.name}`;
      const result = {
        project,
        scenario: scenario.name,
        label,
        status: "pending",
        summary: "",
        details: [],
      };

      try {
        const { normalized, cassetteHits, cassetteMisses } = await runScenario(
          project,
          scenario,
          manifest,
        );

        if (updateMode) {
          const existing = readGolden(project, scenario.name);
          if (existing) {
            const { summary, details } = diffBoms(normalized, existing);
            result.summary = summary;
            result.details = details;
          }
          writeGolden(project, scenario.name, normalized);
          updated++;
          result.status = "updated";
          if (cassetteHits > 0) {
            result.details.push(`cassette: ${cassetteHits} hits`);
          }
        } else {
          const expected = readGolden(project, scenario.name);
          if (!expected) {
            result.status = "fail";
            result.summary = `no golden file at expected/${scenario.name}.json (run UPDATE_GOLDEN=1 pnpm run test:golden)`;
            failed++;
          } else {
            const { isEqual, summary, details } = diffBoms(normalized, expected);
            if (isEqual) {
              passed++;
              result.status = "pass";
              result.summary = "identical";
              if (cassetteHits > 0) {
                result.details.push(`cassette: ${cassetteHits} hits`);
              }
            } else {
              failed++;
              result.status = "fail";
              result.summary = summary;
              result.details = details;
              if (cassetteHits > 0) {
                result.details.push(`cassette: ${cassetteHits} hits`);
              }
            }
          }
        }
      } catch (err) {
        failed++;
        result.status = "error";
        result.summary = err instanceof CassetteMissError ? err.message : err.message;
        if (err.stack && process.env.CDXGEN_DEBUG_MODE) {
          result.details.push(err.stack);
        }
      }

      results.push(result);
    }
  }

  return { passed, failed, updated, total, results };
}

/**
 * Main entry point for the CLI: `node contrib/golden-runner.js`
 */
export async function main() {
  console.log("=== Golden SBOM test runner ===\n");

  const { passed, failed, updated, total, results } = await runAll();

  for (const r of results) {
    const icon =
      r.status === "pass" ? "PASS" : r.status === "updated" ? "UPD" : r.status === "fail" ? "FAIL" : "ERR";
    console.log(`[${icon}] ${r.label}: ${r.summary}`);
    if (r.details.length > 0 && r.status !== "pass") {
      for (const d of r.details) {
        console.log(`        ${d}`);
      }
    }
  }

  console.log(
    `\n${passed} passed, ${failed} failed, ${updated} updated, ${total} total`,
  );

  if (updated > 0) {
    console.log("\n=== Regeneration summary ===");
    for (const r of results.filter((r) => r.status === "updated")) {
      console.log(`  ${r.label}: ${r.summary}`);
      for (const d of r.details) {
        console.log(`    ${d}`);
      }
    }
  }

  process.exit(failed > 0 ? 1 : 0);
}

// Run main() only when invoked directly, not when imported.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
