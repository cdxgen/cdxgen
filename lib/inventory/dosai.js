import { Buffer } from "node:buffer";
import {
  closeSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, delimiter, isAbsolute, join, resolve } from "node:path";
import process from "node:process";

import { DEBUG_MODE } from "../core/activity.js";
import { recordDegradation } from "../core/buildLedger.js";
import {
  getTmpDir,
  safeExistsSync,
  safeMkdtempSync,
  safeRmSync,
  safeSpawnSync,
  safeWriteChunksSync,
  safeWriteSync,
  TIMEOUT_MS,
} from "../core/fs.js";
import {
  indexJsonObject,
  MAX_JSON_TEXT_BYTES,
  readJsonRange,
} from "../parsers/largeJson.js";
import {
  addDosaiSetValue,
  buildDosaiPurlAliasMap,
  dosaiSourceLocation,
  dosaiSourceLocationFromNode,
  resolveDosaiComponentPurl,
} from "./dosaiParsers.js";
import { resolvePluginBinary } from "./plugins.js";

const DOTNET_LANGUAGES = new Set([
  "c#",
  "csharp",
  "cs",
  "dotnet",
  "dotnet-framework",
  // Versioned CLI types (`-t dotnet11`): the project-type aliases map them to
  // csharp for dispatch, but gates such as shouldCollectDosaiCrypto inspect the
  // raw options.projectType, so the versioned spellings must resolve here too.
  "dotnet6",
  "dotnet7",
  "dotnet8",
  "dotnet9",
  "dotnet10",
  "dotnet11",
  "f#",
  "fsharp",
  "fs",
  "nuget",
  "vb",
  "vbnet",
  "visualbasic",
]);

const DOSAI_COMMANDS = new Set(["crypto", "dataflows", "methods"]);

function dosaiBin() {
  return resolvePluginBinary("dosai");
}

function frameFromDosaiNode(node) {
  if (!node) {
    return undefined;
  }
  const fullFilename =
    node.Path || node.FileName || node.CallLocation?.FileName;
  if (!fullFilename || fullFilename === "<unknown>") {
    return undefined;
  }
  return {
    package: node.Namespace || "",
    module: node.ClassName || node.Module || "",
    function: node.MethodName || node.Name || node.CalledMethodName || "",
    line: node.LineNumber || node.CallLocation?.LineNumber || undefined,
    column: node.ColumnNumber || node.CallLocation?.ColumnNumber || undefined,
    fullFilename,
  };
}

/**
 * Whether this slice's ApiEndpoints carry a resolved route in `Path`.
 *
 * Schema 4.0.0 introduced `Path` as the resolved route ([controller] substituted, constraints
 * stripped) alongside the verbatim `Route`. In every earlier schema `Path` is the **source file
 * path**, so preferring it unconditionally emits file paths as service endpoints. cdxgen ships a
 * pinned dosai via @cdxgen/cdxgen-plugins-bin and users can point DOSAI_CMD at any build, so both
 * shapes are live and the version has to be checked.
 *
 * @param {Object} methodsSlice Parsed dosai methods slice JSON
 * @returns {boolean} True when `Path` holds a resolved route
 */
function hasResolvedEndpointPaths(methodsSlice) {
  const version = methodsSlice?.Metadata?.SchemaVersion;
  if (typeof version !== "string") {
    return false;
  }
  const major = Number.parseInt(version.split(".")[0], 10);
  return Number.isFinite(major) && major >= 4;
}

/**
 * Coerce a dosai string list into the array-of-strings shape serviceData.source/destination require.
 * Returns undefined rather than an empty or malformed array so the key is omitted entirely.
 */
function toStringArray(value) {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value.filter((entry) => typeof entry === "string" && entry);
  return strings.length ? strings : undefined;
}

function appendUniqueProperty(properties, name, value) {
  if (value === undefined || value === null || value === "") {
    return;
  }
  if (
    !properties.some(
      (property) => property.name === name && property.value === String(value),
    )
  ) {
    properties.push({ name, value: String(value) });
  }
}

function sanitizeEndpoint(endpoint) {
  const value = String(endpoint || "").trim();
  if (!value) {
    return undefined;
  }
  if (/^https?:\/\//i.test(value)) {
    try {
      const parsedUrl = new URL(value);
      parsedUrl.username = "";
      parsedUrl.password = "";
      parsedUrl.search = "";
      parsedUrl.hash = "";
      return parsedUrl.toString();
    } catch (_err) {
      return undefined;
    }
  }
  const routePath = value.split("?")[0].split("#")[0].slice(0, 512);
  // ASP.NET route templates carry `[controller]` tokens and `{id}` parameters.
  // CycloneDX types `services[].endpoints[]` as an iri-reference, where square
  // brackets are reserved for IPv6 literals and braces are excluded outright,
  // so the template is percent-encoded before it reaches the BOM.
  const encodedPath = routePath.replace(
    /[[\]{}]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return encodedPath;
}

function serviceNameFromEndpoint(endpoint) {
  const className = endpoint.ClassName || endpoint.FileName || "dotnet";
  const methodName = endpoint.MethodName || endpoint.HttpMethod || "endpoint";
  return `dosai-${className}-${methodName}-service`
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/-+/g, "-");
}

function dosaiSdkMessage(result) {
  return (
    result?.stdout?.includes(
      "You must install or update .NET to run this application",
    ) ||
    result?.stderr?.includes(
      "You must install or update .NET to run this application",
    )
  );
}

function safeDosaiPath(value) {
  if (!value || typeof value !== "string" || /[\0\r\n]/.test(value)) {
    return undefined;
  }
  return resolve(value);
}

function safeDosaiPatternPacks(value) {
  if (!value || typeof value !== "string" || /[\0\r\n]/.test(value)) {
    return undefined;
  }
  return value
    .split(delimiter)
    .map((patternPack) => safeDosaiPath(patternPack.trim()))
    .filter(Boolean)
    .join(delimiter);
}

const MAX_DOSAI_EXCLUDES = 256;
const MAX_BRACE_RANGE = 64;
const GLOB_ESCAPABLE = "*?[]{}()!+@,";
// Characters a translated dosai glob may contain. dosai runs without a shell,
// but keeping shell metacharacters out means a pattern can never change
// meaning even if that ever changes. Anything else is reported as skipped.
const SAFE_DOSAI_GLOB = /^[\p{L}\p{N} _.+@#%~=/*?-]+$/u;
// Characters a dosai executable path may contain, including Windows drive
// letters and "Program Files (x86)". Shell metacharacters are not allowed.
const SAFE_DOSAI_EXECUTABLE = /^[\p{L}\p{N} _.,+@#%~=/\\:()-]+$/u;
const warnedDosaiMessages = new Set();
const dosaiWithoutExclude = new Set();

function warnDosaiOnce(message) {
  if (!warnedDosaiMessages.has(message)) {
    warnedDosaiMessages.add(message);
    console.warn(message);
  }
}

/**
 * Find the brace group starting at `open` and return its closing index and the
 * top-level comma positions, or undefined when the brace is never closed.
 */
function scanBraceGroup(pattern, open) {
  let depth = 0;
  const commas = [];
  for (let i = open; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "{") {
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0) {
        return { close: i, commas };
      }
    } else if (char === "," && depth === 1) {
      commas.push(i);
    }
  }
  return undefined;
}

