import { realpathSync } from "node:fs";
import path from "node:path";

import { boundUntrustedGlobPatterns } from "./globPatterns.js";
import { HOST_SCOPE_PROJECT_TYPES, toCamel } from "./utils.js";

/**
 * Config file names cdxgen reads from the directory it is invoked in.
 */
export const PROJECT_CONFIG_FILENAMES = [
  ".cdxgenrc",
  ".cdxgen.json",
  ".cdxgen.yml",
  ".cdxgen.yaml",
];

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
export const PROJECT_CONFIG_OPTIONS = new Set([
  "activity-report",
  "api-key",
  "author",
  "auto-compositions",
  "auto-create",
  "bom-audit",
  "bom-audit-categories",
  "bom-audit-fail-severity",
  "bom-audit-include-trusted",
  "bom-audit-max-targets",
  "bom-audit-min-severity",
  "bom-audit-only-trusted",
  "bom-audit-rules-dir",
  "bom-audit-scope",
  "component-type",
  "data-flow-slices-file",
  "deep",
  "deps-slices-file",
  "dry-run",
  "env-audit",
  "evidence",
  "evinse-output",
  "exclude",
  "exclude-type",
  "export-proto",
  "fail-on-error",
  "filter",
  "format",
  "generate-key-and-sign",
  "git-branch",
  "include-crypto",
  "include-formulation",
  "include-regex",
  "include-release-notes",
  "include-runtime",
  "install-deps",
  "is-latest",
  "json-pretty",
  "license-policy",
  "license-ref",
  "lifecycle",
  "min-confidence",
  "no-babel",
  "no-banner",
  "no-ignore",
  "only",
  "openapi-spec-file",
  "output",
  "parent-project-id",
  "parent-project-name",
  "parent-project-version",
  "print",
  "profile",
  "project-group",
  "project-id",
  "project-name",
  "project-tag",
  "project-version",
  "proto-bin-file",
  "reachables-slices-file",
  "recurse",
  "release-notes-current-tag",
  "release-notes-previous-tag",
  "required-only",
  "resolve-class",
  "semantics-slices-file",
  "server-url",
  "spec-version",
  "standard",
  "technique",
  "tlp-classification",
  "tui",
  "type",
  "usages-slices-file",
  "validate",
]);

/**
 * Options only the operator may set, on the command line or through a
 * CDXGEN_* environment variable. They start a listener, turn off certificate
 * checks on the operator's own upload, opt into experimental tool
 * installation, or end the run without a BOM. A config file that sets one is
 * told so and ignored.
 */
export const OPERATOR_ONLY_OPTIONS = new Set([
  "feature-flags",
  "help",
  "server",
  "server-host",
  "server-port",
  "skip-dt-tls-check",
]);

/**
 * Alternate option names a config file may use, with the option each one
 * stands for. yargs applies its aliases to config keys too, so each is
 * checked as the option it names.
 */
export const PROJECT_CONFIG_OPTION_ALIASES = new Map([
  ["c", "resolve-class"],
  ["exclude-regex", "exclude"],
  ["h", "help"],
  ["o", "output"],
  ["p", "print"],
  ["r", "recurse"],
  ["t", "type"],
]);

/**
 * Options whose values name a file or directory cdxgen writes to or reads
 * from. A config file may set these, but only to a location inside its own
 * directory, after symbolic links are resolved.
 */
const PATH_OPTIONS = new Set([
  "output",
  "evinse-output",
  "proto-bin-file",
  "deps-slices-file",
  "usages-slices-file",
  "data-flow-slices-file",
  "reachables-slices-file",
  "semantics-slices-file",
  "openapi-spec-file",
  "license-policy",
  "bom-audit-rules-dir",
]);

/**
 * Options whose values are glob patterns matched against every file a scan
 * walks, in the order they draw on the shared expansion budget.
 */
const PATTERN_OPTIONS = ["exclude", "include-regex"];

/**
 * Options that change where cdxgen sends data or how much of the host it
 * touches. These stay usable, but never silently.
 */
const ANNOUNCED_OPTIONS = new Set([
  "server-url",
  "api-key",
  "include-formulation",
  "install-deps",
  "deep",
]);

/**
 * Both spellings a config file may use for an option.
 *
 * @param {string} option kebab-case option name
 * @returns {string[]} kebab-case and camelCase spellings
 */
function optionSpellings(option) {
  const camel = toCamel(option);
  return camel === option ? [option] : [option, camel];
}

/**
 * Find the option a config key names.
 *
 * @param {string} key config file key
 * @returns {string|undefined} kebab-case option name, or undefined when the
 *   key is not the kebab-case spelling, the camelCase spelling or an alias of
 *   an option cdxgen declares
 */
