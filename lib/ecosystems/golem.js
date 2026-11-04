import { readFileSync } from "node:fs";
import { cpus } from "node:os";
import { join, resolve } from "node:path";

import { DEBUG_MODE } from "../core/activity.js";
import {
  getTmpDir,
  safeExistsSync,
  safeMkdtempSync,
  safeRmSync,
  safeSpawnSync,
} from "../core/fs.js";
import { dirNameStr } from "../core/paths.js";
import {
  reportPluginRunFailure,
  resolvePluginSourceDir,
} from "../core/pluginRun.js";
import {
  encodeUriReference,
  hasInlineCredential,
  sanitizeBomUrl,
} from "../core/propertySanitizer.js";
import { occurrenceLocationKey } from "../inventory/occurrenceKey.js";
import { resolvePluginBinary } from "../inventory/plugins.js";
import { canonicalPurlFromLooseString } from "../inventory/purl.js";

const GO_LANGUAGES = new Set(["go", "golang"]);
const GOLEM_CALLGRAPH_MODES = new Set(["none", "static", "cha", "rta", "vta"]);
const GOLEM_DATAFLOW_MODES = new Set(["none", "security", "crypto", "all"]);
const GOLEM_DATAFLOW_CALLGRAPH_MODES = new Set([
  "none",
  "static",
  "cha",
  "rta",
  "vta",
]);
const GOLEM_CRYPTO_OIDS = JSON.parse(
  readFileSync(join(dirNameStr, "data", "crypto-oid.json"), "utf-8"),
);
const GOLEM_CRYPTO_PRIMITIVES = new Set([
  "drbg",
  "mac",
  "block-cipher",
  "stream-cipher",
  "signature",
  "hash",
  "pke",
  "xof",
  "kdf",
  "key-agree",
  "kem",
  "ae",
  "combiner",
  "other",
  "unknown",
]);

function golemBin() {
  return resolvePluginBinary("golem");
}

function appendUniqueProperty(properties, name, value) {
  if (value === undefined || value === null || value === "") {
    return;
  }
  const propertyValue = String(value);
  if (
    !properties.some(
      (property) => property.name === name && property.value === propertyValue,
    )
  ) {
    properties.push({ name, value: propertyValue });
  }
}

function addSetValue(map, key, value) {
  if (!key || !value) {
    return;
  }
  map[key] ??= new Set();
  map[key].add(value);
}

function addPropertyValue(map, key, name, value) {
  if (!key || value === undefined || value === null || value === "") {
    return;
  }
  map[key] ??= [];
  appendUniqueProperty(map[key], name, value);
}

function rangeLocation(range) {
  const start = range?.start;
  if (!start?.filename) {
    return undefined;
  }
  return occurrenceLocationKey(start.filename, start.line);
}

function positionLocation(position) {
  if (!position?.filename) {
    return undefined;
  }
  return occurrenceLocationKey(position.filename, position.line);
}

function purlWithoutVersion(purl) {
  return purl?.split("?")[0].split("#")[0].split("@")[0];
}

function modulePurl(module) {
  // cdxgen reports a module that a replace directive swapped out under the
  // replacement's coordinates, which golem names as replace.purl. A directory
  // replacement has none, and its versionless component matches module.purl.
  return module?.replace?.purl || module?.purl || module?.PURL;
}

// The canonical form of every purl an alias map was asked about, so a report
// naming one module in many usages parses its purl once.
const purlMatchKeyCache = new WeakMap();

/**
 * The form two purls of one module share. Golem prints a module path as Go
 * does, keeping its upper-case letters (github.com/BurntSushi/toml), while
 * cdxgen components carry the canonical golang purl, which lower-cases them.
 * Canonicalising both sides also reads an unescaped `+incompatible` like the
 * escaped one.
 *
 * @param {string} purl A purl from the report or a component
 * @param {Map} purlAliasMap The alias map the key belongs to
 * @returns {string} The canonical purl, or the purl itself when it cannot be
 *   parsed
 */
function purlMatchKey(purl, purlAliasMap) {
  let cache = purlMatchKeyCache.get(purlAliasMap);
  if (!cache) {
    cache = new Map();
    purlMatchKeyCache.set(purlAliasMap, cache);
  }
  if (!cache.has(purl)) {
    cache.set(purl, canonicalPurlFromLooseString(purl) || purl);
  }
  return cache.get(purl);
}

function createPurlAliasMap(components = []) {
  const purlAliasMap = new Map();
  for (const component of components) {
    if (!component?.purl) {
      continue;
    }
    const key = purlMatchKey(component.purl, purlAliasMap);
    purlAliasMap.set(key, component.purl);
    const noVersionPurl = purlWithoutVersion(key);
    if (noVersionPurl && !purlAliasMap.has(noVersionPurl)) {
      purlAliasMap.set(noVersionPurl, component.purl);
    }
  }
  return purlAliasMap;
}

function resolveComponentPurl(purl, purlAliasMap) {
  if (!purl) {
    return undefined;
  }
  const key = purlMatchKey(purl, purlAliasMap);
  return (
    purlAliasMap.get(key) ||
    // A package subpath (`#internal`) names a part of the module.
    purlAliasMap.get(key.split("#")[0]) ||
    purlAliasMap.get(purlWithoutVersion(key))
  );
}

function addResolvedPurl(purls, purl, purlAliasMap) {
  const resolvedPurl = resolveComponentPurl(purl, purlAliasMap);
  if (resolvedPurl) {
    purls.add(resolvedPurl);
  }
}

function addResolvedPurls(purls, values, purlAliasMap) {
  for (const value of values || []) {
    addResolvedPurl(purls, value, purlAliasMap);
  }
}

function symbolModule(symbol, modules = []) {
  if (!symbol) {
    return undefined;
  }
  let match;
  for (const module of modules) {
    if (
      module?.path &&
      (symbol === module.path || symbol.startsWith(`${module.path}.`)) &&
      (!match || module.path.length > match.path.length)
    ) {
      match = module;
    }
  }
  return match;
}

function frameFromUsage(usage) {
  const start = usage?.range?.start;
  if (!start?.filename) {
    return undefined;
  }
  return {
    package: usage.enclosing?.id?.split("|")[0] || "",
    module: usage.enclosing?.kind || "",
    function: usage.enclosing?.name || "",
    line: start.line || undefined,
    column: start.column || undefined,
    fullFilename: start.filename,
  };
}

function frameFromEdge(edge) {
  const position = edge?.position;
  if (!position?.filename) {
    return undefined;
  }
  return {
    package: edge.sourceId?.split(".").slice(0, -1).join(".") || "",
    module: edge.callType || "",
    function: edge.sourceName || edge.sourceId || "",
    line: position.line || undefined,
    column: position.column || undefined,
    fullFilename: position.filename,
  };
}

function frameFromCallGraphNode(node, fallbackName = "") {
  const position = node?.position;
  if (!position?.filename) {
    return undefined;
  }
  return {
    package: node.packagePath || fallbackName.split(".").slice(0, -1).join("."),
    module: node.kind || "",
    function: node.label || node.name || fallbackName || "",
    line: position.line || undefined,
    column: position.column || undefined,
    fullFilename: position.filename,
  };
}

function frameLocationKey(frame) {
  if (!frame?.fullFilename) {
    return undefined;
  }
  return `${frame.fullFilename}#${frame.line || ""}#${frame.column || ""}`;
}

function dedupeFrames(frames = []) {
  const seen = new Set();
  const out = [];
  for (const frame of frames) {
    const key = frameLocationKey(frame);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(frame);
  }
  return out;
}

function frameFromDataFlowNode(node, fallbackFunction) {
  const position = node?.position;
  if (!position?.filename) {
    return undefined;
  }
  const functionName = node.function || fallbackFunction || "";
  return {
    package: node.packagePath || functionName.split(".").slice(0, -1).join("."),
    module: node.kind || node.category || "",
    function: functionName || node.symbol || node.name || "",
    line: position.line || undefined,
    column: position.column || undefined,
    fullFilename: position.filename,
  };
}

function addFrame(dataFlowFrames, purl, frame) {
  if (!purl || !frame) {
    return;
  }
  dataFlowFrames[purl] ??= [];
  dataFlowFrames[purl].push([frame]);
}

function addCountProperty(properties, name, count) {
  if (count && count > 0) {
    appendUniqueProperty(properties, name, count);
  }
}

function normalizedPositiveInteger(value) {
  const intValue = Number.parseInt(value, 10);
  if (Number.isFinite(intValue) && intValue > 0) {
    return intValue;
  }
  return undefined;
}

function sortedCsv(values) {
  const filteredValues = [...new Set((values || []).filter(Boolean))].sort();
  return filteredValues.length ? filteredValues.join(",") : undefined;
}

function incrementNestedCount(map, key, name) {
  if (!key || !name) {
    return;
  }
  map[key] ??= {};
  map[key][name] = (map[key][name] || 0) + 1;
}

function incrementCount(map, key) {
  if (!key) {
    return;
  }
  map[key] = (map[key] || 0) + 1;
}

