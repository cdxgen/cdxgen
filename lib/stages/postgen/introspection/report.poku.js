/**
 * Tests for the report renderers: golden markdown and JSON over three
 * committed fixture reflections (a clean run, a degraded JVM run, and a
 * no-ledger foreign-BOM audit), determinism and shuffle stability, the clean
 * run's positive framing, redaction on both renderers, bounded table cells,
 * and the console summary's shape.
 *
 * Everything here is runtime-neutral: the renderers are pure and no test
 * spawns a process.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { assert, describe, it } from "poku";

import {
  buildIntrospectionJson,
  INTROSPECTION_REPORT_SCHEMA_VERSION,
  overallAssessment,
  renderIntrospectionConsole,
  renderIntrospectionMarkdown,
} from "./report.js";
import { scoreReflection } from "./score.js";

const repoRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);

const catalog = JSON.parse(
  readFileSync(join(repoRoot, "data", "remediations.json"), "utf-8"),
);

/** Options the goldens were rendered with. */
const GOLDEN_OPTIONS = { output: "bom.json", installDeps: false };

const FIXTURE_NAMES = ["clean-go", "degraded-jvm", "foreign-bom"];

/**
 * Load a fixture reflection and its scoring.
 *
 * @param {string} name Fixture name.
 * @returns {{reflection: Object, scored: Object}} Fixture and its score.
 */
function loadFixture(name) {
  const reflection = JSON.parse(
    readFileSync(
      join(
        repoRoot,
        "test",
        "data",
        "introspection",
        `${name}.reflection.json`,
      ),
      "utf-8",
    ),
  );
  return { reflection, scored: scoreReflection(reflection, catalog, {}) };
}

/**
 * Deterministic PRNG (mulberry32) so shuffled inputs are identical on every
 * run and every platform.
 *
 * @param {number} seed Seed value.
 * @returns {() => number} Generator producing floats in [0, 1).
 */
function prng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Shuffle a copy of an array.
 *
 * @param {Array} values Array to shuffle.
 * @param {() => number} random Generator.
 * @returns {Array} Shuffled copy.
 */
