import { basename } from "node:path";

import { readRegularTextFile } from "../core/boundedFile.js";
import {
  sanitizeBomEndpointUrl,
  sanitizeBomPropertyValue,
} from "../core/propertySanitizer.js";
import { parseJsonLike } from "./jsonLike.js";
import { isLocalHost, sanitizeMcpRefToken } from "./mcpDiscovery.js";
import { tryBuildPurl } from "./purl.js";
import { scanTextForHiddenUnicode } from "./unicodeScan.js";

const SERVER_MANIFEST_PATTERNS = ["server.json", "**/server.json"];
// A server.json larger than this is skipped unread.
const MAX_SERVER_MANIFEST_BYTES = 4 * 1024 * 1024;

// registryType values understood by the official MCP Registry, mapped to the
// package-url ecosystem cdxgen uses when a component purl can be built.
const REGISTRY_TYPE_PURL_TYPES = {
  npm: "npm",
  pypi: "pypi",
  nuget: "nuget",
  oci: "oci",
  mcpb: undefined,
};

function addUniqueProperty(properties, name, value) {
  const sanitizedValue = sanitizeBomPropertyValue(name, value);
  if (
    sanitizedValue === undefined ||
    sanitizedValue === null ||
    sanitizedValue === ""
  ) {
    return;
  }
  if (
    properties.some(
      (property) =>
        property.name === name && property.value === String(sanitizedValue),
    )
  ) {
    return;
  }
  properties.push({ name, value: String(sanitizedValue) });
}

/**
 * Determine whether a parsed object looks like an MCP Registry server manifest.
 *
 * The heuristic keeps unrelated `server.json` files (for example dev-server
 * configuration) out of the MCP inventory by requiring the manifest to carry a
 * server name plus at least one `packages[]` or `remotes[]` entry, or an
 * explicit MCP Registry `$schema` reference.
 *
 * @param {Object} manifest Parsed JSON object
 * @returns {boolean} true when the object resembles a registry manifest
 */
function looksLikeServerManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return false;
  }
  const schema = String(manifest.$schema || "").toLowerCase();
  if (schema.includes("modelcontextprotocol")) {
    return true;
  }
  const hasName = typeof manifest.name === "string" && manifest.name.length > 0;
  const hasPackages =
    Array.isArray(manifest.packages) && manifest.packages.length > 0;
  const hasRemotes =
    Array.isArray(manifest.remotes) && manifest.remotes.length > 0;
  return hasName && (hasPackages || hasRemotes);
}

/**
 * Build a package-url string for a registry package entry when the
 * registryType maps to a supported ecosystem and enough coordinates exist.
 *
 * @param {Object} pkg Registry package entry
 * @returns {string|undefined} purl string, or undefined when not derivable
 */
function purlForPackage(pkg) {
  const registryType = String(pkg?.registryType || pkg?.registry_type || "")
    .trim()
    .toLowerCase();
  const purlType = REGISTRY_TYPE_PURL_TYPES[registryType];
  if (!purlType) {
    return undefined;
  }
  const identifier = String(pkg?.identifier || pkg?.name || "").trim();
  if (!identifier) {
    return undefined;
  }
  const version = pkg?.version ? String(pkg.version) : undefined;
  let namespace;
  let name = identifier;
  const parts = { type: purlType, version };
  if (purlType === "npm" && identifier.startsWith("@")) {
    const [scope, unscoped] = identifier.split("/");
    namespace = scope;
    name = unscoped || identifier;
  } else if (purlType === "pypi") {
    // PyPI purls require the normalized project name: lowercase with runs of
    // [-_.] collapsed to a single hyphen.
    name = identifier.toLowerCase().replace(/[-_.]+/gu, "-");
  } else if (purlType === "oci") {
    // OCI purls are only meaningful with a lowercase name, a digest version,
    // and a repository_url qualifier. A tag-only reference is not resolvable,
    // so skip the purl rather than emit a misleading one.
    const digest =
      pkg?.digest || (version?.startsWith("sha256:") ? version : undefined);
    const repositoryUrl = pkg?.registryBaseUrl || pkg?.repository_url;
    if (!digest || !repositoryUrl) {
      return undefined;
    }
    name = identifier.toLowerCase().split("/").pop();
    parts.version = digest;
    parts.qualifiers = { repository_url: String(repositoryUrl) };
  }
  parts.namespace = namespace;
  parts.name = name;
  return tryBuildPurl(parts)?.toString() || undefined;
}