function isCryptoDataFlowSlice(slice) {
  return [
    slice?.sourceCategory,
    slice?.sinkCategory,
    slice?.ruleId,
    slice?.ruleName,
    ...(slice?.taintKinds || []),
  ]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes("crypto"));
}

function cryptoBomRef(kind, name, version) {
  return `crypto/${kind}/${encodeURIComponent(name)}@${encodeURIComponent(version || name)}`;
}

function safeCryptoPrimitive(primitive) {
  if (GOLEM_CRYPTO_PRIMITIVES.has(primitive)) {
    return primitive;
  }
  return primitive ? "other" : undefined;
}

function cryptoSourceLocation(item) {
  const start = item?.range?.start;
  if (!start?.filename) {
    return undefined;
  }
  return `${start.filename}:${start.line || 0}:${start.column || 0}`;
}

function appendCryptoComponentProperty(component, name, value) {
  component.properties ??= [];
  appendUniqueProperty(component.properties, name, value);
}

function mergeCryptoComponent(componentsByRef, component, item) {
  const existing = componentsByRef.get(component["bom-ref"]);
  if (!existing) {
    componentsByRef.set(component["bom-ref"], component);
    appendCryptoComponentProperty(
      component,
      "cdx:golem:crypto:sourceLocation",
      cryptoSourceLocation(item),
    );
    return component;
  }
  appendCryptoComponentProperty(
    existing,
    "cdx:golem:crypto:sourceLocation",
    cryptoSourceLocation(item),
  );
  return existing;
}

function cryptoAlgorithmComponent(asset) {
  const algorithmMetadata = GOLEM_CRYPTO_OIDS[asset.name];
  const oid = asset.oid || algorithmMetadata?.oid;
  if (!oid) {
    return undefined;
  }
  const primitive = safeCryptoPrimitive(asset.primitive);
  const component = {
    type: "cryptographic-asset",
    name: asset.name,
    "bom-ref": cryptoBomRef("algorithm", asset.name, oid),
    description:
      algorithmMetadata?.description ||
      `${asset.primitive || "cryptographic"} algorithm detected by golem`,
    cryptoProperties: {
      assetType: "algorithm",
      oid,
      ...(primitive ? { algorithmProperties: { primitive } } : {}),
    },
    properties: [],
  };
  appendCryptoComponentProperty(
    component,
    "cdx:golem:crypto:strength",
    asset.strength,
  );
  appendCryptoComponentProperty(
    component,
    "cdx:golem:crypto:symbol",
    asset.symbol,
  );
  appendCryptoComponentProperty(
    component,
    "cdx:golem:crypto:usageScope",
    asset.usageScope,
  );
  return component;
}

function cryptoCertificateComponent(asset) {
  const component = {
    type: "cryptographic-asset",
    name: asset.name || "X.509 certificate",
    "bom-ref": cryptoBomRef(
      "certificate",
      asset.name || "X.509 certificate",
      "x509",
    ),
    description: "Certificate asset detected by golem source analysis",
    cryptoProperties: {
      assetType: "certificate",
      algorithmProperties: { primitive: "unknown" },
    },
    properties: [],
  };
  appendCryptoComponentProperty(
    component,
    "cdx:golem:crypto:symbol",
    asset.symbol,
  );
  appendCryptoComponentProperty(
    component,
    "cdx:golem:crypto:usageScope",
    asset.usageScope,
  );
  return component;
}

function cryptoProtocolComponent(protocol) {
  const protocolType = protocol.type || "unknown";
  const component = {
    type: "cryptographic-asset",
    name: protocol.name || protocolType.toUpperCase(),
    "bom-ref": cryptoBomRef(
      "protocol",
      protocol.name || protocolType,
      protocol.version || protocolType,
    ),
    description: "Cryptographic protocol detected by golem source analysis",
    cryptoProperties: {
      assetType: "protocol",
      protocolProperties: {
        type: ["tls", "ssh", "ipsec", "ike", "sstp", "wpa"].includes(
          protocolType,
        )
          ? protocolType
          : "other",
        ...(protocol.version ? { version: protocol.version } : {}),
      },
    },
    properties: [],
  };
  appendCryptoComponentProperty(
    component,
    "cdx:golem:crypto:symbol",
    protocol.symbol,
  );
  appendCryptoComponentProperty(
    component,
    "cdx:golem:crypto:usageScope",
    protocol.usageScope,
  );
  return component;
}

function cryptoMaterialComponent(material) {
  const materialType = material.type || "unknown";
  const component = {
    type: "cryptographic-asset",
    name: material.name || materialType,
    "bom-ref": cryptoBomRef(
      "material",
      material.name || materialType,
      materialType,
    ),
    description:
      "Related cryptographic material indicator detected by golem source analysis; raw values are not emitted",
    cryptoProperties: {
      assetType: "related-crypto-material",
      relatedCryptoMaterialProperties: { type: materialType },
    },
    properties: [],
  };
  appendCryptoComponentProperty(
    component,
    "cdx:golem:crypto:symbol",
    material.symbol,
  );
  appendCryptoComponentProperty(
    component,
    "cdx:golem:crypto:usageScope",
    material.usageScope,
  );
  return component;
}

function addScopedProperties(componentPropertiesMap, purl, scopeCounts = {}) {
  const scopes = Object.keys(scopeCounts).filter(
    (scope) => scopeCounts[scope] > 0,
  );
  if (!purl || !scopes.length) {
    return;
  }
  addPropertyValue(
    componentPropertiesMap,
    purl,
    "cdx:golem:usageScopes",
    sortedCsv(scopes),
  );
  addPropertyValue(
    componentPropertiesMap,
    purl,
    "cdx:golem:testOnly",
    scopes.length > 0 && scopes.every((scope) => scope !== "runtime"),
  );
  for (const [scope, count] of Object.entries(scopeCounts)) {
    addCountProperty(
      (componentPropertiesMap[purl] ??= []),
      `cdx:golem:${scope}UsageCount`,
      count,
    );
  }
}

function addOccurrenceKindProperties(
  componentPropertiesMap,
  purl,
  kindCounts = {},
) {
  const kinds = Object.keys(kindCounts).filter((kind) => kindCounts[kind] > 0);
  if (!purl || !kinds.length) {
    return;
  }
  addPropertyValue(
    componentPropertiesMap,
    purl,
    "cdx:golem:occurrenceEvidenceKinds",
    sortedCsv(kinds),
  );
  for (const [kind, count] of Object.entries(kindCounts)) {
    addCountProperty(
      (componentPropertiesMap[purl] ??= []),
      `cdx:golem:${kind}OccurrenceCount`,
      count,
    );
  }
}

