/**
 * Where a C/C++ project's build trees are: the build directories its CMake
 * presets configure, and the conventional ones (`build`, `build-<name>`,
 * `out`, `builddir`, `cmake-build-<name>`). Shared by the lookups for
 * `CMakeCache.txt` and for the compilation database, so both search the same
 * places in the same order.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { platform } from "node:os";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

import { isSecureMode, readEnvironmentVariable } from "../core/activity.js";
import {
  expandPresetMacros,
  parseCmakePresets,
  resolveConfigurePresets,
} from "../parsers/cmakePresets.js";

/** Presets files CMake reads from the source directory, in order. */
const PRESETS_FILES = ["CMakePresets.json", "CMakeUserPresets.json"];

/** A presets file larger than this is not read. */
const MAX_PRESETS_FILE_BYTES = 4 * 1024 * 1024;

/** At most this many presets files are read, includes counted. */
const MAX_PRESETS_FILES = 64;

/** At most this many build directories are proposed. */
const MAX_BUILD_DIRS = 128;

const HOST_SYSTEM_NAMES = {
  darwin: "Darwin",
  linux: "Linux",
  win32: "Windows",
  freebsd: "FreeBSD",
  openbsd: "OpenBSD",
  netbsd: "NetBSD",
  sunos: "SunOS",
  aix: "AIX",
};

/**
 * Whether `child` is `parent` or inside it.
 *
 * @param {string} child Path to test
 * @param {string} parent Directory
 * @returns {boolean}
 */
export function isInsideDir(child, parent) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isDirectory(p) {
  try {
    return statSync(p).isDirectory();
  } catch (_err) {
    return false;
  }
}

function readSmallFile(p) {
  try {
    const stat = statSync(p);
    if (!stat.isFile() || stat.size > MAX_PRESETS_FILE_BYTES) {
      return undefined;
    }
    return readFileSync(p, "utf-8");
  } catch (_err) {
    return undefined;
  }
}

/**
 * CMake's `${hostSystemName}` for this host.
 *
 * @returns {string}
 */
export function hostSystemName() {
  return HOST_SYSTEM_NAMES[platform()] || platform();
}

/**
 * Read a project's presets documents: `CMakePresets.json` and
 * `CMakeUserPresets.json`, each followed by the files it includes (schema
 * version 4 and later). In secure mode an include outside the project is not
 * read.
 *
 * @param {string} root Project source directory
 * @returns {Array<{file: string, fileDir: string, document: Object}>}
 */
export function readCmakePresetDocuments(root) {
  const sourceDir = resolve(root);
  const documents = [];
  const seen = new Set();
  const visit = (file) => {
    const abs = resolve(file);
    if (seen.has(abs) || seen.size >= MAX_PRESETS_FILES) {
      return;
    }
    seen.add(abs);
    if (isSecureMode && !isInsideDir(abs, sourceDir)) {
      return;
    }
    const document = parseCmakePresets(readSmallFile(abs));
    if (!document) {
      return;
    }
    const fileDir = dirname(abs);
    documents.push({ file: abs, fileDir, document });
    for (const include of document.include) {
      const expanded = expandPresetMacros(include, {
        sourceDir,
        sourceParentDir: dirname(sourceDir),
        sourceDirName: basename(sourceDir),
        fileDir,
        pathListSep: delimiter,
        hostSystemName: hostSystemName(),
        penv: readEnvironmentVariable,
      });
      visit(isAbsolute(expanded) ? expanded : join(fileDir, expanded));
    }
  };
  for (const name of PRESETS_FILES) {
    visit(join(sourceDir, name));
  }
  return documents;
}

/**
 * The visible configure presets of a project, resolved and with their macros
 * expanded for this host.
 *
 * @param {string} root Project source directory
 * @returns {Object[]} See `resolveConfigurePresets`
 */
export function readCmakeConfigurePresets(root) {
  const sourceDir = resolve(root);
  const documents = readCmakePresetDocuments(sourceDir);
  if (!documents.length) {
    return [];
  }
  return resolveConfigurePresets(documents, {
    sourceDir,
    sourceParentDir: dirname(sourceDir),
    sourceDirName: basename(sourceDir),
    hostSystemName: hostSystemName(),
    pathListSep: delimiter,
    penv: readEnvironmentVariable,
  });
}

function childDirs(dir, accept = () => true) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && accept(e.name))
      .map((e) => join(dir, e.name))
      .sort();
  } catch (_err) {
    return [];
  }
}

/** The order conventional build directories are searched in. */
function conventionalRank(dir) {
  const name = basename(dir);
  if (name === "build") {
    return 0;
  }
  if (name === "out") {
    return 2;
  }
  if (name === "builddir") {
    return 3;
  }
  if (name.startsWith("cmake-build-")) {
    return 4;
  }
  return 1;
}

/**
 * The directories a project's build trees may be in, most specific first:
 * the directory of an explicit `--cmake-cache`, the build directories of its
 * configure presets, then the `build`, `build-<name>`, `out`, `builddir` and
 * `cmake-build-<name>` directories at the project root, and the directories
 * one level below `build`, `out` and `out/build` (where Visual Studio puts
 * preset builds). Only existing directories are listed; in secure mode, only
 * those inside the project.
 *
 * @param {string} root Project source directory
 * @param {Object} [options] CLI options (`cmakeCache`)
 * @returns {string[]} Absolute directories, without duplicates
 */
export function cmakeBuildDirCandidates(root, options = {}) {
  const sourceDir = resolve(root);
  const dirs = [];
  const add = (d) => {
    if (!d || dirs.length >= MAX_BUILD_DIRS) {
      return;
    }
    const abs = resolve(d);
    if (dirs.includes(abs) || abs === sourceDir) {
      return;
    }
    if (isSecureMode && !isInsideDir(abs, sourceDir)) {
      return;
    }
    if (isDirectory(abs)) {
      dirs.push(abs);
    }
  };
  if (options.cmakeCache) {
    add(dirname(resolve(`${options.cmakeCache}`)));
  }
  if (!isDirectory(sourceDir)) {
    return dirs;
  }
  for (const preset of readCmakeConfigurePresets(sourceDir)) {
    add(preset.binaryDir);
  }
  const rootBuildDirs = childDirs(
    sourceDir,
    (name) =>
      name.startsWith("build") ||
      name === "out" ||
      name.startsWith("cmake-build-"),
  );
  rootBuildDirs.sort(
    (a, b) => conventionalRank(a) - conventionalRank(b) || a.localeCompare(b),
  );
  for (const d of rootBuildDirs) {
    add(d);
  }
  for (const parent of [
    join(sourceDir, "build"),
    join(sourceDir, "out"),
    join(sourceDir, "out", "build"),
  ]) {
    for (const d of childDirs(parent)) {
      add(d);
    }
  }
  return dirs;
}
