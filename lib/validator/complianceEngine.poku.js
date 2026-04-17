import { assert, describe, it } from "poku";

import {
  buildBenchmarkReports,
  evaluateAll,
  evaluateRule,
  listBenchmarks,
  resolveBenchmark,
  scoreBenchmark,
} from "./complianceEngine.js";
import { getAllComplianceRules } from "./complianceRules.js";

function richBom() {
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    serialNumber: "urn:uuid:1b671687-395b-41f5-a30f-a58921a69b79",
    metadata: {
      timestamp: "2024-02-02T00:00:00Z",
      tools: {
        components: [
          { type: "application", name: "cdxgen", version: "12.0.0" },
        ],
      },
      component: {
        name: "demo",
        version: "1.0.0",
        type: "application",
        "bom-ref": "pkg:generic/demo@1.0.0",
      },
      supplier: {
        name: "Acme",
        contact: [{ email: "psirt@example.com" }],
      },
    },
    components: [
      {
        type: "library",
        name: "lodash",
        version: "4.17.21",
        purl: "pkg:npm/lodash@4.17.21",
        "bom-ref": "pkg:npm/lodash@4.17.21",
        licenses: [{ license: { id: "MIT" } }],
        hashes: [{ alg: "SHA-256", content: "x" }],
        copyright: "© OpenJS",
      },
    ],
    dependencies: [
      { ref: "pkg:generic/demo@1.0.0", dependsOn: ["pkg:npm/lodash@4.17.21"] },
    ],
  };
}

describe("complianceEngine.resolveBenchmark/listBenchmarks", () => {
  it("resolves known aliases case-insensitively", () => {
    for (const alias of ["scvs", "scvs-l1", "SCVS-L2", "cra"]) {
      const b = resolveBenchmark(alias);
      assert.ok(b, `expected resolution for ${alias}`);
      assert.ok(typeof b.filter === "function");
    }
  });
  it("returns null for unknown aliases", () => {
    assert.strictEqual(resolveBenchmark("ntia"), null);
    assert.strictEqual(resolveBenchmark(null), null);
    assert.strictEqual(resolveBenchmark(42), null);
  });
  it("listBenchmarks exposes all aliases", () => {
    const ids = listBenchmarks().map((b) => b.id);
    assert.ok(ids.includes("scvs"));
    assert.ok(ids.includes("scvs-l1"));
    assert.ok(ids.includes("scvs-l2"));
    assert.ok(ids.includes("scvs-l3"));
    assert.ok(ids.includes("cra"));
  });
});

describe("complianceEngine.evaluateRule", () => {
  it("marks non-automatable rules as info severity regardless of status", () => {
    const rule = getAllComplianceRules().find((r) => r.automatable === false);
    const f = evaluateRule(rule, richBom());
    assert.strictEqual(f.severity, "info");
    assert.strictEqual(f.status, "manual");
    assert.strictEqual(f.automatable, false);
  });

  it("converts a throwing rule into a fail finding", () => {
    const broken = {
      id: "TEST-001",
      name: "broken",
      description: "",
      standard: "SCVS",
      standardRefs: ["TEST-001"],
      category: "x",
      severity: "high",
      scvsLevels: [],
      automatable: true,
      evaluate: () => {
        throw new Error("boom");
      },
    };
    const f = evaluateRule(broken, {});
    assert.strictEqual(f.status, "fail");
    assert.match(f.message, /boom/);
  });
});

describe("complianceEngine.evaluateAll", () => {
  it("returns one finding per rule with no filters", () => {
    const findings = evaluateAll(richBom());
    assert.strictEqual(findings.length, getAllComplianceRules().length);
  });

  it("filters by category", () => {
    const cra = evaluateAll(richBom(), { categories: ["compliance-cra"] });
    assert.ok(cra.length > 0);
    for (const f of cra) {
      assert.strictEqual(f.category, "compliance-cra");
    }
  });

  it("filters by benchmark alias", () => {
    const l1 = evaluateAll(richBom(), { benchmarks: ["scvs-l1"] });
    for (const f of l1) {
      assert.ok(f.scvsLevels.includes("L1"));
    }
    assert.ok(l1.length < getAllComplianceRules().length);
  });
});

describe("complianceEngine.scoreBenchmark", () => {
  it("computes per-benchmark pass/fail/manual totals", () => {
    const findings = evaluateAll(richBom());
    const cra = resolveBenchmark("cra");
    const report = scoreBenchmark(cra, findings);
    assert.strictEqual(report.id, "cra");
    assert.strictEqual(
      report.totalControls,
      report.pass + report.fail + report.manual,
    );
    assert.ok(report.scorePct >= 0 && report.scorePct <= 100);
    // On the rich BOM every CRA rule should pass.
    assert.strictEqual(report.fail, 0);
    assert.strictEqual(report.scorePct, 100);
  });

  it("scores 0% when all automatable rules fail", () => {
    const scvs = resolveBenchmark("scvs-l1");
    const empty = { bomFormat: "CycloneDX", specVersion: "1.6" };
    const findings = evaluateAll(empty);
    const report = scoreBenchmark(scvs, findings);
    assert.ok(report.fail > 0);
    assert.ok(report.scorePct < 100);
  });
});

describe("complianceEngine.buildBenchmarkReports", () => {
  it("returns every benchmark when none requested", () => {
    const findings = evaluateAll(richBom());
    const reports = buildBenchmarkReports(findings);
    assert.strictEqual(reports.length, listBenchmarks().length);
  });
  it("returns only requested benchmarks and skips unknown aliases", () => {
    const findings = evaluateAll(richBom());
    const reports = buildBenchmarkReports(findings, ["scvs-l1", "unknown"]);
    assert.strictEqual(reports.length, 1);
    assert.strictEqual(reports[0].id, "scvs-l1");
  });
});
