import { Buffer } from "node:buffer";
import { constants, lstatSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import {
  delimiter as _delimiter,
  sep as _sep,
  basename,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

import { build } from "@cdxgen/cdx-purl";
import StreamZip from "node-stream-zip";
import {
  clean,
  coerce,
  compare,
  maxSatisfying,
  parse,
  satisfies,
} from "semver";

import {
  cdxgenAgent,
  DEBUG_MODE,
  isSecureMode,
  readEnvironmentVariable,
} from "../core/activity.js";
import {
  SEARCH_MAVEN_ORG,
  shouldFetchLicense,
  shouldFetchPackageMetadata,
  shouldFetchRegistryProvenance,
  shouldFetchVCS,
} from "../core/env.js";
import {
  checksumFile,
  getAllFiles,
  getTmpDir,
  multiChecksumFile,
  safeCopyFileSync,
  safeExistsSync,
  safeExtractArchive,
  safeMkdtempSync,
  safeRmSync,
} from "../core/fs.js";
import { thoughtLog } from "../core/logger.js";
import { mapWithConcurrency } from "../core/parallel.js";
import { isWin } from "../core/paths.js";
import { vendorAliases } from "../core/state.js";
import { isGitHubUrl, modulePathHost, parseUrl } from "../core/urls.js";
import {
  collectJarNS,
  getPomPropertiesFromMavenDir,
  inferJarGroupFromManifest,
  isDocumentationJar,
  parseJarManifest,
  parsePomXml,
  trimJarGroupSuffix,
} from "../inventory/deps.js";
import {
  isHostCircuitOpen,
  openHostCircuit,
  prefetchEnabled,
  prefetchedResponse,
  prefetchJson,
  withHostRateLimit,
} from "../inventory/fetchBatch.js";
import {
  findLocalMavenArtifact,
  findMavenCoordinatesBySha1,
  inferMavenCoordinatesFromPath,
} from "../inventory/jvmLocalRepos.js";
import {
  applyPurl,
  genericPurl,
  nugetPurl,
  pypiPurl,
} from "../inventory/purl.js";
import {
  publishedArtifactId,
  scalaCoordinateOfPurl,
} from "../inventory/scalaCoords.js";
import {
  findLicenseId,
  guessLicenseId,
  spdxLicenses,
} from "../inventory/spdx.js";
import { extractLicenseText, extractRepoUrl } from "../parsers/htmlExtract.js";
import { xml2js } from "../parsers/xml.js";
import {
  localCargoMetadataEnabled,
  readCargoCacheMetadata,
} from "./cargoCache.js";
import { normalizeNpmRegistryUrl, resolveNpmLicense } from "./npmutils.js";
import { parseNuspecData } from "./parsers-dotnet.js";
import { isDefaultPypiRegistry } from "./pylockutils.js";
import {
  applyPypiClassifierMetadata,
  applyPypiModuleNames,
} from "./pypiClassifiers.js";
import {
  collectCargoRegistryProvenanceProperties,
  collectNpmRegistryProvenanceProperties,
  collectPypiRegistryProvenanceProperties,
} from "./registryProvenance.js";

// Metadata cache
export let metadata_cache = {};

// Speed up lookup namespaces for a given jar

// Maven Central's search API, used to identify a jar by its SHA-1.
const MAVEN_SEARCH_HOST = "central.sonatype.com";

// circuit breaker for get repo license. After five failures the lookups pause
// for fifteen minutes, so a long-running server recovers once the API does.
let get_repo_license_errors = 0;
let get_repo_license_paused_until = 0;
const MAX_GET_REPO_LICENSE_ERRORS = 5;
const GET_REPO_LICENSE_PAUSE_MS = 15 * 60 * 1000;

/**
 * Whether repository licence lookups are currently paused.
 *
 * @returns {boolean}
 */
function repoLicenseLookupsPaused() {
  if (get_repo_license_errors < MAX_GET_REPO_LICENSE_ERRORS) {
    return false;
  }
  if (!get_repo_license_paused_until) {
    get_repo_license_paused_until = Date.now() + GET_REPO_LICENSE_PAUSE_MS;
    return true;
  }
  if (Date.now() < get_repo_license_paused_until) {
    return true;
  }
  get_repo_license_errors = 0;
  get_repo_license_paused_until = 0;
  return false;
}

/**
 * Internal helper to reset metadata_cache. Used by parseGoModData (still in
 * utils.js until batch 6) because ESM forbids reassigning an imported binding.
 * NOT re-exported through the utils.js barrel.
 */
export function _clearMetadataCache() {
  metadata_cache = {};
}

/**
 * Fetches license information for a list of Swift packages by querying the
 * GitHub repository license API for packages hosted on github.com.
 *
 * @param {Object[]} pkgList List of Swift package objects with optional repository.url fields
 * @returns {Promise<Object[]>} Resolved list of package objects, each augmented with a license field where available
 */
export async function getSwiftPackageMetadata(pkgList) {
  const cdepList = [];
  // Swift resolves licences purely through repository lookups, so its whole
  // network cost is one batched round.
  await prefetchRepoLicenses(
    pkgList
      .filter((p) => isGitHubUrl(p.repository?.url))
      .map((p) => p.repository.url),
  );
  for (const p of pkgList) {
    if (p.repository?.url) {
      if (isGitHubUrl(p.repository.url)) {
        try {
          p.license = await getRepoLicense(p.repository.url, undefined);
        } catch (_e) {
          console.error("error fetching repo license from", p.repository.url);
        }
      } else {
        if (DEBUG_MODE) {
          console.log(
            p.repository.url,
            "is currently not supported to fetch for licenses",
          );
        }
      }
    } else {
      if (DEBUG_MODE) {
        console.warn("no repository url found for", p.name);
      }
    }
    cdepList.push(p);
  }
  return cdepList;
}

/** Accept header pub.dev requires for its v2 API. */
const PUB_ACCEPT = "application/vnd.pub.v2+json";

/**
 * The registry path segment for a package: the name, scoped by its group when
 * it has one.
 *
 * Extracted so the batch prefetch and the request inside the loop cannot drift
 * apart — a prefetch that computed the URL even slightly differently would
 * silently fetch documents nobody reads and leave the loop making its own
 * serial requests.
 *
 * @param {Object} p Package object with `name` and optional `group`.
 * @returns {string} Registry key, e.g. `@babel/core` or `left-pad`.
 */
function npmRegistryKey(p) {
  if (p.group && p.group !== "") {
    const group = p.group.startsWith("@") ? p.group : `@${p.group}`;
    return `${group}/${p.name}`;
  }
  return p.name;
}

// The hosts of the public npm registry. A lockfile `resolved` URL on any other
// host was served by a mirror or a private registry.
const DEFAULT_NPM_REGISTRY_HOSTS = new Set([
  "registry.npmjs.org",
  "registry.npmjs.com",
  "registry.yarnpkg.com",
]);

/**
 * Whether a URL points at the public npm registry or at the registry the
 * caller resolves against.
 *
 * @param {string} url Registry or tarball URL.
 * @param {string} defaultRegistryUrl The registry the caller resolves against.
 * @returns {boolean}
 */
function isDefaultNpmRegistry(url, defaultRegistryUrl) {
  const host = parseUrl(url)?.host;
  return (
    !!host &&
    (DEFAULT_NPM_REGISTRY_HOSTS.has(host) ||
      host === parseUrl(defaultRegistryUrl)?.host)
  );
}

/**
 * The registry that served a tarball. Registries lay tarballs out as
 * `<registry>/<name>/-/<file>`, so the registry is everything before the name.
 *
 * @param {string} tarballUrl Lockfile `resolved` URL.
 * @param {string} fullName Package name, with its scope.
 * @returns {string|undefined} Registry base URL, or undefined when the URL has
 *   another layout.
 */
function npmTarballRegistry(tarballUrl, fullName) {
  if (!tarballUrl.startsWith("https://") && !tarballUrl.startsWith("http://")) {
    return undefined;
  }
  const index = tarballUrl.indexOf(`/${fullName}/-/`);
  return index > 0 ? tarballUrl.slice(0, index) : undefined;
}

/**
 * Whether a lockfile `resolved` URL names a git source rather than a tarball.
 *
 * @param {string} url Resolved URL.
 * @returns {boolean}
 */
function isNpmGitSource(url) {
  return (
    url.startsWith("git+") ||
    url.startsWith("git://") ||
    url.startsWith("git@") ||
    url.startsWith("ssh://")
  );
}

/**
 * The registry to look an npm package up at, or undefined when no registry
 * lookup may be made for it.
 *
 * A public registry cannot hold the project itself, a workspace or link
 * member, a file or git source, or a package another registry serves. Sending
 * those names out leaks them and imports a look-alike's metadata, so the
 * component keeps whatever the lockfile and the manifests already say.
 *
 * A scope that .npmrc maps to another registry, or whose tarball another
 * registry served, is looked up at that registry. In secure mode cdxgen does
 * not contact a host the scanned project names, so such a package is not
 * looked up at all.
 *
 * @param {Object} p Package object carrying the properties the npm parsers record.
 * @param {string} defaultRegistryUrl The registry the caller resolves against.
 * @param {Object} [npmrcConfig] Merged .npmrc configuration, for scope mappings.
 * @param {boolean} [secureMode] Whether secure mode is on.
 * @returns {string|undefined} Registry base URL, or undefined to skip.
 */
function npmLookupRegistry(p, defaultRegistryUrl, npmrcConfig, secureMode) {
  if (p.type === "application") {
    return undefined;
  }
  const props = {};
  for (const prop of p.properties || []) {
    props[prop.name] = prop.value;
  }
  if (
    props["cdx:npm:isWorkspace"] === "true" ||
    props["cdx:npm:isLink"] === "true" ||
    props["cdx:npm:isRegistryDependency"] === "false" ||
    props["cdx:npm:resolvedPath"]
  ) {
    return undefined;
  }
  const manifestSourceType = props["cdx:npm:manifestSourceType"];
  if (manifestSourceType && manifestSourceType !== "registry") {
    return undefined;
  }
  const resolvedUrl =
    props["internal:ResolvedUrl"] ||
    p.externalReferences?.find((ref) => ref.type === "distribution")?.url;
  if (resolvedUrl && isNpmGitSource(resolvedUrl)) {
    return undefined;
  }
  if (p.group) {
    const scope = p.group.startsWith("@") ? p.group : `@${p.group}`;
    const scopeRegistry = normalizeNpmRegistryUrl(
      npmrcConfig?.[`${scope}:registry`],
    );
    let registry;
    if (scopeRegistry) {
      registry = scopeRegistry;
    } else if (resolvedUrl) {
      registry = isDefaultNpmRegistry(resolvedUrl, defaultRegistryUrl)
        ? defaultRegistryUrl
        : npmTarballRegistry(resolvedUrl, `${scope}/${p.name}`);
    }
    if (registry && !isDefaultNpmRegistry(registry, defaultRegistryUrl)) {
      return secureMode ? undefined : registry;
    }
    if (resolvedUrl && !registry) {
      // Served by another registry, but not in a layout that names it.
      return undefined;
    }
  }
  return defaultRegistryUrl;
}

/**
 * Whether every field the registry is asked for is already on the component.
 *
 * A lockfile or an installed package.json that already states the licence, the
 * description and the repository has answered the question a packument would be
 * asked, so the package is not looked up at all. A licence the project gave is
 * never replaced by the registry's view even when a lookup happens for the
 * other fields.
 *
 * @param {Object} p Package object
 * @returns {boolean}
 */
function npmMetadataComplete(p) {
  // A lockfile records the repository as a vcs external reference rather than
  // the repository field the registry path sets, so both count.
  const hasRepository =
    p.repository?.url ||
    (typeof p.repository === "string" && p.repository) ||
    (p.externalReferences || []).some((ref) => ref.type === "vcs" && ref.url);
  return Boolean(p.license && p.description && hasRepository);
}

/**
 * The license an npm registry document declares for a version, read like the
 * manifest it came from: the registry still serves the legacy `licenses` array
 * of packages such as fuzzy 0.1.3 (issue 4466). The version's own manifest
 * wins over the document-level field.
 *
 * @param {Object} body Registry document (packument).
 * @param {string} version Version of the package.
 * @returns {string|Object|Array|undefined} The declared license, if any.
 */
function npmRegistryLicense(body, version) {
  return (
    resolveNpmLicense(body?.versions?.[version]) || resolveNpmLicense(body)
  );
}

/**
 * Method to retrieve metadata for npm packages by querying npmjs
 *
 * Packages a public registry cannot hold are skipped: the project itself,
 * workspace and link members, file and git sources, and scopes served by
 * another registry. See {@link npmLookupRegistry}. A package whose licence,
 * description and repository the project or lockfile already supplied is left
 * alone as well: the registry answers only what is still missing, and never
 * overwrites a licence that is already set. The registry's licence is read
 * with its legacy `licenses` field, and only a package for which neither the
 * package nor the registry names one falls back to its repository's licence.
 *
 * @param {Array} pkgList Package list
 * @param {string} [registryUrl] Registry to query instead of NPM_URL
 * @param {Object} [options] Options
 * @param {Object} [options.npmrcConfig] Merged .npmrc configuration, used to
 *   resolve a scope's own registry
 * @param {boolean} [options.secureMode] Whether secure mode is on. Defaults to
 *   the process-wide setting.
 */
export async function getNpmMetadata(pkgList, registryUrl, options = {}) {
  const NPM_URL =
    registryUrl ||
    readEnvironmentVariable("NPM_URL") ||
    "https://registry.npmjs.org/";
  const secureMode = options.secureMode ?? isSecureMode;
  const cdepList = [];
  // The registry for every package is decided up front, so the batch and the
  // loop below cannot disagree about who is skipped and who is asked where.
  const lookupUrls = new Map();
  // Provenance is never held locally, so when it is wanted every package is
  // still asked about; the local fields survive the round either way.
  const wantsProvenance = shouldFetchRegistryProvenance();
  for (const p of pkgList) {
    if (!wantsProvenance && npmMetadataComplete(p)) {
      continue;
    }
    const registry = npmLookupRegistry(
      p,
      NPM_URL,
      options.npmrcConfig,
      secureMode,
    );
    if (registry) {
      const base = registry.endsWith("/") ? registry : `${registry}/`;
      lookupUrls.set(p, base + npmRegistryKey(p));
    }
  }
  // Every URL this loop needs is known up front, so they are fetched
  // concurrently before the loop rather than one at a time inside it. The
  // derivation below is unchanged and still reads `body`; only where `body`
  // comes from differs.
  const prefetched = await prefetchJson(
    prefetchEnabled() ? [...lookupUrls.values()].map((url) => ({ url })) : [],
  );
  // The licence fallback calls getRepoLicense with a URL that only exists once
  // the registry document has arrived, so it needs a second batched round. The
  // documents are already in hand here, which is why this can be done without a
  // second pass over the network for the registry itself.
  if (prefetched.size) {
    const repoUrls = [];
    for (const p of pkgList) {
      const url = lookupUrls.get(p);
      const entry = url ? prefetched.get(url) : undefined;
      if (!entry?.ok) {
        continue;
      }
      const body = entry.body;
      if (
        !p.license &&
        !npmRegistryLicense(body, p.version) &&
        body?.repository?.url
      ) {
        repoUrls.push(body.repository.url);
      }
    }
    await prefetchRepoLicenses(repoUrls);
  }
  for (const p of pkgList) {
    const url = lookupUrls.get(p);
    if (!url) {
      cdepList.push(p);
      continue;
    }
    try {
      // Namespace the cache by registry so packages resolved from a
      // non-default registry (e.g. jsr's npm mirror at npm.jsr.io) do not
      // collide with identically-named packages on the default registry.
      const cacheKey = url;
      let body = {};
      if (metadata_cache[cacheKey]) {
        body = metadata_cache[cacheKey];
      } else {
        const res =
          prefetchedResponse(prefetched, url) ||
          (await cdxgenAgent.get(url, {
            responseType: "json",
          }));
        body = res.body;
        metadata_cache[cacheKey] = body;
      }
      // The registry fills only what the project, the lockfile or an
      // installed manifest left open, so a local answer survives.
      p.description =
        p.description ||
        body.versions?.[p.version]?.description ||
        body.description;
      p.license =
        p.license ||
        npmRegistryLicense(body, p.version) ||
        (await getRepoLicense(body.repository?.url, undefined));
      if (body.repository?.url && !p.repository) {
        p.repository = { url: body.repository.url };
      }
      if (body.homepage && !p.homepage) {
        p.homepage = { url: body.homepage };
      }
      // Capture the resolved tarball as a distribution external reference when
      // the component does not already carry one. This is the reliable source
      // of a download URL for registries (such as jsr's npm mirror) whose
      // tarball path is not deterministically constructible.
      const distTarball = body.versions?.[p.version]?.dist?.tarball;
      if (distTarball) {
        p.externalReferences = p.externalReferences || [];
        if (
          !p.externalReferences.some(
            (ref) => ref.type === "distribution" && ref.url === distTarball,
          )
        ) {
          p.externalReferences.push({
            type: "distribution",
            url: distTarball,
          });
        }
      }
      p.properties = p.properties || [];
      p.properties.push(
        ...collectNpmRegistryProvenanceProperties(body, p.version),
      );
      cdepList.push(p);
    } catch (_err) {
      cdepList.push(p);
      if (DEBUG_MODE) {
        console.error(p, "was not found on npm");
      }
    }
  }
  return cdepList;
}

/**
 * Method to locate local Gradle, Maven, or Coursier cache files for a given maven coordinate.
 *
 * @param {string} group Maven groupId
 * @param {string} name Maven artifactId
 * @param {string} version Package version
 * @returns {Object|null} Object containing jarPath, sha1, and pomPath, or null
 */
export function findLocalMvnArtifact(group, name, version) {
  const found = findLocalMavenArtifact(group, name, version);
  if (!found) {
    return null;
  }
  return {
    jarPath: found.jarPath || null,
    sha1: found.sha1 || null,
    pomPath: found.pomPath || null,
  };
}

// Options for reading a POM with xml2js, shared by every POM reader here.
const POM_XML_OPTIONS = {
  compact: true,
  spaces: 4,
  textKey: "_",
  attributesKey: "$",
  commentKey: "value",
};

// A POM chain is walked at most this deep. Real hierarchies stop well short.
const MAX_POM_PARENT_DEPTH = 8;

// POM URLs that answered 404 or 410, so packages sharing a parent ask once.
// Entries expire so that a long-running server sees new releases.
const missingPomUrls = new Map();
const MISSING_POM_TTL_MS = 60 * 60 * 1000;

// Groups published to Google's Maven repository rather than Maven Central.
const GOOGLE_MAVEN_GROUP_PREFIXES = [
  "android.arch.",
  "androidx.",
  "com.android.",
  "com.google.ads.mediation",
  "com.google.android.",
  "com.google.ar",
  "com.google.firebase",
  "com.google.gms",
  "com.google.mlkit",
  "com.google.testing.platform",
];

/**
 * A repository base URL with exactly one trailing slash, ready for
 * {@link composePomXmlUrl}.
 *
 * @param {string} url Repository URL.
 * @returns {string} Normalised URL.
 */
function withTrailingSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}

/**
 * The repository a package's POM should be fetched from, or undefined when no
 * public repository can hold it: snapshots never reach Maven Central, the
 * project's own modules are not published, and a file:// repository is local.
 *
 * @param {Object} p Package.
 * @param {{MAVEN_CENTRAL_URL: string, ANDROID_MAVEN_URL: string}} repos Repository base URLs.
 * @param {{skipPurls?: Set<string>}} context Packages the caller knows are its own.
 * @returns {string|undefined} Repository base URL.
 */
function mavenRepositoryFor(p, repos, context) {
  const group = p.group || "";
  if (!group || !p.name || !p.version || p.version.endsWith("-SNAPSHOT")) {
    return undefined;
  }
  if (
    context?.skipPurls?.has(p.purl) ||
    context?.skipPurls?.has(p["bom-ref"])
  ) {
    return undefined;
  }
  let repositoryUrl;
  const query = p.purl?.includes("?") ? p.purl.split("?")[1] : "";
  if (query) {
    repositoryUrl = new URLSearchParams(query.split("#")[0]).get(
      "repository_url",
    );
  }
  if (repositoryUrl?.startsWith("file:")) {
    return undefined;
  }
  let repositoryHost;
  try {
    repositoryHost = repositoryUrl ? new URL(repositoryUrl).hostname : "";
  } catch (_err) {
    repositoryHost = "";
  }
  if (
    ["maven.google.com", "dl.google.com"].includes(repositoryHost) ||
    group.includes("android") ||
    GOOGLE_MAVEN_GROUP_PREFIXES.some(
      (prefix) => group === prefix || group.startsWith(prefix),
    )
  ) {
    return repos.ANDROID_MAVEN_URL;
  }
  return repos.MAVEN_CENTRAL_URL;
}

/**
 * Whether a package already carries licence information, in either the
 * `license` field cdxgen fills or the CycloneDX `licenses` array that the
 * cyclonedx-maven-plugin and Quarkus emit.
 *
 * @param {Object} p Package.
 * @returns {boolean}
 */
function hasMavenLicense(p) {
  if (Array.isArray(p.license)) {
    return p.license.some(Boolean);
  }
  return Boolean(p.license) || Boolean(p.licenses?.length);
}

/**
 * Collapse the whitespace a POM description carries over from XML indentation.
 *
 * @param {string} description Raw description.
 * @returns {string} Tidied description.
 */
function tidyPomDescription(description) {
  return description
    .replace(/[ \t]+/g, " ")
    .replace(/^[ \t]+|[ \t]+$/gm, "")
    .replace(/\n\s*\n/g, "\n")
    .trim();
}

/**
 * The licence a POM names in a comment ahead of its project element, as some
 * projects do instead of declaring `<licenses>`.
 *
 * @param {string} pomXml POM text.
 * @returns {string|undefined} Licence id.
 */
function licenseFromPomComment(pomXml) {
  const match = /<!--([\s\S]*?)-->[\s\n]*<project/m.exec(pomXml || "");
  return match?.[1] ? findLicenseId(match[1].trim()) : undefined;
}

/**
 * Fill publisher, description, repository and licence from a merged POM,
 * keeping any value the package already has.
 *
 * @param {Object} p Package.
 * @param {Object} pomJson Merged POM (xml2js compact form).
 * @param {string} [ownPomXml] The package's own POM text, for a licence comment.
 * @returns {void}
 */
function applyPomMetadata(p, pomJson, ownPomXml) {
  if (!pomJson) {
    return;
  }
  if (!p.publisher && pomJson.organization?.name?._) {
    p.publisher = pomJson.organization.name._;
  }
  if (!p.description && pomJson.description?._) {
    p.description = tidyPomDescription(pomJson.description._);
  }
  if (!p.repository && pomJson.scm?.url?._) {
    p.repository = { url: pomJson.scm.url._ };
  }
  if (!hasMavenLicense(p)) {
    const license =
      parseLicenseEntryOrArrayFromPomXml(pomJson.licenses?.license) ||
      licenseFromPomComment(ownPomXml);
    if (license) {
      p.license = license;
    }
  }
}

/**
 * Read a POM from the local Maven, Gradle or Coursier cache.
 *
 * @param {string} group groupId.
 * @param {string} name artifactId.
 * @param {string} version Version.
 * @returns {string|undefined} POM text.
 */
function readLocalPom(group, name, version) {
  const pomPath = findLocalMavenArtifact(group, name, version)?.pomPath;
  if (!pomPath) {
    return undefined;
  }
  try {
    return readFileSync(pomPath, "utf-8");
  } catch (_err) {
    return undefined;
  }
}

/**
 * Load a POM and its parents and merge them child over parent.
 *
 * Every level is read from the local caches first; a build has always
 * downloaded the parents it needed. A level missing locally is fetched only
 * when `remote` is set, and at most `remoteParents` parent levels are fetched,
 * so a cache miss costs no more requests than it always did. The walk stops
 * once licence, organization and scm are all known. A missing parent ends the
 * walk without discarding what the child and nearer parents declared.
 *
 * @param {{urlPrefix?: string, group: string, name: string, version: string}} coordinates
 * @param {{remote?: boolean, remoteParents?: number}} [opts]
 * @returns {Promise<{merged: Object, ownXml: string}|undefined>}
 */
async function loadPomChain(
  coordinates,
  { remote = false, remoteParents = 1 } = {},
) {
  const chain = [];
  let current = coordinates;
  let remoteParentAttempts = 0;
  for (let depth = 0; current && depth < MAX_POM_PARENT_DEPTH; depth++) {
    let xml = readLocalPom(current.group, current.name, current.version);
    if (
      !xml &&
      remote &&
      coordinates.urlPrefix &&
      (depth === 0 || remoteParentAttempts < remoteParents)
    ) {
      if (depth > 0) {
        remoteParentAttempts++;
      }
      xml = await fetchRemotePomXml({
        urlPrefix: coordinates.urlPrefix,
        group: current.group,
        name: current.name,
        version: current.version,
      });
    }
    if (!xml) {
      break;
    }
    let json;
    try {
      json = xml2js(xml, POM_XML_OPTIONS).project;
    } catch (_err) {
      json = undefined;
    }
    if (!json) {
      break;
    }
    chain.push({ json, xml });
    const merged = mergePomChain(chain);
    if (
      parseLicenseEntryOrArrayFromPomXml(merged.licenses?.license) &&
      merged.organization?.name?._ &&
      merged.scm?.url?._
    ) {
      break;
    }
    const parent = json.parent;
    current =
      parent?.groupId?._ && parent?.artifactId?._ && parent?.version?._
        ? {
            group: parent.groupId._,
            name: parent.artifactId._,
            version: parent.version._,
          }
        : undefined;
  }
  if (!chain.length) {
    return undefined;
  }
  return { merged: mergePomChain(chain), ownXml: chain[0].xml };
}

/**
 * Merge POM levels so that nearer levels win, as Maven inheritance does for
 * the elements cdxgen reads.
 *
 * @param {Array<{json: Object}>} chain Levels, child first.
 * @returns {Object} Merged POM.
 */
function mergePomChain(chain) {
  let merged = {};
  for (let i = chain.length - 1; i >= 0; i--) {
    merged = { ...merged, ...chain[i].json };
  }
  return merged;
}

/**
 * A lookup of the jar namespace entry for a package. The jar data is keyed by the
 * POM coordinates of the jar, while sbt (and the Mill and scala-cli paths)
 * emit components with the Scala binary suffix stripped and a repository_url
 * qualifier. Both spellings resolve to the same qualifier-free coordinate
 * key, with the exact purl still winning when it matches. A cache can hold
 * the same library for several Scala versions (`foo_2.13` and `foo_3`); the
 * jar whose binary version matches the component's cdx:scala:compilerVersion
 * speaks for it, and when that cannot be told only the namespaces, which the
 * cross builds share, are taken.
 *
 * @param {Object} jarNSMapping Namespace and hash data from jar analysis.
 * @returns {(p: Object) => {entry?: Object, exact?: Boolean}} Entry lookup.
 */
function scalaJarEntryLookup(jarNSMapping) {
  const coordinateIndex = new Map();
  for (const apurl of Object.keys(jarNSMapping || {})) {
    const coordinate = scalaCoordinateOfPurl(apurl);
    if (!coordinate) {
      continue;
    }
    if (!coordinateIndex.has(coordinate.key)) {
      coordinateIndex.set(coordinate.key, new Map());
    }
    const byBinaryVersion = coordinateIndex.get(coordinate.key);
    const binaryVersion = coordinate.binaryVersion || "";
    if (!byBinaryVersion.has(binaryVersion)) {
      byBinaryVersion.set(binaryVersion, apurl);
    }
  }
  return (pkg) => {
    if (!pkg.purl) {
      return undefined;
    }
    if (jarNSMapping[pkg.purl]) {
      return { entry: jarNSMapping[pkg.purl], exact: true };
    }
    const byBinaryVersion = coordinateIndex.get(
      scalaCoordinateOfPurl(pkg.purl)?.key,
    );
    if (!byBinaryVersion) {
      return undefined;
    }
    const wanted = pkg.properties?.find(
      (prop) => prop.name === "cdx:scala:compilerVersion",
    )?.value;
    if (wanted && byBinaryVersion.has(wanted)) {
      return { entry: jarNSMapping[byBinaryVersion.get(wanted)], exact: true };
    }
    const candidates = [...byBinaryVersion.values()];
    return {
      entry: jarNSMapping[candidates[0]],
      exact: candidates.length === 1,
    };
  };
}

/**
 * Enrich one package from data already on disk: the jar namespace map, the
 * POM that jar analysis parsed, the local jar's hashes and the local POM
 * chain. No request is made.
 *
 * @param {Object} p Package.
 * @param {Function} jarNSEntryFor Jar namespace entry lookup for a package.
 * @returns {Promise<void>}
 */
async function enrichMvnPackageLocally(p, jarNSEntryFor) {
  const { entry: nsEntry, exact } = jarNSEntryFor(p) || {};
  if (nsEntry) {
    // A jar copied into a temporary directory, as Maven --deep copies the
    // dependencies, is deleted with the scan, and its path would make the BOM
    // differ between two runs. The identity the dependency tree gave the
    // package stands.
    if (nsEntry.jarFile && exact && !isInsideTmpDir(nsEntry.jarFile)) {
      p.evidence = {
        identity: {
          field: "purl",
          confidence: 0.8,
          methods: [
            {
              technique: "binary-analysis",
              confidence: 0.8,
              value: nsEntry.jarFile,
            },
          ],
        },
      };
    }
    if (nsEntry.hashes && exact && !p?.hashes?.length) {
      p.hashes = nsEntry.hashes;
    }
    if (nsEntry.namespaces?.length) {
      if (!p.properties) {
        p.properties = [];
      }
      p.properties.push({
        name: "internal:Namespaces",
        value: nsEntry.namespaces.join("\n"),
      });
    }
    // The POM jar analysis already parsed.
    const nsPom = nsEntry.pom;
    if (nsPom) {
      if (!p.publisher && nsPom.organization?.name?._) {
        p.publisher = nsPom.organization.name._;
      }
      if (!p.description && nsPom.description) {
        p.description = tidyPomDescription(nsPom.description);
      }
      if (!p.repository && nsPom.scm) {
        p.repository = { url: nsPom.scm };
      }
      if (!hasMavenLicense(p)) {
        const license = parseLicenseEntryOrArrayFromPomXml(nsPom.licenses);
        if (license) {
          p.license = license;
        }
      }
    }
  }
  // Scala components are named without their Scala binary suffix, while the
  // published artifact carries it. The published name is looked up first and
  // the component name is the local fallback; a disk read costs nothing.
  const publishedName = publishedArtifactId(p);
  const primaryArtifact = findLocalMvnArtifact(
    p.group,
    publishedName,
    p.version,
  );
  const localArtifact =
    primaryArtifact ||
    (publishedName !== p.name
      ? findLocalMvnArtifact(p.group, p.name, p.version)
      : null);
  const pomChainName = primaryArtifact ? publishedName : p.name;
  if (localArtifact?.jarPath && (!p.hashes || p.hashes.length === 0)) {
    try {
      const hashValues = await multiChecksumFile(
        ["md5", "sha1", "sha256", "sha512"],
        localArtifact.jarPath,
      );
      p.hashes = [
        { alg: "MD5", content: hashValues["md5"] },
        { alg: "SHA-1", content: hashValues["sha1"] },
        { alg: "SHA-256", content: hashValues["sha256"] },
        { alg: "SHA-512", content: hashValues["sha512"] },
      ];
    } catch (_err) {
      if (localArtifact.sha1) {
        p.hashes = [{ alg: "SHA-1", content: localArtifact.sha1 }];
      }
    }
  }
  if (localArtifact?.pomPath) {
    const chain = await loadPomChain(
      { group: p.group, name: pomChainName, version: p.version },
      { remote: false },
    );
    applyPomMetadata(p, chain?.merged, chain?.ownXml);
  }
}

/**
 * Method to retrieve metadata for maven packages, from the local caches first
 * and from Maven Central only for what remains.
 *
 * Every package is first enriched from data on disk. Only when license
 * fetching is enabled (FETCH_LICENSE) or `force` is set are the packages
 * still without a licence looked up remotely, and then only those a public
 * repository can hold.
 *
 * @param {Array} pkgList Package list
 * @param {Object} jarNSMapping Jar Namespace mapping object
 * @param {Boolean} force Force fetching of license
 * @param {{skipPurls?: Set<string>}} [context] Purls or bom-refs of the
 *   project's own modules, which are never looked up remotely.
 *
 * @returns {Array} Updated package list
 */
export async function getMvnMetadata(
  pkgList,
  jarNSMapping = {},
  force = false,
  context = {},
) {
  if (!pkgList?.length) {
    return pkgList;
  }
  const repos = {
    MAVEN_CENTRAL_URL: withTrailingSlash(
      readEnvironmentVariable("MAVEN_CENTRAL_URL") ||
        "https://repo1.maven.org/maven2/",
    ),
    ANDROID_MAVEN_URL: withTrailingSlash(
      readEnvironmentVariable("ANDROID_MAVEN_URL") ||
        "https://maven.google.com/",
    ),
  };
  const jarNSEntryFor = scalaJarEntryLookup(jarNSMapping);
  for (const p of pkgList) {
    await enrichMvnPackageLocally(p, jarNSEntryFor);
  }
  if (!shouldFetchLicense() && !force) {
    return pkgList;
  }
  const remoteItems = [];
  for (const p of pkgList) {
    if (hasMavenLicense(p)) {
      continue;
    }
    const urlPrefix = mavenRepositoryFor(p, repos, context);
    if (urlPrefix) {
      // The remote round asks only for the published name: the component
      // name has no POM where the artifact is suffixed.
      remoteItems.push({
        p,
        coordinates: {
          urlPrefix,
          group: p.group,
          name: publishedArtifactId(p),
          version: p.version,
        },
      });
    }
  }
  if (!remoteItems.length) {
    return pkgList;
  }
  if (DEBUG_MODE) {
    console.log(
      `About to query maven for ${remoteItems.length} of ${pkgList.length} packages`,
    );
  }
  // The direct POMs not on disk are fetched in one batched round. Parent URLs
  // depend on the direct POM's content, so parents are read in the loop below.
  const batchUrls = [];
  const seenPomUrls = new Set();
  for (const { coordinates } of remoteItems) {
    const pomUrl = composePomXmlUrl(coordinates);
    if (
      seenPomUrls.has(pomUrl) ||
      readLocalPom(coordinates.group, coordinates.name, coordinates.version)
    ) {
      continue;
    }
    seenPomUrls.add(pomUrl);
    batchUrls.push({ url: pomUrl, responseType: "text" });
  }
  const ownPomUrls = [];
  if (batchUrls.length) {
    for (const [key, value] of await prefetchJson(batchUrls)) {
      prefetchedPoms.set(key, value);
      ownPomUrls.push(key);
    }
  }
  try {
    const needRepoLicense = [];
    for (const item of remoteItems) {
      try {
        const chain = await loadPomChain(item.coordinates, {
          remote: true,
          remoteParents: 1,
        });
        applyPomMetadata(item.p, chain?.merged, chain?.ownXml);
      } catch (err) {
        if (DEBUG_MODE) {
          console.log(
            `An error occurred when trying to fetch metadata for ${item.p.group}/${item.p.name}@${item.p.version}`,
            err,
          );
        }
      }
      if (!hasMavenLicense(item.p) && item.p.repository?.url) {
        needRepoLicense.push(item.p);
      }
    }
    // The repository licence is the last resort, asked for only once the POM
    // and all of its parents have been read, and batched.
    if (needRepoLicense.length) {
      await prefetchRepoLicenses(needRepoLicense.map((p) => p.repository.url));
      for (const p of needRepoLicense) {
        const license = await getRepoLicense(p.repository.url, undefined);
        if (license) {
          p.license = license;
        }
      }
    }
  } finally {
    // Each body is read once, by the loop above. Holding them past that only
    // grows the process, which matters in server mode where one process serves
    // many scans. Only the documents this call fetched are dropped, so a scan
    // running alongside this one keeps its own.
    for (const pomUrl of ownPomUrls) {
      prefetchedPoms.delete(pomUrl);
    }
  }
  return pkgList;
}

/**
 * Method to compose URL of pom.xml
 *
 * @param {String} urlPrefix
 * @param {String} group
 * @param {String} name
 * @param {String} version
 *
 * @return {String} fullUrl
 */
export function composePomXmlUrl({ urlPrefix, group, name, version }) {
  const groupPart = group.replace(/\./g, "/");
  return `${urlPrefix + groupPart}/${name}/${version}/${name}-${version}.pom`;
}

/**
 * Method to fetch pom.xml data and parse it to JSON, merged with its parents.
 *
 * Each level is read from the local caches first. When a parent cannot be
 * found, the child and any nearer parents are still returned.
 *
 * @param {String} urlPrefix
 * @param {String} group
 * @param {String} name
 * @param {String} version
 *
 * @return {Object|undefined}
 */
export async function fetchPomXmlAsJson({ urlPrefix, group, name, version }) {
  const chain = await loadPomChain(
    {
      urlPrefix: urlPrefix ? withTrailingSlash(urlPrefix) : undefined,
      group,
      name,
      version,
    },
    { remote: Boolean(urlPrefix), remoteParents: 1 },
  );
  return chain?.merged;
}

/**
 * Prefetched POM documents, populated by `getMvnMetadata` before its loop and
 * read by `fetchRemotePomXml`. Module state rather than a parameter because
 * the POM readers are reached from several exported entry points.
 *
 * Only the *direct* POMs — the ones whose URLs are known before the loop — are
 * prefetched. Parent URLs depend on the direct POM's content, so they are not
 * known up front and are read serially.
 */
const prefetchedPoms = new Map();

/**
 * Fetch a POM from a remote repository, using a prefetched copy when there is
 * one and remembering 404s for a while.
 *
 * @param {{urlPrefix: string, group: string, name: string, version: string}} coordinates
 * @returns {Promise<string|undefined>} POM text.
 */
async function fetchRemotePomXml({ urlPrefix, group, name, version }) {
  if (!urlPrefix || !group || !name || !version) {
    return undefined;
  }
  const fullUrl = composePomXmlUrl({ urlPrefix, group, name, version });
  const missingUntil = missingPomUrls.get(fullUrl);
  if (missingUntil !== undefined) {
    if (missingUntil > Date.now()) {
      return undefined;
    }
    missingPomUrls.delete(fullUrl);
  }
  // Parent POMs and anything the batch missed fall through to a serial
  // request. It still counts against Maven Central's budget, so it queues
  // behind the same per-host gate as the batch round.
  try {
    const res =
      prefetchedResponse(prefetchedPoms, fullUrl) ||
      (await withHostRateLimit(
        fullUrl,
        (gate) => cdxgenAgent.get(fullUrl, gate),
        { deferGate: true },
      ));
    return res.body;
  } catch (err) {
    const status = err?.statusCode ?? err?.response?.statusCode;
    if (status === 404 || status === 410) {
      missingPomUrls.set(fullUrl, Date.now() + MISSING_POM_TTL_MS);
    }
    return undefined;
  }
}

/**
 * Method to fetch pom.xml data, from the local caches when present.
 *
 * @param {String} urlPrefix
 * @param {String} group
 * @param {String} name
 * @param {String} version
 *
 * @return {Promise<String>}
 */
export async function fetchPomXml({ urlPrefix, group, name, version }) {
  return (
    readLocalPom(group, name, version) ||
    (await fetchRemotePomXml({
      urlPrefix: urlPrefix ? withTrailingSlash(urlPrefix) : undefined,
      group,
      name,
      version,
    }))
  );
}

/**
 * Method extract single or multiple license entries that might appear in pom.xml
 *
 * @param {Object|Array} license
 */
export function parseLicenseEntryOrArrayFromPomXml(license) {
  if (!license) return;
  if (Array.isArray(license)) {
    return license.map((l) => {
      return findLicenseId(l.name?._);
    });
  }
  if (Object.keys(license).length) {
    return [findLicenseId(license.name?._)];
  }
}

/**
 * Method to parse pom.xml in search of a comment containing license text
 *
 * @param {String} urlPrefix
 * @param {String} group
 * @param {String} name
 * @param {String} version
 *
 * @return {Promise<String>} License ID
 */
export async function extractLicenseCommentFromPomXml({
  urlPrefix,
  group,
  name,
  version,
}) {
  return licenseFromPomComment(
    await fetchPomXml({ urlPrefix, group, name, version }),
  );
}

/**
 * Method to mimic pip version solver using node-semver
 *
 * @param {Array} versionsList List of version numbers available
 * @param {*} versionSpecifiers pip version specifier
 */
export function guessPypiMatchingVersion(versionsList, versionSpecifiers) {
  versionSpecifiers = versionSpecifiers.replace(/,/g, " ").split(";")[0];
  const comparator = (a, b) => {
    if (!a && !b) {
      return 0;
    }
    if (!a || !coerce(a, { loose: true })) {
      return -1;
    }
    let c = coerce(a, { loose: true }).compare(coerce(b, { loose: true }));
    // if coerced versions are "equal", compare them as strings
    if (c === 0) {
      c = a < b ? -1 : 1;
    }
    return -c;
  };
  // Iterate in the "reverse" order
  for (const rv of versionsList.sort(comparator)) {
    if (satisfies(coerce(rv, { loose: true }), versionSpecifiers, true)) {
      return rv;
    }
  }
  // Let's try to clean and have another go
  return maxSatisfying(versionsList, clean(versionSpecifiers, { loose: true }));
}

/**
 * Whether PyPI, or the index PYPI_URL points at, can hold the package.
 *
 * The Python parsers record where each package came from. A virtual workspace
 * root, an editable install, and a git, URL or path source are not index
 * releases; Poetry records a private index the same way, as the package's
 * source URL. A package from another index is asked only when PYPI_URL points
 * at that index's server. Asking PyPI about any of them leaks the name and
 * attaches a look-alike's licence.
 *
 * @param {Object} p Package object with the properties the Python parsers record.
 * @param {string} pypiUrl The JSON API base cdxgen asks.
 * @returns {boolean}
 */
function canPypiServe(p, pypiUrl) {
  const props = {};
  for (const prop of p.properties || []) {
    props[prop.name] = prop.value;
  }
  if (props["internal:virtual_path"]) {
    return false;
  }
  const sourceType = props["cdx:pypi:manifestSourceType"];
  if (
    sourceType &&
    !(
      sourceType === "url" &&
      isDefaultPypiRegistry(props["cdx:pypi:manifestSource"])
    )
  ) {
    return false;
  }
  if ((p.externalReferences || []).some((ref) => ref.type === "vcs")) {
    return false;
  }
  // The registry property is recorded only for a non-default index.
  const registry = props["cdx:pypi:registry"];
  if (registry && !isDefaultPypiRegistry(registry)) {
    const host = parseUrl(registry)?.host;
    return !!host && host === parseUrl(pypiUrl)?.host;
  }
  return true;
}

/**
 * Whether a package already carries what a PyPI lookup would be asked for: a
 * licence and a version from the lockfile or an installed distribution. When
 * registry provenance is wanted it is still asked, since nothing local holds
 * that.
 *
 * @param {Object} p Package object.
 * @returns {boolean}
 */
function pypiAnsweredLocally(p) {
  return !!(p.license && p.version) && !shouldFetchRegistryProvenance();
}

/**
 * The PyPI path for a package, or `undefined` when the package will not be
 * queried at all.
 *
 * Shared by the batch prefetch and the request inside the loop so the two
 * cannot construct different URLs. It deliberately reproduces the loop's skip
 * conditions — a URL built for a package the loop skips would be a request the
 * JS path never makes, which is both wasted work and a divergence.
 *
 * @param {Object} p Package object.
 * @param {string} pypiUrl The JSON API base cdxgen asks.
 * @returns {string|undefined} Path to append to PYPI_URL.
 */
function pyUrlAddition(p, pypiUrl) {
  if (!p?.name) {
    return undefined;
  }
  // A package PyPI cannot hold is not queried.
  if (!canPypiServe(p, pypiUrl)) {
    return undefined;
  }
  // A URL as a name, or a package that already has both fields, is not queried.
  if (p.name.includes("https") || pypiAnsweredLocally(p)) {
    return undefined;
  }
  // Extras (`requests[security]`) are not part of the PyPI path.
  const name = p.name.includes("[") ? p.name.split("[")[0] : p.name;
  return p.version?.trim().length
    ? `${name}/${p.version.trim()}/json`
    : `${name}/json`;
}

// PyPI URLs that answered 404 or 410. getPyMetadata runs more than once over
// the same packages, and a miss is asked about once. Entries expire so that a
// long-running server sees new releases.
const missingPypiUrls = new Map();
const MISSING_PYPI_TTL_MS = 60 * 60 * 1000;

/**
 * Whether a PyPI URL recently answered 404 or 410.
 *
 * @param {string} url PyPI JSON API URL.
 * @returns {boolean} True while the miss is remembered.
 */
function isKnownMissingPypiUrl(url) {
  const missingUntil = missingPypiUrls.get(url);
  if (missingUntil === undefined) {
    return false;
  }
  if (missingUntil > Date.now()) {
    return true;
  }
  missingPypiUrls.delete(url);
  return false;
}

/**
 * Whether a failed PyPI request means the project or version does not exist,
 * as opposed to a rate limit, a timeout or a server error, which say nothing
 * about the name.
 *
 * @param {Error} err Error from the agent or the batch prefetch.
 * @returns {boolean} True for 404 and 410.
 */
function isPypiNotFound(err) {
  const status = err?.statusCode ?? err?.response?.statusCode;
  return status === 404 || status === 410;
}

/**
 * Fetch a PyPI JSON document, from the batch prefetch when it holds one, and
 * fail at once for a URL that already answered 404 or 410.
 *
 * @param {string} url PyPI JSON API URL.
 * @param {Map} [prefetched] Results of the batch prefetch.
 * @returns {Promise<Object>} Response with `body`.
 */
async function getPypiDocument(url, prefetched) {
  if (isKnownMissingPypiUrl(url)) {
    const err = new Error("Request failed with status code 404");
    err.statusCode = 404;
    throw err;
  }
  try {
    return (
      prefetchedResponse(prefetched, url) ||
      (await cdxgenAgent.get(url, { responseType: "json" }))
    );
  } catch (err) {
    if (isPypiNotFound(err)) {
      missingPypiUrls.set(url, Date.now() + MISSING_PYPI_TTL_MS);
    }
    throw err;
  }
}

/**
 * Method to retrieve metadata for python packages by querying pypi
 *
 * @param {Array} pkgList Package list
 * @param {Boolean} fetchDepsInfo Fetch dependencies info from pypi
 */
export async function getPyMetadata(pkgList, fetchDepsInfo) {
  if (!shouldFetchPackageMetadata() && !fetchDepsInfo) {
    return pkgList;
  }
  const PYPI_URL =
    readEnvironmentVariable("PYPI_URL") || "https://pypi.org/pypi/";
  const cdepList = [];
  // One batched round for the primary lookups. The `django-` retry below is not
  // prefetched: it only fires when the primary 404s, so batching it would issue
  // a request the serial path never makes for every package that resolves.
  const prefetched = await prefetchJson(
    prefetchEnabled()
      ? pkgList
          .map((p) => pyUrlAddition(p, PYPI_URL))
          .filter(Boolean)
          .map((addition) => PYPI_URL + addition)
          .filter((url) => !isKnownMissingPypiUrl(url))
          .map((url) => ({ url }))
      : [],
  );
  for (const p of pkgList) {
    if (!p?.name) {
      continue;
    }
    try {
      // Module names are derived from the distribution name and the curated alias
      // map, so they are available without a registry round trip and are attached
      // before the skip below rather than after it.
      applyPypiModuleNames(p);
      // A package PyPI cannot hold keeps the answers the lockfile gave it.
      if (!canPypiServe(p, PYPI_URL)) {
        cdepList.push(p);
        continue;
      }
      // If the package name has a url or already includes license and version skip it
      if (p.name.includes("https") || pypiAnsweredLocally(p)) {
        cdepList.push(p);
        continue;
      }
      const origName = p.name;
      // Some packages support extra modules
      if (p.name.includes("[")) {
        p.name = p.name.split("[")[0];
      }
      let res;
      let url_addition;
      if (p.version?.trim().length) {
        url_addition = `${p.name}/${p.version.trim()}/json`;
      } else {
        url_addition = `${p.name}/json`;
      }
      try {
        res = await getPypiDocument(PYPI_URL + url_addition, prefetched);
      } catch (err) {
        // Only a missing project means the name may be the Django plugin's.
        // A rate limit, a timeout or a server error says nothing about the
        // name, and renaming the package then would give it another
        // project's identity.
        if (!isPypiNotFound(err)) {
          throw err;
        }
        res = await getPypiDocument(`${PYPI_URL}django-${url_addition}`);
        p.name = `django-${p.name}`;
      }
      const body = res.body;
      // The registry fills only what the lockfile and the installed
      // distribution left open, so a local answer survives the round.
      let registryAuthor;
      if (body.info.author && body.info.author.trim() !== "") {
        if (body.info.author_email && body.info.author_email.trim() !== "") {
          registryAuthor = `${body.info.author.trim()} <${body.info.author_email.trim()}>`;
        } else {
          registryAuthor = body.info.author.trim();
        }
      } else if (
        body.info.author_email &&
        body.info.author_email.trim() !== ""
      ) {
        registryAuthor = body.info.author_email.trim();
      }
      if (registryAuthor && !p.author) {
        p.author = registryAuthor;
      }
      if (
        p.name !== body.info?.name &&
        p.name.toLowerCase() === body.info?.name.toLowerCase()
      ) {
        p.name = body.info.name;
      }
      if (!p.description) {
        p.description = body.info.summary;
      }
      const registryLicenses = [];
      if (body.info.classifiers) {
        for (const c of body.info.classifiers) {
          if (c.startsWith("License :: ")) {
            const licenseName = c.split("::").slice(-1)[0].trim();
            const licenseId = findLicenseId(licenseName);
            if (licenseId && !registryLicenses.includes(licenseId)) {
              registryLicenses.push(licenseId);
            }
          }
        }
        applyPypiClassifierMetadata(p, body.info.classifiers);
      }
      for (const declared of [
        body.info.license,
        body.info.license_expression,
      ]) {
        const licenseId = declared ? findLicenseId(declared) : undefined;
        if (licenseId && !registryLicenses.includes(licenseId)) {
          registryLicenses.push(licenseId);
        }
      }
      if (!(Array.isArray(p.license) ? p.license.length : p.license)) {
        p.license = registryLicenses;
      }
      if (body.info.home_page) {
        if (body.info.home_page.includes("git")) {
          if (!p.repository) {
            p.repository = { url: body.info.home_page };
          }
        } else if (!p.homepage) {
          p.homepage = { url: body.info.home_page };
        }
      }
      // Use the latest version if none specified
      if (!p.version?.trim().length) {
        let versionSpecifiers;
        if (p.properties?.length) {
          for (const pprop of p.properties) {
            if (pprop.name === "cdx:pypi:versionSpecifiers") {
              versionSpecifiers = pprop.value;
              break;
            }
          }
        } else if (
          p.version &&
          (p.version.includes("*") ||
            p.version.includes("<") ||
            p.version.includes(">") ||
            p.version.includes("!"))
        ) {
          versionSpecifiers = p.version;
        }
        if (versionSpecifiers) {
          p.version = guessPypiMatchingVersion(
            Object.keys(body.releases || {}),
            versionSpecifiers,
          );
          // Indicate the confidence with our guess
          p.evidence = {
            identity: {
              field: "version",
              confidence: 0.6,
              methods: [
                {
                  technique: "manifest-analysis",
                  confidence: 0.6,
                  value: `Version specifiers: ${versionSpecifiers}`,
                },
              ],
            },
          };
        }
        // If we have reached here, it means we have not solved the version
        // So assume latest
        if (!p.version) {
          p.version = body.info.version;
          // Indicate the low confidence
          p.evidence = {
            identity: {
              field: "version",
              confidence: 0.5,
              methods: [
                {
                  technique: "source-code-analysis",
                  confidence: 0.5,
                  value: `PyPI package: ${p.name}`,
                },
              ],
            },
          };
        }
      } else if (p.version !== body.info.version) {
        if (!p.properties) {
          p.properties = [];
        }
        p.properties.push({
          name: "cdx:pypi:latest_version",
          value: body.info.version,
        });
        p.properties.push({
          name: "cdx:pypi:resolved_from",
          value: origName,
        });
      }
      const releaseEntries = body.releases?.[p.version]?.length
        ? body.releases[p.version]
        : Array.isArray(body.urls)
          ? body.urls
          : [];
      mergeExternalReferences(
        p,
        collectPypiReleaseExternalReferences(releaseEntries),
      );
      if (releaseEntries.length) {
        const digest = releaseEntries[0].digests;
        if (digest["sha256"]) {
          p._integrity = `sha256-${digest["sha256"]}`;
        } else if (digest["md5"]) {
          p._integrity = `md5-${digest["md5"]}`;
        }
      }
      const purlString = build({
        type: "pypi",
        namespace: "" || null,
        name: p.name.toLowerCase(),
        version: p.version || null,
      });
      p.properties = p.properties || [];
      p.properties.push(
        ...collectPypiRegistryProvenanceProperties(body, p.version),
      );
      p.purl = purlString;
      p["bom-ref"] = decodeURIComponent(purlString);
      cdepList.push(p);
    } catch (_err) {
      if (DEBUG_MODE) {
        console.error(p.name, "is not found on PyPI.");
        console.log(
          "If this package is available from PyPI or a registry, its name might be different from the module name. Raise a ticket at https://github.com/cdxgen/cdxgen/issues so that this can be added to the mapping file pypi-pkg-aliases.json",
        );
        console.log(
          "Alternatively, if this is a package that gets installed directly in your environment and offers a python binding, then track such packages manually.",
        );
      }
      if (!p.version) {
        if (DEBUG_MODE) {
          console.log(
            `Assuming the version as latest for the package ${p.name}`,
          );
        }
        p.version = "latest";
        // Indicate the low confidence
        p.evidence = {
          identity: {
            field: "version",
            confidence: 0,
            methods: [
              {
                technique: "source-code-analysis",
                confidence: 0,
                value: `Module ${p.name}`,
              },
            ],
          },
        };
      }
      const purlString = build({
        type: "pypi",
        namespace: "" || null,
        name: p.name.toLowerCase(),
        version: p.version || null,
      });
      p.purl = purlString;
      p["bom-ref"] = decodeURIComponent(purlString);
      cdepList.push(p);
    }
  }
  return cdepList;
}

/**
 * Method to parse bdist_wheel metadata (dist-info/METADATA)
 *
 * @param {string} mDataFile bdist_wheel metadata file
 * @param {string} rawMetadata Raw metadata
 *
 */
export function parseBdistMetadata(mDataFile, rawMetadata = undefined) {
  const mData = rawMetadata || readFileSync(mDataFile, { encoding: "utf-8" });
  const pkg = {
    name: "",
    version: "",
    description: "",
    author: "",
    licenses: [],
    externalReferences: [],
    properties: [],
  };
  if (mDataFile) {
    pkg.properties.push({ name: "internal:SrcFile", value: mDataFile });
  }
  const lines = mData.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  let isBody = false;
  for (const line of lines) {
    if (line.trim() === "") {
      isBody = true;
      continue;
    }
    if (isBody) break;
    const firstColon = line.indexOf(":");
    if (firstColon === -1) continue;
    const key = line.substring(0, firstColon).trim().toLowerCase();
    const value = line.substring(firstColon + 1).trim();
    switch (key) {
      case "name":
        pkg.name = value;
        break;
      case "version":
        pkg.version = value;
        break;
      case "summary":
        pkg.description = value;
        break;
      case "author":
      case "maintainer":
        pkg.publisher = value;
        pkg.author = value;
        break;
      case "license-expression":
        pkg.licenses.push({
          expression: value,
        });
        break;
      case "license":
        if (value !== "UNKNOWN" && pkg.licenses.length === 0) {
          pkg.licenses.push({
            license: {
              name: value,
            },
          });
        }
        break;
      case "home-page":
        pkg.homepage = {
          url: value,
        };
        pkg.externalReferences.push({
          type: "website",
          url: value,
        });
        break;
      case "project-url": {
        const commaIndex = value.indexOf(",");
        if (commaIndex > -1) {
          const label = value.substring(0, commaIndex).trim();
          const url = value.substring(commaIndex + 1).trim();
          const lowerLabel = label.toLowerCase();
          let type = "website";
          if (
            ["source", "source code", "repository", "git"].includes(lowerLabel)
          ) {
            type = "vcs";
            pkg.repository = {
              url: url,
            };
          } else if (
            ["tracker", "bug tracker", "issue tracker", "issues"].includes(
              lowerLabel,
            )
          ) {
            type = "issue-tracker";
          } else if (["changelog", "changes", "history"].includes(lowerLabel)) {
            type = "release-notes";
          } else if (["documentation", "docs"].includes(lowerLabel)) {
            type = "documentation";
          } else if (["funding", "sponsor", "donation"].includes(lowerLabel)) {
            type = "other";
          }
          pkg.externalReferences.push({
            type: type,
            url: url,
            comment: label,
          });
        }
        break;
      }
      case "keywords":
        if (value) {
          pkg.keywords = value.split(",").map((k) => k.trim());
        }
        break;
      case "requires-python":
        pkg.properties.push({
          name: "cdx:python:requires_python",
          value: value,
        });
        break;
    }
  }
  if (mDataFile) {
    pkg.evidence = {
      identity: {
        field: "purl",
        confidence: 0.5,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 0.5,
            value: mDataFile,
          },
        ],
      },
    };
  }
  applyPurl(pkg, pypiPurl(pkg.name, pkg.version));
  return [pkg];
}

