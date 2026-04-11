export const DEFAULT_NPMRC_BLOCKLIST = new Set([
  "git",
  "script-shell",
  "shell",
  "call",
  "browser",
  "replace-registry-host",
  "node-gyp",
  "node-options",
  "bin-links",
  "install-links",
  "location",
  "userconfig",
  "globalconfig",
  "foreground-scripts",
  "rebuild-bundle",
]);

/**
 * Parse .npmrc content into a plain key-value object.
 *
 * @param {string} content - Raw .npmrc file content
 * @returns {Object} Parsed key-value pairs
 */
export function parseNpmrc(content) {
  const result = {};
  const lines = content.split(/\r\n|\r|\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }
    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) continue;
    let key = line.substring(0, eqIndex).trim();
    let value = line.substring(eqIndex + 1).trim();
    if (!key) continue;
    const isArray = key.endsWith("[]");
    if (isArray) {
      key = key.slice(0, -2);
    }
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (isArray) {
      if (!result[key]) result[key] = [];
      result[key].push(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

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
export function parseNpmrcFromEnv(env = process.env) {
  const result = {};
  const NPM_PREFIX = "npm_config_";
  const PNPM_PREFIX = "pnpm_config_";
  for (const prefix of [NPM_PREFIX, PNPM_PREFIX]) {
    for (const [fullKey, value] of Object.entries(env)) {
      if (!fullKey.toLowerCase().startsWith(prefix)) {
        continue;
      }
      let configKey = fullKey.slice(prefix.length);
      if (!configKey) continue;
      if (!configKey.startsWith("//") && !configKey.startsWith("@")) {
        configKey = configKey.toLowerCase();
      }
      result[configKey] = value === "" || value === undefined ? "true" : value;
    }
  }
  return result;
}
