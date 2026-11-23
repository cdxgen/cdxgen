import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { DEBUG_MODE } from "../core/activity.js";
import {
  LEDGER_EVENT_IMPACTS,
  LEDGER_EVENT_KINDS,
  recordLedgerEvent,
} from "../core/buildLedger.js";
import { compareCodeUnits } from "../core/compare.js";
import {
  getAllFiles,
  getTmpDir,
  safeExistsSync,
  safeMkdtempSync,
  safeRmSync,
  safeSpawnSync,
  safeWriteSync,
} from "../core/fs.js";
import { dirNameStr } from "../core/paths.js";
import {
  reportPluginRunFailure,
  resolvePluginSourceDir,
} from "../core/pluginRun.js";
import { isProjectToolingAllowed } from "../core/projectTooling.js";
import { applyAlgorithmProperties } from "../inventory/cryptoAlgorithmFamily.js";
import { appendUniqueProperty } from "../inventory/depsUtils.js";
import { occurrenceLocationKey } from "../inventory/occurrenceKey.js";
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
  return occurrenceLocationKey(position.filename, position.line);
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
 * Most versions of one crate an import is credited to when the dependency
 * graph does not pick between them. Both the imports in the sources and the
 * versions in the lock files come from the scanned project, and crediting each
 * import to each version multiplies them. Past this many, an import says
 * nothing about which version is used, and none is credited.
 */
export const MAX_UNDECIDED_CRATE_VERSIONS = 32;

/**
 * Identifier a Rust path spells a cargo component with: a crate named `cfg-if`
 * is written `cfg_if` in source.
 *
 * @param {Object} component Component from the BOM
 * @returns {string|undefined} Crate identifier; undefined for a component that is not a named cargo crate
 */
function crateIdentifier(component) {
  if (!component?.purl?.startsWith("pkg:cargo/") || !component.name) {
    return undefined;
  }
  return component.name.toLowerCase().replaceAll("-", "_");
}

/**
 * Index the cargo components by the identifier a Rust path spells them with.
 *
 * A lock file can carry several versions of the same crate, so a name maps to
 * every matching purl.
 *
 * @param {Object[]} components Components from the BOM
 * @returns {Map<string, Set<string>>} Crate identifier to purls
 */
function createCrateNameIndex(components = []) {
  const crateNameIndex = new Map();
  for (const component of components) {
    const identifier = crateIdentifier(component);
    if (!identifier) {
      continue;
    }
    if (!crateNameIndex.has(identifier)) {
      crateNameIndex.set(identifier, new Set());
    }
    crateNameIndex.get(identifier).add(component.purl);
  }
  return crateNameIndex;
}

/**
 * Index the crates each cargo component depends on directly, by the identifier
 * a Rust path spells them with.
 *
 * A package can only name its own dependencies, so of several versions of a
 * crate in the BOM, the one an import refers to is the one the importing
 * package depends on.
 *
 * @param {Object[]} components Components from the BOM
 * @param {Object[]} dependencies Dependency graph from the BOM
 * @returns {Map<string, Map<string, Set<string>>>} Component purl to crate identifier to the purls depended on
 */
function createDirectCrateIndex(components = [], dependencies = []) {
  const crateByRef = new Map();
  for (const component of components) {
    const identifier = crateIdentifier(component);
    if (identifier) {
      crateByRef.set(component["bom-ref"] || component.purl, {
        identifier,
        purl: component.purl,
      });
    }
  }
  const directCrateIndex = new Map();
  for (const dependency of dependencies || []) {
    const owner = crateByRef.get(dependency?.ref);
    if (!owner) {
      continue;
    }
    for (const ref of dependency.dependsOn || []) {
      const crate = crateByRef.get(ref);
      if (!crate) {
        continue;
      }
      if (!directCrateIndex.has(owner.purl)) {
        directCrateIndex.set(owner.purl, new Map());
      }
      const purlsByIdentifier = directCrateIndex.get(owner.purl);
      if (!purlsByIdentifier.has(crate.identifier)) {
        purlsByIdentifier.set(crate.identifier, new Set());
      }
      purlsByIdentifier.get(crate.identifier).add(crate.purl);
    }
  }
  return directCrateIndex;
}

/**
 * Resolve the dependency crates a Rust path refers to.
 *
 * rusi reports an import against the package that declares it, so the imported
 * crate has to be recovered from the path itself. This is what turns an
 * `use hex::encode;` into usage evidence for the `hex` component.
 *
 * Of several versions of the crate, the ones the declaring package depends on
 * directly are meant. When the dependency graph names none of them, every
 * version is, unless there are more than `MAX_UNDECIDED_CRATE_VERSIONS`: then
 * none is.
 *
 * @param {string} importPath Rust path, such as `hex::encode`
 * @param {Map<string, Set<string>>} crateNameIndex Index from {@link createCrateNameIndex}
 * @param {string} [ownerPurl] purl of the package that declares the path
 * @param {Map<string, Map<string, Set<string>>>} [directCrateIndex] Index from {@link createDirectCrateIndex}
 * @returns {string[]} Matching component purls
 */
