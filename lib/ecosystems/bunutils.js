import { readFileSync } from "node:fs";
import { dirname } from "node:path";

import { build } from "@cdxgen/cdx-purl";

import { DEBUG_MODE } from "../core/activity.js";
import { shouldFetchPackageMetadata } from "../core/env.js";
import { safeExistsSync } from "../core/fs.js";
import { getNpmMetadata } from "./ecosystems.js";
import {
  buildNpmGitDistributionIntakeRefs,
  buildNpmGitPurlQualifiers,
  buildNpmRegistryTarballUrl,
  classifyNpmManifestSource,
  loadNpmrcConfig,
  normalizeNpmRegistryUrl,
  setNpmDevelopmentProperty,
  setNpmOptionalProperty,
  setNpmPeerProperty,
} from "./npmutils.js";

const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org/";

// The dependency groups bun writes for a package or workspace, with the kind
// of edge each one declares.
const DEPENDENCY_GROUP_KINDS = [
  ["dependencies", "dependency"],
  ["optionalDependencies", "optional"],
  ["peerDependencies", "peer"],
  ["devDependencies", "dev"],
];

/**
 * Split a bun.lock package descriptor (eg `@babel/parser@7.29.7`,
 * `left-pad@1.3.0` or `foo@git+https://github.com/foo/bar#abcdef`) into its
 * group, name and version/specifier components.
 *
 * @param {string} descriptor The `name@specifier` descriptor string.
 * @returns {{group: string, name: string, version: string}} Parsed pieces. The
 *   version is returned verbatim, so non-registry specifiers (git/tarball URLs)
 *   are preserved for the caller to handle.
 */
export function parseBunDescriptor(descriptor) {
  // The name may itself start with `@` (scoped package), so look for the `@`
  // that separates name from specifier, i.e. the first one not at index 0.
  const atIndex = descriptor.indexOf("@", 1);
  let fullName = descriptor;
  let version = "";
  if (atIndex > 0) {
    fullName = descriptor.substring(0, atIndex);
    version = descriptor.substring(atIndex + 1);
  }
  let group = "";
  let name = fullName;
  if (fullName.startsWith("@")) {
    const slashIndex = fullName.indexOf("/");
    if (slashIndex > 0) {
      group = fullName.substring(0, slashIndex);
      name = fullName.substring(slashIndex + 1);
    }
  }
  return { group, name, version };
}

/**
 * Split a bun.lock package key into its package-name segments. A key is the
 * dependency path bun nested the package under (eg `@isaacs/cliui/wrap-ansi`),
 * where every segment is a package name, so scoped names (`@scope/name`)
 * count as a single segment despite containing `/`.
 *
 * @param {string} key The lockfile package key.
 * @returns {string[]} The package names composing the key.
 */
function keySegments(key) {
  const parts = key.split("/");
  const segments = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].startsWith("@") && i + 1 < parts.length) {
      segments.push(`${parts[i]}/${parts[i + 1]}`);
      i++;
    } else {
      segments.push(parts[i]);
    }
  }
  return segments;
}

/**
 * Determine whether a bun version specifier points at a non-registry source
 * (git, tarball URL, workspace or local path).
 *
 * Bun writes a local tarball as a bare path (`localdep@./localdep.tgz`) rather
 * than a `file:` specifier, so relative and absolute paths count too.
 *
 * @param {string} version The specifier extracted from the descriptor.
 * @returns {boolean} True when the specifier is not a plain semver version.
 */
function isNonRegistrySpecifier(version) {
  if (!version) {
    return false;
  }
  return (
    version.startsWith("./") ||
    version.startsWith("../") ||
    version.startsWith("/") ||
    version.startsWith("git") ||
    version.includes("://") ||
    version.startsWith("github:") ||
    version.startsWith("gitlab:") ||
    version.startsWith("bitbucket:") ||
    version.startsWith("workspace:") ||
    version.startsWith("file:") ||
    version.startsWith("link:")
  );
}

