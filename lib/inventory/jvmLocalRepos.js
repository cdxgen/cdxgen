import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";

import { readEnvironmentVariable } from "../core/activity.js";
import { parseMavenArgs } from "../core/env.js";
import { safeExistsSync } from "../core/fs.js";
import { xml2js } from "../parsers/xml.js";

// Local JVM artifact caches: the Maven local repository, the Gradle module
// cache and the Coursier cache. Every Maven Central request cdxgen can avoid
// starts with knowing where these live and what they already hold, so the
// lookups here are shared by license enrichment, jar identification and the
// sbt parsers.

const SHA1_HEX = /^[a-f0-9]{40}$/;

// Index walks stop after this many files so that a pathological cache cannot
// stall a scan. Real caches hold tens of thousands of artifacts.
const MAX_SHA1_INDEX_ENTRIES = 500_000;

// A repository prefix in the Coursier layout always starts with
// <protocol>/<host> and in practice adds at most a couple of path segments
// ("maven2", "content/repositories/releases"). The prefix scan stops at this
// depth so it never descends into the group directories.
const MAX_COURSIER_PREFIX_DEPTH = 5;

const settingsCache = new Map();
const repositoryListCache = new Map();
const artifactCache = new Map();
const coursierPrefixCache = new Map();
const coursierLocationCache = new Map();
let sha1Index;

/**
 * Forget every memoised lookup. A long-lived process (server mode) calls this
 * per scan so that artifacts a build downloaded in the meantime are found, and
 * tests call it after changing the cache environment variables.
 *
 * @returns {void}
 */
export function resetJvmLocalRepoCaches() {
  settingsCache.clear();
  repositoryListCache.clear();
  artifactCache.clear();
  coursierPrefixCache.clear();
  coursierLocationCache.clear();
  sha1Index = undefined;
}

/**
 * The user's home directory, preferring HOME/USERPROFILE so that tests and
 * sandboxed runs that redirect the home directory are honoured.
 *
 * @returns {string|undefined} Home directory.
 */
function homeDir() {
  return (
    readEnvironmentVariable("HOME") ||
    readEnvironmentVariable("USERPROFILE") ||
    homedir()
  );
}

/**
 * Add a path to a list once, resolved to an absolute path.
 *
 * @param {string[]} list Accumulator.
 * @param {string|undefined} candidate Path to add.
 * @returns {void}
 */
function pushUnique(list, candidate) {
  if (!candidate || typeof candidate !== "string") {
    return;
  }
  const absolute = resolve(candidate);
  if (!list.includes(absolute)) {
    list.push(absolute);
  }
}

/**
 * Expand the property references Maven allows in a settings.xml
 * `localRepository` element: `${user.home}` and `${env.NAME}`. Anything else is
 * left as is, which makes the path fail the existence check rather than point
 * somewhere unintended.
 *
 * @param {string} value Raw element text.
 * @returns {string} Expanded path.
 */
function expandMavenProperties(value) {
  return (
    value
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Maven property syntax, not a template.
      .replaceAll("${user.home}", homeDir())
      .replace(/\$\{env\.([A-Za-z0-9_]+)\}/g, (_match, name) => {
        return readEnvironmentVariable(name) || "";
      })
  );
}

/**
 * Read `<localRepository>` from a Maven settings file.
 *
 * @param {string} settingsFile Path to settings.xml.
 * @returns {string|undefined} Absolute local repository path.
 */
export function localRepositoryFromSettings(settingsFile) {
  if (!settingsFile || !safeExistsSync(settingsFile)) {
    return undefined;
  }
  let mtimeMs;
  try {
    mtimeMs = statSync(settingsFile).mtimeMs;
  } catch (_err) {
    return undefined;
  }
  const cacheKey = `${settingsFile}|${mtimeMs}`;
  if (settingsCache.has(cacheKey)) {
    return settingsCache.get(cacheKey);
  }
  let localRepository;
  try {
    const settings = xml2js(readFileSync(settingsFile, "utf-8"), {
      compact: true,
      textKey: "_",
    }).settings;
    const raw = settings?.localRepository?._?.trim();
    if (raw) {
      localRepository = resolve(
        dirname(settingsFile),
        expandMavenProperties(raw),
      );
    }
  } catch (_err) {
    localRepository = undefined;
  }
  settingsCache.set(cacheKey, localRepository);
  return localRepository;
}

