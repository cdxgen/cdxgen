import { MAX_BROTLI_PROBE_BYTES, MAX_BROTLI_PROBES, readBrotliDecoder } from "../core/brotliProbe.js";
export { MAX_BROTLI_PROBE_BYTES, MAX_BROTLI_PROBES, readBrotliDecoder };
/**
 * The properties a file component carries once it has been probed: the fix
 * state of each decoder found in it, or why it could not be read.
 *
 * @param {Object} decoder result of readBrotliDecoder
 * @returns {{name: string, value: string}[]} properties to append
 */
export declare function brotliDecoderProperties(decoder: Object): {
    name: string;
    value: string;
}[];
/**
 * The library component every embedded decoder links to. It has no version:
 * no build records one, and only the per-file cdx:brotli:*:blockSwitchFix
 * properties say whether a copy is vulnerable. The `vcs_url` qualifier names
 * the project and keeps the identity apart from an unpackaged `brotli`
 * executable, which is `pkg:generic/brotli`. The purl has no namespace: a
 * `pkg:github` purl is typed as an application and `pkg:generic/google` as a
 * framework when the BOM is assembled, and this is neither.
 *
 * @returns {Object} component with `purl` and `bom-ref`
 */
export declare function createBrotliComponent(): Object;
/**
 * Start collecting the decoder copies of one scan.
 *
 * @returns {{component: Object|undefined, dependencies: Object[], copies: number, unpatched: number, unknown: number}}
 */
export declare function createBrotliInventory(): {
    component: Object | undefined;
    dependencies: Object[];
    copies: number;
    unpatched: number;
    unknown: number;
};
/**
 * Tag a probed file component and, when it holds a decoder, link it to the
 * shared brotli component, creating that component on first use. Mutates the
 * file component in place.
 *
 * @param {Object} inventory accumulator from createBrotliInventory
 * @param {Object} fileComponent file component with a `properties` array
 * @param {Object} decoder result of readBrotliDecoder
 */
export declare function attachBrotliDecoder(inventory: Object, fileComponent: Object, decoder: Object): void;
/**
 * Finish an inventory: record the copy counts on the brotli component.
 *
 * @param {Object} inventory accumulator from createBrotliInventory
 * @returns {{components: Object[], dependencies: Object[]}} what to add to the BOM
 */
export declare function finishBrotliInventory(inventory: Object): {
    components: Object[];
    dependencies: Object[];
};
//# sourceMappingURL=brotliDecoder.d.ts.map