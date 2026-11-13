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

/** Fields read from a preset itself, which CMake does not inherit. */
const OWN_FIELDS = ["name", "hidden", "inherits", "displayName"];

/**
 * Inherited fields that are read: a preset's own value wins, then that of its
 * parents in order. Fields nothing reads are not carried along.
 */
const INHERITED_FIELDS = [
  "generator",
  "binaryDir",
  "toolchainFile",
  "condition",
];

/** Fields merged key by key across the inheritance chain. */
const MAP_FIELDS = ["cacheVariables", "environment"];

/** An inheritance chain deeper than this is treated as malformed. */
const MAX_INHERITANCE_DEPTH = 32;

/** A condition nested deeper than this is not decided. */
const MAX_CONDITION_DEPTH = 64;

/**
 * Work units one resolution may spend on top of PRESET_WORK_PER_UNIT for each
 * unit of the presets' own content. A unit is a map entry, a condition node or
 * a character expanded. Inheritance hands a parent's content to every heir,
 * so without a limit a file of N heirs and K inherited entries costs N times
 * K; real presets stay far below it.
 */
const PRESET_WORK_BASE = 8 * 1024 * 1024;
const PRESET_WORK_PER_UNIT = 16;

/** Source directories whose presets were already reported as too large. */
const reportedOverLimit = new Set();

/** What may follow the `$` of a macro: a namespace, possibly empty, and `{`. */
const MACRO_OPENERS = ["{", "env{", "penv{", "vendor{"];

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
 *   optional. `work`, when given, is a `{remaining}` budget the expansion is
 *   charged to; once it is spent, strings are returned as written.
 * @returns {string} Expanded string
 */
