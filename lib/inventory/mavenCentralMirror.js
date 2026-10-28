import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { isSecureMode, readEnvironmentVariable } from "../core/activity.js";
import { parseMavenArgs } from "../core/env.js";
import {
  getTmpDir,
  safeExistsSync,
  safeMkdtempSync,
  safeRmSync,
  safeWriteSync,
} from "../core/fs.js";
import { registerRunReset } from "../core/runState.js";

/**
 * Opt-in switch that points every Maven Central consumer at Google's public
 * mirror: cdxgen's own POM, licence and metadata lookups, and every JVM build
 * tool cdxgen runs (Maven and its wrapper, Gradle, sbt, Mill, Bazel and the
 * Clojure tools). The value selects the mirror:
 *
 *   `true`/`google`  the global mirror bucket
 *   `eu`             the Europe bucket
 *   `asia`           the Asia bucket
 *   `http(s)://...`  any other mirror or repository manager of Maven Central
 *
 * An explicit `MAVEN_CENTRAL_URL` still wins for cdxgen's own lookups, and a
 * repository the user or the project already configures is never replaced:
 * only the default Maven Central URLs are moved. Nothing is written to the
 * scanned project or the user's home directory; the injection goes through
 * command-line arguments and environment variables, and any settings or init
 * script it needs is written under cdxgen's temp directory and removed again.
 */
export const MAVEN_CENTRAL_MIRROR_VAR = "MAVEN_CENTRAL_MIRROR";

/**
 * Google's public Maven Central mirror buckets, named by region.
 *
 * @type {Object<string, string>}
 */
export const MAVEN_CENTRAL_MIRROR_URLS = {
  google: "https://maven-central.storage-download.googleapis.com/maven2/",
  eu: "https://maven-central-eu.storage-download.googleapis.com/maven2/",
  asia: "https://maven-central-asia.storage-download.googleapis.com/maven2/",
};

/**
 * The default Maven Central repository URLs that the mirror replaces, for
 * tools that name repositories by URL.
 *
 * @type {string[]}
 */
export const MAVEN_CENTRAL_DEFAULT_URLS = [
  "https://repo1.maven.org/maven2/",
  "https://repo.maven.apache.org/maven2/",
];

/**
 * Read the mirror switch. Undefined when cdxgen should use Maven Central
 * itself, the mirror URL otherwise.
 *
 * @returns {string|undefined} Mirror base URL with a trailing slash
 */
export function mavenCentralMirrorUrl() {
  const value = readEnvironmentVariable(MAVEN_CENTRAL_MIRROR_VAR);
  if (!value || ["false", "0", "off", "no"].includes(value.toLowerCase())) {
    return undefined;
  }
  const key = value.toLowerCase();
  // A bare boolean turns the global bucket on.
  const named =
    MAVEN_CENTRAL_MIRROR_URLS[key] ||
    (["true", "1", "yes", "on"].includes(key)
      ? MAVEN_CENTRAL_MIRROR_URLS.google
      : undefined);
  if (named) {
    return named;
  }
  // Anything else must name a repository itself. A mirror URL is fetched and
  // downloaded from by JVM tools, so only http(s) is accepted.
  const trimmed = value.trim().endsWith("/")
    ? value.trim()
    : `${value.trim()}/`;
  return /^https?:\/\//.test(trimmed) ? trimmed : undefined;
}

/**
 * Whether the mirror switch is on. Names and URLs that do not resolve to a
 * mirror leave it off, so a typo never silently redirects builds.
 *
 * @returns {boolean}
 */
export function isMavenCentralMirrorEnabled() {
  return mavenCentralMirrorUrl() !== undefined;
}

/**
 * The repository cdxgen's own POM, licence and metadata lookups should fetch
 * from. An explicit `MAVEN_CENTRAL_URL` is a deliberate choice, often a
 * repository manager holding private artefacts, so it keeps winning over the
 * mirror.
 *
 * @returns {string|undefined} Mirror URL, or undefined to keep the existing
 *   `MAVEN_CENTRAL_URL` behaviour
 */
