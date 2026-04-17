/**
 * SARIF 2.1.0 reporter — renders findings as a SARIF log suitable for upload
 * to GitHub code scanning or any other SARIF-aware consumer.
 *
 * No external dependencies. Spec: https://docs.oasis-open.org/sarif/sarif/v2.1.0/
 */

const SARIF_VERSION = "2.1.0";
const SARIF_SCHEMA =
  "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/Schemata/sarif-schema-2.1.0.json";

/**
 * Map internal severity → SARIF `level` property.
 *
 * @param {string} severity
 * @returns {"error" | "warning" | "note"}
 */
function severityToLevel(severity) {
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

/**
 * Convert an internal location to a SARIF physicalLocation block. Returns null
 * when there is no file context — the caller will fall back to a synthetic
 * location.
 *
 * @param {object} loc
 * @returns {object | null}
 */
function toSarifLocation(loc) {
  if (!loc) return null;
  if (loc.file) {
    return {
      physicalLocation: {
        artifactLocation: { uri: loc.file },
      },
      logicalLocations: loc.bomRef
        ? [{ fullyQualifiedName: loc.bomRef, kind: "package" }]
        : undefined,
    };
  }
  if (loc.purl || loc.bomRef) {
    return {
      logicalLocations: [
        {
          fullyQualifiedName: loc.purl || loc.bomRef,
          kind: "package",
        },
      ],
    };
  }
  return null;
}

/**
 * Build the SARIF `rules` array from a catalogue of rule descriptors.
 *
 * @param {Array<object>} findings
 * @returns {Array<object>}
 */
function deriveRules(findings) {
  const byId = new Map();
  for (const f of findings) {
    if (byId.has(f.ruleId)) continue;
    byId.set(f.ruleId, {
      id: f.ruleId,
      name: f.name || f.ruleId,
      shortDescription: { text: f.name || f.ruleId },
      fullDescription: {
        text: f.description || f.name || f.ruleId,
      },
      defaultConfiguration: { level: severityToLevel(f.severity) },
      properties: {
        category: f.category,
        standard: f.standard,
        standardRefs: f.standardRefs || [],
        scvsLevels: f.scvsLevels || [],
        automatable: f.automatable !== false,
        engine: f.engine,
      },
      help: f.mitigation
        ? {
            text: f.mitigation,
            markdown: `**Remediation:** ${f.mitigation}`,
          }
        : undefined,
    });
  }
  return [...byId.values()];
}

/**
 * Convert one finding into a SARIF result.
 *
 * @param {object} f
 * @returns {object}
 */
function toSarifResult(f) {
  const locations = (f.locations || []).map(toSarifLocation).filter(Boolean);
  if (locations.length === 0) {
    locations.push({
      logicalLocations: [{ fullyQualifiedName: f.ruleId, kind: "rule" }],
    });
  }
  const result = {
    ruleId: f.ruleId,
    level: severityToLevel(f.severity),
    message: { text: f.message || f.name || f.ruleId },
    locations,
    properties: {
      status: f.status,
      severity: f.severity,
      standard: f.standard,
      standardRefs: f.standardRefs || [],
      scvsLevels: f.scvsLevels || [],
      automatable: f.automatable !== false,
      engine: f.engine,
    },
  };
  if (f.evidence && typeof f.evidence === "object") {
    result.properties.evidence = f.evidence;
  }
  return result;
}

/**
 * Render a validation report as SARIF.
 *
 * @param {object} report Output of validateBomAdvanced().
 * @param {object} [options]
 * @param {string} [options.toolName]    Override driver name.
 * @param {string} [options.toolVersion] Driver version to embed.
 * @param {boolean} [options.includeManual] Include manual-review findings (default false).
 * @returns {string}
 */
export function render(report, options = {}) {
  const {
    toolName = "cdx-validate",
    toolVersion = "v12",
    includeManual = false,
  } = options;
  const findings = (report.findings || []).filter((f) =>
    includeManual ? true : f.status !== "manual",
  );
  const log = {
    $schema: SARIF_SCHEMA,
    version: SARIF_VERSION,
    runs: [
      {
        tool: {
          driver: {
            name: toolName,
            version: toolVersion,
            informationUri: "https://cdxgen.github.io/cdxgen/",
            rules: deriveRules(findings),
          },
        },
        invocations: [
          {
            executionSuccessful:
              report.summary?.fail === 0 && report.schemaValid !== false,
          },
        ],
        results: findings.map(toSarifResult),
        properties: {
          schemaValid: report.schemaValid,
          deepValid: report.deepValid,
          signatureVerified: report.signatureVerified ?? null,
          summary: report.summary,
          benchmarks: report.benchmarks || [],
        },
      },
    ],
  };
  return JSON.stringify(log, null, null);
}
