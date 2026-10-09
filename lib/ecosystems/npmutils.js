import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { build, Purl } from "@cdxgen/cdx-purl";
import { clean } from "semver";

import { safeExistsSync } from "../core/fs.js";
import { parsePurlLoose } from "../inventory/purl.js";
import { spdxLicenses } from "../inventory/spdx.js";
import { parseNpmrc, parseNpmrcFromEnv } from "../parsers/npmrc.js";

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
  // Legacy plural form kept by long-lived packages such as fuzzy 0.1.3: the
  // manifest carries `licenses` instead of `license` (issue 4466).
  "licenses",
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
 * Marks an npm component as imported only for its TypeScript types.
 *
 * @param {object} pkg Component object to annotate
 * @returns {void}
 */
export function setNpmTypeOnlyProperty(pkg) {
  addComponentProperty(pkg, "cdx:npm:package:type-only", "true");
}

/**
 * Clean an npm version the way `npm publish` does before it records a release.
 *
 * Publishing a directory runs the manifest through `npm pkg fix`
 * (`fixVersionField` in `@npmcli/package-json`, which calls `semver.clean` in
 * loose mode) and then through libnpmpublish, which calls `semver.clean` again
 * in strict mode and records the result as the packument version, the
 * dist-tag, the `_id` and the tarball file name. Semver build metadata
 * (`1.0.0+build.5`), a leading `v` or `=`, surrounding whitespace and leading
 * zeros are dropped; a prerelease is kept.
 *
 * The `package.json` inside the published tarball keeps the original string,
 * and so do the lockfiles npm, pnpm, yarn and bun write for a project, a
 * workspace member or a git, file or link dependency. The cleaned form is the
 * version the npm registry knows the package by.
 *
 * @param {string} version Version as a manifest or lockfile records it
 * @returns {string|null} The cleaned version, or null when npm would reject `version` as invalid semver
 */
export function cleanNpmVersion(version) {
  if (typeof version !== "string" || !version.trim()) {
    return null;
  }
  const looseClean = clean(version, { loose: true });
  if (!looseClean) {
    return null;
  }
  return clean(looseClean);
}

/**
 * Record the version npm would publish when it differs from the recorded one.
 *
 * Sets `cdx:npm:cleanedVersion` on an npm component whose version is valid
 * semver but not in the form {@link cleanNpmVersion} produces, for example
 * `1.0.0+build.5` (published as `1.0.0`). The component's `version` and `purl`
 * keep the recorded string: that is what the manifest and lockfile say. A
 * component whose version is already clean, or not semver at all (a git
 * commit, a `file:` path), is left without the property, and a stale value from
 * an earlier pass is replaced.
 *
 * @param {object} component Component or package object with `version` and `purl`
 * @returns {object} The same component, for chaining
 */
