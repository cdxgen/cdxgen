// Which installed version of an npm package a source file uses.
//
// A lock file often holds several versions of one package: the one the project
// asked for, hoisted to the top-level node_modules, and older or newer copies
// nested under the packages that need them. A file of the project loads the
// copy Node.js finds first when it walks up from the file's directory, so only
// that version is used there. Crediting the file's imports to every version
// would mark the nested copies as used by the project.

import { dirname, isAbsolute, resolve } from "node:path";

import { Purl } from "@cdxgen/cdx-purl";

import { occurrenceKeyLocation } from "../inventory/occurrenceKey.js";

/**
 * Full npm package name (`@scope/name` or `name`) of a component or manifest.
 *
 * @param {{group?: string, name?: string}} pkg Component or parsed manifest
 * @returns {string} The package name npm installs it under
 */
export function npmPackageName({ group, name }) {
  const scope = group?.startsWith("@") ? group.substring(1) : group;
  return scope ? `@${scope}/${name}` : name;
}

/**
 * Full npm package name of an npm purl.
 *
 * @param {string} purl Package URL
 * @returns {string|undefined} `@scope/name` or `name`; undefined for a purl that is not npm or does not parse
 */
export function npmPackageNameOfPurl(purl) {
  try {
    const purlObj = Purl.parse(purl);
    if (purlObj.type !== "npm") {
      return undefined;
    }
    return purlObj.namespace
      ? `${purlObj.namespace}/${purlObj.name}`
      : purlObj.name;
  } catch (_e) {
    return undefined;
  }
}

/**
 * Directory a package-lock component is installed in.
 *
 * `internal:LocalNodeModulesPath` holds the arborist location, relative to the
 * root of the tree: `node_modules/a/node_modules/b` for a nested copy and
 * `packages/web/node_modules/b` for a copy under a workspace member. The
 * component's `internal:SrcFile` names a `package-lock.json` in the directory
 * that holds the location's first `node_modules` segment, so the install
 * directory is that location's `node_modules/...` part resolved against the
 * SrcFile's directory. A location without a `node_modules` segment (a
 * workspace member itself) and an absolute location (pnpm metadata found by
 * searching node_modules) name no install a file resolves to.
 *
 * @param {Object} pkg Package component
 * @returns {string|undefined} Absolute install directory
 */
export function npmInstallDirectory(pkg) {
  const properties = Array.isArray(pkg?.properties) ? pkg.properties : [];
  const location = properties.find(
    (p) => p.name === "internal:LocalNodeModulesPath",
  )?.value;
  const srcFile = properties.find((p) => p.name === "internal:SrcFile")?.value;
  if (!location || !srcFile || isAbsolute(location)) {
    return undefined;
  }
  const normalized = `${location}`.replaceAll("\\", "/");
  let start = -1;
  if (normalized.startsWith("node_modules/")) {
    start = 0;
  } else {
    const nested = normalized.indexOf("/node_modules/");
    start = nested >= 0 ? nested + 1 : -1;
  }
  if (start < 0) {
    return undefined;
  }
  return resolve(dirname(srcFile), normalized.slice(start));
}

/**
 * References the given root components depend on directly.
 *
 * @param {Array<{ref: string, dependsOn?: string[]}>} dependencies Dependency tree
 * @param {Iterable<string>} rootRefs bom-refs of the project and its workspace members
 * @returns {Set<string>} bom-refs of their direct dependencies
 */
export function directDependencyRefs(dependencies, rootRefs) {
  const roots = new Set(rootRefs || []);
  const direct = new Set();
  for (const dependency of dependencies || []) {
    if (roots.has(dependency?.ref)) {
      for (const ref of dependency.dependsOn || []) {
        direct.add(ref);
      }
    }
  }
  return direct;
}

/**
 * The direct dependencies that apply to a project file, nearest first.
 *
 * A file inside an npm workspace member (a component with
 * `cdx:npm:isWorkspace=true` and its directory in `cdx:npm:resolvedPath`,
 * relative to the project) depends first on what that member declares, then
 * on what the project root declares, since Node.js finds the root's hoisted
 * copies from inside a member too. Any other file depends on the root's.
 *
 * @param {Object[]} components Components or package list
 * @param {Object[]} dependencies Dependency tree
 * @param {string[]} rootRefs bom-refs of the project and the sub-components it lists
 * @returns {function(string): Set<string>[]} Lookup from a file name, relative to the project, to sets of bom-refs
 */
