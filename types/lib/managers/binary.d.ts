export function getCargoAuditableInfo(src: any): any;
/**
 * Execute sourcekitten plugin with the given arguments
 *
 * @param args {Array} Arguments
 * @returns {undefined|Object} Command output
 */
export function executeSourcekitten(args: any[]): undefined | any;
/**
 * Get the packages installed in the container image filesystem.
 *
 * @param src {String} Source directory containing the extracted filesystem.
 * @param imageConfig {Object} Image configuration containing environment variables, command, entrypoints etc
 *
 * @returns {Object} Metadata containing packages, dependencies, etc
 */
export function getOSPackages(src: string, imageConfig: any): any;
export function executeOsQuery(query: any): any;
/**
 * Method to execute dosai to create slices for dotnet
 *
 * @param {string} src Source Path
 * @param {string} slicesFile Slices file name
 * @returns boolean
 */
export function getDotnetSlices(src: string, slicesFile: string): boolean;
/**
 * Method to generate binary SBOM using blint
 *
 * @param {string} src Path to binary or its directory
 * @param {string} binaryBomFile Path to binary
 * @param {boolean} deepMode Deep mode flag
 *
 * @return {boolean} Result of the generation
 */
export function getBinaryBom(src: string, binaryBomFile: string, deepMode: boolean): boolean;
//# sourceMappingURL=binary.d.ts.map