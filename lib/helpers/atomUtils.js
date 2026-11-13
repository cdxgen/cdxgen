import { platform } from "node:os";
import process from "node:process";

/**
 * Characters no shell gives a meaning to. atom builds the command lines of
 * some helpers it starts as one unquoted string and runs it with `sh -c`
 * (`cmd /c` on Windows): `atom-tools convert` for `--extract-endpoints`, and
 * `rbastgen` for Ruby, whose input directory and excluded directory names
 * are pasted in. A value that ends up in such a string must consist of these
 * characters only. This is an allowlist, because a space also splits the
 * string into extra arguments. `%` expands variables in a Windows shell; `\`
 * separates paths there and `~` appears in its short path names.
 */
const ATOM_SHELL_SAFE_RE =
  platform() === "win32"
    ? /^[\p{L}\p{M}\p{N}_@+=:,./\\~-]+$/u
    : /^[\p{L}\p{M}\p{N}_@%+=:,./-]+$/u;

/** atom `-l` values handled by the Ruby frontend. */
const ATOM_RUBY_LANGUAGES = new Set(["ruby", "rb", "rubysrc", "jruby"]);

/**
 * Whether atom may paste a value into a shell command line as it is. Paths
 * and names of the scanned project are not trusted input: they come from its
 * config file and its directory names.
 *
 * @param {string} value Path, file name or option value handed to atom
 * @returns {boolean} true when no shell would interpret any part of the value
 */
export function isAtomShellSafe(value) {
  return typeof value === "string" && ATOM_SHELL_SAFE_RE.test(value);
}

/**
 * Whether atom would start its Ruby frontend for the given atom arguments.
 *
 * @param {string[]} args Arguments passed to atom
 * @returns {boolean} true when the `-l` value names a Ruby language
 */
export function isAtomRubyRun(args) {
  const languageIndex = args.indexOf("-l");
  const atomLanguage =
    languageIndex >= 0 ? `${args[languageIndex + 1]}`.toLowerCase() : "";
  return ATOM_RUBY_LANGUAGES.has(atomLanguage);
}

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

export function isPathExcludedByGlobPatterns(filePath, patterns = []) {
  const atomIgnoreRegex = globPatternsToAtomIgnoreRegex(patterns);
  if (!atomIgnoreRegex) {
    return false;
  }
  const normalizedPath = `${filePath}`.replace(/\\/g, "/").replace(/^\.\//, "");
  const regex = new RegExp(atomIgnoreRegex);
  return regex.test(normalizedPath) || regex.test(`./${normalizedPath}`);
}

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
  if (!excludePatterns.length) {
    return {};
  }
  // atom's Ruby frontend pastes CHEN_IGNORE_DIRS into a single-quoted
  // argument of the rbastgen command line it runs through a shell. A name it
  // is not told about is still dropped from the slices afterwards, by
  // filterAtomSlicesByExcludePatterns.
  const excludedDirNames = extractIgnoreDirsFromExcludePatterns(
    excludePatterns,
    true,
  ).filter((dirName) => {
    if (isAtomShellSafe(dirName)) {
      return true;
    }
    console.warn(
      `The excluded directory name ${JSON.stringify(dirName)} contains characters a shell would interpret, so atom is not told to skip it. The exclude pattern still applies to the slices.`,
    );
    return false;
  });
  const chenIgnoreDirs = mergeCsvValues(
    process.env.CHEN_IGNORE_DIRS,
    excludedDirNames,
  );
  const env = {};
  if (chenIgnoreDirs) {
    env.CHEN_IGNORE_DIRS = chenIgnoreDirs;
  }
  const atomIgnoreRegex = globPatternsToAtomIgnoreRegex(excludePatterns);
  const normalizedLanguage = `${language}`.toLowerCase();
  if (ATOM_JS_LANGUAGES.has(normalizedLanguage)) {
    const astgenBaseIgnoreDirs =
      process.env.ASTGEN_IGNORE_DIRS === undefined
        ? ASTGEN_DEFAULT_IGNORE_DIRS
        : process.env.ASTGEN_IGNORE_DIRS;
    const astgenIgnoreDirs = mergeCsvValues(
      astgenBaseIgnoreDirs,
      "node_modules",
      extractIgnoreDirsFromExcludePatterns(excludePatterns),
    );
    if (astgenIgnoreDirs) {
      env.ASTGEN_IGNORE_DIRS = astgenIgnoreDirs;
    }
    const astgenIgnoreFilePattern = mergeRegexValues(
      process.env.ASTGEN_IGNORE_FILE_PATTERN,
      atomIgnoreRegex,
    );
    if (astgenIgnoreFilePattern) {
      env.ASTGEN_IGNORE_FILE_PATTERN = astgenIgnoreFilePattern;
    }
  }
  return env;
}
