/**
 * YAML parsing without warnings on stderr.
 *
 * The `yaml` package throws parse errors, but prints warnings itself through
 * `process.emitWarning()`, for example for an unresolved `!tag` or a key with
 * a collection value. Each warning quotes the source line it points at, and
 * sometimes the line before it. Most YAML that cdxgen reads comes from the
 * scanned tree, so every parse goes through these wrappers, which set
 * `logLevel: "error"`: errors still throw, warnings are dropped. Documents
 * returned by `parseAllDocuments()` keep the level, so `toJS()` stays quiet
 * too. Import from here, not from `yaml`.
 *
 * Aliases are bounded here as well. An alias and its anchor become the same
 * JavaScript object, so a parsed document is a graph and can be tiny on disk
 * yet huge as a tree: a list of ten aliases to a list of ten aliases, and so
 * on, grows tenfold with every line. cdxgen joins, stringifies, copies and
 * walks parsed values once per reference and therefore pays for the tree. The
 * `maxAliasCount` guard of the yaml package stops most such documents, but it
 * counts an empty collection, and a collection that only refers to itself, as
 * zero, so a graph built on `[]` or `{}` passes it at any depth. Aliases
 * stay allowed, as CI, compose and Kubernetes files use them, and the parsed
 * value is measured instead.
 */

import {
  parse as yamlParse,
  parseAllDocuments as yamlParseAllDocuments,
} from "yaml";

function quietOptions(options) {
  return { ...options, logLevel: "error" };
}

// A document without aliases measures about one unit per character, so the
// factor only bounds what aliases add. The floor leaves room for the anchors
// of a small file.
const MAX_EXPANDED_SIZE = 1_000_000;
const MAX_EXPANSION_FACTOR = 4;

/**
 * Measure a parsed value the way `join` or `JSON.stringify` visit it, once per
 * reference: one unit per node plus the length of every string and key. Each
 * shared object is measured only once, so the cost is linear in the size of
 * the document whatever the size of the tree it describes.
 *
 * @param {unknown} value value produced by yaml's parse
 * @param {Map<Object, number>} sizes sizes of the objects measured so far
 * @returns {number} size of the value as a tree, `Infinity` if it is cyclic
 */
function expandedSize(value, sizes) {
  if (typeof value === "string") {
    return 1 + value.length;
  }
  if (!value || typeof value !== "object") {
    return 1;
  }
  if (ArrayBuffer.isView(value)) {
    // !!binary
    return 1 + value.byteLength;
  }
  let size = sizes.get(value);
  if (size === undefined) {
    // Only an alias to an enclosing node gets here before the size is known
    sizes.set(value, Number.POSITIVE_INFINITY);
    size = 1;
    if (Array.isArray(value) || value instanceof Set) {
      for (const entry of value) {
        size += expandedSize(entry, sizes);
      }
    } else {
      const entries = value instanceof Map ? value : Object.entries(value);
      for (const [key, entry] of entries) {
        size += expandedSize(key, sizes) + expandedSize(entry, sizes);
      }
    }
    sizes.set(value, size);
  }
  return size;
}

function assertBoundedExpansion(value, textLength) {
  if (
    expandedSize(value, new Map()) >
    Math.max(MAX_EXPANDED_SIZE, MAX_EXPANSION_FACTOR * textLength)
  ) {
    throw new ReferenceError(
      "Excessive alias expansion indicates a resource exhaustion attack",
    );
  }
  return value;
}

/**
 * Parse a single YAML document.
 *
 * @param {string} text YAML source
 * @param {Object} [options] yaml options; `logLevel` is always `error`
 * @returns {any} The parsed value
 * @throws {ReferenceError} When the aliases are cyclic or expand to a tree out
 *   of proportion to the text
 */
export function parse(text, options) {
  return assertBoundedExpansion(
    yamlParse(text, quietOptions(options)),
    text?.length || 0,
  );
}

/**
 * Parse a stream of YAML documents.
 *
 * @param {string} text YAML source
 * @param {Object} [options] yaml options; `logLevel` is always `error`
 * @returns {Array<Object>} The parsed documents. Their `toJS()` throws a
 *   ReferenceError like parse() does for aliases that expand too far
 */
export function parseAllDocuments(text, options) {
  const documents = yamlParseAllDocuments(text, quietOptions(options));
  for (const document of Array.isArray(documents) ? documents : []) {
    const toJS = document.toJS.bind(document);
    document.toJS = (toJSOptions) =>
      assertBoundedExpansion(toJS(toJSOptions), text?.length || 0);
  }
  return documents;
}
