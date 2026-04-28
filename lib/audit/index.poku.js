import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import esmock from "esmock";
import { assert, describe, it } from "poku";
import sinon from "sinon";

import {
  buildPythonSourceHeuristicFindings,
  buildTargetContextFindings,
  finalizeAuditReport,
  groupAuditResults,
  loadInputBoms,
} from "./index.js";
import {
  formatPredictiveAnnotations,
  renderAuditReport,
  renderConsoleReport,
} from "./reporters.js";

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

describe("runAuditFromBoms()", () => {
  it("passes scope/max target options to the selector and emits a preflight notice", async () => {
    const collectAuditTargetsStub = sinon.stub().returns({
      skipped: [],
      stats: {
        availableTargets: 60,
        nonRequiredTargets: 59,
        requiredTargets: 1,
        trustedTargets: 12,
        trustedTargetsExcluded: 12,
        truncatedTargets: 59,
      },
      targets: [
        {
          name: "core",
          namespace: "acme",
          purl: "pkg:npm/acme/core@1.0.0",
          required: true,
          type: "npm",
          version: "1.0.0",
        },
      ],
    });
    const progressEvents = [];
    const { runAuditFromBoms: mockedRunAuditFromBoms } = await esmock(
      "./index.js",
      {
        "../cli/index.js": {
          createBom: sinon.stub().resolves({
            bomJson: {
              bomFormat: "CycloneDX",
              components: [],
              specVersion: "1.7",
              version: 1,
            },
          }),
        },
        "../helpers/bomUtils.js": {
          getNonCycloneDxErrorMessage: sinon.stub(),
          isCycloneDxBom: () => true,
        },
        "../helpers/logger.js": { thoughtLog: sinon.stub() },
        "../helpers/provenanceUtils.js": {
          hasRegistryProvenanceEvidenceProperties: () => false,
          hasTrustedPublishingProperties: () => false,
        },
        "../helpers/source.js": {
          cleanupSourceDir: sinon.stub(),
          findGitRefForPurlVersion: sinon.stub().returns(undefined),
          hardenedGitCommand: sinon.stub().returns({ status: 0 }),
          resolveGitUrlFromPurl: sinon.stub().resolves({
            repoUrl: "https://github.com/acme/core.git",
            type: "npm",
          }),
          resolvePurlSourceDirectory: sinon.stub().returnsArg(0),
          sanitizeRemoteUrlForLogs: (value) => value,
        },
        "../helpers/utils.js": {
          dirNameStr: path.resolve("."),
          getTmpDir: () => os.tmpdir(),
          safeExistsSync: (filePath) => existsSync(filePath),
          safeMkdirSync: (filePath, options) => mkdirSync(filePath, options),
        },
        "../stages/postgen/auditBom.js": {
          auditBom: sinon.stub().resolves([]),
        },
        "../stages/postgen/postgen.js": {
          postProcess: sinon.stub().callsFake((bomNSData) => bomNSData),
        },
        "./targets.js": {
          collectAuditTargets: collectAuditTargetsStub,
          normalizePackageName: (value) =>
            (value || "").toLowerCase().replace(/[-_.]+/g, "-"),
        },
      },
    );

    const report = await mockedRunAuditFromBoms(
      [
        {
          bomJson: {
            bomFormat: "CycloneDX",
            components: [],
            specVersion: "1.7",
            version: 1,
          },
          source: "bom.json",
        },
      ],
      {
        maxTargets: 50,
        onProgress: (event) => progressEvents.push(event),
        scope: "required",
        trustedSelectionHelp:
          "Use --include-trusted to include them or --only-trusted to audit just those packages.",
      },
    );

    assert.strictEqual(report.summary.totalTargets, 1);
    assert.deepStrictEqual(collectAuditTargetsStub.firstCall.args[1], {
      maxTargets: 50,
      scope: "required",
      trusted: undefined,
    });
    assert.strictEqual(progressEvents[0].type, "run:info");
    assert.match(progressEvents[0].message, /scan 1 required package/);
    assert.match(
      progressEvents[0].message,
      /Skipping 12 trusted-publishing-backed package/,
    );
    assert.strictEqual(progressEvents[1].type, "run:start");
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

  it("includes next-action and upstream guidance in SARIF output", () => {
    const rendered = renderAuditReport(
      "sarif",
      {
        results: [
          {
            assessment: {
              confidenceLabel: "high",
              reasons: ["Release workflow exposes legacy credentials."],
              score: 71,
              severity: "high",
            },
            findings: [
              {
                attackTactics: ["TA0006", "TA0010"],
                attackTechniques: ["T1528"],
                location: {
                  file: ".github/workflows/release.yml",
                },
                message:
                  "Workflow publish step uses legacy npm token-based publishing.",
                mitigation:
                  "Prefer trusted publishing or OIDC-backed release flows instead of long-lived tokens.",
                ruleId: "CI-010",
                severity: "medium",
              },
            ],
            repoUrl: "https://github.com/example/project",
            status: "audited",
            target: {
              bomRefs: ["pkg:npm/example@1.0.0"],
              name: "example",
              purl: "pkg:npm/example@1.0.0",
              type: "npm",
              version: "1.0.0",
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
        minSeverity: "low",
      },
    );

    const parsed = JSON.parse(rendered);
    assert.match(
      parsed.runs[0].tool.driver.rules[0].help.text,
      /open an issue or discussion/i,
    );
    assert.match(
      parsed.runs[0].results[0].properties.nextAction,
      /open an issue or discussion/i,
    );
    assert.match(
      parsed.runs[0].results[0].properties.upstreamEscalation,
      /upstream maintainers/i,
    );
    assert.deepStrictEqual(parsed.runs[0].results[0].properties.attackTactics, [
      "TA0006",
      "TA0010",
    ]);
    assert.deepStrictEqual(
      parsed.runs[0].tool.driver.rules[0].properties.attackTechniques,
      ["T1528"],
    );
    assert.ok(
      parsed.runs[0].tool.driver.rules[0].properties.tags.includes(
        "ATT&CK:TA0006",
      ),
    );
  });

  it("renders an action-oriented console report for actionable results", () => {
    const rendered = renderConsoleReport(
      {
        results: [
          {
            assessment: {
              confidenceLabel: "high",
              reasons: ["Release workflow exposes legacy credentials."],
              score: 71,
              severity: "high",
            },
            findings: [
              {
                location: {
                  file: ".github/workflows/release.yml",
                },
                message:
                  "Workflow publish step uses legacy npm token-based publishing.",
                mitigation:
                  "Prefer trusted publishing or OIDC-backed release flows instead of long-lived tokens.",
                ruleId: "CI-010",
              },
            ],
            repoUrl: "https://github.com/example/project",
            status: "audited",
            target: {
              bomRefs: ["pkg:npm/example@1.0.0"],
              name: "example",
              purl: "pkg:npm/example@1.0.0",
              type: "npm",
              version: "1.0.0",
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
        minSeverity: "low",
      },
    );

    assert.match(rendered, /Dependencies requiring your attention:/);
    assert.match(rendered, /What to do next/);
    assert.match(rendered, /\.github\/workflows\/release\.yml/);
    assert.match(rendered, /https:\/\/github.com\/example\/project/);
    assert.match(rendered, /OIDC-backed release flows/);
    assert.match(rendered, /open an issue or discussion/i);
    assert.match(rendered, /upstream maintainers/i);
  });

  it("suggests upstream reporting for externally maintained package findings", () => {
    const rendered = renderConsoleReport(
      {
        results: [
          {
            assessment: {
              confidenceLabel: "medium",
              reasons: ["Publisher drift was detected on a mature package."],
              score: 46,
              severity: "medium",
            },
            findings: [
              {
                location: {
                  purl: "pkg:npm/example@2.0.0",
                },
                message:
                  "npm package 'example@2.0.0' was published by a different identity than the prior release and lacks registry-visible provenance.",
                mitigation:
                  "Review maintainer changes, compare the prior release publisher, and validate provenance before upgrading execution-capable packages.",
                ruleId: "PROV-004",
              },
            ],
            repoUrl: "https://github.com/example/project",
            status: "audited",
            target: {
              bomRefs: ["pkg:npm/example@2.0.0"],
              name: "example",
              purl: "pkg:npm/example@2.0.0",
              type: "npm",
              version: "2.0.0",
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
        minSeverity: "low",
      },
    );

    assert.match(rendered, /pkg:npm\/example@2.0.0/);
    assert.match(rendered, /maintained externally/i);
    assert.match(rendered, /open an issue or discussion/i);
    assert.match(rendered, /upstream maintainers/i);
    assert.match(rendered, /Review maintainer/i);
    assert.match(rendered, /prior release publisher/i);
  });

  it("renders a clearer no-action-needed console report when nothing crosses the threshold", () => {
    const rendered = renderConsoleReport(
      {
        results: [],
        summary: {
          erroredTargets: 0,
          inputBomCount: 1,
          scannedTargets: 0,
          skippedTargets: 0,
          totalTargets: 0,
        },
      },
      {
        minSeverity: "low",
      },
    );

    assert.match(rendered, /No dependencies require your attention right now/);
    assert.match(rendered, /configured severity threshold \('low'\)/);
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

  it("does not create provenance detector findings when direct provenance evidence is present", () => {
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
          name: "cdx:npm:provenanceKeyId",
          value: "sigstore-key",
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

describe("buildPythonSourceHeuristicFindings()", () => {
  it("detects suspicious encoded execution inside setup.py", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "cdxgen-audit-py-"));
    writeFileSync(
      path.join(tempDir, "setup.py"),
      [
        "from setuptools import setup",
        "import base64",
        "import os",
        "payload = base64.b64decode('bHM=')",
        "os.system(payload.decode())",
        "setup(name='demo')",
      ].join("\n"),
    );

    try {
      const findings = buildPythonSourceHeuristicFindings(tempDir, {
        bomRefs: ["pkg:pypi/demo@1.0.0"],
        name: "demo",
        purl: "pkg:pypi/demo@1.0.0",
        type: "pypi",
        version: "1.0.0",
      });
      assert.ok(findings.some((finding) => finding.ruleId === "PYSRC-001"));
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("detects suspicious import-time behavior in __init__.py", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "cdxgen-audit-py-"));
    mkdirSync(path.join(tempDir, "demo"), { recursive: true });
    writeFileSync(
      path.join(tempDir, "demo", "__init__.py"),
      [
        "import requests",
        "import subprocess",
        "requests.get('https://example.invalid/payload')",
        "subprocess.run(['echo', 'demo'])",
      ].join("\n"),
    );

    try {
      const findings = buildPythonSourceHeuristicFindings(tempDir, {
        bomRefs: ["pkg:pypi/demo@1.0.0"],
        name: "demo",
        purl: "pkg:pypi/demo@1.0.0",
        type: "pypi",
        version: "1.0.0",
      });
      assert.ok(findings.some((finding) => finding.ruleId === "PYSRC-002"));
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("detects dynamic execution helpers such as exec in setup.py", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "cdxgen-audit-py-"));
    writeFileSync(
      path.join(tempDir, "setup.py"),
      [
        "from setuptools import setup",
        "import base64",
        "payload = base64.b64decode('cHJpbnQoJ2RlbW8nKQ==')",
        "exec(payload.decode())",
        "setup(name='demo')",
      ].join("\n"),
    );

    try {
      const findings = buildPythonSourceHeuristicFindings(tempDir, {
        bomRefs: ["pkg:pypi/demo@1.0.0"],
        name: "demo",
        purl: "pkg:pypi/demo@1.0.0",
        type: "pypi",
        version: "1.0.0",
      });
      assert.ok(findings.some((finding) => finding.ruleId === "PYSRC-001"));
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("skips oversized heuristic files before reading them", async () => {
    const readFileSyncStub = sinon
      .stub()
      .throws(new Error("should not be read"));
    const { buildPythonSourceHeuristicFindings: mockedBuildFindings } =
      await esmock("./index.js", {
        "node:fs": {
          mkdtempSync,
          readdirSync: sinon.stub().callsFake((_dirPath, options) => {
            if (options?.withFileTypes) {
              return [
                {
                  name: "setup.py",
                  isDirectory: () => false,
                  isFile: () => true,
                },
              ];
            }
            return [];
          }),
          readFileSync: readFileSyncStub,
          realpathSync,
          rmSync,
          statSync: sinon.stub().returns({ size: 256 * 1024 + 1 }),
          writeFileSync,
        },
      });

    const findings = mockedBuildFindings("/virtual/project", {
      bomRefs: ["pkg:pypi/demo@1.0.0"],
      name: "demo",
      purl: "pkg:pypi/demo@1.0.0",
      type: "pypi",
      version: "1.0.0",
    });

    assert.deepStrictEqual(findings, []);
    sinon.assert.notCalled(readFileSyncStub);
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
    assert.match(annotations[0].text, /Next action:/);
    assert.match(annotations[0].text, /open an issue or discussion/i);
    assert.match(annotations[0].text, /\| Property \| Value \|/);
    assert.match(annotations[0].text, /cdx:audit:nextAction/);
    assert.match(annotations[0].text, /cdx:audit:upstreamGuidance/);
    assert.match(annotations[0].text, /cdx:audit:engine/);
  });

  it("includes local dispatch sender-to-receiver edges in predictive annotations", () => {
    const annotations = formatPredictiveAnnotations(
      {
        results: [
          {
            assessment: {
              confidenceLabel: "high",
              reasons: ["Correlated local workflow dispatch chain."],
              score: 88,
              severity: "critical",
            },
            findings: [
              {
                category: "ci-permission",
                evidence: {
                  hasLocalDispatchReceiver: "true",
                  localReceiverWorkflowFiles: ".github/workflows/release.yml",
                  localReceiverWorkflowNames: "Release workflow",
                },
                location: {
                  file: ".github/workflows/sender.yml",
                },
                message: "Dispatch chain reaches local receiver",
                ruleId: "CI-019",
                severity: "critical",
              },
            ],
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
    assert.match(annotations[0].text, /cdx:audit:dispatch:edge/);
    assert.match(annotations[0].text, /sender\.yml.*Release workflow/);
  });
});

describe("audit reporters", () => {
  it("renders local sender-to-receiver workflow edges in console and SARIF reports", () => {
    const report = {
      generatedAt: new Date().toISOString(),
      groupedResults: [],
      inputs: ["bom.json"],
      results: [
        {
          assessment: {
            confidenceLabel: "high",
            erroredTargets: 0,
            reasons: ["Correlated local workflow dispatch chain."],
            score: 88,
            severity: "critical",
          },
          findings: [
            {
              attackTactics: ["TA0004"],
              attackTechniques: ["T1528"],
              category: "ci-permission",
              evidence: {
                hasLocalDispatchReceiver: "true",
                localReceiverMatchBasis: "workflow:release.yml",
                localReceiverWorkflowFiles: ".github/workflows/release.yml",
                localReceiverWorkflowNames: "Release workflow",
              },
              location: {
                file: ".github/workflows/sender.yml",
              },
              message: "Dispatch chain reaches local receiver",
              mitigation: "Split dispatchers from fork-reachable jobs.",
              ruleId: "CI-019",
              severity: "critical",
            },
          ],
          repoUrl: "https://github.com/example/repo",
          sourceDirectoryConfidence: "high",
          status: "audited",
          target: {
            bomRefs: ["pkg:npm/left-pad@1.3.0"],
            name: "left-pad",
            purl: "pkg:npm/left-pad@1.3.0",
            type: "npm",
            version: "1.3.0",
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
    };

    const consoleOutput = renderConsoleReport(report, { minSeverity: "low" });
    assert.match(consoleOutput, /sender\.yml -> Release workflow/);

    const sarifText = renderAuditReport("sarif", report, {
      minSeverity: "low",
    });
    const sarif = JSON.parse(sarifText);
    const sarifResult = sarif.runs[0].results[0];
    assert.match(
      sarifResult.properties.localDispatchEdge,
      /sender\.yml -> Release workflow/,
    );
    assert.strictEqual(sarifResult.relatedLocations.length, 1);
    assert.strictEqual(
      sarifResult.relatedLocations[0].physicalLocation.artifactLocation.uri,
      ".github/workflows/release.yml",
    );
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
