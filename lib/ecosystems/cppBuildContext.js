/**
 * How a C/C++ project is built: its CMake configure presets, the compilers
 * its compilation database or configured build tree names, the
 * security-hardening options it is compiled and linked with, and which of the
 * headers it includes are its own.
 *
 * The presets and compilers become formulation components, the hardening
 * options properties of the project component, and the project's own include
 * directories let the include analysis tell first-party headers from
 * dependencies.
 *
 * Layer 3: this module reads the build tree and may run a compiler (only
 * `--version`, only outside secure mode, only a GCC, Clang, MSVC, Intel,
 * NVIDIA or EDG driver found on the PATH or named by an absolute path outside
 * the project).
 */

import {
  accessSync,
  constants,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  basename,
  delimiter,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

import {
  DEBUG_MODE,
  isSecureMode,
  readEnvironmentVariable,
} from "../core/activity.js";
import { safeExistsSync, safeSpawnSync } from "../core/fs.js";
import { isWin } from "../core/paths.js";
import { findCompileCommands } from "../inventory/atomUtils.js";
import {
  isInsideDir,
  readCmakeConfigurePresets,
} from "../inventory/cmakeBuildDirs.js";
import {
  parseCmakeCache,
  parseCmakeCompilerFile,
} from "../parsers/cmakeCache.js";
import {
  classifyCompilerBanner,
  hardeningSettings,
  splitPosixCommand,
  summarizeCompileDatabase,
} from "../parsers/compileCommands.js";
import { readJsonFile } from "../parsers/largeJson.js";
import { detectCmakeBuildDir } from "./cmakeResolver.js";

/** At most this many distinct compilers are asked for their version. */
const MAX_VERSION_QUERIES = 16;

/** A version query that has not answered by then is abandoned. */
const VERSION_QUERY_TIMEOUT_MS = 20000;

/** Cache variables whose flags describe how every unit is compiled or linked. */
const CACHE_FLAG_VARIABLES = [
  "CMAKE_C_FLAGS",
  "CMAKE_CXX_FLAGS",
  "CMAKE_EXE_LINKER_FLAGS",
  "CMAKE_SHARED_LINKER_FLAGS",
];

/** Hardening settings decided at link time, which a compilation database cannot show. */
const LINK_TIME_SETTINGS = new Set(["relro"]);

const EMPTY_CONTEXT = Object.freeze({
  formulationComponents: [],
  parentProperties: [],
  firstPartyIncludeDirs: [],
  compileDatabase: undefined,
  isFirstPartyHeader: () => false,
});

/**
 * The empty build context, for scans that are not of a source tree.
 *
 * @returns {Object}
 */
export function emptyCppBuildContext() {
  return EMPTY_CONTEXT;
}

function isDirectory(p) {
  try {
    return statSync(p).isDirectory();
  } catch (_err) {
    return false;
  }
}

function repoRelative(p, root) {
  if (!p || !isInsideDir(p, root)) {
    return undefined;
  }
  return relative(root, resolve(p)).split("\\").join("/") || ".";
}

function isTruthyCmake(value) {
  return ["1", "ON", "YES", "TRUE", "Y"].includes(
    `${value ?? ""}`.toUpperCase(),
  );
}

function flagWords(value) {
  if (!value) {
    return [];
  }
  return value.includes('"') || value.includes("'")
    ? splitPosixCommand(value)
    : value.split(/\s+/).filter(Boolean);
}

/** Hardening settings spelled by CMake flag variables. */
function hardeningOfFlagVariables(variables) {
  const words = [];
  for (const name of CACHE_FLAG_VARIABLES) {
    words.push(...flagWords(variables[name]));
  }
  const buildType = `${variables.CMAKE_BUILD_TYPE || ""}`.toUpperCase();
  if (buildType) {
    for (const name of CACHE_FLAG_VARIABLES) {
      words.push(...flagWords(variables[`${name}_${buildType}`]));
    }
  }
  return hardeningSettings(words);
}

function hardeningProperties(settings, prefix = "cdx:cpp:hardening:") {
  return [...settings.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([setting, value]) => ({ name: `${prefix}${setting}`, value }));
}

/** A configure preset as a formulation component. */
function presetComponent(preset, root) {
  const properties = [];
  const add = (name, value) => {
    if (value !== undefined && value !== null && `${value}`.length) {
      properties.push({ name, value: `${value}` });
    }
  };
  const vars = preset.cacheVariables || {};
  const env = preset.environment || {};
  add(
    "cdx:cmake:preset:file",
    repoRelative(preset.file, root) || basename(preset.file || ""),
  );
  add("cdx:cmake:preset:inherits", preset.inherits?.join(","));
  add("cdx:cmake:preset:generator", preset.generator);
  add("cdx:cmake:preset:binaryDir", repoRelative(preset.binaryDir, root));
  add("cdx:cmake:preset:buildType", vars.CMAKE_BUILD_TYPE);
  const compilerName = (v) =>
    v ? basename(`${v}`.replaceAll("\\", "/")) : undefined;
  add(
    "cdx:cmake:preset:cCompiler",
    compilerName(vars.CMAKE_C_COMPILER || env.CC),
  );
  add(
    "cdx:cmake:preset:cxxCompiler",
    compilerName(vars.CMAKE_CXX_COMPILER || env.CXX),
  );
  if (preset.toolchainFile) {
    const toolchain = isAbsolute(preset.toolchainFile)
      ? preset.toolchainFile
      : join(root, preset.toolchainFile);
    add(
      "cdx:cmake:preset:toolchainFile",
      repoRelative(toolchain, root) ||
        basename(preset.toolchainFile.replaceAll("\\", "/")),
    );
    if (
      basename(preset.toolchainFile.replaceAll("\\", "/")) === "vcpkg.cmake"
    ) {
      add("cdx:cmake:preset:vcpkg", "true");
    }
  }
  add("cdx:cmake:preset:vcpkgTriplet", vars.VCPKG_TARGET_TRIPLET);
  if (isTruthyCmake(vars.CMAKE_EXPORT_COMPILE_COMMANDS)) {
    add("cdx:cmake:preset:exportCompileCommands", "true");
  }
  if (preset.hasCondition) {
    add(
      "cdx:cmake:preset:hostCondition",
      preset.conditionMet === true
        ? "met"
        : preset.conditionMet === false
          ? "unmet"
          : "unknown",
    );
  }
  properties.push(...hardeningProperties(hardeningOfFlagVariables(vars)));
  const component = {
    type: "data",
    name: preset.name,
    "bom-ref": `cmake-preset:${preset.name}`,
    properties,
  };
  if (preset.displayName) {
    component.description = preset.displayName;
  }
  return component;
}

/** The compiler descriptions CMake wrote into a configured build tree. */
function cmakeCompilerFacts(buildDir) {
  const facts = [];
  const filesDir = join(buildDir, "CMakeFiles");
  let versionDirs = [];
  try {
    versionDirs = readdirSync(filesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d/.test(e.name))
      .map((e) => join(filesDir, e.name));
  } catch (_err) {
    return facts;
  }
  for (const dir of versionDirs) {
    let names = [];
    try {
      names = readdirSync(dir).filter(
        (n) => n.startsWith("CMake") && n.endsWith("Compiler.cmake"),
      );
    } catch (_err) {
      continue;
    }
    for (const name of names.sort()) {
      let text;
      try {
        text = readFileSync(join(dir, name), "utf-8");
      } catch (_err) {
        continue;
      }
      const fact = parseCmakeCompilerFile(text);
      if (fact) {
        facts.push(fact);
      }
    }
  }
  return facts;
}

/**
 * The executable a driver names, when it may be run: an absolute path, or a
 * command found on the PATH, that is a file outside the project. A relative
 * path, or anything inside the project tree, is never run, since a
 * compilation database can come with the code it describes.
 */
export function trustedCompilerPath(driver, root) {
  if (!driver) {
    return undefined;
  }
  // compare real paths: the project may be reached through a symbolic link
  // (macOS's /var is /private/var)
  let realRoot = resolve(root);
  try {
    realRoot = realpathSync(realRoot);
  } catch (_err) {
    // a root that does not exist contains nothing
  }
  let candidates;
  if (isAbsolute(driver)) {
    candidates = [driver];
  } else if (!driver.includes("/") && !driver.includes("\\")) {
    const suffixes = isWin ? ["", ".exe"] : [""];
    candidates = `${readEnvironmentVariable("PATH") || ""}`
      .split(delimiter)
      .filter(Boolean)
      .flatMap((dir) => suffixes.map((s) => join(dir, driver + s)));
  } else {
    return undefined;
  }
  for (const candidate of candidates) {
    try {
      if (!statSync(candidate).isFile()) {
        continue;
      }
      const real = realpathSync(candidate);
      if (isInsideDir(real, realRoot) || isInsideDir(candidate, root)) {
        continue;
      }
      if (!isWin) {
        accessSync(real, constants.X_OK);
      }
      return real;
    } catch (_err) {
      // not this one
    }
  }
  return undefined;
}

/** Ask a compiler what it is. */
function queryCompilerBanner(executable, family) {
  const result = safeSpawnSync(
    executable,
    family === "msvc" ? [] : ["--version"],
    {
      encoding: "utf-8",
      timeout: VERSION_QUERY_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    },
  );
  const text = `${result?.stdout || ""}\n${result?.stderr || ""}`.trim();
  return text.length ? text : undefined;
}

function compilerComponent(entry) {
  const properties = [
    { name: "cdx:cpp:compiler:family", value: entry.family },
    {
      name: "cdx:cpp:compiler:drivers",
      value: [...entry.drivers].sort().join(","),
    },
    { name: "cdx:cpp:compiler:identifiedBy", value: entry.identifiedBy },
  ];
  if (entry.languages.size) {
    properties.push({
      name: "cdx:cpp:compiler:languages",
      value: [...entry.languages].sort().join(","),
    });
  }
  if (entry.units) {
    properties.push({
      name: "cdx:cpp:compiler:units",
      value: `${entry.units}`,
    });
  }
  if (entry.edgFrontEnd) {
    properties.push({ name: "cdx:cpp:frontend", value: "edg" });
  }
  const component = {
    type: "platform",
    name: entry.family,
    "bom-ref": `cpp-compiler:${entry.family}@${entry.version || "unknown"}`,
    properties,
  };
  if (entry.version) {
    component.version = entry.version;
  }
  return component;
}

const CMAKE_LANGUAGES = {
  C: "c",
  CXX: "c++",
  CUDA: "cuda",
  OBJC: "objc",
  OBJCXX: "objc++",
};

/**
 * Identify the compilers of a build, from CMake's own descriptions where the
 * build tree has them and otherwise by asking the compiler.
 */
function identifyCompilers(summary, cmakeFacts, root) {
  const byKey = new Map();
  const note = (family, version, fields) => {
    const key = `${family}@${version || ""}`;
    const entry = byKey.get(key) || {
      family,
      version,
      drivers: new Set(),
      languages: new Set(),
      units: 0,
      identifiedBy: fields.identifiedBy,
      edgFrontEnd: false,
    };
    if (fields.driver) {
      entry.drivers.add(basename(fields.driver.replaceAll("\\", "/")));
    }
    for (const l of fields.languages || []) {
      entry.languages.add(l);
    }
    entry.units += fields.units || 0;
    entry.edgFrontEnd = entry.edgFrontEnd || !!fields.edgFrontEnd;
    byKey.set(key, entry);
  };
  const cmakeByPath = new Map();
  for (const fact of cmakeFacts) {
    let real = fact.compiler;
    try {
      real = realpathSync(fact.compiler);
    } catch (_err) {
      // a build tree from another machine
    }
    cmakeByPath.set(real, fact);
    note(fact.family, fact.version, {
      identifiedBy: "cmake",
      driver: fact.compiler,
      languages: [
        CMAKE_LANGUAGES[fact.language] || fact.language.toLowerCase(),
      ],
    });
  }
  let queries = 0;
  for (const compiler of summary?.compilers?.values() || []) {
    const located = trustedCompilerPath(compiler.driver, root);
    const known = located && cmakeByPath.get(located);
    if (known) {
      note(known.family, known.version, {
        identifiedBy: "cmake",
        driver: compiler.driver,
        languages: compiler.languages,
        units: compiler.units,
      });
      continue;
    }
    let banner;
    if (
      !isSecureMode &&
      located &&
      compiler.family !== "unknown" &&
      queries < MAX_VERSION_QUERIES
    ) {
      queries++;
      banner = queryCompilerBanner(located, compiler.family);
    }
    if (banner) {
      const { family, version, edgFrontEnd } = classifyCompilerBanner(
        banner,
        compiler.family,
      );
      note(family, version, {
        identifiedBy: "version-query",
        driver: compiler.driver,
        languages: compiler.languages,
        units: compiler.units,
        edgFrontEnd,
      });
    } else {
      note(compiler.family, undefined, {
        identifiedBy: "name",
        driver: compiler.driver,
        languages: compiler.languages,
        units: compiler.units,
      });
    }
  }
  return [...byKey.values()].map(compilerComponent);
}

/** The most common value of each hardening setting, with the units it covers. */
function databaseHardening(summary) {
  const properties = [];
  for (const [setting, counts] of [...summary.hardening.entries()].sort(
    ([a], [b]) => a.localeCompare(b),
  )) {
    const [value, units] = [...counts.entries()].sort(
      ([va, a], [vb, b]) => b - a || va.localeCompare(vb),
    )[0];
    properties.push({ name: `cdx:cpp:hardening:${setting}`, value });
    properties.push({
      name: `cdx:cpp:hardening:${setting}:units`,
      value: `${units}`,
    });
  }
  return properties;
}

/**
 * Resolve the build context of a C/C++ project.
 *
 * @param {string} path Project scan root
 * @param {Object} options CLI options
 * @param {Object} [cmakeContext] The CMake context (`boundaries` lists the
 *   source directories of fetched and submodule dependencies)
 * @param {string[]} [vendoredDirs] Directories of code the project carries
 *   under another license; their headers are not the project's own
 * @returns {{
 *   formulationComponents: Object[],
 *   parentProperties: Object[],
 *   firstPartyIncludeDirs: string[],
 *   compileDatabase: string|undefined,
 *   isFirstPartyHeader: function(string): boolean,
 * }}
 */
export function resolveCppBuildContext(
  path,
  options = {},
  cmakeContext = undefined,
  vendoredDirs = [],
) {
  const root = resolve(path);
  let isDir = false;
  try {
    isDir = statSync(root).isDirectory();
  } catch (_err) {
    isDir = false;
  }
  if (!isDir) {
    return EMPTY_CONTEXT;
  }
  const formulationComponents = [];
  const parentProperties = [];
  const presets = readCmakeConfigurePresets(root);
  for (const preset of presets) {
    formulationComponents.push(presetComponent(preset, root));
  }
  const detected = detectCmakeBuildDir(root, options);
  let cacheVariables = {};
  if (detected) {
    try {
      for (const [key, entry] of parseCmakeCache(
        readFileSync(detected.cacheFile, "utf-8"),
      )) {
        cacheVariables[key] = entry.value;
      }
    } catch (_err) {
      cacheVariables = {};
    }
    if (cacheVariables.CMAKE_BUILD_TYPE) {
      parentProperties.push({
        name: "cdx:cmake:buildType",
        value: cacheVariables.CMAKE_BUILD_TYPE,
      });
    }
  }
  const compileDatabase = findCompileCommands(root, options);
  let summary;
  if (compileDatabase) {
    try {
      summary = summarizeCompileDatabase(readJsonFile(compileDatabase));
    } catch (err) {
      if (DEBUG_MODE) {
        console.log(
          `Unable to read the compilation database ${compileDatabase}: ${err.message}`,
        );
      }
    }
  }
  const cmakeFacts = detected ? cmakeCompilerFacts(detected.buildDir) : [];
  formulationComponents.push(...identifyCompilers(summary, cmakeFacts, root));
  const sources = [];
  const cacheHardening = hardeningOfFlagVariables(cacheVariables);
  if (summary?.units) {
    parentProperties.push({
      name: "cdx:cpp:compileCommands:units",
      value: `${summary.units}`,
    });
    const fromDatabase = databaseHardening(summary);
    if (fromDatabase.length) {
      sources.push("compile-commands");
      parentProperties.push(...fromDatabase);
    }
    const linkTime = new Map(
      [...cacheHardening].filter(([setting]) =>
        LINK_TIME_SETTINGS.has(setting),
      ),
    );
    if (linkTime.size) {
      sources.push("cmake-cache");
      parentProperties.push(...hardeningProperties(linkTime));
    }
  } else if (cacheHardening.size) {
    sources.push("cmake-cache");
    parentProperties.push(...hardeningProperties(cacheHardening));
  }
  if (sources.length) {
    parentProperties.push({
      name: "cdx:cpp:hardening:source",
      value: sources.join(","),
    });
  }
  // paths are compared as real paths: the project may be reached through a
  // symbolic link, and atom reports the headers it resolved by real path
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch (_err) {
      return resolve(p);
    }
  };
  const realRoot = real(root);
  const dependencyDirs = [];
  for (const [dir, entry] of cmakeContext?.boundaries || []) {
    if (entry?.kind === "fetch" || entry?.kind === "submodule") {
      dependencyDirs.push(real(resolve(root, dir)));
    }
  }
  for (const dir of vendoredDirs || []) {
    dependencyDirs.push(real(resolve(root, dir)));
  }
  const isOwnPath = (p) => {
    const r = real(p);
    return (
      isInsideDir(r, realRoot) && !dependencyDirs.some((d) => isInsideDir(r, d))
    );
  };
  const firstPartyIncludeDirs = [...(summary?.includeDirectories || [])].filter(
    (d) => isDirectory(d) && isOwnPath(d),
  );
  // the project root, its database's include directories, and the include/
  // and src/ directories most projects keep their own headers in, which is
  // all there is to go on without a database
  const searchDirs = [
    ...new Set([
      root,
      ...firstPartyIncludeDirs,
      ...[join(root, "include"), join(root, "src")].filter(
        (d) => isDirectory(d) && isOwnPath(d),
      ),
    ]),
  ];
  const isFirstPartyHeader = (header) => {
    if (!header) {
      return false;
    }
    const normalized = `${header}`.replaceAll("\\", "/");
    const candidates = isAbsolute(normalized)
      ? [normalized]
      : searchDirs.map((d) => join(d, normalized));
    return candidates.some((c) => safeExistsSync(c) && isOwnPath(c));
  };
  return {
    formulationComponents,
    parentProperties,
    firstPartyIncludeDirs,
    compileDatabase,
    isFirstPartyHeader,
  };
}
