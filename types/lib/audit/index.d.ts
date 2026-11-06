/** Default predictive audit category list applied when none are explicitly requested. */
export declare const DEFAULT_AUDIT_CATEGORIES: string[];
/**
 * Read and validate a CycloneDX BOM file. A CycloneDX 2.0 document is read
 * into cdxgen's internal 1.x-shaped model, so the audit rules keep reading
 * `components`, `bom-ref` and `metadata.component`; the number of losses
 * the read reported is printed once on stderr, with the details in
 * thoughtLog.
 *
 * @param {string} bomPath BOM file path
 * @returns {object} parsed CycloneDX BOM in the 1.x shape
 */
export declare function loadBomFile(bomPath: string): object;
/**
 * Recursively list JSON files under a BOM directory.
 *
 * @param {string} bomDir directory path
 * @returns {string[]} discovered file paths
 */
export declare function listBomFiles(bomDir: string): string[];
/**
 * Load input BOM files from either a single file or a directory.
 *
 * @param {object} options CLI options
 * @returns {{ source: string, bomJson: object }[]} loaded input BOMs
 */
export declare function loadInputBoms(options: object): {
    source: string;
    bomJson: object;
}[];
/**
 * Run the direct (post-generation) BOM policy audit over loaded input BOMs.
 *
 * Audits each supplied BOM with {@link auditBom}, collects per-BOM findings and
 * summaries, and aggregates them into a single report keyed by `auditMode: "direct"`.
 *
 * @param {{ source: string, bomJson: object }[]} inputBoms Loaded CycloneDX BOM objects to audit
 * @param {object} [options={}] CLI options including optional category, severity, and rules configuration
 * @returns {Promise<object>} Aggregate direct audit report with per-BOM results and a rollup summary
 */
export declare function runDirectBomAuditFromBoms(inputBoms: {
    source: string;
    bomJson: object;
}[], options?: object): Promise<object>;
/**
 * Build low-noise provenance-aware contextual findings from the root BOM target.
 *
 * These are intentionally conservative and only fire when there is explicit risk
 * posture already present in the target metadata.
 *
 * @param {object} target audit target
 * @returns {object[]} contextual findings
 */
export declare function buildTargetContextFindings(target: object): object[];
/**
 * Resolve the most specific Python package directory inside a cloned repo.
 *
 * @param {string} cloneDir cloned repository root
 * @param {object} target audit target
 * @returns {{ confidence: string, scanDir: string }} selected directory and confidence
 */
export declare function resolvePythonSourceDirectory(cloneDir: string, target: object): {
    confidence: string;
    scanDir: string;
};
/**
 * Resolve the most appropriate scan directory for a cloned target repository.
 *
 * @param {string} cloneDir cloned repository root
 * @param {object} target audit target
 * @param {object} resolution repository resolution metadata
 * @returns {{ confidence: string, scanDir: string }} selected directory and confidence
 */
export declare function resolveTargetSourceDirectory(cloneDir: string, target: object, resolution: object): {
    confidence: string;
    scanDir: string;
};
/**
 * Build shallow predictive findings for suspicious Python packaging files.
 *
 * Phase 1 intentionally focuses on high-signal packaging surfaces (`setup.py`
 * and package `__init__.py`) until deeper Python static analysis is added.
 *
 * @param {string} scanDir cloned repository scan directory
 * @param {object} target audit target
 * @returns {object[]} predictive findings
 */
export declare function buildPythonSourceHeuristicFindings(scanDir: string, target: object): object[];
/**
 * Analyze a single purl target by generating a child SBOM and auditing it.
 *
 * @param {object} target audit target
 * @param {object} options CLI options
 * @returns {Promise<object>} analyzed target result
 */
export declare function auditTarget(target: object, options: object): Promise<object>;
/**
 * Consolidate per-target audit results into shared repo/CI alert groups.
 *
 * Groups results that share a common repository/CI provenance (or cargo
 * repository/namespace) into consolidated alert entries while preserving
 * single-target results unchanged.
 *
 * @param {object[]} results Per-target audit result objects
 * @returns {object[]} Grouped result objects with consolidated entries where applicable
 */
export declare function groupAuditResults(results: object[]): object[];
/**
 * Run the predictive audit flow from one or more already-loaded CycloneDX BOM inputs.
 *
 * @param {{ source: string, bomJson: object }[]} inputBoms loaded CycloneDX BOM objects
 * @param {object} options CLI options
 * @returns {Promise<object>} aggregate audit report
 */
export declare function runAuditFromBoms(inputBoms: {
    source: string;
    bomJson: object;
}[], options: object): Promise<object>;
/**
 * Run the predictive audit flow from one or more CycloneDX BOM inputs.
 *
 * @param {object} options CLI options
 * @returns {Promise<object>} aggregate audit report
 */
export declare function runAudit(options: object): Promise<object>;
/**
 * Aggregates license compliance violations onto the report. Violations come
 * from two sources: the input BOM(s) directly, and — in predictive mode — the
 * per-dependency child SBOMs generated from cloned upstream sources (carried on
 * each target result). Duplicates across both are collapsed so the same
 * component/license/alert is reported once. No-op without a policy.
 *
 * @param {object} report aggregate audit report (mutated)
 * @param {object[]} inputBoms loaded input BOMs
 * @param {object|null} policy preloaded compliance policy
 * @returns {void}
 */
export declare function attachLicenseViolations(report: object, inputBoms: object[], policy: object | null): void;
/**
 * Render a report and compute the proper process exit code.
 *
 * @param {object} report aggregate report
 * @param {object} options CLI options
 * @returns {{ exitCode: number, output: string }} rendered output and exit code
 */
export declare function finalizeAuditReport(report: object, options: object): {
    exitCode: number;
    output: string;
};
/**
 * Build a result file name for user-provided report output paths.
 *
 * @param {object} options CLI options
 * @returns {string | undefined} output file path
 */
export declare function defaultOutputFile(options: object): string | undefined;
//# sourceMappingURL=index.d.ts.map