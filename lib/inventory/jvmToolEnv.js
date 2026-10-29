import { readFileSync } from "node:fs";
import { join } from "node:path";

import { readEnvironmentVariable } from "../core/activity.js";
import { JVM_BUILD_TOOL_TYPE_PREFIXES } from "../core/env.js";
import { safeExistsSync } from "../core/fs.js";
import {
  compareVersions,
  extractJavaMajor,
  isPrereleaseVersion,
} from "./toolRequirements.js";

/**
 * The general-purpose version comparator, prerelease classifier, and JDK
 * major extractor live in `toolRequirements.js` so every ecosystem shares one
 * comparator; they are re-exported here under the names this module's
 * consumers already use.
 */
export {
  compareVersions as compareSdkmanVersions,
  extractJavaMajor,
  isPrereleaseVersion,
};

/**
 * Upper bound on the `.sdkmanrc` content that is scanned, so that a corrupt or
 * hostile file cannot force cdxgen to walk unbounded content.
 *
 * @type {number}
 */
const MAX_SDKMANRC_BYTES = 64 * 1024;

/**
 * Maximum accepted length for a single sdkman version identifier.
 *
 * @type {number}
 */
const MAX_VERSION_TOKEN_LENGTH = 64;

/**
 * sdkman candidate names that cdxgen can provision for JVM builds. The keys
 * are the canonical candidate identifiers used with `sdk install <candidate>`.
 */
const JVM_BUILD_TOOL_CANDIDATES = ["maven", "gradle", "sbt", "scala"];

/**
 * Anchored validator for sdkman version identifiers such as `3.9.9`,
 * `4.0.0-rc-5`, `8.14`, `21.0.7-tem`, or `26.0.2+1.1-tem`. Versions are
 * interpolated into a shell command by the sdkman installer, so every
 * identifier must be a single safe token: it must start with a digit and may
 * only contain digits, ascii letters, dots, hyphens, and plus signs (`+` has
 * no shell meaning and sdkman uses it in Temurin respin identifiers).
 *
 * Every separator must be followed by at least one alphanumeric character, and
 * a single repeated group covers both the dotted numeric part and the vendor
 * or prerelease suffix. That leaves each character exactly one role, so the
 * pattern matches in linear time on untrusted input.
 *
 * @param {string} version Candidate version identifier
 * @returns {boolean} True when the identifier is safe to pass to sdkman
 */
export function isValidSdkmanVersion(version) {
  return (
    typeof version === "string" &&
    version.length > 0 &&
    version.length <= MAX_VERSION_TOKEN_LENGTH &&
    /^\d+(?:[-.+][0-9A-Za-z]+)*$/.test(version)
  );
}

/**
 * Parse a versioned JVM build tool project type such as `maven3.9.9`,
 * `mvn3.9.9`, `gradle8.14`, `sbt1.10`, or `scala3.6.4` into its sdkman
 * candidate name and version token.
 *
 * The returned object distinguishes between a syntactically valid pin and a
 * rejected one so callers can print a precise CLI error instead of silently
 * ignoring the type.
 *
 * @param {string} projectType Project type argument from the CLI
 * @returns {Object|undefined} `{ tool, version, valid }` when the type looks
 *   like a versioned JVM build tool, `undefined` otherwise. `valid` is false
 *   when the version token fails validation.
 */
export function parseJvmToolProjectType(projectType) {
  const pt = `${projectType || ""}`.toLowerCase();
  for (const prefix of JVM_BUILD_TOOL_TYPE_PREFIXES) {
    if (!pt.startsWith(prefix)) {
      continue;
    }
    const version = pt.slice(prefix.length);
    if (!/^\d/.test(version)) {
      // Bare aliases such as "maven" or unrelated types are not versioned pins.
      continue;
    }
    const tool = prefix === "mvn" ? "maven" : prefix;
    return { tool, version, valid: isValidSdkmanVersion(version) };
  }
  return undefined;
}

/**
 * Parse a `.sdkmanrc` environment file into the sdkman candidates it pins.
 * Only the JVM-related candidates cdxgen knows how to provision are kept;
 * unknown keys are ignored so newer sdkman files remain readable. Malformed
 * lines are skipped instead of aborting the whole file.
 *
 * @param {string} filePath Project directory that may contain a `.sdkmanrc`
 * @returns {Object|undefined} Map of candidate name to exact version
 *   identifier, or `undefined` when the file is missing or unreadable.
 */
