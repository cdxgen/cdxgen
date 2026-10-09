import { readFileSync } from "node:fs";

import { parseToml } from "../core/toml.js";
import { tryBuildPurl } from "../inventory/purl.js";

/**
 * Julia project parser.
 *
 * Two files are consulted:
 *   - `Project.toml` — the manifest holding the project name, UUID, version,
 *     the names (and UUIDs) of its direct dependencies, and version
 *     compatibility constraints.
 *   - `Manifest.toml` — the lock file written by Pkg on resolve, pinning every
 *     package in the environment with its UUID, version, content hash, and the
 *     names of the packages it depends on.
 *
 * Packages are identified with the registered `julia` purl type, which carries
 * the package UUID as a required qualifier (`pkg:julia/JSON@0.21.4?uuid=…`).
 * The UUID is what Julia itself uses to identify packages, so keeping it in
 * the purl lets consumers match components across differently named mirrors.
 *
 * Julia standard libraries ship with the language itself and carry no version
 * in the manifest; they are emitted without a version and marked as standard
 * libraries so they can be told apart from registry packages.
 */

/**
 * Parse a Julia environment from its `Project.toml` and optional
 * `Manifest.toml`.
 *
 * @param {string} [projectTomlFile] Path to `Project.toml`, if present
 * @param {string} [manifestTomlFile] Path to `Manifest.toml`, if present
 * @returns {{ pkgList: object[], dependencies: object[], parentComponent: object, rootInputs?: string[] }}
 */
export function parseJuliaProject(projectTomlFile, manifestTomlFile) {
  const project = projectTomlFile ? readTomlFile(projectTomlFile) : undefined;

  const parentComponent = {};
  const directNames = new Set(
    project?.deps && typeof project.deps === "object"
      ? Object.keys(project.deps)
      : [],
  );
  if (project?.name) {
    const properties = [{ name: "internal:SrcFile", value: projectTomlFile }];
    if (typeof project.uuid === "string" && project.uuid) {
      properties.push({ name: "cdx:julia:uuid", value: project.uuid });
    }
    parentComponent.type = "application";
    parentComponent.name = project.name;
    if (typeof project.version === "string" && project.version) {
      parentComponent.version = project.version;
    }
    parentComponent.description = `Julia project: ${project.name}`;
    parentComponent.properties = properties;
  }

  let manifest;
  if (manifestTomlFile) {
    manifest = readTomlFile(manifestTomlFile);
  }

  // Manifest packages live under `[[deps.<Name>]]` array-of-table entries,
  // which smol-toml surfaces as a plain object keyed by package name.
  const manifestDeps = manifest?.deps;
  if (!manifestDeps || typeof manifestDeps !== "object") {
    // Lockless fallback: emit the declared direct dependencies without
    // resolved versions, using the UUIDs from Project.toml.
    const pkgList = [...directNames].map((name) =>
      juliaPackage(name, undefined, project?.deps?.[name], {
        direct: true,
        stdlib: JULIA_STDLIBS.has(name),
        srcFile: projectTomlFile,
      }),
    );
    return {
      pkgList,
      dependencies: [],
      parentComponent,
      rootInputs: pkgList.map((p) => p["bom-ref"]),
    };
  }

  const pkgList = [];
  const edges = [];
  const refByName = new Map();
  for (const [name, raw] of Object.entries(manifestDeps)) {
    // `[[deps.<Name>]]` is an array of tables; a name repeats only when two
    // sources of the same package are pinned, and the first entry is the one
    // the environment resolves first.
    const entry = Array.isArray(raw) ? raw[0] : raw;
    const uuid =
      typeof entry?.uuid === "string" && entry.uuid ? entry.uuid : undefined;
    const registryVersion =
      typeof entry?.version === "string" && entry.version
        ? entry.version
        : undefined;
    // Entries without a registry version are pinned by content hash (git or
    // local path sources); the hash is the most precise version available.
    const gitTreeSha1 =
      typeof entry?.["git-tree-sha1"] === "string" && entry["git-tree-sha1"]
        ? entry["git-tree-sha1"]
        : undefined;
    const version = registryVersion || gitTreeSha1;
    const pkg = juliaPackage(name, version, uuid, {
      direct: directNames.has(name),
      stdlib: !registryVersion && JULIA_STDLIBS.has(name),
      srcFile: manifestTomlFile,
    });
    pkgList.push(pkg);
    refByName.set(name, pkg["bom-ref"]);
  }
  for (const [name, raw] of Object.entries(manifestDeps)) {
    const ref = refByName.get(name);
    if (!ref) {
      continue;
    }
    const entry = Array.isArray(raw) ? raw[0] : raw;
    const dependsOn = (Array.isArray(entry?.deps) ? entry.deps : [])
      .map((depName) => refByName.get(depName))
      .filter(Boolean);
    edges.push({ ref, dependsOn: [...new Set(dependsOn)].sort() });
  }
  const rootInputs = [...directNames]
    .map((name) => refByName.get(name))
    .filter(Boolean);
  return { pkgList, dependencies: edges, parentComponent, rootInputs };
}

