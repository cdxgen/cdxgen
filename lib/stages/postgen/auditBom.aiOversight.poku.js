import { assert, describe, it } from "poku";

import { auditBom } from "./auditBom.js";

const baseBom = () => ({
  bomFormat: "CycloneDX",
  specVersion: "1.6",
  serialNumber: "urn:uuid:ai-oversight-audit-test",
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

describe("AI human oversight audit rules", () => {
  it("flags high AI verification debt (AIOVS-001)", async () => {
    const bom = baseBom();
    bom.properties = [
      { name: "cdx:ai:codegen:detected", value: "true" },
      { name: "cdx:ai:oversight:verificationDebtRatio", value: "0.8000" },
      { name: "cdx:ai:oversight:selfMergeRate", value: "0.2000" },
      { name: "cdx:ai:oversight:score", value: "0.4500" },
      { name: "cdx:ai:oversight:band", value: "weak" },
    ];

    const findings = await auditBom(bom, {
      bomAuditCategories: "ai-provenance", // should expand to include ai-oversight
    });
    const finding = findings.find((f) => f.ruleId === "AIOVS-001");
    assert.ok(finding, "expected AIOVS-001 finding");
    assert.strictEqual(finding.severity, "high");
    assert.ok(
      finding.message.includes("0.8000"),
      "message should include verification debt ratio",
    );
  });

  it("flags CI weakening events on AI commits (AIOVS-002)", async () => {
    const bom = baseBom();
    bom.properties = [
      { name: "cdx:ai:codegen:detected", value: "true" },
      { name: "cdx:ai:oversight:ciWeakeningEvents", value: "2" },
      { name: "cdx:ai:oversight:score", value: "0.6500" },
      { name: "cdx:ai:oversight:band", value: "moderate" },
    ];

    const findings = await auditBom(bom, {
      bomAuditCategories: "ai-oversight",
    });
    const finding = findings.find((f) => f.ruleId === "AIOVS-002");
    assert.ok(finding, "expected AIOVS-002 finding");
    assert.strictEqual(finding.severity, "high");
  });

  it("flags high self-merge rate of AI commits (AIOVS-003)", async () => {
    const bom = baseBom();
    bom.properties = [
      { name: "cdx:ai:codegen:detected", value: "true" },
      { name: "cdx:ai:oversight:selfMergeRate", value: "0.6000" },
      { name: "cdx:ai:oversight:score", value: "0.5500" },
      { name: "cdx:ai:oversight:band", value: "moderate" },
    ];

    const findings = await auditBom(bom, {
      bomAuditCategories: "ai-oversight",
    });
    const finding = findings.find((f) => f.ruleId === "AIOVS-003");
    assert.ok(finding, "expected AIOVS-003 finding");
    assert.strictEqual(finding.severity, "medium");
  });

  it("flags low review coverage (AIOVS-004)", async () => {
    const bom = baseBom();
    bom.properties = [
      { name: "cdx:ai:codegen:detected", value: "true" },
      { name: "cdx:ai:oversight:reviewCoverage", value: "0.2000" },
      { name: "cdx:ai:oversight:score", value: "0.5500" },
      { name: "cdx:ai:oversight:band", value: "moderate" },
    ];

    const findings = await auditBom(bom, {
      bomAuditCategories: "ai-oversight",
    });
    const finding = findings.find((f) => f.ruleId === "AIOVS-004");
    assert.ok(finding, "expected AIOVS-004 finding");
    assert.strictEqual(finding.severity, "medium");
  });

  it("flags weak role accountability and gaps in AI attribution (AIOVS-005)", async () => {
    const bom = baseBom();
    bom.properties = [
      { name: "cdx:ai:codegen:detected", value: "true" },
      { name: "cdx:ai:oversight:codeownersCoverage", value: "0.2500" },
      { name: "cdx:ai:oversight:signoffCoverage", value: "0.8000" },
      { name: "cdx:ai:oversight:score", value: "0.7800" },
      { name: "cdx:ai:oversight:band", value: "strong" },
    ];

    const findings = await auditBom(bom, {
      bomAuditCategories: "ai-oversight",
    });
    const finding = findings.find((f) => f.ruleId === "AIOVS-005");
    assert.ok(finding, "expected AIOVS-005 finding");
    assert.strictEqual(finding.severity, "low");
  });

  it("flags overall weak band (AIOVS-006)", async () => {
    const bom = baseBom();
    bom.properties = [
      { name: "cdx:ai:codegen:detected", value: "true" },
      { name: "cdx:ai:oversight:score", value: "0.3500" },
      { name: "cdx:ai:oversight:band", value: "weak" },
    ];

    const findings = await auditBom(bom, {
      bomAuditCategories: "ai-oversight",
    });
    const finding = findings.find((f) => f.ruleId === "AIOVS-006");
    assert.ok(finding, "expected AIOVS-006 finding");
    assert.strictEqual(finding.severity, "medium");
  });
});
