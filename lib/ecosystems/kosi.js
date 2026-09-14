import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

import { DEBUG_MODE, readEnvironmentVariable } from "../core/activity.js";
import {
  getTmpDir,
  safeExistsSync,
  safeMkdtempSync,
  safeRmSync,
  safeSpawnSync,
} from "../core/fs.js";
import { resolvePluginBinary } from "../inventory/plugins.js";

/**
 * kosi — JS bridge to the Kotlin-native evidence binary (thirdparty/kosi in
 * cdxgen-plugins-bin). This module is the ONLY place that spawns kosi. It
 * follows the cdxrs discipline: no failure mode may abort SBOM generation.
 * A missing binary, a non-zero exit, a timeout or CDXGEN_KOSI_DISABLE logs
 * once and returns undefined so callers keep the plain JS evidence.
 *
 * The consumed report is kosi's `analyze` JSON (schema kosi/1): usages[],
 * callGraph, dataFlow.slices[], crypto and services[]; the attribute
 * contract is thirdparty/kosi/JSON_ATTRIBUTE_REFERENCE.md.
 */

const KOTLIN_LANGUAGES = new Set(["kotlin", "kt", "kotlin-lang"]);

/** Longest wait for a kosi analyze run. Large repos degrade, not hang. */
const DEFAULT_TIMEOUT_MS = 15 * 60_000;

export function isKosiKotlinLanguage(language) {
  return KOTLIN_LANGUAGES.has(String(language || "").toLowerCase());
}

/**
 * True when kosi is disabled by CDXGEN_KOSI_DISABLE (1/all/true) or --no-kosi.
 * The check happens before any binary resolution so a disabled run never
 * even looks for the plugin.
 */
export function kosiDisabled() {
  const raw = (readEnvironmentVariable("CDXGEN_KOSI_DISABLE") || "").toLowerCase();
  if (raw === "1" || raw === "true" || raw === "all") {
    return true;
  }
  return process.argv.includes("--no-kosi");
}

/**
 * Resolve the kosi command: KOSI_CMD wins (may be a native binary or the
 * kosi-all.jar), then the bundled plugin binary.
 */
function kosiCommand() {
  const cmd = resolvePluginBinary("kosi");
  if (!cmd) {
    return undefined;
  }
  if (cmd.endsWith(".jar")) {
    return { cmd: "java", args: ["-Djava.awt.headless=true", "-jar", cmd] };
  }
  return { cmd, args: [] };
}

/**
 * Builds the kosi argv for one analyze mode.
 */
function kosiArgs(kosi, src, outputFile, dataflowMode) {
  const args = [
    ...kosi.args,
    "analyze",
    "--backend", "resolved",
    "--dataflow", dataflowMode,
    "--deps",
    "--endpoint-sources",
    "--sarif-out", join(outputFile, "..", "kosi.sarif"),
    "--dir", resolve(src),
    "--out", outputFile,
  ];
  const classpathFile = join(resolve(src), "classpath.txt");
  if (safeExistsSync(classpathFile)) {
    args.push("--classpath-file", classpathFile);
  }
  return args;
}

function runKosi(kosi, src, args, tempDir, outputFile, options) {
  const result = safeSpawnSync(kosi.cmd, args, {
    cwd: resolve(src),
    shell: false,
    timeout: options.kosiTimeoutMs || DEFAULT_TIMEOUT_MS,
  });
  if (result?.status !== 0 || !safeExistsSync(outputFile)) {
    if (DEBUG_MODE) {
      console.error(result?.stdout, result?.stderr);
    } else {
      console.log("kosi: analyze did not produce a report; skipping the Kotlin native evidence.");
    }
    return undefined;
  }
  return JSON.parse(readFileSync(outputFile, "utf-8"));
}

/**
 * Orchestrates the kosi runs over src and returns the parsed reports: one
 * `all` pass (every slice kind, dependency tier) and one `reachable` pass
 * (call-graph reachability from the roots). The analysis is read-only and
 * offline: kosi never executes the project's build. A classpath.txt beside
 * the sources (the documented build-tool report) is passed through when
 * present.
 *
 * @param {string} src Directory to analyze.
 * @param {Object} options Configuration options.
 * @returns {Object|undefined} { report, reachableReport } or undefined.
 */
