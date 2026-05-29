import { readFileSync } from "node:fs";
import { cpus } from "node:os";
import { join, resolve } from "node:path";

import { resolvePluginBinary } from "./plugins.js";
import {
  DEBUG_MODE,
  dirNameStr,
  getTmpDir,
  safeExistsSync,
  safeMkdtempSync,
  safeRmSync,
  safeSpawnSync,
} from "./utils.js";

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
  if (start.line && start.line > 0) {
    return `${start.filename}#${start.line}`;
  }
  return start.filename;
}

function positionLocation(position) {
  if (!position?.filename) {
    return undefined;
  }
  if (position.line && position.line > 0) {
    return `${position.filename}#${position.line}`;
  }
  return position.filename;
}

function purlWithoutVersion(purl) {
  return purl?.split("?")[0].split("#")[0].split("@")[0];
}

function modulePurl(module) {
  return module?.purl || module?.PURL;
}

function createPurlAliasMap(components = []) {
  const purlAliasMap = new Map();
  for (const component of components) {
    if (!component?.purl) {
      continue;
    }
    purlAliasMap.set(component.purl, component.purl);
    const noVersionPurl = purlWithoutVersion(component.purl);
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
  return purlAliasMap.get(purl) || purlAliasMap.get(purlWithoutVersion(purl));
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

function normalizedGolemCallGraphMode(dataFlowMode, options = {}) {
  let callgraphMode = String(
    options.golemCallgraph || (dataFlowMode === "none" ? "static" : "none"),
  ).toLowerCase();
  if (!GOLEM_CALLGRAPH_MODES.has(callgraphMode)) {
    callgraphMode = dataFlowMode === "none" ? "static" : "none";
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

function appendGolemDataFlowArgs(args, dataFlowMode, options = {}) {
  if (dataFlowMode === "none") {
    return;
  }
  const cpuCount = cpus()?.length || 1;
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
      addFrame(dataFlowFrames, purl, frameFromEdge(edge));
    }
  }
}

export function isGolemGoLanguage(language) {
  return GO_LANGUAGES.has(String(language || "").toLowerCase());
}

export function readGolemJsonFile(jsonFile) {
  if (!jsonFile || !safeExistsSync(jsonFile)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(jsonFile, "utf-8"));
  } catch (_err) {
    return undefined;
  }
}

export function runGolemAnalysis(src, outputFile, options = {}) {
  const executable = options.golemCommand || golemBin();
  if (!executable || !src || !outputFile) {
    return false;
  }
  const dataFlowMode = normalizedGolemDataFlowMode(options);
  const callgraphMode = normalizedGolemCallGraphMode(dataFlowMode, options);
  const args = [
    "analyze",
    "--dir",
    resolve(src),
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
    cwd: resolve(src),
    shell: false,
  });
  if (result?.status !== 0 || result?.error || !safeExistsSync(outputFile)) {
    if (DEBUG_MODE) {
      if (result?.stdout || result?.stderr) {
        console.error(result.stdout, result.stderr);
      } else {
        console.log("Check if the golem plugin was installed successfully.");
      }
    }
    return false;
  }
  return true;
}

export function analyzeGolemProject(src, options = {}) {
  const tempDir = safeMkdtempSync(join(getTmpDir(), "golem-"));
  const outputFile = join(tempDir, "golem.json");
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
