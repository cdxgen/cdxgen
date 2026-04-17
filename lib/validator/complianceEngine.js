/**
 * Orchestrates evaluation of internal compliance rule packs (SCVS + CRA) and
 * aggregates results into per-benchmark scorecards.
 *
 * This module is deliberately independent of the CycloneDX BOM audit engine
 * (lib/stages/postgen/auditBom.js). The two engines share similar *Finding*
 * output shape so reporters can consume either source uniformly.
 */

import {
  getAllComplianceRules,
  getCraRules,
  getScvsRules,
} from "./complianceRules.js";

/**
 * Benchmark alias → rule filter.
 * Aliases are resolved case-insensitively on the CLI.
 */
const BENCHMARKS = {
  scvs: {
    id: "scvs",
    name: "OWASP SCVS (all levels)",
    standard: "SCVS",
    filter: (rules) => rules.filter((r) => r.standard === "SCVS"),
    // All SCVS rules are considered for overall score regardless of level.
    levelPredicate: () => true,
  },
  "scvs-l1": {
    id: "scvs-l1",
    name: "OWASP SCVS Level 1",
    standard: "SCVS",
    filter: (rules) =>
      rules.filter(
        (r) => r.standard === "SCVS" && r.scvsLevels?.includes("L1"),
      ),
    levelPredicate: (rule) => rule.scvsLevels?.includes("L1"),
  },
  "scvs-l2": {
    id: "scvs-l2",
    name: "OWASP SCVS Level 2",
    standard: "SCVS",
    filter: (rules) =>
      rules.filter(
        (r) => r.standard === "SCVS" && r.scvsLevels?.includes("L2"),
      ),
    levelPredicate: (rule) => rule.scvsLevels?.includes("L2"),
  },
  "scvs-l3": {
    id: "scvs-l3",
    name: "OWASP SCVS Level 3",
    standard: "SCVS",
    filter: (rules) =>
      rules.filter(
        (r) => r.standard === "SCVS" && r.scvsLevels?.includes("L3"),
      ),
    levelPredicate: (rule) => rule.scvsLevels?.includes("L3"),
  },
  cra: {
    id: "cra",
    name: "EU Cyber Resilience Act (SBOM expectations)",
    standard: "CRA",
    filter: (rules) => rules.filter((r) => r.standard === "CRA"),
    levelPredicate: () => true,
  },
};

/**
 * Resolve a benchmark alias (case-insensitive). Returns null when unknown.
 *
 * @param {string} alias
 * @returns {object | null}
 */
export function resolveBenchmark(alias) {
  if (typeof alias !== "string") return null;
  return BENCHMARKS[alias.trim().toLowerCase()] || null;
}

/**
 * List all known benchmark aliases in a stable display order.
 *
 * @returns {Array<object>}
 */
export function listBenchmarks() {
  return Object.values(BENCHMARKS);
}

/**
 * Evaluate one rule against the BOM and return a Finding-shaped object.
 *
 * Rules are pure synchronous functions, but we wrap them in try/catch so one
 * bad rule cannot fail the entire run.
 *
 * @param {object} rule
 * @param {object} bomJson
 * @returns {object} Finding
 */
export function evaluateRule(rule, bomJson) {
  let result;
  try {
    result = rule.evaluate(bomJson);
  } catch (err) {
    result = {
      status: "fail",
      message: `Rule evaluation threw: ${err?.message || err}`,
    };
  }
  const {
    status = "fail",
    message,
    mitigation,
    locations,
    evidence,
  } = result || {};
  // Non-automatable rules always emit `info` severity regardless of status.
  const severity =
    rule.automatable === false
      ? "info"
      : status === "fail"
        ? rule.severity || "medium"
        : status === "manual"
          ? "info"
          : "info";
  return {
    engine: "compliance",
    ruleId: rule.id,
    name: rule.name,
    description: rule.description,
    category: rule.category,
    standard: rule.standard,
    standardRefs: rule.standardRefs || [rule.id],
    scvsLevels: rule.scvsLevels || [],
    automatable: rule.automatable !== false,
    status,
    severity,
    message: message || rule.name,
    mitigation: mitigation || rule.mitigation,
    locations: Array.isArray(locations) ? locations : [],
    evidence: evidence && typeof evidence === "object" ? evidence : null,
  };
}

