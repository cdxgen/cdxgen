import { compareVersions, extractJavaMajor, isPrereleaseVersion } from "./toolRequirements.js";
/**
 * The general-purpose version comparator, prerelease classifier, and JDK
 * major extractor live in `toolRequirements.js` so every ecosystem shares one
 * comparator; they are re-exported here under the names this module's
 * consumers already use.
 */
export { compareVersions as compareSdkmanVersions, extractJavaMajor, isPrereleaseVersion, };
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
export declare function isValidSdkmanVersion(version: string): boolean;
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
export declare function parseJvmToolProjectType(projectType: string): Object | undefined;
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
export declare function parseSdkmanrc(filePath: string): Object | undefined;
/**
 * Read the version pinned by a Gradle wrapper's `gradle-wrapper.properties`.
 * The `distributionUrl` value may escape colons as `\:` per the Java
 * properties format; the escapes are removed before parsing.
 *
 * @param {string} rootPath Directory holding the `gradle/wrapper` folder
 * @returns {Object|undefined} `{ version, distributionUrl, distributionSha256Sum? }`
 *   or `undefined` when the wrapper is missing or unparsable.
 */
export declare function readGradleWrapperVersion(rootPath: string): Object | undefined;
/**
 * Read the version pinned by a Maven wrapper's `maven-wrapper.properties`.
 * Legacy wrappers (pre wrapper-distribution downloads) lack a
 * `distributionUrl` and are treated as unpinned.
 *
 * @param {string} rootPath Directory holding the `.mvn/wrapper` folder
 * @returns {Object|undefined} `{ version, distributionUrl }` or `undefined`
 *   when the wrapper is missing or unpinned.
 */
export declare function readMavenWrapperVersion(rootPath: string): Object | undefined;
/**
 * Read the sbt version declared in `project/build.properties`. Kept here as a
 * small properties-file read so environment preparation does not depend on
 * higher layers.
 *
 * @param {string} projectPath SBT project directory
 * @returns {string|undefined} Declared sbt version, when present and valid.
 */
export declare function readSbtBuildPropertiesVersion(projectPath: string): string | undefined;
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
export declare const TOOL_JDK_REQUIREMENTS: Record<string, number | Record<number, number>>;
/**
 * Minimum Gradle version that supports a given JDK major, for the
 * combinations where running an older Gradle on a newer JDK is known to fail.
 * Used to warn instead of guess-installing when the environment contradicts
 * the project's Gradle pin.
 *
 * @type {Object<number, string>}
 */
export declare const GRADLE_JAVA_CAPS: Record<number, string>;
/** JDK major that satisfies every current build tool minimum. */
export declare const DEFAULT_JAVA_MAJOR = 21;
/**
 * Look up the minimum JDK major required to run a tool version.
 *
 * @param {string} tool Tool name (maven, gradle, sbt, scala)
 * @param {string} version Tool version identifier
 * @returns {number|undefined} Minimum JDK major, when known.
 */
export declare function minimumJdkForToolVersion(tool: string, version: string): number | undefined;
/**
 * Compute the highest JDK major required across a set of tool pins.
 *
 * @param {Array<{tool: string, version: string}>} toolPins Pinned tools
 * @returns {number|undefined} Highest required JDK major, when any pin maps.
 */
export declare function determineRequiredJavaVersion(toolPins: Array<{
    tool: string;
    version: string;
}>): number | undefined;
/**
 * Minimum Gradle version that can run on the given JDK major, when such a cap
 * is known.
 *
 * @param {number} javaMajor JDK major version
 * @returns {string|undefined} Minimum Gradle version, when capped.
 */
export declare function minimumGradleVersionForJava(javaMajor: number): string | undefined;
/**
 * Collect the version tokens printed by `sdk list <candidate>`. The output is
 * a fixed-width table whose cells may carry `+`, `*`, or `>` status markers;
 * every token that passes the sdkman version validator is kept, which
 * naturally drops banners, legends, and shell noise.
 *
 * @param {string} stdout Raw `sdk list` output
 * @returns {string[]} Version identifiers found in the output.
 */
export declare function extractSdkListVersions(stdout: string): string[];
/**
 * Resolve a partial version prefix such as `3.9` or `8.14` to the newest
 * matching version in `sdk list` output. Stable versions are preferred unless
 * the requested prefix itself is a prerelease.
 *
 * @param {string} stdout Raw `sdk list <candidate>` output
 * @param {string} prefix Partial or exact version prefix; empty matches all
 * @returns {string|undefined} Best matching version identifier.
 */
export declare function resolvePartialVersion(stdout: string, prefix: string): string | undefined;
/**
 * Environment variable hints that carry a tool version, used by container
 * images and CI setups to describe the preinstalled JVM toolchain.
 *
 * @type {Object<string, string>}
 */
export declare const JVM_TOOL_VERSION_ENV_HINTS: Record<string, string>;
/**
 * Environment variable overrides that declare the sdkman version to use for
 * a tool, mirroring the existing `JAVA<NN>_TOOL` pattern.
 *
 * @type {Object<string, string>}
 */
export declare const JVM_TOOL_VERSION_OVERRIDES: Record<string, string>;
/**
 * Read the `MAVEN_TOOL`/`GRADLE_TOOL`/`SBT_TOOL`/`SCALA_TOOL` override for a
 * tool, when set to a valid sdkman version identifier.
 *
 * @param {string} tool Tool name
 * @returns {string|undefined} Overridden version identifier.
 */
export declare function readToolVersionOverride(tool: string): string | undefined;
/**
 * Read the container/CI version hint (`MAVEN_VERSION` etc.) for a tool, when
 * set to a valid sdkman version identifier.
 *
 * @param {string} tool Tool name
 * @returns {string|undefined} Hinted version identifier.
 */
export declare function readToolVersionEnvHint(tool: string): string | undefined;
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
export declare function detectProjectJavaMajor(projectPath: string): number | undefined;
//# sourceMappingURL=jvmToolEnv.d.ts.map