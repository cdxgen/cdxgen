import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

import { readScanFileText } from "../core/boundedFile.js";

// Build-input formulation parsers for the ecosystems whose build files cdxgen
// can read without running a build: make and CMake for C/C++, go.mod for Go,
// pip requirements and constraints files for Python, and project.assets.json
// plus .csproj for .NET. Rust already has its own parser
// (rustFormulationParser); Go binaries are read by the OBOM path through the
// bounded buildinfo reader, so a source scan records the module file here.
//
// Every parser takes `parse(files, options, context)`, where context.rootDir
// is the scanned project root. Files are read only when they are regular
// files under that root, and components record their path relative to it.

// A build file larger than this is machine generated (or not a build file at
// all), and reading it would only burn memory, so it is skipped unread.
export const MAX_READ_BYTES = 2 * 1024 * 1024;

// `dotnet restore` output grows with the dependency graph, and tens of
// megabytes are common in .NET monorepos, so it gets its own, larger bound.
export const MAX_ASSETS_READ_BYTES = 32 * 1024 * 1024;

// No build-file line worth reading is longer than this. Longer lines are
// skipped before any tokenising, so a crafted file cannot make a parser
// spend more than linear time on one line.
const MAX_LINE_LENGTH = 4096;

/**
 * The path of a build input relative to the scanned project root, with
 * forward slashes, as recorded in bom-refs and `internal:SrcFile`. A file
 * outside the root, or a call without a root, records only its file name,
 * so no path of the scanning machine reaches the BOM.
 *
 * @param {string} filePath file the component describes
 * @param {string} [rootDir] scanned project root
 * @returns {string} project-relative path, or the file name
 */
export function formulationSourcePath(filePath, rootDir) {
  if (!filePath) {
    return filePath;
  }
  if (rootDir) {
    const rel = relative(resolve(rootDir), resolve(filePath));
    if (rel && !isAbsolute(rel) && rel.split(/[\\/]/)[0] !== "..") {
      return rel.replaceAll("\\", "/");
    }
  }
  return basename(filePath);
}

/**
 * Read a build file when it is a regular file within the size bound. A
 * symbolic link that stays inside rootDir is followed; a link that leads out
 * of it, a FIFO and an oversize file are not read. Without rootDir only a
 * link to a sibling of the file is followed.
 *
 * @param {string} filePath file to read
 * @param {string} [rootDir] root the file must stay under
 * @param {number} [maxBytes] largest size read, in bytes
 * @returns {string|undefined} file text, or undefined
 */
function readBounded(filePath, rootDir, maxBytes = MAX_READ_BYTES) {
  return readScanFileText(filePath, maxBytes, rootDir);
}

/**
 * Split text into lines, dropping lines longer than MAX_LINE_LENGTH.
 *
 * @param {string} content file text
 * @returns {string[]} lines of reasonable length
 */
function boundedLines(content) {
  return content
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
    .filter((line) => line.length <= MAX_LINE_LENGTH);
}

/**
 * Join lines that end in a backslash with the line after them, the way make
 * and pip read their files. A line longer than MAX_LINE_LENGTH contributes no
 * text but still continues when it ends in a backslash, so its neighbours
 * stay where the tool would put them.
 *
 * @param {string} content file text
 * @param {object} rules joining rules
 * @param {boolean} rules.commentLinesContinue true for make, where a comment
 *   ending in a backslash continues; false for pip, where a comment line
 *   never continues and ends a continuation in progress
 * @returns {string[]} logical lines
 */
function joinContinuationLines(content, { commentLinesContinue }) {
  const logicalLines = [];
  let pending;
  for (const rawLine of content.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const overlong = line.length > MAX_LINE_LENGTH;
    const text = overlong ? "" : line;
    const isComment = !commentLinesContinue && text.trimStart().startsWith("#");
    const continues = line.trimEnd().endsWith("\\") && !isComment;
    let piece = text;
    if (continues && !overlong) {
      piece = text.trimEnd().slice(0, -1);
    }
    const joined =
      pending === undefined ? piece : `${pending} ${piece.trimStart()}`;
    if (continues) {
      pending = joined;
      continue;
    }
    logicalLines.push(joined);
    pending = undefined;
  }
  if (pending !== undefined) {
    logicalLines.push(pending);
  }
  return logicalLines;
}

