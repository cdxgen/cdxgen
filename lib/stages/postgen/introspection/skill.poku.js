/**
 * Tests for the sbom-fidelity-loop skill documentation: the frontmatter
 * triggers a model matches on, the embedded JSON examples, and the report
 * field references.
 *
 * Documentation that drifts from the schema is worse than none, so the JSON
 * blocks in the skill are validated two ways. Report-shaped blocks are
 * compared field-for-field against reports real binaries just wrote: a
 * degraded Maven `bin/cdxgen.js` run (the same shape the skill's worked
 * example shows) for the same-run fields, and a `bin/audit.js`
 * `--direct-bom-audit --introspect` re-scan of a committed-shape foreign BOM
 * for the fields that exist only on the foreign path (`attemptedCommand`,
 * `attemptedCommandSource`, formulation-sourced tool records) — a same-run
 * report never carries those. The flags used in the skill's commands are
 * checked against the CLI's own help output. The history-file example is
 * validated against the shape the skill documents directly, since the agent,
 * not cdxgen, writes that file — including the rule that an inferred entry
 * without its evidence quote is malformed.
 *
 * This file spawns the node CLI directly, so it is held back from the Bun and
 * Deno suites (see contrib/alt-runtime-tests.js).
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir as osTmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { assert, describe, it } from "poku";

import {
  buildIntrospectionJson,
  renderIntrospectionConsole,
} from "./report.js";
import { scoreReflection, TIER_LADDER } from "./score.js";

const repoRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);
const skillDir = join(repoRoot, ".agents", "skills", "sbom-fidelity-loop");

const SKILL_PATH = join(skillDir, "SKILL.md");
const SCHEMA_DOC_PATH = join(skillDir, "reference", "report-schema.md");
const ACTIONS_DOC_PATH = join(skillDir, "reference", "remediation-actions.md");

/** Trigger phrases the plan requires the frontmatter description to name. */
const REQUIRED_TRIGGERS = [
  "improving SBOM accuracy",
  "missing transitive dependencies",
  "build tool setup for SBOM generation",
  "cdxgen fidelity report",
  "--introspect",
];

/** The outcome vocabulary the history file's attempted entries may carry. */
const HISTORY_OUTCOMES = new Set(["verified", "no-change", "failed"]);

/**
 * Check one `attempted` entry against the shape SKILL.md documents, and
 * return the violations. This is the documentation's own validator, kept
 * next to the example it describes: a catalog-driven attempt needs the
 * plain fields, an `inferred: true` attempt additionally needs the
 * `inferred:` id prefix and an evidence block whose `quote` names the fact
 * the action rests on — a quote-less inferred entry is malformed by the
 * skill's own rule. A `1.0` file's entries predate the fingerprint and
 * inferred fields, so only the plain fields apply there.
 *
 * @param {Object} attempt One `history.attempted` entry.
 * @param {string} schemaVersion The history file's schema version.
 * @returns {string[]} Human-readable violations; empty when the entry is valid.
 */
function historyProblems(attempt, schemaVersion) {
  const problems = [];
  for (const key of ["remediationId", "at", "actions", "outcome"]) {
    if (!Object.hasOwn(attempt, key)) {
      problems.push(`attempted entry lacks "${key}"`);
    }
  }
  if (schemaVersion !== "1.0" && !Object.hasOwn(attempt, "inputsFingerprint")) {
    problems.push('attempted entry lacks "inputsFingerprint"');
  }
  if (
    Object.hasOwn(attempt, "outcome") &&
    !HISTORY_OUTCOMES.has(attempt.outcome)
  ) {
    problems.push(`outcome "${attempt.outcome}" is not a documented outcome`);
  }
  if (attempt.inferred === true) {
    if (!`${attempt.remediationId}`.startsWith("inferred:")) {
      problems.push(
        "an inferred entry's remediationId lacks the inferred: prefix",
      );
    }
    const quote = attempt.evidence?.quote;
    if (typeof quote !== "string" || !quote.trim()) {
      problems.push("an inferred entry without an evidence.quote is malformed");
    }
    if (typeof attempt.evidence?.from !== "string" || !attempt.evidence.from) {
      problems.push('an inferred entry\'s evidence block lacks "from"');
    }
  }
  return problems;
}

/**
 * Extract the "What this loop can and cannot do" section of SKILL.md, whose
 * coverage statements are checked against the remediation catalog.
 *
 * @param {string} content SKILL.md content.
 * @returns {string|undefined} The section body, or undefined when missing.
 */
function coverageSection(content) {
  const match =
    /## What this loop can and cannot do\r?\n([\s\S]*?)(?=\n## )/.exec(content);
  return match?.[1];
}

/**
 * Read a documentation file.
 *
 * @param {string} filePath Path of the file.
 * @returns {string} File content.
 */
function readDoc(filePath) {
  assert.ok(existsSync(filePath), `missing skill file: ${filePath}`);
  return readFileSync(filePath, "utf-8");
}

