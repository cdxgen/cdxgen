/**
 * Pure parser for CMake language files (`CMakeLists.txt`, `*.cmake`).
 *
 * `parseCmakeCommands` splits a file into command invocations the way CMake
 * reads it: command names are case-insensitive, an invocation may span several
 * lines, and arguments may be quoted, bracketed (`[[...]]`) or interleaved with
 * comments. `cmakeFetchDependencies` reads the commands that download a
 * dependency at configure time: `FetchContent_Declare`, `ExternalProject_Add`
 * and the CPM.cmake `CPMAddPackage` family.
 *
 * This module is layer 1 (text in, data out): no filesystem or subprocess
 * access. `lib/ecosystems/parsers-misc.js` turns the facts into components.
 */
/**
 * Split CMake source into command invocations.
 *
 * @param {string} text Contents of a CMake file
 * @returns {{name: string, args: string[], line: number}[]} Invocations in
 *   source order. `name` is lower-cased; `args` have their quotes and bracket
 *   delimiters removed; `line` is the 1-based line of the command name.
 */
export declare function parseCmakeCommands(text: string): {
    name: string;
    args: string[];
    line: number;
}[];
/**
 * Replace `${VAR}` references with the values of simple `set()` calls. A
 * reference to an unknown variable is left in place, so callers can tell a
 * resolved value from an unresolved one. Expansion stops at the previous
 * round once the text would exceed `maxLength`, 64 KiB by default.
 *
 * @param {string} value Argument text
 * @param {Map<string,string>} variables Known variable values
 * @param {number} [maxLength] Upper bound on the expanded text
 * @returns {string} The expanded text
 */
export declare function expandCmakeVariables(value: string, variables: Map<string, string>, maxLength?: number): string;
/**
 * The variables a file sets to a single value: `set(FOO_VERSION 1.2.3)` and
 * `set(FOO_VERSION "1.2.3" CACHE STRING "...")`. Later definitions win.
 *
 * @param {{name: string, args: string[]}[]} commands Parsed commands
 * @returns {Map<string,string>} Variable values
 */
export declare function cmakeSetVariables(commands: {
    name: string;
    args: string[];
}[]): Map<string, string>;
/**
 * The dependencies a CMake file downloads at configure time.
 *
 * `FetchContent_Declare(<name> ...)` and `ExternalProject_Add(<name> ...)` are
 * read for `GIT_REPOSITORY`/`GIT_TAG` and `URL`/`URL_HASH`/`URL_MD5`.
 * `CPMAddPackage`, `CPMFindPackage` and `CPMDeclarePackage` are read in both
 * the shorthand form and the keyword form (`NAME`, `VERSION`,
 * `GITHUB_REPOSITORY`, `GITLAB_REPOSITORY`, `BITBUCKET_REPOSITORY`,
 * `GIT_REPOSITORY`, `GIT_TAG`, `URL`, `URL_HASH`). `${VAR}` references are
 * expanded with the file's simple `set()` values; anything still unresolved
 * stays as written.
 *
 * @param {string} text Contents of a CMake file
 * @returns {{kind: string, name: string, line: number, gitRepository?: string, gitTag?: string, url?: string, urlHash?: string, version?: string, madeAvailable: boolean}[]}
 *   `kind` is `fetch`, `external-project` or `cpm`; `madeAvailable` is true
 *   when a `FetchContent_MakeAvailable` in the same file names the dependency.
 */
export declare function cmakeFetchDependencies(text: string): {
    kind: string;
    name: string;
    line: number;
    gitRepository?: string;
    gitTag?: string;
    url?: string;
    urlHash?: string;
    version?: string;
    madeAvailable: boolean;
}[];
//# sourceMappingURL=cmakeLists.d.ts.map