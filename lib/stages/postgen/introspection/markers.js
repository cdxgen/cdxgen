/**
 * Ecosystem marker detection for the build-introspection reflection step.
 *
 * A marker is a manifest or lockfile whose presence on disk proves an
 * ecosystem was part of the scanned project. Markers drive two verdicts:
 * an ecosystem with markers but zero components in the BOM is `absent`, and
 * an ecosystem that has markers but no cdxgen project type at all is a
 * coverage gap (`unsupported`), which is cdxgen's backlog rather than the
 * user's problem.
 *
 * Detection is deliberately bounded: the scanned directory itself plus one
 * level of immediate subdirectories. postProcess runs after generation, so a
 * second full tree walk would be a measurable cost on large repos; markers
 * deeper than one directory level are simply not seen, which is acceptable
 * because tier assignment never relies on markers alone when the BOM already
 * carries the ecosystem's components.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

import { safeExistsSync } from "../../../core/fs.js";

/** Largest number of immediate subdirectories inspected at depth one. */
const MAX_SUBDIRS_SCANNED = 100;

/**
 * Marker table: ecosystem → manifest and lockfile names that indicate the
 * ecosystem is part of the project. Entries are either exact file names or
 * `{ suffix }` matchers for extension-driven ecosystems. Ecosystems cdxgen
 * cannot parse (currently only dub, the D package manager) are included so
 * the reflection can report them as coverage gaps instead of silently
 * ignoring them.
 *
 * @type {Readonly<Record<string, {names: string[], suffixes: string[]}>>}
 */
export const ECOSYSTEM_MARKERS = Object.freeze({
  java: {
    names: [
      "pom.xml",
      "build.gradle",
      "build.gradle.kts",
      "settings.gradle",
      "settings.gradle.kts",
      "gradlew",
      "build.sbt",
      "mill-version",
      ".sdkmanrc",
    ],
    suffixes: [],
  },
  npm: {
    names: [
      "package.json",
      "package-lock.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "yarn.lock",
      "bun.lockb",
      "bun.lock",
      "deno.lock",
    ],
    suffixes: [],
  },
  python: {
    names: [
      "requirements.txt",
      "Pipfile",
      "Pipfile.lock",
      "pyproject.toml",
      "poetry.lock",
      "pdm.lock",
      "uv.lock",
      "setup.py",
      "setup.cfg",
      ".python-version",
      "environment.yml",
    ],
    suffixes: [],
  },
  go: { names: ["go.mod", "go.sum", "go.work"], suffixes: [] },
  rust: {
    names: [
      "Cargo.toml",
      "Cargo.lock",
      "rust-toolchain.toml",
      "rust-toolchain",
    ],
    suffixes: [],
  },
  ruby: { names: ["Gemfile", "Gemfile.lock", ".ruby-version"], suffixes: [] },
  csharp: {
    names: ["global.json", "nuget.config"],
    suffixes: [".csproj", ".vbproj", ".fsproj", ".sln"],
  },
  php: { names: ["composer.json", "composer.lock"], suffixes: [] },
  dart: { names: ["pubspec.yaml", "pubspec.lock"], suffixes: [] },
  helm: { names: ["Chart.yaml", "Chart.yml"], suffixes: [] },
  clojure: {
    names: ["project.clj", "deps.edn", "bb.edn", "shadow-cljs.edn"],
    suffixes: [],
  },
  cocoa: { names: ["Podfile", "Podfile.lock"], suffixes: [] },
  swift: { names: ["Package.swift", "Package.resolved"], suffixes: [] },
  elixir: { names: ["mix.exs", "mix.lock"], suffixes: [] },
  c: {
    names: [
      "CMakeLists.txt",
      "conanfile.txt",
      "conanfile.py",
      "xmake-requires.lock",
    ],
    suffixes: [],
  },
  haskell: {
    names: ["cabal.project", "stack.yaml", "stack.yaml.lock", "stack.lock"],
    suffixes: [".cabal"],
  },
  elm: { names: ["elm.json", "elm-package.json"], suffixes: [] },
  dub: { names: ["dub.json", "dub.sdl"], suffixes: [] },
  crystal: { names: ["shard.yml", "shard.lock"], suffixes: [] },
  nim: { names: ["nim.cfg", "config.nims"], suffixes: [".nimble"] },
  perl: {
    names: [
      "cpanfile",
      "cpanfile.snapshot",
      "META.json",
      "META.yml",
      "Makefile.PL",
      "Build.PL",
    ],
    suffixes: [],
  },
  r: { names: ["DESCRIPTION", "renv.lock"], suffixes: [] },
  julia: { names: ["Project.toml", "Manifest.toml"], suffixes: [] },
  erlang: { names: ["rebar.config", "rebar.lock"], suffixes: [] },
  ocaml: { names: ["dune-project"], suffixes: [".opam"] },
  lua: { names: ["luarocks.lock"], suffixes: [".rockspec"] },
  spack: { names: ["spack.yaml", "spack.lock"], suffixes: [] },
  terraform: { names: [".terraform.lock.hcl"], suffixes: [".tf", ".tofu"] },
});

