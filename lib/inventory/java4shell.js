// Java4Shell (CVE-2026-114938, issue #4862): the HotSpot C2 Base64 decode
// intrinsic overflows its output buffer on x86-64 CPUs with AVX-512 VBMI. A
// JDK is exposed when it is OpenJDK 17.0.6 or later from any vendor and runs
// on a CPU with avx512f, avx512bw, avx512vbmi and bmi2; ARM64 is not
// affected. The only workaround known is -XX:-UseBASE64Intrinsics. cdxgen
// warns about an exposed JDK and never adds a JVM flag to the user's builds.

import { closeSync, openSync, readSync } from "node:fs";
import process from "node:process";

import { readEnvironmentVariable } from "../core/activity.js";
import { extractJavaMajor } from "./toolRequirements.js";

const REQUIRED_CPU_FLAGS = ["avx512f", "avx512bw", "avx512vbmi", "bmi2"];
const MAX_CPUINFO_BYTES = 64 * 1024;
const FLAG = "-XX:-UseBASE64Intrinsics";

let warned = false;

/**
 * Whether a JDK version lies in the range the advisory names: 17.0.6 and
 * later, which includes every later feature release.
 *
 * @param {string|undefined} version JAVA_VERSION such as `21.0.5` or `1.8.0_504`
 * @returns {boolean}
 */
export function isJava4ShellAffectedVersion(version) {
  const major = extractJavaMajor(`${version || ""}`);
  if (major === undefined || major < 17) {
    return false;
  }
  if (major > 17) {
    return true;
  }
  const update = Number.parseInt(`${version}`.split(".")[2], 10);
  return Number.isNaN(update) ? false : update >= 6;
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
    !isJava4ShellAffectedVersion(identity.version)
  ) {
    return undefined;
  }
  const options =
    host.options ??
    ["JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS", "_JAVA_OPTIONS"]
      .map((name) => readEnvironmentVariable(name) || "")
      .join(" ");
  if (options.includes(FLAG)) {
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