/**
 * Convert one registry package entry into a CycloneDX component describing the
 * distributable that hosts the MCP server.
 *
 * @param {string} filePath Manifest path
 * @param {string} serverName MCP server name
 * @param {Object} pkg Registry package entry
 * @param {number} index Package index for stable identity
 * @returns {Object|undefined} component or undefined when not usable
 */
function componentForPackage(filePath, serverName, pkg, index) {
  const registryType = String(pkg?.registryType || pkg?.registry_type || "")
    .trim()
    .toLowerCase();
  const identifier = String(pkg?.identifier || pkg?.name || "").trim();
  if (!registryType && !identifier) {
    return undefined;
  }
  const purl = purlForPackage(pkg);
  const properties = [
    { name: "internal:SrcFile", value: filePath },
    { name: "cdx:mcp:inventorySource", value: "server-manifest" },
    { name: "cdx:registry:server:packageRegistryType", value: registryType },
  ];
  if (pkg?.transport?.type || pkg?.transport) {
    addUniqueProperty(
      properties,
      "cdx:registry:server:packageTransport",
      typeof pkg.transport === "string" ? pkg.transport : pkg.transport?.type,
    );
  }
  // Record only the counts and field names the server will be handed at launch,
  // never their values. These describe the launch surface without leaking
  // secrets that a registry manifest may reference through them.
  const secretInputFields = new Set();
  for (const [inputKey, property] of [
    ["environmentVariables", "cdx:registry:server:environmentVariableCount"],
    ["runtimeArguments", "cdx:registry:server:runtimeArgumentCount"],
    ["packageArguments", "cdx:registry:server:packageArgumentCount"],
  ]) {
    const entries = pkg?.[inputKey];
    if (Array.isArray(entries) && entries.length) {
      addUniqueProperty(properties, property, String(entries.length));
      for (const entry of entries) {
        const fieldName = entry?.name || entry?.variable;
        if (
          entry?.isSecret === true ||
          entry?.secret === true ||
          (typeof fieldName === "string" &&
            /(token|secret|password|api[_-]?key|credential)/iu.test(fieldName))
        ) {
          secretInputFields.add(String(fieldName || "secret"));
        }
      }
    }
  }
  if (secretInputFields.size) {
    addUniqueProperty(
      properties,
      "cdx:registry:server:secretInputCount",
      String(secretInputFields.size),
    );
  }
  const component = {
    "bom-ref":
      purl ||
      `urn:mcp:server-package:${sanitizeMcpRefToken(serverName)}:${sanitizeMcpRefToken(identifier || registryType)}:${index}`,
    type: "application",
    name: identifier || `${serverName}-package-${index}`,
    properties,
  };
  if (purl) {
    component.purl = purl;
  }
  if (pkg?.version) {
    component.version = String(pkg.version);
  }
  return component;
}

/**
 * Convert one registry remote entry into a CycloneDX service describing the
 * remotely hosted MCP endpoint.
 *
 * @param {string} filePath Manifest path
 * @param {string} serverName MCP server name
 * @param {Object} remote Registry remote entry
 * @param {number} index Remote index for stable identity
 * @returns {Object|undefined} service or undefined when no URL is present
 */
function serviceForRemote(filePath, serverName, remote, index) {
  const url = typeof remote?.url === "string" ? remote.url : undefined;
  if (!url) {
    return undefined;
  }
  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return undefined;
  }
  const transport = String(remote?.type || remote?.transport || "")
    .trim()
    .toLowerCase();
  const exposureType = isLocalHost(hostname)
    ? "local-only"
    : "networked-public";
  const properties = [
    { name: "internal:SrcFile", value: filePath },
    { name: "cdx:mcp:serviceType", value: "registry-remote" },
    { name: "cdx:mcp:inventorySource", value: "server-manifest" },
    { name: "cdx:mcp:exposureType", value: exposureType },
    // A remote server has no resolvable local package, so its composition
    // cannot be verified from the manifest alone.
    { name: "cdx:mcp:composition", value: "unknown" },
    { name: "cdx:mcp:reviewNeeded", value: "true" },
  ];
  if (transport) {
    addUniqueProperty(
      properties,
      "cdx:mcp:transport",
      transport.includes("sse")
        ? "sse"
        : transport.includes("stream") || transport.includes("http")
          ? "streamable-http"
          : transport,
    );
  }
  return {
    "bom-ref": `urn:service:mcp:${sanitizeMcpRefToken(serverName)}:remote:${index}`,
    group: "mcp",
    name: serverName,
    endpoints: [sanitizeBomEndpointUrl(url)],
    properties,
  };
}

