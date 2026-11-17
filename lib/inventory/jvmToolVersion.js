// The version of the Maven, Gradle or sbt a run executed, for the tool entry
// of `metadata.tools`. The registry of executed tools learns a tool's name
// when its process starts, but only a pin from the project or a build tool
// cdxgen provisioned carries a version, so a Maven found on the PATH was
// recorded as `{"name": "mvn"}` (issue #4862).
//
// The version is read, in this order, from the real path of the executable
// (sdkman's candidates/maven/3.9.9, Homebrew's Cellar/maven/3.9.9, an unpacked
// apache-maven-3.9.9 or gradle-8.14 directory), from the wrapper the project
// carries, and, for a plain mvn or gradle only, from the one line of
// `--version`, run in a temporary directory so a project's `.mvn` or
// `gradle.properties` cannot influence it. A wrapper is never run, because
// it would download the distribution, and sbt is never run, because its
// launcher starts a JVM and the build's own `project/build.properties` names
// its version.

import { realpathSync, statSync } from "node:fs";
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
import { getTmpDir, safeSpawnSync } from "../core/fs.js";
import { isWin } from "../core/paths.js";

const TOOL_PRODUCTS = {
  mvn: { directory: "maven", prefix: "apache-maven-", banner: "Apache Maven" },
  mvnw: { directory: "maven", prefix: "apache-maven-" },
  gradle: { directory: "gradle", prefix: "gradle-", banner: "Gradle" },
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
  const parts = realPath.split(/[\\/]+/);
  for (let index = 0; index + 1 < parts.length; index++) {
    const part = parts[index];
    const next = parts[index + 1];
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
    const fromPath =
      versionFromToolPath(resolved.real, name) ||
      versionFromToolPath(resolved.path, name);
    if (fromPath) {
      return fromPath;
    }
    const fromWrapper = versionFromWrapper(dirname(resolved.path), name);
    if (fromWrapper) {
      return fromWrapper;
    }
  }
  if (!resolved || !product.banner) {
    return undefined;
  }
  const result = safeSpawnSync(resolved.path, ["--version"], {
    cwd: getTmpDir(),
    encoding: "utf-8",
    shell: isWin,
    timeout: 20000,
  });
  if (result?.status !== 0) {
    return undefined;
  }
  for (const line of `${result.stdout || ""}`.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith(`${product.banner} `)) {
      const token = trimmed.slice(product.banner.length + 1).split(/\s+/)[0];
      if (VERSION_RE.test(token)) {
        return token;
      }
    }
  }
  return undefined;
}
