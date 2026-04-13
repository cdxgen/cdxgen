export function printTable(bomJson: any, filterTypes?: undefined, highlight?: undefined): void;
export function printOSTable(bomJson: any): void;
export function printServices(bomJson: any): void;
export function printFormulation(bomJson: any): void;
export function printOccurrences(bomJson: any): void;
export function printCallStack(bomJson: any): void;
export function printDependencyTree(bomJson: any, mode?: string, highlight?: undefined): void;
export function printReachables(sliceArtefacts: any): void;
export function printVulnerabilities(vulnerabilities: any): void;
export function printSponsorBanner(options: any): void;
export function printSummary(bomJson: any): void;
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