import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, describe, it } from "poku";

import {
  buildTargetContextFindings,
  finalizeAuditReport,
  loadInputBoms,
} from "./index.js";
import { formatPredictiveAnnotations } from "./reporters.js";

function writeJson(filePath, payload) {
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

describe("loadInputBoms()", () => {
  it("loads valid BOMs from a directory and skips unrelated JSON files", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "cdx-audit-"));
    const bomPath = path.join(tmpDir, "bom.json");
    const otherPath = path.join(tmpDir, "notes.json");

    writeJson(bomPath, {
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      version: 1,
      components: [],
    });
    writeJson(otherPath, {
      hello: "world",
    });

    try {
      const inputBoms = loadInputBoms({ bomDir: tmpDir });
      assert.strictEqual(inputBoms.length, 1);
      assert.strictEqual(inputBoms[0].source, bomPath);
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });
});

describe("finalizeAuditReport()", () => {
  it("returns exit code 3 when a target meets the fail severity", () => {
    const finalized = finalizeAuditReport(
      {
        results: [
          {
            assessment: {
              severity: "high",
            },
            findings: [],
            target: {
              name: "left-pad",
              type: "npm",
            },
          },
        ],
        summary: {
          erroredTargets: 0,
          inputBomCount: 1,
          scannedTargets: 1,
          skippedTargets: 0,
          totalTargets: 1,
        },
      },
      {
        failSeverity: "high",
        minSeverity: "low",
        report: "console",
      },
    );

    assert.strictEqual(finalized.exitCode, 3);
    assert.match(finalized.output, /left-pad/);
  });

  it("returns exit code 0 when no target crosses the fail threshold", () => {
    const finalized = finalizeAuditReport(
      {
        results: [
          {
            assessment: {
              confidenceLabel: "medium",
              reasons: ["Only one mild signal observed."],
              score: 18,
              severity: "low",
            },
            findings: [
              {
                message: "Deprecated package",
                ruleId: "INT-005",
              },
            ],
            target: {
              name: "requests",
              type: "pypi",
            },
          },
        ],
        summary: {
          erroredTargets: 0,
          inputBomCount: 1,
          scannedTargets: 1,
          skippedTargets: 0,
          totalTargets: 1,
        },
      },
      {
        failSeverity: "high",
        minSeverity: "low",
        report: "console",
      },
    );

    assert.strictEqual(finalized.exitCode, 0);
    assert.match(finalized.output, /requests/);
  });
});

