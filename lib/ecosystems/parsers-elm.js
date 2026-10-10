import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";

import semver from "semver";

import { DEBUG_MODE, readEnvironmentVariable } from "../core/activity.js";
import { safeExistsSync } from "../core/fs.js";
import {
  gatedGet,
  prefetchEnabled,
  prefetchedResponse,
  prefetchJson,
} from "../inventory/fetchBatch.js";
import { tryBuildPurl } from "../inventory/purl.js";

/**
 * Elm project parser.
 *
 * Three files are consulted, spanning the two manifest generations of the
 * ecosystem:
 *
 *   - `elm.json` (0.19) — `type: "application"` projects pin **exact**
 *     versions for direct, indirect, and test dependencies, so the file
 *     doubles as the lock file. `type: "package"` projects declare bounded
 *     ranges (`"1.0.0 <= v < 2.0.0"`) and carry their own name, version,
 *     license, and summary.
 *   - `elm-package.json` (0.18) — the legacy manifest, declaring ranges only.
 *   - `elm-stuff/exact-dependencies.json` (0.18) — the lock file the old
 *     `elm-package` tool wrote with the exact version of every package.
 *
 * Package metadata (license, summary, and the dependencies of a dependency)
 * is enriched from the local Elm cache when it is populated. The cache layout
 * follows the compiler's own resolution (see `builder/src/Stuff.hs` in
 * elm/compiler): `$ELM_HOME` (defaulting to `~/.elm`, or `%APPDATA%\elm` on
 * Windows) contains one directory per compiler version, and each downloaded
 * package lives at `<version>/packages/<author>/<project>/<version>/elm.json`.
 * Parsing itself never reaches the network; {@link getElmMetadata} fills the
 * gaps an empty cache leaves from the registry, and only when the run has
 * asked for registry metadata.
 *
 * No `elm` purl type is registered in purl-spec, so packages are identified
 * as generic packages carrying a `cdx:purl:proposedType=elm` property,
 * following the convention used for crystal and nim. The `author/project`
 * name maps to the purl namespace and the CycloneDX group so the full
 * identity survives.
 */

/**
 * One path segment of an Elm package name (`author` or `project`). Names are
 * GitHub `user/repo` pairs; the shape check doubles as path-traversal
 * protection because segments are joined into cache paths.
 */
const ELM_NAME_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The bounded-interval constraint syntax Elm uses in manifests:
 * `"<lower> <= v < <upper>"`.
 */
const ELM_RANGE_PATTERN = /^(\S+)\s*(<=|<)\s*v\s*(<=|<)\s*(\S+)$/;

/**
 * Parse an Elm project from its 0.19 `elm.json`.
 *
 * @param {string} elmJsonFile Path to `elm.json`
 * @param {object} [cacheReader] Reader returned by {@link createElmCacheReader};
 *   when omitted, one is derived from the manifest's pinned compiler version
 * @returns {{ pkgList: object[], dependencies: object[], parentComponent: object, rootInputs: string[] }}
 */
