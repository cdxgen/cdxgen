import { buildAnnotationText } from "../helpers/annotationFormatter.js";
import { table } from "../helpers/table.js";
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

function formatAnalysisErrorCounts(summary) {
  const entries = Object.entries(summary?.analysisErrorCounts || {});
  if (!entries.length) {
    return undefined;
  }
  return entries
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([errorType, count]) => `${errorType}: ${count}`)
    .join(", ");
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

function splitCsv(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function extractLocalDispatchEdge(finding) {
  const senderFile = finding?.location?.file;
  const receiverFiles = splitCsv(finding?.evidence?.localReceiverWorkflowFiles);
  const receiverNames = splitCsv(finding?.evidence?.localReceiverWorkflowNames);
  const matchBasis = splitCsv(finding?.evidence?.localReceiverMatchBasis);
  const hasLocalDispatchReceiver =
    finding?.evidence?.hasLocalDispatchReceiver === "true" ||
    receiverFiles.length > 0 ||
    receiverNames.length > 0;
  if (!senderFile || !hasLocalDispatchReceiver) {
    return undefined;
  }
  return {
    matchBasis,
    receiverFiles,
    receiverNames,
    senderFile,
  };
}

function formatLocalDispatchEdge(edge) {
  if (!edge) {
    return undefined;
  }
  const receiverLabel = edge.receiverNames[0] || edge.receiverFiles[0];
  if (!receiverLabel) {
    return undefined;
  }
  return `${edge.senderFile} -> ${receiverLabel}`;
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

function findingProperties(finding) {
  const properties = {
    attackTactics: finding?.attackTactics,
    attackTechniques: finding?.attackTechniques,
    category: finding?.category,
    mitigation: finding?.mitigation,
    severity: finding?.severity,
    tags: attackTags(finding),
  };
  const localDispatchEdge = extractLocalDispatchEdge(finding);
  if (localDispatchEdge) {
    properties.localDispatchEdge = formatLocalDispatchEdge(localDispatchEdge);
    properties.localDispatchReceiverFiles = localDispatchEdge.receiverFiles;
    properties.localDispatchReceiverNames = localDispatchEdge.receiverNames;
    properties.localDispatchMatchBasis = localDispatchEdge.matchBasis;
  }
  return properties;
}

function sarifRelatedLocations(finding) {
  const localDispatchEdge = extractLocalDispatchEdge(finding);
  if (!localDispatchEdge?.receiverFiles?.length) {
    return undefined;
  }
  return localDispatchEdge.receiverFiles.map((receiverFile, index) => ({
    id: index + 1,
    logicalLocations: localDispatchEdge.receiverNames[index]
      ? [
          {
            fullyQualifiedName: localDispatchEdge.receiverNames[index],
            kind: "function",
          },
        ]
      : undefined,
    message: {
      text: `Local dispatch receiver: ${
        localDispatchEdge.receiverNames[index] || receiverFile
      }`,
    },
    physicalLocation: {
      artifactLocation: {
        uri: receiverFile,
      },
    },
  }));
}

function sarifHelp(finding, result) {
  const helpText = [];
  if (finding?.mitigation) {
    helpText.push(finding.mitigation);
  }
  const upstreamEscalation = summarizeUpstreamEscalation(result);
  if (upstreamEscalation) {
    helpText.push(upstreamEscalation);
  }
  if (!helpText.length) {
    return undefined;
  }
  return {
    markdown: helpText
      .map((entry, index) =>
        index === 0
          ? `**Remediation:** ${entry}`
          : `**External maintainer path:** ${entry}`,
      )
      .join("\n\n"),
    text: helpText.join(" "),
  };
}

function attackTags(finding) {
  return [
    ...(finding?.attackTactics || []),
    ...(finding?.attackTechniques || []),
  ].map((id) => `ATT&CK:${id}`);
}

function deriveSarifRules(entries) {
  const rulesById = new Map();
  for (const entry of entries) {
    const finding = entry.finding;
    const result = entry.result;
    if (rulesById.has(finding.ruleId)) {
      continue;
    }
    rulesById.set(finding.ruleId, {
      id: finding.ruleId,
      name: finding.name || finding.ruleId,
      shortDescription: {
        text: finding.name || finding.ruleId,
      },
      fullDescription: {
        text: finding.description || finding.name || finding.ruleId,
      },
      defaultConfiguration: {
        level: severityToSarifLevel(finding.severity),
      },
      properties: {
        attackTactics: finding.attackTactics,
        attackTechniques: finding.attackTechniques,
        category: finding.category,
        engine: finding.engine || "cdx-audit",
        tags: attackTags(finding),
      },
      help: sarifHelp(finding, result),
    });
  }
  return [...rulesById.values()];
}

function findingToSarifResult(finding, result) {
  const nextAction = summarizeNextAction(result);
  const upstreamEscalation = summarizeUpstreamEscalation(result);
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
      ...findingProperties(finding),
      nextAction,
      upstreamEscalation,
    },
    relatedLocations: sarifRelatedLocations(finding),
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

function consoleTargetLabel(result) {
  if (result?.grouping?.label) {
    return result.grouping.label;
  }
  if (result?.target?.purl) {
    return result.target.purl;
  }
  const namespacePrefix = result?.target?.namespace
    ? `${result.target.namespace}/`
    : "";
  const versionSuffix = result?.target?.version
    ? `@${result.target.version}`
    : "";
  return `${result?.target?.type || "pkg"}:${namespacePrefix}${result?.target?.name || "unknown"}${versionSuffix}`;
}

function topFinding(result) {
  return result?.findings?.[0];
}

function summarizeWhy(result) {
  const finding = topFinding(result);
  const localDispatchEdge = extractLocalDispatchEdge(finding);
  if (finding?.message && localDispatchEdge) {
    return `${finding.ruleId} — ${finding.message} (${formatLocalDispatchEdge(localDispatchEdge)})`;
  }
  if (finding?.message) {
    return `${finding.ruleId} — ${finding.message}`;
  }
  if (result?.error) {
    return result.error;
  }
  return (
    result?.assessment?.reasons?.[0] || "Review the predictive audit details."
  );
}

function groupedPurlPreview(result) {
  if (!result?.grouping?.groupedPurls?.length) {
    return undefined;
  }
  const preview = result.grouping.groupedPurls.slice(0, 2).join(", ");
  return result.grouping.groupedPurls.length > 2 ? `${preview}, …` : preview;
}

function summarizeReviewFocus(result) {
  const finding = topFinding(result);
  const localDispatchEdge = extractLocalDispatchEdge(finding);
  if (localDispatchEdge?.receiverFiles?.length) {
    return `Review sender '${localDispatchEdge.senderFile}' together with receiver '${localDispatchEdge.receiverFiles[0]}' for the flagged workflow-dispatch chain.`;
  }
  if (finding?.location?.file && result?.repoUrl) {
    return `Review '${finding.location.file}' in ${result.repoUrl}.`;
  }
  if (finding?.location?.file) {
    return `Review '${finding.location.file}' for the flagged workflow or release step.`;
  }
  if (result?.grouping?.memberCount > 1) {
    return `Start with ${groupedPurlPreview(result) || result.grouping.label} and inspect the shared repository or workflow pattern.`;
  }
  if (result?.repoUrl) {
    return `Review ${result.repoUrl} for the flagged release workflow, provenance, or publish behavior.`;
  }
  if (finding?.location?.purl) {
    return `Inspect ${finding.location.purl} in your dependency tree and verify its source and release posture.`;
  }
  if (result?.target?.purl) {
    return `Inspect ${result.target.purl} and verify its source repository, release workflow, and provenance signals.`;
  }
  return "Review the reported target and verify the associated repository, workflow, or package metadata.";
}

function summarizeUpstreamEscalation(result) {
  const finding = topFinding(result);
  if (finding?.location?.file && result?.repoUrl) {
    return `If you do not maintain this repository, open an issue or discussion with the upstream maintainers and reference '${finding.location.file}'.`;
  }
  if (result?.grouping?.memberCount > 1) {
    return `If these dependencies are maintained externally, open an issue or discussion with the upstream maintainers and reference ${result.grouping.label}.`;
  }
  if (result?.target?.purl) {
    return `If this dependency is maintained externally, open an issue or discussion with the upstream maintainers and reference ${result.target.purl}.`;
  }
  if (result?.repoUrl) {
    return "If you do not maintain this repository, open an issue or discussion with the upstream maintainers and share the predictive audit finding.";
  }
  return undefined;
}

function summarizeNextAction(result) {
  const finding = topFinding(result);
  if (result?.error) {
    return `${summarizeReviewFocus(result)} Verify repository access, source resolution, and clone permissions before re-running the audit.`;
  }
  const nextSteps = [summarizeReviewFocus(result)];
  if (finding?.mitigation) {
    nextSteps.push(finding.mitigation);
  }
  const upstreamEscalation = summarizeUpstreamEscalation(result);
  if (upstreamEscalation) {
    nextSteps.push(upstreamEscalation);
  }
  return nextSteps.join(" ");
}

function renderActionTable(results) {
  const rows = [
    ["Severity", "Target", "Why this needs action", "What to do next"],
  ];
  results.forEach((result) => {
    rows.push([
      result?.assessment?.severity?.toUpperCase() || "NONE",
      consoleTargetLabel(result),
      summarizeWhy(result),
      summarizeNextAction(result),
    ]);
  });
  return table(rows, {
    columns: [{ width: 10 }, { width: 36 }, { width: 52 }, { width: 68 }],
    columnDefault: { wrapWord: false },
  });
}

export function renderSarifReport(report, options = {}) {
  const minSeverity = options.minSeverity || "low";
  const visibleResults = filterResults(effectiveResults(report), minSeverity);
  const entries = [];
  const sarifResults = [];
  for (const result of visibleResults) {
    if (result?.findings?.length) {
      for (const finding of result.findings) {
        entries.push({ finding, result });
        sarifResults.push(findingToSarifResult(finding, result));
      }
      continue;
    }
    if (result?.error) {
      const errorEntry = errorToSarifEntry(result);
      entries.push({ finding: errorEntry, result });
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
  const analysisErrorSummary = formatAnalysisErrorCounts(report.summary);
  if (analysisErrorSummary) {
    lines.push(`Analysis error types: ${analysisErrorSummary}`);
  }
  if (report.summary.groupedResultCount) {
    lines.push(
      `Consolidated alert groups: ${report.summary.groupedResultCount}`,
    );
  }
  lines.push("");
  if (!visibleResults.length) {
    lines.push("No dependencies require your attention right now.");
    lines.push(
      `No predictive findings met or exceeded the configured severity threshold ('${minSeverity}').`,
    );
    if (report.summary.erroredTargets > 0) {
      lines.push(
        "Some targets could not be fully analyzed, so review the recorded analysis errors before treating this rollup as complete.",
      );
    }
    return `${lines.join("\n")}\n`;
  }
  lines.push("Dependencies requiring your attention:");
  lines.push("");
  lines.push(renderActionTable(visibleResults));
  lines.push("");
  if (report.summary.erroredTargets > 0) {
    lines.push(
      "Note: one or more targets could not be fully analyzed, so the final rollup may be incomplete until those analysis errors are resolved.",
    );
    lines.push("");
  }
  lines.push(
    "Next step: review the file, repository, or package listed in 'What to do next'. If you maintain it, make the remediation directly; otherwise, open an upstream issue or discussion with the relevant maintainers, then re-run cdx-audit or cdxgen --bom-audit.",
  );
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
    const nextAction = summarizeNextAction(result);
    const upstreamEscalation = summarizeUpstreamEscalation(result);
    const properties = [
      { name: "cdx:audit:engine", value: "cdx-audit" },
      { name: "cdx:audit:severity", value: result.assessment.severity },
      {
        name: "cdx:audit:confidence",
        value: result.assessment.confidenceLabel,
      },
      { name: "cdx:audit:score", value: String(result.assessment.score) },
      { name: "cdx:audit:nextAction", value: nextAction },
      { name: "cdx:audit:target:purl", value: result.target.purl },
    ];
    if (upstreamEscalation) {
      properties.push({
        name: "cdx:audit:upstreamGuidance",
        value: upstreamEscalation,
      });
    }
    if (result.repoUrl) {
      properties.push({
        name: "cdx:audit:target:repoUrl",
        value: result.repoUrl,
      });
    }
    if (result.findings?.length) {
      const localDispatchEdge = extractLocalDispatchEdge(result.findings[0]);
      properties.push({
        name: "cdx:audit:topFinding:ruleId",
        value: result.findings[0].ruleId,
      });
      if (localDispatchEdge) {
        properties.push({
          name: "cdx:audit:dispatch:edge",
          value: formatLocalDispatchEdge(localDispatchEdge),
        });
        if (localDispatchEdge.receiverFiles.length) {
          properties.push({
            name: "cdx:audit:dispatch:receiverFiles",
            value: localDispatchEdge.receiverFiles.join(","),
          });
        }
        if (localDispatchEdge.receiverNames.length) {
          properties.push({
            name: "cdx:audit:dispatch:receiverNames",
            value: localDispatchEdge.receiverNames.join(","),
          });
        }
      }
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
        [result.assessment.reasons?.[0] || "", `Next action: ${nextAction}`],
      ),
      timestamp: getTimestamp(),
    };
  });
}
