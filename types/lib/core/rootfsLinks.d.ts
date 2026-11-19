/**
 * The most symbolic links one lookup follows, as the Linux kernel allows.
 */
export declare const MAX_ROOTFS_LINK_HOPS = 40;
/**
 * Resolve a path of an unpacked root file system the way the image would see
 * it. An absolute link target starts at the root of the root file system, a
 * relative one at the directory that holds the link, and `..` stops at the
 * root, as in a chroot. The host file system outside the root is never read.
 *
 * @param {string} rootDir Directory holding the root file system
 * @param {string} relativePath Path below the root, with or without a leading separator
 * @param {number} [maxHops] Links followed before the lookup gives up
 * @returns {string|undefined} Host path of the target, below rootDir as it was
 *   given. undefined when the path does not exist, or the links loop or
 *   exceed maxHops.
 */
export declare function resolveInRootfs(rootDir: string, relativePath: string, maxHops?: number): string | undefined;
/**
 * The host path to read for a path of an unpacked root file system, for
 * callers that pass the result to a function that reads a file. A path that
 * cannot be resolved inside the root gives a path that does not exist.
 *
 * @param {string} rootDir Directory holding the root file system
 * @param {string} relativePath Path below the root, with or without a leading separator
 * @returns {string} Host path of the target below rootDir
 */
export declare function rootfsReadPath(rootDir: string, relativePath: string): string;
/**
 * The host path of an entry of an unpacked root file system itself, with the
 * links in its directory resolved and a link at the end kept. Use it to ask
 * whether the entry is a link, as lstat does.
 *
 * @param {string} rootDir Directory holding the root file system
 * @param {string} relativePath Path below the root, with or without a leading separator
 * @returns {string} Host path of the entry below rootDir
 */
export declare function rootfsEntryPath(rootDir: string, relativePath: string): string;
/**
 * Check that a path below an unpacked root file system leads to the same
 * place for the image and for this host, so that a read by the host path
 * reads what the image would.
 *
 * @param {string} rootDir Directory holding the root file system
 * @param {string} hostPath Path below rootDir, as joined to it
 * @returns {boolean} false for a path that goes through a link the image
 *   resolves elsewhere, and for one that does not exist
 */
export declare function isSameInRootfs(rootDir: string, hostPath: string): boolean;
//# sourceMappingURL=rootfsLinks.d.ts.map