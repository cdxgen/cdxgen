/**
 * Attach JS/TS import and export usage evidence to matching package components.
 *
 * For each component, resolves its module aliases (including the deno jsr
 * specifier), records imported/exported modules as properties, attaches
 * occurrence evidence, and promotes the component scope to "required" when the
 * package is used. A package with no observed usage keeps the scope its
 * manifest parser assigned: static import analysis cannot see packages loaded
 * from configuration, bundler entrypoints, stylesheets, or plugins, so a
 * missing import is not evidence that a package is optional.
 *
 * When the lock file holds several versions of a package, an import is
 * evidence only for the version the importing file resolves to (see
 * `createNpmVersionChooser`), so a copy nested under another package is not
 * credited with, or promoted to required by, the project's own imports.
 *
 * @param {Array<object>} pkgList Package components to enrich.
 * @param {object} allImports Map of import specifier to usage evidence objects.
 * @param {object} allExports Map of export specifier to export evidence objects.
 * @param {boolean} deep When true, fill in missing description/author/license
 *   metadata from the local node_modules copy of each package.
 * @param {object} [context] Project facts that pick the version a file uses.
 * @param {string} [context.srcDir] Directory the evidence file names are relative to.
 * @param {Array<object>} [context.dependencies] Dependency tree of the packages.
 * @param {object} [context.parentComponent] Project component, with any workspace members as its components.
 * @returns {Promise<Array<object>>} The enriched package list (same reference as pkgList).
 */
export declare function addEvidenceForImports(pkgList: Array<object>, allImports: object, allExports: object, deep: boolean, context?: {
    srcDir?: string;
    dependencies?: Array<object>;
    parentComponent?: object;
}): Promise<Array<object>>;
//# sourceMappingURL=jsEvidence.d.ts.map