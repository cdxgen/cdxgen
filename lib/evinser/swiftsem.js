import { readFileSync, realpathSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  win32,
} from "node:path";
import process from "node:process";

import { DEBUG_MODE, readEnvironmentVariable } from "../core/activity.js";
import { SWIFT_CMD } from "../core/env.js";
import {
  getAllFiles,
  getTmpDir,
  safeExistsSync,
  safeMkdtempSync,
  safeRmSync,
  safeSpawnSync,
} from "../core/fs.js";
import { isProjectToolingAllowed } from "../ecosystems/gradleutils.js";
import { splitCommandArgs } from "../ecosystems/parsers-js.js";
import { collectSwiftProductionTargets } from "../ecosystems/parsers-misc.js";
import { isInsideDir } from "../inventory/cmakeBuildDirs.js";
import { runSwiftCommand } from "../inventory/envcontext.js";
import { executeSourcekitten, probeSourcekitten } from "../managers/binary.js";

// Swift entity kinds
// https://github.com/swiftlang/swift/blob/main/tools/SourceKit/docs/SwiftSupport.txt
const SWIFT_ENTITY_KINDS = {
  IMPORT_CLANG: "source.lang.swift.import.module.clang",
  IMPORT_SWIFT: "source.lang.swift.import.module.swift",
  IMPORT_SOURCE: "source.lang.swift.import.sourcefile",
  DECL_EXTN_STRUCT: "source.lang.swift.decl.extension.struct",
  DECL_EXTN_CLASS: "source.lang.swift.decl.extension.class",
  DECL_EXTN_ENUM: "source.lang.swift.decl.extension.enum",
  DECL_FREE: "source.lang.swift.decl.function.free",
  REF_FREE: "source.lang.swift.ref.function.free",
  DECL_METHOD_INSTANCE: "source.lang.swift.decl.function.method.instance",
  REF_METHOD_INSTANCE: "source.lang.swift.ref.function.method.instance",
  DECL_METHOD_STATIC: "source.lang.swift.decl.function.method.static",
  REF_METHOD_STATIC: "source.lang.swift.ref.function.method.static",
  DECL_CONSTRUCTOR: "source.lang.swift.decl.function.constructor",
  REF_CONSTRUCTOR: "source.lang.swift.ref.function.constructor",
  DECL_DESTRUCTOR: "source.lang.swift.decl.function.destructor",
  REF_DESTRUCTOR: "source.lang.swift.ref.function.destructor",
  DECL_OPERATOR: "source.lang.swift.decl.function.operator",
  REF_OPERATOR: "source.lang.swift.ref.function.operator",
  DECL_SUBSCRIPT: "source.lang.swift.decl.function.subscript",
  REF_SUBSCRIPT: "source.lang.swift.ref.function.subscript",
  DECL_GETTER: "source.lang.swift.decl.function.accessor.getter",
  REF_GETTER: "source.lang.swift.ref.function.accessor.getter",
  DECL_SETTER: "source.lang.swift.decl.function.accessor.setter",
  REF_SETTER: "source.lang.swift.ref.function.accessor.setter",
  DECL_CLASS: "source.lang.swift.decl.class",
  REF_CLASS: "source.lang.swift.ref.class",
  DECL_STRUCT: "source.lang.swift.decl.struct",
  REF_STRUCT: "source.lang.swift.ref.struct",
  DECL_ENUM: "source.lang.swift.decl.enum",
  REF_ENUM: "source.lang.swift.ref.enum",
  DECL_ENUM_ELEMENT: "source.lang.swift.decl.enumelement",
  REF_ENUM_ELEMENT: "source.lang.swift.ref.enumelement",
  DECL_PROTOCOL: "source.lang.swift.decl.protocol",
  REF_PROTOCOL: "source.lang.swift.ref.protocol",
  DECL_TYPE_ALIAS: "source.lang.swift.decl.typealias",
  REF_TYPE_ALIAS: "source.lang.swift.ref.typealias",
  DECL_VAR_GLOBAL: "source.lang.swift.decl.var.global",
  REF_VAR_GLOBAL: "source.lang.swift.ref.var.global",
  DECL_VAR_INSTANCE: "source.lang.swift.decl.var.instance",
  REF_VAR_INSTANCE: "source.lang.swift.ref.var.instance",
  DECL_VAR_STATIC: "source.lang.swift.decl.var.static",
  REF_VAR_STATIC: "source.lang.swift.ref.var.static",
  DECL_VAR_LOCAL: "source.lang.swift.decl.var.local",
  REF_VAR_LOCAL: "source.lang.swift.ref.var.local",
};

// Array of standard types that can be ignored
const IGNORABLE_TYPES = [
  "Bool",
  "Error?",
  "AnyObject",
  "()",
  "Any?",
  "Void",
  "[String]",
  "String?",
  "String",
];

// The Swift Build engine (default from Swift 6.4) writes per-target output
// file maps named `<target>-OutputFileMap.json` under
// `.build/out/Intermediates.noindex/`, while the llbuild engine writes
// `output-file-map.json` files next to the module artifacts.
const SWIFT_BUILD_FILEMAP_SUFFIX = "-OutputFileMap.json";
// SwiftPM turns target names into module names by replacing every character
// that is not valid in a C identifier with an underscore.
const NON_IDENTIFIER_CHARS = /[^A-Za-z0-9_]/g;
// Build logs and descriptions on Windows can mix both separators
const PATH_SEPARATORS = /[\\/]/;

/**
 * Convert a SwiftPM target or package name into its module name.
 *
 * @param {String} name Target or package name
 * @returns {String} Module name
 */
export function toModuleName(name) {
  return (name || "").replace(NON_IDENTIFIER_CHARS, "_");
}

/**
 * Decide whether a module belongs to tests or to an aggregate product and so
 * must not contribute build symbols or semantic context.
 *
 * @param {String} moduleName Module name
 * @returns {boolean} `true` when the module should be skipped
 */
export function isTestOrAggregateModule(moduleName) {
  return (
    !moduleName ||
    moduleName.endsWith("Tests") ||
    moduleName.endsWith("PackageTests") ||
    moduleName.endsWith("_test_runner") ||
    moduleName.endsWith("-test-runner") ||
    moduleName.endsWith("_product") ||
    moduleName.endsWith("-product")
  );
}

/**
 * Spawn the configured swift command in a directory. `SWIFT_CMD` may carry a
 * prefix such as `xcrun swift`.
 *
 * @param {String} basePath Working directory
 * @param {Array<String>} args Arguments
 * @param {Object} [spawnOptions] Extra spawn options, e.g. `input`
 * @returns {Object} spawn result
 */
function spawnSwift(basePath, args, spawnOptions = {}) {
  const [command, ...prefixArgs] = SWIFT_CMD.trim().split(" ");
  return safeSpawnSync(command, [...prefixArgs, ...args], {
    cwd: basePath,
    ...spawnOptions,
  });
}

/**
 * Parse the JSON printed by `swift -print-target-info`.
 *
 * `paths.runtimeResourcePath` is `<toolchain>/usr/lib/swift` for every
 * toolchain layout (Xcode, `.xctoolchain` bundles, swiftly, Linux tarballs),
 * so it names the toolchain that actually compiles the project.
 * `paths.sdkPath` is the SDK the driver selected, on macOS through `SDKROOT`
 * or `xcrun`; it is absent when no SDK applies, as on Linux.
 *
 * @param {Object} targetInfo Parsed `-print-target-info` output
 * @returns {undefined|Object} `{ compilerVersion, triple, runtimeResourcePath, sdkPath, toolchainDir }`
 */
export function parseSwiftTargetInfo(targetInfo) {
  const runtimeResourcePath = targetInfo?.paths?.runtimeResourcePath;
  if (!runtimeResourcePath) {
    return undefined;
  }
  const libDir = dirname(runtimeResourcePath);
  const usrDir = dirname(libDir);
  const toolchainDir =
    basename(runtimeResourcePath) === "swift" &&
    basename(libDir) === "lib" &&
    basename(usrDir) === "usr"
      ? dirname(usrDir)
      : undefined;
  return {
    compilerVersion: targetInfo.compilerVersion,
    triple: targetInfo.target?.triple,
    runtimeResourcePath,
    sdkPath: targetInfo.paths.sdkPath,
    toolchainDir,
  };
}

const swiftToolchainCache = new Map();

/**
 * Identify the toolchain that `swift` resolves to inside a project directory.
 *
 * The query runs in the project directory because toolchain managers such as
 * swiftly select the toolchain per directory (`.swift-version`), so the
 * compiler that builds a project can differ from the one on the PATH of the
 * calling process.
 *
 * @param {String} basePath Project directory
 * @returns {undefined|Object} Toolchain details, see parseSwiftTargetInfo
 */
export function resolveSwiftToolchain(basePath) {
  const cacheKey = basePath || process.cwd();
  if (swiftToolchainCache.has(cacheKey)) {
    return swiftToolchainCache.get(cacheKey);
  }
  let toolchain;
  const result = spawnSwift(basePath, ["-print-target-info"]);
  if (result?.status === 0 && result.stdout) {
    try {
      toolchain = parseSwiftTargetInfo(JSON.parse(result.stdout));
    } catch (_e) {
      toolchain = undefined;
    }
  }
  swiftToolchainCache.set(cacheKey, toolchain);
  return toolchain;
}

/**
 * Environment overrides that make sourcekitten load the SourceKit of the
 * toolchain that builds the project.
 *
 * Without guidance sourcekitten uses the toolchain of the selected Xcode (or
 * the `swift` found on the PATH on Linux). SourceKit cannot load modules
 * produced by a different compiler version, so every reference to a
 * dependency then goes unresolved. On macOS sourcekitten honours
 * `XCODE_DEFAULT_TOOLCHAIN_OVERRIDE` ahead of `xcrun`; on Linux it honours
 * `LINUX_SOURCEKIT_LIB_PATH`. Explicitly configured values always win.
 *
 * @param {Object} toolchain Toolchain details from resolveSwiftToolchain
 * @param {String} [platform] Platform name, defaults to process.platform
 * @returns {undefined|Object} Environment overrides for sourcekitten
 */