/**
 * Build a stable dedupe key for an external reference from its type/url/comment.
 *
 * @param {{type: string, url: string, comment?: string}} reference External reference.
 * @returns {string} JSON-stringified dedupe key.
 */
export function createExternalReferenceKey(reference) {
  return JSON.stringify([
    reference.type,
    reference.url,
    reference.comment || "",
  ]);
}

/**
 * Merge external references onto a component, skipping duplicates.
 *
 * @param {object} component Component to enrich with external references.
 * @param {Array<{type: string, url: string, comment?: string}>} references References to merge.
 * @returns {void}
 */
export function mergeExternalReferences(component, references) {
  if (!references?.length) {
    return;
  }
  const existingReferences = component.externalReferences || [];
  const seen = new Set(
    existingReferences.map((reference) =>
      createExternalReferenceKey(reference),
    ),
  );
  for (const reference of references) {
    const dedupeKey = createExternalReferenceKey(reference);
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    existingReferences.push(reference);
  }
  if (existingReferences.length) {
    component.externalReferences = existingReferences;
  }
}

function collectPypiReleaseExternalReferences(releaseEntries) {
  const externalReferences = [];
  for (const releaseEntry of releaseEntries || []) {
    if (typeof releaseEntry?.url !== "string" || !releaseEntry.url.trim()) {
      continue;
    }
    externalReferences.push({
      type: "distribution",
      url: releaseEntry.url.trim(),
      comment: releaseEntry.filename || releaseEntry.packagetype,
    });
  }
  return externalReferences;
}