export function expandPresetMacros(value, context = {}) {
  const work = context.work;
  if (typeof value !== "string") {
    return value;
  }
  if (work) {
    work.remaining -= 1 + value.length;
    if (work.remaining < 0) {
      return value;
    }
  }
  if (!value.includes("$")) {
    if (work) {
      work.remaining -= value.length;
    }
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
    // the opener is matched in place, so each `$` costs a constant amount
    const opener = MACRO_OPENERS.find((o) => value.startsWith(o, dollar + 1));
    if (opener === undefined) {
      out += "$";
      i = dollar + 1;
      continue;
    }
    const namespace = opener.slice(0, -1);
    const open = dollar + opener.length;
    const close = value.indexOf("}", open);
    if (close < 0) {
      // no later macro can be closed either
      out += value.slice(dollar);
      break;
    }
    const name = value.slice(open + 1, close);
    const replacement = macroValue(namespace, name, context);
    out +=
      replacement === undefined ? value.slice(dollar, close + 1) : replacement;
    i = close + 1;
    // macros may expand to far more than they are written as
    if (work && out.length > work.remaining) {
      work.remaining = -1;
      return value;
    }
  }
  if (work) {
    work.remaining -= out.length;
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
 * @param {{remaining: number}} [work] Budget charged one unit per condition
 *   and list item; once it is spent, the condition is not decided
 * @param {number} [depth] Nesting depth of `condition`
 * @returns {boolean|undefined} `undefined` when the condition cannot be
 *   decided here: `matches`/`notMatches` take a regular expression from the
 *   repository, which is not run, and a condition nested too deeply or past
 *   the work budget is not decided either
 */
export function evaluatePresetCondition(
  condition,
  expand,
  work = undefined,
  depth = 0,
) {
  if (condition === null || condition === undefined) {
    return true;
  }
  if (typeof condition === "boolean") {
    return condition;
  }
  if (
    typeof condition !== "object" ||
    Array.isArray(condition) ||
    depth > MAX_CONDITION_DEPTH
  ) {
    return undefined;
  }
  const spent = () => work !== undefined && work.remaining < 0;
  const charge = () => {
    if (work) {
      work.remaining -= 1;
    }
    return !spent();
  };
  if (!charge()) {
    return undefined;
  }
  const result = decideCondition(condition, expand, work, depth, charge);
  // a string left unexpanded once the budget ran out decides nothing
  return spent() ? undefined : result;
}

function decideCondition(condition, expand, work, depth, charge) {
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
      let found = false;
      for (const v of condition.list) {
        if (!charge()) {
          return undefined;
        }
        if (str(v) === needle) {
          found = true;
          break;
        }
      }
      return found === (condition.type === "inList");
    }
    case "anyOf":
    case "allOf": {
      if (!Array.isArray(condition.conditions)) {
        return undefined;
      }
      const results = [];
      for (const c of condition.conditions) {
        if (!charge()) {
          return undefined;
        }
        results.push(evaluatePresetCondition(c, expand, work, depth + 1));
      }
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
      const inner = evaluatePresetCondition(
        condition.condition,
        expand,
        work,
        depth + 1,
      );
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
  let ownWeight = 0;
  for (const { preset } of byName.values()) {
    for (const field of [...OWN_FIELDS, ...INHERITED_FIELDS, ...MAP_FIELDS]) {
      ownWeight += contentWeight(preset[field]);
    }
  }
  const work = {
    remaining: PRESET_WORK_BASE + PRESET_WORK_PER_UNIT * ownWeight,
  };
  const merged = new Map();
  const merging = new Set();
  const mergedOf = (name, depth) => {
    if (merged.has(name)) {
      return merged.get(name);
    }
    const entry = byName.get(name);
    if (
      !entry ||
      merging.has(name) ||
      depth > MAX_INHERITANCE_DEPTH ||
      work.remaining < 0
    ) {
      return null;
    }
    merging.add(name);
    const own = entry.preset;
    const parents = [];
    let broken = false;
    for (const parentName of inheritsOf(own)) {
      const parent = mergedOf(parentName, depth + 1);
      if (!parent) {
        broken = true;
        break;
      }
      parents.push(parent.fields);
    }
    let resolved = null;
    if (!broken) {
      const result = {};
      for (const field of OWN_FIELDS) {
        if (own[field] !== undefined) {
          result[field] = own[field];
        }
      }
      for (const field of INHERITED_FIELDS) {
        const from = [own, ...parents].find((f) => f[field] !== undefined);
        if (from) {
          result[field] = from[field];
        }
      }
      for (const field of MAP_FIELDS) {
        const map = mergeMaps(
          isPlainObject(own[field]) ? own[field] : undefined,
          parents.map((f) => f[field]).filter(isPlainObject),
          work,
        );
        if (map) {
          result[field] = map;
        }
      }
      resolved = { fields: result, doc: entry.doc };
    }
    merging.delete(name);
    merged.set(name, resolved);
    return resolved;
  };
  const presets = [];
  let leftOut = 0;
  for (const [name, { preset }] of byName) {
    if (work.remaining >= 0) {
      const resolved = mergedOf(name, 0);
      if (!resolved || resolved.fields.hidden === true) {
        continue;
      }
      const expanded = expandPreset(name, resolved, context, work);
      if (work.remaining >= 0) {
        presets.push(expanded);
        continue;
      }
    }
    if (preset.hidden !== true) {
      leftOut++;
    }
  }
  if (leftOut) {
    const key = context.sourceDir || "";
    if (!reportedOverLimit.has(key)) {
      if (reportedOverLimit.size >= 1024) {
        reportedOverLimit.clear();
      }
      reportedOverLimit.add(key);
      console.warn(
        `The CMake presets of ${key || "the project"} inherit more settings than cdxgen resolves; ${leftOut} configure presets are left out.`,
      );
    }
  }
  return presets;
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function inheritsOf(fields) {
  return typeof fields.inherits === "string"
    ? [fields.inherits]
    : Array.isArray(fields.inherits)
      ? fields.inherits.filter((p) => typeof p === "string")
      : [];
}

/**
 * The size of a preset field: one unit per value, plus the length of every
 * string and key. A value nested deeper than MAX_CONDITION_DEPTH counts as one
 * unit.
 */
function contentWeight(value) {
  let weight = 0;
  const stack = [[value, 0]];
  while (stack.length) {
    const [v, depth] = stack.pop();
    weight += 1;
    if (typeof v === "string") {
      weight += v.length;
    } else if (v && typeof v === "object" && depth <= MAX_CONDITION_DEPTH) {
      for (const [key, child] of Object.entries(v)) {
        weight += key.length;
        stack.push([child, depth + 1]);
      }
    }
  }
  return weight;
}

/** Set a key as an own property, even one named `__proto__`. */
function setOwn(target, key, value) {
  if (key === "__proto__") {
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  } else {
    target[key] = value;
  }
}

/**
 * Merge a preset's own map with its parents' maps, key by key: the preset's
 * own entry wins, then that of its parents in order. The keys come out in the
 * order a merge parent by parent (`{ ...parent, ...merged }`) leaves them in,
 * where a parent named again moves its keys to the front. Each distinct map
 * is read at most twice however often it is named, and a single map is
 * shared, not copied; it is never modified.
 */
function mergeMaps(ownMap, parentMaps, work) {
  const maps = ownMap ? [ownMap, ...parentMaps] : parentMaps;
  const firstMentions = [...new Set(maps)];
  if (firstMentions.length <= 1) {
    return firstMentions[0];
  }
  const values = new Map();
  for (const map of firstMentions) {
    for (const [key, value] of Object.entries(map)) {
      work.remaining -= 1;
      if (!values.has(key)) {
        values.set(key, value);
      }
    }
  }
  // the last mention of a map decides where its keys go
  const lastMentions = [...new Set([...maps].reverse())];
  const result = {};
  for (const map of lastMentions) {
    for (const key of Object.keys(map)) {
      work.remaining -= 1;
      if (!Object.hasOwn(result, key)) {
        setOwn(result, key, values.get(key));
      }
    }
  }
  return result;
}

function expandPreset(name, resolved, context, work) {
  const { fields, doc } = resolved;
  const sourceDir = context.sourceDir || "";
  const generator =
    typeof fields.generator === "string" ? fields.generator : "";
  // the generator is not expanded, but every preset reports it
  work.remaining -= generator.length;
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
    work,
  };
  // An environment entry may refer to the process environment and to the
  // other entries; a few rounds settle any chain a real preset writes.
  const rawEnvironment = {};
  for (const [key, value] of Object.entries(fields.environment || {})) {
    work.remaining -= 1;
    if (typeof value === "string") {
      rawEnvironment[key] = value;
    }
  }
  let environment = { ...rawEnvironment };
  for (let round = 0; round < 4; round++) {
    const next = {};
    // while an entry is expanded, its own name refers to the process
    // environment; one copy per round serves every entry
    const scope = { ...environment };
    for (const [key, value] of Object.entries(rawEnvironment)) {
      const saved = scope[key];
      scope[key] = base.penv ? (base.penv(key) ?? "") : "";
      next[key] = expandPresetMacros(value, { ...base, env: scope });
      scope[key] = saved;
    }
    environment = next;
  }
  const expandContext = { ...base, env: environment };
  const expand = (v) => expandPresetMacros(v, expandContext);
  const cacheVariables = {};
  for (const [key, entry] of Object.entries(fields.cacheVariables || {})) {
    work.remaining -= 1;
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
    conditionMet: evaluatePresetCondition(fields.condition, expand, work),
  };
}