function braceAlternatives(pattern, open, group) {
  const body = pattern.slice(open + 1, group.close);
  if (group.commas.length) {
    const bounds = [open, ...group.commas, group.close];
    const alternatives = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      alternatives.push(pattern.slice(bounds[i] + 1, bounds[i + 1]));
    }
    return alternatives;
  }
  // minimatch also expands small integer ranges such as {1..3}.
  const rangeParts = body.split("..");
  if (
    rangeParts.length === 2 &&
    /^-?\d+$/.test(rangeParts[0]) &&
    /^-?\d+$/.test(rangeParts[1])
  ) {
    const from = Number.parseInt(rangeParts[0], 10);
    const to = Number.parseInt(rangeParts[1], 10);
    if (Math.abs(to - from) < MAX_BRACE_RANGE) {
      const step = from <= to ? 1 : -1;
      const alternatives = [];
      for (let value = from; value !== to + step; value += step) {
        alternatives.push(String(value));
      }
      return alternatives;
    }
  }
  return undefined;
}

/**
 * Expand brace groups the way minimatch does. A group without a comma or a
 * numeric range, and a group written as "${...}", stays literal text.
 */
function expandGlobBraces(pattern, limit = MAX_DOSAI_EXCLUDES) {
  let open = pattern.indexOf("{");
  while (open !== -1) {
    const group = scanBraceGroup(pattern, open);
    if (!group) {
      return [pattern];
    }
    const alternatives =
      pattern[open - 1] === "$"
        ? undefined
        : braceAlternatives(pattern, open, group);
    if (alternatives) {
      const head = pattern.slice(0, open);
      const tail = pattern.slice(group.close + 1);
      const expanded = [];
      for (const alternative of alternatives) {
        for (const entry of expandGlobBraces(
          `${head}${alternative}${tail}`,
          limit,
        )) {
          expanded.push(entry);
          if (expanded.length >= limit) {
            return expanded;
          }
        }
      }
      return expanded;
    }
    open = pattern.indexOf("{", group.close + 1);
  }
  return [pattern];
}

/**
 * Normalise separators the way the atom exclude filter does: a backslash
 * before a glob character is an escape, any other backslash is a Windows path
 * separator. Returns undefined for escapes, which dosai cannot express.
 */
function normalizeDosaiGlobSeparators(pattern) {
  let normalized = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char !== "\\") {
      normalized += char;
      continue;
    }
    if (GLOB_ESCAPABLE.includes(pattern[i + 1] || "")) {
      return undefined;
    }
    normalized += "/";
  }
  return normalized;
}

function hasUnsupportedGlobSyntax(glob) {
  if (glob.includes("[") || glob.includes("]")) {
    return true;
  }
  for (let i = 1; i < glob.length; i++) {
    if (glob[i] === "(" && "@?+*!".includes(glob[i - 1])) {
      return true;
    }
  }
  return false;
}

/**
 * Rebase an absolute glob onto one of the scanned roots. Matching ignores case
 * on macOS and Windows, as cdxgen's own glob does there.
 */
function rebaseAbsoluteGlob(glob, roots) {
  const ignoreCase =
    process.platform === "darwin" || process.platform === "win32";
  const candidate = ignoreCase ? glob.toLowerCase() : glob;
  for (const root of roots) {
    let rootPath = root.replaceAll("\\", "/");
    while (rootPath.endsWith("/")) {
      rootPath = rootPath.slice(0, -1);
    }
    const rootPrefix = `${rootPath}/`;
    const prefix = ignoreCase ? rootPrefix.toLowerCase() : rootPrefix;
    if (candidate.startsWith(prefix)) {
      const rest = glob.slice(prefix.length);
      return rest ? rest : undefined;
    }
  }
  return undefined;
}

/**
 * Translate cdxgen --exclude globs into dosai --exclude globs.
 *
 * Dosai is an evidence analyzer, so the translation follows the exclude
 * filter cdxgen already applies to atom evidence slices
 * (`globPatternsToAtomIgnoreRegex`): a relative pattern matches at any depth,
 * and an absolute pattern is anchored to the scanned directory. Dosai itself
 * uses gitignore conventions, where a pattern with a slash is anchored, so
 * relative patterns get a leading "**\/". Like the atom filter, and unlike
 * cdxgen's file discovery, excluding a directory also excludes everything
 * beneath it.
 *
 * Brace groups and numeric ranges are expanded, and comma separated lists are
 * split, since dosai reads both as literal text. Character classes, extglobs,
 * escapes, negation, and patterns that step outside the scanned directory
 * have no dosai equivalent; they are reported as skipped rather than passed
 * on as literals that match nothing. So is any pattern that still carries a
 * character outside a small allowlist, such as a literal brace group or a
 * shell metacharacter. Dosai matches case-sensitively on Linux.
 *
 * @param {string[]} excludes cdxgen exclude globs
 * @param {string} srcPath Absolute directory dosai scans
 * @returns {{patterns: string[], skipped: string[], truncated: number}} Translated patterns, dropped patterns, and how many were left out by the cap
 */
export function toDosaiExcludePatterns(excludes, srcPath) {
  const patterns = new Set();
  const skipped = [];
  let truncated = 0;
  if (!Array.isArray(excludes)) {
    return { patterns: [], skipped, truncated };
  }
  const roots = [srcPath];
  try {
    const realRoot = realpathSync(srcPath);
    if (realRoot !== srcPath) {
      roots.push(realRoot);
    }
  } catch (_err) {
    // The directory may not exist yet in tests; the given path still applies.
  }
  const candidates = [];
  for (const pattern of excludes) {
    if (typeof pattern !== "string" || /[\0\r\n]/.test(pattern)) {
      continue;
    }
    const entries =
      pattern.includes(",") && !pattern.includes("{")
        ? pattern.split(",")
        : [pattern];
    for (const entry of entries) {
      const trimmed = entry.trim();
      if (trimmed) {
        candidates.push(trimmed);
      }
    }
  }
  for (const original of candidates) {
    const normalized = original.startsWith("!")
      ? undefined
      : normalizeDosaiGlobSeparators(original);
    if (!normalized) {
      skipped.push(original);
      continue;
    }
    for (const expanded of expandGlobBraces(normalized)) {
      let glob = expanded;
      while (glob.includes("//")) {
        glob = glob.replaceAll("//", "/");
      }
      if (hasUnsupportedGlobSyntax(glob)) {
        skipped.push(expanded);
        continue;
      }
      if (isAbsolute(glob) || /^[A-Za-z]:\//.test(glob)) {
        const rebased = rebaseAbsoluteGlob(glob, roots);
        if (!rebased) {
          skipped.push(expanded);
          continue;
        }
        glob = `/${rebased}`;
      } else {
        while (glob.startsWith("./")) {
          glob = glob.slice(2);
        }
        if (glob && !glob.startsWith("**/") && glob !== "**") {
          glob = `**/${glob}`;
        }
      }
      const segments = glob.split("/").filter(Boolean);
      if (
        !segments.length ||
        segments.includes("..") ||
        segments.every((segment) => segment === ".")
      ) {
        skipped.push(expanded);
        continue;
      }
      if (!SAFE_DOSAI_GLOB.test(glob)) {
        skipped.push(expanded);
        continue;
      }
      if (patterns.size >= MAX_DOSAI_EXCLUDES) {
        if (!patterns.has(glob)) {
          truncated++;
        }
        continue;
      }
      patterns.add(glob);
    }
  }
  return { patterns: Array.from(patterns), skipped, truncated };
}

