export declare function isKosiKotlinLanguage(language: any): boolean;
/**
 * True when kosi is disabled by CDXGEN_KOSI_DISABLE (1/all/true) or --no-kosi.
 * The check happens before any binary resolution so a disabled run never
 * even looks for the plugin.
 */
export declare function kosiDisabled(): any;
/**
 * Orchestrates the kosi runs over src and returns the parsed reports: one
 * `all` pass (every slice kind, dependency tier) and one `reachable` pass
 * (call-graph reachability from the roots). The analysis is read-only and
 * offline: kosi never executes the project's build. A classpath.txt beside
 * the sources (the documented build-tool report) is passed through when
 * present.
 *
 * @param {string} src Directory to analyze.
 * @param {Object} options Configuration options.
 * @returns {Object|undefined} { report, reachableReport } or undefined.
 */
export declare function analyzeKosiProject(src: string, options?: Object): Object | undefined;
/**
 * Merges the reachable pass's evidence into the all pass's maps, mutating
 * the first argument.
 */
export declare function mergeKosiEvidence(all: any, reachable: any): any;
/**
 * Services evidence: kosi's outbound services[] rows are already
 * CycloneDX-shaped.
 */
export declare function collectKosiServices(kosiReport?: {}, servicesMap?: {}): {};
export declare function collectKosiEvidence(kosiReport?: {}, components?: any[]): {
    componentPropertiesMap: {};
    cryptoComponents: any[];
    cryptoGeneratePurls: {};
    dataFlowFrames: {};
    metadataProperties: any[];
    purlLocationMap: {};
};
//# sourceMappingURL=kosi.d.ts.map