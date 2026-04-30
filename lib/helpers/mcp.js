import { PackageURL } from "packageurl-js";

const OFFICIAL_NPM_NAMESPACE = "@modelcontextprotocol";
const OFFICIAL_PYPI_PACKAGES = new Set(["mcp"]);
const OFFICIAL_MAVEN_GROUPS = new Set(["io.modelcontextprotocol.sdk"]);
const OFFICIAL_NUGET_PREFIXES = ["modelcontextprotocol"];
const OFFICIAL_GOLANG_PREFIX = "github.com/modelcontextprotocol/";
const OFFICIAL_CARGO_PACKAGES = new Set(["rmcp", "rmcp-macros"]);
const KNOWN_MCP_INTEGRATION_GROUPS = new Set(["org.springframework.ai"]);

const MCP_ROLE_HINTS = [
  ["server-sdk", /(?:^|[-/.])server(?:$|[-/.])/i],
  ["client-sdk", /(?:^|[-/.])client(?:$|[-/.])/i],
  [
    "transport-sdk",
    /(?:^|[-/.])(express|node|webflux|webmvc|aspnetcore)(?:$|[-/.])/i,
  ],
];

function lower(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function rootImportName(source) {
  if (typeof source !== "string" || !source.length || source.startsWith(".")) {
    return "";
  }
  if (source.startsWith("@")) {
    return source.split("/").slice(0, 2).join("/");
  }
  return source.split("/")[0];
}

function normalizeReference(ref) {
  if (typeof ref === "string") {
    const importName = rootImportName(ref);
    const importParts = importName.startsWith("@")
      ? importName.split("/")
      : ["", importName];
    return {
      ecosystem: "npm",
      group: lower(importParts[0]),
      name: lower(importParts[1]),
      source: ref,
    };
  }
  if (!ref || typeof ref !== "object") {
    return { ecosystem: "", group: "", name: "", source: "" };
  }
  if (typeof ref.purl === "string" && ref.purl.length) {
    try {
      const purl = PackageURL.fromString(ref.purl);
      return {
        ecosystem: lower(purl.type),
        group: lower(purl.namespace),
        name: lower(purl.name),
        source: ref.purl,
      };
    } catch {
      // continue with object fallback
    }
  }
  return {
    ecosystem: lower(ref.ecosystem || ref.type),
    group: lower(ref.group),
    name: lower(ref.name),
    source: lower(ref.source),
  };
}

function inferRole(name, group) {
  const combined = `${group}/${name}`;
  for (const [role, pattern] of MCP_ROLE_HINTS) {
    if (pattern.test(combined)) {
      return role;
    }
  }
  if (name.includes("sdk") || group.includes("modelcontextprotocol")) {
    return "sdk";
  }
  if (name.includes("integration") || group.includes("springframework")) {
    return "integration";
  }
  return "sdk";
}

/**
 * Classify a package/component/import reference as MCP-related.
 *
 * @param {Object|string} ref Package/component reference or import source
 * @returns {{
 *   isMcp: boolean,
 *   isOfficial: boolean,
 *   isKnownIntegration: boolean,
 *   role: string | undefined,
 *   catalogSource: string | undefined,
 *   packageName: string
 * }}
 */
export function classifyMcpReference(ref) {
  const normalized = normalizeReference(ref);
  const ecosystem = normalized.ecosystem;
  const group = normalized.group;
  const name = normalized.name;
  const packageName = [group, name].filter(Boolean).join("/") || name;
  if (!name && !group) {
    return {
      isMcp: false,
      isOfficial: false,
      isKnownIntegration: false,
      role: undefined,
      catalogSource: undefined,
      packageName,
    };
  }

  let isMcp = false;
  let isOfficial = false;
  let isKnownIntegration = false;
  let catalogSource;

  if (ecosystem === "npm" && group === OFFICIAL_NPM_NAMESPACE) {
    isMcp = true;
    isOfficial = true;
    catalogSource = "official-sdk";
  } else if (ecosystem === "pypi" && OFFICIAL_PYPI_PACKAGES.has(name)) {
    isMcp = true;
    isOfficial = true;
    catalogSource = "official-sdk";
  } else if (ecosystem === "maven" && OFFICIAL_MAVEN_GROUPS.has(group)) {
    isMcp = true;
    isOfficial = true;
    catalogSource = "official-sdk";
  } else if (
    ecosystem === "nuget" &&
    OFFICIAL_NUGET_PREFIXES.some((prefix) => name.startsWith(prefix))
  ) {
    isMcp = true;
    isOfficial = true;
    catalogSource = "official-sdk";
  } else if (
    ecosystem === "golang" &&
    `${group}/${name}`.startsWith(OFFICIAL_GOLANG_PREFIX)
  ) {
    isMcp = true;
    isOfficial = true;
    catalogSource = "official-sdk";
  } else if (ecosystem === "cargo" && OFFICIAL_CARGO_PACKAGES.has(name)) {
    isMcp = true;
    isOfficial = true;
    catalogSource = "official-sdk";
  } else if (
    ecosystem === "maven" &&
    KNOWN_MCP_INTEGRATION_GROUPS.has(group) &&
    name.includes("mcp")
  ) {
    isMcp = true;
    isKnownIntegration = true;
    catalogSource = "known-integration";
  } else if (
    packageName.includes("modelcontextprotocol") ||
    packageName.includes("mcp")
  ) {
    isMcp = true;
    catalogSource = "heuristic";
  }

  return {
    isMcp,
    isOfficial,
    isKnownIntegration,
    role: isMcp ? inferRole(name, group) : undefined,
    catalogSource,
    packageName,
  };
}

function pushUniqueProperty(properties, name, value) {
  if (value === undefined || value === null || value === "") {
    return;
  }
  if (properties.some((prop) => prop.name === name && prop.value === value)) {
    return;
  }
  properties.push({ name, value });
}

/**
 * Add MCP catalog metadata to a CycloneDX component.
 *
 * @param {Object} component CycloneDX component
 * @returns {Object} Same component reference
 */
export function enrichComponentWithMcpMetadata(component) {
  if (!component || typeof component !== "object") {
    return component;
  }
  const classification = classifyMcpReference(component);
  if (!classification.isMcp) {
    return component;
  }
  const tags = new Set(component.tags || []);
  tags.add("mcp");
  tags.add("mcp-sdk");
  if (classification.role === "server-sdk") {
    tags.add("mcp-server");
  }
  if (classification.role === "client-sdk") {
    tags.add("mcp-client");
  }
  if (classification.isOfficial) {
    tags.add("official-mcp-sdk");
    tags.add("trusted-source");
  }
  if (classification.isKnownIntegration) {
    tags.add("known-mcp-integration");
  }
  component.tags = Array.from(tags).sort();
  component.properties = component.properties || [];
  pushUniqueProperty(component.properties, "cdx:mcp:package", "true");
  pushUniqueProperty(
    component.properties,
    "cdx:mcp:official",
    classification.isOfficial ? "true" : "false",
  );
  if (classification.role) {
    pushUniqueProperty(
      component.properties,
      "cdx:mcp:role",
      classification.role,
    );
  }
  if (classification.catalogSource) {
    pushUniqueProperty(
      component.properties,
      "cdx:mcp:catalogSource",
      classification.catalogSource,
    );
  }
  if (classification.packageName) {
    pushUniqueProperty(
      component.properties,
      "cdx:mcp:packageName",
      classification.packageName,
    );
  }
  return component;
}
