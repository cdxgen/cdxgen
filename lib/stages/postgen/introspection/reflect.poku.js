/**
 * Tests for the reflection step: tier assignment from synthesized ledger and
 * BOM pairs, corroboration between the ledger and the rule pack, degraded
 * inputs, marker detection bounds, and the end-to-end verdict through
 * `bin/cdxgen.js`.
 *
 * The CLI fixture test spawns `node bin/cdxgen.js` as a subprocess, so it
 * needs the node CLI; everything else is runtime-neutral.
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname as pathDirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { assert, describe, it } from "poku";

import {
  LEDGER_EVENT_KINDS,
  LEDGER_TOOL_ECOSYSTEM,
  recordDegradation,
  resetLedgerEvents,
} from "../../../core/buildLedger.js";
import { detectEcosystemMarkers } from "./markers.js";
import { reflectOnRun } from "./reflect.js";

const repoRoot = join(
  pathDirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);

const tmpRoot = mkdtempSync(join(tmpdir(), "cdxgen-reflect-"));

/**
 * Build a minimal library component.
 *
 * @param {string} purl Package URL, reused as the bom-ref.
 * @param {Object} [extras] Extra component fields.
 * @returns {Object} Component.
 */
function component(purl, extras = {}) {
  const name = purl.split("/").pop()?.split("@")[0] || "unnamed";
  return {
    type: "library",
    "bom-ref": purl,
    purl,
    name,
    version: "1.0.0",
    ...extras,
  };
}

/**
 * Build a minimal BOM document.
 *
 * @param {Object[]} [components] Components.
 * @param {Object[]} [dependencies] Dependency nodes.
 * @param {Object} [metadata] Metadata section.
 * @returns {Object} BOM JSON.
 */
function bom(components = [], dependencies = [], metadata = {}) {
  return {
    specVersion: "1.6",
    metadata,
    components,
    dependencies,
  };
}

/** A covered go-shaped BOM: a root node with edges, no demoting signal. */
const healthyGoBom = bom(
  [
    component("pkg:golang/github.com/x/a@1.0.0"),
    component("pkg:golang/github.com/x/b@1.0.0"),
    component("pkg:golang/github.com/x/c@1.0.0"),
  ],
  [
    {
      ref: "pkg:golang/github.com/x/a@1.0.0",
      dependsOn: [
        "pkg:golang/github.com/x/b@1.0.0",
        "pkg:golang/github.com/x/c@1.0.0",
      ],
    },
  ],
);

/** A lockfile-shaped npm BOM: covered graph plus integrity hashes. */
const lockfileNpmBom = bom(
  [
    component("pkg:npm/left-pad@1.3.0", {
      hashes: [{ alg: "SHA-512", content: "sha512-abc" }],
    }),
    component("pkg:npm/ms@2.1.3", {
      hashes: [{ alg: "SHA-512", content: "sha512-def" }],
    }),
  ],
  [
    {
      ref: "pkg:npm/left-pad@1.3.0",
      dependsOn: ["pkg:npm/ms@2.1.3"],
    },
  ],
);

/** A pom-fallback-shaped maven BOM: components, no graph, integrity hashes
 * present so the jar-heuristic rule stays silent and the manifest rules are
 * the only signals. */
const flatMavenBom = bom([
  component("pkg:maven/org.a/one@1.0.0", {
    hashes: [
      { alg: "SHA-1", content: "da39a3ee5e6b4b0d3255bfef95601890afd80709" },
    ],
  }),
  component("pkg:maven/org.a/two@2.0.0", {
    hashes: [
      { alg: "SHA-1", content: "da39a3ee5e6b4b0d3255bfef95601890afd80709" },
    ],
  }),
  component("pkg:maven/org.b/three@3.0.0", {
    hashes: [
      { alg: "SHA-1", content: "da39a3ee5e6b4b0d3255bfef95601890afd80709" },
    ],
  }),
]);

/** A jar-heuristic-shaped maven BOM: no hashes and no evidence, the shape the
 * BF-JVM-003 rule reports. */
const jarHeuristicMavenBom = bom([
  component("pkg:maven/org.a/one@1.0.0"),
  component("pkg:maven/org.a/two@2.0.0"),
  component("pkg:maven/org.b/three@3.0.0"),
]);

/** A ceiling-shaped clojure BOM: pinned components, no graph. */
const ceilingClojureBom = bom([
  component("pkg:clojars/babashka/fs@0.5.20"),
  component("pkg:clojars/babashka/curl@1.3.0"),
]);

