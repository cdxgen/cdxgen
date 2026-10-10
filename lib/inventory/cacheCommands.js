/**
 * `cdxgen cache` subcommand — inspect and purge the metadata fetch cache that
 * cdxrs and the JS batch pool share.
 *
 * This module operates directly on the filesystem because JS is the authority
 * for the cache directory. The cache layout is:
 *   <cacheDir>/cdxrs-fetch/<host>/<hash>.json
 */

import { readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

import { fetchCacheDir, resolveCacheDir } from "./cacheDir.js";

/**
 * Walk a directory tree and return all regular files.
 *
 * @param {string} dir Directory to walk.
 * @returns {string[]} Absolute file paths.
 */
function walkFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(fullPath));
    } else if (entry.isFile()) {
      out.push(fullPath);
    }
  }
  return out;
}

/**
 * Gather statistics about the fetch cache.
 *
 * @returns {Object} Cache info: directory, entryCount, totalBytes,
 *   perHost breakdown, oldestMtime, newestMtime.
 */
export function cacheInfo() {
  const cacheDir = resolveCacheDir();
  if (!cacheDir) {
    return {
      directory: null,
      entryCount: 0,
      totalBytes: 0,
      hosts: {},
      message: "No cache directory could be resolved.",
    };
  }
  const fetchDir = fetchCacheDir(cacheDir);
  const files = walkFiles(fetchDir);

  let totalBytes = 0;
  let oldestMtime = null;
  let newestMtime = null;
  const hosts = {};

  for (const file of files) {
    let stat;
    try {
      stat = statSync(file);
    } catch {
      continue;
    }
    totalBytes += stat.size;
    const mtime = stat.mtimeMs;
    if (oldestMtime === null || mtime < oldestMtime) {
      oldestMtime = mtime;
    }
    if (newestMtime === null || mtime > newestMtime) {
      newestMtime = mtime;
    }

    // Extract host from path: .../cdxrs-fetch/<host>/<hash>.json
    const host = path.basename(path.dirname(file));
    if (!hosts[host]) {
      hosts[host] = { entries: 0, bytes: 0 };
    }
    hosts[host].entries++;
    hosts[host].bytes += stat.size;
  }

  return {
    directory: cacheDir,
    fetchDirectory: fetchDir,
    entryCount: files.length,
    totalBytes,
    hosts,
    oldestMtime,
    newestMtime,
  };
}

/**
 * Remove all entries from the fetch cache.
 *
 * @returns {Object} Result with removedCount, freedBytes, directory.
 */
export function cacheClear() {
  const cacheDir = resolveCacheDir();
  if (!cacheDir) {
    return {
      directory: null,
      removedCount: 0,
      freedBytes: 0,
      message: "No cache directory could be resolved.",
    };
  }
  const fetchDir = fetchCacheDir(cacheDir);
  const info = cacheInfo();
  try {
    rmSync(fetchDir, { recursive: true, force: true });
  } catch {
    // Best effort — a locked file on Windows should not fail the command.
  }
  return {
    directory: cacheDir,
    removedCount: info.entryCount,
    freedBytes: info.totalBytes,
  };
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Run the cache subcommand and print results.
 *
 * @param {"info"|"clear"} action What to do.
 * @returns {Promise<number>} Exit code.
 */
export async function runCacheCommand(action) {
  if (action === "clear") {
    const result = cacheClear();
    if (!result.directory) {
      console.log(result.message);
      return 0;
    }
    console.log(`Cleared cache: ${result.directory}`);
    console.log(
      `  Removed ${result.removedCount} entr${result.removedCount === 1 ? "y" : "ies"}, freed ${formatBytes(result.freedBytes)}`,
    );
    return 0;
  }

  // Default: info
  const info = cacheInfo();
  if (!info.directory) {
    console.log(info.message);
    return 0;
  }
  console.log(`Cache directory: ${info.directory}`);
  console.log(`  Entries: ${info.entryCount}`);
  console.log(`  Total size: ${formatBytes(info.totalBytes)}`);
  if (info.oldestMtime) {
    console.log(`  Oldest entry: ${new Date(info.oldestMtime).toISOString()}`);
    console.log(`  Newest entry: ${new Date(info.newestMtime).toISOString()}`);
  }
  const hostEntries = Object.entries(info.hosts).sort(
    (a, b) => b[1].bytes - a[1].bytes,
  );
  if (hostEntries.length) {
    console.log("  Per-host breakdown:");
    for (const [host, stats] of hostEntries) {
      console.log(
        `    ${host}: ${stats.entries} entries, ${formatBytes(stats.bytes)}`,
      );
    }
  }
  return 0;
}
