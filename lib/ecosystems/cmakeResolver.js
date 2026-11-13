/**
 * CMake build-context resolver: the layer-3 bridge between the pure parsers
 * (`lib/parsers/cmakeCache.js`, `lib/parsers/gitmodules.js`) and the C/C++ BOM
 * lifecycle in `lib/cli/nativeBom.js`.
 *
 * This module owns every subprocess invocation and every filesystem read
 * outside the scan root. It reads `CMakeCache.txt`, `.gitmodules`, the
 * FetchContent gitclone scripts, and the submodule gitlinks in the index, then
 * returns repo-relative facts the lifecycle can attach to components.
 */

import { realpathSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  DEBUG_MODE,
  isSecureMode,
  recordSensitiveFileRead,
} from "../core/activity.js";
import { readScanFileText } from "../core/boundedFile.js";
import { safeExistsSync } from "../core/fs.js";
import {
  cmakeBuildDirCandidates,
  isInsideDir,
} from "../inventory/cmakeBuildDirs.js";
import {
  execGitCommand,
  GIT_COMMAND,
  getOriginUrl,
} from "../inventory/envcontext.js";
import { applyPurl, tryBuildPurl } from "../inventory/purl.js";
import {
  parseCmakeCache,
  resolveCmakeCacheFacts,
} from "../parsers/cmakeCache.js";
import {
  parseGitmodules,
  parseGitRemoteUrl,
  resolveSubmoduleUrl,
  submodulePurlCoordinates,
} from "../parsers/gitmodules.js";

// The largest CMakeCache.txt read.
const MAX_CMAKE_CACHE_BYTES = 16 * 1024 * 1024;

// The largest FetchContent gitclone script or .gitmodules file read.
const MAX_CMAKE_SCRIPT_BYTES = 1024 * 1024;

/**
 * Make an absolute build-machine path repo-relative. Returns `null` when the
 * path does not lie under the scan root (so the caller can drop it rather than
 * emit a verbatim build-machine path).
 *
 * @param {string} absPath Absolute path from CMakeCache
 * @param {string} scanRoot The project scan root
 * @returns {string|null} Repo-relative path using POSIX separators, or null
 */
function toRepoRelative(absPath, scanRoot) {
  if (!absPath || !scanRoot) {
    return null;
  }
  const rel = relative(resolve(scanRoot), resolve(absPath));
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return null;
  }
  return rel.split(sep).join("/");
}

/**
 * Detect the build directory that holds a `CMakeCache.txt`.
 *
 * An explicit `--cmake-cache <path>` option (passed via `options.cmakeCache`)
 * takes precedence and skips autodetection. Otherwise the project's build
 * directories are searched in order: those its CMake presets configure, then
 * the conventional `build`, `out`, `builddir` and `cmake-build-` directories
 * (see `cmakeBuildDirCandidates`).
 *
 * @param {string} path Project scan root
 * @param {Object} options CLI options; `options.cmakeCache` is an explicit override
 * @returns {{ cacheFile: string, buildDir: string } | null}
 */
export function detectCmakeBuildDir(path, options) {
  if (options?.cmakeCache) {
    const cacheFile = resolve(options.cmakeCache);
    if (safeExistsSync(cacheFile)) {
      recordSensitiveFileRead(cacheFile, {
        label: "CMakeCache.txt (explicit override)",
      });
      return { cacheFile, buildDir: resolve(dirname(cacheFile)) };
    }
    return null;
  }
  for (const buildDir of cmakeBuildDirCandidates(path, options)) {
    const cacheFile = join(buildDir, "CMakeCache.txt");
    if (safeExistsSync(cacheFile)) {
      recordSensitiveFileRead(cacheFile, {
        label: "CMakeCache.txt (autodetected)",
      });
      return { cacheFile, buildDir };
    }
  }
  return null;
}

/**
 * Read a detected `CMakeCache.txt`. The file must resolve inside its build
 * directory, which is inside the project unless --cmake-cache named it, must
 * be a regular file and must be no larger than 16 MiB.
 *
 * @param {{ cacheFile: string, buildDir: string }} detected Detected cache
 * @returns {string|undefined} The text, or undefined
 */
