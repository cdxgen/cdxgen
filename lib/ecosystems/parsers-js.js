import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import path, {
  sep as _sep,
  basename,
  dirname,
  join,
  relative,
  resolve,
} from "node:path";

import { build, Purl } from "@cdxgen/cdx-purl";
import ssri from "ssri";
import { parse as _load, parseAllDocuments } from "yaml";

import { DEBUG_MODE, readEnvironmentVariable } from "../core/activity.js";
import { recordDegradation } from "../core/buildLedger.js";
import { shouldFetchPackageMetadata } from "../core/env.js";
import { safeExistsSync } from "../core/fs.js";
import { analyzeSuspiciousJsFile } from "../inventory/analyzer.js";
import { npmPurl, parsePurlLoose } from "../inventory/purl.js";
import Arborist from "../third-party/arborist/lib/index.js";
import { getNpmMetadata } from "./ecosystems.js";
import {
  buildNpmGitDistributionIntakeRefs,
  buildNpmGitPurlQualifiers,
  buildPnpmGitPkgRefs,
  collectNpmManifestSources,
  findMatchingNpmWorkspace,
  hydrateNpmNodePackage,
  loadNpmrcConfig,
  normalizePnpmLockKey,
  parsePnpmGitLockKey,
  resolveNpmLicense,
  setNpmDevelopmentProperty,
  setNpmOptionalProperty,
  setNpmPeerProperty,
} from "./npmutils.js";
import { addComponentProperty } from "./parsers-python.js";

/**
 * Parse nodejs package json file
 *
 * @param {string} pkgJsonFile package.json file
 * @param {boolean} simple Return a simpler representation of the component by skipping extended attributes and license fetch.
 * @param {boolean} securityProps Collect security-related properties
 */
const NPM_INSTALL_HOOK_NAMES = [
  "preinstall",
  "install",
  "postinstall",
  "prepublish",
  "prepare",
];

const NPM_BUILD_SCRIPT_NAME_PATTERN =
  /\b(build|compile|bundle|pack|dist|watch|transpile|minif(?:y|ication)|uglif(?:y|ication))\b/i;

