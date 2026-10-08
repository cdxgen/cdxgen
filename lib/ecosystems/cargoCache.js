import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

import * as toml from "smol-toml";
import { Parser as TarParser, t as tarList } from "tar";
import { readEnvironmentVariable } from "../core/activity.js";
import { safeExistsSync } from "../core/fs.js";
import { parseToml } from "../core/toml.js";

/**
 * Crate metadata read from the local Cargo registry, without any network.
 *
 * Cargo keeps two things under `$CARGO_HOME/registry` that together answer
 * most of what the crates.io API is asked for:
 *
 *   - `src/<registry>/<name>-<version>/Cargo.toml` — the manifest Cargo
 *     normalised at publish time, carrying the crate's license, description,
 *     repository, homepage and minimum toolchain.
 *   - `index/<registry>/.cache/<a>/<b>/<name>` — the sparse index cache, one
 *     JSON line per published version with its checksum, feature table, yanked
 *     flag and publish time.
 *
 * Reading them first matters because crates.io's crawler policy allows one
 * request per second: a 200-crate lockfile is several minutes of waiting that
 * a populated `~/.cargo` makes unnecessary.
 *
 * What the local cache cannot supply is publisher identity. The index records
 * when a version was published but not by whom, so the publisher-drift and
 * ownership signals in `collectCargoRegistryProvenanceProperties` have no
 * local equivalent. A component served from here is marked
 * `cdx:cargo:metadataSource=local-registry` so a consumer can tell why those
 * properties are absent, and `CARGO_METADATA_SOURCE=registry` forces the
 * network path for runs that need them.
 */

/**
 * One crate version as the local registry describes it.
 *
 * @typedef {Object} CargoCacheMetadata
 * @property {string} [description] Crate description.
 * @property {string} [license] SPDX license expression.
 * @property {string} [repository] Source repository URL.
 * @property {string} [homepage] Homepage URL.
 * @property {string} [rustVersion] Minimum supported Rust version.
 * @property {string} [checksum] SHA-256 of the published `.crate` archive.
 * @property {Object} [features] Feature table.
 * @property {boolean} [yanked] Whether this version was yanked.
 * @property {string} [publishTime] RFC 3339 publish timestamp.
 * @property {string} [latestVersion] Newest non-yanked version in the index.
 * @property {string[]} sources Which local files answered, for provenance.
 */

/** Parsed index entries, keyed by crate name. A scan asks for the same crate
 * repeatedly across workspace members, and these files hold every version ever
 * published — serde's is over 300 lines. */
let _indexCache = new Map();

/** Registry directories discovered under the Cargo home, memoized per run. */
let _registryDirs;

/**
 * Reset memoized state. Tests that point `CARGO_HOME` at a fixture need the
 * next call to look again rather than reuse the previous run's answer.
 *
 * @returns {void}
 */
export function resetCargoCacheState() {
  _indexCache = new Map();
  _registryDirs = undefined;
}

/**
 * Whether the local registry should be consulted before crates.io.
 *
 * @returns {boolean} false when `CARGO_METADATA_SOURCE=registry` opts out.
 */
export function localCargoMetadataEnabled() {
  return (
    readEnvironmentVariable("CARGO_METADATA_SOURCE")?.toLowerCase() !==
    "registry"
  );
}

/**
 * Resolve the Cargo registry root.
 *
 * @returns {string} Absolute path to `$CARGO_HOME/registry`.
 */
export function getCargoRegistryDir() {
  return resolve(
    readEnvironmentVariable("CARGO_HOME") || join(homedir(), ".cargo"),
    "registry",
  );
}

/**
 * List the per-registry directories under `src` and `index`.
 *
 * Each configured registry gets its own directory named after a hash of its
 * URL (`index.crates.io-1949cf8c6b5b557f`). A machine that also pulls from a
 * private registry has more than one, and the crate being looked up may live
 * in any of them, so all are searched.
 *
 * @returns {{src: string[], index: string[], cache: string[]}} Absolute
 *   directory paths.
 */
function registryDirs() {
  if (_registryDirs) {
    return _registryDirs;
  }
  const root = getCargoRegistryDir();
  _registryDirs = { src: [], index: [], cache: [] };
  for (const kind of ["src", "index", "cache"]) {
    const base = join(root, kind);
    try {
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          _registryDirs[kind].push(join(base, entry.name));
        }
      }
    } catch {
      // No Cargo home, or no registry of this kind: the caller falls back to
      // the network.
    }
  }
  return _registryDirs;
}