function addMetadataProperties(properties, golemReport = {}) {
  appendUniqueProperty(
    properties,
    "cdx:golem:toolVersion",
    golemReport.tool?.version,
  );
  appendUniqueProperty(
    properties,
    "cdx:golem:callGraphMode",
    golemReport.callGraph?.mode || golemReport.options?.callGraphMode,
  );
  appendUniqueProperty(
    properties,
    "cdx:golem:dataFlowMode",
    golemReport.dataFlow?.mode || golemReport.options?.dataFlowMode,
  );
  appendUniqueProperty(
    properties,
    "cdx:golem:dataFlowCallGraphMode",
    golemReport.options?.dataFlowCallGraphMode,
  );
  appendUniqueProperty(
    properties,
    "cdx:golem:noRecurse",
    golemReport.options?.noRecurse,
  );
  appendUniqueProperty(
    properties,
    "cdx:golem:includeAllFlows",
    golemReport.options?.includeAllFlows,
  );
  appendUniqueProperty(
    properties,
    "cdx:golem:dataFlowPacks",
    sortedCsv(golemReport.options?.dataFlowPacks),
  );
  addCountProperty(
    properties,
    "cdx:golem:packageCount",
    golemReport.stats?.packageCount,
  );
  addCountProperty(
    properties,
    "cdx:golem:moduleCount",
    golemReport.stats?.moduleCount,
  );
  addCountProperty(
    properties,
    "cdx:golem:fileCount",
    golemReport.stats?.fileCount,
  );
  addCountProperty(
    properties,
    "cdx:golem:generatedFileCount",
    golemReport.stats?.generatedFileCount,
  );
  addCountProperty(
    properties,
    "cdx:golem:importCount",
    golemReport.stats?.importCount,
  );
  addCountProperty(
    properties,
    "cdx:golem:declarationCount",
    golemReport.stats?.declarationCount,
  );
  addCountProperty(
    properties,
    "cdx:golem:usageCount",
    golemReport.stats?.usageCount,
  );
  for (const scope of ["runtime", "test", "benchmark", "fuzz", "example"]) {
    addCountProperty(
      properties,
      `cdx:golem:${scope}UsageCount`,
      golemReport.stats?.[`${scope}UsageCount`],
    );
  }
  addCountProperty(
    properties,
    "cdx:golem:buildDirectiveCount",
    golemReport.stats?.buildDirectiveCount,
  );
  addCountProperty(
    properties,
    "cdx:golem:nativeArtifactCount",
    golemReport.stats?.nativeArtifactCount,
  );
  addCountProperty(
    properties,
    "cdx:golem:securitySignalCount",
    golemReport.stats?.securitySignalCount,
  );
  addCountProperty(
    properties,
    "cdx:golem:dataFlowSourceCount",
    golemReport.stats?.dataFlowSourceCount,
  );
  addCountProperty(
    properties,
    "cdx:golem:dataFlowSinkCount",
    golemReport.stats?.dataFlowSinkCount,
  );
  addCountProperty(
    properties,
    "cdx:golem:dataFlowSliceCount",
    golemReport.stats?.dataFlowSliceCount,
  );
  addCountProperty(
    properties,
    "cdx:golem:diagnosticCount",
    golemReport.stats?.diagnosticCount,
  );
  addCountProperty(
    properties,
    "cdx:golem:goModReplaceCount",
    golemReport.stats?.goModReplaceCount,
  );
  addCountProperty(
    properties,
    "cdx:golem:goModExcludeCount",
    golemReport.stats?.goModExcludeCount,
  );
  addCountProperty(
    properties,
    "cdx:golem:vendorModuleCount",
    golemReport.stats?.vendorModuleCount,
  );
  addCountProperty(
    properties,
    "cdx:golem:workspaceModuleCount",
    golemReport.stats?.workspaceModuleCount,
  );
  addCountProperty(
    properties,
    "cdx:golem:privateModuleHintCount",
    golemReport.stats?.privateModuleHintCount,
  );
  addCountProperty(
    properties,
    "cdx:golem:licenseFileModuleCount",
    golemReport.stats?.licenseFileModuleCount,
  );
  addCountProperty(
    properties,
    "cdx:golem:callGraphNodeCount",
    golemReport.callGraph?.stats?.nodeCount,
  );
  addCountProperty(
    properties,
    "cdx:golem:callGraphEdgeCount",
    golemReport.callGraph?.stats?.edgeCount,
  );
  addCountProperty(
    properties,
    "cdx:golem:dataFlowNodeCount",
    golemReport.dataFlow?.stats?.nodeCount,
  );
  addCountProperty(
    properties,
    "cdx:golem:dataFlowEdgeCount",
    golemReport.dataFlow?.stats?.edgeCount,
  );
  addCountProperty(
    properties,
    "cdx:golem:dataFlowSummaryCount",
    golemReport.dataFlow?.stats?.summaryCount,
  );
  addCountProperty(
    properties,
    "cdx:golem:dataFlowCandidateFunctionCount",
    golemReport.dataFlow?.stats?.candidateFunctionCount,
  );
  addCountProperty(
    properties,
    "cdx:golem:dataFlowFunctionCount",
    golemReport.dataFlow?.stats?.functionCount,
  );
  addCountProperty(
    properties,
    "cdx:golem:dataFlowSkippedFunctionCount",
    golemReport.dataFlow?.stats?.skippedFunctionCount,
  );
  addCountProperty(
    properties,
    "cdx:golem:dataFlowInstructionCount",
    golemReport.dataFlow?.stats?.instructionCount,
  );
  addCountProperty(
    properties,
    "cdx:golem:dataFlowWorkerCount",
    golemReport.dataFlow?.stats?.workerCount,
  );
  addCountProperty(
    properties,
    "cdx:golem:dataFlowElapsedMillis",
    golemReport.dataFlow?.stats?.elapsedMillis,
  );
  addCountProperty(
    properties,
    "cdx:golem:dataFlowUniqueFlowCount",
    golemReport.dataFlow?.stats?.uniqueFlowCount,
  );
  addCountProperty(
    properties,
    "cdx:golem:dataFlowDuplicateSliceCount",
    golemReport.dataFlow?.stats?.duplicateSliceCount,
  );
  addCountProperty(
    properties,
    "cdx:golem:dataFlowDuplicateGroupCount",
    golemReport.dataFlow?.stats?.duplicateGroupCount,
  );
  addCountProperty(
    properties,
    "cdx:golem:dataFlowMaxPathLength",
    golemReport.dataFlow?.stats?.maxPathLength,
  );
  addCountProperty(
    properties,
    "cdx:golem:dataFlowSanitizedSliceCount",
    golemReport.dataFlow?.stats?.sanitizedSliceCount,
  );
  appendUniqueProperty(
    properties,
    "cdx:golem:dataFlowTruncated",
    golemReport.dataFlow?.stats?.truncated,
  );
  appendUniqueProperty(
    properties,
    "cdx:golem:dataFlowTruncationReasons",
    sortedCsv(golemReport.dataFlow?.stats?.truncationReasons),
  );
  appendUniqueProperty(
    properties,
    "cdx:golem:buildDirectiveKinds",
    sortedCsv(
      (golemReport.buildDirectives || []).map((directive) => directive.kind),
    ),
  );
  appendUniqueProperty(
    properties,
    "cdx:golem:nativeArtifactKinds",
    sortedCsv(
      (golemReport.nativeArtifacts || []).map((artifact) => artifact.kind),
    ),
  );
  appendUniqueProperty(
    properties,
    "cdx:golem:securitySignalCategories",
    sortedCsv(
      (golemReport.securitySignals || []).map((signal) => signal.category),
    ),
  );
  appendUniqueProperty(
    properties,
    "cdx:golem:securitySignalSeverities",
    sortedCsv(
      (golemReport.securitySignals || []).map((signal) => signal.severity),
    ),
  );
  appendUniqueProperty(
    properties,
    "cdx:golem:generatorKinds",
    sortedCsv((golemReport.files || []).map((file) => file.generatedBy)),
  );
  appendUniqueProperty(
    properties,
    "cdx:golem:goDirectiveVersion",
    golemReport.supplyChain?.goDirectiveVersion,
  );
  appendUniqueProperty(
    properties,
    "cdx:golem:toolchainDirective",
    golemReport.supplyChain?.toolchainDirective,
  );
  appendUniqueProperty(
    properties,
    "cdx:golem:goWorkPresent",
    golemReport.supplyChain?.goWorkPresent,
  );
  appendUniqueProperty(
    properties,
    "cdx:golem:vendorDirectoryPresent",
    golemReport.supplyChain?.vendorDirectoryPresent,
  );
  addCountProperty(
    properties,
    "cdx:golem:goGenerateCount",
    (golemReport.buildDirectives || []).filter(
      (directive) => directive.kind === "go-generate",
    ).length,
  );
  addCountProperty(
    properties,
    "cdx:golem:goEmbedCount",
    (golemReport.buildDirectives || []).filter(
      (directive) => directive.kind === "go-embed",
    ).length,
  );
}

function addSupplyChainProperties(
  componentPropertiesMap,
  metadataProperties,
  purlAliasMap,
  supplyChain = {},
) {
  for (const directive of supplyChain.replaces || []) {
    appendUniqueProperty(
      metadataProperties,
      "cdx:golem:replaceModule",
      directive.modulePath,
    );
    appendUniqueProperty(
      metadataProperties,
      "cdx:golem:replaceTargetPathKind",
      directive.targetPathKind,
    );
    appendUniqueProperty(
      metadataProperties,
      "cdx:golem:localReplacementPresent",
      directive.localReplacement,
    );
  }
  for (const directive of supplyChain.excludes || []) {
    appendUniqueProperty(
      metadataProperties,
      "cdx:golem:excludeModule",
      directive.modulePath,
    );
  }
  for (const module of supplyChain.modules || []) {
    const purl = resolveComponentPurl(module.purl || module.PURL, purlAliasMap);
    if (!purl) {
      continue;
    }
    addPropertyValue(
      componentPropertiesMap,
      purl,
      "cdx:golem:vendored",
      module.vendored,
    );
    addPropertyValue(
      componentPropertiesMap,
      purl,
      "cdx:golem:privateModuleCandidate",
      module.privateModuleCandidate,
    );
    addCountProperty(
      (componentPropertiesMap[purl] ??= []),
      "cdx:golem:licenseFileCount",
      module.licenseFiles?.length,
    );
    addPropertyValue(
      componentPropertiesMap,
      purl,
      "cdx:golem:licenseFiles",
      sortedCsv(module.licenseFiles),
    );
    addPropertyValue(
      componentPropertiesMap,
      purl,
      "cdx:golem:replacementModule",
      module.properties?.replacementModule,
    );
    addPropertyValue(
      componentPropertiesMap,
      purl,
      "cdx:golem:localReplacement",
      module.properties?.localReplacement,
    );
  }
}

function addModuleProperties(
  componentPropertiesMap,
  purlAliasMap,
  modules = [],
) {
  for (const module of modules) {
    const purl = resolveComponentPurl(modulePurl(module), purlAliasMap);
    if (!purl) {
      continue;
    }
    addPropertyValue(
      componentPropertiesMap,
      purl,
      "cdx:golem:modulePath",
      module.path,
    );
    addPropertyValue(
      componentPropertiesMap,
      purl,
      "cdx:golem:goVersion",
      module.goVersion,
    );
    addPropertyValue(
      componentPropertiesMap,
      purl,
      "cdx:golem:mainModule",
      module.main,
    );
    addPropertyValue(
      componentPropertiesMap,
      purl,
      "cdx:golem:replacementModule",
      module.replace?.path,
    );
  }
}