function dosaiExcludeArgs(excludes, srcPath) {
  const { patterns, skipped, truncated } = toDosaiExcludePatterns(
    excludes,
    srcPath,
  );
  if (skipped.length) {
    warnDosaiOnce(
      `dosai cannot express these exclude patterns and will not apply them: ${skipped.join(", ")}`,
    );
  }
  if (truncated) {
    warnDosaiOnce(
      `Only the first ${MAX_DOSAI_EXCLUDES} exclude patterns are passed to dosai; ${truncated} more were left out.`,
    );
  }
  return patterns.flatMap((pattern) => ["--exclude", pattern]);
}

function dosaiRejectedExclude(result) {
  const output = `${result?.stdout || ""}${result?.stderr || ""}`;
  return output.includes("Unrecognized command or argument '--exclude'");
}

function safeDosaiExecutable(value) {
  if (!value || typeof value !== "string") {
    return undefined;
  }
  const executable = value.trim();
  if (!SAFE_DOSAI_EXECUTABLE.test(executable)) {
    return undefined;
  }
  return executable;
}

/**
 * Check whether a language is a .NET language supported by dosai analysis.
 *
 * @param {string} language Project type or language name
 * @returns {boolean} True when the language maps to a supported .NET/dotnet identifier
 */
export function isDosaiDotnetLanguage(language) {
  return DOTNET_LANGUAGES.has(String(language || "").toLowerCase());
}

/**
 * Read and parse a dosai JSON output file.
 *
 * @param {string} jsonFile Path to the dosai JSON file
 * @returns {Object|undefined} Parsed JSON content, or undefined when missing or invalid
 */
export function readDosaiJsonFile(jsonFile) {
  if (!jsonFile || !safeExistsSync(jsonFile)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(jsonFile, "utf-8"));
  } catch (_err) {
    return undefined;
  }
}

// The sections of a dosai methods report that cdxgen reads. The rest (Methods,
// Properties, Fields, Reachability, DeadCode, ...) only reaches downstream
// tools through the persisted native report.
const DOSAI_METHODS_SECTIONS = [
  "Metadata",
  "Dependencies",
  "MethodCalls",
  "AssemblyInformation",
  "CallGraph",
  "PackageReachability",
  "Services",
  "ApiEndpoints",
  "AiComponents",
];

// The file each report returned by readDosaiReport came from, and whether it
// was trimmed to what cdxgen reads. persistDosaiSemanticsReport copies the
// file rather than re-serialising a trimmed or oversized report.
const dosaiReportSources = new WeakMap();

function referencedIds(entries, field) {
  const ids = new Set();
  for (const entry of entries || []) {
    for (const id of entry?.[field] || []) {
      ids.add(id);
    }
  }
  return ids;
}

function readDosaiReport(reportFile, options, readTrimmed) {
  if (!reportFile || !safeExistsSync(reportFile)) {
    return undefined;
  }
  try {
    const size = statSync(reportFile).size;
    let report;
    let trimmed = false;
    if (size <= (options.maxTextBytes ?? MAX_JSON_TEXT_BYTES)) {
      report = JSON.parse(readFileSync(reportFile, "utf-8"));
    } else {
      // dotnet/efcore produces a 1.9 GB methods report (issue 1033). Read it
      // in bounded runs and keep only what cdxgen uses, which is a small
      // fraction of the file.
      if (DEBUG_MODE) {
        console.log(
          `The dosai report "${reportFile}" is ${size} bytes, more than one JavaScript string can hold, so only the parts cdxgen uses are read from it.`,
        );
      }
      const index = indexJsonObject(reportFile, options);
      report = {};
      readTrimmed(report, (section, spec) => {
        const range = index.get(section);
        if (range) {
          report[section] = readJsonRange(reportFile, range, spec, options);
        }
      });
      trimmed = true;
    }
    if (report && typeof report === "object") {
      dosaiReportSources.set(report, { file: reportFile, trimmed });
    }
    return report;
  } catch (err) {
    if (DEBUG_MODE) {
      console.log(
        `Unable to read the dosai report "${reportFile}": ${err.message}`,
      );
    }
    return undefined;
  }
}

/**
 * Read a dosai methods report of any size.
 *
 * A report that fits in one JavaScript string is parsed whole. A larger one is
 * read in bounded runs, keeping the requested sections, the CallGraph nodes and
 * edges that PackageReachability references, and the MethodCalls accepted by
 * `keepMethodCall` (none when it is omitted). Nothing cdxgen reads is lost.
 *
 * @param {string} reportFile Path to the dosai methods JSON
 * @param {Object} [options] Options
 * @param {string[]} [options.sections] Sections to keep from a large report (default: every section cdxgen reads)
 * @param {Function} [options.keepMethodCall] Predicate choosing the MethodCalls to keep from a large report
 * @param {number} [options.maxTextBytes] Largest report parsed whole, for tests
 * @returns {Object|undefined} Parsed report, or undefined when missing or invalid
 */
export function readDosaiMethodsReport(reportFile, options = {}) {
  const sections = options.sections || DOSAI_METHODS_SECTIONS;
  return readDosaiReport(reportFile, options, (report, read) => {
    for (const section of sections) {
      if (section !== "CallGraph" && section !== "MethodCalls") {
        read(section);
      }
    }
    if (sections.includes("MethodCalls") && options.keepMethodCall) {
      read("MethodCalls", { filter: options.keepMethodCall });
    }
    if (sections.includes("CallGraph")) {
      // CallGraph precedes PackageReachability in the file, which is why the
      // sections are read by range rather than in one pass.
      const edgeIds = referencedIds(report.PackageReachability, "EdgeIds");
      const nodeIds = referencedIds(report.PackageReachability, "NodeIds");
      read("CallGraph", {
        members: {
          Edges: { filter: (edge) => edgeIds.has(edge?.Id) },
          Nodes: { filter: (node) => nodeIds.has(node?.Id) },
        },
      });
    }
  });
}

/**
 * Read a dosai data-flow report of any size.
 *
 * A report that fits in one JavaScript string is parsed whole. A larger one
 * keeps Metadata, Slices, PackageReachability, and the Nodes those reference.
 *
 * @param {string} reportFile Path to the dosai data-flow JSON
 * @param {Object} [options] Options
 * @param {number} [options.maxTextBytes] Largest report parsed whole, for tests
 * @returns {Object|undefined} Parsed report, or undefined when missing or invalid
 */
export function readDosaiDataFlowReport(reportFile, options = {}) {
  return readDosaiReport(reportFile, options, (report, read) => {
    read("Metadata");
    read("Slices");
    read("PackageReachability");
    const nodeIds = referencedIds(report.Slices, "NodeIds");
    for (const id of referencedIds(report.PackageReachability, "NodeIds")) {
      nodeIds.add(id);
    }
    read("Nodes", { filter: (node) => nodeIds.has(node?.Id) });
  });
}

/**
 * Whether a dosai run ended because it ran out of time.
 *
 * dosai has no limit of its own: cdxgen's spawn timeout
 * (CDXGEN_TIMEOUT_MS) stops the process, which reaches the caller only as an
 * ETIMEDOUT error looking like any other failure (issue 4438).
 *
 * @param {Object} result spawnSync result
 * @returns {boolean} true when the run was stopped by the spawn timeout
 */
export function dosaiRunTimedOut(result) {
  return result?.error?.code === "ETIMEDOUT";
}