/**
 * Normalize a lockfile `os`/`cpu` value. Bun writes a single string for the
 * common one-value case (eg `"darwin"`), a negated string (eg `"!linux"`), an
 * array for several values and the string `"none"` when the manifest named no
 * platform bun recognizes (eg `cpu: ["wasm32"]`), which carries no usable
 * value, so both shapes have to be handled (see `Negatable.toJson` in bun's
 * npm.zig, `Negatable::to_json` in the Rust port).
 *
 * @param {string|string[]} value The raw `os`/`cpu` metadata value.
 * @returns {string|undefined} Comma-joined value, or undefined when absent.
 */
function normalizeOsCpu(value) {
  if (Array.isArray(value)) {
    return value.length ? value.join(", ") : undefined;
  }
  if (typeof value === "string" && value.length && value !== "none") {
    return value;
  }
  return undefined;
}

/**
 * Parse a bun text lockfile (`bun.lock`, lockfileVersion 1-3; v1 was written
 * by the Zig implementation in bun 1.2.x-1.3.x and v2/v3 by the Rust one in
 * bun 1.4+ - the content shape is identical, only parse strictness changed).
 *
 * Bun's text lockfile is JSONC (JSON with trailing commas). It records the
 * workspace roots under `workspaces` and the fully resolved dependency tree
 * under `packages`, where nested duplicate versions are keyed by their
 * dependency path (eg `"parent/child"`). The entry layout after the leading
 * `"name@version"` descriptor depends on the resolution type (see the
 * Stringifier in bun's bun.lock.rs):
 * - npm: `["name@version", tarballUrlOrEmpty, { dependencies, bin, os, ... }, "sha512-..."]`
 * - git/github: `["name@git+repo", { ... }, ".bun-tag", "sha512-..."]`
 * - tarball/folder/symlink: `["name@url", { ... }, "sha512-..."]`
 * - workspace: `["name@workspace:path"]`
 * so the elements are recognised by shape instead of fixed indices.
 *
 * The binary lockfile (`bun.lockb`) is intentionally not supported - callers
 * should ask users to regenerate it with `bun install --save-text-lockfile`.
 *
 * @param {string} bunLockFile Path to the bun.lock file.
 * @param {Object} [options] Parsing options (`parentComponent`).
 * @returns {Promise<{pkgList: Array, dependenciesList: Array}>} Parsed packages
 *   and dependency graph, matching the shape of the other lockfile parsers.
 */
