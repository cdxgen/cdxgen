import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

import {
  HOST_SCOPE_PROJECT_TYPES,
  isVersionedJvmToolProjectType,
  PROJECT_TYPE_ALIASES,
} from "./env.js";
import {
  boundUntrustedGlobPatterns,
  UNTRUSTED_FILTER_TERM_LIMIT,
} from "./globPatterns.js";
import {
  isReservedMetadataPropertyName,
  METADATA_PROPERTY_CONFIG_KEYS,
  parseMetadataProperties,
} from "./metadataProperties.js";
import { toCamel } from "./paths.js";

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
  "cache",
  "cache-ttl",
  "caxa-app-dir",
  "cmake-cache",
  "color",
  "compile-commands",
  "component-type",
  "deep",
  "dry-run",
  "env-audit",
  "evinse-output",
  "exclude",
  "exclude-type",
  "experimental-mcp-pinning",
  "export-proto",
  "fail-on-error",
  "filter",
  "format",
  "git-branch",
  "include-crypto",
  "include-formulation",
  "include-regex",
  "include-release-notes",
  "include-runtime",
  "install-deps",
  "introspect",
  "introspect-annotate",
  "introspect-fail-below",
  "introspect-json",
  "introspect-report",
  "is-latest",
  "json-pretty",
  "license-policy",
  "license-ref",
  "lifecycle",
  "log-format",
  "metadata-property",
  "min-confidence",
  "no-babel",
  "no-banner",
  "no-ignore",
  "only",
  "openapi-spec-file",
  "output",
  "package-extensions",
  "parent-project-id",
  "parent-project-name",
  "parent-project-version",
  "print",
  "profile",
  "progress",
  "project-group",
  "project-id",
  "project-name",
  "project-tag",
  "project-version",
  "proto-bin-file",
  "quiet",
  "recurse",
  "release-notes-current-tag",
  "release-notes-previous-tag",
  "required-only",
  "resolve-class",
  "rust",
  "scalasem",
  "scalasem-include-tests",
  "server-url",
  "spec-version",
  "standard",
  "tea-artifact-url",
  "tea-author-email",
  "tea-author-name",
  "tea-collection-name",
  "tea-fetch",
  "tea-leaf-identifier",
  "tea-publish",
  "tea-reason",
  "tea-token",
  "technique",
  "tlp-classification",
  "type",
  "validate",
  "verbose",
]);

/**
 * Options only the operator may set, on the command line or through a
 * CDXGEN_* environment variable. They choose an executable, start a listener,
 * turn off certificate checks on the operator's own upload, opt into
 * experimental tool installation, hand the terminal to the interactive
 * interface, sign the BOM with a generated key in place
 * of the operator's, or end the run without a BOM. Evidence collection hands
 * project-named values to atom and its helpers, and a slices file is read
 * back as the project's evidence, so neither is the scanned project's to
 * choose either. A config file that sets one is told so and ignored.
 */
export const OPERATOR_ONLY_OPTIONS = new Set([
  "callsites-slices-file",
  "data-flow-slices-file",
  "deps-slices-file",
  "evidence",
  "feature-flags",
  "generate-key-and-sign",
  "help",
  "reachables-slices-file",
  "scalasem-command",
  "semantics-slices-file",
  "server",
  "server-host",
  "server-port",
  "skip-dt-tls-check",
  "tui",
  "usages-slices-file",
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
  ["q", "quiet"],
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
  "openapi-spec-file",
  "license-policy",
  "bom-audit-rules-dir",
  "introspect-report",
  "introspect-json",
  "cmake-cache",
  "compile-commands",
  "caxa-app-dir",
]);

/**
 * Options whose values are glob patterns matched against every file a scan
 * walks, in the order they draw on the shared expansion budget.
 */
const PATTERN_OPTIONS = ["exclude", "include-regex"];

/**
 * Options that change where cdxgen sends data, how much of the host it
 * touches, what the scan covers, or how its findings are judged. These stay
 * usable, but never silently.
 */
