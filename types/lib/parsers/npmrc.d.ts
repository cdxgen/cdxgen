/**
 * npmrc keys that are blocked and ignored during parsing for safety, because
 * they can influence command execution, shell spawning, or sensitive config
 * locations.
 *
 * @type {Set<string>}
 */
export declare const DEFAULT_NPMRC_BLOCKLIST: Set<string>;
/**
 * The names npm may read a .npmrc key as. npm unquotes a key (a double-quoted
 * key is JSON-decoded), cuts an unquoted one at an unescaped `;` or `#`,
 * resolves backslash escapes and expands `${NAME}` and `${NAME?}` from the
 * environment, so the text before `=` is not always the key that applies. A
 * `${NAME}` is expanded both from the environment and to nothing, because an
 * unset optional variable is empty.
 *
 * @param {string} rawKey Key as written before the `=`
 * @param {Object} [env] Environment used to expand variables, defaulting to
 *   the process environment
 * @returns {string[]} Candidate key names, the raw key first
 */
export declare function npmrcKeyCandidates(rawKey: string, env?: Object): string[];
/**
 * Whether a .npmrc key names a setting on DEFAULT_NPMRC_BLOCKLIST under any
 * spelling npm accepts. A registry or scope prefix before the key is ignored.
 *
 * @param {string} key Key as returned by parseNpmrc
 * @returns {boolean} true when npm may read the key as a blocked setting
 */
export declare function isBlockedNpmrcKey(key: string): boolean;
/**
 * Parse .npmrc content into a plain key-value object.
 *
 * Keys that collide with JavaScript object internals are skipped: assigning
 * them on a plain object either silently mutates Object.prototype semantics or,
 * for the array syntax, crashed the parser with a TypeError because
 * `result.__proto__` resolves to Object.prototype instead of an own property.
 *
 * @param {string} content - Raw .npmrc file content
 * @returns {Object} Parsed key-value pairs
 */
export declare function parseNpmrc(content: string): Object;
/**
 * Extract npm/pnpm configuration values from environment variables.
 * See https://docs.npmjs.com/cli/v11/using-npm/config
 *
 * npm uses the NPM_CONFIG_ prefix for env var config:
 * - Dashes become underscores: --allow-same-version → npm_config_allow_same_version
 * - Case-insensitive prefix matching: NPM_CONFIG_FOO = npm_config_foo
 * - Simple keys are lowercased; scoped/URI keys preserve case
 * - Boolean flags without values are treated as true
 *
 * pnpm v11+ uses the PNPM_CONFIG_ prefix instead of NPM_CONFIG_ for pnpm-specific settings.
 *   Both prefixes are supported; pnpm_config_* takes precedence over npm_config_* for the same key.
 *   See https://pnpm.io/next/npmrc
 * @param {Object} env - Environment variables object (defaults to process.env)
 * @returns {Object} Parsed npm config key-value pairs
 */
export declare function parseNpmrcFromEnv(env?: Object): Object;
//# sourceMappingURL=npmrc.d.ts.map