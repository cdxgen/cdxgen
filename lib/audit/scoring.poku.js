import { assert, describe, it } from "poku";

import {
  confidenceLabel,
  scoreTargetRisk,
  severityMeetsThreshold,
} from "./scoring.js";

const baseTarget = {
  name: "left-pad",
  purl: "pkg:npm/left-pad@1.3.0",
  type: "npm",
  version: "1.3.0",
};

describe("confidenceLabel()", () => {
  it("maps numeric confidence to the expected buckets", () => {
    assert.strictEqual(confidenceLabel(0.2), "low");
    assert.strictEqual(confidenceLabel(0.7), "medium");
    assert.strictEqual(confidenceLabel(0.9), "high");
  });
});

describe("severityMeetsThreshold()", () => {
  it("compares severities in the expected order", () => {
    assert.strictEqual(severityMeetsThreshold("high", "medium"), true);
    assert.strictEqual(severityMeetsThreshold("low", "high"), false);
    assert.strictEqual(severityMeetsThreshold("none", "low"), false);
  });
});

describe("scoreTargetRisk()", () => {
  it("keeps a single strong signal at medium to reduce false positives", () => {
    const findings = [
      {
        attackTactics: ["TA0001", "TA0004"],
        attackTechniques: ["T1195.001"],
        category: "ci-permission",
        location: {
          file: ".github/workflows/release.yml",
        },
        message: "Unpinned privileged action",
        ruleId: "CI-001",
        severity: "high",
      },
    ];

    const assessment = scoreTargetRisk(findings, baseTarget, {
      bomJson: {
        formulation: [{}],
      },
      resolution: {
        repoUrl: "https://github.com/example/repo",
      },
      sourceDirectoryConfidence: "high",
      versionMatched: true,
    });

    assert.strictEqual(assessment.severity, "medium");
    assert.strictEqual(assessment.attackTacticCount, 2);
    assert.strictEqual(assessment.attackTechniqueCount, 1);
    assert.ok(assessment.score > 0);
    assert.match(assessment.reasons.join(" "), /ATT&CK tactic/i);
  });

  it("escalates to high only when independent signals corroborate the risk", () => {
    const findings = [
      {
        category: "ci-permission",
        location: {
          file: ".github/workflows/release.yml",
        },
        message: "Unpinned privileged action",
        ruleId: "CI-001",
        severity: "high",
      },
      {
        category: "dependency-source",
        location: {
          purl: baseTarget.purl,
        },
        message: "Install script from non-registry source",
        ruleId: "PKG-001",
        severity: "high",
      },
    ];

    const assessment = scoreTargetRisk(findings, baseTarget, {
      bomJson: {
        formulation: [{}],
      },
      resolution: {
        repoUrl: "https://github.com/example/repo",
      },
      sourceDirectoryConfidence: "high",
      versionMatched: true,
    });

    assert.strictEqual(assessment.severity, "high");
    assert.strictEqual(assessment.distinctCategoryCount, 2);
  });

  it("requires multiple corroborated strong signals before allowing critical", () => {
    const findings = [
      {
        category: "ci-permission",
        location: {
          file: ".github/workflows/release.yml",
        },
        message: "Untrusted interpolation in shell step",
        ruleId: "CI-007",
        severity: "critical",
      },
      {
        category: "dependency-source",
        location: {
          purl: baseTarget.purl,
        },
        message: "Install script from non-registry source",
        ruleId: "PKG-001",
        severity: "high",
      },
      {
        category: "package-integrity",
        location: {
          purl: baseTarget.purl,
        },
        message: "Name mismatch",
        ruleId: "INT-002",
        severity: "high",
      },
    ];

    const assessment = scoreTargetRisk(findings, baseTarget, {
      bomJson: {
        formulation: [{ workflows: [] }],
      },
      resolution: {
        repoUrl: "https://github.com/example/repo",
      },
      sourceDirectoryConfidence: "high",
      versionMatched: true,
    });

    assert.strictEqual(assessment.severity, "critical");
    assert.ok(assessment.confidence >= 0.85);
  });

  it("downgrades severity when the scan encountered an error", () => {
    const findings = [
      {
        category: "ci-permission",
        location: {
          file: ".github/workflows/release.yml",
        },
        message: "Untrusted interpolation in shell step",
        ruleId: "CI-007",
        severity: "critical",
      },
      {
        category: "dependency-source",
        location: {
          purl: baseTarget.purl,
        },
        message: "Install script from non-registry source",
        ruleId: "PKG-001",
        severity: "high",
      },
    ];

    const assessment = scoreTargetRisk(findings, baseTarget, {
      bomJson: {
        formulation: [{ workflows: [] }],
      },
      resolution: {
        repoUrl: "https://github.com/example/repo",
      },
      scanError: true,
      sourceDirectoryConfidence: "low",
      versionMatched: false,
    });

    assert.strictEqual(assessment.severity, "medium");
  });

  it("reduces the final score when trusted publishing evidence is present", () => {
    const findings = [
      {
        category: "dependency-source",
        location: {
          purl: baseTarget.purl,
        },
        message: "Install script from non-registry source",
        ruleId: "PKG-001",
        severity: "high",
      },
    ];

    const withoutProvenance = scoreTargetRisk(findings, baseTarget, {
      resolution: {
        repoUrl: "https://github.com/example/repo",
      },
      versionMatched: true,
    });
    const withProvenance = scoreTargetRisk(
      findings,
      {
        ...baseTarget,
        properties: [
          {
            name: "cdx:npm:provenanceUrl",
            value: "https://registry.npmjs.org/-/npm/v1/attestations/example",
          },
          { name: "cdx:npm:trustedPublishing", value: "true" },
        ],
      },
      {
        resolution: {
          repoUrl: "https://github.com/example/repo",
        },
        versionMatched: true,
      },
    );

    assert.ok(withProvenance.score < withoutProvenance.score);
    assert.match(
      withProvenance.reasons.join(" "),
      /trusted-publishing evidence/i,
    );
  });

  it("reduces the final score when direct provenance evidence properties are present", () => {
    const findings = [
      {
        category: "dependency-source",
        location: {
          purl: baseTarget.purl,
        },
        message: "Install script from non-registry source",
        ruleId: "PKG-001",
        severity: "high",
      },
    ];

    const withoutEvidence = scoreTargetRisk(findings, baseTarget, {
      resolution: {
        repoUrl: "https://github.com/example/repo",
      },
      versionMatched: true,
    });
    const withEvidence = scoreTargetRisk(
      findings,
      {
        ...baseTarget,
        properties: [
          {
            name: "cdx:npm:provenanceKeyId",
            value: "sigstore-key",
          },
        ],
      },
      {
        resolution: {
          repoUrl: "https://github.com/example/repo",
        },
        versionMatched: true,
      },
    );

    assert.ok(withEvidence.score < withoutEvidence.score);
  });

  it("keeps isolated CI-019 findings conservative despite the rule-specific bonus", () => {
    const findings = [
      {
        category: "ci-permission",
        location: {
          file: ".github/workflows/dispatch.yml",
        },
        message: "Fork-aware dispatch chain",
        ruleId: "CI-019",
        severity: "critical",
      },
    ];

    const assessment = scoreTargetRisk(findings, baseTarget, {
      bomJson: {
        formulation: [{ workflows: [] }],
      },
      resolution: {
        repoUrl: "https://github.com/example/repo",
      },
      sourceDirectoryConfidence: "high",
      versionMatched: true,
    });

    assert.strictEqual(assessment.severity, "medium");
    assert.ok(assessment.priorityCorroborationCount >= 1);
  });

  it("escalates CI-019 plus INT-009 to critical at high confidence", () => {
    const findings = [
      {
        category: "ci-permission",
        location: {
          file: ".github/workflows/dispatch.yml",
        },
        message: "Fork-aware dispatch chain",
        ruleId: "CI-019",
        severity: "critical",
      },
      {
        category: "package-integrity",
        location: {
          purl: baseTarget.purl,
        },
        message: "Obfuscated install hook",
        ruleId: "INT-009",
        severity: "critical",
      },
    ];

    const assessment = scoreTargetRisk(findings, baseTarget, {
      bomJson: {
        formulation: [{ workflows: [] }],
      },
      resolution: {
        repoUrl: "https://github.com/example/repo",
      },
      sourceDirectoryConfidence: "high",
      versionMatched: true,
    });

    assert.strictEqual(assessment.severity, "critical");
    assert.ok(assessment.priorityCorroborationCount >= 2);
    assert.match(
      assessment.reasons.join(" "),
      /high-confidence compound rule/i,
    );
  });
});