export function parseSdkmanrc(filePath) {
  const sdkmanrcFile = join(filePath, ".sdkmanrc");
  if (!safeExistsSync(sdkmanrcFile)) {
    return undefined;
  }
  let content;
  try {
    content = readFileSync(sdkmanrcFile, {
      encoding: "utf-8",
      flag: "r",
    }).slice(0, MAX_SDKMANRC_BYTES);
  } catch (_e) {
    return undefined;
  }
  const pins = {};
  const acceptedCandidates = new Set(["java", ...JVM_BUILD_TOOL_CANDIDATES]);
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) {
      continue;
    }
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const candidate = line.slice(0, separatorIndex).trim().toLowerCase();
    const version = line.slice(separatorIndex + 1).trim();
    if (!acceptedCandidates.has(candidate)) {
      continue;
    }
    if (!isValidSdkmanVersion(version)) {
      continue;
    }
    if (candidate === "java" && !version.includes("-")) {
      // sdkman java identifiers carry a vendor suffix, e.g. 21.0.7-tem. A
      // bare number such as "21" is not installable, so skip it.
      continue;
    }
    pins[candidate] = version;
  }
  return Object.keys(pins).length ? pins : undefined;
}

/**
 * Read the version pinned by a Gradle wrapper's `gradle-wrapper.properties`.
 * The `distributionUrl` value may escape colons as `\:` per the Java
 * properties format; the escapes are removed before parsing.
 *
 * @param {string} rootPath Directory holding the `gradle/wrapper` folder
 * @returns {Object|undefined} `{ version, distributionUrl, distributionSha256Sum? }`
 *   or `undefined` when the wrapper is missing or unparsable.
 */
export function readGradleWrapperVersion(rootPath) {
  const wrapperPropsFile = join(
    rootPath,
    "gradle",
    "wrapper",
    "gradle-wrapper.properties",
  );
  if (!safeExistsSync(wrapperPropsFile)) {
    return undefined;
  }
  let propContent;
  try {
    propContent = readFileSync(wrapperPropsFile, {
      encoding: "utf-8",
      flag: "r",
    });
  } catch (_e) {
    return undefined;
  }
  const properties = parsePropertiesContent(propContent);
  const distributionUrl = properties.distributionUrl?.replaceAll("\\:", ":");
  if (!distributionUrl) {
    return undefined;
  }
  const version = extractVersionFromZipBasename(distributionUrl);
  if (!version) {
    return undefined;
  }
  const wrapperInfo = { version, distributionUrl };
  const distributionSha256Sum = properties.distributionSha256Sum;
  // The checksum is copied into the BOM as a CycloneDX hash, whose schema
  // accepts hex digests only. Anything else in the properties file is dropped
  // rather than emitted as a hash that would fail validation downstream.
  if (/^[a-fA-F0-9]{64}$/.test(`${distributionSha256Sum}`)) {
    wrapperInfo.distributionSha256Sum = distributionSha256Sum;
  }
  return wrapperInfo;
}

/**
 * Read the version pinned by a Maven wrapper's `maven-wrapper.properties`.
 * Legacy wrappers (pre wrapper-distribution downloads) lack a
 * `distributionUrl` and are treated as unpinned.
 *
 * @param {string} rootPath Directory holding the `.mvn/wrapper` folder
 * @returns {Object|undefined} `{ version, distributionUrl }` or `undefined`
 *   when the wrapper is missing or unpinned.
 */
export function readMavenWrapperVersion(rootPath) {
  const wrapperPropsFile = join(
    rootPath,
    ".mvn",
    "wrapper",
    "maven-wrapper.properties",
  );
  if (!safeExistsSync(wrapperPropsFile)) {
    return undefined;
  }
  let propContent;
  try {
    propContent = readFileSync(wrapperPropsFile, {
      encoding: "utf-8",
      flag: "r",
    });
  } catch (_e) {
    return undefined;
  }
  const properties = parsePropertiesContent(propContent);
  const distributionUrl = properties.distributionUrl?.replaceAll("\\:", ":");
  if (!distributionUrl) {
    return undefined;
  }
  const version = extractVersionFromZipBasename(distributionUrl);
  if (!version) {
    return undefined;
  }
  return { version, distributionUrl };
}

