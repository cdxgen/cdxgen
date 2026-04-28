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

const CATEGORY_WEIGHT = {
  "ci-permission": 12,
  "dependency-source": 8,
  "package-integrity": 6,
};

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
    return {
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
  }
  const categoryCounts = {};
  const distinctCategories = new Set();
  let score = 0;
  let strongSignalCount = 0;
  let ciSignalCount = 0;
  let formulationSignalCount = 0;
  for (const finding of findings) {
    const findingSeverity = finding?.severity || "low";
    const findingCategory = finding?.category || "unknown";
    let findingScore = BASE_FINDING_WEIGHT[findingSeverity] ?? 4;
    findingScore += CATEGORY_WEIGHT[findingCategory] ?? 4;
    if (findingCategory === "ci-permission") {
      ciSignalCount += 1;
      findingScore += 8;
    }
    if (
      finding?.ruleId?.startsWith("CI-") ||
      finding?.location?.file?.includes(".github/workflows")
    ) {
      formulationSignalCount += 1;
      findingScore += 8;
    }
    if (["high", "critical"].includes(findingSeverity)) {
      strongSignalCount += 1;
    }
    categoryCounts[findingCategory] =
      (categoryCounts[findingCategory] || 0) + 1;
    distinctCategories.add(findingCategory);
    score += findingScore;
  }
  score += Math.max(0, distinctCategories.size - 1) * 8;
  score += Math.max(0, strongSignalCount - 1) * 10;
  score += Math.max(0, formulationSignalCount - 1) * 6;

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
    (strongSignalCount < 3 ||
      distinctCategories.size < 2 ||
      ciSignalCount < 1 ||
      confidence < 0.85)
  ) {
    severity = "high";
  }
  if (
    severity === "high" &&
    (strongSignalCount < 2 || distinctCategories.size < 2 || confidence < 0.65)
  ) {
    severity = "medium";
  }
  if (context?.scanError && severityMeetsThreshold(severity, "high")) {
    severity = "medium";
  }

  const reasons = [];
  if (ciSignalCount > 0) {
    reasons.push(
      `${ciSignalCount} GitHub Actions or privileged workflow signal(s) increased the predictive risk score.`,
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

  return {
    categoryCounts,
    confidence,
    confidenceLabel: confidenceLabel(confidence),
    distinctCategoryCount: distinctCategories.size,
    findingsCount: findings.length,
    formulationSignalCount,
    reasons,
    score,
    severity,
    strongSignalCount,
  };
}