/**
 * Method to construct a GitHub API url for the given repo metadata
 * @param {Object} repoMetadata Repo metadata with group and name
 * @return {String|undefined} github api url (or undefined - if not enough data)
 */
export function repoMetadataToGitHubApiUrl(repoMetadata) {
  if (repoMetadata) {
    const group = repoMetadata.group;
    const name = repoMetadata.name;
    // GITHUB_API_URL is what GitHub Actions itself sets, and it is what a
    // GitHub Enterprise user needs. It also makes this path testable without
    // reaching the real api.github.com, which is why the licence lookups had no
    // offline coverage before.
    const apiBase = (
      readEnvironmentVariable("GITHUB_API_URL") || "https://api.github.com"
    ).replace(/\/$/, "");
    let ghUrl = `${apiBase}/repos`;
    if (group && group !== "." && group !== "") {
      ghUrl = `${ghUrl}/${group.replace("github.com/", "")}`;
    }
    ghUrl = `${ghUrl}/${name}`;
    return ghUrl;
  }
  return undefined;
}

/**
 * Method to split GitHub url into its parts
 * @param {String} repoUrl Repository url
 * @return {[String]} parts from url
 */
export function getGithubUrlParts(repoUrl) {
  if (repoUrl.toLowerCase().endsWith(".git")) {
    repoUrl = repoUrl.slice(0, -4);
  }
  repoUrl.replace(/\/$/, "");
  return repoUrl.split("/");
}

