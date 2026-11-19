/**
 * npmrc keys that are blocked and ignored during parsing for safety, because
 * they can influence command execution, shell spawning, or sensitive config
 * locations.
 *
 * @type {Set<string>}
 */
export declare const DEFAULT_NPMRC_BLOCKLIST: Set<string>;
/**
 * Proxy and TLS keys that belong to the operator. A project .npmrc outranks
 * the operator's user config, so a project that sets one of them could send
 * the operator's registry token through a proxy or to a certificate authority
 * of its choosing. cdxgen does not refuse such a project: it replaces the
 * values for the npm install (see npmOperatorConfigEnv).
 *
 * @type {Set<string>}
 */
export declare const OPERATOR_NPMRC_KEYS: Set<string>;
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
 * The keys on OPERATOR_NPMRC_KEYS are blocked too, unless
 * `options.operatorKeysReplaced` says the caller replaces them for the install.
 * Even then a registry or scope prefixed spelling stays blocked, because the
 * replacement covers only the plain setting.
 *
 * @param {string} key Key as returned by parseNpmrc
 * @param {Object} [options] Options
 * @param {boolean} [options.operatorKeysReplaced] The caller replaces the
 *   plain OPERATOR_NPMRC_KEYS settings for the install
 * @returns {boolean} true when npm may read the key as a blocked setting
 */
export declare function isBlockedNpmrcKey(key: string, options?: {
    operatorKeysReplaced?: boolean;
}): boolean;
/**
 * The OPERATOR_NPMRC_KEYS settings a .npmrc key can be read as, under any
 * spelling npm accepts.
 *
 * @param {string} key Key as returned by parseNpmrc
 * @returns {string[]} Plain setting names, empty for any other key
 */
export declare function operatorNpmrcKeys(key: string): string[];
/**
 * Environment variables that make npm use the operator's proxy and TLS
 * settings instead of the ones in a project .npmrc.
 *
 * npm reads `npm_config_*` variables above every .npmrc, and a command-line
 * option above the variables. A variable set to an empty string is ignored,
 * and `ca` cannot be reset to its default by any value. So for each setting
 * the project .npmrc names:
 *
 * - A variable the operator already exports is left alone.
 * - Otherwise the value from the operator's user .npmrc is exported.
 * - Otherwise the npm default is exported: `null` for `proxy` and
 *   `https-proxy`, `true` for `strict-ssl`.
 * - `ca` and `cafile` are handled together, because npm lets a non-empty
 *   `cafile` replace `ca`. The operator's `cafile` is used when there is one.
 *   When the operator has set only `ca`, `cafile` becomes `options.nullDevice`,
 *   an empty file that npm reads as no certificates. When the operator has set
 *   neither, `cafile` is the file that `options.defaultCaFile()` returns, which
 *   holds the certificate authorities Node.js trusts by default.
 *
 * @param {string[]} keys Settings named by the project .npmrc, from
 *   operatorNpmrcKeys
 * @param {Object} [options] Options
 * @param {Object} [options.env] Environment, defaulting to the process one
 * @param {Object} [options.userConfig] Parsed user .npmrc of the operator
 * @param {string} [options.nullDevice] Path npm reads as an empty file
 * @param {function(): string} [options.defaultCaFile] Returns the path of a
 *   PEM file with the default certificate authorities
 * @returns {Object} Variables to merge into the environment of npm
 */
export declare function npmOperatorConfigEnv(keys: string[], options?: {
    env?: Object;
    userConfig?: Object;
    nullDevice?: string;
}): Object;
/**
 * Parse .npmrc content into a plain key-value object.
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
/**
 * The certificate authorities Node.js trusts for this process, as PEM
 * strings, for use as the `cafile` of an npm that must not read the project's
 * `ca` settings. `tls.getCACertificates("default")` holds the bundled roots
 * and the file named by NODE_EXTRA_CA_CERTS; the system store is added when
 * the operator enabled it with `--use-system-ca` or NODE_USE_SYSTEM_CA=1.
 * Runtimes without getCACertificates (Bun, Deno) get `tls.rootCertificates`
 * plus the NODE_EXTRA_CA_CERTS file.
 *
 * @param {Object} [options] Options
 * @param {Object} [options.env] Environment, defaulting to the process one
 * @param {Object} [options.tlsModule] Module with the `node:tls` API
 * @returns {string[]} Certificates without duplicates
 */
export declare function defaultCaCertificates(options?: {
    env?: Object;
    tlsModule?: Object;
}): string[];
//# sourceMappingURL=npmrc.d.ts.map