export function sourcekittenEnvForToolchain(
  toolchain,
  platform = process.platform,
) {
  const toolchainDir = toolchain?.toolchainDir;
  if (!toolchainDir) {
    return undefined;
  }
  if (platform === "darwin") {
    if (
      readEnvironmentVariable("XCODE_DEFAULT_TOOLCHAIN_OVERRIDE") ||
      readEnvironmentVariable("TOOLCHAIN_DIR")
    ) {
      return undefined;
    }
    // sourcekitten loads the in-process SourceKit of `.xctoolchain` bundles
    // and of the Command Line Tools alike. Open-source toolchains before
    // Swift 6.1 do not ship it; sourcekitten then falls back to the Xcode
    // toolchain, which cannot load the modules of this build
    if (
      !safeExistsSync(
        join(toolchainDir, "usr", "lib", "sourcekitdInProc.framework"),
      )
    ) {
      console.log(
        `The Swift toolchain at ${toolchainDir} has no sourcekitdInProc.framework, so sourcekitten cannot use it. Swift evidence will be limited to import declarations; build with Swift 6.1 or later, or with Xcode.`,
      );
      return undefined;
    }
    return { XCODE_DEFAULT_TOOLCHAIN_OVERRIDE: toolchainDir };
  }
  if (platform === "linux") {
    const libDir = join(toolchainDir, "usr", "lib");
    if (
      readEnvironmentVariable("LINUX_SOURCEKIT_LIB_PATH") ||
      !safeExistsSync(join(libDir, "libsourcekitdInProc.so"))
    ) {
      return undefined;
    }
    return { LINUX_SOURCEKIT_LIB_PATH: libDir };
  }
  return undefined;
}

/**
 * Retrieve the structure information of a .swift file in json format
 *
 * @param {String} filePath Path to .swift file
 * @param {Object} [env] Environment overrides for sourcekitten
 *
 * @returns {undefined|Object} JSON representation of the swift file or undefined.
 */
export function getStructure(filePath, env) {
  return executeSourcekitten(["structure", "--file", filePath], env);
}

/**
 * Parse the data from the structure command
 *
 * @param {Object} structureJson Json from the structure command
 * @returns {Object|undefined} Parsed value
 */
export function parseStructure(structureJson) {
  if (
    structureJson?.["key.diagnostic_stage"] !==
      "source.diagnostic.stage.swift.parse" ||
    !structureJson["key.substructure"]
  ) {
    return undefined;
  }
  const metadata = {};
  const refTypes = new Set();
  collectStructureTypes(structureJson["key.substructure"], refTypes);
  if (refTypes.size) {
    metadata["referredTypes"] = Array.from(refTypes).sort();
  }
  return metadata;
}

/**
 * Recursively collect referred types from the sub-structure
 *
 * @param substructures {Object} Sub structures
 * @param refTypes {Set<String>} Identified reference types
 */
function collectStructureTypes(substructures, refTypes) {
  if (!substructures || !Array.isArray(substructures)) {
    return;
  }
  for (const asubstruct of substructures) {
    if (
      asubstruct["key.typename"] &&
      !IGNORABLE_TYPES.includes(asubstruct["key.typename"])
    ) {
      refTypes.add(asubstruct["key.typename"]);
    }
    if (asubstruct["key.inheritedtypes"]) {
      for (const inheritedType of asubstruct["key.inheritedtypes"]) {
        if (!IGNORABLE_TYPES.includes(inheritedType["key.name"])) {
          refTypes.add(inheritedType["key.name"]);
        }
      }
    }
    // Recurse
    if (asubstruct["key.substructure"]) {
      collectStructureTypes(asubstruct["key.substructure"], refTypes);
    }
  }

  if (substructures["key.substructure"]) {
    collectStructureTypes(substructures["key.substructure"], refTypes);
  }
}

/**
 * Split a Swift command line, as printed by a verbose build or given in an
 * environment variable, into arguments.
 *
 * Paths on Windows use backslash separators, so a backslash there is literal
 * unless it precedes a double quote (the `CommandLineToArgvW` rules). Single
 * quotes, which SwiftPM uses to quote arguments on every platform, keep their
 * content literal. Elsewhere shell quoting applies.
 *
 * @param {String} commandString Command line
 * @param {String} [platform] Platform name, defaults to process.platform
 * @returns {Array<String>} Arguments
 */
export function splitSwiftCommandArgs(
  commandString,
  platform = process.platform,
) {
  const text = commandString || "";
  if (platform !== "win32") {
    return splitCommandArgs(text);
  }
  const args = [];
  let current = "";
  let hasArg = false;
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote === "'") {
      if (char === "'") {
        quote = "";
      } else {
        current += char;
      }
      continue;
    }
    if (char === "\\") {
      let count = 1;
      while (text[i + count] === "\\") {
        count++;
      }
      hasArg = true;
      if (text[i + count] !== '"') {
        current += "\\".repeat(count);
        i += count - 1;
        continue;
      }
      current += "\\".repeat(Math.floor(count / 2));
      if (count % 2) {
        current += '"';
        i += count;
      } else {
        i += count - 1;
      }
      continue;
    }
    if (char === '"' || (char === "'" && !quote)) {
      quote = quote ? "" : char;
      hasArg = true;
      continue;
    }
    if (!quote && (char === " " || char === "\t")) {
      if (hasArg) {
        args.push(current);
        current = "";
        hasArg = false;
      }
      continue;
    }
    current += char;
    hasArg = true;
  }
  if (hasArg) {
    args.push(current);
  }
  return args;
}

/**
 * Method to perform swift build in verbose mode.
 *
 * `SWIFT_BUILD_ARGS` adds arguments to the build, for example
 * `--build-system native` to use the llbuild engine with Swift 6.4.
 *
 * @param {String} basePath Path
 * @returns {undefined|String} Verbose build output
 */
export function verboseBuild(basePath) {
  runSwiftCommand(basePath, ["package", "clean"]);
  console.log("Extracting compiler arguments from swift build...");
  const buildArgs = ["build", "-c", "debug", "--verbose", "-Xcc", "-Wno-error"];
  const extraBuildArgs = readEnvironmentVariable("SWIFT_BUILD_ARGS");
  if (extraBuildArgs) {
    buildArgs.push(...splitSwiftCommandArgs(extraBuildArgs));
  }
  return runSwiftCommand(basePath, buildArgs);
}

// Compiler arguments followed by a single value that sourcekitten needs to
// type-check a module's sources exactly as the compiler did
const SWIFT_ARGS_WITH_VALUE = new Set([
  "-sdk",
  "-target",
  "-target-variant",
  "-swift-version",
  "-language-mode",
  "-module-name",
  "-package-name",
  "-I",
  "-F",
  "-Isystem",
  "-Fsystem",
  "-vfsoverlay",
  "-plugin-path",
  "-external-plugin-path",
  "-load-plugin-executable",
  "-load-plugin-library",
  "-in-process-plugin-server-path",
  "-enable-upcoming-feature",
  "-enable-experimental-feature",
  "-disable-upcoming-feature",
  "-disable-experimental-feature",
  "-Xcc",
]);
// Compiler arguments that apply to the whole module, typically single-value
// flags whose value appears once per line (`-module-cache-path` is replaced by
// a private cache)
const SWIFT_SINGLE_VALUE_ARGS = new Set([
  "-sdk",
  "-target",
  "-target-variant",
  "-swift-version",
  "-language-mode",
  "-module-name",
  "-package-name",
]);
const SWIFT_BOOL_ARGS = new Set([
  "-parse-as-library",
  "-enable-testing",
  "-application-extension",
  "-enable-library-evolution",
  "-enable-bare-slash-regex",
  "-warn-concurrency",
  "-suppress-warnings",
]);
// Frontend flags that change how sources are type-checked (macros, language
// features) and so are kept when passed through `-Xfrontend`
const SWIFT_FRONTEND_ARGS_WITH_VALUE = new Set([
  "-load-plugin-executable",
  "-load-plugin-library",
  "-plugin-path",
  "-external-plugin-path",
  "-enable-upcoming-feature",
  "-enable-experimental-feature",
]);
// Pass-through flags whose value belongs to another tool
const SWIFT_PASSTHROUGH_ARGS = new Set([
  "-Xfrontend",
  "-Xllvm",
  "-Xlinker",
  "-Xclang-linker",
]);

/**
 * Reduce one module's compiler invocation to the arguments that affect how
 * its sources are type-checked.
 *
 * Only known argument classes are kept, so outputs, incremental build
 * bookkeeping, response files, and flags a SourceKit build may not know are
 * dropped. The order of the kept arguments is preserved, which keeps paired
 * clang arguments such as `-Xcc -I -Xcc <path>` intact. The module cache is
 * dropped as well: the build's cache may hold modules of other toolchains.
 *
 * @param {Array<String>} tokens Tokenized compiler invocation
 * @returns {Array<String>} Sanitized compiler arguments
 */
export function sanitizeSwiftModuleArgs(tokens) {
  const args = [];
  const seenPairs = new Set();
  const seenSingles = new Set();
  const pushPair = (flag, value) => {
    // Repeated include paths are harmless but noisy; `-Xcc` values are
    // positional (`-Xcc -I -Xcc <path>`) and must never be de-duplicated
    if (flag !== "-Xcc") {
      const key = `${flag}\u0000${value}`;
      if (seenPairs.has(key)) {
        return;
      }
      seenPairs.add(key);
    }
    args.push(flag, value);
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (SWIFT_PASSTHROUGH_ARGS.has(token)) {
      const value = tokens[i + 1];
      i++;
      if (token !== "-Xfrontend" || !value) {
        continue;
      }
      if (SWIFT_FRONTEND_ARGS_WITH_VALUE.has(value)) {
        if (tokens[i + 1] === "-Xfrontend" && tokens[i + 2] !== undefined) {
          args.push("-Xfrontend", value, "-Xfrontend", tokens[i + 2]);
          i += 2;
        }
      } else if (value.startsWith("-strict-concurrency=")) {
        args.push("-Xfrontend", value);
      }
      continue;
    }
    if (SWIFT_ARGS_WITH_VALUE.has(token)) {
      const value = tokens[i + 1];
      i++;
      if (value === undefined) {
        continue;
      }
      if (SWIFT_SINGLE_VALUE_ARGS.has(token)) {
        if (seenSingles.has(token)) {
          continue;
        }
        seenSingles.add(token);
      }
      pushPair(token, value);
      continue;
    }
    if (SWIFT_BOOL_ARGS.has(token)) {
      if (!seenSingles.has(token)) {
        seenSingles.add(token);
        args.push(token);
      }
      continue;
    }
    if (token.startsWith("-strict-concurrency=")) {
      args.push(token);
      continue;
    }
    if (token === "-D" && tokens[i + 1] !== undefined) {
      pushPair("-D", tokens[i + 1]);
      i++;
      continue;
    }
    // Joined forms: -DFOO, -I/path, -F/path
    if (token.length > 2 && ["-D", "-I", "-F"].includes(token.slice(0, 2))) {
      if (!token.startsWith("-Isystem") && !token.startsWith("-Fsystem")) {
        pushPair(token.slice(0, 2), token.slice(2));
      }
    }
  }
  return args;
}

