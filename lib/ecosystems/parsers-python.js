import { readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import process from "node:process";
import { URL } from "node:url";

import { build } from "@cdxgen/cdx-purl";
import { parse as _load } from "yaml";

import { DEBUG_MODE } from "../core/activity.js";
import { recordDegradation } from "../core/buildLedger.js";
import { getAllFiles, safeExistsSync, safeSpawnSync } from "../core/fs.js";
import { PYTHON_STD_MODULES } from "../core/state.js";
import { parseToml } from "../core/toml.js";
import { tryBuildPurl } from "../inventory/purl.js";
import {
  createExternalReferenceKey,
  getPyMetadata,
  mergeExternalReferences,
} from "./ecosystems.js";
import {
  collectPyLockDependencyRelationships,
  collectPyLockFileComponents,
  collectPyLockPackageProperties,
  collectPyLockTopLevelProperties,
  getPyLockPackages,
  isDefaultPypiRegistry,
  isPyLockObject,
  normalizePyLockRegistry,
} from "./pylockutils.js";

/**
 * TOML lock files a specific Python manager owns, mapped to the manager and
 * the remediation id that ranks its repair. The failing file itself is the
 * detection: the lock command that regenerates it belongs to the manager
 * that wrote it.
 *
 * @type {Record<string, {manager: string, remediationId: string}>}
 */
const PY_LOCKFILE_DEGRADATIONS = {
  "uv.lock": {
    manager: "uv",
    remediationId: "python.lockfile-unparseable.uv",
  },
  "poetry.lock": {
    manager: "poetry",
    remediationId: "python.lockfile-unparseable.poetry",
  },
  "pdm.lock": {
    manager: "pdm",
    remediationId: "python.lockfile-unparseable.pdm",
  },
};

/**
 * The repair for a TOML lock file that names no single manager, such as
 * PEP 751's `pylock.toml`. Its lock command carries the manager variable, so
 * the shaping fills in whichever manager the project turns out to use.
 *
 * @type {{manager: string, remediationId: string}}
 */
const GENERIC_PY_LOCKFILE_DEGRADATION = {
  manager: "python",
  remediationId: "python.lockfile-unparseable",
};

/**
 * Method to parse python requires_dist attribute found in pypi setup.py
 *
 * @param {String} dist_string string
 */
export function parsePyRequiresDist(dist_string) {
  if (!dist_string) {
    return undefined;
  }
  const tmpA = dist_string.split(" ");
  let name = "";
  let version = "";
  if (!tmpA) {
    return undefined;
  }
  if (tmpA.length === 1) {
    name = tmpA[0];
  } else if (tmpA.length > 1) {
    name = tmpA[0];
    const tmpVersion = tmpA[1];
    version = tmpVersion.split(",")[0].replace(/[();=&glt><]/g, "");
  }
  return {
    name,
    version,
  };
}

/**
 * Method to parse pipfile.lock data
 *
 * @param {Object} lockData JSON data from Pipfile.lock
 */
export async function parsePiplockData(lockData) {
  const pkgList = [];
  Object.keys(lockData)
    .filter((i) => i !== "_meta")
    .forEach((k) => {
      const depBlock = lockData[k];
      Object.keys(depBlock).forEach((p) => {
        const pkg = depBlock[p];
        if (Object.hasOwn(pkg, "version")) {
          // `===` (arbitrary equality) pins as tightly as `==`, so both are
          // stripped whole rather than leaving a stray `=` behind.
          const versionStr = pkg.version.replace(/^\s*={2,3}\s*/, "");
          pkgList.push({ name: p, version: versionStr });
        }
      });
    });
  return await getPyMetadata(pkgList, false);
}

/**
 * Append a deduplicated name/value property to a component's properties array.
 *
 * @param {object} component Component to mutate.
 * @param {string} name Property name.
 * @param {string} value Property value.
 * @returns {void}
 */
export function addComponentProperty(component, name, value) {
  if (value === undefined || value === null || value === "" || !component) {
    return;
  }
  component.properties = component.properties || [];
  if (
    component.properties.some(
      (property) => property.name === name && property.value === value,
    )
  ) {
    return;
  }
  component.properties.push({
    name,
    value,
  });
}

const PYTHON_DIRECT_REFERENCE_PATTERN =
  /^([A-Za-z0-9_.-]+)(?:\[[^\]]+])?\s*@\s*(\S+)$/;

function isWindowsAbsolutePath(value) {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function normalizePythonDependencyKey(value) {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  return value.trim().toLowerCase().replaceAll("_", "-");
}

function extractPythonDependencyKey(value) {
  const manifestSource = parsePyProjectDependencySourceString(value);
  if (manifestSource?.name) {
    return normalizePythonDependencyKey(manifestSource.name);
  }
  const packageMatch =
    typeof value === "string"
      ? value.trim().match(/^([A-Za-z0-9_.-]+)(?:\[[^\]]+])?/)
      : undefined;
  return normalizePythonDependencyKey(packageMatch?.[1]);
}

function classifyPythonManifestSourceValue(value) {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const normalizedValue = value.trim();
  const lowerValue = normalizedValue.toLowerCase();
  if (
    lowerValue.startsWith("git+") ||
    lowerValue.startsWith("git://") ||
    lowerValue.startsWith("git@") ||
    lowerValue.startsWith("ssh://git@")
  ) {
    return {
      type: "git",
      value: normalizedValue,
    };
  }
  if (
    lowerValue.startsWith("http://") ||
    lowerValue.startsWith("https://") ||
    lowerValue.startsWith("ftp://")
  ) {
    return {
      type: "url",
      value: normalizedValue,
    };
  }
  if (
    lowerValue.startsWith("file:") ||
    normalizedValue.startsWith("./") ||
    normalizedValue.startsWith("../") ||
    normalizedValue.startsWith("/") ||
    isWindowsAbsolutePath(normalizedValue)
  ) {
    return {
      type: "path",
      value: normalizedValue,
    };
  }
  return undefined;
}

function applyManifestSourceProperties(
  component,
  propertyPrefix,
  manifestSource,
) {
  if (!manifestSource?.type || !manifestSource?.value) {
    return;
  }
  addComponentProperty(
    component,
    `${propertyPrefix}:manifestSourceType`,
    manifestSource.type,
  );
  addComponentProperty(
    component,
    `${propertyPrefix}:manifestSource`,
    manifestSource.value,
  );
}

function recordPythonDependencySource(
  dependencySourceMap,
  dependencyName,
  sourceType,
  sourceValue,
) {
  const normalizedKey = normalizePythonDependencyKey(dependencyName);
  if (!normalizedKey || !sourceType || !sourceValue) {
    return;
  }
  dependencySourceMap[normalizedKey] = {
    type: sourceType,
    value: sourceValue,
  };
}

function parsePyProjectDependencySourceString(value) {
  if (typeof value !== "string" || !value.includes("@")) {
    return undefined;
  }
  const directReferenceMatch = value
    .trim()
    .match(PYTHON_DIRECT_REFERENCE_PATTERN);
  if (!directReferenceMatch) {
    return undefined;
  }
  const manifestSource = classifyPythonManifestSourceValue(
    directReferenceMatch[2],
  );
  if (!manifestSource) {
    return undefined;
  }
  return {
    name: directReferenceMatch[1],
    ...manifestSource,
  };
}

function collectPythonManifestSource(pkg) {
  const sourceCandidates = [
    { kind: "git", value: pkg?.source?.git },
    { kind: "git", value: pkg?.vcs?.git },
    { kind: "url", value: pkg?.vcs?.url },
    { kind: "url", value: pkg?.source?.url },
    { kind: "path", value: pkg?.source?.path },
    { kind: "path", value: pkg?.source?.directory },
    { kind: "path", value: pkg?.source?.editable },
    { kind: "path", value: pkg?.source?.virtual },
    { kind: "path", value: pkg?.directory?.path },
    { kind: "url", value: pkg?.archive?.url },
    { kind: "path", value: pkg?.archive?.path },
  ];
  for (const candidate of sourceCandidates) {
    if (typeof candidate.value !== "string" || !candidate.value.trim()) {
      continue;
    }
    const normalizedValue = candidate.value.trim();
    if (candidate.kind === "git") {
      return {
        type: "git",
        value: normalizedValue.startsWith("git+")
          ? normalizedValue
          : `git+${normalizedValue}`,
      };
    }
    const manifestSource = classifyPythonManifestSourceValue(normalizedValue);
    if (manifestSource) {
      return manifestSource;
    }
    return {
      type: candidate.kind,
      value: normalizedValue,
    };
  }
  return undefined;
}

