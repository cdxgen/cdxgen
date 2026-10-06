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
  const filtered = [...new Set((values || []).filter(Boolean))].sort();
  return filtered.length ? filtered.join(",") : undefined;
}