export function mavenCentralFetchUrl() {
  if (!isMavenCentralMirrorEnabled()) {
    return undefined;
  }
  if (readEnvironmentVariable("MAVEN_CENTRAL_URL")) {
    return undefined;
  }
  return mavenCentralMirrorUrl();
}

// ---------------------------------------------------------------------------
// Temp artifacts: one settings.xml / init.gradle / repositories file per
// process, written under cdxgen's temp directory and removed when the run
// ends. They only have to exist while the tool starts; the removal keeps a
// long-lived server from collecting them.
// ---------------------------------------------------------------------------

/** @type {Map<string, string>} Content key to the written file's path. */
const mirrorArtifacts = new Map();

registerRunReset("inventory.mavenCentralMirror", () => {
  for (const path of mirrorArtifacts.values()) {
    safeRmSync(path, { recursive: true, force: true });
  }
  mirrorArtifacts.clear();
});

function writeMirrorArtifact(key, prefix, content) {
  const existing = mirrorArtifacts.get(key);
  if (existing) {
    return existing;
  }
  const dir = safeMkdtempSync(join(getTmpDir(), prefix));
  const path = join(dir, "artifact");
  safeWriteSync(path, content);
  mirrorArtifacts.set(key, path);
  return path;
}

/**
 * Remove every mirror artifact this process wrote. Registered as a process
 * exit hook the first time an artifact is created, so short CLI runs clean up
 * even when they never reach a run reset.
 */
function cleanupMirrorArtifactsOnExit() {
  for (const path of mirrorArtifacts.values()) {
    try {
      safeRmSync(path, { recursive: true, force: true });
    } catch (_e) {
      // The temp directory is cleaned by the OS eventually.
    }
  }
  mirrorArtifacts.clear();
}

// ---------------------------------------------------------------------------
// Maven and the Maven wrapper
// ---------------------------------------------------------------------------

/**
 * The `<mirror>` element that remaps Maven Central, as a settings.xml
 * fragment. Declared last, so a mirror of Central that the user's own
 * settings.xml or the project's settings.xml already defines keeps winning.
 *
 * @param {string} mirrorUrl Mirror base URL
 * @returns {string}
 */
function mavenMirrorElement(mirrorUrl) {
  return (
    "<mirror><id>cdxgen-maven-central-mirror</id>" +
    "<name>cdxgen Maven Central mirror</name>" +
    `<url>${mirrorUrl}</url><mirrorOf>central</mirrorOf></mirror>`
  );
}

/**
 * Minimal settings.xml holding only the mirror. Maven still reads the user's
 * own settings.xml on top of a global settings file, so mirrors, profiles and
 * credentials defined there keep applying, and theirs win for Central.
 *
 * @param {string} mirrorUrl Mirror base URL
 * @returns {string}
 */
function standaloneMavenSettings(mirrorUrl) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n<settings xmlns="http://maven.apache.org/SETTINGS/1.2.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://maven.apache.org/SETTINGS/1.2.0 https://maven.apache.org/xsd/settings-1.2.0.xsd">\n<mirrors>\n' +
    mavenMirrorElement(mirrorUrl) +
    "\n</mirrors>\n</settings>\n"
  );
}

/**
 * Insert the mirror into the content of a settings file that is passed to
 * Maven anyway, keeping every other element as it is. The mirror is appended
 * to the existing ones, so the file's own mirror of Central still wins.
 *
 * @param {string} content Existing settings.xml content
 * @param {string} mirrorUrl Mirror base URL
 * @returns {string|undefined} Merged content, or undefined when the file
 *   holds no recognisable settings element to merge into
 */
