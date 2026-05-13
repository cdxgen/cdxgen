/**
 * Determine whether the supplied project types include HBOM.
 *
 * @param {string|string[]|undefined|null} projectTypes Project types.
 * @returns {boolean} True when HBOM is requested.
 */
export function hasHbomProjectType(projectTypes: string | string[] | undefined | null): boolean;
/**
 * Determine whether the supplied project types are exclusively HBOM-oriented.
 *
 * @param {string|string[]|undefined|null} projectTypes Project types.
 * @returns {boolean} True when at least one project type is supplied and all are HBOM-oriented.
 */
export function isHbomOnlyProjectTypes(projectTypes: string | string[] | undefined | null): boolean;
/**
 * Reject mixed HBOM and non-HBOM project types.
 *
 * @param {string|string[]|undefined|null} projectTypes Project types.
 */
export function ensureNoMixedHbomProjectTypes(projectTypes: string | string[] | undefined | null): void;
/**
 * Ensure HBOM generation uses the supported CycloneDX version.
 *
 * @param {number|string|undefined|null} specVersion Requested spec version.
 */
export function ensureSupportedHbomSpecVersion(specVersion: number | string | undefined | null): void;
/**
 * Translate cdxgen CLI options to cdx-hbom collector options.
 *
 * @param {object} [options={}] CLI options.
 * @returns {object} cdx-hbom collector options.
 */
export function normalizeHbomOptions(options?: object): object;
export function addHbomAnalysisProperties(bomJson: any): any;
/**
 * Generate an HBOM using the optional cdx-hbom package.
 *
 * @param {object} [options={}] CLI options.
 * @returns {Promise<object>} CycloneDX HBOM document.
 */
export function createHbomDocument(options?: object): Promise<object>;
//# sourceMappingURL=hbom.d.ts.map