export function createDirectDependencyLookup(
  components,
  dependencies,
  rootRefs,
) {
  const rootDirect = directDependencyRefs(dependencies, rootRefs);
  const members = [];
  for (const comp of components || []) {
    const properties = Array.isArray(comp?.properties) ? comp.properties : [];
    const isWorkspace = properties.some(
      (p) => p.name === "cdx:npm:isWorkspace" && p.value === "true",
    );
    const memberPath = properties.find(
      (p) => p.name === "cdx:npm:resolvedPath",
    )?.value;
    if (!isWorkspace || !memberPath || !comp["bom-ref"]) {
      continue;
    }
    const dir = `${memberPath}`.replaceAll("\\", "/").replace(/\/+$/, "");
    if (!dir || dir.startsWith("..") || isAbsolute(dir)) {
      continue;
    }
    members.push({ dir, ref: comp["bom-ref"] });
  }
  members.sort((a, b) => b.dir.length - a.dir.length);
  const memberDirect = new Map();
  return (fileName) => {
    const file = `${fileName ?? ""}`.replaceAll("\\", "/");
    const member = members.find((m) => file.startsWith(`${m.dir}/`));
    if (!member) {
      return [rootDirect];
    }
    if (!memberDirect.has(member.ref)) {
      memberDirect.set(
        member.ref,
        directDependencyRefs(dependencies, [member.ref]),
      );
    }
    return [memberDirect.get(member.ref), rootDirect];
  };
}

/**
 * Narrow candidate versions to the ones a file's nearest direct dependencies
 * name.
 *
 * @param {Set<string>} candidates Candidate references
 * @param {Set<string>[]} directSets Direct dependency sets, nearest first
 * @param {function(string): string} [toRef] Maps a candidate to its bom-ref
 * @returns {Set<string>} The candidates the nearest set names, or all of them
 */
function narrowToDirect(candidates, directSets, toRef = (c) => c) {
  for (const direct of directSets) {
    const hits = [...candidates].filter((c) => direct.has(toRef(c)));
    if (hits.length) {
      return new Set(hits);
    }
  }
  return candidates;
}

/**
 * bom-refs of a parent component and the sub-components it lists, which are
 * the roots whose direct dependencies a project's own files use.
 *
 * @param {Object} parentComponent Parent (metadata) component
 * @returns {string[]} bom-refs
 */
export function projectRootRefs(parentComponent) {
  return [parentComponent, ...(parentComponent?.components || [])]
    .map((c) => c?.["bom-ref"])
    .filter(Boolean);
}

/**
 * Decide which installed versions of an npm package a project file uses.
 *
 * Only package names with more than one version in `pkgList` are decided; a
 * file uses the single version of any other package. For the rest, the file
 * uses:
 *
 * 1. the copy Node.js resolves from the file's directory, when the lock file
 *    records install locations (package-lock.json): the first
 *    `<dir>/node_modules/<name>` holding one of the versions, walking up from
 *    the file;
 * 2. otherwise the versions the file's workspace member, or else the project,
 *    depends on directly (see `createDirectDependencyLookup`);
 * 3. otherwise every version, since nothing tells them apart.
 *
 * @param {Object[]} pkgList Package components, duplicates per install location included
 * @param {Object} [context] Project facts
 * @param {string} [context.srcDir] Directory the file names are relative to
 * @param {Object[]} [context.dependencies] Dependency tree
 * @param {string[]} [context.rootRefs] bom-refs of the project and the sub-components it lists
 * @returns {{isAmbiguous: function(Object): boolean, allows: function(Object, string): boolean}} Chooser
 */
