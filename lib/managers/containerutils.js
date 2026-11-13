import { lstatSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { globSync } from "glob";

import { safeExistsSync } from "../core/fs.js";

/**
 * Method to get all dirs matching a name
 *
 * @param {string} dirPath Root directory for search
 * @param {string} dirName Directory name
 * @param {boolean} hidden Include hidden directories and files. Default: false
 * @param {boolean} recurse Recurse. Default: false
 */
export const getDirs = (dirPath, dirName, hidden = false, recurse = true) => {
  try {
    return globSync(`${recurse ? "**" : ""}${dirName}`, {
      cwd: dirPath,
      absolute: true,
      nocase: true,
      nodir: false,
      follow: false,
      dot: hidden,
    });
  } catch (_err) {
    return [];
  }
};

function flatten(lists) {
  return lists.reduce((a, b) => a.concat(b), []);
}

/**
 * Immediate subdirectories of a given path. Directories that cannot be read,
 * such as those owned by another user, are treated as empty.
 *
 * @param {string} srcpath Directory to list
 * @returns {string[]} Absolute paths of the subdirectories
 */
function getDirectories(srcpath) {
  if (!safeExistsSync(srcpath)) {
    return [];
  }
  let entries;
  try {
    entries = readdirSync(srcpath);
  } catch (_e) {
    return [];
  }
  return entries
    .map((file) => join(srcpath, file))
    .filter((path) => {
      try {
        return statSync(path).isDirectory();
      } catch (_e) {
        return false;
      }
    });
}

/**
 * Recursively walk `srcpath` and return all subdirectory paths whose basename
 * matches `dirName` (the root path is included when it matches). The walk does
 * not descend into a match: every returned directory is scanned recursively,
 * so a match nested inside another one would only repeat that scan.
 *
 * @param {string} srcpath Root directory to start the walk from.
 * @param {string} dirName Basename that a directory must end with to be kept.
 * @returns {string[]} Matching directory paths.
 */
export const getOnlyDirs = (srcpath, dirName) => {
  if (srcpath.endsWith(dirName)) {
    return [srcpath];
  }
  return [
    srcpath,
    ...flatten(
      getDirectories(srcpath)
        .map((p) => {
          try {
            if (safeExistsSync(p) && lstatSync(p).isDirectory()) {
              return getOnlyDirs(p, dirName);
            }
            return [];
          } catch (_err) {
            return [];
          }
        })
        .filter((p) => p !== undefined),
    ),
  ].filter((d) => d.endsWith(dirName));
};

/**
 * Walk a directory tree once and collect all subdirectories whose basename
 * matches any of the target names. Returns a map from name to array of paths.
 * A directory that lies inside a match of the same name is not collected:
 * every returned directory is scanned recursively, so a nested match would
 * only repeat that scan.
 *
 * Replaces multiple {@link getOnlyDirs} calls that each walk the same tree.
 *
 * @param {string} srcpath Root directory for search
 * @param {string[]} dirNames Target directory names to collect
 * @returns {Record<string, string[]>} Map of dirName to matching paths
 */
export const getOnlyDirsMulti = (srcpath, dirNames) => {
  const result = {};
  for (const name of dirNames) {
    result[name] = [];
  }
  const nameSet = new Set(dirNames);
  // matchedAbove: names already matched by an ancestor of dirPath
  const walk = (dirPath, matchedAbove) => {
    const entries = getDirectories(dirPath);
    for (const entry of entries) {
      const base = basename(entry);
      if (nameSet.has(base) && !matchedAbove.includes(base)) {
        result[base].push(entry);
        walk(entry, [...matchedAbove, base]);
      } else {
        walk(entry, matchedAbove);
      }
    }
  };
  if (safeExistsSync(srcpath)) {
    const srcBase = basename(srcpath);
    if (nameSet.has(srcBase)) {
      result[srcBase].push(srcpath);
      walk(srcpath, [srcBase]);
    } else {
      walk(srcpath, []);
    }
  }
  return result;
};