/**
 * Split a line on runs of whitespace.
 *
 * @param {string} line line text
 * @returns {string[]} non-empty tokens
 */
function tokens(line) {
  return line.split(/\s+/).filter(Boolean);
}

function appendProperty(properties, name, value) {
  if (!name || value === undefined || value === null || value === "") {
    return;
  }
  properties.push({
    name,
    value: typeof value === "string" ? value : String(value),
  });
}

function createBuildInputComponent(name, filePath, tool, rootDir) {
  const sourcePath = formulationSourcePath(filePath, rootDir);
  return {
    type: "application",
    name,
    version: "config",
    "bom-ref": `urn:cdxgen:formulation:${tool}:${sourcePath}`,
    properties: [
      { name: "internal:SrcFile", value: sourcePath },
      { name: "cdx:build:tool", value: tool },
    ],
  };
}

const MAX_LISTED = 25;

const MAKE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAKE_INCLUDE_DIRECTIVES = new Set(["include", "-include", "sinclude"]);
const MAKE_VARIABLE_MODIFIERS = new Set(["export", "override", "private"]);

/**
 * Whether a path from a make file is safe to record: relative to the make
 * file and not leaving the repository. Absolute POSIX, Windows drive and UNC
 * paths, home-relative paths and paths with a `..` segment describe the
 * machine or tree around the project, so they are dropped.
 *
 * @param {string} includePath include directive argument or target name
 * @returns {boolean} true when the path can be recorded
 */
function isRecordableIncludePath(includePath) {
  if (
    !includePath ||
    includePath.startsWith("/") ||
    includePath.startsWith("\\") ||
    includePath.startsWith("~")
  ) {
    return false;
  }
  if (
    includePath.length >= 2 &&
    includePath[1] === ":" &&
    /^[A-Za-z]$/.test(includePath[0])
  ) {
    return false;
  }
  return !includePath.split(/[\\/]/).includes("..");
}

// A file name or glob, with plain `$(NAME)` or `${NAME}` references. Quotes,
// `:`, `@`, `=`, `;`, `,` and `#` are never part of one.
const MAKE_INCLUDE_PATH =
  /^(?:[A-Za-z0-9_.+*?/\\-]|\$\([A-Za-z_][A-Za-z0-9_]*\)|\$\{[A-Za-z_][A-Za-z0-9_]*\})+$/;

/**
 * The file names an include directive lists. The words of a function call
 * such as `$(shell curl -u user:password ...)` are a value, not paths, so
 * every word from the one that opens the call to the one that closes it is
 * dropped, and a `#` comment ends the list. The remaining words are recorded
 * only when they look like a file name and pass isRecordableIncludePath.
 *
 * @param {string[]} words tokens after the include keyword
 * @returns {string[]} include paths that can be recorded
 */
function includeDirectivePaths(words) {
  const paths = [];
  let depth = 0;
  for (const word of words) {
    const insideCall = depth > 0;
    const commentStart = word.indexOf("#");
    const text = commentStart === -1 ? word : word.slice(0, commentStart);
    for (const ch of text) {
      if (ch === "(" || ch === "{") {
        depth += 1;
      } else if ((ch === ")" || ch === "}") && depth > 0) {
        depth -= 1;
      }
    }
    if (
      text &&
      !insideCall &&
      depth === 0 &&
      MAKE_INCLUDE_PATH.test(text) &&
      isRecordableIncludePath(text)
    ) {
      paths.push(text);
    }
    if (commentStart !== -1) {
      return paths;
    }
  }
  return paths;
}

/**
 * Whether the text before a rule colon is a target name worth recording: one
 * token with no whitespace or quotes, not an option-like word, not a special
 * (`.PHONY`), variable-reference or pattern target, and a path that passes
 * the same filter as include directives.
 *
 * @param {string} name text before the rule colon
 * @returns {boolean} true when the target can be recorded
 */