/** An ecosystem-assessment lookup by ecosystem name. */
function assessmentFor(reflection, ecosystem) {
  return reflection.ecosystems.find((entry) => entry.ecosystem === ecosystem);
}

/**
 * Create a project directory with the given marker file names.
 *
 * @param {string[]} names Marker file names placed at the root.
 * @returns {string} Created directory path.
 */
function projectDir(names) {
  const dir = mkdtempSync(join(tmpRoot, "proj-"));
  for (const name of names) {
    writeFileSync(join(dir, name), "marker\n");
  }
  return dir;
}

describe("reflectOnRun tier assignment", () => {
  it("grades a covered graph with no findings as resolved", async () => {
    const reflection = await reflectOnRun(
      healthyGoBom,
      { projectType: ["go"] },
      {
        ledgerEvents: [],
        projectPath: "",
      },
    );
    const go = assessmentFor(reflection, "go");
    assert.equal(go.tier, "resolved");
    assert.equal(go.state, "at-ceiling");
    assert.equal(go.degradations.length, 0);
    assert.equal(go.findings.length, 0);
    assert.ok(go.tierReasons.some((reason) => reason.determining));
  });

  it("grades lockfile evidence as lockfile when no rule fired", async () => {
    const reflection = await reflectOnRun(
      lockfileNpmBom,
      { projectType: ["js"] },
      {
        ledgerEvents: [],
        projectPath: "",
      },
    );
    const npm = assessmentFor(reflection, "npm");
    assert.equal(npm.tier, "lockfile");
    assert.equal(npm.state, "at-ceiling");
    assert.ok(
      npm.tierReasons.some(
        (reason) => reason.id === "lockfile-evidence" && reason.determining,
      ),
    );
  });

  it("grades a pom-fallback shape as manifest from the rule alone", async () => {
    const reflection = await reflectOnRun(
      flatMavenBom,
      { projectType: ["java"] },
      {
        ledgerEvents: [],
        projectPath: "",
      },
    );
    const java = assessmentFor(reflection, "java");
    assert.equal(java.tier, "manifest");
    assert.equal(java.state, "graded");
    assert.ok(java.findings.some((finding) => finding.ruleId === "BF-JVM-001"));
    assert.ok(
      java.tierReasons.some(
        (reason) => reason.source === "rule" && reason.determining,
      ),
    );
  });

  it("breaks ties toward the worse tier when the ledger adds a heuristic event", async () => {
    const reflection = await reflectOnRun(
      jarHeuristicMavenBom,
      { projectType: ["java"] },
      {
        ledgerEvents: [
          {
            kind: LEDGER_EVENT_KINDS.FALLBACK_ENGAGED,
            ecosystem: "java",
            tool: "jar",
            impact: "versions",
            remediationId: "jvm.jar.heuristic",
            detail: "Components were inferred from jar files.",
          },
        ],
        projectPath: "",
      },
    );
    const java = assessmentFor(reflection, "java");
    assert.equal(java.tier, "heuristic");
    assert.ok(
      java.tierReasons.some(
        (reason) =>
          reason.source === "ledger" &&
          reason.id === "jvm.jar.heuristic" &&
          reason.determining,
      ),
    );
    // The manifest rule still contributed without determining the tier.
    assert.ok(
      java.tierReasons.some(
        (reason) => reason.id === "BF-JVM-001" && !reason.determining,
      ),
    );
  });

  it("demotes to manifest from an uncorroborated-by-rules event when nothing was produced", async () => {
    const reflection = await reflectOnRun(
      bom(),
      { projectType: ["python"] },
      {
        ledgerEvents: [
          {
            kind: LEDGER_EVENT_KINDS.EVIDENCE_DEGRADED,
            ecosystem: "python",
            impact: "transitive-deps",
            remediationId: "python.lockfile-unparseable",
            detail: "The lock file could not be parsed.",
          },
        ],
        projectPath: "",
      },
    );
    const python = assessmentFor(reflection, "python");
    assert.equal(python.tier, "manifest");
    assert.deepEqual(
      python.degradations.map((entry) => entry.remediationId),
      ["python.lockfile-unparseable"],
    );
  });

  it("grades markers with zero components as absent", async () => {
    const dir = projectDir(["Podfile"]);
    const reflection = await reflectOnRun(
      bom([], [], {
        component: {
          type: "application",
          name: "app",
          "bom-ref": "app",
          purl: "pkg:cocoapods/app@1.0.0",
        },
      }),
      { projectType: ["cocoa"] },
      { ledgerEvents: [], projectPath: dir },
    );
    const cocoa = assessmentFor(reflection, "cocoa");
    assert.equal(cocoa.tier, "absent");
    assert.equal(cocoa.state, "absent");
    assert.equal(cocoa.componentCount, 0);
    assert.ok(cocoa.markersOnDisk.length > 0);
    assert.ok(
      cocoa.tierReasons.some(
        (reason) => reason.source === "disk" && reason.determining,
      ),
    );
  });

  it("classifies a ceiling ecosystem as at-ceiling and keeps its degradations out of the remediation set", async () => {
    const reflection = await reflectOnRun(
      ceilingClojureBom,
      { projectType: ["clj"] },
      {
        ledgerEvents: [
          {
            kind: LEDGER_EVENT_KINDS.FALLBACK_ENGAGED,
            ecosystem: "clojure",
            impact: "transitive-deps",
            remediationId: "clojure.lein.missing",
            detail: "lein is unavailable; project.clj was parsed manually.",
          },
        ],
        projectPath: "",
      },
    );
    const clojure = assessmentFor(reflection, "clojure");
    assert.equal(clojure.tier, "manifest");
    assert.equal(clojure.state, "at-ceiling");
    assert.equal(clojure.degradations.length, 0);
    assert.ok(
      reflection.observations.some(
        (observation) => observation.remediationId === "clojure.lein.missing",
      ),
    );
  });

  it("keeps an uncorroborated degradation out of the remediation set on a healthy BOM", async () => {
    // A healthy python BOM (graph covered, provenance properties present)
    // with a ledger event whose damage the BOM does not show — the shape of
    // a degraded fixture inside the tree rather than the scanned project.
    const healthyPythonBom = bom(
      [
        component("pkg:pypi/click@8.1.7", {
          properties: [{ name: "cdx:pypi:versionSpecifiers", value: "^8.1" }],
        }),
        component("pkg:pypi/requests@2.31.0", {
          properties: [{ name: "cdx:pypi:versionSpecifiers", value: "^2.31" }],
        }),
      ],
      [
        {
          ref: "pkg:pypi/click@8.1.7",
          dependsOn: ["pkg:pypi/requests@2.31.0"],
        },
      ],
    );
    const reflection = await reflectOnRun(
      healthyPythonBom,
      { projectType: ["python"] },
      {
        ledgerEvents: [
          {
            kind: LEDGER_EVENT_KINDS.EVIDENCE_DEGRADED,
            ecosystem: "python",
            impact: "transitive-deps",
            remediationId: "python.lockfile-unparseable",
            detail: "A lock file inside the tree could not be parsed.",
          },
        ],
        projectPath: "",
      },
    );
    const python = assessmentFor(reflection, "python");
    assert.equal(python.degradations.length, 0);
    assert.ok(
      reflection.observations.some(
        (observation) =>
          observation.remediationId === "python.lockfile-unparseable",
      ),
    );
  });

  it("reports unsupported ecosystems as coverage gaps without a tier", async () => {
    const dir = projectDir(["dub.json", "elm.json"]);
    const reflection = await reflectOnRun(
      bom(),
      { projectType: ["dub"] },
      {
        ledgerEvents: [],
        projectPath: dir,
      },
    );
    const dub = assessmentFor(reflection, "dub");
    assert.equal(dub.state, "unsupported");
    assert.equal(dub.tier, null);
    assert.ok(dub.markersOnDisk.some((marker) => marker.endsWith("dub.json")));
    // elm was a coverage gap until it gained a parser; a supported type
    // with no package-fidelity ladder gets no row at all rather than an
    // unsupported one.
    assert.equal(assessmentFor(reflection, "elm"), undefined);
    assert.equal(
      reflection.ecosystems.filter((entry) => entry.state === "unsupported")
        .length,
      1,
    );
  });

  it("gives supported non-package project types no row at all", async () => {
    for (const projectType of ["docker", "os", "universal", "github"]) {
      const reflection = await reflectOnRun(
        bom(),
        { projectType: [projectType] },
        { ledgerEvents: [], projectPath: "" },
      );
      assert.equal(
        assessmentFor(reflection, projectType),
        undefined,
        `${projectType} is a cdxgen project type and must not be reported as a coverage gap`,
      );
    }
  });
});