export function parseElmProject(elmJsonFile, cacheReader) {
  const manifest = readJsonFile(elmJsonFile);
  if (
    !manifest ||
    (manifest.type !== "application" && manifest.type !== "package")
  ) {
    return {
      pkgList: [],
      dependencies: [],
      parentComponent: {},
      rootInputs: [],
    };
  }

  const elmVersion =
    typeof manifest["elm-version"] === "string"
      ? manifest["elm-version"]
      : undefined;
  const cache =
    cacheReader ||
    createElmCacheReader(
      manifest.type === "application" && semver.valid(elmVersion)
        ? elmVersion
        : undefined,
    );

  const parentComponent = {};
  const properties = [{ name: "internal:SrcFile", value: elmJsonFile }];
  if (elmVersion) {
    properties.push({ name: "cdx:elm:elmVersion", value: elmVersion });
  }
  if (manifest.type === "package") {
    const split = splitElmName(manifest.name);
    parentComponent.type = "application";
    if (split) {
      parentComponent.group = split.author;
      parentComponent.name = split.repo;
    } else {
      parentComponent.name = projectDirectoryName(elmJsonFile);
    }
    if (typeof manifest.version === "string" && manifest.version) {
      parentComponent.version = manifest.version;
    }
    if (typeof manifest.summary === "string" && manifest.summary) {
      parentComponent.description = manifest.summary;
    }
    if (typeof manifest.license === "string" && manifest.license) {
      parentComponent.license = manifest.license;
    }
  } else {
    // Applications carry no name of their own; the directory stands in.
    parentComponent.type = "application";
    parentComponent.name = projectDirectoryName(elmJsonFile);
  }
  parentComponent.properties = properties;

  const entries = [];
  if (manifest.type === "package") {
    addRangeDependencies(
      entries,
      manifest.dependencies,
      "direct",
      elmJsonFile,
      cache,
    );
    addRangeDependencies(
      entries,
      manifest["test-dependencies"],
      "direct-test",
      elmJsonFile,
      cache,
    );
  } else {
    for (const [section, kind] of [
      ["dependencies", "direct"],
      ["test-dependencies", "direct-test"],
    ]) {
      const group = manifest[section];
      addExactDependencies(entries, group?.direct, kind, elmJsonFile, cache);
      addExactDependencies(
        entries,
        group?.indirect,
        kind === "direct" ? "indirect" : "indirect-test",
        elmJsonFile,
        cache,
      );
    }
  }
  const pkgList = entries.map((entry) => entry.pkg);
  const rootInputs = entries
    .filter((entry) => entry.kind === "direct" || entry.kind === "direct-test")
    .map((entry) => entry.pkg["bom-ref"]);
  return {
    pkgList,
    dependencies: buildDependencyEdges(entries),
    parentComponent,
    rootInputs,
  };
}

/**
 * Parse a legacy 0.18 Elm project from `elm-package.json` and its optional
 * `elm-stuff/exact-dependencies.json` lock file.
 *
 * @param {string} elmPackageJsonFile Path to `elm-package.json`
 * @param {string} [exactDepsFile] Path to the lock file, if present
 * @returns {{ pkgList: object[], dependencies: object[], parentComponent: object, rootInputs: string[] }}
 */
export function parseLegacyElmProject(elmPackageJsonFile, exactDepsFile) {
  const manifest = readJsonFile(elmPackageJsonFile);
  if (
    !manifest ||
    typeof manifest !== "object" ||
    (!manifest["elm-version"] && !manifest.dependencies)
  ) {
    return {
      pkgList: [],
      dependencies: [],
      parentComponent: {},
      rootInputs: [],
    };
  }

  const parentComponent = {
    type: "application",
    name: projectDirectoryName(elmPackageJsonFile),
  };
  if (typeof manifest.version === "string" && manifest.version) {
    parentComponent.version = manifest.version;
  }
  if (typeof manifest.summary === "string" && manifest.summary) {
    parentComponent.description = manifest.summary;
  }
  if (typeof manifest.license === "string" && manifest.license) {
    parentComponent.license = manifest.license;
  }
  const properties = [{ name: "internal:SrcFile", value: elmPackageJsonFile }];
  if (typeof manifest["elm-version"] === "string" && manifest["elm-version"]) {
    properties.push({
      name: "cdx:elm:elmVersion",
      value: manifest["elm-version"],
    });
  }
  parentComponent.properties = properties;

  const declared = new Set(
    manifest.dependencies && typeof manifest.dependencies === "object"
      ? Object.keys(manifest.dependencies)
      : [],
  );
  const ranges =
    manifest.dependencies && typeof manifest.dependencies === "object"
      ? manifest.dependencies
      : {};

  const entries = [];
  const exact = exactDepsFile ? readJsonFile(exactDepsFile) : undefined;
  const pinned =
    exact && typeof exact === "object" && !Array.isArray(exact) ? exact : {};
  for (const [name, version] of Object.entries(pinned)) {
    const kind = declared.has(name) ? "direct" : "indirect";
    entries.push({
      kind,
      name,
      pkg: elmPackage(name, typeof version === "string" ? version : undefined, {
        dependency: kind,
        srcFile: exactDepsFile,
        versionRange:
          typeof ranges[name] === "string" ? ranges[name] : undefined,
      }),
    });
  }
  if (!entries.length) {
    // Lockless fallback: the declared dependencies without resolved versions.
    for (const [name, range] of Object.entries(ranges)) {
      entries.push({
        kind: "direct",
        name,
        pkg: elmPackage(name, undefined, {
          dependency: "direct",
          srcFile: elmPackageJsonFile,
          versionRange: typeof range === "string" ? range : undefined,
        }),
      });
    }
  }
  const rootInputs = entries
    .filter((entry) => entry.kind === "direct")
    .map((entry) => entry.pkg["bom-ref"]);
  return {
    pkgList: entries.map((entry) => entry.pkg),
    dependencies: buildDependencyEdges(entries),
    parentComponent,
    rootInputs,
  };
}