/**
 * Method to construct GitHub api url from repo metadata or one of multiple formats of repo URLs
 * @param {String} repoUrl Repository url
 * @param {Object} repoMetadata Object containing group and package name strings
 * @return {String|undefined} github api url (or undefined - if not a GitHub repo)
 */
export function toGitHubApiUrl(repoUrl, repoMetadata) {
  if (repoMetadata) {
    return repoMetadataToGitHubApiUrl(repoMetadata);
  }
  const parts = getGithubUrlParts(repoUrl);
  if (parts.length < 5 || parts[2] !== "github.com") {
    return undefined; // Not a valid GitHub repo URL
  }
  return repoMetadataToGitHubApiUrl({
    group: parts[3],
    name: parts[4],
  });
}

/**
 * Method to retrieve repo license by querying github api
 *
 * @param {String} repoUrl Repository url
 * @param {Object} repoMetadata Object containing group and package name strings
 * @return {Promise<String>} SPDX license id
 */
/**
 * URLs for repository licence lookups, prefetched by {@link prefetchRepoLicenses}.
 *
 * Module state rather than a parameter because `getRepoLicense` is called from
 * eight places, several of them deep inside other metadata functions, and
 * threading a map through all of them would be a wide change for no gain. A
 * miss simply means the lookup issues its own request.
 */
let repoLicensePrefetch = new Map();

/**
 * Prefetch the GitHub licence endpoint for a list of repository URLs.
 *
 * The single biggest remaining serialisation: `getRepoLicense` is called once
 * per component from npm, Maven, Swift and Go, each call a full round trip to
 * api.github.com. Batching them also makes the authenticated concurrency
 * allowance worth having — with `GITHUB_TOKEN` set, cdxrs runs eight of these at
 * a time instead of one.
 *
 * @param {Array<string|undefined>} repoUrls Repository URLs (duplicates and
 *   empties are fine).
 * @returns {Promise<void>}
 */
export async function prefetchRepoLicenses(repoUrls) {
  if (!prefetchEnabled() || !Array.isArray(repoUrls)) {
    return;
  }
  const requests = [];
  const seen = new Set();
  for (const repoUrl of repoUrls) {
    if (!repoUrl) {
      continue;
    }
    const apiUrl = toGitHubApiUrl(repoUrl, undefined);
    if (!apiUrl) {
      continue;
    }
    const licenseUrl = `${apiUrl}/license`;
    if (seen.has(licenseUrl)) {
      continue;
    }
    seen.add(licenseUrl);
    requests.push({
      url: licenseUrl,
      // The realm keys the cache per repository, never on the token itself, so
      // an authenticated response cannot be served to an anonymous lookup.
      authRealm: readEnvironmentVariable("GITHUB_TOKEN")
        ? `github-auth:${apiUrl}`
        : undefined,
    });
  }
  if (!requests.length) {
    return;
  }
  const fetched = await prefetchJson(requests);
  for (const [key, value] of fetched) {
    repoLicensePrefetch.set(key, value);
  }
}

