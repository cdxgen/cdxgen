import { readFileSync } from "node:fs";
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
import { applyAlgorithmProperties } from "../inventory/cryptoAlgorithmFamily.js";
import { resolvePluginBinary } from "../inventory/plugins.js";

const RUST_LANGUAGES = new Set(["rust", "rs", "rust-lang"]);

const RUSI_CRYPTO_OIDS = JSON.parse(
  readFileSync(join(dirNameStr, "data", "crypto-oid.json"), "utf-8"),
);

/**
 * Resolves the rusi binary.
 *
 * @returns {string} The path to the rusi binary.
 */
function rusiBin() {
  return resolvePluginBinary("rusi");
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

/**
 * Path roots that never name a dependency crate.
 */
const RUST_NON_CRATE_PATH_ROOTS = new Set([
  "crate",
  "self",
  "super",
  "std",
  "core",
  "alloc",
  "proc_macro",
  "test",
]);

/**
 * Index the cargo components by the identifier a Rust path spells them with.
 *
 * A crate named `cfg-if` is written `cfg_if` in source, and a lock file can
 * carry several versions of the same crate, so a name maps to every matching
 * purl.
 *
 * @param {Object[]} components Components from the BOM
 * @returns {Map<string, string[]>} Crate identifier to purls
 */
function createCrateNameIndex(components = []) {
  const crateNameIndex = new Map();
  for (const component of components) {
    if (!component?.purl?.startsWith("pkg:cargo/") || !component.name) {
      continue;
    }
    const crateIdentifier = component.name.toLowerCase().replaceAll("-", "_");
    const purls = crateNameIndex.get(crateIdentifier) || [];
    if (!purls.includes(component.purl)) {
      purls.push(component.purl);
    }
    crateNameIndex.set(crateIdentifier, purls);
  }
  return crateNameIndex;
}

/**
 * Resolve the dependency crates a Rust path refers to.
 *
 * rusi reports an import against the package that declares it, so the imported
 * crate has to be recovered from the path itself. This is what turns an
 * `use hex::encode;` into usage evidence for the `hex` component.
 *
 * @param {string} importPath Rust path, such as `hex::encode`
 * @param {Map<string, string[]>} crateNameIndex Index from {@link createCrateNameIndex}
 * @param {string} [ownerPurl] purl of the package that declares the path
 * @returns {string[]} Matching component purls
 */
function resolveImportedCratePurls(importPath, crateNameIndex, ownerPurl) {
  if (!importPath || !crateNameIndex?.size) {
    return [];
  }
  const pathRoot = String(importPath)
    .replace(/^::/, "")
    .split("::")[0]
    .trim()
    .toLowerCase();
  if (!pathRoot || RUST_NON_CRATE_PATH_ROOTS.has(pathRoot)) {
    return [];
  }
  return (crateNameIndex.get(pathRoot) || []).filter(
    (purl) => purl !== ownerPurl,
  );
}

function resolveComponentPurl(purl, purlAliasMap) {
  if (!purl) {
    return undefined;
  }
  return purlAliasMap.get(purl) || purlAliasMap.get(purlWithoutVersion(purl));
}

function addResolvedPurls(purls, values, purlAliasMap) {
  for (const value of values || []) {
    const resolvedPurl = resolveComponentPurl(value, purlAliasMap);
    if (resolvedPurl) {
      purls.add(resolvedPurl);
    }
  }
}

function frameFromPosition(position, fallbackData = {}) {
  if (!position?.filename) {
    return undefined;
  }
  return {
    package: fallbackData.packagePath || "",
    module: fallbackData.kind || "",
    function: fallbackData.name || "",
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

function incrementCount(map, key) {
  if (!key) {
    return;
  }
  map[key] = (map[key] || 0) + 1;
}

function cryptoBomRef(kind, name, detail) {
  return `crypto/${kind}/${encodeURIComponent(name)}@${encodeURIComponent(detail || name)}`;
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
      "cdx:rusi:crypto:sourceLocation",
      positionLocation(item?.position),
    );
    return component;
  }
  appendCryptoComponentProperty(
    existing,
    "cdx:rusi:crypto:sourceLocation",
    positionLocation(item?.position),
  );
  return existing;
}

// The schema requires an oid for algorithm assets, so an algorithm the OID
// table cannot name is skipped rather than emitted invalid. rusi reports
// display-cased names ("SHA-256") while the table is lowercase ("sha-256").
function resolveCryptoAlgorithmMetadata(name) {
  if (!name) {
    return undefined;
  }
  const lowered = String(name).toLowerCase();
  return (
    RUSI_CRYPTO_OIDS[name] ||
    RUSI_CRYPTO_OIDS[lowered] ||
    RUSI_CRYPTO_OIDS[lowered.replace(/[\s_]+/g, "-")]
  );
}

function cryptoAlgorithmComponent(asset) {
  const algorithmName = asset.algorithm || asset.kind || "unknown";
  const algorithmMetadata = resolveCryptoAlgorithmMetadata(algorithmName);
  if (!algorithmMetadata?.oid) {
    return undefined;
  }
  const component = {
    type: "cryptographic-asset",
    name: algorithmName,
    "bom-ref": cryptoBomRef("algorithm", algorithmName, algorithmMetadata.oid),
    description:
      algorithmMetadata.description ||
      "Cryptographic algorithm/component detected by rusi source analysis",
    cryptoProperties: {
      assetType: "algorithm",
      oid: algorithmMetadata.oid,
      algorithmProperties: { primitive: asset.kind || "unknown" },
    },
    properties: [],
  };
  // rusi reports a free-form kind ("key-generation", "signing"), while the
  // schema closes `primitive` to an enum. The kind is kept as a property so a
  // value the enum cannot express is recorded rather than lost when
  // applyAlgorithmProperties drops it from the structured field.
  appendCryptoComponentProperty(component, "cdx:rusi:crypto:kind", asset.kind);
  applyAlgorithmProperties(component, {
    name: asset.algorithm || asset.kind,
    primitive: asset.kind,
    curve: asset.curve,
  });
  appendCryptoComponentProperty(
    component,
    "cdx:rusi:crypto:provider",
    asset.provider,
  );
  appendCryptoComponentProperty(
    component,
    "cdx:rusi:crypto:operation",
    asset.operation,
  );
  appendCryptoComponentProperty(
    component,
    "cdx:rusi:crypto:symbol",
    asset.symbol,
  );
  return component;
}

function cryptoMaterialComponent(material) {
  const materialType = material.kind || "unknown";
  const component = {
    type: "cryptographic-asset",
    name: material.name || materialType,
    "bom-ref": cryptoBomRef(
      "material",
      material.name || materialType,
      materialType,
    ),
    description:
      "Related cryptographic material indicator detected by rusi source analysis",
    cryptoProperties: {
      assetType: "related-crypto-material",
      relatedCryptoMaterialProperties: { type: materialType },
    },
    properties: [],
  };
  appendCryptoComponentProperty(
    component,
    "cdx:rusi:crypto:function",
    material.function,
  );
  appendCryptoComponentProperty(
    component,
    "cdx:rusi:crypto:confidence",
    material.confidence,
  );
  return component;
}

/**
 * Returns the backend rusi actually used. `options.backend` is only the
 * requested backend: when the compiler backend cannot run (missing
 * components, wrapper build failure), rusi still echoes "compiler" but falls
 * back to the stable source analysis. Compiler evidence was collected only
 * when rusi emits its compiler-source-evidence diagnostic; a backend-error
 * alone is not conclusive because native interop scanning reports failures
 * under that kind too.
 *
 * @param {Object} rusiReport Parsed rusi report
 * @returns {string|undefined} Effective backend name
 */
export function effectiveRusiBackend(rusiReport = {}) {
  const requested = rusiReport.options?.backend;
  if (requested !== "compiler") {
    return requested;
  }
  const collected = (rusiReport.diagnostics || []).some(
    (d) => d?.kind === "compiler-source-evidence",
  );
  return collected ? requested : "stable";
}

function addMetadataProperties(properties, rusiReport = {}) {
  appendUniqueProperty(
    properties,
    "cdx:rusi:schemaVersion",
    rusiReport.schema_version,
  );
  appendUniqueProperty(
    properties,
    "cdx:rusi:toolVersion",
    rusiReport.tool?.version,
  );
  appendUniqueProperty(
    properties,
    "cdx:rusi:rustcVersion",
    rusiReport.runtime?.rustc_version,
  );
  appendUniqueProperty(
    properties,
    "cdx:rusi:cargoVersion",
    rusiReport.runtime?.cargo_version,
  );
  appendUniqueProperty(properties, "cdx:rusi:host", rusiReport.runtime?.host);

  const options = rusiReport.options || {};
  const backend = effectiveRusiBackend(rusiReport);
  appendUniqueProperty(properties, "cdx:rusi:backend", backend);
  if (options.backend && options.backend !== backend) {
    appendUniqueProperty(
      properties,
      "cdx:rusi:requestedBackend",
      options.backend,
    );
  }
  appendUniqueProperty(
    properties,
    "cdx:rusi:analysisScope",
    options.analysis_scope,
  );
  appendUniqueProperty(
    properties,
    "cdx:rusi:callGraphMode",
    options.call_graph_mode,
  );
  appendUniqueProperty(
    properties,
    "cdx:rusi:dataFlowMode",
    options.data_flow_mode,
  );

  const stats = rusiReport.stats || {};
  addCountProperty(properties, "cdx:rusi:packageCount", stats.package_count);
  addCountProperty(properties, "cdx:rusi:fileCount", stats.file_count);
  addCountProperty(properties, "cdx:rusi:importCount", stats.import_count);
  addCountProperty(
    properties,
    "cdx:rusi:declarationCount",
    stats.declaration_count,
  );
  addCountProperty(properties, "cdx:rusi:usageCount", stats.usage_count);
  addCountProperty(
    properties,
    "cdx:rusi:securitySignalCount",
    stats.security_signal_count,
  );
  addCountProperty(
    properties,
    "cdx:rusi:cryptoLibraryCount",
    stats.crypto_library_count,
  );
  addCountProperty(
    properties,
    "cdx:rusi:cryptoComponentCount",
    stats.crypto_component_count,
  );
  addCountProperty(
    properties,
    "cdx:rusi:cryptoFindingCount",
    stats.crypto_finding_count,
  );
  addCountProperty(
    properties,
    "cdx:rusi:callGraphNodeCount",
    stats.call_graph_node_count,
  );
  addCountProperty(
    properties,
    "cdx:rusi:callGraphEdgeCount",
    stats.call_graph_edge_count,
  );
  addCountProperty(
    properties,
    "cdx:rusi:dataFlowNodeCount",
    stats.data_flow_node_count,
  );
  addCountProperty(
    properties,
    "cdx:rusi:dataFlowEdgeCount",
    stats.data_flow_edge_count,
  );
  addCountProperty(
    properties,
    "cdx:rusi:dataFlowSliceCount",
    stats.data_flow_slice_count,
  );
}

function addImportEvidence(
  rusiReport,
  purlAliasMap,
  purlLocationMap,
  componentPropertiesMap,
  crateNameIndex,
) {
  for (const importUsage of rusiReport.imports || []) {
    const purl = resolveComponentPurl(importUsage.purl, purlAliasMap);
    if (!purl) {
      continue;
    }
    addSetValue(purlLocationMap, purl, positionLocation(importUsage.position));
    addPropertyValue(
      componentPropertiesMap,
      purl,
      "cdx:rusi:importPath",
      importUsage.path,
    );
    addPropertyValue(
      componentPropertiesMap,
      purl,
      "cdx:rusi:importAlias",
      importUsage.alias,
    );
    // The import is also evidence about the crate being imported, which is the
    // component a consumer filters on.
    for (const cratePurl of resolveImportedCratePurls(
      importUsage.path,
      crateNameIndex,
      purl,
    )) {
      addSetValue(
        purlLocationMap,
        cratePurl,
        positionLocation(importUsage.position),
      );
      addPropertyValue(
        componentPropertiesMap,
        cratePurl,
        "cdx:rusi:importedBy",
        purl,
      );
      addPropertyValue(
        componentPropertiesMap,
        cratePurl,
        "cdx:rusi:importPath",
        importUsage.path,
      );
    }
  }
}

function addUsageEvidence(
  rusiReport,
  purlAliasMap,
  purlLocationMap,
  dataFlowFrames,
  componentPropertiesMap,
) {
  for (const usage of rusiReport.usages || []) {
    const purl = resolveComponentPurl(usage.purl, purlAliasMap);
    if (!purl) {
      continue;
    }
    addSetValue(purlLocationMap, purl, positionLocation(usage.position));
    addFrame(
      dataFlowFrames,
      purl,
      frameFromPosition(usage.position, {
        packagePath: usage.package_path,
        kind: usage.kind,
        name: usage.name,
      }),
    );
    addPropertyValue(
      componentPropertiesMap,
      purl,
      "cdx:rusi:usageKind",
      usage.kind,
    );
  }
}

function addCallGraphEvidence(
  rusiReport,
  purlAliasMap,
  purlLocationMap,
  dataFlowFrames,
) {
  const callGraph = rusiReport.call_graph || {};
  const nodeMap = new Map();
  for (const node of callGraph.nodes || []) {
    if (node.id) {
      nodeMap.set(node.id, node);
    }
  }

  for (const edge of callGraph.edges || []) {
    const purls = new Set();
    addResolvedPurls(purls, edge.purls, purlAliasMap);
    addResolvedPurls(purls, [edge.sourcePurl, edge.targetPurl], purlAliasMap);

    if (!purls.size) {
      continue;
    }

    const sourceNode = nodeMap.get(edge.source_id);
    const targetNode = nodeMap.get(edge.target_id);

    for (const purl of purls) {
      addSetValue(purlLocationMap, purl, positionLocation(edge.position));

      const sourceFrame = frameFromPosition(edge.position, {
        packagePath: sourceNode?.package_path,
        kind: edge.call_type,
        name: edge.source_name,
      });

      const targetFrame = targetNode
        ? frameFromPosition(targetNode.position, {
            packagePath: targetNode.package_path,
            kind: targetNode.kind,
            name: edge.target_name,
          })
        : undefined;

      const edgeFrames = dedupeFrames(
        [sourceFrame, targetFrame].filter(Boolean),
      );
      if (edgeFrames.length) {
        dataFlowFrames[purl] ??= [];
        dataFlowFrames[purl].push(edgeFrames);
      }
    }
  }
}

function addDataFlowEvidence(
  rusiReport,
  purlAliasMap,
  purlLocationMap,
  dataFlowFrames,
  componentPropertiesMap,
) {
  const dataFlow = rusiReport.data_flow || {};
  const nodeMap = new Map();
  for (const node of dataFlow.nodes || []) {
    nodeMap.set(node.id, node);
  }

  const dataFlowCounts = {};
  for (const slice of dataFlow.slices || []) {
    const purls = new Set();
    addResolvedPurls(purls, slice.purls, purlAliasMap);
    addResolvedPurls(purls, [slice.sourcePurl, slice.targetPurl], purlAliasMap);

    for (const nodeId of slice.node_ids || []) {
      const node = nodeMap.get(nodeId);
      if (node?.purl) {
        addResolvedPurls(purls, [node.purl], purlAliasMap);
      }
    }

    if (!purls.size) {
      continue;
    }

    const frames = [];
    for (const nodeId of slice.node_ids || []) {
      const node = nodeMap.get(nodeId);
      if (node) {
        const frame = frameFromPosition(node.position, {
          packagePath: node.package_path,
          kind: node.category || node.kind,
          name: node.name || node.function,
        });
        if (frame) frames.push(frame);
      }
    }

    const category = [slice.source_category, slice.sink_category]
      .filter(Boolean)
      .join("->");

    for (const purl of purls) {
      incrementCount(dataFlowCounts, purl);
      const sourceNode = nodeMap.get(slice.source_id);
      const sinkNode = nodeMap.get(slice.sink_id);

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
        "cdx:rusi:dataFlowCategories",
        category,
      );
      addPropertyValue(
        componentPropertiesMap,
        purl,
        "cdx:rusi:dataFlowRuleName",
        slice.rule_name,
      );
    }
  }

  for (const [purl, count] of Object.entries(dataFlowCounts)) {
    addCountProperty(
      (componentPropertiesMap[purl] ??= []),
      "cdx:rusi:dataFlowSliceCount",
      count,
    );
  }
}