const NPM_LIFECYCLE_OBFUSCATION_PATTERNS = [
  [
    "base64-decode",
    /\b(?:base64(?:\s+--decode|\s+-d)?|openssl\s+enc\s+-base64\s+-d)\b/i,
  ],
  ["buffer-base64", /Buffer\.from\s*\([^)]*,\s*["']base64["']\s*\)/i],
  ["atob", /\batob\s*\(/i],
  ["string-from-char-code", /\bString\.fromCharCode\s*\(/i],
  ["long-base64-literal", /\b[A-Za-z0-9+/]{80,}={0,2}\b/],
];

const NPM_LIFECYCLE_EXECUTION_PATTERNS = [
  ["node-eval", /\bnode\b[^\n]*\s-[ep]\b/i],
  ["eval", /\beval\s*\(/i],
  ["function-constructor", /\b(?:new\s+Function|Function\s*\()/i],
  [
    "child-process",
    /\b(?:child_process|node:child_process|execSync|execFileSync|spawnSync|execFile|spawn|exec)\b/i,
  ],
  [
    "shell-inline",
    /\b(?:sh|bash|cmd|powershell|pwsh)\b[^\n]*\s-(?:c|Command|EncodedCommand)\b/i,
  ],
];

const NPM_LIFECYCLE_NETWORK_PATTERNS = [
  ["curl", /\bcurl\b/i],
  ["wget", /\bwget\b/i],
  ["invoke-webrequest", /\b(?:invoke-webrequest|iwr)\b/i],
  ["http-url", /https?:\/\//i],
];

const NPM_LIFECYCLE_JS_RUNNERS = new Set([
  "babel-node",
  "node",
  "ts-node",
  "tsx",
  "bun",
  "deno",
]);

const NPM_LIFECYCLE_JS_RUNNER_VALUE_OPTIONS = new Set([
  "-c",
  "-e",
  "-p",
  "-r",
  "--config",
  "--conditions",
  "--cwd-file",
  "--compilerOptions",
  "--cwd",
  "--env-file",
  "--env-file-if-exists",
  "--eval",
  "--experimental-loader",
  "--ignore",
  "--import",
  "--import-map",
  "--input-type",
  "--inspect",
  "--inspect-brk",
  "--inspect-port",
  "--loader",
  "--print",
  "--preload",
  "--project",
  "--require",
  "--test-name-pattern",
  "--test-reporter",
  "--test-reporter-destination",
  "--test-shard",
  "--title",
  "--tsconfig",
  "--watch-path",
]);

const NPM_LIFECYCLE_JS_SOURCE_FILE_PATTERN = /\.[cm]?[jt]sx?$/i;

const SHELL_ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=.*/;

// The root component's name when neither package.json, --project-name, nor
// the directory names one (a tree rooted at a file-system root): a purl needs
// a name.
const UNNAMED_NPM_PROJECT = "unnamed-project";

function splitLifecycleScriptCommands(scriptValue) {
  const commands = [];
  let current = "";
  let escaped = false;
  let quoteChar = "";

  for (let index = 0; index < scriptValue.length; index++) {
    const character = scriptValue[index];
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      current += character;
      escaped = true;
      continue;
    }
    if (quoteChar) {
      current += character;
      if (character === quoteChar) {
        quoteChar = "";
      }
      continue;
    }
    if (character === '"' || character === "'") {
      current += character;
      quoteChar = character;
      continue;
    }
    if (character === ";" || character === "|") {
      if (current.trim()) {
        commands.push(current.trim());
      }
      current = "";
      continue;
    }
    if (character === "&") {
      if (current.trim()) {
        commands.push(current.trim());
      }
      current = "";
      if (scriptValue[index + 1] === "&") {
        index += 1;
      }
      continue;
    }
    current += character;
  }
  if (current.trim()) {
    commands.push(current.trim());
  }
  return commands;
}

function lifecycleRunnerOptionConsumesValue(token) {
  if (!token?.startsWith("-") || token === "--") {
    return false;
  }
  if (token.includes("=")) {
    return false;
  }
  if (token.startsWith("--")) {
    return NPM_LIFECYCLE_JS_RUNNER_VALUE_OPTIONS.has(token);
  }
  if (token.length > 2) {
    return false;
  }
  return NPM_LIFECYCLE_JS_RUNNER_VALUE_OPTIONS.has(token);
}

function isLifecycleScriptSourceFile(token) {
  if (!token || token.startsWith("-")) {
    return false;
  }
  const fileToken = token.split(/[?#]/u, 1)[0];
  return NPM_LIFECYCLE_JS_SOURCE_FILE_PATTERN.test(fileToken);
}

function findLifecycleScriptSourceArg(tokens, startIndex) {
  for (let index = startIndex; index < tokens.length; index++) {
    const token = tokens[index]?.trim();
    if (!token) {
      continue;
    }
    if (token === "--" || SHELL_ENV_ASSIGNMENT_PATTERN.test(token)) {
      continue;
    }
    if (token.startsWith("-")) {
      if (
        lifecycleRunnerOptionConsumesValue(token) &&
        index + 1 < tokens.length
      ) {
        index += 1;
      }
      continue;
    }
    if (isLifecycleScriptSourceFile(token)) {
      return token;
    }
    break;
  }
  return undefined;
}

function findLifecycleScriptSourceStartIndex(tokens, runnerIndex) {
  const runnerToken = tokens[runnerIndex];
  for (let index = runnerIndex + 1; index < tokens.length; index++) {
    const token = tokens[index]?.trim();
    if (!token || token === "--" || SHELL_ENV_ASSIGNMENT_PATTERN.test(token)) {
      continue;
    }
    if (token.startsWith("-")) {
      if (
        lifecycleRunnerOptionConsumesValue(token) &&
        index + 1 < tokens.length
      ) {
        index += 1;
      }
      continue;
    }
    if (runnerToken === "deno") {
      return token === "run" ? index + 1 : undefined;
    }
    if (runnerToken === "bun" && token === "run") {
      return index + 1;
    }
    return index;
  }
  return undefined;
}

function isResolvedPathWithinDirectory(baseDir, resolvedFile) {
  const relativePath = relative(baseDir, resolvedFile);
  if (!relativePath) {
    return true;
  }
  return (
    !relativePath.startsWith(`..${path.sep}`) &&
    relativePath !== ".." &&
    !path.isAbsolute(relativePath)
  );
}

function collectLifecyclePatternIndicators(scriptValue, patterns) {
  const indicators = [];
  patterns.forEach(([name, pattern]) => {
    if (pattern.test(scriptValue)) {
      indicators.push(name);
    }
  });
  return indicators;
}

function extractLifecycleScriptSourceFiles(pkgJsonFile, scriptValue) {
  const sourceFiles = [];
  const seen = new Set();
  if (!scriptValue || typeof scriptValue !== "string") {
    return sourceFiles;
  }
  const pkgJsonDir = resolve(dirname(pkgJsonFile));
  const commandSegments = splitLifecycleScriptCommands(scriptValue);
  for (const commandSegment of commandSegments) {
    const tokens = splitCommandArgs(commandSegment);
    for (let index = 0; index < tokens.length; index++) {
      if (!NPM_LIFECYCLE_JS_RUNNERS.has(tokens[index])) {
        continue;
      }
      const scriptStartIndex = findLifecycleScriptSourceStartIndex(
        tokens,
        index,
      );
      if (scriptStartIndex === undefined) {
        continue;
      }
      const relativeFile = findLifecycleScriptSourceArg(
        tokens,
        scriptStartIndex,
      );
      if (!relativeFile) {
        continue;
      }
      const resolvedFile = resolve(pkgJsonDir, relativeFile);
      if (
        !isResolvedPathWithinDirectory(pkgJsonDir, resolvedFile) ||
        !safeExistsSync(resolvedFile) ||
        seen.has(resolvedFile)
      ) {
        continue;
      }
      seen.add(resolvedFile);
      sourceFiles.push(resolvedFile);
    }
  }
  return sourceFiles;
}

function analyzeNpmLifecycleScripts(pkgJsonFile, scripts) {
  const executionIndicators = new Set();
  const networkIndicators = new Set();
  const obfuscationIndicators = new Set();
  const obfuscatedScripts = [];
  const suspiciousScripts = [];
  const scriptIndicatorMap = [];
  const riskyScripts = NPM_INSTALL_HOOK_NAMES.filter(
    (scriptName) => scripts?.[scriptName],
  );
  riskyScripts.forEach((scriptName) => {
    const scriptValue = String(scripts[scriptName] || "");
    const scriptExecutionIndicators = new Set(
      collectLifecyclePatternIndicators(
        scriptValue,
        NPM_LIFECYCLE_EXECUTION_PATTERNS,
      ),
    );
    const scriptNetworkIndicators = new Set(
      collectLifecyclePatternIndicators(
        scriptValue,
        NPM_LIFECYCLE_NETWORK_PATTERNS,
      ),
    );
    const scriptObfuscationIndicators = new Set(
      collectLifecyclePatternIndicators(
        scriptValue,
        NPM_LIFECYCLE_OBFUSCATION_PATTERNS,
      ),
    );
    extractLifecycleScriptSourceFiles(pkgJsonFile, scriptValue).forEach(
      (sourceFile) => {
        const astIndicators = analyzeSuspiciousJsFile(sourceFile);
        astIndicators.executionIndicators.forEach((indicator) => {
          scriptExecutionIndicators.add(`ast:${indicator}`);
        });
        astIndicators.networkIndicators.forEach((indicator) => {
          scriptNetworkIndicators.add(`ast:${indicator}`);
        });
        astIndicators.obfuscationIndicators.forEach((indicator) => {
          scriptObfuscationIndicators.add(`ast:${indicator}`);
        });
      },
    );
    if (scriptObfuscationIndicators.size) {
      scriptExecutionIndicators.forEach((indicator) => {
        executionIndicators.add(indicator);
      });
      scriptObfuscationIndicators.forEach((indicator) => {
        obfuscationIndicators.add(indicator);
      });
    }
    if (
      scriptObfuscationIndicators.size &&
      (scriptExecutionIndicators.size || scriptNetworkIndicators.size)
    ) {
      obfuscatedScripts.push(scriptName);
    }
    if (
      scriptObfuscationIndicators.size ||
      (scriptExecutionIndicators.size && scriptNetworkIndicators.size)
    ) {
      suspiciousScripts.push(scriptName);
    }
    scriptNetworkIndicators.forEach((indicator) => {
      networkIndicators.add(indicator);
    });
    if (
      scriptExecutionIndicators.size ||
      scriptNetworkIndicators.size ||
      scriptObfuscationIndicators.size
    ) {
      scriptIndicatorMap.push(
        `${scriptName}:${[
          ...scriptObfuscationIndicators,
          ...scriptExecutionIndicators,
          ...scriptNetworkIndicators,
        ].join("+")}`,
      );
    }
  });
  return {
    executionIndicators: Array.from(executionIndicators).sort(),
    networkIndicators: Array.from(networkIndicators).sort(),
    obfuscatedScripts: [...new Set(obfuscatedScripts)].sort(),
    obfuscationIndicators: Array.from(obfuscationIndicators).sort(),
    riskyScripts,
    scriptIndicatorMap: scriptIndicatorMap.sort(),
    suspiciousScripts: [...new Set(suspiciousScripts)].sort(),
  };
}

/**
 * Parse a package.json file into CycloneDX component objects.
 *
 * @param {string} pkgJsonFile Path to the package.json file.
 * @param {boolean} [simple=false] When true, omit component properties and
 *   identity evidence and skip npm registry metadata fetching.
 * @param {boolean} [securityProps=false] When true, append npm security-relevant
 *   properties such as lifecycle scripts, binaries, native addons, and deprecation notices.
 * @returns {Promise<Array<object>>} Parsed component list, enriched with npm
 *   registry metadata when available and not in simple mode.
 */
export async function parsePkgJson(
  pkgJsonFile,
  simple = false,
  securityProps = false,
) {
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
      const purl = build({
        type: "npm",
        namespace: group || null,
        name: name,
        version: pkgData.version || null,
      });
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
        license: resolveNpmLicense(pkgData),
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
            name: "internal:SrcFile",
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
      if (securityProps) {
        if (!apkg.properties) {
          apkg.properties = [];
        }
        // Track executable binaries (potential code execution vectors)
        if (pkgData.bin) {
          const binValue =
            typeof pkgData.bin === "object"
              ? Object.keys(pkgData.bin).join(", ")
              : pkgData.bin;
          apkg.properties.push({
            name: "cdx:npm:bin",
            value: binValue,
          });
          apkg.properties.push({
            name: "cdx:npm:has_binary",
            value: "true",
          });
        }
        // Track lifecycle scripts (preinstall, postinstall, etc. - code execution risk)
        if (pkgData.scripts && Object.keys(pkgData.scripts).length) {
          const scriptNames = Object.keys(pkgData.scripts).join(", ");
          const lifecycleAnalysis = analyzeNpmLifecycleScripts(
            pkgJsonFile,
            pkgData.scripts,
          );
          apkg.properties.push({
            name: "cdx:npm:scripts",
            value: scriptNames,
          });
          // Highlight build-related scripts for downstream tooling consumers
          const buildScriptNames = Object.keys(pkgData.scripts).filter(
            (scriptName) => NPM_BUILD_SCRIPT_NAME_PATTERN.test(scriptName),
          );
          if (buildScriptNames.length) {
            apkg.properties.push({
              name: "cdx:npm:buildScripts",
              value: buildScriptNames.join(", "),
            });
          }
          // Flag high-risk scripts specifically
          const riskyScripts = lifecycleAnalysis.riskyScripts;
          if (riskyScripts.length) {
            apkg.properties.push({
              name: "cdx:npm:hasInstallScript",
              value: "true",
            });
            apkg.properties.push({
              name: "cdx:npm:risky_scripts",
              value: riskyScripts.join(", "),
            });
          }
          if (lifecycleAnalysis.suspiciousScripts.length) {
            apkg.properties.push({
              name: "cdx:npm:hasSuspiciousLifecycleScript",
              value: "true",
            });
            apkg.properties.push({
              name: "cdx:npm:suspiciousLifecycleScripts",
              value: lifecycleAnalysis.suspiciousScripts.join(", "),
            });
          }
          if (lifecycleAnalysis.obfuscatedScripts.length) {
            apkg.properties.push({
              name: "cdx:npm:hasObfuscatedLifecycleScript",
              value: "true",
            });
            apkg.properties.push({
              name: "cdx:npm:obfuscatedLifecycleScripts",
              value: lifecycleAnalysis.obfuscatedScripts.join(", "),
            });
          }
          if (lifecycleAnalysis.obfuscationIndicators.length) {
            apkg.properties.push({
              name: "cdx:npm:lifecycleObfuscationIndicators",
              value: lifecycleAnalysis.obfuscationIndicators.join(", "),
            });
          }
          if (lifecycleAnalysis.executionIndicators.length) {
            apkg.properties.push({
              name: "cdx:npm:lifecycleExecutionIndicators",
              value: lifecycleAnalysis.executionIndicators.join(", "),
            });
          }
          if (lifecycleAnalysis.networkIndicators.length) {
            apkg.properties.push({
              name: "cdx:npm:lifecycleNetworkIndicators",
              value: lifecycleAnalysis.networkIndicators.join(", "),
            });
          }
          if (lifecycleAnalysis.scriptIndicatorMap.length) {
            apkg.properties.push({
              name: "cdx:npm:lifecycleIndicatorMap",
              value: lifecycleAnalysis.scriptIndicatorMap.join(" | "),
            });
          }
        }
        // Track platform/architecture constraints
        if (pkgData.cpu && Array.isArray(pkgData.cpu) && pkgData.cpu.length) {
          apkg.properties.push({
            name: "cdx:npm:cpu",
            value: pkgData.cpu.join(", "),
          });
        }
        if (pkgData.os && Array.isArray(pkgData.os) && pkgData.os.length) {
          apkg.properties.push({
            name: "cdx:npm:os",
            value: pkgData.os.join(", "),
          });
        }
        if (
          pkgData.libc &&
          Array.isArray(pkgData.libc) &&
          pkgData.libc.length
        ) {
          apkg.properties.push({
            name: "cdx:npm:libc",
            value: pkgData.libc.join(", "),
          });
        }
        // Track deprecation notices
        if (pkgData.deprecated) {
          apkg.properties.push({
            name: "cdx:npm:deprecation_notice",
            value: pkgData.deprecated,
          });
        }
        // Track if package uses node-gyp (native C/C++ addons = higher risk)
        if (
          pkgData.gypfile === true ||
          pkgData.files?.some((f) => f.endsWith(".gyp") || f.endsWith(".gypi"))
        ) {
          apkg.properties.push({
            name: "cdx:npm:gypfile",
            value: "true",
          });
          apkg.properties.push({
            name: "cdx:npm:native_addon",
            value: "true",
          });
          const nativeDeps = [
            "nan",
            "node-addon-api",
            "bindings",
            "node-gyp-build",
          ];
          const foundNativeDeps = Object.keys(
            pkgData.dependencies || {},
          ).filter((dep) => nativeDeps.includes(dep));
          if (foundNativeDeps.length) {
            apkg.properties.push({
              name: "cdx:npm:native_deps",
              value: foundNativeDeps.join(", "),
            });
          }
        }
      }
      pkgList.push(apkg);
    } catch (_err) {
      // continue regardless of error
    }
  }
  if (!simple && shouldFetchPackageMetadata() && pkgList?.length) {
    if (DEBUG_MODE) {
      console.log(
        `About to fetch npm registry metadata for ${pkgList.length} packages in parsePkgJson`,
      );
    }
    return await getNpmMetadata(pkgList);
  }
  return pkgList;
}

// The four manifest fields that npm packageExtensions and .npm-extension
// transformManifest may add or correct. Mirrors EXTENSION_FIELDS in the
// vendored arborist's package-extensions.js and the upstream npm-extension.js
// at the pinned commit, so overlays and provenance stay in lockstep with npm.
const EXTENSION_FIELDS = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
];

/**
 * Collect the dependency names that an extension provenance object says changed,
 * sorted and comma-separated per the component-level list convention.
 *
 * @param {object|null|undefined} applied Provenance from arborist
 *   ({ selector|extensionPoint, dependencies?, optionalDependencies?, peerDependencies?, peerDependenciesMeta? })
 * @returns {string|null} Sorted comma-separated names, or null when nothing changed.
 */
function formatExtensionAppliedList(applied) {
  if (!applied || typeof applied !== "object") {
    return null;
  }
  const names = new Set();
  for (const field of EXTENSION_FIELDS) {
    const changed = applied[field];
    if (Array.isArray(changed)) {
      for (const name of changed) {
        if (typeof name === "string" && name) {
          names.add(name);
        }
      }
    }
  }
  if (!names.size) {
    return null;
  }
  return [...names].sort().join(", ");
}

/**
 * Hash a root `.npm-extension` file exactly as npm does: ssri sha512 over
 * `npm-extension:v1:<format>\n` followed by the raw file bytes. Mirrors
 * `hashFile` in the vendored arborist's upstream npm-extension.js so the value
 * is comparable to what npm writes into the lockfile as `npmExtensionHash`.
 *
 * @param {string} format Either "mjs" or "cjs"
 * @param {Buffer} bytes Raw file contents
 * @returns {string} ssri integrity string
 */
export function hashNpmExtensionFile(format, bytes) {
  return ssri
    .fromData(
      Buffer.concat([Buffer.from(`npm-extension:v1:${format}\n`), bytes]),
      { algorithms: ["sha512"] },
    )
    .toString();
}

/**
 * Detect a root-owned `.npm-extension.mjs` or `.npm-extension.cjs` file and
 * return its format, path, and npm-comparable hash. Returns null when no file
 * is present. A non-root workspace file is never consulted, matching upstream.
 *
 * @param {string} rootPath Real path of the project root (tree.realpath)
 * @returns {{format: string, path: string, hash: string, duplicate: boolean}|null}
 */
export function detectRootNpmExtension(rootPath) {
  const candidates = [
    { ext: "mjs", file: ".npm-extension.mjs" },
    { ext: "cjs", file: ".npm-extension.cjs" },
  ];
  let found = null;
  let duplicate = false;
  for (const candidate of candidates) {
    const filePath = join(rootPath, candidate.file);
    if (safeExistsSync(filePath)) {
      if (found) {
        duplicate = true;
        break;
      }
      found = { ext: candidate.ext, file: filePath };
    }
  }
  if (!found) {
    return null;
  }
  const bytes = readFileSync(found.file);
  return {
    format: found.ext,
    path: found.file,
    hash: hashNpmExtensionFile(found.ext, bytes),
    duplicate,
  };
}

/**
 * Overlay the four post-extension dependency fields from the lockfile onto each
 * node whose lockfile entry records an `.npm-extension` repair. This reproduces
 * npm's repaired edges exactly without executing any project-supplied code.
 * The lockfile entries hold the post-extension manifest because npm writes
 * `node.package` — already repaired at that point — into the lockfile.
 *
 * @param {object} tree The arborist root node from `loadActual`
 */
function applyNpmExtensionOverlay(tree) {
  const sw = tree.meta;
  const packages = sw?.data?.packages;
  if (!packages) {
    return;
  }
  for (const node of tree.inventory.values()) {
    if (node.isProjectRoot) {
      continue;
    }
    const loc = node.location;
    if (!loc) {
      continue;
    }
    const swEntry = packages[loc];
    if (!swEntry?.npmExtensionApplied) {
      continue;
    }
    const merged = { ...node.package };
    for (const field of EXTENSION_FIELDS) {
      if (swEntry[field] !== undefined) {
        merged[field] = swEntry[field];
      } else {
        delete merged[field];
      }
    }
    node.package = merged;
    node.npmExtensionApplied = swEntry.npmExtensionApplied;
  }
}

/**
 * Undo packageExtensions repairs applied by the vendored arborist during
 * loadActual, so the BOM reflects manifests as published. Only the four fields
 * an extension can touch are restored from the node's on-disk package.json;
 * every other field arborist derived while building the tree is left alone.
 * Reassigning `package` rebuilds the node's edges from the restored manifest.
 *
 * @param {object} tree The arborist root node from `loadActual`
 */
function undoPackageExtensions(tree) {
  for (const node of tree.inventory.values()) {
    if (!node.packageExtensionsApplied) {
      continue;
    }
    let published;
    try {
      published = JSON.parse(
        readFileSync(join(node.path, "package.json"), "utf8"),
      );
    } catch {
      // Without a readable manifest there is nothing to restore from, so the
      // repaired one stands and the provenance property keeps saying so.
      continue;
    }
    const restored = { ...node.package };
    for (const field of EXTENSION_FIELDS) {
      if (published[field] === undefined) {
        delete restored[field];
      } else {
        restored[field] = published[field];
      }
    }
    node.package = restored;
    node.packageExtensionsApplied = null;
  }
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
  const npmrcConfig = loadNpmrcConfig(
    options.projectRoot || dirname(pkgLockFile),
  );
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
    const isDevelopmentNode = node.dev === true || node.devOptional === true;
    const scope =
      isDevelopmentNode || node.optional === true ? "optional" : undefined;
    const integrity = node.integrity ? node.integrity : undefined;
    const { nodePackage, diskPkg, packageJsonPath } = hydrateNpmNodePackage(
      node,
      options,
    );

    let pkg;
    let purlString;
    const author = nodePackage.author;
    const authorString =
      author instanceof Object
        ? `${author.name}${author.email ? ` <${author.email}>` : ""}${
            author.url ? ` (${author.url})` : ""
          }`
        : author;
    if (node === rootNode) {
      const projectGroup = options.projectGroup;
      // A package.json without a name still installs, so the root of a deep
      // tree can lack one: name the root component after its directory, the
      // way the scans without node_modules already do, rather than fail to
      // build its purl (issue 4440). A tree rooted at a file-system root has
      // no directory name either, and neither has the --project-name the CLI
      // derives from it.
      const projectName =
        ("project-name" in options && options.projectName) ||
        node.packageName ||
        basename(node.path || "") ||
        node.name ||
        UNNAMED_NPM_PROJECT;
      const projectVersion = options.projectVersion || node.version;
      // A package.json need not declare a version, and npm installs without
      // one, so the root of a lockfile can reach here with none. A purl carries
      // no version rather than an empty one.
      purlString = (
        projectGroup
          ? build({
              type: "npm",
              namespace: projectGroup,
              name: projectName,
              version: projectVersion || null,
            })
          : npmPurl(projectName, projectVersion)
      ).replace(/%2F/g, "/");
      pkg = {
        author: authorString,
        group: options.projectGroup || "",
        name: projectName,
        version: options.projectVersion || node.version,
        type: "application",
        purl: purlString,
        "bom-ref": decodeURIComponent(purlString),
        properties: [],
      };
      if (lockfilePackageExtensionsHash) {
        pkg.properties.push({
          name: "cdx:npm:packageExtensionsHash",
          value: lockfilePackageExtensionsHash,
        });
      }
      if (extensionFile) {
        pkg.properties.push({
          name: "cdx:npm:extensionHash",
          value: extensionFile.hash,
        });
        pkg.properties.push({
          name: "cdx:npm:extensionFormat",
          value: extensionFile.format,
        });
      }
      if (extensionAppliedStatus !== null) {
        pkg.properties.push({
          name: "cdx:npm:extensionApplied",
          value: extensionAppliedStatus,
        });
      }
      if (noPackageExtensions && isDeep) {
        pkg.properties.push({
          name: "cdx:npm:packageExtensionsDisabled",
          value: "true",
        });
      }
    } else {
      // A package.json without a name installs as a file: or workspace
      // dependency too, and arborist then has no packageName for it: such a
      // package goes by the name its folder has in the tree, which is also
      // the name the edges into it carry (issue 4440).
      const packageName =
        node.packageName || node.name || basename(node.path || "");
      let namespace = "";
      let name = packageName;
      if (packageName.startsWith("@")) {
        const slashIndex = packageName.indexOf("/");
        if (slashIndex > 0) {
          namespace = packageName.substring(0, slashIndex);
          name = packageName.substring(slashIndex + 1);
        }
      }
      let qualifiers = null;
      let extRefs = [];
      const isGitDep =
        node.resolved &&
        (node.resolved.startsWith("git+") ||
          node.resolved.startsWith("git://") ||
          node.resolved.startsWith("ssh://") ||
          node.resolved.startsWith("git@"));
      if (isGitDep) {
        qualifiers = buildNpmGitPurlQualifiers(
          node.resolved,
          namespace,
          npmrcConfig,
        );
        const gitIntakeRefs = buildNpmGitDistributionIntakeRefs(
          namespace,
          name,
          node.version,
          npmrcConfig,
        );
        if (gitIntakeRefs) {
          extRefs = extRefs.concat(gitIntakeRefs);
        }
      }
      purlString = build({
        type: "npm",
        namespace: namespace || null,
        name: name,
        version: node.version || null,
        qualifiers: qualifiers || null,
      });
      const pkgLockFile = join(
        srcFilePath.replace("/", _sep),
        "package-lock.json",
      );
      pkg = {
        group: namespace,
        name: name,
        version: node.version,
        author: authorString,
        scope: scope,
        _integrity: integrity,
        externalReferences: extRefs,
        properties: [
          {
            name: "internal:SrcFile",
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
      if (isDevelopmentNode) {
        setNpmDevelopmentProperty(pkg);
      }
      if (node.optional === true) {
        setNpmOptionalProperty(pkg);
      }
      if (node.peer === true) {
        setNpmPeerProperty(pkg);
      }
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
            name: "internal:ResolvedUrl",
            value: node.resolved,
          });
          pkg.externalReferences.push({
            type: "distribution",
            url: node.resolved,
          });
        }
      }
      if (node.location) {
        pkg.properties.push({
          name: "internal:LocalNodeModulesPath",
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
        // Absolute bin paths would leak the generating machine's home
        // directory into the SBOM and differ between checkouts, so they are
        // emitted relative to the project root the package was resolved from
        // (issue 4467).
        pkg.properties.push({
          name: "cdx:npm:binPaths",
          value: node.binPaths
            .map((binPath) => relative(srcFilePath, binPath))
            .join(", "),
        });
      }
      if (nodePackage?.bin) {
        const binValue =
          typeof nodePackage.bin === "object"
            ? Object.keys(nodePackage.bin).join(", ")
            : nodePackage.bin;
        pkg.properties.push({
          name: "cdx:npm:bin",
          value: binValue,
        });
        pkg.properties.push({
          name: "cdx:npm:has_binary",
          value: "true",
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
      const npmManifestSources = collectNpmManifestSources(node);
      if (npmManifestSources.length) {
        addComponentProperty(
          pkg,
          "cdx:npm:manifestSourceType",
          npmManifestSources
            .map((manifestSource) => manifestSource.type)
            .join(","),
        );
        addComponentProperty(
          pkg,
          "cdx:npm:manifestSource",
          npmManifestSources
            .map((manifestSource) => manifestSource.value)
            .join(","),
        );
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
      // Detect version spoofing by comparing the version in the lockfile with the version in package.json
      if (packageJsonPath && safeExistsSync(packageJsonPath)) {
        try {
          const onDiskPkg =
            diskPkg || JSON.parse(readFileSync(packageJsonPath, "utf8"));
          // A package that declares no name on disk and none in the lockfile
          // (a nameless file: dependency) disagrees with nothing.
          if (
            (onDiskPkg.name || node.packageName) &&
            onDiskPkg.name !== node.packageName
          ) {
            console.warn(
              `\x1b[1;35mWARNING: Package name spoofing detected for ${packageName}! Lockfile says ${node.packageName}, but disk says ${onDiskPkg.name}.\x1b[0m`,
            );
            if (onDiskPkg.name) {
              pkg.properties.push({
                name: "cdx:npm:nameMismatchError",
                value: `${onDiskPkg.name} used instead of ${node.packageName}`,
              });
            }
          }
          if (
            (onDiskPkg.version || node.version) &&
            onDiskPkg.version !== node.version
          ) {
            console.warn(
              `\x1b[1;35mWARNING: Package version spoofing detected for ${packageName}! Lockfile says ${node.version}, but disk says ${onDiskPkg.version}.\x1b[0m`,
            );
            if (onDiskPkg.version) {
              pkg.properties.push({
                name: "cdx:npm:versionMismatchError",
                value: `${onDiskPkg.version} used instead of ${node.version}`,
              });
            }
          }
        } catch (_err) {
          // ignore
        }
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
      const packageExtensionsAppliedList = formatExtensionAppliedList(
        node.packageExtensionsApplied,
      );
      if (packageExtensionsAppliedList) {
        pkg.properties.push({
          name: "cdx:npm:packageExtensionsApplied",
          value: packageExtensionsAppliedList,
        });
      }
      const npmExtensionAppliedList = formatExtensionAppliedList(
        node.npmExtensionApplied,
      );
      if (npmExtensionAppliedList) {
        pkg.properties.push({
          name: "cdx:npm:extensionFieldsApplied",
          value: npmExtensionAppliedList,
        });
      }
      if (nodePackage?.repository?.url) {
        pkg.externalReferences.push({
          type: "vcs",
          url: nodePackage.repository.url,
        });
      }
      if (nodePackage?.bugs?.url) {
        pkg.externalReferences.push({
          type: "issue-tracker",
          url: nodePackage.bugs.url,
        });
      }
      if (nodePackage?.keywords?.length) {
        pkg.tags = Array.isArray(nodePackage.keywords)
          ? nodePackage.keywords.sort()
          : nodePackage.keywords.split(",");
      }
      if (nodePackage?.description) {
        pkg.description = nodePackage.description;
      }
    }
    const npmLicense = resolveNpmLicense(nodePackage);
    if (npmLicense) {
      // License will be overridden if shouldFetchLicense() is enabled
      pkg.license = npmLicense;
    }
    const deprecatedMessage = nodePackage?.deprecated;
    if (deprecatedMessage) {
      pkg.properties.push({
        name: "cdx:npm:deprecated",
        value: deprecatedMessage,
      });
    }
    if (!pkg.properties.length) {
      delete pkg.properties;
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
          new Purl({
            type: "npm",
            namespace: "" || null,
            name: workspaceNode.name,
            version: workspaceNode.version || null,
          })
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
          new Purl({
            type: "npm",
            namespace: "" || null,
            name: childNode.name,
            version: childNode.version || null,
          })
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
            targetName = edge.name.replace(/-cjs$/, "");
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
        npmPurl(targetName, targetVersion),
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
    recordDegradation("js.lockfile-version", {
      ecosystem: "npm",
      tool: "npm",
      impact: "transitive-deps",
      path: pkgLockFile,
      detail:
        "The package-lock.json could not be parsed with the current npm dependency-resolution semantics, so the legacy parser is used instead.",
    });
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
      recordDegradation("js.lockfile-version", {
        ecosystem: "npm",
        tool: "npm",
        kind: "evidence.degraded",
        impact: "transitive-deps",
        path: pkgLockFile,
        detail:
          "The package-lock.json could not be parsed in either npm resolution mode, so the resulting SBOM is incomplete.",
      });
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

  const isDeep = Boolean(options.deep);
  const noPackageExtensions = options.packageExtensions === false;
  const lockfilePackageExtensionsHash =
    tree.meta?.packageExtensionsHash || null;
  const lockfileNpmExtensionHash = tree.meta?.npmExtensionHash || null;

  let extensionFile = null;
  try {
    extensionFile = detectRootNpmExtension(tree.realpath);
  } catch (e) {
    if (DEBUG_MODE) {
      console.log(`Failed to inspect .npm-extension: ${e.message}`);
    }
  }

  // Whether the repairs the root .npm-extension defines are reflected in this
  // BOM. null when no extension file is present, so an absent property always
  // means "no extension", never "we did not look".
  //
  // The lockfile is the only source for those repairs, since cdxgen never
  // executes the file. A lockfile written against the same file bytes carries
  // the repaired dependency fields, whichever load path built the tree:
  // loadVirtual reads them directly, loadActual overlays them onto the
  // manifests found on disk. So the hash comparison, not the load path, decides
  // the status.
  let extensionAppliedStatus = null;
  if (extensionFile) {
    if (extensionFile.duplicate) {
      console.warn(
        "\x1b[1;33mWARNING: Found both .npm-extension.mjs and .npm-extension.cjs at the project root. Using the .mjs file.\x1b[0m",
      );
    }
    if (!lockfileNpmExtensionHash) {
      extensionAppliedStatus = "false";
      console.warn(
        "\x1b[1;33mWARNING: A root .npm-extension file is present but the lockfile does not record one, and cdxgen does not execute project-supplied code. " +
          "The dependency graph may be incomplete because the manifest repairs the extension defines are not reflected.\x1b[0m",
      );
    } else if (extensionFile.hash !== lockfileNpmExtensionHash) {
      extensionAppliedStatus = "unverified";
      console.warn(
        "\x1b[1;33mWARNING: The root .npm-extension file has changed since the lockfile was written. " +
          "The dependency graph is reported as unverified because the on-disk hash does not match the lockfile.\x1b[0m",
      );
    } else {
      if (isDeep) {
        applyNpmExtensionOverlay(tree);
      }
      extensionAppliedStatus = "true";
    }
  }

  if (noPackageExtensions && isDeep) {
    undoPackageExtensions(tree);
  }

  ({ pkgList, dependenciesList } = parseArboristNode(
    tree,
    tree,
    null,
    new Set(),
    pkgSpecVersionCache,
    options,
  ));

  if (shouldFetchPackageMetadata() && pkgList?.length) {
    if (DEBUG_MODE) {
      console.log(
        `About to fetch npm registry metadata for ${pkgList.length} packages in parsePkgLock`,
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
    l = l.replaceAll("\r", "");
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
  let fullName;
  // A yarn lock key is `<name>@<descriptor>`. The first "@" that is not the
  // leading scope marker separates the package name from its descriptor:
  //   asap@~2.0.3                       -> name "asap"
  //   @babel/cli@7.10.1                 -> name "@babel/cli"
  //   lru-cache@npm:^6.0.0              -> name "lru-cache"
  //   react-is-18@npm:react-is@^18.3.1  -> npm alias, real name "react-is"
  //   lru-cache@patch:lru-cache@npm:... -> patch protocol, name "lru-cache"
  const sepIdx = l.startsWith("@") ? l.indexOf("@", 1) : l.indexOf("@");
  if (sepIdx > -1) {
    fullName = l.slice(0, sepIdx);
    const descriptor = l.slice(sepIdx + 1);
    // Only an npm: descriptor placed immediately after the name can alias to a
    // different real package. Other protocols (patch:, workspace:, file:, ...)
    // keep the original name; the "@npm:" nested inside a patch locator is not
    // an alias marker, so we must not treat it as one.
    if (descriptor.startsWith("npm:")) {
      const target = descriptor.slice("npm:".length);
      // An alias target is `name@range`; a plain version is just a `range`.
      // A leading "@" only marks a scoped package, so look for the separator
      // beyond it.
      const aliasSepIdx = target.startsWith("@")
        ? target.indexOf("@", 1)
        : target.indexOf("@");
      if (aliasSepIdx > -1) {
        // Aliased dependency: use the real package name from the target.
        fullName = target.slice(0, aliasSepIdx);
      }
    }
  }
  if (fullName) {
    const slashIdx = fullName.indexOf("/");
    if (slashIdx > -1) {
      group = fullName.slice(0, slashIdx);
      name = fullName.slice(slashIdx + 1);
    } else {
      name = fullName;
    }
  }
  return { group, name };
}

function _resolveYarnDependencyBomRef(
  packageName,
  versionRange,
  identMap,
  workspacePackages = [],
) {
  if (!packageName || !versionRange) {
    return undefined;
  }
  let packageNameToUse = packageName;
  let versionRangeToUse = versionRange;
  if (versionRange.startsWith("npm:")) {
    if (versionRange.includes("@")) {
      versionRangeToUse = versionRange.split("@").splice(-1)[0];
      packageNameToUse = versionRange
        .replace("npm:", "")
        .replace(`@${versionRangeToUse}`, "");
    } else {
      versionRangeToUse = versionRange.replace("npm:", "");
    }
  }
  let resolvedVersion =
    identMap[`${packageName}|${versionRangeToUse}`] ||
    identMap[`${packageNameToUse}|${versionRangeToUse}`];
  if (!resolvedVersion) {
    const packageKeys = Object.keys(identMap).filter((key) => {
      const [pkg] = key.split("|");
      return pkg === packageName || pkg === packageNameToUse;
    });
    resolvedVersion = identMap[packageKeys[0]];
  }
  if (!resolvedVersion && workspacePackages?.length) {
    const matchingWorkspace = findMatchingNpmWorkspace(
      workspacePackages,
      packageNameToUse,
    );
    if (matchingWorkspace) {
      // The workspace reference may be an escaped purl, so its version is read
      // through the purl parser rather than cut out of the string.
      resolvedVersion =
        parsePurlLoose(matchingWorkspace)?.version || resolvedVersion;
    }
  }
  return decodeURIComponent(
    npmPurl(packageNameToUse, resolvedVersion?.length ? resolvedVersion : null),
  );
}

function _collectYarnRootDependencyRefs(
  yarnLockFile,
  identMap,
  workspacePackages = [],
) {
  const rootRefs = _createYarnRootDependencyRefs();
  const packageJsonFile = join(dirname(yarnLockFile), "package.json");
  if (!safeExistsSync(packageJsonFile)) {
    return rootRefs;
  }
  let packageJson;
  try {
    packageJson = JSON.parse(readFileSync(packageJsonFile, "utf-8"));
  } catch {
    return rootRefs;
  }
  for (const dependencyType of Object.keys(rootRefs)) {
    for (const [packageName, versionRange] of Object.entries(
      packageJson[dependencyType] || {},
    )) {
      const bomRef = _resolveYarnDependencyBomRef(
        packageName,
        String(versionRange),
        identMap,
        workspacePackages,
      );
      if (bomRef) {
        rootRefs[dependencyType].add(bomRef);
      }
    }
  }
  return rootRefs;
}

function _createYarnRootDependencyRefs() {
  return {
    dependencies: new Set(),
    devDependencies: new Set(),
    optionalDependencies: new Set(),
    peerDependencies: new Set(),
  };
}

function _buildDependencyClosure(rootRefs, dependenciesMap) {
  const closure = new Set();
  const stack = [...rootRefs];
  while (stack.length) {
    const ref = stack.pop();
    if (!ref || closure.has(ref)) {
      continue;
    }
    closure.add(ref);
    for (const childRef of dependenciesMap[ref] || []) {
      stack.push(childRef);
    }
  }
  return closure;
}

function _markYarnDependencyScopeClosures(
  pkgList,
  dependenciesList,
  yarnRootRefs,
  yarnOptionalDependencyRefs,
) {
  const dependenciesMap = {};
  for (const dependency of dependenciesList || []) {
    if (!dependenciesMap[dependency.ref]) {
      dependenciesMap[dependency.ref] = [];
    }
    dependenciesMap[dependency.ref] = Array.from(
      new Set([
        ...dependenciesMap[dependency.ref],
        ...(dependency.dependsOn || []),
      ]),
    );
  }
  const runtimeClosure = _buildDependencyClosure(
    yarnRootRefs.dependencies,
    dependenciesMap,
  );
  const devClosure = _buildDependencyClosure(
    yarnRootRefs.devDependencies,
    dependenciesMap,
  );
  const optionalClosure = _buildDependencyClosure(
    new Set([
      ...yarnRootRefs.optionalDependencies,
      ...yarnOptionalDependencyRefs,
    ]),
    dependenciesMap,
  );
  const peerClosure = _buildDependencyClosure(
    yarnRootRefs.peerDependencies,
    dependenciesMap,
  );
  for (const pkg of pkgList) {
    const ref = pkg["bom-ref"];
    if (!ref) {
      continue;
    }
    if (
      optionalClosure.has(ref) &&
      (!runtimeClosure.has(ref) ||
        yarnRootRefs.optionalDependencies.has(ref) ||
        yarnOptionalDependencyRefs.has(ref))
    ) {
      pkg.scope = "optional";
      setNpmOptionalProperty(pkg);
    }
    if (peerClosure.has(ref) && !runtimeClosure.has(ref)) {
      pkg.scope = "optional";
      setNpmPeerProperty(pkg);
    }
    if (devClosure.has(ref) && !runtimeClosure.has(ref)) {
      pkg.scope = "optional";
      setNpmDevelopmentProperty(pkg);
    }
  }
}

/**
 * Parse nodejs yarn lock file
 *
 * @param {string} yarnLockFile yarn.lock file
 * @param {Object} parentComponent parent component
 * @param {Array[String]} workspacePackages Workspace packages
 * @param {Object} workspaceSrcFiles Workspace package.json files
 * @param {Object} workspaceDirectDeps Declared dependencies (name to range) of each workspace package
 * @param {Object} depsWorkspaceRefs Workspace references for each dependency
 */
export async function parseYarnLock(
  yarnLockFile,
  parentComponent = null,
  workspacePackages = [],
  workspaceSrcFiles = {},
  workspaceDirectDeps = {},
  depsWorkspaceRefs = {},
) {
  let pkgList = [];
  const dependenciesList = [];
  const depKeys = {};
  // The lock keys and the resolved version required to solve the dependency tree
  let identMap = {};
  let yarnRootRefs = _createYarnRootDependencyRefs();
  const yarnOptionalDependencyRefs = new Set();
  const npmrcConfig = loadNpmrcConfig(dirname(yarnLockFile));
  if (safeExistsSync(yarnLockFile)) {
    const lockData = readFileSync(yarnLockFile, "utf8");
    let name = "";
    let name_aliases = [];
    let group = "";
    let version = "";
    let integrity = "";
    let resolvedUrl = "";
    let depsMode = false;
    let optionalDepsMode = false;
    let purlString = "";
    let deplist = new Set();
    const pkgAddedMap = {};
    // Map to track workspace package PURL replacements from 0.0.0-use.local to actual versions
    const workspacePurlMap = {};
    identMap = yarnLockToIdentMap(lockData);
    yarnRootRefs = _collectYarnRootDependencyRefs(
      yarnLockFile,
      identMap,
      workspacePackages,
    );
    lockData.split("\n").forEach((l) => {
      l = l.replaceAll("\r", "");
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
            let qualifiers = null;
            let extRefs = [];
            const isGitDep =
              resolvedUrl &&
              (resolvedUrl.startsWith("git+") ||
                resolvedUrl.startsWith("git://") ||
                resolvedUrl.startsWith("ssh://") ||
                resolvedUrl.startsWith("git@") ||
                resolvedUrl.includes(".git"));
            if (isGitDep) {
              qualifiers = buildNpmGitPurlQualifiers(
                resolvedUrl,
                group,
                npmrcConfig,
              );
              const gitIntakeRefs = buildNpmGitDistributionIntakeRefs(
                group,
                name,
                version,
                npmrcConfig,
              );
              if (gitIntakeRefs) {
                extRefs = extRefs.concat(gitIntakeRefs);
              }
            }
            // Create a purl ref for the current package
            purlString = build({
              type: "npm",
              namespace: group || null,
              name: name,
              version: version || null,
              qualifiers: qualifiers || null,
            });
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
                  wp.startsWith(
                    `${npmPurl(group ? `${group}/${name}` : name)}@`,
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
                  name: "internal:SrcFile",
                  value: yarnLockFile,
                },
              ];
              const pkgObj = {
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
              };
              if (extRefs && extRefs.length > 0) {
                pkgObj.externalReferences = extRefs;
              }
              pkgList.push(pkgObj);
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
          resolvedUrl = "";
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
          const range = tmpA[1].replace(/["']/g, "");
          const depBomRef = _resolveYarnDependencyBomRef(
            dgroupname,
            range,
            identMap,
            workspacePackages,
          );
          if (depBomRef) {
            deplist.add(depBomRef);
          }
          if (optionalDepsMode && depBomRef) {
            yarnOptionalDependencyRefs.add(depBomRef);
          }
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
          resolvedUrl = parts[1].replace(/"/g, "");
          const tmpB = resolvedUrl.split("#");
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
      const purlObj = Purl.parse(apkg.purl);
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
          const purlObj = Purl.parse(apkg.purl);
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
          // Workspace references arrive both escaped (built by cdx-purl) and in
          // the decoded bom-ref form, so they are split structurally and
          // rebuilt. Copying the version text across forms is what turned
          // `3.0.0+ws` into `3.0.0%252Bws`.
          const workspaceParts = parsePurlLoose(workspacePkg);
          if (!workspaceParts) {
            continue;
          }
          const purlObj = new Purl({
            type: "npm",
            namespace: workspaceParts.namespace,
            name: workspaceParts.name,
            version: workspaceParts.version,
            subpath: workspaceParts.subpath,
          });

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
                name: "internal:SrcFile",
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
                name: "internal:SrcFile",
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
    // A yarn v1 lock file has no entries for workspace packages, so a member
    // would otherwise have no dependency entry and nothing would reach it.
    // Each member gets one built from the dependencies its own package.json
    // declares; the root's entry, built from every dependency entry, then
    // includes the member too. A lock file that already recorded the member
    // (yarn berry) keeps the entry it produced.
    const recordedRefs = new Set(dependenciesList.map((d) => d.ref));
    for (const workspacePkg of workspacePackages) {
      const workspaceRef = decodeURIComponent(workspacePkg);
      if (
        recordedRefs.has(workspaceRef) ||
        !pkgList.some((pkg) => pkg["bom-ref"] === workspaceRef)
      ) {
        continue;
      }
      const dependsOn = new Set();
      for (const [depName, depRange] of Object.entries(
        workspaceDirectDeps?.[workspacePkg] || {},
      )) {
        const depRef = _resolveYarnDependencyBomRef(
          depName,
          String(depRange),
          identMap,
          workspacePackages,
        );
        if (depRef && depRef !== workspaceRef) {
          dependsOn.add(depRef);
        }
      }
      dependenciesList.push({
        ref: workspaceRef,
        dependsOn: [...dependsOn].sort(),
      });
      recordedRefs.add(workspaceRef);
    }
  }

  _markYarnDependencyScopeClosures(
    pkgList,
    dependenciesList,
    yarnRootRefs,
    yarnOptionalDependencyRefs,
  );

  if (shouldFetchPackageMetadata() && pkgList?.length) {
    if (DEBUG_MODE) {
      console.log(
        `About to fetch npm registry metadata for ${pkgList.length} packages in parseYarnLock`,
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
              name: "internal:SrcFile",
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
  if (shouldFetchPackageMetadata() && pkgList?.length) {
    if (DEBUG_MODE) {
      console.log(
        `About to fetch npm registry metadata for ${pkgList.length} packages in parseNodeShrinkwrap`,
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

function _markTreeDevelopment(
  dbomRef,
  dependenciesMap,
  possibleDevelopmentDeps,
  visited,
) {
  // Production-required packages set this map entry to false, and that wins
  // over any later attempt to propagate a development-only marking.
  if (possibleDevelopmentDeps[dbomRef] === undefined) {
    possibleDevelopmentDeps[dbomRef] = true;
  }
  if (dependenciesMap[dbomRef] && !visited[dbomRef]) {
    visited[dbomRef] = true;
    for (const eachDep of dependenciesMap[dbomRef]) {
      // Undefined means we have not classified this dependency yet, so we
      // continue propagating the dev-only marking unless it was already proven
      // to be non-development via a false entry.
      if (possibleDevelopmentDeps[eachDep] !== false) {
        _markTreeDevelopment(
          eachDep,
          dependenciesMap,
          possibleDevelopmentDeps,
          visited,
        );
      }
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

/**
 * Strip the peer-dependency resolution that pnpm encodes into a version string.
 *
 * pnpm 5 and below append it after an underscore, either as a peer spec or as a hash
 * of one, while 6 and above wrap it in parentheses:
 *
 *   7.26.0_typescript@6.0.2
 *   2.3.3_5b3b7d3a75edb27abc53579646941536
 *   3.0.1(ajv@8.14.0)
 *
 * An npm version can contain neither an underscore nor a parenthesis, so both are
 * unambiguous separators. The suffix must not survive into a version or a purl: no
 * SCA tool can match `2.3.3_5b3b7d...` against an advisory, so a component carrying
 * one is effectively invisible to vulnerability lookups.
 *
 * @param {String} version Version string from a pnpm lock file
 *
 * @returns {String} The published version, without the peer-resolution suffix
 */
export function stripPnpmPeerSuffix(version) {
  // Only a registry version carries this suffix. Git refs, file:/link: paths and
  // package aliases may legitimately contain an underscore, and they never begin
  // with a digit.
  if (typeof version !== "string" || !/^\d/.test(version)) {
    return version;
  }
  return version.split("(")[0].split("_")[0];
}

/**
 * Resolve a concrete version for a pnpm dependency.
 *
 * Link/file references are resolved by reading the target package.json, while
 * registry versions have their pnpm peer-dependency suffix stripped via
 * {@link stripPnpmPeerSuffix}.
 *
 * @param {string|object} depPkg Dependency version string or package object.
 * @param {string} relativePath Base path for resolving link/file references:
 *   the directory of the importer that declares the dependency. Without it the
 *   path is tried against the working directory, which only works when cdxgen
 *   runs from the lock file's directory.
 * @returns {Promise<string|undefined>} The resolved published version.
 */
export async function getVersionNumPnpm(depPkg, relativePath) {
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
  } else {
    // version: 3.0.1(ajv@8.14.0) or, under lockfile 5, 3.0.1_ajv@8.14.0
    version = stripPnpmPeerSuffix(version);
  }
  return version;
}

/**
 * Split the package name of a pnpm `file:` lock key into scope and name.
 *
 * @param {string} fullName Package name as written before `@file:`, eg `@scope/pkg`
 * @returns {{group: string, name: string}} Scope (with its `@`) and bare name
 */
function splitPnpmFilePackageName(fullName) {
  if (fullName.startsWith("@")) {
    const slash = fullName.indexOf("/");
    if (slash > 0) {
      return {
        group: fullName.slice(0, slash),
        name: fullName.slice(slash + 1),
      };
    }
  }
  return { group: "", name: fullName };
}

/**
 * Resolve a pnpm dependency to its PURL string.
 *
 * Moved here from npmutils.js to break the npmutils ↔ parsers-js cycle.
 * Only callers are in this file.
 *
 * @param {string|object} depPkg Dependency package version or object
 * @param {string} packageName Package name
 * @param {object} gitPkgRefs Git package refs map
 * @param {string} relativePath Relative path for resolution
 * @param {string} githubServerHost GitHub server host
 * @param {object} [npmrcConfig={}] npmrc configuration
 * @returns {Promise<string>} Decoded PURL string
 */
export async function getPnpmDepPurl(
  depPkg,
  packageName,
  gitPkgRefs,
  relativePath,
  githubServerHost,
  npmrcConfig = {},
) {
  let name = packageName;
  let group = "";
  let version;
  const versionObj = typeof depPkg === "object" ? depPkg : { version: depPkg };
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
    const rawSpec =
      typeof versionObj?.version === "string" ? versionObj.version : "";
    version = await getVersionNumPnpm(depPkg, relativePath);
    const gitEntry =
      gitPkgRefs[packageName] ||
      gitPkgRefs[version] ||
      gitPkgRefs[normalizePnpmLockKey(`${packageName}@${version}`)] ||
      (rawSpec.startsWith("file:")
        ? gitPkgRefs[normalizePnpmLockKey(`${packageName}@${rawSpec}`)]
        : undefined);
    if (gitEntry) {
      group = gitEntry.group;
      name = gitEntry.name;
      version = gitEntry.version;
      const qualifiers =
        gitEntry.qualifiers ||
        buildNpmGitPurlQualifiers(gitEntry.vcsUrl, group, npmrcConfig);
      return decodeURIComponent(
        build({
          type: "npm",
          namespace: group || null,
          name: name,
          version: version || null,
          qualifiers: qualifiers || null,
        }),
      );
    }
  }
  return decodeURIComponent(
    build({
      type: "npm",
      namespace: group || null,
      name: name,
      version: version || null,
    }),
  );
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
  const workspacePackages = Array.isArray(yamlObj.packages)
    ? yamlObj.packages.filter((n) => typeof n === "string").map((n) => n.trim())
    : typeof yamlObj.packages === "string"
      ? [yamlObj.packages.trim()]
      : [];
  // Normalize a leading "./" so relative patterns such as "./packages/*" are
  // treated identically to "packages/*".
  const stripDotSlash = (n) => n.replace(/^\.\//, "");
  const excludePackages = workspacePackages
    .filter((n) => n.startsWith("!"))
    .map((n) => stripDotSlash(n.replace(/^!/, "")));
  const packagePatterns = workspacePackages
    // Drop exclusions ("!"), internal dirs ("__"), and the workspace root
    // self-reference ("." / "./"). Relative subpaths such as "./packages/*"
    // and dotdir members such as ".meta-updater" are kept - only the bare
    // root reference is dropped.
    .filter((n) => !/^(!|__)/.test(n) && n !== "." && n !== "./")
    .map(stripDotSlash);
  const packages = packagePatterns.map((n) =>
    n.replaceAll("/**", "").replaceAll("/*", ""),
  );
  const catalogs = yamlObj.catalog || {};
  return {
    excludePackages,
    packagePatterns,
    packages,
    catalogs,
  };
}

/**
 * Parses the workspaces field from a package.json file and returns the list of
 * workspace glob patterns. Handles both array and object (with packages key) formats.
 *
 * @param {string} packageJsonFile Path to the package.json file to parse
 * @returns {Object} Object with a packages array of workspace glob patterns, or an empty object on error
 */
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
    const encodedName = packageName.replaceAll("/", "%2f");
    const virtualStoreName = packageName.replaceAll("/", "+");
    let pnpmPackagePath;

    // Try different formats that pnpm might use
    const possiblePaths = [
      join(
        pnpmDir,
        `${virtualStoreName}@${version}`,
        "node_modules",
        packageName,
      ),
      join(pnpmDir, `${encodedName}@${version}`, "node_modules", packageName),
      join(pnpmDir, `${packageName}@${version}`, "node_modules", packageName),
      join(pnpmDir, `${virtualStoreName}@${version}`),
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
  if (!pkgList?.length || !lockFilePath) {
    return pkgList;
  }
  const baseDir = dirname(lockFilePath);
  const nodeModulesDir = join(baseDir, "node_modules");
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
    const packageName = pkg.group ? `${pkg.group}/${pkg.name}` : pkg.name;
    const packagePath = findPnpmPackagePath(baseDir, packageName, pkg.version);
    if (!packagePath) {
      continue;
    }
    const packageJsonPath = join(packagePath, "package.json");
    if (!safeExistsSync(packageJsonPath)) {
      continue;
    }
    try {
      const localPkgList = await parsePkgJson(packageJsonPath, true, true);
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
          if (!pkg.properties) {
            pkg.properties = [];
          }
          if (localMetadata?.properties?.length) {
            const seenProperties = new Set(
              pkg.properties.map(
                (prop) => `${String(prop?.name)}\u0000${String(prop?.value)}`,
              ),
            );
            for (const prop of localMetadata.properties) {
              const propertyKey = `${String(prop?.name)}\u0000${String(prop?.value)}`;
              if (!seenProperties.has(propertyKey)) {
                pkg.properties.push(prop);
                seenProperties.add(propertyKey);
              }
            }
          }
          pkg.properties.push({
            name: "internal:LocalNodeModulesPath",
            value: packagePath,
          });
          enhancedCount++;
        }
      }
    } catch (error) {
      // Silently ignore parsing errors for individual packages
      if (DEBUG_MODE) {
        console.log(
          "Failed to parse package.json at %s:",
          packageJsonPath,
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
 * Resolve a pnpm dependency value that is an alias pointing at another lock entry
 * rather than a plain version.
 *
 * pnpm writes such a value in the same shape as its package keys, and that shape
 * changed between lockfile versions:
 *
 *   v5 and below: /@wdio/utils/7.26.0_typescript@6.0.2, /string-width/4.2.3
 *   v6 and above: /@wdio/utils@7.26.0, string-width@4.2.3
 *
 * The version is returned verbatim, peer-dependency suffix included, because that
 * is how the aliased package's own lock key is turned into a version elsewhere in
 * parsePnpmLock - stripping it here would leave the dependency ref pointing at a
 * component that does not exist.
 *
 * @param {String} value Raw dependency value from the lock file
 *
 * @returns {Object|undefined} `{name, version}`, or undefined when the value is a
 *          plain version and not an alias
 */
export function parsePnpmAliasRef(value) {
  if (!value) {
    return undefined;
  }
  const spec = value.startsWith("/") ? value.slice(1) : value;
  // A leading @ introduces a scope, so the name spans two path segments there
  const nameSegCount = spec.startsWith("@") ? 2 : 1;
  const segments = spec.split("/");
  if (segments.length > nameSegCount) {
    // v5 style: the version is a path segment of its own
    return {
      name: segments.slice(0, nameSegCount).join("/"),
      version: segments.slice(nameSegCount).join("/"),
    };
  }
  if (segments.length < nameSegCount) {
    return undefined;
  }
  // v6 style: the version is glued to the last name segment with an @. Index 0 is
  // excluded so that the scope leader of an unversioned /@scope/pkg is not mistaken
  // for the separator.
  const lastSegment = segments[nameSegCount - 1];
  const sepIdx = lastSegment.indexOf("@");
  if (sepIdx < 1) {
    return undefined;
  }
  segments[nameSegCount - 1] = lastSegment.slice(0, sepIdx);
  return {
    name: segments.join("/"),
    version: lastSegment.slice(sepIdx + 1),
  };
}

/**
 * Parse nodejs pnpm lock file
 *
 * @param {string} pnpmLock pnpm-lock.yaml file
 * @param {Object} parentComponent parent component
 * @param {Array[String]} workspacePackages Workspace packages
 * @param {Object} workspaceSrcFiles Workspace package.json files
 * @param {Object} _workspaceCatalogs Workspace catalogs
 * @param {Object} _workspaceDirectDeps Direct dependencies of each workspace
 * @param {Object} depsWorkspaceRefs Workspace references for each dependency
 * @param {string} projectRoot Root path used to relativize pnpm-lock evidence paths
 */
export async function parsePnpmLock(
  pnpmLock,
  parentComponent = null,
  workspacePackages = [],
  workspaceSrcFiles = {},
  _workspaceCatalogs = {},
  _workspaceDirectDeps = {},
  depsWorkspaceRefs = {},
  projectRoot = undefined,
) {
  let pkgList = [];
  const dependenciesList = [];
  const pnpmLockDir = dirname(pnpmLock);
  const pnpmEvidenceRoot = projectRoot ? resolve(projectRoot) : pnpmLockDir;
  const npmrcConfig = loadNpmrcConfig(projectRoot || pnpmLockDir);
  const pnpmLockSrcFile = path.isAbsolute(pnpmLock)
    ? relative(pnpmEvidenceRoot, pnpmLock)
    : pnpmLock;
  // For lockfile >= 9, we need to track dev and optional packages manually
  // See: #1163
  // Moreover, we have changed >= 9 for >= 6
  // See: discussion #1359
  const possibleDevelopmentDeps = {};
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
  const githubServerHost =
    readEnvironmentVariable("CDXGEN_GIT_HOST") || "github.com";
  // Convert workspace package names to an object to help with the lookup
  for (const w of workspacePackages || []) {
    workspacePackageNames[w] = true;
  }
  if (parentComponent?.name) {
    ppurl =
      parentComponent.purl ||
      build({
        type: "npm",
        namespace: parentComponent.group || null,
        name: parentComponent.name,
        version: parentComponent.version || null,
      });
  }
  if (safeExistsSync(pnpmLock)) {
    const lockData = readFileSync(pnpmLock, "utf8");
    let yamlObj = parseAllDocuments(lockData);
    if (!yamlObj) {
      return {};
    }
    if (Array.isArray(yamlObj)) {
      try {
        yamlObj = yamlObj[yamlObj.length - 1].toJS();
      } catch (_e) {
        recordDegradation("js.pnpm-lock-unparseable", {
          ecosystem: "npm",
          tool: "pnpm",
          impact: "transitive-deps",
          path: pnpmLock,
          detail:
            "The pnpm-lock.yaml could not be parsed, so no locked versions were captured from it.",
        });
        console.log(`Unable to parse the pnpm lock file ${pnpmLock}.`);
        return {};
      }
    }
    lockfileVersion = yamlObj.lockfileVersion;
    try {
      lockfileVersion = Number.parseFloat(lockfileVersion, 10);
    } catch (_e) {
      // ignore parse errors
    }
    Object.assign(
      gitPkgRefs,
      buildPnpmGitPkgRefs(
        yamlObj.packages || {},
        yamlObj.snapshots || {},
        npmrcConfig,
      ),
    );
    // A `file:` package is keyed by its path (`localdep@file:localdep.tgz`) and
    // pnpm copies the manifest version into its `packages` entry. Registering
    // it lets an importer that names the path resolve to the same ref the
    // package loop below builds, instead of a version made from the path.
    if (lockfileVersion >= 9) {
      for (const [lockKey, pkgEntry] of Object.entries(
        yamlObj.packages || {},
      )) {
        const fileAt = lockKey.indexOf("@file:", 1);
        if (fileAt < 1 || !pkgEntry?.version) {
          continue;
        }
        const normalizedKey = normalizePnpmLockKey(lockKey);
        if (gitPkgRefs[normalizedKey]) {
          continue;
        }
        const { group, name } = splitPnpmFilePackageName(
          lockKey.slice(0, fileAt),
        );
        gitPkgRefs[normalizedKey] = {
          group,
          name,
          version: String(pkgEntry.version),
          vcsUrl: lockKey.slice(fileAt + 1),
        };
      }
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
        const dpurl = await getPnpmDepPurl(
          rootDevDeps[rdk],
          rdk,
          gitPkgRefs,
          pnpmLockDir,
          githubServerHost,
          npmrcConfig,
        );
        possibleDevelopmentDeps[dpurl] = true;
      }
      // Find the root optional and peer dependencies
      for (const rdk of Object.keys({ ...rootOptionalDeps, ...rootPeerDeps })) {
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
        const dpurl = await getPnpmDepPurl(
          rootOptionalDeps[rdk] || rootPeerDeps[rdk],
          rdk,
          gitPkgRefs,
          pnpmLockDir,
          githubServerHost,
          npmrcConfig,
        );
        possibleOptionalDeps[dpurl] = true;
        possibleDevelopmentDeps[dpurl] = false;
      }
      // Find the root direct dependencies
      for (const dk of Object.keys(rootDirectDeps)) {
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
        const dpurl = await getPnpmDepPurl(
          rootDirectDeps[dk],
          dk,
          gitPkgRefs,
          pnpmLockDir,
          githubServerHost,
          npmrcConfig,
        );
        ddeplist.add(dpurl);
        if (lockfileVersion >= 6) {
          // These are direct dependencies so cannot be optional
          possibleOptionalDeps[dpurl] = false;
        }
        possibleDevelopmentDeps[dpurl] = false;
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
        if (
          safeExistsSync(
            join(pnpmLockDir, importedComponentName, "package.json"),
          )
        ) {
          pkgSrcFile = join(pnpmLockDir, importedComponentName, "package.json");
          const importedComponentObj = await parsePkgJson(pkgSrcFile, true);
          if (importedComponentObj.length) {
            const version = importedComponentObj[0].version;
            compPurl = build({
              type: "npm",
              namespace: importedComponentObj[0]?.group || null,
              name: importedComponentObj[0]?.name,
              version: version || null,
            });
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
            const purlNoVersion = build({
              type: "npm",
              namespace: importedComponentObj[0]?.group || null,
              name: importedComponentObj[0]?.name,
              version: version || null,
            });
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
              psObj.properties.push({
                name: "internal:SrcFile",
                value: matchSrcFile,
              });
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
          compPurl = build({
            type: "npm",
            namespace: parentComponent.group || null,
            name: `${parentComponent.name}/${lastname}`,
            version: parentComponent.version || "latest" || null,
            subpath: subpath || null,
          });
        }
        // Find the component optional dependencies
        const comDepList = new Set();
        for (const cdk of Object.keys(componentDeps)) {
          const versionObj = componentDeps[cdk];
          const depRef = await getPnpmDepPurl(
            versionObj,
            cdk,
            gitPkgRefs,
            join(pnpmLockDir, importedComponentName),
            githubServerHost,
            npmrcConfig,
          );
          // This is a definite dependency of this component
          comDepList.add(depRef);
          possibleOptionalDeps[depRef] = false;
          possibleDevelopmentDeps[depRef] = false;
          // Track the package.json files
          if (pkgSrcFile) {
            if (!srcFilesMap[depRef]) {
              srcFilesMap[depRef] = [];
            }
            srcFilesMap[depRef].push(pkgSrcFile);
          }
        }
        for (const cdk of Object.keys(componentDevDeps)) {
          const version = await getVersionNumPnpm(
            componentDevDeps[cdk],
            join(pnpmLockDir, importedComponentName),
          );
          const dpurl = build({
            type: "npm",
            namespace: "" || null,
            name: cdk,
            version: version || null,
          });
          const devDpRef = decodeURIComponent(dpurl);
          possibleDevelopmentDeps[devDpRef] = true;
          // This is also a dependency of this component
          comDepList.add(devDpRef);
        }
        for (const cdk of Object.keys({
          ...componentOptionalDeps,
          ...componentPeerDeps,
        })) {
          const version = await getVersionNumPnpm(
            componentOptionalDeps[cdk] || componentPeerDeps[cdk],
            join(pnpmLockDir, importedComponentName),
          );
          const dpurl = build({
            type: "npm",
            namespace: "" || null,
            name: cdk,
            version: version || null,
          });
          possibleOptionalDeps[decodeURIComponent(dpurl)] = true;
          possibleDevelopmentDeps[decodeURIComponent(dpurl)] = false;
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
    // A lock entry named `__proto__` is not a real package: emitting it as a
    // component produces SBOM data that breaks naive JSON consumers, and the
    // name can never come from the npm registry. Legitimate names such as
    // `constructor` or `prototype` are unaffected.
    const protoLockKey = /(^|\/)__proto__(@|$)/;
    for (const k in pkgKeys) {
      // Eg: @babel/code-frame/7.10.1
      // In lockfileVersion 6, /@babel/code-frame@7.18.6
      let fullName = pkgKeys[k].replace("/@", "@");
      // Handle /vite@4.2.1(@types/node@18.15.11) in lockfileVersion 6
      if (lockfileVersion >= 6 && fullName.includes("(")) {
        fullName = fullName.split("(")[0];
      }
      if (protoLockKey.test(pkgKeys[k]) || protoLockKey.test(fullName)) {
        continue;
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
      const tarball = resolution?.tarball;
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
          // An aliased optional dependency records `name@version`, and the
          // version may carry semver build metadata that must be escaped.
          const aliasParts = parsePurlLoose(`pkg:npm/${vers}`);
          opurlString = aliasParts
            ? npmPurl(
                aliasParts.namespace
                  ? `${aliasParts.namespace}/${aliasParts.name}`
                  : aliasParts.name,
                aliasParts.version,
              )
            : npmPurl(opkgName, vers);
        } else {
          opurlString = npmPurl(opkgName, vers);
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
        const parsedGitKey =
          parsePnpmGitLockKey(fullName) || parsePnpmGitLockKey(pkgKeys[k]);
        if (parsedGitKey) {
          group = parsedGitKey.group;
          name = parsedGitKey.name;
          version =
            gitPkgRefs[parsedGitKey.fullName]?.version ||
            gitPkgRefs[parsedGitKey.packageName]?.version ||
            packageNode.version ||
            resolution?.commit ||
            "";
          const repo =
            resolution?.repo || gitPkgRefs[parsedGitKey.fullName]?.repo || "";
          const commit =
            resolution?.commit ||
            gitPkgRefs[parsedGitKey.fullName]?.commit ||
            "";
          if (repo && commit) {
            srcUrl = `${repo}#${commit}`;
          } else {
            srcUrl =
              gitPkgRefs[parsedGitKey.fullName]?.vcsUrl || parsedGitKey.gitSpec;
          }
        } else if (lockfileVersion >= 9 && fullName.includes("@")) {
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
            ({ group, name } = splitPnpmFilePackageName(
              fullName.replace(`@${srcUrl}`, ""),
            ));
            // The key names the path, not a version. pnpm copies the version
            // from the package's own manifest into its `packages` entry, and
            // that may carry semver build metadata (`2.0.0+local`).
            version = String(
              packages[pkgKeys[k]]?.version ||
                packages[fullName]?.version ||
                "",
            );
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
              purl: build({
                type: "npm",
                namespace: group || null,
                name: name,
                version: version || null,
              }),
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
          // The version segment of a lockfile 5 key carries the peer-dependency
          // resolution, eg /@wdio/utils/7.26.0_typescript@6.0.2. Normalising here,
          // before the purl exists, keeps `version`, `purl` and `bom-ref` in
          // agreement and keeps the bom-ref equal to the purl, which trimComponents
          // and dedupeBom both rely on.
          version = stripPnpmPeerSuffix(version);
          const gitEntry =
            gitPkgRefs[parsedGitKey?.fullName] ||
            gitPkgRefs[parsedGitKey?.packageName];
          const purlQualifiers = srcUrl
            ? buildNpmGitPurlQualifiers(srcUrl, group, npmrcConfig)
            : null;
          const purlString = build({
            type: "npm",
            namespace: group || null,
            name: name,
            version: version || null,
            qualifiers: purlQualifiers || null,
          });
          const bomRef = decodeURIComponent(purlString);
          if (
            packageNode.dev === true &&
            possibleDevelopmentDeps[bomRef] === undefined
          ) {
            possibleDevelopmentDeps[bomRef] = true;
          }
          const isBaseOptional = possibleOptionalDeps[bomRef];
          // optionalDependencies are tracked separately because they may still
          // be runtime-relevant and should keep the CycloneDX optional scope.
          // packageNode.dev captures explicit dev-only packages from the lock
          // entry, while possibleDevelopmentDeps lets that marking propagate to
          // transitive dependencies discovered through the dependency graph.
          const isBaseDevelopment =
            packageNode.dev === true ||
            possibleDevelopmentDeps[bomRef] === true;
          const deplist = [];
          for (let dpkgName of Object.keys(deps)) {
            let vers = deps[dpkgName];
            if (vers?.includes("(")) {
              vers = vers.split("(")[0];
            }
            // A value beginning with a "/" is never a version - it is an alias
            // pointing at another lock entry, which pnpm writes in its package-key
            // shape. The dual-published *-cjs shims are the common source of these,
            // and from lockfile v6 they lose the leading slash, so those are trusted
            // as aliases on the strength of the name alone.
            // Eg: '@wdio/utils-cjs': /@wdio/utils/7.26.0_typescript@6.0.2
            //     string-width-cjs: string-width@4.2.3
            const aliasRef =
              vers?.startsWith("/") || dpkgName.endsWith("-cjs")
                ? parsePnpmAliasRef(vers)
                : undefined;
            if (aliasRef) {
              dpkgName = aliasRef.name;
              vers = aliasRef.version;
            }
            // A dependency value carries the same peer-resolution suffix as the lock
            // key it points at, eg jest-cli: 25.5.1_jest-resolve@25.5.1. Stripping it
            // here is what keeps this ref equal to that package's bom-ref.
            vers = stripPnpmPeerSuffix(vers);
            if (vers.includes("file:") || vers.includes("link:")) {
              vers = await getVersionNumPnpm(vers.split("@").pop());
            }
            // With overrides version could be like this: @nolyfill/side-channel@1.0.29
            // An alias has already been split into its name and version, and its
            // version legitimately contains an @ when it carries a peer suffix, so
            // it must not be re-split here.
            if (!aliasRef && vers.includes("@")) {
              const overrideVersion = vers.split("@").pop();
              dpkgName = vers
                .replace(`@${overrideVersion}`, "")
                .replace(/^\//, "");
              vers = overrideVersion;
            }
            const dpurlString = npmPurl(dpkgName, vers);
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
            if (
              isBaseDevelopment &&
              possibleDevelopmentDeps[dbomRef] === undefined
            ) {
              possibleDevelopmentDeps[dbomRef] = true;
              _markTreeDevelopment(
                dbomRef,
                dependenciesMap,
                possibleDevelopmentDeps,
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
              name: "internal:SrcFile",
              value: pnpmLockSrcFile,
            },
          ];
          if (hasBin) {
            properties.push({
              name: "cdx:npm:has_binary",
              value: "true",
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
              name: `cdx:npm:${key}`,
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
          const purlNoVersion = build({
            type: "npm",
            namespace: group || null,
            name: name,
          });
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
                    value: pnpmLockSrcFile,
                  },
                ],
              },
            },
          };
          if (tarball) {
            thePkg.externalReferences = [
              {
                type: "distribution",
                url: tarball,
              },
            ];
          } else if (gitEntry?.externalReferences?.length) {
            thePkg.externalReferences = gitEntry.externalReferences;
          }
          if (possibleOptionalDeps[thePkg["bom-ref"]]) {
            setNpmOptionalProperty(thePkg);
          }
          // Don't add internal workspace packages to the components list
          if (thePkg.type !== "application") {
            if (pkgRefMap[theBomRef]) {
              continue;
            }
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
  // Repeat development dependency detection after the dependency graph is fully
  // built, since a single package iteration can encounter a dev-only component
  // before its own dependency list has been captured in dependenciesMap.
  for (const dependencyRef of Object.keys(possibleDevelopmentDeps)) {
    if (possibleDevelopmentDeps[dependencyRef] === true) {
      _markTreeDevelopment(
        dependencyRef,
        dependenciesMap,
        possibleDevelopmentDeps,
        {},
      );
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
    if (
      !requiredDependencies[apkg["bom-ref"]] &&
      possibleDevelopmentDeps[apkg["bom-ref"]]
    ) {
      if (!apkg.scope) {
        apkg.scope = "optional";
      }
      setNpmDevelopmentProperty(apkg);
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
      build({ type: "npm", namespace: apkg.group || null, name: apkg.name }),
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
        const purlObj = Purl.parse(apkg.purl);
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

  if (shouldFetchPackageMetadata() && pkgList?.length) {
    if (DEBUG_MODE) {
      console.log(
        `About to fetch npm registry metadata for ${pkgList.length} packages in parsePnpmLock`,
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
        license: resolveNpmLicense(pkgData) || "",
        properties: [
          {
            name: "internal:SrcFile",
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
  if (shouldFetchPackageMetadata() && pkgList?.length) {
    if (DEBUG_MODE) {
      console.log(
        `About to fetch npm registry metadata for ${pkgList.length} packages in parseBowerJson`,
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
                    name: "internal:SrcFile",
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
  if (shouldFetchPackageMetadata() && pkgList?.length) {
    if (DEBUG_MODE) {
      console.log(
        `About to fetch npm registry metadata for ${pkgList.length} packages in parseMinJs`,
      );
    }
    return await getNpmMetadata(pkgList);
  }
  return pkgList;
}

// taken from a very old package https://github.com/keithamus/parse-packagejson-name/blob/master/index.js
/**
 * Parse a package.json `name` field (or a plain string) and extract its scope,
 * full name, project name, and module name components.
 *
 * @param {string|Object} name The package name string or an object with a `name` property
 * @returns {{ scope: string|null, fullName: string, projectName: string|null, moduleName: string|null }}
 */
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
 * Helper to split a command line string into an array of arguments,
 * respecting single and double quotes.
 *
 * @param {String} commandString The full command line string
 * @returns {Array<String>} Array of tokens
 */
export function splitCommandArgs(commandString) {
  const args = [];
  let current = "";
  let inQuote = false;
  let quoteChar = "";
  let escaped = false;

  for (let i = 0; i < commandString.length; i++) {
    const char = commandString[i];
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (inQuote) {
      if (char === quoteChar) {
        inQuote = false;
      } else {
        current += char;
      }
    } else {
      if (char === '"' || char === "'") {
        inQuote = true;
        quoteChar = char;
      } else if (char === " " || char === "\t") {
        if (current.length > 0) {
          args.push(current);
          current = "";
        }
      } else {
        current += char;
      }
    }
  }
  if (current.length > 0) {
    args.push(current);
  }
  return args;
}
