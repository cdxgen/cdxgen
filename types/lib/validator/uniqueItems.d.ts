/**
 * Canonical serialisation behind the linear-time `uniqueItems` keyword.
 *
 * Shared by the validators `bomValidator.js` compiles at runtime, the
 * pre-compiled ones (through `generated/runtime.mjs`) and
 * `contrib/gen-validators.mjs`, so that the three cannot drift apart.
 */
/**
 * Serialise a value so that two values are deep-equal exactly when their
 * serialisations match: object keys are emitted in sorted order and every
 * string is length-prefixed so that no two distinct values can collide.
 *
 * Arrays with `uniqueItems` nest (`components` within `components`), so a
 * value is serialised again for every such array around it, and a parent's
 * text holds a copy of each child's. Inside withCanonicalKeys() an object or
 * array with a long serialisation is therefore serialised once and stands in
 * its parents as `#<n>`, a key that only deep-equal values share and that no
 * other serialisation starts with.
 *
 * @param {*} value Value from a parsed BOM document
 * @returns {string} Canonical form of the value
 */
export declare function canonicalize(value: any): string;
/**
 * Run the schema validation of one document with the keys canonicalize()
 * needs to stay linear in the size of the document, however deep its arrays
 * nest.
 *
 * The keys describe the document as it is during the call and are dropped
 * when it returns, because callers go on changing a BOM between validations.
 * Without this wrapper canonicalize() keeps no state and serialises every
 * value in full.
 *
 * @template T
 * @param {() => T} validation Synchronous validation of a single document
 * @returns {T} Whatever the validation returned
 */
export declare function withCanonicalKeys<T>(validation: () => T): T;
//# sourceMappingURL=uniqueItems.d.ts.map