export function readCmakeCacheText(detected) {
  return readScanFileText(
    detected.cacheFile,
    MAX_CMAKE_CACHE_BYTES,
    detected.buildDir,
  );
}

/**
 * Read and resolve the CMakeCache facts for a project.
 *
 * @param {string} path Project scan root
 * @param {Object} options CLI options
 * @returns {{ rootProject: {name?:string, version?:string}|null, projects: Map, findPackages: Map, fetchContentBase?: string, buildDir?: string } | null}
 */
export function resolveCmakeCache(path, options) {
  const detected = detectCmakeBuildDir(path, options);
  if (!detected) {
    return null;
  }
  const text = readCmakeCacheText(detected);
  if (text === undefined) {
    if (DEBUG_MODE) {
      console.warn(`Unable to read CMakeCache at ${detected.cacheFile}`);
    }
    return null;
  }
  const facts = resolveCmakeCacheFacts(parseCmakeCache(text));
  return {
    ...facts,
    buildDir: detected.buildDir,
  };
}

/**
 * Read the FetchContent gitclone script and extract the repository URL and tag.
 *
 * The script lives at
 * `<build>/_deps/<name>-subbuild/<name>-populate-prefix/tmp/<name>-populate-gitclone.cmake`
 * and contains the literal `clone ... "<GIT_REPOSITORY>" "<name>-src"` and
 * `checkout "<GIT_TAG>" --` lines. No git invocation is needed.
 *
 * @param {string} buildDir Build directory
 * @param {string} depName FetchContent dep name (lowercase)
 * @returns {{ url: string|null, tag: string|null }}
 */
export function readFetchContentGitclone(buildDir, depName) {
  // `depName` reaches here from a CMakeCache key and is interpolated into a
  // path, so a separator or a `..` segment in it would read outside the build
  // directory. A FetchContent dependency name is a CMake identifier; anything
  // else is refused rather than resolved.
  if (
    !depName ||
    !/^[A-Za-z0-9_.+-]+$/.test(depName) ||
    depName.includes("..")
  ) {
    return { url: null, tag: null };
  }
  const scriptPath = join(
    buildDir,
    "_deps",
    `${depName}-subbuild`,
    `${depName}-populate-prefix`,
    "tmp",
    `${depName}-populate-gitclone.cmake`,
  );
  if (!safeExistsSync(scriptPath)) {
    return { url: null, tag: null };
  }
  recordSensitiveFileRead(scriptPath, {
    label: "FetchContent gitclone script",
  });
  const text = readScanFileText(scriptPath, MAX_CMAKE_SCRIPT_BYTES, buildDir);
  if (text === undefined) {
    return { url: null, tag: null };
  }
  return parseGitcloneScript(text);
}

/**
 * Parse a gitclone.cmake script for the GIT_REPOSITORY and GIT_TAG literals.
 *
 * The clone line carries several quoted arguments (`--config "..."`, the
 * repository URL, and the source dir), so the URL is identified as the quoted
 * token that parses as a git remote rather than the first quoted token.
 *
 * @param {string} text Script contents
 * @returns {{ url: string|null, tag: string|null }}
 */
export function parseGitcloneScript(text) {
  if (!text || typeof text !== "string") {
    return { url: null, tag: null };
  }
  let url = null;
  let tag = null;
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();
    if (!url && line.startsWith("clone")) {
      const quoted = line.matchAll(/"([^"]+)"/g);
      for (const match of quoted) {
        const candidate = match[1];
        if (parseGitRemoteUrl(candidate)) {
          url = candidate;
          break;
        }
      }
    }
    if (!tag && line.startsWith("checkout")) {
      const quoted = line.matchAll(/"([^"]+)"/g);
      for (const match of quoted) {
        tag = match[1];
        break;
      }
    }
  }
  return { url, tag };
}

/** The `git describe` forms `git submodule status` tries, in order. */
const SUBMODULE_DESCRIBE_ARGS = [
  [],
  ["--tags"],
  ["--contains"],
  ["--all", "--always"],
];

