/**
 * Tests for the build-fidelity rule pack (`data/rules/build-fidelity.yaml`).
 *
 * The pack is the BOM-side evidence source for the `--introspect` reflection
 * step. Every rule must have a fixture BOM that makes it fire and one that
 * leaves it silent, the pack must stay silent on the repository's golden SBOMs
 * of well-formed projects, and the category must never activate on a default
 * `--bom-audit` run.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { assert, describe, it } from "poku";

import { DEFAULT_AUDIT_CATEGORIES } from "../../../audit/index.js";
import { OPT_IN_BOM_AUDIT_CATEGORIES } from "../../../inventory/auditCategories.js";
import { auditBom } from "../auditBom.js";
import { evaluateRule, evaluateRules, loadRules } from "../ruleEngine.js";
import {
  findRuntimeToolMismatch,
  readFormulationEvidence,
} from "./formulationEvidence.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const RULES_DIR = join(__dirname, "..", "..", "..", "..", "data", "rules");
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
const GOLDEN_ROOT = join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "test",
  "repotests",
);

const FIDELITY_TIERS = [
  "resolved",
  "lockfile",
  "manifest",
  "heuristic",
  "absent",
];

// Rules about BOM structure itself (lifecycle claims, empty component sets)
// are gated by their condition instead of a purl-type scope. The formulation
// rules belong here too: they are gated on the formulation's origin and the
// parent component's purl type, not on any component query in the condition.
const STRUCTURE_RULES = new Set([
  "BF-GEN-005",
  "BF-GEN-006",
  "BF-FORM-001",
  "BF-FORM-002",
]);

// A rule's scope is whichever purl types its condition gates on. Component-type
// exclusions such as the container check and the non-purl type list share the
// `$arrayContains` shape, so each pattern below requires a purl-derived second
// argument rather than matching every array literal.
//
// Multi-ecosystem: `$arrayContains(['maven', 'npm'], $substringBefore($substringAfter(purl, …)))`.
const ARRAY_GATE_PATTERN =
  /\$arrayContains\(\s*\[([^\]]+)\]\s*,\s*\$substringBefore\(\$substringAfter\(purl/g;
// The same gate applied to a variable already reduced to purl types.
const TYPE_LIST_GATE_PATTERN =
  /\$types\[\$arrayContains\(\s*\[([^\]]+)\]\s*,\s*\$\)\]/g;
// Single-ecosystem: `$substringBefore($substringAfter(purl, 'pkg:'), '/') = 'maven'`.
const EQUALITY_GATE_PATTERN =
  /\$substringBefore\(\$substringAfter\(purl, 'pkg:'\), '\/'\)\s*=\s*'([^']+)'/g;
// A rule keyed on an ecosystem-specific property is scoped by that property's
// namespace, as with `cdx:npm:isWorkspace`.
const PROPERTY_GATE_PATTERN = /'cdx:([a-z0-9]+):[^']+'/g;

// Full expected finding-id set per firing fixture. A degraded BOM legitimately
// trips more than one rule (BF-GEN-001 is the umbrella coverage signal that
// co-fires whenever a scoped rule's fixture has uncovered components), so each
// entry names every finding the fixture is allowed to produce.
const EXPECTED_FIRING_FINDINGS = {
  "BF-GEN-001.fires": ["BF-GEN-001"],
  "BF-GEN-002.fires": ["BF-GEN-002"],
  "BF-GEN-003.fires": ["BF-GEN-003"],
  "BF-GEN-004.fires": ["BF-GEN-004", "BF-JS-001"],
  "BF-GEN-005.fires": ["BF-GEN-005"],
  "BF-GEN-006.fires": ["BF-GEN-006"],
  "BF-GEN-007.fires": ["BF-GEN-007"],
  "BF-JVM-001.fires": ["BF-JVM-001", "BF-GEN-001"],
  "BF-JVM-002.fires": ["BF-JVM-002", "BF-GEN-001"],
  "BF-JVM-003.fires": ["BF-JVM-003", "BF-JVM-001", "BF-GEN-001"],
  "BF-JVM-004.fires": ["BF-JVM-004"],
  "BF-JS-001.fires": ["BF-JS-001"],
  "BF-JS-002.fires": ["BF-JS-002"],
  "BF-JS-003.fires": ["BF-JS-003"],
  "BF-PY-001.fires": ["BF-PY-001", "BF-GEN-001"],
  "BF-PY-002.fires": ["BF-PY-002", "BF-PY-001", "BF-GEN-001"],
  "BF-PY-003.fires": ["BF-PY-003"],
  "BF-GO-001.fires": ["BF-GO-001", "BF-GEN-007"],
  "BF-RB-001.fires": ["BF-RB-001", "BF-GEN-007"],
  "BF-RS-001.fires": ["BF-RS-001", "BF-GEN-007"],
  "BF-CS-001.fires": ["BF-CS-001", "BF-GEN-007"],
  "BF-SWIFT-001.fires": ["BF-SWIFT-001"],
  "BF-FORM-001.fires": ["BF-FORM-001", "BF-JVM-001", "BF-GEN-001"],
  "BF-FORM-002.fires": ["BF-FORM-002"],
};

// Goldens of well-formed projects must produce zero build-fidelity findings.
// The exceptions below carry committed, real degradations or ceiling shapes:
// - dotnet-assembly-refs and maven-smoke explain themselves in the table;
// - pubspec-smoke is the measured spotube degradation (344 components, one
//   dependency node), the exact case BF-GEN-001 exists for;
// - python-smoke (requirements.txt) and pipenv-smoke (Pipfile.lock) hold
//   package lists with no dependency graph, which is BF-GEN-001/BF-PY-001
//   territory (pipenv additionally records no provenance at all, BF-PY-002);
// - swift-smoke is the Package.resolved ceiling shape that BF-SWIFT-001
//   reports for the reflection step to classify as at-ceiling.
const ALLOWED_GOLDEN_FINDINGS = {
  // The fixture is a .NET project that pins almost nothing: assembly references
  // and a version range, with no restore output to resolve them from. Most of
  // its components genuinely have no version, and saying so is the point of the
  // fixture - see #4359.
  "dotnet-assembly-refs/expected/default.json": ["BF-GEN-002"],
  // The default maven-smoke scenario runs with installDeps: false, and since
  // #4527 that skips Maven entirely: only the pom's direct dependencies are
  // captured, without a dependency graph, which is the pom fallback shape
  // these two rules describe. The with-maven scenario resolves the full tree
  // and fires neither.
  "maven-smoke/expected/default.json": ["BF-GEN-001", "BF-JVM-001"],
  "pipenv-smoke/expected/default.json": [
    "BF-GEN-001",
    "BF-PY-001",
    "BF-PY-002",
  ],
  "pubspec-smoke/expected/default.json": ["BF-GEN-001"],
  // The fixture's requirements.txt pins flask with flask>=2.0.0, and since
  // #4717 a range requirement leaves the component version-less. One of the
  // BOM's three components then carries no version, which is past the 20%
  // threshold of both rules, so BF-GEN-002 and BF-PY-003 truthfully describe
  // it; the missing dependency graph stays the job of BF-GEN-001 and
  // BF-PY-001.
  "python-smoke/expected/default.json": [
    "BF-GEN-001",
    "BF-PY-001",
    "BF-GEN-002",
    "BF-PY-003",
  ],
  "swift-smoke/expected/default.json": ["BF-SWIFT-001"],
};

function listGoldenBoms() {
  const goldens = [];
  for (const entry of readdirSync(GOLDEN_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const expectedDir = join(GOLDEN_ROOT, entry.name, "expected");
    let files = [];
    try {
      files = readdirSync(expectedDir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (file.endsWith(".json")) {
        goldens.push(`${entry.name}/expected/${file}`);
      }
    }
  }
  return goldens.sort();
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const allRules = await loadRules(RULES_DIR);
const fidelityRules = allRules.filter(
  (rule) => rule.category === "build-fidelity",
);
const fidelityRuleIds = fidelityRules.map((rule) => rule.id).sort();
const expectedRuleIds = Object.keys(EXPECTED_FIRING_FINDINGS)
  .map((fixtureName) => fixtureName.replace(/\.fires$/, ""))
  .sort();

async function evaluateFidelity(bomJson, options = {}) {
  const findings = await evaluateRules(fidelityRules, bomJson, options);
  return findings.map((finding) => finding.ruleId);
}

// The formulation rules gate on the origin verdict the reflection computes,
// so their fixtures are evaluated the way the reflection evaluates a BOM:
// the marker names another run, the ledger observed nothing, and the runtime
// facts are the ones each fixture's formulation records as this scan's own —
// pinned per fixture, so the toolchain-mismatch rule fires exactly where the
// fixture intends it. A standalone rule evaluation passes no such context,
// which is exactly why the goldens below stay silent.
const FIXTURE_RUNTIMES = {
  "BF-FORM-001": { name: "Node.js", version: "26.7.0" },
  "BF-FORM-002": { name: "Node.js", version: "22.0.0" },
};

async function evaluateFidelityAsReScan(bomJson, fixtureName) {
  const evidence = readFormulationEvidence(bomJson, {
    runId: "test-run",
    ledgerEventCount: 0,
  });
  return evaluateFidelity(bomJson, {
    formulationEvidence: {
      origin: evidence.origin,
      runtimeMismatch: findRuntimeToolMismatch(
        evidence,
        FIXTURE_RUNTIMES[fixtureName] || {
          name: "Node.js",
          version: globalThis.process?.versions?.node || "0.0.0-test",
        },
      ),
    },
  });
}

describe("build-fidelity rule pack", () => {
  it("loads the full documented rule set", () => {
    assert.equal(fidelityRuleIds.length, expectedRuleIds.length);
    assert.deepEqual(fidelityRuleIds, expectedRuleIds);
    const uniqueIds = new Set(fidelityRuleIds);
    assert.equal(uniqueIds.size, fidelityRuleIds.length);
  });

  it("declares tier-signal, full dry-run support, and ecosystem scope", () => {
    for (const rule of fidelityRules) {
      assert.ok(
        FIDELITY_TIERS.includes(rule["tier-signal"]),
        `${rule.id} has unknown tier-signal ${rule["tier-signal"]}`,
      );
      assert.equal(
        rule.dryRunSupport,
        "full",
        `${rule.id} must read BOM structure only`,
      );
      assert.ok(rule.mitigation, `${rule.id} needs a remediation hint`);
      if (!STRUCTURE_RULES.has(rule.id)) {
        assert.ok(
          Array.isArray(rule["applies-to"]) && rule["applies-to"].length > 0,
          `${rule.id} must declare applies-to so resolver-less ecosystems stay silent`,
        );
      }
    }
  });

  it("declares an applies-to matching the purl types its condition gates on", () => {
    // The engine never reads `applies-to`; the scope a rule actually enforces
    // lives in its condition, and `applies-to` is what humans and Deliverable
    // 05 read. Comparing the two keeps the documented scope honest.
    for (const rule of fidelityRules) {
      if (STRUCTURE_RULES.has(rule.id)) {
        continue;
      }
      const gated = new Set();
      for (const pattern of [ARRAY_GATE_PATTERN, TYPE_LIST_GATE_PATTERN]) {
        for (const [, list] of rule.condition.matchAll(pattern)) {
          for (const token of list.split(",")) {
            const purlType = token.trim().replaceAll("'", "");
            if (purlType) {
              gated.add(purlType);
            }
          }
        }
      }
      for (const [, purlType] of rule.condition.matchAll(
        EQUALITY_GATE_PATTERN,
      )) {
        gated.add(purlType);
      }
      if (!gated.size) {
        for (const [, namespace] of rule.condition.matchAll(
          PROPERTY_GATE_PATTERN,
        )) {
          gated.add(namespace);
        }
      }
      assert.ok(
        gated.size,
        `${rule.id}: no purl-type or property gate found in the condition, so applies-to cannot be enforced`,
      );
      assert.deepEqual(
        [...gated].sort(),
        [...rule["applies-to"]].sort(),
        `${rule.id}: applies-to and the purl types its condition gates on have diverged`,
      );
    }
  });

  it("has a firing and a passing fixture for every rule", () => {
    const onDisk = new Set(readdirSync(FIXTURE_DIR));
    const missing = [];
    for (const ruleId of fidelityRuleIds) {
      if (!onDisk.has(`${ruleId}.fires.json`)) {
        missing.push(`${ruleId}.fires.json`);
      }
      if (!onDisk.has(`${ruleId}.passes.json`)) {
        missing.push(`${ruleId}.passes.json`);
      }
    }
    if (missing.length) {
      throw new Error(
        `Missing build-fidelity fixtures (add them to test/data/fidelity-boms/): ${missing.join(", ")}`,
      );
    }
    for (const file of onDisk) {
      if (!file.endsWith(".fires.json") && !file.endsWith(".passes.json")) {
        continue;
      }
      const base = file.replace(/\.json$/, "");
      assert.ok(
        fidelityRuleIds.includes(base.split(".")[0]),
        `Fixture ${file} has no matching rule`,
      );
    }
  });

  for (const [fixtureName, expectedFindings] of Object.entries(
    EXPECTED_FIRING_FINDINGS,
  )) {
    it(`fixture ${fixtureName} produces exactly its expected findings`, async () => {
      const bomJson = readJson(join(FIXTURE_DIR, `${fixtureName}.json`));
      const fired = fixtureName.startsWith("BF-FORM-")
        ? await evaluateFidelityAsReScan(
            bomJson,
            fixtureName.replace(/\.fires$/, ""),
          )
        : await evaluateFidelity(bomJson);
      const uniqueFired = [...new Set(fired)].sort();
      assert.deepEqual(
        uniqueFired,
        [...expectedFindings].sort(),
        `${fixtureName} fired ${uniqueFired.join(", ") || "nothing"}`,
      );
    });
  }

  for (const ruleId of fidelityRuleIds) {
    it(`fixture ${ruleId}.passes produces no build-fidelity findings`, async () => {
      const bomJson = readJson(join(FIXTURE_DIR, `${ruleId}.passes.json`));
      const fired = ruleId.startsWith("BF-FORM-")
        ? await evaluateFidelityAsReScan(bomJson, ruleId)
        : await evaluateFidelity(bomJson);
      assert.deepEqual(
        fired,
        [],
        `${ruleId}.passes.json fired ${[...new Set(fired)].join(", ")}`,
      );
    });
  }

  describe("golden SBOM false-positive gate", () => {
    for (const golden of listGoldenBoms()) {
      it(`stays within the allowed findings for ${golden}`, async () => {
        const bomJson = readJson(join(GOLDEN_ROOT, golden));
        const fired = [...new Set(await evaluateFidelity(bomJson))].sort();
        const allowed = ALLOWED_GOLDEN_FINDINGS[golden] || [];
        const unexpected = fired.filter((id) => !allowed.includes(id));
        assert.deepEqual(
          unexpected,
          [],
          unexpected.length
            ? `${golden} fired undocumented findings: ${unexpected.join(", ")}. If this degradation is real, document it in ALLOWED_GOLDEN_FINDINGS with the reason; otherwise fix the rule.`
            : undefined,
        );
        for (const id of allowed) {
          assert.ok(
            fired.includes(id),
            `${golden} was expected to fire ${id} but did not; the golden changed or the rule broke`,
          );
        }
      });
    }
  });

  describe("category activation", () => {
    const crossActivationFixture = join(FIXTURE_DIR, "BF-GEN-001.fires.json");

    it("keeps build-fidelity out of the default audit categories", () => {
      assert.ok(
        !DEFAULT_AUDIT_CATEGORIES.includes("build-fidelity"),
        "build-fidelity must never become a default audit category",
      );
      assert.ok(
        OPT_IN_BOM_AUDIT_CATEGORIES.includes("build-fidelity"),
        "build-fidelity must stay listed as an opt-in-only category",
      );
    });

    it("never activates the pack on a default --bom-audit run", async () => {
      const findings = await auditBom(readJson(crossActivationFixture), {});
      const fidelityFindings = findings.filter((finding) =>
        finding.ruleId?.startsWith("BF-"),
      );
      assert.equal(
        fidelityFindings.length,
        0,
        `a default audit activated ${fidelityFindings.map((f) => f.ruleId).join(", ")}`,
      );
    });

    it("activates the pack when build-fidelity is explicitly requested", async () => {
      const findings = await auditBom(readJson(crossActivationFixture), {
        bomAuditCategories: "build-fidelity",
      });
      const fidelityFindings = findings.filter((finding) =>
        finding.ruleId?.startsWith("BF-"),
      );
      assert.ok(fidelityFindings.length > 0);
      assert.ok(
        fidelityFindings.some((finding) => finding.ruleId === "BF-GEN-001"),
      );
    });
  });

  it("evaluates each rule standalone without surprising matches", async () => {
    for (const rule of fidelityRules) {
      const findings = await evaluateRule(
        rule,
        readJson(join(FIXTURE_DIR, `${rule.id}.passes.json`)),
      );
      assert.equal(
        findings.length,
        0,
        `${rule.id} fired on its own passing fixture`,
      );
    }
  });
});