function parsePythonRequirementManifestSource(value) {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const normalizedValue = value.trim();
  const directReferenceMatch = normalizedValue.match(
    PYTHON_DIRECT_REFERENCE_PATTERN,
  );
  if (directReferenceMatch) {
    const manifestSource = classifyPythonManifestSourceValue(
      directReferenceMatch[2],
    );
    if (manifestSource) {
      return {
        name: directReferenceMatch[1],
        ...manifestSource,
      };
    }
  }
  const vcsRequirementMatch = normalizedValue.match(
    /^(git\+\S+?)(?:#.*egg=([A-Za-z0-9_.-]+))?$/,
  );
  if (vcsRequirementMatch?.[2]) {
    return {
      name: vcsRequirementMatch[2],
      type: "git",
      value: vcsRequirementMatch[1],
    };
  }
  return undefined;
}

/**
 * Method to parse python pyproject.toml file
 *
 * @param {string} tomlFile pyproject.toml file
 * @returns {Object} Object with parent component, root dependencies, and metadata.
 */
export function parsePyProjectTomlFile(tomlFile) {
  function handleBlock(pkg, atool) {
    for (const k of ["name", "version", "description", "license"]) {
      // We can copy string values as-is
      if (
        !pkg[k] &&
        atool[k] &&
        (typeof atool[k] === "string" || atool[k] instanceof String)
      ) {
        pkg[k] = atool[k];
      }
    }
    if (atool.authors) {
      if (Array.isArray(atool.authors) && atool.authors.length > 0) {
        // Multiple author objects
        if (
          Object.keys(atool.authors[0]).length &&
          (atool.authors[0]?.name || atool.authors[0]?.email)
        ) {
          pkg.authors = atool.authors;
        } else {
          pkg.author = atool.authors.join(", ");
        }
      } else if (
        typeof atool.authors === "string" ||
        atool.authors instanceof String
      ) {
        pkg.author = atool.authors.trim();
      }
    }
    if (atool.homepage) {
      pkg.homepage = { url: atool.homepage };
    }
    if (atool.repository) {
      pkg.repository = { url: atool.repository };
    }
    if (atool.keywords && Array.isArray(atool.keywords)) {
      pkg.tags = atool.keywords.sort();
    }
    if (atool["requires-python"]) {
      pkg.properties = [
        { name: "cdx:pypi:requiresPython", value: atool["requires-python"] },
      ];
    }
  }

  let poetryMode = false;
  let uvMode = false;
  let hatchMode = false;
  const workspacePaths = [];
  let tomlData;
  const directDepsKeys = {};
  const groupDepsKeys = {};
  const dependencySourceMap = {};
  try {
    tomlData = parseToml(readFileSync(tomlFile, { encoding: "utf-8" }));
  } catch (err) {
    console.log(`Error while parsing the pyproject file ${tomlFile}.`, err);
  }
  const pkg = {};
  if (!tomlData) {
    return {};
  }
  if (
    tomlData?.tool?.poetry ||
    tomlData?.["build-system"]?.["build-backend"]?.startsWith("poetry.core")
  ) {
    poetryMode = true;
  }
  if (tomlData?.tool?.uv) {
    uvMode = true;
  }
  if (tomlData?.["build-system"]?.["build-backend"]?.startsWith("hatchling.")) {
    hatchMode = true;
  }
  if (
    uvMode &&
    tomlData.tool.uv.workspace &&
    Array.isArray(tomlData.tool.uv.workspace?.members)
  ) {
    for (const amember of tomlData.tool.uv.workspace.members) {
      const memberPyProjPaths = amember.endsWith("/*")
        ? amember.replace(/\/\*$/, "/**/pyproject.toml")
        : `${amember}/**/pyproject.toml`;
      workspacePaths.push(memberPyProjPaths);
    }
  }
  // uv and others
  if (tomlData?.project && Object.keys(tomlData.project).length) {
    handleBlock(pkg, tomlData.project);
  }
  if (tomlData?.tool && Object.keys(tomlData.tool).length) {
    for (const atoolKey of Object.keys(tomlData.tool)) {
      const atool = tomlData.tool[atoolKey];
      handleBlock(pkg, atool);
    }
  }
  if (pkg.name) {
    pkg.type = "application";
    const ppurl = build({
      type: "pypi",
      namespace: pkg.group || "" || null,
      name: pkg.name,
      version: pkg.version || "latest" || null,
    });
    pkg["bom-ref"] = decodeURIComponent(ppurl);
    pkg["purl"] = ppurl;
    pkg.evidence = {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: tomlFile,
          },
        ],
      },
    };
  }
  if (tomlData?.project?.dependencies) {
    for (const adep of tomlData.project.dependencies) {
      const dependencyKey = extractPythonDependencyKey(adep);
      if (dependencyKey) {
        directDepsKeys[dependencyKey] = true;
      }
      const manifestSource = parsePyProjectDependencySourceString(adep);
      if (manifestSource) {
        recordPythonDependencySource(
          dependencySourceMap,
          manifestSource.name,
          manifestSource.type,
          manifestSource.value,
        );
      }
    }
  }
  if (tomlData["dependency-groups"]) {
    for (const agroup of Object.keys(tomlData["dependency-groups"])) {
      tomlData["dependency-groups"][agroup].forEach((p) => {
        if (typeof p === "string" || p instanceof String) {
          const pname = normalizePythonDependencyKey(
            p.split(/(==|<=|~=|>=)/)[0].split(" ")[0],
          );
          if (!pname) {
            return;
          }
          if (!groupDepsKeys[pname]) {
            groupDepsKeys[pname] = [];
          }
          groupDepsKeys[pname].push(agroup);
          const manifestSource = parsePyProjectDependencySourceString(p);
          if (manifestSource) {
            recordPythonDependencySource(
              dependencySourceMap,
              manifestSource.name,
              manifestSource.type,
              manifestSource.value,
            );
          }
        } else {
          return;
        }
      });
    }
  }
  if (tomlData?.tool?.poetry?.dependencies) {
    for (const adep of Object.keys(tomlData?.tool?.poetry?.dependencies)) {
      // poetry keys keep the author's casing (Click = "^8.1"), while every
      // consumer of directDepsKeys looks entries up with the normalised
      // (lowercase, hyphenated) package name, so normalise at the source.
      const poetryDepKey = normalizePythonDependencyKey(adep);
      if (
        !poetryDepKey ||
        [
          "python",
          "py",
          "pytest",
          "pylint",
          "ruff",
          "setuptools",
          "bandit",
        ].includes(poetryDepKey)
      ) {
        continue;
      }
      directDepsKeys[poetryDepKey] = true;
      const poetryDependency = tomlData.tool.poetry.dependencies[adep];
      if (poetryDependency?.git) {
        recordPythonDependencySource(
          dependencySourceMap,
          adep,
          "git",
          poetryDependency.git,
        );
      } else if (poetryDependency?.url) {
        recordPythonDependencySource(
          dependencySourceMap,
          adep,
          "url",
          poetryDependency.url,
        );
      } else if (poetryDependency?.path) {
        recordPythonDependencySource(
          dependencySourceMap,
          adep,
          "path",
          poetryDependency.path,
        );
      }
    } // for
    // Group keys are matched against the normalised package names from the
    // lock file, so they are normalised here too.
    if (tomlData?.tool?.poetry?.group) {
      for (const agroup of Object.keys(tomlData.tool.poetry.group)) {
        for (const adep of Object.keys(
          tomlData.tool.poetry.group[agroup]?.dependencies,
        )) {
          const poetryGroupDepKey = normalizePythonDependencyKey(adep);
          if (!poetryGroupDepKey) {
            continue;
          }
          if (!groupDepsKeys[poetryGroupDepKey]) {
            groupDepsKeys[poetryGroupDepKey] = [];
          }
          groupDepsKeys[poetryGroupDepKey].push(agroup);
          const poetryDependency =
            tomlData.tool.poetry.group[agroup]?.dependencies?.[adep];
          if (poetryDependency?.git) {
            recordPythonDependencySource(
              dependencySourceMap,
              adep,
              "git",
              poetryDependency.git,
            );
          } else if (poetryDependency?.url) {
            recordPythonDependencySource(
              dependencySourceMap,
              adep,
              "url",
              poetryDependency.url,
            );
          } else if (poetryDependency?.path) {
            recordPythonDependencySource(
              dependencySourceMap,
              adep,
              "path",
              poetryDependency.path,
            );
          }
        }
      } // for
    }
  }
  if (tomlData?.tool?.uv?.sources) {
    for (const adep of Object.keys(tomlData.tool.uv.sources)) {
      const uvSource = Array.isArray(tomlData.tool.uv.sources[adep])
        ? tomlData.tool.uv.sources[adep][0]
        : tomlData.tool.uv.sources[adep];
      if (uvSource?.git) {
        recordPythonDependencySource(
          dependencySourceMap,
          adep,
          "git",
          uvSource.git,
        );
      } else if (uvSource?.url) {
        recordPythonDependencySource(
          dependencySourceMap,
          adep,
          "url",
          uvSource.url,
        );
      } else if (uvSource?.path) {
        recordPythonDependencySource(
          dependencySourceMap,
          adep,
          "path",
          uvSource.path,
        );
      }
    }
  }
  return {
    parentComponent: pkg,
    poetryMode,
    uvMode,
    hatchMode,
    workspacePaths,
    directDepsKeys,
    groupDepsKeys,
    dependencySourceMap,
  };
}