function addSignalProperties(
  componentPropertiesMap,
  purlAliasMap,
  golemReport = {},
) {
  const modules = golemReport.modules || [];
  for (const signal of golemReport.securitySignals || []) {
    const module = symbolModule(signal.packagePath, modules);
    const purl = resolveComponentPurl(modulePurl(module), purlAliasMap);
    if (!purl) {
      continue;
    }
    addPropertyValue(
      componentPropertiesMap,
      purl,
      "cdx:golem:securitySignalCategory",
      signal.category,
    );
    addPropertyValue(
      componentPropertiesMap,
      purl,
      "cdx:golem:securitySignalSeverity",
      signal.severity,
    );
  }
}

function addCryptoEvidence(
  componentPropertiesMap,
  metadataProperties,
  purlAliasMap,
  golemReport,
  cryptoComponentsByRef,
  cryptoGeneratePurls,
) {
  const crypto = golemReport?.crypto;
  if (!crypto) {
    return;
  }
  addCountProperty(
    metadataProperties,
    "cdx:golem:cryptoLibraryCount",
    crypto.libraries?.length,
  );
  addCountProperty(
    metadataProperties,
    "cdx:golem:cryptoAssetCount",
    crypto.assets?.length,
  );
  addCountProperty(
    metadataProperties,
    "cdx:golem:cryptoOperationCount",
    crypto.operations?.length,
  );
  addCountProperty(
    metadataProperties,
    "cdx:golem:cryptoMaterialCount",
    crypto.materials?.length,
  );
  addCountProperty(
    metadataProperties,
    "cdx:golem:cryptoProtocolCount",
    crypto.protocols?.length,
  );
  addCountProperty(
    metadataProperties,
    "cdx:golem:cryptoFindingCount",
    crypto.findings?.length,
  );
  appendUniqueProperty(
    metadataProperties,
    "cdx:golem:cryptoAlgorithms",
    sortedCsv(
      (crypto.assets || []).map((asset) =>
        asset.assetType === "algorithm" ? asset.name : undefined,
      ),
    ),
  );
  appendUniqueProperty(
    metadataProperties,
    "cdx:golem:cryptoMaterialTypes",
    sortedCsv((crypto.materials || []).map((material) => material.type)),
  );
  appendUniqueProperty(
    metadataProperties,
    "cdx:golem:cryptoProtocols",
    sortedCsv((crypto.protocols || []).map((protocol) => protocol.type)),
  );
  for (const asset of crypto.assets || []) {
    let component;
    if (asset.assetType === "algorithm") {
      component = cryptoAlgorithmComponent(asset);
    } else if (asset.assetType === "certificate") {
      component = cryptoCertificateComponent(asset);
    }
    if (component) {
      mergeCryptoComponent(cryptoComponentsByRef, component, asset);
    }
  }
  for (const protocol of crypto.protocols || []) {
    mergeCryptoComponent(
      cryptoComponentsByRef,
      cryptoProtocolComponent(protocol),
      protocol,
    );
  }
  for (const material of crypto.materials || []) {
    mergeCryptoComponent(
      cryptoComponentsByRef,
      cryptoMaterialComponent(material),
      material,
    );
  }
  const componentRefByAssetId = new Map();
  for (const asset of crypto.assets || []) {
    const component =
      asset.assetType === "algorithm"
        ? cryptoAlgorithmComponent(asset)
        : asset.assetType === "certificate"
          ? cryptoCertificateComponent(asset)
          : undefined;
    if (component) {
      componentRefByAssetId.set(asset.id, component["bom-ref"]);
    }
  }
  const modules = golemReport.modules || [];
  for (const operation of crypto.operations || []) {
    const module = symbolModule(operation.packagePath, modules);
    const purl = resolveComponentPurl(modulePurl(module), purlAliasMap);
    if (!purl) {
      continue;
    }
    addPropertyValue(
      componentPropertiesMap,
      purl,
      "cdx:golem:cryptoOperationType",
      operation.operationType,
    );
    addPropertyValue(
      componentPropertiesMap,
      purl,
      "cdx:golem:cryptoAlgorithm",
      operation.algorithm,
    );
    const assetRef = componentRefByAssetId.get(operation.assetId);
    if (assetRef) {
      cryptoGeneratePurls[purl] ??= new Set();
      cryptoGeneratePurls[purl].add(assetRef);
    }
  }
  for (const finding of crypto.findings || []) {
    const module = symbolModule(finding.packagePath, modules);
    const purl = resolveComponentPurl(modulePurl(module), purlAliasMap);
    if (!purl) {
      continue;
    }
    addPropertyValue(
      componentPropertiesMap,
      purl,
      "cdx:golem:cryptoFinding",
      finding.ruleId,
    );
    addPropertyValue(
      componentPropertiesMap,
      purl,
      "cdx:golem:cryptoFindingSeverity",
      finding.severity,
    );
  }
  for (const slice of golemReport.dataFlow?.slices || []) {
    if (!isCryptoDataFlowSlice(slice)) {
      continue;
    }
    const module = symbolModule(slice.sinkPackagePath, modules);
    const purl =
      resolveComponentPurl(slice.sinkPurl, purlAliasMap) ||
      resolveComponentPurl(modulePurl(module), purlAliasMap);
    if (!purl) {
      continue;
    }
    const asset = (crypto.assets || []).find(
      (item) =>
        item.symbol === slice.sinkSymbol ||
        (item.name && slice.sinkSymbol?.toLowerCase().includes(item.name)),
    );
    const assetRef = componentRefByAssetId.get(asset?.id);
    if (assetRef) {
      cryptoGeneratePurls[purl] ??= new Set();
      cryptoGeneratePurls[purl].add(assetRef);
    }
  }
}

function dataFlowNodeCache(golemReport = {}) {
  const nodeCache = new Map();
  for (const node of golemReport.dataFlow?.nodes || []) {
    nodeCache.set(node.id, node);
  }
  return nodeCache;
}

function resolveDataFlowSlicePurls(slice, nodeCache, modules, purlAliasMap) {
  const purls = new Set();
  addResolvedPurls(purls, slice.purls, purlAliasMap);
  addResolvedPurls(purls, [slice.sourcePurl, slice.sinkPurl], purlAliasMap);
  for (const packagePath of [slice.sourcePackagePath, slice.sinkPackagePath]) {
    const resolvedPurl = resolveComponentPurl(
      modulePurl(symbolModule(packagePath, modules)),
      purlAliasMap,
    );
    if (resolvedPurl) {
      purls.add(resolvedPurl);
    }
  }
  for (const nodeId of slice.nodeIds || []) {
    const node = nodeCache.get(nodeId);
    const resolvedPurl =
      resolveComponentPurl(node?.purl, purlAliasMap) ||
      resolveComponentPurl(modulePurl(node?.module), purlAliasMap) ||
      resolveComponentPurl(
        modulePurl(symbolModule(node?.packagePath, modules)),
        purlAliasMap,
      );
    if (resolvedPurl) {
      purls.add(resolvedPurl);
    }
  }
  return purls;
}

function dataFlowSliceFrames(slice, nodeCache) {
  const frames = [];
  for (const nodeId of slice.nodeIds || []) {
    const node = nodeCache.get(nodeId);
    const frame = frameFromDataFlowNode(node, slice.sinkFunction);
    if (frame) {
      frames.push(frame);
    }
  }
  if (!frames.length) {
    for (const nodeId of [slice.sourceId, slice.sinkId]) {
      const node = nodeCache.get(nodeId);
      const frame = frameFromDataFlowNode(node, slice.sinkFunction);
      if (frame) {
        frames.push(frame);
      }
    }
  }
  return frames;
}