export function mergeMavenMirrorSettings(content, mirrorUrl) {
  const mirror = mavenMirrorElement(mirrorUrl);
  if (content.includes("</mirrors>")) {
    return content.replace("</mirrors>", `${mirror}</mirrors>`);
  }
  if (content.includes("<mirrors/>")) {
    return content.replace("<mirrors/>", `<mirrors>${mirror}</mirrors>`);
  }
  if (content.includes("<mirrors>")) {
    // A mirrors element that never closes: leave the file alone rather than
    // produce a malformed one.
    return undefined;
  }
  if (content.includes("</settings>")) {
    return content.replace(
      "</settings>",
      `<mirrors>${mirror}</mirrors></settings>`,
    );
  }
  return undefined;
}

/**
 * Whether the user's own Maven arguments name a settings file, which must
 * keep winning over anything cdxgen generates.
 *
 * @returns {boolean}
 */
function userMavenArgsNameSettings() {
  const userArgs = ["MVN_ARGS", "MAVEN_ARGS"].flatMap((name) =>
    parseMavenArgs(readEnvironmentVariable(name)),
  );
  return userArgs.some(
    (arg) =>
      ["-s", "--settings", "-gs", "--global-settings"].includes(arg) ||
      arg.startsWith("--settings=") ||
      arg.startsWith("--global-settings="),
  );
}

/**
 * Extra Maven arguments that send Central to the mirror, written as a global
 * settings file under cdxgen's temp directory. An existing `-gs` settings
 * file named by the caller is merged with the mirror instead, so a project
 * that ships its own settings.xml keeps its repositories and its own mirror.
 * A settings file the user named themselves (in `MVN_ARGS`/`MAVEN_ARGS`) is
 * never touched, and neither is secure mode.
 *
 * @param {string} [existingSettingsFile] Settings file the caller already
 *   passes to Maven
 * @returns {string[]} Arguments to append to the Maven command line
 */
export function mavenMirrorSettingsArgs(existingSettingsFile) {
  const mirrorUrl = mavenCentralMirrorUrl();
  if (!mirrorUrl || isSecureMode || userMavenArgsNameSettings()) {
    return [];
  }
  let content = standaloneMavenSettings(mirrorUrl);
  let key = `maven|${mirrorUrl}`;
  if (existingSettingsFile && safeExistsSync(existingSettingsFile)) {
    let existing;
    try {
      existing = readFileSync(existingSettingsFile, "utf-8");
    } catch (_e) {
      return [];
    }
    const merged = mergeMavenMirrorSettings(existing, mirrorUrl);
    if (!merged) {
      return [];
    }
    content = merged;
    key = `maven|${mirrorUrl}|${existingSettingsFile}`;
  }
  const path = writeMirrorArtifact(key, "cdxgen-maven-mirror-", content);
  return ["-gs", path];
}

/**
 * Environment for a Maven or Maven wrapper invocation that moves the
 * wrapper's own distribution download off Maven Central. Plain `mvn`
 * invocations ignore it.
 *
 * @returns {Object} Environment variables to add to the child process
 */
export function mavenWrapperMirrorEnv() {
  const mirrorUrl = mavenCentralMirrorUrl();
  if (!mirrorUrl || isSecureMode) {
    return {};
  }
  // The wrapper appends org/apache/maven/... to this base, which the mirror
  // serves with the same layout. MVNW_REPOURL carries no trailing slash.
  return { MVNW_REPOURL: mirrorUrl.replace(/\/$/, "") };
}

// ---------------------------------------------------------------------------
// Gradle
// ---------------------------------------------------------------------------

/**
 * A Gradle init script that rewrites Maven Central repository URLs to the
 * mirror after the settings and projects are evaluated. Repositories that are
 * not Maven Central keep their URL, so private repositories and declared
 * mirrors are untouched.
 *
 * @param {string} mirrorUrl Mirror base URL
 * @returns {string}
 */
