/**
 * CLI argument → options conversion for cdxgen.
 *
 * Extracts the complex arg-to-options mapping from `bin/cdxgen.js` into
 * pure, testable functions with no side-effects (no process.exit, no
 * console output).
 *
 * Architecture note: This module is a helper and must NOT import from
 * `lib/cli/index.js` or `lib/stages/`. See AGENTS.md "Module layering
 * rules".
 *
 */
/**
 * Validate the `--spec-version` value against the v13 spec floor (1.6).
 *
 * Returns `null` when the value is an accepted generation target, or an
 * actionable error string when it is rejected. The error message for
 * sub-floor versions (1.4 / 1.5) explains that output downgrade still
 * exists, so users are not left without a migration path.
 *
 * @param {number} specVersion  The parsed `--spec-version` value.
 * @param {string} [commandName]  The invoked binary name for the message.
 * @returns {string|null}  Error message, or `null` when valid.
 */
export declare function validateSpecVersion(specVersion: number, commandName?: string): string | null;
/**
 * Check whether a value was explicitly provided by the user (i.e., is not
 * the yargs default). Yargs always populates default values, so we cannot
 * simply check for truthiness.
 *
 * We detect "user-provided" by checking whether the actual value differs
 * from the declared yargs default. This is robust for primitive types
 * (number, string, boolean) which is the case for all cdxgen CLI flags.
 *
 * @param {*} value    The value from the parsed args
 * @param {*} yaDefault The default declared in yargs `.option()`
 * @returns {boolean}  True when the user explicitly set this flag
 */
export declare function isUserProvided(value: any, yaDefault: any): boolean;
/**
 * The value the operator gave an option on the command line or through its
 * CDXGEN_* environment variable. yargs also fills options in from defaults
 * and from a config file, which cannot be told apart in its output.
 *
 * @param {string} option kebab-case option name
 * @param {object} [context]
 * @param {string[]} [context.argv] Raw command-line arguments
 * @param {object} [context.env] Environment variables
 * @param {boolean} [context.boolean] Read the option as a boolean flag
 * @returns {string|boolean|undefined} The operator's value, or undefined
 */
export declare function operatorOptionChoice(option: string, { argv, env, boolean }?: {
    argv?: string[];
    env?: object;
    boolean?: boolean;
}): string | boolean | undefined;
/**
 * Make the operator's choice about running the scanned project's own code
 * final. A config file is read from the working directory, which is usually
 * the scanned project, so it carries that project's trust. Neither the config
 * file nor a profile or lifecycle may turn installs on when the operator
 * disabled them, and secure mode keeps installs off unless the operator
 * passes --install-deps. Introspection keeps the project's build tools
 * running with installs off, which is likewise the operator's decision, so
 * introspection asked for only by the config file does not do that.
 *
 * **Mutates `options` in place.**
 *
 * @param {object} options The options object, after applyAdvancedOptions
 * @param {object} [context]
 * @param {object} [context.projectConfig] Sanitized config file contents
 * @param {boolean} [context.isSecureMode] Whether cdxgen runs in secure mode
 * @param {string[]} [context.argv] Raw command-line arguments
 * @param {object} [context.env] Environment variables
 * @returns {void}
 */
export declare function applyOperatorToolingChoice(options: object, context?: {
    projectConfig?: object;
    isSecureMode?: boolean;
    argv?: string[];
    env?: object;
}): void;
/**
 * Tell which of the options that expand into others the config file chose.
 * A profile or technique the operator did not give on the command line or
 * through its CDXGEN_* environment variable, but the config file sets, came
 * from the config file.
 *
 * @param {object} projectConfig Sanitized config file contents
 * @param {object} [context]
 * @param {string[]} [context.argv] Raw command-line arguments
 * @param {object} [context.env] Environment variables
 * @returns {{profileFromConfigFile: boolean, techniqueFromConfigFile: boolean}}
 */
export declare function configFileSelections(projectConfig: object, context?: {
    argv?: string[];
    env?: object;
}): {
    profileFromConfigFile: boolean;
    techniqueFromConfigFile: boolean;
};
/**
 * Mark the TEA servers that a config file named. The TEA token belongs to the
 * operator, while a config file is read from the working directory, usually
 * the scanned project, so a TEI to fetch or a server to publish to that only
 * the config file names is contacted without the token.
 *
 * **Mutates `options` in place.**
 *
 * @param {object} options The options object
 * @param {object} [context]
 * @param {object} [context.projectConfig] Sanitized config file contents
 * @param {string[]} [context.argv] Raw command-line arguments
 * @param {object} [context.env] Environment variables
 * @returns {string[]} The TEA options whose requests go without the token
 */
