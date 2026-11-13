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
export declare function isPathInsideProject(candidate: string, projectRoot: string): boolean;
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
export declare function isExistingPathInsideProject(candidate: string, projectRoot: string): boolean;
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
export declare function isRealPathInsideProject(candidate: string, projectRoot: string): boolean;
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
export declare function isLinkedOutsideProject(candidate: string, projectRoot: string): boolean;
//# sourceMappingURL=lockPaths.d.ts.map