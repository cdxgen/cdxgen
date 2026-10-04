/**
 * Pure reader for JSON compilation databases (`compile_commands.json`).
 *
 * Each entry names a translation unit (`file`), the directory its command ran
 * in (`directory`) and the command, either as an argument list (`arguments`)
 * or as one command line (`command`) split with the quoting rules of the
 * shell it was written for. From the entries this module derives the
 * compilers a build uses, the include directories each unit is compiled
 * with, and the security-hardening options in effect.
 *
 * Layer 1: data in, data out. Locating and reading the file, and running a
 * compiler to learn its version, belong to the callers.
 */

import { basename, isAbsolute, join, normalize } from "node:path";

/** Launchers that run the compiler named by the next argument. */
const COMPILER_LAUNCHERS = new Set([
  "ccache",
  "sccache",
  "distcc",
  "icecc",
  "buildcache",
  "env",
]);

/**
 * Split a POSIX shell command line into words: single quotes keep everything
 * literally, double quotes keep everything except `\"`, `\\`, `\$` and
 * `` \` ``, and a backslash outside quotes escapes the next character.
 *
 * @param {string} command Command line
 * @returns {string[]} Words
 */
export function splitPosixCommand(command) {
  const words = [];
  let current = "";
  let inWord = false;
  let quote = "";
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote === "'") {
      if (c === "'") {
        quote = "";
      } else {
        current += c;
      }
      continue;
    }
    if (quote === '"') {
      if (c === '"') {
        quote = "";
      } else if (
        c === "\\" &&
        i + 1 < command.length &&
        '"\\$`'.includes(command[i + 1])
      ) {
        current += command[++i];
      } else {
        current += c;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === "\\" && i + 1 < command.length) {
      current += command[++i];
      inWord = true;
    } else if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      if (inWord) {
        words.push(current);
        current = "";
        inWord = false;
      }
    } else {
      current += c;
      inWord = true;
    }
  }
  if (inWord) {
    words.push(current);
  }
  return words;
}

/**
 * Split a Windows command line into words as the Microsoft C runtime does:
 * double quotes group, `\"` is a literal quote, and backslashes are literal
 * unless they precede a quote.
 *
 * @param {string} command Command line
 * @returns {string[]} Words
 */
export function splitWindowsCommand(command) {
  const words = [];
  let current = "";
  let inWord = false;
  let inQuotes = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "\\") {
      let slashes = 0;
      while (i < command.length && command[i] === "\\") {
        slashes++;
        i++;
      }
      if (i < command.length && command[i] === '"') {
        current += "\\".repeat(Math.floor(slashes / 2));
        if (slashes % 2 === 1) {
          current += '"';
        } else {
          inQuotes = !inQuotes;
        }
      } else {
        current += "\\".repeat(slashes);
        i--;
      }
      inWord = true;
    } else if (c === '"') {
      inQuotes = !inQuotes;
      inWord = true;
    } else if ((c === " " || c === "\t") && !inQuotes) {
      if (inWord) {
        words.push(current);
        current = "";
        inWord = false;
      }
    } else {
      current += c;
      inWord = true;
    }
  }
  if (inWord) {
    words.push(current);
  }
  return words;
}

/** The file name of a driver path, lower case, without `.exe`. */
function driverName(driver) {
  const name = basename(`${driver}`.replaceAll("\\", "/")).toLowerCase();
  return name.endsWith(".exe") ? name.slice(0, -4) : name;
}

/**
 * The compiler family a driver's name implies.
 *
 * @param {string} driver Driver path or name
 * @returns {string} `msvc`, `clang-cl`, `clang`, `gcc`, `nvcc`, `icx`,
 *   `icc`, `nvhpc`, `edg` or `unknown`
 */
export function compilerFamilyOfName(driver) {
  const name = driverName(driver);
  if (name === "cl") {
    return "msvc";
  }
  if (name === "clang-cl" || name.endsWith("-clang-cl")) {
    return "clang-cl";
  }
  if (name === "nvcc") {
    return "nvcc";
  }
  if (["icx", "icpx", "icx-cl", "dpcpp"].includes(name)) {
    return "icx";
  }
  if (["icc", "icpc", "icl"].includes(name)) {
    return "icc";
  }
  if (["nvc", "nvc++", "pgcc", "pgc++"].includes(name)) {
    return "nvhpc";
  }
  if (["cpfe", "eccp", "edgcpfe"].includes(name)) {
    return "edg";
  }
  if (name.includes("clang")) {
    return "clang";
  }
  if (
    name.includes("gcc") ||
    name.includes("g++") ||
    name === "cc" ||
    name === "c++" ||
    name.endsWith("-cc") ||
    name.endsWith("-c++")
  ) {
    return "gcc";
  }
  return "unknown";
}

