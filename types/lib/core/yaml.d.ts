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
 *
 * Two features of the package cost far more than linear time on a document of
 * a few kilobytes, so the wrappers restrict them. A collection used as a
 * mapping key is an error (`stringKeys`), because the key is rendered to text
 * once per nesting level. A document with more than `MAX_ALIAS_NODES` alias
 * nodes is an error, because the package recomputes the alias budget over the
 * anchored node for every alias, and that count stays zero for an anchored
 * empty collection, so its own `maxAliasCount` limit never applies.
 */
/**
 * Largest number of alias nodes (`*name`) a document may hold. CI files that
 * merge shared job settings use a few dozen.
 *
 * @type {number}
 */
export declare const MAX_ALIAS_NODES: number;
/**
 * Parse a single YAML document.
 *
 * @param {string} text YAML source
 * @param {Object} [options] yaml options; `logLevel` is always `error`
 * @returns {any} The parsed value
 * @throws {Error} On a syntax error, a collection used as a mapping key, a
 *   document with more than MAX_ALIAS_NODES aliases, or aliases that are cyclic
 *   or expand to a tree out of proportion to the text
 */
export declare function parse(text: string, options?: Object): any;
/**
 * Parse a stream of YAML documents.
 *
 * A document that uses a collection as a mapping key, or holds more than
 * MAX_ALIAS_NODES aliases, keeps an error and has no contents, so `toJS()` on
 * it is cheap.
 *
 * @param {string} text YAML source
 * @param {Object} [options] yaml options; `logLevel` is always `error`
 * @returns {Array<Object>} The parsed documents. Their `toJS()` throws a
 *   ReferenceError like parse() does for aliases that expand too far
 */
export declare function parseAllDocuments(text: string, options?: Object): Array<Object>;
//# sourceMappingURL=yaml.d.ts.map