function formatDuration(ms) {
  if (ms >= 60_000) {
    const minutes = Math.round(ms / 6_000) / 10;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  return `${Math.round(ms / 100) / 10} seconds`;
}

/**
 * Run a dosai subcommand ("methods", "dataflows", or "crypto") against a source
 * tree and write its JSON output to the given file.
 *
 * @param {string} command Dosai subcommand to execute
 * @param {string} src Source directory to analyze
 * @param {string} outputFile Path where the dosai JSON output is written
 * @param {Object} [options] Options carrying dosaiCommand, dataFlowPatterns, patternPacks, or exclude globs
 * @returns {boolean} True when the command succeeded and produced the output file, false otherwise
 */
export function runDosaiCommand(command, src, outputFile, options = {}) {
  if (!DOSAI_COMMANDS.has(command)) {
    return false;
  }
  const executable = safeDosaiExecutable(options.dosaiCommand || dosaiBin());
  const srcPath = safeDosaiPath(src);
  const outputPath = safeDosaiPath(outputFile);
  if (!executable || !srcPath || !outputPath) {
    return false;
  }
  const args = [command, "--path", srcPath, "--o", outputPath];
  if (command === "dataflows") {
    if (options.dataFlowPatterns) {
      const patternsPath = safeDosaiPath(options.dataFlowPatterns);
      if (patternsPath) {
        args.push("--patterns", patternsPath);
      }
    }
    if (options.dataFlowPatternPacks || options.patternPacks) {
      const patternPacks = safeDosaiPatternPacks(
        options.dataFlowPatternPacks || options.patternPacks,
      );
      if (patternPacks) {
        args.push("--pattern-packs", patternPacks);
      }
    }
  } else if (command === "crypto") {
    args.push("--format", "dosai");
  }
  const excludeArgs = dosaiWithoutExclude.has(executable)
    ? []
    : dosaiExcludeArgs(options.exclude, srcPath);
  if (DEBUG_MODE) {
    console.log("Executing", executable, [...args, ...excludeArgs].join(" "));
  }
  let result = safeSpawnSync(executable, [...args, ...excludeArgs], {
    cwd: srcPath,
    shell: false,
  });
  // Dosai releases that predate --exclude reject it. Rerun without it so a
  // user supplied exclude never turns into a missing slice.
  if (
    excludeArgs.length &&
    result?.status !== 0 &&
    dosaiRejectedExclude(result)
  ) {
    dosaiWithoutExclude.add(executable);
    warnDosaiOnce(
      "This dosai build does not support --exclude, so it runs without the exclude patterns. Upgrade dosai or set DOSAI_CMD to a newer build to honour them.",
    );
    result = safeSpawnSync(executable, args, {
      cwd: srcPath,
      shell: false,
    });
  }
  if (dosaiSdkMessage(result)) {
    recordDegradation("dotnet.sdk.missing", {
      ecosystem: "csharp",
      tool: "dotnet",
      impact: "none",
      command: `${basename(executable)} ${args.join(" ")}`,
      detail:
        "dosai reported that no .NET SDK is installed, so the requested dosai analysis could not run.",
    });
    console.log(
      "Dotnet SDK is not installed. Please use the cdxgen dotnet container images to analyze this project with dosai.",
    );
    console.log(
      "Alternatively, download the dosai self-contained binary (-full suffix) from https://github.com/owasp-dep-scan/dosai/releases and set DOSAI_CMD to its location.",
    );
  }
  if (dosaiRunTimedOut(result)) {
    // Visible without debug output: otherwise a stopped dosai reads like any
    // other failure while the scan silently loses its .NET evidence.
    console.warn(
      `WARN: dosai did not finish within ${formatDuration(TIMEOUT_MS)} and was stopped, so its slices are missing or incomplete. Allow more time with CDXGEN_TIMEOUT_MS (milliseconds, every external command).`,
    );
    // A stopped dosai can leave its output half written, and the caller would
    // read the truncated file back as a slice.
    if (safeExistsSync(outputPath)) {
      safeRmSync(outputPath, { force: true });
    }
    return false;
  }
  if (result?.status !== 0 || result?.error || !safeExistsSync(outputPath)) {
    if (DEBUG_MODE) {
      if (result?.stderr || result?.stdout) {
        console.error(result.stdout, result.stderr);
      } else {
        console.log("Check if the dosai plugin was installed successfully.");
      }
    }
    return false;
  }
  return true;
}

/**
 * Produce the dosai methods (call graph) slice for a source tree.
 *
 * @param {string} src Source directory to analyze
 * @param {string} outputFile Path where the methods slice JSON is written
 * @param {Object} [options] Options forwarded to runDosaiCommand
 * @returns {boolean} True when the slice was produced successfully
 */
export function createDosaiMethodsSlice(src, outputFile, options = {}) {
  return runDosaiCommand("methods", src, outputFile, options);
}

/**
 * Produce the dosai data-flow slice for a source tree.
 *
 * @param {string} src Source directory to analyze
 * @param {string} outputFile Path where the data-flow slice JSON is written
 * @param {Object} [options] Options carrying dataFlowPatterns or patternPacks overrides
 * @returns {boolean} True when the slice was produced successfully
 */
export function createDosaiDataFlowSlice(src, outputFile, options = {}) {
  return runDosaiCommand("dataflows", src, outputFile, options);
}

/**
 * Produce the dosai crypto analysis output for a source tree.
 *
 * @param {string} src Source directory to analyze
 * @param {string} outputFile Path where the crypto analysis JSON is written
 * @param {Object} [options] Options forwarded to runDosaiCommand
 * @returns {boolean} True when the analysis was produced successfully
 */
export function createDosaiCryptoAnalysis(src, outputFile, options = {}) {
  return runDosaiCommand("crypto", src, outputFile, options);
}

/**
 * Run dosai crypto analysis in a temporary directory and return the parsed result.
 *
 * @param {string} src Source directory to analyze
 * @param {Object} [options] Options forwarded to createDosaiCryptoAnalysis
 * @returns {Object|undefined} Parsed crypto analysis JSON, or undefined when the analysis fails
 */
export function analyzeDosaiCrypto(src, options = {}) {
  const tempDir = safeMkdtempSync(join(getTmpDir(), "dosai-crypto-"));
  const outputFile = join(tempDir, "dosai-crypto.json");
  try {
    if (!createDosaiCryptoAnalysis(src, outputFile, options)) {
      return undefined;
    }
    return readDosaiJsonFile(outputFile);
  } finally {
    if (tempDir?.startsWith(getTmpDir())) {
      safeRmSync(tempDir, { recursive: true, force: true });
    }
  }
}

/**
 * Build the combined native dosai report object persisted for downstream tools.
 *
 * dosai produces TWO native artifacts (methods + dataflows); we wrap them under
 * a single object that carries the producer Metadata plus both sections so
 * downstream consumers (depscan) read one source of truth. The Metadata is
 * taken from the data-flow slice (richest) and falls back to the methods slice.
 * Native/PascalCase keys are preserved losslessly.
 */
function buildCombinedDosaiReport(methodsSlice, dataFlowSlice) {
  const metadata = dataFlowSlice?.Metadata ||
    methodsSlice?.Metadata || {
      Tool: "Dosai",
    };
  return {
    Metadata: metadata,
    methods: methodsSlice || {},
    dataflows: dataFlowSlice || {},
  };
}

function* fileChunks(filePath) {
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (!count) {
        return;
      }
      yield buffer.subarray(0, count);
    }
  } finally {
    closeSync(fd);
  }
}

// The combined report as JSON text in pieces, with each part copied from its
// native file when there is one. Keys and their order match
// buildCombinedDosaiReport.
function* combinedDosaiReportChunks(combined, parts) {
  yield `{"Metadata":${JSON.stringify(combined.Metadata)}`;
  for (const [key, source] of parts) {
    yield `,${JSON.stringify(key)}:`;
    if (source) {
      yield* fileChunks(source.file);
    } else {
      yield JSON.stringify(combined[key]);
    }
  }
  yield "}";
}