describe("buildTargetContextFindings()", () => {
  it("creates a medium provenance detector for npm install-script packages without provenance", () => {
    const findings = buildTargetContextFindings({
      bomRefs: ["pkg:npm/example@1.2.3"],
      name: "example",
      purl: "pkg:npm/example@1.2.3",
      properties: [
        {
          name: "cdx:npm:hasInstallScript",
          value: "true",
        },
      ],
      type: "npm",
      version: "1.2.3",
    });

    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].ruleId, "PROV-001");
    assert.strictEqual(findings[0].severity, "medium");
  });

  it("creates a low provenance detector for default-registry PyPI packages without provenance", () => {
    const findings = buildTargetContextFindings({
      bomRefs: ["pkg:pypi/example@2.0.0"],
      name: "example",
      purl: "pkg:pypi/example@2.0.0",
      properties: [],
      type: "pypi",
      version: "2.0.0",
    });

    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].ruleId, "PROV-002");
    assert.strictEqual(findings[0].severity, "low");
  });

  it("does not create provenance detector findings when trusted publishing is present", () => {
    const findings = buildTargetContextFindings({
      bomRefs: ["pkg:npm/example@1.2.3"],
      name: "example",
      purl: "pkg:npm/example@1.2.3",
      properties: [
        {
          name: "cdx:npm:hasInstallScript",
          value: "true",
        },
        {
          name: "cdx:npm:trustedPublishing",
          value: "true",
        },
      ],
      type: "npm",
      version: "1.2.3",
    });

    assert.strictEqual(findings.length, 0);
  });

  it("creates recent-release and publisher-drift detectors for risky npm packages", () => {
    const recentTimestamp = new Date(
      Date.now() - 1000 * 60 * 60 * 12,
    ).toISOString();
    const oldTimestamp = new Date(
      Date.now() - 1000 * 60 * 60 * 24 * 120,
    ).toISOString();
    const findings = buildTargetContextFindings({
      bomRefs: ["pkg:npm/example@2.0.0"],
      name: "example",
      purl: "pkg:npm/example@2.0.0",
      properties: [
        {
          name: "cdx:npm:hasInstallScript",
          value: "true",
        },
        {
          name: "cdx:npm:publishTime",
          value: recentTimestamp,
        },
        {
          name: "cdx:npm:packageCreatedTime",
          value: oldTimestamp,
        },
        {
          name: "cdx:npm:versionCount",
          value: "10",
        },
        {
          name: "cdx:npm:publisherDrift",
          value: "true",
        },
      ],
      type: "npm",
      version: "2.0.0",
    });

    assert.ok(findings.some((finding) => finding.ruleId === "PROV-003"));
    assert.ok(findings.some((finding) => finding.ruleId === "PROV-004"));
  });

  it("creates maintainer-set drift and dormant-gap detectors for risky npm packages", () => {
    const findings = buildTargetContextFindings({
      bomRefs: ["pkg:npm/example@3.0.0"],
      name: "example",
      purl: "pkg:npm/example@3.0.0",
      properties: [
        {
          name: "cdx:npm:hasInstallScript",
          value: "true",
        },
        {
          name: "cdx:npm:packageCreatedTime",
          value: "2024-01-01T00:00:00.000Z",
        },
        {
          name: "cdx:npm:versionCount",
          value: "12",
        },
        {
          name: "cdx:npm:maintainerSetDrift",
          value: "true",
        },
        {
          name: "cdx:npm:releaseGapDays",
          value: "240",
        },
        {
          name: "cdx:npm:releaseGapBaselineDays",
          value: "12",
        },
        {
          name: "cdx:npm:releaseGapSampleSize",
          value: "4",
        },
      ],
      type: "npm",
      version: "3.0.0",
    });

    assert.ok(findings.some((finding) => finding.ruleId === "PROV-007"));
    assert.ok(findings.some((finding) => finding.ruleId === "PROV-008"));
  });

  it("creates partial-overlap drift and compressed-cadence detectors for risky npm packages", () => {
    const findings = buildTargetContextFindings({
      bomRefs: ["pkg:npm/example@3.1.0"],
      name: "example",
      purl: "pkg:npm/example@3.1.0",
      properties: [
        {
          name: "cdx:npm:hasInstallScript",
          value: "true",
        },
        {
          name: "cdx:npm:packageCreatedTime",
          value: "2024-01-01T00:00:00.000Z",
        },
        {
          name: "cdx:npm:versionCount",
          value: "12",
        },
        {
          name: "cdx:npm:maintainerSet",
          value: "alice, bob",
        },
        {
          name: "cdx:npm:priorMaintainerSet",
          value: "bob, charlie",
        },
        {
          name: "cdx:npm:releaseGapDays",
          value: "9",
        },
        {
          name: "cdx:npm:releaseGapBaselineDays",
          value: "60",
        },
        {
          name: "cdx:npm:releaseGapSampleSize",
          value: "3",
        },
      ],
      type: "npm",
      version: "3.1.0",
    });

    assert.ok(findings.some((finding) => finding.ruleId === "PROV-011"));
    assert.ok(findings.some((finding) => finding.ruleId === "PROV-012"));
    assert.ok(!findings.some((finding) => finding.ruleId === "PROV-007"));
  });

  it("creates recent-release and publisher-drift detectors for default-registry PyPI packages", () => {
    const recentTimestamp = new Date(
      Date.now() - 1000 * 60 * 60 * 12,
    ).toISOString();
    const oldTimestamp = new Date(
      Date.now() - 1000 * 60 * 60 * 24 * 120,
    ).toISOString();
    const findings = buildTargetContextFindings({
      bomRefs: ["pkg:pypi/example@2.0.0"],
      name: "example",
      purl: "pkg:pypi/example@2.0.0",
      properties: [
        {
          name: "cdx:pypi:publishTime",
          value: recentTimestamp,
        },
        {
          name: "cdx:pypi:packageCreatedTime",
          value: oldTimestamp,
        },
        {
          name: "cdx:pypi:versionCount",
          value: "8",
        },
        {
          name: "cdx:pypi:publisherDrift",
          value: "true",
        },
      ],
      type: "pypi",
      version: "2.0.0",
    });

    assert.ok(findings.some((finding) => finding.ruleId === "PROV-005"));
    assert.ok(findings.some((finding) => finding.ruleId === "PROV-006"));
  });

  it("creates uploader-set drift and dormant-gap detectors for PyPI packages with weak trust posture", () => {
    const findings = buildTargetContextFindings({
      bomRefs: ["pkg:pypi/example@3.0.0"],
      name: "example",
      purl: "pkg:pypi/example@3.0.0",
      properties: [
        {
          name: "cdx:pypi:packageCreatedTime",
          value: "2024-01-01T00:00:00.000Z",
        },
        {
          name: "cdx:pypi:versionCount",
          value: "12",
        },
        {
          name: "cdx:pypi:uploaderSetDrift",
          value: "true",
        },
        {
          name: "cdx:pypi:releaseGapDays",
          value: "240",
        },
        {
          name: "cdx:pypi:releaseGapBaselineDays",
          value: "12",
        },
        {
          name: "cdx:pypi:releaseGapSampleSize",
          value: "4",
        },
      ],
      type: "pypi",
      version: "3.0.0",
    });

    assert.ok(findings.some((finding) => finding.ruleId === "PROV-009"));
    assert.ok(findings.some((finding) => finding.ruleId === "PROV-010"));
  });

  it("creates partial-overlap drift and compressed-cadence detectors for PyPI packages with weak trust posture", () => {
    const findings = buildTargetContextFindings({
      bomRefs: ["pkg:pypi/example@3.1.0"],
      name: "example",
      purl: "pkg:pypi/example@3.1.0",
      properties: [
        {
          name: "cdx:pypi:packageCreatedTime",
          value: "2024-01-01T00:00:00.000Z",
        },
        {
          name: "cdx:pypi:versionCount",
          value: "12",
        },
        {
          name: "cdx:pypi:uploaderSet",
          value: "alice, bob",
        },
        {
          name: "cdx:pypi:priorUploaderSet",
          value: "bob, charlie",
        },
        {
          name: "cdx:pypi:releaseGapDays",
          value: "9",
        },
        {
          name: "cdx:pypi:releaseGapBaselineDays",
          value: "60",
        },
        {
          name: "cdx:pypi:releaseGapSampleSize",
          value: "3",
        },
      ],
      type: "pypi",
      version: "3.1.0",
    });

    assert.ok(findings.some((finding) => finding.ruleId === "PROV-013"));
    assert.ok(findings.some((finding) => finding.ruleId === "PROV-014"));
    assert.ok(!findings.some((finding) => finding.ruleId === "PROV-009"));
  });
});

