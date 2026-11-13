import { readFileSync } from "node:fs";
import { basename } from "node:path";

import { tryBuildPurl } from "../inventory/purl.js";

/**
 * Nim parser for `.nimble` manifests and `nimble.lock`.
 *
 * A `.nimble` file is a Nim script whose practical surface is a set of
 * `key = "value"` assignments plus `requires "dep >= 1.0"` lines; it is read
 * with a line scanner over those shapes rather than a Nim interpreter.
 * Nimble persists the resolved dependency set to `nimble.lock` (JSON), which
 * is the source of truth for versions.
 *
 * No `nim` purl type is registered, so packages are identified as generic
 * carrying a `cdx:purl:proposedType=nim` property, following the convention
 * used for nix and zig.
 */

/**
 * Parse a Nim project from a `.nimble` manifest and optional `nimble.lock`.
 *
 * @param {string} nimbleFile Path to the `.nimble` file
 * @param {string} [nimbleLockFile] Path to `nimble.lock`, if present
 * @returns {{ pkgList: object[], dependencies: object[], parentComponent: object, rootInputs?: string[], lockEntries: number }}
 *   `lockEntries` counts the package records the lock holds
 */
export function parseNimProject(nimbleFile, nimbleLockFile) {
  const fields = readNimbleFile(nimbleFile);
  const parentComponent = {};
  // Nimble files frequently omit `name`; the manifest file name is the
  // package name in that case, which is also how nimble itself refers to it.
  const projectName =
    fields.name || basename(nimbleFile).replace(/\.nimble$/iu, "");
  if (projectName) {
    parentComponent.type = "application";
    parentComponent.name = projectName;
    if (fields.version) {
      parentComponent.version = fields.version;
    }
    parentComponent.description =
      fields.description || `Nim package: ${fields.name}`;
    parentComponent.properties = [
      { name: "internal:SrcFile", value: nimbleFile },
    ];
    if (fields.license) {
      parentComponent.license = fields.license;
    }
  }

  let lock;
  if (nimbleLockFile) {
    try {
      lock = JSON.parse(readFileSync(nimbleLockFile, "utf-8"));
    } catch (error) {
      console.warn(`Failed to parse ${nimbleLockFile}: ${error.message}`);
      lock = undefined;
    }
  }

  // nimble.lock has carried `packages` both as an object keyed by name and as
  // an array of records; both shapes are accepted so locks from either
  // nimble generation parse.
  let lockedEntries = [];
  if (Array.isArray(lock?.packages)) {
    lockedEntries = lock.packages;
  } else if (lock?.packages && typeof lock.packages === "object") {
    for (const [name, entry] of Object.entries(lock.packages)) {
      lockedEntries.push({ name, ...entry });
    }
  }

  if (!lockedEntries.length) {
    // Lockless fallback: emit declared requirements without resolved versions.
    const pkgList = fields.requires.map((req) =>
      nimPackage(req.name, undefined, { direct: true, srcFile: nimbleFile }),
    );
    return {
      pkgList,
      dependencies: [],
      parentComponent,
      rootInputs: pkgList.map((p) => p["bom-ref"]),
      lockEntries: 0,
    };
  }

  const directNames = new Set(fields.requires.map((req) => req.name));
  const pkgList = [];
  const refByName = new Map();
  const edges = [];
  for (const entry of lockedEntries) {
    if (typeof entry?.name !== "string" || !entry.name) {
      continue;
    }
    const version =
      typeof entry.version === "string" && entry.version
        ? entry.version
        : undefined;
    const pkg = nimPackage(entry.name, version, {
      direct: directNames.has(entry.name),
      vcsRevision:
        typeof entry.vcsRevision === "string" && entry.vcsRevision
          ? entry.vcsRevision
          : undefined,
      srcFile: nimbleLockFile,
    });
    pkgList.push(pkg);
    refByName.set(entry.name, pkg["bom-ref"]);
  }
  for (const entry of lockedEntries) {
    const ref = refByName.get(entry.name);
    if (!ref) {
      continue;
    }
    const dependsOn = (
      Array.isArray(entry.dependencies) ? entry.dependencies : []
    )
      .map((depName) =>
        typeof depName === "string" ? refByName.get(depName) : undefined,
      )
      .filter(Boolean);
    edges.push({ ref, dependsOn: [...new Set(dependsOn)].sort() });
  }
  const rootInputs = [...directNames]
    .map((name) => refByName.get(name))
    .filter(Boolean);
  return {
    pkgList,
    dependencies: edges,
    parentComponent,
    rootInputs,
    lockEntries: lockedEntries.length,
  };
}

/**
 * Build a component-like package record for a Nim package.
 *
 * @param {string} name Package name
 * @param {string|undefined} version Resolved version, if known
 * @param {object} opts Extra context (`direct`, `vcsRevision`, `srcFile`)
 * @returns {object} Package record
 */
function nimPackage(name, version, opts) {
  const purl = tryBuildPurl({
    type: "generic",
    name,
    version: version || undefined,
  });
  const properties = [
    { name: "internal:SrcFile", value: opts.srcFile },
    { name: "cdx:purl:proposedType", value: "nim" },
    {
      name: "cdx:nim:dependency",
      value: opts.direct ? "direct" : "transitive",
    },
  ];
  if (opts.vcsRevision) {
    properties.push({ name: "cdx:nim:vcsRevision", value: opts.vcsRevision });
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
 * Read the assignments and requirements of a `.nimble` file.
 *
 * @param {string} filePath File to read
 * @returns {{name?: string, version?: string, description?: string, license?: string, requires: Array<{name: string, constraint?: string}>}}
 */
export function readNimbleFile(filePath) {
  const result = { requires: [] };
  let text;
  try {
    text = readFileSync(filePath, "utf-8");
  } catch (error) {
    console.warn(`Failed to read ${filePath}: ${error.message}`);
    return result;
  }
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const assignment = line.match(
      /^(name|version|description|license)\s*=\s*"([^"]*)"/u,
    );
    if (assignment) {
      const value = assignment[2];
      if (value) {
        result[assignment[1]] = value;
      }
      continue;
    }
    const requires = line.match(/^requires\s+"([^"]+)"/u);
    if (requires) {
      const tokens = requires[1].split(/\s+/u);
      const first = tokens[0];
      const constraint = tokens.slice(1).join(" ");
      if (first.startsWith("http") || first.includes("://")) {
        // URL requirements are identified by the repository name, which is
        // how nimble itself keys them in the lock file. A trailing .nim
        // extension is dropped because the lock keys by the bare name.
        const withoutExtension = first.split(/[?#]/u)[0].replace(/\.git$/u, "");
        const segments = withoutExtension.split("/").filter(Boolean);
        const repoName = segments[segments.length - 1] || first;
        result.requires.push({
          name: repoName.replace(/\.nim$/iu, ""),
          constraint,
        });
        continue;
      }
      result.requires.push({ name: first, constraint });
    }
  }
  return result;
}
