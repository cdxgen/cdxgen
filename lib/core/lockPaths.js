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