/**
 * Persist the combined native dosai report to options.semanticsSlicesFile.
 *
 * Mirrors the rusi/golem persistence contract (analyzeRusiProject /
 * analyzeGolemProject on branch feat/rusi-persist-report): when a semantics-
 * slices path is provided, the FULL native report is written there and kept so
 * downstream tools (depscan) can consume the complete methods + data-flow
 * facts that cdxgen only projects a subset of into the SBOM evidence. dotnet
 * does not otherwise use the semantics slice (atom is never run for dotnet),
 * so the path is free to carry the combined dosai report. Returns the resolved
 * durable path when something was persisted, otherwise undefined.
 */
export function persistDosaiSemanticsReport(
  options,
  methodsSlice,
  dataFlowSlice,
) {
  const durablePath = options?.semanticsSlicesFile
    ? resolve(options.semanticsSlicesFile)
    : undefined;
  if (!durablePath) {
    return undefined;
  }
  if (
    (!methodsSlice || !Object.keys(methodsSlice).length) &&
    (!dataFlowSlice || !Object.keys(dataFlowSlice).length)
  ) {
    return undefined;
  }
  const combined = buildCombinedDosaiReport(methodsSlice, dataFlowSlice);
  const methodsSource = dosaiReportSources.get(methodsSlice);
  const dataFlowSource = dosaiReportSources.get(dataFlowSlice);
  try {
    let text;
    if (!methodsSource?.trimmed && !dataFlowSource?.trimmed) {
      try {
        text = JSON.stringify(combined);
      } catch (err) {
        // Too large for one string: write it in parts below instead.
        if (!(err instanceof RangeError)) {
          throw err;
        }
      }
    }
    if (text !== undefined) {
      safeWriteSync(durablePath, text);
    } else {
      // A trimmed report lacks the sections cdxgen skipped, so each part is
      // copied from its native file when it has one, and serialised on its
      // own otherwise.
      safeWriteChunksSync(
        durablePath,
        combinedDosaiReportChunks(combined, [
          ["methods", methodsSource],
          ["dataflows", dataFlowSource],
        ]),
      );
    }
  } catch (err) {
    // A part with no native file can still be too large to serialise, and the
    // write can fail. The SBOM evidence is already collected by this point, so
    // skip the durable copy instead of losing the whole analysis.
    recordDegradation("dosai.semantics.persist-failed", {
      ecosystem: "csharp",
      tool: "dosai",
      impact: "none",
      command: `persistDosaiSemanticsReport ${durablePath}`,
      detail: `The combined dosai report could not be persisted: ${err.message}. The SBOM evidence is unaffected.`,
    });
    return undefined;
  }
  return durablePath;
}

/**
 * Build a purl alias map for a list of components.
 *
 * @param {Object[]} [components] Component objects with purl fields
 * @param {Object} [options] Options passed to {@link buildDosaiPurlAliasMap} (`srcPath`)
 * @returns {Map<string, string>} Map of component purls, carrying the version-free identity index
 */
export function buildPurlAliasMap(components = [], options = {}) {
  return buildDosaiPurlAliasMap(components, options);
}

/**
 * Resolve a dosai purl to the canonical component purl, by version, and for a
 * package the BOM holds in several versions by the record's location.
 *
 * @param {string} purl Purl from a dosai report
 * @param {Map<string, string>} purlAliasMap Alias map built by buildPurlAliasMap
 * @param {string} [location] Source location of the dosai record
 * @returns {string|undefined} Canonical component purl, the input purl when the BOM has no such package,
 *          or undefined when empty or ambiguous
 */
export function resolveComponentPurl(purl, purlAliasMap, location) {
  return resolveDosaiComponentPurl(purl, purlAliasMap, location);
}

/**
 * The component purls one PackageReachability fact belongs to: each of its
 * locations resolved in its own project (a versionless purl from unrestored
 * projects spans several), else the purl alone.
 *
 * @param {Object} reachability dosai PackageReachability entry
 * @param {Map<string, string>} purlAliasMap Alias map built by buildPurlAliasMap
 * @param {Object} [graph] Call graph lookups `{ edgesById, nodesById }`
 * @returns {string[]} Component purls
 */
function reachabilityComponentPurls(reachability, purlAliasMap, graph = {}) {
  const locations = [
    ...(reachability.SourceLocations || []).map((location) =>
      dosaiSourceLocation(location),
    ),
    ...(reachability.EdgeIds || []).map((edgeId) =>
      dosaiSourceLocation(graph.edgesById?.get(edgeId)),
    ),
    ...(reachability.NodeIds || []).map((nodeId) =>
      dosaiSourceLocationFromNode(graph.nodesById?.get(nodeId)),
    ),
  ].filter(Boolean);
  const purls = new Set(
    locations
      .map((location) =>
        resolveComponentPurl(reachability.Purl, purlAliasMap, location),
      )
      .filter(Boolean),
  );
  if (!purls.size) {
    const purl = resolveComponentPurl(reachability.Purl, purlAliasMap);
    if (purl) {
      purls.add(purl);
    }
  }
  return [...purls];
}

/**
 * Copy one dosai PackageReachability fact onto a component as properties.
 *
 * The occurrence/location consumers of PackageReachability read SourceLocations, EdgeIds,
 * and NodeIds only, so dosai's Confidence, EvidenceKinds, ReachabilityKind, and
 * ConfidenceReasons never reached the BOM: an unbuilt tree (Low confidence, unresolved
 * evidence) was indistinguishable from a package that really is only imported. These
 * properties carry that distinction to BOM consumers. They use the consumer-facing
 * `cdx:dosai:reachability:*` namespace - not `internal:`, which is cdxgen's private
 * bookkeeping namespace stripped or ignored by downstream tooling.
 *
 * @param {Object} component BOM component object (mutated; properties created on demand)
 * @param {Object} reachability dosai PackageReachability entry
 */
export function addDosaiReachabilityProperties(component, reachability) {
  if (!component || !reachability) {
    return;
  }
  component.properties = component.properties || [];
  const values = {
    "cdx:dosai:reachability:kind": reachability.ReachabilityKind,
    "cdx:dosai:reachability:confidence": reachability.Confidence,
    "cdx:dosai:reachability:evidence": (reachability.EvidenceKinds || []).join(
      ", ",
    ),
    "cdx:dosai:reachability:reasons": (
      reachability.ConfidenceReasons || []
    ).join(" | "),
  };
  for (const [name, value] of Object.entries(values)) {
    if (!value) {
      continue;
    }
    // First fact wins so a repeated enrichment pass cannot stack duplicate properties.
    if (component.properties.some((p) => p.name === name)) {
      continue;
    }
    component.properties.push({ name, value });
  }
}

/**
 * Attach dosai PackageReachability confidence facts to matching BOM components.
 *
 * @param {Object} methodsSlice Parsed dosai methods slice JSON
 * @param {Object[]} [components] BOM components used to resolve purl aliases and mutate
 * @param {Object} [options] Options
 * @param {string} [options.srcPath] Directory dosai analyzed; a package the BOM holds in several
 *        versions is matched by the project of the record's file
 * @returns {number} Number of distinct components enriched
 */
