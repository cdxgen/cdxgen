import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { URL } from "node:url";

import { build } from "@cdxgen/cdx-purl";

import { DEBUG_MODE } from "../core/activity.js";
import { readRegularTextFile } from "../core/boundedFile.js";
import { recordDegradation } from "../core/buildLedger.js";
import { getAllFiles, safeExistsSync, safeSpawnSync } from "../core/fs.js";
import { boundUntrustedGlobPatterns } from "../core/globPatterns.js";
import { sanitizeBomUrl } from "../core/propertySanitizer.js";
import { PYTHON_STD_MODULES } from "../core/state.js";
import { parseToml } from "../core/toml.js";
import { parse as _load } from "../core/yaml.js";
import { applyPurl, pypiPurl, tryBuildPurl } from "../inventory/purl.js";
import { parseSpdxExpression } from "../inventory/spdxExpression.js";
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
 * @param {Object[]} [installedMetadata] Components parsed from the installed
 *   `*.dist-info/METADATA` files of this machine, which answer before PyPI
 *   is asked
 */
export async function parsePiplockData(lockData, installedMetadata) {
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
  // The installed distributions answer first, so PyPI is asked only about
  // the packages they do not cover.
  enrichFromInstalledMetadata(pkgList, installedMetadata);
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

// A full SHA-1 or SHA-256 commit id.
const GIT_COMMIT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

// A URL scheme followed by `//`, such as `https://` or `hg+https://`.
const URL_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

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

/**
 * A dependency source URL as it may appear in the BOM. User name, password,
 * query and fragment are dropped, since a deploy token or a signed download
 * can travel in any of them. The fragment of a git source is kept when it is
 * a commit id, which is how uv.lock pins the commit it resolved.
 *
 * @param {string} type Source type: `git`, `url` or `path`
 * @param {string} value Source URL or path
 * @returns {string} The value to record
 */
function sanitizePythonSourceUrl(type, value) {
  if (type !== "git" && type !== "url") {
    return value;
  }
  const sanitized = sanitizeBomUrl(value);
  if (type !== "git" || sanitized.includes("#")) {
    return sanitized;
  }
  const fragment = String(value).split("#")[1]?.trim();
  return fragment && GIT_COMMIT_ID_PATTERN.test(fragment)
    ? `${sanitized}#${fragment}`
    : sanitized;
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
    sanitizePythonSourceUrl(manifestSource.type, manifestSource.value),
  );
}

// Longest git URL, URL or path accepted as a dependency source. The manifest
// states a source once per package name, and every locked version of that
// name gets its own copy as `cdx:pypi:manifestSource`, so the bound keeps the
// BOM linear in the size of the two files. 4096 is PATH_MAX on Linux.
const MAX_MANIFEST_SOURCE_VALUE_LENGTH = 4096;

function recordPythonDependencySource(
  dependencySourceMap,
  dependencyName,
  sourceType,
  sourceValue,
) {
  const normalizedKey = normalizePythonDependencyKey(dependencyName);
  // TOML lets `git`, `url` and `path` hold any type; only a string is a source.
  if (
    !normalizedKey ||
    !sourceType ||
    typeof sourceValue !== "string" ||
    !sourceValue ||
    sourceValue.length > MAX_MANIFEST_SOURCE_VALUE_LENGTH
  ) {
    return;
  }
  dependencySourceMap[normalizedKey] = {
    type: sourceType,
    value: sourceValue,
  };
}

// Every locked version of a package receives one `cdx:pyproject:group`
// property per group recorded for its name, so the BOM grows with
// versions x groups. A project lists a package in a handful of groups with
// short names; the caps keep a crafted manifest from multiplying a lock file
// with thousands of versions by thousands of groups.
const MAX_DEPENDENCY_GROUPS_PER_PACKAGE = 32;
const MAX_DEPENDENCY_GROUP_NAME_LENGTH = 128;

/**
 * Record that a package is a member of a dependency group, once per group
 * and at most MAX_DEPENDENCY_GROUPS_PER_PACKAGE groups per package.
 *
 * @param {Object} groupDepsKeys Map of normalised package name to group names.
 * @param {string} dependencyKey Normalised package name.
 * @param {string} groupName Group name from the manifest.
 * @returns {void}
 */