/**
 * Pull the values cdxgen needs out of a Maven argument list: the
 * `maven.repo.local` system property and the user settings file.
 *
 * @param {string[]} args Parsed arguments.
 * @param {string} [baseDir] Directory relative paths resolve against.
 * @returns {{repoLocal?: string, settingsFile?: string}}
 */
export function mavenRepoArgs(args, baseDir = process.cwd()) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    let property;
    if (arg === "-D" && i + 1 < args.length) {
      property = args[++i];
    } else if (arg.startsWith("-D")) {
      property = arg.substring(2);
    }
    if (property?.startsWith("maven.repo.local=")) {
      const value = property.substring("maven.repo.local=".length);
      if (value) {
        result.repoLocal = resolve(baseDir, value);
      }
      continue;
    }
    let settingsFile;
    if ((arg === "-s" || arg === "--settings") && i + 1 < args.length) {
      settingsFile = args[++i];
    } else if (arg.startsWith("--settings=")) {
      settingsFile = arg.substring("--settings=".length);
    }
    if (settingsFile) {
      result.settingsFile = resolve(baseDir, settingsFile);
    }
  }
  return result;
}

/**
 * Every Maven local repository this run may have populated, most specific
 * first: MAVEN_CACHE_DIR, then an explicit `-Dmaven.repo.local` (from
 * MVN_ARGS, MAVEN_ARGS, MAVEN_OPTS or the project's `.mvn/maven.config`), then
 * `<localRepository>` from the settings Maven would read, then
 * `~/.m2/repository`.
 *
 * @param {Object} [opts]
 * @param {string} [opts.projectDir] Project directory, for `.mvn/maven.config`.
 * @returns {string[]} Absolute paths. Not filtered for existence.
 */
export function mavenLocalRepositories({ projectDir } = {}) {
  const signature = [
    "MVN_ARGS",
    "MAVEN_ARGS",
    "MAVEN_OPTS",
    "MAVEN_CACHE_DIR",
    "MAVEN_HOME",
    "M2_HOME",
    "HOME",
    "USERPROFILE",
  ]
    .map((name) => readEnvironmentVariable(name) || "")
    .concat(projectDir || "")
    .join("\u0000");
  if (repositoryListCache.has(signature)) {
    return repositoryListCache.get(signature);
  }
  const repos = [];
  pushUnique(repos, readEnvironmentVariable("MAVEN_CACHE_DIR"));
  const settingsFiles = [];
  const argSources = ["MVN_ARGS", "MAVEN_ARGS", "MAVEN_OPTS"].map((name) =>
    parseMavenArgs(readEnvironmentVariable(name)),
  );
  if (projectDir) {
    const mavenConfig = join(projectDir, ".mvn", "maven.config");
    if (safeExistsSync(mavenConfig)) {
      try {
        argSources.push(parseMavenArgs(readFileSync(mavenConfig, "utf-8")));
      } catch (_err) {
        // An unreadable maven.config contributes nothing.
      }
    }
  }
  for (const args of argSources) {
    const { repoLocal, settingsFile } = mavenRepoArgs(
      args,
      projectDir || process.cwd(),
    );
    pushUnique(repos, repoLocal);
    pushUnique(settingsFiles, settingsFile);
  }
  pushUnique(settingsFiles, join(homeDir(), ".m2", "settings.xml"));
  const mavenHome =
    readEnvironmentVariable("MAVEN_HOME") || readEnvironmentVariable("M2_HOME");
  if (mavenHome) {
    pushUnique(settingsFiles, join(mavenHome, "conf", "settings.xml"));
  }
  for (const settingsFile of settingsFiles) {
    pushUnique(repos, localRepositoryFromSettings(settingsFile));
  }
  pushUnique(repos, join(homeDir(), ".m2", "repository"));
  repositoryListCache.set(signature, repos);
  return repos;
}