export function gradleMirrorInitScript(mirrorUrl) {
  const prefixes = JSON.stringify(MAVEN_CENTRAL_DEFAULT_URLS);
  return `// Generated by cdxgen: send Maven Central to a mirror.
def cdxgenMirrorUrl = '${mirrorUrl}'
def cdxgenCentralPrefixes = ${prefixes}
def cdxgenSwapCentral = { repositoryContainer ->
    if (repositoryContainer == null) {
        return
    }
    repositoryContainer.findAll { it instanceof MavenArtifactRepository }.each { repo ->
        def repoUrl = repo.url?.toString()
        if (repoUrl && cdxgenCentralPrefixes.any { repoUrl.startsWith(it) }) {
            repo.url = cdxgenMirrorUrl
        }
    }
}
gradle.settingsEvaluated { settings ->
    cdxgenSwapCentral(settings.repositories)
    try {
        cdxgenSwapCentral(settings.pluginManagement.repositories)
    } catch (Exception ignored) {
    }
}
gradle.projectsEvaluated { grad ->
    grad.allprojects { project ->
        cdxgenSwapCentral(project.repositories)
        cdxgenSwapCentral(project.buildscript.repositories)
    }
}
`;
}

/**
 * Extra Gradle arguments that install the mirror init script. Gradle applies
 * every init script it is given, so cdxgen's own helper script keeps working.
 *
 * @returns {string[]} Arguments to append to the Gradle command line
 */
export function gradleMirrorInitScriptArgs() {
  const mirrorUrl = mavenCentralMirrorUrl();
  if (!mirrorUrl || isSecureMode) {
    return [];
  }
  const path = writeMirrorArtifact(
    `gradle|${mirrorUrl}`,
    "cdxgen-gradle-mirror-",
    gradleMirrorInitScript(mirrorUrl),
  );
  return ["--init-script", path];
}

// ---------------------------------------------------------------------------
// sbt
// ---------------------------------------------------------------------------

/**
 * An sbt launcher repositories file that resolves Maven Central from the
 * mirror. The launcher replaces its default list with this file, so the
 * plugin and Typesafe repositories it must still reach are named here, and
 * only the Central entry points at the mirror.
 *
 * @param {string} mirrorUrl Mirror base URL
 * @returns {string}
 */
export function sbtRepositoriesFile(mirrorUrl) {
  return `[repositories]
  local
  maven-central: ${mirrorUrl}
  typesafe-ivy-releases: https://repo.typesafe.com/typesafe/ivy-releases/, [organization]/[module]/[revision]/[type]s/[artifact](-[classifier]).[ext], bootOnly
  sbt-plugin-releases: https://repo.scala-sbt.org/scalasbt/sbt-plugin-releases/, [organization]/[module]/[revision]/[artifact]/[type]s/[artifact](-[classifier]).[ext]
`;
}

/**
 * Environment for an sbt invocation that resolves Maven Central from the
 * mirror: a repositories file under cdxgen's temp directory, named through
 * `SBT_OPTS`. A user who already configures repositories (`~/.sbt/repositories`
 * or their own `sbt.repository.config`) keeps their configuration, and the
 * mirror stays out of the way.
 *
 * @returns {Object} Environment variables to add to the child process
 */
export function sbtMirrorEnv() {
  const mirrorUrl = mavenCentralMirrorUrl();
  if (!mirrorUrl || isSecureMode) {
    return {};
  }
  const existingSbtOpts = readEnvironmentVariable("SBT_OPTS");
  if (existingSbtOpts?.includes("sbt.repository.config")) {
    return {};
  }
  if (
    safeExistsSync(join(homedir(), ".sbt", "repositories")) ||
    safeExistsSync(join(homedir(), ".config", "sbt", "repositories"))
  ) {
    return {};
  }
  const path = writeMirrorArtifact(
    `sbt|${mirrorUrl}`,
    "cdxgen-sbt-mirror-",
    sbtRepositoriesFile(mirrorUrl),
  );
  const properties = `-Dsbt.repository.config=${path} -Dsbt.override.build.repos=true`;
  return {
    SBT_OPTS: existingSbtOpts ? `${existingSbtOpts} ${properties}` : properties,
  };
}

