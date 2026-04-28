/**
 * Read and validate a CycloneDX BOM file.
 *
 * @param {string} bomPath BOM file path
 * @returns {object} parsed CycloneDX BOM
 */
export function loadBomFile(bomPath: string): object;
/**
 * Recursively list JSON files under a BOM directory.
 *
 * @param {string} bomDir directory path
 * @returns {string[]} discovered file paths
 */
export function listBomFiles(bomDir: string): string[];
/**
 * Load input BOM files from either a single file or a directory.
 *
 * @param {object} options CLI options
 * @returns {{ source: string, bomJson: object }[]} loaded input BOMs
 */
export function loadInputBoms(options: object): {
    source: string;
    bomJson: object;
}[];
/**
 * Build low-noise provenance-aware contextual findings from the root BOM target.
 *
 * These are intentionally conservative and only fire when there is explicit risk
 * posture already present in the target metadata.
 *
 * @param {object} target audit target
 * @returns {object[]} contextual findings
 */
export function buildTargetContextFindings(target: object): object[];
/**
 * Resolve the most specific Python package directory inside a cloned repo.
 *
 * @param {string} cloneDir cloned repository root
 * @param {object} target audit target
 * @returns {{ confidence: string, scanDir: string }} selected directory and confidence
 */
export function resolvePythonSourceDirectory(cloneDir: string, target: object): {
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
export function resolveTargetSourceDirectory(cloneDir: string, target: object, resolution: object): {
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
export function buildPythonSourceHeuristicFindings(scanDir: string, target: object): object[];
/**
 * Analyze a single purl target by generating a child SBOM and auditing it.
 *
 * @param {object} target audit target
 * @param {object} options CLI options
 * @returns {Promise<object>} analyzed target result
 */
export function auditTarget(target: object, options: object): Promise<object>;
export function groupAuditResults(results: any): any[];
/**
 * Run the predictive audit flow from one or more already-loaded CycloneDX BOM inputs.
 *
 * @param {{ source: string, bomJson: object }[]} inputBoms loaded CycloneDX BOM objects
 * @param {object} options CLI options
 * @returns {Promise<object>} aggregate audit report
 */
export function runAuditFromBoms(inputBoms: {
    source: string;
    bomJson: object;
}[], options: object): Promise<object>;
/**
 * Run the predictive audit flow from one or more CycloneDX BOM inputs.
 *
 * @param {object} options CLI options
 * @returns {Promise<object>} aggregate audit report
 */
export function runAudit(options: object): Promise<object>;
/**
 * Render a report and compute the proper process exit code.
 *
 * @param {object} report aggregate report
 * @param {object} options CLI options
 * @returns {{ exitCode: number, output: string }} rendered output and exit code
 */
export function finalizeAuditReport(report: object, options: object): {
    exitCode: number;
    output: string;
};
/**
 * Build a result file name for user-provided report output paths.
 *
 * @param {object} options CLI options
 * @returns {string | undefined} output file path
 */
export function defaultOutputFile(options: object): string | undefined;
export const DEFAULT_AUDIT_CATEGORIES: string[];
//# sourceMappingURL=index.d.ts.map