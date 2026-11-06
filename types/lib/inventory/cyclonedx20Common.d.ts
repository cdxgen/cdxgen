/**
 * Small shared helpers for the CycloneDX 2.0 renderer and reader: type
 * guards, cloning, render counters and the environment-variable shape change.
 */
/** True for a plain object (not null, not an array). */
export declare const isObjectRecord: (value: any) => boolean;
/** True for a string with at least one character. */
export declare const isNonEmptyString: (value: any) => boolean;
/** structuredClone that passes `undefined` through. */
export declare const clone: (value: any) => any;
export declare const isBomLink: (value: any) => boolean;
/**
 * A fresh, empty set of render counters.
 *
 * @param {object} [shadows] 2.0 originals kept by readCycloneDx20 (see
 *   takeShadow)
 * @param {{toolRefId?: string, timestamp?: string}} [claims] What identity
 *   claims are attributed with (see identityClaimContext)
 * @returns {object} Render counters
 */
export declare function createRenderStats(shadows?: object, claims?: {
    toolRefId?: string;
    timestamp?: string;
}): object;
/**
 * The key a 1.x value is shadowed under: the SHA-256 of its JSON. The
 * reader and the renderer serialize the same object the same way, so an
 * unchanged value finds its 2.0 original again.
 *
 * @param {*} value 1.x value
 * @returns {string} Hex digest
 */
export declare function shadowKey(value: any): string;
/**
 * The 2.0 original readCycloneDx20 kept for this unchanged 1.x value, as a
 * fresh clone, or undefined. Identical 1.x values kept for several originals
 * get them back in document order. Never mutates the stored shadows.
 *
 * @param {object} stats Render counters from createRenderStats
 * @param {string} kind Shadow namespace (component, metadata, …)
 * @param {*} value 1.x value about to be rendered
 * @returns {*} The 2.0 original or undefined
 */
export declare function takeShadow(stats: object, kind: string, value: any): any;
/**
 * The single 2.0 original readCycloneDx20 kept for this unchanged 1.x value,
 * as a fresh clone, or undefined. Unlike takeShadow nothing is consumed: the
 * reader registers a key here only when every entry it read under that key
 * had the same original, so the lookup does not depend on render order.
 *
 * @param {object} stats Render counters from createRenderStats
 * @param {string} kind Shadow namespace (identity)
 * @param {*} value 1.x value about to be rendered
 * @returns {*} The 2.0 original or undefined
 */
export declare function peekShadow(stats: object, kind: string, value: any): any;
/** Count one dropped or rewritten value under a stable label. */
export declare function countDrop(stats: any, label: any, count?: number): void;
/**
 * Count one value the render rewrote without losing data (a duplicate refId
 * turned into a reference, a retargeted annotation subject).
 */
export declare function countRewrite(stats: any, label: any, count?: number): void;
/** Count every defined key of `source` that `handled` does not list. */
export declare function countUnmapped(stats: any, prefix: any, source: any, handled: any): void;
/** Clone the listed fields of `source` that are defined onto `target`. */
export declare function copyDefined(target: any, source: any, fields: any): void;
/** Remove duplicate entries (by JSON value) for `uniqueItems` arrays. */
export declare function uniqueByValue(values: any): any[];
/** Split a 1.x `author` string the way specVersionCompat does. */
export declare function authorStringToNames(authorValue: any): string[];
/** A 1.x scalar-or-array identifier field as a list of strings. */
export declare function identifierValues(value: any): any[];
/** Assign `value` to `out[key]` unless it is undefined. */
export declare function setDefined(out: any, key: any, value: any): void;
/**
 * Convert a 1.x `environmentVars` array of {name, value} entries into the 2.0
 * map of names to values
 * (#/$defs/cyclonedx-formulation-2.0/$defs/environmentVars). Reverse for read.
 */
export declare function convertEnvironmentVars(value: any): any;
/** Turn a 2.0 environmentVars map back into the 1.x {name, value} array. */
export declare function reverseEnvironmentVars(value: any): any;
/** Every refId string declared anywhere under the given roots. */
export declare function collectDeclaredRefIds(roots: any): Set<any>;
/**
 * True when any `party` member (a refId string or a partyReference) or any
 * `ref` member below `node` names `refId`. Restored 2.0 originals reference
 * a derived party (see derivedPartyDeclarations) without passing through the
 * converters, so its declaration follows the rendered document rather than a
 * render flag.
 */
export declare function referencesParty(node: any, refId: any): any;
//# sourceMappingURL=cyclonedx20Common.d.ts.map