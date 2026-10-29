import { isAbsolute, relative, resolve, win32 } from "node:path";

// Windows drive-letter prefix such as `C:` or `c:`. A single anchored check on
// one token rather than a parsing regex: everything after the colon is left to
// the path module.
const WIN_DRIVE_PREFIX = /^[a-zA-Z]:/;

/**
 * Validator for path-valued fields of npm lockfiles (`resolved` of `link:`
 * entries, `file:` and `link:` specifiers). A crafted lockfile can turn these
 * into absolute paths, Windows drive paths, or `..` chains that escape the
 * project, so every value that is about to be joined with the project root,
 * resolved as a specifier, or emitted as a link target must pass this check
 * first (issue #3816).
 *
 * A value is safe when it is a non-empty string without NUL bytes, is relative
 * on both POSIX and Windows (no leading `/`, `\`, or drive letter), and stays
 * inside `rootDir` once normalised against it. Registry URLs and other
 * scheme-bearing values are not paths and never reach this function; callers
 * strip the `file:`/`link:` scheme before calling.
 *
 * Lives in `lib/core` (layer 0) because both the vendored arborist tree and
 * the layer-3/5 lockfile readers need the identical rule; `lib/core` is the
 * lowest layer every one of them may import.
 *
 * @param {string} candidate Path value from a lockfile, scheme already stripped
 * @param {string} rootDir Project root the value must stay inside; a falsy
 *   root means the current working directory, mirroring `node:path`
 *
 * @returns {Boolean} True when the value is a safe relative path inside rootDir
 */
export function isSafeLockfilePath(candidate, rootDir) {
  if (typeof candidate !== "string" || !candidate) {
    return false;
  }
  if (candidate.includes("\0")) {
    return false;
  }
  // Check both grammars regardless of the host platform: a lockfile parsed on
  // Linux may still carry a Windows-style escape.
  if (isAbsolute(candidate) || win32.isAbsolute(candidate)) {
    return false;
  }
  if (WIN_DRIVE_PREFIX.test(candidate)) {
    return false;
  }
  const rootAbs = resolve(rootDir || process.cwd());
  const rel = relative(rootAbs, resolve(rootAbs, candidate));
  // Strictly inside: a value that normalises back to the root itself is
  // degenerate, and anything the platform reads as a parent walk or an
  // absolute escape is rejected. A name that merely starts with dots (for
  // example "...foo") stays allowed.
  if (!rel || isAbsolute(rel) || win32.isAbsolute(rel)) {
    return false;
  }
  return rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\");
}

/**
 * Containment check for an already-absolute candidate path, used where the
 * lockfile value's base directory is ambiguous: `file:` and `link:`
 * specifiers are written relative to the consuming package, but older or
 * hand-written lockfiles use the project root. The caller resolves the value
 * against each plausible base and accepts it when any interpretation lands
 * inside `projectRoot`; this helper checks one such interpretation.
 *
 * @param {string} candidateAbs Absolute candidate path to check
 * @param {string} projectRoot Project root the result must stay inside
 *
 * @returns {Boolean} True when the candidate is inside projectRoot
 */
export function isPathInsideProject(candidateAbs, projectRoot) {
  if (typeof candidateAbs !== "string" || !candidateAbs) {
    return false;
  }
  if (candidateAbs.includes("\0")) {
    return false;
  }
  const rootAbs = resolve(projectRoot || process.cwd());
  const candidateResolved = resolve(candidateAbs);
  const rel = relative(rootAbs, candidateResolved);
  if (!rel || isAbsolute(rel) || win32.isAbsolute(rel)) {
    return false;
  }
  return rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\");
}
