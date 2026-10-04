import {
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { tmpdir, totalmem } from "node:os";
import {
  delimiter as _delimiter,
  basename,
  dirname,
  join,
  resolve,
} from "node:path";
import process from "node:process";

import {
  DEBUG_MODE,
  isSecureMode,
  readEnvironmentVariable,
} from "../core/activity.js";
import {
  safeExistsSync,
  safeMkdtempSync,
  safeRmSync,
  safeSpawnSync,
  TIMEOUT_MS,
} from "../core/fs.js";
import { TRACE_MODE } from "../core/logger.js";
import { dirNameStr, isWin } from "../core/paths.js";
import { readJsonFile } from "../parsers/largeJson.js";
import { cmakeBuildDirCandidates } from "./cmakeBuildDirs.js";

const ASTGEN_DEFAULT_IGNORE_DIRS = [
  "venv",
  "docs",
  "e2e",
  "e2e-beta",
  "examples",
  "cypress",
  "jest-cache",
  "eslint-rules",
  "codemods",
  "flow-typed",
  "i18n",
];

const ATOM_JS_LANGUAGES = new Set([
  "javascript",
  "js",
  "jsx",
  "node",
  "nodejs",
  "typescript",
  "ts",
  "tsx",
]);

// atom 3 ships per-platform sub-packages. The native sub-packages embed a
// GraalVM native image (`bin/atom`) and need no JDK; the jar sub-packages
// carry `plugins/` (jars + launchers) and require Java 23+. This set must stay
// in lockstep with `NATIVE_PACKAGES` in @appthreat/atom/resolve.js; the
// `atomProviderKind` parity test in atomUtils.poku.js guards the drift.
/**
 * Platform-specific @appthreat/atom-* native package names that carry the
 * bundled native `atom` binary.
 */
export const ATOM_NATIVE_PACKAGES = new Set([
  "@appthreat/atom-linux-amd64",
  "@appthreat/atom-linux-arm64",
  "@appthreat/atom-darwin-arm64",
  "@appthreat/atom-linux-amd64-musl",
  "@appthreat/atom-windows-amd64",
]);

const ATOM_PHP_LANGUAGES = new Set(["php"]);

/** atom `-l` values that parse C/C++ headers without function bodies. */
const ATOM_HEADER_LANGUAGES = new Set(["h", "hpp", "i"]);

/** atom `-l` values handled by the C/C++ frontend. */
const ATOM_C_LANGUAGES = new Set([
  "c",
  "cpp",
  "c++",
  "newc",
  ...ATOM_HEADER_LANGUAGES,
]);

const COMPILE_COMMANDS_FILE = "compile_commands.json";

/**
 * Characters a Windows shell command line would interpret: `&`, `|`, `<` and
 * `>` chain or redirect commands, `%` expands variables even inside quotes,
 * `^` escapes, `!` expands under delayed expansion, and a quote breaks the
 * quoting Node applies to arguments when `shell` is on. A database is often
 * discovered inside the scanned tree, so its path is not trusted input.
 */
const UNSAFE_SHELL_CHARS_RE = /[\r\n\t&|<>%^!"]/;

function compileCommandsIn(dir) {
  for (const candidate of [
    join(dir, COMPILE_COMMANDS_FILE),
    join(dir, "build", COMPILE_COMMANDS_FILE),
  ]) {
    try {
      if (statSync(candidate).isFile()) {
        return candidate;
      }
    } catch (_err) {
      // not there
    }
  }
  return undefined;
}

/**
 * Locate the JSON compilation database (`compile_commands.json`) of a C/C++
 * project, which lets atom parse each file with the include paths, macros and
 * language its build uses.
 *
 * An explicit `options.compileCommands` (a file, or a directory holding one
 * directly or under `build/`) wins. Otherwise the scan root and the project's
 * build directories are searched: the directory of `options.cmakeCache`, the
 * build directories of its CMake presets, and the conventional `build`,
 * `out`, `builddir` and `cmake-build-` directories (see
 * `cmakeBuildDirCandidates`). A database can come with the code it describes,
 * and atom asks the
 * GCC or Clang driver it names (from the PATH, or an absolute path outside
 * the project) for its predefined macros, so in secure mode only an explicit
 * database is used.
 *
 * @param {string} src Project scan root
 * @param {Object} options CLI options
 * @returns {string|undefined} Absolute path of the database
 */
export function findCompileCommands(src, options = {}) {
  if (options.compileCommands) {
    const requested = resolve(`${options.compileCommands}`);
    let found;
    try {
      found = statSync(requested).isDirectory()
        ? compileCommandsIn(requested)
        : requested;
    } catch (_err) {
      found = undefined;
    }
    if (!found) {
      console.warn(
        `No compilation database at ${requested}. Parsing the C/C++ sources without one.`,
      );
    }
    return found;
  }
  if (isSecureMode || !src) {
    return undefined;
  }
  const root = resolve(src);
  let rootIsDir = false;
  try {
    rootIsDir = statSync(root).isDirectory();
  } catch (_err) {
    return undefined;
  }
  if (!rootIsDir) {
    return undefined;
  }
  const dirs = [root, ...cmakeBuildDirCandidates(root, options)];
  for (const dir of dirs) {
    const candidate = join(dir, COMPILE_COMMANDS_FILE);
    try {
      if (statSync(candidate).isFile()) {
        return candidate;
      }
    } catch (_err) {
      // not there
    }
  }
  return undefined;
}

const atomFrontendArgKeysCache = new Map();

/**
 * Split an atom command that may carry a leading argument (`node
 * script.js`, a custom `ATOM_CMD`) into its binary and that argument. The
 * first space only splits when it can: a binary under a path with spaces
 * (`C:\Program Files\...\node.exe script.js`) would otherwise be cut
 * mid-path and the shell told to run `C:\Program`. A command name without a
 * path separator (`node script.js`) resolves through the PATH, so it splits
 * at its first space as before; otherwise the first prefix that exists as a
 * file is the binary, and when none does the first space keeps the old
 * behaviour.
 *
 * @param {string} command The atom command, possibly with an argument
 * @returns {[string, string|undefined]} The binary and its leading argument, when present
 */
export function splitAtomCommand(command) {
  const firstSpace = `${command}`.indexOf(" ");
  if (firstSpace === -1) {
    return [`${command}`, undefined];
  }
  const head = command.slice(0, firstSpace);
  if (!/[/\\]/.test(head)) {
    return [head, command.slice(firstSpace + 1)];
  }
  let splitAt = firstSpace;
  let index = firstSpace;
  while ((index = command.indexOf(" ", index + 1)) !== -1) {
    try {
      if (statSync(command.slice(0, index)).isFile()) {
        splitAt = index;
        break;
      }
    } catch (_err) {
      // not a file; a later space may still split at the real binary
    }
  }
  return [command.slice(0, splitAt), command.slice(splitAt + 1)];
}

/**
 * The `--frontend-args` keys the installed atom accepts for a language, as
 * `atom --frontend-args-keys -l <language>` lists them. Asked once per atom
 * command and language. An atom that cannot list them (a release without
 * `--frontend-args`, or one that fails to start) accepts none.
 *
 * @param {string} language atom `-l` value
 * @returns {Set<string>} Supported keys
 */
export function atomFrontendArgKeys(language) {
  const command = getAtomCommand();
  const cacheKey = `${command}\u0000${language}`;
  if (atomFrontendArgKeysCache.has(cacheKey)) {
    return atomFrontendArgKeysCache.get(cacheKey);
  }
  const [bin, leadingArg] = splitAtomCommand(command);
  const args = ["--frontend-args-keys", "-l", `${language}`];
  if (leadingArg !== undefined) {
    args.unshift(leadingArg);
  }
  const env = { ...process.env };
  if (readEnvironmentVariable("ATOM_JAVA_HOME")) {
    env.JAVA_HOME = readEnvironmentVariable("ATOM_JAVA_HOME");
  }
  const keys = new Set();
  const result = safeSpawnSync(bin, args, {
    shell: isWin,
    env,
    timeout: 120000,
  });
  if (result?.status === 0 && result.stdout) {
    let inTable = false;
    for (const line of `${result.stdout}`.split(/\r?\n/)) {
      if (line.startsWith("----")) {
        inTable = true;
      } else if (inTable && /^[a-z][a-z0-9-]*\s/.test(line)) {
        keys.add(line.split(/\s+/)[0]);
      }
    }
  }
  if (DEBUG_MODE && !keys.size) {
    console.log(
      `The installed atom did not list its --frontend-args keys for ${language}.`,
    );
  }
  atomFrontendArgKeysCache.set(cacheKey, keys);
  return keys;
}

/**
 * The `--frontend-args` atom takes for a C/C++ language: the project's
 * compilation database, when there is one and the installed atom reads it
 * (atom 4 and later). An older atom is given the arguments it has always
 * been given, and parses the sources without the database.
 *
 * @param {string} src Project scan root
 * @param {string} language atom `-l` value
 * @param {Object} options CLI options
 * @returns {string[]} Arguments to add to the atom command
 */
export function atomCompileCommandsArgs(src, language, options = {}) {
  if (!ATOM_C_LANGUAGES.has(`${language}`.toLowerCase())) {
    return [];
  }
  const database = findCompileCommands(src, options);
  if (!database) {
    return [];
  }
  // --frontend-args separates its key=value pairs with commas
  if (database.includes(",")) {
    console.warn(
      `The compilation database path ${database} contains a comma, which atom cannot take. Parsing the C/C++ sources without it.`,
    );
    return [];
  }
  // The argument reaches a Windows shell command line through `shell: isWin`
  // in executeAtom, and the path is routinely discovered inside the scanned
  // tree, so a database whose path a shell would interpret is never passed on.
  if (UNSAFE_SHELL_CHARS_RE.test(database)) {
    console.warn(
      `The compilation database path ${database} contains characters a shell would interpret. Parsing the C/C++ sources without it.`,
    );
    return [];
  }
  if (!atomFrontendArgKeys(language).has("compile-commands")) {
    return [];
  }
  if (DEBUG_MODE) {
    console.log(`Passing the compilation database ${database} to atom.`);
  }
  return ["--frontend-args", `compile-commands=${database}`];
}

// Absolute ceiling on atom's heap. Past this point a larger heap buys a
// collector that runs less often rather than an analysis that succeeds where it
// otherwise would not, while the reservation itself is what pushes a build
// agent into swap or an OOM kill.
const ATOM_MAX_HEAP_CAP_BYTES = 8 * 1024 ** 3;

// A heap this small still completes the repository fixtures, so it is the floor
// applied on memory-constrained containers rather than a target.
const ATOM_MIN_HEAP_FLOOR_BYTES = 2 * 1024 ** 3;

// Below this, slicing a large project is slow before it is fatal, so the run is
// worth a warning even though it is allowed to proceed.
const ATOM_COMFORTABLE_HEAP_BYTES = 7 * 1024 ** 3;

// atom is spawned once per language and the ceiling is identical every time, so
// the warning belongs to the ceiling rather than to each spawn.
let warnedAtomHeapCeiling;

function escapeScalaRegexLiteral(value) {
  return value.replace(/[\\^$*+?.()|[\]{}]/g, "\\$&");
}

function normalizeGlobPattern(pattern) {
  pattern = `${pattern}`;
  let normalizedPattern = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char !== "\\") {
      normalizedPattern += char;
      continue;
    }
    const nextChar = pattern[i + 1];
    if (nextChar && "*?[]{}()!+@,".includes(nextChar)) {
      normalizedPattern += char;
      normalizedPattern += nextChar;
      i++;
    } else {
      normalizedPattern += "/";
    }
  }
  return normalizedPattern.replace(/^\.\//, "");
}

function splitGlobAlternates(value, separator = ",") {
  const alternates = [];
  let current = "";
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === "\\") {
      current += char;
      if (i + 1 < value.length) {
        current += value[++i];
      }
      continue;
    }
    if (char === "[" && bracketDepth === 0) {
      bracketDepth++;
    } else if (char === "]" && bracketDepth > 0) {
      bracketDepth--;
    } else if (!bracketDepth) {
      if (char === "{") {
        braceDepth++;
      } else if (char === "}" && braceDepth > 0) {
        braceDepth--;
      } else if (char === "(") {
        parenDepth++;
      } else if (char === ")" && parenDepth > 0) {
        parenDepth--;
      } else if (char === separator && braceDepth === 0 && parenDepth === 0) {
        alternates.push(current);
        current = "";
        continue;
      }
    }
    current += char;
  }
  alternates.push(current);
  return alternates;
}

