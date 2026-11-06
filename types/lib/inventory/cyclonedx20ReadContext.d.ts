/**
 * Shared state and the field-mapping engine of the CycloneDX 2.0 reader.
 *
 * Every 2.0 object kind the reader converts has a frozen field spec: the
 * allowlist of the members the 1.x model carries, with the 1.x name or the
 * converter for each. `reverseFields` walks the object's own members in
 * document order and reports every member the spec does not list as a loss,
 * so a field the reader has no mapping for can never vanish silently.
 *
 * Loss pointers are RFC 6901 JSON pointers into the 2.0 input, with array
 * indexes and `~`/`/` escaped.
 */
/**
 * Mark `bom` as cdxgen's 1.x-shaped internal model. The mark is a
 * non-enumerable symbol property, so it never reaches JSON output, and a
 * copy made with JSON or structuredClone does not carry it.
 *
 * @param {object} bom The internal model
 * @returns {object} The same object
 */
export declare function markInternalModel(bom: object): object;
/**
 * Whether `bom` carries the internal model mark of markInternalModel.
 *
 * @param {object} bom Any value
 * @returns {boolean} True for a marked internal model
 */
export declare function isMarkedInternalModel(bom: object): boolean;
export declare const MAX_READ_DEPTH = 256;
/**
 * Copy a parsed JSON value, leaving out every object nested deeper than
 * `maxDepth` objects and recording its JSON pointer. Arrays do not count
 * towards the depth, so every object entry of one array sits at the same
 * depth and is cut with the rest; an array left empty by the cut is left out
 * of its parent object too. Iterative, so no input depth can exhaust the
 * call stack.
 *
 * @param {*} value Parsed JSON value
 * @param {number} [maxDepth] Deepest object level kept
 * @returns {{value: *, truncated: string[]}} The copy and the pointers of the
 *   objects that were cut
 */
export declare function cloneWithDepthLimit(value: any, maxDepth?: number): {
    value: any;
    truncated: string[];
};
/**
 * A fresh reader context for one 2.0 document.
 *
 * @param {object} doc The (private, cloned) 2.0 document
 * @returns {object} Reader context
 */
export declare function createReadContext(doc: object): object;
/**
 * Append reference tokens to a JSON pointer (RFC 6901): `~` becomes `~0` and
 * `/` becomes `~1`; array indexes are plain numbers.
 *
 * @param {string} base Pointer so far ("" is the whole document)
 * @param {...(string|number)} tokens Member names or array indexes
 * @returns {string} The extended pointer
 */
export declare function jsonPointer(base: string, ...tokens: (string | number)[]): string;
/** Record one loss. */
export declare function addLoss(ctx: any, pointer: any, reason: any): void;
/**
 * Report every defined member of `source` that `carried` does not list.
 *
 * @param {object} ctx Reader context
 * @param {string} kind 2.0 object kind, used in the reason
 * @param {object} source 2.0 object
 * @param {string} pointer JSON pointer of `source`
 * @param {Set<string>|object} carried Member names (a Set or spec keys)
 */
export declare function reportUnmapped(ctx: object, kind: string, source: object, pointer: string, carried: Set<string> | object): void;
/**
 * Convert one 2.0 object with a field spec. A spec maps each carried 2.0
 * member to `true` (copied under the same name), a string (copied under that
 * 1.x name) or `{to?, spread?, convert}` where
 * `convert(ctx, value, pointer, source)` returns the 1.x value or undefined
 * (and reports its own losses); a `spread` rule returns an object of 1.x
 * members to merge (one 2.0 member feeding several 1.x fields). Members
 * the spec does not list are reported through reportUnmapped.
 *
 * @param {object} ctx Reader context
 * @param {string} kind 2.0 object kind
 * @param {object} source 2.0 object
 * @param {string} pointer JSON pointer of `source`
 * @param {object} spec Frozen field spec
 * @returns {object} The 1.x object
 */
export declare function reverseFields(ctx: object, kind: string, source: object, pointer: string, spec: object): object;
/**
 * Convert each entry of a 2.0 array with `convertEntry(ctx, entry, pointer)`,
 * dropping entries that convert to undefined. A non-array is a loss.
 */
export declare function reverseList(ctx: any, value: any, pointer: any, convertEntry: any): any[] | undefined;
/** A spec rule converting an array entry by entry. */
export declare function listOf(convertEntry: any, to: any): Readonly<{
    to: any;
    convert: (ctx: any, value: any, pointer: any) => any[] | undefined;
}>;
/** A spec rule converting a nested object with its own spec. */
export declare function objectOf(kind: any, spec: any, to: any): Readonly<{
    to: any;
    convert: (ctx: any, value: any, pointer: any) => object | undefined;
}>;
/** reverseFields for a value that must be an object; a loss otherwise. */
export declare function reverseObject(ctx: any, kind: any, value: any, pointer: any, spec: any): object | undefined;
/** Keep `original` for the 1.x value `internal` in namespace `kind`. */
export declare function registerShadow(ctx: any, kind: any, internal: any, original: any): void;
/** Keep `original` under a precomputed shadow key. */
export declare function registerShadowKey(ctx: any, kind: any, key: any, original: any): void;
/**
 * Run `read()` with component shadows suspended: for section entries that
 * are restored whole, whose nested components the renderer never converts.
 */
export declare function withoutComponentShadows(ctx: any, read: any): any;
//# sourceMappingURL=cyclonedx20ReadContext.d.ts.map