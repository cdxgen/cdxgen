// Bounded, read-only probe for the PHP no package manager owns on a live host,
// for `-t os` / obom. osquery's package tables list what dpkg, rpm and the like
// installed, so a PHP built from source (a Docker Official image, FrankenPHP, a
// /usr/local or /opt build) is invisible to them, and with it the version a PHP
// advisory is read against.
//
// Candidates come from a few fixed directories, one level deep, never from a
// walk of the file system. A candidate is opened only after the package
// databases have said they do not own it: a package manager's file is
// identified by its package, and distros backport fixes under old PHP version
// numbers, which the cdx:php properties would misstate. Only files nothing owns
// are read, for their bytes; nothing is executed.
//
// A package database that exists but cannot be read leaves ownership unknown.
// Unknown is not unpackaged: it emits nothing and records a degradation.

import { dirname, join } from "node:path";

import {
  isDryRun,
  readEnvironmentVariable,
  recordActivity,
} from "../core/activity.js";
import { recordDegradation } from "../core/buildLedger.js";
import {
  isDirectory,
  listDirectory,
  probeHostRuntime,
} from "./hostRuntimeProbe.js";
import {
  attachPhpBuild,
  classifyPhpSapi,
  createPhpRuntimeInventory,
  MAX_PHP_PROBES,
  readPhpBuildVersion,
} from "./phpBuildInfo.js";

// Where the PHP of a source build is installed, relative to the root. `only`
// narrows a directory to one SAPI. `opt/*/bin` and `opt/*/sbin` read /opt one
// level down and nothing below that.
const POSIX_DIRECTORIES = {
  linux: [
    { dir: "usr/local/bin" },
    { dir: "usr/local/sbin" },
    { dir: "usr/local/lib", only: "libphp" },
    { dir: "usr/lib/apache2/modules", only: "libphp" },
    { dir: "usr/lib/httpd/modules", only: "libphp" },
    { dir: "usr/lib64/httpd/modules", only: "libphp" },
    { dir: "opt/*/bin" },
    { dir: "opt/*/sbin" },
  ],
  darwin: [
    { dir: "usr/local/bin" },
    { dir: "usr/local/sbin" },
    { dir: "opt/homebrew/bin" },
    { dir: "opt/homebrew/sbin" },
  ],
};

// The programs of a php.net Windows build. The CGI and debugger executables
// hold no version of their own; the core DLL beside them does (php8.dll, or
// php8ts.dll for a thread-safe build).
const WINDOWS_SAPIS = {
  "php.exe": "cli",
  "php-win.exe": "cli",
  "php-cgi.exe": "cgi",
  "phpdbg.exe": "phpdbg",
};

function isWindowsCoreLibrary(name) {
  const lower = name.toLowerCase();
  if (!lower.startsWith("php") || !lower.endsWith(".dll")) {
    return false;
  }
  const stem = lower.slice("php".length, -".dll".length);
  return /^\d+$/.test(stem.endsWith("ts") ? stem.slice(0, -2) : stem);
}

// The directories to look in, as absolute paths.
function candidateDirectories(context) {
  const { rootPath, platform } = context;
  const directories = [];
  if (platform === "win32") {
    const programFiles =
      context.readEnv("ProgramFiles") || join(rootPath, "Program Files");
    for (const parent of [rootPath, join(rootPath, "tools"), programFiles]) {
      for (const name of listDirectory(parent)) {
        const directory = join(parent, name);
        if (name.toLowerCase().startsWith("php") && isDirectory(directory)) {
          directories.push({ directory });
        }
      }
    }
    return directories;
  }
  for (const { dir, only } of POSIX_DIRECTORIES[platform] || []) {
    if (!dir.startsWith("opt/*/")) {
      directories.push({ directory: join(rootPath, dir), only });
      continue;
    }
    const leaf = dir.slice("opt/*/".length);
    for (const name of listDirectory(join(rootPath, "opt"))) {
      const directory = join(rootPath, "opt", name, leaf);
      if (isDirectory(directory)) {
        directories.push({ directory, only });
      }
    }
  }
  return directories;
}

// On Windows the CGI and debugger executables hold no version; the core DLL in
// the same directory does.
function readBuild(context, candidate) {
  const build = readPhpBuildVersion(candidate.real, context.realRoot);
  if (build || context.platform !== "win32") {
    return build;
  }
  const directory = dirname(candidate.real);
  for (const name of listDirectory(directory)) {
    if (isWindowsCoreLibrary(name)) {
      const fromLibrary = readPhpBuildVersion(
        join(directory, name),
        context.realRoot,
      );
      if (fromLibrary) {
        return fromLibrary;
      }
    }
  }
  return undefined;
}

/**
 * Look for PHP no package manager owns, in the fixed directories of the host.
 * Components come back only for the files nothing owns: a `file` component for
 * each PHP binary or library with the cdx:php properties, one `platform`
 * component per version with its CPE, and the edges between them.
 *
 * @param {Object} [options] probe options
 * @param {string} [options.rootPath] directory the fixed directories hang off:
 *   `/`, or the system drive on Windows. Tests point it at a built tree.
 * @param {string} [options.platform] `linux`, `darwin` or `win32`
 * @param {Object} [options.env] environment read for ProgramFiles, SystemDrive
 *   and ChocolateyInstall, instead of the process's
 * @param {{dpkgInfoDirectory?: string, apkInstalledFile?: string, rpmDatabaseDirectories?: string[]}} [options.packageDatabases]
 *   where the package databases are, instead of under `rootPath`
 * @param {function(string): (Object[]|undefined)} [options.executeOsQuery] runs
 *   an osquery query; the rpm database is only asked through it
 * @param {Object[]} [options.packageComponents] the packages the OS scan has
 *   inventoried, from which Chocolatey's are known
 * @param {number} [options.maxProbes] most candidate files to look at
 * @returns {{components: Object[], dependencies: Object[]}}
 */
export function probeHostPhp(options = {}) {
  return probeHostRuntime(options, {
    label: "PHP",
    ecosystem: "php",
    capability: "php-host-probe",
    remediationId: "php.host-probe.package-db-unreadable",
    maxProbes: MAX_PHP_PROBES,
    chocolateyPackages: ["php"],
    directories: candidateDirectories,
    classify: (name, platform) =>
      platform === "win32"
        ? WINDOWS_SAPIS[name.toLowerCase()]
        : classifyPhpSapi(name),
    readBuild,
    createInventory: createPhpRuntimeInventory,
    attach: (inventory, component, build, candidate) =>
      attachPhpBuild(inventory, component, build, candidate.kind),
    finish: (inventory) => ({
      components: inventory.runtimeComponents,
      dependencies: inventory.dependencies,
    }),
    hooks: {
      isDryRun,
      readEnvironmentVariable,
      recordActivity,
      recordDegradation,
    },
  });
}