describe("reflectOnRun degraded inputs", () => {
  it("produces a complete reflection with no ledger at all", async () => {
    const reflection = await reflectOnRun(
      flatMavenBom,
      { projectType: ["java"] },
      {
        ledgerEvents: [],
        projectPath: "",
      },
    );
    assert.equal(reflection.ledgerSource, "none");
    assert.equal(reflection.ledgerComplete, true);
    assert.ok(reflection.ecosystems.length > 0);
    assert.ok(reflection.inputsFingerprint.match(/^[0-9a-f]{64}$/));
    assert.ok(reflection.runtime.name);
  });

  it("reports an incomplete ledger when the truncation marker is present", async () => {
    const reflection = await reflectOnRun(
      healthyGoBom,
      { projectType: ["go"] },
      {
        ledgerEvents: [
          {
            kind: LEDGER_EVENT_KINDS.EVIDENCE_DEGRADED,
            ecosystem: LEDGER_TOOL_ECOSYSTEM,
            detail: "The in-memory build ledger reached its cap of 10 events.",
          },
        ],
        projectPath: "",
      },
    );
    assert.equal(reflection.ledgerComplete, false);
    assert.ok(
      reflection.observations.some(
        (observation) => observation.ecosystem === LEDGER_TOOL_ECOSYSTEM,
      ),
    );
    assert.equal(
      reflection.ecosystems.some(
        (entry) => entry.ecosystem === LEDGER_TOOL_ECOSYSTEM,
      ),
      false,
    );
  });

  it("carries the failure facts onto the degradation and the observation", async () => {
    const failedEvent = {
      kind: LEDGER_EVENT_KINDS.COMMAND_FAILED,
      ecosystem: "java",
      tool: "maven",
      command: "mvn -B dependency:tree",
      exitCode: 1,
      remediationId: "jvm.maven.manifest-fallback",
      impact: "transitive-deps",
      detail: "The maven dependency tree did not succeed.",
      causeDetail: "the resolver could not reach the repository",
      outputExcerpt: "[ERROR] Failed to execute goal …",
    };
    const reflection = await reflectOnRun(
      flatMavenBom,
      { projectType: ["java"] },
      { ledgerEvents: [failedEvent], projectPath: "" },
    );
    const go = assessmentFor(reflection, "java");
    assert.equal(go.degradations.length, 1);
    assert.deepEqual(go.degradations[0], {
      remediationId: "jvm.maven.manifest-fallback",
      impact: "transitive-deps",
      detail: "The maven dependency tree did not succeed.",
      command: "mvn -B dependency:tree",
      exitCode: 1,
      causeDetail: "the resolver could not reach the repository",
      outputExcerpt: "[ERROR] Failed to execute goal …",
    });
  });

  it("an uncorroborated failure keeps its facts on the observation", async () => {
    // A covered graph and no findings: the recorded failure cost the output
    // nothing measurable, so the event is an observation — one that still
    // carries its command, exit code and excerpt.
    const reflection = await reflectOnRun(
      healthyGoBom,
      { projectType: ["go"] },
      {
        ledgerEvents: [
          {
            kind: LEDGER_EVENT_KINDS.COMMAND_FAILED,
            ecosystem: "go",
            tool: "go",
            command: "go mod download",
            exitCode: 1,
            remediationId: "policy.offline",
            impact: "none",
            detail: "The module download did not succeed.",
            outputExcerpt: "go: module lookup disabled",
          },
        ],
        projectPath: "",
      },
    );
    assert.equal(assessmentFor(reflection, "go").degradations.length, 0);
    const observation = reflection.observations.find(
      (entry) => entry.remediationId === "policy.offline",
    );
    assert.ok(observation, "the failure is reported as an observation");
    assert.equal(observation.command, "go mod download");
    assert.equal(observation.exitCode, 1);
    assert.equal(observation.outputExcerpt, "go: module lookup disabled");
  });

  it("ignores unknown ledger event kinds without throwing", async () => {
    const reflection = await reflectOnRun(
      healthyGoBom,
      { projectType: ["go"] },
      {
        ledgerEvents: [
          {
            kind: "future.producer.kind",
            ecosystem: "go",
            detail: "An event kind a newer cdxgen records.",
          },
        ],
        projectPath: "",
      },
    );
    const go = assessmentFor(reflection, "go");
    assert.equal(go.tier, "resolved");
  });

  it("changes the fingerprint when a resolved tool version changes", async () => {
    const baseEvents = [
      {
        kind: LEDGER_EVENT_KINDS.TOOL_RESOLVED,
        ecosystem: "java",
        tool: "maven",
        found: "3.9.6",
        source: "PATH",
      },
    ];
    const before = await reflectOnRun(
      flatMavenBom,
      { projectType: ["java"] },
      {
        ledgerEvents: baseEvents,
        projectPath: "",
      },
    );
    const after = await reflectOnRun(
      flatMavenBom,
      { projectType: ["java"] },
      {
        ledgerEvents: [{ ...baseEvents[0], found: "3.9.9" }],
        projectPath: "",
      },
    );
    assert.notEqual(before.inputsFingerprint, after.inputsFingerprint);
  });

  it("keeps the fingerprint stable when only timestamps move", async () => {
    const baseEvents = [
      {
        kind: LEDGER_EVENT_KINDS.TOOL_RESOLVED,
        ecosystem: "java",
        tool: "maven",
        found: "3.9.6",
        source: "PATH",
        timestamp: "2026-01-01T00:00:00.000Z",
      },
      {
        kind: LEDGER_EVENT_KINDS.TOOL_EXPECTED,
        ecosystem: "java",
        tool: "java",
        wanted: "17",
        source: "wrapper",
        timestamp: "2026-01-01T00:00:01.000Z",
      },
    ];
    const before = await reflectOnRun(
      flatMavenBom,
      { projectType: ["java"] },
      {
        ledgerEvents: baseEvents,
        projectPath: "",
      },
    );
    const after = await reflectOnRun(
      flatMavenBom,
      { projectType: ["java"] },
      {
        ledgerEvents: baseEvents.map((event) => ({
          ...event,
          timestamp: "2027-06-06T06:06:06.000Z",
        })),
        projectPath: "",
      },
    );
    assert.equal(before.inputsFingerprint, after.inputsFingerprint);
    assert.notEqual(before.runId, after.runId);
  });

  it("does not let events outside the scan scope create an ecosystem row", async () => {
    const reflection = await reflectOnRun(
      bom(),
      { projectType: ["r"] },
      {
        ledgerEvents: [
          {
            kind: LEDGER_EVENT_KINDS.EVIDENCE_DEGRADED,
            ecosystem: "npm",
            impact: "transitive-deps",
            remediationId: "js.no-node-modules",
            detail: "node_modules is absent.",
          },
        ],
        projectPath: "",
      },
    );
    assert.equal(assessmentFor(reflection, "npm"), undefined);
    assert.ok(
      reflection.observations.some(
        (observation) => observation.remediationId === "js.no-node-modules",
      ),
    );
  });
});

