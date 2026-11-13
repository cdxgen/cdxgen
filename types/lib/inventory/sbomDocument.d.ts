/**
 * Maximum size in bytes (5 MiB) of a third-party SBOM document accepted for parsing.
 *
 * @type {number}
 */
export declare const MAX_SBOM_DOCUMENT_BYTES: number;
/**
 * Parse a third-party SBOM document into components and dependencies.
 *
 * Returns null — never throws — when the document is too large, is not JSON, is
 * not a recognised SBOM shape, or carries nothing worth merging. Every rejection
 * is reported once, naming the source, so a skipped document is visible rather
 * than silent.
 *
 * @param {string} text Raw document text
 * @param {Object} [input] Parse inputs
 * @param {string} [input.source] Provenance label used in warnings (path, entry name or URL)
 * @param {number} [input.maxBytes] Size bound. Defaults to `MAX_SBOM_DOCUMENT_BYTES`
 * @returns {{components: Object[], dependencies: Object[], format: string, rootRef: (string|undefined)}|null}
 */
export declare function parseSbomDocument(text: string, { source, maxBytes }?: {
    source?: string;
    maxBytes?: number;
}): {
    components: Object[];
    dependencies: Object[];
    format: string;
    rootRef: (string | undefined);
} | null;
/**
 * Repair the purl of a component read from a third-party document.
 *
 * Producers write a `download_url` as a bare URL, but a purl qualifier value is
 * percent-encoded, so an unescaped `://` makes the whole purl unparseable. A
 * `file:` URL is dropped instead of escaped: it names a path on the machine
 * that built the document, so it identifies nothing for a reader of the BOM.
 * Versions are escaped for build metadata in either case.
 *
 * A purl that is still unparseable afterwards is split on its separators and
 * rebuilt, which escapes any remaining reserved character wherever it sits —
 * a shared-library name such as `libstdc++.so.6`, for instance.
 *
 * @param {object} component Component whose purl is rewritten in place
 */
export declare function repairPurl(component: object): void;
/**
 * Attach provenance properties to every component of a parsed document. The
 * caller owns the property names so each provenance channel stays
 * distinguishable in the merged BOM.
 *
 * @param {Object[]} components Components from `parseSbomDocument`
 * @param {Array<{name: string, value: string}>} properties Properties to add
 * @returns {Object[]} The same array, with properties attached
 */
export declare function tagSbomComponents(components: Object[], properties: Array<{
    name: string;
    value: string;
}>): Object[];
/**
 * Create a bound on the components and dependencies a caller keeps from
 * third-party SBOM documents. One document is bounded by its size, but
 * nothing bounds how many documents a wheel, a directory of installed
 * distributions or a TEA Collection supplies, and every component kept stays
 * in memory until the BOM is written.
 *
 * @param {number} max Most components and dependencies to accept
 * @param {string} scope What the bound covers, for the warning
 * @returns {{max: number, used: number, scope: string}} The budget
 */
export declare function createSbomElementBudget(max: number, scope: string): {
    max: number;
    used: number;
    scope: string;
};
/**
 * Charge the components and dependencies of a parsed document to budgets
 * made by {@link createSbomElementBudget}. The document is charged to all of
 * them, or, when it would take any of them past its bound, to none, and the
 * caller skips it.
 *
 * @param {{components: Object[], dependencies: Object[]}} parsed Document from `parseSbomDocument`
 * @param {Array<{max: number, used: number, scope: string}>} budgets Budgets to charge
 * @param {string} source Provenance label used in the warning
 * @returns {boolean} true when the document fits every budget
 */
export declare function chargeSbomElementBudgets(parsed: {
    components: Object[];
    dependencies: Object[];
}, budgets: Array<{
    max: number;
    used: number;
    scope: string;
}>, source: string): boolean;
//# sourceMappingURL=sbomDocument.d.ts.map