export async function parseBunLock(bunLockFile, options = {}) {
  let pkgList = [];
  const dependenciesList = [];
  if (!safeExistsSync(bunLockFile)) {
    return { pkgList, dependenciesList };
  }
  const npmrcConfig = loadNpmrcConfig(
    options.projectRoot || dirname(bunLockFile),
  );
  const defaultRegistry =
    normalizeNpmRegistryUrl(npmrcConfig.registry) || DEFAULT_NPM_REGISTRY;
  const rawData = readFileSync(bunLockFile, "utf8");
  let lockData;
  try {
    // Strip JSONC trailing commas (bun.lock does not use comments) before
    // parsing. Package names, versions and integrity hashes never contain the
    // `,}`/`,]` sequences this targets, so the replacement is safe.
    const jsonText = rawData.replace(/,(\s*[}\]])/g, "$1");
    lockData = JSON.parse(jsonText);
  } catch (err) {
    if (DEBUG_MODE) {
      console.log(`Unable to parse ${bunLockFile}`, err);
    }
    return { pkgList, dependenciesList };
  }
  const packages = lockData.packages || {};
  const workspaces = lockData.workspaces || {};

  // First pass: build per-key metadata and purl/bom-ref lookups. Bun keys
  // nested duplicate versions by dependency path (eg `parent/child`), which we
  // handle per-lookup in resolveDepRef below.
  const infoForKey = new Map();
  for (const [key, entry] of Object.entries(packages)) {
    if (!Array.isArray(entry) || !entry.length) {
      continue;
    }
    const descriptor = entry[0];
    if (typeof descriptor !== "string") {
      continue;
    }
    const { group, name, version } = parseBunDescriptor(descriptor);
    if (!name || !version || version === "root:") {
      continue;
    }
    const isWorkspaceDep = version.startsWith("workspace:");
    const isGitDep =
      version.startsWith("git") ||
      version.startsWith("github:") ||
      version.startsWith("gitlab:") ||
      version.startsWith("bitbucket:");
    const isNonRegistry = isGitDep || isNonRegistrySpecifier(version);
    // The elements after the descriptor depend on the resolution type, so
    // recognise them by shape: the metadata object, the integrity hash and,
    // for npm packages on a custom registry, the tarball URL. The git
    // `.bun-tag` string is not needed.
    let meta = {};
    let integrity;
    let tarballUrl;
    let sawMeta = false;
    for (const el of entry.slice(1)) {
      if (el && typeof el === "object" && !Array.isArray(el)) {
        if (!sawMeta) {
          meta = el;
          sawMeta = true;
        }
      } else if (typeof el === "string" && el.length) {
        if (/^sha\d+-/.test(el)) {
          integrity = integrity || el;
        } else if (!isNonRegistry) {
          tarballUrl = tarballUrl || el;
        }
      }
    }
    // Workspace members point back at their manifest via `workspace:<path>`;
    // use the version declared there for the component identity.
    let componentVersion = version;
    if (isWorkspaceDep) {
      const wsEntry = workspaces[version.slice("workspace:".length)];
      componentVersion = wsEntry?.version || null;
    }
    let qualifiers = null;
    if (isGitDep) {
      qualifiers = buildNpmGitPurlQualifiers(version, group, npmrcConfig);
    } else if (isNonRegistry && !isWorkspaceDep) {
      qualifiers = { download_url: version };
    }
    const purlString = build({
      type: "npm",
      namespace: group || null,
      name: name,
      version: componentVersion,
      qualifiers: qualifiers || null,
    });
    const bomRef = decodeURIComponent(purlString);
    infoForKey.set(key, {
      group,
      name,
      version,
      componentVersion,
      registry: tarballUrl || "",
      meta,
      integrity,
      purlString,
      bomRef,
      isGitDep,
      isWorkspaceDep,
      isNonRegistry,
    });
  }

  // Resolve a dependency name referenced from `parentKey` to the bom-ref of
  // the concrete package bun installed for it. Bun walks up the parent's key
  // one package segment at a time (eg for `a/@scope/b/c` it tries
  // `a/@scope/b/c/<dep>`, `a/@scope/b/<dep>`, `a/<dep>`, then `<dep>`) and
  // uses the first entry it finds, so a version nested at an intermediate
  // level must win over the top-level one.
  const resolveDepRef = (parentKey, depName) => {
    const segments = parentKey ? keySegments(parentKey) : [];
    for (let i = segments.length; i >= 0; i--) {
      const key = [...segments.slice(0, i), depName].join("/");
      if (infoForKey.has(key)) {
        return infoForKey.get(key).bomRef;
      }
    }
    return undefined;
  };

  // Resolve the dependency groups an entry declares to the packages bun
  // installed for them, tagging each edge with how it was declared. A name
  // listed in `optionalPeers` is an optional peer: bun binds it to a package
  // some other edge installed, but never installs one for it. Registry
  // packages never carry devDependencies (bun does not install them), while
  // workspaces and `file:` folders do.
  const addEdges = (edges, parentKey, meta) => {
    const optionalPeers = new Set(
      Array.isArray(meta.optionalPeers) ? meta.optionalPeers : [],
    );
    for (const [group, kind] of DEPENDENCY_GROUP_KINDS) {
      for (const depName of Object.keys(meta[group] || {})) {
        const ref = resolveDepRef(parentKey, depName);
        if (!ref) {
          continue;
        }
        const edgeKind =
          kind === "peer" && optionalPeers.has(depName) ? "optionalPeer" : kind;
        if (!edges.has(ref)) {
          edges.set(ref, new Set());
        }
        edges.get(ref).add(edgeKind);
      }
    }
  };

  // Collect the edges of every package, unioned per bom-ref since the same
  // version can be nested under several keys (or aliases). A workspace
  // member's own entry has no metadata: its dependencies come from its
  // `workspaces` entry and resolve under the member's package name (bun nests
  // a member's own versions there, eg `pkg-a/strip-ansi`). Bun marks each
  // copy installed from a parent's bundleDependencies, so a version counts as
  // bundled only when no copy of it was installed on its own.
  const edgesByRef = new Map();
  const memberRefs = new Set();
  const bundledRefs = new Set();
  const unbundledRefs = new Set();
  for (const [key, info] of infoForKey.entries()) {
    if (!edgesByRef.has(info.bomRef)) {
      edgesByRef.set(info.bomRef, new Map());
    }
    if (info.meta.bundled === true) {
      bundledRefs.add(info.bomRef);
    } else {
      unbundledRefs.add(info.bomRef);
    }
    const edges = edgesByRef.get(info.bomRef);
    if (info.isWorkspaceDep) {
      memberRefs.add(info.bomRef);
      const wsEntry = workspaces[info.version.slice("workspace:".length)];
      if (wsEntry) {
        const fullName = info.group ? `${info.group}/${info.name}` : info.name;
        addEdges(edges, wsEntry.name || fullName, wsEntry);
      }
    } else {
      addEdges(edges, key, info.meta);
    }
  }
  // The root resolves at the top level. Bun makes every workspace member a
  // dependency of the root, whether or not the root declares it.
  const rootEdges = new Map();
  if (workspaces[""]) {
    addEdges(rootEdges, "", workspaces[""]);
  }
  for (const ref of memberRefs) {
    if (!rootEdges.has(ref)) {
      rootEdges.set(ref, new Set());
    }
    rootEdges.get(ref).add("workspace");
  }

  // Walk the graph from the root following only the given edge kinds.
  const reachableVia = (kinds) => {
    const seen = new Set();
    const stack = [];
    const visit = (edges) => {
      for (const [ref, edgeKinds] of edges) {
        if (seen.has(ref)) {
          continue;
        }
        for (const kind of edgeKinds) {
          if (kinds.includes(kind)) {
            seen.add(ref);
            stack.push(ref);
            break;
          }
        }
      }
    };
    visit(rootEdges);
    while (stack.length) {
      visit(edgesByRef.get(stack.pop()));
    }
    return seen;
  };
  // Like npm's dev/optional/peer flags, a package is development-only,
  // optional or peer-only when every path from the root reaches it through
  // that kind of edge. Production follows required peers (bun auto-installs
  // them) but not optional peers, which never install anything themselves.
  const installedRefs = reachableVia([
    "dependency",
    "optional",
    "peer",
    "optionalPeer",
    "dev",
    "workspace",
  ]);
  const prodRefs = reachableVia([
    "dependency",
    "optional",
    "peer",
    "workspace",
  ]);
  const nonOptionalRefs = reachableVia([
    "dependency",
    "peer",
    "dev",
    "workspace",
  ]);
  const nonPeerRefs = reachableVia([
    "dependency",
    "optional",
    "dev",
    "workspace",
  ]);

  // Second pass: emit the package list and dependency graph.
  const seenRefs = new Set();
  for (const info of infoForKey.values()) {
    if (seenRefs.has(info.bomRef)) {
      continue;
    }
    seenRefs.add(info.bomRef);
    const {
      group,
      name,
      version,
      componentVersion,
      registry,
      meta,
      integrity,
      purlString,
    } = info;
    const properties = [{ name: "internal:SrcFile", value: bunLockFile }];
    const externalReferences = [];

    // Resolve the distribution (tarball) URL. Bun leaves the registry field
    // empty for the default npm registry, so synthesise the tarball URL in
    // that case; otherwise use the recorded resolution.
    let resolvedUrl;
    if (registry && typeof registry === "string" && registry.length) {
      resolvedUrl = registry;
    } else if (!info.isNonRegistry) {
      resolvedUrl = buildNpmRegistryTarballUrl(
        defaultRegistry,
        group,
        name,
        componentVersion,
      );
    }
    if (resolvedUrl) {
      properties.push({ name: "internal:ResolvedUrl", value: resolvedUrl });
      externalReferences.push({ type: "distribution", url: resolvedUrl });
    }
    if (info.isGitDep) {
      const gitIntakeRefs = buildNpmGitDistributionIntakeRefs(
        group,
        name,
        version,
        npmrcConfig,
      );
      if (gitIntakeRefs) {
        externalReferences.push(...gitIntakeRefs);
      }
      const manifestSource = classifyNpmManifestSource(version);
      if (manifestSource) {
        properties.push({
          name: "cdx:npm:manifestSourceType",
          value: manifestSource.type,
        });
        properties.push({
          name: "cdx:npm:manifestSource",
          value: manifestSource.value,
        });
      }
    }
    if (info.isNonRegistry) {
      properties.push({ name: "cdx:npm:isRegistryDependency", value: "false" });
    }
    if (info.isWorkspaceDep) {
      properties.push({ name: "cdx:npm:isWorkspace", value: "true" });
    }
    // npm lockfiles record the same bundleDependencies marker as `inBundle`.
    if (bundledRefs.has(info.bomRef) && !unbundledRefs.has(info.bomRef)) {
      properties.push({ name: "cdx:npm:inBundle", value: "true" });
    }
    if (meta.bin) {
      const binValue =
        typeof meta.bin === "object"
          ? Object.keys(meta.bin).join(", ")
          : meta.bin;
      properties.push({ name: "cdx:npm:bin", value: binValue });
      properties.push({ name: "cdx:npm:has_binary", value: "true" });
    }
    const osValue = normalizeOsCpu(meta.os);
    if (osValue) {
      properties.push({ name: "cdx:npm:os", value: osValue });
    }
    const cpuValue = normalizeOsCpu(meta.cpu);
    if (cpuValue) {
      properties.push({ name: "cdx:npm:cpu", value: cpuValue });
    }

    const pkgObj = {
      group: group || "",
      name,
      version: componentVersion ?? undefined,
      purl: purlString,
      "bom-ref": info.bomRef,
      _integrity: integrity || undefined,
      properties,
      evidence: {
        identity: {
          field: "purl",
          confidence: 1,
          methods: [
            {
              technique: "manifest-analysis",
              confidence: 1,
              value: bunLockFile,
            },
          ],
        },
      },
    };
    if (externalReferences.length) {
      pkgObj.externalReferences = externalReferences;
    }
    // Packages that are not reachable through production dependencies are
    // development-only tooling.
    const ref = info.bomRef;
    if (!prodRefs.has(ref)) {
      pkgObj.scope = "optional";
      setNpmDevelopmentProperty(pkgObj);
    }
    if (installedRefs.has(ref) && !nonOptionalRefs.has(ref)) {
      pkgObj.scope = "optional";
      setNpmOptionalProperty(pkgObj);
    }
    if (installedRefs.has(ref) && !nonPeerRefs.has(ref)) {
      setNpmPeerProperty(pkgObj);
    }
    pkgList.push(pkgObj);
    dependenciesList.push({
      ref,
      dependsOn: [...edgesByRef.get(ref).keys()].sort(),
    });
  }

  // Add the dependency entry for the workspace root.
  if (options.parentComponent?.["bom-ref"]) {
    dependenciesList.push({
      ref: options.parentComponent["bom-ref"],
      dependsOn: [...rootEdges.keys()].sort(),
    });
  }

  // The shared metadata gate: FETCH_LICENSE and the provenance fetch that
  // --bom-audit turns on both reach the registry from here.
  if (shouldFetchPackageMetadata()) {
    if (DEBUG_MODE) {
      console.log(
        `About to fetch npm registry metadata for ${pkgList.length} packages in parseBunLock`,
      );
    }
    pkgList = await getNpmMetadata(pkgList);
  }
  return { pkgList, dependenciesList };
}
