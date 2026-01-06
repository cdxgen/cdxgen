import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  constants,
  copyFileSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import path, {
  delimiter as _delimiter,
  sep as _sep,
  basename,
  dirname,
  extname,
  join,
  relative,
  resolve,
} from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

import toml from "@iarna/toml";
import { load } from "cheerio";
import { parseEDNString } from "edn-data";
import { globSync } from "glob";
import got from "got";
import iconv from "iconv-lite";
import Keyv from "keyv";
import StreamZip from "node-stream-zip";
import { PackageURL } from "packageurl-js";
import propertiesReader from "properties-reader";
import {
  clean,
  coerce,
  compare,
  maxSatisfying,
  parse,
  satisfies,
  valid,
} from "semver";
import { xml2js } from "xml-js";
import { parse as _load } from "yaml";

import { getTreeWithPlugin } from "../managers/piptree.js";
import { IriValidationStrategy, validateIri } from "../parsers/iri.js";
import Arborist from "../third-party/arborist/lib/index.js";
import { extractPackageInfoFromHintPath } from "./dotnetutils.js";
import { thoughtLog, traceLog } from "./logger.js";

let url = import.meta?.url;
if (url && !url.startsWith("file://")) {
  url = new URL(`file://${import.meta.url}`).toString();
}
// TODO: verify if this is a good method (Prabhu)
// this is due to dirNameStr being "cdxgen/lib/helpers" which causes errors
export const dirNameStr = url
  ? dirname(dirname(dirname(fileURLToPath(url))))
  : __dirname;

export const isSecureMode =
  ["true", "1"].includes(process.env?.CDXGEN_SECURE_MODE) ||
  process.env?.NODE_OPTIONS?.includes("--permission");

export const isWin = platform() === "win32";
export const isMac = platform() === "darwin";
export let ATOM_DB = join(homedir(), ".local", "share", ".atomdb");
if (isWin) {
  ATOM_DB = join(homedir(), "AppData", "Local", ".atomdb");
} else if (isMac) {
  ATOM_DB = join(homedir(), "Library", "Application Support", ".atomdb");
}

/**
 * Safely check if a file path exists without crashing due to a lack of permissions
 *
 * @param {String} filePath File path
 * @Boolean True if the path exists. False otherwise
 */
export function safeExistsSync(filePath) {
  if (isSecureMode && process.permission) {
    if (!process.permission.has("fs.read", join(filePath, "", "*"))) {
      if (DEBUG_MODE) {
        console.log(`cdxgen lacks read permission for: ${filePath}`);
      }
      return false;
    }
  }
  return existsSync(filePath);
}

/**
 * Safely create a directory without crashing due to a lack of permissions
 *
 * @param {String} filePath File path
 * @param options {Options} mkdir options
 * @Boolean True if the path exists. False otherwise
 */
export function safeMkdirSync(filePath, options) {
  if (isSecureMode && process.permission) {
    if (!process.permission.has("fs.write", join(filePath, "", "*"))) {
      if (DEBUG_MODE) {
        console.log(`cdxgen lacks write permission for: ${filePath}`);
      }
      return undefined;
    }
  }
  return mkdirSync(filePath, options);
}

export const commandsExecuted = new Set();
function isAllowedCommand(command) {
  if (!process.env.CDXGEN_ALLOWED_COMMANDS) {
    return true;
  }
  const allow_commands = (process.env.CDXGEN_ALLOWED_COMMANDS || "").split(",");
  return allow_commands.includes(command.trim());
}

export function safeSpawnSync(command, args, options) {
  if (
    (isSecureMode && process.permission && !process.permission.has("child")) ||
    !isAllowedCommand(command)
  ) {
    if (DEBUG_MODE) {
      console.log(`cdxgen lacks execute permission for ${command}`);
    }
    return {
      status: 1,
      stdout: undefined,
      stderr: undefined,
      error: new Error("No execute permission"),
    };
  }
  if (!options) {
    options = {};
  }
  // Inject maxBuffer
  if (!options.maxBuffer) {
    options.maxBuffer = MAX_BUFFER;
  }
  // Inject encoding
  if (!options.encoding) {
    options.encoding = "utf-8";
  }
  // Inject timeout
  if (!options.timeout) {
    options.timeout = TIMEOUT_MS;
  }
  traceLog("spawn", { command, args, ...options });
  commandsExecuted.add(command);
  // Fix for DEP0190 warning
  if (options?.shell === true) {
    if (args?.length) {
      command = `${command} ${args.join(" ")}`;
      args = undefined;
    }
  }
  return spawnSync(command, args, options);
}

const licenseMapping = JSON.parse(
  readFileSync(join(dirNameStr, "data", "lic-mapping.json"), "utf-8"),
);
const vendorAliases = JSON.parse(
  readFileSync(join(dirNameStr, "data", "vendor-alias.json"), "utf-8"),
);
const spdxLicenses = JSON.parse(
  readFileSync(join(dirNameStr, "data", "spdx-licenses.json"), "utf-8"),
);
const knownLicenses = JSON.parse(
  readFileSync(join(dirNameStr, "data", "known-licenses.json"), "utf-8"),
);
const mesonWrapDB = JSON.parse(
  readFileSync(join(dirNameStr, "data", "wrapdb-releases.json"), "utf-8"),
);
export const frameworksList = JSON.parse(
  readFileSync(join(dirNameStr, "data", "frameworks-list.json"), "utf-8"),
);
const selfPJson = JSON.parse(
  readFileSync(join(dirNameStr, "package.json"), "utf-8"),
);

const CPP_STD_MODULES = JSON.parse(
  readFileSync(join(dirNameStr, "data", "glibc-stdlib.json"), "utf-8"),
);
export const CDXGEN_VERSION = selfPJson.version;

// Refer to contrib/py-modules.py for a script to generate this list
// The script needs to be used once every few months to update this list
const PYTHON_STD_MODULES = JSON.parse(
  readFileSync(join(dirNameStr, "data", "python-stdlib.json"), "utf-8"),
);
// Mapping between modules and package names
const PYPI_MODULE_PACKAGE_MAPPING = JSON.parse(
  readFileSync(join(dirNameStr, "data", "pypi-pkg-aliases.json"), "utf-8"),
);

// FIXME. This has to get removed, once we improve the module detection one-liner.
// If you're a Rubyist, please help us improve this code.
const RUBY_KNOWN_MODULES = JSON.parse(
  readFileSync(join(dirNameStr, "data", "ruby-known-modules.json"), "utf-8"),
);

// Debug mode flag
export const DEBUG_MODE =
  ["debug", "verbose"].includes(process.env.CDXGEN_DEBUG_MODE) ||
  process.env.SCAN_DEBUG_MODE === "debug";

// Timeout milliseconds. Default 20 mins
export const TIMEOUT_MS =
  Number.parseInt(process.env.CDXGEN_TIMEOUT_MS, 10) || 20 * 60 * 1000;

// Max buffer for stdout and stderr. Defaults to 100MB
export const MAX_BUFFER =
  Number.parseInt(process.env.CDXGEN_MAX_BUFFER, 10) || 100 * 1024 * 1024;

// Metadata cache
export let metadata_cache = {};
// Speed up lookup namespaces for a given jar
const jarNSMapping_cache = {};

// Temporary files written by cdxgen, will be removed on exit
const temporaryFiles = new Set();
process.on("exit", () =>
  temporaryFiles.forEach((tempFile) => {
    if (safeExistsSync(tempFile)) {
      unlinkSync(tempFile);
    }
  }),
);

// Whether test scope shall be included for java/maven projects; default, if unset shall be 'true'
export const includeMavenTestScope =
  !process.env.CDX_MAVEN_INCLUDE_TEST_SCOPE ||
  ["true", "1"].includes(process.env.CDX_MAVEN_INCLUDE_TEST_SCOPE);

// Whether to use the native maven dependency tree command. Defaults to true.
export const PREFER_MAVEN_DEPS_TREE = !["false", "0"].includes(
  process.env?.PREFER_MAVEN_DEPS_TREE,
);

export function shouldFetchLicense() {
  return (
    process.env.FETCH_LICENSE &&
    ["true", "1"].includes(process.env.FETCH_LICENSE)
  );
}

export function shouldFetchVCS() {
  return (
    process.env.GO_FETCH_VCS && ["true", "1"].includes(process.env.GO_FETCH_VCS)
  );
}

// Whether license information should be fetched
export const FETCH_LICENSE = shouldFetchLicense();

// Whether search.maven.org will be used to identify jars without maven metadata; default, if unset shall be 'true'
export const SEARCH_MAVEN_ORG =
  !process.env.SEARCH_MAVEN_ORG ||
  ["true", "1"].includes(process.env.SEARCH_MAVEN_ORG);

// circuit breaker for search maven.org
let search_maven_org_errors = 0;
const MAX_SEARCH_MAVEN_ORG_ERRORS = 1;

// circuit breaker for get repo license
let get_repo_license_errors = 0;
const MAX_GET_REPO_LICENSE_ERRORS = 5;

const MAX_LICENSE_ID_LENGTH = 100;

export const JAVA_CMD = getJavaCommand();

export function getJavaCommand() {
  let javaCmd = "java";
  if (process.env.JAVA_CMD) {
    javaCmd = process.env.JAVA_CMD;
  } else if (
    process.env.JAVA_HOME &&
    safeExistsSync(process.env.JAVA_HOME) &&
    safeExistsSync(join(process.env.JAVA_HOME, "bin", "java"))
  ) {
    javaCmd = join(process.env.JAVA_HOME, "bin", "java");
  }
  return javaCmd;
}

export const PYTHON_CMD = getPythonCommand();

export function getPythonCommand() {
  let pythonCmd = "python";
  if (process.env.PYTHON_CMD) {
    pythonCmd = process.env.PYTHON_CMD;
  } else if (process.env.CONDA_PYTHON_EXE) {
    pythonCmd = process.env.CONDA_PYTHON_EXE;
  }
  return pythonCmd;
}

export let DOTNET_CMD = "dotnet";
if (process.env.DOTNET_CMD) {
  DOTNET_CMD = process.env.DOTNET_CMD;
}
export let NODE_CMD = "node";
if (process.env.NODE_CMD) {
  NODE_CMD = process.env.NODE_CMD;
}
export let NPM_CMD = "npm";
if (process.env.NPM_CMD) {
  NPM_CMD = process.env.NPM_CMD;
}
export let YARN_CMD = "yarn";
if (process.env.YARN_CMD) {
  YARN_CMD = process.env.YARN_CMD;
}
export let GCC_CMD = "gcc";
if (process.env.GCC_CMD) {
  GCC_CMD = process.env.GCC_CMD;
}
export let RUSTC_CMD = "rustc";
if (process.env.RUSTC_CMD) {
  RUSTC_CMD = process.env.RUSTC_CMD;
}
export let GO_CMD = "go";
if (process.env.GO_CMD) {
  GO_CMD = process.env.GO_CMD;
}
export let CARGO_CMD = "cargo";
if (process.env.CARGO_CMD) {
  CARGO_CMD = process.env.CARGO_CMD;
}

// Clojure CLI
export let CLJ_CMD = "clj";
if (process.env.CLJ_CMD) {
  CLJ_CMD = process.env.CLJ_CMD;
}

export let LEIN_CMD = "lein";
if (process.env.LEIN_CMD) {
  LEIN_CMD = process.env.LEIN_CMD;
}

export let CDXGEN_TEMP_DIR = "temp";
if (process.env.CDXGEN_TEMP_DIR) {
  CDXGEN_TEMP_DIR = process.env.CDXGEN_TEMP_DIR;
}

// On a mac, use xcrun
// xcrun: Find and execute the named command line tool from the active developer directory
export const SWIFT_CMD =
  process.env.SWIFT_CMD || isMac ? "xcrun swift" : "swift";

export const RUBY_CMD = process.env.RUBY_CMD || "ruby";

// Python components that can be excluded
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

// Project type aliases
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
    "js",
    "javascript",
    "typescript",
    "ts",
    "tsx",
    "vsix",
    "yarn",
    "rush",
  ],
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
    "pixi",
    "pip",
    "poetry",
    "uv",
    "pdm",
    "hatch",
  ],
  go: ["go", "golang", "gomod", "gopkg"],
  rust: ["rust", "rust-lang", "cargo"],
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
    "dotnet-framework",
    "dotnet-framework47",
    "dotnet-framework48",
    "vb",
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
  haskell: ["haskell", "hackage", "cabal"],
  elixir: ["elixir", "hex", "mix"],
  c: ["c", "cpp", "c++", "conan"],
  clojure: ["clojure", "edn", "clj", "leiningen"],
  github: ["github", "actions"],
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
  oci: ["docker", "oci", "container", "podman"],
  cocoa: ["cocoa", "cocoapods", "objective-c", "swift", "ios"],
  scala: ["scala", "scala3", "sbt", "mill"],
  nix: ["nix", "nixos", "flake"],
};

// Package manager aliases
export const PACKAGE_MANAGER_ALIASES = {
  scala: ["sbt"],
};

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
    process.env[feature.toUpperCase()] &&
    ["true", "1"].includes(process.env[feature.toUpperCase()])
  ) {
    return true;
  }
  // Retry by replacing hyphens with underscore
  return !!(
    process.env[feature.replaceAll("-", "_").toUpperCase()] &&
    ["true", "1"].includes(
      process.env[feature.replaceAll("-", "_").toUpperCase()],
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
  // Support for arbitrary versioned ruby type
  if (
    options.projectType?.length &&
    projectTypes.filter((p) => p.startsWith("ruby")).length
  ) {
    baseProjectTypes.push("ruby");
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

// HTTP cache
const gotHttpCache = new Keyv();
// Don't complain when there's lots of parallel requests
gotHttpCache.setMaxListeners(10000);

function isCacheDisabled() {
  return (
    process.env.CDXGEN_NO_CACHE &&
    ["true", "1"].includes(process.env.CDXGEN_NO_CACHE)
  );
}

const cache = isCacheDisabled() ? undefined : gotHttpCache;
export const remoteHostsAccessed = new Set();

function isAllowedHost(hostname) {
  if (!process.env.CDXGEN_ALLOWED_HOSTS) {
    return true;
  }
  const allow_hosts = (process.env.CDXGEN_ALLOWED_HOSTS || "").split(",");
  for (const ahost of allow_hosts) {
    if (!ahost.length) {
      continue;
    }
    if (hostname === ahost) {
      return true;
    }
    // wildcard support
    if (ahost.startsWith("*.") && hostname.endsWith(ahost.replace("*", ""))) {
      return true;
    }
  }
}

// Custom user-agent for cdxgen
export const cdxgenAgent = got.extend({
  headers: {
    "user-agent": `@CycloneDX/cdxgen ${CDXGEN_VERSION}`,
  },
  cache,
  retry: {
    limit: 0,
  },
  followRedirect: !isSecureMode,
  hooks: {
    beforeRequest: [
      (options) => {
        if (!isAllowedHost(options.url.hostname)) {
          console.log(
            `Access to the remote host '${options.url.hostname}' is not permitted.`,
          );
          return new AbortController().abort();
        }
        // Only allow https protocol in secure mode
        if (isSecureMode && options.url.protocol !== "https:") {
          console.log(
            `Access to the remote host '${options.url.hostname}' is not permitted via the '${options.url.protocol}' protocol.`,
          );
          return new AbortController().abort();
        }
        remoteHostsAccessed.add(options.url.hostname);
        traceLog("http", {
          protocol: options.url.protocol,
          pathname: options.url.pathname,
          host: options.url.host,
        });
      },
    ],
  },
});

/**
 * Method to get files matching a pattern
 *
 * @param {string} dirPath Root directory for search
 * @param {string} pattern Glob pattern (eg: *.gradle)
 * @param {Object} options CLI options
 *
 * @returns {Array[string]} List of matched files
 */
export function getAllFiles(dirPath, pattern, options = {}) {
  let ignoreList = [
    "**/.hg/**",
    "**/.git/**",
    "**/venv/**",
    "**/examples/**",
    "**/site-packages/**",
    "**/flow-typed/**",
    "**/coverage/**",
  ];
  // Only ignore node_modules if the caller is not looking for package.json
  if (!pattern.includes("package.json") && !options.includeNodeModulesDir) {
    ignoreList.push("**/node_modules/**");
  } else if (options.includeNodeModulesDir === false) {
    ignoreList.push("**/node_modules/**");
  }
  // ignore docs only for non-lock file lookups
  if (
    !pattern.includes("package.json") &&
    !pattern.includes("package-lock.json") &&
    !pattern.includes("yarn.lock") &&
    !pattern.includes("pnpm-lock.yaml")
  ) {
    ignoreList.push("**/docs/**");
  }
  if (options?.exclude && Array.isArray(options.exclude)) {
    ignoreList = ignoreList.concat(options.exclude);
  }
  const includeDot = pattern.startsWith(".") || options.includeNodeModulesDir;
  const defaultHits = getAllFilesWithIgnore(
    dirPath,
    pattern,
    includeDot,
    ignoreList,
  );
  // Support for specifying the pattern via options
  if (options?.include?.length) {
    const includeOnlyHits = getAllFilesWithIgnore(
      dirPath,
      options.include,
      includeDot,
      ignoreList,
    );
    if (!includeOnlyHits.length) {
      return [];
    }
    return defaultHits.filter((f) => includeOnlyHits.includes(f));
  }
  return defaultHits;
}

/**
 * Method to get files matching a pattern
 *
 * @param {string} dirPath Root directory for search
 * @param {string} pattern Glob pattern (eg: *.gradle)
 * @param {Boolean} includeDot whether hidden files can be included.
 * @param {Array} ignoreList Directory patterns to ignore
 *
 * @returns {Array[string]} List of matched files
 */
export function getAllFilesWithIgnore(
  dirPath,
  pattern,
  includeDot,
  ignoreList,
) {
  try {
    const files = globSync(pattern, {
      cwd: dirPath,
      absolute: true,
      nocase: true,
      nodir: true,
      dot: includeDot,
      follow: false,
      ignore: ignoreList,
    });
    if (files.length > 1) {
      thoughtLog(
        `Found ${files.length} files for the pattern '${pattern}' at '${dirPath}'.`,
      );
    }
    return files;
  } catch (err) {
    if (DEBUG_MODE) {
      console.error(err);
    }
    return [];
  }
}

/**
 * Method to encode hex string to base64 string
 *
 * @param {string} hexString hex string
 * @returns {string} base64 encoded string
 */
function toBase64(hexString) {
  return Buffer.from(hexString, "hex").toString("base64");
}

/**
 * Return the current timestamp in YYYY-MM-DDTHH:MM:SSZ format.
 *
 * @returns {string} ISO formatted timestamp, without milliseconds.
 */
export function getTimestamp() {
  return `${new Date().toISOString().split(".")[0]}Z`;
}

export function getTmpDir() {
  if (
    process.env.CDXGEN_TEMP_DIR &&
    !safeExistsSync(process.env.CDXGEN_TEMP_DIR)
  ) {
    safeMkdirSync(process.env.CDXGEN_TEMP_DIR, { recursive: true });
  }
  return process.env.CDXGEN_TEMP_DIR || tmpdir();
}

/**
 * Method to determine if a license is a valid SPDX license expression
 *
 * @param {string} license License string
 * @returns {boolean} true if the license is a valid SPDX license expression
 * @see https://spdx.dev/learn/handling-license-info/
 **/
export function isSpdxLicenseExpression(license) {
  if (!license) {
    return false;
  }
  if (/[(\s]+/g.test(license)) {
    return true;
  }
  return !!license.endsWith("+");
}

/**
 * Convert the array of licenses to a CycloneDX 1.5 compliant license array.
 * This should return an array containing:
 * - one or more SPDX license if no expression is present
 * - the license of the expression if one expression is present
 * - a unified conditional 'OR' license expression if more than one expression is present
 *
 * @param {Array} licenses Array of licenses
 * @returns {Array} CycloneDX 1.5 compliant license array
 */
export function adjustLicenseInformation(licenses) {
  if (!licenses || !Array.isArray(licenses)) {
    return [];
  }

  const expressions = licenses.filter((f) => {
    return f.expression;
  });
  if (expressions.length >= 1) {
    if (expressions.length > 1) {
      return [
        {
          expression: expressions
            .map((e) => e.expression || "")
            .filter(Boolean)
            .join(" OR "),
        },
      ];
    }
    return [{ expression: expressions[0].expression }];
  }
  return licenses.map((l) => {
    if (typeof l.license === "object") {
      return l;
    }
    return { license: l };
  });
}

/**
 * Performs a lookup + validation of the license specified in the
 * package. If the license is a valid SPDX license ID, set the 'id'
 * and url of the license object, otherwise, set the 'name' of the license
 * object.
 */
export function getLicenses(pkg) {
  let license = pkg.license && (pkg.license.type || pkg.license);
  if (license) {
    if (!Array.isArray(license)) {
      license = [license];
    }
    return adjustLicenseInformation(
      license
        .filter((l) => l !== undefined)
        .map((l) => {
          let licenseContent = {};
          if (typeof l === "string" || l instanceof String) {
            if (
              spdxLicenses.some((v) => {
                return l === v;
              })
            ) {
              licenseContent.id = l;
              licenseContent.url = `https://opensource.org/licenses/${l}`;
            } else if (l.startsWith("http")) {
              const knownLicense = getKnownLicense(l, pkg);
              if (knownLicense) {
                licenseContent.id = knownLicense.id;
                licenseContent.name = knownLicense.name;
              }
              // We always need a name to avoid validation errors
              // Issue: #469
              if (!licenseContent.name && !licenseContent.id) {
                licenseContent.name = "CUSTOM";
              }
              licenseContent.url = l;
            } else if (isSpdxLicenseExpression(l)) {
              licenseContent.expression = l;
            } else {
              licenseContent.name = l;
            }
          } else if (Object.keys(l).length) {
            licenseContent = l;
          } else {
            return undefined;
          }
          if (!licenseContent.id) {
            addLicenseText(pkg, l, licenseContent);
          }
          return licenseContent;
        }),
    );
  }
  const knownLicense = getKnownLicense(undefined, pkg);
  if (knownLicense) {
    return [{ license: knownLicense }];
  }
  return undefined;
}

/**
 * Method to retrieve known license by known-licenses.json
 *
 * @param {String} licenseUrl Repository url
 * @param {String} pkg Bom ref
 * @return {Object} Objetct with SPDX license id or license name
 */
export function getKnownLicense(licenseUrl, pkg) {
  if (licenseUrl?.includes("opensource.org")) {
    const possibleId = licenseUrl
      .toLowerCase()
      .replace("https://", "http://")
      .replace("http://www.opensource.org/licenses/", "");
    for (const spdxLicense of spdxLicenses) {
      if (spdxLicense.toLowerCase() === possibleId) {
        return { id: spdxLicense };
      }
    }
  } else if (licenseUrl?.includes("apache.org")) {
    const possibleId = licenseUrl
      .toLowerCase()
      .replace("https://", "http://")
      .replace("http://www.apache.org/licenses/license-", "apache-")
      .replace(".txt", "");
    for (const spdxLicense of spdxLicenses) {
      if (spdxLicense.toLowerCase() === possibleId) {
        return { id: spdxLicense };
      }
    }
  }
  for (const akLicGroup of knownLicenses) {
    if (
      akLicGroup.packageNamespace === "*" ||
      pkg.purl?.startsWith(akLicGroup.packageNamespace)
    ) {
      for (const akLic of akLicGroup.knownLicenses) {
        if (akLic.group && akLic.name) {
          if (akLic.group === "." && akLic.name === pkg.name) {
            return { id: akLic.license, name: akLic.licenseName };
          }
          if (
            pkg.group?.includes(akLic.group) &&
            (akLic.name === pkg.name || akLic.name === "*")
          ) {
            return { id: akLic.license, name: akLic.licenseName };
          }
        }
        if (
          akLic.urlIncludes &&
          licenseUrl &&
          licenseUrl.includes(akLic.urlIncludes)
        ) {
          return { id: akLic.license, name: akLic.licenseName };
        }
        if (
          akLic.urlEndswith &&
          licenseUrl &&
          licenseUrl.endsWith(akLic.urlEndswith)
        ) {
          return { id: akLic.license, name: akLic.licenseName };
        }
      }
    }
  }
  return undefined;
}

/**
 * Tries to find a file containing the license text based on commonly
 * used naming and content types. If a candidate file is found, add
 * the text to the license text object and stop.
 */
export function addLicenseText(pkg, l, licenseContent) {
  const licenseFilenames = [
    "LICENSE",
    "License",
    "license",
    "LICENCE",
    "Licence",
    "licence",
    "NOTICE",
    "Notice",
    "notice",
  ];
  const licenseContentTypes = {
    "text/plain": "",
    "text/txt": ".txt",
    "text/markdown": ".md",
    "text/xml": ".xml",
  };
  /* Loops over different name combinations starting from the license specified
       naming (e.g., 'LICENSE.Apache-2.0') and proceeding towards more generic names. */
  for (const licenseName of [`.${l}`, ""]) {
    for (const licenseFilename of licenseFilenames) {
      for (const [licenseContentType, fileExtension] of Object.entries(
        licenseContentTypes,
      )) {
        const licenseFilepath = `${pkg.realPath}/${licenseFilename}${licenseName}${fileExtension}`;
        if (safeExistsSync(licenseFilepath)) {
          licenseContent.text = readLicenseText(
            licenseFilepath,
            licenseContentType,
          );
          return;
        }
      }
    }
  }
}

/**
 * Read the file from the given path to the license text object and includes
 * content-type attribute, if not default. Returns the license text object.
 */
export function readLicenseText(licenseFilepath, licenseContentType) {
  const licenseText = readFileSync(licenseFilepath, "utf8");
  if (licenseText) {
    const licenseContentText = { content: licenseText };
    if (licenseContentType !== "text/plain") {
      licenseContentText["contentType"] = licenseContentType;
    }
    return licenseContentText;
  }
  return null;
}

export async function getSwiftPackageMetadata(pkgList) {
  const cdepList = [];
  for (const p of pkgList) {
    if (p.repository?.url) {
      if (p.repository.url.includes("://github.com/")) {
        try {
          p.license = await getRepoLicense(p.repository.url, undefined);
        } catch (_e) {
          console.error("error fetching repo license from", p.repository.url);
        }
      } else {
        if (DEBUG_MODE) {
          console.log(
            p.repository.url,
            "is currently not supported to fetch for licenses",
          );
        }
      }
    } else {
      if (DEBUG_MODE) {
        console.warn("no repository url found for", p.name);
      }
    }
    cdepList.push(p);
  }
  return cdepList;
}

/**
 * Method to retrieve metadata for npm packages by querying npmjs
 *
 * @param {Array} pkgList Package list
 */
export async function getNpmMetadata(pkgList) {
  const NPM_URL = process.env.NPM_URL || "https://registry.npmjs.org/";
  const cdepList = [];
  for (const p of pkgList) {
    try {
      let key = p.name;
      if (p.group && p.group !== "") {
        let group = p.group;
        if (!group.startsWith("@")) {
          group = `@${group}`;
        }
        key = `${group}/${p.name}`;
      }
      let body = {};
      if (metadata_cache[key]) {
        body = metadata_cache[key];
      } else {
        const res = await cdxgenAgent.get(NPM_URL + key, {
          responseType: "json",
        });
        body = res.body;
        metadata_cache[key] = body;
      }
      p.description =
        body.versions?.[p.version]?.description || body.description;
      p.license =
        body.versions?.[p.version]?.license ||
        body.license ||
        (await getRepoLicense(body.repository?.url, undefined));
      if (body.repository?.url) {
        p.repository = { url: body.repository.url };
      }
      if (body.homepage) {
        p.homepage = { url: body.homepage };
      }
      cdepList.push(p);
    } catch (_err) {
      cdepList.push(p);
      if (DEBUG_MODE) {
        console.error(p, "was not found on npm");
      }
    }
  }
  return cdepList;
}

/**
 * Parse nodejs package json file
 *
 * @param {string} pkgJsonFile package.json file
 * @param {boolean} simple Return a simpler representation of the component by skipping extended attributes and license fetch.
 */
export async function parsePkgJson(pkgJsonFile, simple = false) {
  const pkgList = [];
  if (safeExistsSync(pkgJsonFile)) {
    try {
      const pkgData = JSON.parse(readFileSync(pkgJsonFile, "utf8"));
      const pkgIdentifier = parsePackageJsonName(pkgData.name);
      let name = pkgIdentifier.fullName || pkgData.name;
      if (!name && !pkgJsonFile.includes("node_modules")) {
        name = basename(dirname(pkgJsonFile));
      }
      const group = pkgIdentifier.scope || "";
      const purl = new PackageURL(
        "npm",
        group,
        name,
        pkgData.version,
        null,
        null,
      ).toString();
      const author = pkgData.author;
      const authorString =
        author instanceof Object
          ? `${author.name}${author.email ? ` <${author.email}>` : ""}${
              author.url ? ` (${author.url})` : ""
            }`
          : author;
      const apkg = {
        name,
        group,
        version: pkgData.version,
        description: pkgData.description,
        purl: purl,
        "bom-ref": decodeURIComponent(purl),
        author: authorString,
        license: pkgData.license,
      };
      if (pkgData.homepage) {
        apkg.homepage = { url: pkgData.homepage };
      }
      if (pkgData.repository?.url) {
        apkg.repository = { url: pkgData.repository.url };
      }
      if (!simple) {
        apkg.properties = [
          {
            name: "SrcFile",
            value: pkgJsonFile,
          },
        ];
        apkg.evidence = {
          identity: {
            field: "purl",
            confidence: 0.7,
            methods: [
              {
                technique: "manifest-analysis",
                confidence: 0.7,
                value: pkgJsonFile,
              },
            ],
          },
        };
      }
      pkgList.push(apkg);
    } catch (_err) {
      // continue regardless of error
    }
  }
  if (!simple && shouldFetchLicense() && pkgList && pkgList.length) {
    if (DEBUG_MODE) {
      console.log(
        `About to fetch license information for ${pkgList.length} packages in parsePkgJson`,
      );
    }
    return await getNpmMetadata(pkgList);
  }
  return pkgList;
}

/**
 * Parse nodejs package lock file
 *
 * @param {string} pkgLockFile package-lock.json file
 * @param {object} options Command line options
 */
export async function parsePkgLock(pkgLockFile, options = {}) {
  let pkgList = [];
  let dependenciesList = [];
  if (!options) {
    options = {};
  }
  const pkgSpecVersionCache = {};
  if (!safeExistsSync(pkgLockFile)) {
    return {
      pkgList,
      dependenciesList,
    };
  }

  const parseArboristNode = (
    node,
    rootNode,
    parentRef = null,
    visited = new Set(),
    pkgSpecVersionCache = {},
    options = {},
  ) => {
    if (visited.has(node)) {
      return { pkgList: [], dependenciesList: [] };
    }
    visited.add(node);
    let pkgList = [];
    let dependenciesList = [];

    // Create the package entry
    const srcFilePath = node.path.includes(`${_sep}node_modules`)
      ? node.path.split(`${_sep}node_modules`)[0]
      : node.path;
    const scope = node.dev === true ? "optional" : undefined;
    const integrity = node.integrity ? node.integrity : undefined;

    let pkg;
    let purlString;
    const author = node.package.author;
    const authorString =
      author instanceof Object
        ? `${author.name}${author.email ? ` <${author.email}>` : ""}${
            author.url ? ` (${author.url})` : ""
          }`
        : author;
    if (node === rootNode) {
      const projectGroup = options.projectGroup;
      const projectName =
        "project-name" in options ? options.projectName : node.packageName;
      const projectVersion = options.projectVersion || node.version;
      purlString = PackageURL.fromString(
        `pkg:npm/${projectGroup ? `${encodeURIComponent(projectGroup).replace(/%2F/g, "/")}/` : ""}${encodeURIComponent(projectName).replace(/%2F/g, "/")}@${projectVersion}`,
      )
        .toString()
        .replace(/%2F/g, "/");
      pkg = {
        author: authorString,
        group: options.projectGroup || "",
        name:
          "project-name" in options ? options.projectName : node.packageName,
        version: options.projectVersion || node.version,
        type: "application",
        purl: purlString,
        "bom-ref": decodeURIComponent(purlString),
      };
    } else {
      purlString = PackageURL.fromString(
        `pkg:npm/${encodeURIComponent(node.packageName).replace(/%2F/g, "/")}@${node.version}`,
      )
        .toString()
        .replace(/%2F/g, "/");
      const pkgLockFile = join(
        srcFilePath.replace("/", _sep),
        "package-lock.json",
      );
      pkg = {
        group: "",
        name: node.packageName,
        version: node.version,
        author: authorString,
        scope: scope,
        _integrity: integrity,
        externalReferences: [],
        properties: [
          {
            name: "SrcFile",
            value: pkgLockFile,
          },
        ],
        evidence: {
          identity: {
            field: "purl",
            confidence: 1,
            methods: [
              {
                technique: "manifest-analysis",
                confidence: 1,
                value: pkgLockFile,
              },
            ],
          },
        },
        type: parentRef ? "npm" : "application",
        purl: purlString,
        "bom-ref": decodeURIComponent(purlString),
      };
      if (node.resolved) {
        if (node.resolved.startsWith("file:")) {
          pkg.properties.push({
            name: "cdx:npm:resolvedPath",
            value: node.realpath
              ? relative(dirname(pkgLockFile), node.realpath)
              : relative(
                  dirname(pkgLockFile),
                  resolve(node.resolved.replace("file:", "")),
                ),
          });
        } else {
          pkg.properties.push({
            name: "ResolvedUrl",
            value: node.resolved,
          });
          pkg.distribution = { url: node.resolved };
        }
      }
      if (node.location) {
        pkg.properties.push({
          name: "LocalNodeModulesPath",
          value: node.location,
        });
      }
      if (node?.installLinks) {
        pkg.properties.push({
          name: "cdx:npm:installLinks",
          value: "true",
        });
      }
      if (node?.binPaths?.length) {
        pkg.properties.push({
          name: "cdx:npm:binPaths",
          value: node.binPaths.join(", "),
        });
      }
      if (node?.hasInstallScript) {
        pkg.properties.push({
          name: "cdx:npm:hasInstallScript",
          value: "true",
        });
      }
      if (node?.isLink) {
        pkg.properties.push({
          name: "cdx:npm:isLink",
          value: "true",
        });
      }
      // This getter method could fail with errors at times.
      // Example Error: Invalid tag name "^>=6.0.0" of package "^>=6.0.0": Tags may not have any characters that encodeURIComponent encodes.
      try {
        if (!node?.isRegistryDependency) {
          pkg.properties.push({
            name: "cdx:npm:isRegistryDependency",
            value: "false",
          });
        }
      } catch (_err) {
        // ignore
      }
      if (node?.isWorkspace) {
        pkg.properties.push({
          name: "cdx:npm:isWorkspace",
          value: "true",
        });
      }
      if (node?.inBundle) {
        pkg.properties.push({
          name: "cdx:npm:inBundle",
          value: "true",
        });
      }
      if (node?.inDepBundle) {
        pkg.properties.push({
          name: "cdx:npm:inDepBundle",
          value: "true",
        });
      }
      if (node.package?.repository?.url) {
        pkg.externalReferences.push({
          type: "vcs",
          url: node.package.repository.url,
        });
      }
      if (node.package?.bugs?.url) {
        pkg.externalReferences.push({
          type: "issue-tracker",
          url: node.package.bugs.url,
        });
      }
      if (node?.package?.keywords?.length) {
        pkg.tags = Array.isArray(node.package.keywords)
          ? node.package.keywords.sort()
          : node.package.keywords.split(",");
      }
    }
    if (node.package?.license) {
      // License will be overridden if shouldFetchLicense() is enabled
      pkg.license = node.package.license;
    }
    const deprecatedMessage = node.package?.deprecated;
    if (deprecatedMessage) {
      pkg.properties.push({
        name: "cdx:npm:deprecated",
        value: deprecatedMessage,
      });
    }
    pkgList.push(pkg);
    // retrieve workspace node pkglists
    const workspaceDependsOn = [];
    if (node.fsChildren && node.fsChildren.size > 0) {
      for (const workspaceNode of node.fsChildren) {
        const {
          pkgList: childPkgList,
          dependenciesList: childDependenciesList,
        } = parseArboristNode(
          workspaceNode,
          rootNode,
          purlString,
          visited,
          pkgSpecVersionCache,
          options,
        );
        pkgList = pkgList.concat(childPkgList);
        dependenciesList = dependenciesList.concat(childDependenciesList);
        let depWorkspacePurlString = decodeURIComponent(
          new PackageURL(
            "npm",
            "",
            workspaceNode.name,
            workspaceNode.version,
            null,
            null,
          )
            .toString()
            .replace(/%2F/g, "/"),
        );
        let purlStringFromPkgid;
        if (workspaceNode.pkgid) {
          purlStringFromPkgid = `pkg:npm/${workspaceNode.pkgid.replace(`${workspaceNode.name}@npm:`, "")}`;
        }
        if (
          purlStringFromPkgid &&
          purlStringFromPkgid !== depWorkspacePurlString
        ) {
          if (DEBUG_MODE) {
            console.log(
              `Internal warning: Got two different refs for this workspace node: ${depWorkspacePurlString} and ${purlStringFromPkgid}. Assuming the bom-ref as ${purlStringFromPkgid} based on pkgid.`,
            );
          }
          depWorkspacePurlString = purlStringFromPkgid;
        }
        if (decodeURIComponent(purlString) !== depWorkspacePurlString) {
          workspaceDependsOn.push(depWorkspacePurlString);
        }
      }
    }

    // this handles the case when a node has ["dependencies"] key in a package-lock.json
    // for a node. We exclude the root node because it's already been handled
    // If the node has "requires", we don't have to track the "dependencies"
    const childrenDependsOn = [];
    if (node !== rootNode && !node.edgesOut.size) {
      for (const child of node.children) {
        const childNode = child[1];
        const {
          pkgList: childPkgList,
          dependenciesList: childDependenciesList,
        } = parseArboristNode(
          childNode,
          rootNode,
          decodeURIComponent(purlString),
          visited,
          pkgSpecVersionCache,
          options,
        );
        pkgList = pkgList.concat(childPkgList);
        dependenciesList = dependenciesList.concat(childDependenciesList);
        const depChildString = decodeURIComponent(
          new PackageURL(
            "npm",
            "",
            childNode.name,
            childNode.version,
            null,
            null,
          )
            .toString()
            .replace(/%2F/g, "/"),
        );
        if (decodeURIComponent(purlString) !== depChildString) {
          childrenDependsOn.push(depChildString);
        }
      }
    }

    // this handles the case when a node has a ["requires"] key
    const pkgDependsOn = [];
    for (const edge of node.edgesOut.values()) {
      let targetVersion;
      let targetName;
      let foundMatch = false;
      // This cache is required to help us down the line.
      if (edge?.to?.version && edge?.spec) {
        pkgSpecVersionCache[`${edge.name}-${edge.spec}`] = edge.to.version;
      }
      // if the edge doesn't have an integrity, it's likely a peer dependency
      // which isn't installed
      // Bug #795. At times, npm loses the integrity node completely and such packages are getting missed out
      // To keep things safe, we include these packages.
      let edgeToIntegrityOrLocation = edge.to ? edge.to.integrity : undefined;
      // Fallback to location based lookups when integrity is missing
      if (!edgeToIntegrityOrLocation && edge.to && edge.to.location) {
        edgeToIntegrityOrLocation = edge.to.location;
      }
      if (!edgeToIntegrityOrLocation) {
        // This hack is required to fix the package name
        targetName = edge.name.replace(/-cjs$/, "");
        foundMatch = false;
      } else {
        // the edges don't actually contain a version, so we need to search the root node
        // children to find the correct version. we check the node children first, then
        // we check the root node children
        for (const child of node.children) {
          if (edgeToIntegrityOrLocation) {
            if (
              child[1].integrity === edgeToIntegrityOrLocation ||
              child[1].location === edgeToIntegrityOrLocation
            ) {
              targetName = child[0].replace(/node_modules\//g, "");
              // The package name could be different from the targetName retrieved
              // Eg: "string-width-cjs": "npm:string-width@^4.2.0",
              if (child[1].packageName && child[1].packageName !== targetName) {
                targetName = child[1].packageName;
              }
              targetVersion = child[1].version;
              foundMatch = true;
              break;
            }
          }
        }
      }
      if (!foundMatch) {
        for (const child of rootNode.children) {
          if (
            edgeToIntegrityOrLocation &&
            (child[1].integrity === edgeToIntegrityOrLocation ||
              child[1].location === edgeToIntegrityOrLocation)
          ) {
            targetName = child[0].replace(/node_modules\//g, "");
            targetVersion = child[1].version;
            // The package name could be different from the targetName retrieved
            // "string-width-cjs": "npm:string-width@^4.2.0",
            if (child[1].packageName && child[1].packageName !== targetName) {
              targetName = child[1].packageName;
            }
            break;
          }
        }
        if (!targetVersion || !targetName) {
          if (pkgSpecVersionCache[`${edge.name}-${edge.spec}`]) {
            targetVersion = pkgSpecVersionCache[`${edge.name}-${edge.spec}`];
            targetName = edge.name;
          }
        }
      }

      // if we can't find the version of the edge, continue
      // it may be an optional peer dependency
      if (!targetVersion || !targetName) {
        if (
          DEBUG_MODE &&
          !options.deep &&
          !["optional", "peer", "peerOptional"].includes(edge?.type)
        ) {
          if (!targetVersion) {
            console.log(
              `Unable to determine the version for the dependency ${edge.name} from the path ${edge?.from?.path}. This is likely an edge case that is not handled.`,
              edge,
            );
          } else if (!targetName) {
            console.log(
              `Unable to determine the name for the dependency from the edge from the path ${edge?.from?.path}. This is likely an edge case that is not handled.`,
              edge,
            );
          }
        }
        // juice-shop
        // Lock files created with --legacy-peer-deps will have certain peer dependencies missing
        // This flags any non-missing peers
        if (DEBUG_MODE && edge?.type === "peer" && edge?.error !== "MISSING") {
          console.log(
            `Unable to determine the version for the dependency ${edge.name} from the path ${edge?.from?.path}. This is likely an edge case that is not handled.`,
            edge,
          );
        }
        continue;
      }
      const depPurlString = decodeURIComponent(
        PackageURL.fromString(
          `pkg:npm/${encodeURIComponent(targetName).replace(/%2F/g, "/")}@${targetVersion}`,
        )
          .toString()
          .replace(/%2F/g, "/"),
      );
      if (decodeURIComponent(purlString) !== depPurlString) {
        pkgDependsOn.push(depPurlString);
      }
      if (edge.to == null) {
        continue;
      }
      const { pkgList: childPkgList, dependenciesList: childDependenciesList } =
        parseArboristNode(
          edge.to,
          rootNode,
          decodeURIComponent(purlString),
          visited,
          pkgSpecVersionCache,
          options,
        );
      pkgList = pkgList.concat(childPkgList);
      dependenciesList = dependenciesList.concat(childDependenciesList);
    }
    dependenciesList.push({
      ref: decodeURIComponent(purlString),
      dependsOn: [
        ...new Set(
          workspaceDependsOn.concat(childrenDependsOn).concat(pkgDependsOn),
        ),
      ].sort(),
    });

    return { pkgList, dependenciesList };
  };

  let arb = new Arborist({
    path: path.dirname(pkgLockFile),
    // legacyPeerDeps=false enables npm >v3 package dependency resolution
    legacyPeerDeps: false,
  });
  let tree;
  try {
    const rootNodeModulesDir = join(path.dirname(pkgLockFile), "node_modules");
    if (safeExistsSync(rootNodeModulesDir)) {
      if (options.deep) {
        console.log(
          `Constructing the actual dependency hierarchy from ${rootNodeModulesDir}.`,
        );
        tree = await arb.loadActual();
      } else {
        if (DEBUG_MODE) {
          console.log(
            "Constructing virtual dependency tree based on the lock file. Pass --deep argument to construct the actual dependency tree from disk.",
          );
        }
        tree = await arb.loadVirtual();
      }
    } else {
      tree = await arb.loadVirtual();
    }
  } catch (e) {
    console.log(e);
    console.log(
      `Unable to parse ${pkgLockFile} without legacy peer dependencies. Retrying ...`,
    );
    if (DEBUG_MODE) {
      console.log(e);
    }
    try {
      arb = new Arborist({
        path: path.dirname(pkgLockFile),
        legacyPeerDeps: true,
      });
      tree = await arb.loadVirtual();
    } catch (e) {
      console.log(e);
      console.log(
        `Unable to parse ${pkgLockFile} in legacy and non-legacy mode. The resulting SBOM would be incomplete.`,
      );
      if (DEBUG_MODE) {
        console.log(e);
      }
      return { pkgList, dependenciesList };
    }
  }
  if (!tree) {
    return { pkgList, dependenciesList };
  }
  ({ pkgList, dependenciesList } = parseArboristNode(
    tree,
    tree,
    null,
    new Set(),
    pkgSpecVersionCache,
    options,
  ));

  if (shouldFetchLicense() && pkgList && pkgList.length) {
    if (DEBUG_MODE) {
      console.log(
        `About to fetch license information for ${pkgList.length} packages in parsePkgLock`,
      );
    }
    pkgList = await getNpmMetadata(pkgList);
    return { pkgList, dependenciesList };
  }
  return {
    pkgList,
    dependenciesList,
  };
}

/**
 * Given a lock file this method would return an Object with the identity as the key and parsed name and value
 * eg: "@actions/core@^1.2.6", "@actions/core@^1.6.0":
 *        version "1.6.0"
 * would result in two entries
 *
 * @param {string} lockData Yarn Lockfile data
 */
export function yarnLockToIdentMap(lockData) {
  const identMap = {};
  let currentIdents = [];
  lockData.split("\n").forEach((l) => {
    l = l.replace("\r", "");
    if (l === "\n" || !l.length || l.startsWith("#")) {
      return;
    }
    // "@actions/core@^1.2.6", "@actions/core@^1.6.0":
    if (!l.startsWith(" ") && l.trim().length > 0) {
      const tmpA = l.replace(/["']/g, "").split(", ");
      if (tmpA?.length) {
        for (let s of tmpA) {
          if (!s.startsWith("__")) {
            if (s.endsWith(":")) {
              s = s.substring(0, s.length - 1);
            }
            // Non-strict mode parsing
            const match = s.match(/^(?:(@[^/]+?)\/)?([^/]+?)(?:@(.+))?$/);
            if (!match) {
              continue;
            }
            let [, group, name, range] = match;
            if (group) {
              group = `${group}/`;
            }
            // "lru-cache@npm:^6.0.0":
            // "string-width-cjs@npm:string-width@^4.2.0":
            // Here range can be
            // - npm:^6.0.0
            // - npm:@types/ioredis@^4.28.10
            // - npm:strip-ansi@^6.0.1
            // See test cases with yarn3.lock and yarn6.lock
            if (range?.startsWith("npm:")) {
              if (range.includes("@")) {
                range = range.split("@").slice(-1)[0];
              } else {
                range = range.replace("npm:", "");
              }
              if (
                !l.includes(" ") &&
                l.includes("@npm:") &&
                l.match(/@/g).length === 2
              ) {
                const newName = l
                  .split("@npm:")
                  .pop()
                  .replace(`@${range}`, "")
                  .replace(/[:"']/g, "");
                if (
                  !newName.startsWith("*") &&
                  !newName.includes(range) &&
                  newName.length > name.length
                ) {
                  name = newName;
                }
              }
            }
            currentIdents.push(`${group || ""}${name}|${range}`);
          }
        }
      }
    } else if (
      (l.startsWith("  version") || l.startsWith('  "version')) &&
      currentIdents.length
    ) {
      const tmpA = l.replace(/"/g, "").split(" ");
      const version = tmpA[tmpA.length - 1].trim();
      for (const id of currentIdents) {
        identMap[id] = version;
      }
      currentIdents = [];
    }
  });
  return identMap;
}

function _parseYarnLine(l) {
  let name = "";
  let group = "";
  let prefixAtSymbol = l.startsWith("@");
  const tmpA = l.split("@");
  // ignore possible leading empty strings
  if (tmpA[0] === "") {
    tmpA.shift();
  }
  let fullName;
  if (tmpA.length >= 2) {
    if (tmpA.length === 4) {
      if (tmpA[1] === "npm:") {
        prefixAtSymbol = true;
      }
      fullName = tmpA[2];
    } else {
      fullName = tmpA[0];
    }
    if (fullName.indexOf("/") > -1) {
      const parts = fullName.split("/");
      group = (prefixAtSymbol ? "@" : "") + parts[0];
      name = parts[1];
    } else {
      name = fullName;
    }
  }
  return { group, name };
}

/**
 * Parse nodejs yarn lock file
 *
 * @param {string} yarnLockFile yarn.lock file
 * @param {Object} parentComponent parent component
 * @param {Array[String]} workspacePackages Workspace packages
 * @param {Object} workspaceSrcFiles Workspace package.json files
 * @param {Object} _workspaceDirectDeps Direct dependencies of each workspace
 * @param {Object} depsWorkspaceRefs Workspace references for each dependency
 */
export async function parseYarnLock(
  yarnLockFile,
  parentComponent = null,
  workspacePackages = [],
  workspaceSrcFiles = {},
  _workspaceDirectDeps = {},
  depsWorkspaceRefs = {},
) {
  let pkgList = [];
  const dependenciesList = [];
  const depKeys = {};
  if (safeExistsSync(yarnLockFile)) {
    const lockData = readFileSync(yarnLockFile, "utf8");
    let name = "";
    let name_aliases = [];
    let group = "";
    let version = "";
    let integrity = "";
    let depsMode = false;
    let optionalDepsMode = false;
    let purlString = "";
    let deplist = new Set();
    const pkgAddedMap = {};
    // Map to track workspace package PURL replacements from 0.0.0-use.local to actual versions
    const workspacePurlMap = {};
    // This would have the keys and the resolved version required to solve the dependency tree
    const identMap = yarnLockToIdentMap(lockData);
    lockData.split("\n").forEach((l) => {
      l = l.replace("\r", "");
      if (l.startsWith("#")) {
        return;
      }
      if (!l.startsWith(" ") || l.trim() === "") {
        // Create an entry for the package and reset variables
        if (
          name !== "" &&
          version !== "" &&
          (integrity !== "" ||
            version.includes("local") ||
            (integrity === "" && (depsMode || l.trim() === "")))
        ) {
          name_aliases.push({ group, name });
          // FIXME: What should we do about the dependencies for such aliases
          for (const ang of name_aliases) {
            group = ang.group;
            name = ang.name;
            // Create a purl ref for the current package
            purlString = new PackageURL(
              "npm",
              group,
              name,
              version,
              null,
              null,
            ).toString();
            // Skip workspace packages with placeholder version "0.0.0-use.local"
            // These are yarn's internal placeholders for local workspace packages
            // The actual workspace packages are already added with their real versions
            const isPlaceholderVersion = version === "0.0.0-use.local";
            if (isPlaceholderVersion) {
              // Try to find matching workspace package by creating the expected PURL format
              const expectedPurlStart = `pkg:npm/${group ? `${group}/${name}` : name}@`;
              const actualWorkspacePurl = workspacePackages.find(
                (wp) =>
                  wp.startsWith(expectedPurlStart) ||
                  wp.includes(
                    `pkg:npm/${encodeForPurl(group ? `${group}/${name}` : name)}@`,
                  ),
              );
              // Also check if this package already exists in pkgList with a real version
              const existingPkg = pkgList.find(
                (pkg) =>
                  pkg.group === (group || "") &&
                  pkg.name === name &&
                  pkg.version !== "0.0.0-use.local",
              );
              // Check if this is a root workspace package by looking at parentComponent
              const isRootWorkspacePackage =
                parentComponent &&
                parentComponent.name === name &&
                parentComponent.group === (group || "");
              if (
                actualWorkspacePurl ||
                existingPkg ||
                isRootWorkspacePackage
              ) {
                if (actualWorkspacePurl) {
                  // Store mapping from placeholder PURL to actual workspace PURL (both URL-decoded for bom-ref)
                  workspacePurlMap[decodeURIComponent(purlString)] =
                    decodeURIComponent(actualWorkspacePurl);
                } else if (existingPkg) {
                  // Store mapping to existing package's PURL
                  workspacePurlMap[decodeURIComponent(purlString)] =
                    existingPkg["bom-ref"];
                } else if (isRootWorkspacePackage) {
                  // Store mapping to parent component's PURL
                  workspacePurlMap[decodeURIComponent(purlString)] =
                    parentComponent["bom-ref"];
                }
                continue;
              }
            }
            // Trim duplicates
            if (!pkgAddedMap[purlString]) {
              pkgAddedMap[purlString] = true;
              const properties = [
                {
                  name: "SrcFile",
                  value: yarnLockFile,
                },
              ];
              pkgList.push({
                group: group || "",
                name: name,
                version: version,
                _integrity: integrity,
                purl: purlString,
                "bom-ref": decodeURIComponent(purlString),
                properties,
                evidence: {
                  identity: {
                    field: "purl",
                    confidence: 1,
                    methods: [
                      {
                        technique: "manifest-analysis",
                        confidence: 1,
                        value: yarnLockFile,
                      },
                    ],
                  },
                },
              });
            }
          }
          // Reset all the variables
          group = "";
          name = "";
          name_aliases = [];
          version = "";
          integrity = "";
        }
        if (purlString && purlString !== "" && !depKeys[purlString]) {
          // Map workspace placeholder PURLs to actual workspace PURLs
          const resolvedRef =
            workspacePurlMap[decodeURIComponent(purlString)] ||
            decodeURIComponent(purlString);
          const resolvedDependsOn = [...deplist]
            .map((dep) => workspacePurlMap[dep] || dep)
            .sort();
          // Create an entry for dependencies
          dependenciesList.push({
            ref: resolvedRef,
            dependsOn: resolvedDependsOn,
          });
          depKeys[purlString] = true;
          deplist = new Set();
          purlString = "";
          depsMode = false;
          optionalDepsMode = false;
        }
        // Collect the group and the name
        l = l.replace(/["']/g, "");
        // Deals with lines including aliases
        // Eg: string-width-cjs@npm:string-width@^4.2.0, string-width@npm:^1.0.2 || 2 || 3 || 4, string-width@npm:^4.1.0, string-width@npm:^4.2.0, string-width@npm:^4.2.3
        const fragments = l.split(", ");
        for (let i = 0; i < fragments.length; i++) {
          const parsedline = _parseYarnLine(fragments[i]);
          if (i === 0) {
            group = parsedline.group;
            name = parsedline.name;
          } else {
            let fullName = parsedline.name;
            if (parsedline.group?.length) {
              fullName = `${parsedline.group}/${parsedline.name}`;
            }
            if (
              fullName !== name &&
              fullName !== `${group}/${name}` &&
              !name_aliases.includes(fullName)
            ) {
              name_aliases.push({
                group: parsedline.group,
                name: parsedline.name,
              });
            }
          }
        }
      } else if (
        name !== "" &&
        (l.startsWith("  dependencies:") ||
          l.startsWith('  "dependencies:') ||
          l.startsWith("  optionalDependencies:") ||
          l.startsWith('  "optionalDependencies:'))
      ) {
        if (
          l.startsWith("  dependencies:") ||
          l.startsWith('  "dependencies:')
        ) {
          depsMode = true;
          optionalDepsMode = false;
        } else {
          depsMode = false;
          optionalDepsMode = true;
        }
      } else if ((depsMode || optionalDepsMode) && l.startsWith("    ")) {
        // Given "@actions/http-client" "^1.0.11"
        // We need the resolved version from identMap
        // Deal with values with space within the quotes. Eg: minimatch "2 || 3"
        // vinyl-sourcemaps-apply ">=0.1.1 <0.2.0-0"
        l = l.trim();
        let splitPattern = ' "';
        // yarn v7 has a different split pattern
        if (l.includes('": ')) {
          splitPattern = '": ';
        } else if (l.includes(": ")) {
          splitPattern = ": ";
        }
        const tmpA = l.trim().split(splitPattern);
        if (tmpA && tmpA.length === 2) {
          let dgroupname = tmpA[0].replace(/"/g, "");
          if (dgroupname.endsWith(":")) {
            dgroupname = dgroupname.substring(0, dgroupname.length - 1);
          }
          let dgroupnameToUse = dgroupname;
          const range = tmpA[1].replace(/["']/g, "");
          let versionRange = range;
          // Deal with range with npm: prefix such as npm:string-width@^4.2.0, npm:@types/ioredis@^4.28.10
          if (range.startsWith("npm:")) {
            if (range.includes("@")) {
              // Case like npm:string-width@^4.2.0 or npm:@types/ioredis@^4.28.10
              versionRange = range.split("@").splice(-1)[0];
              dgroupnameToUse = range
                .replace("npm:", "")
                .replace(`@${versionRange}`, "");
            } else {
              // Case like npm:^5.1.1 - just a version range with npm: prefix
              versionRange = range.replace("npm:", "");
              dgroupnameToUse = dgroupname;
            }
          }
          let resolvedVersion =
            identMap[`${dgroupname}|${versionRange}`] ||
            identMap[`${dgroupnameToUse}|${versionRange}`];
          // If we couldn't resolve the version directly, try to find any resolved version for this package
          if (!resolvedVersion) {
            const packageKeys = Object.keys(identMap).filter((key) => {
              const [pkg] = key.split("|");
              return pkg === dgroupname || pkg === dgroupnameToUse;
            });

            if (packageKeys.length > 0) {
              // Use the first available resolved version for this package
              resolvedVersion = identMap[packageKeys[0]];
            }
          }
          // If we couldn't resolve the version from yarn.lock, check if it's a workspace package
          if (!resolvedVersion && workspacePackages?.length) {
            // Use helper function for more efficient workspace matching
            const matchingWorkspace = findMatchingWorkspace(
              workspacePackages,
              dgroupnameToUse,
            );

            if (matchingWorkspace) {
              // Extract version from workspace PURL like "npm:@swc/helpers@0.4.14"
              const versionMatch = matchingWorkspace.match(/@([^@]+)$/);
              if (versionMatch) {
                resolvedVersion = versionMatch[1];
              }
            }
          }
          // If we still can't resolve the version, use "" as fallback
          if (!resolvedVersion) {
            resolvedVersion = "";
          }
          // Handle case where the dependency name is really an alias.
          // Eg: legacy-swc-helpers "npm:@swc/helpers@=0.4.14". Here the dgroupname=@swc/helpers
          let purlPart = `pkg:npm/${encodeURIComponent(dgroupnameToUse).replace(/%2F/g, "/")}`;
          if (resolvedVersion?.length) {
            purlPart = `${purlPart}@${resolvedVersion}`;
          }
          const depPurlString = PackageURL.fromString(purlPart).toString();
          deplist.add(decodeURIComponent(depPurlString));
        }
      } else if (name !== "") {
        if (!l.startsWith("    ")) {
          depsMode = false;
          optionalDepsMode = false;
        }
        l = l.replace(/"/g, "").trim();
        const parts = l.split(" ");
        if (l.startsWith("version")) {
          version = parts[1].replace(/"/g, "");
        }
        if (l.startsWith("integrity")) {
          integrity = parts[1];
        }
        // checksum used by yarn 2/3 is hex encoded
        if (l.startsWith("checksum")) {
          // in some cases yarn 4 will add a prefix to the checksum, containing the cachekey and compression level
          // example: 10c0/53c2b231a61a46792b39a0d43bc4f4f77...
          const checksum = parts[1].split("/").pop();
          integrity = `sha512-${Buffer.from(checksum, "hex").toString(
            "base64",
          )}`;
        }
        if (l.startsWith("resolved")) {
          const tmpB = parts[1].split("#");
          if (tmpB.length > 1) {
            const digest = tmpB[1].replace(/"/g, "");
            integrity = `sha256-${digest}`;
          }
        }
      }
    });
  }
  // Add workspace references for yarn workspaces
  if (depsWorkspaceRefs && Object.keys(depsWorkspaceRefs).length) {
    for (const apkg of pkgList) {
      if (!apkg.properties) {
        apkg.properties = [];
      }
      const purlObj = PackageURL.fromString(apkg.purl);
      purlObj.version = undefined;
      const purlNoVersion = decodeURIComponent(purlObj.toString());
      const wsRefs =
        depsWorkspaceRefs[apkg["bom-ref"]] || depsWorkspaceRefs[purlNoVersion];
      // There is a workspace reference
      if (wsRefs?.length) {
        const wsprops = apkg.properties.filter(
          (p) => p.name === "internal:workspaceRef",
        );
        // workspace properties are already set.
        if (wsprops.length) {
          continue;
        }
        for (const wref of wsRefs) {
          // Such a cycle should never happen, but we can't sure
          if (wref === apkg["bom-ref"]) {
            continue;
          }
          apkg.properties.push({
            name: "internal:workspaceRef",
            value: wref,
          });
          const purlObj = PackageURL.fromString(apkg.purl);
          purlObj.version = undefined;
          const wrefNoVersion = decodeURIComponent(purlObj.toString());
          const wsrcFile =
            workspaceSrcFiles[wref] || workspaceSrcFiles[wrefNoVersion];
          if (wsrcFile) {
            apkg.properties.push({
              name: "internal:workspaceSrcFile",
              value: wsrcFile,
            });
          }
        }
      }
    }
  }
  // Create components for workspace packages that are referenced but not yet created
  if (workspacePackages?.length) {
    for (const workspacePkg of workspacePackages) {
      const existingComponent = pkgList.find(
        (pkg) => pkg["bom-ref"] === decodeURIComponent(workspacePkg),
      );
      if (!existingComponent) {
        try {
          if (DEBUG_MODE) {
            console.log(`Processing workspace package: "${workspacePkg}"`);
          }
          let purlObj;
          // For workspace packages that already have versions in the PURL format
          if (
            workspacePkg.includes("@") &&
            workspacePkg.lastIndexOf("@") > workspacePkg.indexOf("/")
          ) {
            // This is a scoped package with version like "npm:@swc/helpers@0.4.14"
            const lastAtIndex = workspacePkg.lastIndexOf("@");
            const purlWithoutVersion = workspacePkg.substring(0, lastAtIndex);
            const version = workspacePkg.substring(lastAtIndex + 1);
            // Parse the PURL without version first, then set the version.
            purlObj = PackageURL.fromString(purlWithoutVersion);
            purlObj.version = version;
          } else {
            // Parse the PURL as-is (no version or simple package)
            purlObj = PackageURL.fromString(workspacePkg);
          }

          // Create the workspace component using the properly parsed PURL
          const workspaceComponent = {
            group: purlObj.namespace || "",
            name: purlObj.name,
            version: purlObj.version,
            purl: purlObj.toString(),
            "bom-ref": decodeURIComponent(purlObj.toString()),
            type: "library",
            scope: "required",
            properties: [
              {
                name: "SrcFile",
                value: workspaceSrcFiles[workspacePkg] || "package.json",
              },
              {
                name: "internal:workspaceRef",
                value: purlObj.toString(),
              },
              {
                name: "cdx:npm:is_workspace",
                value: workspaceSrcFiles[workspacePkg] ? "true" : "false",
              },
            ],
            evidence: {
              identity: {
                field: "purl",
                confidence: 0.7,
                methods: [
                  {
                    technique: "manifest-analysis",
                    confidence: 0.7,
                    value: workspaceSrcFiles[workspacePkg] || "package.json",
                  },
                ],
              },
            },
          };

          if (workspaceSrcFiles[workspacePkg]) {
            workspaceComponent.properties.push({
              name: "internal:workspaceSrcFile",
              value: workspaceSrcFiles[workspacePkg],
            });
          }
          pkgList.push(workspaceComponent);
        } catch (err) {
          if (DEBUG_MODE) {
            console.log(
              `Error parsing workspace package PURL: ${workspacePkg}`,
              err.message,
            );
          }
          // Create a fallback component with minimal information that will trigger warnings
          // Removed property `cdx:invalid-purl` in favour of a lower confidence value.
          const fallbackComponent = {
            group: "",
            name: workspacePkg.includes("/")
              ? workspacePkg.split("/").pop()
              : workspacePkg,
            version: "",
            purl: workspacePkg,
            "bom-ref": decodeURIComponent(workspacePkg),
            type: "library",
            scope: "required",
            properties: [
              {
                name: "SrcFile",
                value: workspaceSrcFiles[workspacePkg] || "package.json",
              },
              {
                name: "internal:workspaceRef",
                value: workspacePkg,
              },
              {
                name: "cdx:npm:is_workspace",
                value: workspaceSrcFiles[workspacePkg] ? "true" : "false",
              },
            ],
            evidence: {
              identity: {
                field: "purl",
                confidence: 0.1,
                methods: [
                  {
                    technique: "manifest-analysis",
                    confidence: 0.1,
                    value: workspaceSrcFiles[workspacePkg] || "package.json",
                  },
                ],
              },
            },
          };
          pkgList.push(fallbackComponent);
          if (DEBUG_MODE) {
            console.log(
              `Created fallback workspace component with invalid PURL: ${workspacePkg}`,
            );
          }
        }
      }
    }
  }

  if (shouldFetchLicense() && pkgList && pkgList.length) {
    if (DEBUG_MODE) {
      console.log(
        `About to fetch license information for ${pkgList.length} packages in parseYarnLock`,
      );
    }
    pkgList = await getNpmMetadata(pkgList);
    return {
      pkgList,
      dependenciesList,
    };
  }
  return {
    pkgList,
    dependenciesList,
  };
}

/**
 * Parse nodejs shrinkwrap deps file
 *
 * @param {string} swFile shrinkwrap-deps.json file
 */
export async function parseNodeShrinkwrap(swFile) {
  const pkgList = [];
  if (safeExistsSync(swFile)) {
    const lockData = JSON.parse(readFileSync(swFile, "utf8"));
    const pkgKeys = Object.keys(lockData);
    for (const k in pkgKeys) {
      const fullName = pkgKeys[k];
      const integrity = lockData[fullName];
      const parts = fullName.split("@");
      if (parts?.length) {
        let name = "";
        let version = "";
        let group = "";
        if (parts.length === 2) {
          name = parts[0];
          version = parts[1];
        } else if (parts.length === 3) {
          if (parts[0] === "") {
            const gnameparts = parts[1].split("/");
            group = gnameparts[0];
            name = gnameparts[1];
          } else {
            name = parts[0];
          }
          version = parts[2];
        }
        pkgList.push({
          group: group,
          name: name,
          version: version,
          _integrity: integrity,
          properties: [
            {
              name: "SrcFile",
              value: swFile,
            },
          ],
          evidence: {
            identity: {
              field: "purl",
              confidence: 1,
              methods: [
                {
                  technique: "manifest-analysis",
                  confidence: 1,
                  value: swFile,
                },
              ],
            },
          },
        });
      }
    }
  }
  if (shouldFetchLicense() && pkgList && pkgList.length) {
    if (DEBUG_MODE) {
      console.log(
        `About to fetch license information for ${pkgList.length} packages in parseNodeShrinkwrap`,
      );
    }
    return await getNpmMetadata(pkgList);
  }
  return pkgList;
}

function _markTreeOptional(
  dbomRef,
  dependenciesMap,
  possibleOptionalDeps,
  visited,
) {
  if (possibleOptionalDeps[dbomRef] === undefined) {
    possibleOptionalDeps[dbomRef] = true;
  }
  if (dependenciesMap[dbomRef] && !visited[dbomRef]) {
    visited[dbomRef] = true;
    for (const eachDep of dependenciesMap[dbomRef]) {
      if (possibleOptionalDeps[eachDep] !== false) {
        _markTreeOptional(
          eachDep,
          dependenciesMap,
          possibleOptionalDeps,
          visited,
        );
      }
      visited[eachDep] = true;
    }
  }
}

function _setTreeWorkspaceRef(
  dependenciesMap,
  depref,
  pkgRefMap,
  wref,
  wsrcFile,
  depsWorkspaceRefs,
) {
  for (const dref of dependenciesMap[depref] || []) {
    const addedMap = {};
    const depPkg = pkgRefMap[dref];
    if (!depPkg) {
      continue;
    }
    const wsprops = depPkg.properties.filter(
      (p) => p.name === "internal:workspaceRef",
    );
    if (wsprops.length) {
      continue;
    }
    depPkg.properties = depPkg.properties || [];
    for (const prop of depPkg.properties) {
      addedMap[prop.value] = true;
    }
    if (!addedMap[wref]) {
      depPkg.properties.push({
        name: "internal:workspaceRef",
        value: wref,
      });
      addedMap[wref] = true;
    }
    if (wsrcFile && !addedMap[wsrcFile]) {
      depPkg.properties.push({
        name: "internal:workspaceSrcFile",
        value: wsrcFile,
      });
      addedMap[wsrcFile] = true;
    }
    depsWorkspaceRefs[dref] = depsWorkspaceRefs[dref] || [];
    depsWorkspaceRefs[dref] = depsWorkspaceRefs[dref].concat(
      dependenciesMap[depref] || [],
    );
    _setTreeWorkspaceRef(
      dependenciesMap,
      dref,
      pkgRefMap,
      wref,
      wsrcFile,
      depsWorkspaceRefs,
    );
  }
}

async function getVersionNumPnpm(depPkg, relativePath) {
  let version = depPkg;
  if (typeof version === "object" && depPkg.version) {
    version = depPkg.version;
  }
  // link:../packages/plugin-highlight-ssr
  if (version.startsWith("link:") || version.startsWith("file:")) {
    version = version.replace("link:", "").replace("file:", "");
    const relativePkgJson = relativePath
      ? join(relativePath, version, "package.json")
      : join(version.replaceAll("../", "packages/"), "package.json");
    if (safeExistsSync(relativePkgJson)) {
      const importedComponentObj = await parsePkgJson(relativePkgJson, true);
      version = importedComponentObj[0].version;
    } else if (safeExistsSync(join(version, "package.json"))) {
      const importedComponentObj = await parsePkgJson(
        join(version, "package.json"),
        true,
      );
      version = importedComponentObj[0].version;
    } else if (
      safeExistsSync(join(version.replaceAll("../", ""), "package.json"))
    ) {
      const importedComponentObj = await parsePkgJson(
        join(version.replaceAll("../", ""), "package.json"),
        true,
      );
      version = importedComponentObj[0].version;
    }
  } else if (version?.includes("(")) {
    // version: 3.0.1(ajv@8.14.0)
    version = version.split("(")[0];
  }
  return version;
}

/**
 * Parse pnpm workspace file
 *
 * @param {string} workspaceFile pnpm-workspace.yaml
 * @returns {object} Object containing packages and catalogs
 */
export function parsePnpmWorkspace(workspaceFile) {
  const workspaceData = readFileSync(workspaceFile, "utf-8");
  const yamlObj = _load(workspaceData);
  if (!yamlObj) {
    return {};
  }
  const packages = (yamlObj.packages || [])
    .filter((n) => !/^(!|\.|__)/.test(n))
    .map((n) => n.replaceAll("/**", "").replaceAll("/*", ""));
  const catalogs = yamlObj.catalog || {};
  return {
    packages,
    catalogs,
  };
}

/**
 * Helper function to create a properly encoded workspace PURL
 *
 * @param {string} packageName - Package name (e.g., "@babel/core")
 * @param {string} version - Package version
 * @returns {string} Encoded PURL string
 */
export function createNpmWorkspacePurl(packageName, version) {
  try {
    let namespace = "";
    let name = packageName;
    if (packageName.startsWith("@")) {
      const slashIndex = packageName.indexOf("/");
      if (slashIndex > 0) {
        namespace = packageName.substring(0, slashIndex);
        name = packageName.substring(slashIndex + 1);
      }
    }
    const purlObj = new PackageURL("npm", namespace, name, version);
    return purlObj.toString();
  } catch (_err) {
    // Fallback to simple string construction for invalid names
    let workspaceRef = `pkg:npm/${packageName}`;
    if (version) {
      workspaceRef = `${workspaceRef}@${version}`;
    }
    return workspaceRef;
  }
}

/**
 * Helper function to efficiently find matching workspace packages
 *
 * @param {Array} workspacePackages - Array of workspace package PURLs
 * @param {string} packageName - Package name to match against
 * @returns {string|undefined} Matching workspace package PURL or undefined
 */
function findMatchingWorkspace(workspacePackages, packageName) {
  if (!workspacePackages?.length || !packageName) {
    return undefined;
  }

  // Create expected PURL patterns to match against workspace packages
  const expectedEncodedPurl = createNpmWorkspacePurl(packageName);
  const simplePurl = `pkg:npm/${packageName}`;

  return workspacePackages.find(
    (wp) => wp.startsWith(expectedEncodedPurl) || wp.startsWith(simplePurl),
  );
}

export function parseYarnWorkspace(packageJsonFile) {
  try {
    const packageData = JSON.parse(readFileSync(packageJsonFile, "utf-8"));
    if (!packageData?.workspaces) {
      return {};
    }

    let packages = [];
    // Handle both array and object formats
    if (Array.isArray(packageData.workspaces)) {
      packages = packageData.workspaces;
    } else if (
      packageData.workspaces.packages &&
      Array.isArray(packageData.workspaces.packages)
    ) {
      packages = packageData.workspaces.packages;
    }
    // Filter and normalize package patterns - don't strip the glob patterns as they're needed
    packages = packages.filter((n) => !/^(!|\.|__)/.test(n));
    return {
      packages,
    };
  } catch (_err) {
    return {};
  }
}

/**
 * Helper function to find a package path in pnpm node_modules structure
 *
 * @param {string} baseDir Base directory containing node_modules
 * @param {string} packageName Package name (with or without scope)
 * @param {string} version Package version
 * @returns {string|null} Path to the package directory or null if not found
 */
export function findPnpmPackagePath(baseDir, packageName, version) {
  if (!baseDir || !packageName) {
    return null;
  }

  const nodeModulesDir = join(baseDir, "node_modules");
  if (!safeExistsSync(nodeModulesDir)) {
    return null;
  }

  // Try direct node_modules lookup first (for symlinked packages)
  const directPath = join(nodeModulesDir, packageName);
  if (
    safeExistsSync(directPath) &&
    safeExistsSync(join(directPath, "package.json"))
  ) {
    return directPath;
  }

  // Try pnpm's .pnpm directory structure
  const pnpmDir = join(nodeModulesDir, ".pnpm");
  if (safeExistsSync(pnpmDir)) {
    // pnpm stores packages as {name}@{version} in .pnpm directory
    const encodedName = packageName.replace("/", "%2f");
    let pnpmPackagePath;

    // Try different formats that pnpm might use
    const possiblePaths = [
      join(pnpmDir, `${encodedName}@${version}`, "node_modules", packageName),
      join(pnpmDir, `${packageName}@${version}`, "node_modules", packageName),
      join(pnpmDir, `${encodedName}@${version}`),
      join(pnpmDir, `${packageName}@${version}`),
    ];

    for (const possiblePath of possiblePaths) {
      if (
        safeExistsSync(possiblePath) &&
        safeExistsSync(join(possiblePath, "package.json"))
      ) {
        pnpmPackagePath = possiblePath;
        break;
      }
    }

    if (pnpmPackagePath) {
      return pnpmPackagePath;
    }
  }

  return null;
}

/**
 * pnpm packages with metadata from local node_modules
 *
 * @param {Array} pkgList Package list to enhance
 * @param {string} lockFilePath Path to the pnpm-lock.yaml file
 * @returns {Array} Enhanced package list
 */
export async function pnpmMetadata(pkgList, lockFilePath) {
  if (!pkgList || !pkgList.length || !lockFilePath) {
    return pkgList;
  }

  const baseDir = dirname(lockFilePath);
  const nodeModulesDir = join(baseDir, "node_modules");

  // Only proceed if node_modules exists
  if (!safeExistsSync(nodeModulesDir)) {
    return pkgList;
  }

  if (DEBUG_MODE) {
    console.log(
      `Metadata for ${pkgList.length} pnpm packages using local node_modules at ${nodeModulesDir}`,
    );
  }

  let enhancedCount = 0;
  for (const pkg of pkgList) {
    // Skip if package already has complete metadata
    if (pkg.description && pkg.author && pkg.license) {
      continue;
    }

    // Find the package path in node_modules
    const packagePath = findPnpmPackagePath(baseDir, pkg.name, pkg.version);
    if (!packagePath) {
      continue;
    }

    const packageJsonPath = join(packagePath, "package.json");
    if (!safeExistsSync(packageJsonPath)) {
      continue;
    }

    try {
      // Parse the local package.json to get metadata
      const localPkgList = await parsePkgJson(packageJsonPath, true);
      if (localPkgList && localPkgList.length === 1) {
        const localMetadata = localPkgList[0];
        if (localMetadata && Object.keys(localMetadata).length) {
          if (!pkg.description && localMetadata.description) {
            pkg.description = localMetadata.description;
          }
          if (!pkg.author && localMetadata.author) {
            pkg.author = localMetadata.author;
          }
          if (!pkg.license && localMetadata.license) {
            pkg.license = localMetadata.license;
          }
          if (!pkg.homepage && localMetadata.homepage) {
            pkg.homepage = localMetadata.homepage;
          }
          if (!pkg.repository && localMetadata.repository) {
            pkg.repository = localMetadata.repository;
          }

          // Add a property to track that we enhanced from local node_modules
          if (!pkg.properties) {
            pkg.properties = [];
          }
          pkg.properties.push({
            name: "LocalNodeModulesPath",
            value: packagePath,
          });

          enhancedCount++;
        }
      }
    } catch (error) {
      // Silently ignore parsing errors for individual packages
      if (DEBUG_MODE) {
        console.log(
          `Failed to parse package.json at ${packageJsonPath}:`,
          error.message,
        );
      }
    }
  }

  if (DEBUG_MODE && enhancedCount > 0) {
    console.log(
      `Enhanced metadata for ${enhancedCount} packages from local node_modules`,
    );
  }

  return pkgList;
}

/**
 * Parse nodejs pnpm lock file
 *
 * @param {string} pnpmLock pnpm-lock.yaml file
 * @param {Object} parentComponent parent component
 * @param {Array[String]} workspacePackages Workspace packages
 * @param {Object} workspaceSrcFiles Workspace package.json files
 * @param {Object} workspaceCatalogs Workspace catalogs
 * @param {Object} workspaceDirectDeps Direct dependencies of each workspace
 * @param {Object} depsWorkspaceRefs Workspace references for each dependency
 */
export async function parsePnpmLock(
  pnpmLock,
  parentComponent = null,
  workspacePackages = [],
  workspaceSrcFiles = {},
  _workspaceCatalogs = {},
  _workspaceDirectDeps = {},
  depsWorkspaceRefs = {},
) {
  let pkgList = [];
  const dependenciesList = [];
  // For lockfile >= 9, we need to track dev and optional packages manually
  // See: #1163
  // Moreover, we have changed >= 9 for >= 6
  // See: discussion #1359
  const possibleOptionalDeps = {};
  const dependenciesMap = {};
  let ppurl = "";
  let lockfileVersion = 0;
  const parentSubComponents = [];
  const srcFilesMap = {};
  const workspacePackageNames = {};
  const pkgRefMap = {};
  // Track references to packages that are directly installed from github.com
  const gitPkgRefs = {};
  // Track aliases
  const possibleAliases = {};
  const possibleAliasesRefs = {};
  // pnpm could refer to packages from git sources
  const githubServerHost = process.env.CDXGEN_GIT_HOST || "github.com";
  // Convert workspace package names to an object to help with the lookup
  for (const w of workspacePackages || []) {
    workspacePackageNames[w] = true;
  }
  if (parentComponent?.name) {
    ppurl =
      parentComponent.purl ||
      new PackageURL(
        "npm",
        parentComponent.group,
        parentComponent.name,
        parentComponent.version,
        null,
        null,
      ).toString();
  }
  if (safeExistsSync(pnpmLock)) {
    const lockData = readFileSync(pnpmLock, "utf8");
    const yamlObj = _load(lockData);
    if (!yamlObj) {
      return {};
    }
    lockfileVersion = yamlObj.lockfileVersion;
    try {
      lockfileVersion = Number.parseFloat(lockfileVersion, 10);
    } catch (_e) {
      // ignore parse errors
    }
    // This logic matches the pnpm list command to include only direct dependencies
    if (ppurl !== "" && yamlObj?.importers) {
      // In lock file version 6, direct dependencies is under importers
      const rootDirectDeps =
        lockfileVersion >= 6
          ? yamlObj.importers["."]?.dependencies || {}
          : yamlObj.dependencies || {};
      const rootDevDeps =
        lockfileVersion >= 6
          ? yamlObj.importers["."]?.devDependencies || {}
          : {};
      const rootOptionalDeps =
        lockfileVersion >= 6
          ? yamlObj.importers["."]?.optionalDependencies || {}
          : {};
      const rootPeerDeps =
        lockfileVersion >= 6
          ? yamlObj.importers["."]?.peerDependencies || {}
          : {};
      const ddeplist = new Set();
      // Find the root dev dependencies
      for (const rdk of Object.keys(rootDevDeps)) {
        const version = await getVersionNumPnpm(rootDevDeps[rdk]);
        let specifier;
        if (
          typeof rootDevDeps[rdk] === "object" &&
          rootDevDeps[rdk].specifier
        ) {
          specifier = rootDevDeps[rdk].specifier;
        }
        if (specifier?.includes("npm:")) {
          possibleAliases[rdk] = specifier;
        }
        const dpurl = new PackageURL(
          "npm",
          "",
          rdk,
          version,
          null,
          null,
        ).toString();
        possibleOptionalDeps[decodeURIComponent(dpurl)] = true;
      }
      // Find the root optional and peer dependencies
      for (const rdk of Object.keys({ ...rootOptionalDeps, ...rootPeerDeps })) {
        const version = await getVersionNumPnpm(rootOptionalDeps[rdk]);
        let specifier;
        if (
          typeof rootOptionalDeps[rdk] === "object" &&
          rootOptionalDeps[rdk].specifier
        ) {
          specifier = rootOptionalDeps[rdk].specifier;
        }
        if (specifier?.includes("npm:")) {
          possibleAliases[rdk] = specifier;
        }
        const dpurl = new PackageURL(
          "npm",
          "",
          rdk,
          version,
          null,
          null,
        ).toString();
        possibleOptionalDeps[decodeURIComponent(dpurl)] = true;
      }
      // Find the root direct dependencies
      for (const dk of Object.keys(rootDirectDeps)) {
        const version = await getVersionNumPnpm(rootDirectDeps[dk]);
        let specifier;
        if (
          typeof rootDirectDeps[dk] === "object" &&
          rootDirectDeps[dk].specifier
        ) {
          specifier = rootDirectDeps[dk].specifier;
        }
        if (specifier?.includes("npm:")) {
          possibleAliases[dk] = specifier;
        }
        const dpurl = new PackageURL(
          "npm",
          "",
          dk,
          version,
          null,
          null,
        ).toString();
        ddeplist.add(decodeURIComponent(dpurl));
        if (lockfileVersion >= 6) {
          // These are direct dependencies so cannot be optional
          possibleOptionalDeps[decodeURIComponent(dpurl)] = false;
        }
      }
      // pnpm-lock.yaml contains more than root dependencies in importers
      // we do what we did above but for all the other components
      for (const importedComponentName of Object.keys(yamlObj?.importers)) {
        // if component name is '.' continue loop
        if (importedComponentName === ".") {
          continue;
        }
        const componentDeps =
          yamlObj?.importers[importedComponentName]["dependencies"] || {};
        const componentDevDeps =
          yamlObj?.importers[importedComponentName]["devDependencies"] || {};
        const componentOptionalDeps =
          yamlObj?.importers[importedComponentName]["optionalDependencies"] ||
          {};
        const componentPeerDeps =
          yamlObj?.importers[importedComponentName]["peerDependencies"] || {};
        let compPurl;
        let pkgSrcFile;
        let fallbackMode = true;
        if (safeExistsSync(join(importedComponentName, "package.json"))) {
          pkgSrcFile = join(importedComponentName, "package.json");
          const importedComponentObj = await parsePkgJson(pkgSrcFile, true);
          if (importedComponentObj.length) {
            const version = importedComponentObj[0].version;
            compPurl = new PackageURL(
              "npm",
              importedComponentObj[0]?.group,
              importedComponentObj[0]?.name,
              version,
              null,
              null,
            ).toString();
            const compRef = decodeURIComponent(compPurl);
            // Add this package to the root dependency list and parent component
            ddeplist.add(compRef);
            const psObj = {
              group: importedComponentObj[0]?.group,
              name: importedComponentObj[0]?.name,
              version,
              type: "application",
              purl: compPurl,
              "bom-ref": compRef,
            };
            const purlNoVersion = new PackageURL(
              "npm",
              importedComponentObj[0]?.group,
              importedComponentObj[0]?.name,
              version,
            ).toString();
            const matchRef =
              workspacePackageNames[decodeURIComponent(purlNoVersion)] ||
              workspacePackageNames[compRef];
            const matchSrcFile =
              workspaceSrcFiles[decodeURIComponent(purlNoVersion)] ||
              workspaceSrcFiles[compRef];
            if (matchRef || matchSrcFile) {
              psObj.properties = [
                { name: "internal:is_workspace", value: "true" },
              ];
            }
            if (matchSrcFile) {
              psObj.properties.push({ name: "SrcFile", value: matchSrcFile });
              psObj.properties.push({
                name: "internal:virtual_path",
                value: relative(dirname(pnpmLock), dirname(matchSrcFile)),
              });
            }
            parentSubComponents.push(psObj);
            fallbackMode = false;
          }
        }
        if (fallbackMode) {
          const name = importedComponentName.split("/");
          const lastname = name[name.length - 1];
          // let subpath = name.filter(part => part !== '.' && part !== '..').join('/');
          const subpath = name
            .join("/")
            .replaceAll("../", "")
            .replaceAll("./", "");
          compPurl = new PackageURL(
            "npm",
            parentComponent.group,
            `${parentComponent.name}/${lastname}`,
            parentComponent.version || "latest",
            null,
            subpath,
          ).toString();
        }
        // Find the component optional dependencies
        const comDepList = new Set();
        for (const cdk of Object.keys(componentDeps)) {
          let name = cdk;
          let group = "";
          let version;
          const versionObj = componentDeps[cdk];
          if (versionObj?.version?.startsWith(githubServerHost)) {
            const parts = versionObj.version.split("/");
            version = parts.pop();
            name = parts.pop();
            group = parts.pop();
            if (group === githubServerHost) {
              group = "";
            } else {
              group = `@${group}`;
            }
            gitPkgRefs[versionObj.version] = { group, name, version };
          } else {
            version = await getVersionNumPnpm(
              versionObj,
              importedComponentName,
            );
          }
          const dpurl = new PackageURL(
            "npm",
            group,
            name,
            version,
            null,
            null,
          ).toString();
          const depRef = decodeURIComponent(dpurl);
          // This is a definite dependency of this component
          comDepList.add(depRef);
          possibleOptionalDeps[depRef] = false;
          // Track the package.json files
          if (pkgSrcFile) {
            if (!srcFilesMap[depRef]) {
              srcFilesMap[depRef] = [];
            }
            srcFilesMap[depRef].push(pkgSrcFile);
          }
        }
        for (const cdk of Object.keys(componentDevDeps)) {
          const version = await getVersionNumPnpm(componentDevDeps[cdk]);
          const dpurl = new PackageURL(
            "npm",
            "",
            cdk,
            version,
            null,
            null,
          ).toString();
          const devDpRef = decodeURIComponent(dpurl);
          possibleOptionalDeps[devDpRef] = true;
          // This is also a dependency of this component
          comDepList.add(devDpRef);
        }
        for (const cdk of Object.keys({
          ...componentOptionalDeps,
          ...componentPeerDeps,
        })) {
          const version = await getVersionNumPnpm(componentOptionalDeps[cdk]);
          const dpurl = new PackageURL(
            "npm",
            "",
            cdk,
            version,
            null,
            null,
          ).toString();
          possibleOptionalDeps[decodeURIComponent(dpurl)] = true;
        }
        dependenciesList.push({
          ref: decodeURIComponent(compPurl),
          dependsOn: [...comDepList].sort(),
        });
      }
      dependenciesList.push({
        ref: decodeURIComponent(ppurl),
        dependsOn: [...ddeplist].sort(),
      });
    }
    const packages = yamlObj.packages || {};
    // snapshots is a new key under lockfile version 9
    const snapshots = yamlObj.snapshots || {};
    const pkgKeys = { ...Object.keys(packages), ...Object.keys(snapshots) };
    for (const k in pkgKeys) {
      // Eg: @babel/code-frame/7.10.1
      // In lockfileVersion 6, /@babel/code-frame@7.18.6
      let fullName = pkgKeys[k].replace("/@", "@");
      // Handle /vite@4.2.1(@types/node@18.15.11) in lockfileVersion 6
      if (lockfileVersion >= 6 && fullName.includes("(")) {
        fullName = fullName.split("(")[0];
      }
      const parts = fullName.split("/");
      const packageNode =
        packages[pkgKeys[k]] ||
        snapshots[pkgKeys[k]] ||
        packages[fullName] ||
        snapshots[fullName];
      if (!packageNode) {
        continue;
      }
      const resolution =
        packages[pkgKeys[k]]?.resolution ||
        snapshots[pkgKeys[k]]?.resolution ||
        packages[fullName]?.resolution ||
        snapshots[fullName]?.resolution;
      const integrity = resolution?.integrity;
      const cpu =
        packages[pkgKeys[k]]?.cpu ||
        snapshots[pkgKeys[k]]?.cpu ||
        packages[fullName]?.cpu ||
        snapshots[fullName]?.cpu;
      const os =
        packages[pkgKeys[k]]?.os ||
        snapshots[pkgKeys[k]]?.os ||
        packages[fullName]?.os ||
        snapshots[fullName]?.os;
      const libc =
        packages[pkgKeys[k]]?.libc ||
        snapshots[pkgKeys[k]]?.libc ||
        packages[fullName]?.libc ||
        snapshots[fullName]?.libc;
      // In lock file version 9, dependencies is under snapshots
      const deps =
        packages[pkgKeys[k]]?.dependencies ||
        snapshots[pkgKeys[k]]?.dependencies ||
        packages[fullName]?.dependencies ||
        snapshots[fullName]?.dependencies ||
        {};
      const optionalDeps =
        packages[pkgKeys[k]]?.optionalDependencies ||
        snapshots[pkgKeys[k]]?.optionalDependencies ||
        packages[fullName]?.optionalDependencies ||
        snapshots[fullName]?.optionalDependencies ||
        {};
      const _peerDeps =
        packages[pkgKeys[k]]?.peerDependencies ||
        snapshots[pkgKeys[k]]?.peerDependencies ||
        packages[fullName]?.peerDependencies ||
        snapshots[fullName]?.peerDependencies ||
        {};
      // Track the explicit optional dependencies of this package
      for (const opkgName of Object.keys(optionalDeps)) {
        let vers = optionalDeps[opkgName];
        if (vers?.includes("(")) {
          vers = vers.split("(")[0];
        }
        let opurlString;
        if (vers.includes("@")) {
          opurlString = PackageURL.fromString(
            `pkg:npm/${vers.replace(/^@/g, "%40")}`,
          ).toString();
        } else {
          opurlString = PackageURL.fromString(
            `pkg:npm/${encodeURIComponent(opkgName).replace(/%2F/g, "/")}@${vers}`,
          ).toString();
        }
        const obomRef = decodeURIComponent(opurlString);
        if (possibleOptionalDeps[obomRef] === undefined) {
          possibleOptionalDeps[obomRef] = true;
        }
        if (possibleAliases[opkgName]) {
          possibleAliasesRefs[obomRef] = opkgName;
        }
      }
      let scope =
        packageNode.dev === true || packageNode.optional === true
          ? "optional"
          : undefined;
      // In v9, a package can be declared optional in more places :(
      if (
        lockfileVersion >= 9 &&
        (packages[pkgKeys[k]]?.optional === true ||
          snapshots[pkgKeys[k]]?.optional === true ||
          packages[fullName]?.optional === true ||
          snapshots[fullName]?.optional === true)
      ) {
        scope = "optional";
      }
      if (parts?.length) {
        let name = "";
        let version = "";
        let group = "";
        let srcUrl;
        const hasBin = packageNode?.hasBin;
        const deprecatedMessage = packageNode?.deprecated;
        if (lockfileVersion >= 9 && fullName.includes("@")) {
          // ci-info@https://codeload.github.com/watson/ci-info/tar.gz/f43f6a1cefff47fb361c88cf4b943fdbcaafe540
          const possibleHttpParts = fullName.split("@");
          if (
            possibleHttpParts[possibleHttpParts.length - 1].startsWith("http")
          ) {
            srcUrl = possibleHttpParts[possibleHttpParts.length - 1];
            name = fullName.replace(`@${srcUrl}`, "");
            version = srcUrl.split("/").pop();
          } else if (
            possibleHttpParts[possibleHttpParts.length - 1].startsWith("file")
          ) {
            srcUrl = possibleHttpParts[possibleHttpParts.length - 1];
            name = fullName.replace(`@${srcUrl}`, "");
            version = "";
          } else {
            group = parts.length > 1 ? parts[0] : "";
            const tmpA = parts[parts.length - 1].split("@");
            if (tmpA.length > 1) {
              name = tmpA[0];
              version = tmpA[1];
            }
            if (version?.includes("(")) {
              version = version.split("(")[0];
            }
          }
        } else if (
          lockfileVersion >= 6 &&
          lockfileVersion < 9 &&
          fullName.includes("@")
        ) {
          const tmpA = parts[parts.length - 1].split("@");
          group = parts[0];
          if (parts.length === 2 && tmpA.length > 1) {
            name = tmpA[0];
            version = tmpA[1];
          } else {
            console.log("Missed", parts, fullName);
          }
        } else {
          if (parts.length === 2) {
            name = parts[0];
            version = parts[1];
          } else if (parts.length === 3) {
            group = parts[0];
            name = parts[1];
            version = parts[2];
          }
        }
        // Let's have some warnings till we fully support pnpm 8
        if (!name) {
          if (gitPkgRefs[fullName]) {
            name = gitPkgRefs[fullName].name;
            group = gitPkgRefs[fullName].group;
            version = gitPkgRefs[fullName].version;
          } else if (parts?.length >= 3 && parts[0] === githubServerHost) {
            version = parts[parts.length - 1];
            name = parts[parts.length - 2];
            group = parts.length === 4 ? `@${parts[parts.length - 3]}` : "";
            gitPkgRefs[fullName] = {
              group,
              name,
              version,
              purl: new PackageURL("npm", group, name, version).toString(),
            };
          } else {
            console.warn(
              `Unable to extract name and version for string ${pkgKeys[k]}`,
              parts,
              fullName,
            );
            continue;
          }
        }
        if (name.indexOf("file:") !== 0) {
          const purlString = new PackageURL(
            "npm",
            group,
            name,
            version,
            srcUrl ? { vcs_url: srcUrl } : null,
            null,
          ).toString();
          const bomRef = decodeURIComponent(purlString);
          const isBaseOptional = possibleOptionalDeps[bomRef];
          const deplist = [];
          for (let dpkgName of Object.keys(deps)) {
            let vers = deps[dpkgName];
            if (vers?.includes("(")) {
              vers = vers.split("(")[0];
            }
            // string-width-cjs: string-width@4.2.3
            if (dpkgName.endsWith("-cjs")) {
              const tmpB = vers.split("@");
              if (tmpB.length > 1) {
                dpkgName = tmpB[0].replace(/^\//, "");
                vers = tmpB[1];
              }
            }
            if (vers.includes("file:") || vers.includes("link:")) {
              vers = await getVersionNumPnpm(vers.split("@").pop());
            }
            // With overrides version could be like this: @nolyfill/side-channel@1.0.29
            if (vers.includes("@")) {
              const overrideVersion = vers.split("@").pop();
              dpkgName = vers
                .replace(`@${overrideVersion}`, "")
                .replace(/^\//, "");
              vers = overrideVersion;
            }
            const dpurlString = PackageURL.fromString(
              `pkg:npm/${encodeURIComponent(dpkgName).replace(/%2F/g, "/")}@${vers}`,
            ).toString();
            const dbomRef = decodeURIComponent(dpurlString);
            deplist.push(dbomRef);
            // If the base package is optional, make the dependencies optional too
            // We need to repeat the optional detection down the line to find these new packages
            if (isBaseOptional && possibleOptionalDeps[dbomRef] === undefined) {
              possibleOptionalDeps[dbomRef] = true;
              scope = "optional";
              _markTreeOptional(
                dbomRef,
                dependenciesMap,
                possibleOptionalDeps,
                {},
              );
            }
          }
          if (!dependenciesMap[bomRef]) {
            dependenciesMap[bomRef] = [];
          }

          dependenciesMap[bomRef] = dependenciesMap[bomRef].concat(deplist);
          const properties = [
            {
              name: "SrcFile",
              value: pnpmLock,
            },
          ];
          if (hasBin || os || cpu || libc) {
            properties.push({
              name: "cdx:npm:has_binary",
              value: `${hasBin}`,
            });
          }
          if (deprecatedMessage) {
            properties.push({
              name: "cdx:npm:deprecation_notice",
              value: deprecatedMessage,
            });
          }
          const binary_metadata = { os, cpu, libc };
          Object.entries(binary_metadata).forEach(([key, value]) => {
            if (!value) return;
            properties.push({
              name: `cdx:pnpm:${key}`,
              value: Array.isArray(value) ? value.join(", ") : value,
            });
          });
          if (srcFilesMap[decodeURIComponent(purlString)]) {
            for (const sf of srcFilesMap[decodeURIComponent(purlString)]) {
              properties.push({
                name: "cdx:npm:package_json",
                value: sf,
              });
            }
          }
          const purlNoVersion = new PackageURL("npm", group, name).toString();
          let packageType = "library";
          const theBomRef = decodeURIComponent(purlString);
          if (
            workspacePackageNames[decodeURIComponent(purlNoVersion)] ||
            workspacePackageNames[theBomRef]
          ) {
            properties.push({
              name: "internal:is_workspace",
              value: "true",
            });
            packageType = "application";
            const wsSrcFile =
              workspaceSrcFiles[decodeURIComponent(purlNoVersion)] ||
              workspaceSrcFiles[theBomRef];
            if (wsSrcFile) {
              properties.push({
                name: "internal:virtual_path",
                value: relative(dirname(pnpmLock), dirname(wsSrcFile)),
              });
            }
          }
          // Capture all the workspaces that directly depend on this package and their source file
          for (const wref of Array.from(
            depsWorkspaceRefs[purlNoVersion] ||
              depsWorkspaceRefs[purlString] ||
              [],
          )) {
            // This cycle shouldn't happen, but we can't be sure
            if (wref === purlString) {
              continue;
            }
            properties.push({
              name: "internal:workspaceRef",
              value: wref,
            });
            if (workspaceSrcFiles[wref]) {
              properties.push({
                name: "internal:workspaceSrcFile",
                value: workspaceSrcFiles[wref],
              });
            }
            // Add workspaceRef to the dependent components as well
            for (const dref of dependenciesMap[theBomRef]) {
              if (!depsWorkspaceRefs[dref]) {
                depsWorkspaceRefs[dref] = [];
              }
              if (!depsWorkspaceRefs[dref].includes(wref)) {
                depsWorkspaceRefs[dref].push(wref);
              }
              if (dependenciesMap[dref]) {
                for (const l2ref of dependenciesMap[dref]) {
                  if (!depsWorkspaceRefs[l2ref]) {
                    depsWorkspaceRefs[l2ref] = [];
                  }
                  if (!depsWorkspaceRefs[l2ref].includes(wref)) {
                    depsWorkspaceRefs[l2ref].push(wref);
                  }
                }
              }
            }
          }
          const thePkg = {
            group: group,
            name: name,
            version: version,
            purl: purlString,
            "bom-ref": theBomRef,
            type: packageType,
            scope,
            _integrity: integrity,
            properties,
            evidence: {
              identity: {
                field: "purl",
                confidence: 1,
                methods: [
                  {
                    technique: "manifest-analysis",
                    confidence: 1,
                    value: pnpmLock,
                  },
                ],
              },
            },
          };
          // Don't add internal workspace packages to the components list
          if (thePkg.type !== "application") {
            pkgList.push(thePkg);
          }
          pkgRefMap[thePkg["bom-ref"]] = thePkg;
        }
      }
    }
  }
  // We need to repeat optional packages detection
  if (Object.keys(possibleOptionalDeps).length) {
    for (const apkg of pkgList) {
      if (!apkg.scope) {
        if (possibleOptionalDeps[apkg["bom-ref"]]) {
          apkg.scope = "optional";
          _markTreeOptional(
            apkg["bom-ref"],
            dependenciesMap,
            possibleOptionalDeps,
            {},
          );
        }
      }
    }
  }

  // Problem: We might have over aggressively marked a package as optional even it is both required and optional
  // The below loops ensure required packages continue to stay required
  // See #1184
  const requiredDependencies = {};
  const requiredDependencyStack = [];
  // Initialize the required dependency stack
  for (const dependency in possibleOptionalDeps) {
    if (possibleOptionalDeps[dependency] === false) {
      requiredDependencyStack.push(dependency);
    }
  }

  // Walk the required dependency stack iteratively and mark it as required
  while (requiredDependencyStack.length > 0) {
    const requiredDependencyRef = requiredDependencyStack.pop();
    if (!requiredDependencies[requiredDependencyRef]) {
      requiredDependencies[requiredDependencyRef] = true;
      if (dependenciesMap[requiredDependencyRef]) {
        for (const subDependencyRef of dependenciesMap[requiredDependencyRef]) {
          requiredDependencyStack.push(subDependencyRef);
        }
      }
    }
  }
  // Ensure any required dependency is not scoped optionally
  for (const apkg of pkgList) {
    if (requiredDependencies[apkg["bom-ref"]]) {
      apkg.scope = undefined;
    }
    if (possibleAliasesRefs[apkg["bom-ref"]]) {
      apkg.properties.push({
        name: "cdx:pnpm:alias",
        value: possibleAliasesRefs[apkg["bom-ref"]],
      });
    }
    // There are no workspaces so exit early
    if (!Object.keys(workspacePackageNames).length) {
      continue;
    }
    const purlNoVersion = decodeURIComponent(
      new PackageURL("npm", apkg.group, apkg.name).toString(),
    );
    const wsRefs =
      depsWorkspaceRefs[apkg["bom-ref"]] || depsWorkspaceRefs[purlNoVersion];
    // There is a workspace reference
    if (wsRefs?.length) {
      const wsprops = apkg.properties.filter(
        (p) => p.name === "internal:workspaceRef",
      );
      // workspace properties are already set.
      if (wsprops.length) {
        continue;
      }
      for (const wref of wsRefs) {
        // Such a cycle should never happen, but we can't sure
        if (wref === apkg["bom-ref"]) {
          continue;
        }
        apkg.properties.push({
          name: "internal:workspaceRef",
          value: wref,
        });
        const purlObj = PackageURL.fromString(apkg.purl);
        purlObj.version = undefined;
        const wrefNoVersion = decodeURIComponent(purlObj.toString());
        const wsrcFile =
          workspaceSrcFiles[wref] || workspaceSrcFiles[wrefNoVersion];
        if (wsrcFile) {
          apkg.properties.push({
            name: "internal:workspaceSrcFile",
            value: wsrcFile,
          });
        }
        // Repeat for the children
        _setTreeWorkspaceRef(
          dependenciesMap,
          apkg["bom-ref"],
          pkgRefMap,
          wref,
          wsrcFile,
          depsWorkspaceRefs,
        );
      }
    }
  }

  if (Object.keys(dependenciesMap).length) {
    for (const aref of Object.keys(dependenciesMap)) {
      dependenciesList.push({
        ref: aref,
        dependsOn: [...new Set(dependenciesMap[aref])].sort(),
      });
    }
  }

  // Enhance metadata from local node_modules if available
  if (pkgList?.length) {
    pkgList = await pnpmMetadata(pkgList, pnpmLock);
  }

  if (shouldFetchLicense() && pkgList && pkgList.length) {
    if (DEBUG_MODE) {
      console.log(
        `About to fetch license information for ${pkgList.length} packages in parsePnpmLock`,
      );
    }
    pkgList = await getNpmMetadata(pkgList);
    return {
      pkgList,
      dependenciesList,
      parentSubComponents,
    };
  }
  return {
    pkgList,
    dependenciesList,
    parentSubComponents,
  };
}

/**
 * Parse bower json file
 *
 * @param {string} bowerJsonFile bower.json file
 */
export async function parseBowerJson(bowerJsonFile) {
  const pkgList = [];
  if (safeExistsSync(bowerJsonFile)) {
    try {
      const pkgData = JSON.parse(readFileSync(bowerJsonFile, "utf8"));
      const pkgIdentifier = parsePackageJsonName(pkgData.name);
      pkgList.push({
        name: pkgIdentifier.fullName || pkgData.name,
        group: pkgIdentifier.scope || "",
        version: pkgData.version || "",
        description: pkgData.description || "",
        license: pkgData.license || "",
        properties: [
          {
            name: "SrcFile",
            value: bowerJsonFile,
          },
        ],
        evidence: {
          identity: {
            field: "purl",
            confidence: 1,
            methods: [
              {
                technique: "manifest-analysis",
                confidence: 1,
                value: bowerJsonFile,
              },
            ],
          },
        },
      });
    } catch (_err) {
      // continue regardless of error
    }
  }
  if (shouldFetchLicense() && pkgList && pkgList.length) {
    if (DEBUG_MODE) {
      console.log(
        `About to fetch license information for ${pkgList.length} packages in parseBowerJson`,
      );
    }
    return await getNpmMetadata(pkgList);
  }
  return pkgList;
}

/**
 * Parse minified js file
 *
 * @param {string} minJsFile min.js file
 */
export async function parseMinJs(minJsFile) {
  const pkgList = [];
  if (safeExistsSync(minJsFile)) {
    try {
      const rawData = readFileSync(minJsFile, { encoding: "utf-8" });
      const tmpA = rawData.split("\n");
      tmpA.forEach((l) => {
        if ((l.startsWith("/*!") || l.startsWith("  * ")) && l.length < 500) {
          let delimiter = "  * ";
          if (!l.includes(delimiter) && l.includes("/*!")) {
            delimiter = "/*!";
          }
          if (!l.includes(delimiter) && l.includes(" - ")) {
            delimiter = " - ";
          }
          const tmpPV = l.split(delimiter);
          if (!tmpPV || tmpPV.length < 2) {
            return;
          }
          // Eg: jQuery v3.6.0
          const pkgNameVer = tmpPV[1]
            .replace("/*!", "")
            .replace("  * ", "")
            .trim();
          const tmpB = pkgNameVer.includes(" - ")
            ? pkgNameVer.split(" - ")
            : pkgNameVer.split(" ");
          if (tmpB && tmpB.length > 1) {
            // Fix #223 - lowercase parsed package name
            const name = tmpB[0].replace(/ /g, "-").trim().toLowerCase();
            if (name === "@license" || name === "license") {
              return;
            }
            if (name.startsWith("@") && !name.includes("/")) {
              return;
            }
            if (
              [
                "copyright",
                "author",
                "licensed",
                "minified",
                "vendor",
                "build",
              ].includes(name.toLowerCase())
            ) {
              return;
            }
            const pkgIdentifier = parsePackageJsonName(name);
            if (pkgIdentifier.fullName !== "") {
              pkgList.push({
                name: pkgIdentifier.fullName,
                group: pkgIdentifier.scope || "",
                version: tmpB[1].replace(/^v/, "") || "",
                properties: [
                  {
                    name: "SrcFile",
                    value: minJsFile,
                  },
                ],
                evidence: {
                  identity: {
                    field: "purl",
                    confidence: 0.25,
                    methods: [
                      {
                        technique: "filename",
                        confidence: 0.25,
                        value: minJsFile,
                      },
                    ],
                  },
                },
              });
            }
          }
        }
      });
    } catch (_err) {
      // continue regardless of error
    }
  }
  if (shouldFetchLicense() && pkgList && pkgList.length) {
    if (DEBUG_MODE) {
      console.log(
        `About to fetch license information for ${pkgList.length} packages in parseMinJs`,
      );
    }
    return await getNpmMetadata(pkgList);
  }
  return pkgList;
}

/**
 * Parse pom file
 *
 * @param {string} pomFile pom file to parse
 * @returns {Object} Object containing pom properties, modules, and array of dependencies
 */
export function parsePom(pomFile) {
  const deps = [];
  let modules;
  let pomPurl;
  const properties = {};
  let isQuarkus = false;
  const xmlData = readFileSync(pomFile, "utf-8");
  const project = xml2js(xmlData, {
    compact: true,
    spaces: 4,
    textKey: "_",
    attributesKey: "$",
    commentKey: "value",
  }).project;
  for (const aprop of [
    "groupId",
    "artifactId",
    "version",
    "name",
    "description",
    "url",
    "packaging",
  ]) {
    if (project?.[aprop]?._) {
      properties[aprop] = project[aprop]._;
    }
  }
  // Take the version from the parent if available
  if (!properties.version && project.parent) {
    properties.version = project.parent.version._;
  }
  // Take the groupId from the parent if available
  if (!properties.groupId && project.parent) {
    properties.groupId = project.parent.groupId._;
  }
  if (project?.scm?.url?._) {
    properties.scm = project.scm.url._;
  }
  if (properties.groupId || properties.artifactId) {
    pomPurl = new PackageURL(
      "maven",
      properties.groupId || "",
      properties.artifactId,
      properties.version,
      { type: properties.packaging || "jar" },
      null,
    ).toString();
  }
  if (project?.modules?.module) {
    if (Array.isArray(project.modules.module)) {
      // If it's an array, proceed with mapping
      modules = project.modules.module.map((m) => m?._);
    } else {
      // If not an array, handle/convert it accordingly. For instance:
      modules = [project.modules.module._];
    }
  }
  if (project?.properties) {
    for (const aprop of Object.keys(project.properties)) {
      properties[aprop] = project.properties[aprop]?._;
      if (!isQuarkus && aprop.startsWith("quarkus.platform")) {
        isQuarkus = true;
      }
    }
  }
  // Check the plugins for quarkus
  if (!isQuarkus && project?.build?.plugins?.plugin) {
    if (Array.isArray(project.build.plugins.plugin)) {
      for (const aplugin of project.build.plugins.plugin) {
        if (aplugin?.groupId?._?.includes("quarkus.platform")) {
          isQuarkus = true;
          break;
        }
      }
    } else if (
      Object.keys(project.build.plugins.plugin).length &&
      project.build.plugins.plugin?.groupId?._
    ) {
      if (project.build.plugins.plugin.groupId._.includes("quarkus.platform")) {
        isQuarkus = true;
      }
    }
  }
  if (project?.dependencies) {
    let dependencies = project.dependencies.dependency;
    // Convert to an array
    if (!dependencies) {
      dependencies = [];
    } else if (dependencies && !Array.isArray(dependencies)) {
      dependencies = [dependencies];
    }
    for (const adep of dependencies) {
      const version = adep.version;
      let versionStr;
      if (version?._) {
        versionStr = version._;
      }
      if (versionStr?.includes("$")) {
        versionStr = properties[versionStr?.replace(/[${}]/g, "")];
      }
      if (includeMavenTestScope || !adep.scope || adep.scope !== "test") {
        deps.push({
          group: adep.groupId ? adep.groupId._ : "",
          name: adep.artifactId ? adep.artifactId._ : "",
          version: versionStr,
          qualifiers: { type: "jar" },
          properties: [
            {
              name: "SrcFile",
              value: pomFile,
            },
          ],
          evidence: {
            identity: {
              field: "purl",
              confidence: 1,
              methods: [
                {
                  technique: "manifest-analysis",
                  confidence: !versionStr ? 0 : 0.6,
                  value: pomFile,
                },
              ],
            },
          },
        });
      }
    }
  }
  return { isQuarkus, pomPurl, modules, properties, dependencies: deps };
}

/**
 * Parse maven tree output
 * @param {string} rawOutput Raw string output
 * @param {string} pomFile .pom file for evidence
 *
 * @returns {Object} Object containing packages and dependencies
 */
export function parseMavenTree(rawOutput, pomFile) {
  if (!rawOutput) {
    return {};
  }
  const deps = [];
  const dependenciesList = [];
  const keys_cache = {};
  const level_trees = {};
  const tmpA = rawOutput.split("\n");
  let last_level = 0;
  let last_purl = "";
  let first_ref;
  const stack = [];
  tmpA.forEach((l) => {
    l = l.replace("\r", "");
    if (!includeMavenTestScope && l.trim().endsWith(":test")) {
      return;
    }
    let level = 0;
    const tmpline = l.split(" ");
    if (tmpline?.length) {
      if (l.includes(" ")) {
        level = l.replace(tmpline[tmpline.length - 1], "").length / 3;
      }
      l = tmpline[tmpline.length - 1];
      const pkgArr = l.split(":");
      // Support for classifiers
      // com.github.jnr:jffi:jar:1.3.11:compile
      // com.github.jnr:jffi:jar:native:1.3.11:runtime
      let classifier;
      if (pkgArr && pkgArr.length > 2) {
        let versionStr = pkgArr[pkgArr.length - 2];
        const componentScope = pkgArr[pkgArr.length - 1];
        if (
          pkgArr.length >= 6 &&
          pkgArr[3] !== versionStr &&
          !pkgArr[3].includes(".jar")
        ) {
          classifier = pkgArr[3];
        }
        // Ignore test scope
        if (!includeMavenTestScope && componentScope === "test") {
          return;
        }
        let scope;
        if (["compile", "runtime"].includes(componentScope)) {
          scope = "required";
        } else if (componentScope === "test") {
          scope = "optional";
        } else if (componentScope === "provided") {
          scope = "excluded";
        }
        if (pkgArr.length === 4) {
          versionStr = pkgArr[pkgArr.length - 1];
        }
        const qualifiers = { type: pkgArr[2] };
        if (classifier) {
          qualifiers.classifier = classifier;
        }
        const purlString = new PackageURL(
          "maven",
          pkgArr[0],
          pkgArr[1],
          versionStr,
          qualifiers,
          null,
        ).toString();
        const bomRef = decodeURIComponent(purlString);
        const key = bomRef;
        if (!first_ref) {
          first_ref = bomRef;
        }
        if (!keys_cache[key]) {
          keys_cache[key] = key;
          const properties = [];
          if (scope) {
            properties.push({
              name: "cdx:maven:component_scope",
              value: componentScope,
            });
          }
          const apkg = {
            group: pkgArr[0],
            name: pkgArr[1],
            version: versionStr,
            qualifiers,
            scope,
            properties,
            purl: purlString,
            "bom-ref": bomRef,
          };
          if (pomFile) {
            properties.push({
              name: "SrcFile",
              value: pomFile,
            });
            apkg.evidence = {
              identity: {
                field: "purl",
                confidence: 0.5,
                methods: [
                  {
                    technique: "manifest-analysis",
                    confidence: 0.5,
                    value: pomFile,
                  },
                ],
              },
            };
          }
          deps.push(apkg);
          if (!level_trees[bomRef]) {
            level_trees[bomRef] = [];
          }
          if (level === 0 || last_purl === "") {
            stack.push(bomRef);
          } else if (level > last_level) {
            const cnodes = level_trees[last_purl] || [];
            cnodes.push(bomRef);
            level_trees[last_purl] = cnodes;
            if (stack[stack.length - 1] !== bomRef) {
              stack.push(bomRef);
            }
          } else {
            for (let i = level; i <= last_level; i++) {
              stack.pop();
            }
            const last_stack = stack.length
              ? stack[stack.length - 1]
              : first_ref;
            const cnodes = level_trees[last_stack] || [];
            cnodes.push(bomRef);
            level_trees[last_stack] = cnodes;
            stack.push(bomRef);
          }
          last_level = level;
          last_purl = bomRef;
        }
      }
    }
  });
  for (const lk of Object.keys(level_trees)) {
    dependenciesList.push({
      ref: lk,
      dependsOn: [...new Set(level_trees[lk])].sort(),
    });
  }
  const parentComponent = deps?.length
    ? { ...deps[0], type: "application" }
    : {};
  return {
    parentComponent,
    pkgList: deps,
    dependenciesList,
  };
}

/**
 * Parse mill dependencies from file
 *
 * @param {string} module name of the module
 * @param {map} dependencies the parsed dependencies
 * @param {map} relations a map containing all relations
 * @param {string} millRootPath root of the project
 *
 * @returns the bom-ref of the module
 */
export function parseMillDependency(
  module,
  dependencies,
  relations,
  millRootPath,
) {
  const treeRegex = /^(?<treeIndentation>(?:[?├│└─ ]{3})+)(?<dependency>.*)/m;
  const ESC = "\\x1B";
  const versionRegex = new RegExp(
    `^(?:${ESC}\\[\\d+m.+ -> )?(?<version>[^\\ ${ESC}]+)(?:.*${ESC}\\[0m)?`,
    "m",
  );
  const levelCache = new Map();
  const moduleComponent = completeComponent({
    name: module,
    version: "latest",
  });
  dependencies.set(moduleComponent["bom-ref"], moduleComponent);
  relations.set(moduleComponent["bom-ref"], []);
  levelCache.set(0, moduleComponent["bom-ref"]);
  let moduleFilePath = module;
  const versionNumbers = [];
  let indexOfBracket = moduleFilePath.indexOf("[");
  for (let versionIndex = 0; indexOfBracket !== -1; versionIndex++) {
    // Special handling for modules called something like 'main.init.sbt.models[2.12.20]'
    // This needs to be turned into a path like 'main/init/sbt/models/2.12.20'
    // However, since all other periods need to be changed to slashes, this needs something more...
    versionNumbers.push(
      moduleFilePath.substring(
        indexOfBracket + 1,
        moduleFilePath.indexOf("]", indexOfBracket + 1),
      ),
    );
    moduleFilePath = moduleFilePath.replace(
      `[${versionNumbers[versionIndex]}]`,
      "[]",
    );
    indexOfBracket = moduleFilePath.indexOf("[", indexOfBracket + 1);
  }
  moduleFilePath = moduleFilePath.replaceAll(".", "/");
  for (const versionNumber of versionNumbers) {
    // Now put the versions we removed above back into the path and replace the brackets at the same time
    moduleFilePath = moduleFilePath.replace("[]", `/${versionNumber}/`);
  }
  moduleFilePath = resolve(
    millRootPath,
    "out",
    moduleFilePath,
    "ivyDepsTree.log",
  );
  moduleComponent.properties = [
    {
      name: "SrcFile",
      value: moduleFilePath,
    },
  ];
  moduleComponent.evidence = {
    identity: {
      field: "purl",
      confidence: 0.6,
      methods: [
        {
          technique: "manifest-analysis",
          confidence: 0.6,
          value: moduleFilePath,
        },
      ],
    },
  };
  const dependencyTreeLog = readFileSync(moduleFilePath, "utf-8");
  const dependencyTreeLines = dependencyTreeLog
    .trim()
    .split("\n")
    .map((dependency) => dependency.replaceAll("\r", ""));
  for (const line of dependencyTreeLines) {
    const match = treeRegex.exec(line);
    if (match === null) {
      continue;
    }
    const level = match.groups.treeIndentation.length / 3;
    let group;
    let name;
    let version;
    if (match.groups.dependency.indexOf(":") === -1) {
      name = match.groups.dependency;
      version = "latest";
    } else {
      [group, name, version] = match.groups.dependency.split(":");
      version = versionRegex.exec(version).groups.version;
    }
    const component = completeComponent({
      group,
      name,
      version,
    });
    if (!dependencies.has(component["bom-ref"])) {
      dependencies.set(component["bom-ref"], component);
      relations.set(component["bom-ref"], []);
    }
    if (
      !relations.get(levelCache.get(level - 1)).includes(component["bom-ref"])
    ) {
      relations.get(levelCache.get(level - 1)).push(component["bom-ref"]);
    }
    levelCache.set(level, component["bom-ref"]);
  }
  return moduleComponent["bom-ref"];
}

function completeComponent(component) {
  component["type"] = component.group ? "library" : "application";
  const purl = new PackageURL(
    "maven",
    component.group,
    component.name,
    component.version,
    { type: "jar" },
    null,
  ).toString();
  component["purl"] = purl;
  component["bom-ref"] = decodeURIComponent(purl);
  return component;
}

/**
 * Parse gradle dependencies output
 * @param {string} rawOutput Raw string output
 * @param {string} rootProjectName Root project name
 * @param {map} gradleModules Cache with all gradle modules that have already been read
 * @param {string} gradleRootPath Root path where Gradle is to be run when getting module information
 */
export async function parseGradleDep(
  rawOutput,
  rootProjectName = "root",
  gradleModules = new Map(),
  gradleRootPath = "",
) {
  if (typeof rawOutput === "string") {
    // Bug: 249. Get any sub-projects refered here
    const retMap = parseGradleProjects(rawOutput);
    // Issue #289. Work hard to find the root project name
    if (
      !rootProjectName ||
      (rootProjectName === "root" &&
        retMap &&
        retMap.rootProject &&
        retMap.rootProject !== "root")
    ) {
      rootProjectName = retMap.rootProject;
    }
    let match = "";
    // To render dependency tree we need a root project
    const rootProject = gradleModules.get(rootProjectName);
    const deps = [];
    const dependenciesList = [];
    const keys_cache = {};
    const deps_keys_cache = {};
    let last_level = 0;
    let last_bomref = rootProject["bom-ref"];
    const first_bomref = last_bomref;
    let last_project_bomref = first_bomref;
    const level_trees = {};
    level_trees[last_bomref] = [];
    let scope;
    let profileName;
    if (retMap?.projects) {
      const modulesToSkip = process.env.GRADLE_SKIP_MODULES
        ? process.env.GRADLE_SKIP_MODULES.split(",")
        : [];
      const modulesToScan = retMap.projects.filter(
        (module) => !gradleModules.has(module),
      );
      if (modulesToScan.length > 0) {
        const parallelPropTaskOut = executeParallelGradleProperties(
          gradleRootPath,
          modulesToScan.filter((module) => !modulesToSkip.includes(module)),
        );
        const splitPropTaskOut = splitOutputByGradleProjects(
          parallelPropTaskOut,
          ["properties"],
        );

        for (const module of modulesToScan) {
          const propMap = parseGradleProperties(
            splitPropTaskOut.get(module),
            module,
          );
          const rootSubProject = propMap.rootProject;
          if (rootSubProject) {
            const rootSubProjectObj = await buildObjectForGradleModule(
              rootSubProject === "root" ? module : rootSubProject,
              propMap.metadata,
            );
            gradleModules.set(module, rootSubProjectObj);
          }
        }
      }
      const subDependsOn = [];
      for (const sd of retMap.projects) {
        if (gradleModules.has(sd)) {
          subDependsOn.push(gradleModules.get(sd)["bom-ref"]);
        }
      }
      level_trees[last_bomref] = subDependsOn;
    }
    let stack = [last_bomref];
    const depRegex =
      /^.*?--- +(?<groupspecified>[^\s:]+) ?:(?<namespecified>[^\s:]+)(?::(?:{strictly [[]?)?(?<versionspecified>[^,\s:}]+))?(?:})?(?:[^->]* +-> +(?:(?<groupoverride>[^\s:]+):(?<nameoverride>[^\s:]+):)?(?<versionoverride>[^\s:]+))?/gm;
    for (let rline of rawOutput.split("\n")) {
      if (!rline) {
        continue;
      }
      rline = rline.replace("\r", "");
      if (
        (rline.startsWith("+--- ") || rline.startsWith("\\--- ")) &&
        rline.includes("{strictly") &&
        rline.includes("(c)")
      ) {
        continue;
      }
      if (
        rline.trim() === "" ||
        rline.startsWith("+--- ") ||
        rline.startsWith("\\--- ")
      ) {
        last_level = 1;
        last_project_bomref = first_bomref;
        last_bomref = last_project_bomref;
        stack = [first_bomref];
      }
      if (rline.includes(" - ") && !rline.startsWith("Project ':")) {
        profileName = rline.split(" - ")[0];
        if (profileName.toLowerCase().includes("test")) {
          scope = "optional";
        } else if (profileName.toLowerCase().includes("runtime")) {
          scope = "required";
        } else {
          scope = undefined;
        }
      }
      while ((match = depRegex.exec(rline))) {
        const [
          line,
          groupspecified,
          namespecified,
          versionspecified,
          groupoverride,
          nameoverride,
          versionoverride,
        ] = match;
        let group = groupoverride || groupspecified;
        let name = nameoverride || namespecified;
        let version = versionoverride || versionspecified;
        const level = line.split(groupspecified)[0].length / 5;
        if (version !== undefined || group === "project") {
          // Project line has no version
          // For multi sub-module projects such as :module:dummy:starter the regex is producing incorrect values
          if (rline.includes("project ")) {
            const tmpA = rline.split("project ");
            if (tmpA && tmpA.length > 1) {
              group = rootProject.group;
              name = tmpA[1].split(" ")[0];
              version = undefined;
            }
          }
          let purl;
          let bomRef;
          if (gradleModules.has(name)) {
            purl = gradleModules.get(name)["purl"];
            bomRef = gradleModules.get(name)["bom-ref"];
          } else {
            purl = new PackageURL(
              "maven",
              group !== "project" ? group : rootProject.group,
              name.replace(/^:/, ""),
              version !== undefined ? version : rootProject.version,
              { type: "jar" },
              null,
            ).toString();
            bomRef = decodeURIComponent(purl);
          }
          keys_cache[`${bomRef}_${last_bomref}`] = true;
          // Filter duplicates
          if (!deps_keys_cache[bomRef]) {
            deps_keys_cache[bomRef] = true;
            let adep;
            if (gradleModules.has(name)) {
              adep = gradleModules.get(name);
            } else {
              adep = {
                group: group !== "project" ? group : rootProject.group,
                name: name,
                version: version !== undefined ? version : rootProject.version,
                qualifiers: { type: "jar" },
              };
              adep["purl"] = purl;
              adep["bom-ref"] = bomRef;
              if (scope) {
                adep["scope"] = scope;
              }
              adep.properties = [];
              if (profileName) {
                adep.properties.push({
                  name: "GradleProfileName",
                  value: profileName,
                });
              }
              if (gradleRootPath && gradleRootPath !== ".") {
                adep.properties.push({
                  name: "cdx:gradle:GradleRootPath",
                  value: gradleRootPath,
                });
              }
            }
            if (adep?.properties?.length === 0) {
              delete adep.properties;
            }
            deps.push(adep);
          }
          if (!level_trees[bomRef]) {
            level_trees[bomRef] = [];
          }
          if (level === 0) {
            stack = [first_bomref];
            stack.push(bomRef);
          } else if (last_bomref === "") {
            stack.push(bomRef);
          } else if (level > last_level) {
            const cnodes = level_trees[last_bomref] || [];
            if (!cnodes.includes(bomRef)) {
              cnodes.push(bomRef);
            }
            level_trees[last_bomref] = cnodes;
            if (stack[stack.length - 1] !== bomRef) {
              stack.push(bomRef);
            }
          } else {
            for (let i = level; i <= last_level; i++) {
              stack.pop();
            }
            const last_stack =
              stack.length > 0 ? stack[stack.length - 1] : last_project_bomref;
            const cnodes = level_trees[last_stack] || [];
            if (!cnodes.includes(bomRef)) {
              cnodes.push(bomRef);
            }
            level_trees[last_stack] = cnodes;
            stack.push(bomRef);
          }
          last_level = level;
          last_bomref = bomRef;
        }
      }
    }
    for (const lk of Object.keys(level_trees)) {
      dependenciesList.push({
        ref: lk,
        dependsOn: [...new Set(level_trees[lk])].sort(),
      });
    }
    return {
      pkgList: deps,
      dependenciesList,
    };
  }
  return {};
}

/**
 * Parse clojure cli dependencies output
 * @param {string} rawOutput Raw string output
 */
export function parseCljDep(rawOutput) {
  if (typeof rawOutput === "string") {
    const deps = [];
    const keys_cache = {};
    const tmpA = rawOutput.split("\n");
    tmpA.forEach((l) => {
      l = l.trim();
      if (!l.startsWith("Downloading") || !l.startsWith("X ")) {
        if (l.startsWith(". ")) {
          l = l.replace(". ", "");
        }
        const tmpArr = l.split(" ");
        if (tmpArr.length === 2) {
          let group = dirname(tmpArr[0]);
          if (group === ".") {
            group = "";
          }
          const name = basename(tmpArr[0]);
          const version = tmpArr[1];
          const cacheKey = `${group}-${name}-${version}`;
          if (!keys_cache[cacheKey]) {
            keys_cache[cacheKey] = true;
            deps.push({
              group,
              name,
              version,
            });
          }
        }
      }
    });
    return deps;
  }
  return [];
}

/**
 * Parse lein dependency tree output
 * @param {string} rawOutput Raw string output
 */
export function parseLeinDep(rawOutput) {
  if (typeof rawOutput === "string") {
    const deps = [];
    const keys_cache = {};
    if (rawOutput.includes("{[") && !rawOutput.startsWith("{[")) {
      rawOutput = `{[${rawOutput.split("{[")[1]}`;
    }
    const ednData = parseEDNString(rawOutput);
    return parseLeinMap(ednData, keys_cache, deps);
  }
  return [];
}

export function parseLeinMap(node, keys_cache, deps) {
  if (node["map"]) {
    for (const n of node["map"]) {
      if (n.length === 2) {
        const rootNode = n[0];
        const psym = rootNode[0].sym;
        const version = rootNode[1];
        let group = dirname(psym);
        if (group === ".") {
          group = "";
        }
        const name = basename(psym);
        const cacheKey = `${group}-${name}-${version}`;
        if (!keys_cache[cacheKey]) {
          keys_cache[cacheKey] = true;
          deps.push({ group, name, version });
        }
        if (n[1]) {
          parseLeinMap(n[1], keys_cache, deps);
        }
      }
    }
  }
  return deps;
}

/**
 * Parse gradle projects output
 *
 * @param {string} rawOutput Raw string output
 */
export function parseGradleProjects(rawOutput) {
  let rootProject = "root";
  const projects = new Set();
  if (typeof rawOutput === "string") {
    const tmpA = rawOutput.split("\n");
    tmpA.forEach((l) => {
      l = l.replace("\r", "");
      if (l.startsWith("Root project ")) {
        rootProject = l
          .split("Root project ")[1]
          .split(" ")[0]
          .replace(/'/g, "");
      } else if (l.includes("--- Project")) {
        const tmpB = l.split("Project ");
        if (tmpB && tmpB.length > 1) {
          const projName = tmpB[1].split(" ")[0].replace(/'/g, "");
          // Include all projects including test projects
          if (projName.startsWith(":")) {
            // Handle the case where the project name could have a space. Eg: +--- project :app (*)
            const tmpName = projName.split(" ")[0];
            if (tmpName.length > 1) {
              projects.add(tmpName);
            }
          }
        }
      } else if (l.includes("--- project ")) {
        const tmpB = l.split("--- project ");
        if (tmpB && tmpB.length > 1) {
          const projName = tmpB[1];
          if (projName.startsWith(":")) {
            const tmpName = projName.split(" ")[0];
            if (tmpName.length > 1) {
              projects.add(tmpName);
            }
          }
        }
      } else if (l.includes("-> project ")) {
        const tmpB = l.split("-> project ");
        if (tmpB && tmpB.length > 1) {
          const projName = tmpB[1];
          if (projName.startsWith(":")) {
            const tmpName = projName.split(" ")[0];
            if (tmpName.length > 1) {
              projects.add(tmpName);
            }
          }
        }
      }
    });
  }
  return {
    rootProject,
    projects: Array.from(projects),
  };
}

/**
 * Parse gradle properties output
 *
 * @param {string} rawOutput Raw string output
 * @param {string} gradleModuleName The name (or 'path') of the module as seen from the root of the project
 */
export function parseGradleProperties(rawOutput, gradleModuleName = null) {
  let rootProject = "root";
  const projects = new Set();
  const metadata = { group: "", version: "latest", properties: [] };
  if (gradleModuleName) {
    metadata.properties.push({ name: "GradleModule", value: gradleModuleName });
  }
  if (typeof rawOutput === "string") {
    const tmpA = rawOutput.split("\n");
    tmpA.forEach((l) => {
      l = l.replace("\r", "");
      if (
        !gradleModuleName &&
        (l.startsWith("Root project '") || l.startsWith("Project '"))
      ) {
        metadata.properties.push({
          name: "GradleModule",
          value: l.split("'")[1],
        });
        return;
      }
      if (l.startsWith("----") || l.startsWith(">") || !l.includes(": ")) {
        return;
      }
      const tmpB = l.split(": ");
      if (tmpB && tmpB.length === 2) {
        if (tmpB[0] === "name") {
          rootProject = tmpB[1].trim();
        } else if (tmpB[0] === "group") {
          metadata[tmpB[0]] = tmpB[1];
        } else if (tmpB[0] === "version") {
          metadata[tmpB[0]] = tmpB[1].trim().replace("unspecified", "latest");
        } else if (["buildFile", "projectDir", "rootDir"].includes(tmpB[0])) {
          metadata.properties.push({ name: tmpB[0], value: tmpB[1].trim() });
        } else if (tmpB[0] === "subprojects") {
          const spStrs = tmpB[1].replace(/[[\]']/g, "").split(", ");
          const tmpprojects = spStrs
            .flatMap((s) => s.replace("project ", ""))
            .filter((s) => ![""].includes(s.trim()));
          tmpprojects.forEach(projects.add, projects);
        }
      }
    });
  }
  return {
    rootProject,
    projects: Array.from(projects),
    metadata,
  };
}

/**
 * Execute gradle properties command using multi-threading and return parsed output
 *
 * @param {string} dir Directory to execute the command
 * @param {array} allProjectsStr List of all sub-projects (including the preceding `:`)
 * @param {array} extraArgs List of extra arguments to use when calling gradle
 *
 * @returns {string} The combined output for all subprojects of the Gradle properties task
 */
export function executeParallelGradleProperties(
  dir,
  allProjectsStr,
  extraArgs = [],
) {
  const gradleCmd = getGradleCommand(dir, null);
  const gradleArgs = buildGradleCommandArguments(
    extraArgs.concat(
      process.env.GRADLE_ARGS ? process.env.GRADLE_ARGS.split(" ") : [],
    ),
    allProjectsStr.map((project) =>
      project ? `${project}:properties` : "properties",
    ),
    process.env.GRADLE_ARGS_PROPERTIES
      ? process.env.GRADLE_ARGS_PROPERTIES.split(" ")
      : [],
    gradleCmd.length,
  );
  const allOutputs = [];
  for (const gradleArg of gradleArgs) {
    if (DEBUG_MODE) {
      console.log(
        `Executing ${gradleCmd} with arguments ${gradleArg.join(" ").substring(0, 150)}... in ${dir}`,
      );
    }
    const result = safeSpawnSync(gradleCmd, gradleArg, {
      cwd: dir,
      shell: isWin,
    });
    if (result.status !== 0 || result.error) {
      if (process.env?.CDXGEN_IN_CONTAINER === "true") {
        thoughtLog(
          "Gradle build has failed. Perhaps the user is using the wrong container image?",
        );
      } else {
        thoughtLog(
          "Gradle build has failed. I recommend using Java container images.",
        );
      }
      if (result.stderr) {
        console.group("*** GRADLE BUILD ERRORS ***");
        console.error(result.stdout, result.stderr);
        console.groupEnd();
        console.log(
          "1. Check if the correct version of java and gradle are installed and available in PATH. For example, some project might require Java 11 with gradle 7.\n cdxgen container image bundles Java 23 with gradle 8 which might be incompatible.",
        );
        console.log(
          "2. Try running cdxgen with the custom JDK11-based image `ghcr.io/cyclonedx/cdxgen-java11:v12`.",
        );
        if (result.stderr?.includes("not get unknown property")) {
          console.log(
            "3. Check if the SBOM is generated for the correct root project for your application.",
          );
        } else if (
          result.stderr?.includes(
            "In version catalog libs, import of external catalog file failed",
          )
        ) {
          console.log(
            "3. Catalog file is required for gradle dependency resolution to succeed.",
          );
        } else if (result.stderr?.includes("Unrecognized option")) {
          console.log(
            "3. Try removing the unrecognized options to improve compatibility with a range of Java versions. Refer to the error message above.",
          );
        }
        if (result.stderr.includes("does not exist")) {
          return "";
        }
      }
    }
    if (result.stdout !== null) {
      allOutputs.push(result.stdout);
    }
  }
  const stdout = allOutputs.join("\n");
  if (stdout) {
    return Buffer.from(stdout).toString();
  }
  return "";
}

/**
 * Parse bazel action graph output
 * @param {string} rawOutput Raw string output
 */
export function parseBazelActionGraph(rawOutput) {
  const mavenPrefixRegex = /^@maven\/\/:(.*)\/(.*)\/(.*)\/(.*\.jar)$/g;

  if (typeof rawOutput === "string") {
    const deps = [];
    const keys_cache = {};
    const tmpA = rawOutput.split("\n");
    tmpA.forEach((l) => {
      l = l.replace("\r", "");
      if (l.trim().startsWith("@maven//:")) {
        const matches = Array.from(l.matchAll(mavenPrefixRegex));

        if (matches[0]?.[1]) {
          const group = matches[0][1].split("/").join(".");
          const name = matches[0][2];
          const version = matches[0][3];

          const key = `${group}:${name}:${version}`;

          if (!keys_cache[key]) {
            keys_cache[key] = true;
            deps.push({
              group,
              name,
              version,
              qualifiers: { type: "jar" },
            });
          }
        }
      }
    });
    return deps;
  }
  return [];
}

/**
 * Parse bazel skyframe state output
 * @param {string} rawOutput Raw string output
 */
export function parseBazelSkyframe(rawOutput) {
  if (typeof rawOutput === "string") {
    const deps = [];
    const keys_cache = {};
    const tmpA = rawOutput.split("\n");
    tmpA.forEach((l) => {
      l = l.replace("\r", "");
      if (l.indexOf("external/maven") >= 0) {
        l = l.replace("arguments: ", "").replace(/"/g, "");
        // Skyframe could have duplicate entries
        if (l.includes("@@maven//")) {
          l = l.split(",")[0];
        }
        const mparts = l.split("external/maven/v1/");
        if (mparts?.[mparts.length - 1].endsWith(".jar")) {
          // Example
          // https/jcenter.bintray.com/com/google/guava/failureaccess/1.0.1/failureaccess-1.0.1.jar
          // https/repo1.maven.org/maven2/org/simpleflatmapper/sfm-util/8.2.2/header_sfmutil-8.2.2.jar
          const jarPath = mparts[mparts.length - 1];
          let jarPathParts = jarPath.split("/");
          if (jarPathParts.length) {
            // Remove the protocol, registry url and then file name
            let prefix_slice_count = 2;
            // Bug: #169
            const prefix = process.env.BAZEL_STRIP_MAVEN_PREFIX || "/maven2/";
            if (l.includes(prefix)) {
              prefix_slice_count = prefix.split("/").length;
            }
            jarPathParts = jarPathParts.slice(prefix_slice_count, -1);
            // The last part would be the version
            const version = jarPathParts[jarPathParts.length - 1];
            // Last but one would be the name
            const name = jarPathParts[jarPathParts.length - 2].toLowerCase();
            // Rest would be the group
            const group = jarPathParts.slice(0, -2).join(".").toLowerCase();
            const key = `${group}:${name}:${version}`;
            if (!keys_cache[key]) {
              keys_cache[key] = true;
              deps.push({
                group,
                name,
                version,
                qualifiers: { type: "jar" },
              });
            }
          }
        }
      }
    });
    return deps;
  }
  return [];
}

/**
 * Parse bazel BUILD file
 * @param {string} rawOutput Raw string output
 */
export function parseBazelBuild(rawOutput) {
  if (typeof rawOutput === "string") {
    const projs = [];
    const tmpA = rawOutput.split("\n");
    tmpA.forEach((l) => {
      if (l.includes("name =")) {
        const name = l.split("name =")[1].replace(/[",]/g, "").trim();
        if (!name.includes("test")) {
          projs.push(name);
        }
      }
    });
    return projs;
  }
  return [];
}

/**
 * Parse dependencies in Key:Value format
 */
export function parseKVDep(rawOutput) {
  if (typeof rawOutput === "string") {
    const deps = [];
    rawOutput.split("\n").forEach((l) => {
      l = l.replace("\r", "");
      const tmpA = l.split(":");
      let group = "";
      let name = "";
      let version = "";
      if (tmpA.length === 3) {
        group = tmpA[0];
        name = tmpA[1];
        version = tmpA[2];
      } else if (tmpA.length === 2) {
        name = tmpA[0];
        version = tmpA[1];
      }
      const purlString = new PackageURL(
        "maven",
        group,
        name,
        version,
        { type: "jar" },
        null,
      ).toString();
      deps.push({
        group,
        name,
        version,
        purl: purlString,
        "bom-ref": decodeURIComponent(purlString),
      });
    });
    return deps;
  }
  return [];
}

/**
 * Method to find the spdx license id from name
 *
 * @param {string} name License full name
 */
export function findLicenseId(name) {
  if (!name) {
    return undefined;
  }
  for (const l of licenseMapping) {
    if (l.names.includes(name) || l.exp.toUpperCase() === name.toUpperCase()) {
      return l.exp;
    }
  }
  return name && (name.includes("\n") || name.length > MAX_LICENSE_ID_LENGTH)
    ? guessLicenseId(name)
    : name;
}

/**
 * Method to guess the spdx license id from license contents
 *
 * @param {string} content License file contents
 */
export function guessLicenseId(content) {
  content = content.replace(/\n/g, " ");
  for (const l of licenseMapping) {
    for (const j in l.names) {
      if (content.toUpperCase().indexOf(l.names[j].toUpperCase()) > -1) {
        return l.exp;
      }
    }
  }
  return undefined;
}

/**
 * Method to retrieve metadata for maven packages by querying maven central
 *
 * @param {Array} pkgList Package list
 * @param {Object} jarNSMapping Jar Namespace mapping object
 * @param {Boolean} force Force fetching of license
 *
 * @returns {Array} Updated package list
 */
export async function getMvnMetadata(
  pkgList,
  jarNSMapping = {},
  force = false,
) {
  const MAVEN_CENTRAL_URL =
    process.env.MAVEN_CENTRAL_URL || "https://repo1.maven.org/maven2/";
  const ANDROID_MAVEN_URL =
    process.env.ANDROID_MAVEN_URL || "https://maven.google.com/";
  const cdepList = [];
  if (!pkgList || !pkgList.length) {
    return pkgList;
  }
  if (DEBUG_MODE && shouldFetchLicense()) {
    console.log(`About to query maven for ${pkgList.length} packages`);
  }
  for (const p of pkgList) {
    // Reuse any namespace and hashes data from jarNSMapping
    if (jarNSMapping && p.purl && jarNSMapping[p.purl]) {
      if (jarNSMapping[p.purl].jarFile) {
        p.evidence = {
          identity: {
            field: "purl",
            confidence: 0.8,
            methods: [
              {
                technique: "binary-analysis",
                confidence: 0.8,
                value: jarNSMapping[p.purl].jarFile,
              },
            ],
          },
        };
      }
      if (jarNSMapping[p.purl].hashes && !p?.hashes?.length) {
        p.hashes = jarNSMapping[p.purl].hashes;
      }
      if (
        jarNSMapping[p.purl].namespaces &&
        jarNSMapping[p.purl].namespaces.length
      ) {
        if (!p.properties) {
          p.properties = [];
        }
        p.properties.push({
          name: "Namespaces",
          value: jarNSMapping[p.purl].namespaces.join("\n"),
        });
      }
    }
    const group = p.group || "";
    // If the package already has key metadata skip querying maven
    if (
      !p.version ||
      (group && p.name && p.version && !shouldFetchLicense() && !force)
    ) {
      cdepList.push(p);
      continue;
    }
    let urlPrefix = MAVEN_CENTRAL_URL;
    // Ideally we should try one resolver after the other. But it increases the time taken
    if (group.indexOf("android") !== -1) {
      urlPrefix = ANDROID_MAVEN_URL;
    }
    // Querying maven requires a valid group name
    if (!group || group === "") {
      cdepList.push(p);
      continue;
    }
    const pomMetadata = {
      urlPrefix: urlPrefix,
      group: group,
      name: p.name,
      version: p.version,
    };
    try {
      if (DEBUG_MODE) {
        console.log(
          `Querying ${pomMetadata.urlPrefix} for '${group}/${p.name}@${p.version}' ${composePomXmlUrl(
            pomMetadata,
          )}`,
        );
      }
      const bodyJson = await fetchPomXmlAsJson(pomMetadata);
      if (bodyJson) {
        p.publisher = bodyJson?.organization?.name
          ? bodyJson?.organization.name._
          : "";
        p.description = bodyJson?.description
          ? bodyJson.description._.replace(/[ \t]+/g, " ")
              .replace(/^[ \t]+|[ \t]+$/gm, "")
              .replace(/\n\s*\n/g, "\n")
              .trim()
          : "";
        if (bodyJson?.scm?.url) {
          p.repository = { url: bodyJson.scm.url._ };
        }
        p.license =
          parseLicenseEntryOrArrayFromPomXml(bodyJson?.licenses?.license) ||
          (await extractLicenseCommentFromPomXml(pomMetadata)) ||
          (await getRepoLicense(p.repository?.url, undefined));
      }
    } catch (err) {
      if (DEBUG_MODE) {
        console.log(
          `An error occurred when trying to fetch metadata ${pomMetadata}`,
          err,
        );
      }
    } finally {
      cdepList.push(p);
    }
  }
  return cdepList;
}

/**
 * Method to compose URL of pom.xml
 *
 * @param {String} urlPrefix
 * @param {String} group
 * @param {String} name
 * @param {String} version
 *
 * @return {String} fullUrl
 */
export function composePomXmlUrl({ urlPrefix, group, name, version }) {
  const groupPart = group.replace(/\./g, "/");
  return `${urlPrefix + groupPart}/${name}/${version}/${name}-${version}.pom`;
}

/**
 * Method to fetch pom.xml data and parse it to JSON
 *
 * @param {String} urlPrefix
 * @param {String} group
 * @param {String} name
 * @param {String} version
 *
 * @return {Object|undefined}
 */
export async function fetchPomXmlAsJson({ urlPrefix, group, name, version }) {
  const pomXml = await fetchPomXml({ urlPrefix, group, name, version });
  if (!pomXml) {
    return undefined;
  }
  const options = {
    compact: true,
    spaces: 4,
    textKey: "_",
    attributesKey: "$",
    commentKey: "value",
  };
  const pomJson = xml2js(pomXml, options).project;
  if (pomJson?.parent) {
    const parentXml = await fetchPomXml({
      urlPrefix,
      group: pomJson.parent.groupId?._,
      name: pomJson.parent.artifactId?._,
      version: pomJson.parent.version?._,
    });
    if (!parentXml) {
      return undefined;
    }
    const parentJson = xml2js(parentXml, options).project;
    return { ...parentJson, ...pomJson };
  }
  return pomJson;
}

/**
 * Method to fetch pom.xml data
 *
 * @param {String} urlPrefix
 * @param {String} group
 * @param {String} name
 * @param {String} version
 *
 * @return {Promise<String>}
 */
export async function fetchPomXml({ urlPrefix, group, name, version }) {
  const fullUrl = composePomXmlUrl({ urlPrefix, group, name, version });
  try {
    const res = await cdxgenAgent.get(fullUrl);
    return res.body;
  } catch (_err) {
    return undefined;
  }
}

/**
 * Method extract single or multiple license entries that might appear in pom.xml
 *
 * @param {Object|Array} license
 */
export function parseLicenseEntryOrArrayFromPomXml(license) {
  if (!license) return;
  if (Array.isArray(license)) {
    return license.map((l) => {
      return findLicenseId(l.name?._);
    });
  }
  if (Object.keys(license).length) {
    return [findLicenseId(license.name?._)];
  }
}

/**
 * Method to parse pom.xml in search of a comment containing license text
 *
 * @param {String} urlPrefix
 * @param {String} group
 * @param {String} name
 * @param {String} version
 *
 * @return {Promise<String>} License ID
 */
export async function extractLicenseCommentFromPomXml({
  urlPrefix,
  group,
  name,
  version,
}) {
  const pom_xml = await fetchPomXml({ urlPrefix, group, name, version });
  const licenseRegex = /<!--([\s\S]*?)-->[\s\n]*<project/m;
  const match = licenseRegex.exec(pom_xml);
  if (match?.[1]) {
    return findLicenseId(match[1].trim());
  }
}

/**
 * Method to parse python requires_dist attribute found in pypi setup.py
 *
 * @param {String} dist_string string
 */
export function parsePyRequiresDist(dist_string) {
  if (!dist_string) {
    return undefined;
  }
  const tmpA = dist_string.split(" ");
  let name = "";
  let version = "";
  if (!tmpA) {
    return undefined;
  }
  if (tmpA.length === 1) {
    name = tmpA[0];
  } else if (tmpA.length > 1) {
    name = tmpA[0];
    const tmpVersion = tmpA[1];
    version = tmpVersion.split(",")[0].replace(/[();=&glt><]/g, "");
  }
  return {
    name,
    version,
  };
}

/**
 * Method to mimic pip version solver using node-semver
 *
 * @param {Array} versionsList List of version numbers available
 * @param {*} versionSpecifiers pip version specifier
 */
export function guessPypiMatchingVersion(versionsList, versionSpecifiers) {
  versionSpecifiers = versionSpecifiers.replace(/,/g, " ").split(";")[0];
  const comparator = (a, b) => {
    if (!a && !b) {
      return 0;
    }
    if (!a || !coerce(a, { loose: true })) {
      return -1;
    }
    let c = coerce(a, { loose: true }).compare(coerce(b, { loose: true }));
    // if coerced versions are "equal", compare them as strings
    if (c === 0) {
      c = a < b ? -1 : 1;
    }
    return -c;
  };
  // Iterate in the "reverse" order
  for (const rv of versionsList.sort(comparator)) {
    if (satisfies(coerce(rv, { loose: true }), versionSpecifiers, true)) {
      return rv;
    }
  }
  // Let's try to clean and have another go
  return maxSatisfying(versionsList, clean(versionSpecifiers, { loose: true }));
}

/**
 * Method to retrieve metadata for python packages by querying pypi
 *
 * @param {Array} pkgList Package list
 * @param {Boolean} fetchDepsInfo Fetch dependencies info from pypi
 */
export async function getPyMetadata(pkgList, fetchDepsInfo) {
  if (!shouldFetchLicense() && !fetchDepsInfo) {
    return pkgList;
  }
  const PYPI_URL = process.env.PYPI_URL || "https://pypi.org/pypi/";
  const cdepList = [];
  for (const p of pkgList) {
    if (!p || !p.name) {
      continue;
    }
    try {
      // If the package name has a url or already includes license and version skip it
      if (p.name.includes("https") || (p.license && p.version)) {
        cdepList.push(p);
        continue;
      }
      const origName = p.name;
      // Some packages support extra modules
      if (p.name.includes("[")) {
        p.name = p.name.split("[")[0];
      }
      let res;
      let url_addition;
      if (p.version?.trim().length) {
        url_addition = `${p.name}/${p.version.trim()}/json`;
      } else {
        url_addition = `${p.name}/json`;
      }
      try {
        res = await cdxgenAgent.get(`${PYPI_URL + url_addition}`, {
          responseType: "json",
        });
      } catch (_err) {
        // retry by prefixing django- to the package name
        res = await cdxgenAgent.get(`${PYPI_URL}django-${url_addition}`, {
          responseType: "json",
        });
        p.name = `django-${p.name}`;
      }
      const body = res.body;
      if (body.info.author && body.info.author.trim() !== "") {
        if (body.info.author_email && body.info.author_email.trim() !== "") {
          p.author = `${body.info.author.trim()} <${body.info.author_email.trim()}>`;
        } else {
          p.author = body.info.author.trim();
        }
      } else if (
        body.info.author_email &&
        body.info.author_email.trim() !== ""
      ) {
        p.author = body.info.author_email.trim();
      }
      if (
        p.name !== body.info?.name &&
        p.name.toLowerCase() === body.info?.name.toLowerCase()
      ) {
        p.name = body.info.name;
      }
      p.description = body.info.summary;
      p.license = [];
      if (body.info.classifiers) {
        for (const c of body.info.classifiers) {
          if (c.startsWith("License :: ")) {
            const licenseName = c.split("::").slice(-1)[0].trim();
            const licenseId = findLicenseId(licenseName);
            if (licenseId && !p.license.includes(licenseId)) {
              p.license.push(licenseId);
            }
          }
        }
      }
      if (body.info.license) {
        const licenseId = findLicenseId(body.info.license);
        if (licenseId && !p.license.includes(licenseId)) {
          p.license.push(licenseId);
        }
      }
      if (body.info.license_expression) {
        const licenseId = findLicenseId(body.info.license_expression);
        if (licenseId && !p.license.includes(licenseId)) {
          p.license.push(licenseId);
        }
      }
      if (body.info.home_page) {
        if (body.info.home_page.includes("git")) {
          p.repository = { url: body.info.home_page };
        } else {
          p.homepage = { url: body.info.home_page };
        }
      }
      // Use the latest version if none specified
      if (!p.version || !p.version.trim().length) {
        let versionSpecifiers;
        if (p.properties?.length) {
          for (const pprop of p.properties) {
            if (pprop.name === "cdx:pypi:versionSpecifiers") {
              versionSpecifiers = pprop.value;
              break;
            }
          }
        } else if (
          p.version &&
          (p.version.includes("*") ||
            p.version.includes("<") ||
            p.version.includes(">") ||
            p.version.includes("!"))
        ) {
          versionSpecifiers = p.version;
        }
        if (versionSpecifiers) {
          p.version = guessPypiMatchingVersion(
            Object.keys(body.releases || {}),
            versionSpecifiers,
          );
          // Indicate the confidence with our guess
          p.evidence = {
            identity: {
              field: "version",
              confidence: 0.6,
              methods: [
                {
                  technique: "manifest-analysis",
                  confidence: 0.6,
                  value: `Version specifiers: ${versionSpecifiers}`,
                },
              ],
            },
          };
        }
        // If we have reached here, it means we have not solved the version
        // So assume latest
        if (!p.version) {
          p.version = body.info.version;
          // Indicate the low confidence
          p.evidence = {
            identity: {
              field: "version",
              confidence: 0.5,
              methods: [
                {
                  technique: "source-code-analysis",
                  confidence: 0.5,
                  value: `PyPI package: ${p.name}`,
                },
              ],
            },
          };
        }
      } else if (p.version !== body.info.version) {
        if (!p.properties) {
          p.properties = [];
        }
        p.properties.push({
          name: "cdx:pypi:latest_version",
          value: body.info.version,
        });
        p.properties.push({
          name: "cdx:pypi:resolved_from",
          value: origName,
        });
      }
      if (body.releases?.[p.version] && body.releases[p.version].length) {
        const digest = body.releases[p.version][0].digests;
        if (digest["sha256"]) {
          p._integrity = `sha256-${digest["sha256"]}`;
        } else if (digest["md5"]) {
          p._integrity = `md5-${digest["md5"]}`;
        }
      }
      const purlString = new PackageURL(
        "pypi",
        "",
        p.name.toLowerCase(),
        p.version,
        null,
        null,
      ).toString();
      p.purl = purlString;
      p["bom-ref"] = decodeURIComponent(purlString);
      cdepList.push(p);
    } catch (_err) {
      if (DEBUG_MODE) {
        console.error(p.name, "is not found on PyPI.");
        console.log(
          "If this package is available from PyPI or a registry, its name might be different from the module name. Raise a ticket at https://github.com/cdxgen/cdxgen/issues so that this can be added to the mapping file pypi-pkg-aliases.json",
        );
        console.log(
          "Alternatively, if this is a package that gets installed directly in your environment and offers a python binding, then track such packages manually.",
        );
      }
      if (!p.version) {
        if (DEBUG_MODE) {
          console.log(
            `Assuming the version as latest for the package ${p.name}`,
          );
        }
        p.version = "latest";
        // Indicate the low confidence
        p.evidence = {
          identity: {
            field: "version",
            confidence: 0,
            methods: [
              {
                technique: "source-code-analysis",
                confidence: 0,
                value: `Module ${p.name}`,
              },
            ],
          },
        };
      }
      const purlString = new PackageURL(
        "pypi",
        "",
        p.name.toLowerCase(),
        p.version,
        null,
        null,
      ).toString();
      p.purl = purlString;
      p["bom-ref"] = decodeURIComponent(purlString);
      cdepList.push(p);
    }
  }
  return cdepList;
}

/**
 * Method to parse bdist_wheel metadata
 *
 * @param {Object} mData bdist_wheel metadata
 */
export function parseBdistMetadata(mData) {
  const pkg = {};
  mData.split("\n").forEach((l) => {
    l = l.replace("\r", "");
    if (l.indexOf("Name: ") > -1) {
      pkg.name = l.split("Name: ")[1];
    } else if (l.indexOf("Version: ") > -1) {
      pkg.version = l.split("Version: ")[1];
    } else if (l.indexOf("Summary: ") > -1) {
      pkg.description = l.split("Summary: ")[1];
    } else if (l.indexOf("Home-page: ") > -1) {
      pkg.homepage = { url: l.split("Home-page: ")[1] };
    } else if (l.indexOf("Project-URL: Source Code, ") > -1) {
      pkg.repository = { url: l.split("Project-URL: Source Code, ")[1] };
    } else if (l.indexOf("Author: ") > -1) {
      pkg.publisher = l.split("Author: ")[1];
    }
  });
  return [pkg];
}

/**
 * Method to parse pipfile.lock data
 *
 * @param {Object} lockData JSON data from Pipfile.lock
 */
export async function parsePiplockData(lockData) {
  const pkgList = [];
  Object.keys(lockData)
    .filter((i) => i !== "_meta")
    .forEach((k) => {
      const depBlock = lockData[k];
      Object.keys(depBlock).forEach((p) => {
        const pkg = depBlock[p];
        if (Object.hasOwn(pkg, "version")) {
          const versionStr = pkg.version.replace("==", "");
          pkgList.push({ name: p, version: versionStr });
        }
      });
    });
  return await getPyMetadata(pkgList, false);
}

/**
 * Method to parse python pyproject.toml file
 *
 * @param {string} tomlFile pyproject.toml file
 * @returns {Object} Object with parent component, root dependencies, and metadata.
 */
export function parsePyProjectTomlFile(tomlFile) {
  function handleBlock(pkg, atool) {
    for (const k of ["name", "version", "description", "license"]) {
      // We can copy string values as-is
      if (
        !pkg[k] &&
        atool[k] &&
        (typeof atool[k] === "string" || atool[k] instanceof String)
      ) {
        pkg[k] = atool[k];
      }
    }
    if (atool.authors) {
      if (Array.isArray(atool.authors) && atool.authors.length > 0) {
        // Multiple author objects
        if (
          Object.keys(atool.authors[0]).length &&
          (atool.authors[0]?.name || atool.authors[0]?.email)
        ) {
          pkg.authors = atool.authors;
        } else {
          pkg.author = atool.authors.join(", ");
        }
      } else if (
        typeof atool.authors === "string" ||
        atool.authors instanceof String
      ) {
        pkg.author = atool.authors.trim();
      }
    }
    if (atool.homepage) {
      pkg.homepage = { url: atool.homepage };
    }
    if (atool.repository) {
      pkg.repository = { url: atool.repository };
    }
    if (atool.keywords && Array.isArray(atool.keywords)) {
      pkg.tags = atool.keywords.sort();
    }
    if (atool["requires-python"]) {
      pkg.properties = [
        { name: "cdx:pypi:requiresPython", value: atool["requires-python"] },
      ];
    }
  }

  let poetryMode = false;
  let uvMode = false;
  let hatchMode = false;
  const workspacePaths = [];
  let tomlData;
  const directDepsKeys = {};
  const groupDepsKeys = {};
  try {
    tomlData = toml.parse(readFileSync(tomlFile, { encoding: "utf-8" }));
  } catch (err) {
    console.log(`Error while parsing the pyproject file ${tomlFile}.`, err);
  }
  const pkg = {};
  if (!tomlData) {
    return {};
  }
  if (
    tomlData?.tool?.poetry ||
    tomlData?.["build-system"]?.["build-backend"]?.startsWith("poetry.core")
  ) {
    poetryMode = true;
  }
  if (tomlData?.tool?.uv) {
    uvMode = true;
  }
  if (tomlData?.["build-system"]?.["build-backend"]?.startsWith("hatchling.")) {
    hatchMode = true;
  }
  if (
    uvMode &&
    tomlData.tool.uv.workspace &&
    Array.isArray(tomlData.tool.uv.workspace?.members)
  ) {
    for (const amember of tomlData.tool.uv.workspace.members) {
      const memberPyProjPaths = amember.endsWith("/*")
        ? amember.replace(/\/\*$/, "/**/pyproject.toml")
        : `${amember}/**/pyproject.toml`;
      workspacePaths.push(memberPyProjPaths);
    }
  }
  // uv and others
  if (tomlData?.project && Object.keys(tomlData.project).length) {
    handleBlock(pkg, tomlData.project);
  }
  if (tomlData?.tool && Object.keys(tomlData.tool).length) {
    for (const atoolKey of Object.keys(tomlData.tool)) {
      const atool = tomlData.tool[atoolKey];
      handleBlock(pkg, atool);
    }
  }
  if (pkg.name) {
    pkg.type = "application";
    const ppurl = new PackageURL(
      "pypi",
      pkg.group || "",
      pkg.name,
      pkg.version || "latest",
      null,
      null,
    ).toString();
    pkg["bom-ref"] = decodeURIComponent(ppurl);
    pkg["purl"] = ppurl;
    pkg.evidence = {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: tomlFile,
          },
        ],
      },
    };
  }
  if (tomlData?.project?.dependencies) {
    for (const adep of tomlData.project.dependencies) {
      // Example: bcrypt>=4.2.0
      directDepsKeys[adep.split(/[\s<>=]/)[0]] = true;
    }
  }
  if (tomlData["dependency-groups"]) {
    for (const agroup of Object.keys(tomlData["dependency-groups"])) {
      tomlData["dependency-groups"][agroup].forEach((p) => {
        const pname = p.split(/(==|<=|~=|>=)/)[0].split(" ")[0];
        if (!groupDepsKeys[pname]) {
          groupDepsKeys[pname] = [];
        }
        groupDepsKeys[pname].push(agroup);
      });
    }
  }
  if (tomlData?.tool?.poetry?.dependencies) {
    for (const adep of Object.keys(tomlData?.tool?.poetry?.dependencies)) {
      if (
        ![
          "python",
          "py",
          "pytest",
          "pylint",
          "ruff",
          "setuptools",
          "bandit",
        ].includes(adep)
      ) {
        directDepsKeys[adep] = true;
      }
    } // for
    if (tomlData?.tool?.poetry?.group) {
      for (const agroup of Object.keys(tomlData.tool.poetry.group)) {
        for (const adep of Object.keys(
          tomlData.tool.poetry.group[agroup]?.dependencies,
        )) {
          if (!groupDepsKeys[adep]) {
            groupDepsKeys[adep] = [];
          }
          groupDepsKeys[adep].push(agroup);
        }
      } // for
    }
  }
  return {
    parentComponent: pkg,
    poetryMode,
    uvMode,
    hatchMode,
    workspacePaths,
    directDepsKeys,
    groupDepsKeys,
  };
}

/**
 * Method to parse python lock files such as poetry.lock, pdm.lock, uv.lock.
 *
 * @param {Object} lockData JSON data from poetry.lock, pdm.lock, or uv.lock file
 * @param {string} lockFile Lock file name for evidence
 * @param {string} pyProjectFile pyproject.toml file
 */
export async function parsePyLockData(lockData, lockFile, pyProjectFile) {
  let pkgList = [];
  const rootList = [];
  const dependenciesList = [];
  const depsMap = {};
  const existingPkgMap = {};
  const pkgBomRefMap = {};
  let directDepsKeys = {};
  let groupDepsKeys = {};
  let parentComponent;
  let workspacePaths;
  let workspaceWarningShown = false;
  let hasWorkspaces = false;
  // Keep track of any workspace components to be added to the parent component
  const workspaceComponentMap = {};
  const workspacePyProjMap = {};
  const workspaceRefPyProjMap = {};
  const pkgParentMap = {};
  if (!lockData) {
    return { pkgList, dependenciesList };
  }
  if (!pyProjectFile && lockFile) {
    // See if there is a pyproject.toml in the same directory
    pyProjectFile = join(dirname(lockFile), "pyproject.toml");
  }
  if (pyProjectFile && safeExistsSync(pyProjectFile)) {
    if (DEBUG_MODE) {
      console.log(
        `Parsing ${pyProjectFile} for dependencies and groups information.`,
      );
    }
    const pyProjMap = parsePyProjectTomlFile(pyProjectFile);
    directDepsKeys = pyProjMap.directDepsKeys || {};
    groupDepsKeys = pyProjMap.groupDepsKeys || {};
    parentComponent = pyProjMap.parentComponent;
    workspacePaths = pyProjMap.workspacePaths;
    if (workspacePaths?.length) {
      if (!hasWorkspaces) {
        hasWorkspaces = true;
      }
      // Parent component is going to have children
      parentComponent.components = [];
      for (const awpath of workspacePaths) {
        const wpyprojfiles = getAllFiles(dirname(lockFile), awpath);
        if (!wpyprojfiles?.length) {
          if (!workspaceWarningShown) {
            console.log(
              `Unable to collect pyproject.toml files for the workspace pattern ${awpath}. Ensure cdxgen is run from the root directory containing the application source code.`,
            );
            console.log(
              "The dependency tree in the generated SBOM will be flattened and therefore incorrect.",
            );
            workspaceWarningShown = true;
          }
          continue;
        }
        for (const awpyproj of wpyprojfiles) {
          if (DEBUG_MODE) {
            console.log(
              `Parsing workspace ${awpyproj} to improve the dependency tree.`,
            );
          }
          // Nested workspace is not supported
          const wcompMap = parsePyProjectTomlFile(awpyproj);
          if (wcompMap?.parentComponent) {
            wcompMap.parentComponent.properties =
              wcompMap.parentComponent.properties || [];
            wcompMap.parentComponent.properties.push({
              name: "internal:is_workspace",
              value: "true",
            });
            wcompMap.parentComponent.properties.push({
              name: "SrcFile",
              value: awpyproj,
            });
            wcompMap.parentComponent.properties.push({
              name: "internal:virtual_path",
              value: relative(dirname(lockFile), dirname(awpyproj)),
            });
            workspaceComponentMap[wcompMap.parentComponent.name] =
              wcompMap.parentComponent;
            workspacePyProjMap[wcompMap.parentComponent.name] = awpyproj;
            if (wcompMap.parentComponent["bom-ref"]) {
              workspaceRefPyProjMap[wcompMap.parentComponent["bom-ref"]] =
                awpyproj;
            }
            // uv.lock auto normalizes names containing underscores
            if (wcompMap.parentComponent.name.includes("_")) {
              workspaceComponentMap[
                wcompMap.parentComponent.name.replaceAll("_", "-")
              ] = wcompMap.parentComponent;
              workspacePyProjMap[
                wcompMap.parentComponent.name.replaceAll("_", "-")
              ] = awpyproj;
            }
          }
          const wparentComponentRef = wcompMap.parentComponent["bom-ref"];
          // Track the parents of workspace direct dependencies
          if (wcompMap?.directDepsKeys) {
            for (const wdd of Object.keys(wcompMap?.directDepsKeys)) {
              if (!pkgParentMap[wdd]) {
                pkgParentMap[wdd] = [];
              }
              pkgParentMap[wdd].push(wparentComponentRef);
            }
          }
        }
      }
    }
  }
  let lockTomlObj;
  try {
    lockTomlObj = toml.parse(lockData);
  } catch (err) {
    if (lockFile) {
      console.log(`Error while parsing the lock file ${lockFile}.`, err);
    } else {
      console.log("Error while parsing the lock data as toml", err);
    }
  }
  // Check for workspaces
  if (lockTomlObj?.manifest?.members) {
    const workspaceMembers = lockTomlObj.manifest.members;
    if (workspaceMembers && !hasWorkspaces) {
      hasWorkspaces = true;
    }
    for (const amember of workspaceMembers) {
      if (amember === parentComponent.name) {
        continue;
      }
      if (workspaceComponentMap[amember]) {
        parentComponent.components.push(workspaceComponentMap[amember]);
      } else {
        if (!workspaceWarningShown) {
          console.log(
            `Unable to identify the metadata for the workspace ${amember}. Check if the path specified in ${workspacePyProjMap[amember] || pyProjectFile} is valid.`,
          );
        }
      }
    }
  }
  for (const apkg of lockTomlObj.package || []) {
    // This avoids validation errors with uv.lock
    if (parentComponent?.name && parentComponent.name === apkg.name) {
      continue;
    }
    const pkg = {
      name: apkg.name,
      version: apkg.version,
      description: apkg.description || "",
      properties: [],
    };
    if (pyProjectFile || workspacePyProjMap[apkg.name]) {
      pkg.properties.push({
        name: "SrcFile",
        value: workspacePyProjMap[apkg.name] || pyProjectFile,
      });
    }
    if (apkg.optional) {
      pkg.scope = "optional";
    }
    if (apkg["python-versions"]) {
      pkg.properties.push({
        name: "cdx:pypi:requiresPython",
        value: apkg["python-versions"],
      });
    }
    if (apkg?.source) {
      if (
        apkg.source.registry &&
        !apkg?.source?.registry?.startsWith("https://pypi.org/")
      ) {
        pkg.properties.push({
          name: "cdx:pypi:registry",
          value: apkg.source.registry,
        });
      }
      if (apkg?.source?.virtual) {
        pkg.properties.push({
          name: "internal:virtual_path",
          value: workspacePyProjMap[apkg.name] || apkg.source.virtual,
        });
      }
      if (apkg?.source?.editable) {
        pkg.properties.push({
          name: "internal:virtual_path",
          value: apkg.source.editable,
        });
      }
    }
    // Is this component a module?
    if (workspaceComponentMap[pkg.name]) {
      pkg.properties.push({
        name: "internal:is_workspace",
        value: "true",
      });
      pkg.type = "application";
    }
    const purlString = new PackageURL(
      "pypi",
      "",
      pkg.name,
      pkg.version,
      null,
      null,
    ).toString();
    pkg.purl = purlString;
    pkg["bom-ref"] = decodeURIComponent(purlString);
    pkg.evidence = {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: lockFile,
          },
        ],
      },
    };
    if (groupDepsKeys?.[pkg.name]) {
      pkg.scope = "optional";
      pkg.properties = pkg.properties.concat(
        groupDepsKeys[pkg.name].map((g) => {
          return { name: "cdx:pyproject:group", value: g };
        }),
      );
    }
    // Track the workspace purls that had an explicit dependency on this package
    if (pkgParentMap[pkg.name]) {
      for (const workspaceRef of pkgParentMap[pkg.name]) {
        pkg.properties.push({
          name: "internal:workspaceRef",
          value: workspaceRef,
        });
        if (workspaceRefPyProjMap[workspaceRef]) {
          pkg.properties.push({
            name: "internal:workspaceSrcFile",
            value: workspaceRefPyProjMap[workspaceRef],
          });
        }
      }
    }
    if (lockTomlObj?.metadata?.files?.[pkg.name]?.length) {
      pkg.components = [];
      for (const afileObj of lockTomlObj.metadata.files[pkg.name]) {
        const hashParts = afileObj?.hash?.split(":");
        let hashes;
        if (hashParts?.length === 2) {
          const alg = hashParts[0].replace("sha", "SHA-");
          hashes = [{ alg, content: hashParts[1] }];
        }
        pkg.components.push({
          type: "file",
          name: afileObj.file,
          hashes,
          evidence: {
            identity: {
              field: "name",
              confidence: 1,
              methods: [
                {
                  technique: "manifest-analysis",
                  confidence: 1,
                  value: lockFile,
                },
              ],
            },
          },
          properties: [{ name: "SrcFile", value: lockFile }],
        });
      }
    }
    if (
      directDepsKeys[pkg.name] ||
      (hasWorkspaces && !Object.keys(workspaceComponentMap).length)
    ) {
      rootList.push(pkg);
    }
    // This would help the lookup
    existingPkgMap[pkg.name.toLowerCase()] = pkg["bom-ref"];
    pkgBomRefMap[pkg["bom-ref"]] = pkg;
    // Do not repeat workspace components again under components
    // This will reduce false positives, when a downstream tool attempts to analyze all components
    if (pkg.type !== "application") {
      pkgList.push(pkg);
    }
    if (!depsMap[pkg["bom-ref"]]) {
      depsMap[pkg["bom-ref"]] = new Set();
    }
    // Track the workspace tree
    if (pkgParentMap[pkg.name]) {
      for (const pkgParentRef of pkgParentMap[pkg.name]) {
        if (!depsMap[pkgParentRef]) {
          depsMap[pkgParentRef] = new Set();
        }
        depsMap[pkgParentRef].add(pkg["bom-ref"]);
      }
    }
    let optionalDependencies = [];
    let devDependencies = [];
    if (apkg["dev-dependencies"]) {
      for (const agroup of Object.keys(apkg["dev-dependencies"])) {
        devDependencies = devDependencies.concat(
          apkg["dev-dependencies"][agroup],
        );
      }
    }
    if (apkg["optional-dependencies"]) {
      for (const agroup of Object.keys(apkg["optional-dependencies"])) {
        optionalDependencies = optionalDependencies.concat(
          apkg["optional-dependencies"][agroup],
        );
      }
    }
    if (
      apkg.dependencies ||
      devDependencies.length ||
      optionalDependencies.length
    ) {
      if (Array.isArray(apkg.dependencies)) {
        // pdm.lock files
        let allDeps = apkg.dependencies;
        allDeps = allDeps.concat(devDependencies);
        allDeps = allDeps.concat(optionalDependencies);
        for (const apkgDep of allDeps) {
          // Example: "msgpack>=0.5.2"
          const nameStr =
            apkgDep.name || apkgDep.split(/(==|<=|~=|>=)/)[0].split(" ")[0];
          depsMap[pkg["bom-ref"]].add(existingPkgMap[nameStr] || nameStr);
          // Propagate the workspace properties to the child components
          if (
            existingPkgMap[nameStr] &&
            pkgBomRefMap[existingPkgMap[nameStr]]
          ) {
            const dependentPkg = pkgBomRefMap[existingPkgMap[nameStr]];
            dependentPkg.properties = dependentPkg.properties || [];
            const addedValue = {};
            // Is the parent a workspace
            if (workspaceComponentMap[pkg.name]) {
              dependentPkg.properties.push({
                name: "internal:workspaceRef",
                value: pkg["bom-ref"],
              });
              dependentPkg.properties.push({
                name: "internal:workspaceSrcFile",
                value: workspaceRefPyProjMap[pkg["bom-ref"]],
              });
              addedValue[pkg["bom-ref"]] = true;
            }
            for (const pprop of pkg.properties) {
              if (
                pprop.name.startsWith("internal:workspace") &&
                !addedValue[pprop.value]
              ) {
                dependentPkg.properties.push(pprop);
                addedValue[pprop.value] = true;
              }
            }
          }
        }
      } else if (apkg.dependencies && Object.keys(apkg.dependencies).length) {
        for (const apkgDep of Object.keys(apkg.dependencies)) {
          depsMap[pkg["bom-ref"]].add(existingPkgMap[apkgDep] || apkgDep);
        }
      }
    }
  }
  for (const key of Object.keys(depsMap)) {
    const dependsOnList = new Set();
    const parentPkg = pkgBomRefMap[key];
    for (const adep of Array.from(depsMap[key])) {
      let depRef;
      if (adep.startsWith("pkg:")) {
        depRef = adep;
      } else if (existingPkgMap[adep]) {
        depRef = existingPkgMap[adep];
      } else if (existingPkgMap[`py${adep}`]) {
        depRef = existingPkgMap[`py${adep}`];
      } else if (existingPkgMap[adep.replace(/-/g, "_")]) {
        depRef = existingPkgMap[adep.replace(/-/g, "_")];
      }
      if (depRef) {
        dependsOnList.add(depRef);
        // We need to propagate the workspace properties from the parent
        const dependentPkg = pkgBomRefMap[depRef];
        dependentPkg.properties = dependentPkg.properties || [];
        const addedValue = {};
        for (const p of dependentPkg.properties) {
          if (p.name.startsWith("internal:workspace")) {
            addedValue[p.value] = true;
          }
        }
        if (parentPkg?.properties?.length) {
          for (const pprop of parentPkg.properties) {
            if (
              pprop.name.startsWith("internal:workspace") &&
              !addedValue[pprop.value]
            ) {
              dependentPkg.properties.push(pprop);
              addedValue[pprop.value] = true;
            } else if (pprop.name === "internal:is_workspace") {
              dependentPkg.properties.push({
                name: "internal:workspaceRef",
                value: parentPkg["bom-ref"],
              });
              dependentPkg.properties.push({
                name: "internal:workspaceSrcFile",
                value: workspaceRefPyProjMap[parentPkg["bom-ref"]],
              });
              addedValue[parentPkg["bom-ref"]] = true;
              addedValue[workspaceRefPyProjMap[parentPkg["bom-ref"]]] = true;
              const childDeps = depsMap[dependentPkg["bom-ref"]];
              for (const childRef of childDeps) {
                if (!childRef.startsWith("pkg:")) {
                  continue;
                }
                const childPkg = pkgBomRefMap[childRef];
                if (childPkg) {
                  childPkg.properties = childPkg.properties || [];
                  childPkg.properties.push({
                    name: "internal:workspaceRef",
                    value: parentPkg["bom-ref"],
                  });
                  childPkg.properties.push({
                    name: "internal:workspaceSrcFile",
                    value: workspaceRefPyProjMap[parentPkg["bom-ref"]],
                  });
                }
              }
            }
          }
        }
      }
    }
    dependenciesList.push({
      ref: key,
      dependsOn: [...dependsOnList].sort(),
    });
  }
  pkgList = await getPyMetadata(pkgList, false);
  return {
    parentComponent,
    pkgList,
    rootList,
    dependenciesList,
    workspaceWarningShown,
  };
}

/**
 * Method to parse requirements.txt file. This must be replaced with atom parsedeps.
 *
 * @param {String} reqFile Requirements.txt file
 * @param {Boolean} fetchDepsInfo Fetch dependencies info from pypi
 *
 * @returns {Promise[Array<Object>]} List of direct dependencies from the requirements file
 */
export async function parseReqFile(reqFile, fetchDepsInfo = false) {
  return await parseReqData(reqFile, null, fetchDepsInfo);
}

/**
 * Method to parse requirements.txt file. Must only be used internally.
 *
 * @param {String} reqFile Requirements.txt file
 * @param {Object} reqData Requirements.txt data for internal invocations from setup.py file etc.
 * @param {Boolean} fetchDepsInfo Fetch dependencies info from pypi
 * @returns {Promise<Array<Object>>} List of direct dependencies from the requirements file
 */
async function parseReqData(reqFile, reqData = null, fetchDepsInfo = false) {
  const pkgList = [];
  let compScope;
  if (!reqFile && !reqData) {
    console.warn(
      "Either the requirements file or the data needs to be provided for parsing.",
    );
    return pkgList;
  }
  reqData = reqData || readFileSync(reqFile, { encoding: "utf-8" });
  const evidence = reqFile
    ? {
        identity: {
          field: "purl",
          confidence: 0.5,
          methods: [
            {
              technique: "manifest-analysis",
              confidence: 0.5,
              value: reqFile,
            },
          ],
        },
      }
    : undefined;
  const lines = reqData.replace(/\r/g, "").replace(/\\$/gm, "").split("\n");
  for (const line of lines) {
    let l = line.trim();
    if (l.includes("# Basic requirements")) {
      compScope = "required";
    } else if (l.includes("added by pip freeze")) {
      compScope = undefined;
    }
    if (l.startsWith("Skipping line") || l.startsWith("(add")) {
      continue;
    }
    if (!l || l.startsWith("#") || l.startsWith("-")) {
      continue;
    }
    const properties = reqFile
      ? [
          {
            name: "SrcFile",
            value: reqFile,
          },
        ]
      : [];

    // Handle markers
    let markers = null;
    let structuredMarkers = null;
    if (l.includes(";")) {
      const parts = l.split(";");
      l = parts[0].trim();
      markers = parts.slice(1).join(";").trim();
      structuredMarkers = parseReqEnvMarkers(markers);
    }

    // Handle extras (e.g., package[extra1,extra2])
    let extras = null;
    const extrasMatch = l.match(/^([a-zA-Z0-9_\-\.]+)(\[([^\]]+)\])?(.*)$/);
    if (extrasMatch) {
      const [, packageName, , extrasStr, versionSpecifiers] = extrasMatch;
      const name = packageName;
      if (extrasStr) {
        extras = extrasStr.split(",").map((e) => e.trim());
        l = `${name}${versionSpecifiers}`; // Reconstruct without extras for version parsing
      }
      if (PYTHON_STD_MODULES.includes(name)) {
        continue;
      }
      const versionMatch = versionSpecifiers.match(
        /(==|!=|<=|>=|<|>|~=)([0-9.a-zA-Z_*\-+]*)/,
      );
      let version = null;
      if (versionMatch) {
        version = versionMatch[2].replaceAll("*", "0") || null;
        if (version === "0") {
          version = null;
        }
      }
      const apkg = {
        name,
        version,
        scope: compScope,
        evidence,
      };
      if (extras && extras.length > 0) {
        properties.push({
          name: "cdx:pypi:extras",
          value: extras.join(","),
        });
      }
      if (versionSpecifiers && !versionSpecifiers.startsWith("==")) {
        properties.push({
          name: "cdx:pypi:versionSpecifiers",
          value: versionSpecifiers.trim(),
        });
      }
      if (markers) {
        properties.push({
          name: "cdx:pip:markers",
          value: markers,
        });
        if (structuredMarkers && structuredMarkers.length > 0) {
          properties.push({
            name: "cdx:pip:structuredMarkers",
            value: JSON.stringify(structuredMarkers),
          });
        }
      }
      if (properties.length) {
        apkg.properties = properties;
      }
      pkgList.push(apkg);
    } else {
      const match = l.match(/^([a-zA-Z0-9_\-\.]+)(.*)$/);
      if (!match) {
        continue;
      }
      const [, name, versionSpecifiers] = match;
      if (PYTHON_STD_MODULES.includes(name)) {
        continue;
      }
      const versionMatch = versionSpecifiers.match(
        /(==|!=|<=|>=|<|>|~=)([0-9.a-zA-Z_*\-+]*)/,
      );
      let version = null;
      if (versionMatch) {
        version = versionMatch[2].replace("*", "0") || null;
        if (version === "0") version = null;
      }
      const apkg = {
        name,
        version,
        scope: compScope,
        evidence,
      };
      if (versionSpecifiers && !versionSpecifiers.startsWith("==")) {
        properties.push({
          name: "cdx:pypi:versionSpecifiers",
          value: versionSpecifiers.trim(),
        });
      }
      if (markers) {
        properties.push({
          name: "cdx:pip:markers",
          value: markers,
        });
        if (structuredMarkers && structuredMarkers.length > 0) {
          properties.push({
            name: "cdx:pip:structuredMarkers",
            value: JSON.stringify(structuredMarkers),
          });
        }
      }
      if (properties.length) {
        apkg.properties = properties;
      }
      pkgList.push(apkg);
    }
  }
  return await getPyMetadata(pkgList, fetchDepsInfo);
}

/**
 * Parse environment markers into structured format
 *
 * @param {String} markersStr Raw markers string
 * @returns {Array<Object>} Structured markers array
 */
export function parseReqEnvMarkers(markersStr) {
  if (!markersStr) return [];

  const markers = [];
  const tokens = markersStr
    .replace(/\s+/g, " ")
    .trim()
    .split(/\s+(and|or)\s+/gi)
    .filter((token) => token.trim());
  for (const token of tokens) {
    if (token.toLowerCase() === "and" || token.toLowerCase() === "or") {
      markers.push({
        operator: token.toLowerCase(),
      });
    } else {
      const match = token.match(
        /([a-zA-Z_]+)\s*(==|!=|<=|>=|<|>)\s*["']?([^"']*)["']?/,
      );
      if (match) {
        markers.push({
          variable: match[1],
          operator: match[2],
          value: match[3],
        });
      } else {
        // Add as raw token if parsing fails
        markers.push({
          raw: token,
        });
      }
    }
  }
  return markers;
}

/**
 * Method to find python modules by parsing the imports and then checking with PyPI to obtain the latest version
 *
 * @param {string} src directory
 * @param {Array} epkgList Existing package list
 * @param {Object} options CLI options
 * @returns List of packages
 */
export async function getPyModules(src, epkgList, options) {
  const allImports = {};
  const dependenciesList = [];
  let modList = [];
  const slicesFile = resolve(
    options.depsSlicesFile || options.usagesSlicesFile,
  );
  // Issue: 615 fix. Reuse existing slices file
  if (slicesFile && safeExistsSync(slicesFile)) {
    const slicesData = JSON.parse(readFileSync(slicesFile, "utf-8"));
    if (slicesData && Object.keys(slicesData) && slicesData.modules) {
      modList = slicesData.modules;
    } else {
      modList = slicesData;
    }
  } else {
    modList = findAppModules(src, "python", "parsedeps", slicesFile);
  }
  const pyDefaultModules = new Set(PYTHON_STD_MODULES);
  modList = modList.filter(
    (x) =>
      !pyDefaultModules.has(x.name.toLowerCase()) &&
      !x.name.startsWith("_") &&
      !x.name.startsWith("."),
  );
  let pkgList = modList.map((p) => {
    const apkg = {
      name:
        PYPI_MODULE_PACKAGE_MAPPING[p.name.toLowerCase()] ||
        PYPI_MODULE_PACKAGE_MAPPING[p.name.replace(/_/g, "-").toLowerCase()] ||
        p.name.replace(/_/g, "-").toLowerCase(),
      version: p.version?.trim().length ? p.version : undefined,
      scope: "required",
      properties: [
        {
          name: "cdx:pypi:versionSpecifiers",
          value: p.versionSpecifiers,
        },
      ],
    };
    if (p.importedSymbols) {
      apkg.properties.push({
        name: "ImportedModules",
        value: p.importedSymbols,
      });
    }
    return apkg;
  });
  pkgList = pkgList.filter(
    (obj, index) => pkgList.findIndex((i) => i.name === obj.name) === index,
  );
  if (epkgList?.length) {
    const pkgMaps = epkgList.map((p) => p.name);
    pkgList = pkgList.filter((p) => !pkgMaps.includes(p.name));
  }
  pkgList = await getPyMetadata(pkgList, true);
  // Populate the imports list after dealiasing
  if (pkgList?.length) {
    pkgList.forEach((p) => {
      allImports[p.name] = true;
    });
  }
  for (const p of pkgList) {
    if (p.version) {
      dependenciesList.push({
        ref: `pkg:pypi/${p.name.replace(/_/g, "-")}@${p.version}`.toLowerCase(),
        dependsOn: [],
      });
    }
  }
  return { allImports, pkgList, dependenciesList, modList };
}

/**
 * Method to parse setup.py data
 *
 * @param {Object} setupPyData Contents of setup.py
 */
export async function parseSetupPyFile(setupPyData) {
  let lines = [];
  let requires_found = false;
  let should_break = false;
  setupPyData.split("\n").forEach((l) => {
    l = l.trim();
    if (l.includes("install_requires")) {
      l = l.replace("install_requires=[", "");
      requires_found = true;
    }
    if (l.length && requires_found && !should_break) {
      if (l.includes("]")) {
        should_break = true;
        l = l.replace("],", "").replace("]", "");
      }
      let tmpA = l.replace(/['"]/g, "").split(",");
      tmpA = tmpA.filter((v) => v.length);
      lines = lines.concat(tmpA);
    }
  });
  return await parseReqData(null, lines.join("\n"), false);
}

/**
 * Method to create purl using information in pixi.lock file.
 * According to pixi lock file satisfiability (https://pixi.sh/latest/features/lockfile/#lockfile-satisfiability)
 *
 *
 *
 * @param {*} packageData
 * @returns
 */
function createPurlTemplate(packageData) {
  return `pkg:${packageData["kind"]}/${packageData["name"]}@${packageData["version"]}-${packageData["build"]}?os=${packageData["subdir"]}`;
}

/**
 * Method to parse pixi.lock data
 *
 * @param {String} pixiLockFileName  pixi.lock file name
 * @param {String} path File path
 */
export function parsePixiLockFile(pixiLockFileName, path) {
  const pixiFileData = readFileSync(pixiLockFileName, { encoding: "utf-8" });
  const pixiLockData = _load(pixiFileData);

  // this function returns
  let pkgList;
  const formulationList = [];
  const rootList = [];
  let dependenciesList;
  // we do not set false because we have assumed that pixi lock is accurate
  const frozen = true;

  /**
   * pixiMapper used with a map on pixi packages list.
   * the pixi list contains the following information e.g.
   * {kind: conda
   *  name: alsa-lib
   *  version: 1.2.11
   *  build: h31becfc_1
   *  build_number: 1
   *  subdir: linux-aarch64
   *  url: https://conda.anaconda.org/conda-forge/linux-aarch64/alsa-lib-1.2.11-h31becfc_1.conda
   *  sha256: d062bc712dd307714dfdb0f7da095a510c138c5db76321494a516ac127f9e5cf
   *  md5: 76bf292a85a0556cef4f500420cabe6c
   *  depends:
   *  - libgcc-ng >=12
   *  license: LGPL-2.1-or-later
   *  license_family: GPL
   *  size: 584152
   *  timestamp: 1709396718705
   * }
   * We create the purl using the following logic:
   * "purl": "pkg:{kind}/{name}@{version}-{build}?os={os}"
   * type would be "library" and evidence would be
   * {
   *  "identity": {
   *                    "field": "purl",
   *                    "confidence": 1,
   *                    "methods": [
   *                        {
   *                            "technique": "instrumentation",
   *                            "confidence": 1,
   *                            "value": "pixi.lock"
   *                        }
   *                    ]
   *                }
   * }
   *
   */
  function pixiMapper(packageData) {
    // return pkgList
    /** E.g. of what a pkgList element looks like
     * {
     *      name: "conda-content-trust",
     *      version: "latest",
     *      purl: "pkg:pypi/conda-content-trust@latest",
     *      type: "library",
     *      "bom-ref": "pkg:pypi/conda-content-trust@latest",
     *      scope: "excluded",
     *      evidence: {
     *        identity: {
     *          field: "purl",
     *          confidence: 1,
     *          methods: [
     *            {
     *              technique: "instrumentation",
     *              confidence: 1,
     *              value: "/home/greatsage/miniconda3",
     *            },
     *          ],
     *        },
     *      },
     *      properties: [
     *        {
     *          name: "SrcFile",
     *          value: "/home/greatsage/projects/supplyChain/trials/pythonprojs/fastapi/requirements.txt",
     *        },
     *      ],
     *    }
     *
     */
    const purlTemplate = createPurlTemplate(packageData);
    return {
      name: packageData["name"],
      version: packageData["version"],
      purl: purlTemplate,
      type: "library",
      "bom-ref": purlTemplate,
      // "licenses": [
      //   [{
      //       "id": packageData["license"]
      //   }]
      // ],
      supplier: {
        name: packageData["build"],
        url: packageData["url"],
      },
      // "hashes": [
      //   {"md5": packageData["md5"]},
      //   {"sha256": packageData["sha256"]}
      // ],
      evidence: {
        identity: {
          field: "purl",
          confidence: 1,
          methods: [
            {
              technique: "instrumentation",
              confidence: 1,
              // "value": `${path}/.pixi/envs/default`
            },
          ],
        },
      },
      properties: [
        { name: "cdx:pixi:operating_system", value: packageData["subdir"] },
        {
          name: "cdx:pixi:build_number",
          value: `${packageData["build_number"]}`,
        },
        { name: "cdx:pixi:build", value: `${packageData["build"]}` },
      ],
    };
  }

  function mapAddEvidenceValue(p) {
    // TODO: get pixi environment variable (PR #1343)
    p["evidence"]["identity"]["methods"]["value"] =
      `${path}/.pixi/envs/default`;
    return p;
  }

  // create the pkgList
  pkgList = pixiLockData["packages"].map(pixiMapper);
  pkgList = pkgList.map(mapAddEvidenceValue);

  // create dependencies
  const dictionary_packages = pixiLockData["packages"].reduce(
    (accumulator, currentObject) => {
      accumulator[currentObject["name"]] = currentObject;
      return accumulator;
    },
    {},
  );

  dependenciesList = [];
  for (const package_iter of pixiLockData["packages"]) {
    const depends = package_iter["depends"];
    if (!depends) {
      continue;
    }

    const purltemplate = createPurlTemplate(package_iter);
    const subdir = package_iter["subdir"];
    const dependsOn = new Set();
    for (const depends_package of depends) {
      const depends_package_name = depends_package.split(" ");
      const depends_package_information =
        dictionary_packages[depends_package_name[0] + subdir];
      if (!depends_package_information) {
        continue;
      }
      dependsOn.add(createPurlTemplate(depends_package_information));
    }

    dependenciesList.push({
      ref: purltemplate,
      dependsOn: [...dependsOn].sort(),
    });
  }

  return {
    pkgList,
    formulationList,
    rootList,
    dependenciesList,
    frozen,
  };
}

/**
 * Method to parse pixi.toml file
 *
 * @param {String} pixiToml
 */
export function parsePixiTomlFile(pixiToml) {
  const pixiTomlFile = readFileSync(pixiToml, { encoding: "utf-8" });
  const tomlData = toml.parse(pixiTomlFile);
  const pkg = {};
  if (!tomlData) {
    return pkg;
  }
  pkg.description = tomlData["project"]["description"];
  pkg.name = tomlData["project"]["name"];
  pkg.version = tomlData["project"]["version"];
  // pkg.authors = tomlData['project']['authors'];
  pkg.homepage = tomlData["project"]["homepage"];
  pkg.repository = tomlData["project"]["repository"];
  return pkg;
}

/**
 * Method to construct a GitHub API url for the given repo metadata
 * @param {Object} repoMetadata Repo metadata with group and name
 * @return {String|undefined} github api url (or undefined - if not enough data)
 */
export function repoMetadataToGitHubApiUrl(repoMetadata) {
  if (repoMetadata) {
    const group = repoMetadata.group;
    const name = repoMetadata.name;
    let ghUrl = "https://api.github.com/repos";
    if (group && group !== "." && group !== "") {
      ghUrl = `${ghUrl}/${group.replace("github.com/", "")}`;
    }
    ghUrl = `${ghUrl}/${name}`;
    return ghUrl;
  }
  return undefined;
}

/**
 * Method to run cli command `pixi install`
 *
 *
 */
export function generatePixiLockFile(_path) {
  const result = safeSpawnSync("pixi", ["install"]);

  if (result.status !== 0) {
    // Handle errors
    if (result.error && result.error.code === "ENOENT") {
      console.error(
        "Error: pixi command not found. Make sure pixi.js is installed globally.",
      );
    } else {
      console.error(
        `Error executing pixi install: ${result.error || result.stderr.toString()}`,
      );
    }
    process.exit(1);
  } else {
    console.log("Dependencies installed successfully.");
  }
}

/**
 * Method to split GitHub url into its parts
 * @param {String} repoUrl Repository url
 * @return {[String]} parts from url
 */
export function getGithubUrlParts(repoUrl) {
  if (repoUrl.toLowerCase().endsWith(".git")) {
    repoUrl = repoUrl.slice(0, -4);
  }
  repoUrl.replace(/\/$/, "");
  return repoUrl.split("/");
}

/**
 * Method to construct GitHub api url from repo metadata or one of multiple formats of repo URLs
 * @param {String} repoUrl Repository url
 * @param {Object} repoMetadata Object containing group and package name strings
 * @return {String|undefined} github api url (or undefined - if not a GitHub repo)
 */
export function toGitHubApiUrl(repoUrl, repoMetadata) {
  if (repoMetadata) {
    return repoMetadataToGitHubApiUrl(repoMetadata);
  }
  const parts = getGithubUrlParts(repoUrl);
  if (parts.length < 5 || parts[2] !== "github.com") {
    return undefined; // Not a valid GitHub repo URL
  }
  return repoMetadataToGitHubApiUrl({
    group: parts[3],
    name: parts[4],
  });
}

/**
 * Method to retrieve repo license by querying github api
 *
 * @param {String} repoUrl Repository url
 * @param {Object} repoMetadata Object containing group and package name strings
 * @return {Promise<String>} SPDX license id
 */
export async function getRepoLicense(repoUrl, repoMetadata) {
  if (!repoUrl) {
    return undefined;
  }
  const apiUrl = toGitHubApiUrl(repoUrl, repoMetadata);
  // Perform github lookups
  if (apiUrl && get_repo_license_errors < MAX_GET_REPO_LICENSE_ERRORS) {
    const licenseUrl = `${apiUrl}/license`;
    const headers = {};
    if (process.env.GITHUB_TOKEN) {
      headers["Authorization"] = `Bearer ${process.env.GITHUB_TOKEN}`;
    }
    try {
      const res = await cdxgenAgent.get(licenseUrl, {
        responseType: "json",
        headers: headers,
      });
      if (res?.body) {
        const license = res.body.license;
        let licenseId = license.spdx_id;
        const licObj = {
          url: res.body.html_url,
        };
        if (license.spdx_id === "NOASSERTION") {
          if (res.body.content) {
            const content = Buffer.from(res.body.content, "base64").toString(
              "ascii",
            );
            licenseId = guessLicenseId(content);
          }
          // If content match fails attempt to find by name
          if (!licenseId && license.name.toLowerCase() !== "other") {
            licenseId = findLicenseId(license.name);
            licObj["name"] = license.name;
          }
        }
        licObj["id"] = licenseId;
        if (licObj["id"] || licObj["name"]) {
          return licObj;
        }
      }
    } catch (err) {
      if (err?.message) {
        if (
          err.message.includes("rate limit exceeded") &&
          !process.env.GITHUB_TOKEN
        ) {
          console.log(
            "Rate limit exceeded for REST API of github.com. " +
              "Please ensure GITHUB_TOKEN is set as environment variable. " +
              "See: https://docs.github.com/en/rest/overview/rate-limits-for-the-rest-api",
          );
          get_repo_license_errors++;
        } else if (!err.message.includes("404")) {
          get_repo_license_errors++;
        }
      }
    }
  }
  return undefined;
}

/**
 * Method to get go pkg license from go.dev site.
 *
 * @param {Object} repoMetadata Repo metadata
 */
export async function getGoPkgLicense(repoMetadata) {
  const group = repoMetadata.group;
  const pkgUrl = `${getGoPkgUrl(repoMetadata)}?tab=licenses`;
  // Check the metadata cache first
  if (metadata_cache[pkgUrl]) {
    return metadata_cache[pkgUrl];
  }
  try {
    const res = await cdxgenAgent.get(pkgUrl);
    if (res?.body) {
      const $ = load(res.body);
      let licenses = $("#LICENSE > h2").text().trim();
      if (licenses === "") {
        licenses = $("section.License > h2").text().trim();
      }
      const licenseIds = licenses.split(", ");
      const licList = [];
      for (const id of licenseIds) {
        if (id.trim().length) {
          const alicense = {};
          if (id.includes(" ")) {
            alicense.name = id
              .trim()
              .replace(/ {2}/g, "")
              .replace("\n", " ")
              .replace("\n", " OR ");
          } else {
            alicense.id = id.trim();
          }
          alicense["url"] = pkgUrl;
          licList.push(alicense);
        }
      }
      metadata_cache[pkgUrl] = licList;
      return licList;
    }
  } catch (_err) {
    return undefined;
  }
  if (group.indexOf("github.com") > -1) {
    return await getRepoLicense(undefined, repoMetadata);
  }
  return undefined;
}

/**
 * Method to get go pkg vcs url from go.dev site.
 *
 * @param {String} group Package group
 * @param {String} name Package name
 */
async function getGoPkgVCSUrl(group, name) {
  const fullName = getGoPkgFullName(group, name);
  if (fullName.startsWith("github.com") || fullName.startsWith("gitlab.com")) {
    return `https://${fullName}`;
  }
  const pkgUrl = getGoPkgUrl({ fullName });
  if (metadata_cache[pkgUrl]) {
    return metadata_cache[pkgUrl];
  }
  try {
    const res = await cdxgenAgent.get(pkgUrl);
    if (res?.body) {
      const $ = load(res.body);
      const vcs = $("div.UnitMeta-repo").children("a").attr("href");
      metadata_cache[pkgUrl] = vcs;
      return vcs;
    }
  } catch (_err) {
    return undefined;
  }
  return undefined;
}

export async function getGoPkgComponent(group, name, version, hash) {
  let license;
  if (shouldFetchLicense()) {
    if (DEBUG_MODE) {
      console.log(
        `About to fetch go package license information for ${group}:${name}`,
      );
    }
    license = await getGoPkgLicense({
      group: group,
      name: name,
    });
  }
  // By replacing %2F with /, we make the purl compatible with the spec.
  const purlString = new PackageURL("golang", group, name, version)
    .toString()
    .replace(/%2F/g, "/");
  let vcs;
  if (shouldFetchVCS()) {
    vcs = await getGoPkgVCSUrl(group, name);
  }
  const packageInfo = {
    group: group,
    name: name,
    version: version,
    _integrity: hash,
    license: license,
    purl: purlString,
    "bom-ref": decodeURIComponent(purlString),
  };
  if (vcs) {
    packageInfo.externalReferences = [{ type: "vcs", url: vcs }];
  }
  return packageInfo;
}

/**
 * Method to get go pkg url (go.dev site).
 *
 * @param {Object} pkgMetadata pkg metadata
 */
function getGoPkgUrl(pkgMetadata) {
  const pkgUrlPrefix = process.env.GO_PKG_URL || "https://pkg.go.dev/";
  const fullName =
    pkgMetadata.fullName ||
    getGoPkgFullName(pkgMetadata.group, pkgMetadata.name);
  return pkgUrlPrefix + fullName;
}

/**
 * Method to get go pkg full name.
 *
 * @param {String} group Package group
 * @param {String} name Package name
 */
function getGoPkgFullName(group, name) {
  return group && group !== "." && group !== name ? `${group}/${name}` : name;
}

/**
 * Method to parse go.mod files
 *
 * @param {String} goModData Contents of go.mod file
 * @param {Object} gosumMap Data from go.sum files
 *
 * @returns {Object} Object containing parent component, rootList and packages list
 */
export async function parseGoModData(goModData, gosumMap) {
  const pkgComponentsList = [];
  const parentComponent = {};
  const rootList = [];
  let isModReplacement = false;
  let isTool = false;

  if (!goModData) {
    return {};
  }

  const pkgs = goModData.split("\n");
  for (let l of pkgs) {
    // Windows of course
    l = l.replace("\r", "").replace(/[\t ]+/g, " ");
    // Capture the parent component name from the module
    if (l.startsWith("module ")) {
      parentComponent.name = l.split(" ").pop().trim();
      parentComponent.type = "application";
      parentComponent["purl"] = PackageURL.fromString(
        `pkg:golang/${parentComponent.name}`,
      ).toString();
      parentComponent["bom-ref"] = decodeURIComponent(parentComponent["purl"]);
      continue;
    }

    // The `tool` block dependency relations will be recorded into `require` block(need run `go mod tidy`), just ignore that
    if (l.includes("tool (")) {
      isTool = !l.includes(")");
      continue;
    }
    if (l.includes(")")) {
      isTool = false;
      continue;
    }
    if (l.includes("tool ")) {
      continue;
    }
    if (isTool) {
      continue;
    }

    // Skip go.mod file headers, whitespace, and/or comments
    if (
      l.startsWith("go ") ||
      //TODO: should toolchain be considered as a dependency
      l.startsWith("toolchain ") ||
      l.includes(")") ||
      l.trim() === "" ||
      l.trim().startsWith("//")
    ) {
      continue;
    }

    // Handle required modules separately from replacement modules to ensure accuracy when parsing component data.
    if (l.includes("require (")) {
      isModReplacement = false;
      continue;
    }
    if (l.includes("replace (")) {
      isModReplacement = true;
      continue;
    }
    if (l.includes("replace ")) {
      // If this is an inline replacement, drop the word replace
      // (eg; "replace google.golang.org/grpc => google.golang.org/grpc v1.21.0" becomes " google.golang.org/grpc => google.golang.org/grpc v1.21.0")
      l = l.replace("replace", "");
      isModReplacement = true;
    }
    // require google.golang.org/genproto v0.0.0-20231106174013-bbf56f31fb17
    if (l.startsWith("require ")) {
      l = l.replace("require ", "");
      isModReplacement = false;
    }
    const tmpA = l.trim().split(" ");
    if (!isModReplacement) {
      // Add group, name and version component properties for required modules
      const version = tmpA[1];
      const gosumHash = gosumMap[`${tmpA[0]}@${version}`];
      const component = await getGoPkgComponent(
        "",
        tmpA[0],
        version,
        gosumHash,
      );
      if (l.endsWith("// indirect")) {
        component.scope = "optional";
      } else {
        rootList.push(component);
      }
      pkgComponentsList.push(component);
    } else {
      // Add group, name and version component properties for replacement modules
      const version = tmpA[3];
      const gosumHash = gosumMap[`${tmpA[2]}@${version}`];
      const component = await getGoPkgComponent(
        "",
        tmpA[2],
        version,
        gosumHash,
      );
      pkgComponentsList.push(component);
      rootList.push(component);
    }
  }
  // Clear the cache
  metadata_cache = {};
  return {
    parentComponent,
    pkgList: pkgComponentsList.sort((a, b) => a.purl.localeCompare(b.purl)),
    rootList,
  };
}

export async function parseGoModulesTxt(txtFile, gosumMap) {
  const pkgList = [];
  const txtData = readFileSync(txtFile, { encoding: "utf-8" });
  const pkgs = txtData
    .split("\n")
    .filter((p) => p.trim().replace(/["']/g, "").startsWith("# "));
  for (const l of pkgs) {
    // # cel.dev/expr v0.18.0
    const tmpA = l.split(" ");
    if (!tmpA.length === 3) {
      continue;
    }
    const version = tmpA[2];
    const gosumHash = gosumMap[`${tmpA[1]}@${version}`];
    const component = await getGoPkgComponent("", tmpA[1], tmpA[2], gosumHash);
    let confidence = 0.7;
    if (gosumHash) {
      component.scope = "required";
    } else {
      confidence = 0.3;
    }
    pkgList.push(_addGoComponentEvidence(component, txtFile, confidence));
  }
  return pkgList;
}

/**
 * Parse go list output
 *
 * @param {string} rawOutput Output from go list invocation
 * @param {Object} gosumMap go.sum data
 * @returns Object with parent component and List of packages
 */
export async function parseGoListDep(rawOutput, gosumMap) {
  let parentComponent = {};
  const deps = [];
  if (typeof rawOutput === "string") {
    const keys_cache = {};
    const pkgs = rawOutput
      .split("\n")
      .filter((p) => p.trim().replace(/["']/g, "").length);
    for (const l of pkgs) {
      const verArr = l.trim().replace(/["']/g, "").split(" ");
      if (verArr && verArr.length >= 5) {
        const key = `${verArr[0]}-${verArr[1]}`;
        // Filter duplicates
        if (!keys_cache[key]) {
          keys_cache[key] = key;
          const version = verArr[1];
          const gosumHash = gosumMap[`${verArr[0]}@${version}`];
          const component = await getGoPkgComponent(
            "",
            verArr[0],
            version,
            gosumHash,
          );
          // This is misusing the scope attribute to represent direct vs indirect
          if (verArr[2] === "false") {
            component.scope = "required";
          } else if (verArr[2] === "true") {
            component.scope = "optional";
          }
          component.properties = [
            {
              name: "SrcGoMod",
              value: verArr[3] || "",
            },
            {
              name: "ModuleGoVersion",
              value: verArr[4] || "",
            },
            {
              name: "cdx:go:indirect",
              value: verArr[2],
            },
          ];
          if (verArr.length > 5 && verArr[5] === "true") {
            parentComponent = component;
          } else {
            deps.push(component);
          }
        }
      }
    }
  }
  return {
    parentComponent,
    pkgList: deps.sort((a, b) => a.purl.localeCompare(b.purl)),
  };
}

function _addGoComponentEvidence(component, goModFile, confidence = 0.8) {
  if (goModFile) {
    component.evidence = {
      identity: {
        field: "purl",
        confidence,
        methods: [
          {
            technique: "manifest-analysis",
            confidence,
            value: goModFile,
          },
        ],
      },
    };
    if (!component.properties) {
      component.properties = [];
    }
    component.properties.push({
      name: "SrcFile",
      value: goModFile,
    });
  }
  return component;
}

/**
 * Parse go mod graph
 *
 * @param {string} rawOutput Output from go mod graph invocation
 * @param {string} goModFile go.mod file
 * @param {Object} gosumMap Hashes from gosum for lookups
 * @param {Array} epkgList Existing package list
 * @param {Object} parentComponent Current parent component
 *
 * @returns Object containing List of packages and dependencies
 */
export async function parseGoModGraph(
  rawOutput,
  goModFile,
  gosumMap,
  epkgList = [],
  parentComponent = {},
) {
  const pkgList = [];
  const dependenciesList = [];
  const addedPkgs = {};
  const depsMap = {};
  // Useful for filtering out invalid components
  const existingPkgMap = {};
  // Package map by manually parsing the go.mod data
  let goModPkgMap = {};
  // Direct dependencies by manually parsing the go.mod data
  const goModDirectDepsMap = {};
  // Indirect dependencies by manually parsing the go.mod data
  const goModOptionalDepsMap = {};
  const excludedRefs = [];
  if (goModFile) {
    goModPkgMap = await parseGoModData(
      readFileSync(goModFile, { encoding: "utf-8" }),
      gosumMap,
    );
    if (goModPkgMap?.rootList) {
      for (const epkg of goModPkgMap.rootList) {
        goModDirectDepsMap[epkg["bom-ref"]] = true;
      }
    }
    if (goModPkgMap?.pkgList) {
      for (const epkg of goModPkgMap.pkgList) {
        if (epkg?.scope === "optional") {
          goModOptionalDepsMap[epkg["bom-ref"]] = true;
        }
      }
    }
  }
  for (const epkg of epkgList) {
    existingPkgMap[epkg["bom-ref"]] = true;
  }
  if (parentComponent && Object.keys(parentComponent).length) {
    existingPkgMap[parentComponent["bom-ref"]] = true;
  }
  if (typeof rawOutput === "string") {
    const lines = rawOutput.split("\n");
    // Each line is of the form ref dependsOn
    // github.com/spf13/afero@v1.2.2 golang.org/x/text@v0.3.0
    for (const l of lines) {
      // To keep the parsing logic simple we prefix pkg:golang/
      // and let packageurl work out the rest
      const tmpA = l.replace("\r", "").split(" ");
      if (tmpA && tmpA.length === 2) {
        try {
          const sourcePurl = PackageURL.fromString(`pkg:golang/${tmpA[0]}`);
          const dependsPurl = PackageURL.fromString(`pkg:golang/${tmpA[1]}`);
          const sourceRefString = decodeURIComponent(sourcePurl.toString());
          const dependsRefString = decodeURIComponent(dependsPurl.toString());
          // Since go mod graph over-reports direct dependencies we use the existing list
          // from go deps to filter the result
          if (
            existingPkgMap &&
            Object.keys(existingPkgMap).length &&
            (!existingPkgMap[sourceRefString] ||
              !existingPkgMap[dependsRefString])
          ) {
            continue;
          }
          // Add the source and depends to the pkgList
          if (!addedPkgs[tmpA[0]] && !excludedRefs.includes(sourceRefString)) {
            const component = await getGoPkgComponent(
              "",
              `${sourcePurl.namespace ? `${sourcePurl.namespace}/` : ""}${
                sourcePurl.name
              }`,
              sourcePurl.version,
              gosumMap[tmpA[0]],
            );
            let confidence = 0.7;
            if (goModOptionalDepsMap[component["bom-ref"]]) {
              component.scope = "optional";
              confidence = 0.5;
            } else if (goModDirectDepsMap[component["bom-ref"]]) {
              component.scope = "required";
            }
            // These are likely false positives
            if (
              goModFile &&
              !Object.keys(existingPkgMap).length &&
              goModPkgMap?.parentComponent?.["bom-ref"] !== sourceRefString &&
              !component.scope
            ) {
              continue;
            }
            // Don't add the parent component to the package list
            if (goModPkgMap?.parentComponent?.["bom-ref"] !== sourceRefString) {
              pkgList.push(
                _addGoComponentEvidence(component, goModFile, confidence),
              );
            }
            addedPkgs[tmpA[0]] = true;
          }
          if (!addedPkgs[tmpA[1]]) {
            const component = await getGoPkgComponent(
              "",
              `${dependsPurl.namespace ? `${dependsPurl.namespace}/` : ""}${
                dependsPurl.name
              }`,
              dependsPurl.version,
              gosumMap[tmpA[1]],
            );
            let confidence = 0.7;
            if (goModDirectDepsMap[component["bom-ref"]]) {
              component.scope = "required";
            }
            if (goModOptionalDepsMap[component["bom-ref"]]) {
              component.scope = "optional";
              confidence = 0.5;
            }
            if (
              goModPkgMap?.parentComponent?.["bom-ref"] !== sourceRefString &&
              goModDirectDepsMap[sourceRefString] &&
              component?.scope !== "required"
            ) {
              // If the parent is required, then ensure the child doesn't accidentally become optional or excluded
              component.scope = undefined;
            }
            // Mark the go toolchain components as excluded
            if (
              dependsRefString.startsWith("pkg:golang/toolchain@") ||
              dependsRefString.startsWith("pkg:golang/go@")
            ) {
              excludedRefs.push(dependsRefString);
              continue;
            }
            // These are likely false positives
            if (
              goModFile &&
              goModPkgMap?.parentComponent?.["bom-ref"] !== sourceRefString &&
              !Object.keys(existingPkgMap).length &&
              !component.scope
            ) {
              excludedRefs.push(dependsRefString);
              continue;
            }
            // The confidence for the indirect dependencies is lower
            // This is because go mod graph emits module requirements graph, which could be different to module compile graph
            // See https://go.dev/ref/mod#glos-module-graph
            pkgList.push(
              _addGoComponentEvidence(component, goModFile, confidence),
            );
            addedPkgs[tmpA[1]] = true;
          }
          if (!depsMap[sourceRefString]) {
            depsMap[sourceRefString] = new Set();
          }
          if (!depsMap[dependsRefString]) {
            depsMap[dependsRefString] = new Set();
          }
          // Check if the root is really dependent on this component
          if (
            goModPkgMap?.parentComponent?.["bom-ref"] === sourceRefString &&
            Object.keys(goModDirectDepsMap).length &&
            !goModDirectDepsMap[dependsRefString]
          ) {
            // ignore
          } else if (!excludedRefs.includes(dependsRefString)) {
            depsMap[sourceRefString].add(dependsRefString);
          }
        } catch (_e) {
          // pass
        }
      }
    }
  }
  for (const adep of Object.keys(depsMap).sort()) {
    dependenciesList.push({
      ref: adep,
      dependsOn: Array.from(depsMap[adep]).sort(),
    });
  }
  return {
    pkgList: pkgList.sort((a, b) => a.purl.localeCompare(b.purl)),
    dependenciesList,
    parentComponent: goModPkgMap?.parentComponent,
    rootList: goModPkgMap?.rootList,
  };
}

/**
 * Parse go mod why output.
 *
 * @param {string} rawOutput Output from go mod why
 * @returns {string|undefined} package name or none
 */
export function parseGoModWhy(rawOutput) {
  if (typeof rawOutput === "string") {
    let pkg_name;
    const lines = rawOutput.split("\n");
    lines.forEach((l) => {
      if (l && !l.startsWith("#") && !l.startsWith("(")) {
        pkg_name = l.trim();
      }
    });
    return pkg_name;
  }
  return undefined;
}

/**
 * Parse go sum data
 * @param {string} gosumData Content of go.sum
 * @returns package list
 */
export async function parseGosumData(gosumData) {
  const pkgList = [];
  if (!gosumData) {
    return pkgList;
  }
  const pkgs = gosumData.split("\n");
  for (const l of pkgs) {
    const m = l.replace("\r", "");
    // look for lines containing go.mod
    if (m.indexOf("go.mod") > -1) {
      const tmpA = m.split(" ");
      const name = tmpA[0];
      const version = tmpA[1].replace("/go.mod", "");
      const hash = tmpA[tmpA.length - 1].replace("h1:", "sha256-");
      const component = await getGoPkgComponent("", name, version, hash);
      pkgList.push(component);
    }
  }
  return pkgList;
}

export async function parseGopkgData(gopkgData) {
  const pkgList = [];
  if (!gopkgData) {
    return pkgList;
  }
  let pkg = null;
  const pkgs = gopkgData.split("\n");
  for (const l of pkgs) {
    let key = null;
    let value = null;
    if (l.indexOf("[[projects]]") > -1) {
      if (pkg) {
        pkgList.push(pkg);
      }
      pkg = {};
    }
    if (l.indexOf("=") > -1) {
      const tmpA = l.split("=");
      key = tmpA[0].trim();
      value = tmpA[1].trim().replace(/"/g, "");
      let digestStr;
      switch (key) {
        case "digest":
          digestStr = value.replace("1:", "");
          pkg._integrity = `sha256-${toBase64(digestStr)}`;
          break;
        case "name":
          pkg.group = "";
          pkg.name = value;
          if (shouldFetchLicense()) {
            pkg.license = await getGoPkgLicense({
              group: pkg.group,
              name: pkg.name,
            });
          }
          break;
        case "version":
          pkg.version = value;
          break;
        case "revision":
          if (!pkg.version) {
            pkg.version = value;
          }
      }
    }
  }
  return pkgList;
}

export async function parseGoVersionData(buildInfoData) {
  const pkgList = [];
  if (!buildInfoData) {
    return pkgList;
  }
  const pkgs = buildInfoData.split("\n");
  for (const i in pkgs) {
    const l = pkgs[i].trim().replace(/\t/g, " ");
    if (!l.startsWith("dep")) {
      continue;
    }
    const tmpA = l.split(" ");
    if (!tmpA || tmpA.length < 3) {
      continue;
    }
    const name = tmpA[1].trim();
    let hash = "";
    if (tmpA.length === 4) {
      hash = tmpA[tmpA.length - 1].replace("h1:", "sha256-");
    }
    const component = await getGoPkgComponent("", name, tmpA[2].trim(), hash);
    pkgList.push(component);
  }
  return pkgList;
}

export const RUBY_PLATFORM_PREFIXES = [
  "-x86_64",
  "-x86",
  "-x64",
  "-aarch",
  "-arm",
  "-ruby",
  "-universal",
  "-java",
  "-truffle",
];

/**
 * Simplify the ruby version by removing platform suffixes
 *
 * @param {string} version Version to simplify
 * @returns {string} Simplified version
 */
function simplifyRubyVersion(version) {
  for (const prefix of RUBY_PLATFORM_PREFIXES) {
    if (version.includes(prefix)) {
      version = version.split(prefix)[0];
    }
  }
  return version;
}

/**
 * Method to query rubygems api for gems details
 *
 * @param {Array} pkgList List of packages with metadata
 */
export async function getRubyGemsMetadata(pkgList) {
  const RUBYGEMS_V2_URL =
    process.env.RUBYGEMS_V2_URL || "https://rubygems.org/api/v2/rubygems/";
  const RUBYGEMS_V1_URL =
    process.env.RUBYGEMS_V1_URL || "https://rubygems.org/api/v1/gems/";
  const rdepList = [];
  const apiOptions = {
    responseType: "json",
  };
  if (process.env.GEM_HOST_API_KEY) {
    apiOptions.headers = {
      Authorization: process.env.GEM_HOST_API_KEY,
    };
  }
  for (const p of pkgList) {
    try {
      if (DEBUG_MODE) {
        console.log(`Querying rubygems.org for ${p.name}`);
      }
      const fullUrl = p.version
        ? `${RUBYGEMS_V2_URL}${p.name}/versions/${simplifyRubyVersion(
            p.version,
          )}.json`
        : `${RUBYGEMS_V1_URL}${p.name}.json`;
      const res = await cdxgenAgent.get(fullUrl, apiOptions);
      let body = res.body;
      if (body?.length) {
        body = body[0];
      }
      p.description = body.description || body.summary || "";
      if (body.licenses) {
        p.license = body.licenses;
      }
      if (body.metadata) {
        if (body.metadata.source_code_uri) {
          p.repository = { url: body.metadata.source_code_uri };
          if (
            body.homepage_uri &&
            body.homepage_uri !== body.metadata.source_code_uri
          ) {
            p.homepage = { url: body.homepage_uri };
          }
        }
        if (body.metadata.bug_tracker_uri) {
          p.bugs = { url: body.metadata.bug_tracker_uri };
        }
      }
      if (body.sha) {
        p._integrity = `sha256-${body.sha}`;
      }
      if (body.authors) {
        p.author = body.authors;
      }
      const platformPresent =
        p.properties.filter((p) => p.name === "cdx:gem:platform").length > 0;
      // Track the platform such as java
      if (!platformPresent && body.platform && body.platform !== "ruby") {
        p.properties.push({
          name: "cdx:gem:platform",
          value: body.platform,
        });
      }
      if (body.ruby_version) {
        p.properties.push({
          name: "cdx:gem:rubyVersionSpecifiers",
          value: body.ruby_version,
        });
      }
      if (body.gem_uri) {
        p.properties.push({
          name: "cdx:gem:gemUri",
          value: body.gem_uri,
        });
      }
      if (body.yanked) {
        p.properties.push({
          name: "cdx:gem:yanked",
          value: `${body.yanked}`,
        });
      }
      if (body.prerelease) {
        p.properties.push({
          name: "cdx:gem:prerelease",
          value: `${body.prerelease}`,
        });
      }
      // Use the latest version if none specified
      if (!p.version) {
        p.version = body.number;
      }
      rdepList.push(p);
    } catch (err) {
      rdepList.push(p);
      if (DEBUG_MODE) {
        console.error(p, err);
      }
    }
  }
  return rdepList;
}

function _upperFirst(string) {
  return string.slice(0, 1).toUpperCase() + string.slice(1, string.length);
}

/**
 * Utility method to convert a gem package name to a CamelCased module name. Low accuracy.
 *
 * @param name Package name
 */
export function toGemModuleNames(name) {
  const modList = name.split("-").map((s) => {
    return s
      .split("_")
      .map((str) => {
        return _upperFirst(str.split("/").map(_upperFirst).join("/"));
      })
      .join("");
  });
  const moduleNames = [];
  let prefix = "";
  for (const amod of modList) {
    if (amod !== "Ruby") {
      moduleNames.push(`${prefix}${amod}`);
    }
    prefix = prefix?.length ? `${prefix}${amod}::` : `${amod}::`;
    // ruby-prof is RubyProf
    if (prefix === "Ruby::") {
      prefix = "Ruby";
    }
  }
  return moduleNames;
}

/**
 * Collect all namespaces for a given gem present at the given gemHome
 *
 * @param {String} rubyCommand Ruby command to use if bundle is not available
 * @param {String} bundleCommand Bundle command to use
 * @param {String} gemHome Value to use as GEM_HOME env variable
 * @param {String} gemName Name of the gem
 * @param {String} filePath File path to the directory containing the Gemfile or .bundle directory
 *
 * @returns {Array<string>} List of module names
 */
export function collectGemModuleNames(
  rubyCommand,
  bundleCommand,
  gemHome,
  gemName,
  filePath,
) {
  gemHome = gemHome || process.env.CDXGEN_GEM_HOME || process.env.GEM_HOME;
  if (!gemHome) {
    console.log(
      "Set the environment variable CDXGEN_GEM_HOME or GEM_HOME to collect the gem module names.",
    );
    return [];
  }
  if (!gemName || gemName.startsWith("/") || gemName === ".") {
    return [];
  }
  gemName = gemName.replace(/["']/g, "");
  // Module names for some gems cannot be obtained with our one-liner
  // So we keep a hard-coded list of such problematic ones.
  if (RUBY_KNOWN_MODULES[gemName]) {
    return RUBY_KNOWN_MODULES[gemName];
  }
  const moduleNames = new Set();
  const commandToUse = bundleCommand || rubyCommand;
  let args = bundleCommand ? ["exec", "ruby"] : [];
  args = args.concat([
    "-e",
    `initial = ObjectSpace.each_object(Module).map { |m| m.respond_to?(:name) ? m.name : nil }.compact;
  require '${gemName}';
  begin
    afterwards = ObjectSpace.each_object(Module).map { |m| m.respond_to?(:name) ? m.name : nil }.compact;
    added = afterwards - initial;
    puts added.sort
  rescue NoMethodError => e
    puts ""
  end
  `,
  ]);
  const result = safeSpawnSync(commandToUse, args, {
    shell: isWin,
    timeout: 5000,
    cwd: filePath,
    env: {
      ...process.env,
      GEM_HOME: gemHome,
    },
  });
  if (result.error || result.status !== 0) {
    if (result?.stderr?.includes("Could not locate Gemfile or .bundle")) {
      console.log(
        `${filePath} must be a directory containing the Gemfile. This appears like a bug in cdxgen.`,
      );
      return [];
    }
    // Let's retry for simple mismatches
    if (gemName?.includes("-")) {
      return collectGemModuleNames(
        rubyCommand,
        bundleCommand,
        gemHome,
        gemName.replaceAll("-", "/"),
        filePath,
      );
    }
    // bundle can sometimes offer suggestions for simple mismatches. Let's try that.
    if (result?.stderr?.includes("Did you mean?")) {
      const altGemName = result.stderr
        .split("Did you mean? ")[1]
        .split("\n")[0]
        .trim();
      if (
        altGemName?.length &&
        !altGemName.startsWith("/") &&
        altGemName !== "." &&
        gemName.replace(/[-_/]/g, "").toLowerCase() ===
          altGemName.replace(/[-_/]/g, "").toLowerCase()
      ) {
        if (DEBUG_MODE) {
          console.log("Retrying", gemName, "with", altGemName);
        }
        return collectGemModuleNames(
          rubyCommand,
          bundleCommand,
          gemHome,
          altGemName,
          filePath,
        );
      }
      if (DEBUG_MODE) {
        console.log(
          `Is ${altGemName} an alternative gem name for '${gemName}' package? Please let us know if this is correct.`,
        );
      }
    }
    // Gem wasn't installed or the GEM_HOME was not set correctly.
    if (
      result?.stderr?.includes("Bundler::GemNotFound") ||
      result?.stderr?.includes("(LoadError)")
    ) {
      return [];
    }
    if (
      !result?.stderr?.includes("(NameError)") &&
      !result?.stderr?.includes("(NoMethodError)") &&
      !result?.stderr?.includes("(ArgumentError)") &&
      DEBUG_MODE
    ) {
      console.log(
        `Unable to collect the module names exported by the gem ${gemName}.`,
      );
      console.log(result.stderr);
    }
    // Let's guess the module name based on common naming convention.
    return toGemModuleNames(gemName);
  }
  const simpleModuleNames = new Set();
  for (const aline of result.stdout.split("\n")) {
    if (
      !aline?.length ||
      aline.startsWith("Ignoring ") ||
      aline.includes("cannot load such file") ||
      aline.startsWith("#<")
    ) {
      continue;
    }
    if (!aline.includes("::")) {
      simpleModuleNames.add(aline.trim());
      continue;
    }
    moduleNames.add(aline.trim());
  }
  return moduleNames.size
    ? Array.from(moduleNames).sort()
    : Array.from(simpleModuleNames).sort();
}

/**
 * Method to parse Gemspec file contents
 *
 * @param {string} gemspecData Gemspec data
 * @param {string} gemspecFile File name for evidence.
 */
export async function parseGemspecData(gemspecData, gemspecFile) {
  let pkgList = [];
  const pkg = { properties: [] };
  if (gemspecFile) {
    pkg.name = basename(gemspecFile).replace(".gemspec", "");
  }
  if (!gemspecData) {
    return pkgList;
  }
  let versionHackMatch = false;
  gemspecData.split("\n").forEach((l) => {
    versionHackMatch = false;
    l = l.replace("\r", "");
    l = l.replace(/\s+/g, " ").replaceAll("%q{", "").trim().replace(/}$/, "");
    if (l.startsWith("#")) {
      return;
    }
    for (const aprop of ["name", "version", "description", "homepage"]) {
      if (l.includes(`.${aprop} = `)) {
        let value = l
          .split(`.${aprop} = `)[1]
          .replace(".freeze", "")
          .replaceAll("''', ", "")
          .replace(/"/g, "");
        if (["name", "version"].includes(aprop)) {
          value = value.replace(/["']/g, "");
        }
        // Do not set name=name or version=version
        if (value !== aprop) {
          pkg[aprop] = value;
          break;
        }
      }
    }
    // Handle common problems
    if (pkg.name === "name") {
      console.log(
        "Unable to identify the package name by parsing the file",
        gemspecFile,
      );
      return;
    }
    if (
      pkg?.version === "version" ||
      pkg?.version?.includes("$") ||
      pkg?.version?.includes("gem_version") ||
      pkg?.version?.includes("File.") ||
      pkg?.version?.includes("::")
    ) {
      const origVersion = pkg.version;
      pkg.version = undefined;
      // Can we find the version from the directory name?
      if (gemspecFile) {
        const versionFromDir = dirname(gemspecFile).split("-").pop();
        if (/\d/.test(versionFromDir)) {
          pkg.version = versionFromDir;
          versionHackMatch = true;
        }
      }
      if (!versionHackMatch && !pkg.version) {
        if (origVersion?.toLowerCase().includes("version")) {
          if (DEBUG_MODE) {
            console.log(
              `Unable to identify the version for '${pkg.name}' from the string '${origVersion}'. Spec file: ${gemspecFile}`,
            );
          }
        } else {
          console.log(
            `Unable to identify the version for '${pkg.name}'. Spec file: ${gemspecFile}`,
          );
        }
      }
    }
    for (const aprop of ["authors", "licenses"]) {
      if (l.includes(`.${aprop} = `)) {
        try {
          const pline = l
            .split(`.${aprop} = `)
            .pop()
            .replaceAll(".freeze", "")
            .replaceAll("%w", "")
            .replaceAll("'", '"')
            .replaceAll(']"', "");
          const apropList = JSON.parse(pline);
          if (apropList) {
            if (Array.isArray(apropList)) {
              pkg[aprop] = apropList;
            } else if (
              typeof apropList === "string" ||
              apropList instanceof String
            ) {
              pkg[aprop] = apropList.split(",");
            }
          }
        } catch (_err) {
          const alist = l
            .replace(/[[\]'"]/g, "")
            .replaceAll("%w", "")
            .split(", ");
          if (alist?.length) {
            pkg[aprop] = alist;
          }
        }
      }
    }
    if (l.includes(".executables = ")) {
      try {
        const exeList = JSON.parse(
          l
            .split(".executables = ")
            .pop()
            .replaceAll(".freeze", "")
            .replaceAll("'", '"')
            .replaceAll(']"', ""),
        );
        if (exeList && Array.isArray(exeList)) {
          pkg.properties.push({
            name: "cdx:gem:executables",
            value: exeList.join(", "),
          });
        }
      } catch (_err) {
        // pass
      }
    }
  });
  if (pkg.name) {
    const purlString = new PackageURL(
      "gem",
      "",
      pkg.name,
      pkg.version,
      null,
      null,
    ).toString();
    pkg.purl = purlString;
    pkg["bom-ref"] = decodeURIComponent(purlString);
  }
  if (gemspecFile) {
    pkg.properties.push({ name: "SrcFile", value: gemspecFile });
    // Did we find the version number from the directory name? Let's reduce the confidence and set the correct technique
    pkg.evidence = {
      identity: {
        field: "purl",
        confidence: !pkg.version || versionHackMatch ? 0.2 : 0.5,
        methods: [
          {
            technique: versionHackMatch ? "filename" : "manifest-analysis",
            confidence: !pkg.version || versionHackMatch ? 0.2 : 0.5,
            value: gemspecFile,
          },
        ],
      },
    };
  }
  if (pkg.authors) {
    pkg.authors = pkg.authors.map((a) => {
      return { name: a };
    });
  }
  if (pkg.licenses) {
    pkg.licenses = pkg.licenses.map((l) => {
      return { license: { name: l } };
    });
  }
  if (pkg.name) {
    pkgList = [pkg];
  } else {
    console.log("Unable to parse", gemspecData, gemspecFile);
  }
  if (shouldFetchLicense()) {
    return await getRubyGemsMetadata(pkgList);
  }
  return pkgList;
}

/**
 * Method to parse Gemfile.lock
 *
 * @param {object} gemLockData Gemfile.lock data
 * @param {string} lockFile Lock file
 */
export async function parseGemfileLockData(gemLockData, lockFile) {
  let pkgList = [];
  const pkgnames = {};
  const dependenciesList = [];
  const dependenciesMap = {};
  const pkgVersionMap = {};
  const pkgVersionPlatformMap = {};
  const pkgNameRef = {};
  if (!gemLockData) {
    return pkgList;
  }
  let specsFound = false;
  // We need two passes to identify components and resolve dependencies
  // In the first pass, we capture package name and version
  gemLockData.split("\n").forEach((l) => {
    l = l.trim();
    l = l.replace("\r", "");
    if (specsFound) {
      const tmpA = l.split(" ");
      if (tmpA && tmpA.length === 2) {
        const name = tmpA[0];
        if (name === "remote:") {
          return;
        }
        let version = tmpA[1];
        // We only allow bracket characters ()
        if (version.search(/[,><~ ]/) < 0) {
          version = version.replace(/[=()]/g, "");
          // Sometimes, the version number could include the platform
          // Examples:
          //  bcrypt_pbkdf (1.1.0)
          //  bcrypt_pbkdf (1.1.0-x64-mingw32)
          //  bcrypt_pbkdf (1.1.0-x86-mingw32)
          // In such cases, we need to track all of them to improve precision
          let platformPrefix = false;
          for (const prefix of RUBY_PLATFORM_PREFIXES) {
            if (version.includes(prefix)) {
              platformPrefix = true;
              const platform = version.split(prefix).pop();
              pkgVersionMap[`${name}${prefix}${platform}`] = version;
              if (!pkgVersionPlatformMap[name]) {
                pkgVersionPlatformMap[name] = new Set();
              }
              pkgVersionPlatformMap[name].add(version);
              break;
            }
          }
          if (!platformPrefix) {
            pkgVersionMap[name] = version;
          }
        }
      }
    }
    if (l === "specs:") {
      specsFound = true;
    }
    if (l === l.toUpperCase()) {
      specsFound = false;
    }
  });
  specsFound = false;
  let lastParent;
  let lastRemote;
  let lastRevision;
  let lastBranch;
  let lastTag;
  let lastParentPlatform;
  // Dependencies block would begin with DEPENDENCIES
  let dependenciesBlock = false;
  const rootList = [];
  // In the second pass, we use the space in the prefix to figure out the dependency tree
  gemLockData.split("\n").forEach((l) => {
    l = l.replace("\r", "");
    if (l.trim().startsWith("remote:")) {
      lastRemote = l.trim().split(" ")[1];
      if (lastRemote.length < 3) {
        lastRemote = undefined;
      }
    }
    if (l.trim().startsWith("revision:")) {
      lastRevision = l.trim().split(" ")[1];
    }
    if (l.trim().startsWith("branch:")) {
      lastBranch = l.trim().split(" ")[1];
    }
    if (l.trim().startsWith("tag:")) {
      lastTag = l.trim().split(" ")[1];
    }
    if (l.trim() === l.trim().toUpperCase()) {
      if (l.trim() === "DEPENDENCIES") {
        dependenciesBlock = true;
        return;
      }
      dependenciesBlock = false;
      specsFound = false;
      lastRemote = undefined;
      lastRevision = undefined;
      lastBranch = undefined;
      lastTag = undefined;
      lastParentPlatform = undefined;
    }
    if (l.trim() === "specs:") {
      specsFound = true;
      return;
    }
    if (specsFound) {
      const tmpA = l.split(" (");
      const nameWithPrefix = tmpA[0];
      const name = tmpA[0].replace(/["']/g, "").trim();
      const level = nameWithPrefix.replace(name, "").split("  ").length % 2;
      if (
        !name.length ||
        ["remote:", "bundler", name.toUpperCase()].includes(name)
      ) {
        return;
      }
      let mayBeVersion = l
        .trim()
        .replace(name, "")
        .replace(" (", "")
        .replace(")", "");
      if (mayBeVersion.search(/[,><~ ]/) < 0) {
        // Reset the platform
        if (level === 1) {
          lastParentPlatform = undefined;
        }
        // Extract the platform
        for (const prefix of RUBY_PLATFORM_PREFIXES) {
          if (mayBeVersion.includes(prefix)) {
            const platform = mayBeVersion.split(prefix).pop();
            lastParentPlatform = `${prefix.replace("-", "")}${platform}`;
            break;
          }
        }
      } else {
        mayBeVersion = undefined;
      }
      // Give preference to the version in the line
      let version = mayBeVersion;
      if (!version) {
        // Identifying the resolved version for a given dependency requires multiple lookups
        version = pkgVersionMap[name];
      }
      // Is there a platform specific alias?
      if (!version && lastParentPlatform) {
        version = pkgVersionMap[`${name}-${lastParentPlatform}`];
      }

      // Is there a match based on the last parent platform
      if (!version && lastParentPlatform && pkgVersionPlatformMap[name]) {
        for (const aver of Array.from(pkgVersionPlatformMap[name])) {
          if (aver.includes(lastParentPlatform.replace("-gnu", ""))) {
            version = aver;
            break;
          }
        }
      }
      const purlString = new PackageURL(
        "gem",
        "",
        name,
        version,
        null,
        null,
      ).toString();
      const bomRef = decodeURIComponent(purlString);
      if (level === 1) {
        lastParent = bomRef;
      }
      const properties = [
        {
          name: "SrcFile",
          value: lockFile,
        },
      ];
      if (lastRemote) {
        properties.push({
          name: "cdx:gem:remote",
          value: lastRemote,
        });
      }
      if (lastRevision) {
        properties.push({
          name: "cdx:gem:remoteRevision",
          value: lastRevision,
        });
      }
      if (lastBranch) {
        properties.push({
          name: "cdx:gem:remoteBranch",
          value: lastBranch,
        });
      }
      if (lastTag) {
        properties.push({
          name: "cdx:gem:remoteTag",
          value: lastTag,
        });
      }
      if (lastParentPlatform) {
        properties.push({
          name: "cdx:gem:platform",
          value: lastParentPlatform,
        });
      }
      const apkg = {
        name,
        version,
        purl: purlString,
        "bom-ref": bomRef,
        properties,
        evidence: {
          identity: {
            field: "purl",
            confidence: 0.8,
            methods: [
              {
                technique: "manifest-analysis",
                confidence: 0.8,
                value: lockFile,
              },
            ],
          },
        },
      };
      if (lastParent && lastParent !== bomRef) {
        if (!dependenciesMap[lastParent]) {
          dependenciesMap[lastParent] = new Set();
        }
        dependenciesMap[lastParent].add(bomRef);
      }
      if (!dependenciesMap[bomRef]) {
        dependenciesMap[bomRef] = new Set();
      }
      pkgNameRef[name] = bomRef;
      // Allow duplicate packages if the version number includes platform
      if (!pkgnames[purlString]) {
        pkgList.push(apkg);
        pkgnames[purlString] = true;
      }
    } else if (dependenciesBlock) {
      const rootDepName = l.trim().split(" ")[0].replace("!", "");
      if (pkgNameRef[rootDepName]) {
        rootList.push(pkgNameRef[rootDepName]);
      } else {
        // We are dealing with an optional platform-dependent import
        // create a placeholder component to track this
        let specifier;
        if (l.includes("(")) {
          specifier = l.trim().split(" (").pop().replace(")", "").trim();
        }
        const untrackedPurl = new PackageURL(
          "gem",
          "",
          rootDepName,
          null,
          null,
          null,
        ).toString();
        const untrackedBomRef = decodeURIComponent(untrackedPurl);
        const untrackedProps = [
          {
            name: "SrcFile",
            value: lockFile,
          },
        ];
        if (specifier) {
          untrackedProps.push({
            name: "cdx:gem:versionSpecifiers",
            value: specifier,
          });
        }
        const untrackedRootDep = {
          name: rootDepName,
          version: undefined,
          purl: untrackedPurl,
          "bom-ref": untrackedBomRef,
          properties: untrackedProps,
          evidence: {
            identity: {
              field: "purl",
              confidence: 0.3,
              methods: [
                {
                  technique: "manifest-analysis",
                  confidence: 0.3,
                  value: lockFile,
                },
              ],
            },
          },
        };
        pkgnames[untrackedPurl] = true;
        pkgNameRef[rootDepName] = untrackedBomRef;
        pkgList.push(untrackedRootDep);
        rootList.push(untrackedBomRef);
        dependenciesMap[untrackedBomRef] = new Set();
      }
    }
  });
  for (const k of Object.keys(dependenciesMap)) {
    dependenciesList.push({
      ref: k,
      dependsOn: Array.from(dependenciesMap[k]).sort(),
    });
  }
  if (shouldFetchLicense()) {
    pkgList = await getRubyGemsMetadata(pkgList);
    return { pkgList, dependenciesList, rootList };
  }
  return { pkgList, dependenciesList, rootList };
}

/**
 * Method to retrieve metadata for rust packages by querying crates
 *
 * @param {Array} pkgList Package list
 */
export async function getCratesMetadata(pkgList) {
  const CRATES_URL =
    process.env.RUST_CRATES_URL || "https://crates.io/api/v1/crates/";
  const cdepList = [];
  for (const p of pkgList) {
    try {
      if (DEBUG_MODE) {
        console.log(`Querying crates.io for ${p.name}@${p.version}`);
      }
      const res = await cdxgenAgent.get(CRATES_URL + p.name, {
        responseType: "json",
      });
      let versionToUse = res?.body?.versions[0];
      if (p.version) {
        for (const aversion of res.body.versions) {
          if (aversion.num === p.version) {
            versionToUse = aversion;
            break;
          }
        }
      }
      const body = res.body.crate;
      p.description = body.description;
      if (versionToUse?.license) {
        p.license = versionToUse.license;
      }
      if (body.repository) {
        p.repository = { url: body.repository };
      }
      if (body.homepage && body.homepage !== body.repository) {
        p.homepage = { url: body.homepage };
      }
      // Use the latest version if none specified
      if (!p.version) {
        p.version = body.newest_version;
      }
      if (!p._integrity && versionToUse.checksum) {
        p._integrity = `sha384-${versionToUse.checksum}`;
      }
      if (!p.properties) {
        p.properties = [];
      }
      p.properties.push({
        name: "cdx:cargo:crate_id",
        value: `${versionToUse.id}`,
      });
      if (versionToUse.rust_version) {
        p.properties.push({
          name: "cdx:cargo:rust_version",
          value: `${versionToUse.rust_version}`,
        });
      }
      p.properties.push({
        name: "cdx:cargo:latest_version",
        value: body.newest_version,
      });
      p.distribution = { url: `https://crates.io${versionToUse.dl_path}` };
      if (versionToUse.features && Object.keys(versionToUse.features).length) {
        p.properties.push({
          name: "cdx:cargo:features",
          value: JSON.stringify(versionToUse.features),
        });
      }
      cdepList.push(p);
    } catch (_err) {
      cdepList.push(p);
    }
  }
  return cdepList;
}

/**
 * Method to retrieve metadata for dart packages by querying pub.dev
 *
 * @param {Array} pkgList Package list
 */
export async function getDartMetadata(pkgList) {
  const PUB_DEV_URL = process.env.PUB_DEV_URL || "https://pub.dev";
  const PUB_LICENSE_REGEX = /^license:/i;
  const OPTIONS = {
    responseType: "json",
    headers: {
      Accept: "application/vnd.pub.v2+json",
    },
  };

  const cdepList = [];
  for (const p of pkgList) {
    try {
      if (DEBUG_MODE) {
        console.log(`Querying ${PUB_DEV_URL} for ${p.name}`);
      }
      const PUB_PACKAGE_URL = `${PUB_DEV_URL}/api/packages/${p.name}/versions/${p.version}`;
      const PUB_PACKAGE_SCORE_URL = `${PUB_PACKAGE_URL}/score`;
      const res = await cdxgenAgent.get(PUB_PACKAGE_URL, OPTIONS);
      if (res?.body) {
        const pubspec = res.body.pubspec;
        p.description = pubspec.description;
        if (pubspec.repository) {
          p.repository = { url: pubspec.repository };
        }
        if (pubspec.homepage) {
          p.homepage = { url: pubspec.homepage };
        }
        const score = await cdxgenAgent.get(PUB_PACKAGE_SCORE_URL, OPTIONS);
        if (score?.body) {
          const tags = score.body.tags;
          const license = tags.find((tag) => PUB_LICENSE_REGEX.test(tag));
          if (license) {
            p.license = spdxLicenses.find(
              (spdxLicense) =>
                spdxLicense.toLowerCase() ===
                license.replace(PUB_LICENSE_REGEX, "").toLowerCase(),
            );
          }
        }
        cdepList.push(p);
      }
    } catch (_err) {
      cdepList.push(p);
    }
  }
  return cdepList;
}

/**
 * Convert list of file paths to components
 *
 * @param {Array} fileList List of file paths
 *
 * @returns {Array} List of components
 */
function fileListToComponents(fileList) {
  const components = [];
  for (const afile of fileList) {
    components.push({
      name: basename(afile),
      type: "file",
      properties: [
        {
          name: "SrcFile",
          value: afile,
        },
      ],
    });
  }
  return components;
}

/**
 * Parse dependency info from the `[package]` node in `cargo.toml` or `cargo.lock`
 * @param {Object} packageNode
 * @returns {Object} dependency info
 * @throws {Error} if dependency name or version is invalid
 */
function parseCargoDependencyFromPackageNode(packageNode) {
  const pkg = {};
  const pkgName = packageNode["name"];
  let group = dirname(pkgName.toString());
  if (group === ".") {
    group = "";
  }
  const pkgChecksum = packageNode["checksum"];
  const pkgVersion = packageNode["version"];
  const pkgAuthors = packageNode["authors"];
  const pkgHomepage = packageNode["homepage"];
  const pkgRepository = packageNode["repository"];
  const pkgLicense = packageNode["license"];
  const pkgDependencies = packageNode["dependencies"];

  //  the value of attributes like:
  //  - `version = 1.0.0`
  //  - `version.workspace = true`
  const isExtendFromWorkspace = (attribute) => {
    return attribute?.workspace;
  };
  if (!pkgName || !pkgVersion) {
    throw new Error("name or version is not defined");
  }

  if (!isExtendFromWorkspace(pkgChecksum) && pkgChecksum) {
    pkg._integrity = `${pkgChecksum}`;
  }
  if (!isExtendFromWorkspace(pkgName) && pkgName) {
    pkg.group = group;
    pkg.name = basename(pkgName.toString());
  }
  if (!isExtendFromWorkspace(pkgVersion) && pkgVersion) {
    pkg.version = pkgVersion;
  }
  if (!isExtendFromWorkspace(pkgAuthors) && pkgAuthors) {
    if (Array.isArray(pkgAuthors)) {
      pkg.author = pkgAuthors.join(",");
    } else {
      pkg.author = Object.prototype.toString.call(pkgAuthors);
    }
  }
  if (!isExtendFromWorkspace(pkgHomepage) && pkgHomepage) {
    pkg.homepage = { url: pkgHomepage };
  }
  if (!isExtendFromWorkspace(pkgRepository) && pkgRepository) {
    pkg.repository = { url: pkgRepository };
  }
  if (!isExtendFromWorkspace(pkgLicense) && pkgLicense) {
    pkg.license = pkgLicense;
  }
  if (!isExtendFromWorkspace(pkgDependencies) && pkgDependencies) {
    pkg.dependencies = pkgDependencies;
  }
  return pkg;
}

/**
 * Method to parse cargo.toml data
 *
 * The component described by a [package] section will be put at the front of
 * the list, regardless of if [package] appears before or after
 * [dependencies]. Found dependencies will be placed at the back of the
 * list.
 *
 * The Cargo documentation specifies that the [package] section should appear
 * first as a convention, but it is not enforced.
 * https://doc.rust-lang.org/stable/style-guide/cargo.html#formatting-conventions
 *
 * @param {String} cargoTomlFile cargo.toml file
 * @param {boolean} simple Return a simpler representation of the component by skipping extended attributes and license fetch.
 * @param {Object} pkgFilesMap Object with package name and list of files
 *
 * @returns {Array} Package list
 */
export async function parseCargoTomlData(
  cargoTomlFile,
  simple = false,
  pkgFilesMap = {},
) {
  const pkgList = [];

  // Helper function to add a component to the package list. It will uphold
  // the guarantee that the component described by the
  // [package]-section remains at the front of the list, and add evidence if
  // requested.
  const addPackageToList = (packageList, pkg, { packageMode, simple }) => {
    if (!pkg) return;

    if (!simple) {
      pkg.properties = [
        {
          name: "SrcFile",
          value: cargoTomlFile,
        },
      ];
      if (pkgFilesMap?.[pkg.name]) {
        pkg.components = fileListToComponents(pkgFilesMap[pkg.name]);
      }
      pkg.evidence = {
        identity: {
          field: "purl",
          confidence: pkg.version ? 0.5 : 0,
          methods: [
            {
              technique: "manifest-analysis",
              confidence: pkg.version ? 0.5 : 0,
              value: cargoTomlFile,
            },
          ],
        },
      };
    }
    const ppurl = new PackageURL(
      "cargo",
      pkg.group,
      pkg.name,
      pkg.version,
      null,
      null,
    ).toString();
    pkg.purl = ppurl;
    pkg["bom-ref"] = decodeURIComponent(ppurl);
    pkg.type = "library";

    // Ensure the component described by [package] is in front of the list to
    // give the caller some information about which component the BOM is the
    // parent component and which are dependencies.
    if (packageMode) {
      packageList.unshift(pkg);
    } else {
      packageList.push(pkg);
    }
  };

  if (!cargoTomlFile || !safeExistsSync(cargoTomlFile)) {
    return pkgList;
  }
  let cargoData;
  try {
    cargoData = toml.parse(readFileSync(cargoTomlFile, { encoding: "utf-8" }));
  } catch (e) {
    console.log(e);
  }
  if (!cargoData) {
    return pkgList;
  }
  const packageNode = cargoData["package"];
  // parse `[package]`
  if (packageNode instanceof Object && !Array.isArray(packageNode)) {
    /** @type {Object} */
    const packageObjNode = packageNode;
    try {
      const pkg = parseCargoDependencyFromPackageNode(packageNode);
      addPackageToList(pkgList, pkg, { packageMode: true, simple });
    } catch (e) {
      console.warn(
        `Failed to parse package: ${packageObjNode?.name}@${packageObjNode?.version},fail with:${e.message}`,
      );
    }
  }
  // parse `[dependencies]`
  const dependenciesNode = cargoData["dependencies"];
  if (dependenciesNode) {
    for (const dependencyName in dependenciesNode) {
      const dependencyNode = dependenciesNode[dependencyName];
      let version = "";
      if (
        typeof dependencyNode === "string" ||
        dependencyNode instanceof String
      ) {
        // like `libc = 0.2.79`
        version = dependencyNode;
      } else if (Object.keys(dependencyNode).length > 0) {
        // like `libc = { version = "0.2.79", features = ['rustc-dep-of-std'], default-features = false }`
        version = dependencyNode?.version;
        const git = dependencyNode?.git;
        if (!version && git) {
          version = `git+${git}`;
        }
      }
      if (dependencyName && version) {
        const pkg = {};
        pkg.name = dependencyName;
        pkg.version = version;
        addPackageToList(pkgList, pkg, { packageMode: false, simple });
      }
    }
  }

  // Properly parsing project with workspaces is currently unsupported. Some
  // projects may have a top-level Cargo.toml file containing only
  // workspace definitions and no package name. That will make the parent
  // component unreliable.
  // See: https://doc.rust-lang.org/cargo/reference/workspaces.html#virtual-workspace
  if (cargoData.workspace && DEBUG_MODE) {
    console.log(
      `Found [workspace] section in ${cargoTomlFile}. Workspaces are currently not fully supported. Verify that the parent component is correct.`,
    );
  }

  if (!simple && shouldFetchLicense()) {
    return await getCratesMetadata(pkgList);
  }
  return pkgList;
}

/**
 * Parse a Cargo.lock file to find components within the Rust project.
 *
 * @param {String} cargoLockFile A path to a Cargo.lock file. The Cargo.lock-file path may be used as information for extended attributes, such as manifest based evidence.
 * @param {boolean} simple Return a simpler representation of the component by skipping extended attributes and license fetch.
 * @param {Object} pkgFilesMap Object with package name and list of files
 *
 * @returns {Array} A list of the project's components as described by the Cargo.lock-file.
 */
export async function parseCargoData(
  cargoLockFile,
  simple = false,
  pkgFilesMap = {},
) {
  const addPackageToList = (packageList, newPackage, { simple }) => {
    if (!newPackage) {
      return;
    }

    const purl = new PackageURL(
      "cargo",
      "",
      newPackage.name,
      newPackage.version,
      null,
      null,
    ).toString();
    const component = {
      type: "library",
      group: newPackage.group,
      "bom-ref": purl,
      purl: purl,
      name: newPackage.name,
      version: newPackage.version,
    };

    if (newPackage._integrity) {
      component.hashes = [
        {
          alg: "SHA-384",
          content: newPackage._integrity,
        },
      ];
    }

    if (!simple) {
      // Assign evidence according to CycloneDX's confidence recommendations in section Evidence of:
      // * https://cyclonedx.org/guides/OWASP_CycloneDX-Authoritative-Guide-to-SBOM-en.pdf
      // The evidence is deemed to be reliable because Cargo itself generates
      // the Cargo.lock-file based on the listed dependencies in the
      // Cargo.toml-file and registry information. So, either we get a direct
      // dependency (very likely), or a transitive dependency based on
      // evidence from the package information in the Cargo registry.
      component.evidence = {
        identity: {
          field: "purl",
          confidence: 0.6,
          methods: [
            {
              technique: "manifest-analysis",
              confidence: 0.6,
              value: cargoLockFile,
            },
          ],
        },
      };

      // Evidence information for CyclondDX specification version < 1.5.
      component.properties = [
        {
          name: "SrcFile",
          value: cargoLockFile,
        },
      ];
      if (pkgFilesMap?.[newPackage.name]) {
        component.components = fileListToComponents(
          pkgFilesMap[component.name],
        );
      }
    }
    packageList.push(component);
  };
  const pkgList = [];
  if (!cargoLockFile) {
    return pkgList;
  }

  const cargoData = toml.parse(
    readFileSync(cargoLockFile, { encoding: "utf-8" }),
  );
  if (!cargoData) {
    return pkgList;
  }

  const packageNode = cargoData["package"];
  // parse `[[package]]`
  if (Array.isArray(packageNode)) {
    packageNode.forEach((packageItem) => {
      try {
        const pkg = parseCargoDependencyFromPackageNode(packageItem);
        addPackageToList(pkgList, pkg, { simple });
      } catch (e) {
        console.warn(
          `Failed to parse package: ${packageItem["name"]}@${packageItem["version"]},fail with:${e.message}`,
        );
      }
    });
  }
  if (shouldFetchLicense() && !simple) {
    return await getCratesMetadata(pkgList);
  }
  return pkgList;
}

export function parseCargoDependencyData(cargoLockData) {
  const purlFromPackageInfo = (pkg) =>
    decodeURIComponent(
      new PackageURL("cargo", "", pkg.name, pkg.version, null, null).toString(),
    );
  const cargoData = toml.parse(cargoLockData);
  const packageNode = cargoData?.package;
  if (!packageNode || !Array.isArray(packageNode)) {
    return [];
  }
  /** @type {Array<Object>} */
  const packageArrayNode = packageNode;
  /** @type {Array<{ name: string, version: string, dependencies: Array<string>}>} */
  const pkgList = [];
  packageArrayNode.forEach((packageItem) => {
    try {
      const pkg = parseCargoDependencyFromPackageNode(packageItem);
      pkgList.push(pkg);
    } catch (e) {
      console.warn(
        `Failed to parse package: ${packageItem["name"]}@${packageItem["version"]},fail with:${e.message}`,
      );
    }
  });
  // Create a map of package names to package objects
  const pkgMap = pkgList.reduce((acc, item) => {
    acc[item.name] = item;
    return acc;
  }, {});
  const result = [];
  // parse dependency version
  Object.values(pkgMap).forEach((pkg) => {
    const dependsOn = new Set();
    pkg.dependencies?.forEach((dep) => {
      if (dep.indexOf(" ") !== -1) {
        // fill version in dependency definition like `libc 0.2.79`
        const depSplit = dep.split(" ");
        dependsOn.add(
          purlFromPackageInfo({
            name: depSplit[0].trim(),
            version: depSplit[1].trim(),
          }),
        );
      } else if (pkgMap[dep]) {
        dependsOn.add(purlFromPackageInfo(pkgMap[dep]));
      } else if (DEBUG_MODE) {
        console.warn(
          `The package "${dep.name}" appears as a dependency to "${pkg.name}" but is not itself listed in the Cargo.lock file. The Cargo.lock file is invalid! The produced SBOM will not list ${dep.name} as a dependency.`,
        );
      }
    });
    result.push({
      ref: purlFromPackageInfo(pkg),
      dependsOn: [...dependsOn],
    });
  });
  return result;
}

export async function parseCargoAuditableData(cargoData) {
  const pkgList = [];
  if (!cargoData) {
    return pkgList;
  }
  cargoData.split("\n").forEach((l) => {
    l = l.replace("\r", "");
    const tmpA = l.split("\t");
    if (tmpA && tmpA.length > 2) {
      let group = dirname(tmpA[0].trim());
      const name = basename(tmpA[0].trim());
      if (group === ".") {
        group = "";
      }
      const version = tmpA[1];
      pkgList.push({
        group,
        name,
        version,
      });
    }
  });
  if (shouldFetchLicense()) {
    return await getCratesMetadata(pkgList);
  }
  return pkgList;
}

/**
 * Method to parse pubspec.lock files.
 *
 * @param pubLockData Contents of lock data
 * @param lockFile Filename for setting evidence
 *
 * @returns {Object}
 */
export async function parsePubLockData(pubLockData, lockFile) {
  if (!pubLockData) {
    return [];
  }
  let pkgList = [];
  const rootList = [];
  const data = _load(pubLockData);
  const packages = data.packages;
  for (const [packageName, packageData] of Object.entries(packages)) {
    const pkg = {
      name: packageName,
      version: packageData.version,
      properties: [],
    };
    // older dart versions don't have sha256
    if (packageData.description?.sha256) {
      pkg._integrity = `sha256-${packageData.description?.sha256}`;
    }
    if (
      packageData.description?.url &&
      packageData.description?.url !== "https://pub.dev"
    ) {
      pkg.properties.push({
        name: "cdx:pub:registry",
        value: packageData.description.url,
      });
    }
    const purlString = new PackageURL("pub", "", pkg.name, pkg.version)
      .toString()
      .replace(/%2F/g, "/");
    pkg["bom-ref"] = decodeURIComponent(purlString);
    if (packageData.dependency === "direct main") {
      pkg.scope = "required";
      rootList.push(pkg);
    } else if (packageData.dependency === "transitive") {
      pkg.scope = "required";
    } else if (packageData.dependency === "direct dev") {
      pkg.scope = "optional";
    }
    if (lockFile) {
      pkg.properties.push({
        name: "SrcFile",
        value: lockFile,
      });
      pkg.evidence = {
        identity: {
          field: "purl",
          confidence: 1,
          methods: [
            {
              technique: "manifest-analysis",
              confidence: 1,
              value: lockFile,
            },
          ],
        },
      };
    }
    pkgList.push(pkg);
  }
  if (shouldFetchLicense()) {
    pkgList = await getDartMetadata(pkgList);
  }
  return { rootList, pkgList };
}

export function parsePubYamlData(pubYamlData) {
  const pkgList = [];
  let yamlObj;
  try {
    yamlObj = _load(pubYamlData);
  } catch (_err) {
    // continue regardless of error
  }
  if (!yamlObj) {
    return pkgList;
  }
  const pkg = {
    name: yamlObj.name,
    description: yamlObj.description,
    version: yamlObj.version,
    homepage: { url: yamlObj.homepage },
  };
  const purlString = new PackageURL("pub", "", pkg.name, pkg.version)
    .toString()
    .replace(/%2F/g, "/");
  pkg.purl = purlString;
  pkg["bom-ref"] = decodeURIComponent(purlString);
  pkgList.push(pkg);
  return pkgList;
}

export function parseHelmYamlData(helmData) {
  const pkgList = [];
  let yamlObj;
  try {
    yamlObj = _load(helmData);
  } catch (_err) {
    // continue regardless of error
  }
  if (!yamlObj) {
    return pkgList;
  }
  if (yamlObj.name && yamlObj.version) {
    const pkg = {
      name: yamlObj.name,
      description: yamlObj.description || "",
      version: yamlObj.version,
    };
    if (yamlObj.home) {
      pkg["homepage"] = { url: yamlObj.home };
    }
    pkgList.push(pkg);
  }
  if (yamlObj.dependencies) {
    for (const hd of yamlObj.dependencies) {
      const pkg = {
        name: hd.name,
        version: hd.version, // This could have * so not precise
      };
      if (hd.repository) {
        pkg["repository"] = { url: hd.repository };
      }
      pkgList.push(pkg);
    }
  }
  if (yamlObj.entries) {
    for (const he of Object.keys(yamlObj.entries)) {
      for (const key of Object.keys(yamlObj.entries[he])) {
        const hd = yamlObj.entries[he][key];
        if (hd.name && hd.version) {
          const pkg = {
            name: hd.name,
            version: hd.version,
            description: hd.description || "",
          };
          if (hd.sources && Array.isArray(hd.sources) && hd.sources.length) {
            pkg["repository"] = { url: hd.sources[0] };
            if (hd.home && hd.home !== hd.sources[0]) {
              pkg["homepage"] = { url: hd.home };
            }
          }
          if (hd.home && !pkg["homepage"]) {
            pkg["homepage"] = { url: hd.home };
          }
          if (hd.digest) {
            pkg._integrity = `sha256-${hd.digest}`;
          }

          pkgList.push(pkg);
        }
      }
    }
  }
  return pkgList;
}

export function recurseImageNameLookup(keyValueObj, pkgList, imgList) {
  if (typeof keyValueObj === "string" || keyValueObj instanceof String) {
    return imgList;
  }
  if (Array.isArray(keyValueObj)) {
    for (const ele of keyValueObj) {
      if (typeof ele !== "string") {
        recurseImageNameLookup(ele, pkgList, imgList);
      }
    }
  } else if (Object.keys(keyValueObj).length) {
    let imageLike =
      keyValueObj.image ||
      keyValueObj.repository ||
      keyValueObj.dockerImage ||
      keyValueObj.mavenImage ||
      keyValueObj.gradleImage ||
      keyValueObj.packImage ||
      keyValueObj.koImage ||
      keyValueObj.kanikoImage;
    if (
      !imageLike &&
      keyValueObj.name &&
      typeof keyValueObj.name === "string" &&
      keyValueObj.name.includes("/")
    ) {
      imageLike = keyValueObj.name;
    }
    if (
      imageLike &&
      typeof imageLike === "string" &&
      !imgList.includes(imageLike)
    ) {
      if (imageLike.includes("VERSION")) {
        imageLike = imageLike
          .replace(":${VERSION:-", ":")
          .replace(":${VERSION:", ":")
          .replace(":%VERSION%", ":latest")
          .replace("}", "");
      }
      pkgList.push({ image: imageLike });
      pkgList.push({ service: keyValueObj.name || imageLike });
      imgList.push(imageLike);
    }
    for (const key of Object.keys(keyValueObj)) {
      // Skip unwanted blocks to improve performance
      if (["schema", "openAPIV3Schema", "names", "status"].includes(key)) {
        continue;
      }
      const valueObj = keyValueObj[key];
      if (!valueObj) {
        continue;
      }
      if (Object.keys(valueObj).length && typeof valueObj !== "string") {
        recurseImageNameLookup(valueObj, pkgList, imgList);
      }
      if (Array.isArray(valueObj)) {
        for (const ele of valueObj) {
          if (typeof ele !== "string") {
            recurseImageNameLookup(ele, pkgList, imgList);
          }
        }
      }
    }
  }
  return imgList;
}

function substituteBuildArgs(statement, buildArgs) {
  for (const argMatch of [
    ...statement.matchAll(/\${?([^:\/\\}]+)}?/g),
  ].reverse()) {
    const fullArgName = argMatch[0];
    const argName = argMatch[1];
    const argIndex = argMatch.index;
    if (buildArgs.has(argName)) {
      statement =
        statement.slice(0, argIndex) +
        buildArgs.get(argName) +
        statement.slice(argIndex + fullArgName.length);
    }
  }
  return statement;
}

export function parseContainerFile(fileContents) {
  const buildArgs = new Map();
  const imagesSet = new Set();
  const buildStageNames = [];
  for (let line of fileContents.split("\n")) {
    line = line.trim();

    if (line.startsWith("#")) {
      continue; // skip commented out lines
    }

    if (line.startsWith("ARG")) {
      const argStatement = line.split("ARG ")[1].split("=");

      if (argStatement.length < 2) {
        continue; // skip ARG statements without default value
      }

      const argName = argStatement[0].trim();
      let argValue = argStatement[1].trim().replace(/['"]+/g, "");
      if (argValue.includes("$")) {
        argValue = substituteBuildArgs(argValue, buildArgs);
      }
      buildArgs.set(argName, argValue);
    }

    if (line.startsWith("FROM")) {
      // The alias could be called AS or as
      const fromStatement = line.split("FROM ")[1].split(/\s(as|AS)\s/);

      let imageStatement = fromStatement[0].trim();
      const buildStageName =
        fromStatement.length > 1
          ? fromStatement[fromStatement.length - 1].trim()
          : undefined;
      if (buildStageNames.includes(imageStatement)) {
        if (DEBUG_MODE) {
          console.log(
            `Skipping image ${imageStatement} which uses previously seen build stage name.`,
          );
        }
        continue;
      }
      if (imageStatement.includes("$")) {
        imageStatement = substituteBuildArgs(imageStatement, buildArgs);
        if (imageStatement.includes("$")) {
          if (DEBUG_MODE) {
            console.log(
              `Unable to substitute build arguments in '${line}' statement.`,
            );
          }
          continue;
        }
      }
      imagesSet.add(imageStatement);

      if (buildStageName) {
        buildStageNames.push(buildStageName);
      }
    }
  }

  return Array.from(imagesSet).map((i) => {
    return { image: i };
  });
}

export function parseBitbucketPipelinesFile(fileContents) {
  const imgList = [];

  let privateImageBlockFound = false;

  for (let line of fileContents.split("\n")) {
    line = line.trim();
    if (line.startsWith("#")) {
      continue; // skip commented out lines
    }

    // Assume this is a private build image object
    if (line.startsWith("name:") && privateImageBlockFound) {
      const imageName = line.split("name:").pop().trim();

      imgList.push({
        image: imageName,
      });

      privateImageBlockFound = false;
    }

    // Docker image usage
    if (line.startsWith("image:")) {
      const imageName = line.split("image:").pop().trim();

      /**
       * Assume this is a private build image object
       * See: https://support.atlassian.com/bitbucket-cloud/docs/use-docker-images-as-build-environments/#Using-private-build-images
       */
      if (imageName === "") {
        privateImageBlockFound = true;
        continue;
      }
      /**
       * Assume this is a public build image
       * See: https://support.atlassian.com/bitbucket-cloud/docs/use-docker-images-as-build-environments/#Using-public-build-images
       */

      imgList.push({
        image: imageName,
      });
    }

    // Pipe usage
    if (line.startsWith("- pipe:")) {
      let pipeName = line.split("- pipe:").pop().trim();

      if (pipeName.startsWith("docker://")) {
        pipeName = pipeName.replace("docker://", "");
      }

      imgList.push({
        image: pipeName,
      });
    }
  }

  return imgList;
}

export function parseContainerSpecData(dcData) {
  const pkgList = [];
  const imgList = [];
  if (!dcData.includes("image") && !dcData.includes("kind")) {
    return pkgList;
  }
  let dcDataList = [dcData];
  if (dcData.includes("---")) {
    dcDataList = dcData.split("---");
  }
  for (const dcData of dcDataList) {
    let yamlObj;
    try {
      yamlObj = _load(dcData);
    } catch (_err) {
      // ignore errors
    }
    if (!yamlObj) {
      continue;
    }
    if (yamlObj.services) {
      for (const serv of Object.keys(yamlObj.services)) {
        pkgList.push({
          service: serv,
        });
        const aservice = yamlObj.services[serv];
        // Track locally built images
        if (aservice.build) {
          if (Object.keys(aservice.build).length && aservice.build.dockerfile) {
            pkgList.push({
              ociSpec: aservice.build.dockerfile,
            });
          } else {
            if (aservice.build === "." || aservice.build === "./") {
              pkgList.push({
                ociSpec: "Dockerfile",
              });
            } else {
              pkgList.push({
                ociSpec: aservice.build,
              });
            }
          }
        } else if (aservice.image && !imgList.includes(aservice.image)) {
          let imgFullName = aservice.image;
          if (imgFullName.includes(":${VERSION:")) {
            imgFullName = imgFullName
              .replace(":${VERSION:-", ":")
              .replace(":${VERSION:", ":")
              .replace("}", "");
          }
          pkgList.push({
            image: imgFullName,
          });
          imgList.push(imgFullName);
        }
      }
    }
    // Tekton tasks and kustomize have spec. Skaffold has build
    const recurseBlock = yamlObj.spec || yamlObj.build || yamlObj.images;
    if (recurseBlock) {
      recurseImageNameLookup(recurseBlock, pkgList, imgList);
    }
  }
  return pkgList;
}

export function identifyFlow(processingObj) {
  let flow = "unknown";
  if (processingObj.sinkId) {
    const sinkId = processingObj.sinkId.toLowerCase();
    if (sinkId.endsWith("write")) {
      flow = "inbound";
    } else if (sinkId.endsWith("read")) {
      flow = "outbound";
    } else if (sinkId.includes("http") || sinkId.includes("grpc")) {
      flow = "bi-directional";
    }
  }
  return flow;
}

function convertProcessing(processing_list) {
  const data_list = [];
  for (const p of processing_list) {
    data_list.push({
      classification: p.sourceId || p.sinkId,
      flow: identifyFlow(p),
    });
  }
  return data_list;
}

export function parsePrivadoFile(f) {
  const pData = readFileSync(f, { encoding: "utf-8" });
  const servlist = [];
  if (!pData) {
    return servlist;
  }
  const jsonData = JSON.parse(pData);
  const aservice = {
    "x-trust-boundary": false,
    properties: [],
    data: [],
    endpoints: [],
  };
  if (jsonData.repoName) {
    aservice.name = jsonData.repoName;
    aservice.properties = [
      {
        name: "SrcFile",
        value: f,
      },
    ];
    // Capture git metadata info
    if (jsonData.gitMetadata) {
      aservice.version = jsonData.gitMetadata.commitId || "";
      aservice.properties.push({
        name: "privadoCoreVersion",
        value: jsonData.privadoCoreVersion || "",
      });
      aservice.properties.push({
        name: "privadoCLIVersion",
        value: jsonData.privadoCLIVersion || "",
      });
      aservice.properties.push({
        name: "localScanPath",
        value: jsonData.localScanPath || "",
      });
    }
    // Capture processing
    if (jsonData.processing?.length) {
      aservice.data = aservice.data.concat(
        convertProcessing(jsonData.processing),
      );
    }
    // Capture sink processing
    if (jsonData.sinkProcessing?.length) {
      aservice.data = aservice.data.concat(
        convertProcessing(jsonData.sinkProcessing),
      );
    }
    // Find endpoints
    if (jsonData.collections) {
      const endpoints = [];
      for (const c of jsonData.collections) {
        for (const occ of c.collections) {
          for (const e of occ.occurrences) {
            if (e.endPoint) {
              endpoints.push(e.endPoint);
            }
          }
        }
      }
      aservice.endpoints = endpoints;
    }
    // Capture violations
    if (jsonData.violations) {
      for (const v of jsonData.violations) {
        aservice.properties.push({
          name: "privado_violations",
          value: v.policyId,
        });
      }
    }
    // If there are third party libraries detected, then there are cross boundary calls happening
    if (jsonData.dataFlow?.third_parties?.length) {
      aservice["x-trust-boundary"] = true;
    }
    servlist.push(aservice);
  }
  return servlist;
}

export function parseOpenapiSpecData(oaData) {
  const servlist = [];
  if (!oaData) {
    return servlist;
  }
  try {
    if (oaData.startsWith("openapi:")) {
      oaData = _load(oaData);
    } else {
      oaData = JSON.parse(oaData);
    }
  } catch (_e) {
    return servlist;
  }

  const name = oaData.info?.title
    ? oaData.info.title.replace(/ /g, "-")
    : "default-name";
  const version = oaData.info?.version ? oaData.info.version : "latest";
  const aservice = {
    "bom-ref": `urn:service:${name}:${version}`,
    name,
    description: oaData.description || "",
    version,
  };
  let serverName = [];
  if (oaData.servers?.length && oaData.servers[0].url) {
    serverName = oaData.servers[0].url;
    if (!serverName.startsWith("http") || !serverName.includes("//")) {
      serverName = `http://${serverName}`;
    }
  }
  if (oaData.paths) {
    const endpoints = [];
    for (const route of Object.keys(oaData.paths)) {
      let sep = "";
      if (!route.startsWith("/")) {
        sep = "/";
      }
      endpoints.push(`${serverName}${sep}${route}`);
    }
    aservice.endpoints = endpoints;
  }
  let authenticated = false;
  if (oaData.components?.securitySchemes) {
    authenticated = true;
  }
  aservice.authenticated = authenticated;
  servlist.push(aservice);
  return servlist;
}

export function parseCabalData(cabalData) {
  const pkgList = [];
  if (!cabalData) {
    return pkgList;
  }
  cabalData.split("\n").forEach((l) => {
    if (!l.includes(" ==")) {
      return;
    }
    l = l.replace("\r", "");
    if (l.includes(" ==")) {
      const tmpA = l.split(" ==");
      const name = tmpA[0]
        .replace("constraints: ", "")
        .replace("any.", "")
        .trim();
      const version = tmpA[1].replace(",", "").trim();
      if (name && version) {
        pkgList.push({
          name,
          version,
        });
      }
    }
  });
  return pkgList;
}

export function parseMixLockData(mixData) {
  const pkgList = [];
  if (!mixData) {
    return pkgList;
  }
  mixData.split("\n").forEach((l) => {
    if (!l.includes(":hex")) {
      return;
    }
    l = l.replace("\r", "");
    if (l.includes(":hex")) {
      const tmpA = l.split(",");
      if (tmpA.length > 3) {
        const name = tmpA[1].replace(":", "").trim();
        const version = tmpA[2].trim().replace(/"/g, "");
        if (name && version) {
          pkgList.push({
            name,
            version,
          });
        }
      }
    }
  });
  return pkgList;
}

export function parseGitHubWorkflowData(f) {
  const pkgList = [];
  if (!f) {
    return pkgList;
  }
  const ghwData = readFileSync(f, { encoding: "utf-8" });
  const keys_cache = {};
  if (!ghwData) {
    return pkgList;
  }
  const yamlObj = _load(ghwData);
  if (!yamlObj) {
    return pkgList;
  }
  const lines = ghwData.split("\n");
  for (const jobName of Object.keys(yamlObj.jobs)) {
    if (yamlObj.jobs[jobName].steps) {
      for (const step of yamlObj.jobs[jobName].steps) {
        if (step.uses) {
          const tmpA = step.uses.split("@");
          if (tmpA.length !== 2) {
            continue;
          }
          const groupName = tmpA[0];
          let name = groupName;
          let group = "";
          const tagOrCommit = tmpA[1];
          let version = tagOrCommit;
          const tmpB = groupName.split("/");
          if (tmpB.length >= 2) {
            name = tmpB.pop();
            group = tmpB.join("/");
          } else if (tmpB.length === 1) {
            name = tmpB[0];
            group = "";
          }
          let lineNum = -1;
          const stepLineMatch = ghwData.indexOf(step.uses);
          if (stepLineMatch >= 0) {
            lineNum =
              ghwData.substring(0, stepLineMatch).split("\n").length - 1;
          }
          if (lineNum >= 0 && lines[lineNum]) {
            const line = lines[lineNum];
            const commentMatch = line.match(/#\s*v?([0-9]+(?:\.[0-9]+)*)/);
            if (commentMatch?.[1]) {
              version = commentMatch[1];
            }
          }
          const key = `${group}-${name}-${version}`;
          let confidence = 0.6;
          if (!keys_cache[key] && name && version) {
            keys_cache[key] = key;
            let fullName = name;
            if (group.length) {
              fullName = `${group}/${name}`;
            }
            let purl = `pkg:github/${fullName}@${version}`;
            if (tagOrCommit && version !== tagOrCommit) {
              const qualifierDesc = tagOrCommit.startsWith("v")
                ? "tag"
                : "commit";
              purl = `${purl}?${qualifierDesc}=${tagOrCommit}`;
              confidence = 0.7;
            }
            const properties = [
              {
                name: "SrcFile",
                value: f,
              },
            ];
            if (group?.startsWith("github/") || group === "actions") {
              properties.push({
                name: "cdx:actions:isOfficial",
                value: "true",
              });
            }
            pkgList.push({
              group,
              name,
              version,
              purl,
              properties,
              evidence: {
                identity: {
                  field: "purl",
                  confidence,
                  methods: [
                    {
                      technique: "source-code-analysis",
                      confidence,
                      value: f,
                    },
                  ],
                },
              },
            });
          }
        }
      }
    }
  }
  return pkgList;
}

export function parseCloudBuildData(cbwData) {
  const pkgList = [];
  const keys_cache = {};
  if (!cbwData) {
    return pkgList;
  }
  const yamlObj = _load(cbwData);
  if (!yamlObj) {
    return pkgList;
  }
  if (yamlObj.steps) {
    for (const step of yamlObj.steps) {
      if (step.name) {
        const tmpA = step.name.split(":");
        if (tmpA.length === 2) {
          let group = dirname(tmpA[0]);
          const name = basename(tmpA[0]);
          if (group === ".") {
            group = "";
          }
          const version = tmpA[1];
          const key = `${group}-${name}-${version}`;
          if (!keys_cache[key] && name && version) {
            keys_cache[key] = key;
            pkgList.push({
              group,
              name,
              version,
            });
          }
        }
      }
    }
  }
  return pkgList;
}

function createConanPurlString(name, version, user, channel, rrev, prev) {
  // https://github.com/package-url/purl-spec/blob/master/PURL-TYPES.rst#conan

  const qualifiers = {};

  if (user) qualifiers["user"] = user;
  if (channel) qualifiers["channel"] = channel;
  if (rrev) qualifiers["rrev"] = rrev;
  if (prev) qualifiers["prev"] = prev;

  return new PackageURL(
    "conan",
    "",
    name,
    version,
    Object.keys(qualifiers).length ? qualifiers : null,
    null,
  ).toString();
}

function untilFirst(separator, inputStr) {
  // untilFirst("/", "a/b") -> ["/", "a", "b"]
  // untilFirst("/", "abc") -> ["/", "abc", null]

  if (!inputStr || inputStr.length === 0) {
    return [null, null, null];
  }

  const separatorIndex = inputStr.search(separator);
  if (separatorIndex === -1) {
    return ["", inputStr, null];
  }
  return [
    inputStr[separatorIndex],
    inputStr.substring(0, separatorIndex),
    inputStr.substring(separatorIndex + 1),
  ];
}

export function mapConanPkgRefToPurlStringAndNameAndVersion(conanPkgRef) {
  // A full Conan package reference may be composed of the following segments:
  // conanPkgRef = "name/version@user/channel#recipe_revision:package_id#package_revision"
  // See also https://docs.conan.io/1/cheatsheet.html#package-terminology

  // The components 'package_id' and 'package_revision' do not appear in any files processed by cdxgen.
  // The components 'user' and 'channel' are not mandatory.
  // 'name/version' is a valid Conan package reference, so is 'name/version@user/channel' or 'name/version@user/channel#recipe_revision'.
  // pURL for Conan does not recognize 'package_id'.

  const UNABLE_TO_PARSE_CONAN_PKG_REF = [null, null, null];

  if (!conanPkgRef) {
    if (DEBUG_MODE)
      console.warn(
        `Could not parse Conan package reference '${conanPkgRef}', input does not seem valid.`,
      );

    return UNABLE_TO_PARSE_CONAN_PKG_REF;
  }

  const separatorRegex = /[@#:\/]/;

  const info = {
    name: null,
    version: null,
    user: null,
    channel: null,
    recipe_revision: null,
    package_id: null,
    package_revision: null,
    phase_history: [],
  };

  const transitions = {
    ["name"]: {
      "/": "version",
      "#": "recipe_revision",
      "": "end",
    },
    ["version"]: {
      "@": "user",
      "#": "recipe_revision",
      "": "end",
    },
    ["user"]: {
      "/": "channel",
    },
    ["channel"]: {
      "#": "recipe_revision",
      "": "end",
    },
    ["recipe_revision"]: {
      ":": "package_id",
      "": "end",
    },
    ["package_id"]: {
      "#": "package_revision",
    },
    ["package_revision"]: {
      "": "end",
    },
  };

  let phase = "name";
  let remainder = conanPkgRef;
  let separator;
  let item;

  while (remainder) {
    [separator, item, remainder] = untilFirst(separatorRegex, remainder);

    if (!item) {
      if (DEBUG_MODE)
        console.warn(
          `Could not parse Conan package reference '${conanPkgRef}', empty item in phase '${phase}', separator=${separator}, remainder=${remainder}, info=${JSON.stringify(info)}`,
        );
      return UNABLE_TO_PARSE_CONAN_PKG_REF;
    }

    info[phase] = item;
    info.phase_history.push(phase);

    if (!(phase in transitions)) {
      if (DEBUG_MODE)
        console.warn(
          `Could not parse Conan package reference '${conanPkgRef}', no transition from '${phase}', separator=${separator}, item=${item}, remainder=${remainder}, info=${JSON.stringify(info)}`,
        );
      return UNABLE_TO_PARSE_CONAN_PKG_REF;
    }

    const possibleTransitions = transitions[phase];
    if (!(separator in possibleTransitions)) {
      if (DEBUG_MODE)
        console.warn(
          `Could not parse Conan package reference '${conanPkgRef}', transition '${separator}' not allowed from '${phase}', item=${item}, remainder=${remainder}, info=${JSON.stringify(info)}`,
        );
      return UNABLE_TO_PARSE_CONAN_PKG_REF;
    }

    phase = possibleTransitions[separator];
  }

  if (phase !== "end") {
    if (DEBUG_MODE)
      console.warn(
        `Could not parse Conan package reference '${conanPkgRef}', end of input string reached unexpectedly in phase '${phase}', info=${JSON.stringify(info)}.`,
      );
    return UNABLE_TO_PARSE_CONAN_PKG_REF;
  }

  if (!info.version) info.version = "latest";

  const purl = createConanPurlString(
    info.name,
    info.version,
    info.user,
    info.channel,
    info.recipe_revision,
    info.package_revision,
  );

  return [purl, info.name, info.version];
}

export function parseConanLockData(conanLockData) {
  const pkgList = [];
  const dependencies = {};
  const parentComponentDependencies = [];

  if (!conanLockData) {
    return { pkgList, dependencies, parentComponentDependencies };
  }

  const lockFile = JSON.parse(conanLockData);
  if (
    (!lockFile || !lockFile.graph_lock || !lockFile.graph_lock.nodes) &&
    !lockFile.requires
  ) {
    return { pkgList, dependencies, parentComponentDependencies };
  }

  if (lockFile.graph_lock?.nodes) {
    const depends = lockFile.graph_lock.nodes;
    const nodeKeyToBomRefMap = {};

    for (const nk of Object.keys(depends)) {
      if (!depends[nk].ref) continue;

      const [purl, name, version] = mapConanPkgRefToPurlStringAndNameAndVersion(
        depends[nk].ref,
      );
      if (purl === null) continue;

      const bomRef = decodeURIComponent(purl);
      pkgList.push({
        name,
        version,
        purl,
        "bom-ref": bomRef,
      });

      nodeKeyToBomRefMap[nk] = bomRef;
    }

    for (const nk of Object.keys(depends)) {
      let requirementNodeKeys = [];
      if (Array.isArray(depends[nk].requires))
        requirementNodeKeys = requirementNodeKeys.concat(depends[nk].requires);
      if (Array.isArray(depends[nk].build_requires))
        requirementNodeKeys = requirementNodeKeys.concat(
          depends[nk].build_requires,
        );

      for (const dependencyNodeKey of requirementNodeKeys) {
        const dependencyBomRef = nodeKeyToBomRefMap[dependencyNodeKey];
        if (!dependencyBomRef) continue;

        const dependentBomRef = nodeKeyToBomRefMap[nk];
        if (dependentBomRef) {
          if (!(dependentBomRef in dependencies))
            dependencies[dependentBomRef] = [];
          if (!dependencies[dependentBomRef].includes(dependencyBomRef))
            dependencies[dependentBomRef].push(dependencyBomRef);
        } else if (nk === "0") {
          // parent component for which the conan.lock was generated
          if (!parentComponentDependencies.includes(dependencyBomRef))
            parentComponentDependencies.push(dependencyBomRef);
        }
      }
    }
  } else if (lockFile.requires) {
    const depends = lockFile.requires;
    for (const nk of Object.keys(depends)) {
      depends[nk] = depends[nk].split("%").shift();
      const [purl, name, version] = mapConanPkgRefToPurlStringAndNameAndVersion(
        depends[nk],
      );
      if (purl !== null) {
        pkgList.push({
          name,
          version,
          purl,
          "bom-ref": decodeURIComponent(purl),
        });
      }
    }
  }
  return { pkgList, dependencies, parentComponentDependencies };
}

export function parseConanData(conanData) {
  const pkgList = [];
  if (!conanData) {
    return pkgList;
  }
  let scope = "required";
  conanData.split("\n").forEach((l) => {
    l = l.replace("\r", "");
    if (l.includes("[build_requires]")) {
      scope = "optional";
    }
    if (l.includes("[requires]")) {
      scope = "required";
    }

    // The line must start with sequence non-whitespace characters, followed by a slash,
    // followed by at least one more non-whitespace character.
    // Provides a heuristic for locating Conan package references inside conanfile.txt files.
    if (l.match(/^[^\s\/]+\/\S+/)) {
      const [purl, name, version] =
        mapConanPkgRefToPurlStringAndNameAndVersion(l);
      if (purl !== null) {
        pkgList.push({
          name,
          version,
          purl,
          "bom-ref": decodeURIComponent(purl),
          scope,
        });
      }
    }
  });
  return pkgList;
}

export function parseLeiningenData(leinData) {
  const pkgList = [];
  if (!leinData) {
    return pkgList;
  }
  const tmpArr = leinData.split("(defproject");
  if (tmpArr.length > 1) {
    leinData = `(defproject${tmpArr[1]}`;
  }
  const ednData = parseEDNString(leinData);
  for (const k of Object.keys(ednData)) {
    if (k === "list") {
      ednData[k].forEach((jk) => {
        if (Array.isArray(jk)) {
          jk.forEach((pobjl) => {
            if (Array.isArray(pobjl) && pobjl.length > 1) {
              const psym = pobjl[0].sym;
              if (psym) {
                let group = dirname(psym) || "";
                if (group === ".") {
                  group = "";
                }
                const name = basename(psym);
                pkgList.push({ group, name, version: pobjl[1] });
              }
            }
          });
        }
      });
    }
  }
  return pkgList;
}

export function parseEdnData(rawEdnData) {
  const pkgList = [];
  if (!rawEdnData) {
    return pkgList;
  }
  const ednData = parseEDNString(rawEdnData);
  const pkgCache = {};
  for (const k of Object.keys(ednData)) {
    if (k === "map") {
      ednData[k].forEach((jk) => {
        if (Array.isArray(jk)) {
          if (Array.isArray(jk)) {
            if (jk.length > 1) {
              if (jk[0].key === "deps") {
                const deps = jk[1].map;
                if (deps) {
                  deps.forEach((d) => {
                    if (Array.isArray(d)) {
                      let psym = "";
                      d.forEach((e) => {
                        if (e.sym) {
                          psym = e.sym;
                        }
                        if (e["map"]) {
                          if (e["map"][0].length > 1) {
                            const version = e["map"][0][1];
                            let group = dirname(psym) || "";
                            if (group === ".") {
                              group = "";
                            }
                            const name = basename(psym);
                            const cacheKey = `${group}-${name}-${version}`;
                            if (!pkgCache[cacheKey]) {
                              pkgList.push({ group, name, version });
                              pkgCache[cacheKey] = true;
                            }
                          }
                        }
                      });
                    }
                  });
                }
              }
            }
          }
        }
      });
    }
  }
  return pkgList;
}

/**
 * Method to parse .nupkg files
 *
 * @param {String} nupkgFile .nupkg file
 * @returns {Object} Object containing package list and dependencies
 */
export async function parseNupkg(nupkgFile) {
  let nuspecData = await readZipEntry(nupkgFile, ".nuspec");
  if (!nuspecData) {
    return [];
  }
  if (nuspecData.charCodeAt(0) === 65533) {
    nuspecData = await readZipEntry(nupkgFile, ".nuspec", "ucs2");
  }
  return parseNuspecData(nupkgFile, nuspecData);
}

/**
 * Method to parse flake.nix files
 *
 * @param {String} flakeNixFile flake.nix file to parse
 * @returns {Object} Object containing package information
 */
export function parseFlakeNix(flakeNixFile) {
  const pkgList = [];
  const dependencies = [];

  if (!existsSync(flakeNixFile)) {
    return { pkgList, dependencies };
  }

  try {
    const flakeContent = readFileSync(flakeNixFile, "utf-8");

    // Extract inputs from flake.nix using regex
    const inputsRegex = /inputs\s*=\s*\{[^}]*\}/g;
    let match;
    while ((match = inputsRegex.exec(flakeContent)) !== null) {
      const inputBlock = match[0];

      // Match different input patterns including nested inputs
      const inputPatterns = [
        /([a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*)\.url\s*=\s*"([^"]+)"/g,
        /([a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*)\s*=\s*\{\s*url\s*=\s*"([^"]+)"[^}]*\}/gs,
      ];

      const addedPackages = new Set();

      for (const pattern of inputPatterns) {
        let subMatch;
        pattern.lastIndex = 0;
        while ((subMatch = pattern.exec(inputBlock)) !== null) {
          const name = subMatch[1];
          const url = subMatch[2] || subMatch[3];

          if (name && url && !addedPackages.has(name)) {
            addedPackages.add(name);
            const pkg = {
              name: name,
              version: "latest",
              description: `Nix flake input: ${name}`,
              scope: "required",
              properties: [
                {
                  name: "SrcFile",
                  value: flakeNixFile,
                },
                {
                  name: "cdx:nix:input_url",
                  value: url,
                },
              ],
              evidence: {
                identity: {
                  field: "purl",
                  confidence: 0.8,
                  methods: [
                    {
                      technique: "manifest-analysis",
                      confidence: 0.8,
                      value: flakeNixFile,
                    },
                  ],
                },
              },
            };

            pkg.purl = generateNixPurl(name, "latest");
            pkg["bom-ref"] = pkg.purl;

            pkgList.push(pkg);
          }
        }
      }
    }
  } catch (error) {
    console.warn(`Failed to parse ${flakeNixFile}: ${error.message}`);
  }

  return { pkgList, dependencies };
}

/**
 * Method to parse flake.lock files
 *
 * @param {String} flakeLockFile flake.lock file to parse
 * @returns {Object} Object containing locked dependency information
 */
export function parseFlakeLock(flakeLockFile) {
  const pkgList = [];
  const dependencies = [];

  if (!existsSync(flakeLockFile)) {
    return { pkgList, dependencies };
  }

  try {
    const lockContent = readFileSync(flakeLockFile, "utf-8");
    const lockData = JSON.parse(lockContent);

    if (lockData.nodes) {
      for (const [nodeName, nodeData] of Object.entries(lockData.nodes)) {
        if (nodeName === "root" || !nodeData.locked) continue;

        const locked = nodeData.locked;

        let version = "latest";
        if (locked.rev) {
          version = locked.rev.substring(0, 7);
        } else if (locked.ref) {
          version = locked.ref;
        }

        const pkg = {
          name: nodeName,
          version: version,
          description: `Nix flake dependency: ${nodeName}`,
          scope: "required",
          properties: [
            {
              name: "SrcFile",
              value: flakeLockFile,
            },
          ],
          evidence: {
            identity: {
              field: "purl",
              confidence: 1.0,
              methods: [
                {
                  technique: "manifest-analysis",
                  confidence: 1.0,
                  value: flakeLockFile,
                },
              ],
            },
          },
        };

        if (locked.narHash) {
          pkg.properties.push({
            name: "cdx:nix:nar_hash",
            value: locked.narHash,
          });
        }

        if (locked.lastModified) {
          pkg.properties.push({
            name: "cdx:nix:last_modified",
            value: locked.lastModified.toString(),
          });
        }

        if (locked.rev) {
          pkg.properties.push({
            name: "cdx:nix:revision",
            value: locked.rev,
          });
        }

        if (locked.ref) {
          pkg.properties.push({
            name: "cdx:nix:ref",
            value: locked.ref,
          });
        }

        pkg.purl = generateNixPurl(nodeName, version);
        pkg["bom-ref"] = pkg.purl;

        pkgList.push(pkg);
      }

      // Generate dependency relationships from root inputs
      if (lockData.nodes?.root?.inputs) {
        const rootInputs = Object.keys(lockData.nodes.root.inputs);
        if (rootInputs.length > 0) {
          dependencies.push({
            ref: "pkg:nix/flake@latest",
            dependsOn: rootInputs
              .map(
                (input) =>
                  pkgList.find((pkg) => pkg.name === input)?.["bom-ref"],
              )
              .filter(Boolean),
          });
        }
      }
    }
  } catch (error) {
    console.warn(`Failed to parse ${flakeLockFile}: ${error.message}`);
  }

  return { pkgList, dependencies };
}

/**
 * Generate a Nix PURL from input information
 *
 * @param {String} name Package name
 * @param {String} version Package version
 * @returns {String} PURL string
 */
function generateNixPurl(name, version) {
  // For now, use a generic nix PURL type
  // In the future, this could be more sophisticated based on the source type
  return `pkg:nix/${name}@${version}`;
}

/**
 * Method to parse .nuspec files
 *
 * @param {String} nupkgFile .nupkg file
 * @param {String} nuspecData Raw nuspec data
 * @returns {Object} Object containing package list and dependencies
 */
export function parseNuspecData(nupkgFile, nuspecData) {
  const pkgList = [];
  const pkg = { group: "" };
  let npkg;
  const dependenciesMap = {};
  const addedMap = {};
  try {
    npkg = xml2js(nuspecData, {
      compact: true,
      alwaysArray: false,
      spaces: 4,
      textKey: "_",
      attributesKey: "$",
      commentKey: "value",
    }).package;
  } catch (_e) {
    // If we are parsing with invalid encoding, unicode replacement character is used
    if (nuspecData.charCodeAt(0) === 65533) {
      console.log(`Unable to parse ${nupkgFile} in utf-8 mode`);
    } else {
      console.log(
        "Unable to parse this package. Tried utf-8 and ucs2 encoding.",
      );
    }
  }
  if (!npkg) {
    return {
      pkgList,
      dependenciesMap,
    };
  }
  const m = npkg.metadata;
  pkg.name = m.id._;
  pkg.version = m.version._;
  pkg.description = m.description._;
  pkg.purl = `pkg:nuget/${pkg.name}@${pkg.version}`;
  pkg["bom-ref"] = pkg.purl;
  if (m.licenseUrl) {
    pkg.license = findLicenseId(m.licenseUrl._);
  }
  if (m.authors) {
    pkg.author = m.authors._;
  }
  pkg.properties = [
    {
      name: "SrcFile",
      value: nupkgFile,
    },
  ];
  pkg.evidence = {
    identity: {
      field: "purl",
      confidence: 1,
      methods: [
        {
          technique: "binary-analysis",
          confidence: 1,
          value: nupkgFile,
        },
      ],
    },
  };
  pkg.scope = "required";
  pkgList.push(pkg);
  if (m?.dependencies?.dependency) {
    const dependsOn = [];
    if (Array.isArray(m.dependencies.dependency)) {
      for (const adep of m.dependencies.dependency) {
        const d = adep.$;
        dependsOn.push(d.id);
      }
    } else {
      const d = m.dependencies.dependency.$;
      dependsOn.push(d.id);
    }
    dependenciesMap[pkg["bom-ref"]] = dependsOn;
  } else if (m?.dependencies?.group) {
    let dependencyGroups;
    if (Array.isArray(m.dependencies.group)) {
      dependencyGroups = m.dependencies.group;
    } else {
      dependencyGroups = [m.dependencies.group];
    }
    const dependsOn = [];
    for (const agroup of dependencyGroups) {
      let targetFramework;
      if (agroup?.$?.targetFramework) {
        targetFramework = agroup.$.targetFramework;
      }
      if (agroup?.dependency) {
        let groupDependencies = [];
        // This dependency can be an array or object
        if (Array.isArray(agroup.dependency)) {
          groupDependencies = agroup.dependency;
        } else if (agroup?.dependency?.$) {
          groupDependencies = [agroup.dependency];
        }
        for (let agroupdep of groupDependencies) {
          agroupdep = agroupdep.$;
          const groupPkg = {};
          if (!agroupdep.id) {
            continue;
          }
          groupPkg.name = agroupdep.id;
          if (agroupdep?.version) {
            let versionStr = agroupdep.version;
            // version could have square brackets around them
            if (versionStr.startsWith("[") && versionStr.endsWith("]")) {
              versionStr = versionStr.replace(/[\[\]]/g, "");
            }
            groupPkg.version = versionStr;
            groupPkg.purl = `pkg:nuget/${groupPkg.name}@${versionStr}`;
          } else {
            groupPkg.purl = `pkg:nuget/${groupPkg.name}`;
          }
          groupPkg["bom-ref"] = groupPkg.purl;
          groupPkg.scope = "optional";
          groupPkg.properties = [
            {
              name: "SrcFile",
              value: nupkgFile,
            },
          ];
          if (targetFramework) {
            groupPkg.properties.push({
              name: "cdx:dotnet:target_framework",
              value: targetFramework,
            });
          }
          groupPkg.evidence = {
            identity: {
              field: "purl",
              confidence: 0.7,
              methods: [
                {
                  technique: "binary-analysis",
                  confidence: 1,
                  value: nupkgFile,
                },
              ],
            },
          };
          pkgList.push(groupPkg);
          if (!addedMap[groupPkg.purl]) {
            dependsOn.push(groupPkg.name);
            addedMap[groupPkg.purl] = true;
          }
        } // for
      } // group dependency block
      dependenciesMap[pkg["bom-ref"]] = dependsOn;
    } // for
  }
  return {
    pkgList,
    dependenciesMap,
  };
}

export function parseCsPkgData(pkgData, pkgFile) {
  const pkgList = [];
  if (!pkgData) {
    return pkgList;
  }
  // Remove byte order mark
  if (pkgData.charCodeAt(0) === 0xfeff) {
    pkgData = pkgData.slice(1);
  }
  let packages = xml2js(pkgData, {
    compact: true,
    alwaysArray: true,
    spaces: 4,
    textKey: "_",
    attributesKey: "$",
    commentKey: "value",
  }).packages;
  if (!packages || packages.length === 0) {
    return pkgList;
  }
  packages = packages[0].package;
  for (const i in packages) {
    const p = packages[i].$;
    const pkg = { group: "" };
    pkg.name = p.id;
    pkg.version = p.version;
    pkg.purl = `pkg:nuget/${pkg.name}@${pkg.version}`;
    pkg["bom-ref"] = pkg.purl;
    if (pkgFile) {
      pkg.properties = [
        {
          name: "SrcFile",
          value: pkgFile,
        },
      ];
      pkg.evidence = {
        identity: {
          field: "purl",
          confidence: 0.7,
          methods: [
            {
              technique: "manifest-analysis",
              confidence: 0.7,
              value: pkgFile,
            },
          ],
        },
      };
    }
    pkgList.push(pkg);
  }
  return pkgList;
}

/**
 * Method to parse .csproj like xml files
 *
 * @param {String} csProjData Raw data
 * @param {String} projFile File name
 * @param {Object} pkgNameVersions Package name - version map object
 *
 * @returns {Object} Containing parent component, package, and dependencies
 */
export function parseCsProjData(csProjData, projFile, pkgNameVersions = {}) {
  const pkgList = [];
  const parentComponent = { type: "application", properties: [] };
  if (!csProjData) {
    return pkgList;
  }
  // Remove byte order mark
  if (csProjData.charCodeAt(0) === 0xfeff) {
    csProjData = csProjData.slice(1);
  }
  const projectTargetFrameworks = [];
  let projects;
  try {
    projects = xml2js(csProjData, {
      compact: true,
      alwaysArray: true,
      spaces: 4,
      textKey: "_",
      attributesKey: "$",
      commentKey: "value",
    }).Project;
  } catch (_e) {
    console.log(`Unable to parse ${projFile} with utf-8 encoding!`);
  }
  if (!projects || projects.length === 0) {
    return pkgList;
  }
  const project = projects[0];
  let gacVersionWarningShown = false;
  // First make up a parentcomponent name based on the .csproj file name
  if (projFile) {
    parentComponent.name = basename(projFile).replaceAll(
      /.(cs|fs|vb|ts|plc|hmi)proj$/g,
      "",
    );
  }
  // Collect details about the parent component
  if (project?.PropertyGroup?.length) {
    for (const apg of project.PropertyGroup) {
      if (
        apg?.AssemblyName &&
        Array.isArray(apg.AssemblyName) &&
        apg.AssemblyName[0]._ &&
        Array.isArray(apg.AssemblyName[0]._)
      ) {
        parentComponent.name = apg.AssemblyName[0]._[0];
      } else if (
        apg?.Name &&
        Array.isArray(apg.Name) &&
        apg.Name[0]._ &&
        Array.isArray(apg.Name[0]._)
      ) {
        parentComponent.name = apg.Name[0]._[0];
      }
      if (
        apg?.ProductVersion &&
        Array.isArray(apg.ProductVersion) &&
        apg.ProductVersion[0]._ &&
        Array.isArray(apg.ProductVersion[0]._)
      ) {
        parentComponent.version = apg.ProductVersion[0]._[0];
      } else if (
        apg?.ProgramVersion &&
        Array.isArray(apg.ProgramVersion) &&
        apg.ProgramVersion[0]._ &&
        Array.isArray(apg.ProgramVersion[0]._)
      ) {
        parentComponent.version = apg.ProgramVersion[0]._[0];
      } else if (
        apg?.HmiVersion &&
        Array.isArray(apg.HmiVersion) &&
        apg.HmiVersion[0]._ &&
        Array.isArray(apg.HmiVersion[0]._)
      ) {
        parentComponent.version = apg.HmiVersion[0]._[0];
      }
      if (
        apg?.OutputType &&
        Array.isArray(apg.OutputType) &&
        apg.OutputType[0]._ &&
        Array.isArray(apg.OutputType[0]._)
      ) {
        if (apg.OutputType[0]._[0] === "Library") {
          parentComponent.type = "library";
          parentComponent.purl = `pkg:nuget/${parentComponent.name}@${
            parentComponent.version || "latest"
          }`;
        } else {
          parentComponent.purl = `pkg:nuget/${parentComponent.name}@${
            parentComponent.version || "latest"
          }?output_type=${apg.OutputType[0]._[0]}`;
        }
      }
      if (
        apg?.ProjectGuid &&
        Array.isArray(apg.ProjectGuid) &&
        apg.ProjectGuid[0]._ &&
        Array.isArray(apg.ProjectGuid[0]._)
      ) {
        parentComponent.properties.push({
          name: "cdx:dotnet:project_guid",
          value: apg.ProjectGuid[0]._[0],
        });
      }
      if (
        apg?.RootNamespace &&
        Array.isArray(apg.RootNamespace) &&
        apg.RootNamespace[0]._ &&
        Array.isArray(apg.RootNamespace[0]._)
      ) {
        parentComponent.properties.push({
          name: "Namespaces",
          value: apg.RootNamespace[0]._[0],
        });
      }
      if (
        apg?.TargetFramework &&
        Array.isArray(apg.TargetFramework) &&
        apg.TargetFramework[0]._ &&
        Array.isArray(apg.TargetFramework[0]._)
      ) {
        for (const apgtf of apg.TargetFramework[0]._) {
          projectTargetFrameworks.push(apgtf);
          parentComponent.properties.push({
            name: "cdx:dotnet:target_framework",
            value: apgtf,
          });
        }
      } else if (
        apg?.TargetFrameworkVersion &&
        Array.isArray(apg.TargetFrameworkVersion) &&
        apg.TargetFrameworkVersion[0]._ &&
        Array.isArray(apg.TargetFrameworkVersion[0]._)
      ) {
        for (const apgtf of apg.TargetFrameworkVersion[0]._) {
          projectTargetFrameworks.push(apgtf);
          parentComponent.properties.push({
            name: "cdx:dotnet:target_framework",
            value: apgtf,
          });
        }
      } else if (
        apg?.TargetFrameworks &&
        Array.isArray(apg.TargetFrameworks) &&
        apg.TargetFrameworks[0]._ &&
        Array.isArray(apg.TargetFrameworks[0]._)
      ) {
        for (const apgtf of apg.TargetFrameworks[0]._) {
          projectTargetFrameworks.push(apgtf);
          parentComponent.properties.push({
            name: "cdx:dotnet:target_framework",
            value: apgtf,
          });
        }
      }
      if (
        apg?.AzureFunctionsVersion &&
        Array.isArray(apg.AzureFunctionsVersion) &&
        apg.AzureFunctionsVersion[0]._ &&
        Array.isArray(apg.AzureFunctionsVersion[0]._)
      ) {
        parentComponent.properties.push({
          name: "cdx:dotnet:azure_functions_version",
          value: apg.AzureFunctionsVersion[0]._[0],
        });
      }
      if (
        apg?.Description &&
        Array.isArray(apg.Description) &&
        apg.Description[0]._ &&
        Array.isArray(apg.Description[0]._)
      ) {
        parentComponent.description = apg.Description[0]._[0];
      } else if (
        apg?.PackageDescription &&
        Array.isArray(apg.PackageDescription) &&
        apg.PackageDescription[0]._ &&
        Array.isArray(apg.PackageDescription[0]._)
      ) {
        parentComponent.description = apg.PackageDescription[0]._[0];
      }
    }
  }
  if (project.ItemGroup?.length) {
    for (const i in project.ItemGroup) {
      const item = project.ItemGroup[i];
      // .net core use PackageReference
      for (const j in item.PackageReference) {
        const pref = item.PackageReference[j].$;
        const pkg = { group: "" };
        if (!pref.Include || pref.Include.includes(".csproj")) {
          continue;
        }
        pkg.name = pref.Include;
        pkg.version = pref.Version || pkgNameVersions[pkg.name];
        pkg.purl = `pkg:nuget/${pkg.name}@${pkg.version}`;
        pkg["bom-ref"] = pkg.purl;
        if (projFile) {
          pkg.properties = [
            {
              name: "SrcFile",
              value: projFile,
            },
          ];
          pkg.evidence = {
            identity: {
              field: "purl",
              confidence: 0.7,
              methods: [
                {
                  technique: "manifest-analysis",
                  confidence: 0.7,
                  value: projFile,
                },
              ],
            },
          };
        }
        pkgList.push(pkg);
      }
      // .net framework use Reference
      for (const j in item.Reference) {
        const hintPaths = item.Reference[j]?.HintPath;
        let hintPath;
        let hintVersion;
        let assemblyName;
        let assemblyVersion;
        let packageFileName;

        if (hintPaths && Array.isArray(hintPaths)) {
          const tmpHintPathValues = hintPaths[0]._;
          if (Array.isArray(tmpHintPathValues)) {
            hintPath = tmpHintPathValues[0];
            packageFileName = basename(hintPath);
            if (packageFileName.includes("\\")) {
              packageFileName = packageFileName.split("\\").pop();
            }
          }
        }
        const pref = item.Reference[j].$;
        const pkg = { group: "" };
        if (!pref.Include || pref.Include.includes(".csproj")) {
          continue;
        }
        const incParts = pref.Include.split(",");
        pkg.name = incParts[0];
        pkg.properties = [];
        // Prefer the version from the hint path if available, falling back to assembly version
        if (hintPath) {
          const packageInfo = extractPackageInfoFromHintPath(hintPath);
          if (packageInfo) {
            hintVersion = packageInfo.version;
            // Assembly name is different to package name
            if (packageInfo.name && pkg.name !== packageInfo.name) {
              assemblyName = pkg.name;
              pkg.name = packageInfo.name;
            }
          }
        }
        if (incParts.length > 1 && incParts[1].includes("Version")) {
          assemblyVersion =
            incParts[1].replace("Version=", "").trim() ||
            pkgNameVersions[pkg.name];
        }
        const version = hintVersion ?? assemblyVersion;
        if (version) {
          pkg.version = version;
          pkg.purl = `pkg:nuget/${pkg.name}@${version}`;
        } else {
          pkg.purl = `pkg:nuget/${pkg.name}`;
          if (
            pkg.name.startsWith("System.") ||
            pkg.name.startsWith("Mono.") ||
            pkg.name.startsWith("Microsoft.")
          ) {
            // If this is a System package, then track the target frameworks
            for (const tf of projectTargetFrameworks) {
              pkg.properties.push({
                name: "cdx:dotnet:target_framework",
                value: tf,
              });
            }
            if (!gacVersionWarningShown && pkg.name.startsWith("System.")) {
              gacVersionWarningShown = true;
              console.log("*** Found system packages without a version ***");
              console.log(
                "Global Assembly Cache (GAC) dependencies must be included in the project's build output for version detection. Please follow the instructions in the README: https://github.com/cdxgen/cdxgen?tab=readme-ov-file#including-net-global-assembly-cache-dependencies-in-the-results.",
              );
              if (process.env?.CDXGEN_IN_CONTAINER === "true") {
                console.log(
                  "NOTE: cdxgen must be run in CLI mode from an environment identical to the production environment. Otherwise, the reported version numbers will correspond to the cdxgen container image instead of the target version!",
                );
              }
            }
          }
        }
        pkg["bom-ref"] = pkg.purl;
        if (assemblyName) {
          pkg.properties.push({
            name: "cdx:dotnet:assembly_name",
            value: assemblyName,
          });
        }
        if (hintVersion && assemblyVersion) {
          pkg.properties.push({
            name: "cdx:dotnet:assembly_version",
            value: assemblyVersion,
          });
        }
        if (projFile) {
          pkg.properties.push({
            name: "SrcFile",
            value: projFile,
          });
          pkg.evidence = {
            identity: {
              field: "purl",
              confidence: hintVersion ? 0.7 : 0.3,
              methods: [
                {
                  technique: "manifest-analysis",
                  confidence: hintVersion ? 0.7 : 0.3,
                  value: projFile,
                },
              ],
            },
          };
        }
        if (hintPath) {
          // The same component could be referred by a slightly different name.
          // Use the hint_path to figure out the aliases in such cases.
          // Example:
          // <Reference Include="Microsoft.AI.Agent.Intercept, Version=2.0.6.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35, processorArchitecture=MSIL">
          //   <HintPath>..\packages\Microsoft.ApplicationInsights.Agent.Intercept.2.0.6\lib\net45\Microsoft.AI.Agent.Intercept.dll</HintPath>
          // </Reference>
          // cdxgen would create two components Microsoft.AI.Agent.Intercept@2.0.6.0 and Microsoft.ApplicationInsights.Agent.Intercept@2.0.6
          // They're The Same Picture meme goes here
          pkg.properties.push({
            name: "cdx:dotnet:hint_path",
            value: hintPath,
          });
          pkg.properties.push({
            name: "PackageFiles",
            value: packageFileName,
          });
        }
        pkgList.push(pkg);
      }
    }
  }
  // If the parent still lacks a purl, add one based on the name and version
  if (parentComponent && !parentComponent.purl && parentComponent.name) {
    parentComponent.purl = `pkg:nuget/${parentComponent.name}@${
      parentComponent.version || "latest"
    }`;
  }
  if (parentComponent?.purl) {
    parentComponent["bom-ref"] = parentComponent.purl;
  }
  let dependencies = [];
  if (parentComponent?.["bom-ref"]) {
    dependencies = [
      {
        ref: parentComponent.purl,
        dependsOn: [...new Set(pkgList.map((p) => p["bom-ref"]))].sort(),
      },
    ];
  }
  return {
    pkgList,
    parentComponent,
    dependencies,
  };
}

export function parseCsProjAssetsData(csProjData, assetsJsonFile) {
  // extract name, operator, version from .NET package representation
  // like "NLog >= 4.5.0"
  function extractNameOperatorVersion(inputStr) {
    if (!inputStr) {
      return null;
    }
    const extractNameOperatorVersion = /([\w.-]+)\s*([><=!]+)\s*(.*)/;
    let match = inputStr.match(extractNameOperatorVersion);
    if (match) {
      return {
        name: match[1],
        operator: match[2],
        version: match[3],
      };
    }
    match = inputStr.split(" ");
    if (match && match.length === 3) {
      return {
        name: match[1],
        operator: match[2],
        version: match[3],
      };
    }
    return null;
  }

  const pkgList = [];
  const dependenciesList = [];
  let rootPkg = {};
  // This tracks the resolved version
  const pkgNameVersionMap = {};
  const pkgAddedMap = {};

  if (!csProjData) {
    return { pkgList, dependenciesList };
  }
  csProjData = JSON.parse(csProjData);
  let purlString;
  if (csProjData.project?.restore?.projectName) {
    purlString = new PackageURL(
      "nuget",
      "",
      csProjData.project?.restore?.projectName,
      csProjData.project.version || "latest",
      null,
      null,
    ).toString();
    rootPkg = {
      group: "",
      name: csProjData.project.restore.projectName,
      version: csProjData.project.version || "latest",
      type: "application",
      purl: purlString,
      "bom-ref": decodeURIComponent(purlString),
    };
    pkgList.push(rootPkg);
  }
  const rootPkgDeps = new Set();
  // create root pkg deps
  if (csProjData.targets && csProjData.projectFileDependencyGroups) {
    for (const frameworkTarget in csProjData.projectFileDependencyGroups) {
      for (const dependencyName of csProjData.projectFileDependencyGroups[
        frameworkTarget
      ]) {
        const nameOperatorVersion = extractNameOperatorVersion(dependencyName);
        if (nameOperatorVersion == null) {
          continue;
        }
        const targetNameVersion = `${nameOperatorVersion.name}/${nameOperatorVersion.version}`;
        let nameToUse = nameOperatorVersion.name;
        // Due to the difference in casing, we might arrive this case where a simple lookup doesn't succeed.
        // Instead of skipping, let's work harder to find a match.
        if (!csProjData.targets[frameworkTarget][targetNameVersion]) {
          let matchFound = false;
          for (const fkeys of Object.keys(
            csProjData.targets[frameworkTarget],
          )) {
            const tmpParts = fkeys.split("/");
            const tname = tmpParts[0];
            const tversion = tmpParts[1];
            if (
              tname.toLowerCase() === nameOperatorVersion.name.toLowerCase() &&
              tversion === nameOperatorVersion.version.replace("-*", "")
            ) {
              nameToUse = tname;
              matchFound = true;
              break;
            }
          }
          if (!matchFound) {
            if (DEBUG_MODE) {
              console.log(
                "Unable to match",
                dependencyName,
                "with a target name. The dependency tree will be imprecise.",
              );
            }
            continue;
          }
        }

        const dpurl = decodeURIComponent(
          new PackageURL(
            "nuget",
            "",
            nameToUse,
            nameOperatorVersion.version,
            null,
            null,
          ).toString(),
        );
        rootPkgDeps.add(dpurl);
      }
    }
    if (purlString && rootPkgDeps.size) {
      dependenciesList.push({
        ref: purlString,
        dependsOn: Array.from(rootPkgDeps).sort(),
      });
    }
  }

  if (csProjData.libraries && csProjData.targets) {
    const lib = csProjData.libraries;
    // Pass 1: Construct pkgList alone and track name and resolved version
    for (const framework in csProjData.targets) {
      for (const rootDep of Object.keys(csProjData.targets[framework])) {
        // if (rootDep.startsWith("runtime")){
        //   continue;
        // }
        const [name, version] = rootDep.split("/");
        const dpurl = new PackageURL(
          "nuget",
          "",
          name,
          version,
          null,
          null,
        ).toString();
        const pkg = {
          group: "",
          name: name,
          version: version,
          description: "",
          type: csProjData.targets[framework][rootDep].type,
          purl: dpurl,
          "bom-ref": decodeURIComponent(dpurl),
        };
        if (lib[rootDep]) {
          if (lib[rootDep].sha512) {
            pkg["_integrity"] = `sha512-${lib[rootDep].sha512}`;
          } else if (lib[rootDep].sha256) {
            pkg["_integrity"] = `sha256-${lib[rootDep].sha256}`;
          }
          if (lib[rootDep].files && Array.isArray(lib[rootDep].files)) {
            const dllFiles = new Set();
            lib[rootDep].files.forEach((f) => {
              if (
                f.endsWith(".dll") ||
                f.endsWith(".exe") ||
                f.endsWith(".so")
              ) {
                dllFiles.add(basename(f));
              }
            });
            pkg.properties = [
              {
                name: "SrcFile",
                value: assetsJsonFile,
              },
              {
                name: "PackageFiles",
                value: Array.from(dllFiles).join(", "),
              },
            ];
          }
        }
        if (assetsJsonFile) {
          pkg.evidence = {
            identity: {
              field: "purl",
              confidence: 1,
              methods: [
                {
                  technique: "manifest-analysis",
                  confidence: 1,
                  value: assetsJsonFile,
                },
              ],
            },
          };
        }
        pkgList.push(pkg);
        pkgNameVersionMap[name + framework] = version;
        pkgAddedMap[name] = true;
      }
    }
    // Pass 2: Fix the dependency tree
    for (const framework in csProjData.targets) {
      for (const rootDep of Object.keys(csProjData.targets[framework])) {
        const depList = new Set();
        const [name, version] = rootDep.split("/");
        const dpurl = decodeURIComponent(
          new PackageURL("nuget", "", name, version, null, null).toString(),
        );
        const dependencies =
          csProjData.targets[framework][rootDep].dependencies;
        if (dependencies) {
          for (const p of Object.keys(dependencies)) {
            // This condition is not required for assets json that are well-formed.
            if (!pkgNameVersionMap[p + framework]) {
              continue;
            }
            const dversion = pkgNameVersionMap[p + framework];
            const ipurl = new PackageURL(
              "nuget",
              "",
              p,
              dversion,
              null,
              null,
            ).toString();
            depList.add(ipurl);
            if (!pkgAddedMap[p]) {
              pkgList.push({
                group: "",
                name: p,
                version: dversion,
                description: "",
                purl: ipurl,
                "bom-ref": decodeURIComponent(ipurl),
              });
              pkgAddedMap[p] = true;
            }
          }
        }
        dependenciesList.push({
          ref: dpurl,
          dependsOn: Array.from(depList).sort(),
        });
      }
    }
  }
  return {
    pkgList,
    dependenciesList,
  };
}

export function parseCsPkgLockData(csLockData, pkgLockFile) {
  const pkgList = [];
  const dependenciesList = [];
  const rootList = [];
  let pkg = null;
  if (!csLockData) {
    return {
      pkgList,
      dependenciesList,
      rootList,
    };
  }
  const assetData = JSON.parse(csLockData);
  if (!assetData || !assetData.dependencies) {
    return {
      pkgList,
      dependenciesList,
      rootList,
    };
  }
  for (const aversion of Object.keys(assetData.dependencies)) {
    for (const alib of Object.keys(assetData.dependencies[aversion])) {
      const libData = assetData.dependencies[aversion][alib];
      const purl = new PackageURL(
        "nuget",
        "",
        alib,
        libData.resolved,
        null,
        null,
      ).toString();
      pkg = {
        group: "",
        name: alib,
        version: libData.resolved,
        purl,
        "bom-ref": decodeURIComponent(purl),
        _integrity: libData.contentHash
          ? `sha512-${libData.contentHash}`
          : undefined,
        properties: [
          {
            name: "SrcFile",
            value: pkgLockFile,
          },
        ],
        evidence: {
          identity: {
            field: "purl",
            confidence: 1,
            methods: [
              {
                technique: "manifest-analysis",
                confidence: 1,
                value: pkgLockFile,
              },
            ],
          },
        },
      };
      pkgList.push(pkg);
      if (["Direct", "Project"].includes(libData.type)) {
        rootList.push(pkg);
      }
      const dependsOn = new Set();
      if (libData.dependencies) {
        for (let adep of Object.keys(libData.dependencies)) {
          let adepResolvedVersion = libData.dependencies[adep];
          const aversionNoRuntime = aversion.split("/")[0];
          // Try to get the resolved version of the dependency. See #930 and #937
          if (assetData.dependencies[aversion]?.[adep]?.resolved) {
            adepResolvedVersion =
              assetData.dependencies[aversion][adep].resolved;
          } else if (
            aversion.includes("/") &&
            assetData.dependencies[aversionNoRuntime] &&
            assetData.dependencies[aversionNoRuntime][adep] &&
            assetData.dependencies[aversionNoRuntime][adep].resolved
          ) {
            adepResolvedVersion =
              assetData.dependencies[aversionNoRuntime][adep].resolved;
          } else if (
            (assetData.dependencies[aversion]?.[adep.toLowerCase()] &&
              assetData.dependencies[aversion][adep.toLowerCase()].type ===
                "Project") ||
            (assetData.dependencies[aversionNoRuntime]?.[adep.toLowerCase()] &&
              assetData.dependencies[aversionNoRuntime][adep.toLowerCase()]
                .type === "Project")
          ) {
            adepResolvedVersion = undefined;
            adep = adep.toLowerCase();
          } else if (DEBUG_MODE) {
            console.warn(
              `Unable to find the resolved version for ${adep} ${aversion}. Using ${adepResolvedVersion} which may be incorrect.`,
            );
          }
          const adpurl = new PackageURL(
            "nuget",
            "",
            adep,
            adepResolvedVersion,
            null,
            null,
          ).toString();
          dependsOn.add(decodeURIComponent(adpurl));
        }
      }
      dependenciesList.push({
        ref: decodeURIComponent(purl),
        dependsOn: [...dependsOn].sort(),
      });
    }
  }
  return {
    pkgList,
    dependenciesList,
    rootList,
  };
}

export function parsePaketLockData(paketLockData, pkgLockFile) {
  const pkgList = [];
  const dependenciesList = [];
  const dependenciesMap = {};
  const pkgNameVersionMap = {};
  let group = null;
  let pkg = null;
  if (!paketLockData) {
    return { pkgList, dependenciesList };
  }

  const packages = paketLockData.split("\n");
  const groupRegex = /^GROUP\s(\S*)$/;
  const pkgRegex = /^\s{4}([\w.-]+) \(((?=.*?\.)[\w.-]+)\)/;
  const depRegex = /^\s{6}([\w.-]+) \([><= \w.-]+\)/;

  // Gather all packages
  packages.forEach((l) => {
    let match = l.match(groupRegex);
    if (match) {
      group = match[1];
      return;
    }

    match = l.match(pkgRegex);
    if (match) {
      const name = match[1];
      const version = match[2];
      const purl = new PackageURL(
        "nuget",
        "",
        name,
        version,
        null,
        null,
      ).toString();
      pkg = {
        group: "",
        name,
        version,
        purl,
        "bom-ref": decodeURIComponent(purl),
        properties: [
          {
            name: "SrcFile",
            value: pkgLockFile,
          },
        ],
        evidence: {
          identity: {
            field: "purl",
            confidence: 1,
            methods: [
              {
                technique: "manifest-analysis",
                confidence: 1,
                value: pkgLockFile,
              },
            ],
          },
        },
      };
      pkgList.push(pkg);
      dependenciesMap[purl] = new Set();
      pkgNameVersionMap[name + group] = version;
    }
  });

  let purl = null;
  group = null;

  // Construct the dependency tree
  packages.forEach((l) => {
    let match = l.match(groupRegex);
    if (match) {
      group = match[1];
      return;
    }

    match = l.match(pkgRegex);
    if (match) {
      const pkgName = match[1];
      const pkgVersion = match[2];
      purl = decodeURIComponent(
        new PackageURL("nuget", "", pkgName, pkgVersion, null, null).toString(),
      );
      return;
    }

    match = l.match(depRegex);
    if (match) {
      const depName = match[1];
      const depVersion = pkgNameVersionMap[depName + group];
      const dpurl = decodeURIComponent(
        new PackageURL("nuget", "", depName, depVersion, null, null).toString(),
      );
      dependenciesMap[purl].add(dpurl);
    }
  });

  for (const ref in dependenciesMap) {
    dependenciesList.push({
      ref: ref,
      dependsOn: Array.from(dependenciesMap[ref]).sort(),
    });
  }

  return {
    pkgList,
    dependenciesList,
  };
}

/**
 * Parse composer.json file
 *
 * @param {string} composerJsonFile composer.json file
 *
 * @returns {Object} Object with rootRequires and parent component
 */
export function parseComposerJson(composerJsonFile) {
  const moduleParent = {};
  const composerData = JSON.parse(
    readFileSync(composerJsonFile, { encoding: "utf-8" }),
  );
  const rootRequires = {
    ...composerData.require,
    ...composerData["require-dev"],
  };
  const pkgName = composerData.name;
  if (pkgName) {
    moduleParent.group = dirname(pkgName);
    if (moduleParent.group === ".") {
      moduleParent.group = "";
    }
    moduleParent.name = basename(pkgName);
    moduleParent.type = "application";
    moduleParent.version = composerData.version;
    if (composerData.description) {
      moduleParent.description = composerData.description;
    }
    if (composerData.license) {
      moduleParent.licenses = getLicenses({
        expression: composerData.license,
      });
    }
    moduleParent.purl = new PackageURL(
      "composer",
      moduleParent.group,
      moduleParent.name,
      moduleParent.version,
      null,
      null,
    ).toString();
    moduleParent["bom-ref"] = decodeURIComponent(moduleParent.purl);
  }
  return { rootRequires, moduleParent };
}

/**
 * Parse composer lock file
 *
 * @param {string} pkgLockFile composer.lock file
 * @param {array} rootRequires require section from composer.json
 */
export function parseComposerLock(pkgLockFile, rootRequires) {
  const pkgList = [];
  const dependenciesList = [];
  const dependenciesMap = {};
  const pkgNamePurlMap = {};
  const rootList = [];
  const rootRequiresMap = {};
  if (rootRequires) {
    for (const rr of Object.keys(rootRequires)) {
      rootRequiresMap[rr] = true;
    }
  }
  if (safeExistsSync(pkgLockFile)) {
    let lockData = {};
    try {
      lockData = JSON.parse(readFileSync(pkgLockFile, { encoding: "utf-8" }));
    } catch (_e) {
      console.error("Invalid composer.lock file:", pkgLockFile);
      return [];
    }
    if (lockData) {
      const packages = {};
      if (lockData["packages"]) {
        packages["required"] = lockData["packages"];
      }
      if (lockData["packages-dev"]) {
        packages["optional"] = lockData["packages-dev"];
      }
      // Pass 1: Collect all packages
      for (const compScope in packages) {
        for (const i in packages[compScope]) {
          const pkg = packages[compScope][i];
          // Be extra cautious. Potential fix for #236
          if (!pkg || !pkg.name || !pkg.version) {
            continue;
          }

          let group = dirname(pkg.name);
          if (group === ".") {
            group = "";
          }
          const name = basename(pkg.name);
          const purl = new PackageURL(
            "composer",
            group,
            name,
            pkg.version?.toString(),
            null,
            null,
          ).toString();
          const apkg = {
            group: group,
            name: name,
            purl,
            "bom-ref": decodeURIComponent(purl),
            version: pkg.version?.toString(),
            repository: pkg.source,
            license: pkg.license,
            description: pkg.description,
            scope: compScope,
            properties: [
              {
                name: "SrcFile",
                value: pkgLockFile,
              },
            ],
            evidence: {
              identity: {
                field: "purl",
                confidence: 1,
                methods: [
                  {
                    technique: "manifest-analysis",
                    confidence: 1,
                    value: pkgLockFile,
                  },
                ],
              },
            },
          };
          if (pkg?.dist?.url) {
            // Replace placeholders like %prettyVersion% with actual version
            let distUrl = pkg.dist.url;
            if (
              distUrl.includes("%prettyVersion%") ||
              distUrl.includes("%version%")
            ) {
              const version = pkg.version || "unknown";
              distUrl = distUrl
                .replace(/%prettyVersion%/g, version)
                .replace(/%version%/g, version);
            }
            apkg.distribution = { url: distUrl };
          }
          if (pkg?.authors?.length) {
            apkg.authors = pkg.authors.map((a) => {
              return { name: a.name, email: a.email };
            });
          }
          if (pkg?.keywords?.length) {
            apkg.tags = pkg.keywords;
          }
          if (pkg.autoload && Object.keys(pkg.autoload).length) {
            const namespaces = [];
            for (const aaload of Object.keys(pkg.autoload)) {
              if (aaload.startsWith("psr")) {
                for (const ans of Object.keys(pkg.autoload[aaload])) {
                  namespaces.push(ans.trim());
                }
              }
            }
            if (namespaces.length) {
              apkg.properties.push({
                name: "Namespaces",
                value: namespaces.join(", "),
              });
            }
          }
          pkgList.push(apkg);
          dependenciesMap[purl] = new Set();
          pkgNamePurlMap[pkg.name] = purl;
          // Add this package to the root list if needed
          if (rootRequiresMap[pkg.name]) {
            rootList.push(apkg);
          }
        }
      }
      // Pass 2: Construct dependency tree
      for (const compScope in packages) {
        for (const i in packages[compScope]) {
          const pkg = packages[compScope][i];
          if (!pkg || !pkg.name || !pkg.version) {
            continue;
          }
          if (!pkg.require || !Object.keys(pkg.require).length) {
            continue;
          }
          const purl = pkgNamePurlMap[pkg.name];
          for (const adepName of Object.keys(pkg.require)) {
            if (pkgNamePurlMap[adepName]) {
              dependenciesMap[purl].add(pkgNamePurlMap[adepName]);
            }
          }
        }
      }
    }
  }
  for (const ref in dependenciesMap) {
    dependenciesList.push({
      ref: ref,
      dependsOn: Array.from(dependenciesMap[ref]).sort(),
    });
  }
  return {
    pkgList,
    dependenciesList,
    rootList,
  };
}

export function parseSbtTree(sbtTreeFile) {
  const pkgList = [];
  const dependenciesList = [];
  const keys_cache = {};
  const level_trees = {};
  const tmpA = readFileSync(sbtTreeFile, { encoding: "utf-8" }).split("\n");
  let last_level = 0;
  let last_purl = "";
  let stack = [];
  let first_purl = "";
  tmpA.forEach((l) => {
    l = l.replace("\r", "");
    // Ignore evicted packages and packages with multiple version matches indicated with a comma
    // | +-org.scala-lang:scala3-library_3:3.1.3 (evicted by: 3.3.0)
    // | | | | | | +-org.eclipse.platform:org.eclipse.equinox.common:[3.15.100,4.0...
    // | | | | | | | +-org.eclipse.platform:org.eclipse.equinox.common:3.17.100 (ev..
    if (l.includes("(evicted") || l.includes(",")) {
      return;
    }
    let level = 0;
    let isLibrary = false;
    if (l.startsWith("  ")) {
      level = l.split("|").length;
    }
    // This will skip blank lines such as "| | | | | | | "
    if (level > 0 && !l.includes("+-")) {
      return;
    }
    if (l.endsWith("[S]")) {
      isLibrary = true;
    }
    const tmpB = l.split("+-");
    const pkgLine = tmpB[tmpB.length - 1].split(" ")[0];
    if (!pkgLine.includes(":")) {
      return;
    }
    const pkgParts = pkgLine.split(":");
    let group = "";
    let name = "";
    let version = "";
    if (pkgParts.length === 3) {
      group = pkgParts[0];
      name = pkgParts[1];
      version = pkgParts[2];
    } else if (pkgParts.length === 2) {
      // unlikely for scala
      name = pkgParts[0];
      version = pkgParts[1];
    }
    if (!name?.length) {
      console.log(pkgLine, "was not parsed correctly!");
      return;
    }
    const purlString = new PackageURL(
      "maven",
      group,
      name,
      version,
      { type: "jar" },
      null,
    ).toString();
    // Filter duplicates
    if (!keys_cache[purlString]) {
      const adep = {
        group,
        name,
        version,
        purl: purlString,
        "bom-ref": decodeURIComponent(purlString),
        evidence: {
          identity: {
            field: "purl",
            confidence: 1,
            methods: [
              {
                technique: "manifest-analysis",
                confidence: 1,
                value: sbtTreeFile,
              },
            ],
          },
        },
      };
      if (isLibrary) {
        adep["type"] = "library";
      }
      pkgList.push(adep);
      keys_cache[purlString] = true;
    }
    // From here the logic is similar to parsing gradle tree
    if (!level_trees[purlString]) {
      level_trees[purlString] = [];
    }
    if (level === 0) {
      first_purl = purlString;
      stack = [first_purl];
      stack.push(purlString);
    } else if (last_purl === "") {
      stack.push(purlString);
    } else if (level > last_level) {
      const cnodes = level_trees[last_purl] || [];
      if (!cnodes.includes(purlString)) {
        cnodes.push(purlString);
      }
      level_trees[last_purl] = cnodes;
      if (stack[stack.length - 1] !== purlString) {
        stack.push(purlString);
      }
    } else {
      for (let i = level; i <= last_level; i++) {
        stack.pop();
      }
      const last_stack =
        stack.length > 0 ? stack[stack.length - 1] : first_purl;
      const cnodes = level_trees[last_stack] || [];
      if (!cnodes.includes(purlString)) {
        cnodes.push(purlString);
      }
      level_trees[last_stack] = cnodes;
      stack.push(purlString);
    }
    last_level = level;
    last_purl = purlString;
  });
  for (const lk of Object.keys(level_trees)) {
    dependenciesList.push({
      ref: lk,
      dependsOn: [...new Set(level_trees[lk])].sort(),
    });
  }
  return { pkgList, dependenciesList };
}

/**
 * Parse sbt lock file
 *
 * @param {string} pkgLockFile build.sbt.lock file
 */
export function parseSbtLock(pkgLockFile) {
  const pkgList = [];
  if (safeExistsSync(pkgLockFile)) {
    const lockData = JSON.parse(
      readFileSync(pkgLockFile, { encoding: "utf-8" }),
    );
    if (lockData?.dependencies) {
      for (const pkg of lockData.dependencies) {
        const artifacts = pkg.artifacts || undefined;
        let integrity = "";
        if (artifacts?.length) {
          integrity = artifacts[0].hash.replace("sha1:", "sha1-");
        }
        let compScope;
        if (pkg.configurations) {
          if (pkg.configurations.includes("runtime")) {
            compScope = "required";
          } else {
            compScope = "optional";
          }
        }
        pkgList.push({
          group: pkg.org,
          name: pkg.name,
          version: pkg.version,
          _integrity: integrity,
          scope: compScope,
          properties: [
            {
              name: "SrcFile",
              value: pkgLockFile,
            },
          ],
          evidence: {
            identity: {
              field: "purl",
              confidence: 1,
              methods: [
                {
                  technique: "manifest-analysis",
                  confidence: 1,
                  value: pkgLockFile,
                },
              ],
            },
          },
        });
      }
    }
  }
  return pkgList;
}

function convertStdoutToList(result) {
  if (result.status !== 0 || result.error) {
    return undefined;
  }
  const stdout = result.stdout;
  if (stdout) {
    const cmdOutput = Buffer.from(stdout).toString();
    return cmdOutput
      .trim()
      .toLowerCase()
      .split("\n")
      .filter((p) => p.length > 2 && p.includes("."))
      .sort();
  }
  return undefined;
}

/**
 * Method to execute dpkg --listfiles to determine the files provided by a given package
 *
 * @param {string} pkgName deb package name
 * @returns
 */
export function executeDpkgList(pkgName) {
  const result = safeSpawnSync("dpkg", ["--listfiles", "--no-pager", pkgName]);
  return convertStdoutToList(result);
}

/**
 * Method to execute dnf repoquery to determine the files provided by a given package
 *
 * @param {string} pkgName deb package name
 * @returns
 */
export function executeRpmList(pkgName) {
  let result = safeSpawnSync("dnf", ["repoquery", "-l", pkgName]);
  // Fallback to rpm
  if (result.status !== 0 || result.error) {
    result = safeSpawnSync("rpm", ["-ql", pkgName]);
  }
  return convertStdoutToList(result);
}

/**
 * Method to execute apk -L info to determine the files provided by a given package
 *
 * @param {string} pkgName deb package name
 * @returns
 */
export function executeApkList(pkgName) {
  const result = safeSpawnSync("apk", ["-L", "info", pkgName]);
  return convertStdoutToList(result);
}

/**
 * Method to execute alpm -Ql to determine the files provided by a given package
 *
 * @param {string} pkgName deb package name
 * @returns
 */
export function executeAlpmList(pkgName) {
  const result = safeSpawnSync("pacman", ["-Ql", pkgName]);
  return convertStdoutToList(result);
}

/**
 * Method to execute equery files to determine the files provided by a given package
 *
 * @param {string} pkgName deb package name
 * @returns
 */
export function executeEqueryList(pkgName) {
  const result = safeSpawnSync("equery", ["files", pkgName]);
  return convertStdoutToList(result);
}

/**
 * Convert OS query results
 *
 * @param {string} queryCategory Query category
 * @param {Object} queryObj Query Object from the queries.json configuration
 * @param {Array} results Query Results
 * @param {Boolean} enhance Optionally enhance results by invoking additional package manager commands
 */
export function convertOSQueryResults(
  queryCategory,
  queryObj,
  results,
  enhance = false,
) {
  const pkgList = [];
  if (results?.length) {
    for (const res of results) {
      const version =
        res.version ||
        res.hotfix_id ||
        res.hardware_version ||
        res.port ||
        res.pid ||
        res.subject_key_id ||
        res.interface ||
        res.instance_id;
      let name =
        res.name ||
        res.device_id ||
        res.hotfix_id ||
        res.uuid ||
        res.serial ||
        res.pid ||
        res.address ||
        res.ami_id ||
        res.interface ||
        res.client_app_id;
      let group = "";
      const subpath = res.path || res.admindir || res.source;
      let publisher =
        res.publisher ||
        res.maintainer ||
        res.creator ||
        res.manufacturer ||
        res.provider ||
        "";
      if (publisher === "null") {
        publisher = "";
      }
      let scope;
      const compScope = res.priority;
      if (["required", "optional", "excluded"].includes(compScope)) {
        scope = compScope;
      }
      const description =
        res.description ||
        res.summary ||
        res.arguments ||
        res.device ||
        res.codename ||
        res.section ||
        res.status ||
        res.identifier ||
        res.components ||
        "";
      // Re-use the name from query obj
      if (!name && results.length === 1 && queryObj.name) {
        name = queryObj.name;
      }
      let qualifiers;
      if (res.identifying_number?.length) {
        qualifiers = {
          tag_id: res.identifying_number.replace("{", "").replace("}", ""),
        };
      }
      if (name) {
        name = name
          .replace(/ /g, "+")
          .replace(/[:%]/g, "-")
          .replace(/^[@{]/g, "")
          .replace(/[}]$/g, "");
        group = group
          .replace(/ /g, "+")
          .replace(/[:%]/g, "-")
          .replace(/^[@{]/g, "")
          .replace(/[}]$/g, "");
        const purl = new PackageURL(
          queryObj.purlType || "swid",
          group,
          name,
          version || "",
          qualifiers,
          subpath,
        ).toString();
        const props = [{ name: "cdx:osquery:category", value: queryCategory }];
        let providesList;
        if (enhance) {
          switch (queryObj.purlType) {
            case "deb":
              providesList = executeDpkgList(name);
              break;
            case "rpm":
              providesList = executeRpmList(name);
              break;
            case "apk":
              providesList = executeApkList(name);
              break;
            case "ebuild":
              providesList = executeEqueryList(name);
              break;
            case "alpm":
              providesList = executeAlpmList(name);
              break;
            default:
              break;
          }
        }
        if (providesList) {
          props.push({ name: "PkgProvides", value: providesList.join(", ") });
        }
        const apkg = {
          name,
          group,
          version: version || "",
          description,
          publisher,
          "bom-ref": decodeURIComponent(purl),
          purl,
          scope,
          type: queryObj.componentType,
        };
        for (const k of Object.keys(res).filter(
          (p) => !["name", "version", "description", "publisher"].includes(p),
        )) {
          if (res[k] && res[k] !== "null") {
            props.push({
              name: k,
              value: res[k],
            });
          }
        }
        apkg.properties = props;
        pkgList.push(apkg);
      }
    }
  }
  return pkgList;
}

export function purlFromUrlString(type, repoUrl, version) {
  let namespace = "";
  let name;
  if (repoUrl?.startsWith("http")) {
    const url = new URL(repoUrl);
    const pathnameParts = url.pathname.split("/");
    const pathnameLastElement = pathnameParts.pop(); // pop() returns last element and removes it from pathnameParts
    name = pathnameLastElement.replace(".git", "");
    const urlpath = pathnameParts.join("/");
    namespace = url.hostname + urlpath;
  } else if (repoUrl?.startsWith("git@")) {
    const parts = repoUrl.split(":");
    const hostname = parts[0].split("@")[1];
    const pathnameParts = parts[1].split("/");
    const pathnameLastElement = pathnameParts.pop();
    name = pathnameLastElement.replace(".git", "");
    const urlpath = pathnameParts.join("/");
    namespace = `${hostname}/${urlpath}`;
  } else if (repoUrl?.startsWith("ssh://git@bitbucket")) {
    repoUrl = repoUrl.replace("ssh://git@", "");
    const parts = repoUrl.split(":");
    const hostname = parts[0];
    const pathnameParts = parts[1].split("/").slice(1);
    const pathnameLastElement = pathnameParts.pop();
    name = pathnameLastElement.replace(".git", "");
    const urlpath = pathnameParts.join("/");
    namespace = `${hostname}/${urlpath}`;
  } else if (repoUrl?.startsWith("/")) {
    const parts = repoUrl.split("/");
    name = parts[parts.length - 1] || "unknown";
    if (type === "swift") {
      namespace = "local";
    }
  } else {
    if (DEBUG_MODE) {
      console.warn("unsupported repo url for swift type");
    }
    return undefined;
  }

  return new PackageURL(type, namespace, name, version, null, null);
}

/**
 * Parse swift dependency tree output json object
 *
 * @param {Array} pkgList Package list
 * @param {Array} dependenciesList Dependencies
 * @param {string} jsonObject Swift dependencies json object
 * @param {string} pkgFile Package.swift file
 */
export function parseSwiftJsonTreeObject(
  pkgList,
  dependenciesList,
  jsonObject,
  pkgFile,
) {
  let purl;
  const urlOrPath = jsonObject.url || jsonObject.path;
  if (jsonObject?.url?.startsWith("http")) {
    const version = jsonObject.version;
    purl = purlFromUrlString("swift", urlOrPath, version);
  } else {
    purl = new PackageURL(
      "swift",
      "",
      jsonObject.name,
      jsonObject.version,
      null,
      null,
    );
  }
  const purlString = decodeURIComponent(purl.toString());
  const rootPkg = {
    name: purl.name,
    group: purl.namespace,
    version: purl.version,
    purl: purlString,
    "bom-ref": purlString,
  };
  const properties = [];
  if (jsonObject.name && jsonObject.name !== rootPkg.name) {
    properties.push({
      name: "cdx:swift:packageName",
      value: jsonObject.name,
    });
  }
  if (jsonObject?.path?.includes("checkouts")) {
    const relativeCheckoutPath = relative(dirname(pkgFile), jsonObject.path);
    if (!relativeCheckoutPath.startsWith("..")) {
      properties.push({
        name: "cdx:swift:localCheckoutPath",
        value: relativeCheckoutPath,
      });
    }
  }
  if (urlOrPath) {
    if (urlOrPath.startsWith("http")) {
      rootPkg.repository = { url: urlOrPath };
    } else {
      rootPkg.type = "application";
      properties.push({
        name: "SrcPath",
        value: urlOrPath,
      });
      if (pkgFile) {
        properties.push({
          name: "SrcFile",
          value: pkgFile,
        });
      }
    }
  }
  if (properties.length) {
    rootPkg.properties = properties;
  }
  pkgList.push(rootPkg);
  const depList = new Set();
  if (jsonObject.dependencies) {
    for (const dependency of jsonObject.dependencies) {
      const res = parseSwiftJsonTreeObject(
        pkgList,
        dependenciesList,
        dependency,
        pkgFile,
      );
      depList.add(res);
    }
  }
  dependenciesList.push({
    ref: purlString,
    dependsOn: [...depList].sort(),
  });
  return purlString;
}

/**
 * Parse swift dependency tree output
 * @param {string} rawOutput Swift dependencies json output
 * @param {string} pkgFile Package.swift file
 */
export function parseSwiftJsonTree(rawOutput, pkgFile) {
  if (!rawOutput) {
    return {};
  }
  const pkgList = [];
  const dependenciesList = [];
  try {
    const jsonData = JSON.parse(rawOutput);
    parseSwiftJsonTreeObject(pkgList, dependenciesList, jsonData, pkgFile);
  } catch (e) {
    if (DEBUG_MODE) {
      console.log(e);
    }
    return {};
  }
  const rootList = pkgList.filter((p) => p.type === "application");
  return {
    rootList,
    pkgList,
    dependenciesList,
  };
}

/**
 * Parse swift package resolved file
 * @param {string} resolvedFile Package.resolved file
 */
export function parseSwiftResolved(resolvedFile) {
  const pkgList = [];
  if (safeExistsSync(resolvedFile)) {
    try {
      const pkgData = JSON.parse(
        readFileSync(resolvedFile, { encoding: "utf-8" }),
      );
      let resolvedList = [];
      if (pkgData.pins) {
        resolvedList = pkgData.pins;
      } else if (pkgData.object?.pins) {
        resolvedList = pkgData.object.pins;
      }
      for (const adep of resolvedList) {
        const locationOrUrl = adep.location || adep.repositoryURL;
        const version = adep.state.version || adep.state.revision;
        const purl = purlFromUrlString("swift", locationOrUrl, version);
        const purlString = decodeURIComponent(purl.toString());
        const rootPkg = {
          name: purl.name,
          group: purl.namespace,
          version: purl.version,
          purl: purlString,
          "bom-ref": purlString,
          properties: [
            {
              name: "SrcFile",
              value: resolvedFile,
            },
          ],
          evidence: {
            identity: {
              field: "purl",
              confidence: 1,
              methods: [
                {
                  technique: "manifest-analysis",
                  confidence: 1,
                  value: resolvedFile,
                },
              ],
            },
          },
        };
        if (locationOrUrl) {
          rootPkg.repository = { url: locationOrUrl };
        }
        pkgList.push(rootPkg);
      }
    } catch (_err) {
      // continue regardless of error
    }
  }
  return pkgList;
}

/**
 * Collect maven dependencies
 *
 * @param {string} mavenCmd Maven command to use
 * @param {string} basePath Path to the maven project
 * @param {boolean} cleanup Remove temporary directories
 * @param {boolean} includeCacheDir Include maven and gradle cache directories
 */
export async function collectMvnDependencies(
  mavenCmd,
  basePath,
  cleanup = true,
  includeCacheDir = false,
) {
  let jarNSMapping = {};
  const MAVEN_CACHE_DIR =
    process.env.MAVEN_CACHE_DIR || join(homedir(), ".m2", "repository");
  const tempDir = mkdtempSync(join(tmpdir(), "mvn-deps-"));
  let copyArgs = [
    "dependency:copy-dependencies",
    `-DoutputDirectory=${tempDir}`,
    "-U",
    "-Dmdep.copyPom=true",
    "-Dmdep.useRepositoryLayout=true",
    "-Dmdep.includeScope=compile",
    `-Dmdep.prependGroupId=${process.env.MAVEN_PREPEND_GROUP || "false"}`,
    `-Dmdep.stripVersion=${process.env.MAVEN_STRIP_VERSION || "false"}`,
  ];
  if (process.env.MVN_ARGS) {
    const addArgs = process.env.MVN_ARGS.split(" ");
    copyArgs = copyArgs.concat(addArgs);
  }
  if (basePath && basePath !== MAVEN_CACHE_DIR) {
    console.log(`Executing '${mavenCmd} in ${basePath}`);
    const result = safeSpawnSync(mavenCmd, copyArgs, {
      cwd: basePath,
      shell: isWin,
    });
    if (result.status !== 0 || result.error) {
      console.error(result.stderr, result.error);
      console.log(
        "You can try the following remediation tips to resolve this error:\n",
      );
      console.log(
        "1. Check if the correct version of maven is installed and available in the PATH. Check if the environment variable MVN_ARGS needs to be set.",
      );
      console.log(
        "2. Perform 'mvn compile package' before invoking this command. Fix any errors found during this invocation.",
      );
      console.log(
        "3. Ensure the temporary directory is available and has sufficient disk space to copy all the artifacts.",
      );
    } else {
      jarNSMapping = await collectJarNS(tempDir);
    }
  }
  if (includeCacheDir || basePath === MAVEN_CACHE_DIR) {
    // slow operation
    jarNSMapping = await collectJarNS(MAVEN_CACHE_DIR);
  }

  // Clean up
  if (cleanup && tempDir && tempDir.startsWith(tmpdir()) && rmSync) {
    rmSync(tempDir, { recursive: true, force: true });
  }
  return jarNSMapping;
}

export async function collectGradleDependencies(
  _gradleCmd,
  _basePath,
  _cleanup = true, // eslint-disable-line no-unused-vars
  _includeCacheDir = false, // eslint-disable-line no-unused-vars
) {
  // HELP WANTED: We need an init script that mimics maven copy-dependencies that only collects the project specific jars and poms
  // Construct gradle cache directory
  let GRADLE_CACHE_DIR =
    process.env.GRADLE_CACHE_DIR ||
    join(homedir(), ".gradle", "caches", "modules-2", "files-2.1");
  if (process.env.GRADLE_USER_HOME) {
    GRADLE_CACHE_DIR = join(
      process.env.GRADLE_USER_HOME,
      "caches",
      "modules-2",
      "files-2.1",
    );
  }
  if (DEBUG_MODE) {
    console.log("Collecting jars from", GRADLE_CACHE_DIR);
    console.log(
      "To improve performance, ensure only the project dependencies are present in this cache location.",
    );
  }
  const pomPathMap = {};
  const pomFiles = getAllFiles(GRADLE_CACHE_DIR, "**/*.pom");
  for (const apom of pomFiles) {
    pomPathMap[basename(apom)] = apom;
  }
  return await collectJarNS(GRADLE_CACHE_DIR, pomPathMap);
}

/**
 * Method to collect class names from all jars in a directory
 *
 * @param {string} jarPath Path containing jars
 * @param {object} pomPathMap Map containing jar to pom names. Required to successfully parse gradle cache.
 *
 * @return object containing jar name and class list
 */
export async function collectJarNS(jarPath, pomPathMap = {}) {
  const jarNSMapping = {};
  const env = {
    ...process.env,
  };
  // jar command usually would not be available in the PATH for windows
  if (isWin && env.JAVA_HOME) {
    env.PATH = `${env.PATH || env.Path}${_delimiter}${join(
      env.JAVA_HOME,
      "bin",
    )}`;
  }
  // Parse jar files to get class names
  const jarFiles = jarPath.endsWith(".jar")
    ? [jarPath]
    : getAllFiles(jarPath, "**/*.jar");
  if (jarFiles?.length) {
    for (const jf of jarFiles) {
      let pomname =
        pomPathMap[basename(jf).replace(".jar", ".pom")] ||
        jf.replace(".jar", ".pom");
      let pomData;
      let purl;
      // In some cases, the pom name might be slightly different to the jar name
      if (!safeExistsSync(pomname)) {
        let searchDir = dirname(jf);
        // in case of gradle, there would be hash directory that is different for jar vs pom
        // so we need to start search from a level up
        if (searchDir.includes(join(".gradle", "caches"))) {
          searchDir = join(searchDir, "..");
        }
        const pomSearch = getAllFiles(searchDir, "**/*.pom");
        if (pomSearch && pomSearch.length === 1) {
          pomname = pomSearch[0];
        }
      }
      if (safeExistsSync(pomname)) {
        // TODO: Replace with parsePom which contains pomPurl
        pomData = parsePomXml(readFileSync(pomname, { encoding: "utf-8" }));
        if (pomData) {
          const purlObj = new PackageURL(
            "maven",
            pomData.groupId || "",
            pomData.artifactId,
            pomData.version,
            { type: "jar" },
            null,
          );
          purl = purlObj.toString();
        }
      } else if (jf.includes(join(".m2", "repository"))) {
        // Let's try our best to construct a purl for .m2 cache entries of the form
        // .m2/repository/org/apache/logging/log4j/log4j-web/3.0.0-SNAPSHOT/log4j-web-3.0.0-SNAPSHOT.jar
        const tmpA = jf.split(join(".m2", "repository", ""));
        if (tmpA?.length) {
          const tmpJarPath = tmpA[tmpA.length - 1];
          // This would yield log4j-web-3.0.0-SNAPSHOT.jar
          const jarFileName = basename(tmpJarPath).replace(".jar", "");
          const tmpDirParts = dirname(tmpJarPath).split(_sep);
          // Retrieve the version
          let jarVersion = tmpDirParts.pop();
          if (jarVersion === "plugins") {
            jarVersion = tmpDirParts.pop();
            if (jarVersion === "eclipse") {
              jarVersion = tmpDirParts.pop();
            }
          }
          // The result would form the group name
          let jarGroupName = tmpDirParts.join(".").replace(/^\./, "");
          let qualifierType = "jar";
          // Support for p2 bundles and plugins
          // See https://github.com/CycloneDX/cyclonedx-maven-plugin/issues/137
          // See https://github.com/cdxgen/cdxgen/pull/510#issuecomment-1702551615
          if (jarGroupName.startsWith("p2.osgi.bundle")) {
            jarGroupName = "p2.osgi.bundle";
            qualifierType = "osgi-bundle";
          } else if (jarGroupName.startsWith("p2.eclipse.plugin")) {
            jarGroupName = "p2.eclipse.plugin";
            qualifierType = "eclipse-plugin";
          } else if (jarGroupName.startsWith("p2.binary")) {
            jarGroupName = "p2.binary";
            qualifierType = "eclipse-executable";
          } else if (jarGroupName.startsWith("p2.org.eclipse.update.feature")) {
            jarGroupName = "p2.org.eclipse.update.feature";
            qualifierType = "eclipse-feature";
          }
          const purlObj = new PackageURL(
            "maven",
            jarGroupName,
            jarFileName.replace(`-${jarVersion}`, ""),
            jarVersion,
            { type: qualifierType },
            null,
          );
          purl = purlObj.toString();
        }
      } else if (jf.includes(join(".gradle", "caches"))) {
        // Let's try our best to construct a purl for gradle cache entries of the form
        // .gradle/caches/modules-2/files-2.1/org.xmlresolver/xmlresolver/4.2.0/f4dbdaa83d636dcac91c9003ffa7fb173173fe8d/xmlresolver-4.2.0-data.jar
        const tmpA = jf.split(join("files-2.1", ""));
        if (tmpA?.length) {
          const tmpJarPath = tmpA[tmpA.length - 1];
          // This would yield xmlresolver-4.2.0-data.jar
          const jarFileName = basename(tmpJarPath).replace(".jar", "");
          const tmpDirParts = dirname(tmpJarPath).split(_sep);
          // This would remove the hash from the end of the directory name
          tmpDirParts.pop();
          // Retrieve the version
          const jarVersion = tmpDirParts.pop();
          const pkgName = jarFileName.replace(`-${jarVersion}`, "");
          // The result would form the group name
          let jarGroupName = tmpDirParts.join(".").replace(/^\./, "");
          if (jarGroupName.includes(pkgName)) {
            jarGroupName = jarGroupName.replace(`.${pkgName}`, "");
          }
          const purlObj = new PackageURL(
            "maven",
            jarGroupName,
            pkgName,
            jarVersion,
            { type: "jar" },
            null,
          );
          purl = purlObj.toString();
        }
      }
      // If we have a hit from the cache, use it.
      if (purl && jarNSMapping_cache[purl]) {
        jarNSMapping[purl] = jarNSMapping_cache[purl];
      } else {
        if (DEBUG_MODE) {
          console.log(`Parsing ${jf}`);
        }
        const nsList = await getJarClasses(jf);
        let hashes;
        try {
          const hashValues = await multiChecksumFile(
            ["md5", "sha1", "sha256", "sha512"],
            jf,
          );
          hashes = [
            { alg: "MD5", content: hashValues["md5"] },
            { alg: "SHA-1", content: hashValues["sha1"] },
            { alg: "SHA-256", content: hashValues["sha256"] },
            { alg: "SHA-512", content: hashValues["sha512"] },
          ];
        } catch (_e) {
          // ignore
        }
        jarNSMapping[purl || jf] = {
          jarFile: jf,
          pom: pomData,
          namespaces: nsList,
          hashes,
        };
        // Retain in the global cache to speed up future lookups
        if (purl) {
          jarNSMapping_cache[purl] = jarNSMapping[purl];
        }
      }
    }
    if (!jarNSMapping) {
      console.log(`Unable to determine class names for the jars in ${jarPath}`);
    }
  } else {
    console.log(
      `${jarPath} did not contain any jars. Try building the project to improve the BOM precision.`,
    );
  }
  return jarNSMapping;
}

export async function convertJarNSToPackages(jarNSMapping) {
  const pkgList = [];
  for (const purl of Object.keys(jarNSMapping)) {
    let { jarFile, pom, namespaces, hashes } = jarNSMapping[purl];
    if (!pom) {
      pom = {};
    }
    let purlObj;
    try {
      purlObj = PackageURL.fromString(purl);
    } catch (_e) {
      // ignore
      purlObj = {};
    }
    const name = pom.artifactId || purlObj.name;
    if (!name) {
      console.warn(
        `Unable to identify the metadata for ${purl}. This will be skipped.`,
      );
      continue;
    }
    const apackage = {
      name,
      group: pom.groupId || purlObj.namespace || "",
      version: pom.version || purlObj.version,
      description: (pom.description || "").trim(),
      purl,
      "bom-ref": decodeURIComponent(purl),
      hashes,
      evidence: {
        identity: {
          field: "purl",
          confidence: 0.5,
          methods: [
            {
              technique: "filename",
              confidence: 1,
              value: jarFile,
            },
          ],
        },
      },
      properties: [
        {
          name: "SrcFile",
          value: jarFile,
        },
        {
          name: "Namespaces",
          value: namespaces.join("\n"),
        },
      ],
    };
    if (pom.url) {
      apackage["homepage"] = { url: pom.url };
    }
    if (pom.scm) {
      apackage["repository"] = { url: pom.scm };
    }
    pkgList.push(apackage);
  }
  return pkgList;
}

/**
 * Deprecated function to parse pom.xml. Use parsePom instead.
 *
 * @deprecated
 * @param pomXmlData XML contents
 * @returns {Object} Parent component data
 */
export function parsePomXml(pomXmlData) {
  if (!pomXmlData) {
    return undefined;
  }
  const project = xml2js(pomXmlData, {
    compact: true,
    spaces: 4,
    textKey: "_",
    attributesKey: "$",
    commentKey: "value",
  }).project;
  if (project) {
    let version = project.version ? project.version._ : undefined;
    if (!version && project.parent) {
      version = project.parent.version._;
    }
    let groupId = project.groupId ? project.groupId._ : undefined;
    if (!groupId && project.parent) {
      groupId = project.parent.groupId._;
    }
    return {
      artifactId: project.artifactId ? project.artifactId._ : "",
      groupId,
      version,
      description: project.description ? project.description._ : "",
      url: project.url ? project.url._ : "",
      scm: project.scm?.url ? project.scm.url._ : "",
    };
  }
  return undefined;
}

export function parseJarManifest(jarMetadata) {
  const metadata = {};
  if (!jarMetadata) {
    return metadata;
  }
  jarMetadata.split("\n").forEach((l) => {
    l = l.replace("\r", "");
    if (l.includes(": ")) {
      const tmpA = l.split(": ");
      if (tmpA && tmpA.length === 2) {
        metadata[tmpA[0]] = tmpA[1].replace("\r", "");
      }
    }
  });
  return metadata;
}

export function parsePomProperties(pomProperties) {
  const properties = {};
  if (!pomProperties) {
    return properties;
  }
  pomProperties.split("\n").forEach((l) => {
    l = l.replace("\r", "");
    if (l.includes("=")) {
      const tmpA = l.split("=");
      if (tmpA && tmpA.length === 2) {
        properties[tmpA[0]] = tmpA[1].replace("\r", "");
      }
    }
  });
  return properties;
}

export function encodeForPurl(s) {
  return s && !s.includes("%40")
    ? encodeURIComponent(s).replace(/%3A/g, ":").replace(/%2F/g, "/")
    : s;
}

/**
 * Method to get pom properties from maven directory
 *
 * @param {string} mavenDir Path to maven directory
 *
 * @return array with pom properties
 */
export function getPomPropertiesFromMavenDir(mavenDir) {
  let pomProperties = {};
  if (safeExistsSync(mavenDir) && lstatSync(mavenDir).isDirectory()) {
    const pomPropertiesFiles = getAllFiles(mavenDir, "**/pom.properties");
    if (pomPropertiesFiles?.length) {
      const pomPropertiesString = readFileSync(pomPropertiesFiles[0], {
        encoding: "utf-8",
      });
      pomProperties = parsePomProperties(pomPropertiesString);
    }
  }
  return pomProperties;
}

/**
 * Computes the checksum for a file path using the given hash algorithm
 *
 * @param {string} hashName name of hash algorithm
 * @param {string} path path to file
 * @returns {Promise<String>} hex value of hash
 */
export function checksumFile(hashName, path) {
  return new Promise((resolve, reject) => {
    const hash = createHash(hashName);
    const stream = createReadStream(path);
    stream.on("error", (err) => reject(err));
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * Computes multiple checksum for a file path using the given hash algorithms
 *
 * @param {Array[String]} algorithms Array of algorithms
 * @param {string} path path to file
 * @returns {Promise<Object>} hashes object
 */
export function multiChecksumFile(algorithms, path) {
  return new Promise((resolve, reject) => {
    const hashes = {};
    for (const alg of algorithms) {
      hashes[alg] = createHash(alg);
    }
    const stream = createReadStream(path);
    stream.on("error", (err) => reject(err));
    stream.on("data", (chunk) =>
      algorithms.forEach((alg) => {
        hashes[alg].update(chunk);
      }),
    );
    stream.on("end", () => {
      algorithms.forEach((alg) => {
        hashes[alg] = hashes[alg].digest("hex");
      });
      resolve(hashes);
    });
  });
}

/**
 * Method to extract a war or ear file
 *
 * @param {string} jarFile Path to jar file
 * @param {string} tempDir Temporary directory to use for extraction
 * @param {object} jarNSMapping Jar class names mapping object
 *
 * @return pkgList Package list
 */
export async function extractJarArchive(jarFile, tempDir, jarNSMapping = {}) {
  const pkgList = [];
  let jarFiles = [];
  const fname = basename(jarFile);
  let pomname;
  // If there is a pom file in the same directory, try to use it
  const manifestname = join(dirname(jarFile), "META-INF", "MANIFEST.MF");
  // Issue 439: Current implementation checks for existance of a .pom file, but .pom file is not used.
  // Instead code expects to find META-INF/MANIFEST.MF in the same folder as a .jar file.
  // For now check for presence of both .pom and MANIFEST.MF files.
  if (jarFile.endsWith(".jar")) {
    pomname = jarFile.replace(".jar", ".pom");
  }
  if (
    pomname &&
    safeExistsSync(pomname) &&
    manifestname &&
    safeExistsSync(manifestname)
  ) {
    tempDir = dirname(jarFile);
  } else if (
    !safeExistsSync(join(tempDir, fname)) &&
    safeExistsSync(jarFile) &&
    lstatSync(jarFile).isFile()
  ) {
    // Only copy if the file doesn't exist
    copyFileSync(jarFile, join(tempDir, fname), constants.COPYFILE_FICLONE);
  }
  const env = {
    ...process.env,
  };
  // jar command usually would not be available in the PATH for windows
  if (isWin && env.JAVA_HOME) {
    env.PATH = `${env.PATH || env.Path}${_delimiter}${join(
      env.JAVA_HOME,
      "bin",
    )}`;
  }
  if (
    jarFile.endsWith(".war") ||
    jarFile.endsWith(".hpi") ||
    jarFile.endsWith(".jar")
  ) {
    if (safeExistsSync(join(tempDir, fname))) {
      try {
        const zip = new StreamZip.async({ file: join(tempDir, fname) });
        await zip.extract(null, tempDir);
        await zip.close();
      } catch (e) {
        console.log(`Unable to extract ${join(tempDir, fname)}. Skipping.`, e);
        return pkgList;
      }
    }
    jarFiles = getAllFiles(join(tempDir, "WEB-INF", "lib"), "**/*.jar");
    if (jarFile.endsWith(".hpi")) {
      jarFiles.push(jarFile);
    }
    // Some jar files could also have more jar files inside BOOT-INF directory
    const jarFiles2 = getAllFiles(join(tempDir, "BOOT-INF", "lib"), "**/*.jar");
    if (jarFiles && jarFiles2.length) {
      jarFiles = jarFiles.concat(jarFiles2);
    }
    // Fallback. If our jar file didn't include any jar
    if (jarFile.endsWith(".jar") && !jarFiles.length) {
      jarFiles = [join(tempDir, fname)];
    }
  } else {
    jarFiles = [join(tempDir, fname)];
  }
  if (jarFiles?.length) {
    for (const jf of jarFiles) {
      // If the jar file doesn't exist at the point of use, skip it
      if (!safeExistsSync(jf)) {
        if (DEBUG_MODE) {
          console.log(jf, jarFile, "is not a readable file.");
        }
        continue;
      }
      pomname = jf.replace(".jar", ".pom");
      const jarname = basename(jf);
      // Ignore test jars
      if (
        jarname.endsWith("-tests.jar") ||
        jarname.endsWith("-test-sources.jar")
      ) {
        if (DEBUG_MODE) {
          console.log(`Skipping tests jar ${jarname}`);
        }
        continue;
      }
      const manifestDir = join(tempDir, "META-INF");
      const manifestFile = join(manifestDir, "MANIFEST.MF");
      const mavenDir = join(manifestDir, "maven");
      let jarResult = {
        status: 1,
      };
      if (safeExistsSync(pomname)) {
        jarResult = { status: 0 };
      } else {
        // Unzip natively
        try {
          const zip = new StreamZip.async({ file: jf });
          await zip.extract(null, tempDir);
          await zip.close();
          jarResult = { status: 0 };
        } catch (_e) {
          if (DEBUG_MODE) {
            console.log(`Unable to extract ${jf}. Skipping.`);
          }
          jarResult = { status: 1 };
        }
      }
      if (jarResult.status === 0) {
        // When maven descriptor is available take group, name and version from pom.properties
        // META-INF/maven/${groupId}/${artifactId}/pom.properties
        // see https://maven.apache.org/shared/maven-archiver/index.html
        const pomProperties = getPomPropertiesFromMavenDir(mavenDir);
        let group = pomProperties["groupId"];
        let name = pomProperties["artifactId"];
        let version = pomProperties["version"];
        let confidence = 0.5;
        let technique = "manifest-analysis";
        if (
          (!group || !name || !version) &&
          SEARCH_MAVEN_ORG &&
          search_maven_org_errors < MAX_SEARCH_MAVEN_ORG_ERRORS
        ) {
          try {
            const sha = await checksumFile("sha1", jf);
            const searchurl = `https://central.sonatype.com/solrsearch/select?q=1:%22${sha}%22&rows=20&wt=json`;
            const res = await cdxgenAgent.get(searchurl, {
              responseType: "json",
              timeout: {
                lookup: 1000,
                connect: 5000,
                secureConnect: 5000,
                socket: 1000,
                send: 10000,
                response: 1000,
              },
            });
            const data = res?.body ? res.body["response"] : undefined;
            if (data && data["numFound"] === 1) {
              const jarInfo = data["docs"][0];
              group = jarInfo["g"];
              name = jarInfo["a"];
              version = jarInfo["v"];
              technique = "hash-comparison";
            }
          } catch (err) {
            if (err?.message && !err.message.includes("404")) {
              if (
                err.message.includes("Timeout") ||
                err.message.includes("429")
              ) {
                console.log(
                  "Maven search appears to be unavailable. Search will be skipped for all remaining packages.",
                );
              }
              search_maven_org_errors++;
            }
          }
        }
        let jarMetadata;
        if ((!group || !name || !version) && safeExistsSync(manifestFile)) {
          confidence = 0.8;
          jarMetadata = parseJarManifest(
            readFileSync(manifestFile, {
              encoding: "utf-8",
            }),
          );
          group =
            group ||
            jarMetadata["Extension-Name"] ||
            jarMetadata["Implementation-Vendor-Id"] ||
            jarMetadata["Bundle-SymbolicName"] ||
            jarMetadata["Bundle-Vendor"] ||
            jarMetadata["Automatic-Module-Name"] ||
            "";
          version =
            version ||
            jarMetadata["Bundle-Version"] ||
            jarMetadata["Implementation-Version"] ||
            jarMetadata["Specification-Version"];
          if (version?.includes(" ")) {
            version = version.split(" ")[0];
          }
          // Prefer jar filename to construct name and version
          if (!name || !version || name === "" || version === "") {
            confidence = 0.5;
            technique = "filename";
            name = jarname.replace(".jar", "");
            const tmpA = jarname.split("-");
            if (tmpA && tmpA.length > 1) {
              const lastPart = tmpA[tmpA.length - 1];
              // Bug #768. Check if we have any number before simplifying the name.
              if (/\d/.test(lastPart)) {
                if (!version || version === "") {
                  version = lastPart.replace(".jar", "");
                }
                name = jarname.replace(`-${lastPart}`, "") || "";
              }
            }
          }
          if (
            !name.length &&
            jarMetadata["Bundle-Name"] &&
            !jarMetadata["Bundle-Name"].includes(" ")
          ) {
            name = jarMetadata["Bundle-Name"];
          } else if (
            !name.length &&
            jarMetadata["Implementation-Title"] &&
            !jarMetadata["Implementation-Title"].includes(" ")
          ) {
            name = jarMetadata["Implementation-Title"];
          }
          // Sometimes the group might already contain the name
          // Eg: group: org.checkerframework.checker.qual name: checker-qual
          if (name && group && !group.startsWith("javax")) {
            if (group.includes(`.${name.toLowerCase().replace(/-/g, ".")}`)) {
              group = group.replace(
                new RegExp(`.${name.toLowerCase().replace(/-/g, ".")}$`),
                "",
              );
            } else if (group.includes(`.${name.toLowerCase()}`)) {
              group = group.replace(new RegExp(`.${name.toLowerCase()}$`), "");
            }
          }
          // Patch the group string
          for (const aprefix in vendorAliases) {
            if (name?.startsWith(aprefix)) {
              group = vendorAliases[aprefix];
              break;
            }
          }
          // if group is empty use name as group
          group = group === "." ? name : group || name;
        }
        if (name) {
          if (!version) {
            confidence = 0;
          }
          const properties = [
            {
              name: "SrcFile",
              value: jf,
            },
          ];
          const purl = new PackageURL(
            "maven",
            group,
            name,
            version,
            { type: "jar" },
            null,
          ).toString();
          let namespaceValues;
          let namespaceList;
          if (jarNSMapping?.[purl]?.namespaces) {
            namespaceList = jarNSMapping[purl].namespaces;
            namespaceValues = namespaceList.join("\n");
            properties.push({
              name: "Namespaces",
              value: namespaceValues,
            });
          } else {
            const tmpJarNSMapping = await collectJarNS(jf);
            if (tmpJarNSMapping?.[jf]?.namespaces?.length) {
              namespaceList = tmpJarNSMapping[jf].namespaces;
              namespaceValues = namespaceList.join("\n");
              properties.push({
                name: "Namespaces",
                value: namespaceValues,
              });
            }
          }
          // Are there any shaded classes
          if (
            namespaceValues?.includes(".shaded.") ||
            namespaceValues?.includes(".thirdparty.com.")
          ) {
            properties.push({
              name: "cdx:maven:shaded",
              value: "true",
            });
            confidence = 0;
            const unshadedNS = new Set();
            for (const ans of namespaceList) {
              let tmpns;
              if (ans.includes(".shaded.")) {
                tmpns = ans.split(".shaded.").pop();
              } else if (ans.includes(".thirdparty.")) {
                tmpns = ans.split(".thirdparty.").pop();
              }
              if (tmpns?.search("[.]") > 3) {
                unshadedNS.add(tmpns.split("$")[0]);
              }
            }
            if (unshadedNS.size) {
              properties.push({
                name: "cdx:maven:unshadedNamespaces",
                value: Array.from(unshadedNS).join("\n"),
              });
            }
          }
          const apkg = {
            group: group ? encodeForPurl(group) : "",
            name: name ? encodeForPurl(name) : "",
            version,
            purl,
            evidence: {
              identity: {
                field: "purl",
                confidence: confidence,
                methods: [
                  {
                    technique: technique,
                    confidence: confidence,
                    value: jarname,
                  },
                ],
              },
            },
            properties,
          };
          pkgList.push(apkg);
        } else {
          if (DEBUG_MODE) {
            console.log(`Ignored jar ${jarname}`, name, version);
          }
        }
      }
      try {
        if (rmSync && safeExistsSync(join(tempDir, "META-INF"))) {
          // Clean up META-INF
          rmSync(join(tempDir, "META-INF"), {
            recursive: true,
            force: true,
          });
        }
      } catch (_err) {
        // ignore cleanup errors
      }
    } // for
  } // if
  let jarMissWarningShown = false;
  if (jarFiles.length !== pkgList.length) {
    if (pkgList.length) {
      console.log(
        `Obtained only ${pkgList.length} components from ${jarFiles.length} jars at ${tempDir}.`,
      );
    } else {
      console.log(
        `Unable to extract component information from ${jarFile}. The SBOM won't include this artifact.`,
      );
      if (!jarMissWarningShown) {
        thoughtLog(
          `Looks like we are going to miss some jars (${basename(jarFile)}) in our SBOM 😞.`,
        );
        jarMissWarningShown = true;
      }
    }
  }
  return pkgList;
}

/**
 * Determine the version of SBT used in compilation of this project.
 * By default it looks into a standard SBT location i.e.
 * <path-project>/project/build.properties
 * Returns `null` if the version cannot be determined.
 *
 * @param {string} projectPath Path to the SBT project
 */
export function determineSbtVersion(projectPath) {
  const buildPropFile = join(projectPath, "project", "build.properties");
  if (DEBUG_MODE) {
    console.log("Looking for", buildPropFile);
  }
  if (safeExistsSync(buildPropFile)) {
    const properties = propertiesReader(buildPropFile);
    const property = properties.get("sbt.version");
    if (property != null && valid(property)) {
      return property;
    }
  }
  return null;
}

/**
 * Adds a new plugin to the SBT project by amending its plugins list.
 * Only recommended for SBT < 1.2.0 or otherwise use `addPluginSbtFile`
 * parameter.
 * The change manipulates the existing plugins' file by creating a copy of it
 * and returning a path where it is moved to.
 * Once the SBT task is complete one must always call `cleanupPlugin` to remove
 * the modifications made in place.
 *
 * @param {string} projectPath Path to the SBT project
 * @param {string} plugin Name of the plugin to add
 */
export function addPlugin(projectPath, plugin) {
  const pluginsFile = sbtPluginsPath(projectPath);
  let originalPluginsFile = null;
  if (safeExistsSync(pluginsFile)) {
    originalPluginsFile = `${pluginsFile}.cdxgen`;
    copyFileSync(pluginsFile, originalPluginsFile, constants.COPYFILE_FICLONE);
  }

  writeFileSync(pluginsFile, plugin, { flag: "a" });
  return originalPluginsFile;
}

/**
 * Cleans up modifications to the project's plugins' file made by the
 * `addPlugin` function.
 *
 * @param {string} projectPath Path to the SBT project
 * @param {string} originalPluginsFile Location of the original plugins file, if any
 */
export function cleanupPlugin(projectPath, originalPluginsFile) {
  const pluginsFile = sbtPluginsPath(projectPath);
  if (safeExistsSync(pluginsFile)) {
    if (!originalPluginsFile) {
      // just remove the file, it was never there
      unlinkSync(pluginsFile);
      return !safeExistsSync(pluginsFile);
    }
    // Bring back the original file
    copyFileSync(originalPluginsFile, pluginsFile, constants.COPYFILE_FICLONE);
    unlinkSync(originalPluginsFile);
    return true;
  }
  return false;
}

/**
 * Returns a default location of the plugins file.
 *
 * @param {string} projectPath Path to the SBT project
 */
export function sbtPluginsPath(projectPath) {
  return join(projectPath, "project", "plugins.sbt");
}

/**
 * Method to read a single file entry from a zip file
 *
 * @param {string} zipFile Zip file to read
 * @param {string} filePattern File pattern
 * @param {string} contentEncoding Encoding. Defaults to utf-8
 *
 * @returns File contents
 */
export async function readZipEntry(
  zipFile,
  filePattern,
  contentEncoding = "utf-8",
) {
  let retData;
  try {
    const zip = new StreamZip.async({ file: zipFile });
    const entriesCount = await zip.entriesCount;
    if (!entriesCount) {
      return undefined;
    }
    const entries = await zip.entries();
    for (const entry of Object.values(entries)) {
      if (entry.isDirectory) {
        continue;
      }
      if (entry.name.endsWith(filePattern)) {
        const fileData = await zip.entryData(entry.name);
        retData = iconv.decode(Buffer.from(fileData), contentEncoding);
        break;
      }
    }
    await zip.close();
  } catch (e) {
    console.log(e);
  }
  return retData;
}

/**
 * Method to get the classes and relevant sources in a jar file
 *
 * @param {string} jarFile Jar file to read
 *
 * @returns List of classes and sources matching certain known patterns
 */
export async function getJarClasses(jarFile) {
  const retList = [];
  try {
    const zip = new StreamZip.async({ file: jarFile });
    const entriesCount = await zip.entriesCount;
    if (!entriesCount) {
      return [];
    }
    const entries = await zip.entries();
    for (const entry of Object.values(entries)) {
      if (entry.isDirectory) {
        continue;
      }
      if (
        (entry.name.includes(".class") ||
          entry.name.includes(".java") ||
          entry.name.includes(".scala") ||
          entry.name.includes(".groovy") ||
          entry.name.includes(".kt")) &&
        !entry.name.includes("-INF") &&
        !entry.name.includes("module-info")
      ) {
        retList.push(
          entry.name
            .replace("\r", "")
            .replace(/.(class|java|kt|scala|groovy)/g, "")
            .replace(/\/$/, "")
            .replace(/\//g, "."),
        );
      }
    }
    await zip.close();
  } catch (e) {
    // node-stream-zip seems to fail on deno with a RangeError.
    // So we fallback to using jar -tf command
    if (e.name === "RangeError") {
      const jarResult = safeSpawnSync("jar", ["-tf", jarFile], {
        shell: isWin,
      });
      if (
        jarResult?.stderr?.includes(
          "is not recognized as an internal or external command",
        )
      ) {
        return retList;
      }
      const consolelines = (jarResult.stdout || "").split("\n");
      return consolelines
        .filter((l) => {
          return (
            (l.includes(".class") ||
              l.includes(".java") ||
              l.includes(".scala") ||
              l.includes(".groovy") ||
              l.includes(".kt")) &&
            !l.includes("-INF") &&
            !l.includes("module-info")
          );
        })
        .map((e) => {
          return e
            .replace("\r", "")
            .replace(/.(class|java|kt|scala|groovy)/, "")
            .replace(/\/$/, "")
            .replace(/\//g, ".");
        });
    }
  }
  return retList;
}

/**
 * Method to return the gradle command to use.
 *
 * @param {string} srcPath Path to look for gradlew wrapper
 * @param {string|null} rootPath Root directory to look for gradlew wrapper
 */
export function getGradleCommand(srcPath, rootPath) {
  let gradleCmd = "gradle";

  let findGradleFile = "gradlew";
  if (platform() === "win32") {
    findGradleFile = "gradlew.bat";
  }

  if (safeExistsSync(join(srcPath, findGradleFile))) {
    // Use local gradle wrapper if available
    // Enable execute permission
    try {
      chmodSync(join(srcPath, findGradleFile), 0o775);
    } catch (_e) {
      // continue regardless of error
    }
    gradleCmd = resolve(join(srcPath, findGradleFile));
  } else if (rootPath && safeExistsSync(join(rootPath, findGradleFile))) {
    // Check if the root directory has a wrapper script
    try {
      chmodSync(join(rootPath, findGradleFile), 0o775);
    } catch (_e) {
      // continue regardless of error
    }
    gradleCmd = resolve(join(rootPath, findGradleFile));
  } else if (process.env.GRADLE_CMD) {
    gradleCmd = process.env.GRADLE_CMD;
  } else if (process.env.GRADLE_HOME) {
    gradleCmd = join(process.env.GRADLE_HOME, "bin", "gradle");
  }
  return gradleCmd;
}

/**
 * Method to return the mill command to use.
 *
 * @param {string} srcPath Path to look for mill wrapper
 */
export function getMillCommand(srcPath) {
  let millCmd = `mill${platform() === "win32" ? ".bat" : ""}`;
  if (safeExistsSync(join(srcPath, millCmd))) {
    // Use local mill wrapper if available
    // Enable execute permission
    try {
      chmodSync(join(srcPath, millCmd), 0o775);
    } catch (_e) {
      // continue regardless of error
    }
    millCmd = resolve(join(srcPath, millCmd));
  }
  return millCmd;
}

/**
 * Method to combine the general gradle arguments, the sub-commands and the sub-commands' arguments in the correct way
 *
 * @param {string[]} gradleArguments The general gradle arguments, which must only be added once
 * @param {string[]} gradleSubCommands The sub-commands that are to be executed by gradle
 * @param {string[]} gradleSubCommandArguments The arguments specific to the sub-command(s), which much be added PER sub-command
 * @param {int} gradleCommandLength The length of the full gradle-command
 *
 * @returns {string[]} Array of arrays of arguments to be added to the gradle command
 */
export function buildGradleCommandArguments(
  gradleArguments,
  gradleSubCommands,
  gradleSubCommandArguments,
  gradleCommandLength,
) {
  const mainGradleArguments = [
    "--build-cache",
    "--console",
    "plain",
    "--no-parallel",
  ]
    .concat(getGradleDaemonParameter())
    .concat(gradleArguments);
  const maxCliArgsLength = isWin
    ? 7500 - gradleCommandLength - mainGradleArguments.join(" ").length - 2
    : -1;
  if (DEBUG_MODE && maxCliArgsLength !== -1) {
    console.log(
      "Running on Windows with a very long command -- splitting into multiple commands",
    );
  }
  const splitArgs = [];
  let allGradleArguments = [].concat(mainGradleArguments);
  let remainingLength = maxCliArgsLength;
  for (const gradleSubCommand of gradleSubCommands) {
    const subCommandLength =
      [gradleSubCommand, ...gradleSubCommandArguments].join(" ").length + 1;
    if (maxCliArgsLength !== -1 && remainingLength - subCommandLength < 0) {
      splitArgs.push(allGradleArguments);
      allGradleArguments = [].concat(mainGradleArguments);
      remainingLength = maxCliArgsLength;
    }
    allGradleArguments.push(gradleSubCommand);
    allGradleArguments = allGradleArguments.concat(gradleSubCommandArguments);
    remainingLength -= subCommandLength;
  }
  if (allGradleArguments.length !== mainGradleArguments.length) {
    splitArgs.push(allGradleArguments);
  }
  return splitArgs;
}

function getGradleDaemonParameter() {
  switch (process.env.GRADLE_USE_DAEMON) {
    case "default":
      return [];
    case "false":
    case "1":
      return ["--no-daemon"];
    default:
      return ["--daemon"];
  }
}

/**
 * Method to split the output produced by Gradle using parallel processing by project
 *
 * @param {string} rawOutput Full output produced by Gradle using parallel processing
 * @param {string[]} relevantTasks The list of gradle tasks whose output need to be considered.
 * @returns {map} Map with subProject names as keys and corresponding dependency task outputs as values.
 */

export function splitOutputByGradleProjects(rawOutput, relevantTasks) {
  const outputSplitBySubprojects = new Map();
  let subProjectOut = "";
  const outSplitByLine = rawOutput.split("\n");
  let currentProjectName = "root";
  const regexPatternForRelevantTasks = `.*:(${relevantTasks.join("|")})(?=s|\r|$)`;
  const regexForRelevantTasks = new RegExp(regexPatternForRelevantTasks);
  for (const [i, line] of outSplitByLine.entries()) {
    //filter out everything before first task output
    if (!line.startsWith("> Task :") && subProjectOut === "") {
      continue;
    }

    //ignore output of irrelevant tasks
    if (line.startsWith("> Task :") && !regexForRelevantTasks.test(line)) {
      continue;
    }

    if (line.startsWith("Root project '") || line.startsWith("Project ':")) {
      currentProjectName = line.split("'")[1];
      outputSplitBySubprojects.set(currentProjectName, "");
    }
    // if previous subProject has ended, push to array and reset subProject string
    if (line.startsWith("> Task :") && subProjectOut !== "") {
      outputSplitBySubprojects.set(currentProjectName, subProjectOut);
      subProjectOut = "";
    }
    //if in subproject block, keep appending to string
    subProjectOut += `${line}\n`;
    //if end of last dependencies output block, push to array
    if (i === outSplitByLine.length - 1) {
      outputSplitBySubprojects.set(currentProjectName, subProjectOut);
    }
  }
  return outputSplitBySubprojects;
}

/**
 * Parse the contents of a 'Podfile.lock'
 *
 * @param {Object} podfileLock The content of the podfile.lock as an Object
 * @param {String} projectPath The path to the project root
 * @returns {Map} Map of all dependencies with their direct dependencies
 */
export async function parsePodfileLock(podfileLock, projectPath) {
  const dependencies = new Map();
  for (const pod of podfileLock["PODS"]) {
    const dependency = {};
    if (pod.constructor === Object) {
      for (const key in pod) {
        dependency.metadata = parseCocoaDependency(key);
        const subDependencies = new Set();
        for (const subPod of pod[key]) {
          subDependencies.add(parseCocoaDependency(subPod, false));
        }
        dependency.dependencies = Array.from(subDependencies);
      }
    } else {
      dependency.metadata = parseCocoaDependency(pod);
    }
    const podName = dependency.metadata.name.includes("/")
      ? dependency.metadata.name.substring(
          0,
          dependency.metadata.name.indexOf("/"),
        )
      : dependency.metadata.name;
    if (podfileLock["EXTERNAL SOURCES"]?.[podName]) {
      const externalPod = podfileLock["EXTERNAL SOURCES"][podName];
      if (externalPod[":git"]) {
        let projectRepo = externalPod[":git"];
        if (projectRepo.includes("github.com")) {
          projectRepo = projectRepo.replace(
            "github.com",
            "raw.githubusercontent.com",
          );
        }
        if (projectRepo.endsWith(".git")) {
          projectRepo = projectRepo.substring(0, projectRepo.length - 4);
        }
        const projectRepoBranchOrTag = externalPod[":tag"]
          ? `tags/${externalPod[":tag"]}`
          : `heads/${externalPod[":branch"] ? externalPod[":branch"] : "<DEFAULT>"}`;
        dependency.metadata.properties = [
          {
            name: "cdx:pods:podspecLocation",
            value: `${projectRepo}/refs/${projectRepoBranchOrTag}/${podName}.podspec`,
          },
        ];
      } else if (externalPod[":path"]) {
        const projectLocation = resolve(projectPath, externalPod[":path"]);
        dependency.metadata.properties = [
          {
            name: "cdx:pods:projectDir",
            value: projectLocation,
          },
        ];
        let podspec = join(projectLocation, `${podName}.podspec`);
        if (!existsSync(podspec)) {
          podspec = `${podspec}.json`;
        }
        if (existsSync(podspec)) {
          dependency.metadata.properties.push({
            name: "cdx:pods:podspecLocation",
            value: podspec,
          });
        }
      } else if (externalPod[":podspec"]) {
        const podspecLocation = resolve(projectPath, externalPod[":podspec"]);
        dependency.metadata.properties = [
          {
            name: "cdx:pods:projectDir",
            value: dirname(podspecLocation),
          },
          {
            name: "cdx:pods:podspecLocation",
            value: podspecLocation,
          },
        ];
      }
    }
    dependencies.set(dependency.metadata.name, dependency);
  }
  if (!["false", "0"].includes(process.env.COCOA_MERGE_SUBSPECS)) {
    for (const subspecComponentName of [...dependencies.keys()].filter((name) =>
      name.includes("/"),
    )) {
      const subspecComponent = dependencies.get(subspecComponentName);
      const mainComponentName = subspecComponentName.split("/")[0];
      let mainComponent = dependencies.get(mainComponentName);
      if (!mainComponent) {
        mainComponent = {
          metadata: {
            name: mainComponentName,
            version: subspecComponent.metadata.version,
          },
        };
        dependencies.set(mainComponentName, mainComponent);
      }
      if (subspecComponent.dependencies) {
        if (mainComponent.dependencies) {
          mainComponent.dependencies = [
            ...mainComponent.dependencies,
            ...subspecComponent.dependencies,
          ];
        } else {
          mainComponent.dependencies = subspecComponent.dependencies;
        }
      }
      mainComponent.metadata.properties = [
        ...(mainComponent.metadata.properties
          ? mainComponent.metadata.properties
          : []),
        {
          name: "cdx:pods:Subspec",
          value: subspecComponentName.substring(
            subspecComponentName.indexOf("/") + 1,
          ),
        },
        ...(subspecComponent.metadata.propertie
          ? subspecComponent.metadata.properties
          : []),
      ];
      dependencies.delete(subspecComponentName);
    }
    for (const [dependencyName, dependency] of dependencies) {
      if (dependency.dependencies) {
        dependency.dependencies.forEach((dep) => {
          dep.name = dep.name.split("/")[0];
        });
        dependency.dependencies = [
          ...new Map(
            dependency.dependencies
              .filter((dep) => dep.name !== dependencyName)
              .map((dep) => [dep.name, dep]),
          ).values(),
        ];
        if (dependency.dependencies.length === 0) {
          delete dependency.dependencies;
        }
      }
    }
  }
  return dependencies;
}

/**
 * Parse all targets and their direct dependencies from the 'Podfile'
 *
 * @param {Object} target A JSON-object representing a target
 * @param {Map} allDependencies The map containing all parsed direct dependencies for a target
 * @param {String} [prefix=undefined] Prefix to add to the targets name
 */
export function parsePodfileTargets(
  target,
  allDependencies,
  prefix = undefined,
) {
  const targetName = (prefix ? `${prefix}/` : "") + target.name;
  const targetDependencies = new Set(
    prefix && allDependencies.has(prefix)
      ? allDependencies.get(prefix)
      : targetName !== "Pods"
        ? allDependencies.get("Pods")
        : [],
  );
  if (target["dependencies"]) {
    for (const targetDependency of target["dependencies"]) {
      if (targetDependency.constructor === Object) {
        targetDependencies.add(Object.keys(targetDependency)[0]);
      } else {
        targetDependencies.add(targetDependency);
      }
    }
  }
  allDependencies.set(targetName, Array.from(targetDependencies));
  if (target.children) {
    const childPrefix = targetName === "Pods" ? undefined : targetName;
    for (const childTarget of target.children) {
      parsePodfileTargets(childTarget, allDependencies, childPrefix);
    }
  }
}

/**
 * Parse a single line representing a dependency
 *
 * @param {String} dependencyLine The line that should be parsed as a dependency
 * @param {boolean} [parseVersion=true] Include parsing the version of the dependency
 * @returns {Object} Object representing a dependency
 */
export function parseCocoaDependency(dependencyLine, parseVersion = true) {
  const dependencyData = dependencyLine.split(" (");
  const dependency = { name: dependencyData[0] };
  if (parseVersion) {
    dependency.version = dependencyData[1].substring(
      0,
      dependencyData[1].length - 1,
    );
  }
  return dependency;
}

/**
 * Execute the 'pod'-command with parameters
 *
 * @param {String[]} parameters The parameters for the command
 * @param {String} path The path where the command should be executed
 * @param {Object} options CLI options
 * @returns {Object} The result of running the command
 */
export function executePodCommand(parameters, path, options) {
  if (DEBUG_MODE) {
    if (path) {
      console.log("Executing pod", parameters.join(" "), "in", path);
    } else {
      console.log("Executing pod", parameters.join(" "));
    }
  }
  const result = safeSpawnSync(process.env.POD_CMD || "pod", parameters, {
    cwd: path,
    shell: isWin,
  });
  if (result.status !== 0 || result.error) {
    if (result?.stderr?.includes("Unable to find a pod")) {
      console.log(
        "Try again by running 'pod install' before invoking 'cdxgen'.",
      );
    }
    if (process.env?.CDXGEN_IN_CONTAINER !== "true") {
      console.log(
        "Consider using the cdxgen container image (`ghcr.io/cyclonedx/cdxgen`), which includes cocoapods and additional build tools.",
      );
    } else if (!DEBUG_MODE) {
      console.log(
        "Something went wrong when trying to execute cocoapods -- Set the environment variable 'CDXGEN_DEBUG_MODE=debug' to troubleshoot cocoapods related errors",
      );
    }
    if (options.failOnError || DEBUG_MODE) {
      if (result.stdout) {
        console.log(result.stdout);
      }
      if (result.stderr) {
        console.log(result.stderr);
      }
      options.failOnError && process.exit(1);
    }
  }
  return result;
}

/**
 * Method that handles object creation for cocoa pods.
 *
 * @param {Object} dependency The dependency that is to be transformed into an SBOM object
 * @param {Object} options CLI options
 * @param {String} [type="library"] The type of Object to create
 * @returns {Object} An object representing the pod in SBOM-format
 */
export async function buildObjectForCocoaPod(
  dependency,
  options,
  type = "library",
) {
  let component;
  if (
    !["false", "0"].includes(process.env.COCOA_RESOLVE_FROM_NODE) &&
    dependency.properties?.find(({ name }) => name === "cdx:pods:projectDir")
  ) {
    let tmpDir = dependency.properties.find(
      ({ name }) => name === "cdx:pods:projectDir",
    ).value;
    const exclusionDirs = process.env.COCOA_RESOLVE_FROM_NODE_EXCLUSION_DIRS
      ? process.env.COCOA_RESOLVE_FROM_NODE_EXCLUSION_DIRS.split(",")
      : [];
    if (
      tmpDir &&
      !exclusionDirs.some((dir) =>
        `${tmpDir.replaceAll("\\", "/")}/`.includes(
          `/${dir.replaceAll("\\", "/")}/`.replaceAll("//", "/"),
        ),
      ) &&
      tmpDir.indexOf("node_modules") !== -1
    ) {
      do {
        const npmPackages = await parsePkgJson(join(tmpDir, "package.json"));
        if (npmPackages.length === 1) {
          component = npmPackages[0];
          component.type = "library";
          component.properties = component.properties.concat(
            {
              name: "cdx:pods:PodName",
              value: dependency.name,
            },
            dependency.properties,
          );
          tmpDir = undefined;
        } else {
          tmpDir = dirname(tmpDir);
        }
      } while (tmpDir && tmpDir.indexOf("node_modules") !== -1);
    }
  }
  if (!component) {
    let name = dependency.name;
    let subspec = null;
    const locationOfSubspec = dependency.name.indexOf("/");
    if (locationOfSubspec !== -1) {
      name = dependency.name.substring(0, locationOfSubspec);
      subspec = dependency.name.substring(locationOfSubspec + 1);
    }
    component = {
      ...dependency,
      type,
    };
    if (subspec) {
      if (!component.properties) {
        component.properties = [];
      }
      component.properties.push({
        name: "cdx:pods:Subspec",
        value: subspec,
      });
    }
    const purl = new PackageURL(
      "cocoapods",
      "",
      name,
      component.version,
      null,
      subspec,
    ).toString();
    component["purl"] = purl;
    component["bom-ref"] = decodeURIComponent(purl);
    if (options && !["false", "0"].includes(process.env.COCOA_FULL_SCAN)) {
      await fullScanCocoaPod(dependency, component, options);
    }
  }
  return component;
}

async function fullScanCocoaPod(dependency, component, options) {
  let result;
  if (
    component.properties?.find(
      ({ name }) => name === "cdx:pods:podspecLocation",
    )
  ) {
    let podspecLocation = component.properties.find(
      ({ name }) => name === "cdx:pods:podspecLocation",
    ).value;
    if (
      component.properties.find(({ name }) => name === "cdx:pods:projectDir")
    ) {
      component.properties.push({
        name: "SrcFile",
        value: podspecLocation,
      });
    }
    let replacements = [];
    if (
      podspecLocation.endsWith(".podspec") &&
      process.env.COCOA_PODSPEC_REPLACEMENTS
    ) {
      replacements = process.env.COCOA_PODSPEC_REPLACEMENTS.split(";");
    } else if (
      podspecLocation.endsWith(".json") &&
      process.env.COCOA_PODSPEC_JSON_REPLACEMENTS
    ) {
      replacements = process.env.COCOA_PODSPEC_JSON_REPLACEMENTS.split(";");
    }
    if (replacements || podspecLocation.startsWith("http")) {
      let podspecContent;
      if (podspecLocation.startsWith("http")) {
        let httpResult;
        for (const branchName of ["main", "master"]) {
          try {
            httpResult = await cdxgenAgent.get(
              podspecLocation.replace("<DEFAULT>", branchName),
            );
            podspecLocation = podspecLocation.replace("<DEFAULT>", branchName);
          } catch (_err) {
            try {
              httpResult = await cdxgenAgent.get(
                `${podspecLocation.replace("<DEFAULT>", branchName)}.json`,
              );
              podspecLocation = `${podspecLocation.replace("<DEFAULT>", branchName)}.json`;
            } catch (_err) {
              continue;
            }
          }
          component.properties.find(
            ({ name }) => name === "cdx:pods:podspecLocation",
          ).value = podspecLocation;
          podspecLocation = `${randomUUID()}.${podspecLocation.substring(podspecLocation.lastIndexOf(".") + 1)}`;
          podspecContent = httpResult.body;
          break;
        }
      } else {
        podspecContent = readFileSync(podspecLocation, "utf-8");
      }
      for (const replacement of replacements) {
        const replacementPair = replacement.split("=");
        let match = replacementPair[0].replaceAll("<NEWLINE>", "\n");
        if (match.startsWith("/") && match.endsWith("/")) {
          match = new RegExp(match.substring(1, match.length - 1), "g");
        }
        const repl = replacementPair[1].replaceAll("<NEWLINE>", "\n");
        podspecContent = podspecContent.replaceAll(match, repl);
      }
      podspecLocation = join(
        dirname(podspecLocation),
        `${randomUUID()}.${podspecLocation.substring(podspecLocation.lastIndexOf(".") + 1)}`,
      );
      writeFileSync(podspecLocation, podspecContent);
      temporaryFiles.add(podspecLocation);
    }
    result = executePodCommand(
      ["ipc", "spec", "--silent", podspecLocation],
      undefined,
      options,
    );
  } else {
    let dependencyName = dependency.name;
    if (dependencyName.includes("/")) {
      dependencyName = dependencyName.substring(0, dependencyName.indexOf("/"));
    }
    const srcFileProperty = {
      name: "SrcFile",
      value: executePodCommand(
        [
          "spec",
          "which",
          `^${dependencyName}$`,
          "--regex",
          `--version=${dependency.version}`,
        ],
        undefined,
        options,
      ).stdout.trim(),
    };
    if (component.properties) {
      component.properties.push(srcFileProperty);
    } else {
      component.properties = [srcFileProperty];
    }
    result = executePodCommand(
      [
        "spec",
        "cat",
        `^${dependencyName}$`,
        "--regex",
        `--version=${dependency.version}`,
      ],
      undefined,
      options,
    );
  }
  const podspecText = result.stdout;
  let podspec;
  try {
    podspec = JSON.parse(
      podspecText.substring(
        podspecText.indexOf("{"),
        podspecText.lastIndexOf("}") + 1,
      ),
    );
  } catch (_e) {
    return;
  }
  const externalRefs = [];
  if (podspec.authors) {
    component.authors = [];
    if (podspec.authors.constructor === Object) {
      Object.entries(podspec.authors).forEach(([name, email]) => {
        email.includes("@")
          ? component.authors.push({ name, email })
          : component.authors.push({ name });
      });
    } else if (podspec.authors.constructor === Array) {
      podspec.authors.forEach((name) => {
        component.authors.push({ name });
      });
    } else {
      component.authors.push({ name: podspec.authors });
    }
  }
  if (podspec.description) {
    component.description = podspec.description;
  } else if (podspec.summary) {
    component.description = podspec.summary;
  }
  if (podspec.documentation_url) {
    externalRefs.push({
      type: "documentation",
      url: podspec.documentation_url,
    });
  } else if (podspec.readme) {
    externalRefs.push({
      type: "documentation",
      url: podspec.readme,
    });
  }
  if (podspec.homepage) {
    externalRefs.push({
      type: "website",
      url: podspec.homepage,
    });
  }
  if (podspec.license) {
    if (podspec.license.constructor === Object) {
      if (podspec.license.type === "Copyright") {
        component.copyright = podspec.license.text;
      } else {
        component.licenses = [{ license: {} }];
        if (spdxLicenses.includes(podspec.license.type)) {
          component.licenses[0].license.id = podspec.license.type;
        } else {
          component.licenses[0].license.name = podspec.license.type;
        }
        const licenseText = [];
        if (podspec.license.text) {
          if (podspec.license.text.startsWith("http")) {
            component.licenses[0].license.url = podspec.license.text;
          } else {
            licenseText.push(podspec.license.text);
          }
        }
        if (podspec.license.file) {
          if (podspec.license.file.startsWith("http")) {
            if (component.licenses[0].license.url) {
              if (licenseText.length !== 0) {
                licenseText.push("");
              }
              licenseText.push(
                `See also: ${component.licenses[0].license.url}`,
              );
            }
            component.licenses[0].license.url = podspec.license.file;
          } else {
            if (licenseText.length !== 0) {
              licenseText.push("");
            }
            licenseText.push(`See license in file '${podspec.license.file}'`);
          }
        }
        if (licenseText.length !== 0) {
          component.licenses[0].license.text = {
            content: licenseText.join("\n"),
          };
        }
      }
    } else {
      if (spdxLicenses.includes(podspec.license)) {
        component.licenses = [{ license: { id: podspec.license } }];
      } else {
        component.licenses = [{ license: { name: podspec.license } }];
      }
    }
  }
  if (podspec.social_media_url) {
    externalRefs.push({
      type: "social",
      url: podspec.social_media_url,
    });
  }
  if (podspec.source) {
    const comment = [];
    if (podspec.source.http) {
      const sourceDistro = {
        type: "source-distribution",
        url: podspec.source.http,
      };
      const hashes = [];
      if (podspec.source.http.sha1) {
        hashes.push({
          alg: "SHA-1",
          content: podspec.source.http.sha1,
        });
      }
      if (podspec.source.http.sha256) {
        hashes.push({
          alg: "SHA-256",
          content: podspec.source.http.sha256,
        });
      }
      if (hashes.length !== 0) {
        sourceDistro.hashes = hashes;
      }
      if (podspec.source.flatten) {
        comment.push(`Flatten: ${podspec.source.flatten}`);
      }
      if (podspec.source.type) {
        comment.push(`Type: ${podspec.source.type}`);
      }
      if (podspec.source.headers) {
        comment.push(`Headers: ${podspec.source.headers}`);
      }
      if (comment.length !== 0) {
        sourceDistro.comment = comment.join("\n");
      }
      externalRefs.push(sourceDistro);
    } else {
      let url;
      if (podspec.source.git) {
        url = podspec.source.git;
        comment.push("Type: git");
        if (podspec.source.branch) {
          comment.push(`Branch: ${podspec.source.branch}`);
        }
        if (podspec.source.commit) {
          comment.push(`Commit: ${podspec.source.commit}`);
        }
        if (podspec.source.tag) {
          comment.push(`Tag: ${podspec.source.tag}`);
        }
        if (podspec.source.submodules) {
          comment.push(`Submodules: ${podspec.source.submodules}`);
        }
      } else if (podspec.source.hg) {
        url = podspec.source.hg;
        comment.push("Type: hg");
        if (podspec.source.revision) {
          comment.push(`Revision: ${podspec.source.revision}`);
        }
      } else if (podspec.source.svn) {
        url = podspec.source.svn;
        comment.push("Type: svn");
        if (podspec.source.folder) {
          comment.push(`Folder: ${podspec.source.folder}`);
        }
        if (podspec.source.revision) {
          comment.push(`Revision: ${podspec.source.revision}`);
        }
        if (podspec.source.tag) {
          comment.push(`Tag: ${podspec.source.tag}`);
        }
      }
      if (url) {
        externalRefs.push({
          type: "vcs",
          url: url,
          comment: comment.join("\n"),
        });
      } else {
        console.warn(
          `${dependency.name} has property 'source' defined, but it does not contain a URL -- ignoring...`,
        );
      }
    }
  }
  if (externalRefs.length !== 0) {
    component.externalReferences = externalRefs;
  }
}

/**
 * Method that handles object creation for gradle modules.
 *
 * @param {string} name The simple name of the module
 * @param {object} metadata Object with all other parsed data for the gradle module
 * @returns {object} An object representing the gradle module in SBOM-format
 */
export async function buildObjectForGradleModule(name, metadata) {
  let component;
  if (
    !["false", "0"].includes(process.env.GRADLE_RESOLVE_FROM_NODE) &&
    metadata.properties?.find(({ name }) => name === "projectDir")
  ) {
    let tmpDir = metadata.properties?.find(
      ({ name }) => name === "projectDir",
    ).value;
    if (tmpDir.indexOf("node_modules") !== -1) {
      do {
        const npmPackages = await parsePkgJson(join(tmpDir, "package.json"));
        if (npmPackages.length === 1) {
          component = { ...npmPackages[0] };
          component.type = "library";
          component.properties = component.properties.concat(
            metadata.properties,
          );
          tmpDir = undefined;
        } else {
          tmpDir = tmpDir.substring(0, tmpDir.lastIndexOf("/"));
        }
      } while (tmpDir && tmpDir.indexOf("node_modules") !== -1);
    }
  }
  if (!component) {
    component = {
      name: name,
      type: "application",
      ...metadata,
    };
    const purl = new PackageURL(
      "maven",
      component.group,
      component.name,
      component.version,
      { type: "jar" },
      null,
    ).toString();
    component["purl"] = purl;
    component["bom-ref"] = decodeURIComponent(purl);
  }
  return component;
}

/**
 * Method to return the maven command to use.
 *
 * @param {string} srcPath Path to look for maven wrapper
 * @param {string} rootPath Root directory to look for maven wrapper
 */
export function getMavenCommand(srcPath, rootPath) {
  let mavenCmd = "mvn";
  // Check if the wrapper script is both available and functional
  let isWrapperReady = false;
  let isWrapperFound = false;
  let findMavenFile = "mvnw";
  let mavenWrapperCmd = null;
  if (platform() === "win32") {
    findMavenFile = "mvnw.bat";
    if (
      !safeExistsSync(join(srcPath, findMavenFile)) &&
      safeExistsSync(join(srcPath, "mvnw.cmd"))
    ) {
      findMavenFile = "mvnw.cmd";
    }
  }

  if (safeExistsSync(join(srcPath, findMavenFile))) {
    // Use local maven wrapper if available
    // Enable execute permission
    try {
      chmodSync(join(srcPath, findMavenFile), 0o775);
    } catch (_e) {
      // continue regardless of error
    }
    mavenWrapperCmd = resolve(join(srcPath, findMavenFile));
    isWrapperFound = true;
  } else if (rootPath && safeExistsSync(join(rootPath, findMavenFile))) {
    // Check if the root directory has a wrapper script
    try {
      chmodSync(join(rootPath, findMavenFile), 0o775);
    } catch (_e) {
      // continue regardless of error
    }
    mavenWrapperCmd = resolve(join(rootPath, findMavenFile));
    isWrapperFound = true;
  }
  if (isWrapperFound) {
    if (DEBUG_MODE) {
      console.log(
        "Testing the wrapper script by invoking wrapper:wrapper task",
      );
    }
    const result = safeSpawnSync(mavenWrapperCmd, ["wrapper:wrapper"], {
      cwd: rootPath,
      shell: isWin,
    });
    if (!result.error && !result.status) {
      isWrapperReady = true;
      mavenCmd = mavenWrapperCmd;
    } else {
      if (DEBUG_MODE) {
        console.log(
          "Maven wrapper script test has failed. Will use the installed version of maven.",
        );
      }
    }
  }
  if (!isWrapperFound || !isWrapperReady) {
    if (process.env.MVN_CMD || process.env.MAVEN_CMD) {
      mavenCmd = process.env.MVN_CMD || process.env.MAVEN_CMD;
    } else if (process.env.MAVEN_HOME) {
      mavenCmd = join(process.env.MAVEN_HOME, "bin", "mvn");
    }
  }
  return mavenCmd;
}

/**
 * Retrieves the atom command by referring to various environment variables
 */
export function getAtomCommand() {
  if (process.env.ATOM_CMD) {
    return process.env.ATOM_CMD;
  }
  if (process.env.ATOM_HOME) {
    return join(process.env.ATOM_HOME, "bin", "atom");
  }
  const NODE_CMD = process.env.NODE_CMD || "node";
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

export function executeAtom(src, args, extra_env = {}) {
  const cwd =
    safeExistsSync(src) && lstatSync(src).isDirectory() ? src : dirname(src);
  let ATOM_BIN = getAtomCommand();
  let isSupported = true;
  if (ATOM_BIN.includes(" ")) {
    const tmpA = ATOM_BIN.split(" ");
    if (tmpA && tmpA.length > 1) {
      ATOM_BIN = tmpA[0];
      args.unshift(tmpA[1]);
    }
  }
  if (DEBUG_MODE) {
    console.log("Executing", ATOM_BIN);
  }
  const env = {
    ...process.env,
    ...extra_env,
  };
  // Atom requires Java >= 21
  if (process.env?.ATOM_JAVA_HOME) {
    env.JAVA_HOME = process.env.ATOM_JAVA_HOME;
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
  const result = safeSpawnSync(ATOM_BIN, args, {
    cwd,
    shell: isWin,
    killSignal: "SIGKILL",
    env,
  });
  if (result.stderr) {
    if (
      result.stderr?.includes(
        "has been compiled by a more recent version of the Java Runtime",
      ) ||
      result.stderr?.includes(
        "Error: Could not create the Java Virtual Machine",
      )
    ) {
      console.log(
        "Atom requires Java 21 or above. To improve the SBOM accuracy, please install a suitable version, set the JAVA_HOME environment variable, and re-run cdxgen.\nAlternatively, use the cdxgen container image.",
      );
      console.log(`Current JAVA_HOME: ${env["JAVA_HOME"] || ""}`);
    } else if (result.stderr?.includes("astgen")) {
      console.warn(
        "WARN: Unable to locate astgen command. Install atom globally using sudo npm install -g @appthreat/atom-parsetools@1.0.4 to resolve this issue.",
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
      result.stdout.includes(
        "The crash happened outside the Java Virtual Machine in native code",
      ) ||
      result.stdout.includes(
        "A fatal error has been detected by the Java Runtime Environment",
      )
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
  return isSupported && !result.error;
}

/**
 * Find the imported modules in the application with atom parsedeps command
 *
 * @param {string} src
 * @param {string} language
 * @param {string} methodology
 * @param {string} slicesFile
 * @returns List of imported modules
 */
export function findAppModules(
  src,
  language,
  methodology = "usages",
  slicesFile = undefined,
) {
  const tempDir = mkdtempSync(join(tmpdir(), "atom-deps-"));
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
    resolve(src),
  ];
  executeAtom(src, args);
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
  if (tempDir?.startsWith(tmpdir()) && rmSync) {
    rmSync(tempDir, { recursive: true, force: true });
  }
  return retList;
}

function flattenDeps(dependenciesMap, pkgList, reqOrSetupFile, t) {
  const tRef = `pkg:pypi/${t.name.replace(/_/g, "-").toLowerCase()}@${
    t.version
  }`;
  const dependsOn = [];
  for (const d of t.dependencies) {
    const pkgRef = `pkg:pypi/${d.name.replace(/_/g, "-").toLowerCase()}@${
      d.version
    }`;
    dependsOn.push(pkgRef);
    if (!dependenciesMap[pkgRef]) {
      dependenciesMap[pkgRef] = [];
    }
    const purlString = new PackageURL(
      "pypi",
      "",
      d.name,
      d.version,
      null,
      null,
    ).toString();
    const apkg = {
      name: d.name,
      version: d.version,
      purl: purlString,
      "bom-ref": decodeURIComponent(purlString),
    };
    if (reqOrSetupFile) {
      apkg.properties = [
        {
          name: "SrcFile",
          value: reqOrSetupFile,
        },
      ];
      apkg.evidence = {
        identity: {
          field: "purl",
          confidence: 0.8,
          methods: [
            {
              technique: "manifest-analysis",
              confidence: 0.8,
              value: reqOrSetupFile,
            },
          ],
        },
      };
    }
    pkgList.push(apkg);
    // Recurse and flatten
    if (d.dependencies && d.dependencies) {
      flattenDeps(dependenciesMap, pkgList, reqOrSetupFile, d);
    }
  }
  dependenciesMap[tRef] = (dependenciesMap[tRef] || [])
    .concat(dependsOn)
    .sort();
}

function get_python_command_from_env(env) {
  // Virtual environments needs special treatment to use the correct python executable
  // Without this step, the default python is always used resulting in false positives
  const python_exe_name = isWin ? "python.exe" : "python";
  const python3_exe_name = isWin ? "python3.exe" : "python3";
  let python_cmd_to_use = PYTHON_CMD;
  if (env.VIRTUAL_ENV) {
    const bin_dir = isWin ? "Scripts" : "bin";
    if (safeExistsSync(join(env.VIRTUAL_ENV, bin_dir, python_exe_name))) {
      python_cmd_to_use = join(env.VIRTUAL_ENV, bin_dir, python_exe_name);
    } else if (
      safeExistsSync(join(env.VIRTUAL_ENV, bin_dir, python3_exe_name))
    ) {
      python_cmd_to_use = join(env.VIRTUAL_ENV, bin_dir, python3_exe_name);
    }
  } else if (env.CONDA_PREFIX) {
    const bin_dir = isWin ? "" : "bin";
    if (safeExistsSync(join(env.CONDA_PREFIX, bin_dir, python_exe_name))) {
      python_cmd_to_use = join(env.CONDA_PREFIX, bin_dir, python_exe_name);
    } else if (
      safeExistsSync(join(env.CONDA_PREFIX, bin_dir, python3_exe_name))
    ) {
      python_cmd_to_use = join(env.CONDA_PREFIX, bin_dir, python3_exe_name);
    }
  } else if (env.CONDA_PYTHON_EXE) {
    python_cmd_to_use = env.CONDA_PYTHON_EXE;
  }
  return python_cmd_to_use;
}

/**
 * Create uv.lock file with uv sync command.
 *
 * @param {string} basePath Path
 * @param {Object} options CLI options
 */
export function createUVLock(basePath, options) {
  const python_cmd = get_python_command_from_env(process.env);
  let uvSyncArgs = ["-m", "uv", "sync"];
  // Do not update the lock file in pre-build mode
  if (options?.lifecycle?.includes("pre-build")) {
    uvSyncArgs.push("--frozen");
  } else if (options?.recurse) {
    uvSyncArgs = uvSyncArgs.concat(["--all-groups", "--all-packages"]);
  }
  // Install everything and do not remove anything extraneous
  if (options?.deep) {
    uvSyncArgs = uvSyncArgs.concat(["--all-extras", "--inexact"]);
  }
  if (process?.env?.UV_INSTALL_ARGS) {
    const addArgs = process.env.UV_INSTALL_ARGS.split(" ");
    uvSyncArgs = uvSyncArgs.concat(addArgs);
  }
  if (DEBUG_MODE) {
    console.log(
      `Executing ${python_cmd} ${uvSyncArgs.join(" ")} in ${basePath}`,
    );
  }
  let result = safeSpawnSync(python_cmd, uvSyncArgs, {
    shell: isWin,
    cwd: basePath,
  });
  if (result.status !== 0 || result.error) {
    if (result?.stderr?.includes("No module named uv")) {
      if (DEBUG_MODE) {
        console.log(`Executing uv sync in ${basePath}`);
      }
      result = safeSpawnSync("uv", ["sync"], {
        shell: isWin,
        cwd: basePath,
      });
      if (result.status !== 0 || result.error) {
        console.log("Check if uv is installed and available in PATH.");
        if (process.env?.CDXGEN_IN_CONTAINER !== "true") {
          console.log(
            "Use the cdxgen container image which comes with uv installed.",
          );
        }
        console.log(result.stderr);
      }
    } else {
      console.log(result.stderr);
    }
  }
}

/**
 * Execute pip freeze by creating a virtual env in a temp directory and construct the dependency tree
 *
 * @param {string} basePath Base path
 * @param {string} reqOrSetupFile Requirements or setup.py file
 * @param {string} tempVenvDir Temp venv dir
 * @param {Object} parentComponent Parent component
 *
 * @returns {Object} List of packages from the virtual env
 */
export async function getPipFrozenTree(
  basePath,
  reqOrSetupFile,
  tempVenvDir,
  parentComponent,
) {
  const pkgList = [];
  const formulationList = [];
  const rootList = [];
  const dependenciesList = [];
  let result;
  let frozen = true;
  const env = {
    ...process.env,
  };

  // FIX: Create a set of explicit dependencies from requirements.txt to identify root packages.
  const explicitDeps = new Set();
  if (reqOrSetupFile?.endsWith(".txt") && safeExistsSync(reqOrSetupFile)) {
    // We only need the package names, so we pass `false` to avoid fetching full metadata.
    const tempPkgList = await parseReqFile(reqOrSetupFile, null, false);
    for (const pkg of tempPkgList) {
      if (pkg.name) {
        // Normalize the name (lowercase, hyphenated) for accurate lookups.
        explicitDeps.add(pkg.name.replace(/_/g, "-").toLowerCase());
      }
    }
  }

  /**
   * Let's start with an attempt to create a new temporary virtual environment in case we aren't in one
   *
   * By checking the environment variable "VIRTUAL_ENV" we decide whether to create an env or not
   */
  if (
    !process.env.VIRTUAL_ENV &&
    !process.env.CONDA_PREFIX &&
    reqOrSetupFile &&
    !reqOrSetupFile.endsWith("poetry.lock")
  ) {
    thoughtLog(
      "Let me create a new virtual environment for installing the packages with pip.",
    );
    result = safeSpawnSync(PYTHON_CMD, ["-m", "venv", tempVenvDir], {
      shell: isWin,
    });
    if (result.status !== 0 || result.error) {
      frozen = false;
      if (DEBUG_MODE) {
        console.log("Virtual env creation has failed");
        if (result.stderr?.includes("safeSpawnSync python ENOENT")) {
          console.log(
            "Install suitable version of python or set the environment variable PYTHON_CMD.",
          );
        }
      }
    } else {
      if (DEBUG_MODE) {
        console.log("Using the virtual environment", tempVenvDir);
      }
      env.VIRTUAL_ENV = tempVenvDir;
      env.PATH = `${join(
        tempVenvDir,
        platform() === "win32" ? "Scripts" : "bin",
      )}${_delimiter}${process.env.PATH || ""}`;
      // When cdxgen is invoked with the container image, we seem to be including unnecessary packages from the image.
      // This workaround, unsets PYTHONPATH to suppress the pre-installed packages
      if (
        env?.PYTHONPATH === "/opt/pypi" &&
        env?.CDXGEN_IN_CONTAINER === "true"
      ) {
        env.PYTHONPATH = undefined;
      }
    }
  }
  /**
   * We now have a virtual environment so we can attempt to install the project and perform
   * pip freeze to collect the packages that got installed.
   * Note that we did not create a virtual environment for poetry because poetry will do this when we run the install.
   * This step is accurate but not reproducible since the resulting list could differ based on various factors
   * such as the version of python, pip, os, pypi.org availability (and weather?)
   */
  // Bug #388. Perform pip install in all virtualenv to make the experience consistent
  if (reqOrSetupFile) {
    // We have a poetry.lock file
    if (reqOrSetupFile.endsWith("poetry.lock")) {
      const poetryConfigArgs = [
        "-m",
        "poetry",
        "config",
        "virtualenvs.options.no-setuptools",
        "true",
        "--local",
      ];
      result = safeSpawnSync(PYTHON_CMD, poetryConfigArgs, {
        cwd: basePath,
        shell: isWin,
      });
      thoughtLog("Performing poetry install");
      let poetryInstallArgs = ["-m", "poetry", "install", "-n", "--no-root"];
      // Attempt to perform poetry install
      result = safeSpawnSync(PYTHON_CMD, poetryInstallArgs, {
        cwd: basePath,
        shell: isWin,
      });
      if (result.status !== 0 || result.error) {
        if (result.stderr?.includes("No module named poetry")) {
          thoughtLog(
            "Hmm, poetry doesn't seem to be available as a module. Perhaps it was installed directly 🤔?",
          );
          poetryInstallArgs = ["install", "-n", "--no-root"];
          // Attempt to perform poetry install
          result = safeSpawnSync("poetry", poetryInstallArgs, {
            cwd: basePath,
            shell: isWin,
            env,
          });
          if (result.status !== 0 || result.error) {
            frozen = false;
            if (DEBUG_MODE && result.stderr) {
              console.log(result.stderr);
            }
            thoughtLog(
              "poetry install has failed. Let me suggest some troubleshooting ideas.",
            );
            console.log("poetry install has failed.");
            console.log(
              "1. Install the poetry command using python -m pip install poetry.",
            );
            console.log(
              "2. Check the version of python supported by the project. Poetry is strict about the version used.",
            );
            console.log(
              "3. Setup and activate the poetry virtual environment and re-run cdxgen.",
            );
          }
        } else {
          frozen = false;
          console.log(
            "Poetry install has failed. Setup and activate the poetry virtual environment and re-run cdxgen.",
          );
          if (DEBUG_MODE) {
            if (result.error) {
              console.log(result.error);
            }
            if (result.stderr) {
              console.log(result.stderr);
            }
          }
        }
      } else {
        const poetryEnvArgs = ["env info", "--path"];
        result = safeSpawnSync("poetry", poetryEnvArgs, {
          cwd: basePath,
          shell: isWin,
          env,
        });
        tempVenvDir = result.stdout?.replaceAll(/[\r\n]+/g, "");
        if (tempVenvDir?.length) {
          env.VIRTUAL_ENV = tempVenvDir;
          env.PATH = `${join(
            tempVenvDir,
            platform() === "win32" ? "Scripts" : "bin",
          )}${_delimiter}${process.env.PATH || ""}`;
        }
      }
    } else {
      // We are about to do a pip install with the right python command from the virtual environment
      // This step can fail if the correct OS packages and development libraries are not installed
      const python_cmd_for_tree = get_python_command_from_env(env);
      let pipInstallArgs = [
        "-m",
        "pip",
        "install",
        "--disable-pip-version-check",
      ];
      // Requirements.txt could be called with any name so best to check for not setup.py and not pyproject.toml
      if (
        !reqOrSetupFile.endsWith("setup.py") &&
        !reqOrSetupFile.endsWith("pyproject.toml")
      ) {
        pipInstallArgs.push("-r");
        pipInstallArgs.push(resolve(reqOrSetupFile));
        if (reqOrSetupFile.includes("test")) {
          thoughtLog(
            `${reqOrSetupFile} appears to be related to tests. Should I suggest the "--exclude" argument?`,
          );
        }
      } else {
        pipInstallArgs.push(resolve(basePath));
      }
      // Support for passing additional arguments to pip
      // Eg: --python-version 3.10 --ignore-requires-python --no-warn-conflicts --only-binary=:all:
      if (process?.env?.PIP_INSTALL_ARGS) {
        const addArgs = process.env.PIP_INSTALL_ARGS.split(" ");
        pipInstallArgs = pipInstallArgs.concat(addArgs);
      }
      thoughtLog(
        `**PIP**: Trying pip install using the arguments ${pipInstallArgs.join(" ")}`,
      );
      if (DEBUG_MODE) {
        console.log("Executing", python_cmd_for_tree);
      }
      // Attempt to perform pip install
      result = safeSpawnSync(python_cmd_for_tree, pipInstallArgs, {
        cwd: basePath,
        shell: isWin,
        env,
      });
      if (result.status !== 0 || result.error) {
        frozen = false;
        let versionRelatedError = false;
        if (
          result.stderr?.includes(
            "Could not find a version that satisfies the requirement",
          ) ||
          result.stderr?.includes("No matching distribution found for")
        ) {
          versionRelatedError = true;
          if (process.env.PIP_INSTALL_ARGS) {
            console.log(
              "1. Try invoking cdxgen with a different python type. Example: `-t python`, `-t python310`, or `-t python39`\n",
            );
          } else {
            console.log(
              "The version or the version specifiers used for a dependency is invalid. Try with a different python type such as -t python310 or -t python39.\nOriginal error from pip:\n",
            );
          }
          console.log(result.stderr);
        } else if (
          process.env.PIP_INSTALL_ARGS &&
          result.stderr?.includes("Cannot set --home and --prefix together")
        ) {
          versionRelatedError = true;
          thoughtLog(`Got the error: ${result.stderr.split("\n").slice(0, 5)}`);
          if (DEBUG_MODE) {
            console.log(result.stderr);
          } else {
            console.log(
              "Possible build errors detected with 'pip install'. Set the environment variable CDXGEN_DEBUG_MODE=debug to troubleshoot.",
            );
            if (result?.stderr?.includes("No module named pip")) {
              console.log(
                "Using uv? Run uv pip install command prior to running cdxgen.",
              );
            } else {
              console.log(result.stderr.split("\n").slice(0, 5));
            }
          }
          console.warn(
            "This project does not support python with version types. Use an appropriate container image such as `ghcr.io/appthreat/cdxgen-python39:v12` or `ghcr.io/appthreat/cdxgen-python311:v12` and invoke cdxgen with `-t python` instead.\n",
          );
        } else if (
          result?.stderr?.includes(
            "pip subprocess to install build dependencies",
          )
        ) {
          console.log(
            "Installing build dependencies has failed. Use an appropriate container image such as `ghcr.io/appthreat/cdxgen-python39:v12` or `ghcr.io/appthreat/cdxgen-python311:v12` and invoke cdxgen with `-t python` instead.",
          );
          if (
            result?.stderr?.includes(
              "Failed to build installable wheels for some pyproject.toml based projects",
            )
          ) {
            console.log(
              "Try upgrading setuptools with `python -m pip install setuptools --upgrade`",
            );
          }
          if (process.env?.CDXGEN_IN_CONTAINER !== "true") {
            thoughtLog(
              "Installation of build dependencies failed. I told you we must use container images for python.",
            );
          } else {
            thoughtLog(
              "Installation of build dependencies failed. Perhaps the user is using the wrong container image?",
            );
          }
        }
        if (!versionRelatedError) {
          if (DEBUG_MODE) {
            console.info(
              "\nEXPERIMENTAL: Invoke cdxgen with '--feature-flags safe-pip-install' to recover a partial dependency tree for projects with build errors.\n",
            );
            if (result.stderr) {
              console.log(result.stderr);
            }
            console.log(
              "Possible build errors detected. The resulting list in the SBOM would therefore be incomplete.\nTry installing any missing build tools or development libraries to improve the accuracy.",
            );
            thoughtLog(
              "Possible build errors detected. We have an incomplete list of pypi components and dependencies.",
            );
            if (platform() === "win32") {
              console.log(
                "- Install the appropriate compilers and build tools on Windows by following this documentation - https://wiki.python.org/moin/WindowsCompilers",
              );
            } else {
              console.log(
                "- For example, you may have to install gcc, gcc-c++ compiler, postgresql or mysql devel packages and additional development libraries using apt-get or yum package manager.",
              );
            }
            console.log(
              "- Certain projects would only build with specific versions of Python. Data science and ML related projects might require a conda/anaconda distribution.",
            );
            console.log(
              "- Check if any git submodules have to be initialized.\n- If the application has its own Dockerfile, look for any clues for build dependencies.",
            );
            if (
              process.env?.CDXGEN_IN_CONTAINER !== "true" &&
              !process.env.PIP_INSTALL_ARGS
            ) {
              console.log(
                "1. Try invoking cdxgen with a specific python version type. Example: `-t python36` or `-t python39`",
              );
              console.log(
                "2. Alternatively, try using the custom container images `ghcr.io/cyclonedx/cdxgen-python39:v12` or `ghcr.io/cyclonedx/cdxgen-python311:v12`, which bundles a range of build tools and development libraries.",
              );
            } else if (
              process.env?.PIP_INSTALL_ARGS?.includes("--python-version")
            ) {
              console.log(
                "1. Try invoking cdxgen with a different python version type. Example: `-t python`, `-t python39`, or `-t python311`",
              );
              console.log(
                "2. Try with the experimental flag '--feature-flags safe-pip-install'",
              );
            }
          } else {
            if (process.env?.CDXGEN_IN_CONTAINER !== "true") {
              thoughtLog(
                "**PIP**: Installation of build dependencies failed. If in doubt, use the cdxgen container images for python.",
              );
            } else {
              thoughtLog(
                "Installation of build dependencies failed. Perhaps the user is using the wrong cdxgen container image? Should I recommend raising a GitHub issue?",
              );
            }
            // Bug #1640. result.stderr is null here despite the process erroring with a non-zero value.
            // How do we reproduce this with repo tests?
            if (result?.stderr) {
              if (result?.stderr?.includes("No module named pip")) {
                console.log(
                  "Using uv? Run uv pip install command prior to running cdxgen.",
                );
              } else {
                console.log(
                  "Possible build errors detected. Set the environment variable CDXGEN_DEBUG_MODE=debug to troubleshoot.",
                );
                console.log(result.stderr?.split("\n")?.slice(0, 5));
              }
            }
          }
        }
      }
    }
  }
  // Bug #375. Attempt pip freeze on existing and new virtual environments
  if (env.VIRTUAL_ENV?.length || env.CONDA_PREFIX?.length) {
    /**
     * At this point, the previous attempt to do a pip install might have failed and we might have an unclean virtual environment with an incomplete list
     * The position taken by cdxgen is "Some SBOM is better than no SBOM", so we proceed to collecting the dependencies that got installed with pip freeze
     */
    if (DEBUG_MODE) {
      if (reqOrSetupFile) {
        console.log(
          `About to construct the pip dependency tree based on ${reqOrSetupFile}. Please wait ...`,
        );
      }
    }
    const python_cmd_for_tree = get_python_command_from_env(env);
    // This is a slow step that ideally needs to be invoked only once per venv
    const tree = getTreeWithPlugin(env, python_cmd_for_tree, basePath);
    if (DEBUG_MODE && !tree.length) {
      console.log(
        "Dependency tree generation has failed. Please check for any errors or version incompatibilities reported in the logs.",
      );
    }
    const dependenciesMap = {};
    for (const t of tree) {
      const name = t.name.replace(/_/g, "-").toLowerCase();
      // Bug #1232 - the root package might lack a version resulting in duplicate tree
      // So we make use of the existing parent component to try and patch the version
      if (
        parentComponent &&
        parentComponent.name === t.name &&
        parentComponent.version &&
        parentComponent?.version !== "latest" &&
        t.version === "latest"
      ) {
        t.version = parentComponent.version;
      }
      const version = t.version;
      const scope = PYTHON_EXCLUDED_COMPONENTS.includes(name)
        ? "excluded"
        : undefined;
      if (!scope && !t.version.length) {
        // Don't leave out any local dependencies
        if (t.dependencies.length) {
          flattenDeps(dependenciesMap, pkgList, reqOrSetupFile, t);
        }
        continue;
      }
      const purlString = new PackageURL(
        "pypi",
        "",
        name,
        version,
        null,
        null,
      ).toString();
      const apkg = {
        name,
        version,
        purl: purlString,
        type: "library",
        "bom-ref": decodeURIComponent(purlString),
        scope,
        evidence: {
          identity: {
            field: "purl",
            confidence: 1,
            methods: [
              {
                technique: "instrumentation",
                confidence: 1,
                value: env.VIRTUAL_ENV || env.CONDA_PREFIX,
              },
            ],
          },
        },
        properties: [
          {
            name: "SrcFile",
            value: reqOrSetupFile,
          },
        ],
      };
      if (scope !== "excluded") {
        pkgList.push(apkg);
        if (explicitDeps.size === 0 || explicitDeps.has(name)) {
          rootList.push({
            name,
            version,
            purl: purlString,
            "bom-ref": decodeURIComponent(purlString),
          });
        }
        flattenDeps(dependenciesMap, pkgList, reqOrSetupFile, t);
      } else {
        formulationList.push(apkg);
      }
    } // end for
    for (const k of Object.keys(dependenciesMap)) {
      dependenciesList.push({
        ref: k,
        dependsOn: [...new Set(dependenciesMap[k])].sort(),
      });
    }
  }
  return {
    pkgList,
    formulationList,
    rootList,
    dependenciesList,
    frozen,
  };
}

/**
 * The problem: pip installation can fail for a number of reasons such as missing OS dependencies and devel packages.
 * When it fails, we don't get any dependency tree. As a workaroud, this method would attempt to install one package at a time to the same virtual environment and then attempts to obtain a dependency tree.
 * Such a tree could be incorrect or quite approximate, but some users might still find it useful to know the names of the indirect dependencies.
 *
 * @param {string} basePath Base path
 * @param {Array} pkgList Existing package list
 * @param {string} tempVenvDir Temp venv dir
 * @param {Object} parentComponent Parent component
 *
 * @returns List of packages from the virtual env
 */
export function getPipTreeForPackages(
  basePath,
  pkgList,
  tempVenvDir,
  parentComponent,
) {
  const failedPkgList = [];
  const rootList = [];
  const dependenciesList = [];
  let result;
  const env = {
    ...process.env,
  };
  if (!process.env.VIRTUAL_ENV && !process.env.CONDA_PREFIX) {
    // Create a virtual environment
    result = safeSpawnSync(PYTHON_CMD, ["-m", "venv", tempVenvDir], {
      shell: isWin,
    });
    if (result.status !== 0 || result.error) {
      console.log("Virtual env creation has failed. Unable to continue.");
      return {};
    }
    env.VIRTUAL_ENV = tempVenvDir;
    env.PATH = `${join(
      tempVenvDir,
      platform() === "win32" ? "Scripts" : "bin",
    )}${_delimiter}${process.env.PATH || ""}`;
    // When cdxgen is invoked with the container image, we seem to be including unnecessary packages from the image.
    // This workaround, unsets PYTHONPATH to suppress the pre-installed packages
    if (
      env?.PYTHONPATH === "/opt/pypi" &&
      env?.CDXGEN_IN_CONTAINER === "true"
    ) {
      env.PYTHONPATH = undefined;
    }
  }
  const python_cmd_for_tree = get_python_command_from_env(env);
  let pipInstallArgs = ["-m", "pip", "install", "--disable-pip-version-check"];
  // Support for passing additional arguments to pip
  // Eg: --python-version 3.10 --ignore-requires-python --no-warn-conflicts
  if (process?.env?.PIP_INSTALL_ARGS) {
    const addArgs = process.env.PIP_INSTALL_ARGS.split(" ");
    pipInstallArgs = pipInstallArgs.concat(addArgs);
  } else {
    pipInstallArgs = pipInstallArgs.concat([
      "--ignore-requires-python",
      "--no-compile",
      "--no-warn-script-location",
      "--no-warn-conflicts",
    ]);
  }
  if (DEBUG_MODE) {
    console.log(
      "Installing",
      pkgList.length,
      "packages using the command",
      python_cmd_for_tree,
      pipInstallArgs.join(" "),
    );
  }
  for (const apkg of pkgList) {
    let pkgSpecifier = apkg.name;
    if (apkg.version && apkg.version !== "latest") {
      pkgSpecifier = `${apkg.name}==${apkg.version}`;
    } else if (apkg.properties) {
      let versionSpecifierFound = false;
      for (const aprop of apkg.properties) {
        if (aprop.name === "cdx:pypi:versionSpecifiers") {
          pkgSpecifier = `${apkg.name}${aprop.value}`;
          versionSpecifierFound = true;
          break;
        }
      }
      if (!versionSpecifierFound) {
        failedPkgList.push(apkg);
        continue;
      }
    } else {
      failedPkgList.push(apkg);
      continue;
    }
    if (DEBUG_MODE) {
      console.log("Installing", pkgSpecifier);
    }
    // Attempt to perform pip install for pkgSpecifier
    const result = safeSpawnSync(
      python_cmd_for_tree,
      [...pipInstallArgs, pkgSpecifier],
      {
        cwd: basePath,
        shell: isWin,
        env,
      },
    );
    if (result.status !== 0 || result.error) {
      failedPkgList.push(apkg);
      if (DEBUG_MODE) {
        console.log(apkg.name, "failed to install.");
      }
    }
  }
  // Did any package get installed successfully?
  if (failedPkgList.length < pkgList.length) {
    const dependenciesMap = {};
    const tree = getTreeWithPlugin(env, python_cmd_for_tree, basePath);
    for (const t of tree) {
      const name = t.name.replace(/_/g, "-").toLowerCase();
      // We can ignore excluded components such as build tools
      if (PYTHON_EXCLUDED_COMPONENTS.includes(name)) {
        continue;
      }
      if (parentComponent && parentComponent.name === t.name) {
        t.version = parentComponent.version;
      } else if (t.version && t.version === "latest") {
        continue;
      }
      const version = t.version;
      const purlString = new PackageURL(
        "pypi",
        "",
        name,
        version,
        null,
        null,
      ).toString();
      const apkg = {
        name,
        version,
        purl: purlString,
        type: "library",
        "bom-ref": decodeURIComponent(purlString),
        evidence: {
          identity: {
            field: "purl",
            confidence: 0.5,
            methods: [
              {
                technique: "instrumentation",
                confidence: 0.5,
                value: env.VIRTUAL_ENV,
              },
            ],
          },
        },
      };
      // These packages have lower confidence
      pkgList.push(apkg);
      rootList.push({
        name,
        version,
        purl: purlString,
        "bom-ref": decodeURIComponent(purlString),
      });
      flattenDeps(dependenciesMap, pkgList, undefined, t);
    } // end for
    for (const k of Object.keys(dependenciesMap)) {
      dependenciesList.push({
        ref: k,
        dependsOn: [...new Set(dependenciesMap[k])].sort(),
      });
    }
  } // end if
  return {
    failedPkgList,
    rootList,
    dependenciesList,
  };
}

// taken from a very old package https://github.com/keithamus/parse-packagejson-name/blob/master/index.js
export function parsePackageJsonName(name) {
  const nameRegExp = /^(?:@([^/]+)\/)?(([^.]+)(?:\.(.*))?)$/;
  const returnObject = {
    scope: null,
    fullName: "",
    projectName: "",
    moduleName: "",
  };
  const safeName = name?.name ?? name ?? "";
  const match = safeName.match(nameRegExp);
  if (match) {
    returnObject.scope =
      (match[1] && name.includes("@") ? `@${match[1]}` : match[1]) || null;
    returnObject.fullName = match[2] || match[0];
    returnObject.projectName = match[3] === match[2] ? null : match[3];
    returnObject.moduleName = match[4] || match[2] || null;
  }
  return returnObject;
}

/**
 * Method to add occurrence evidence for components based on import statements. Currently useful for js
 *
 * @param {array} pkgList List of package
 * @param {object} allImports Import statements object with package name as key and an object with file and location details
 * @param {object} allExports Exported modules if available from node_modules
 * @param {Boolean} deep Deep mode
 */
export async function addEvidenceForImports(
  pkgList,
  allImports,
  allExports,
  deep,
) {
  const impPkgs = Object.keys(allImports);
  const exportedPkgs = Object.keys(allExports);
  for (const pkg of pkgList) {
    if (impPkgs?.length) {
      // Assume that all packages are optional until we see an evidence
      pkg.scope = "optional";
    }
    const { group, name } = pkg;
    // Evidence belonging to a type must be associated with the package
    if (group === "@types") {
      continue;
    }
    const aliases = group?.length
      ? [name, `${group}/${name}`, `@${group}/${name}`]
      : [name];
    for (const alias of aliases) {
      const all_includes = impPkgs.filter(
        (find_pkg) =>
          find_pkg.startsWith(alias) &&
          (find_pkg.length === alias.length || find_pkg[alias.length] === "/"),
      );
      const all_exports = exportedPkgs.filter((find_pkg) =>
        find_pkg.startsWith(alias),
      );
      if (all_exports?.length) {
        let exportedModules = new Set(all_exports);
        pkg.properties = pkg.properties || [];
        for (const subevidence of all_exports) {
          const evidences = allExports[subevidence];
          for (const evidence of evidences) {
            if (evidence && Object.keys(evidence).length) {
              if (evidence.exportedModules.length > 1) {
                for (const aexpsubm of evidence.exportedModules) {
                  // Be selective on the submodule names
                  if (
                    !evidence.importedAs
                      .toLowerCase()
                      .includes(aexpsubm.toLowerCase()) &&
                    !alias.endsWith(aexpsubm)
                  ) {
                    // Store both the short and long form of the exported sub modules
                    if (aexpsubm.length > 3) {
                      exportedModules.add(aexpsubm);
                    }
                    exportedModules.add(
                      `${evidence.importedAs.replace("./", "")}/${aexpsubm}`,
                    );
                  }
                }
              }
            }
          }
        }
        exportedModules = Array.from(exportedModules);
        if (exportedModules.length) {
          pkg.properties.push({
            name: "ExportedModules",
            value: exportedModules.join(","),
          });
        }
      }
      // Identify all the imported modules of a component
      if (impPkgs.includes(alias) || all_includes.length) {
        let importedModules = new Set();
        pkg.scope = "required";
        for (const subevidence of all_includes) {
          const evidences = allImports[subevidence];
          for (const evidence of evidences) {
            if (evidence && Object.keys(evidence).length && evidence.fileName) {
              pkg.evidence = pkg.evidence || {};
              pkg.evidence.occurrences = pkg.evidence.occurrences || [];
              pkg.evidence.occurrences.push({
                location: `${evidence.fileName}${
                  evidence.lineNumber ? `#${evidence.lineNumber}` : ""
                }`,
              });
              importedModules.add(evidence.importedAs);
              for (const importedSm of evidence.importedModules || []) {
                if (!importedSm) {
                  continue;
                }
                // Store both the short and long form of the imported sub modules
                if (importedSm.length > 3) {
                  importedModules.add(importedSm);
                }
                importedModules.add(`${evidence.importedAs}/${importedSm}`);
              }
            }
          }
        }
        importedModules = Array.from(importedModules);
        if (importedModules.length) {
          pkg.properties = pkg.properties || [];
          pkg.properties.push({
            name: "ImportedModules",
            value: importedModules.join(","),
          });
        }
        break;
      }
      // Capture metadata such as description from local node_modules in deep mode
      if (deep && !pkg.description && pkg.properties) {
        let localNodeModulesPath;
        for (const aprop of pkg.properties) {
          if (aprop.name === "LocalNodeModulesPath") {
            localNodeModulesPath = resolve(join(aprop.value, "package.json"));
            break;
          }
        }
        if (localNodeModulesPath && safeExistsSync(localNodeModulesPath)) {
          const lnmPkgList = await parsePkgJson(localNodeModulesPath, true);
          if (lnmPkgList && lnmPkgList.length === 1) {
            const lnmMetadata = lnmPkgList[0];
            if (lnmMetadata && Object.keys(lnmMetadata).length) {
              pkg.description = lnmMetadata.description;
              pkg.author = lnmMetadata.author;
              pkg.license = lnmMetadata.license;
              pkg.homepage = lnmMetadata.homepage;
              pkg.repository = lnmMetadata.repository;
            }
          }
        }
      }
    } // for alias
    // Trim the properties
    pkg.properties = pkg.properties.filter(
      (p) => p.name !== "LocalNodeModulesPath",
    );
  } // for pkg
  return pkgList;
}

export function componentSorter(a, b) {
  if (a && b) {
    for (const k of ["bom-ref", "purl", "name"]) {
      if (a[k] && b[k]) {
        return a[k].localeCompare(b[k]);
      }
    }
  }
  return a.localeCompare(b);
}

export function parseCmakeDotFile(dotFile, pkgType, options = {}) {
  const dotGraphData = readFileSync(dotFile, { encoding: "utf-8" });
  const pkgList = [];
  const dependenciesMap = {};
  const pkgBomRefMap = {};
  let parentComponent = {};
  dotGraphData.split("\n").forEach((l) => {
    l = l.replace("\r", "").trim();
    if (l === "\n" || l.startsWith("#")) {
      return;
    }
    let name = "";
    const group = "";
    const version = "";
    let path;
    if (l.startsWith("digraph")) {
      const tmpA = l.split(" ");
      if (tmpA && tmpA.length > 1) {
        name = tmpA[1].replace(/"/g, "");
      }
    } else if (l.startsWith('"node')) {
      // Direct dependencies are represented as nodes
      if (l.includes("label =")) {
        const tmpA = l.split('label = "');
        if (tmpA && tmpA.length > 1) {
          name = tmpA[1].split('"')[0];
        }
        if (name.includes("\\n")) {
          name = name.split("\\n")[0];
        } else if (name.includes(_sep)) {
          path = name;
          name = basename(name);
        }
      } else if (l.includes("// ")) {
        // Indirect dependencies are represented with comments
        const tmpA = l.split("// ");
        if (tmpA?.length) {
          const relationship = tmpA[1];
          if (relationship.includes("->")) {
            const tmpB = relationship.split(" -> ");
            if (tmpB && tmpB.length === 2) {
              if (tmpB[0].includes(_sep)) {
                tmpB[0] = basename(tmpB[0]);
              }
              if (tmpB[1].includes(_sep)) {
                tmpB[1] = basename(tmpB[1]);
              }
              const ref = pkgBomRefMap[tmpB[0]];
              const depends = pkgBomRefMap[tmpB[1]];
              if (ref && depends) {
                if (!dependenciesMap[ref]) {
                  dependenciesMap[ref] = new Set();
                }
                dependenciesMap[ref].add(depends);
              }
            }
          }
        }
      }
    }
    if (!Object.keys(parentComponent).length) {
      parentComponent = {
        group: options.projectGroup || "",
        name: "project-name" in options ? options.projectName : name,
        version: options.projectVersion || "",
        type: "application",
      };
      parentComponent["purl"] = new PackageURL(
        pkgType,
        parentComponent.group,
        parentComponent.name,
        parentComponent.version,
        null,
        path,
      ).toString();
      parentComponent["bom-ref"] = decodeURIComponent(parentComponent["purl"]);
    } else if (name) {
      const apkg = {
        name: name,
        type: pkgType,
        purl: new PackageURL(
          pkgType,
          group,
          name,
          version,
          null,
          path,
        ).toString(),
      };
      apkg["bom-ref"] = decodeURIComponent(apkg["purl"]);
      pkgList.push(apkg);
      pkgBomRefMap[name] = apkg["bom-ref"];
    }
  });
  const dependenciesList = [];
  for (const pk of Object.keys(dependenciesMap)) {
    const dependsOn = Array.from(dependenciesMap[pk] || []).sort();
    dependenciesList.push({
      ref: pk,
      dependsOn,
    });
  }
  return {
    parentComponent,
    pkgList,
    dependenciesList,
  };
}

export function parseCmakeLikeFile(cmakeListFile, pkgType, options = {}) {
  let cmakeListData = readFileSync(cmakeListFile, { encoding: "utf-8" });
  const pkgList = [];
  const pkgAddedMap = {};
  const versionSpecifiersMap = {};
  const versionsMap = {};
  let parentComponent = {};
  const templateValues = {};
  cmakeListData = cmakeListData
    .replace(/^ {2}/g, "")
    .replace(/\(\r\n/g, "(")
    .replace(/\(\n/g, "(")
    .replace(/,\r\n/g, ",")
    .replace(/,\n/g, ",");
  cmakeListData.split("\n").forEach((l) => {
    l = l.replace("\r", "").trim();
    if (l === "\n" || l.startsWith("#")) {
      return;
    }
    const group = "";
    const path = undefined;
    const name_list = [];
    if (l.startsWith("set")) {
      const tmpA = l.replace("set(", "").replace(")", "").trim().split(" ");
      if (tmpA && tmpA.length === 2) {
        templateValues[tmpA[0]] = tmpA[1];
      }
    } else if (
      l.startsWith("project") &&
      !Object.keys(parentComponent).length
    ) {
      if (l.includes("${")) {
        for (const tmplKey of Object.keys(templateValues)) {
          l = l.replace(`\${${tmplKey}}`, templateValues[tmplKey] || "");
        }
      }
      const tmpA = l.replace("project (", "project(").split("project(");
      if (tmpA && tmpA.length > 1) {
        const tmpB = (tmpA[1] || "")
          .trim()
          .replace(/["']/g, "")
          .replace(/ /g, ",")
          .split(")")[0]
          .split(",")
          .filter((v) => v.length > 1);
        const parentName =
          tmpB.length > 0 ? tmpB[0].replace(":", "").trim() : "";
        let parentVersion;
        // In case of meson.build we can find the version number after the word version
        // thanks to our replaces and splits
        const versionIndex = tmpB.findIndex(
          (v) => v?.toLowerCase() === "version",
        );
        if (versionIndex > -1 && tmpB.length > versionIndex) {
          parentVersion = tmpB[versionIndex + 1];
        }
        if (parentName?.length && !parentName.includes("$")) {
          parentComponent = {
            group: options.projectGroup || "",
            name: parentName,
            version: parentVersion || options.projectVersion || "",
            type: "application",
          };
          parentComponent["purl"] = new PackageURL(
            pkgType,
            parentComponent.group,
            parentComponent.name,
            parentComponent.version,
            null,
            path,
          ).toString();
          parentComponent["bom-ref"] = decodeURIComponent(
            parentComponent["purl"],
          );
        }
      }
    } else if (l.startsWith("find_")) {
      let tmpA = [];
      for (const fm of [
        "find_package(",
        "find_library(",
        "find_dependency(",
        "find_file(",
        "FetchContent_MakeAvailable(",
      ]) {
        if (l.startsWith(fm)) {
          tmpA = l.split(fm);
          break;
        }
      }
      if (tmpA && tmpA.length > 1) {
        let tmpB = tmpA[1].split(")")[0].split(" ");
        tmpB = tmpB.filter(
          (v) =>
            ![
              "REQUIRED",
              "COMPONENTS",
              "QUIET",
              "NAMES",
              "PATHS",
              "ENV",
              "NO_MODULE",
              "NO_DEFAULT_PATH",
            ].includes(v) &&
            !v.includes("$") &&
            !v.includes("LIB") &&
            !v.startsWith("CMAKE_") &&
            v.length,
        );
        // find_package(Catch2)
        // find_package(GTest REQUIRED)
        // find_package(Boost 1.79 COMPONENTS date_time)
        // find_library(PTHREADPOOL_LIB pthreadpool REQUIRED)
        if (tmpB) {
          let working_name;
          if (l.startsWith("find_library")) {
            name_list.push(tmpB[1]);
            working_name = tmpB[1];
          } else {
            name_list.push(tmpB[0]);
            working_name = tmpB[0];
          }
          if (l.startsWith("find_package") && tmpB.length > 1) {
            if (
              /^\d+/.test(tmpB[1]) &&
              !tmpB[1].includes("${") &&
              !tmpB[1].startsWith("@")
            ) {
              versionsMap[working_name] = tmpB[1];
            }
          } else {
            for (const n of tmpB) {
              if (n.match(/^\d/)) {
                continue;
              }
              if (n.includes(_sep)) {
                if (
                  n.includes(".so") ||
                  n.includes(".a") ||
                  n.includes(".dll")
                ) {
                  name_list.push(basename(n));
                }
              } else {
                name_list.push(n);
              }
            }
          }
        }
      }
    } else if (l.includes("dependency(")) {
      let tmpA = l.split("dependency(");
      if (tmpA?.length) {
        if (!l.includes("_dependency") && !l.includes(".dependency")) {
          tmpA = tmpA[tmpA.length - 1]
            .split(", ")
            .map((v) => v.replace(/['" )]/g, ""));
          if (tmpA.length) {
            name_list.push(tmpA[0]);
            if (tmpA.length > 2 && tmpA[1].startsWith("version")) {
              const tmpB = tmpA[1].split("version:");
              if (tmpB && tmpB.length === 2) {
                if (tmpB[1].includes(">") || tmpB[1].includes("<")) {
                  // We have a version specifier
                  versionSpecifiersMap[tmpA[0]] = tmpB[1];
                } else if (
                  /^\d+/.test(tmpB[1]) &&
                  !tmpB[1].includes("${") &&
                  !tmpB[1].startsWith("@")
                ) {
                  // We have a valid version
                  versionsMap[tmpA[0]] = tmpB[1];
                }
              }
            }
          }
        }
      }
    }
    for (let n of name_list) {
      const props = [];
      let confidence = 0;
      if (
        n &&
        n.length > 1 &&
        !pkgAddedMap[n] &&
        !n.startsWith(_sep) &&
        !n.startsWith("@")
      ) {
        n = n.replace(/"/g, "");
        // Can this be replaced with a db lookup?
        for (const wrapkey of Object.keys(mesonWrapDB)) {
          const awrap = mesonWrapDB[wrapkey];
          if (
            awrap.PkgProvides.includes(n) ||
            awrap.PkgProvides.includes(n.toLowerCase())
          ) {
            // Use the new name
            n = wrapkey;
            for (const eprop of Object.keys(awrap)) {
              props.push({
                name: eprop,
                value: Array.isArray(awrap[eprop])
                  ? awrap[eprop].join("|")
                  : awrap[eprop],
              });
            }
            // Our confidence has improved from 0 since there is a matching wrap so we know the correct name
            // and url. We lack the version details.
            confidence = 0.5;
            break;
          }
        }
        if (versionSpecifiersMap[n]) {
          props.push({
            name: "cdx:build:versionSpecifiers",
            value: versionSpecifiersMap[n],
          });
        }
        const apkg = {
          name: n,
          version: versionsMap[n] || "",
          type: pkgType,
          purl: new PackageURL(
            pkgType,
            group,
            n,
            versionsMap[n] || "",
            null,
            path,
          ).toString(),
          evidence: {
            identity: {
              field: "purl",
              confidence,
              methods: [
                {
                  technique: "source-code-analysis",
                  confidence: 0.5,
                  value: `Filename ${cmakeListFile}`,
                },
              ],
            },
          },
          properties: props,
        };
        apkg["bom-ref"] = decodeURIComponent(apkg["purl"]);
        pkgList.push(apkg);
        pkgAddedMap[n] = true;
      }
    }
  });
  return {
    parentComponent,
    pkgList,
  };
}

export function getOSPackageForFile(afile, osPkgsList) {
  for (const ospkg of osPkgsList) {
    for (const props of ospkg.properties || []) {
      if (
        props.name === "PkgProvides" &&
        props.value.includes(afile.toLowerCase())
      ) {
        delete ospkg.scope;
        // dev packages are libraries
        ospkg.type = "library";
        // Set the evidence to indicate how we identified this package from the header or .so file
        ospkg.evidence = {
          identity: {
            field: "purl",
            confidence: 0.8,
            methods: [
              {
                technique: "filename",
                confidence: 0.8,
                value: `PkgProvides ${afile}`,
              },
            ],
          },
        };
        return ospkg;
      }
    }
  }
  return undefined;
}

/**
 * Method to find c/c++ modules by collecting usages with atom
 *
 * @param {string} src directory
 * @param {object} options Command line options
 * @param {array} osPkgsList Array of OS pacakges represented as components
 * @param {array} epkgList Existing packages list
 */
export function getCppModules(src, options, osPkgsList, epkgList) {
  // Generic is the type to use where the package registry could not be located
  const pkgType = "generic";
  const pkgList = [];
  const pkgAddedMap = {};
  let sliceData;
  const epkgMap = {};
  let parentComponent;
  const dependsOn = new Set();

  (epkgList || []).forEach((p) => {
    epkgMap[`${p.group}/${p.name}`] = p;
  });
  // Let's look for any vcpkg.json file to tell us about the directory we're scanning
  // users can use this file to give us a clue even if they do not use vcpkg library manager
  if (safeExistsSync(join(src, "vcpkg.json"))) {
    const vcPkgData = JSON.parse(
      readFileSync(join(src, "vcpkg.json"), { encoding: "utf-8" }),
    );
    if (vcPkgData && Object.keys(vcPkgData).length && vcPkgData.name) {
      const parentPurl = new PackageURL(
        pkgType,
        "",
        vcPkgData.name,
        vcPkgData.version || "",
        null,
        null,
      ).toString();
      parentComponent = {
        name: vcPkgData.name,
        version: vcPkgData.version || "",
        description: vcPkgData.description,
        license: vcPkgData.license,
        purl: parentPurl,
        type: "application",
        "bom-ref": decodeURIComponent(parentPurl),
      };
      if (vcPkgData.homepage) {
        parentComponent.homepage = { url: vcPkgData.homepage };
      }
      // Are there any dependencies declared in vcpkg.json
      if (vcPkgData.dependencies && Array.isArray(vcPkgData.dependencies)) {
        for (const avcdep of vcPkgData.dependencies) {
          let avcpkgName;
          let scope;
          if (typeof avcdep === "string" || avcdep instanceof String) {
            avcpkgName = avcdep;
          } else if (Object.keys(avcdep).length && avcdep.name) {
            avcpkgName = avcdep.name;
            if (avcdep.host) {
              scope = "optional";
            }
          }
          // Is this a dependency we haven't seen before including the all lower and upper case version?
          if (
            avcpkgName &&
            !epkgMap[`/${avcpkgName}`] &&
            !epkgMap[`/${avcpkgName.toLowerCase()}`] &&
            !epkgMap[`/${avcpkgName.toUpperCase()}`]
          ) {
            const pkgPurl = new PackageURL(
              pkgType,
              "",
              avcpkgName,
              "",
              null,
              null,
            ).toString();
            const apkg = {
              group: "",
              name: avcpkgName,
              type: pkgType,
              version: "",
              purl: pkgPurl,
              scope,
              "bom-ref": decodeURIComponent(pkgPurl),
              evidence: {
                identity: {
                  field: "purl",
                  confidence: 0.5,
                  methods: [
                    {
                      technique: "source-code-analysis",
                      confidence: 0.5,
                      value: `Filename ${join(src, "vcpkg.json")}`,
                    },
                  ],
                },
              },
            };
            if (!pkgAddedMap[avcpkgName]) {
              pkgList.push(apkg);
              dependsOn.add(apkg["bom-ref"]);
              pkgAddedMap[avcpkgName] = true;
            }
          }
        }
      }
    } // if
  } else if (safeExistsSync(join(src, "CMakeLists.txt"))) {
    const retMap = parseCmakeLikeFile(join(src, "CMakeLists.txt"), pkgType);
    if (retMap.parentComponent && Object.keys(retMap.parentComponent).length) {
      parentComponent = retMap.parentComponent;
    }
  } else if (options.projectName && options.projectVersion) {
    parentComponent = {
      group: options.projectGroup || "",
      name: options.projectName || "",
      version: `${options.projectVersion}` || "latest",
      type: "application",
    };
    const parentPurl = new PackageURL(
      pkgType,
      parentComponent.group,
      parentComponent.name,
      parentComponent.version,
      null,
      null,
    ).toString();
    parentComponent.purl = parentPurl;
    parentComponent["bom-ref"] = decodeURIComponent(parentPurl);
  }
  if (options.usagesSlicesFile && safeExistsSync(options.usagesSlicesFile)) {
    sliceData = JSON.parse(
      readFileSync(options.usagesSlicesFile, { encoding: "utf-8" }),
    );
    if (DEBUG_MODE) {
      console.log("Re-using existing slices file", options.usagesSlicesFile);
    }
  } else {
    sliceData = findAppModules(
      src,
      options.deep ? "c" : "h",
      "usages",
      options.usagesSlicesFile,
    );
  }
  const usageData = parseCUsageSlice(sliceData);
  for (let afile of Object.keys(usageData)) {
    // Normalize windows separator
    afile = afile.replace("..\\", "").replace(/\\/g, "/");
    const fileName = basename(afile);
    if (!fileName || !fileName.length) {
      continue;
    }
    const extn = extname(fileName);
    let group = dirname(afile);
    if (
      group.startsWith(".") ||
      group.startsWith(_sep) ||
      safeExistsSync(resolve(afile)) ||
      safeExistsSync(resolve(src, afile))
    ) {
      group = "";
    }
    const version = "";
    // We need to resolve the name to an os package here
    const name = fileName.replace(extn, "");
    // Logic here if name matches the standard library of cpp
    // we skip it
    // Load the glibc-stdlib.json file, which contains std lib for cpp
    if (CPP_STD_MODULES.includes(name)) {
      continue;
    }
    let apkg = getOSPackageForFile(afile, osPkgsList) ||
      epkgMap[`${group}/${name}`] || {
        name,
        group,
        version: "",
        type: pkgType,
      };
    // If this is a relative file, there is a good chance we can reuse the project group
    if (!afile.startsWith(_sep) && !group.length) {
      group = options.projectGroup || "";
    }
    if (!apkg.purl) {
      apkg.purl = new PackageURL(
        pkgType,
        group,
        name,
        version,
        null,
        afile,
      ).toString();
      apkg.evidence = {
        identity: {
          field: "purl",
          confidence: 0,
          methods: [
            {
              technique: "source-code-analysis",
              confidence: 0,
              value: `Filename ${afile}`,
            },
          ],
        },
      };
      apkg["bom-ref"] = decodeURIComponent(apkg["purl"]);
    }
    if (usageData[afile]) {
      const usymbols = Array.from(usageData[afile])
        .filter(
          (v) =>
            !v.startsWith("<") &&
            !v.startsWith("__") &&
            v !== "main" &&
            !v.includes("anonymous_") &&
            !v.includes(afile),
        )
        .map((v) => v.split(":")[0])
        .sort();
      if (!apkg["properties"] && usymbols.length) {
        apkg["properties"] = [
          { name: "ImportedSymbols", value: usymbols.join("|") },
        ];
      } else {
        apkg["properties"] = [];
      }
      const newProps = [];
      let symbolsPropertyFound = false;
      for (const prop of apkg["properties"]) {
        if (prop.name === "ImportedSymbols") {
          symbolsPropertyFound = true;
          let existingSymbols = prop.value.split("|");
          existingSymbols = existingSymbols.concat(usymbols);
          prop.value = Array.from(new Set(existingSymbols)).sort().join("|");
        }
        newProps.push(prop);
      }
      if (!symbolsPropertyFound && usymbols.length) {
        apkg["properties"].push({
          name: "ImportedSymbols",
          value: usymbols.join("|"),
        });
      }
      apkg["properties"] = newProps;
    }
    // At this point, we have a package but we don't know what it's called
    // So let's try to locate this generic package using some heuristics
    apkg = locateGenericPackage(apkg);
    if (!pkgAddedMap[name]) {
      pkgList.push(apkg);
      dependsOn.add(apkg["bom-ref"]);
      pkgAddedMap[name] = true;
    }
  }
  const dependenciesList =
    dependsOn.size && parentComponent
      ? [
          {
            ref: parentComponent["bom-ref"],
            dependsOn: [...dependsOn].sort(),
          },
        ]
      : [];
  return {
    parentComponent,
    pkgList: pkgList.sort((a, b) => a.purl.localeCompare(b.purl)),
    dependenciesList,
  };
}

/**
 * NOT IMPLEMENTED YET.
 * A future method to locate a generic package given some name and properties
 *
 * @param {object} apkg Package to locate
 * @returns Located project with precise purl or the original unmodified input.
 */
export function locateGenericPackage(apkg) {
  return apkg;
}

export function parseCUsageSlice(sliceData) {
  if (!sliceData) {
    return undefined;
  }
  const usageData = {};
  try {
    const objectSlices = sliceData.objectSlices || [];
    for (const slice of objectSlices) {
      if (
        (!slice.fileName && !slice.code.startsWith("#include")) ||
        slice.fileName.startsWith("<includes") ||
        slice.fileName.startsWith("<global") ||
        slice.fileName.includes("__")
      ) {
        continue;
      }
      const slFileName = slice.fileName;
      const allLines = usageData[slFileName] || new Set();
      if (slice.fullName && slice.fullName.length > 3) {
        if (slice.code?.startsWith("#include")) {
          usageData[slice.fullName] = new Set();
        } else {
          allLines.add(slice.fullName);
        }
      }
      for (const ausage of slice.usages) {
        let calls = ausage?.invokedCalls || [];
        calls = calls.concat(ausage?.argToCalls || []);
        for (const acall of calls) {
          if (!acall.resolvedMethod.includes("->")) {
            allLines.add(acall.resolvedMethod);
          }
        }
      }
      if (Array.from(allLines).length) {
        usageData[slFileName] = allLines;
      }
    }
  } catch (_err) {
    // ignore
  }
  return usageData;
}

async function getNugetUrl() {
  const req = "https://api.nuget.org/v3/index.json";
  const res = await cdxgenAgent.get(req, {
    responseType: "json",
  });
  const urls = res.body.resources;
  for (const resource of urls) {
    if (resource["@type"] === "RegistrationsBaseUrl/3.6.0") {
      return resource["@id"];
    }
  }
  return "https://api.nuget.org/v3/registration3/";
}

async function queryNuget(p, NUGET_URL) {
  function setLatestVersion(upper) {
    // Handle special case for versions with more than 3 parts
    if (upper.split(".").length > 3) {
      const tmpVersionArray = upper.split("-")[0].split(".");
      // Compromise for versions such as 1.2.3.0-alpha
      // How to find latest proper release version?
      if (
        upper.split("-").length > 1 &&
        Number(tmpVersionArray.slice(-1)) === 0
      ) {
        return upper;
      }
      if (upper.split("-").length > 1) {
        tmpVersionArray[tmpVersionArray.length - 1] = (
          Number(tmpVersionArray.slice(-1)) - 1
        ).toString();
      }
      return tmpVersionArray.join(".");
    }
    const tmpVersion = parse(upper);
    let version = `${tmpVersion.major}.${tmpVersion.minor}.${tmpVersion.patch}`;
    if (compare(version, upper) === 1) {
      if (tmpVersion.patch > 0) {
        version = `${tmpVersion.major}.${tmpVersion.minor}.${(tmpVersion.patch - 1).toString()}`;
      }
    }
    return version;
  }

  // Coerce only when missing patch/minor version
  function coerceUp(version) {
    return version.split(".").length < 3
      ? coerce(version, { loose: true }).version
      : version;
  }

  if (DEBUG_MODE) {
    console.log(`Querying nuget for ${p.name}`);
  }
  const np = JSON.parse(JSON.stringify(p));
  const body = [];
  const newBody = [];
  let res = await cdxgenAgent.get(
    `${NUGET_URL + np.name.toLowerCase()}/index.json`,
    { responseType: "json" },
  );
  const items = res.body.items;
  if (!items || !items[0]) {
    return [np, newBody, body];
  }
  if (items[0] && !items[0].items) {
    if (!p.version || p.version === "0.0.0" || p.version === "latest") {
      const upper = items[items.length - 1].upper;
      np.version = setLatestVersion(upper);
    }
    for (const item of items) {
      if (np.version) {
        const lower = compare(
          coerce(item.lower, { loose: true }),
          coerce(np.version, { loose: true }),
        );
        const upper = compare(
          coerce(item.upper, { loose: true }),
          coerce(np.version, { loose: true }),
        );
        if (lower !== 1 && upper !== -1) {
          res = await cdxgenAgent.get(item["@id"], { responseType: "json" });
          for (const i of res.body.items.reverse()) {
            if (
              i.catalogEntry &&
              i.catalogEntry.version === coerceUp(np.version)
            ) {
              newBody.push(i);
              return [np, newBody];
            }
          }
        }
      }
    }
  } else {
    if (!p.version || p.version === "0.0.0" || p.version === "latest") {
      const upper = items[items.length - 1].upper;
      np.version = setLatestVersion(upper);
    }
    if (np.version) {
      for (const item of items) {
        const lower = compare(
          coerce(item.lower, { loose: true }),
          coerce(np.version, { loose: true }),
        );
        const upper = compare(
          coerce(item.upper, { loose: true }),
          coerce(np.version, { loose: true }),
        );
        if (lower !== 1 && upper !== -1) {
          for (const i of item.items.reverse()) {
            if (
              i.catalogEntry &&
              i.catalogEntry.version === coerceUp(np.version)
            ) {
              newBody.push(i);
              return [np, newBody];
            }
          }
        }
      }
    }
  }
  return [np, newBody];
}

/**
 * Method to retrieve metadata for nuget packages
 *
 * @param {Array} pkgList Package list
 * @param {Array} dependencies Dependencies
 */
export async function getNugetMetadata(pkgList, dependencies = undefined) {
  const NUGET_URL = process.env.NUGET_URL || (await getNugetUrl());
  const cdepList = [];
  const depRepList = {};
  for (const p of pkgList) {
    let cacheKey;
    try {
      // If there is a version, we can safely use the cache to retrieve the license
      // See: https://github.com/cdxgen/cdxgen/issues/352
      cacheKey = `${p.name}|${p.version}`;
      let body = metadata_cache[cacheKey];

      if (body?.error) {
        cdepList.push(p);
        continue;
      }
      if (!body) {
        let newBody = {};
        let np = {};
        [np, newBody] = await queryNuget(p, NUGET_URL);
        if (p.version !== np.version) {
          const oldRef = p["bom-ref"];
          p["bom-ref"] = decodeURIComponent(
            new PackageURL(
              "nuget",
              "",
              np.name,
              np.version,
              null,
              null,
            ).toString(),
          );
          depRepList[oldRef] = p["bom-ref"];
          p.version = np.version;
        }
        if (newBody && newBody.length > 0) {
          body = newBody[0];
        }
        if (body) {
          metadata_cache[cacheKey] = body;
          // Set the latest version in case it is missing
          if (!p.version && body.catalogEntry.version) {
            p.version = body.catalogEntry.version;
          }
          p.description = body.catalogEntry.description;
          if (body.catalogEntry.authors) {
            p.author = body.catalogEntry.authors.trim();
          }
          if (
            body.catalogEntry.licenseExpression &&
            body.catalogEntry.licenseExpression !== ""
          ) {
            p.license = findLicenseId(body.catalogEntry.licenseExpression);
          } else if (body.catalogEntry.licenseUrl) {
            p.license = findLicenseId(body.catalogEntry.licenseUrl);
            if (
              typeof p.license === "string" &&
              p.license.includes("://github.com/")
            ) {
              p.license =
                (await getRepoLicense(p.license, undefined)) || p.license;
            }
          }
          // Capture the tags
          if (
            body.catalogEntry?.tags?.length &&
            Array.isArray(body.catalogEntry.tags)
          ) {
            p.tags = body.catalogEntry.tags.map((t) =>
              t.toLowerCase().replaceAll(" ", "-"),
            );
          }
          if (body.catalogEntry.projectUrl) {
            p.repository = { url: body.catalogEntry.projectUrl };
            p.homepage = {
              url: `https://www.nuget.org/packages/${p.name}/${p.version}/`,
            };
            if (
              (!p.license || typeof p.license === "string") &&
              typeof p.repository.url === "string" &&
              p.repository.url.includes("://github.com/")
            ) {
              // license couldn't be properly identified and is still a url,
              // therefore trying to resolve license via repository
              p.license =
                (await getRepoLicense(p.repository.url, undefined)) ||
                p.license;
            }
          }
          cdepList.push(p);
        }
      }
    } catch (err) {
      if (cacheKey) {
        metadata_cache[cacheKey] = { error: err.code };
      }
      cdepList.push(p);
    }
  }
  const newDependencies = [].concat(dependencies);
  if (depRepList && newDependencies.length) {
    const changed = Object.keys(depRepList);
    // if (!parentComponent.version || parentComponent.version === "latest" || parentComponent.version === "0.0.0"){
    //   if (changed.includes(parentComponent["bom-ref"])) {
    //     parentComponent["bom-ref"] = depRepList[parentComponent["bom-ref"]["ref"]];
    //   }
    // }
    for (const d of newDependencies) {
      if (changed.length > 0 && changed.includes(d["ref"])) {
        d["ref"] = depRepList[d["ref"]];
      }
      for (const dd in d["dependsOn"]) {
        if (changed.includes(d["dependsOn"][dd])) {
          const replace = d["dependsOn"][dd];
          d["dependsOn"][dd] = depRepList[replace];
        }
      }
    }
  }
  return {
    pkgList: cdepList,
    dependencies: newDependencies,
  };
}

export function addEvidenceForDotnet(pkgList, slicesFile) {
  // We need two datastructures.
  // dll to purl mapping from the pkgList
  // purl to occurrences list using the slicesFile
  if (!slicesFile || !safeExistsSync(slicesFile)) {
    return pkgList;
  }
  const pkgFilePurlMap = {};
  const purlLocationMap = {};
  const purlModulesMap = {};
  const purlMethodsMap = {};
  for (const apkg of pkgList) {
    if (apkg.properties && Array.isArray(apkg.properties)) {
      apkg.properties
        .filter((p) => p.name === "PackageFiles")
        .forEach((aprop) => {
          if (aprop.value) {
            const tmpA = aprop.value.split(", ");
            if (tmpA?.length) {
              tmpA.forEach((dllFile) => {
                pkgFilePurlMap[dllFile] = apkg.purl;
              });
            }
          }
        });
    }
  }
  const slicesData = JSON.parse(readFileSync(slicesFile, "utf-8"));
  if (slicesData && Object.keys(slicesData)) {
    thoughtLog(
      "Let's thoroughly inspect the dependency slice to identify where and how the components are used.",
    );
    if (slicesData.Dependencies) {
      for (const adep of slicesData.Dependencies) {
        // Case 1: Dependencies slice has the .dll file
        if (adep.Module?.endsWith(".dll") && pkgFilePurlMap[adep.Module]) {
          const modPurl = pkgFilePurlMap[adep.Module];
          if (!purlLocationMap[modPurl]) {
            purlLocationMap[modPurl] = new Set();
          }
          purlLocationMap[modPurl].add(`${adep.Path}#${adep.LineNumber}`);
        } else if (
          adep?.Name &&
          (adep?.Namespace?.startsWith("System") ||
            adep?.Namespace?.startsWith("Microsoft"))
        ) {
          // Case 2: System packages where the .dll information is missing
          // In this case, the dll file name is the name followed by dll.
          const moduleDll = `${adep.Name}.dll`;
          if (pkgFilePurlMap[moduleDll]) {
            const modPurl = pkgFilePurlMap[moduleDll];
            if (!purlLocationMap[modPurl]) {
              purlLocationMap[modPurl] = new Set();
            }
            purlLocationMap[modPurl].add(`${adep.Path}#${adep.LineNumber}`);
          }
        }
      }
    }
    if (slicesData.MethodCalls) {
      for (const amethodCall of slicesData.MethodCalls) {
        if (
          amethodCall.Module?.endsWith(".dll") &&
          pkgFilePurlMap[amethodCall.Module]
        ) {
          const modPurl = pkgFilePurlMap[amethodCall.Module];
          if (!purlLocationMap[modPurl]) {
            purlLocationMap[modPurl] = new Set();
          }
          if (!purlModulesMap[modPurl]) {
            purlModulesMap[modPurl] = new Set();
          }
          if (!purlMethodsMap[modPurl]) {
            purlMethodsMap[modPurl] = new Set();
          }
          purlLocationMap[modPurl].add(
            `${amethodCall.Path}#${amethodCall.LineNumber}`,
          );
          purlModulesMap[modPurl].add(amethodCall.ClassName);
          purlMethodsMap[modPurl].add(amethodCall.CalledMethod);
        }
      }
    }
    if (slicesData.AssemblyInformation) {
      for (const apkg of pkgList) {
        if (!apkg.version) {
          for (const assemblyInfo of slicesData.AssemblyInformation) {
            if (apkg.name === assemblyInfo.Name) {
              apkg.version = assemblyInfo.Version;
            }
          }
        }
      }
    }
  }
  if (Object.keys(purlLocationMap).length) {
    for (const apkg of pkgList) {
      if (purlLocationMap[apkg.purl]) {
        const locationOccurrences = Array.from(
          purlLocationMap[apkg.purl],
        ).sort();
        // Add the occurrences evidence
        apkg.evidence.occurrences = locationOccurrences.map((l) => ({
          location: l,
        }));
        // Set the package scope
        apkg.scope = "required";
      }
      // Add the imported modules to properties
      if (purlModulesMap[apkg.purl]) {
        apkg.properties.push({
          name: "ImportedModules",
          value: Array.from(purlModulesMap[apkg.purl]).sort().join(", "),
        });
      }
      // Add the called methods to properties
      if (purlMethodsMap[apkg.purl]) {
        apkg.properties.push({
          name: "CalledMethods",
          value: Array.from(purlMethodsMap[apkg.purl]).sort().join(", "),
        });
      }
    }
  } else if (slicesData?.Dependencies || slicesData?.MethodCalls) {
    thoughtLog(
      "I didn't find any occurrence evidence or detailed imported modules, even though there is good dependency slice data from dosai. This is surprising.",
    );
  }
  return pkgList;
}

/**
 * Function to parse the .d make files
 *
 * @param {String} dfile .d file path
 *
 * @returns {Object} pkgFilesMap Object with package name and list of files
 */
export function parseMakeDFile(dfile) {
  const pkgFilesMap = {};
  const dData = readFileSync(dfile, { encoding: "utf-8" });
  const pkgName = basename(dfile).split("-").shift();
  const filesList = new Set();
  dData.split("\n").forEach((l) => {
    l = l.replace("\r", "");
    if (!l.endsWith(".rs:")) {
      return;
    }
    const fileName = `.cargo/${l.split(".cargo/").pop()}`.replace(
      ".rs:",
      ".rs",
    );
    filesList.add(fileName);
  });
  pkgFilesMap[pkgName] = Array.from(filesList);
  return pkgFilesMap;
}

/**
 * Function to validate an externalReference URL for conforming to the JSON schema or bomLink
 * https://github.com/CycloneDX/cyclonedx-core-java/blob/75575318b268dda9e2a290761d7db11b4f414255/src/main/resources/bom-1.5.schema.json#L1140
 * https://datatracker.ietf.org/doc/html/rfc3987#section-2.2
 * https://cyclonedx.org/capabilities/bomlink/
 *
 * @param {String} iri IRI to validate
 *
 * @returns {Boolean} Flag indicating whether the supplied URL is valid or not
 *
 */
export function isValidIriReference(iri) {
  if (typeof iri !== "string") {
    return false;
  }
  const trimmedIri = iri.trim();
  if (iri === "" || iri !== trimmedIri) {
    return false;
  }

  if (/[${}]/.test(iri)) {
    return false;
  }

  // Check for malformed percent-encoding sequences more robustly
  // This regex looks for a % that is NOT followed by:
  // - Exactly two hex digits that are then either:
  //   - The end of the string ($)
  //   - Or a character that is NOT a hex digit ([^0-9A-Fa-f])
  // This catches %ab, %ab%, %abZ, %abc, etc.
  if (/%(?!([0-9A-Fa-f]{2})($|[^0-9A-Fa-f]))/.test(iri)) {
    return false;
  }

  // Use the dedicated IRI validator for strict RFC 3987 compliance check
  const validateIriResult = validateIri(iri, IriValidationStrategy.Strict);

  // If the IRI validator reports an error, it's invalid.
  if (validateIriResult instanceof Error) {
    return false;
  }

  // Optional: Additional check for common URI schemes (like http/https)
  //    using the built-in URL constructor for stricter URI syntax conformance.
  //    This might catch cases where an IRI is valid per RFC 3987 but not
  //    strictly a valid URI as parsed by the URL constructor (e.g., missing host for http).
  //    Only apply this if the IRI looks like it starts with a scheme like http.
  if (/^https?:/i.test(iri)) {
    // Case-insensitive check for http/https
    try {
      // Attempt to construct a URL object. If it fails, it's likely not a valid URI structure.
      new URL(iri); // Use iri here
    } catch (_error) {
      // If URL construction fails, consider the IRI reference invalid for http-like schemes.
      return false;
    }
  }

  // 8. If all checks pass, the IRI reference is considered valid.
  return true;
}

/**
 * Method to check if a given dependency tree is partial or not.
 *
 * @param {Array} dependencies List of dependencies
 * @param {Number} componentsCount Number of components
 * @returns {Boolean} True if the dependency tree lacks any non-root parents without children. False otherwise.
 */
export function isPartialTree(dependencies, componentsCount = 1) {
  if (componentsCount <= 1) {
    return false;
  }
  if (dependencies?.length <= 1) {
    return true;
  }
  let isCbom = false;
  let parentsWithChildsCount = 0;
  for (const adep of dependencies) {
    if (adep?.dependsOn.length > 0) {
      parentsWithChildsCount++;
    }
    if (!isCbom && adep?.provides?.length > 0) {
      isCbom = true;
    }
  }
  return (
    !isCbom &&
    parentsWithChildsCount <
      Math.min(Math.round(componentsCount / 3), componentsCount)
  );
}

/**
 * Re-compute and set the scope based on the dependency tree
 *
 * @param {Array} pkgList List of components
 * @param {Array} dependencies List of dependencies
 *
 * @returns {Array} Updated list
 */
export function recomputeScope(pkgList, dependencies) {
  const requiredPkgs = {};
  if (!pkgList || !dependencies) {
    return pkgList;
  }
  for (const pkg of pkgList) {
    if (!pkg.scope || !pkg["bom-ref"]) {
      continue;
    }
    if (pkg.scope === "required") {
      requiredPkgs[pkg["bom-ref"]] = true;
    }
  }
  for (const adep of dependencies) {
    if (requiredPkgs[adep.ref]) {
      for (const ado of adep.dependsOn) {
        requiredPkgs[ado] = true;
      }
    }
  }
  // Prevent marking every component as optional
  if (!Object.keys(requiredPkgs).length) {
    return pkgList;
  }
  for (const pkg of pkgList) {
    if (requiredPkgs[pkg["bom-ref"]]) {
      pkg.scope = "required";
    } else if (!pkg.scope) {
      pkg.scope = "optional";
    }
  }
  return pkgList;
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
  return expandedBinPaths;
}

/**
 * Collect all executable files from the given list of binary paths
 *
 * @param basePath Base directory
 * @param binPaths {Array[String]} Paths containing potential binaries
 * @return {Array[String]} List of executables
 */
export function collectExecutables(basePath, binPaths) {
  if (!binPaths) {
    return [];
  }
  let executables = [];
  const ignoreList = [
    "**/*.{h,c,cpp,hpp,man,txt,md,htm,html,jar,ear,war,zip,tar,egg,keepme,gitignore,json,js,py,pyc}",
    "[",
  ];
  for (const apath of binPaths) {
    try {
      const files = globSync(`**${apath}/*`, {
        cwd: basePath,
        absolute: false,
        nocase: true,
        nodir: true,
        dot: true,
        follow: true,
        ignore: ignoreList,
      });
      executables = executables.concat(files);
    } catch (_err) {
      // ignore
    }
  }
  return Array.from(new Set(executables)).sort();
}

/**
 * Collect all shared library files from the given list of paths
 *
 * @param basePath Base directory
 * @param libPaths {Array[String]} Paths containing potential libraries
 * @param ldConf {String} Config file used by ldconfig to locate additional paths
 * @param ldConfDirPattern {String} Config directory that can contain more .conf files for ldconfig
 *
 * @return {Array[String]} List of executables
 */
export function collectSharedLibs(
  basePath,
  libPaths,
  ldConf,
  ldConfDirPattern,
) {
  if (!libPaths) {
    return [];
  }
  let sharedLibs = [];
  const ignoreList = [
    "**/*.{h,c,cpp,hpp,man,txt,md,htm,html,jar,ear,war,zip,tar,egg,keepme,gitignore,json,js,py,pyc}",
  ];
  const allLdConfDirs = ldConfDirPattern ? [ldConfDirPattern] : [];
  collectAllLdConfs(basePath, ldConf, allLdConfDirs, libPaths);
  if (allLdConfDirs.length) {
    for (const aldconfPattern of allLdConfDirs) {
      const confFiles = globSync(aldconfPattern, {
        cwd: basePath,
        absolute: false,
        nocase: true,
        nodir: true,
        dot: true,
        follow: false,
      });
      for (const moreConf of confFiles) {
        collectAllLdConfs(basePath, moreConf, allLdConfDirs, libPaths);
      }
    }
  }
  for (const apath of Array.from(new Set(libPaths))) {
    try {
      const files = globSync(`**${apath}/*.{so,so.*,a,lib,dll}`, {
        cwd: basePath,
        absolute: false,
        nocase: true,
        nodir: true,
        dot: true,
        follow: true,
        ignore: ignoreList,
      });
      sharedLibs = sharedLibs.concat(files);
    } catch (_err) {
      // ignore
    }
  }
  return Array.from(new Set(sharedLibs)).sort();
}

function collectAllLdConfs(basePath, ldConf, allLdConfDirs, libPaths) {
  if (ldConf && existsSync(join(basePath, ldConf))) {
    const ldConfData = readFileSync(join(basePath, ldConf), "utf-8");
    for (let line of ldConfData.split("\n")) {
      line = line.replace("\r", "").trim();
      if (!line.length || line.startsWith("#")) {
        continue;
      }
      if (line.startsWith("include ")) {
        let apattern = line.replace("include ", "");
        if (!apattern.includes("*")) {
          apattern = `${apattern}/*.conf`;
        }
        if (!allLdConfDirs.includes(apattern)) {
          allLdConfDirs.push(apattern);
        }
      } else if (line.startsWith("/")) {
        if (!libPaths.includes(line)) {
          libPaths.push(line);
        }
      }
    }
  }
}

/**
 * Get information about the runtime.
 *
 * @returns {Object} Object containing the name and version of the runtime
 */
export function getRuntimeInformation() {
  const runtimeInfo = {};

  if (globalThis.Deno?.version?.deno) {
    runtimeInfo.runtime = "Deno";
    runtimeInfo.version = globalThis.Deno.version.deno;
  } else if (globalThis.Bun?.version) {
    runtimeInfo.runtime = "Bun";
    runtimeInfo.version = globalThis.Bun.version;
  } else if (globalThis.process?.versions?.node) {
    runtimeInfo.runtime = "Node.js";
    runtimeInfo.version = globalThis.process.versions.node;
    const report = process.report.getReport();
    const nodeSourceUrl = report?.header?.release?.sourceUrl;
    // Collect the bundled components in node.js
    if (report?.header?.componentVersions) {
      const nodeBundledComponents = [];
      for (const [name, version] of Object.entries(
        report.header.componentVersions,
      )) {
        if (name === "node") {
          continue;
        }
        const apkg = {
          name,
          version,
          description: `Bundled with Node.js ${runtimeInfo.version}`,
          type: "library",
          scope: "excluded",
          purl: `pkg:generic/${name}@${version}`,
          "bom-ref": `pkg:generic/${name}@${version}`,
        };
        if (nodeSourceUrl) {
          apkg.externalReferences = [
            {
              url: nodeSourceUrl,
              type: "source-distribution",
              comment: "Node.js release url",
            },
          ];
        }
        nodeBundledComponents.push(apkg);
      }
      if (nodeBundledComponents.length) {
        runtimeInfo.components = nodeBundledComponents;
      }
    }
    if (report.sharedObjects) {
      const osSharedObjects = [];
      for (const aso of report.sharedObjects) {
        const name = basename(aso);
        if (name === "node") {
          continue;
        }
        const apkg = {
          name,
          type: "library",
          scope: "excluded",
          purl: `pkg:generic/${name}#${aso}`,
          "bom-ref": `pkg:generic/${name}`,
        };
        osSharedObjects.push(apkg);
      }
      if (osSharedObjects.length) {
        runtimeInfo.components = osSharedObjects;
      }
    }
  } else {
    runtimeInfo.runtime = "Unknown";
    runtimeInfo.version = "N/A";
  }

  return runtimeInfo;
}

/**
 * Checks for dangerous Unicode characters that could enable homograph attacks
 *
 * @param {string} str String to check
 * @returns {boolean} true if dangerous Unicode is found
 */
// biome-ignore-start lint/suspicious/noControlCharactersInRegex: validation
export function hasDangerousUnicode(str) {
  // Check for bidirectional control characters
  const bidiChars = /[\u202A-\u202E\u2066-\u2069]/;
  if (bidiChars.test(str)) {
    return true;
  }

  // Check for zero-width characters that could be used for obfuscation
  const zeroWidthChars = /[\u200B-\u200D\uFEFF]/;
  if (zeroWidthChars.test(str)) {
    return true;
  }

  // Check for control characters (except common ones like \n, \r, \t)
  const controlChars = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
  if (controlChars.test(str)) {
    return true;
  }

  return false;
}
// biome-ignore-end lint/suspicious/noControlCharactersInRegex: validation

/**
 * Validates that a root is a legitimate Windows drive letter format
 *
 * @param {string} root Root to validate
 * @returns {boolean} true if valid drive format
 */
export function isValidDriveRoot(root) {
  // Must be at most 3 characters: letter, colon, backslash
  if (root.length > 3) {
    return false;
  }

  // Check each character individually to prevent Unicode lookalikes
  const driveLetter = root.charAt(0);
  const colon = root.charAt(1);
  const backslash = root.charAt(2);

  // Drive letter must be ASCII A-Z or a-z
  const charCode = driveLetter.charCodeAt(0);
  const isAsciiLetter =
    (charCode >= 65 && charCode <= 90) || (charCode >= 97 && charCode <= 122);
  if (!isAsciiLetter) {
    return false;
  }

  // Colon must be exactly ASCII colon (0x3A)
  if (colon.charCodeAt(0) !== 0x3a) {
    return false;
  }

  // Backslash (optional) must be exactly ASCII backslash (0x5C)
  if (backslash && backslash.charCodeAt(0) !== 0x5c) {
    return false;
  }

  return true;
}

/**
 * Get version and runtime information
 */
export function retrieveCdxgenVersion() {
  const packageJsonAsString = readFileSync(
    join(dirNameStr, "package.json"),
    "utf-8",
  );
  const packageJson = JSON.parse(packageJsonAsString);

  const runtimeInfo = getRuntimeInformation();

  return `\x1b[1mCycloneDX Generator ${packageJson.version}\x1b[0m\nRuntime: ${runtimeInfo.runtime}, Version: ${runtimeInfo.version}`;
}