describe("marker detection bounds", () => {
  it("does not descend more than one directory level", () => {
    const root = mkdtempSync(join(tmpRoot, "depth-"));
    mkdirSync(join(root, "child"), { recursive: true });
    mkdirSync(join(root, "deep", "deeper", "deepest"), { recursive: true });
    writeFileSync(join(root, "child", "elm.json"), "{}\n");
    writeFileSync(join(root, "deep", "deeper", "deepest", "elm.json"), "{}\n");
    const visited = [];
    const realListDir = (dirPath) =>
      readdirSync(dirPath, { withFileTypes: true })
        .map((entry) => ({
          name: entry.name,
          directory: entry.isDirectory(),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    const spyListDir = (dirPath) => {
      visited.push(dirPath);
      return realListDir(dirPath);
    };
    const { markersByEcosystem } = detectEcosystemMarkers(root, {
      listDir: spyListDir,
    });
    for (const visitedPath of visited) {
      const relative = visitedPath.slice(root.length);
      assert.ok(
        relative === "" || relative.split(sep).length === 2,
        `marker detection visited ${visitedPath}, deeper than one level`,
      );
    }
    const elmPaths = markersByEcosystem.get("elm") || [];
    assert.ok(elmPaths.includes(join(root, "child", "elm.json")));
    assert.ok(
      !elmPaths.includes(join(root, "deep", "deeper", "deepest", "elm.json")),
    );
    rmSync(root, { recursive: true, force: true });
  });

  it("builds marker paths with platform separators", () => {
    const dir = projectDir(["Podfile", "shard.yml"]);
    const { markersByEcosystem } = detectEcosystemMarkers(dir);
    assert.deepEqual(markersByEcosystem.get("cocoa"), [join(dir, "Podfile")]);
    assert.deepEqual(markersByEcosystem.get("crystal"), [
      join(dir, "shard.yml"),
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns no markers for a path that cannot be inspected", () => {
    const { markersByEcosystem, scannedDirectories } = detectEcosystemMarkers(
      join(tmpRoot, "does", "not", "exist"),
    );
    assert.equal(markersByEcosystem.size, 0);
    assert.equal(scannedDirectories, 0);
  });
});

describe("reflection over committed fixtures", () => {
  const golden = (name) =>
    JSON.parse(
      readFileSync(
        join(repoRoot, "test", "repotests", name, "expected", "default.json"),
        "utf-8",
      ),
    );

  it("classifies the pubspec-smoke dart row as at-ceiling manifest", async () => {
    const reflection = await reflectOnRun(
      golden("pubspec-smoke"),
      { projectType: ["dart"] },
      {
        ledgerEvents: [],
        projectPath: "",
      },
    );
    const dart = assessmentFor(reflection, "dart");
    assert.equal(dart.tier, "manifest");
    assert.equal(dart.state, "at-ceiling");
    assert.equal(dart.findings.length > 0, true);
  });

  it("classifies the swift-smoke ceiling as at-ceiling", async () => {
    const reflection = await reflectOnRun(
      golden("swift-smoke"),
      { projectType: ["swift"] },
      {
        ledgerEvents: [],
        projectPath: "",
      },
    );
    const swift = assessmentFor(reflection, "swift");
    assert.equal(swift.tier, "lockfile");
    assert.equal(swift.state, "at-ceiling");
    assert.equal(swift.degradations.length, 0);
  });

  it("grades the python-smoke requirements shape as a graded heuristic row", async () => {
    const reflection = await reflectOnRun(
      golden("python-smoke"),
      { projectType: ["python"] },
      {
        ledgerEvents: [],
        projectPath: "",
      },
    );
    const python = assessmentFor(reflection, "python");
    // requirements.txt pins flask with flask>=2.0.0, and since #4717 a range
    // requirement leaves the component version-less. The unpinned-component
    // findings (BF-GEN-002, BF-PY-003) argue the worst tier, so the row sits
    // on heuristic rather than manifest while the state stays graded.
    assert.equal(python.tier, "heuristic");
    assert.equal(python.state, "graded");
  });
});

describe("reflection through bin/cdxgen.js", () => {
  const fixture = join(repoRoot, "test", "repotests", "swift-smoke");

  it("prints a verdict line when introspection is enabled", () => {
    const result = spawnSync(
      process.execPath,
      [
        join(repoRoot, "bin", "cdxgen.js"),
        "-t",
        "swift",
        "--no-install-deps",
        "--introspect",
        "-o",
        join(tmpRoot, "introspect-bom.json"),
        fixture,
      ],
      {
        encoding: "utf-8",
        timeout: 240000,
        // The introspection report can exceed spawnSync's 1 MiB default on
        // machines with a rich build environment (long cache paths widen the
        // table), which kills the child with ENOBUFS instead of letting it
        // exit; give the diagnostic stream room.
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, CDXGEN_INTROSPECT: "" },
      },
    );
    assert.equal(
      `${result.stdout}${result.stderr}`.includes(
        "Build introspection: overall lockfile (100/100), confidence",
      ),
      true,
      `verdict line missing from the CLI output:\n${result.stdout.slice(-2000)}\n${result.stderr.slice(-2000)}`,
    );
    // The ceiling fixture scores 100 and carries no remediation, so the
    // counts line doubles as the no-nagging regression guard.
    assert.equal(
      `${result.stdout}${result.stderr}`.includes(
        "Build introspection: 0 remediation(s) ranked",
      ),
      true,
      `remediation counts line missing from the CLI output:\n${result.stdout.slice(-2000)}\n${result.stderr.slice(-2000)}`,
    );
    // The flag alone must switch the recorder on: a ledger event recorded
    // during the run means --introspect is a full equivalent of the
    // environment opt-in.
    assert.equal(
      `${result.stdout}${result.stderr}`.includes(
        "Build introspection: markdown report:",
      ),
      true,
      "report path line missing from the CLI output",
    );
  });

  it("stays silent when introspection is disabled", () => {
    const result = spawnSync(
      process.execPath,
      [
        join(repoRoot, "bin", "cdxgen.js"),
        "-t",
        "swift",
        "--no-install-deps",
        "-o",
        join(tmpRoot, "plain-bom.json"),
        fixture,
      ],
      {
        encoding: "utf-8",
        timeout: 240000,
        // The introspection report can exceed spawnSync's 1 MiB default on
        // machines with a rich build environment (long cache paths widen the
        // table), which kills the child with ENOBUFS instead of letting it
        // exit; give the diagnostic stream room.
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, CDXGEN_INTROSPECT: "" },
      },
    );
    assert.equal(result.status, 0);
    assert.equal(
      `${result.stdout}${result.stderr}`.includes("Build introspection"),
      false,
      "introspection ran without the opt-in",
    );
  });

  it("keeps introspection off when --profile introspect meets --no-introspect", () => {
    const result = spawnSync(
      process.execPath,
      [
        join(repoRoot, "bin", "cdxgen.js"),
        "-t",
        "python",
        "--no-install-deps",
        "--profile",
        "introspect",
        "--no-introspect",
        "-o",
        join(tmpRoot, "negated-bom.json"),
        join(repoRoot, "test", "repotests", "python-smoke"),
      ],
      {
        encoding: "utf-8",
        timeout: 240000,
        // The introspection report can exceed spawnSync's 1 MiB default on
        // machines with a rich build environment (long cache paths widen the
        // table), which kills the child with ENOBUFS instead of letting it
        // exit; give the diagnostic stream room.
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, CDXGEN_INTROSPECT: "" },
      },
    );
    assert.equal(result.status, 0);
    const output = `${result.stdout}${result.stderr}`;
    assert.equal(
      output.includes("Build introspection"),
      false,
      "the explicit negation must keep introspection off",
    );
    assert.ok(
      output.includes("--no-introspect"),
      "the negation warns the user",
    );
  });
});

describe("introspection reports and CI gate through bin/cdxgen.js", () => {
  const ceilingFixture = join(repoRoot, "test", "repotests", "swift-smoke");
  // The degraded shape is forced through the environment, not the fixture:
  // a healthy pom plus a dead MVN_CMD grades manifest on any machine.
  const degradedFixture = join(tmpRoot, "gate-fail-fixture");
  mkdirSync(degradedFixture, { recursive: true });
  copyFileSync(
    join(repoRoot, "test", "repotests", "maven-smoke", "pom.xml"),
    join(degradedFixture, "pom.xml"),
  );

  it("exits with the gate code after writing the BOM and the reports", () => {
    const output = join(tmpRoot, "gate-fail", "bom.json");
    const result = spawnSync(
      process.execPath,
      [
        join(repoRoot, "bin", "cdxgen.js"),
        "-t",
        "java",
        "--no-install-deps",
        "--introspect",
        "--introspect-fail-below",
        "70",
        "-o",
        output,
        degradedFixture,
      ],
      {
        encoding: "utf-8",
        timeout: 240000,
        // The introspection report can exceed spawnSync's 1 MiB default on
        // machines with a rich build environment (long cache paths widen the
        // table), which kills the child with ENOBUFS instead of letting it
        // exit; give the diagnostic stream room.
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          CDXGEN_INTROSPECT: "",
          MVN_CMD: join("/", "cdxgen-nonexistent", "mvn"),
        },
      },
    );
    assert.equal(
      result.status,
      4,
      `expected the gate exit code, got ${result.status}: ${result.stderr.slice(-1500)}`,
    );
    // The gate never withholds output: the BOM and both reports exist.
    assert.ok(existsSync(output), "the BOM is written before the gate fires");
    assert.ok(existsSync(`${output}.introspection.md`));
    assert.ok(existsSync(`${output}.introspection.json`));
    assert.ok(
      `${result.stdout}${result.stderr}`.includes(
        "below the --introspect-fail-below threshold 70",
      ),
    );
  });

  it("exits zero when the score clears the threshold", () => {
    const output = join(tmpRoot, "gate-pass", "bom.json");
    const result = spawnSync(
      process.execPath,
      [
        join(repoRoot, "bin", "cdxgen.js"),
        "-t",
        "swift",
        "--no-install-deps",
        "--introspect",
        "--introspect-fail-below",
        "70",
        "-o",
        output,
        ceilingFixture,
      ],
      {
        encoding: "utf-8",
        timeout: 240000,
        // The introspection report can exceed spawnSync's 1 MiB default on
        // machines with a rich build environment (long cache paths widen the
        // table), which kills the child with ENOBUFS instead of letting it
        // exit; give the diagnostic stream room.
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, CDXGEN_INTROSPECT: "" },
      },
    );
    assert.equal(result.status, 0);
    assert.ok(existsSync(`${output}.introspection.json`));
  });

  it("produces the report without writing any file under dry-run", () => {
    const output = join(tmpRoot, "dry-run", "bom.json");
    const result = spawnSync(
      process.execPath,
      [
        join(repoRoot, "bin", "cdxgen.js"),
        "-t",
        "java",
        "--dry-run",
        "--introspect",
        "-o",
        output,
        degradedFixture,
      ],
      {
        encoding: "utf-8",
        timeout: 240000,
        // The introspection report can exceed spawnSync's 1 MiB default on
        // machines with a rich build environment (long cache paths widen the
        // table), which kills the child with ENOBUFS instead of letting it
        // exit; give the diagnostic stream room.
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          CDXGEN_INTROSPECT: "",
          MVN_CMD: join("/", "cdxgen-nonexistent", "mvn"),
        },
      },
    );
    assert.equal(result.status, 0);
    assert.ok(!existsSync(output), "dry-run writes no BOM");
    assert.ok(!existsSync(`${output}.introspection.md`));
    assert.ok(!existsSync(`${output}.introspection.json`));
    // The report is still produced, on the diagnostic stream.
    assert.ok(
      result.stderr.includes("# cdxgen build introspection"),
      "the markdown report goes to the diagnostic stream in dry-run",
    );
    assert.ok(
      result.stderr.includes("dry-run mode produced the report"),
      "the summary names the dry-run behaviour",
    );
  });

  it("defaults the reports to the working directory when the BOM goes to stdout", () => {
    const result = spawnSync(
      process.execPath,
      [
        join(repoRoot, "bin", "cdxgen.js"),
        "-t",
        "swift",
        "--no-install-deps",
        "--introspect",
        "--print",
        "--no-progress",
        "-o",
        "-",
        ceilingFixture,
      ],
      {
        encoding: "utf-8",
        timeout: 240000,
        // The introspection report can exceed spawnSync's 1 MiB default on
        // machines with a rich build environment (long cache paths widen the
        // table), which kills the child with ENOBUFS instead of letting it
        // exit; give the diagnostic stream room.
        maxBuffer: 16 * 1024 * 1024,
        cwd: tmpRoot,
        env: { ...process.env, CDXGEN_INTROSPECT: "" },
      },
    );
    assert.equal(result.status, 0);
    // stdout carries only the BOM payload, so the summary naming the reports
    // lives on the diagnostic stream.
    assert.ok(
      result.stderr.includes("markdown report: cdxgen-introspection.md"),
      "the summary names the working-directory default",
    );
    assert.ok(
      existsSync(join(tmpRoot, "cdxgen-introspection.md")),
      "the named report exists",
    );
    assert.ok(existsSync(join(tmpRoot, "cdxgen-introspection.json")));
    rmSync(join(tmpRoot, "cdxgen-introspection.md"), { force: true });
    rmSync(join(tmpRoot, "cdxgen-introspection.json"), { force: true });
  });
});

