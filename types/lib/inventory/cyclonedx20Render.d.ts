/**
 * Render the 1.x-shaped internal model as a CycloneDX 2.0 document: the
 * document sections, reference integrity and the render report. The public
 * entry points are re-exported from cyclonedx20.js.
 */
/**
 * Render the 1.x-shaped internal model as a CycloneDX 2.0 document and report
 * what could not be carried. Pure: the input is never mutated and the output
 * shares no objects with it. Deterministic: the same input renders to the
 * same JSON.
 *
 * @param {object} internalBom BOM in the 1.x shape
 * @param {{hardwareMapper?: Function, hardwareOptions?: {includeSensitiveIdentifiers?: boolean, identifierPolicy?: string}}} [context]
 *   What the render may use besides the model: `hardwareMapper` is the
 *   optional toCdx20HardwareComponent of @cdxgen/cdx-hbom and
 *   `hardwareOptions` its identifier options (see hbomLoader.js:
 *   hardwareRenderContext and cyclonedx20RenderHardware.js). The output
 *   depends only on the model and this context.
 * @returns {{bomJson: object, report: {drops: Object<string, number>, rewrites: Object<string, number>, customSchemes: string[], droppedMethods: Array<{reason: string, technique: string}>}}}
 *   The 2.0 document, the counts of values the render could not carry
 *   (`drops`) and of values it rewrote without losing data (`rewrites`), by
 *   label
 */
export declare function renderCycloneDx20WithReport(internalBom: object, context?: {
    hardwareMapper?: Function;
    hardwareOptions?: {
        includeSensitiveIdentifiers?: boolean;
        identifierPolicy?: string;
    };
}): {
    bomJson: object;
    report: {
        drops: Record<string, number>;
        rewrites: Record<string, number>;
        customSchemes: string[];
        droppedMethods: Array<{
            reason: string;
            technique: string;
        }>;
    };
};
/**
 * Render the 1.x-shaped internal model as a CycloneDX 2.0 document. Pure: the
 * input is never mutated and the output shares no objects with it. What the
 * render could not carry is logged through thoughtLog; use
 * renderCycloneDx20WithReport for the counts.
 *
 * @param {object} internalBom BOM in the 1.x shape
 * @param {object} [context] See renderCycloneDx20WithReport
 * @returns {object} BOM in the 2.0 shape
 */
export declare function renderCycloneDx20(internalBom: object, context?: object): object;
//# sourceMappingURL=cyclonedx20Render.d.ts.map