/**
 * Gradle module cache directories (`.../modules-2/files-2.1`): the one under
 * GRADLE_USER_HOME, the cdxgen-specific GRADLE_CACHE_DIR, the default
 * `~/.gradle` when neither is set, and the read-only shared cache named by
 * GRADLE_RO_DEP_CACHE.
 *
 * @returns {string[]} Absolute paths. Not filtered for existence.
 */
export function gradleCacheRoots() {
  const roots = [];
  const gradleUserHome = readEnvironmentVariable("GRADLE_USER_HOME");
  const gradleCacheDir = readEnvironmentVariable("GRADLE_CACHE_DIR");
  if (gradleUserHome) {
    pushUnique(roots, join(gradleUserHome, "caches", "modules-2", "files-2.1"));
  }
  pushUnique(roots, gradleCacheDir);
  if (!gradleUserHome && !gradleCacheDir) {
    pushUnique(
      roots,
      join(homeDir(), ".gradle", "caches", "modules-2", "files-2.1"),
    );
  }
  const readOnlyCache = readEnvironmentVariable("GRADLE_RO_DEP_CACHE");
  if (readOnlyCache) {
    pushUnique(roots, join(readOnlyCache, "modules-2", "files-2.1"));
  }
  return roots;
}

/**
 * The Coursier cache directory used by sbt, Mill and scala-cli: COURSIER_CACHE
 * when set, otherwise the platform default (XDG_CACHE_HOME is honoured on
 * Linux).
 *
 * @returns {string|undefined} Absolute path. Not checked for existence.
 */
export function coursierCacheDir() {
  const configured = readEnvironmentVariable("COURSIER_CACHE");
  if (configured) {
    return resolve(configured);
  }
  const home = homeDir();
  if (!home) {
    return undefined;
  }
  if (process.platform === "darwin") {
    return join(home, "Library", "Caches", "Coursier", "v1");
  }
  if (process.platform === "win32") {
    const localAppData = readEnvironmentVariable("LOCALAPPDATA");
    return localAppData
      ? join(localAppData, "Coursier", "Cache", "v1")
      : join(home, "AppData", "Local", "Coursier", "Cache", "v1");
  }
  const xdgCache = readEnvironmentVariable("XDG_CACHE_HOME");
  return join(xdgCache || join(home, ".cache"), "coursier", "v1");
}

/**
 * Repository prefixes present in a Coursier cache, found with a shallow,
 * depth-bounded scan and memoised per cache root. See cdxgen issue 4291 for
 * why this replaced a recursive glob per coordinate.
 *
 * @param {string} cacheRoot Coursier cache root.
 * @returns {string[][]} Prefixes as path segments relative to the root.
 */
function coursierRepoPrefixes(cacheRoot) {
  if (coursierPrefixCache.has(cacheRoot)) {
    return coursierPrefixCache.get(cacheRoot);
  }
  const prefixes = [];
  // Breadth-first so that shallower prefixes, the common ones, come first.
  let frontier = [[]];
  for (let depth = 1; depth <= MAX_COURSIER_PREFIX_DEPTH; depth++) {
    const next = [];
    for (const parts of frontier) {
      let entries;
      try {
        entries = readdirSync(join(cacheRoot, ...parts), {
          withFileTypes: true,
        });
      } catch (_err) {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const childParts = [...parts, entry.name];
        // <protocol>/<host> is the shortest thing that can be a repository.
        if (depth >= 2) {
          prefixes.push(childParts);
        }
        next.push(childParts);
      }
    }
    frontier = next;
    if (!frontier.length) {
      break;
    }
  }
  coursierPrefixCache.set(cacheRoot, prefixes);
  return prefixes;
}

/**
 * Convert a Coursier repository prefix into the repository URL it caches.
 *
 * @param {string[]} parts Prefix segments relative to the cache root.
 * @returns {string|null} Repository URL.
 */