function resolveImportedCratePurls(
  importPath,
  crateNameIndex,
  ownerPurl,
  directCrateIndex,
) {
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
  const purls =
    directCrateIndex?.get(ownerPurl)?.get(pathRoot) ||
    crateNameIndex.get(pathRoot);
  if (!purls || purls.size > MAX_UNDECIDED_CRATE_VERSIONS) {
    return [];
  }
  return [...purls].filter((purl) => purl !== ownerPurl);
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

const RUST_IDENTIFIER = String.raw`(?:r#)?[\p{XID_Start}_]\p{XID_Continue}*`;

/**
 * A function or macro rusi names by its path, such as `connect`,
 * `std::env::var` or `crate::inner::r#try`.
 */
const RUST_PATH = new RegExp(
  `^(?:::)?${RUST_IDENTIFIER}(?:::${RUST_IDENTIFIER})*!?$`,
  "u",
);

/**
 * A package named the way cargo does, which also allows `-`.
 */
const CARGO_PACKAGE_NAME = /^[\p{XID_Continue}-]+$/u;

/**
 * Keep what rusi reports as a name only when it is one.
 *
 * rusi names a call by its callee. For a callee that is not a path, such as an
 * immediately called closure or a call on the result of a call, that is the
 * source text of the expression, string literals included, and the package
 * of a call graph node is cut from the same text. A frame is published in the
 * BOM, so it carries names and never the source they were read from.
 *
 * @param {*} value Name from the rusi report
 * @param {...RegExp} shapes What a name of this kind looks like
 * @returns {string} The name, or an empty string
 */
function reportedName(value, ...shapes) {
  return typeof value === "string" && shapes.some((shape) => shape.test(value))
    ? value
    : "";
}

function frameFromPosition(position, fallbackData = {}) {
  if (!position?.filename) {
    return undefined;
  }
  return {
    package: reportedName(
      fallbackData.packagePath,
      CARGO_PACKAGE_NAME,
      RUST_PATH,
    ),
    module: fallbackData.kind || "",
    function: reportedName(fallbackData.name, RUST_PATH),
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
  directCrateIndex,
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
      directCrateIndex,
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
 * Whether a `Cargo.toml` declares a workspace of its own.
 *
 * @param {string} manifest Path to a `Cargo.toml`
 * @returns {boolean} True when it has a `[workspace]` table
 */
function declaresCargoWorkspace(manifest) {
  try {
    return readFileSync(manifest, "utf-8")
      .split(/\r?\n/)
      .some((line) => line.trim().startsWith("[workspace"));
  } catch {
    return false;
  }
}

/**
 * Choose the directory rusi analyzes, and name the crates it leaves out.
 *
 * rusi runs `cargo metadata` in the directory it is given, so a repository
 * whose only `Cargo.toml` sits in a subdirectory needs that subdirectory. The
 * scanned directory is used when it holds a `Cargo.toml`. Otherwise a nested
 * Cargo workspace root is used (the nearest one), and failing that the crate
 * nearest to the scanned directory, with ties settled by path. `target`
 * directories and the `--exclude` patterns are skipped. One rusi run covers
 * one cargo project, so crates outside the chosen directory are returned in
 * `skipped`, relative to the scanned directory. When no crate is found the
 * scanned directory is returned, so rusi reports its own error for it.
 *
 * @param {string} dir The scanned directory.
 * @param {Object} [options] CLI options; `options.exclude` is honoured.
 * @returns {{dir: string, skipped: string[]}} The directory to pass to rusi
 * and the crates that analysis does not cover
 */
export function selectCargoProject(dir, options = {}) {
  if (safeExistsSync(join(dir, "Cargo.toml"))) {
    return { dir, skipped: [] };
  }
  const manifests = getAllFiles(dir, "**/Cargo.toml", {
    ...options,
    exclude: [...(options.exclude || []), "**/target/**"],
  });
  const depth = (crateDir) => relative(dir, crateDir).split(sep).length;
  const ordered = manifests
    .map((manifest) => ({
      crateDir: dirname(manifest),
      workspace: declaresCargoWorkspace(manifest),
    }))
    .sort(
      (a, b) =>
        depth(a.crateDir) - depth(b.crateDir) ||
        compareCodeUnits(a.crateDir, b.crateDir),
    );
  if (!ordered.length) {
    return { dir, skipped: [] };
  }
  const chosen = ordered.find((crate) => crate.workspace) || ordered[0];
  const inside = (crateDir) => {
    const rel = relative(chosen.crateDir, crateDir);
    return !rel.startsWith("..") && !isAbsolute(rel);
  };
  return {
    dir: chosen.crateDir,
    skipped: ordered
      .filter((crate) => !inside(crate.crateDir))
      .map((crate) => relative(dir, crate.crateDir)),
  };
}

/**
 * The directory rusi should analyze for a scanned directory, as chosen by
 * {@link selectCargoProject}.
 *
 * @param {string} dir The scanned directory.
 * @param {Object} [options] CLI options; `options.exclude` is honoured.
 * @returns {string} The directory to pass to rusi
 */
export function resolveCargoProjectDir(dir, options = {}) {
  return selectCargoProject(dir, options).dir;
}

/**"],
  });
  const crateDirs = manifests
    .map((manifest) => dirname(manifest))
    .sort(
      (a, b) =>
        relative(dir, a).split(sep).length -
          relative(dir, b).split(sep).length || compareCodeUnits(a, b),
    );
  if (!crateDirs.length) {
    return dir;
  }
  if (crateDirs.length > 1) {
    console.warn(
      `${dir} has no Cargo.toml of its own and holds ${crateDirs.length} crates, so rusi analyzes ${relative(dir, crateDirs[0])}.`,
    );
  }
  return crateDirs[0];
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
  // rusi runs cargo and rustc on the project, which follow its
  // `.cargo/config.toml` and `rust-toolchain.toml` and can compile its build
  // scripts, so it waits for permission to run the project's tooling.
  if (!isProjectToolingAllowed(options)) {
    console.log(
      "Skipping rusi since dependency installation is disabled. Rust evidence needs cargo to run on the project.",
    );
    return false;
  }

  // cdxgen may run with its working directory already inside the project
  // while the source argument is relative to a repository root; a plain
  // resolve would join the two into a directory that does not exist. The
  // helper checks the result and falls back to the working directory when it
  // is itself the cargo project under analysis.
  const scanDir = resolvePluginSourceDir(src, ["Cargo.toml"]);
  const { dir: analysisDir, skipped } = selectCargoProject(scanDir, options);
  if (skipped.length) {
    // One rusi report describes one cargo project and its paths are relative
    // to it, so the other crates are named instead of silently left out.
    const shown = skipped.slice(0, 20).join(", ");
    const more = skipped.length > 20 ? `, and ${skipped.length - 20} more` : "";
    console.warn(
      `${scanDir} has no Cargo.toml of its own, so rusi analyzes ${relative(scanDir, analysisDir) || "."} only; the crates in ${shown}${more} get no rusi evidence.`,
    );
    recordLedgerEvent(LEDGER_EVENT_KINDS.EVIDENCE_DEGRADED, {
      ecosystem: "rust",
      tool: "rusi",
      impact: LEDGER_EVENT_IMPACTS.COMPONENTS,
      detail: `rusi analyzed ${relative(scanDir, analysisDir) || "."} only; ${skipped.length} other crate(s) get no rusi evidence: ${shown}${more}.`,
    });
  }
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
  // rusi always writes into a directory of this run, and cdxgen copies the
  // report to the durable path. The default path is semantics.slices.json in
  // the working directory, which is usually the scanned repository. Given
  // that path, rusi follows a symbolic link committed there and overwrites
  // the file the link points at; safeWriteSync() replaces the link instead.
  const tempDir = safeMkdtempSync(join(getTmpDir(), "rusi-"));
  const outputFile = join(tempDir, "rusi.json");
  try {
    if (!runRusiAnalysis(src, outputFile, options)) {
      return undefined;
    }
    if (durablePath) {
      try {
        safeWriteSync(durablePath, readFileSync(outputFile));
      } catch (err) {
        console.warn(
          `rusi: the report could not be kept at ${durablePath} (${err.message}); this run still uses it.`,
        );
      }
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
 * @param {Array} [dependencies] The dependency graph of the SBOM, which tells the versions of a crate apart.
 * @returns {Object} Maps representing evidence structures.
 */
export function collectRusiEvidence(
  rusiReport = {},
  components = [],
  dependencies = [],
) {
  const purlAliasMap = createPurlAliasMap(components);
  const crateNameIndex = createCrateNameIndex(components);
  const directCrateIndex = createDirectCrateIndex(components, dependencies);
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
    directCrateIndex,
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
        compareCodeUnits(
          `${left.name}:${left["bom-ref"]}`,
          `${right.name}:${right["bom-ref"]}`,
        ),
    ),
    cryptoGeneratePurls,
    dataFlowFrames,
    metadataProperties,
    purlLocationMap,
  };
}