/** Families whose drivers take MSVC-style options. */
const MSVC_STYLE = new Set(["msvc", "clang-cl"]);

/**
 * The argument list of a database entry, with any compiler launcher
 * (`ccache`, `sccache`, ...) removed so the first argument is the compiler.
 *
 * @param {Object} entry Database entry
 * @returns {string[]} Arguments
 */
export function entryArguments(entry) {
  let args;
  if (Array.isArray(entry?.arguments)) {
    args = entry.arguments.filter((a) => typeof a === "string");
  } else if (typeof entry?.command === "string") {
    const firstWord = entry.command.trimStart().split(/\s/, 1)[0] || "";
    const family = compilerFamilyOfName(firstWord.replaceAll('"', ""));
    args = MSVC_STYLE.has(family)
      ? splitWindowsCommand(entry.command)
      : splitPosixCommand(entry.command);
  } else {
    return [];
  }
  let start = 0;
  while (
    start < args.length - 1 &&
    COMPILER_LAUNCHERS.has(driverName(args[start]))
  ) {
    start++;
    // `env NAME=value cc ...`
    while (
      start < args.length - 1 &&
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[start])
    ) {
      start++;
    }
  }
  return args.slice(start);
}

/**
 * The language a unit is compiled as: from `-x`/`/TP`/`/TC`, the driver
 * name, then the file extension.
 *
 * @param {string[]} args Arguments, compiler first
 * @param {string} file Translation unit
 * @returns {string} `c`, `c++`, `cuda` or `unknown`
 */
export function unitLanguage(args, file) {
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    const value =
      a === "-x" ? args[i + 1] : a.startsWith("-x") ? a.slice(2) : undefined;
    if (value) {
      if (value.startsWith("c++")) {
        return "c++";
      }
      if (value === "c" || value.startsWith("c-")) {
        return "c";
      }
      if (value === "cuda") {
        return "cuda";
      }
    }
    if (a === "/TP" || a === "-TP") {
      return "c++";
    }
    if (a === "/TC" || a === "-TC") {
      return "c";
    }
  }
  const name = driverName(args[0] || "");
  if (name === "nvcc") {
    return "cuda";
  }
  if (name.includes("++") || name.endsWith("cpp") || name === "icpc") {
    return "c++";
  }
  const lower = `${file || ""}`.toLowerCase();
  const dot = lower.lastIndexOf(".");
  const ext = dot >= 0 ? lower.slice(dot) : "";
  if (ext === ".c") {
    return `${file}`.endsWith(".C") ? "c++" : "c";
  }
  if (ext === ".cu") {
    return "cuda";
  }
  if ([".cc", ".cpp", ".cxx", ".c++", ".cppm", ".ixx", ".mm"].includes(ext)) {
    return "c++";
  }
  return "unknown";
}

/**
 * The include directories a unit is compiled with, as absolute paths.
 *
 * @param {string[]} args Arguments, compiler first
 * @param {string} directory The entry's working directory
 * @returns {string[]} Directories, in command order
 */
export function includeDirectories(args, directory) {
  const msvc = MSVC_STYLE.has(compilerFamilyOfName(args[0] || ""));
  const dirs = [];
  const add = (d) => {
    if (!d) {
      return;
    }
    const unquoted = d.replaceAll('"', "");
    dirs.push(
      normalize(
        isAbsolute(unquoted) || !directory
          ? unquoted
          : join(directory, unquoted),
      ),
    );
  };
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    for (const option of ["-iquote", "-isystem", "-idirafter", "-I"]) {
      if (a === option) {
        add(args[++i]);
        break;
      }
      if (a.startsWith(option)) {
        add(a.slice(option.length).replace(/^=/, ""));
        break;
      }
    }
    if (msvc && (a.startsWith("/I") || a.startsWith("/external:I"))) {
      const option = a.startsWith("/I") ? "/I" : "/external:I";
      if (a === option) {
        add(args[++i]);
      } else {
        add(a.slice(option.length));
      }
    }
  }
  return dirs;
}