/**
 * Read everything the local registry knows about one crate version.
 *
 * @param {string} name Crate name.
 * @param {string} version Exact version.
 * @returns {CargoCacheMetadata|undefined} Metadata, or undefined when neither
 *   local source has this crate.
 */
export async function readCargoCacheMetadata(name, version) {
  if (!name || !version) {
    return undefined;
  }
  const sources = [];
  const result = { sources };
  const manifest = readExtractedManifest(name, version);
  if (manifest) {
    Object.assign(result, manifest.values);
    sources.push(manifest.source);
  }
  const archive = await readCachedCrateArchive(name, version);
  if (archive) {
    for (const [key, value] of Object.entries(archive.values)) {
      if (result[key] === undefined) {
        result[key] = value;
      }
    }
    sources.push(archive.source);
  }
  const index = readIndexEntry(name, version);
  if (index) {
    // The manifest is authoritative for the fields both carry, since it is the
    // file Cargo itself compiles against; the index adds what it alone knows.
    for (const [key, value] of Object.entries(index.values)) {
      if (result[key] === undefined) {
        result[key] = value;
      }
    }
    sources.push(index.source);
  }
  return sources.length ? result : undefined;
}

/**
 * A `.crate` archive larger than this is not opened for its manifest. Crates
 * this size are rare, and the archive may be untrusted input.
 */
const CRATE_ARCHIVE_MAX_BYTES = 16 * 1024 * 1024;

/**
 * An archive that unpacks to more than this is not read, so a small archive
 * that expands without bound costs bounded time and memory.
 */
const CRATE_UNPACKED_MAX_BYTES = 64 * 1024 * 1024;

/**
 * A single entry larger than this is not read out of a `.crate` archive.
 */
const CRATE_ENTRY_MAX_BYTES = 1024 * 1024;

/**
 * The `license-file` of a manifest as a path inside the crate, or undefined
 * when it points anywhere else. The manifest is the crate author's, so a path
 * that climbs out of the crate must never be followed.
 *
 * @param {*} licenseFile The manifest's `license-file` value
 * @returns {string|undefined} Normalised relative path
 */
