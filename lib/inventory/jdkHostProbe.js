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

import { realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";

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
import { jvmOptionsMitigate, parseJvmPathOptions } from "./java4shell.js";
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

// Directories other accounts can write to: a JDK found there is read without
// following a link below its parent, so a planted `release` link cannot lead
// to a file outside it.
const USER_WRITABLE_PREFIXES = ["tmp", "var/tmp", "dev/shm"];

/**
 * The directory of a process's launcher under the probe's root. On the live
 * Windows root the path already names its drive; under another root the drive
 * letter is dropped and the rest joined to it.
 *
 * @param {Object} context probe context with `rootPath`, `logicalRoot`,
 *   `platform` and `pathApi`
 * @param {string} launcherPath path of the launcher as the host names it
 * @returns {string} absolute directory
 */
export function processDirectory(context, launcherPath) {
  const { rootPath, logicalRoot, platform, pathApi } = context;
  const directory = pathApi.dirname(launcherPath);
  if (platform === "win32") {
    if (/^[A-Za-z]:/.test(directory)) {
      if (rootPath.toLowerCase() === logicalRoot.toLowerCase()) {
        return directory;
      }
      return join(rootPath, directory.slice(2).replaceAll("\\", "/"));
    }
    return join(rootPath, directory.replaceAll("\\", "/"));
  }
  return join(rootPath, directory);
}

// The directory of every java launcher a running process was started from,
// as osquery's `processes` and `listening_ports` rows name it. This finds the
// JDKs that applications bundle (Nexus, Jenkins, Elasticsearch, IDEs), which
// no fixed list of directories can name. A directory below a home is read
// without following a link in it, as the other home candidates are, and so
// is one in /tmp, /var/tmp or /dev/shm.
function runningProcessDirectories(context) {
  const { rootPath } = context;
  const homes = homeDirectories(context);
  const writable = USER_WRITABLE_PREFIXES.map((prefix) =>
    join(rootPath, prefix),
  );
  const directories = [];
  const seen = new Set();
  for (const component of context.packageComponents || []) {
    const category = propertyOf(component, "cdx:osquery:category");
    if (category !== "processes" && category !== "listening_ports") {
      continue;
    }
    for (const property of component.properties || []) {
      if (
        property.name !== "path" ||
        typeof property.value !== "string" ||
        !classifyJavaBinary(
          context.pathApi.basename(property.value),
          context.platform,
        )
      ) {
        continue;
      }
      // The Windows probe reads no home directory
      if (
        context.platform === "win32" &&
        property.value
          .split(/[\\/]/)
          .some((part) => part.toLowerCase() === "users")
      ) {
        continue;
      }
      const directory = processDirectory(context, property.value);
      if (seen.has(directory) || seen.size >= MAX_JDK_PROBES) {
        continue;
      }
      seen.add(directory);
      const home = homes.find((candidate) =>
        directory.startsWith(`${candidate}${sep}`),
      );
      if (home) {
        directories.push({ directory, within: home });
      } else if (
        writable.some((root) => directory.startsWith(`${root}${sep}`))
      ) {
        directories.push({ directory, within: dirname(dirname(directory)) });
      } else {
        directories.push({ directory });
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
  return directories
    .concat(homeJdkDirectories(context))
    .concat(runningProcessDirectories(context));
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
  return directories.concat(runningProcessDirectories(context));
}

// The directory a candidate's release file must stay inside: the home, or the
// directory its links were checked against, or the scan root.
function confinementOf(candidate, context) {
  const base = candidate.within || candidate.confine;
  if (!base) {
    return context.realRoot;
  }
  try {
    return realpathSync(base);
  } catch {
    return context.realRoot;
  }
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
 * identity.
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
      readJdkIdentity(
        homeOfLauncher(candidate.real),
        confinementOf(candidate, context),
      ),
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

function isJavaProcessRow(component) {
  const category = propertyOf(component, "cdx:osquery:category");
  if (category !== "processes" && category !== "listening_ports") {
    return false;
  }
  const path = propertyOf(component, "path");
  return (
    typeof path === "string" &&
    ["java", "java.exe"].includes(path.split(/[\\/]/).pop())
  );
}

/**
 * Record, on the process and listening-port rows of java launchers, the two
 * JVM options that switch the Base64 intrinsic path off: `-XX:-UseBASE64Intrinsics`
 * and `-XX:UseAVX=<0-3>`, read from the row's command lines, including the
 * text of a JAVA_TOOL_OPTIONS or JDK_JAVA_OPTIONS assignment in them. They
 * become `cdx:java:jvmOption:UseBASE64Intrinsics` (`true`/`false`) and
 * `cdx:java:jvmOption:UseAVX`. No other option is read: a `-D` value can hold
 * a password.
 *
 * @param {Object[]} components the OS scan's components, changed in place
 * @returns {number} how many rows gained an option
 */
export function annotateJavaProcessOptions(components) {
  let changed = 0;
  for (const component of components || []) {
    if (!isJavaProcessRow(component)) {
      continue;
    }
    const options = parseJvmPathOptions(
      component.properties
        .filter((property) => property.name === "cmdline")
        .map((property) => property.value)
        .join(" "),
    );
    let added = false;
    for (const [name, value] of Object.entries(options)) {
      const propertyName = `cdx:java:jvmOption:${name}`;
      if (!component.properties.some((p) => p.name === propertyName)) {
        component.properties.push({ name: propertyName, value });
        added = true;
      }
    }
    if (added) {
      changed++;
    }
  }
  return changed;
}

// Whether a path lies below a directory, on either kind of host: separators
// are normalised, and Windows paths (a drive letter or a backslash) compare
// without regard to case.
function isUnder(path, directory) {
  const windows = /^[A-Za-z]:|\\/.test(`${path}${directory}`);
  const normalise = (value) => {
    const unified = `${value}`.replaceAll("\\", "/").replace(/\/+$/, "");
    return windows ? unified.toLowerCase() : unified;
  };
  return normalise(path).startsWith(`${normalise(directory)}/`);
}

/**
 * Join the listening-port and process rows of java launchers to the JDK
 * whose home holds the row's path: a probed JDK, or an OS package JDK that
 * names its home (a Windows program's install location). Each such row gains
 * `cdx:java:version` and `cdx:java:vendor`. A row osquery reports with the
 * version 0, a placeholder (a listening-port row's version is its port), gets
 * the JDK's version, and its swid purl and bom-ref are rewritten. A JDK is
 * `mitigated` only when every one of its homes has a running process and
 * every such process sets an option that switches the Base64 intrinsic path
 * off (see annotateJavaProcessOptions); a home without a running process
 * keeps the JDK `exposed`. An OBOM has no dependency graph, so no edge is
 * added. A row whose JDK was not found keeps what it had.
 *
 * @param {Object[]} components the OS scan's components, changed in place
 * @param {Object[]} jdkComponents JDK components with `cdx:java:home`
 * @returns {number} how many rows were changed
 */
export function linkJdkProcessRows(components, jdkComponents) {
  const homes = [];
  for (const jdk of jdkComponents || []) {
    for (const property of jdk.properties || []) {
      if (property.name === "cdx:java:home") {
        homes.push({ home: property.value, jdk, rows: [] });
      }
    }
  }
  if (!homes.length) {
    return 0;
  }
  let changed = 0;
  for (const component of components || []) {
    if (!isJavaProcessRow(component)) {
      continue;
    }
    const path = propertyOf(component, "path");
    const match = homes.find(({ home }) => isUnder(path, home));
    if (!match) {
      continue;
    }
    match.rows.push(component);
    const jdkVersion =
      propertyOf(match.jdk, "cdx:java:version") ?? match.jdk.version;
    // A listening-port row's version is its port number, so only the
    // placeholder 0 is replaced; every row names its JDK in properties.
    if (!component.properties.some((p) => p.name === "cdx:java:version")) {
      component.properties.push(
        { name: "cdx:java:version", value: jdkVersion },
        {
          name: "cdx:java:vendor",
          value: propertyOf(match.jdk, "cdx:java:vendor"),
        },
      );
      changed++;
    }
    if (component.version !== "0") {
      continue;
    }
    component.version = jdkVersion;
    for (const key of ["purl", "bom-ref"]) {
      if (typeof component[key] === "string") {
        component[key] = component[key].replace(
          /^(pkg:swid\/[^@]*)@0(?=[?#]|$)/,
          `$1@${jdkVersion}`,
        );
      }
    }
  }
  // The rows of every home of one component decide together
  const byJdk = new Map();
  for (const entry of homes) {
    byJdk.set(entry.jdk, [...(byJdk.get(entry.jdk) || []), entry]);
  }
  for (const [jdk, entries] of byJdk) {
    const exposure = jdk.properties.find(
      (property) => property.name === "cdx:java:base64IntrinsicExposure",
    );
    if (
      exposure?.value === "exposed" &&
      entries.every(
        ({ rows }) =>
          rows.length > 0 &&
          rows.every((row) =>
            jvmOptionsMitigate({
              UseBASE64Intrinsics: propertyOf(
                row,
                "cdx:java:jvmOption:UseBASE64Intrinsics",
              ),
              UseAVX: propertyOf(row, "cdx:java:jvmOption:UseAVX"),
            }),
          ),
      )
    ) {
      exposure.value = "mitigated";
    }
  }
  return changed;
}
