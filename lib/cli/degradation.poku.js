/**
 * Tests for the ecosystem degradation instrumentation: the remediation-id
 * catalog contract and the end-to-end emission of degradation events on real
 * CLI runs over degraded environments.
 *
 * The catalog test is pure source analysis and runs everywhere. The CLI
 * fixture tests spawn `node bin/cdxgen.js` as a subprocess, so they need the
 * node CLI.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assert, describe, it } from "poku";

import {
  LEDGER_EVENT_IMPACTS,
  LEDGER_EVENT_KINDS,
} from "../core/buildLedger.js";

const repoRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const catalogPath = path.join(repoRoot, "data", "remediations.json");
const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf-8"));

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "cdxgen-degradation-"));
process.on("exit", () => {
  fs.rmSync(testDir, { force: true, recursive: true });
});

/**
 * Collect the remediation ids referenced by the producers. Producers either
 * call `recordDegradation("…")` or set `remediationId: "…"` on a direct
 * recordLedgerEvent call; both forms use a quoted id literal.
 *
 * @returns {Set<string>} Referenced remediation ids.
 */
function referencedRemediationIds() {
  const referenced = new Set();
  const firstArgument =
    // Mixed case is matched too, so an id the catalog format rejects is
    // reported as missing instead of silently skipped.
    /record(?:Degradation|PolicyDegradationOnce)\(\s*["']([A-Za-z0-9._-]+)["']/g;
  const quotedLiteral = /["']([a-z0-9.-]+)["']/g;
  // reportProjectToolingSkipped takes the id as its second argument, which the
  // formatter usually puts on a line of its own.
  const toolingSkip =
    /reportProjectToolingSkipped\(\s*[A-Za-z_.]+\s*,\s*["']([A-Za-z0-9._-]+)["']/g;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
      } else if (
        entry.name.endsWith(".js") &&
        !entry.name.endsWith(".poku.js")
      ) {
        const content = fs.readFileSync(entryPath, "utf-8");
        for (const match of content.matchAll(toolingSkip)) {
          referenced.add(match[1]);
        }
        for (const line of content.split("\n")) {
          for (const match of line.matchAll(firstArgument)) {
            referenced.add(match[1]);
          }
          // The remediationId field also accepts a ternary of two ids, so
          // every quoted literal on a remediationId assignment line is
          // collected. Lines that merely read event.remediationId carry no
          // producer ids.
          if (/remediationId\s*[:=]/.test(line)) {
            for (const match of line.matchAll(quotedLiteral)) {
              referenced.add(match[1]);
            }
          }
        }
      }
    }
  };
  walk(path.join(repoRoot, "lib"));
  return referenced;
}

describe("remediation catalog", () => {
  it("carries the required fields with known vocabulary", () => {
    const knownKinds = new Set(Object.values(LEDGER_EVENT_KINDS));
    const knownImpacts = new Set(Object.values(LEDGER_EVENT_IMPACTS));
    assert.ok(Object.keys(catalog).length > 0, "catalog must not be empty");
    for (const [id, entry] of Object.entries(catalog)) {
      assert.match(
        id,
        /^[a-z0-9]+(\.[a-z0-9-]+)+$/,
        `id ${id} must be dot-separated lowercase tokens`,
      );
      assert.ok(
        typeof entry.ecosystem === "string" && entry.ecosystem.length > 0,
        `${id} must declare an ecosystem`,
      );
      assert.ok(
        knownKinds.has(entry.kind),
        `${id} declares unknown kind ${entry.kind}`,
      );
      assert.ok(
        knownImpacts.has(entry.impact),
        `${id} declares unknown impact ${entry.impact}`,
      );
      assert.ok(
        typeof entry.title === "string" && entry.title.length > 0,
        `${id} must declare a title`,
      );
    }
  });

  it("matches the set of ids referenced by producers exactly", () => {
    const referenced = referencedRemediationIds();
    const catalogIds = new Set(Object.keys(catalog));
    for (const id of referenced) {
      assert.ok(
        catalogIds.has(id),
        `id ${id} is referenced in lib/ but missing from data/remediations.json`,
      );
    }
    for (const id of catalogIds) {
      assert.ok(
        referenced.has(id),
        `catalog id ${id} is not referenced by any producer in lib/`,
      );
    }
  });
});

describe("recordDegradation", () => {
  it("resolves the kind from the catalog and requires the id to exist", () => {
    const probePath = path.join(testDir, "record-degradation-probe.mjs");
    const buildLedgerHref = pathToFileURL(
      path.join(repoRoot, "lib", "core", "buildLedger.js"),
    ).href;
    fs.writeFileSync(
      probePath,
      `import process from "node:process";
       process.env.CDXGEN_INTROSPECT_LEDGER = process.env.PROBE_LEDGER_PATH;
       const { closeLedger, recordDegradation } = await import(
         "${buildLedgerHref}"
       );
       const known = recordDegradation("jvm.maven.manifest-fallback", {
         ecosystem: "java",
         tool: "maven",
         impact: "transitive-deps",
         detail: "probe known id",
       });
       const overridden = recordDegradation("jvm.sbt.project-discovery", {
         ecosystem: "java",
         tool: "sbt",
         kind: "command.failed",
         impact: "components",
         detail: "probe override",
       });
       const unknown = recordDegradation("not.in.catalog", {
         ecosystem: "java",
         impact: "none",
       });
       const noEcosystem = recordDegradation("js.no-lockfile", {
         impact: "versions",
       });
       console.log(
         JSON.stringify({
           known: known && { kind: known.kind, remediationId: known.remediationId },
           overridden: overridden && overridden.kind,
           unknown,
           noEcosystem,
         }),
       );
       closeLedger();`,
    );
    const ledgerPath = path.join(testDir, "probe-ledger.jsonl");
    const stdout = execFileSync(process.execPath, [probePath], {
      env: {
        ...process.env,
        PROBE_LEDGER_PATH: ledgerPath,
        CDXGEN_INTROSPECT: "",
        CDXGEN_INTROSPECT_LEDGER: "",
      },
    }).toString();
    const result = JSON.parse(stdout.trim().split("\n").pop());
    assert.deepStrictEqual(result.known, {
      kind: "fallback.engaged",
      remediationId: "jvm.maven.manifest-fallback",
    });
    assert.strictEqual(result.overridden, "command.failed");
    assert.strictEqual(result.unknown, undefined);
    assert.strictEqual(result.noEcosystem, undefined);
    const sidecarLines = fs
      .readFileSync(ledgerPath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.strictEqual(sidecarLines.length, 2);
    assert.strictEqual(
      sidecarLines[0].remediationId,
      "jvm.maven.manifest-fallback",
    );
    assert.strictEqual(
      sidecarLines[1].remediationId,
      "jvm.sbt.project-discovery",
    );
  });
});

/**
 * Write a small single-pom maven project fixture.
 *
 * @param {string} dir Destination directory.
 * @returns {void}
 */
function writeMavenFixture(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "pom.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>d03-degradation-fixture</artifactId>
  <version>1.0.0</version>
  <packaging>jar</packaging>
  <dependencies>
    <dependency>
      <groupId>org.apache.commons</groupId>
      <artifactId>commons-lang3</artifactId>
      <version>3.14.0</version>
    </dependency>
  </dependencies>
</project>
`,
  );
}

/**
 * Write a small npm project fixture without a lockfile.
 *
 * @param {string} dir Destination directory.
 * @returns {void}
 */
function writeJsFixture(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    `${JSON.stringify({ name: "d03-degradation-fixture", version: "1.0.0" }, null, 2)}\n`,
  );
}

/**
 * Write a small go module fixture with a go.mod only.
 *
 * @param {string} dir Destination directory.
 * @returns {void}
 */
function writeGoFixture(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "go.mod"),
    // go 1.21 is the oldest release that switches toolchains. A higher go
    // line makes an older local go try to download a newer toolchain, which
    // fails offline or for a bare language version such as "1.24", and the
    // healthy-go test would then see the go.mod fallback.
    "module d03/degradation/fixture\n\ngo 1.21\n\nrequire (\n\tgithub.com/spf13/cobra v1.8.1\n)\n",
  );
}

/**
 * Write a small rust manifest fixture without a Cargo.lock.
 *
 * @param {string} dir Destination directory.
 * @returns {void}
 */
function writeRustFixture(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "Cargo.toml"),
    '[package]\nname = "d03-degradation-fixture"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nserde = "1.0"\n',
  );
}

/**
 * Write a small rust fixture with a lockfile, so the lockfile parse is the
 * path under test.
 *
 * @param {string} dir Destination directory.
 * @returns {void}
 */
function writeRustLockFixture(dir) {
  writeRustFixture(dir);
  fs.writeFileSync(
    path.join(dir, "Cargo.lock"),
    `# This file is automatically @generated by Cargo.
version = 3

[[package]]
name = "d03-degradation-fixture"
version = "0.1.0"
`,
  );
}

/**
 * Write a small dart fixture with a pubspec.yaml only.
 *
 * @param {string} dir Destination directory.
 * @returns {void}
 */
function writeDartFixture(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "pubspec.yaml"),
    "name: d03_degradation_fixture\nenvironment:\n  sdk: ^3.5.0\ndependencies:\n  path: ^1.9.0\n",
  );
}

/**
 * Write a small php fixture with a composer.json only.
 *
 * @param {string} dir Destination directory.
 * @returns {void}
 */
function writePhpFixture(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "composer.json"),
    `${JSON.stringify({ name: "d03/degradation-fixture", require: { "psr/log": "^3.0" } }, null, 2)}\n`,
  );
}

/**
 * Write an elixir fixture with a mix.exs only.
 *
 * @param {string} dir Destination directory.
 * @returns {void}
 */
function writeElixirFixture(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "mix.exs"),
    'defmodule D03DegradationFixture.MixProject do\n  use Mix.Project\n  def project, do: [app: :d03_degradation_fixture, version: "0.1.0", deps: deps()]\n  defp deps, do: [{:jason, "~> 1.4"}]\nend\n',
  );
}

/**
 * Write a haskell fixture with a cabal.project and no freeze file.
 *
 * @param {string} dir Destination directory.
 * @returns {void}
 */
function writeHaskellFixture(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "cabal.project"), "packages: .\n");
  fs.writeFileSync(
    path.join(dir, "d03.cabal"),
    "cabal-version: 2.4\nname: d03-degradation-fixture\nversion: 0.1.0\n",
  );
}

/**
 * Run the cdxgen CLI over a fixture and return the process result plus the
 * events collected in the ledger sidecar, when one was requested.
 *
 * @param {string} fixtureDir Project directory to scan.
 * @param {string} projectType Project type argument.
 * @param {Object} [opts] `env` additions, extra CLI arguments, whether the
 *   ledger is enabled, and whether the JSON introspection report is requested.
 * @returns {{stdout: string, stderr: string, status: number, events: object[], report: object|undefined}} CLI result, parsed sidecar events, and the parsed introspection report when one was written.
 */
function runCli(fixtureDir, projectType, opts = {}) {
  const sidecarPath = path.join(
    testDir,
    `sidecar-${path.basename(fixtureDir)}-${opts.tag ?? "run"}.jsonl`,
  );
  const env = {
    ...process.env,
    CDXGEN_INTROSPECT: "",
    CDXGEN_INTROSPECT_LEDGER: "",
    ...opts.env,
  };
  if (opts.enableLedger) {
    env.CDXGEN_INTROSPECT_LEDGER = sidecarPath;
  }
  const args = [
    path.join(repoRoot, "bin", "cdxgen.js"),
    "-t",
    projectType,
    // The default matches the other fixtures of this file; the maven
    // manifest-fallback case opts out because --no-install-deps now skips
    // mvn entirely and records jvm.maven.tooling-disabled instead.
    ...(opts.installDeps ? [] : ["--no-install-deps"]),
    ...(opts.introspect ? ["--introspect"] : []),
    ...(opts.extraArgs || []),
    "-o",
    path.join(
      testDir,
      `bom-${path.basename(fixtureDir)}-${opts.tag ?? "run"}.json`,
    ),
    "-q",
    fixtureDir,
  ];
  const result = spawnSync(process.execPath, args, {
    env,
    encoding: "utf-8",
  });
  let events = [];
  if (opts.enableLedger && fs.existsSync(sidecarPath)) {
    events = fs
      .readFileSync(sidecarPath, "utf-8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  }
  const reportPath = path.join(
    testDir,
    `bom-${path.basename(fixtureDir)}-${opts.tag ?? "run"}.json.introspection.json`,
  );
  const report =
    opts.introspect && fs.existsSync(reportPath)
      ? JSON.parse(fs.readFileSync(reportPath, "utf-8"))
      : undefined;
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status,
    events,
    report,
  };
}

describe("degradation events on real CLI runs", () => {
  it("records jvm.maven.manifest-fallback when maven is unavailable", () => {
    const fixtureDir = path.join(testDir, "maven-fixture");
    writeMavenFixture(fixtureDir);
    const enabled = runCli(fixtureDir, "java", {
      tag: "enabled",
      enableLedger: true,
      installDeps: true,
      env: { MVN_CMD: path.join("/", "cdxgen-nonexistent", "mvn") },
    });
    assert.strictEqual(enabled.status, 0, `CLI run failed: ${enabled.stderr}`);
    const remediationIds = enabled.events
      .map((event) => event.remediationId)
      .filter(Boolean);
    assert.ok(
      remediationIds.includes("jvm.maven.manifest-fallback"),
      `expected jvm.maven.manifest-fallback, got ${JSON.stringify(remediationIds)}`,
    );
    const fallbackEvent = enabled.events.find(
      (event) => event.remediationId === "jvm.maven.manifest-fallback",
    );
    assert.ok(
      fallbackEvent,
      `manifest-fallback event missing; events: ${JSON.stringify(enabled.events)}`,
    );
    assert.strictEqual(fallbackEvent.ecosystem, "java", "ecosystem");
    assert.strictEqual(fallbackEvent.kind, "fallback.engaged", "kind");
    assert.strictEqual(fallbackEvent.impact, "transitive-deps", "impact");
  });

  it("records jvm.maven.tooling-disabled instead when --no-install-deps skips mvn", () => {
    const fixtureDir = path.join(testDir, "maven-fixture-gated");
    writeMavenFixture(fixtureDir);
    const gated = runCli(fixtureDir, "java", {
      tag: "gated",
      enableLedger: true,
      env: { MVN_CMD: path.join("/", "cdxgen-nonexistent", "mvn") },
    });
    assert.strictEqual(gated.status, 0, `CLI run failed: ${gated.stderr}`);
    const remediationIds = gated.events
      .map((event) => event.remediationId)
      .filter(Boolean);
    assert.ok(
      remediationIds.includes("jvm.maven.tooling-disabled"),
      `expected jvm.maven.tooling-disabled, got ${JSON.stringify(remediationIds)}`,
    );
    assert.ok(
      !remediationIds.includes("jvm.maven.manifest-fallback"),
      "mvn must not have been attempted under --no-install-deps",
    );
  });

  it("records js.no-node-modules for lockfile-less js scans", () => {
    const fixtureDir = path.join(testDir, "js-fixture");
    writeJsFixture(fixtureDir);
    const enabled = runCli(fixtureDir, "js", {
      tag: "enabled",
      enableLedger: true,
    });
    assert.strictEqual(enabled.status, 0, `CLI run failed: ${enabled.stderr}`);
    const remediationIds = enabled.events
      .map((event) => event.remediationId)
      .filter(Boolean);
    assert.ok(
      remediationIds.includes("js.no-node-modules"),
      `expected js.no-node-modules, got ${JSON.stringify(remediationIds)}`,
    );
  });

  it("keeps stdout and stderr byte-identical when the ledger is enabled", () => {
    const mavenDir = path.join(testDir, "maven-fixture");
    writeMavenFixture(mavenDir);
    const mavenEnv = { MVN_CMD: path.join("/", "cdxgen-nonexistent", "mvn") };
    const mavenDisabled = runCli(mavenDir, "java", {
      tag: "byte-disabled",
      env: mavenEnv,
    });
    const mavenEnabled = runCli(mavenDir, "java", {
      tag: "byte-enabled",
      enableLedger: true,
      env: mavenEnv,
    });
    assert.strictEqual(mavenDisabled.stdout, mavenEnabled.stdout);
    assert.strictEqual(mavenDisabled.stderr, mavenEnabled.stderr);

    const jsDir = path.join(testDir, "js-fixture");
    writeJsFixture(jsDir);
    const jsDisabled = runCli(jsDir, "js", { tag: "byte-disabled" });
    const jsEnabled = runCli(jsDir, "js", {
      tag: "byte-enabled",
      enableLedger: true,
    });
    assert.strictEqual(jsDisabled.stdout, jsEnabled.stdout);
    assert.strictEqual(jsDisabled.stderr, jsEnabled.stderr);
  });
});

/**
 * The remediation ids of an introspection report's ranked list.
 *
 * @param {object|undefined} report Parsed introspection JSON report.
 * @returns {string[]} Ranked remediation ids.
 */
function rankedRemediationIds(report) {
  return (report?.remediation || [])
    .map((entry) => entry.remediationId)
    .filter(Boolean);
}

describe("catalog breadth degradations on real CLI runs", () => {
  it("ranks the go entries when the go toolchain is unavailable", () => {
    const fixtureDir = path.join(testDir, "go-fixture");
    writeGoFixture(fixtureDir);
    const enabled = runCli(fixtureDir, "go", {
      tag: "enabled",
      enableLedger: true,
      introspect: true,
      // A PATH with no directories removes the go executable while keeping
      // the CLI itself runnable, since it is spawned by absolute path.
      env: { PATH: path.join(testDir, "empty-path") },
    });
    assert.strictEqual(enabled.status, 0, `CLI run failed: ${enabled.stderr}`);
    const ranked = rankedRemediationIds(enabled.report);
    assert.ok(
      ranked.includes("go.toolchain.missing") &&
        ranked.includes("go.mod-only-fallback"),
      `expected both go entries ranked, got ${JSON.stringify(ranked)}`,
    );
    const goRow = enabled.report?.ecosystems?.find(
      (row) => row.ecosystem === "go",
    );
    assert.ok(goRow, "the report carries a go row");
    assert.strictEqual(goRow.tier, "manifest");
    assert.strictEqual(goRow.ceilingTier, "resolved");
  });

  it("records no go degradation when the go toolchain resolves the graph", () => {
    const probe = spawnSync("go", ["version"], { encoding: "utf-8" });
    if (probe.status !== 0) {
      // The negative needs the tool the healthy path drives; without it this
      // machine cannot answer the question, so register nothing.
      console.log("go is unavailable; skipping the healthy-go assertion");
      return;
    }
    const fixtureDir = path.join(testDir, "go-fixture");
    writeGoFixture(fixtureDir);
    const enabled = runCli(fixtureDir, "go", {
      tag: "healthy",
      enableLedger: true,
      introspect: true,
    });
    assert.strictEqual(enabled.status, 0, `CLI run failed: ${enabled.stderr}`);
    const ids = enabled.events
      .map((event) => event.remediationId)
      .filter(Boolean);
    assert.ok(
      !ids.includes("go.toolchain.missing") &&
        !ids.includes("go.mod-only-fallback"),
      `expected no go degradation with go on the PATH, got ${JSON.stringify(ids)}`,
    );
  });

  it("ranks rust.cargo-lock-missing for a manifest-only rust project", () => {
    const fixtureDir = path.join(testDir, "rust-lockless-fixture");
    writeRustFixture(fixtureDir);
    const enabled = runCli(fixtureDir, "rust", {
      tag: "enabled",
      enableLedger: true,
      introspect: true,
    });
    assert.strictEqual(enabled.status, 0, `CLI run failed: ${enabled.stderr}`);
    const ranked = rankedRemediationIds(enabled.report);
    assert.ok(
      ranked.includes("rust.cargo-lock-missing"),
      `expected rust.cargo-lock-missing ranked, got ${JSON.stringify(ranked)}`,
    );
    const rustRow = enabled.report?.ecosystems?.find(
      (row) => row.ecosystem === "rust",
    );
    assert.ok(rustRow, "the report carries a rust row");
    assert.strictEqual(rustRow.ceilingTier, "lockfile");
  });

  it("records no rust degradation when a Cargo.lock is parsed", () => {
    const fixtureDir = path.join(testDir, "rust-locked-fixture");
    writeRustLockFixture(fixtureDir);
    const enabled = runCli(fixtureDir, "rust", {
      tag: "enabled",
      enableLedger: true,
    });
    assert.strictEqual(enabled.status, 0, `CLI run failed: ${enabled.stderr}`);
    const ids = enabled.events
      .map((event) => event.remediationId)
      .filter(Boolean);
    assert.ok(
      !ids.includes("rust.cargo-lock-missing"),
      `expected no rust degradation for a locked project, got ${JSON.stringify(ids)}`,
    );
  });

  it("records rust.toolchain.missing when cargo cannot be executed", () => {
    const fixtureDir = path.join(testDir, "rust-deep-fixture");
    writeRustFixture(fixtureDir);
    // `cargo check` runs only when the project's tooling may, so installs
    // stay on for this case.
    const enabled = runCli(fixtureDir, "rust", {
      tag: "enabled",
      enableLedger: true,
      installDeps: true,
      extraArgs: ["--deep"],
      env: { CARGO_CMD: path.join("/", "cdxgen-nonexistent", "cargo") },
    });
    assert.strictEqual(enabled.status, 0, `CLI run failed: ${enabled.stderr}`);
    const ids = enabled.events
      .map((event) => event.remediationId)
      .filter(Boolean);
    assert.ok(
      ids.includes("rust.toolchain.missing"),
      `expected rust.toolchain.missing, got ${JSON.stringify(ids)}`,
    );
  });

  it("ranks dart.pub-get-needed for a pubspec.yaml-only project", () => {
    const fixtureDir = path.join(testDir, "dart-fixture");
    writeDartFixture(fixtureDir);
    const enabled = runCli(fixtureDir, "dart", {
      tag: "enabled",
      enableLedger: true,
      introspect: true,
    });
    assert.strictEqual(enabled.status, 0, `CLI run failed: ${enabled.stderr}`);
    const ranked = rankedRemediationIds(enabled.report);
    assert.ok(
      ranked.includes("dart.pub-get-needed"),
      `expected dart.pub-get-needed ranked, got ${JSON.stringify(ranked)}`,
    );
  });

  it("records the php degradations for a composer.json-only project", () => {
    const fixtureDir = path.join(testDir, "php-fixture");
    writePhpFixture(fixtureDir);
    const enabled = runCli(fixtureDir, "php", {
      tag: "enabled",
      enableLedger: true,
    });
    assert.strictEqual(enabled.status, 0, `CLI run failed: ${enabled.stderr}`);
    const ids = enabled.events
      .map((event) => event.remediationId)
      .filter(Boolean);
    assert.ok(
      ids.includes("php.no-lockfile"),
      `expected php.no-lockfile, got ${JSON.stringify(ids)}`,
    );
  });

  it("records php.composer.missing when composer cannot be executed", () => {
    const fixtureDir = path.join(testDir, "php-fixture");
    writePhpFixture(fixtureDir);
    const enabled = runCli(fixtureDir, "php", {
      tag: "enabled",
      enableLedger: true,
      // install-deps is the default, so the composer probes run and fail.
      extraArgs: ["--install-deps"],
      env: { PATH: path.join(testDir, "empty-path") },
    });
    assert.strictEqual(enabled.status, 0, `CLI run failed: ${enabled.stderr}`);
    const ids = enabled.events
      .map((event) => event.remediationId)
      .filter(Boolean);
    assert.ok(
      ids.includes("php.composer.missing"),
      `expected php.composer.missing, got ${JSON.stringify(ids)}`,
    );
  });

  it("records elixir.deps-not-fetched for a mix.exs-only project", () => {
    const fixtureDir = path.join(testDir, "elixir-fixture");
    writeElixirFixture(fixtureDir);
    const enabled = runCli(fixtureDir, "elixir", {
      tag: "enabled",
      enableLedger: true,
    });
    assert.strictEqual(enabled.status, 0, `CLI run failed: ${enabled.stderr}`);
    const ids = enabled.events
      .map((event) => event.remediationId)
      .filter(Boolean);
    assert.ok(
      ids.includes("elixir.deps-not-fetched"),
      `expected elixir.deps-not-fetched, got ${JSON.stringify(ids)}`,
    );
  });

  it("records haskell.freeze-missing for a project without a freeze file", () => {
    const fixtureDir = path.join(testDir, "haskell-fixture");
    writeHaskellFixture(fixtureDir);
    const enabled = runCli(fixtureDir, "haskell", {
      tag: "enabled",
      enableLedger: true,
    });
    assert.strictEqual(enabled.status, 0, `CLI run failed: ${enabled.stderr}`);
    const ids = enabled.events
      .map((event) => event.remediationId)
      .filter(Boolean);
    assert.ok(
      ids.includes("haskell.freeze-missing"),
      `expected haskell.freeze-missing, got ${JSON.stringify(ids)}`,
    );
  });
});
