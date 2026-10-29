// Bounded, read-only probe for the Ruby no package manager owns on a live host,
// for `-t os` / obom. osquery's package tables list what dpkg, rpm and the like
// installed, so a Ruby built by ruby-build, rbenv, rvm, asdf, mise, chruby or
// frum, unpacked from a toolcache tarball, or installed under /usr/local or
// /opt is invisible to them, and with it the version an advisory in the
// interpreter core is read against.
//
// Candidates come from fixed directories and from each version manager's tree
// under the home directories, one wildcard level at a time, never from a walk
// of the file system. The ownership rules, caps and degradations are the
// shared host-runtime probe's. Only rbconfig.rb and the interpreter's own
// files are read; nothing is executed.

import { join } from "node:path";

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
  attachRubyBuild,
  createRubyRuntimeInventory,
  isRubyBinaryName,
  MAX_RUBY_PROBES,
  readRubyBuildVersion,
} from "./rubyBuildInfo.js";

// The most directories one wildcard pattern may expand to.
const MAX_EXPANDED_DIRECTORIES = 256;

// Relative to the root.
const POSIX_DIRECTORIES = {
  linux: [
    "usr/local/bin",
    "opt/*/bin",
    "opt/rubies/*/bin",
    "opt/hostedtoolcache/Ruby/*/*/bin",
    "usr/local/rbenv/versions/*/bin",
    "usr/local/rvm/rubies/*/bin",
  ],
  darwin: [
    "usr/local/bin",
    "opt/*/bin",
    "opt/rubies/*/bin",
    "Users/runner/hostedtoolcache/Ruby/*/*/bin",
  ],
};

// Relative to a home directory.
export const RUBY_VERSION_MANAGER_DIRECTORIES = [
  ".rbenv/versions/*/bin",
  ".rvm/rubies/*/bin",
  ".asdf/installs/ruby/*/bin",
  ".local/share/mise/installs/ruby/*/bin",
  ".rubies/*/bin",
  ".frum/versions/*/bin",
  ".local/share/rv/rubies/*/bin",
];

export const HOME_PARENTS = {
  linux: ["home"],
  darwin: ["Users"],
};

/**
 * Expand a relative directory pattern whose `*` segments match one directory
 * name each.
 *
 * @param {string} base absolute directory the pattern hangs off
 * @param {string} pattern `/`-separated relative pattern
 * @returns {string[]} existing directories, at most MAX_EXPANDED_DIRECTORIES
 */
export function expandDirectories(base, pattern) {
  let current = [base];
  for (const segment of pattern.split("/")) {
    const next = [];
    for (const directory of current) {
      if (segment !== "*") {
        next.push(join(directory, segment));
        continue;
      }
      for (const name of listDirectory(directory)) {
        const child = join(directory, name);
        if (isDirectory(child)) {
          next.push(child);
        }
        if (next.length >= MAX_EXPANDED_DIRECTORIES) {
          break;
        }
      }
    }
    current = next.slice(0, MAX_EXPANDED_DIRECTORIES);
  }
  return current.filter(isDirectory);
}

/**
 * The home directories of a host: /root and /home/* on Linux, /Users/* on
 * macOS.
 *
 * @param {{rootPath: string, platform: string}} context probe context
 * @returns {string[]}
 */
export function homeDirectories(context) {
  const { rootPath, platform } = context;
  const homes = [];
  if (platform === "linux") {
    homes.push(join(rootPath, "root"));
  }
  for (const parent of HOME_PARENTS[platform] || []) {
    for (const name of listDirectory(join(rootPath, parent))) {
      const home = join(rootPath, parent, name);
      if (isDirectory(home)) {
        homes.push(home);
      }
    }
  }
  return homes.slice(0, MAX_EXPANDED_DIRECTORIES);
}

/**
 * The directories a Windows Ruby lives in: the RubyInstaller's C:\Ruby34-x64,
 * Chocolatey's C:\tools\ruby34, and the hosted toolcache.
 *
 * @param {Object} context probe context
 * @returns {string[]} install roots, each with a `bin` directory
 */
export function windowsRubyRoots(context) {
  const { rootPath } = context;
  const roots = [];
  for (const parent of [rootPath, join(rootPath, "tools")]) {
    for (const name of listDirectory(parent)) {
      const directory = join(parent, name);
      if (name.toLowerCase().startsWith("ruby") && isDirectory(directory)) {
        roots.push(directory);
      }
    }
  }
  roots.push(
    ...expandDirectories(rootPath, "hostedtoolcache/windows/Ruby/*/*"),
  );
  return roots.slice(0, MAX_EXPANDED_DIRECTORIES);
}

function candidateDirectories(context) {
  const { rootPath, platform } = context;
  const directories = [];
  if (platform === "win32") {
    for (const root of windowsRubyRoots(context)) {
      directories.push({ directory: join(root, "bin") });
    }
    return directories;
  }
  for (const pattern of POSIX_DIRECTORIES[platform] || []) {
    for (const directory of expandDirectories(rootPath, pattern)) {
      directories.push({ directory });
    }
  }
  for (const home of homeDirectories(context)) {
    for (const pattern of RUBY_VERSION_MANAGER_DIRECTORIES) {
      for (const directory of expandDirectories(home, pattern)) {
        directories.push({ directory });
      }
    }
  }
  return directories;
}

/**
 * Look for Ruby no package manager owns on the host. Components come back
 * only for the files nothing owns: a `file` component for each `ruby` binary
 * with the cdx:ruby properties, and one `platform` component per Ruby version
 * with its CPE.
 *
 * @param {Object} [options] probe options, as probeHostPhp takes them
 * @returns {{components: Object[], dependencies: Object[]}}
 */
export function probeHostRuby(options = {}) {
  return probeHostRuntime(options, {
    label: "Ruby",
    ecosystem: "ruby",
    capability: "ruby-host-probe",
    remediationId: "ruby.host-probe.package-db-unreadable",
    maxProbes: MAX_RUBY_PROBES,
    chocolateyPackages: ["ruby"],
    // Chocolatey's ruby package runs the RubyInstaller into C:\tools.
    chocolateyDirectories: (context) => [join(context.rootPath, "tools")],
    directories: candidateDirectories,
    classify: (name, platform) => {
      if (platform === "win32") {
        return name.toLowerCase() === "ruby.exe" ? "ruby" : undefined;
      }
      return isRubyBinaryName(name) ? "ruby" : undefined;
    },
    readBuild: (context, candidate) =>
      readRubyBuildVersion(candidate.real, context.realRoot),
    createInventory: createRubyRuntimeInventory,
    attach: (inventory, component, build) =>
      attachRubyBuild(inventory, component, build),
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