/**
 * Read the sbt version declared in `project/build.properties`. Kept here as a
 * small properties-file read so environment preparation does not depend on
 * higher layers.
 *
 * @param {string} projectPath SBT project directory
 * @returns {string|undefined} Declared sbt version, when present and valid.
 */
export function readSbtBuildPropertiesVersion(projectPath) {
  const buildPropsFile = join(projectPath, "project", "build.properties");
  if (!safeExistsSync(buildPropsFile)) {
    return undefined;
  }
  let propContent;
  try {
    propContent = readFileSync(buildPropsFile, {
      encoding: "utf-8",
      flag: "r",
    });
  } catch (_e) {
    return undefined;
  }
  const sbtVersion = parsePropertiesContent(propContent)["sbt.version"];
  return isValidSdkmanVersion(sbtVersion) ? sbtVersion : undefined;
}

/**
 * Parse the text content of a Java `.properties` file into a flat map. Only
 * the keys cdxgen consumes are of interest, so a line-based parse with
 * `key=value` splitting is sufficient and avoids regex-heavy parsing of
 * untrusted files.
 *
 * @param {string} content Properties file content
 * @returns {Object} Map of property name to raw value
 */
function parsePropertiesContent(content) {
  const properties = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) {
      continue;
    }
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (key && !(key in properties)) {
      properties[key] = value;
    }
  }
  return properties;
}

/**
 * Extract a version identifier from the basename of a distribution zip such
 * as `gradle-8.14.3-bin.zip` or `apache-maven-3.9.9-bin.zip` using token
 * splits instead of a capture-everything regex.
 *
 * @param {string} url Distribution URL
 * @returns {string|undefined} Validated version identifier.
 */
function extractVersionFromZipBasename(url) {
  const pathSeparatorIndex = Math.max(
    url.lastIndexOf("/"),
    url.lastIndexOf("\\"),
  );
  const basename =
    pathSeparatorIndex >= 0 ? url.slice(pathSeparatorIndex + 1) : url;
  for (const token of basename.split("-")) {
    if (/^\d/.test(token) && isValidSdkmanVersion(token)) {
      return token;
    }
  }
  return undefined;
}

/**
 * Minimum JDK major version required to run each build tool, keyed by the
 * tool's major version line. Versions absent from the table fall back to the
 * tool's `default` entry.
 *
 * Sources: Maven release history (maven.apache.org/docs/history.html), the
 * Gradle compatibility table (docs.gradle.org), and the sbt setup notes.
 *
 * @type {Object<string, Object<number, number>|number>}
 */
export const TOOL_JDK_REQUIREMENTS = {
  maven: { default: 8, 3: 8, 4: 17 },
  gradle: { default: 8, 8: 8, 9: 17 },
  sbt: { default: 8, 1: 8, 2: 17 },
  scala: { default: 8, 2: 8, 3: 8 },
};

/**
 * Minimum Gradle version that supports a given JDK major, for the
 * combinations where running an older Gradle on a newer JDK is known to fail.
 * Used to warn instead of guess-installing when the environment contradicts
 * the project's Gradle pin.
 *
 * @type {Object<number, string>}
 */
export const GRADLE_JAVA_CAPS = {
  17: "7.3",
  21: "8.5",
  23: "8.10",
  25: "9.1.0",
  26: "9.4.0",
  27: "9.8.0",
};

/** JDK major that satisfies every current build tool minimum. */
export const DEFAULT_JAVA_MAJOR = 21;

/**
 * Look up the minimum JDK major required to run a tool version.
 *
 * @param {string} tool Tool name (maven, gradle, sbt, scala)
 * @param {string} version Tool version identifier
 * @returns {number|undefined} Minimum JDK major, when known.
 */