function findClosingGlobToken(value, startIndex, openChar, closeChar) {
  if (openChar === "[") {
    for (let i = startIndex + 1; i < value.length; i++) {
      if (value[i] === "\\") {
        i++;
      } else if (value[i] === closeChar) {
        return i;
      }
    }
    return -1;
  }
  let depth = 0;
  let inBracket = false;
  for (let i = startIndex; i < value.length; i++) {
    const char = value[i];
    if (char === "\\") {
      i++;
      continue;
    }
    if (char === "[" && !inBracket) {
      inBracket = true;
    } else if (char === "]" && inBracket) {
      inBracket = false;
    } else if (!inBracket) {
      if (char === openChar) {
        depth++;
      } else if (char === closeChar) {
        depth--;
        if (depth === 0) {
          return i;
        }
      }
    }
  }
  return -1;
}

function globCharClassToRegex(value) {
  if (!value.length) {
    return "\\[";
  }
  let classValue = value;
  let prefix = "";
  if (classValue[0] === "!" || classValue[0] === "^") {
    prefix = "^";
    classValue = classValue.slice(1);
  }
  if (!classValue.length) {
    return "\\[";
  }
  classValue = classValue.replace(/\\/g, "\\\\").replace(/]/g, "\\]");
  return `[${prefix}${classValue}]`;
}

function globSegmentToScalaRegex(segment) {
  let regex = "";
  for (let i = 0; i < segment.length; i++) {
    const char = segment[i];
    const nextChar = segment[i + 1];
    if (char === "\\") {
      if (i + 1 < segment.length) {
        regex += escapeScalaRegexLiteral(segment[++i]);
      } else {
        regex += "\\\\";
      }
    } else if (char === "*" && nextChar !== "(") {
      regex += "[^/\\\\]*";
    } else if (char === "?" && nextChar !== "(") {
      regex += "[^/\\\\]";
    } else if (char === "[") {
      const bracketEnd = findClosingGlobToken(segment, i, "[", "]");
      if (bracketEnd === -1) {
        regex += "\\[";
      } else {
        regex += globCharClassToRegex(segment.slice(i + 1, bracketEnd));
        i = bracketEnd;
      }
    } else if (char === "{") {
      const braceEnd = findClosingGlobToken(segment, i, "{", "}");
      if (braceEnd === -1) {
        regex += "\\{";
      } else {
        const alternates = splitGlobAlternates(
          segment.slice(i + 1, braceEnd),
        ).map((alternate) => globSegmentToScalaRegex(alternate));
        regex += `(?:${alternates.join("|")})`;
        i = braceEnd;
      }
    } else if (["@", "?", "+", "*", "!"].includes(char) && nextChar === "(") {
      const parenEnd = findClosingGlobToken(segment, i + 1, "(", ")");
      if (parenEnd === -1) {
        regex += escapeScalaRegexLiteral(char);
      } else {
        const alternates = splitGlobAlternates(
          segment.slice(i + 2, parenEnd),
          "|",
        ).map((alternate) => globSegmentToScalaRegex(alternate));
        const alternateRegex = `(?:${alternates.join("|")})`;
        if (char === "@") {
          regex += alternateRegex;
        } else if (char === "?") {
          regex += `${alternateRegex}?`;
        } else if (char === "+") {
          regex += `${alternateRegex}+`;
        } else if (char === "*") {
          regex += `${alternateRegex}*`;
        } else {
          regex += `(?!(?:${alternates.join("|")})$)[^/\\\\]*`;
        }
        i = parenEnd;
      }
    } else {
      regex += escapeScalaRegexLiteral(char);
    }
  }
  return regex;
}

function getExcludePatterns(options = {}) {
  if (!Array.isArray(options.exclude)) {
    return [];
  }
  return options.exclude
    .flatMap((pattern) => {
      pattern = `${pattern}`;
      return pattern.includes(",") && !pattern.includes("{")
        ? pattern.split(",")
        : [pattern];
    })
    .map((pattern) => pattern.trim())
    .filter(Boolean)
    .filter((pattern) => !pattern.startsWith("!"));
}