/**
 * Extract the YAML frontmatter object of a skill file. The skill files use
 * one-line `name` and `description` fields, so a line parse is sufficient.
 *
 * @param {string} content File content.
 * @returns {Object} Parsed frontmatter fields.
 */
function parseFrontmatter(content) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  assert.ok(match, "skill file has no YAML frontmatter");
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([a-z]+):\s*(.*)$/.exec(line);
    if (field) {
      fields[field[1]] = field[2];
    }
  }
  return fields;
}

/**
 * Extract fenced code blocks of the given languages from a document.
 *
 * @param {string} content Document content.
 * @param {string[]} languages Fence info strings to collect.
 * @returns {string[]} Block bodies in document order.
 */
function codeBlocks(content, languages) {
  const blocks = [];
  for (const match of content.matchAll(/```([a-z]*)\r?\n([\s\S]*?)```/g)) {
    if (languages.includes(match[1])) {
      blocks.push(match[2]);
    }
  }
  return blocks;
}

/**
 * Parse every fenced JSON block of a document.
 *
 * @param {string} filePath Document path, for assertion messages.
 * @param {string} content Document content.
 * @returns {Object[]} Parsed JSON documents.
 */
function jsonBlocks(filePath, content) {
  return codeBlocks(content, ["json"]).map((block, index) => {
    try {
      return JSON.parse(block);
    } catch (error) {
      assert.ok(
        false,
        `${filePath} json block #${index + 1} does not parse: ${error.message}`,
      );
      return undefined;
    }
  });
}

/**
 * The key set of a value, or null for non-plain-object values.
 *
 * @param {Object} value Value to inspect.
 * @returns {string[]|null} Keys of a plain object, else null.
 */
function keysOf(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value)
    : null;
}

/**
 * Assert that every key an example object carries also exists on the real
 * object. Arrays are compared through their first elements when both sides
 * have one.
 *
 * @param {Object} example Example object from the documentation.
 * @param {Object} real Real object from a generated report.
 * @param {string} where Human-readable location for assertion messages.
 * @returns {void}
 */
function assertKeysCovered(example, real, where) {
  const exampleKeys = keysOf(example);
  if (!exampleKeys) {
    return;
  }
  assert.ok(keysOf(real), `${where}: report section missing entirely`);
  for (const key of exampleKeys) {
    assert.ok(
      Object.hasOwn(real, key),
      `${where}: documented field "${key}" does not exist in the real report`,
    );
    if (
      Array.isArray(example[key]) &&
      example[key].length &&
      Array.isArray(real[key]) &&
      real[key].length
    ) {
      assertKeysCovered(example[key][0], real[key][0], `${where}.${key}[]`);
    } else if (keysOf(example[key]) && keysOf(real[key])) {
      assertKeysCovered(example[key], real[key], `${where}.${key}`);
    }
  }
}

/**
 * Write a small single-pom maven project fixture, the degraded shape the
 * skill's worked example describes.
 *
 * @param {string} dir Destination directory.
 * @returns {void}
 */
function writeMavenFixture(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "pom.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>sbom-fidelity-skill-fixture</artifactId>
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
  // The fixture pins java but not maven, so the real report's install
  // actions carry both resolution states the reference documents: a pin
  // file answer with its versionSource, and an explicit unresolved answer
  // with versionSourceMissing.
  writeFileSync(join(dir, ".java-version"), "21\n");
}

/**
 * Write a stand-in maven command that fails the way a build with an
 * unreachable registry does: real `[ERROR]` output on the stream, exit
 * status 1. The degraded run then exercises the evidence block a report
 * carries — command, exit code and bounded output excerpt — instead of the
 * command-absent shape a nonexistent binary produces.
 *
 * @param {string} dir Destination directory.
 * @returns {string} Path of the stand-in command.
 */
function writeFailingMavenStub(dir) {
  const isWindows = process.platform === "win32";
  const stubPath = join(dir, isWindows ? "failing-mvn.cmd" : "failing-mvn.sh");
  if (isWindows) {
    writeFileSync(
      stubPath,
      // Both spellings put the failure on stderr. cdxgen reads *stdout* for
      // the resolver's own "Could not resolve dependencies" wording and
      // ranks jvm.maven.build-first on it, so a stub that echoed to stdout
      // would exercise a different entry on Windows than on posix.
      // The redirect leads each line: `echo text 1>&2` would put the digit
      // next to the text and echo a trailing space with it.
      "@echo off\r\n>&2 echo [ERROR] Failed to execute goal org.apache.maven.plugins:maven-dependency-plugin:3.6.1:tree on project sbom-fidelity-skill-fixture: Could not resolve dependencies for project com.example:sbom-fidelity-skill-fixture:jar:1.0.0\r\n>&2 echo [ERROR] Could not transfer artifact org.apache:x:y from/to central\r\nexit /b 1\r\n",
    );
  } else {
    writeFileSync(
      stubPath,
      `#!/bin/sh
echo "[ERROR] Failed to execute goal org.apache.maven.plugins:maven-dependency-plugin:3.6.1:tree on project sbom-fidelity-skill-fixture: Could not resolve dependencies for project com.example:sbom-fidelity-skill-fixture:jar:1.0.0" >&2
echo "[ERROR] Could not transfer artifact org.apache:x:y from/to central" >&2
exit 1
`,
    );
    chmodSync(stubPath, 0o755);
  }
  return stubPath;
}