export function setNpmCleanedVersionProperty(component) {
  if (!component || typeof component !== "object") {
    return component;
  }
  const purl = component.purl;
  if (typeof purl !== "string" || !purl.startsWith("pkg:npm/")) {
    return component;
  }
  const cleaned = cleanNpmVersion(component.version);
  const wanted = cleaned && cleaned !== component.version ? cleaned : undefined;
  const existing = component.properties?.filter(
    (property) => property?.name === "cdx:npm:cleanedVersion",
  );
  if (
    (!existing?.length && !wanted) ||
    (existing?.length === 1 && existing[0].value === wanted)
  ) {
    return component;
  }
  const properties = (component.properties || []).filter(
    (property) => property?.name !== "cdx:npm:cleanedVersion",
  );
  if (wanted) {
    properties.push({ name: "cdx:npm:cleanedVersion", value: wanted });
  }
  component.properties = properties;
  return component;
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
    const purlObj = new Purl({
      type: "npm",
      namespace: namespace || null,
      name: name,
      version: version || null,
    });
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

  // Compare the parsed coordinates: a prefix match on the purl text would let
  // `ws` match `wsmember`, and the reference may be escaped or decoded.
  return workspacePackages.find((workspacePackage) => {
    const parts = parsePurlLoose(workspacePackage);
    if (parts?.type !== "npm") {
      return false;
    }
    const fullName = parts.namespace
      ? `${parts.namespace}/${parts.name}`
      : parts.name;
    return fullName === packageName;
  });
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
    // Arborist adds a `workspace` edge from the root to every member, with an
    // absolute `file:` spec it builds from the checkout path. No manifest
    // declares it, and copying it would put the local path into the BOM.
    if (edge?.workspace || edge?.type === "workspace") {
      continue;
    }
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
 * Whether a value of the legacy `licenses` field names a license: a non-empty
 * string, or an object with a non-empty `type`.
 *
 * @param {*} entry One value of the legacy field
 * @returns {boolean} True when the entry names a license
 */
function isLegacyNpmLicenseEntry(entry) {
  if (typeof entry === "string") {
    return entry.trim() !== "";
  }
  return typeof entry?.type === "string" && entry.type.trim() !== "";
}

/**
 * Resolve the license of an npm-style manifest, honouring the legacy plural
 * `licenses` field that packages published before the SPDX convention still
 * carry (issue 4466). A modern `license` value is returned unchanged. The
 * legacy field may hold one entry or an array of them, each a string or a
 * `{ type, url }` object; one entry is returned as it is. npm documents an
 * array of several entries as a choice between them, so when every entry is an
 * SPDX identifier the array becomes the equivalent `MIT OR Apache-2.0`
 * expression, and otherwise stays a list for `getLicenses` to convert entry by
 * entry.
 *
 * @param {object} pkgData Parsed package.json (or bower.json) manifest
 * @returns {string|object|Array|undefined} The effective license value
 */
export function resolveNpmLicense(pkgData) {
  if (!pkgData || typeof pkgData !== "object") {
    return undefined;
  }
  const license = pkgData.license;
  // An empty or null license is no declaration and defers to `licenses`.
  if (
    license !== undefined &&
    license !== null &&
    !(typeof license === "string" && license.trim() === "")
  ) {
    return license;
  }
  const legacyEntries = (
    Array.isArray(pkgData.licenses) ? pkgData.licenses : [pkgData.licenses]
  ).filter(isLegacyNpmLicenseEntry);
  if (legacyEntries.length <= 1) {
    return legacyEntries[0];
  }
  const licenseIds = [
    ...new Set(
      legacyEntries.map((entry) =>
        (typeof entry === "string" ? entry : entry.type).trim(),
      ),
    ),
  ];
  if (licenseIds.every((licenseId) => spdxLicenses.includes(licenseId))) {
    return licenseIds.join(" OR ");
  }
  return legacyEntries;
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

/**
 * Normalize a pnpm lockfile package key by stripping the leading "/@"
 * separator and any parenthetical peer-dependency suffix.
 *
 * @param {string} lockKey Raw package key from a pnpm lockfile.
 * @returns {string} The normalized key.
 */
export function normalizePnpmLockKey(lockKey) {
  let key = lockKey.replace("/@", "@");
  if (key.includes("(")) {
    key = key.split("(")[0];
  }
  return key;
}

/**
 * Normalize an npm registry URL by trimming surrounding whitespace and any
 * trailing slash. Returns undefined for empty or templated (`${...}`) URLs.
 *
 * @param {string} registryUrl Raw registry URL.
 * @returns {string|undefined} The normalized registry URL, or undefined when
 *   the URL is empty or templated.
 */
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

/**
 * Load and merge npm/pnpm configuration from the project root with env-derived values.
 *
 * Reads `.npmrc` and `.pnpmrc` (when present) under `projectRoot`, layering them
 * on top of the environment-derived config returned by `parseNpmrcFromEnv`.
 *
 * @param {string} projectRoot Project root directory to search for rc files.
 * @returns {Object<string, string>} Merged npmrc configuration object.
 */
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

/**
 * Strip a leading "@" from an npm scope group name.
 *
 * @param {string} group Raw scope group (e.g. "@scope").
 * @returns {string} The scope without the leading "@", or an empty string.
 */
export function normalizeNpmScopeGroup(group) {
  if (!group) {
    return "";
  }
  return group.startsWith("@") ? group.slice(1) : group;
}

/**
 * Resolve the npm registry URL for a git-installed package.
 *
 * Prefers the scope-specific registry (`@scope:registry`) from the npmrc config,
 * falling back to the global `registry` value.
 *
 * @param {string} group npm scope group (with or without leading "@").
 * @param {Object<string, string>} [npmrcConfig={}] Merged npmrc configuration.
 * @returns {string|undefined} The resolved registry URL, or undefined.
 */
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

/**
 * Build purl qualifiers (vcs_url, repository_url) for a git-sourced npm package.
 *
 * @param {string} vcsUrl Version-control URL (e.g. "repo#commit").
 * @param {string} group npm scope group.
 * @param {Object<string, string>} npmrcConfig Merged npmrc configuration.
 * @returns {Object<string, string>|null} Qualifier map, or null when none apply.
 */
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

/**
 * Construct the registry tarball download URL for an npm package.
 *
 * @param {string} registryUrl Normalized registry base URL.
 * @param {string} group npm scope group.
 * @param {string} name Package name.
 * @param {string} version Package version.
 * @returns {string|undefined} The tarball URL, or undefined when required inputs are missing.
 */
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

/**
 * Build distribution-intake external references for a git npm package's tarball.
 *
 * Resolves the registry URL for the package scope and constructs the tarball
 * download URL, returning a single-element external-reference list.
 *
 * @param {string} group npm scope group.
 * @param {string} name Package name.
 * @param {string} version Package version.
 * @param {Object<string, string>} npmrcConfig Merged npmrc configuration.
 * @returns {Array<{type: string, url: string}>|undefined} Distribution-intake
 *   references, or undefined when the registry URL cannot be resolved.
 */
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

/**
 * Parse a pnpm lockfile key into group/name/git-spec for git-resolved packages.
 *
 * @param {string} lockKey Raw package key from a pnpm lockfile.
 * @returns {{group: string, name: string, gitSpec: string, fullName: string, packageName: string}|null}
 *   Parsed coordinates, or null when the key is not a git reference.
 */
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

/**
 * Build external-reference/intake objects for git-resolved pnpm packages.
 *
 * Scans the lockfile `packages` and `snapshots` maps for git resolutions,
 * deriving purl, vcs_url, and distribution-intake references for each. Entries
 * are indexed under every alias of their lock key for fast lookup.
 *
 * @param {Object<string, object>} packages Lockfile `packages` map.
 * @param {Object<string, object>} snapshots Lockfile `snapshots` map.
 * @param {Object<string, string>} [npmrcConfig={}] Merged npmrc configuration.
 * @returns {Object<string, object>} Map of lookup key to git package reference.
 */
export function buildPnpmGitPkgRefs(packages, snapshots, npmrcConfig = {}) {
  // A null prototype keeps inherited Object properties (such as `constructor`)
  // from masquerading as lookup hits for keys that were never registered.
  const gitPkgRefs = Object.create(null);
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
    if (name === "__proto__" || packageName === "__proto__") {
      // A crafted lock key cannot become a lookup entry under this name.
      return;
    }
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
    const purlString = build({
      type: "npm",
      namespace: group || null,
      name: name,
      version: version || null,
      qualifiers: qualifiers || null,
    });
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
