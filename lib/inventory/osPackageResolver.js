import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";

import { escape as escapeGlob, globIterateSync, globSync } from "glob";

import { DEBUG_MODE, recordSymlinkResolution } from "../core/activity.js";
import { safeExistsSync, safeSpawnSync } from "../core/fs.js";
import { thoughtLog } from "../core/logger.js";
import { getDistroInfo } from "./osinfo.js";
import { buildOsPackagePurl } from "./osPackagePurl.js";

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------

/** file path → pkgInfo (or undefined when not owned by any package) */
const packageCache = new Map();

/** pkgName (as returned by dpkg-query -S) → pkgInfo */
const pkgNameCache = new Map();

// ---------------------------------------------------------------------------
// Exported for unit tests only — resets all caches.
// ---------------------------------------------------------------------------
/**
 * Reset all OS package resolver caches. Exported for unit tests only.
 */
export function _resetOsInfoCache() {
  packageCache.clear();
  pkgNameCache.clear();
}

// ---------------------------------------------------------------------------
// Alpine: parse "musl-1.2.4-r2" → { name: "musl", version: "1.2.4-r2" }
// ---------------------------------------------------------------------------
function parseAlpinePackage(pkgStr) {
  const parts = pkgStr.split("-");
  let versionIndex = parts.findIndex((p) => /^\d/.test(p));
  if (versionIndex === -1) {
    versionIndex = parts.length - 1;
  }
  return {
    name: parts.slice(0, versionIndex).join("-"),
    version: parts.slice(versionIndex).join("-"),
  };
}

// ---------------------------------------------------------------------------
// Build a PackageURL string from resolved package info.
//
// deb, rpm, apk and Homebrew packages are named by buildOsPackagePurl, the
// function the OBOM rows use as well, so a file and the package that owns it
// share one identity with the package an OBOM or a container scan lists. The
// distro qualifiers come from /etc/os-release via getDistroInfo(), never from
// a hard-coded table.
//
// Homebrew has no official purl type yet, but cdx-purl builds pkg:brew, as the
// OBOM does for its homebrew_packages rows. A brew purl carries no qualifiers:
// this used to pass an `arch` that the generic type it fell back to does not
// allow, so build() threw and a file of a Homebrew package got no purl at all.
// ---------------------------------------------------------------------------
function buildPurl(pkgInfo) {
  const distro =
    pkgInfo.type === "brew" || !pkgInfo.type ? undefined : getDistroInfo();
  return buildOsPackagePurl(pkgInfo, distro) || "";
}

// apk names an architecture its own way, which is not the way node does.
const APK_ARCHITECTURES = {
  x64: "x86_64",
  arm64: "aarch64",
  ia32: "x86",
  ppc64: "ppc64le",
  loong64: "loongarch64",
};

