/**
 * Lua parser for rockspecs and `luarocks.lock`.
 *
 * A rockspec is a Lua source file whose top level is a sequence of
 * assignments describing one package: its name, version, source, and a
 * `dependencies` table of constraint strings (`"lua >= 5.1"`). LuaRocks 3
 * can also persist the resolved set to `luarocks.lock`. Both are read with a
 * small line scanner over the shapes these files actually use, rather than a
 * Lua interpreter.
 *
 * Rocks are identified with the registered `luarocks` purl type
 * (`pkg:luarocks/<name>@<version>`). Lua versions carry a rock revision
 * suffix (`5.4.6-1`); the full rock version is kept verbatim because the
 * revision distinguishes distinct builds.
 */
/**
 * Parse a rockspec manifest.
 *
 * @param {string} rockspecFile Path to the `.rockspec` file
 * @returns {{ pkgList: object[], parentComponent: object }}
 */
export declare function parseRockspecFile(rockspecFile: string): {
    pkgList: object[];
    parentComponent: object;
};
/**
 * Parse a `luarocks.lock` file.
 *
 * @param {string} lockFile Path to `luarocks.lock`
 * @param {string|string[]} [rockspecFile] Path to the rockspec, or to every
 *   rockspec sharing the lock, to mark direct deps
 * @returns {{ pkgList: object[], parentComponent: object }}
 */
export declare function parseLuaRocksLock(lockFile: string, rockspecFile?: string | string[]): {
    pkgList: object[];
    parentComponent: object;
};
/**
 * Read the top-level assignments of a Lua configuration file.
 *
 * The files cdxgen consumes use a constrained surface: `key = value` lines
 * where the value is a quoted string, a table of strings or
 * `["key"] = "value"` entries, or a short list expression. Values are
 * normalised to strings, arrays of `{name, constraint}` records, or arrays
 * of `{key, value}` records for mixed tables.
 *
 * @param {string} filePath File to read
 * @returns {Map<string, *>} Parsed top-level fields
 */
export declare function readLuaAssignments(filePath: string): Map<string, any>;
//# sourceMappingURL=parsers-lua.d.ts.map