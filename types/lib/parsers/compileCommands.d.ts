/**
 * Pure reader for JSON compilation databases (`compile_commands.json`).
 *
 * Each entry names a translation unit (`file`), the directory its command ran
 * in (`directory`) and the command, either as an argument list (`arguments`)
 * or as one command line (`command`) split with the quoting rules of the
 * shell it was written for. From the entries this module derives the
 * compilers a build uses, the include directories each unit is compiled
 * with, and the security-hardening options in effect.
 *
 * Layer 1: data in, data out. Locating and reading the file, and running a
 * compiler to learn its version, belong to the callers.
 */
/**
 * Split a POSIX shell command line into words: single quotes keep everything
 * literally, double quotes keep everything except `\"`, `\\`, `\$` and
 * `` \` ``, and a backslash outside quotes escapes the next character.
 *
 * @param {string} command Command line
 * @returns {string[]} Words
 */
export declare function splitPosixCommand(command: string): string[];
/**
 * Split a Windows command line into words as the Microsoft C runtime does:
 * double quotes group, `\"` is a literal quote, and backslashes are literal
 * unless they precede a quote.
 *
 * @param {string} command Command line
 * @returns {string[]} Words
 */
export declare function splitWindowsCommand(command: string): string[];
/**
 * The compiler family a driver's name implies.
 *
 * @param {string} driver Driver path or name
 * @returns {string} `msvc`, `clang-cl`, `clang`, `gcc`, `nvcc`, `icx`,
 *   `icc`, `nvhpc`, `edg` or `unknown`
 */
export declare function compilerFamilyOfName(driver: string): string;
/**
 * The argument list of a database entry, with any compiler launcher
 * (`ccache`, `sccache`, ...) removed so the first argument is the compiler.
 *
 * @param {Object} entry Database entry
 * @returns {string[]} Arguments
 */
export declare function entryArguments(entry: Object): string[];
/**
 * The language a unit is compiled as: from `-x`/`/TP`/`/TC`, the driver
 * name, then the file extension.
 *
 * @param {string[]} args Arguments, compiler first
 * @param {string} file Translation unit
 * @returns {string} `c`, `c++`, `cuda` or `unknown`
 */
export declare function unitLanguage(args: string[], file: string): string;
/**
 * The include directories a unit is compiled with, as absolute paths.
 *
 * @param {string[]} args Arguments, compiler first
 * @param {string} directory The entry's working directory
 * @returns {string[]} Directories, in command order
 */
export declare function includeDirectories(args: string[], directory: string): string[];
/**
 * The security-hardening settings an argument list turns on or off. Later
 * options override earlier ones, as they do for the compiler.
 *
 * @param {string[]} args Compiler or linker arguments
 * @returns {Map<string, string>} Setting name to value:
 *   `fortifySource` (level), `stackProtector` (`on`, `strong`, `all`,
 *   `off`), `pie` (`on`/`off`), `relro` (`partial`/`full`, from `-z relro`
 *   and `-z now`), `cfProtection` (`full`, `branch`, `return`, `none`),
 *   `sanitizers` (comma-separated), `glibcxxAssertions` (`on`),
 *   `stackClashProtection` (`on`/`off`), `msvcBufferSecurityCheck` (`/GS`
 *   `on`/`off`), `msvcControlFlowGuard` (`on`/`off`)
 */
export declare function hardeningSettings(args: string[]): Map<string, string>;
/**
 * Summarise a compilation database.
 *
 * @param {Object[]} entries Parsed database (a JSON array)
 * @returns {{
 *   units: number,
 *   compilers: Map<string, {driver: string, family: string, units: number, languages: Set<string>}>,
 *   includeDirectories: Set<string>,
 *   hardening: Map<string, Map<string, number>>,
 * }} `compilers` is keyed by the driver as written; `hardening` maps each
 *   setting to the number of units per value
 */
export declare function summarizeCompileDatabase(entries: Object[]): {
    units: number;
    compilers: Map<string, {
        driver: string;
        family: string;
        units: number;
        languages: Set<string>;
    }>;
    includeDirectories: Set<string>;
    hardening: Map<string, Map<string, number>>;
};
/**
 * Read a compiler's family and version from what it prints for `--version`
 * (or, for MSVC, on start-up).
 *
 * @param {string} banner Output of the version query
 * @param {string} [nameFamily] Family implied by the driver's name
 * @returns {{family: string, version: string|undefined, edgFrontEnd: boolean}}
 */
export declare function classifyCompilerBanner(banner: string, nameFamily?: string): {
    family: string;
    version: string | undefined;
    edgFrontEnd: boolean;
};
//# sourceMappingURL=compileCommands.d.ts.map