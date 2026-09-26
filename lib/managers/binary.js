import {
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { platform as _platform, homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

import { build, Purl } from "@cdxgen/cdx-purl";

import {
  DEBUG_MODE,
  hasDangerousUnicode,
  isDryRun,
  readEnvironmentVariable,
  recordActivity,
  recordSymlinkResolution,
} from "../core/activity.js";
import { recordDegradation } from "../core/buildLedger.js";
import { extractPathEnv } from "../core/env.js";
import {
  getTmpDir,
  multiChecksumFile,
  safeExistsSync,
  safeMkdirSync,
  safeMkdtempSync,
  safeRmSync,
  safeSpawnSync,
} from "../core/fs.js";
import { mapWithConcurrency } from "../core/parallel.js";
import { isValidDriveRoot } from "../core/paths.js";
import { isCycloneDxComponentTypeEnabled } from "../inventory/bomUtils.js";
import { createContainerRiskProperties } from "../inventory/containerRisk.js";
import {
  attachIdentityTools,
  extractToolRefs,
} from "../inventory/evidenceUtils.js";
import { createGtfoBinsProperties } from "../inventory/gtfobins.js";
import {
  canonicalDistroQualifier,
  isCleanDistroQualifier,
  OS_DISTRO_ALIAS,
  OS_NAMESPACE_ALIAS,
  readOsRelease,
} from "../inventory/osinfo.js";
import {
  collectExecutables,
  collectSharedLibs,
} from "../inventory/osPackageResolver.js";
import {
  resolveCdxgenPlugins,
  resolvePluginBinary,
  setPluginsPathEnv,
} from "../inventory/plugins.js";
import { genericPurl, tryBuildPurl } from "../inventory/purl.js";
import {
  adjustLicenseInformation,
  findLicenseId,
  isSpdxLicenseExpression,
} from "../inventory/spdx.js";
import { getDirs } from "./containerutils.js";

const isWin = _platform() === "win32";
const OS_PURL_TYPES = ["deb", "apk", "rpm", "alpm", "qpkg"];
const pluginRuntime = setPluginsPathEnv(resolveCdxgenPlugins());
const platform = pluginRuntime.platform;
const CDXGEN_PLUGINS_DIR = pluginRuntime.pluginsDir;
const PLUGIN_MANIFEST_FILE = pluginRuntime.pluginManifestFile;
let pluginManifest;

const MAX_PLUGIN_MANIFEST_BYTES = 1024 * 1024;
const MAX_PLUGIN_MANIFEST_PLUGINS = 32;
const MAX_PLUGIN_COMPONENT_HASHES = 16;
const MAX_PLUGIN_COMPONENT_REFERENCES = 32;
const MAX_PLUGIN_COMPONENT_PROPERTIES = 128;
const MAX_PLUGIN_COMPONENT_LICENSES = 8;
const MAX_PLUGIN_STRING_LENGTH = 4096;
const MAX_PLUGIN_LONG_STRING_LENGTH = 16384;

function sanitizeManifestString(value, maxLength = MAX_PLUGIN_STRING_LENGTH) {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmedValue = value.trim();
  if (!trimmedValue || trimmedValue.length > maxLength) {
    return undefined;
  }
  return trimmedValue;
}

function sanitizeManifestObjectList(values, limit, mapper) {
  if (!Array.isArray(values) || !values.length) {
    return undefined;
  }
  const mappedValues = values
    .slice(0, limit)
    .map((value) => mapper(value))
    .filter(Boolean);
  return mappedValues.length ? mappedValues : undefined;
}

function sanitizeManifestHash(hash) {
  const alg = sanitizeManifestString(hash?.alg, 64);
  const content = sanitizeManifestString(hash?.content, 512);
  if (!alg || !content) {
    return undefined;
  }
  return { alg, content };
}

function sanitizeManifestProperty(property) {
  const name = sanitizeManifestString(property?.name, 256);
  const value = sanitizeManifestString(
    property?.value,
    MAX_PLUGIN_LONG_STRING_LENGTH,
  );
  if (!name || !value) {
    return undefined;
  }
  return { name, value };
}

function sanitizeManifestExternalReference(reference) {
  const type = sanitizeManifestString(reference?.type, 64);
  const url = sanitizeManifestString(
    reference?.url,
    MAX_PLUGIN_LONG_STRING_LENGTH,
  );
  if (!type || !url) {
    return undefined;
  }
  const sanitizedReference = { type, url };
  const comment = sanitizeManifestString(reference?.comment, 512);
  if (comment) {
    sanitizedReference.comment = comment;
  }
  return sanitizedReference;
}

function sanitizeManifestLicense(licenseEntry) {
  const licenseId = sanitizeManifestString(licenseEntry?.license?.id, 128);
  const licenseName = sanitizeManifestString(licenseEntry?.license?.name, 256);
  const licenseUrl = sanitizeManifestString(
    licenseEntry?.license?.url,
    MAX_PLUGIN_LONG_STRING_LENGTH,
  );
  if (!licenseId && !licenseName) {
    return undefined;
  }
  const license = {};
  if (licenseId) {
    license.id = licenseId;
  }
  if (licenseName) {
    license.name = licenseName;
  }
  if (licenseUrl) {
    license.url = licenseUrl;
  }
  return { license };
}

function sanitizeManifestComponent(component, fallbackName) {
  if (!component || typeof component !== "object") {
    return undefined;
  }
  const sanitizedComponent = {};
  const stringFields = {
    group: 256,
    name: 256,
    version: 256,
    description: MAX_PLUGIN_LONG_STRING_LENGTH,
    publisher: 256,
    purl: MAX_PLUGIN_LONG_STRING_LENGTH,
    "bom-ref": MAX_PLUGIN_LONG_STRING_LENGTH,
    type: 64,
  };
  for (const [field, maxLength] of Object.entries(stringFields)) {
    const sanitizedValue = sanitizeManifestString(component[field], maxLength);
    if (sanitizedValue) {
      sanitizedComponent[field] = sanitizedValue;
    }
  }
  if (!sanitizedComponent.name && fallbackName) {
    sanitizedComponent.name = fallbackName;
  }
  if (!sanitizedComponent.name || !sanitizedComponent["bom-ref"]) {
    return undefined;
  }
  const hashes = sanitizeManifestObjectList(
    component.hashes,
    MAX_PLUGIN_COMPONENT_HASHES,
    sanitizeManifestHash,
  );
  const externalReferences = sanitizeManifestObjectList(
    component.externalReferences,
    MAX_PLUGIN_COMPONENT_REFERENCES,
    sanitizeManifestExternalReference,
  );
  const properties = sanitizeManifestObjectList(
    component.properties,
    MAX_PLUGIN_COMPONENT_PROPERTIES,
    sanitizeManifestProperty,
  );
  const licenses = sanitizeManifestObjectList(
    component.licenses,
    MAX_PLUGIN_COMPONENT_LICENSES,
    sanitizeManifestLicense,
  );
  if (hashes) {
    sanitizedComponent.hashes = hashes;
  }
  if (externalReferences) {
    sanitizedComponent.externalReferences = externalReferences;
  }
  if (properties) {
    sanitizedComponent.properties = properties;
  }
  if (licenses) {
    sanitizedComponent.licenses = licenses;
  }
  return sanitizedComponent;
}

function sanitizePluginManifest(manifest) {
  if (!manifest || typeof manifest !== "object") {
    return null;
  }
  const sanitizedManifest = {
    plugins: [],
  };
  const generatedAt = sanitizeManifestString(manifest.generatedAt, 128);
  if (generatedAt) {
    sanitizedManifest.generatedAt = generatedAt;
  }
  if (manifest.package && typeof manifest.package === "object") {
    const sanitizedPackage = {};
    for (const [field, maxLength] of Object.entries({
      name: 256,
      version: 256,
      repository: MAX_PLUGIN_LONG_STRING_LENGTH,
      homepage: MAX_PLUGIN_LONG_STRING_LENGTH,
    })) {
      const sanitizedValue = sanitizeManifestString(
        manifest.package[field],
        maxLength,
      );
      if (sanitizedValue) {
        sanitizedPackage[field] = sanitizedValue;
      }
    }
    if (Object.keys(sanitizedPackage).length) {
      sanitizedManifest.package = sanitizedPackage;
    }
  }
  for (const pluginEntry of Array.isArray(manifest.plugins)
    ? manifest.plugins.slice(0, MAX_PLUGIN_MANIFEST_PLUGINS)
    : []) {
    const name = sanitizeManifestString(pluginEntry?.name, 128);
    const component = sanitizeManifestComponent(pluginEntry?.component, name);
    if (!name || !component) {
      continue;
    }
    const sanitizedPlugin = { name, component };
    for (const [field, maxLength] of Object.entries({
      version: 256,
      binaryPath: MAX_PLUGIN_LONG_STRING_LENGTH,
      sbomFile: MAX_PLUGIN_LONG_STRING_LENGTH,
      sha256: 256,
    })) {
      const sanitizedValue = sanitizeManifestString(
        pluginEntry?.[field],
        maxLength,
      );
      if (sanitizedValue) {
        sanitizedPlugin[field] = sanitizedValue;
      }
    }
    sanitizedManifest.plugins.push(sanitizedPlugin);
  }
  return sanitizedManifest.plugins.length ? sanitizedManifest : null;
}

function loadPluginManifest() {
  if (pluginManifest !== undefined) {
    return pluginManifest;
  }
  if (!PLUGIN_MANIFEST_FILE) {
    pluginManifest = null;
    return pluginManifest;
  }
  try {
    const manifestRealPath = realpathSync(PLUGIN_MANIFEST_FILE);
    const manifestDirectory = dirname(manifestRealPath);
    const expectedManifestDirectory = realpathSync(CDXGEN_PLUGINS_DIR);
    const manifestStats = statSync(manifestRealPath);
    if (
      basename(manifestRealPath) !== "plugins-manifest.json" ||
      manifestDirectory !== expectedManifestDirectory ||
      !manifestStats.isFile() ||
      manifestStats.size > MAX_PLUGIN_MANIFEST_BYTES
    ) {
      pluginManifest = null;
      return pluginManifest;
    }
    pluginManifest = sanitizePluginManifest(
      JSON.parse(readFileSync(manifestRealPath, { encoding: "utf-8" })),
    );
  } catch (_err) {
    pluginManifest = null;
  }
  return pluginManifest;
}

function cloneSerializable(value) {
  if (!value || typeof value !== "object") {
    return value;
  }
  return JSON.parse(JSON.stringify(value));
}

function getPluginManifestEntry(toolName) {
  const manifest = loadPluginManifest();
  if (!manifest?.plugins?.length) {
    return undefined;
  }
  return manifest.plugins.find((entry) => entry?.name === toolName);
}

function mergeToolComponent(manifestComponent, existingComponent) {
  if (!manifestComponent) {
    return cloneSerializable(existingComponent);
  }
  if (!existingComponent) {
    return cloneSerializable(manifestComponent);
  }
  const merged = {
    ...cloneSerializable(manifestComponent),
    ...cloneSerializable(existingComponent),
  };
  for (const key of [
    "group",
    "name",
    "version",
    "description",
    "publisher",
    "purl",
    "bom-ref",
    "type",
  ]) {
    if (manifestComponent?.[key]) {
      merged[key] = manifestComponent[key];
    }
  }
  merged.hashes = manifestComponent?.hashes?.length
    ? manifestComponent.hashes
    : existingComponent?.hashes;
  merged.externalReferences = uniqueExternalReferences(
    (manifestComponent?.externalReferences || []).concat(
      existingComponent?.externalReferences || [],
    ),
  );
  merged.properties = uniqueProperties(
    (manifestComponent?.properties || []).concat(
      existingComponent?.properties || [],
    ),
  );
  merged.licenses =
    manifestComponent?.licenses?.length || !existingComponent?.licenses?.length
      ? manifestComponent?.licenses
      : existingComponent.licenses;
  merged.evidence = manifestComponent?.evidence || existingComponent?.evidence;
  return merged;
}

function uniqueExternalReferences(references) {
  const seen = new Set();
  const uniqueValues = [];
  for (const reference of references || []) {
    if (!reference?.url || !reference?.type) {
      continue;
    }
    const key = `${reference.type}\u0000${reference.url}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    uniqueValues.push(reference);
  }
  return uniqueValues;
}

/**
 * Look up plugin manifest entries for the given tool names and return their
 * CycloneDX tool component objects, de-duplicated by bom-ref.
 *
 * @param {string[]} [toolNames=[]] Plugin tool names to resolve.
 * @returns {Object[]} De-duplicated CycloneDX tool component objects.
 */
export function getPluginToolComponents(toolNames = []) {
  const components = [];
  const seenRefs = new Set();
  for (const toolName of uniqueSortedStrings(toolNames)) {
    const component = cloneSerializable(
      getPluginManifestEntry(toolName)?.component,
    );
    if (!component?.["bom-ref"] || seenRefs.has(component["bom-ref"])) {
      continue;
    }
    seenRefs.add(component["bom-ref"]);
    components.push(component);
  }
  return components;
}

function enrichToolComponents(existingTools = [], toolNames = []) {
  const manifestTools = getPluginToolComponents(toolNames);
  if (!existingTools?.length) {
    return manifestTools;
  }
  const toolMap = new Map();
  for (const tool of existingTools) {
    if (!tool) {
      continue;
    }
    toolMap.set(tool["bom-ref"] || tool.name || JSON.stringify(tool), tool);
  }
  for (const manifestTool of manifestTools) {
    const matchKey = Array.from(toolMap.keys()).find((key) => {
      const existing = toolMap.get(key);
      return (
        existing?.["bom-ref"] === manifestTool["bom-ref"] ||
        existing?.name === manifestTool.name
      );
    });
    if (matchKey) {
      toolMap.set(
        matchKey,
        mergeToolComponent(manifestTool, toolMap.get(matchKey)),
      );
      continue;
    }
    toolMap.set(manifestTool["bom-ref"], manifestTool);
  }
  return Array.from(toolMap.values());
}

const TRIVY_BIN = resolvePluginBinary("trivy", pluginRuntime);
const CARGO_AUDITABLE_BIN = resolvePluginBinary(
  "cargo-auditable",
  pluginRuntime,
);
const OSQUERY_BIN = resolvePluginBinary("osquery", pluginRuntime);
const DOSAI_BIN = resolvePluginBinary("dosai", pluginRuntime);
const TRUSTINSPECTOR_BIN = resolvePluginBinary("trustinspector", pluginRuntime);

// Blint bin
const BLINT_BIN = readEnvironmentVariable("BLINT_CMD") || "blint";

// sourcekitten
const SOURCEKITTEN_BIN = resolvePluginBinary("sourcekitten", pluginRuntime);

// TODO: Move the lists to a config file
const COMMON_RUNTIMES = [
  "java",
  "node",
  "nodejs",
  "nodejs-current",
  "deno",
  "bun",
  "python",
  "python3",
  "ruby",
  "ruby3",
  "php",
  "php7",
  "php8",
  "perl",
  "openjdk",
  "openjdk8",
  "openjdk11",
  "openjdk17",
  "openjdk21",
  "openjdk22",
  "openjdk23",
  "openjdk24",
  "openjdk25",
  "openjdk8-jdk",
  "openjdk11-jdk",
  "openjdk17-jdk",
  "openjdk21-jdk",
  "openjdk22-jdk",
  "openjdk23-jdk",
  "openjdk24-jdk",
  "openjdk25-jdk",
  "openjdk8-jre",
  "openjdk11-jre",
  "openjdk17-jre",
  "openjdk21-jre",
  "openjdk22-jre",
  "openjdk23-jre",
  "openjdk24-jre",
  "openjdk25-jre",
];

/**
 * Run the `cargo-auditable` companion binary against the given source path and
 * return its stdout.
 *
 * @param {string} src Path to the Rust binary or source to inspect.
 * @returns {string|undefined} The tool's stdout, or undefined when the binary
 *   is unavailable or produced no output.
 */
export function getCargoAuditableInfo(src) {
  if (CARGO_AUDITABLE_BIN) {
    const result = safeSpawnSync(CARGO_AUDITABLE_BIN, [src]);
    if (result.status !== 0 || result.error) {
      if (result.stdout || result.stderr) {
        console.error(result.stdout, result.stderr);
      }
    }
    if (result) {
      const stdout = result.stdout;
      if (stdout) {
        return stdout;
      }
    }
  }
  return undefined;
}

/**
 * Execute sourcekitten plugin with the given arguments
 *
 * @param args {Array} Arguments
 * @returns {undefined|Object} Command output
 */
export function executeSourcekitten(args) {
  if (SOURCEKITTEN_BIN) {
    const result = safeSpawnSync(SOURCEKITTEN_BIN, args);
    if (result.status !== 0 || result.error) {
      if (result.stdout || result.stderr) {
        console.error(result.stdout, result.stderr);
      }
    }
    if (result) {
      const stdout = result.stdout;
      if (stdout) {
        return JSON.parse(stdout);
      }
    }
  }
  return undefined;
}

/**
 * Canonicalise the distro vendor namespace of an OS package component
 * produced by trivy, regardless of whether trivy expressed the vendor via the
 * purl namespace or the component group (it is inconsistent between
 * packages). e.g. pkg:rpm/alma/... -> pkg:rpm/almalinux/... and
 * pkg:rpm/cbl-mariner/... -> pkg:rpm/azure-linux/... so the purls match the
 * vulnerability feeds. Also aligns the ``distro`` qualifier vendor prefix
 * (alma-9.8 -> almalinux-9.8, mariner-2.0 -> azure-linux-2.0), including
 * spellings that disagree with the namespace, and rebuilds ``group`` and
 * ``bom-ref`` from the rewritten purl.
 *
 * The namespace table is OS_NAMESPACE_ALIAS from lib/inventory/osinfo.js so
 * the trivy path and the os-release path (getDistroInfo) cannot drift apart.
 *
 * A `distro` qualifier that is not purl-safe (trivy emits Amazon Linux as
 * `amazon-2023.12.20260727+(Amazon Linux)`) is replaced with the os-release
 * derived value, or dropped when there is none: an unusable qualifier
 * invalidates the purl and fails validation for the whole BOM.
 *
 * @param {Object} comp trivy OS package component (mutated in place)
 * @param {Object} purlObj parsed PackageURL of comp.purl (mutated in place)
 * @param {string} name component package name (basename form)
 * @param {string} group component group derived from the trivy component name
 * @param {string} [distroId] canonical os-release distro id, e.g. "amazon-2023"
 * @returns {string} the canonicalised group
 */
export function canonicaliseOsPackageNamespace(
  comp,
  purlObj,
  name,
  group,
  distroId,
) {
  if (!purlObj || !OS_PURL_TYPES.includes(purlObj.type)) {
    return group;
  }
  const os_ns = purlObj.namespace || group || "";
  const os_ns_alias = OS_NAMESPACE_ALIAS[os_ns];
  const distroQual = purlObj.qualifiers?.distro;
  let canonicalDistroQual = distroQual;
  if (os_ns_alias && distroQual?.startsWith(`${os_ns}-`)) {
    canonicalDistroQual = `${os_ns_alias}-${distroQual.slice(os_ns.length + 1)}`;
  }
  canonicalDistroQual = canonicalDistroQualifier(canonicalDistroQual);
  if (canonicalDistroQual && !isCleanDistroQualifier(canonicalDistroQual)) {
    canonicalDistroQual = isCleanDistroQualifier(distroId)
      ? distroId
      : undefined;
  }
  if (!os_ns_alias && canonicalDistroQual === distroQual) {
    return group;
  }
  group = os_ns_alias || purlObj.namespace || group || "";
  comp.group = group;
  purlObj.namespace = group;
  if (canonicalDistroQual !== distroQual) {
    if (canonicalDistroQual) {
      purlObj.qualifiers.distro = canonicalDistroQual;
    } else {
      delete purlObj.qualifiers.distro;
    }
  }
  comp.purl = build({
    type: purlObj.type,
    namespace: purlObj.namespace || null,
    name: name,
    version: purlObj.version || null,
    qualifiers: purlObj.qualifiers || null,
    subpath: purlObj.subpath || null,
  });
  comp["bom-ref"] = decodeURIComponent(comp.purl);
  return group;
}

/**
 * Repair a `distro` qualifier that cannot survive purl parsing, in place.
 *
 * trivy stamps Amazon Linux with the full pretty version — the qualifier
 * arrives as `distro=amazon-2023.12.20260727+%28Amazon+Linux%29`, whose spaces
 * and parentheses `Purl.parse` rejects outright ("Invalid character in
 * qualifier distro"). The component then bypasses every canonicalisation below
 * (they all need a parsed purl) and reaches the BOM verbatim, where schema
 * validation fails and the *entire* SBOM is discarded — an Amazon Linux scan
 * produces no output at all today.
 *
 * The release is already known from os-release, so the unusable value is
 * swapped for it; with no usable replacement the qualifier is dropped, since a
 * missing qualifier costs one matching hint while an invalid one costs the
 * whole document.
 *
 * @param {Object} comp component whose purl may carry an unusable qualifier
 * @param {string} [distroId] canonical os-release distro id, e.g. "amazon-2023"
 * @returns {Object} the same component
 */
export function repairOsComponentPurl(comp, distroId) {
  const purl = comp?.purl;
  if (!purl?.includes("distro=")) {
    return comp;
  }
  const match = /([?&]distro=)([^&]*)/.exec(purl);
  if (!match) {
    return comp;
  }
  let decoded = match[2];
  try {
    decoded = decodeURIComponent(match[2].replace(/\+/g, " "));
  } catch (_err) {
    // A value that cannot even be decoded is definitely not purl-safe
  }
  if (isCleanDistroQualifier(decoded)) {
    return comp;
  }
  const replacement = isCleanDistroQualifier(distroId)
    ? `${match[1]}${distroId}`
    : "";
  comp.purl = purl.replace(match[0], replacement).replace(/\?&/, "?");
  if (comp.purl.endsWith("?")) {
    comp.purl = comp.purl.slice(0, -1);
  }
  comp["bom-ref"] = decodeURIComponent(comp.purl);
  return comp;
}

/**
 * Drop source-package shadow components that duplicate a real installed
 * package, in place.
 *
 * A shadow is emitted whenever an rpm/deb declares a source name different
 * from its own (bzip2-libs -> bzip2) so that scanners keying on source names
 * still match. When the source package is *itself* installed at the same
 * version, the shadow's purl is identical to the real component's and the two
 * collapse in trimComponents() — which keeps whichever was seen first and
 * never merges `tags`. Seen-first is trivy's listing order, so the outcome is
 * arbitrary: when the shadow wins, a genuinely installed package is reported
 * with `tags: ["source"]` and identity confidence 0, the very marker the
 * shadow carries so consumers can filter shadows out. That turns a real
 * package into a filtered-away one.
 *
 * Dropping the redundant shadow is loss-free: it duplicates the real
 * component's purl (so nothing that matches on purl changes) and its bom-ref
 * is byte-identical, so no dependency reference can dangle.
 *
 * @param {Array} pkgList component list, mutated in place
 * @returns {Array} the same list, for convenience
 */
export function dropRedundantSourceComponents(pkgList) {
  if (!Array.isArray(pkgList) || !pkgList.length) {
    return pkgList;
  }
  const installedPurls = new Set();
  for (const comp of pkgList) {
    if (comp?.purl && !comp?.tags?.includes("source")) {
      installedPurls.add(comp.purl);
    }
  }
  if (!installedPurls.size) {
    return pkgList;
  }
  for (let i = pkgList.length - 1; i >= 0; i--) {
    const comp = pkgList[i];
    if (comp?.tags?.includes("source") && installedPurls.has(comp.purl)) {
      pkgList.splice(i, 1);
    }
  }
  return pkgList;
}

/**
 * Get the packages installed in the container image filesystem.
 *
 * @param src {String} Source directory containing the extracted filesystem.
 * @param imageConfig {Object} Image configuration containing environment variables, command, entrypoints etc
 * @param options CLI options controlling inventory generation
 *
 * @returns {Object} Metadata containing packages, dependencies, etc
 */
export async function getOSPackages(src, imageConfig, options = {}) {
  if (isDryRun) {
    recordActivity({
      kind: "container",
      reason:
        "Dry run mode blocks Trivy-based OS package generation because it executes external tools and writes temporary output.",
      status: "blocked",
      target: src,
    });
    return {
      allTypes: new Set(),
      binPaths: [],
      bundledRuntimes: new Set(),
      bundledSdks: new Set(),
      dependenciesList: [],
      executables: [],
      osPackages: [],
      osPackageFiles: [],
      sharedLibs: [],
      services: [],
      tools: [],
    };
  }
  const pkgList = [];
  const osPackageEntries = [];
  const dependenciesList = [];
  const allTypes = new Set();
  const bundledSdks = new Set();
  const bundledRuntimes = new Set();
  let osPackageFiles = [];
  let services = [];
  let tools = [];
  let binPaths = extractPathEnv(imageConfig?.Env);
  if (!binPaths?.length) {
    const rootBinPaths = getDirs(src, "{sbin,bin}", true, false);
    const usrBinPaths = getDirs(
      src,
      "/{app,opt,usr,home}/**/{sbin,bin}",
      true,
      true,
    );
    binPaths = Array.from(
      new Set(
        rootBinPaths
          .concat(usrBinPaths)
          .map((f) => relative(src, f))
          .filter(Boolean),
      ),
    ).sort();
    if (binPaths.length) {
      recordDegradation("binary.paths.inferred", {
        ecosystem: "generic",
        tool: "trivy",
        impact: "none",
        path: src,
        detail:
          "The image config carried no PATH, so executable directories were inferred by scanning the filesystem.",
      });
    }
    if (DEBUG_MODE && binPaths.length) {
      console.log(
        `Falling back to inferred binary paths for ${src}: ${binPaths.join(", ")}`,
      );
    }
  }
  // trivy-cdxgen only scans a root filesystem; it has no `image` command. The
  // caller hands over the exported image directory, so a missing path means
  // the export failed and there is nothing for trivy to scan.
  const rootfsPresent = TRIVY_BIN ? safeExistsSync(src) : false;
  if (TRIVY_BIN && !rootfsPresent) {
    console.warn(
      `Skipping the trivy OS package scan: the root filesystem ${src} does not exist.`,
    );
  }
  if (TRIVY_BIN && rootfsPresent) {
    const trivyCacheDir = join(homedir(), ".cache", "trivy");
    try {
      safeMkdirSync(join(trivyCacheDir, "db"), { recursive: true });
      safeMkdirSync(join(trivyCacheDir, "java-db"), { recursive: true });
    } catch (_err) {
      // ignore errors
    }
    const tempDir = safeMkdtempSync(join(getTmpDir(), "trivy-cdxgen-"));
    const bomJsonFile = join(tempDir, "trivy-bom.json");
    const args = [
      "rootfs",
      "--cache-dir",
      trivyCacheDir,
      "--output",
      bomJsonFile,
    ];
    if (DEBUG_MODE) {
      args.push("--debug");
    }
    args.push(src);
    if (DEBUG_MODE) {
      console.log("Executing", TRIVY_BIN, args.join(" "));
    }
    const result = safeSpawnSync(TRIVY_BIN, args);
    if (result.status !== 0 || result.error) {
      if (result.stdout || result.stderr) {
        console.error(result.stdout, result.stderr);
      }
    }
    if (safeExistsSync(bomJsonFile)) {
      let tmpBom = {};
      try {
        tmpBom = JSON.parse(
          readFileSync(bomJsonFile, {
            encoding: "utf-8",
          }),
        );
      } catch (_e) {
        // ignore errors
      }
      // Clean up
      if (tempDir?.startsWith(getTmpDir())) {
        if (DEBUG_MODE) {
          console.log(`Cleaning up ${tempDir}`);
        }
        safeRmSync(tempDir, { recursive: true, force: true });
      }
      const osReleaseData = readOsRelease(src);
      if (DEBUG_MODE) {
        console.log(osReleaseData);
      }
      // distro_name must be a real release codename/token (bookworm, jammy,
      // rhel-9, alpine-3.19), never a distro *display name*. VERSION_CODENAME is
      // authoritative when present; otherwise the RHEL/CentOS product-name
      // fallbacks are only accepted when they resolve through OS_DISTRO_ALIAS
      // (e.g. "red hat enterprise linux 9" -> "rhel-9"). Display names such as
      // "Rocky Linux" or "AlmaLinux" have no alias entry and are dropped so we
      // never emit a bogus distro_name qualifier (RPM distros track packages
      // flat, without a release segment, so folding a display name breaks
      // downstream vuln-db matching).
      let distro_codename = (
        osReleaseData["VERSION_CODENAME"] || ""
      ).toLowerCase();
      if (!distro_codename) {
        const distro_display_name = (
          osReleaseData["CENTOS_MANTISBT_PROJECT"] ||
          osReleaseData["REDHAT_BUGZILLA_PRODUCT"] ||
          osReleaseData["REDHAT_SUPPORT_PRODUCT"] ||
          ""
        ).toLowerCase();
        if (distro_display_name && OS_DISTRO_ALIAS[distro_display_name]) {
          distro_codename = OS_DISTRO_ALIAS[distro_display_name];
        }
      }
      let distro_id = osReleaseData["ID"] || "";
      const distro_id_like = osReleaseData["ID_LIKE"] || "";
      let purl_type = "rpm";
      switch (distro_id) {
        case "debian":
        case "ubuntu":
        case "pop":
          purl_type = "deb";
          break;
        case "sles":
        case "suse":
        case "opensuse":
          purl_type = "rpm";
          break;
        case "alpine":
          purl_type = "apk";
          if (osReleaseData.VERSION_ID) {
            const versionParts = osReleaseData["VERSION_ID"].split(".");
            if (versionParts.length >= 2) {
              distro_codename = `alpine-${versionParts[0]}.${versionParts[1]}`;
            }
          }
          break;
        case "alpaquita":
          purl_type = "apk";
          break;
        default:
          if (distro_id_like.includes("debian")) {
            purl_type = "deb";
          } else if (distro_id_like.includes("alpine")) {
            purl_type = "apk";
          } else if (
            distro_id_like.includes("rhel") ||
            distro_id_like.includes("centos") ||
            distro_id_like.includes("fedora")
          ) {
            purl_type = "rpm";
          }
          break;
      }
      if (osReleaseData["VERSION_ID"]) {
        distro_id = `${distro_id}-${osReleaseData["VERSION_ID"]}`;
        if (OS_DISTRO_ALIAS[distro_id]) {
          distro_codename = OS_DISTRO_ALIAS[distro_id];
        }
      }
      // Canonicalise the distro qualifier vendor (e.g. "mariner-2.0" ->
      // "azure-linux-2.0") so every spelling of one release yields a single
      // qualifier value. This runs before distro_id is used to overwrite
      // trivy's own qualifier below.
      distro_id = canonicalDistroQualifier(distro_id);
      const tmpDependencies = {};
      tools = enrichToolComponents(
        (Array.isArray(tmpBom?.metadata?.tools)
          ? tmpBom.metadata.tools
          : tmpBom?.metadata?.tools?.components || []
        ).filter((tool) => tool?.["bom-ref"] && tool?.name !== "cdxgen"),
        ["trivy", "trustinspector"],
      );
      const toolRefs = extractToolRefs(
        { components: tools },
        (tool) => tool?.name !== "cdxgen",
      );
      (tmpBom.dependencies || []).forEach((d) => {
        tmpDependencies[d.ref] = d.dependsOn;
      });
      if (tmpBom?.components) {
        for (const comp of tmpBom.components) {
          if (comp.purl) {
            const origBomRef = comp["bom-ref"];
            // Fix the group
            let group = dirname(comp.name);
            const name = basename(comp.name);
            let purlObj;
            if (group === ".") {
              group = "";
            }
            comp.group = group;
            comp.name = name;
            const modularityLabel = extractModularityLabel(comp);
            repairOsComponentPurl(comp, distro_id);
            try {
              purlObj = Purl.parse(comp.purl);
              purlObj.qualifiers = purlObj.qualifiers || {};
            } catch (_err) {
              // continue regardless of error
            }
            // Canonicalise the distro vendor namespace (see
            // canonicaliseOsPackageNamespace) before any later bom-ref
            // rebuild so the rewritten purl, group and bom-ref stay in sync.
            group = canonicaliseOsPackageNamespace(
              comp,
              purlObj,
              name,
              group,
              distro_id,
            );
            if (
              group === "" &&
              purlObj &&
              OS_PURL_TYPES.includes(purlObj["type"])
            ) {
              try {
                if (purlObj?.namespace && purlObj.namespace !== "") {
                  group =
                    OS_NAMESPACE_ALIAS[purlObj.namespace] || purlObj.namespace;
                  comp.group = group;
                  purlObj.namespace = group;
                }
                if (distro_id?.length) {
                  purlObj.qualifiers["distro"] = distro_id;
                }
                if (distro_codename?.length) {
                  purlObj.qualifiers["distro_name"] = distro_codename;
                }
                // Bug fix for mageia and oracle linux
                // Type is being returned as none for ubuntu as well!
                if (purlObj?.type === "none") {
                  purlObj["type"] = purl_type;
                  purlObj["namespace"] = "";
                  comp.group = "";
                  if (comp.purl?.includes(".mga")) {
                    purlObj["namespace"] = "mageia";
                    comp.group = "mageia";
                    purlObj.qualifiers["distro"] = "mageia";
                    distro_codename = "mga";
                  }
                  comp.purl = build({
                    type: purlObj.type,
                    namespace: purlObj.namespace || null,
                    name: name,
                    version: purlObj.version || null,
                    qualifiers: purlObj.qualifiers || null,
                    subpath: purlObj.subpath || null,
                  });
                  comp["bom-ref"] = decodeURIComponent(comp.purl);
                }
                if (purlObj?.type !== "none") {
                  allTypes.add(purlObj.type);
                }
                // Prefix distro codename for ubuntu
                if (purlObj?.qualifiers?.distro) {
                  allTypes.add(purlObj.qualifiers.distro);
                  if (OS_DISTRO_ALIAS[purlObj.qualifiers.distro]) {
                    distro_codename =
                      OS_DISTRO_ALIAS[purlObj.qualifiers.distro];
                  } else if (group === "alpine") {
                    const dtmpA = purlObj.qualifiers.distro.split(".");
                    if (dtmpA && dtmpA.length > 2) {
                      distro_codename = `${dtmpA[0]}.${dtmpA[1]}`;
                    }
                  } else if (group === "photon") {
                    const dtmpA = purlObj.qualifiers.distro.split("-");
                    if (dtmpA && dtmpA.length > 1) {
                      distro_codename = dtmpA[0];
                    }
                  } else if (group === "redhat") {
                    const dtmpA = purlObj.qualifiers.distro.split(".");
                    if (dtmpA && dtmpA.length > 1) {
                      distro_codename = dtmpA[0].replace(
                        "redhat",
                        "enterprise_linux",
                      );
                    }
                  }
                }
                if (distro_codename !== "") {
                  allTypes.add(distro_codename);
                  allTypes.add(purlObj.namespace);
                  comp.purl = build({
                    type: purlObj.type,
                    namespace: purlObj.namespace || null,
                    name: name,
                    version: purlObj.version || null,
                    qualifiers: purlObj.qualifiers || null,
                    subpath: purlObj.subpath || null,
                  });
                  comp["bom-ref"] = decodeURIComponent(comp.purl);
                }
              } catch (_err) {
                // continue regardless of error
              }
            }
            if (comp.purl.includes("epoch=")) {
              try {
                const epoch = purlObj.qualifiers?.epoch;
                // trivy seems to be removing the epoch from the version and moving it to a qualifier
                // let's fix this hack to improve confidence.
                if (epoch) {
                  purlObj.version = `${epoch}:${purlObj.version}`;
                  comp.version = purlObj.version;
                }
                comp.evidence = {
                  identity: [
                    {
                      field: "purl",
                      confidence: 1,
                      methods: [
                        {
                          technique: "other",
                          confidence: 1,
                          value: comp.purl,
                        },
                      ],
                    },
                  ],
                };
                if (distro_id?.length) {
                  purlObj.qualifiers["distro"] = distro_id;
                }
                if (distro_codename?.length) {
                  purlObj.qualifiers["distro_name"] = distro_codename;
                }
                allTypes.add(purlObj.namespace);
                comp.purl = build({
                  type: purlObj.type,
                  namespace: purlObj.namespace || null,
                  name: name,
                  version: purlObj.version || null,
                  qualifiers: purlObj.qualifiers || null,
                  subpath: purlObj.subpath || null,
                });
                comp["bom-ref"] = decodeURIComponent(comp.purl);
              } catch (err) {
                // continue regardless of error
                console.log(err);
              }
            }
            attachIdentityTools(comp, toolRefs);
            // Fix licenses
            if (
              comp.licenses &&
              Array.isArray(comp.licenses) &&
              comp.licenses.length
            ) {
              const newLicenses = [];
              for (const aLic of comp.licenses) {
                if (aLic?.license?.name) {
                  if (isSpdxLicenseExpression(aLic.license.name)) {
                    newLicenses.push({ expression: aLic.license.name });
                  } else {
                    const possibleId = findLicenseId(aLic.license.name);
                    if (possibleId !== aLic.license.name) {
                      newLicenses.push({ license: { id: possibleId } });
                    } else {
                      newLicenses.push({
                        license: { name: aLic.license.name },
                      });
                    }
                  }
                } else if (
                  aLic?.license &&
                  Object.keys(aLic).length &&
                  Object.keys(aLic.license).length
                ) {
                  newLicenses.push(aLic);
                }
              }
              comp.licenses = adjustLicenseInformation(newLicenses);
            }
            // Fix hashes
            if (
              comp.hashes &&
              Array.isArray(comp.hashes) &&
              comp.hashes.length
            ) {
              const hashContent = comp.hashes[0].content;
              if (!hashContent || hashContent.length < 32) {
                delete comp.hashes;
              }
            }
            const compProperties = comp.properties;
            const trivyMetadata = extractTrivyOsPackageMetadata(compProperties);
            const fallbackIdentityProperties = promoteTrivyOsPackageIdentity(
              comp,
              trivyMetadata,
            );
            let { srcName, srcVersion, srcRelease, epoch } = trivyMetadata;
            // See issue #2067
            if (srcVersion && srcRelease) {
              srcVersion = `${srcVersion}-${srcRelease}`;
            }
            if (epoch) {
              srcVersion = `${epoch}:${srcVersion}`;
            }
            const labelProperties = modularityLabel
              ? [{ name: "cdx:os:modularityLabel", value: modularityLabel }]
              : [];
            if (
              trivyMetadata.retainedProperties.length ||
              fallbackIdentityProperties.length ||
              labelProperties.length
            ) {
              comp.properties = uniqueProperties(
                trivyMetadata.retainedProperties
                  .concat(fallbackIdentityProperties)
                  .concat(labelProperties),
              );
            } else {
              delete comp.properties;
            }
            // A golang purl carries the module path in its namespace, and the
            // Go standard library has no module path — trivy reports it as the
            // bare name `stdlib`, which is not a valid purl. The component is
            // worth keeping, since the toolchain version is a real signal, so
            // the purl is dropped rather than given an invented namespace.
            if (
              comp.purl?.startsWith("pkg:golang/") &&
              !tryBuildPurl({
                type: "golang",
                namespace: comp.group || null,
                name: comp.name,
                version: comp.version || null,
              })
            ) {
              comp["bom-ref"] = decodeURIComponent(comp.purl);
              delete comp.purl;
            }
            // Bug fix: We can get bom-ref like this: pkg:rpm/sles/libstdc%2B%2B6@14.2.0+git10526-150000.1.6.1?arch=x86_64&distro=sles-15.5
            if (
              comp["bom-ref"] &&
              comp.purl &&
              comp["bom-ref"] !== decodeURIComponent(comp.purl)
            ) {
              comp["bom-ref"] = decodeURIComponent(comp.purl);
            }
            pkgList.push(comp);
            if (trivyMetadata.installedFiles.length) {
              osPackageEntries.push({
                capabilities: trivyMetadata.capabilities,
                commandPaths: trivyMetadata.installedCommandPaths,
                commands: trivyMetadata.installedCommands,
                files: trivyMetadata.installedFiles,
                packageName: comp.name,
                packageRef: comp["bom-ref"],
                packageVersion: comp.version,
              });
            }
            detectSdksRuntimes(comp, bundledSdks, bundledRuntimes);
            const compDeps = retrieveDependencies(
              tmpDependencies,
              origBomRef,
              comp,
            );
            if (compDeps) {
              dependenciesList.push(compDeps);
            }
            // HACK: Many vulnerability databases, including vdb, track vulnerabilities based on source package names :(
            // If there is a source package defined we include it as well to make such SCA scanners work.
            // As a compromise, we reduce the confidence to zero so that there is a way to filter these out.
            if (srcName && srcVersion && srcName !== comp.name) {
              const newComp = Object.assign({}, comp);
              newComp.name = srcName;
              newComp.version = srcVersion;
              newComp.tags = ["source"];
              newComp.evidence = {
                identity: [
                  {
                    field: "purl",
                    confidence: 0,
                    methods: [
                      {
                        technique: "filename",
                        confidence: 0,
                        value: comp.name,
                      },
                    ],
                  },
                ],
              };
              // Track upstream and source versions as qualifiers
              if (purlObj) {
                const newCompQualifiers = {
                  ...purlObj.qualifiers,
                };
                delete newCompQualifiers.epoch;
                if (epoch) {
                  newCompQualifiers.epoch = epoch;
                }
                newComp.purl = build({
                  type: purlObj.type,
                  namespace: purlObj.namespace || null,
                  name: srcName,
                  version: srcVersion || null,
                  qualifiers: newCompQualifiers || null,
                  subpath: purlObj.subpath || null,
                });
              }
              newComp["bom-ref"] = decodeURIComponent(newComp.purl);
              delete newComp.properties;
              attachIdentityTools(newComp, toolRefs);
              pkgList.push(newComp);
              detectSdksRuntimes(newComp, bundledSdks, bundledRuntimes);
            }
          }
        }
      }
    }
  }
  dropRedundantSourceComponents(pkgList);
  const rootfsRepositoryInventory = await collectRootfsRepositoryInventory(
    src,
    options,
  );
  if (rootfsRepositoryInventory.components.length) {
    pkgList.push(...rootfsRepositoryInventory.components);
  }
  if (rootfsRepositoryInventory.dependenciesList.length) {
    dependenciesList.push(...rootfsRepositoryInventory.dependenciesList);
  }
  const {
    components: ownedFileComponents,
    dependenciesList: ownedFileDependencies,
    ownedFilePaths,
    services: ownedServices,
  } = await createOSPackageFileComponents(src, osPackageEntries);
  if (ownedFileComponents.length) {
    osPackageFiles = ownedFileComponents;
  }
  if (ownedFileDependencies.length) {
    dependenciesList.push(...ownedFileDependencies);
  }
  if (ownedServices.length) {
    services = ownedServices;
  }
  let executables = [];
  if (binPaths?.length) {
    executables = await fileComponents(
      src,
      collectExecutables(src, binPaths, ownedFilePaths),
      "executable",
    );
  }
  // Directories containing shared libraries
  const defaultLibPaths = [
    "/lib",
    "/lib64",
    "/usr/lib",
    "/usr/lib64",
    "/usr/local/lib64",
    "/usr/local/lib",
    "/lib/x86_64-linux-gnu",
    "/usr/lib/x86_64-linux-gnu",
    "/lib/i386-linux-gnu",
    "/usr/lib/i386-linux-gnu",
    "/lib/arm-linux-gnueabihf",
    "/usr/lib/arm-linux-gnueabihf",
    "/opt/**/lib",
    "/root/**/lib",
  ];
  const sharedLibs = await fileComponents(
    src,
    collectSharedLibs(
      src,
      defaultLibPaths,
      "/etc/ld.so.conf",
      "/etc/ld.so.conf.d/*.conf",
      ownedFilePaths,
    ),
    "shared_library",
  );
  return {
    osPackages: pkgList,
    osPackageFiles,
    dependenciesList,
    allTypes: Array.from(allTypes).sort(),
    bundledSdks: Array.from(bundledSdks).sort(),
    bundledRuntimes: Array.from(bundledRuntimes).sort(),
    binPaths,
    executables,
    sharedLibs,
    services,
    tools,
  };
}

function extractTrivyOsPackageMetadata(compProperties) {
  const metadata = {
    capabilities: [],
    installedCommandPaths: [],
    installedCommands: [],
    installedFiles: [],
    packageMaintainer: undefined,
    packageVendor: undefined,
    retainedProperties: [],
    srcName: undefined,
    srcRelease: undefined,
    srcVersion: undefined,
    epoch: undefined,
  };
  if (!Array.isArray(compProperties) || !compProperties.length) {
    return metadata;
  }
  for (const aprop of compProperties) {
    if (!aprop?.name) {
      continue;
    }
    if (aprop.name.endsWith("SrcName")) {
      metadata.srcName = aprop.value;
      continue;
    }
    if (aprop.name.endsWith("SrcVersion")) {
      metadata.srcVersion = aprop.value;
      continue;
    }
    if (aprop.name.endsWith("SrcRelease")) {
      metadata.srcRelease = aprop.value;
      continue;
    }
    if (aprop.name.endsWith("SrcEpoch")) {
      metadata.epoch = aprop.value;
      continue;
    }
    if (aprop.name.endsWith("PackageMaintainer")) {
      metadata.packageMaintainer = aprop.value;
      continue;
    }
    if (aprop.name.endsWith("PackageVendor")) {
      metadata.packageVendor = aprop.value;
      continue;
    }
    if (aprop.name.endsWith("InstalledFile")) {
      metadata.installedFiles.push(aprop.value);
      continue;
    }
    if (aprop.name.endsWith("InstalledCommandPath")) {
      metadata.installedCommandPaths.push(aprop.value);
      metadata.retainedProperties.push(aprop);
      continue;
    }
    if (aprop.name.endsWith("InstalledCommand")) {
      metadata.installedCommands.push(aprop.value);
      metadata.retainedProperties.push(aprop);
      continue;
    }
    if (aprop.name.endsWith("Capability")) {
      metadata.capabilities.push(aprop.value);
      metadata.retainedProperties.push(aprop);
      continue;
    }
    if (
      aprop.name.endsWith("CapabilityCount") ||
      aprop.name.endsWith("InstalledFileCount") ||
      aprop.name.endsWith("InstalledCommandCount")
    ) {
      metadata.retainedProperties.push(aprop);
      continue;
    }
    metadata.retainedProperties.push(aprop);
  }
  metadata.capabilities = uniqueSortedStrings(metadata.capabilities);
  metadata.installedCommandPaths = uniqueSortedStrings(
    metadata.installedCommandPaths,
  );
  metadata.installedCommands = uniqueSortedStrings(metadata.installedCommands);
  metadata.installedFiles = uniqueSortedStrings(metadata.installedFiles);
  metadata.retainedProperties = uniqueProperties(metadata.retainedProperties);
  return metadata;
}

function getOrganizationalEntityName(entity) {
  if (!entity) {
    return undefined;
  }
  if (typeof entity === "string") {
    return entity.trim() || undefined;
  }
  if (typeof entity === "object" && typeof entity.name === "string") {
    return entity.name.trim() || undefined;
  }
  return undefined;
}

function sameOrganizationalEntity(entity, expectedName) {
  const currentName = getOrganizationalEntityName(entity);
  return Boolean(
    currentName &&
      expectedName &&
      currentName.localeCompare(expectedName, undefined, {
        sensitivity: "accent",
      }) === 0,
  );
}

function mergeOrganizationalEntityField(component, fieldName, entityName) {
  const normalizedName = `${entityName || ""}`.trim();
  if (!normalizedName) {
    return { applied: false, represented: false };
  }
  if (!component?.[fieldName]) {
    component[fieldName] = { name: normalizedName };
    return { applied: true, represented: true };
  }
  if (sameOrganizationalEntity(component[fieldName], normalizedName)) {
    return { applied: false, represented: true };
  }
  return { applied: false, represented: false };
}

function parseOrganizationalContact(value) {
  const normalizedValue = `${value || ""}`.trim();
  if (!normalizedValue) {
    return undefined;
  }
  const match = normalizedValue.match(/^([^<>]+?)\s*<([^<>\s]+@[^<>\s]+)>$/);
  if (match) {
    return {
      name: match[1].trim(),
      email: match[2].trim(),
    };
  }
  return { name: normalizedValue };
}

function sameOrganizationalContact(left, right) {
  if (!left || !right) {
    return false;
  }
  const leftName = `${left.name || ""}`.trim();
  const rightName = `${right.name || ""}`.trim();
  const leftEmail = `${left.email || ""}`.trim().toLowerCase();
  const rightEmail = `${right.email || ""}`.trim().toLowerCase();
  return leftName === rightName && leftEmail === rightEmail;
}

function mergeAuthorsFromMaintainer(component, maintainerValue) {
  const authorContact = parseOrganizationalContact(maintainerValue);
  if (!authorContact?.name) {
    return { applied: false, represented: false };
  }
  if (!Array.isArray(component?.authors) || !component.authors.length) {
    component.authors = [authorContact];
    return { applied: true, represented: true };
  }
  if (
    component.authors.some((author) =>
      sameOrganizationalContact(author, authorContact),
    )
  ) {
    return { applied: false, represented: true };
  }
  return { applied: false, represented: false };
}

function promoteTrivyOsPackageIdentity(component, trivyMetadata) {
  const fallbackProperties = [];
  const vendorValue = `${trivyMetadata?.packageVendor || ""}`.trim();
  const supplierName = getOrganizationalEntityName(component?.supplier);
  const maintainerValue = `${
    trivyMetadata?.packageMaintainer || supplierName || ""
  }`.trim();

  const maintainerAuthorResult = mergeAuthorsFromMaintainer(
    component,
    maintainerValue,
  );
  const maintainerSupplierResult = mergeOrganizationalEntityField(
    component,
    "supplier",
    maintainerValue,
  );
  if (
    trivyMetadata?.packageMaintainer &&
    !maintainerAuthorResult.represented &&
    !maintainerSupplierResult.represented
  ) {
    fallbackProperties.push({
      name: "internal:PackageMaintainer",
      value: trivyMetadata.packageMaintainer,
    });
  }

  const vendorSupplierResult = mergeOrganizationalEntityField(
    component,
    "supplier",
    vendorValue,
  );
  const vendorManufacturerResult = mergeOrganizationalEntityField(
    component,
    "manufacturer",
    vendorValue,
  );
  if (
    vendorValue &&
    !vendorSupplierResult.represented &&
    !vendorManufacturerResult.represented
  ) {
    fallbackProperties.push({
      name: "internal:PackageVendor",
      value: vendorValue,
    });
  }
  return fallbackProperties;
}

async function collectRootfsRepositoryInventory(basePath, options = {}) {
  let trustedKeyComponents = [];
  let refsByPath = new Map();
  if (isCycloneDxComponentTypeEnabled("cryptographic-asset", options)) {
    ({ components: trustedKeyComponents, refsByPath } =
      await collectTrustedKeyComponents(basePath));
    trustedKeyComponents = applyTrustMaterialEnhancements(
      trustedKeyComponents,
      collectTrustInspectorRootfsInventory(basePath),
    );
  }
  refsByPath = new Map(
    trustedKeyComponents
      .map((component) => {
        const srcFile = (component.properties || []).find(
          (property) => property.name === "internal:SrcFile",
        )?.value;
        return srcFile
          ? [normalizeContainerPath(srcFile), component["bom-ref"]]
          : undefined;
      })
      .filter(Boolean),
  );
  const repositoryEntries = uniqueRepositoryEntries(
    parseAptRepositorySources(basePath).concat(
      parseYumRepositorySources(basePath),
    ),
  );
  const components = [...trustedKeyComponents];
  const dependenciesList = [];
  const seenComponentRefs = new Set(components.map((comp) => comp["bom-ref"]));
  for (const entry of repositoryEntries) {
    const component = createRepositorySourceComponent(entry);
    if (seenComponentRefs.has(component["bom-ref"])) {
      continue;
    }
    seenComponentRefs.add(component["bom-ref"]);
    components.push(component);
    const dependsOn = uniqueSortedStrings(
      (entry.keyReferences || [])
        .map((keyRef) => normalizeLocalRepositoryReference(keyRef))
        .map((keyRef) => refsByPath.get(keyRef))
        .filter(Boolean),
    );
    if (dependsOn.length) {
      dependenciesList.push({
        ref: component["bom-ref"],
        dependsOn,
      });
    }
  }
  return { components, dependenciesList };
}

async function collectTrustedKeyComponents(basePath) {
  const refsByPath = new Map();
  const components = [];
  for (const normalizedPath of collectTrustedKeyPaths(basePath)) {
    const component = await createTrustedKeyComponent(basePath, normalizedPath);
    if (!component?.["bom-ref"]) {
      continue;
    }
    refsByPath.set(normalizedPath, component["bom-ref"]);
    components.push(component);
  }
  return { components, refsByPath };
}

function collectTrustedKeyPaths(basePath) {
  const results = new Set();
  for (const candidate of [
    "/etc/apt/trusted.gpg",
    "/etc/apt/trusted.gpg.d",
    "/usr/share/keyrings",
    "/etc/pki/rpm-gpg",
    "/usr/share/distribution-gpg-keys",
    "/etc/apk/keys",
  ]) {
    const normalizedCandidate = normalizeContainerPath(candidate);
    const absoluteCandidate = join(
      basePath,
      normalizedCandidate.replace(/^\/+/, ""),
    );
    if (!safeExistsSync(absoluteCandidate)) {
      continue;
    }
    const stats = statSync(absoluteCandidate, { throwIfNoEntry: false });
    if (!stats) {
      continue;
    }
    if (stats.isDirectory()) {
      for (const filePath of walkRootfsFiles(basePath, normalizedCandidate)) {
        if (isTrustedKeyPath(filePath)) {
          results.add(filePath);
        }
      }
      continue;
    }
    if (isTrustedKeyPath(normalizedCandidate)) {
      results.add(normalizedCandidate);
    }
  }
  return Array.from(results).sort();
}

function walkRootfsFiles(basePath, normalizedDir) {
  const results = [];
  const absoluteDir = join(basePath, normalizedDir.replace(/^\/+/, ""));
  if (!safeExistsSync(absoluteDir)) {
    return results;
  }
  let entries;
  try {
    entries = readdirSync(absoluteDir, { withFileTypes: true });
  } catch (_e) {
    return results;
  }
  for (const entry of entries) {
    const normalizedPath = normalizeContainerPath(
      `${normalizedDir.replace(/\/+$/, "")}/${entry.name}`,
    );
    if (entry.isDirectory()) {
      results.push(...walkRootfsFiles(basePath, normalizedPath));
      continue;
    }
    if (entry.isFile()) {
      results.push(normalizedPath);
    }
  }
  return results;
}

function isTrustedKeyPath(normalizedPath) {
  const lowerPath = normalizeContainerPath(normalizedPath)?.toLowerCase();
  if (!lowerPath) {
    return false;
  }
  return (
    lowerPath === "/etc/apt/trusted.gpg" ||
    lowerPath.includes("/trusted.gpg.d/") ||
    lowerPath.includes("/keyrings/") ||
    lowerPath.includes("/rpm-gpg/") ||
    lowerPath.includes("/distribution-gpg-keys/") ||
    lowerPath.includes("/apk/keys/")
  );
}

async function createTrustedKeyComponent(basePath, normalizedPath) {
  const absolutePath = join(basePath, normalizedPath.replace(/^\/+/, ""));
  const stats = statSync(absolutePath, { throwIfNoEntry: false });
  if (!stats || stats.isDirectory()) {
    return undefined;
  }
  let hashValues = {};
  try {
    hashValues = await multiChecksumFile(["sha1", "sha256"], absolutePath);
  } catch (_err) {
    // ignore
  }
  const version = hashValues.sha256 || hashValues.sha1 || `${stats.mtimeMs}`;
  const hashes = [];
  if (hashValues.sha1) {
    hashes.push({ alg: "SHA-1", content: hashValues.sha1 });
  }
  if (hashValues.sha256) {
    hashes.push({ alg: "SHA-256", content: hashValues.sha256 });
  }
  return {
    "bom-ref": `crypto/related-crypto-material/public-key/${encodeURIComponent(normalizedPath)}@${hashValues.sha256 ? `sha256:${hashValues.sha256}` : version}`,
    name: basename(normalizedPath),
    type: "cryptographic-asset",
    version,
    hashes,
    cryptoProperties: {
      assetType: "related-crypto-material",
      relatedCryptoMaterialProperties: {
        type: "public-key",
        id: hashValues.sha256 || hashValues.sha1 || normalizedPath,
        state: "active",
      },
    },
    properties: uniqueProperties([
      { name: "internal:SrcFile", value: normalizedPath },
      {
        name: "cdx:crypto:trustDomain",
        value: deriveTrustedKeyDomain(normalizedPath),
      },
      { name: "cdx:crypto:keyPath", value: normalizedPath },
      {
        name: "cdx:crypto:fileExtension",
        value: extname(normalizedPath).replace(/^\./, "") || "gpg",
      },
    ]),
  };
}

function deriveTrustedKeyDomain(normalizedPath) {
  const lowerPath = normalizeContainerPath(normalizedPath)?.toLowerCase() || "";
  if (lowerPath.includes("/apt/") || lowerPath.includes("/keyrings/")) {
    return "apt";
  }
  if (
    lowerPath.includes("/rpm-gpg/") ||
    lowerPath.includes("/distribution-gpg-keys/")
  ) {
    return "rpm";
  }
  if (lowerPath.includes("/apk/keys/")) {
    return "apk";
  }
  return "generic";
}

function trustInspectorToolRefs() {
  return extractToolRefs({
    components: getPluginToolComponents(["trustinspector"]),
  });
}

function executeTrustInspector(args, activity) {
  if (isDryRun) {
    recordActivity({
      kind: "trustinspector",
      reason:
        "Dry run mode blocks trustinspector execution and reports the requested inspection instead.",
      status: "blocked",
      ...activity,
    });
    return undefined;
  }
  if (!TRUSTINSPECTOR_BIN) {
    return undefined;
  }
  if (DEBUG_MODE) {
    console.log("Executing", TRUSTINSPECTOR_BIN, args.join(" "));
  }
  const result = safeSpawnSync(TRUSTINSPECTOR_BIN, args);
  if (result?.status !== 0 || result?.error) {
    if (DEBUG_MODE && (result?.stdout || result?.stderr)) {
      console.error(result.stdout, result.stderr);
    }
    return undefined;
  }
  if (!result?.stdout) {
    return undefined;
  }
  try {
    return JSON.parse(result.stdout);
  } catch (_err) {
    return undefined;
  }
}

function normalizeTrustInspectorTargetPath(basePath) {
  if (typeof basePath !== "string") {
    return undefined;
  }
  const trimmedPath = basePath.trim();
  if (
    !trimmedPath ||
    hasDangerousUnicode(trimmedPath) ||
    /[\r\n]/.test(trimmedPath)
  ) {
    return undefined;
  }
  const resolvedPath = resolve(trimmedPath);
  if (
    !resolvedPath ||
    hasDangerousUnicode(resolvedPath) ||
    /[\r\n]/.test(resolvedPath)
  ) {
    return undefined;
  }
  if (
    (isWin &&
      !(
        resolvedPath.startsWith("\\\\") ||
        isValidDriveRoot(resolvedPath.slice(0, 3))
      )) ||
    (!isWin && !resolvedPath.startsWith("/")) ||
    !safeExistsSync(resolvedPath)
  ) {
    return undefined;
  }
  const targetStats = statSync(resolvedPath, { throwIfNoEntry: false });
  if (!targetStats?.isDirectory()) {
    return undefined;
  }
  let canonicalPath;
  try {
    canonicalPath = realpathSync(resolvedPath);
  } catch (_err) {
    return undefined;
  }
  if (
    !canonicalPath ||
    hasDangerousUnicode(canonicalPath) ||
    /[\r\n]/.test(canonicalPath)
  ) {
    return undefined;
  }
  return resolvedPath;
}

function trustMaterialHashes(material) {
  const hashes = [];
  if (material?.sha1) {
    hashes.push({ alg: "SHA-1", content: material.sha1 });
  }
  if (material?.sha256) {
    hashes.push({ alg: "SHA-256", content: material.sha256 });
  }
  return hashes;
}

function trustMaterialState(material) {
  const expiresAt = material?.expiresAt
    ? Date.parse(material.expiresAt)
    : Number.NaN;
  if (!Number.isNaN(expiresAt) && expiresAt < Date.now()) {
    return "expired";
  }
  return "active";
}

function createTrustMaterialComponent(material) {
  const normalizedPath = normalizeContainerPath(material?.path);
  if (!normalizedPath || !material?.kind) {
    return undefined;
  }
  const hashes = trustMaterialHashes(material);
  const sharedProperties = uniqueProperties([
    { name: "internal:SrcFile", value: normalizedPath },
    ...(material?.properties || []),
    ...(material?.fingerprint
      ? [{ name: "cdx:crypto:fingerprint", value: material.fingerprint }]
      : []),
    ...(material?.algorithm
      ? [{ name: "cdx:crypto:algorithm", value: material.algorithm }]
      : []),
    ...(material?.keyStrength
      ? [{ name: "cdx:crypto:keyStrength", value: `${material.keyStrength}` }]
      : []),
    ...(material?.createdAt
      ? [{ name: "cdx:crypto:createdAt", value: material.createdAt }]
      : []),
    ...(material?.expiresAt
      ? [{ name: "cdx:crypto:expiresAt", value: material.expiresAt }]
      : []),
  ]);
  let component;
  if (material.kind === "certificate") {
    component = {
      "bom-ref": `crypto/certificate/${encodeURIComponent(material.name || normalizedPath)}@${material.sha256 ? `sha256:${material.sha256}` : material.serial || material.expiresAt || "unknown"}`,
      name: material.name || basename(normalizedPath),
      type: "cryptographic-asset",
      version:
        material.sha256 ||
        material.serial ||
        material.expiresAt ||
        "configured",
      hashes,
      description: material.subject || normalizedPath,
      cryptoProperties: {
        assetType: "certificate",
        algorithmProperties: {
          executionEnvironment: "unknown",
          implementationPlatform: "unknown",
        },
        certificateProperties: {
          serialNumber: material.serial || undefined,
          subjectName: material.subject || undefined,
          issuerName: material.issuer || undefined,
          notValidBefore: material.createdAt || undefined,
          notValidAfter: material.expiresAt || undefined,
          certificateFormat: material.format || "X.509",
          certificateFileExtension: material.fileExtension || undefined,
          fingerprint: material.fingerprint
            ? { alg: "SHA-256", content: material.fingerprint }
            : undefined,
        },
      },
      properties: uniqueProperties(
        sharedProperties.concat(
          material.trustDomain
            ? [{ name: "cdx:crypto:trustDomain", value: material.trustDomain }]
            : [],
        ),
      ),
    };
  } else {
    component = {
      "bom-ref": `crypto/related-crypto-material/public-key/${encodeURIComponent(normalizedPath)}@${material.sha256 ? `sha256:${material.sha256}` : material.keyId || "unknown"}`,
      name: material.name || basename(normalizedPath),
      type: "cryptographic-asset",
      version: material.sha256 || material.keyId || normalizedPath,
      hashes,
      cryptoProperties: {
        assetType: "related-crypto-material",
        relatedCryptoMaterialProperties: {
          type: "public-key",
          id:
            material.keyId ||
            material.fingerprint ||
            material.sha256 ||
            normalizedPath,
          state: trustMaterialState(material),
        },
      },
      properties: uniqueProperties(
        sharedProperties.concat([
          {
            name: "cdx:crypto:trustDomain",
            value:
              material.trustDomain || deriveTrustedKeyDomain(normalizedPath),
          },
          { name: "cdx:crypto:keyPath", value: normalizedPath },
          {
            name: "cdx:crypto:fileExtension",
            value:
              material.fileExtension ||
              extname(normalizedPath).replace(/^\./, "") ||
              "gpg",
          },
          ...(material?.keyId
            ? [{ name: "cdx:crypto:keyId", value: material.keyId }]
            : []),
          ...(material?.userIds || []).map((value) => ({
            name: "cdx:crypto:userId",
            value,
          })),
        ]),
      ),
    };
  }
  attachIdentityTools(component, trustInspectorToolRefs());
  return component;
}

function enhanceComponentFromTrustMaterial(component, material) {
  if (!component || !material) {
    return component;
  }
  component.hashes = component.hashes?.length
    ? component.hashes
    : trustMaterialHashes(material);
  component.properties = uniqueProperties(
    (component.properties || []).concat(
      createTrustMaterialComponent(material)?.properties || [],
    ),
  );
  if (!component.cryptoProperties) {
    component.cryptoProperties =
      createTrustMaterialComponent(material)?.cryptoProperties;
  }
  attachIdentityTools(component, trustInspectorToolRefs());
  return component;
}

function applyTrustMaterialEnhancements(components, materials) {
  if (!materials?.length) {
    return components || [];
  }
  const componentList = [...(components || [])];
  const bySrcFile = new Map();
  const seenRefs = new Set();
  for (const component of componentList) {
    if (component?.["bom-ref"]) {
      seenRefs.add(component["bom-ref"]);
    }
    const srcFile = (component?.properties || []).find(
      (property) => property.name === "internal:SrcFile",
    )?.value;
    if (srcFile) {
      bySrcFile.set(normalizeContainerPath(srcFile), component);
    }
  }
  for (const material of materials) {
    const srcFile = normalizeContainerPath(material?.path);
    const existing = bySrcFile.get(srcFile);
    if (
      existing &&
      existing.type === "cryptographic-asset" &&
      material?.kind === "public-key"
    ) {
      enhanceComponentFromTrustMaterial(existing, material);
      continue;
    }
    const component = createTrustMaterialComponent(material);
    if (!component?.["bom-ref"] || seenRefs.has(component["bom-ref"])) {
      continue;
    }
    seenRefs.add(component["bom-ref"]);
    componentList.push(component);
    if (srcFile) {
      bySrcFile.set(srcFile, component);
    }
  }
  return componentList;
}

function collectTrustInspectorRootfsInventory(basePath) {
  const targetPath = normalizeTrustInspectorTargetPath(basePath);
  if (!targetPath) {
    return [];
  }
  const trustData = executeTrustInspector(["rootfs", targetPath], {
    target: targetPath,
  });
  return trustData?.materials || [];
}

function parseAptRepositorySources(basePath) {
  const sourceFiles = [
    "/etc/apt/sources.list",
    ...walkRootfsFiles(basePath, "/etc/apt/sources.list.d").filter(
      (filePath) => filePath.endsWith(".list") || filePath.endsWith(".sources"),
    ),
  ].filter((filePath, index, values) => values.indexOf(filePath) === index);
  const entries = [];
  for (const sourceFile of sourceFiles) {
    const data = readRootfsTextFile(basePath, sourceFile);
    if (!data) {
      continue;
    }
    if (sourceFile.endsWith(".sources")) {
      entries.push(...parseDeb822AptRepositorySources(data, sourceFile));
      continue;
    }
    entries.push(...parseLegacyAptRepositorySources(data, sourceFile));
  }
  return entries;
}

function parseLegacyAptRepositorySources(data, sourceFile) {
  const entries = [];
  for (const rawLine of data.split(/\r?\n/)) {
    const line = rawLine.split("#")[0].trim();
    if (!line || (!line.startsWith("deb ") && !line.startsWith("deb-src "))) {
      continue;
    }
    const match = line.match(
      /^(deb(?:-src)?)\s+(?:\[(?<options>[^\]]+)\]\s+)?(?<uri>\S+)\s+(?<suite>\S+)(?:\s+(?<components>.+))?$/,
    );
    if (!match?.groups?.uri) {
      continue;
    }
    const options = parseRepositoryOptionString(match.groups.options);
    entries.push({
      name: deriveRepositoryDisplayName(match.groups.uri, sourceFile),
      path: sourceFile,
      repoType: isPpaRepository(match.groups.uri) ? "ppa-source" : "apt-source",
      release: match.groups.suite,
      url: match.groups.uri,
      description: line,
      enabled: true,
      keyReferences: extractRepositoryKeyReferences(options["signed-by"]),
      properties: uniqueProperties([
        { name: "internal:SrcFile", value: sourceFile },
        { name: "cdx:os:repo:kind", value: match[1] },
        { name: "cdx:os:repo:url", value: match.groups.uri },
        { name: "cdx:os:repo:release", value: match.groups.suite },
        ...(match.groups.components
          ? [
              {
                name: "cdx:os:repo:components",
                value: match.groups.components,
              },
            ]
          : []),
        ...(options.arch
          ? [{ name: "cdx:os:repo:architectures", value: options.arch }]
          : []),
        ...(options["signed-by"]
          ? [{ name: "cdx:os:repo:signedBy", value: options["signed-by"] }]
          : []),
      ]),
    });
  }
  return entries;
}

function parseDeb822AptRepositorySources(data, sourceFile) {
  const entries = [];
  for (const stanza of data.split(/\n\s*\n/)) {
    const fields = parseDeb822Fields(stanza);
    const uris = splitRepositoryField(fields.uris);
    const suites = splitRepositoryField(fields.suites || fields.suite);
    if (!uris.length) {
      continue;
    }
    for (const uri of uris) {
      entries.push({
        name: deriveRepositoryDisplayName(uri, sourceFile),
        path: sourceFile,
        repoType: isPpaRepository(uri) ? "ppa-source" : "apt-source",
        release: suites.join(",") || "configured",
        url: uri,
        description: stanza.trim(),
        enabled: !["no", "false", "0"].includes(
          `${fields.enabled || "yes"}`.toLowerCase(),
        ),
        keyReferences: extractRepositoryKeyReferences(fields["signed-by"]),
        properties: uniqueProperties([
          { name: "internal:SrcFile", value: sourceFile },
          { name: "cdx:os:repo:kind", value: fields.types || "deb" },
          { name: "cdx:os:repo:url", value: uri },
          ...(suites.length
            ? [{ name: "cdx:os:repo:release", value: suites.join(",") }]
            : []),
          ...(fields.components
            ? [{ name: "cdx:os:repo:components", value: fields.components }]
            : []),
          ...(fields.architectures
            ? [
                {
                  name: "cdx:os:repo:architectures",
                  value: fields.architectures,
                },
              ]
            : []),
          ...(fields["signed-by"]
            ? [
                {
                  name: "cdx:os:repo:signedBy",
                  value: fields["signed-by"],
                },
              ]
            : []),
        ]),
      });
    }
  }
  return entries;
}

function parseYumRepositorySources(basePath) {
  const entries = [];
  for (const repoFile of walkRootfsFiles(basePath, "/etc/yum.repos.d").filter(
    (f) => f.endsWith(".repo"),
  )) {
    const data = readRootfsTextFile(basePath, repoFile);
    if (!data) {
      continue;
    }
    let currentSection;
    let currentConfig = {};
    const flushCurrentSection = () => {
      if (!currentSection) {
        return;
      }
      const url =
        currentConfig.baseurl ||
        currentConfig.mirrorlist ||
        currentConfig.metalink;
      if (!url) {
        return;
      }
      entries.push({
        name: currentSection,
        path: repoFile,
        repoType: "yum-source",
        release:
          `${currentConfig.enabled || "1"}` === "1" ? "enabled" : "disabled",
        url,
        description: `${repoFile}#${currentSection}`,
        enabled: `${currentConfig.enabled || "1"}` === "1",
        keyReferences: extractRepositoryKeyReferences(currentConfig.gpgkey),
        properties: uniqueProperties([
          { name: "internal:SrcFile", value: repoFile },
          { name: "cdx:os:repo:url", value: url },
          ...(currentConfig.baseurl
            ? [{ name: "cdx:os:repo:baseurl", value: currentConfig.baseurl }]
            : []),
          ...(currentConfig.mirrorlist
            ? [
                {
                  name: "cdx:os:repo:mirrorlist",
                  value: currentConfig.mirrorlist,
                },
              ]
            : []),
          ...(currentConfig.metalink
            ? [{ name: "cdx:os:repo:metalink", value: currentConfig.metalink }]
            : []),
          {
            name: "cdx:os:repo:enabled",
            value: `${currentConfig.enabled || "1"}`,
          },
          ...(currentConfig.gpgcheck
            ? [{ name: "cdx:os:repo:gpgcheck", value: currentConfig.gpgcheck }]
            : []),
          ...(currentConfig.gpgkey
            ? [{ name: "cdx:os:repo:gpgkey", value: currentConfig.gpgkey }]
            : []),
        ]),
      });
    };
    for (const rawLine of data.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#") || line.startsWith(";")) {
        continue;
      }
      if (line.startsWith("[") && line.endsWith("]")) {
        flushCurrentSection();
        currentSection = line.slice(1, -1).trim();
        currentConfig = {};
        continue;
      }
      const equalsIndex = line.indexOf("=");
      if (equalsIndex === -1) {
        continue;
      }
      currentConfig[line.slice(0, equalsIndex).trim().toLowerCase()] = line
        .slice(equalsIndex + 1)
        .trim();
    }
    flushCurrentSection();
  }
  return entries;
}