export declare function markConfigFileTeaTargets(options: object, context?: {
    projectConfig?: object;
    argv?: string[];
    env?: object;
}): string[];
/**
 * The options naming a slices file that atom, dosai and the other analyzers
 * write, and that a later step of the same run, or of a later run, reads back
 * as the project's evidence.
 */
export declare const SLICES_FILE_OPTIONS: string[];
/**
 * Find the slices files that already exist inside the scanned directory. A
 * run writes its slices files during generation, so one that exists before
 * it starts came with the scanned tree, and in secure mode it is not read
 * back as the project's evidence. A relative path is checked against both
 * the working directory and the scan path, since analyzers resolve it
 * against either.
 *
 * @param {object} options The options object
 * @param {object} context
 * @param {string} context.scanPath Directory being scanned
 * @param {string} [context.cwd] Working directory, process.cwd() when absent
 * @param {boolean} [context.isSecureMode] Whether cdxgen runs in secure mode
 * @returns {{option: string, path: string}[]} The slices files found, by
 *   option, empty outside secure mode
 */
export declare function findInTreeSlicesFiles(options: object, context: {
    scanPath: string;
    cwd?: string;
    isSecureMode?: boolean;
}): {
    option: string;
    path: string;
}[];
/**
 * Keep a config file from changing how an audit the operator asked for runs.
 * The config file is read from the working directory, usually the scanned
 * project, while the operator turns the audit on with --bom-audit or
 * CDXGEN_BOM_AUDIT. A profile can cancel the audit or strip the component
 * properties its rules read, and the bom-audit-* options narrow what it
 * checks, so neither is taken from the config file in that case. In secure
 * mode, where the audit gates the run, no bom-audit option, `bom-audit`
 * itself included, is taken from the config file.
 *
 * **Mutates `projectConfig` in place.**
 *
 * @param {object} projectConfig Sanitized config file contents
 * @param {object} [context]
 * @param {string[]} [context.argv] Raw command-line arguments
 * @param {object} [context.env] Environment variables
 * @param {boolean} [context.isSecureMode] Whether cdxgen runs in secure mode
 * @returns {string[]} The config keys that were removed
 */
export declare function dropConfigAuditOverrides(projectConfig: object, context?: {
    argv?: string[];
    env?: object;
    isSecureMode?: boolean;
}): string[];
/**
 * Combine the custom metadata properties of every source (discussion 4391):
 * the `--metadata-property` flag, the CDXGEN_METADATA_PROPERTY and
 * CDXGEN_METADATA_PROPERTIES environment variables, and a config file's
 * `metadata-property` or `metadataProperties` entry.
 *
 * yargs would let the highest-precedence source replace the others outright,
 * so each is read on its own and they are merged instead. A name set by more
 * than one source takes its values from the one that wins in the usual order
 * — the command line, then the environment, then the config file — while a
 * source may repeat a name for a multi-valued property.
 *
 * @param {object} args Parsed yargs argv
 * @param {object} [context]
 * @param {string[]} [context.argv] Raw command-line arguments, which tell a
 *   flag on the command line from one yargs filled in from elsewhere
 * @param {object} [context.projectConfig] The sanitized config file contents.
 *   Without it, a programmatic caller's `args` are taken as the config.
 * @returns {{name: string, value: string}[]} The merged properties
 */
export declare function resolveMetadataProperties(args: object, { argv, projectConfig }?: {
    argv?: string[];
    projectConfig?: object;
}): {
    name: string;
    value: string;
}[];
/**
 * Apply command-name-based defaults to the raw parsed args. When cdxgen is
 * invoked via a symlink or alias (e.g. `obom`, `cbom`, `spdxgen`, `aibom`),
 * certain args receive implicit values.
 *
 * **Pure function** — returns a shallow copy of `args` with mutations; the
 * original `args` object is not modified.
 *
 * @param {object} args               Parsed yargs argv
 * @param {string} invokedCommandName Binary name without extension
 * @returns {object} A shallow copy of args with alias-based defaults applied
 */
export declare function applyCommandNameDefaults(args: object, invokedCommandName: string): object;
export declare function buildInitialOptions(args: any, { filePath, isRemoteOrPurl, argv, projectConfig }: {
    argv?: any;
    filePath: any;
    isRemoteOrPurl: any;
    projectConfig: any;
}): any;
export type OptionsWarning = {
    /**
     * Severity level
     */
    level: "info" | "warn" | "error";
    /**
     * Human-readable description
     */
    message: string;
};
/**
 * @typedef {object} OptionsWarning
 * @property {"info"|"warn"|"error"} level   Severity level
 * @property {string}                message Human-readable description
 */
