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
  "ubuntu-26.04": "resolute",
  "ubuntu-26.10": "stonking",
  "debian-15": "duke",
  "debian-14": "forky",
  "debian-14.5": "forky",
  "debian-13": "trixie",
  "debian-13.7": "trixie",
  "debian-13.6": "trixie",
  "debian-13.5": "trixie",
  "debian-13.4": "trixie",
  "debian-13.3": "trixie",
  "debian-13.2": "trixie",
  "debian-13.1": "trixie",
  "debian-12": "bookworm",
  "debian-12.15": "bookworm",
  "debian-12.14": "bookworm",
  "debian-12.13": "bookworm",
  "debian-12.12": "bookworm",
  "debian-12.11": "bookworm",
  "debian-12.10": "bookworm",
  "debian-12.9": "bookworm",
  "debian-12.8": "bookworm",
  "debian-12.7": "bookworm",
  "debian-12.6": "bookworm",
  "debian-12.5": "bookworm",
  "debian-12.4": "bookworm",
  "debian-12.2": "bookworm",
  "debian-12.1": "bookworm",
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

/**
 * Canonical purl namespace for distro vendors that are published under more
 * than one spelling. Both the os-release path (`getDistroInfo`) and the trivy
 * passthrough in `lib/managers/binary.js` route through this single map so the
 * two paths cannot drift apart again.
 *
 * Azure Linux 2.0 is CBL-Mariner 2.0 — Microsoft renamed the product — and the
 * OSV feed publishes `pkg:rpm/azure-linux/<name>` for every generation
 * (ecosystems "Azure Linux:2" and "Azure Linux:3"), so the historical
 * spellings azurelinux, cbl-mariner and mariner all canonicalise to
 * "azure-linux". rhel/ol/amzn/opensuse-* are the cases previously inlined in
 * getDistroInfo(); alma/rocky-linux were previously inlined in binary.js.
 *
 * Amazon Linux canonicalises to "amazon", the spelling the vulnerability feeds
 * publish (AppThreat vuln-list `amazon`): the os-release ID is `amzn` and
 * trivy emits `amazon`, and the previous `amazonlinux` mapping here matched
 * neither, so live-host Amazon Linux purls matched nothing at all.
 */
export const OS_NAMESPACE_ALIAS = {
  alma: "almalinux",
  amazonlinux: "amazon",
  amzn: "amazon",
  azurelinux: "azure-linux",
  "cbl-mariner": "azure-linux",
  mariner: "azure-linux",
  ol: "oracle",
  "opensuse-leap": "opensuse",
  "opensuse-tumbleweed": "opensuse",
  rhel: "redhat",
  "rocky-linux": "rocky",
};

/**
 * Vendor prefixes that `distro` qualifier values are canonicalised for, so one
 * release has exactly one qualifier value no matter which side produced it.
 *
 * trivy stamps the qualifier from its own distro table while cdxgen stamps it
 * from os-release, and the two disagree: an Oracle Linux 9.8 image came out
 * with `oracle-9.8` on 99 components and `ol-9.8` on 43, and a RHEL 9.8 image
 * with namespace `redhat` but qualifier `rhel-9.8`. Canonicalising both sides
 * through this map collapses each release onto the vendor its purl namespace
 * already uses.
 *
 * SUSE is deliberately absent. `sles-15.6`, `opensuse-leap-15.6` and
 * `opensuse-tumbleweed-<snapshot>` are the values consumers derive the release
 * channel from (vulnerability-db maps them to per-release channels), and both
 * sides already agree on them; folding Leap and Tumbleweed onto a bare
 * `opensuse-` vendor would destroy exactly the distinction that matters.
 *
 * Keys are matched longest-first so `cbl-mariner-2.0` resolves against the
 * full vendor segment rather than a shorter prefix.
 */
export const OS_DISTRO_QUALIFIER_ALIAS = {
  alma: "almalinux",
  amazonlinux: "amazon",
  amzn: "amazon",
  azurelinux: "azure-linux",
  "cbl-mariner": "azure-linux",
  mariner: "azure-linux",
  ol: "oracle",
  rhel: "redhat",
  "rocky-linux": "rocky",
};

// A distro qualifier reaches a purl verbatim, so anything outside the purl
// qualifier charset makes the whole purl — and with it the whole BOM —
// invalid. trivy emits Amazon Linux as
// `amazon-2023.12.20260727+(Amazon Linux)`, which failed cdxgen's own schema
// validation and cost the entire SBOM. The value is also stamped on the purl
// of every OS package, so one longer than any release is named would be
// multiplied by the package count; such a value is rejected too.
const SAFE_DISTRO_QUALIFIER = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Whether a `distro` qualifier value is safe to place in a purl unencoded.
 *
 * @param {string} qualifier - distro qualifier value
 * @returns {boolean} true when the value contains only purl-safe characters
 *   and is at most 128 characters long
 */
export function isCleanDistroQualifier(qualifier) {
  return !!qualifier && SAFE_DISTRO_QUALIFIER.test(qualifier);
}

const OS_DISTRO_QUALIFIER_ALIAS_KEYS = Object.keys(
  OS_DISTRO_QUALIFIER_ALIAS,
).sort((a, b) => b.length - a.length);