/**
 * Run the skill's loop command against a degraded maven fixture and return
 * the result with the report the run wrote.
 *
 * @returns {Object} Spawn result, the temp dir, the report paths and the parsed report.
 */
function runLoopCommand() {
  const tmpDir = mkdtempSync(join(osTmpdir(), "cdxgen-skill-test-"));
  const fixtureDir = join(tmpDir, "maven-fixture");
  writeMavenFixture(fixtureDir);
  const failingMaven = writeFailingMavenStub(tmpDir);
  const reportPath = join(tmpDir, "report.md");
  const jsonPath = join(tmpDir, "report.json");
  const env = { ...process.env };
  // An empty-string variable reads as an explicit opt-out, so the baseline is
  // a genuinely unset environment and the profile alone switches the feature
  // on, exactly as the skill's loop command does.
  delete env.CDXGEN_INTROSPECT;
  delete env.CDXGEN_INTROSPECT_LEDGER;
  const result = spawnSync(
    process.execPath,
    [
      join(repoRoot, "bin", "cdxgen.js"),
      "--profile",
      "introspect",
      "--introspect-fail-below",
      "70",
      "-t",
      "java",
      "--no-install-deps",
      "-o",
      join(tmpDir, "bom.json"),
      "--introspect-report",
      reportPath,
      "--introspect-json",
      jsonPath,
      fixtureDir,
    ],
    {
      env: {
        ...env,
        MVN_CMD: failingMaven,
      },
      encoding: "utf-8",
    },
  );
  return {
    tmpDir,
    result,
    reportPath,
    jsonPath,
    report: existsSync(jsonPath)
      ? JSON.parse(readFileSync(jsonPath, "utf-8"))
      : undefined,
  };
}

const e2e = runLoopCommand();

/**
 * Write a small foreign BOM fixture: maven components with no dependency
 * edges, and a formulation section whose CI workflows declare maven resolver
 * commands and whose platform components record a java 21 toolchain. Every
 * finding this fixture earns (BF-FORM-001, BF-GEN-001, BF-JVM-001) is
 * BOM-structure-only, so the re-scan is machine-independent; the runtime
 * mismatch finding may or may not join it, which the assertions do not
 * depend on.
 *
 * @param {string} dir Destination directory.
 * @returns {string} Path of the fixture BOM.
 */
