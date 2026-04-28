import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import esmock from "esmock";
import { assert, describe, it } from "poku";
import sinon from "sinon";

import {
  buildTargetContextFindings,
  finalizeAuditReport,
  groupAuditResults,
  loadInputBoms,
} from "./index.js";
import { formatPredictiveAnnotations, renderAuditReport } from "./reporters.js";

function writeJson(filePath, payload) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function auditTargetSlug(target) {
  const packageName = target.namespace
    ? `${target.namespace}-${target.name}`
    : target.name;
  const normalized = packageName
    .toLowerCase()
    .replace(/[-_.]+/g, "-")
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const version = (target.version || "latest")
    .toLowerCase()
    .replace(/[-_.]+/g, "-");
  const digest = createHash("sha256")
    .update(target.purl)
    .digest("hex")
    .slice(0, 12);
  return `${target.type}-${normalized || "package"}-${version || "latest"}-${digest}`;
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

  it("uses consolidated grouped results for fail-threshold decisions", () => {
    const finalized = finalizeAuditReport(
      {
        groupedResults: [
          {
            assessment: {
              severity: "medium",
            },
            findings: [],
            grouping: {
              label: "npm:@npmcli/*",
            },
            target: {
              name: "*",
              type: "npm",
            },
          },
        ],
        results: [
          {
            assessment: {
              severity: "high",
            },
            findings: [],
            target: {
              name: "fs",
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

    assert.strictEqual(finalized.exitCode, 0);
    assert.match(finalized.output, /@npmcli/);
  });

  it("renders grouped predictive findings as SARIF 2.1.0 output", () => {
    const finalized = finalizeAuditReport(
      {
        groupedResults: [
          {
            assessment: {
              confidenceLabel: "high",
              reasons: ["Two corroborating signals were observed."],
              score: 72,
              severity: "high",
            },
            findings: [
              {
                category: "package-integrity",
                description: "Install-time hooks without provenance.",
                message: "Package lacks registry-visible provenance.",
                mitigation: "Prefer provenance-backed releases.",
                ruleId: "PROV-001",
                severity: "medium",
              },
            ],
            grouping: {
              groupedPurls: ["pkg:npm/%40npmcli/fs@5.0.0"],
              label: "npm:@npmcli/*",
              memberCount: 1,
            },
            status: "audited",
            target: {
              bomRefs: ["pkg:npm/@npmcli/fs@5.0.0"],
              name: "*",
              namespace: "@npmcli",
              purl: "pkg:npm/%40npmcli/fs@5.0.0",
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
        tool: {
          name: "cdx-audit",
          version: "12.3.0",
        },
      },
      {
        failSeverity: "critical",
        minSeverity: "low",
        report: "sarif",
      },
    );

    const parsed = JSON.parse(finalized.output);
    assert.strictEqual(finalized.exitCode, 0);
    assert.strictEqual(parsed.version, "2.1.0");
    assert.strictEqual(parsed.runs[0].tool.driver.name, "cdx-audit");
    assert.strictEqual(parsed.runs[0].tool.driver.version, "12.3.0");
    assert.strictEqual(parsed.runs[0].results.length, 1);
    assert.strictEqual(parsed.runs[0].results[0].ruleId, "PROV-001");
    assert.strictEqual(
      parsed.runs[0].results[0].locations[0].logicalLocations[0]
        .fullyQualifiedName,
      "pkg:npm/@npmcli/fs@5.0.0",
    );
  });

  it("includes synthetic SARIF results when a target fails before findings are produced", () => {
    const rendered = renderAuditReport(
      "sarif",
      {
        results: [
          {
            assessment: {
              confidenceLabel: "low",
              reasons: ["Source resolution failed."],
              score: 45,
              severity: "high",
            },
            error: "Unable to clone repository.",
            errorType: "clone",
            findings: [],
            status: "error",
            target: {
              bomRefs: ["pkg:pypi/example@1.0.0"],
              name: "example",
              purl: "pkg:pypi/example@1.0.0",
              type: "pypi",
              version: "1.0.0",
            },
          },
        ],
        summary: {
          erroredTargets: 1,
          inputBomCount: 1,
          scannedTargets: 0,
          skippedTargets: 0,
          totalTargets: 1,
        },
        tool: {
          name: "cdx-audit",
          version: "12.3.0",
        },
      },
      {
        minSeverity: "low",
      },
    );

    const parsed = JSON.parse(rendered);
    assert.strictEqual(parsed.runs[0].results.length, 1);
    assert.strictEqual(parsed.runs[0].results[0].ruleId, "AUDIT-ERROR");
    assert.strictEqual(parsed.runs[0].results[0].level, "error");
    assert.strictEqual(parsed.runs[0].tool.driver.rules[0].id, "AUDIT-ERROR");
  });
});

describe("groupAuditResults()", () => {
  it("consolidates npm namespace findings with the same rule pattern", () => {
    const groupedResults = groupAuditResults([
      {
        assessment: {
          categoryCounts: {
            "ci-permission": 1,
          },
          confidenceLabel: "high",
          reasons: [
            "1 strong finding(s) were observed across the generated source SBOM.",
          ],
          score: 58,
          severity: "medium",
        },
        findings: [
          {
            category: "ci-permission",
            message: "Interpolated github.event.pull_request.title",
            ruleId: "CI-007",
          },
        ],
        repoUrl: "https://github.com/npm/fs.git",
        status: "audited",
        target: {
          bomRefs: ["pkg:npm/@npmcli/fs@5.0.0"],
          name: "fs",
          namespace: "@npmcli",
          purl: "pkg:npm/%40npmcli/fs@5.0.0",
          type: "npm",
          version: "5.0.0",
        },
      },
      {
        assessment: {
          categoryCounts: {
            "ci-permission": 1,
          },
          confidenceLabel: "high",
          reasons: [
            "1 strong finding(s) were observed across the generated source SBOM.",
          ],
          score: 58,
          severity: "medium",
        },
        findings: [
          {
            category: "ci-permission",
            message: "Interpolated github.event.pull_request.title",
            ruleId: "CI-007",
          },
        ],
        repoUrl: "https://github.com/npm/git.git",
        status: "audited",
        target: {
          bomRefs: ["pkg:npm/@npmcli/git@7.0.2"],
          name: "git",
          namespace: "@npmcli",
          purl: "pkg:npm/%40npmcli/git@7.0.2",
          type: "npm",
          version: "7.0.2",
        },
      },
      {
        assessment: {
          categoryCounts: {
            "package-integrity": 1,
          },
          confidenceLabel: "high",
          reasons: ["Findings remained isolated."],
          score: 16,
          severity: "low",
        },
        findings: [
          {
            category: "package-integrity",
            message: "Install hook present",
            ruleId: "INT-001",
          },
        ],
        repoUrl: "https://github.com/isaacs/string-locale-compare.git",
        status: "audited",
        target: {
          bomRefs: ["pkg:npm/@isaacs/string-locale-compare@1.1.0"],
          name: "string-locale-compare",
          namespace: "@isaacs",
          purl: "pkg:npm/%40isaacs/string-locale-compare@1.1.0",
          type: "npm",
          version: "1.1.0",
        },
      },
    ]);

    assert.strictEqual(groupedResults.length, 2);
    assert.strictEqual(groupedResults[0].grouping?.label, "npm:@npmcli/*");
    assert.strictEqual(groupedResults[0].grouping?.memberCount, 2);
    assert.strictEqual(groupedResults[1].target.name, "string-locale-compare");
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

describe("auditTarget() cache resume", () => {
  it("reuses a cached child SBOM from the workspace without resolving or regenerating source", async () => {
    const workspaceDir = mkdtempSync(
      path.join(os.tmpdir(), "cdx-audit-workspace-"),
    );
    const target = {
      bomRefs: ["pkg:npm/@scope/pkg@1.0.0"],
      name: "pkg",
      namespace: "@scope",
      purl: "pkg:npm/%40scope/pkg@1.0.0",
      properties: [],
      type: "npm",
      version: "1.0.0",
    };
    const targetDir = path.join(workspaceDir, auditTargetSlug(target));
    const cacheDir = path.join(targetDir, ".cdx-audit");
    const cachedBom = {
      bomFormat: "CycloneDX",
      specVersion: "1.7",
      version: 1,
      components: [],
    };
    writeJson(path.join(cacheDir, "source-bom.json"), cachedBom);
    writeJson(path.join(cacheDir, "source-bom.meta.json"), {
      repoUrl: "https://github.com/scope/pkg.git",
      resolution: {
        name: "pkg",
        namespace: "@scope",
        repoUrl: "https://github.com/scope/pkg.git",
        type: "npm",
        version: "1.0.0",
      },
      scanDirRelative: ".",
      sourceDirectoryConfidence: "high",
      versionMatched: true,
    });

    const createBomStub = sinon.stub().resolves({ bomJson: cachedBom });
    const resolveGitUrlFromPurlStub = sinon.stub().resolves({
      repoUrl: "https://github.com/scope/pkg.git",
    });
    const auditBomStub = sinon.stub().resolves([]);
    const { auditTarget } = await esmock("./index.js", {
      "../cli/index.js": { createBom: createBomStub },
      "../helpers/logger.js": { thoughtLog: sinon.stub() },
      "../helpers/source.js": {
        cleanupSourceDir: sinon.stub(),
        findGitRefForPurlVersion: sinon.stub().returns(undefined),
        hardenedGitCommand: sinon.stub(),
        resolveGitUrlFromPurl: resolveGitUrlFromPurlStub,
        resolvePurlSourceDirectory: sinon.stub().returns(targetDir),
        sanitizeRemoteUrlForLogs: (value) => value,
      },
      "../helpers/utils.js": {
        dirNameStr: path.resolve("."),
        getTmpDir: () => os.tmpdir(),
        safeExistsSync: (filePath) => existsSync(filePath),
        safeMkdirSync: (filePath, options) => mkdirSync(filePath, options),
      },
      "../stages/postgen/auditBom.js": { auditBom: auditBomStub },
      "../stages/postgen/postgen.js": {
        postProcess: sinon.stub().callsFake((bomNSData) => bomNSData),
      },
    });

    try {
      const result = await auditTarget(target, {
        maxTargets: 1,
        minSeverity: "low",
        workspaceDir,
      });

      assert.strictEqual(result.status, "audited");
      assert.strictEqual(result.cacheHit, true);
      assert.strictEqual(createBomStub.callCount, 0);
      assert.strictEqual(resolveGitUrlFromPurlStub.callCount, 0);
      assert.strictEqual(auditBomStub.callCount, 1);
    } finally {
      rmSync(workspaceDir, { force: true, recursive: true });
    }
  });
});
