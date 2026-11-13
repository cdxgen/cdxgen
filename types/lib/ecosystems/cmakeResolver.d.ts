/**
 * CMake build-context resolver: the layer-3 bridge between the pure parsers
 * (`lib/parsers/cmakeCache.js`, `lib/parsers/gitmodules.js`) and the C/C++ BOM
 * lifecycle in `lib/cli/nativeBom.js`.
 *
 * This module owns every subprocess invocation and every filesystem read
 * outside the scan root. It reads `CMakeCache.txt`, `.gitmodules`, the
 * FetchContent gitclone scripts, and the submodule gitlinks in the index, then
 * returns repo-relative facts the lifecycle can attach to components.
 */
import { GIT_COMMAND } from "../inventory/envcontext.js";
/**
 * Make an absolute build-machine path repo-relative. Returns `null` when the
 * path does not lie under the scan root (so the caller can drop it rather than
 * emit a verbatim build-machine path).
 *
 * @param {string} absPath Absolute path from CMakeCache
 * @param {string} scanRoot The project scan root
 * @returns {string|null} Repo-relative path using POSIX separators, or null
 */
declare function toRepoRelative(absPath: string, scanRoot: string): string | null;
/**
 * Detect the build directory that holds a `CMakeCache.txt`.
 *
 * An explicit `--cmake-cache <path>` option (passed via `options.cmakeCache`)
 * takes precedence and skips autodetection. Otherwise the project's build
 * directories are searched in order: those its CMake presets configure, then
 * the conventional `build`, `out`, `builddir` and `cmake-build-` directories
 * (see `cmakeBuildDirCandidates`).
 *
 * @param {string} path Project scan root
 * @param {Object} options CLI options; `options.cmakeCache` is an explicit override
 * @returns {{ cacheFile: string, buildDir: string } | null}
 */
export declare function detectCmakeBuildDir(path: string, options: Object): {
    cacheFile: string;
    buildDir: string;
} | null;
/**
 * Read a detected `CMakeCache.txt`. The file must resolve inside its build
 * directory, which is inside the project unless --cmake-cache named it, must
 * be a regular file and must be no larger than 16 MiB.
 *
 * @param {{ cacheFile: string, buildDir: string }} detected Detected cache
 * @returns {string|undefined} The text, or undefined
 */
export declare function readCmakeCacheText(detected: {
    cacheFile: string;
    buildDir: string;
}): string | undefined;
/**
 * Read and resolve the CMakeCache facts for a project.
 *
 * @param {string} path Project scan root
 * @param {Object} options CLI options
 * @returns {{ rootProject: {name?:string, version?:string}|null, projects: Map, findPackages: Map, fetchContentBase?: string, buildDir?: string } | null}
 */
export declare function resolveCmakeCache(path: string, options: Object): {
    rootProject: {
        name?: string;
        version?: string;
    } | null;
    projects: Map<any, any>;
    findPackages: Map<any, any>;
    fetchContentBase?: string;
    buildDir?: string;
} | null;
/**
 * Read the FetchContent gitclone script and extract the repository URL and tag.
 *
 * The script lives at
 * `<build>/_deps/<name>-subbuild/<name>-populate-prefix/tmp/<name>-populate-gitclone.cmake`
 * and contains the literal `clone ... "<GIT_REPOSITORY>" "<name>-src"` and
 * `checkout "<GIT_TAG>" --` lines. No git invocation is needed.
 *
 * @param {string} buildDir Build directory
 * @param {string} depName FetchContent dep name (lowercase)
 * @returns {{ url: string|null, tag: string|null }}
 */
export declare function readFetchContentGitclone(buildDir: string, depName: string): {
    url: string | null;
    tag: string | null;
};
/**
 * Parse a gitclone.cmake script for the GIT_REPOSITORY and GIT_TAG literals.
 *
 * The clone line carries several quoted arguments (`--config "..."`, the
 * repository URL, and the source dir), so the URL is identified as the quoted
 * token that parses as a git remote rather than the first quoted token.
 *
 * @param {string} text Script contents
 * @returns {{ url: string|null, tag: string|null }}
 */
