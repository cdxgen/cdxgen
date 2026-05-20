import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { PackageURL } from "packageurl-js";

import { resolvePluginBinary } from "./plugins.js";
import {
  DEBUG_MODE,
  getTmpDir,
  safeExistsSync,
  safeMkdtempSync,
  safeRmSync,
  safeSpawnSync,
} from "./utils.js";

const DOTNET_LANGUAGES = new Set([
  "c#",
  "csharp",
  "cs",
  "dotnet",
  "dotnet-framework",
  "f#",
  "fsharp",
  "fs",
  "nuget",
  "vb",
  "vbnet",
  "visualbasic",
]);

function dosaiBin() {
  return resolvePluginBinary("dosai");
}

function normalizePurlKey(purl) {
  if (!purl || typeof purl !== "string") {
    return undefined;
  }
  try {
    const purlObj = PackageURL.fromString(purl);
    return [
      purlObj.type?.toLowerCase(),
      purlObj.namespace?.toLowerCase() || "",
      purlObj.name?.toLowerCase(),
    ].join("/");
  } catch (_err) {
    return purl.split("?")[0].split("#")[0].split("@")[0].toLowerCase();
  }
}

function addSetValue(map, key, value) {
  if (!key || !value) {
    return;
  }
  map[key] ??= new Set();
  map[key].add(value);
}

function locationFromDosai(item) {
  const location = item?.Location || item?.CallLocation || item;
  const fileName =
    location?.Path || location?.FileName || item?.Path || item?.FileName;
  if (!fileName || fileName === "<unknown>") {
    return undefined;
  }
  const lineNumber = location?.LineNumber || item?.LineNumber;
  if (lineNumber && lineNumber > 0) {
    return `${fileName}#${lineNumber}`;
  }
  return fileName;
}

function frameFromDosaiNode(node) {
  if (!node) {
    return undefined;
  }
  const fullFilename =
    node.Path || node.FileName || node.CallLocation?.FileName;
  if (!fullFilename || fullFilename === "<unknown>") {
    return undefined;
  }
  return {
    package: node.Namespace || "",
    module: node.ClassName || node.Module || "",
    function: node.MethodName || node.Name || node.CalledMethodName || "",
    line: node.LineNumber || node.CallLocation?.LineNumber || undefined,
    column: node.ColumnNumber || node.CallLocation?.ColumnNumber || undefined,
    fullFilename,
  };
}

function appendUniqueProperty(properties, name, value) {
  if (value === undefined || value === null || value === "") {
    return;
  }
  if (
    !properties.some(
      (property) => property.name === name && property.value === String(value),
    )
  ) {
    properties.push({ name, value: String(value) });
  }
}

function sanitizeEndpoint(endpoint) {
  const value = String(endpoint || "").trim();
  if (!value) {
    return undefined;
  }
  if (/^https?:\/\//i.test(value)) {
    try {
      const parsedUrl = new URL(value);
      parsedUrl.username = "";
      parsedUrl.password = "";
      parsedUrl.search = "";
      parsedUrl.hash = "";
      return parsedUrl.toString();
    } catch (_err) {
      return undefined;
    }
  }
  return value.split("?")[0].split("#")[0].slice(0, 512);
}

function serviceNameFromEndpoint(endpoint) {
  const className = endpoint.ClassName || endpoint.FileName || "dotnet";
  const methodName = endpoint.MethodName || endpoint.HttpMethod || "endpoint";
  return `dosai-${className}-${methodName}-service`
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/-+/g, "-");
}

function dosaiSdkMessage(result) {
  return (
    result?.stdout?.includes(
      "You must install or update .NET to run this application",
    ) ||
    result?.stderr?.includes(
      "You must install or update .NET to run this application",
    )
  );
}

export function isDosaiDotnetLanguage(language) {
  return DOTNET_LANGUAGES.has(String(language || "").toLowerCase());
}

export function readDosaiJsonFile(jsonFile) {
  if (!jsonFile || !safeExistsSync(jsonFile)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(jsonFile, "utf-8"));
  } catch (_err) {
    return undefined;
  }
}