/**
 * Tell whether a candidate `elm.json` really is an Elm manifest. The file
 * name is distinctive but lives in every Elm project, so detection only
 * needs a cheap content check before dispatching.
 *
 * @param {string} filePath Path to the candidate `elm.json`
 * @returns {boolean} true when the file declares an Elm project
 */
export function isElmProjectFile(filePath) {
  const manifest = readJsonFile(filePath);
  return manifest?.type === "application" || manifest?.type === "package";
}

/**
 * Create a reader for the local Elm package cache. Reads are memoised and
 * silently disabled when the cache directory does not exist.
 *
 * @param {string} [elmVersionHint] Exact compiler version directory to try
 *   first, when the project pins one
 * @returns {{ readMetadata: (name: string, version: string) => object|null, listVersions: (name: string) => string[] }}
 */
export function createElmCacheReader(elmVersionHint) {
  const home = elmHomeDir();
  const metadataCache = new Map();
  const versionsCache = new Map();
  let versionDirs;

  function listVersionDirs() {
    if (versionDirs) {
      return versionDirs;
    }
    try {
      versionDirs = readdirSync(home)
        .filter((entry) => semver.valid(entry))
        .sort()
        .reverse();
    } catch {
      versionDirs = [];
    }
    return versionDirs;
  }

  function packageDir(name) {
    const split = splitElmName(name);
    return split
      ? { author: split.author, repo: split.repo, valid: true }
      : { valid: false };
  }

  return {
    readMetadata(name, version) {
      const key = `${name}@${version}`;
      if (metadataCache.has(key)) {
        return metadataCache.get(key);
      }
      let metadata = null;
      const dir = packageDir(name);
      if (dir.valid && semver.valid(version)) {
        const dirs =
          elmVersionHint && semver.valid(elmVersionHint)
            ? [
                elmVersionHint,
                ...listVersionDirs().filter((d) => d !== elmVersionHint),
              ]
            : listVersionDirs();
        for (const versionDir of dirs) {
          const metaFile = join(
            home,
            versionDir,
            "packages",
            dir.author,
            dir.repo,
            version,
            "elm.json",
          );
          if (safeExistsSync(metaFile)) {
            metadata = readJsonFile(metaFile);
            if (metadata) {
              break;
            }
          }
        }
      }
      metadataCache.set(key, metadata);
      return metadata;
    },
    listVersions(name) {
      if (versionsCache.has(name)) {
        return versionsCache.get(name);
      }
      const versions = new Set();
      const dir = packageDir(name);
      if (dir.valid) {
        for (const versionDir of listVersionDirs()) {
          try {
            for (const entry of readdirSync(
              join(home, versionDir, "packages", dir.author, dir.repo),
            )) {
              if (semver.valid(entry)) {
                versions.add(entry);
              }
            }
          } catch {
            // No cached copy under this compiler version.
          }
        }
      }
      const list = [...versions];
      versionsCache.set(name, list);
      return list;
    },
  };
}