/**
 * The security-hardening settings an argument list turns on or off. Later
 * options override earlier ones, as they do for the compiler.
 *
 * @param {string[]} args Compiler or linker arguments
 * @returns {Map<string, string>} Setting name to value:
 *   `fortifySource` (level), `stackProtector` (`on`, `strong`, `all`,
 *   `off`), `pie` (`on`/`off`), `relro` (`partial`/`full`, from `-z relro`
 *   and `-z now`), `cfProtection` (`full`, `branch`, `return`, `none`),
 *   `sanitizers` (comma-separated), `glibcxxAssertions` (`on`),
 *   `stackClashProtection` (`on`/`off`), `msvcBufferSecurityCheck` (`/GS`
 *   `on`/`off`), `msvcControlFlowGuard` (`on`/`off`)
 */
export function hardeningSettings(args) {
  const settings = new Map();
  const sanitizers = new Set();
  let relro = false;
  let now = false;
  const linkerWords = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("-Wl,")) {
      linkerWords.push(...a.slice(4).split(","));
      continue;
    }
    if (a === "-z" && i + 1 < args.length) {
      linkerWords.push("-z", args[++i]);
      continue;
    }
    const define =
      a === "-D" || a === "/D"
        ? args[i + 1]
        : /^[-/]D/.test(a)
          ? a.slice(2)
          : undefined;
    if (define !== undefined) {
      if (a === "-D" || a === "/D") {
        i++;
      }
      const [name, value] = define.split("=", 2);
      if (name === "_FORTIFY_SOURCE") {
        settings.set("fortifySource", value === undefined ? "1" : value);
      } else if (name === "_GLIBCXX_ASSERTIONS") {
        settings.set("glibcxxAssertions", "on");
      }
      continue;
    }
    if (/^[-/]U_FORTIFY_SOURCE$/.test(a)) {
      settings.delete("fortifySource");
      continue;
    }
    if (a === "-fstack-protector") {
      settings.set("stackProtector", "on");
    } else if (a === "-fstack-protector-strong") {
      settings.set("stackProtector", "strong");
    } else if (a === "-fstack-protector-all") {
      settings.set("stackProtector", "all");
    } else if (a === "-fno-stack-protector") {
      settings.set("stackProtector", "off");
    } else if (a === "-fPIE" || a === "-fpie" || a === "-pie") {
      settings.set("pie", "on");
    } else if (a === "-fno-pie" || a === "-fno-PIE" || a === "-no-pie") {
      settings.set("pie", "off");
    } else if (a === "-fcf-protection") {
      settings.set("cfProtection", "full");
    } else if (a.startsWith("-fcf-protection=")) {
      settings.set("cfProtection", a.slice("-fcf-protection=".length));
    } else if (a.startsWith("-fsanitize=")) {
      for (const s of a.slice("-fsanitize=".length).split(",")) {
        if (s) {
          sanitizers.add(s);
        }
      }
    } else if (a.startsWith("-fno-sanitize=")) {
      for (const s of a.slice("-fno-sanitize=".length).split(",")) {
        sanitizers.delete(s);
      }
    } else if (a === "-fstack-clash-protection") {
      settings.set("stackClashProtection", "on");
    } else if (a === "-fno-stack-clash-protection") {
      settings.set("stackClashProtection", "off");
    } else if (a === "/GS" || a === "-GS") {
      settings.set("msvcBufferSecurityCheck", "on");
    } else if (a === "/GS-" || a === "-GS-") {
      settings.set("msvcBufferSecurityCheck", "off");
    } else if (a === "/guard:cf" || a === "-guard:cf") {
      settings.set("msvcControlFlowGuard", "on");
    } else if (a === "/guard:cf-" || a === "-guard:cf-") {
      settings.set("msvcControlFlowGuard", "off");
    }
  }
  for (let i = 0; i < linkerWords.length; i++) {
    const w = linkerWords[i];
    const z =
      w === "-z"
        ? linkerWords[++i]
        : w.startsWith("-z")
          ? w.slice(2)
          : undefined;
    if (z === "relro") {
      relro = true;
    } else if (z === "norelro") {
      relro = false;
      now = false;
    } else if (z === "now") {
      now = true;
    } else if (w === "-pie" || w === "--pie") {
      settings.set("pie", "on");
    }
  }
  if (relro) {
    settings.set("relro", now ? "full" : "partial");
  }
  if (sanitizers.size) {
    settings.set("sanitizers", [...sanitizers].sort().join(","));
  }
  return settings;
}