/**
 * Canonicalise the vendor prefix of a `distro` qualifier value
 * (e.g. "cbl-mariner-2.0" or "mariner-2.0" -> "azure-linux-2.0") so a release
 * has exactly one qualifier spelling regardless of which tool emitted it.
 * Values without a known vendor prefix are returned unchanged.
 *
 * @param {string} qualifier - distro qualifier value such as "azurelinux-3.0"
 * @returns {string} canonical qualifier value
 */
export function canonicalDistroQualifier(qualifier) {
  if (!qualifier) {
    return qualifier;
  }
  for (const key of OS_DISTRO_QUALIFIER_ALIAS_KEYS) {
    if (qualifier.startsWith(`${key}-`)) {
      return `${OS_DISTRO_QUALIFIER_ALIAS[key]}${qualifier.slice(key.length)}`;
    }
  }
  return qualifier;
}

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
/**
 * Reset the per-root os-release cache. Exported for unit tests only.
 */
export function _resetOsReleaseCache() {
  _osReleaseCache.clear();
}

/**
 * Derive structured distro information from an os-release file.
 *
 * Returns an object with:
 *   - purlType    {string}  "deb" | "apk" | "rpm" | "alpm" (Arch and the
 *                           distros built on it)
 *   - namespace   {string}  canonical purl namespace (e.g. "ubuntu", "alpine",
 *                           "azure-linux" for both Azure Linux and CBL-Mariner)
 *   - distroId    {string}  ID + "-" + VERSION_ID with a canonical vendor
 *                           prefix (e.g. "ubuntu-22.04", "azure-linux-3.0",
 *                           "alpine-3.24.3")
 *   - distroName  {string}  release codename, or a token OS_DISTRO_ALIAS knows
 *                           (e.g. "jammy", "rhel", "alpine-3.24"); empty when
 *                           the distro has neither
 *
 * lib/managers/binary.js getOSPackages() reads its distro from here, so a
 * container scan and an OBOM run on the same system give a package the same
 * `distro` and `distro_name` qualifiers.
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
    case "alpaquita":
    case "openwrt":
    case "wolfi":
    case "chainguard":
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
    case "azurelinux":
    case "cbl-mariner":
    case "mariner":
    case "oracle":
    case "ol":
    case "amzn":
    case "mageia":
    case "photon":
      purlType = "rpm";
      break;
    case "arch":
    case "archarm":
    case "manjaro":
    case "endeavouros":
    case "cachyos":
    case "steamos":
    case "artix":
      purlType = "alpm";
      break;
    default:
      if (idLike.includes("debian") || idLike.includes("ubuntu")) {
        purlType = "deb";
      } else if (idLike.includes("alpine")) {
        purlType = "apk";
      } else if (idLike.split(/\s+/u).includes("arch")) {
        // A token, not a substring: ID_LIKE is a space-separated list.
        purlType = "alpm";
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

  // Determine the purl namespace (vendor), canonicalising vendors that are
  // published under several spellings (e.g. mariner -> azure-linux)
  let namespace = OS_NAMESPACE_ALIAS[rawId] || rawId;
  if (!rawId) {
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
    } else if (purlType === "alpm") {
      namespace = "arch";
    } else {
      namespace = "linux";
    }
  }

  // Build distroId = ID-VERSION_ID as os-release writes it (e.g. "fedora-25",
  // "alpine-3.24.3"), canonicalising the vendor prefix so one release has a
  // single qualifier value (e.g. "mariner-2.0" and "azurelinux-3.0" ->
  // "azure-linux-2.0"/"azure-linux-3.0")
  const releaseId = versionId ? `${rawId}-${versionId}` : rawId;
  const distroId = canonicalDistroQualifier(releaseId);

  // distro_name is a release codename or a token OS_DISTRO_ALIAS knows
  // ("bookworm", "jammy", "rhel", "alpine-3.24"), never a product display
  // name: "AlmaLinux" or "Rocky Linux 9" has no place in a purl, since RPM
  // distros track packages flat and a display name there breaks vulnerability
  // matching. A product name counts only when it resolves through the alias
  // table, which holds the RHEL names.
  let distroName = (info.VERSION_CODENAME || "").toLowerCase();
  if (!distroName) {
    const productName = (
      info.CENTOS_MANTISBT_PROJECT ||
      info.REDHAT_BUGZILLA_PRODUCT ||
      info.REDHAT_SUPPORT_PRODUCT ||
      ""
    ).toLowerCase();
    if (productName && Object.hasOwn(OS_DISTRO_ALIAS, productName)) {
      distroName = OS_DISTRO_ALIAS[productName];
    }
  }
  // Alpine names its release series: 3.24.3 belongs to alpine-3.24, the unit
  // its security data is kept in.
  if (rawId === "alpine" && versionId) {
    const parts = versionId.split(".");
    if (parts.length >= 2) {
      distroName = `alpine-${parts[0]}.${parts[1]}`;
    }
  }
  // The alias of the release itself (ubuntu-24.04 -> noble) wins over the
  // codename the file carries.
  if (versionId && Object.hasOwn(OS_DISTRO_ALIAS, releaseId)) {
    distroName = OS_DISTRO_ALIAS[releaseId];
  }

  return { purlType, namespace, distroId, distroName };
}