/**
 * Resolve the Elm home directory the way the compiler does: `$ELM_HOME` when
 * set, otherwise the OS per-user data directory for "elm" (`~/.elm` on Unix,
 * `%APPDATA%\elm` on Windows).
 *
 * @returns {string} Elm home directory
 */
function elmHomeDir() {
  const custom = readEnvironmentVariable("ELM_HOME");
  if (custom) {
    return custom;
  }
  if (process.platform === "win32") {
    const appData =
      readEnvironmentVariable("APPDATA") ||
      join(homedir(), "AppData", "Roaming");
    return join(appData, "elm");
  }
  return join(homedir(), ".elm");
}

/**
 * Split an Elm package name into its author and project segments.
 *
 * @param {string} name Package name, e.g. `elm/http`
 * @returns {{author: string, repo: string}|null} null when the name is not a
 *   well-formed `author/project` pair
 */
function splitElmName(name) {
  if (typeof name !== "string") {
    return null;
  }
  const parts = name.split("/");
  if (parts.length !== 2 || !parts.every((p) => ELM_NAME_SEGMENT.test(p))) {
    return null;
  }
  return { author: parts[0], repo: parts[1] };
}

/**
 * Derive a project display name from the manifest's directory, used by
 * application manifests, which carry no name of their own.
 *
 * @param {string} manifestFile Manifest path
 * @returns {string} Directory base name
 */
function projectDirectoryName(manifestFile) {
  return basename(dirname(resolve(manifestFile)));
}

/**
 * Translate an Elm version constraint into semver range syntax. Only the
 * documented bounded interval (`"1.0.0 <= v < 2.0.0"`) is understood;
 * anything else is returned as null and treated as an opaque constraint.
 *
 * @param {string} range Constraint string from a manifest
 * @returns {string|null} Equivalent semver range, e.g. `">=1.0.0 <2.0.0"`
 */
function toSemverRange(range) {
  if (typeof range !== "string") {
    return null;
  }
  const match = range.match(ELM_RANGE_PATTERN);
  if (!match) {
    return null;
  }
  const [, lower, lowerOp, upperOp, upper] = match;
  // The grammar allows `<= v` lower bounds only; a `< v` lower bound would
  // exclude the very version the resolver needs, so treat it as opaque.
  if (lowerOp !== "<=" || !semver.valid(lower) || !semver.valid(upper)) {
    return null;
  }
  return `>=${lower} ${upperOp}${upper}`;
}

/**
 * Append the dependencies of one exact-version section of an application
 * `elm.json`, enriching each from the local cache when possible.
 *
 * @param {object[]} entries Accumulator of `{kind, name, pkg, metadata}` records
 */
function addExactDependencies(entries, section, kind, srcFile, cache) {
  if (!section || typeof section !== "object") {
    return;
  }
  for (const [name, version] of Object.entries(section)) {
    const exact = typeof version === "string" && version ? version : undefined;
    const metadata =
      cache && exact && semver.valid(exact) && splitElmName(name)
        ? cache.readMetadata(name, exact)
        : null;
    entries.push({
      kind,
      name,
      metadata,
      pkg: elmPackage(name, exact, {
        dependency: kind,
        srcFile,
        metadata,
      }),
    });
  }
}

/**
 * Append the dependencies of a range-constrained section of a package
 * `elm.json`. When the local Elm cache holds versions satisfying the declared
 * range, the newest of them — the one Elm's solver would pick — becomes the
 * component version; otherwise the component keeps only the constraint.
 *
 * @param {object[]} entries Accumulator of `{kind, name, pkg, metadata}` records
 */
