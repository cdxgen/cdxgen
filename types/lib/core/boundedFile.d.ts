/**
 * The largest file scanFileMarkers reads. Larger files are skipped whole
 * rather than read in part, so a marker past the cap is never mistaken for an
 * absent one; the result says the file was skipped.
 *
 * @type {number}
 */
export declare const MAX_MARKER_SCAN_BYTES: number;
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
export declare function openRegularFile(absPath: string, rootDir: string | undefined): {
    fd: number;
    size: number;
} | undefined;
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
export declare function readRegularTextFile(absPath: string, maxBytes: number, rootDir?: string | undefined): string | undefined;
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
export declare function scanFileMarkers(absPath: string, rootDir: string | undefined, markers: Buffer[], { maxBytes, contextBytes, beforeBytes, maxHits, }?: {
    maxBytes?: number;
    contextBytes?: number;
    beforeBytes?: number;
    maxHits?: number;
}): {
    hits: {
        before: Buffer;
        after: Buffer;
        offset: number;
    }[][];
    size: number;
    skipped?: string;
} | undefined;
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
export declare function hashRegularFile(absPath: string, maxBytes: number, rootDir?: string | undefined, algorithm?: string): string | undefined;
/**
 * True when the process runs as root, where a symlink planted in a user's
 * home could point a scan at files only root can read.
 *
 * @returns {boolean} true for uid 0
 */
export declare function isRunningAsRoot(): boolean;
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
export declare function readUserFileText(absPath: string, maxBytes: number): string | undefined;
//# sourceMappingURL=boundedFile.d.ts.map