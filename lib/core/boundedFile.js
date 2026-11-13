// Bounded, read-only access to files inside an extracted image or a live host.
//
// Every file a scan opens may be hostile: only regular files that stay inside
// the extracted root are opened, a symlink is never followed, a FIFO is never
// opened, and reads are capped. A missing or odd file yields no result rather
// than throwing.

import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readlinkSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";
import process from "node:process";

const READ_CHUNK_BYTES = 1024 * 1024;

// O_NOFOLLOW refuses a symlink swapped in after lstat, and O_NONBLOCK keeps a
// FIFO swapped in the same way from blocking the open. Neither exists on
// Windows, where neither race applies.
const OPEN_FLAGS =
  constants.O_RDONLY |
  (constants.O_NOFOLLOW || 0) |
  (constants.O_NONBLOCK || 0);

/**
 * The largest file scanFileMarkers reads. Larger files are skipped whole
 * rather than read in part, so a marker past the cap is never mistaken for an
 * absent one; the result says the file was skipped.
 *
 * @type {number}
 */
export const MAX_MARKER_SCAN_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Whether no name between base and path is a symbolic link: the real path of
 * path is the real path of base followed by the names that lead from base to
 * path. A link that leads back to the same place still counts as a link.
 *
 * @param {string} base directory the path hangs off
 * @param {string} path path below base
 * @returns {boolean} false as well when either cannot be resolved
 */
export function isReachedWithoutLinks(base, path) {
  try {
    return sameLocation(
      realpathSync(path),
      join(realpathSync(base), relative(base, path)),
    );
  } catch {
    return false;
  }
}

function sameLocation(left, right) {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

// Whether the file open at fd was reached from base through no symbolic link.
// Linux names the opened file in /proc, which settles it for the open itself.
// Elsewhere the path is checked again after the open, and must still lead to
// the file that was opened.
function openedWithoutLinks(fd, stats, base, absPath) {
  let expected;
  try {
    expected = join(realpathSync(base), relative(base, absPath));
  } catch {
    return false;
  }
  if (process.platform === "linux") {
    try {
      return readlinkSync(`/proc/self/fd/${fd}`) === expected;
    } catch {
      // no /proc
    }
  }
  try {
    const current = statSync(absPath);
    return (
      isReachedWithoutLinks(base, absPath) &&
      current.dev === stats.dev &&
      current.ino === stats.ino
    );
  } catch {
    return false;
  }
}

/**
 * Open a path only when it is a regular file that does not resolve outside
 * rootDir. lstat runs first so a FIFO is rejected without opening it (an open
 * on a FIFO blocks until a writer appears) and a symlink is never followed.
 *
 * @param {string} absPath absolute path
 * @param {string|undefined} rootDir extracted root the path must stay under
 * @param {string} [linkFreeBase] directory from which no name on the way to
 *   the file may be a symbolic link, checked against the file that was opened
 * @returns {{fd: number, size: number}|undefined} an open descriptor the
 *   caller closes, or undefined
 */
export function openRegularFile(absPath, rootDir, linkFreeBase) {
  let fd;
  try {
    if (typeof absPath !== "string" || !absPath) {
      return undefined;
    }
    const lst = lstatSync(absPath);
    if (!lst.isFile()) {
      return undefined;
    }
    if (rootDir) {
      const root = realpathSync(resolve(rootDir));
      const real = realpathSync(absPath);
      const rootPrefix = root.endsWith(sep) ? root : root + sep;
      if (real !== root && !real.startsWith(rootPrefix)) {
        return undefined;
      }
    }
    fd = openSync(absPath, OPEN_FLAGS);
    const stats = fstatSync(fd);
    if (
      !stats.isFile() ||
      (linkFreeBase && !openedWithoutLinks(fd, stats, linkFreeBase, absPath))
    ) {
      closeSync(fd);
      return undefined;
    }
    return { fd, size: stats.size };
  } catch {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
    }
    return undefined;
  }
}