export function analyzeKosiProject(src, options = {}) {
  if (kosiDisabled()) {
    console.log("kosi: disabled via CDXGEN_KOSI_DISABLE; skipping the Kotlin native evidence.");
    return undefined;
  }
  const kosi = kosiCommand();
  if (!kosi) {
    console.log("kosi: plugin binary not found; skipping the Kotlin native evidence.");
    return undefined;
  }
  const tempDir = safeMkdtempSync(join(getTmpDir(), "kosi-"));
  try {
    const outputFile = join(tempDir, "kosi-all.json");
    const allArgs = kosiArgs(kosi, src, outputFile, "all");
    if (DEBUG_MODE) {
      console.log("Executing", kosi.cmd, allArgs.join(" "));
    }
    const report = runKosi(kosi, src, allArgs, tempDir, outputFile, options);
    if (!report) {
      return undefined;
    }
    // The reachable pass answers a different question (call-graph
    // reachability from the roots); its slices carry
    // reachableFromRoots + the root witness. Losing it would silently
    // drop the reachability evidence, so a failure here names itself but
    // keeps the all-pass evidence.
    const reachableFile = join(tempDir, "kosi-reachable.json");
    const reachableArgs = kosiArgs(kosi, src, reachableFile, "reachable");
    const reachableReport = runKosi(kosi, src, reachableArgs, tempDir, reachableFile, options);
    return { report, reachableReport };
  } catch (error) {
    if (DEBUG_MODE) {
      console.error("kosi: analyze failed", error);
    }
    return undefined;
  } finally {
    safeRmSync(tempDir, { recursive: true, force: true });
  }
}

function mergeSetMap(into, from) {
  for (const [key, values] of Object.entries(from || {})) {
    for (const value of values) {
      addSetValue(into, key, value);
    }
  }
}

function mergeFramesMap(into, from) {
  for (const [key, frames] of Object.entries(from || {})) {
    into[key] ??= [];
    into[key].push(...frames);
  }
}

function mergePropertiesMap(into, from) {
  for (const [key, properties] of Object.entries(from || {})) {
    into[key] ??= [];
    for (const property of properties) {
      appendUniqueProperty(into[key], property.name, property.value);
    }
  }
}

/**
 * Merges the reachable pass's evidence into the all pass's maps, mutating
 * the first argument.
 */
export function mergeKosiEvidence(all, reachable) {
  if (!reachable) {
    return all;
  }
  mergeSetMap(all.purlLocationMap, reachable.purlLocationMap);
  mergeFramesMap(all.dataFlowFrames, reachable.dataFlowFrames);
  mergePropertiesMap(all.componentPropertiesMap, reachable.componentPropertiesMap);
  for (const component of reachable.cryptoComponents || []) {
    if (!all.cryptoComponents.some((existing) => existing["bom-ref"] === component["bom-ref"])) {
      all.cryptoComponents.push(component);
    }
  }
  return all;
}

