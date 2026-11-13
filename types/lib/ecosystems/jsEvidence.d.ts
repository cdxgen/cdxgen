/**
 * Module specifier in the form that may be written to a BOM. A module loaded
 * by URL (deno, browser ES modules, wasm) can carry userinfo or a signed query
 * string, neither of which may reach the BOM, so a URL with an authority,
 * protocol-relative ones included, loses both and its fragment. Anything else,
 * such as a bare package name or a Windows path, is returned as it is.
 *
 * @param {string} specifier Module specifier found in the sources.
 * @returns {string|undefined} The specifier, a URL without userinfo, query and
 *   fragment, or undefined for a URL that cannot be parsed.
 */
export declare function bomSafeSpecifier(specifier: string): string | undefined;
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