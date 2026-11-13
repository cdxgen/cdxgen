import { readFileSync } from "node:fs";

import { parse as loadYaml } from "../core/yaml.js";
import { tryBuildPurl } from "../inventory/purl.js";

/**
 * Crystal parser for `shard.yml` and `shard.lock`.
 *
 * Shards resolves dependencies declared in `shard.yml` and records the
 * resolved set in `shard.lock`, which pins each dependency's version and
 * source repository. Both files are YAML and are read with the standard
 * parser.
 *
 * No `crystal` purl type is registered, so shards are identified as generic
 * packages carrying a `cdx:purl:proposedType=crystal` property, following
 * the convention used for nix and zig. This keeps the BOM valid today and
 * allows a mechanical migration if a type is registered upstream.
 */

/**
 * Parse a Crystal project from `shard.yml` and optional `shard.lock`.
 *
 * @param {string} shardYmlFile Path to `shard.yml`
 * @param {string} [shardLockFile] Path to `shard.lock`, if present
 * @returns {{ pkgList: object[], dependencies: object[], parentComponent: object, rootInputs?: string[] }}
 */
export function parseShardsProject(shardYmlFile, shardLockFile) {
  const manifest = readYamlFile(shardYmlFile);

  const parentComponent = {};
  if (typeof manifest?.name === "string" && manifest.name) {
    parentComponent.type = "application";
    parentComponent.name = manifest.name;
    if (typeof manifest.version === "string" && manifest.version) {
      parentComponent.version = manifest.version;
    }
    parentComponent.description =
      typeof manifest.description === "string" && manifest.description
        ? manifest.description
        : `Crystal shard: ${manifest.name}`;
    parentComponent.properties = [
      { name: "internal:SrcFile", value: shardYmlFile },
    ];
    if (typeof manifest.crystal === "string" && manifest.crystal) {
      parentComponent.properties.push({
        name: "cdx:crystal:languageVersion",
        value: manifest.crystal,
      });
    }
  }

  const declared =
    manifest?.dependencies && typeof manifest.dependencies === "object"
      ? Object.keys(manifest.dependencies)
      : [];
  const devDeclared =
    manifest?.development_dependencies &&
    typeof manifest.development_dependencies === "object"
      ? Object.keys(manifest.development_dependencies)
      : [];

  let lock;
  if (shardLockFile) {
    lock = readYamlFile(shardLockFile);
  }
  const lockedShards =
    lock?.shards && typeof lock.shards === "object" ? lock.shards : undefined;
  if (!lockedShards) {
    // Lockless fallback: emit declared dependencies without resolved versions.
    const pkgList = [
      ...declared.map((name) =>
        crystalPackage(name, undefined, {
          direct: true,
          dev: false,
          srcFile: shardYmlFile,
        }),
      ),
      ...devDeclared.map((name) =>
        crystalPackage(name, undefined, {
          direct: true,
          dev: true,
          srcFile: shardYmlFile,
        }),
      ),
    ];
    return {
      pkgList,
      dependencies: [],
      parentComponent,
      rootInputs: pkgList.map((p) => p["bom-ref"]),
    };
  }

  const directNames = new Set(declared);
  const devNames = new Set(devDeclared);
  const pkgList = [];
  const refByName = new Map();
  for (const [name, entry] of Object.entries(lockedShards)) {
    const version =
      typeof entry?.version === "string" && entry.version
        ? entry.version
        : undefined;
    const pkg = crystalPackage(name, version, {
      direct: directNames.has(name),
      dev: devNames.has(name),
      srcFile: shardLockFile,
    });
    pkgList.push(pkg);
    refByName.set(name, pkg["bom-ref"]);
  }

  // shard.lock records no dependency graph between shards, so the root links
  // to the declared set and every other shard stands on its own version pin.
  const rootInputs = [...directNames, ...devNames]
    .map((name) => refByName.get(name))
    .filter(Boolean);
  return { pkgList, dependencies: [], parentComponent, rootInputs };
}

/**
 * Build a component-like package record for a Crystal shard.
 *
 * @param {string} name Shard name
 * @param {string|undefined} version Resolved version, if known
 * @param {object} opts Extra context (`direct`, `dev`, `srcFile`)
 * @returns {object} Package record
 */
function crystalPackage(name, version, opts) {
  const purl = tryBuildPurl({
    type: "generic",
    name,
    version: version || undefined,
  });
  const properties = [
    { name: "internal:SrcFile", value: opts.srcFile },
    { name: "cdx:purl:proposedType", value: "crystal" },
  ];
  if (opts.direct) {
    properties.push({
      name: "cdx:crystal:dependency",
      value: opts.dev ? "direct-dev" : "direct",
    });
  } else {
    properties.push({ name: "cdx:crystal:dependency", value: "transitive" });
  }
  if (opts.dev) {
    properties.push({ name: "cdx:crystal:scope", value: "development" });
  }
  const pkg = {
    name,
    ...(version ? { version } : {}),
    type: "library",
    scope: opts.dev ? "optional" : "required",
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
 * Read and parse a YAML file, warning instead of throwing.
 *
 * @param {string} filePath File to read
 * @returns {object|undefined} Parsed value
 */
function readYamlFile(filePath) {
  try {
    return loadYaml(readFileSync(filePath, "utf-8"));
  } catch (error) {
    console.warn(`Failed to parse ${filePath}: ${error.message}`);
    return undefined;
  }
}
