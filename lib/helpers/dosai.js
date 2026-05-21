import { readFileSync } from "node:fs";
import { basename, delimiter, join, resolve } from "node:path";

import {
  addDosaiSetValue,
  buildDosaiPurlAliasMap,
  dosaiSourceLocation,
  dosaiSourceLocationFromNode,
  resolveDosaiComponentPurl,
} from "./dosaiParsers.js";
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

const DOSAI_COMMANDS = new Set(["crypto", "dataflows", "methods"]);

function dosaiBin() {
  return resolvePluginBinary("dosai");
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

function safeDosaiPath(value) {
  if (!value || typeof value !== "string" || /[\0\r\n]/.test(value)) {
    return undefined;
  }
  return resolve(value);
}

function safeDosaiPatternPacks(value) {
  if (!value || typeof value !== "string" || /[\0\r\n]/.test(value)) {
    return undefined;
  }
  return value
    .split(delimiter)
    .map((patternPack) => safeDosaiPath(patternPack.trim()))
    .filter(Boolean)
    .join(delimiter);
}

function safeDosaiExecutable(value) {
  if (!value || typeof value !== "string" || /[\0\r\n]/.test(value)) {
    return undefined;
  }
  return value.trim();
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
  if (!DOSAI_COMMANDS.has(command)) {
    return false;
  }
  const executable = safeDosaiExecutable(options.dosaiCommand || dosaiBin());
  const srcPath = safeDosaiPath(src);
  const outputPath = safeDosaiPath(outputFile);
  if (!executable || !srcPath || !outputPath) {
    return false;
  }
  const args = [command, "--path", srcPath, "--o", outputPath];
  if (command === "dataflows") {
    if (options.dataFlowPatterns) {
      const patternsPath = safeDosaiPath(options.dataFlowPatterns);
      if (patternsPath) {
        args.push("--patterns", patternsPath);
      }
    }
    if (options.dataFlowPatternPacks || options.patternPacks) {
      const patternPacks = safeDosaiPatternPacks(
        options.dataFlowPatternPacks || options.patternPacks,
      );
      if (patternPacks) {
        args.push("--pattern-packs", patternPacks);
      }
    }
  } else if (command === "crypto") {
    args.push("--format", "dosai");
  }
  if (DEBUG_MODE) {
    console.log("Executing", executable, args.join(" "));
  }
  const result = safeSpawnSync(executable, args, {
    cwd: srcPath,
    shell: false,
  });
  if (dosaiSdkMessage(result)) {
    console.log(
      "Dotnet SDK is not installed. Please use the cdxgen dotnet container images to analyze this project with dosai.",
    );
    console.log(
      "Alternatively, download the dosai self-contained binary (-full suffix) from https://github.com/owasp-dep-scan/dosai/releases and set DOSAI_CMD to its location.",
    );
  }
  if (result?.status !== 0 || result?.error || !safeExistsSync(outputPath)) {
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
  return buildDosaiPurlAliasMap(components);
}

export function resolveComponentPurl(purl, purlAliasMap) {
  return resolveDosaiComponentPurl(purl, purlAliasMap);
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

  for (const dependency of methodsSlice?.Dependencies || []) {
    const purl = resolveComponentPurl(dependency.Purl, purlAliasMap);
    if (!purl) {
      continue;
    }
    addDosaiSetValue(purlLocationMap, purl, dosaiSourceLocation(dependency));
    addDosaiSetValue(
      purlModulesMap,
      purl,
      dependency.Name || dependency.Namespace,
    );
  }

  for (const reachability of methodsSlice?.PackageReachability || []) {
    const purl = resolveComponentPurl(reachability.Purl, purlAliasMap);
    if (!purl) {
      continue;
    }
    let hasExplicitSourceLocations = false;
    for (const sourceLocation of reachability.SourceLocations || []) {
      const location = dosaiSourceLocation(sourceLocation);
      addDosaiSetValue(purlLocationMap, purl, location);
      hasExplicitSourceLocations ||= Boolean(location);
    }
    for (const edgeId of reachability.EdgeIds || []) {
      const edge = edgesById.get(edgeId);
      if (!hasExplicitSourceLocations) {
        addDosaiSetValue(purlLocationMap, purl, dosaiSourceLocation(edge));
      }
      addDosaiSetValue(
        purlMethodsMap,
        purl,
        edge?.CalledMethodName || edge?.TargetName,
      );
    }
    for (const nodeId of reachability.NodeIds || []) {
      const node = nodesById.get(nodeId);
      if (!hasExplicitSourceLocations) {
        addDosaiSetValue(
          purlLocationMap,
          purl,
          dosaiSourceLocationFromNode(node),
        );
      }
      addDosaiSetValue(purlModulesMap, purl, node?.ClassName || node?.Module);
      addDosaiSetValue(
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
