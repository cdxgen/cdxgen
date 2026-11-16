// Bounded, read-only probe for the Go toolchains no package manager owns on a
// live host, for `-t os` / obom. osquery's package tables list what dpkg, rpm
// and the like installed, so a toolchain unpacked from the official tarball
// (/usr/local/go), installed by Homebrew, or downloaded by golang.org/dl into
// the sdk tree of a home directory is invisible to them, and with it the
// version a Go advisory is read against (issue #4849).
//
// Candidates come from a few fixed bin directories and, for the homes, one
// wildcard level at a time, never from a walk of the file system. A candidate
// is opened only after the package databases have said they do not own it: a
// toolchain an OS package owns, such as the golang deb or rpm installs, is
// identified by that package, and distros backport fixes under old version
// numbers. The version comes from the VERSION file of the GOROOT the
// candidate hangs off; nothing is executed.
//
// A package database that exists but cannot be read leaves ownership unknown.
// Unknown is not unpackaged: it emits nothing and records a degradation.

import { join } from "node:path";

import {
  isDryRun,
  readEnvironmentVariable,
  recordActivity,
} from "../core/activity.js";
import { recordDegradation } from "../core/buildLedger.js";
import {
  attachGoToolchain,
  createGoToolchainInventory,
  goBinaryName,
  MAX_GO_PROBES,
  readGoToolchainVersion,
} from "./goToolchain.js";
import {
  isDirectory,
  listDirectory,
  probeHostRuntime,
  rootPatternConfine,
} from "./hostRuntimeProbe.js";
import { expandDirectories, homeDirectories } from "./rubyHostProbe.js";

// The bin directories a Go toolchain hangs its launcher in, relative to the
// root. The tarball unpacks to usr/local/go, Alpine and Gentoo install to
// usr/lib/go, Fedora to usr/lib/golang, Debian names each minor version
// usr/lib/go-1.x (read through the one-wildcard usr/lib/*/bin, which the
// classify step filters), and a tarball unpacked under /opt keeps the same
// shape.
const POSIX_DIRECTORIES = {
  linux: [
    "usr/local/go/bin",
    "usr/lib/go/bin",
    "usr/lib/golang/bin",
    "usr/lib/*/bin",
    "opt/*/bin",
    "home/linuxbrew/.linuxbrew/opt/go/libexec/bin",
  ],
  darwin: [
    "usr/local/go/bin",
    "opt/*/bin",
    "opt/homebrew/opt/go/libexec/bin",
    "opt/homebrew/Cellar/go/*/libexec/bin",
    "usr/local/opt/go/libexec/bin",
  ],
};

// The bin directory golang.org/dl creates inside a home, one sdk tree per
// downloaded toolchain, read through the one-wildcard sdk/*/bin.
const GO_SDK_DIRECTORIES = ["sdk/*/bin"];

// The roots a Windows toolchain hangs its launcher in: the MSI's Program
// Files install, the zip unpacked to the drive root, and the hosted
// toolcache of a GitHub runner.
const WINDOWS_DIRECTORIES = [
  "Program Files/Go/bin",
  "Go/bin",
  "hostedtoolcache/windows/go/*/*/bin",
];

function sdkDirectories(context) {
  const directories = [];
  // No scan follows a symbolic link a user left in their home: it would
  // resolve with the scan's rights.
  for (const home of homeDirectories(context)) {
    for (const pattern of GO_SDK_DIRECTORIES) {
      for (const directory of expandDirectories(home, pattern, false)) {
        directories.push({ directory, within: home });
      }
    }
  }
  return directories;
}

function posixCandidateDirectories(context) {
  const { rootPath, platform } = context;
  const directories = [];
  for (const pattern of POSIX_DIRECTORIES[platform] || []) {
    const confine = rootPatternConfine(rootPath, pattern);
    for (const directory of expandDirectories(rootPath, pattern)) {
      directories.push(confine ? { directory, confine } : { directory });
    }
  }
  return directories.concat(sdkDirectories(context));
}

function windowsCandidateDirectories(context) {
  const { rootPath, readEnv } = context;
  const directories = [];
  const programFiles =
    readEnv("ProgramFiles") || join(rootPath, "Program Files");
  for (const parent of [rootPath, programFiles]) {
    for (const name of listDirectory(parent)) {
      const directory = join(parent, name, "bin");
      if (name.toLowerCase() === "go" && isDirectory(directory)) {
        directories.push({ directory });
      }
    }
  }
  for (const pattern of WINDOWS_DIRECTORIES) {
    for (const directory of expandDirectories(rootPath, pattern)) {
      directories.push({ directory });
    }
  }
  return directories.concat(sdkDirectories(context));
}

/**
 * Look for Go toolchains no package manager owns on the host. Components come
 * back only for the files nothing owns: a `file` component for each `go`
 * launcher with the cdx:go properties, and one `platform` component per
 * toolchain version with its CPE.
 *
 * @param {Object} [options] probe options, as probeHostPhp takes them
 * @returns {{components: Object[], dependencies: Object[]}}
 */
export function probeHostGo(options = {}) {
  return probeHostRuntime(options, {
    label: "Go",
    ecosystem: "go",
    capability: "go-host-probe",
    remediationId: "go.host-probe.package-db-unreadable",
    budget: { remediationId: "go.host-probe.budget-exhausted" },
    maxProbes: MAX_GO_PROBES,
    chocolateyPackages: ["go"],
    directories: (context) =>
      context.platform === "win32"
        ? windowsCandidateDirectories(context)
        : posixCandidateDirectories(context),
    classify: (name, platform) =>
      name === goBinaryName(platform) ? "go" : undefined,
    readBuild: (context, candidate) => {
      // The launcher sits in <GOROOT>/bin, the VERSION file one level above
      // it; a directory without one is not a GOROOT and answers nothing.
      const goRoot = candidate.real.split(/[\\/]/).slice(0, -2).join("/");
      return readGoToolchainVersion(goRoot, context.realRoot);
    },
    createInventory: createGoToolchainInventory,
    attach: (inventory, component, build) =>
      attachGoToolchain(inventory, component, build),
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
