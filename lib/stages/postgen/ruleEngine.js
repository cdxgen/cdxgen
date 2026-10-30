/**
 * JSONata-powered rule engine for audits
 * Loads YAML rules and evaluates them against CycloneDX BOMs
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { Purl } from "@cdxgen/cdx-purl";
import { parse as loadYaml } from "yaml";

import { DEBUG_MODE, readEnvironmentVariable } from "../../core/activity.js";
import { safeExistsSync } from "../../core/fs.js";

let jsonata;

try {
  ({ default: jsonata } = await import("jsonata"));
} catch {
  jsonata = () => {
    throw new Error(
      "BOM audit rule evaluation requires the optional `jsonata` dependency. Install optional dependencies or add `jsonata` to use `--bom-audit`.",
    );
  };
}

/**
 * Helper: Extract property value from CycloneDX properties array
 * Usage in JSONata: $prop(component, 'cdx:github:action:isShaPinned')
 * Returns string value or null if not found
 */
function extractProperty(obj, propName) {
  if (!obj?.properties || !Array.isArray(obj.properties)) {
    return null;
  }
  const prop = obj.properties.find((p) => p?.name === propName);
  return prop?.value ?? null;
}

function dedupeObjectsByIdentity(items) {
  const seen = new Set();
  const deduped = [];
  (items || []).forEach((item) => {
    if (!item) {
      return;
    }
    const key =
      item["bom-ref"] ||
      item.purl ||
      `${item.type || "unknown"}:${item.name || "unnamed"}:${item.version || ""}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    deduped.push(item);
  });
  return deduped;
}

function getFormulationEntries(bomJson) {
  return Array.isArray(bomJson?.formulation) ? bomJson.formulation : [];
}

function getFormulationComponents(bomJson) {
  return getFormulationEntries(bomJson).flatMap(
    (entry) => entry?.components || [],
  );
}

function getAuditComponents(bomJson) {
  return dedupeObjectsByIdentity([
    ...(Array.isArray(bomJson?.components) ? bomJson.components : []),
    ...getFormulationComponents(bomJson),
  ]);
}

function getAuditWorkflows(bomJson) {
  return dedupeObjectsByIdentity(
    getFormulationEntries(bomJson).flatMap((entry) => entry?.workflows || []),
  );
}

function flattenServices(services, result = []) {
  if (!Array.isArray(services)) {
    return result;
  }
  for (const service of services) {
    if (!service) {
      continue;
    }
    result.push(service);
    if (Array.isArray(service.services) && service.services.length) {
      flattenServices(service.services, result);
    }
  }
  return result;
}

function getAuditServices(bomJson) {
  const formulationServices = getFormulationEntries(bomJson).flatMap(
    (entry) => entry?.services || [],
  );
  return dedupeObjectsByIdentity(
    flattenServices([...(bomJson?.services || []), ...formulationServices]),
  );
}

function normalizeAttackMetadata(rule) {
  const tactics = Array.isArray(rule?.attack?.tactics)
    ? rule.attack.tactics
    : [];
  const techniques = Array.isArray(rule?.attack?.techniques)
    ? rule.attack.techniques
    : [];
  return {
    tactics: tactics
      .filter((value) => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim()),
    techniques: techniques
      .filter((value) => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim()),
  };
}

function normalizeStandardsMetadata(rule) {
  if (!rule?.standards || typeof rule.standards !== "object") {
    return undefined;
  }
  const normalized = {};
  for (const [standardName, entries] of Object.entries(rule.standards)) {
    const values = Array.isArray(entries) ? entries : [entries];
    const filtered = values
      .filter((value) => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim());
    if (filtered.length) {
      normalized[standardName] = filtered;
    }
  }
  return Object.keys(normalized).length ? normalized : undefined;
}

function normalizeDryRunSupport(rule) {
  const rawValue =
    typeof rule?.["dry-run-support"] === "string"
      ? rule["dry-run-support"]
      : typeof rule?.dryRunSupport === "string"
        ? rule.dryRunSupport
        : undefined;
  if (rawValue !== undefined && !["no", "partial", "full"].includes(rawValue)) {
    if (DEBUG_MODE) {
      console.warn(
        `Rule ${rule?.id || "unknown"} has invalid dry-run-support '${rawValue}'; defaulting to 'partial'`,
      );
    }
    return "partial";
  }
  return ["no", "partial", "full"].includes(rawValue) ? rawValue : "partial";
}

/**
 * Helper: Check if property exists and equals expected value
 * Usage: $hasProp(component, 'cdx:foo', 'bar')
 */
function hasProperty(obj, propName, expectedValue) {
  const value = extractProperty(obj, propName);
  if (expectedValue === undefined) {
    return value !== null;
  }
  // A repeatable property (cdx:crypto:sourceType on a certificate found by
  // several producers) matches when any of its values does.
  return extractPropertyValues(obj, propName).includes(String(expectedValue));
}

function extractPropertyValues(obj, propName) {
  if (!Array.isArray(obj?.properties)) {
    return [];
  }
  return obj.properties
    .filter((p) => p?.name === propName && p.value !== undefined)
    .map((p) => String(p.value));
}

/**
 * Helper: Safe JSONata evaluation with timeout protection
 */
async function safeEvaluate(expression, context, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`JSONata evaluation timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    expression
      .evaluate(context)
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function getImageRef(val) {
  if (typeof val === "string") {
    return val;
  }
  if (val && typeof val === "object") {
    // Try extract from purl first
    if (val.purl && typeof val.purl === "string") {
      try {
        const purlObj = Purl.parse(val.purl);
        if (purlObj.type === "oci") {
          let repo = purlObj.name;
          const repoUrl = purlObj.qualifiers?.repository_url;
          if (repoUrl) {
            repo = repoUrl.replace(/^https?:\/\//, "");
          }
          if (purlObj.version) {
            if (purlObj.version.startsWith("sha256:")) {
              return `${repo}@${purlObj.version}`;
            }
            return `${repo}:${purlObj.version}`;
          }
          const tag = purlObj.qualifiers?.tag;
          if (tag) {
            return `${repo}:${tag}`;
          }
          return repo;
        }
      } catch {
        // ignore purl parse errors
      }
    }
    // Fallback to name/version
    if (val.name) {
      if (val.name.includes(":") || val.name.includes("@")) {
        return val.name;
      }
      if (val.version) {
        return `${val.name}:${val.version}`;
      }
      return val.name;
    }
  }
  return null;
}

/**
 * Registry SBOM lookups (`$hasSbom`/`$hasSignedSbom`) perform network I/O from
 * inside JSONata, whose whole-expression evaluation is bounded by safeEvaluate's
 * 5000ms timeout. A slow or unreachable registry must not consume that budget
 * and abort the rule (which would drop findings, e.g. CTR-009 stops reporting a
 * missing SBOM). Bound each probe well under the JSONata budget and fail closed:
 * an unresolved probe is treated as "no SBOM found".
 */
const SBOM_PROBE_TIMEOUT_MS = Number(
  readEnvironmentVariable("CDXGEN_SBOM_PROBE_TIMEOUT_MS") || 2500,
);

/**
 * Resolve a probe promise, or fall back to a default if it rejects or does not
 * settle within the timeout. Never rejects.
 *
 * @param {Promise} promise probe promise
 * @param {*} fallback value to resolve with on timeout/error
 * @param {number} [ms] timeout in milliseconds
 * @returns {Promise} resolves with the probe result or the fallback
 */
function probeWithTimeout(promise, fallback, ms = SBOM_PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    if (typeof timer?.unref === "function") {
      timer.unref();
    }
    Promise.resolve(promise)
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(fallback);
      });
  });
}

