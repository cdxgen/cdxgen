import {
  DEBUG_MODE,
  isSecureMode,
  readEnvironmentVariable,
  recordSensitiveFileRead,
} from "../core/activity.js";
import { readScanFileText } from "../core/boundedFile.js";
import { safeExistsSync } from "../core/fs.js";
import { fallbackBomRef } from "../inventory/purl.js";
import { parseBuildZigZon, parseBuildZigZonContent } from "./parsers-zig.js";

// The largest build.zig.zon read for a dependency.
const MAX_ZON_BYTES = 4 * 1024 * 1024;

/**
 * Zig transitive dependency resolver.
 *
 * Zig has no central registry. A dependency is a content-addressed archive
 * whose identity is its `.hash`. The same hash string is used as a filesystem
 * lookup key across every Zig version — only the container differs (in-tree
 * `zig-pkg/` directory, extracted cache directory, or cache `.tar.gz`
 * archive). This module walks the full dependency graph by locating each
 * dependency's `build.zig.zon` through those containers, then emits a flat
 * component list plus a CycloneDX `dependencies[]` edge list.
 *
 * Resolution is a pure filesystem walk keyed on hashes already present in the
 * manifests. No subprocess, no network, no toolchain. Populating the cache
 * (`zig build --fetch`) is the user's job.
 */

// ---------------------------------------------------------------------------
// Hash validation — path-traversal guard
// ---------------------------------------------------------------------------

/**
 * Validate a Zig `.hash` string against the two known encodings before it is
 * used to build a filesystem path.
 *
 * A `.hash` is attacker-controlled data from a manifest. Joining it blindly
 * into `<cache>/p/<hash>/build.zig.zon` would let a `../` in the hash escape
 * the cache directory. The two legal encodings never contain path separators
 * or `..` segments, so any hash that does not match one of them is refused
 * before the filesystem is touched.
 *
 * The two forms are:
 *   1. 0.14+ — `<name>-<version>-<base64url digest>` where the digest uses
 *      `[A-Za-z0-9_-]`.
 *   2. Pre-0.14 — hex multihash, all hex digits (at least 4 characters).
 *
 * @param {string|undefined} hash Hash field value from the manifest
 * @returns {boolean} `true` only when the hash matches a known Zig encoding
 */
