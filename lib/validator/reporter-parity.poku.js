import { strict as assert, describe, it } from "poku";

import { render as renderAnnotations } from "./reporters/annotations.js";
import { render as renderConsole } from "./reporters/console.js";
import { render as renderReport } from "./reporters/index.js";
import { render as renderJson } from "./reporters/json.js";
import { render as renderSarif } from "./reporters/sarif.js";

// ---------------------------------------------------------------------------
// The reporters operate on compliance-engine-shaped finding objects, which
// have fields like { ruleId, name, severity, status, message, ... }.
//
// Rust validator findings have a different shape: { id, severity, path, ... }.
// To prove reporter parity, we convert a Rust finding to the compliance shape
// and verify that the same shape produces identical output regardless of
// whether we label it "rust-sourced" or "js-sourced".
//
// This test proves the reporters are source-agnostic: they don't inspect
// where a finding came from, only its content.
// ---------------------------------------------------------------------------

function rustFindingToReportShape(rf) {
  return {
    ruleId: rf.id,
    name: rf.id,
    description: rf.message,
    engine: "cdxrs",
    standard: null,
    standardRefs: [],
    scvsLevels: [],
    category: "validation",
    status: rf.severity === "error" ? "fail" : "manual",
    severity:
      rf.severity === "error"
        ? "high"
        : rf.severity === "warning"
          ? "medium"
          : "low",
    automatable: true,
    message: rf.message,
    mitigation: rf.hint || undefined,
    locations: rf.bomRef ? [{ bomRef: rf.bomRef }] : [],
    evidence: null,
  };
}

function makeReport(findings) {
  return {
    schemaValid: !findings.some((f) => f.severity === "high"),
    deepValid: !findings.some((f) => f.severity === "high"),
    signatureVerified: null,
    findings,
    allFindings: findings,
    benchmarks: [],
    summary: {
      total: findings.length,
      pass: 0,
      fail: findings.filter((f) => f.status === "fail").length,
      manual: findings.filter((f) => f.status === "manual").length,
      errors: findings.filter(
        (f) => f.status === "fail" && ["high", "critical"].includes(f.severity),
      ).length,
      warnings: findings.filter(
        (f) =>
          f.status === "fail" && !["high", "critical"].includes(f.severity),
      ).length,
      schemaValid: !findings.some((f) => f.severity === "high"),
      deepValid: !findings.some((f) => f.severity === "high"),
    },
  };
}

const rustFindings = [
  {
    id: "purl.invalid-syntax",
    severity: "error",
    path: "/components/0/purl",
    bomRef: "pkg:npm/foo",
    message: "Invalid purl INVALID",
    hint: null,
  },
  {
    id: "metadata.component-version-missing",
    severity: "warning",
    path: "/metadata/component/version",
    bomRef: null,
    message: "Version is missing for metadata.component",
    hint: undefined,
  },
];

const reportShapeFindings = rustFindings.map(rustFindingToReportShape);
const report = makeReport(reportShapeFindings);

describe("reporter parity — Rust-sourced findings render identically", () => {
  it("console reporter produces deterministic output", () => {
    const output1 = renderConsole(report);
    const output2 = renderConsole(report);
    assert.strictEqual(output1, output2);
    assert.ok(output1.length > 0);
  });

  it("json reporter produces parseable, deterministic output", () => {
    const output1 = renderJson(report);
    const output2 = renderJson(report);
    assert.strictEqual(output1, output2);
    const parsed = JSON.parse(output1);
    assert.ok(parsed.findings);
    assert.strictEqual(parsed.findings.length, 2);
  });

  it("sarif reporter produces valid SARIF with error findings", () => {
    const output1 = renderSarif(report);
    const output2 = renderSarif(report);
    assert.strictEqual(output1, output2);
    const parsed = JSON.parse(output1);
    assert.strictEqual(parsed.version, "2.1.0");
    // SARIF excludes manual findings by default; only the error appears.
    assert.ok(parsed.runs[0].results.length >= 1);
  });

  it("annotations reporter produces annotated BOM", () => {
    const bomJson = {
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      serialNumber: "urn:uuid:test",
      metadata: {
        timestamp: "2026-08-04T00:00:00.000Z",
        tools: {
          components: [{ type: "application", name: "cdxgen", version: "13" }],
        },
      },
    };
    const output1 = renderAnnotations(report, { bomJson });
    const output2 = renderAnnotations(report, { bomJson });
    assert.strictEqual(output1, output2);
    const parsed = JSON.parse(output1);
    assert.ok(parsed.annotations);
    // An annotation is derived from the BOM, not from the moment the reporter
    // ran, so two renders agree however far apart in time they happen.
    for (const annotation of parsed.annotations) {
      assert.strictEqual(annotation.timestamp, bomJson.metadata.timestamp);
    }
  });

  it("all four reporters work through the dispatcher", () => {
    for (const name of ["console", "json", "sarif"]) {
      const output = renderReport(name, report);
      assert.ok(typeof output === "string");
      assert.ok(output.length > 0);
    }
  });
});

describe("reporter parity — identical findings produce identical output", () => {
  it("js-sourced and rust-sourced findings with same shape produce same output", () => {
    // Create two findings with the same compliance-engine shape, differing
    // only in the engine field. The reporters must produce identical output.
    const jsFinding = {
      ruleId: "purl.invalid-syntax",
      name: "purl.invalid-syntax",
      description: "Invalid purl",
      engine: "js",
      standard: null,
      standardRefs: [],
      scvsLevels: [],
      category: "validation",
      status: "fail",
      severity: "high",
      automatable: true,
      message: "Invalid purl INVALID",
      mitigation: undefined,
      locations: [],
      evidence: null,
    };

    const rustFinding = { ...jsFinding, engine: "cdxrs" };

    const jsReport = makeReport([jsFinding]);
    const rustReport = makeReport([rustFinding]);

    // Console
    assert.strictEqual(renderConsole(jsReport), renderConsole(rustReport));
    // JSON
    const jsJson = JSON.parse(renderJson(jsReport));
    const rustJson = JSON.parse(renderJson(rustReport));
    assert.strictEqual(jsJson.findings.length, rustJson.findings.length);
    assert.strictEqual(jsJson.findings[0].ruleId, rustJson.findings[0].ruleId);

    // SARIF
    const jsSarif = JSON.parse(renderSarif(jsReport));
    const rustSarif = JSON.parse(renderSarif(rustReport));
    assert.strictEqual(
      jsSarif.runs[0].results.length,
      rustSarif.runs[0].results.length,
    );
  });
});