/**
 * Register custom JSONata functions for CycloneDX property access
 */
function registerCdxHelpers(expression, helpers = {}) {
  expression.registerFunction("hasSbom", async (val) => {
    const image = getImageRef(val);
    if (!image || !helpers.getBomWithOras) return false;
    const bom = await probeWithTimeout(
      helpers.getBomWithOras(image),
      undefined,
    );
    return bom !== undefined;
  });

  expression.registerFunction("hasSignedSbom", async (val) => {
    const image = getImageRef(val);
    if (!image || !helpers.getBomWithOras) return false;
    const bom = await probeWithTimeout(
      helpers.getBomWithOras(image),
      undefined,
    );
    if (!bom) return false;
    if (bom.signature) return true;
    if (
      Array.isArray(bom.components) &&
      bom.components.some((c) => c.signature)
    )
      return true;
    if (Array.isArray(bom.services) && bom.services.some((s) => s.signature))
      return true;
    if (
      Array.isArray(bom.annotations) &&
      bom.annotations.some((a) => a.signature)
    )
      return true;
    return false;
  });

  expression.registerFunction("prop", (obj, propName) =>
    extractProperty(obj, propName),
  );
  expression.registerFunction("propValues", (obj, propName) =>
    extractPropertyValues(obj, propName),
  );
  expression.registerFunction("nullSafeProp", (obj, propName) => {
    const value = extractProperty(obj, propName);
    return value === null ? "" : value;
  });
  expression.registerFunction("hasProp", (obj, propName, expectedValue) =>
    hasProperty(obj, propName, expectedValue),
  );
  expression.registerFunction("p", (obj, propName) =>
    extractProperty(obj, propName),
  );
  expression.registerFunction("hasP", (obj, propName, expectedValue) =>
    hasProperty(obj, propName, expectedValue),
  );
  expression.registerFunction("startsWith", (str, prefix) => {
    if (typeof str !== "string" || typeof prefix !== "string") {
      return false;
    }
    return str.startsWith(prefix);
  });
  expression.registerFunction("endsWith", (str, suffix) => {
    if (typeof str !== "string" || typeof suffix !== "string") {
      return false;
    }
    return str.endsWith(suffix);
  });
  expression.registerFunction("arrayContains", (arr, value) => {
    if (!Array.isArray(arr)) return false;
    return arr.includes(value);
  });
  expression.registerFunction("propBool", (obj, propName) => {
    const val = extractProperty(obj, propName);
    if (val === null || val === undefined) {
      return null;
    }
    if (typeof val === "boolean") {
      return val;
    }
    if (typeof val === "string") {
      const normalized = val.trim().toLowerCase();
      if (normalized === "true") {
        return true;
      }
      if (normalized === "false") {
        return false;
      }
    }
    return null;
  });
  expression.registerFunction("propList", (obj, propName) => {
    const val = extractProperty(obj, propName);
    if (!val || typeof val !== "string") return [];
    return val
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  });
  expression.registerFunction("listContains", (val, target) => {
    if (Array.isArray(val)) {
      return val.some((item) => String(item).trim() === String(target).trim());
    }
    if (typeof val === "string") {
      return val
        .split(",")
        .some((item) => item.trim() === String(target).trim());
    }
    return false;
  });
  expression.registerFunction("safeStr", (val) => {
    return val === null || val === undefined ? "" : String(val).trim();
  });
  // End of validity in epoch milliseconds. A date-only value (2026-01-31)
  // is valid through the end of that day in UTC; a full RFC 3339 timestamp
  // is taken as is; anything else, or an impossible date, gives no value so
  // the rule skips the component.
  expression.registerFunction("certEndMillis", (val) =>
    parseCertificateEndMillis(val),
  );
  expression.registerFunction("parseSizeBytes", (val) => {
    if (val === null || val === undefined || val === "") {
      return null;
    }
    if (typeof val === "number") {
      return Number.isFinite(val) ? val : null;
    }
    const normalizedValue = String(val).trim();
    if (!normalizedValue) {
      return null;
    }
    const matchedValue = normalizedValue.match(
      /^(\d+(?:\.\d+)?)\s*([kmgtpe]?i?b)?$/iu,
    );
    if (!matchedValue) {
      return null;
    }
    const numericValue = Number.parseFloat(matchedValue[1]);
    if (!Number.isFinite(numericValue)) {
      return null;
    }
    const unit = (matchedValue[2] || "").toLowerCase();
    const unitMap = {
      b: 1,
      kb: 1000,
      kib: 1024,
      mb: 1000 ** 2,
      mib: 1024 ** 2,
      gb: 1000 ** 3,
      gib: 1024 ** 3,
      tb: 1000 ** 4,
      tib: 1024 ** 4,
      pb: 1000 ** 5,
      pib: 1024 ** 5,
      eb: 1000 ** 6,
      eib: 1024 ** 6,
    };
    const multiplier = unitMap[unit || "b"];
    if (!multiplier) {
      return null;
    }
    return numericValue * multiplier;
  });
  expression.registerFunction("firstNonEmpty", (...values) => {
    for (const value of values) {
      if (value === null || value === undefined) {
        continue;
      }
      if (Array.isArray(value)) {
        const candidate = value
          .map((entry) =>
            entry === null || entry === undefined ? "" : String(entry).trim(),
          )
          .filter(Boolean)
          .join(", ");
        if (candidate) {
          return candidate;
        }
        continue;
      }
      const candidate = String(value).trim();
      if (candidate) {
        return candidate;
      }
    }
    return "";
  });
  expression.registerFunction("isDarwinSystemPath", (value) => {
    if (typeof value !== "string") {
      return false;
    }
    const normalized = value.trim();
    return (
      normalized.startsWith("/bin/") ||
      normalized.startsWith("/sbin/") ||
      normalized.startsWith("/System/") ||
      normalized.startsWith("/usr/bin/") ||
      normalized.startsWith("/usr/libexec/") ||
      normalized.startsWith("/usr/sbin/") ||
      normalized.startsWith("/Library/Apple/System/") ||
      normalized.startsWith("/System/Volumes/Preboot/Cryptexes/")
    );
  });
  expression.registerFunction("isWindowsUserControlledPath", (value) => {
    if (typeof value !== "string") {
      return false;
    }
    const normalized = value.trim().replaceAll("/", "\\").toLowerCase();
    return (
      normalized.includes("\\users\\") ||
      normalized.includes("\\programdata\\") ||
      normalized.includes("\\appdata\\") ||
      normalized.includes("\\downloads\\") ||
      normalized.includes("\\desktop\\") ||
      normalized.includes("\\temp\\")
    );
  });
  expression.registerFunction("auditComponents", (bomJson) =>
    getAuditComponents(bomJson),
  );
  expression.registerFunction("auditWorkflows", (bomJson) =>
    getAuditWorkflows(bomJson),
  );
  expression.registerFunction("auditServices", (bomJson) =>
    getAuditServices(bomJson),
  );
  expression.registerFunction("formulationComponents", (bomJson) =>
    getFormulationComponents(bomJson),
  );
  // Formulation-derived rules need to know whether the formulation section
  // describes the run being reflected (whose probes the ledger already
  // counted) or a foreign BOM's record. The caller that read the evidence
  // passes its origin verdict through the options; without one, rules gated
  // on a specific origin stay silent.
  expression.registerFunction(
    "formulationOrigin",
    () => helpers?.formulationEvidence?.origin || "unknown",
  );
  // The toolchain mismatch a foreign BOM's formulation proves: the recorded
  // version of this runtime's own family differs from the runtime in use, so
  // the record describes another machine. Computed by the caller, which owns
  // the runtime facts.
  expression.registerFunction(
    "formulationRuntimeMismatch",
    () => helpers?.formulationEvidence?.runtimeMismatch,
  );
  return expression;
}