// Compiler arguments that load code into the compiler or the SourceKit
// service: macro plugins and their search paths, the SDK (on macOS the driver
// derives the external plugin directory and the plugin server executable
// from `<Developer>/SDKs/<name>.sdk`, two levels up), virtual file system
// overlays (they can redirect any of these paths), and the clang arguments
// (`-Xcc -fplugin=...`) behind -Xcc.
const SWIFT_CODE_LOADING_ARGS = new Set([
  "-sdk",
  "-vfsoverlay",
  "-plugin-path",
  "-external-plugin-path",
  "-load-plugin-executable",
  "-load-plugin-library",
  "-in-process-plugin-server-path",
  "-Xcc",
]);

/**
 * Remove the arguments that would make SourceKit load code named by the
 * project. A `.build` directory that cdxgen did not create is project content,
 * so the compiler arguments read from it are cleaned this way whenever the
 * project's own tooling may not run. The project's SDK is replaced with the
 * SDK of the host toolchain when one is known, and dropped otherwise.
 *
 * @param {Array<String>} args Sanitized compiler arguments
 * @param {String} [sdkPath] Host SDK that takes the place of the project's
 * @returns {Array<String>} Arguments without plugin and clang pass-through flags
 */
export function withoutSwiftPluginArgs(args, sdkPath) {
  const kept = [];
  for (let i = 0; i < (args || []).length; i++) {
    const token = args[i];
    // Walk the argument groups as sanitizeSwiftModuleArgs wrote them, so that
    // a value is never taken for a flag: dropping a value together with its
    // neighbour would shift the list and turn a later value into an option
    let flag = token;
    let size = 1;
    if (token === "-Xfrontend") {
      // -Xfrontend <flag> [-Xfrontend <value>]
      flag = args[i + 1];
      size =
        SWIFT_FRONTEND_ARGS_WITH_VALUE.has(flag) && args[i + 2] === "-Xfrontend"
          ? 4
          : 2;
    } else if (SWIFT_ARGS_WITH_VALUE.has(token) || token === "-D") {
      size = 2;
    }
    const group = args.slice(i, i + size);
    i += group.length - 1;
    // A response file (`@<path>`) in a value position would let the project
    // name any argument, including the ones removed here
    if (
      SWIFT_CODE_LOADING_ARGS.has(flag) ||
      group.some((v) => String(v).startsWith("@"))
    ) {
      if (flag === "-sdk" && sdkPath) {
        kept.push("-sdk", sdkPath);
      }
      continue;
    }
    kept.push(...group);
  }
  return kept;
}

/**
 * Read the sources listed in a response or file-list file (`@<path>`), one
 * path per line.
 *
 * @param {String} listFile File list path
 * @param {String} [platform] Platform that wrote the list
 * @returns {Array<String>} Swift source paths
 */
function readSourceList(listFile, platform = process.platform) {
  if (!listFile || !safeExistsSync(listFile)) {
    return [];
  }
  try {
    return readFileSync(listFile, { encoding: "utf-8" })
      .split("\n")
      .map((l) => splitSwiftCommandArgs(l.trim(), platform)[0])
      .filter((l) => l?.endsWith(".swift"));
  } catch (_e) {
    return [];
  }
}

/**
 * Extract the per-module compiler invocations printed by a verbose swift
 * build.
 *
 * Both engines print one driver invocation per module that carries
 * `-module-name`: llbuild prints `swiftc ... -module-name X ... @sources`,
 * while the Swift Build engine prints `builtin-SwiftDriver -- swiftc ...
 * -module-name X ... @<target>.SwiftFileList`. llbuild also prints the
 * frontend jobs of each module, which are only used when no driver line is
 * found. Package manifest and plugin compilations are skipped.
 *
 * @param {String} buildOutput Verbose build output
 * @param {String} [platform] Platform that printed the output, which decides
 *   its quoting rules; defaults to process.platform
 * @returns {Object} Map of module name to `{ args, sources, isDriver }`
 */
export function parseSwiftModuleInvocations(
  buildOutput,
  platform = process.platform,
) {
  const isAbsolutePath =
    platform === "win32" ? win32.isAbsolute : posix.isAbsolute;
  const modules = {};
  for (const rawLine of (buildOutput || "").split("\n")) {
    const line = rawLine.trim();
    if (!line.includes("swiftc") && !line.includes("swift-frontend")) {
      continue;
    }
    if (!line.includes("-module-name")) {
      continue;
    }
    const tokens = splitSwiftCommandArgs(line, platform);
    const nameIndex = tokens.indexOf("-module-name");
    const moduleName = tokens[nameIndex + 1];
    if (
      !moduleName ||
      tokens.includes("-package-description-version") ||
      tokens.includes("-plugin-description-version")
    ) {
      continue;
    }
    const isDriver = !tokens.includes("-frontend");
    const sources = new Set();
    for (const token of tokens) {
      if (token.startsWith("@")) {
        for (const src of readSourceList(token.slice(1), platform)) {
          sources.add(src);
        }
      } else if (token.endsWith(".swift") && isAbsolutePath(token)) {
        sources.add(token);
      }
    }
    const existing = modules[moduleName];
    // Prefer the driver invocation, then the longest frontend job
    if (
      existing &&
      (existing.isDriver > isDriver ||
        (existing.isDriver === isDriver && existing.length >= tokens.length))
    ) {
      for (const src of sources) {
        if (!existing.sources.includes(src)) {
          existing.sources.push(src);
        }
      }
      continue;
    }
    const mergedSources = new Set([...(existing?.sources || []), ...sources]);
    modules[moduleName] = {
      args: sanitizeSwiftModuleArgs(tokens),
      sources: Array.from(mergedSources),
      isDriver,
      length: tokens.length,
    };
  }
  for (const amodule of Object.values(modules)) {
    delete amodule.length;
  }
  return modules;
}

/**
 * Parse the llbuild engine's build description
 * (`.build/<triple>/debug/description.json`).
 *
 * Its `swiftCommands` record every Swift module the build compiled, with the
 * exact source list and compiler arguments. Host-tool variants
 * (`...-tool.module`, built for macros and plugins) are used only when a
 * module has no regular variant.
 *
 * @param {Object} descriptionJson Parsed description.json
 * @returns {Object} Map of module name to `{ args, sources, isDriver }`
 */
export function parseSwiftBuildDescription(descriptionJson) {
  const modules = {};
  const toolVariants = new Set();
  for (const [key, command] of Object.entries(
    descriptionJson?.swiftCommands || {},
  )) {
    const moduleName = command?.moduleName;
    if (!moduleName) {
      continue;
    }
    const isTool = key.endsWith("-tool.module");
    if (modules[moduleName] && (isTool || !toolVariants.has(moduleName))) {
      continue;
    }
    const tokens = [
      "-module-name",
      moduleName,
      ...(command.otherArguments || []),
    ];
    if (command.importPath) {
      tokens.push("-I", command.importPath);
    }
    modules[moduleName] = {
      args: sanitizeSwiftModuleArgs(tokens),
      sources: (command.sources || []).filter((s) => s.endsWith(".swift")),
      isDriver: true,
    };
    if (isTool) {
      toolVariants.add(moduleName);
    } else {
      toolVariants.delete(moduleName);
    }
  }
  return modules;
}

// Clang argument groups: a flag and the separate value that follows it
const CLANG_ARGS_WITH_SEPARATE_VALUE = new Set([
  "-I",
  "-F",
  "-D",
  "-U",
  "-isystem",
  "-iquote",
  "-idirafter",
  "-include",
  "-iframework",
  "-ivfsoverlay",
  "-working-directory",
  "-Xclang",
  "-target",
]);

/**
 * Split a list of `-Xcc` values into clang argument groups so that repeated
 * groups can be dropped without separating a flag from its value.
 *
 * @param {Array<String>} values `-Xcc` values in order
 * @returns {Array<Array<String>>} Clang argument groups
 */
function groupClangArgs(values) {
  const groups = [];
  for (let i = 0; i < values.length; i++) {
    if (
      CLANG_ARGS_WITH_SEPARATE_VALUE.has(values[i]) &&
      i + 1 < values.length
    ) {
      groups.push([values[i], values[i + 1]]);
      i++;
    } else {
      groups.push([values[i]]);
    }
  }
  return groups;
}

/**
 * Merge the sanitized arguments of several modules into one argument list,
 * used when a source file cannot be attributed to a single module. The first
 * module's single-value flags win, include paths accumulate, and `-Xcc`
 * values are merged per clang argument group.
 *
 * @param {Array<Array<String>>} argLists Sanitized argument lists, most relevant first
 * @returns {Array<String>} Merged arguments
 */
export function mergeSwiftModuleArgs(argLists) {
  const merged = [];
  const seen = new Set();
  const seenSingles = new Set();
  const clangGroups = [];
  const seenClangGroups = new Set();
  for (const args of argLists) {
    const xccValues = [];
    for (let i = 0; i < args.length; i++) {
      const token = args[i];
      if (token === "-Xcc") {
        xccValues.push(args[i + 1]);
        i++;
        continue;
      }
      if (SWIFT_ARGS_WITH_VALUE.has(token) || token === "-D") {
        const value = args[i + 1];
        i++;
        if (token === "-module-name") {
          continue;
        }
        if (SWIFT_SINGLE_VALUE_ARGS.has(token)) {
          if (seenSingles.has(token)) {
            continue;
          }
          seenSingles.add(token);
        }
        const key = `${token}\u0000${value}`;
        if (!seen.has(key)) {
          seen.add(key);
          merged.push(token, value);
        }
        continue;
      }
      if (token === "-Xfrontend") {
        // -Xfrontend groups were validated while sanitizing
        const group = [token, args[i + 1]];
        i++;
        if (
          SWIFT_FRONTEND_ARGS_WITH_VALUE.has(group[1]) &&
          args[i + 1] === "-Xfrontend"
        ) {
          group.push(args[i + 1], args[i + 2]);
          i += 2;
        }
        const key = group.join("\u0000");
        if (!seen.has(key)) {
          seen.add(key);
          merged.push(...group);
        }
        continue;
      }
      if (!seen.has(token)) {
        seen.add(token);
        merged.push(token);
      }
    }
    for (const group of groupClangArgs(xccValues)) {
      const key = group.join("\u0000");
      if (!seenClangGroups.has(key)) {
        seenClangGroups.add(key);
        clangGroups.push(group);
      }
    }
  }
  for (const group of clangGroups) {
    for (const value of group) {
      merged.push("-Xcc", value);
    }
  }
  return merged;
}