export function isValidZigHash(hash) {
  if (!hash || typeof hash !== "string") {
    return false;
  }
  // Reject any path separator or parent-directory sequence regardless of the
  // regex below — a doubled safety net that costs nothing.
  if (hash.includes("/") || hash.includes("\\") || hash.includes("..")) {
    return false;
  }
  // 0.14+ form: <identifier>-<version>-<base64url digest>
  if (/^[A-Za-z_][A-Za-z0-9_]*-\d[^-]*-[A-Za-z0-9_-]+$/.test(hash)) {
    return true;
  }
  // Pre-0.14 hex multihash (all hex digits, at least 4)
  if (/^[0-9a-fA-F]{4,}$/.test(hash)) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Global cache resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the Zig global package cache directory.
 *
 * Order: `ZIG_GLOBAL_CACHE_DIR`, then `$XDG_CACHE_HOME/zig`, then
 * `~/.cache/zig` on Linux **and macOS** (macOS uses `~/.cache/zig`, *not*
 * `Library/Caches` — confirmed empirically), then `%LOCALAPPDATA%\zig` on
 * Windows.
 *
 * @returns {string|null} Absolute cache directory path, or null when it cannot
 *   be determined
 */
export function getZigGlobalCacheDir() {
  const explicit = readEnvironmentVariable("ZIG_GLOBAL_CACHE_DIR");
  if (explicit) {
    return explicit;
  }
  if (process.platform === "win32") {
    const localAppData = readEnvironmentVariable("LOCALAPPDATA");
    if (localAppData) {
      return `${localAppData}\\zig`;
    }
    return null;
  }
  const xdgCache = readEnvironmentVariable("XDG_CACHE_HOME");
  if (xdgCache) {
    return `${xdgCache}/zig`;
  }
  const home = readEnvironmentVariable("HOME");
  if (home) {
    return `${home}/.cache/zig`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Manifest location
// ---------------------------------------------------------------------------

/**
 * Attempt to read a dependency's manifest from the in-tree
 * `zig-pkg/<hash>/build.zig.zon` directory.
 *
 * This is the Zig 0.16+ layout and is preferred because it lives inside the
 * scan root — no home-directory access, no `recordSensitiveFileRead`, and it
 * works under secure mode.
 *
 * @param {string} hash Validated package hash
 * @param {string} projectRoot The project scan root
 * @returns {{ path: string, content: string } | null}
 */
function tryInTreeManifest(hash, projectRoot) {
  const candidate = `${projectRoot}/zig-pkg/${hash}/build.zig.zon`;
  // A zig-pkg entry that links out of the scan root is not read.
  const content = readScanFileText(candidate, MAX_ZON_BYTES, projectRoot);
  if (content !== undefined) {
    return { path: candidate, content };
  }
  return null;
}

/**
 * Attempt to locate a dependency's manifest in the extracted global cache
 * directory `<cache>/p/<hash>/build.zig.zon`.
 *
 * This is the Zig 0.14/0.15 layout. Reads leave the scan root, so the path is
 * recorded via `recordSensitiveFileRead`.
 *
 * @param {string} hash Validated package hash
 * @param {string} cacheDir Global cache directory
 * @returns {{ path: string, content: string } | null}
 */
function tryCacheDirManifest(hash, cacheDir) {
  if (!cacheDir) {
    return null;
  }
  const candidate = `${cacheDir}/p/${hash}/build.zig.zon`;
  if (!safeExistsSync(candidate)) {
    return null;
  }
  recordSensitiveFileRead(candidate, {
    label: "Zig global cache manifest (extracted directory)",
  });
  const content = readScanFileText(candidate, MAX_ZON_BYTES, cacheDir);
  return content === undefined ? null : { path: candidate, content };
}

/**
 * Read the `build.zig.zon` entry from a `.tar.gz` cache archive by streaming
 * the single entry, never extracting the whole archive to disk.
 *
 * This is the Zig 0.16 global-cache archive form. The entry lives at
 * `<hash>/build.zig.zon` inside the archive.
 *
 * @param {string} hash Validated package hash
 * @param {string} cacheDir Global cache directory
 * @returns {Promise<{ path: null, content: string } | null>}
 */
async function tryArchiveManifest(hash, cacheDir) {
  if (!cacheDir) {
    return null;
  }
  const archivePath = `${cacheDir}/p/${hash}.tar.gz`;
  if (!safeExistsSync(archivePath)) {
    return null;
  }
  recordSensitiveFileRead(archivePath, {
    label: "Zig global cache archive",
  });
  // Archives are packed either with the hash directory as the single root
  // entry or with the manifest at the archive root, and tar writers vary on
  // whether they prefix paths with `./`. Matching on the trailing path rather
  // than one exact string covers all of those without extracting anything.
  const isManifestEntry = (entryPath) =>
    entryPath.replace(/^\.\//, "") === "build.zig.zon" ||
    entryPath.endsWith("/build.zig.zon");
  try {
    const { t: listTarEntries } = await import("tar");
    const content = await new Promise((resolve, reject) => {
      let result = null;
      listTarEntries({
        file: archivePath,
        gzip: true,
        filter: (p) => result === null && isManifestEntry(p),
        onentry: (entry) => {
          const chunks = [];
          let size = 0;
          entry.on("data", (chunk) => {
            size += chunk.length;
            if (size <= MAX_ZON_BYTES) {
              chunks.push(chunk);
            }
          });
          entry.on("end", () => {
            if (size <= MAX_ZON_BYTES) {
              result = Buffer.concat(chunks).toString("utf-8");
            }
          });
        },
      })
        .then(() => resolve(result))
        .catch(reject);
    });
    if (content) {
      return { path: null, content };
    }
    return null;
  } catch (err) {
    if (DEBUG_MODE) {
      console.warn(
        `Failed to read build.zig.zon from ${archivePath}: ${err.message}`,
      );
    }
    return null;
  }
}

/**
 * Locate a dependency's `build.zig.zon` by trying, in order, the in-tree
 * `zig-pkg/` directory, the extracted cache directory, and the cache archive.
 *
 * The in-tree path is tried first because it is inside the scan root and
 * needs no sensitive-file recording or secure-mode bypass. Global-cache
 * reads are skipped under secure mode; the caller degrades to direct-only
 * output with the component still present.
 *
 * @param {string} hash Validated package hash
 * @param {string} projectRoot The project scan root
 * @param {string|null} cacheDir Global cache directory (null when unresolved)
 * @returns {Promise<{ path: string|null, content: string|null } | null>}
 */
async function findManifestForHash(hash, projectRoot, cacheDir) {
  // 1. In-tree zig-pkg/ — always tried, works under secure mode.
  const inTree = tryInTreeManifest(hash, projectRoot);
  if (inTree) {
    return inTree;
  }

  // Global-cache reads leave the scan root.
  if (isSecureMode) {
    return null;
  }

  // 2. Extracted cache directory (0.14/0.15).
  const cacheDirResult = tryCacheDirManifest(hash, cacheDir);
  if (cacheDirResult) {
    return cacheDirResult;
  }

  // 3. Cache archive (0.16 global-cache form).
  const archiveResult = await tryArchiveManifest(hash, cacheDir);
  return archiveResult;
}

/**
 * The most bom-refs (field names or URLs) one package hash is reported under.
 * Every alias of a hash carries a copy of its dependency edges.
 */
const MAX_REFS_PER_HASH = 16;

// ---------------------------------------------------------------------------
// Component helpers
// ---------------------------------------------------------------------------

/**
 * Extract the `cdx:zig:hash` property value from a parsed component.
 *
 * @param {object} pkg Component built by `buildZigPackage`
 * @returns {string|undefined} The raw hash string, or undefined
 */
function getHashFromComponent(pkg) {
  const prop = pkg.properties?.find((p) => p.name === "cdx:zig:hash");
  return prop?.value;
}

/**
 * Parse a manifest from a file path or raw ZON content.
 *
 * @param {{ path: string|null, content: string|null }} location
 * @returns {{ pkgList: object[] } | null}
 */
function parseManifestAt(location) {
  if (!location) {
    return null;
  }
  if (typeof location.content === "string") {
    return parseBuildZigZonContent(
      location.content,
      location.path || undefined,
    );
  }
  if (location.path) {
    return parseBuildZigZon(location.path);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Walk the full Zig dependency graph starting from a root `build.zig.zon`,
 * returning a flat component list and a CycloneDX `dependencies[]` edge list.
 *
 * For each dependency carrying a `.hash`, the resolver locates the
 * dependency's own `build.zig.zon` and recurses. Hashes are memoised so
 * diamond dependencies do not re-read manifests.
 *
 * Unresolvable hashes (cache not populated) degrade gracefully: the component
 * still appears with no outgoing edges, and the count is returned so callers
 * can report a partial graph.
 *
 * @param {string} rootZonFile Absolute path to the root `build.zig.zon`
 * @param {string} projectRoot The project scan root
 * @param {object} [options] CLI options (reserved for future use)
 * @returns {Promise<{ pkgList: object[], dependencies: object[], parentComponent: object, unresolvedCount: number }>}
 */
export async function resolveZigGraph(rootZonFile, projectRoot, options = {}) {
  const { pkgList, dependencies, parentComponents, unresolvedCount } =
    await resolveZigGraphs([rootZonFile], projectRoot, options);
  return {
    pkgList,
    dependencies,
    parentComponent: parentComponents[0],
    unresolvedCount,
  };
}

/**
 * Walk the Zig dependency graphs of several root `build.zig.zon` files, such
 * as the members of a workspace, over one set of memo tables, so a dependency
 * the roots share is read and walked once.
 *
 * Each hash is walked once, and every component that names it gets the
 * dependencies found there; two hashes that give one bom-ref (one name and
 * version, pinned to different commits) both add theirs. A hash named under
 * more than MAX_REFS_PER_HASH bom-refs (field names or URLs) resolves to the
 * first one from then on, since every further alias would copy all its edges.
 *
 * @param {string[]} rootZonFiles Absolute paths of the root manifests
 * @param {string} projectRoot The project scan root
 * @param {object} [_options] CLI options (reserved for future use)
 * @returns {Promise<{ pkgList: object[], dependencies: object[], parentComponents: object[], unresolvedCount: number }>}
 */
export async function resolveZigGraphs(
  rootZonFiles,
  projectRoot,
  _options = {},
) {
  const cacheDir = getZigGlobalCacheDir();

  // hash → the dependency components declared by the manifest that hash
  // resolved to, or null when no container held it. Memoised in both
  // directions so a diamond dependency reads its manifest once and an
  // unpopulated cache is probed once per hash rather than once per edge.
  const hashToPkgs = new Map();

  // hash → the bom-refs of the dependencies its manifest declares. Set
  // before the walk below it, so a cycle in a tampered cache ends there.
  const hashToDeps = new Map();

  // hash → the distinct bom-refs it was named under.
  const hashToRefs = new Map();

  // `${bom-ref}\0${hash}` pairs whose edges were recorded.
  const claimed = new Set();

  // Component map: bom-ref → component. Deduplicates across the graph.
  const components = new Map();

  // Edge map: bom-ref → Set<bom-ref>. Keys are parents; values are their
  // direct dependencies' bom-refs.
  const edges = new Map();

  // Hashes whose manifest could not be located in any container.
  const unresolvedHashes = new Set();

  /**
   * Record a set of dependency components and walk each one's own hash,
   * returning their bom-refs so the caller can attach an edge.
   *
   * @param {object[]} pkgs Dependency components from one manifest
   * @returns {Promise<string[]>} Their bom-refs, in declaration order
   */
  async function walkDeps(pkgs) {
    const refs = [];
    for (const pkg of pkgs) {
      const hash = getHashFromComponent(pkg);
      let ref = pkg["bom-ref"];
      if (hash) {
        const known = hashToRefs.get(hash) || [];
        if (!known.includes(ref)) {
          if (known.length >= MAX_REFS_PER_HASH) {
            ref = known[0];
          } else {
            known.push(ref);
            hashToRefs.set(hash, known);
          }
        }
      }
      refs.push(ref);
      if (!components.has(ref)) {
        components.set(ref, pkg);
      }
      if (!edges.has(ref)) {
        edges.set(ref, new Set());
      }
      if (!hash || claimed.has(`${ref}\0${hash}`)) {
        continue;
      }
      claimed.add(`${ref}\0${hash}`);
      const dependsOn = edges.get(ref);
      for (const dependency of await dependenciesOfHash(hash)) {
        dependsOn.add(dependency);
      }
    }
    return refs;
  }

  /**
   * The bom-refs of the dependencies a hash's manifest declares, walking that
   * manifest the first time the hash is seen.
   *
   * @param {string} hash Package hash
   * @returns {Promise<Set<string>>} Dependency bom-refs; empty when the hash
   *   is invalid or its manifest cannot be found
   */
  async function dependenciesOfHash(hash) {
    if (hashToDeps.has(hash)) {
      return hashToDeps.get(hash);
    }
    // claimed before recursing: a manifest graph is content-addressed and so
    // cannot legitimately contain a cycle, but a hand-written or tampered
    // cache can, and an unclaimed hash would recurse forever
    const dependencies = new Set();
    hashToDeps.set(hash, dependencies);
    if (!isValidZigHash(hash)) {
      unresolvedHashes.add(hash);
      return dependencies;
    }
    const transitives = await resolveHash(hash);
    if (transitives === null) {
      unresolvedHashes.add(hash);
      return dependencies;
    }
    for (const ref of await walkDeps(transitives)) {
      dependencies.add(ref);
    }
    return dependencies;
  }

  /**
   * Locate and parse the manifest a hash names, returning the dependency
   * components it declares.
   *
   * @param {string} hash Validated package hash
   * @returns {Promise<object[]|null>} Declared dependencies, or null when the
   *   manifest cannot be found in any container
   */
  async function resolveHash(hash) {
    if (hashToPkgs.has(hash)) {
      return hashToPkgs.get(hash);
    }
    const location = await findManifestForHash(hash, projectRoot, cacheDir);
    const parsed = location ? parseManifestAt(location) : null;
    const pkgs = parsed ? parsed.pkgList : location ? [] : null;
    hashToPkgs.set(hash, pkgs);
    return pkgs;
  }

  const parentComponents = [];
  for (const rootZonFile of rootZonFiles) {
    const { pkgList: rootPkgs, parentComponent } =
      parseBuildZigZon(rootZonFile);
    // The parent component reaches the BOM through `metadata.component`,
    // which carries no purl, so the graph needs a ref derived the same way
    // the rest of the pipeline derives one for a purl-less component.
    parentComponent["bom-ref"] = fallbackBomRef(parentComponent);
    parentComponents.push(parentComponent);
    const rootDepRefs = await walkDeps(rootPkgs);
    // two roots of the same name and version share a ref and its edges
    const parentRef = parentComponent["bom-ref"];
    if (!edges.has(parentRef)) {
      edges.set(parentRef, new Set());
    }
    for (const ref of rootDepRefs) {
      edges.get(parentRef).add(ref);
    }
  }

  const pkgList = Array.from(components.values());
  const dependencies = Array.from(edges.entries()).map(([ref, deps]) => ({
    ref,
    dependsOn: Array.from(deps),
  }));

  return {
    pkgList,
    dependencies,
    parentComponents,
    unresolvedCount: unresolvedHashes.size,
  };
}
