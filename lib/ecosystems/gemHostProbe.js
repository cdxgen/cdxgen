// Bounded, read-only inventory of the gems installed on a live host, for
// `-t os` / obom. osquery has no table for RubyGems, so without this an OBOM
// lists no gems at all: neither the default gems that ship with each Ruby
// (resolv, net-http, uri, ...), nor what `gem install` and the distro's
// ruby-* packages put in the system gem homes, nor the gems of the version
// manager installs.
//
// Gem homes are found in fixed places, one wildcard level at a time: a
// directory holding a `specifications` directory is a gem home. Only the
// `*.gemspec` files under specifications/ and specifications/default/ are
// read, statically; nothing is executed. A gemspec a package database lists is
// marked with `cdx:os:installedBy`, so a consumer judges it by that package,
// which may carry backported fixes under the same gem version.

import { readdirSync, statSync } from "node:fs";
import { join, posix, relative, sep, win32 } from "node:path";
import process from "node:process";

import { isDryRun, recordActivity } from "../core/activity.js";
import { safeExistsSync, safeReadFileSync } from "../core/fs.js";
import { thoughtLog } from "../core/logger.js";
import { findHostPathOwners } from "../inventory/hostRuntimeProbe.js";
import {
  expandDirectories,
  homeDirectories,
  windowsRubyRoots,
} from "../inventory/rubyHostProbe.js";
import { parseGemspecData } from "./rubyutils.js";

const MAX_GEM_HOMES = 128;
const MAX_GEMSPECS = 8192;
const MAX_GEMSPEC_BYTES = 1024 * 1024;

// Gem homes relative to the root.
const ROOT_GEM_HOMES = {
  linux: [
    "usr/lib/ruby/gems/*",
    "usr/lib64/ruby/gems/*",
    "usr/share/gems",
    "usr/local/share/gems",
    "var/lib/gems/*",
    "usr/local/lib/ruby/gems/*",
    "usr/local/bundle",
    "opt/*/lib/ruby/gems/*",
    "opt/rubies/*/lib/ruby/gems/*",
    "opt/hostedtoolcache/Ruby/*/*/lib/ruby/gems/*",
    "usr/local/rbenv/versions/*/lib/ruby/gems/*",
    "usr/local/rvm/rubies/*/lib/ruby/gems/*",
    "usr/local/rvm/gems/*",
  ],
  darwin: [
    "Library/Ruby/Gems/*",
    "usr/local/lib/ruby/gems/*",
    "opt/homebrew/lib/ruby/gems/*",
    "opt/*/lib/ruby/gems/*",
    "opt/rubies/*/lib/ruby/gems/*",
  ],
};

// Gem homes relative to a home directory.
const USER_GEM_HOMES = [
  ".gem/ruby/*",
  ".local/share/gem/ruby/*",
  ".rbenv/versions/*/lib/ruby/gems/*",
  ".rvm/rubies/*/lib/ruby/gems/*",
  ".rvm/gems/*",
  ".asdf/installs/ruby/*/lib/ruby/gems/*",
  ".local/share/mise/installs/ruby/*/lib/ruby/gems/*",
  ".rubies/*/lib/ruby/gems/*",
  ".frum/versions/*/lib/ruby/gems/*",
  ".local/share/rv/rubies/*/lib/ruby/gems/*",
];

