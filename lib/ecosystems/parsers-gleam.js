import { readFileSync } from "node:fs";

import { parseToml } from "../core/toml.js";
import { tryBuildPurl } from "../inventory/purl.js";

/**
 * Gleam package parser.
 *
 * Gleam resolves dependencies through Hex, so packages are identified with the
 * registered `hex` purl type (`pkg:hex/<name>@<version>`). No new purl type is
 * introduced: a Gleam package on Hex is a Hex package, with a flat name and no
 * namespace, exactly as the registered `hex` rules allow.
 *
 * Two files are consulted:
 *   - `gleam.toml` — the manifest (project name, version, target, and the
 *     version ranges the project declares for its dependencies).
 *   - `manifest.toml` — the lock file written by the Gleam build tool, which
 *     pins every resolved package version and records which packages each one
 *     requires. The lock is the source of truth for versions and for the
 *     direct/transitive distinction.
 *
 * When `manifest.toml` is absent (the project has not been resolved), the
 * manifest alone is used and versions are left unspecified.
 */

/**
 * Parse a Gleam project from its `gleam.toml` manifest and optional
 * `manifest.toml` lock.
 *
 * @param {string} gleamTomlFile Path to `gleam.toml`
 * @param {string} [manifestTomlFile] Path to `manifest.toml`, if present
 * @returns {{ pkgList: object[], dependencies: object[], parentComponent: object }}
 */
export function parseGleamProject(gleamTomlFile, manifestTomlFile) {
  let manifest;
  try {
    manifest = parseToml(readFileSync(gleamTomlFile, "utf-8"));
  } catch (error) {
    console.warn(`Failed to parse ${gleamTomlFile}: ${error.message}`);
    return { pkgList: [], dependencies: [], parentComponent: {} };
  }

  const name = typeof manifest.name === "string" ? manifest.name : undefined;
  const version =
    typeof manifest.version === "string" ? manifest.version : undefined;
  const parentComponent = {};
  if (name) {
    Object.assign(parentComponent, {
      type: "application",
      name,
      ...(version ? { version } : {}),
      description:
        typeof manifest.description === "string"
          ? manifest.description
          : `Gleam project: ${name}`,
      properties: [{ name: "internal:SrcFile", value: gleamTomlFile }],
    });
    const target = manifestTarget(manifest);
    if (target) {
      parentComponent.properties.push({
        name: "cdx:gleam:target",
        value: target,
      });
    }
  }

  const directDevNames = collectDevDependencyNames(manifest);

  let lock;
  if (manifestTomlFile) {
    try {
      lock = parseToml(readFileSync(manifestTomlFile, "utf-8"));
    } catch (error) {
      console.warn(`Failed to parse ${manifestTomlFile}: ${error.message}`);
      lock = undefined;
    }
  }
  if (!lock || !Array.isArray(lock.packages)) {
    // Lockless fallback: emit declared dependencies without resolved versions.
    const declared = collectDeclaredDependencies(manifest);
    const pkgList = declared.map((dep) =>
      gleamPackage(dep.name, undefined, {
        direct: true,
        dev: directDevNames.has(dep.name),
        target: dep.target,
        srcFile: gleamTomlFile,
      }),
    );
    return {
      pkgList,
      dependencies: [],
      rootInputs: pkgList.map((p) => p["bom-ref"]),
      parentComponent,
    };
  }

  const packages = lock.packages;
  const directNames = new Set(
    lock.requirements ? Object.keys(lock.requirements) : [],
  );
  // A package counts as development-only when nothing outside the dev tree
  // reaches it. Packages in both trees are runtime dependencies that a dev
  // dependency happens to share, and scoping those `optional` would drop them
  // from a `--required-only` BOM.
  const directProdNames = new Set(
    [...directNames].filter((name) => !directDevNames.has(name)),
  );
  const reachableFromProd = transitiveClosureOf(directProdNames, packages);
  const reachableFromDev = transitiveClosureOf(directDevNames, packages);

  const pkgList = packages.map((pkg) => {
    const direct = directNames.has(pkg.name);
    const dev = direct
      ? directDevNames.has(pkg.name)
      : reachableFromDev.has(pkg.name) && !reachableFromProd.has(pkg.name);
    return gleamPackage(pkg.name, pkg.version, {
      direct,
      dev,
      buildType: pkg.build_type,
      srcFile: manifestTomlFile,
    });
  });

  const dependencies = buildDependencyGraph(pkgList, packages);
  const rootInputs = pkgList
    .filter((p) => directNames.has(p.name))
    .map((p) => p["bom-ref"]);
  return { pkgList, dependencies, rootInputs, parentComponent };
}
/**
 * Build a component-like package record for a Gleam dependency.
 *
 * Scope reflects CycloneDX semantics: dev-only dependencies are `optional`,
 * everything else is `required`. The direct/transitive distinction is recorded
 * as a property because it is useful for triage but is not a CycloneDX scope.
 *
 * @param {string} name Package name
 * @param {string|undefined} version Resolved version, if known
 * @param {object} opts Extra context
 * @returns {object} Package record
 */
