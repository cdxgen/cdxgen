import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, win32 } from "node:path";

/**
 * Containment check for a path taken from a lockfile (issue #3816). A crafted
 * npm lockfile can name `file:`/`link:` specifiers or link targets built from
 * `..` chains or absolute paths, so a parser that is about to list such an
 * entry checks the resolved path against the project root first.
 *
 * The candidate is resolved against `projectRoot`, so both relative values
 * and the absolute paths arborist already normalised are accepted. The root
 * itself counts as inside: a lockfile may legitimately link the project to
 * its own directory.
 *
 * @param {string} candidate Path to check, absolute or relative to projectRoot
 * @param {string} projectRoot Project root the path must stay inside; a falsy
 *   root means the current working directory, mirroring `node:path`
 *
 * @returns {Boolean} True when the path is inside projectRoot
 */
export function isPathInsideProject(candidate, projectRoot) {
  if (typeof candidate !== "string" || !candidate) {
    return false;
  }
  if (candidate.includes("\0")) {
    return false;
  }
  const rootAbs = resolve(projectRoot || process.cwd());
  const rel = relative(rootAbs, resolve(rootAbs, candidate));
  if (!rel) {
    return true;
  }
  // relative() returns an absolute path when the two sit on different
  // Windows drives.
  if (isAbsolute(rel) || win32.isAbsolute(rel)) {
    return false;
  }
  return rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\");
}

/**
 * Containment check for a path taken from a manifest that is about to be
 * looked up on disk. Whether a path exists must not be asked of the host for
 * an arbitrary path, as the answer can steer the BOM, so the lexical test of
 * {@link isPathInsideProject} comes first, and because a symlink in the tree
 * can lead out of it, the real paths are compared as well. Only a path that
 * exists inside the project passes; the lookup itself never leaves the tree.
 *
 * @param {string} candidate Path to check, absolute or relative to projectRoot
 * @param {string} projectRoot Project root the path must stay inside; a falsy
 *   root means the current working directory, mirroring `node:path`
 *
 * @returns {Boolean} True when the path exists and is inside projectRoot
 */
export function isExistingPathInsideProject(candidate, projectRoot) {
  if (!isPathInsideProject(candidate, projectRoot)) {
    return false;
  }
  const rootAbs = resolve(projectRoot || process.cwd());
  try {
    return isPathInsideProject(
      realpathSync(resolve(rootAbs, candidate)),
      realpathSync(rootAbs),
    );
  } catch (_err) {
    // Missing, unreadable, or refused by the permission model
    return false;
  }
}

/**
 * Containment check for a file that is about to be opened. It resolves
 * symbolic links on both sides before comparing, so a path below the root
 * that leads outside it through a link counts as outside, as does a path
 * that does not exist. Same test as {@link isExistingPathInsideProject}.
 *
 * @param {string} candidate Path to check, absolute or relative to projectRoot
 * @param {string} projectRoot Project root the resolved path must stay inside
 *
 * @returns {Boolean} True when the real path is inside the real projectRoot
 */
export function isRealPathInsideProject(candidate, projectRoot) {
  return isExistingPathInsideProject(candidate, projectRoot);
}

/**
 * Whether a path that is inside the project as written reaches outside it
 * through a symbolic link on disk. A path that is outside as written, or
 * that does not exist, gives false; callers test those with
 * {@link isPathInsideProject} first. Only paths inside the project are
 * resolved, so the answer never tells whether a host path exists.
 *
 * @param {string} candidate Path to check, absolute or relative to projectRoot
 * @param {string} projectRoot Project root the path is written against
 *
 * @returns {Boolean} True when the real path lies outside the real root
 */
export function isLinkedOutsideProject(candidate, projectRoot) {
  if (!isPathInsideProject(candidate, projectRoot)) {
    return false;
  }
  const rootAbs = resolve(projectRoot || process.cwd());
  let real;
  try {
    real = realpathSync(resolve(rootAbs, candidate));
  } catch (_err) {
    return false;
  }
  try {
    return !isPathInsideProject(real, realpathSync(rootAbs));
  } catch (_err) {
    return false;
  }
}
