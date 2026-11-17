// Bounded, read-only probe for the JDKs no package manager owns on a live
// host, for `-t os` / obom. osquery's package tables list what dpkg, rpm,
// Homebrew, Chocolatey and the like installed, so a JDK that sdkman,
// IntelliJ, asdf, the Oracle or Temurin macOS installers, or a tarball
// unpacked under /opt left on disk is invisible to them. All that shows of
// it is the listening-port row of a running java, with the version 0
// (issue #4862).
//
// Candidates come from a few fixed bin directories and, for the homes, one
// wildcard level at a time, never from a walk of the file system. A candidate
// is opened only after the package databases have said they do not own it: a
// JDK an OS package owns is identified by that package, and distros backport
// fixes under old version numbers. The identity comes from the `release` file
// of the home the launcher hangs off; nothing is executed. Like the Ruby, PHP
// and Go probes, the Windows probe reads no home directory.
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
  isDirectory,
  listDirectory,
  probeHostRuntime,
  rootPatternConfine,
} from "./hostRuntimeProbe.js";
import {
  attachJdk,
  classifyJavaBinary,
  createJdkInventory,
  MAX_JDK_PROBES,
  readJdkIdentity,
} from "./jdkIdentity.js";
import { expandDirectories, homeDirectories } from "./rubyHostProbe.js";

// The bin directories a JDK hangs its launcher in, relative to the root.
const POSIX_DIRECTORIES = {
  linux: [
    "usr/lib/jvm/*/bin",
    "usr/java/*/bin",
    "opt/*/bin",
    "opt/java/*/bin",
    "opt/jvm/*/bin",
    "usr/local/*/bin",
    "opt/.sdkman/candidates/java/*/bin",
    "opt/sdkman/candidates/java/*/bin",
    "usr/local/sdkman/candidates/java/*/bin",
    "home/linuxbrew/.linuxbrew/opt/openjdk*/libexec/bin",
  ],
  darwin: [
    "Library/Java/JavaVirtualMachines/*/Contents/Home/bin",
    "opt/*/bin",
    "usr/local/*/bin",
    "opt/.sdkman/candidates/java/*/bin",
  ],
};

// Relative to a home directory. IntelliJ downloads to .jdks, sdkman to
// .sdkman, asdf and mise under their own trees; the user-level
// JavaVirtualMachines directory is where a per-user macOS installer puts one.
const HOME_DIRECTORIES = [
  ".sdkman/candidates/java/*/bin",
  ".jdks/*/bin",
  ".asdf/installs/java/*/bin",
  ".local/share/mise/installs/java/*/bin",
  ".gradle/jdks/*/bin",
  "Library/Java/JavaVirtualMachines/*/Contents/Home/bin",
];

// Where the Windows installers of the vendors unpack: one directory per
// vendor in Program Files, one per release inside it.
const WINDOWS_VENDOR_FOLDERS = [
  "Eclipse Adoptium",
  "Java",
  "Microsoft",
  "Amazon Corretto",
  "Zulu",
  "BellSoft",
  "Semeru",
  "AdoptOpenJDK",
];

// The Chocolatey packages that put a JDK in Program Files.
const CHOCOLATEY_JDK_PACKAGES = [
  "temurin",
  "temurin8",
  "temurin11",
  "temurin17",
  "temurin21",
  "temurin25",
  "openjdk",
  "microsoft-openjdk",
  "corretto",
  "corretto8",
  "corretto11",
  "corretto17",
  "corretto21",
  "zulu",
  "liberica",
];

