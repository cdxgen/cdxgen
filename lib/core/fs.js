import { Buffer } from "node:buffer";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  closeSync,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  fchmodSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path, { basename, dirname, join, resolve, sep } from "node:path";
import process from "node:process";
import { pipeline } from "node:stream/promises";

import { Glob, globSync, Ignore } from "glob";

import {
  buildReadCountSuffix,
  classifyActivityPath,
  classifyDiscoveryPattern,
  createDryRunError,
  DEBUG_MODE,
  isDryRun,
  isSecureMode,
  readEnvironmentVariable,
  recordActivity,
  recordDiscoveryActivity,
  recordFilesystemActivity,
  recordObservedActivity,
  recordPolicyActivity,
  recordSymlinkResolution,
} from "./activity.js";
import { isPathInsideProject } from "./lockPaths.js";
import { thoughtLog, traceLog } from "./logger.js";
import { isWin } from "./paths.js";
import { recordExecutedTool } from "./toolRegistry.js";

// The same test env.js applies, kept local because env.js imports this module
// and importing back would form a cycle. parallel.js does the same.
const isDenoRuntime = globalThis.Deno?.version?.deno !== undefined;

function getArchiveSourceByteSize(sourcePath) {
  if (!sourcePath || !safeExistsSync(sourcePath)) {
    return undefined;
  }
  try {
    const sourceStats = lstatSync(sourcePath);
    return sourceStats.isFile() ? sourceStats.size : undefined;
  } catch {
    return undefined;
  }
}

function hasReadPermission(filePath) {
  if (!(isSecureMode && process.permission)) {
    return true;
  }
  return process.permission.has("fs.read", join(filePath, "", "*"));
}

function hasWritePermission(filePath) {
  if (!(isSecureMode && process.permission)) {
    return true;
  }
  const candidatePaths = [
    filePath,
    join(filePath, "", "*"),
    join(dirname(filePath), "*"),
  ];
  return candidatePaths.some((candidatePath) =>
    process.permission.has("fs.write", candidatePath),
  );
}
/**
 * Safely check if a file path exists without crashing due to a lack of permissions
 *
 * @param {String} filePath File path
 * @Boolean True if the path exists. False otherwise
 */
export function safeExistsSync(filePath) {
  const pathMetadata = classifyActivityPath(filePath);
  if (!hasReadPermission(filePath)) {
    if (DEBUG_MODE) {
      console.log("cdxgen lacks read permission for a requested path.");
    }
    if (pathMetadata) {
      recordPolicyActivity(filePath, {
        metadata: {
          classification: pathMetadata.classification,
          ecosystem: pathMetadata.ecosystem,
          policyType: "fs.read",
        },
        reason: `Denied inspection of ${pathMetadata.label} ${filePath} due to missing fs.read permission.`,
        status: "blocked",
      });
    }
    return false;
  }
  const exists = existsSync(filePath);
  if (pathMetadata) {
    const inspectionKind =
      pathMetadata.classification === "directory" ? "discover" : "inspect";
    recordObservedActivity(inspectionKind, filePath, {
      metadata: {
        classification: pathMetadata.classification,
        ecosystem: pathMetadata.ecosystem,
        exists,
        redacted: pathMetadata.sensitive ?? false,
      },
      reasonBuilder: (count) =>
        `${exists ? "Inspected" : "Checked for"} ${pathMetadata.label} ${filePath}${buildReadCountSuffix(count)}.`,
    });
  }
  return exists;
}

/**
 * Permission-aware check for whether a path exists and carries the executable
 * bit for the current user. Answers false instead of throwing when the path
 * is absent, unreadable, or blocked by secure mode.
 *
 * @param {string} filePath File path to check.
 * @returns {boolean} True when the path exists and is executable.
 */
