/**
 * JSON reporter — emits a stable, documented structure for programmatic use.
 * No dependencies.
 */

/**
 * @param {object} report Output of validateBomAdvanced().
 * @param {object} [options]
 * @param {boolean} [options.pretty] Pretty-print when true (default: true).
 * @returns {string}
 */
export function render(report, options = {}) {
  const { pretty = true } = options;
  const payload = {
    schemaValid: report.schemaValid,
    deepValid: report.deepValid,
    signatureVerified: report.signatureVerified ?? null,
    summary: report.summary,
    benchmarks: report.benchmarks || [],
    findings: (report.findings || []).map((f) => ({
      ruleId: f.ruleId,
      name: f.name,
      description: f.description,
      engine: f.engine,
      standard: f.standard,
      standardRefs: f.standardRefs,
      scvsLevels: f.scvsLevels,
      category: f.category,
      status: f.status,
      severity: f.severity,
      automatable: f.automatable,
      message: f.message,
      mitigation: f.mitigation,
      locations: f.locations || [],
      evidence: f.evidence || null,
    })),
  };
  return JSON.stringify(payload, null, pretty ? 2 : 0);
}
