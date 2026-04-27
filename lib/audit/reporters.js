import { getTimestamp } from "../helpers/utils.js";
import { severityMeetsThreshold } from "./scoring.js";

const CODE_BLOCK = "```";

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
  const visibleResults = filterResults(report.results || [], minSeverity);
  const lines = [];
  lines.push("cdx-audit — predictive supply-chain exposure audit");
  lines.push("");
  lines.push(`Input BOMs: ${report.summary.inputBomCount}`);
  lines.push(`Candidate targets: ${report.summary.totalTargets}`);
  lines.push(`Scanned targets: ${report.summary.scannedTargets}`);
  lines.push(`Errored targets: ${report.summary.erroredTargets}`);
  lines.push(`Skipped targets: ${report.summary.skippedTargets}`);
  lines.push("");
  if (!visibleResults.length) {
    lines.push(`No targets at or above severity '${minSeverity}'.`);
    return `${lines.join("\n")}\n`;
  }
  lines.push(`Targets at or above severity '${minSeverity}':`);
  lines.push("");
  for (const result of visibleResults) {
    const packageVersion = result.target.version
      ? `@${result.target.version}`
      : "";
    lines.push(
      `- [${result.assessment.severity.toUpperCase()}] ${result.target.type}:${result.target.name}${packageVersion} score=${result.assessment.score} confidence=${result.assessment.confidenceLabel}`,
    );
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
      text: `Predictive audit score ${result.assessment.score} (${result.assessment.severity}) for ${result.target.purl}.\n${result.assessment.reasons?.[0] || ""}\n${CODE_BLOCK}\n${JSON.stringify(properties)}\n${CODE_BLOCK}`,
      timestamp: getTimestamp(),
    };
  });
}
