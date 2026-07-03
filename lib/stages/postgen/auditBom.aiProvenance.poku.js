import { assert, describe, it } from "poku";

import { auditBom } from "./auditBom.js";

const baseBom = () => ({
  bomFormat: "CycloneDX",
  specVersion: "1.6",
  serialNumber: "urn:uuid:ai-prov-test",
  metadata: {
    component: {
      "bom-ref": "pkg:npm/test-app@1.0.0",
      purl: "pkg:npm/test-app@1.0.0",
      name: "test-app",
      version: "1.0.0",
    },
    properties: [],
    tools: {
      components: [{ name: "cdxgen", type: "application" }],
    },
  },
});

describe("AI provenance audit rules", () => {
  it("flags AI authorship from cdx:ai:codegen properties (AIPROV-001)", async () => {
    const bom = baseBom();
    bom.properties = [
      { name: "cdx:ai:codegen:detected", value: "true" },
      { name: "cdx:ai:codegen:confidence", value: "0.72" },
      { name: "cdx:ai:codegen:confidence:band", value: "medium" },
      { name: "cdx:ai:codegen:tools", value: "claude-code" },
      { name: "cdx:ai:codegen:phases", value: "dev" },
      { name: "cdx:ai:codegen:signals:count", value: "1" },
    ];

    const findings = await auditBom(bom, {
      bomAuditCategories: "ai-provenance",
    });
    const finding = findings.find((f) => f.ruleId === "AIPROV-001");
    assert.ok(finding, "expected AIPROV-001 finding");
    assert.strictEqual(finding.category, "ai-provenance");
    assert.ok(
      finding.message.includes("claude-code"),
      "message should include the detected tool",
    );
    assert.ok(
      /copyright/i.test(finding.message),
      "message should mention copyright",
    );
  });

  it("raises severity for high-confidence signals (AIPROV-002)", async () => {
    const bom = baseBom();
    bom.properties = [
      { name: "cdx:ai:codegen:detected", value: "true" },
      { name: "cdx:ai:codegen:confidence", value: "0.98" },
      { name: "cdx:ai:codegen:confidence:band", value: "high" },
      { name: "cdx:ai:codegen:tools", value: "github-copilot" },
      { name: "cdx:ai:codegen:phases", value: "dev" },
      { name: "cdx:ai:codegen:signals:count", value: "2" },
    ];

    const findings = await auditBom(bom, {
      bomAuditCategories: "ai-provenance",
    });
    const highFinding = findings.find((f) => f.ruleId === "AIPROV-002");
    assert.ok(highFinding, "expected AIPROV-002 finding");
    assert.strictEqual(highFinding.severity, "medium");
  });

  it("does not flag BOMs without AI signals", async () => {
    const bom = baseBom();
    const findings = await auditBom(bom, {
      // process.cwd() is the cdxgen repo; disable detection so the audit does
      // not pick up its own AI signals for this negative test.
      aiProvenance: false,
      bomAuditCategories: "ai-provenance",
    });
    assert.strictEqual(
      findings.filter((f) => f.category === "ai-provenance").length,
      0,
    );
  });
});
