/**
 * Config file names cdxgen reads from the directory it is invoked in.
 */
export declare const PROJECT_CONFIG_FILENAMES: string[];
/**
 * Options a config file may set, by their kebab-case name. A config file may
 * also use the camelCase spelling of each, or one of the aliases in
 * PROJECT_CONFIG_OPTION_ALIASES. Every other key is ignored: options that
 * only library callers pass (such as `dosaiCommand` or `traceCmd`), yargs'
 * own `extends`, and anything cdxgen does not know.
 *
 * Every option bin/cdxgen.js declares is either here or in
 * OPERATOR_ONLY_OPTIONS, which projectConfig.poku.js checks.
 */
export declare const PROJECT_CONFIG_OPTIONS: Set<string>;
/**
 * Options only the operator may set, on the command line or through a
 * CDXGEN_* environment variable. They start a listener, turn off certificate
 * checks on the operator's own upload, opt into experimental tool
 * installation, or end the run without a BOM. A config file that sets one is
 * told so and ignored. Evidence collection hands project-named values to
 * atom and its helpers, so it is not the scanned project's to choose either.
 */
export declare const OPERATOR_ONLY_OPTIONS: Set<string>;
/**
 * Alternate option names a config file may use, with the option each one
 * stands for. yargs applies its aliases to config keys too, so each is
 * checked as the option it names.
 */
export declare const PROJECT_CONFIG_OPTION_ALIASES: Map<string, string>;
/**
 * Apply the trust boundary between cdxgen and the directory it is scanning.
 *
 * A config file lives in the tree under analysis, so it is attacker-controlled
 * whenever that tree is. It may therefore only set the options listed in
 * PROJECT_CONFIG_OPTIONS: options that start a listener or weaken the
 * operator's own checks, and every key cdxgen does not declare as an option,
 * such as the analyzer commands library callers pass, are dropped. Path options are confined to the config's own
 * directory - a scanned project may choose where in itself the BOM lands, but
 * not write outside it - and project types that inventory the host rather
 * than the scan path are dropped. Exclude and include patterns are kept
 * within the bounds of boundUntrustedGlobPatterns, so a project cannot make
 * every file match against thousands of brace-expanded patterns. Options that
 * redirect data off the host or widen what cdxgen does are announced on the
 * console.
 *
 * @param {Object} config parsed config file contents
 * @param {string} configDir directory the config file was read from
 * @returns {{config: Object, rejected: string[], announced: string[], ignored: string[], operatorOnly: string[], hostScopeTypes: string[], refusedPatterns: {key: string, pattern: string, reason: string}[]}} sanitized config and what it did
 */
export declare function sanitizeProjectConfig(config: Object, configDir: string): {
    config: Object;
    rejected: string[];
    announced: string[];
    ignored: string[];
    operatorOnly: string[];
    hostScopeTypes: string[];
    refusedPatterns: {
        key: string;
        pattern: string;
        reason: string;
    }[];
};
//# sourceMappingURL=projectConfig.d.ts.map