function addSecuritySignals(rusiReport, purlAliasMap, componentPropertiesMap) {
  for (const signal of rusiReport.security_signals || []) {
    const purl = resolveComponentPurl(signal.purl, purlAliasMap);
    if (!purl) {
      continue;
    }
    addPropertyValue(
      componentPropertiesMap,
      purl,
      "cdx:rusi:securitySignalCategory",
      signal.category,
    );
    addPropertyValue(
      componentPropertiesMap,
      purl,
      "cdx:rusi:securitySignalSeverity",
      signal.severity,
    );
  }
}

function addCryptoEvidence(
  rusiReport,
  purlAliasMap,
  cryptoComponentsByRef,
  cryptoGeneratePurls,
  componentPropertiesMap,
) {
  const crypto = rusiReport.crypto;
  if (!crypto) {
    return;
  }

  for (const comp of crypto.components || []) {
    const component = cryptoAlgorithmComponent(comp);
    if (component) {
      mergeCryptoComponent(cryptoComponentsByRef, component, comp);
      const purl = resolveComponentPurl(comp.purl, purlAliasMap);
      if (purl) {
        cryptoGeneratePurls[purl] ??= new Set();
        cryptoGeneratePurls[purl].add(component["bom-ref"]);
      }
    }
  }

  for (const material of crypto.materials || []) {
    const component = cryptoMaterialComponent(material);
    if (component) {
      mergeCryptoComponent(cryptoComponentsByRef, component, material);
    }
  }

  for (const finding of crypto.findings || []) {
    const purl = resolveComponentPurl(finding.purl, purlAliasMap);
    if (!purl) {
      continue;
    }
    addPropertyValue(
      componentPropertiesMap,
      purl,
      "cdx:rusi:cryptoFindingCategory",
      finding.category,
    );
    addPropertyValue(
      componentPropertiesMap,
      purl,
      "cdx:rusi:cryptoFindingSeverity",
      finding.severity,
    );
  }
}

