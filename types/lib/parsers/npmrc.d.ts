/**
 * Parse .npmrc content into a plain key-value object.
 *
 * @param {string} content - Raw .npmrc file content
 * @returns {Object} Parsed key-value pairs
 */
export function parseNpmrc(content: string): Object;
/**
 * Extract npm configuration values from environment variables.
 * See https://docs.npmjs.com/cli/v11/using-npm/config
 *
 * npm uses the NPM_CONFIG_ prefix for env var config:
 * - Dashes become underscores: --allow-same-version → npm_config_allow_same_version
 * - Case-insensitive prefix matching: NPM_CONFIG_FOO = npm_config_foo
 * - Simple keys are lowercased; scoped/URI keys preserve case
 * - Boolean flags without values are treated as true
 *
 * @param {Object} env - Environment variables object (defaults to process.env)
 * @returns {Object} Parsed npm config key-value pairs
 */
export function parseNpmrcFromEnv(env?: Object): Object;
export const DEFAULT_NPMRC_BLOCKLIST: Set<string>;
//# sourceMappingURL=npmrc.d.ts.map