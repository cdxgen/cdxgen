/**
 * Which package provides a C/C++ header, from the file the include resolved
 * to. atom 4 and later name that file in each include's usages slice
 * (`resolvedPath`); with it, a header is attributed exactly instead of by its
 * name: to the project itself, to a dependency whose sources CMake fetched or
 * a submodule checked out, to code the project vendors, to a port vcpkg
 * installed, to a package in the Conan cache, or to the operating-system
 * package that owns the file.
 *
 * Layer 3: reads the vcpkg installed tree and the Conan cache, and asks the
 * OS package manager about a file (`dpkg-query -S`, `rpm -qf`, `apk info -W`,
 * or the Homebrew Cellar path).
 */

import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import process from "node:process";

import { readEnvironmentVariable } from "../core/activity.js";
import { safeExistsSync } from "../core/fs.js";
import { isInsideDir } from "../inventory/cmakeBuildDirs.js";
import { resolvePackageForFile } from "../inventory/osPackageResolver.js";

/**
 * The include slices of an atom C/C++ usages report: for each header as
 * written, the files it resolved to, whether it was written as a system
 * include, and the functions the including files call that it declares.
 * Slices from atom releases that do not name the resolved file contribute no
 * paths and no symbols.
 *
 * @param {Object} sliceData Parsed atom usages report
 * @returns {Map<string, {paths: Set<string>, system: boolean, symbols: Set<string>}>}
 */
export function parseCIncludeSlices(sliceData) {
  const includes = new Map();
  for (const slice of sliceData?.objectSlices || []) {
    if (!slice || !`${slice.code || ""}`.startsWith("#include")) {
      continue;
    }
    const header = slice.fullName;
    if (!header) {
      continue;
    }
    const entry = includes.get(header) || {
      paths: new Set(),
      system: false,
      symbols: new Set(),
    };
    if (typeof slice.resolvedPath === "string" && slice.resolvedPath.length) {
      entry.paths.add(slice.resolvedPath);
    }
    entry.system = entry.system || slice.isSystem === true;
    for (const symbol of Array.isArray(slice.importedSymbols)
      ? slice.importedSymbols
      : []) {
      if (typeof symbol === "string" && symbol.length) {
        entry.symbols.add(symbol);
      }
    }
    includes.set(header, entry);
  }
  return includes;
}

/**
 * Index the ports vcpkg installed into the given `vcpkg_installed`
 * directories: every file a port installed, by absolute path. vcpkg lists a
 * port's files in `vcpkg/info/<port>_<version>_<triplet>.list`, one path per
 * line relative to the installed directory.
 *
 * @param {string[]} installedDirs `vcpkg_installed` directories
 * @returns {Map<string, {port: string, version: string, triplet: string}>}
 */
export function readVcpkgInstalledIndex(installedDirs) {
  const index = new Map();
  for (const dir of installedDirs) {
    const infoDir = join(dir, "vcpkg", "info");
    let lists = [];
    try {
      lists = readdirSync(infoDir).filter((f) => f.endsWith(".list"));
    } catch (_err) {
      continue;
    }
    for (const list of lists) {
      const stem = list.slice(0, -".list".length);
      const first = stem.indexOf("_");
      const last = stem.lastIndexOf("_");
      if (first <= 0 || last <= first) {
        continue;
      }
      const port = stem.slice(0, first);
      const version = stem.slice(first + 1, last);
      const triplet = stem.slice(last + 1);
      let text = "";
      try {
        text = readFileSync(join(infoDir, list), "utf-8");
      } catch (_err) {
        continue;
      }
      for (const line of text.split(/\r?\n/)) {
        const rel = line.trim();
        if (!rel || rel.endsWith("/")) {
          continue;
        }
        index.set(resolve(dir, rel), { port, version, triplet });
      }
    }
  }
  return index;
}

/**
 * The package folders of a Conan 2 cache, from its database
 * (`<home>/p/cache.sqlite3`, table `packages`).
 *
 * @param {string} conanHome Conan 2 home (`CONAN_HOME`, or `~/.conan2`)
 * @returns {Array<{dir: string, name: string, version: string}>}
 */
export function conan2Packages(conanHome) {
  const packages = [];
  const db = join(conanHome, "p", "cache.sqlite3");
  if (!safeExistsSync(db)) {
    return packages;
  }
  const sqlite = process.getBuiltinModule?.("node:sqlite");
  if (!sqlite?.DatabaseSync) {
    return packages;
  }
  let handle;
  try {
    handle = new sqlite.DatabaseSync(db, { readOnly: true });
    for (const row of handle
      .prepare("SELECT reference, path FROM packages")
      .all()) {
      if (typeof row.reference === "string" && typeof row.path === "string") {
        const [name, version] = row.reference.split("@")[0].split("/");
        if (name && version) {
          packages.push({
            dir: resolve(conanHome, "p", row.path),
            name,
            version,
          });
        }
      }
    }
  } catch (_err) {
    // a database of another layout tells nothing
  } finally {
    try {
      handle?.close();
    } catch (_err) {
      // already closed
    }
  }
  return packages;
}