/**
 * Load and validate rules from a directory of YAML files
 * @param {string} rulesDir - Path to directory containing .yaml rule files
 * @returns {Promise<Array>} Array of parsed rule objects
 */
const FULL_TIMESTAMP_RE =
  /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d+)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/;
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Parse a certificate notValidAfter value.
 *
 * @param {*} value timestamp or date-only string
 * @returns {number|undefined} epoch milliseconds, or undefined when the value
 *   does not parse
 */
export function parseCertificateEndMillis(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  const text = value.trim();
  const dateOnly = DATE_ONLY_RE.exec(text);
  if (dateOnly) {
    const [year, month, day] = dateOnly.slice(1).map(Number);
    const start = new Date(Date.UTC(year, month - 1, day));
    if (
      start.getUTCFullYear() !== year ||
      start.getUTCMonth() !== month - 1 ||
      start.getUTCDate() !== day
    ) {
      return undefined;
    }
    return start.getTime() + 24 * 60 * 60 * 1000 - 1;
  }
  if (!FULL_TIMESTAMP_RE.test(text)) {
    return undefined;
  }
  const millis = Date.parse(text);
  return Number.isNaN(millis) ? undefined : millis;
}

export async function loadRules(rulesDir) {
  const rules = [];
  if (!safeExistsSync(rulesDir)) {
    if (DEBUG_MODE) {
      console.warn(`Rules directory not found: ${rulesDir}`);
    }
    return rules;
  }
  try {
    if (!statSync(rulesDir)?.isDirectory()) {
      if (DEBUG_MODE) {
        console.warn(`Rules path is not a directory: ${rulesDir}`);
      }
      return rules;
    }
  } catch (err) {
    if (DEBUG_MODE) {
      console.warn(`Cannot stat rules directory ${rulesDir}:`, err.message);
    }
    return rules;
  }
  let ruleFiles = [];
  try {
    ruleFiles = readdirSync(rulesDir);
  } catch (err) {
    if (DEBUG_MODE) {
      console.warn(`Cannot read rules directory ${rulesDir}:`, err.message);
    }
    return rules;
  }
  for (const file of ruleFiles) {
    if (!file.endsWith(".yaml") && !file.endsWith(".yml")) {
      continue;
    }
    const filePath = join(rulesDir, file);
    try {
      if (!statSync(filePath).isFile()) {
        continue;
      }
    } catch (_err) {
      continue;
    }
    try {
      const content = loadYaml(readFileSync(filePath, "utf-8"));
      const fileRules = Array.isArray(content) ? content : [content];
      for (const rule of fileRules) {
        if (!rule.id || typeof rule.id !== "string") {
          console.warn(`Rule in ${file} missing required field: id (string)`);
          continue;
        }
        if (!rule.condition || typeof rule.condition !== "string") {
          console.warn(
            `Rule ${rule.id} missing required field: condition (string)`,
          );
          continue;
        }
        if (!rule.message || typeof rule.message !== "string") {
          console.warn(
            `Rule ${rule.id} missing required field: message (string)`,
          );
          continue;
        }
        rule.severity = rule.severity || "medium";
        rule.category = rule.category || "unknown";
        rule.dryRunSupport = normalizeDryRunSupport(rule);
        const attack = normalizeAttackMetadata(rule);
        if (attack.tactics.length || attack.techniques.length) {
          rule.attack = attack;
        }
        if (!["critical", "high", "medium", "low"].includes(rule.severity)) {
          console.warn(
            `Rule ${rule.id} has invalid severity '${rule.severity}'; defaulting to 'medium'`,
          );
          rule.severity = "medium";
        }
        rules.push(rule);
      }
    } catch (err) {
      console.warn(`Failed to load rule file ${filePath}:`, err.message);
    }
  }
  if (DEBUG_MODE) {
    console.log(`Loaded ${rules.length} audit rules from ${rulesDir}`);
  }
  return rules;
}

