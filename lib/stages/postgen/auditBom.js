/**
 * Post-generation BOM audit orchestrator
 * Evaluates security rules against CI/CD and dependency data in the BOM
 */
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Purl } from "@cdxgen/cdx-purl";

import { DEBUG_MODE } from "../../core/activity.js";
import { safeExistsSync } from "../../core/fs.js";
import { collectAiOversight } from "../../inventory/aiOversightCollector.js";
import { collectAiProvenance } from "../../inventory/aiProvenanceCollector.js";
import {
  expandBomAuditCategories,
  OPT_IN_BOM_AUDIT_CATEGORIES,
  validateBomAuditCategories,
} from "../../inventory/auditCategories.js";
import { isHbomLikeBom as isHbomLikeBomDocument } from "../../inventory/hbomAnalysis.js";
import { table } from "../../inventory/table.js";
import {
  buildDocumentAnnotation,
  evidenceProperties,
  warnMissingAnnotator,
} from "./annotationBuilder.js";
import { evaluateRules, loadRules } from "./ruleEngine.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const BUILTIN_RULES_DIR = join(__dirname, "..", "..", "..", "data", "rules");

/** The property each supported purl type carries when its name matches a
 * configured private namespace prefix. Whether the public registry holds the
 * name is recorded beside it by cdx-audit's registry check. */
