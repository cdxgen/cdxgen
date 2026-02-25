import { lstatSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { globSync } from "glob";

import { safeExistsSync } from "../helpers/utils.js";

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

function getDirectories(srcpath) {
  if (safeExistsSync(srcpath)) {
    return readdirSync(srcpath)
      .map((file) => join(srcpath, file))
      .filter((path) => {
        try {
          return statSync(path).isDirectory();
        } catch (_e) {
          return false;
        }
      });
  }
  return [];
}

export const getOnlyDirs = (srcpath, dirName) => {
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
