/**
 * Register an external formulation parser.
 *
 * The parser is appended to the registry and will be invoked by
 * {@link addFormulationSection} on the next call.
 *
 * @param {{ id: string, patterns: string[], parse: Function }} parser
 */
export function registerParser(parser: {
    id: string;
    patterns: string[];
    parse: Function;
}): void;
/**
 * Return a shallow copy of the currently registered parsers.
 *
 * @returns {Array<{ id: string, patterns: string[], parse: Function }>}
 */
export function getParsers(): Array<{
    id: string;
    patterns: string[];
    parse: Function;
}>;
/**
 * Build the formulation section for a CycloneDX BOM.
 *
 * This function is the top-level aggregator: it collects git metadata,
 * invokes every registered CI parser, and merges the results into a single
 * CycloneDX formulation entry.
 *
 * The function falls back to a minimal stub workflow when no CI config files
 * are detected at the given path.
 *
 * @param {Object} options          CLI options; `options.path` is used as the
 *                                  project root for file discovery.
 * @param {Object} [context={}]     Optional context object.  If it contains a
 *                                  non-empty `formulationList` array those
 *                                  components are merged into the result.
 *
 * @returns {{ formulation: Object[], dependencies: Object[] }}
 *   `formulation` – array to be placed at `bomJson.formulation`
 *   `dependencies` – dependency objects to be merged into
 *                    `bomJson.dependencies` via `mergeDependencies`
 */
export function addFormulationSection(options: Object, context?: Object): {
    formulation: Object[];
    dependencies: Object[];
};
//# sourceMappingURL=formulationParsers.d.ts.map