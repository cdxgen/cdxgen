/**
 * Post-generation BOM audit orchestrator
 * Evaluates security rules against CI/CD and dependency data in the BOM
 */
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { collectAiOversight } from "../../helpers/aiOversightCollector.js";
import { collectAiProvenance } from "../../helpers/aiProvenanceCollector.js";
import { buildAnnotationText } from "../../helpers/annotationFormatter.js";
import {
  expandBomAuditCategories,
  validateBomAuditCategories,
} from "../../helpers/auditCategories.js";
import { isHbomLikeBom as isHbomLikeBomDocument } from "../../helpers/hbomAnalysis.js";
import { table } from "../../helpers/table.js";
import {
  DEBUG_MODE,
  getTimestamp,
  safeExistsSync,
} from "../../helpers/utils.js";
import { evaluateRules, loadRules } from "./ruleEngine.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const BUILTIN_RULES_DIR = join(__dirname, "..", "..", "..", "data", "rules");

async function loadConfiguredBomAuditRules(options = {}) {
  const rules = await loadRules(BUILTIN_RULES_DIR);
  if (options.bomAuditRulesDir && safeExistsSync(options.bomAuditRulesDir)) {
    const userRulesDir = resolve(options.bomAuditRulesDir);
    const userRules = await loadRules(userRulesDir);
    if (DEBUG_MODE) {
      console.log(`Loaded ${userRules.length} user rules from ${userRulesDir}`);
    }
    rules.push(...userRules);
  }
  if (!rules.length) {
    return {
      activeRules: [],
      rules,
    };
  }
  let activeRules = rules;
  if (options.bomAuditCategories) {
    const { categories, expandedCategories } = validateBomAuditCategories(
      options.bomAuditCategories,
      rules,
    );
    if (categories.length > 0) {
      activeRules = rules.filter((r) =>
        expandedCategories.includes(r.category),
      );
      if (DEBUG_MODE) {
        console.log(
          `Filtering rules by categories: ${categories.join(", ")} -> ${expandBomAuditCategories(categories).join(", ")} (${activeRules.length} active)`,
        );
      }
    }
  }
  return {
    activeRules,
    rules,
  };
}

/**
 * Detect whether a BOM looks like an HBOM inventory.
 *
 * @param {object} bomJson CycloneDX BOM
 * @returns {boolean} True when the BOM appears to represent hardware inventory
 */
export function isHbomLikeBom(bomJson) {
  return isHbomLikeBomDocument(bomJson);
}

/**
 * Detect whether a BOM looks like an OBOM/runtime inventory.
 *
 * @param {object} bomJson CycloneDX BOM
 * @returns {boolean} True when the BOM appears to represent operations/runtime data
 */
export function isObomLikeBom(bomJson) {
  if (!bomJson) {
    return false;
  }
  if (isHbomLikeBom(bomJson)) {
    return false;
  }
  if (
    bomJson?.metadata?.component?.type === "operating-system" ||
    bomJson?.metadata?.component?.type === "device"
  ) {
    return true;
  }
  if (
    Array.isArray(bomJson?.metadata?.lifecycles) &&
    bomJson.metadata.lifecycles.some(
      (lifecycle) => lifecycle?.phase === "operations",
    )
  ) {
    return true;
  }
  return (bomJson?.components || []).some((component) =>
    (component?.properties || []).some(
      (property) => property?.name === "cdx:osquery:category",
    ),
  );
}

function summarizeDryRunSupport(activeRules = []) {
  const summary = {
    fullCount: 0,
    noCount: 0,
    partialCount: 0,
    totalRules: activeRules.length,
  };
  for (const rule of activeRules) {
    if (rule?.dryRunSupport === "no") {
      summary.noCount += 1;
      continue;
    }
    if (rule?.dryRunSupport === "full") {
      summary.fullCount += 1;
      continue;
    }
    summary.partialCount += 1;
  }
  return summary;
}

/**
 * Summarize dry-run support across active BOM audit rules.
 *
 * @param {Object} [options={}] audit configuration options
 * @returns {Promise<{ fullCount: number, noCount: number, partialCount: number, totalRules: number }>} dry-run summary
 */
export async function getBomAuditDryRunSupportSummary(options = {}) {
  const { activeRules } = await loadConfiguredBomAuditRules(options);
  return summarizeDryRunSupport(activeRules);
}

/**
 * Format BOM audit dry-run support as a console-friendly summary line.
 *
 * @param {{ fullCount: number, noCount: number, partialCount: number, totalRules: number }} summary dry-run support summary
 * @returns {string} formatted summary text
 */
export function formatDryRunSupportSummary(summary) {
  if (!summary) {
    return "";
  }
  return `BOM audit dry-run summary: ${summary.noCount} rule(s) do not support dry-run, ${summary.partialCount} rule(s) have partial dry-run support, ${summary.totalRules} active rule(s) total.`;
}

/**
 * Determine whether AI provenance detection should run for this audit.
 * Detection is enabled by default and can be disabled with `--no-ai-provenance`.
 * When explicit categories are supplied, it only runs if `ai-provenance` is
 * among the expanded categories.
 *
 * @param {Object} options CLI options
 * @param {Array} rules loaded audit rules
 * @returns {boolean} True when AI provenance detection is active
 */