function addDataFlowEvidence(
  golemReport,
  purlAliasMap,
  purlLocationMap,
  dataFlowFrames,
  componentPropertiesMap,
  scopeCountsMap,
  occurrenceKindCountsMap,
  metadataProperties,
) {
  const dataFlow = golemReport.dataFlow;
  if (!dataFlow) {
    return;
  }
  const nodeCache = dataFlowNodeCache(golemReport);
  const modules = golemReport.modules || [];
  const dataFlowCounts = {};
  const cryptoDataFlowCounts = {};
  const slices = [...(dataFlow.slices || [])].sort(
    (left, right) =>
      Number(isCryptoDataFlowSlice(right)) -
      Number(isCryptoDataFlowSlice(left)),
  );
  for (const slice of slices) {
    const purls = resolveDataFlowSlicePurls(
      slice,
      nodeCache,
      modules,
      purlAliasMap,
    );
    if (!purls.size) {
      continue;
    }
    const frames = dataFlowSliceFrames(slice, nodeCache);
    const category = [slice.sourceCategory, slice.sinkCategory]
      .filter(Boolean)
      .join("->");
    const taintKinds = sortedCsv(slice.taintKinds);
    const sourceNode = nodeCache.get(slice.sourceId);
    const sinkNode = nodeCache.get(slice.sinkId);
    for (const purl of purls) {
      incrementCount(dataFlowCounts, purl);
      incrementNestedCount(occurrenceKindCountsMap, purl, "dataFlowSlice");
      incrementNestedCount(scopeCountsMap, purl, slice.sinkScope || "runtime");
      addSetValue(
        purlLocationMap,
        purl,
        positionLocation(sourceNode?.position),
      );
      addSetValue(purlLocationMap, purl, positionLocation(sinkNode?.position));
      if (frames.length) {
        dataFlowFrames[purl] ??= [];
        dataFlowFrames[purl].push(frames);
      }
      addPropertyValue(
        componentPropertiesMap,
        purl,
        "cdx:golem:dataFlowCategories",
        category,
      );
      addPropertyValue(
        componentPropertiesMap,
        purl,
        "cdx:golem:dataFlowRuleId",
        slice.ruleId,
      );
      addPropertyValue(
        componentPropertiesMap,
        purl,
        "cdx:golem:dataFlowSeverity",
        slice.severity,
      );
      addPropertyValue(
        componentPropertiesMap,
        purl,
        "cdx:golem:dataFlowConfidence",
        slice.confidence,
      );
      addPropertyValue(
        componentPropertiesMap,
        purl,
        "cdx:golem:dataFlowTaintKinds",
        taintKinds,
      );
      if (isCryptoDataFlowSlice(slice)) {
        incrementCount(cryptoDataFlowCounts, purl);
        addPropertyValue(
          componentPropertiesMap,
          purl,
          "cdx:golem:cryptoDataFlow",
          true,
        );
        addPropertyValue(
          componentPropertiesMap,
          purl,
          "cdx:golem:cryptoDataFlowCategories",
          category,
        );
        addPropertyValue(
          componentPropertiesMap,
          purl,
          "cdx:golem:cryptoDataFlowRuleId",
          slice.ruleId,
        );
        addPropertyValue(
          componentPropertiesMap,
          purl,
          "cdx:golem:cryptoDataFlowTaintKinds",
          taintKinds,
        );
      }
    }
  }
  addCountProperty(
    metadataProperties,
    "cdx:golem:cryptoDataFlowCount",
    Object.values(cryptoDataFlowCounts).reduce((sum, count) => sum + count, 0),
  );
  for (const [purl, count] of Object.entries(dataFlowCounts)) {
    addCountProperty(
      (componentPropertiesMap[purl] ??= []),
      "cdx:golem:dataFlowSliceCount",
      count,
    );
  }
  for (const [purl, count] of Object.entries(cryptoDataFlowCounts)) {
    addCountProperty(
      (componentPropertiesMap[purl] ??= []),
      "cdx:golem:cryptoDataFlowCount",
      count,
    );
  }
}

function normalizedGolemDataFlowMode(options = {}) {
  let dataFlowMode = String(
    options.golemDataflow || options.golemDataFlow || "",
  ).toLowerCase();
  if (!dataFlowMode) {
    if (options.withDataFlow || options.profile === "research") {
      dataFlowMode = "all";
    } else if (options.deep) {
      dataFlowMode = "all";
    } else {
      dataFlowMode = "none";
    }
  }
  if (!GOLEM_DATAFLOW_MODES.has(dataFlowMode)) {
    return "none";
  }
  return dataFlowMode;
}

function normalizedGolemCallGraphMode(options = {}) {
  let callgraphMode = String(options.golemCallgraph || "static").toLowerCase();
  if (!GOLEM_CALLGRAPH_MODES.has(callgraphMode)) {
    // An unrecognised mode falls back to the default. It used to fall back to
    // the data-flow mode ("security", "all"), which is not a call-graph mode
    // and made golem reject the run.
    callgraphMode = "static";
  }
  return callgraphMode;
}

function normalizedGolemDataFlowCallGraphMode(options = {}) {
  let callgraphMode = String(
    options.golemDataflowCallgraph || "static",
  ).toLowerCase();
  if (!GOLEM_DATAFLOW_CALLGRAPH_MODES.has(callgraphMode)) {
    callgraphMode = "static";
  }
  return callgraphMode;
}

function availableCpuCount() {
  try {
    return cpus()?.length || 1;
  } catch {
    // Deno denies the probe without --allow-sys=cpus; a worker-count hint
    // must not abort the analysis, so fall back to a single worker.
    return 1;
  }
}

function appendGolemDataFlowArgs(args, dataFlowMode, options = {}) {
  if (dataFlowMode === "none") {
    return;
  }
  const cpuCount = availableCpuCount();
  const performanceWorkerCount = Math.max(1, Math.min(cpuCount, 4));
  const dataFlowCallgraph = normalizedGolemDataFlowCallGraphMode(options);
  const dataFlowPacks =
    options.golemDataflowPatternPacks ||
    (dataFlowMode === "crypto" ? "crypto" : "all");
  const dataFlowMaxSlices =
    normalizedPositiveInteger(options.golemDataflowMaxSlices) ||
    (options.deep ? 250 : 1000);
  const dataFlowWorkers =
    normalizedPositiveInteger(options.golemDataflowWorkers) ||
    performanceWorkerCount;
  const maxProcs =
    normalizedPositiveInteger(options.golemMaxProcs) || performanceWorkerCount;
  args.push("--dataflow", dataFlowMode);
  args.push("--dataflow-callgraph", dataFlowCallgraph);
  args.push("--dataflow-pattern-packs", String(dataFlowPacks));
  args.push("--dataflow-max-slices", String(dataFlowMaxSlices));
  args.push("--dataflow-workers", String(dataFlowWorkers));
  args.push("--max-procs", String(maxProcs));
  args.push(
    "--dataflow-large-repo-functions",
    String(
      normalizedPositiveInteger(options.golemDataflowLargeRepoFunctions) ||
        1000,
    ),
  );
  args.push(
    "--dataflow-max-function-instructions",
    String(
      normalizedPositiveInteger(options.golemDataflowMaxFunctionInstructions) ||
        200,
    ),
  );
  args.push(
    "--dataflow-max-trace-nodes",
    String(normalizedPositiveInteger(options.golemDataflowMaxTraceNodes) || 64),
  );
  args.push(
    "--dataflow-max-trace-edges",
    String(
      normalizedPositiveInteger(options.golemDataflowMaxTraceEdges) || 128,
    ),
  );
  if (options.golemDataflowPatterns) {
    args.push("--dataflow-patterns", String(options.golemDataflowPatterns));
  }
  if (options.golemMemoryLimit) {
    args.push("--memory-limit", String(options.golemMemoryLimit));
  }
  if (options.golemDataflowSkipGenerated ?? true) {
    args.push("--dataflow-skip-generated");
  }
  if (options.golemDataflowSkipTests ?? !options.golemTests) {
    args.push("--dataflow-skip-tests");
  }
  if (options.golemProgress) {
    args.push("--progress");
  }
}

function addImportEvidence(
  golemReport,
  purlAliasMap,
  purlLocationMap,
  componentPropertiesMap,
  scopeCountsMap,
  occurrenceKindCountsMap,
) {
  for (const importUsage of golemReport.imports || []) {
    const purl = resolveComponentPurl(
      modulePurl(importUsage.module),
      purlAliasMap,
    );
    if (!purl) {
      continue;
    }
    addSetValue(purlLocationMap, purl, rangeLocation(importUsage.range));
    incrementNestedCount(
      scopeCountsMap,
      purl,
      importUsage.usageScope || "runtime",
    );
    incrementNestedCount(occurrenceKindCountsMap, purl, "import");
    addPropertyValue(
      componentPropertiesMap,
      purl,
      "cdx:golem:importDirect",
      importUsage.direct,
    );
    addPropertyValue(
      componentPropertiesMap,
      purl,
      "cdx:golem:importAliasKind",
      importUsage.aliasKind,
    );
  }
}

function addUsageEvidence(
  golemReport,
  purlAliasMap,
  purlLocationMap,
  dataFlowFrames,
  componentPropertiesMap,
  scopeCountsMap,
  occurrenceKindCountsMap,
) {
  for (const usage of golemReport.usages || []) {
    const purl = resolveComponentPurl(modulePurl(usage.module), purlAliasMap);
    if (!purl) {
      continue;
    }
    addSetValue(purlLocationMap, purl, rangeLocation(usage.range));
    addFrame(dataFlowFrames, purl, frameFromUsage(usage));
    incrementNestedCount(scopeCountsMap, purl, usage.usageScope || "runtime");
    incrementNestedCount(
      occurrenceKindCountsMap,
      purl,
      usage.call ? "symbolCall" : "symbolReference",
    );
    addPropertyValue(
      componentPropertiesMap,
      purl,
      "cdx:golem:symbolKind",
      usage.symbolKind,
    );
    addPropertyValue(
      componentPropertiesMap,
      purl,
      "cdx:golem:usageKind",
      usage.kind,
    );
    addPropertyValue(
      componentPropertiesMap,
      purl,
      "cdx:golem:usageScope",
      usage.usageScope || "runtime",
    );
  }
}

