// Bounded, read-only probe for the Python packages of virtual environments and
// pyenv installs on a live host, for `-t os` / obom.
//
// osquery's python_packages table reads the interpreter's own site-packages
// directories, so a package installed into a virtual environment (an app's
// /opt/app/venv, a Poetry or pipenv environment under a home directory) or into
// a pyenv-built Python is missing from an OBOM. Brotli and brotlicffi are
// usually installed exactly there, pulled in by requests, aiohttp or httpx.
//
// Environments are found in fixed places, one wildcard level at a time: a
// directory holding pyvenv.cfg is a virtual environment, and a pyenv
// `versions/*` directory is an interpreter install. Only `*.dist-info/METADATA`
// files are read; nothing is executed.

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import { isDryRun, recordActivity } from "../core/activity.js";
import { safeExistsSync, safeReadFileSync } from "../core/fs.js";
import { thoughtLog } from "../core/logger.js";
import { applyPurl, tryBuildPurl } from "../inventory/purl.js";
import { parseBdistMetadata } from "./ecosystems.js";

const MAX_ENVIRONMENTS = 64;
const MAX_DIRECTORIES = 512;
const MAX_PACKAGES = 8192;
const MAX_METADATA_BYTES = 4 * 1024 * 1024;

// Relative to the root.
const ROOT_PATTERNS = [
  "opt/*",
  "opt/*/*",
  "srv/*",
  "srv/*/*",
  "app",
  "app/*",
  "usr/local/*",
];
// Relative to a home directory.
const HOME_PATTERNS = [
  "*",
  "*/*",
  ".virtualenvs/*",
  ".local/share/virtualenvs/*",
  ".cache/pypoetry/virtualenvs/*",
  "Library/Caches/pypoetry/virtualenvs/*",
  ".pyenv/versions/*",
];
const HOME_PARENTS = { linux: ["home"], darwin: ["Users"] };
// Folders of a macOS home that privacy protection (TCC) guards. Looking inside
// one makes macOS ask the user to grant the terminal access, so a wildcard
// never enters them; Library is skipped too, for the Mail, Messages and cloud
// storage folders under it. Patterns that name a folder below Library, such as
// Poetry's cache, still reach it.
const MACOS_PROTECTED_HOME_FOLDERS = new Set([
  "Desktop",
  "Documents",
  "Downloads",
  "Library",
  "Movies",
  "Music",
  "Pictures",
]);

