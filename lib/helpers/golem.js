import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { resolvePluginBinary } from "./plugins.js";
import {
  DEBUG_MODE,
  getTmpDir,
  safeExistsSync,
  safeMkdtempSync,
  safeRmSync,
  safeSpawnSync,
} from "./utils.js";

const GO_LANGUAGES = new Set(["go", "golang"]);
const GOLEM_CALLGRAPH_MODES = new Set(["none", "static", "rta", "pointer"]);

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
  for (const edge of golemReport.callGraph?.edges || []) {
    const sourceModule = symbolModule(edge.sourceId, modules);
    const targetModule = symbolModule(edge.targetId, modules);
    if (!sourceModule?.path || !localModules.has(sourceModule.path)) {
      continue;
    }
    const purl = resolveComponentPurl(modulePurl(targetModule), purlAliasMap);
    if (!purl) {
      continue;
    }
    addSetValue(purlLocationMap, purl, rangeLocation({ start: edge.position }));
    addFrame(dataFlowFrames, purl, frameFromEdge(edge));
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
  let callgraphMode = String(options.golemCallgraph || "static").toLowerCase();
  if (!GOLEM_CALLGRAPH_MODES.has(callgraphMode)) {
    callgraphMode = "static";
  }
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
  if (options.golemPatterns) {
    args.push("--patterns", String(options.golemPatterns));
  }
  if (options.golemTags || options.tags) {
    args.push("--tags", String(options.golemTags || options.tags));
  }
  if (options.golemTests || options.tests) {
    args.push("--tests");
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
  addSignalProperties(componentPropertiesMap, purlAliasMap, golemReport);
  for (const [purl, scopeCounts] of Object.entries(scopeCountsMap)) {
    addScopedProperties(componentPropertiesMap, purl, scopeCounts);
  }
  for (const [purl, kindCounts] of Object.entries(occurrenceKindCountsMap)) {
    addOccurrenceKindProperties(componentPropertiesMap, purl, kindCounts);
  }
  return {
    componentPropertiesMap,
    dataFlowFrames,
    metadataProperties,
    purlLocationMap,
  };
}
