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
import { resolvePluginSourceDir } from "../core/pluginRun.js";
import { resolvePluginBinary } from "../inventory/plugins.js";
import {
  parsePurlLoose,
  tryBuildPurl,
  tryParsePurl,
} from "../inventory/purl.js";

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

/**
 * Builds the workspace component candidate for one kosi module.
 *
 * kosi derives module names from Gradle settings files, so a quoted literal
 * (rootProject.name = 'KotlinGoat') rides into the reported purl. A purl
 * cdx-purl rejects anchors nothing and must not reach the BOM: keep the
 * reported purl when it parses, rebuild one from the cleaned coordinates
 * when it does not, and return undefined when neither works.
 *
 * @param {Object|undefined} workspaceModule One entry of kosi's modules[].
 * @returns {Object|undefined} Component candidate with a valid purl, or undefined.
 */
export function kosiWorkspaceComponent(workspaceModule) {
  if (!workspaceModule?.purl) {
    return undefined;
  }
  // The version is read through the purl parser: cutting the text after `@`
  // kept its escaping (`1.0.0%2Bbuild`) and any `?type=jar` qualifiers.
  const version =
    parsePurlLoose(workspaceModule.purl)?.version || "unspecified";
  const cleanName = (workspaceModule.name || "").replace(/^['"]|['"]+$/g, "");
  const purl =
    tryParsePurl(workspaceModule.purl) ||
    tryBuildPurl({ type: "generic", name: cleanName, version });
  if (!purl) {
    return undefined;
  }
  return {
    type: "application",
    name: cleanName || workspaceModule.name,
    version,
    purl,
    "bom-ref": decodeURIComponent(purl),
  };
}

export function isKosiKotlinLanguage(language) {
  return KOTLIN_LANGUAGES.has(String(language || "").toLowerCase());
}

/**
 * True when kosi is disabled by CDXGEN_KOSI_DISABLE (1/all/true) or --no-kosi.
 * The check happens before any binary resolution so a disabled run never
 * even looks for the plugin.
 */
export function kosiDisabled() {
  const raw = (
    readEnvironmentVariable("CDXGEN_KOSI_DISABLE") || ""
  ).toLowerCase();
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
    "--backend",
    "resolved",
    "--dataflow",
    dataflowMode,
    "--deps",
    "--endpoint-sources",
    "--dir",
    resolve(src),
    "--out",
    outputFile,
  ];
  const classpathFile = join(resolve(src), "classpath.txt");
  if (safeExistsSync(classpathFile)) {
    args.push("--classpath-file", classpathFile);
  }
  return args;
}

function runKosi(kosi, src, args, outputFile, options) {
  const result = safeSpawnSync(kosi.cmd, args, {
    cwd: resolve(src),
    shell: false,
    timeout: options.kosiTimeoutMs || DEFAULT_TIMEOUT_MS,
  });
  if (result?.status !== 0 || !safeExistsSync(outputFile)) {
    if (DEBUG_MODE) {
      console.error(result?.stdout, result?.stderr);
    } else {
      console.log(
        "kosi: analyze did not produce a report; skipping the Kotlin native evidence.",
      );
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
    console.log(
      "kosi: disabled via CDXGEN_KOSI_DISABLE; skipping the Kotlin native evidence.",
    );
    return undefined;
  }
  const kosi = kosiCommand();
  if (!kosi) {
    console.log(
      "kosi: plugin binary not found; skipping the Kotlin native evidence.",
    );
    return undefined;
  }
  // cdxgen may run with its working directory already inside the project
  // while the source argument is relative to a repository root; a plain
  // resolve would join the two into a directory that does not exist.
  const analysisDir = resolvePluginSourceDir(src, [
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "settings.gradle",
    "settings.gradle.kts",
    "classpath.txt",
  ]);
  const tempDir = safeMkdtempSync(join(getTmpDir(), "kosi-"));
  try {
    const outputFile = join(tempDir, "kosi-all.json");
    const allArgs = kosiArgs(kosi, analysisDir, outputFile, "all");
    if (DEBUG_MODE) {
      console.log("Executing", kosi.cmd, allArgs.join(" "));
    }
    const report = runKosi(kosi, analysisDir, allArgs, outputFile, options);
    if (!report) {
      return undefined;
    }
    // The reachable pass answers a different question (call-graph
    // reachability from the roots): its slice set is the intersection
    // with that reachability, so its evidence is a strict subset of the
    // all-pass's. Losing it would silently drop the filtered evidence,
    // so a failure here names itself but keeps the all-pass evidence.
    const reachableFile = join(tempDir, "kosi-reachable.json");
    const reachableArgs = kosiArgs(
      kosi,
      analysisDir,
      reachableFile,
      "reachable",
    );
    const reachableReport = runKosi(
      kosi,
      analysisDir,
      reachableArgs,
      reachableFile,
      options,
    );
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
 *
 * The reachable pass's slices are the all pass's INTERSECTED with call-graph
 * reachability from the roots, so every key it produces is a key the all pass
 * already has, and the unions below cannot add one. That made the second full
 * `--backend resolved --deps` analysis — the most expensive thing this arm
 * runs, and it runs it twice — contribute exactly nothing: the one fact it
 * computes, reachability, was discarded at the merge (the P23 review's R144).
 * It is recorded now, on the components whose evidence survived the
 * intersection, which is the signal an SBOM consumer prioritises with. kosi's
 * own schema deliberately stopped carrying `reachableFromRoots` per slice in
 * P22 because there it was a mode-level fact wearing a per-slice field's
 * clothes; here it is neither, it is the measured difference between two runs.
 */
export function mergeKosiEvidence(all, reachable) {
  if (!reachable) {
    return all;
  }
  for (const purl of Object.keys(reachable.purlLocationMap || {})) {
    addPropertyValue(
      all.componentPropertiesMap,
      purl,
      "cdx:kosi:reachableFromRoots",
      "true",
    );
  }
  mergeSetMap(all.purlLocationMap, reachable.purlLocationMap);
  mergeFramesMap(all.dataFlowFrames, reachable.dataFlowFrames);
  mergePropertiesMap(
    all.componentPropertiesMap,
    reachable.componentPropertiesMap,
  );
  for (const component of reachable.cryptoComponents || []) {
    if (
      !all.cryptoComponents.some(
        (existing) => existing["bom-ref"] === component["bom-ref"],
      )
    ) {
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
      const artifact = String(component.purl).match(
        /pkg:[^/]+\/[^/]+\/([^/@?]+)@/,
      );
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
  const hit = nameIndex.get(candidate);
  if (hit) {
    return hit;
  }
  const stripped = candidate.replace(/-v?\d+(?:\.\d+)*$/u, "");
  return stripped === candidate ? undefined : nameIndex.get(stripped);
}

function resolveKosiPurl(purl, purlAliasMap, nameIndex) {
  return (
    resolveComponentPurl(purl, purlAliasMap) ||
    resolveLoosePurl(purl, nameIndex)
  );
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

/**
 * P24: kosi's per-slice `frames[]` are the named hops —
 * (function, file, line, role), source first, sink last, with the
 * callee-internal hops spliced in at every summary boundary. They are a
 * BETTER callstack than the node-derived one (every hop names its
 * function, not just its register), so they are preferred whenever the
 * report carries them; the node walk stays as the pre-P24 fallback.
 */
function framesFromSlice(slice) {
  if (!Array.isArray(slice.frames) || !slice.frames.length) {
    return undefined;
  }
  const frames = [];
  for (const frame of slice.frames) {
    if (!frame?.file) {
      continue;
    }
    frames.push({
      package: "",
      module: frame.role || "",
      function: frame.function || "",
      line: frame.line || undefined,
      column: undefined,
      fullFilename: frame.file,
    });
  }
  return frames.length ? frames : undefined;
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

/**
 * kosi's exit contract (kosi-cli Main.kt): `analyze` exits 0 whenever a
 * report was written — a degraded run (budget trip, callgraph-failed, even
 * ERROR-severity diagnostics) is DATA in the report, printed to stderr but
 * never a crash. A non-zero exit means usage error or an uncaught failure,
 * and in both cases no report file exists. So runKosi's discard on
 * status !== 0 never throws away a partial report — there is never one to
 * throw away — and a report that made it this far is always the complete
 * record of what kosi did, degradations included. Those degradations are
 * joined onto the BOM below; before that they stopped at the report and a
 * half-read repository produced a BOM indistinguishable from a fully-read
 * one (the same defect kosi itself was fixed for, one layer up).
 */
function aggregateDiagnostics(kosiReport = {}) {
  const byCode = new Map();
  for (const diagnostic of kosiReport.diagnostics || []) {
    if (!diagnostic?.code) {
      continue;
    }
    // An entry without a count is one event (no-sources); a counted entry
    // carries its own multiplicity (resolution-errors per file, count =
    // errors in it), so the sum is the population the code affected.
    const entry = byCode.get(diagnostic.code) ?? { count: 0, error: false };
    entry.count += diagnostic.count ?? 1;
    // Severity is the half a bare count cannot carry. `callgraph-failed`
    // is an ERROR — the call graph is ABSENT from the report — while
    // `resolution-errors` is a warning about imperfect typing on a run
    // that otherwise completed. Published as one count each, they read
    // alike, and a consumer sorting by count reads the warning as the
    // bigger problem. Error wins for a code once any entry carries it.
    entry.error = entry.error || diagnostic.severity === "error";
    byCode.set(diagnostic.code, entry);
  }
  return byCode;
}

function addMetadataProperties(properties, kosiReport = {}) {
  appendUniqueProperty(
    properties,
    "cdx:kosi:schemaVersion",
    kosiReport.schemaVersion,
  );
  appendUniqueProperty(
    properties,
    "cdx:kosi:toolVersion",
    kosiReport.tool?.version,
  );
  appendUniqueProperty(
    properties,
    "cdx:kosi:kotlinVersion",
    kosiReport.runtime?.kotlinVersion,
  );
  // Signals are counted at the BOM level as well as attached to components,
  // because one of them cannot be attached: a cinterop `.def` file carries no
  // purl — it is not a module source — and attaching it to nothing would make
  // a real finding disappear between the report and the BOM.
  const signals = kosiReport.securitySignals || [];
  if (signals.length) {
    appendUniqueProperty(
      properties,
      "cdx:kosi:securitySignalCount",
      String(signals.length),
    );
    for (const code of Array.from(
      new Set(signals.map((signal) => signal?.code).filter(Boolean)),
    ).sort()) {
      appendUniqueProperty(properties, "cdx:kosi:securitySignal", code);
    }
  }
  const stats = kosiReport.stats || {};
  // A run kosi itself marked incomplete. `no-jdk` means the resolved tier
  // attached no JDK, so every `java.*` symbol resolved to nothing;
  // `kotlin-version` means a version mismatch coincided with heavy
  // resolution fallout. Either way the counts below are not facts about the
  // code, and a BOM that carries the counts without the caveat is the
  // failure this property exists to prevent.
  if (stats.degraded) {
    appendUniqueProperty(properties, "cdx:kosi:degraded", stats.degraded);
  }
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
  // Source coverage: discovery against what is on disk, published WITH its
  // denominators (kosi's own rule — a rate without its denominator is not a
  // result). The `source-coverage-gap` diagnostic fires on nonTestRatio;
  // the numbers let a consumer judge runs the threshold stayed silent on.
  const coverage = stats.sourceCoverage;
  if (coverage) {
    appendUniqueProperty(
      properties,
      "cdx:kosi:sourceCoverageDiscovered",
      coverage.discovered,
    );
    appendUniqueProperty(
      properties,
      "cdx:kosi:sourceCoveragePresent",
      coverage.present,
    );
    appendUniqueProperty(
      properties,
      "cdx:kosi:sourceCoverageTestPresent",
      coverage.testPresent,
    );
    appendUniqueProperty(
      properties,
      "cdx:kosi:sourceCoverageRatio",
      coverage.ratio,
    );
    appendUniqueProperty(
      properties,
      "cdx:kosi:sourceCoverageNonTestRatio",
      coverage.nonTestRatio,
    );
  }
  // Every degradation kosi suffered, named by its diagnostic code and
  // counted. Silence here was the join losing the caveat: an endpoint kosi
  // explicitly marked unread (endpoint-unsubstantiated), a budget trip
  // (analysis-time-budget, rss-budget), a coverage gap — none of it reached
  // the BOM, so the SaaSBOM's services and the metadata read exactly like a
  // fully-analysed run's.
  const diagnostics = aggregateDiagnostics(kosiReport);
  for (const [code, entry] of diagnostics) {
    appendUniqueProperty(
      properties,
      `cdx:kosi:diagnostic:${code}`,
      entry.count,
    );
  }
  // Which of those codes were ERRORS, in one property a consumer can read
  // without knowing kosi's diagnostic vocabulary. An error means a piece of
  // the analysis is ABSENT from this report (the call graph crashed, a file
  // could not be read), not merely imperfect — and that is the difference a
  // per-code count on its own cannot express.
  const errorCodes = [...diagnostics]
    .filter(([, entry]) => entry.error)
    .map(([code]) => code)
    .sort();
  if (errorCodes.length) {
    appendUniqueProperty(
      properties,
      "cdx:kosi:diagnosticErrors",
      errorCodes.join(","),
    );
  }
}

/**
 * Occurrence evidence: every workspace/library usage with a resolved purl
 * and a source position.
 */
function addUsageEvidence(
  kosiReport,
  purlAliasMap,
  nameIndex,
  purlLocationMap,
  dataFlowFrames,
) {
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
 * slice's trace walks source -> sink; the frames are the callstack, kosi's
 * per-slice `pathKind` says what that trace IS (complete | partial |
 * symbol-only), and the rule identities are the data-flow classification.
 * Reachability is NOT here: it is the difference between the two passes and
 * is stamped in `mergeKosiEvidence`. This sentence said "the
 * reachableFromRoots flag is the reachability evidence" for a field kosi
 * deleted in P22, seventy lines above the code that had already stopped
 * reading it.
 */
function addDataFlowEvidence(
  kosiReport,
  purlAliasMap,
  nameIndex,
  purlLocationMap,
  dataFlowFrames,
  componentPropertiesMap,
) {
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
    // P24: the named hops first; the node walk only when the report
    // predates frames[].
    const frames =
      framesFromSlice(slice) ||
      (slice.nodeIds || [])
        .map((nodeId) => frameFromNode(nodeMap.get(nodeId)))
        .filter(Boolean);
    const deduped = dedupeFrames(frames);
    const category = [slice.sourceCategory, slice.sinkCategory]
      .filter(Boolean)
      .join("->");
    for (const purl of purls) {
      dataFlowCounts[purl] = (dataFlowCounts[purl] || 0) + 1;
      const sourceNode = nodeMap.get(slice.sourceId);
      const sinkNode = nodeMap.get(slice.sinkId);
      addSetValue(
        purlLocationMap,
        purl,
        positionLocation(sourceNode?.position),
      );
      addSetValue(purlLocationMap, purl, positionLocation(sinkNode?.position));
      if (deduped.length) {
        dataFlowFrames[purl] ??= [];
        dataFlowFrames[purl].push(deduped);
      }
      addPropertyValue(
        componentPropertiesMap,
        purl,
        "cdx:kosi:dataFlowCategories",
        category,
      );
      addPropertyValue(
        componentPropertiesMap,
        purl,
        "cdx:kosi:dataFlowRuleName",
        slice.ruleName,
      );
      // P22: kosi replaced the constant-false reachableFromRoots flag with
      // pathKind (complete | partial | symbol-only) — what the slice's
      // trace IS, published per slice instead of a mode-level fact.
      if (slice.pathKind) {
        addPropertyValue(
          componentPropertiesMap,
          purl,
          "cdx:kosi:pathKind",
          slice.pathKind,
        );
      }
      if (slice.crossesDependency) {
        addPropertyValue(
          componentPropertiesMap,
          purl,
          "cdx:kosi:crossesDependency",
          "true",
        );
      }
    }
  }
  for (const [purl, count] of Object.entries(dataFlowCounts)) {
    addPropertyValue(
      componentPropertiesMap,
      purl,
      "cdx:kosi:dataFlowSliceCount",
      count,
    );
  }
}

/**
 * Crypto-flow evidence: kosi's crypto collector yields the CBOM assets and
 * materials; crypto-FLOW slices connect material stores to sinks.
 */
/**
 * kosi's `securitySignals[]` codes, with the severity each one carries. The
 * vocabulary is CLOSED (kosi's 02-ARCHITECTURE.md §8), so this is a table and
 * not a guess; a code kosi adds later arrives here as an unknown and is
 * published with its code and no severity rather than silently dropped.
 *
 * kosi's signal shape is not golem's — `code`/`message`/`symbol` against
 * golem's `category`/`severity` — which is why the golem reader could not
 * simply be pointed at it, and why these signals reached no BOM at all while
 * golem's did. kosi's report contract described the field as reserved and
 * empty long after it began emitting, which is the likeliest reason nobody
 * wired it up.
 */
const KOSI_SIGNAL_SEVERITY = {
  "native-interop": "info",
};

/**
 * Non-flow findings: the JNI seams, `loadLibrary` binding sites and cinterop
 * `.def` files kosi reports. Each signal already names the purl and module it
 * attaches to, so no symbol-to-module resolution is needed — unlike golem,
 * where the package path has to be matched back to a module.
 */
function addSecuritySignalEvidence(
  kosiReport,
  purlAliasMap,
  nameIndex,
  purlLocationMap,
  componentPropertiesMap,
) {
  for (const signal of kosiReport.securitySignals || []) {
    const code = signal?.code;
    if (!code) {
      continue;
    }
    const purl = resolveKosiPurl(signal.purl, purlAliasMap, nameIndex);
    if (!purl) {
      continue;
    }
    addPropertyValue(
      componentPropertiesMap,
      purl,
      "cdx:kosi:securitySignalCode",
      code,
    );
    addPropertyValue(
      componentPropertiesMap,
      purl,
      "cdx:kosi:securitySignalSeverity",
      KOSI_SIGNAL_SEVERITY[code],
    );
    addPropertyValue(
      componentPropertiesMap,
      purl,
      "cdx:kosi:securitySignalSymbol",
      signal.symbol,
    );
    // A `.def` file carries a repo-relative path and no module of its own,
    // so the filePath is the only location it has.
    const location =
      positionLocation(signal.position) ||
      (signal.filePath ? signal.filePath : undefined);
    if (location) {
      addSetValue(purlLocationMap, purl, location);
    }
  }
}

function addCryptoEvidence(
  kosiReport,
  purlAliasMap,
  nameIndex,
  cryptoComponentsByRef,
  componentPropertiesMap,
) {
  const crypto = kosiReport.crypto || {};
  for (const asset of crypto.assets || []) {
    const component = {
      type: "cryptographic-asset",
      name: asset.algorithm || asset.symbol || "unknown",
      "bom-ref": cryptoBomRef(
        "algorithm",
        asset.algorithm || asset.symbol || "unknown",
        asset.form || "literal",
      ),
      description: "Cryptographic algorithm detected by kosi source analysis",
      cryptoProperties: {
        assetType: "algorithm",
        algorithmProperties: { primitive: asset.kind || "unknown" },
      },
      properties: [],
    };
    appendUniqueProperty(
      component.properties,
      "cdx:kosi:crypto:form",
      asset.form,
    );
    appendUniqueProperty(
      component.properties,
      "cdx:kosi:crypto:resolution",
      asset.resolution,
    );
    cryptoComponentsByRef.set(component["bom-ref"], component);
  }
  for (const material of crypto.materials || []) {
    const component = {
      type: "cryptographic-asset",
      name: material.name || "material",
      "bom-ref": cryptoBomRef(
        "material",
        material.name || "material",
        material.kind || "secret",
      ),
      description:
        "Cryptographic material indicator detected by kosi source analysis",
      cryptoProperties: {
        assetType: "related-crypto-material",
        relatedCryptoMaterialProperties: { type: material.kind || "secret" },
      },
      properties: [],
    };
    appendUniqueProperty(
      component.properties,
      "cdx:kosi:crypto:function",
      material.function,
    );
    cryptoComponentsByRef.set(component["bom-ref"], component);
  }
  for (const slice of kosiReport.dataFlow?.slices || []) {
    const isCryptoFlow =
      (slice.sourceCategory || "").startsWith("hardcoded") ||
      slice.sinkCategory === "crypto-asset" ||
      slice.sinkCategory === "insecure-tls";
    if (!isCryptoFlow) {
      continue;
    }
    for (const purl of slice.purls || []) {
      // The SAME join every other evidence kind uses. This site alone used
      // the exact-match resolver, so a crypto flow whose purl is an offline
      // `pkg:generic/...` one — which is every workspace-local flow, and the
      // hardcoded-secret -> crypto-asset flow on the sample is exactly that
      // — silently attached to nothing while the other four kinds landed.
      const resolvedPurl = resolveKosiPurl(purl, purlAliasMap, nameIndex);
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
 * Occurrence evidence for one service call site. Mirrors the dosai shape:
 * `evidence.occurrences[]` is a CycloneDX 2.0 field that spec-version
 * compatibility strips below 2.0, so the same location also lands in a
 * property where it survives at 1.6 and 1.7.
 */
function addServiceOccurrence(definition, filePath, position, enclosingSymbol) {
  const path = filePath || position?.filename;
  if (!path) {
    return;
  }
  const location = {
    path,
    line: position?.line || undefined,
    column: position?.column || undefined,
  };
  definition.evidence ??= { occurrences: [] };
  definition.evidence.occurrences ??= [];
  const key = `${location.path}#${location.line}#${location.column}`;
  const known = definition.evidence.occurrences;
  if (
    !known.some(
      (seen) =>
        `${seen?.location?.path}#${seen?.location?.line}#${seen?.location?.column}` ===
        key,
    )
  ) {
    known.push({ location });
  }
  definition.properties ??= [];
  appendUniqueProperty(
    definition.properties,
    "cdx:kosi:service:location",
    `${location.path}:${location.line || 0}:${location.column || 0}`,
  );
  appendUniqueProperty(
    definition.properties,
    "cdx:kosi:service:enclosingSymbol",
    enclosingSymbol,
  );
}

/**
 * kosi's `urls[]` rows, indexed by the value they carry. Every outbound call
 * site appears here with its file, position, enclosing symbol and resolution,
 * while `services[]` carries ONE position for the service as a whole — so a
 * service reached from three places gets three occurrences only through this
 * index. Both spellings are indexed (`url` is the normalised value, `raw` the
 * source text) because a service's `endpoints[]` may match either.
 */
function urlEvidenceIndex(kosiReport = {}) {
  const index = new Map();
  for (const row of kosiReport.urls || []) {
    for (const value of [row?.url, row?.raw]) {
      if (!value) {
        continue;
      }
      if (!index.has(value)) {
        index.set(value, []);
      }
      const rows = index.get(value);
      if (!rows.includes(row)) {
        rows.push(row);
      }
    }
  }
  return index;
}

/**
 * Services evidence: kosi's outbound services[] rows are already
 * CycloneDX-shaped.
 */
export function collectKosiServices(kosiReport = {}, servicesMap = {}) {
  const urlIndex = urlEvidenceIndex(kosiReport);
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
    // kosi publishes the HYPHENATED CycloneDX key, not the camelCase one this
    // read used, so every kosi service lost its trust boundary — the property
    // was never present under the name being asked for. It also belongs in
    // `x-trust-boundary`, which the normaliser maps to the CycloneDX field;
    // `trustZone` is a different concept and put the flag somewhere no
    // consumer reads it as one.
    const trustBoundary = service["x-trust-boundary"] ?? service.xTrustBoundary;
    if (
      typeof trustBoundary === "boolean" &&
      typeof definition["x-trust-boundary"] === "undefined"
    ) {
      definition["x-trust-boundary"] = trustBoundary;
    }
    // Where the call was made. The service's own position is one call site;
    // the url rows carry the rest, with the function each one sits in.
    addServiceOccurrence(
      definition,
      service.position?.filename,
      service.position,
    );
    for (const endpoint of service.endpoints || []) {
      for (const row of urlIndex.get(endpoint) || []) {
        addServiceOccurrence(
          definition,
          row.filePath,
          row.position,
          row.enclosingSymbol,
        );
        appendUniqueProperty(
          definition.properties,
          "cdx:kosi:service:urlResolution",
          row.resolution,
        );
      }
    }
    appendUniqueProperty(
      definition.properties,
      "cdx:kosi:service:protocol",
      service.protocol,
    );
    appendUniqueProperty(
      definition.properties,
      "cdx:kosi:service:resolution",
      service.resolution,
    );
    appendUniqueProperty(
      definition.properties,
      "cdx:kosi:service:clientLibrary",
      service.clientLibrary,
    );
  }
  return servicesMap;
}

/**
 * INBOUND endpoints: kosi's apiEndpoints[] rows are the routes the analysed
 * application itself serves, which `services[]` (kosi's OUTBOUND calls)
 * does not carry. Without this the whole inbound surface — the path
 * template, the framework that declared it, and above all whether anything
 * authenticates it — stopped at the kosi report and never reached the
 * SaaSBOM.
 *
 * One service per endpoint, named the way detectServicesFromOpenAPI names
 * its own (`service-<path>-<method>`), so an OpenAPI spec and a kosi run
 * over the same route converge on one entry instead of two.
 *
 * `authenticated` is left UNDEFINED when the endpoint declares no
 * authentication: kosi's empty list means "nothing was declared here",
 * which is not the same claim as "this route is unauthenticated", and
 * cdxgen's own detectors use undefined for exactly that unknown.
 *
 * @param {Object} kosiReport The parsed JSON generated by kosi.
 * @param {Object} servicesMap Map populated with detected service definitions
 * @returns {Object} The mutated services map
 */
export function collectKosiApiEndpoints(kosiReport = {}, servicesMap = {}) {
  for (const endpoint of kosiReport.apiEndpoints || []) {
    const pathTemplate = endpoint?.pathTemplate;
    if (!pathTemplate) {
      continue;
    }
    // kosi's schema field is httpMethod (SINGULAR) — reading a plural
    // `httpMethods` silently fell to ["ALL"] for every endpoint, losing the
    // verb and splitting one route into kosi's service-x-all beside an
    // OpenAPI spec's service-x-get: the duplicate the shared naming exists
    // to prevent. Found by running the join on a real kosi report (P16 §4).
    const methods = endpoint.httpMethod?.length ? endpoint.httpMethod : ["ALL"];
    for (const httpMethod of methods) {
      const serviceName = `service-${pathTemplate.replaceAll("/", "")}-${httpMethod.toLowerCase()}`;
      const definition = (servicesMap[serviceName] ??= {
        name: serviceName,
        endpoints: new Set(),
        authenticated: undefined,
        xTrustBoundary: undefined,
        properties: [],
      });
      definition.properties ??= [];
      definition.endpoints ??= new Set();
      definition.endpoints.add(pathTemplate);
      if (endpoint.authentication?.length) {
        definition.authenticated = true;
        definition.xTrustBoundary = true;
        for (const scheme of endpoint.authentication) {
          appendUniqueProperty(
            definition.properties,
            "cdx:kosi:endpoint:authentication",
            scheme,
          );
        }
      }
      appendUniqueProperty(
        definition.properties,
        "cdx:service:httpMethod",
        httpMethod,
      );
      appendUniqueProperty(
        definition.properties,
        "cdx:kosi:endpoint:framework",
        endpoint.framework,
      );
      appendUniqueProperty(
        definition.properties,
        "cdx:kosi:endpoint:handler",
        endpoint.handlerCanonicalName || endpoint.handlerSymbol,
      );
      // The caveat kosi spent rounds learning to say: `substantiated:
      // false` means the manifest DECLARES this endpoint and kosi read none
      // of the code behind it (a library component, or a run that discovered
      // no sources). The endpoint is still published — the manifest is real
      // — but as `false` on the service, so the SaaSBOM no longer renders an
      // unread attack surface identical to a fully-analysed one. Only false
      // is stamped: absence keeps meaning "read", which is every other
      // endpoint, and a positive property on all of them is noise.
      if (endpoint.substantiated === false) {
        appendUniqueProperty(
          definition.properties,
          "cdx:kosi:endpoint:substantiated",
          "false",
        );
      }
      for (const mediaType of endpoint.consumes || []) {
        appendUniqueProperty(
          definition.properties,
          "cdx:kosi:endpoint:consumes",
          mediaType,
        );
      }
      for (const mediaType of endpoint.produces || []) {
        appendUniqueProperty(
          definition.properties,
          "cdx:kosi:endpoint:produces",
          mediaType,
        );
      }
    }
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
function addImportEvidence(
  kosiReport,
  purlAliasMap,
  nameIndex,
  purlLocationMap,
  dataFlowFrames,
) {
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
  addImportEvidence(
    kosiReport,
    purlAliasMap,
    nameIndex,
    purlLocationMap,
    dataFlowFrames,
  );
  addUsageEvidence(
    kosiReport,
    purlAliasMap,
    nameIndex,
    purlLocationMap,
    dataFlowFrames,
  );
  addDataFlowEvidence(
    kosiReport,
    purlAliasMap,
    nameIndex,
    purlLocationMap,
    dataFlowFrames,
    componentPropertiesMap,
  );
  addCryptoEvidence(
    kosiReport,
    purlAliasMap,
    nameIndex,
    cryptoComponentsByRef,
    componentPropertiesMap,
  );
  addSecuritySignalEvidence(
    kosiReport,
    purlAliasMap,
    nameIndex,
    purlLocationMap,
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
    cryptoGeneratePurls: {},
    dataFlowFrames,
    metadataProperties,
    purlLocationMap,
  };
}
