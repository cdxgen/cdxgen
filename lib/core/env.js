import { join } from "node:path";

import {
  buildReadCountSuffix,
  readEnvironmentVariable,
  recordObservedActivity,
} from "./activity.js";
import { safeExistsSync } from "./fs.js";
import { thoughtLog } from "./logger.js";

/** True when running under Node.js. */
export const isNode = globalThis.process?.versions?.node !== undefined;
/** True when running under Bun. */
export const isBun = globalThis.Bun?.version !== undefined;
/** True when running under Deno. */
export const isDeno = globalThis.Deno?.version?.deno !== undefined;

/** Value of the CDXGEN_SPDX_CREATED_BY environment variable, or undefined when unset. */
export const CDXGEN_SPDX_CREATED_BY = readEnvironmentVariable(
  "CDXGEN_SPDX_CREATED_BY",
);

/**
 * Resolved table border style for console output ("ascii", "unicode", or
 * "auto"), driven by the CDXGEN_TABLE_BORDER environment variable.
 */
export const TABLE_BORDER_STYLE = ["ascii", "unicode", "auto"].includes(
  `${readEnvironmentVariable("CDXGEN_TABLE_BORDER") || ""}`.toLowerCase(),
)
  ? `${readEnvironmentVariable("CDXGEN_TABLE_BORDER")}`.toLowerCase()
  : "auto";

/** True when test scope dependencies should be included for Maven projects (default true unless CDX_MAVEN_INCLUDE_TEST_SCOPE is explicitly false). */
export const includeMavenTestScope =
  !readEnvironmentVariable("CDX_MAVEN_INCLUDE_TEST_SCOPE") ||
  ["true", "1"].includes(
    readEnvironmentVariable("CDX_MAVEN_INCLUDE_TEST_SCOPE"),
  );

/** True when the native Maven dependency tree command should be preferred (default true unless PREFER_MAVEN_DEPS_TREE is false/0). */
export const PREFER_MAVEN_DEPS_TREE = !["false", "0"].includes(
  readEnvironmentVariable("PREFER_MAVEN_DEPS_TREE"),
);

/**
 * Split a Maven arguments string into an argv array, honoring shell quoting
 * (single and double quotes) and backslash escaping of whitespace and quotes.
 *
 * @param {string} argsString Raw Maven arguments string.
 * @returns {string[]} Parsed argument array, or an empty array when input is falsy.
 */
