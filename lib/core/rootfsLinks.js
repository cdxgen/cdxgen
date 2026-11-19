import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { join, parse, relative } from "node:path";
import process from "node:process";

/**
 * The most symbolic links one lookup follows, as the Linux kernel allows.
 */
export const MAX_ROOTFS_LINK_HOPS = 40;

/**
 * Name of a path that exists in no root file system. A read that asks for it
 * finds nothing, which is what a link that cannot be resolved inside the root
 * file system has to give.
 */
const UNRESOLVED_NAME = ".cdxgen-unresolved-link";

const isWindows = process.platform === "win32";

function splitSegments(aPath) {
  return aPath.split(isWindows ? /[\\/]+/ : /\/+/);
}

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
export function resolveInRootfs(
  rootDir,
  relativePath,
  maxHops = MAX_ROOTFS_LINK_HOPS,
) {
  let realRoot;
  try {
    realRoot = realpathSync(rootDir);
  } catch (_err) {
    return undefined;
  }
  const pending = splitSegments(relativePath || "");
  const resolved = [];
  let hops = 0;
  while (pending.length) {
    const segment = pending.shift();
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      resolved.pop();
      continue;
    }
    const candidate = join(realRoot, ...resolved, segment);
    let stats;
    try {
      stats = lstatSync(candidate);
    } catch (_err) {
      return undefined;
    }
    if (!stats.isSymbolicLink()) {
      resolved.push(segment);
      continue;
    }
    hops += 1;
    if (hops > maxHops) {
      return undefined;
    }
    let target;
    try {
      target = readlinkSync(candidate);
    } catch (_err) {
      return undefined;
    }
    const targetRoot = parse(target).root;
    if (targetRoot) {
      resolved.length = 0;
    }
    pending.unshift(...splitSegments(target.slice(targetRoot.length)));
  }
  return join(rootDir, ...resolved);
}

/**
 * The host path to read for a path of an unpacked root file system, for
 * callers that pass the result to a function that reads a file. A path that
 * cannot be resolved inside the root gives a path that does not exist.
 *
 * @param {string} rootDir Directory holding the root file system
 * @param {string} relativePath Path below the root, with or without a leading separator
 * @returns {string} Host path of the target below rootDir
 */
export function rootfsReadPath(rootDir, relativePath) {
  return (
    resolveInRootfs(rootDir, relativePath) ?? join(rootDir, UNRESOLVED_NAME)
  );
}

/**
 * The host path of an entry of an unpacked root file system itself, with the
 * links in its directory resolved and a link at the end kept. Use it to ask
 * whether the entry is a link, as lstat does.
 *
 * @param {string} rootDir Directory holding the root file system
 * @param {string} relativePath Path below the root, with or without a leading separator
 * @returns {string} Host path of the entry below rootDir
 */
export function rootfsEntryPath(rootDir, relativePath) {
  const segments = splitSegments(relativePath || "").filter(
    (segment) => segment && segment !== ".",
  );
  const name = segments.pop();
  if (!name || name === "..") {
    return rootfsReadPath(rootDir, relativePath);
  }
  return join(rootfsReadPath(rootDir, segments.join("/")), name);
}

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
export function isSameInRootfs(rootDir, hostPath) {
  try {
    const resolved = resolveInRootfs(rootDir, relative(rootDir, hostPath));
    return (
      resolved !== undefined &&
      realpathSync(resolved) === realpathSync(hostPath)
    );
  } catch (_err) {
    return false;
  }
}