export function coursierPrefixToUrl(parts) {
  if (!parts || parts.length < 2) {
    return null;
  }
  const protocol = parts[0];
  if (protocol === "file") {
    let localPath = parts.slice(1).join("/");
    if (!localPath.startsWith("/")) {
      localPath = `/${localPath}`;
    }
    return `file://${localPath}`;
  }
  const host = parts[1];
  const repoPath = parts.slice(2).join("/");
  let repoUrl = `${protocol}://${host}`;
  if (repoPath) {
    repoUrl += `/${repoPath}`;
  }
  return repoUrl.endsWith("/") ? repoUrl.slice(0, -1) : repoUrl;
}

/**
 * Locate a Maven coordinate's directory in the Coursier cache.
 *
 * @param {string} group Maven groupId.
 * @param {string} name Maven artifactId, including any Scala suffix.
 * @param {string} version Version.
 * @returns {{repoUrl: string, dir: string}|null} Repository URL and directory.
 */
export function locateInCoursierCache(group, name, version) {
  if (!group || !name || !version) {
    return null;
  }
  const cacheRoot = coursierCacheDir();
  if (!cacheRoot || !safeExistsSync(cacheRoot)) {
    return null;
  }
  // The root is part of the key so a changed COURSIER_CACHE is never answered
  // from a memo built against the previous one.
  const cacheKey = `${cacheRoot}|${group}:${name}:${version}`;
  if (coursierLocationCache.has(cacheKey)) {
    return coursierLocationCache.get(cacheKey);
  }
  const groupParts = group.split(".");
  const prefixes = coursierRepoPrefixes(cacheRoot);
  let result = null;
  for (let i = 0; i < prefixes.length; i++) {
    const dir = join(cacheRoot, ...prefixes[i], ...groupParts, name, version);
    if (safeExistsSync(dir)) {
      const repoUrl = coursierPrefixToUrl(prefixes[i]);
      if (repoUrl) {
        result = { repoUrl, dir };
        // Most coordinates in a build come from a handful of repositories, so
        // the prefix that just matched moves to the front.
        if (i > 0) {
          prefixes.unshift(prefixes.splice(i, 1)[0]);
        }
        break;
      }
    }
  }
  coursierLocationCache.set(cacheKey, result);
  return result;
}

/**
 * The file name a Maven artifact is stored under.
 *
 * @param {string} name artifactId.
 * @param {string} version Version.
 * @param {string} [classifier] Classifier.
 * @param {string} [extension] Extension without the dot.
 * @returns {string} File name.
 */
function artifactFileName(name, version, classifier, extension) {
  return `${name}-${version}${classifier ? `-${classifier}` : ""}.${extension}`;
}

/**
 * Find a file with an exact name in any immediate subdirectory of `dir`. The
 * Gradle module cache keeps every file under a directory named after its
 * SHA-1, so the name is known but the directory is not.
 *
 * @param {string} dir Version directory in the Gradle cache.
 * @param {string} fileName Exact file name.
 * @returns {{path: string, sha1: string}|undefined}
 */
function findInHashedDirs(dir, fileName) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (_err) {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = join(dir, entry.name, fileName);
    if (safeExistsSync(candidate)) {
      return { path: candidate, sha1: entry.name };
    }
  }
  return undefined;
}

/**
 * Locate a Maven artifact and its POM in the local caches.
 *
 * Only the exact file names Maven, Gradle and Coursier use are accepted, so a
 * classifier jar (`-sources`, `-javadoc`, `-linux-x86_64`) is never mistaken
 * for the main artifact. Results, including misses, are memoised until
 * {@link resetJvmLocalRepoCaches}.
 *
 * @param {string} group Maven groupId.
 * @param {string} name Maven artifactId.
 * @param {string} version Version.
 * @param {Object} [opts]
 * @param {string} [opts.classifier] Classifier of the wanted jar.
 * @param {string} [opts.extension] Artifact extension. Defaults to jar.
 * @param {string} [opts.projectDir] Project directory, for `.mvn/maven.config`.
 * @returns {{jarPath?: string, pomPath?: string, sha1?: string, repoUrl?: string}|null}
 */
