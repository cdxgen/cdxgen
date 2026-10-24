// Bounded, read-only access to files inside an extracted image or a live host.
//
// Every file a scan opens may be hostile: only regular files that stay inside
// the extracted root are opened, a symlink is never followed, a FIFO is never
// opened, and reads are capped. A missing or odd file yields no result rather
// than throwing.

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { resolve, sep } from "node:path";

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
 * Open a path only when it is a regular file that does not resolve outside
 * rootDir. lstat runs first so a FIFO is rejected without opening it (an open
 * on a FIFO blocks until a writer appears) and a symlink is never followed.
 *
 * @param {string} absPath absolute path
 * @param {string|undefined} rootDir extracted root the path must stay under
 * @returns {{fd: number, size: number}|undefined} an open descriptor the
 *   caller closes, or undefined
 */
export function openRegularFile(absPath, rootDir) {
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
    if (!stats.isFile()) {
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
 * @returns {string|undefined} the text, or undefined
 */
export function readRegularTextFile(absPath, maxBytes, rootDir) {
  const opened = openRegularFile(absPath, rootDir);
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
  } = {},
) {
  if (!Array.isArray(markers) || !markers.length) {
    return undefined;
  }
  const opened = openRegularFile(absPath, rootDir);
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