function recordPythonDependencyGroup(groupDepsKeys, dependencyKey, groupName) {
  if (
    !dependencyKey ||
    typeof groupName !== "string" ||
    !groupName ||
    groupName.length > MAX_DEPENDENCY_GROUP_NAME_LENGTH
  ) {
    return;
  }
  if (!Object.hasOwn(groupDepsKeys, dependencyKey)) {
    groupDepsKeys[dependencyKey] = [];
  }
  const groups = groupDepsKeys[dependencyKey];
  if (
    groups.length >= MAX_DEPENDENCY_GROUPS_PER_PACKAGE ||
    groups.includes(groupName)
  ) {
    return;
  }
  groups.push(groupName);
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
    // `name @ <url>` always names the package. A url whose scheme is not
    // recognised, such as `hg+https://`, is left out of the BOM.
    return {
      name: directReferenceMatch[1],
      ...classifyPythonManifestSourceValue(directReferenceMatch[2]),
    };
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
    // Each member pattern is a file search, so the brace expansions of the
    // list are bounded as for other patterns from the scanned tree.
    const { accepted: uvMembers, refused } = boundUntrustedGlobPatterns(
      tomlData.tool.uv.workspace.members,
      { budget: 1024 },
    );
    if (refused.length) {
      console.warn(
        `Ignoring ${refused.length} uv workspace member pattern(s), such as '${refused[0].pattern.substring(0, 64)}', which ${refused[0].reason}.`,
      );
    }
    for (const amember of uvMembers) {
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
          recordPythonDependencyGroup(groupDepsKeys, pname, agroup);
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
          recordPythonDependencyGroup(groupDepsKeys, poetryGroupDepKey, agroup);
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
    const normalizedUrl = sanitizePythonSourceUrl(
      type === "vcs" ? "git" : "url",
      url.trim(),
    );
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

function normalizePythonLockVersion(version) {
  return version ? `${version}`.trim().toLowerCase() : "";
}

/**
 * The key a locked package and its `[metadata.files]` entries are matched by:
 * the normalised name and the version, separated by a space, which is also
 * how pdm keys the table.
 *
 * @param {string} name Package name
 * @param {string} version Package version
 * @returns {string} The key
 */
function pythonLockMetadataFilesKey(name, version) {
  return `${normalizePythonDependencyKey(name)} ${normalizePythonLockVersion(version)}`;
}

const SDIST_EXTENSIONS = [
  ".tar.gz",
  ".tar.bz2",
  ".tar.xz",
  ".tgz",
  ".tar",
  ".zip",
];

/**
 * The version a wheel or sdist file name carries.
 *
 * A wheel is `<name>-<version>(-<build>)?-<python>-<abi>-<platform>.whl`,
 * where neither the name nor the version contains a hyphen. An sdist is
 * `<name>-<version>.<ext>`, where an older name may still contain hyphens, so
 * the version is the longest part after a hyphen that is one of the versions
 * the package is locked at. Only the tail that could hold such a version is
 * searched, so a long file name costs linear time.
 *
 * @param {string} fileName File name
 * @param {{versions: Set<string>, maxLength: number}} locked The versions the
 *   package is locked at, and the length of the longest
 * @returns {string | undefined} The version, or undefined if none is found
 */
function pythonDistributionFileVersion(fileName, locked) {
  if (typeof fileName !== "string") {
    return undefined;
  }
  const name = fileName.trim().toLowerCase();
  if (name.endsWith(".whl")) {
    const parts = name.slice(0, -4).split("-");
    return parts.length >= 5 && locked.versions.has(parts[1])
      ? parts[1]
      : undefined;
  }
  const extension = SDIST_EXTENSIONS.find((ext) => name.endsWith(ext));
  if (!extension) {
    return undefined;
  }
  const stem = name.slice(0, -extension.length);
  let found;
  for (
    let i = stem.lastIndexOf("-");
    i !== -1 && stem.length - i - 1 <= locked.maxLength;
    i = i > 0 ? stem.lastIndexOf("-", i - 1) : -1
  ) {
    const version = stem.slice(i + 1);
    if (locked.versions.has(version)) {
      found = version;
    }
  }
  return found;
}

/**
 * Index the `[metadata.files]` table of a poetry or pdm lock file by package,
 * handing every entry to one locked name and version at most.
 *
 * pdm keys the table by `<name> <version>`. poetry 1.x keys it by the bare
 * name, and when a name is locked at several versions the list holds the files
 * of all of them, so each version only takes the files whose name carries it.
 * Copying the whole list onto every version would otherwise build
 * versions x files components from a lock file of versions + files lines.
 *
 * @param {object} lockTomlObj Parsed lock file
 * @param {object[]} packageEntries The `[[package]]` entries of the lock file
 * @returns {Map<string, object[]>} File entries by {@link pythonLockMetadataFilesKey}
 */
function indexPythonLockMetadataFileEntries(lockTomlObj, packageEntries) {
  const entriesByPackage = new Map();
  if (!lockTomlObj?.metadata?.files) {
    return entriesByPackage;
  }
  const lockedVersionsByName = new Map();
  for (const apkg of packageEntries) {
    const nameKey = normalizePythonDependencyKey(apkg?.name);
    if (!nameKey) {
      continue;
    }
    if (!lockedVersionsByName.has(nameKey)) {
      lockedVersionsByName.set(nameKey, { versions: new Set(), maxLength: 0 });
    }
    const locked = lockedVersionsByName.get(nameKey);
    const version = normalizePythonLockVersion(apkg.version);
    locked.versions.add(version);
    locked.maxLength = Math.max(locked.maxLength, version.length);
  }
  const addEntry = (key, fileEntry) => {
    if (!entriesByPackage.has(key)) {
      entriesByPackage.set(key, []);
    }
    entriesByPackage.get(key).push(fileEntry);
  };
  for (const [entryKey, entryValues] of Object.entries(
    lockTomlObj.metadata.files,
  )) {
    if (!Array.isArray(entryValues)) {
      continue;
    }
    const key = normalizePythonDependencyKey(entryKey);
    const locked = lockedVersionsByName.get(key);
    if (!locked) {
      // pdm: the key already names the version
      for (const fileEntry of entryValues) {
        addEntry(key, fileEntry);
      }
    } else if (locked.versions.size === 1) {
      const version = locked.versions.values().next().value;
      for (const fileEntry of entryValues) {
        addEntry(`${key} ${version}`, fileEntry);
      }
    } else {
      for (const fileEntry of entryValues) {
        const version = pythonDistributionFileVersion(
          derivePythonLockMetadataFileName(fileEntry),
          locked,
        );
        if (version !== undefined) {
          addEntry(`${key} ${version}`, fileEntry);
        }
      }
    }
  }
  return entriesByPackage;
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
      url: sanitizeBomUrl(fileEntry.url.trim()),
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
  return value
    .trim()
    .toLowerCase()
    .replaceAll(/[-_.]+/g, "-");
}

/**
 * The key an installed distribution and a lockfile entry are matched by: the
 * PEP 503 normalised name and the version.
 *
 * @param {Object} p Component with `name` and `version`
 * @returns {string|undefined} The key, or undefined without a name or version
 */
export function installedMetadataKey(p) {
  const name = normalizePep503Name(p?.name);
  const version = typeof p?.version === "string" ? p.version.trim() : "";
  return name && version ? `${name}@${version}` : undefined;
}

/**
 * Enrich lockfile entries from the installed distributions on this machine,
 * before PyPI is asked.
 *
 * Each entry of `installedMetadata` is a component as
 * {@link parseBdistMetadata} builds it from an installed `*.dist-info/METADATA`
 * file. An entry is matched to the lockfile component with the same PEP 503
 * normalised name and the same version, and fills the fields it lacks, so the
 * registry is left only what the installed distributions do not answer. An
 * installed release of another version describes a different release, so it
 * enriches nothing. The distributions enrich the entries in place; no new
 * components are created.
 *
 * @param {Object[]} pkgList Lockfile components, enriched in place
 * @param {Object[]} installedMetadata Components parsed from installed
 *   `*.dist-info/METADATA` files
 * @returns {Set<string>} The keys of the installations that enriched an entry,
 *   as {@link installedMetadataKey} builds them, so a caller that also walks
 *   the METADATA files can skip those as components
 */
export function enrichFromInstalledMetadata(pkgList, installedMetadata) {
  const byKey = new Map();
  for (const p of pkgList || []) {
    const key = installedMetadataKey(p);
    if (key && !byKey.has(key)) {
      byKey.set(key, p);
    }
  }
  const enriched = new Set();
  for (const md of installedMetadata || []) {
    const key = installedMetadataKey(md);
    const p = key ? byKey.get(key) : undefined;
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

// The interpreter cdxgen assumes for a lock file's environment. A marker that
// tests the implementation against it is decidable without a target machine.
const IMPLEMENTATION_CLAUSE_RE =
  /^(platform_python_implementation|implementation_name)\s*(==|!=)\s*(['"])([A-Za-z]+)\3$/;

function implementationClauseIsFalse(clause) {
  const match = IMPLEMENTATION_CLAUSE_RE.exec(clause.trim());
  if (!match) {
    return false;
  }
  const expected = match[1] === "implementation_name" ? "cpython" : "CPython";
  const equal = match[4] === expected;
  return match[2] === "==" ? !equal : equal;
}

/**
 * Whether an environment marker is false for every CPython interpreter. Only
 * `platform_python_implementation` and `implementation_name` clauses are
 * decided; anything else, or a marker with parentheses, is treated as possibly
 * true, so the answer errs towards keeping a package.
 *
 * @param {string} marker PEP 508 environment marker
 * @returns {boolean} true when no CPython environment satisfies the marker
 */
export function markerExcludesCPython(marker) {
  if (typeof marker !== "string" || !marker.trim() || /[()]/.test(marker)) {
    return false;
  }
  // Whitespace is collapsed first, as in parseReqEnvMarkers, so the operators
  // are split on as plain strings. A pattern such as `/\s+or\s+/` takes time
  // quadratic in the length of a whitespace run that no operator follows.
  return marker
    .replace(/\s+/g, " ")
    .split(" or ")
    .every((disjunct) =>
      disjunct.split(" and ").some(implementationClauseIsFalse),
    );
}

function recordMarkerEdge(markerEdges, depKey, apkgDep) {
  if (!depKey) {
    return;
  }
  const edge = markerEdges.get(depKey) || {
    total: 0,
    cpythonExcluded: 0,
    markers: new Set(),
  };
  edge.total += 1;
  const marker = typeof apkgDep === "object" ? apkgDep?.marker : undefined;
  if (typeof marker === "string" && marker.trim()) {
    edge.markers.add(marker.trim());
    if (markerExcludesCPython(marker)) {
      edge.cpythonExcluded += 1;
    }
  }
  markerEdges.set(depKey, edge);
}

/**
 * Parse a pyproject.toml at most once per cache.
 *
 * Any number of lock files (poetry.lock, pdm.lock, uv.lock and every
 * pylock.<name>.toml) can sit next to one pyproject.toml and each of them
 * reads it, so parsing the manifest again per lock file costs
 * lock files x manifest size for a tree the scanned project shapes.
 *
 * parsePyLockData() adds to the parent component it gets back, so each call
 * receives its own copy of that component. The key maps are only read.
 *
 * @param {string} pyProjectFile pyproject.toml file
 * @param {Map<string, Object>} [cache] Manifests already parsed, keyed by file
 * @returns {Object} What parsePyProjectTomlFile() returns for the file
 */
function parsePyProjectTomlFileOnce(pyProjectFile, cache) {
  if (!cache) {
    return parsePyProjectTomlFile(pyProjectFile);
  }
  let pyProjMap = cache.get(pyProjectFile);
  if (!pyProjMap) {
    pyProjMap = parsePyProjectTomlFile(pyProjectFile);
    cache.set(pyProjectFile, pyProjMap);
  }
  if (!pyProjMap.parentComponent) {
    return pyProjMap;
  }
  return {
    ...pyProjMap,
    parentComponent: structuredClone(pyProjMap.parentComponent),
  };
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
 * @param {Map<string, Object>} [options.pyProjectCache] pyproject.toml files
 *   already parsed, shared by the lock files of one scan so that each
 *   manifest is parsed once
 * @param {Map<string, string[]>} [options.workspaceFilesCache] Workspace
 *   member pyproject.toml files already found, keyed by the member pattern
 *   joined to the lock file directory, shared the same way
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
  // Incoming edges per dependency, with the environment markers they carry.
  const markerEdges = new Map();
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
    if (DEBUG_MODE && !options.pyProjectCache?.has(pyProjectFile)) {
      console.log(
        `Parsing ${pyProjectFile} for dependencies and groups information.`,
      );
    }
    const pyProjMap = parsePyProjectTomlFileOnce(
      pyProjectFile,
      options.pyProjectCache,
    );
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
        // The lock files next to one manifest all expand the same patterns
        const workspaceFilesKey = join(dirname(lockFile), awpath);
        let wpyprojfiles = options.workspaceFilesCache?.get(workspaceFilesKey);
        if (!wpyprojfiles) {
          wpyprojfiles = getAllFiles(dirname(lockFile), awpath);
          options.workspaceFilesCache?.set(workspaceFilesKey, wpyprojfiles);
        }
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
          if (DEBUG_MODE && !options.pyProjectCache?.has(awpyproj)) {
            console.log(
              `Parsing workspace ${awpyproj} to improve the dependency tree.`,
            );
          }
          // Nested workspace is not supported
          const wcompMap = parsePyProjectTomlFileOnce(
            awpyproj,
            options.pyProjectCache,
          );
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
      if (amember === parentComponent?.name) {
        continue;
      }
      // a lock file read without its pyproject.toml has no parent to hold
      // the members, which is said once for the whole lock file
      if (!parentComponent) {
        if (!workspaceWarningShown) {
          console.log(
            `The workspace members in ${lockFile || "the lock file"} are read without a pyproject.toml, so there is no project to list them under.`,
          );
          workspaceWarningShown = true;
        }
        continue;
      }
      if (workspaceComponentMap[amember]) {
        parentComponent.components = parentComponent.components || [];
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
  const metadataFileEntriesByPackage = indexPythonLockMetadataFileEntries(
    lockTomlObj,
    packageEntries,
  );
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
    // Each package takes its entries once, so a name and version that is
    // repeated does not get a second copy either.
    const metadataFilesKey = pythonLockMetadataFilesKey(pkg.name, pkg.version);
    const metadataFileEntries =
      metadataFileEntriesByPackage.get(metadataFilesKey) || [];
    metadataFileEntriesByPackage.delete(metadataFilesKey);
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
      // A package whose only dependencies are optional (urllib3 has no
      // required ones, only the `brotli`, `socks` and `zstd` extras) has no
      // `dependencies` key in uv.lock, but its extras are still edges.
      if (
        Array.isArray(apkg.dependencies) ||
        (!apkg.dependencies &&
          (devDependencies.length || optionalDependencies.length))
      ) {
        // pdm.lock files
        let allDeps = apkg.dependencies || [];
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
          recordMarkerEdge(markerEdges, depPkgRef || nameLower, apkgDep);
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
  // A package reached only through edges whose environment marker excludes
  // CPython (brotlicffi is `platform_python_implementation != 'CPython'`) is
  // not installed by a CPython environment built from this lock, so it is
  // optional rather than part of the CPython closure. A direct dependency of
  // the project is left alone: the manifest asked for it.
  for (const [depRef, edge] of markerEdges) {
    const dependentPkg = pkgBomRefMap[depRef];
    if (
      !dependentPkg ||
      !edge.total ||
      edge.cpythonExcluded !== edge.total ||
      directDepsKeys[normalizePythonDependencyKey(dependentPkg.name)]
    ) {
      continue;
    }
    dependentPkg.scope = "optional";
    dependentPkg.properties = dependentPkg.properties || [];
    dependentPkg.properties.push({
      name: "cdx:pip:markers",
      value: Array.from(edge.markers).sort().join(" or "),
    });
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
 * An exact PEP 440 version clause: `==` or `===` and a version with no
 * wildcard.
 *
 * Whitespace may separate the operator from the version, and a version may
 * carry a PEP 440 epoch (`1!2.0`) or a local version label (`2.1.0+cpu`).
 */
const PEP440_EXACT_CLAUSE = /^(===?)\s*([0-9A-Za-z._+!-]+)$/;

/**
 * Version a PEP 508 requirement pins: the version of its only exact clause.
 *
 * A requirement with no exact clause, a wildcard (`==1.2.*`) or more than one
 * exact clause pins no version, so a range such as `>=1.0,<2` gives null
 * rather than one of its bounds. Per-requirement options such as
 * `--config-settings` are not clauses.
 *
 * @param {String} versionSpecifiers Version specifiers of the requirement
 * @returns {String|null} The pinned version, or null
 */
function pinnedRequirementVersion(versionSpecifiers) {
  const specifiers = versionSpecifiers || "";
  const optionsIndex = specifiers.indexOf(" --");
  const clausesSource =
    optionsIndex === -1 ? specifiers : specifiers.substring(0, optionsIndex);
  let trimmed = clausesSource.trim();
  if (trimmed.startsWith("(") && trimmed.endsWith(")")) {
    trimmed = trimmed.substring(1, trimmed.length - 1);
  }
  const exactClauses = trimmed
    .split(",")
    .map((clause) => clause.trim().match(PEP440_EXACT_CLAUSE))
    .filter(Boolean);
  return exactClauses.length === 1 ? exactClauses[0][2] : null;
}

// A PEP 440 version specifier set, such as `>=2.0,<3`, `==1.4.*` or `(>=2.0)`.
const PEP440_SPECIFIER_SET =
  /^\(?\s*(?:===?|!=|~=|<=?|>=?)\s*[0-9A-Za-z._+!*-]+(?:\s*,\s*(?:===?|!=|~=|<=?|>=?)\s*[0-9A-Za-z._+!*-]+)*\s*\)?$/;

/**
 * The version specifier set of a requirement, without per-requirement
 * options such as `--config-settings`.
 *
 * What follows a package name on a requirement line is recorded only when it
 * is a specifier set. Anything else, such as the rest of a URL with its
 * credentials, stays out of the BOM.
 *
 * @param {string} versionSpecifiers Text after the name and extras
 * @returns {string|undefined} The specifier set, or undefined
 */
function requirementSpecifierSet(versionSpecifiers) {
  const specifiers = versionSpecifiers || "";
  const optionsIndex = specifiers.indexOf(" --");
  const clauses = (
    optionsIndex === -1 ? specifiers : specifiers.substring(0, optionsIndex)
  ).trim();
  return PEP440_SPECIFIER_SET.test(clauses) ? clauses : undefined;
}

/**
 * Method to parse requirements.txt file. This must be replaced with atom parsedeps.
 *
 * @param {String} reqFile Requirements.txt file
 * @param {Boolean} fetchDepsInfo Fetch dependencies info from pypi
 * @param {Object[]} [installedMetadata] Components parsed from the installed
 *   `*.dist-info/METADATA` files of this machine, which answer before PyPI
 *   is asked
 *
 * @returns {Promise[Array<Object>]} List of direct dependencies from the requirements file
 */
export async function parseReqFile(
  reqFile,
  fetchDepsInfo = false,
  installedMetadata = undefined,
) {
  return await parseReqData(reqFile, null, fetchDepsInfo, installedMetadata);
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

// The largest requirements file read.
const MAX_REQUIREMENTS_FILE_BYTES = 16 * 1024 * 1024;

/**
 * Method to parse requirements.txt file. Must only be used internally.
 *
 * @param {String} reqFile Requirements.txt file
 * @param {Object} reqData Requirements.txt data for internal invocations from setup.py file etc.
 * @param {Boolean} fetchDepsInfo Fetch dependencies info from pypi
 * @param {Object[]} [installedMetadata] Components parsed from the installed
 *   `*.dist-info/METADATA` files of this machine, which answer before PyPI
 *   is asked
 * @returns {Promise<Array<Object>>} List of direct dependencies from the requirements file
 */
async function parseReqData(
  reqFile,
  reqData = null,
  fetchDepsInfo = false,
  installedMetadata = undefined,
) {
  const pkgList = [];
  let compScope;
  if (!reqFile && !reqData) {
    console.warn(
      "Either the requirements file or the data needs to be provided for parsing.",
    );
    return pkgList;
  }
  if (!reqData) {
    // The path may be a link inside the scanned tree; its target must be a
    // regular file within the size bound.
    let realReqFile;
    try {
      realReqFile = realpathSync(reqFile);
    } catch (_err) {
      return pkgList;
    }
    reqData = readRegularTextFile(realReqFile, MAX_REQUIREMENTS_FILE_BYTES);
    if (reqData === undefined) {
      return pkgList;
    }
  }
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
    // A line that starts with an option once the backslashes are gone, such
    // as `\--log=x`, names no package.
    if (!l || l.startsWith("-")) {
      continue;
    }
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
    // A requirement that is only a url, a vcs url or a path names no package
    // (`https://host/x.whl`, `git+https://host/repo.git`, `./libs/foo`).
    if (classifyPythonManifestSourceValue(l) || URL_SCHEME_PATTERN.test(l)) {
      continue;
    }

    // Handle extras (e.g., package[extra1,extra2])
    let extras = null;
    const extrasMatch = l.match(/^([a-zA-Z0-9_\-.]+)(\s*\[([^\]]+)])?(.*)$/);
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
      const version = pinnedRequirementVersion(versionSpecifiers);
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
      const specifierSet = requirementSpecifierSet(versionSpecifiers);
      if (specifierSet && (!version || !specifierSet.startsWith("=="))) {
        properties.push({
          name: "cdx:pypi:versionSpecifiers",
          value: specifierSet,
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
      const version = pinnedRequirementVersion(versionSpecifiers);
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
      const specifierSet = requirementSpecifierSet(versionSpecifiers);
      if (specifierSet && (!version || !specifierSet.startsWith("=="))) {
        properties.push({
          name: "cdx:pypi:versionSpecifiers",
          value: specifierSet,
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
  // The installed distributions answer first, so PyPI is asked only about
  // the packages they do not cover.
  enrichFromInstalledMetadata(pkgList, installedMetadata);
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
 * Decode a percent-encoded path segment or filename, keeping the encoded form
 * when it is not valid encoding. Lock files and records are untrusted input,
 * and a stray percent sign must not abort the scan.
 *
 * @param {string} value Encoded value
 * @returns {string} The decoded value, or the input unchanged
 */
function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Split a conda artifact filename into the name, version, build string and
 * package type it encodes.
 *
 * A conda filename is `<name>-<version>-<build>.<conda|tar.bz2>`, and both the
 * name and the build string can contain hyphens
 * (`python-flatbuffers-1.0-py312_0.conda`,
 * `python-3.12.7-h9e4cc4f_0_cpython.conda`). The version is the only part
 * that always starts with a digit, so the name ends at the first hyphen
 * followed by a digit, the version at the next hyphen, and whatever follows
 * is the build. rattler derives the same three fields this way when a pixi.lock
 * location has to stand in for the name, version and build fields a v6 or v7
 * lock no longer writes.
 *
 * @param {string} filename Artifact filename, e.g. `numpy-2.5.4-py315h39cfc7d_0.conda`
 * @returns {{name: string, version: string, build: string|undefined, type: string|undefined}|undefined}
 *   The parsed fields, or undefined when the filename is not a conda artifact
 */
export function parseCondaArtifactFilename(filename) {
  if (typeof filename !== "string" || !filename.trim()) {
    return undefined;
  }
  let stem = filename;
  let type;
  if (stem.toLowerCase().endsWith(".conda")) {
    type = "conda";
    stem = stem.slice(0, -6);
  } else if (stem.toLowerCase().endsWith(".tar.bz2")) {
    type = "tar.bz2";
    stem = stem.slice(0, -8);
  }
  // The name ends at the first hyphen whose next character is a digit, which
  // is where the version starts.
  let nameEnd = -1;
  for (let i = 0; i < stem.length - 1; i += 1) {
    if (stem[i] === "-" && stem[i + 1] >= "0" && stem[i + 1] <= "9") {
      nameEnd = i;
      break;
    }
  }
  if (nameEnd <= 0) {
    return undefined;
  }
  const name = stem.slice(0, nameEnd);
  const rest = stem.slice(nameEnd + 1);
  const buildStart = rest.indexOf("-");
  if (buildStart === -1) {
    return { name, version: rest, build: undefined, type };
  }
  return {
    name,
    version: rest.slice(0, buildStart),
    build: rest.slice(buildStart + 1),
    type,
  };
}

/**
 * The platform subdirs conda serves. A conda channel serves packages from its
 * subdir directory, so the segment before the filename is the subdir even
 * when its name is not on this list: the NVIDIA channel's `linux-cos7-64` is
 * as much a platform as `linux-64`. A segment with no digit at all (a
 * `downloads` folder on an arbitrary web server) is not a platform token and
 * belongs to the channel name instead, so the qualifier can only be missed
 * for a digit-free path, never invented for one.
 */
const CONDA_SUBDIR_RE =
  /^(?:noarch|any|(?:linux|osx|win|zos|emscripten|wasi|freebsd)-(?:64|32|arm64|aarch64|armv6l|armv7l|ppc64|ppc64le|s390x|riscv32|riscv64|loongarch32|loongarch64|wasm32|z))$/i;

/**
 * Derive the conda channel name and platform subdir a package location
 * carries. The location is a repository url in every lock and conda-meta
 * record cdxgen reads; pixi.lock v7 also allows file paths, which encode
 * neither field.
 *
 * The channel qualifier holds the canonical channel name (conda-forge, main),
 * never the host: `conda.anaconda.org/<channel>/...` keeps the channel in its
 * path, and `repo.anaconda.com/pkgs/<channel>/...` after the `pkgs` prefix.
 * The subdir is the path segment before the filename, `noarch` included.
 *
 * @param {string} location Package url from a lock file or conda-meta record
 * @returns {{channel: string|undefined, subdir: string|undefined}} The derived
 *   fields; both undefined when the location carries neither
 */
export function condaChannelAndSubdir(location) {
  if (typeof location !== "string" || !location.trim()) {
    return { channel: undefined, subdir: undefined };
  }
  let parsed;
  try {
    parsed = new URL(location);
  } catch {
    return { channel: undefined, subdir: undefined };
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { channel: undefined, subdir: undefined };
  }
  const segments = parsed.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => safeDecodeURIComponent(segment));
  // A private anaconda.org channel carries its access token in /t/<token>/.
  if (segments[0] === "t" && segments.length > 4) {
    segments.splice(0, 2);
  }
  segments.pop();
  if (!segments.length) {
    return { channel: undefined, subdir: undefined };
  }
  const parent = segments[segments.length - 1];
  const subdir = CONDA_SUBDIR_RE.test(parent)
    ? parent.toLowerCase()
    : /\d/.test(parent)
      ? parent.toLowerCase()
      : undefined;
  let channelSegments = subdir ? segments.slice(0, -1) : segments;
  if (parsed.host === "repo.anaconda.com" && channelSegments[0] === "pkgs") {
    channelSegments = channelSegments.slice(1);
  }
  return {
    channel: channelSegments.join("/") || undefined,
    subdir,
  };
}

/**
 * Canonicalise a channel value as conda records it. conda-meta records of a
 * defaults environment and older conda versions write the channel as a url
 * (`https://conda.anaconda.org/conda-forge/`) or as `pkgs/main`; the qualifier
 * holds the canonical name either way.
 *
 * @param {unknown} channel Channel field from a conda or pixi record
 * @returns {string|undefined} Canonical channel name
 */
function condaCanonicalChannel(channel) {
  if (typeof channel !== "string" || !channel.trim()) {
    return undefined;
  }
  const trimmed = channel.trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(trimmed)) {
    return condaChannelAndSubdir(trimmed).channel;
  }
  return trimmed.replace(/^pkgs\//, "");
}

/**
 * Build a canonical conda purl from the fields the purl-spec conda type
 * defines: a required name, an optional version, and the optional `build`,
 * `channel`, `subdir` and `type` qualifiers. The build string stays a
 * qualifier and out of the version, matching the canonical purl-spec example
 * (`pkg:conda/absl-py@0.4.1?build=py36h06a4308_0&channel=main&subdir=linux-64&type=tar.bz2`)
 * and ecosystem practice (conda's conda-sboms plugin, pixi-sbom). The conda
 * type defines no name normalisation of its own, so names are kept as written.
 *
 * @param {{name: string, version?: string, build?: string, channel?: string, subdir?: string, type?: string}} fields
 * @returns {string|null} Canonical purl, or null when the parts are invalid
 */
export function condaPurl(fields = {}) {
  const qualifiers = {};
  if (fields.build) {
    qualifiers.build = fields.build;
  }
  if (fields.channel) {
    qualifiers.channel = fields.channel;
  }
  if (fields.subdir) {
    qualifiers.subdir = fields.subdir;
  }
  if (fields.type) {
    qualifiers.type = fields.type;
  }
  return tryBuildPurl({
    type: "conda",
    name: fields.name,
    version: fields.version || undefined,
    qualifiers: Object.keys(qualifiers).length ? qualifiers : undefined,
  });
}

/**
 * Turn a conda license value into CycloneDX licence objects. Conda records
 * carry SPDX ids and expressions (`BSD-3-Clause`,
 * `Apache-2.0 WITH LLVM-exception`) but also names no SPDX list holds
 * (`blessing`, `TCL`); anything the SPDX parser accepts travels as an
 * expression and the rest as a license name, the same rule a dist-info
 * `License-Expression` follows.
 *
 * @param {unknown} license License field from a conda or pixi record
 * @returns {Array<Object>|undefined} CycloneDX licenses, or undefined
 */
function condaLicenseObjects(license) {
  if (typeof license !== "string" || !license.trim()) {
    return undefined;
  }
  const trimmed = license.trim();
  // A pixi.lock v5 record stringifies an absent license as the literal
  // "None", which is not a licence.
  if (/^none$/i.test(trimmed)) {
    return undefined;
  }
  if (parseSpdxExpression(trimmed).valid) {
    return [{ expression: trimmed }];
  }
  return [{ license: { name: trimmed } }];
}

/**
 * CycloneDX hashes for the checksums a conda artifact ships.
 *
 * @param {string} [sha256] SHA-256 as hex
 * @param {string} [md5] MD5 as hex
 * @returns {Array<Object>|undefined} Hashes, or undefined without any
 */
function condaHashes(sha256, md5) {
  const hashes = [];
  if (typeof sha256 === "string" && /^[a-fA-F0-9]{64}$/.test(sha256)) {
    hashes.push({ alg: "SHA-256", content: sha256.toLowerCase() });
  }
  if (typeof md5 === "string" && /^[a-fA-F0-9]{32}$/.test(md5)) {
    hashes.push({ alg: "MD5", content: md5.toLowerCase() });
  }
  return hashes.length ? hashes : undefined;
}

/**
 * The newest pixi.lock file format version this parser knows. Lock versions
 * 5, 6 and 7 are in the wild today, and the older flat record shape this
 * parser also accepts covers versions 1 to 5, so a lock is only rejected as
 * too new above this number.
 */
const PIXI_LOCK_MAX_VERSION = 7;

/**
 * Return the download url of a pixi.lock package, without credentials, query
 * or fragment. A private conda channel can carry its access token in a
 * `/t/<token>/` path segment, so such a url is left out.
 *
 * @param {unknown} url Package url from pixi.lock
 * @returns {string|undefined} Distribution url
 */
function pixiDistributionUrl(url) {
  if (typeof url !== "string" || !url.trim()) {
    return undefined;
  }
  const sanitized = sanitizeBomUrl(url);
  try {
    const parsed = new URL(sanitized);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.pathname.split("/").includes("t")
    ) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return sanitized;
}

/**
 * Normalise one pixi.lock package record into the fields a component needs.
 *
 * A lock from format version 6 on keys every record by its origin (its `kind`
 * merged with the location: `- conda: <url>`, `- pypi: <url>`; rattler's
 * `file_format_version.rs`), and leaves name, version, build and subdir to be
 * derived from the location. Older locks write a flat record with `kind`,
 * `name`, `version` and `url` fields. Source records (`conda_source`,
 * `pypi_source`) are built from a local path rather than resolved from a
 * repository, so they carry no channel, subdir or checksums.
 *
 * A v6-plus lock also writes a `purls` field on conda packages that PyPI maps
 * (`pkg:pypi/numpy?source=compressed-mapping`). Those purls describe the
 * PyPI mapping, never the conda artifact, so the field is not read.
 *
 * @param {Object} entry A `packages` list entry of a pixi.lock file
 * @returns {{kind: string, location: string|undefined, name: string, version: string,
 *   build: string|undefined, buildNumber: string|number|undefined, subdir: string|undefined,
 *   channel: string|undefined, type: string|undefined, sha256: string|undefined,
 *   md5: string|undefined, license: string|undefined, depends: string[]}|undefined}
 *   The normalised record, or undefined when the entry identifies no package
 */
function normalizePixiPackage(entry) {
  if (!entry || typeof entry !== "object") {
    return undefined;
  }
  let kind;
  let location;
  for (const key of ["conda", "conda_source", "pypi", "pypi_source"]) {
    if (typeof entry[key] === "string") {
      kind = key.replace("_source", "");
      location = entry[key];
      break;
    }
  }
  if (!kind) {
    // The pre-v6 flat record carries the kind in a field and the location in
    // `url`. `pip` is the pre-v3 spelling of `pypi`.
    const entryKind =
      entry["kind"] === "pip" || entry["kind"] === "pypi"
        ? "pypi"
        : entry["kind"];
    if (entryKind !== "conda" && entryKind !== "pypi") {
      return undefined;
    }
    kind = entryKind;
    location = typeof entry["url"] === "string" ? entry["url"] : undefined;
  }

  let name = typeof entry["name"] === "string" ? entry["name"] : undefined;
  let version =
    typeof entry["version"] === "string" || typeof entry["version"] === "number"
      ? `${entry["version"]}`
      : undefined;
  let build =
    typeof entry["build"] === "string" || typeof entry["build"] === "number"
      ? `${entry["build"]}`
      : undefined;
  let subdir =
    typeof entry["subdir"] === "string" ? entry["subdir"] : undefined;
  let channel = condaCanonicalChannel(entry["channel"]);
  let type;

  if (kind === "conda") {
    // A v6 or v7 conda record names no name, version or build of its own:
    // they are derived from the artifact filename, and the channel and subdir
    // from the repository url.
    const filename = location
      ? location.split("?")[0].split("/").pop()
      : undefined;
    const artifact = filename
      ? parseCondaArtifactFilename(safeDecodeURIComponent(filename))
      : undefined;
    name = name || artifact?.name;
    version = version || artifact?.version;
    build = build || artifact?.build;
    type = artifact?.type;
    const fromLocation = condaChannelAndSubdir(location);
    channel = channel || fromLocation.channel;
    subdir = subdir || fromLocation.subdir;
  }
  if (!name || !version) {
    // A record without an identity (a source record the lock spells no
    // version for) describes nothing a component could be built from.
    return undefined;
  }
  return {
    kind,
    location,
    name,
    version,
    build,
    buildNumber: entry["build_number"],
    subdir,
    channel,
    type,
    sha256: typeof entry["sha256"] === "string" ? entry["sha256"] : undefined,
    md5: typeof entry["md5"] === "string" ? entry["md5"] : undefined,
    license:
      typeof entry["license"] === "string" ? entry["license"] : undefined,
    depends: Array.isArray(entry["depends"]) ? entry["depends"] : [],
  };
}

/**
 * Build the component of one normalised pixi.lock record.
 *
 * Conda entries become `pkg:conda` purls with the build, channel, subdir and
 * type qualifiers, and pypi entries stay `pkg:pypi`. The purl type follows
 * the artifact's repository, never the installer, which is the answer the
 * purl maintainers gave to the pkg:pypi versus pkg:conda collision question
 * (package-url/purl-spec discussion 473, opened from cdxgen issue 1809).
 *
 * @param {Object} pkg Normalised record from {@link normalizePixiPackage}
 * @param {string} evidenceValue Evidence method value for the lock's environment
 * @returns {Object} Component for `pkgList`
 */
function pixiComponent(pkg, evidenceValue) {
  const component = {
    name: pkg.kind === "pypi" ? pkg.name.toLowerCase() : pkg.name,
    version: pkg.version,
    type: "library",
    evidence: {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "instrumentation",
            confidence: 1,
            value: evidenceValue,
          },
        ],
      },
    },
  };
  const distributionUrl = pixiDistributionUrl(pkg.location);
  if (distributionUrl) {
    // The package download url becomes a distribution external reference.
    component.distribution = { url: distributionUrl };
  }
  const hashes = condaHashes(pkg.sha256, pkg.md5);
  if (hashes) {
    component.hashes = hashes;
  }
  const licenses = condaLicenseObjects(pkg.license);
  if (licenses) {
    component.licenses = licenses;
  }
  const properties = [];
  if (pkg.subdir) {
    properties.push({ name: "cdx:pixi:operating_system", value: pkg.subdir });
  }
  if (pkg.buildNumber !== undefined && pkg.buildNumber !== null) {
    properties.push({
      name: "cdx:pixi:build_number",
      value: `${pkg.buildNumber}`,
    });
  }
  if (pkg.build) {
    // The conda build string is not a supplier, so it stays a property.
    properties.push({ name: "cdx:pixi:build", value: pkg.build });
  }
  if (properties.length) {
    component.properties = properties;
  }
  const purl =
    pkg.kind === "conda"
      ? condaPurl({
          name: pkg.name,
          version: pkg.version,
          build: pkg.build,
          channel: pkg.channel,
          subdir: pkg.subdir,
          type: pkg.type,
        })
      : // The pypi type applies the PEP 503 name normalisation, so the purl
        // and the component name agree on the lowercased name.
        pypiPurl(component.name, pkg.version);
  return applyPurl(component, purl, `library:${pkg.name}:${pkg.version}`);
}

/**
 * Method to parse pixi.lock data.
 *
 * Lock format versions 5, 6 and 7 are accepted, and the flat package records
 * of versions up to 5 keep working. The packages of every environment in the
 * `environments` section are selected (any environment, any platform,
 * deduplicated by location); without that section the flat package list is
 * used. Conda entries become `pkg:conda` components and pypi entries
 * `pkg:pypi` components, with the conda dependency graph following each
 * entry's `depends` resolved by name.
 *
 * @param {String} pixiLockFileName  pixi.lock file name
 * @param {String} path File path
 */
export function parsePixiLockFile(pixiLockFileName, path) {
  const pixiFileData = readFileSync(pixiLockFileName, { encoding: "utf-8" });
  const pixiLockData = _load(pixiFileData);
  const evidenceBasePath = path ?? dirname(pixiLockFileName);
  const evidenceValue = `${evidenceBasePath}/.pixi/envs/default`;

  const pkgList = [];
  const formulationList = [];
  const rootList = [];
  const dependenciesList = [];
  // we do not set false because we have assumed that pixi lock is accurate
  const frozen = true;

  const lockVersion = Number(pixiLockData["version"]);
  if (lockVersion > PIXI_LOCK_MAX_VERSION) {
    // A newer pixi wrote this lock; its records are parsed on a best effort
    // rather than silently, but the shapes may have changed again.
    console.log(
      `pixi.lock version ${pixiLockData["version"]} is newer than the latest supported version ${PIXI_LOCK_MAX_VERSION}; parsing it on a best effort.`,
    );
  }

  const rawPackages = Array.isArray(pixiLockData["packages"])
    ? pixiLockData["packages"]
    : [];
  const packagesByLocation = new Map();
  const normalizedPackages = [];
  for (const entry of rawPackages) {
    const pkg = normalizePixiPackage(entry);
    if (!pkg) {
      continue;
    }
    normalizedPackages.push(pkg);
    if (pkg.location) {
      if (!packagesByLocation.has(pkg.location)) {
        packagesByLocation.set(pkg.location, pkg);
      }
    }
  }

  // The environments section holds the resolved per-platform package lists as
  // locations, which select the records the components are built from.
  const selected = new Set();
  const environments = pixiLockData["environments"];
  if (environments && typeof environments === "object") {
    for (const environment of Object.values(environments)) {
      const platformLists = environment?.packages;
      if (!platformLists || typeof platformLists !== "object") {
        continue;
      }
      for (const entries of Object.values(platformLists)) {
        if (!Array.isArray(entries)) {
          continue;
        }
        for (const selector of entries) {
          if (!selector || typeof selector !== "object") {
            continue;
          }
          for (const key of ["conda", "conda_source", "pypi", "pypi_source"]) {
            if (typeof selector[key] === "string") {
              selected.add(selector[key]);
            }
          }
        }
      }
    }
  }

  const chosen = selected.size
    ? [...selected]
        .map((location) => packagesByLocation.get(location))
        .filter(Boolean)
    : normalizedPackages;

  const condaRefsByName = new Map();
  const componentsOf = new Map();
  for (const pkg of chosen) {
    const component = pixiComponent(pkg, evidenceValue);
    pkgList.push(component);
    componentsOf.set(pkg, component);
    if (pkg.kind === "conda") {
      if (!condaRefsByName.has(pkg.name)) {
        condaRefsByName.set(pkg.name, new Set());
      }
      condaRefsByName.get(pkg.name).add(component["bom-ref"]);
    }
  }

  for (const pkg of chosen) {
    if (pkg.kind !== "conda" || !pkg.depends.length) {
      continue;
    }
    const dependsOn = new Set();
    for (const dependency of pkg.depends) {
      // A conda matchspec starts with the package name; virtual packages
      // (`__unix`, `__osx`) describe the platform, not a package in the lock.
      const dependencyName = `${dependency}`.trim().split(/\s+/)[0];
      if (!dependencyName || dependencyName.startsWith("__")) {
        continue;
      }
      for (const ref of condaRefsByName.get(dependencyName) || []) {
        dependsOn.add(ref);
      }
    }
    dependenciesList.push({
      ref: componentsOf.get(pkg)["bom-ref"],
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
 * Read the `.dist-info/INSTALLER` file of an installed distribution.
 *
 * The file names the tool that installed the distribution (packaging
 * specification "Recording installed projects"): conda-build and
 * rattler-build write `conda` into it at package build time, pip writes
 * `pip`, pixi writes `uv-pixi`. conda itself never writes it at install time,
 * so an absent file says nothing.
 *
 * @param {string} distInfoDir The `*.dist-info` directory
 * @returns {string|undefined} The installer name, or undefined without the file
 */
export function readDistInfoInstaller(distInfoDir) {
  try {
    const installer = readFileSync(join(distInfoDir, "INSTALLER"), {
      encoding: "utf-8",
    });
    const trimmed = installer.trim();
    return trimmed || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The installed distributions their environment's conda-meta records already
 * describe, so they must not also be emitted as PyPI components.
 *
 * A distribution is attributed to a conda record when both live in the same
 * conda environment (the conda-meta directory's parent) and carry the same
 * PEP 503 normalised name and version, and its INSTALLER file either names
 * `conda` or is absent. Any other installer value (`pip`, `uv`, `uv-pixi`)
 * means a different tool installed or reinstalled the distribution, so it
 * stays a PyPI component even when a conda package of the same name exists.
 *
 * @param {string[]} metadataFiles The installed dist-info METADATA files,
 *   in the order their parse results are passed in `installedLists`
 * @param {Array<Object[]>} installedLists The parse results of `metadataFiles`
 *   as parseBdistMetadata returns them
 * @param {Map<string, Set<string>>} condaEnvKeys Environment prefix to the
 *   {@link installedMetadataKey} keys of its conda-meta records
 * @returns {Set<string>} The keys of the distributions attributed to a conda
 *   record
 */
export function condaAttributedKeys(
  metadataFiles,
  installedLists,
  condaEnvKeys,
) {
  const claimed = new Set();
  if (
    !Array.isArray(metadataFiles) ||
    !Array.isArray(installedLists) ||
    !condaEnvKeys?.size
  ) {
    return claimed;
  }
  // Longest prefix first, so nested environments resolve to their own records.
  const prefixes = [...condaEnvKeys.keys()].sort((a, b) => b.length - a.length);
  for (let i = 0; i < metadataFiles.length; i += 1) {
    const key = installedMetadataKey(installedLists[i]?.[0]);
    if (!key) {
      continue;
    }
    const prefix = prefixes.find((candidate) =>
      metadataFiles[i].startsWith(`${candidate}${sep}`),
    );
    if (!prefix || !condaEnvKeys.get(prefix)?.has(key)) {
      continue;
    }
    const installer = readDistInfoInstaller(dirname(metadataFiles[i]));
    if (installer === undefined || installer.toLowerCase() === "conda") {
      claimed.add(key);
    }
  }
  return claimed;
}

/**
 * Build the component of one conda-meta record.
 *
 * A conda-meta `<name>-<version>-<build>.json` record is conda's PrefixRecord
 * for an installed conda package (conda's `conda/models/records.py`); a
 * pip-installed package never gets one. It carries the purl fields and the
 * sha256 checksum and license of the artifact the environment installed.
 *
 * @param {Object} record A parsed conda-meta record
 * @param {string} condaMetaFile The record's file path
 * @returns {Object|undefined} Component, or undefined without name or version
 */
function condaMetaRecordComponent(record, condaMetaFile) {
  if (!record?.name || !record?.version) {
    return undefined;
  }
  const location =
    typeof record["url"] === "string"
      ? record["url"]
      : typeof record["fn"] === "string"
        ? record["fn"]
        : undefined;
  const artifact = location
    ? parseCondaArtifactFilename(
        safeDecodeURIComponent(location.split("?")[0].split("/").pop()),
      )
    : undefined;
  const fromLocation = condaChannelAndSubdir(location);
  const component = {
    name: record["name"],
    version: `${record["version"]}`,
    type: "library",
    evidence: {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "instrumentation",
            confidence: 1,
            value: condaMetaFile,
          },
        ],
      },
    },
    properties: [{ name: "internal:SrcFile", value: condaMetaFile }],
  };
  // The sha256 checksum pins the artifact; records predating sha256 keep
  // their md5.
  const hashes = condaHashes(
    record["sha256"] || undefined,
    record["sha256"] ? undefined : record["md5"] || undefined,
  );
  if (hashes) {
    component.hashes = hashes;
  }
  const licenses = condaLicenseObjects(record["license"]);
  if (licenses) {
    component.licenses = licenses;
  }
  const purl = condaPurl({
    name: record["name"],
    version: `${record["version"]}`,
    build:
      typeof record["build"] === "string" ? record["build"] : artifact?.build,
    channel: condaCanonicalChannel(record["channel"]) || fromLocation.channel,
    subdir:
      typeof record["subdir"] === "string"
        ? record["subdir"]
        : fromLocation.subdir,
    type: artifact?.type,
  });
  return applyPurl(
    component,
    purl,
    `library:${record["name"]}:${record["version"]}`,
  );
}

/**
 * Parse the conda-meta records of installed conda environments.
 *
 * Every record becomes a `pkg:conda` component with its sha256 hash and
 * license, and its `depends` list feeds the dependency graph (virtual
 * packages excluded). The keys of each environment's records are also
 * returned, keyed by the environment prefix, so a caller that also collects
 * the site-packages distributions of the same tree can attribute the ones
 * conda installed (see {@link condaAttributedKeys}).
 *
 * @param {string[]} condaMetaFiles conda-meta record files
 * @returns {{pkgList: Object[], dependenciesList: Object[], envKeys: Map<string, Set<string>>}}
 */
export function parseCondaMetaRecords(condaMetaFiles) {
  const pkgList = [];
  const dependenciesList = [];
  const envKeys = new Map();
  const refsByName = new Map();
  const parsedRecords = [];
  for (const condaMetaFile of condaMetaFiles || []) {
    let record;
    try {
      record = JSON.parse(readFileSync(condaMetaFile, { encoding: "utf-8" }));
    } catch (err) {
      if (DEBUG_MODE) {
        console.log(
          `Error parsing the conda-meta record ${condaMetaFile}.`,
          err,
        );
      }
      continue;
    }
    const component = condaMetaRecordComponent(record, condaMetaFile);
    if (!component) {
      continue;
    }
    pkgList.push(component);
    parsedRecords.push({ component, depends: record["depends"] });
    // The environment prefix is the parent of its conda-meta directory.
    const envPrefix = dirname(dirname(condaMetaFile));
    if (!envKeys.has(envPrefix)) {
      envKeys.set(envPrefix, new Set());
    }
    const key = installedMetadataKey(component);
    if (key) {
      envKeys.get(envPrefix).add(key);
    }
    if (!refsByName.has(component.name)) {
      refsByName.set(component.name, new Set());
    }
    refsByName.get(component.name).add(component["bom-ref"]);
  }
  for (const { component, depends } of parsedRecords) {
    if (!Array.isArray(depends)) {
      continue;
    }
    const dependsOn = new Set();
    for (const dependency of depends) {
      const dependencyName = `${dependency}`.trim().split(/\s+/)[0];
      if (!dependencyName || dependencyName.startsWith("__")) {
        continue;
      }
      for (const ref of refsByName.get(dependencyName) || []) {
        dependsOn.add(ref);
      }
    }
    if (dependsOn.size) {
      dependenciesList.push({
        ref: component["bom-ref"],
        dependsOn: [...dependsOn].sort(),
      });
    }
  }
  return { pkgList, dependenciesList, envKeys };
}

/**
 * Drop the conda components an environment file declared when the installed
 * environment also records them.
 *
 * A scan root can hold both: the environment.yml the project declares and a
 * conda-meta record of the same package the environment installed. They are
 * one artifact seen twice, and the record is the better half of the pair,
 * because it carries the build, the hashes and the license, so the declared
 * component goes, pinned or not.
 *
 * @param {Object[]} pkgList Components collected so far
 * @param {Object[]} condaMetaPkgList Components built from conda-meta records
 * @param {string[]} envYmlFiles The environment files the scan read
 * @returns {Object[]} The component list without the shadowed declarations
 */
export function dropEnvYmlCondaDuplicates(
  pkgList,
  condaMetaPkgList,
  envYmlFiles,
) {
  if (!condaMetaPkgList?.length || !envYmlFiles?.length) {
    return pkgList;
  }
  const installedVersionsByName = new Map();
  for (const component of condaMetaPkgList) {
    if (!installedVersionsByName.has(component.name)) {
      installedVersionsByName.set(component.name, new Set());
    }
    installedVersionsByName.get(component.name).add(component.version);
  }
  const envYmlSrcFiles = new Set(envYmlFiles);
  return (pkgList || []).filter((component) => {
    if (!component?.purl?.startsWith("pkg:conda/")) {
      return true;
    }
    const srcFile = (component.properties || []).find(
      (property) => property?.name === "internal:SrcFile",
    )?.value;
    if (!envYmlSrcFiles.has(srcFile)) {
      return true;
    }
    const installedVersions = installedVersionsByName.get(component.name);
    return !(
      installedVersions &&
      (component.version === undefined ||
        installedVersions.has(component.version))
    );
  });
}

/**
 * Parse the name, pinned version and build of a conda matchspec from an
 * environment file dependency entry.
 *
 * A pinned entry (`python=3.12`, `python==3.12.7`, `python=3.12.7=h9e4cc4f_0_cpython`)
 * carries one concrete version and an optional build; anything else (a range,
 * a wildcard, a bare name) pins nothing. The `channel::` prefix is handled by
 * the caller, which needs it as the channel qualifier.
 *
 * @param {string} spec A dependency entry with any channel prefix removed
 * @returns {{name: string|undefined, version: string|undefined, build: string|undefined}}
 *   The name always, the version and build only when pinned
 */
function parseCondaMatchSpec(spec) {
  const nameMatch = /^([A-Za-z0-9_.\-]+)/.exec(spec.trim());
  if (!nameMatch) {
    return { name: undefined, version: undefined, build: undefined };
  }
  const name = nameMatch[1];
  const rest = spec.trim().slice(name.length).trim();
  // `=3.9`, `==1.4.4`, and version-with-build `=1.3.1=hcb275e0_0`; a range
  // or wildcard starts with another character and never matches.
  const versionMatch = /^(==?)\s*([^\s=]+)(?:=([^\s=]+))?$/.exec(rest);
  let version;
  let build;
  if (versionMatch) {
    version = versionMatch[2];
    build = versionMatch[3];
  }
  // A single concrete version starts with a digit and carries no specifier
  // characters; `1.21.*` is a wildcard and `>=1.0` never reaches here.
  if (version && !(/^\d/.test(version) && /^[A-Za-z0-9_.+]+$/.test(version))) {
    version = undefined;
    build = undefined;
  }
  return { name, version, build };
}

/**
 * A pip dependency entry cdxgen cannot name: a url (any scheme), a path, an
 * editable install or an option flag. The requirements parser would invent a
 * component name out of such an entry, so it is skipped instead. A path can
 * also arrive without any prefix (`dist/local-wheel-1.0-py3-none-any.whl`),
 * so any entry carrying a separator is one.
 */
const NON_SPEC_PIP_REQUIREMENT_RE =
  /^(?:[a-z][a-z0-9+.-]*:\/\/|.*[\\/]|-e\b|--editable\b|-[-a-z])/i;

/**
 * Method to parse conda environment files (`environment.yml`).
 *
 * Every `dependencies` entry that is not the nested pip mapping is a conda
 * dependency: a `channel::` prefix becomes the channel qualifier, and the
 * `channels` list feeds it for entries without their own when it holds
 * exactly one channel. A pinned version becomes the purl version; anything
 * else (a range, a wildcard, a bare name) omits the version, which the conda
 * purl type allows, and records the full spec in a `cdx:conda:spec` property.
 * The nested `pip:` list becomes `pkg:pypi` components through the
 * requirements parser, minus the entries that are urls, paths or editable
 * installs.
 *
 * @param {String} environmentYmlFile environment.yml file name
 * @returns {Promise<{pkgList: Object[]}>} The parsed components
 */
export async function parseEnvironmentYmlFile(environmentYmlFile) {
  const pkgList = [];
  let envData;
  try {
    envData = _load(readFileSync(environmentYmlFile, { encoding: "utf-8" }));
  } catch (err) {
    console.log(
      `Error while parsing the environment file ${environmentYmlFile}.`,
      err,
    );
    return { pkgList };
  }
  const dependencies = Array.isArray(envData?.dependencies)
    ? envData.dependencies
    : [];
  const channels = Array.isArray(envData?.channels)
    ? envData.channels.filter((channel) => typeof channel === "string")
    : [];
  // A dependency without its own channel inherits the file's only when the
  // file leaves no choice between several.
  const defaultChannel =
    channels.length === 1
      ? condaCanonicalChannel(channels[0]) || channels[0].trim()
      : undefined;

  const pipRequirements = [];
  for (const dependency of dependencies) {
    if (dependency && typeof dependency === "object") {
      // The nested pip mapping is the one object a dependencies list holds.
      if (Array.isArray(dependency["pip"])) {
        for (const requirement of dependency["pip"]) {
          if (
            typeof requirement === "string" &&
            !NON_SPEC_PIP_REQUIREMENT_RE.test(requirement.trim())
          ) {
            pipRequirements.push(requirement.trim());
          }
        }
      }
      continue;
    }
    if (typeof dependency !== "string" || !dependency.trim()) {
      continue;
    }
    let spec = dependency.trim();
    let channel;
    const channelSplit = spec.split("::");
    if (channelSplit.length > 1) {
      channel = condaCanonicalChannel(channelSplit[0]) || channelSplit[0];
      spec = channelSplit.slice(1).join("::").trim();
    }
    const { name, version, build } = parseCondaMatchSpec(spec);
    if (!name) {
      continue;
    }
    // `pip` as a conda dependency is the conda package pip and stays one.
    const component = {
      name,
      ...(version ? { version } : {}),
      type: "library",
      evidence: {
        identity: {
          field: "purl",
          confidence: 0.5,
          methods: [
            {
              technique: "manifest-analysis",
              confidence: 0.5,
              value: environmentYmlFile,
            },
          ],
        },
      },
      properties: [{ name: "internal:SrcFile", value: environmentYmlFile }],
    };
    if (!version) {
      component.properties.push({
        name: "cdx:conda:spec",
        value: dependency.trim(),
      });
    }
    const purl = condaPurl({
      name,
      version,
      build,
      channel: channel || defaultChannel,
    });
    pkgList.push(
      applyPurl(component, purl, `library:${name}:${version || ""}`),
    );
  }

  if (pipRequirements.length) {
    // The pip list is a requirements list embedded in the environment file.
    const pipList = await parseReqData(
      environmentYmlFile,
      pipRequirements.join("\n"),
      false,
    );
    if (pipList?.length) {
      pkgList.push(...pipList);
    }
  }
  return { pkgList };
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
 * Method to run cli command `pixi install` in the project directory.
 *
 * @param {string} projectPath Directory containing pixi.toml
 * @returns {boolean} true when pixi install succeeded
 */
export function generatePixiLockFile(projectPath) {
  const result = safeSpawnSync("pixi", ["install"], { cwd: projectPath });

  if (result.status !== 0) {
    // Handle errors. The caller carries on without a lock file: exiting here
    // would also stop a long-running cdxgen server.
    if (result.error && result.error.code === "ENOENT") {
      console.error(
        "Error: pixi command not found. Make sure pixi.js is installed globally.",
      );
    } else {
      console.error(
        `Error executing pixi install: ${result.error || result.stderr?.toString()}`,
      );
    }
    return false;
  }
  console.log("Dependencies installed successfully.");
  return true;
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
