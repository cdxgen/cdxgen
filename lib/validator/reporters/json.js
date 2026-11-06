/**
 * JSON reporter — emits a stable, documented structure for programmatic use.
 * No dependencies.
 */

/**
 * @param {object} report Output of validateBomAdvanced().
 * @param {object} [_options] Unused
 * @returns {string}
 */
export function render(report, _options = {}) {
  const payload = {
    schemaValid: report.schemaValid,
    deepValid: report.deepValid,
    validationErrors: report.validationErrors || [],
    signatureVerified: report.signatureVerified ?? null,
    signatureEntries: report.signatureEntries ?? null,
    // What reading a CycloneDX 2.0 input into the 1.x model behind the rules
    // could not hold, as RFC 6901 pointers; empty for 1.x input.
    readLosses: (report.readLosses || []).map((loss) => ({
      pointer: loss.pointer,
      reason: loss.reason,
    })),
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
  return JSON.stringify(payload, null, null);
}
