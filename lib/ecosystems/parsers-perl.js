import { readFileSync } from "node:fs";

import { tryBuildPurl } from "../inventory/purl.js";

/**
 * Perl parser for `cpanfile` and `cpanfile.snapshot`.
 *
 * Carton snapshots the resolved install set as a text document: one entry per
 * distribution, each carrying the `pathname` it was fetched from (which
 * encodes the PAUSE author id), the packages it provides, and the
 * requirements it was resolved against. The declared `cpanfile` lists the
 * project's own requirements.
 *
 * Distributions are identified with the registered `cpan` purl type, whose
 * rules require the author id as the namespace
 * (`pkg:cpan/<AUTHOR>/<Distribution>@<version>`).
 */

/**
 * Parse a `cpanfile.snapshot` into distributions with a dependency graph.
 *
 * @param {string} snapshotFile Path to `cpanfile.snapshot`
 * @param {string} [cpanfileFile] Path to `cpanfile`, if present
 * @returns {{ pkgList: object[], dependencies: object[] }}
 */
export function parseCpanSnapshot(snapshotFile, cpanfileFile) {
  let text;
  try {
    text = readFileSync(snapshotFile, "utf-8");
  } catch (error) {
    console.warn(`Failed to read ${snapshotFile}: ${error.message}`);
    return { pkgList: [], dependencies: [] };
  }

  const distributions = [];
  let current;
  let section;
  for (const rawLine of text.split("\n")) {
    if (!rawLine.trim() || rawLine.trim().startsWith("#")) {
      continue;
    }
    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trim();
    if (indent === 0) {
      // Top-level headers separate the snapshot sections.
      current = undefined;
      section = line === "DISTRIBUTIONS" ? "distributions" : undefined;
      continue;
    }
    if (line.startsWith("DISTRIBUTIONS")) {
      section = "distributions";
      continue;
    }
    if (section !== "distributions") {
      continue;
    }
    // A distribution line is indented by two spaces and carries
    // `<Name>-<version>`; its details follow indented deeper.
    if (indent === 2) {
      const dist = parseDistributionLine(line);
      if (dist) {
        distributions.push(dist);
        current = dist;
      }
      continue;
    }
    if (!current) {
      continue;
    }
    if (line.startsWith("pathname:")) {
      current.author = authorFromPathname(
        line.slice("pathname:".length).trim(),
      );
      continue;
    }
    if (line.startsWith("provides:")) {
      current.inProvides = true;
      current.inRequirements = false;
      continue;
    }
    if (line.startsWith("requirements:")) {
      current.inRequirements = true;
      current.inProvides = false;
      continue;
    }
    // Deeper indented `key value` lines under provides/requirements.
    const pair = line.match(/^([A-Za-z0-9_:.-]+)\s+(\S+)$/u);
    if (pair) {
      if (current.inProvides) {
        current.provides.set(pair[1], pair[2]);
      } else if (current.inRequirements) {
        current.requirements.push(pair[1]);
      }
    }
  }

  const directNames = cpanfileFile
    ? directRequirementsFromCpanfile(cpanfileFile)
    : new Set();

  // Map every provided package name to its distribution so requirements can
  // be resolved to edges between distributions.
  const distByPackage = new Map();
  for (const dist of distributions) {
    for (const provided of dist.provides.keys()) {
      if (!distByPackage.has(provided)) {
        distByPackage.set(provided, dist);
      }
    }
  }

  const pkgList = [];
  const refByDist = new Map();
  for (const dist of distributions) {
    const name = dist.name;
    const version = dist.version;
    const direct =
      directNames.size === 0
        ? true
        : [...dist.provides.keys()].some((pkg) => directNames.has(pkg));
    const pkg = cpanPackage(name, version, dist.author, {
      direct,
      srcFile: snapshotFile,
    });
    pkgList.push(pkg);
    refByDist.set(dist, pkg["bom-ref"]);
  }

  const dependencies = [];
  for (const dist of distributions) {
    const ref = refByDist.get(dist);
    const dependsOn = new Set();
    for (const requirement of dist.requirements) {
      const target = distByPackage.get(requirement);
      if (target && target !== dist) {
        const targetRef = refByDist.get(target);
        if (targetRef) {
          dependsOn.add(targetRef);
        }
      }
    }
    dependencies.push({ ref, dependsOn: [...dependsOn].sort() });
  }
  return { pkgList, dependencies };
}