const PRIVATE_NAMESPACE_PROPERTY_BY_TYPE = {
  npm: "cdx:npm:privateNamespace",
  pypi: "cdx:pypi:privateNamespace",
  cargo: "cdx:cargo:privateNamespace",
};

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
  } else {
    // Without explicit categories every loaded rule would activate, so rules
    // belonging to opt-in-only categories are removed here.
    activeRules = rules.filter(
      (r) => !OPT_IN_BOM_AUDIT_CATEGORIES.includes(r.category),
    );
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
 * Pick the directory whose git history the AI provenance and oversight
 * collectors read. A direct audit of a saved BOM (`directBomAudit`) reads
 * only a directory the caller named; the current working directory is used
 * as the fallback for every other audit, where it is the scanned project.
 *
 * @param {Object} options CLI options
 * @returns {string | undefined} Directory to scan, or undefined for none
 */
function resolveAiTargetDir(options) {
  const named = options.path || options.filePath || options.workspaceDir;
  if (named || options.directBomAudit) {
    return named;
  }
  return process.cwd();
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
  const targetDir = resolveAiTargetDir(options);
  if (!targetDir || !safeExistsSync(targetDir)) {
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
  const targetDir = resolveAiTargetDir(options);
  if (!targetDir || !safeExistsSync(targetDir)) {
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
 * The name a public registry knows a component by, read from its purl and,
 * when the purl does not parse, from its group and name.
 *
 * An npm scope always carries its `@` (`@acme`), whichever spelling the purl
 * or the group used. Only npm, PyPI and Cargo components have one.
 *
 * @param {Object} component CycloneDX component
 * @returns {{ type: string, scope: string | undefined, name: string, fullName: string } | undefined}
 *   the registry name, or undefined for another type or no name
 */
export function componentRegistryName(component) {
  const purl = typeof component?.purl === "string" ? component.purl : "";
  const purlType = purl.match(/^pkg:([^/]+)\//i)?.[1]?.toLowerCase();
  if (!PRIVATE_NAMESPACE_PROPERTY_BY_TYPE[purlType]) {
    return undefined;
  }
  let namespace;
  let name;
  try {
    const purlObj = Purl.parse(purl);
    namespace = purlObj?.namespace;
    name = purlObj?.name;
  } catch {
    namespace = component?.group;
    name = component?.name;
  }
  if (!name) {
    return undefined;
  }
  const scope =
    purlType === "npm" && namespace
      ? namespace.startsWith("@")
        ? namespace
        : `@${namespace}`
      : undefined;
  return {
    fullName: scope ? `${scope}/${name}` : name,
    name,
    scope,
    type: purlType,
  };
}

const NAME_SEPARATORS = "-_./";

/** Whether a name is the prefix itself or continues it after a separator. */
function startsAtBoundary(name, prefix) {
  if (!prefix || !name.startsWith(prefix)) {
    return false;
  }
  return (
    name.length === prefix.length ||
    NAME_SEPARATORS.includes(prefix.at(-1)) ||
    NAME_SEPARATORS.includes(name[prefix.length])
  );
}

/** A PyPI name as PEP 503 compares it. */
function pep503Name(value) {
  return value.toLowerCase().replace(/[-_.]+/g, "-");
}

/**
 * Whether a configured private namespace or name prefix names a component.
 *
 * - npm: a prefix that names a scope (`@acme`) matches that scope exactly,
 *   and so does a bare prefix (`acme`) for a scoped package. A prefix with a
 *   scope and a name part (`@acme/internal-`) matches the full name at a
 *   separator boundary. A bare prefix matches an unscoped name exactly or at
 *   a separator boundary (`-`, `_`, `.`, `/`): `acme` matches `acme` and
 *   `acme-client`, never `acmecorp` or `@acmecorp/x`.
 * - PyPI: both sides are compared after PEP 503 normalisation, at a
 *   separator boundary: `acme` matches `acme_internal` and `Acme.Tools`.
 * - Cargo: both sides are compared with `_` read as `-`, at a separator
 *   boundary, as crates.io compares names.
 *
 * @param {string} prefix configured prefix
 * @param {{ type: string, scope?: string, name: string, fullName: string }} registryName
 *   see {@link componentRegistryName}
 * @returns {boolean} whether the prefix names the component
 */
export function matchesPrivateNamespace(prefix, registryName) {
  const wanted = String(prefix || "")
    .trim()
    .toLowerCase();
  if (!wanted || !registryName?.name) {
    return false;
  }
  if (registryName.type === "npm") {
    const scope = registryName.scope?.toLowerCase();
    if (wanted.startsWith("@")) {
      return wanted.includes("/")
        ? startsAtBoundary(registryName.fullName.toLowerCase(), wanted)
        : scope === wanted;
    }
    if (scope) {
      return scope === `@${wanted}`;
    }
    return startsAtBoundary(registryName.name.toLowerCase(), wanted);
  }
  if (registryName.type === "pypi") {
    return startsAtBoundary(pep503Name(registryName.name), pep503Name(wanted));
  }
  const crateName = (value) => value.toLowerCase().replace(/_/g, "-");
  return startsAtBoundary(crateName(registryName.name), crateName(wanted));
}

/**
 * Mark the components whose name a caller has declared private.
 *
 * A private namespace or name prefix that shows up on a public registry is
 * the classic dependency-confusion setup: the build resolves the public
 * package because the private registry holds no copy. Components of the
 * npm, PyPI and Cargo purl types whose registry name a configured prefix
 * names (see {@link matchesPrivateNamespace}) carry a
 * `cdx:<eco>:privateNamespace` property whose value is the matched prefix.
 * The INT-017 to INT-019 rules report a marked component only once the
 * public registry has said it holds the name (`cdx:<eco>:publicRegistry`),
 * which this function does not ask about.
 *
 * @param {Object} bomJson CycloneDX BOM (mutated in place)
 * @param {Object} options audit options with bomAuditPrivateNamespace
 * @returns {number} count of components marked
 */
export function applyPrivateNamespaceProperties(bomJson, options = {}) {
  const rawPrefixes = options.bomAuditPrivateNamespace;
  const prefixList = (Array.isArray(rawPrefixes) ? rawPrefixes : [rawPrefixes])
    .flatMap((prefix) => String(prefix || "").split(","))
    .map((prefix) => prefix.trim())
    .filter(Boolean);
  if (!prefixList.length || !Array.isArray(bomJson?.components)) {
    return 0;
  }
  let marked = 0;
  for (const component of bomJson.components) {
    const registryName = componentRegistryName(component);
    if (!registryName) {
      continue;
    }
    const matched = prefixList.find((prefix) =>
      matchesPrivateNamespace(prefix, registryName),
    );
    if (!matched) {
      continue;
    }
    const propertyName = PRIVATE_NAMESPACE_PROPERTY_BY_TYPE[registryName.type];
    component.properties = component.properties || [];
    if (
      !component.properties.some((property) => property?.name === propertyName)
    ) {
      component.properties.push({ name: propertyName, value: matched });
      marked += 1;
    }
  }
  return marked;
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
  if (options.bomAuditPrivateNamespace) {
    applyPrivateNamespaceProperties(bomJson, options);
  }
  // AI provenance detection is enabled by default for audits. When the
  // ai-provenance category is active and the BOM does not already carry
  // cdx:ai:codegen properties, scan the target directory and inject them so the
  // ai-provenance rules can evaluate against them.
  if (isAiProvenanceAuditActive(options, rules)) {
    ensureAiProvenanceProperties(bomJson, options);
    await ensureAiOversightProperties(bomJson, options);
  }
  const allFindings = await evaluateRules(activeRules, bomJson, options);
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
  let warnedMissingAnnotator = false;
  return findings
    .map((f) => {
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
      properties.push(...evidenceProperties("cdx:audit", f.evidence));
      return buildDocumentAnnotation({
        bomJson,
        message: f.message,
        properties,
      });
    })
    .filter((annotation) => {
      if (!annotation) {
        if (!warnedMissingAnnotator) {
          warnMissingAnnotator("audit");
          warnedMissingAnnotator = true;
        }
        return false;
      }
      return true;
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