/**
 * Discard prefetched repository licences. Tests only.
 */
export function resetRepoLicensePrefetch() {
  repoLicensePrefetch = new Map();
}

/**
 * Fetch the license for a repository, primarily via the GitHub license API.
 *
 * Resolves the GitHub API license endpoint for the repository URL, deriving an
 * SPDX id from the response (or by scanning the license file content when the
 * API reports `NOASSERTION`). Honours any prefetched response.
 *
 * @param {string} repoUrl Repository URL.
 * @param {object} [repoMetadata] Optional repository metadata.
 * @returns {Promise<{url: string, id?: string, name?: string}|undefined>}
 *   Resolved license object, or undefined when no license can be determined.
 */
export async function getRepoLicense(repoUrl, repoMetadata) {
  if (!repoUrl) {
    return undefined;
  }
  const apiUrl = toGitHubApiUrl(repoUrl, repoMetadata);
  // Perform github lookups
  if (apiUrl && !repoLicenseLookupsPaused()) {
    const licenseUrl = `${apiUrl}/license`;
    const headers = {};
    if (readEnvironmentVariable("GITHUB_TOKEN")) {
      headers["Authorization"] =
        `Bearer ${readEnvironmentVariable("GITHUB_TOKEN")}`;
    }
    try {
      const res =
        prefetchedResponse(repoLicensePrefetch, licenseUrl) ||
        (await cdxgenAgent.get(licenseUrl, {
          responseType: "json",
          headers: headers,
        }));
      if (res?.body) {
        const license = res.body.license;
        let licenseId = license.spdx_id;
        const licObj = {
          url: res.body.html_url,
        };
        if (license.spdx_id === "NOASSERTION") {
          if (res.body.content) {
            const content = Buffer.from(res.body.content, "base64").toString(
              "ascii",
            );
            licenseId = guessLicenseId(content);
          }
          // If content match fails attempt to find by name
          if (!licenseId && license.name.toLowerCase() !== "other") {
            licenseId = findLicenseId(license.name);
            licObj["name"] = license.name;
          }
        }
        licObj["id"] = licenseId;
        if (licObj["id"] || licObj["name"]) {
          return licObj;
        }
      }
    } catch (err) {
      if (err?.message) {
        // GitHub signals an exhausted quota with a 403 and a zero remaining
        // count; over HTTP/2 there is no status text to match on.
        const rateLimited =
          err.message.includes("rate limit exceeded") ||
          (err.response?.statusCode === 403 &&
            String(err.response?.headers?.["x-ratelimit-remaining"]) === "0");
        if (rateLimited && !readEnvironmentVariable("GITHUB_TOKEN")) {
          console.log(
            "Rate limit exceeded for REST API of github.com. " +
              "Please ensure GITHUB_TOKEN is set as environment variable. " +
              "See: https://docs.github.com/en/rest/overview/rate-limits-for-the-rest-api",
          );
          get_repo_license_errors++;
        } else if (!err.message.includes("404")) {
          get_repo_license_errors++;
        }
      }
    }
  }
  return undefined;
}

/**
 * Documents from pkg.go.dev, prefetched by {@link prefetchGoPkgMetadata}.
 *
 * Module state for the same reason as {@link prefetchRepoLicenses}: the two
 * readers are called once per module from six Go parsers, and threading a map
 * through all of them would be a wide change for no gain. A miss means the
 * lookup issues its own request, exactly as before.
 */
let goPkgPrefetch = new Map();

/**
 * Prefetch the pkg.go.dev pages for a list of Go modules.
 *
 * Go was the last ecosystem making one round trip per module with the URL known
 * up front: `getGoPkgLicense` and `getGoPkgVCSUrl` are both called from inside
 * the parsers' loops, so a module list of any size was fetched strictly one at a
 * time. Both pages are HTML, which is why these requests carry
 * `responseType: "text"` and so run on the JS pool rather than through cdxrs.
 *
 * Callers must pass exactly the modules their loop will look up. A superset
 * issues requests the serial path never made; a subset only loses some of the
 * batching.
 *
 * @param {Array<{group?: string, name?: string}>} modules Modules about to be
 *   resolved. Duplicates and entries without a name are fine.
 * @returns {Promise<void>}
 */
export async function prefetchGoPkgMetadata(modules) {
  if (!prefetchEnabled() || !Array.isArray(modules)) {
    return;
  }
  const requests = [];
  const seen = new Set();
  for (const module of modules) {
    if (!module?.name) {
      continue;
    }
    const fullName =
      module.fullName || getGoPkgFullName(module.group, module.name);
    // A module the environment marks private is never requested.
    // getGoPkgLicense applies the same test, so the batch cannot ask for a
    // module the serial path would skip.
    if (isPrivateGoModule(fullName)) {
      continue;
    }
    const pkgUrl = getGoPkgUrl(module);
    // The licence tab and the module page are distinct documents, read by
    // getGoPkgLicense and getGoPkgVCSUrl respectively. Both are requested only
    // when the corresponding flag is on, so the batch mirrors that.
    const wanted = [];
    // A licence notice read on this machine answers the licence tab.
    if (shouldFetchLicense() && !module.licenseKnown) {
      wanted.push(`${pkgUrl}?tab=licenses`);
    }
    // getGoPkgVCSUrl derives github.com and gitlab.com URLs without asking
    // pkg.go.dev, so those modules must not be requested here either.
    if (shouldFetchVCS() && !isDirectlyResolvableGoVCS(module)) {
      wanted.push(pkgUrl);
    }
    for (const url of wanted) {
      if (seen.has(url) || metadata_cache[url]) {
        continue;
      }
      seen.add(url);
      requests.push({ url, responseType: "text" });
    }
  }
  if (!requests.length) {
    return;
  }
  const fetched = await prefetchJson(requests);
  for (const [key, value] of fetched) {
    goPkgPrefetch.set(key, value);
  }
}

/**
 * Discard prefetched pkg.go.dev documents. Tests only.
 */
export function resetGoPkgPrefetch() {
  goPkgPrefetch = new Map();
}

/**
 * Method to get go pkg license from go.dev site.
 *
 * @param {Object} repoMetadata Repo metadata
 */
export async function getGoPkgLicense(repoMetadata) {
  const group = repoMetadata.group;
  // A module the environment marks private is never sent to the public site.
  const fullName =
    repoMetadata.fullName ||
    getGoPkgFullName(repoMetadata.group, repoMetadata.name);
  if (isPrivateGoModule(fullName)) {
    return undefined;
  }
  const pkgUrl = `${getGoPkgUrl(repoMetadata)}?tab=licenses`;
  // Check the metadata cache first
  if (metadata_cache[pkgUrl]) {
    return metadata_cache[pkgUrl];
  }
  try {
    const res =
      prefetchedResponse(goPkgPrefetch, pkgUrl) ||
      (await cdxgenAgent.get(pkgUrl));
    if (res?.body) {
      const licenses = extractLicenseText(res.body);
      const licenseIds = licenses.split(", ");
      const licList = [];
      for (const id of licenseIds) {
        if (id.trim().length) {
          const alicense = {};
          if (id.includes(" ")) {
            // go.dev separates a package's licences by newline. The first break
            // ends the licence name, every later one joins another licence.
            let breakCount = 0;
            alicense.name = id
              .trim()
              .replaceAll(/ {2}/g, "")
              .replaceAll("\n", () => (breakCount++ === 0 ? " " : " OR "));
          } else {
            alicense.id = id.trim();
          }
          alicense["url"] = pkgUrl;
          licList.push(alicense);
        }
      }
      metadata_cache[pkgUrl] = licList;
      return licList;
    }
  } catch (_err) {
    return undefined;
  }
  if (modulePathHost(group, "github.com")) {
    return await getRepoLicense(undefined, repoMetadata);
  }
  return undefined;
}

/**
 * Method to get go pkg vcs url from go.dev site.
 *
 * @param {String} group Package group
 * @param {String} name Package name
 * @param {String} [version] Package version, part of the page URL
 */
export async function getGoPkgVCSUrl(group, name, version) {
  const fullName = getGoPkgFullName(group, name);
  if (isDirectlyResolvableGoVCS({ group, name })) {
    return `https://${fullName}`;
  }
  // The repository URL of a private module follows from a github.com or
  // gitlab.com path without a request, but pkg.go.dev is never asked.
  if (isPrivateGoModule(fullName)) {
    return undefined;
  }
  // The versioned page matches the URL the prefetch requested, so a prefetched
  // document is found in the cache.
  const pkgUrl = getGoPkgUrl({ fullName, version });
  if (metadata_cache[pkgUrl]) {
    return metadata_cache[pkgUrl];
  }
  try {
    const res =
      prefetchedResponse(goPkgPrefetch, pkgUrl) ||
      (await cdxgenAgent.get(pkgUrl));
    if (res?.body) {
      const vcs = extractRepoUrl(res.body);
      metadata_cache[pkgUrl] = vcs;
      return vcs;
    }
  } catch (_err) {
    return undefined;
  }
  return undefined;
}

/**
 * Whether a module's repository URL follows from its path alone, needing no
 * pkg.go.dev lookup.
 *
 * @param {Object} pkgMetadata pkg metadata with `group` and/or `name`
 * @returns {boolean} True for github.com and gitlab.com hosted modules
 */
function isDirectlyResolvableGoVCS(pkgMetadata) {
  const fullName =
    pkgMetadata.fullName ||
    getGoPkgFullName(pkgMetadata.group, pkgMetadata.name);
  return (
    modulePathHost(fullName, "github.com") ||
    modulePathHost(fullName, "gitlab.com")
  );
}

/**
 * Method to get go pkg url (go.dev site).
 *
 * The version is part of the URL whenever it is known, so pkg.go.dev answers
 * for the release the project pinned rather than for the latest one.
 *
 * @param {Object} pkgMetadata pkg metadata
 */
function getGoPkgUrl(pkgMetadata) {
  const pkgUrlPrefix =
    readEnvironmentVariable("GO_PKG_URL") || "https://pkg.go.dev/";
  const fullName =
    pkgMetadata.fullName ||
    getGoPkgFullName(pkgMetadata.group, pkgMetadata.name);
  const version = pkgMetadata.version ? `@${pkgMetadata.version}` : "";
  return pkgUrlPrefix + fullName + version;
}

/**
 * Match one path element of a Go module pattern against one element of a
 * module path, the way Go's `path.Match` does: `*` and `?` do not cross a `/`,
 * and a bracketed character class is allowed.
 *
 * @param {string} pattern One pattern element
 * @param {string} name One module path element
 * @returns {boolean}
 */
function matchGoPathElement(pattern, name) {
  let p = 0;
  let n = 0;
  let starP = -1;
  let starN = -1;
  while (n < name.length) {
    if (p < pattern.length) {
      const c = pattern[p];
      if (c === "*") {
        starP = p;
        starN = n;
        p++;
        continue;
      }
      if (c === "?") {
        p++;
        n++;
        continue;
      }
      if (c === "[") {
        let i = p + 1;
        let negate = false;
        if (i < pattern.length && "^".indexOf(pattern[i]) > -1) {
          negate = pattern[i] === "^";
          i++;
        }
        let matched = false;
        let first = true;
        while (i < pattern.length && (first || pattern[i] !== "]")) {
          first = false;
          let lo = pattern[i];
          if (lo === "\\" && i + 1 < pattern.length) {
            i++;
            lo = pattern[i];
          }
          let hi = lo;
          if (
            i + 2 < pattern.length &&
            pattern[i + 1] === "-" &&
            pattern[i + 2] !== "]"
          ) {
            hi = pattern[i + 2];
            i += 2;
          }
          if (name[n] >= lo && name[n] <= hi) {
            matched = true;
          }
          i++;
        }
        if (i < pattern.length && pattern[i] === "]") {
          if (matched !== negate) {
            p = i + 1;
            n++;
            continue;
          }
        } else {
          // An unterminated class matches nothing rather than silently
          // swallowing the rest of the pattern.
          return false;
        }
      } else if (c === "\\" && p + 1 < pattern.length) {
        if (pattern[p + 1] === name[n]) {
          p += 2;
          n++;
          continue;
        }
      } else if (c === name[n]) {
        p++;
        n++;
        continue;
      }
    }
    if (starP !== -1) {
      p = starP + 1;
      starN++;
      n = starN;
      continue;
    }
    return false;
  }
  while (p < pattern.length && pattern[p] === "*") {
    p++;
  }
  return p === pattern.length;
}

/**
 * Whether a module is private and must not be sent to pkg.go.dev.
 *
 * `GOPRIVATE`, and `GONOPROXY`/`GONOSUMDB` when they are set, hold
 * comma-separated globs. Like Go's `module.MatchPrefixPatterns`, a glob with N
 * path elements is matched against the first N elements of the module path,
 * so `example.com/org` matches `example.com/org/tool`. Sending a private
 * module to a public site leaks its path, and the site cannot hold it anyway.
 *
 * @param {string} modulePath Full module path
 * @returns {boolean}
 */
