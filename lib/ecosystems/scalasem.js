import { lstatSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";

import { DEBUG_MODE, readEnvironmentVariable } from "../core/activity.js";
import { PROJECT_TYPE_ALIASES } from "../core/env.js";
import {
  getAllFiles,
  getTmpDir,
  safeExistsSync,
  safeMkdtempSync,
  safeRmSync,
  safeSpawnSync,
} from "../core/fs.js";
import { dirNameStr } from "../core/paths.js";
import { reportPluginRunFailure } from "../core/pluginRun.js";
import { parsetoolsFile } from "../inventory/atomUtils.js";
import { getJarClasses } from "../inventory/deps.js";
import {
  parseScalaArtifact,
  scalaCoordinateKey,
  scalaCoordinateOfPurl,
} from "../inventory/scalaCoords.js";
import { parsePkgJson, parsePkgLock } from "./parsers-js.js";

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

  /**
   * Every purl whose jar ships the exact class. A class several artifacts
   * carry (a facade and the library it fronts) is evidence on each of them;
   * which jar served the call at runtime cannot be told from the source.
   *
   * @param {string} symbol Fully qualified class name.
   * @param {string|undefined} platform Platform of the referencing file.
   * @returns {string[]} Owning purls, empty when none holds the class.
   */
  exactOwners(symbol, platform) {
    const candidates =
      this.classPurls.get(symbol) ||
      this.classPurls.get(String(symbol || "").replace(/\$$/, ""));
    if (!candidates?.size) {
      return [];
    }
    if (platform && candidates.size > 1) {
      const filtered = [...candidates].filter(
        (purl) => scalaPurlPlatform(purl) === platform,
      );
      if (filtered.length) {
        return filtered;
      }
    }
    return [...candidates];
  }

  /**
   * The owners a stack is evidence for: every jar holding the exact class,
   * or the single package-prefix owner when no jar lists the class itself.
   */
  lookupAll(symbol, platform) {
    const exact = this.exactOwners(symbol, platform);
    if (exact.length) {
      return exact;
    }
    const single = this.lookup(symbol, platform);
    return single ? [single] : [];
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

// The registry of known algorithm OIDs, shared with the golem converter.
const SCALASEM_CRYPTO_OIDS = JSON.parse(
  readFileSync(join(dirNameStr, "data", "crypto-oid.json"), "utf-8"),
);
const SCALASEM_OID_KEYS = new Map(
  Object.keys(SCALASEM_CRYPTO_OIDS).map((key) => [key.toLowerCase(), key]),
);

// Canonical scalasem algorithm spellings that have no key of their own in the
// OID registry, mapped to the key that names the same algorithm. Everything
// the rules can emit is covered by this table, the key-size dependent AES
// family below, or one of the explicit no-OID sets.
const SCALASEM_OID_ALIASES = {
  HS256: "hmacWithSHA256",
  HS384: "hmacWithSHA384",
  HS512: "hmacWithSHA512",
  HmacSHA1: "hmacWithSHA1",
  HmacSHA224: "hmacWithSHA224",
  HmacSHA256: "hmacWithSHA256",
  HmacSHA384: "hmacWithSHA384",
  HmacSHA512: "hmacWithSHA512",
  ES256: "ecdsaWithSHA256",
  ES384: "ecdsaWithSHA384",
  ES512: "ecdsaWithSHA512",
  RS256: "sha256WithRSAEncryption",
  RS384: "sha384WithRSAEncryption",
  RS512: "sha512WithRSAEncryption",
  PS256: "rsassa-pss",
  PS384: "rsassa-pss",
  PS512: "rsassa-pss",
  SHA1withDSA: "dsaWithSha1",
  SHA1withECDSA: "ecdsaWithSHA1",
  SHA224withECDSA: "ecdsaWithSHA224",
  SHA256withECDSA: "ecdsaWithSHA256",
  SHA384withECDSA: "ecdsaWithSHA384",
  SHA512withECDSA: "ecdsaWithSHA512",
  SHA224withRSA: "sha224WithRSAEncryption",
  SHA256withRSA: "sha256WithRSAEncryption",
  SHA384withRSA: "sha384WithRSAEncryption",
  SHA512withRSA: "sha512WithRSAEncryption",
  MD2withRSA: "md2WithRSAEncryption",
  MD5withRSA: "md5WithRSAEncryption",
  "RSA-OAEP": "id-RSAES-OAEP",
  "RSASSA-PKCS1-v1_5": "rsaSignature",
  "SHA256withRSA/PSS": "rsassa-pss",
  "ChaCha20-Poly1305": "chaCha20Poly1305",
  X448: "curveX448",
  PBKDF2WithHmacSHA1: "PBKDF2",
  PBKDF2WithHmacSHA256: "PBKDF2",
  PBKDF2WithHmacSHA384: "PBKDF2",
  PBKDF2WithHmacSHA512: "PBKDF2",
  PBEWithMD5AndDES: "pbeWithMD5AndDES-CBC",
};

// AES spellings resolve through the key size and mode when both are known,
// and to the generic `aes` key otherwise.
const SCALASEM_AES_MODE_KEYS = {
  ECB: "ECB",
  CBC: "CBC",
  CFB: "CFB",
  OFB: "OFB",
  CTR: "CTR",
  GCM: "GCM",
  CCM: "CCM",
  GMAC: "GMAC",
};
const SCALASEM_AES_NAMES = new Set([
  "AES",
  "AES-CBC",
  "AES-CTR",
  "AES-GCM",
  "AES-KW",
]);

// Names that never resolve to an OID. Protocols, keystores and random
// generators are emitted as their own asset kinds without an OID; the
// algorithms listed here have no registry key and become
// `cdx:scalasem:crypto:*` properties instead of assets.
export const SCALASEM_PROTOCOL_NAMES = new Set([
  "SSL",
  "SSLv3",
  "TLS",
  "TLSv1",
  "TLSv1.1",
  "TLSv1.2",
  "TLSv1.3",
  "DTLSv1.2",
]);
export const SCALASEM_KEYSTORE_NAMES = new Set([
  "JKS",
  "JCEKS",
  "PKCS12",
  "BCFKS",
]);
export const SCALASEM_NO_OID_ALGORITHMS = new Set([
  "Argon2",
  "Argon2d",
  "Argon2i",
  "Argon2id",
  "BLAKE2b-512",
  "BLAKE2s-256",
  "Blowfish",
  "CMAC",
  "Camellia",
  "ChaCha20",
  "DESede",
  "DH",
  "DRBG",
  "EdDSA",
  "EC",
  "ECDH",
  "ECDSA",
  "ECIES",
  "HKDF",
  "HMAC",
  "HmacSHA3-256",
  "HmacSHA3-512",
  "MD2withDSA",
  "MD2withECDSA",
  "MD5withDSA",
  "MD5withECDSA",
  "NativePRNG",
  "NONEwithECDSA",
  "NONEwithRSA",
  "PBEWithHmacSHA256AndAES_128",
  "PBEWithHmacSHA256AndAES_256",
  "PBEWithMD5AndTripleDES",
  "PBEWithSHA1AndDESede",
  "PBEWithSHA1AndRC4_128",
  "Poly1305",
  "RC2",
  "SHA-512/224",
  "SHA-512/256",
  "SHA1PRNG",
  "SHA1withRSA",
  "SHA224withDSA",
  "SHA256withDSA",
  "SHA3-256withECDSA",
  "SHA384withDSA",
  "SHA512withDSA",
  "SM3",
  "SM4",
  "Whirlpool",
  "Windows-PRNG",
  "XDH",
  "bcrypt",
  "none",
  "scrypt",
]);

/**
 * The OID registry key for a canonical scalasem algorithm name, with the key
 * size when the name needs it. Names that have no key return undefined.
 *
 * @param {string} name Canonical algorithm name.
 * @param {number} [keySize] Key size in bits, when the report carries one.
 * @returns {string|undefined} Registry key such as `aes256-GCM`.
 */
const SCALASEM_CURVE_NAMES = new Set(["EC", "ECDH", "ECDSA", "ECIES", "XDH"]);

export function scalasemCryptoOidKey(name, keySize, mode, curve) {
  if (!name) {
    return undefined;
  }
  if (SCALASEM_AES_NAMES.has(name)) {
    const modeKey =
      SCALASEM_AES_MODE_KEYS[mode] ||
      SCALASEM_AES_MODE_KEYS[name.split("-")[1]];
    const wrap = name === "AES-KW" || mode === "KW";
    if (keySize && (modeKey !== undefined || wrap)) {
      const sizedKey = wrap ? `aes${keySize}-wrap` : `aes${keySize}-${modeKey}`;
      const hit = SCALASEM_OID_KEYS.get(sizedKey.toLowerCase());
      if (hit) {
        return hit;
      }
    }
    return SCALASEM_OID_KEYS.get("aes");
  }
  const aliased = SCALASEM_OID_ALIASES[name];
  if (aliased && SCALASEM_OID_KEYS.has(aliased.toLowerCase())) {
    return SCALASEM_OID_KEYS.get(aliased.toLowerCase());
  }
  // A generic curve algorithm names its curve, and the registry holds the
  // curve identifiers (`secp256r1`, `curve25519`).
  if (curve && SCALASEM_CURVE_NAMES.has(name)) {
    const curveKey = SCALASEM_OID_KEYS.get(curve.toLowerCase());
    if (curveKey) {
      return curveKey;
    }
  }
  return SCALASEM_OID_KEYS.get(name.toLowerCase());
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
  const cryptoComponentsByRef = new Map();
  const cryptoGeneratePurls = {};
  attachJoinedNamespaces(joinIndex, components, componentPropertiesMap);
  addUsageEvidence(
    report,
    joinIndex,
    purlLocationMap,
    componentPropertiesMap,
    options,
  );
  addCallStackEvidence(report, joinIndex, dataFlowFrames);
  addCryptoEvidence(
    report,
    components,
    cryptoComponentsByRef,
    cryptoGeneratePurls,
    componentPropertiesMap,
    metadataProperties,
  );
  addJsModuleEvidence(
    report,
    components,
    purlLocationMap,
    componentPropertiesMap,
    metadataProperties,
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
  const mergedStacksByPurl = {};
  for (const stack of report.callStacks || []) {
    const sink = stack.sink;
    if (!sink?.owner) {
      continue;
    }
    const fileEntry = report[sink.file];
    const platform = fileEntry?.platform || (fileEntry?.platforms || [])[0];
    const purls = stackTargetPurls(sink, fileEntry, joinIndex, platform);
    if (!purls.length) {
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
      for (const purl of purls) {
        mergedStacksByPurl[purl] ??= [];
        mergedStacksByPurl[purl].push(...frames);
      }
    }
  }
  // CycloneDX carries a single frame list per component, so the stacks a
  // component collects are published as their deduplicated union: every hop
  // of every stack survives, and the caps the writer already applied bound
  // the size.
  for (const [purl, frames] of Object.entries(mergedStacksByPurl)) {
    dataFlowFrames[purl] = [dedupeByLocation(frames)];
  }
}

/**
 * The components a stack is evidence for: the jars that ship the sink class,
 * plus the libraries called on the sink's own line, which is the terminal hop
 * the sink call came through. The standard library is ambient and never a
 * target.
 */
function stackTargetPurls(sink, fileEntry, joinIndex, platform) {
  const purls = new Set(joinIndex.lookupAll(sink.owner, platform));
  for (const call of fileEntry?.calls || []) {
    if (call.line !== sink.line || !call.owner) {
      continue;
    }
    for (const purl of joinIndex.lookupAll(call.owner, platform)) {
      if (!isStdlibPurl(purl)) {
        purls.add(purl);
      }
    }
  }
  return [...purls];
}

function dedupeByLocation(frames) {
  const seen = new Set();
  const out = [];
  for (const frame of frames) {
    const key = `${frame.fullFilename}#${frame.line || ""}#${frame.column || ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(frame);
  }
  return out;
}

function packageOf(functionName) {
  const text = String(functionName || "");
  const dot = text.lastIndexOf(".");
  return dot > 0 ? text.slice(0, dot) : "";
}

const SCALASEM_CRYPTO_PRIMITIVES = new Set([
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
  "key-wrap",
  "other",
  "unknown",
]);

const SCALASEM_MODES = new Set([
  "cbc",
  "ecb",
  "ccm",
  "gcm",
  "cfb",
  "ofb",
  "ctr",
]);

const SCALASEM_PADDING = {
  nopadding: "raw",
  pkcs5padding: "pkcs5",
  pkcs7padding: "pkcs7",
  pkcs1padding: "pkcs1v15",
  oaepwithsha1andmgf1: "oaep",
  ssl3padding: "other",
  iso10126padding: "other",
};

// The spellings one purl answers to: sbt components carry the encoded purl and
// the decoded bom-ref, and dependency refs use either.
function providerAliases(purl, components = []) {
  if (!purl) {
    return [];
  }
  const component = components.find((candidate) => candidate.purl === purl);
  return component?.["bom-ref"] && component["bom-ref"] !== purl
    ? [component["bom-ref"]]
    : [];
}

/**
 * The component purl of the library a crypto finding names as its provider.
 * Maven coordinates match on group and base artifact; the short aliases cover
 * the providers the rules emit for libraries without a coordinate.
 */
export function scalasemProviderPurl(provider, components = []) {
  if (!provider) {
    return undefined;
  }
  let group;
  let artifactPrefix;
  if (provider === "bcprov") {
    group = "org.bouncycastle";
    artifactPrefix = "bcprov";
  } else if (provider.includes(":")) {
    [group, artifactPrefix] = provider.split(":");
  } else {
    return undefined;
  }
  const base = parseScalaArtifact(artifactPrefix).artifactBase;
  for (const component of components) {
    if (!component?.purl) {
      continue;
    }
    const segments = /^pkg:[^/]+\/(?:([^/@?]+)\/)?([^@?]+)/.exec(
      component.purl,
    );
    if (!segments || decodeSafe(segments[1]) !== group) {
      continue;
    }
    const name = parseScalaArtifact(decodeSafe(segments[2])).artifactBase;
    if (name === base || name.startsWith(`${base}-`)) {
      return component.purl;
    }
  }
  return undefined;
}

function cryptoAssetDisplayName(finding) {
  const parts = [finding.algorithm];
  if (finding.keySize) {
    parts.push(String(finding.keySize));
  }
  if (finding.mode) {
    parts.push(finding.mode);
  }
  return parts.join("-");
}

function cryptoAlgorithmProperties(finding) {
  const properties = {};
  if (finding.primitive) {
    const primitive = finding.primitive === "rng" ? "drbg" : finding.primitive;
    properties.primitive = SCALASEM_CRYPTO_PRIMITIVES.has(primitive)
      ? primitive
      : "other";
  }
  const mode = String(finding.mode || "").toLowerCase();
  if (mode && SCALASEM_MODES.has(mode)) {
    properties.mode = mode;
  }
  const padding = SCALASEM_PADDING[String(finding.padding || "").toLowerCase()];
  if (padding) {
    properties.padding = padding;
  }
  if (finding.keySize) {
    properties.parameterSetIdentifier = String(finding.keySize);
  }
  if (finding.curve) {
    properties.ellipticCurve = finding.curve;
  }
  return properties;
}

function cryptoBomRef(kind, name, oidKey) {
  return `crypto/${kind}/${encodeURIComponent(name)}@${encodeURIComponent(oidKey || name)}`;
}

/**
 * Crypto findings become CycloneDX crypto assets. Algorithms resolve through
 * the OID alias table and are skipped without one, protocols and keystores
 * are their own asset kinds, and everything the registry cannot name becomes
 * a `cdx:scalasem:crypto:*` property on the providing component instead of an
 * asset with an invented identifier.
 */
function addCryptoEvidence(
  report,
  components,
  cryptoComponentsByRef,
  cryptoGeneratePurls,
  componentPropertiesMap,
  metadataProperties,
) {
  const nativeLibraryBySymbol = new Map();
  for (const binding of report.nativeBindings || []) {
    if (binding.library) {
      nativeLibraryBySymbol.set(
        binding.owner + binding.symbol,
        binding.library,
      );
    }
  }
  const assetOccurrencesByRef = new Map();
  for (const finding of report.crypto || []) {
    const location = `${finding.file || ""}#${finding.line || 0}`;
    if (finding.kind?.startsWith("native")) {
      finding.nativeLibrary = nativeLibraryBySymbol.get(finding.name);
    }
    const providerPurl = scalasemProviderPurl(finding.provider, components);
    const asset = cryptoAssetFor(finding);
    if (asset) {
      const existing = cryptoComponentsByRef.get(asset["bom-ref"]) || asset;
      cryptoComponentsByRef.set(asset["bom-ref"], existing);
      const occurrences = assetOccurrencesByRef.get(asset["bom-ref"]) || [];
      if (!occurrences.includes(location)) {
        occurrences.push(location);
      }
      assetOccurrencesByRef.set(asset["bom-ref"], occurrences);
      if (providerPurl) {
        cryptoGeneratePurls[providerPurl] ??= new Set();
        cryptoGeneratePurls[providerPurl].add(asset["bom-ref"]);
        addPropertyValue(
          componentPropertiesMap,
          providerPurl,
          "cdx:scalasem:cryptoAlgorithms",
          finding.algorithm,
        );
      }
      providerAliases(providerPurl, components).forEach((alias) => {
        cryptoGeneratePurls[alias] ??= new Set();
        cryptoGeneratePurls[alias].add(asset["bom-ref"]);
      });
    } else if (finding.algorithm || finding.name) {
      // No registry OID: the finding stays visible as a property.
      const name = finding.algorithm || finding.name;
      const target = providerPurl ? componentPropertiesMap : undefined;
      const value = `${name}@${location}`;
      if (target) {
        addPropertyValue(
          target,
          providerPurl,
          `cdx:scalasem:crypto:${finding.kind}`,
          value,
        );
      } else {
        appendUniqueProperty(
          metadataProperties,
          `cdx:scalasem:crypto:${finding.kind}`,
          value,
        );
      }
    }
  }
  for (const [ref, asset] of cryptoComponentsByRef.entries()) {
    asset.evidence = {
      occurrences: assetOccurrencesByRef
        .get(ref)
        .sort()
        .map((location) => parseLocationString(location)),
    };
  }
}

function parseLocationString(location) {
  const separator = location.lastIndexOf("#");
  const line = Number.parseInt(location.slice(separator + 1), 10);
  return {
    location: location.slice(0, separator),
    ...(Number.isFinite(line) && line > 0 ? { line } : {}),
  };
}

function cryptoAssetFor(finding) {
  const name = finding.algorithm || finding.name;
  if (!name) {
    return undefined;
  }
  if (SCALASEM_PROTOCOL_NAMES.has(name) || finding.kind === "protocol") {
    const version = name.replace(/^TLSv/, "").replace(/^SSLv/, "");
    return {
      type: "cryptographic-asset",
      name,
      "bom-ref": cryptoBomRef("protocol", name),
      description:
        "Cryptographic protocol detected by scalasem source analysis",
      cryptoProperties: {
        assetType: "protocol",
        protocolProperties: {
          type:
            name.startsWith("TLS") || name.startsWith("SSL") ? "tls" : "other",
          ...(version && /^\d/.test(version) ? { version } : {}),
        },
      },
      properties: cryptoAssetProperties(finding),
    };
  }
  if (SCALASEM_KEYSTORE_NAMES.has(name) || finding.kind === "keystore") {
    return {
      type: "cryptographic-asset",
      name,
      "bom-ref": cryptoBomRef("keystore", name),
      description: "Key store detected by scalasem source analysis",
      cryptoProperties: {
        assetType: "related-crypto-material",
        relatedCryptoMaterialProperties: { type: "other" },
      },
      properties: cryptoAssetProperties(finding),
    };
  }
  const oidKey = scalasemCryptoOidKey(
    name,
    finding.keySize,
    finding.mode,
    finding.curve,
  );
  if (!oidKey) {
    return undefined;
  }
  const algorithmProperties = cryptoAlgorithmProperties(finding);
  return {
    type: "cryptographic-asset",
    name: cryptoAssetDisplayName(finding),
    "bom-ref": cryptoBomRef(
      "algorithm",
      cryptoAssetDisplayName(finding),
      oidKey,
    ),
    description: `Cryptographic algorithm detected by scalasem source analysis (${finding.api})`,
    cryptoProperties: {
      assetType: "algorithm",
      oid: SCALASEM_CRYPTO_OIDS[oidKey]?.oid,
      ...(Object.keys(algorithmProperties).length
        ? { algorithmProperties }
        : {}),
    },
    properties: cryptoAssetProperties(finding),
  };
}

function cryptoAssetProperties(finding) {
  const properties = [];
  appendUniqueProperty(
    properties,
    "cdx:scalasem:crypto:resolution",
    finding.resolution,
  );
  appendUniqueProperty(properties, "cdx:scalasem:crypto:api", finding.api);
  appendUniqueProperty(
    properties,
    "cdx:scalasem:crypto:provider",
    finding.provider,
  );
  if (finding.weak) {
    appendUniqueProperty(properties, "cdx:scalasem:crypto:weak", "true");
  }
  if (finding.name && finding.kind.startsWith("native")) {
    appendUniqueProperty(
      properties,
      "cdx:scalasem:crypto:nativeFunction",
      finding.name,
    );
    if (finding.nativeLibrary) {
      appendUniqueProperty(
        properties,
        "cdx:scalasem:crypto:nativeLibrary",
        finding.nativeLibrary,
      );
    }
  }
  if (finding.bits) {
    appendUniqueProperty(
      properties,
      "cdx:scalasem:crypto:gcmTagBits",
      finding.bits,
    );
  }
  return properties;
}

/**
 * The host a service URL names, or the topic and JDBC scheme equivalents, so
 * every outbound service is named after where it talks to rather than the
 * client library it uses.
 */
export function scalasemServiceName(service) {
  if (service?.topic) {
    return scalasemServiceEndpoint(service);
  }
  const value = service?.url || service?.host;
  if (!value) {
    return undefined;
  }
  if (value.startsWith("jdbc:")) {
    const scheme = value.slice(5).split(":", 1)[0] || "jdbc";
    const host = /\/\/([^/?]+)/
      .exec(value)?.[1]
      ?.split("@")
      .pop()
      ?.split(":")[0];
    return [scheme, host].filter(Boolean).join("-");
  }
  if (service?.host) {
    return service.host.split(":")[0];
  }
  try {
    return new URL(value).hostname || undefined;
  } catch (_err) {
    return undefined;
  }
}

/**
 * The endpoint a service row carries, normalized: URLs and hosts as they are,
 * a topic as `client:topic`, a JDBC URL with its credentials and parameters
 * dropped.
 */
export function scalasemServiceEndpoint(service) {
  if (service?.topic) {
    const scheme = service.client || "messaging";
    return `${scheme}:${service.topic}`;
  }
  const value = service?.url || service?.host;
  if (!value) {
    return undefined;
  }
  if (value.startsWith("jdbc:")) {
    // The database name in the path is part of the address.
    return value;
  }
  if (service?.host) {
    return service.host;
  }
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.host}`;
  } catch (_err) {
    const hostMatch = /:\/\/([^/?]+)/.exec(value);
    return hostMatch ? `${hostMatch[0]}` : value;
  }
}

function serviceLocation(service) {
  if (!service?.file) {
    return undefined;
  }
  return service.line ? `${service.file}#${service.line}` : service.file;
}

/**
 * Outbound services: HTTP and websocket clients, data stores, messaging
 * topics and cloud clients. Locations ride in
 * `cdx:scalasem:service:location` properties because CycloneDX services
 * carry no evidence field before 2.0; spec compatibility keeps the
 * occurrences below that only at 2.0.
 *
 * @param {Object} report Parsed scalasem report.
 * @param {Object} servicesMap Map populated with service definitions.
 * @returns {Object} The mutated services map.
 */
export function collectScalasemServices(report = {}, servicesMap = {}) {
  for (const service of report.services || []) {
    const name = scalasemServiceName(service);
    if (!name) {
      continue;
    }
    const definition = (servicesMap[name] ??= {
      name,
      endpoints: new Set(),
      authenticated: undefined,
      xTrustBoundary: true,
      properties: [],
    });
    definition.endpoints ??= new Set();
    definition.properties ??= [];
    const value = scalasemServiceEndpoint(service);
    if (value) {
      definition.endpoints.add(value);
    }
    const location = serviceLocation(service);
    if (location) {
      appendUniqueProperty(
        definition.properties,
        "cdx:scalasem:service:location",
        location,
      );
      definition.evidence ??= { occurrences: [] };
      const known = definition.evidence.occurrences;
      if (!known.some((occurrence) => occurrence.location === location)) {
        known.push(parseLocationString(location));
      }
    }
    appendUniqueProperty(
      definition.properties,
      "cdx:scalasem:service:kind",
      service.kind,
    );
    appendUniqueProperty(
      definition.properties,
      "cdx:scalasem:service:client",
      service.client,
    );
    appendUniqueProperty(
      definition.properties,
      "cdx:scalasem:service:resolution",
      service.resolution,
    );
  }
  return servicesMap;
}

/**
 * Inbound endpoints, one service per route, named the way the OpenAPI reader
 * names its own so the two converge on one entry for the same route.
 *
 * @param {Object} report Parsed scalasem report.
 * @param {Object} servicesMap Map populated with service definitions.
 * @returns {Object} The mutated services map.
 */
export function collectScalasemApiEndpoints(report = {}, servicesMap = {}) {
  for (const endpoint of report.endpoints || []) {
    const path = endpoint?.path;
    const method = String(endpoint.method || "").toUpperCase();
    if (!path || !method) {
      continue;
    }
    const serviceName = `service-${path.replaceAll("/", "")}-${method.toLowerCase()}`;
    const definition = (servicesMap[serviceName] ??= {
      name: serviceName,
      endpoints: new Set(),
      authenticated: undefined,
      xTrustBoundary: undefined,
      properties: [],
    });
    definition.endpoints ??= new Set();
    definition.properties ??= [];
    definition.endpoints.add(path);
    if (endpoint.authenticated === true) {
      definition.authenticated = true;
      definition.xTrustBoundary = true;
    }
    if (endpoint.handler) {
      appendUniqueProperty(
        definition.properties,
        "internal:operationId",
        endpoint.handler,
      );
      appendUniqueProperty(
        definition.properties,
        "cdx:scalasem:endpoint:handler",
        endpoint.handler,
      );
    }
    appendUniqueProperty(
      definition.properties,
      "cdx:service:httpMethod",
      method,
    );
    appendUniqueProperty(
      definition.properties,
      "cdx:scalasem:endpoint:framework",
      endpoint.framework,
    );
    const location = serviceLocation(endpoint);
    if (location) {
      appendUniqueProperty(
        definition.properties,
        "cdx:scalasem:service:location",
        location,
      );
      definition.evidence ??= { occurrences: [] };
      const known = definition.evidence.occurrences;
      if (!known.some((occurrence) => occurrence.location === location)) {
        known.push(parseLocationString(location));
      }
    }
  }
  return servicesMap;
}

/**
 * The npm packages a Scala.js build bundles. scalajs-bundler writes a
 * package.json (and a lock file) under `target`, and ScalablyTyped or a
 * bundler workspace keeps one beside the build. Their npm components join the
 * BOM so the report's JavaScript module imports can be attributed to them.
 *
 * @param {string} src Project directory.
 * @param {Object[]} pkgList Components the build tools reported.
 * @returns {Promise<{components: Object[], roots: string[], dependencies: Object[]}>}
 *   Npm components, the bom-refs of the workspace roots and the lock file's
 *   dependency edges.
 */
export async function collectScalaJsNpmComponents(src, pkgList = []) {
  const isScalaJs = pkgList.some((pkg) => {
    const name = pkg?.name || purlPurlName(pkg?.purl) || "";
    return /_(sjs\d+(?:\.\d+)?)$/.test(name) || name === "scalajs-library";
  });
  if (!isScalaJs) {
    return { components: [], roots: [] };
  }
  const projectDir = resolve(src);
  const seen = new Set();
  const manifestFiles = [];
  const addManifest = (file) => {
    if (file && !seen.has(file)) {
      seen.add(file);
      manifestFiles.push(file);
    }
  };
  for (const file of getAllFiles(
    projectDir,
    "**/scalajs-bundler/**/package.json",
  )) {
    addManifest(file);
  }
  // A workspace kept beside the build: the project's own manifests, not the
  // ones node_modules holds. Two levels cover the usual client/server split.
  for (const file of getAllFiles(projectDir, "*/package.json")) {
    addManifest(file);
  }
  for (const file of getAllFiles(projectDir, "package.json")) {
    addManifest(file);
  }
  const components = [];
  const roots = [];
  const dependencies = [];
  for (const manifest of manifestFiles) {
    const manifestDir = dirname(manifest);
    const parsed = await parsePkgJson(manifest);
    if (parsed?.length) {
      components.push(...parsed);
      roots.push(parsed[0]["bom-ref"]);
    }
    for (const lockName of ["package-lock.json", "npm-shrinkwrap.json"]) {
      const lockFile = join(manifestDir, lockName);
      if (safeExistsSync(lockFile)) {
        const lockData = await parsePkgLock(lockFile);
        components.push(...(lockData?.pkgList || []));
        dependencies.push(...(lockData?.dependenciesList || []));
        break;
      }
    }
  }
  return { components, roots, dependencies };
}

// The package name an npm purl carries, with the scope decoded back to
// `@scope/name`, which is how JavaScript names its modules.
function npmNameFromPurl(purl) {
  const rest = /^pkg:npm\/(.+)$/.exec(purl || "")?.[1];
  if (!rest) {
    return undefined;
  }
  const at = rest.lastIndexOf("@");
  const name = at > 0 ? rest.slice(0, at) : rest;
  try {
    return decodeURIComponent(name);
  } catch (_err) {
    return name;
  }
}

/**
 * Attribute the report's JavaScript module imports to the npm components the
 * build bundles. A module no component owns is reported on the project
 * component instead, so the import stays visible either way.
 */
function addJsModuleEvidence(
  report,
  components,
  purlLocationMap,
  componentPropertiesMap,
  metadataProperties,
) {
  const jsModules = report.jsModules || [];
  if (!jsModules.length) {
    return;
  }
  const npmByName = new Map();
  for (const component of components) {
    const name = npmNameFromPurl(component?.purl);
    if (name) {
      npmByName.set(name, component);
    }
  }
  const moduleMatchesComponent = (moduleName) => {
    if (npmByName.has(moduleName)) {
      return npmByName.get(moduleName);
    }
    // `pkg/subpath` and `@scope/pkg/subpath` belong to the package named by
    // their leading segments.
    const segments = moduleName.split("/");
    const scoped =
      moduleName.startsWith("@") && segments.length > 2
        ? `${segments[0]}/${segments[1]}`
        : segments[0];
    return npmByName.get(scoped);
  };
  const unmatched = new Set();
  const seenLocations = new Set();
  for (const jsModule of jsModules) {
    const moduleName = jsModule.module;
    if (!moduleName || moduleName.startsWith(".") || moduleName.includes("*")) {
      continue;
    }
    const component = moduleMatchesComponent(moduleName);
    const location = jsModule.line
      ? `${jsModule.file}#${jsModule.line}`
      : jsModule.file;
    if (!component) {
      unmatched.add(moduleName);
      continue;
    }
    if (!seenLocations.has(`${component.purl}#${location}`)) {
      seenLocations.add(`${component.purl}#${location}`);
      addSetValue(purlLocationMap, component.purl, location);
    }
    addPropertyValue(
      componentPropertiesMap,
      component.purl,
      "cdx:scalasem:jsModule",
      moduleName,
    );
  }
  if (unmatched.size) {
    appendUniqueProperty(
      metadataProperties,
      "cdx:scalasem:jsModules",
      sortedCsv(unmatched),
    );
  }
}
