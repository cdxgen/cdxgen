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
 */

import {
  parse as yamlParse,
  parseAllDocuments as yamlParseAllDocuments,
} from "yaml";

function quietOptions(options) {
  return { ...options, logLevel: "error" };
}

/**
 * Parse a single YAML document.
 *
 * @param {string} text YAML source
 * @param {Object} [options] yaml options; `logLevel` is always `error`
 * @returns {any} The parsed value
 */
export function parse(text, options) {
  return yamlParse(text, quietOptions(options));
}

/**
 * Parse a stream of YAML documents.
 *
 * @param {string} text YAML source
 * @param {Object} [options] yaml options; `logLevel` is always `error`
 * @returns {Array<Object>} The parsed documents
 */
export function parseAllDocuments(text, options) {
  return yamlParseAllDocuments(text, quietOptions(options));
}