function addRangeDependencies(entries, section, kind, srcFile, cache) {
  if (!section || typeof section !== "object") {
    return;
  }
  for (const [name, range] of Object.entries(section)) {
    let version;
    let metadata;
    const semverRange = toSemverRange(range);
    if (cache && semverRange && splitElmName(name)) {
      // Elm's solver picks the newest version within the constraints.
      version =
        semver.maxSatisfying(cache.listVersions(name), semverRange) ||
        undefined;
      if (version) {
        metadata = cache.readMetadata(name, version);
      }
    }
    entries.push({
      kind,
      name,
      metadata,
      pkg: elmPackage(name, version, {
        dependency: kind,
        srcFile,
        metadata,
        versionRange: typeof range === "string" ? range : undefined,
      }),
    });
  }
}

/**
 * Build the dependency graph for the packages of a single manifest.
 *
 * Elm manifests list the resolved set but not the edges between its members;
 * those live in each package's own cached `elm.json`, which the enrichment
 * pass has already read. Edges are therefore emitted only for packages found
 * in the local cache — every component still gets an entry, so none of them
 * is left dangling outside the graph.
 *
 * @param {object[]} entries `{kind, name, pkg, metadata}` records of one manifest
 * @returns {object[]} CycloneDX dependency entries
 */
function buildDependencyEdges(entries) {
  const refByName = new Map(
    entries.map((entry) => [entry.name, entry.pkg["bom-ref"]]),
  );
  return entries.map((entry) => {
    const declared = entry.metadata?.dependencies;
    const dependsOn =
      declared && typeof declared === "object" && !Array.isArray(declared)
        ? Object.keys(declared)
            .map((name) => refByName.get(name))
            .filter((ref) => ref && ref !== entry.pkg["bom-ref"])
        : [];
    return {
      ref: entry.pkg["bom-ref"],
      dependsOn: [...new Set(dependsOn)].sort(),
    };
  });
}

/**
 * Build a component-like package record for an Elm dependency.
 *
 * @param {string} name Package name as Elm writes it (`author/project`)
 * @param {string|undefined} version Resolved version, if known
 * @param {object} opts Extra context (`dependency`, `srcFile`, `metadata`, `versionRange`)
 * @returns {object} Package record
 */
function elmPackage(name, version, opts) {
  const split = splitElmName(name);
  const test =
    opts.dependency === "direct-test" || opts.dependency === "indirect-test";
  const purl = tryBuildPurl({
    type: "generic",
    namespace: split?.author,
    name: split?.repo ?? name,
    version: version || undefined,
  });
  const properties = [
    { name: "internal:SrcFile", value: opts.srcFile },
    { name: "cdx:purl:proposedType", value: "elm" },
    { name: "cdx:elm:dependency", value: opts.dependency },
  ];
  if (opts.versionRange) {
    properties.push({
      name: "cdx:elm:versionRange",
      value: opts.versionRange,
    });
  }
  const pkg = {
    name: split?.repo ?? name,
    group: split?.author,
    ...(version ? { version } : {}),
    type: "library",
    scope: test ? "optional" : "required",
    properties,
  };
  if (split) {
    // Both locations follow from the name alone: the registry only publishes
    // packages hosted on GitHub under the same `author/project` path, and
    // documents every version at a stable URL. The link is to the canonical
    // site rather than to whatever `ELM_PACKAGE_URL` points at, since a
    // mirror is where cdxgen read the metadata, not where a reader of the BOM
    // should be sent.
    pkg.repository = {
      url: `https://github.com/${split.author}/${split.repo}`,
    };
    pkg.homepage = {
      url: version
        ? `${ELM_REGISTRY_HOME}/packages/${split.author}/${split.repo}/${version}/`
        : `${ELM_REGISTRY_HOME}/packages/${split.author}/${split.repo}/`,
    };
  }
  if (typeof opts.metadata?.license === "string" && opts.metadata.license) {
    pkg.license = opts.metadata.license;
  }
  if (typeof opts.metadata?.summary === "string" && opts.metadata.summary) {
    pkg.description = opts.metadata.summary;
  }
  if (purl) {
    pkg.purl = purl;
    pkg["bom-ref"] = decodeURIComponent(purl);
  } else {
    pkg["bom-ref"] = `library:${name}:${version || ""}`;
  }
  return pkg;
}

