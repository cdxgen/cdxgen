import { lstatSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import process from "node:process";

import { DEBUG_MODE, readEnvironmentVariable } from "../core/activity.js";
import { deferFailOnError } from "../core/deferredExit.js";
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
import { resolvePluginSourceDir } from "../core/pluginRun.js";
import { formatDuration } from "../core/processTree.js";
import { parsetoolsFile } from "../inventory/atomUtils.js";
import { applyAlgorithmProperties } from "../inventory/cryptoAlgorithmFamily.js";
import { getJarClasses } from "../inventory/deps.js";
import {
  parseScalaArtifact,
  scalaCoordinateKey,
  scalaCoordinateOfPurl,
} from "../inventory/scalaCoords.js";
import { parsePkgLock } from "./parsers-js.js";

/**
 * scalasem is the Scala semantic analyzer shipped inside atom-parsetools. This
 * module is the only place that spawns it, and it owns the projection of the
 * scalasem report (schema scalasem/2) onto CycloneDX evidence. It follows the
 * golem and kosi discipline: a failed run may degrade the Scala evidence but
 * never aborts SBOM generation, and it always says why.
 */

/** Longest wait for a scalasem run. Large repositories degrade, not hang. */
const DEFAULT_TIMEOUT_MS = 20 * 60_000;

/** Occurrences kept per component unless CDXGEN_SCALASEM_MAX_OCCURRENCES says otherwise. */
const DEFAULT_MAX_OCCURRENCES = 200;

// The JDK ships these packages and no component stands for it. `javax.` is
// split between the JDK and libraries (`javax.servlet`, `javax.inject`), so a
// `javax.` symbol joins a library only through a class the library ships.
export const JDK_OWNER_PREFIXES = ["java.", "jdk.", "sun."];
const JDK_EXTENSION_PREFIX = "javax.";

// The language runtimes every module carries, on each platform. Their
// occurrences are capped at one per file: they say a file is Scala, not that
// it uses a library.
export const SCALA_STDLIB_ARTIFACTS = new Set([
  "auxlib",
  "javalib",
  "nativelib",
  "scala-library",
  "scala3-library",
  "scalajs-library",
  "scalalib",
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
 * --no-scalasem flag, which yargs carries as `scalasem: false`. Library code never reads
 * process.argv for this.
 *
 * @param {Object} options CLI options.
 * @returns {boolean}
 */
export function scalasemDisabled(options = {}) {
  const raw = (
    readEnvironmentVariable("CDXGEN_SCALASEM_DISABLE") || ""
  ).toLowerCase();
  return (
    raw === "1" || raw === "true" || raw === "all" || options.scalasem === false
  );
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

// Time scalasem gets to stop its builds and itself after its own limit,
// before cdxgen stops it.
const TIMEOUT_GRACE_MS = 30_000;

// The build files that identify a Scala project, for a source argument that
// names the working directory relative to itself.
const SCALA_BUILD_MARKERS = [
  "build.sbt",
  "build.sc",
  "build.mill",
  "pom.xml",
  "project.scala",
];

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

/**
 * Whether a version 1 slice describes this project: it names no project, so
 * every source file it lists must exist under the project directory.
 */
function isV1SliceOfProject(slice, projectDir) {
  const files = Object.keys(slice).filter((key) => key.endsWith(".scala"));
  return (
    files.length > 0 &&
    files.every((file) => {
      const path = resolve(projectDir, file);
      return path.startsWith(`${projectDir}${sep}`) && safeExistsSync(path);
    })
  );
}

/**
 * Run scalasem over a Scala project and return its report, reusing a
 * persisted version 2 report that belongs to this project and is newer than
 * the input BOM.
 *
 * Failures are visible rather than silent: the reason is printed once, the
 * run's diagnostics reach the caller as `cdx:scalasem:diagnostic` properties,
 * and --fail-on-error claims the exit status. A version 1 slice of this
 * project, at the path the user named or at the report path, is returned
 * separately and never overwritten; the fresh report then goes to a
 * temporary file.
 *
 * @param {string} src Project directory.
 * @param {Object} options CLI options.
 * @returns {Object|undefined} `{ report, reportFile, v1Slice, metadataProperties }`,
 *   or undefined when the analyzer is disabled.
 */
export function analyzeScalaProject(src, options = {}) {
  if (scalasemDisabled(options)) {
    console.log(
      "scalasem: disabled; skipping the Scala semantic evidence. Unset CDXGEN_SCALASEM_DISABLE or drop --no-scalasem to re-enable it.",
    );
    return undefined;
  }
  const analysisDir = resolvePluginSourceDir(src, SCALA_BUILD_MARKERS);
  const reportFile = scalasemOutputFile(options);
  const candidates = [
    ...new Set(
      [
        options.semanticsSlicesFile
          ? resolve(options.semanticsSlicesFile)
          : undefined,
        reportFile,
      ].filter(Boolean),
    ),
  ];
  let v1Slice;
  let v1File;
  for (const candidate of candidates) {
    const existing = readScalasemReport(candidate);
    if (existing?._meta?.schemaVersion === "scalasem/2") {
      if (
        resolve(existing._meta.projectPath || "") === analysisDir &&
        isNewerThan(candidate, options.input)
      ) {
        if (DEBUG_MODE) {
          console.log(`Reusing the scalasem report "${candidate}".`);
        }
        return {
          report: existing,
          reportFile: candidate,
          v1Slice: undefined,
          metadataProperties: scalasemMetadataProperties(existing),
        };
      }
    } else if (
      !v1Slice &&
      isV1SemanticsSlice(existing) &&
      isV1SliceOfProject(existing, analysisDir)
    ) {
      v1Slice = existing;
      v1File = candidate;
    }
  }
  return runScalasem(analysisDir, options, reportFile, v1Slice, v1File);
}

function scalasemRunFailure(code, message, options, args, status) {
  console.warn(`scalasem: ${message}`);
  deferFailOnError(options, {
    ecosystem: "scala",
    tool: "scalasem",
    detail: message,
    exitCode: typeof status === "number" ? status : undefined,
    command: `${process.execPath} ${args.join(" ")}`,
  });
  return [{ code }];
}

function runScalasem(analysisDir, options, requestedFile, v1Slice, v1File) {
  // A version 1 slice at the report path stays as the user left it.
  const tempDir =
    v1File === requestedFile
      ? safeMkdtempSync(join(getTmpDir(), "scalasem-"))
      : undefined;
  const reportFile = tempDir
    ? join(tempDir, "scalasem.slices.json")
    : requestedFile;
  const durable = !tempDir;
  const scalasem = options.scalasemCommand || resolveScalasemCommand();
  if (!scalasem) {
    const diagnostics = scalasemRunFailure(
      "scalasem-missing",
      "analyzer not found, so the BOM carries no Scala semantic evidence. Install @appthreat/atom-parsetools or set SCALASEM_CMD.",
      options,
      [],
    );
    if (tempDir) {
      safeRmSync(tempDir, { recursive: true, force: true });
    }
    return {
      report: undefined,
      reportFile: undefined,
      v1Slice,
      metadataProperties: scalasemMetadataProperties(undefined, diagnostics),
    };
  }
  const args = [scalasem, analysisDir, reportFile];
  if (options.installDeps === false) {
    args.push("--no-build");
  }
  if (options.scalasemIncludeTests && !options.requiredOnly) {
    args.push("--include-tests");
  }
  if (DEBUG_MODE) {
    console.log("Executing", process.execPath, args.join(" "));
  }
  const timeoutMs = scalasemTimeoutMs(options);
  const startedAt = Date.now();
  // scalasem enforces the limit itself, so the builds it started stop with
  // it; cdxgen's own timeout is the backstop. Naming cdxgen as the supervisor
  // stops scalasem when cdxgen is killed.
  const result = safeSpawnSync(process.execPath, args, {
    cwd: analysisDir,
    shell: false,
    killSignal: "SIGKILL",
    timeout: timeoutMs + Math.min(TIMEOUT_GRACE_MS, timeoutMs),
    env: {
      ...process.env,
      ATOM_PARENT_PID: String(process.pid),
      SCALASEM_TIMEOUT: String(timeoutMs),
    },
  });
  const elapsedMs = Date.now() - startedAt;
  // A report the run did not write is a previous run's output for some other
  // state of the project; a failed run must not adopt it.
  let wroteReport = false;
  try {
    wroteReport = statSync(reportFile).mtimeMs >= startedAt;
  } catch (_err) {
    wroteReport = false;
  }
  const written = wroteReport ? readScalasemReport(reportFile) : undefined;
  const usable = written?._meta?.schemaVersion === "scalasem/2";
  const report = usable ? written : undefined;
  // scalasem stops itself at the limit and exits with an error and no
  // report; cdxgen's own timeout is only the backstop. A run that ends without
  // a usable report once the limit has passed overran it, however it exited.
  const timedOut =
    result?.error?.code === "ETIMEDOUT" || (!usable && elapsedMs >= timeoutMs);
  let diagnostics;
  if (timedOut) {
    diagnostics = scalasemRunFailure(
      "scalasem-timeout",
      `did not finish within ${formatDuration(timeoutMs)} and was stopped, so the BOM carries no Scala semantic evidence. Allow more time with CDXGEN_SCALASEM_TIMEOUT (milliseconds).`,
      options,
      args,
    );
  } else if (result?.error) {
    diagnostics = scalasemRunFailure(
      "scalasem-not-runnable",
      `could not be started (${result.error.message}). Check SCALASEM_CMD or the atom-parsetools install.`,
      options,
      args,
    );
  } else if (!wroteReport) {
    diagnostics = scalasemRunFailure(
      "scalasem-no-report",
      `wrote no report for ${analysisDir} (exit status ${result?.status ?? "unknown"}); run with CDXGEN_DEBUG_MODE=debug to see its output.`,
      options,
      args,
      result?.status,
    );
  } else if (!written) {
    diagnostics = scalasemRunFailure(
      "scalasem-invalid-report",
      `wrote a report that is not valid JSON: ${reportFile}`,
      options,
      args,
      result?.status,
    );
  } else if (!usable) {
    diagnostics = scalasemRunFailure(
      "scalasem-old-report",
      "wrote a version 1 report. Scala evidence needs atom-parsetools 1.10.0 or later.",
      options,
      args,
      result?.status,
    );
  } else {
    diagnostics = report._meta.diagnostics || [];
    if (result?.status !== 0) {
      diagnostics = [
        ...diagnostics,
        ...scalasemRunFailure(
          "scalasem-exit-status",
          `exited with status ${result?.status}; its report is used, and may be incomplete.`,
          options,
          args,
          result?.status,
        ),
      ];
    }
    const summary = summarizeDiagnostics(report._meta.diagnostics);
    if (summary) {
      console.warn(
        `scalasem: the report is degraded: ${summary}. The cdx:scalasem:diagnostic:* metadata properties of the BOM say where.`,
      );
    }
  }
  if (DEBUG_MODE && !usable && (result?.stdout || result?.stderr)) {
    console.log(result.stdout, result.stderr);
  }
  const analysis = {
    report,
    reportFile: durable && usable ? reportFile : undefined,
    v1Slice,
    metadataProperties: scalasemMetadataProperties(report, diagnostics),
  };
  if (tempDir) {
    safeRmSync(tempDir, { recursive: true, force: true });
  }
  return analysis;
}

function summarizeDiagnostics(diagnostics = []) {
  const byCode = new Map();
  for (const diagnostic of diagnostics || []) {
    if (diagnostic?.code) {
      byCode.set(
        diagnostic.code,
        (byCode.get(diagnostic.code) || 0) + (diagnostic.count ?? 1),
      );
    }
  }
  return [...byCode.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([code, count]) => `${code} (${count})`)
    .join(", ");
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
 * (2), and the jar namespace map cdxgen writes beside the BOM (3). A symbol an
 * earlier source already attributed is never re-attributed by a later one.
 *
 * A jar answers for the classes it ships and for the packages it ships classes
 * in directly, never for the parents of those packages: a library with one
 * class under `scala.collection.compat` owns neither `scala.collection` nor
 * `scala`. The JDK has no component, and neither do the project's own classes.
 */
export class ScalaJoinIndex {
  constructor() {
    this.classPurls = new Map();
    this.packagePurls = new Map();
    this.sourceBySymbol = new Map();
    this.purlsBySource = new Map();
    this.namespacesByPurl = new Map();
    this.projectClasses = new Set();
    this.projectPackages = new Set();
  }

  hasNamespaces(purl) {
    return (this.purlsBySource.get(purl) || 0) > 0;
  }

  /**
   * Index the classes of one library: each class under its dotted name (a
   * nested `Outer$Inner` also as `Outer.Inner`, an object `Foo$` as `Foo`),
   * and the package each one sits in.
   *
   * @param {string} purl The owning component purl.
   * @param {string[]} names Class names from the jar or the namespace property.
   * @param {number} source The source priority, 1 to 3.
   */
  addNamespaces(purl, names, source) {
    if (!purl || this.hasNamespaces(purl)) {
      return;
    }
    this.purlsBySource.set(purl, source);
    const indexed = [];
    this.namespacesByPurl.set(purl, indexed);
    for (const name of names || []) {
      const symbol = String(name || "").trim();
      if (!symbol || symbol.includes(" ") || symbol.includes("/")) {
        continue;
      }
      indexed.push(symbol);
      const dollar = symbol.indexOf("$");
      const topLevel = dollar > 0 ? symbol.slice(0, dollar) : symbol;
      this.addSymbol(this.classPurls, topLevel, purl, source);
      if (dollar > 0) {
        const nested = symbol.replaceAll("$", ".").replace(/\.+$/, "");
        if (nested !== topLevel) {
          this.addSymbol(this.classPurls, nested, purl, source);
        }
      }
      const lastDot = topLevel.lastIndexOf(".");
      if (lastDot > 0) {
        this.addSymbol(
          this.packagePurls,
          topLevel.slice(0, lastDot),
          purl,
          source,
        );
      }
    }
  }

  addSymbol(map, symbol, purl, source) {
    const key = `${map === this.classPurls ? "c" : "p"}:${symbol}`;
    const existing = this.sourceBySymbol.get(key);
    if (existing !== undefined && existing < source) {
      // A higher-priority source (lower number) already attributed it.
      return;
    }
    if (existing !== undefined && existing > source) {
      map.set(symbol, new Set());
    }
    this.sourceBySymbol.set(key, source);
    if (!map.has(symbol)) {
      map.set(symbol, new Set());
    }
    map.get(symbol).add(purl);
  }

  /**
   * Record the classes the project defines, so that references to them, and
   * to packages only the project fills, never join a library.
   *
   * @param {Object} report Parsed scalasem report.
   */
  addProjectDefinitions(report) {
    for (const [fileKey, fileEntry] of Object.entries(report || {})) {
      if (!isReportFileKey(fileKey) || !Array.isArray(fileEntry?.definitions)) {
        continue;
      }
      for (const definition of fileEntry.definitions) {
        if (
          !["class", "object", "trait", "enum"].includes(definition?.kind) ||
          !definition.owner ||
          !definition.name
        ) {
          continue;
        }
        this.projectClasses.add(`${definition.owner}.${definition.name}`);
        this.projectPackages.add(definition.owner);
      }
    }
  }

  /**
   * Whether a symbol belongs to code the BOM has no component for: the JDK,
   * or the project itself.
   */
  isUnowned(symbol) {
    if (JDK_OWNER_PREFIXES.some((prefix) => symbol.startsWith(prefix))) {
      return true;
    }
    const parts = symbol.replace(/\$+$/, "").split(".");
    for (let i = parts.length; i > 1; i--) {
      if (this.projectClasses.has(parts.slice(0, i).join("."))) {
        return true;
      }
    }
    return false;
  }

  /**
   * The libraries that ship the class a symbol names: the longest dotted
   * prefix of the symbol that is a class name, for a member or a nested type.
   */
  classOwners(symbol) {
    const parts = symbol.replace(/\$+$/, "").split(".");
    for (let i = parts.length; i > 0; i--) {
      const owners = this.classPurls.get(parts.slice(0, i).join("."));
      if (owners?.size) {
        return owners;
      }
    }
    return undefined;
  }

  /**
   * The libraries that ship classes directly in the package a symbol names or
   * sits in. A package the project also fills is ambiguous and joins nothing,
   * and `javax.` names join only through an exact class, since the JDK ships
   * most of them.
   */
  packageOwners(symbol) {
    if (symbol.startsWith(JDK_EXTENSION_PREFIX)) {
      return undefined;
    }
    const parts = symbol.replace(/\$+$/, "").split(".");
    for (let i = parts.length; i > 0; i--) {
      const name = parts.slice(0, i).join(".");
      const owners = this.packagePurls.get(name);
      if (owners?.size) {
        return this.projectPackages.has(name) ? undefined : owners;
      }
    }
    return undefined;
  }

  /**
   * The purl owning a symbol: the class first, then the package it sits in,
   * each narrowed to the module's own classpath and the file's platform, and
   * kept only when a single owner remains.
   *
   * @param {string} symbol Fully qualified symbol from the report.
   * @param {string|undefined} platform Platform of the referencing file.
   * @param {Set<string>|undefined} allowedPurls Purls on the module's classpath.
   * @returns {string|undefined} Component purl.
   */
  lookup(symbol, platform, allowedPurls) {
    if (!symbol || this.isUnowned(symbol)) {
      return undefined;
    }
    const byClass = this.narrow(
      this.classOwners(symbol),
      platform,
      allowedPurls,
    );
    if (byClass.length) {
      return byClass.length === 1 ? byClass[0] : undefined;
    }
    const byPackage = this.narrow(
      this.packageOwners(symbol),
      platform,
      allowedPurls,
    );
    return byPackage.length === 1 ? byPackage[0] : undefined;
  }

  /**
   * The owners a stack is evidence for: every jar that ships the class, since
   * which one served the call cannot be told from the source, or the single
   * package owner when no jar lists the class.
   */
  lookupAll(symbol, platform, allowedPurls) {
    if (!symbol || this.isUnowned(symbol)) {
      return [];
    }
    const byClass = this.narrow(
      this.classOwners(symbol),
      platform,
      allowedPurls,
    );
    if (byClass.length) {
      return byClass;
    }
    const single = this.lookup(symbol, platform, allowedPurls);
    return single ? [single] : [];
  }

  /**
   * Narrow candidate owners to what the referencing file can use. A module
   * compiles against its own classpath: a library on it wins, and a library
   * only other modules compile against does not qualify. A library on no
   * module's classpath stays a candidate, since the report cannot list every
   * jar (a locally published snapshot, say). The file's platform then picks
   * among the JVM, Scala.js and Scala Native variants of one library.
   */
  narrow(candidates, platform, allowedPurls) {
    let pool = [...(candidates || [])];
    if (!pool.length) {
      return pool;
    }
    let onClasspath = false;
    if (allowedPurls?.size) {
      const inModule = pool.filter((purl) => allowedPurls.has(purl));
      onClasspath = inModule.length > 0;
      pool = onClasspath
        ? inModule
        : pool.filter((purl) => !this.classpathPurls?.has(purl));
    }
    if (platform && pool.length) {
      const samePlatform = pool.filter(
        (purl) => scalaPurlPlatform(purl) === platform,
      );
      if (samePlatform.length || !onClasspath) {
        pool = samePlatform;
      }
    } else if (pool.length > 1) {
      // Without a platform the JVM speaks for a library built for several.
      const jvm = pool.filter((purl) => scalaPurlPlatform(purl) === "jvm");
      if (jvm.length) {
        pool = jvm;
      }
    }
    return pool;
  }
}

/**
 * Whether a report key names a source file entry. The schema keys file
 * entries by their relative path, for Scala sources, scripts and the Java
 * sources of a mixed module alike.
 */
export function isReportFileKey(key) {
  return /\.(scala|sc|java)$/.test(key || "");
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

// The Scala binary versions a component was built for: the suffix its purl
// keeps, or every cdx:scala:compilerVersion it carries, since one component can
// stand for the same library in builds of several Scala versions.
function componentBinaryVersions(component, coordinate) {
  if (coordinate.binaryVersion) {
    return new Set([coordinate.binaryVersion]);
  }
  return new Set(
    (component.properties || [])
      .filter((property) => property.name === "cdx:scala:compilerVersion")
      .map((property) => property.value)
      .filter(Boolean),
  );
}

/**
 * Index the BOM components by their normalized Scala coordinates, both with
 * and without the version, so a classpath jar, a namespace property and a map
 * entry of the same library meet on one component. Each entry keeps the Scala
 * binary version the component was built for, so the `_2.13` and `_3`
 * artifacts of one library in a Maven build stay apart.
 */
export function componentCoordinateIndex(components = []) {
  const byVersion = new Map();
  const withoutVersion = new Map();
  for (const component of components) {
    const coordinate = scalaCoordinateOfPurl(component?.purl);
    if (!coordinate) {
      continue;
    }
    const [type, group, artifactBase, platformSuffix] =
      coordinate.key.split(":");
    const entry = {
      component,
      binaryVersions: componentBinaryVersions(component, coordinate),
    };
    if (!byVersion.has(coordinate.key)) {
      byVersion.set(coordinate.key, []);
    }
    byVersion.get(coordinate.key).push(entry);
    const key = scalaCoordinateKey({
      type,
      group,
      artifactBase,
      platformSuffix,
    });
    if (!withoutVersion.has(key)) {
      withoutVersion.set(key, []);
    }
    withoutVersion.get(key).push(entry);
  }
  return { byVersion, withoutVersion };
}

function pickByBinaryVersion(entries, binaryVersion) {
  if (!entries?.length) {
    return [];
  }
  if (binaryVersion) {
    const same = entries.filter((entry) =>
      entry.binaryVersions.has(binaryVersion),
    );
    if (same.length) {
      return same;
    }
    const unknown = entries.filter((entry) => !entry.binaryVersions.size);
    if (unknown.length) {
      return unknown;
    }
    return [];
  }
  return entries;
}

/**
 * The component a report classpath entry belongs to. Coordinates are
 * normalized (`upickle_sjs1_3` and the purl name `upickle_sjs1` share a key),
 * the entry's version and Scala binary version win, and a versionless match
 * must have a single owner. A jar the BOM does not hold matches nothing: no
 * component is invented.
 *
 * @returns {{component: Object, exact: boolean}|undefined} The component, and
 *   whether its version is the one on the classpath.
 */
export function matchClasspathEntry(
  entry,
  { byVersion, withoutVersion },
  platform,
) {
  const parsed = parseScalaArtifact(entry?.artifact);
  const parts = {
    group: entry?.group,
    artifactBase: parsed.artifactBase,
    platformSuffix: parsed.platformSuffix,
  };
  const exact = pickByBinaryVersion(
    byVersion.get(scalaCoordinateKey({ ...parts, version: entry?.version })),
    parsed.binaryVersion,
  );
  if (exact.length === 1) {
    return { component: exact[0].component, exact: true };
  }
  if (exact.length > 1) {
    return undefined;
  }
  const candidates = pickByBinaryVersion(
    withoutVersion.get(scalaCoordinateKey(parts)),
    parsed.binaryVersion,
  );
  const matching = candidates.filter(
    (candidate) => scalaPurlPlatform(candidate.component.purl) === platform,
  );
  const pool = matching.length ? matching : candidates;
  return pool.length === 1
    ? { component: pool[0].component, exact: false }
    : undefined;
}

/**
 * Build the symbol index from the three sources, reading each classpath jar
 * once, and only for components that carry no namespaces yet.
 *
 * @param {Object} report Parsed scalasem report.
 * @param {Object[]} components BOM components.
 * @param {Object} jarNSMapping The jar namespace map cdxgen writes beside the BOM.
 * @returns {Promise<ScalaJoinIndex>}
 */
export async function buildScalaJoinIndex(report, components, jarNSMapping) {
  const index = new ScalaJoinIndex();
  index.addProjectDefinitions(report);
  index.exactPurls = new Set();
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
  const readJars = new Set();
  for (const module of report.modules || []) {
    for (const entry of module.classpath || []) {
      const matched = matchClasspathEntry(
        entry,
        coordinateIndex,
        module.platform,
      );
      const purl = matched?.component?.purl;
      if (!purl || purlsWithNamespaces.has(purl) || index.hasNamespaces(purl)) {
        continue;
      }
      if (!entry.path || readJars.has(entry.path)) {
        continue;
      }
      readJars.add(entry.path);
      if (!safeExistsSync(entry.path)) {
        continue;
      }
      let classes = [];
      try {
        classes = await getJarClasses(entry.path);
      } catch (_err) {
        classes = [];
      }
      if (classes.length) {
        index.addNamespaces(purl, classes, 1);
        if (matched.exact) {
          index.exactPurls.add(purl);
        }
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
      index.addNamespaces(matched.component.purl, entry.namespaces, 3);
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
  SHA1withRSA: "sha1-with-rsa-signature",
  SHA224withDSA: "dsaWithSha224",
  SHA256withDSA: "dsaWithSha256",
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
// `cdx:scalasem:crypto:*` properties instead of assets. Ciphers whose key
// depends on the mode (Blowfish, DESede, RC2) and the curve algorithms
// resolve only when the finding names the mode or the curve, and are
// properties otherwise.
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
// Algorithms that resolve to an OID only together with what the finding
// says about them: the mode of a mode-keyed cipher, or the curve.
export const SCALASEM_QUALIFIED_ALGORITHMS = new Set([
  "Blowfish",
  "DESede",
  "EC",
  "ECDH",
  "ECDSA",
  "ECIES",
  "EdDSA",
  "RC2",
  "XDH",
]);
export const SCALASEM_NO_OID_ALGORITHMS = new Set([
  "Argon2",
  "Argon2d",
  "Argon2i",
  "Argon2id",
  "BLAKE2b-512",
  "BLAKE2s-256",
  "CMAC",
  "Camellia",
  "ChaCha20",
  "DH",
  "DRBG",
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
  "SHA-512/224",
  "SHA-512/256",
  "SHA1PRNG",
  "SHA3-256withECDSA",
  "SHA384withDSA",
  "SHA512withDSA",
  "SM3",
  "SM4",
  "Whirlpool",
  "Windows-PRNG",
  "bcrypt",
  "none",
  "scrypt",
]);

// Ciphers whose registry key names the mode: `blowfishCBC`, `rc2ECB`.
const SCALASEM_MODE_KEYED_CIPHERS = {
  Blowfish: (mode) => `blowfish${mode}`,
  DESede: (mode) => (mode === "CBC" ? "des-EDE3-CBC" : undefined),
  RC2: (mode) => `rc2${mode}`,
};

// NIST names of the prime curves, as the registry spells them.
const SCALASEM_CURVE_ALIASES = {
  "p-256": "secp256r1",
  "p-384": "secp384r1",
  "p-521": "secp521r1",
};
const SCALASEM_WEIERSTRASS_ALGORITHMS = new Set([
  "EC",
  "ECDH",
  "ECDSA",
  "ECIES",
]);

/**
 * The registry key of a curve algorithm on a named curve. A key pair or an
 * ECDSA or ECDH use on a prime curve is identified by that curve. The
 * Montgomery curves serve key agreement only and the Edwards curves
 * signatures only, so a curve the algorithm cannot use resolves to nothing.
 */
function curveOidKey(name, curve) {
  const normalized = String(curve || "").toLowerCase();
  if (!normalized) {
    return undefined;
  }
  const montgomery = /^(x|curve)(25519|448)$/.exec(normalized);
  const edwards = /^ed(25519|448)$/.exec(normalized);
  if (montgomery) {
    return ["XDH", "ECDH"].includes(name)
      ? SCALASEM_OID_KEYS.get(
          montgomery[2] === "25519" ? "x25519" : "curvex448",
        )
      : undefined;
  }
  if (edwards) {
    return name === "EdDSA"
      ? SCALASEM_OID_KEYS.get(`ed${edwards[1]}`)
      : undefined;
  }
  if (!SCALASEM_WEIERSTRASS_ALGORITHMS.has(name)) {
    return undefined;
  }
  return SCALASEM_OID_KEYS.get(
    SCALASEM_CURVE_ALIASES[normalized] || normalized,
  );
}

/**
 * The CycloneDX padding enum value of a JCA padding name.
 */
function paddingOf(padding) {
  const normalized = String(padding || "").toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized.startsWith("oaep")) {
    return "oaep";
  }
  return SCALASEM_PADDING[normalized] || "other";
}

/**
 * The OID registry key for a canonical scalasem algorithm name, with the key
 * size, mode, curve or padding when the name needs one. Names that have no
 * key return undefined.
 *
 * @param {string} name Canonical algorithm name.
 * @param {number} [keySize] Key size in bits, when the report carries one.
 * @param {string} [mode] Block cipher mode, such as `GCM`.
 * @param {string} [curve] Elliptic curve name.
 * @param {string} [padding] JCA padding name.
 * @returns {string|undefined} Registry key such as `aes256-GCM`.
 */
export function scalasemCryptoOidKey(name, keySize, mode, curve, padding) {
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
  if (SCALASEM_MODE_KEYED_CIPHERS[name]) {
    const key = mode && SCALASEM_MODE_KEYED_CIPHERS[name](mode.toUpperCase());
    return key ? SCALASEM_OID_KEYS.get(key.toLowerCase()) : undefined;
  }
  if (name === "RSA") {
    const rsaPadding = paddingOf(padding);
    if (rsaPadding === "oaep") {
      return SCALASEM_OID_KEYS.get("id-rsaes-oaep");
    }
    if (rsaPadding === "pkcs1v15") {
      return SCALASEM_OID_KEYS.get("rsaencryption");
    }
  }
  const aliased = SCALASEM_OID_ALIASES[name];
  if (aliased && SCALASEM_OID_KEYS.has(aliased.toLowerCase())) {
    return SCALASEM_OID_KEYS.get(aliased.toLowerCase());
  }
  if (
    SCALASEM_WEIERSTRASS_ALGORITHMS.has(name) ||
    name === "XDH" ||
    name === "EdDSA"
  ) {
    return curveOidKey(name, curve);
  }
  return SCALASEM_OID_KEYS.get(name.toLowerCase());
}

function maxOccurrences() {
  const parsed = Number.parseInt(
    String(readEnvironmentVariable("CDXGEN_SCALASEM_MAX_OCCURRENCES") ?? ""),
    10,
  );
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAX_OCCURRENCES;
}

function isStdlibPurl(purl) {
  return SCALA_STDLIB_ARTIFACTS.has(
    parseScalaArtifact(purlPurlName(purl) || "").artifactBase,
  );
}

/**
 * The component purls each module's own classpath names, so a file compiled
 * against one version of a library attributes its uses to that version.
 */
function classpathPurlsByModule(report, coordinateIndex) {
  const byModule = new Map();
  for (const module of report.modules || []) {
    const purls = new Set();
    for (const entry of module.classpath || []) {
      const matched = matchClasspathEntry(
        entry,
        coordinateIndex,
        module.platform,
      );
      if (matched) {
        purls.add(matched.component.purl);
      }
    }
    byModule.set(module.id, purls);
  }
  return byModule;
}

function allowedPurlsFor(fileEntry, allowedPurlsByModule) {
  if (!fileEntry?.module) {
    return undefined;
  }
  return allowedPurlsByModule.get(fileEntry.module);
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
  if (options.deep || options.scalasemNamespaces) {
    attachJoinedNamespaces(joinIndex, components, componentPropertiesMap);
  }
  const allowedPurlsByModule = classpathPurlsByModule(
    report,
    componentCoordinateIndex(components),
  );
  joinIndex.classpathPurls = new Set(
    [...allowedPurlsByModule.values()].flatMap((purls) => [...purls]),
  );
  addUsageEvidence(
    report,
    joinIndex,
    purlLocationMap,
    componentPropertiesMap,
    options,
    allowedPurlsByModule,
  );
  addCallStackEvidence(
    report,
    joinIndex,
    dataFlowFrames,
    allowedPurlsByModule,
    options,
  );
  addCryptoEvidence(
    report,
    components,
    cryptoComponentsByRef,
    cryptoGeneratePurls,
    componentPropertiesMap,
    metadataProperties,
    options,
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
 * With --deep, publish the namespaces the classpath join read as
 * `internal:Namespaces` properties, the property the deep Maven flow
 * attaches, so components from builds that report no namespaces gain them.
 * Only a jar of the component's own version speaks for its classes.
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
    if (source !== 1 || known.has(purl) || !joinIndex.exactPurls?.has(purl)) {
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
 * only when they were asked for, the Scala runtime is capped at one
 * occurrence per file, and each component keeps at most a bounded number of
 * locations, every file it is used in first and further lines after. Call
 * sites are counted in full, whatever the cap kept.
 */
function addUsageEvidence(
  report,
  joinIndex,
  purlLocationMap,
  componentPropertiesMap,
  options,
  allowedPurlsByModule,
) {
  const includeTests = options.scalasemIncludeTests === true;
  const cap = maxOccurrences();
  const scopesByPurl = {};
  const platformsByPurl = {};
  const callSitesByPurl = {};
  const stdlibFilesByPurl = {};
  const linesByPurl = new Map();
  const addOccurrence = (purl, file, line, kind, scope, platform) => {
    if (!purl || !line) {
      return;
    }
    addSetValue(scopesByPurl, purl, scope);
    addSetValue(platformsByPurl, purl, platform);
    if (kind === "call") {
      callSitesByPurl[purl] = (callSitesByPurl[purl] || 0) + 1;
    }
    if (isStdlibPurl(purl)) {
      stdlibFilesByPurl[purl] ??= new Set();
      if (stdlibFilesByPurl[purl].has(file)) {
        return;
      }
      stdlibFilesByPurl[purl].add(file);
    }
    if (!linesByPurl.has(purl)) {
      linesByPurl.set(purl, new Map());
    }
    const byFile = linesByPurl.get(purl);
    if (!byFile.has(file)) {
      byFile.set(file, new Set());
    }
    byFile.get(file).add(line);
  };
  for (const [fileKey, fileEntry] of Object.entries(report)) {
    if (
      !isReportFileKey(fileKey) ||
      !fileEntry ||
      typeof fileEntry !== "object"
    ) {
      continue;
    }
    if (fileEntry.scope === "test" && !includeTests) {
      continue;
    }
    const platform = fileEntry.platform || (fileEntry.platforms || [])[0];
    const allowed = allowedPurlsFor(fileEntry, allowedPurlsByModule);
    const scope = fileEntry.scope || "main";
    for (const reference of fileEntry.references || []) {
      addOccurrence(
        joinIndex.lookup(reference.symbol, platform, allowed),
        fileKey,
        reference.line,
        "reference",
        scope,
        platform,
      );
    }
    for (const call of fileEntry.calls || []) {
      addOccurrence(
        joinIndex.lookup(call.owner, platform, allowed),
        fileKey,
        call.line,
        "call",
        scope,
        platform,
      );
    }
  }
  for (const [purl, byFile] of linesByPurl) {
    const locations = (purlLocationMap[purl] ??= new Set());
    const files = [...byFile.entries()].map(([file, lines]) => [
      file,
      [...lines].sort((left, right) => left - right),
    ]);
    // Every file first, then the further lines of each file in turn.
    for (let depth = 0; locations.size < cap; depth++) {
      let added = false;
      for (const [file, lines] of files) {
        if (depth < lines.length && locations.size < cap) {
          locations.add(`${file}#${lines[depth]}`);
          added = true;
        }
      }
      if (!added) {
        break;
      }
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
 * Call stacks: each stack the report found becomes one frame list on the
 * components of the library it ends in, with the entry point first and the
 * library call last. CycloneDX holds a single call stack per component, and
 * `framePicker` chooses which of the stacks a component collected to publish.
 * A library called on the sink's line is reached by the stack too, but a
 * stack that ends in a call to the component itself is the better evidence:
 * such a component is offered only its own stacks. Stacks that differ only in
 * which call of one method into the library they end at are one path; the
 * method's last call stands for it.
 */
function addCallStackEvidence(
  report,
  joinIndex,
  dataFlowFrames,
  allowedPurlsByModule,
  options = {},
) {
  const includeTests = options.scalasemIncludeTests === true;
  const ownStacks = {};
  const reachedStacks = {};
  for (const stack of report.callStacks || []) {
    const sink = stack.sink;
    if (!sink?.owner) {
      continue;
    }
    const fileEntry = report[sink.file];
    if (fileEntry?.scope === "test" && !includeTests) {
      continue;
    }
    const platform = fileEntry?.platform || (fileEntry?.platforms || [])[0];
    const allowed = allowedPurlsFor(fileEntry, allowedPurlsByModule);
    const sinkPurls = new Set(
      joinIndex.lookupAll(sink.owner, platform, allowed),
    );
    const purls = stackTargetPurls(
      sink,
      fileEntry,
      joinIndex,
      platform,
      allowed,
    );
    if (!purls.length) {
      continue;
    }
    const frames = (stack.frames || [])
      .filter((frame) => frame?.file)
      .map((frame) => stackFrame(report, frame));
    const sinkCovered = frames.some(
      (frame) => frame.fullFilename === sink.file && frame.line === sink.line,
    );
    if (!sinkCovered) {
      frames.push({
        package: packageOf(sink.owner),
        module: sink.owner,
        function: sink.name || "",
        line: sink.line,
        column: undefined,
        fullFilename: sink.file,
      });
    }
    for (const purl of purls) {
      const target = sinkPurls.has(purl) ? ownStacks : reachedStacks;
      target[purl] ??= [];
      target[purl].push(frames);
    }
  }
  for (const purl of new Set([
    ...Object.keys(ownStacks),
    ...Object.keys(reachedStacks),
  ])) {
    dataFlowFrames[purl] = onePerPath(ownStacks[purl] || reachedStacks[purl]);
  }
}

function onePerPath(stacks) {
  const byPath = new Map();
  for (const frames of stacks) {
    const last = frames[frames.length - 1];
    const key = [
      ...frames
        .slice(0, -1)
        .map((frame) => `${frame.fullFilename}#${frame.line}`),
      `${last.fullFilename}#${last.module}.${last.function}`,
    ].join(">");
    const known = byPath.get(key);
    if (!known || (known[known.length - 1].line || 0) < (last.line || 0)) {
      byPath.set(key, frames);
    }
  }
  return [...byPath.values()];
}

/**
 * One call stack frame in the shape `framePicker` reads. The report names the
 * method; the definition that encloses the frame's line names its class.
 */
function stackFrame(report, frame) {
  const owner = enclosingOwner(report[frame.file], frame);
  return {
    package: owner ? packageOf(owner) : "",
    module: owner || "",
    function: frame.function || "",
    line: frame.line || undefined,
    column: frame.column || undefined,
    fullFilename: frame.file,
  };
}

function enclosingOwner(fileEntry, frame) {
  let best;
  for (const definition of fileEntry?.definitions || []) {
    if (
      definition?.kind !== "def" ||
      definition.name !== frame.function ||
      !definition.owner ||
      definition.line > frame.line ||
      (definition.endLine || definition.line) < frame.line
    ) {
      continue;
    }
    if (!best || definition.line > best.line) {
      best = definition;
    }
  }
  return best?.owner;
}

/**
 * The components a stack is evidence for: the jars that ship the sink class,
 * plus the libraries called on the sink's own line, which is the terminal hop
 * the sink call came through. The Scala runtime is ambient and never a
 * target.
 */
function stackTargetPurls(sink, fileEntry, joinIndex, platform, allowed) {
  const purls = new Set(joinIndex.lookupAll(sink.owner, platform, allowed));
  for (const call of fileEntry?.calls || []) {
    if (call.line !== sink.line || !call.owner) {
      continue;
    }
    for (const purl of joinIndex.lookupAll(call.owner, platform, allowed)) {
      if (!isStdlibPurl(purl)) {
        purls.add(purl);
      }
    }
  }
  return [...purls];
}

function packageOf(className) {
  const text = String(className || "").replace(/\$+$/, "");
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

// Primitives a mode of operation applies to. RSA spells `RSA/ECB/...` in JCA,
// but a public key cipher has no mode, and calling it ECB would read as the
// weak block cipher mode.
const SCALASEM_MODE_PRIMITIVES = new Set(["block-cipher", "ae"]);

function cryptoModeOf(finding) {
  const mode = String(finding.mode || "").toLowerCase();
  return mode &&
    SCALASEM_MODES.has(mode) &&
    SCALASEM_MODE_PRIMITIVES.has(finding.primitive)
    ? mode
    : undefined;
}

/**
 * The asset name: the algorithm with its key size, mode and padding, so one
 * cipher used two ways is two assets, and an AES name that carries its mode
 * (`AES-GCM`) reads the same as AES with that mode.
 */
function cryptoAssetDisplayName(finding) {
  let base = finding.algorithm;
  let mode = cryptoModeOf(finding)?.toUpperCase();
  if (SCALASEM_AES_NAMES.has(base) && base.includes("-")) {
    [base] = base.split("-");
    mode ||= finding.algorithm.split("-")[1];
  }
  const parts = [base];
  if (finding.keySize) {
    parts.push(String(finding.keySize));
  }
  if (mode) {
    parts.push(mode);
  }
  const padding = paddingOf(finding.padding);
  if (finding.primitive === "pke" && padding && padding !== "raw") {
    parts.push(padding.toUpperCase());
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
  const mode = cryptoModeOf(finding);
  if (mode) {
    properties.mode = mode;
  }
  const padding = paddingOf(finding.padding);
  if (padding) {
    properties.padding = padding;
  }
  if (finding.keySize) {
    properties.parameterSetIdentifier = String(finding.keySize);
  }
  return properties;
}

function cryptoBomRef(kind, name, identifier) {
  return `crypto/${kind}/${encodeURIComponent(name)}@${encodeURIComponent(identifier || name)}`;
}

/**
 * Crypto findings become CycloneDX crypto assets. Algorithms resolve through
 * the OID alias table and are skipped without one, protocols and keystores
 * are their own asset kinds, and everything the registry cannot name becomes
 * a `cdx:scalasem:crypto:*` property on the providing component instead of an
 * asset with an invented identifier. A finding the report could not resolve
 * never becomes an asset.
 */
function addCryptoEvidence(
  report,
  components,
  cryptoComponentsByRef,
  cryptoGeneratePurls,
  componentPropertiesMap,
  metadataProperties,
  options = {},
) {
  const includeTests = options.scalasemIncludeTests === true;
  const nativeLibraryBySymbol = new Map();
  for (const binding of report.nativeBindings || []) {
    if (binding.library && binding.symbol) {
      nativeLibraryBySymbol.set(binding.symbol, binding.library);
    }
  }
  const assetOccurrencesByRef = new Map();
  for (const finding of report.crypto || []) {
    const scope = report[finding.file]?.scope || "main";
    if (scope === "test" && !includeTests) {
      continue;
    }
    const location = `${finding.file || ""}#${finding.line || 0}`;
    const nativeLibrary = finding.kind?.startsWith("native")
      ? nativeLibraryBySymbol.get(finding.name)
      : undefined;
    const providerPurl = scalasemProviderPurl(finding.provider, components);
    const asset =
      finding.resolution === "unresolved"
        ? undefined
        : cryptoAssetFor(finding, options);
    if (asset) {
      const existing = cryptoComponentsByRef.get(asset["bom-ref"]);
      const target = existing || asset;
      if (!existing) {
        cryptoComponentsByRef.set(asset["bom-ref"], asset);
      }
      for (const property of cryptoAssetProperties(finding, nativeLibrary)) {
        appendUniqueProperty(target.properties, property.name, property.value);
      }
      appendUniqueProperty(
        target.properties,
        "cdx:scalasem:usageScopes",
        scope,
      );
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
      // No registry OID: the finding stays visible as a property, and a weak
      // one says so, since no asset carries the verdict.
      const name = finding.algorithm || finding.name;
      const value = `${name}@${location}`;
      const record = (propertyName) => {
        if (providerPurl) {
          addPropertyValue(
            componentPropertiesMap,
            providerPurl,
            propertyName,
            value,
          );
        } else {
          appendUniqueProperty(metadataProperties, propertyName, value);
        }
      };
      record(`cdx:scalasem:crypto:${finding.kind}`);
      if (finding.weak) {
        record("cdx:scalasem:crypto:weakFinding");
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

// Protocol names as CycloneDX types and versions. SSL predates TLS and has
// no type of its own, and the bare names carry no version.
const SCALASEM_PROTOCOLS = {
  SSL: { type: "other" },
  SSLv3: { type: "other", version: "3.0" },
  TLS: { type: "tls" },
  TLSv1: { type: "tls", version: "1.0" },
  "TLSv1.1": { type: "tls", version: "1.1" },
  "TLSv1.2": { type: "tls", version: "1.2" },
  "TLSv1.3": { type: "tls", version: "1.3" },
  "DTLSv1.2": { type: "dtls", version: "1.2" },
};

function cryptoAssetFor(finding) {
  const name = finding.algorithm || finding.name;
  if (!name) {
    return undefined;
  }
  if (SCALASEM_PROTOCOL_NAMES.has(name) || finding.kind === "protocol") {
    const protocol = SCALASEM_PROTOCOLS[name] || { type: "other" };
    return {
      type: "cryptographic-asset",
      name,
      "bom-ref": cryptoBomRef("protocol", name),
      description:
        "Cryptographic protocol detected by scalasem source analysis",
      cryptoProperties: {
        assetType: "protocol",
        protocolProperties: { ...protocol },
      },
      properties: [],
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
      properties: [],
    };
  }
  const oidKey = scalasemCryptoOidKey(
    name,
    finding.keySize,
    finding.mode,
    finding.curve,
    finding.padding,
  );
  const oid = oidKey ? SCALASEM_CRYPTO_OIDS[oidKey]?.oid : undefined;
  if (!oid) {
    return undefined;
  }
  const algorithmProperties = cryptoAlgorithmProperties(finding);
  const displayName = cryptoAssetDisplayName(finding);
  // A native finding's bom-ref carries the C function it resolves to, so the
  // asset stays distinct per binding and findable by the function name.
  const nativeSuffix =
    finding.kind?.startsWith("native") && finding.name
      ? `#${finding.name}`
      : "";
  const component = {
    type: "cryptographic-asset",
    name: displayName,
    "bom-ref": `${cryptoBomRef("algorithm", displayName, oid)}${nativeSuffix}`,
    description: "Cryptographic algorithm detected by scalasem source analysis",
    cryptoProperties: {
      assetType: "algorithm",
      oid,
      algorithmProperties,
    },
    properties: [],
  };
  // The family and the curve in the schema's own spellings (`secg/secp256r1`);
  // spec compatibility keeps them for 1.7 and later only.
  applyAlgorithmProperties(component, {
    name: SCALASEM_AES_NAMES.has(name) ? "AES" : name,
    curve: finding.curve,
  });
  return component;
}

function cryptoAssetProperties(finding, nativeLibrary) {
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
  if (finding.name && finding.kind?.startsWith("native")) {
    appendUniqueProperty(
      properties,
      "cdx:scalasem:crypto:nativeFunction",
      finding.name,
    );
    appendUniqueProperty(
      properties,
      "cdx:scalasem:crypto:nativeLibrary",
      nativeLibrary,
    );
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
 * A JDBC address without what may carry credentials: userinfo, the Oracle
 * `user/password@` prefix, URL parameters and the `;key=value` properties
 * some drivers take. The report is sanitized already; this keeps the BOM
 * safe from a report written by anything else.
 *
 * @param {string} value JDBC URL.
 * @returns {string} The address part.
 */
export function sanitizeJdbcUrl(value) {
  let text = String(value || "").trim();
  if (!/^jdbc:/i.test(text)) {
    return text;
  }
  text = `jdbc:${text.slice(5)}`;
  for (const separator of ["?", "#", ";"]) {
    const index = text.indexOf(separator);
    if (index >= 0) {
      text = text.slice(0, index);
    }
  }
  const slashes = text.indexOf("//");
  if (slashes >= 0) {
    const authorityEnd = text.indexOf("/", slashes + 2);
    const authority = text.slice(
      slashes + 2,
      authorityEnd >= 0 ? authorityEnd : undefined,
    );
    const at = authority.lastIndexOf("@");
    if (at >= 0) {
      text =
        text.slice(0, slashes + 2) +
        authority.slice(at + 1) +
        (authorityEnd >= 0 ? text.slice(authorityEnd) : "");
    }
  }
  // Oracle thin: jdbc:oracle:thin:user/password@host:port:sid
  const thin = /^(jdbc:oracle:thin:)[^@]*@/i.exec(text);
  if (thin) {
    text = `${thin[1]}@${text.slice(thin[0].length)}`;
  }
  return text;
}

function jdbcServiceName(value) {
  const address = sanitizeJdbcUrl(value);
  const scheme = address.slice(5).split(":", 1)[0].toLowerCase() || "jdbc";
  let host = /\/\/([^/:]+)/.exec(address)?.[1];
  if (!host) {
    // Oracle thin and similar: the host follows the @.
    host = /@(?:\/\/)?([^/:]+)/.exec(address)?.[1];
  }
  return [scheme, host].filter(Boolean).join("-");
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
  if (/^jdbc:/i.test(value)) {
    return jdbcServiceName(value);
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
 * The endpoint a service row carries, normalized: a URL as its scheme and
 * host, a host as it is, a topic as `client:topic`, a JDBC URL with its
 * credentials and parameters dropped.
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
  if (/^jdbc:/i.test(value)) {
    // The database name in the path is part of the address.
    return sanitizeJdbcUrl(value);
  }
  if (service?.host) {
    return service.host;
  }
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.host}`;
  } catch (_err) {
    const hostMatch = /:\/\/([^/?#@]+@)?([^/?#]+)/.exec(value);
    return hostMatch ? `${value.split("://")[0]}://${hostMatch[2]}` : undefined;
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
 * The npm packages a Scala.js build bundles. scalajs-bundler installs them
 * with a lock file under `target`, and a bundler workspace such as a Vite
 * client keeps its own manifest and lock file beside the build. Their npm
 * components join the BOM so the report's JavaScript module imports can be
 * attributed to them. Only lock files name the installed versions, and a
 * workspace counts only when its manifest uses Scala.js, so a documentation
 * site or a tool's own `package.json` adds nothing.
 *
 * @param {string} src Project directory.
 * @param {Object[]} pkgList Components the build tools reported.
 * @param {Object} [options] CLI options; `exclude` is honoured.
 * @returns {Promise<{components: Object[], roots: string[], dependencies: Object[]}>}
 *   Npm components, the bom-refs the workspaces depend on directly, and the
 *   lock files' dependency edges between the npm components.
 */
export async function collectScalaJsNpmComponents(
  src,
  pkgList = [],
  options = {},
) {
  const isScalaJs = pkgList.some((pkg) => {
    const name = pkg?.name || purlPurlName(pkg?.purl) || "";
    return /_(sjs\d+(?:\.\d+)?)$/.test(name) || name === "scalajs-library";
  });
  const empty = { components: [], roots: [], dependencies: [] };
  if (!isScalaJs) {
    return empty;
  }
  const projectDir = resolve(src);
  const searchOptions = {
    includeNodeModulesDir: false,
    exclude: options.exclude,
  };
  const manifestDirs = new Set();
  for (const file of getAllFiles(
    projectDir,
    "**/scalajs-bundler/**/package.json",
    searchOptions,
  )) {
    manifestDirs.add(dirname(file));
  }
  // A workspace beside the build: the project's own manifests, not the ones
  // node_modules holds. Two levels cover the usual client/server split.
  for (const pattern of ["package.json", "*/package.json"]) {
    for (const file of getAllFiles(projectDir, pattern, searchOptions)) {
      if (manifestUsesScalaJs(file)) {
        manifestDirs.add(dirname(file));
      }
    }
  }
  const components = [];
  const roots = [];
  const dependencies = [];
  for (const manifestDir of manifestDirs) {
    const lockFile = ["package-lock.json", "npm-shrinkwrap.json"]
      .map((name) => join(manifestDir, name))
      .find((file) => safeExistsSync(file));
    if (!lockFile) {
      continue;
    }
    const lockData = await parsePkgLock(lockFile, options);
    // The lock file's own package is the workspace, which is part of the
    // project rather than a dependency of it.
    const workspaceRefs = new Set(
      (lockData?.pkgList || [])
        .filter((pkg) => pkg.type === "application")
        .map((pkg) => pkg["bom-ref"]),
    );
    components.push(
      ...(lockData?.pkgList || []).filter((pkg) => pkg.type !== "application"),
    );
    for (const dependency of lockData?.dependenciesList || []) {
      if (workspaceRefs.has(dependency.ref)) {
        roots.push(...(dependency.dependsOn || []));
      } else {
        dependencies.push(dependency);
      }
    }
  }
  return { components, roots: [...new Set(roots)], dependencies };
}

function manifestUsesScalaJs(manifestFile) {
  try {
    const manifest = JSON.parse(readFileSync(manifestFile, "utf-8"));
    const names = Object.keys({
      ...(manifest?.dependencies || {}),
      ...(manifest?.devDependencies || {}),
    });
    return names.some((name) => /scala-?js/i.test(name));
  } catch (_err) {
    return false;
  }
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
