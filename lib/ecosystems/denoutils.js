import { readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, dirname, join } from "node:path";

import { build } from "@cdxgen/cdx-purl";

// utils.js does not import denoutils.js, so importing from it here is safe and
// does not introduce a cyclic dependency.
import { DEBUG_MODE, readEnvironmentVariable } from "../core/activity.js";
import {
  shouldFetchPackageMetadata,
  shouldFetchRegistryProvenance,
} from "../core/env.js";
import { safeExistsSync } from "../core/fs.js";
import { registerRunReset } from "../core/runState.js";
import {
  gatedGet,
  prefetchEnabled,
  prefetchedResponse,
  prefetchJson,
} from "../inventory/fetchBatch.js";
import { getNpmMetadata } from "./ecosystems.js";
import {
  buildNpmRegistryTarballUrl,
  loadNpmrcConfig,
  normalizeNpmRegistryUrl,
  resolveNpmLicense,
} from "./npmutils.js";

const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org/";

// jsr's metadata API. Version endpoints expose the SPDX license and package
// endpoints expose the description + GitHub repository.
// Overridable for the same reason NPM_URL is: without it the jsr lookups cannot
// be covered offline, and a private jsr mirror cannot be pointed at.
const JSR_API_URL =
  readEnvironmentVariable("JSR_API_URL") || "https://api.jsr.io/";

// Small in-module response cache so repeated packages (or multiple lockfiles)
// don't re-fetch the same jsr metadata.
const jsrMetadataCache = new Map();
registerRunReset("jsr:documents", () => jsrMetadataCache.clear());

/**
 * purl decision for `jsr:` dependencies.
 *
 * JSR (https://jsr.io) does not have a ratified PackageURL type yet. JSR
 * publishes every package to a real npm scope, `@jsr/<owner>__<package>`, on
 * its npm mirror (npm.jsr.io), so a `jsr:@std/assert@1.0.19` import resolves
 * to the installable npm package `@jsr/std__assert@1.0.19`.
 *
 * We therefore map jsr deps to `pkg:npm/@jsr/<owner>__<name>@<version>`. This
 * keeps cdxgen aligned with the AppThreat vulnerability-DB / dep-scan lookups,
 * which index npm advisories, so jsr packages get vulnerability matching for
 * free without needing a dedicated VDB integration. The original jsr identity
 * is preserved in the `cdx:deno:jsrKey` property for traceability.
 */
const JSR_NPM_SCOPE = "@jsr";

// jsr publishes an npm-compatible mirror at npm.jsr.io. jsr packages are NOT
// available on registry.npmjs.org, so license/metadata lookups for the
// `@jsr/<owner>__<name>` components must target this registry instead.
const JSR_NPM_REGISTRY = "https://npm.jsr.io/";
const JSR_NPM_REGISTRY_HOST = "npm.jsr.io";

/**
 * Remove JSONC (JSON-with-comments) noise from a source string so it can be
 * parsed with `JSON.parse`. Handles `//` line comments, `/* block *​/`
 * comments and trailing commas, while leaving string literals untouched.
 *
 * Implemented as a small single-pass scanner rather than a regex, per the
 * cdxgen convention of avoiding hard-to-review/exponential regexes for
 * untrusted input.
 *
 * @param {string} text Raw JSONC source.
 * @returns {string} Plain JSON text.
 */
