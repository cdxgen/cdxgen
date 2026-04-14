/**
 * Prints the BOM components as a streaming table to the console.
 * Delegates to {@link printOSTable} automatically when the BOM metadata indicates
 * an operating-system or platform component type.
 *
 * @param {Object} bomJson CycloneDX BOM JSON object
 * @param {string[]} [filterTypes] Optional list of component types to include; all types shown when omitted
 * @param {string} [highlight] Optional string to highlight in the output
 * @returns {void}
 */
export function printTable(bomJson: Object, filterTypes?: string[], highlight?: string): void;
/**
 * Prints OS package components from the BOM as a formatted streaming table.
 *
 * @param {Object} bomJson CycloneDX BOM JSON object
 * @returns {void}
 */
export function printOSTable(bomJson: Object): void;
/**
 * Prints the services listed in the BOM as a formatted table.
 * Includes endpoint URLs, authentication flag, and cross-trust-boundary flag.
 *
 * @param {Object} bomJson CycloneDX BOM JSON object
 * @returns {void}
 */
export function printServices(bomJson: Object): void;
/**
 * Prints the formulation components from the BOM as a formatted table.
 *
 * @param {Object} bomJson CycloneDX BOM JSON object
 * @returns {void}
 */
export function printFormulation(bomJson: Object): void;
/**
 * Prints component evidence occurrences (file locations) as a streaming table.
 * Only components that have `evidence.occurrences` are included.
 *
 * @param {Object} bomJson CycloneDX BOM JSON object
 * @returns {void}
 */
export function printOccurrences(bomJson: Object): void;
/**
 * Prints the call stack evidence for each component in the BOM as a formatted table.
 * Only components that have `evidence.callstack.frames` are included.
 *
 * @param {Object} bomJson CycloneDX BOM JSON object
 * @returns {void}
 */
export function printCallStack(bomJson: Object): void;
/**
 * Prints the dependency tree from the BOM as an ASCII tree diagram.
 * Uses the `table` library for small trees and plain console output for larger ones.
 *
 * @param {Object} bomJson CycloneDX BOM JSON object containing a `dependencies` array
 * @param {string} [mode="dependsOn"] Dependency relation to traverse (`"dependsOn"` or `"provides"`)
 * @param {string} [highlight] Optional string to highlight in the tree output
 * @returns {void}
 */
export function printDependencyTree(bomJson: Object, mode?: string, highlight?: string): void;
/**
 * Prints a table of reachable components derived from a reachability slices file.
 * Aggregates per-purl reachable-flow counts and sorts them descending.
 *
 * @param {Object} sliceArtefacts Slice artefact paths, must include `reachablesSlicesFile`
 * @returns {void}
 */
export function printReachables(sliceArtefacts: Object): void;
/**
 * Prints a formatted table of CycloneDX vulnerability objects.
 *
 * @param {Object[]} vulnerabilities Array of CycloneDX vulnerability objects
 * @returns {void}
 */
export function printVulnerabilities(vulnerabilities: Object[]): void;
/**
 * Prints an OWASP donation banner when running in a CI environment.
 * The banner is suppressed when `options.noBanner` is set or the repository
 * belongs to the cdxgen project itself.
 *
 * @param {Object} options CLI options
 * @returns {void}
 */
export function printSponsorBanner(options: Object): void;
/**
 * Prints a BOM summary table including generator tool names, component package types,
 * and component namespaces extracted from BOM metadata properties.
 *
 * @param {Object} bomJson CycloneDX BOM JSON object
 * @returns {void}
 */
export function printSummary(bomJson: Object): void;
/**
 * @typedef {{type: string, variable: string, severity: string, message: string, mitigation: string}} EnvAuditFinding
 */
/**
 * Runs the pre-generation environment audit and renders the results as formatted
 * tables to the console. Called when the --env-audit CLI flag is set.
 *
 * @param {string} filePath Project path being scanned
 * @param {Object} config Loaded .cdxgenrc / config-file values
 * @param {Object} options Effective CLI options
 * @param {EnvAuditFinding[]} envAuditFindings Audit findings to display
 */
export function displaySelfThreatModel(filePath: string, config: Object, options: Object, envAuditFindings: EnvAuditFinding[]): void;
export type EnvAuditFinding = {
    type: string;
    variable: string;
    severity: string;
    message: string;
    mitigation: string;
};
//# sourceMappingURL=display.d.ts.map