function addCallGraphEvidence(
  golemReport,
  purlAliasMap,
  purlLocationMap,
  dataFlowFrames,
) {
  const modules = golemReport.modules || [];
  const callGraphNodeMap = new Map();
  for (const node of golemReport.callGraph?.nodes || []) {
    if (node?.id) {
      callGraphNodeMap.set(node.id, node);
    }
  }
  const localModules = new Set(
    modules.filter((module) => module.main).map((module) => module.path),
  );
  const localPurls = new Set(
    modules
      .filter((module) => module.main)
      .map((module) => resolveComponentPurl(modulePurl(module), purlAliasMap))
      .filter(Boolean),
  );
  for (const edge of golemReport.callGraph?.edges || []) {
    const sourceModule = symbolModule(edge.sourceId, modules);
    const targetModule = symbolModule(edge.targetId, modules);
    const sourcePurl = resolveComponentPurl(edge.sourcePurl, purlAliasMap);
    const resolvedSourcePurl =
      sourcePurl ||
      resolveComponentPurl(modulePurl(sourceModule), purlAliasMap);
    if (
      resolvedSourcePurl
        ? !localPurls.has(resolvedSourcePurl)
        : !sourceModule?.path || !localModules.has(sourceModule.path)
    ) {
      continue;
    }
    const purls = new Set();
    addResolvedPurls(
      purls,
      [edge.sinkPurl, edge.targetPurl, modulePurl(targetModule)],
      purlAliasMap,
    );
    addResolvedPurls(purls, edge.purls, purlAliasMap);
    purls.delete(resolvedSourcePurl);
    if (!purls.size && resolvedSourcePurl) {
      purls.add(resolvedSourcePurl);
    }
    if (!purls.size) {
      continue;
    }
    for (const purl of purls) {
      addSetValue(
        purlLocationMap,
        purl,
        rangeLocation({ start: edge.position }),
      );
      const sourceFrame =
        frameFromEdge(edge) ||
        frameFromCallGraphNode(
          callGraphNodeMap.get(edge.sourceId),
          edge.sourceName,
        );
      const targetFrame = frameFromCallGraphNode(
        callGraphNodeMap.get(edge.targetId),
        edge.targetName,
      );
      const edgeFrames = dedupeFrames([sourceFrame, targetFrame]);
      if (edgeFrames.length) {
        dataFlowFrames[purl] ??= [];
        dataFlowFrames[purl].push(edgeFrames);
      }
    }
  }
}

/**
 * Determine whether a project language is a Go variant that should trigger golem analysis.
 *
 * @param {string} language Project language identifier.
 * @returns {boolean} True when the language maps to a Go variant.
 */
export function isGolemGoLanguage(language) {
  return GO_LANGUAGES.has(String(language || "").toLowerCase());
}

/**
 * Read and parse a golem analysis JSON report file.
 *
 * @param {string} jsonFile Path to the golem JSON report.
 * @returns {object|undefined} Parsed report object, or undefined when the file
 *   is missing, cannot be parsed, or holds something other than a JSON object
 *   such as `null`.
 */
export function readGolemJsonFile(jsonFile) {
  if (!jsonFile || !safeExistsSync(jsonFile)) {
    return undefined;
  }
  try {
    const report = JSON.parse(readFileSync(jsonFile, "utf-8"));
    return report && typeof report === "object" && !Array.isArray(report)
      ? report
      : undefined;
  } catch (_err) {
    return undefined;
  }
}

/**
 * Invoke the golem analyzer binary over a source directory to produce a JSON report.
 *
 * Assembles the analyze invocation (callgraph mode, data-flow mode, patterns,
 * tags, tests, stdlib flags) from the options and writes the result to
 * `outputFile`.
 *
 * @param {string} src Source directory to analyze.
 * @param {string} outputFile Destination path for the JSON report.
 * @param {object} [options={}] Options controlling golem behavior.
 * @returns {boolean} True when the analysis succeeded and the report was written.
 */
export function runGolemAnalysis(src, outputFile, options = {}) {
  const executable = options.golemCommand || golemBin();
  if (!executable || !src || !outputFile) {
    return false;
  }
  const dataFlowMode = normalizedGolemDataFlowMode(options);
  const callgraphMode = normalizedGolemCallGraphMode(options);
  // cdxgen may run with its working directory already inside the project
  // while the source argument is relative to a repository root; a plain
  // resolve would join the two into a directory that does not exist. The
  // helper checks the result and falls back to the working directory when it
  // is itself the Go module under analysis.
  const analysisDir = resolvePluginSourceDir(src, ["go.mod", "go.work"]);
  const args = [
    "analyze",
    "--dir",
    analysisDir,
    "--format",
    "json",
    "--callgraph",
    callgraphMode,
    "--out",
    resolve(outputFile),
  ];
  appendGolemDataFlowArgs(args, dataFlowMode, options);
  if (options.golemPatterns) {
    args.push("--patterns", String(options.golemPatterns));
  }
  if (options.golemTags || options.tags) {
    args.push("--tags", String(options.golemTags || options.tags));
  }
  if (options.golemTests || options.tests) {
    args.push("--tests");
  }
  if (options.golemIncludeStdlib) {
    args.push("--include-stdlib");
  }
  if (DEBUG_MODE) {
    console.log("Executing", executable, args.join(" "));
  }
  const result = safeSpawnSync(executable, args, {
    cwd: analysisDir,
    shell: false,
  });
  if (result?.status !== 0 || result?.error || !safeExistsSync(outputFile)) {
    reportPluginRunFailure({
      tool: "golem",
      ecosystem: "go",
      executable,
      args,
      dir: analysisDir,
      result,
      outputFile,
      options,
    });
    return false;
  }
  return true;
}

/**
 * Orchestrate a full golem run: execute the analyzer, read the report, and clean up.
 *
 * When `options.semanticsSlicesFile` is set the report is persisted there;
 * otherwise it is written to a temporary directory that is removed after parsing.
 *
 * @param {string} src Source directory to analyze.
 * @param {object} [options={}] Options forwarded to {@link runGolemAnalysis}.
 * @returns {object|undefined} Parsed golem report, or undefined on failure.
 */
export function analyzeGolemProject(src, options = {}) {
  // When a semantics-slices path is provided (--semantics-slices-file), persist
  // the full raw golem report there and keep it. Downstream tools (e.g. depscan)
  // can then consume the complete report - call graph, data-flow slices,
  // security signals, usages - which cdxgen only projects a subset of into the
  // SBOM evidence. go does not otherwise use the semantics slice (atom is never
  // run for go), so the path is free to carry the golem report. Without it,
  // the report is written to a temp dir and deleted after parsing (default).
  const durablePath = options.semanticsSlicesFile
    ? resolve(options.semanticsSlicesFile)
    : undefined;
  const tempDir = durablePath
    ? undefined
    : safeMkdtempSync(join(getTmpDir(), "golem-"));
  const outputFile = durablePath || join(tempDir, "golem.json");
  try {
    if (!runGolemAnalysis(src, outputFile, options)) {
      return undefined;
    }
    return readGolemJsonFile(outputFile);
  } finally {
    if (tempDir?.startsWith(getTmpDir())) {
      safeRmSync(tempDir, { recursive: true, force: true });
    }
  }
}

/**
 * Project a golem report into CycloneDX component evidence, properties, and crypto assets.
 *
 * Aggregates import/usage/call-graph/data-flow evidence and crypto signals from
 * the report, attaching per-component properties and occurrence evidence while
 * collecting any derived cryptographic-asset components.
 *
 * @param {object} [golemReport={}] Parsed golem analysis report.
 * @param {Array<object>} [components=[]] Existing BOM components to match against.
 * @returns {{componentPropertiesMap: Object<string, Array<object>>, cryptoComponents: Array<object>, cryptoGeneratePurls: Object<string, boolean>, dataFlowFrames: Object<string, Array>, metadataProperties: Array<object>, purlLocationMap: Object<string, Array>}}
 *   Projected evidence maps and crypto components.
 */
export function collectGolemEvidence(golemReport = {}, components = []) {
  const purlAliasMap = createPurlAliasMap(components);
  const purlLocationMap = {};
  const dataFlowFrames = {};
  const componentPropertiesMap = {};
  const metadataProperties = [];
  const scopeCountsMap = {};
  const occurrenceKindCountsMap = {};
  const cryptoComponentsByRef = new Map();
  const cryptoGeneratePurls = {};
  addMetadataProperties(metadataProperties, golemReport);
  addSupplyChainProperties(
    componentPropertiesMap,
    metadataProperties,
    purlAliasMap,
    golemReport.supplyChain,
  );
  addModuleProperties(
    componentPropertiesMap,
    purlAliasMap,
    golemReport.modules || [],
  );
  addImportEvidence(
    golemReport,
    purlAliasMap,
    purlLocationMap,
    componentPropertiesMap,
    scopeCountsMap,
    occurrenceKindCountsMap,
  );
  addUsageEvidence(
    golemReport,
    purlAliasMap,
    purlLocationMap,
    dataFlowFrames,
    componentPropertiesMap,
    scopeCountsMap,
    occurrenceKindCountsMap,
  );
  addCallGraphEvidence(
    golemReport,
    purlAliasMap,
    purlLocationMap,
    dataFlowFrames,
  );
  addDataFlowEvidence(
    golemReport,
    purlAliasMap,
    purlLocationMap,
    dataFlowFrames,
    componentPropertiesMap,
    scopeCountsMap,
    occurrenceKindCountsMap,
    metadataProperties,
  );
  addSignalProperties(componentPropertiesMap, purlAliasMap, golemReport);
  addCryptoEvidence(
    componentPropertiesMap,
    metadataProperties,
    purlAliasMap,
    golemReport,
    cryptoComponentsByRef,
    cryptoGeneratePurls,
  );
  for (const [purl, scopeCounts] of Object.entries(scopeCountsMap)) {
    addScopedProperties(componentPropertiesMap, purl, scopeCounts);
  }
  for (const [purl, kindCounts] of Object.entries(occurrenceKindCountsMap)) {
    addOccurrenceKindProperties(componentPropertiesMap, purl, kindCounts);
  }
  return {
    componentPropertiesMap,
    cryptoComponents: Array.from(cryptoComponentsByRef.values()).sort(
      (left, right) =>
        `${left.name}:${left["bom-ref"]}`.localeCompare(
          `${right.name}:${right["bom-ref"]}`,
        ),
    ),
    cryptoGeneratePurls,
    dataFlowFrames,
    metadataProperties,
    purlLocationMap,
  };
}