function writeForeignBomFixture(dir) {
  mkdirSync(dir, { recursive: true });
  const bom = {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: "urn:uuid:12345678-1234-5678-1234-567812345678",
    version: 1,
    metadata: {
      tools: [{ vendor: "cyclonedx", name: "cdxgen", version: "13.0.1" }],
      component: {
        type: "application",
        "bom-ref": "pkg:maven/com.example/demo@1.0.0",
        name: "demo",
        version: "1.0.0",
        purl: "pkg:maven/com.example/demo@1.0.0",
      },
    },
    components: [
      {
        type: "library",
        "bom-ref": "pkg:maven/org.apache.commons/commons-lang3@3.14.0",
        name: "org.apache.commons:commons-lang3",
        version: "3.14.0",
        purl: "pkg:maven/org.apache.commons/commons-lang3@3.14.0",
      },
      {
        type: "library",
        "bom-ref": "pkg:maven/junit/junit@4.13.2",
        name: "junit:junit",
        version: "4.13.2",
        purl: "pkg:maven/junit/junit@4.13.2",
      },
    ],
    formulation: [
      {
        "bom-ref": "form-skill-fixture",
        components: [
          {
            type: "platform",
            "bom-ref": "plat-java",
            name: "java",
            version: "21.0.1",
          },
          {
            type: "platform",
            "bom-ref": "plat-maven",
            name: "maven",
            version: "3.9.9",
          },
        ],
        workflows: [
          {
            "bom-ref": "wf-ci",
            name: "ci",
            tasks: [
              {
                "bom-ref": "task-build",
                name: "build",
                taskTypes: ["build"],
                steps: [
                  {
                    name: "Resolve dependency tree",
                    commands: [
                      {
                        executed:
                          "mvn -B dependency:tree -DoutputFile=/tmp/dependency-tree.txt",
                      },
                    ],
                  },
                  {
                    name: "Build",
                    commands: [{ executed: "mvn -B package -DskipTests" }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  const bomPath = join(dir, "foreign-skill.bom.json");
  writeFileSync(bomPath, JSON.stringify(bom, null, 2));
  return bomPath;
}

/**
 * Re-scan the foreign fixture through the real `cdx-audit` path and return
 * the introspection verdict embedded in the audit report.
 *
 * @returns {Object} Spawn result, the temp dir and the parsed introspection report.
 */
function runForeignAudit() {
  const tmpDir = mkdtempSync(join(osTmpdir(), "cdxgen-skill-foreign-"));
  const bomPath = writeForeignBomFixture(tmpDir);
  const auditReportPath = join(tmpDir, "audit-report.json");
  const result = spawnSync(
    process.execPath,
    [
      join(repoRoot, "bin", "audit.js"),
      "--bom",
      bomPath,
      "--direct-bom-audit",
      "--introspect",
      "--report",
      "json",
      "--report-file",
      auditReportPath,
    ],
    { encoding: "utf-8" },
  );
  const auditReport = existsSync(auditReportPath)
    ? JSON.parse(readFileSync(auditReportPath, "utf-8"))
    : undefined;
  return {
    tmpDir,
    result,
    report: auditReport?.results?.find((entry) => entry?.introspection)
      ?.introspection,
  };
}

const foreign = runForeignAudit();

process.on("exit", () => {
  rmSync(e2e.tmpDir, { recursive: true, force: true });
  rmSync(foreign.tmpDir, { recursive: true, force: true });
});

const skillDoc = readDoc(SKILL_PATH);
const schemaDoc = readDoc(SCHEMA_DOC_PATH);
const actionsDoc = readDoc(ACTIONS_DOC_PATH);

describe("skill frontmatter", () => {
  const frontmatter = parseFrontmatter(skillDoc);

  it("declares the skill name", () => {
    assert.strictEqual(frontmatter.name, "sbom-fidelity-loop");
  });

  it("names every trigger phrase the plan requires", () => {
    for (const trigger of REQUIRED_TRIGGERS) {
      assert.ok(
        frontmatter.description?.includes(trigger),
        `frontmatter description is missing the trigger "${trigger}"`,
      );
    }
  });

  it("links both reference files", () => {
    assert.ok(skillDoc.includes("reference/report-schema.md"));
    assert.ok(skillDoc.includes("reference/remediation-actions.md"));
  });
});

describe("skill commands use real CLI flags", () => {
  const help = spawnSync(
    process.execPath,
    [join(repoRoot, "bin", "cdxgen.js"), "--help"],
    { encoding: "utf-8" },
  );
  const helpText = `${help.stdout}\n${help.stderr}`;
  // Docker's own flags appear in container action prose; every other long
  // flag used in the skill's shell blocks must be one cdxgen accepts.
  const foreignFlags = new Set(["rm"]);
  const used = new Set();
  for (const content of [
    ...codeBlocks(skillDoc, ["sh", "text"]),
    ...codeBlocks(schemaDoc, ["sh", "bat", "text"]),
    ...codeBlocks(actionsDoc, ["sh", "bat", "text"]),
  ]) {
    for (const match of content.matchAll(/--([a-z][a-z0-9-]*)/g)) {
      if (!foreignFlags.has(match[1])) {
        used.add(match[1]);
      }
    }
  }

  it("uses only flags the CLI accepts", () => {
    assert.ok(used.size > 0, "no flags found in the skill's shell blocks");
    for (const flag of used) {
      const negated = flag.startsWith("no-") ? flag.slice(3) : flag;
      assert.ok(
        helpText.includes(`--${flag}`) || helpText.includes(`--${negated}`),
        `flag --${flag} used by the skill is not accepted by cdxgen`,
      );
    }
  });
});

describe("skill JSON examples against a real generated report", () => {
  it("the loop command on a degraded maven fixture exits 4 with reports written", () => {
    assert.strictEqual(
      e2e.result.status,
      4,
      `expected gate exit 4, got ${e2e.result.status}: ${e2e.result.stderr}`,
    );
    assert.ok(e2e.report, "the --introspect-json report was not written");
    assert.ok(
      existsSync(e2e.reportPath),
      "the --introspect-report markdown was not written",
    );
    assert.ok(
      e2e.result.stderr.includes(
        "is below the --introspect-fail-below threshold",
      ),
      "the gate message is missing from the run output",
    );
    assert.strictEqual(e2e.report.schemaVersion, "1.1");
    assert.strictEqual(e2e.report.ledger.complete, true);
    assert.deepEqual(e2e.report.gate, { threshold: 70, passed: false });
    // The degraded run failed a real command with output, so the top entry
    // must carry the evidence block the schema reference documents.
    const evidence = e2e.report.remediation[0].evidence;
    assert.ok(evidence, "the top remediation carries no evidence block");
    assert.match(evidence.failedCommand, /mvn/);
    assert.equal(evidence.exitCode, 1);
    assert.match(evidence.outputExcerpt, /\[ERROR\]/);
    assert.ok(evidence.cause);
    // The fixture pins java in .java-version but names no maven version, so
    // the two install actions carry the two resolution states the reference
    // documents: a pin-file answer with its versionSource, and the explicit
    // unresolved answer the loop branches on instead of string-matching
    // "{{" in the command.
    const actions = e2e.report.remediation[0].actions;
    const javaInstall = actions.find(
      (action) => action.kind === "install" && action.tool === "java",
    );
    assert.ok(
      javaInstall,
      "the top remediation carries no java install action",
    );
    assert.equal(javaInstall.versionFrom, "pin");
    assert.equal(javaInstall.versionSource, "pinned in .java-version");
    assert.equal(javaInstall.versionSourceMissing, undefined);
    assert.equal(javaInstall.command, "sdk install java 21");
    const mavenInstall = actions.find(
      (action) => action.kind === "install" && action.tool === "maven",
    );
    assert.ok(
      mavenInstall,
      "the top remediation carries no maven install action",
    );
    assert.equal(mavenInstall.versionFrom, "unresolved");
    assert.equal(mavenInstall.versionSourceMissing, true);
    assert.equal(mavenInstall.versionSource, undefined);
    assert.match(mavenInstall.command, /\{\{version\}\}/);
  });

  it("the report skeleton in report-schema.md matches the real report", () => {
    const skeleton = jsonBlocks(SCHEMA_DOC_PATH, schemaDoc).find(
      (block) => block.schemaVersion && block.overall,
    );
    assert.ok(skeleton, "report-schema.md has no report skeleton block");
    assertKeysCovered(skeleton, e2e.report, "report skeleton");
  });

  it("the ecosystem row example matches a real row", () => {
    const example = jsonBlocks(SCHEMA_DOC_PATH, schemaDoc).find(
      (block) => block.ecosystem && block.tools && block.tierReasons,
    );
    assert.ok(example, "report-schema.md has no ecosystem row example");
    const realRow = e2e.report.ecosystems?.[0];
    assert.ok(realRow, "the real report has no ecosystem rows");
    assertKeysCovered(example, realRow, "ecosystem row");
    assert.deepEqual(
      Object.keys(example.tools).sort(),
      Object.keys(realRow.tools).sort(),
    );
  });

  it("the remediation entry examples match the top-ranked real entry", () => {
    assert.ok(
      e2e.report.remediation?.length,
      "the real report ranked no remediations",
    );
    const realTop = e2e.report.remediation[0];
    assert.strictEqual(
      realTop.remediationId,
      "jvm.maven.manifest-fallback",
      "the fixture no longer reproduces the worked example's top remediation",
    );
    const examples = [
      ...jsonBlocks(SCHEMA_DOC_PATH, schemaDoc),
      ...jsonBlocks(ACTIONS_DOC_PATH, actionsDoc),
    ].filter((block) => block.remediationId);
    assert.ok(examples.length >= 2, "the remediation examples went missing");
    // Action shapes come from the catalog plus whatever this run produced:
    // a degraded maven run exercises install/build/rerun, while container
    // and env actions only appear in other ecosystems' entries.
    const catalog = JSON.parse(
      readFileSync(join(repoRoot, "data", "remediations.json"), "utf-8"),
    );
    const realActionShapes = new Set(
      [
        ...e2e.report.remediation.flatMap((entry) => entry.actions || []),
        ...Object.values(catalog).flatMap((entry) => entry.actions || []),
      ].map((action) => Object.keys(action).sort().join("+")),
    );
    for (const example of examples) {
      // Excerpts may trim actions, so only the entry's own keys are compared
      // here; the actions are validated by shape below.
      for (const key of Object.keys(example)) {
        assert.ok(
          Object.hasOwn(realTop, key),
          `remediation ${example.remediationId}: documented field "${key}" does not exist in the real report`,
        );
      }
      for (const action of example.actions || []) {
        const shape = Object.keys(action).sort().join("+");
        assert.ok(
          realActionShapes.has(shape),
          `documented action shape {${shape}} does not exist in the catalog or the real report's actions`,
        );
      }
    }
  });

  it("report fields named in SKILL.md prose exist in a real report", () => {
    const references = new Set();
    for (const match of skillDoc.matchAll(
      /(?<![/\w])report\.[a-zA-Z][a-zA-Z0-9.]*/g,
    )) {
      references.add(match[0]);
    }
    assert.ok(references.size > 0, "SKILL.md names no report fields");
    for (const reference of references) {
      // A field is documented when either real report carries it: the
      // degraded Maven run stands for the same-run path, the audit re-scan
      // for the foreign path, whose findings exist only there.
      const resolvesOn = (report) => {
        let node = report;
        for (const part of reference.split(".").slice(1)) {
          if (node && typeof node === "object" && Object.hasOwn(node, part)) {
            node = node[part];
          } else {
            return false;
          }
        }
        return true;
      };
      assert.ok(
        resolvesOn(e2e.report) || resolvesOn(foreign.report),
        `SKILL.md references "${reference}" but neither the same-run nor the foreign report carries it`,
      );
    }
  });

  it("the foreign-only fields the skill names exist only on the foreign report", () => {
    assert.ok(foreign.report, "the audit re-scan produced no verdict");
    assert.strictEqual(foreign.report.schemaVersion, "1.1");
    const formEntry = (foreign.report.remediation || []).find(
      (entry) => entry.remediationId === "BF-FORM-001",
    );
    assert.ok(
      formEntry,
      "the foreign fixture no longer earns BF-FORM-001 (no dependency edges with declared resolver commands)",
    );
    // Declared, never observed: the entry names the CI command and its
    // source, and carries none of the observation fields a ledger-derived
    // entry would.
    assert.equal(
      formEntry.evidence?.attemptedCommand,
      "mvn -B dependency:tree -DoutputFile=/tmp/dependency-tree.txt",
    );
    assert.equal(formEntry.evidence?.attemptedCommandSource, "formulation");
    assert.equal(formEntry.evidence?.failedCommand, undefined);
    assert.equal(formEntry.evidence?.exitCode, undefined);
    // The foreign path caps confidence at medium and fills the row's
    // resolved tools from the formulation's toolchain record.
    assert.ok(
      (foreign.report.remediation || []).every(
        (entry) => entry.confidence !== "high",
      ),
      "a foreign entry exceeded the documented medium confidence cap",
    );
    assert.ok(
      (foreign.report.ecosystems || []).some((row) =>
        (row.tools?.resolved || []).some(
          (tool) => tool.source === "formulation",
        ),
      ),
      "no row carries the formulation-sourced tool record the skill describes",
    );
    // The mirror image: a same-run report carries none of the declared
    // fields, so prose must never promise them there.
    for (const entry of e2e.report.remediation || []) {
      assert.equal(
        entry.evidence?.attemptedCommand,
        undefined,
        "a same-run entry carries a declared command",
      );
      assert.equal(
        entry.evidence?.attemptedCommandSource,
        undefined,
        "a same-run entry carries the formulation command source",
      );
    }
  });

  it("the history-file example matches the documented history shape", () => {
    const history = jsonBlocks(SKILL_PATH, skillDoc).find(
      (block) => block.iterations && block.attempted,
    );
    assert.ok(history, "SKILL.md has no history-file example");
    assert.strictEqual(history.schemaVersion, "1.1");
    for (const iteration of history.iterations) {
      for (const key of ["n", "score", "tier", "inputsFingerprint", "at"]) {
        assert.ok(
          Object.hasOwn(iteration, key),
          `history iteration entry lacks "${key}"`,
        );
      }
    }
    assert.ok(
      history.attempted.some((attempt) => attempt.inferred !== true),
      "the history example no longer shows a catalog-driven attempt",
    );
    assert.ok(
      history.attempted.some((attempt) => attempt.inferred === true),
      "the history example no longer shows an inferred attempt",
    );
    for (const attempt of history.attempted) {
      const problems = historyProblems(attempt, "1.1");
      assert.deepEqual(
        problems,
        [],
        `history attempt ${attempt.remediationId} violates the documented shape`,
      );
    }
  });

  it("rejects an inferred entry with no evidence.quote as malformed", () => {
    const malformed = {
      remediationId: "inferred:jvm.java-home-invalid",
      inferred: true,
      inputsFingerprint:
        "sha256:4c734642d88a9bc75b9496f2840397d14320cd3bb28a3ba14d45b00c5e3d69c6",
      evidence: { from: "observations[0].detail" },
      at: "2026-08-30T13:31:00.000Z",
      actions: ["export JAVA_HOME=/opt/jdk21"],
      outcome: "verified",
    };
    const problems = historyProblems(malformed, "1.1");
    assert.ok(
      problems.some((problem) => problem.includes("quote")),
      `a quote-less inferred entry was not rejected as malformed: ${JSON.stringify(problems)}`,
    );
  });

  it("accepts a 1.0 history file unchanged", () => {
    const legacy = {
      schemaVersion: "1.0",
      iterations: [
        {
          n: 1,
          score: 45,
          tier: "manifest",
          inputsFingerprint:
            "sha256:4c734642d88a9bc75b9496f2840397d14320cd3bb28a3ba14d45b00c5e3d69c6",
          at: "2026-08-30T13:21:11.300Z",
        },
      ],
      attempted: [
        {
          remediationId: "jvm.maven.manifest-fallback",
          at: "2026-08-30T13:25:00.000Z",
          actions: ["sdk install maven 3.9.9"],
          outcome: "verified",
          detail: "BF-JVM-001 no longer fires",
        },
      ],
    };
    assert.deepEqual(
      historyProblems(legacy.attempted[0], "1.0"),
      [],
      "a legacy catalog-driven attempt no longer validates",
    );
    // The inferred rules are additive: they constrain only entries that
    // declare themselves inferred, so the loop's reading of a 1.0 file —
    // its candidates are the unattempted catalog ids — is unchanged.
    const inferred = { ...legacy.attempted[0], inferred: true };
    assert.ok(
      historyProblems(inferred, "1.0").some((problem) =>
        problem.includes("quote"),
      ),
      "an inferred entry without a quote passes even under the legacy version",
    );
  });

  it("a 1.0 report still drives the loop to the same decision", () => {
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
    assert.equal(captured.schemaVersion, "1.0");
    // Every field the loop's pseudo-code reads must exist on the 1.0
    // document, and the candidate it names must match the 1.1 rendering of
    // the same run.
    const reflection = JSON.parse(
      readFileSync(
        join(
          repoRoot,
          "test",
          "data",
          "introspection",
          "degraded-jvm.reflection.json",
        ),
        "utf-8",
      ),
    );
    const catalog = JSON.parse(
      readFileSync(join(repoRoot, "data", "remediations.json"), "utf-8"),
    );
    const modern = buildIntrospectionJson(
      reflection,
      scoreReflection(reflection, catalog, {}),
      {},
    );
    const decisionOf = (report) => {
      const entry = (report.remediation || []).find(
        (candidate) => candidate.blocked !== true,
      );
      return {
        id: entry?.remediationId,
        score: report.overall?.score,
        tier: report.overall?.tier,
        complete: report.ledger?.complete !== false,
        fingerprint: report.inputsFingerprint,
      };
    };
    for (const report of [captured, modern]) {
      assert.ok(Object.hasOwn(report, "overall"), "1.0 report lacks overall");
      assert.ok(
        Object.hasOwn(report, "ecosystems"),
        "1.0 report lacks ecosystems",
      );
      assert.ok(
        Object.hasOwn(report, "inputsFingerprint"),
        "1.0 report lacks inputsFingerprint",
      );
    }
    assert.deepEqual(
      decisionOf(captured),
      decisionOf(modern),
      "a 1.0 report drives the loop to a different decision than its 1.1 rendering",
    );
    assert.equal(decisionOf(captured).id, "jvm.maven.manifest-fallback");
  });
});

describe("skill vocabulary matches the implementation", () => {
  it("the documented tier ladder equals TIER_LADDER in order", () => {
    const ladder =
      /`([a-z]+)`\s*>\s*`([a-z]+)`\s*>\s*`([a-z]+)`\s*>\s*`([a-z]+)`\s*>\s*`([a-z]+)`/.exec(
        schemaDoc,
      );
    assert.ok(ladder, "report-schema.md does not state the tier ladder");
    assert.deepEqual(
      ladder.slice(1),
      TIER_LADDER,
      "the documented tier ladder drifted from TIER_LADDER",
    );
  });

  it("the documented action kinds are exactly the catalog's kinds", () => {
    const catalog = JSON.parse(
      readFileSync(join(repoRoot, "data", "remediations.json"), "utf-8"),
    );
    const catalogKinds = new Set();
    for (const entry of Object.values(catalog)) {
      for (const action of entry.actions || []) {
        catalogKinds.add(action.kind);
      }
    }
    const documented = [
      "install",
      "env",
      "build",
      "config",
      "container",
      "rerun",
    ].filter((kind) => actionsDoc.includes(`\`${kind}\``));
    assert.deepEqual(
      documented.sort(),
      [...catalogKinds].sort(),
      "the documented action kinds drifted from data/remediations.json",
    );
  });

  it("the documented console summary lines are the renderer's lines", () => {
    const reflection = JSON.parse(
      readFileSync(
        join(
          repoRoot,
          "test",
          "data",
          "introspection",
          "degraded-jvm.reflection.json",
        ),
        "utf-8",
      ),
    );
    const catalog = JSON.parse(
      readFileSync(join(repoRoot, "data", "remediations.json"), "utf-8"),
    );
    const summary = renderIntrospectionConsole(
      scoreReflection(reflection, catalog, {}),
      { introspectReport: "r.md", introspectJson: "r.json" },
    );
    for (const documented of [
      "Build introspection: overall ",
      "remediation(s) ranked",
      "markdown report: r.md",
      "json report: r.json",
    ]) {
      assert.ok(
        summary.includes(documented),
        `renderer no longer produces "${documented}"`,
      );
    }
    const binSource = readFileSync(join(repoRoot, "bin", "cdxgen.js"), "utf-8");
    assert.ok(
      binSource.includes("is below the --introspect-fail-below threshold"),
      "bin/cdxgen.js no longer prints the documented gate message",
    );
  });

  it("the coverage section's entry count equals the real catalog", () => {
    const catalog = JSON.parse(
      readFileSync(join(repoRoot, "data", "remediations.json"), "utf-8"),
    );
    const section = coverageSection(skillDoc);
    assert.ok(
      section,
      "SKILL.md lost its 'What this loop can and cannot do' section",
    );
    const stated = /(\d+) entries/.exec(section);
    assert.ok(stated, "the coverage section states no entry count");
    assert.equal(
      Number(stated[1]),
      Object.keys(catalog).length,
      "the entry count the skill states drifted from data/remediations.json",
    );
  });

  it("the c/cpp zero-coverage claim matches the catalog", () => {
    const catalog = JSON.parse(
      readFileSync(join(repoRoot, "data", "remediations.json"), "utf-8"),
    );
    for (const entry of Object.values(catalog)) {
      assert.ok(
        !["c", "cpp"].includes(entry.ecosystem),
        `catalog ecosystem "${entry.ecosystem}" consistent with the zero-coverage claim`,
      );
    }
    const section = coverageSection(skillDoc);
    assert.match(
      section,
      /zero entries[\s\S]{0,200}c\/cpp|c\/cpp[\s\S]{0,200}zero entries/,
      "the coverage section no longer states the c/cpp gap plainly",
    );
  });

  it("the named rust entries exist and the scope note is stated", () => {
    const catalog = JSON.parse(
      readFileSync(join(repoRoot, "data", "remediations.json"), "utf-8"),
    );
    for (const id of ["rust.toolchain.missing", "rust.cargo-lock-missing"]) {
      assert.ok(Object.hasOwn(catalog, id), `catalog carries ${id}`);
    }
    const section = coverageSection(skillDoc);
    assert.match(
      section,
      /rust\.toolchain\.missing[\s\S]*--deep[\s\S]*--install-deps/,
      "the rust scope note no longer names the conditions that spawn cargo",
    );
  });

  it("the split keeps both absolute rules and caps the latitude", () => {
    for (const absolute of [
      "**Never modify the project to make a rule pass.**",
      "**Never weaken the measurement.**",
      "**Ask before installing.**",
      "falsifies",
      "the subject of the measurement",
      "Do not pass `--skip-*` flags",
      "--introspect-fail-below",
      // The subtler project changes, each one a shape an agent reads as
      // environment setup.
      "wrapper scripts",
      "`.java-version`, `.tool-versions`",
      "compile_commands.json",
    ]) {
      assert.ok(
        skillDoc.includes(absolute),
        `absolute rule present: ${absolute}`,
      );
    }
    // The latitude is reachable only where the loop has nothing ranked left
    // to try. Stated in the execution rule as well as the pseudo-code, so a
    // reader of either half cannot take it as licence beside a catalog fix.
    assert.match(
      skillDoc,
      /`candidates empty` branch of the loop\s+above, never alongside a ranked action/,
      "the bounded rule states it is reachable only when no candidate remains",
    );
    // The bounded rule's own constraints, each auditable in the history file.
    assert.ok(
      /at most one\s+`inferred: true` entry may exist per `inputsFingerprint`/i.test(
        skillDoc,
      ),
      "cap stated: at most one inferred entry per inputsFingerprint",
    );
    assert.match(
      skillDoc,
      /per `inputsFingerprint`\. A second guess at\s+the same inputs is churn/,
      "cap stated: a second guess at the same inputs is churn",
    );
    assert.ok(
      skillDoc.includes("No quote, no action."),
      "cap stated: no quote, no action",
    );
    assert.ok(
      skillDoc.includes(
        "**An inferred entry with no `evidence.quote` is malformed.**",
      ),
      "malformed rule stated: an inferred entry without evidence.quote",
    );
    // The weakening ban outranks the new latitude, in so many words.
    assert.match(
      skillDoc,
      /latitude above does not reach/,
      "weakening ban states the bounded latitude does not reach it",
    );
    // Declared commands stay hypotheses in the execution rules' own words.
    assert.match(
      skillDoc,
      /attemptedCommand[\s\S]{0,400}hypothesis to check/,
      "declared command stated as a hypothesis to check",
    );
  });
});

describe("the Claude Code plugin's copies of the mirrored skills", () => {
  // .agents/skills is the source of truth for the skills the plugin ships a
  // copy of. An installed plugin has no repository around it, so where the
  // source links docs/ in the repository the copy links the same page on the
  // documentation site; nothing else may differ.
  const agentsSkills = join(repoRoot, ".agents", "skills");
  const pluginSkills = join(repoRoot, "claude-plugin", "skills");
  const forPlugin = (text) =>
    text.replace(
      /\]\(\.\.\/\.\.\/\.\.\/docs\/([A-Za-z0-9_-]+)\.md\)/g,
      "](https://cdxgen.github.io/cdxgen/#/$1)",
    );
  const filesUnder = (dir, prefix = "") =>
    readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? filesUnder(dir, join(prefix, entry.name))
        : [join(prefix, entry.name)],
    );
  const mirrored = readdirSync(pluginSkills).filter((name) =>
    existsSync(join(agentsSkills, name)),
  );

  it("finds the skills the plugin mirrors", () => {
    assert.ok(mirrored.includes("sbom-fidelity-loop"), mirrored.join());
    assert.ok(mirrored.includes("bom-slimmer"), mirrored.join());
  });

  for (const name of mirrored) {
    it(`claude-plugin/skills/${name} is .agents/skills/${name} with site links`, () => {
      const sourceFiles = filesUnder(join(agentsSkills, name)).sort();
      assert.deepStrictEqual(
        filesUnder(join(pluginSkills, name)).sort(),
        sourceFiles,
      );
      for (const file of sourceFiles) {
        assert.strictEqual(
          readFileSync(join(pluginSkills, name, file), "utf-8"),
          forPlugin(readFileSync(join(agentsSkills, name, file), "utf-8")),
          `claude-plugin/skills/${name}/${file} differs from its source; copy it again from .agents/skills`,
        );
      }
    });
  }
});