function listDirectory(directory) {
  try {
    return readdirSync(directory).sort();
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

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// `skipFirst` names folders a wildcard in the pattern's first segment never
// enters.
function expand(base, pattern, skipFirst) {
  let current = [base];
  for (const [depth, segment] of pattern.split("/").entries()) {
    const next = [];
    for (const directory of current) {
      if (segment !== "*") {
        next.push(join(directory, segment));
        continue;
      }
      for (const name of listDirectory(directory)) {
        // Hidden directories are only entered when a pattern names them.
        if (name.startsWith(".") || (depth === 0 && skipFirst?.has(name))) {
          continue;
        }
        next.push(join(directory, name));
        if (next.length >= MAX_DIRECTORIES) {
          break;
        }
      }
    }
    current = next.filter(isDirectory).slice(0, MAX_DIRECTORIES);
  }
  return current;
}

/**
 * Find the virtual environments and pyenv interpreters under the fixed
 * places of a root.
 *
 * @param {string} rootPath root directory
 * @param {string} platform `linux` or `darwin`
 * @returns {{path: string, kind: string}[]} environments, at most MAX_ENVIRONMENTS
 */
export function findPythonEnvironments(rootPath, platform) {
  const bases = [{ base: rootPath, patterns: ROOT_PATTERNS }];
  const homes = platform === "linux" ? [join(rootPath, "root")] : [];
  for (const parent of HOME_PARENTS[platform] || []) {
    for (const name of listDirectory(join(rootPath, parent))) {
      homes.push(join(rootPath, parent, name));
    }
  }
  const skipFirst =
    platform === "darwin" ? MACOS_PROTECTED_HOME_FOLDERS : undefined;
  for (const home of homes.filter(isDirectory)) {
    bases.push({ base: home, patterns: HOME_PATTERNS, skipFirst });
  }
  const environments = [];
  const seen = new Set();
  for (const { base, patterns, skipFirst } of bases) {
    for (const pattern of patterns) {
      for (const candidate of expand(base, pattern, skipFirst)) {
        if (seen.has(candidate)) {
          continue;
        }
        let kind;
        if (isFile(join(candidate, "pyvenv.cfg"))) {
          kind = "virtualenv";
        } else if (pattern.endsWith(".pyenv/versions/*")) {
          kind = "pyenv";
        }
        // A directory with a nested .venv is the project, not the environment.
        if (!kind && isFile(join(candidate, ".venv", "pyvenv.cfg"))) {
          const nested = join(candidate, ".venv");
          if (!seen.has(nested)) {
            seen.add(nested);
            environments.push({ path: nested, kind: "virtualenv" });
          }
          continue;
        }
        if (!kind) {
          continue;
        }
        seen.add(candidate);
        environments.push({ path: candidate, kind });
        if (environments.length >= MAX_ENVIRONMENTS) {
          return environments;
        }
      }
    }
  }
  return environments;
}

function sitePackagesOf(environment) {
  const lib = join(environment, "lib");
  const directories = [];
  for (const name of listDirectory(lib)) {
    if (!name.startsWith("python")) {
      continue;
    }
    const sitePackages = join(lib, name, "site-packages");
    if (isDirectory(sitePackages)) {
      directories.push(sitePackages);
    }
  }
  return directories;
}

function readMetadata(file) {
  try {
    const stats = statSync(file);
    if (!stats.isFile() || stats.size > MAX_METADATA_BYTES) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  const text = safeReadFileSync(file, "utf-8");
  return typeof text === "string" ? text : undefined;
}

/**
 * Inventory the packages installed in the virtual environments and pyenv
 * interpreters of a host. One component per distinct name and version, with
 * an occurrence for each dist-info directory it was found in, so no host path
 * reaches a purl.
 *
 * @param {Object} [options] options
 * @param {string} [options.rootPath="/"] root directory; tests point it at a built tree
 * @param {string} [options.platform] `linux` or `darwin`
 * @returns {Object[]} pypi components
 */
export function probeHostPythonEnvironments(options = {}) {
  const rootPath = options.rootPath || "/";
  const platform = options.platform || process.platform;
  if (!HOME_PARENTS[platform]) {
    return [];
  }
  if (isDryRun) {
    recordActivity({
      capability: "python-env-probe",
      kind: "read",
      reason:
        "Dry run mode blocks the Python environment probe, which reads package metadata outside the project.",
      status: "blocked",
      target: rootPath,
    });
    return [];
  }
  if (!safeExistsSync(rootPath)) {
    return [];
  }
  const environments = findPythonEnvironments(rootPath, platform);
  const byRef = new Map();
  let packages = 0;
  for (const environment of environments) {
    for (const sitePackages of sitePackagesOf(environment.path)) {
      for (const name of listDirectory(sitePackages)) {
        if (!name.endsWith(".dist-info") || packages >= MAX_PACKAGES) {
          continue;
        }
        const distInfo = join(sitePackages, name);
        const metadataFile = join(distInfo, "METADATA");
        const raw = readMetadata(metadataFile);
        if (raw === undefined) {
          continue;
        }
        const [pkg] = parseBdistMetadata(metadataFile, raw);
        if (!pkg?.name || !pkg.version) {
          continue;
        }
        packages += 1;
        const purl = tryBuildPurl({
          type: "pypi",
          name: pkg.name,
          version: pkg.version,
        });
        if (!purl) {
          continue;
        }
        const ref = decodeURIComponent(purl);
        let component = byRef.get(ref);
        if (!component) {
          component = applyPurl(
            {
              type: "library",
              name: pkg.name,
              version: pkg.version,
              ...(pkg.description ? { description: pkg.description } : {}),
              properties: [
                { name: "cdx:python:environment", value: environment.kind },
              ],
              evidence: { occurrences: [] },
            },
            purl,
          );
          byRef.set(ref, component);
        } else if (
          !component.properties.some(
            (prop) =>
              prop.name === "cdx:python:environment" &&
              prop.value === environment.kind,
          )
        ) {
          component.properties.push({
            name: "cdx:python:environment",
            value: environment.kind,
          });
        }
        component.evidence.occurrences.push({ location: distInfo });
      }
    }
  }
  recordActivity({
    capability: "python-env-probe",
    kind: "read",
    reason: `Read ${packages} package(s) from ${environments.length} Python environment(s) in the fixed places.`,
    status: "completed",
    target: rootPath,
  });
  if (byRef.size) {
    thoughtLog(
      `I found ${byRef.size} Python package(s) in ${environments.length} virtual environment(s) or pyenv install(s).`,
    );
  }
  return Array.from(byRef.values()).sort((a, b) =>
    a["bom-ref"] < b["bom-ref"] ? -1 : a["bom-ref"] > b["bom-ref"] ? 1 : 0,
  );
}

/**
 * Add the packages of the host's Python environments to an OBOM's component
 * list. A package osquery already listed from the interpreter's own
 * site-packages keeps its component; the environment's dist-info becomes one
 * more occurrence of it, and its cdx:python:environment property says where
 * else it is installed.
 *
 * @param {Object[]} components OBOM components
 * @param {Object[]} envPackages result of probeHostPythonEnvironments
 * @returns {Object[]} the components, with the environment packages merged in
 */
export function mergeHostPythonEnvironmentPackages(components, envPackages) {
  if (!envPackages?.length) {
    return components;
  }
  const byPurl = new Map();
  for (const component of components) {
    if (typeof component?.purl === "string") {
      byPurl.set(decodeURIComponent(component.purl), component);
    }
  }
  const added = [];
  for (const pkg of envPackages) {
    const existing = byPurl.get(decodeURIComponent(pkg.purl));
    if (!existing) {
      added.push(pkg);
      continue;
    }
    existing.evidence = existing.evidence || {};
    const occurrences = existing.evidence.occurrences || [];
    for (const occurrence of pkg.evidence?.occurrences || []) {
      if (!occurrences.some((o) => o.location === occurrence.location)) {
        occurrences.push(occurrence);
      }
    }
    existing.evidence.occurrences = occurrences;
    existing.properties = existing.properties || [];
    for (const prop of pkg.properties || []) {
      if (
        !existing.properties.some(
          (p) => p.name === prop.name && p.value === prop.value,
        )
      ) {
        existing.properties.push(prop);
      }
    }
  }
  return added.length ? components.concat(added) : components;
}