/** The canonical package site, used for the documentation link of a package. */
const ELM_REGISTRY_HOME = "https://package.elm-lang.org";

/**
 * Base URL the registry documents are read from. `ELM_PACKAGE_URL` redirects
 * lookups at a mirror, matching the `PUB_DEV_URL`/`RUST_CRATES_URL` convention.
 *
 * @returns {string} Registry base URL without a trailing slash
 */
function elmRegistryUrl() {
  const custom = readEnvironmentVariable("ELM_PACKAGE_URL");
  return (custom || ELM_REGISTRY_HOME).replace(/\/+$/, "");
}

/**
 * Package path prefixes the registry's own `robots.txt` disallows for every
 * user-agent. They are the pre-0.19 packages, which the site keeps serving but
 * asks clients not to walk; a 0.18 project's dependencies fall entirely inside
 * this set, so its metadata comes from the local cache or not at all.
 */
const ROBOTS_DISALLOWED_PREFIXES = [
  "elm-lang/",
  "elm-tools/",
  "elm-community/elm-test/",
  "evancz/elm-html/",
  "evancz/elm-http/",
  "evancz/elm-svg/",
  "evancz/url-parser/",
  "evancz/virtual-dom/",
];

/**
 * Whether the registry's `robots.txt` permits fetching a package's documents.
 *
 * @param {string} name Package name, `author/project`
 * @returns {boolean} true when no `Disallow` rule covers the package
 */
