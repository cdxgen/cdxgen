/**
 * Post-generation BOM audit orchestrator
 * Evaluates security rules against CI/CD and dependency data in the BOM
 */
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildAnnotationText } from "../../helpers/annotationFormatter.js";
import { table } from "../../helpers/table.js";
import {
  DEBUG_MODE,
  getTimestamp,
  safeExistsSync,
} from "../../helpers/utils.js";
import { evaluateRules, loadRules } from "./ruleEngine.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const BUILTIN_RULES_DIR = join(__dirname, "..", "..", "..", "data", "rules");

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
export function formatConsoleOutput(findings) {
  if (!findings?.length) {
    return "";
  }
  const config = {
    columnDefault: { wrapWord: true, width: 100 },
    columns: [
      { width: 10 },
      { width: 35 },
      { width: 50 },
      { width: 50 },
      { width: 60 },
    ],
    header: {
      alignment: "center",
      content: "BOM Audit Findings\nGenerated with \u2665  by cdxgen",
    },
  };
  const data = [["Rule", "Message", "Description", "Ref", "File"]];
  for (const f of findings) {
    const line = [];
    line.push(f.ruleId);
    line.push(f.message);
    line.push(f.description || "");
    line.push(f.location?.purl || f.location?.bomRef || "");
    line.push(f.location?.file || "");
    data.push(line);
  }
  console.log(table(data, config));
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
      text: buildAnnotationText(f.message, properties),
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
