/**
 * The key of a place in a purl's occurrence set (`purlLocationMap`).
 *
 * Every location that enters an occurrence set is keyed by this function,
 * whatever evidence source added it: the seeding from the input BOM
 * (`initFromSbom`), the atom `usages` slices, the golem, rusi, kosi, dosai and
 * scalasem reports, the C include attribution and the Swift semantics slices.
 * Backslashes become `/`, so a place spelled with `\` in the input BOM
 * (Windows cdxgen output) and `/` in a slice is one occurrence, not two
 * (issue 4726). The path is otherwise left as spelled: no resolving, no case
 * folding, no stripping of a leading `./`.
 *
 * @param {string} location File path or other location text
 * @param {number} [line] Line number; not a positive number means the location names no line
 * @returns {string|undefined} Key in the `file#line` or plain `file` shape; undefined when the location is empty
 */
export declare function occurrenceLocationKey(location: string, line?: number): string | undefined;
//# sourceMappingURL=occurrenceKey.d.ts.map