/**
 * Method to parse the verbose swift build output to identify key compiler
 * parameters. The arguments of the root package's modules are merged, or of
 * every module when the root modules are unknown.
 *
 * @param {String} buildOutput Verbose build output
 * @param {Array<String>|Set<String>} [rootModules] Module names of the root package
 * @returns {Object} `{ params, compilerArgs }` where params maps module names to their arguments
 */
export function extractCompilerParamsFromBuild(buildOutput, rootModules) {
  if (!buildOutput) {
    console.log("No build output. Returning empty compilerArgs");
    return { params: {}, compilerArgs: [] };
  }
  const invocations = parseSwiftModuleInvocations(buildOutput);
  const rootSet = new Set(rootModules || []);
  let selected = Object.keys(invocations).filter((m) => rootSet.has(m));
  if (!selected.length) {
    selected = Object.keys(invocations);
  }
  selected.sort(
    (a, b) => invocations[b].args.length - invocations[a].args.length,
  );
  const compilerArgs = [];
  if (process?.env?.SWIFT_COMPILER_EXTRA_ARGS) {
    compilerArgs.push(
      ...splitSwiftCommandArgs(process.env.SWIFT_COMPILER_EXTRA_ARGS),
    );
  }
  compilerArgs.push(
    ...mergeSwiftModuleArgs(selected.map((m) => invocations[m].args)),
  );
  const params = {};
  for (const m of selected) {
    params[m] = invocations[m].args;
  }
  return { params, compilerArgs };
}

/**
 * Method to index a swift file and extract metadata
 *
 * @param {String} filePath Path to .swift file
 * @param {String|Array<string>} compilerArgs Compiler arguments. They should
 *   list every source of the file's module so that references across files
 *   resolve; the file itself is appended when missing.
 * @param {Object} [env] Environment overrides for sourcekitten
 * @returns {undefined|Object} metadata
 */
export function index(filePath, compilerArgs, env) {
  const skArgs = ["index", "--file", filePath];
  const args = Array.isArray(compilerArgs)
    ? compilerArgs
    : compilerArgs
      ? splitSwiftCommandArgs(compilerArgs)
      : [];
  skArgs.push("--", ...args);
  if (!args.includes(filePath)) {
    skArgs.push(filePath);
  }
  return executeSourcekitten(skArgs, env);
}

/**
 * Parse the data from the index command
 *
 * Besides the symbol names and lines, the unified symbol resolution (USR) of
 * every indexed entity is recorded with its lines. A USR identifies the
 * declaration the compiler resolved a reference to, including the module
 * that declares it, which is what attributes a usage to a dependency.
 *
 * @param {Object} indexJson Json from the index command
 * @returns {Object|undefined} Parsed value
 */
export function parseIndex(indexJson) {
  if (!indexJson) {
    return undefined;
  }
  // Some modules can be in both swift and clang
  const swiftModules = new Set();
  const clangModules = new Set();
  collectIndexedModules(
    indexJson["key.dependencies"],
    swiftModules,
    clangModules,
  );
  // Maps the given symbols with this obfuscated version
  const obfuscatedSymbols = {};
  // Line numbers where the given symbols are found
  const symbolLocations = {};
  // Line numbers of every resolved entity, keyed by its USR
  const usrLines = {};
  buildIndexedObfuscatedSymbols(
    indexJson["key.entities"],
    obfuscatedSymbols,
    symbolLocations,
    usrLines,
  );
  return {
    swiftModules: Array.from(swiftModules).sort(),
    clangModules: Array.from(clangModules).sort(),
    obfuscatedSymbols,
    symbolLocations,
    usrLines,
  };
}

/**
 * Recursively collect the swift and llvm modules from the index data
 *
 * @param dependencies {Array} dependencies array as per the index command
 * @param swiftModules {Set<String>} Swift modules used
 * @param clangModules {Set<String>} clang modules
 */
function collectIndexedModules(dependencies, swiftModules, clangModules) {
  for (const adep of dependencies || []) {
    if (adep["key.kind"] === SWIFT_ENTITY_KINDS.IMPORT_SWIFT) {
      swiftModules.add(adep["key.name"]);
    } else if (adep["key.kind"] === SWIFT_ENTITY_KINDS.IMPORT_CLANG) {
      clangModules.add(adep["key.name"]);
    }
    if (adep["key.dependencies"]) {
      collectIndexedModules(
        adep["key.dependencies"],
        swiftModules,
        clangModules,
      );
    }
  }
}

/**
 * Recursively collect the obfuscated symbols from the index data
 *
 * @param entities {Array} Entities found in the index data
 * @param obfuscatedSymbols {Object} Obfuscated symbols map
 * @param symbolLocations {Object} Symbol locations
 * @param usrLines {Object} Lines of each USR
 */
function buildIndexedObfuscatedSymbols(
  entities,
  obfuscatedSymbols,
  symbolLocations,
  usrLines,
) {
  if (!entities) {
    return;
  }
  for (const aentity of entities) {
    if (aentity["key.name"] && aentity["key.usr"]) {
      obfuscatedSymbols[aentity["key.name"]] = aentity["key.usr"];
    }
    if (aentity["key.line"]) {
      if (aentity["key.usr"]) {
        if (!usrLines[aentity["key.usr"]]) {
          usrLines[aentity["key.usr"]] = [];
        }
        if (!usrLines[aentity["key.usr"]].includes(aentity["key.line"])) {
          usrLines[aentity["key.usr"]].push(aentity["key.line"]);
        }
      }
      const symbolLocationsKey = aentity["key.name"] || aentity["key.usr"];
      if (symbolLocationsKey) {
        if (
          !symbolLocations[symbolLocationsKey] ||
          !Array.isArray(symbolLocations[symbolLocationsKey])
        ) {
          symbolLocations[symbolLocationsKey] = [];
        }
        if (
          !symbolLocations[symbolLocationsKey].includes(aentity["key.line"])
        ) {
          symbolLocations[symbolLocationsKey].push(aentity["key.line"]);
        }
      }
    }
    if (aentity["key.entities"]) {
      buildIndexedObfuscatedSymbols(
        aentity["key.entities"],
        obfuscatedSymbols,
        symbolLocations,
        usrLines,
      );
    }
  }
}

// Declaration qualifiers the demangler prints ahead of the qualified name
const DEMANGLED_QUALIFIERS = new Set([
  "static",
  "class",
  "mutating",
  "nonmutating",
  "__owned",
  "__shared",
  "__consuming",
  "borrowing",
  "consuming",
  "dynamic",
  "distributed",
  "nonisolated",
  "isolated",
]);

function isIdentifierChar(char) {
  return (
    (char >= "a" && char <= "z") ||
    (char >= "A" && char <= "Z") ||
    (char >= "0" && char <= "9") ||
    char === "_"
  );
}

/**
 * Identify the module that declares an entity from its demangled name.
 *
 * Qualified names start with the module (`Yams.dump(object:...)`), and
 * members declared in extensions carry the extending module
 * (`(extension in Yams):Swift.String.yaml`), which is what a usage of the
 * member depends on.
 *
 * @param {String} demangled Output of `swift demangle --compact`
 * @returns {undefined|String} Module name
 */
export function moduleFromDemangledName(demangled) {
  let text = (demangled || "").trim();
  if (!text || text.startsWith("$")) {
    return undefined;
  }
  for (let round = 0; round < 4; round++) {
    const space = text.indexOf(" ");
    if (space > 0 && DEMANGLED_QUALIFIERS.has(text.slice(0, space))) {
      text = text.slice(space + 1);
      continue;
    }
    // Descriptions such as `default argument 0 of X` or
    // `variable initialization expression of X`
    const of = text.indexOf(" of ");
    const prefix = of > 0 ? text.slice(0, of) : "";
    if (prefix && !prefix.includes(".") && !prefix.includes("(")) {
      text = text.slice(of + 4);
      continue;
    }
    break;
  }
  const extensionPrefix = "(extension in ";
  if (text.startsWith(extensionPrefix)) {
    const end = text.indexOf("):");
    return end > extensionPrefix.length
      ? text.slice(extensionPrefix.length, end)
      : undefined;
  }
  let i = 0;
  while (i < text.length && isIdentifierChar(text[i])) {
    i++;
  }
  return i > 0 && text[i] === "." ? text.slice(0, i) : undefined;
}

/**
 * Identify the module of a mangled Swift name without the demangler. Only the
 * leading module context is decoded, so extension members are attributed to
 * the extended type's module.
 *
 * @param {String} mangled Mangled name starting with `$s`
 * @returns {undefined|String} Module name
 */
export function moduleFromMangledPrefix(mangled) {
  if (!mangled?.startsWith("$s")) {
    return undefined;
  }
  const rest = mangled.slice(2);
  if (rest.startsWith("s") || /^S[A-Za-z]/.test(rest)) {
    return rest.startsWith("So") || rest.startsWith("SC") ? "__C" : "Swift";
  }
  let i = 0;
  while (i < rest.length && rest[i] >= "0" && rest[i] <= "9") {
    i++;
  }
  // A leading 0 marks an identifier with word substitutions
  if (!i || rest[0] === "0") {
    return undefined;
  }
  const length = Number.parseInt(rest.slice(0, i), 10);
  const identifier = rest.slice(i, i + length);
  return identifier.length === length ? identifier : undefined;
}

/**
 * Convert a Swift USR (`s:<mangled>`, or `s:e:s:<mangled>` for extensions)
 * into a mangled name the demangler accepts.
 *
 * @param {String} usr USR
 * @returns {undefined|String} Mangled name starting with `$s`
 */
function swiftUsrToMangledName(usr) {
  let value = usr || "";
  if (value.startsWith("s:e:")) {
    value = value.slice(4);
  }
  return value.startsWith("s:") && value.length > 2
    ? `$s${value.slice(2)}`
    : undefined;
}

/**
 * Identify the declaring module of each USR.
 *
 * Swift USRs are demangled in one batch with `swift demangle`; clang module
 * references (`c:@M@<module>`, emitted for import declarations) carry the
 * module name directly. Other clang USRs name no module and are skipped.
 *
 * @param {Array<String>} usrs USRs to resolve
 * @param {String} basePath Directory to run the demangler in
 * @returns {Map<String, String>} USR to module name
 */
