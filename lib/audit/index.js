import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

import { createBom } from "../cli/index.js";
import {
  getNonCycloneDxErrorMessage,
  isCycloneDxBom,
} from "../helpers/bomUtils.js";
import { thoughtLog } from "../helpers/logger.js";
import {
  cleanupSourceDir,
  findGitRefForPurlVersion,
  gitClone,
  hardenedGitCommand,
  resolveGitUrlFromPurl,
  resolvePurlSourceDirectory,
  sanitizeRemoteUrlForLogs,
} from "../helpers/source.js";
import { dirNameStr, safeExistsSync, safeMkdirSync } from "../helpers/utils.js";
import { auditBom } from "../stages/postgen/auditBom.js";
import { postProcess } from "../stages/postgen/postgen.js";
import { formatTargetLabel } from "./progress.js";
import { renderAuditReport } from "./reporters.js";
import { scoreTargetRisk, severityMeetsThreshold } from "./scoring.js";
import { collectAuditTargets, normalizePackageName } from "./targets.js";

export const DEFAULT_AUDIT_CATEGORIES = [
  "ci-permission",
  "dependency-source",
  "package-integrity",
];

const PYTHON_METADATA_FILES = ["pyproject.toml", "setup.cfg", "setup.py"];
const PYTHON_SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".tox",
  ".venv",
  "__pycache__",
  "build",
  "dist",
  "node_modules",
  "site-packages",
  "venv",
]);

/**
 * Read and validate a CycloneDX BOM file.
 *
 * @param {string} bomPath BOM file path
 * @returns {object} parsed CycloneDX BOM
 */
export function loadBomFile(bomPath) {
  const resolvedPath = resolve(bomPath);
  let bomJson;
  try {
    bomJson = JSON.parse(readFileSync(resolvedPath, "utf8"));
  } catch (error) {
    throw new Error(`Failed to parse ${resolvedPath}: ${error.message}`);
  }
  if (!isCycloneDxBom(bomJson)) {
    throw new Error(getNonCycloneDxErrorMessage(bomJson, "cdx-audit"));
  }
  return bomJson;
}

/**
 * Recursively list JSON files under a BOM directory.
 *
 * @param {string} bomDir directory path
 * @returns {string[]} discovered file paths
 */
export function listBomFiles(bomDir) {
  const foundFiles = [];
  const queue = [resolve(bomDir)];
  while (queue.length) {
    const currentDir = queue.shift();
    const entries = readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        queue.push(entryPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".json")) {
        foundFiles.push(entryPath);
      }
    }
  }
  return foundFiles.sort();
}

/**
 * Load input BOM files from either a single file or a directory.
 *
 * @param {object} options CLI options
 * @returns {{ source: string, bomJson: object }[]} loaded input BOMs
 */
export function loadInputBoms(options) {
  const inputBoms = [];
  if (options.bom) {
    inputBoms.push({
      bomJson: loadBomFile(options.bom),
      source: resolve(options.bom),
    });
  }
  if (options.bomDir) {
    const bomFiles = listBomFiles(options.bomDir);
    for (const bomFile of bomFiles) {
      try {
        inputBoms.push({
          bomJson: loadBomFile(bomFile),
          source: bomFile,
        });
      } catch (error) {
        console.warn(
          `Skipping non-CycloneDX JSON file '${bomFile}': ${error.message}`,
        );
      }
    }
  }
  return inputBoms;
}

/**
 * Read the package version from the local package.json file.
 *
 * @returns {string} package version
 */
function readPackageVersion() {
  const packageJson = JSON.parse(
    readFileSync(join(dirNameStr, "package.json"), "utf8"),
  );
  return packageJson.version;
}

/**
 * Build a deterministic directory-safe slug for report and workspace paths.
 *
 * @param {object} target audit target
 * @returns {string} slug string
 */
function targetSlug(target) {
  const packageName = target.namespace
    ? `${target.namespace}-${target.name}`
    : target.name;
  const normalized = normalizePackageName(packageName)
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const version = normalizePackageName(target.version || "latest") || "latest";
  const digest = createHash("sha256")
    .update(target.purl)
    .digest("hex")
    .slice(0, 12);
  return `${target.type}-${normalized || "package"}-${version}-${digest}`;
}