const OBJECT_ID_LENGTHS = new Set([40, 64]);

function isObjectId(value) {
  return (
    typeof value === "string" &&
    OBJECT_ID_LENGTHS.has(value.length) &&
    /^[0-9a-f]+$/.test(value)
  );
}

function realPathOf(p) {
  try {
    return realpathSync(p);
  } catch (_err) {
    return resolve(p);
  }
}

/**
 * The checked-out commit of a submodule, or undefined when the directory is
 * not the top of a git working tree of its own.
 */
function submoduleHead(subDir) {
  const output = execGitCommand(subDir, [
    "rev-parse",
    "--show-toplevel",
    "HEAD",
  ]);
  const [toplevel, head] = `${output || ""}`.split("\n").map((l) => l.trim());
  if (!toplevel || !isObjectId(head)) {
    return undefined;
  }
  // a broken `.git` makes git find the enclosing repository instead
  return realPathOf(toplevel) === realPathOf(subDir) ? head : undefined;
}

/** The name `git submodule status` shows for a commit of a submodule. */
function describeSubmoduleCommit(subDir, sha) {
  for (const args of SUBMODULE_DESCRIBE_ARGS) {
    const described = execGitCommand(subDir, ["describe", ...args, sha]);
    if (described && !/\s/.test(described)) {
      return described;
    }
  }
  return null;
}

/**
 * Collect submodule pin data from the gitlinks (mode 160000) in the index,
 * with the prefixes and names `git submodule status` would show: ` ` for a
 * checked-out submodule at the recorded commit, `+` for one at another
 * commit (whose commit is reported), `-` for one that is not checked out and
 * `U` for a conflicted entry.
 *
 * `git submodule status` itself is not run, because it compares work-tree
 * files with the index and hashes a racily clean file again through the
 * `filter.<name>.clean` command the scanned repository's own config names,
 * which no `-c` override in `execGitCommand` can disable. Only the index
 * (`git ls-files --stage`) and a submodule's refs and objects (`git
 * rev-parse`, `git describe`) are read. Uninitialised submodules (the normal
 * case for `--depth 1` clones and CI) have no describe, so the version
 * degrades to the commit SHA.
 *
 * @param {string} path Repo directory
 * @returns {Map<string, { sha: string, describe: string|null, prefix: string, path: string }>} Path → pin data
 */
export function collectSubmoduleStatus(path) {
  const result = new Map();
  if (isSecureMode) {
    return result;
  }
  const output = execGitCommand(path, ["ls-files", "--stage", "-z"]);
  const realRoot = realPathOf(path);
  for (const [subPath, entry] of parseIndexGitlinks(output)) {
    if (entry.conflicted) {
      result.set(subPath, {
        sha: "0".repeat(entry.sha.length),
        describe: null,
        prefix: "U",
        path: subPath,
      });
      continue;
    }
    const subDir = resolve(path, subPath);
    // a submodule is only read where it is checked out inside the project
    const head =
      safeExistsSync(join(subDir, ".git")) &&
      isInsideDir(realPathOf(subDir), realRoot)
        ? submoduleHead(subDir)
        : undefined;
    if (!head) {
      result.set(subPath, {
        sha: entry.sha,
        describe: null,
        prefix: "-",
        path: subPath,
      });
      continue;
    }
    result.set(subPath, {
      sha: head,
      describe: describeSubmoduleCommit(subDir, head),
      prefix: head === entry.sha ? " " : "+",
      path: subPath,
    });
  }
  return result;
}

/**
 * Parse the gitlinks out of `git ls-files --stage -z` output.
 *
 * Each NUL-terminated record is `<mode> <sha> <stage>\t<path>`. Only entries
 * of mode `160000` are submodule pins. A path with a stage-0 entry is
 * resolved; one with only conflict stages (1 to 3) is marked conflicted.
 *
 * @param {string|undefined} output Raw command output
 * @returns {Map<string, { sha: string, conflicted: boolean }>} Path → pinned commit
 */
