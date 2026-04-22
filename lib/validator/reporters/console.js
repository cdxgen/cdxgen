/**
 * Console reporter — renders findings and benchmark scorecards as tables.
 * Uses cdxgen's internal table helper for lightweight rendering.
 */

import { table } from "../../helpers/table.js";

const SEVERITY_ICONS = {
  critical: "⛔",
  high: "🔴",
  medium: "🟠",
  low: "🟡",
  info: "🔵",
};

/**
 * @param {object} f Finding
 * @returns {string}
 */
function severityIcon(f) {
  return SEVERITY_ICONS[f.severity] || "·";
}

/**
 * Produce a human-readable summary of findings.
 *
 * @param {Array<object>} findings
 * @param {object} [options]
 * @returns {string}
 */
export function formatFindings(findings, options = {}) {
  if (!findings || findings.length === 0) {
    return "No findings.";
  }
  const data = [["", "Rule", "Status", "Severity", "Standard", "Message"]];
  for (const f of findings) {
    data.push([
      severityIcon(f),
      f.ruleId,
      f.status,
      f.severity,
      (f.standardRefs || []).join(", ") || f.standard || "",
      f.message,
    ]);
  }
  const config = {
    columnDefault: { wrapWord: true },
    columns: [
      { width: 2 },
      { width: 15 },
      { width: 8 },
      { width: 10 },
      { width: 20 },
      { width: 60 },
    ],
    header: {
      alignment: "center",
      content: options.title || "cdx-validate findings",
    },
  };
  return table(data, config);
}

/**
 * Produce a scorecard table for benchmark reports.
 *
 * @param {Array<object>} reports
 * @returns {string}
 */
export function formatBenchmarks(reports) {
  if (!reports || reports.length === 0) {
    return "";
  }
  const data = [
    ["Benchmark", "Controls", "Pass", "Fail", "Manual", "Automatable score"],
  ];
  for (const r of reports) {
    data.push([
      r.name,
      String(r.totalControls),
      String(r.pass),
      String(r.fail),
      String(r.manual),
      `${r.scorePct}% (${r.pass}/${r.automatable})`,
    ]);
  }
  const config = {
    columnDefault: { wrapWord: true },
    columns: [
      { width: 40 },
      { width: 8 },
      { width: 6 },
      { width: 6 },
      { width: 8 },
      { width: 24 },
    ],
    header: {
      alignment: "center",
      content: "cdx-validate benchmark scorecards",
    },
  };
  return table(data, config);
}

/**
 * Produce a compact one-line summary for CI logs.
 *
 * @param {object} summary
 * @returns {string}
 */
export function formatSummary(summary) {
  return [
    `schemaValid=${summary.schemaValid}`,
    `deepValid=${summary.deepValid}`,
    `pass=${summary.pass}`,
    `fail=${summary.fail}`,
    `manual=${summary.manual}`,
    `errors=${summary.errors}`,
  ].join("  ");
}

/**
 * Render the full report as a single string.
 *
 * @param {object} report Output of validateBomAdvanced().
 * @returns {string}
 */
export function render(report) {
  const pieces = [];
  pieces.push(formatSummary(report.summary));
  if (report.benchmarks?.length) {
    pieces.push(formatBenchmarks(report.benchmarks));
  }
  const actionable = report.findings.filter(
    (f) => f.status === "fail" || f.severity === "critical",
  );
  if (actionable.length) {
    pieces.push(formatFindings(actionable, { title: "Failing controls" }));
  }
  const manual = report.findings.filter((f) => f.status === "manual");
  if (manual.length) {
    pieces.push(
      formatFindings(manual, {
        title: `Manual review required (${manual.length})`,
      }),
    );
  }
  return pieces.filter(Boolean).join("\n");
}
