/**
 * Post-generation BOM audit orchestrator
 * Evaluates security rules against CI/CD and dependency data in the BOM
 */
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEBUG_MODE,
  getTimestamp,
  safeExistsSync,
} from "../../helpers/utils.js";
import { evaluateRules, loadRules } from "./ruleEngine.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const BUILTIN_RULES_DIR = join(__dirname, "..", "..", "..", "data", "rules");
const CODE_BLOCK = "```";

/**
 * Audit BOM formulation section using JSONata-powered rule engine
 * @param {Object} bomJson - Generated CycloneDX BOM
 * @param {Object} options - CLI options
 * @returns {Promise<Array>} Array of audit findings
 */
export async function auditBom(bomJson, options) {
  if (!bomJson) {
    return [];
  }
  const findings = [];
  const rules = await loadRules(BUILTIN_RULES_DIR);
  if (options.bomAuditRulesDir && safeExistsSync(options.bomAuditRulesDir)) {
    const userRulesDir = resolve(options.bomAuditRulesDir);
    const userRules = await loadRules(userRulesDir);
    if (DEBUG_MODE) {
      console.log(`Loaded ${userRules.length} user rules from ${userRulesDir}`);
    }
    rules.push(...userRules);
  }
  if (rules.length === 0) {
    if (DEBUG_MODE) {
      console.log("No audit rules loaded; formulation audit skipped");
    }
    return findings;
  }
  let activeRules = rules;
  if (options.bomAuditCategories) {
    const categories = options.bomAuditCategories
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
    if (categories.length > 0) {
      activeRules = rules.filter((r) => categories.includes(r.category));
      if (DEBUG_MODE) {
        console.log(
          `Filtering rules by categories: ${categories.join(", ")} (${activeRules.length} active)`,
        );
      }
    }
  }
  const allFindings = await evaluateRules(activeRules, bomJson);
  if (options.bomAuditMinSeverity) {
    const minSeverity = options.bomAuditMinSeverity.toLowerCase();
    const severityThreshold = { low: 0, medium: 1, high: 2, critical: 3 };
    const threshold = severityThreshold[minSeverity] ?? 0;
    findings.push(
      ...allFindings.filter((f) => severityThreshold[f.severity] >= threshold),
    );
  } else {
    findings.push(...allFindings);
  }
  if (DEBUG_MODE) {
    console.log(
      `Formulation audit complete: ${findings.length} finding(s) from ${activeRules.length} rule(s)`,
    );
  }

  return findings;
}

/**
 * Format findings for console output with color-coded severity
 */
export function formatConsoleOutput(findings, options) {
  if (!findings?.length) {
    return "";
  }
  const lines = [];
  lines.push(`\nFormulation audit: ${findings.length} finding(s)\n`);
  for (const f of findings) {
    // Severity icon
    const icon =
      f.severity === "critical"
        ? "⛔"
        : f.severity === "high"
          ? "🔴"
          : f.severity === "medium"
            ? "🟡"
            : "🔵";
    lines.push(`${icon} [${f.ruleId}] ${f.message}`);
    if (options.print || options.debug || DEBUG_MODE) {
      if (f.name && f.name !== f.ruleId) {
        lines.push(`${f.name}`);
      }
      if (f.description) {
        lines.push(`Description: ${f.description}`);
      }
      if (f.mitigation) {
        lines.push(`Mitigation: ${f.mitigation}`);
      }
      if (f.location?.purl) {
        lines.push(`PURL: ${f.location.purl}`);
      }
      if (f.location?.file) {
        lines.push(`File: ${f.location.file}`);
      }
      if (!f.location?.purl && f.location?.bomRef) {
        lines.push(`bom-ref: ${f.location.bomRef}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Convert findings to CycloneDX annotations
 */
export function formatAnnotations(findings, bomJson) {
  if (!findings?.length) {
    return [];
  }
  const cdxgenAnnotator =
    bomJson?.metadata?.tools?.components?.filter((c) => c.name === "cdxgen") ||
    [];
  if (!cdxgenAnnotator.length) {
    if (DEBUG_MODE) {
      console.warn(
        "Cannot create audit annotations: cdxgen tool component not found in metadata",
      );
    }
    return [];
  }
  return findings.map((f) => {
    const subjects = [bomJson.serialNumber];
    const properties = [
      { name: "cdx:audit:ruleId", value: f.ruleId },
      { name: "cdx:audit:severity", value: f.severity },
      { name: "cdx:audit:category", value: f.category },
    ];
    if (f.name) {
      properties.push({ name: "cdx:audit:name", value: f.name });
    }
    if (f.mitigation) {
      properties.push({ name: "cdx:audit:mitigation", value: f.mitigation });
    }
    if (f?.location?.purl) {
      properties.push({
        name: "cdx:audit:location:purl",
        value: f.location.purl,
      });
    }
    if (f.location?.file) {
      properties.push({
        name: "cdx:audit:location:file",
        value: f.location.file,
      });
    }
    if (f.location?.bomRef) {
      properties.push({
        name: "cdx:audit:location:bomRef",
        value: f.location.bomRef,
      });
    }
    if (f.evidence && typeof f.evidence === "object") {
      for (const [key, value] of Object.entries(f.evidence)) {
        const propValue =
          typeof value === "object" ? JSON.stringify(value) : String(value);
        properties.push({
          name: `cdx:audit:evidence:${key}`,
          value: propValue,
        });
      }
    }
    return {
      subjects,
      annotator: {
        component: cdxgenAnnotator[0],
      },
      timestamp: getTimestamp(),
      text: `${f.message}\n${CODE_BLOCK}\n${JSON.stringify(properties)}\n${CODE_BLOCK}`,
    };
  });
}

/**
 * Check if any findings meet the severity threshold for secure mode failure
 */
export function hasCriticalFindings(findings, options) {
  if (!findings?.length) {
    return false;
  }
  const failSeverity = options.bomAuditFailSeverity || "high";
  const severityOrder = { low: 0, medium: 1, high: 2, critical: 3 };
  const threshold = severityOrder[failSeverity] ?? severityOrder.high;
  return findings.some((f) => (severityOrder[f.severity] ?? 0) >= threshold);
}