export function parseIndexGitlinks(output) {
  const gitlinks = new Map();
  if (!output) {
    return gitlinks;
  }
  for (const record of output.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab === -1) {
      continue;
    }
    const [mode, sha, stage] = record.slice(0, tab).split(" ");
    const subPath = record.slice(tab + 1);
    if (mode !== "160000" || !isObjectId(sha) || !subPath) {
      continue;
    }
    if (stage === "0") {
      gitlinks.set(subPath, { sha, conflicted: false });
    } else if (["1", "2", "3"].includes(stage) && !gitlinks.has(subPath)) {
      gitlinks.set(subPath, { sha, conflicted: true });
    }
  }
  return gitlinks;
}

/**
 * Build the complete CMake/submodule resolution for a project.
 *
 * Combines CMakeCache facts, `.gitmodules`, submodule pins, and FetchContent
 * gitclone scripts into a single boundary set and component list the C/C++
 * lifecycle can consume.
 *
 * @param {string} path Project scan root
 * @param {Object} options CLI options
 * @returns {{ rootProject: {name?:string, version?:string}|null, findPackages: Map<string,string>, submodules: Array, fetchDeps: Array, boundaries: Map<string,{kind:string,version?:string,url?:string,name:string}> }}
 */
export function resolveCmakeContext(path, options) {
  const cacheFacts = resolveCmakeCache(path, options);
  const rootProject = cacheFacts?.rootProject || null;
  const findPackages = cacheFacts?.findPackages || new Map();
  const buildDir = cacheFacts?.buildDir;

  const boundaries = new Map();
  const fetchDeps = [];
  const submodules = [];

  if (cacheFacts?.projects) {
    for (const [name, project] of cacheFacts.projects) {
      if (project.kind === "fetch" && project.sourceDir) {
        const relDir = toRepoRelative(project.sourceDir, path);
        const gitclone = buildDir
          ? readFetchContentGitclone(buildDir, name)
          : { url: null, tag: null };
        const tag = gitclone.tag || project.version || null;
        const url = gitclone.url || null;
        const entry = {
          kind: "fetch",
          name,
          version: tag,
          url,
          sourceDir: relDir,
        };
        fetchDeps.push(entry);
        if (relDir) {
          boundaries.set(relDir, entry);
        }
        continue;
      }
      if (project.kind === "internal" && project.sourceDir) {
        const relDir = toRepoRelative(project.sourceDir, path);
        if (relDir && relDir !== ".") {
          boundaries.set(relDir, {
            kind: "internal",
            name,
            version: project.version,
          });
        }
      }
    }
  }

  const gitmodulesFile = findGitmodules(path);
  let originUrl = null;
  // Only ask git about a directory that is a working tree. A container scan
  // walks every directory of an exploded image, none of which are checkouts,
  // and each call is a process spawn.
  if (safeExistsSync(join(path, ".git"))) {
    try {
      originUrl = getOriginUrl(path);
    } catch {
      originUrl = null;
    }
  }
  if (gitmodulesFile) {
    const gmText =
      readScanFileText(gitmodulesFile, MAX_CMAKE_SCRIPT_BYTES, path) ?? "";
    const parsed = parseGitmodules(gmText);
    const statusMap = collectSubmoduleStatus(path);
    for (const sub of parsed) {
      if (!sub.path) {
        continue;
      }
      const status = statusMap.get(sub.path);
      const sha = status?.sha || null;
      const describe = status?.describe || null;
      const version = describe || sha || null;
      const resolvedUrl = sub.url
        ? resolveSubmoduleUrl(sub.url, originUrl)
        : null;
      const entry = {
        kind: "submodule",
        name: basename(sub.path),
        path: sub.path,
        version,
        sha,
        describe,
        url: resolvedUrl,
        uninitialised: status?.prefix === "-",
      };
      submodules.push(entry);
      boundaries.set(sub.path, entry);
    }
  }

  return {
    rootProject,
    findPackages,
    submodules,
    fetchDeps,
    boundaries,
  };
}

/**
 * Locate `.gitmodules` in the project root.
 *
 * @param {string} path Project scan root
 * @returns {string|null}
 */