function isRecordableMakeTarget(name) {
  if (!name || /[\s"'`]/.test(name)) {
    return false;
  }
  if (".#$-".includes(name[0]) || name.includes("%")) {
    return false;
  }
  return isRecordableIncludePath(name);
}

/**
 * The variable name a `define` line opens, without a trailing assignment
 * operator.
 *
 * @param {string[]} words tokens after the `define` keyword
 * @returns {string|undefined} the variable name
 */
function defineVariableName(words) {
  let name = words[0] || "";
  while (name && "?+!:=".includes(name[name.length - 1])) {
    name = name.slice(0, -1);
  }
  return MAKE_IDENTIFIER.test(name) ? name : undefined;
}

/**
 * Collect target names, include directives and variable names from a make
 * file. Values are deliberately not recorded: flags can carry tokens or
 * machine-specific paths, and a name is enough for audit triage. Continuation
 * lines are joined first and `define ... endef` bodies are skipped, so text
 * from inside a value is never read as a target. Lines are tokenised with
 * indexOf, so the work stays linear in the line length.
 *
 * @param {string} content make file text
 * @returns {{ targets: string[], includes: string[], variables: string[] }}
 */
function parseMakeContent(content) {
  const targets = [];
  const includes = [];
  const variables = [];
  let defineDepth = 0;
  for (const line of joinContinuationLines(content, {
    commentLinesContinue: true,
  })) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const words = tokens(trimmed);
    let start = 0;
    while (
      start < words.length - 1 &&
      MAKE_VARIABLE_MODIFIERS.has(words[start])
    ) {
      start += 1;
    }
    const directive = words[start];
    if (defineDepth > 0) {
      if (directive === "endef") {
        defineDepth -= 1;
      } else if (directive === "define") {
        defineDepth += 1;
      }
      continue;
    }
    // Recipe lines cannot declare targets or variables.
    if (line.startsWith("\t")) {
      continue;
    }
    if (directive === "define") {
      defineDepth = 1;
      const name = defineVariableName(words.slice(start + 1));
      if (name) {
        variables.push(name);
      }
      continue;
    }
    if (directive === "endef") {
      continue;
    }
    if (MAKE_INCLUDE_DIRECTIVES.has(words[0])) {
      for (const includePath of includeDirectivePaths(words.slice(1))) {
        includes.push(includePath);
      }
      continue;
    }
    // export, override and private qualify the assignment that follows.
    const body = start ? words.slice(start).join(" ") : trimmed;
    const eq = body.indexOf("=");
    const colon = body.indexOf(":");
    // An assignment: `=`, `?=`, `+=`, `!=`, `:=`, `::=` or `:::=` before any
    // rule colon.
    const colonIsOperator =
      colon !== -1 &&
      eq > colon &&
      body
        .slice(colon, eq)
        .split("")
        .every((ch) => ch === ":");
    if (eq !== -1 && (colon === -1 || eq < colon || colonIsOperator)) {
      let nameEnd = colonIsOperator ? colon : eq;
      while (nameEnd > 0 && "?+!".includes(body[nameEnd - 1])) {
        nameEnd -= 1;
      }
      const name = body.slice(0, nameEnd).trim();
      if (MAKE_IDENTIFIER.test(name)) {
        variables.push(name);
      }
      continue;
    }
    if (start || colon <= 0) {
      continue;
    }
    // A Windows drive path such as C:\out\app.exe names the machine.
    if (
      colon === 1 &&
      /^[A-Za-z]$/.test(body[0]) &&
      (body[2] === "\\" || body[2] === "/")
    ) {
      continue;
    }
    const name = body.slice(0, colon).trim();
    if (isRecordableMakeTarget(name)) {
      targets.push(name);
    }
  }
  return { targets, includes, variables };
}