/**
 * Read a small text file in full, only when it is a regular file no larger
 * than maxBytes. A FIFO, a directory, a symlink or an oversized file reads as
 * undefined.
 *
 * @param {string} absPath absolute path
 * @param {number} maxBytes largest size read
 * @param {string|undefined} [rootDir] root the path must stay under
 * @param {string} [linkFreeBase] directory from which no name on the way to
 *   the file may be a symbolic link
 * @returns {string|undefined} the text, or undefined
 */
export function readRegularTextFile(absPath, maxBytes, rootDir, linkFreeBase) {
  const opened = openRegularFile(absPath, rootDir, linkFreeBase);
  if (!opened) {
    return undefined;
  }
  try {
    if (opened.size > maxBytes) {
      return undefined;
    }
    const buffer = Buffer.alloc(opened.size);
    let total = 0;
    while (total < opened.size) {
      const read = readSync(
        opened.fd,
        buffer,
        total,
        opened.size - total,
        total,
      );
      if (read <= 0) {
        break;
      }
      total += read;
    }
    return buffer.toString("utf8", 0, total);
  } catch {
    return undefined;
  } finally {
    try {
      closeSync(opened.fd);
    } catch {
      // already closed
    }
  }
}

// Most links followed for one path, as the kernel's own limit.
const MAX_LINK_HOPS = 40;

function isWithin(child, parent) {
  const prefix = parent.endsWith(sep) ? parent : parent + sep;
  if (child === parent || child.startsWith(prefix)) {
    return true;
  }
  return (
    process.platform === "win32" &&
    (child.toLowerCase() === parent.toLowerCase() ||
      child.toLowerCase().startsWith(prefix.toLowerCase()))
  );
}

function pathSegments(text) {
  return `${text}`
    .split(process.platform === "win32" ? /[\\/]/ : "/")
    .filter((part) => part !== "" && part !== ".");
}

/**
 * The real path of a file below scanRoot, when the file exists and every
 * name on the way to it resolves inside the real scanRoot. The path is walked
 * one name at a time from the root: a symbolic link is followed only when its
 * target, as written, stays inside the root, and a `..` that would leave the
 * root ends the walk. No link target outside the root is looked up, so the
 * answer never tells whether a host path exists. Only a path written outside
 * the root has its own ancestors resolved, to match a root reached through a
 * link above it.
 *
 * @param {string} absPath path of the file; a relative path is taken from
 *   the working directory, as the fs functions take it
 * @param {string} scanRoot directory the scan was started from
 * @returns {string|undefined} the real path, or undefined
 */
export function realPathWithin(absPath, scanRoot) {
  if (
    typeof absPath !== "string" ||
    !absPath ||
    typeof scanRoot !== "string" ||
    !scanRoot ||
    absPath.includes("\0")
  ) {
    return undefined;
  }
  try {
    const lexicalRoot = resolve(scanRoot);
    const root = realpathSync(lexicalRoot);
    const target = resolve(absPath);
    let rel;
    if (isWithin(target, lexicalRoot)) {
      rel = relative(lexicalRoot, target);
    } else if (isWithin(target, root)) {
      rel = relative(root, target);
    } else {
      // The path may name the root through a link above it, as /var does
      // for /private/var on macOS.
      for (
        let ancestor = dirname(target);
        ancestor !== dirname(ancestor);
        ancestor = dirname(ancestor)
      ) {
        let realAncestor;
        try {
          realAncestor = realpathSync(ancestor);
        } catch {
          continue;
        }
        if (sameLocation(realAncestor, root)) {
          rel = relative(ancestor, target);
          break;
        }
      }
      if (rel === undefined) {
        return undefined;
      }
    }
    const parts = pathSegments(rel);
    let current = root;
    let hops = 0;
    while (parts.length) {
      const part = parts.shift();
      if (part === "..") {
        current = dirname(current);
        if (!isWithin(current, root)) {
          return undefined;
        }
        continue;
      }
      const next = join(current, part);
      if (!lstatSync(next).isSymbolicLink()) {
        current = next;
        continue;
      }
      hops += 1;
      if (hops > MAX_LINK_HOPS) {
        return undefined;
      }
      let link = readlinkSync(next);
      if (process.platform === "win32" && link.startsWith("\\\\?\\")) {
        link = link.slice(4);
      }
      if (isAbsolute(link) || win32.isAbsolute(link)) {
        // An absolute target counts only when it is written inside the root;
        // its names are then walked from the root like any others.
        if (!isWithin(link, root) && !isWithin(link, lexicalRoot)) {
          return undefined;
        }
        const base = isWithin(link, root) ? root : lexicalRoot;
        parts.unshift(...pathSegments(link.slice(base.length)));
        current = root;
      } else {
        parts.unshift(...pathSegments(link));
      }
    }
    return current;
  } catch {
    // missing, unreadable or refused by the permission model
    return undefined;
  }
}