export function applyDosaiReachabilityEvidence(
  methodsSlice,
  components = [],
  options = {},
) {
  const purlAliasMap = buildPurlAliasMap(components, options);
  const componentsByPurl = new Map(
    components
      .filter((component) => component?.purl)
      .map((component) => [component.purl, component]),
  );
  const graph = {
    edgesById: new Map(
      (methodsSlice?.CallGraph?.Edges || []).map((edge) => [edge.Id, edge]),
    ),
    nodesById: new Map(
      (methodsSlice?.CallGraph?.Nodes || []).map((node) => [node.Id, node]),
    ),
  };
  const enriched = new Set();
  // The first fact applied to a component wins, so a fact that names the
  // component's exact purl goes before one that reached it by name.
  const facts = [...(methodsSlice?.PackageReachability || [])].sort(
    (a, b) =>
      Number(!componentsByPurl.has(a.Purl)) -
      Number(!componentsByPurl.has(b.Purl)),
  );
  for (const reachability of facts) {
    for (const purl of reachabilityComponentPurls(
      reachability,
      purlAliasMap,
      graph,
    )) {
      const component = componentsByPurl.get(purl);
      if (!component) {
        continue;
      }
      addDosaiReachabilityProperties(component, reachability);
      enriched.add(component);
    }
  }
  return enriched.size;
}

/**
 * Map a dosai methods slice to per-purl occurrence evidence.
 *
 * Extracts source locations, imported modules, and called methods from the
 * Dependencies and PackageReachability sections of the slice.
 *
 * @param {Object} methodsSlice Parsed dosai methods slice JSON
 * @param {Object[]} [components] BOM components used to resolve purl aliases
 * @param {Object} [options] Options
 * @param {string} [options.srcPath] Directory dosai analyzed; a package the BOM holds in several
 *        versions is matched by the project of the record's file
 * @returns {Object} Object with purlLocationMap, purlModulesMap, and purlMethodsMap keyed by purl
 */
export function collectDosaiPurlEvidence(
  methodsSlice,
  components = [],
  options = {},
) {
  const purlAliasMap = buildPurlAliasMap(components, options);
  const purlLocationMap = {};
  const purlModulesMap = {};
  const purlMethodsMap = {};
  const edgesById = new Map(
    (methodsSlice?.CallGraph?.Edges || []).map((edge) => [edge.Id, edge]),
  );
  const nodesById = new Map(
    (methodsSlice?.CallGraph?.Nodes || []).map((node) => [node.Id, node]),
  );

  for (const dependency of methodsSlice?.Dependencies || []) {
    const purl = resolveComponentPurl(
      dependency.Purl,
      purlAliasMap,
      dependency.Path,
    );
    if (!purl) {
      continue;
    }
    addDosaiSetValue(purlLocationMap, purl, dosaiSourceLocation(dependency));
    addDosaiSetValue(
      purlModulesMap,
      purl,
      dependency.Name || dependency.Namespace,
    );
  }

  for (const reachability of methodsSlice?.PackageReachability || []) {
    // Every location resolves in its own project: a versionless purl from
    // unrestored projects spans projects restored at different versions.
    const resolveAt = (location) =>
      resolveComponentPurl(reachability.Purl, purlAliasMap, location);
    const factPurls = new Set();
    // Modules and methods of call-graph items that name no source file
    // (frames inside the package), held for the fact's own version.
    const unplaced = [];
    let hasExplicitSourceLocations = false;
    for (const sourceLocation of reachability.SourceLocations || []) {
      const location = dosaiSourceLocation(sourceLocation);
      const purl = resolveAt(location);
      addDosaiSetValue(purlLocationMap, purl, location);
      if (purl) {
        factPurls.add(purl);
      }
      hasExplicitSourceLocations ||= Boolean(location);
    }
    for (const edgeId of reachability.EdgeIds || []) {
      const edge = edgesById.get(edgeId);
      const location = dosaiSourceLocation(edge);
      const purl = resolveAt(location ?? edge?.Path);
      const method = edge?.CalledMethodName || edge?.TargetName;
      if (!purl) {
        unplaced.push([purlMethodsMap, method]);
        continue;
      }
      factPurls.add(purl);
      if (!hasExplicitSourceLocations) {
        addDosaiSetValue(purlLocationMap, purl, location);
      }
      addDosaiSetValue(purlMethodsMap, purl, method);
    }
    for (const nodeId of reachability.NodeIds || []) {
      const node = nodesById.get(nodeId);
      const location = dosaiSourceLocationFromNode(node);
      const purl = resolveAt(location);
      const module = node?.ClassName || node?.Module;
      const method = node?.Name || node?.Identity?.MethodName;
      if (!purl) {
        unplaced.push([purlModulesMap, module], [purlMethodsMap, method]);
        continue;
      }
      factPurls.add(purl);
      if (!hasExplicitSourceLocations) {
        addDosaiSetValue(purlLocationMap, purl, location);
      }
      addDosaiSetValue(purlModulesMap, purl, module);
      addDosaiSetValue(purlMethodsMap, purl, method);
    }
    if (factPurls.size === 1) {
      const [purl] = factPurls;
      for (const [map, value] of unplaced) {
        addDosaiSetValue(map, purl, value);
      }
    }
  }
  return { purlLocationMap, purlModulesMap, purlMethodsMap };
}

/**
 * Extract data-flow call frames per component purl from a dosai data-flow result.
 *
 * Frames are derived from slice and PackageReachability node ids, and grouped
 * under every purl referenced by each flow (source, sink, and intermediate).
 *
 * @param {Object} dataFlowResult Parsed dosai data-flow slice JSON
 * @param {Object[]} [components] BOM components used to resolve purl aliases
 * @param {Object} [options] Options
 * @param {string} [options.srcPath] Directory dosai analyzed; a package the BOM holds in several
 *        versions is matched by the project of the record's file
 * @returns {Object} Map of canonical purl to arrays of call-stack frame objects
 */
export function collectDosaiDataFlowFrames(
  dataFlowResult,
  components = [],
  options = {},
) {
  const purlAliasMap = buildPurlAliasMap(components, options);
  const nodesById = new Map(
    (dataFlowResult?.Nodes || []).map((node) => [node.Id, node]),
  );
  const dataFlowFrames = {};
  const addFramesForPurl = (purl, frames) => {
    if (!frames.length) {
      return;
    }
    // The flow runs in the project of its first frame that settles one.
    let componentPurl;
    for (const frame of frames) {
      componentPurl = resolveComponentPurl(
        purl,
        purlAliasMap,
        frame.fullFilename,
      );
      if (componentPurl) {
        break;
      }
    }
    if (!componentPurl) {
      return;
    }
    dataFlowFrames[componentPurl] ??= [];
    dataFlowFrames[componentPurl].push(frames);
  };

  for (const slice of dataFlowResult?.Slices || []) {
    const frames = (slice.NodeIds || [])
      .map((nodeId) => frameFromDosaiNode(nodesById.get(nodeId)))
      .filter(Boolean);
    const purls = new Set(
      [...(slice.Purls || []), slice.SourcePurl, slice.SinkPurl].filter(
        Boolean,
      ),
    );
    for (const purl of purls) {
      addFramesForPurl(purl, frames);
    }
  }

  for (const reachability of dataFlowResult?.PackageReachability || []) {
    const frames = (reachability.NodeIds || [])
      .map((nodeId) => frameFromDosaiNode(nodesById.get(nodeId)))
      .filter(Boolean);
    addFramesForPurl(reachability.Purl, frames);
  }
  return dataFlowFrames;
}

/**
 * Consume dosai's AiComponents[] inventory (schema 4.0.0): model identifiers,
 * on-disk model artifacts with hashes, MCP tools, prompts (redacted), and agents
 * become CycloneDX machine-learning-model / data components with modelCard data.
 *
 * @param {Object} methodsSlice Parsed dosai methods slice JSON
 * @param {Array} [components] Component list to mutate in place
 * @returns {Array} The updated component list
 */
