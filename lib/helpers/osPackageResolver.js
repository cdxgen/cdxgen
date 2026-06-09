import { PackageURL } from "packageurl-js";

import { thoughtLog } from "./logger.js";
import { getDistroInfo } from "./osinfo.js";
import { safeSpawnSync } from "./utils.js";

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
// Distro qualifiers (distro, distro_name) are taken from /etc/os-release via
// getDistroInfo() so they are always accurate, never hardcoded.
//
// "brew" is not an official PackageURL type — Homebrew packages are emitted
// as pkg:generic with a package_manager=homebrew qualifier.
// ---------------------------------------------------------------------------
function buildPurl(pkgInfo) {
  let purlType = pkgInfo.type;
  let namespace;
  const qualifiers = {};

  if (pkgInfo.arch) {
    qualifiers.arch = pkgInfo.arch;
  }

  if (purlType === "deb" || purlType === "apk" || purlType === "rpm") {
    const di = getDistroInfo();
    namespace = di.namespace;

    // distro qualifier: ID-VERSION_ID (e.g. "fedora-25", "alpine-3.17")
    if (di.distroId) {
      qualifiers.distro = di.distroId;
    }
    // distro_name qualifier: codename (e.g. "jammy", "bookworm")
    if (di.distroName) {
      qualifiers.distro_name = di.distroName;
    }
  } else if (purlType === "brew") {
    // No official brew purl type — use generic with qualifier
    purlType = "generic";
    qualifiers.package_manager = "homebrew";
  }

  const finalQualifiers = Object.keys(qualifiers).length
    ? qualifiers
    : undefined;

  try {
    return new PackageURL(
      purlType,
      namespace || undefined,
      pkgInfo.name,
      pkgInfo.version || undefined,
      finalQualifiers,
      undefined,
    ).toString();
  } catch (_e) {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolves a file path to its owning OS package manager package, including a
 * correctly computed purl with distro qualifiers derived from /etc/os-release.
 *
 * @param {string} filePath - Absolute path to the library file
 * @returns {{ name: string, version: string, arch: string, type: string, purl: string } | undefined}
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
        arch: process.arch === "x64" ? "x86_64" : process.arch,
        type: "apk",
      };
    }
  }

  // 3. RPM-based (rpm -qf)
  const rpmRes = safeSpawnSync("rpm", [
    "-qf",
    "--qf",
    "%{NAME} %{VERSION}-%{RELEASE} %{ARCH}\n",
    filePath,
  ]);
  if (rpmRes && rpmRes.status === 0 && rpmRes.stdout) {
    const line = rpmRes.stdout.split("\n")[0].trim();
    const parts = line.split(" ");
    if (parts.length >= 3) {
      return {
        name: parts[0],
        version: parts[1],
        arch: parts[2],
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
          type: "brew", // remapped to pkg:generic in buildPurl
        };
      }
    }
  }
  return undefined;
}
