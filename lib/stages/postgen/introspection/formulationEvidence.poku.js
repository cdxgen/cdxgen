/**
 * Tests for the formulation evidence reader.
 *
 * Formulation is the third evidence source, and the reader's contract is
 * what keeps it honest: origin classification decides whether the evidence
 * may act at all, action references must never surface as commands, and
 * environment variable values must never leave the BOM.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { assert, describe, it } from "poku";

import { LEDGER_EVENT_KINDS } from "../../../core/buildLedger.js";
import {
  declaredCommandForEcosystem,
  FORMULATION_ORIGIN_ABSENT,
  FORMULATION_ORIGIN_FOREIGN,
  FORMULATION_ORIGIN_SAME_RUN,
  findRuntimeToolMismatch,
  isActionReference,
  readFormulationEvidence,
  TOOL_NAME_ECOSYSTEMS,
} from "./formulationEvidence.js";
import { reflectOnRun } from "./reflect.js";
import {
  buildIntrospectionJson,
  renderIntrospectionMarkdown,
} from "./report.js";
import { confidenceFor, scoreReflection } from "./score.js";

// `.pathname` would keep the URL's leading slash, which makes a Windows
// path a drive letter deep in nothing: `/C:/…` joined against the cwd.
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE_DIR = join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "test",
  "data",
  "fidelity-boms",
);

/** Marker run id another run stamped, the foreign direction. */
const FOREIGN_RUN_ID = "urn:uuid:aaaaaaaa-0000-0000-0000-000000000001";

/** Sentinel planted as an environment variable *value* in the fixture BOM. */
const SENTINEL_VALUE = "cdxgen-formulation-sentinel-do-not-publish-9x2";

/**
 * A formulation BOM with both halves of the evidence: run-derived platform
 * components and git provenance, and config-parsed CI commands whose
 * environment variables carry planted values.
 *
 * @param {Object} overrides Field overrides merged into the formulation entry.
 * @returns {Object} CycloneDX BOM.
 */