/** Marker file name → ecosystems claiming it, and marker suffix → claiming
 * ecosystems, both built once from the table. The name index is exported so
 * the reflection can recognize marker paths carried in ledger events without
 * rescanning the filesystem. */
export const MARKERS_BY_NAME = new Map();
/** Marker suffix → ecosystems claiming it. */
const MARKERS_BY_SUFFIX = [];
for (const [ecosystem, markers] of Object.entries(ECOSYSTEM_MARKERS)) {
  for (const name of markers.names) {
    const ecosystems = MARKERS_BY_NAME.get(name) || [];
    ecosystems.push(ecosystem);
    MARKERS_BY_NAME.set(name, ecosystems);
  }
  for (const suffix of markers.suffixes) {
    MARKERS_BY_SUFFIX.push({ ecosystem, suffix });
  }
}

/**
 * List a directory's entries as plain `{ name, directory }` records, sorted by
 * name so detection results are deterministic. Callers may inject this helper
 * to bound or observe the scan in tests.
 *
 * @param {string} dirPath Directory to list.
 * @returns {{name: string, directory: boolean}[]} Sorted entries.
 */
function listDirectory(dirPath) {
  return readdirSync(dirPath, { withFileTypes: true })
    .map((entry) => ({ name: entry.name, directory: entry.isDirectory() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Match one directory's entries against the marker index and record the full
 * paths of every marker found.
 *
 * @param {string} dirPath Directory the entries belong to.
 * @param {{name: string, directory: boolean}[]} entries Directory entries.
 * @param {Map<string, Set<string>>} markersByEcosystem Accumulator keyed by ecosystem.
 * @returns {void}
 */
function scanEntries(dirPath, entries, markersByEcosystem) {
  for (const entry of entries) {
    const nameEcosystems = MARKERS_BY_NAME.get(entry.name);
    if (nameEcosystems) {
      for (const ecosystem of nameEcosystems) {
        const paths = markersByEcosystem.get(ecosystem) || new Set();
        paths.add(join(dirPath, entry.name));
        markersByEcosystem.set(ecosystem, paths);
      }
    }
    for (const { ecosystem, suffix } of MARKERS_BY_SUFFIX) {
      if (entry.name.length > suffix.length && entry.name.endsWith(suffix)) {
        const paths = markersByEcosystem.get(ecosystem) || new Set();
        paths.add(join(dirPath, entry.name));
        markersByEcosystem.set(ecosystem, paths);
      }
    }
  }
}

/**
 * Detect ecosystem markers under a project directory without walking the full
 * tree: the directory itself is inspected, then up to
 * {@link MAX_SUBDIRS_SCANNED} immediate subdirectories in sorted order. Paths
 * are built with `node:path`, so `markersOnDisk` carries platform-correct
 * separators.
 *
 * @param {string} projectPath Directory that was scanned, when known.
 * @param {Object} [hooks] Test hooks.
 * @param {(dirPath: string) => {name: string, directory: boolean}[]} [hooks.listDir] Directory lister override.
 * @returns {{markersByEcosystem: Map<string, string[]>, scannedDirectories: number}} Marker paths per ecosystem and the number of directories inspected.
 */
export function detectEcosystemMarkers(projectPath, hooks = {}) {
  const markersByEcosystem = new Map();
  if (!projectPath || !safeExistsSync(projectPath)) {
    return { markersByEcosystem, scannedDirectories: 0 };
  }
  const listDir = hooks.listDir || listDirectory;
  let rootEntries;
  try {
    rootEntries = listDir(projectPath);
  } catch {
    return { markersByEcosystem, scannedDirectories: 0 };
  }
  scanEntries(projectPath, rootEntries, markersByEcosystem);
  const subdirs = rootEntries
    .filter((entry) => entry.directory)
    .map((entry) => entry.name)
    .slice(0, MAX_SUBDIRS_SCANNED);
  let scannedDirectories = 1;
  for (const subdir of subdirs) {
    const subdirPath = join(projectPath, subdir);
    try {
      scanEntries(subdirPath, listDir(subdirPath), markersByEcosystem);
    } catch {
      continue;
    }
    scannedDirectories += 1;
  }
  const sorted = new Map(
    [...markersByEcosystem.entries()].map(([ecosystem, paths]) => [
      ecosystem,
      [...paths].sort(),
    ]),
  );
  return { markersByEcosystem: sorted, scannedDirectories };
}
