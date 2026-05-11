export function getGtfoBinsMetadata(name: any, linkedName: any): {
    canonicalName: any;
    contexts: any;
    functions: any;
    matchSource: string;
    mitreTechniques: any;
    privilegedContexts: any;
    reference: string;
    riskTags: any[];
    source: any;
    sourceRef: any;
} | undefined;
export function createGtfoBinsProperties(name: any, linkedName: any): {
    name: string;
    value: any;
}[];
/**
 * Resolve GTFOBins properties for a live Linux osquery row.
 *
 * @param {string} queryCategory Osquery query category
 * @param {object} row Osquery row
 * @returns {Array<object>} CycloneDX custom properties
 */
export function createGtfoBinsPropertiesFromRow(queryCategory: string, row: object): Array<object>;
//# sourceMappingURL=gtfobins.d.ts.map