export function findLocalMavenArtifact(group, name, version, opts = {}) {
  if (!group || !name || !version) {
    return null;
  }
  const classifier = opts.classifier || "";
  const extension = opts.extension || "jar";
  const mavenRepos = mavenLocalRepositories({ projectDir: opts.projectDir });
  const gradleRoots = gradleCacheRoots();
  const coursierRoot = coursierCacheDir();
  const cacheKey = [
    group,
    name,
    version,
    classifier,
    extension,
    mavenRepos.join(","),
    gradleRoots.join(","),
    coursierRoot,
  ].join("|");
  if (artifactCache.has(cacheKey)) {
    return artifactCache.get(cacheKey);
  }
  const jarName = artifactFileName(name, version, classifier, extension);
  const pomName = artifactFileName(name, version, "", "pom");
  const result = {};
  const groupPath = group.split(".");
  for (const repo of mavenRepos) {
    const dir = join(repo, ...groupPath, name, version);
    if (!safeExistsSync(dir)) {
      continue;
    }
    if (!result.jarPath && safeExistsSync(join(dir, jarName))) {
      result.jarPath = join(dir, jarName);
    }
    if (!result.pomPath && safeExistsSync(join(dir, pomName))) {
      result.pomPath = join(dir, pomName);
    }
    if (result.jarPath && result.pomPath) {
      break;
    }
  }
  if (!result.jarPath || !result.pomPath) {
    for (const root of gradleRoots) {
      const dir = join(root, group, name, version);
      if (!safeExistsSync(dir)) {
        continue;
      }
      if (!result.jarPath) {
        const jar = findInHashedDirs(dir, jarName);
        if (jar) {
          result.jarPath = jar.path;
          if (SHA1_HEX.test(jar.sha1)) {
            result.sha1 = jar.sha1;
          }
        }
      }
      if (!result.pomPath) {
        result.pomPath = findInHashedDirs(dir, pomName)?.path;
      }
      if (result.jarPath && result.pomPath) {
        break;
      }
    }
  }
  if (!result.jarPath || !result.pomPath) {
    const location = locateInCoursierCache(group, name, version);
    if (location) {
      if (!result.jarPath && safeExistsSync(join(location.dir, jarName))) {
        result.jarPath = join(location.dir, jarName);
      }
      if (!result.pomPath && safeExistsSync(join(location.dir, pomName))) {
        result.pomPath = join(location.dir, pomName);
      }
      if (result.jarPath || result.pomPath) {
        result.repoUrl = location.repoUrl;
      }
    }
  }
  const found = result.jarPath || result.pomPath ? result : null;
  artifactCache.set(cacheKey, found);
  return found;
}

/**
 * Split an artifact file name into its classifier and extension, given the
 * artifactId and version it belongs to.
 *
 * @param {string} fileName File name, for example `netty-4.1.1-linux.jar`.
 * @param {string} name artifactId.
 * @param {string} version Version.
 * @returns {{classifier: string, extension: string}|undefined} Undefined when
 *   the name does not belong to the coordinate.
 */
export function splitArtifactFileName(fileName, name, version) {
  const prefix = `${name}-${version}`;
  if (!fileName.startsWith(prefix)) {
    return undefined;
  }
  const rest = fileName.substring(prefix.length);
  const dot = rest.lastIndexOf(".");
  if (dot === -1) {
    return undefined;
  }
  const extension = rest.substring(dot + 1);
  const classifierPart = rest.substring(0, dot);
  if (!classifierPart) {
    return { classifier: "", extension };
  }
  if (!classifierPart.startsWith("-") || classifierPart.length < 2) {
    return undefined;
  }
  return { classifier: classifierPart.substring(1), extension };
}

/**
 * Coordinates from a path in the Maven repository layout:
 * `<root>/<group path>/<artifactId>/<version>/<artifactId>-<version>[-<classifier>].<ext>`.
 *
 * @param {string[]} parts Path segments below the repository root.
 * @returns {Object|undefined}
 */
