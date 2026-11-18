// Java4Shell (CVE-2026-114938, issue #4862): the HotSpot C2 Base64 decode
// intrinsic overflows its output buffer on x86-64 CPUs with AVX-512 VBMI. A
// JDK is exposed when it is OpenJDK 17.0.6 or later from any vendor and runs
// on a CPU with avx512f, avx512bw, avx512vbmi and bmi2; ARM64 is not
// affected. The only workaround known is -XX:-UseBASE64Intrinsics. cdxgen
// warns about an exposed JDK and never adds a JVM flag to the user's builds.

import { closeSync, openSync, readSync } from "node:fs";
import process from "node:process";

import { readEnvironmentVariable } from "../core/activity.js";
import { compareVersions, extractJavaMajor } from "./toolRequirements.js";

const REQUIRED_CPU_FLAGS = ["avx512f", "avx512bw", "avx512vbmi", "bmi2"];
const MAX_CPUINFO_BYTES = 64 * 1024;
const FLAG = "-XX:-UseBASE64Intrinsics";

let warned = false;

/**
 * The first affected release of the advisory: OpenJDK 17.0.6. Every later
 * feature release is affected as well, so the bound is open-ended.
 */
export const JAVA4SHELL_FIRST_AFFECTED = Object.freeze({
  major: 17,
  update: 6,
});

/**
 * Builds that fix the defect, one entry per feature release:
 * `{ major: 21, version: "21.0.14" }` makes every 21.x JDK below that version
 * affected and that version and later not. Empty until vendors publish
 * fixed builds; the range above stays open-ended until then.
 *
 * @type {{major: number, version: string}[]}
 */
export const JAVA4SHELL_FIXED_VERSIONS = [];

/**
 * Whether a JDK version lies in the range the advisory names: 17.0.6 and
 * later, which includes every later feature release, minus the fixed builds.
 *
 * @param {string|undefined} version JAVA_VERSION such as `21.0.5` or `1.8.0_504`
 * @returns {boolean}
 */
export function isJava4ShellAffectedVersion(version) {
  const major = extractJavaMajor(`${version || ""}`);
  if (major === undefined || major < JAVA4SHELL_FIRST_AFFECTED.major) {
    return false;
  }
  if (major === JAVA4SHELL_FIRST_AFFECTED.major) {
    const update = Number.parseInt(`${version}`.split(".")[2], 10);
    if (Number.isNaN(update) || update < JAVA4SHELL_FIRST_AFFECTED.update) {
      return false;
    }
  }
  const fixed = JAVA4SHELL_FIXED_VERSIONS.find(
    (entry) => entry.major === major,
  );
  return !(fixed && compareVersions(`${version}`, fixed.version) >= 0);
}

const AFFECTED_ARCHITECTURES = new Set(["x86_64", "amd64", "x64"]);

/**
 * The exposure of a JDK to the Base64 intrinsic defect, before looking at
 * the JVM options of any process: `not-affected` for a JDK before 17.0.6, a
 * fixed build, a VM other than HotSpot (OpenJ9 and Semeru have no C2 Base64
 * intrinsic), or a CPU architecture other than x86-64, and `exposed`
 * otherwise. An unknown architecture stays `exposed`.
 *
 * @param {{version: string, vm?: string, arch?: string, vendor?: {key: string}}} identity
 *   JDK identity
 * @returns {"exposed"|"not-affected"}
 */
export function java4ShellExposure(identity) {
  if (
    (identity?.vm && identity.vm !== "hotspot") ||
    identity?.vendor?.key === "semeru"
  ) {
    return "not-affected";
  }
  const arch = `${identity?.arch || ""}`.toLowerCase();
  if (arch && !AFFECTED_ARCHITECTURES.has(arch)) {
    return "not-affected";
  }
  return isJava4ShellAffectedVersion(identity?.version)
    ? "exposed"
    : "not-affected";
}

/**
 * Whether the text of /proc/cpuinfo lists every CPU feature the overflow
 * needs on its first `flags` line.
 *
 * @param {string|undefined} cpuinfo text of /proc/cpuinfo
 * @returns {boolean}
 */
export function cpuHasAvx512Vbmi(cpuinfo) {
  for (const line of `${cpuinfo || ""}`.split("\n")) {
    if (!line.startsWith("flags")) {
      continue;
    }
    const flags = new Set(
      line
        .slice(line.indexOf(":") + 1)
        .trim()
        .split(/\s+/),
    );
    return REQUIRED_CPU_FLAGS.every((flag) => flags.has(flag));
  }
  return false;
}

function readCpuInfo() {
  let descriptor;
  try {
    descriptor = openSync("/proc/cpuinfo", "r");
    const buffer = Buffer.alloc(MAX_CPUINFO_BYTES);
    const read = readSync(descriptor, buffer, 0, MAX_CPUINFO_BYTES, 0);
    return buffer.toString("utf8", 0, read);
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // already closed
      }
    }
  }
}

