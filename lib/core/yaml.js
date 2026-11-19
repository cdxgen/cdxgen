/**
 * YAML parsing without warnings on stderr, and without the constructs that
 * take super-linear time.
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
 * Two features of the package cost far more than linear time on a document of
 * a few kilobytes, so the wrappers restrict them. A collection used as a
 * mapping key is an error (`stringKeys`), because the key is rendered to text
 * once per nesting level. A document with more than `MAX_ALIAS_NODES` alias
 * nodes is an error, because the package recomputes the alias budget over the
 * anchored node for every alias, and that count stays zero for an anchored
 * empty collection, so its own `maxAliasCount` limit never applies.
 */

import {
  isAlias,
  visit,
  parseAllDocuments as yamlParseAllDocuments,
  parseDocument as yamlParseDocument,
} from "yaml";

/**
 * Largest number of alias nodes (`*name`) a document may hold. CI files that
 * merge shared job settings use a few dozen.
 *
 * @type {number}
 */
export const MAX_ALIAS_NODES = 200;

function quietOptions(options) {
  return { stringKeys: true, ...options, logLevel: "error" };
}

/**
 * Count the alias nodes of a document and stop at the limit.
 *
 * @param {import("yaml").Document} doc Parsed document
 * @returns {boolean} true when the document holds more than MAX_ALIAS_NODES aliases
 */
function hasTooManyAliases(doc) {
  let aliases = 0;
  visit(doc, (_key, node) => {
    if (isAlias(node) && ++aliases > MAX_ALIAS_NODES) {
      return visit.BREAK;
    }
    return undefined;
  });
  return aliases > MAX_ALIAS_NODES;
}

/**
 * Parse a single YAML document.
 *
 * @param {string} text YAML source
 * @param {Object} [options] yaml options; `logLevel` is always `error`
 * @returns {any} The parsed value
 * @throws {Error} On a syntax error, a collection used as a mapping key, or
 *   a document with more than MAX_ALIAS_NODES aliases
 */
export function parse(text, options) {
  const opts = quietOptions(options);
  const doc = yamlParseDocument(text, opts);
  if (doc.errors.length) {
    throw doc.errors[0];
  }
  if (hasTooManyAliases(doc)) {
    throw new Error(`YAML document has more than ${MAX_ALIAS_NODES} aliases`);
  }
  return doc.toJS(opts);
}

/**
 * Parse a stream of YAML documents.
 *
 * A document that uses a collection as a mapping key, or holds more than
 * MAX_ALIAS_NODES aliases, keeps an error and has no contents, so `toJS()` on
 * it is cheap.
 *
 * @param {string} text YAML source
 * @param {Object} [options] yaml options; `logLevel` is always `error`
 * @returns {Array<Object>} The parsed documents
 */
export function parseAllDocuments(text, options) {
  const documents = yamlParseAllDocuments(text, quietOptions(options));
  if (!Array.isArray(documents)) {
    return documents;
  }
  for (const doc of documents) {
    if (hasTooManyAliases(doc)) {
      doc.errors.push(
        new Error(`YAML document has more than ${MAX_ALIAS_NODES} aliases`),
      );
      doc.contents = null;
    } else if (doc.errors.some((error) => error.code === "NON_STRING_KEY")) {
      doc.contents = null;
    }
  }
  return documents;
}
