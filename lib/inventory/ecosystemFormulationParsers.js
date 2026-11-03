import { readFileSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";

// Build-input formulation parsers for the ecosystems whose build files cdxgen
// can read without running a build: make and CMake for C/C++, go.mod for Go,
// pip requirements and constraints files for Python, and project.assets.json
// plus .csproj for .NET. Rust already has its own parser
// (rustFormulationParser); Go binaries are read by the OBOM path through the
// bounded buildinfo reader, so a source scan records the module file here.

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
 * Read a text file when its size is within the bound. The size is checked
 * before the read, so an oversize file is never loaded into memory.
 *
 * @param {string} filePath file to read
 * @param {number} [maxBytes] largest size read, in bytes
 * @returns {string|undefined} file text, or undefined when unreadable or too large
 */
function readBounded(filePath, maxBytes = MAX_READ_BYTES) {
  try {
    const stats = statSync(filePath);
    if (!stats.isFile() || stats.size > maxBytes) {
      return undefined;
    }
    return readFileSync(filePath, { encoding: "utf-8" });
  } catch {
    return undefined;
  }
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
 * Split a line on runs of spaces and tabs.
 *
 * @param {string} line line text
 * @returns {string[]} non-empty tokens
 */
function tokens(line) {
  return line.split(/[ \t]+/).filter(Boolean);
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

function createBuildInputComponent(name, filePath, tool) {
  return {
    type: "application",
    name,
    version: "config",
    "bom-ref": `urn:cdxgen:formulation:${tool}:${filePath}`,
    properties: [
      { name: "internal:SrcFile", value: filePath },
      { name: "cdx:build:tool", value: tool },
    ],
  };
}

const MAX_LISTED = 25;

const MAKE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAKE_INCLUDE_DIRECTIVES = new Set(["include", "-include", "sinclude"]);

/**
 * Whether an include path from a make file is safe to record: relative to
 * the make file and not leaving the repository. Absolute POSIX, Windows
 * drive and UNC paths, home-relative paths and paths with a `..` segment
 * describe the machine or tree around the project, so they are dropped.
 *
 * @param {string} includePath include directive argument
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

/**
 * Collect target names, include directives and variable names from a make
 * file. Values are deliberately not recorded: flags can carry tokens or
 * machine-specific paths, and a name is enough for audit triage. Lines are
 * tokenised with indexOf, so the work stays linear in the line length.
 *
 * @param {string} content make file text
 * @returns {{ targets: string[], includes: string[], variables: string[] }}
 */
function parseMakeContent(content) {
  const targets = [];
  const includes = [];
  const variables = [];
  for (const rawLine of boundedLines(content)) {
    // Recipe lines and comments cannot declare targets.
    if (rawLine.startsWith("\t")) {
      continue;
    }
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const words = tokens(trimmed);
    if (MAKE_INCLUDE_DIRECTIVES.has(words[0])) {
      includes.push(...words.slice(1).filter(isRecordableIncludePath));
      continue;
    }
    const eq = trimmed.indexOf("=");
    const colon = trimmed.indexOf(":");
    // An assignment: `=`, `?=`, `+=`, `!=`, `:=`, `::=` or `:::=` before any
    // rule colon.
    const colonIsOperator =
      colon !== -1 &&
      eq > colon &&
      trimmed
        .slice(colon, eq)
        .split("")
        .every((ch) => ch === ":");
    if (eq !== -1 && (colon === -1 || eq < colon || colonIsOperator)) {
      let nameEnd = colonIsOperator ? colon : eq;
      while (nameEnd > 0 && "?+!".includes(trimmed[nameEnd - 1])) {
        nameEnd -= 1;
      }
      const name = trimmed.slice(0, nameEnd).trim();
      if (MAKE_IDENTIFIER.test(name)) {
        variables.push(name);
      }
      continue;
    }
    if (colon <= 0 || ".#$".includes(trimmed[0])) {
      continue;
    }
    const name = trimmed.slice(0, colon).trim();
    // Pattern rules and rule-spliced targets say nothing about the project.
    if (name && !name.includes("%")) {
      targets.push(name);
    }
  }
  return { targets, includes, variables };
}

function parseMakeFile(filePath) {
  const content = readBounded(filePath);
  if (!content) {
    return undefined;
  }
  const { targets, includes, variables } = parseMakeContent(content);
  const component = createBuildInputComponent(
    basename(dirname(filePath)) || basename(filePath),
    filePath,
    "make",
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
 * Find the first `project(<name> ...)` command of a CMake file. The
 * arguments are cut at the next `)` with indexOf, so a file full of
 * unterminated `project(` calls is still read in linear time.
 *
 * @param {string} content CMakeLists.txt text
 * @returns {string[]|undefined} [match, name, remaining arguments], or undefined
 */
function parseCMakeProject(content) {
  const projectCall = /\bproject\s*\(/.exec(content);
  if (!projectCall) {
    return undefined;
  }
  const argsStart = projectCall.index + projectCall[0].length;
  const argsEnd = content.indexOf(")", argsStart);
  if (argsEnd === -1) {
    return undefined;
  }
  const args = content.slice(argsStart, argsEnd).trim();
  const name = tokens(args.replaceAll("\n", " ").replaceAll("\r", " "))[0];
  if (!name || !/^[A-Za-z0-9_.-]+$/.test(name)) {
    return undefined;
  }
  return [
    content.slice(projectCall.index, argsEnd + 1),
    name,
    args.slice(name.length),
  ];
}

function parseCMakeLists(filePath) {
  const content = readBounded(filePath);
  if (!content) {
    return undefined;
  }
  const minimum = /cmake_minimum_required\s*\(\s*VERSION\s+([0-9.]+)/.exec(
    content,
  );
  const project = parseCMakeProject(content);
  const languages = project?.[2]
    ? project[2].match(
        /\b(C|CXX|CUDA|Fortran|ASM|OBJC|OBJCXX|Swift|Java)\b/g,
      ) || []
    : [];
  const executableCount = (content.match(/\badd_executable\s*\(/g) || [])
    .length;
  const libraryCount = (content.match(/\badd_library\s*\(/g) || []).length;
  const component = createBuildInputComponent(
    project?.[1] || basename(dirname(filePath)) || "cmake-project",
    filePath,
    "cmake",
  );
  const properties = component.properties;
  appendProperty(properties, "cdx:cmake:minimumVersion", minimum?.[1]);
  appendProperty(
    properties,
    "cdx:cmake:languages",
    languages.length ? [...new Set(languages)].join(", ") : undefined,
  );
  appendProperty(properties, "cdx:cmake:executableCount", executableCount);
  appendProperty(properties, "cdx:cmake:libraryCount", libraryCount);
  return component;
}

/**
 * Parser for make and CMake build inputs (C/C++ and friends).
 *
 * @type {{id: string, patterns: string[], parse(files: string[]): {components: Object[]}}}
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
  parse(files) {
    const components = [];
    for (const filePath of files || []) {
      const base = basename(filePath).toLowerCase();
      const component = base.startsWith("cmakelists")
        ? parseCMakeLists(filePath)
        : parseMakeFile(filePath);
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

function parseGoMod(filePath) {
  const content = readBounded(filePath);
  if (!content) {
    return undefined;
  }
  const { module, goVersion, toolchain, requireCount, indirectCount } =
    parseGoModContent(content);
  if (!module) {
    return undefined;
  }
  const component = createBuildInputComponent(module, filePath, "go");
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
 * @type {{id: string, patterns: string[], parse(files: string[]): {components: Object[]}}}
 */
export const goModuleFormulationParser = {
  id: "go-module",
  patterns: ["**/go.mod"],
  parse(files) {
    const components = [];
    for (const filePath of files || []) {
      const component = parseGoMod(filePath);
      if (component) {
        components.push(component);
      }
    }
    return { components };
  },
};

/**
 * Count the requirements of a pip requirements or constraints file and how
 * many of them are exact pins (`==` or `===`). Lines ending in a backslash
 * continue on the next line, which is where pip-compile writes the
 * `--hash` options, so hashes are looked for in the joined logical line.
 *
 * @param {string} content file text
 * @returns {{ requirementCount: number, pinCount: number, hasHashes: boolean }}
 */
function parsePipContent(content) {
  let requirementCount = 0;
  let pinCount = 0;
  let hasHashes = false;
  const logicalLines = [];
  let pending = "";
  for (const rawLine of boundedLines(content)) {
    const trimmedEnd = rawLine.trimEnd();
    // As in pip's join_lines, a comment line never continues, even when it
    // ends in a backslash; it ends any continuation in progress instead.
    const isCommentLine = trimmedEnd.trimStart().startsWith("#");
    if (trimmedEnd.endsWith("\\") && !isCommentLine) {
      pending += `${trimmedEnd.slice(0, -1)} `;
      continue;
    }
    logicalLines.push(pending + rawLine);
    pending = "";
  }
  if (pending) {
    logicalLines.push(pending);
  }
  for (const logicalLine of logicalLines) {
    const trimmed = logicalLine.trim();
    // Option lines such as --index-url, -r and -c are not requirements.
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("-")) {
      continue;
    }
    const commentStart = trimmed.indexOf(" #");
    const requirement = (
      commentStart === -1 ? trimmed : trimmed.slice(0, commentStart)
    ).trim();
    if (!requirement) {
      continue;
    }
    requirementCount += 1;
    const words = tokens(requirement);
    if (words.some((word) => word.toLowerCase().startsWith("--hash"))) {
      hasHashes = true;
    }
    // The specifier ends at the first option or environment marker.
    const optionStart = words.findIndex((word) => word.startsWith("--"));
    let specifier = (
      optionStart === -1 ? words : words.slice(0, optionStart)
    ).join("");
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

function parsePipRequirements(filePath) {
  const content = readBounded(filePath);
  if (!content) {
    return undefined;
  }
  const { requirementCount, pinCount, hasHashes } = parsePipContent(content);
  const component = createBuildInputComponent(
    basename(filePath),
    filePath,
    "pip",
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
 * @type {{id: string, patterns: string[], parse(files: string[]): {components: Object[]}}}
 */
export const pythonRequirementsFormulationParser = {
  id: "python-requirements",
  patterns: [
    "**/requirements*.txt",
    "**/constraints*.txt",
    "**/requirements/*.txt",
    "**/requirements.d/*.txt",
  ],
  parse(files) {
    const components = [];
    for (const filePath of files || []) {
      const component = parsePipRequirements(filePath);
      if (component) {
        components.push(component);
      }
    }
    return { components };
  },
};

function parseCsProj(filePath) {
  const content = readBounded(filePath);
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

function parseProjectAssets(filePath) {
  const content = readBounded(filePath, MAX_ASSETS_READ_BYTES);
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
  const component = createBuildInputComponent(
    data.project?.restore?.projectName ||
      basename(dirname(filePath)) ||
      "nuget-restore",
    filePath,
    "nuget",
  );
  const properties = component.properties;
  appendProperty(properties, "cdx:nuget:assetsVersion", data.version);
  appendProperty(
    properties,
    "cdx:nuget:frameworks",
    frameworks.length ? frameworks.join(", ") : undefined,
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
 * @type {{id: string, patterns: string[], parse(files: string[]): {components: Object[]}}}
 */
export const dotnetProjectFormulationParser = {
  id: "dotnet-project",
  patterns: [
    "**/project.assets.json",
    "**/packages.assets.json",
    "**/*.csproj",
  ],
  parse(files) {
    const components = [];
    for (const filePath of files || []) {
      const base = basename(filePath).toLowerCase();
      const component = base.endsWith("assets.json")
        ? parseProjectAssets(filePath)
        : parseCsProj(filePath);
      if (component) {
        components.push(component);
      }
    }
    return { components };
  },
};
