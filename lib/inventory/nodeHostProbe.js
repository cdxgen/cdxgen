// Bounded, read-only probe for the Node.js no package manager owns on a live
// host, for `-t os` / obom. The release tarballs, the nodejs.org installer and
// the version managers (nvm, fnm, volta, asdf, mise, n) put Node.js where no
// package database records it, so an OBOM sees neither the runtime nor the
// Brotli decoder compiled into it.
//
// Candidates come from fixed directories and from each version manager's
// tree under the home directories, one wildcard level at a time, never from a
// walk of the file system. The ownership rules, caps and degradations are the
// shared host-runtime probe's.

import { join } from "node:path";

import {
  isDryRun,
  readEnvironmentVariable,
  recordActivity,
} from "../core/activity.js";
import { recordDegradation } from "../core/buildLedger.js";
import {
  attachBrotliDecoder,
  createBrotliInventory,
  finishBrotliInventory,
  readBrotliDecoder,
} from "./brotliDecoder.js";
import {
  isDirectory,
  listDirectory,
  probeHostRuntime,
} from "./hostRuntimeProbe.js";
import {
  attachNodeBuild,
  createNodeRuntimeInventory,
  isNodeBinaryName,
  MAX_NODE_PROBES,
  readNodeBuildVersion,
} from "./nodeBuildInfo.js";

// The most directories one wildcard pattern may expand to.
const MAX_EXPANDED_DIRECTORIES = 256;

// Relative to the root.
const POSIX_DIRECTORIES = {
  linux: ["usr/local/bin", "opt/*/bin", "usr/local/n/versions/node/*/bin"],
  darwin: ["usr/local/bin", "opt/homebrew/bin", "opt/*/bin"],
};

// Relative to a home directory.
const VERSION_MANAGER_DIRECTORIES = [
  ".nvm/versions/node/*/bin",
  ".local/share/fnm/node-versions/*/installation/bin",
  ".fnm/node-versions/*/installation/bin",
  "Library/Application Support/fnm/node-versions/*/installation/bin",
  ".volta/tools/image/node/*/bin",
  ".asdf/installs/nodejs/*/bin",
  ".local/share/mise/installs/node/*/bin",
];

const HOME_PARENTS = {
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
function expandDirectories(base, pattern) {
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

function homeDirectories(context) {
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

function candidateDirectories(context) {
  const { rootPath, platform } = context;
  const directories = [];
  if (platform === "win32") {
    const programFiles =
      context.readEnv("ProgramFiles") || join(rootPath, "Program Files");
    directories.push({ directory: join(programFiles, "nodejs") });
    const appData = context.readEnv("APPDATA");
    if (appData) {
      for (const directory of expandDirectories(appData, "nvm/*")) {
        directories.push({ directory });
      }
    }
    return directories;
  }
  for (const pattern of POSIX_DIRECTORIES[platform] || []) {
    for (const directory of expandDirectories(rootPath, pattern)) {
      directories.push({ directory });
    }
  }
  for (const home of homeDirectories(context)) {
    for (const pattern of VERSION_MANAGER_DIRECTORIES) {
      for (const directory of expandDirectories(home, pattern)) {
        directories.push({ directory });
      }
    }
  }
  return directories;
}

function readBuild(context, candidate) {
  const node = readNodeBuildVersion(candidate.real, context.realRoot);
  if (!node) {
    return undefined;
  }
  return { node, brotli: readBrotliDecoder(candidate.real, context.realRoot) };
}

/**
 * Look for Node.js no package manager owns on the host. Components come back
 * only for the files nothing owns: a `file` component for each `node` binary
 * with the cdx:node and cdx:brotli properties, one `platform` component per
 * Node.js version with its CPE, and the brotli component when a binary embeds
 * a decoder.
 *
 * @param {Object} [options] probe options, as probeHostPhp takes them
 * @returns {{components: Object[], dependencies: Object[]}}
 */
export function probeHostNode(options = {}) {
  return probeHostRuntime(options, {
    label: "Node.js",
    ecosystem: "npm",
    capability: "node-host-probe",
    remediationId: "npm.host-probe.package-db-unreadable",
    maxProbes: MAX_NODE_PROBES,
    chocolateyPackages: ["nodejs", "nodejs-lts", "nodejs.install"],
    directories: candidateDirectories,
    classify: (name) => (isNodeBinaryName(name) ? "node" : undefined),
    readBuild,
    createInventory: () => ({
      node: createNodeRuntimeInventory(),
      brotli: createBrotliInventory(),
    }),
    attach: (inventory, component, build) => {
      attachNodeBuild(inventory.node, component, build.node);
      if (build.brotli) {
        attachBrotliDecoder(inventory.brotli, component, build.brotli);
      }
    },
    finish: (inventory) => {
      const brotli = finishBrotliInventory(inventory.brotli);
      return {
        components: [...inventory.node.runtimeComponents, ...brotli.components],
        dependencies: [...inventory.node.dependencies, ...brotli.dependencies],
      };
    },
    hooks: {
      isDryRun,
      readEnvironmentVariable,
      recordActivity,
      recordDegradation,
    },
  });
}
