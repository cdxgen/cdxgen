import { getDistroInfo } from "./osinfo.js";
import { buildOsPackagePurl, osPackageVersion } from "./osPackagePurl.js";
import { tryBuildPurl } from "./purl.js";

/**
 * Derive a version value from an osquery result row.
 *
 * Falls back through alternate row fields (e.g. `hotfix_id`, `port`, `pid`)
 * that carry version-like values for the given query category.
 *
 * @param {Object} res osquery result row
 * @returns {string|undefined} First present version-like field value
 */
export function deriveOsQueryVersion(res) {
  return (
    res.version ||
    res.hotfix_id ||
    res.hardware_version ||
    res.port ||
    res.pid ||
    res.subject_key_id ||
    res.interface ||
    res.instance_id
  );
}

/**
 * Derive a name value from an osquery result row.
 *
 * @param {Object} res osquery result row
 * @param {boolean} singleResult Whether the query returned exactly one row
 * @param {string} queryName Query name used as a fallback name for single-result queries
 * @returns {string|undefined} First present name-like field value
 */
export function deriveOsQueryName(res, singleResult, queryName) {
  let name =
    res.name ||
    res.device_id ||
    res.hotfix_id ||
    res.uuid ||
    res.serial ||
    res.pid ||
    res.address ||
    res.ami_id ||
    res.interface ||
    res.client_app_id;
  if (!name && singleResult && queryName) {
    name = queryName;
  }
  return name;
}

/**
 * Derive a publisher value from an osquery result row.
 *
 * @param {Object} res osquery result row
 * @returns {string} Publisher-like value, or an empty string when absent or literal `"null"`
 */
export function deriveOsQueryPublisher(res) {
  const publisher =
    res.publisher ||
    res.maintainer ||
    res.creator ||
    res.manufacturer ||
    res.provider ||
    res.packager ||
    res.developer_name ||
    "";
  return publisher === "null" ? "" : publisher;
}

/**
 * Derive a description value from an osquery result row.
 *
 * @param {Object} res osquery result row
 * @returns {string} First present description-like field value, or an empty string
 */
export function deriveOsQueryDescription(res) {
  return (
    res.description ||
    res.summary ||
    res.arguments ||
    res.device ||
    res.codename ||
    res.section ||
    res.status ||
    res.identifier ||
    res.components ||
    ""
  );
}

/**
 * Sanitize an identity string for use in component names and references.
 *
 * @param {string} value Raw identity value
 * @param {Object} [options]
 * @param {boolean} [options.keepSpaces=false] Keep spaces, as a component name
 *   does: the real name of `7-Zip 26.02 (x64)` is not `7-Zip+26.02+(x64)`, and
 *   a purl encodes its own spaces
 * @returns {string} Value with spaces mapped to `+` (unless kept), `:`/`%` mapped to `-`, and `@`/brace delimiters trimmed
 */
export function sanitizeOsQueryIdentity(value, { keepSpaces = false } = {}) {
  return String(value || "")
    .replace(/ /g, keepSpaces ? " " : "+")
    .replace(/[:%]/g, "-")
    .replace(/^[@{]/g, "")
    .replace(/[}]$/g, "");
}

/**
 * Sanitize a value for safe use inside a `bom-ref`.
 *
 * @param {string} value Raw value
 * @param {string} [fallback="unknown"] Value returned when the input is empty or `"null"`
 * @returns {string} Whitespace-collapsed value with bom-ref delimiters replaced by `-`
 */