/**
 * The warning for a JDK that Java4Shell can hit on this host, or undefined.
 *
 * @param {Object} identity JDK identity from jdkIdentity.js
 * @param {Object} [host] overrides for tests: `platform`, `arch`, `cpuinfo`
 *   and `options`, the text of the JVM option variables
 * @returns {string|undefined}
 */
export function java4ShellWarning(identity, host = {}) {
  const platform = host.platform || process.platform;
  const arch = host.arch || process.arch;
  if (
    !identity ||
    platform !== "linux" ||
    arch !== "x64" ||
    java4ShellExposure(identity) !== "exposed"
  ) {
    return undefined;
  }
  const options =
    host.options ??
    ["JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS", "_JAVA_OPTIONS"]
      .map((name) => readEnvironmentVariable(name) || "")
      .join(" ");
  if (jvmOptionsMitigate(parseJvmPathOptions(options))) {
    return undefined;
  }
  if (!cpuHasAvx512Vbmi(host.cpuinfo ?? readCpuInfo())) {
    return undefined;
  }
  return `WARNING: the JDK in use (${identity.vendor?.label || "OpenJDK"} ${identity.version}${identity.build ? `+${identity.build}` : ""}) is affected by Java4Shell (CVE-2026-114938) on this AVX-512 VBMI host. Set JAVA_TOOL_OPTIONS="-XX:+IgnoreUnrecognizedVMOptions ${FLAG}" and run gradle --stop to restart any running daemon.`;
}

/**
 * Print the Java4Shell warning once per run.
 *
 * @param {Object} identity JDK identity from jdkIdentity.js
 */
export function warnIfJava4ShellExposed(identity) {
  if (warned) {
    return;
  }
  const message = java4ShellWarning(identity);
  if (message) {
    warned = true;
    console.warn(message);
  }
}

// The only JVM options recorded from a command line. Every other option,
// -D values above all, can hold a password.
const BASE64_OPTION = /^-XX:([+-])UseBASE64Intrinsics$/;
const AVX_OPTION = /^-XX:UseAVX=([0-3])$/;
// Launcher options that take their value as the next token.
const OPTIONS_WITH_ARGUMENT = new Set([
  "-cp",
  "-classpath",
  "--class-path",
  "-p",
  "--module-path",
  "--upgrade-module-path",
  "--add-modules",
  "--limit-modules",
  "--patch-module",
  "--add-reads",
  "--add-exports",
  "--add-opens",
  "--enable-native-access",
  "--source",
]);

/**
 * Read the two options that change the vulnerable path from the command line
 * of a java process: `-XX:-UseBASE64Intrinsics` and `-XX:UseAVX=<0-3>`. The
 * tokens may come from the command line itself or from the text of a
 * JAVA_TOOL_OPTIONS or JDK_JAVA_OPTIONS assignment in it. The last
 * occurrence of an option wins, as in the JVM.
 *
 * @param {string|undefined} cmdline command line text
 * @returns {{UseBASE64Intrinsics?: string, UseAVX?: string}} the options set,
 *   as `true`/`false` and `0` to `3`
 */
export function parseJvmPathOptions(cmdline) {
  const options = {};
  const tokens = `${cmdline || ""}`.split(/\s+/).filter(Boolean);
  const launcher = tokens.findIndex((token) =>
    ["java", "java.exe"].includes(token.split(/[\\/]/).pop()),
  );
  // Options come before the main class or the argument of -jar, -m and
  // --module; whatever follows belongs to the application. Text without a
  // launcher, such as the value of JAVA_TOOL_OPTIONS, is all options.
  let afterLauncher = false;
  let skipNext = false;
  for (let index = 0; index < tokens.length; index++) {
    if (index === launcher) {
      afterLauncher = true;
      continue;
    }
    const token = tokens[index]
      .replace(/^[A-Z_]+=/, "")
      .replace(/^["']+|["']+$/g, "");
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (afterLauncher) {
      if (OPTIONS_WITH_ARGUMENT.has(token)) {
        skipNext = true;
        continue;
      }
      if (!token.startsWith("-") && !token.startsWith("@")) {
        break;
      }
      if (["-jar", "-m", "--module"].includes(token)) {
        break;
      }
    }
    const base64 = BASE64_OPTION.exec(token);
    if (base64) {
      options.UseBASE64Intrinsics = base64[1] === "-" ? "false" : "true";
      continue;
    }
    const avx = AVX_OPTION.exec(token);
    if (avx) {
      options.UseAVX = avx[1];
    }
  }
  return options;
}

/**
 * Whether the options of a process switch the vulnerable path off: the
 * intrinsic is disabled, or AVX is capped below AVX-512 (`UseAVX` 0 to 2).
 *
 * @param {{UseBASE64Intrinsics?: string, UseAVX?: string}} options result of
 *   parseJvmPathOptions
 * @returns {boolean}
 */
export function jvmOptionsMitigate(options) {
  return (
    options?.UseBASE64Intrinsics === "false" ||
    (options?.UseAVX !== undefined && Number(options.UseAVX) < 3)
  );
}