// The methods a route can be registered for: the RFC 9110 methods, PATCH,
// and the catch-all that gin's and echo's Any register.
const GOLEM_HTTP_METHODS = new Set([
  "get",
  "head",
  "post",
  "put",
  "delete",
  "connect",
  "options",
  "trace",
  "patch",
  "any",
]);

// An RFC 9110 token, which is what net/http accepts as a pattern's method.
const HTTP_METHOD_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

// The host of a net/http pattern: a name or address with an optional port.
const GO_PATTERN_HOST = /^[A-Za-z0-9.:[\]-]+$/;

// Hosts whose URL path carries the credential itself — webhook and bot URLs
// that authenticate by the path alone — with the route each keeps. Everything
// below that route, the team, channel and hook ids and the secret, is dropped.
const GOLEM_SECRET_PATH_ROUTES = [
  ["hooks.slack.com", ["/services/", "/workflows/", "/triggers/"]],
  ["discord.com", ["/api/webhooks/"]],
  ["discordapp.com", ["/api/webhooks/"]],
  ["hooks.zapier.com", ["/hooks/catch/", "/hooks/standard/"]],
  ["maker.ifttt.com", ["/trigger/"]],
  ["api.telegram.org", ["/bot", "/file/bot"]],
  ["outlook.office.com", ["/webhook/", "/webhookb2/"]],
  ["webhook.office.com", ["/webhookb2/"]],
];

/**
 * Append a property to a service definition unless the same name and value are
 * already there, so repeated endpoints of one service do not repeat their
 * framework or method.
 *
 * @param {Object[]} properties Property array, appended to in place
 * @param {string} name Property name
 * @param {string} value Property value, skipped unless a non-empty string
 */
function appendGolemServiceProperty(properties, name, value) {
  if (typeof value !== "string" || !value) {
    return;
  }
  if (
    !properties.some((known) => known.name === name && known.value === value)
  ) {
    properties.push({ name, value });
  }
}

/**
 * The method a golem endpoint names, lower-cased the way the OpenAPI flow
 * spells `cdx:service:httpMethod`, or undefined when it is not an HTTP
 * method. golem takes the selector of a chained gorilla/mux call for the
 * method, so `.Methods("GET", "POST")` arrives as `METHODS` and
 * `.PathPrefix("/products")` as `PATHPREFIX`; neither names one.
 *
 * @param {unknown} method Method a golem endpoint reports
 * @returns {string|undefined} The lower-cased method
 */
function golemHttpMethod(method) {
  if (typeof method !== "string") {
    return undefined;
  }
  const lowered = method.trim().toLowerCase();
  return GOLEM_HTTP_METHODS.has(lowered) ? lowered : undefined;
}

/**
 * The host a golem service names, without the `/` golem puts in front of a
 * listener address that has a host (`/127.0.0.1:9095`) and without userinfo.
 *
 * @param {unknown} host Host a golem service reports
 * @returns {string|undefined} The host
 */
function golemServiceHost(host) {
  if (typeof host !== "string") {
    return undefined;
  }
  return host.slice(host.lastIndexOf("@") + 1).replace(/^\/+/, "") || undefined;
}

/**
 * Index of the brace that closes the one at `open`, counting nesting the way
 * gorilla/mux's braceIndices does, so the `{3}` of `{code:[0-9]{3}}` stays
 * inside the variable. -1 when the braces are unbalanced.
 *
 * @param {string} text Route path
 * @param {number} open Index of an opening brace
 * @returns {number} Index of the closing brace, or -1
 */
function closingBraceIndex(text, open) {
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    if (text[index] === "{") {
      depth++;
    } else if (text[index] === "}" && --depth === 0) {
      return index;
    }
  }
  return -1;
}

/**
 * The OpenAPI spelling of a braced variable. gorilla/mux, chi and iris write
 * `{name:pattern}`; Go 1.22 net/http writes `{name...}` for a trailing
 * wildcard and `{$}` for an exact match of a trailing slash, which names no
 * parameter and is dropped.
 *
 * @param {string} raw Text between the braces
 * @returns {string} The placeholder
 */
function bracedPlaceholder(raw) {
  let name = raw.split(":", 1)[0].trim();
  if (name.endsWith("...")) {
    name = name.slice(0, -3);
  }
  if (name === "$") {
    return "";
  }
  return name ? `{${name}}` : `{${raw}}`;
}

/**
 * The name of a `:name` parameter starting at `start` and the index after it.
 * gin and echo end the name at the next `/`, so `:user-id` names `user-id`.
 * fiber also ends it at `-` and `.`, which lets one segment hold two
 * parameters (`:from-:to`), and allows a constraint and an optional marker
 * after it (`:id<int>?`); both are dropped.
 *
 * @param {string} routePath Route path
 * @param {number} start Index after the colon
 * @param {boolean} fiber Whether the route is a fiber route
 * @returns {{name: string, end: number}|undefined} The parameter
 */
function colonParameter(routePath, start, fiber) {
  const stops = fiber ? "/-.<?" : "/<?";
  let end = start;
  while (end < routePath.length && !stops.includes(routePath[end])) {
    end++;
  }
  const name = routePath.slice(start, end);
  if (!name) {
    return undefined;
  }
  if (routePath[end] === "<") {
    const close = routePath.indexOf(">", end);
    if (close >= 0) {
      end = close + 1;
    }
  }
  if (routePath[end] === "?") {
    end++;
  }
  return { name, end };
}

/**
 * Normalise a Go route path to the placeholder spelling OpenAPI — and
 * therefore the rest of the services a BOM carries — uses. gin, echo and
 * fiber write `:id`, gin writes `*filepath`, chi and gorilla/mux write `{id}`
 * or `{id:[0-9]+}`, and Go 1.22's net/http patterns write `{id...}`; all
 * become `{id}`. Braces are matched by depth, so a regular expression with
 * its own braces or slashes (`{code:[0-9]{3}}`, `{rest:[a-z/]+}`) stays one
 * variable. A fiber constraint or optional marker (`:id<int>`, `:name?`) is
 * dropped, and net/http's `{$}` is removed. A `:` or `*` placeholder is only
 * recognised at the start of a segment — or, for fiber, after a `-` or `.` —
 * so a literal colon such as `/time/09:30` is left alone. Values that do not
 * start with `/` are returned as they are, and so is echo's catch-all, whose
 * bare `*` names no placeholder.
 *
 * @param {string} routePath Path a golem endpoint reports
 * @param {string} [framework] Framework the route was registered with
 * @returns {string} The normalised path
 */
export function normalizeGolemRoutePath(routePath, framework) {
  if (typeof routePath !== "string" || !routePath.startsWith("/")) {
    return routePath;
  }
  const fiber = framework === "fiber";
  let normalized = "";
  let index = 0;
  while (index < routePath.length) {
    const character = routePath[index];
    const previous = routePath[index - 1];
    if (character === "{") {
      const close = closingBraceIndex(routePath, index);
      if (close < 0) {
        // gorilla/mux rejects unbalanced braces; keep the rest as written.
        normalized += routePath.slice(index);
        break;
      }
      normalized += bracedPlaceholder(routePath.slice(index + 1, close));
      index = close + 1;
      continue;
    }
    if (
      character === ":" &&
      (previous === "/" || (fiber && (previous === "-" || previous === ".")))
    ) {
      const parameter = colonParameter(routePath, index + 1, fiber);
      if (parameter) {
        normalized += `{${parameter.name}}`;
        index = parameter.end;
        continue;
      }
    }
    if (character === "*" && previous === "/") {
      let end = routePath.indexOf("/", index);
      if (end < 0) {
        end = routePath.length;
      }
      const name = routePath.slice(index + 1, end);
      if (/^[A-Za-z0-9_]+$/.test(name)) {
        normalized += `{${name}}`;
        index = end;
        continue;
      }
    }
    normalized += character;
    index++;
  }
  return normalized;
}

