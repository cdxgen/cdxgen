// Identify the JDKs installed in an extracted image or rootfs. An OS package
// names its JDK (the Corretto rpm, the Alpine openjdk apk, the SLES rpm), but
// the JDK of an eclipse-temurin image, the sdkman JDKs of cdxgen's own images
// and a tarball unpacked under /opt or /usr/local are no package's files, so
// no package table lists them (issue #4862).
//
// A JDK home is a directory with a `release` file beside `bin/java`. Homes are
// looked for under a fixed set of parents, one wildcard level at a time and
// never in a walk of the tree, and under any JAVA_HOME the image config names.
// The release file is read through the bounded file reader, and nothing in the
// image is executed. A home a package manager owns is left to that package.

import { join, relative, sep } from "node:path";

import { safeExistsSync } from "../core/fs.js";
import { isPlainDirectory, listDirectory } from "./hostRuntimeProbe.js";
import {
  attachJdk,
  createJdkInventory,
  readJdkIdentity,
} from "./jdkIdentity.js";

// The parents whose children may be JDK homes, relative to the root. A
// wildcard names one level of directories (the homes of users).
const JDK_PARENTS = [
  "opt",
  "opt/java",
  "opt/jdk",
  "opt/jvm",
  "opt/.sdkman/candidates/java",
  "opt/sdkman/candidates/java",
  "usr/lib/jvm",
  "usr/java",
  "usr/local",
  "usr/local/java",
  "usr/local/lib/jvm",
  "usr/local/sdkman/candidates/java",
  "root/.sdkman/candidates/java",
  "home/*/.sdkman/candidates/java",
];

// The directories OS packages install JDKs to, and the names of such packages
// (java-21-amazon-corretto-headless, openjdk-17-jre, java-11-openjdk-devel,
// temurin-21-jdk, zulu21-jdk, bellsoft-java21).
const PACKAGE_JDK_DIRECTORIES = ["/usr/lib/jvm/", "/usr/java/"];
const JDK_PACKAGE_NAME =
  /(?:^|[-_])(?:openjdk|jdk|jre|corretto|temurin|zulu\d*|liberica|bellsoft|java-\d+)(?:$|[-_\d])/i;

/**
 * The most JDK homes one rootfs is probed at, including the ones the image
 * config names.
 *
 * @type {number}
 */
export const MAX_JDK_HOMES = 64;
// The most entries read from one parent directory.
const MAX_ENTRIES_PER_PARENT = 256;

function expandParent(basePath, pattern) {
  let current = [basePath];
  for (const segment of pattern.split("/")) {
    const next = [];
    for (const directory of current) {
      if (segment !== "*") {
        next.push(join(directory, segment));
        continue;
      }
      for (const name of listDirectory(directory).slice(
        0,
        MAX_ENTRIES_PER_PARENT,
      )) {
        const child = join(directory, name);
        if (isPlainDirectory(child)) {
          next.push(child);
        }
      }
    }
    current = next;
  }
  return current.filter(isPlainDirectory);
}

function isJdkHome(directory) {
  return (
    safeExistsSync(join(directory, "release")) &&
    (safeExistsSync(join(directory, "bin", "java")) ||
      safeExistsSync(join(directory, "bin", "java.exe")))
  );
}

function javaHomesFromEnvironment(envValues) {
  const homes = [];
  for (const entry of Array.isArray(envValues) ? envValues : []) {
    if (typeof entry !== "string" || !entry.startsWith("JAVA_HOME=")) {
      continue;
    }
    // The value is read as a path inside the rootfs: a drive letter or a ".."
    // segment would name something outside it.
    const value = entry.slice("JAVA_HOME=".length).trim();
    const segments = value
      .split(/[\\/]+/)
      .filter((segment) => segment && segment !== ".");
    if (
      !segments.length ||
      /^[A-Za-z]:/.test(value) ||
      segments.includes("..")
    ) {
      continue;
    }
    homes.push(segments);
  }
  return homes;
}