/**
 * Read a text file found in a scanned tree. The file must resolve inside
 * scanRoot (a symbolic link that stays inside the tree is followed, one that
 * leads out of it is not), must be a regular file, and must be no larger than
 * maxBytes. Without a scan root the file's own directory is the root, so only
 * a link to a sibling is followed.
 *
 * @param {string} absPath path of the file
 * @param {number} maxBytes largest size read
 * @param {string} [scanRoot] directory the scan was started from
 * @returns {string|undefined} the text, or undefined
 */
export function readScanFileText(absPath, maxBytes, scanRoot) {
  if (typeof absPath !== "string" || !absPath) {
    return undefined;
  }
  const root = scanRoot || dirname(resolve(absPath));
  const real = realPathWithin(absPath, root);
  if (!real) {
    return undefined;
  }
  return readRegularTextFile(real, maxBytes, root);
}

/**
 * Find byte markers in a file with bounded chunked reads.
 *
 * Each hit records up to `beforeBytes` bytes before the marker and up to
 * `contextBytes` bytes after it, so a caller can read a version that follows a
 * marker or check what a string is part of. Consecutive reads overlap by the
 * longest marker plus the context length, so a marker split across two reads
 * is seen whole once. Only bytes that were read are searched.
 *
 * @param {string} absPath absolute path of the file
 * @param {string|undefined} rootDir extracted root the file must stay under
 * @param {Buffer[]} markers byte markers to look for
 * @param {Object} [options] options
 * @param {number} [options.maxBytes] files larger than this are not read
 * @param {number} [options.contextBytes=64] bytes kept after each hit
 * @param {number} [options.beforeBytes=1] bytes kept before each hit
 * @param {number} [options.maxHits=16] hits kept per marker
 * @param {string} [options.linkFreeBase] directory from which no name on the
 *   way to the file may be a symbolic link
 * @returns {{hits: {before: Buffer, after: Buffer, offset: number}[][], size: number, skipped?: string}|undefined}
 *   hits per marker, in marker order, and the file size; `skipped` is
 *   `too-large` when the file is over the cap and was not read. Undefined when
 *   the file cannot be opened.
 */