function appendUniqueProperty(properties, name, value) {
  if (value === undefined || value === null || value === "") {
    return;
  }
  const propertyValue = String(value);
  if (!properties.some((property) => property.name === name && property.value === propertyValue)) {
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

function createPurlAliasMap(components = []) {
  const purlAliasMap = new Map();
  const nameIndex = new Map();
  for (const component of components) {
    if (!component?.purl) {
      continue;
    }
    purlAliasMap.set(component.purl, component.purl);
    const noVersionPurl = purlWithoutVersion(component.purl);
    if (noVersionPurl && !purlAliasMap.has(noVersionPurl)) {
      purlAliasMap.set(noVersionPurl, component.purl);
    }
    // kosi names jars from an offline classpath as pkg:generic/<file>@<v>
    // (thirdparty/kosi/JSON_ATTRIBUTE_REFERENCE.md). Join those to the
    // resolved component by NAME: "timber-5.0.1" -> the timber component.
    if (component.name) {
      nameIndex.set(String(component.name).toLowerCase(), component.purl);
      const artifact = String(component.purl).match(/pkg:[^/]+\/[^/]+\/([^/@?]+)@/);
      if (artifact && !nameIndex.has(artifact[1].toLowerCase())) {
        nameIndex.set(artifact[1].toLowerCase(), component.purl);
      }
    }
  }
  return { purlAliasMap, nameIndex };
}

function resolveComponentPurl(purl, purlAliasMap) {
  if (!purl) {
    return undefined;
  }
  return purlAliasMap.get(purl) || purlAliasMap.get(purlWithoutVersion(purl));
}

/**
 * The offline-analysis join: a pkg:generic purl resolves through the name
 * index (exact, then with a trailing version stripped). Unresolved purls
 * stay unresolved — no purl is invented.
 */
function resolveLoosePurl(purl, nameIndex) {
  if (!purl?.startsWith("pkg:generic/")) {
    return undefined;
  }
  let candidate = purl.slice("pkg:generic/".length).split("@")[0].split("?")[0];
  candidate = decodeURIComponent(candidate).toLowerCase();
  let hit = nameIndex.get(candidate);
  if (hit) {
    return hit;
  }
  const stripped = candidate.replace(/-v?\d+(?:\.\d+)*$/u, "");
  return stripped === candidate ? undefined : nameIndex.get(stripped);
}

function resolveKosiPurl(purl, purlAliasMap, nameIndex) {
  return resolveComponentPurl(purl, purlAliasMap) || resolveLoosePurl(purl, nameIndex);
}

function frameFromNode(node = {}) {
  if (!node.filePath) {
    return undefined;
  }
  return {
    package: node.modulePath || node.purl || "",
    module: node.kind || "",
    function: node.name || "",
    line: node.position?.line || undefined,
    column: node.position?.column || undefined,
    fullFilename: node.filePath,
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

function addFrame(dataFlowFrames, purl, frame) {
  if (!purl || !frame) {
    return;
  }
  dataFlowFrames[purl] ??= [];
  dataFlowFrames[purl].push([frame]);
}

function cryptoBomRef(kind, name, detail) {
  return `crypto/kosi/${kind}/${encodeURIComponent(name)}@${encodeURIComponent(detail || name)}`;
}

function addMetadataProperties(properties, kosiReport = {}) {
  appendUniqueProperty(properties, "cdx:kosi:schemaVersion", kosiReport.schemaVersion);
  appendUniqueProperty(properties, "cdx:kosi:toolVersion", kosiReport.tool?.version);
  appendUniqueProperty(properties, "cdx:kosi:kotlinVersion", kosiReport.runtime?.kotlinVersion);
  const stats = kosiReport.stats || {};
  if ((stats.sliceCount ?? 0) > 0) {
    appendUniqueProperty(properties, "cdx:kosi:sliceCount", stats.sliceCount);
  }
  if ((stats.crossDependencySliceCount ?? 0) > 0) {
    appendUniqueProperty(
      properties,
      "cdx:kosi:crossDependencySliceCount",
      stats.crossDependencySliceCount,
    );
  }
  const dataFlowStats = kosiReport.dataFlow?.stats || {};
  if ((dataFlowStats.bytecodeSummaries ?? 0) > 0) {
    appendUniqueProperty(
      properties,
      "cdx:kosi:bytecodeSummariesApplied",
      dataFlowStats.bytecodeSummaries,
    );
  }
}

/**
 * Occurrence evidence: every workspace/library usage with a resolved purl
 * and a source position.
 */
function addUsageEvidence(kosiReport, purlAliasMap, nameIndex, purlLocationMap, dataFlowFrames) {
  for (const usage of kosiReport.usages || []) {
    const purl = resolveKosiPurl(usage.purl, purlAliasMap, nameIndex);
    if (!purl) {
      continue;
    }
    addSetValue(purlLocationMap, purl, positionLocation(usage.position));
    addFrame(dataFlowFrames, purl, {
      package: usage.purl || "",
      module: usage.kind || "",
      function: usage.name || "",
      line: usage.position?.line || undefined,
      column: usage.position?.column || undefined,
      fullFilename: usage.position?.filename,
    });
  }
}

/**
 * Callstack, reachability and data-flow evidence from the slices: each
 * slice's trace walks source -> sink; the frames are the callstack, the
 * reachableFromRoots flag is the reachability evidence, and the rule
 * identities are the data-flow classification.
 */
function addDataFlowEvidence(kosiReport, purlAliasMap, nameIndex, purlLocationMap, dataFlowFrames, componentPropertiesMap) {
  const dataFlow = kosiReport.dataFlow || {};
  const nodeMap = new Map();
  for (const node of dataFlow.nodes || []) {
    nodeMap.set(node.id, node);
  }
  const dataFlowCounts = {};
  for (const slice of dataFlow.slices || []) {
    const purls = new Set();
    for (const value of slice.purls || []) {
      const resolvedPurl = resolveKosiPurl(value, purlAliasMap, nameIndex);
      if (resolvedPurl) {
        purls.add(resolvedPurl);
      }
    }
    for (const nodeId of slice.nodeIds || []) {
      const node = nodeMap.get(nodeId);
      const resolvedPurl = resolveKosiPurl(node?.purl, purlAliasMap, nameIndex);
      if (resolvedPurl) {
        purls.add(resolvedPurl);
      }
    }
    if (!purls.size) {
      continue;
    }
    const frames = [];
    for (const nodeId of slice.nodeIds || []) {
      const node = nodeMap.get(nodeId);
      const frame = frameFromNode(node);
      if (frame) {
        frames.push(frame);
      }
    }
    const deduped = dedupeFrames(frames);
    const category = [slice.sourceCategory, slice.sinkCategory].filter(Boolean).join("->");
    for (const purl of purls) {
      dataFlowCounts[purl] = (dataFlowCounts[purl] || 0) + 1;
      const sourceNode = nodeMap.get(slice.sourceId);
      const sinkNode = nodeMap.get(slice.sinkId);
      addSetValue(purlLocationMap, purl, positionLocation(sourceNode?.position));
      addSetValue(purlLocationMap, purl, positionLocation(sinkNode?.position));
      if (deduped.length) {
        dataFlowFrames[purl] ??= [];
        dataFlowFrames[purl].push(deduped);
      }
      addPropertyValue(componentPropertiesMap, purl, "cdx:kosi:dataFlowCategories", category);
      addPropertyValue(componentPropertiesMap, purl, "cdx:kosi:dataFlowRuleName", slice.ruleName);
      if (slice.reachableFromRoots) {
        addPropertyValue(componentPropertiesMap, purl, "cdx:kosi:reachableFromRoots", "true");
      }
      if (slice.crossesDependency) {
        addPropertyValue(componentPropertiesMap, purl, "cdx:kosi:crossesDependency", "true");
      }
    }
  }
  for (const [purl, count] of Object.entries(dataFlowCounts)) {
    addPropertyValue(componentPropertiesMap, purl, "cdx:kosi:dataFlowSliceCount", count);
  }
}

/**
 * Crypto-flow evidence: kosi's crypto collector yields the CBOM assets and
 * materials; crypto-FLOW slices connect material stores to sinks.
 */
function addCryptoEvidence(kosiReport, purlAliasMap, cryptoComponentsByRef, componentPropertiesMap) {
  const crypto = kosiReport.crypto || {};
  for (const asset of crypto.assets || []) {
    const component = {
      type: "cryptographic-asset",
      name: asset.algorithm || asset.symbol || "unknown",
      "bom-ref": cryptoBomRef("algorithm", asset.algorithm || asset.symbol || "unknown", asset.form || "literal"),
      description: "Cryptographic algorithm detected by kosi source analysis",
      cryptoProperties: {
        assetType: "algorithm",
        algorithmProperties: { primitive: asset.kind || "unknown" },
      },
      properties: [],
    };
    appendUniqueProperty(component.properties, "cdx:kosi:crypto:form", asset.form);
    appendUniqueProperty(component.properties, "cdx:kosi:crypto:resolution", asset.resolution);
    cryptoComponentsByRef.set(component["bom-ref"], component);
  }
  for (const material of crypto.materials || []) {
    const component = {
      type: "cryptographic-asset",
      name: material.name || "material",
      "bom-ref": cryptoBomRef("material", material.name || "material", material.kind || "secret"),
      description: "Cryptographic material indicator detected by kosi source analysis",
      cryptoProperties: {
        assetType: "related-crypto-material",
        relatedCryptoMaterialProperties: { type: material.kind || "secret" },
      },
      properties: [],
    };
    appendUniqueProperty(component.properties, "cdx:kosi:crypto:function", material.function);
    cryptoComponentsByRef.set(component["bom-ref"], component);
  }
  for (const slice of (kosiReport.dataFlow || {}).slices || []) {
    const isCryptoFlow =
      (slice.sourceCategory || "").startsWith("hardcoded") ||
      slice.sinkCategory === "crypto-asset" ||
      slice.sinkCategory === "insecure-tls";
    if (!isCryptoFlow) {
      continue;
    }
    for (const purl of slice.purls || []) {
      const resolvedPurl = resolveComponentPurl(purl, purlAliasMap);
      if (resolvedPurl) {
        addPropertyValue(
          componentPropertiesMap,
          resolvedPurl,
          "cdx:kosi:cryptoFlow",
          `${slice.sourceCategory}->${slice.sinkCategory}`,
        );
      }
    }
  }
}

/**
 * Services evidence: kosi's outbound services[] rows are already
 * CycloneDX-shaped.
 */
export function collectKosiServices(kosiReport = {}, servicesMap = {}) {
  for (const service of kosiReport.services || []) {
    if (!service?.id || !service?.name) {
      continue;
    }
    const definition = (servicesMap[service.id] ??= {
      name: service.name,
      bomRef: service.id,
      endpoints: new Set(),
      properties: [],
    });
    for (const endpoint of service.endpoints || []) {
      definition.endpoints.add(endpoint);
    }
    if (typeof definition.authenticated === "undefined") {
      definition.authenticated = service.authenticated ?? undefined;
    }
    if (service.xTrustBoundary && !definition.trustZone) {
      definition.trustZone = service.xTrustBoundary;
    }
    appendUniqueProperty(definition.properties, "cdx:kosi:service:protocol", service.protocol);
    appendUniqueProperty(definition.properties, "cdx:kosi:service:resolution", service.resolution);
    appendUniqueProperty(definition.properties, "cdx:kosi:service:clientLibrary", service.clientLibrary);
  }
  return servicesMap;
}

/**
 * Extracts and maps CycloneDX evidence structures from a kosi report.
 *
 * @param {Object} kosiReport The parsed JSON generated by kosi.
 * @param {Array} components The components present in the SBOM.
 * @returns {Object} Maps representing evidence structures.
 */
function addImportEvidence(kosiReport, purlAliasMap, nameIndex, purlLocationMap, dataFlowFrames) {
  for (const imported of kosiReport.imports || []) {
    const purl = resolveKosiPurl(imported.purl, purlAliasMap, nameIndex);
    if (!purl) {
      continue;
    }
    addSetValue(purlLocationMap, purl, positionLocation(imported.position));
    addFrame(dataFlowFrames, purl, {
      package: imported.purl || "",
      module: "import",
      function: imported.name || "",
      line: imported.position?.line || undefined,
      column: imported.position?.column || undefined,
      fullFilename: imported.position?.filename,
    });
  }
}

export function collectKosiEvidence(kosiReport = {}, components = []) {
  const { purlAliasMap, nameIndex } = createPurlAliasMap(components);
  const purlLocationMap = {};
  const dataFlowFrames = {};
  const componentPropertiesMap = {};
  const metadataProperties = [];
  const cryptoComponentsByRef = new Map();

  addMetadataProperties(metadataProperties, kosiReport);
  addImportEvidence(kosiReport, purlAliasMap, nameIndex, purlLocationMap, dataFlowFrames);
  addUsageEvidence(kosiReport, purlAliasMap, nameIndex, purlLocationMap, dataFlowFrames);
  addDataFlowEvidence(kosiReport, purlAliasMap, nameIndex, purlLocationMap, dataFlowFrames, componentPropertiesMap);
  addCryptoEvidence(kosiReport, purlAliasMap, cryptoComponentsByRef, componentPropertiesMap);

  return {
    componentPropertiesMap,
    cryptoComponents: Array.from(cryptoComponentsByRef.values()).sort((left, right) =>
      `${left.name}:${left["bom-ref"]}`.localeCompare(`${right.name}:${right["bom-ref"]}`),
    ),
    cryptoGeneratePurls: {},
    dataFlowFrames,
    metadataProperties,
    purlLocationMap,
  };
}