function collectPythonLockDistributionReferences(pkg) {
  const externalReferences = [];
  const seen = new Set();

  function addExternalReference(type, url, comment) {
    if (typeof url !== "string" || !url.trim()) {
      return;
    }
    const normalizedUrl = url.trim();
    const reference = {
      type,
      url: normalizedUrl,
      comment,
    };
    const referenceKey = createExternalReferenceKey(reference);
    if (seen.has(referenceKey)) {
      return;
    }
    seen.add(referenceKey);
    externalReferences.push(reference);
  }

  addExternalReference("distribution", pkg?.archive?.url, "archive");
  addExternalReference("distribution", pkg?.sdist?.url, "sdist");
  if (Array.isArray(pkg?.wheels)) {
    for (const wheel of pkg.wheels) {
      addExternalReference(
        "distribution",
        wheel?.url,
        wheel?.file || wheel?.name || wheel?.filename || "wheel",
      );
    }
  }
  const vcsSource = [
    { kind: "url", value: pkg?.vcs?.url },
    { kind: "git", value: pkg?.vcs?.git },
    { kind: "git", value: pkg?.source?.git },
  ].find(
    (entry) => typeof entry.value === "string" && entry.value.trim().length > 0,
  );
  if (vcsSource) {
    const vcsUrl = vcsSource.value.trim();
    const normalizedVcsUrl =
      vcsSource.kind === "git" && !vcsUrl.startsWith("git+")
        ? `git+${vcsUrl}`
        : vcsUrl;
    addExternalReference("vcs", normalizedVcsUrl, "vcs");
  }
  if (pkg?.source?.url) {
    const manifestSource = classifyPythonManifestSourceValue(pkg.source.url);
    addExternalReference(
      manifestSource?.type === "git" ? "vcs" : "distribution",
      pkg.source.url,
      "source",
    );
  }
  return externalReferences;
}

function collectPythonLockMetadataFileEntries(lockTomlObj, pkg) {
  if (!lockTomlObj?.metadata?.files || !pkg?.name) {
    return [];
  }
  const expectedKeys = new Set([normalizePythonDependencyKey(pkg.name)]);
  if (pkg.version) {
    expectedKeys.add(
      `${normalizePythonDependencyKey(pkg.name)} ${`${pkg.version}`.trim().toLowerCase()}`,
    );
  }
  const matchingEntries = [];
  for (const [entryKey, entryValues] of Object.entries(
    lockTomlObj.metadata.files,
  )) {
    if (!Array.isArray(entryValues)) {
      continue;
    }
    if (expectedKeys.has(normalizePythonDependencyKey(entryKey))) {
      matchingEntries.push(...entryValues);
    }
  }
  return matchingEntries;
}

/**
 * Derive a file name for a file entry of a python lock file.
 *
 *  - poetry.lock `[metadata.files]` entries carry a `file` key.
 *  - pdm.lock `[metadata.files]` entries carry a `url` key (no `file`).
 *  - pylock.toml / uv.lock artifacts can carry an explicit `name`, a local
 *    `path`, and/or a `url`.
 *
 * @param {object} fileEntry A single lock-file file entry.
 * @returns {string | undefined} The derived file name, or undefined when none can be derived.
 */
export function derivePythonLockMetadataFileName(fileEntry) {
  if (!fileEntry || typeof fileEntry !== "object") {
    return undefined;
  }
  // Explicit filenames (pylock `name`, poetry `file`) win over derived ones.
  for (const key of ["file", "name"]) {
    const value = fileEntry[key];
    if (typeof value === "string" && value.trim()) {
      return basename(value.trim());
    }
  }
  // Local artifact paths (pylock `path`).
  if (typeof fileEntry.path === "string" && fileEntry.path.trim()) {
    const name = basename(fileEntry.path.trim());
    if (name) {
      return name;
    }
  }
  // Remote artifact URLs (pdm `url`, uv/pylock `url`). Strip the query string
  // and fragment by reading the pathname, and percent-decode the basename.
  if (typeof fileEntry.url === "string" && fileEntry.url.trim()) {
    const rawUrl = fileEntry.url.trim();
    let name;
    try {
      name = basename(new URL(rawUrl).pathname);
    } catch (_err) {
      // Not an absolute URL - treat it as a path-like string.
      name = basename(rawUrl);
    }
    if (name) {
      try {
        name = decodeURIComponent(name);
      } catch (_err) {
        // Ignore malformed URLs and fall through to undefined.
      }
      if (name) {
        return name;
      }
    }
  }
  return undefined;
}

function collectPythonLockMetadataDistributionReferences(fileEntries) {
  const distributionReferences = [];
  for (const fileEntry of fileEntries || []) {
    if (typeof fileEntry?.url !== "string" || !fileEntry.url.trim()) {
      continue;
    }
    distributionReferences.push({
      type: "distribution",
      url: fileEntry.url.trim(),
      comment: fileEntry.file,
    });
  }
  return distributionReferences;
}

/**
 * Normalise a Python distribution name the way PEP 503 does, so an installed
 * distribution and the lockfile entry it belongs to compare equal whatever
 * separator and case each of them used.
 *
 * @param {string} value Distribution name
 * @returns {string|undefined} The normalised name, or undefined for no name
 */
export function normalizePep503Name(value) {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  return value.trim().toLowerCase().replaceAll(/[-_.]+/g, "-");
}

/**
 * Enrich lockfile entries from the installed distributions on this machine,
 * before PyPI is asked.
 *
 * Each entry of `installedMetadata` is a component as
 * {@link parseBdistMetadata} builds it from an installed `*.dist-info/METADATA`
 * file. An entry is matched to the lockfile component with the same PEP 503
 * normalised name and fills the fields it lacks, so the registry is left only
 * what the installed distributions do not answer. The distributions enrich the
 * entries in place; no new components are created.
 *
 * @param {Object[]} pkgList Lockfile components, enriched in place
 * @param {Object[]} installedMetadata Components parsed from installed
 *   `*.dist-info/METADATA` files
 * @returns {Set<string>} The PEP 503 normalised names that were enriched, so a
 *   caller that also walks the METADATA files can skip those as components
 */
export function enrichFromInstalledMetadata(pkgList, installedMetadata) {
  const byName = new Map();
  for (const p of pkgList || []) {
    const key = normalizePep503Name(p.name);
    if (key && !byName.has(key)) {
      byName.set(key, p);
    }
  }
  const enriched = new Set();
  for (const md of installedMetadata || []) {
    const key = normalizePep503Name(md.name);
    const p = key ? byName.get(key) : undefined;
    if (!p) {
      continue;
    }
    enriched.add(key);
    if (!p.description?.trim() && md.description?.trim()) {
      p.description = md.description;
    }
    if (!p.license && md.licenses?.length) {
      // The licence field holds the names a lockfile consumer expects; the
      // CycloneDX licence objects travel in `licenses`.
      p.license = md.licenses
        .map((alicense) => alicense.expression || alicense.license?.name)
        .filter((aname) => aname?.length);
      p.licenses = md.licenses;
    }
    if (!p.homepage && md.homepage) {
      p.homepage = md.homepage;
    }
    if (!p.repository && md.repository) {
      p.repository = md.repository;
    }
    if (!p.author && md.author) {
      p.author = md.author;
    }
  }
  return enriched;
}

/**
 * Method to parse python lock files such as poetry.lock, pdm.lock, uv.lock, and pylock.toml.
 *
 * @param {string} lockData Raw TOML text from poetry.lock, pdm.lock, uv.lock, or pylock.toml
 * @param {string} lockFile Lock file name for evidence
 * @param {string} pyProjectFile pyproject.toml file
 * @param {Object} [options] Options
 * @param {Object[]} [options.installedMetadata] Components parsed from the
 *   installed `*.dist-info/METADATA` files of this machine, which answer
 *   before PyPI is asked
 */