function createRepositorySourceComponent(entry) {
  const version = entry.release || "configured";
  const purl = build({
    type: "generic",
    namespace: "os-repository",
    name: entry.name,
    version: version || null,
  });
  return {
    "bom-ref": decodeURIComponent(purl),
    purl,
    name: entry.name,
    type: "data",
    version,
    description: entry.description || entry.url,
    properties: uniqueProperties(
      [
        { name: "internal:SrcFile", value: entry.path },
        { name: "cdx:os:repo:type", value: entry.repoType },
        { name: "cdx:os:repo:url", value: entry.url },
        {
          name: "cdx:os:repo:enabled",
          value: entry.enabled === false ? "false" : "true",
        },
      ].concat(entry.properties || []),
    ),
  };
}

function uniqueRepositoryEntries(entries) {
  const seen = new Set();
  const results = [];
  for (const entry of entries || []) {
    if (!entry?.name || !entry?.path || !entry?.url) {
      continue;
    }
    const key = `${entry.repoType}\u0000${entry.path}\u0000${entry.url}\u0000${entry.release || ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    results.push(entry);
  }
  return results;
}

function deriveRepositoryDisplayName(url, sourceFile) {
  try {
    const parsedUrl = new URL(url);
    const repoPath = parsedUrl.pathname.replace(/\/+$/, "") || "/";
    return `${parsedUrl.hostname}${repoPath}`;
  } catch (_err) {
    return basename(sourceFile);
  }
}

function isPpaRepository(url) {
  try {
    const hostname = new URL(`${url || ""}`).hostname.toLowerCase();
    return (
      hostname === "ppa.launchpadcontent.net" ||
      hostname === "ppa.launchpad.net"
    );
  } catch (_err) {
    return false;
  }
}

function parseRepositoryOptionString(optionString) {
  const options = {};
  for (const token of `${optionString || ""}`.split(/\s+/).filter(Boolean)) {
    const [key, ...valueParts] = token.split("=");
    if (!key || !valueParts.length) {
      continue;
    }
    options[key.toLowerCase()] = valueParts.join("=");
  }
  return options;
}

function parseDeb822Fields(stanza) {
  const fields = {};
  let currentKey;
  for (const rawLine of stanza.split(/\r?\n/)) {
    if (!rawLine.trim()) {
      continue;
    }
    if (/^[ \t]/.test(rawLine) && currentKey) {
      fields[currentKey] = `${fields[currentKey]} ${rawLine.trim()}`.trim();
      continue;
    }
    const separatorIndex = rawLine.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }
    currentKey = rawLine.slice(0, separatorIndex).trim().toLowerCase();
    fields[currentKey] = rawLine.slice(separatorIndex + 1).trim();
  }
  return fields;
}

function splitRepositoryField(value) {
  return `${value || ""}`.split(/\s+/).filter(Boolean);
}

function extractRepositoryKeyReferences(value) {
  return uniqueSortedStrings(
    `${value || ""}`
      .split(/[\s,]+/)
      .map((part) => normalizeLocalRepositoryReference(part))
      .filter(Boolean),
  );
}

function normalizeLocalRepositoryReference(value) {
  if (!value) {
    return undefined;
  }
  const trimmedValue = `${value}`.trim();
  if (!trimmedValue || trimmedValue.includes("BEGIN PGP PUBLIC KEY BLOCK")) {
    return undefined;
  }
  if (trimmedValue.startsWith("file://")) {
    return normalizeContainerPath(trimmedValue.slice("file://".length));
  }
  if (trimmedValue.startsWith("/")) {
    return normalizeContainerPath(trimmedValue);
  }
  return undefined;
}

function readRootfsTextFile(basePath, normalizedPath) {
  const absolutePath = join(basePath, normalizedPath.replace(/^\/+/, ""));
  if (!safeExistsSync(absolutePath)) {
    return undefined;
  }
  try {
    return readFileSync(absolutePath, "utf-8");
  } catch (_err) {
    return undefined;
  }
}

async function createOSPackageFileComponents(basePath, osPackageEntries) {
  const components = [];
  const dependenciesList = [];
  const ownedFilePaths = new Set();
  const services = [];
  const componentByPath = new Map();
  for (const packageEntry of osPackageEntries) {
    const commandPathSet = new Set(packageEntry.commandPaths || []);
    const providedRefs = new Set();
    for (const filePath of packageEntry.files || []) {
      if (!filePath) {
        continue;
      }
      ownedFilePaths.add(filePath);
      let fileComponent = componentByPath.get(filePath);
      if (!fileComponent) {
        fileComponent = await createOSPackageFileComponent(
          basePath,
          filePath,
          commandPathSet,
        );
        if (!fileComponent) {
          continue;
        }
        componentByPath.set(filePath, fileComponent);
        components.push(fileComponent);
      }
      providedRefs.add(fileComponent["bom-ref"]);
    }
    const serviceResults = await createOSPackageServices(
      basePath,
      packageEntry,
      componentByPath,
    );
    for (const service of serviceResults.services) {
      services.push(service);
      providedRefs.add(service["bom-ref"]);
    }
    if (serviceResults.dependenciesList.length) {
      dependenciesList.push(...serviceResults.dependenciesList);
    }
    if (providedRefs.size) {
      dependenciesList.push({
        ref: packageEntry.packageRef,
        provides: Array.from(providedRefs).sort(),
      });
    }
  }
  return {
    components,
    dependenciesList,
    ownedFilePaths: Array.from(ownedFilePaths).sort(),
    services: dedupeServices(services),
  };
}

async function createOSPackageFileComponent(
  basePath,
  filePath,
  commandPathSet,
) {
  const normalizedFilePath = normalizeContainerPath(filePath);
  if (!normalizedFilePath) {
    return undefined;
  }
  let hashes;
  try {
    const hashValues = await multiChecksumFile(
      ["md5", "sha1"],
      join(basePath, normalizedFilePath.replace(/^\/+/, "")),
    );
    hashes = [
      { alg: "MD5", content: hashValues.md5 },
      { alg: "SHA-1", content: hashValues.sha1 },
    ];
  } catch (_e) {
    // ignore
  }
  const fileName = basename(normalizedFilePath);
  const stats = statSync(
    join(basePath, normalizedFilePath.replace(/^\/+/, "")),
    {
      throwIfNoEntry: false,
    },
  );
  if (!stats || stats.isDirectory()) {
    return undefined;
  }
  let linkedName;
  try {
    const resolvedPath = realpathSync(
      join(basePath, normalizedFilePath.replace(/^\/+/, "")),
    );
    const linkStats = lstatSync(
      join(basePath, normalizedFilePath.replace(/^\/+/, "")),
    );
    if (linkStats?.isSymbolicLink()) {
      linkedName = basename(resolvedPath);
      recordSymlinkResolution(
        join(basePath, normalizedFilePath.replace(/^\/+/, "")),
        resolvedPath,
        {
          basePath,
          metadata: {
            resolutionKind: "container-os-package-file",
          },
        },
      );
    }
  } catch (_e) {
    // ignore
  }
  const fileType = determineOwnedFileType(
    normalizedFilePath,
    stats,
    commandPathSet,
  );
  const properties = [{ name: "internal:SrcFile", value: normalizedFilePath }];
  if (fileType === "executable") {
    properties.push({ name: "internal:is_executable", value: "true" });
  } else if (fileType === "shared_library") {
    properties.push({ name: "internal:is_shared_library", value: "true" });
  } else {
    properties.push({ name: "internal:is_file", value: "true" });
  }
  properties.push(...createContainerRiskProperties(fileName, linkedName));
  properties.push(...createGtfoBinsProperties(fileName, linkedName));
  // The file path is a purl subpath, not a qualifier: `path` is not among the
  // qualifiers the generic type allows. The SrcFile property above already
  // carries the absolute path, so the subpath is stripped to a relative one as
  // the spec requires.
  const purl = tryBuildPurl({
    type: "generic",
    name: fileName,
    subpath: normalizedFilePath ? normalizedFilePath.replace(/^\/+/, "") : null,
  });
  return {
    name: fileName,
    type: "file",
    ...(purl ? { purl, "bom-ref": purl } : {}),
    hashes,
    properties,
    evidence: {
      identity: [
        {
          field: "purl",
          confidence: 0,
          methods: [
            {
              technique: "filename",
              confidence: 0,
              value: normalizedFilePath,
            },
          ],
          concludedValue: normalizedFilePath,
        },
      ],
    },
  };
}

async function createOSPackageServices(
  basePath,
  packageEntry,
  componentByPath,
) {
  const services = [];
  const dependenciesList = [];
  for (const filePath of packageEntry.files || []) {
    const serviceDescriptor = parseOwnedServiceFile(basePath, filePath);
    if (!serviceDescriptor) {
      continue;
    }
    const service = buildOwnedServiceComponent(packageEntry, serviceDescriptor);
    services.push(service);
    const dependsOn = new Set([packageEntry.packageRef]);
    const fileComponent = componentByPath.get(filePath);
    if (fileComponent?.["bom-ref"]) {
      dependsOn.add(fileComponent["bom-ref"]);
    }
    for (const execPath of serviceDescriptor.execPaths) {
      const execComponent = componentByPath.get(execPath);
      if (execComponent?.["bom-ref"]) {
        dependsOn.add(execComponent["bom-ref"]);
      }
    }
    dependenciesList.push({
      ref: service["bom-ref"],
      dependsOn: Array.from(dependsOn).sort(),
    });
  }
  return { services, dependenciesList };
}

function parseOwnedServiceFile(basePath, filePath) {
  const normalizedFilePath = normalizeContainerPath(filePath);
  if (!normalizedFilePath) {
    return undefined;
  }
  const fileContentPath = join(
    basePath,
    normalizedFilePath.replace(/^\/+/, ""),
  );
  if (!safeExistsSync(fileContentPath)) {
    return undefined;
  }
  if (isSystemdServiceFile(normalizedFilePath)) {
    const unitData = readFileSync(fileContentPath, "utf-8");
    const unitMetadata = parseSystemdUnitFile(unitData);
    return {
      description: unitMetadata.description,
      execPaths: unitMetadata.execPaths,
      filePath: normalizedFilePath,
      manager: "systemd",
      name: basename(normalizedFilePath).replace(/\.[^.]+$/, ""),
      properties: [
        { name: "cdx:service:manager", value: "systemd" },
        {
          name: "cdx:service:unitType",
          value: basename(normalizedFilePath).split(".").pop() || "service",
        },
        ...unitMetadata.properties,
      ],
    };
  }
  if (isInitServiceFile(normalizedFilePath)) {
    const initData = readFileSync(fileContentPath, "utf-8");
    const initMetadata = parseInitScriptMetadata(initData);
    return {
      description: initMetadata.description,
      execPaths: initMetadata.execPaths,
      filePath: normalizedFilePath,
      manager: "sysvinit",
      name: initMetadata.name || basename(normalizedFilePath),
      properties: [
        { name: "cdx:service:manager", value: "sysvinit" },
        ...initMetadata.properties,
      ],
    };
  }
  return undefined;
}

function buildOwnedServiceComponent(packageEntry, serviceDescriptor) {
  const serviceName = sanitizeServiceName(serviceDescriptor.name);
  const manager = serviceDescriptor.manager;
  return {
    "bom-ref": `urn:service:${manager}:${sanitizeServiceRefToken(packageEntry.packageRef)}:${sanitizeServiceRefToken(serviceName)}`,
    name: serviceName,
    version: packageEntry.packageVersion || "latest",
    group: packageEntry.packageName || manager,
    description: serviceDescriptor.description,
    properties: uniqueProperties(
      [
        { name: "internal:SrcFile", value: serviceDescriptor.filePath },
        { name: "cdx:service:packageRef", value: packageEntry.packageRef },
        { name: "cdx:service:packageName", value: packageEntry.packageName },
      ].concat(serviceDescriptor.properties || []),
    ),
  };
}

function parseSystemdUnitFile(unitData) {
  const properties = [];
  const execPaths = new Set();
  let description;
  let currentSection = "";
  for (const rawLine of unitData.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }
    if (line.startsWith("[") && line.endsWith("]")) {
      currentSection = line.slice(1, -1);
      continue;
    }
    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) {
      continue;
    }
    const key = line.slice(0, equalsIndex).trim();
    const value = line.slice(equalsIndex + 1).trim();
    if (!value) {
      continue;
    }
    if (currentSection === "Unit" && key === "Description") {
      description = value;
    }
    if (currentSection === "Service") {
      if (key.startsWith("Exec")) {
        properties.push({ name: `cdx:service:${key}`, value });
        const execPath = extractExecPath(value);
        if (execPath) {
          execPaths.add(execPath);
        }
      } else if (
        ["Type", "User", "Group", "WorkingDirectory", "Restart"].includes(key)
      ) {
        properties.push({ name: `cdx:service:${key}`, value });
      }
    }
    if (
      currentSection === "Install" &&
      ["WantedBy", "RequiredBy", "Alias"].includes(key)
    ) {
      properties.push({ name: `cdx:service:${key}`, value });
    }
    if (
      currentSection === "Unit" &&
      ["After", "Requires", "Wants"].includes(key)
    ) {
      properties.push({ name: `cdx:service:${key}`, value });
    }
  }
  return {
    description,
    execPaths: Array.from(execPaths).sort(),
    properties: uniqueProperties(properties),
  };
}

function parseInitScriptMetadata(initData) {
  const properties = [];
  const execPaths = new Set();
  let description;
  let name;
  for (const rawLine of initData.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("#")) {
      const execPath = extractExecPath(line);
      if (execPath) {
        execPaths.add(execPath);
      }
      continue;
    }
    const normalized = line.replace(/^#+\s*/, "");
    if (normalized.startsWith("Provides:")) {
      const providedName = normalized
        .replace(/^Provides:\s*/, "")
        .split(/\s+/)[0];
      if (providedName) {
        name = providedName;
        properties.push({ name: "cdx:service:Provides", value: providedName });
      }
      continue;
    }
    if (normalized.startsWith("Short-Description:")) {
      description = normalized.replace(/^Short-Description:\s*/, "");
      continue;
    }
    if (normalized.startsWith("Description:")) {
      description = normalized.replace(/^Description:\s*/, "");
      continue;
    }
    if (normalized.startsWith("Required-Start:")) {
      properties.push({
        name: "cdx:service:RequiredStart",
        value: normalized.replace(/^Required-Start:\s*/, ""),
      });
      continue;
    }
    if (normalized.startsWith("Default-Start:")) {
      properties.push({
        name: "cdx:service:DefaultStart",
        value: normalized.replace(/^Default-Start:\s*/, ""),
      });
    }
  }
  return {
    description,
    execPaths: Array.from(execPaths).sort(),
    name,
    properties: uniqueProperties(properties),
  };
}

function extractExecPath(commandLine) {
  if (!commandLine) {
    return undefined;
  }
  const sanitized = commandLine.replace(/^[\-@:+!|]+/, "").trim();
  const match = sanitized.match(/^("[^"]+"|'[^']+'|\S+)/);
  if (!match?.[1]) {
    return undefined;
  }
  const candidate = match[1].replace(/^['"]|['"]$/g, "");
  return candidate.startsWith("/")
    ? normalizeContainerPath(candidate)
    : undefined;
}

function determineOwnedFileType(filePath, stats, commandPathSet) {
  if (!stats) {
    return "file";
  }
  if (isSharedLibraryPath(filePath)) {
    return "shared_library";
  }
  if (commandPathSet?.has(filePath)) {
    return "executable";
  }
  if (stats.mode & 0o111) {
    return "executable";
  }
  return "file";
}

function isSharedLibraryPath(filePath) {
  return /(?:^|\/)[^/]+\.(?:so(?:\.[^/]+)?|a|lib|dll)$/i.test(filePath);
}

function isSystemdServiceFile(filePath) {
  return /\/(?:etc|lib|usr\/lib)\/systemd\/system\/.+\.(?:service|socket|timer|mount|path|target|slice|automount)$/i.test(
    filePath,
  );
}

function isInitServiceFile(filePath) {
  return /\/(?:etc\/init\.d|etc\/rc\.d\/init\.d)\/.+/i.test(filePath);
}

function sanitizeServiceName(value) {
  return String(value || "service").trim() || "service";
}

function sanitizeServiceRefToken(value) {
  return (
    String(value || "service")
      .toLowerCase()
      .replace(/[^a-z0-9._:-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "service"
  );
}

function uniqueProperties(properties) {
  const seen = new Set();
  const uniqueValues = [];
  for (const property of properties || []) {
    if (!property?.name || !property?.value) {
      continue;
    }
    const key = `${property.name}\u0000${property.value}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    uniqueValues.push(property);
  }
  return uniqueValues;
}