export function minimumJdkForToolVersion(tool, version) {
  const toolRequirements = TOOL_JDK_REQUIREMENTS[`${tool}`.toLowerCase()];
  if (!toolRequirements || !isValidSdkmanVersion(`${version}`)) {
    return undefined;
  }
  const major = Number.parseInt(`${version}`, 10);
  if (Number.isNaN(major)) {
    return undefined;
  }
  return toolRequirements[major] ?? toolRequirements.default;
}

/**
 * Compute the highest JDK major required across a set of tool pins.
 *
 * @param {Array<{tool: string, version: string}>} toolPins Pinned tools
 * @returns {number|undefined} Highest required JDK major, when any pin maps.
 */
export function determineRequiredJavaVersion(toolPins) {
  let required;
  for (const pin of toolPins || []) {
    const minimum = minimumJdkForToolVersion(pin?.tool, pin?.version);
    if (
      minimum !== undefined &&
      (required === undefined || minimum > required)
    ) {
      required = minimum;
    }
  }
  return required;
}

/**
 * Minimum Gradle version that can run on the given JDK major, when such a cap
 * is known.
 *
 * @param {number} javaMajor JDK major version
 * @returns {string|undefined} Minimum Gradle version, when capped.
 */
export function minimumGradleVersionForJava(javaMajor) {
  return GRADLE_JAVA_CAPS[javaMajor];
}

/**
 * Pick the newest stable Gradle version from `sdk list` output that can run on
 * the given JDK major. Without a known cap this is the newest stable version,
 * matching the plain default install; with a cap, versions below it are
 * skipped so a project that declared a new JDK never gets a Gradle that
 * refuses to run on it, even when the sdkman list is stale.
 *
 * @param {string} stdout Raw `sdk list gradle` output
 * @param {number|undefined} javaMajor JDK major the Gradle daemon must run on
 * @returns {string|undefined} Best matching version identifier.
 */
export function resolveGradleVersionForJava(stdout, javaMajor) {
  const minimum = minimumGradleVersionForJava(javaMajor);
  if (!minimum) {
    return resolvePartialVersion(stdout, "");
  }
  let best;
  for (const version of extractSdkListVersions(stdout)) {
    if (isPrereleaseVersion(version) || compareVersions(version, minimum) < 0) {
      continue;
    }
    if (best === undefined || compareVersions(version, best) > 0) {
      best = version;
    }
  }
  return best;
}

/**
 * Collect the version tokens printed by `sdk list <candidate>`. The output is
 * a fixed-width table whose cells may carry `+`, `*`, or `>` status markers;
 * every token that passes the sdkman version validator is kept, which
 * naturally drops banners, legends, and shell noise.
 *
 * @param {string} stdout Raw `sdk list` output
 * @returns {string[]} Version identifiers found in the output.
 */
export function extractSdkListVersions(stdout) {
  if (typeof stdout !== "string") {
    return [];
  }
  const versions = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    for (const token of rawLine.trim().split(/\s+/)) {
      const cleaned = token.replace(/^[+*>]+/, "");
      if (cleaned && isValidSdkmanVersion(cleaned)) {
        versions.push(cleaned);
      }
    }
  }
  return versions;
}

/**
 * Resolve a partial version prefix such as `3.9` or `8.14` to the newest
 * matching version in `sdk list` output. Stable versions are preferred unless
 * the requested prefix itself is a prerelease.
 *
 * @param {string} stdout Raw `sdk list <candidate>` output
 * @param {string} prefix Partial or exact version prefix; empty matches all
 * @returns {string|undefined} Best matching version identifier.
 */
export function resolvePartialVersion(stdout, prefix) {
  const versions = extractSdkListVersions(stdout);
  const wantedPrefix = `${prefix || ""}`;
  const allowPrerelease = isPrereleaseVersion(wantedPrefix);
  let best;
  for (const version of versions) {
    const matches =
      !wantedPrefix ||
      version === wantedPrefix ||
      version.startsWith(`${wantedPrefix}.`) ||
      version.startsWith(`${wantedPrefix}-`);
    if (!matches) {
      continue;
    }
    if (!allowPrerelease && isPrereleaseVersion(version)) {
      continue;
    }
    if (best === undefined || compareVersions(version, best) > 0) {
      best = version;
    }
  }
  return best;
}

/**
 * Environment variable hints that carry a tool version, used by container
 * images and CI setups to describe the preinstalled JVM toolchain.
 *
 * @type {Object<string, string>}
 */
