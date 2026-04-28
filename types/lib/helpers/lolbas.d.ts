/**
 * Resolve LOLBAS metadata for a binary or script name.
 *
 * @param {string} candidate Binary or script path/name
 * @returns {object|undefined} Matched LOLBAS metadata
 */
export function getLolbasMetadata(candidate: string): object | undefined;
/**
 * Resolve LOLBAS properties for an osquery row.
 *
 * @param {string} queryCategory Osquery query category
 * @param {object} row Osquery row
 * @returns {Array<object>} CycloneDX custom properties
 */
export function createLolbasProperties(queryCategory: string, row: object): Array<object>;
//# sourceMappingURL=lolbas.d.ts.map