export function isRegistryCrawlable(name) {
  const path = `${name}/`;
  return !ROBOTS_DISALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * Enrich Elm components from the package registry.
 *
 * Only the gaps left by the local cache are fetched, and only for packages
 * with a resolved version that `robots.txt` permits. Two documents are read
 * per package, both of which the compiler itself reads when it installs one:
 *
 *   - `elm.json` — the published manifest, carrying the summary, the license
 *     and the package's own dependencies, which close the gaps in the
 *     dependency graph that an unpopulated cache leaves behind.
 *   - `endpoint.json` — the source archive URL and the SHA-1 of its bytes,
 *     which the compiler verifies after downloading. It becomes the
 *     component's distribution reference and hash.
 *
 * Requests carry cdxgen's contact user-agent and pass through the shared
 * per-host rate policy for `package.elm-lang.org` (see `fetchRate.js`).
 *
 * @param {object[]} pkgList Components to enrich, mutated in place
 * @param {object[]} [dependencies] Dependency edges to complete in place
 * @returns {Promise<object[]>} The same package list
 */
export async function getElmMetadata(pkgList, dependencies) {
  const registry = elmRegistryUrl();
  // The two documents are asked for separately, each only when a field it
  // supplies is still missing after the local cache: the manifest carries
  // the licence, the summary and the package's own dependencies, the
  // endpoint the distribution URL and its hash. Neither carries
  // provenance, so a provenance fetch, as under --bom-audit, asks for
  // nothing more.
  const refsWithoutEdges = new Set(
    (dependencies || [])
      .filter((edge) => !edge.dependsOn?.length)
      .map((edge) => edge.ref),
  );
  const needsManifest = (pkg) =>
    !pkg.license || !pkg.description || refsWithoutEdges.has(pkg["bom-ref"]);
  const needsEndpoint = (pkg) => !pkg.distribution?.url || !pkg.hashes?.length;
  const targets = pkgList.filter(
    (pkg) =>
      pkg.group &&
      pkg.version &&
      semver.valid(pkg.version) &&
      splitElmName(`${pkg.group}/${pkg.name}`) &&
      isRegistryCrawlable(`${pkg.group}/${pkg.name}`) &&
      (needsManifest(pkg) || needsEndpoint(pkg)),
  );
  if (!targets.length) {
    return pkgList;
  }
  const manifestUrl = (pkg) =>
    `${registry}/packages/${pkg.group}/${pkg.name}/${pkg.version}/elm.json`;
  const endpointUrl = (pkg) =>
    `${registry}/packages/${pkg.group}/${pkg.name}/${pkg.version}/endpoint.json`;
  const prefetched = await prefetchJson(
    prefetchEnabled()
      ? targets
          .flatMap((pkg) => [
            needsManifest(pkg) ? { url: manifestUrl(pkg) } : undefined,
            needsEndpoint(pkg) ? { url: endpointUrl(pkg) } : undefined,
          ])
          .filter(Boolean)
      : [],
  );
  const manifests = new Map();
  for (const pkg of targets) {
    if (DEBUG_MODE) {
      console.log(`Querying ${registry} for ${pkg.group}/${pkg.name}`);
    }
    if (needsManifest(pkg)) {
      const manifest = await fetchJson(manifestUrl(pkg), prefetched);
      if (manifest) {
        manifests.set(pkg["bom-ref"], manifest);
        if (!pkg.license && typeof manifest.license === "string") {
          pkg.license = manifest.license;
        }
        if (!pkg.description && typeof manifest.summary === "string") {
          pkg.description = manifest.summary;
        }
      }
    }
    if (needsEndpoint(pkg)) {
      const endpoint = await fetchJson(endpointUrl(pkg), prefetched);
      if (typeof endpoint?.url === "string") {
        pkg.distribution = { url: endpoint.url };
      }
      if (/^[a-f0-9]{40}$/i.test(endpoint?.hash || "")) {
        // The compiler streams the archive and compares this digest against the
        // SHA-1 of the bytes it received, so it is a content hash of the
        // distribution rather than a revision identifier.
        pkg.hashes = [{ alg: "SHA-1", content: endpoint.hash.toLowerCase() }];
      }
    }
  }
  if (dependencies?.length && manifests.size) {
    completeDependencyEdges(dependencies, pkgList, manifests);
  }
  return pkgList;
}

/**
 * Fill in the edges of components the local cache could not describe, using
 * the manifests fetched from the registry. Edges already resolved from the
 * cache are left alone.
 *
 * @param {object[]} dependencies Dependency edges, mutated in place
 * @param {object[]} pkgList Components the edges may point at
 * @param {Map<string, object>} manifests Registry manifests by bom-ref
 */
function completeDependencyEdges(dependencies, pkgList, manifests) {
  const refByName = new Map(
    pkgList
      .filter((pkg) => pkg.group)
      .map((pkg) => [`${pkg.group}/${pkg.name}`, pkg["bom-ref"]]),
  );
  for (const edge of dependencies) {
    if (edge.dependsOn?.length) {
      continue;
    }
    const declared = manifests.get(edge.ref)?.dependencies;
    if (!declared || typeof declared !== "object" || Array.isArray(declared)) {
      continue;
    }
    edge.dependsOn = [
      ...new Set(
        Object.keys(declared)
          .map((name) => refByName.get(name))
          .filter((ref) => ref && ref !== edge.ref),
      ),
    ].sort();
  }
}

/**
 * Read one registry document, preferring the batched prefetch and falling back
 * to a direct request. A failure leaves the component as the manifests found
 * it rather than aborting the enrichment.
 *
 * @param {string} url Document URL
 * @param {Map} prefetched Batched results
 * @returns {Promise<object|undefined>} Parsed document
 */
async function fetchJson(url, prefetched) {
  try {
    const res =
      prefetchedResponse(prefetched, url) ||
      (await gatedGet(url, { responseType: "json" }));
    return res?.body;
  } catch (err) {
    if (DEBUG_MODE) {
      console.log(`Unable to fetch ${url}: ${err.message}`);
    }
    return undefined;
  }
}

/**
 * Read and parse a JSON file, warning instead of throwing on invalid input.
 *
 * @param {string} filePath File to read
 * @returns {object|undefined} Parsed value
 */
function readJsonFile(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch (error) {
    console.warn(`Failed to parse ${filePath}: ${error.message}`);
    return undefined;
  }
}