function formulationBom(overrides = {}) {
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    serialNumber: "urn:uuid:formulation-reader-0000-0000-0000-000001",
    version: 1,
    metadata: {
      component: {
        type: "application",
        "bom-ref": "root",
        name: "reader-fixture",
        purl: "pkg:npm/reader-fixture@1.0.0",
      },
    },
    components: [
      {
        type: "library",
        "bom-ref": "pkg:npm/left-pad@1.3.0",
        name: "left-pad",
        version: "1.3.0",
        purl: "pkg:npm/left-pad@1.3.0",
      },
    ],
    dependencies: [
      {
        ref: "pkg:npm/reader-fixture@1.0.0",
        dependsOn: ["pkg:npm/left-pad@1.3.0"],
      },
    ],
    formulation: [
      {
        "bom-ref": "formulation-1",
        components: [
          { type: "platform", name: "java", version: "openjdk 25.0.2" },
          { type: "platform", name: "Node.js", version: "26.7.0" },
          {
            type: "file",
            name: "git-parent",
            omniborId: ["gitoid:commit:sha1:abc123parent"],
            swhid: ["swh:1:rev:abc123parent"],
          },
          {
            type: "file",
            name: "git-tree",
            omniborId: ["gitoid:tree:sha1:def456tree"],
          },
          { type: "file", name: "src/index.js", version: "blobhash1" },
          { type: "file", name: "src/util.js", version: "blobhash2" },
          { type: "library", name: "some-ci-action", version: "1.0.0" },
        ],
        workflows: [
          {
            "bom-ref": "workflow-1",
            uid: "workflow-1",
            name: "ci",
            taskTypes: ["build"],
            properties: [
              {
                name: "cdx:introspection:runId",
                value: overrides.markerRunId ?? FOREIGN_RUN_ID,
              },
            ],
            inputs: [
              {
                environmentVars: [
                  { name: "GIT_BRANCH", value: "main" },
                  { name: "JAVA_OPTS", value: SENTINEL_VALUE },
                  { name: "SDKMAN_DIR" },
                  "MAVEN_REPO",
                ],
              },
            ],
            tasks: [
              {
                "bom-ref": "task-1",
                uid: "task-1",
                name: "build",
                taskTypes: ["build"],
                steps: [
                  {
                    name: "checkout",
                    commands: [
                      {
                        executed:
                          "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
                      },
                    ],
                  },
                  {
                    name: "install",
                    commands: [{ executed: "pnpm install:frozen" }],
                  },
                  {
                    name: "wrap",
                    commands: [{ executed: "./mvnw -q package" }],
                  },
                  { name: "empty", commands: [{ executed: "" }] },
                  { name: "no-commands" },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("origin classification", () => {
  it("is same-run when the ledger observed the generation", () => {
    const evidence = readFormulationEvidence(formulationBom(), {
      runId: "this-run",
      ledgerEventCount: 12,
    });
    assert.equal(evidence.origin, FORMULATION_ORIGIN_SAME_RUN);
  });

  it("is same-run when the formulation carries this run's marker", () => {
    const evidence = readFormulationEvidence(formulationBom(), {
      runId: FOREIGN_RUN_ID,
      ledgerEventCount: 0,
    });
    assert.equal(evidence.origin, FORMULATION_ORIGIN_SAME_RUN);
  });

  it("is foreign when the marker names another run and no ledger exists", () => {
    const evidence = readFormulationEvidence(formulationBom(), {
      runId: "this-run",
      ledgerEventCount: 0,
    });
    assert.equal(evidence.origin, FORMULATION_ORIGIN_FOREIGN);
  });

  it("is absent, not foreign, for a BOM without any formulation", () => {
    // A missing record is not a foreign record. Calling it foreign would put
    // the scoring path's foreign branch in charge of a BOM that carries no
    // formulation evidence at all, which is how an empty ledger sidecar
    // lifted a marker-only verdict to medium confidence.
    const evidence = readFormulationEvidence(
      { components: [], dependencies: [] },
      { runId: "this-run", ledgerEventCount: 0 },
    );
    assert.equal(evidence.origin, FORMULATION_ORIGIN_ABSENT);
    assert.deepEqual(evidence.tools, []);
    assert.deepEqual(evidence.declaredCommands, []);
    assert.equal(evidence.sourceTree, undefined);
    assert.deepEqual(evidence.environmentKeys, []);
  });
});

describe("run-derived evidence", () => {
  it("reads the platform probes as tools", () => {
    const evidence = readFormulationEvidence(formulationBom(), {
      runId: "this-run",
      ledgerEventCount: 0,
    });
    assert.deepEqual(evidence.tools, [
      { name: "java", version: "openjdk 25.0.2", source: "probe" },
      { name: "Node.js", version: "26.7.0", source: "probe" },
    ]);
  });

  it("reads the git provenance as a source tree", () => {
    const evidence = readFormulationEvidence(formulationBom(), {
      runId: "this-run",
      ledgerEventCount: 0,
    });
    assert.deepEqual(evidence.sourceTree, {
      commit: "abc123parent",
      treeId: "def456tree",
      fileCount: 2,
    });
  });

  it("leaves the source tree out when the BOM records no provenance", () => {
    const bom = formulationBom();
    bom.formulation[0].components = [];
    const evidence = readFormulationEvidence(bom, {
      runId: "this-run",
      ledgerEventCount: 0,
    });
    assert.equal(evidence.sourceTree, undefined);
  });
});

describe("config-parsed evidence", () => {
  it("reads declared commands and never action references", () => {
    const evidence = readFormulationEvidence(formulationBom(), {
      runId: "this-run",
      ledgerEventCount: 0,
    });
    assert.deepEqual(evidence.declaredCommands, [
      {
        executable: "pnpm",
        commandLine: "pnpm install:frozen",
        workflow: "ci",
        task: "build",
        step: "install",
        source: "ci-config",
      },
      {
        executable: "mvnw",
        commandLine: "./mvnw -q package",
        workflow: "ci",
        task: "build",
        step: "wrap",
        source: "ci-config",
      },
    ]);
  });

  it("carries environment variable names and never values", () => {
    const evidence = readFormulationEvidence(formulationBom(), {
      runId: "this-run",
      ledgerEventCount: 0,
    });
    assert.deepEqual(evidence.environmentKeys, [
      "GIT_BRANCH",
      "JAVA_OPTS",
      "SDKMAN_DIR",
      "MAVEN_REPO",
    ]);
  });
});

describe("environment values never leave the reader", () => {
  it("holds no value anywhere in its output object", () => {
    const evidence = readFormulationEvidence(formulationBom(), {
      runId: "this-run",
      ledgerEventCount: 0,
    });
    assert.equal(
      !JSON.stringify(evidence).includes(SENTINEL_VALUE),
      true,
      "the planted environment value leaked into the evidence object",
    );
  });
});

describe("isActionReference", () => {
  it("marks owner/repo@revision action references", () => {
    assert.equal(
      isActionReference(
        "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      ),
      true,
    );
    assert.equal(isActionReference("pnpm/action-setup@v4.1.0"), true);
  });

  it("keeps commands, including relative-path executables", () => {
    assert.equal(isActionReference("./mvnw -q package"), false);
    assert.equal(isActionReference("mvn dependency:tree"), false);
    assert.equal(isActionReference("bash .github/scripts/build.sh"), false);
  });

  it("rejects empty and whitespace values", () => {
    assert.equal(isActionReference(""), false);
    assert.equal(isActionReference(undefined), false);
    assert.equal(isActionReference("   "), false);
  });
});

describe("findRuntimeToolMismatch", () => {
  const evidence = readFormulationEvidence(formulationBom(), {
    runId: "this-run",
    ledgerEventCount: 0,
  });

  it("finds the recorded entry of this runtime's family at another version", () => {
    assert.deepEqual(
      findRuntimeToolMismatch(evidence, { name: "Node.js", version: "22.0.0" }),
      {
        tool: "Node.js",
        recordedVersion: "26.7.0",
        runtimeVersion: "22.0.0",
      },
    );
  });

  it("finds nothing when the recorded version matches this runtime", () => {
    assert.equal(
      findRuntimeToolMismatch(evidence, { name: "Node.js", version: "26.7.0" }),
      undefined,
    );
  });

  it("finds the family's absence when the record names only other toolchains", () => {
    const bom = formulationBom();
    bom.formulation[0].components = bom.formulation[0].components.filter(
      (component) => component.name !== "Node.js",
    );
    const narrowed = readFormulationEvidence(bom, {
      runId: "this-run",
      ledgerEventCount: 0,
    });
    assert.deepEqual(
      findRuntimeToolMismatch(narrowed, { name: "Node.js", version: "22.0.0" }),
      {
        tool: "Node.js",
        recordedVersion: undefined,
        runtimeVersion: "22.0.0",
      },
    );
  });

  it("finds nothing when the formulation records no toolchain at all", () => {
    const bom = formulationBom();
    bom.formulation[0].components = [];
    const narrowed = readFormulationEvidence(bom, {
      runId: "this-run",
      ledgerEventCount: 0,
    });
    assert.equal(
      findRuntimeToolMismatch(narrowed, { name: "Node.js", version: "22.0.0" }),
      undefined,
    );
  });
});

describe("declaredCommandForEcosystem", () => {
  const evidence = readFormulationEvidence(formulationBom(), {
    runId: "this-run",
    ledgerEventCount: 0,
  });

  it("maps a declared command to the ecosystem its executable drives", () => {
    assert.equal(
      declaredCommandForEcosystem(evidence, "java")?.executable,
      "mvnw",
    );
    assert.equal(
      declaredCommandForEcosystem(evidence, "npm")?.executable,
      "pnpm",
    );
  });

  it("returns nothing for an ecosystem no declared command drives", () => {
    assert.equal(declaredCommandForEcosystem(evidence, "python"), undefined);
  });
});

describe("tool name to ecosystem mapping", () => {
  it("covers the platform names the environment probes emit", () => {
    for (const name of [
      "java",
      "dotnet",
      "python",
      "Node.js",
      "gcc",
      "rustc",
      "go",
      "ruby",
    ]) {
      assert.ok(TOOL_NAME_ECOSYSTEMS[name], `${name} has no ecosystem`);
    }
  });
});

describe("the committed rule fixtures", () => {
  it("classify the fires fixtures foreign and the same-run pass fixture same-run", () => {
    const fires = JSON.parse(
      readFileSync(join(FIXTURE_DIR, "BF-FORM-002.fires.json"), "utf-8"),
    );
    assert.equal(
      readFormulationEvidence(fires, { runId: "test-run", ledgerEventCount: 0 })
        .origin,
      FORMULATION_ORIGIN_FOREIGN,
    );
    const passes = JSON.parse(
      readFileSync(join(FIXTURE_DIR, "BF-FORM-002.passes.json"), "utf-8"),
    );
    assert.equal(
      readFormulationEvidence(passes, {
        runId: "test-run",
        ledgerEventCount: 0,
      }).origin,
      FORMULATION_ORIGIN_SAME_RUN,
    );
  });
});

describe("the confidence guard, end to end", () => {
  const catalog = JSON.parse(
    readFileSync(
      join(__dirname, "..", "..", "..", "..", "data", "remediations.json"),
      "utf-8",
    ),
  );

  /** Runtime version no test environment records, so the mismatch always fires. */
  const FOREIGN_NODE_VERSION = "0.0.0-formulation-fixture";

  /**
   * A healthy maven BOM whose formulation records the toolchain and CI
   * commands of a foreign machine, with an environment variable value
   * planted for the redaction assertion.
   *
   * @param {string} markerRunId Run id stamped on the formulation workflows.
   * @returns {Object} CycloneDX BOM.
   */
  function healthyForeignMavenBom(markerRunId) {
    return {
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      serialNumber: "urn:uuid:guard-0000-0000-0000-000000000001",
      version: 1,
      metadata: {
        component: {
          type: "application",
          "bom-ref": "pkg:maven/com.example/guarded@1.0.0",
          name: "guarded",
          purl: "pkg:maven/com.example/guarded@1.0.0",
        },
      },
      components: [
        {
          type: "library",
          "bom-ref": "pkg:maven/org.apache.commons/commons-lang3@3.14.0",
          name: "commons-lang3",
          version: "3.14.0",
          purl: "pkg:maven/org.apache.commons/commons-lang3@3.14.0",
        },
        {
          type: "library",
          "bom-ref": "pkg:maven/org.slf4j/slf4j-api@2.0.13",
          name: "slf4j-api",
          version: "2.0.13",
          purl: "pkg:maven/org.slf4j/slf4j-api@2.0.13",
        },
      ],
      dependencies: [
        {
          ref: "pkg:maven/com.example/guarded@1.0.0",
          dependsOn: [
            "pkg:maven/org.apache.commons/commons-lang3@3.14.0",
            "pkg:maven/org.slf4j/slf4j-api@2.0.13",
          ],
        },
        {
          ref: "pkg:maven/org.apache.commons/commons-lang3@3.14.0",
          dependsOn: [],
        },
        {
          ref: "pkg:maven/org.slf4j/slf4j-api@2.0.13",
          dependsOn: [],
        },
      ],
      formulation: [
        {
          "bom-ref": "formulation-1",
          components: [
            { type: "platform", name: "java", version: "openjdk 17.0.2" },
            {
              type: "platform",
              name: "Node.js",
              version: FOREIGN_NODE_VERSION,
            },
          ],
          workflows: [
            {
              "bom-ref": "workflow-1",
              uid: "workflow-1",
              name: "ci",
              taskTypes: ["build"],
              properties: [
                {
                  name: "cdx:introspection:runId",
                  value: markerRunId,
                },
              ],
              inputs: [
                {
                  environmentVars: [
                    { name: "JAVA_OPTS", value: SENTINEL_VALUE },
                  ],
                },
              ],
              tasks: [
                {
                  "bom-ref": "task-1",
                  uid: "task-1",
                  name: "build",
                  taskTypes: ["build"],
                  steps: [
                    {
                      name: "resolve",
                      commands: [
                        {
                          executed:
                            "mvn -B dependency:tree -DoutputFile=/tmp/tree.txt",
                        },
                      ],
                    },
                    {
                      name: "checkout",
                      commands: [
                        {
                          executed:
                            "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
  }

  const stripFormulation = (bom) => {
    const stripped = structuredClone(bom);
    delete stripped.formulation;
    return stripped;
  };

  const reflectSameRun = (bom) =>
    reflectOnRun(
      bom,
      { projectType: ["java"] },
      {
        ledgerEvents: [
          {
            kind: LEDGER_EVENT_KINDS.TOOL_RESOLVED,
            ecosystem: "java",
            tool: "java",
            found: "openjdk 17.0.2",
            source: "PATH",
          },
        ],
        ledgerSource: "memory",
        projectPath: "",
      },
    );

  const reflectForeign = (bom) =>
    reflectOnRun(
      bom,
      { projectType: ["java"] },
      { ledgerEvents: [], ledgerSource: "none", projectPath: "" },
    );

  it("moves no score, confidence or entry by a single point on a same-run scan", async () => {
    const withFormulation = await reflectSameRun(
      healthyForeignMavenBom("this-run"),
    );
    const withoutFormulation = await reflectSameRun(
      stripFormulation(healthyForeignMavenBom("this-run")),
    );
    const scoredWith = scoreReflection(withFormulation, catalog);
    const scoredWithout = scoreReflection(withoutFormulation, catalog);
    assert.equal(
      JSON.stringify(scoredWith),
      JSON.stringify(scoredWithout),
      "same-run formulation moved the scoring document",
    );
    for (const row of withFormulation.ecosystems) {
      for (const entry of row.toolsResolved) {
        assert.notEqual(entry.source, "formulation");
      }
    }
    for (const entry of scoredWith.remediations) {
      assert.equal(
        entry.evidence?.attemptedCommand,
        undefined,
        "a same-run entry carries a declared CI command",
      );
    }
  });

  it("produces an actionable remediation on a foreign BOM where the stripped control produces none", async () => {
    const foreign = await reflectForeign(
      healthyForeignMavenBom(FOREIGN_RUN_ID),
    );
    assert.equal(foreign.formulation.origin, FORMULATION_ORIGIN_FOREIGN);
    const scored = scoreReflection(foreign, catalog);
    assert.ok(scored.remediations.length > 0, "the foreign BOM ranked nothing");
    const entry = scored.remediations.find(
      (candidate) => candidate.remediationId === "BF-FORM-002",
    );
    assert.ok(entry, "BF-FORM-002 did not rank");
    assert.equal(entry.source, "rule");
    assert.equal(entry.confidence, "medium");
    assert.equal(
      entry.evidence?.attemptedCommand,
      "mvn -B dependency:tree -DoutputFile=/tmp/tree.txt",
    );
    assert.equal(entry.evidence?.attemptedCommandSource, "formulation");
    const javaRow = foreign.ecosystems.find((row) => row.ecosystem === "java");
    assert.equal(javaRow.tier, "manifest");
    assert.equal(
      javaRow.tierReasons.some(
        (reason) => reason.source === "formulation" && reason.determining,
      ),
      true,
      "the demoting reason does not carry the formulation source",
    );
    assert.ok(
      javaRow.toolsResolved.some(
        (tool) => tool.source === "formulation" && tool.tool === "java",
      ),
      "the formulation's platform record did not substitute for the absent ledger events",
    );

    const control = await reflectForeign(
      stripFormulation(healthyForeignMavenBom(FOREIGN_RUN_ID)),
    );
    const controlScored = scoreReflection(control, catalog);
    assert.deepEqual(controlScored.remediations, []);
    assert.equal(controlScored.ecosystems[0].tier, "resolved");
    assert.equal(controlScored.ecosystems[0].confidence, "low");
  });

  it("never exceeds medium confidence on a foreign BOM", async () => {
    const foreign = await reflectForeign(
      healthyForeignMavenBom(FOREIGN_RUN_ID),
    );
    const scored = scoreReflection(foreign, catalog);
    assert.equal(foreign.ecosystems.length > 0, true);
    for (const row of foreign.ecosystems) {
      assert.notEqual(row.confidence, "high");
    }
    for (const entry of scored.remediations) {
      assert.notEqual(entry.confidence, "high");
    }
  });

  it("holds the planted environment value out of both rendered reports", async () => {
    const foreign = await reflectForeign(
      healthyForeignMavenBom(FOREIGN_RUN_ID),
    );
    const scored = scoreReflection(foreign, catalog);
    const jsonReport = JSON.stringify(
      buildIntrospectionJson(foreign, scored, {}),
    );
    const markdownReport = renderIntrospectionMarkdown(foreign, scored, {});
    for (const report of [jsonReport, markdownReport]) {
      assert.equal(
        report.includes(SENTINEL_VALUE),
        false,
        "the planted environment value reached a report",
      );
    }
    assert.ok(
      markdownReport.includes(
        "Declared by the BOM's formulation, not observed to have run",
      ),
      "the declared command is not labelled as declared",
    );
    assert.ok(
      !markdownReport.includes("- Failed: `mvn -B dependency:tree"),
      "the declared command renders as a failure",
    );
  });

  it("leaves a marker-only verdict at low confidence, formulation or not", async () => {
    // `medium` is a cap on a foreign BOM, not a floor. A row whose tier is
    // argued only by a marker file on disk is the weakest verdict the ladder
    // produces, and a formulation record — which says nothing about that
    // marker — must not raise its confidence.
    const markerOnlyRow = {
      tierReasons: [{ source: "disk", id: "markers", determining: true }],
    };
    const withLedgerPresent = {
      ledgerSource: "sidecar",
      ledgerComplete: true,
    };
    assert.equal(
      confidenceFor(markerOnlyRow, {
        ...withLedgerPresent,
        formulation: {
          origin: FORMULATION_ORIGIN_FOREIGN,
          tools: [{ name: "java", version: "openjdk 17.0.2" }],
        },
      }),
      "low",
      "a foreign formulation raised a marker-only verdict above low",
    );
    assert.equal(
      confidenceFor(markerOnlyRow, {
        ...withLedgerPresent,
        formulation: { origin: FORMULATION_ORIGIN_ABSENT, tools: [] },
      }),
      "low",
    );
  });

  it("behaves exactly as before for a BOM without formulation", async () => {
    const reflection = await reflectForeign(
      stripFormulation(healthyForeignMavenBom(FOREIGN_RUN_ID)),
    );
    assert.equal(reflection.formulation.tools.length, 0);
    assert.equal(reflection.formulation.declaredCommands.length, 0);
    assert.equal(reflection.formulation.environmentKeys.length, 0);
    const report = JSON.stringify(
      buildIntrospectionJson(
        reflection,
        scoreReflection(reflection, catalog),
        {},
      ),
    );
    assert.equal(report.includes("attemptedCommand"), false);
    assert.equal(report.includes("formulation"), false);
  });
});