export function resolveUsrModules(usrs, basePath) {
  const usrModules = new Map();
  const pending = [];
  for (const usr of new Set(usrs)) {
    if (usr.startsWith("c:@M@")) {
      const moduleName = usr.slice(5).split("@")[0];
      if (moduleName) {
        usrModules.set(usr, moduleName);
      }
      continue;
    }
    const mangled = swiftUsrToMangledName(usr);
    if (mangled) {
      pending.push([usr, mangled]);
    }
  }
  if (!pending.length) {
    return usrModules;
  }
  const result = spawnSwift(basePath, ["demangle", "--compact"], {
    input: `${pending.map(([, mangled]) => mangled).join("\n")}\n`,
  });
  const demangledLines =
    result?.status === 0 && result.stdout ? result.stdout.split("\n") : [];
  if (!demangledLines.length && DEBUG_MODE) {
    console.log(
      "swift demangle is unavailable. Falling back to the mangled module prefix.",
    );
  }
  pending.forEach(([usr, mangled], i) => {
    const moduleName =
      moduleFromDemangledName(demangledLines[i]) ||
      moduleFromMangledPrefix(mangled);
    if (moduleName) {
      usrModules.set(usr, moduleName);
    }
  });
  return usrModules;
}

/**
 * Method to execute dump-package package command.
 *
 * @param {String} basePath Path
 * @returns {undefined|Object} Output from dump-package command
 */
export function dumpPackage(basePath) {
  // stderr carries manifest warnings, so only stdout is parsed
  const result = spawnSwift(basePath, ["package", "dump-package"]);
  if (!result?.stdout) {
    return undefined;
  }
  try {
    return JSON.parse(result.stdout);
  } catch (_e) {
    return undefined;
  }
}

/**
 * Parse the data from dump-package command
 *
 * @param {Object} dumpJson Json from dump-package command
 * @returns {Object|undefined} Parsed value
 */
export function parseDumpPackage(dumpJson) {
  if (!dumpJson) {
    return undefined;
  }
  const metadata = {
    rootModule: dumpJson?.name,
    rootDir: dumpJson?.packageKind?.root,
    platforms: dumpJson?.platforms,
  };
  const rootPkgDependencies = [];
  const rootModules = new Set();
  // Test targets and the library targets only tests depend on
  const testModules = new Set();
  const productionTargets = collectSwiftProductionTargets(dumpJson);
  if (dumpJson.targets) {
    for (const atarget of dumpJson.targets) {
      const ref = atarget.name.replaceAll("+", "_");
      if (productionTargets.has(String(atarget.name).toLowerCase())) {
        rootModules.add(toModuleName(ref));
      } else {
        testModules.add(toModuleName(ref));
      }
      if (atarget.dependencies) {
        // Product dependencies such as `.product(name:package:)` record both
        // the product (module) name and the package identity; `byName` and
        // `target` entries only record the product or target name.
        const dependsOn = atarget.dependencies
          .map(
            (v) =>
              v?.byName?.[0]?.replaceAll("+", "_") ??
              v?.target?.[0]?.replaceAll("+", "_") ??
              v?.product?.[0]?.replaceAll("+", "_"),
          )
          .filter((v) => v !== undefined);
        rootPkgDependencies.push({
          ref,
          dependsOn,
        });
      }
    }
  }
  metadata.dependencies = rootPkgDependencies;
  if (rootModules.size) {
    metadata.rootModules = Array.from(rootModules).sort();
  }
  if (testModules.size) {
    metadata.testModules = Array.from(testModules).sort();
  }
  return metadata;
}

/**
 * Retrieve the module information of the swift project
 *
 * @param {String} moduleName Module name
 * @param {String|Array<string>} compilerArgs Compiler arguments extracted from verbose build log
 * @param {Object} [env] Environment overrides for sourcekitten
 * @returns {undefined|Object} JSON representation of the swift module or undefined.
 */
export function moduleInfo(moduleName, compilerArgs, env) {
  const skArgs = ["module-info", "--module", moduleName];
  if (compilerArgs && compilerArgs.length > 0) {
    skArgs.push("--");
    if (Array.isArray(compilerArgs)) {
      skArgs.push(...compilerArgs);
    } else {
      skArgs.push(...splitSwiftCommandArgs(compilerArgs));
    }
  }
  return executeSourcekitten(skArgs, env);
}

/**
 * Parse the data from module-info command to replicate the swift interface
 *
 * @param {Object} moduleInfoJson Json from module-info command
 * @returns {Object|undefined} Parsed classes, protocols, enums and their functions
 */
export function parseModuleInfo(moduleInfoJson) {
  if (!moduleInfoJson?.["key.annotations"]) {
    return undefined;
  }
  const classes = new Set();
  const protocols = new Set();
  const enums = new Set();
  const obfuscationMap = {};
  const classMethods = {};
  const protocolMethods = {};
  // Collect the classes, protocols and enums first
  for (const annot of moduleInfoJson["key.annotations"] || []) {
    switch (annot["key.kind"]) {
      case SWIFT_ENTITY_KINDS.REF_CLASS:
        classes.add(annot["key.name"]);
        break;
      case SWIFT_ENTITY_KINDS.REF_PROTOCOL:
        protocols.add(annot["key.name"]);
        break;
      case SWIFT_ENTITY_KINDS.REF_ENUM:
        enums.add(annot["key.name"]);
        break;
    }
    // Build the obfuscation map
    if (
      [
        SWIFT_ENTITY_KINDS.REF_CLASS,
        SWIFT_ENTITY_KINDS.REF_PROTOCOL,
        SWIFT_ENTITY_KINDS.REF_ENUM,
      ].includes(annot["key.kind"])
    ) {
      obfuscationMap[annot["key.name"]] = annot["key.usr"];
    }
  }
  // Collect the class and protocol functions
  for (const aentity of moduleInfoJson["key.entities"] || []) {
    if (
      aentity["key.entities"] &&
      [
        SWIFT_ENTITY_KINDS.DECL_CLASS,
        SWIFT_ENTITY_KINDS.DECL_PROTOCOL,
      ].includes(aentity["key.kind"])
    ) {
      for (const centities of aentity["key.entities"] || []) {
        if (
          [SWIFT_ENTITY_KINDS.DECL_METHOD_INSTANCE].includes(
            centities["key.kind"],
          )
        ) {
          switch (aentity["key.kind"]) {
            case SWIFT_ENTITY_KINDS.DECL_CLASS:
              if (!classMethods[aentity["key.name"]]) {
                classMethods[aentity["key.name"]] = [];
              }
              classMethods[aentity["key.name"]].push(centities["key.name"]);
              break;
            case SWIFT_ENTITY_KINDS.DECL_PROTOCOL:
              if (!protocolMethods[aentity["key.name"]]) {
                protocolMethods[aentity["key.name"]] = [];
              }
              protocolMethods[aentity["key.name"]].push(centities["key.name"]);
              break;
          }
          obfuscationMap[centities["key.name"]] = centities["key.usr"];
        }
      }
    }
  }
  // Collect the imported modules and the free functions offered by the module
  const freeFunctions = new Set();
  const importedModules = [];
  for (const aline of (moduleInfoJson?.["key.sourcetext"] || "").split("\n")) {
    const line = aline.replaceAll("\r", "");
    if (line.startsWith("import ")) {
      importedModules.push(line.replace("import ", ""));
      continue;
    }
    // Free functions such as Yams' `dump(object:)` are declared at the top
    // level of the interface; members of types and extensions are indented
    const funcMatch = line.match(
      /^(?:@\w+(?:\([^)]*\))?\s+)*(?:public\s+|open\s+)?func\s+([A-Za-z_][A-Za-z0-9_]*)/,
    );
    if (funcMatch) {
      freeFunctions.add(funcMatch[1]);
    }
  }
  return {
    classes: Array.from(classes).sort(),
    protocols: Array.from(protocols).sort(),
    enums: Array.from(enums).sort(),
    obfuscationMap,
    classMethods,
    protocolMethods,
    functions: Array.from(freeFunctions).sort(),
    importedModules: importedModules.sort(),
  };
}

/**
 * Method to collect the build symbols from the output file maps generated by
 * swift build.
 *
 * Both build engines are supported: the llbuild engine writes per-module
 * `output-file-map.json` files, while the Swift Build engine (default from
 * Swift 6.4) writes per-target `<target>-OutputFileMap.json` files under
 * `.build/out/Intermediates.noindex`.
 *
 * @param {String} basePath Path
 * @param {Object} options CLI options
 * @param {Array<String>} [fileMaps] Output file maps, found under basePath when omitted
 * @returns {Object} symbols map keyed by module name
 */
export function collectBuildSymbols(basePath, options, fileMaps) {
  const symbolsMap = {};
  const mapFiles =
    fileMaps ||
    getAllFiles(
      basePath,
      `.build/**/{output-file-map.json,*${SWIFT_BUILD_FILEMAP_SUFFIX}}`,
      options,
    );
  for (const afilemap of mapFiles) {
    let metadata;
    try {
      metadata = parseOutputFileMap(afilemap);
    } catch (_e) {
      continue;
    }
    if (!metadata?.moduleName || isTestOrAggregateModule(metadata.moduleName)) {
      continue;
    }
    const existing = symbolsMap[metadata.moduleName] || [];
    for (const asym of metadata.moduleSymbols) {
      if (!existing.includes(asym)) {
        existing.push(asym);
      }
    }
    symbolsMap[metadata.moduleName] = existing;
  }
  return symbolsMap;
}

/**
 * Method to parse output file map to identify the module, its sources, and
 * their symbols. The symbol list is imprecise; the sources are exact.
 *
 * The module name is derived from the containing directory for llbuild maps
 * (`<Module>.build` and, since Swift 6.4, `<Module>-tool.build`) and from the
 * file name for Swift Build maps (`<target>-OutputFileMap.json`, where the
 * target name still needs to be sanitised into a module name).
 *
 * @param filemap {String} File name
 * @returns {Object} parsed module metadata `{ moduleName, moduleSymbols, sourceFiles }`
 */
