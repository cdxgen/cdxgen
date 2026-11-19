/**
 * Zig `build.zig.zon` parser.
 *
 * `build.zig.zon` is ZON — Zig Object Notation — and it is not JSON. It uses
 * unquoted `.field = value` syntax, `.{}` anonymous struct literals, tuples
 * (positional struct fields), multiline string literals, character literals,
 * hex/underscore-separated numbers, and enum literals (`.foo`). A naive
 * `JSON.parse` with fixups cannot read it, so this module ships a real
 * tokenizer and recursive-descent parser.
 *
 * The grammar implemented here is the subset that appears in `build.zig.zon`:
 * anonymous struct literals, tuples, string literals (with the full Zig escape
 * set), multiline string literals, numbers, character literals, booleans,
 * `null`, enum literals, and `//` line comments — ZON is Zig syntax, and the
 * manifest `zig init` generates is largely comments.
 */
/**
 * Parse a Zig `build.zig.zon` file and return a package list and parent
 * component describing the project and its dependencies.
 *
 * Zig dependencies are content-addressed rather than versioned by tag, so a
 * fetched dependency's identity comes from its `.hash`. Two encodings are in
 * use: the pre-0.14 hex multihash, where a `1220` prefix denotes SHA-2-256
 * (codec `0x12`, 32-byte length `0x20`), and the 0.14+ form
 * `<name>-<version>-<base64 digest>`, which carries the dependency's declared
 * version. The multihash digest is emitted as a CycloneDX `hashes[]` entry
 * when the codec is recognised; the raw hash string is always kept as a
 * property so nothing is lost for encodings that cannot be decoded.
 *
 * `zig` is not a registered purl type, so dependencies use `pkg:generic/...`
 * with a `cdx:purl:proposedType=zig` property and a `download_url` qualifier
 * built from the `url`.
 *
 * @param {string} zonFile Path to `build.zig.zon`
 * @param {string} [sourceLabel] Path or label used in `internal:SrcFile`
 *   evidence. When omitted, `zonFile` is used. A manifest read from outside
 *   the scan root needs a label, so that its host path stays out of the BOM.
 * @returns {{ pkgList: object[], parentComponent: object }} parsed packages
 */
export declare function parseBuildZigZon(zonFile: string, sourceLabel?: string): {
    pkgList: object[];
    parentComponent: object;
};
/**
 * Parse ZON content (already read from a file or extracted from an archive)
 * into a package list and parent component.
 *
 * The content-based entry point lets the resolver parse manifests read from
 * `.tar.gz` cache archives without writing them to a temp file.
 *
 * @param {string} content Raw ZON source
 * @param {string} [sourceLabel] Path or label used in `internal:SrcFile`
 *   evidence. When omitted, `"<zon-content>"` is used.
 * @returns {{ pkgList: object[], parentComponent: object }} parsed packages
 */
export declare function parseBuildZigZonContent(content: string, sourceLabel?: string): {
    pkgList: object[];
    parentComponent: object;
};
/**
 * Tokenize a ZON source string.
 *
 * The tokenizer is intentionally separate from the parser so each literal form
 * (string escapes, multiline strings, hex numbers, char literals) is handled
 * in one place and can be unit-tested in isolation.
 *
 * @param {string} src ZON source
 * @returns {Array<{type: string, value: *}>} tokens
 * @throws {Error} when the source contains a character that cannot begin a token
 */
export declare function tokenizeZon(src: string): Array<{
    type: string;
    value: any;
}>;
/**
 * Parse a ZON source string into a JavaScript value.
 *
 * Structs become plain objects keyed by field name; tuple (positional) values
 * are collected under a `_positional` array. Enum literals (`.foo`) become the
 * bare identifier string.
 *
 * @param {string} src ZON source
 * @returns {*} parsed value
 */
export declare function parseZon(src: string): any;
//# sourceMappingURL=parsers-zig.d.ts.map