import { basename, dirname, extname, resolve } from "node:path";
import process from "node:process";

const isWindows = process.platform === "win32";

// Memoize node_modules folder resolution to keep it fast
const memoNodeModules = new Map();

/**
 * Returns the path to the node_modules directory under which a package is installed.
 * Handles scoped packages correctly.
 *
 * @param {string} path Path to the package
 * @returns {string} Path to the parent node_modules directory
 */
function getNodeModules(path) {
  if (memoNodeModules.has(path)) {
    return memoNodeModules.get(path);
  }
  const scopeOrNm = dirname(path);
  const nm =
    basename(scopeOrNm) === "node_modules" ? scopeOrNm : dirname(scopeOrNm);
  memoNodeModules.set(path, nm);
  return nm;
}

/**
 * Resolves the parent prefix directory for the installed package.
 *
 * @param {string} path Path to the package
 * @returns {string} The prefix path
 */
function getPrefix(path) {
  return dirname(getNodeModules(path));
}

/**
 * Resolves the binary target installation directory.
 *
 * @param {Object} options
 * @param {boolean} options.top Is this a top-level package
 * @param {string} options.path Path to the package
 * @returns {string} Target binary folder path
 */
function binTarget({ top, path }) {
  if (!top) {
    return `${getNodeModules(path)}/.bin`;
  }
  if (isWindows) {
    return getPrefix(path);
  }
  return `${dirname(getPrefix(path))}/bin`;
}

/**
 * Resolves the manual page installation directory.
 *
 * @param {Object} options
 * @param {boolean} options.top Is this a top-level package
 * @param {string} options.path Path to the package
 * @returns {string | null} Target manual folder path or null
 */
function manTarget({ top, path }) {
  if (!top || isWindows) {
    return null;
  }
  return `${dirname(getPrefix(path))}/share/man`;
}

/**
 * Custom lightweight replacement for the bin-links getPaths function.
 * Calculates all possible symbolic links or shims that would be created.
 *
 * @param {Object} options Options object
 * @param {string} options.path Path to the package directory
 * @param {Object} options.pkg The parsed package.json object
 * @param {boolean} [options.global] Whether this is a global install
 * @param {boolean} [options.top] Whether this is the top-level package being installed
 * @returns {string[]} An array of potential link target file paths
 */
export default function getPaths({ path, pkg, global, top }) {
  if (top && !global) {
    return [];
  }

  const binSet = [];
  const binTarg = binTarget({ path, top });
  if (pkg.bin) {
    const binKeys =
      typeof pkg.bin === "string"
        ? [pkg.name ? basename(pkg.name) : basename(path)]
        : Object.keys(pkg.bin);

    for (const bin of binKeys) {
      const b = resolve(binTarg, bin);
      binSet.push(b);
      if (isWindows) {
        binSet.push(`${b}.cmd`);
        binSet.push(`${b}.ps1`);
      }
    }
  }

  const manTarg = manTarget({ path, top });
  const manSet = [];
  if (manTarg && pkg.man && Array.isArray(pkg.man) && pkg.man.length) {
    for (const man of pkg.man) {
      if (!/.\.[0-9]+(\.gz)?$/.test(man)) {
        return binSet;
      }

      const section = extname(basename(man, ".gz")).slice(1);
      const base = basename(man);

      manSet.push(resolve(manTarg, `man${section}`, base));
    }
  }

  return manSet.length ? [...binSet, ...manSet] : binSet;
}