// ---------------------------------------------------------------------------
// Coursier-family tools: Mill, scala-cli and any build that shells out to the
// coursier CLI. Mill's own resolution has no project-free override, so this
// covers the coursier launcher downloads and is best effort there.
// ---------------------------------------------------------------------------

/**
 * Environment for tools that resolve through the Coursier CLI.
 *
 * @returns {Object} Environment variables to add to the child process
 */
export function coursierMirrorEnv() {
  const mirrorUrl = mavenCentralMirrorUrl();
  if (!mirrorUrl || isSecureMode) {
    return {};
  }
  const existing = readEnvironmentVariable("COURSIER_REPOSITORIES");
  if (existing) {
    return {};
  }
  return { COURSIER_REPOSITORIES: `ivy2local|${mirrorUrl}` };
}

// ---------------------------------------------------------------------------
// Bazel
// ---------------------------------------------------------------------------

/**
 * Extra Bazel build arguments that hand the mirror to repository rules, whose
 * environment Bazel otherwise keeps isolated from the client's. Repositories
 * whose URLs the project pins, as rules_jvm_external projects do, are not
 * changed by this; it covers the ones that resolve through Coursier defaults.
 *
 * @returns {string[]} Arguments to append to the Bazel build command line
 */
export function bazelMirrorArgs() {
  const mirrorUrl = mavenCentralMirrorUrl();
  if (!mirrorUrl || isSecureMode) {
    return [];
  }
  if (readEnvironmentVariable("COURSIER_REPOSITORIES")) {
    return [];
  }
  return [`--repo_env=COURSIER_REPOSITORIES=ivy2local|${mirrorUrl}`];
}

// ---------------------------------------------------------------------------
// Clojure tools
// ---------------------------------------------------------------------------

/**
 * The `-Sdeps` data that repoints the default `central` repository of the
 * Clojure CLI at the mirror. Repositories merge by name, so a project's other
 * repositories, including Clojars, keep resolving as declared.
 *
 * @param {string} mirrorUrl Mirror base URL
 * @returns {string}
 */
export function clojureMirrorSdeps(mirrorUrl) {
  return `{:mvn/repos {"central" {:url "${mirrorUrl}"}}}`;
}

/**
 * Extra arguments for a Clojure CLI invocation. Skipped when the user already
 * passes `-Sdeps`, whose data would otherwise be replaced.
 *
 * @param {string[]} baseArgs Arguments the caller already assembled
 * @returns {string[]} Arguments to append
 */
export function clojureMirrorArgs(baseArgs = []) {
  const mirrorUrl = mavenCentralMirrorUrl();
  if (!mirrorUrl || isSecureMode) {
    return [...baseArgs];
  }
  if (baseArgs.includes("-Sdeps")) {
    return [...baseArgs];
  }
  return [...baseArgs, "-Sdeps", clojureMirrorSdeps(mirrorUrl)];
}

/**
 * Arguments for a Leiningen invocation that repoint its `central` repository
 * at the mirror, through `lein update-in`, which changes the project map in
 * memory and never the project.clj file. Skipped when the project declares
 * its own `:mirrors`, which must keep winning.
 *
 * @param {string[]} baseArgs Arguments the caller already assembled
 * @param {string} [projectFileContent] The project's project.clj, when the
 *   caller has it at hand
 * @returns {string[]} Full argument list to invoke Leiningen with
 */
export function leiningenMirrorArgs(baseArgs, projectFileContent) {
  const mirrorUrl = mavenCentralMirrorUrl();
  if (!mirrorUrl || isSecureMode || projectFileContent?.includes(":mirrors")) {
    return baseArgs;
  }
  return [
    "update-in",
    ":mirrors",
    "assoc",
    '"central"',
    `{:url "${mirrorUrl}"}`,
    "--",
    ...baseArgs,
  ];
}

// Exit backstop: a run reset already removes the artifacts between scans;
// this one covers a CLI process that exits without one. It is a no-op while
// no artifact was written.
process.once("exit", cleanupMirrorArtifactsOnExit);