export function collectDosaiAiComponents(methodsSlice, components = []) {
  for (const ai of methodsSlice?.AiComponents || []) {
    if (!ai?.Id || !ai?.Name) {
      continue;
    }
    if (components.some((c) => c["bom-ref"] === ai.Id)) {
      continue;
    }
    if (ai.Kind === "model") {
      const modelCard = {
        modelParameters: {},
      };
      if (ai.Task) {
        modelCard.modelParameters.task = ai.Task;
      }
      if (ai.ArchitectureFamily) {
        modelCard.modelParameters.architectureFamily = ai.ArchitectureFamily;
      }
      if (ai.ModelArchitecture) {
        // modelArchitecture lives under modelParameters; modelCard itself is
        // additionalProperties:false, so placing it at the top level fails validation.
        modelCard.modelParameters.modelArchitecture = ai.ModelArchitecture;
      }
      if (Array.isArray(ai.InputFormats) && ai.InputFormats.length) {
        modelCard.modelParameters.inputs = ai.InputFormats.map((format) => ({
          format,
        }));
      }
      if (Array.isArray(ai.OutputFormats) && ai.OutputFormats.length) {
        modelCard.modelParameters.outputs = ai.OutputFormats.map((format) => ({
          format,
        }));
      }
      const component = {
        "bom-ref": ai.Id,
        type: "machine-learning-model",
        name: ai.Name,
        version: ai.Version,
        purl: ai.Purl,
        modelCard,
        properties: [
          { name: "cdx:ai:provider", value: ai.Provider || "unknown" },
          { name: "cdx:ai:deployment", value: ai.Deployment || "unknown" },
        ],
      };
      if (ai.Sha256) {
        component.hashes = [{ alg: "SHA-256", content: ai.Sha256 }];
      }
      if (ai.FilePath) {
        component.properties.push({
          name: "cdx:ai:modelFile",
          value: ai.FilePath,
        });
      }
      components.push(component);
    } else if (ai.Kind === "prompt" || ai.Kind === "dataset") {
      components.push({
        "bom-ref": ai.Id,
        type: "data",
        name: ai.Name,
        properties: [
          { name: "cdx:ai:kind", value: ai.Kind },
          ...(ai.PromptText
            ? [{ name: "cdx:ai:promptText", value: ai.PromptText }]
            : []),
          ...Object.entries(ai.Properties || {}).map(([name, value]) => ({
            name: `cdx:ai:${name}`,
            value: String(value),
          })),
        ],
      });
    } else if (
      ai.Kind === "tool" ||
      ai.Kind === "agent" ||
      ai.Kind === "guardrail" ||
      ai.Kind === "embedding"
    ) {
      const properties = [
        { name: "cdx:ai:kind", value: ai.Kind },
        { name: "cdx:ai:provider", value: ai.Provider || "unknown" },
      ];
      if (ai.ToolSchema) {
        properties.push({ name: "cdx:ai:toolSchema", value: ai.ToolSchema });
      }
      components.push({
        "bom-ref": ai.Id,
        type: "data",
        name: ai.Name,
        properties,
      });
    }
  }
  return components;
}

/**
 * Consume dosai's first-class Services[] inventory (schema 4.0.0) directly: richer
 * than deriving services from ApiEndpoints alone — stable bom-refs, trust zones,
 * data classifications, providers, and per-service evidence occurrences.
 *
 * @param {Object} methodsSlice Parsed dosai methods slice JSON
 * @param {Object} [servicesMap] Map of service key to service definition, mutated in place
 * @returns {Object} The updated services map
 */
export function collectDosaiServiceComponents(methodsSlice, servicesMap = {}) {
  for (const service of methodsSlice?.Services || []) {
    if (!service?.Id || !service?.Name) {
      continue;
    }
    const key = service.Id;
    const definition = (servicesMap[key] ??= {
      name: service.Name,
      bomRef: service.Id,
      endpoints: new Set(),
      properties: [],
    });
    definition.group = definition.group || service.Group;
    definition.version = definition.version || service.Version;
    // The same service Id can appear in several Services[] entries (one per
    // implementing type or call site). Scalar facts left unset by earlier
    // entries must still be filled from later ones, in particular the
    // outbound provider: an entry that is only inbound must not lock the
    // definition into an anonymous egress.
    if (
      !definition.provider &&
      service.Provider &&
      service.Direction === "outbound"
    ) {
      definition.provider = { name: service.Provider };
    }
    if (typeof definition.authenticated === "undefined") {
      definition.authenticated = service.Authenticated ?? undefined;
    }
    if (!definition.trustZone) {
      definition.trustZone = service.TrustZone;
    }
    if (!definition["x-trust-boundary"]) {
      definition["x-trust-boundary"] =
        service.CrossesTrustBoundary === true ? true : undefined;
    }
    for (const endpoint of service.Endpoints || []) {
      const sanitized = sanitizeEndpoint(endpoint);
      if (sanitized) {
        definition.endpoints.add(sanitized);
      }
    }
    if (Array.isArray(service.Operations) && service.Operations.length) {
      appendUniqueProperty(
        definition.properties,
        "cdx:dosai:operationCount",
        service.Operations.length,
      );
      for (const operation of service.Operations) {
        // Endpoints[] can miss routes that only Operations carry (e.g. gRPC and
        // messaging operations resolved per method), so both are collected.
        const sanitized = sanitizeEndpoint(operation.Path);
        if (sanitized) {
          definition.endpoints.add(sanitized);
        }
        // Verbs are small enum values; they keep the HTTP surface auditable
        // per endpoint without copying request payloads.
        appendUniqueProperty(
          definition.properties,
          "cdx:service:httpMethod",
          operation.HttpMethod,
        );
        if (operation.RouteTemplate && operation.Path) {
          appendUniqueProperty(
            definition.properties,
            "cdx:service:pathTemplate",
            operation.RouteTemplate,
          );
        }
      }
    }
    if (Array.isArray(service.Data) && service.Data.length) {
      // First population of services[].data[] for .NET: flow + classification
      // with auditable descriptions from dosai.
      definition.data = (definition.data || []).concat(
        service.Data
          // `flow` and `classification` are both required by serviceData in the 1.7 schema; an entry
          // missing either fails validation and would fail the whole BOM, so drop it instead.
          .filter((entry) => entry?.Classification && entry?.Flow)
          .map((entry) => ({
            classification: entry.Classification,
            // "unknown" is a legitimate dataFlowDirection member. Coercing it to "bi-directional"
            // turned an absence of knowledge into a positive claim that data flows both ways.
            flow: ["inbound", "outbound", "bi-directional", "unknown"].includes(
              entry.Flow,
            )
              ? entry.Flow
              : "unknown",
            name: entry.Name,
            description: entry.Description,
            // source/destination are arrays of strings (iri-reference or BOM-link) in the schema.
            source: toStringArray(entry.Source),
            destination: toStringArray(entry.Destination),
          })),
      );
    }
    const properties = definition.properties;
    appendUniqueProperty(properties, "cdx:service:kind", service.ServiceKind);
    appendUniqueProperty(
      properties,
      "cdx:service:direction",
      service.Direction,
    );
    appendUniqueProperty(
      properties,
      "cdx:service:framework",
      service.Framework,
    );
    appendUniqueProperty(
      properties,
      "cdx:dosai:confidence",
      service.Confidence,
    );
    for (const tag of service.Tags || []) {
      appendUniqueProperty(properties, "cdx:dosai:tag", tag);
    }
    // Auth surface as counts and scheme categories only; policies, roles, and
    // claim values never cross into the BOM verbatim.
    appendUniqueProperty(
      properties,
      "cdx:dosai:allowAnonymous",
      service.AllowAnonymous,
    );
    for (const scheme of service.AuthenticationSchemes || []) {
      appendUniqueProperty(properties, "cdx:dosai:authScheme", scheme);
    }
    appendUniqueProperty(
      properties,
      "cdx:dosai:authorizationPolicyCount",
      service.AuthorizationPolicies?.length,
    );
    appendUniqueProperty(
      properties,
      "cdx:dosai:roleCount",
      service.Roles?.length,
    );
    if (service.Location?.Path) {
      // Accumulate call sites: a service implemented across files must keep
      // every occurrence, not just the last one processed.
      definition.evidence ??= { occurrences: [] };
      const location = {
        path: service.Location.Path,
        line: service.Location.LineNumber || undefined,
        column: service.Location.ColumnNumber || undefined,
      };
      const occurrenceKey = `${location.path}#${location.line}#${location.column}`;
      const knownOccurrences = definition.evidence.occurrences;
      if (
        !knownOccurrences.some(
          (known) =>
            `${known?.location?.path}#${known?.location?.line}#${known?.location?.column}` ===
            occurrenceKey,
        )
      ) {
        knownOccurrences.push({ location });
      }
      // services[].evidence is a CycloneDX 2.0 field that spec-version
      // compatibility strips below 2.0, so the location also lands in a
      // property where it survives at 1.6 and 1.7.
      appendUniqueProperty(
        definition.properties,
        "cdx:dosai:location",
        `${location.path}:${location.line || 0}:${location.column || 0}`,
      );
    }
  }
  return servicesMap;
}

