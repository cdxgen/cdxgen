import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";

// Build-input formulation parsers for the ecosystems whose build files cdxgen
// can read without running a build: make and CMake for C/C++, go.mod for Go,
// pip requirements and constraints files for Python, and project.assets.json
// plus .csproj for .NET. Rust already has its own parser
// (rustFormulationParser); Go binaries are read by the OBOM path through the
// bounded buildinfo reader, so a source scan records the module file here.

// A build file larger than this is machine generated (or not a build file at
// all), and reading it in full would only burn memory.
const MAX_READ_BYTES = 2 * 1024 * 1024;

function readBounded(filePath) {
  try {
    const content = readFileSync(filePath, { encoding: "utf-8" });
    return content.length > MAX_READ_BYTES
      ? content.slice(0, MAX_READ_BYTES)
      : content;
  } catch {
    return undefined;
  }
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

/**
 * Collect target names, include directives and variable names from a make
 * file. Values are deliberately not recorded: flags can carry tokens or
 * machine-specific paths, and a name is enough for audit triage.
 *
 * @param {string} content make file text
 * @returns {{ targets: string[], includes: string[], variables: string[] }}
 */
function parseMakeContent(content) {
  const targets = [];
  const includes = [];
  const variables = [];
  for (const rawLine of content.split(/\r?\n/)) {
    // Recipe lines and comments cannot declare targets.
    if (rawLine.startsWith("\t") || rawLine.trim().startsWith("#")) {
      continue;
    }
    const trimmed = rawLine.trim();
    if (!trimmed) {
      continue;
    }
    const include = /^-?include\s+(.+)$/.exec(trimmed);
    if (include) {
      includes.push(...include[1].split(/\s+/).filter(Boolean));
      continue;
    }
    const variable = /^([A-Za-z_][A-Za-z0-9_]*)\s*[:?+]?=/.exec(trimmed);
    if (variable) {
      variables.push(variable[1]);
      continue;
    }
    const target = /^([^.#$][^:=]*?)\s*:(?!=)\s*(.*)$/.exec(trimmed);
    if (target) {
      const name = target[1].trim();
      // Pattern rules and rule-spliced targets say nothing about the project.
      if (name && !name.includes("%")) {
        targets.push(name);
      }
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

function parseCMakeLists(filePath) {
  const content = readBounded(filePath);
  if (!content) {
    return undefined;
  }
  const minimum = /cmake_minimum_required\s*\(\s*VERSION\s+([0-9.]+)/.exec(
    content,
  );
  const project = /project\s*\(\s*([A-Za-z0-9_.-]+)([^)]*)\)/.exec(content);
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

function parseGoMod(filePath) {
  const content = readBounded(filePath);
  if (!content) {
    return undefined;
  }
  const module = /^module\s+(\S+)$/m.exec(content);
  if (!module) {
    return undefined;
  }
  const goVersion = /^go\s+(\S+)$/m.exec(content);
  const toolchain = /^toolchain\s+(\S+)$/m.exec(content);
  const requirementLines =
    content.match(/^\s+[^\s/#][^\s]*\s+v[\w.\-]+/gm) || [];
  const indirectCount = (content.match(/\/\/\s*indirect/g) || []).length;
  const component = createBuildInputComponent(module[1], filePath, "go");
  const properties = component.properties;
  appendProperty(properties, "cdx:go:module", module[1]);
  appendProperty(properties, "cdx:go:version", goVersion?.[1]);
  appendProperty(properties, "cdx:go:toolchain", toolchain?.[1]);
  appendProperty(properties, "cdx:go:requireCount", requirementLines.length);
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
 * Count the pinned requirement lines of a pip requirements or constraints
 * file: non-empty, non-comment, non-option lines.
 *
 * @param {string} content file text
 * @returns {{ pinCount: number, hasHashes: boolean }}
 */
function parsePipContent(content) {
  let pinCount = 0;
  let hasHashes = false;
  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("-")) {
      continue;
    }
    pinCount += 1;
    if (/--hash=/i.test(trimmed)) {
      hasHashes = true;
    }
  }
  return { pinCount, hasHashes };
}

function parsePipRequirements(filePath) {
  const content = readBounded(filePath);
  if (!content) {
    return undefined;
  }
  const { pinCount, hasHashes } = parsePipContent(content);
  const component = createBuildInputComponent(
    basename(filePath),
    filePath,
    "pip",
  );
  const properties = component.properties;
  appendProperty(properties, "cdx:pip:pinCount", pinCount);
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
  let data;
  try {
    data = JSON.parse(readFileSync(filePath, { encoding: "utf-8" }));
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
