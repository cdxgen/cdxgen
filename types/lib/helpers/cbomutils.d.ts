/**
 * Method to collect crypto and ssl libraries from the OS.
 *
 * @param {Object} options
 * @returns osPkgsList Array of OS crypto packages
 */
export function collectOSCryptoLibs(options: Object): any[];
export function collectSourceCryptoComponents(src: any, options?: {}): Promise<any[]>;
/**
 * Find crypto algorithm in the given code snippet
 *
 * @param {string} code Code snippet
 * @returns {Array} Arary of crypto algorithm objects with oid and description
 */
export function findCryptoAlgos(code: string): any[];
//# sourceMappingURL=cbomutils.d.ts.map