await describe("reflectOnRun ledger sidecar that was never created", async () => {
  await it("reads the in-memory events instead of an empty sidecar", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cdxgen-reflect-sidecar-"));
    const names = ["CDXGEN_INTROSPECT", "CDXGEN_INTROSPECT_LEDGER"];
    const saved = Object.fromEntries(
      names.map((name) => [name, process.env[name]]),
    );
    try {
      // A sidecar path the run could not create, as when the permission
      // model denies writes outside the granted paths
      const missingSidecar = join(dir, "not-created", "ledger.jsonl");
      process.env.CDXGEN_INTROSPECT = "true";
      process.env.CDXGEN_INTROSPECT_LEDGER = missingSidecar;
      resetLedgerEvents();
      assert.ok(
        recordDegradation("python.lockfile-unparseable", {
          ecosystem: "python",
          impact: "transitive-deps",
          detail: "The lock file could not be parsed.",
        }),
        "the degradation was not recorded",
      );
      assert.equal(existsSync(missingSidecar), false);
      const reflection = await reflectOnRun(
        bom(),
        { projectType: ["python"] },
        { projectPath: "" },
      );
      assert.equal(reflection.ledgerSource, "memory");
      assert.deepEqual(
        assessmentFor(reflection, "python").degradations.map(
          (entry) => entry.remediationId,
        ),
        ["python.lockfile-unparseable"],
      );
      assert.ok(
        reflection.observations.some(
          (observation) => observation.kind === "ledger.memory-only",
        ),
      );

      // Control: a sidecar that exists is still preferred over the buffer
      const emptySidecar = join(dir, "ledger.jsonl");
      writeFileSync(emptySidecar, "");
      process.env.CDXGEN_INTROSPECT_LEDGER = emptySidecar;
      const fromSidecar = await reflectOnRun(
        bom(),
        { projectType: ["python"] },
        { projectPath: "" },
      );
      assert.equal(fromSidecar.ledgerSource, "sidecar");
      assert.equal(
        (assessmentFor(fromSidecar, "python")?.degradations || []).length,
        0,
      );
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
      resetLedgerEvents();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