export function stripJsonc(text) {
  if (!text) {
    return text;
  }
  let out = "";
  let i = 0;
  const len = text.length;
  while (i < len) {
    const ch = text[i];
    const next = text[i + 1];
    // String literal (including escaped quotes) — copy verbatim.
    if (ch === '"') {
      out += ch;
      i++;
      while (i < len) {
        const c = text[i];
        out += c;
        if (c === "\\" && i + 1 < len) {
          out += text[i + 1];
          i += 2;
          continue;
        }
        if (c === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    // Line comment `// ...`
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < len && text[i] !== "\n") {
        i++;
      }
      continue;
    }
    // Block comment `/* ... */`
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < len && !(text[i] === "*" && text[i + 1] === "/")) {
        i++;
      }
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  // Strip trailing commas that JSONC allows before `}` or `]`. Safe because
  // `,}` / `,]` never appear inside string literals after comment stripping.
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/**
 * Parse a JSON or JSONC file (deno.json or deno.jsonc) into a plain object.
 *
 * @param {string} jsonFile Path to the deno.json(c) file.
 * @returns {Object|undefined} Parsed config, or undefined on failure.
 */
export function parseDenoJsonFile(jsonFile) {
  if (!safeExistsSync(jsonFile)) {
    return undefined;
  }
  let rawData;
  try {
    rawData = readFileSync(jsonFile, "utf8");
  } catch (err) {
    if (DEBUG_MODE) {
      console.log(`Unable to read ${jsonFile}`, err);
    }
    return undefined;
  }
  try {
    return JSON.parse(stripJsonc(rawData));
  } catch (err) {
    if (DEBUG_MODE) {
      console.log(`Unable to parse ${jsonFile}`, err);
    }
    return undefined;
  }
}

/**
 * Locate the deno.json or deno.jsonc manifest for a given directory.
 *
 * @param {string} dir Directory to search.
 * @returns {string|undefined} Path to the manifest, if present.
 */
export function findDenoJson(dir) {
  const jsonPath = join(dir, "deno.json");
  if (safeExistsSync(jsonPath)) {
    return jsonPath;
  }
  const jsoncPath = join(dir, "deno.jsonc");
  if (safeExistsSync(jsoncPath)) {
    return jsoncPath;
  }
  return undefined;
}

/**
 * Split a `@scope/name@version` descriptor into its group, name and version.
 * Handles scoped names that themselves begin with `@`.
 *
 * @param {string} descriptor The `[@scope/]name[@version]` descriptor.
 * @returns {{group: string, name: string, version: string}} Parsed pieces.
 */
function parseScopedDescriptor(descriptor) {
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
 * Build the JSR npm-compat name (`<owner>__<name>`) for a jsr group/name pair.
 * The returned value is the npm *package name* that lives under the `@jsr`
 * scope on npm.jsr.io, e.g. `jsr:@std/assert` -> npm `@jsr/std__assert`. The
 * `@jsr` scope itself is applied separately as the purl namespace/group so the
 * resulting purl is a valid two-segment npm purl
 * (`pkg:npm/%40jsr/std__assert@1.0.19`).
 *
 * @param {string} group Original jsr scope, e.g. `@std`.
 * @param {string} name Original jsr name, e.g. `assert`.
 * @returns {string} npm package name, e.g. `std__assert`.
 */
function jsrNpmName(group, name) {
  const owner = group ? group.replace(/^@/, "") : "";
  if (!owner) {
    return name;
  }
  return `${owner}__${name}`;
}

/**
 * Parse an npm integrity string into a canonical `_integrity` value. npm
 * lockfiles already use the SRI form (`sha512-base64==`); deno's npm entries
 * reuse the same form, so this is mostly a passthrough that discards blanks.
 *
 * @param {string} integrity Raw integrity from the lockfile.
 * @returns {string|undefined} Normalised integrity, or undefined.
 */
function toNpmIntegrity(integrity) {
  if (!integrity || typeof integrity !== "string") {
    return undefined;
  }
  const trimmed = integrity.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed;
}

/**
 * Normalise a jsr integrity hash (raw sha256 hex, as emitted by deno) into an
 * `_integrity`-shaped value. We prefix `sha256-` but keep the hex payload
 * verbatim rather than base64-encoding, and store the raw value in a property
 * so consumers can distinguish it from a canonical SRI digest.
 *
 * @param {string} integrity Raw sha256 hex string.
 * @returns {string|undefined} Prefixed integrity, or undefined.
 */
function toJsrIntegrity(integrity) {
  if (!integrity || typeof integrity !== "string") {
    return undefined;
  }
  const trimmed = integrity.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.startsWith("sha256-") ? trimmed : `sha256-${trimmed}`;
}

/**
 * Read and JSON-parse a package.json, tolerating any IO/parse failure.
 *
 * @param {string} pkgJsonFile Path to a package.json.
 * @returns {Object|undefined} Parsed manifest, or undefined.
 */
function readPackageJsonSafe(pkgJsonFile) {
  if (!safeExistsSync(pkgJsonFile)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(pkgJsonFile, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Add a `vcs` external reference to a component, de-duplicating by URL.
 *
 * @param {Object} component The component to enrich.
 * @param {string} url The repository URL.
 */
function addVcsReference(component, url) {
  if (!url) {
    return;
  }
  component.externalReferences = component.externalReferences || [];
  if (
    !component.externalReferences.some(
      (ref) => ref.type === "vcs" && ref.url === url,
    )
  ) {
    component.externalReferences.push({ type: "vcs", url });
  }
}

/**
 * Copy license/description/repository from a package.json manifest onto a
 * component, without overwriting values already resolved. The repository is
 * emitted as a `vcs` external reference (deno components are added directly to
 * the BOM and never pass through the npm `listComponents` normalisation that
 * would otherwise convert a `repository` field).
 *
 * @param {Object} component The component to enrich.
 * @param {Object} pj Parsed package.json manifest.
 */
function applyPackageJsonMetadata(component, pj) {
  if (!pj) {
    return;
  }
  if (!component.description && pj.description) {
    component.description = pj.description;
  }
  if (!component.license) {
    const license = resolveNpmLicense(pj);
    if (license) {
      component.license = license;
    }
  }
  if (pj.repository) {
    const url =
      typeof pj.repository === "string" ? pj.repository : pj.repository.url;
    addVcsReference(component, url);
  }
}

/**
 * Resolve the Deno cache directory ($DENO_DIR or the per-OS default) used to
 * store the npm compatibility layer at `<denoDir>/npm/<registry-host>/...`.
 *
 * @returns {string|undefined} The Deno cache directory, if resolvable.
 */
function resolveDenoCacheDir() {
  if (readEnvironmentVariable("DENO_DIR")) {
    return readEnvironmentVariable("DENO_DIR");
  }
  const home = homedir();
  if (!home) {
    return undefined;
  }
  switch (platform()) {
    case "darwin":
      return join(home, "Library", "Caches", "deno");
    case "win32":
      return join(
        readEnvironmentVariable("LOCALAPPDATA") ||
          join(home, "AppData", "Local"),
        "deno",
      );
    default:
      return join(
        readEnvironmentVariable("XDG_CACHE_HOME") || join(home, ".cache"),
        "deno",
      );
  }
}

/**
 * Locate an installed package.json for a component by checking, in order:
 *  1. the project-local `node_modules` (deno `nodeModulesDir`),
 *  2. deno's flattened `.deno` node_modules layout, and
 *  3. deno's global npm cache under `<denoDir>/npm/<registry-host>/`.
 *
 * jsr components resolve under the `@jsr` scope (their npm-compat name), which
 * is only present when a project materialises jsr packages into node_modules.
 *
 * @param {Object} component The component to resolve.
 * @param {string} projectRoot The directory containing deno.lock.
 * @param {string[]} registryHosts npm registry hosts to probe in the cache.
 * @returns {Object|undefined} Parsed package.json, if found.
 */
function findInstalledManifest(component, projectRoot, registryHosts) {
  const { group, name, version } = component;
  const scopedName = group ? `${group}/${name}` : name;
  const candidates = [];
  if (projectRoot) {
    const nmDir = join(projectRoot, "node_modules");
    // 1. Hoisted/symlinked layout: node_modules/<scope>/<name>/package.json
    candidates.push(join(nmDir, scopedName, "package.json"));
    // 2. Deno's flattened layout: node_modules/.deno/<key>@<version>/node_modules/<scope>/<name>/package.json
    const denoKey = `${group ? `${group.replace(/^@/, "")}+` : ""}${name}@${version}`;
    candidates.push(
      join(nmDir, ".deno", denoKey, "node_modules", scopedName, "package.json"),
    );
  }
  // 3. Deno global npm cache: <denoDir>/npm/<host>/<scope>/<name>/<version>/package.json
  const denoCacheDir = resolveDenoCacheDir();
  if (denoCacheDir && version) {
    for (const host of registryHosts) {
      candidates.push(
        join(denoCacheDir, "npm", host, scopedName, version, "package.json"),
      );
    }
  }
  for (const candidate of candidates) {
    const pj = readPackageJsonSafe(candidate);
    if (pj) {
      return pj;
    }
  }
  return undefined;
}

/**
 * Enrich components with license/description/repository metadata mined offline
 * from a project's `node_modules` and the global deno npm cache. Runs before
 * any network lookup so air-gapped scans still capture available metadata.
 *
 * @param {Array} pkgList Components to enrich (mutated in place).
 * @param {string} projectRoot Directory containing deno.lock.
 * @param {string} jsrNpmRegistryHost Host of jsr's npm mirror.
 */
function mineInstalledMetadata(pkgList, projectRoot, jsrNpmRegistryHost) {
  for (const component of pkgList) {
    if (component.description && component.license) {
      continue;
    }
    // jsr components are cached under jsr's npm-mirror host; npm components
    // under the default registry host.
    const registryHosts =
      component.group === JSR_NPM_SCOPE
        ? [jsrNpmRegistryHost, "registry.npmjs.org"]
        : ["registry.npmjs.org"];
    const pj = findInstalledManifest(component, projectRoot, registryHosts);
    if (pj) {
      applyPackageJsonMetadata(component, pj);
    }
  }
}

/**
 * Fetch license, description and repository metadata for jsr components from
 * jsr's metadata API (api.jsr.io). jsr's npm mirror does not expose license
 * data, so this is the authoritative source for it.
 *
 * @param {Array} pkgList jsr components (identified by `cdx:deno:jsrKey`).
 * @returns {Promise<Array>} The same component list.
 */
/**
 * The two jsr.io API URLs a component needs, or undefined when it has no
 * `cdx:deno:jsrKey` property to derive them from.
 *
 * Shared by the batch prefetch and the loop so neither can drift from the
 * other.
 *
 * @param {Object} component CycloneDX component with cdxgen properties.
 * @returns {{versionUrl: string, packageUrl: string}|undefined}
 */
function jsrUrlsFor(component) {
  const jsrKey = (component.properties || []).find(
    (p) => p.name === "cdx:deno:jsrKey",
  )?.value;
  if (!jsrKey) {
    return undefined;
  }
  const atIndex = jsrKey.lastIndexOf("@");
  const idPart = atIndex > 0 ? jsrKey.substring(0, atIndex) : jsrKey;
  const version =
    atIndex > 0 ? jsrKey.substring(atIndex + 1) : component.version;
  const match = idPart.match(/^@([^/]+)\/(.+)$/);
  if (!match) {
    return undefined;
  }
  const [, scope, pkgName] = match;
  return {
    versionUrl: `${JSR_API_URL}scopes/${scope}/packages/${pkgName}/versions/${version}`,
    packageUrl: `${JSR_API_URL}scopes/${scope}/packages/${pkgName}`,
  };
}

/**
 * Whether a component already names its source repository, so the jsr
 * package document, which supplies the GitHub link, has nothing left to add.
 *
 * @param {Object} component CycloneDX component with cdxgen properties.
 * @returns {boolean}
 */
function hasVcsReference(component) {
  return Boolean(
    component.repository?.url ||
      (component.externalReferences || []).some(
        (ref) => ref.type === "vcs" && ref.url,
      ),
  );
}

/**
 * Fetch JSR registry metadata for deno/jsr package components.
 *
 * For each component carrying a `cdx:deno:jsrKey` property, fetches the
 * version and package endpoints from the JSR API and fills in license,
 * description, and the GitHub source link. A document is requested only for
 * a component that still misses a field that document supplies: the version
 * document carries the license, the package document the description and the
 * repository link, so whatever the lockfile and the installed-manifest
 * mining filled is never asked for again. When registry provenance is
 * wanted, as under --bom-audit, both documents are still requested, because
 * they also answer questions the local data cannot.
 *
 * @param {Array<object>} pkgList Package components potentially enriched with `cdx:deno:jsrKey`.
 * @returns {Promise<Array<object>>} The enriched package list (same reference as pkgList).
 */
export async function getJsrMetadata(pkgList) {
  const wantsProvenance = shouldFetchRegistryProvenance();
  // The documents each component still needs, decided before the batched
  // round so a fetch the loop would never make is not issued either.
  const documentsByComponent = new Map();
  for (const component of pkgList) {
    const urls = jsrUrlsFor(component);
    if (!urls) {
      continue;
    }
    const documents = [];
    if (wantsProvenance || !component.license) {
      documents.push(urls.versionUrl);
    }
    if (
      wantsProvenance ||
      !component.description ||
      !hasVcsReference(component)
    ) {
      documents.push(urls.packageUrl);
    }
    documentsByComponent.set(component, documents);
  }
  const prefetched = await prefetchJson(
    prefetchEnabled()
      ? [...new Set([...documentsByComponent.values()].flat())]
          .filter((url) => !jsrMetadataCache.has(url))
          .map((url) => ({ url }))
      : [],
  );
  for (const component of pkgList) {
    try {
      const urls = jsrUrlsFor(component);
      if (!urls) {
        continue;
      }
      const documents = documentsByComponent.get(component) || [];

      if (documents.includes(urls.versionUrl)) {
        let versionBody = jsrMetadataCache.get(urls.versionUrl);
        if (!versionBody) {
          const res =
            prefetchedResponse(prefetched, urls.versionUrl) ||
            (await gatedGet(urls.versionUrl, { responseType: "json" }));
          versionBody = res.body;
          jsrMetadataCache.set(urls.versionUrl, versionBody);
        }
        if (versionBody?.license && !component.license) {
          component.license = versionBody.license;
        }
      }

      if (documents.includes(urls.packageUrl)) {
        let packageBody = jsrMetadataCache.get(urls.packageUrl);
        if (!packageBody) {
          const res =
            prefetchedResponse(prefetched, urls.packageUrl) ||
            (await gatedGet(urls.packageUrl, { responseType: "json" }));
          packageBody = res.body;
          jsrMetadataCache.set(urls.packageUrl, packageBody);
        }
        if (packageBody?.description && !component.description) {
          component.description = packageBody.description;
        }
        const ghRepo = packageBody?.githubRepository;
        if (ghRepo?.owner && ghRepo?.name) {
          addVcsReference(
            component,
            `https://github.com/${ghRepo.owner}/${ghRepo.name}`,
          );
        }
      }
    } catch (_err) {
      if (DEBUG_MODE) {
        console.log(`${component.name} was not found on jsr`);
      }
    }
  }
  return pkgList;
}

/**
 * Parse a deno.lock file (versions 2 through 5) and return the package list
 * and dependency graph in the same shape as the other lockfile parsers.
 *
 * Lock version summary:
 *  - v5 (Deno >= 2.x, current): flat top-level `specifiers`, `jsr`, `npm` and
 *    optional `remote` maps. jsr entries list their own jsr dependencies; npm
 *    entries only carry an integrity hash and DO NOT list their own transitive
 *    npm dependencies (see the limitation note below).
 *  - v2/v3/v4: `npm.specifiers` + `npm.packages` (packages carry a
 *    `dependencies` map of `name` -> `name@version`), optional `jsr` map and
 *    `remote` map.
 *
 * purl mapping:
 *  - `jsr:@scope/name@ver` -> `pkg:npm/@jsr/scope__name@ver` (see
 *    `JSR_NPM_SCOPE` doc comment for the rationale).
 *  - `npm:name@ver` -> `pkg:npm/name@ver` with the sha512 integrity as
 *    `_integrity`.
 *  - `https://...` remote imports -> `pkg:generic/<basename>` with a
 *    `download_url` external reference.
 *
 * v5 npm-transitive limitation: in v5 lockfiles the `npm` map is flat and each
 * npm entry contains only an integrity hash, never a dependencies list. As a
 * result the CycloneDX dependency graph for npm packages under v5 is shallow
 * (only the parent component -> direct npm deps). Resolving the full npm
 * transitive graph would require hitting the npm registry or the deno
 * `node_modules` cache, which cdxgen intentionally does not do by default.
 *
 * @param {string} lockFile Path to the deno.lock file.
 * @param {Object} [options] Parsing options (`parentComponent`, `projectRoot`).
 * @returns {Promise<{pkgList: Array, dependenciesList: Array}>} Parsed
 *   packages and dependency graph.
 */
export async function parseDenoLock(lockFile, options = {}) {
  let pkgList = [];
  const dependenciesList = [];
  if (!safeExistsSync(lockFile)) {
    return { pkgList, dependenciesList };
  }
  let lockData;
  try {
    lockData = JSON.parse(readFileSync(lockFile, "utf8"));
  } catch (err) {
    if (DEBUG_MODE) {
      console.log(`Unable to parse ${lockFile}`, err);
    }
    return { pkgList, dependenciesList };
  }
  const version = `${lockData.version ?? ""}`;
  if (DEBUG_MODE) {
    console.log(`Parsing deno.lock (${lockFile}) version ${version || "?"}`);
  }

  const npmrcConfig = loadNpmrcConfig(options.projectRoot || dirname(lockFile));
  const defaultRegistry =
    normalizeNpmRegistryUrl(npmrcConfig.registry) || DEFAULT_NPM_REGISTRY;

  // Map of concrete package key -> bom-ref for dependency resolution.
  // Keys are the canonical `@scope/name@version` (jsr) or `name@version` (npm).
  const keyToBomRef = new Map();
  // Map of bom-ref -> dependency bom-refs (collected during the first pass so
  // we can emit the graph without ordering constraints).
  const edgesByBomRef = new Map();
  // Direct dependencies of the parent/application component (the roots of the
  // graph). Populated from the workspace block or the specifiers maps below.
  const rootRefs = new Set();
  const pkgObjectsByKey = new Map();

  const rememberEdge = (fromRef, toRef) => {
    if (!fromRef || !toRef || fromRef === toRef) {
      return;
    }
    const set = edgesByBomRef.get(fromRef);
    if (set) {
      set.add(toRef);
    } else {
      edgesByBomRef.set(fromRef, new Set([toRef]));
    }
  };

  // ---- jsr packages -----------------------------------------------------
  // Resolve a jsr dependency reference (e.g. `jsr:@std/internal@^1.0.12`) to
  // the bom-ref of the concrete installed package, using the specifiers map
  // to turn the requirement into a pinned version.
  const resolveJsrRef = (jsrRef, specifiers) => {
    if (!jsrRef) {
      return undefined;
    }
    const req = jsrRef.startsWith("jsr:") ? jsrRef.slice(4) : jsrRef;
    // Specifiers may key the exact requirement string (with the `jsr:` prefix)
    // so look it up both ways before falling back to a version-less match.
    const pinnedVersion = specifiers?.[jsrRef] ?? specifiers?.[`jsr:${req}`];
    const { group, name } = parseScopedDescriptor(req);
    if (pinnedVersion) {
      const concreteKey = `${group ? `${group}/` : ""}${name}@${pinnedVersion}`;
      return keyToBomRef.get(concreteKey);
    }
    // Fall back to any concrete key matching this group/name. Picks the first
    // known version — deno does not allow two versions of the same jsr package
    // in a single resolve, so this is unambiguous in practice.
    for (const [ck, ref] of keyToBomRef) {
      const prefix = `${group ? `${group}/` : ""}${name}@`;
      if (ck.startsWith(prefix)) {
        return ref;
      }
    }
    return undefined;
  };

  const jsrMap = lockData.jsr || {};
  const specifiers = lockData.specifiers || {};
  for (const [entryKey, entry] of Object.entries(jsrMap)) {
    const { group, name, version } = parseScopedDescriptor(entryKey);
    if (!name || !version) {
      continue;
    }
    const npmName = jsrNpmName(group, name);
    const purlString = build({
      type: "npm",
      namespace: JSR_NPM_SCOPE || null,
      name: npmName,
      version: version || null,
    });
    const bomRef = decodeURIComponent(purlString);
    keyToBomRef.set(entryKey, bomRef);
    const integrity = toJsrIntegrity(entry?.integrity);
    const properties = [
      { name: "internal:SrcFile", value: lockFile },
      { name: "cdx:deno:source", value: "jsr" },
      // Preserve the original jsr identity for traceability, since the purl is
      // rewritten to the npm-compat form (`@jsr/<owner>__<name>`).
      { name: "cdx:deno:jsrKey", value: entryKey },
    ];
    if (integrity) {
      properties.push({
        name: "cdx:deno:integrity",
        value: entry?.integrity,
      });
    }
    // Deterministic canonical jsr page for the original specifier, e.g.
    // `https://jsr.io/@std/assert@1.0.19`. The npm-mirror tarball URL is only
    // available after a registry lookup, so this gives every jsr component a
    // stable reference even without --fetch-license.
    const jsrHomepage = `https://jsr.io/${group ? `${group}/` : ""}${name}@${version}`;
    const pkgObj = {
      group: JSR_NPM_SCOPE,
      name: npmName,
      version,
      purl: purlString,
      "bom-ref": bomRef,
      properties,
      externalReferences: [{ type: "website", url: jsrHomepage }],
      evidence: {
        identity: {
          field: "purl",
          confidence: 1,
          methods: [
            {
              technique: "manifest-analysis",
              confidence: 1,
              value: lockFile,
            },
          ],
        },
      },
    };
    if (integrity) {
      pkgObj._integrity = integrity;
    }
    pkgObjectsByKey.set(entryKey, pkgObj);
    // Always seed an edge set so leaf jsr packages (no dependencies array)
    // still appear in the CycloneDX dependency graph with an empty dependsOn,
    // matching how the npm loop below treats every entry.
    if (!edgesByBomRef.has(bomRef)) {
      edgesByBomRef.set(bomRef, new Set());
    }
  }
  // Wire up jsr -> jsr edges now that every jsr bom-ref is known.
  for (const [entryKey, entry] of Object.entries(jsrMap)) {
    const fromRef = keyToBomRef.get(entryKey);
    if (!fromRef || !Array.isArray(entry?.dependencies)) {
      continue;
    }
    for (const depRef of entry.dependencies) {
      const toRef = resolveJsrRef(depRef, specifiers);
      if (toRef) {
        rememberEdge(fromRef, toRef);
      }
    }
  }

  // ---- npm packages -----------------------------------------------------
  // v5: flat `npm` map keyed by `name@version` with integrity only.
  // v2/v3/v4: nested `npm.packages` map with a `dependencies` object whose
  // values are `name@version` references to other entries.
  const npmFlat = Array.isArray(lockData.npm) ? {} : lockData.npm || {};
  const npmFlatEntries = npmFlat?.packages ? {} : npmFlat;
  const npmNested = npmFlat?.packages ? npmFlat.packages : {};

  // v5-style flat entries.
  for (const [entryKey, entry] of Object.entries(npmFlatEntries)) {
    if (entryKey === "specifiers") {
      continue;
    }
    const { group, name, version } = parseScopedDescriptor(entryKey);
    if (!name || !version) {
      continue;
    }
    const purlString = build({
      type: "npm",
      namespace: group || null,
      name: name,
      version: version || null,
    });
    const bomRef = decodeURIComponent(purlString);
    keyToBomRef.set(entryKey, bomRef);
    const integrity = toNpmIntegrity(
      entry && typeof entry === "object" ? entry.integrity : entry,
    );
    const resolvedUrl = buildNpmRegistryTarballUrl(
      defaultRegistry,
      group,
      name,
      version,
    );
    const properties = [
      { name: "internal:SrcFile", value: lockFile },
      { name: "cdx:deno:source", value: "npm" },
    ];
    const externalReferences = [];
    if (resolvedUrl) {
      properties.push({ name: "internal:ResolvedUrl", value: resolvedUrl });
      externalReferences.push({ type: "distribution", url: resolvedUrl });
    }
    const pkgObj = {
      group: group || "",
      name,
      version,
      purl: purlString,
      "bom-ref": bomRef,
      properties,
      evidence: {
        identity: {
          field: "purl",
          confidence: 1,
          methods: [
            {
              technique: "manifest-analysis",
              confidence: 1,
              value: lockFile,
            },
          ],
        },
      },
    };
    if (integrity) {
      pkgObj._integrity = integrity;
    }
    if (externalReferences.length) {
      pkgObj.externalReferences = externalReferences;
    }
    // v5 npm entries have no dependencies; initialise an empty edge set so
    // the dependency graph still references every component.
    pkgObjectsByKey.set(entryKey, pkgObj);
    if (!edgesByBomRef.has(bomRef)) {
      edgesByBomRef.set(bomRef, new Set());
    }
  }

  // v2/v3/v4-style nested packages with explicit dependency maps.
  for (const [entryKey, entry] of Object.entries(npmNested)) {
    if (entryKey === "specifiers") {
      continue;
    }
    const { group, name, version } = parseScopedDescriptor(entryKey);
    if (!name || !version) {
      continue;
    }
    const purlString = build({
      type: "npm",
      namespace: group || null,
      name: name,
      version: version || null,
    });
    const bomRef = decodeURIComponent(purlString);
    keyToBomRef.set(entryKey, bomRef);
    const integrity = toNpmIntegrity(entry?.integrity);
    const resolvedUrl = buildNpmRegistryTarballUrl(
      defaultRegistry,
      group,
      name,
      version,
    );
    const properties = [
      { name: "internal:SrcFile", value: lockFile },
      { name: "cdx:deno:source", value: "npm" },
    ];
    const externalReferences = [];
    if (resolvedUrl) {
      properties.push({ name: "internal:ResolvedUrl", value: resolvedUrl });
      externalReferences.push({ type: "distribution", url: resolvedUrl });
    }
    const pkgObj = {
      group: group || "",
      name,
      version,
      purl: purlString,
      "bom-ref": bomRef,
      properties,
      evidence: {
        identity: {
          field: "purl",
          confidence: 1,
          methods: [
            {
              technique: "manifest-analysis",
              confidence: 1,
              value: lockFile,
            },
          ],
        },
      },
    };
    if (integrity) {
      pkgObj._integrity = integrity;
    }
    if (externalReferences.length) {
      pkgObj.externalReferences = externalReferences;
    }
    pkgObjectsByKey.set(entryKey, pkgObj);
    if (!edgesByBomRef.has(bomRef)) {
      edgesByBomRef.set(bomRef, new Set());
    }
  }
  // Wire up nested npm -> npm edges using the `name@version` references.
  for (const [entryKey, entry] of Object.entries(npmNested)) {
    const fromRef = keyToBomRef.get(entryKey);
    if (!fromRef || !entry?.dependencies) {
      continue;
    }
    for (const depName of Object.keys(entry.dependencies)) {
      const depTarget = entry.dependencies[depName];
      // v2 maps each dependency name to a canonical `name@version` key.
      const toRef = keyToBomRef.get(depTarget) || keyToBomRef.get(depName);
      if (toRef) {
        rememberEdge(fromRef, toRef);
      }
    }
  }

  // ---- remote (https://) imports ---------------------------------------
  // Keyed by full URL; value is an integrity hash. Represented as
  // `pkg:generic` with a download_url external reference.
  const remoteMap = lockData.remote || {};
  for (const [url, integrity] of Object.entries(remoteMap)) {
    if (!url) {
      continue;
    }
    let remoteName;
    try {
      remoteName = basename(new URL(url).pathname) || "remote";
    } catch {
      remoteName = "remote";
    }
    // Strip any query fragment from the stored name; the URL itself is kept
    // whole only in the external reference (no userinfo is expected here).
    const cleanName = remoteName.split("?")[0].split("#")[0] || "remote";
    const integritySafe =
      typeof integrity === "string" ? integrity : `${integrity}`;
    const shortHash = integritySafe.slice(0, 12);
    const qualifiers = { download_url: url };
    const purlString = build({
      type: "generic",
      name: cleanName,
      version: shortHash || null,
      qualifiers: qualifiers || null,
    });
    const bomRef = decodeURIComponent(purlString);
    // Only add each remote URL once (a bom-ref collision means we already did).
    if (keyToBomRef.has(`remote:${url}`)) {
      continue;
    }
    keyToBomRef.set(`remote:${url}`, bomRef);
    const properties = [
      { name: "internal:SrcFile", value: lockFile },
      { name: "cdx:deno:source", value: "https" },
    ];
    const pkgObj = {
      name: cleanName,
      version: shortHash,
      purl: purlString,
      "bom-ref": bomRef,
      externalReferences: [{ type: "distribution", url }],
      properties,
      evidence: {
        identity: {
          field: "purl",
          confidence: 0.7,
          methods: [
            {
              technique: "manifest-analysis",
              confidence: 0.7,
              value: lockFile,
            },
          ],
        },
      },
    };
    pkgObjectsByKey.set(`remote:${url}`, pkgObj);
    if (!edgesByBomRef.has(bomRef)) {
      edgesByBomRef.set(bomRef, new Set());
    }
  }

  // ---- root dependencies (workspace) -----------------------------------
  // The workspace.dependencies array (v5) or npm.specifiers / npm-flat-specs
  // lists the packages the project directly imports. Link the parent component
  // to these so the root of the dependency graph is meaningful.
  const workspaceDeps = lockData.workspace?.dependencies;
  if (Array.isArray(workspaceDeps)) {
    for (const depRef of workspaceDeps) {
      const ref = resolveRootDep(depRef, specifiers, keyToBomRef);
      if (ref) {
        rootRefs.add(ref);
      }
    }
  } else {
    // Fall back to the specifiers maps for lockfiles without an explicit
    // workspace block.
    // v5 top-level specifiers: keys are `jsr:`/`npm:` requirements, values are
    // the pinned version. v2 `npm.specifiers`: keys are `name@range`, values
    // are the canonical `name@version` package key used in `npm.packages`.
    for (const [req, resolved] of Object.entries(specifiers)) {
      if (req.startsWith("jsr:")) {
        const ref = resolveJsrRef(req, specifiers);
        if (ref) {
          rootRefs.add(ref);
        }
      } else if (req.startsWith("npm:")) {
        const { group, name } = parseScopedDescriptor(req.slice(4));
        const ref = keyToBomRef.get(
          `${group ? `${group}/` : ""}${name}@${resolved}`,
        );
        if (ref) {
          rootRefs.add(ref);
        }
      }
    }
    const npmSpecifiers = npmFlat?.specifiers || {};
    for (const resolved of Object.values(npmSpecifiers)) {
      // v2 specifier values are already the package key (e.g.
      // `@cdxgen/cdxgen@9.0.1`).
      const ref = keyToBomRef.get(resolved);
      if (ref) {
        rootRefs.add(ref);
      }
    }
  }
  // ---- emit -------------------------------------------------------------
  pkgList = [...pkgObjectsByKey.values()];
  for (const [ref, deps] of edgesByBomRef) {
    dependenciesList.push({ ref, dependsOn: [...deps].sort() });
  }

  // Parent component -> direct dependencies. Mirror the bun emitter by
  // appending an entry for the parent so the application root is wired into
  // the dependency graph.
  const parentRef = options.parentComponent?.["bom-ref"];
  if (parentRef) {
    dependenciesList.push({
      ref: parentRef,
      dependsOn: [...rootRefs].sort(),
    });
  }

  // Offline enrichment first: mine license/description/repository from a
  // project's node_modules and the global deno npm cache. This needs no
  // network and runs even without --fetch-license.
  mineInstalledMetadata(
    pkgList,
    options.projectRoot || dirname(lockFile),
    JSR_NPM_REGISTRY_HOST,
  );

  // The shared metadata gate: FETCH_LICENSE and the provenance fetch that
  // --bom-audit turns on both reach the registries from here.
  if (shouldFetchPackageMetadata()) {
    if (DEBUG_MODE) {
      console.log(
        `About to fetch registry metadata for ${pkgList.length} packages in parseDenoLock`,
      );
    }
    // getNpmMetadata mutates each component in place, so the split lists share
    // the same objects as pkgList. jsr packages live on jsr's npm mirror
    // (npm.jsr.io), NOT registry.npmjs.org, so they must be resolved against a
    // different registry or every lookup 404s.
    const jsrPkgs = pkgList.filter((p) => p.group === JSR_NPM_SCOPE);
    const npmPkgs = pkgList.filter((p) => p.group !== JSR_NPM_SCOPE);
    if (npmPkgs.length) {
      await getNpmMetadata(npmPkgs, defaultRegistry);
    }
    if (jsrPkgs.length) {
      // The npm mirror provides the description + resolved tarball
      // (distribution externalReference) but no license; jsr's own API is the
      // authoritative source for the license, so query it afterwards.
      await getNpmMetadata(jsrPkgs, JSR_NPM_REGISTRY);
      await getJsrMetadata(jsrPkgs);
    }
  }
  return { pkgList, dependenciesList };
}

/**
 * Resolve a top-level workspace dependency reference from a v5 lockfile to a
 * concrete bom-ref.
 *
 * @param {string} depRef Reference such as `jsr:@std/assert@1` or
 *   `npm:chalk@^5.3.0`.
 * @param {Object} specifiers The v5 `specifiers` map (req -> pinned version).
 * @param {Map<string, string>} keyToBomRef Concrete-key -> bom-ref lookup.
 * @returns {string|undefined} Resolved bom-ref.
 */
function resolveRootDep(depRef, specifiers, keyToBomRef) {
  if (!depRef) {
    return undefined;
  }
  const pinned = specifiers?.[depRef];
  if (depRef.startsWith("jsr:")) {
    const { group, name } = parseScopedDescriptor(depRef.slice(4));
    if (pinned) {
      return keyToBomRef.get(`${group ? `${group}/` : ""}${name}@${pinned}`);
    }
  } else if (depRef.startsWith("npm:")) {
    const { group, name } = parseScopedDescriptor(depRef.slice(4));
    if (pinned) {
      return keyToBomRef.get(`${group ? `${group}/` : ""}${name}@${pinned}`);
    }
  }
  return undefined;
}
