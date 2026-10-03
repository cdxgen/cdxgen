import { readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";

import { Purl } from "@cdxgen/cdx-purl";

import { safeExistsSync } from "../core/fs.js";

/**
 * Build a lowercase type/namespace/name lookup key for a purl.
 *
 * Falls back to a stripped, lowercased form of the raw string when the purl
 * cannot be parsed.
 *
 * @param {string} purl Package URL string
 * @returns {string|undefined} Normalized key, or undefined when the input is empty or not a string
 */
export function normalizeDosaiPurlKey(purl) {
  if (!purl || typeof purl !== "string") {
    return undefined;
  }
  try {
    const purlObj = Purl.parse(purl);
    return [
      purlObj.type?.toLowerCase(),
      purlObj.namespace?.toLowerCase() || "",
      purlObj.name?.toLowerCase(),
    ].join("/");
  } catch (_err) {
    return purl.split("?")[0].split("#")[0].split("@")[0].toLowerCase();
  }
}

/**
 * Append a value to the Set stored under a key in a map, creating the Set when absent.
 *
 * @param {Object} map Map of key to Set of values, mutated in place
 * @param {string} key Map key (usually a purl)
 * @param {string} value Value to add; no-op when key or value is falsy
 * @returns {void}
 */
export function addDosaiSetValue(map, key, value) {
  if (!key || !value) {
    return;
  }
  map[key] ??= new Set();
  map[key].add(value);
}

/**
 * Format a `file#line` location string from a dosai node or location item.
 *
 * @param {Object} item Dosai node, edge, or location object carrying Path/FileName and LineNumber fields
 * @returns {string|undefined} Location string with a `#line` suffix when available, or undefined when no file is known
 */
export function dosaiLocation(item) {
  const location = item?.Location || item?.CallLocation || item;
  const fileName =
    location?.Path || location?.FileName || item?.Path || item?.FileName;
  if (!fileName || fileName === "<unknown>") {
    return undefined;
  }
  const lineNumber = location?.LineNumber || item?.LineNumber;
  if (lineNumber && lineNumber > 0) {
    return `${fileName}#${lineNumber}`;
  }
  return fileName;
}

function dosaiSourceFileName(item) {
  const location = item?.Location || item?.CallLocation || item;
  return String(
    location?.Path || location?.FileName || item?.Path || item?.FileName || "",
  );
}

function dosaiSourceLineNumber(item) {
  const location = item?.Location || item?.CallLocation || item;
  return location?.LineNumber || item?.LineNumber;
}

/**
 * Return a validated source location for .NET source extensions, from a call graph node.
 *
 * @param {Object} node Dosai call graph node object
 * @returns {string|undefined} Location string, or undefined unless the file is .cs/.vb/.fs/.fsx/.r with a positive line number
 */
export function dosaiSourceLocationFromNode(node) {
  const location = dosaiLocation(node);
  const fileName = dosaiSourceFileName(node).toLowerCase();
  const lineNumber = dosaiSourceLineNumber(node);
  if (!location || !/\.(cs|vb|fs|fsx|r)$/i.test(fileName)) {
    return undefined;
  }
  if (!lineNumber || lineNumber <= 0) {
    return undefined;
  }
  return location;
}

/**
 * Return a validated source location for .NET source extensions, from a location object.
 *
 * @param {Object} location Dosai location object carrying Path/FileName and LineNumber fields
 * @returns {string|undefined} Location string, or undefined unless the file is .cs/.vb/.fs/.fsx/.r with a positive line number
 */
export function dosaiSourceLocation(location) {
  const sourceLocation = dosaiLocation(location);
  const fileName = dosaiSourceFileName(location);
  const lineNumber = dosaiSourceLineNumber(location);
  if (!sourceLocation || !/\.(cs|vb|fs|fsx|r)$/i.test(fileName)) {
    return undefined;
  }
  if (!lineNumber || lineNumber <= 0) {
    return undefined;
  }
  return sourceLocation;
}

/**
 * Split a purl into its version-free identity key and its version.
 *
 * @param {string} purl Package URL string
 * @returns {{key: string, version: (string|undefined)}|undefined} Parts, or undefined for an empty input
 */
function dosaiPurlParts(purl) {
  const key = normalizeDosaiPurlKey(purl);
  if (!key) {
    return undefined;
  }
  let version;
  try {
    version = Purl.parse(purl).version || undefined;
  } catch (_err) {
    const at = purl.split("?")[0].split("#")[0].lastIndexOf("@");
    version = at > 0 ? purl.slice(at + 1).split("?")[0] : undefined;
  }
  return { key, version };
}

/**
 * The manifests a component was identified from, as recorded in its
 * `internal:SrcFile` values.
 *
 * @param {Object} component BOM component
 * @returns {string[]} Manifest paths as recorded
 */
function componentSrcFiles(component) {
  const files = new Set();
  for (const property of component?.properties || []) {
    if (property?.name === "internal:SrcFile" && property.value) {
      files.add(`${property.value}`);
    }
  }
  return [...files];
}

/**
 * Resolve a recorded manifest path. A BOM records it relative to the scanned
 * directory, a scan in progress as found; a relative path that does not exist
 * under the scanned directory is tried against the working directory.
 *
 * @param {string} file Manifest path as recorded
 * @param {string} [srcPath] Scanned directory
 * @returns {string} Absolute manifest path
 */
function resolveManifestPath(file, srcPath) {
  if (isAbsolute(file)) {
    return file;
  }
  const fromSrcPath = resolve(srcPath || ".", file);
  if (!srcPath || safeExistsSync(fromSrcPath)) {
    return fromSrcPath;
  }
  const fromCwd = resolve(file);
  return safeExistsSync(fromCwd) ? fromCwd : fromSrcPath;
}

/**
 * The project directory a .NET manifest belongs to. A project.assets.json
 * names its project, which an artifacts layout keeps outside the `obj/`
 * holding the file; otherwise it sits in the project's `obj/`, and the other
 * manifests in the project directory.
 *
 * @param {string} file Absolute manifest path
 * @returns {string} Absolute project directory
 */
function manifestProjectDir(file) {
  const dir = dirname(file);
  if (basename(file).toLowerCase() === "project.assets.json") {
    try {
      const projectPath = JSON.parse(readFileSync(file, "utf-8"))?.project
        ?.restore?.projectPath;
      const projectDir = projectPath && dirname(resolve(projectPath));
      if (projectDir && safeExistsSync(projectDir)) {
        return projectDir;
      }
    } catch (_err) {
      // An unreadable file falls back to its location
    }
  }
  return basename(dir) === "obj" ? dirname(dir) : dir;
}

/**
 * The project directories a candidate's manifests belong to, worked out on
 * first use: only a record that names a version the BOM lacks, of a package
 * the BOM holds in several versions, needs them.
 *
 * @param {Object} candidate Candidate built by buildDosaiPurlAliasMap
 * @param {Map<string, string>} purlAliasMap Alias map carrying srcPath and the directory cache
 * @returns {string[]} Absolute project directories
 */
function candidateProjectDirs(candidate, purlAliasMap) {
  if (!candidate.projectDirs) {
    const dirs = new Set();
    for (const file of candidate.srcFiles) {
      const path = resolveManifestPath(file, purlAliasMap?.srcPath);
      let dir = purlAliasMap?.projectDirCache?.get(path);
      if (!dir) {
        dir = manifestProjectDir(path);
        purlAliasMap?.projectDirCache?.set(path, dir);
      }
      dirs.add(dir);
    }
    candidate.projectDirs = [...dirs];
  }
  return candidate.projectDirs;
}

/**
 * Build a purl alias map from BOM components.
 *
 * Maps each component purl to itself, and indexes the components by their
 * version-free identity, so a dosai-reported purl can be reconciled by version
 * (see {@link resolveDosaiComponentPurl}). Two versions of one package are two
 * components, and nothing here picks one of them on a name alone.
 *
 * @param {Object[]} [components] Component objects with purl fields
 * @param {Object} [options] Options
 * @param {string} [options.srcPath] Directory dosai analyzed, which its relative locations
 *        and the BOM's relative manifest paths are relative to
 * @returns {Map<string, string>} Map of purl to canonical component purl, carrying the identity index
 */
export function buildDosaiPurlAliasMap(components = [], options = {}) {
  const purlAliasMap = new Map();
  const candidatesByKey = new Map();
  for (const component of components) {
    if (!component?.purl) {
      continue;
    }
    purlAliasMap.set(component.purl, component.purl);
    const parts = dosaiPurlParts(component.purl);
    if (!parts) {
      continue;
    }
    const candidates = candidatesByKey.get(parts.key) || [];
    const existing = candidates.find(
      (candidate) => candidate.purl === component.purl,
    );
    if (existing) {
      for (const file of componentSrcFiles(component)) {
        if (!existing.srcFiles.includes(file)) {
          existing.srcFiles.push(file);
        }
      }
    } else {
      candidates.push({
        purl: component.purl,
        version: parts.version,
        srcFiles: componentSrcFiles(component),
      });
    }
    candidatesByKey.set(parts.key, candidates);
  }
  purlAliasMap.candidatesByKey = candidatesByKey;
  purlAliasMap.srcPath = options.srcPath;
  purlAliasMap.projectDirCache = new Map();
  return purlAliasMap;
}

/**
 * The candidate whose project directory is the nearest one holding a file.
 *
 * @param {Object[]} candidates Candidates of one package identity
 * @param {string} location Location string (`path` or `path#line`), relative to srcPath or absolute
 * @param {Map<string, string>} purlAliasMap Alias map built by buildDosaiPurlAliasMap
 * @returns {string|undefined} Candidate purl, or undefined when no single candidate is nearest
 */
function candidateForLocation(candidates, location, purlAliasMap) {
  if (!location) {
    return undefined;
  }
  const file = resolve(
    purlAliasMap?.srcPath || ".",
    `${location}`.split("#")[0],
  );
  let best;
  let bestLength = -1;
  let tied = false;
  for (const candidate of candidates) {
    for (const dir of candidateProjectDirs(candidate, purlAliasMap)) {
      if (file !== dir && !file.startsWith(`${dir}${sep}`)) {
        continue;
      }
      if (dir.length > bestLength) {
        best = candidate.purl;
        bestLength = dir.length;
        tied = false;
      } else if (dir.length === bestLength && best !== candidate.purl) {
        tied = true;
      }
    }
  }
  return tied ? undefined : best;
}

/**
 * Choose among the components that share a file name (two versions of a
 * package ship the same DLLs): the only one, else the one whose project
 * directory is nearest the record's location.
 *
 * @param {Iterable<string>} purls Candidate component purls
 * @param {Map<string, string>} purlAliasMap Alias map built by buildDosaiPurlAliasMap
 * @param {string} [location] Source location of the dosai record (`path` or `path#line`)
 * @returns {string|undefined} The component purl, or undefined when it cannot be told
 */
export function pickDosaiComponentByLocation(purls, purlAliasMap, location) {
  const wanted = new Set(purls);
  if (wanted.size <= 1) {
    return [...wanted][0];
  }
  const candidates = [];
  for (const list of purlAliasMap?.candidatesByKey?.values() || []) {
    for (const candidate of list) {
      if (wanted.has(candidate.purl)) {
        candidates.push(candidate);
      }
    }
  }
  return candidateForLocation(candidates, location, purlAliasMap);
}

/**
 * Resolve a dosai-reported purl to a BOM component purl.
 *
 * The exact purl wins, then the same package at the same version (ids compare
 * case-insensitively). A versionless purl, or a version the BOM does not hold,
 * maps to the package's only component when it has one. When the BOM holds
 * several versions, the record's location picks the version of the project
 * that file belongs to; without a location that settles it the purl maps to
 * nothing rather than to an arbitrary version (issue dosai#72).
 *
 * @param {string} purl Purl reported by dosai
 * @param {Map<string, string>} purlAliasMap Alias map built by buildDosaiPurlAliasMap
 * @param {string} [location] Source location of the dosai record (`path` or `path#line`)
 * @returns {string|undefined} Canonical component purl, the input purl when the BOM has no
 *          component of that package, or undefined when empty or ambiguous
 */
export function resolveDosaiComponentPurl(purl, purlAliasMap, location) {
  if (!purl) {
    return undefined;
  }
  const exact = purlAliasMap?.get(purl);
  if (exact) {
    return exact;
  }
  const parts = dosaiPurlParts(purl);
  const candidates = parts && purlAliasMap?.candidatesByKey?.get(parts.key);
  if (!candidates?.length) {
    return purl;
  }
  if (parts.version) {
    const sameVersion = candidates.filter(
      (candidate) =>
        candidate.version?.toLowerCase() === parts.version.toLowerCase(),
    );
    if (sameVersion.length === 1) {
      return sameVersion[0].purl;
    }
  }
  if (candidates.length === 1) {
    return candidates[0].purl;
  }
  return candidateForLocation(candidates, location, purlAliasMap);
}