function findGitmodules(path) {
  const candidate = join(path, ".gitmodules");
  if (safeExistsSync(candidate)) {
    return candidate;
  }
  return null;
}

/**
 * Build a purl string from resolved submodule/fetch coordinates, returning
 * null when the parts do not form a valid purl.
 *
 * @param {string} resolvedUrl Absolute git URL
 * @param {string} [version] Resolved version
 * @returns {string|null}
 */
export function buildDependentPurl(resolvedUrl, version) {
  const coords = submodulePurlCoordinates(resolvedUrl, version);
  if (!coords) {
    return null;
  }
  return tryBuildPurl({
    type: coords.type,
    namespace: coords.namespace,
    name: coords.name,
    version: coords.version,
    qualifiers: coords.qualifiers,
  });
}

/**
 * Order two `find_package` version requirements.
 *
 * The arguments are CMake version requirements such as `1.54` or `3.0.1`, which
 * are dotted numbers rather than semver, so they are compared segment by
 * segment. A segment that is not a number orders below every number, which puts
 * git describe output and similar strings behind a plain version.
 *
 * @param {string} left First version
 * @param {string} right Second version
 * @returns {number} Negative when `left` is lower, positive when it is higher
 */
function compareCmakeVersions(left, right) {
  const leftParts = String(left).split(".");
  const rightParts = String(right).split(".");
  for (let i = 0; i < Math.max(leftParts.length, rightParts.length); i++) {
    const leftNumber = Number.parseInt(leftParts[i] ?? "", 10);
    const rightNumber = Number.parseInt(rightParts[i] ?? "", 10);
    const leftValid = Number.isFinite(leftNumber);
    const rightValid = Number.isFinite(rightNumber);
    if (!leftValid && !rightValid) {
      continue;
    }
    if (!leftValid) {
      return -1;
    }
    if (!rightValid) {
      return 1;
    }
    if (leftNumber !== rightNumber) {
      return leftNumber - rightNumber;
    }
  }
  return 0;
}

/**
 * Fold the identity methods of a discarded duplicate into the retained one.
 *
 * Each CMake-like file records itself as a `Filename` method, so a package that
 * several files declare keeps one method per file naming them all.
 *
 * @param {Object} target Component being retained
 * @param {Object} source Component being collapsed away
 */
function mergeEvidence(target, source) {
  const sourceIdentity = source?.evidence?.identity;
  const incoming = (
    Array.isArray(sourceIdentity) ? sourceIdentity[0] : sourceIdentity
  )?.methods;
  if (!incoming?.length) {
    return;
  }
  target.evidence = target.evidence || {};
  target.evidence.identity = target.evidence.identity || { field: "purl" };
  const identity = Array.isArray(target.evidence.identity)
    ? target.evidence.identity[0]
    : target.evidence.identity;
  if (!identity) {
    return;
  }
  const methods = (identity.methods = identity.methods || []);
  for (const method of incoming) {
    if (!methods.some((existing) => existing.value === method.value)) {
      methods.push(method);
    }
  }
}

/**
 * Collapse components that name the same CMake package at different versions.
 *
 * `find_package(Boost 1.54)` in one `CMakeLists.txt` and `find_package(Boost
 * 1.64)` in another state two minimum requirements for a single dependency, not
 * two dependencies. A build that satisfies both links one Boost, the higher of
 * the two, so that requirement becomes the component version and the full set
 * is kept under `cdx:cmake:versionRequirements`.
 *
 * Matching is on name alone, case-insensitively. Components carrying a
 * `cdx:cmake:depKind` property are left alone: a FetchContent dependency or a
 * submodule is pinned to a commit that was really checked out, and two such
 * pins are genuinely two things.
 *
 * @param {Object[]} pkgList Components scraped from CMake-like files
 * @returns {Object[]} Components with one entry per package name, in first-seen order
 */
