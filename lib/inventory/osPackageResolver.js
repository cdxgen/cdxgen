import { readFileSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";

import { globSync } from "glob";

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
  if (!filePath) {
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
  const dpkgRes = safeSpawnSync("dpkg-query", ["-S", filePath]);
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
  const apkRes = safeSpawnSync("apk", ["info", "-W", filePath]);
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

/**
 * Collect all executable files from the given list of binary paths
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
  for (const apath of binPaths) {
    try {
      const files = globSync(`**${apath}/*`, {
        cwd: basePath,
        absolute: false,
        nocase: true,
        nodir: true,
        dot: true,
        follow: true,
        ignore: ignoreList,
      });
      for (const file of files) {
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
  const allLdConfDirs = ldConfDirPattern ? [ldConfDirPattern] : [];
  collectAllLdConfs(basePath, ldConf, allLdConfDirs, libPaths);
  if (allLdConfDirs.length) {
    for (const aldconfPattern of allLdConfDirs) {
      const confFiles = globSync(aldconfPattern, {
        cwd: basePath,
        absolute: false,
        nocase: true,
        nodir: true,
        dot: true,
        follow: false,
      });
      for (const moreConf of confFiles) {
        collectAllLdConfs(basePath, moreConf, allLdConfDirs, libPaths);
      }
    }
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

function collectAllLdConfs(basePath, ldConf, allLdConfDirs, libPaths) {
  if (ldConf && safeExistsSync(join(basePath, ldConf))) {
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
        if (!allLdConfDirs.includes(apattern)) {
          allLdConfDirs.push(apattern);
        }
      } else if (line.startsWith("/")) {
        if (!libPaths.includes(line)) {
          libPaths.push(line);
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
  "**/site-packages/**/*.so",
  "**/dist-packages/**/*.so",
  "**/lib/php/**/*.so",
  "**/lib/php*/modules/*.so",
  "**/gems/*/lib/**/*.{so,bundle}",
  "**/gems/*/extensions/**/*.{so,bundle}",
  "**/bundle/extensions/**/*.{so,bundle}",
  "**/node_modules/**/*.node",
  "**/dotnet/shared/*/*/*.so",
  "**/.dotnet/shared/*/*/*.so",
];
const NATIVE_EXTENSION_IGNORES = ["proc/**", "sys/**", "dev/**"];

/**
 * The most native extension candidates one scan returns.
 *
 * @type {number}
 */
export const MAX_NATIVE_EXTENSIONS = 4096;

/**
 * Collect native extension modules under a root file system that the library
 * collector does not see, leaving out paths a package database owns and paths
 * already collected. Symlinks are not followed, so a link pointing out of the
 * root is never listed.
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