/**
 * Interpolate template strings with JSONata expressions
 * Supports {{ expression }} syntax for dynamic message/evidence generation
 */
async function interpolateTemplate(template, context, options = {}) {
  if (!template || typeof template !== "string") {
    return template;
  }
  const templateRegex = /\{\{\s*([^}]+)\s*}}/g;
  // The template is rebuilt from its own slices in one pass, so a value taken
  // from the BOM is never scanned for {{ }} again and never read as a
  // String.replace pattern such as `$&`.
  let result = "";
  let cursor = 0;
  for (const match of template.matchAll(templateRegex)) {
    const [fullMatch, expr] = match;
    let replacement = fullMatch;
    try {
      const expression = jsonata(expr.trim());
      registerCdxHelpers(expression, options);
      const value = await safeEvaluate(expression, context);
      if (value !== undefined) {
        replacement = String(value);
      }
    } catch (err) {
      if (DEBUG_MODE) {
        console.warn(
          `Template interpolation failed for '{{${expr}}}':`,
          err.message,
        );
      }
    }
    result += template.slice(cursor, match.index) + replacement;
    cursor = match.index + fullMatch.length;
  }
  result += template.slice(cursor);
  return result;
}

/**
 * Evaluate a single rule against the BOM using JSONata
 * @param {Object} rule - Parsed rule object
 * @param {Object} bomJson - Full CycloneDX BOM object
 * @returns {Promise<Array>} Array of matched findings
 */
