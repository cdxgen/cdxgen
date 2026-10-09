/**
 * Pure parser for CMakeCache.txt.
 *
 * CMakeCache is produced by `cmake` during configuration. Each non-comment line
 * is `KEY:TYPE=VALUE`, where TYPE is one of BOOL, PATH, FILEPATH, STRING,
 * INTERNAL, STATIC, UNINITIALIZED. Comment lines start with `//`; a leading
 * `# This is the CMakeCache file.` header and blank lines are ignored.
 *
 * This module is layer 1 (pure text in, data out): it has no filesystem or
 * subprocess access. The git/build-directory orchestration that consumes these
 * facts lives in `lib/ecosystems/cmakeResolver.js`.
 */
/**
 * Parse the raw text of a CMakeCache.txt file into an ordered key→entry map.
 *
 * Only well-formed `KEY:TYPE=VALUE` lines are captured. Comment (`//`), blank,
 * and the `# This is the CMakeCache file.` header lines are ignored, as are
 * lines that do not carry a recognised CMake cache type.
 *
 * @param {string} text Raw CMakeCache.txt contents
 * @returns {Map<string, {type: string, value: string}>} Ordered map of cache entries
 */
export declare function parseCmakeCache(text: string): Map<string, {
    type: string;
    value: string;
}>;
/**
 * Extract the version from a `FIND_PACKAGE_MESSAGE_DETAILS_<Pkg>:INTERNAL`
 * value.
 *
 * The value is a sequence of `[...]` groups whose last group is
 * `[v<VERSION>()]`. The version may be empty (`[v()]`). Only the final
 * `[v...]` group is matched so a `[v...]` fragment inside an earlier bracket
 * (a library path) cannot poison the result.
 *
 * @param {string} value The INTERNAL value after `=`
 * @returns {string|null} The resolved version, empty string when the group is
 *   present but empty, or `null` when no `[v...]` group is present.
 */
export declare function parseFindPackageVersion(value: string): string | null;
/**
 * Resolve the high-level facts a CMakeCache exposes about a configured build.
 *
 * Harvests the root project, every project directory, FetchContent sources, and
 * the resolved versions of `find_package` lookups. `<name>_VERSION` is **not**
 * present in the cache for subprojects, so fetched/submodule versions must be
 * resolved from git or the gitclone script instead.
 *
 * @param {Map<string, {type: string, value: string}>} map Output of {@link parseCmakeCache}
 * @returns {{ rootProject: {name?: string, version?: string} | null, projects: Map<string, {version?: string, sourceDir?: string, binaryDir?: string, isTopLevel?: boolean, kind: string}>, findPackages: Map<string, string>, fetchContentBase?: string }}
 */
export declare function resolveCmakeCacheFacts(map: Map<string, {
    type: string;
    value: string;
}>): {
    rootProject: {
        name?: string;
        version?: string;
    } | null;
    projects: Map<string, {
        version?: string;
        sourceDir?: string;
        binaryDir?: string;
        isTopLevel?: boolean;
        kind: string;
    }>;
    findPackages: Map<string, string>;
    fetchContentBase?: string;
};
/**
 * Parse a compiler description CMake writes when it configures a build
 * (`CMakeFiles/<cmake version>/CMake<LANG>Compiler.cmake`): the compiler's
 * path, CMake's id for it and its version, all identified by CMake itself.
 *
 * @param {string} text File contents
 * @returns {{language: string, compiler: string, family: string, id: string, version: string}|null}
 *   `null` when the text names no compiler
 */
export declare function parseCmakeCompilerFile(text: string): {
    language: string;
    compiler: string;
    family: string;
    id: string;
    version: string;
} | null;
//# sourceMappingURL=cmakeCache.d.ts.map