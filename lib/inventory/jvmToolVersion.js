// The version of the Maven, Gradle or sbt a run executed, for the tool entry
// of `metadata.tools`. The registry of executed tools learns a tool's name
// when its process starts, but only a pin from the project or a build tool
// cdxgen provisioned carries a version, so a Maven found on the PATH was
// recorded as `{"name": "mvn"}` (issue #4862).
//
// The version is read, in this order, from the real path of the executable
// (sdkman's candidates/maven/3.9.9, Homebrew's Cellar/maven/3.9.9, an unpacked
// apache-maven-3.9.9 or gradle-8.14 directory), from the wrapper the project
// carries, and last from the name of the jar under the distribution's lib
// directory (maven-core-3.9.9.jar, gradle-launcher-8.14.jar). Nothing is
// executed: a wrapper would download its distribution, and the launchers of
// Maven, Gradle and sbt start a JVM.

import { readdirSync, realpathSync, statSync } from "node:fs";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  resolve,
} from "node:path";

import { readEnvironmentVariable } from "../core/activity.js";
import { readScanFileText } from "../core/boundedFile.js";
import { isWin } from "../core/paths.js";

const TOOL_PRODUCTS = {
  mvn: { directory: "maven", prefix: "apache-maven-" },
  mvnw: { directory: "maven", prefix: "apache-maven-" },
  gradle: { directory: "gradle", prefix: "gradle-" },
  gradlew: { directory: "gradle", prefix: "gradle-" },
  sbt: { directory: "sbt", prefix: "sbt-" },
};
const MAX_PROPERTIES_BYTES = 64 * 1024;
const VERSION_RE = /^\d+(?:\.\d+){0,3}(?:-(?:rc|beta|alpha|m)-?\d+)?$/i;

function toolNameOf(name) {
  const base = basename(`${name}`.split("\\").join("/"));
  for (const suffix of [".exe", ".cmd", ".bat"]) {
    if (base.endsWith(suffix)) {
      return base.slice(0, -suffix.length);
    }
  }
  return base;
}

function resolveCommand(command, cwd) {
  const name = `${command || ""}`;
  if (!name) {
    return undefined;
  }
  const directories =
    isAbsolute(name) || name.includes("/") || name.includes("\\")
      ? [dirname(resolve(cwd || ".", name))]
      : `${readEnvironmentVariable("PATH") || ""}`
          .split(delimiter)
          .filter(Boolean);
  const base = basename(name);
  const extensions = isWin ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = join(directory, `${base}${extension}`);
      try {
        if (statSync(candidate).isFile()) {
          return { path: candidate, real: realpathSync(candidate) };
        }
      } catch {
        // not here
      }
    }
  }
  return undefined;
}

/**
 * The version a path names: the directory under `candidates/<tool>` of
 * sdkman, `Cellar/<tool>` of Homebrew, or a directory named like the
 * distribution (`apache-maven-3.9.9`, `gradle-8.14`).
 *
 * @param {string} realPath real path of the executable
 * @param {string} tool tool name, such as `mvn`
 * @returns {string|undefined} version, or undefined
 */
export function versionFromToolPath(realPath, tool) {
  const product = TOOL_PRODUCTS[toolNameOf(tool)];
  if (!product || typeof realPath !== "string") {
    return undefined;
  }
  // Only the directories at or above the tool's own bin directory describe
  // the installation; a checkout folder next to a wrapper, such as
  // gradle-8.14/app/gradlew, describes nothing.
  const all = realPath.split(/[\\/]+/);
  const binIndex = all.lastIndexOf("bin");
  if (binIndex === -1) {
    return undefined;
  }
  const parts = all.slice(0, binIndex);
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    const next = parts[index + 1] ?? "";
    if (
      part === product.directory &&
      ["candidates", "Cellar"].includes(parts[index - 1])
    ) {
      if (VERSION_RE.test(next)) {
        return next;
      }
    }
    if (part.startsWith(product.prefix)) {
      const candidate = part.slice(product.prefix.length);
      if (VERSION_RE.test(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

function wrapperDistributionVersion(text, prefix) {
  for (const line of `${text || ""}`.split(/\r?\n/)) {
    if (!line.startsWith("distributionUrl")) {
      continue;
    }
    const file = line
      .slice(line.indexOf("=") + 1)
      .split("/")
      .pop();
    const at = file.indexOf(prefix);
    if (at === -1) {
      continue;
    }
    const rest = file.slice(at + prefix.length);
    const end = rest.indexOf("-bin");
    const candidate = end === -1 ? rest : rest.slice(0, end);
    if (VERSION_RE.test(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function versionFromWrapper(directory, tool) {
  const name = toolNameOf(tool);
  const read = (file) =>
    readScanFileText(join(directory, file), MAX_PROPERTIES_BYTES, directory);
  if (name === "mvnw") {
    return wrapperDistributionVersion(
      read(".mvn/wrapper/maven-wrapper.properties"),
      "apache-maven-",
    );
  }
  if (name === "gradlew") {
    return wrapperDistributionVersion(
      read("gradle/wrapper/gradle-wrapper.properties"),
      "gradle-",
    );
  }
  return undefined;
}

// The jar every Maven and Gradle distribution carries names its version:
// lib/maven-core-3.9.9.jar, lib/gradle-launcher-8.14.jar. A distro package
// links the unversioned name to the versioned jar, so the link is followed.
const LIBRARY_JARS = {
  mvn: "maven-core-",
  gradle: "gradle-launcher-",
};

function versionFromInstallLibraries(realPath, tool) {
  const prefix = LIBRARY_JARS[toolNameOf(tool)];
  if (!prefix) {
    return undefined;
  }
  const libDirectory = join(dirname(dirname(realPath)), "lib");
  const candidates = [];
  try {
    for (const name of readdirSync(libDirectory)) {
      if (name.startsWith(prefix) && name.endsWith(".jar")) {
        candidates.push(name);
      }
    }
    for (const name of readdirSync(libDirectory)) {
      if (name === `${prefix.slice(0, -1)}.jar`) {
        candidates.push(basename(realpathSync(join(libDirectory, name))));
      }
    }
  } catch {
    return undefined;
  }
  for (const name of candidates) {
    const candidate = name.slice(prefix.length, -".jar".length);
    if (name.startsWith(prefix) && VERSION_RE.test(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Resolve the version of an executed JVM build tool.
 *
 * @param {string} tool tool name as the registry keys it (`mvn`, `gradle`,
 *   `sbt`, or a wrapper)
 * @param {{command?: string, cwd?: string}} [invocation] how it was invoked
 * @returns {string|undefined} version, or undefined when none is known
 */
export function resolveJvmToolVersion(tool, invocation = {}) {
  const name = toolNameOf(tool);
  const product = TOOL_PRODUCTS[name];
  if (!product) {
    return undefined;
  }
  const resolved = resolveCommand(invocation.command || tool, invocation.cwd);
  if (resolved) {
    // A wrapper runs the distribution it pins, whatever its folder is called
    const fromWrapper = versionFromWrapper(dirname(resolved.path), name);
    if (fromWrapper) {
      return fromWrapper;
    }
    const fromPath =
      versionFromToolPath(resolved.real, name) ||
      versionFromToolPath(resolved.path, name);
    if (fromPath) {
      return fromPath;
    }
  }
  return resolved
    ? versionFromInstallLibraries(resolved.real, name)
    : undefined;
}