/**
 * Infer service and endpoint definitions from a dosai methods slice.
 *
 * Sanitizes API endpoint routes, derives stable service names, and records
 * `cdx:dosai:*` properties (http method, auth requirements, claim counts) per
 * service in the supplied map, mutating it in place.
 *
 * @param {Object} methodsSlice Parsed dosai methods slice JSON
 * @param {Object} [servicesMap] Map of service name to service definition, mutated in place
 * @returns {Object} The updated services map
 */
export function collectDosaiServicesFromMethods(
  methodsSlice,
  servicesMap = {},
) {
  const resolvedPaths = hasResolvedEndpointPaths(methodsSlice);
  for (const endpoint of methodsSlice?.ApiEndpoints || []) {
    // Endpoints owned by a provider service (ServiceId set and already
    // collected) enrich the owner instead of being re-derived into a duplicate
    // service. Their method and auth metadata still lands on the owner via the
    // shared property recording below.
    const ownedDefinition =
      endpoint.ServiceId && servicesMap[endpoint.ServiceId]
        ? servicesMap[endpoint.ServiceId]
        : undefined;
    // Schema 4.0.0: Path is the resolved route (tokens substituted, constraints
    // stripped); Route keeps the verbatim template. Preferring Path is the fix for
    // cdxgen discussion #4333, where [controller] shipped as %5Bcontroller%5D.
    const route = sanitizeEndpoint(
      resolvedPaths ? endpoint.Path || endpoint.Route : endpoint.Route,
    );
    if (!ownedDefinition && !route) {
      continue;
    }
    let definition = ownedDefinition;
    if (!definition) {
      const serviceName = serviceNameFromEndpoint(endpoint);
      definition = servicesMap[serviceName] ??= {
        endpoints: new Set(),
        authenticated: endpoint.AuthorizationRequired,
        xTrustBoundary:
          endpoint.AuthorizationRequired === true ? true : undefined,
        properties: [],
      };
    }
    if (route) {
      definition.endpoints.add(route);
    }
    const properties = definition.properties;
    appendUniqueProperty(
      properties,
      "cdx:service:httpMethod",
      endpoint.HttpMethod || "ANY",
    );
    appendUniqueProperty(
      properties,
      "cdx:dosai:endpointKind",
      endpoint.EndpointKind,
    );
    appendUniqueProperty(
      properties,
      "cdx:dosai:authorizationRequired",
      endpoint.AuthorizationRequired,
    );
    appendUniqueProperty(
      properties,
      "cdx:dosai:allowAnonymous",
      endpoint.AllowAnonymous,
    );
    appendUniqueProperty(
      properties,
      "cdx:dosai:authorizationPolicyCount",
      endpoint.AuthorizationPolicies?.length,
    );
    appendUniqueProperty(
      properties,
      "cdx:dosai:roleCount",
      endpoint.Roles?.length,
    );
    appendUniqueProperty(
      properties,
      "cdx:dosai:requiredClaimCount",
      endpoint.RequiredClaims?.length,
    );
    appendUniqueProperty(
      properties,
      "cdx:dosai:requiredScopeCount",
      endpoint.RequiredScopes?.length,
    );
    appendUniqueProperty(
      properties,
      "internal:SrcFile",
      endpoint.FilePath || endpoint.FileName,
    );
    if (endpoint.LineNumber) {
      appendUniqueProperty(
        properties,
        "cdx:dosai:location",
        // Schema 4.0.0 renamed the ApiEndpoint source file field to FilePath;
        // Path carries the resolved route there, not a location.
        `${endpoint.FilePath || endpoint.FileName}:${endpoint.LineNumber}:${endpoint.ColumnNumber || 0}`,
      );
    }
    if (endpoint.Route && endpoint.Path && endpoint.Route !== endpoint.Path) {
      // The verbatim template (e.g. api/[controller]/{id:int}) alongside the resolved path.
      appendUniqueProperty(
        properties,
        "cdx:service:pathTemplate",
        endpoint.Route,
      );
    }
    if (endpoint.Confidence) {
      appendUniqueProperty(
        properties,
        "cdx:dosai:confidence",
        endpoint.Confidence,
      );
    }
  }
  return servicesMap;
}

/**
 * Normalize a services map into a sorted array of CycloneDX service objects.
 *
 * @param {Object} [servicesMap] Map of service name to service definition with Set-backed endpoints
 * @returns {Object[]} Array of service objects with sorted endpoint arrays and properties
 */
export function normalizeDosaiServiceMap(servicesMap = {}) {
  return Object.keys(servicesMap)
    .map((serviceName) => {
      const definition = servicesMap[serviceName];
      const service = {
        name:
          definition.name ||
          serviceName ||
          `dosai-${basename(serviceName)}-service`,
        endpoints: Array.from(definition.endpoints || []).sort(),
        authenticated: definition.authenticated,
        // Accept both spellings. Every pre-4.0.0 producer — collectDosaiServicesFromMethods here, and
        // the OpenAPI/Java/Python paths in evinser.js — sets the camelCase `xTrustBoundary`; only the
        // new Services[] path sets the hyphenated CycloneDX key. Reading just the latter silently
        // dropped the flag for all of them, including languages dosai has nothing to do with.
        "x-trust-boundary":
          definition["x-trust-boundary"] ?? definition.xTrustBoundary,
        properties: definition.properties,
      };
      if (definition.bomRef) {
        service["bom-ref"] = definition.bomRef;
      }
      if (definition.group) {
        service.group = definition.group;
      }
      if (definition.version) {
        service.version = definition.version;
      }
      if (definition.trustZone) {
        service.trustZone = definition.trustZone;
      }
      if (definition.provider) {
        service.provider = definition.provider;
      }
      if (definition.data) {
        service.data = definition.data;
      }
      if (definition.evidence) {
        service.evidence = definition.evidence;
      }
      return service;
    })
    .filter((service) => service.name);
}