function gleamPackage(name, version, opts) {
  const direct = !!opts.direct;
  const dev = !!opts.dev;
  const purl = tryBuildPurl({
    type: "hex",
    name,
    version: version || undefined,
  });
  const properties = [
    { name: "internal:SrcFile", value: opts.srcFile },
    {
      name: "cdx:gleam:dependency",
      value: direct ? "direct" : "transitive",
    },
  ];
  if (dev) {
    properties.push({ name: "cdx:gleam:scope", value: "development" });
  }
  if (opts.target) {
    properties.push({ name: "cdx:gleam:target", value: opts.target });
  }
  if (opts.buildType) {
    properties.push({ name: "cdx:gleam:build_type", value: opts.buildType });
  }
  const pkg = {
    name,
    ...(version ? { version } : {}),
    type: "library",
    scope: dev ? "optional" : "required",
    properties,
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
 * Extract the target (erlang/javascript) declared in a gleam.toml manifest.
 * The field may be a single string or an array of target names.
 *
 * @param {object} manifest Parsed gleam.toml
 * @returns {string|undefined} Comma-separated target list, or undefined
 */
function manifestTarget(manifest) {
  const t = manifest.target;
  if (typeof t === "string") {
    return t;
  }
  if (Array.isArray(t) && t.length) {
    return t.join(",");
  }
  return undefined;
}

/**
 * Collect the names of dev dependencies declared in `[dev-dependencies]`.
 *
 * @param {object} manifest Parsed gleam.toml
 * @returns {Set<string>} Dev dependency names
 */
function collectDevDependencyNames(manifest) {
  const names = new Set();
  const dev = manifest["dev-dependencies"];
  if (dev && typeof dev === "object") {
    for (const key of Object.keys(dev)) {
      names.add(key);
    }
  }
  return names;
}

/**
 * Collect declared main dependencies from `[dependencies]`, normalising the
 * value (which may be a version string or a `{ version, target, source }`
 * table) into a flat record.
 *
 * @param {object} manifest Parsed gleam.toml
 * @returns {Array<{name: string, target?: string}>} Declared dependencies
 */
function collectDeclaredDependencies(manifest) {
  const result = [];
  const deps = manifest.dependencies;
  if (!deps || typeof deps !== "object") {
    return result;
  }
  for (const [name, value] of Object.entries(deps)) {
    if (value && typeof value === "object") {
      result.push({
        name,
        ...(value.target ? { target: `${value.target}` } : {}),
      });
    } else {
      result.push({ name });
    }
  }
  return result;
}

/**
 * Compute the transitive closure of package names reachable from a set of root
 * names, following each package's `requirements` list. Used to flag packages
 * that are only pulled in by dev dependencies.
 *
 * @param {Set<string>} roots Starting package names
 * @param {Array<{name: string, requirements?: string[]}>} packages Lock packages
 * @returns {Set<string>} All reachable names (excluding the roots themselves)
 */
function transitiveClosureOf(roots, packages) {
  const byName = new Map(packages.map((p) => [p.name, p]));
  const visited = new Set();
  const stack = [...roots];
  while (stack.length) {
    const current = stack.pop();
    if (visited.has(current)) continue;
    visited.add(current);
    const reqs = byName.get(current)?.requirements;
    if (Array.isArray(reqs)) {
      for (const r of reqs) {
        if (!visited.has(r)) {
          stack.push(r);
        }
      }
    }
  }
  // The roots are dev deps themselves; return everything reachable so callers
  // can treat a non-direct package in this set as dev-scoped.
  for (const root of roots) {
    visited.delete(root);
  }
  return visited;
}

/**
 * Build a CycloneDX dependency graph from the lock's per-package requirements.
 *
 * The root entry links the parent component (if known) to its direct
 * dependencies; the root ref is left empty here and attached by `createGleamBom`
 * once the parent's bom-ref is known, mirroring the Nix flow.
 *
 * @param {object[]} pkgList Built package records
 * @param {Array<{name: string, requirements?: string[]}>} packages Lock packages
 * @returns {object[]} Dependency edges keyed by bom-ref
 */
function buildDependencyGraph(pkgList, packages) {
  const refByName = new Map(pkgList.map((p) => [p.name, p["bom-ref"]]));
  const edges = [];
  for (const pkg of packages) {
    const ref = refByName.get(pkg.name);
    if (!ref) continue;
    const dependsOn = (pkg.requirements || [])
      .map((r) => refByName.get(r))
      .filter(Boolean);
    edges.push({ ref, dependsOn: [...new Set(dependsOn)].sort() });
  }
  return edges;
}
