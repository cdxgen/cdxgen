import { basename } from "node:path";

const PYLOCK_FILE_REGEX = /^pylock(\.[^.]+)?\.toml$/;
const DEFAULT_PYPI_REGISTRIES = new Set(["https://pypi.org/simple"]);

const PYLOCK_TOP_LEVEL_KEYS = [
  "lock-version",
  "environments",
  "requires-python",
  "extras",
  "dependency-groups",
  "default-groups",
  "created-by",
  "tool",
];

const PYLOCK_PACKAGE_CUSTOM_KEYS = [
  "marker",
  "index",
  "dependencies",
  "extras",
  "dependency-groups",
  "attestation-identities",
  "tool",
  "vcs",
  "directory",
  "archive",
  "sdist",
  "wheels",
];

/**
 * Check whether a file name conforms to pylock naming.
 *
 * @param {string} lockFilePath lock file path
 * @returns {boolean} true if this is a pylock file
 */
export function isPyLockFile(lockFilePath) {
  if (!lockFilePath) {
    return false;
  }
  return PYLOCK_FILE_REGEX.test(basename(lockFilePath));
}

/**
 * Check whether a parsed toml object follows pylock format.
 *
 * @param {object} lockTomlObj parsed toml object
 * @returns {boolean} true if object appears to be pylock data
 */
export function isPyLockObject(lockTomlObj) {
  return !!(
    lockTomlObj?.["lock-version"] && Array.isArray(lockTomlObj.packages)
  );
}

/**
 * Get package entries from py lock data in a format-agnostic way.
 *
 * @param {object} lockTomlObj parsed toml object
 * @returns {Array<object>} package entries
 */
export function getPyLockPackages(lockTomlObj) {
  if (Array.isArray(lockTomlObj?.package)) {
    return lockTomlObj.package;
  }
  if (Array.isArray(lockTomlObj?.packages)) {
    return lockTomlObj.packages;
  }
  return [];
}

/**
 * Convert top-level pylock keys to custom cdx properties.
 *
 * @param {object} lockTomlObj parsed toml object
 * @returns {Array<object>} custom properties
 */
export function collectPyLockTopLevelProperties(lockTomlObj) {
  const properties = [];
  for (const akey of PYLOCK_TOP_LEVEL_KEYS) {
    if (lockTomlObj?.[akey] !== undefined) {
      properties.push({
        name: `cdx:pylock:${akey.replaceAll("-", "_")}`,
        value: toPropertyValue(lockTomlObj[akey]),
      });
    }
  }
  return properties.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Convert package-level pylock keys to custom cdx properties.
 *
 * @param {object} pkg pylock package entry
 * @returns {Array<object>} custom properties
 */
export function collectPyLockPackageProperties(pkg) {
  const properties = [];
  for (const akey of PYLOCK_PACKAGE_CUSTOM_KEYS) {
    if (pkg?.[akey] !== undefined) {
      properties.push({
        name: `cdx:pylock:${akey.replaceAll("-", "_")}`,
        value: toPropertyValue(pkg[akey]),
      });
    }
  }
  return properties.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Build file components from pylock source entries.
 *
 * @param {object} pkg pylock package entry
 * @param {string} lockFile lock file path
 * @returns {Array<object>} file components
 */
export function collectPyLockFileComponents(pkg, lockFile) {
  const fileComponents = [];
  if (pkg?.archive) {
    const archiveComp = createArtifactComponent(
      pkg.archive,
      "archive",
      lockFile,
      pkg.name,
    );
    if (archiveComp) {
      fileComponents.push(archiveComp);
    }
  }
  if (pkg?.sdist) {
    const sdistComp = createArtifactComponent(
      pkg.sdist,
      "sdist",
      lockFile,
      pkg.name,
    );
    if (sdistComp) {
      fileComponents.push(sdistComp);
    }
  }
  if (Array.isArray(pkg?.wheels)) {
    for (const awheel of pkg.wheels) {
      const wheelComp = createArtifactComponent(
        awheel,
        "wheel",
        lockFile,
        pkg.name,
      );
      if (wheelComp) {
        fileComponents.push(wheelComp);
      }
    }
  }
  return fileComponents;
}

/**
 * Check whether index points to the default pypi registry.
 *
 * @param {string} indexUrl index URL from pylock
 * @returns {boolean} true for default pypi
 */
export function isDefaultPypiRegistry(indexUrl) {
  if (!indexUrl) {
    return false;
  }
  return DEFAULT_PYPI_REGISTRIES.has(normalizePyLockRegistry(indexUrl));
}

/**
 * Normalize a pylock package index URL for comparison and reporting.
 *
 * @param {string} indexUrl package index URL
 * @returns {string|undefined} normalized registry URL
 */
export function normalizePyLockRegistry(indexUrl) {
  if (!indexUrl) {
    return undefined;
  }
  try {
    const parsed = new URL(indexUrl);
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString().replace(/\/$/u, "");
  } catch {
    return String(indexUrl).trim().replace(/\/$/u, "");
  }
}

/**
 * Collect dependency names and scopes from a pylock package entry.
 *
 * @param {object} pkg pylock package entry
 * @returns {{ name: string, scope: string }[]} dependency relationships
 */
export function collectPyLockDependencyRelationships(pkg) {
  const relationships = [];
  for (const dependencyName of normalizeDependencyEntries(pkg?.dependencies)) {
    relationships.push({ name: dependencyName, scope: "required" });
  }
  for (const dependencyName of normalizeDependencyEntries(pkg?.extras)) {
    relationships.push({ name: dependencyName, scope: "optional-extra" });
  }
  for (const dependencyName of normalizeDependencyEntries(
    pkg?.["dependency-groups"],
  )) {
    relationships.push({ name: dependencyName, scope: "dependency-group" });
  }
  return dedupeRelationships(relationships);
}

function createArtifactComponent(artifact, sourceType, lockFile, packageName) {
  if (!artifact) {
    return null;
  }
  const properties = [{ name: "SrcFile", value: lockFile }];
  properties.push({
    name: "cdx:pylock:file:source_type",
    value: sourceType,
  });
  if (artifact.url) {
    properties.push({
      name: "cdx:pylock:file:url",
      value: normalizePyLockRegistry(artifact.url),
    });
  }
  if (artifact.path) {
    properties.push({
      name: "cdx:pylock:file:path",
      value: artifact.path,
    });
  }
  if (artifact.size !== undefined) {
    properties.push({
      name: "cdx:pylock:file:size",
      value: `${artifact.size}`,
    });
  }
  if (artifact["upload-time"]) {
    properties.push({
      name: "cdx:pylock:file:upload_time",
      value: toPropertyValue(artifact["upload-time"]),
    });
  }
  if (artifact.subdirectory) {
    properties.push({
      name: "cdx:pylock:file:subdirectory",
      value: artifact.subdirectory,
    });
  }
  if (artifact.index && !isDefaultPypiRegistry(artifact.index)) {
    properties.push({
      name: "cdx:pylock:file:registry",
      value: normalizePyLockRegistry(artifact.index),
    });
  }
  const name = resolveArtifactName(artifact, packageName, sourceType);
  return {
    "bom-ref": `urn:file:pylock:${String(packageName || "package").replaceAll(/[^a-zA-Z0-9._:-]+/gu, "-")}:${sourceType}:${name.replaceAll(/[^a-zA-Z0-9._:-]+/gu, "-")}`,
    type: "file",
    name,
    externalReferences: artifact.url
      ? [
          {
            type: "distribution",
            url: normalizePyLockRegistry(artifact.url),
          },
        ]
      : undefined,
    evidence: {
      identity: {
        field: "name",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: lockFile,
          },
        ],
      },
    },
    hashes: toHashes(artifact.hashes),
    properties,
  };
}