export function parseOutputFileMap(filemap) {
  const fileMapObj = JSON.parse(readFileSync(filemap, { encoding: "utf-8" }));
  const fileMapName = basename(filemap);
  let moduleName;
  if (fileMapName.endsWith(SWIFT_BUILD_FILEMAP_SUFFIX)) {
    moduleName = toModuleName(
      fileMapName.slice(0, -SWIFT_BUILD_FILEMAP_SUFFIX.length),
    );
  } else {
    moduleName = basename(dirname(filemap))
      .replace(/\.build$/, "")
      .replace(/-tool$/, "");
  }
  const moduleSymbols = [];
  const sourceFiles = [];
  for (const akey of Object.keys(fileMapObj)) {
    // The empty key describes module-level outputs rather than a source file
    if (!akey.length) {
      continue;
    }
    if (akey.endsWith(".swift")) {
      sourceFiles.push(akey);
    }
    const swiftDeps = fileMapObj[akey]?.["swift-dependencies"];
    if (swiftDeps) {
      moduleSymbols.push(
        basename(swiftDeps).replace(".swiftdeps", "").replaceAll("+", "_"),
      );
    }
  }
  return { moduleName, moduleSymbols, sourceFiles };
}

/**
 * Parse `.build/workspace-state.json` into the dependency packages of the
 * workspace and the directory each one was materialised in.
 *
 * @param {Object} stateJson Parsed workspace-state.json
 * @param {String} basePath Root package directory
 * @returns {Array<Object>} `{ identity, name, location, kind, dir }` per package
 */
export function parseSwiftWorkspaceState(stateJson, basePath) {
  const packages = [];
  const dependencies =
    stateJson?.object?.dependencies || stateJson?.dependencies || [];
  for (const adep of dependencies) {
    const packageRef = adep?.packageRef || {};
    const identity = packageRef.identity;
    if (!identity) {
      continue;
    }
    let dir;
    switch (adep?.state?.name) {
      case "sourceControlCheckout":
      case "checkout":
        dir = join(basePath, ".build", "checkouts", adep.subpath || identity);
        break;
      case "registryDownload":
        dir = join(
          basePath,
          ".build",
          "registry",
          "downloads",
          adep.subpath || identity,
        );
        break;
      case "fileSystem":
      case "local":
        dir = adep.state?.path || packageRef.location;
        break;
      case "edited":
        dir = adep.state?.path || join(basePath, "Packages", adep.subpath);
        break;
      default:
        dir = undefined;
    }
    packages.push({
      identity,
      name: packageRef.name || identity,
      location: packageRef.location,
      kind: packageRef.kind,
      dir: dir && isAbsolute(dir) ? dir : undefined,
    });
  }
  return packages;
}

/**
 * Parse the Swift Build engine's project model (`.build/manifest.pif`) into
 * the module names each package declares.
 *
 * The manifest is a list of workspace, project, and target objects linked
 * through their `signature` hashes. A project's guid is `PACKAGE:<identity>`
 * and each target records its `PRODUCT_MODULE_NAME`. Unlike the verbose
 * build output, the manifest lists modules whose compilation never started,
 * which keeps the module-to-package mapping complete when a build fails.
 *
 * @param {Array} manifestJson Parsed manifest.pif contents
 * @returns {Object} Map of package identity to module names
 */
export function parseSwiftBuildManifest(manifestJson) {
  const packageModules = {};
  if (!Array.isArray(manifestJson)) {
    return packageModules;
  }
  const objectsBySignature = new Map();
  for (const obj of manifestJson) {
    if (obj?.signature) {
      objectsBySignature.set(obj.signature, obj);
    }
  }
  for (const obj of manifestJson) {
    const guid = obj?.type === "project" ? obj.contents?.guid : undefined;
    if (!guid?.startsWith("PACKAGE:")) {
      continue;
    }
    const identity = guid.slice("PACKAGE:".length);
    const modules = new Set();
    for (const targetSignature of obj.contents.targets || []) {
      const target = objectsBySignature.get(targetSignature);
      const contents = target?.type === "target" ? target.contents : undefined;
      if (!contents?.name || isTestOrAggregateModule(contents.name)) {
        continue;
      }
      for (const buildConfig of contents.buildConfigurations || []) {
        const moduleName = buildConfig?.buildSettings?.PRODUCT_MODULE_NAME;
        if (moduleName && !isTestOrAggregateModule(moduleName)) {
          modules.add(moduleName);
          break;
        }
      }
    }
    if (modules.size) {
      packageModules[identity] = Array.from(modules).sort();
    }
  }
  return packageModules;
}

/**
 * Blank out the comments and string literals of Swift source, keeping line
 * breaks so line numbers are unchanged.
 *
 * Handles line comments, nested block comments, and single-line, multi-line
 * (`"""`) and raw (`#"..."#`) string literals.
 *
 * @param {String} sourceText Swift source
 * @returns {String} Source with comments and string contents replaced by spaces
 */
function maskSwiftCommentsAndStrings(sourceText) {
  const text = sourceText || "";
  let out = "";
  let i = 0;
  const blank = (s) => s.replace(/[^\n]/g, " ");
  while (i < text.length) {
    const char = text[i];
    if (char === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? text.length : end;
      out += blank(text.slice(i, stop));
      i = stop;
      continue;
    }
    if (char === "/" && text[i + 1] === "*") {
      let depth = 0;
      let j = i;
      while (j < text.length) {
        if (text[j] === "/" && text[j + 1] === "*") {
          depth++;
          j += 2;
        } else if (text[j] === "*" && text[j + 1] === "/") {
          depth--;
          j += 2;
          if (!depth) {
            break;
          }
        } else {
          j++;
        }
      }
      out += blank(text.slice(i, j));
      i = j;
      continue;
    }
    if (char === '"' || (char === "#" && /^#+"/.test(text.slice(i, i + 64)))) {
      let hashes = 0;
      while (text[i + hashes] === "#") {
        hashes++;
      }
      const quoteStart = i + hashes;
      const multiline = text.startsWith('"""', quoteStart);
      const closing = `${multiline ? '"""' : '"'}${"#".repeat(hashes)}`;
      let j = quoteStart + (multiline ? 3 : 1);
      while (j < text.length) {
        // Escapes need as many `#` as the delimiter in raw strings
        if (
          text[j] === "\\" &&
          text.startsWith("#".repeat(hashes), j + 1) &&
          j + 1 + hashes < text.length
        ) {
          j += 2 + hashes;
          continue;
        }
        if (text.startsWith(closing, j)) {
          j += closing.length;
          break;
        }
        // An unterminated single-line literal ends at the line break
        if (!multiline && text[j] === "\n") {
          break;
        }
        j++;
      }
      out += blank(text.slice(i, j));
      i = j;
      continue;
    }
    out += char;
    i++;
  }
  return out;
}

/**
 * Collect the modules imported by a Swift source file, with their lines.
 *
 * Declarations such as `@testable import Foo`, `public import Foo`,
 * `@_implementationOnly import cmark_gfm`, and `import struct Foo.Bar` are
 * recognised; comments, string literals, and `canImport` conditions are not
 * imports.
 *
 * @param {String} sourceText Swift source
 * @returns {Array<Object>} `{ module, line }` per import declaration
 */
export function parseSwiftImports(sourceText) {
  const imports = [];
  const accessLevels = new Set([
    "public",
    "package",
    "internal",
    "fileprivate",
    "private",
    "open",
  ]);
  const importKinds = new Set([
    "struct",
    "class",
    "enum",
    "protocol",
    "typealias",
    "func",
    "var",
    "let",
  ]);
  const lines = maskSwiftCommentsAndStrings(sourceText).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.includes("import")) {
      continue;
    }
    for (const statement of line.split(";")) {
      const tokens = statement.trim().split(/\s+/);
      let t = 0;
      while (
        t < tokens.length &&
        (tokens[t].startsWith("@") || accessLevels.has(tokens[t]))
      ) {
        t++;
      }
      if (tokens[t] !== "import") {
        continue;
      }
      t++;
      if (importKinds.has(tokens[t])) {
        t++;
      }
      const moduleName = tokens[t]?.split(".")[0];
      if (moduleName && isIdentifierChar(moduleName[0])) {
        imports.push({ module: moduleName, line: i + 1 });
      }
    }
  }
  return imports;
}

/**
 * Collect the clang module names declared at the top level of a module map.
 *
 * @param {String} moduleMapText module.modulemap contents
 * @returns {Object} `{ modules, headerPaths }`
 */
export function parseClangModuleMap(moduleMapText) {
  const modules = [];
  const headerPaths = [];
  let depth = 0;
  for (const rawLine of (moduleMapText || "").split("\n")) {
    const line = rawLine.split("//")[0].trim();
    if (!line) {
      continue;
    }
    const tokens = line.split(/\s+/);
    if (depth === 0) {
      let t = 0;
      while (["explicit", "framework", "extern"].includes(tokens[t])) {
        t++;
      }
      if (tokens[t] === "module" && tokens[t + 1]) {
        const moduleName = tokens[t + 1].split("{")[0];
        if (moduleName && moduleName !== "*") {
          modules.push(moduleName);
        }
      }
    }
    const quoteStart = line.indexOf('"');
    const quoteEnd = line.indexOf('"', quoteStart + 1);
    if (
      quoteStart >= 0 &&
      quoteEnd > quoteStart &&
      (tokens.includes("header") || tokens.includes("umbrella"))
    ) {
      headerPaths.push(line.slice(quoteStart + 1, quoteEnd));
    }
    for (const char of line) {
      if (char === "{") {
        depth++;
      } else if (char === "}") {
        depth = Math.max(0, depth - 1);
      }
    }
  }
  return { modules, headerPaths };
}

function canonicalPath(filePath) {
  try {
    return realpathSync(filePath);
  } catch (_e) {
    return filePath;
  }
}

function isWithinDir(dir, filePath) {
  if (!dir || !filePath) {
    return false;
  }
  // Only a whole `..` segment leaves the directory; `..build` is an entry.
  return isInsideDir(filePath, dir);
}

/**
 * Attribute a source, module map, or header path to the package that owns
 * it: the dependency whose directory contains it (the most specific one
 * wins), the Swift Build intermediates directory named after the package, or
 * the root package.
 *
 * @param {String} filePath Absolute path
 * @param {Object} workspace `{ basePath, packages }` with canonical directories
 * @returns {undefined|Object} Owning package, `workspace.root` for the root package
 */
