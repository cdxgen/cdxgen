import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Ubuntu / Debian codename map and RHEL display-name aliases.
 * Keep this list updated every year.
 */
export const OS_DISTRO_ALIAS = {
  "ubuntu-4.10": "warty",
  "ubuntu-5.04": "hoary",
  "ubuntu-5.10": "breezy",
  "ubuntu-6.06": "dapper",
  "ubuntu-6.10": "edgy",
  "ubuntu-7.04": "feisty",
  "ubuntu-7.10": "gutsy",
  "ubuntu-8.04": "hardy",
  "ubuntu-8.10": "intrepid",
  "ubuntu-9.04": "jaunty",
  "ubuntu-9.10": "karmic",
  "ubuntu-10.04": "lucid",
  "ubuntu-10.10": "maverick",
  "ubuntu-11.04": "natty",
  "ubuntu-11.10": "oneiric",
  "ubuntu-12.04": "precise",
  "ubuntu-12.10": "quantal",
  "ubuntu-13.04": "raring",
  "ubuntu-13.10": "saucy",
  "ubuntu-14.04": "trusty",
  "ubuntu-14.10": "utopic",
  "ubuntu-15.04": "vivid",
  "ubuntu-15.10": "wily",
  "ubuntu-16.04": "xenial",
  "ubuntu-16.10": "yakkety",
  "ubuntu-17.04": "zesty",
  "ubuntu-17.10": "artful",
  "ubuntu-18.04": "bionic",
  "ubuntu-18.10": "cosmic",
  "ubuntu-19.04": "disco",
  "ubuntu-19.10": "eoan",
  "ubuntu-20.04": "focal",
  "ubuntu-20.10": "groovy",
  "ubuntu-21.04": "hirsute",
  "ubuntu-21.10": "impish",
  "ubuntu-22.04": "jammy",
  "ubuntu-22.10": "kinetic",
  "ubuntu-23.04": "lunar",
  "ubuntu-23.10": "mantic",
  "ubuntu-24.04": "noble",
  "ubuntu-24.10": "oracular",
  "ubuntu-25.04": "plucky",
  "ubuntu-25.10": "questing",
  "debian-15": "duke",
  "debian-14": "forky",
  "debian-14.5": "forky",
  "debian-13": "trixie",
  "debian-13.5": "trixie",
  "debian-12": "bookworm",
  "debian-12.5": "bookworm",
  "debian-12.6": "bookworm",
  "debian-11": "bullseye",
  "debian-11.5": "bullseye",
  "debian-10": "buster",
  "debian-10.5": "buster",
  "debian-9": "stretch",
  "debian-9.5": "stretch",
  "debian-8": "jessie",
  "debian-8.5": "jessie",
  "debian-7": "wheezy",
  "debian-7.5": "wheezy",
  "debian-6": "squeeze",
  "debian-5": "lenny",
  "debian-4": "etch",
  "debian-3.1": "sarge",
  "debian-3": "woody",
  "debian-2.2": "potato",
  "debian-2.1": "slink",
  "debian-2": "hamm",
  "debian-1.3": "bo",
  "debian-1.2": "rex",
  "debian-1.1": "buzz",
  "red hat enterprise linux": "rhel",
  "red hat enterprise linux 6": "rhel-6",
  "red hat enterprise linux 7": "rhel-7",
  "red hat enterprise linux 8": "rhel-8",
  "red hat enterprise linux 9": "rhel-9",
  "red hat enterprise linux 10": "rhel-10",
};

// ---------------------------------------------------------------------------
// Raw os-release cache — keyed by the osRelease file path so the live-host
// cache (/etc/os-release) and any container rootfs path are kept separate.
// ---------------------------------------------------------------------------
const _osReleaseCache = new Map();

/**
 * Parse an os-release file from an arbitrary root path and return a plain
 * key→value object.  Results are cached per root path so the file is read
 * at most once per process per distinct root.
 *
 * @param {string} [root="/"] - Root of the filesystem to search (e.g. a
 *   container rootfs extracted to a temp directory, or "/" for the live host).
 * @returns {Object} Raw key/value pairs from the os-release file.
 */
export function readOsRelease(root = "/") {
  if (_osReleaseCache.has(root)) {
    return _osReleaseCache.get(root);
  }

  // Candidate locations, in preference order
  const candidates = [
    join(root, "etc", "os-release"),
    join(root, "usr", "lib", "os-release"),
  ];

  const data = {};
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        const content = readFileSync(candidate, "utf-8");
        for (const line of content.split("\n")) {
          if (line.startsWith("#") || !line.includes("=")) {
            continue;
          }
          const eqIdx = line.indexOf("=");
          const key = line.substring(0, eqIdx).trim();
          const raw = line.substring(eqIdx + 1).trim();
          // Strip surrounding single or double quotes
          data[key] = raw.replace(/^["']|["']$/g, "");
        }
        break; // Stop at the first readable file
      } catch (_e) {
        // Try the next candidate
      }
    }
  }

  _osReleaseCache.set(root, data);
  return data;
}