function shuffled(values, random) {
  const copy = [...(Array.isArray(values) ? values : [])];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

/**
 * Shuffle every ordered array a reflection carries, so a renderer that
 * iterates any of them in input order produces a different report.
 *
 * @param {Object} reflection Reflection document.
 * @param {number} seed Seed value.
 * @returns {Object} Shuffled copy.
 */
function shuffledReflection(reflection, seed) {
  const random = prng(seed);
  return {
    ...reflection,
    ecosystems: shuffled(
      (reflection.ecosystems || []).map((row) => ({
        ...row,
        tierReasons: shuffled(row.tierReasons, random),
        markersOnDisk: shuffled(row.markersOnDisk, random),
        toolsExpected: shuffled(row.toolsExpected, random),
        toolsResolved: shuffled(row.toolsResolved, random),
        toolsMissing: shuffled(row.toolsMissing, random),
        toolsMismatched: shuffled(row.toolsMismatched, random),
        degradations: shuffled(row.degradations, random),
        findings: shuffled(row.findings, random),
      })),
      random,
    ),
    observations: shuffled(reflection.observations, random),
    globalFindings: shuffled(reflection.globalFindings, random),
  };
}

/**
 * A basic graded manifest row with no deductions.
 *
 * @param {string} ecosystem Ecosystem name.
 * @param {number} componentCount Component count.
 * @returns {Object} Row.
 */
function gradedRow(ecosystem, componentCount) {
  return {
    ecosystem,
    state: "graded",
    tier: "manifest",
    ceilingTier: "resolved",
    tierReasons: [{ source: "rule", id: "BF-GEN-001", determining: true }],
    componentCount,
    dependencyEdgeCount: 0,
    markersOnDisk: [],
    toolsExpected: [],
    toolsResolved: [],
    toolsMissing: [],
    toolsMismatched: [],
    degradations: [],
    findings: [
      {
        ruleId: "BF-GEN-001",
        message: "flat graph",
        severity: "high",
        tierSignal: "manifest",
      },
    ],
  };
}

describe("markdown goldens", () => {
  for (const name of FIXTURE_NAMES) {
    it(`renders ${name} byte-identically`, () => {
      const { reflection, scored } = loadFixture(name);
      const rendered = renderIntrospectionMarkdown(
        reflection,
        scored,
        GOLDEN_OPTIONS,
      );
      const golden = readFileSync(
        join(repoRoot, "test", "data", "introspection", `${name}.golden.md`),
        "utf-8",
      );
      assert.equal(rendered, golden);
    });
  }

  it("keeps the clean run free of a remediation section and says so positively", () => {
    const { reflection, scored } = loadFixture("clean-go");
    const rendered = renderIntrospectionMarkdown(
      reflection,
      scored,
      GOLDEN_OPTIONS,
    );
    assert.equal(rendered.includes("## What to fix"), false);
    assert.equal(rendered.includes("## Cannot be fixed"), false);
    assert.match(rendered, /nothing needs fixing/);
  });

  it("keeps the graded-but-quiet run free of a remediation section too", () => {
    // A healthy lockfile parse grades below resolved with nothing actionable;
    // a report that nags here reads as an accusation of a healthy project.
    const reflection = {
      ledgerSource: "sidecar",
      ledgerComplete: true,
      ledgerEventCount: 0,
      projectTypes: ["python"],
      projectPath: "",
      ecosystems: [
        {
          ...gradedRow("python", 149),
          tier: "lockfile",
          findings: [],
          tierReasons: [
            {
              source: "bom",
              id: "lockfile-evidence",
              detail: "Components carry per-package provenance properties.",
              determining: true,
            },
          ],
        },
      ],
      observations: [],
    };
    const rendered = renderIntrospectionMarkdown(
      reflection,
      scoreReflection(reflection, catalog, {}),
      GOLDEN_OPTIONS,
    );
    assert.equal(rendered.includes("## What to fix"), false);
    assert.match(rendered, /no remediations are pending/);
  });

  it("never accuses an at-ceiling ecosystem of its tier", () => {
    const { reflection, scored } = loadFixture("clean-go");
    const rendered = renderIntrospectionMarkdown(
      reflection,
      scored,
      GOLDEN_OPTIONS,
    );
    assert.doesNotMatch(rendered, /missing transitive dependencies/);
  });

  it("renders the degraded JVM run with the ledger remediation ranked first", () => {
    const { reflection, scored } = loadFixture("degraded-jvm");
    const rendered = renderIntrospectionMarkdown(
      reflection,
      scored,
      GOLDEN_OPTIONS,
    );
    const fallbackAt = rendered.indexOf("### 1. Maven build failed");
    const genericAt = rendered.indexOf("Only 0 of 3 components");
    assert.ok(fallbackAt >= 0, "the ledger remediation must be section 1");
    assert.ok(
      genericAt > fallbackAt,
      "rule remediations follow the ledger one",
    );
    assert.equal(
      rendered.includes("### 3."),
      false,
      "BF-JVM-001 is folded into the maven fix that clears it, not ranked again",
    );
    assert.match(rendered, /Also resolves: `BF-JVM-001`/);
    assert.match(rendered, /45 → 100/);
    assert.match(rendered, /expected overall gain: \+55\.00/);
  });

  it("gives the degraded JVM run both command blocks with resolved versions", () => {
    const { reflection, scored } = loadFixture("degraded-jvm");
    const rendered = renderIntrospectionMarkdown(
      reflection,
      scored,
      GOLDEN_OPTIONS,
    );
    assert.match(rendered, /```sh\nsdk install java 21\n/);
    assert.match(
      rendered,
      /```bat\nwinget install --id EclipseAdoptium\.Temurin\.21\.JDK\n/,
    );
    assert.match(rendered, /mvn -q package -DskipTests/);
  });

  it("gives a rule-derived remediation a pasteable re-scan in both blocks", () => {
    const { reflection, scored } = loadFixture("foreign-bom");
    const rendered = renderIntrospectionMarkdown(
      reflection,
      scored,
      GOLDEN_OPTIONS,
    );
    assert.match(
      rendered,
      /```sh\ncdxgen -t dart --install-deps -o bom\.json\n```/,
    );
    assert.match(
      rendered,
      /```bat\ncdxgen -t dart --install-deps -o bom\.json\n```/,
    );
  });

  it("names the exclude patterns of the scan in the re-scan command", () => {
    const { reflection, scored } = loadFixture("foreign-bom");
    const rendered = renderIntrospectionMarkdown(reflection, scored, {
      ...GOLDEN_OPTIONS,
      exclude: ["test/**", "**/{docs,ci}/**"],
      excludeType: ["github"],
    });
    assert.match(
      rendered,
      /cdxgen -t dart --install-deps --exclude-type "github" --exclude "test\/\*\*" --exclude "\*\*\/\{docs,ci\}\/\*\*" -o bom\.json/,
    );
    const reproduce = rendered.slice(rendered.indexOf("## Reproduce"));
    assert.match(reproduce, /--exclude "test\/\*\*"/);
  });

  it("escapes backslashes and shell characters in an exclude pattern", () => {
    const { reflection, scored } = loadFixture("foreign-bom");
    const rendered = renderIntrospectionMarkdown(reflection, scored, {
      ...GOLDEN_OPTIONS,
      exclude: ["dir\\", 'a"$`b'],
    });
    assert.ok(rendered.includes('--exclude "dir\\\\"'));
    assert.ok(rendered.includes('--exclude "a\\"\\$\\`b"'));
  });

  it("warns that images which could not be pulled are outside the verdict", () => {
    const { reflection, scored } = loadFixture("foreign-bom");
    const withLostImage = {
      ...reflection,
      observations: [
        ...(reflection.observations || []),
        {
          kind: "evidence.degraded",
          ecosystem: "container",
          tool: "docker",
          impact: "components",
          detail:
            "The image alpine:3.20 named by the manifest could not be pulled.",
        },
      ],
    };
    const rendered = renderIntrospectionMarkdown(
      withLostImage,
      scored,
      GOLDEN_OPTIONS,
    );
    assert.match(
      rendered,
      /1 container image\(s\) named by the scanned manifests could not be pulled/,
    );
    assert.doesNotMatch(
      renderIntrospectionMarkdown(reflection, scored, GOLDEN_OPTIONS),
      /container image\(s\)/,
    );
  });

  it("reports the no-ledger audit with its warning above the findings", () => {
    const { reflection, scored } = loadFixture("foreign-bom");
    const rendered = renderIntrospectionMarkdown(
      reflection,
      scored,
      GOLDEN_OPTIONS,
    );
    const warningsAt = rendered.indexOf("## Warnings about this report");
    const findingsAt = rendered.indexOf("## What to fix");
    assert.ok(warningsAt >= 0, "the no-ledger warning must render");
    assert.ok(warningsAt < findingsAt, "warnings sit above the findings");
    assert.match(rendered, /No build ledger was available/);
  });

  it("moves blocked remediations into their own subsection with the reason", () => {
    const { reflection } = loadFixture("degraded-jvm");
    const scored = scoreReflection(reflection, catalog, { secureMode: true });
    const rendered = renderIntrospectionMarkdown(
      reflection,
      scored,
      GOLDEN_OPTIONS,
    );
    // The network-needing ledger entry blocks; the rule-derived entries keep
    // their place in the ranking.
    const whatAt = rendered.indexOf("## What to fix");
    const blockedAt = rendered.indexOf(
      "## Cannot be fixed from this environment",
    );
    assert.ok(whatAt >= 0, "unblocked rule entries stay actionable");
    assert.ok(blockedAt > whatAt, "blocked entries move below the ranking");
    const blockedSlice = rendered.slice(blockedAt);
    assert.match(blockedSlice, /Maven build failed/);
    assert.match(blockedSlice, /- Blocked: .*network access/);
    assert.match(blockedSlice, /expected overall gain: \+55\.00/);
  });

  it("renders unsupported ecosystems as cdxgen backlog, not reader fault", () => {
    const reflection = {
      ledgerSource: "sidecar",
      ledgerComplete: true,
      ledgerEventCount: 0,
      projectTypes: ["r"],
      projectPath: "",
      ecosystems: [
        {
          ecosystem: "r",
          state: "unsupported",
          tier: null,
          ceilingTier: null,
          tierReasons: [
            { source: "disk", id: "unsupported-ecosystem", determining: true },
          ],
          componentCount: 0,
          dependencyEdgeCount: 0,
          markersOnDisk: [join("somewhere", "DESCRIPTION")],
          toolsExpected: [],
          toolsResolved: [],
          toolsMissing: [],
          toolsMismatched: [],
          degradations: [],
          findings: [],
        },
      ],
      observations: [],
      globalFindings: [],
    };
    const scored = scoreReflection(reflection, catalog, {});
    const rendered = renderIntrospectionMarkdown(
      reflection,
      scored,
      GOLDEN_OPTIONS,
    );
    assert.match(rendered, /## cdxgen coverage gaps/);
    assert.match(rendered, /belongs on cdxgen's backlog/);
    assert.match(rendered, /not a problem with your project/);
    assert.match(rendered, /DESCRIPTION/);
    // No score row and no remediation section for the gap.
    assert.doesNotMatch(rendered, /\| r \|/);
    assert.equal(rendered.includes("## What to fix"), false);
  });
});

describe("markdown determinism", () => {
  it("renders the same reflection twice byte-identically", () => {
    const { reflection, scored } = loadFixture("degraded-jvm");
    assert.equal(
      renderIntrospectionMarkdown(reflection, scored, GOLDEN_OPTIONS),
      renderIntrospectionMarkdown(reflection, scored, GOLDEN_OPTIONS),
    );
  });

  it("renders shuffled inputs to the same bytes", () => {
    for (const name of FIXTURE_NAMES) {
      const { reflection, scored } = loadFixture(name);
      const baseline = renderIntrospectionMarkdown(
        reflection,
        scored,
        GOLDEN_OPTIONS,
      );
      for (const seed of [1, 7, 97]) {
        const shuffled = shuffledReflection(reflection, seed);
        const rendered = renderIntrospectionMarkdown(
          shuffled,
          scoreReflection(shuffled, catalog, {}),
          GOLDEN_OPTIONS,
        );
        assert.equal(rendered, baseline, `${name} moved under shuffle ${seed}`);
      }
    }
  });

  it("keeps table cells bounded with escaped pipes and an explicit ellipsis", () => {
    const { reflection } = loadFixture("degraded-jvm");
    const longMessage = `${"word ".repeat(60)}end|pipe`;
    const poisoned = {
      ...reflection,
      ecosystems: reflection.ecosystems.map((row) => ({
        ...row,
        findings: row.findings.map((finding) => ({
          ...finding,
          message: longMessage,
        })),
        toolsExpected: [
          ...row.toolsExpected,
          { tool: "a|b".repeat(40), wanted: "1|2", source: "s|s" },
        ],
      })),
    };
    const scored = scoreReflection(poisoned, catalog, {});
    const rendered = renderIntrospectionMarkdown(
      poisoned,
      scored,
      GOLDEN_OPTIONS,
    );
    const tableLines = rendered
      .split("\n")
      .filter((line) => line.startsWith("|"));
    assert.ok(tableLines.length > 2, "the tables rendered");
    for (const line of tableLines) {
      assert.ok(
        line.length <= 300,
        `a table line grew to ${line.length} characters: ${line.slice(0, 80)}`,
      );
    }
    assert.ok(rendered.includes("\\|"), "pipes inside cells are escaped");
    assert.ok(
      rendered.includes("…"),
      "long values end with the ellipsis marker",
    );
    const fences = rendered
      .split("\n")
      .filter((line) => line.startsWith("```"));
    assert.equal(
      fences.length % 2,
      0,
      "the fenced blocks stay balanced under hostile input",
    );
  });

  it("renders a sub-hundredth gain with the projection instead of dropping it", () => {
    const reflection = {
      ledgerSource: "sidecar",
      ledgerComplete: true,
      ledgerEventCount: 0,
      projectTypes: [],
      projectPath: "",
      ecosystems: [
        gradedRow("npm", 200000),
        {
          ...gradedRow("java", 1),
          findings: [
            {
              ruleId: "BF-JVM-001",
              message: "no maven graph",
              severity: "high",
              tierSignal: "manifest",
            },
          ],
        },
      ],
      observations: [],
      globalFindings: [],
    };
    const scored = scoreReflection(reflection, catalog, {});
    const entry = scored.remediations.find(
      (candidate) => candidate.ecosystem === "java",
    );
    assert.ok(entry, "the tiny ecosystem keeps its remediation");
    assert.equal(entry.expectedGain, 0);
    const rendered = renderIntrospectionMarkdown(
      reflection,
      scored,
      GOLDEN_OPTIONS,
    );
    assert.match(rendered, /no maven graph/);
    assert.match(rendered, /expected overall gain: \+0\.00/);
    assert.match(rendered, /55 → 85/);
  });
});

describe("markdown redaction", () => {
  it("never copies poisoned free text into the report", () => {
    const { reflection } = loadFixture("degraded-jvm");
    const poisoned = {
      ...reflection,
      observations: [
        {
          kind: "evidence.degraded",
          ecosystem: "java",
          detail:
            "fetch failed for https://user:hunter2@example.com/path?token=abc1234 and ghp_Abcdefghijklmnopqrstuvwxyz123456",
        },
      ],
      ecosystems: reflection.ecosystems.map((row) => ({
        ...row,
        findings: row.findings.map((finding) => ({
          ...finding,
          message: `${finding.message} bearer sk_live_abcdef1234567890`,
        })),
      })),
    };
    const scored = scoreReflection(poisoned, catalog, {});
    const rendered = renderIntrospectionMarkdown(
      poisoned,
      scored,
      GOLDEN_OPTIONS,
    );
    for (const secret of [
      "hunter2",
      "token=abc1234",
      "ghp_Abcdefghij",
      "sk_live_abcdef",
    ]) {
      assert.equal(
        rendered.includes(secret),
        false,
        `the markdown leaked ${secret}`,
      );
    }
  });

  it("never copies a poisoned evidence block into the markdown either", () => {
    const { reflection } = loadFixture("degraded-jvm");
    const poisoned = {
      ...reflection,
      ecosystems: reflection.ecosystems.map((row) => ({
        ...row,
        degradations: row.degradations.map((degradation) => ({
          ...degradation,
          command: "mvn deploy --registry-token hunter2secrettoken",
          outputExcerpt: [
            "[ERROR] Failed to execute goal",
            "Authorization: Basic dXNlcjpodW50ZXIy",
            "PGPASSWORD=hunter2",
            "token d7a8fbb307d78fbaa3bd0aa1b2c3d4e5f",
            "use ~/sandbox/secret-project for the local build",
          ].join("\n"),
        })),
      })),
    };
    const rendered = renderIntrospectionMarkdown(
      poisoned,
      scoreReflection(poisoned, catalog, {}),
      GOLDEN_OPTIONS,
    );
    for (const secret of [
      "hunter2",
      "dXNlcjpodW50ZXIy",
      "d7a8fbb307d78fbaa3bd0aa1b2c3d4e5f",
    ]) {
      assert.equal(
        rendered.includes(secret),
        false,
        `the markdown evidence leaked ${secret}`,
      );
    }
    // The excerpt itself must still be present: redaction degrades one
    // entry, it does not remove it.
    assert.match(rendered, /Failed command output/);
    assert.match(rendered, /\[ERROR\] Failed to execute goal/);
  });
});

describe("json renderer", () => {
  for (const name of FIXTURE_NAMES) {
    it(`builds ${name} identically to its golden`, () => {
      const { reflection, scored } = loadFixture(name);
      const document = buildIntrospectionJson(
        reflection,
        scored,
        GOLDEN_OPTIONS,
      );
      const golden = readFileSync(
        join(repoRoot, "test", "data", "introspection", `${name}.golden.json`),
        "utf-8",
      );
      assert.equal(`${JSON.stringify(document, null, 2)}\n`, golden);
    });
  }

  it("is byte-stable across calls and under shuffled inputs", () => {
    const { reflection, scored } = loadFixture("degraded-jvm");
    const first = JSON.stringify(
      buildIntrospectionJson(reflection, scored, GOLDEN_OPTIONS),
    );
    assert.equal(
      JSON.stringify(
        buildIntrospectionJson(reflection, scored, GOLDEN_OPTIONS),
      ),
      first,
    );
    for (const seed of [3, 42]) {
      const shuffled = shuffledReflection(reflection, seed);
      assert.equal(
        JSON.stringify(
          buildIntrospectionJson(
            shuffled,
            scoreReflection(shuffled, catalog, {}),
            GOLDEN_OPTIONS,
          ),
        ),
        first,
        `the json moved under shuffle ${seed}`,
      );
    }
  });

  it("stamps the schema version and derives the overall labels from the rows", () => {
    const { reflection, scored } = loadFixture("degraded-jvm");
    const document = buildIntrospectionJson(reflection, scored, GOLDEN_OPTIONS);
    assert.equal(document.schemaVersion, INTROSPECTION_REPORT_SCHEMA_VERSION);
    assert.equal(document.schemaVersion, "1.1");
    assert.equal(document.overall.score, scored.overallScore);
    assert.equal(document.overall.tier, "manifest");
    assert.equal(document.overall.confidence, "high");
    assert.match(document.inputsFingerprint, /^sha256:[0-9a-f]{64}$/);
    assert.equal(document.ledger.source, "sidecar");
    assert.equal(document.ledger.complete, true);
    assert.equal(document.ledger.truncated, false);
    assert.equal(typeof document.ledger.eventCount, "number");
  });

  it("publishes the worst row's tier and confidence, not the average", () => {
    // Confidence is recomputed by the scorer from each row's tier reasons, so
    // the rows earn their labels through their evidence sources: the go row's
    // verdict rests on rule+ledger corroboration, the ruby row on disk alone.
    const reflection = {
      ledgerSource: "sidecar",
      ledgerComplete: true,
      ecosystems: [
        {
          ...gradedRow("go", 50),
          tier: "resolved",
          state: "at-ceiling",
          tierReasons: [
            { source: "rule", id: "BF-GEN-001", determining: false },
            {
              source: "ledger",
              id: "jvm.maven.manifest-fallback",
              determining: false,
            },
            {
              source: "bom",
              id: "no-demoting-signal",
              determining: true,
            },
          ],
        },
        {
          ...gradedRow("ruby", 2),
          tierReasons: [{ source: "disk", id: "markers", determining: true }],
        },
      ],
      observations: [],
    };
    const document = buildIntrospectionJson(
      reflection,
      scoreReflection(reflection, catalog, {}),
      {},
    );
    assert.equal(document.overall.tier, "manifest");
    assert.equal(document.overall.confidence, "low");
  });

  it("carries the bom facts and the gate only when the caller knows them", () => {
    const { reflection, scored } = loadFixture("degraded-jvm");
    const withBom = {
      ...reflection,
      bom: { serialNumber: "urn:uuid:1234", componentCount: 3 },
    };
    const document = buildIntrospectionJson(withBom, scored, {
      output: "out/bom.json",
      introspectFailBelow: 70,
    });
    assert.deepEqual(document.bom, {
      serialNumber: "urn:uuid:1234",
      componentCount: 3,
      path: "out/bom.json",
    });
    assert.deepEqual(document.gate, { threshold: 70, passed: false });
    const passing = buildIntrospectionJson(withBom, scored, {
      introspectFailBelow: 40,
    });
    assert.equal(passing.gate.passed, true);
    assert.equal(passing.bom.path, undefined);
    const ungated = buildIntrospectionJson(withBom, scored, {});
    assert.equal(ungated.gate, undefined);
  });

  it("reports an incomplete ledger as truncated", () => {
    const { reflection, scored } = loadFixture("degraded-jvm");
    const document = buildIntrospectionJson(
      { ...reflection, ledgerComplete: false },
      scored,
      {},
    );
    assert.equal(document.ledger.complete, false);
    assert.equal(document.ledger.truncated, true);
  });

  it("renders a reflection with zero ecosystems without throwing", () => {
    const reflection = {
      ledgerSource: "none",
      ledgerComplete: true,
      ecosystems: [],
      observations: [],
    };
    const scored = scoreReflection(reflection, catalog, {});
    const document = buildIntrospectionJson(reflection, scored, {});
    assert.equal(document.overall.tier, null);
    assert.equal(document.overall.confidence, null);
    assert.deepEqual(document.ecosystems, []);
    assert.ok(renderIntrospectionMarkdown(reflection, scored, {}));
    assert.ok(renderIntrospectionConsole(scored, {}));
  });

  it("carries shapedBy on the actions and into both renderers", () => {
    const { reflection } = loadFixture("degraded-jvm");
    const scored = scoreReflection(reflection, catalog, {
      commandFacts: { wrappers: { mvnw: true } },
    });
    const document = buildIntrospectionJson(reflection, scored, {});
    const shaped = document.remediation
      .flatMap((entry) => entry.actions || [])
      .find((action) => action.shapedBy);
    assert.ok(shaped, "no action carried shapedBy");
    assert.equal(shaped.command.split(" ").slice(0, 1)[0], "./mvnw");
    const markdown = renderIntrospectionMarkdown(reflection, scored, {});
    assert.match(markdown, /shaped for this project \(wrapper:\.\/mvnw\)/);
  });

  it("never copies poisoned free text into the document", () => {
    const { reflection } = loadFixture("degraded-jvm");
    const poisoned = {
      ...reflection,
      observations: [
        {
          kind: "evidence.degraded",
          ecosystem: "java",
          detail:
            "fetch failed for https://user:hunter2@example.com/path?token=abc1234",
        },
      ],
    };
    const scored = scoreReflection(poisoned, catalog, {});
    const serialized = JSON.stringify(
      buildIntrospectionJson(poisoned, scored, {}),
    );
    for (const secret of ["hunter2", "token=abc1234"]) {
      assert.equal(
        serialized.includes(secret),
        false,
        `the json leaked ${secret}`,
      );
    }
  });

  it("keeps remediation records in the ranked order the scoring produced", () => {
    const { reflection, scored } = loadFixture("degraded-jvm");
    const document = buildIntrospectionJson(reflection, scored, {});
    assert.deepEqual(
      document.remediation.map((entry) => entry.remediationId),
      scored.remediations.map((entry) => entry.remediationId),
    );
    assert.deepEqual(
      document.remediation[0].actions.map((action) => action.kind),
      scored.remediations[0].actions.map((action) => action.kind),
    );
  });

  it("publishes the evidence block with absent fields omitted", () => {
    const { reflection } = loadFixture("degraded-jvm");
    const poisoned = {
      ...reflection,
      ecosystems: reflection.ecosystems.map((row) => ({
        ...row,
        degradations: row.degradations.map((degradation) => ({
          ...degradation,
          command: "mvn -B dependency:tree -s settings.xml",
          exitCode: 1,
          causeDetail: "the resolver could not reach the repository",
          outputExcerpt:
            "[ERROR] Failed to execute goal … Could not resolve dependencies\n[ERROR] …",
        })),
      })),
    };
    const document = buildIntrospectionJson(
      poisoned,
      scoreReflection(poisoned, catalog, {}),
      {},
    );
    const entry = document.remediation.find(
      (candidate) => candidate.source === "ledger",
    );
    assert.ok(entry, "a ledger-derived entry exists");
    assert.deepEqual(entry.evidence, {
      failedCommand: "mvn -B dependency:tree -s settings.xml",
      exitCode: 1,
      cause: "the resolver could not reach the repository",
      outputExcerpt:
        "[ERROR] Failed to execute goal … Could not resolve dependencies\n[ERROR] …",
    });
    // Rule-derived entries carry no failure facts, so they carry no block.
    const ruleEntry = document.remediation.find(
      (candidate) => candidate.source === "rule",
    );
    assert.equal(ruleEntry?.evidence, undefined);
    assert.equal(
      JSON.stringify(ruleEntry).includes('"evidence"'),
      false,
      "an absent evidence block must be omitted, not null",
    );
  });

  it("omits the evidence fields a run did not record", () => {
    const { reflection } = loadFixture("degraded-jvm");
    // The committed fixture predates the failure facts: its degradations
    // carry a detail only, so cause falls back to detail and the other
    // fields are absent from the block.
    const document = buildIntrospectionJson(
      reflection,
      scoreReflection(reflection, catalog, {}),
      {},
    );
    const entry = document.remediation.find(
      (candidate) => candidate.source === "ledger",
    );
    assert.deepEqual(entry.evidence, {
      cause:
        "Maven build failed; the dependency tree fell back to the pom.xml declarations.",
    });
  });

  it("redacts the evidence block in the json report", () => {
    const { reflection } = loadFixture("degraded-jvm");
    const poisoned = {
      ...reflection,
      ecosystems: reflection.ecosystems.map((row) => ({
        ...row,
        degradations: row.degradations.map((degradation) => ({
          ...degradation,
          command: "mvn deploy --password hunter2 -Dtoken=abc123def",
          outputExcerpt:
            "Authorization: Bearer abcdef1234567890abcdef1234 and https://user:hunter2@example.com/p",
        })),
      })),
    };
    const serialized = JSON.stringify(
      buildIntrospectionJson(
        poisoned,
        scoreReflection(poisoned, catalog, {}),
        {},
      ),
    );
    for (const secret of [
      "hunter2",
      "abc123def",
      "abcdef1234567890",
      "user:@",
    ]) {
      assert.equal(
        serialized.includes(secret),
        false,
        `the json evidence leaked ${secret}`,
      );
    }
  });

  it("redacts a versionSource derived from a poisoned mismatch diagnosis", () => {
    const { reflection } = loadFixture("degraded-jvm");
    const poisoned = {
      ...reflection,
      ecosystems: reflection.ecosystems.map((row) => ({
        ...row,
        toolsMismatched: (row.toolsMismatched || []).concat([
          {
            tool: "java",
            wanted: "21",
            found: "17",
            source: "invocation",
            detail:
              "gradle refused JVM 17 and named 21; token=abc123defgh and https://user:hunter2@example.com/",
          },
        ]),
      })),
    };
    const scored = scoreReflection(poisoned, catalog, {});
    const serialized = JSON.stringify(
      buildIntrospectionJson(poisoned, scored, {}),
    );
    for (const secret of ["abc123defgh", "hunter2", "user:"]) {
      assert.equal(
        serialized.includes(secret),
        false,
        `the json versionSource leaked ${secret}`,
      );
    }
    // The field itself must still flow, redacted rather than dropped.
    assert.match(serialized, /"versionSource": ?"[^"]*\[redacted\]/);
    const rendered = renderIntrospectionMarkdown(
      poisoned,
      scored,
      GOLDEN_OPTIONS,
    );
    for (const secret of ["abc123defgh", "hunter2"]) {
      assert.equal(
        rendered.includes(secret),
        false,
        `the markdown versionSource leaked ${secret}`,
      );
    }
  });
});

describe("report 1.0 backward compatibility", () => {
  const captured = JSON.parse(
    readFileSync(
      join(
        repoRoot,
        "test",
        "data",
        "introspection",
        "degraded-jvm.report-1.0.json",
      ),
      "utf-8",
    ),
  );

  it("a captured 1.0 report still parses and carries the fields the loop reads", () => {
    assert.equal(captured.schemaVersion, "1.0");
    for (const field of [
      "overall",
      "ecosystems",
      "remediation",
      "observations",
      "coverageGaps",
      "ledger",
    ]) {
      assert.ok(
        Object.hasOwn(captured, field),
        `the 1.0 report lacks "${field}"`,
      );
    }
  });

  it("a captured 1.0 report yields the same loop decision as its 1.1 rendering", () => {
    const { reflection } = loadFixture("degraded-jvm");
    const modern = buildIntrospectionJson(
      reflection,
      scoreReflection(reflection, catalog, {}),
      {},
    );
    // The loop's next candidate is the first unblocked entry of
    // remediation[], and the stalled check keys on overall and the
    // fingerprint; both documents must answer identically.
    const candidateOf = (report) => {
      const entry = (report.remediation || []).find(
        (candidate) => candidate.blocked !== true,
      );
      return {
        id: entry?.remediationId,
        score: report.overall?.score,
        tier: report.overall?.tier,
        complete: report.ledger?.complete !== false,
      };
    };
    assert.deepEqual(candidateOf(captured), candidateOf(modern));
    assert.equal(candidateOf(captured).id, "jvm.maven.manifest-fallback");
  });
});

describe("console renderer", () => {
  it("summarises the verdict, the counts and the report paths in a few lines", () => {
    const { scored } = loadFixture("degraded-jvm");
    const summary = renderIntrospectionConsole(scored, {
      introspectReport: "bom.introspection.md",
      introspectJson: "bom.introspection.json",
    });
    const lines = summary.split("\n").filter(Boolean);
    assert.ok(lines.length <= 6, `the summary grew to ${lines.length} lines`);
    assert.match(
      lines[0],
      /Build introspection: overall manifest \(45\/100\), confidence high/,
    );
    assert.match(summary, /2 remediation\(s\) ranked/);
    assert.match(summary, /bom\.introspection\.md/);
    assert.match(summary, /bom\.introspection\.json/);
    assert.equal(summary.endsWith("\n"), true);
    // A table in six terminal lines would wrap and corrupt; the summary is prose.
    assert.equal(summary.includes("│"), false);
  });

  it("counts blocked entries and coverage gaps", () => {
    const { reflection } = loadFixture("degraded-jvm");
    const blocked = {
      ...reflection,
      ecosystems: [
        ...reflection.ecosystems,
        {
          ecosystem: "r",
          state: "unsupported",
          tier: null,
          ceilingTier: null,
          tierReasons: [
            { source: "disk", id: "unsupported-ecosystem", determining: true },
          ],
          componentCount: 0,
          dependencyEdgeCount: 0,
          markersOnDisk: [],
          toolsExpected: [],
          toolsResolved: [],
          toolsMissing: [],
          toolsMismatched: [],
          degradations: [],
          findings: [],
        },
      ],
    };
    const scored = scoreReflection(blocked, catalog, { secureMode: true });
    const summary = renderIntrospectionConsole(scored, {});
    assert.match(
      summary,
      /2 remediation\(s\) ranked, 1 blocked, 1 coverage gap\(s\)/,
    );
  });
});

describe("overall assessment derivation", () => {
  it("is null for a reflection with no scored rows", () => {
    assert.deepEqual(overallAssessment({ ecosystems: [] }), {
      tier: null,
      confidence: null,
    });
    assert.deepEqual(overallAssessment({}), { tier: null, confidence: null });
  });
});