function parseMakeFile(filePath, rootDir) {
  const content = readBounded(filePath, rootDir);
  if (!content) {
    return undefined;
  }
  const { targets, includes, variables } = parseMakeContent(content);
  const component = createBuildInputComponent(
    basename(dirname(filePath)) || basename(filePath),
    filePath,
    "make",
    rootDir,
  );
  const properties = component.properties;
  appendProperty(properties, "cdx:make:targetCount", targets.length);
  appendProperty(
    properties,
    "cdx:make:targets",
    targets.length ? targets.slice(0, MAX_LISTED).join(", ") : undefined,
  );
  appendProperty(
    properties,
    "cdx:make:includes",
    includes.length ? includes.slice(0, MAX_LISTED).join(", ") : undefined,
  );
  appendProperty(
    properties,
    "cdx:make:variables",
    variables.length ? variables.slice(0, MAX_LISTED).join(", ") : undefined,
  );
  appendProperty(
    properties,
    "cdx:make:usesDocker",
    targets.some((t) => /docker/i.test(t)) ? "true" : undefined,
  );
  return component;
}

/**
 * Remove CMake comments: `#` line comments and `#[[ ... ]]` bracket
 * comments, outside quoted and bracket arguments. The text is scanned once
 * with indexOf, so the work stays linear in the file size.
 *
 * @param {string} content CMakeLists.txt text
 * @returns {string} the text without comments
 */
function stripCMakeComments(content) {
  const kept = [];
  let segmentStart = 0;
  let index = 0;
  let inQuote = false;
  // A bracket opener is `[`, any number of `=`, then `[`; it returns the
  // matching closer, or undefined.
  const bracketCloser = (at) => {
    let cursor = at + 1;
    while (content[cursor] === "=") {
      cursor += 1;
    }
    return content[cursor] === "["
      ? `]${"=".repeat(cursor - at - 1)}]`
      : undefined;
  };
  while (index < content.length) {
    const ch = content[index];
    if (ch === "\\") {
      index += 2;
      continue;
    }
    if (inQuote) {
      if (ch === '"') {
        inQuote = false;
      }
      index += 1;
      continue;
    }
    if (ch === '"') {
      inQuote = true;
      index += 1;
      continue;
    }
    if (ch === "[") {
      const closer = bracketCloser(index);
      if (closer) {
        const end = content.indexOf(closer, index);
        index = end === -1 ? content.length : end + closer.length;
        continue;
      }
      index += 1;
      continue;
    }
    if (ch === "#") {
      kept.push(content.slice(segmentStart, index));
      const closer =
        content[index + 1] === "[" ? bracketCloser(index + 1) : undefined;
      let end;
      if (closer) {
        end = content.indexOf(closer, index);
        end = end === -1 ? content.length : end + closer.length;
      } else {
        end = content.indexOf("\n", index);
        end = end === -1 ? content.length : end;
      }
      index = end;
      segmentStart = end;
      continue;
    }
    index += 1;
  }
  kept.push(content.slice(segmentStart));
  return kept.join("");
}

/**
 * Blank the inside of CMake quoted arguments, keeping the text length, so a
 * command name or parenthesis inside a string is not read as code. Indexes
 * into the result point at the same characters of the input.
 *
 * @param {string} content CMakeLists.txt text without comments
 * @returns {string} the text with quoted argument contents replaced by spaces
 */
function maskCMakeStrings(content) {
  const kept = [];
  let segmentStart = 0;
  let index = 0;
  while (index < content.length) {
    const ch = content[index];
    if (ch === "\\") {
      index += 2;
      continue;
    }
    if (ch !== '"') {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < content.length && content[end] !== '"') {
      end += content[end] === "\\" ? 2 : 1;
    }
    end = Math.min(end, content.length);
    kept.push(content.slice(segmentStart, index + 1));
    kept.push(" ".repeat(end - index - 1));
    segmentStart = end;
    index = end + 1;
  }
  kept.push(content.slice(segmentStart));
  return kept.join("");
}

const CMAKE_PROJECT_KEYWORDS = new Set([
  "DESCRIPTION",
  "HOMEPAGE_URL",
  "LANGUAGES",
  "VERSION",
]);
const CMAKE_LANGUAGES = new Set([
  "ASM",
  "ASM-ATT",
  "ASM_MASM",
  "ASM_NASM",
  "C",
  "CSharp",
  "CUDA",
  "CXX",
  "Fortran",
  "HIP",
  "ISPC",
  "Java",
  "OBJC",
  "OBJCXX",
  "Swift",
]);