export function scanFileMarkers(
  absPath,
  rootDir,
  markers,
  {
    maxBytes = MAX_MARKER_SCAN_BYTES,
    contextBytes = 64,
    beforeBytes = 1,
    maxHits = 16,
    linkFreeBase,
  } = {},
) {
  if (!Array.isArray(markers) || !markers.length) {
    return undefined;
  }
  const opened = openRegularFile(absPath, rootDir, linkFreeBase);
  if (!opened) {
    return undefined;
  }
  const hits = markers.map(() => []);
  try {
    const { fd, size } = opened;
    if (size > maxBytes) {
      return { hits, size, skipped: "too-large" };
    }
    if (size <= 0) {
      return { hits, size };
    }
    const longest = Math.max(...markers.map((marker) => marker.length));
    const overlap = longest + contextBytes;
    const bufferSize = Math.min(size, READ_CHUNK_BYTES) + overlap;
    const buffer = Buffer.allocUnsafe(bufferSize);
    // The bytes just before the current window, for a hit near its start.
    let previousTail = Buffer.alloc(0);
    for (let position = 0; position < size; position += READ_CHUNK_BYTES) {
      const want = Math.min(bufferSize, size - position);
      const read = readSync(fd, buffer, 0, want, position);
      if (read <= 0) {
        break;
      }
      // What a previous, longer read left in the buffer past `read` is never
      // searched.
      const window = buffer.subarray(0, read);
      // Only hits starting inside this window are new; the overlap lets the
      // next window see a marker and its context that cross the edge. The
      // last window has no next one, so everything it read is searched.
      const isLast = position + read >= size;
      const searchLimit = isLast ? read : Math.min(READ_CHUNK_BYTES, read);
      for (let index = 0; index < markers.length; index++) {
        const marker = markers[index];
        const found = hits[index];
        let offset = window.indexOf(marker);
        while (
          offset !== -1 &&
          offset < searchLimit &&
          found.length < maxHits
        ) {
          const afterStart = offset + marker.length;
          const before =
            offset >= beforeBytes
              ? window.subarray(offset - beforeBytes, offset)
              : Buffer.concat([
                  previousTail,
                  window.subarray(0, offset),
                ]).subarray(-beforeBytes);
          found.push({
            offset: position + offset,
            before: Buffer.from(before),
            after: Buffer.from(
              window.subarray(
                Math.min(afterStart, read),
                Math.min(read, afterStart + contextBytes),
              ),
            ),
          });
          offset = window.indexOf(marker, offset + 1);
        }
      }
      if (read < bufferSize) {
        break;
      }
      previousTail = Buffer.from(
        window.subarray(
          Math.max(0, READ_CHUNK_BYTES - beforeBytes),
          READ_CHUNK_BYTES,
        ),
      );
    }
    return { hits, size };
  } catch {
    return undefined;
  } finally {
    try {
      closeSync(opened.fd);
    } catch {
      // already closed
    }
  }
}

/**
 * Compute the digest of a regular file with bounded chunked reads, under the
 * same rules as readRegularTextFile: a FIFO, a directory, a symlink, a file
 * that resolves outside rootDir or one larger than maxBytes yields undefined.
 *
 * @param {string} absPath absolute path
 * @param {number} maxBytes largest size hashed
 * @param {string|undefined} [rootDir] root the path must stay under
 * @param {string} [algorithm="sha256"] node:crypto hash algorithm
 * @returns {string|undefined} the hex digest, or undefined
 */
export function hashRegularFile(
  absPath,
  maxBytes,
  rootDir,
  algorithm = "sha256",
) {
  const opened = openRegularFile(absPath, rootDir);
  if (!opened) {
    return undefined;
  }
  try {
    if (opened.size > maxBytes) {
      return undefined;
    }
    const hash = createHash(algorithm);
    const buffer = Buffer.alloc(Math.min(READ_CHUNK_BYTES, opened.size || 1));
    let total = 0;
    while (total < opened.size) {
      const read = readSync(
        opened.fd,
        buffer,
        0,
        Math.min(buffer.length, opened.size - total),
        total,
      );
      if (read <= 0) {
        break;
      }
      hash.update(buffer.subarray(0, read));
      total += read;
    }
    return hash.digest("hex");
  } catch {
    return undefined;
  } finally {
    try {
      closeSync(opened.fd);
    } catch {
      // already closed
    }
  }
}

/**
 * True when the process runs as root, where a symlink planted in a user's
 * home could point a scan at files only root can read.
 *
 * @returns {boolean} true for uid 0
 */
export function isRunningAsRoot() {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

/**
 * Read a small text file a user keeps in their home, such as an editor's or an
 * agent's configuration. Dotfile managers often make these symlinks, so a
 * symlink to a regular file is followed, except when the process runs as root.
 * The target must still be a regular file no larger than maxBytes.
 *
 * @param {string} absPath absolute path
 * @param {number} maxBytes largest size read
 * @returns {string|undefined} the text, or undefined
 */
export function readUserFileText(absPath, maxBytes) {
  if (typeof absPath !== "string" || !absPath) {
    return undefined;
  }
  let target = absPath;
  try {
    if (lstatSync(absPath).isSymbolicLink()) {
      if (isRunningAsRoot()) {
        return undefined;
      }
      target = realpathSync(absPath);
    }
  } catch {
    return undefined;
  }
  return readRegularTextFile(target, maxBytes);
}