export const JVM_TOOL_VERSION_ENV_HINTS = {
  maven: "MAVEN_VERSION",
  gradle: "GRADLE_VERSION",
  sbt: "SBT_VERSION",
  scala: "SCALA_VERSION",
};

/**
 * Environment variable overrides that declare the sdkman version to use for
 * a tool, mirroring the existing `JAVA<NN>_TOOL` pattern.
 *
 * @type {Object<string, string>}
 */
export const JVM_TOOL_VERSION_OVERRIDES = {
  maven: "MAVEN_TOOL",
  gradle: "GRADLE_TOOL",
  sbt: "SBT_TOOL",
  scala: "SCALA_TOOL",
};

/**
 * Read the `MAVEN_TOOL`/`GRADLE_TOOL`/`SBT_TOOL`/`SCALA_TOOL` override for a
 * tool, when set to a valid sdkman version identifier.
 *
 * @param {string} tool Tool name
 * @returns {string|undefined} Overridden version identifier.
 */
export function readToolVersionOverride(tool) {
  const envName = JVM_TOOL_VERSION_OVERRIDES[tool];
  if (!envName) {
    return undefined;
  }
  const value = readEnvironmentVariable(envName);
  return isValidSdkmanVersion(value) ? value : undefined;
}

/**
 * Read the container/CI version hint (`MAVEN_VERSION` etc.) for a tool, when
 * set to a valid sdkman version identifier.
 *
 * @param {string} tool Tool name
 * @returns {string|undefined} Hinted version identifier.
 */
export function readToolVersionEnvHint(tool) {
  const envName = JVM_TOOL_VERSION_ENV_HINTS[tool];
  if (!envName) {
    return undefined;
  }
  const value = readEnvironmentVariable(envName);
  return isValidSdkmanVersion(value) ? value : undefined;
}

/**
 * Well-known build files scanned for the JDK major a project targets.
 *
 * @type {string[]}
 */
const JAVA_BUILD_FILES = ["build.gradle", "build.gradle.kts", "pom.xml"];

/**
 * Detect the JDK major a project asks for from its build files: Gradle
 * toolchain declarations (`JavaLanguageVersion.of(N)`) and Maven compiler or
 * enforcer properties (`maven.compiler.release`, `maven.compiler.source`,
 * `requireJavaVersion`). The scan is intentionally line-based and
 * conservative: it only recognises whole-number values.
 *
 * @param {string} projectPath Project directory
 * @returns {number|undefined} JDK major requested by the project.
 */
export function detectProjectJavaMajor(projectPath) {
  if (!projectPath) {
    return undefined;
  }
  for (const buildFileName of JAVA_BUILD_FILES) {
    const buildFile = join(projectPath, buildFileName);
    if (!safeExistsSync(buildFile)) {
      continue;
    }
    let content;
    try {
      content = readFileSync(buildFile, { encoding: "utf-8", flag: "r" });
    } catch (_e) {
      continue;
    }
    const detected = scanBuildFileForJavaMajor(content);
    if (detected !== undefined) {
      return detected;
    }
  }
  return undefined;
}

/**
 * Scan Gradle or Maven build file content for the JDK major it targets.
 *
 * @param {string} content Build file content
 * @returns {number|undefined} JDK major, when recognisable.
 */
function scanBuildFileForJavaMajor(content) {
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    let match = line.match(/JavaLanguageVersion\.of\((\d{1,2})\)/);
    if (match) {
      return Number.parseInt(match[1], 10);
    }
    match = line.match(
      /<(?:maven\.compiler\.release|maven\.compiler\.source|release|source)>(?:1\.)?(\d{1,2})</,
    );
    if (match) {
      return Number.parseInt(match[1], 10);
    }
    // Enforcer requireJavaVersion ranges such as <version>[17,)</version>.
    // Dependency and plugin version ranges share this element name, so only
    // values that are plausible JDK majors are accepted.
    match = line.match(/<version>\[(?:1\.)?(\d{1,2})[,)\]]/);
    if (match) {
      const major = Number.parseInt(match[1], 10);
      if (major >= 8) {
        return major;
      }
    }
  }
  return undefined;
}
