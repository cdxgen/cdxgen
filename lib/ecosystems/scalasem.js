import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import process from "node:process";

import { DEBUG_MODE, readEnvironmentVariable } from "../core/activity.js";
import { deferFailOnError } from "../core/deferredExit.js";
import { PROJECT_TYPE_ALIASES } from "../core/env.js";
import {
  getAllFiles,
  getTmpDir,
  safeExistsSync,
  safeMkdirSync,
  safeMkdtempSync,
  safeRmSync,
  safeSpawnSync,
  safeWriteSync,
} from "../core/fs.js";
import { dirNameStr } from "../core/paths.js";
import { resolvePluginSourceDir } from "../core/pluginRun.js";
import { formatDuration } from "../core/processTree.js";
import { isProjectToolingAllowed } from "../core/projectTooling.js";
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
// names the working directory relative to itself, and that a persisted report
// must be newer than. sbt 0.13 builds may define everything under project/.
const SCALA_BUILD_MARKERS = [
  "build.sbt",
  "build.sc",
  "build.mill",
  "pom.xml",
  "project.scala",
  join("project", "build.properties"),
];

/**
 * Where the scalasem report is persisted. An absolute --semantics-slices-file
 * keeps its directory; anything else lands in the evinse output directory, the
 * same rule the atom slice writer follows. Without either there is nowhere to
 * keep it, and the report lives only as long as the run.
 *
 * @param {Object} options CLI options carrying `output` and `semanticsSlicesFile`.
 * @returns {string|undefined} Absolute report path.
 */
export function scalasemOutputFile(options = {}) {
  const requested = options.semanticsSlicesFile || "semantics.slices.json";
  // Comparing with resolve() missed Windows paths written with forward slashes
  // or without a drive.
  if (isAbsolute(requested)) {
    return requested;
  }
  if (!options.output) {
    return undefined;
  }
  const resolvedOutput = resolve(options.output);
  let isDir = false;
  try {
    isDir =
      safeExistsSync(resolvedOutput) && lstatSync(resolvedOutput).isDirectory();
  } catch (_err) {
    isDir = false;
  }
  const outputDir = isDir ? resolvedOutput : dirname(resolvedOutput);
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

// Whether a path lies below a directory. A prefix test fails for a root
// directory (`/`, `C:\\`), whose path already ends in the separator.
function isInside(directory, path) {
  const rel = relative(directory, path);
  return (
    Boolean(rel) &&
    rel !== ".." &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  );
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
      return isInside(projectDir, path) && safeExistsSync(path);
    })
  );
}

// The run settings a report depends on. cdxgen records them in the report it
// keeps, so a later run reuses that report only when it would ask for the
// same: tests included or not, the build run or not.
const RUN_SETTINGS_KEY = "cdxgenRunSettings";

function scalasemRunSettings(options) {
  return {
    build: isProjectToolingAllowed(options),
    includeTests: Boolean(
      options.scalasemIncludeTests && !options.requiredOnly,
    ),
  };
}

function canonicalPath(path) {
  try {
    return realpathSync(path);
  } catch (_err) {
    return resolve(path);
  }
}