function apkArchitecture() {
  return APK_ARCHITECTURES[process.arch] || process.arch;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolves a file path to its owning OS package manager package, including a
 * correctly computed purl with distro qualifiers derived from /etc/os-release.
 *
 * @param {string} filePath - Absolute path to the library file
 * @returns {{ name: string, version: string, arch: string, type: string, epoch?: string, purl: string } | undefined}
 */
export function resolvePackageForFile(filePath) {
  // Package databases list absolute paths. A relative path comes from traced
  // or scanned content, would be matched as a pattern and may start with "-".
  if (!filePath || !isAbsolute(filePath)) {
    return undefined;
  }

  if (packageCache.has(filePath)) {
    return packageCache.get(filePath);
  }

  let pkgInfo;
  try {
    if (process.platform === "linux") {
      pkgInfo = _resolveLinux(filePath);
    } else if (process.platform === "darwin") {
      pkgInfo = _resolveDarwin(filePath);
    }
  } catch (err) {
    thoughtLog(
      `OS package resolution encountered an error for ${filePath}: ${err}`,
    );
  }

  if (pkgInfo) {
    pkgInfo.purl = buildPurl(pkgInfo);
  }

  packageCache.set(filePath, pkgInfo);
  return pkgInfo;
}

// ---------------------------------------------------------------------------
// Platform-specific resolvers
// ---------------------------------------------------------------------------

function _resolveLinux(filePath) {
  // 1. Debian/Ubuntu (dpkg-query -S)
  const dpkgRes = safeSpawnSync("dpkg-query", ["-S", "--", filePath]);
  if (dpkgRes && dpkgRes.status === 0 && dpkgRes.stdout) {
    const line = dpkgRes.stdout.split("\n")[0];
    const colonIdx = line.indexOf(": ");
    if (colonIdx !== -1) {
      const rawPkgName = line.substring(0, colonIdx).trim();
      if (pkgNameCache.has(rawPkgName)) {
        return pkgNameCache.get(rawPkgName);
      }
      const infoRes = safeSpawnSync("dpkg-query", [
        "-W",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: dpkg-query format string
        "-f=${Version} ${Architecture}",
        rawPkgName,
      ]);
      if (infoRes && infoRes.status === 0 && infoRes.stdout) {
        const [version, arch] = infoRes.stdout.trim().split(" ");
        const info = {
          name: rawPkgName.split(":")[0], // strip ":amd64" arch suffix
          version,
          arch,
          type: "deb",
        };
        pkgNameCache.set(rawPkgName, info);
        return info;
      }
    }
  }

  // 2. Alpine Linux (apk info -W)
  const apkRes = safeSpawnSync("apk", ["info", "-W", "--", filePath]);
  if (apkRes && apkRes.status === 0 && apkRes.stdout) {
    const line = apkRes.stdout.split("\n")[0].trim();
    const marker = " is owned by ";
    const markerIdx = line.indexOf(marker);
    if (markerIdx !== -1) {
      const pkgRaw = line.substring(markerIdx + marker.length).trim();
      const { name, version } = parseAlpinePackage(pkgRaw);
      return {
        name,
        version,
        arch: apkArchitecture(),
        type: "apk",
      };
    }
  }

  // 3. RPM-based (rpm -qf). The epoch is part of an rpm's identity; %{EPOCH} is
  // (none) for a package without one, so the conditional makes that a 0, which
  // means the same.
  const rpmRes = safeSpawnSync("rpm", [
    "-qf",
    "--qf",
    "%{NAME} %|EPOCH?{%{EPOCH}}:{0}| %{VERSION}-%{RELEASE} %{ARCH}\n",
    "--",
    filePath,
  ]);
  if (rpmRes && rpmRes.status === 0 && rpmRes.stdout) {
    const line = rpmRes.stdout.split("\n")[0].trim();
    const parts = line.split(" ");
    if (parts.length >= 4) {
      return {
        name: parts[0],
        epoch: parts[1],
        version: parts[2],
        arch: parts[3],
        type: "rpm",
      };
    }
  }

  return undefined;
}

function _resolveDarwin(filePath) {
  // Homebrew installs files under .../Cellar/<name>/<version>/...
  // Use path parsing rather than shelling out to brew (which is slow).
  const cellarMarkers = ["/Cellar/", "/homebrew/Cellar/"];
  for (const marker of cellarMarkers) {
    const idx = filePath.indexOf(marker);
    if (idx !== -1) {
      const rest = filePath.substring(idx + marker.length);
      const segments = rest.split("/");
      if (segments.length >= 2) {
        return {
          name: segments[0],
          version: segments[1],
          arch: process.arch,
          type: "brew",
        };
      }
    }
  }
  return undefined;
}

/**
 * Find the OS package component that provides a given file, by searching the
 * `internal:PkgProvides` property of each package in the OS package list.
 *
 * @param {string} afile Filename or path to look up (matched case-insensitively)
 * @param {Object[]} osPkgsList Array of OS package component objects to search
 * @returns {Object|undefined} The matching OS package component, or undefined if not found
 */
export function getOSPackageForFile(afile, osPkgsList) {
  for (const ospkg of osPkgsList) {
    for (const props of ospkg.properties || []) {
      if (
        props.name === "internal:PkgProvides" &&
        props.value.includes(afile.toLowerCase())
      ) {
        delete ospkg.scope;
        // dev packages are libraries
        ospkg.type = "library";
        // Set the evidence to indicate how we identified this package from the header or .so file
        ospkg.evidence = {
          identity: {
            field: "purl",
            confidence: 0.8,
            methods: [
              {
                technique: "filename",
                confidence: 0.8,
                value: `PkgProvides ${afile}`,
              },
            ],
          },
        };
        return ospkg;
      }
    }
  }
  return undefined;
}

function hasParentSegment(aPath) {
  return aPath.split(/[\\/]/).includes("..");
}

/**
 * Turn a directory named by the root filesystem under analysis, such as an
 * entry of PATH in the image config or a line of ld.so.conf, into a glob
 * pattern for that directory alone. The value is untrusted: used as is, its
 * `..` segments climb out of the base directory and its wildcards list trees.
 *
 * @param {string} dirPath Directory path
 * @returns {string|undefined} Escaped path. undefined for a path with `..` segments
 */
function toLiteralDirPattern(dirPath) {
  if (hasParentSegment(dirPath)) {
    if (DEBUG_MODE) {
      console.log(`Ignoring the path ${dirPath} as it contains '..' segments.`);
    }
    return undefined;
  }
  return escapeGlob(dirPath, { magicalBraces: true });
}

/**
 * Check whether a glob match, relative to the base directory, lies outside
 * it. Such a match is a file of this host and must not be listed or hashed.
 *
 * @param {string} relativePath Path relative to the base directory
 * @returns {boolean} true when the path is absolute or climbs above the base directory
 */
function leavesBasePath(relativePath) {
  return isAbsolute(relativePath) || hasParentSegment(relativePath);
}

// Ends an entry in the tree createDirMatcher() builds. No path segment is empty.
const DIR_END = "";

function dirSegments(dir) {
  return normalize(dir)
    .toLowerCase()
    .split(sep)
    .filter((segment) => segment && segment !== ".");
}

/**
 * Index a list of directories of an image, such as the entries of its PATH, to
 * look up the directory of each of its files. The image chooses the entries as
 * well as the directories, so a lookup must not cost more when there are more
 * entries: it takes one step per segment of the directory looked up.
 *
 * An entry is the name of a directory and not a glob. As the glob per entry
 * did, an absolute entry names that directory under any parent, so /bin is
 * also usr/local/bin, and a relative entry names a directory at the root only.
 * Case is ignored.
 *
 * @param dirs {Array[String]} Directories to look for
 * @return {Function} Takes a root-relative directory, returns true if an entry names it
 */
function createDirMatcher(dirs) {
  const rootDirs = new Set();
  // The absolute entries as a tree of their segments, the last one first.
  const nestedDirs = new Map();
  for (const dir of dirs) {
    const segments = dirSegments(dir);
    if (!segments.length) {
      continue;
    }
    if (!isAbsolute(dir)) {
      rootDirs.add(segments.join("/"));
      continue;
    }
    let node = nestedDirs;
    for (const segment of segments.reverse()) {
      if (!node.has(segment)) {
        node.set(segment, new Map());
      }
      node = node.get(segment);
    }
    node.set(DIR_END, true);
  }
  return (dir) => {
    const segments = dirSegments(dir);
    if (rootDirs.has(segments.join("/"))) {
      return true;
    }
    let node = nestedDirs;
    for (const segment of segments.reverse()) {
      node = node.get(segment);
      if (!node) {
        return false;
      }
      if (node.has(DIR_END)) {
        return true;
      }
    }
    return false;
  };
}

/**
 * Collect all executable files from the given list of binary paths
 *
 * The image is walked once for all the paths, which createDirMatcher() reads
 * as directory names.
 *
 * @param basePath Base directory
 * @param binPaths {Array[String]} Paths containing potential binaries
 * @param excludePaths {Array[String]} Container-relative paths that should be excluded from the result set
 * @return {Array[String]} List of executables
 */
export function collectExecutables(basePath, binPaths, excludePaths = []) {
  if (!binPaths) {
    return [];
  }
  const executablesByResolvedPath = new Map();
  const excludedPathSet = new Set(
    (excludePaths || []).map((f) => f.replace(/^\/+/, "").replace(/\\/g, "/")),
  );
  const ignoreList = [
    "**/*.{h,c,cpp,hpp,man,txt,md,htm,html,jar,ear,war,zip,tar,egg,keepme,gitignore,json,js,py,pyc}",
    "[",
  ];
  if (binPaths.length) {
    try {
      const isBinDir = createDirMatcher(binPaths);
      const files = globIterateSync("**/*", {
        cwd: basePath,
        absolute: false,
        nocase: true,
        nodir: true,
        dot: true,
        follow: true,
        ignore: ignoreList,
      });
      for (const file of files) {
        if (!isBinDir(dirname(file))) {
          continue;
        }
        let resolvedFile = file;
        try {
          resolvedFile = relative(basePath, realpathSync(join(basePath, file)));
          if (resolvedFile !== file) {
            recordSymlinkResolution(join(basePath, file), resolvedFile, {
              basePath,
              metadata: {
                resolutionKind: "executable",
              },
              reason: `Resolved executable candidate ${file} to ${resolvedFile}.`,
            });
          }
        } catch (err) {
          recordSymlinkResolution(join(basePath, file), undefined, {
            basePath,
            errorCode: err?.code || err?.name,
            metadata: {
              resolutionKind: "executable",
            },
            reason: `Failed to resolve executable candidate ${file}.`,
            status: "failed",
          });
          // Broken symlinks or permission errors can prevent realpath resolution.
          if (DEBUG_MODE) {
            console.log(`Unable to resolve executable path alias for ${file}`);
          }
        }
        if (
          excludedPathSet.has(file.replace(/^\/+/, "").replace(/\\/g, "/")) ||
          excludedPathSet.has(
            resolvedFile.replace(/^\/+/, "").replace(/\\/g, "/"),
          )
        ) {
          continue;
        }
        const existingFile = executablesByResolvedPath.get(resolvedFile);
        if (shouldPreferUsrMergedExecutablePath(file, existingFile)) {
          executablesByResolvedPath.set(resolvedFile, file);
        }
      }
    } catch (_err) {
      // ignore
    }
  }
  return Array.from(executablesByResolvedPath.values()).sort();
}

function shouldPreferUsrMergedExecutablePath(file, existingFile) {
  if (!existingFile) {
    return true;
  }
  const fileUsesUsrPrefix = file.startsWith("usr/");
  const existingFileUsesUsrPrefix = existingFile.startsWith("usr/");
  if (fileUsesUsrPrefix !== existingFileUsesUsrPrefix) {
    return fileUsesUsrPrefix;
  }
  return file < existingFile;
}

// The image writes ld.so.conf, and each directory and each include pattern in
// it is one more glob over the extracted image. A real one has a handful, so
// at most this many library directories, the caller's among them, and this
// many include patterns are searched.
const MAX_LD_CONF_ENTRIES = 128;

/**
 * Collect all shared library files from the given list of paths
 *
 * @param basePath Base directory
 * @param libPaths {Array[String]} Paths containing potential libraries
 * @param ldConf {String} Config file used by ldconfig to locate additional paths
 * @param ldConfDirPattern {String} Config directory that can contain more .conf files for ldconfig
 * @param excludePaths {Array[String]} Container-relative paths that should be excluded from the result set
 * @param extraLibGlobs {Array[String]} Extra container-relative globs for files
 *   the default paths miss, such as libphp*.so under Apache's modules
 *   directory. The existing globs are unchanged; this adds candidates only.
 *
 * @return {Array[String]} List of executables
 */
export function collectSharedLibs(
  basePath,
  libPaths,
  ldConf,
  ldConfDirPattern,
  excludePaths = [],
  extraLibGlobs = [],
) {
  if (!libPaths) {
    return [];
  }
  const sharedLibs = [];
  const excludedPathSet = new Set(
    (excludePaths || []).map((f) => f.replace(/^\/+/, "").replace(/\\/g, "/")),
  );
  const ignoreList = [
    "**/*.{h,c,cpp,hpp,man,txt,md,htm,html,jar,ear,war,zip,tar,egg,keepme,gitignore,json,js,py,pyc}",
  ];
  const addCandidate = (file) => {
    if (leavesBasePath(file)) {
      return;
    }
    let resolvedFile = file;
    try {
      resolvedFile = relative(basePath, realpathSync(join(basePath, file)));
      recordSymlinkResolution(join(basePath, file), resolvedFile, {
        basePath,
        metadata: {
          resolutionKind: "shared-library",
        },
        reason: `Resolved shared library candidate ${file} to ${resolvedFile}.`,
      });
    } catch (err) {
      recordSymlinkResolution(join(basePath, file), undefined, {
        basePath,
        errorCode: err?.code || err?.name,
        metadata: {
          resolutionKind: "shared-library",
        },
        reason: `Failed to resolve shared library candidate ${file}.`,
        status: "failed",
      });
      // Broken symlinks or permission errors can prevent realpath resolution.
    }
    if (
      excludedPathSet.has(file.replace(/^\/+/, "").replace(/\\/g, "/")) ||
      excludedPathSet.has(resolvedFile.replace(/^\/+/, "").replace(/\\/g, "/"))
    ) {
      return;
    }
    sharedLibs.push(file);
  };
  // A set keeps insertion order, and a pattern added while the set is walked
  // is visited as well.
  const allLdConfDirs = new Set(ldConfDirPattern ? [ldConfDirPattern] : []);
  // Any number of include patterns can match one file, the file holding them
  // among others, so a file is read the first time it is matched only.
  const seenLdConfs = new Set();
  collectAllLdConfs(basePath, ldConf, allLdConfDirs, libPaths, seenLdConfs);
  if (allLdConfDirs.size) {
    for (const aldconfPattern of allLdConfDirs) {
      // The patterns name files of the root filesystem under analysis, so an
      // absolute one starts at the base directory and not at the host's root.
      const confFiles = globSync(aldconfPattern, {
        cwd: basePath,
        root: basePath,
        absolute: false,
        nocase: true,
        nodir: true,
        dot: true,
        follow: false,
        // ldconfig does not expand braces in an include line.
        braceExpansion: false,
      });
      for (const moreConf of confFiles) {
        if (leavesBasePath(moreConf)) {
          continue;
        }
        collectAllLdConfs(
          basePath,
          moreConf,
          allLdConfDirs,
          libPaths,
          seenLdConfs,
        );
      }
    }
  }
  if (libPaths.length > MAX_LD_CONF_ENTRIES) {
    console.warn(
      `The image lists more than ${MAX_LD_CONF_ENTRIES} shared library directories. Only the first ${MAX_LD_CONF_ENTRIES} are searched.`,
    );
    libPaths = libPaths.slice(0, MAX_LD_CONF_ENTRIES);
  }
  for (const apath of Array.from(new Set(libPaths))) {
    try {
      const files = globSync(`**${apath}/*.{so,so.*,a,lib,dll}`, {
        cwd: basePath,
        absolute: false,
        nocase: true,
        nodir: true,
        dot: true,
        follow: true,
        ignore: ignoreList,
      });
      for (const file of files) {
        addCandidate(file);
      }
    } catch (_err) {
      // ignore
    }
  }
  for (const pattern of extraLibGlobs) {
    try {
      const files = globSync(pattern, {
        cwd: basePath,
        absolute: false,
        nocase: true,
        nodir: true,
        dot: true,
        follow: true,
        ignore: ignoreList,
      });
      for (const file of files) {
        addCandidate(file);
      }
    } catch (_err) {
      // ignore
    }
  }
  return Array.from(new Set(sharedLibs)).sort();
}

/**
 * Identify the file a path leads to. Symbolic and hard links to one file share
 * its device and inode; the real path stands in where the platform reports
 * neither.
 *
 * @param {string} filePath Path to the file, which may be a link
 * @returns {string} Key that is the same for every name of the file
 */
export function fileIdentity(filePath) {
  try {
    const stats = statSync(filePath, { bigint: true });
    if (stats.dev && stats.ino) {
      return `${stats.dev}:${stats.ino}`;
    }
    return realpathSync(filePath);
  } catch (_err) {
    // A path that cannot be resolved is only known by its name.
    return filePath;
  }
}

function collectAllLdConfs(
  basePath,
  ldConf,
  allLdConfDirs,
  libPaths,
  seenLdConfs,
) {
  if (ldConf && safeExistsSync(join(basePath, ldConf))) {
    const ldConfId = fileIdentity(join(basePath, ldConf));
    if (seenLdConfs.has(ldConfId)) {
      return;
    }
    seenLdConfs.add(ldConfId);
    const ldConfData = readFileSync(join(basePath, ldConf), "utf-8");
    for (let line of ldConfData.split("\n")) {
      line = line.replaceAll("\r", "").trim();
      if (!line.length || line.startsWith("#")) {
        continue;
      }
      if (line.startsWith("include ")) {
        let apattern = line.replace("include ", "");
        if (!apattern.includes("*")) {
          apattern = `${apattern}/*.conf`;
        }
        // ldconfig expands the wildcards of an include line, so only the
        // climb out of the base directory is refused here.
        if (
          !hasParentSegment(apattern) &&
          allLdConfDirs.size < MAX_LD_CONF_ENTRIES
        ) {
          allLdConfDirs.add(apattern);
        }
      } else if (line.startsWith("/")) {
        const apath = toLiteralDirPattern(line);
        // One past the limit is kept, so that collectSharedLibs() can tell the
        // list was cut.
        if (
          apath &&
          libPaths.length <= MAX_LD_CONF_ENTRIES &&
          !libPaths.includes(apath)
        ) {
          libPaths.push(apath);
        }
      }
    }
  }
}

// Native modules that language package managers install outside the library
// directories the loader searches: CPython and PyPy extension modules, PHP
// extensions, Ruby gem extensions, Node.js addons, and the native half of a
// .NET runtime. A Brotli decoder compiled into one of them is invisible unless
// the file is read.
const NATIVE_EXTENSION_GLOBS = [
  "**/site-packages/**/*.{so,pyd}",
  "**/dist-packages/**/*.so",
  "**/lib/php/**/*.so",
  "**/lib/php*/modules/*.so",
  "**/php*/ext/php_*.dll",
  "**/gems/*/lib/**/*.{so,bundle}",
  "**/gems/*/extensions/**/*.{so,bundle}",
  "**/bundle/extensions/**/*.{so,bundle}",
  "**/node_modules/**/*.node",
  "**/dotnet/shared/*/*/*.so",
  "**/.dotnet/shared/*/*/*.so",
  // Of a Windows runtime's many DLLs, only this one is native and holds the
  // decoder.
  "**/dotnet/shared/*/*/System.IO.Compression.Native.dll",
];
const NATIVE_EXTENSION_IGNORES = ["proc/**", "sys/**", "dev/**"];

/**
 * The most native extension candidates one scan returns.
 *
 * @type {number}
 */
export const MAX_NATIVE_EXTENSIONS = 4096;

// The deepest directory level searched for native extensions. A pattern with
// more than one fixed segment between two `**`, such as lib/php or gems/*/lib,
// makes glob start another walk of the subtree at every nested match, so
// without a bound the work grows with the cube of the depth of the image.
const MAX_NATIVE_EXTENSION_DEPTH = 64;

/**
 * Collect native extension modules under a root file system that the library
 * collector does not see, leaving out paths a package database owns and paths
 * already collected. Symlinks are not followed, so a link pointing out of the
 * root is never listed, and the search stops MAX_NATIVE_EXTENSION_DEPTH
 * levels below the root.
 *
 * @param {string} basePath extracted root file system
 * @param {string[]} [excludePaths] root-relative paths to leave out
 * @returns {string[]} root-relative paths, sorted, capped at MAX_NATIVE_EXTENSIONS
 */
export function collectNativeExtensions(basePath, excludePaths = []) {
  if (!basePath) {
    return [];
  }
  const excluded = new Set(
    (excludePaths || []).map((f) => f.replace(/^\/+/, "").replace(/\\/g, "/")),
  );
  let files = [];
  try {
    files = globSync(NATIVE_EXTENSION_GLOBS, {
      cwd: basePath,
      absolute: false,
      nodir: true,
      dot: true,
      follow: false,
      maxDepth: MAX_NATIVE_EXTENSION_DEPTH,
      ignore: NATIVE_EXTENSION_IGNORES,
    });
  } catch (_err) {
    return [];
  }
  const result = new Set();
  for (const file of files) {
    const normalized = file.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!excluded.has(normalized)) {
      result.add(normalized);
    }
  }
  return Array.from(result).sort().slice(0, MAX_NATIVE_EXTENSIONS);
}