function configKeyOption(key) {
  if (PROJECT_CONFIG_OPTION_ALIASES.has(key)) {
    return PROJECT_CONFIG_OPTION_ALIASES.get(key);
  }
  const kebab = key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  if (!PROJECT_CONFIG_OPTIONS.has(kebab) && !OPERATOR_ONLY_OPTIONS.has(kebab)) {
    return undefined;
  }
  return optionSpellings(kebab).includes(key) ? kebab : undefined;
}

/**
 * Resolve a path through the symbolic links of its longest existing prefix.
 * The part that does not exist yet is appended unchanged.
 *
 * @param {string} absolutePath absolute path to resolve
 * @returns {string} the path with every existing component resolved
 */
function resolveExistingPrefix(absolutePath) {
  const missing = [];
  let current = absolutePath;
  for (;;) {
    try {
      return path.join(realpathSync(current), ...missing.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return absolutePath;
      }
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Determine whether a config-supplied path stays inside the config's own
 * directory once symbolic links are resolved, so a link committed to the
 * scanned tree cannot carry a path option outside it.
 *
 * @param {string} configDir directory the config file was read from
 * @param {unknown} value config-supplied path value
 * @returns {boolean} true when the path resolves inside configDir
 */
function isContainedPath(configDir, value) {
  if (typeof value !== "string" || !value.length) {
    return false;
  }
  const root = resolveExistingPrefix(path.resolve(configDir));
  const target = resolveExistingPrefix(path.resolve(configDir, value));
  const relativePath = path.relative(root, target);
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath))
  );
}

/**
 * Split a config-supplied project type value into the individual types.
 *
 * @param {unknown} value `type` value from a config file
 * @returns {string[]} trimmed, non-empty project types
 */
function projectTypeList(value) {
  return (Array.isArray(value) ? value : [value])
    .flatMap((entry) => `${entry ?? ""}`.split(","))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

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
export function sanitizeProjectConfig(config, configDir) {
  const result = {
    announced: [],
    config: {},
    hostScopeTypes: [],
    ignored: [],
    operatorOnly: [],
    refusedPatterns: [],
    rejected: [],
  };
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return result;
  }
  const sanitized = result.config;
  const aliasEntries = [];
  for (const [key, value] of Object.entries(config)) {
    const option = configKeyOption(key);
    if (!option) {
      result.ignored.push(key);
      continue;
    }
    if (OPERATOR_ONLY_OPTIONS.has(option)) {
      result.operatorOnly.push(key);
      continue;
    }
    if (PROJECT_CONFIG_OPTION_ALIASES.has(key)) {
      aliasEntries.push([option, value]);
      continue;
    }
    sanitized[key] = value;
  }
  // An alias is stored under the option it names, so the checks below see
  // it. A spelled-out option in the same file takes precedence.
  for (const [option, value] of aliasEntries) {
    if (optionSpellings(option).every((key) => sanitized[key] === undefined)) {
      sanitized[option] = value;
    }
  }
  for (const option of PATH_OPTIONS) {
    for (const key of optionSpellings(option)) {
      if (sanitized[key] === undefined) {
        continue;
      }
      if (!isContainedPath(configDir, sanitized[key])) {
        result.rejected.push(`${key}=${sanitized[key]}`);
        delete sanitized[key];
      }
    }
  }
  if (sanitized.type !== undefined) {
    const types = projectTypeList(sanitized.type);
    const projectTypes = types.filter(
      (type) => !HOST_SCOPE_PROJECT_TYPES.has(type.toLowerCase()),
    );
    result.hostScopeTypes = types.filter(
      (type) => !projectTypes.includes(type),
    );
    if (result.hostScopeTypes.length) {
      if (projectTypes.length) {
        sanitized.type = projectTypes;
      } else {
        delete sanitized.type;
      }
    }
  }
  // Exclude patterns, then include patterns, share one expansion budget.
  let patternsUsed = 0;
  for (const option of PATTERN_OPTIONS) {
    for (const key of optionSpellings(option)) {
      if (sanitized[key] === undefined) {
        continue;
      }
      const { accepted, expansions, refused } = boundUntrustedGlobPatterns(
        sanitized[key],
        { used: patternsUsed },
      );
      patternsUsed += expansions;
      for (const entry of refused) {
        result.refusedPatterns.push({ key, ...entry });
      }
      if (!refused.length) {
        continue;
      }
      if (!accepted.length) {
        delete sanitized[key];
      } else {
        sanitized[key] = Array.isArray(sanitized[key]) ? accepted : accepted[0];
      }
    }
  }
  for (const option of ANNOUNCED_OPTIONS) {
    for (const key of optionSpellings(option)) {
      if (sanitized[key] !== undefined) {
        result.announced.push(key);
      }
    }
  }
  return result;
}
