/**
 * cdx-validate orchestrator.
 *
 * Combines cdxgen's existing structural validation
 * ({@link ./bomValidator.js}) with the compliance rule packs in
 * {@link ./complianceEngine.js} and (optionally) signature verification from
 * {@link ../helpers/bomSigner.js}.
 *
 * This module exposes a single high-level function, `validateBomAdvanced`,
 * and helpers to classify the result. It does *not* perform any I/O: the CLI
 * wrapper (`bin/validate.js`) is responsible for reading the input BOM.
 */

import { verifyNode } from "../helpers/bomSigner.js";
import {
  validateBom,
  validateMetadata,
  validateProps,
  validatePurls,
  validateRefs,
} from "./bomValidator.js";
import { buildBenchmarkReports, evaluateAll } from "./complianceEngine.js";

const SEVERITY_ORDER = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

/**
 * Compute the summary block of the report.
 *
 * @param {Array<object>} findings
 * @returns {object}
 */
function summarize(findings) {
  let pass = 0;
  let failed = 0;
  let manual = 0;
  let errors = 0;
  let warnings = 0;
  for (const f of findings) {
    if (f.status === "pass") pass += 1;
    else if (f.status === "fail") failed += 1;
    else if (f.status === "manual") manual += 1;
    if (
      f.status === "fail" &&
      (f.severity === "high" || f.severity === "critical")
    ) {
      errors += 1;
    } else if (f.status === "fail") {
      warnings += 1;
    }
  }
  return {
    total: findings.length,
    pass,
    fail: failed,
    manual,
    errors,
    warnings,
    schemaValid: true,
    deepValid: true,
  };
}

/**
 * Filter findings by minimum severity and optional status inclusion rules.
 *
 * @param {Array<object>} findings
 * @param {object} opts
 * @param {string} [opts.minSeverity]    "info"..."critical".
 * @param {boolean} [opts.includeManual]  When false, drop manual findings from
 *                                        the final array (they are still in
 *                                        the benchmark scorecards).
 * @param {boolean} [opts.includePass]    When false, drop pass findings.
 * @returns {Array<object>}
 */
function filterFindings(findings, opts) {
  const min = SEVERITY_ORDER[(opts.minSeverity || "info").toLowerCase()] ?? 0;
  return findings.filter((f) => {
    if (!opts.includeManual && f.status === "manual") return false;
    if (!opts.includePass && f.status === "pass") return false;
    return (SEVERITY_ORDER[f.severity] ?? 0) >= min;
  });
}

/**
 * Run schema + deep validation checks from the existing validator helpers and
 * capture their boolean results without letting them blow up the process.
 *
 * @param {object} bomJson
 * @param {object} opts
 * @returns {{ schemaValid: boolean, deepValid: boolean }}
 */
function runSchemaAndDeep(bomJson, opts) {
  let schemaValid = true;
  let deepValid = true;
  if (opts.schema !== false) {
    try {
      schemaValid = validateBom(bomJson) !== false;
    } catch (err) {
      schemaValid = false;
      if (opts.onError) opts.onError("schema", err);
    }
  }
  if (opts.deep !== false) {
    try {
      deepValid =
        validateMetadata(bomJson) !== false &&
        validatePurls(bomJson) !== false &&
        validateRefs(bomJson) !== false &&
        validateProps(bomJson) !== false;
    } catch (err) {
      deepValid = false;
      if (opts.onError) opts.onError("deep", err);
    }
  }
  return { schemaValid, deepValid };
}

/**
 * Run structural + compliance validation against a parsed BOM.
 *
 * @param {object} bomJson Parsed CycloneDX JSON BOM.
 * @param {object} [options]
 * @param {boolean} [options.schema]            Run JSON-Schema validation (default true).
 * @param {boolean} [options.deep]              Run purl/ref/metadata deep checks (default true).
 * @param {Array<string>} [options.benchmarks]  Aliases to include in the scorecards (default: all).
 * @param {Array<string>} [options.categories]  Restrict compliance rules to these categories.
 * @param {string} [options.minSeverity]        Minimum severity for returned findings.
 * @param {boolean} [options.includeManual]     Include manual-review findings (default true).
 * @param {boolean} [options.includePass]       Include passing findings (default false).
 * @param {string} [options.publicKey]          If set, verify the BOM signature.
 * @returns {{
 *   schemaValid: boolean,
 *   deepValid: boolean,
 *   signatureVerified: boolean | null,
 *   signatureDetails: object | null,
 *   findings: Array<object>,
 *   allFindings: Array<object>,
 *   benchmarks: Array<object>,
 *   summary: object
 * }}
 */
export function validateBomAdvanced(bomJson, options = {}) {
  const { schemaValid, deepValid } = runSchemaAndDeep(bomJson, options);
  const allFindings = evaluateAll(bomJson, {
    categories: options.categories,
    benchmarks: options.benchmarks,
  });
  const benchmarks = buildBenchmarkReports(allFindings, options.benchmarks);
  const filtered = filterFindings(allFindings, {
    minSeverity: options.minSeverity || "info",
    includeManual: options.includeManual !== false,
    includePass: options.includePass === true,
  });
  let signatureVerified = null;
  let signatureDetails = null;
  if (options.publicKey && bomJson?.signature) {
    try {
      const match = verifyNode(bomJson, options.publicKey);
      signatureVerified = Boolean(match);
      signatureDetails = match || null;
    } catch (err) {
      signatureVerified = false;
      signatureDetails = { error: err?.message || String(err) };
    }
  } else if (options.publicKey) {
    // Public key provided but BOM has no signature.
    signatureVerified = false;
    signatureDetails = { error: "BOM has no signature block." };
  }
  const summary = summarize(allFindings);
  summary.schemaValid = schemaValid;
  summary.deepValid = deepValid;
  return {
    schemaValid,
    deepValid,
    signatureVerified,
    signatureDetails,
    findings: filtered,
    allFindings,
    benchmarks,
    summary,
  };
}

/**
 * Decide whether a report should trigger a non-zero CLI exit.
 *
 * @param {object} report
 * @param {object} opts
 * @param {string} [opts.failSeverity] Severity level at or above which failing findings are considered a failure (default "high").
 * @param {boolean} [opts.strict]      When true, failing on any `fail` status regardless of severity, and a failing schema/deep validation also counts.
 * @param {boolean} [opts.requireSignature] Require a valid signature when verification was requested.
 * @returns {{ shouldFail: boolean, reason: string | null }}
 */
export function shouldFail(report, opts = {}) {
  if (opts.requireSignature && report.signatureVerified === false) {
    return { shouldFail: true, reason: "Signature verification failed." };
  }
  if (opts.strict && report.schemaValid === false) {
    return { shouldFail: true, reason: "Schema validation failed." };
  }
  if (opts.strict && report.deepValid === false) {
    return { shouldFail: true, reason: "Deep validation failed." };
  }
  const threshold =
    SEVERITY_ORDER[(opts.failSeverity || "high").toLowerCase()] ??
    SEVERITY_ORDER.high;
  for (const f of report.allFindings || []) {
    if (f.status !== "fail") continue;
    const sev = SEVERITY_ORDER[f.severity] ?? 0;
    if (sev >= threshold) {
      return {
        shouldFail: true,
        reason: `Rule ${f.ruleId} failed with severity ${f.severity}.`,
      };
    }
  }
  return { shouldFail: false, reason: null };
}

export { buildBenchmarkReports, evaluateAll } from "./complianceEngine.js";
export { SEVERITY_ORDER };