/**
 * Tell whether a `Project.toml` declares a Julia environment.
 *
 * Cloud Native Buildpacks and Gleam use the same file names, so the caller
 * needs a content check before dispatching. A Julia project always carries a
 * package `uuid`, a `[deps]` table, or a `[compat]` table.
 *
 * @param {string} filePath Path to the candidate `Project.toml`
 * @returns {boolean} true when the file is a Julia project
 */
export function isJuliaProjectFile(filePath) {
  const project = readTomlFile(filePath);
  return Boolean(
    project &&
      (typeof project.uuid === "string" ||
        (project.deps && typeof project.deps === "object") ||
        (project.compat && typeof project.compat === "object")),
  );
}

/**
 * Tell whether a `Manifest.toml` is a Julia lock file.
 *
 * Gleam writes a lowercase `manifest.toml` that case-insensitive filesystems
 * surface under the same glob; a Julia manifest is recognised by its
 * `manifest_format` marker or its `[[deps.<Name>]]` tables.
 *
 * @param {string} filePath Path to the candidate `Manifest.toml`
 * @returns {boolean} true when the file is a Julia manifest
 */
export function isJuliaManifestFile(filePath) {
  const manifest = readTomlFile(filePath);
  return Boolean(
    manifest &&
      (typeof manifest.manifest_format === "string" ||
        (manifest.deps && typeof manifest.deps === "object")),
  );
}

/**
 * Build a component-like package record for a Julia dependency.
 *
 * @param {string} name Package name as Julia writes it
 * @param {string|undefined} version Resolved version, if known
 * @param {string|undefined} uuid Package UUID, if known
 * @param {object} opts Extra context (`direct`, `stdlib`, `srcFile`)
 * @returns {object} Package record
 */
function juliaPackage(name, version, uuid, opts) {
  // The julia purl type requires the uuid qualifier; when it is unknown the
  // purl is dropped entirely rather than emitted without its identity anchor.
  const purl =
    name && uuid
      ? tryBuildPurl({
          type: "julia",
          name,
          version: version || undefined,
          qualifiers: { uuid },
        })
      : null;
  const properties = [
    { name: "internal:SrcFile", value: opts.srcFile },
    {
      name: "cdx:julia:dependency",
      value: opts.direct ? "direct" : "transitive",
    },
  ];
  if (uuid) {
    properties.push({ name: "cdx:julia:uuid", value: uuid });
  }
  if (opts.stdlib) {
    properties.push({ name: "cdx:julia:stdlib", value: "true" });
  }
  const pkg = {
    name,
    ...(version ? { version } : {}),
    type: "library",
    scope: "required",
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
 * Julia standard libraries ship with the language itself. They carry no
 * version in the manifest, so they are recognised by name against this list.
 *
 * @type {Set<string>}
 */
const JULIA_STDLIBS = new Set([
  "Base",
  "CRC32c",
  "Dates",
  "DelimitedFiles",
  "Distributed",
  "FileWatching",
  "Future",
  "LibGit2",
  "Libdl",
  "LinearAlgebra",
  "Logging",
  "Markdown",
  "Mmap",
  "Printf",
  "Profile",
  "Random",
  "REPL",
  "Serialization",
  "SharedArrays",
  "Sockets",
  "SparseArrays",
  "Statistics",
  "TOML",
  "Test",
  "UUIDs",
  "Unicode",
]);

/**
 * Read and parse a TOML file, warning instead of throwing on invalid input.
 *
 * @param {string} filePath File to read
 * @returns {object|undefined} Parsed value
 */
function readTomlFile(filePath) {
  try {
    return parseToml(readFileSync(filePath, "utf-8"));
  } catch (error) {
    console.warn(`Failed to parse ${filePath}: ${error.message}`);
    return undefined;
  }
}