// Exported only for unit tests — resets the per-root cache.
export function _resetOsReleaseCache() {
  _osReleaseCache.clear();
}

/**
 * Derive structured distro information from an os-release file.
 *
 * Returns an object with:
 *   - purlType    {string}  "deb" | "apk" | "rpm"
 *   - namespace   {string}  purl namespace (e.g. "ubuntu", "alpine", "fedora")
 *   - distroId    {string}  ID + "-" + VERSION_ID  (e.g. "ubuntu-22.04")
 *   - distroName  {string}  codename/alias          (e.g. "jammy")
 *
 * Mirrors the logic in lib/managers/binary.js getOSPackages() so that both
 * callers share a single implementation.
 *
 * @param {string} [root="/"] - Filesystem root to look for os-release.
 * @returns {{ purlType: string, namespace: string, distroId: string, distroName: string }}
 */
export function getDistroInfo(root = "/") {
  const info = readOsRelease(root);

  const rawId = (info.ID || "").toLowerCase();
  const idLike = (info.ID_LIKE || "").toLowerCase();
  const versionId = info.VERSION_ID || "";

  // Determine the purl type
  let purlType = "rpm"; // safe default for unknown Linux
  switch (rawId) {
    case "debian":
    case "ubuntu":
    case "pop":
    case "kali":
    case "raspbian":
    case "linuxmint":
      purlType = "deb";
      break;
    case "alpine":
    case "openwrt":
      purlType = "apk";
      break;
    case "sles":
    case "suse":
    case "opensuse":
    case "opensuse-leap":
    case "opensuse-tumbleweed":
    case "fedora":
    case "rhel":
    case "centos":
    case "rocky":
    case "almalinux":
    case "oracle":
    case "ol":
    case "amzn":
    case "mageia":
    case "photon":
      purlType = "rpm";
      break;
    default:
      if (idLike.includes("debian") || idLike.includes("ubuntu")) {
        purlType = "deb";
      } else if (idLike.includes("alpine")) {
        purlType = "apk";
      } else if (
        idLike.includes("rhel") ||
        idLike.includes("centos") ||
        idLike.includes("fedora") ||
        idLike.includes("suse")
      ) {
        purlType = "rpm";
      }
      break;
  }

  // Determine the purl namespace (vendor)
  let namespace = rawId;
  if (rawId === "rhel") {
    namespace = "redhat";
  } else if (rawId === "ol") {
    namespace = "oracle";
  } else if (rawId === "amzn") {
    namespace = "amazonlinux";
  } else if (rawId === "opensuse-leap" || rawId === "opensuse-tumbleweed") {
    namespace = "opensuse";
  } else if (rawId === "almalinux") {
    namespace = "almalinux";
  } else if (!rawId) {
    // Fallback via ID_LIKE
    if (idLike.includes("rhel") || idLike.includes("centos")) {
      namespace = "redhat";
    } else if (idLike.includes("fedora")) {
      namespace = "fedora";
    } else if (idLike.includes("suse")) {
      namespace = "opensuse";
    } else if (idLike.includes("debian")) {
      namespace = "debian";
    } else if (idLike.includes("ubuntu")) {
      namespace = "ubuntu";
    } else {
      namespace = "linux";
    }
  }

  // Build distroId = ID-VERSION_ID (e.g. "fedora-25", "alpine-3.17")
  let distroId = versionId ? `${rawId}-${versionId}` : rawId;

  // Special-case Alpine: truncate to major.minor
  if (purlType === "apk" && versionId) {
    const parts = versionId.split(".");
    if (parts.length >= 2) {
      distroId = `${rawId}-${parts[0]}.${parts[1]}`;
    }
  }

  // Determine codename / alias
  let distroName =
    info.VERSION_CODENAME ||
    info.CENTOS_MANTISBT_PROJECT ||
    info.REDHAT_BUGZILLA_PRODUCT ||
    info.REDHAT_SUPPORT_PRODUCT ||
    "";
  distroName = distroName.toLowerCase();

  // Resolve well-known display name aliases
  if (distroName.includes(" ") && OS_DISTRO_ALIAS[distroName]) {
    distroName = OS_DISTRO_ALIAS[distroName];
  }
  if (!distroName && OS_DISTRO_ALIAS[distroId]) {
    distroName = OS_DISTRO_ALIAS[distroId];
  }

  return { purlType, namespace, distroId, distroName };
}
