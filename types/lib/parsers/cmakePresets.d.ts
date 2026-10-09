/**
 * Pure reader for CMake presets (`CMakePresets.json` and
 * `CMakeUserPresets.json`, schema versions 1 to 10).
 *
 * A configure preset names how a project is configured: the generator, the
 * build directory, the toolchain file and the cache variables (build type,
 * compilers). Presets inherit from one another, may be hidden (templates
 * that only exist to be inherited), may be enabled only under a condition,
 * and spell paths with macros such as `${sourceDir}` and `$env{NAME}`.
 *
 * This module is layer 1: text and a context object in, data out. Reading the
 * files (and their `include` lists) is done by the caller, which also supplies
 * the process environment through `context.penv`.
 */
/**
 * Parse the text of a presets file.
 *
 * @param {string} text File contents
 * @returns {{version: number|undefined, include: string[], configurePresets: Object[]}|null}
 *   `null` when the text is not a presets document
 */
export declare function parseCmakePresets(text: string): {
    version: number | undefined;
    include: string[];
    configurePresets: Object[];
} | null;
/**
 * Expand the macros CMake allows in preset strings.
 *
 * Supported: `${sourceDir}`, `${sourceParentDir}`, `${sourceDirName}`,
 * `${presetName}`, `${generator}`, `${hostSystemName}`, `${fileDir}`,
 * `${dollar}`, `${pathListSep}`, `$env{NAME}` (the preset's own environment,
 * then the process environment) and `$penv{NAME}` (the process environment).
 * `$vendor{...}` and unknown macros are left as written.
 *
 * @param {string} value String to expand
 * @param {Object} context Macro values; `env` (preset environment, a plain
 *   object) and `penv` (a function reading the process environment) are
 *   optional
 * @returns {string} Expanded string
 */
export declare function expandPresetMacros(value: string, context?: Object): string;
/**
 * Evaluate a preset condition (schema version 3 and later).
 *
 * @param {*} condition Condition object (or boolean, or null)
 * @param {function(string): string} expand Macro expander for the preset
 * @returns {boolean|undefined} `undefined` when the condition cannot be
 *   decided here: `matches`/`notMatches` take a regular expression from the
 *   repository, which is not run
 */
export declare function evaluatePresetCondition(condition: any, expand: Function): boolean | undefined;
/**
 * Resolve the configure presets of a set of presets documents.
 *
 * Inheritance follows CMake: a preset's own fields win, then those of its
 * `inherits` entries in order (the first wins), recursively; `cacheVariables`
 * and `environment` merge key by key the same way, and a `null` entry unsets
 * the key. `name`, `hidden`, `inherits`, `description` and `displayName` are
 * not inherited. A preset that is part of an inheritance cycle, or inherits
 * one that does not exist, is dropped.
 *
 * @param {Array<{file: string, fileDir: string, document: Object}>} documents
 *   Parsed documents in reading order (`CMakePresets.json` first, then its
 *   includes, then `CMakeUserPresets.json`)
 * @param {Object} context `sourceDir`, `hostSystemName`, `pathListSep`, and
 *   `penv` (a function reading the process environment)
 * @returns {Object[]} Visible configure presets: `name`, `displayName`,
 *   `file`, `inherits`, `generator`, `binaryDir` (absolute), `toolchainFile`,
 *   `cacheVariables` (expanded strings), `environment` (expanded strings),
 *   `hasCondition`, and `conditionMet` (true, false or undefined)
 */
export declare function resolveConfigurePresets(documents: Array<{
    file: string;
    fileDir: string;
    document: Object;
}>, context?: Object): Object[];
//# sourceMappingURL=cmakePresets.d.ts.map