function coordinatesFromMavenLayout(parts) {
  if (parts.length < 4) {
    return undefined;
  }
  const fileName = parts[parts.length - 1];
  const version = parts[parts.length - 2];
  const name = parts[parts.length - 3];
  const group = parts.slice(0, -3).join(".");
  let split = splitArtifactFileName(fileName, name, version);
  if (!split && version.endsWith("-SNAPSHOT")) {
    // Timestamped snapshot files replace -SNAPSHOT with the build stamp.
    const base = version.substring(0, version.length - "-SNAPSHOT".length);
    const stamp = /^-\d{8}\.\d{6}-\d+/.exec(
      fileName.substring(`${name}-${base}`.length),
    );
    if (fileName.startsWith(`${name}-${base}`) && stamp) {
      split = splitArtifactFileName(
        fileName,
        name,
        `${base}${stamp[0]}`,
      );
    }
  }
  if (!group || !split) {
    return undefined;
  }
  return { group, name, version, ...split };
}

/**
 * Coordinates from a path in the Gradle module cache layout:
 * `<root>/<group>/<artifactId>/<version>/<sha1>/<file>`.
 *
 * @param {string[]} parts Path segments below the cache root.
 * @returns {Object|undefined}
 */
function coordinatesFromGradleLayout(parts) {
  if (parts.length !== 5) {
    return undefined;
  }
  const [group, name, version, sha1, fileName] = parts;
  const split = splitArtifactFileName(fileName, name, version);
  if (!split) {
    return undefined;
  }
  return {
    group,
    name,
    version,
    ...split,
    ...(SHA1_HEX.test(sha1) ? { sha1 } : {}),
  };
}

/**
 * Segments of `filePath` below `root`, or undefined when it is not inside.
 *
 * @param {string} root Root directory.
 * @param {string} filePath File path.
 * @returns {string[]|undefined}
 */
function segmentsBelow(root, filePath) {
  const rel = relative(root, filePath);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    return undefined;
  }
  return rel.split(/[\\/]/).filter(Boolean);
}

/**
 * Infer Maven coordinates from where an artifact sits on disk.
 *
 * Paths inside a configured Maven repository or Gradle cache are read by
 * their layout. Paths elsewhere are recognised by the conventional
 * `.m2/repository` and `files-2.1` segments, so a copied cache still works. A
 * Coursier path is resolved through its sibling POM, because the repository
 * prefix and the group path cannot be told apart from the path alone.
 *
 * @param {string} filePath Absolute path of a jar or other artifact.
 * @returns {{group: string, name: string, version: string, classifier: string, extension: string, sha1?: string}|undefined}
 */
