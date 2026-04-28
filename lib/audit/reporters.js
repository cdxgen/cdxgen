import { buildAnnotationText } from "../helpers/annotationFormatter.js";
import { getTimestamp } from "../helpers/utils.js";
import { severityMeetsThreshold } from "./scoring.js";

const SARIF_VERSION = "2.1.0";
const SARIF_SCHEMA =
  "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/Schemata/sarif-schema-2.1.0.json";
const AUDIT_ERROR_RULE_ID = "AUDIT-ERROR";

/**
 * Filter results by final severity threshold.
 *
 * @param {object[]} results results list
 * @param {string} minSeverity threshold severity
 * @returns {object[]} filtered results
 */
function filterResults(results, minSeverity) {
  return results.filter((result) =>
    severityMeetsThreshold(result?.assessment?.severity || "none", minSeverity),
  );
}

function effectiveResults(report) {
  return report.groupedResults?.length
    ? report.groupedResults
    : report.results || [];
}

function severityToSarifLevel(severity) {
  switch (severity) {
    case "critical":
    case "high":
      return "error";
    case "medium":
      return "warning";
    default:
      return "note";
  }
}

function targetSarifLocations(result, findingLocation) {
  const bomRef =
    findingLocation?.bomRef ||
    result?.target?.bomRefs?.[0] ||
    result?.target?.purl ||
    result?.grouping?.label;
  if (findingLocation?.file) {
    return [
      {
        physicalLocation: {
          artifactLocation: {
            uri: findingLocation.file,
          },
        },
        logicalLocations: bomRef
          ? [{ fullyQualifiedName: bomRef, kind: "package" }]
          : undefined,
      },
    ];
  }
  if (bomRef) {
    return [
      {
        logicalLocations: [{ fullyQualifiedName: bomRef, kind: "package" }],
      },
    ];
  }
  return [
    {
      logicalLocations: [{ fullyQualifiedName: "cdx-audit", kind: "tool" }],
    },
  ];
}

function resultProperties(result) {
  const properties = {
    auditSeverity: result?.assessment?.severity || "none",
    confidence: result?.assessment?.confidenceLabel,
    reasons: result?.assessment?.reasons || [],
    score: result?.assessment?.score,
    status: result?.status,
    target: {
      bomRefs: result?.target?.bomRefs || [],
      name: result?.target?.name,
      namespace: result?.target?.namespace,
      purl: result?.target?.purl,
      type: result?.target?.type,
      version: result?.target?.version,
    },
  };
  if (result?.grouping) {
    properties.grouping = result.grouping;
  }
  if (result?.repoUrl) {
    properties.repoUrl = result.repoUrl;
  }
  if (result?.sourceDirectoryConfidence) {
    properties.sourceDirectoryConfidence = result.sourceDirectoryConfidence;
  }
  return properties;
}

function deriveSarifRules(entries) {
  const rulesById = new Map();
  for (const entry of entries) {
    if (rulesById.has(entry.ruleId)) {
      continue;
    }
    rulesById.set(entry.ruleId, {
      id: entry.ruleId,
      name: entry.name || entry.ruleId,
      shortDescription: {
        text: entry.name || entry.ruleId,
      },
      fullDescription: {
        text: entry.description || entry.name || entry.ruleId,
      },
      defaultConfiguration: {
        level: severityToSarifLevel(entry.severity),
      },
      properties: {
        category: entry.category,
        engine: entry.engine || "cdx-audit",
      },
      help: entry.mitigation
        ? {
            text: entry.mitigation,
            markdown: `**Remediation:** ${entry.mitigation}`,
          }
        : undefined,
    });
  }
  return [...rulesById.values()];
}

function findingToSarifResult(finding, result) {
  return {
    level: severityToSarifLevel(
      finding?.severity || result?.assessment?.severity,
    ),
    locations: targetSarifLocations(result, finding?.location),
    message: {
      text: finding?.message || finding?.description || finding?.ruleId,
    },
    properties: {
      ...resultProperties(result),
      category: finding?.category,
      mitigation: finding?.mitigation,
      severity: finding?.severity,
    },
    ruleId: finding?.ruleId || AUDIT_ERROR_RULE_ID,
  };
}

function errorToSarifEntry(result) {
  const severity = result?.assessment?.severity || "high";
  return {
    category: result?.errorType || "runtime",
    description:
      "cdx-audit could not complete predictive analysis for the resolved target.",
    message: result?.error || "cdx-audit failed to analyze the target.",
    name: "Target analysis error",
    ruleId: AUDIT_ERROR_RULE_ID,
    severity,
  };
}

export function renderSarifReport(report, options = {}) {
  const minSeverity = options.minSeverity || "low";
  const visibleResults = filterResults(effectiveResults(report), minSeverity);
  const entries = [];
  const sarifResults = [];
  for (const result of visibleResults) {
    if (result?.findings?.length) {
      for (const finding of result.findings) {
        entries.push(finding);
        sarifResults.push(findingToSarifResult(finding, result));
      }
      continue;
    }
    if (result?.error) {
      const errorEntry = errorToSarifEntry(result);
      entries.push(errorEntry);
      sarifResults.push(findingToSarifResult(errorEntry, result));
    }
  }
  const toolName = report?.tool?.name || "cdx-audit";
  const toolVersion = report?.tool?.version || "v12";
  const log = {
    $schema: SARIF_SCHEMA,
    version: SARIF_VERSION,
    runs: [
      {
        tool: {
          driver: {
            informationUri: "https://cdxgen.github.io/cdxgen/",
            name: toolName,
            rules: deriveSarifRules(entries),
            version: toolVersion,
          },
        },
        invocations: [
          {
            executionSuccessful: report?.summary?.erroredTargets === 0,
          },
        ],
        properties: {
          aggregateReportFile: report?.aggregateReportFile,
          generatedAt: report?.generatedAt,
          inputs: report?.inputs || [],
          summary: report?.summary,
        },
        results: sarifResults,
      },
    ],
  };
  return `${JSON.stringify(log, null, 2)}\n`;
}

