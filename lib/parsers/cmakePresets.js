/**
 * Pure reader for CMake presets (`CMakePresets.json` and
 * `CMakeUserPresets.json`, schema versions 1 to 10).
 *
 * A configure preset names how a project is configured: the generator, the
 * build directory, the toolchain file and the cache variables (build type,
 * compilers). Presets inherit from one another, may be hidden (templates
 * that only exist to be inherited), may be enabled only under a condition,
 * and spell paths with macros such as `${sourceDir}` and `$env{NAME}`.
 *
 * This module is layer 1: text and a context object in, data out. Reading the
 * files (and their `include` lists) is done by the caller, which also supplies
 * the process environment through `context.penv`.
 */

import { isAbsolute, join, normalize } from "node:path";

/** Fields a preset does not inherit (CMake's rule). */
const NOT_INHERITED = new Set([
  "name",
  "hidden",
  "inherits",
  "description",
  "displayName",
]);

/** Fields merged key by key across the inheritance chain. */
const MAP_FIELDS = new Set(["cacheVariables", "environment"]);

/** An inheritance chain deeper than this is treated as malformed. */
const MAX_INHERITANCE_DEPTH = 32;

/**
 * Parse the text of a presets file.
 *
 * @param {string} text File contents
 * @returns {{version: number|undefined, include: string[], configurePresets: Object[]}|null}
 *   `null` when the text is not a presets document
 */