function isAiProvenanceAuditActive(options, rules) {
  if (options.aiProvenance === false) {
    return false;
  }
  if (!options.bomAuditCategories) {
    return true;
  }
  const { expandedCategories } = validateBomAuditCategories(
    options.bomAuditCategories,
    rules,
  );
  // The oversight layer is part of AI provenance; either category activates the
  // provenance + oversight property injection.
  return (
    expandedCategories.includes("ai-provenance") ||
    expandedCategories.includes("ai-oversight")
  );
}

/**
 * Ensure the BOM carries cdx:ai:codegen properties at the document root
 * (`bomJson.properties`). If they are already present (for example, generated
 * with `-t ai-provenance`) the BOM is left untouched. Otherwise the target
 * directory is scanned and any detected properties are merged into the root
 * `properties` array.
 *
 * @param {Object} bomJson Generated CycloneDX BOM (mutated in place)
 * @param {Object} options CLI options
 */
export function ensureAiProvenanceProperties(bomJson, options = {}) {
  if (!bomJson) {
    return;
  }
  const existing = bomJson.properties || [];
  if (existing.some((p) => p?.name === "cdx:ai:codegen:detected")) {
    return;
  }
  const targetDir =
    options.path || options.filePath || options.workspaceDir || process.cwd();
  if (!safeExistsSync(targetDir)) {
    return;
  }
  try {
    const provResult = collectAiProvenance(targetDir, options);
    if (provResult?.detected && provResult.properties?.length) {
      bomJson.properties = [...existing, ...provResult.properties];
    }
  } catch (err) {
    if (DEBUG_MODE) {
      console.error("Error running AI provenance audit:", err);
    }
  }
}

/**
 * Ensure the BOM carries cdx:ai:oversight properties at the document root
 * (`bomJson.properties`). If they are already present or AI codegen was not
 * detected, the BOM is left untouched.
 *
 * @param {Object} bomJson Generated CycloneDX BOM (mutated in place)
 * @param {Object} options CLI options
 */
export async function ensureAiOversightProperties(bomJson, options = {}) {
  // Oversight is part of the AI provenance layer; disabling provenance
  // (--no-ai-provenance) disables oversight too.
  if (!bomJson || options.aiProvenance === false) {
    return;
  }
  const existing = bomJson.properties || [];
  if (existing.some((p) => p?.name === "cdx:ai:oversight:score")) {
    return;
  }
  const codegenDetected = existing.some(
    (p) => p?.name === "cdx:ai:codegen:detected" && p?.value === "true",
  );
  if (!codegenDetected) {
    return;
  }
  const targetDir =
    options.path || options.filePath || options.workspaceDir || process.cwd();
  if (!safeExistsSync(targetDir)) {
    return;
  }
  try {
    const oversightResult = await collectAiOversight(targetDir, options);
    if (oversightResult?.properties?.length) {
      bomJson.properties = [
        ...(bomJson.properties || []),
        ...oversightResult.properties,
      ];
    }
  } catch (err) {
    if (DEBUG_MODE) {
      console.error("Error running AI oversight audit:", err);
    }
  }
}

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
  const { activeRules, rules } = await loadConfiguredBomAuditRules(options);
  if (rules.length === 0) {
    if (DEBUG_MODE) {
      console.log("No audit rules loaded; formulation audit skipped");
    }
    return findings;
  }
  // AI provenance detection is enabled by default for audits. When the
  // ai-provenance category is active and the BOM does not already carry
  // cdx:ai:codegen properties, scan the target directory and inject them so the
  // ai-provenance rules can evaluate against them.
  if (isAiProvenanceAuditActive(options, rules)) {
    ensureAiProvenanceProperties(bomJson, options);
    await ensureAiOversightProperties(bomJson, options);
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
 * Format findings into a console report table.
 *
 * @param {Array} findings audit findings
 * @returns {string} console report table
 */
export function renderBomAuditConsoleReport(findings) {
  if (!findings?.length) {
    return "";
  }
  const config = {
    columnDefault: { wrapWord: true, width: 100 },
    columns: [
      { width: 10 },
      { width: 26 },
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
  const data = [["Rule", "ATT&CK", "Message", "Description", "Ref", "File"]];
  for (const f of findings) {
    const line = [];
    line.push(f.ruleId);
    line.push(
      [...(f.attackTactics || []), ...(f.attackTechniques || [])].join(", "),
    );
    line.push(f.message);
    line.push(f.description || "");
    line.push(f.location?.purl || f.location?.bomRef || "");
    line.push(f.location?.file || "");
    data.push(line);
  }
  return table(data, config);
}

/**
 * Print BOM audit findings to the console.
 *
 * @param {Array} findings audit findings
 * @returns {string} rendered console output
 */
export function formatConsoleOutput(findings) {
  const output = renderBomAuditConsoleReport(findings);
  if (output) {
    console.log(output);
  }
  return output;
}

/**
 * Convert BOM audit findings to CycloneDX annotations.
 *
 * @param {Array} findings audit findings
 * @param {Object} bomJson generated CycloneDX BOM
 * @returns {Array} CycloneDX annotations
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
    if (f.attackTactics?.length) {
      properties.push({
        name: "cdx:audit:attack:tactics",
        value: f.attackTactics.join(","),
      });
    }
    if (f.attackTechniques?.length) {
      properties.push({
        name: "cdx:audit:attack:techniques",
        value: f.attackTechniques.join(","),
      });
    }
    if (f.standards && typeof f.standards === "object") {
      for (const [standardName, entries] of Object.entries(f.standards)) {
        properties.push({
          name: `cdx:audit:standards:${standardName}`,
          value: Array.isArray(entries) ? entries.join(",") : String(entries),
        });
      }
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
