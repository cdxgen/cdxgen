/**
 * OCaml opam parser for `.opam.locked` files.
 *
 * `opam lock` writes a `<name>.opam.locked` file that pins the full resolved
 * dependency set of a project: a `depends:` field listing every package with
 * an equality constraint on its version, and a `pin-depends:` field for
 * packages pinned to a URL. The file is opam's own syntax, a small
 * line-oriented field language, which is read here with a line scanner rather
 * than a monolithic expression.
 *
 * A locked file holds the closure only: it does not record which packages are
 * direct dependencies of the project, so every entry is reported with the
 * same standing and the project root links to all of them.
 *
 * Packages are identified with the registered `opam` purl type
 * (`pkg:opam/<name>@<version>`).
 */
/**
 * Parse an `.opam.locked` (or plain `.opam`) file.
 *
 * @param {string} opamLockedFile Path to the opam file
 * @returns {{ pkgList: object[], pins: Array<{name: string, url: string|undefined}> }}
 */
export declare function parseOpamLockedFile(opamLockedFile: string): {
    pkgList: object[];
    pins: Array<{
        name: string;
        url: string | undefined;
    }>;
};
//# sourceMappingURL=parsers-opam.d.ts.map