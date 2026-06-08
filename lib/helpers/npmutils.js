import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { PackageURL } from "packageurl-js";

import { parseNpmrc, parseNpmrcFromEnv } from "../parsers/npmrc.js";
import { getVersionNumPnpm, safeExistsSync } from "./utils.js";

const npmPackageHydrationFields = [
  "author",
  "bin",
  "bugs",
  "contributors",
  "deprecated",
  "description",
  "funding",
  "homepage",
  "keywords",
  "license",
  "repository",
];

function addComponentProperty(component, name, value) {
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

function isWindowsAbsolutePath(value) {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

/**
 * Marks an npm component as development-only.
 *
 * @param {object} pkg Component object to annotate
 * @returns {void}
 */
export function setNpmDevelopmentProperty(pkg) {
  if (!pkg.properties) {
    pkg.properties = [];
  }
  if (
    !pkg.properties.some((property) => {
      return property.name === "cdx:npm:package:development";
    })
  ) {
    pkg.properties.push({
      name: "cdx:npm:package:development",
      value: "true",
    });
  }
}

/**
 * Marks an npm component as optional.
 *
 * @param {object} pkg Component object to annotate
 * @returns {void}
 */
export function setNpmOptionalProperty(pkg) {
  addComponentProperty(pkg, "cdx:npm:package:optional", "true");
}

/**
 * Marks an npm component as a peer dependency.
 *
 * @param {object} pkg Component object to annotate
 * @returns {void}
 */
export function setNpmPeerProperty(pkg) {
  addComponentProperty(pkg, "cdx:npm:package:peer", "true");
}

/**
 * Helper function to create a properly encoded workspace PURL
 *
 * @param {string} packageName - Package name (e.g., "@babel/core")
 * @param {string} version - Package version
 * @returns {string} Encoded PURL string
 */
export function createNpmWorkspacePurl(packageName, version) {
  try {
    let namespace = "";
    let name = packageName;
    if (packageName.startsWith("@")) {
      const slashIndex = packageName.indexOf("/");
      if (slashIndex > 0) {
        namespace = packageName.substring(0, slashIndex);
        name = packageName.substring(slashIndex + 1);
      }
    }
    const purlObj = new PackageURL("npm", namespace, name, version);
    return purlObj.toString();
  } catch (_err) {
    let workspaceRef = `pkg:npm/${packageName}`;
    if (version) {
      workspaceRef = `${workspaceRef}@${version}`;
    }
    return workspaceRef;
  }
}

/**
 * Finds a matching npm workspace PURL for the supplied package name.
 *
 * @param {string[] | undefined} workspacePackages Array of workspace package PURLs
 * @param {string} packageName Package name to match against
 * @returns {string | undefined} Matching workspace package PURL, if any
 */
export function findMatchingNpmWorkspace(workspacePackages, packageName) {
  if (!workspacePackages?.length || !packageName) {
    return undefined;
  }

  const expectedEncodedPurl = createNpmWorkspacePurl(packageName);
  const simplePurl = `pkg:npm/${packageName}`;

  return workspacePackages.find(
    (workspacePackage) =>
      workspacePackage.startsWith(expectedEncodedPurl) ||
      workspacePackage.startsWith(simplePurl),
  );
}

/**
 * Classifies an npm dependency specifier by source type.
 *
 * @param {string | undefined | null} spec npm dependency specifier
 * @returns {{ type: string, value: string } | undefined} Classified manifest source, if supported
 */
export function classifyNpmManifestSource(spec) {
  if (typeof spec !== "string" || !spec.trim()) {
    return undefined;
  }
  const normalizedSpec = spec.trim();
  const lowerSpec = normalizedSpec.toLowerCase();
  if (
    lowerSpec.startsWith("git+") ||
    lowerSpec.startsWith("git://") ||
    lowerSpec.startsWith("github:") ||
    lowerSpec.startsWith("gitlab:") ||
    lowerSpec.startsWith("bitbucket:") ||
    lowerSpec.startsWith("gist:")
  ) {
    return {
      type: "git",
      value: normalizedSpec,
    };
  }
  if (lowerSpec.startsWith("http://") || lowerSpec.startsWith("https://")) {
    return {
      type: "url",
      value: normalizedSpec,
    };
  }
  if (
    lowerSpec.startsWith("file:") ||
    lowerSpec.startsWith("link:") ||
    lowerSpec.startsWith("workspace:") ||
    normalizedSpec.startsWith("./") ||
    normalizedSpec.startsWith("../") ||
    normalizedSpec.startsWith("/") ||
    isWindowsAbsolutePath(normalizedSpec)
  ) {
    return {
      type: "path",
      value: normalizedSpec,
    };
  }
  return undefined;
}

/**
 * Collects unique manifest-declared npm dependency sources from incoming edges.
 *
 * @param {object} node Arborist node
 * @returns {{ type: string, value: string }[]} Unique manifest source entries
 */
export function collectNpmManifestSources(node) {
  const manifestSources = [];
  const seen = new Set();
  if (!node?.edgesIn) {
    return manifestSources;
  }
  for (const edge of node.edgesIn) {
    const manifestSource = classifyNpmManifestSource(edge?.spec);
    if (!manifestSource) {
      continue;
    }
    const dedupeKey = `${manifestSource.type}|${manifestSource.value}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    manifestSources.push(manifestSource);
  }
  return manifestSources;
}

/**
 * Hydrates sparse npm package metadata from the installed package.json in deep mode.
 * Existing metadata on the Arborist node wins over on-disk values.
 *
 * @param {object} node Arborist node
 * @param {object} [options={}] CLI options
 * @returns {{ nodePackage: object, diskPkg: object | undefined, packageJsonPath: string | undefined }} Hydrated package metadata and the source package.json context
 */
export function hydrateNpmNodePackage(node, options = {}) {
  const nodePackage = node?.package || {};
  if (!node?.path) {
    return { nodePackage, diskPkg: undefined, packageJsonPath: undefined };
  }
  const packageJsonPath = join(node.path, "package.json");
  if (!options.deep) {
    return { nodePackage, diskPkg: undefined, packageJsonPath };
  }
  if (!existsSync(packageJsonPath)) {
    return { nodePackage, diskPkg: undefined, packageJsonPath };
  }
  const shouldHydrate = npmPackageHydrationFields.some(
    (field) => nodePackage[field] === undefined,
  );
  if (!shouldHydrate) {
    return { nodePackage, diskPkg: undefined, packageJsonPath };
  }
  try {
    const diskPkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    const hydratedPackage = { ...nodePackage };
    for (const field of npmPackageHydrationFields) {
      if (
        hydratedPackage[field] === undefined &&
        diskPkg[field] !== undefined
      ) {
        hydratedPackage[field] = diskPkg[field];
      }
    }
    return { nodePackage: hydratedPackage, diskPkg, packageJsonPath };
  } catch (_err) {
    return { nodePackage, diskPkg: undefined, packageJsonPath };
  }
}

/**
 * Helper to check if a package is imported only for TypeScript types.
 */
export function isPkgTypeOnlyImport(allImports, group, name) {
  if (!allImports) {
    return false;
  }
  const pkgNames = [];
  if (group) {
    const cleanGroup = group.startsWith("@") ? group : `@${group}`;
    pkgNames.push(`${cleanGroup}/${name}`);
    pkgNames.push(`${group}/${name}`);
  } else {
    pkgNames.push(name);
  }

  let hasImports = false;
  for (const importName of Object.keys(allImports)) {
    const isMatch = pkgNames.some(
      (pkgName) =>
        importName === pkgName || importName.startsWith(`${pkgName}/`),
    );
    if (isMatch) {
      const occurrences = allImports[importName];
      if (occurrences) {
        const items =
          occurrences instanceof Set ? Array.from(occurrences) : occurrences;
        if (Array.isArray(items) && items.length > 0) {
          hasImports = true;
          if (items.some((occ) => !occ.isTypeOnly)) {
            return false;
          }
        } else if (occurrences === true) {
          return false;
        }
      }
    }
  }
  return hasImports;
}

export function normalizePnpmLockKey(lockKey) {
  let key = lockKey.replace("/@", "@");
  if (key.includes("(")) {
    key = key.split("(")[0];
  }
  return key;
}

export function normalizeNpmRegistryUrl(registryUrl) {
  if (!registryUrl || registryUrl.includes("${")) {
    return undefined;
  }
  let normalized = registryUrl.trim();
  if (normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

export function loadNpmrcConfig(projectRoot) {
  const config = { ...parseNpmrcFromEnv() };
  if (!projectRoot) {
    return config;
  }
  const rootPath = resolve(projectRoot);
  for (const rcFile of [".npmrc", ".pnpmrc"]) {
    const rcPath = join(rootPath, rcFile);
    if (safeExistsSync(rcPath)) {
      Object.assign(config, parseNpmrc(readFileSync(rcPath, "utf8")));
    }
  }
  return config;
}

export function normalizeNpmScopeGroup(group) {
  if (!group) {
    return "";
  }
  return group.startsWith("@") ? group.slice(1) : group;
}

export function resolveNpmRegistryUrlForGitPackage(group, npmrcConfig = {}) {
  const scope = normalizeNpmScopeGroup(group);
  if (scope) {
    const scopedRegistry = normalizeNpmRegistryUrl(
      npmrcConfig[`@${scope}:registry`],
    );
    if (scopedRegistry) {
      return scopedRegistry;
    }
  }
  if (npmrcConfig.registry) {
    return normalizeNpmRegistryUrl(npmrcConfig.registry);
  }
  return undefined;
}

export function buildNpmGitPurlQualifiers(vcsUrl, group, npmrcConfig) {
  const qualifiers = {};
  if (vcsUrl) {
    qualifiers.vcs_url = vcsUrl;
  }
  const repositoryUrl = resolveNpmRegistryUrlForGitPackage(group, npmrcConfig);
  if (repositoryUrl) {
    qualifiers.repository_url = repositoryUrl;
  }
  return Object.keys(qualifiers).length ? qualifiers : null;
}

export function buildNpmRegistryTarballUrl(registryUrl, group, name, version) {
  if (!registryUrl || !name || !version) {
    return undefined;
  }
  const scope = normalizeNpmScopeGroup(group);
  const base = registryUrl.endsWith("/") ? registryUrl : `${registryUrl}/`;
  if (scope) {
    return `${base}@${encodeURIComponent(scope)}/${encodeURIComponent(name)}/-/${encodeURIComponent(name)}-${version}.tgz`;
  }
  return `${base}${encodeURIComponent(name)}/-/${encodeURIComponent(name)}-${version}.tgz`;
}

export function buildNpmGitDistributionIntakeRefs(
  group,
  name,
  version,
  npmrcConfig,
) {
  const registryUrl = resolveNpmRegistryUrlForGitPackage(group, npmrcConfig);
  const scope = normalizeNpmScopeGroup(group);
  if (!registryUrl || !scope) {
    return undefined;
  }
  const tarballUrl = buildNpmRegistryTarballUrl(
    registryUrl,
    group,
    name,
    version,
    npmrcConfig,
  );
  if (!tarballUrl || tarballUrl.includes("${")) {
    return undefined;
  }
  return [
    {
      type: "distribution-intake",
      url: tarballUrl,
    },
  ];
}

export function parsePnpmGitLockKey(lockKey) {
  const fullName = normalizePnpmLockKey(lockKey);
  const gitLockKeyMatch = fullName.match(
    /^(@[^/]+\/)?([^@]+)@(git\+(?:ssh|https|http)|https?:|ssh:)/,
  );
  if (!gitLockKeyMatch) {
    return null;
  }
  const group = gitLockKeyMatch[1]?.slice(0, -1) ?? "";
  const name = gitLockKeyMatch[2];
  const namePrefix = group ? `${group}/${name}` : name;
  const gitSpec = fullName.slice(namePrefix.length + 1);
  return {
    group,
    name,
    gitSpec,
    fullName,
    packageName: namePrefix,
  };
}

export function buildPnpmGitPkgRefs(packages, snapshots, npmrcConfig = {}) {
  const gitPkgRefs = {};
  const registerEntry = (lockKey, packageNode) => {
    const resolution = packageNode?.resolution;
    const parsed = parsePnpmGitLockKey(lockKey);
    if (!parsed && resolution?.type !== "git") {
      return;
    }
    if (!parsed) {
      return;
    }
    const { group, name, gitSpec, fullName, packageName } = parsed;
    const version = packageNode?.version || resolution?.commit || "";
    const repo = resolution?.repo || "";
    const commit = resolution?.commit || "";
    let vcsUrl;
    if (repo && commit) {
      vcsUrl = `${repo}#${commit}`;
    } else if (gitSpec) {
      vcsUrl = gitSpec;
    }
    const qualifiers = buildNpmGitPurlQualifiers(vcsUrl, group, npmrcConfig);
    const purlString = new PackageURL(
      "npm",
      group,
      name,
      version,
      qualifiers,
      null,
    ).toString();
    const entry = {
      group,
      name,
      version,
      packageName,
      commit,
      repo,
      gitSpec,
      vcsUrl,
      qualifiers,
      purl: decodeURIComponent(purlString),
      purlEncoded: purlString,
      externalReferences: buildNpmGitDistributionIntakeRefs(
        group,
        name,
        version,
        npmrcConfig,
      ),
    };
    gitPkgRefs[fullName] = entry;
    gitPkgRefs[normalizePnpmLockKey(lockKey)] = entry;
    gitPkgRefs[packageName] = entry;
    if (gitSpec) {
      gitPkgRefs[gitSpec] = entry;
    }
  };
  for (const [lockKey, packageNode] of Object.entries(packages || {})) {
    registerEntry(lockKey, packageNode);
  }
  for (const [lockKey, packageNode] of Object.entries(snapshots || {})) {
    if (!gitPkgRefs[normalizePnpmLockKey(lockKey)]) {
      registerEntry(lockKey, packageNode);
    }
  }
  return gitPkgRefs;
}

export async function getPnpmDepPurl(
  depPkg,
  packageName,
  gitPkgRefs,
  relativePath,
  githubServerHost,
  npmrcConfig = {},
) {
  let name = packageName;
  let group = "";
  let version;
  const versionObj = typeof depPkg === "object" ? depPkg : { version: depPkg };
  if (versionObj?.version?.startsWith(githubServerHost)) {
    const parts = versionObj.version.split("/");
    version = parts.pop();
    name = parts.pop();
    group = parts.pop();
    if (group === githubServerHost) {
      group = "";
    } else {
      group = `@${group}`;
    }
    gitPkgRefs[versionObj.version] = { group, name, version };
  } else {
    version = await getVersionNumPnpm(depPkg, relativePath);
    const gitEntry =
      gitPkgRefs[packageName] ||
      gitPkgRefs[version] ||
      gitPkgRefs[normalizePnpmLockKey(`${packageName}@${version}`)];
    if (gitEntry) {
      group = gitEntry.group;
      name = gitEntry.name;
      version = gitEntry.version;
      const qualifiers =
        gitEntry.qualifiers ||
        buildNpmGitPurlQualifiers(gitEntry.vcsUrl, group, npmrcConfig);
      return decodeURIComponent(
        new PackageURL(
          "npm",
          group,
          name,
          version,
          qualifiers,
          null,
        ).toString(),
      );
    }
  }
  return decodeURIComponent(
    new PackageURL("npm", group, name, version, null, null).toString(),
  );
}
