/**
 * JSONata-powered rule engine for audits
 * Loads YAML rules and evaluates them against CycloneDX BOMs
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { parse as loadYaml } from "yaml";

import { DEBUG_MODE, safeExistsSync } from "../../helpers/utils.js";

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

/**
 * Helper: Check if property exists and equals expected value
 * Usage: $hasProp(component, 'cdx:foo', 'bar')
 */
function hasProperty(obj, propName, expectedValue) {
  const value = extractProperty(obj, propName);
  if (expectedValue === undefined) {
    return value !== null;
  }
  return value === String(expectedValue);
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

/**
 * Register custom JSONata functions for CycloneDX property access
 */
function registerCdxHelpers(expression) {
  expression.registerFunction("prop", (obj, propName) =>
    extractProperty(obj, propName),
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
  return expression;
}

/**
 * Load and validate rules from a directory of YAML files
 * @param {string} rulesDir - Path to directory containing .yaml rule files
 * @returns {Promise<Array>} Array of parsed rule objects
 */
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
async function interpolateTemplate(template, context) {
  if (!template || typeof template !== "string") {
    return template;
  }
  const templateRegex = /\{\{\s*([^}]+)\s*}}/g;
  let result = template;
  const matches = [...template.matchAll(templateRegex)];
  for (const match of matches) {
    const [fullMatch, expr] = match;
    try {
      const expression = jsonata(expr.trim());
      registerCdxHelpers(expression);
      const value = await safeEvaluate(expression, context);
      const replacement = value !== undefined ? String(value) : fullMatch;
      result = result.replace(fullMatch, replacement);
    } catch (err) {
      if (DEBUG_MODE) {
        console.warn(
          `Template interpolation failed for '{{${expr}}}':`,
          err.message,
        );
      }
    }
  }
  return result;
}

/**
 * Evaluate a single rule against the BOM using JSONata
 * @param {Object} rule - Parsed rule object
 * @param {Object} bomJson - Full CycloneDX BOM object
 * @returns {Promise<Array>} Array of matched findings
 */
export async function evaluateRule(rule, bomJson) {
  const findings = [];
  try {
    const conditionExpr = jsonata(rule.condition);
    registerCdxHelpers(conditionExpr);
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
      const context = {
        ...item,
        bom: bomJson,
        components: bomJson.components || [],
        workflows: bomJson.formulation?.[0]?.workflows || [],
        services: bomJson.services || [],
        metadata: bomJson.metadata || {},
      };
      const message = await interpolateTemplate(rule.message, context);
      let location = null;
      if (rule.location) {
        try {
          const locationExpr = jsonata(rule.location);
          registerCdxHelpers(locationExpr);
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
          registerCdxHelpers(evidenceExpr);
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
export async function evaluateRules(rules, bomJson) {
  const allFindings = [];
  for (const rule of rules) {
    const findings = await evaluateRule(rule, bomJson);
    allFindings.push(...findings);
  }
  const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  allFindings.sort((a, b) => {
    const sevDiff = severityOrder[a.severity] - severityOrder[b.severity];
    return sevDiff !== 0 ? sevDiff : a.ruleId.localeCompare(b.ruleId);
  });
  return allFindings;
}