export declare function parseGitcloneScript(text: string): {
    url: string | null;
    tag: string | null;
};
/**
 * Collect submodule pin data from the gitlinks (mode 160000) in the index,
 * with the prefixes and names `git submodule status` would show: ` ` for a
 * checked-out submodule at the recorded commit, `+` for one at another
 * commit (whose commit is reported), `-` for one that is not checked out and
 * `U` for a conflicted entry.
 *
 * `git submodule status` itself is not run, because it compares work-tree
 * files with the index and hashes a racily clean file again through the
 * `filter.<name>.clean` command the scanned repository's own config names,
 * which no `-c` override in `execGitCommand` can disable. Only the index
 * (`git ls-files --stage`) and a submodule's refs and objects (`git
 * rev-parse`, `git describe`) are read. Uninitialised submodules (the normal
 * case for `--depth 1` clones and CI) have no describe, so the version
 * degrades to the commit SHA.
 *
 * @param {string} path Repo directory
 * @returns {Map<string, { sha: string, describe: string|null, prefix: string, path: string }>} Path → pin data
 */
export declare function collectSubmoduleStatus(path: string): Map<string, {
    sha: string;
    describe: string | null;
    prefix: string;
    path: string;
}>;
/**
 * Parse the gitlinks out of `git ls-files --stage -z` output.
 *
 * Each NUL-terminated record is `<mode> <sha> <stage>\t<path>`. Only entries
 * of mode `160000` are submodule pins. A path with a stage-0 entry is
 * resolved; one with only conflict stages (1 to 3) is marked conflicted.
 *
 * @param {string|undefined} output Raw command output
 * @returns {Map<string, { sha: string, conflicted: boolean }>} Path → pinned commit
 */
export declare function parseIndexGitlinks(output: string | undefined): Map<string, {
    sha: string;
    conflicted: boolean;
}>;
/**
 * Build the complete CMake/submodule resolution for a project.
 *
 * Combines CMakeCache facts, `.gitmodules`, submodule pins, and FetchContent
 * gitclone scripts into a single boundary set and component list the C/C++
 * lifecycle can consume.
 *
 * @param {string} path Project scan root
 * @param {Object} options CLI options
 * @returns {{ rootProject: {name?:string, version?:string}|null, findPackages: Map<string,string>, submodules: Array, fetchDeps: Array, boundaries: Map<string,{kind:string,version?:string,url?:string,name:string}> }}
 */
export declare function resolveCmakeContext(path: string, options: Object): {
    rootProject: {
        name?: string;
        version?: string;
    } | null;
    findPackages: Map<string, string>;
    submodules: any[];
    fetchDeps: any[];
    boundaries: Map<string, {
        kind: string;
        version?: string;
        url?: string;
        name: string;
    }>;
};
/**
 * Build a purl string from resolved submodule/fetch coordinates, returning
 * null when the parts do not form a valid purl.
 *
 * @param {string} resolvedUrl Absolute git URL
 * @param {string} [version] Resolved version
 * @returns {string|null}
 */
export declare function buildDependentPurl(resolvedUrl: string, version?: string): string | null;
/**
 * Collapse components that name the same CMake package at different versions.
 *
 * `find_package(Boost 1.54)` in one `CMakeLists.txt` and `find_package(Boost
 * 1.64)` in another state two minimum requirements for a single dependency, not
 * two dependencies. A build that satisfies both links one Boost, the higher of
 * the two, so that requirement becomes the component version and the full set
 * is kept under `cdx:cmake:versionRequirements`.
 *
 * Matching is on name alone, case-insensitively. Components carrying a
 * `cdx:cmake:depKind` property are left alone: a FetchContent dependency or a
 * submodule is pinned to a commit that was really checked out, and two such
 * pins are genuinely two things.
 *
 * @param {Object[]} pkgList Components scraped from CMake-like files
 * @returns {Object[]} Components with one entry per package name, in first-seen order
 */
export declare function collapseCmakeVersions(pkgList: Object[]): Object[];
/**
 * Keep one component per dependency downloaded at configure time.
 *
 * The same `FetchContent_Declare` may be read from several files, and a
 * `find_package(<name>)` names the package a `FetchContent_Declare(<name>)` or
 * `CPMAddPackage` fetches. Within the components scraped from CMake files, the
 * first fetched component of each name stands for all of them, and a plain
 * `find_package` entry of that name is dropped.
 *
 * @param {Object[]} pkgList Components scraped from CMake-like files
 * @returns {Object[]} The components, in first-seen order
 */
export declare function preferFetchedCmakeDependencies(pkgList: Object[]): Object[];
/**
 * Drop the components scraped from CMake files for a dependency the build tree
 * has resolved: the gitclone script names the repository and tag that were
 * really checked out, so its component replaces the declared one.
 *
 * @param {Object[]} pkgList Components collected so far
 * @param {string} name Name of the resolved dependency
 * @returns {Object[]} The components without the scraped entries for `name`
 */
export declare function withoutScrapedFetchDependency(pkgList: Object[], name: string): Object[];
export { GIT_COMMAND, toRepoRelative };
//# sourceMappingURL=cmakeResolver.d.ts.map