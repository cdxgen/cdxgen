/**
 * Parsed list of SPDX license identifiers loaded from `data/spdx-licenses.json`.
 *
 * @type {string[]}
 */
export declare const spdxLicenses: string[];
/**
 * Method to determine if a license is a valid SPDX license expression
 *
 * @param {string} license License string
 * @returns {boolean} true if the license is a valid SPDX license expression
 * @see https://spdx.dev/learn/handling-license-info/
 **/
export declare function isSpdxLicenseExpression(license: string): boolean;
/**
 * Convert the array of licenses to a CycloneDX 1.5 compliant license array.
 * This should return an array containing:
 * - one or more SPDX license if no expression is present
 * - the license of the expression if one expression is present
 * - a unified conditional 'OR' license expression if more than one expression is present
 *
 * @param {Array} licenses Array of licenses
 * @returns {Array} CycloneDX 1.5 compliant license array
 */
export declare function adjustLicenseInformation(licenses: any[]): any[];
/**
 * Performs a lookup + validation of the license specified in the
 * package. If the license is a valid SPDX license ID, set the 'id'
 * and url of the license object, otherwise, set the 'name' of the license
 * object.
 */
export declare function getLicenses(pkg: any): any[] | undefined;
/**
 * Method to retrieve known license by known-licenses.json
 *
 * @param {String} licenseUrl Repository url
 * @param {String} pkg Bom ref
 * @return {Object} Objetct with SPDX license id or license name
 */
export declare function getKnownLicense(licenseUrl: string, pkg: string): Object;
/**
 * Tries to find a file containing the license text based on commonly
 * used naming and content types. If a candidate file is found, add
 * the text to the license text object and stop.
 */
export declare function addLicenseText(pkg: any, l: any, licenseContent: any): void;
/**
 * Read the file from the given path to the license text object and includes
 * content-type attribute, if not default. Returns the license text object.
 */
export declare function readLicenseText(licenseFilepath: any, licenseContentType: any): {
    content: any;
} | null;
/**
 * Method to find the spdx license id from name
 *
 * @param {string} name License full name
 */
export declare function findLicenseId(name: string): any;
/**
 * Identify a license from the title and opening of its full text. A license
 * text quotes other licenses (the GNU GPL's text names the GNU Lesser GPL),
 * so the substring scan of `guessLicenseId` alone can name the wrong one.
 *
 * @param {string} content License file contents
 * @returns {string|undefined} SPDX license id or expression
 */
export declare function licenseIdFromText(content: string): string | undefined;
/**
 * Method to guess the spdx license id from license contents
 *
 * @param {string} content License file contents
 */
export declare function guessLicenseId(content: string): any;
//# sourceMappingURL=spdx.d.ts.map