export async function evaluateRule(rule, bomJson, options = {}) {
  const findings = [];
  try {
    const conditionExpr = jsonata(rule.condition);
    registerCdxHelpers(conditionExpr, options);
    const conditionResult = await safeEvaluate(conditionExpr, bomJson);
    const matches = Array.isArray(conditionResult)
      ? conditionResult.filter((m) => m !== null && m !== undefined)
      : conditionResult
        ? [conditionResult]
        : [];
    if (matches.length === 0) {
      return findings;
    }
    for (const item of matches) {
      const attack = normalizeAttackMetadata(rule);
      const standards = normalizeStandardsMetadata(rule);
      const context = {
        ...item,
        bom: bomJson,
        components: getAuditComponents(bomJson),
        workflows: getAuditWorkflows(bomJson),
        auditServices: getAuditServices(bomJson),
        formulationComponents: getFormulationComponents(bomJson),
        services: getAuditServices(bomJson),
        metadata: bomJson.metadata || {},
      };
      const message = await interpolateTemplate(rule.message, context, options);
      let location = null;
      if (rule.location) {
        try {
          const locationExpr = jsonata(rule.location);
          registerCdxHelpers(locationExpr, options);
          location = await safeEvaluate(locationExpr, context);
        } catch (err) {
          if (DEBUG_MODE) {
            console.warn(
              `Failed to extract location for rule ${rule.id}:`,
              err.message,
            );
          }
        }
      }
      let evidence = null;
      if (rule.evidence) {
        try {
          const evidenceExpr = jsonata(rule.evidence);
          registerCdxHelpers(evidenceExpr, options);
          evidence = await safeEvaluate(evidenceExpr, context);
        } catch (err) {
          if (DEBUG_MODE) {
            console.warn(
              `Failed to extract evidence for rule ${rule.id}:`,
              err.message,
            );
          }
        }
      }
      findings.push({
        attack,
        attackTactics: attack.tactics,
        attackTechniques: attack.techniques,
        standards,
        ruleId: rule.id,
        name: rule.name || rule.id,
        description: rule.description,
        severity: rule.severity,
        category: rule.category,
        message,
        mitigation: rule.mitigation,
        location,
        evidence,
        _match: item,
      });
    }
  } catch (err) {
    console.warn(
      `Failed to evaluate rule ${rule?.id || "unknown"}:`,
      err.message,
    );
    if (DEBUG_MODE && err.stack) {
      console.debug(err.stack);
    }
  }
  return findings;
}

/**
 * Evaluate all rules against a BOM
 */
export async function evaluateRules(rules, bomJson, options = {}) {
  const allFindings = [];
  for (const rule of rules) {
    const findings = await evaluateRule(rule, bomJson, options);
    allFindings.push(...findings);
  }
  const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  allFindings.sort((a, b) => {
    const sevDiff = severityOrder[a.severity] - severityOrder[b.severity];
    return sevDiff !== 0 ? sevDiff : a.ruleId.localeCompare(b.ruleId);
  });
  return allFindings;
}