/**
 * Parse a `Name-Version` distribution line.
 *
 * @param {string} line Trimmed distribution line
 * @param {string} srcFile Source path for provenance
 * @returns {object|undefined} Distribution accumulator
 */
function parseDistributionLine(line) {
  // Neither group can match a space, so a line holding one is never a
  // distribution. Refusing it first keeps the match linear: left to the
  // pattern, every `-<digit>` is tried as the end of the name and each try
  // rescans the rest of the line up to the space.
  if (line.includes(" ")) {
    return undefined;
  }
  const match = line.match(/^([A-Za-z0-9_.-]+?)-(\d[^ ]*)$/u);
  if (!match) {
    return undefined;
  }
  return {
    name: match[1],
    version: match[2],
    author: undefined,
    provides: new Map(),
    requirements: [],
    inProvides: false,
    inRequirements: false,
  };
}

/**
 * Extract the PAUSE author id from a CPAN pathname.
 *
 * Pathnames look like `M/MI/MIYAGAWA/Plack-1.0051.tar.gz`; the author id is
 * the third segment.
 *
 * @param {string} pathname CPAN pathname
 * @returns {string|undefined} Author id
 */
function authorFromPathname(pathname) {
  const segments = pathname.split("/").filter(Boolean);
  return segments.length >= 3 ? segments[2] : undefined;
}

/**
 * Build a component-like package record for a CPAN distribution.
 *
 * @param {string} name Distribution name
 * @param {string|undefined} version Distribution version
 * @param {string|undefined} author PAUSE author id
 * @param {object} opts Extra context (`direct`, `srcFile`)
 * @returns {object} Package record
 */
function cpanPackage(name, version, author, opts) {
  // The cpan purl type requires the author namespace; without it the purl is
  // dropped rather than emitted without its identity anchor.
  const purl = author
    ? tryBuildPurl({
        type: "cpan",
        namespace: author,
        name,
        version: version || undefined,
      })
    : null;
  const properties = [
    { name: "internal:SrcFile", value: opts.srcFile },
    {
      name: "cdx:cpan:dependency",
      value: opts.direct ? "direct" : "transitive",
    },
  ];
  const pkg = {
    name,
    ...(version ? { version } : {}),
    type: "library",
    scope: "required",
    properties,
  };
  if (purl) {
    pkg.purl = purl;
    pkg["bom-ref"] = decodeURIComponent(purl);
  } else {
    pkg["bom-ref"] = `library:${name}:${version || ""}`;
  }
  return pkg;
}

/**
 * Collect the requirement names declared in a `cpanfile`.
 *
 * Only the `requires` keyword outside phase blocks is read; phases such as
 * `on 'test'` are ignored so test-only modules do not become direct
 * dependencies.
 *
 * @param {string} cpanfileFile Path to `cpanfile`
 * @returns {Set<string>} Declared requirement names
 */
export function directRequirementsFromCpanfile(cpanfileFile) {
  const names = new Set();
  let text;
  try {
    text = readFileSync(cpanfileFile, "utf-8");
  } catch (error) {
    console.warn(`Failed to read ${cpanfileFile}: ${error.message}`);
    return names;
  }
  let inPhaseBlock = false;
  let blockDepth = 0;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    if (inPhaseBlock) {
      for (const char of line) {
        if (char === "{") {
          blockDepth += 1;
        } else if (char === "}") {
          blockDepth -= 1;
          if (blockDepth === 0) {
            inPhaseBlock = false;
          }
        }
      }
      continue;
    }
    if (/^on\s+['"]/.test(line) && line.includes("sub")) {
      inPhaseBlock = true;
      blockDepth = line.includes("{") ? 1 : 0;
      continue;
    }
    const requires = line.match(/^requires\s+['"]([^'"]+)['"]/u);
    if (requires) {
      names.add(requires[1]);
    }
  }
  return names;
}
