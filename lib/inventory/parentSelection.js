/**
 * Which detected project becomes the parent (`metadata.component`) when one
 * scan covers several ecosystems and no parent was given.
 *
 * Each ecosystem detects its own project from its own manifest. The project
 * whose manifest sits at the scan root describes the repository; one found
 * deeper is a part of it (a web client in `tools/ui/`, a helper script's
 * `pyproject.toml`). So candidates are ordered by how deep their ecosystem's
 * manifests sit, the scan root first, and ties keep the ecosystem order the
 * scan ran in.
 */

import { readdirSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

import { getAllFiles } from "../core/fs.js";

/**
 * Manifest file names (or `*.ext` suffixes) per purl type: the files a
 * project of that ecosystem is described by.
 */
const MANIFESTS_BY_PURL_TYPE = {
  npm: ["package.json"],
  pypi: [
    "pyproject.toml",
    "setup.py",
    "setup.cfg",
    "Pipfile",
    "requirements.txt",
    "uv.lock",
    "poetry.lock",
    "pixi.toml",
  ],
  generic: [
    "CMakeLists.txt",
    "meson.build",
    "conanfile.txt",
    "conanfile.py",
    "vcpkg.json",
    "xmake.lua",
  ],
  maven: ["pom.xml", "build.gradle", "build.gradle.kts", "build.sbt"],
  golang: ["go.mod"],
  cargo: ["Cargo.toml"],
  composer: ["composer.json"],
  gem: ["Gemfile", "*.gemspec"],
  nuget: ["*.csproj", "*.fsproj", "*.vbproj", "*.sln", "packages.config"],
  pub: ["pubspec.yaml"],
  hex: ["mix.exs"],
  hackage: ["*.cabal", "stack.yaml"],
  swift: ["Package.swift"],
  cocoapods: ["Podfile"],
  clojars: ["deps.edn", "project.clj"],
};

/** The purl type of a component, or `undefined`. */
function purlTypeOf(component) {
  const purl = `${component?.purl || ""}`;
  if (!purl.startsWith("pkg:")) {
    return undefined;
  }
  const rest = purl.slice(4);
  const end = rest.search(/[/@?#]/);
  return (end < 0 ? rest : rest.slice(0, end)).toLowerCase();
}

function matchesManifest(name, patterns) {
  return patterns.some((p) =>
    p.startsWith("*.") ? name.endsWith(p.slice(1)) : name === p,
  );
}

/**
 * How deep the shallowest manifest of an ecosystem sits under a scan root:
 * 0 for one at the root itself, `Infinity` when there is none (or the
 * ecosystem is not one this module knows).
 *
 * @param {string} root Scan root
 * @param {string} purlType Purl type of the ecosystem
 * @param {Object} options CLI options (exclusions)
 * @returns {number}
 */
export function manifestDepth(root, purlType, options = {}) {
  const patterns = MANIFESTS_BY_PURL_TYPE[purlType];
  if (!patterns || !root) {
    return Number.POSITIVE_INFINITY;
  }
  const absRoot = resolve(root);
  try {
    if (readdirSync(absRoot).some((name) => matchesManifest(name, patterns))) {
      return 0;
    }
  } catch (_err) {
    return Number.POSITIVE_INFINITY;
  }
  const glob =
    patterns.length === 1 ? `**/${patterns[0]}` : `**/{${patterns.join(",")}}`;
  const files = getAllFiles(absRoot, glob, options);
  let depth = Number.POSITIVE_INFINITY;
  for (const f of files) {
    const rel = relative(absRoot, dirname(resolve(f)));
    if (!rel || rel.startsWith("..")) {
      continue;
    }
    depth = Math.min(depth, rel.split(sep).length);
  }
  return depth;
}

/**
 * Order parent candidates by the depth of their ecosystem's manifests under
 * the scan roots (the shallowest first). The sort is stable, so candidates of
 * equal depth keep the order the ecosystems were scanned in.
 *
 * @param {Object[]} candidates Detected parent components, in scan order
 * @param {string[]} roots Scan roots
 * @param {Object} options CLI options
 * @returns {Object[]} The candidates, reordered
 */
export function orderParentCandidates(candidates, roots, options = {}) {
  const depthByType = new Map();
  const depthOf = (component) => {
    const type = purlTypeOf(component);
    if (!type) {
      return Number.POSITIVE_INFINITY;
    }
    if (!depthByType.has(type)) {
      depthByType.set(
        type,
        Math.min(
          Number.POSITIVE_INFINITY,
          ...(roots || []).map((r) => manifestDepth(r, type, options)),
        ),
      );
    }
    return depthByType.get(type);
  };
  return candidates
    .map((component, index) => ({
      component,
      index,
      depth: depthOf(component),
    }))
    .sort((a, b) => a.depth - b.depth || a.index - b.index)
    .map((c) => c.component);
}