function uniqueSortedStrings(values) {
  return Array.from(new Set((values || []).filter(Boolean))).sort();
}

function dedupeServices(services) {
  const serviceMap = new Map();
  for (const service of services || []) {
    if (!service?.["bom-ref"]) {
      continue;
    }
    if (!serviceMap.has(service["bom-ref"])) {
      serviceMap.set(service["bom-ref"], {
        ...service,
        properties: uniqueProperties(service.properties),
      });
      continue;
    }
    const existing = serviceMap.get(service["bom-ref"]);
    existing.properties = uniqueProperties(
      (existing.properties || []).concat(service.properties || []),
    );
  }
  return Array.from(serviceMap.values());
}

function normalizeContainerPath(filePath) {
  if (!filePath) {
    return undefined;
  }
  const normalized = filePath.replace(/\\/g, "/").replace(/^\/+/, "/");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

/**
 * Remove the `modularitylabel` qualifier from a component's purl and return its
 * decoded value.
 *
 * The label is a Red Hat modularity concept that trivy expresses as a purl
 * qualifier. It is not a qualifier the rpm purl type defines, and its value is
 * a colon-separated stream that trivy percent-encodes, which a canonical purl
 * does not. Either alone makes the purl unparseable, so the label travels as a
 * component property instead.
 *
 * @param {object} comp Component whose purl is rewritten in place
 * @returns {string|undefined} The decoded label, when one was present
 */
function extractModularityLabel(comp) {
  const [base, query] = `${comp.purl}`.split("?");
  if (!query) {
    return undefined;
  }
  let label;
  const kept = query.split("&").filter((pair) => {
    if (!pair.startsWith("modularitylabel=")) {
      return true;
    }
    try {
      label = decodeURIComponent(pair.slice("modularitylabel=".length));
    } catch {
      label = pair.slice("modularitylabel=".length);
    }
    return false;
  });
  if (label === undefined) {
    return undefined;
  }
  comp.purl = kept.length ? `${base}?${kept.join("&")}` : base;
  return label;
}

// Detect common sdks and runtimes from the name
function detectSdksRuntimes(comp, bundledSdks, bundledRuntimes) {
  if (!comp?.name) {
    return;
  }
  if (/dotnet[6-9]?-sdk/.test(comp.name)) {
    bundledSdks.add(comp.name);
  }
  if (
    /dotnet[6-9]?-runtime/.test(comp.name) ||
    comp.name.includes("aspnet-runtime") ||
    /aspnetcore[6-9]?-runtime/.test(comp.name)
  ) {
    bundledRuntimes.add(comp.name);
  }
  // TODO: Need to test this for a range of base images
  if (COMMON_RUNTIMES.includes(comp.name)) {
    bundledRuntimes.add(comp.name);
  }
}

const retrieveDependencies = (tmpDependencies, origBomRef, comp) => {
  try {
    const tmpDependsOn =
      tmpDependencies[origBomRef] || tmpDependencies[comp["bom-ref"]] || [];
    const dependsOn = new Set();
    tmpDependsOn.forEach((d) => {
      try {
        const compPurl = Purl.parse(comp.purl);
        const tmpPurl = Purl.parse(d.replace("none", compPurl.type));
        tmpPurl.type = compPurl.type;
        // FIXME: Check if this hack is still needed with the latest trivy
        if (OS_PURL_TYPES.includes(compPurl.type)) {
          tmpPurl.namespace = compPurl.namespace;
          tmpPurl.qualifiers = tmpPurl.qualifiers || {};
          if (compPurl.qualifiers) {
            if (compPurl.qualifiers.distro_name) {
              tmpPurl.qualifiers.distro_name = compPurl.qualifiers.distro_name;
            }
            if (compPurl.qualifiers.distro) {
              tmpPurl.qualifiers.distro = compPurl.qualifiers.distro;
            }
          }
        }
        if (tmpPurl.qualifiers) {
          if (
            tmpPurl.qualifiers.epoch &&
            !tmpPurl.version.startsWith(`${tmpPurl.qualifiers.epoch}:`)
          ) {
            tmpPurl.version = `${tmpPurl.qualifiers.epoch}:${tmpPurl.version}`;
          }
        }
        // Prevents purls ending with ?
        if (!Object.keys(tmpPurl.qualifiers).length) {
          tmpPurl.qualifiers = undefined;
        }
        dependsOn.add(decodeURIComponent(tmpPurl.toString()));
      } catch (_e) {
        // ignore
      }
    });
    return { ref: comp["bom-ref"], dependsOn: Array.from(dependsOn).sort() };
  } catch (_e) {
    // ignore
  }
  return undefined;
};

function isHostInspectionPath(value) {
  if (!value) {
    return false;
  }
  if (platform === "darwin") {
    return value.startsWith("/");
  }
  if (platform === "windows") {
    return /^[a-z]:\\/i.test(value) || /^\\\\/.test(value);
  }
  return false;
}

function isDarwinSystemHostPath(value) {
  if (typeof value !== "string") {
    return false;
  }
  return (
    value.startsWith("/bin/") ||
    value.startsWith("/sbin/") ||
    value.startsWith("/System/") ||
    value.startsWith("/usr/bin/") ||
    value.startsWith("/usr/libexec/") ||
    value.startsWith("/usr/sbin/") ||
    value.startsWith("/Library/Apple/System/") ||
    value.startsWith("/System/Volumes/Preboot/Cryptexes/")
  );
}

function shouldInspectComponentHostPath(value) {
  if (!isHostInspectionPath(value)) {
    return false;
  }
  if (platform === "darwin") {
    return !(
      value.toLowerCase().endsWith(".plist") || isDarwinSystemHostPath(value)
    );
  }
  return true;
}

function shouldInspectComponentTrust(component) {
  if (platform !== "darwin") {
    return true;
  }
  const queryCategory = `${
    (component?.properties || []).find(
      (property) => property?.name === "cdx:osquery:category",
    )?.value || ""
  }`.trim();
  if (!queryCategory) {
    return true;
  }
  return new Set(["launchd_services", "startup_items", "running_apps"]).has(
    queryCategory,
  );
}

function extractComponentHostPaths(component) {
  if (!shouldInspectComponentTrust(component)) {
    return [];
  }
  const pathPropertyNames = new Set([
    "path",
    "bundle_path",
    "bundle_executable",
    "executable",
    "program",
    "image_path",
    "binary_path",
    "action_path",
  ]);
  const paths = [];
  for (const property of component?.properties || []) {
    const propertyName = `${property?.name || ""}`.toLowerCase();
    if (!pathPropertyNames.has(propertyName)) {
      continue;
    }
    const normalizedValue = `${property?.value || ""}`.trim();
    if (shouldInspectComponentHostPath(normalizedValue)) {
      paths.push(normalizedValue);
    }
  }
  return uniqueSortedStrings(paths);
}

function createHostTrustFindingComponent(finding) {
  if (!finding?.kind || !finding?.name) {
    return undefined;
  }
  const purl = build({
    type: "generic",
    namespace: "host-trust",
    name: finding.name,
    version: finding.version || "observed",
  });
  const component = {
    "bom-ref": decodeURIComponent(purl),
    name: finding.name,
    version: finding.version || "observed",
    description: finding.description,
    purl,
    type: "data",
    properties: uniqueProperties(
      (finding.properties || []).concat([
        { name: "cdx:trustinspector:kind", value: finding.kind },
        ...(finding.path
          ? [{ name: "internal:SrcFile", value: finding.path }]
          : []),
      ]),
    ),
  };
  if (finding.sha256) {
    component.hashes = [{ alg: "SHA-256", content: finding.sha256 }];
  }
  attachIdentityTools(component, trustInspectorToolRefs());
  return component;
}

/**
 * Batch-enrich operating-system components with host-path trust data using the
 * `trustinspector` helper on darwin and Windows.
 *
 * @param {Object[]} [components=[]] OS components to enrich.
 * @returns {{components: Object[], tools: Object[]}} The enriched components
 *   and any trust-inspector tool components that should be attached to the BOM
 *   metadata.
 */
export function enrichOSComponentsWithTrustData(components = []) {
  if (!["darwin", "windows"].includes(platform) || !TRUSTINSPECTOR_BIN) {
    return { components, tools: [] };
  }
  const mergedComponents = [...components];
  const pathInspectionCandidates = uniqueSortedStrings(
    components.flatMap((component) => extractComponentHostPaths(component)),
  );
  if (pathInspectionCandidates.length) {
    const inspectionMap = new Map();
    const batchSize = 200;
    for (
      let offset = 0;
      offset < pathInspectionCandidates.length;
      offset += batchSize
    ) {
      const inspectionBatch = pathInspectionCandidates.slice(
        offset,
        offset + batchSize,
      );
      const inspectionData = executeTrustInspector(
        ["paths", ...inspectionBatch],
        {
          target: `${inspectionBatch.length} path(s)`,
        },
      );
      for (const inspection of inspectionData?.inspections || []) {
        inspectionMap.set(
          inspection.path,
          uniqueProperties(inspection.properties || []),
        );
      }
    }
    if (inspectionMap.size) {
      for (const component of mergedComponents) {
        const matchingProperties = extractComponentHostPaths(component)
          .map((candidatePath) => inspectionMap.get(candidatePath))
          .filter(Boolean)
          .flat();
        if (!matchingProperties.length) {
          continue;
        }
        component.properties = uniqueProperties(
          (component.properties || []).concat(matchingProperties),
        );
        attachIdentityTools(component, trustInspectorToolRefs());
      }
    }
  }
  const hostData = executeTrustInspector(["host"], { target: platform });
  const hostComponents = (hostData?.hostFindings || [])
    .map((finding) => createHostTrustFindingComponent(finding))
    .filter(Boolean);
  if (hostComponents.length) {
    mergedComponents.push(...hostComponents);
  }
  return {
    components: mergedComponents,
    tools:
      pathInspectionCandidates.length || hostComponents.length
        ? getPluginToolComponents(["trustinspector"])
        : [],
  };
}

/**
 * Execute a SQL query against the bundled osquery binary and return the parsed
 * JSON result.
 *
 * @param {string} query The SQL query string to run.
 * @returns {Object|undefined} The parsed JSON result, or undefined when the
 *   binary is unavailable, dry-run blocks execution, or the output cannot be
 *   parsed.
 */
export function executeOsQuery(query) {
  if (isDryRun) {
    recordActivity({
      kind: "osquery",
      reason:
        "Dry run mode blocks osquery execution and reports the query instead.",
      status: "blocked",
      target: query,
    });
    return undefined;
  }
  if (OSQUERY_BIN) {
    if (!query.endsWith(";")) {
      query = `${query};`;
    }
    const args = ["--S", "--disable_database", "--json", query];
    // On darwin, we need to disable the safety check and run cdxgen with sudo
    // https://github.com/osquery/osquery/issues/1382
    if (platform === "darwin") {
      args.push("--allow_unsafe");
      args.push("--disable_logging");
      args.push("--disable_events");
    }
    if (DEBUG_MODE) {
      console.log("Executing", OSQUERY_BIN, args.join(" "));
    }
    const result = safeSpawnSync(OSQUERY_BIN, args);
    if (result.status !== 0 || result.error) {
      if (
        DEBUG_MODE &&
        result.stderr &&
        !result.stderr.includes("no such table")
      ) {
        console.error(result.stdout, result.stderr);
      }
    }
    if (result) {
      const stdout = result.stdout;
      if (stdout) {
        const cmdOutput = stdout;
        if (cmdOutput !== "") {
          try {
            return JSON.parse(cmdOutput);
          } catch (_err) {
            // ignore
            if (DEBUG_MODE) {
              console.log("Unable to parse the output from query", query);
              console.log(
                "This could be due to the amount of data returned or the query being invalid for the given platform.",
              );
            }
          }
        }
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * Method to execute dosai to create slices for dotnet
 *
 * @param {string} src Source Path
 * @param {string} slicesFile Slices file name
 * @returns boolean
 */
export function getDotnetSlices(src, slicesFile) {
  if (!DOSAI_BIN) {
    return false;
  }
  const args = ["methods", "--path", src, "--o", slicesFile];
  if (DEBUG_MODE) {
    console.log("Executing", DOSAI_BIN, args.join(" "));
  }
  const result = safeSpawnSync(DOSAI_BIN, args, {
    cwd: src,
  });
  if (
    result?.stdout?.includes(
      "You must install or update .NET to run this application",
    ) ||
    result?.stderr?.includes(
      "You must install or update .NET to run this application",
    )
  ) {
    recordDegradation("dotnet.sdk.missing", {
      ecosystem: "csharp",
      tool: "dotnet",
      impact: "components",
      command: `dosai ${args.join(" ")}`,
      detail:
        "dosai reported that no .NET SDK is installed, so dotnet-related evidence for this image is incomplete.",
    });
    console.log(
      "Dotnet SDK is not installed. Please use the cdxgen dotnet container images to generate slices for this project.",
    );
    console.log(
      "Alternatively, download the dosai self-contained binary (-full suffix) from https://github.com/owasp-dep-scan/dosai/releases and set the environment variable DOSAI_CMD with its location.",
    );
  }
  if (result.status !== 0 || result.error) {
    if (DEBUG_MODE && result.error) {
      if (result.stderr) {
        console.error(result.stdout, result.stderr);
      } else {
        console.log("Check if dosai plugin was installed successfully.");
      }
    }
    return false;
  }
  return true;
}

/**
 * Method to generate binary SBOM using blint
 *
 * @param {string} src Path to binary or its directory
 * @param {string} binaryBomFile Path to binary
 * @param {boolean} deepMode Deep mode flag
 *
 * @return {boolean} Result of the generation
 */
export function getBinaryBom(src, binaryBomFile, deepMode) {
  if (!BLINT_BIN) {
    return false;
  }
  const args = ["sbom", "-i", resolve(src), "-o", binaryBomFile];
  if (deepMode) {
    args.push("--deep");
  }
  if (DEBUG_MODE) {
    console.log("Executing", BLINT_BIN, args.join(" "));
  }
  const lstatResult = lstatSync(src, { throwIfNoEntry: false });
  if (!lstatResult) {
    console.log(`Source path ${src} does not exist`);
    return false;
  }
  const cwd = lstatResult.isDirectory() ? src : dirname(src);
  const result = safeSpawnSync(BLINT_BIN, args, {
    cwd,
  });
  if (result.status !== 0 || result.error) {
    if (result.stderr) {
      console.error(result.stdout, result.stderr);
    } else {
      console.log(
        "Install blint using 'pip install blint' or use the cdxgen container image.",
      );
    }
    return false;
  }
  return true;
}

async function fileComponents(basePath, fileList, fileType) {
  const hashResults = await mapWithConcurrency(fileList, (f) =>
    multiChecksumFile(["md5", "sha1"], join(basePath, f))
      .then((hashValues) => [
        { alg: "MD5", content: hashValues["md5"] },
        { alg: "SHA-1", content: hashValues["sha1"] },
      ])
      .catch(() => undefined),
  );
  const components = [];
  for (let i = 0; i < fileList.length; i++) {
    let f = fileList[i];
    const hashes = hashResults[i];
    if (!f.startsWith("/")) {
      f = `/${f}`;
    }
    const name = basename(f);
    let linkedName;
    try {
      const resolvedPath = realpathSync(join(basePath, f.replace(/^\/+/, "")));
      const linkStats = lstatSync(join(basePath, f.replace(/^\/+/, "")));
      if (linkStats?.isSymbolicLink()) {
        linkedName = basename(resolvedPath);
        recordSymlinkResolution(
          join(basePath, f.replace(/^\/+/, "")),
          resolvedPath,
          {
            basePath,
            metadata: {
              resolutionKind: "container-binary",
            },
          },
        );
      }
    } catch (_e) {
      // ignore
    }
    const purl = genericPurl(name);
    let isExecutable;
    let isSetuid;
    let isSetgid;
    let isSticky;
    try {
      const stats = statSync(join(basePath, f.replace(/^\/+/, "")));
      const mode = stats.mode;
      isExecutable = !!(mode & 0o111);
      isSetuid = !!(mode & 0o4000);
      isSetgid = !!(mode & 0o2000);
      isSticky = !!(mode & 0o1000);
    } catch (_e) {
      // ignore
    }
    const properties = [{ name: "internal:SrcFile", value: f }];
    if (fileType === "executable" && isExecutable !== undefined) {
      properties.push({
        name: `internal:is_${fileType}`,
        value: isExecutable.toString(),
      });
    } else {
      properties.push({ name: `internal:is_${fileType}`, value: "true" });
    }
    if (isSetuid) {
      properties.push({ name: "internal:has_setuid", value: "true" });
    }
    if (isSetgid) {
      properties.push({ name: "internal:has_setgid", value: "true" });
    }
    if (isSticky) {
      properties.push({ name: "internal:has_sticky", value: "true" });
    }
    properties.push(...createContainerRiskProperties(name, linkedName));
    properties.push(...createGtfoBinsProperties(name, linkedName));
    components.push({
      name,
      type: "file",
      purl,
      "bom-ref": purl,
      hashes,
      properties,
      evidence: {
        identity: [
          {
            field: "purl",
            confidence: 0,
            methods: [
              {
                technique: "filename",
                confidence: 0,
                value: f,
              },
            ],
            concludedValue: f,
          },
        ],
      },
    });
  }
  return components;
}
