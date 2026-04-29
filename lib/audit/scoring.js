import { thoughtLog } from "../helpers/logger.js";
import {
  hasRegistryProvenanceEvidenceProperties,
  hasTrustedPublishingProperties,
} from "../helpers/provenanceUtils.js";

export const SEVERITY_ORDER = {
  none: -1,
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

const BASE_FINDING_WEIGHT = {
  low: 4,
  medium: 10,
  high: 18,
  critical: 30,
};

// Predictive scoring weighs dependency-source findings more heavily than generic
// CI hygiene because source mutability/local-path/git-origin issues tend to map
// more directly to reviewable upstream compromise exposure for package targets.
const CATEGORY_WEIGHT = {
  "ci-permission": 4,
  "dependency-source": 10,
  "package-integrity": 6,
};

const RULE_SPECIFIC_WEIGHT = {
  "CI-019": 16,
  "INT-009": 14,
};

const PRIORITY_CORROBORATION_RULES = new Set(["CI-019", "INT-009"]);
// Require multiple compromise-oriented signals before escalating to critical so
// a single strong heuristic or one noisy category cannot dominate the final
// predictive severity on its own.
const MIN_COMPROMISE_SIGNALS_FOR_CRITICAL = 2;
const MIN_COMPROMISE_SIGNALS_FOR_HIGH = 1;
const CI_HYGIENE_RULES = new Set([
  "CI-001",
  "CI-002",
  "CI-003",
  "CI-005",
  "CI-014",
]);
const PACKAGE_HYGIENE_RULES = new Set(["INT-001"]);
const SIGNAL_BUCKET_WEIGHT = {
  "ci-compromise": 12,
  "ci-hygiene": 2,
  "dependency-compromise": 10,
  "package-hygiene": 3,
  "package-compromise": 12,
  other: 4,
};

/**
 * Emit a short thought-log explanation for the final package risk decision.
 *
 * @param {object} target audit target descriptor
 * @param {object} assessment final predictive risk assessment
 * @returns {void}
 */
function logRiskAssessmentDecision(target, assessment) {
  const reasonPreview = Array.isArray(assessment?.reasons)
    ? assessment.reasons.slice(0, 2)
    : [];
  const indicators = {
    confidence: assessment?.confidence,
    confidenceLabel: assessment?.confidenceLabel,
    distinctCategories: assessment?.distinctCategoryCount,
    findings: assessment?.findingsCount,
    purl: target?.purl,
    reasons: reasonPreview,
    score: assessment?.score,
    severity: assessment?.severity,
    strongSignals: assessment?.strongSignalCount,
  };
  if (["medium", "high", "critical"].includes(assessment?.severity)) {
    thoughtLog("Predictive audit considered the package risky.", indicators);
    return;
  }
  thoughtLog("Predictive audit kept the package at low risk.", indicators);
}

/**
 * Clamp a number into a fixed range.
 *
 * @param {number} value input number
 * @param {number} min minimum value
 * @param {number} max maximum value
 * @returns {number} clamped number
 */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Retrieve a custom property value from a target descriptor.
 *
 * @param {object} target audit target
 * @param {string} propertyName property name
 * @returns {string | undefined} property value
 */
function getTargetProperty(target, propertyName) {
  return target?.properties?.find((property) => property.name === propertyName)
    ?.value;
}

function getTargetListProperty(target, propertyName) {
  const propertyValue = getTargetProperty(target, propertyName);
  if (!propertyValue || typeof propertyValue !== "string") {
    return [];
  }
  return propertyValue
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function getCargoPredictiveSignals(target) {
  const buildScriptCapabilities = getTargetListProperty(
    target,
    "cdx:cargo:buildScriptCapabilities",
  );
  const nativeBuildIndicators = getTargetListProperty(
    target,
    "cdx:cargo:nativeBuildIndicators",
  );
  return {
    buildDependency:
      getTargetProperty(target, "cdx:cargo:dependencyKind") === "build",
    buildScript:
      getTargetProperty(target, "cdx:cargo:hasBuildScript") === "true",
    nativeBuild:
      getTargetProperty(target, "cdx:cargo:hasNativeBuild") === "true",
    networkCapableBuildScript:
      buildScriptCapabilities.includes("network-access"),
    processCapableBuildScript:
      buildScriptCapabilities.includes("process-execution"),
    runtimeFacing: Boolean(target?.runtimeFacingCargo),
    workspaceDependency:
      getTargetProperty(target, "cdx:cargo:workspaceDependencyResolved") ===
      "true",
    buildOnlyWorkspace: Boolean(target?.buildOnlyWorkspace),
    yanked: getTargetProperty(target, "cdx:cargo:yanked") === "true",
    buildScriptCapabilities,
    nativeBuildIndicators,
  };
}

/**
 * Classify a finding into a coarse signal bucket for conservative scoring.
 *
 * @param {object} finding predictive audit finding
 * @returns {"ci-hygiene" | "ci-compromise" | "dependency-compromise" | "package-hygiene" | "package-compromise" | "other"} signal bucket
 */
function classifyFindingSignalBucket(finding) {
  if (finding?.category === "ci-permission") {
    return CI_HYGIENE_RULES.has(finding?.ruleId)
      ? "ci-hygiene"
      : "ci-compromise";
  }
  if (finding?.category === "package-integrity") {
    return PACKAGE_HYGIENE_RULES.has(finding?.ruleId)
      ? "package-hygiene"
      : "package-compromise";
  }
  if (finding?.category === "dependency-source") {
    return "dependency-compromise";
  }
  return "other";
}

/**
 * Convert a numeric confidence score into a human readable label.
 *
 * @param {number} confidence confidence score
 * @returns {string} confidence label
 */
export function confidenceLabel(confidence) {
  if (confidence >= 0.85) {
    return "high";
  }
  if (confidence >= 0.6) {
    return "medium";
  }
  return "low";
}

/**
 * Check if a severity meets the given threshold.
 *
 * @param {string} severity severity to compare
 * @param {string} threshold threshold severity
 * @returns {boolean} true if severity is at or above threshold
 */
export function severityMeetsThreshold(severity, threshold) {
  const resolvedSeverity = SEVERITY_ORDER[severity] ?? SEVERITY_ORDER.none;
  const resolvedThreshold = SEVERITY_ORDER[threshold] ?? SEVERITY_ORDER.low;
  return resolvedSeverity >= resolvedThreshold;
}

/**
 * Conservatively score predictive supply-chain risk for a single target.
 *
 * High and critical require corroboration across categories and strong findings,
 * which keeps false positives low.
 *
 * @param {object[]} findings post-generation audit findings
 * @param {object} target target metadata
 * @param {object} context additional scan context
 * @returns {object} conservative risk assessment
 */
export function scoreTargetRisk(findings, target, context = {}) {
  if (!Array.isArray(findings) || findings.length === 0) {
    const explicitReason =
      context?.skipReason ||
      context?.scanErrorReason ||
      context?.errorMessage ||
      (context?.scanError
        ? `Predictive audit for '${target.purl}' could not complete successfully.`
        : `${target.type} package '${target.purl}' did not trigger any predictive audit rules.`);
    const assessment = {
      categoryCounts: {},
      confidence: 0.35,
      confidenceLabel: "low",
      distinctCategoryCount: 0,
      findingsCount: 0,
      formulationSignalCount: 0,
      reasons: [explicitReason],
      score: 0,
      severity: "none",
      strongSignalCount: 0,
    };
    logRiskAssessmentDecision(target, assessment);
    return assessment;
  }
  const categoryCounts = {};
  const attackTactics = new Set();
  const attackTechniques = new Set();
  const distinctCategories = new Set();
  const matchedPriorityRules = new Set();
  let score = 0;
  let strongSignalCount = 0;
  let ciCompromiseSignalCount = 0;
  let ciHygieneSignalCount = 0;
  let formulationSignalCount = 0;
  let compromiseSignalCount = 0;
  let packageIntegrityCompromiseSignalCount = 0;
  let packageIntegrityHygieneSignalCount = 0;
  let priorityCorroborationCount = 0;
  let cargoBuildSignalCount = 0;
  for (const finding of findings) {
    const findingSeverity = finding?.severity || "low";
    const findingCategory = finding?.category || "unknown";
    const signalBucket = classifyFindingSignalBucket(finding);
    let findingScore = BASE_FINDING_WEIGHT[findingSeverity] ?? 4;
    findingScore += CATEGORY_WEIGHT[findingCategory] ?? 4;
    findingScore +=
      SIGNAL_BUCKET_WEIGHT[signalBucket] ?? SIGNAL_BUCKET_WEIGHT.other;
    findingScore += RULE_SPECIFIC_WEIGHT[finding?.ruleId] ?? 0;
    if (target?.type === "cargo") {
      const cargoSignals = getCargoPredictiveSignals(target);
      if (
        ["dependency-compromise", "package-compromise"].includes(
          signalBucket,
        ) &&
        cargoSignals.nativeBuild
      ) {
        findingScore += 6;
        cargoBuildSignalCount += 1;
      }
      if (
        signalBucket === "package-compromise" &&
        (cargoSignals.processCapableBuildScript ||
          cargoSignals.networkCapableBuildScript)
      ) {
        findingScore += 4;
        cargoBuildSignalCount += 1;
      }
      if (
        signalBucket === "dependency-compromise" &&
        (cargoSignals.buildDependency || cargoSignals.workspaceDependency)
      ) {
        findingScore += 3;
        cargoBuildSignalCount += 1;
      }
      if (
        ["dependency-compromise", "package-compromise"].includes(
          signalBucket,
        ) &&
        cargoSignals.runtimeFacing
      ) {
        findingScore += 2;
      }
      if (
        cargoSignals.buildOnlyWorkspace &&
        !cargoSignals.runtimeFacing &&
        signalBucket !== "ci-compromise"
      ) {
        findingScore -= 2;
      }
      if (finding?.ruleId === "PROV-015" && cargoSignals.yanked) {
        findingScore += cargoSignals.nativeBuild ? 8 : 4;
      }
    }
    if (signalBucket === "ci-hygiene") {
      ciHygieneSignalCount += 1;
    } else if (signalBucket === "ci-compromise") {
      ciCompromiseSignalCount += 1;
    } else if (signalBucket === "package-compromise") {
      packageIntegrityCompromiseSignalCount += 1;
    } else if (signalBucket === "package-hygiene") {
      packageIntegrityHygieneSignalCount += 1;
    }
    if (
      finding?.ruleId?.startsWith("CI-") ||
      finding?.location?.file?.includes(".github/workflows")
    ) {
      formulationSignalCount += 1;
      findingScore += signalBucket === "ci-hygiene" ? 1 : 4;
    }
    if (["high", "critical"].includes(findingSeverity)) {
      strongSignalCount += 1;
      if (
        signalBucket === "ci-compromise" ||
        signalBucket === "dependency-compromise" ||
        signalBucket === "package-compromise"
      ) {
        compromiseSignalCount += 1;
      }
    }
    if (PRIORITY_CORROBORATION_RULES.has(finding?.ruleId)) {
      priorityCorroborationCount += 1;
      matchedPriorityRules.add(finding.ruleId);
    }
    (finding?.attackTactics || finding?.attack?.tactics || []).forEach((id) => {
      if (id) {
        attackTactics.add(id);
      }
    });
    (finding?.attackTechniques || finding?.attack?.techniques || []).forEach(
      (id) => {
        if (id) {
          attackTechniques.add(id);
        }
      },
    );
    categoryCounts[findingCategory] =
      (categoryCounts[findingCategory] || 0) + 1;
    distinctCategories.add(findingCategory);
    score += findingScore;
  }
  score += Math.max(0, distinctCategories.size - 1) * 8;
  score += Math.max(0, strongSignalCount - 1) * 10;
  score += Math.max(0, formulationSignalCount - 1) * 2;
  if (target?.type === "cargo" && cargoBuildSignalCount > 0) {
    score += Math.min(cargoBuildSignalCount, 3) * 3;
  }
  if (
    target?.type === "cargo" &&
    target?.buildOnlyWorkspace &&
    !target?.runtimeFacingCargo
  ) {
    score = Math.max(0, score - 3);
  }

  const hasTrustedPublishing = hasTrustedPublishingProperties(
    target?.properties,
  );
  const hasProvenanceEvidence = hasRegistryProvenanceEvidenceProperties(
    target?.properties,
  );
  const hasVerifiedPublisher =
    getTargetProperty(target, "cdx:pypi:uploaderVerified") === "true";
  let provenanceDiscount = 0;
  if (hasProvenanceEvidence) {
    provenanceDiscount += 4;
  }
  if (hasTrustedPublishing) {
    provenanceDiscount += 6;
  }
  if (hasVerifiedPublisher) {
    provenanceDiscount += 2;
  }
  score -= Math.min(provenanceDiscount, 10);
  if (score < 0) {
    score = 0;
  }

  const effectiveStrongSignalCount =
    strongSignalCount + priorityCorroborationCount;

  let confidence = 0.45;
  if (context?.resolution?.repoUrl) {
    confidence += 0.15;
  }
  if (target?.version) {
    confidence += 0.1;
  }
  if (context?.versionMatched) {
    confidence += 0.1;
  }
  if (context?.bomJson?.formulation?.length) {
    confidence += 0.15;
  }
  if (context?.sourceDirectoryConfidence === "high") {
    confidence += 0.05;
  }
  if (context?.sourceDirectoryConfidence === "low") {
    confidence -= 0.1;
  }
  if (context?.scanError) {
    confidence -= 0.35;
  }
  if (!context?.resolution?.repoUrl) {
    confidence -= 0.2;
  }
  confidence = clamp(confidence, 0.05, 0.95);

  let severity = "low";
  if (score >= 84) {
    severity = "critical";
  } else if (score >= 52) {
    severity = "high";
  } else if (score >= 24) {
    severity = "medium";
  }

  if (
    severity === "critical" &&
    (effectiveStrongSignalCount < 3 ||
      compromiseSignalCount < MIN_COMPROMISE_SIGNALS_FOR_CRITICAL ||
      distinctCategories.size < 2 ||
      confidence < 0.85)
  ) {
    severity = "high";
  }
  if (
    severity === "high" &&
    (effectiveStrongSignalCount < 2 ||
      compromiseSignalCount < MIN_COMPROMISE_SIGNALS_FOR_HIGH ||
      distinctCategories.size < 2 ||
      confidence < 0.65)
  ) {
    severity = "medium";
  }
  if (context?.scanError && severityMeetsThreshold(severity, "high")) {
    severity = "medium";
  }

  const reasons = [];
  if (ciHygieneSignalCount > 0) {
    reasons.push(
      `${ciHygieneSignalCount} CI hygiene signal(s) were observed in GitHub Actions or privileged workflow configuration.`,
    );
  }
  if (ciCompromiseSignalCount > 0) {
    reasons.push(
      `${ciCompromiseSignalCount} compromise-oriented CI signal(s) increased the predictive risk score.`,
    );
  }
  if (target?.type === "cargo" && cargoBuildSignalCount > 0) {
    const cargoSignals = getCargoPredictiveSignals(target);
    const cargoReasonParts = [];
    if (cargoSignals.nativeBuild) {
      cargoReasonParts.push("native build tooling");
    }
    if (cargoSignals.processCapableBuildScript) {
      cargoReasonParts.push("process-capable build scripts");
    }
    if (cargoSignals.networkCapableBuildScript) {
      cargoReasonParts.push("network-capable build scripts");
    }
    if (cargoSignals.workspaceDependency) {
      cargoReasonParts.push("workspace-resolved member dependencies");
    }
    if (cargoSignals.runtimeFacing) {
      cargoReasonParts.push("runtime-facing crate exposure");
    }
    if (cargoSignals.buildOnlyWorkspace && !cargoSignals.runtimeFacing) {
      cargoReasonParts.push("build-only workspace helper role");
    }
    if (cargoReasonParts.length) {
      reasons.push(
        `Cargo build-surface signals (${cargoReasonParts.join(", ")}) increased the predictive review priority.`,
      );
    }
  }
  if (packageIntegrityCompromiseSignalCount > 0) {
    reasons.push(
      `${packageIntegrityCompromiseSignalCount} package-integrity compromise signal(s) corroborated the package risk posture.`,
    );
  }
  if (packageIntegrityHygieneSignalCount > 0) {
    reasons.push(
      `${packageIntegrityHygieneSignalCount} package-integrity hygiene signal(s) were recorded for review.`,
    );
  }
  if (distinctCategories.size > 1) {
    reasons.push(
      `${distinctCategories.size} distinct rule categories corroborated the package risk posture.`,
    );
  }
  if (strongSignalCount > 0) {
    reasons.push(
      `${strongSignalCount} strong finding(s) were observed across the generated source SBOM.`,
    );
  }
  if (priorityCorroborationCount > 0) {
    reasons.push(
      `${priorityCorroborationCount} high-confidence compound rule(s) received additional predictive weight (${Array.from(matchedPriorityRules).join(", ")}).`,
    );
  }
  if (attackTactics.size > 0 || attackTechniques.size > 0) {
    reasons.push(
      `${attackTactics.size} ATT&CK tactic(s) and ${attackTechniques.size} ATT&CK technique(s) were implicated by the audit findings.`,
    );
  }
  if (hasTrustedPublishing || hasProvenanceEvidence || hasVerifiedPublisher) {
    reasons.push(
      "Registry provenance or trusted-publishing evidence reduced the final predictive score.",
    );
  }
  if (reasons.length === 0) {
    reasons.push(
      `Findings remained isolated, so severity stayed conservative for '${target.purl}'.`,
    );
  }

  const assessment = {
    categoryCounts,
    attackTacticCount: attackTactics.size,
    attackTechniqueCount: attackTechniques.size,
    confidence,
    confidenceLabel: confidenceLabel(confidence),
    ciCompromiseSignalCount,
    ciHygieneSignalCount,
    distinctCategoryCount: distinctCategories.size,
    findingsCount: findings.length,
    formulationSignalCount,
    packageIntegrityCompromiseSignalCount,
    packageIntegrityHygieneSignalCount,
    priorityCorroborationCount,
    reasons,
    score,
    severity,
    strongSignalCount,
  };
  logRiskAssessmentDecision(target, assessment);
  return assessment;
}