const ANNOUNCED_OPTIONS = new Set([
  "server-url",
  "api-key",
  "include-formulation",
  "install-deps",
  "introspect",
  "deep",
  "exclude",
  "exclude-type",
  "license-policy",
  "tea-publish",
  "tea-fetch",
  "tea-artifact-url",
  "tea-token",
  "type",
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
 * The operating system does the resolving, because it is what opens the path
 * later: realpathSync() follows the links in JavaScript and ends up somewhere
 * else at a link target that is not valid UTF-8 or at a ".." behind a link. A
 * component counts as not existing yet only when nothing is there. A dangling
 * or looping link, or a directory that cannot be searched, leads somewhere
 * unknown instead.
 *
 * @param {string} absolutePath absolute path to resolve
 * @returns {string|undefined} the path with every existing component
 *   resolved, or undefined when something is at the path but where it leads
 *   cannot be determined
 */
function resolveExistingPrefix(absolutePath) {
  const isMissing = (err) => ["ENOENT", "ENOTDIR"].includes(err?.code);
  const missing = [];
  let current = absolutePath;
  for (;;) {
    try {
      return path.join(realpathSync.native(current), ...missing.reverse());
    } catch (err) {
      if (!isMissing(err)) {
        return undefined;
      }
      try {
        lstatSync(current);
        // A link whose target is missing
        return undefined;
      } catch (lstatErr) {
        if (!isMissing(lstatErr)) {
          return undefined;
        }
      }
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
 * A path with a `..` segment is refused outright. path.resolve() removes
 * `link/..` as text, while the file system, which later opens the value as
 * written, follows the link before it takes the parent. The two agree only on
 * a path without `..` segments, and a path inside configDir never needs one.
 *
 * @param {string} configDir directory the config file was read from
 * @param {unknown} value config-supplied path value
 * @returns {boolean} true when the path resolves inside configDir
 */
function isContainedPath(configDir, value) {
  if (typeof value !== "string" || !value.length) {
    return false;
  }
  if (value.split(/[\\/]/).includes("..")) {
    return false;
  }
  const root = resolveExistingPrefix(path.resolve(configDir));
  const target = resolveExistingPrefix(path.resolve(configDir, value));
  if (root === undefined || target === undefined) {
    return false;
  }
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
 * Project type names cdxgen dispatches on besides the entries of
 * PROJECT_TYPE_ALIASES.
 */
const EXTRA_PROJECT_TYPES = ["ai", "aibom", "ai-bom", "maven-repo"];

let knownProjectTypes;

/**
 * Determine whether cdxgen knows a project type by the exact name given.
 * cdxgen matches project types case-sensitively, and a name it does not know
 * makes it scan for every ecosystem while later stages still see the name.
 *
 * @param {string} type project type from a config file
 * @returns {boolean} true for a project type cdxgen dispatches on
 */
function isKnownProjectType(type) {
  if (!knownProjectTypes) {
    knownProjectTypes = new Set([
      ...Object.keys(PROJECT_TYPE_ALIASES),
      ...Object.values(PROJECT_TYPE_ALIASES).flat(),
      ...EXTRA_PROJECT_TYPES,
    ]);
  }
  if (
    knownProjectTypes.has(type) ||
    (type === type.toLowerCase() && isVersionedJvmToolProjectType(type))
  ) {
    return true;
  }
  // A versioned Ruby type such as ruby3.4.1.
  const rubyVersion = type.startsWith("ruby") ? type.slice(4) : "";
  return (
    rubyVersion.length > 0 &&
    rubyVersion.split(".").every((part) => /^\d{1,4}$/.test(part))
  );
}

/**
 * Apply the trust boundary between cdxgen and the directory it is scanning.
 *
 * A config file lives in the tree under analysis, so it is attacker-controlled
 * whenever that tree is. It may therefore only set the options listed in
 * PROJECT_CONFIG_OPTIONS: options that choose an executable, start a listener
 * or weaken the operator's own checks, and every key cdxgen does not declare
 * as an option, are dropped. Path options are confined to the config's own
 * directory - a scanned project may choose where in itself the BOM lands, but
 * not write outside it - and project types that inventory the host rather
 * than the scan path, or that cdxgen does not know by the name given, are
 * dropped. Exclude and include patterns are kept
 * within the bounds of boundUntrustedGlobPatterns, so a project cannot make
 * every file match against thousands of brace-expanded patterns, and filter
 * and only lists to UNTRUSTED_FILTER_TERM_LIMIT terms, since every term is
 * searched for in every component. Options that
 * redirect data off the host or widen what cdxgen does are announced on the
 * console. A project may describe itself with custom metadata properties, but
 * not in the namespaces cdxgen reserves for the facts it establishes, so a
 * scanned tree cannot pass its own claims off as cdxgen's.
 *
 * @param {Object} config parsed config file contents
 * @param {string} configDir directory the config file was read from
 * @returns {{config: Object, rejected: string[], announced: string[], reservedProperties: string[], ignored: string[], operatorOnly: string[], hostScopeTypes: string[], unknownTypes: string[], refusedPatterns: {key: string, pattern: string, reason: string}[]}} sanitized config and what it did
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
    reservedProperties: [],
    unknownTypes: [],
  };
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return result;
  }
  const sanitized = result.config;
  const aliasEntries = [];
  for (const [key, value] of Object.entries(config)) {
    if (METADATA_PROPERTY_CONFIG_KEYS.includes(key)) {
      sanitized[key] = value;
      continue;
    }
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
  for (const key of METADATA_PROPERTY_CONFIG_KEYS) {
    if (sanitized[key] === undefined) {
      continue;
    }
    const properties = [];
    for (const aprop of parseMetadataProperties(sanitized[key])) {
      if (isReservedMetadataPropertyName(aprop.name)) {
        result.reservedProperties.push(aprop.name);
      } else {
        properties.push(aprop);
      }
    }
    if (properties.length) {
      sanitized[key] = properties;
    } else {
      delete sanitized[key];
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
    // One pass over a list that a config file can make arbitrarily long. A
    // host-scope or unknown type the file repeats is reported once.
    const types = projectTypeList(sanitized.type);
    const projectTypes = [];
    const hostScopeTypes = new Set();
    const unknownTypes = new Set();
    for (const type of types) {
      if (HOST_SCOPE_PROJECT_TYPES.has(type.toLowerCase())) {
        hostScopeTypes.add(type);
      } else if (!isKnownProjectType(type)) {
        unknownTypes.add(type);
      } else {
        projectTypes.push(type);
      }
    }
    result.hostScopeTypes = Array.from(hostScopeTypes);
    result.unknownTypes = Array.from(unknownTypes);
    if (projectTypes.length !== types.length) {
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
        { keepInTree: option === "include-regex", used: patternsUsed },
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
  // Every filter and only term is searched for in every component.
  for (const key of ["filter", "only"]) {
    if (
      Array.isArray(sanitized[key]) &&
      sanitized[key].length > UNTRUSTED_FILTER_TERM_LIMIT
    ) {
      result.refusedPatterns.push({
        key,
        pattern: `${sanitized[key][UNTRUSTED_FILTER_TERM_LIMIT]}`,
        reason: `is past the ${UNTRUSTED_FILTER_TERM_LIMIT} terms a config file may list, as is every one after it`,
      });
      sanitized[key] = sanitized[key].slice(0, UNTRUSTED_FILTER_TERM_LIMIT);
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