export async function parsePyLockData(
  lockData,
  lockFile,
  pyProjectFile,
  options = {},
) {
  let pkgList = [];
  const rootList = [];
  const dependenciesList = [];
  const depsMap = {};
  const existingPkgMap = {};
  const pkgBomRefMap = {};
  let directDepsKeys = {};
  let groupDepsKeys = {};
  let dependencySourceMap = {};
  let parentComponent;
  let workspacePaths;
  let workspaceWarningShown = false;
  let hasWorkspaces = false;
  let pyLockProperties = [];
  // Keep track of any workspace components to be added to the parent component
  const workspaceComponentMap = {};
  const workspaceDependencySourceMap = {};
  const workspacePyProjMap = {};
  const workspaceRefPyProjMap = {};
  const pkgParentMap = {};
  if (!lockData) {
    return { pkgList, dependenciesList };
  }
  if (!pyProjectFile && lockFile) {
    // See if there is a pyproject.toml in the same directory
    pyProjectFile = join(dirname(lockFile), "pyproject.toml");
  }
  if (pyProjectFile && safeExistsSync(pyProjectFile)) {
    if (DEBUG_MODE) {
      console.log(
        `Parsing ${pyProjectFile} for dependencies and groups information.`,
      );
    }
    const pyProjMap = parsePyProjectTomlFile(pyProjectFile);
    directDepsKeys = pyProjMap.directDepsKeys || {};
    groupDepsKeys = pyProjMap.groupDepsKeys || {};
    dependencySourceMap = pyProjMap.dependencySourceMap || {};
    parentComponent = pyProjMap.parentComponent;
    workspacePaths = pyProjMap.workspacePaths;
    // `parsePyProjectTomlFile` reports a parse failure and returns an empty map, so a
    // pyproject.toml this parser cannot read leaves `parentComponent` undefined while
    // the lock file still declares workspaces. Building the workspace tree then throws
    // on the first dereference and takes the whole SBOM with it. Degrade to a flattened
    // tree instead - the caller supplies its own parent component, so the components
    // themselves are still reported.
    if (workspacePaths?.length && !parentComponent) {
      console.log(
        `Unable to read a parent component from ${pyProjectFile}, so the workspace structure declared in ${basename(lockFile)} cannot be reconstructed.`,
      );
      console.log(
        "The dependency tree in the generated SBOM will be flattened and therefore incorrect.",
      );
      recordDegradation("python.pyproject-unparseable", {
        ecosystem: "python",
        impact: "transitive-deps",
        path: pyProjectFile,
        detail: `${basename(pyProjectFile)} could not be parsed, so the workspace structure declared in ${basename(lockFile)} was not reconstructed.`,
      });
    }
    if (workspacePaths?.length && parentComponent) {
      if (!hasWorkspaces) {
        hasWorkspaces = true;
      }
      // Parent component is going to have children
      parentComponent.components = [];
      for (const awpath of workspacePaths) {
        const wpyprojfiles = getAllFiles(dirname(lockFile), awpath);
        if (!wpyprojfiles?.length) {
          if (!workspaceWarningShown) {
            console.log(
              `Unable to collect pyproject.toml files for the workspace pattern ${awpath}. Ensure cdxgen is run from the root directory containing the application source code.`,
            );
            console.log(
              "The dependency tree in the generated SBOM will be flattened and therefore incorrect.",
            );
            workspaceWarningShown = true;
          }
          continue;
        }
        for (const awpyproj of wpyprojfiles) {
          if (DEBUG_MODE) {
            console.log(
              `Parsing workspace ${awpyproj} to improve the dependency tree.`,
            );
          }
          // Nested workspace is not supported
          const wcompMap = parsePyProjectTomlFile(awpyproj);
          if (wcompMap?.parentComponent) {
            wcompMap.parentComponent.properties =
              wcompMap.parentComponent.properties || [];
            wcompMap.parentComponent.properties.push({
              name: "internal:is_workspace",
              value: "true",
            });
            wcompMap.parentComponent.properties.push({
              name: "internal:SrcFile",
              value: awpyproj,
            });
            wcompMap.parentComponent.properties.push({
              name: "internal:virtual_path",
              value: relative(dirname(lockFile), dirname(awpyproj)),
            });
            workspaceComponentMap[wcompMap.parentComponent.name] =
              wcompMap.parentComponent;
            workspacePyProjMap[wcompMap.parentComponent.name] = awpyproj;
            if (wcompMap.parentComponent["bom-ref"]) {
              workspaceRefPyProjMap[wcompMap.parentComponent["bom-ref"]] =
                awpyproj;
            }
            // uv.lock auto normalizes names containing underscores
            if (wcompMap.parentComponent.name.includes("_")) {
              workspaceComponentMap[
                wcompMap.parentComponent.name.replaceAll("_", "-")
              ] = wcompMap.parentComponent;
              workspacePyProjMap[
                wcompMap.parentComponent.name.replaceAll("_", "-")
              ] = awpyproj;
            }
          }
          // The block above already treats an unreadable workspace pyproject.toml as
          // tolerable, so this must not dereference the component it skipped. A
          // workspace member whose manifest cannot be parsed contributes no parent
          // ref, and recording `undefined` as the parent of its dependencies would
          // corrupt the tree for the members that did parse.
          const wparentComponentRef = wcompMap?.parentComponent?.["bom-ref"];
          if (wcompMap?.dependencySourceMap) {
            Object.assign(
              workspaceDependencySourceMap,
              wcompMap.dependencySourceMap,
            );
          }
          // Track the parents of workspace direct dependencies
          if (wcompMap?.directDepsKeys && wparentComponentRef) {
            for (const wdd of Object.keys(wcompMap?.directDepsKeys)) {
              if (!pkgParentMap[wdd]) {
                pkgParentMap[wdd] = [];
              }
              pkgParentMap[wdd].push(wparentComponentRef);
            }
          }
        }
      }
    }
  }
  let lockTomlObj;
  try {
    lockTomlObj = parseToml(lockData);
  } catch (err) {
    if (lockFile) {
      // The failing file names the manager whose lock command regenerates
      // it. A standards-named lock file (PEP 751 `pylock.toml`) belongs to
      // no single manager, so it falls back to the generic repair, whose
      // lock command the shaping resolves from whichever manager the
      // project turns out to use.
      const degradation =
        PY_LOCKFILE_DEGRADATIONS[basename(lockFile)] ||
        GENERIC_PY_LOCKFILE_DEGRADATION;
      recordDegradation(degradation.remediationId, {
        ecosystem: "python",
        impact: "transitive-deps",
        path: lockFile,
        detail: `The ${degradation.manager} lock file could not be parsed, so no locked versions were captured from it.`,
      });
      console.log(`Error while parsing the lock file ${lockFile}.`, err);
    } else {
      console.log("Error while parsing the lock data as toml", err);
    }
  }
  // Check for workspaces
  if (lockTomlObj?.manifest?.members) {
    const workspaceMembers = lockTomlObj.manifest.members;
    if (workspaceMembers && !hasWorkspaces) {
      hasWorkspaces = true;
    }
    for (const amember of workspaceMembers) {
      if (amember === parentComponent.name) {
        continue;
      }
      if (workspaceComponentMap[amember]) {
        parentComponent.components.push(workspaceComponentMap[amember]);
      } else {
        if (!workspaceWarningShown) {
          console.log(
            `Unable to identify the metadata for the workspace ${amember}. Check if the path specified in ${workspacePyProjMap[amember] || pyProjectFile} is valid.`,
          );
        }
      }
    }
  }
  const pyLockMode = isPyLockObject(lockTomlObj);
  if (pyLockMode) {
    pyLockProperties = collectPyLockTopLevelProperties(lockTomlObj);
    if (parentComponent) {
      parentComponent.properties = parentComponent.properties || [];
      parentComponent.properties =
        parentComponent.properties.concat(pyLockProperties);
    }
  }
  const packageEntries = getPyLockPackages(lockTomlObj);
  for (const apkg of packageEntries) {
    // This avoids validation errors with uv.lock
    if (parentComponent?.name && parentComponent.name === apkg.name) {
      continue;
    }
    const pkg = {
      name: apkg.name,
      version: apkg.version,
      description: apkg.description || "",
      properties: [],
    };
    if (pyProjectFile || workspacePyProjMap[apkg.name]) {
      pkg.properties.push({
        name: "internal:SrcFile",
        value: workspacePyProjMap[apkg.name] || pyProjectFile,
      });
    }
    const manifestSource =
      dependencySourceMap[normalizePythonDependencyKey(apkg.name)] ||
      workspaceDependencySourceMap[normalizePythonDependencyKey(apkg.name)] ||
      collectPythonManifestSource(apkg);
    applyManifestSourceProperties(pkg, "cdx:pypi", manifestSource);
    if (apkg.optional) {
      pkg.scope = "optional";
    }
    // poetry/pdm/uv use "python-versions", while pylock (PEP 751) uses "requires-python".
    // Prefer the existing lock-family field when both are present.
    const requiresPython = apkg["python-versions"] || apkg["requires-python"];
    if (requiresPython) {
      pkg.properties.push({
        name: "cdx:pypi:requiresPython",
        value: requiresPython,
      });
    }
    if (apkg.index && !isDefaultPypiRegistry(apkg.index)) {
      pkg.properties.push({
        name: "cdx:pypi:registry",
        value: normalizePyLockRegistry(apkg.index),
      });
    }
    if (apkg?.source) {
      if (
        apkg.source.registry &&
        !apkg?.source?.registry?.startsWith("https://pypi.org/")
      ) {
        pkg.properties.push({
          name: "cdx:pypi:registry",
          value: normalizePyLockRegistry(apkg.source.registry),
        });
      }
      if (apkg?.source?.virtual) {
        pkg.properties.push({
          name: "internal:virtual_path",
          value: workspacePyProjMap[apkg.name] || apkg.source.virtual,
        });
      }
      if (apkg?.source?.editable) {
        pkg.properties.push({
          name: "internal:virtual_path",
          value: apkg.source.editable,
        });
      }
    }
    mergeExternalReferences(pkg, collectPythonLockDistributionReferences(apkg));
    if (pyLockMode) {
      pkg.properties = pkg.properties.concat(
        collectPyLockPackageProperties(apkg),
      );
    }
    // Is this component a module?
    if (workspaceComponentMap[pkg.name]) {
      pkg.properties.push({
        name: "internal:is_workspace",
        value: "true",
      });
      pkg.type = "application";
    }
    const purlString = build({
      type: "pypi",
      namespace: "" || null,
      name: pkg.name,
      version: pkg.version || null,
    });
    pkg.purl = purlString;
    pkg["bom-ref"] = decodeURIComponent(purlString);
    if (parentComponent && pkg["bom-ref"] === parentComponent["bom-ref"]) {
      continue;
    }
    pkg.evidence = {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: lockFile,
          },
        ],
      },
    };
    if (groupDepsKeys?.[pkg.name]) {
      pkg.scope = "optional";
      pkg.properties = pkg.properties.concat(
        groupDepsKeys[pkg.name].map((g) => {
          return { name: "cdx:pyproject:group", value: g };
        }),
      );
    }
    // Track the workspace purls that had an explicit dependency on this package
    if (pkgParentMap[pkg.name]) {
      for (const workspaceRef of pkgParentMap[pkg.name]) {
        pkg.properties.push({
          name: "internal:workspaceRef",
          value: workspaceRef,
        });
        if (workspaceRefPyProjMap[workspaceRef]) {
          pkg.properties.push({
            name: "internal:workspaceSrcFile",
            value: workspaceRefPyProjMap[workspaceRef],
          });
        }
      }
    }
    const metadataFileEntries = collectPythonLockMetadataFileEntries(
      lockTomlObj,
      pkg,
    );
    mergeExternalReferences(
      pkg,
      collectPythonLockMetadataDistributionReferences(metadataFileEntries),
    );
    if (metadataFileEntries.length) {
      pkg.components = [];
      for (const afileObj of metadataFileEntries) {
        const fileName = derivePythonLockMetadataFileName(afileObj);
        // Skip entries we cannot name - nameless type:file components are
        // invalid per the CycloneDX schema and would fail validation.
        if (!fileName) {
          continue;
        }
        const hashParts = afileObj?.hash?.split(":");
        let hashes;
        if (hashParts?.length === 2) {
          const alg = hashParts[0].replace("sha", "SHA-");
          hashes = [{ alg, content: hashParts[1] }];
        }
        pkg.components.push({
          type: "file",
          name: fileName,
          hashes,
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
          properties: [{ name: "internal:SrcFile", value: lockFile }],
        });
      }
      // All entries may have been skipped (e.g. none had a derivable name).
      if (!pkg.components.length) {
        delete pkg.components;
      }
    }
    if (pyLockMode) {
      const pylockFileComponents = collectPyLockFileComponents(apkg, lockFile);
      if (pylockFileComponents.length) {
        pkg.components = (pkg.components || []).concat(pylockFileComponents);
      }
    }
    const normalizedPkgName = normalizePythonDependencyKey(pkg.name);
    if (
      directDepsKeys[normalizedPkgName] ||
      (hasWorkspaces && !Object.keys(workspaceComponentMap).length)
    ) {
      rootList.push(pkg);
    }
    // This would help the lookup
    existingPkgMap[pkg.name.toLowerCase()] = pkg["bom-ref"];
    pkgBomRefMap[pkg["bom-ref"]] = pkg;
    // Do not repeat workspace components again under components
    // This will reduce false positives, when a downstream tool attempts to analyze all components
    if (pkg.type !== "application") {
      pkgList.push(pkg);
    }
    if (!depsMap[pkg["bom-ref"]]) {
      depsMap[pkg["bom-ref"]] = new Set();
    }
    // Track the workspace tree
    if (pkgParentMap[pkg.name]) {
      for (const pkgParentRef of pkgParentMap[pkg.name]) {
        if (!depsMap[pkgParentRef]) {
          depsMap[pkgParentRef] = new Set();
        }
        depsMap[pkgParentRef].add(pkg["bom-ref"]);
      }
    }
    let optionalDependencies = [];
    let devDependencies = [];
    const pylockRelationshipDeps = pyLockMode
      ? collectPyLockDependencyRelationships(apkg)
      : [];
    if (apkg["dev-dependencies"]) {
      for (const agroup of Object.keys(apkg["dev-dependencies"])) {
        devDependencies = devDependencies.concat(
          apkg["dev-dependencies"][agroup],
        );
      }
    }
    if (apkg["optional-dependencies"]) {
      for (const agroup of Object.keys(apkg["optional-dependencies"])) {
        optionalDependencies = optionalDependencies.concat(
          apkg["optional-dependencies"][agroup],
        );
      }
    }
    if (
      apkg.dependencies ||
      pylockRelationshipDeps.length ||
      devDependencies.length ||
      optionalDependencies.length
    ) {
      if (Array.isArray(apkg.dependencies)) {
        // pdm.lock files
        let allDeps = apkg.dependencies;
        allDeps = allDeps.concat(devDependencies);
        allDeps = allDeps.concat(optionalDependencies);
        for (const apkgDep of allDeps) {
          // Example: "msgpack>=0.5.2"
          const nameStr =
            apkgDep.name || apkgDep.split(/(==|<=|~=|>=)/)[0].split(" ")[0];
          // Python package names are normalized/case-insensitive; support both forms for lookup.
          const nameLower = nameStr.toLowerCase();
          const depPkgRef =
            existingPkgMap[nameLower] || existingPkgMap[nameStr];
          depsMap[pkg["bom-ref"]].add(depPkgRef || nameStr);
          // Propagate the workspace properties to the child components
          if (depPkgRef && pkgBomRefMap[depPkgRef]) {
            const dependentPkg = pkgBomRefMap[depPkgRef];
            dependentPkg.properties = dependentPkg.properties || [];
            const addedValue = {};
            // Is the parent a workspace
            if (workspaceComponentMap[pkg.name]) {
              dependentPkg.properties.push({
                name: "internal:workspaceRef",
                value: pkg["bom-ref"],
              });
              dependentPkg.properties.push({
                name: "internal:workspaceSrcFile",
                value: workspaceRefPyProjMap[pkg["bom-ref"]],
              });
              addedValue[pkg["bom-ref"]] = true;
            }
            for (const pprop of pkg.properties) {
              if (
                pprop.name.startsWith("internal:workspace") &&
                !addedValue[pprop.value]
              ) {
                dependentPkg.properties.push(pprop);
                addedValue[pprop.value] = true;
              }
            }
          }
        }
        for (const relationship of pylockRelationshipDeps) {
          const depPkgRef =
            existingPkgMap[relationship.name.toLowerCase()] ||
            existingPkgMap[relationship.name];
          if (depPkgRef) {
            depsMap[pkg["bom-ref"]].add(depPkgRef);
          }
          if (relationship.scope === "optional-extra") {
            pkg.scope = pkg.scope || "optional";
            pkg.properties.push({
              name: "cdx:pyproject:extra",
              value: relationship.name,
            });
          }
          if (relationship.scope === "dependency-group") {
            pkg.properties.push({
              name: "cdx:pyproject:dependencyGroupMember",
              value: relationship.name,
            });
          }
        }
      } else if (apkg.dependencies && Object.keys(apkg.dependencies).length) {
        for (const apkgDep of Object.keys(apkg.dependencies)) {
          depsMap[pkg["bom-ref"]].add(existingPkgMap[apkgDep] || apkgDep);
        }
        for (const relationship of pylockRelationshipDeps) {
          const depPkgRef =
            existingPkgMap[relationship.name.toLowerCase()] ||
            existingPkgMap[relationship.name];
          if (depPkgRef) {
            depsMap[pkg["bom-ref"]].add(depPkgRef);
          }
        }
      } else {
        for (const relationship of pylockRelationshipDeps) {
          const depPkgRef =
            existingPkgMap[relationship.name.toLowerCase()] ||
            existingPkgMap[relationship.name];
          if (depPkgRef) {
            depsMap[pkg["bom-ref"]].add(depPkgRef);
          }
        }
      }
    }
  }
  // Seed the parent component's first-level edges from the manifest. Lock
  // files describe the resolved closure but do not say which of the locked
  // packages the root project directly depends on; parsePyProjectTomlFile
  // derived that set into directDepsKeys from [project.dependencies] /
  // [tool.poetry.dependencies]. Only packages that are locked resolve to a
  // bom-ref here, so the seeded edge never dangles and dev-group or
  // unresolved dependencies stay out of the first level. Seeding
  // depsMap (instead of pushing into dependenciesList) lets the
  // materialisation below apply its usual ref resolution and sorting.
  if (parentComponent?.["bom-ref"] && Object.keys(directDepsKeys).length) {
    const rootRef = parentComponent["bom-ref"];
    const rootDeps = new Set();
    for (const depKey of Object.keys(directDepsKeys)) {
      const depRef =
        existingPkgMap[depKey] ||
        existingPkgMap[depKey.replaceAll("-", "_")] ||
        existingPkgMap[`py${depKey}`];
      if (depRef && depRef !== rootRef) {
        rootDeps.add(depRef);
      }
    }
    if (rootDeps.size) {
      const existingRootDeps = depsMap[rootRef];
      if (existingRootDeps) {
        for (const adep of rootDeps) {
          existingRootDeps.add(adep);
        }
      } else {
        depsMap[rootRef] = rootDeps;
      }
    }
  }
  for (const key of Object.keys(depsMap)) {
    const dependsOnList = new Set();
    const parentPkg = pkgBomRefMap[key];
    for (const adep of Array.from(depsMap[key])) {
      let depRef;
      if (adep.startsWith("pkg:")) {
        depRef = adep;
      } else if (existingPkgMap[adep]) {
        depRef = existingPkgMap[adep];
      } else if (existingPkgMap[adep.toLowerCase()]) {
        depRef = existingPkgMap[adep.toLowerCase()];
      } else if (existingPkgMap[`py${adep}`]) {
        depRef = existingPkgMap[`py${adep}`];
      } else if (existingPkgMap[adep.replace(/-/g, "_")]) {
        depRef = existingPkgMap[adep.replace(/-/g, "_")];
      }
      if (depRef) {
        dependsOnList.add(depRef);
        // We need to propagate the workspace properties from the parent
        const dependentPkg = pkgBomRefMap[depRef];
        dependentPkg.properties = dependentPkg.properties || [];
        const addedValue = {};
        for (const p of dependentPkg.properties) {
          if (p.name.startsWith("internal:workspace")) {
            addedValue[p.value] = true;
          }
        }
        if (parentPkg?.properties?.length) {
          for (const pprop of parentPkg.properties) {
            if (
              pprop.name.startsWith("internal:workspace") &&
              !addedValue[pprop.value]
            ) {
              dependentPkg.properties.push(pprop);
              addedValue[pprop.value] = true;
            } else if (pprop.name === "internal:is_workspace") {
              dependentPkg.properties.push({
                name: "internal:workspaceRef",
                value: parentPkg["bom-ref"],
              });
              dependentPkg.properties.push({
                name: "internal:workspaceSrcFile",
                value: workspaceRefPyProjMap[parentPkg["bom-ref"]],
              });
              addedValue[parentPkg["bom-ref"]] = true;
              addedValue[workspaceRefPyProjMap[parentPkg["bom-ref"]]] = true;
              const childDeps = depsMap[dependentPkg["bom-ref"]];
              for (const childRef of childDeps) {
                if (!childRef.startsWith("pkg:")) {
                  continue;
                }
                const childPkg = pkgBomRefMap[childRef];
                if (childPkg) {
                  childPkg.properties = childPkg.properties || [];
                  childPkg.properties.push({
                    name: "internal:workspaceRef",
                    value: parentPkg["bom-ref"],
                  });
                  childPkg.properties.push({
                    name: "internal:workspaceSrcFile",
                    value: workspaceRefPyProjMap[parentPkg["bom-ref"]],
                  });
                }
              }
            }
          }
        }
      }
    }
    dependenciesList.push({
      ref: key,
      dependsOn: [...dependsOnList].sort(),
    });
  }
  // The installed distributions answer first, so PyPI is asked only about the
  // packages they do not cover.
  enrichFromInstalledMetadata(pkgList, options.installedMetadata);
  pkgList = await getPyMetadata(pkgList, false);
  return {
    parentComponent,
    pkgList,
    rootList,
    dependenciesList,
    pyLockProperties,
    workspaceWarningShown,
  };
}

