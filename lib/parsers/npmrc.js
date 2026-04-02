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
export function parseNpmrcFromEnv(env = process.env) {
  const result = {};
  const PREFIX = "npm_config_";

  for (const [fullKey, value] of Object.entries(env)) {
    if (!fullKey.toLowerCase().startsWith(PREFIX)) {
      continue;
    }

    let configKey = fullKey.slice(PREFIX.length);
    if (!configKey) continue;
    if (!configKey.startsWith("//") && !configKey.startsWith("@")) {
      configKey = configKey.toLowerCase();
    }
    result[configKey] = value === "" || value === undefined ? "true" : value;
  }
  return result;
}