function crateLicenseFilePath(licenseFile) {
  if (typeof licenseFile !== "string" || !licenseFile.trim()) {
    return undefined;
  }
  const normalized = posix.normalize(licenseFile.trim().replaceAll("\\", "/"));
  if (
    normalized.startsWith("/") ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    /^[A-Za-z]:/.test(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

/**
 * The unpacked tar data of a `.crate` archive, within the size bounds.
 *
 * @param {string} crateFile Path to the `.crate` archive (a gzipped tar)
 * @returns {Buffer|undefined}
 */
function unpackCrateArchive(crateFile) {
  try {
    if (statSync(crateFile).size > CRATE_ARCHIVE_MAX_BYTES) {
      return undefined;
    }
    return gunzipSync(readFileSync(crateFile), {
      maxOutputLength: CRATE_UNPACKED_MAX_BYTES,
    });
  } catch {
    // An unreadable archive, or one that unpacks past the bound, is the same
    // as none: the network path answers.
    return undefined;
  }
}

/**
 * Read one file out of unpacked `.crate` tar data.
 *
 * @param {Buffer} tarData Unpacked tar data
 * @param {string} entryName Entry path relative to the archive root
 * @returns {Promise<string|undefined>} The entry's text, or undefined
 */
function readCrateArchiveEntry(tarData, entryName) {
  return new Promise((resolvePromise) => {
    let content;
    const parser = new TarParser({
      onReadEntry: (entry) => {
        const path = entry.path.startsWith("./")
          ? entry.path.slice(2)
          : entry.path;
        if (
          content !== undefined ||
          path !== entryName ||
          entry.size > CRATE_ENTRY_MAX_BYTES
        ) {
          entry.resume();
          return;
        }
        const chunks = [];
        entry.on("data", (chunk) => chunks.push(chunk));
        entry.on("end", () => {
          content = Buffer.concat(chunks).toString("utf-8");
        });
      },
    });
    parser.on("error", () => resolvePromise(undefined));
    parser.on("close", () => resolvePromise(content));
    parser.end(tarData);
  });
}

/**
 * The manifest values of a `.crate` archive, read without extracting it.
 *
 * @param {string} crateFile Path to the `.crate` archive
 * @param {string} name Crate name, for the archive's inner directory
 * @param {string} version Crate version
 * @returns {Promise<{values: Object, source: string}|undefined>}
 */
export async function readCrateArchiveValues(crateFile, name, version) {
  if (!name || !version) {
    return undefined;
  }
  const tarData = unpackCrateArchive(crateFile);
  if (!tarData) {
    return undefined;
  }
  const prefix = `${name}-${version}`;
  const manifestData = await readCrateArchiveEntry(
    tarData,
    `${prefix}/Cargo.toml`,
  );
  if (!manifestData) {
    return undefined;
  }
  let parsed;
  try {
    parsed = toml.parse(manifestData);
  } catch {
    return undefined;
  }
  const pkg = parsed?.package;
  if (!pkg || typeof pkg !== "object") {
    return undefined;
  }
  const values = {};
  assignString(values, "description", pkg.description);
  assignString(values, "repository", pkg.repository);
  assignString(values, "homepage", pkg.homepage);
  assignString(values, "rustVersion", pkg["rust-version"]);
  assignString(values, "license", pkg.license);
  const licenseFile = crateLicenseFilePath(pkg["license-file"]);
  if (licenseFile && !values.license) {
    assignLicenseText(
      values,
      await readCrateArchiveEntry(tarData, `${prefix}/${licenseFile}`),
    );
  }
  return { values, source: crateFile };
}

/**
 * The `.crate` archive of a crate version held in the registry cache, which is
 * the only local copy of a crate the build downloaded but never compiled.
 *
 * @param {string} name Crate name.
 * @param {string} version Exact version.
 * @returns {Promise<{values: Object, source: string}|undefined>}
 */
async function readCachedCrateArchive(name, version) {
  for (const dir of registryDirs().cache) {
    const crateFile = join(dir, `${name}-${version}.crate`);
    if (!safeExistsSync(crateFile)) {
      continue;
    }
    const archive = await readCrateArchiveValues(crateFile, name, version);
    if (archive) {
      return archive;
    }
  }
  return undefined;
}

/**
 * Record a `license-file` notice as a component licence, following the shape
 * cdxgen records licence file text in elsewhere: a CUSTOM licence name with
 * the notice as its text.
 *
 * @param {Object} values Manifest values so far, updated in place
 * @param {string|undefined} text The notice text
 */
function assignLicenseText(values, text) {
  if (!text?.length) {
    return;
  }
  values.licenses = [
    {
      license: {
        name: "CUSTOM",
        text: { contentType: "text/plain", content: text },
      },
    },
  ];
}

/**
 * Read the normalised `Cargo.toml` of an extracted crate.
 *
 * @param {string} name Crate name.
 * @param {string} version Exact version.
 * @returns {{values: Object, source: string}|undefined}
 */
function readExtractedManifest(name, version) {
  for (const dir of registryDirs().src) {
    const manifestFile = join(dir, `${name}-${version}`, "Cargo.toml");
    if (!safeExistsSync(manifestFile)) {
      continue;
    }
    let parsed;
    try {
      parsed = parseToml(readFileSync(manifestFile, "utf-8"));
    } catch {
      // A manifest that does not parse is not worth a warning: the network
      // path still has the answer.
      continue;
    }
    const pkg = parsed?.package;
    if (!pkg || typeof pkg !== "object") {
      continue;
    }
    const values = {};
    assignString(values, "description", pkg.description);
    assignString(values, "repository", pkg.repository);
    assignString(values, "homepage", pkg.homepage);
    assignString(values, "rustVersion", pkg["rust-version"]);
    // A crate may carry `license` or, for a non-SPDX license, `license-file`.
    // The expression is used as the licence; a licence file is recorded as a
    // CUSTOM licence carrying the notice text, the way cdxgen records licence
    // file text elsewhere.
    assignString(values, "license", pkg.license);
    const licenseFile = crateLicenseFilePath(pkg["license-file"]);
    if (licenseFile && !values.license) {
      try {
        assignLicenseText(
          values,
          readFileSync(join(dir, `${name}-${version}`, licenseFile), {
            encoding: "utf-8",
          }),
        );
      } catch {
        // A licence file that cannot be read leaves the licence to the network
        // path, exactly as an absent one does.
      }
    }
    if (parsed.features && typeof parsed.features === "object") {
      values.features = parsed.features;
    }
    return { values, source: manifestFile };
  }
  return undefined;
}

/**
 * Read one version's entry from the sparse index cache.
 *
 * The cache file is a small binary envelope: a version byte, the index format
 * version, then NUL-separated fields holding the registry revision followed by
 * alternating version strings and JSON blobs. Rather than decode the header,
 * every NUL-separated chunk that parses as JSON carrying a `vers` field is
 * taken, which keeps working if Cargo revises the envelope.
 *
 * @param {string} name Crate name.
 * @param {string} version Exact version.
 * @returns {{values: Object, source: string}|undefined}
 */
function readIndexEntry(name, version) {
  const entries = indexEntriesFor(name);
  if (!entries) {
    return undefined;
  }
  const match = entries.byVersion.get(version);
  if (!match) {
    return undefined;
  }
  const values = {};
  assignString(values, "checksum", match.cksum);
  if (match.features && typeof match.features === "object") {
    values.features = match.features;
  }
  if (typeof match.yanked === "boolean") {
    values.yanked = match.yanked;
  }
  assignString(values, "publishTime", match.pubtime);
  assignString(values, "rustVersion", match.rust_version);
  assignString(values, "latestVersion", entries.latestVersion);
  return { values, source: entries.source };
}

/**
 * Parse and memoize the index cache file for one crate.
 *
 * @param {string} name Crate name.
 * @returns {{byVersion: Map<string, Object>, latestVersion: string|undefined, source: string}|undefined}
 */
function indexEntriesFor(name) {
  if (_indexCache.has(name)) {
    return _indexCache.get(name);
  }
  const parsed = parseIndexCacheFile(name);
  _indexCache.set(name, parsed);
  return parsed;
}

/**
 * Locate and parse a crate's index cache file.
 *
 * @param {string} name Crate name.
 * @returns {{byVersion: Map<string, Object>, latestVersion: string|undefined, source: string}|undefined}
 */
function parseIndexCacheFile(name) {
  for (const dir of registryDirs().index) {
    const path = indexCachePath(dir, name);
    if (!path) {
      continue;
    }
    let raw;
    try {
      if (!statSync(path).isFile()) {
        continue;
      }
      raw = readFileSync(path);
    } catch {
      continue;
    }
    const byVersion = new Map();
    for (const chunk of raw.toString("utf-8").split("\u0000")) {
      if (!chunk.startsWith("{")) {
        continue;
      }
      let entry;
      try {
        entry = JSON.parse(chunk);
      } catch {
        continue;
      }
      if (typeof entry?.vers === "string" && entry.vers) {
        byVersion.set(entry.vers, entry);
      }
    }
    if (!byVersion.size) {
      continue;
    }
    return {
      byVersion,
      latestVersion: newestVersion(byVersion),
      source: path,
    };
  }
  return undefined;
}

/**
 * Build the `.cache` path Cargo uses for a crate name.
 *
 * Names are bucketed by length: one character goes under `1/`, two under `2/`,
 * three under `3/<first letter>/`, and four or more under the first two
 * characters then the next two.
 *
 * @param {string} indexDir The registry's index directory.
 * @param {string} name Crate name.
 * @returns {string|undefined} Absolute path, or undefined for an unusable name.
 */
function indexCachePath(indexDir, name) {
  const lower = name.toLowerCase();
  if (!lower.length) {
    return undefined;
  }
  const cacheDir = join(indexDir, ".cache");
  if (lower.length === 1) {
    return join(cacheDir, "1", lower);
  }
  if (lower.length === 2) {
    return join(cacheDir, "2", lower);
  }
  if (lower.length === 3) {
    return join(cacheDir, "3", lower.slice(0, 1), lower);
  }
  return join(cacheDir, lower.slice(0, 2), lower.slice(2, 4), lower);
}

/**
 * Pick the newest non-yanked version from an index file.
 *
 * The index is written in publish order, so the last entry that was not yanked
 * is the version crates.io would call newest. No semver comparison is done:
 * a patch release for an older line is published after the newer line and
 * would win a naive ordering, but it is also what the registry reports as most
 * recent, so publish order is the honest reading.
 *
 * @param {Map<string, Object>} byVersion Parsed entries in file order.
 * @returns {string|undefined} Newest version.
 */
function newestVersion(byVersion) {
  let newest;
  for (const [version, entry] of byVersion) {
    if (entry?.yanked !== true) {
      newest = version;
    }
  }
  return newest;
}

/**
 * Copy a value onto the target when it is a usable string.
 *
 * @param {Object} target Accumulator.
 * @param {string} key Field name.
 * @param {*} value Candidate value.
 * @returns {void}
 */
function assignString(target, key, value) {
  if (typeof value === "string" && value.length) {
    target[key] = value;
  }
}
