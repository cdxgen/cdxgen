/**
 * Zig transitive dependency resolver.
 *
 * Zig has no central registry. A dependency is a content-addressed archive
 * whose identity is its `.hash`. The same hash string is used as a filesystem
 * lookup key across every Zig version — only the container differs (in-tree
 * `zig-pkg/` directory, extracted cache directory, or cache `.tar.gz`
 * archive). This module walks the full dependency graph by locating each
 * dependency's `build.zig.zon` through those containers, then emits a flat
 * component list plus a CycloneDX `dependencies[]` edge list.
 *
 * Resolution is a pure filesystem walk keyed on hashes already present in the
 * manifests. No subprocess, no network, no toolchain. Populating the cache
 * (`zig build --fetch`) is the user's job.
 */
/**
 * Validate a Zig `.hash` string against the two known encodings before it is
 * used to build a filesystem path.
 *
 * A `.hash` is attacker-controlled data from a manifest. Joining it blindly
 * into `<cache>/p/<hash>/build.zig.zon` would let a `../` in the hash escape
 * the cache directory. The two legal encodings never contain path separators
 * or `..` segments, so any hash that does not match one of them is refused
 * before the filesystem is touched.
 *
 * The two forms are:
 *   1. 0.14+ — `<name>-<version>-<base64url digest>` where the digest uses
 *      `[A-Za-z0-9_-]`.
 *   2. Pre-0.14 — hex multihash, all hex digits (at least 4 characters).
 *
 * @param {string|undefined} hash Hash field value from the manifest
 * @returns {boolean} `true` only when the hash matches a known Zig encoding
 */
export declare function isValidZigHash(hash: string | undefined): boolean;
/**
 * Resolve the Zig global package cache directory.
 *
 * Order: `ZIG_GLOBAL_CACHE_DIR`, then `$XDG_CACHE_HOME/zig`, then
 * `~/.cache/zig` on Linux **and macOS** (macOS uses `~/.cache/zig`, *not*
 * `Library/Caches` — confirmed empirically), then `%LOCALAPPDATA%\zig` on
 * Windows.
 *
 * @returns {string|null} Absolute cache directory path, or null when it cannot
 *   be determined
 */
export declare function getZigGlobalCacheDir(): string | null;
/**
 * Walk the full Zig dependency graph starting from a root `build.zig.zon`,
 * returning a flat component list and a CycloneDX `dependencies[]` edge list.
 *
 * For each dependency carrying a `.hash`, the resolver locates the
 * dependency's own `build.zig.zon` and recurses. Hashes are memoised so
 * diamond dependencies do not re-read manifests.
 *
 * Unresolvable hashes (cache not populated) degrade gracefully: the component
 * still appears with no outgoing edges, and the count is returned so callers
 * can report a partial graph.
 *
 * @param {string} rootZonFile Absolute path to the root `build.zig.zon`
 * @param {string} projectRoot The project scan root
 * @param {object} [options] CLI options (reserved for future use)
 * @returns {Promise<{ pkgList: object[], dependencies: object[], parentComponent: object, unresolvedCount: number }>}
 */
export declare function resolveZigGraph(rootZonFile: string, projectRoot: string, options?: object): Promise<{
    pkgList: object[];
    dependencies: object[];
    parentComponent: object;
    unresolvedCount: number;
}>;
/**
 * Walk the Zig dependency graphs of several root `build.zig.zon` files, such
 * as the members of a workspace, over one set of memo tables, so a dependency
 * the roots share is read and walked once.
 *
 * Each hash is walked once, and every component that names it gets the
 * dependencies found there; two hashes that give one bom-ref (one name and
 * version, pinned to different commits) both add theirs. A hash named under
 * more than MAX_REFS_PER_HASH bom-refs (field names or URLs) resolves to the
 * first one from then on, since every further alias would copy all its edges.
 *
 * @param {string[]} rootZonFiles Absolute paths of the root manifests
 * @param {string} projectRoot The project scan root
 * @param {object} [_options] CLI options (reserved for future use)
 * @returns {Promise<{ pkgList: object[], dependencies: object[], parentComponents: object[], unresolvedCount: number }>}
 */
export declare function resolveZigGraphs(rootZonFiles: string[], projectRoot: string, _options?: object): Promise<{
    pkgList: object[];
    dependencies: object[];
    parentComponents: object[];
    unresolvedCount: number;
}>;
//# sourceMappingURL=zigResolver.d.ts.map