function homeJdkDirectories(context) {
  const directories = [];
  // No scan follows a symbolic link a user left in their home: it would
  // resolve with the scan's rights.
  for (const home of homeDirectories(context)) {
    for (const pattern of HOME_DIRECTORIES) {
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
  return directories.concat(homeJdkDirectories(context));
}

function windowsCandidateDirectories(context) {
  const { rootPath, readEnv } = context;
  const programFiles =
    readEnv("ProgramFiles") || join(rootPath, "Program Files");
  const directories = [];
  for (const parent of [rootPath, programFiles]) {
    for (const vendor of listDirectory(parent)) {
      if (
        !WINDOWS_VENDOR_FOLDERS.some(
          (folder) => folder.toLowerCase() === vendor.toLowerCase(),
        )
      ) {
        continue;
      }
      for (const release of listDirectory(join(parent, vendor))) {
        const directory = join(parent, vendor, release, "bin");
        if (isDirectory(directory)) {
          directories.push({ directory });
        }
      }
    }
  }
  return directories;
}

// The launcher sits in <home>/bin, or <home>/jre/bin of a Java 8 JDK.
function homeOfLauncher(real) {
  const parts = real.split(/[\\/]/).slice(0, -2);
  if (parts[parts.length - 1] === "jre") {
    parts.pop();
  }
  return parts.join("/");
}

// The home a launcher's logical path names, written as the host writes it.
function homeOfLogical(logical) {
  const parts = `${logical}`.split(/[\\/]/);
  parts.splice(-2);
  if (parts[parts.length - 1] === "jre") {
    parts.pop();
  }
  const separator = logical.includes("\\") ? "\\" : "/";
  return parts.join(separator);
}

/**
 * Look for JDKs no package manager owns on the host. Components come back
 * only for the files nothing owns: a `file` component for each `java`
 * launcher with the cdx:java properties, and one `platform` component per JDK
 * identity with its CPE.
 *
 * @param {Object} [options] probe options, as probeHostPhp takes them
 * @returns {{components: Object[], dependencies: Object[]}}
 */
export function probeHostJdk(options = {}) {
  return probeHostRuntime(options, {
    label: "JDK",
    ecosystem: "java",
    capability: "jdk-host-probe",
    remediationId: "java.host-probe.package-db-unreadable",
    budget: { remediationId: "java.host-probe.budget-exhausted" },
    maxProbes: MAX_JDK_PROBES,
    chocolateyPackages: CHOCOLATEY_JDK_PACKAGES,
    directories: (context) =>
      context.platform === "win32"
        ? windowsCandidateDirectories(context)
        : posixCandidateDirectories(context),
    classify: (name, platform) => classifyJavaBinary(name, platform),
    readBuild: (context, candidate) =>
      readJdkIdentity(homeOfLauncher(candidate.real), context.realRoot),
    createInventory: createJdkInventory,
    attach: (inventory, component, build, candidate) =>
      attachJdk(inventory, component, build, homeOfLogical(candidate.logical)),
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

function propertyOf(component, name) {
  return component?.properties?.find((property) => property.name === name)
    ?.value;
}

/**
 * Give the listening-port and process rows of a java launcher the version of
 * the JDK the probe found at that path. osquery reports such a row with the
 * version 0, a placeholder; the row's purl and bom-ref carry it too, so they
 * are rewritten, and the row gains the JDK's vendor. An OBOM has no
 * dependency graph, so no edge is added. A row whose path the probe did not
 * see keeps what it had.
 *
 * @param {Object[]} components the OS scan's components, changed in place
 * @param {Object[]} jdkComponents the platform components of probeHostJdk
 * @returns {number} how many rows were changed
 */
export function linkJdkProcessRows(components, jdkComponents) {
  const homes = [];
  for (const jdk of jdkComponents || []) {
    for (const property of jdk.properties || []) {
      if (property.name === "cdx:java:home") {
        homes.push({ home: property.value, jdk });
      }
    }
  }
  if (!homes.length) {
    return 0;
  }
  let changed = 0;
  for (const component of components || []) {
    const category = propertyOf(component, "cdx:osquery:category");
    if (
      (category !== "listening_ports" && category !== "processes") ||
      component.version !== "0"
    ) {
      continue;
    }
    const path = propertyOf(component, "path");
    const match =
      typeof path === "string" &&
      homes.find(({ home }) => path.startsWith(`${home}/`));
    if (!match) {
      continue;
    }
    component.version = match.jdk.version;
    for (const key of ["purl", "bom-ref"]) {
      if (typeof component[key] === "string") {
        component[key] = component[key].replace(
          /^(pkg:swid\/[^@]*)@0(?=[?#]|$)/,
          `$1@${match.jdk.version}`,
        );
      }
    }
    component.properties.push({
      name: "cdx:java:vendor",
      value: propertyOf(match.jdk, "cdx:java:vendor"),
    });
    changed++;
  }
  return changed;
}