/**
 * Split a route golem reports into the `[METHOD ][HOST]/PATH` parts of a Go
 * 1.22 net/http ServeMux pattern. golem puts a `/` in front of the pattern it
 * read, so `GET /items/{id}` arrives as `/GET /items/{id}` and
 * `GET example.com/items` as `/GET example.com/items`. A method followed by a
 * space or tab is split off, and so is a host between the method and the
 * path. Without a method, only a value that starts with `/` is a route: the
 * `:8080` a listener reports and the `GET` that a gorilla/mux
 * `.Methods("GET")` call leaves behind are not, and give undefined. A host
 * pattern without a method reaches golem's report as a plain path
 * (`/example.com/items`) and stays one.
 *
 * @param {string} routePath Path a golem endpoint reports
 * @returns {{method: (string|undefined), host: (string|undefined), path: string}|undefined}
 *   The parts, or undefined when the value is not a route
 */
export function parseGolemRoutePattern(routePath) {
  if (typeof routePath !== "string") {
    return undefined;
  }
  const body = routePath.startsWith("/") ? routePath.slice(1) : routePath;
  const gap = body.search(/[ \t]/);
  if (gap > 0) {
    const method = body.slice(0, gap);
    const rest = body.slice(gap + 1).replace(/^[ \t]+/, "");
    const slash = rest.indexOf("/");
    if (HTTP_METHOD_TOKEN.test(method) && slash >= 0) {
      const host = rest.slice(0, slash);
      if (host && !GO_PATTERN_HOST.test(host)) {
        return undefined;
      }
      return { method, host: host || undefined, path: rest.slice(slash) };
    }
  }
  if (!routePath.startsWith("/")) {
    return undefined;
  }
  return { method: undefined, host: undefined, path: routePath };
}

/**
 * The route a golem endpoint of a server names: its CycloneDX endpoint, HTTP
 * method and, for a host-specific net/http pattern, host. Undefined when the
 * entry is not a route — the listener entry that repeats the address a server
 * binds, the leftovers of a chained gorilla/mux call, or the `/PATCH` golem
 * reports for gin's `Handle("PATCH", "/path")`, whose method it read as the
 * path.
 *
 * @param {object} endpoint Endpoint a golem server service reports
 * @param {object} service The service
 * @returns {{endpoint: string, method: (string|undefined), host: (string|undefined)}|undefined}
 *   The route
 */
function golemServerRoute(endpoint, service) {
  const routePath = endpoint.path;
  if (typeof routePath !== "string" || !routePath) {
    return undefined;
  }
  const listener = golemServiceHost(service.host);
  if (listener && routePath.replace(/^\//, "") === listener) {
    return undefined;
  }
  const pattern = parseGolemRoutePattern(routePath);
  if (!pattern) {
    return undefined;
  }
  const method =
    golemHttpMethod(endpoint.method) || golemHttpMethod(pattern.method);
  if (
    !method &&
    /^\/[A-Z]+$/.test(pattern.path) &&
    GOLEM_HTTP_METHODS.has(pattern.path.slice(1).toLowerCase())
  ) {
    return undefined;
  }
  const path = normalizeGolemRoutePath(
    pattern.path,
    endpoint.properties?.framework,
  ).split(/[?#]/, 1)[0];
  return {
    endpoint: encodeUriReference(path),
    method,
    host: pattern.host,
  };
}

/**
 * Reduce an outbound URL golem reports to what is safe to keep in a BOM:
 * scheme, host and path, without userinfo, query, fragment or `;name=value`
 * path parameters such as `;jsessionid=` and `;token=`. Webhook and bot URLs
 * that authenticate by their path — Slack, Discord, Teams, Zapier, IFTTT,
 * Telegram — keep only their route (`https://hooks.slack.com/services`), and a
 * path segment holding a token shape the BOM sanitizer recognises ends the
 * path there. Undefined when the value is not a URL with a host.
 *
 * @param {string} value URL golem reports
 * @returns {string|undefined} The sanitised URL
 */
export function sanitizeGolemEndpointUrl(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  let parsed;
  try {
    // sanitizeBomUrl returns what it cannot parse as it is, which this parse
    // then rejects.
    parsed = new URL(sanitizeBomUrl(value));
  } catch (_err) {
    return undefined;
  }
  if (!parsed.host) {
    return undefined;
  }
  const segments = [];
  for (const segment of parsed.pathname.split("/").slice(1)) {
    const bare = segment.split(";", 1)[0];
    let decoded = bare;
    try {
      decoded = decodeURIComponent(bare);
    } catch (_err) {
      // A malformed escape is checked as written.
    }
    if (hasInlineCredential(decoded)) {
      break;
    }
    segments.push(bare);
  }
  let path = `/${segments.join("/")}`;
  for (const [host, routes] of GOLEM_SECRET_PATH_ROUTES) {
    if (parsed.hostname !== host && !parsed.hostname.endsWith(`.${host}`)) {
      continue;
    }
    const route = routes.find((prefix) => path.startsWith(prefix));
    if (route) {
      path = route.endsWith("/") ? route.slice(0, -1) : route;
      break;
    }
  }
  return encodeUriReference(`${parsed.protocol}//${parsed.host}${path}`);
}

/**
 * The URL a golem endpoint of an external service names, sanitised, with its
 * HTTP method. golem reports the full URL; a report without one has the
 * service's scheme and host put in front of the path.
 *
 * @param {object} endpoint Endpoint a golem external service reports
 * @param {object} service The service
 * @returns {{endpoint: string, method: (string|undefined)}|undefined} The URL
 */
function golemExternalEndpoint(endpoint, service) {
  let url = endpoint.url;
  if (typeof url !== "string" || !url) {
    const host = golemServiceHost(service.host);
    if (
      !host ||
      typeof service.scheme !== "string" ||
      typeof endpoint.path !== "string" ||
      !endpoint.path.startsWith("/")
    ) {
      return undefined;
    }
    url = `${service.scheme}://${host}${endpoint.path}`;
  }
  const sanitized = sanitizeGolemEndpointUrl(url);
  return sanitized
    ? { endpoint: sanitized, method: golemHttpMethod(endpoint.method) }
    : undefined;
}

/**
 * Project the services and API endpoints of a golem report into evinse's
 * service map, so a Go `evinse`/`saasbom` run lists its services the way the
 * kosi (Kotlin) and dosai (.NET) collectors already do (#4498).
 *
 * golem rolls one service up per server it saw — a `gin` engine, a net/http
 * listener on `:8080` — and lists the routes registered on it, each with its
 * HTTP method and framework. Route paths are normalised to OpenAPI
 * placeholders and Go 1.22 ServeMux patterns are split into method, host and
 * path; entries that are not routes are skipped. It also rolls the outbound
 * hosts the source calls into services of `kind: "external"`; those carry
 * `x-trust-boundary: true`, since a host the application calls sits outside
 * its own trust boundary, and their URLs are sanitised before they become
 * endpoints. Every endpoint is percent-encoded to an RFC 3986 reference. The
 * map is keyed by the golem service id, which is unique per server, while
 * `name` carries the display name.
 *
 * HTTP methods are lower-cased to match the property values the OpenAPI flow
 * emits, so a consumer grouping by `cdx:service:httpMethod` sees one value
 * per method.
 *
 * @param {object|null} [golemReport={}] Parsed golem analysis report.
 * @param {Object} [servicesMap={}] Service map to populate.
 * @returns {Object} The service map
 */
export function collectGolemServices(golemReport = {}, servicesMap = {}) {
  const services = Array.isArray(golemReport?.services)
    ? golemReport.services
    : [];
  for (const service of services) {
    const id = typeof service?.id === "string" ? service.id : undefined;
    const name = typeof service?.name === "string" ? service.name : undefined;
    if (!id && !name) {
      continue;
    }
    const definition = (servicesMap[id || name] ??= {
      name: name || id,
      bomRef: id || name,
      endpoints: new Set(),
      properties: [],
    });
    const external = service.kind === "external";
    if (external) {
      definition["x-trust-boundary"] = true;
    }
    const endpoints = Array.isArray(service.endpoints) ? service.endpoints : [];
    for (const endpoint of endpoints) {
      if (!endpoint || typeof endpoint !== "object") {
        continue;
      }
      const route = external
        ? golemExternalEndpoint(endpoint, service)
        : golemServerRoute(endpoint, service);
      if (route) {
        definition.endpoints.add(route.endpoint);
        appendGolemServiceProperty(
          definition.properties,
          "cdx:service:httpMethod",
          route.method,
        );
      }
      appendGolemServiceProperty(
        definition.properties,
        "cdx:golem:service:framework",
        endpoint.properties?.framework,
      );
      appendGolemServiceProperty(
        definition.properties,
        "cdx:golem:service:host",
        route?.host,
      );
    }
    appendGolemServiceProperty(
      definition.properties,
      "cdx:golem:service:kind",
      service.kind,
    );
    appendGolemServiceProperty(
      definition.properties,
      "cdx:golem:service:scheme",
      service.scheme,
    );
    appendGolemServiceProperty(
      definition.properties,
      "cdx:golem:service:host",
      golemServiceHost(service.host),
    );
    appendGolemServiceProperty(
      definition.properties,
      "cdx:golem:service:package",
      service.packagePath,
    );
  }
  return servicesMap;
}