export function createNpmVersionChooser(pkgList, context = {}) {
  const refsByName = new Map();
  const refByInstallDir = new Map();
  for (const pkg of pkgList || []) {
    const ref = pkg?.["bom-ref"];
    if (!ref || !pkg.name) {
      continue;
    }
    if (pkg.purl && npmPackageNameOfPurl(pkg.purl) === undefined) {
      continue;
    }
    const name = npmPackageName(pkg);
    if (!refsByName.has(name)) {
      refsByName.set(name, new Set());
    }
    refsByName.get(name).add(ref);
    const installDir = npmInstallDirectory(pkg);
    if (installDir) {
      refByInstallDir.set(installDir, ref);
    }
  }
  const directFor = createDirectDependencyLookup(
    pkgList,
    context.dependencies,
    context.rootRefs || [],
  );
  const decided = new Map();
  const chosenRefs = (name, fileName) => {
    const candidates = refsByName.get(name);
    const fileDir =
      fileName && context.srcDir
        ? resolve(context.srcDir, dirname(`${fileName}`))
        : undefined;
    const cacheKey = `${name}\u0000${dirname(`${fileName ?? ""}`)}`;
    if (decided.has(cacheKey)) {
      return decided.get(cacheKey);
    }
    let chosen;
    if (fileDir) {
      let dir = fileDir;
      while (!chosen) {
        const ref = refByInstallDir.get(resolve(dir, "node_modules", name));
        if (ref && candidates.has(ref)) {
          chosen = new Set([ref]);
          break;
        }
        const parent = dirname(dir);
        if (parent === dir) {
          break;
        }
        dir = parent;
      }
    }
    if (!chosen) {
      chosen = narrowToDirect(candidates, directFor(fileName));
    }
    decided.set(cacheKey, chosen);
    return chosen;
  };
  const isAmbiguous = (pkg) =>
    Boolean(pkg?.name) && (refsByName.get(npmPackageName(pkg))?.size || 0) > 1;
  return {
    isAmbiguous,
    allows(pkg, fileName) {
      if (!isAmbiguous(pkg)) {
        return true;
      }
      return chosenRefs(npmPackageName(pkg), fileName).has(pkg["bom-ref"]);
    },
  };
}

/**
 * Keep each npm occurrence only on the versions the project file uses.
 *
 * evinse credits a slice record to every component of the record's package,
 * one per installed version. For a package with several versions in the BOM,
 * an occurrence in file F stays on a version when the input BOM's own import
 * evidence (seeded before any slice is read) puts that version in F; when the
 * BOM credits none of the versions in F, or several, the versions F's
 * workspace member or else the project depends on directly are kept (see
 * `createDirectDependencyLookup`); failing both, all stay.
 *
 * @param {Object} purlLocationMap purl -> Set of occurrence keys, changed in place
 * @param {Object} purlSymbolMap purl -> occurrence key -> symbol, changed in place
 * @param {Object} seededLocationMap purl -> Set of occurrence keys the input BOM carried
 * @param {Object} bomJson Input BOM, for its components, dependencies and metadata component
 * @returns {Set<string>} purls left with no occurrence, whose input occurrences belong to another version
 */
export function keepResolvedNpmVersions(
  purlLocationMap,
  purlSymbolMap,
  seededLocationMap,
  bomJson,
) {
  const purlsByName = new Map();
  const refByPurl = new Map();
  for (const comp of bomJson?.components || []) {
    const name = comp?.purl ? npmPackageNameOfPurl(comp.purl) : undefined;
    if (!name) {
      continue;
    }
    if (!purlsByName.has(name)) {
      purlsByName.set(name, new Set());
    }
    purlsByName.get(name).add(comp.purl);
    refByPurl.set(comp.purl, comp["bom-ref"] || comp.purl);
  }
  const clearedPurls = new Set();
  const directFor = createDirectDependencyLookup(
    bomJson?.components,
    bomJson?.dependencies,
    projectRootRefs(bomJson?.metadata?.component),
  );
  for (const purls of purlsByName.values()) {
    if (purls.size < 2) {
      continue;
    }
    const seededIn = new Map();
    for (const purl of purls) {
      for (const key of seededLocationMap?.[purl] || []) {
        const location = occurrenceKeyLocation(key);
        if (!seededIn.has(location)) {
          seededIn.set(location, new Set());
        }
        seededIn.get(location).add(purl);
      }
    }
    const decided = new Map();
    const keeps = (purl, location) => {
      if (!decided.has(location)) {
        let chosen = seededIn.get(location) || purls;
        if (chosen.size > 1) {
          chosen = narrowToDirect(chosen, directFor(location), (purl) =>
            refByPurl.get(purl),
          );
        }
        decided.set(location, chosen);
      }
      return decided.get(location).has(purl);
    };
    for (const purl of purls) {
      const keys = purlLocationMap[purl];
      if (!keys?.size) {
        continue;
      }
      for (const key of [...keys]) {
        if (!keeps(purl, occurrenceKeyLocation(key))) {
          keys.delete(key);
          if (purlSymbolMap?.[purl]) {
            delete purlSymbolMap[purl][key];
          }
        }
      }
      if (!keys.size) {
        clearedPurls.add(purl);
      }
    }
  }
  return clearedPurls;
}