/**
 * Evaluate every rule in the catalog, or a filtered subset.
 *
 * @param {object} bomJson CycloneDX BOM
 * @param {object} [opts]
 * @param {Array<string>} [opts.categories] Filter to these category values.
 * @param {Array<string>} [opts.benchmarks] Only run rules from these benchmark aliases.
 * @returns {Array<object>} Findings (one per rule)
 */
export function evaluateAll(bomJson, opts = {}) {
  let rules = getAllComplianceRules();
  if (Array.isArray(opts.categories) && opts.categories.length > 0) {
    const wanted = new Set(opts.categories.map((c) => c.toLowerCase()));
    rules = rules.filter((r) => wanted.has((r.category || "").toLowerCase()));
  }
  if (Array.isArray(opts.benchmarks) && opts.benchmarks.length > 0) {
    const selected = new Set();
    for (const alias of opts.benchmarks) {
      const bench = resolveBenchmark(alias);
      if (bench) {
        for (const r of bench.filter(rules)) {
          selected.add(r.id);
        }
      }
    }
    rules = rules.filter((r) => selected.has(r.id));
  }
  return rules.map((r) => evaluateRule(r, bomJson));
}

/**
 * Produce a scorecard for a single benchmark against a set of already-evaluated
 * findings. Scoring rules:
 *   - pass      counts as 1 / 1.
 *   - fail      counts as 0 / 1.
 *   - manual    is excluded from the percentage but counted separately.
 *
 * This mirrors how OWASP SCVS publishes results: automatable controls score a
 * percentage, manual controls are reported so reviewers can address them.
 *
 * @param {object} benchmark Result of resolveBenchmark
 * @param {Array<object>} findings Full set of findings from evaluateAll
 * @returns {object}
 */
export function scoreBenchmark(benchmark, findings) {
  const catalog = benchmark.filter(getAllComplianceRules());
  const byId = new Map(findings.map((f) => [f.ruleId, f]));
  const controls = [];
  let pass = 0;
  let failed = 0;
  let manual = 0;
  for (const rule of catalog) {
    const f = byId.get(rule.id) || evaluateRule(rule, {});
    controls.push({
      id: rule.id,
      name: rule.name,
      standardRefs: rule.standardRefs,
      status: f.status,
      severity: f.severity,
      automatable: rule.automatable !== false,
      message: f.message,
    });
    if (f.status === "pass") pass += 1;
    else if (f.status === "fail") failed += 1;
    else manual += 1;
  }
  const automatable = pass + failed;
  const scorePct =
    automatable === 0 ? 0 : Math.round((pass / automatable) * 100);
  return {
    id: benchmark.id,
    name: benchmark.name,
    standard: benchmark.standard,
    totalControls: catalog.length,
    pass,
    fail: failed,
    manual,
    automatable,
    scorePct,
    controls,
  };
}

/**
 * Build scorecards for each requested benchmark. When no benchmarks are
 * specified, returns scorecards for every built-in benchmark alias.
 *
 * @param {Array<object>} findings
 * @param {Array<string>} [requestedAliases]
 * @returns {Array<object>}
 */
export function buildBenchmarkReports(findings, requestedAliases) {
  const aliases = requestedAliases?.length
    ? requestedAliases.map((a) => resolveBenchmark(a)).filter(Boolean)
    : Object.values(BENCHMARKS);
  return aliases.map((b) => scoreBenchmark(b, findings));
}

export { getAllComplianceRules, getCraRules, getScvsRules };