/**
 * Read the first `project(<name> ...)` command of a CMake file whose
 * comments were removed. Command names are case-insensitive in CMake. The
 * arguments are cut at the next `)` with indexOf, so a file full of
 * unterminated `project(` calls is still read in linear time. Languages are
 * the arguments after `LANGUAGES`, or, in the short form
 * `project(name C CXX)`, the arguments before the first keyword.
 *
 * @param {string} content CMakeLists.txt text without comments
 * @param {string} masked the same text with quoted contents blanked
 * @returns {{ name: string, languages: string[] }|undefined}
 */
function parseCMakeProject(content, masked) {
  const projectCall = /\bproject\s*\(/i.exec(masked);
  if (!projectCall) {
    return undefined;
  }
  const argsStart = projectCall.index + projectCall[0].length;
  const argsEnd = masked.indexOf(")", argsStart);
  if (argsEnd === -1) {
    return undefined;
  }
  const args = tokens(content.slice(argsStart, argsEnd)).map((arg) =>
    arg.length >= 2 && arg.startsWith('"') && arg.endsWith('"')
      ? arg.slice(1, -1)
      : arg,
  );
  const name = args[0];
  if (!name || !/^[A-Za-z0-9_.-]+$/.test(name)) {
    return undefined;
  }
  const rest = args.slice(1);
  const languagesAt = rest.indexOf("LANGUAGES");
  const languageArgs = [];
  for (const arg of rest.slice(languagesAt + 1)) {
    if (CMAKE_PROJECT_KEYWORDS.has(arg)) {
      break;
    }
    languageArgs.push(arg);
  }
  return {
    name,
    languages: [...new Set(languageArgs.filter((a) => CMAKE_LANGUAGES.has(a)))],
  };
}

function parseCMakeLists(filePath, rootDir) {
  const raw = readBounded(filePath, rootDir);
  if (!raw) {
    return undefined;
  }
  const content = stripCMakeComments(raw);
  const masked = maskCMakeStrings(content);
  const minimum = /\bcmake_minimum_required\s*\(\s*VERSION\s+([0-9.]+)/i.exec(
    masked,
  );
  const project = parseCMakeProject(content, masked);
  const executableCount = (masked.match(/\badd_executable\s*\(/gi) || [])
    .length;
  const libraryCount = (masked.match(/\badd_library\s*\(/gi) || []).length;
  const component = createBuildInputComponent(
    project?.name || basename(dirname(filePath)) || "cmake-project",
    filePath,
    "cmake",
    rootDir,
  );
  const properties = component.properties;
  appendProperty(properties, "cdx:cmake:minimumVersion", minimum?.[1]);
  appendProperty(
    properties,
    "cdx:cmake:languages",
    project?.languages.length ? project.languages.join(", ") : undefined,
  );
  appendProperty(properties, "cdx:cmake:executableCount", executableCount);
  appendProperty(properties, "cdx:cmake:libraryCount", libraryCount);
  return component;
}

/**
 * Parser for make and CMake build inputs (C/C++ and friends).
 *
 * @type {{id: string, patterns: string[], parse(files: string[], options?: Object, context?: {rootDir?: string}): {components: Object[]}}}
 */
export const makefileFormulationParser = {
  id: "make-build",
  patterns: [
    "**/Makefile",
    "**/makefile",
    "**/GNUmakefile",
    "**/*.mk",
    "**/CMakeLists.txt",
  ],
  parse(files, _options, context = {}) {
    const components = [];
    for (const filePath of files || []) {
      const base = basename(filePath).toLowerCase();
      const component = base.startsWith("cmakelists")
        ? parseCMakeLists(filePath, context.rootDir)
        : parseMakeFile(filePath, context.rootDir);
      if (component) {
        components.push(component);
      }
    }
    return { components };
  },
};

/**
 * Read the directives of a go.mod file. Requirements are counted from
 * single-line `require` directives and the lines of `require ( ... )`
 * blocks only; `replace`, `exclude` and `retract` lines are not
 * requirements. Lines are split into tokens, with no regex over the file.
 *
 * @param {string} content go.mod text
 * @returns {{ module: string|undefined, goVersion: string|undefined, toolchain: string|undefined, requireCount: number, indirectCount: number }}
 */
function parseGoModContent(content) {
  const result = {
    module: undefined,
    goVersion: undefined,
    toolchain: undefined,
    requireCount: 0,
    indirectCount: 0,
  };
  const unquote = (value) =>
    value && value.length >= 2 && value.startsWith('"') && value.endsWith('"')
      ? value.slice(1, -1)
      : value;
  const countRequirement = (spec, comment) => {
    const parts = tokens(spec);
    if (parts.length < 2 || !parts[1].startsWith("v")) {
      return;
    }
    result.requireCount += 1;
    if (comment && tokens(comment.replaceAll(";", " ")).includes("indirect")) {
      result.indirectCount += 1;
    }
  };
  let block;
  for (const rawLine of boundedLines(content)) {
    const commentStart = rawLine.indexOf("//");
    const code = (
      commentStart === -1 ? rawLine : rawLine.slice(0, commentStart)
    ).trim();
    const comment =
      commentStart === -1 ? "" : rawLine.slice(commentStart + 2).trim();
    if (block) {
      if (code === ")") {
        block = undefined;
      } else if (block === "require" && code) {
        countRequirement(code, comment);
      }
      continue;
    }
    if (!code) {
      continue;
    }
    const words = tokens(code);
    const directive = words[0];
    if (words.length === 2 && words[1] === "(") {
      block = directive;
      continue;
    }
    if (words.length === 1 && directive.length > 1 && directive.endsWith("(")) {
      block = directive.slice(0, -1);
      continue;
    }
    if (directive === "module" && result.module === undefined) {
      result.module = unquote(words[1]);
    } else if (directive === "go" && result.goVersion === undefined) {
      result.goVersion = words[1];
    } else if (directive === "toolchain" && result.toolchain === undefined) {
      result.toolchain = words[1];
    } else if (directive === "require") {
      countRequirement(words.slice(1).join(" "), comment);
    }
  }
  return result;
}

function parseGoMod(filePath, rootDir) {
  const content = readBounded(filePath, rootDir);
  if (!content) {
    return undefined;
  }
  const { module, goVersion, toolchain, requireCount, indirectCount } =
    parseGoModContent(content);
  if (!module) {
    return undefined;
  }
  const component = createBuildInputComponent(module, filePath, "go", rootDir);
  const properties = component.properties;
  appendProperty(properties, "cdx:go:module", module);
  appendProperty(properties, "cdx:go:version", goVersion);
  appendProperty(properties, "cdx:go:toolchain", toolchain);
  appendProperty(properties, "cdx:go:requireCount", requireCount);
  appendProperty(properties, "cdx:go:indirectCount", indirectCount);
  return component;
}

/**
 * Parser for go.mod build inputs. The compiled binaries are read by the
 * binary/OBOM path through the bounded Go buildinfo reader, not here.
 *
 * @type {{id: string, patterns: string[], parse(files: string[], options?: Object, context?: {rootDir?: string}): {components: Object[]}}}
 */
export const goModuleFormulationParser = {
  id: "go-module",
  patterns: ["**/go.mod"],
  parse(files, _options, context = {}) {
    const components = [];
    for (const filePath of files || []) {
      const component = parseGoMod(filePath, context.rootDir);
      if (component) {
        components.push(component);
      }
    }
    return { components };
  },
};

/**
 * Whether a pip requirement is a direct reference rather than a name with a
 * version specifier: `name @ url` (PEP 508), a bare URL, or a local path.
 * Such a requirement is never an exact pin, even when its URL holds `==`.
 *
 * @param {string} requirement requirement text before any option
 * @returns {boolean} true for a direct reference
 */
function isPipDirectReference(requirement) {
  const schemeAt = requirement.indexOf("://");
  const at = requirement.indexOf("@");
  if (at !== -1 && (schemeAt === -1 || at < schemeAt)) {
    return true;
  }
  if (schemeAt !== -1) {
    return true;
  }
  return (
    requirement.startsWith(".") ||
    requirement.startsWith("/") ||
    requirement.startsWith("\\") ||
    (requirement[1] === ":" && /^[A-Za-z]$/.test(requirement[0]))
  );
}

/**
 * Count the requirements of a pip requirements or constraints file and how
 * many of them are exact pins (`==` or `===`). Lines ending in a backslash
 * continue on the next line, which is where pip-compile writes the
 * `--hash` options, so hashes are looked for in the joined logical line.
 * Editable installs (`-e`, `--editable`) are requirements but never pins.
 *
 * @param {string} content file text
 * @returns {{ requirementCount: number, pinCount: number, hasHashes: boolean }}
 */
function parsePipContent(content) {
  let requirementCount = 0;
  let pinCount = 0;
  let hasHashes = false;
  // As in pip's join_lines, a comment line never continues, even when it
  // ends in a backslash; it ends any continuation in progress instead.
  for (const logicalLine of joinContinuationLines(content, {
    commentLinesContinue: false,
  })) {
    const trimmed = logicalLine.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const commentStart = trimmed.indexOf(" #");
    const requirement = (
      commentStart === -1 ? trimmed : trimmed.slice(0, commentStart)
    ).trim();
    if (!requirement) {
      continue;
    }
    const words = tokens(requirement);
    const isEditable =
      words[0] === "--editable" ||
      words[0].startsWith("--editable=") ||
      (words[0].startsWith("-e") && !words[0].startsWith("--"));
    // Other option lines such as --index-url, -r and -c are not
    // requirements.
    if (requirement.startsWith("-") && !isEditable) {
      continue;
    }
    requirementCount += 1;
    if (words.some((word) => word.toLowerCase().startsWith("--hash"))) {
      hasHashes = true;
    }
    if (isEditable) {
      continue;
    }
    // The specifier ends at the first option or environment marker.
    const optionStart = words.findIndex((word) => word.startsWith("--"));
    const specifierWords =
      optionStart === -1 ? words : words.slice(0, optionStart);
    if (isPipDirectReference(specifierWords.join(" "))) {
      continue;
    }
    let specifier = specifierWords.join("");
    const markerStart = specifier.indexOf(";");
    if (markerStart !== -1) {
      specifier = specifier.slice(0, markerStart);
    }
    const pinStart = specifier.indexOf("==");
    if (
      pinStart !== -1 &&
      !specifier.includes(",") &&
      !specifier.slice(pinStart).includes("*")
    ) {
      pinCount += 1;
    }
  }
  return { requirementCount, pinCount, hasHashes };
}

function parsePipRequirements(filePath, rootDir) {
  const content = readBounded(filePath, rootDir);
  if (!content) {
    return undefined;
  }
  const { requirementCount, pinCount, hasHashes } = parsePipContent(content);
  const component = createBuildInputComponent(
    basename(filePath),
    filePath,
    "pip",
    rootDir,
  );
  const properties = component.properties;
  appendProperty(properties, "cdx:pip:requirementCount", requirementCount);
  appendProperty(properties, "cdx:pip:pinCount", pinCount);
  appendProperty(
    properties,
    "cdx:pip:unpinnedCount",
    requirementCount - pinCount,
  );
  appendProperty(
    properties,
    "cdx:pip:hasHashes",
    hasHashes ? "true" : undefined,
  );
  appendProperty(
    properties,
    "cdx:pip:kind",
    /constraints/i.test(basename(filePath)) ? "constraints" : "requirements",
  );
  return component;
}

/**
 * Parser for pip requirements and constraints files.
 *
 * @type {{id: string, patterns: string[], parse(files: string[], options?: Object, context?: {rootDir?: string}): {components: Object[]}}}
 */
export const pythonRequirementsFormulationParser = {
  id: "python-requirements",
  patterns: [
    "**/requirements*.txt",
    "**/constraints*.txt",
    "**/requirements/*.txt",
    "**/requirements.d/*.txt",
  ],
  parse(files, _options, context = {}) {
    const components = [];
    for (const filePath of files || []) {
      const component = parsePipRequirements(filePath, context.rootDir);
      if (component) {
        components.push(component);
      }
    }
    return { components };
  },
};

function parseCsProj(filePath, rootDir) {
  const content = readBounded(filePath, rootDir);
  if (!content) {
    return undefined;
  }
  const sdk = /\bSdk\s*=\s*"([^"]+)"/.exec(content);
  const targetFramework =
    /<TargetFrameworks?>([^<]+)<\/TargetFrameworks?>/.exec(content);
  const outputType = /<OutputType>([^<]+)<\/OutputType>/.exec(content);
  const version = /<Version>([^<]+)<\/Version>/.exec(content);
  const packageReferenceCount = (
    content.match(/<PackageReference\s+Include=/g) || []
  ).length;
  const component = createBuildInputComponent(
    basename(filePath).replace(/\.csproj$/i, ""),
    filePath,
    "nuget",
    rootDir,
  );
  const properties = component.properties;
  appendProperty(properties, "cdx:msbuild:sdk", sdk?.[1]);
  appendProperty(
    properties,
    "cdx:msbuild:targetFrameworks",
    targetFramework?.[1]?.trim(),
  );
  appendProperty(properties, "cdx:msbuild:outputType", outputType?.[1]?.trim());
  appendProperty(properties, "cdx:msbuild:version", version?.[1]?.trim());
  appendProperty(
    properties,
    "cdx:msbuild:packageReferenceCount",
    packageReferenceCount,
  );
  return component;
}

function parseProjectAssets(filePath, rootDir) {
  const content = readBounded(filePath, rootDir, MAX_ASSETS_READ_BYTES);
  if (!content) {
    return undefined;
  }
  let data;
  try {
    data = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!data || typeof data !== "object") {
    return undefined;
  }
  const frameworks = Object.keys(data.project?.frameworks || {});
  const libraryCount = Object.keys(data.libraries || {}).length;
  const targetCount = Object.keys(data.targets || {}).length;
  // The restore project name is an MSBuild project name, never a path.
  const projectName = data.project?.restore?.projectName;
  const component = createBuildInputComponent(
    (typeof projectName === "string" &&
      !/[\\/]/.test(projectName) &&
      projectName) ||
      basename(dirname(filePath)) ||
      "nuget-restore",
    filePath,
    "nuget",
    rootDir,
  );
  const properties = component.properties;
  const assetsVersion =
    typeof data.version === "string" ||
    (typeof data.version === "number" && Number.isFinite(data.version))
      ? data.version
      : undefined;
  appendProperty(properties, "cdx:nuget:assetsVersion", assetsVersion);
  appendProperty(
    properties,
    "cdx:nuget:frameworks",
    frameworks.length ? frameworks.slice(0, MAX_LISTED).join(", ") : undefined,
  );
  appendProperty(properties, "cdx:nuget:libraryCount", libraryCount);
  appendProperty(properties, "cdx:nuget:targetCount", targetCount);
  return component;
}

/**
 * Parser for .NET build inputs: project.assets.json (the file `dotnet
 * restore` writes; some projects call it packages.assets.json) and the
 * SDK-style .csproj project files.
 *
 * @type {{id: string, patterns: string[], parse(files: string[], options?: Object, context?: {rootDir?: string}): {components: Object[]}}}
 */
export const dotnetProjectFormulationParser = {
  id: "dotnet-project",
  patterns: [
    "**/project.assets.json",
    "**/packages.assets.json",
    "**/*.csproj",
  ],
  parse(files, _options, context = {}) {
    const components = [];
    for (const filePath of files || []) {
      const base = basename(filePath).toLowerCase();
      const component = base.endsWith("assets.json")
        ? parseProjectAssets(filePath, context.rootDir)
        : parseCsProj(filePath, context.rootDir);
      if (component) {
        components.push(component);
      }
    }
    return { components };
  },
};
