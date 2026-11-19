import { lstatSync, realpathSync, statSync } from "node:fs";

// The file a path leads to: its device and inode, which symbolic and hard
// links to one file share, or its real path where the platform gives none.
function fileIdentity(filePath) {
  try {
    const stats = statSync(filePath, { bigint: true });
    if (stats.dev && stats.ino) {
      return `${stats.dev}:${stats.ino}`;
    }
    return realpathSync(filePath);
  } catch (_err) {
    // A file that cannot be read is known by its path.
    return filePath;
  }
}

function isSymbolicLink(filePath) {
  try {
    return lstatSync(filePath).isSymbolicLink();
  } catch (_err) {
    return false;
  }
}

/**
 * Keep one path for every file among the matched paths.
 *
 * The scanned tree can hold any number of symbolic and hard links to one file,
 * each under a name the discovery patterns match. Reading once per path would
 * let the number of links multiply the work and the size of the BOM, so each
 * file is read once. A path that is not a symbolic link is preferred, so that
 * the result is recorded under the name of the file itself.
 *
 * @param {string[]} files Matched file paths
 * @returns {string[]} One path per file, in the order the files were first seen
 */
export function uniqueFiles(files) {
  const pathsByFile = new Map();
  for (const f of files || []) {
    const identity = fileIdentity(f);
    const known = pathsByFile.get(identity);
    if (known === undefined || (isSymbolicLink(known) && !isSymbolicLink(f))) {
      pathsByFile.set(identity, f);
    }
  }
  return [...pathsByFile.values()];
}