/**
 * Checks if the provided language is a Rust language alias.
 *
 * @param {string} language The language to check.
 * @returns {boolean} True if the language is Rust.
 */
export function isRusiRustLanguage(language) {
  return RUST_LANGUAGES.has(String(language || "").toLowerCase());
}

/**
 * Reads and parses the JSON output generated by rusi.
 *
 * @param {string} jsonFile Path to the rusi output file.
 * @returns {Object|undefined} Parsed JSON report or undefined.
 */
export function readRusiJsonFile(jsonFile) {
  if (!jsonFile || !safeExistsSync(jsonFile)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(jsonFile, "utf-8"));
  } catch (_err) {
    return undefined;
  }
}

/**
 * Invokes the rusi binary to analyze a codebase.
 *
 * @param {string} src Directory to analyze.
 * @param {string} outputFile Path to store the resulting JSON file.
 * @param {Object} options Options containing rusi configurations.
 * @returns {boolean} True if successful.
 */
export function runRusiAnalysis(src, outputFile, options = {}) {
  const executable = options.rusiCommand || rusiBin();
  if (!executable || !src || !outputFile) {
    return false;
  }

  // cdxgen may run with its working directory already inside the project
  // while the source argument is relative to a repository root; a plain
  // resolve would join the two into a directory that does not exist. The
  // helper checks the result and falls back to the working directory when it
  // is itself the cargo project under analysis.
  const analysisDir = resolvePluginSourceDir(src, ["Cargo.toml"]);
  const rusiMode = options.rusiMode === "cryptos" ? "cryptos" : "analyze";
  const args = [rusiMode, "--dir", analysisDir, "--out", resolve(outputFile)];

  // Set callgraph and data-flow args
  args.push("--callgraph", options.rusiCallgraph || "static");

  let dataFlow = options.rusiDataflow;
  if (!dataFlow) {
    dataFlow =
      options.withDataFlow || options.profile === "research"
        ? "security"
        : "none";
  }
  args.push("--dataflow", dataFlow);

  if (options.rusiBackend) {
    args.push("--backend", options.rusiBackend);
  }

  if (options.rusiToolchain) {
    args.push("--toolchain", options.rusiToolchain);
  }

  if (options.rusiPatterns) {
    args.push("--patterns", resolve(options.rusiPatterns));
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
      tool: "rusi",
      ecosystem: "rust",
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
 * Orchestrates the execution of rusi and returns the parsed report.
 *
 * @param {string} src Directory to analyze.
 * @param {Object} options Configuration options.
 * @returns {Object|undefined} Parsed rusi report or undefined.
 */
export function analyzeRusiProject(src, options = {}) {
  // When a semantics-slices path is provided (--semantics-slices-file), persist
  // the full raw rusi report there and keep it. Downstream tools (e.g. depscan)
  // can then consume the complete report - call graph, data-flow slices,
  // security signals - which cdxgen only projects a subset of into the SBOM
  // evidence. rust does not otherwise use the semantics slice (atom is never
  // run for rust), so the path is free to carry the rusi report. Without it,
  // the report is written to a temp dir and deleted after parsing (default).
  const durablePath = options.semanticsSlicesFile
    ? resolve(options.semanticsSlicesFile)
    : undefined;
  const tempDir = durablePath
    ? undefined
    : safeMkdtempSync(join(getTmpDir(), "rusi-"));
  const outputFile = durablePath || join(tempDir, "rusi.json");
  try {
    if (!runRusiAnalysis(src, outputFile, options)) {
      return undefined;
    }
    return readRusiJsonFile(outputFile);
  } finally {
    if (tempDir?.startsWith(getTmpDir())) {
      safeRmSync(tempDir, { recursive: true, force: true });
    }
  }
}

/**
 * Extracts and maps CycloneDX evidence structures from a rusi report.
 *
 * @param {Object} rusiReport The parsed JSON generated by rusi.
 * @param {Array} components The components present in the SBOM.
 * @returns {Object} Maps representing evidence structures.
 */
export function collectRusiEvidence(rusiReport = {}, components = []) {
  const purlAliasMap = createPurlAliasMap(components);
  const crateNameIndex = createCrateNameIndex(components);
  const purlLocationMap = {};
  const dataFlowFrames = {};
  const componentPropertiesMap = {};
  const metadataProperties = [];
  const cryptoComponentsByRef = new Map();
  const cryptoGeneratePurls = {};

  addMetadataProperties(metadataProperties, rusiReport);
  addImportEvidence(
    rusiReport,
    purlAliasMap,
    purlLocationMap,
    componentPropertiesMap,
    crateNameIndex,
  );
  addUsageEvidence(
    rusiReport,
    purlAliasMap,
    purlLocationMap,
    dataFlowFrames,
    componentPropertiesMap,
  );
  addCallGraphEvidence(
    rusiReport,
    purlAliasMap,
    purlLocationMap,
    dataFlowFrames,
  );
  addDataFlowEvidence(
    rusiReport,
    purlAliasMap,
    purlLocationMap,
    dataFlowFrames,
    componentPropertiesMap,
  );
  addSecuritySignals(rusiReport, purlAliasMap, componentPropertiesMap);
  addCryptoEvidence(
    rusiReport,
    purlAliasMap,
    cryptoComponentsByRef,
    cryptoGeneratePurls,
    componentPropertiesMap,
  );

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