const OS_PACKAGE_PURL_PREFIXES = [
  "pkg:deb/",
  "pkg:apk/",
  "pkg:rpm/",
  "pkg:alpm/",
  "pkg:qpkg/",
  "pkg:generic/",
];

/**
 * Whether a source file is the installation record of a language package,
 * the file a package manager writes when it installs the package: dist-info
 * or egg-info metadata, an installed gemspec, a package.json inside
 * node_modules, or a jar. A lock file or manifest only names packages, so an
 * OS package owning one says nothing about who installed them.
 *
 * @param {string} filePath root-relative path with forward slashes
 * @returns {boolean}
 */
function isInstallRecord(filePath) {
  const parts = filePath.split("/");
  const name = parts.at(-1) || "";
  const parent = parts.at(-2) || "";
  if (parent.endsWith(".dist-info") || parent.endsWith(".egg-info")) {
    return true;
  }
  if (name.endsWith(".egg-info") || name.endsWith(".jar")) {
    return true;
  }
  if (name.endsWith(".gemspec") && parts.includes("specifications")) {
    return true;
  }
  return name === "package.json" && parts.includes("node_modules");
}

/**
 * Mark language packages that an OS package installed. Alpine's py3-brotli
 * ships a Brotli-1.1.0.dist-info that a Python scan reports as
 * pkg:pypi/brotli@1.1.0, but a distro fixes it by backporting under the same
 * upstream version, so a PyPI advisory range keeps matching after the fix. The
 * `cdx:os:installedBy` property names the OS package that owns the
 * installation record, so a consumer can judge the component by that package
 * instead.
 *
 * A component is marked only when every installation record it was read from
 * belongs to an OS package: a copy that pip put in a virtual environment
 * beside the distro's is not the distro's to fix. Run it after duplicates
 * merge, so that a merged component carries all of its records.
 *
 * @param {Object[]} components BOM components, mutated in place
 * @param {Map<string, string>|undefined} ownerByPath root-relative file path to
 *   owning OS package bom-ref
 * @param {string} [rootDir] extracted root, stripped from absolute source paths
 * @returns {number} how many components were marked
 */