export function parseCmakePresets(text) {
  if (typeof text !== "string" || !text.trim()) {
    return null;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (_err) {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  const configurePresets = Array.isArray(data.configurePresets)
    ? data.configurePresets.filter(
        (p) =>
          p &&
          typeof p === "object" &&
          !Array.isArray(p) &&
          typeof p.name === "string" &&
          p.name.length,
      )
    : [];
  return {
    version: Number.isInteger(data.version) ? data.version : undefined,
    include: Array.isArray(data.include)
      ? data.include.filter((f) => typeof f === "string" && f.length)
      : [],
    configurePresets,
  };
}

/**
 * Expand the macros CMake allows in preset strings.
 *
 * Supported: `${sourceDir}`, `${sourceParentDir}`, `${sourceDirName}`,
 * `${presetName}`, `${generator}`, `${hostSystemName}`, `${fileDir}`,
 * `${dollar}`, `${pathListSep}`, `$env{NAME}` (the preset's own environment,
 * then the process environment) and `$penv{NAME}` (the process environment).
 * `$vendor{...}` and unknown macros are left as written.
 *
 * @param {string} value String to expand
 * @param {Object} context Macro values; `env` (preset environment, a plain
 *   object) and `penv` (a function reading the process environment) are
 *   optional
 * @returns {string} Expanded string
 */
export function expandPresetMacros(value, context = {}) {
  if (typeof value !== "string" || !value.includes("$")) {
    return value;
  }
  let out = "";
  let i = 0;
  while (i < value.length) {
    const dollar = value.indexOf("$", i);
    if (dollar < 0) {
      out += value.slice(i);
      break;
    }
    out += value.slice(i, dollar);
    const open = value.indexOf("{", dollar);
    const close = open < 0 ? -1 : value.indexOf("}", open);
    const namespace = open < 0 ? "" : value.slice(dollar + 1, open);
    if (
      open < 0 ||
      close < 0 ||
      !["", "env", "penv", "vendor"].includes(namespace)
    ) {
      out += "$";
      i = dollar + 1;
      continue;
    }
    const name = value.slice(open + 1, close);
    const replacement = macroValue(namespace, name, context);
    out +=
      replacement === undefined ? value.slice(dollar, close + 1) : replacement;
    i = close + 1;
  }
  return out;
}

function macroValue(namespace, name, context) {
  if (namespace === "penv") {
    return context.penv ? (context.penv(name) ?? "") : "";
  }
  if (namespace === "env") {
    if (context.env && Object.hasOwn(context.env, name)) {
      return context.env[name] ?? "";
    }
    return context.penv ? (context.penv(name) ?? "") : "";
  }
  if (namespace === "vendor") {
    return undefined;
  }
  switch (name) {
    case "sourceDir":
    case "sourceParentDir":
    case "sourceDirName":
    case "presetName":
    case "generator":
    case "hostSystemName":
    case "fileDir":
    case "pathListSep":
      return context[name] ?? "";
    case "dollar":
      return "$";
    default:
      return undefined;
  }
}

/**
 * Evaluate a preset condition (schema version 3 and later).
 *
 * @param {*} condition Condition object (or boolean, or null)
 * @param {function(string): string} expand Macro expander for the preset
 * @returns {boolean|undefined} `undefined` when the condition cannot be
 *   decided here: `matches`/`notMatches` take a regular expression from the
 *   repository, which is not run
 */
export function evaluatePresetCondition(condition, expand) {
  if (condition === null || condition === undefined) {
    return true;
  }
  if (typeof condition === "boolean") {
    return condition;
  }
  if (typeof condition !== "object" || Array.isArray(condition)) {
    return undefined;
  }
  const str = (v) => (typeof v === "string" ? expand(v) : undefined);
  switch (condition.type) {
    case "const":
      return typeof condition.value === "boolean" ? condition.value : undefined;
    case "equals":
    case "notEquals": {
      const lhs = str(condition.lhs);
      const rhs = str(condition.rhs);
      if (lhs === undefined || rhs === undefined) {
        return undefined;
      }
      return (lhs === rhs) === (condition.type === "equals");
    }
    case "inList":
    case "notInList": {
      const needle = str(condition.string);
      if (needle === undefined || !Array.isArray(condition.list)) {
        return undefined;
      }
      const found = condition.list.some((v) => str(v) === needle);
      return found === (condition.type === "inList");
    }
    case "anyOf":
    case "allOf": {
      if (!Array.isArray(condition.conditions)) {
        return undefined;
      }
      const results = condition.conditions.map((c) =>
        evaluatePresetCondition(c, expand),
      );
      if (condition.type === "anyOf") {
        if (results.includes(true)) {
          return true;
        }
        return results.includes(undefined) ? undefined : false;
      }
      if (results.includes(false)) {
        return false;
      }
      return results.includes(undefined) ? undefined : true;
    }
    case "not": {
      const inner = evaluatePresetCondition(condition.condition, expand);
      return inner === undefined ? undefined : !inner;
    }
    default:
      return undefined;
  }
}

/** A cache variable's value as CMake sets it, or `null` for an unset one. */
function cacheValue(entry) {
  if (entry === null) {
    return null;
  }
  const raw =
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? entry.value
      : entry;
  if (typeof raw === "boolean") {
    return raw ? "TRUE" : "FALSE";
  }
  return typeof raw === "string" ? raw : undefined;
}

/**
 * Resolve the configure presets of a set of presets documents.
 *
 * Inheritance follows CMake: a preset's own fields win, then those of its
 * `inherits` entries in order (the first wins), recursively; `cacheVariables`
 * and `environment` merge key by key the same way, and a `null` entry unsets
 * the key. `name`, `hidden`, `inherits`, `description` and `displayName` are
 * not inherited. A preset that is part of an inheritance cycle, or inherits
 * one that does not exist, is dropped.
 *
 * @param {Array<{file: string, fileDir: string, document: Object}>} documents
 *   Parsed documents in reading order (`CMakePresets.json` first, then its
 *   includes, then `CMakeUserPresets.json`)
 * @param {Object} context `sourceDir`, `hostSystemName`, `pathListSep`, and
 *   `penv` (a function reading the process environment)
 * @returns {Object[]} Visible configure presets: `name`, `displayName`,
 *   `file`, `inherits`, `generator`, `binaryDir` (absolute), `toolchainFile`,
 *   `cacheVariables` (expanded strings), `environment` (expanded strings),
 *   `hasCondition`, and `conditionMet` (true, false or undefined)
 */
export function resolveConfigurePresets(documents, context = {}) {
  const byName = new Map();
  for (const doc of documents || []) {
    for (const preset of doc?.document?.configurePresets || []) {
      if (!byName.has(preset.name)) {
        byName.set(preset.name, { preset, doc });
      }
    }
  }
  const merged = new Map();
  const merging = new Set();
  const mergedOf = (name, depth) => {
    if (merged.has(name)) {
      return merged.get(name);
    }
    const entry = byName.get(name);
    if (!entry || merging.has(name) || depth > MAX_INHERITANCE_DEPTH) {
      return null;
    }
    merging.add(name);
    const own = entry.preset;
    const parents =
      typeof own.inherits === "string"
        ? [own.inherits]
        : Array.isArray(own.inherits)
          ? own.inherits.filter((p) => typeof p === "string")
          : [];
    const result = {};
    for (const [field, value] of Object.entries(own)) {
      if (MAP_FIELDS.has(field)) {
        if (value && typeof value === "object" && !Array.isArray(value)) {
          result[field] = { ...value };
        }
      } else {
        result[field] = value;
      }
    }
    let broken = false;
    for (const parentName of parents) {
      const parent = mergedOf(parentName, depth + 1);
      if (!parent) {
        broken = true;
        break;
      }
      for (const [field, value] of Object.entries(parent.fields)) {
        if (NOT_INHERITED.has(field)) {
          continue;
        }
        if (MAP_FIELDS.has(field)) {
          result[field] = { ...value, ...(result[field] || {}) };
        } else if (result[field] === undefined) {
          result[field] = value;
        }
      }
    }
    merging.delete(name);
    const resolved = broken ? null : { fields: result, doc: entry.doc };
    merged.set(name, resolved);
    return resolved;
  };
  const presets = [];
  for (const name of byName.keys()) {
    const resolved = mergedOf(name, 0);
    if (!resolved || resolved.fields.hidden === true) {
      continue;
    }
    presets.push(expandPreset(name, resolved, context));
  }
  return presets;
}

function expandPreset(name, resolved, context) {
  const { fields, doc } = resolved;
  const sourceDir = context.sourceDir || "";
  const generator =
    typeof fields.generator === "string" ? fields.generator : "";
  const base = {
    sourceDir,
    sourceParentDir: context.sourceParentDir ?? "",
    sourceDirName: context.sourceDirName ?? "",
    hostSystemName: context.hostSystemName ?? "",
    pathListSep: context.pathListSep ?? ":",
    presetName: name,
    generator,
    fileDir: doc?.fileDir ?? sourceDir,
    penv: context.penv,
  };
  // An environment entry may refer to the process environment and to the
  // other entries; a few rounds settle any chain a real preset writes.
  const rawEnvironment = {};
  for (const [key, value] of Object.entries(fields.environment || {})) {
    if (typeof value === "string") {
      rawEnvironment[key] = value;
    }
  }
  let environment = { ...rawEnvironment };
  for (let round = 0; round < 4; round++) {
    const next = {};
    for (const [key, value] of Object.entries(rawEnvironment)) {
      next[key] = expandPresetMacros(value, {
        ...base,
        env: { ...environment, [key]: base.penv ? (base.penv(key) ?? "") : "" },
      });
    }
    environment = next;
  }
  const expandContext = { ...base, env: environment };
  const expand = (v) => expandPresetMacros(v, expandContext);
  const cacheVariables = {};
  for (const [key, entry] of Object.entries(fields.cacheVariables || {})) {
    const value = cacheValue(entry);
    if (typeof value === "string") {
      cacheVariables[key] = expand(value);
    }
  }
  let binaryDir;
  if (typeof fields.binaryDir === "string" && fields.binaryDir.length) {
    const dir = expand(fields.binaryDir);
    binaryDir =
      isAbsolute(dir) || !sourceDir ? normalize(dir) : join(sourceDir, dir);
  }
  const toolchainFile =
    typeof fields.toolchainFile === "string" && fields.toolchainFile.length
      ? expand(fields.toolchainFile)
      : cacheVariables.CMAKE_TOOLCHAIN_FILE;
  const inherits =
    typeof fields.inherits === "string"
      ? [fields.inherits]
      : Array.isArray(fields.inherits)
        ? fields.inherits.filter((p) => typeof p === "string")
        : [];
  return {
    name,
    displayName:
      typeof fields.displayName === "string" ? fields.displayName : undefined,
    file: doc?.file,
    inherits,
    generator: generator || undefined,
    binaryDir,
    toolchainFile: toolchainFile || undefined,
    cacheVariables,
    environment,
    hasCondition: fields.condition !== undefined && fields.condition !== null,
    conditionMet: evaluatePresetCondition(fields.condition, expand),
  };
}