function extractIgnoreDirsFromExcludePatterns(
  patterns,
  includeExactPathFragments = false,
) {
  const ignoreDirs = new Set();
  for (const pattern of patterns) {
    const normalizedPattern = normalizeGlobPattern(pattern);
    const isExactPath = !/[!*?{}[\]]/.test(normalizedPattern);
    const segments = normalizedPattern.split("/").filter(Boolean);
    const literalSegments = segments.filter(
      (segment) =>
        !/[!*?{}[\]]/.test(segment) && segment !== "." && segment !== "..",
    );
    if (!literalSegments.length) {
      continue;
    }
    const dirName = literalSegments.at(-1);
    if (
      dirName &&
      ((includeExactPathFragments && isExactPath) ||
        !dirName.includes(".") ||
        segments.at(-1) !== dirName)
    ) {
      ignoreDirs.add(dirName);
    }
  }
  return Array.from(ignoreDirs);
}

function globToScalaRegexFragment(pattern) {
  pattern = normalizeGlobPattern(pattern);
  const isAbsolute = pattern.startsWith("/");
  const segments = pattern.split("/").filter(Boolean);
  if (!segments.length) {
    return "$^";
  }
  if (segments.length === 1 && segments[0] === "**") {
    return ".*";
  }
  let regex = isAbsolute ? "^[/\\\\]" : "(?:^|.*[/\\\\])";
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const isLast = i === segments.length - 1;
    const nextSegment = segments[i + 1];
    if (segment === "**") {
      if (i === 0) {
        continue;
      }
      if (isLast) {
        regex += "(?:[/\\\\].*)?";
      } else {
        regex += "(?:[/\\\\][^/\\\\]+)*[/\\\\]";
      }
      continue;
    }
    regex += globSegmentToScalaRegex(segment);
    if (!isLast && nextSegment !== "**") {
      regex += "[/\\\\]";
    }
  }
  return `${regex}$`;
}

/**
 * Convert cdxgen's glob-style exclude patterns to a Scala/Java regex string.
 *
 * @param {string[]} patterns Glob patterns from cdxgen's `--exclude` option
 * @returns {string|undefined} Scala-compatible regex or undefined when empty
 */
export function globPatternsToAtomIgnoreRegex(patterns = []) {
  const fragments = getExcludePatterns({ exclude: patterns }).map((pattern) =>
    globToScalaRegexFragment(pattern),
  );
  if (!fragments.length) {
    return undefined;
  }
  return `(?:${fragments.join("|")})`;
}

/**
 * Determine whether a file path is excluded by the given atom-style glob
 * exclude patterns.
 *
 * @param {string} filePath File path to test.
 * @param {string[]} [patterns=[]] Glob exclude patterns.
 * @returns {boolean} True when the path matches an exclude pattern.
 */