/**
 * First version clause of a PEP 508 requirement: an operator and the version
 * that follows it.
 *
 * `===` (arbitrary equality) is tried before `==`, whitespace may separate the
 * operator from the version, and a version may carry a PEP 440 epoch (`1!2.0`)
 * or a local version label (`2.1.0+cpu`).
 */
const PEP440_VERSION_CLAUSE = /(===|==|!=|<=|>=|~=|<|>)\s*([0-9A-Za-z.*_+!-]*)/;

/**
 * Method to parse requirements.txt file. This must be replaced with atom parsedeps.
 *
 * @param {String} reqFile Requirements.txt file
 * @param {Boolean} fetchDepsInfo Fetch dependencies info from pypi
 *
 * @returns {Promise[Array<Object>]} List of direct dependencies from the requirements file
 */
export async function parseReqFile(reqFile, fetchDepsInfo = false) {
  return await parseReqData(reqFile, null, fetchDepsInfo);
}

const LICENSE_ID_COMMENTS_PATTERN =
  /^(Apache-2\.0|MIT|ISC|GPL-|LGPL-|BSD-[23]-Clause)/i;

function parseLicenseComment(comment) {
  if (!comment) {
    return undefined;
  }
  const licenses = comment
    .split("/")
    .map((value) => {
      const licenseId = value.trim();
      if (!licenseId.match(LICENSE_ID_COMMENTS_PATTERN)) {
        return undefined;
      }
      return { license: { id: licenseId } };
    })
    .filter((value) => value !== undefined);
  return licenses.length ? licenses : undefined;
}

