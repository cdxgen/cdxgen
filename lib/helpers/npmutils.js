import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PackageURL } from "packageurl-js";

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