function isPrivateGoModule(modulePath) {
  if (!modulePath) {
    return false;
  }
  const targetParts = modulePath.split("/");
  for (const name of ["GOPRIVATE", "GONOPROXY", "GONOSUMDB"]) {
    for (const rawGlob of (readEnvironmentVariable(name) || "").split(",")) {
      const trimmed = rawGlob.trim();
      const glob = trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
      if (!glob) {
        continue;
      }
      const globParts = glob.split("/");
      if (globParts.length > targetParts.length) {
        continue;
      }
      if (
        globParts.every((part, i) => matchGoPathElement(part, targetParts[i]))
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Method to get go pkg full name.
 *
 * @param {String} group Package group
 * @param {String} name Package name
 */
function getGoPkgFullName(group, name) {
  return group && group !== "." && group !== name ? `${group}/${name}` : name;
}

/**
 * Whether crates.io can hold the crate.
 *
 * The Cargo.lock parser records a `cdx:cargo:sourceKind` for every crate whose
 * source is not plain crates.io: the workspace and path crates, the project
 * itself, git crates, and crates an alternate registry serves. Asking crates.io
 * about those attaches a same-named crate's metadata to them, so only a crate
 * crates.io actually serves is looked up.
 *
 * @param {Object} p Package object with the parser's source properties.
 * @returns {boolean}
 */
function canCratesIoServe(p) {
  let sourceKind;
  let alternateRegistry = false;
  for (const prop of p.properties || []) {
    if (prop.name === "cdx:cargo:sourceKind") {
      sourceKind = prop.value;
    } else if (prop.name === "cdx:cargo:alternateRegistry") {
      alternateRegistry = prop.value === "true";
    }
  }
  if (!sourceKind) {
    // The public registry is the norm and goes unrecorded.
    return true;
  }
  return sourceKind === "registry" && !alternateRegistry;
}

/**
 * Method to retrieve metadata for rust packages by querying crates
 *
 * The local Cargo registry is consulted first, because crates.io's crawler
 * policy allows one request per second and a populated `~/.cargo` already
 * holds the license, description, repository, checksum and yanked flag for
 * every crate the build compiled.
 *
 * What it does not hold is publisher identity, so a caller that needs the
 * publisher-drift and release-cadence signals — the predictive audit does —
 * passes `preferLocalCache: false` and takes the slower registry path. That is
 * also the only caller that needs the crate's owners, so the `/owners` request
 * is made for it alone.
 *
 * Crates a public registry cannot hold are skipped: the project itself, path
 * and git crates, and crates from an alternate registry. See
 * {@link canCratesIoServe}.
 *
 * @param {Array} pkgList Package list
 * @param {Object} [options] Options
 * @param {boolean} [options.preferLocalCache=true] Answer from the local Cargo
 *   registry where it can, and query crates.io only for the rest.
 */
export async function getCratesMetadata(pkgList, options = {}) {
  const CRATES_URL =
    readEnvironmentVariable("RUST_CRATES_URL") ||
    "https://crates.io/api/v1/crates/";
  const cdepList = [];
  // The local Cargo registry answers first. crates.io allows one request per
  // second, so a populated ~/.cargo turns minutes of waiting into a few file
  // reads; only the crates it cannot account for reach the network.
  const servedLocally = new Set();
  const preferLocalCache = options.preferLocalCache !== false;
  // The owners listing carries no licence, so only a caller that wants the
  // publisher identity behind it pays for the second request.
  const wantsOwners = !preferLocalCache;
  if (preferLocalCache && localCargoMetadataEnabled()) {
    for (const p of pkgList) {
      if (!p?.name || !p?.version || p.version === "workspace") {
        continue;
      }
      // A crate crates.io does not hold must not take a same-named crate's
      // place in the local registry cache either.
      if (!canCratesIoServe(p)) {
        continue;
      }
      // A crate a caller already filled from its own local source, such as a
      // .crate archive the scan itself read, has nothing left to ask for.
      if (p.license && p.description) {
        servedLocally.add(p);
        continue;
      }
      if (await applyCargoCacheMetadata(p)) {
        servedLocally.add(p);
      }
    }
    if (DEBUG_MODE && servedLocally.size) {
      console.log(
        `Resolved ${servedLocally.size} of ${pkgList.length} crate(s) from the local Cargo registry.`,
      );
    }
  }
  const needsRegistry = pkgList.filter(
    (p) =>
      p?.name &&
      p?.version &&
      p.version !== "workspace" &&
      canCratesIoServe(p) &&
      !servedLocally.has(p),
  );
  // Two URLs per crate — the crate document and, for the caller that wants
  // publisher identity, its owners — fetched for the whole list at once. The
  // `workspace` and source guards below are mirrored here so the batch does
  // not request anything the loop would have skipped.
  const prefetched = await prefetchJson(
    prefetchEnabled()
      ? needsRegistry.flatMap((p) => {
          const crateUrl = CRATES_URL + p.name;
          return wantsOwners
            ? [{ url: crateUrl }, { url: `${crateUrl}/owners` }]
            : [{ url: crateUrl }];
        })
      : [],
  );
  for (const p of pkgList) {
    try {
      if (!p?.name || !p?.version || p.version === "workspace") {
        cdepList.push(p);
        continue;
      }
      if (!canCratesIoServe(p)) {
        cdepList.push(p);
        continue;
      }
      if (servedLocally.has(p)) {
        cdepList.push(p);
        continue;
      }
      if (DEBUG_MODE) {
        console.log(`Querying crates.io for ${p.name}@${p.version}`);
      }
      const crateUrl = CRATES_URL + p.name;
      // A prefetch miss falls back to a direct request, which must queue
      // behind the same crates.io gate the batch pool uses: the registry
      // allows one request per second and does not care which code path in
      // this process issued it.
      const res =
        prefetchedResponse(prefetched, crateUrl) ||
        (await withHostRateLimit(
          crateUrl,
          (gate) =>
            cdxgenAgent.get(crateUrl, {
              ...gate,
              responseType: "json",
            }),
          { deferGate: true },
        ));
      let ownersRes;
      if (wantsOwners) {
        try {
          const ownersUrl = `${crateUrl}/owners`;
          ownersRes =
            prefetchedResponse(prefetched, ownersUrl) ||
            (await withHostRateLimit(
              ownersUrl,
              (gate) =>
                cdxgenAgent.get(ownersUrl, {
                  ...gate,
                  responseType: "json",
                }),
              { deferGate: true },
            ));
        } catch (_err) {
          ownersRes = undefined;
        }
      }
      // A crate whose version crates.io does not list was not published
      // there: a path or git crate, or one from another registry, that
      // shares a crates.io name. Nothing in that document describes it.
      const versionToUse = res?.body?.versions?.find(
        (aversion) => aversion.num === p.version,
      );
      if (!versionToUse) {
        if (DEBUG_MODE) {
          console.log(
            `crates.io has no version ${p.version} of ${p.name}; leaving it unchanged.`,
          );
        }
        cdepList.push(p);
        continue;
      }
      const body = res.body.crate;
      p.description = body.description;
      if (versionToUse?.license) {
        p.license = versionToUse.license;
      }
      if (body.repository) {
        p.repository = { url: body.repository };
      }
      if (body.homepage && body.homepage !== body.repository) {
        p.homepage = { url: body.homepage };
      }
      if (!p._integrity && versionToUse.checksum) {
        p._integrity = normalizeCargoIntegrity(versionToUse.checksum);
      }
      if (!p.properties) {
        p.properties = [];
      }
      p.properties.push({
        name: "cdx:cargo:crate_id",
        value: `${versionToUse.id}`,
      });
      if (versionToUse.rust_version) {
        p.properties.push({
          name: "cdx:cargo:rust_version",
          value: `${versionToUse.rust_version}`,
        });
      }
      p.properties.push({
        name: "cdx:cargo:latest_version",
        value: body.newest_version,
      });
      p.distribution = { url: `https://crates.io${versionToUse.dl_path}` };
      if (versionToUse.features && Object.keys(versionToUse.features).length) {
        p.properties.push({
          name: "cdx:cargo:features",
          value: JSON.stringify(versionToUse.features),
        });
      }
      p.properties = p.properties.concat(
        collectCargoRegistryProvenanceProperties(
          res?.body,
          versionToUse?.num || p.version,
          ownersRes?.body,
        ),
      );
      cdepList.push(p);
    } catch (_err) {
      cdepList.push(p);
    }
  }
  return cdepList;
}

/**
 * Apply the local Cargo registry's view of a crate to its component.
 *
 * Returns whether the component is complete enough to skip crates.io. The bar
 * is the license: `getCratesMetadata` runs only under `FETCH_LICENSE`, so a
 * crate whose license the local registry cannot name has not answered the
 * question that was asked and still needs the network. That happens when the
 * index knows a version but Cargo never extracted its sources — a crate the
 * lockfile pins but the build never compiled.
 *
 * Publisher identity has no local equivalent, so a component served from here
 * carries the publish time and yanked flag but none of the publisher-drift
 * properties; `cdx:cargo:metadataSource` records which it was.
 *
 * @param {Object} p Package component to enrich in place.
 * @returns {boolean} true when crates.io can be skipped for this crate.
 */
async function applyCargoCacheMetadata(p) {
  const local = await readCargoCacheMetadata(p.name, p.version);
  if (!local?.license && !local?.licenses) {
    return false;
  }
  if (local.license) {
    p.license = local.license;
  }
  if (local.licenses && !p.licenses) {
    p.licenses = local.licenses;
  }
  if (local.description) {
    p.description = local.description;
  }
  if (local.repository) {
    p.repository = { url: local.repository };
  }
  if (local.homepage && local.homepage !== local.repository) {
    p.homepage = { url: local.homepage };
  }
  if (!p._integrity && local.checksum) {
    p._integrity = normalizeCargoIntegrity(local.checksum);
  }
  if (!p.properties) {
    p.properties = [];
  }
  p.properties.push({
    name: "cdx:cargo:metadataSource",
    value: "local-registry",
  });
  if (local.rustVersion) {
    p.properties.push({
      name: "cdx:cargo:rust_version",
      value: local.rustVersion,
    });
  }
  if (local.latestVersion) {
    p.properties.push({
      name: "cdx:cargo:latest_version",
      value: local.latestVersion,
    });
  }
  if (typeof local.yanked === "boolean") {
    p.properties.push({
      name: "cdx:cargo:yanked",
      value: String(local.yanked),
    });
  }
  if (local.publishTime) {
    p.properties.push({
      name: "cdx:cargo:publishTime",
      value: local.publishTime,
    });
  }
  if (local.features && Object.keys(local.features).length) {
    p.properties.push({
      name: "cdx:cargo:features",
      value: JSON.stringify(local.features),
    });
  }
  // The download path is a documented, stable URL shape rather than something
  // the API had to tell us, so it costs no request to state it.
  p.distribution = {
    url: `https://crates.io/api/v1/crates/${p.name}/${p.version}/download`,
  };
  return true;
}

// pub.dev also answers under its old name, which lockfiles written before
// Dart 2.19 record for every hosted package.
const PUB_DEV_HOSTS = new Set(["pub.dev", "pub.dartlang.org"]);

/**
 * The registry a hosted Dart package records, or undefined when that is
 * pub.dev or the registry cdxgen is configured to ask.
 *
 * @param {Object} p Package object with the pubspec.lock properties.
 * @param {string} pubDevUrl The registry cdxgen asks by default.
 * @returns {string|undefined}
 */
function pubHostedRegistry(p, pubDevUrl) {
  const registry = p.properties?.find(
    (prop) => prop.name === "cdx:pub:registry" && prop.value,
  )?.value;
  const host = parseUrl(registry)?.host;
  if (!host || PUB_DEV_HOSTS.has(host) || host === parseUrl(pubDevUrl)?.host) {
    return undefined;
  }
  return registry;
}

/**
 * Method to retrieve metadata for dart packages by querying pub.dev
 *
 * A hosted package whose lockfile names another registry is looked up there;
 * the score endpoint that carries the licence tag is pub.dev's, so a private
 * registry is asked only for the package document. In secure mode cdxgen does
 * not contact a registry the scanned project names, so such a package is not
 * looked up at all.
 *
 * @param {Array} pkgList Package list
 * @param {Object} [options] Options
 * @param {boolean} [options.secureMode] Whether secure mode is on. Defaults to
 *   the process-wide setting.
 */
export async function getDartMetadata(pkgList, options = {}) {
  const PUB_DEV_URL =
    readEnvironmentVariable("PUB_DEV_URL") || "https://pub.dev";
  const secureMode = options.secureMode ?? isSecureMode;
  const PUB_LICENSE_REGEX = /^license:/i;
  const OPTIONS = {
    responseType: "json",
    headers: {
      Accept: PUB_ACCEPT,
    },
  };
  const apiBase = (url) => (url.endsWith("/") ? url.slice(0, -1) : url);

  const cdepList = [];
  // Where each package is asked, decided once so the batch and the loop agree.
  // pub.dev needs the package document and its score document; both carry the
  // vendor Accept header, which is part of the cache key on the Rust side. A
  // package hosted elsewhere is asked only for its package document.
  const lookups = new Map();
  for (const p of pkgList) {
    const registry = pubHostedRegistry(p, PUB_DEV_URL);
    if (registry && secureMode) {
      continue;
    }
    lookups.set(p, {
      registry,
      url: `${apiBase(registry || PUB_DEV_URL)}/api/packages/${p.name}/versions/${p.version}`,
    });
  }
  const prefetched = await prefetchJson(
    prefetchEnabled()
      ? [...lookups.values()].flatMap(({ registry, url }) =>
          registry
            ? [{ url, accept: PUB_ACCEPT }]
            : [
                { url, accept: PUB_ACCEPT },
                { url: `${url}/score`, accept: PUB_ACCEPT },
              ],
        )
      : [],
  );
  for (const p of pkgList) {
    const lookup = lookups.get(p);
    if (!lookup) {
      cdepList.push(p);
      continue;
    }
    try {
      const { registry, url: PUB_PACKAGE_URL } = lookup;
      if (DEBUG_MODE) {
        console.log(`Querying ${registry || PUB_DEV_URL} for ${p.name}`);
      }
      const res =
        prefetchedResponse(prefetched, PUB_PACKAGE_URL) ||
        (await cdxgenAgent.get(PUB_PACKAGE_URL, OPTIONS));
      if (res?.body) {
        const pubspec = res.body.pubspec;
        p.description = pubspec.description;
        if (pubspec.repository) {
          p.repository = { url: pubspec.repository };
        }
        if (pubspec.homepage) {
          p.homepage = { url: pubspec.homepage };
        }
        if (!registry) {
          const PUB_PACKAGE_SCORE_URL = `${PUB_PACKAGE_URL}/score`;
          const score =
            prefetchedResponse(prefetched, PUB_PACKAGE_SCORE_URL) ||
            (await cdxgenAgent.get(PUB_PACKAGE_SCORE_URL, OPTIONS));
          if (score?.body) {
            const tags = score.body.tags;
            const license = tags.find((tag) => PUB_LICENSE_REGEX.test(tag));
            if (license) {
              p.license = spdxLicenses.find(
                (spdxLicense) =>
                  spdxLicense.toLowerCase() ===
                  license.replace(PUB_LICENSE_REGEX, "").toLowerCase(),
              );
            }
          }
        }
        cdepList.push(p);
      }
    } catch (_err) {
      cdepList.push(p);
    }
  }
  return cdepList;
}

/**
 * Normalize a Cargo checksum/integrity string into canonical hex-prefixed form.
 *
 * Accepts an existing `sha256-`/`sha384-` prefixed digest (validating the hex
 * length) or a bare hex digest, returning `<algo>-<digest>`. Returns undefined
 * for non-string or unrecognized inputs.
 *
 * @param {string} integrity Raw checksum string from a Cargo.lock or registry.
 * @returns {string|undefined} Canonical `algo-digest` integrity, or undefined.
 */
export function normalizeCargoIntegrity(integrity) {
  if (typeof integrity !== "string") {
    return undefined;
  }
  const normalizedIntegrity = integrity.trim().toLowerCase();
  const prefixedMatch = /^(sha256|sha384)-(?<digest>[a-f0-9]+)$/i.exec(
    normalizedIntegrity,
  );
  if (prefixedMatch?.groups?.digest) {
    const algorithm = prefixedMatch[1].toLowerCase();
    const digest = prefixedMatch.groups.digest;
    const expectedDigestLength = algorithm === "sha384" ? 96 : 64;
    if (digest.length === expectedDigestLength) {
      return `${algorithm}-${digest}`;
    }
    return undefined;
  }
  if (!/^[a-f0-9]+$/i.test(normalizedIntegrity)) {
    return undefined;
  }
  if (normalizedIntegrity.length === 64) {
    return `sha256-${normalizedIntegrity}`;
  }
  if (normalizedIntegrity.length === 96) {
    return `sha384-${normalizedIntegrity}`;
  }
  return undefined;
}

/**
 * The POM stored next to a jar, as in the Maven repository layout.
 *
 * @param {string} jarPath Path to a jar.
 * @returns {string|undefined} Path to `<name>.pom` when it exists.
 */
function siblingPomFile(jarPath) {
  if (!jarPath?.endsWith(".jar")) {
    return undefined;
  }
  const pomPath = `${jarPath.slice(0, -".jar".length)}.pom`;
  return safeExistsSync(pomPath) ? pomPath : undefined;
}

/**
 * Read the groupId, artifactId and version a POM declares, inheriting the
 * groupId and version from its parent element when they are omitted.
 *
 * @param {string} pomPath Path to a POM.
 * @returns {{groupId: string, artifactId: string, version: string}|undefined}
 */
function readPomCoordinates(pomPath) {
  try {
    const pomData = parsePomXml(readFileSync(pomPath, "utf-8"));
    if (pomData?.groupId && pomData.artifactId && pomData.version) {
      return {
        groupId: pomData.groupId,
        artifactId: pomData.artifactId,
        version: pomData.version,
      };
    }
  } catch (_err) {
    // An unreadable POM contributes nothing.
  }
  return undefined;
}

/**
 * Whether a directory lies inside cdxgen's temp directory or the OS temp
 * directory. Cleanup in {@link extractJarArchive} is limited to such paths.
 *
 * @param {string} dir Directory to check.
 * @returns {boolean}
 */
function isInsideTmpDir(dir) {
  if (!dir) {
    return false;
  }
  return [getTmpDir(), tmpdir()].some((root) => {
    const rel = relative(resolve(root), resolve(dir));
    return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
  });
}

/**
 * Method to extract a war or ear file
 *
 * @param {string} jarFile Path to jar file
 * @param {string} tempDir Temporary directory to use for extraction
 * @param {object} jarNSMapping Jar class names mapping object
 *
 * @return pkgList Package list
 */
export async function extractJarArchive(jarFile, tempDir, jarNSMapping = {}) {
  const pkgList = [];
  let jarFiles = [];
  // Archives whose Maven coordinates could not be determined. They are still
  // reported, as file components with zero-confidence identity evidence.
  const unresolvedJars = [];
  const fname = basename(jarFile);
  // A POM next to the archive, as in the Maven repository layout, names its
  // coordinates. It is read where it is. The archive itself is always copied
  // into tempDir and extracted there, so nothing is ever written to or removed
  // from the directory being scanned.
  const siblingPom = siblingPomFile(jarFile);
  if (
    !safeExistsSync(join(tempDir, fname)) &&
    safeExistsSync(jarFile) &&
    lstatSync(jarFile).isFile()
  ) {
    // Only copy if the file doesn't exist
    safeCopyFileSync(jarFile, join(tempDir, fname), constants.COPYFILE_FICLONE);
  }
  const outerCopy = join(tempDir, fname);
  let outerExtracted = false;
  const env = {
    ...process.env,
  };
  // jar command usually would not be available in the PATH for windows
  if (isWin && env.JAVA_HOME) {
    env.PATH = `${env.PATH || env.Path}${_delimiter}${join(
      env.JAVA_HOME,
      "bin",
    )}`;
  }
  if (
    jarFile.endsWith(".war") ||
    jarFile.endsWith(".hpi") ||
    jarFile.endsWith(".jar")
  ) {
    if (safeExistsSync(outerCopy)) {
      try {
        const zip = new StreamZip.async({ file: outerCopy });
        const extracted = await safeExtractArchive(
          outerCopy,
          tempDir,
          async () => {
            await zip.extract(null, tempDir);
          },
        );
        await zip.close();
        if (!extracted) {
          return pkgList;
        }
        outerExtracted = true;
      } catch (e) {
        console.log("Unable to extract %s. Skipping.", join(tempDir, fname), e);
        return pkgList;
      }
    }
    jarFiles = getAllFiles(join(tempDir, "WEB-INF", "lib"), "**/*.jar");
    if (jarFile.endsWith(".hpi")) {
      jarFiles.push(jarFile);
    }
    // Some jar files could also have more jar files inside BOOT-INF directory
    const jarFiles2 = getAllFiles(join(tempDir, "BOOT-INF", "lib"), "**/*.jar");
    if (jarFiles && jarFiles2.length) {
      jarFiles = jarFiles.concat(jarFiles2);
    }
    // Fallback. If our jar file didn't include any jar
    if (jarFile.endsWith(".jar") && !jarFiles.length) {
      jarFiles = [join(tempDir, fname)];
    }
  } else {
    jarFiles = [join(tempDir, fname)];
  }
  if (jarFiles?.length) {
    for (const jf of jarFiles) {
      // If the jar file doesn't exist at the point of use, skip it
      if (!safeExistsSync(jf)) {
        if (DEBUG_MODE) {
          console.log("%s %s is not a readable file.", jf, jarFile);
        }
        continue;
      }
      const jarname = basename(jf);
      // Ignore test, sources and javadoc jars: none of them is a runtime
      // component, and identifying them only costs lookups.
      if (
        jarname.endsWith("-tests.jar") ||
        jarname.endsWith("-test-sources.jar") ||
        isDocumentationJar(jarname)
      ) {
        if (DEBUG_MODE) {
          console.log(`Skipping tests jar ${jarname}`);
        }
        continue;
      }
      const isOuterArchive = jf === outerCopy || jf === jarFile;
      // The outer archive is already extracted into tempDir. Every nested
      // archive gets a directory of its own, so the META-INF of the war or of
      // a previously read jar can never be mistaken for this jar's.
      const reuseOuter = jf === outerCopy && outerExtracted;
      const workDir = reuseOuter
        ? tempDir
        : safeMkdtempSync(join(tempDir, "nested-"));
      const manifestDir = join(workDir, "META-INF");
      const manifestFile = join(manifestDir, "MANIFEST.MF");
      const mavenDir = join(manifestDir, "maven");
      let jarResult = {
        status: 1,
      };
      if (reuseOuter) {
        jarResult = { status: 0 };
      } else if (workDir) {
        // Unzip natively
        try {
          const zip = new StreamZip.async({ file: jf });
          const extracted = await safeExtractArchive(jf, workDir, async () => {
            await zip.extract(null, workDir);
          });
          await zip.close();
          jarResult = { status: extracted ? 0 : 1 };
        } catch (_e) {
          if (DEBUG_MODE) {
            console.log(`Unable to extract ${jf}. Skipping.`);
          }
          jarResult = { status: 1 };
        }
      }
      if (jarResult.status === 0) {
        // When maven descriptor is available take group, name and version from pom.properties
        // META-INF/maven/${groupId}/${artifactId}/pom.properties
        // see https://maven.apache.org/shared/maven-archiver/index.html
        const pomProperties = getPomPropertiesFromMavenDir(mavenDir, jarname);
        let group = pomProperties["groupId"];
        let name = pomProperties["artifactId"];
        let version = pomProperties["version"];
        let confidence = 0.5;
        let technique = "manifest-analysis";
        let classifier;
        // A POM stored next to the archive names the same coordinates.
        const identityPom = isOuterArchive ? siblingPom : siblingPomFile(jf);
        if ((!group || !name || !version) && identityPom) {
          const pomData = readPomCoordinates(identityPom);
          if (pomData) {
            group = pomData.groupId;
            name = pomData.artifactId;
            version = pomData.version;
          }
        }
        // A jar inside a local Maven repository or Gradle cache is named by
        // where it sits.
        if ((!group || !name || !version) && isOuterArchive) {
          const coordinates = inferMavenCoordinatesFromPath(jarFile);
          if (coordinates?.extension === "jar") {
            group = coordinates.group;
            name = coordinates.name;
            version = coordinates.version;
            classifier = coordinates.classifier;
            technique = "filename";
          }
        }
        // A jar that was copied out of a local cache is known by its SHA-1,
        // which answers what the Maven Central search would be asked.
        let sha;
        if (!group || !name || !version) {
          sha = await checksumFile("sha1", jf);
          const indexed = findMavenCoordinatesBySha1(sha);
          if (indexed) {
            group = indexed.group;
            name = indexed.name;
            version = indexed.version;
            classifier = indexed.classifier;
            technique = "hash-comparison";
          }
        }
        if (
          (!group || !name || !version) &&
          SEARCH_MAVEN_ORG &&
          !isHostCircuitOpen(MAVEN_SEARCH_HOST)
        ) {
          try {
            sha = sha || (await checksumFile("sha1", jf));
            const searchurl = `https://${MAVEN_SEARCH_HOST}/solrsearch/select?q=1:%22${sha}%22&rows=20&wt=json`;
            // One Solr query per unidentified jar, against Central's origin
            // rather than its CDN. A directory of jars issues these back to
            // back, so they go through the same per-host gate the batch pool
            // uses (500 ms, serial) instead of a second, ungoverned path. A
            // repeated hash is answered from the response cache without
            // waiting for that gate.
            const res = await withHostRateLimit(
              searchurl,
              (gate) =>
                cdxgenAgent.get(searchurl, {
                  ...gate,
                  responseType: "json",
                  timeout: {
                    lookup: 1000,
                    connect: 5000,
                    secureConnect: 5000,
                    socket: 1000,
                    send: 10000,
                    response: 1000,
                  },
                }),
              { deferGate: true },
            );
            const data = res?.body ? res.body["response"] : undefined;
            if (data && data["numFound"] === 1) {
              const jarInfo = data["docs"][0];
              group = jarInfo["g"];
              name = jarInfo["a"];
              version = jarInfo["v"];
              technique = "hash-comparison";
            }
          } catch (err) {
            // Any failure other than "not found" pauses the search for a
            // while; a 429 has already done so. Only a rate limit or an
            // unanswered request is the host's doing and worth a warning; a
            // dry run or an allowlist block pauses it quietly.
            if (err?.message && !err.message.includes("404")) {
              const rateLimited = err.message.includes("429");
              const unanswered =
                err.name === "RequestError" &&
                !err.options?.context?.activityBlocked;
              openHostCircuit(MAVEN_SEARCH_HOST, {
                cause: rateLimited
                  ? "answered HTTP 429 (rate limited)"
                  : "did not answer",
                quiet: !rateLimited && !unanswered,
              });
            }
          }
        }
        let jarMetadata;
        if ((!group || !name || !version) && safeExistsSync(manifestFile)) {
          confidence = 0.3;
          jarMetadata = parseJarManifest(
            readFileSync(manifestFile, {
              encoding: "utf-8",
            }),
          );
          if (jarMetadata["Bundle-SymbolicName"]) {
            jarMetadata["Bundle-SymbolicName"] = jarMetadata[
              "Bundle-SymbolicName"
            ]
              .split(";")[0]
              .trim();
          }
          group = group || inferJarGroupFromManifest(jarMetadata);
          version =
            version ||
            jarMetadata["Bundle-Version"] ||
            jarMetadata["Implementation-Version"] ||
            jarMetadata["Specification-Version"];
          if (version?.includes(" ")) {
            version = version.split(" ")[0];
          }
          // Prefer jar filename to construct name and version
          const tmpA = jarname.split("-");
          let fileVersionCandidate;
          let nameCandidate;
          if (tmpA && tmpA.length > 1) {
            const lastPart = tmpA[tmpA.length - 1];
            // Bug #768. Check if we have any number before simplifying the name.
            if (/\d/.test(lastPart)) {
              fileVersionCandidate = lastPart.replace(".jar", "");
              nameCandidate = jarname.replace(`-${lastPart}`, "") || "";
              if (nameCandidate.includes(".")) {
                const gnArr = nameCandidate.split(".");
                if (gnArr?.length === 2 && gnArr[0] === gnArr[1]) {
                  nameCandidate = gnArr[1];
                }
              }
            }
          }
          if (
            fileVersionCandidate &&
            (!version ||
              version === "" ||
              (version.includes(fileVersionCandidate) &&
                version.length > fileVersionCandidate.length))
          ) {
            version = fileVersionCandidate;
            confidence = 0.3;
            technique = "filename";
          }
          if (!name || name === "") {
            name = nameCandidate;
          }
          if (
            !name?.length &&
            jarMetadata["Bundle-Name"] &&
            !jarMetadata["Bundle-Name"].includes(" ")
          ) {
            name = jarMetadata["Bundle-Name"];
          } else if (
            !name?.length &&
            jarMetadata["Implementation-Title"] &&
            !jarMetadata["Implementation-Title"].includes(" ")
          ) {
            name = jarMetadata["Implementation-Title"];
          }
          // Sometimes the group might already contain the name
          // Eg: group: org.checkerframework.checker.qual name: checker-qual
          group = trimJarGroupSuffix(group, name);
          // Patch the group string
          if (vendorAliases[name]) {
            group = vendorAliases[name];
          } else {
            for (const aprefix in vendorAliases) {
              if (name?.startsWith(aprefix) || name?.endsWith(`.${aprefix}`)) {
                group = vendorAliases[aprefix];
                if (name?.startsWith(`${group}.`)) {
                  name = name.replace(`${group}.`, "");
                }
                break;
              }
            }
          }
          // if group is empty use name as group
          group = group === "." ? name : group || name;
        }
        if (name) {
          if (!version) {
            confidence = 0;
          }
          const properties = [
            {
              name: "internal:SrcFile",
              value: jf,
            },
          ];
          const qualifiers = { type: "jar" };
          if (classifier) {
            qualifiers.classifier = classifier;
          }
          const purl = build({
            type: "maven",
            namespace: group || null,
            name: name,
            version: version || null,
            qualifiers,
          });
          let namespaceValues;
          let namespaceList;
          if (jarNSMapping?.[purl]?.namespaces) {
            namespaceList = jarNSMapping[purl].namespaces;
            namespaceValues = namespaceList.join("\n");
            properties.push({
              name: "internal:Namespaces",
              value: namespaceValues,
            });
          } else {
            const tmpJarNSMapping = await collectJarNS(jf);
            if (tmpJarNSMapping?.[jf]?.namespaces?.length) {
              namespaceList = tmpJarNSMapping[jf].namespaces;
              namespaceValues = namespaceList.join("\n");
              properties.push({
                name: "internal:Namespaces",
                value: namespaceValues,
              });
            }
          }
          // Are there any shaded classes
          if (
            namespaceValues?.includes(".shaded.") ||
            namespaceValues?.includes(".thirdparty.com.")
          ) {
            properties.push({
              name: "cdx:maven:shaded",
              value: "true",
            });
            confidence = 0;
            const unshadedNS = new Set();
            for (const ans of namespaceList) {
              let tmpns;
              if (ans.includes(".shaded.")) {
                tmpns = ans.split(".shaded.").pop();
              } else if (ans.includes(".thirdparty.")) {
                tmpns = ans.split(".thirdparty.").pop();
              }
              if (tmpns?.search("[.]") > 3) {
                unshadedNS.add(tmpns.split("$")[0]);
              }
            }
            if (unshadedNS.size) {
              properties.push({
                name: "cdx:maven:unshadedNamespaces",
                value: Array.from(unshadedNS).join("\n"),
              });
            }
          }
          const apkg = {
            group: group || "",
            name: name || "",
            version,
            purl,
            evidence: {
              identity: {
                field: "purl",
                confidence: confidence,
                methods: [
                  {
                    technique: technique,
                    confidence: confidence,
                    value: jarname,
                  },
                ],
              },
            },
            properties,
          };
          pkgList.push(apkg);
        } else {
          unresolvedJars.push(jf);
          if (DEBUG_MODE) {
            console.log("Ignored jar %s", jarname, name, version);
          }
        }
      }
      try {
        // Only directories this function created are removed. A caller's
        // tempDir is never the scanned directory, but the check keeps it that
        // way should a caller ever pass one.
        if (workDir && workDir !== tempDir && isInsideTmpDir(workDir)) {
          safeRmSync(workDir, { recursive: true, force: true });
        } else if (
          workDir === tempDir &&
          isInsideTmpDir(tempDir) &&
          safeExistsSync(manifestDir)
        ) {
          safeRmSync(manifestDir, { recursive: true, force: true });
        }
      } catch (_err) {
        // ignore cleanup errors
      }
    } // for
  } // if
  if (unresolvedJars.length) {
    // An archive without readable Maven coordinates is still a real file in the
    // artifact. Reporting it as a file component keeps it in the inventory,
    // while zero-confidence identity evidence records that only its name and
    // hashes are known — the same treatment unpackaged executables and shared
    // libraries get.
    pkgList.push(
      ...(await unresolvedJarComponents(unresolvedJars, jarFile, tempDir)),
    );
    thoughtLog(
      `I couldn't read Maven coordinates for ${unresolvedJars.length} archive(s) under ${basename(jarFile)}, so I recorded them as files with their hashes instead of dropping them.`,
    );
  }
  return pkgList;
}

/**
 * Build file components for archives whose Maven coordinates could not be
 * determined.
 *
 * @param {string[]} unresolvedJars Paths of the archives on disk
 * @param {string} jarFile The archive originally passed for extraction
 * @param {string} tempDir Directory the archive was expanded into
 * @returns {Promise<object[]>} File components with zero-confidence identity
 */
async function unresolvedJarComponents(unresolvedJars, jarFile, tempDir) {
  const hashResults = await mapWithConcurrency(unresolvedJars, (jf) =>
    multiChecksumFile(["md5", "sha1", "sha256"], jf)
      .then((hashValues) => [
        { alg: "MD5", content: hashValues.md5 },
        { alg: "SHA-1", content: hashValues.sha1 },
        { alg: "SHA-256", content: hashValues.sha256 },
      ])
      .catch(() => undefined),
  );
  const components = [];
  for (let i = 0; i < unresolvedJars.length; i++) {
    const jf = unresolvedJars[i];
    const name = basename(jf);
    // A nested archive is identified by its entry path within the outer one,
    // which is what a reader can actually go and look at. The temp directory
    // the archive happened to be expanded into carries no information.
    const relativeEntry = relative(tempDir, jf);
    const srcFile =
      relativeEntry && !relativeEntry.startsWith("..") && relativeEntry !== name
        ? `${jarFile}!/${relativeEntry.split(_sep).join("/")}`
        : jarFile;
    // The purl carries the name only. The archive is reached through a
    // temporary extraction directory whose name changes every run, and postgen
    // rewrites `internal:SrcFile` and `concludedValue` to scan-relative paths
    // but never a purl, since purls are join keys. Putting the location in the
    // purl would make it differ between two runs over the same input.
    const purl = genericPurl(name);
    components.push({
      name,
      type: "file",
      ...(purl ? { purl, "bom-ref": purl } : {}),
      hashes: hashResults[i],
      properties: [
        { name: "internal:SrcFile", value: srcFile },
        { name: "internal:is_file", value: "true" },
      ],
      evidence: {
        identity: [
          {
            field: "purl",
            confidence: 0,
            methods: [
              {
                technique: "filename",
                confidence: 0,
                value: srcFile,
              },
            ],
            concludedValue: srcFile,
          },
        ],
      },
    });
  }
  return components;
}

/**
 * Property recording the NuGet release a versionless component's metadata was
 * read from, so the description and licence in the output can be traced.
 */
const METADATA_VERSION_PROP = "cdx:nuget:metadata_version";

/**
 * Fetch one JSON document through the batch pool, so it shares the rate gate
 * and the disk cache with every other registry request. A direct request is
 * made only when batched fetching is off, which is the cassette replay the
 * golden corpus runs under.
 *
 * @param {string} url Document URL
 * @returns {Promise<{body: Object}|undefined>} The response, or undefined when
 *   the batch answered definitely that the document is not available
 */
async function batchedJsonDocument(url) {
  if (prefetchEnabled()) {
    const fetched = await prefetchJson([{ url, responseType: "json" }]);
    const entry = fetched.get(url);
    return entry?.ok ? { body: entry.body } : undefined;
  }
  return await cdxgenAgent.get(url, { responseType: "json" });
}

async function getNugetUrl() {
  const req = "https://api.nuget.org/v3/index.json";
  const fallbackUrl = "https://api.nuget.org/v3/registration3/";
  let res;
  try {
    res = await batchedJsonDocument(req);
  } catch (err) {
    // Package lookups already degrade to unenriched components on error. An
    // unreachable service index used to reject here instead and abort the
    // whole BOM, so fall back to the well-known registration base.
    thoughtLog(
      `Unable to read the NuGet service index (${err.code || err.message}). Using ${fallbackUrl}.`,
    );
    return fallbackUrl;
  }
  if (!res) {
    thoughtLog(`Unable to read the NuGet service index. Using ${fallbackUrl}.`);
    return fallbackUrl;
  }
  const urls = res?.body?.resources || [];
  for (const resource of urls) {
    if (resource["@type"] === "RegistrationsBaseUrl/3.6.0") {
      return resource["@id"];
    }
  }
  return fallbackUrl;
}

/**
 * Prefetched NuGet registration index documents, populated by
 * `getNugetMetadata`'s batch round. The index is the first request
 * `queryNuget` makes for each package; batching it removes the serial round
 * trip per package. The follow-up request to a specific registration page
 * (when the index does not inline items) depends on the index response and
 * stays serial.
 */
const prefetchedNugetIndex = new Map();

async function queryNuget(p, NUGET_URL) {
  function setLatestVersion(upper) {
    // Handle special case for versions with more than 3 parts
    if (upper.split(".").length > 3) {
      const tmpVersionArray = upper.split("-")[0].split(".");
      // Compromise for versions such as 1.2.3.0-alpha
      // How to find latest proper release version?
      if (
        upper.split("-").length > 1 &&
        Number(tmpVersionArray.slice(-1)) === 0
      ) {
        return upper;
      }
      if (upper.split("-").length > 1) {
        tmpVersionArray[tmpVersionArray.length - 1] = (
          Number(tmpVersionArray.slice(-1)) - 1
        ).toString();
      }
      return tmpVersionArray.join(".");
    }
    const tmpVersion = parse(upper);
    let version = `${tmpVersion.major}.${tmpVersion.minor}.${tmpVersion.patch}`;
    if (compare(version, upper) === 1) {
      if (tmpVersion.patch > 0) {
        version = `${tmpVersion.major}.${tmpVersion.minor}.${(tmpVersion.patch - 1).toString()}`;
      }
    }
    return version;
  }

  // Coerce only when missing patch/minor version
  function coerceUp(version) {
    return version.split(".").length < 3
      ? coerce(version, { loose: true }).version
      : version;
  }

  if (DEBUG_MODE) {
    console.log(`Querying nuget for ${p.name}`);
  }
  const np = JSON.parse(JSON.stringify(p));
  const body = [];
  const newBody = [];
  const indexUrl = `${NUGET_URL + np.name.toLowerCase()}/index.json`;
  let res;
  try {
    res =
      prefetchedResponse(prefetchedNugetIndex, indexUrl) ||
      (await batchedJsonDocument(indexUrl));
  } catch {
    res = undefined;
  }
  const items = res?.body?.items;
  if (!items?.[0]) {
    return [np, newBody, body];
  }
  // A component that states no version at all is not the same as one carrying a
  // `latest` or `0.0.0` placeholder. The placeholder asks to be replaced, so the
  // registry's newest release becomes the component's version. A missing version
  // means the manifest never said which release is in use - a `<Reference>` to an
  // assembly is the usual source - and the newest release is then only a key for
  // looking metadata up, never a version to write back. See #4359.
  const versionStated = p.version && !["0.0.0", "latest"].includes(p.version);
  let lookupVersion = p.version;
  if (!versionStated) {
    lookupVersion = setLatestVersion(items[items.length - 1].upper);
    np.version = p.version ? lookupVersion : undefined;
    np.metadataVersion = lookupVersion;
  }
  if (lookupVersion) {
    for (const item of items) {
      const lower = compare(
        coerce(item.lower, { loose: true }),
        coerce(lookupVersion, { loose: true }),
      );
      const upper = compare(
        coerce(item.upper, { loose: true }),
        coerce(lookupVersion, { loose: true }),
      );
      if (lower === 1 || upper === -1) {
        continue;
      }
      // The registration index either inlines the leaves of each page or points
      // at a page that must be fetched.
      let leaves = item.items;
      if (!leaves) {
        // The page URL is only known once the index answered, but it still
        // goes through the batch pool, its rate gate and its disk cache.
        const page = await batchedJsonDocument(item["@id"]);
        if (!page) {
          return [np, newBody, body];
        }
        leaves = page.body.items;
      }
      for (const i of leaves.reverse()) {
        if (
          i.catalogEntry &&
          i.catalogEntry.version === coerceUp(lookupVersion)
        ) {
          newBody.push(i);
          return [np, newBody];
        }
      }
    }
  }
  return [np, newBody];
}

/**
 * The global NuGet packages folder of this machine.
 *
 * @returns {string} `$NUGET_PACKAGES`, or the default `~/.nuget/packages`.
 */
function nugetPackagesRoot() {
  return resolve(
    readEnvironmentVariable("NUGET_PACKAGES") ||
      join(homedir(), ".nuget", "packages"),
  );
}

/**
 * Read the nuspec of a package version installed in the global packages
 * folder, without asking the NuGet service.
 *
 * The folder and the nuspec inside it are named by the lower-cased package id,
 * under a folder named by the lower-cased version.
 *
 * @param {Object} p Component with `name` and an exact `version`
 * @returns {{license: string|undefined, description: string|undefined,
 *   author: string|undefined, repository: {url: string}|undefined,
 *   source: string}|undefined} The nuspec's fields, or undefined when the
 *   package is not installed here or states no exact version
 */
function readLocalNugetNuspec(p) {
  if (
    !p?.name ||
    !p.version ||
    ["0.0.0", "latest"].includes(p.version) ||
    p.version === "workspace"
  ) {
    return undefined;
  }
  // The folder holds the lower-cased id and version. A name or version that is
  // not a single path segment cannot be a package there.
  const id = p.name.toLowerCase();
  const version = p.version.trim().toLowerCase();
  if (
    [id, version].some(
      (segment) =>
        segment.includes("/") ||
        segment.includes("\\") ||
        segment === "." ||
        segment === "..",
    )
  ) {
    return undefined;
  }
  const nuspecFile = join(nugetPackagesRoot(), id, version, `${id}.nuspec`);
  if (!safeExistsSync(nuspecFile)) {
    return undefined;
  }
  let nuspec;
  try {
    nuspec = parseNuspecData(nuspecFile, readFileSync(nuspecFile, "utf-8"));
  } catch {
    return undefined;
  }
  const pkg = nuspec?.pkgList?.[0];
  if (!pkg?.name) {
    return undefined;
  }
  return {
    license: pkg.license,
    description: pkg.description,
    author: pkg.author,
    repository: pkg.repository,
    source: nuspecFile,
  };
}

/**
 * Apply the installed nuspec of a package to its component, and say whether it
 * answered everything the registry round would have been asked for.
 *
 * @param {Object} p Component, enriched in place
 * @returns {boolean} true when the registry can be skipped for this package
 */
function applyLocalNugetNuspec(p) {
  const local = readLocalNugetNuspec(p);
  if (!local) {
    return false;
  }
  if (!p.license && local.license) {
    p.license = local.license;
  }
  if (!p.description && local.description) {
    p.description = local.description;
  }
  if (!p.author && local.author) {
    p.author = local.author;
  }
  if (!p.repository && local.repository) {
    p.repository = local.repository;
  }
  if (!p.license || !p.description) {
    return false;
  }
  p.properties = p.properties || [];
  if (!p.properties.some((prop) => prop.name === "cdx:nuget:metadataSource")) {
    p.properties.push({
      name: "cdx:nuget:metadataSource",
      value: "local-nuspec",
    });
  }
  return true;
}

/**
 * Method to retrieve metadata for nuget packages
 *
 * @param {Array} pkgList Package list
 * @param {Array} dependencies Dependencies
 */
export async function getNugetMetadata(pkgList, dependencies = undefined) {
  const NUGET_URL =
    readEnvironmentVariable("NUGET_URL") || (await getNugetUrl());
  const cdepList = [];
  const depRepList = {};
  // Batch the per-package registration index requests. queryNuget's first
  // request for each package is the index; the follow-up to a specific
  // registration page depends on the index response and stays serial. Only
  // packages that would actually be queried (not in metadata_cache, no prior
  // error) are prefetched, matching the loop's skip conditions.
  const batchUrls = [];
  const seenNugetUrls = new Set();
  // Packages the installed nuspec answered, so neither the batch nor the loop
  // asks the service about them.
  const servedLocally = new Set();
  for (const p of pkgList) {
    // A cached entry — a body or a recorded error — means the loop will not
    // reach the network for this package, so the batch must not either.
    if (metadata_cache[`${p.name}|${p.version}`]) {
      continue;
    }
    if (applyLocalNugetNuspec(p)) {
      servedLocally.add(p);
      continue;
    }
    const indexUrl = `${NUGET_URL + p.name.toLowerCase()}/index.json`;
    if (!seenNugetUrls.has(indexUrl)) {
      seenNugetUrls.add(indexUrl);
      batchUrls.push({ url: indexUrl });
    }
  }
  const ownIndexUrls = [];
  if (batchUrls.length) {
    const fetched = await prefetchJson(batchUrls);
    for (const [key, value] of fetched) {
      prefetchedNugetIndex.set(key, value);
      ownIndexUrls.push(key);
    }
  }
  try {
    for (const p of pkgList) {
      let cacheKey;
      try {
        // If there is a version, we can safely use the cache to retrieve the license
        // See: https://github.com/cdxgen/cdxgen/issues/352
        cacheKey = `${p.name}|${p.version}`;
        let body = metadata_cache[cacheKey];

        if (body?.error) {
          cdepList.push(p);
          continue;
        }
        if (!body) {
          if (servedLocally.has(p)) {
            cdepList.push(p);
            continue;
          }
          let newBody = {};
          let np = {};
          [np, newBody] = await queryNuget(p, NUGET_URL);
          if (p.version !== np.version) {
            const oldRef = p["bom-ref"];
            // The purl is rebuilt alongside the bom-ref. Leaving it behind let a
            // component state one version in `version` and another - or none - in
            // its purl, which is what a scanner range matches on. See #4359.
            p.version = np.version;
            applyPurl(p, nugetPurl(np.name, np.version));
            if (oldRef && p["bom-ref"] !== oldRef) {
              depRepList[oldRef] = p["bom-ref"];
            }
          }
          if (newBody && newBody.length > 0) {
            body = newBody[0];
          }
          if (body) {
            metadata_cache[cacheKey] = body;
            // The component states no version, so the description and licence
            // below were read from whichever release the lookup fell back to.
            // That release is recorded rather than adopted as the version: a
            // version cdxgen chose is not a version the project declared.
            if (!p.version && np.metadataVersion) {
              p.properties = p.properties || [];
              if (
                !p.properties.some(
                  (prop) => prop.name === METADATA_VERSION_PROP,
                )
              ) {
                p.properties.push({
                  name: METADATA_VERSION_PROP,
                  value: np.metadataVersion,
                });
              }
            }
            if (body.catalogEntry.description && !p.description) {
              p.description = body.catalogEntry.description;
            }
            if (body.catalogEntry.authors && !p.author) {
              p.author = body.catalogEntry.authors.trim();
            }
            if (
              !p.license &&
              body.catalogEntry.licenseExpression &&
              body.catalogEntry.licenseExpression !== ""
            ) {
              p.license = findLicenseId(body.catalogEntry.licenseExpression);
            } else if (!p.license && body.catalogEntry.licenseUrl) {
              p.license = findLicenseId(body.catalogEntry.licenseUrl);
              if (typeof p.license === "string" && isGitHubUrl(p.license)) {
                p.license =
                  (await getRepoLicense(p.license, undefined)) || p.license;
              }
            }
            // Capture the tags
            if (
              body.catalogEntry?.tags?.length &&
              Array.isArray(body.catalogEntry.tags)
            ) {
              p.tags = body.catalogEntry.tags.map((t) =>
                t.toLowerCase().replaceAll(" ", "-"),
              );
            }
            if (body.catalogEntry.projectUrl && !p.repository) {
              p.repository = { url: body.catalogEntry.projectUrl };
              // A versionless component gets the package's landing page. Pasting
              // an undefined version into the path produced a 404 link.
              p.homepage = {
                url: p.version
                  ? `https://www.nuget.org/packages/${p.name}/${p.version}/`
                  : `https://www.nuget.org/packages/${p.name}/`,
              };
              if (
                (!p.license || typeof p.license === "string") &&
                typeof p.repository.url === "string" &&
                isGitHubUrl(p.repository.url)
              ) {
                // license couldn't be properly identified and is still a url,
                // therefore trying to resolve license via repository
                p.license =
                  (await getRepoLicense(p.repository.url, undefined)) ||
                  p.license;
              }
            }
            cdepList.push(p);
          } else {
            // A package the service does not know, such as a private one,
            // stays in the BOM as the project described it.
            cdepList.push(p);
          }
        }
      } catch (err) {
        if (cacheKey) {
          metadata_cache[cacheKey] = { error: err.code };
        }
        cdepList.push(p);
      }
    }
  } finally {
    // Each index document is read once, by the loop above. Holding them past
    // that only grows the process, which matters in server mode where one
    // process serves many scans. Only the documents this call fetched are
    // dropped, so a scan running alongside this one keeps its own.
    for (const indexUrl of ownIndexUrls) {
      prefetchedNugetIndex.delete(indexUrl);
    }
  }
  const newDependencies = [].concat(dependencies);
  if (depRepList && newDependencies.length) {
    const changed = Object.keys(depRepList);
    // if (!parentComponent.version || parentComponent.version === "latest" || parentComponent.version === "0.0.0"){
    //   if (changed.includes(parentComponent["bom-ref"])) {
    //     parentComponent["bom-ref"] = depRepList[parentComponent["bom-ref"]["ref"]];
    //   }
    // }
    for (const d of newDependencies) {
      if (changed.length > 0 && changed.includes(d["ref"])) {
        d["ref"] = depRepList[d["ref"]];
      }
      for (const dd in d["dependsOn"]) {
        if (changed.includes(d["dependsOn"][dd])) {
          const replace = d["dependsOn"][dd];
          d["dependsOn"][dd] = depRepList[replace];
        }
      }
    }
  }
  return {
    pkgList: cdepList,
    dependencies: newDependencies,
  };
}