/**
 * Method to parse requirements.txt file. Must only be used internally.
 *
 * @param {String} reqFile Requirements.txt file
 * @param {Object} reqData Requirements.txt data for internal invocations from setup.py file etc.
 * @param {Boolean} fetchDepsInfo Fetch dependencies info from pypi
 * @returns {Promise<Array<Object>>} List of direct dependencies from the requirements file
 */
async function parseReqData(reqFile, reqData = null, fetchDepsInfo = false) {
  const pkgList = [];
  let compScope;
  if (!reqFile && !reqData) {
    console.warn(
      "Either the requirements file or the data needs to be provided for parsing.",
    );
    return pkgList;
  }
  reqData = reqData || readFileSync(reqFile, { encoding: "utf-8" });
  const evidence = reqFile
    ? {
        identity: {
          field: "purl",
          confidence: 0.5,
          methods: [
            {
              technique: "manifest-analysis",
              confidence: 0.5,
              value: reqFile,
            },
          ],
        },
      }
    : undefined;
  const normalizedData = reqData.replace(/\r/g, "").replace(/\\\n/g, " ");
  const lines = normalizedData.split("\n");
  for (const line of lines) {
    let l = line.trim();
    let editableRequirement = false;
    if (l.includes("# Basic requirements")) {
      compScope = "required";
    } else if (l.includes("added by pip freeze")) {
      compScope = undefined;
    }
    if (l.startsWith("-e ") || l.startsWith("--editable ")) {
      editableRequirement = true;
      l = l.replace(/^--editable\s+|^-e\s+/, "").trim();
    }
    if (l.startsWith("Skipping line") || l.startsWith("(add")) {
      continue;
    }
    if (!l || l.startsWith("#") || l.startsWith("-")) {
      continue;
    }
    let comment = null;
    // Equivalent to /\s+#(.*)$/ but linear: an unanchored `\s+` backtracks
    // quadratically on long whitespace runs without a '#', which a crafted
    // requirements.txt used to burn seconds of CPU per line.
    const hashIndex = l.indexOf("#");
    if (hashIndex > 0 && /\s/.test(l[hashIndex - 1])) {
      comment = l.substring(hashIndex + 1).trim();
      l = l.substring(0, hashIndex).trim();
    }
    const properties = reqFile
      ? [
          {
            name: "internal:SrcFile",
            value: reqFile,
          },
        ]
      : [];
    const hashes = [];
    const hashRegex = /--hash=([a-zA-Z0-9\-]+):([a-fA-F0-9]+)/g;
    let hashMatch;
    while ((hashMatch = hashRegex.exec(l)) !== null) {
      let alg = hashMatch[1].toUpperCase();
      if (alg === "SHA256") alg = "SHA-256";
      else if (alg === "SHA384") alg = "SHA-384";
      else if (alg === "SHA512") alg = "SHA-512";
      else if (alg === "SHA1") alg = "SHA-1";
      hashes.push({
        alg: alg,
        content: hashMatch[2],
      });
    }
    // Strip the hash flags and any residual backslashes
    l = l
      .replace(/--hash=[a-zA-Z0-9\-]+:[a-fA-F0-9]+/g, "")
      .replace(/\\/g, "")
      .trim();
    // Handle markers
    let markers = null;
    let structuredMarkers = null;
    if (l.includes(";")) {
      const parts = l.split(";");
      l = parts[0].trim();
      markers = parts.slice(1).join(";").trim();
      structuredMarkers = parseReqEnvMarkers(markers);
    }
    const requirementManifestSource = parsePythonRequirementManifestSource(l);
    if (requirementManifestSource?.name) {
      const apkg = {
        name: requirementManifestSource.name,
        version: null,
        scope: compScope,
        evidence,
      };
      if (hashes.length > 0) {
        apkg.hashes = hashes;
      }
      const licenses = parseLicenseComment(comment);
      if (licenses) {
        apkg.licenses = licenses;
      }
      applyManifestSourceProperties(
        apkg,
        "cdx:pypi",
        requirementManifestSource,
      );
      if (editableRequirement) {
        addComponentProperty(apkg, "cdx:pypi:editable", "true");
      }
      if (markers) {
        addComponentProperty(apkg, "cdx:pip:markers", markers);
        if (structuredMarkers?.length > 0) {
          addComponentProperty(
            apkg,
            "cdx:pip:structuredMarkers",
            JSON.stringify(structuredMarkers),
          );
        }
      }
      if (reqFile) {
        addComponentProperty(apkg, "internal:SrcFile", reqFile);
      }
      pkgList.push(apkg);
      continue;
    }

    // Handle extras (e.g., package[extra1,extra2])
    let extras = null;
    const extrasMatch = l.match(/^([a-zA-Z0-9_\-.]+)(\[([^\]]+)])?(.*)$/);
    if (extrasMatch) {
      const [, packageName, , extrasStr, versionSpecifiers] = extrasMatch;
      const name = packageName;
      if (extrasStr) {
        extras = extrasStr.split(",").map((e) => e.trim());
        l = `${name}${versionSpecifiers}`; // Reconstruct without extras for version parsing
      }
      if (PYTHON_STD_MODULES.includes(name)) {
        continue;
      }
      const versionMatch = versionSpecifiers.match(PEP440_VERSION_CLAUSE);
      let version = null;
      if (versionMatch) {
        version = versionMatch[2].replaceAll("*", "0") || null;
        if (version === "0") {
          version = null;
        }
      }
      const apkg = {
        name,
        version,
        scope: compScope,
        evidence,
      };
      if (hashes.length > 0) {
        apkg.hashes = hashes;
      }
      const licenses = parseLicenseComment(comment);
      if (licenses) {
        apkg.licenses = licenses;
      }
      if (extras && extras.length > 0) {
        properties.push({
          name: "cdx:pypi:extras",
          value: extras.join(","),
        });
      }
      if (versionSpecifiers && !versionSpecifiers.trim().startsWith("==")) {
        properties.push({
          name: "cdx:pypi:versionSpecifiers",
          value: versionSpecifiers.trim(),
        });
      }
      if (markers) {
        properties.push({
          name: "cdx:pip:markers",
          value: markers,
        });
        if (structuredMarkers && structuredMarkers.length > 0) {
          properties.push({
            name: "cdx:pip:structuredMarkers",
            value: JSON.stringify(structuredMarkers),
          });
        }
      }
      if (editableRequirement) {
        properties.push({
          name: "cdx:pypi:editable",
          value: "true",
        });
      }
      if (properties.length) {
        apkg.properties = properties;
      }
      pkgList.push(apkg);
    } else {
      const match = l.match(/^([a-zA-Z0-9_\-.]+)(.*)$/);
      if (!match) {
        continue;
      }
      const [, name, versionSpecifiers] = match;
      if (PYTHON_STD_MODULES.includes(name)) {
        continue;
      }
      const versionMatch = versionSpecifiers.match(PEP440_VERSION_CLAUSE);
      let version = null;
      if (versionMatch) {
        version = versionMatch[2].replaceAll("*", "0") || null;
        if (version === "0") version = null;
      }
      const apkg = {
        name,
        version,
        scope: compScope,
        evidence,
      };
      const licenses = parseLicenseComment(comment);
      if (licenses) {
        apkg.licenses = licenses;
      }
      if (versionSpecifiers && !versionSpecifiers.trim().startsWith("==")) {
        properties.push({
          name: "cdx:pypi:versionSpecifiers",
          value: versionSpecifiers.trim(),
        });
      }
      if (markers) {
        properties.push({
          name: "cdx:pip:markers",
          value: markers,
        });
        if (structuredMarkers && structuredMarkers.length > 0) {
          properties.push({
            name: "cdx:pip:structuredMarkers",
            value: JSON.stringify(structuredMarkers),
          });
        }
      }
      if (editableRequirement) {
        properties.push({
          name: "cdx:pypi:editable",
          value: "true",
        });
      }
      if (properties.length) {
        apkg.properties = properties;
      }
      pkgList.push(apkg);
    }
  }
  return await getPyMetadata(pkgList, fetchDepsInfo);
}

