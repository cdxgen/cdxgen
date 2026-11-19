/**
 * Canonical serialisation behind the linear-time `uniqueItems` keyword.
 *
 * Shared by the validators `bomValidator.js` compiles at runtime, the
 * pre-compiled ones (through `generated/runtime.mjs`) and
 * `contrib/gen-validators.mjs`, so that the three cannot drift apart.
 */

// Serialisations up to this length are compared as text. A longer one is
// swapped for a short key while a document is being validated.
const MAX_INLINE_LENGTH = 256;

// Keys of the document being validated. Unset outside withCanonicalKeys().
let canonicalKeys;

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
export function canonicalize(value) {
  if (value === null || typeof value !== "object") {
    return typeof value === "string"
      ? `s${value.length}:${value}`
      : `${typeof value}:${value}`;
  }
  let canonical = canonicalKeys?.byValue.get(value);
  if (canonical !== undefined) {
    return canonical;
  }
  if (Array.isArray(value)) {
    canonical = `[${value.map(canonicalize).join(",")}]`;
  } else {
    const keys = Object.keys(value).sort();
    canonical = `{${keys.map((key) => `s${key.length}:${key}=${canonicalize(value[key])}`).join(",")}}`;
  }
  if (canonicalKeys && canonical.length > MAX_INLINE_LENGTH) {
    const text = canonical;
    canonical = canonicalKeys.byText.get(text);
    if (canonical === undefined) {
      canonical = `#${canonicalKeys.byText.size}`;
      canonicalKeys.byText.set(text, canonical);
    }
    canonicalKeys.byValue.set(value, canonical);
  }
  return canonical;
}

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
export function withCanonicalKeys(validation) {
  const outerKeys = canonicalKeys;
  canonicalKeys = { byText: new Map(), byValue: new WeakMap() };
  try {
    return validation();
  } finally {
    canonicalKeys = outerKeys;
  }
}