export function markOsInstalledLanguagePackages(
  components,
  ownerByPath,
  rootDir,
) {
  if (!ownerByPath?.size || !Array.isArray(components)) {
    return 0;
  }
  const rootPrefix = rootDir
    ? rootDir.replaceAll("\\", "/").replace(/\/+$/, "")
    : undefined;
  let marked = 0;
  for (const component of components) {
    const purl = component?.purl;
    if (
      typeof purl !== "string" ||
      !purl.startsWith("pkg:") ||
      OS_PACKAGE_PURL_PREFIXES.some((prefix) => purl.startsWith(prefix)) ||
      !Array.isArray(component.properties) ||
      component.properties.some((prop) => prop.name === "cdx:os:installedBy")
    ) {
      continue;
    }
    const owners = new Set();
    let records = 0;
    let unowned = 0;
    for (const prop of component.properties) {
      if (prop.name !== "internal:SrcFile" || typeof prop.value !== "string") {
        continue;
      }
      let filePath = prop.value.replaceAll("\\", "/");
      if (rootPrefix && filePath.startsWith(`${rootPrefix}/`)) {
        filePath = filePath.slice(rootPrefix.length);
      }
      filePath = filePath.replace(/^\/+/, "");
      if (!isInstallRecord(filePath)) {
        continue;
      }
      records += 1;
      const owner = ownerByPath.get(filePath);
      if (owner) {
        owners.add(owner);
      } else {
        unowned += 1;
      }
    }
    if (!records || unowned) {
      continue;
    }
    for (const owner of Array.from(owners).sort()) {
      component.properties.push({ name: "cdx:os:installedBy", value: owner });
    }
    marked += 1;
  }
  return marked;
}