/**
 * Ensure a parent directory exists before writing a file.
 *
 * @param {string} filePath file path to create
 * @param {string} content file content
 * @returns {void}
 */
function writeTextFile(filePath, content) {
  const parentDir = dirname(filePath);
  if (!safeExistsSync(parentDir)) {
    safeMkdirSync(parentDir, { recursive: true });
  }
  writeFileSync(filePath, content);
}

/**
 * Ensure a parent directory exists before writing JSON.
 *
 * @param {string} filePath file path to create
 * @param {object} payload JSON payload
 * @returns {void}
 */
function writeJsonFile(filePath, payload) {
  writeTextFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

/**
 * Emit a progress event when a callback is configured.
 *
 * @param {object} options CLI options
 * @param {object} event progress event payload
 * @returns {void}
 */
function emitProgress(options, event) {
  if (typeof options?.onProgress === "function") {
    options.onProgress(event);
  }
}

/**
 * Clone a repository into a deterministic workspace directory.
 *
 * @param {string} repoUrl repository URL
 * @param {string} cloneDir target clone directory
 * @param {string | undefined} gitRef git ref to checkout
 * @returns {void}
 */
function cloneRepositoryToDir(repoUrl, cloneDir, gitRef) {
  const gitArgs = [
    "-c",
    "alias.clone=",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "safe.bareRepository=explicit",
    "-c",
    "core.hooksPath=/dev/null",
    "clone",
    "--template=",
    repoUrl,
    "--depth",
    "1",
    cloneDir,
  ];
  if (gitRef) {
    const cloneIndex = gitArgs.indexOf("clone");
    gitArgs.splice(cloneIndex + 1, 0, "--branch", gitRef);
  }
  const result = hardenedGitCommand(gitArgs);
  if (result.status !== 0) {
    const stderr = result.stderr
      ? result.stderr.toString()
      : "unknown git clone error";
    throw new Error(stderr.trim());
  }
}

/**
 * Reuse or create a checkout for a target repository.
 *
 * @param {object} target audit target
 * @param {object} resolution resolved repository metadata
 * @param {string | undefined} workspaceDir workspace directory
 * @param {string | undefined} gitRef git ref to checkout
 * @returns {{ cleanup: boolean, cloneDir: string, reused: boolean }} checkout info
 */
function ensureCheckout(target, resolution, workspaceDir, gitRef) {
  if (!workspaceDir) {
    return {
      cleanup: true,
      cloneDir: gitClone(resolution.repoUrl, gitRef),
      reused: false,
    };
  }
  const resolvedWorkspaceDir = resolve(workspaceDir);
  if (!safeExistsSync(resolvedWorkspaceDir)) {
    safeMkdirSync(resolvedWorkspaceDir, { recursive: true });
  }
  const cloneDir = join(resolvedWorkspaceDir, targetSlug(target));
  if (safeExistsSync(join(cloneDir, ".git"))) {
    return {
      cleanup: false,
      cloneDir,
      reused: true,
    };
  }
  if (safeExistsSync(cloneDir)) {
    throw new Error(
      `Workspace path '${cloneDir}' already exists but is not a git checkout.`,
    );
  }
  cloneRepositoryToDir(resolution.repoUrl, cloneDir, gitRef);
  return {
    cleanup: false,
    cloneDir,
    reused: false,
  };
}

/**
 * Extract an expected package name from Python packaging metadata.
 *
 * @param {string} filePath metadata file path
 * @returns {string | undefined} discovered package name
 */
function readPythonPackageName(filePath) {
  let fileContent;
  try {
    fileContent = readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
  const patterns = [
    /(^|\n)\s*name\s*=\s*["']([^"'\n]+)["']/m,
    /(^|\n)\s*name\s*=\s*([^\n#]+)/m,
    /setup\s*\([^)]*name\s*=\s*["']([^"']+)["']/ms,
  ];
  for (const pattern of patterns) {
    const match = fileContent.match(pattern);
    if (!match) {
      continue;
    }
    const packageName = (match[2] || match[1] || "").trim();
    if (packageName) {
      return packageName;
    }
  }
  return undefined;
}

/**
 * Resolve the most specific Python package directory inside a cloned repo.
 *
 * @param {string} cloneDir cloned repository root
 * @param {object} target audit target
 * @returns {{ confidence: string, scanDir: string }} selected directory and confidence
 */
export function resolvePythonSourceDirectory(cloneDir, target) {
  const normalizedTargetName = normalizePackageName(target.name);
  const queue = [cloneDir];
  const matches = [];
  while (queue.length) {
    const currentDir = queue.shift();
    let entries = [];
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (!PYTHON_SKIP_DIRS.has(entry.name)) {
          queue.push(entryPath);
        }
        continue;
      }
      if (!entry.isFile() || !PYTHON_METADATA_FILES.includes(entry.name)) {
        continue;
      }
      const packageName = readPythonPackageName(entryPath);
      if (normalizePackageName(packageName) === normalizedTargetName) {
        matches.push(currentDir);
      }
    }
  }
  if (!matches.length) {
    return {
      confidence: "low",
      scanDir: cloneDir,
    };
  }
  matches.sort((left, right) => left.length - right.length);
  return {
    confidence: matches[0] === cloneDir ? "medium" : "high",
    scanDir: matches[0],
  };
}

/**
 * Resolve the most appropriate scan directory for a cloned target repository.
 *
 * @param {string} cloneDir cloned repository root
 * @param {object} target audit target
 * @param {object} resolution repository resolution metadata
 * @returns {{ confidence: string, scanDir: string }} selected directory and confidence
 */
export function resolveTargetSourceDirectory(cloneDir, target, resolution) {
  if (target.type === "npm") {
    const scanDir = resolvePurlSourceDirectory(cloneDir, resolution);
    if (!scanDir) {
      return {
        confidence: "medium",
        scanDir: cloneDir,
      };
    }
    return {
      confidence: scanDir === cloneDir ? "medium" : "high",
      scanDir,
    };
  }
  if (target.type === "pypi") {
    return resolvePythonSourceDirectory(cloneDir, target);
  }
  return {
    confidence: "low",
    scanDir: cloneDir,
  };
}

/**
 * Build cdxgen options for a child source scan.
 *
 * @param {object} options CLI options
 * @param {object} target audit target
 * @returns {object} createBom options
 */
function buildChildOptions(options, target) {
  return {
    deep: true,
    failOnError: false,
    filePath: options.workspaceDir || process.cwd(),
    includeFormulation: true,
    installDeps: false,
    multiProject: true,
    profile: "threat-modeling",
    projectType: [target.type === "npm" ? "js" : "py"],
    specVersion: 1.7,
  };
}

/**
 * Analyze a single purl target by generating a child SBOM and auditing it.
 *
 * @param {object} target audit target
 * @param {object} options CLI options
 * @returns {Promise<object>} analyzed target result
 */
export async function auditTarget(target, options) {
  const categories = options.categories?.length
    ? options.categories
    : DEFAULT_AUDIT_CATEGORIES;
  const targetIndex = options._targetIndex || 0;
  const targetTotal = options._targetTotal || 0;
  const targetLabel = formatTargetLabel(target);
  const originalFetchPackageMetadata = process.env.CDXGEN_FETCH_PKG_METADATA;
  let checkout;
  try {
    emitProgress(options, {
      index: targetIndex,
      label: targetLabel,
      target,
      total: targetTotal,
      type: "target:stage",
      stage: "resolving repository metadata",
    });
    const resolution = await resolveGitUrlFromPurl(target.purl);
    if (!resolution?.repoUrl) {
      return {
        assessment: scoreTargetRisk([], target, { scanError: true }),
        error: "Unable to resolve repository URL from purl metadata.",
        findings: [],
        resolution,
        status: "skipped",
        target,
      };
    }
    const sanitizedRepoUrl = sanitizeRemoteUrlForLogs(resolution.repoUrl);
    thoughtLog("Preparing predictive audit target.", {
      purl: target.purl,
      repoUrl: sanitizedRepoUrl,
    });
    const gitRef = findGitRefForPurlVersion(resolution.repoUrl, resolution);
    emitProgress(options, {
      index: targetIndex,
      label: targetLabel,
      target,
      total: targetTotal,
      type: "target:stage",
      stage: gitRef ? `cloning source at ref ${gitRef}` : "cloning source",
    });
    checkout = ensureCheckout(target, resolution, options.workspaceDir, gitRef);
    const sourceSelection = resolveTargetSourceDirectory(
      checkout.cloneDir,
      target,
      resolution,
    );
    const childOptions = buildChildOptions(options, target);
    process.env.CDXGEN_FETCH_PKG_METADATA = "true";
    emitProgress(options, {
      index: targetIndex,
      label: targetLabel,
      target,
      total: targetTotal,
      type: "target:stage",
      stage: "generating child SBOM",
    });
    const bomNSData =
      (await createBom(sourceSelection.scanDir, childOptions)) || {};
    if (!bomNSData?.bomJson) {
      return {
        assessment: scoreTargetRisk([], target, { scanError: true }),
        error:
          "Unable to generate a child SBOM for the resolved source repository.",
        findings: [],
        repoUrl: sanitizedRepoUrl,
        resolution,
        status: "error",
        target,
      };
    }
    const processedBomNSData = postProcess(
      bomNSData,
      childOptions,
      sourceSelection.scanDir,
    );
    emitProgress(options, {
      index: targetIndex,
      label: targetLabel,
      target,
      total: targetTotal,
      type: "target:stage",
      stage: "evaluating audit rules",
    });
    const findings = await auditBom(processedBomNSData.bomJson, {
      bomAuditCategories: categories.join(","),
      bomAuditMinSeverity: options.minSeverity || "low",
    });
    const assessment = scoreTargetRisk(findings, target, {
      bomJson: processedBomNSData.bomJson,
      repoReused: checkout.reused,
      resolution,
      sourceDirectoryConfidence: sourceSelection.confidence,
      versionMatched: Boolean(gitRef),
    });
    const result = {
      assessment,
      findings,
      repoUrl: sanitizedRepoUrl,
      resolution,
      scanDir: sourceSelection.scanDir,
      status: "audited",
      target,
    };
    if (options.reportsDir) {
      const resultDir = join(resolve(options.reportsDir), targetSlug(target));
      safeMkdirSync(resultDir, { recursive: true });
      result.reportDir = resultDir;
      result.sourceBomFile = join(resultDir, "source-bom.json");
      result.findingsFile = join(resultDir, "findings.json");
      result.summaryFile = join(resultDir, "summary.json");
      writeJsonFile(result.sourceBomFile, processedBomNSData.bomJson);
      writeJsonFile(result.findingsFile, findings);
      writeJsonFile(result.summaryFile, {
        assessment,
        findingsCount: findings.length,
        repoUrl: sanitizedRepoUrl,
        sourceDirectoryConfidence: sourceSelection.confidence,
        status: result.status,
        target,
      });
    }
    return result;
  } catch (error) {
    const assessment = scoreTargetRisk([], target, { scanError: true });
    return {
      assessment,
      error: error.message,
      findings: [],
      status: "error",
      target,
    };
  } finally {
    if (originalFetchPackageMetadata === undefined) {
      delete process.env.CDXGEN_FETCH_PKG_METADATA;
    } else {
      process.env.CDXGEN_FETCH_PKG_METADATA = originalFetchPackageMetadata;
    }
    if (checkout?.cleanup) {
      cleanupSourceDir(checkout.cloneDir);
    }
  }
}

/**
 * Build an aggregate summary for all analyzed targets.
 *
 * @param {object[]} inputBoms loaded BOMs
 * @param {object[]} results target results
 * @param {object[]} skipped skipped component entries
 * @returns {object} summary object
 */
function summarizeAudit(inputBoms, results, skipped) {
  const severityCounts = {
    critical: 0,
    high: 0,
    low: 0,
    medium: 0,
    none: 0,
  };
  let scannedTargets = 0;
  let erroredTargets = 0;
  for (const result of results) {
    const severity = result?.assessment?.severity || "none";
    severityCounts[severity] = (severityCounts[severity] || 0) + 1;
    if (result.status === "audited") {
      scannedTargets += 1;
    }
    if (result.status === "error") {
      erroredTargets += 1;
    }
  }
  return {
    erroredTargets,
    inputBomCount: inputBoms.length,
    scannedTargets,
    severityCounts,
    skippedTargets:
      skipped.length +
      results.filter((result) => result.status === "skipped").length,
    totalTargets: results.length,
  };
}

/**
 * Run the predictive audit flow from one or more already-loaded CycloneDX BOM inputs.
 *
 * @param {{ source: string, bomJson: object }[]} inputBoms loaded CycloneDX BOM objects
 * @param {object} options CLI options
 * @returns {Promise<object>} aggregate audit report
 */
export async function runAuditFromBoms(inputBoms, options) {
  if (!inputBoms.length) {
    throw new Error("No CycloneDX BOM inputs were found.");
  }
  const extractedTargets = collectAuditTargets(inputBoms, options.maxTargets);
  const results = [];
  if (extractedTargets.targets.length) {
    emitProgress(options, {
      total: extractedTargets.targets.length,
      type: "run:start",
    });
  }
  for (const [index, target] of extractedTargets.targets.entries()) {
    const targetIndex = index + 1;
    emitProgress(options, {
      index: targetIndex,
      label: formatTargetLabel(target),
      target,
      total: extractedTargets.targets.length,
      type: "target:start",
    });
    const result = await auditTarget(target, {
      ...options,
      _targetIndex: targetIndex,
      _targetTotal: extractedTargets.targets.length,
    });
    results.push(result);
    emitProgress(options, {
      index: targetIndex,
      label: formatTargetLabel(target),
      result,
      target,
      total: extractedTargets.targets.length,
      type: "target:finish",
    });
  }
  const report = {
    generatedAt: new Date().toISOString(),
    inputs: inputBoms.map((inputBom) => inputBom.source),
    results,
    skipped: extractedTargets.skipped,
    summary: summarizeAudit(inputBoms, results, extractedTargets.skipped),
    tool: {
      name: "cdx-audit",
      version: readPackageVersion(),
    },
  };
  if (options.reportsDir) {
    const aggregateFile = join(
      resolve(options.reportsDir),
      "aggregate-report.json",
    );
    writeJsonFile(aggregateFile, report);
    report.aggregateReportFile = aggregateFile;
  }
  if (extractedTargets.targets.length) {
    emitProgress(options, {
      summary: report.summary,
      type: "run:finish",
    });
  }
  return report;
}

/**
 * Run the predictive audit flow from one or more CycloneDX BOM inputs.
 *
 * @param {object} options CLI options
 * @returns {Promise<object>} aggregate audit report
 */
export async function runAudit(options) {
  const inputBoms = loadInputBoms(options);
  return runAuditFromBoms(inputBoms, options);
}

/**
 * Render a report and compute the proper process exit code.
 *
 * @param {object} report aggregate report
 * @param {object} options CLI options
 * @returns {{ exitCode: number, output: string }} rendered output and exit code
 */
export function finalizeAuditReport(report, options) {
  const output = renderAuditReport(options.report, report, {
    minSeverity: options.minSeverity,
  });
  const shouldFail = report.results.some((result) =>
    severityMeetsThreshold(
      result?.assessment?.severity || "none",
      options.failSeverity || "high",
    ),
  );
  return {
    exitCode: shouldFail ? 3 : 0,
    output,
  };
}

/**
 * Build a result file name for user-provided report output paths.
 *
 * @param {object} options CLI options
 * @returns {string | undefined} output file path
 */
export function defaultOutputFile(options) {
  if (!options.reportsDir) {
    return undefined;
  }
  return join(
    resolve(options.reportsDir),
    `cdx-audit-report.${options.report || "console"}.txt`,
  );
}