/**
 * The JDK home candidates of an extracted rootfs: the children of the fixed
 * parents that are plain directories (a symbolic link such as sdkman's
 * `current` names a home found under its real name), and any JAVA_HOME the
 * image config names.
 *
 * @param {string} basePath extracted rootfs
 * @param {string[]|undefined} envValues environment of the image config
 * @returns {string[]} absolute home paths, at most MAX_JDK_HOMES
 */
export function candidateJdkHomes(basePath, envValues) {
  const homes = [];
  const seen = new Set();
  const consider = (directory) => {
    if (
      homes.length < MAX_JDK_HOMES &&
      !seen.has(directory) &&
      isJdkHome(directory)
    ) {
      seen.add(directory);
      homes.push(directory);
    }
  };
  for (const segments of javaHomesFromEnvironment(envValues)) {
    consider(join(basePath, ...segments));
  }
  for (const pattern of JDK_PARENTS) {
    for (const parent of expandParent(basePath, pattern)) {
      for (const name of listDirectory(parent).slice(
        0,
        MAX_ENTRIES_PER_PARENT,
      )) {
        const child = join(parent, name);
        if (isPlainDirectory(child)) {
          consider(child);
        }
      }
    }
  }
  return homes;
}

/**
 * Identify the JDKs installed in an extracted rootfs. Each home becomes
 * one `platform` component per identity (a JDK installed twice is one
 * component with two occurrences); the `bin/java` launcher component, when
 * the executables scan found one, is tagged and linked to it. A home an OS
 * package owns is left to that package.
 *
 * @param {string} basePath extracted rootfs the paths are relative to
 * @param {string[]|undefined} ownedFilePaths root-relative paths owned by OS
 *   packages
 * @param {string[]|undefined} envValues environment of the image config
 * @param {Object[]} executables file components from
 *   `fileComponents(.., "executable")`
 * @param {string[]|undefined} osPackageNames names of the OS packages the
 *   scan found. Some package managers list no files (trivy gives none for an
 *   rpm), so a home under a directory only JDK packages install to, such as
 *   /usr/lib/jvm, is package-owned when a JDK package is installed
 * @returns {{jdkComponents: Object[], dependencies: Object[]}}
 */
export function collectJdkInfo(
  basePath,
  ownedFilePaths,
  envValues,
  executables,
  osPackageNames,
) {
  // File lists name paths with or without the leading slash (apk lists have
  // none), so both sides are compared with one.
  const withSlash = (path) => (`${path}`.startsWith("/") ? path : `/${path}`);
  const owned = new Set((ownedFilePaths || []).map(withSlash));
  const bySrcFile = new Map();
  for (const component of executables || []) {
    const srcFile = component?.properties?.find(
      (property) => property.name === "internal:SrcFile",
    )?.value;
    if (srcFile && !bySrcFile.has(srcFile)) {
      bySrcFile.set(srcFile, component);
    }
  }
  const inventory = createJdkInventory();
  for (const home of candidateJdkHomes(basePath, envValues)) {
    const rootRelative = `/${relative(basePath, home).split(sep).join("/")}`;
    let ownedHome = owned.has(rootRelative);
    if (!ownedHome) {
      for (const path of owned) {
        if (path.startsWith(`${rootRelative}/`)) {
          ownedHome = true;
          break;
        }
      }
    }
    if (
      !ownedHome &&
      PACKAGE_JDK_DIRECTORIES.some((prefix) =>
        rootRelative.startsWith(prefix),
      ) &&
      (osPackageNames || []).some((name) => JDK_PACKAGE_NAME.test(name))
    ) {
      ownedHome = true;
    }
    if (ownedHome) {
      continue;
    }
    const identity = readJdkIdentity(home, basePath);
    if (!identity) {
      continue;
    }
    const launcher = bySrcFile.get(`${rootRelative}/bin/java`);
    if (launcher) {
      attachJdk(inventory, launcher, identity, rootRelative);
    } else {
      attachJdk(inventory, { properties: [] }, identity, rootRelative);
    }
  }
  return {
    jdkComponents: inventory.runtimeComponents,
    dependencies: inventory.dependencies,
  };
}