export function runDosaiCommand(command, src, outputFile, options = {}) {
  const executable = options.dosaiCommand || dosaiBin();
  if (!executable) {
    return false;
  }
  const args = [command, "--path", resolve(src), "--o", resolve(outputFile)];
  if (command === "dataflows") {
    if (options.dataFlowPatterns) {
      args.push("--patterns", resolve(options.dataFlowPatterns));
    }
    if (options.dataFlowPatternPacks || options.patternPacks) {
      args.push(
        "--pattern-packs",
        options.dataFlowPatternPacks || options.patternPacks,
      );
    }
  } else if (command === "crypto") {
    args.push("--format", "dosai");
  }
  if (DEBUG_MODE) {
    console.log("Executing", executable, args.join(" "));
  }
  const result = safeSpawnSync(executable, args, { cwd: src });
  if (dosaiSdkMessage(result)) {
    console.log(
      "Dotnet SDK is not installed. Please use the cdxgen dotnet container images to analyze this project with dosai.",
    );
    console.log(
      "Alternatively, download the dosai self-contained binary (-full suffix) from https://github.com/owasp-dep-scan/dosai/releases and set DOSAI_CMD to its location.",
    );
  }
  if (result?.status !== 0 || result?.error || !safeExistsSync(outputFile)) {
    if (DEBUG_MODE) {
      if (result?.stderr || result?.stdout) {
        console.error(result.stdout, result.stderr);
      } else {
        console.log("Check if the dosai plugin was installed successfully.");
      }
    }
    return false;
  }
  return true;
}

export function createDosaiMethodsSlice(src, outputFile, options = {}) {
  return runDosaiCommand("methods", src, outputFile, options);
}

export function createDosaiDataFlowSlice(src, outputFile, options = {}) {
  return runDosaiCommand("dataflows", src, outputFile, options);
}

export function createDosaiCryptoAnalysis(src, outputFile, options = {}) {
  return runDosaiCommand("crypto", src, outputFile, options);
}

export function analyzeDosaiCrypto(src, options = {}) {
  const tempDir = safeMkdtempSync(join(getTmpDir(), "dosai-crypto-"));
  const outputFile = join(tempDir, "dosai-crypto.json");
  try {
    if (!createDosaiCryptoAnalysis(src, outputFile, options)) {
      return undefined;
    }
    return readDosaiJsonFile(outputFile);
  } finally {
    if (tempDir?.startsWith(getTmpDir())) {
      safeRmSync(tempDir, { recursive: true, force: true });
    }
  }
}

export function buildPurlAliasMap(components = []) {
  const purlAliasMap = new Map();
  for (const component of components) {
    if (!component?.purl) {
      continue;
    }
    purlAliasMap.set(component.purl, component.purl);
    const key = normalizePurlKey(component.purl);
    if (key && !purlAliasMap.has(key)) {
      purlAliasMap.set(key, component.purl);
    }
  }
  return purlAliasMap;
}

export function resolveComponentPurl(purl, purlAliasMap) {
  if (!purl) {
    return undefined;
  }
  return (
    purlAliasMap.get(purl) || purlAliasMap.get(normalizePurlKey(purl)) || purl
  );
}

export function collectDosaiPurlEvidence(methodsSlice, components = []) {
  const purlAliasMap = buildPurlAliasMap(components);
  const purlLocationMap = {};
  const purlModulesMap = {};
  const purlMethodsMap = {};
  const edgesById = new Map(
    (methodsSlice?.CallGraph?.Edges || []).map((edge) => [edge.Id, edge]),
  );
  const nodesById = new Map(
    (methodsSlice?.CallGraph?.Nodes || []).map((node) => [node.Id, node]),
  );

  for (const reachability of methodsSlice?.PackageReachability || []) {
    const purl = resolveComponentPurl(reachability.Purl, purlAliasMap);
    if (!purl) {
      continue;
    }
    for (const edgeId of reachability.EdgeIds || []) {
      const edge = edgesById.get(edgeId);
      addSetValue(purlLocationMap, purl, locationFromDosai(edge));
      addSetValue(
        purlMethodsMap,
        purl,
        edge?.CalledMethodName || edge?.TargetName,
      );
    }
    for (const nodeId of reachability.NodeIds || []) {
      const node = nodesById.get(nodeId);
      addSetValue(purlLocationMap, purl, locationFromDosai(node));
      addSetValue(purlModulesMap, purl, node?.ClassName || node?.Module);
      addSetValue(
        purlMethodsMap,
        purl,
        node?.Name || node?.Identity?.MethodName,
      );
    }
  }
  return { purlLocationMap, purlModulesMap, purlMethodsMap };
}