/**
 * Parse environment markers into structured format
 *
 * @param {String} markersStr Raw markers string
 * @returns {Array<Object>} Structured markers array
 */
export function parseReqEnvMarkers(markersStr) {
  if (!markersStr) return [];

  const markers = [];
  const tokens = markersStr
    .replace(/\s+/g, " ")
    .trim()
    .split(/\s+(and|or)\s+/gi)
    .filter((token) => token.trim());
  for (const token of tokens) {
    if (token.toLowerCase() === "and" || token.toLowerCase() === "or") {
      markers.push({
        operator: token.toLowerCase(),
      });
    } else {
      const match = token.match(
        /([a-zA-Z_]+)\s*(==|!=|<=|>=|<|>)\s*["']?([^"']*)["']?/,
      );
      if (match) {
        markers.push({
          variable: match[1],
          operator: match[2],
          value: match[3],
        });
      } else {
        // Add as raw token if parsing fails
        markers.push({
          raw: token,
        });
      }
    }
  }
  return markers;
}

/**
 * Method to parse setup.py data
 *
 * @param {Object} setupPyData Contents of setup.py
 */
export async function parseSetupPyFile(setupPyData) {
  let lines = [];
  let requires_found = false;
  let should_break = false;
  setupPyData.split("\n").forEach((l) => {
    l = l.trim();
    if (l.includes("install_requires")) {
      l = l.replace("install_requires=[", "");
      requires_found = true;
    }
    if (l.length && requires_found && !should_break) {
      if (l.includes("]")) {
        should_break = true;
        l = l.replaceAll("],", "").replaceAll("]", "");
      }
      let tmpA = l.replace(/['"]/g, "").split(",");
      tmpA = tmpA.filter((v) => v.length);
      lines = lines.concat(tmpA);
    }
  });
  return await parseReqData(null, lines.join("\n"), false);
}

/**
 * Method to create purl using information in pixi.lock file.
 * According to pixi lock file satisfiability (https://pixi.sh/latest/features/lockfile/#lockfile-satisfiability)
 *
 *
 *
 * @param {*} packageData
 * @returns
 */
function createPurlTemplate(packageData) {
  // conda defines build/channel/subdir/type as its qualifiers, and the pixi
  // field is already called subdir, so it maps straight across. pixi records
  // the build separately while conda versions carry it as a `version-build`
  // suffix.
  const version = packageData["build"]
    ? `${packageData["version"]}-${packageData["build"]}`
    : packageData["version"];
  return tryBuildPurl({
    type: packageData["kind"],
    name: packageData["name"],
    version,
    qualifiers: packageData["subdir"]
      ? { subdir: packageData["subdir"] }
      : undefined,
  });
}

/**
 * Identifier for a pixi package, used as its `bom-ref` and by every dependency
 * that references it. Derived from the purl so the graph and the components
 * agree, with a fallback for a package whose purl cannot be built.
 *
 * @param {object} packageData Package entry from a pixi.lock file
 * @returns {string} bom-ref
 */
function createPixiBomRef(packageData) {
  const purl = createPurlTemplate(packageData);
  if (purl) {
    return decodeURIComponent(purl);
  }
  return `library:${packageData["name"]}:${packageData["version"] || ""}`;
}

/**
 * Method to parse pixi.lock data
 *
 * @param {String} pixiLockFileName  pixi.lock file name
 * @param {String} path File path
 */
export function parsePixiLockFile(pixiLockFileName, path) {
  const pixiFileData = readFileSync(pixiLockFileName, { encoding: "utf-8" });
  const pixiLockData = _load(pixiFileData);
  const evidenceBasePath = path ?? dirname(pixiLockFileName);

  // this function returns
  let pkgList;
  const formulationList = [];
  const rootList = [];
  let dependenciesList;
  // we do not set false because we have assumed that pixi lock is accurate
  const frozen = true;

  /**
   * pixiMapper used with a map on pixi packages list.
   * the pixi list contains the following information e.g.
   * {kind: conda
   *  name: alsa-lib
   *  version: 1.2.11
   *  build: h31becfc_1
   *  build_number: 1
   *  subdir: linux-aarch64
   *  url: https://conda.anaconda.org/conda-forge/linux-aarch64/alsa-lib-1.2.11-h31becfc_1.conda
   *  sha256: d062bc712dd307714dfdb0f7da095a510c138c5db76321494a516ac127f9e5cf
   *  md5: 76bf292a85a0556cef4f500420cabe6c
   *  depends:
   *  - libgcc-ng >=12
   *  license: LGPL-2.1-or-later
   *  license_family: GPL
   *  size: 584152
   *  timestamp: 1709396718705
   * }
   * We create the purl using the following logic:
   * "purl": "pkg:{kind}/{name}@{version}-{build}?os={os}"
   * type would be "library" and evidence would be
   * {
   *  "identity": {
   *                    "field": "purl",
   *                    "confidence": 1,
   *                    "methods": [
   *                        {
   *                            "technique": "instrumentation",
   *                            "confidence": 1,
   *                            "value": "pixi.lock"
   *                        }
   *                    ]
   *                }
   * }
   *
   */
  function pixiMapper(packageData) {
    // return pkgList
    /** E.g. of what a pkgList element looks like
     * {
     *      name: "conda-content-trust",
     *      version: "latest",
     *      purl: "pkg:pypi/conda-content-trust@latest",
     *      type: "library",
     *      "bom-ref": "pkg:pypi/conda-content-trust@latest",
     *      scope: "excluded",
     *      evidence: {
     *        identity: {
     *          field: "purl",
     *          confidence: 1,
     *          methods: [
     *            {
     *              technique: "instrumentation",
     *              confidence: 1,
     *              value: "/home/greatsage/miniconda3",
     *            },
     *          ],
     *        },
     *      },
     *      properties: [
     *        {
     *          name: "internal:SrcFile",
     *          value: "/home/greatsage/projects/supplyChain/trials/pythonprojs/fastapi/requirements.txt",
     *        },
     *      ],
     *    }
     *
     */
    const purlTemplate = createPurlTemplate(packageData);
    return {
      name: packageData["name"],
      version: packageData["version"],
      ...(purlTemplate ? { purl: purlTemplate } : {}),
      type: "library",
      "bom-ref": createPixiBomRef(packageData),
      // "licenses": [
      //   [{
      //       "id": packageData["license"]
      //   }]
      // ],
      supplier: {
        name: packageData["build"],
        url: packageData["url"],
      },
      // "hashes": [
      //   {"md5": packageData["md5"]},
      //   {"sha256": packageData["sha256"]}
      // ],
      evidence: {
        identity: {
          field: "purl",
          confidence: 1,
          methods: [
            {
              technique: "instrumentation",
              confidence: 1,
              // "value": `${path}/.pixi/envs/default`
            },
          ],
        },
      },
      properties: [
        { name: "cdx:pixi:operating_system", value: packageData["subdir"] },
        {
          name: "cdx:pixi:build_number",
          value: `${packageData["build_number"]}`,
        },
        { name: "cdx:pixi:build", value: `${packageData["build"]}` },
      ],
    };
  }

  function mapAddEvidenceValue(p) {
    // TODO: get pixi environment variable (PR #1343)
    p.evidence.identity.methods[0].value = `${evidenceBasePath}/.pixi/envs/default`;
    return p;
  }

  // create the pkgList
  pkgList = pixiLockData["packages"].map(pixiMapper);
  pkgList = pkgList.map(mapAddEvidenceValue);

  // create dependencies
  const dictionary_packages = pixiLockData["packages"].reduce(
    (accumulator, currentObject) => {
      accumulator[currentObject["name"]] = currentObject;
      return accumulator;
    },
    {},
  );

  dependenciesList = [];
  for (const package_iter of pixiLockData["packages"]) {
    const depends = package_iter["depends"];
    if (!depends) {
      continue;
    }

    const purltemplate = createPixiBomRef(package_iter);
    const subdir = package_iter["subdir"];
    const dependsOn = new Set();
    for (const depends_package of depends) {
      const depends_package_name = depends_package.split(" ");
      const depends_package_information =
        dictionary_packages[depends_package_name[0] + subdir];
      if (!depends_package_information) {
        continue;
      }
      dependsOn.add(createPixiBomRef(depends_package_information));
    }

    dependenciesList.push({
      ref: purltemplate,
      dependsOn: [...dependsOn].sort(),
    });
  }

  return {
    pkgList,
    formulationList,
    rootList,
    dependenciesList,
    frozen,
  };
}

/**
 * Method to parse pixi.toml file
 *
 * @param {String} pixiToml
 */
export function parsePixiTomlFile(pixiToml) {
  const pixiTomlFile = readFileSync(pixiToml, { encoding: "utf-8" });
  let tomlData;
  try {
    tomlData = parseToml(pixiTomlFile);
  } catch (err) {
    console.log(`Error while parsing the pixi file ${pixiToml}.`, err);
    return {};
  }
  const pkg = {};
  if (!tomlData) {
    return pkg;
  }
  const projectData = tomlData.workspace || tomlData.project || {};
  pkg.description = projectData.description;
  pkg.name = projectData.name;
  pkg.version = projectData.version;
  // pkg.authors = tomlData['project']['authors'];
  // The parent component only gets `cleanParentComponent`, which converts the
  // transient `{ url }` shape — raw strings would be dropped silently, so
  // emit external references directly instead.
  if (projectData.homepage) {
    pkg.externalReferences = pkg.externalReferences || [];
    pkg.externalReferences.push({
      type: "website",
      url: projectData.homepage,
    });
  }
  if (projectData.repository) {
    pkg.externalReferences = pkg.externalReferences || [];
    pkg.externalReferences.push({ type: "vcs", url: projectData.repository });
  }
  return pkg;
}

/**
 * Method to run cli command `pixi install`
 *
 *
 */
export function generatePixiLockFile(_path) {
  const result = safeSpawnSync("pixi", ["install"]);

  if (result.status !== 0) {
    // Handle errors
    if (result.error && result.error.code === "ENOENT") {
      console.error(
        "Error: pixi command not found. Make sure pixi.js is installed globally.",
      );
    } else {
      console.error(
        `Error executing pixi install: ${result.error || result.stderr.toString()}`,
      );
    }
    process.exit(1);
  } else {
    console.log("Dependencies installed successfully.");
  }
}

/**
 * Parse a Mojo `mojoproject.toml` manifest.
 *
 * Mojo projects are pixi-managed, so conda and PyPI dependencies pulled through
 * pixi.lock already keep their correct registered types via the pixi path.
 * Only Mojo's *own* packages — declared in `mojoproject.toml` — need special
 * handling: `mojo` is not a registered purl type, so each is emitted as
 * `pkg:generic/...` with a `cdx:purl:proposedType=mojo` property.
 *
 * The manifest is TOML. The `[project]` table carries the project's name and
 * version; `[dependencies]` maps dependency names to version specifiers. A
 * declared version range (e.g. `==0.1.0`, `>=0.2`) is normalised to its
 * concrete version when one is present, otherwise the version is omitted.
 *
 * @param {string} mojoProjectFile Path to `mojoproject.toml`
 * @returns {{ pkgList: object[], parentComponent: object }}
 */
export function parseMojoProject(mojoProjectFile) {
  let manifest;
  try {
    manifest = parseToml(readFileSync(mojoProjectFile, "utf-8"));
  } catch (error) {
    console.warn(`Failed to parse ${mojoProjectFile}: ${error.message}`);
    return { pkgList: [], parentComponent: {} };
  }

  const parentComponent = {};
  const project = manifest.project;
  if (project && typeof project === "object") {
    if (project.name) {
      parentComponent.name = `${project.name}`;
      parentComponent.type = "application";
      if (project.version) {
        parentComponent.version = `${project.version}`;
      }
      parentComponent.description =
        typeof project.description === "string"
          ? project.description
          : `Mojo project: ${project.name}`;
      parentComponent.properties = [
        { name: "internal:SrcFile", value: mojoProjectFile },
      ];
    }
  }

  const pkgList = [];
  const deps = manifest.dependencies;
  if (deps && typeof deps === "object") {
    for (const [name, specRaw] of Object.entries(deps)) {
      const spec =
        typeof specRaw === "string"
          ? specRaw
          : specRaw && typeof specRaw === "object"
            ? `${specRaw.version || ""}`
            : "";
      const version = normaliseMojoVersion(spec);
      pkgList.push(mojoPackage(name, version, mojoProjectFile));
    }
  }

  return { pkgList, parentComponent };
}

/**
 * Build a component record for a Mojo dependency. Mojo has no registered purl
 * type, so the package is identified as generic with a proposedType marker.
 *
 * @param {string} name Dependency name
 * @param {string|undefined} version Concrete version, if one was declared
 * @param {string} srcFile Source manifest path for evidence
 * @returns {object} Package record
 */
function mojoPackage(name, version, srcFile) {
  const purl = tryBuildPurl({
    type: "generic",
    name,
    version: version || undefined,
  });
  const pkg = {
    name,
    ...(version ? { version } : {}),
    type: "library",
    scope: "required",
    properties: [
      { name: "internal:SrcFile", value: srcFile },
      { name: "cdx:purl:proposedType", value: "mojo" },
      { name: "cdx:mojo:dependency", value: "direct" },
    ],
  };
  if (purl) {
    pkg.purl = purl;
    pkg["bom-ref"] = decodeURIComponent(purl);
  } else {
    pkg["bom-ref"] = `library:${name}:${version || ""}`;
  }
  return pkg;
}

/**
 * Normalise a Mojo/Python-style version specifier to a concrete version.
 *
 * Specifiers like `==0.1.0`, `>=0.2,<1`, or `~=1.2` are reduced to the first
 * concrete version token; bare version strings pass through. An unresolvable
 * range yields undefined so the purl omits the version rather than encoding a
 * meaningless operator.
 *
 * @param {string} spec Version specifier
 * @returns {string|undefined}
 */
function normaliseMojoVersion(spec) {
  if (!spec || typeof spec !== "string") return undefined;
  const trimmed = spec.trim();
  if (!trimmed) return undefined;
  // Strip common comparison operators and take the first concrete version.
  // A PEP 440 epoch (`1!2.0`) is part of the version, not a separator.
  const match = trimmed.match(/((?:\d+!)?\d+(?:\.\d+)*(?:[+-][A-Za-z0-9.]+)?)/);
  return match ? match[1] : undefined;
}