/**
 * Apply command-specific, standard, and security overrides to the options
 * object. This covers:
 *
 * - Dedup of `projectType`
 * - `cbom` / `saasbom` command overrides
 * - `cdxgen-secure` mode
 * - Dry-run mode
 * - Standards-driven specVersion default
 * - HBOM formulation suppression
 *
 * **Mutates `options` in place** and returns a list of warnings that the
 * caller should surface to the user (e.g. via `console.warn`).
 *
 * @param {object} options               The options object from Phase 2
 * @param {object} context
 * @param {string} context.invokedCommandName  Binary name (e.g. "cbom")
 * @param {boolean} context.userSetSpecVersion True when the user explicitly
 *                                             passed `--spec-version`
 * @param {boolean} [context.isDryRun=false]   Current dry-run state
 * @returns {OptionsWarning[]} Warnings to surface to the user
 */
export declare function applyPostConstructionOverrides(options: object, context: {
    invokedCommandName: string;
    userSetSpecVersion: boolean;
    isDryRun?: boolean;
}): OptionsWarning[];
/**
 * Apply advanced option expansion based on `profile`, `lifecycle`, and
 * `technique` settings. This is the extracted form of the
 * `applyAdvancedOptions()` function that was previously inline in
 * `bin/cdxgen.js`.
 *
 * **Mutates `options` in place.**
 *
 * Design note: Several profiles unconditionally override user flags like
 * `deep`, `evidence`, and `installDeps`. This is intentional — the profile
 * is a "meta-flag" that sets a curated combination. When users select a
 * profile, they opt into its opinionated defaults.
 *
 * @param {object} options    The options object
 * @param {object} [context]
 * @param {boolean} [context.isSecureMode]  Whether cdxgen runs in secure mode
 * @param {string} [context.invokedCommandName] Binary name (e.g. "cbom"),
 *                                              which can turn on formulation
 * @param {boolean} [context.profileFromConfigFile] The profile came from a
 *   config file, so it neither turns on evidence nor adds a project type
 *   that inventories the host
 * @param {boolean} [context.techniqueFromConfigFile] The technique came from
 *   a config file, so it does not turn on evidence
 * @returns {OptionsWarning[]} Warnings for the caller
 */
export declare function applyAdvancedOptions(options: object, context?: {
    isSecureMode?: boolean;
    invokedCommandName?: string;
    profileFromConfigFile?: boolean;
    techniqueFromConfigFile?: boolean;
}): OptionsWarning[];
/**
 * Build the complete `options` object from parsed CLI arguments.
 *
 * This is the single entry point that replaces the ~330 lines of inline
 * imperative code in `bin/cdxgen.js`. It orchestrates all four phases:
 *
 * 1. Command-name alias expansion
 * 2. Initial options construction (field renames, derived values)
 * 3. Post-construction overrides (dedup, command flags, specVersion)
 * 4. Advanced options (profile, lifecycle, technique)
 *
 * Returns both the options object and a list of warnings that the caller
 * (typically `bin/cdxgen.js`) should surface to the user.
 *
 * @param {object} args               Raw parsed yargs argv
 * @param {object} context
 * @param {string} context.invokedCommandName  Binary name without extension
 * @param {string} context.filePath            Resolved source path
 * @param {boolean} context.isRemoteOrPurl     True for URL/purl sources
 * @param {boolean} context.userSetSpecVersion True when the user explicitly
 *                                             passed `--spec-version`
 * @param {boolean} [context.isDryRun=false]   Dry-run mode
 * @param {boolean} [context.isSecureMode]     Secure mode
 * @param {object} [context.projectConfig]     Sanitized config file contents,
 *                                             whose metadata properties merge
 *                                             with the other sources'
 * @param {string[]} [context.argv]            Raw command-line arguments,
 *                                             process.argv when absent
 * @param {object} [context.env]               The environment the operator
 *                                             launched cdxgen with,
 *                                             process.env when absent
 * @returns {{ options: object, warnings: OptionsWarning[] }}
 */
export declare function buildOptionsFromArgs(args: object, context: {
    invokedCommandName: string;
    filePath: string;
    isRemoteOrPurl: boolean;
    userSetSpecVersion: boolean;
    isDryRun?: boolean;
    isSecureMode?: boolean;
    projectConfig?: object;
    argv?: string[];
    env?: object;
}): {
    options: object;
    warnings: OptionsWarning[];
};
//# sourceMappingURL=cliOptions.d.ts.map