export function collectDosaiDataFlowFrames(dataFlowResult, components = []) {
  const purlAliasMap = buildPurlAliasMap(components);
  const nodesById = new Map(
    (dataFlowResult?.Nodes || []).map((node) => [node.Id, node]),
  );
  const dataFlowFrames = {};
  const addFramesForPurl = (purl, frames) => {
    const componentPurl = resolveComponentPurl(purl, purlAliasMap);
    if (!componentPurl || !frames.length) {
      return;
    }
    dataFlowFrames[componentPurl] ??= [];
    dataFlowFrames[componentPurl].push(frames);
  };

  for (const slice of dataFlowResult?.Slices || []) {
    const frames = (slice.NodeIds || [])
      .map((nodeId) => frameFromDosaiNode(nodesById.get(nodeId)))
      .filter(Boolean);
    const purls = new Set(
      [...(slice.Purls || []), slice.SourcePurl, slice.SinkPurl].filter(
        Boolean,
      ),
    );
    for (const purl of purls) {
      addFramesForPurl(purl, frames);
    }
  }

  for (const reachability of dataFlowResult?.PackageReachability || []) {
    const frames = (reachability.NodeIds || [])
      .map((nodeId) => frameFromDosaiNode(nodesById.get(nodeId)))
      .filter(Boolean);
    addFramesForPurl(reachability.Purl, frames);
  }
  return dataFlowFrames;
}

export function collectDosaiServicesFromMethods(
  methodsSlice,
  servicesMap = {},
) {
  for (const endpoint of methodsSlice?.ApiEndpoints || []) {
    const route = sanitizeEndpoint(endpoint.Route || endpoint.Path);
    if (!route) {
      continue;
    }
    const serviceName = serviceNameFromEndpoint(endpoint);
    servicesMap[serviceName] ??= {
      endpoints: new Set(),
      authenticated: endpoint.AuthorizationRequired,
      xTrustBoundary:
        endpoint.AuthorizationRequired === true ? true : undefined,
      properties: [],
    };
    servicesMap[serviceName].endpoints.add(route);
    const properties = servicesMap[serviceName].properties;
    appendUniqueProperty(
      properties,
      "cdx:service:httpMethod",
      endpoint.HttpMethod || "ANY",
    );
    appendUniqueProperty(
      properties,
      "cdx:dosai:endpointKind",
      endpoint.EndpointKind,
    );
    appendUniqueProperty(
      properties,
      "cdx:dosai:authorizationRequired",
      endpoint.AuthorizationRequired,
    );
    appendUniqueProperty(
      properties,
      "cdx:dosai:allowAnonymous",
      endpoint.AllowAnonymous,
    );
    appendUniqueProperty(
      properties,
      "cdx:dosai:authorizationPolicyCount",
      endpoint.AuthorizationPolicies?.length,
    );
    appendUniqueProperty(
      properties,
      "cdx:dosai:roleCount",
      endpoint.Roles?.length,
    );
    appendUniqueProperty(
      properties,
      "cdx:dosai:requiredClaimCount",
      endpoint.RequiredClaims?.length,
    );
    appendUniqueProperty(
      properties,
      "cdx:dosai:requiredScopeCount",
      endpoint.RequiredScopes?.length,
    );
    appendUniqueProperty(
      properties,
      "SrcFile",
      endpoint.Path || endpoint.FileName,
    );
    if (endpoint.LineNumber) {
      appendUniqueProperty(
        properties,
        "cdx:dosai:location",
        `${endpoint.Path || endpoint.FileName}:${endpoint.LineNumber}:${endpoint.ColumnNumber || 0}`,
      );
    }
  }
  return servicesMap;
}

export function normalizeDosaiServiceMap(servicesMap = {}) {
  return Object.keys(servicesMap).map((serviceName) => ({
    name: serviceName || `dosai-${basename(serviceName)}-service`,
    endpoints: Array.from(servicesMap[serviceName].endpoints || []).sort(),
    authenticated: servicesMap[serviceName].authenticated,
    "x-trust-boundary": servicesMap[serviceName].xTrustBoundary,
    properties: servicesMap[serviceName].properties,
  }));
}
