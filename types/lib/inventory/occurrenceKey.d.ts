/**
 * The key of a place in a purl's occurrence set (`purlLocationMap`).
 *
 * Every location that enters an occurrence set is keyed by this function,
 * whatever evidence source added it: the seeding from the input BOM
 * (`initFromSbom`), the atom `usages` and `callsites` slices, the golem, rusi,
 * kosi, dosai and scalasem reports, the C include attribution and the Swift
 * semantics slices. Backslashes become `/`, so a place spelled with `\` in the
 * input BOM (Windows cdxgen output) and `/` in a slice is one occurrence, not
 * two (issue 4726). The path is otherwise left as spelled: no resolving, no
 * case folding, no stripping of a leading `./`.
 *
 * A place a line already names is keyed `file#line`; a place a callsites
 * record names down to its column is keyed `file:line:offset`, so two use
 * sites on one line are two occurrences. An occurrence with only `location`
 * and `line` names the line as a whole: it is the same place as any use site
 * that line carries, and it is kept as an occurrence of its own only while no
 * `file:line:offset` key of that line exists (the writer drops the line-only
 * key then, see `dropSubsumedOccurrenceKeys`). That rule is what keeps a
 * re-run of evinse over its own output at the same occurrences: the first run
 * writes the `file:line:offset` keys, and the second run seeds and re-adds
 * exactly those.
 *
 * @param {string} location File path or other location text
 * @param {number} [line] Line number; not a positive number means the location names no line
 * @param {number} [offset] Column within the line; not a positive number means the place is the line
 * @returns {string|undefined} Key in the `file:line:offset`, `file#line` or plain `file` shape; undefined when the location is empty
 */
export declare function occurrenceLocationKey(location: string, line?: number, offset?: number): string | undefined;
/**
 * Drop the occurrence keys a use-site key subsumes.
 *
 * A `file:line:offset` key names a use site on a line; the line-only
 * `file#line` key of the same line names no place of its own any more, so it
 * is removed rather than counted beside the use sites (issue 4726: an
 * occurrence seeded from an input BOM with only `location` and `line` is the
 * same place as a callsites occurrence at that line).
 *
 * @param {string[]} keys Occurrence-set keys
 * @returns {string[]} The keys without the subsumed line-only entries
 */
export declare function dropSubsumedOccurrenceKeys(keys: string[]): string[];
//# sourceMappingURL=occurrenceKey.d.ts.map