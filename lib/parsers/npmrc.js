import { readFileSync } from "node:fs";
import tls from "node:tls";

import { readEnvironmentVariable } from "../helpers/utils.js";

/**
 * npmrc keys that are blocked and ignored during parsing for safety, because
 * they can influence command execution, shell spawning, or sensitive config
 * locations.
 *
 * @type {Set<string>}
 */
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
  "global",
  "prefix",
  "userconfig",
  "globalconfig",
  "foreground-scripts",
  "rebuild-bundle",
]);

/**
 * Proxy and TLS keys that belong to the operator. A project .npmrc outranks
 * the operator's user config, so a project that sets one of them could send
 * the operator's registry token through a proxy or to a certificate authority
 * of its choosing. cdxgen does not refuse such a project: it replaces the
 * values for the npm install (see npmOperatorConfigEnv).
 *
 * @type {Set<string>}
 */
export const OPERATOR_NPMRC_KEYS = new Set([
  "proxy",
  "https-proxy",
  "cafile",
  "ca",
  "strict-ssl",
]);

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
export function npmrcKeyCandidates(rawKey, env = undefined) {
  const candidates = new Set([rawKey]);
  let decoded = String(rawKey).trim();
  if (
    decoded.length >= 2 &&
    (decoded.startsWith('"') || decoded.startsWith("'")) &&
    decoded.endsWith(decoded[0])
  ) {
    const inner = decoded.slice(1, -1);
    try {
      decoded = decoded.startsWith('"') ? JSON.parse(decoded) : inner;
    } catch {
      decoded = inner;
    }
  } else {
    let unquoted = "";
    for (let i = 0; i < decoded.length; i++) {
      const ch = decoded[i];
      if (ch === "\\" && i + 1 < decoded.length) {
        unquoted += decoded[i + 1];
        i++;
      } else if (ch === ";" || ch === "#") {
        break;
      } else {
        unquoted += ch;
      }
    }
    decoded = unquoted.trim();
  }
  if (typeof decoded !== "string") {
    return [...candidates];
  }
  candidates.add(decoded);
  if (decoded.includes("${")) {
    const expand = (replacement) =>
      decoded.replace(/\$\{([^}?]{0,256})\??\}/g, (_m, name) =>
        replacement(name),
      );
    candidates.add(expand(() => ""));
    candidates.add(
      expand((name) => (env ? env[name] : readEnvironmentVariable(name)) ?? ""),
    );
  }
  return [...candidates];
}

/**
 * The setting name of a registry (`//host/path/:name`) or scope (`@scope:name`)
 * prefixed key, or the key itself when it has no prefix.
 *
 * @param {string} key Candidate key name
 * @returns {string} Key without its prefix
 */
function npmrcBaseKey(key) {
  if (key.startsWith("//")) {
    const index = key.lastIndexOf("/:");
    return index === -1 ? key : key.slice(index + 2);
  }
  if (key.startsWith("@")) {
    const index = key.indexOf(":");
    return index === -1 ? key : key.slice(index + 1);
  }
  return key;
}

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
export function isBlockedNpmrcKey(key, options = {}) {
  for (const candidate of npmrcKeyCandidates(key)) {
    const baseKey = npmrcBaseKey(candidate);
    if (
      DEFAULT_NPMRC_BLOCKLIST.has(baseKey) ||
      DEFAULT_NPMRC_BLOCKLIST.has(candidate)
    ) {
      return true;
    }
    if (
      OPERATOR_NPMRC_KEYS.has(baseKey) &&
      (!options.operatorKeysReplaced || baseKey !== candidate)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The OPERATOR_NPMRC_KEYS settings a .npmrc key can be read as, under any
 * spelling npm accepts.
 *
 * @param {string} key Key as returned by parseNpmrc
 * @returns {string[]} Plain setting names, empty for any other key
 */
export function operatorNpmrcKeys(key) {
  const found = new Set();
  for (const candidate of npmrcKeyCandidates(key)) {
    if (OPERATOR_NPMRC_KEYS.has(candidate)) {
      found.add(candidate);
    }
  }
  return [...found];
}

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
export function npmOperatorConfigEnv(keys, options = {}) {
  const env = options.env ?? process.env;
  const userConfig = options.userConfig ?? {};
  const overrides = {};
  const operatorEnv = new Set();
  for (const [name, value] of Object.entries(env)) {
    if (/^npm_config_/i.test(name) && value !== "" && value !== undefined) {
      operatorEnv.add(
        name.slice("npm_config_".length).replace(/_/g, "-").toLowerCase(),
      );
    }
  }
  const userValue = (key) => {
    const value = userConfig[key];
    if (Array.isArray(value)) {
      return value.join("\n\n");
    }
    return value === undefined || value === "" ? undefined : String(value);
  };
  const variable = (key) => `npm_config_${key.replace(/-/g, "_")}`;
  const pin = (key, defaultValue) => {
    if (operatorEnv.has(key)) {
      return;
    }
    overrides[variable(key)] = userValue(key) ?? defaultValue;
  };
  const wanted = new Set(keys);
  if (wanted.has("proxy")) {
    pin("proxy", "null");
  }
  if (wanted.has("https-proxy")) {
    pin("https-proxy", "null");
  }
  if (wanted.has("strict-ssl")) {
    pin("strict-ssl", "true");
  }
  if (wanted.has("ca") || wanted.has("cafile")) {
    const operatorHasCa =
      operatorEnv.has("ca") || userValue("ca") !== undefined;
    if (userValue("ca") !== undefined) {
      pin("ca");
    }
    if (!operatorEnv.has("cafile")) {
      if (userValue("cafile") !== undefined) {
        pin("cafile");
      } else if (operatorHasCa) {
        overrides[variable("cafile")] = options.nullDevice;
      } else if (options.defaultCaFile) {
        overrides[variable("cafile")] = options.defaultCaFile();
      }
    }
  }
  return overrides;
}

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
export function defaultCaCertificates(options = {}) {
  const env = options.env ?? process.env;
  const tlsModule = options.tlsModule ?? tls;
  const certificates = [];
  if (typeof tlsModule.getCACertificates === "function") {
    certificates.push(...tlsModule.getCACertificates("default"));
    const useSystem =
      /(?:^|\s)--use-system-ca(?:\s|$)/u.test(env.NODE_OPTIONS ?? "") ||
      env.NODE_USE_SYSTEM_CA === "1";
    if (useSystem) {
      certificates.push(...tlsModule.getCACertificates("system"));
    }
  } else {
    certificates.push(...(tlsModule.rootCertificates ?? []));
    const extra = env.NODE_EXTRA_CA_CERTS;
    if (extra) {
      try {
        const pem = readFileSync(extra, "utf-8");
        const delimiter = "-----END CERTIFICATE-----";
        for (const section of pem.split(delimiter)) {
          if (section.trim()) {
            certificates.push(`${section.trim()}\n${delimiter}\n`);
          }
        }
      } catch (_err) {
        // An unreadable extra file adds nothing, as it does for Node.js.
      }
    }
  }
  return [...new Set(certificates)];
}