export function safeIsExecutableSync(filePath) {
  if (!safeExistsSync(filePath)) {
    return false;
  }
  try {
    accessSync(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// writeFileSync flags that create or replace a file, which the no-follow
// write below reproduces with open(2) flags.
const NO_FOLLOW_WRITE_FLAGS = new Set([
  "a",
  "a+",
  "as",
  "as+",
  "ax",
  "ax+",
  "w",
  "w+",
  "wx",
  "wx+",
]);

// The standard streams and open descriptors, by the names they have once the
// directory part of a path is resolved: /dev/stdout, /dev/fd/63 and
// /proc/<pid>/fd/63.
const STANDARD_STREAM_PATH =
  /^\/(?:dev\/(?:null|tty|stdin|stdout|stderr|fd\/\d+)|proc\/(?:self|thread-self|\d+)\/(?:task\/\d+\/)?fd\/\d+)$/;

/**
 * Determine whether a path names a standard stream or an open descriptor,
 * such as /dev/stdout, /dev/null or the /dev/fd entry of a shell process
 * substitution. These are symbolic links an operator names on purpose, so
 * they are written through as given.
 *
 * Nothing else under /dev or /proc qualifies, and the directory the file is
 * really in decides, not the spelling of the path. /proc/self/cwd and
 * /proc/self/root are other names for ordinary directories and /dev/shm is an
 * ordinary filesystem, so such a path can lead to a link in a scanned tree.
 *
 * @param {string} filePath File path to check.
 * @returns {boolean} True for a standard stream or descriptor path on POSIX
 *   systems.
 */
function isStandardStreamPath(filePath) {
  if (isWin) {
    return false;
  }
  let streamPath = filePath;
  try {
    // The native call resolves the directory as the write will. The
    // JavaScript one normalizes the path first and takes "link/.." for the
    // directory holding the link.
    streamPath = join(
      realpathSync.native(dirname(filePath)),
      basename(filePath),
    );
  } catch {
    // The directory is missing, or the permission model does not let cdxgen
    // read it, as with /dev when only writes to /dev/stdout are granted. The
    // path then has to name the stream exactly as given.
  }
  return STANDARD_STREAM_PATH.test(streamPath);
}

/**
 * Convert a writeFileSync flag string into open(2) flags.
 *
 * @param {string} flag Flag such as "w", "a" or "wx".
 * @returns {number} Numeric open flags.
 */
function writeOpenFlags(flag) {
  let flags =
    fsConstants.O_CREAT |
    (flag.includes("+") ? fsConstants.O_RDWR : fsConstants.O_WRONLY) |
    (flag.startsWith("a") ? fsConstants.O_APPEND : fsConstants.O_TRUNC);
  if (flag.includes("x")) {
    flags |= fsConstants.O_EXCL;
  }
  return flags;
}

/**
 * Write a file without following a symbolic link in the last component of
 * its path. A link found there is removed and a regular file is created in
 * its place, so a link committed to a scanned repository under a name cdxgen
 * writes, such as bom.json, cannot send the write to the file it points at.
 * The open uses O_NOFOLLOW where the platform has it, so a link that appears
 * after the check makes the write fail rather than follow it. Links in the
 * parent directories are followed as usual.
 *
 * @param {string} filePath File path to write.
 * @param {string|Buffer|Uint8Array} data Data to write.
 * @param {Object|string} [options] writeFileSync options or encoding.
 * @returns {boolean} True when a symbolic link was replaced.
 */
function writeFileWithoutFollowingLink(filePath, data, options) {
  const flag =
    (typeof options === "object" && options?.flag
      ? String(options.flag)
      : undefined) || "w";
  if (
    typeof filePath !== "string" ||
    !NO_FOLLOW_WRITE_FLAGS.has(flag) ||
    isStandardStreamPath(filePath)
  ) {
    writeFileSync(filePath, data, options);
    return false;
  }
  let replacedLink = false;
  let pathStats;
  try {
    pathStats = lstatSync(filePath);
  } catch {
    pathStats = undefined;
  }
  if (pathStats?.isSymbolicLink()) {
    // rmSync removes the link itself, including a directory link on Windows.
    rmSync(filePath, { force: true });
    replacedLink = true;
  }
  const openFlags =
    writeOpenFlags(flag) |
    (fsConstants.O_NOFOLLOW || 0) |
    (replacedLink ? fsConstants.O_EXCL : 0);
  const mode =
    typeof options === "object" && options?.mode !== undefined
      ? options.mode
      : 0o666;
  const fd = openSync(filePath, openFlags, mode);
  try {
    writeFileSync(fd, data, {
      encoding: typeof options === "string" ? options : options?.encoding,
    });
  } finally {
    closeSync(fd);
  }
  if (replacedLink) {
    console.warn(
      `'${filePath}' was a symbolic link. cdxgen replaced the link with a regular file instead of writing to the file it pointed at.`,
    );
  }
  return replacedLink;
}

/**
 * Permission- and dry-run-aware wrapper around writeFileSync. Records the
 * activity and returns undefined when blocked.
 *
 * The last component of the path is never followed when it is a symbolic
 * link: the link is replaced with a regular file. The standard streams and
 * descriptor paths, such as /dev/stdout, are written through as given.
 *
 * @param {string} filePath File path to write.
 * @param {string|Buffer} data Data to write.
 * @param {Object} [options] writeFileSync options (encoding, mode, flag).
 * @returns {void}
 */
export function safeWriteSync(filePath, data, options) {
  if (isWriteBlocked(filePath)) {
    return undefined;
  }
  const replacedLink = writeFileWithoutFollowingLink(filePath, data, options);
  recordFilesystemActivity(
    "write",
    filePath,
    "completed",
    replacedLink
      ? "Replaced a symbolic link with a regular file instead of following it."
      : undefined,
  );
}

/**
 * Remove a symbolic link from a path that an external tool is about to write.
 * safeWriteSync() keeps cdxgen's own writes from following such a link, but a
 * tool that is handed the path on its command line opens the file itself and
 * would write to the file the link points at. Call this right before the tool
 * runs. The standard streams and descriptor paths are left as given, and nothing is removed
 * in dry-run mode, where the tool does not run either.
 *
 * @param {string} filePath Output path handed to the tool.
 * @returns {boolean} False when the path could not be checked or a symbolic
 *   link there could not be removed, in which case the tool must not be given
 *   the path.
 */
export function safeRemoveOutputLinkSync(filePath) {
  if (
    isDryRun ||
    typeof filePath !== "string" ||
    isStandardStreamPath(filePath)
  ) {
    return true;
  }
  try {
    if (!lstatSync(filePath).isSymbolicLink()) {
      return true;
    }
    // rmSync removes the link itself, including a directory link on Windows.
    rmSync(filePath, { force: true });
  } catch (err) {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") {
      return true;
    }
    console.warn(
      `cdxgen could not make sure that '${filePath}' is not a symbolic link (${err.message}), so nothing is written there.`,
    );
    return false;
  }
  recordFilesystemActivity(
    "cleanup",
    filePath,
    "completed",
    "Removed a symbolic link at an output path instead of following it.",
  );
  console.warn(
    `'${filePath}' was a symbolic link. cdxgen removed the link instead of writing to the file it pointed at.`,
  );
  return true;
}

/**
 * Permission- and dry-run-aware write of a sequence of chunks, for content too
 * large to join into one string first. The chunks go to a temporary file next
 * to the target, which is renamed into place once complete, so a chunk may be
 * read from the file being replaced and a failed write leaves the target as it
 * was.
 *
 * @param {string} filePath File path to write.
 * @param {Iterable<string|Buffer>} chunks Chunks written in order.
 * @returns {void}
 */
export function safeWriteChunksSync(filePath, chunks) {
  if (isWriteBlocked(filePath)) {
    return undefined;
  }
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(tempPath, "wx");
  try {
    for (const chunk of chunks) {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      let written = 0;
      while (written < bytes.length) {
        written += writeSync(fd, bytes, written);
      }
    }
    closeSync(fd);
    renameSync(tempPath, filePath);
  } catch (err) {
    try {
      closeSync(fd);
    } catch {
      // Already closed before the rename failed.
    }
    rmSync(tempPath, { force: true });
    throw err;
  }
  recordFilesystemActivity("write", filePath, "completed");
}

function isWriteBlocked(filePath) {
  if (isDryRun) {
    recordFilesystemActivity(
      "write",
      filePath,
      "blocked",
      "Dry run mode blocks filesystem writes.",
    );
    return true;
  }
  if (!hasWritePermission(filePath)) {
    if (DEBUG_MODE) {
      console.log("cdxgen lacks write permission for a requested path.");
    }
    recordFilesystemActivity(
      "write",
      filePath,
      "blocked",
      "cdxgen lacks write permission for this path.",
    );
    return true;
  }
  return false;
}

/**
 * Permission-aware wrapper around readFileSync that returns undefined instead
 * of throwing. Reads are allowed in dry-run mode, so unlike the write wrappers
 * this only guards secure-mode read permission; the read itself is not recorded
 * in the activity ledger because inspection of classified paths is already
 * recorded by safeExistsSync and a read has no side effect to audit.
 *
 * @param {string} filePath File path to read.
 * @param {Object|string} [options] readFileSync options; defaults to UTF-8 text.
 * @returns {string|Buffer|undefined} File content, or undefined when the path cannot be read.
 */
export function safeReadFileSync(filePath, options = "utf-8") {
  if (!hasReadPermission(filePath)) {
    if (DEBUG_MODE) {
      console.log("cdxgen lacks read permission for a requested path.");
    }
    const pathMetadata = classifyActivityPath(filePath);
    if (pathMetadata) {
      recordPolicyActivity(filePath, {
        metadata: {
          classification: pathMetadata.classification,
          ecosystem: pathMetadata.ecosystem,
          policyType: "fs.read",
        },
        reason: `Denied read of ${pathMetadata.label} ${filePath} due to missing fs.read permission.`,
        status: "blocked",
      });
    }
    return undefined;
  }
  try {
    return readFileSync(filePath, options);
  } catch {
    return undefined;
  }
}

/**
 * Safely create a directory without crashing due to a lack of permissions
 *
 * @param {String} filePath File path
 * @param options {Options} mkdir options
 * @Boolean True if the path exists. False otherwise
 */
export function safeMkdirSync(filePath, options) {
  if (isDryRun) {
    recordFilesystemActivity(
      "mkdir",
      filePath,
      "blocked",
      "Dry run mode blocks directory creation.",
    );
    return undefined;
  }
  if (!hasWritePermission(filePath)) {
    if (DEBUG_MODE) {
      console.log("cdxgen lacks write permission for a requested path.");
    }
    recordFilesystemActivity(
      "mkdir",
      filePath,
      "blocked",
      "cdxgen lacks write permission for this path.",
    );
    return undefined;
  }
  mkdirSync(filePath, options);
  recordFilesystemActivity("mkdir", filePath, "completed");
}

/**
 * Dry-run-aware wrapper around mkdtempSync that records the activity. In dry-run
 * mode, returns a synthetic path without touching the filesystem.
 *
 * @param {string} prefix Path prefix for the temporary directory.
 * @param {string|Object} [options] Encoding or mkdtempSync options.
 * @returns {string|undefined} The created directory path, a synthetic path in dry-run mode, or undefined when blocked.
 */
export function safeMkdtempSync(prefix, options = undefined) {
  const resourceType =
    typeof prefix === "string" && prefix.toLowerCase().includes("cache")
      ? "cache"
      : "temporary-workspace";
  if (isDryRun) {
    const tempPath = `${prefix}${randomUUID().replaceAll("-", "").slice(0, 6)}`;
    recordFilesystemActivity(
      "temp-dir",
      tempPath,
      "blocked",
      `Dry run mode blocks temporary directory creation for ${resourceType}.`,
      {
        resourceType,
      },
    );
    return tempPath;
  }
  const tempPath = mkdtempSync(prefix, options);
  recordFilesystemActivity("temp-dir", tempPath, "completed", undefined, {
    resourceType,
  });
  return tempPath;
}

/**
 * Dry-run-aware wrapper around rmSync. Records the activity and returns
 * undefined when blocked.
 *
 * @param {string} filePath Path to remove.
 * @param {Object} [options] rmSync options (recursive, force, etc.).
 * @returns {void}
 */
export function safeRmSync(filePath, options = undefined) {
  if (isDryRun) {
    recordFilesystemActivity(
      "cleanup",
      filePath,
      "blocked",
      "Dry run mode blocks filesystem deletions.",
    );
    return undefined;
  }
  rmSync(filePath, options);
  recordFilesystemActivity("cleanup", filePath, "completed");
}

/**
 * Dry-run-aware wrapper around unlinkSync. Records the activity and returns
 * undefined when blocked.
 *
 * @param {string} filePath File path to unlink.
 * @returns {void}
 */
export function safeUnlinkSync(filePath) {
  if (isDryRun) {
    recordFilesystemActivity(
      "cleanup",
      filePath,
      "blocked",
      "Dry run mode blocks file deletions.",
    );
    return undefined;
  }
  unlinkSync(filePath);
  recordFilesystemActivity("cleanup", filePath, "completed");
}

/**
 * Copy a file without following a symbolic link in the last component of the
 * destination path. copyFileSync opens its destination like a plain write, so
 * a link committed to a scanned repository under a name cdxgen copies to, such
 * as project/plugins.sbt.cdxgen, would send the source's content and mode to
 * the file it points at. A link found there is removed and the copy creates a
 * regular file in its place with COPYFILE_EXCL, so the copy fails rather than
 * follow a link that reappears after the removal. Links in the parent
 * directories are followed as usual.
 *
 * @param {string} src Source file path.
 * @param {string} dest Destination file path.
 * @param {number} [mode] Optional copy mode bitmask.
 * @returns {boolean} True when a symbolic link was replaced.
 */
function copyFileWithoutFollowingLink(src, dest, mode) {
  if (typeof dest !== "string" || isStandardStreamPath(dest)) {
    copyFileSync(src, dest, mode);
    return false;
  }
  let destStats;
  try {
    destStats = lstatSync(dest);
  } catch {
    destStats = undefined;
  }
  if (!destStats?.isSymbolicLink()) {
    copyFileSync(src, dest, mode);
    return false;
  }
  // rmSync removes the link itself, including a directory link on Windows.
  rmSync(dest, { force: true });
  copyFileSync(src, dest, (mode ?? 0) | fsConstants.COPYFILE_EXCL);
  console.warn(
    `'${dest}' was a symbolic link. cdxgen replaced the link with a regular file instead of copying to the file it pointed at.`,
  );
  return true;
}

/**
 * Dry-run-aware wrapper around copyFileSync. Records the activity and returns
 * undefined when blocked.
 *
 * The last component of the destination is never followed when it is a
 * symbolic link: the link is replaced with a regular file. The standard
 * streams and descriptor paths are copied to as given.
 *
 * @param {string} src Source file path.
 * @param {string} dest Destination file path.
 * @param {number} [mode] Optional copy mode bitmask.
 * @returns {void}
 */
export function safeCopyFileSync(src, dest, mode = undefined) {
  if (isDryRun) {
    recordFilesystemActivity(
      "write",
      dest,
      "blocked",
      `Dry run mode blocks copying files from ${src}.`,
    );
    return undefined;
  }
  const replacedLink = copyFileWithoutFollowingLink(src, dest, mode);
  recordFilesystemActivity(
    "write",
    dest,
    "completed",
    replacedLink
      ? `Copied from ${src}. Replaced a symbolic link with a regular file instead of following it.`
      : `Copied from ${src}.`,
  );
}

/**
 * Dry-run-aware wrapper around chmodSync for a file found in a scanned tree,
 * such as a build wrapper that needs its execute bit. Records the activity
 * and returns undefined when blocked.
 *
 * Only a regular file gets the mode. chmodSync follows symbolic links, so a
 * link committed to a scanned repository under a name cdxgen makes
 * executable, such as gradlew, would pass the mode on to the file or
 * directory it points at. The mode is set through a descriptor opened with
 * O_NOFOLLOW where the platform has it, so a link that appears after the
 * check makes the call fail rather than follow it. Links in the parent
 * directories are followed as usual. Node.js disables fchmod under the
 * permission model, so there the call throws and the mode stays as it was.
 *
 * @param {string} filePath File path to change the mode of.
 * @param {number} mode File mode, such as 0o775.
 * @returns {boolean|undefined} True when the mode was set, false when the path is not a regular file.
 */
export function safeChmodSync(filePath, mode) {
  if (isDryRun) {
    recordFilesystemActivity(
      "chmod",
      filePath,
      "blocked",
      "Dry run mode blocks file mode changes.",
    );
    return undefined;
  }
  if (!lstatSync(filePath).isFile()) {
    recordFilesystemActivity(
      "chmod",
      filePath,
      "blocked",
      "Only the mode of a regular file is changed; symbolic links are not followed.",
    );
    return false;
  }
  // O_NONBLOCK keeps the open from waiting on a FIFO swapped in after the check.
  const fd = openSync(
    filePath,
    fsConstants.O_RDONLY |
      (fsConstants.O_NOFOLLOW || 0) |
      (fsConstants.O_NONBLOCK || 0),
  );
  try {
    if (!fstatSync(fd).isFile()) {
      return false;
    }
    fchmodSync(fd, mode);
  } finally {
    closeSync(fd);
  }
  recordFilesystemActivity("chmod", filePath, "completed");
  return true;
}

/**
 * Run an archive extractor under dry-run/debug activity tracing. In dry-run
 * mode the extraction is recorded as blocked and resolves false without running.
 *
 * @param {string} sourcePath Path to the source archive.
 * @param {string} targetPath Path to extract into.
 * @param {() => Promise} extractor Async function performing the extraction.
 * @param {string} [kind="unzip"] Archive kind label for tracing.
 * @param {Object} [options] Optional tracing metadata, blockedReason, and failureReason.
 * @returns {Promise<boolean>} True when extraction succeeded, false when blocked by dry-run.
 */
export async function safeExtractArchive(
  sourcePath,
  targetPath,
  extractor,
  kind = "unzip",
  options = undefined,
) {
  const traceArchiveStats = isDryRun || DEBUG_MODE;
  const sourceBytes = traceArchiveStats
    ? getArchiveSourceByteSize(sourcePath)
    : undefined;
  if (isDryRun) {
    recordActivity({
      archiveKind: kind,
      capability: "archive-extraction",
      kind,
      ...(options?.metadata || {}),
      ...(sourceBytes !== undefined ? { sourceBytes } : {}),
      reason:
        options?.blockedReason ||
        `Dry run mode blocks ${kind} extraction from ${sourcePath} into ${targetPath}.`,
      status: "blocked",
      target: `${sourcePath} -> ${targetPath}`,
    });
    return false;
  }
  try {
    await extractor();
    recordActivity({
      archiveKind: kind,
      capability: "archive-extraction",
      kind,
      ...(options?.metadata || {}),
      ...(sourceBytes !== undefined ? { sourceBytes } : {}),
      status: "completed",
      target: `${sourcePath} -> ${targetPath}`,
    });
    return true;
  } catch (error) {
    recordActivity({
      archiveKind: kind,
      capability: "archive-extraction",
      kind,
      ...(options?.metadata || {}),
      ...(sourceBytes !== undefined ? { sourceBytes } : {}),
      ...(error?.code ? { errorCode: error.code } : {}),
      reason:
        options?.failureReason ||
        `Failed ${kind} extraction from ${sourcePath} into ${targetPath}: ${error.message}`,
      status: "failed",
      target: `${sourcePath} -> ${targetPath}`,
    });
    throw error;
  }
}

/** How many times its own size a zip archive may unpack to (100), overridable via CDXGEN_UNZIP_MAX_RATIO. */
const UNZIP_MAX_RATIO =
  Number.parseInt(readEnvironmentVariable("CDXGEN_UNZIP_MAX_RATIO"), 10) || 100;

/** Most bytes a zip archive of any size may unpack to (8 GB), overridable via CDXGEN_UNZIP_MAX_BYTES. */
const UNZIP_MAX_BYTES =
  Number.parseInt(readEnvironmentVariable("CDXGEN_UNZIP_MAX_BYTES"), 10) ||
  8 * 1024 * 1024 * 1024;

/** A small archive of very compressible files is ordinary, so the ratio is not applied below this (64 MB). */
const UNZIP_RATIO_FREE_BYTES = 64 * 1024 * 1024;

/**
 * The number of bytes a zip archive may unpack to. The archive is untrusted
 * input and a small one can declare any amount of data, so the allowance
 * follows the size of the file. Archives found inside it are extracted against
 * the same budget, or every level of nesting would multiply it again.
 *
 * @param {string} zipFile Path to the zip archive.
 * @returns {{remainingBytes: number}} Budget for {@link extractZipWithinBudget}.
 */
export function createUnzipBudget(zipFile) {
  const zipBytes = safeExistsSync(zipFile) ? statSync(zipFile).size : 0;
  return {
    remainingBytes: Math.min(
      UNZIP_MAX_BYTES,
      Math.max(UNZIP_RATIO_FREE_BYTES, zipBytes * UNZIP_MAX_RATIO),
    ),
  };
}

/**
 * Extract every entry of a zip archive, as `zip.extract(null, targetPath)`
 * does, but never write more than the budget allows. An archive whose entries
 * declare more than that is refused before anything is written. The declared
 * sizes are the archive's own claim, so the bytes written are counted as well.
 * A write that fails, as on a full disk, rejects like any other error.
 *
 * @param {Object} zip Open `StreamZip.async` instance for the archive.
 * @param {string} zipFile Path to the zip archive.
 * @param {string} targetPath Directory to extract into.
 * @param {{remainingBytes: number}} [budget] Budget shared with the enclosing archive. Defaults to one for this archive.
 * @returns {Promise<void>}
 */
export async function extractZipWithinBudget(
  zip,
  zipFile,
  targetPath,
  budget = createUnzipBudget(zipFile),
) {
  const allowedBytes = budget.remainingBytes;
  const raiseLimit =
    "Set CDXGEN_UNZIP_MAX_RATIO or CDXGEN_UNZIP_MAX_BYTES to raise the limit.";
  // node-stream-zip has validated the entry names while reading the archive.
  const entries = Object.values(await zip.entries());
  let declaredBytes = 0;
  for (const entry of entries) {
    declaredBytes += entry.size;
  }
  if (declaredBytes > allowedBytes) {
    throw new Error(
      `${zipFile} unpacks to ${declaredBytes} bytes, more than the ${allowedBytes} bytes allowed. ${raiseLimit}`,
    );
  }
  const createdDirs = new Set();
  for (const entry of entries) {
    const entryPath = join(targetPath, entry.name);
    const entryDir = entry.isDirectory ? entryPath : dirname(entryPath);
    if (!createdDirs.has(entryDir)) {
      safeMkdirSync(entryDir, { recursive: true });
      createdDirs.add(entryDir);
    }
    if (entry.isDirectory) {
      continue;
    }
    await pipeline(
      await zip.stream(entry),
      async function* (chunks) {
        for await (const chunk of chunks) {
          budget.remainingBytes -= chunk.length;
          if (budget.remainingBytes < 0) {
            throw new Error(
              `${zipFile} unpacks to more than the ${allowedBytes} bytes allowed. ${raiseLimit}`,
            );
          }
          yield chunk;
        }
      },
      createWriteStream(entryPath),
    );
  }
}

/** Set of temporary file paths written by cdxgen that are removed on process exit. */
export const temporaryFiles = new Set();
process.on("exit", () =>
  temporaryFiles.forEach((tempFile) => {
    if (safeExistsSync(tempFile)) {
      safeUnlinkSync(tempFile);
    }
  }),
);

/** Set accumulating every executable command spawned via safeSpawnSync. */
export const commandsExecuted = new Set();

/**
 * Check a command against the CDXGEN_ALLOWED_COMMANDS allowlist. Every command
 * is allowed when no allowlist is configured.
 *
 * @param {string} command The executable, exactly as it is passed to spawn
 * @param {string} [allowedCommandsEnv] Comma-separated allowlist; defaults to CDXGEN_ALLOWED_COMMANDS
 * @returns {boolean} True when the command may be started
 */
export function isAllowedCommand(
  command,
  allowedCommandsEnv = readEnvironmentVariable("CDXGEN_ALLOWED_COMMANDS"),
) {
  if (!allowedCommandsEnv) {
    return true;
  }
  return allowedCommandsEnv
    .split(",")
    .map((entry) => entry.trim())
    .includes(command.trim());
}

const ALLOWED_WRAPPERS = new Set(["gradlew", "mvnw"]);

/**
 * Check for Windows CWD executable hijack of a bare command name.
 * cmd.exe (shell: true) searches CWD before PATH using PATHEXT. Without a
 * shell, libuv does the same: it tries the name as given when it has an
 * extension, then the name with .com and .exe appended. Either way a local
 * file can shadow a system command. A spawn without a cwd option starts in
 * cdxgen's own working directory, which is the scanned project whenever
 * cdxgen is run from inside it, so that directory is checked in its place.
 *
 * @param {string} command The executable to spawn
 * @param {Object} options Options forwarded to spawnSync (e.g. cwd, env, shell)
 *
 * @returns {boolean} true if there is a hijack risk. false otherwise.
 */
function isWindowsShellHijackRisk(command, options) {
  if (!isWin || !command) {
    return false;
  }
  const cwd = options?.cwd || process.cwd();
  const usesShell = options?.shell === true;
  if (/[\/\\]/.test(command)) {
    return false;
  }
  const cmdBase = command.toLowerCase();
  if (ALLOWED_WRAPPERS.has(cmdBase)) {
    return false;
  }
  let candidates;
  if (usesShell) {
    const pathExt = (
      readEnvironmentVariable("PATHEXT") ||
      ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC"
    )
      .split(";")
      .filter(Boolean);
    candidates = [
      cmdBase,
      ...pathExt.map((ext) => cmdBase + ext.toLowerCase()),
    ];
  } else {
    const dot = cmdBase.lastIndexOf(".");
    candidates = [`${cmdBase}.com`, `${cmdBase}.exe`];
    if (dot > -1 && dot < cmdBase.length - 1) {
      candidates.unshift(cmdBase);
    }
  }
  const absCwd = resolve(cwd);
  for (const candidate of candidates) {
    const candidatePath = path.join(absCwd, candidate);
    // Only files are run, so a directory named like the tool is harmless.
    try {
      if (statSync(candidatePath).isFile()) {
        return true;
      }
    } catch (_err) {
      // Not present.
    }
  }
  return false;
}

const VERSION_PROBE_ARGS = new Set(["--version", "-version", "version"]);

const POSIX_SHELL_METACHARACTERS = /[;&|<>$`\\\n\r]/;
const WINDOWS_SHELL_METACHARACTERS = /[&|<>^%\n\r]/;

/**
 * Quote one argument of a shell command line that is built as a single
 * string. The shell flag exists so cmd.exe can resolve bare command names,
 * `.cmd` shims and scripts, and every argument is data (paths, flags) that
 * must arrive as one token whatever it contains: joined unquoted, an
 * argument with spaces splits into several and hands the tool the wrong
 * tokens.
 *
 * Windows follows the quoting rules cmd.exe and the MSVC runtimes share:
 * wrap in double quotes, doubling the backslashes that precede a quote and
 * escaping the quote itself. Inside double quotes cmd.exe already treats
 * `&`, `|`, `<`, `>`, `^` and parentheses as literals, and the
 * shell-metacharacter block above refuses `%` and the rest before this
 * runs. A POSIX shell gets single quotes, which no expansion can leave.
 *
 * The same quoting is applied to the command itself when it names an
 * existing file under a path with spaces; a command the shell must parse
 * (a bare name, `sh -c`) never names a file as a whole and stays verbatim.
 *
 * @param {string} arg Argument to quote
 * @param {boolean} [forWindows] Quote for cmd.exe rather than a POSIX shell; defaults to the current platform
 * @returns {string} The argument, quoted when the shell needs it
 */
export function shellQuoteArgument(arg, forWindows = isWin) {
  const value = `${arg}`;
  if (forWindows) {
    if (value === "") {
      return '""';
    }
    if (!/[\s"]/.test(value)) {
      return value;
    }
    // Every backslash run that precedes a quote doubles, each quote escapes,
    // and the trailing run doubles for the closing quote this returns. A
    // character scan keeps it linear; the equivalent `(\\*)"` pattern is
    // polynomial on runs of backslashes that no quote ends.
    let quoted = "";
    let backslashes = 0;
    for (const ch of value) {
      if (ch === "\\") {
        backslashes++;
        quoted += ch;
      } else if (ch === '"') {
        quoted += `${"\\".repeat(backslashes)}\\"`;
        backslashes = 0;
      } else {
        quoted += ch;
        backslashes = 0;
      }
    }
    quoted += "\\".repeat(backslashes);
    return `"${quoted}"`;
  }
  if (value === "") {
    return "''";
  }
  if (!/[^-\w@%+=:,./]/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Whether the path names an existing regular file, without throwing on the
 * many values that are not paths at all (a bare command name, a command with
 * arguments, anything the shell is meant to parse).
 *
 * @param {string} file Candidate path
 * @returns {boolean} True when a regular file exists at the path
 */
function isFileNoThrow(file) {
  try {
    return statSync(`${file}`).isFile();
  } catch (_err) {
    return false;
  }
}

/**
 * Build the single command string a shell spawn runs. Every argument is
 * quoted for the platform shell, so an argument containing spaces stays one
 * token and cannot alter the command, and a command that is itself a file
 * under a path with spaces (`C:\Program Files\...\node.exe`) is quoted too;
 * a command the shell must parse (`sh -c`, a bare name) never names an
 * existing file as a whole and is left verbatim.
 *
 * The one exception is a caller that composes shell fragments itself (sbt
 * command lines embed their own quoting for the shell to strip): it passes
 * `rawShellArgs` and keeps the verbatim join, under the shell-metacharacter
 * block in safeSpawnSync like every other argument.
 *
 * @param {string} command The executable
 * @param {string[]|undefined} args Arguments, when the caller passed any
 * @param {boolean} [rawShellArgs] Join the arguments verbatim instead of quoting them
 * @returns {string} The command line the shell will run
 */
export function joinShellCommand(command, args, rawShellArgs = false) {
  let commandToken = `${command}`;
  if (/\s/.test(commandToken) && isFileNoThrow(commandToken)) {
    commandToken = shellQuoteArgument(commandToken);
  }
  if (!args?.length) {
    return commandToken;
  }
  return [
    commandToken,
    ...(rawShellArgs ? args : args.map((arg) => shellQuoteArgument(arg))),
  ].join(" ");
}

function hasShellMetacharacters(value) {
  if (value === undefined || value === null) {
    return false;
  }
  const stringValue = String(value);
  return isWin
    ? WINDOWS_SHELL_METACHARACTERS.test(stringValue)
    : POSIX_SHELL_METACHARACTERS.test(stringValue);
}

function getUnsafeShellToken(command, args) {
  if (hasShellMetacharacters(command)) {
    return command;
  }
  const argList = Array.isArray(args)
    ? args
    : args === undefined || args === null
      ? []
      : [args];
  return argList.find((arg) => hasShellMetacharacters(arg));
}

function recordSuspiciousShellPathActivities(files, metadata = {}) {
  for (const file of files) {
    if (!hasShellMetacharacters(file)) {
      continue;
    }
    recordActivity({
      classification: "suspicious-path",
      discoveryType: metadata.discoveryType,
      kind: "inspect",
      pattern: metadata.pattern,
      reason:
        "Suspicious path contains shell metacharacters. cdxgen passes direct process arguments as argv values, but review this path before invoking external build tools on untrusted projects.",
      risk: "shell-metacharacters",
      status: "completed",
      target: file,
    });
  }
}

function detectProbeType(command, args = []) {
  const normalizedCommand = basename(String(command || "")).toLowerCase();
  const normalizedArgs = (args || []).map((arg) => String(arg).toLowerCase());
  if (
    normalizedArgs.some((arg) => VERSION_PROBE_ARGS.has(arg)) ||
    (normalizedArgs.length === 1 && normalizedArgs[0] === "-v")
  ) {
    return "version-check";
  }
  if (normalizedCommand === "which" || normalizedArgs.includes("--help")) {
    return "capability-probe";
  }
  if (
    normalizedCommand.startsWith("python") &&
    normalizedArgs.includes("-c") &&
    normalizedArgs.some((arg) => arg.includes("import"))
  ) {
    return "runtime-probe";
  }
  return undefined;
}

function buildCommandActivityDescriptor(command, args, options) {
  const target = `${command}${args?.length ? ` ${args.join(" ")}` : ""}`;
  const cdxgenActivity = options?.cdxgenActivity || {};
  const probeType = cdxgenActivity.probeType || detectProbeType(command, args);
  const metadata = {
    ...(cdxgenActivity.metadata || {}),
  };
  if (probeType) {
    metadata.capability = metadata.capability || "tool-runtime-probe";
    metadata.probeType = probeType;
  }
  if (cdxgenActivity.gitOperation) {
    metadata.gitOperation = cdxgenActivity.gitOperation;
  }
  return {
    blockedReason:
      cdxgenActivity.blockedReason ||
      (probeType
        ? `Dry run mode blocks ${probeType.replaceAll("-", " ")} command execution.`
        : "Dry run mode blocks child process execution."),
    kind: cdxgenActivity.kind || "execute",
    metadata,
    target: cdxgenActivity.target || target,
  };
}

function getOutputByteSize(value, encoding = "utf-8") {
  if (value === undefined || value === null) {
    return 0;
  }
  if (Buffer.isBuffer(value)) {
    return value.length;
  }
  if (ArrayBuffer.isView(value)) {
    return value.byteLength;
  }
  const safeEncoding =
    typeof encoding === "string" && encoding !== "buffer" ? encoding : "utf8";
  return Buffer.byteLength(String(value), safeEncoding);
}

/**
 * Copy an environment into an object without a prototype. Node.js builds a
 * child's environment with for...in, which also lists properties inherited
 * from Object.prototype, so a child must be handed such a copy to receive
 * only the variables that are really set.
 *
 * @param {Object} [env] Environment to copy, process.env by default
 * @returns {Object} Null-prototype copy holding the own properties of env
 */
export function ownEnvironment(env = process.env) {
  const copy = Object.create(null);
  for (const name of Object.getOwnPropertyNames(env)) {
    copy[name] = env[name];
  }
  return copy;
}

/**
 * Whether Deno's merged spawn would hand the child exactly this environment.
 *
 * Deno's spawnSync adds every parent variable the env option does not list
 * and lets the option win on collisions, so the merged child differs from
 * the one Node would start only through a variable the option dropped: a
 * superset option, one that carries every process variable whatever values
 * it gives them, reaches the child unchanged. Only a reduced option must
 * take the clearEnv path, and keeping supersets on the compat spawn also
 * keeps what only that path provides: the timeout it enforces, and the run's
 * own permission flags, which Deno's compat layer grants a child that is
 * the runtime's executable and a raw Deno.Command does not. Windows spells
 * one variable name in either case, so both sides are compared lower-cased
 * there.
 *
 * @param {Object} env Environment option the caller passed
 * @returns {boolean} True when the merge cannot change what the child receives
 */
function envOptionSurvivesDenoMerge(env) {
  const parentNames = Object.getOwnPropertyNames(process.env);
  if (isWin) {
    const option = new Set(
      Object.getOwnPropertyNames(env).map((name) => name.toLowerCase()),
    );
    return parentNames.every((name) => option.has(name.toLowerCase()));
  }
  return parentNames.every((name) => Object.hasOwn(env, name));
}

/**
 * Map one Node stdio spec to the Deno.Command stream mode that collects it.
 *
 * @param {string|number} [spec] One stdio entry as spawnSync accepts it
 * @returns {"piped"|"null"|"inherit"} The Deno.Command stream mode
 */
function denoStreamMode(spec) {
  if (spec === "ignore") {
    return "null";
  }
  if (spec === "inherit") {
    return "inherit";
  }
  // "pipe" is Node's default, and "overlapped" is its Windows variant.
  return "piped";
}

/**
 * Start a synchronous child whose environment is exactly the one passed in
 * the options, and return a Node-shaped spawnSync result.
 *
 * Deno's node:child_process spawnSync merges the parent environment under
 * the env option instead of replacing it, so a child started there with a
 * reduced environment still receives every dropped variable
 * (denoland/deno#27343, unfixed as of Deno 2.9). Deno.Command with
 * clearEnv replaces the environment the way Node always has, so under Deno
 * this helper starts the child that way; under every other runtime it
 * delegates to spawnSync, whose env option already replaces.
 *
 * Two spawnSync features have no outputSync equivalent, and this helper
 * cannot honour them: outputSync runs the child to completion however
 * timeout and maxBuffer are set, and it cannot write to a piped stdin, so a
 * caller feeding the child input must stay on the compat spawn. A
 * synchronous child nobody feeds reads an immediately closed stdin either
 * way, which is why every stdin mode but "inherit" maps to the null device.
 *
 * A caller that asks for a shell together with separate arguments gets the
 * metacharacter refusal safeSpawnSync applies, on every runtime: the
 * arguments are folded into one line here, and such a refusal is the only
 * way to keep a quoted argument from becoming a second command.
 *
 * @param {string} command The executable to spawn
 * @param {string[]} [args] Arguments to pass to the command
 * @param {Object} [options] Options as spawnSync accepts them (cwd, env,
 *   stdio, encoding, timeout, shell); input is not supported here
 * @returns {Object} spawnSync result object with status, stdout, stderr and
 *   error fields
 */
export function denoClearEnvSpawnSync(command, args, options) {
  // A shell invocation with separate arguments folds the arguments into one
  // line below, so an argument carrying shell metacharacters could become a
  // second command once a shell reads the line. safeSpawnSync refuses such
  // arguments before it folds; a direct caller of this helper gets the same
  // refusal here, on every runtime, before the line exists. An already
  // folded command arrives with no arguments and had its own refusal.
  if (options?.shell && args?.length) {
    const unsafeToken = getUnsafeShellToken(command, args);
    if (unsafeToken !== undefined) {
      return {
        status: 1,
        stdout: undefined,
        stderr: undefined,
        pid: undefined,
        error: new Error(
          `Blocked shell execution for ${command}: command or argument contains shell metacharacters.`,
        ),
      };
    }
  }
  const DenoCommand = isDenoRuntime ? globalThis.Deno?.Command : undefined;
  if (typeof DenoCommand !== "function") {
    return spawnSync(command, args, options);
  }
  let denoCommand = command;
  let denoArgs = args;
  let rawWindowsArgs = false;
  if (options?.shell) {
    // A shell invocation arrives as the single command line safeSpawnSync's
    // folding produced; a direct caller's separate arguments are folded the
    // same way. Node wraps the line in cmd.exe with these exact flags on
    // Windows and in /bin/sh -c elsewhere.
    const commandLine = args?.length
      ? joinShellCommand(command, args)
      : `${command}`;
    if (isWin) {
      // Node runs a named shell with the same cmd.exe flags on Windows, so a
      // string shell is honoured here too rather than replaced. The default
      // wrapper comes from ComSpec, accepted only when it names cmd.exe
      // inside the Windows directory, so a rewritten variable cannot
      // substitute another program for the shell.
      const systemRoot = process.env.SystemRoot || process.env.systemroot;
      const comspec = process.env.comspec;
      denoCommand =
        typeof options.shell === "string"
          ? options.shell
          : comspec &&
              systemRoot &&
              basename(comspec).toLowerCase() === "cmd.exe" &&
              comspec.toLowerCase().startsWith(systemRoot.toLowerCase())
            ? comspec
            : systemRoot
              ? join(systemRoot, "System32", "cmd.exe")
              : "cmd.exe";
      // Node hands cmd.exe the line verbatim inside one pair of quotes, and
      // letting Deno quote the argument instead would escape the line's own
      // quotes in a way cmd.exe strips differently, so raw arguments
      // reproduce the exact bytes Node writes.
      denoArgs = ["/d", "/s", "/c", `"${commandLine}"`];
      rawWindowsArgs = true;
    } else {
      denoCommand =
        typeof options.shell === "string" ? options.shell : "/bin/sh";
      denoArgs = ["-c", commandLine];
    }
  }
  const stdio = Array.isArray(options?.stdio)
    ? options.stdio
    : typeof options?.stdio === "string"
      ? [options.stdio, options.stdio, options.stdio]
      : [];
  const stdinMode = stdio[0] === "inherit" ? "inherit" : "null";
  const stdoutMode = denoStreamMode(stdio[1]);
  const stderrMode = denoStreamMode(stdio[2]);
  const encoding =
    typeof options?.encoding === "string" ? options.encoding : undefined;
  try {
    const output = new DenoCommand(denoCommand, {
      args: denoArgs || [],
      clearEnv: true,
      env: options?.env || ownEnvironment(),
      cwd: options?.cwd,
      stdin: stdinMode,
      stdout: stdoutMode,
      stderr: stderrMode,
      ...(rawWindowsArgs ? { windowsRawArguments: true } : {}),
      ...(options?.timeout ? { timeout: options.timeout } : {}),
      ...(typeof options?.killSignal === "string"
        ? { killSignal: options.killSignal }
        : {}),
    }).outputSync();
    // Reading a stream the child did not pipe throws, and one Node ignored
    // or inherited arrives as undefined in the result.
    const collect = (bytes) =>
      encoding && encoding !== "buffer"
        ? Buffer.from(bytes).toString(encoding)
        : Buffer.from(bytes);
    return {
      status: output.code,
      signal: output.signal,
      stdout: stdoutMode === "piped" ? collect(output.stdout) : undefined,
      stderr: stderrMode === "piped" ? collect(output.stderr) : undefined,
      pid: undefined,
      error: undefined,
    };
  } catch (error) {
    // A binary that cannot start, a missing one, throws a NotFound error
    // whose .code is ENOENT; Node reports that through the error field with
    // a null status and pid 0 instead of throwing. The mapped result has no
    // output array, and a pid only in this shape, because outputSync exposes
    // neither; no caller in this repository reads either field today.
    return {
      status: null,
      signal: null,
      stdout: undefined,
      stderr: undefined,
      pid: 0,
      error,
    };
  }
}

/**
 * Whether a safeSpawnSync call must start its child through
 * {@link denoClearEnvSpawnSync} for the env option to be honoured.
 *
 * Only a Deno run whose env option the runtime's merge would not deliver
 * unchanged needs the isolation. A caller feeding the child's stdin cannot
 * use outputSync at all, so it keeps the compat spawn and, when its
 * environment also drops a variable, learns in debug mode
 * that the isolation cannot be honoured for that combination; no such
 * caller exists today.
 *
 * @param {string} command The executable, named in the debug warning
 * @param {Object} callerEnv The env option as the caller passed it
 * @param {Object} options Options as safeSpawnSync accepted them
 * @returns {boolean} True when the child must start through Deno.Command
 */
function needsDenoClearEnvSpawn(command, callerEnv, options) {
  if (!isDenoRuntime || callerEnv === undefined) {
    return false;
  }
  if (envOptionSurvivesDenoMerge(callerEnv)) {
    return false;
  }
  if (options?.input !== undefined) {
    if (DEBUG_MODE) {
      console.warn(
        `Under Deno, ${command} reads its stdin through a spawn whose env option drops process variables, so the child also receives the merged parent environment.`,
      );
    }
    return false;
  }
  return true;
}

/**
 * Safe wrapper around spawnSync that enforces permission checks, injects default
 * options (maxBuffer, encoding, timeout), warns about unsafe Python and pip/uv
 * invocations, and records every executed command in the commandsExecuted set.
 *
 * @param {string} command The executable to spawn
 * @param {string[]} args Arguments to pass to the command
 * @param {Object} options Options forwarded to spawnSync (e.g. cwd, env, shell)
 * @returns {Object} spawnSync result object with status, stdout, stderr, and error fields
 */
export function safeSpawnSync(command, args, options) {
  return guardedSpawn(command, args, options, spawnSyncForRuntime);
}

/**
 * spawnSync, or the clear-environment spawn that Deno needs when the caller's
 * environment is not one its merge delivers unchanged.
 *
 * @param {string} command The executable to spawn
 * @param {string[]|undefined} args Arguments to pass to the command
 * @param {Object} options spawnSync options, with the environment as own properties
 * @param {Object|undefined} callerEnv The env option as the caller wrote it
 * @returns {Object} spawnSync result object
 */
function spawnSyncForRuntime(command, args, options, callerEnv) {
  return needsDenoClearEnvSpawn(command, callerEnv, options)
    ? denoClearEnvSpawnSync(command, args, options)
    : spawnSync(command, args, options);
}

/**
 * Asynchronous counterpart of safeSpawnSync for commands that wait on a remote
 * peer: the same checks, defaults and records, without holding the event loop
 * while the command runs. stdout and stderr are always captured and the
 * command gets no input.
 *
 * @param {string} command The executable to spawn
 * @param {string[]} args Arguments to pass to the command
 * @param {Object} options Options as for safeSpawnSync (e.g. cwd, env, shell, timeout)
 * @returns {Promise<Object>} Resolves with a result object shaped like that of safeSpawnSync
 */
export async function safeSpawn(command, args, options) {
  return guardedSpawn(command, args, options, spawnBufferedForRuntime);
}

/**
 * spawnBuffered, except where Deno would merge the parent environment into
 * the child's: that call takes the synchronous clear-environment path and
 * resolves with its result.
 *
 * @param {string} command The executable to spawn
 * @param {string[]|undefined} args Arguments to pass to the command
 * @param {Object} options spawnSync options, with the environment as own properties
 * @param {Object|undefined} callerEnv The env option as the caller wrote it
 * @returns {Promise<Object>} Result with status, signal, stdout, stderr and error fields
 */
function spawnBufferedForRuntime(command, args, options, callerEnv) {
  return needsDenoClearEnvSpawn(command, callerEnv, options)
    ? Promise.resolve(denoClearEnvSpawnSync(command, args, options))
    : spawnBuffered(command, args, options);
}

/**
 * Run a command with spawn and resolve with the result object spawnSync
 * returns for the same outcome, error codes included.
 *
 * @param {string} command The executable to spawn
 * @param {string[]|undefined} args Arguments to pass to the command
 * @param {Object} options spawnSync options; encoding, maxBuffer, timeout and killSignal are applied here
 * @returns {Promise<Object>} Result with status, signal, stdout, stderr and error fields
 */
function spawnBuffered(command, args, options) {
  const { encoding, killSignal, maxBuffer, timeout, ...spawnOptions } = options;
  return new Promise((resolvePromise) => {
    const chunks = { stdout: [], stderr: [] };
    const collect = (stream) => {
      const buffer = Buffer.concat(chunks[stream]);
      return encoding && encoding !== "buffer"
        ? buffer.toString(encoding)
        : buffer;
    };
    let child;
    let error;
    let timer;
    let settled = false;
    const settle = (status, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      const result = {
        pid: child?.pid ?? 0,
        status,
        signal,
        stdout: collect("stdout"),
        stderr: collect("stderr"),
      };
      if (error) {
        result.error = error;
      }
      resolvePromise(result);
    };
    // Stop the command together with the helpers it started, such as
    // git-remote-https or ssh, which would otherwise keep waiting on the
    // remote after the command itself is gone.
    const stop = (code) => {
      if (error) {
        return;
      }
      error = Object.assign(new Error(`spawn ${command} ${code}`), { code });
      child.stdout.destroy();
      child.stderr.destroy();
      const signal = killSignal || "SIGTERM";
      if (isWin) {
        child.kill(signal);
        return;
      }
      try {
        // Signal the process group (-pid) the command leads.
        process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    };
    try {
      child = spawn(command, args, {
        ...spawnOptions,
        // detached: true creates a new process group so the entire group
        // can be stopped. Windows has no process group to signal.
        detached: !isWin,
        // Like spawnSync without input, the command has nothing to read.
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      error = err;
      settle(null, null);
      return;
    }
    for (const stream of ["stdout", "stderr"]) {
      let streamBytes = 0;
      child[stream].on("data", (chunk) => {
        const room = maxBuffer - streamBytes;
        streamBytes += chunk.length;
        chunks[stream].push(chunk.subarray(0, room));
        if (chunk.length > room) {
          stop("ENOBUFS");
        }
      });
    }
    child.on("error", (err) => {
      // The command could not be started.
      error = error || err;
      settle(null, null);
    });
    child.on("close", (status, signal) => settle(status, signal));
    if (timeout > 0) {
      timer = setTimeout(() => stop("ETIMEDOUT"), timeout);
    }
  });
}

/**
 * The checks, defaults and records shared by safeSpawnSync and safeSpawn.
 *
 * @param {string} command The executable to spawn
 * @param {string[]} args Arguments to pass to the command
 * @param {Object} options Options forwarded to the spawner
 * @param {Function} spawner spawnSync, or a function that resolves with a result of the same shape
 * @returns {Object|Promise<Object>} The spawner's result, or a blocked result
 */
function guardedSpawn(command, args, options, spawner) {
  const activityDescriptor = buildCommandActivityDescriptor(
    command,
    args,
    options,
  );
  const allowedCommandsEnv = readEnvironmentVariable("CDXGEN_ALLOWED_COMMANDS");
  const commandAllowed = isAllowedCommand(command, allowedCommandsEnv);
  if (allowedCommandsEnv) {
    recordPolicyActivity(command, {
      metadata: {
        allowed: commandAllowed,
        allowlist: allowedCommandsEnv,
        policyType: "command-allowlist",
      },
      reason: `${commandAllowed ? "Allowed" : "Blocked"} command ${command} against CDXGEN_ALLOWED_COMMANDS.`,
      status: commandAllowed ? "completed" : "blocked",
      traceDetail: "allowlist",
    });
  }
  if (isSecureMode && process.permission) {
    const hasChildPermission = process.permission.has("child");
    recordPolicyActivity(command, {
      metadata: {
        allowed: hasChildPermission,
        policyType: "child-process",
      },
      reason: `${hasChildPermission ? "Confirmed" : "Denied"} child-process permission for ${command}.`,
      status: hasChildPermission ? "completed" : "blocked",
      traceDetail: "child-permission",
    });
  }
  if (isDryRun) {
    const error = createDryRunError(
      "execute",
      command,
      activityDescriptor.blockedReason,
    );
    recordActivity({
      kind: activityDescriptor.kind,
      ...activityDescriptor.metadata,
      reason: error.message,
      status: "blocked",
      target: activityDescriptor.target,
    });
    return {
      status: 1,
      stdout: undefined,
      stderr: undefined,
      error,
    };
  }
  if (
    (isSecureMode && process.permission && !process.permission.has("child")) ||
    !commandAllowed
  ) {
    if (DEBUG_MODE) {
      console.log(`cdxgen lacks execute permission for ${command}`);
    }
    recordActivity({
      kind: activityDescriptor.kind,
      ...activityDescriptor.metadata,
      reason: "cdxgen lacks execute permission for this command.",
      status: "blocked",
      target: activityDescriptor.target,
    });
    return {
      status: 1,
      stdout: undefined,
      stderr: undefined,
      error: new Error("No execute permission"),
    };
  }
  // On Windows, cmd.exe and, without a shell, libuv look in the working
  // directory (inherited when no cwd is given) before PATH, so a scanned project
  // could otherwise replace the tool cdxgen means to run. This holds outside
  // secure mode too, since --no-install-deps scans still run version probes
  // and read-only tools with the project as the working directory.
  if (isWindowsShellHijackRisk(command, options)) {
    const blockedReason = `${command} matches local file in cwd (Windows shell hijack risk)`;
    console.warn(`\x1b[1;31mSecurity Alert: ${blockedReason}\x1b[0m`);
    recordActivity({
      kind: activityDescriptor.kind,
      ...activityDescriptor.metadata,
      reason: blockedReason,
      status: "blocked",
      target: activityDescriptor.target,
    });
    return {
      status: 1,
      stdout: undefined,
      stderr: undefined,
      error: new Error(blockedReason),
    };
  }
  if (isSecureMode) {
    if (options?.cwd && options.cwd !== resolve(options.cwd)) {
      if (DEBUG_MODE) {
        console.log(
          "Executing commands with a relative cwd can cause security issues.",
        );
      }
    }
  }
  // Read before the option is stripped below: a caller composing shell
  // fragments itself opts out of argument quoting with this flag.
  const rawShellArgs = options?.cdxgenRawShellArgs === true;
  if (!options) {
    options = {};
  } else if (options.cdxgenActivity || options.cdxgenRawShellArgs) {
    options = {
      ...options,
    };
  }
  if (options.cdxgenActivity) {
    delete options.cdxgenActivity;
  }
  if (options.cdxgenRawShellArgs) {
    delete options.cdxgenRawShellArgs;
  }
  if (options.shell === true) {
    const unsafeShellToken = getUnsafeShellToken(command, args);
    if (unsafeShellToken !== undefined) {
      const blockedReason = `Blocked shell execution for ${command}: command or argument contains shell metacharacters.`;
      console.warn(`\x1b[1;31mSecurity Alert: ${blockedReason}\x1b[0m`);
      recordActivity({
        kind: activityDescriptor.kind,
        ...activityDescriptor.metadata,
        reason: blockedReason,
        status: "blocked",
        target: activityDescriptor.target,
      });
      return {
        status: 1,
        stdout: undefined,
        stderr: undefined,
        error: new Error(blockedReason),
      };
    }
  }
  // Inject maxBuffer
  if (!options.maxBuffer) {
    options.maxBuffer = MAX_BUFFER;
  }
  // Inject encoding
  if (!options.encoding) {
    options.encoding = "utf-8";
  }
  // Inject timeout
  if (!options.timeout) {
    options.timeout = TIMEOUT_MS;
  }
  // Emit certain operational warnings only once per process to keep audit logs readable.
  const emitNoticeOnce = (noticeKey, message, level = "warn") => {
    if (!globalThis.__cdxgenNoticeCache) {
      globalThis.__cdxgenNoticeCache = new Set();
    }
    if (globalThis.__cdxgenNoticeCache.has(noticeKey)) {
      return;
    }
    globalThis.__cdxgenNoticeCache.add(noticeKey);
    if (level === "log") {
      console.log(message);
      return;
    }
    console.warn(message);
  };
  // Check for -S for python invocations in secure mode
  if (command.includes("python") && (!args?.length || args[0] !== "-S")) {
    if (isSecureMode) {
      emitNoticeOnce(
        "python-without-S-secure",
        "\x1b[1;35mNotice: Running python command without '-S' argument. This is a bug in cdxgen. Please report with an example repo here https://github.com/cdxgen/cdxgen/issues.\x1b[0m",
      );
    } else if (readEnvironmentVariable("CDXGEN_IN_CONTAINER") === "true") {
      emitNoticeOnce(
        "python-without-S-container",
        "Running python command without '-S' argument.",
        "log",
      );
    } else {
      emitNoticeOnce(
        "python-without-S-host",
        "\x1b[1;35mNotice: Running python command without '-S' argument. Only run cdxgen in trusted directories to prevent auto-executing local scripts.\x1b[0m",
      );
    }
  }
  let isPyPackageInstall = false;
  if (command.includes("pip") && args?.includes("install")) {
    isPyPackageInstall = true;
  } else if (
    command.includes("python") &&
    args?.includes("pip") &&
    args?.includes("install")
  ) {
    isPyPackageInstall = true;
  } else if (
    command.includes("uv") &&
    args?.includes("pip") &&
    args?.includes("install")
  ) {
    isPyPackageInstall = true;
  }
  if (isPyPackageInstall) {
    const hasOnlyBinary = args?.some(
      (arg) => arg === "--only-binary" || arg.startsWith("--only-binary="),
    );
    if (!hasOnlyBinary) {
      if (isSecureMode) {
        emitNoticeOnce(
          "pip-without-only-binary-secure",
          "\x1b[1;31mSecurity Alert: pip/uv install invoked without '--only-binary' argument in secure mode. This is a bug in cdxgen and introduces Arbitrary Code Execution (ACE) risks. Please report with an example repo here https://github.com/cdxgen/cdxgen/issues.\x1b[0m",
        );
      } else if (readEnvironmentVariable("CDXGEN_IN_CONTAINER") === "true") {
        emitNoticeOnce(
          "pip-without-only-binary-container",
          "Running pip/uv install without '--only-binary' argument.",
          "log",
        );
      } else {
        emitNoticeOnce(
          "pip-without-only-binary-host",
          "\x1b[1;35mNotice: pip/uv install invoked without '--only-binary'. This allows executing untrusted setup.py scripts. Only run cdxgen in trusted directories.\x1b[0m",
        );
      }
    }
  }
  traceLog("spawn", { command, args, ...options });
  commandsExecuted.add(command);
  // The tool as invoked, before a shell invocation folds the arguments in.
  const executedCommand = command;
  // Fix for DEP0190 warning
  if (options?.shell === true) {
    const joined = joinShellCommand(command, args, rawShellArgs);
    command = joined;
    if (args?.length) {
      args = undefined;
    }
  }
  // The env option as the caller wrote it: the copy below always carries an
  // environment, so the Deno branch needs the original to tell one the
  // runtime's merge delivers unchanged from one it does not.
  const callerEnv = options.env;
  // spawnSync lists the child's variables with for...in, which also walks
  // the env object's prototype, so it gets own properties only.
  options = { ...options, env: ownEnvironment(options.env) };
  const recordResult = (spawned) => {
    // Node reports a spawn that never started, a missing binary for example,
    // with a null status, while bun leaves the field undefined. The wrapper's
    // contract is node's shape under every runtime.
    const result =
      spawned.error && spawned.status === undefined
        ? { ...spawned, status: null }
        : spawned;
    // The run-scoped tool registry feeds metadata.tools (issue #598); every
    // external execution funnels through this wrapper. A spawn that failed to
    // start, such as a missing binary, ran nothing and is not recorded; through
    // a shell, a missing command shows as exit code 127, or 9009 on cmd.exe.
    const shellCommandNotFound =
      options?.shell === true && [127, 9009].includes(result.status);
    if (!result.error && !shellCommandNotFound) {
      recordExecutedTool(executedCommand, undefined, { cwd: options?.cwd });
    }
    recordActivity({
      kind: activityDescriptor.kind,
      ...activityDescriptor.metadata,
      stderrBytes: getOutputByteSize(result.stderr, options.encoding),
      reason: result.error?.message,
      status: result.status === 0 && !result.error ? "completed" : "failed",
      stdoutBytes: getOutputByteSize(result.stdout, options.encoding),
      target: activityDescriptor.target,
    });
    return result;
  };
  const spawned = spawner(command, args, options, callerEnv);
  return spawned instanceof Promise
    ? spawned.then(recordResult)
    : recordResult(spawned);
}

/** Default spawn timeout in milliseconds (20 minutes), overridable via CDXGEN_TIMEOUT_MS. */
export const TIMEOUT_MS =
  Number.parseInt(readEnvironmentVariable("CDXGEN_TIMEOUT_MS"), 10) ||
  20 * 60 * 1000;

/** Default maxBuffer size for spawned process stdout/stderr (100 MB), overridable via CDXGEN_MAX_BUFFER. */
export const MAX_BUFFER =
  Number.parseInt(readEnvironmentVariable("CDXGEN_MAX_BUFFER"), 10) ||
  100 * 1024 * 1024;

/**
 * Name the directory the matches of a file search must stay inside once
 * symbolic links are resolved.
 *
 * That is the directory searched, with two exceptions. A caller that searches
 * a directory named by the scanned project, such as a workspace member, names
 * the directory that name is relative to. And the directories of an exploded
 * image are searched one at a time, while a link from one of them to another
 * is part of the image.
 *
 * @param {string} dirPath Root directory for search
 * @param {Object} options CLI options
 * @param {string} [rootDir] Directory named by the caller
 *
 * @returns {string} Directory the matches must resolve inside
 */
function getDiscoveryRootDir(dirPath, options, rootDir) {
  if (rootDir) {
    return rootDir;
  }
  const imageDir = options.allLayersExplodedDir;
  if (
    imageDir &&
    isPathInsideProject(resolve(dirPath || ""), resolve(imageDir))
  ) {
    return imageDir;
  }
  return dirPath;
}

/**
 * Method to get files matching a pattern
 *
 * A match that a symbolic link, or a `..` or absolute path in the pattern,
 * places outside the directory searched is left out.
 *
 * @param {string} dirPath Root directory for search
 * @param {string} pattern Glob pattern (eg: *.gradle)
 * @param {Object} options CLI options
 * @param {string} [rootDir] Directory the matches must resolve inside, for a
 *   dirPath that was named by the scanned project. Defaults to dirPath, or to
 *   the exploded image that holds it.
 *
 * @returns {Array[string]} List of matched files
 */
export function getAllFiles(
  dirPath,
  pattern,
  options = {},
  rootDir = undefined,
) {
  let ignoreList = [];
  if (!options.noIgnore) {
    // .chen holds chen's AST cache, which atom writes into a C/C++ source tree
    ignoreList.push("**/.hg/**", "**/.git/**", "**/.chen/**");
    // Only ignore node_modules if the caller is not looking for package.json
    if (!pattern.includes("package.json") && !options.includeNodeModulesDir) {
      ignoreList.push("**/node_modules/**");
    } else if (options.includeNodeModulesDir === false) {
      ignoreList.push("**/node_modules/**");
    }
  }
  if (options?.exclude && Array.isArray(options.exclude)) {
    ignoreList = ignoreList.concat(options.exclude);
  }
  const includeDot =
    options.includeDot ||
    pattern.startsWith(".") ||
    options.includeNodeModulesDir ||
    options.noIgnore;
  const discoveryRootDir = getDiscoveryRootDir(dirPath, options, rootDir);
  const defaultHits = getAllFilesWithIgnore(
    dirPath,
    pattern,
    includeDot,
    ignoreList,
    discoveryRootDir,
  );
  // Support for specifying the pattern via options
  if (options?.include?.length) {
    const includeOnlyHits = getAllFilesWithIgnore(
      dirPath,
      options.include,
      includeDot,
      ignoreList,
      discoveryRootDir,
    );
    if (!includeOnlyHits.length) {
      return [];
    }
    // Both lists can hold every file of the scanned tree, so intersect them
    // through a Set rather than searching one list once per entry of the other.
    const includeOnlyHitSet = new Set(includeOnlyHits);
    return defaultHits.filter((f) => includeOnlyHitSet.has(f));
  }
  return defaultHits;
}

/**
 * Directory-walk caches, keyed by the root each walk starts from, and the one
 * subtree they may be used for.
 *
 * A container scan enumerates the same rootfs path from about 25 ecosystem
 * legs, each with a different glob pattern. `glob` reads the tree through a
 * `PathScurry`, which memoises `readdir` and `lstat` per directory, so handing
 * every call for a root the same instance turns those repeated walks into one
 * walk followed by in-memory lookups. Pattern matching, ignore handling,
 * ordering and dotfile rules all stay inside `glob`.
 *
 * Memoised directory entries describe the tree as it was first read, so they
 * may only be reused where nothing changes during the scan. That holds for the
 * exploded image layers, which are written once by the extractor and read from
 * then on, and not for a source tree, where a build tool invoked by one
 * ecosystem writes the lock file another goes on to look for. Caching is
 * therefore confined to a subtree named by {@link setDirWalkCacheRoot}.
 *
 * A `PathScurry` is bound to the case sensitivity it was built with, so the
 * cache holds one per root for the `nocase` walks issued from here.
 */
const dirWalkCache = new Map();
let dirWalkCacheRoot;

/**
 * Confine directory-walk caching to one subtree, or switch it off.
 *
 * @param {string|undefined} rootDir Subtree whose contents are fixed for the rest of the scan
 */
export function setDirWalkCacheRoot(rootDir) {
  if (rootDir !== dirWalkCacheRoot) {
    dirWalkCache.clear();
  }
  dirWalkCacheRoot = rootDir || undefined;
}

/**
 * Return the shared directory-walk cache for a root, creating it on first use.
 *
 * Constructing a `Glob` does not touch the filesystem; it is the supported way
 * to obtain the `PathScurry` that `glob` would otherwise build per call.
 *
 * @param {string} dirPath Root directory the walk starts from
 * @returns {object|undefined} Cache to pass to `globSync`, or undefined when the path is not cacheable
 */
function getDirWalkCache(dirPath) {
  if (!(dirWalkCacheRoot && dirPath?.startsWith(dirWalkCacheRoot))) {
    return undefined;
  }
  if (dirWalkCache.has(dirPath)) {
    return dirWalkCache.get(dirPath);
  }
  let scurry;
  try {
    scurry = new Glob("**/*", { cwd: dirPath, nocase: true }).scurry;
  } catch (_err) {
    scurry = undefined;
  }
  dirWalkCache.set(dirPath, scurry);
  return scurry;
}

/**
 * Directories a warning about ignored files was already printed for. An image
 * can hold many links that lead out of it, and one line per directory tells
 * the operator what happened. Emptied with the file discovery cache.
 */
const outsideLinkWarnings = new Set();

/**
 * Release every cached directory walk.
 *
 * Called when a BOM generation cycle starts, so that a long-lived process such
 * as the server never serves a scan from an earlier scan's view of the
 * filesystem, and so the retained directory entries are freed.
 */
export function clearFileDiscoveryCache() {
  dirWalkCache.clear();
  dirWalkCacheRoot = undefined;
  outsideLinkWarnings.clear();
}

/**
 * Whether the operator asked to read the files that symbolic links place
 * outside the directory searched, such as the packages of an `npm link` or of
 * a pnpm workspace when one member is scanned on its own. Secure mode never
 * reads them.
 *
 * @returns {boolean} True when such files are kept
 */
function followsExternalSymlinks() {
  return (
    !isSecureMode &&
    ["true", "1"].includes(
      readEnvironmentVariable("CDXGEN_FOLLOW_EXTERNAL_SYMLINKS"),
    )
  );
}

/**
 * Resolve every symbolic link in a path.
 *
 * @param {string} filePath Path that exists
 * @returns {string} Real path
 * @throws {Error} When the path, or the target of a link in it, is missing
 */
function realPath(filePath) {
  if (realpathSync.native) {
    try {
      return realpathSync.native(filePath);
    } catch {
      // The native call fails on some Windows volumes, such as RAM disks.
    }
  }
  return realpathSync(filePath);
}

/**
 * Keep the matches of a file search that really are files the search may
 * return.
 *
 * `follow: false` only keeps a leading `**` from descending into symbolic
 * links. `glob` still returns a link whose own name matches, walks a literal
 * segment or a later `**` through a linked directory, and accepts `..` and
 * absolute paths in a pattern that came from a manifest. The callers read
 * every match as a file of the project, so a `requirements.txt` that links to
 * /proc/self/environ would put the environment of the scan into the BOM. A
 * match is therefore kept only when its real path is below the real path of
 * rootDir. The ignore list is matched against the name a file was found by,
 * so a match that is reached through a link is also checked against it under
 * its real name: .git/config holds the credentials of a CI checkout. Links
 * that stay inside, such as pnpm's `node_modules` layout, are kept under the
 * name they were found by, and a link with no target is left out because
 * there is nothing to read.
 *
 * @param {string[]} files Absolute paths matched by glob
 * @param {string} rootDir Directory the matches must resolve inside
 * @param {Array} ignoreList Directory patterns to ignore
 * @param {string} patternValue Pattern searched for, for the activity record
 *
 * @returns {string[]} Matches that resolve to a path inside rootDir
 */
function keepFilesInsideDir(files, rootDir, ignoreList, patternValue) {
  if (!files.length || followsExternalSymlinks()) {
    return files;
  }
  const absRootDir = resolve(rootDir || "");
  const realRootDir = realPath(absRootDir);
  const realRootPrefix = realRootDir.endsWith(sep)
    ? realRootDir
    : `${realRootDir}${sep}`;
  const metadata = {
    pattern: patternValue,
    resolutionKind: "file-discovery",
  };
  let realRoot;
  let realIgnore;
  const isIgnored = (realFile) => {
    if (!ignoreList?.length) {
      return false;
    }
    if (!realIgnore) {
      realRoot = new Glob("**/*", { cwd: realRootDir, nocase: true }).scurry
        .cwd;
      realIgnore = new Ignore(ignoreList, { nocase: true }, realRoot);
    }
    return realIgnore.ignored(realRoot.resolve(realFile));
  };
  return files.filter((file) => {
    let realFile;
    try {
      realFile = realPath(file);
    } catch (err) {
      // A broken or looping link has nothing to read.
      recordSymlinkResolution(file, undefined, {
        errorCode: err?.code || err?.name,
        metadata,
        reason: `Ignored ${file}, which could not be resolved.`,
        status: "failed",
      });
      return false;
    }
    let cause;
    if (!realFile.startsWith(realRootPrefix)) {
      cause = `is outside '${absRootDir}'`;
    } else if (realFile !== file && isIgnored(realFile)) {
      cause = "this search ignores";
    } else {
      return true;
    }
    recordSymlinkResolution(file, realFile, {
      metadata,
      reason: `Ignored ${file}, since it resolves to ${realFile}, which ${cause}.`,
      status: "blocked",
    });
    if (!outsideLinkWarnings.has(realRootDir)) {
      outsideLinkWarnings.add(realRootDir);
      console.warn(
        `'${file}' resolves to '${realFile}', which ${cause}. cdxgen does not read files that a symbolic link or a pattern places outside the directory it searches, or inside a directory the search ignores, such as .git.${isSecureMode ? "" : " Set CDXGEN_FOLLOW_EXTERNAL_SYMLINKS=true to read them when the directory is trusted."}`,
      );
    }
    return false;
  });
}

/**
 * Symbolic links a file search may go through on any one path below the
 * directory it starts from.
 */
const MAX_LINKS_PER_WALK_PATH = 1;

/**
 * Ignore rules of a glob walk that stops descending once a path below the
 * directory it starts from has gone through more than
 * {@link MAX_LINKS_PER_WALK_PATH} symbolic links.
 */
class LinkBoundedIgnore extends Ignore {
  #walkRoot;

  constructor(ignoreList, globOptions, walkRoot) {
    super(ignoreList, globOptions, walkRoot);
    this.#walkRoot = walkRoot;
  }

  childrenIgnored(entry) {
    let links = 0;
    for (
      let segment = entry;
      segment && segment !== this.#walkRoot;
      segment = segment.parent
    ) {
      // glob resolves a literal segment of a pattern without reading its
      // directory, so it may not know yet what the segment is.
      const known = segment.isUnknown() ? segment.lstatSync() : segment;
      if (known?.isSymbolicLink() && ++links > MAX_LINKS_PER_WALK_PATH) {
        return true;
      }
    }
    return super.childrenIgnored(entry);
  }
}

/**
 * Bound the symbolic links a glob walk goes through.
 *
 * `follow: false` only keeps `**` from walking on through the symbolic links
 * it meets. Every other segment of a pattern, a `*` or a name, goes through
 * the link it matches. Links that lead back into the tree then let a pattern
 * of n segments reach a directory along 2^n paths: two links to `.` and a
 * workspace member pattern of `*` segments are enough, and so are two
 * directories that each hold a link to `..`. A walk with the returned options
 * goes through at most one link on any path below the directory it starts
 * from. That keeps a workspace member that is a link, and bounds the paths of
 * a walk by the links in the tree rather than by the length of the pattern.
 * Use it for every walk whose pattern comes from scanned content.
 *
 * @param {object} globOptions Options of the glob call, including `cwd` and any `ignore` patterns
 * @returns {object} The options to pass to glob instead
 */
export function linkBoundedGlobOptions(globOptions) {
  // The ignore rules and the walk have to share one PathScurry: the rules
  // recognise the directory the walk starts from by its entry there.
  const scurry =
    globOptions.scurry || new Glob("**/*", { ...globOptions }).scurry;
  return {
    ...globOptions,
    ignore: new LinkBoundedIgnore(
      [globOptions.ignore ?? []].flat(),
      { ...globOptions, nocase: scurry.nocase },
      scurry.cwd,
    ),
    scurry,
  };
}

/**
 * Method to get files matching a pattern
 *
 * @param {string} dirPath Root directory for search
 * @param {string} pattern Glob pattern (eg: *.gradle)
 * @param {Boolean} includeDot whether hidden files can be included.
 * @param {Array} ignoreList Directory patterns to ignore
 * @param {string} [rootDir] Directory the matches must resolve inside once
 *   symbolic links are followed. Defaults to dirPath.
 *
 * @returns {Array[string]} List of matched files
 */
export function getAllFilesWithIgnore(
  dirPath,
  pattern,
  includeDot,
  ignoreList,
  rootDir = dirPath,
) {
  const patternValue = Array.isArray(pattern)
    ? pattern.join(",")
    : String(pattern);
  const discoveryMetadata = classifyDiscoveryPattern(patternValue);
  try {
    const matches = globSync(
      pattern,
      linkBoundedGlobOptions({
        cwd: dirPath,
        absolute: true,
        nocase: true,
        nodir: true,
        dot: includeDot,
        follow: false,
        ignore: ignoreList,
        scurry: getDirWalkCache(dirPath),
      }),
    );
    const files = keepFilesInsideDir(
      matches,
      rootDir,
      ignoreList,
      patternValue,
    );
    recordDiscoveryActivity(`${dirPath} :: ${patternValue}`, {
      metadata: {
        discoveryType: discoveryMetadata.discoveryType,
        matchedCount: files.length,
        pattern: patternValue,
      },
      traceDetail: `matched:${files.length}`,
      reasonBuilder: (count) =>
        `Scanned ${dirPath} with glob '${patternValue}' for ${discoveryMetadata.label}; matched ${files.length} path(s)${buildReadCountSuffix(count)}.`,
    });
    recordSuspiciousShellPathActivities(files, {
      discoveryType: discoveryMetadata.discoveryType,
      pattern: patternValue,
    });
    if (files.length > 1) {
      thoughtLog(
        `Found ${files.length} files for the pattern '${pattern}' at '${dirPath}'.`,
      );
    }
    return files;
  } catch (err) {
    recordDiscoveryActivity(`${dirPath} :: ${patternValue}`, {
      metadata: {
        discoveryType: discoveryMetadata.discoveryType,
        pattern: patternValue,
      },
      reason: `File discovery failed for glob '${patternValue}' under ${dirPath}: ${err.message}`,
      status: "failed",
    });
    if (DEBUG_MODE) {
      console.error(err);
    }
    return [];
  }
}

/**
 * Return the current timestamp in YYYY-MM-DDTHH:MM:SSZ format.
 *
 * @returns {string} ISO formatted timestamp, without milliseconds.
 */
export function getTimestamp() {
  return `${new Date().toISOString().split(".")[0]}Z`;
}

/**
 * Return the temp directory, creating CDXGEN_TEMP_DIR when it is set but does
 * not yet exist. Falls back to the OS tmpdir when unset.
 *
 * @returns {string} Resolved temp directory path.
 */
export function getTmpDir() {
  if (
    readEnvironmentVariable("CDXGEN_TEMP_DIR") &&
    !safeExistsSync(readEnvironmentVariable("CDXGEN_TEMP_DIR"))
  ) {
    safeMkdirSync(readEnvironmentVariable("CDXGEN_TEMP_DIR"), {
      recursive: true,
    });
  }
  return readEnvironmentVariable("CDXGEN_TEMP_DIR") || tmpdir();
}

/**
 * Computes the checksum for a file path using the given hash algorithm
 *
 * @param {string} hashName name of hash algorithm
 * @param {string} path path to file
 * @returns {Promise<String>} hex value of hash
 */
export function checksumFile(hashName, path) {
  return new Promise((resolve, reject) => {
    const hash = createHash(hashName);
    const stream = createReadStream(path);
    stream.on("error", (err) => reject(err));
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * Computes multiple checksum for a file path using the given hash algorithms
 *
 * @param {Array[String]} algorithms Array of algorithms
 * @param {string} path path to file
 * @returns {Promise<Object>} hashes object
 */
export function multiChecksumFile(algorithms, path) {
  return new Promise((resolve, reject) => {
    const hashes = {};
    for (const alg of algorithms) {
      hashes[alg] = createHash(alg);
    }
    const stream = createReadStream(path);
    let errorOccurred = false;
    stream.on("error", (err) => {
      errorOccurred = true;
      reject(err);
    });
    stream.on("data", (chunk) =>
      algorithms.forEach((alg) => {
        hashes[alg].update(chunk);
      }),
    );
    stream.on("end", () => {
      algorithms.forEach((alg) => {
        hashes[alg] = hashes[alg].digest("hex");
      });
    });
    stream.on("close", () => {
      if (!errorOccurred) {
        resolve(hashes);
      }
    });
  });
}