/**
 * Build the file component that represents the discovered manifest itself and
 * summarizes the packages and remotes it declares.
 *
 * @param {string} filePath Manifest path
 * @param {Object} manifest Parsed manifest
 * @param {string} raw Raw file contents
 * @param {number} packageCount Number of package components emitted
 * @param {number} remoteCount Number of remote services emitted
 * @returns {Object} file component
 */
function manifestFileComponent(
  filePath,
  manifest,
  raw,
  packageCount,
  remoteCount,
) {
  const properties = [
    { name: "internal:SrcFile", value: filePath },
    { name: "cdx:file:kind", value: "mcp-server-manifest" },
    { name: "cdx:mcp:inventorySource", value: "server-manifest" },
    {
      name: "cdx:registry:server:packageCount",
      value: String(packageCount),
    },
    { name: "cdx:registry:server:remoteCount", value: String(remoteCount) },
  ];
  addUniqueProperty(
    properties,
    "cdx:registry:server:name",
    typeof manifest.name === "string" ? manifest.name : undefined,
  );
  addUniqueProperty(
    properties,
    "cdx:registry:server:version",
    manifest.version ? String(manifest.version) : undefined,
  );
  const hiddenUnicodeScan = scanTextForHiddenUnicode(raw, { syntax: "json" });
  if (hiddenUnicodeScan.hasHiddenUnicode) {
    addUniqueProperty(properties, "cdx:file:hasHiddenUnicode", "true");
    addUniqueProperty(
      properties,
      "cdx:file:hiddenUnicodeCodePoints",
      hiddenUnicodeScan.codePoints.join(","),
    );
  }
  return {
    "bom-ref": `file:${filePath}`,
    type: "file",
    name: basename(filePath),
    properties,
  };
}

/**
 * Parser for MCP Registry server manifests (`server.json`).
 *
 * Converts each declared distributable package into a CycloneDX component
 * (with a purl when the registry type maps to a supported ecosystem) and each
 * remotely hosted endpoint into a service, alongside a file component that
 * summarizes the manifest. Only regular files inside `context.rootDir`, the
 * scanned root, are read; a symbolic link is never followed.
 *
 * @type {{id: string, patterns: string[], parse(files: string[], options?: Object, context?: {rootDir?: string}): {components: Object[], services: Object[]}}}
 */
export const mcpServerManifestParser = {
  id: "mcp-server-manifest",
  patterns: SERVER_MANIFEST_PATTERNS,
  parse(files, _options = {}, context = {}) {
    const components = [];
    const services = [];
    for (const filePath of [...new Set(files || [])]) {
      const raw = readRegularTextFile(
        filePath,
        MAX_SERVER_MANIFEST_BYTES,
        context?.rootDir,
      );
      if (raw === undefined) {
        continue;
      }
      let manifest;
      try {
        manifest = parseJsonLike(raw);
      } catch {
        continue;
      }
      if (!looksLikeServerManifest(manifest)) {
        continue;
      }
      const serverName =
        typeof manifest.name === "string" && manifest.name.length
          ? manifest.name
          : basename(filePath);
      const packageComponents = [];
      const packages = Array.isArray(manifest.packages)
        ? manifest.packages
        : [];
      for (let index = 0; index < packages.length; index++) {
        const component = componentForPackage(
          filePath,
          serverName,
          packages[index],
          index,
        );
        if (component) {
          packageComponents.push(component);
        }
      }
      const remoteServices = [];
      const remotes = Array.isArray(manifest.remotes) ? manifest.remotes : [];
      for (let index = 0; index < remotes.length; index++) {
        const service = serviceForRemote(
          filePath,
          serverName,
          remotes[index],
          index,
        );
        if (service) {
          remoteServices.push(service);
        }
      }
      components.push(
        manifestFileComponent(
          filePath,
          manifest,
          raw,
          packageComponents.length,
          remoteServices.length,
        ),
      );
      components.push(...packageComponents);
      services.push(...remoteServices);
    }
    return { components, services };
  },
};