function owningPackage(filePath, workspace) {
  const target = canonicalPath(filePath);
  let best;
  for (const apkg of workspace.packages) {
    if (
      apkg.canonicalDir &&
      isWithinDir(apkg.canonicalDir, target) &&
      (!best || apkg.canonicalDir.length > best.canonicalDir.length)
    ) {
      best = apkg;
    }
  }
  if (best) {
    return best;
  }
  // Swift Build keeps generated module maps in
  // `.build/out/Intermediates.noindex/<package identity>.build/`
  const segments = target.split(PATH_SEPARATORS);
  const intermediates = segments.indexOf("Intermediates.noindex");
  if (intermediates >= 0 && segments[intermediates + 1]?.endsWith(".build")) {
    const identity = segments[intermediates + 1].slice(0, -".build".length);
    const byIdentity = workspace.packages.find(
      (p) => p.identity === identity.toLowerCase() || p.name === identity,
    );
    if (byIdentity) {
      return byIdentity;
    }
    if (identity === workspace.root.name) {
      return workspace.root;
    }
    return undefined;
  }
  if (isWithinDir(workspace.canonicalBasePath, target)) {
    const rel = relative(workspace.canonicalBasePath, target);
    return rel.split(PATH_SEPARATORS)[0] === ".build"
      ? undefined
      : workspace.root;
  }
  return undefined;
}

/**
 * Build a description of every module in a completed swift build: its
 * compiler arguments, sources, and owning package.
 *
 * Arguments come from the llbuild build description when present and from
 * the verbose build output otherwise (the only source for the Swift Build
 * engine); sources come from the same places or from the output file maps.
 * Packages come from `workspace-state.json`, and every module is attributed
 * to the package whose directory holds its sources. Clang modules are
 * discovered through their module maps.
 *
 * @param {String} basePath Root package directory
 * @param {String} buildOutput Verbose build output
 * @param {Object} options CLI options
 * @param {Object} [rootMetadata] Parsed dump-package of the root package
 * @returns {Object} `{ modules, packages, root, clangModules, fileMaps }`
 */
export function collectSwiftBuildPlan(
  basePath,
  buildOutput,
  options,
  rootMetadata,
) {
  const buildArtifacts = getAllFiles(
    basePath,
    `.build/**/{description.json,output-file-map.json,*${SWIFT_BUILD_FILEMAP_SUFFIX},module.modulemap}`,
    options,
  );
  const fileMaps = [];
  const moduleMapFiles = new Set();
  const modules = {};
  const seenDescriptions = new Set();
  for (const artifact of buildArtifacts) {
    const name = basename(artifact);
    // Dependency repositories may ship build files of their own as test
    // fixtures; only their module maps describe real clang modules
    const buildSubdir = relative(join(basePath, ".build"), artifact).split(
      PATH_SEPARATORS,
    )[0];
    if (
      name !== "module.modulemap" &&
      ["checkouts", "repositories", "registry"].includes(buildSubdir)
    ) {
      continue;
    }
    if (name === "description.json") {
      const realDescription = canonicalPath(artifact);
      if (
        seenDescriptions.has(realDescription) ||
        !artifact.toLowerCase().split(PATH_SEPARATORS).includes("debug")
      ) {
        continue;
      }
      seenDescriptions.add(realDescription);
      try {
        Object.assign(
          modules,
          parseSwiftBuildDescription(
            JSON.parse(readFileSync(artifact, { encoding: "utf-8" })),
          ),
        );
      } catch (_e) {
        // Fall back to the verbose build output
      }
    } else if (name === "module.modulemap") {
      moduleMapFiles.add(artifact);
    } else {
      fileMaps.push(artifact);
    }
  }
  for (const [moduleName, invocation] of Object.entries(
    parseSwiftModuleInvocations(buildOutput),
  )) {
    if (!modules[moduleName]) {
      modules[moduleName] = invocation;
    } else if (!modules[moduleName].sources.length) {
      modules[moduleName].sources = invocation.sources;
    }
  }
  // Output file maps list the exact sources of every module
  for (const afilemap of fileMaps) {
    let metadata;
    try {
      metadata = parseOutputFileMap(afilemap);
    } catch (_e) {
      continue;
    }
    if (!metadata?.moduleName || !metadata.sourceFiles.length) {
      continue;
    }
    const amodule = modules[metadata.moduleName];
    if (!amodule) {
      modules[metadata.moduleName] = {
        args: [],
        sources: metadata.sourceFiles,
        isDriver: false,
      };
    } else if (!amodule.sources.length) {
      amodule.sources = metadata.sourceFiles;
    }
  }
  const rootName = rootMetadata?.rootModule || basename(basePath);
  const workspace = {
    basePath,
    canonicalBasePath: canonicalPath(basePath),
    root: { identity: rootName.toLowerCase(), name: rootName, root: true },
    packages: [],
  };
  const workspaceStateFile = join(basePath, ".build", "workspace-state.json");
  if (safeExistsSync(workspaceStateFile)) {
    try {
      workspace.packages = parseSwiftWorkspaceState(
        JSON.parse(readFileSync(workspaceStateFile, { encoding: "utf-8" })),
        basePath,
      );
    } catch (_e) {
      workspace.packages = [];
    }
  }
  for (const apkg of workspace.packages) {
    apkg.canonicalDir = apkg.dir ? canonicalPath(apkg.dir) : undefined;
    apkg.modules = new Set();
  }
  workspace.root.modules = new Set();
  const testModules = new Set(rootMetadata?.testModules || []);
  for (const [moduleName, amodule] of Object.entries(modules)) {
    const firstSource =
      amodule.sources.find(
        (s) => !s.split(PATH_SEPARATORS).includes(".build"),
      ) || amodule.sources[0];
    const owner = firstSource
      ? owningPackage(firstSource, workspace)
      : undefined;
    amodule.package = owner?.root ? workspace.root.identity : owner?.identity;
    amodule.isRoot = Boolean(owner?.root);
    // Local packages kept inside the scanned directory (monorepos) are part
    // of the project's own code
    amodule.isWorkspace =
      amodule.isRoot ||
      Boolean(
        owner?.kind === "fileSystem" &&
          owner.canonicalDir &&
          isWithinDir(workspace.canonicalBasePath, owner.canonicalDir),
      );
    amodule.isTest =
      testModules.has(moduleName) ||
      isTestOrAggregateModule(moduleName) ||
      (amodule.sources.length > 0 &&
        amodule.sources.every((s) =>
          relative(basePath, s).split(PATH_SEPARATORS).includes("Tests"),
        ));
    owner?.modules.add(moduleName);
    // Module maps referenced through -fmodule-map-file describe clang modules
    for (let i = 0; i < amodule.args.length; i++) {
      if (
        amodule.args[i] === "-Xcc" &&
        amodule.args[i + 1]?.startsWith("-fmodule-map-file=")
      ) {
        moduleMapFiles.add(
          amodule.args[i + 1].slice("-fmodule-map-file=".length),
        );
      }
    }
  }
  // The Swift Build project model names the modules of every package, also
  // those a failed build never compiled
  const manifestFile = join(basePath, ".build", "manifest.pif");
  if (safeExistsSync(manifestFile)) {
    let manifestModules = {};
    try {
      manifestModules = parseSwiftBuildManifest(
        JSON.parse(readFileSync(manifestFile, { encoding: "utf-8" })),
      );
    } catch (_e) {
      manifestModules = {};
    }
    for (const [identity, moduleNames] of Object.entries(manifestModules)) {
      const owner =
        workspace.packages.find((p) => p.identity === identity) ||
        workspace.root;
      for (const moduleName of moduleNames) {
        const attributed =
          modules[moduleName]?.package !== undefined ||
          [workspace.root, ...workspace.packages].some((p) =>
            p.modules.has(moduleName),
          );
        if (!attributed) {
          owner.modules.add(moduleName);
        }
      }
    }
  }
  const clangModules = {};
  for (const moduleMapFile of moduleMapFiles) {
    if (!safeExistsSync(moduleMapFile)) {
      continue;
    }
    let parsed;
    try {
      parsed = parseClangModuleMap(
        readFileSync(moduleMapFile, { encoding: "utf-8" }),
      );
    } catch (_e) {
      continue;
    }
    // Generated module maps live in the build directory; their headers point
    // back at the package sources
    const attributionPath = moduleMapFile
      .split(PATH_SEPARATORS)
      .includes(".build")
      ? parsed.headerPaths.find((h) => isAbsolute(h)) || moduleMapFile
      : moduleMapFile;
    const owner = owningPackage(attributionPath, workspace);
    if (!owner) {
      continue;
    }
    for (const clangModule of parsed.modules) {
      if (!modules[clangModule] && !clangModules[clangModule]) {
        clangModules[clangModule] = owner.root
          ? workspace.root.identity
          : owner.identity;
        owner.modules.add(clangModule);
      }
    }
  }
  return {
    modules,
    clangModules,
    root: workspace.root,
    packages: workspace.packages,
    fileMaps,
  };
}

/**
 * Register a package's modules under its identity, name, and repository name
 * (and their lowercase forms) so that SBOM components can be matched
 * regardless of how they were named.
 *
 * @param {Object} packageModules Map to mutate
 * @param {Object} apkg Package with `identity`, `name`, `location`, `modules`
 */
function addPackageModuleAliases(packageModules, apkg) {
  const modules = Array.from(apkg.modules || []).sort();
  if (!modules.length) {
    return;
  }
  const repoName = (apkg.location || "")
    .split("?")[0]
    .split("#")[0]
    .replace(/\/+$/, "")
    .split("/")
    .pop()
    ?.replace(/\.git$/, "");
  for (const alias of [apkg.identity, apkg.name, repoName]) {
    for (const key of [alias, alias?.toLowerCase()]) {
      if (key) {
        packageModules[key] = Array.from(
          new Set([...(packageModules[key] || []), ...modules]),
        ).sort();
      }
    }
  }
}

/**
 * Check that sourcekitten can load SourceKit, with a trivial syntax request.
 *
 * A missing binary, a binary without its Swift runtime (`error while loading
 * shared libraries: libswiftCore.so`), or one linked against a different
 * Swift runtime than the toolchain provides (Linux has no stable Swift ABI, so
 * such a binary crashes inside libswiftCore) fails every request; the probe
 * turns that into one clear message instead of silent empty results.
 *
 * @param {Object} [env] Environment overrides for sourcekitten
 * @returns {boolean} `true` when sourcekitten answered the probe
 */