export function parseMavenArgs(argsString) {
  if (!argsString) {
    return [];
  }
  const args = [];
  let currentArg = "";
  let quoteChar = "";
  for (let i = 0; i < argsString.length; i++) {
    const char = argsString[i];
    if (char === "\\") {
      const nextChar = argsString[i + 1];
      if (
        nextChar &&
        (/\s/.test(nextChar) || nextChar === '"' || nextChar === "'")
      ) {
        currentArg += nextChar;
        i++;
      } else {
        currentArg += char;
      }
      continue;
    }
    if (quoteChar) {
      if (char === quoteChar) {
        quoteChar = "";
      } else {
        currentArg += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quoteChar = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (currentArg) {
        args.push(currentArg);
        currentArg = "";
      }
      continue;
    }
    currentArg += char;
  }
  if (currentArg) {
    args.push(currentArg);
  }
  return args;
}

/**
 * Determines whether license information should be fetched from remote sources,
 * based on the FETCH_LICENSE environment variable.
 *
 * @returns {boolean} True if the FETCH_LICENSE env var is set to "true" or "1"
 */
export function shouldFetchLicense() {
  return (
    readEnvironmentVariable("FETCH_LICENSE") &&
    ["true", "1"].includes(readEnvironmentVariable("FETCH_LICENSE"))
  );
}

/**
 * Determines whether registry provenance, such as publish times, publishers
 * and trusted-publishing signals, is wanted. `--bom-audit` turns it on through
 * CDXGEN_FETCH_PKG_METADATA. Local data cannot answer these questions, so a
 * package whose licence and description are known locally is still looked up.
 *
 * @returns {boolean} True if CDXGEN_FETCH_PKG_METADATA is "true" or "1"
 */
export function shouldFetchRegistryProvenance() {
  return ["true", "1"].includes(
    readEnvironmentVariable("CDXGEN_FETCH_PKG_METADATA"),
  );
}

/**
 * Determines whether remote package metadata should be fetched for enrichment.
 *
 * @returns {boolean} True when registry metadata enrichment is enabled.
 */
export function shouldFetchPackageMetadata() {
  return shouldFetchLicense() || shouldFetchRegistryProvenance();
}

/**
 * Determines whether VCS (version control system) information should be fetched
 * for Go packages, based on the GO_FETCH_VCS environment variable.
 *
 * @returns {boolean} True if the GO_FETCH_VCS env var is set to "true" or "1"
 */
export function shouldFetchVCS() {
  return (
    readEnvironmentVariable("GO_FETCH_VCS") &&
    ["true", "1"].includes(readEnvironmentVariable("GO_FETCH_VCS"))
  );
}

/** True when license information should be fetched from remote sources (FETCH_LICENSE env var). */
export const FETCH_LICENSE = shouldFetchLicense();

/** True when search.maven.org should be used to identify jars without Maven metadata (default true unless SEARCH_MAVEN_ORG is explicitly false). */
export const SEARCH_MAVEN_ORG =
  !readEnvironmentVariable("SEARCH_MAVEN_ORG") ||
  ["true", "1"].includes(readEnvironmentVariable("SEARCH_MAVEN_ORG"));

/** Resolved Java executable command (JAVA_CMD env var > JAVA_HOME/bin/java > "java"). */
export const JAVA_CMD = getJavaCommand();

/**
 * Returns the Java executable command to use, resolved in priority order:
 * JAVA_CMD env var > JAVA_HOME/bin/java > "java".
 *
 * @returns {string} Path or name of the Java executable
 */
export function getJavaCommand() {
  let javaCmd = "java";
  if (readEnvironmentVariable("JAVA_CMD")) {
    javaCmd = readEnvironmentVariable("JAVA_CMD");
  } else if (
    readEnvironmentVariable("JAVA_HOME") &&
    safeExistsSync(readEnvironmentVariable("JAVA_HOME")) &&
    safeExistsSync(join(readEnvironmentVariable("JAVA_HOME"), "bin", "java"))
  ) {
    javaCmd = join(readEnvironmentVariable("JAVA_HOME"), "bin", "java");
  }
  return javaCmd;
}

/** Resolved Python executable command (PYTHON_CMD env var > CONDA_PYTHON_EXE > "python"). */
export const PYTHON_CMD = getPythonCommand();

/**
 * Whether an executable of the given name is reachable through PATH.
 *
 * @param {string} name Executable name, without a platform extension.
 * @returns {boolean} True when a PATH entry holds the executable.
 */
function isOnPath(name) {
  const searchPath = readEnvironmentVariable("PATH");
  if (!searchPath) {
    return false;
  }
  const names =
    process.platform === "win32" ? [`${name}.exe`, `${name}.bat`] : [name];
  return searchPath
    .split(process.platform === "win32" ? ";" : ":")
    .some((binDir) =>
      names.some((binName) => binDir && safeExistsSync(join(binDir, binName))),
    );
}

/**
 * Returns the Python executable command to use, resolved in priority order:
 * PYTHON_CMD env var > CONDA_PYTHON_EXE env var > "python" > "python3".
 *
 * Distributions that ship only a versioned interpreter leave a bare "python"
 * unresolvable, which would fail every virtualenv this tool creates, so the
 * versioned name is used when it is the only one PATH offers.
 *
 * @returns {string} Path or name of the Python executable
 */
export function getPythonCommand() {
  let pythonCmd = "python";
  if (readEnvironmentVariable("PYTHON_CMD")) {
    pythonCmd = readEnvironmentVariable("PYTHON_CMD");
  } else if (readEnvironmentVariable("CONDA_PYTHON_EXE")) {
    pythonCmd = readEnvironmentVariable("CONDA_PYTHON_EXE");
  } else if (!isOnPath("python") && isOnPath("python3")) {
    pythonCmd = "python3";
  }
  return pythonCmd;
}

/** Resolved .NET CLI command (DOTNET_CMD env var, or "dotnet"). */
export let DOTNET_CMD = "dotnet";
if (readEnvironmentVariable("DOTNET_CMD")) {
  DOTNET_CMD = readEnvironmentVariable("DOTNET_CMD");
}
/** Resolved Node.js executable command (NODE_CMD env var, or "node"). */
export let NODE_CMD = "node";
if (readEnvironmentVariable("NODE_CMD")) {
  NODE_CMD = readEnvironmentVariable("NODE_CMD");
}
/** Resolved npm executable command (NPM_CMD env var, or "npm"). */
export let NPM_CMD = "npm";
if (readEnvironmentVariable("NPM_CMD")) {
  NPM_CMD = readEnvironmentVariable("NPM_CMD");
}
/** Resolved Yarn executable command (YARN_CMD env var, or "yarn"). */
export let YARN_CMD = "yarn";
if (readEnvironmentVariable("YARN_CMD")) {
  YARN_CMD = readEnvironmentVariable("YARN_CMD");
}
/** Resolved GCC executable command (GCC_CMD env var, or "gcc"). */
export let GCC_CMD = "gcc";
if (readEnvironmentVariable("GCC_CMD")) {
  GCC_CMD = readEnvironmentVariable("GCC_CMD");
}
/** Resolved rustc executable command (RUSTC_CMD env var, or "rustc"). */
export let RUSTC_CMD = "rustc";
if (readEnvironmentVariable("RUSTC_CMD")) {
  RUSTC_CMD = readEnvironmentVariable("RUSTC_CMD");
}
/** Resolved Go executable command (GO_CMD env var, or "go"). */
export let GO_CMD = "go";
if (readEnvironmentVariable("GO_CMD")) {
  GO_CMD = readEnvironmentVariable("GO_CMD");
}
/** Resolved Cargo executable command (CARGO_CMD env var, or "cargo"). */
export let CARGO_CMD = "cargo";
if (readEnvironmentVariable("CARGO_CMD")) {
  CARGO_CMD = readEnvironmentVariable("CARGO_CMD");
}

/**
 * Target triple the cargo resolve graph is filtered to, so that a
 * cross-compiled project can be described for the triple it ships on rather
 * than for the union of every triple its lock file covers.
 *
 * `CDXGEN_CARGO_TARGET` is cdxgen's own name for it; `CARGO_BUILD_TARGET` is
 * cargo's standard variable, which a cross-compiling build already sets.
 */
export const CARGO_TARGET =
  readEnvironmentVariable("CDXGEN_CARGO_TARGET") ||
  readEnvironmentVariable("CARGO_BUILD_TARGET") ||
  undefined;

/** Resolved Clojure CLI executable command (CLJ_CMD env var, or "clj"). */
export let CLJ_CMD = "clj";
if (readEnvironmentVariable("CLJ_CMD")) {
  CLJ_CMD = readEnvironmentVariable("CLJ_CMD");
}

/** Resolved Leiningen executable command (LEIN_CMD env var, or "lein"). */
export let LEIN_CMD = "lein";
if (readEnvironmentVariable("LEIN_CMD")) {
  LEIN_CMD = readEnvironmentVariable("LEIN_CMD");
}

/** Resolved temp directory used by cdxgen (CDXGEN_TEMP_DIR env var, or "temp"). */
export let CDXGEN_TEMP_DIR = "temp";
if (readEnvironmentVariable("CDXGEN_TEMP_DIR")) {
  CDXGEN_TEMP_DIR = readEnvironmentVariable("CDXGEN_TEMP_DIR");
}

/** Resolved Swift executable command (SWIFT_CMD env var, or "swift"). */
export const SWIFT_CMD = readEnvironmentVariable("SWIFT_CMD") || "swift";

/** Resolved Ruby executable command (RUBY_CMD env var, or "ruby"). */
export const RUBY_CMD = readEnvironmentVariable("RUBY_CMD") || "ruby";

/** Python package components that can be excluded from the generated BOM. */
export const PYTHON_EXCLUDED_COMPONENTS = [
  "pip",
  "setuptools",
  "wheel",
  "conda",
  "conda-build",
  "conda-index",
  "conda-libmamba-solver",
  "conda-package-handling",
  "conda-package-streaming",
  "conda-content-trust",
];

/** Map of base cdxgen project type to the array of accepted alias strings. */
export const PROJECT_TYPE_ALIASES = {
  java: [
    "java",
    "java8",
    "java11",
    "java17",
    "java21",
    "java22",
    "java23",
    "java24",
    "java25",
    "java26",
    "java27",
    "groovy",
    "kotlin",
    "kt",
    "scala",
    "jvm",
    "gradle",
    "mvn",
    "maven",
    "sbt",
    "bazel",
    "quarkus",
    "mill",
  ],
  android: ["android", "apk", "aab"],
  jar: ["jar", "war", "ear"],
  "gradle-index": ["gradle-index", "gradle-cache"],
  "sbt-index": ["sbt-index", "sbt-cache"],
  "maven-index": ["maven-index", "maven-cache", "maven-core"],
  "cargo-cache": ["cargo-cache", "cargo-index"],
  js: [
    "npm",
    "pnpm",
    "nodejs",
    "nodejs8",
    "nodejs10",
    "nodejs12",
    "nodejs14",
    "nodejs16",
    "nodejs18",
    "nodejs20",
    "nodejs22",
    "nodejs23",
    "nodejs24",
    "nodejs25",
    "nodejs26",
    "node",
    "node8",
    "node10",
    "node12",
    "node14",
    "node16",
    "node18",
    "node20",
    "node22",
    "node23",
    "node24",
    "node25",
    "node26",
    "js",
    "javascript",
    "typescript",
    "ts",
    "tsx",
    "svelte",
    "sveltekit",
    "yarn",
    "rush",
    "bun",
    "deno",
  ],
  mcp: ["mcp"],
  "ai-skill": ["ai-skill", "skill", "skills"],
  agentic: ["agentic", "agentic-cli", "ai-tools", "ai-cli"],
  py: [
    "py",
    "python",
    "pypi",
    "python36",
    "python38",
    "python39",
    "python310",
    "python311",
    "python312",
    "python313",
    "python314",
    "python315",
    "pixi",
    "pip",
    "poetry",
    "uv",
    "pdm",
    "rye",
    "hatch",
    "conda",
    "miniconda",
    "pyenv",
    "mojo",
  ],
  go: ["go", "golang", "gomod", "gopkg"],
  rust: ["rust", "rust-lang", "cargo", "rs"],
  php: ["php", "composer", "wordpress"],
  ruby: ["ruby", "gems", "rubygems", "bundler", "rb", "gemspec"],
  csharp: [
    "csharp",
    "netcore",
    "netcore2.1",
    "netcore3.1",
    "dotnet",
    "dotnet6",
    "dotnet7",
    "dotnet8",
    "dotnet9",
    "dotnet10",
    "dotnet11",
    "dotnet-framework",
    "dotnet-framework47",
    "dotnet-framework48",
    "vb",
    "vbnet",
    "visualbasic",
    "f#",
    "fs",
    "fsharp",
    "twincat",
    "csproj",
    "tsproj",
    "vbproj",
    "sln",
    "fsproj",
    "plcproj",
    "hmiproj",
  ],
  dart: ["dart", "flutter", "pub"],
  haskell: ["haskell", "hackage", "cabal", "stack", "stackage"],
  elixir: ["elixir", "hex", "mix"],
  erlang: ["erlang", "rebar", "rebar3"],
  julia: ["julia"],
  r: ["r", "cran", "renv"],
  ocaml: ["ocaml", "opam", "dune"],
  elm: ["elm"],
  crystal: ["crystal", "shards"],
  nim: ["nim", "nimble"],
  lua: ["lua", "luarocks"],
  perl: ["perl", "cpan", "carton", "cpanfile"],
  spack: ["spack"],
  terraform: ["terraform", "opentofu", "tf"],
  c: ["c", "cpp", "c++", "conan", "collider", "cmake", "meson", "vcpkg"],
  clojure: ["clojure", "edn", "clj", "leiningen"],
  github: ["github", "actions"],
  hbom: ["hbom", "hardware"],
  os: ["os", "osquery", "windows", "linux", "mac", "macos", "darwin"],
  jenkins: ["jenkins", "hpi"],
  helm: ["helm", "charts"],
  "helm-index": ["helm-index", "helm-repo"],
  universal: [
    "universal",
    "containerfile",
    "docker-compose",
    "dockerfile",
    "swarm",
    "tekton",
    "kustomize",
    "operator",
    "skaffold",
    "kubernetes",
    "openshift",
    "yaml-manifest",
  ],
  cloudbuild: ["cloudbuild"],
  swift: [
    "swift",
    "ios",
    "macos",
    "swiftpm",
    "ipados",
    "tvos",
    "watchos",
    "visionos",
  ],
  binary: ["binary", "blint"],
  oci: ["docker", "image", "oci", "container", "podman", "rootfs", "oci-dir"],
  cocoa: ["cocoa", "cocoapods", "objective-c", "swift", "ios"],
  scala: ["scala", "scala3", "sbt", "mill", "scala-cli"],
  nix: ["nix", "nixos", "flake"],
  zig: ["zig", "zon"],
  gleam: ["gleam"],
  caxa: ["caxa"],
  asar: ["asar", "electron", "electron-asar"],
  "vscode-extension": [
    "vscode-extension",
    "vsix",
    "vscode",
    "openvsx",
    "vscode-extensions",
    "ide-extension",
    "ide-extensions",
  ],
  "chrome-extension": [
    "chrome-extension",
    "chrome-extensions",
    "chromium-extension",
    "chromium-extensions",
  ],
  dynamic: ["dynamic", "trace"],
  "ai-provenance": ["ai-provenance", "ai-authorship", "aicode", "ai-codegen"],
};

/** Map of base package manager to the array of accepted alias strings. */
export const PACKAGE_MANAGER_ALIASES = {
  scala: ["sbt"],
};

/**
 * Project-type prefixes that accept a version suffix pinning a JVM build
 * tool, e.g. `maven3.9.9`, `mvn3.9.9`, `gradle8.14`, `sbt1.10`, or
 * `scala3.6.4`. Kept alongside the alias map because both describe how CLI
 * project types map to base types.
 *
 * @type {string[]}
 */
export const JVM_BUILD_TOOL_TYPE_PREFIXES = [
  "maven",
  "mvn",
  "gradle",
  "sbt",
  "scala",
];

/**
 * Check whether a project type pins a JVM build tool version, i.e. it starts
 * with one of the JVM build tool prefixes followed by a digit.
 *
 * @param {string} projectType Project type from the CLI
 * @returns {boolean} True for versioned JVM build tool types.
 */
export function isVersionedJvmToolProjectType(projectType) {
  const pt = `${projectType || ""}`.toLowerCase();
  for (const prefix of JVM_BUILD_TOOL_TYPE_PREFIXES) {
    if (pt.startsWith(prefix) && /^\d/.test(pt.slice(prefix.length))) {
      return true;
    }
  }
  return false;
}

/**
 * Method to check if a given feature flag is enabled.
 *
 * @param {Object} cliOptions CLI options
 * @param {String} feature Feature flag
 *
 * @returns {Boolean} True if the feature is enabled
 */
export function isFeatureEnabled(cliOptions, feature) {
  if (cliOptions?.featureFlags?.includes(feature)) {
    return true;
  }
  if (
    readEnvironmentVariable(feature.toUpperCase()) &&
    ["true", "1"].includes(readEnvironmentVariable(feature.toUpperCase()))
  ) {
    return true;
  }
  // Retry by replacing hyphens with underscore
  return !!(
    readEnvironmentVariable(feature.replaceAll("-", "_").toUpperCase()) &&
    ["true", "1"].includes(
      readEnvironmentVariable(feature.replaceAll("-", "_").toUpperCase()),
    )
  );
}

/**
 * Method to check if the given project types are allowed by checking against include and exclude types passed from the CLI arguments.
 *
 * @param {Array} projectTypes project types to check
 * @param {Object} options CLI options
 * @param {Boolean} defaultStatus Default return value if there are no types provided
 */
export function hasAnyProjectType(projectTypes, options, defaultStatus = true) {
  // If no project type is specified, then consider it as yes
  if (
    !projectTypes ||
    (!options.projectType?.length && !options.excludeType?.length)
  ) {
    return defaultStatus;
  }
  // Convert string project types to an array
  if (
    projectTypes &&
    (typeof projectTypes === "string" || projectTypes instanceof String)
  ) {
    projectTypes = projectTypes.split(",");
  }
  // If only exclude type is specified, then do not allow oci type
  if (
    (projectTypes?.length === 1 || !defaultStatus) &&
    !options.projectType?.length &&
    options.excludeType?.length
  ) {
    const isExcluded = projectTypes.some((pt) => {
      const ptLower = pt.toLowerCase();
      if (options.excludeType.includes(ptLower)) {
        return true;
      }
      for (const et of options.excludeType) {
        const etLower = et.toLowerCase();
        for (const [key, aliases] of Object.entries(PROJECT_TYPE_ALIASES)) {
          if (
            (key === etLower || aliases.includes(etLower)) &&
            (key === ptLower || aliases.includes(ptLower))
          ) {
            return true;
          }
        }
      }
      return false;
    });
    if (isExcluded) {
      return false;
    }
    return (
      !projectTypes.includes("oci") &&
      !projectTypes.includes("oci-dir") &&
      !projectTypes.includes("os") &&
      !projectTypes.includes("docker") &&
      !options.excludeType.includes("oci")
    );
  }
  const allProjectTypes = [...projectTypes];
  // Convert the project types into base types
  const baseProjectTypes = [];
  // Support for arbitrary versioned ruby type: a requested ruby3.4.1 is a
  // ruby project. The test is on the requested types; testing the queried
  // ones made every scan a ruby scan whenever "ruby" was asked about.
  if (options.projectType?.some((p) => p.startsWith("ruby"))) {
    baseProjectTypes.push("ruby");
  }
  // Versioned JVM build tool types such as maven3.9.9 or gradle8.14 are java
  // types with a pinned build tool, so they must dispatch java parsing too.
  if (
    options.projectType?.length &&
    projectTypes.includes("java") &&
    options.projectType.some((pt) => isVersionedJvmToolProjectType(pt))
  ) {
    baseProjectTypes.push("java");
  }
  const baseExcludeTypes = [];
  for (const abt of Object.keys(PROJECT_TYPE_ALIASES)) {
    if (
      PROJECT_TYPE_ALIASES[abt].filter((pt) =>
        new Set(options?.projectType).has(pt),
      ).length
    ) {
      baseProjectTypes.push(abt);
    }
    if (
      PROJECT_TYPE_ALIASES[abt].filter((pt) => new Set(projectTypes).has(pt))
        .length
    ) {
      allProjectTypes.push(abt);
    }
    if (
      PROJECT_TYPE_ALIASES[abt].filter((pt) =>
        new Set(options?.excludeType).has(pt),
      ).length
    ) {
      baseExcludeTypes.push(abt);
    }
  }
  const shouldInclude =
    !options.projectType?.length ||
    options.projectType?.includes("universal") ||
    options.projectType?.filter((pt) => new Set(allProjectTypes).has(pt))
      .length > 0 ||
    baseProjectTypes.filter((pt) => new Set(allProjectTypes).has(pt)).length >
      0;
  if (shouldInclude && options.excludeType) {
    return (
      !baseExcludeTypes.filter((pt) => pt && new Set(baseProjectTypes).has(pt))
        .length &&
      !baseExcludeTypes.filter((pt) => pt && new Set(allProjectTypes).has(pt))
        .length
    );
  }
  return shouldInclude;
}

/**
 * Determine whether the predictive dependency audit should run for the current
 * CLI invocation.
 *
 * OBOM-focused runs (`obom` or explicit `-t os` / OS aliases only) should keep
 * the direct BOM audit findings but skip the predictive dependency audit.
 *
 * @param {object} options CLI options
 * @param {string} [commandPath] Invoked command path or name
 * @returns {boolean} True when predictive dependency audit should run
 */
export function shouldRunPredictiveBomAudit(options, commandPath) {
  const normalizedCommandPath = `${commandPath || ""}`.toLowerCase();
  if (normalizedCommandPath.includes("obom")) {
    return false;
  }
  if (normalizedCommandPath.includes("hbom")) {
    return false;
  }
  const projectTypes = Array.isArray(options?.projectType)
    ? options.projectType
    : typeof options?.projectType === "string"
      ? options.projectType.split(",")
      : [];
  const normalizedProjectTypes = projectTypes
    .map((projectType) => `${projectType || ""}`.trim().toLowerCase())
    .filter(Boolean);
  if (!normalizedProjectTypes.length) {
    return true;
  }
  const hbomProjectTypes = new Set(["hbom", "hardware"]);
  if (
    normalizedProjectTypes.every((projectType) =>
      hbomProjectTypes.has(projectType),
    )
  ) {
    return false;
  }
  const osProjectTypes = new Set(["os", ...(PROJECT_TYPE_ALIASES.os || [])]);
  return !normalizedProjectTypes.every((projectType) =>
    osProjectTypes.has(projectType),
  );
}

/**
 * Convenient method to check if the given package manager is allowed.
 *
 * @param {String} name Package manager name
 * @param {Array} conflictingManagers List of package managers
 * @param {Object} options CLI options
 *
 * @returns {Boolean} True if the package manager is allowed
 */
export function isPackageManagerAllowed(name, conflictingManagers, options) {
  for (const apm of conflictingManagers) {
    if (options?.projectType?.includes(apm)) {
      return false;
    }
  }
  const res = !options.excludeType?.filter(
    (p) => p === name || PACKAGE_MANAGER_ALIASES[p]?.includes(name),
  ).length;
  if (res) {
    thoughtLog(
      `**PACKAGE MANAGER**: Let's make use of the package manager '${name}', which is allowed.`,
    );
  }
  return res;
}

/**
 * Function to parse a list of environment variables to identify the paths containing executable binaries
 *
 * @param envValues {Array[String]} Environment variables list
 * @returns {Array[String]} Binary Paths identified from the environment variables
 */
export function extractPathEnv(envValues) {
  if (!envValues) {
    return [];
  }
  let binPaths = new Set();
  const shellVariables = {};
  // Let's focus only on linux container images for now
  for (const env of envValues) {
    if (env.startsWith("PATH=")) {
      binPaths = new Set(env.replace("PATH=", "").split(":"));
    } else {
      const tmpA = env.split("=");
      if (tmpA.length === 2) {
        shellVariables[`$${tmpA[0]}`] = tmpA[1];
        shellVariables[`\${${tmpA[0]}}`] = tmpA[1];
      }
    }
  }
  binPaths = Array.from(binPaths);
  const expandedBinPaths = [];
  for (let apath of binPaths) {
    // Filter empty paths
    if (!apath.length) {
      continue;
    }
    if (apath.includes("$")) {
      for (const k of Object.keys(shellVariables)) {
        apath = apath.replace(k, shellVariables[k]);
      }
    }
    // We're here, but not all paths got substituted
    // Let's ignore them for now instead of risking substitution based on host values.
    // Eg: ${GITHUB_TOKEN} could get expanded with the values from the host
    if (apath.length && !apath.includes("$")) {
      expandedBinPaths.push(apath);
    }
  }
  recordObservedActivity("path-resolution", "PATH", {
    metadata: {
      capability: "path-lookup",
      pathCount: expandedBinPaths.length,
    },
    reasonBuilder: (count) =>
      `Expanded PATH into ${expandedBinPaths.length} executable search path(s)${buildReadCountSuffix(count)}.`,
  });
  return expandedBinPaths;
}