export function inferMavenCoordinatesFromPath(filePath) {
  if (!filePath) {
    return undefined;
  }
  const absolute = resolve(filePath);
  for (const repo of mavenLocalRepositories()) {
    const parts = segmentsBelow(repo, absolute);
    if (parts) {
      return coordinatesFromMavenLayout(parts);
    }
  }
  for (const root of gradleCacheRoots()) {
    const parts = segmentsBelow(root, absolute);
    if (parts) {
      return coordinatesFromGradleLayout(parts);
    }
  }
  const segments = absolute.split(/[\\/]/);
  for (let i = segments.length - 2; i > 0; i--) {
    if (segments[i] === "repository" && segments[i - 1] === ".m2") {
      return coordinatesFromMavenLayout(segments.slice(i + 1));
    }
    if (segments[i] === "files-2.1") {
      return coordinatesFromGradleLayout(segments.slice(i + 1));
    }
  }
  const coursierRoot = coursierCacheDir();
  if (coursierRoot && segmentsBelow(coursierRoot, absolute)) {
    const fileName = basename(absolute);
    const version = basename(dirname(absolute));
    const name = basename(dirname(dirname(absolute)));
    const pomPath = join(dirname(absolute), `${name}-${version}.pom`);
    const split = splitArtifactFileName(fileName, name, version);
    if (split && safeExistsSync(pomPath)) {
      try {
        const project = xml2js(readFileSync(pomPath, "utf-8"), {
          compact: true,
          textKey: "_",
        }).project;
        const group = project?.groupId?._ || project?.parent?.groupId?._;
        if (group && (project?.artifactId?._ || name) === name) {
          return { group, name, version, ...split };
        }
      } catch (_err) {
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * Read the SHA-1 recorded in a Maven `*.sha1` checksum file.
 *
 * @param {string} file Checksum file.
 * @returns {string|undefined} Lowercase hex digest.
 */
function readSha1File(file) {
  try {
    const digest = readFileSync(file, "utf-8").trim().split(/\s+/)[0];
    const lower = digest?.toLowerCase();
    return SHA1_HEX.test(lower) ? lower : undefined;
  } catch (_err) {
    return undefined;
  }
}

/**
 * Walk a Maven repository and record `<jar>.sha1` digests.
 *
 * @param {string} dir Directory to walk.
 * @param {Map<string, Object>} index Index being built.
 * @param {string} repoRoot Repository root.
 * @returns {void}
 */
function indexMavenRepository(dir, index, repoRoot) {
  const stack = [dir];
  while (stack.length && index.size < MAX_SHA1_INDEX_ENTRIES) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (_err) {
      continue;
    }
    for (const entry of entries) {
      const entryPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.name.endsWith(".jar.sha1")) {
        const digest = readSha1File(entryPath);
        const jarPath = entryPath.substring(0, entryPath.length - 5);
        const parts = segmentsBelow(repoRoot, jarPath);
        const coordinates = parts && coordinatesFromMavenLayout(parts);
        if (digest && coordinates && !index.has(digest)) {
          index.set(digest, { ...coordinates, path: jarPath });
        }
      }
    }
  }
}

/**
 * Walk a Gradle module cache. The SHA-1 is the directory name, so no file is
 * read: `<root>/<group>/<artifactId>/<version>/<sha1>/<file>`.
 *
 * @param {string} root Cache root.
 * @param {Map<string, Object>} index Index being built.
 * @returns {void}
 */
function indexGradleCache(root, index) {
  const list = (dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true }).filter((e) =>
        e.isDirectory(),
      );
    } catch (_err) {
      return [];
    }
  };
  for (const groupEntry of list(root)) {
    const groupDir = join(root, groupEntry.name);
    for (const nameEntry of list(groupDir)) {
      const nameDir = join(groupDir, nameEntry.name);
      for (const versionEntry of list(nameDir)) {
        const versionDir = join(nameDir, versionEntry.name);
        for (const hashEntry of list(versionDir)) {
          if (index.size >= MAX_SHA1_INDEX_ENTRIES) {
            return;
          }
          const digest = hashEntry.name.toLowerCase();
          if (!SHA1_HEX.test(digest) || index.has(digest)) {
            continue;
          }
          let files;
          try {
            files = readdirSync(join(versionDir, hashEntry.name));
          } catch (_err) {
            continue;
          }
          for (const fileName of files) {
            const coordinates = coordinatesFromGradleLayout([
              groupEntry.name,
              nameEntry.name,
              versionEntry.name,
              hashEntry.name,
              fileName,
            ]);
            if (coordinates?.extension === "jar") {
              index.set(digest, {
                ...coordinates,
                path: join(versionDir, hashEntry.name, fileName),
              });
              break;
            }
          }
        }
      }
    }
  }
}

/**
 * Look up the Maven coordinates of a jar by its SHA-1 in the local caches.
 *
 * The index is built once, on first use, from the Gradle module cache (whose
 * directory names are SHA-1s) and from the `*.jar.sha1` files Maven writes
 * next to every downloaded jar. It answers the question cdxgen would otherwise
 * send to the Maven Central search API.
 *
 * @param {string} sha1 Hex SHA-1 of the jar.
 * @returns {{group: string, name: string, version: string, classifier: string, extension: string, path: string}|undefined}
 */
export function findMavenCoordinatesBySha1(sha1) {
  const digest = sha1?.toLowerCase();
  if (!digest || !SHA1_HEX.test(digest)) {
    return undefined;
  }
  if (!sha1Index) {
    sha1Index = new Map();
    for (const root of gradleCacheRoots()) {
      if (safeExistsSync(root)) {
        indexGradleCache(root, sha1Index);
      }
    }
    for (const repo of mavenLocalRepositories()) {
      if (safeExistsSync(repo)) {
        indexMavenRepository(repo, sha1Index, repo);
      }
    }
  }
  return sha1Index.get(digest);
}