function listGemspecs(directory) {
  try {
    return readdirSync(directory)
      .filter((name) => name.endsWith(".gemspec"))
      .sort();
  } catch {
    return [];
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The gem homes of a host, each a directory with a `specifications` directory.
 *
 * @param {string} rootPath root directory
 * @param {string} platform `linux`, `darwin` or `win32`
 * @returns {string[]} absolute gem home directories
 */
export function findGemHomes(rootPath, platform) {
  const context = { rootPath, platform };
  const candidates = [];
  if (platform === "win32") {
    for (const root of windowsRubyRoots(context)) {
      candidates.push(...expandDirectories(root, "lib/ruby/gems/*"));
    }
  } else {
    for (const pattern of ROOT_GEM_HOMES[platform] || []) {
      candidates.push(...expandDirectories(rootPath, pattern));
    }
    for (const home of homeDirectories(context)) {
      for (const pattern of USER_GEM_HOMES) {
        candidates.push(...expandDirectories(home, pattern));
      }
    }
  }
  const homes = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (
      seen.has(candidate) ||
      !isDirectory(join(candidate, "specifications"))
    ) {
      continue;
    }
    seen.add(candidate);
    homes.push(candidate);
    if (homes.length >= MAX_GEM_HOMES) {
      break;
    }
  }
  return homes;
}

// The path as the host names it, for the package databases and evidence.
function logicalPath(rootPath, platform, absolutePath) {
  const parts = relative(rootPath, absolutePath).split(sep);
  if (platform === "win32") {
    return win32.join(rootPath, ...parts);
  }
  return posix.join("/", ...parts);
}

/**
 * Inventory the gems of a host's gem homes. One component per distinct gem
 * and version, with an occurrence for each gemspec it was read from, so no
 * host path reaches a purl.
 *
 * @param {Object} [options] options
 * @param {string} [options.rootPath="/"] root directory; tests point it at a built tree
 * @param {string} [options.platform] `linux`, `darwin` or `win32`
 * @param {function(string): (Object[]|undefined)} [options.executeOsQuery] runs
 *   an osquery query, for rpm ownership
 * @param {Object[]} [options.packageComponents] the OS packages the scan has
 *   inventoried, which name the owners
 * @param {Object} [options.packageDatabases] where the package databases are
 * @returns {Promise<Object[]>} gem components
 */
export async function probeHostRubyGems(options = {}) {
  const platform = options.platform || process.platform;
  const rootPath =
    options.rootPath ||
    (platform === "win32" ? `${process.env.SystemDrive || "C:"}\\` : "/");
  if (isDryRun) {
    recordActivity({
      capability: "ruby-gem-probe",
      kind: "read",
      reason:
        "Dry run mode blocks the RubyGems probe, which reads gem specifications outside the project.",
      status: "blocked",
      target: rootPath,
    });
    return [];
  }
  if (!safeExistsSync(rootPath)) {
    return [];
  }
  const homes = findGemHomes(rootPath, platform);
  const gemspecs = [];
  for (const home of homes) {
    for (const subdir of [
      "specifications",
      join("specifications", "default"),
    ]) {
      const directory = join(home, subdir);
      for (const name of listGemspecs(directory)) {
        if (gemspecs.length >= MAX_GEMSPECS) {
          break;
        }
        const absolutePath = join(directory, name);
        gemspecs.push({
          absolutePath,
          logical: logicalPath(rootPath, platform, absolutePath),
        });
      }
    }
  }
  if (!gemspecs.length) {
    return [];
  }
  const { owners, unreadable } = findHostPathOwners(
    { ...options, platform, rootPath },
    gemspecs.map((gemspec) => gemspec.logical),
  );
  // An OBOM names a package once; its purl says how the distro named it.
  const packagePurls = new Map();
  for (const component of options.packageComponents || []) {
    if (
      component?.name &&
      typeof component.purl === "string" &&
      /^pkg:(deb|rpm|apk)\//.test(component.purl) &&
      !packagePurls.has(component.name)
    ) {
      packagePurls.set(component.name, decodeURIComponent(component.purl));
    }
  }
  const byRef = new Map();
  for (const gemspec of gemspecs) {
    const text = safeReadFileSync(gemspec.absolutePath, "utf-8");
    if (typeof text !== "string" || text.length > MAX_GEMSPEC_BYTES) {
      continue;
    }
    // The gemspec files RubyGems writes on install are Ruby source, read here
    // without evaluating them.
    const [pkg] = await parseGemspecData(text, gemspec.logical);
    if (!pkg?.name || !pkg.version || !pkg["bom-ref"]) {
      continue;
    }
    const owner = owners.get(gemspec.logical);
    const ownerRef = owner
      ? packagePurls.get(owner.packageName) || owner.packageName
      : undefined;
    let component = byRef.get(pkg["bom-ref"]);
    if (!component) {
      component = pkg;
      component.evidence = {
        ...(component.evidence || {}),
        occurrences: [],
      };
      byRef.set(pkg["bom-ref"], component);
    }
    component.properties = component.properties || [];
    if (
      ownerRef &&
      !component.properties.some(
        (prop) => prop.name === "cdx:os:installedBy" && prop.value === ownerRef,
      )
    ) {
      component.properties.push({
        name: "cdx:os:installedBy",
        value: ownerRef,
      });
    }
    if (
      !component.evidence.occurrences.some(
        (occurrence) => occurrence.location === gemspec.logical,
      )
    ) {
      component.evidence.occurrences.push({ location: gemspec.logical });
    }
  }
  // A gem a package owns in one gem home and `gem install` put in another is
  // not wholly that package's, so it keeps no owner.
  for (const component of byRef.values()) {
    const owned = component.evidence.occurrences.every((occurrence) =>
      owners.has(occurrence.location),
    );
    if (!owned) {
      component.properties = component.properties.filter(
        (prop) => prop.name !== "cdx:os:installedBy",
      );
    }
  }
  recordActivity({
    capability: "ruby-gem-probe",
    kind: "read",
    reason: `Read ${gemspecs.length} gemspec(s) from ${homes.length} gem home(s) in the fixed places${unreadable.length ? `; the ${unreadable.join(", ")} database could not be read in full, so gem ownership is incomplete` : ""}.`,
    status: "completed",
    target: rootPath,
  });
  if (byRef.size) {
    thoughtLog(
      `I found ${byRef.size} gem(s) in ${homes.length} gem home(s) on this host.`,
    );
  }
  return Array.from(byRef.values()).sort((a, b) =>
    a["bom-ref"] < b["bom-ref"] ? -1 : a["bom-ref"] > b["bom-ref"] ? 1 : 0,
  );
}
