/**
 * The places cdx-hbom is loaded from, in order: a local checkout next to
 * cdxgen, else the installed package.
 */
export declare const HBOM_MODULE_LOCATIONS: Readonly<{
    localModulePath: any;
    localMapperPath: any;
    packageMapperSpecifier: "@cdxgen/cdx-hbom/cdx20";
}>;
/**
 * Resolve the optional cdx-hbom module.
 *
 * @returns {Promise<object>} Loaded cdx-hbom module namespace.
 */
export declare function importHbomModule(): Promise<object>;
/**
 * Load the optional CycloneDX 2.0 hardware mapper,
 * `toCdx20HardwareComponent`, from the same cdx-hbom that importHbomModule
 * loads: the local checkout when it exists (its src/common/cdx20.js), else
 * the installed package's `./cdx20` export. A cdx-hbom without the mapper
 * (the published 0.7.0 has no `./cdx20` export) or one that fails to load
 * gives null, and the 2.0 render then keeps its generic conversion.
 *
 * @param {object} [locations] Where to look; defaults to
 *   HBOM_MODULE_LOCATIONS
 * @returns {Promise<Function|null>} The mapper, or null
 */
export declare function loadHardwareMapper(locations?: object): Promise<Function | null>;
/** The identifier policy cdx-hbom records when raw identifiers were kept. */
export declare const RAW_IDENTIFIER_POLICY = "raw-identifiers-enabled";
/**
 * The identifier policy the collector recorded for the run, on the HBOM
 * subject (`metadata.component`) or in `metadata.properties`.
 *
 * @param {object} internalBom The 1.x-shaped internal model
 * @returns {string|undefined} The `cdx:hbom:identifierPolicy` value
 */
export declare function recordedIdentifierPolicy(internalBom: object): string | undefined;
/**
 * The renderCycloneDx20 context for an internal model: the hardware mapper
 * and its identifier options when the model has a component with a
 * cdx:hbom:* property and a mapper is available, otherwise an empty context,
 * so a BOM without hardware never loads cdx-hbom. Hardware identifiers are
 * asserted only when the collector recorded `raw-identifiers-enabled` for the
 * run (it does when HBOM generation was asked to include sensitive
 * identifiers); a redacted run never yields identifiers, whichever command
 * renders it.
 *
 * @param {object} internalBom The 1.x-shaped internal model
 * @param {object} [locations] Passed to loadHardwareMapper
 * @returns {Promise<{hardwareMapper?: Function, hardwareOptions?: {includeSensitiveIdentifiers: boolean, identifierPolicy?: string}}>}
 *   The render context
 */
export declare function hardwareRenderContext(internalBom: object, locations?: object): Promise<{
    hardwareMapper?: Function;
    hardwareOptions?: {
        includeSensitiveIdentifiers: boolean;
        identifierPolicy?: string;
    };
}>;
//# sourceMappingURL=hbomLoader.d.ts.map