export function collapseCmakeVersions(pkgList) {
  if (!Array.isArray(pkgList) || pkgList.length < 2) {
    return Array.isArray(pkgList) ? pkgList : [];
  }
  const collapsed = [];
  const byName = new Map();
  const requirements = new Map();
  for (const pkg of pkgList) {
    const isResolvedDep = pkg?.properties?.some(
      (prop) => prop.name === "cdx:cmake:depKind",
    );
    if (!pkg?.name || isResolvedDep) {
      collapsed.push(pkg);
      continue;
    }
    const key = `${pkg.group || ""}/${pkg.name.toLowerCase()}`;
    const existing = byName.get(key);
    if (!existing) {
      byName.set(key, pkg);
      requirements.set(key, new Set(pkg.version ? [pkg.version] : []));
      collapsed.push(pkg);
      continue;
    }
    mergeEvidence(existing, pkg);
    if (pkg.version) {
      requirements.get(key).add(pkg.version);
      if (
        !existing.version ||
        compareCmakeVersions(pkg.version, existing.version) > 0
      ) {
        existing.version = pkg.version;
      }
    }
  }
  for (const [key, pkg] of byName) {
    const versions = Array.from(requirements.get(key)).sort(
      compareCmakeVersions,
    );
    if (versions.length < 2) {
      continue;
    }
    pkg.properties = pkg.properties || [];
    pkg.properties.push({
      name: "cdx:cmake:versionRequirements",
      value: versions.join("|"),
    });
    applyPurl(
      pkg,
      tryBuildPurl({
        type: pkg.type || "generic",
        namespace: pkg.group || null,
        name: pkg.name,
        version: pkg.version || null,
      }),
    );
  }
  return collapsed;
}

/** `cdx:cmake:depKind` values for dependencies downloaded at configure time. */
const FETCHED_KINDS = new Set(["fetch", "cpm", "external-project"]);

function cmakeProperty(pkg, name) {
  return pkg?.properties?.find((prop) => prop.name === name)?.value;
}

/**
 * Keep one component per dependency downloaded at configure time.
 *
 * The same `FetchContent_Declare` may be read from several files, and a
 * `find_package(<name>)` names the package a `FetchContent_Declare(<name>)` or
 * `CPMAddPackage` fetches. Within the components scraped from CMake files, the
 * first fetched component of each name stands for all of them, and a plain
 * `find_package` entry of that name is dropped.
 *
 * @param {Object[]} pkgList Components scraped from CMake-like files
 * @returns {Object[]} The components, in first-seen order
 */
export function preferFetchedCmakeDependencies(pkgList) {
  if (!Array.isArray(pkgList)) {
    return [];
  }
  const fetched = new Map();
  for (const pkg of pkgList) {
    const key = pkg?.name?.toLowerCase();
    if (
      key &&
      FETCHED_KINDS.has(cmakeProperty(pkg, "cdx:cmake:depKind")) &&
      !fetched.has(key)
    ) {
      fetched.set(key, pkg);
    }
  }
  return pkgList.filter((pkg) => {
    const key = pkg?.name?.toLowerCase();
    if (!key || !fetched.has(key)) {
      return true;
    }
    const kind = cmakeProperty(pkg, "cdx:cmake:depKind");
    return FETCHED_KINDS.has(kind) ? fetched.get(key) === pkg : !!kind;
  });
}

/**
 * Drop the components scraped from CMake files for a dependency the build tree
 * has resolved: the gitclone script names the repository and tag that were
 * really checked out, so its component replaces the declared one.
 *
 * @param {Object[]} pkgList Components collected so far
 * @param {string} name Name of the resolved dependency
 * @returns {Object[]} The components without the scraped entries for `name`
 */
export function withoutScrapedFetchDependency(pkgList, name) {
  const key = name?.toLowerCase();
  return pkgList.filter(
    (pkg) =>
      !(
        key &&
        pkg?.name?.toLowerCase() === key &&
        cmakeProperty(pkg, "cdx:cmake:resolvedVia") === "cmake-lists" &&
        FETCHED_KINDS.has(cmakeProperty(pkg, "cdx:cmake:depKind"))
      ),
  );
}

export { GIT_COMMAND, toRepoRelative };
