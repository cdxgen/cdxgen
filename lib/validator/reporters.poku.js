import { assert, describe, it } from "poku";

import { buildAnnotations } from "./reporters/annotations.js";
import { render } from "./reporters/index.js";

function sampleReport() {
  return {
    schemaValid: true,
    deepValid: true,
    signatureVerified: null,
    summary: {
      total: 2,
      pass: 0,
      fail: 1,
      manual: 1,
      errors: 1,
      warnings: 0,
      schemaValid: true,
      deepValid: true,
    },
    benchmarks: [
      {
        id: "scvs-l1",
        name: "OWASP SCVS Level 1",
        standard: "SCVS",
        totalControls: 2,
        pass: 0,
        fail: 1,
        manual: 1,
        automatable: 1,
        scorePct: 0,
        controls: [],
      },
    ],
    findings: [
      {
        engine: "compliance",
        ruleId: "SCVS-2.4",
        name: "SBOM is signed",
        description: "SBOM must be signed.",
        standard: "SCVS",
        standardRefs: ["SCVS-2.4"],
        scvsLevels: ["L2", "L3"],
        category: "compliance-scvs",
        status: "fail",
        severity: "high",
        automatable: true,
        message: "BOM is not signed.",
        mitigation: "Use cdx-sign.",
        locations: [{ file: "bom.json" }],
        evidence: { reason: "no-signature" },
      },
      {
        engine: "compliance",
        ruleId: "SCVS-1.5",
        name: "Manual procurement check",
        description: "Manual.",
        standard: "SCVS",
        standardRefs: ["SCVS-1.5"],
        scvsLevels: ["L2", "L3"],
        category: "compliance-scvs",
        status: "manual",
        severity: "info",
        automatable: false,
        message: "Manual review.",
        locations: [],
        evidence: null,
      },
    ],
  };
}

describe("reporter dispatcher", () => {
  it("throws for unknown reporter", () => {
    assert.throws(() => render("xml", sampleReport()), /Unknown reporter/);
  });

  it("console reporter renders a non-empty string", () => {
    const out = render("console", sampleReport());
    assert.ok(typeof out === "string");
    assert.match(out, /cdx-validate/);
    assert.match(out, /SCVS-2\.4/);
  });

  it("json reporter emits stable schema", () => {
    const out = render("json", sampleReport());
    const parsed = JSON.parse(out);
    assert.strictEqual(parsed.schemaValid, true);
    assert.strictEqual(parsed.benchmarks.length, 1);
    assert.strictEqual(parsed.findings.length, 2);
    assert.strictEqual(parsed.findings[0].ruleId, "SCVS-2.4");
  });

  it("sarif reporter emits valid 2.1.0 structure", () => {
    const out = render("sarif", sampleReport(), {
      toolName: "cdx-validate",
      toolVersion: "1.2.3",
    });
    const parsed = JSON.parse(out);
    assert.strictEqual(parsed.version, "2.1.0");
    assert.strictEqual(parsed.runs[0].tool.driver.name, "cdx-validate");
    assert.strictEqual(parsed.runs[0].tool.driver.version, "1.2.3");
    // Manual findings are hidden by default.
    assert.strictEqual(parsed.runs[0].results.length, 1);
    assert.strictEqual(parsed.runs[0].results[0].ruleId, "SCVS-2.4");
    assert.strictEqual(parsed.runs[0].results[0].level, "error");
    // Driver rules must be unique and reference the only remaining finding.
    assert.strictEqual(parsed.runs[0].tool.driver.rules.length, 1);
  });

  it("sarif reporter can include manual findings when requested", () => {
    const out = render("sarif", sampleReport(), { includeManual: true });
    const parsed = JSON.parse(out);
    assert.strictEqual(parsed.runs[0].results.length, 2);
  });

  it("annotations reporter returns the BOM with annotations appended", () => {
    const bomJson = {
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      serialNumber: "urn:uuid:1b671687-395b-41f5-a30f-a58921a69b79",
      metadata: {
        tools: {
          components: [
            { type: "application", name: "cdxgen", version: "12.0.0" },
          ],
        },
        component: { name: "demo", "bom-ref": "demo", type: "application" },
      },
      components: [{ name: "demo", "bom-ref": "demo", type: "library" }],
    };
    const out = render("annotations", sampleReport(), { bomJson });
    const parsed = JSON.parse(out);
    assert.ok(Object.keys(parsed?.annotations));
    assert.strictEqual(parsed.annotations.length, 2);
    const first = parsed.annotations[0];
    assert.ok(first.subjects[0].includes(bomJson.serialNumber));
    assert.ok(first.annotator);
  });

  it("annotations reporter skips when spec version is below 1.5", () => {
    const bomJson = {
      bomFormat: "CycloneDX",
      specVersion: "1.4",
      metadata: { component: { name: "old" } },
    };
    const ann = buildAnnotations(sampleReport().findings, bomJson);
    assert.strictEqual(Object.keys(ann).length, 0);
  });
});
