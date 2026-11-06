/**
 * Determine whether the supplied project types include HBOM.
 *
 * @param {string|string[]|undefined|null} projectTypes Project types.
 * @returns {boolean} True when HBOM is requested.
 */
export declare function hasHbomProjectType(projectTypes: string | string[] | undefined | null): boolean;
/**
 * Determine whether the supplied project types are exclusively HBOM-oriented.
 *
 * @param {string|string[]|undefined|null} projectTypes Project types.
 * @returns {boolean} True when at least one project type is supplied and all are HBOM-oriented.
 */
export declare function isHbomOnlyProjectTypes(projectTypes: string | string[] | undefined | null): boolean;
/**
 * Reject mixed HBOM and non-HBOM project types.
 *
 * @param {string|string[]|undefined|null} projectTypes Project types.
 */
export declare function ensureNoMixedHbomProjectTypes(projectTypes: string | string[] | undefined | null): void;
/**
 * Ensure HBOM generation uses the supported CycloneDX version.
 *
 * @param {number|string|undefined|null} specVersion Requested spec version.
 */
export declare function ensureSupportedHbomSpecVersion(specVersion: number | string | undefined | null): void;
/**
 * Ensure merged HBOM + runtime collection has access to osquery.
 *
 * @param {object} [options={}] CLI options.
 * @param {string} [commandName="hbom"] Invoked command name for tailored guidance.
 */
export declare function ensureHbomRuntimeSupport(options?: object, commandName?: string): void;
/**
 * Translate cdxgen CLI options to cdx-hbom collector options.
 *
 * @param {object} [options={}] CLI options.
 * @returns {object} cdx-hbom collector options.
 */
export declare function normalizeHbomOptions(options?: object): object;
/**
 * Recompute and attach `cdx:hbom:analysis:*` summary properties to an HBOM.
 *
 * Existing analysis properties are dropped and rebuilt from the BOM's
 * `cdx:hbom:evidence:commandDiagnostic` payload.
 *
 * @param {Object} bomJson CycloneDX HBOM document
 * @returns {Object} The same BOM with refreshed analysis properties
 */
export declare function addHbomAnalysisProperties(bomJson: Object): Object;
/**
 * The 1.x-shaped model of a collector result. cdxgen asks the collector for
 * 1.7; a collector that still answers with a CycloneDX 2.0 document (a
 * `specFormat`, or specVersion 2.0) is read with readCycloneDx20, so the
 * 1.x pipeline that follows never mistakes it for a 1.x BOM and loses its
 * inventories.
 *
 * @param {object} collected What collectHardware returned
 * @returns {object} The 1.x-shaped HBOM
 */
export declare function toInternalHbom(collected: object): object;
/**
 * Generate an HBOM using the optional cdx-hbom package.
 *
 * @param {object} [options={}] CLI options.
 * @returns {Promise<object>} CycloneDX HBOM document.
 */
export declare function createHbomDocument(options?: object): Promise<object>;
//# sourceMappingURL=hbom.d.ts.map