/**
 * The Conan package a file belongs to: in a Conan 1 cache
 * (`<home>/.conan/data/<name>/<version>/<user>/<channel>/package/<id>/...`)
 * from its path, in a Conan 2 cache from the cache's database.
 *
 * @param {string} file Absolute path
 * @param {Object[]} conan2 Conan 2 package folders (see `conan2Packages`)
 * @returns {{name: string, version: string}|undefined}
 */
export function conanPackageOf(file, conan2) {
  const segments = file.split(sep);
  const data = segments.findIndex(
    (s, i) => s === "data" && segments[i - 1] === ".conan",
  );
  if (
    data >= 0 &&
    segments.length > data + 6 &&
    segments[data + 5] === "package"
  ) {
    return { name: segments[data + 1], version: segments[data + 2] };
  }
  const hit = conan2.find((p) => isInsideDir(file, p.dir));
  return hit ? { name: hit.name, version: hit.version } : undefined;
}

function propertyValue(component, name) {
  return (component?.properties || []).find((p) => p.name === name)?.value;
}

/**
 * Build the function that attributes a header from the files it resolved
 * to.
 *
 * @param {Object} context
 * @param {string} context.src Project scan root
 * @param {Object[]} [context.components] Components already known: CMake
 *   dependencies (`cdx:cmake:sourceDir`) and vendored code
 *   (`cdx:vendored:path`) claim the headers under their directories
 * @param {string[]} [context.buildDirs] Build directories, searched for
 *   `vcpkg_installed`
 * @param {function(string): boolean} [context.isFirstPartyHeader] Whether a
 *   file is the project's own
 * @returns {function(Iterable<string>): Object|undefined} Given the resolved
 *   files, `{kind: "first-party"}`, `{kind: "component", component}`,
 *   `{kind: "vcpkg", port, version, triplet}`, `{kind: "conan", name,
 *   version}`, `{kind: "os", pkgInfo}`, or `undefined` when no file says.
 *   Its `vcpkgPorts()` lists the ports vcpkg installed.
 */
export function createIncludeAttributor(context) {
  const root = resolve(context.src);
  const owners = [];
  for (const component of context.components || []) {
    for (const name of ["cdx:cmake:sourceDir", "cdx:vendored:path"]) {
      const dir = propertyValue(component, name);
      if (dir) {
        owners.push({ dir: resolve(root, dir), component });
      }
    }
  }
  // the deepest directory owns a file inside nested ones
  owners.sort((a, b) => b.dir.length - a.dir.length);
  const installedDirs = [root, ...(context.buildDirs || [])]
    .map((d) => join(d, "vcpkg_installed"))
    .filter((d) => safeExistsSync(d));
  let vcpkgIndex;
  const vcpkg = () => {
    vcpkgIndex = vcpkgIndex || readVcpkgInstalledIndex(installedDirs);
    return vcpkgIndex;
  };
  const conanHome =
    readEnvironmentVariable("CONAN_HOME") || join(homedir(), ".conan2");
  let conan2;
  const conan2Folders = () => {
    conan2 = conan2 || conan2Packages(conanHome);
    return conan2;
  };
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch (_err) {
      return resolve(p);
    }
  };
  const attributeOne = (file) => {
    if (!file || !isAbsolute(file)) {
      return undefined;
    }
    const abs = resolve(file);
    const owner = owners.find((o) => isInsideDir(abs, o.dir));
    if (owner) {
      return { kind: "component", component: owner.component };
    }
    if (context.isFirstPartyHeader?.(abs)) {
      return { kind: "first-party" };
    }
    const port =
      installedDirs.length && (vcpkg().get(abs) || vcpkg().get(real(abs)));
    if (port) {
      return { kind: "vcpkg", ...port };
    }
    const conan = conanPackageOf(real(abs), conan2Folders());
    if (conan) {
      return { kind: "conan", ...conan };
    }
    if (isInsideDir(abs, root)) {
      return undefined;
    }
    const pkgInfo = resolvePackageForFile(real(abs));
    if (pkgInfo?.name) {
      return { kind: "os", pkgInfo };
    }
    return undefined;
  };
  const attribute = (files) => {
    for (const file of files || []) {
      const target = attributeOne(file);
      if (target) {
        return target;
      }
    }
    return undefined;
  };
  /** The ports vcpkg installed for the project: port to version and triplet. */
  attribute.vcpkgPorts = () => {
    const ports = new Map();
    if (installedDirs.length) {
      for (const { port, version, triplet } of vcpkg().values()) {
        if (!ports.has(port)) {
          ports.set(port, { version, triplet });
        }
      }
    }
    return ports;
  };
  return attribute;
}