export function isSourcekittenUsable(env) {
  const status = probeSourcekitten(env);
  if (status === "ok") {
    return true;
  }
  if (status === "unavailable") {
    // cdxgen-plugins-bin ships sourcekitten for macOS only: a prebuilt Linux
    // binary runs only next to the Swift toolchain that built it.
    console.log(
      process.platform === "darwin"
        ? "sourcekitten is unavailable, so Swift evidence is limited to import declarations. Install the cdxgen-plugins-bin package for this platform or set SOURCEKITTEN_CMD."
        : "sourcekitten is unavailable, so Swift evidence is limited to import declarations. Build sourcekitten with the Swift toolchain used here and set SOURCEKITTEN_CMD, or use a cdxgen container image that includes Swift.",
    );
    return false;
  }
  if (status === "not-found") {
    console.log(
      readEnvironmentVariable("SOURCEKITTEN_CMD")
        ? "SOURCEKITTEN_CMD does not name an executable that exists, so Swift evidence is limited to import declarations. Point it at a sourcekitten binary."
        : "The bundled sourcekitten executable is missing, so Swift evidence is limited to import declarations. Reinstall the cdxgen-plugins-bin package for this platform or set SOURCEKITTEN_CMD.",
    );
    return false;
  }
  console.log(
    "sourcekitten could not load SourceKit, so Swift evidence is limited to import declarations. On Linux, sourcekitten must be linked against the Swift runtime of this toolchain; set SOURCEKITTEN_CMD to a sourcekitten built with it (or with --static-swift-stdlib). Set CDXGEN_DEBUG_MODE=debug to see the error.",
  );
  return false;
}

/**
 * Create a precise semantics slices file for a swift project.
 *
 * The project is built once in verbose mode. Every source file of the root
 * package's (non-test) modules is then indexed with sourcekitten using that
 * module's own compiler arguments and source list, with sourcekitten aligned
 * to the toolchain that compiled the project. The declaring module of every
 * resolved reference is recovered from its USR, which attributes each usage
 * to the package that provides the module (`moduleReferences`).
 *
 * @param basePath basePath Path
 * @param options options CLI options
 */
export function createSemanticsSlices(basePath, options) {
  const pkgSwiftFiles = getAllFiles(
    basePath,
    `${options.multiProject ? "**/" : ""}Package*.swift`,
    options,
  );
  if (!pkgSwiftFiles.length) {
    return undefined;
  }
  // A SwiftPM manifest is a Swift program and the verbose build compiles the
  // project, so both belong to the dependency-tooling surface disabled by
  // --no-install-deps and the pre-build lifecycle. Evidence then comes from
  // the .build artifacts a previous build left and import declarations.
  const toolingAllowed = isProjectToolingAllowed(options);
  // swiftly picks a toolchain from the project's .swift-version, so every
  // swift command (the toolchain query, the demangler) starts outside the
  // project when its tooling may not run
  const swiftDir = toolingAllowed ? basePath : getTmpDir();
  const toolchain = resolveSwiftToolchain(swiftDir);
  const sourcekittenEnv = sourcekittenEnvForToolchain(toolchain);
  // Without a working sourcekitten, the evidence is limited to the import
  // declarations of the modules the build describes
  const useSourcekitten = isSourcekittenUsable(sourcekittenEnv);
  if (DEBUG_MODE && toolchain) {
    console.log(
      `Swift toolchain for ${basePath}: ${toolchain.compilerVersion} at ${toolchain.toolchainDir}.`,
      sourcekittenEnv
        ? `sourcekitten environment: ${JSON.stringify(sourcekittenEnv)}`
        : "",
    );
  }
  if (!toolingAllowed) {
    console.log(
      "Skipping 'swift package dump-package' and the swift build for evidence since dependency installation is disabled. Evidence is limited to the build artifacts already in the project, without their compiler plugins.",
    );
  }
  // Package.swift contains the root targets, including which ones are tests
  const packageMetadata = toolingAllowed
    ? parseDumpPackage(dumpPackage(basePath))
    : undefined;
  const userCompilerArgs = process?.env?.SWIFT_COMPILER_ARGS;
  const userSdkArgs = process?.env?.SWIFT_SDK_ARGS;
  // A clean verbose debug build reveals the compiler arguments of every module
  const buildOutput =
    !toolingAllowed || (userCompilerArgs && userSdkArgs)
      ? undefined
      : verboseBuild(basePath);
  const buildPlan = collectSwiftBuildPlan(
    basePath,
    buildOutput,
    options,
    packageMetadata,
  );
  const packageModules = {};
  for (const apkg of [buildPlan.root, ...buildPlan.packages]) {
    addPackageModuleAliases(packageModules, apkg);
  }
  const packages = buildPlan.packages
    .filter((p) => p.modules.size)
    .map((p) => ({
      identity: p.identity,
      name: p.name,
      location: p.location,
      kind: p.kind,
      modules: Array.from(p.modules).sort(),
    }));
  const dependencyModules = new Set(
    buildPlan.packages.flatMap((p) => Array.from(p.modules)),
  );
  const rootModuleNames = Object.keys(buildPlan.modules).filter(
    (m) => buildPlan.modules[m].isWorkspace && !buildPlan.modules[m].isTest,
  );
  // A private module cache per run: the build's cache is shared with every
  // compiler that ever touched the project, and modules from a mismatched
  // toolchain make SourceKit return empty results
  const moduleCachePath = safeMkdtempSync(join(getTmpDir(), "swiftsem-cache-"));
  const fileIndexes = {};
  const indexedFiles = new Set();
  const indexFile = (afile, compilerArgs) => {
    fileIndexes[afile] = useSourcekitten
      ? parseIndex(index(afile, compilerArgs, sourcekittenEnv))
      : undefined;
    indexedFiles.add(canonicalPath(afile));
  };
  // The build descriptions and output file maps are project content, so a
  // source they list (or a symlinked source) is only read when it really
  // lives inside the scanned package
  const canonicalBasePath = canonicalPath(basePath);
  const isProjectSource = (afile) =>
    safeExistsSync(afile) &&
    isWithinDir(canonicalBasePath, canonicalPath(afile));
  const isIndexableSource = (afile) =>
    afile.endsWith(".swift") &&
    !/^Package(@.+)?\.swift$/.test(basename(afile)) &&
    !relative(basePath, afile).split(PATH_SEPARATORS).includes(".build") &&
    isProjectSource(afile);
  try {
    const moduleArgs = {};
    for (const moduleName of rootModuleNames) {
      const amodule = buildPlan.modules[moduleName];
      moduleArgs[moduleName] = [
        ...(userCompilerArgs
          ? splitSwiftCommandArgs(`${userCompilerArgs} ${userSdkArgs || ""}`)
          : toolingAllowed
            ? amodule.args
            : withoutSwiftPluginArgs(amodule.args, toolchain?.sdkPath)),
        "-module-cache-path",
        moduleCachePath,
      ];
      if (!moduleArgs[moduleName].includes("-module-name")) {
        moduleArgs[moduleName].push("-module-name", moduleName);
      }
      // Every source of the module is passed so that references to
      // declarations in the module's other files (including generated
      // sources) resolve; only the project's own files are indexed
      const moduleSources = amodule.sources.filter(isProjectSource);
      for (const afile of moduleSources.filter(isIndexableSource)) {
        indexFile(afile, [...moduleArgs[moduleName], ...moduleSources]);
      }
    }
    // Sources that belong to no known module, for example when the build
    // failed, are indexed with the merged arguments of the root modules
    let fallbackArgs = userCompilerArgs
      ? splitSwiftCommandArgs(`${userCompilerArgs} ${userSdkArgs || ""}`)
      : extractCompilerParamsFromBuild(
          buildOutput,
          packageMetadata?.rootModules,
        ).compilerArgs;
    if (!userCompilerArgs && !toolingAllowed) {
      fallbackArgs = withoutSwiftPluginArgs(fallbackArgs, toolchain?.sdkPath);
    }
    // Sources of test and dependency modules are never indexed
    const plannedSources = new Set();
    for (const amodule of Object.values(buildPlan.modules)) {
      for (const asource of amodule.sources) {
        plannedSources.add(canonicalPath(asource));
      }
    }
    for (const afile of getAllFiles(basePath, "**/*.swift", options)) {
      const canonicalFile = canonicalPath(afile);
      if (
        indexedFiles.has(canonicalFile) ||
        plannedSources.has(canonicalFile) ||
        !isIndexableSource(afile) ||
        relative(basePath, afile)
          .split(PATH_SEPARATORS)
          .some((segment) => segment.endsWith("Tests"))
      ) {
        continue;
      }
      indexFile(afile, [
        ...fallbackArgs,
        "-module-cache-path",
        moduleCachePath,
      ]);
    }
    // Attribute every resolved reference to its declaring module
    const allUsrs = new Set();
    for (const afileIndex of Object.values(fileIndexes)) {
      for (const ausr of Object.keys(afileIndex?.usrLines || {})) {
        allUsrs.add(ausr);
      }
    }
    const usrModules = resolveUsrModules(Array.from(allUsrs), swiftDir);
    for (const afile of Object.keys(fileIndexes)) {
      const afileIndex = fileIndexes[afile] || {};
      const moduleLines = {};
      const addLines = (moduleName, lines) => {
        if (!dependencyModules.has(moduleName)) {
          return;
        }
        if (!moduleLines[moduleName]) {
          moduleLines[moduleName] = new Set();
        }
        for (const aline of lines) {
          moduleLines[moduleName].add(aline);
        }
      };
      for (const [ausr, lines] of Object.entries(afileIndex.usrLines || {})) {
        const moduleName = usrModules.get(ausr);
        if (moduleName) {
          addLines(moduleName, lines);
        }
      }
      // Import declarations are evidence even when SourceKit could not load
      // the module, for example after a partial build
      let sourceText;
      try {
        sourceText = readFileSync(afile, { encoding: "utf-8" });
      } catch (_e) {
        sourceText = "";
      }
      for (const aimport of parseSwiftImports(sourceText)) {
        addLines(aimport.module, [aimport.line]);
      }
      const moduleReferences = {};
      for (const moduleName of Object.keys(moduleLines).sort()) {
        moduleReferences[moduleName] = Array.from(moduleLines[moduleName]).sort(
          (a, b) => a - b,
        );
      }
      afileIndex.moduleReferences = moduleReferences;
      delete afileIndex.usrLines;
      fileIndexes[afile] = afileIndex;
    }
  } finally {
    safeRmSync(moduleCachePath, { recursive: true, force: true });
  }
  return {
    projectPath: basePath,
    toolchain: toolchain?.compilerVersion,
    packageMetadata,
    packages,
    packageModules,
    buildSymbols: collectBuildSymbols(basePath, options, buildPlan.fileMaps),
    fileIndexes,
  };
}