function toHashes(hashesObj) {
  if (!hashesObj || typeof hashesObj !== "object") {
    return undefined;
  }
  const hashes = [];
  for (const [alg, content] of Object.entries(hashesObj)) {
    if (!content) {
      continue;
    }
    const normalizedAlg = normalizeHashAlgorithm(alg);
    hashes.push({ alg: normalizedAlg, content: `${content}` });
  }
  return hashes.length
    ? hashes
        .sort((left, right) => left.alg.localeCompare(right.alg))
        .filter(
          (entry, index, list) =>
            index === 0 ||
            entry.alg !== list[index - 1].alg ||
            entry.content !== list[index - 1].content,
        )
    : undefined;
}

function resolveArtifactName(artifact, packageName, sourceType) {
  if (artifact.name) {
    return artifact.name;
  }
  if (artifact.path) {
    return basename(artifact.path);
  }
  if (artifact.url) {
    try {
      return basename(new URL(artifact.url).pathname);
    } catch (_err) {
      return `${packageName || "package"}-${sourceType}-invalid-url`;
    }
  }
  return `${packageName || "package"}-${sourceType}`;
}

function normalizeHashAlgorithm(algorithm) {
  const normalized = `${algorithm}`.toLowerCase();
  const blake2Match = normalized.match(/^blake2([bs])[-_]?(\d+)?$/u);
  if (blake2Match) {
    return `BLAKE2${blake2Match[1].toUpperCase()}${blake2Match[2] ? `-${blake2Match[2]}` : ""}`;
  }
  if (normalized.startsWith("sha3")) {
    return `SHA3-${normalized.slice(4).replace(/^[-_]/, "")}`;
  }
  if (normalized.startsWith("sha")) {
    return `SHA-${normalized.slice(3).replace(/^[-_]/, "").toUpperCase()}`;
  }
  return normalized.toUpperCase();
}

function normalizeDependencyEntries(entries) {
  if (!entries) {
    return [];
  }
  if (Array.isArray(entries)) {
    return entries
      .map((entry) => normalizeDependencyName(entry?.name || entry))
      .filter(Boolean);
  }
  if (typeof entries === "object") {
    return Object.entries(entries)
      .flatMap(([key, value]) => {
        if (Array.isArray(value)) {
          return value.map((entry) =>
            normalizeDependencyName(entry?.name || entry),
          );
        }
        if (value && typeof value === "object" && value.name) {
          return [normalizeDependencyName(value.name)];
        }
        return [normalizeDependencyName(key)];
      })
      .filter(Boolean);
  }
  return [normalizeDependencyName(entries)].filter(Boolean);
}

function normalizeDependencyName(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/\[.*\]/u, "")
    .split(/(==|<=|~=|>=|!=|<|>)/u)[0]
    .trim();
  return normalized || undefined;
}

function dedupeRelationships(relationships) {
  return Array.from(
    new Map(
      relationships.map((relationship) => [
        `${relationship.scope}:${relationship.name.toLowerCase()}`,
        relationship,
      ]),
    ).values(),
  ).sort(
    (left, right) =>
      left.scope.localeCompare(right.scope) ||
      left.name.localeCompare(right.name),
  );
}

function toPropertyValue(value) {
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return `${value}`;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => sortValue(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, sortValue(entryValue)]),
    );
  }
  return value;
}
