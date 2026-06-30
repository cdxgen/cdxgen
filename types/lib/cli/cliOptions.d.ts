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
export function isUserProvided(value: any, yaDefault: any): boolean;
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
export function applyCommandNameDefaults(args: object, invokedCommandName: string): object;
/**
 * Build the initial `options` object from parsed CLI args. This performs
 * the field renames and derived-value computations that create the shape
 * expected by `createBom`.
 *
 * @param {object} args               Parsed yargs argv (after command-name
 *                                    defaults have been applied)
 * @param {object} context
 * @param {string} context.filePath          Resolved source path
 * @param {boolean} context.isRemoteOrPurl   True when source is a URL or purl
 * @returns {object} The initial options object
 */
export function buildInitialOptions(args: object, { filePath, isRemoteOrPurl }: {
    filePath: string;
    isRemoteOrPurl: boolean;
}): object;
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
export function applyPostConstructionOverrides(options: object, context: {
    invokedCommandName: string;
    userSetSpecVersion: boolean;
    isDryRun?: boolean | undefined;
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
 * @returns {OptionsWarning[]} Warnings for the caller
 */
export function applyAdvancedOptions(options: object, context?: {
    isSecureMode?: boolean | undefined;
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
 * @returns {{ options: object, warnings: OptionsWarning[] }}
 */
export function buildOptionsFromArgs(args: object, context: {
    invokedCommandName: string;
    filePath: string;
    isRemoteOrPurl: boolean;
    userSetSpecVersion: boolean;
    isDryRun?: boolean | undefined;
    isSecureMode?: boolean | undefined;
}): {
    options: object;
    warnings: OptionsWarning[];
};
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
//# sourceMappingURL=cliOptions.d.ts.map