/**
 * Render an audit report as pretty JSON.
 *
 * @param {object} report aggregate report
 * @returns {string} JSON output
 */
export function renderJsonReport(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/**
 * Render an audit report for terminal output.
 *
 * @param {object} report aggregate report
 * @param {object} options render options
 * @returns {string} console report text
 */
export function renderConsoleReport(report, options = {}) {
  const minSeverity = options.minSeverity || "low";
  const visibleResults = filterResults(effectiveResults(report), minSeverity);
  const lines = [];
  lines.push("cdx-audit — predictive supply-chain exposure audit");
  lines.push("");
  lines.push(`Input BOMs: ${report.summary.inputBomCount}`);
  lines.push(`Candidate targets: ${report.summary.totalTargets}`);
  lines.push(`Scanned targets: ${report.summary.scannedTargets}`);
  lines.push(`Errored targets: ${report.summary.erroredTargets}`);
  lines.push(`Skipped targets: ${report.summary.skippedTargets}`);
  if (report.summary.groupedResultCount) {
    lines.push(
      `Consolidated alert groups: ${report.summary.groupedResultCount}`,
    );
  }
  lines.push("");
  if (!visibleResults.length) {
    lines.push(`No targets at or above severity '${minSeverity}'.`);
    return `${lines.join("\n")}\n`;
  }
  lines.push(`Targets at or above severity '${minSeverity}':`);
  lines.push("");
  for (const result of visibleResults) {
    const packageLabel = result.grouping?.label
      ? result.grouping.label
      : `${result.target.type}:${result.target.name}`;
    const packageVersion = result.target.version
      ? `@${result.target.version}`
      : "";
    lines.push(
      `- [${result.assessment.severity.toUpperCase()}] ${packageLabel}${packageVersion} score=${result.assessment.score} confidence=${result.assessment.confidenceLabel}`,
    );
    if (result.grouping?.memberCount > 1) {
      lines.push(
        `  grouped packages: ${result.grouping.memberCount} (${result.grouping.groupedPurls.slice(0, 3).join(", ")}${result.grouping.groupedPurls.length > 3 ? ", …" : ""})`,
      );
    }
    if (result.assessment.reasons?.length) {
      lines.push(`  reason: ${result.assessment.reasons[0]}`);
    }
    if (result.findings?.length) {
      lines.push(
        `  top finding: ${result.findings[0].ruleId} — ${result.findings[0].message}`,
      );
    }
    if (result.error) {
      lines.push(`  error: ${result.error}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Render the requested report format.
 *
 * @param {string} reportType format name
 * @param {object} report aggregate report
 * @param {object} options render options
 * @returns {string} rendered report
 */
export function renderAuditReport(reportType, report, options = {}) {
  if ((reportType || "console") === "json") {
    return renderJsonReport(report);
  }
  if ((reportType || "console") === "sarif") {
    return renderSarifReport(report, options);
  }
  return renderConsoleReport(report, options);
}

/**
 * Convert predictive audit results into CycloneDX annotations.
 *
 * @param {object} report aggregate audit report
 * @param {object} bomJson root CycloneDX BOM
 * @param {object} [options] annotation options
 * @returns {object[]} annotations
 */
export function formatPredictiveAnnotations(report, bomJson, options = {}) {
  const cdxgenAnnotator = bomJson?.metadata?.tools?.components?.find(
    (component) => component.name === "cdxgen",
  );
  if (!cdxgenAnnotator) {
    return [];
  }
  const minSeverity = options.minSeverity || "low";
  const actionableResults = filterResults(
    report.results || [],
    minSeverity,
  ).filter((result) => (result?.assessment?.severity || "none") !== "none");
  return actionableResults.map((result) => {
    const properties = [
      { name: "cdx:audit:engine", value: "cdx-audit" },
      { name: "cdx:audit:severity", value: result.assessment.severity },
      {
        name: "cdx:audit:confidence",
        value: result.assessment.confidenceLabel,
      },
      { name: "cdx:audit:score", value: String(result.assessment.score) },
      { name: "cdx:audit:target:purl", value: result.target.purl },
    ];
    if (result.repoUrl) {
      properties.push({
        name: "cdx:audit:target:repoUrl",
        value: result.repoUrl,
      });
    }
    if (result.findings?.length) {
      properties.push({
        name: "cdx:audit:topFinding:ruleId",
        value: result.findings[0].ruleId,
      });
    }
    return {
      annotator: {
        component: cdxgenAnnotator,
      },
      subjects: result.target.bomRefs?.length
        ? result.target.bomRefs
        : [bomJson.serialNumber],
      text: buildAnnotationText(
        `Predictive audit score ${result.assessment.score} (${result.assessment.severity}) for ${result.target.purl}.`,
        properties,
        [result.assessment.reasons?.[0] || ""],
      ),
      timestamp: getTimestamp(),
    };
  });
}
