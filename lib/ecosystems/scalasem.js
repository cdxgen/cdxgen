import { lstatSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";

import { DEBUG_MODE, readEnvironmentVariable } from "../core/activity.js";
import { PROJECT_TYPE_ALIASES } from "../core/env.js";
import {
  getTmpDir,
  safeExistsSync,
  safeMkdtempSync,
  safeRmSync,
  safeSpawnSync,
} from "../core/fs.js";
import { reportPluginRunFailure } from "../core/pluginRun.js";
import { parsetoolsFile } from "../inventory/atomUtils.js";
import { getJarClasses } from "../inventory/deps.js";
import {
  parseScalaArtifact,
  scalaCoordinateKey,
  scalaCoordinateOfPurl,
} from "../inventory/scalaCoords.js";

/**
 * scalasem — the Scala semantic analyzer shipped inside atom-parsetools. This
 * module is the only place that spawns it, and it owns the projection of the
 * scalasem report (schema scalasem/2) onto CycloneDX evidence. It follows the
 * golem and kosi discipline: a failed run may degrade the Scala evidence but
 * never aborts SBOM generation, and it always says why.
 */

/** Longest wait for a scalasem run. Large repositories degrade, not hang. */
const DEFAULT_TIMEOUT_MS = 20 * 60_000;

export const JDK_OWNER_PREFIXES = ["java.", "javax.", "jdk.", "sun."];

export const SCALA_STDLIB_ARTIFACTS = new Set([
  "scala-library",
  "scala3-library",
  "scala3-library_sjs1",
  "scala3-library_native0.5",
  "scala-library_sjs1",
]);

export function appendUniqueProperty(properties, name, value) {
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

export function addPropertyValue(map, key, name, value) {
  if (!key || value === undefined || value === null || value === "") {
    return;
  }
  map[key] ??= [];
  appendUniqueProperty(map[key], name, value);
}

export function addSetValue(map, key, value) {
  if (!key || !value) {
    return;
  }
  map[key] ??= new Set();
  map[key].add(value);
}

/**
 * True for every project type the Scala path serves, matching the alias list
 * the BOM generators dispatch on.
 *
 * @param {string} language Project language or type.
 * @returns {boolean}
 */
export function isScalasemLanguage(language) {
  return PROJECT_TYPE_ALIASES.scala.includes(
    String(language || "").toLowerCase(),
  );
}

/**
 * True when scalasem is turned off, through CDXGEN_SCALASEM_DISABLE or the
 * --no-scalasem flag carried on the options object. Library code never reads
 * process.argv for this.
 *
 * @param {Object} options CLI options.
 * @returns {boolean}
 */
export function scalasemDisabled(options = {}) {
  const raw = (
    readEnvironmentVariable("CDXGEN_SCALASEM_DISABLE") || ""
  ).toLowerCase();
  return raw === "1" || raw === "true" || raw === "all" || options.noScalasem;
}

/**
 * The scalasem entry point: SCALASEM_CMD wins, then the scalasem.js inside
 * the installed atom-parsetools package.
 *
 * @returns {string|undefined}
 */
export function resolveScalasemCommand() {
  return (
    readEnvironmentVariable("SCALASEM_CMD") || parsetoolsFile("scalasem.js")
  );
}

function scalasemTimeoutMs(options = {}) {
  const raw =
    options.scalasemTimeoutMs ??
    readEnvironmentVariable("CDXGEN_SCALASEM_TIMEOUT");
  const parsed = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

/**
 * Where the scalasem report is persisted. An absolute --semantics-slices-file
 * keeps its directory; anything else lands in the evinse output directory, the
 * same rule the atom slice writer follows.
 *
 * @param {Object} options CLI options carrying `output` and `semanticsSlicesFile`.
 * @returns {string} Absolute report path.
 */
export function scalasemOutputFile(options = {}) {
  const requested = options.semanticsSlicesFile || "semantics.slices.json";
  if (requested === resolve(requested)) {
    return requested;
  }
  let outputDir;
  if (options.output) {
    const resolvedOutput = resolve(options.output);
    let isDir = false;
    try {
      isDir =
        safeExistsSync(resolvedOutput) &&
        lstatSync(resolvedOutput).isDirectory();
    } catch (_err) {
      isDir = false;
    }
    outputDir = isDir ? resolvedOutput : dirname(resolvedOutput);
  } else {
    outputDir = safeMkdtempSync(join(getTmpDir(), "scalasem-"));
  }
  return join(outputDir, basename(requested));
}

function readScalasemReport(reportFile) {
  if (!reportFile || !safeExistsSync(reportFile)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(reportFile, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch (_err) {
    return undefined;
  }
}

function isNewerThan(file, otherFile) {
  try {
    return statSync(file).mtimeMs >= statSync(otherFile).mtimeMs;
  } catch (_err) {
    // Without both timestamps the project checks alone decide.
    return true;
  }
}

/**
 * A version 1 semantics slice (the shape atom's scalasem wrote before schema
 * version 2): keyed by .scala files with `usedTypes`, no `_meta.schemaVersion`.
 *
 * @param {Object} parsed Candidate slice.
 * @returns {boolean}
 */
export function isV1SemanticsSlice(parsed) {
  if (!parsed || parsed._meta?.schemaVersion) {
    return false;
  }
  return Object.keys(parsed).some((key) => key.endsWith(".scala"));
}

function diagnosticCodeFor(result, reportFile) {
  if (result?.error?.code === "ETIMEDOUT") {
    return "scalasem-timeout";
  }
  return safeExistsSync(reportFile) ? "scalasem-failed" : "scalasem-no-report";
}

/**
 * Run scalasem over a Scala project and return its report, reusing a
 * persisted version 2 report that belongs to this project and is newer than
 * the input BOM.
 *
 * Failures are visible rather than silent: the reason is printed once, the
 * run's diagnostics reach the caller as `cdx:scalasem:diagnostic` properties,
 * and --fail-on-error claims the exit status through the shared plugin
 * contract. A version 1 slice found at the output path is returned separately
 * and never overwritten; the fresh report then goes to a temporary file.
 *
 * @param {string} src Project directory.
 * @param {Object} options CLI options.
 * @returns {Object|undefined} `{ report, reportFile, v1Slice, metadataProperties }`,
 *   or undefined when the analyzer is disabled.
 */
export function analyzeScalaProject(src, options = {}) {
  if (scalasemDisabled(options)) {
    console.log(
      "scalasem: disabled; skipping the Scala semantic evidence. Unset CDXGEN_SCALASEM_DISABLE to re-enable it.",
    );
    return undefined;
  }
  const analysisDir = resolve(src);
  const reportFile = scalasemOutputFile(options);
  const existing = readScalasemReport(reportFile);
  if (existing?._meta?.schemaVersion === "scalasem/2") {
    if (
      resolve(existing._meta.projectPath || "") === analysisDir &&
      isNewerThan(reportFile, options.input)
    ) {
      if (DEBUG_MODE) {
        console.log(`Reusing the scalasem report "${reportFile}".`);
      }
      return {
        report: existing,
        reportFile,
        v1Slice: undefined,
        metadataProperties: scalasemMetadataProperties(
          existing,
          existing._meta.diagnostics || [],
        ),
      };
    }
  } else if (existing && isV1SemanticsSlice(existing)) {
    return runScalasem(analysisDir, options, existing);
  }
  return runScalasem(analysisDir, options, undefined);
}

function runScalasem(analysisDir, options, v1Slice) {
  const durable = !v1Slice;
  const tempDir = durable
    ? undefined
    : safeMkdtempSync(join(getTmpDir(), "scalasem-"));
  const reportFile = durable
    ? scalasemOutputFile(options)
    : join(tempDir, "scalasem.slices.json");
  const scalasem = options.scalasemCommand || resolveScalasemCommand();
  if (!scalasem) {
    console.log(
      "scalasem: analyzer not found. Install @appthreat/atom-parsetools or set SCALASEM_CMD; skipping the Scala semantic evidence.",
    );
    if (tempDir) {
      safeRmSync(tempDir, { recursive: true, force: true });
    }
    return {
      report: undefined,
      reportFile: undefined,
      v1Slice,
      metadataProperties: scalasemMetadataProperties(undefined, [
        { code: "scalasem-missing" },
      ]),
    };
  }
  const args = [scalasem, analysisDir, reportFile];
  if (options.installDeps === false) {
    args.push("--no-build");
  }
  if (options.scalasemIncludeTests) {
    args.push("--include-tests");
  }
  if (DEBUG_MODE) {
    console.log("Executing", process.execPath, args.join(" "));
  }
  const startedAt = Date.now();
  const result = safeSpawnSync(process.execPath, args, {
    cwd: analysisDir,
    shell: false,
    timeout: scalasemTimeoutMs(options),
  });
  // A report the run did not write is a previous run's output for some other
  // state of the project; a failed run must not adopt it.
  let wroteReport = false;
  try {
    wroteReport = statSync(reportFile).mtimeMs >= startedAt;
  } catch (_err) {
    wroteReport = false;
  }
  const report = wroteReport ? readScalasemReport(reportFile) : undefined;
  const usable = report?._meta?.schemaVersion === "scalasem/2";
  if (!usable || result?.status !== 0) {
    reportPluginRunFailure({
      tool: "scalasem",
      ecosystem: "scala",
      executable: process.execPath,
      args,
      dir: analysisDir,
      result: usable
        ? { status: result?.status ?? 1 }
        : result || { status: 1 },
      outputFile: reportFile,
      options,
    });
  }
  let diagnostics;
  if (usable) {
    diagnostics = report._meta.diagnostics || [];
  } else if (result?.status === 0) {
    diagnostics = [{ code: "scalasem-no-report" }];
  } else {
    diagnostics = [{ code: diagnosticCodeFor(result, reportFile) }];
  }
  const analysis = {
    report: usable ? report : undefined,
    reportFile: durable ? reportFile : undefined,
    v1Slice,
    metadataProperties: scalasemMetadataProperties(report, diagnostics),
  };
  if (tempDir?.startsWith(getTmpDir())) {
    safeRmSync(tempDir, { recursive: true, force: true });
  }
  return analysis;
}

/**
 * The `cdx:scalasem:*` metadata properties of one run: what produced the
 * report, and what limited it.
 *
 * @param {Object|undefined} report Parsed scalasem report, when one exists.
 * @param {Object[]} diagnostics Run diagnostics, from the report or the spawn.
 * @returns {Object[]} Metadata properties.
 */
export function scalasemMetadataProperties(
  report,
  diagnostics = report?._meta?.diagnostics || [],
) {
  const properties = [];
  const meta = report?._meta || {};
  appendUniqueProperty(
    properties,
    "cdx:scalasem:schemaVersion",
    meta.schemaVersion,
  );
  appendUniqueProperty(
    properties,
    "cdx:scalasem:factsSource",
    sortedCsv(meta.generatedFrom),
  );
  appendUniqueProperty(
    properties,
    "cdx:scalasem:compilerSource",
    sortedCsv((meta.compilers || []).map((compiler) => compiler.source)),
  );
  appendUniqueProperty(
    properties,
    "cdx:scalasem:scalaVersions",
    sortedCsv((meta.compilers || []).map((compiler) => compiler.version)),
  );
  appendUniqueProperty(
    properties,
    "cdx:scalasem:platforms",
    sortedCsv(meta.platforms),
  );
  appendUniqueProperty(
    properties,
    "cdx:scalasem:filesAnalyzed",
    meta.counts?.files,
  );
  if (meta.truncated || diagnostics.length) {
    appendUniqueProperty(properties, "cdx:scalasem:degraded", "true");
  }
  const byCode = {};
  for (const diagnostic of diagnostics) {
    if (!diagnostic?.code) {
      continue;
    }
    byCode[diagnostic.code] =
      (byCode[diagnostic.code] || 0) + (diagnostic.count ?? 1);
  }
  for (const code of Object.keys(byCode).sort()) {
    appendUniqueProperty(
      properties,
      `cdx:scalasem:diagnostic:${code}`,
      byCode[code],
    );
  }
  return properties;
}

export function sortedCsv(values) {
  const items = values instanceof Set ? [...values] : values || [];
  const filtered = [...new Set(items.filter(Boolean))].sort();
  return filtered.length ? filtered.join(",") : undefined;
}

/**
 * The platform a purl's artifact name targets: `_sjs1` is Scala.js,
 * `_native0.x` is Scala Native, and neither is the JVM.
 *
 * @param {string} purl Package URL.
 * @returns {"jvm"|"js"|"native"} Platform key.
 */
export function scalaPurlPlatform(purl) {
  const name = purlPurlName(purl);
  if (!name) {
    return "jvm";
  }
  if (/_(sjs\d+(?:\.\d+)?)$/.test(name)) {
    return "js";
  }
  if (/_(native\d+(?:\.\d+)*)$/.test(name)) {
    return "native";
  }
  return "jvm";
}

function purlPurlName(purl) {
  const match = /pkg:[^/]+\/(?:[^/@?]+\/)?([^/@?]+)/.exec(purl || "");
  if (!match) {
    return undefined;
  }
  try {
    return decodeURIComponent(match[1]);
  } catch (_err) {
    return match[1];
  }
}

/**
 * The class and package index that joins scalasem symbols to component purls.
 *
 * Symbols are indexed from three sources in priority order: the classpath the
 * report recorded (1), the `internal:Namespaces` properties of the components
 * (2), and the jar namespace map cdxgen writes beside the BOM (3). A symbol a
 * earlier source already attributed is never re-attributed by a later one.
 */
export class ScalaJoinIndex {
  constructor() {
    this.classPurls = new Map();
    this.sourceBySymbol = new Map();
    this.purlsBySource = new Map();
    this.namespacesByPurl = new Map();
  }

  hasNamespaces(purl) {
    return (this.purlsBySource.get(purl) || 0) > 0;
  }

  /**
   * Index the classes of one library. A class name registers itself and every
   * package prefix it sits in, so package references join too.
   *
   * @param {string} purl The owning component purl.
   * @param {string[]} names Class names from the jar or the namespace property.
   * @param {number} source The source priority, 1 to 3.
   */
  addNamespaces(purl, names, source) {
    if (!purl || this.purlsBySource.get(purl) === source) {
      return;
    }
    if ((this.purlsBySource.get(purl) || 0) > 0) {
      // A higher-priority source already indexed this purl's classes.
      return;
    }
    this.purlsBySource.set(purl, source);
    this.namespacesByPurl.set(purl, []);
    for (const name of names || []) {
      const symbol = String(name || "").trim();
      if (!symbol || symbol.includes(" ") || symbol.includes("/")) {
        continue;
      }
      this.addSymbol(symbol, purl, source);
      this.namespacesByPurl.get(purl).push(symbol);
      const dollar = symbol.indexOf("$");
      if (dollar > 0) {
        this.addSymbol(symbol.slice(0, dollar), purl, source);
      }
      const parts = symbol.split(".");
      for (let i = 1; i < parts.length; i++) {
        this.addSymbol(parts.slice(0, i).join("."), purl, source);
      }
    }
  }

  addSymbol(symbol, purl, source) {
    const existing = this.sourceBySymbol.get(symbol);
    if (existing !== undefined) {
      // A higher-priority source (lower number) already attributed it.
      if (existing < source) {
        return;
      }
      // This source outranks whatever attributed it before: replace.
      if (existing > source) {
        this.classPurls.set(symbol, new Set());
      }
    }
    this.sourceBySymbol.set(symbol, source);
    this.addTo(this.classPurls, symbol, purl);
  }

  addTo(map, key, purl) {
    if (!map.has(key)) {
      map.set(key, new Set());
    }
    map.get(key).add(purl);
  }

  /**
   * The purl owning a symbol: the exact class first, then the longest package
   * prefix with a single owner. Several owners of one class mean the same
   * library is present for several platforms; the platform of the referencing
   * file picks the right one, and the JVM wins a tie.
   *
   * @param {string} symbol Fully qualified symbol from the report.
   * @param {string|undefined} platform Platform of the referencing file.
   * @returns {string|undefined} Component purl.
   */
  lookup(symbol, platform) {
    if (!symbol) {
      return undefined;
    }
    let candidates = this.classPurls.get(symbol);
    if (!candidates?.size) {
      const plain = symbol.replace(/\$$/, "");
      candidates = this.classPurls.get(plain);
    }
    if (!candidates?.size) {
      const parts = symbol.split(".");
      for (let i = parts.length - 1; i > 0; i--) {
        const owners = this.classPurls.get(parts.slice(0, i).join("."));
        if (owners?.size === 1) {
          candidates = owners;
          break;
        }
      }
    }
    return this.pick(candidates, platform);
  }

  pick(candidates, platform) {
    if (!candidates?.size) {
      return undefined;
    }
    if (candidates.size > 1 && platform) {
      const filtered = [...candidates].filter(
        (purl) => scalaPurlPlatform(purl) === platform,
      );
      if (filtered.length === 1) {
        return filtered[0];
      }
      if (filtered.length > 1) {
        candidates = new Set(filtered);
      }
    }
    if (candidates.size === 1) {
      return [...candidates][0];
    }
    const jvm = [...candidates].filter(
      (purl) => scalaPurlPlatform(purl) === "jvm",
    );
    return jvm.length === 1 ? jvm[0] : undefined;
  }
}

function decodeSafe(value) {
  if (!value) {
    return "";
  }
  try {
    return decodeURIComponent(value);
  } catch (_err) {
    return value;
  }
}

/**
 * Index the BOM components by their normalized Scala coordinates, both with
 * and without the version, so a classpath jar, a namespace property and a map
 * entry of the same library meet on one component.
 */
export function componentCoordinateIndex(components = []) {
  const byVersion = new Map();
  const withoutVersion = new Map();
  for (const component of components) {
    const coordinate = scalaCoordinateOfPurl(component?.purl);
    if (!coordinate) {
      continue;
    }
    byVersion.set(coordinate.key, component);
    const key = scalaCoordinateKey({
      group: coordinate.key.split(":")[1],
      artifactBase: coordinate.key.split(":")[2],
      platformSuffix: coordinate.key.split(":")[3],
    });
    if (!withoutVersion.has(key)) {
      withoutVersion.set(key, new Set());
    }
    withoutVersion.get(key).add(component);
  }
  return { byVersion, withoutVersion };
}

/**
 * The component a report classpath entry belongs to. Coordinates are
 * normalized (`upickle_sjs1_3` and the purl name `upickle_sjs1` share a key),
 * the entry's version wins, and a versionless match must have a single owner.
 * A jar the BOM does not hold matches nothing: no component is invented.
 */
export function matchClasspathEntry(
  entry,
  { byVersion, withoutVersion },
  platform,
) {
  const parsed = parseScalaArtifact(entry?.artifact);
  const versionKey = scalaCoordinateKey({
    group: entry?.group,
    artifactBase: parsed.artifactBase,
    platformSuffix: parsed.platformSuffix,
    version: entry?.version,
  });
  const exact = byVersion.get(versionKey);
  if (exact) {
    return exact;
  }
  const key = scalaCoordinateKey({
    group: entry?.group,
    artifactBase: parsed.artifactBase,
    platformSuffix: parsed.platformSuffix,
  });
  const candidates = withoutVersion.get(key);
  if (!candidates?.size) {
    return undefined;
  }
  const matching = [...candidates].filter(
    (component) => scalaPurlPlatform(component.purl) === platform,
  );
  const pool = matching.length ? matching : [...candidates];
  return pool.length === 1 ? pool[0] : undefined;
}

/**
 * Build the symbol index from the three sources, reading the report's
 * classpath jars for the components that carry no namespaces yet.
 *
 * @param {Object} report Parsed scalasem report.
 * @param {Object[]} components BOM components.
 * @param {Object} jarNSMapping The jar namespace map cdxgen writes beside the BOM.
 * @returns {Promise<ScalaJoinIndex>}
 */
export async function buildScalaJoinIndex(report, components, jarNSMapping) {
  const index = new ScalaJoinIndex();
  const coordinateIndex = componentCoordinateIndex(components);
  const purlsWithNamespaces = new Set(
    components
      .filter((component) =>
        (component.properties || []).some(
          (property) => property.name === "internal:Namespaces",
        ),
      )
      .map((component) => component.purl),
  );
  for (const module of report.modules || []) {
    for (const entry of module.classpath || []) {
      const parsed = parseScalaArtifact(entry.artifact);
      if (SCALA_STDLIB_ARTIFACTS.has(parsed.artifactBase)) {
        continue;
      }
      const matched = matchClasspathEntry(
        entry,
        coordinateIndex,
        module.platform,
      );
      if (!matched || purlsWithNamespaces.has(matched.purl)) {
        continue;
      }
      if (!entry.path || !safeExistsSync(entry.path)) {
        continue;
      }
      let classes = [];
      try {
        classes = await getJarClasses(entry.path);
      } catch (_err) {
        classes = [];
      }
      if (classes.length) {
        index.addNamespaces(matched.purl, classes, 1);
      }
    }
  }
  for (const component of components) {
    if (purlsWithNamespaces.has(component.purl)) {
      const namespaces = (component.properties || [])
        .filter((property) => property.name === "internal:Namespaces")
        .flatMap((property) => (property.value || "").split("\n"));
      index.addNamespaces(component.purl, namespaces, 2);
    }
  }
  for (const mapPurl of Object.keys(jarNSMapping || {})) {
    const entry = jarNSMapping[mapPurl] || {};
    if (!Array.isArray(entry.namespaces) || !entry.namespaces.length) {
      continue;
    }
    const segments = /^pkg:[^/]+\/(?:([^/@?]+)\/)?([^@?]+)@([^?#]*)/.exec(
      mapPurl,
    );
    if (!segments) {
      continue;
    }
    const matched = matchClasspathEntry(
      {
        group: decodeSafe(segments[1]),
        artifact: decodeSafe(segments[2]),
        version: decodeSafe(segments[3]),
      },
      coordinateIndex,
      scalaPurlPlatform(mapPurl),
    );
    if (matched) {
      index.addNamespaces(matched.purl, entry.namespaces, 3);
    }
  }
  return index;
}

function maxOccurrences() {
  const parsed = Number.parseInt(
    String(readEnvironmentVariable("CDXGEN_SCALASEM_MAX_OCCURRENCES") ?? ""),
    10,
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 200;
}

function isStdlibPurl(purl) {
  return SCALA_STDLIB_ARTIFACTS.has(
    parseScalaArtifact(purlPurlName(purl) || "").artifactBase,
  );
}

/**
 * Project a scalasem report onto CycloneDX evidence: occurrences for the
 * joined components, call stacks for the library sinks, namespaces for the
 * components the classpath join read, and the run's metadata properties.
 *
 * @param {Object} report Parsed scalasem report.
 * @param {Object[]} components BOM components.
 * @param {Object} options CLI options; `scalaNamespaceMap` carries the jar
 *   namespace map cdxgen wrote beside the BOM.
 * @returns {Promise<Object>} The evidence maps `createEvinseFile` consumes.
 */
export async function collectScalasemEvidence(
  report = {},
  components = [],
  options = {},
) {
  const joinIndex = await buildScalaJoinIndex(
    report,
    components,
    options.scalaNamespaceMap || {},
  );
  const purlLocationMap = {};
  const componentPropertiesMap = {};
  const dataFlowFrames = {};
  const metadataProperties = scalasemMetadataProperties(report);
  attachJoinedNamespaces(joinIndex, components, componentPropertiesMap);
  addUsageEvidence(
    report,
    joinIndex,
    purlLocationMap,
    componentPropertiesMap,
    options,
  );
  addCallStackEvidence(report, joinIndex, dataFlowFrames);
  return {
    componentPropertiesMap,
    cryptoComponents: [],
    cryptoGeneratePurls: {},
    dataFlowFrames,
    joinIndex,
    metadataProperties,
    purlLocationMap,
  };
}

/**
 * Publish the namespaces the classpath join read as `internal:Namespaces`
 * properties, the same property the deep Maven flow attaches, so components
 * from builds that report no namespaces gain them here.
 */
function attachJoinedNamespaces(joinIndex, components, componentPropertiesMap) {
  const known = new Set(
    components
      .filter((component) =>
        (component.properties || []).some(
          (property) => property.name === "internal:Namespaces",
        ),
      )
      .map((component) => component.purl),
  );
  for (const [purl, source] of joinIndex.purlsBySource.entries()) {
    if (source === 2 || known.has(purl)) {
      continue;
    }
    const namespaces = joinIndex.namespacesByPurl.get(purl) || [];
    if (namespaces.length) {
      componentPropertiesMap[purl] ??= [];
      appendUniqueProperty(
        componentPropertiesMap[purl],
        "internal:Namespaces",
        namespaces.join("\n"),
      );
    }
  }
}

/**
 * Occurrences from the report's references and calls: every symbol and call
 * owner joined to a component records its source location. Test sources count
 * only when they were asked for, the Scala standard library is capped at one
 * occurrence per file, and each component keeps at most a bounded number of
 * locations.
 */
function addUsageEvidence(
  report,
  joinIndex,
  purlLocationMap,
  componentPropertiesMap,
  options,
) {
  const includeTests = options.scalasemIncludeTests === true;
  const cap = maxOccurrences();
  const scopesByPurl = {};
  const platformsByPurl = {};
  const callSitesByPurl = {};
  const stdlibFilesByPurl = {};
  const addOccurrence = (purl, file, line, kind) => {
    if (!purl || !line) {
      return;
    }
    if (isStdlibPurl(purl)) {
      stdlibFilesByPurl[purl] ??= new Set();
      if (stdlibFilesByPurl[purl].has(file)) {
        return;
      }
      stdlibFilesByPurl[purl].add(file);
    }
    const locations = (purlLocationMap[purl] ??= new Set());
    if (locations.size >= cap) {
      return;
    }
    locations.add(`${file}#${line}`);
    if (kind === "call") {
      callSitesByPurl[purl] = (callSitesByPurl[purl] || 0) + 1;
    }
  };
  for (const [fileKey, fileEntry] of Object.entries(report)) {
    if (
      !fileKey.endsWith(".scala") ||
      !fileEntry ||
      typeof fileEntry !== "object"
    ) {
      continue;
    }
    if (fileEntry.scope === "test" && !includeTests) {
      continue;
    }
    const platform = fileEntry.platform || (fileEntry.platforms || [])[0];
    const scope = fileEntry.scope === "test" ? "test" : "main";
    for (const reference of fileEntry.references || []) {
      const purl = joinIndex.lookup(reference.symbol, platform);
      if (purl) {
        scopesByPurl[purl] ??= new Set();
        scopesByPurl[purl].add(scope);
        if (platform) {
          platformsByPurl[purl] ??= new Set();
          platformsByPurl[purl].add(platform);
        }
      }
      addOccurrence(purl, fileKey, reference.line, "reference");
    }
    for (const call of fileEntry.calls || []) {
      const purl = joinIndex.lookup(call.owner, platform);
      if (purl) {
        scopesByPurl[purl] ??= new Set();
        scopesByPurl[purl].add(scope);
        if (platform) {
          platformsByPurl[purl] ??= new Set();
          platformsByPurl[purl].add(platform);
        }
      }
      addOccurrence(purl, fileKey, call.line, "call");
    }
  }
  for (const purl of Object.keys(scopesByPurl)) {
    addPropertyValue(
      componentPropertiesMap,
      purl,
      "cdx:scalasem:usageScopes",
      sortedCsv(scopesByPurl[purl]),
    );
    addPropertyValue(
      componentPropertiesMap,
      purl,
      "cdx:scalasem:platforms",
      sortedCsv(platformsByPurl[purl]),
    );
    if (callSitesByPurl[purl]) {
      addPropertyValue(
        componentPropertiesMap,
        purl,
        "cdx:scalasem:callSites",
        callSitesByPurl[purl],
      );
    }
  }
}

/**
 * Call stacks: one frame list per stack, keyed by the purl of the library the
 * stack ends in. The entry point comes first and the library call last, and
 * the sink hop is kept even when the report's frames stop one short.
 */
function addCallStackEvidence(report, joinIndex, dataFlowFrames) {
  for (const stack of report.callStacks || []) {
    const sink = stack.sink;
    if (!sink?.owner) {
      continue;
    }
    const fileEntry = report[sink.file];
    const platform = fileEntry?.platform || (fileEntry?.platforms || [])[0];
    const purl = joinIndex.lookup(sink.owner, platform);
    if (!purl) {
      continue;
    }
    const frames = (stack.frames || [])
      .filter((frame) => frame?.file)
      .map((frame) => ({
        package: packageOf(frame.function),
        module: "",
        function: frame.function || "",
        line: frame.line || undefined,
        column: frame.column || undefined,
        fullFilename: frame.file,
      }));
    const sinkCovered = frames.some(
      (frame) => frame.fullFilename === sink.file && frame.line === sink.line,
    );
    if (!sinkCovered) {
      frames.push({
        package: packageOf(sink.owner),
        module: "",
        function: `${sink.owner}.${sink.name}`,
        line: sink.line,
        column: undefined,
        fullFilename: sink.file,
      });
    }
    if (frames.length) {
      dataFlowFrames[purl] ??= [];
      dataFlowFrames[purl].push(frames);
    }
  }
}

function packageOf(functionName) {
  const text = String(functionName || "");
  const dot = text.lastIndexOf(".");
  return dot > 0 ? text.slice(0, dot) : "";
}