export function isPathExcludedByGlobPatterns(filePath, patterns = []) {
  const atomIgnoreRegex = globPatternsToAtomIgnoreRegex(patterns);
  if (!atomIgnoreRegex) {
    return false;
  }
  const normalizedPath = `${filePath}`.replace(/\\/g, "/").replace(/^\.\//, "");
  let regex;
  try {
    // The pattern is compiled from globs by globToScalaRegexFragment, which
    // escapes every literal it emits, so a pattern the engine rejects means the
    // glob itself was malformed and nothing should be excluded on its account.
    regex = new RegExp(atomIgnoreRegex);
  } catch (_e) {
    return false;
  }
  return regex.test(normalizedPath) || regex.test(`./${normalizedPath}`);
}

/**
 * Remove atom-slice entries whose source file matches the given glob exclude
 * patterns, preserving the original slice structure otherwise.
 *
 * Filters `objectSlices`, `userDefinedTypes`, `reachables`, and reachable
 * `paths`/`graph` nodes/edges that reference excluded files.
 *
 * @param {object|Array} sliceData Atom slice data object or array.
 * @param {string[]} [patterns=[]] Glob exclude patterns.
 * @returns {object|Array} Filtered slice data (shallow copy when an object).
 */
export function filterAtomSlicesByExcludePatterns(sliceData, patterns = []) {
  if (!sliceData || !getExcludePatterns({ exclude: patterns }).length) {
    return sliceData;
  }
  const shouldKeepFile = (fileName) =>
    !fileName || !isPathExcludedByGlobPatterns(fileName, patterns);
  if (Array.isArray(sliceData)) {
    return sliceData.filter((slice) => shouldKeepFile(slice.fileName));
  }
  const filteredSliceData = { ...sliceData };
  if (Array.isArray(filteredSliceData.objectSlices)) {
    filteredSliceData.objectSlices = filteredSliceData.objectSlices.filter(
      (slice) => shouldKeepFile(slice.fileName),
    );
  }
  if (Array.isArray(filteredSliceData.userDefinedTypes)) {
    filteredSliceData.userDefinedTypes =
      filteredSliceData.userDefinedTypes.filter((slice) =>
        shouldKeepFile(slice.fileName),
      );
  }
  if (Array.isArray(filteredSliceData.reachables)) {
    filteredSliceData.reachables = filteredSliceData.reachables.filter(
      (reachable) =>
        (reachable.flows || []).every((flow) =>
          shouldKeepFile(flow.parentFileName || flow.fileName),
        ),
    );
  }
  if (
    filteredSliceData.graph?.nodes &&
    Array.isArray(filteredSliceData.paths)
  ) {
    const excludedNodeIds = new Set(
      filteredSliceData.graph.nodes
        .filter((node) => !shouldKeepFile(node.parentFileName || node.fileName))
        .map((node) => node.id),
    );
    filteredSliceData.paths = filteredSliceData.paths.filter((path) =>
      path.every((nodeId) => !excludedNodeIds.has(nodeId)),
    );
    const retainedNodeIds = new Set(filteredSliceData.paths.flat());
    filteredSliceData.graph = {
      ...filteredSliceData.graph,
      nodes: filteredSliceData.graph.nodes.filter(
        (node) => retainedNodeIds.has(node.id) || !excludedNodeIds.has(node.id),
      ),
      edges: (filteredSliceData.graph.edges || []).filter((edge) => {
        const source = edge.src ?? edge.source;
        const destination = edge.dst ?? edge.destination;
        return (
          !excludedNodeIds.has(source) && !excludedNodeIds.has(destination)
        );
      }),
    };
  }
  return filteredSliceData;
}

function mergeCsvValues(...valueLists) {
  const values = new Set();
  for (const valueList of valueLists) {
    if (Array.isArray(valueList)) {
      valueList.forEach((value) => {
        values.add(`${value}`.trim());
      });
    } else if (typeof valueList === "string" && valueList.length) {
      valueList.split(",").forEach((value) => {
        values.add(value.trim());
      });
    }
  }
  return Array.from(values).filter(Boolean).join(",");
}

function mergeRegexValues(...regexValues) {
  const values = regexValues
    .map((regexValue) => `${regexValue || ""}`.trim())
    .filter(Boolean);
  if (!values.length) {
    return undefined;
  }
  return values.map((regexValue) => `(?:${regexValue})`).join("|");
}

/**
 * Build additional environment variables for Atom from cdxgen CLI options.
 *
 * @param {Object} options CLI options
 * @param {string} language Atom language name
 * @returns {Object} Environment variables to pass to Atom
 */
export function buildAtomCommandEnv(options = {}, language = "") {
  const excludePatterns = getExcludePatterns(options);
  const normalizedLanguage = `${language}`.toLowerCase();
  // PHP frontend: the atom 3 dispatcher clobbers PHP_PARSER_BIN with a path
  // that does not exist on native platforms, and atom 3.0.x crashes parsing
  // that bogus value. Forward the resolved php-parse location through the env
  // so executeAtom can bypass the dispatcher for PHP (see
  // resolveDirectAtomBinaryPath). PHP_ASTGEN_BIN additionally names the
  // batch-capable generator (phpastgen.js): chen parses the whole tree, vendor
  // included, in one generator run instead of one php interpreter per file,
  // which on windows is the difference between minutes and hours. Computed
  // independently of exclude patterns.
  const phpParseBin = ATOM_PHP_LANGUAGES.has(normalizedLanguage)
    ? resolvePhpParseBin()
    : undefined;
  const phpAstgenBin = ATOM_PHP_LANGUAGES.has(normalizedLanguage)
    ? resolvePhpAstgenBin()
    : undefined;
  const phpEnv = {};
  if (phpParseBin) {
    phpEnv.PHP_PARSER_BIN = phpParseBin;
  }
  if (phpAstgenBin) {
    phpEnv.PHP_ASTGEN_BIN = phpAstgenBin;
  }
  if (!excludePatterns.length) {
    return phpEnv;
  }
  const chenIgnoreDirs = mergeCsvValues(
    readEnvironmentVariable("CHEN_IGNORE_DIRS"),
    extractIgnoreDirsFromExcludePatterns(excludePatterns, true),
  );
  const env = { ...phpEnv };
  if (chenIgnoreDirs) {
    env.CHEN_IGNORE_DIRS = chenIgnoreDirs;
  }
  const atomIgnoreRegex = globPatternsToAtomIgnoreRegex(excludePatterns);
  if (ATOM_JS_LANGUAGES.has(normalizedLanguage)) {
    const astgenBaseIgnoreDirs =
      readEnvironmentVariable("ASTGEN_IGNORE_DIRS") === undefined
        ? ASTGEN_DEFAULT_IGNORE_DIRS
        : readEnvironmentVariable("ASTGEN_IGNORE_DIRS");
    const astgenIgnoreDirs = mergeCsvValues(
      astgenBaseIgnoreDirs,
      "node_modules",
      extractIgnoreDirsFromExcludePatterns(excludePatterns),
    );
    if (astgenIgnoreDirs) {
      env.ASTGEN_IGNORE_DIRS = astgenIgnoreDirs;
    }
    const astgenIgnoreFilePattern = mergeRegexValues(
      readEnvironmentVariable("ASTGEN_IGNORE_FILE_PATTERN"),
      atomIgnoreRegex,
    );
    if (astgenIgnoreFilePattern) {
      env.ASTGEN_IGNORE_FILE_PATTERN = astgenIgnoreFilePattern;
    }
  }
  return env;
}

/**
 * Detect the libc flavour on Linux without shelling out. Mirrors the cheap
 * branches of atom's `getLinuxLibc` (Alpine release file first, then glibc
 * default). atom additionally consults `process.report` and `ldd --version`;
 * those are only needed to disambiguate exotic setups and are intentionally not
 * reproduced here to keep this call subprocess-free.
 */
function detectLinuxLibc() {
  if (safeExistsSync("/etc/alpine-release")) {
    return "musl";
  }
  return "glibc";
}

/**
 * Resolve the atom platform sub-package name and provider kind for the current
 * (or supplied) runtime. This is a cdxgen-side reimplementation of atom's own
 * `resolveAtomProvider`, kept here rather than imported from
 * `@appthreat/atom/resolve.js` so it is safe under every cdxgen runtime
 * (node, bun, deno, caxa) and inside the extracted caxa tree where the
 * dispatcher's own resolver may not find a sibling sub-package.
 *
 * The returned `preferredPkg`/`kind` pair must agree with atom's
 * `resolveAtomProvider` and `NATIVE_PACKAGES`; the parity test in
 * atomUtils.poku.js asserts the agreement for all eight published triples.
 *
 * @param {Object} [opts] Optional overrides for testability
 * @param {string} [opts.platform] Defaults to `process.platform`
 * @param {string} [opts.arch] Defaults to `process.arch`
 * @param {string} [opts.libc] Defaults to detected libc on linux
 * @returns {{preferredPkg: string, kind: "native"|"jar", platform: string, arch: string, libc?: string}}
 */
export function resolveAtomProvider(opts = {}) {
  const platform = opts.platform || process.platform;
  const arch = opts.arch || process.arch;
  let libc = opts.libc;
  if (platform === "linux" && !libc) {
    libc = detectLinuxLibc();
  }
  let preferredPkg = "@appthreat/atom-jar";
  let kind = "jar";
  if (platform === "win32") {
    if (arch === "x64") {
      preferredPkg = "@appthreat/atom-windows-amd64";
      kind = "native";
    } else if (arch === "arm64") {
      preferredPkg = "@appthreat/atom-windows-arm64";
      kind = "jar";
    }
  } else if (platform === "darwin") {
    if (arch === "arm64") {
      preferredPkg = "@appthreat/atom-darwin-arm64";
      kind = "native";
    } else if (arch === "x64") {
      preferredPkg = "@appthreat/atom-darwin-amd64";
      kind = "jar";
    }
  } else if (platform === "linux") {
    if (arch === "x64") {
      preferredPkg =
        libc === "musl"
          ? "@appthreat/atom-linux-amd64-musl"
          : "@appthreat/atom-linux-amd64";
      kind = "native";
    } else if (arch === "arm64") {
      if (libc === "musl") {
        preferredPkg = "@appthreat/atom-linux-arm64-musl";
        kind = "jar";
      } else {
        preferredPkg = "@appthreat/atom-linux-arm64";
        kind = "native";
      }
    }
  }
  return { preferredPkg, kind, platform, arch, libc };
}

/**
 * Returns `"native"` or `"jar"` for the atom provider that will actually run.
 *
 * The platform decides which provider atom prefers, but the dispatcher falls
 * back to the jar package when the platform's native package is not installed
 * (optional dependencies skipped, a failed download). The two take the heap
 * ceiling differently, and a native-image runtime option on a jar run reaches
 * atom as an unknown argument that fails every slice. So the kind follows what
 * is installed where cdxgen can see it: the native binary means native, the jar
 * package without it means jar. An `ATOM_CMD` is classified by what it names
 * (see `atomCommandKind`). With nothing in view (an install elsewhere) the
 * platform's kind stands.
 *
 * Also used to gate Java/JDK advice, so users on the five native platforms are
 * not told to install a JDK for a failure that has nothing to do with Java.
 */
export function atomProviderKind() {
  const { kind } = resolveAtomProvider();
  if (readEnvironmentVariable("ATOM_CMD")) {
    return atomCommandKind(readEnvironmentVariable("ATOM_CMD"), kind);
  }
  if (kind !== "native") {
    return kind;
  }
  const atomHome = readEnvironmentVariable("ATOM_HOME");
  if (atomHome) {
    // A jar install's ATOM_HOME is its plugins/ directory, which carries lib/;
    // a native sub-package directory does not.
    return safeExistsSync(join(atomHome, "lib")) ? "jar" : kind;
  }
  if (resolveDirectAtomBinaryPath()) {
    return "native";
  }
  const jarPlugins = atomSubPackageCandidates("atom-jar").some((dir) =>
    safeExistsSync(join(dir, "plugins")),
  );
  return jarPlugins ? "jar" : kind;
}

/**
 * Whether `ATOM_CMD` launches a jar or follows the platform.
 *
 * The jar launchers (`plugins/bin/atom`, `plugins/bin/atom.bat`) sit next to a
 * `plugins/lib` directory holding atom's jars, so a launcher with that sibling,
 * or any `.bat` (only the jar payload ships one), runs on the JVM whatever the
 * platform is. Everything else, including the npm dispatcher (`node
 * .../index.js`, its `atom`/`atom.cmd` bin shims) and a native binary, follows
 * the platform's kind. A GraalVM `-XX:` heap argument handed to a jar launcher
 * is rejected by atom's option parser before any analysis starts, and a
 * `JAVA_TOOL_OPTIONS` ceiling handed to a native image is silently ignored, so
 * the distinction decides whether the heap is bounded at all.
 *
 * @param {string} command The `ATOM_CMD` value
 * @param {"native"|"jar"} platformKind Kind the platform prefers
 * @returns {"native"|"jar"}
 */
export function atomCommandKind(command, platformKind) {
  const [bin, leadingArg] = splitAtomCommand(command);
  const runsScript =
    leadingArg !== undefined && /^node(\.exe)?$/i.test(basename(bin));
  let launcher = runsScript ? leadingArg : bin;
  if (/\.bat$/i.test(launcher)) {
    return "jar";
  }
  try {
    // npm bin entries are symlinks into the package (`/usr/local/bin/atom` ->
    // `.../@appthreat/atom/index.js`), and `/usr/local` has a `lib` of its own.
    launcher = realpathSync(launcher);
  } catch {
    return platformKind;
  }
  const binDir = dirname(launcher);
  if (basename(binDir) !== "bin") {
    return platformKind;
  }
  try {
    const libDir = join(dirname(binDir), "lib");
    if (
      readdirSync(libDir).some(
        (file) => file.startsWith("io.appthreat.atom") && file.endsWith(".jar"),
      )
    ) {
      return "jar";
    }
  } catch {
    // no lib directory: not a jar layout
  }
  return platformKind;
}

/**
 * Locate the `php-parse` binary that the PHP frontend needs.
 *
 * atom 3's dispatcher unconditionally sets `PHP_PARSER_BIN=<ATOM_HOME>/bin/php-parse`,
 * which for a native sub-package does not exist and also clobbers a caller-set
 * value. cdxgen therefore resolves the real location and forwards it through the
 * child env (see `buildAtomCommandEnv`); `executeAtom` then spawns the
 * native binary directly for PHP so the dispatcher cannot clobber it (see
 * `resolveDirectAtomBinaryPath`). Resolution order:
 *   1. explicit `PHP_PARSER_BIN` env var (operators / container images)
 *   2. `@appthreat/atom-parsetools/plugins/bin/php-parse` under cdxgen's own
 *      node_modules, then under `GLOBAL_NODE_MODULES_PATH` for global installs
 *
 * Returns `undefined` when neither is found, in which case PHP analysis runs
 * through the dispatcher unchanged (and fails on native platforms until atom
 * fixes the clobber).
 *
 * @returns {string|undefined}
 */
export function resolvePhpParseBin() {
  if (readEnvironmentVariable("PHP_PARSER_BIN")) {
    return readEnvironmentVariable("PHP_PARSER_BIN");
  }
  return phpParsetoolsFile("plugins", "bin", "php-parse");
}

/**
 * Locate the `phpastgen` generator that lets the PHP frontend parse whole
 * directories in one batch.
 *
 * `php-parse` (forwarded as `PHP_PARSER_BIN`) is the per-file parser: atom
 * starts a php interpreter for every `.php` file, which on windows turns a
 * vendored PHP project (thousands of files under `vendor/`) into an hours-long
 * run that no timeout can rescue. `phpastgen` answers the `--parser-info`
 * capability probe, so atom's batch path engages, and atom-parsetools 1.9 and
 * later parse the whole tree, vendor included, with a few interpreters that
 * each take a chunk of files. It is a Node script, so the frontend launches it
 * with `node` rather than `php`; an atom that does not know `PHP_ASTGEN_BIN`
 * simply ignores it and keeps today's per-file behaviour. Resolution order:
 *   1. explicit `PHP_ASTGEN_BIN` env var (operators / container images)
 *   2. `@appthreat/atom-parsetools/phpastgen.js` under cdxgen's own
 *      node_modules, then under `GLOBAL_NODE_MODULES_PATH` for global installs
 *
 * @returns {string|undefined}
 */
export function resolvePhpAstgenBin() {
  if (readEnvironmentVariable("PHP_ASTGEN_BIN")) {
    return readEnvironmentVariable("PHP_ASTGEN_BIN");
  }
  return phpParsetoolsFile("phpastgen.js");
}

/**
 * Resolve a file inside the installed `@appthreat/atom-parsetools` package,
 * searching cdxgen's own node_modules and `GLOBAL_NODE_MODULES_PATH` for global
 * installs.
 *
 * @param {...string} segments Path segments below the package root
 * @returns {string|undefined}
 */
function phpParsetoolsFile(...segments) {
  const roots = [dirNameStr];
  if (readEnvironmentVariable("GLOBAL_NODE_MODULES_PATH")) {
    roots.push(dirname(readEnvironmentVariable("GLOBAL_NODE_MODULES_PATH")));
  }
  for (const root of roots) {
    const candidate = join(
      root,
      "node_modules",
      "@appthreat",
      "atom-parsetools",
      ...segments,
    );
    if (safeExistsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Resolve the atom native binary path directly, bypassing the dispatcher.
 *
 * This is required for the PHP frontend: the dispatcher clobbers
 * `PHP_PARSER_BIN` with a path that does not exist on native platforms, and
 * atom 3.0.x crashes in `defaultPhpParserBin` parsing that bogus value before
 * any `--frontend-args php-parser-bin=` override is consulted. Spawning the
 * native binary directly lets cdxgen control the child env, so the correct
 * `PHP_PARSER_BIN` reaches atom. Returns `undefined` when the provider is the
 * jar kind or the native binary cannot be located (in which case the dispatcher
 * is used as-is).
 *
 * @returns {string|undefined}
 */
export function resolveDirectAtomBinaryPath() {
  const { preferredPkg, kind } = resolveAtomProvider();
  if (kind !== "native") {
    return undefined;
  }
  const folder = preferredPkg.split("/")[1];
  const exeName = isWin ? "atom.exe" : "atom";
  for (const dir of atomSubPackageCandidates(folder)) {
    const candidate = join(dir, "bin", exeName);
    if (safeExistsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Directories where an `@appthreat/atom-*` sub-package may be installed next to
 * the dispatcher cdxgen uses, for npm, pnpm and global layouts: a sibling of
 * `@appthreat/atom`, nested under it, in a pnpm virtual store, or a sibling of
 * the dispatcher's real (symlink-resolved) directory.
 *
 * @param {string} folder Sub-package folder name, e.g. `atom-jar`
 * @returns {string[]} Candidate package directories
 */
function atomSubPackageCandidates(folder) {
  const version = readAtomVersion();
  const roots = [join(dirNameStr, "node_modules")];
  if (readEnvironmentVariable("GLOBAL_NODE_MODULES_PATH")) {
    roots.push(readEnvironmentVariable("GLOBAL_NODE_MODULES_PATH"));
  }
  const candidates = [];
  for (const root of roots) {
    candidates.push(join(root, "@appthreat", folder));
    candidates.push(
      join(root, "@appthreat", "atom", "node_modules", "@appthreat", folder),
    );
    if (version) {
      candidates.push(
        join(
          root,
          ".pnpm",
          `@appthreat+${folder}@${version}`,
          "node_modules",
          "@appthreat",
          folder,
        ),
      );
    }
    // pnpm links @appthreat/atom to its store entry, where the sub-packages
    // are its siblings.
    try {
      const atomDir = realpathSync(join(root, "@appthreat", "atom"));
      candidates.push(join(dirname(atomDir), folder));
    } catch {
      // not installed under this root
    }
  }
  return [...new Set(candidates)];
}

function readAtomVersion() {
  const roots = [join(dirNameStr, "node_modules")];
  if (readEnvironmentVariable("GLOBAL_NODE_MODULES_PATH")) {
    roots.push(readEnvironmentVariable("GLOBAL_NODE_MODULES_PATH"));
  }
  for (const root of roots) {
    try {
      const pj = JSON.parse(
        readFileSync(join(root, "@appthreat", "atom", "package.json"), "utf8"),
      );
      if (pj.version) {
        return pj.version;
      }
    } catch {
      // try the next root
    }
  }
  return undefined;
}

/**
 * Retrieves the atom command by referring to various environment variables
 */
export function getAtomCommand() {
  if (readEnvironmentVariable("ATOM_CMD")) {
    return readEnvironmentVariable("ATOM_CMD");
  }
  if (readEnvironmentVariable("ATOM_HOME")) {
    // For atom 3 native installs, ATOM_HOME points at the platform sub-package
    // directory (the dispatcher sets it to `dirname(dirname(binPath))`), which
    // contains `bin/atom`. For jar installs it points at `plugins/`, where
    // `bin/atom` is the launcher. Either way `join(ATOM_HOME, "bin", "atom")`
    // is the correct path, so this branch needs no change for atom 3.
    return join(readEnvironmentVariable("ATOM_HOME"), "bin", "atom");
  }
  const NODE_CMD = readEnvironmentVariable("NODE_CMD") || "node";
  const localAtom = join(
    dirNameStr,
    "node_modules",
    "@appthreat",
    "atom",
    "index.js",
  );
  if (safeExistsSync(localAtom)) {
    return `${NODE_CMD} ${localAtom}`;
  }
  return "atom";
}

/**
 * Compute the maximum heap atom may grow to, in bytes.
 *
 * Neither of atom's two runtimes bounds itself to anything a machine can
 * comfortably back: a GraalVM native image defaults to
 * `MaximumHeapSizePercent=80` of physical memory, and HotSpot to a quarter of
 * it. Both use a collector that grows the heap in preference to collecting, so
 * on a large host atom reserves tens of gigabytes and the machine, not atom,
 * is what runs out of memory.
 *
 * The ceiling is therefore the smaller of half of physical memory and
 * `ATOM_MAX_HEAP_CAP_BYTES`, with a floor so that a small container still gets
 * a workable heap. `ATOM_MAX_HEAP` overrides the whole calculation and accepts
 * a plain byte count or a `k`/`m`/`g` suffix.
 *
 * @returns {number|undefined} Heap ceiling in bytes, or `undefined` to leave the runtime default in place
 */
export function atomMaxHeapBytes() {
  const configured = readEnvironmentVariable("ATOM_MAX_HEAP");
  if (configured) {
    const match = /^(\d+)([kmg]?)b?$/i.exec(configured.trim());
    if (!match) {
      console.warn(
        `WARN: Ignoring ATOM_MAX_HEAP='${configured}'. Expected a byte count, optionally suffixed with k, m, or g.`,
      );
    } else {
      const scale = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 };
      const bytes = Number(match[1]) * scale[match[2].toLowerCase()];
      // Zero is the runtime's own "unset" value, so it is the way to ask for
      // the unbounded default back.
      return bytes > 0 ? bytes : undefined;
    }
  }
  const total = totalmem();
  if (!total) {
    return undefined;
  }
  return Math.max(
    ATOM_MIN_HEAP_FLOOR_BYTES,
    Math.min(Math.floor(total / 2), ATOM_MAX_HEAP_CAP_BYTES),
  );
}

/**
 * Warn when atom is about to run with a heap that slicing may not fit in.
 *
 * Below the comfortable threshold the failure is not a clean error: the
 * collector spends progressively longer reclaiming an almost-full heap, so the
 * run first becomes very slow and only then dies. Saying so up front turns an
 * apparent hang into an actionable message. It is said once per ceiling, so the
 * per-language spawns of a single run share one warning.
 *
 * @param {number} maxHeap Heap ceiling in bytes that atom will run with
 */
function warnOnTightAtomHeap(maxHeap) {
  if (
    maxHeap === warnedAtomHeapCeiling ||
    maxHeap >= ATOM_COMFORTABLE_HEAP_BYTES
  ) {
    return;
  }
  warnedAtomHeapCeiling = maxHeap;
  const asGib = (bytes) => Math.round((bytes / 1024 ** 3) * 10) / 10;
  console.warn(
    `WARN: atom is limited to a ${asGib(maxHeap)} GiB heap, below the ${asGib(
      ATOM_COMFORTABLE_HEAP_BYTES,
    )} GiB that slice computation is comfortable with. Slicing large projects may take a long time or run out of memory. Raise it with ATOM_MAX_HEAP (for example ATOM_MAX_HEAP=8g) on a host with more memory.`,
  );
}

/**
 * Build the runtime arguments and environment that bound atom's heap.
 *
 * A native image takes its heap ceiling as a `-XX:` argument, which its runtime
 * consumes before the command line reaches atom's own parser. A jar install is
 * launched through a script that owns the `java` command line, so the only way
 * in is `JAVA_TOOL_OPTIONS`, and an existing value is left alone rather than
 * overridden.
 *
 * @param {string[]} args Arguments destined for atom, mutated in place
 * @param {Object} env Environment for the atom process, mutated in place
 */
function applyAtomHeapLimit(args, env) {
  const maxHeap = atomMaxHeapBytes();
  if (!maxHeap) {
    return;
  }
  warnOnTightAtomHeap(maxHeap);
  if (atomProviderKind() === "jar") {
    if (!env.JAVA_TOOL_OPTIONS) {
      env.JAVA_TOOL_OPTIONS = `-Xmx${Math.floor(maxHeap / 1024 ** 2)}m`;
    }
    return;
  }
  if (!args.some((arg) => String(arg).startsWith("-XX:MaxHeapSize="))) {
    args.unshift(`-XX:MaxHeapSize=${maxHeap}`);
  }
}

// How long cdxgen waits past atom's own time limit for the dispatcher to stop
// the runtime and exit. It covers the dispatcher's SIGTERM-to-SIGKILL grace (10
// seconds) and the runtime's exit. A short limit (a test, a smoke run) gets a
// quarter of itself instead.
const ATOM_STOP_GRACE_MS = 30_000;

/**
 * Compute how long atom may run, and how long cdxgen waits for it.
 *
 * cdxgen's spawn timeout kills only the process cdxgen started, and for atom
 * that is the npm dispatcher. The runtime under it (the native binary or the
 * JVM) used to survive that kill, re-parented and still holding its heap. atom
 * therefore gets its own limit, `ATOM_TIMEOUT`, which the dispatcher enforces on
 * the runtime, and cdxgen's spawn timeout sits a grace period beyond it as the
 * last resort.
 *
 * An explicit `ATOM_TIMEOUT` (milliseconds) sets atom's limit independently of
 * `CDXGEN_TIMEOUT_MS`, which keeps bounding every other tool. Otherwise atom's
 * limit is `CDXGEN_TIMEOUT_MS` less the grace period.
 *
 * @returns {{atomTimeoutMs: number, spawnTimeoutMs: number}} atom's own limit and cdxgen's spawn timeout for it
 */
export function atomTimeouts() {
  const graceFor = (ms) => Math.min(ATOM_STOP_GRACE_MS, Math.floor(ms / 4));
  const configured = Number.parseInt(
    readEnvironmentVariable("ATOM_TIMEOUT"),
    10,
  );
  if (configured > 0) {
    return {
      atomTimeoutMs: configured,
      spawnTimeoutMs: configured + graceFor(configured),
    };
  }
  return {
    atomTimeoutMs: TIMEOUT_MS - graceFor(TIMEOUT_MS),
    spawnTimeoutMs: TIMEOUT_MS,
  };
}

function formatDuration(ms) {
  if (ms >= 60_000) {
    const minutes = Math.round(ms / 6_000) / 10;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  return `${Math.round(ms / 100) / 10} seconds`;
}

// The status the atom dispatcher exits with when ATOM_TIMEOUT stops atom.
const ATOM_TIMEOUT_EXIT_CODE = 124;

/**
 * Reap everything a timed-out atom run left behind on Windows.
 *
 * cdxgen starts atom through a shell there (`shell: isWin`), so the spawn
 * timeout terminates only that `cmd.exe`. Windows neither kills nor
 * re-parents its children: the runtime under it, and every parser worker it
 * started (one `php.exe` per file for the per-file PHP frontend), keep running
 * against the next slice of the same run while still pointing at the dead
 * shell's pid. `taskkill /T` on that pid finds nothing, because the root is
 * already gone. The live descendants are therefore found by parent pid in a
 * process snapshot and stopped, limited to processes created after the run
 * started. The root's own children must also predate its end: once the root
 * is gone its pid can be handed to an unrelated process, whose children would
 * otherwise look like the run's. A chain broken
 * by an intermediate that already exited (the npm dispatcher stopping its
 * runtime itself) cannot be followed, and atom 4 stops its helpers once
 * `ATOM_PARENT_PID` is gone.
 *
 * @param {number|undefined} rootPid pid of the process cdxgen spawned
 * @param {number} startedAt Epoch milliseconds at which the run started
 * @param {number} [endedAt] Epoch milliseconds at which the spawned process ended
 * @returns {number[]} The pids that were stopped
 */
export function reapAtomProcessTree(rootPid, startedAt, endedAt = Date.now()) {
  if (!isWin || !Number.isInteger(rootPid) || rootPid <= 0) {
    return [];
  }
  // All three values are integers, so interpolating them cannot inject anything.
  const since = Math.max(0, Math.floor(startedAt) - 1000);
  const until = Math.max(since, Math.floor(endedAt) + 1000);
  const script = [
    `$root = ${rootPid}`,
    `$since = [DateTimeOffset]::FromUnixTimeMilliseconds(${since}).UtcDateTime`,
    `$until = [DateTimeOffset]::FromUnixTimeMilliseconds(${until}).UtcDateTime`,
    "$children = @{}",
    "foreach ($p in Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate) {",
    "  if (-not $p.CreationDate) { continue }",
    "  $created = $p.CreationDate.ToUniversalTime()",
    "  if ($created -lt $since) { continue }",
    "  if ([int]$p.ParentProcessId -eq $root -and $created -gt $until) { continue }",
    "  $children[[int]$p.ParentProcessId] += @([int]$p.ProcessId)",
    "}",
    "$found = [System.Collections.Generic.List[int]]::new()",
    "$queue = [System.Collections.Generic.Queue[int]]::new()",
    "$queue.Enqueue($root)",
    "while ($queue.Count) {",
    "  foreach ($child in @($children[$queue.Dequeue()])) {",
    "    if ($child -and -not $found.Contains($child)) { $found.Add($child); $queue.Enqueue($child) }",
    "  }",
    "}",
    "foreach ($child in $found) { Stop-Process -Id $child -Force -ErrorAction SilentlyContinue }",
    "$found -join ','",
  ].join("\n");
  const result = safeSpawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { timeout: 60000 },
  );
  const reaped = `${result?.stdout || ""}`
    .trim()
    .split(",")
    .map((pid) => Number.parseInt(pid, 10))
    .filter((pid) => pid > 0);
  if (DEBUG_MODE) {
    console.log(
      reaped.length
        ? `Stopped ${reaped.length} process(es) the timed-out atom run left behind: ${reaped.join(", ")}.`
        : "The timed-out atom run left no processes behind.",
    );
  }
  return reaped;
}

/**
 * Whether an atom run ended because it ran out of time.
 *
 * The dispatcher reports its own limit with status 124. cdxgen's spawn timeout
 * shows up as `ETIMEDOUT`. A dispatcher older than the status code stops atom
 * with SIGTERM and passes on how the runtime ended: 1, or the runtime's own
 * exit on SIGTERM (143) or SIGKILL (137), which is what atom 3.1 reports. Those
 * statuses at or past the limit count as well, unless atom's own output shows
 * it failed for another reason first (an exhausted heap, a crash), which
 * deserves its own diagnosis. Missing one leaves the half-written atom behind,
 * and the next slice of the run fails to load it.
 *
 * @param {Object} result spawnSync result
 * @param {number} elapsedMs How long the run took
 * @param {number} atomTimeoutMs atom's time limit
 * @returns {boolean} true when the run hit a time limit
 */
export function atomRunTimedOut(result, elapsedMs, atomTimeoutMs) {
  if (result?.status === ATOM_TIMEOUT_EXIT_CODE) {
    return true;
  }
  if (result?.error?.code === "ETIMEDOUT") {
    return true;
  }
  if (
    !ATOM_STOPPED_STATUSES.includes(result?.status) ||
    elapsedMs < atomTimeoutMs
  ) {
    return false;
  }
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  return !ATOM_FAILURE_MARKERS.some((marker) => output.includes(marker));
}

// How a runtime stopped by an older dispatcher at ATOM_TIMEOUT exits: the
// dispatcher's own 1, or the runtime's exit on SIGTERM (128 + 15) or SIGKILL
// (128 + 9) passed through.
const ATOM_STOPPED_STATUSES = [1, 137, 143];

// Output that means atom failed by itself, whatever the clock says.
const ATOM_FAILURE_MARKERS = [
  "OutOfMemoryError",
  "A fatal error has been detected by the Java Runtime Environment",
  "The crash happened outside the Java Virtual Machine in native code",
  "Failure: ",
];

/**
 * Execute the atom tool against a source directory or file with the given arguments.
 *
 * Resolves the atom binary via `getAtomCommand`, sets up the required environment
 * (including `JAVA_HOME` from `ATOM_JAVA_HOME` if set), and spawns the process.
 * Logs diagnostic messages for common failure modes such as unsupported Java versions,
 * missing `astgen`, and JVM crashes.
 *
 * @param {string} src Path to the source directory or file to analyse
 * @param {string[]} args Arguments to pass to the atom command
 * @param {Object} extra_env Additional environment variables to merge into the process environment
 * @returns {boolean} `true` if atom executed successfully and the language is supported; `false` otherwise
 */
export function executeAtom(src, args, extra_env = {}) {
  const cwd =
    safeExistsSync(src) && lstatSync(src).isDirectory() ? src : dirname(src);
  let ATOM_BIN = getAtomCommand();
  // PHP on a native platform: the atom 3 dispatcher clobbers PHP_PARSER_BIN
  // with a non-existent path and atom 3.0.x crashes parsing it before any
  // --frontend-args override is honoured. When the caller forwards a resolved
  // PHP_PARSER_BIN (see buildAtomCommandEnv) and the resolved command is the
  // dispatcher, spawn the native binary directly so our env reaches atom. This
  // must happen before the space-split below prepends index.js to argv.
  let bypassAtomHome;
  if (extra_env.PHP_PARSER_BIN && ATOM_BIN.includes("index.js")) {
    const directBinary = resolveDirectAtomBinaryPath();
    if (directBinary) {
      ATOM_BIN = directBinary;
      // The dispatcher exports ATOM_HOME=<sub-package dir> for the child. Set
      // the same value here so bypassing it does not change anything else atom
      // derives from that variable.
      bypassAtomHome = dirname(dirname(directBinary));
    }
  }
  let isSupported = true;
  const env = {
    ...process.env,
    ...extra_env,
  };
  // Bound the heap while argv still starts at atom's own arguments: the
  // split below prepends the launcher script, which has to stay first.
  applyAtomHeapLimit(args, env);
  const [resolvedBin, leadingArg] = splitAtomCommand(ATOM_BIN);
  if (leadingArg !== undefined) {
    ATOM_BIN = resolvedBin;
    args.unshift(leadingArg);
  }
  if (DEBUG_MODE) {
    console.log("Executing", ATOM_BIN);
  }
  if (bypassAtomHome) {
    env.ATOM_HOME = bypassAtomHome;
  }
  // Surface atom 3's resolver diagnostics under verbose debug. The dispatcher
  // traces every candidate path it inspects, which is the cheapest way to
  // diagnose a payload-less install.
  if (TRACE_MODE && env.ATOM_DEBUG === undefined) {
    env.ATOM_DEBUG = "1";
  }
  // Atom requires Java >= 23 (jar-kind platforms only)
  if (readEnvironmentVariable("ATOM_JAVA_HOME")) {
    env.JAVA_HOME = readEnvironmentVariable("ATOM_JAVA_HOME");
  }
  if (isWin) {
    env.PATH = `${env.PATH || env.Path}${_delimiter}${join(
      dirNameStr,
      "node_modules",
      ".bin",
    )}`;
  } else {
    env.PATH = `${env.PATH}${_delimiter}${join(
      dirNameStr,
      "node_modules",
      ".bin",
    )}`;
  }
  const { atomTimeoutMs, spawnTimeoutMs } = atomTimeouts();
  env.ATOM_TIMEOUT = String(atomTimeoutMs);
  // Name cdxgen as the supervisor: the dispatcher, and atom under it, stop when
  // cdxgen is gone (killed by a caller's own timeout, say) instead of analysing
  // on for nobody.
  env.ATOM_PARENT_PID = String(process.pid);
  const startedAt = Date.now();
  const result = safeSpawnSync(ATOM_BIN, args, {
    cwd,
    shell: isWin,
    killSignal: "SIGKILL",
    env,
    timeout: spawnTimeoutMs,
  });
  const endedAt = Date.now();
  if (atomRunTimedOut(result, endedAt - startedAt, atomTimeoutMs)) {
    console.warn(
      `WARN: atom did not finish within ${formatDuration(atomTimeoutMs)} and was stopped, so its results are missing or incomplete. Allow more time with ATOM_TIMEOUT (milliseconds, atom only) or CDXGEN_TIMEOUT_MS (every external command).`,
    );
    reapAtomProcessTree(result.pid, startedAt, endedAt);
    // A stopped atom leaves its graph half written, and the next slice of the
    // same run would try to reuse it and fail to load it.
    const atomFileIndex = args.indexOf("-o");
    const atomFile = atomFileIndex >= 0 ? args[atomFileIndex + 1] : undefined;
    if (atomFile && safeExistsSync(atomFile)) {
      safeRmSync(atomFile, { recursive: true, force: true });
    }
    return false;
  }
  const isJarKind = atomProviderKind() === "jar";
  if (result.stderr) {
    if (
      isJarKind &&
      (result.stderr?.includes(
        "has been compiled by a more recent version of the Java Runtime",
      ) ||
        result.stderr?.includes(
          "Error: Could not create the Java Virtual Machine",
        ))
    ) {
      console.log(
        "Atom requires Java 23 or above. To improve the SBOM accuracy, please install a suitable version, set the JAVA_HOME environment variable, and re-run cdxgen.\nAlternatively, use the cdxgen container image.",
      );
      console.log(
        env["JAVA_HOME"]
          ? "JAVA_HOME is currently set. Check that it points to a supported JDK."
          : "JAVA_HOME is not set.",
      );
    } else if (result.stderr?.includes("astgen")) {
      console.warn(
        "WARN: Unable to locate astgen command. Install atom globally using sudo npm install -g @appthreat/atom-parsetools to resolve this issue.",
      );
    } else if (
      result.stderr?.includes(
        "The crash happened outside the Java Virtual Machine in native code",
      )
    ) {
      console.warn(
        "WARN: The binary plugin used by atom has crashed. Please try an alternative container image and file an issue with steps to reproduce at: https://github.com/AppThreat/atom/issues",
      );
    } else if (
      result.stderr?.includes("Could not parse command line options")
    ) {
      console.warn(
        "Invalid command-line options passed to atom. Please file a bug in the cdxgen repository.",
      );
    }
  }
  if (result.stdout) {
    if (result.stdout.includes("No language frontend supported for language")) {
      console.log("This language is not yet supported by atom.");
      isSupported = false;
    } else if (
      isJarKind &&
      (result.stdout.includes(
        "The crash happened outside the Java Virtual Machine in native code",
      ) ||
        result.stdout.includes(
          "A fatal error has been detected by the Java Runtime Environment",
        ))
    ) {
      console.warn(
        "WARN: The binary plugin used by atom has crashed. Please try an alternative container image and file an issue with steps to reproduce at: https://github.com/AppThreat/atom/issues",
      );
    }
  }
  if (DEBUG_MODE) {
    if (result.stdout) {
      console.log(result.stdout);
    }
    if (result.stderr) {
      console.log(result.stderr);
    }
  }
  // atom 3's dispatcher propagates the child exit status, so a non-zero exit is
  // finally observable. Report it rather than treating a failed analysis as a
  // success (the spawn `error` field is only set when the process could not be
  // launched at all). A null status (signal/timeout) is treated as failure.
  if (result.status !== null && result.status !== 0) {
    console.warn(
      `WARN: atom exited with status ${result.status}; the analysis may be incomplete.`,
    );
    return false;
  }
  return isSupported && !result.error && result.status === 0;
}

const CHUNK_MTIME_SLACK_MS = 2000;

/**
 * The numbered chunks atom wrote beside a reachables slices file.
 *
 * atom writes reachables at most 1000 flows per file: `<base>.json`, then
 * `<base>_1.json`, `<base>_2.json` and so on. Chunks are taken until the first
 * gap. A chunk older than the base file was left by an earlier run with more
 * flows (atom before 4.0.0 did not remove those), so it ends the sequence
 * instead of being merged.
 *
 * @param {string} slicesFile Path of the base reachables slices file
 * @returns {string[]} Chunk file paths, in order
 */
export function reachablesChunkFiles(slicesFile) {
  const baseMtimeMs = mtimeMsOf(slicesFile);
  if (!slicesFile?.endsWith(".json") || baseMtimeMs === undefined) {
    return [];
  }
  const stem = slicesFile.slice(0, -".json".length);
  // atom writes the base file first, so its chunks are never older. The slack
  // covers filesystems that store modification times in whole seconds or two;
  // it assumes no earlier run wrote chunks to the same path within that window.
  // atom 4 and cdxgen both remove old chunks before atom writes new ones, so
  // the mtime test only matters for slices files produced elsewhere.
  const oldestChunkMtimeMs = baseMtimeMs - CHUNK_MTIME_SLACK_MS;
  const chunks = [];
  for (let index = 1; ; index++) {
    const chunk = `${stem}_${index}.json`;
    const chunkMtimeMs = mtimeMsOf(chunk);
    if (chunkMtimeMs === undefined || chunkMtimeMs < oldestChunkMtimeMs) {
      break;
    }
    chunks.push(chunk);
  }
  return chunks;
}

// A file that disappears between listing and stat ends the sequence, not the run.
function mtimeMsOf(file) {
  if (!file || !safeExistsSync(file)) {
    return undefined;
  }
  try {
    return statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Remove the numbered chunks beside a reachables slices file, before atom
 * writes a new set there, so no chunk of an earlier run survives next to it.
 *
 * @param {string} slicesFile Path of the base reachables slices file
 */
export function removeReachablesChunkFiles(slicesFile) {
  if (!slicesFile?.endsWith(".json")) {
    return;
  }
  const stem = slicesFile.slice(0, -".json".length);
  for (let index = 1; safeExistsSync(`${stem}_${index}.json`); index++) {
    safeRmSync(`${stem}_${index}.json`, { force: true });
  }
}

/**
 * Read an atom slices file, or warn and return `undefined` when it cannot be
 * parsed. A run stopped while writing (a timeout, a kill) can leave a
 * truncated file, and the evidence from the other slices is still worth
 * keeping.
 *
 * @param {string} slicesFile Path of the slices file
 * @param {string} sliceType Slice type, for the warning
 * @returns {*} The parsed slices, or `undefined`
 */
export function readSlicesFile(slicesFile, sliceType) {
  if (!slicesFile || !safeExistsSync(slicesFile)) {
    return undefined;
  }
  try {
    return readJsonFile(slicesFile);
  } catch (e) {
    console.warn(
      `WARN: Ignoring the ${sliceType} slices file ${slicesFile}, which is incomplete or not valid JSON (${e.message}).`,
    );
    return undefined;
  }
}

/**
 * Read a reachables slices file together with its chunks.
 *
 * Reading only the base file silently dropped every flow past the first
 * thousand. A chunk that cannot be parsed ends the sequence, keeping the flows
 * read before it.
 *
 * @param {string} slicesFile Path of the base reachables slices file
 * @returns {Object[]|Object|undefined} Every flow, in the base file's shape (an array, or an object with `reachables`)
 */
export function readReachablesSlices(slicesFile) {
  const data = readSlicesFile(slicesFile, "reachables");
  if (data === undefined) {
    return undefined;
  }
  const chunks = reachablesChunkFiles(slicesFile);
  if (!chunks.length) {
    return data;
  }
  const flowsOf = (slices) =>
    Array.isArray(slices) ? slices : slices?.reachables || [];
  const flows = [...flowsOf(data)];
  for (const chunk of chunks) {
    const chunkData = readSlicesFile(chunk, "reachables");
    if (chunkData === undefined) {
      break;
    }
    for (const flow of flowsOf(chunkData)) {
      flows.push(flow);
    }
  }
  return Array.isArray(data) || !data ? flows : { ...data, reachables: flows };
}

/**
 * Find the imported modules in the application with atom parsedeps command
 *
 * @param {string} src
 * @param {string} language
 * @param {string} methodology
 * @param {string} slicesFile
 * @param {Object} options CLI options
 * @returns List of imported modules
 */
export function findAppModules(
  src,
  language,
  methodology = "usages",
  slicesFile = undefined,
  options = {},
) {
  const tempDir = safeMkdtempSync(join(tmpdir(), "atom-deps-"));
  const atomFile = join(tempDir, `${language}-app.atom`);
  if (!slicesFile) {
    slicesFile = join(tempDir, "slices.json");
  }
  let retList = [];
  const args = [
    methodology,
    "-l",
    language,
    "-o",
    resolve(atomFile),
    "--slice-outfile",
    resolve(slicesFile),
  ];
  // The header languages parse without function bodies. Their AST cache, kept
  // in <src>/.chen, would be replayed by a later full C/C++ run over the same
  // directory (evinse, or `-t c --deep`) on atom releases that do not key the
  // cache on that difference, leaving that run with no method bodies.
  if (ATOM_HEADER_LANGUAGES.has(`${language}`.toLowerCase())) {
    args.push("--no-ast-cache");
  }
  args.push(...atomCompileCommandsArgs(src, language, options));
  args.push(resolve(src));
  executeAtom(src, args, buildAtomCommandEnv(options, language));
  if (safeExistsSync(slicesFile)) {
    const slicesData = JSON.parse(readFileSync(slicesFile, "utf-8"), {
      encoding: "utf-8",
    });
    if (slicesData && Object.keys(slicesData) && slicesData.modules) {
      retList = slicesData.modules;
    } else {
      retList = slicesData;
    }
  } else {
    console.log(
      "Slicing was not successful. For large projects (> 1 million lines of code), try running atom cli externally in Java mode. Please refer to the instructions in https://github.com/cdxgen/cdxgen/blob/master/ADVANCED.md.",
    );
  }
  // Clean up
  if (tempDir?.startsWith(tmpdir())) {
    safeRmSync(tempDir, { recursive: true, force: true });
  }
  return retList;
}