/**
 * Summarise a compilation database.
 *
 * @param {Object[]} entries Parsed database (a JSON array)
 * @returns {{
 *   units: number,
 *   compilers: Map<string, {driver: string, family: string, units: number, languages: Set<string>}>,
 *   includeDirectories: Set<string>,
 *   hardening: Map<string, Map<string, number>>,
 * }} `compilers` is keyed by the driver as written; `hardening` maps each
 *   setting to the number of units per value
 */
export function summarizeCompileDatabase(entries) {
  const compilers = new Map();
  const dirs = new Set();
  const hardening = new Map();
  let units = 0;
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const args = entryArguments(entry);
    if (!args.length) {
      continue;
    }
    units++;
    const driver = args[0];
    const known = compilers.get(driver) || {
      driver,
      family: compilerFamilyOfName(driver),
      units: 0,
      languages: new Set(),
    };
    known.units++;
    const language = unitLanguage(args, entry.file);
    if (language !== "unknown") {
      known.languages.add(language);
    }
    compilers.set(driver, known);
    const directory =
      typeof entry.directory === "string" ? entry.directory : "";
    for (const d of includeDirectories(args, directory)) {
      dirs.add(d);
    }
    for (const [setting, value] of hardeningSettings(args.slice(1))) {
      const counts = hardening.get(setting) || new Map();
      counts.set(value, (counts.get(value) || 0) + 1);
      hardening.set(setting, counts);
    }
  }
  return { units, compilers, includeDirectories: dirs, hardening };
}

/**
 * Read a compiler's family and version from what it prints for `--version`
 * (or, for MSVC, on start-up).
 *
 * @param {string} banner Output of the version query
 * @param {string} [nameFamily] Family implied by the driver's name
 * @returns {{family: string, version: string|undefined, edgFrontEnd: boolean}}
 */
export function classifyCompilerBanner(banner, nameFamily = "unknown") {
  const text = `${banner || ""}`;
  const firstLine = text.split(/\r?\n/).find((l) => l.trim().length) || "";
  const edgFrontEnd = text.includes("Edison Design Group");
  let family = nameFamily;
  if (text.includes("Microsoft (R) C/C++")) {
    family = "msvc";
  } else if (firstLine.startsWith("Apple clang")) {
    family = "apple-clang";
  } else if (firstLine.includes("clang version")) {
    // clang-cl prints clang's banner
    family = nameFamily === "clang-cl" ? "clang-cl" : "clang";
  } else if (text.includes("Cuda compilation tools")) {
    family = "nvcc";
  } else if (text.includes("Intel(R) oneAPI")) {
    family = "icx";
  } else if (/^ic(c|pc) \(ICC\)/.test(firstLine)) {
    family = "icc";
  } else if (/^nvc\+?\+? /.test(firstLine) || firstLine.startsWith("pgc")) {
    family = "nvhpc";
  } else if (/\(GCC\)|^gcc |^g\+\+ |Free Software Foundation/.test(text)) {
    family = "gcc";
  } else if (edgFrontEnd) {
    family = "edg";
  }
  return { family, version: versionOf(text, family), edgFrontEnd };
}

/** The first dotted version in the banner line that names the compiler. */
function versionOf(text, family) {
  const lines = text.split(/\r?\n/);
  const pick =
    family === "nvcc"
      ? lines.find((l) => l.includes("release")) || ""
      : family === "msvc"
        ? lines.find((l) => l.includes("Version")) || ""
        : lines.find((l) => l.trim().length) || "";
  const words = pick.replaceAll(",", " ").split(/\s+/);
  for (const w of family === "gcc" ? [...words].reverse() : words) {
    const v = w.replace(/^V/, "");
    if (/^\d+(\.\d+)+/.test(v)) {
      return v.match(/^\d+(\.\d+)+/)[0];
    }
  }
  return undefined;
}