// Whether two paths name one directory, through symbolic links such as
// /var and /private/var, and in any case on Windows.
function isSamePath(left, right) {
  const a = canonicalPath(left);
  const b = canonicalPath(right);
  return process.platform === "win32"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

function modifiedAt(file) {
  try {
    return statSync(file).mtimeMs;
  } catch (_err) {
    return undefined;
  }
}

/**
 * Why a persisted report cannot stand in for a new run: it describes another
 * project, it predates the input BOM, cdxgen kept it from a run with other
 * settings, or a build file or a source it describes changed or went away
 * since it was written.
 *
 * @returns {string|undefined} The reason, or undefined when it can be reused.
 */
function reportReuseProblem(report, reportFile, analysisDir, options) {
  const projectPath = report._meta?.projectPath;
  if (!projectPath || !isSamePath(projectPath, analysisDir)) {
    return "it describes another project";
  }
  if (!isNewerThan(reportFile, options.input)) {
    return "it is older than the input BOM";
  }
  const recorded = report._meta[RUN_SETTINGS_KEY];
  const wanted = scalasemRunSettings(options);
  if (
    recorded &&
    (recorded.build !== wanted.build ||
      recorded.includeTests !== wanted.includeTests)
  ) {
    return "it was made with other settings";
  }
  const writtenAt = modifiedAt(reportFile);
  if (writtenAt === undefined) {
    return "its modification time is unknown";
  }
  for (const marker of SCALA_BUILD_MARKERS) {
    const changedAt = modifiedAt(join(analysisDir, marker));
    if (changedAt !== undefined && changedAt > writtenAt) {
      return `${marker} changed since`;
    }
  }
  for (const key of Object.keys(report)) {
    const file = isReportFileKey(key) ? resolve(analysisDir, key) : undefined;
    if (!file || !isInside(analysisDir, file)) {
      continue;
    }
    const changedAt = modifiedAt(file);
    if (changedAt === undefined || changedAt > writtenAt) {
      return `${key} changed since`;
    }
  }
  return undefined;
}

/**
 * Run scalasem over a Scala project and return its report, reusing a
 * persisted version 2 report that belongs to this project, is newer than the
 * input BOM and than the build files and sources it describes, and, when
 * cdxgen kept it, was made with the settings this run asks for.
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
      const problem = reportReuseProblem(
        existing,
        candidate,
        analysisDir,
        options,
      );
      if (problem && DEBUG_MODE) {
        console.log(
          `Not reusing the scalasem report "${candidate}": ${problem}.`,
        );
      }
      if (!problem) {
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
  const scalasem = options.scalasemCommand || resolveScalasemCommand();
  if (!scalasem) {
    const diagnostics = scalasemRunFailure(
      "scalasem-missing",
      "analyzer not found, so the BOM carries no Scala semantic evidence. Install @appthreat/atom-parsetools or set SCALASEM_CMD.",
      options,
      [],
    );
    return {
      report: undefined,
      reportFile: undefined,
      v1Slice,
      metadataProperties: scalasemMetadataProperties(undefined, diagnostics),
    };
  }
  // scalasem writes into a directory of this run's own, so a report found
  // there afterwards is this run's. Writing to the requested path directly
  // left only the file's modification time to tell a fresh report from one an
  // earlier run (or another project's run) had left there, and a report
  // written within the millisecond the run started passed for fresh.
  const runDir = safeMkdtempSync(join(getTmpDir(), "scalasem-"));
  try {
    return runScalasemIn(
      runDir,
      scalasem,
      analysisDir,
      options,
      requestedFile,
      v1Slice,
      v1File,
    );
  } finally {
    safeRmSync(runDir, { recursive: true, force: true });
  }
}

function runScalasemIn(
  runDir,
  scalasem,
  analysisDir,
  options,
  requestedFile,
  v1Slice,
  v1File,
) {
  const runReportFile = join(runDir, "scalasem.slices.json");
  const args = [scalasem, analysisDir, runReportFile];
  const settings = scalasemRunSettings(options);
  // The build runs the project's sbt definitions
  if (!settings.build) {
    args.push("--no-build");
  }
  if (settings.includeTests) {
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
  // A spawn that throws, such as a command the allow list refuses, degrades
  // the evidence like any other run that could not start.
  let result;
  try {
    result = safeSpawnSync(process.execPath, args, {
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
  } catch (err) {
    result = { error: err };
  }
  const elapsedMs = Date.now() - startedAt;
  const wroteReport = safeExistsSync(runReportFile);
  const written = wroteReport ? readScalasemReport(runReportFile) : undefined;
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
      `wrote a report for ${analysisDir} that is not valid JSON; run with CDXGEN_DEBUG_MODE=debug to see its output.`,
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
    const summary = summarizeDiagnostics(
      degradingDiagnostics(report._meta.diagnostics),
    );
    if (summary) {
      console.warn(
        `scalasem: the report is degraded: ${summary}. The cdx:scalasem:diagnostic:* metadata properties of the BOM say where.`,
      );
    }
  }
  if (DEBUG_MODE && !usable && (result?.stdout || result?.stderr)) {
    console.log(result.stdout, result.stderr);
  }
  // Only a usable report replaces the one at the requested path, and a
  // version 1 slice there stays as the user left it.
  // The kept copy records the settings of this run, so a later run reuses it
  // only when it asks for the same.
  let reportFile;
  if (usable && requestedFile && v1File !== requestedFile) {
    try {
      safeMkdirSync(dirname(requestedFile), { recursive: true });
      safeWriteSync(
        requestedFile,
        JSON.stringify({
          ...report,
          _meta: { ...report._meta, [RUN_SETTINGS_KEY]: settings },
        }),
      );
      reportFile = safeExistsSync(requestedFile) ? requestedFile : undefined;
    } catch (err) {
      console.warn(
        `scalasem: the report could not be kept at ${requestedFile} (${err.message}); this run still uses it.`,
      );
    }
  }
  return {
    report,
    reportFile,
    v1Slice,
    metadataProperties: scalasemMetadataProperties(report, diagnostics),
  };
}

// Diagnostics scalasem counts on a healthy run: symbols its semantic pass
// could not resolve, and stale build outputs it correctly skipped. They say
// the analysis is incomplete, not that it is degraded, so they stay out of
// the BOM and out of the degraded flag.
const INFORMATIONAL_DIAGNOSTIC_CODES = new Set([
  "unresolved-symbols",
  "stale-output",
]);

function degradingDiagnostics(diagnostics = []) {
  return (diagnostics || []).filter(
    (diagnostic) => !INFORMATIONAL_DIAGNOSTIC_CODES.has(diagnostic?.code),
  );
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
  allDiagnostics = report?._meta?.diagnostics || [],
) {
  const diagnostics = degradingDiagnostics(allDiagnostics);
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
 * `_native0.x` is Scala Native, and neither is the JVM. The platform suffix
 * counts whether the Scala binary suffix follows it (`upickle_sjs1_3`, the
 * published name a jar scan keeps) or not (`upickle_sjs1`, the sbt name).
 *
 * @param {string} purl Package URL.
 * @returns {"jvm"|"js"|"native"} Platform key.
 */
export function scalaPurlPlatform(purl) {
  return scalaNamePlatform(purlPurlName(purl));
}

function scalaNamePlatform(name) {
  const { platformSuffix } = parseScalaArtifact(name);
  if (platformSuffix.startsWith("_sjs")) {
    return "js";
  }
  if (platformSuffix.startsWith("_native")) {
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

// A compiler-generated class: a `$`-separated part that is empty past the
// top-level name (`$$`) or numeric, or one of the anonymous and lambda markers.
function isSyntheticClassName(symbol, dollar) {
  return symbol
    .slice(dollar + 1)
    .split("$")
    .some(
      (part, index, parts) =>
        (part === "" && index < parts.length - 1) ||
        /^\d+$/.test(part) ||
        ["anon", "anonfun", "Lambda", "lambda"].includes(part),
    );
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
      // A `$` inside the simple name separates nested classes; one that starts
      // it belongs to an encoded operator name (`$colon$colon` for `::`).
      const simpleName = symbol.lastIndexOf(".") + 1;
      const dollar = symbol.startsWith("$", simpleName)
        ? -1
        : symbol.indexOf("$", simpleName);
      const topLevel = dollar > 0 ? symbol.slice(0, dollar) : symbol;
      // Anonymous classes and lambdas (`Foo$$anon$1`, `Foo$$anonfun$bar$1`,
      // `Foo$$Lambda$12`) are no names a source can reference; their outer
      // class speaks for them.
      const synthetic = dollar > 0 && isSyntheticClassName(symbol, dollar);
      if (!synthetic) {
        indexed.push(symbol);
      }
      this.addSymbol(this.classPurls, topLevel, purl, source);
      if (dollar > 0 && !synthetic) {
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
   *
   * The package is the part of the symbol before its first type name, which
   * starts with a capital letter (`io.circe` of `io.circe.Json.fromString`). A
   * symbol without one names a package (`io.circe`) or a member of one, such
   * as a package object member (`io.circe.syntax.asJson`). Parent packages
   * never answer: a missing `io.circe.generic` is not circe-core.
   */
  packageOwners(symbol) {
    if (symbol.startsWith(JDK_EXTENSION_PREFIX)) {
      return undefined;
    }
    const parts = symbol.replace(/\$+$/, "").split(".");
    const firstType = parts.findIndex((part) => /^[A-Z]/.test(part));
    const packages =
      firstType >= 0
        ? [parts.slice(0, firstType).join(".")]
        : [parts.join("."), parts.slice(0, -1).join(".")];
    for (const name of packages) {
      const owners = name ? this.packagePurls.get(name) : undefined;
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

// Which of two components standing for the same library is the one evidence
// attaches to: the plain purl over one with qualifiers, then the shorter, then
// the lexicographically first, so the choice never depends on BOM order.
function preferredComponent(current, candidate) {
  const rank = (component) => [
    component.purl.includes("?") ? 1 : 0,
    component.purl.length,
  ];
  const [currentQualified, currentLength] = rank(current);
  const [candidateQualified, candidateLength] = rank(candidate);
  if (currentQualified !== candidateQualified) {
    return candidateQualified < currentQualified ? candidate : current;
  }
  if (currentLength !== candidateLength) {
    return candidateLength < currentLength ? candidate : current;
  }
  return candidate.purl < current.purl ? candidate : current;
}

/**
 * Index the BOM components by their normalized Scala coordinates, both with
 * and without the version, so a classpath jar, a namespace property and a map
 * entry of the same library meet on one component. Each entry keeps the Scala
 * binary versions the component was built for, so the `_2.13` and `_3`
 * artifacts of one library in a Maven build stay apart. Components that share
 * a normalized coordinate and were built for an overlapping set of Scala
 * binary versions are one library listed more than once (a repository_url
 * qualifier, a `_3` suffix beside the sbt name built for 2.13 and 3, a stale
 * duplicate), so they share one entry, which the preferred component of the
 * group stands for.
 */
export function componentCoordinateIndex(components = []) {
  const groupsByKey = new Map();
  for (const component of components) {
    const coordinate = scalaCoordinateOfPurl(component?.purl);
    if (!coordinate) {
      continue;
    }
    const binaryVersions = componentBinaryVersions(component, coordinate);
    const groups = groupsByKey.get(coordinate.key) || [];
    groupsByKey.set(coordinate.key, groups);
    // Every group this component overlaps becomes one with it.
    const overlapping = groups.filter((group) =>
      binaryVersions.size
        ? [...binaryVersions].some((version) =>
            group.binaryVersions.has(version),
          )
        : !group.binaryVersions.size,
    );
    const merged = {
      component,
      binaryVersions: new Set(binaryVersions),
    };
    for (const group of overlapping) {
      merged.component = preferredComponent(merged.component, group.component);
      for (const version of group.binaryVersions) {
        merged.binaryVersions.add(version);
      }
      groups.splice(groups.indexOf(group), 1);
    }
    groups.push(merged);
  }
  const byVersion = new Map();
  const withoutVersion = new Map();
  for (const [key, groups] of groupsByKey) {
    const [type, group, artifactBase, platformSuffix] = key.split(":");
    byVersion.set(key, groups);
    const versionless = scalaCoordinateKey({
      type,
      group,
      artifactBase,
      platformSuffix,
    });
    withoutVersion.set(versionless, [
      ...(withoutVersion.get(versionless) || []),
      ...groups,
    ]);
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
export function matchClasspathEntry(entry, coordinateIndex, platform) {
  const direct =
    entry?.group && entry?.artifact
      ? matchCoordinates(entry, coordinateIndex, platform)
      : undefined;
  if (direct?.component || direct?.ambiguous) {
    return direct.component ? direct : undefined;
  }
  // The report reads coordinates from a Maven repository layout and can take
  // directories above the group for part of it (`maven.io.circe` for jars
  // under `<repository>/maven/io/circe/`), and reads none from the Gradle and
  // Ivy cache layouts. The coordinates the jar's own path spells are tried
  // then, and must still meet a component on artifact and version.
  for (const coordinates of jarPathCoordinates(entry)) {
    const byPath = matchCoordinates(
      { ...entry, ...coordinates },
      coordinateIndex,
      platform,
    );
    if (byPath?.exact) {
      return byPath;
    }
  }
  return undefined;
}

/**
 * The coordinates a classpath jar's path spells, for the layouts the report
 * does not read itself, most specific first:
 *
 * - a Maven layout `<group dirs>/<artifact>/<version>/<file>` whose group is
 *   a dotted tail of the group the report recorded, so a group is only ever
 *   shortened by the directories the report took for it, never guessed
 * - the Gradle cache `files-2.1/<group>/<artifact>/<version>/<sha1>/<file>`
 * - an Ivy cache `<org>/<artifact>/jars/<artifact>-<version>.jar`, as sbt 0.13
 *   and sbt 1.0 to 1.2 keep it, and an Ivy local repository
 *   `<org>/<artifact>/<version>/jars/<artifact>.jar`
 *
 * @param {Object} entry Classpath entry with `path` and, when the report read
 *   them, `group`, `artifact` and `version`.
 * @returns {{group: string, artifact: string, version: string}[]}
 */
export function jarPathCoordinates(entry) {
  if (!entry?.path) {
    return [];
  }
  const segments = String(entry.path).split(/[\\/]/).filter(Boolean);
  const total = segments.length;
  const file = segments[total - 1] || "";
  if (total < 4 || !file.toLowerCase().endsWith(".jar")) {
    return [];
  }
  const found = [];
  if (entry.group && entry.artifact && entry.version) {
    const artifactIndex = total - 3;
    if (
      segments[artifactIndex] === entry.artifact &&
      segments[artifactIndex + 1] === entry.version
    ) {
      const groupParts = entry.group.split(".");
      for (let start = 1; start < groupParts.length; start++) {
        const tail = groupParts.slice(start);
        const directories = segments.slice(
          artifactIndex - tail.length,
          artifactIndex,
        );
        if (
          artifactIndex - tail.length >= 0 &&
          directories.join("/") === tail.join("/")
        ) {
          found.push({
            group: tail.join("."),
            artifact: entry.artifact,
            version: entry.version,
          });
        }
      }
    }
  }
  const gradle = segments.lastIndexOf("files-2.1");
  if (gradle >= 0 && gradle + 5 === total - 1) {
    found.push({
      group: segments[gradle + 1],
      artifact: segments[gradle + 2],
      version: segments[gradle + 3],
    });
  }
  const stem = file.slice(0, -".jar".length);
  if (["jars", "bundles"].includes(segments[total - 2])) {
    // Ivy local: <org>/<artifact>/<version>/jars/<artifact>.jar
    if (total >= 5 && stem === segments[total - 4]) {
      found.push({
        group: segments[total - 5],
        artifact: segments[total - 4],
        version: segments[total - 3],
      });
    } else if (stem.startsWith(`${segments[total - 3]}-`)) {
      // Ivy cache: <org>/<artifact>/jars/<artifact>-<version>.jar
      found.push({
        group: segments[total - 4],
        artifact: segments[total - 3],
        version: stem.slice(segments[total - 3].length + 1),
      });
    }
  }
  return found.filter(
    (coordinates) =>
      coordinates.group &&
      coordinates.artifact &&
      coordinates.version &&
      (coordinates.group !== entry.group ||
        coordinates.artifact !== entry.artifact ||
        coordinates.version !== entry.version),
  );
}

// The component a set of coordinates names: `{component, exact}` for a single
// owner, `{ambiguous: true}` when several components answer, undefined when
// none does.
function matchCoordinates(entry, { byVersion, withoutVersion }, platform) {
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
    return { ambiguous: true };
  }
  const candidates = pickByBinaryVersion(
    withoutVersion.get(scalaCoordinateKey(parts)),
    parsed.binaryVersion,
  );
  const matching = candidates.filter(
    (candidate) => scalaPurlPlatform(candidate.component.purl) === platform,
  );
  const pool = matching.length ? matching : candidates;
  if (pool.length === 1) {
    return { component: pool[0].component, exact: false };
  }
  return pool.length > 1 ? { ambiguous: true } : undefined;
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
    // Maps written before every producer used `{ namespaces }` hold the
    // newline-joined namespaces of a jar-scanned component as a string.
    const value = jarNSMapping[mapPurl];
    const namespaces =
      typeof value === "string"
        ? value.split("\n").filter(Boolean)
        : value?.namespaces;
    if (!Array.isArray(namespaces) || !namespaces.length) {
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
      index.addNamespaces(matched.component.purl, namespaces, 3);
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
    const upperMode = mode?.toUpperCase();
    const modeKey =
      SCALASEM_AES_MODE_KEYS[upperMode] ||
      SCALASEM_AES_MODE_KEYS[name.split("-")[1]];
    const wrap = name === "AES-KW" || upperMode === "KW";
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
    allowedPurlsByModule,
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

// The package of a class the report names. A class nested in an object reads
// `Outer$.Inner`, so the package ends before the first part that is a type:
// one that carries a `$` or starts with a capital letter.
function packageOf(className) {
  const parts = String(className || "").split(".");
  const firstType = parts.findIndex(
    (part) => part.includes("$") || /^[A-Z]/.test(part),
  );
  if (firstType > 0) {
    return parts.slice(0, firstType).join(".");
  }
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
 * the providers the rules emit for libraries without a coordinate. Of several
 * matching components, one on the referencing module's classpath wins, then
 * the artifact whose name extends the provider's least (`bcprov-jdk18on`
 * over `bcprov-ext-jdk18on`), then the first purl, so the choice never
 * depends on the order of the BOM.
 *
 * @param {string} provider Provider the finding names.
 * @param {Object[]} components BOM components.
 * @param {Set<string>} [classpathPurls] Purls on the module's classpath.
 * @returns {string|undefined} Component purl.
 */
export function scalasemProviderPurl(
  provider,
  components = [],
  classpathPurls = undefined,
) {
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
  const matches = [];
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
      matches.push({ purl: component.purl, name });
    }
  }
  const rank = (match) => [
    classpathPurls?.has(match.purl) ? 0 : 1,
    match.name.length,
  ];
  matches.sort((left, right) => {
    const [leftClasspath, leftLength] = rank(left);
    const [rightClasspath, rightLength] = rank(right);
    return (
      leftClasspath - rightClasspath ||
      leftLength - rightLength ||
      (left.purl < right.purl ? -1 : left.purl > right.purl ? 1 : 0)
    );
  });
  return matches[0]?.purl;
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
  allowedPurlsByModule = new Map(),
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
    const location = finding.line
      ? `${finding.file || ""}#${finding.line}`
      : finding.file || "";
    const nativeLibrary = finding.kind?.startsWith("native")
      ? nativeLibraryBySymbol.get(finding.name)
      : undefined;
    const providerPurl = scalasemProviderPurl(
      finding.provider,
      components,
      allowedPurlsFor(report[finding.file], allowedPurlsByModule),
    );
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

// `file#line` as an occurrence. A location without a line, or whose `#` is
// part of the file name, is the file alone.
function parseLocationString(location) {
  const separator = location.lastIndexOf("#");
  const suffix = separator >= 0 ? location.slice(separator + 1) : "";
  if (!/^\d+$/.test(suffix)) {
    return { location };
  }
  const line = Number.parseInt(suffix, 10);
  return {
    location: location.slice(0, separator),
    ...(line > 0 ? { line } : {}),
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

// The characters that end a host list: a path, URL parameters, and the
// `;key=value` properties some JDBC drivers take.
const ADDRESS_END = ["/", "?", "#", ";"];

const HOST_PATTERN = /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._%-]+)(?::\d+)?$/;

function indexOfAny(text, characters, from = 0) {
  let found = -1;
  for (const character of characters) {
    const index = text.indexOf(character, from);
    if (index >= 0 && (found < 0 || index < found)) {
      found = index;
    }
  }
  return found;
}

function cutAt(text, characters) {
  const index = indexOfAny(text, characters);
  return index >= 0 ? text.slice(0, index) : text;
}

// `host`, `host:port`, `[ipv6]:port`, or a comma separated list of those.
function isHostList(text) {
  return (
    Boolean(text) && text.split(",").every((host) => HOST_PATTERN.test(host))
  );
}

/**
 * Where the userinfo in front of a host ends, or -1 when there is none. A
 * password may hold any of `/ ? # ; @ =`, so an `@` ends the userinfo unless a
 * well-formed host list is followed by parameters that hold it
 * (`host:1433;user=a@b`). Of several `@`, the last one before the first
 * parameter ends it, and the last one of all when that leaves none: a host the
 * split gets wrong costs a service name, a split that keeps a password leaks it.
 *
 * @param {string} rest The text after `//`, or after a JDBC subprotocol.
 * @returns {number} Index of the `@` that ends the userinfo.
 */
function userinfoEnd(rest) {
  const firstAt = rest.indexOf("@");
  if (firstAt < 0) {
    return -1;
  }
  const end = indexOfAny(rest, ADDRESS_END);
  if (
    end >= 0 &&
    end < firstAt &&
    isHostList(rest.slice(0, end)) &&
    rest.slice(end + 1, firstAt).includes("=")
  ) {
    return -1;
  }
  const firstEquals = rest.indexOf("=");
  const beforeParameters =
    firstEquals >= 0 ? rest.lastIndexOf("@", firstEquals) : -1;
  return beforeParameters >= 0 ? beforeParameters : rest.lastIndexOf("@");
}

/**
 * The `host[:port]` list of a parenthesized address: MySQL
 * `address=(host=h)(port=3306)` and `(host=h,port=3306,user=u)`, Oracle
 * `(DESCRIPTION=(ADDRESS=(HOST=h)(PORT=1521)))`. Only host and port values are
 * read, so a user or password beside them never leaves.
 */
function parenthesizedHosts(text) {
  const hosts = [];
  const ports = [];
  for (const group of text.split(/[()]/)) {
    for (const pair of group.split(",")) {
      const equals = pair.indexOf("=");
      if (equals <= 0) {
        continue;
      }
      const key = pair.slice(0, equals).trim().toLowerCase();
      const value = pair.slice(equals + 1).trim();
      if (key === "host" && HOST_PATTERN.test(value)) {
        hosts.push(value);
      } else if (key === "port" && /^\d+$/.test(value)) {
        ports[hosts.length ? hosts.length - 1 : 0] ??= value;
      }
    }
  }
  return hosts.map((host, index) =>
    ports[index] && !host.includes(":") ? `${host}:${ports[index]}` : host,
  );
}

// The hosts and database path of an authority, after its userinfo is gone.
function parseAuthority(text) {
  const parenthesized = text.startsWith("(") || /^[A-Za-z]+=\(/.test(text);
  if (parenthesized) {
    const close = text.lastIndexOf(")");
    const after = close >= 0 ? text.slice(close + 1) : "";
    return {
      hosts: parenthesizedHosts(text.slice(0, close + 1)),
      path: after.startsWith("/") ? cutAt(after, ["?", "#", ";", ":"]) : "",
    };
  }
  const end = indexOfAny(text, ADDRESS_END);
  const hostPart = end >= 0 ? text.slice(0, end) : text;
  const hosts = isHostList(hostPart) ? hostPart.split(",") : [];
  // DB2 and Informix append `:key=value;` properties to the database name.
  const path =
    hosts.length && end >= 0 && text[end] === "/"
      ? cutAt(text.slice(end), ["?", "#", ";", ":"])
      : "";
  return { hosts, path };
}

/**
 * Split a JDBC URL into its subprotocol, hosts and database path, dropping
 * anything that may carry credentials: userinfo, the `user/password@` prefix
 * Oracle takes, URL parameters, and the `;key=value` and `:key=value`
 * properties some drivers take. Host values that do not look like hosts are
 * dropped too, rather than passed on.
 *
 * @param {string} value JDBC URL.
 * @returns {{scheme: string, hosts: string[], address: string}|undefined}
 *   The first subprotocol, the hosts, and the address rebuilt from those
 *   parts; undefined for anything but a JDBC URL.
 */
function parseJdbcUrl(value) {
  const text = String(value || "").trim();
  if (!/^jdbc:/i.test(text)) {
    return undefined;
  }
  let rest = text.slice(5);
  const tokens = [];
  for (
    let token = /^[A-Za-z][\w+.-]*:/.exec(rest);
    token && !rest.startsWith("//");
    token = /^[A-Za-z][\w+.-]*:/.exec(rest)
  ) {
    tokens.push(token[0]);
    rest = rest.slice(token[0].length);
  }
  const scheme = (tokens[0] || "jdbc:").slice(0, -1).toLowerCase();
  if (rest.startsWith("//")) {
    const authority = rest.slice(2);
    const { hosts, path } = parseAuthority(
      authority.slice(userinfoEnd(authority) + 1),
    );
    return {
      scheme,
      hosts,
      address: `jdbc:${tokens.join("")}//${hosts.join(",")}${path}`,
    };
  }
  const at = userinfoEnd(rest);
  if (at < 0) {
    return {
      scheme,
      hosts: [],
      address: `jdbc:${tokens.join("")}${cutAt(rest, ["?", "#", ";"])}`,
    };
  }
  // `user/password@host:port:sid`: a word before the credentials can read as
  // a subprotocol (`jdbc:db:user:password@host`), so only the driver keeps
  // its tokens, and Oracle its driver type.
  const kept = tokens.slice(0, scheme === "oracle" ? 2 : 1).join("");
  const target = rest.slice(at + 1);
  if (target.startsWith("//")) {
    const { hosts, path } = parseAuthority(target.slice(2));
    return {
      scheme,
      hosts,
      address: `jdbc:${kept}@//${hosts.join(",")}${path}`,
    };
  }
  if (target.startsWith("(")) {
    const hosts = parenthesizedHosts(target);
    return { scheme, hosts, address: `jdbc:${kept}@${hosts.join(",")}` };
  }
  const address = cutAt(target, ["?", "#", ";", "/"]);
  const host = address.split(":")[0];
  const hosts = HOST_PATTERN.test(host) ? [host] : [];
  return {
    scheme,
    hosts,
    address: `jdbc:${kept}@${hosts.length ? address : ""}`,
  };
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
  const parsed = parseJdbcUrl(value);
  return parsed ? parsed.address : String(value || "").trim();
}

// The host name of `host`, `host:port` or `[ipv6]:port`.
function hostName(host) {
  if (host.startsWith("[")) {
    const close = host.indexOf("]");
    return close > 0 ? host.slice(1, close) : undefined;
  }
  return host.split(":")[0] || undefined;
}

function jdbcServiceName(value) {
  const { scheme, hosts } = parseJdbcUrl(value);
  return [scheme, hosts.length ? hostName(hosts[0]) : undefined]
    .filter(Boolean)
    .join("-");
}

// A host value as `host[:port]`, without a scheme, userinfo, path or
// parameters, or undefined when what is left is not a host.
function bareHost(value) {
  let text = String(value || "").trim();
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.exec(text);
  if (scheme) {
    text = text.slice(scheme[0].length);
  }
  text = cutAt(text.slice(userinfoEnd(text) + 1), ADDRESS_END);
  return HOST_PATTERN.test(text) ? text : undefined;
}

// The `host[:port]` a URL names. The userinfo is dropped before the URL is
// parsed: a password holding `/` would otherwise end the authority early and
// leave the user name to read as the host.
function urlHost(value) {
  const separator = value.indexOf("://");
  if (separator <= 0) {
    return undefined;
  }
  const rest = value.slice(separator + 3);
  const withoutUserinfo = rest.slice(userinfoEnd(rest) + 1);
  try {
    const host = new URL(`${value.slice(0, separator)}://${withoutUserinfo}`)
      .host;
    if (host) {
      return host;
    }
  } catch (_err) {
    // Not a URL the WHATWG parser takes; the host is read by hand.
  }
  return bareHost(withoutUserinfo);
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
    const host = bareHost(service.host);
    return host ? hostName(host) : undefined;
  }
  const host = urlHost(value);
  return host ? hostName(host) : undefined;
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
    return bareHost(service.host);
  }
  const host = urlHost(value);
  return host
    ? `${value.slice(0, value.indexOf("://")).toLowerCase()}://${host}`
    : undefined;
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
    return (
      scalaNamePlatform(name) === "js" ||
      parseScalaArtifact(name).artifactBase === "scalajs-library"
    );
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

function nodeModulesDepth(component) {
  const location = (component.properties || []).find(
    (property) => property.name === "internal:LocalNodeModulesPath",
  )?.value;
  return location
    ? location.split("node_modules/").length - 1
    : Number.POSITIVE_INFINITY;
}

function isPreferredNpmCopy(candidate, known) {
  const candidateDepth = nodeModulesDepth(candidate);
  const knownDepth = nodeModulesDepth(known);
  if (candidateDepth !== knownDepth) {
    return candidateDepth < knownDepth;
  }
  return candidate.purl < known.purl;
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
  // Of several versions of one package, the one a bare import resolves to is
  // the hoisted copy, the shallowest under node_modules; the first purl
  // breaks a tie, so the choice never depends on the order of the BOM.
  const npmByName = new Map();
  for (const component of components) {
    const name = npmNameFromPurl(component?.purl);
    if (!name) {
      continue;
    }
    const known = npmByName.get(name);
    if (!known || isPreferredNpmCopy(component, known)) {
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