describe("formatPredictiveAnnotations()", () => {
  it("creates component-scoped annotations for predictive audit results", () => {
    const annotations = formatPredictiveAnnotations(
      {
        results: [
          {
            assessment: {
              confidenceLabel: "medium",
              reasons: ["Two signals corroborated the risk posture."],
              score: 58,
              severity: "high",
            },
            findings: [
              {
                message: "Install script from non-registry source",
                ruleId: "PKG-001",
              },
            ],
            repoUrl: "https://github.com/example/left-pad",
            target: {
              bomRefs: ["pkg:npm/left-pad@1.3.0"],
              purl: "pkg:npm/left-pad@1.3.0",
            },
          },
        ],
      },
      {
        metadata: {
          tools: {
            components: [
              {
                name: "cdxgen",
                type: "application",
                version: "12.3.0",
              },
            ],
          },
        },
        serialNumber: "urn:uuid:test-bom",
      },
      {
        minSeverity: "medium",
      },
    );

    assert.strictEqual(annotations.length, 1);
    assert.deepStrictEqual(annotations[0].subjects, ["pkg:npm/left-pad@1.3.0"]);
    assert.match(annotations[0].text, /Predictive audit score 58/);
    assert.match(annotations[0].text, /cdx:audit:engine/);
  });
});