export function sanitizeOsQueryBomRefValue(value, fallback = "unknown") {
  const normalizedValue = String(value || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalizedValue || normalizedValue === "null") {
    return fallback;
  }
  return normalizedValue.replace(/[:@#\[\]=]/g, "-");
}

/**
 * Build a deterministic fallback `bom-ref` for an osquery-derived component.
 *
 * @param {string} queryCategory Osquery category (e.g. `deb_packages`)
 * @param {string} componentType CycloneDX component type
 * @param {string|undefined} name Component name
 * @param {string|undefined} version Component version
 * @param {string|undefined} identityField Row field used to distinguish the component's identity
 * @param {string|undefined} identityValue Value of the identity field
 * @returns {string} BOM ref of the form `osquery:<category>:<type>:<name>@<version>[<field>=<value>]`
 */
export function createOsQueryFallbackBomRef(
  queryCategory,
  componentType,
  name,
  version,
  identityField,
  identityValue,
) {
  const categoryRef = sanitizeOsQueryBomRefValue(queryCategory, "component");
  const componentTypeRef = sanitizeOsQueryBomRefValue(
    componentType,
    "component",
  );
  const nameRef = sanitizeOsQueryBomRefValue(
    name || queryCategory,
    "component",
  );
  const versionRef = sanitizeOsQueryBomRefValue(version, "unknown");
  const baseBomRef = `osquery:${categoryRef}:${componentTypeRef}:${nameRef}@${versionRef}`;
  if (!identityField || !identityValue) {
    return baseBomRef;
  }
  const identityFieldRef = sanitizeOsQueryBomRefValue(
    identityField,
    "identity",
  );
  const identityValueRef = sanitizeOsQueryBomRefValue(identityValue, "unknown");
  return `${baseBomRef}[${identityFieldRef}=${identityValueRef}]`;
}

/**
 * Determine whether an osquery-derived component type may carry a purl.
 *
 * @param {string} componentType CycloneDX component type
 * @returns {boolean} `false` for `cryptographic-asset`, `data`, `device`, and `information`
 */
export function shouldCreateOsQueryPurl(componentType) {
  return !["cryptographic-asset", "data", "device", "information"].includes(
    componentType || "",
  );
}

// Purl types whose type rules require a namespace. For OS package types the
// namespace is the distro vendor (`pkg:deb/debian/...`, `pkg:rpm/redhat/...`),
// which osquery does not report but /etc/os-release does. deb, rpm and apk rows
// are named by createOsQueryPackageIdentity; this covers the other types that
// need a vendor (portage's ebuild) and a caller that asks for one of the three
// directly.
const NAMESPACE_REQUIRED_TYPES = new Set([
  "deb",
  "rpm",
  "apk",
  "alpm",
  "ebuild",
]);

/**
 * Construct a purl string for an osquery-derived component.
 *
 * Builds through `tryBuildPurl`, so an invalid combination yields `null`
 * instead of throwing. Derives a swid `tag_id` qualifier when missing and a
 * distro namespace from `/etc/os-release` for OS package types that require one.
 *
 * @param {string} purlType Purl type (e.g. `deb`, `rpm`, `generic`)
 * @param {string|null} group Purl namespace or group
 * @param {string} name Component name
 * @param {string} version Component version
 * @param {Object|null} qualifiers Purl qualifiers
 * @param {string|null} subpath Purl subpath (leading slashes are stripped)
 * @returns {string|null} Canonical purl string, or `null` when the parts do not form a valid purl
 */
export function createOsQueryPurl(
  purlType,
  group,
  name,
  version,
  qualifiers,
  subpath,
) {
  // cdx-purl rejects absolute subpaths; strip a leading slash so filesystem
  // paths like /usr/lib/libcrypto.dylib become relative subpath segments.
  const safeSubpath = subpath ? subpath.replace(/^\/+/, "") : null;
  const type = purlType || "generic";
  const finalQualifiers = { ...qualifiers };
  // swid purls require a tag_id qualifier (ISO/IEC 19770-2). Auto-derive one
  // from the component name when the caller did not provide one.
  if (type === "swid" && !finalQualifiers.tag_id) {
    finalQualifiers.tag_id = name;
  }
  // Rows with no group whose purl type requires a namespace get the vendor from
  // /etc/os-release, the way osPackageResolver does, so they keep a valid purl
  // instead of losing one.
  let namespace = group || null;
  if (!namespace && NAMESPACE_REQUIRED_TYPES.has(type)) {
    namespace = getDistroInfo().namespace || null;
  }
  // tryBuildPurl rather than build: a component that cannot be expressed as a
  // valid purl must not abort the whole SBOM. Before this, an unknown distro on
  // Linux threw E_REQUIRED_COMPONENT out of the middle of createCppBom.
  return tryBuildPurl({
    type,
    namespace,
    name: name,
    version: version || null,
    qualifiers: Object.keys(finalQualifiers).length ? finalQualifiers : null,
    subpath: safeSubpath,
  });
}

/**
 * The version and purl of a row from an OS package table: `deb_packages`,
 * `rpm_packages`, `pacman_packages`, `homebrew_packages`, `macports_packages`,
 * `snap_packages`, `flatpak_packages` or the rows of the apk database.
 *
 * Such a row is named the way the package manager's own scan names it: deb,
 * rpm and apk with the vendor and the `arch`, `distro`, `distro_name` and
 * `epoch` qualifiers of the container scan, an rpm version joined to its
 * release, a MacPorts version joined to its revision, a flatpak by its
 * application ID with the `arch` and `branch` of its ref. A row's `path`,
 * `admindir` or source file is not a path inside the package, so none of them
 * becomes a subpath.
 *
 * @param {string} purlType One of OS_PACKAGE_PURL_TYPES
 * @param {Object} res osquery row
 * @param {string} name Component name derived from the row
 * @param {Object} [distro] What getDistroInfo() reports; the host's by default
 * @returns {{version: string, purl: string|null}} The component version and the purl, which is null when the row cannot be expressed as one
 */
export function createOsQueryPackageIdentity(purlType, res, name, distro) {
  const pkg = {
    type: purlType,
    name,
    version: res.version,
    arch: res.arch,
  };
  if (purlType === "rpm") {
    pkg.release = res.release;
    pkg.epoch = res.epoch;
  } else if (purlType === "macports") {
    pkg.revision = res.revision;
  } else if (purlType === "flatpak") {
    pkg.branch = res.branch;
  }
  return {
    version: osPackageVersion(pkg),
    purl: buildOsPackagePurl(pkg, distro),
  };
}

// Columns of an OS package table that are named or dropped on their way to a
// property. A bare `source` is the source package of a deb, the source rpm file
// of an rpm and the pkgbase of a pacman package, and `type` says whether a
// Homebrew entry is a formula or a cask, a snap an app or a base, a flatpak an
// app or a runtime, so each takes the name that says which. The dpkg
// administrative directory and the pacman database path are the same for every
// package and say nothing about one.
const OS_PACKAGE_PROPERTY_NAMES = {
  deb: { source: "cdx:deb:source", admindir: undefined },
  rpm: { source: "cdx:rpm:sourceRpm" },
  apk: { origin: "cdx:apk:origin" },
  alpm: { source: "cdx:alpm:pkgbase", dbpath: undefined },
  brew: { type: "cdx:homebrew:type" },
  macports: {
    variants: "cdx:macports:variants",
    requested: "cdx:macports:requested",
  },
  snap: {
    type: "cdx:snap:type",
    revision: "cdx:snap:revision",
    channel: "cdx:snap:channel",
    confinement: "cdx:snap:confinement",
  },
  flatpak: {
    display_name: "cdx:flatpak:displayName",
    commit_hash: "cdx:flatpak:commit",
    origin: "cdx:flatpak:origin",
    installation: "cdx:flatpak:installation",
    type: "cdx:flatpak:type",
    runtime: "cdx:flatpak:runtime",
  },
};

/**
 * The columns of an OS package row that give its licence and its home page.
 * They become the component's `licenses` and a `website` reference rather than
 * properties. `separator` splits a licence column that lists several: pacman
 * keeps one licence per entry, which osquery joins with commas.
 */
export const OS_PACKAGE_LICENSE_COLUMNS = {
  alpm: { license: "licenses", separator: ",", website: "url" },
  snap: { license: "license" },
  flatpak: { license: "license", website: "homepage" },
};

/**
 * The property name an OS package table column is emitted under.
 *
 * @param {string|undefined} purlType Purl type of the table
 * @param {string} column Column name
 * @returns {string|undefined} The property name, or undefined when the column is not emitted
 */
export function osPackagePropertyName(purlType, column) {
  const fields = OS_PACKAGE_LICENSE_COLUMNS[purlType];
  if (fields && (column === fields.license || column === fields.website)) {
    return undefined;
  }
  const names = OS_PACKAGE_PROPERTY_NAMES[purlType];
  if (names && Object.hasOwn(names, column)) {
    return names[column];
  }
  return column;
}

function _deriveCertificateFormat(certificateFileExtension) {
  switch ((certificateFileExtension || "").toLowerCase()) {
    case "pem":
      return "PEM";
    case "der":
      return "DER";
    case "cer":
    case "crt":
      return "X.509";
    default:
      return undefined;
  }
}

function _normalizeCertificateDate(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const stringValue = `${value}`.trim();
  if (!stringValue) {
    return undefined;
  }
  const numericValue = Number(stringValue);
  if (Number.isFinite(numericValue)) {
    const millis = stringValue.length > 10 ? numericValue : numericValue * 1000;
    const parsedDate = new Date(millis);
    return Number.isNaN(parsedDate.getTime())
      ? undefined
      : parsedDate.toISOString();
  }
  const parsedDate = new Date(stringValue);
  return Number.isNaN(parsedDate.getTime())
    ? undefined
    : parsedDate.toISOString();
}
