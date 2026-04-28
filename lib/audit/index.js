import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";

import { createBom } from "../cli/index.js";
import {
  getNonCycloneDxErrorMessage,
  isCycloneDxBom,
} from "../helpers/bomUtils.js";
import { thoughtLog } from "../helpers/logger.js";
import {
  hasRegistryProvenanceEvidenceProperties,
  hasTrustedPublishingProperties,
} from "../helpers/provenanceUtils.js";
import {
  cleanupSourceDir,
  findGitRefForPurlVersion,
  hardenedGitCommand,
  resolveGitUrlFromPurl,
  resolvePurlSourceDirectory,
  sanitizeRemoteUrlForLogs,
} from "../helpers/source.js";
import {
  dirNameStr,
  getTmpDir,
  safeExistsSync,
  safeMkdirSync,
} from "../helpers/utils.js";
import { auditBom } from "../stages/postgen/auditBom.js";
import { postProcess } from "../stages/postgen/postgen.js";
import { formatTargetLabel } from "./progress.js";
import { renderAuditReport } from "./reporters.js";
import {
  SEVERITY_ORDER,
  scoreTargetRisk,
  severityMeetsThreshold,
} from "./scoring.js";
import { collectAuditTargets, normalizePackageName } from "./targets.js";

export const DEFAULT_AUDIT_CATEGORIES = [
  "ci-permission",
  "dependency-source",
  "package-integrity",
];

const AUDIT_CACHE_DIRNAME = ".cdx-audit";
const AUDIT_CACHE_BOM_FILE = "source-bom.json";
const AUDIT_CACHE_META_FILE = "source-bom.meta.json";
const CLONE_RETRY_DELAYS_MS = [750, 1500];
const LARGE_PREDICTIVE_AUDIT_THRESHOLD = 50;
const VERY_LARGE_PREDICTIVE_AUDIT_THRESHOLD = 100;

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

function sleep(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function isPathWithin(parentDir, childPath) {
  const normalizePath = (candidatePath) => {
    try {
      return realpathSync.native
        ? realpathSync.native(candidatePath)
        : realpathSync(candidatePath);
    } catch {
      return resolve(candidatePath);
    }
  };
  const normalizedChild = normalizePath(childPath);
  const candidateParents = [parentDir];
  if (process.platform !== "win32") {
    candidateParents.push("/tmp");
    candidateParents.push("/private/tmp");
  }
  return candidateParents.some((candidateParent) => {
    const normalizedParent = normalizePath(candidateParent);
    return (
      normalizedChild === normalizedParent ||
      normalizedChild.startsWith(`${normalizedParent}/`)
    );
  });
}

function isTemporaryWorkspaceDir(workspaceDir) {
  return workspaceDir ? isPathWithin(getTmpDir(), workspaceDir) : false;
}

function prepareWorkspaceContext(options = {}) {
  if (!options.workspaceDir) {
    return {
      cleanupOnFinish: false,
      workspaceDir: undefined,
    };
  }
  const workspaceDir = resolve(options.workspaceDir);
  const existed = safeExistsSync(workspaceDir);
  if (!existed) {
    safeMkdirSync(workspaceDir, { recursive: true });
  }
  return {
    cleanupOnFinish: !existed && isTemporaryWorkspaceDir(workspaceDir),
    workspaceDir,
  };
}

function getWorkspaceTargetDir(workspaceDir, target) {
  return join(resolve(workspaceDir), targetSlug(target));
}

function getWorkspaceCachePaths(workspaceDir, target) {
  const targetDir = getWorkspaceTargetDir(workspaceDir, target);
  const cacheDir = join(targetDir, AUDIT_CACHE_DIRNAME);
  return {
    cacheDir,
    metadataFile: join(cacheDir, AUDIT_CACHE_META_FILE),
    sourceBomFile: join(cacheDir, AUDIT_CACHE_BOM_FILE),
    targetDir,
  };
}

function loadCachedChildBom(workspaceDir, target) {
  if (!workspaceDir) {
    return undefined;
  }
  const cachePaths = getWorkspaceCachePaths(workspaceDir, target);
  if (!safeExistsSync(cachePaths.sourceBomFile)) {
    return undefined;
  }
  try {
    const bomJson = loadBomFile(cachePaths.sourceBomFile);
    let metadata = {};
    if (safeExistsSync(cachePaths.metadataFile)) {
      metadata = JSON.parse(readFileSync(cachePaths.metadataFile, "utf8"));
    }
    const scanDir = metadata.scanDirRelative
      ? resolve(cachePaths.targetDir, metadata.scanDirRelative)
      : cachePaths.targetDir;
    return {
      bomJson,
      cacheDir: cachePaths.cacheDir,
      repoUrl: metadata.repoUrl,
      resolution: metadata.resolution,
      scanDir,
      sourceDirectoryConfidence: metadata.sourceDirectoryConfidence || "medium",
      versionMatched: metadata.versionMatched !== false,
    };
  } catch {
    return undefined;
  }
}

function writeCachedChildBom(workspaceDir, target, payload) {
  if (!workspaceDir || !payload?.bomJson) {
    return;
  }
  const cachePaths = getWorkspaceCachePaths(workspaceDir, target);
  safeMkdirSync(cachePaths.cacheDir, { recursive: true });
  writeJsonFile(cachePaths.sourceBomFile, payload.bomJson);
  writeJsonFile(cachePaths.metadataFile, {
    generatedAt: new Date().toISOString(),
    repoUrl: payload.repoUrl,
    resolution: payload.resolution,
    scanDirRelative: payload.scanDir
      ? relative(cachePaths.targetDir, resolve(payload.scanDir)) || "."
      : ".",
    sourceDirectoryConfidence: payload.sourceDirectoryConfidence,
    versionMatched: payload.versionMatched,
  });
}

function persistAuditArtifacts(result, options, sourceBomJson) {
  if (!options.reportsDir) {
    return result;
  }
  const resultDir = join(
    resolve(options.reportsDir),
    targetSlug(result.target),
  );
  safeMkdirSync(resultDir, { recursive: true });
  result.reportDir = resultDir;
  result.findingsFile = join(resultDir, "findings.json");
  result.summaryFile = join(resultDir, "summary.json");
  if (sourceBomJson) {
    result.sourceBomFile = join(resultDir, "source-bom.json");
    writeJsonFile(result.sourceBomFile, sourceBomJson);
  }
  writeJsonFile(result.findingsFile, result.findings || []);
  writeJsonFile(result.summaryFile, {
    assessment: result.assessment,
    cacheHit: result.cacheHit || false,
    error: result.error,
    errorType: result.errorType,
    findingsCount: result.findings?.length || 0,
    repoUrl: result.repoUrl,
    sourceDirectoryConfidence: result.sourceDirectoryConfidence,
    status: result.status,
    target: result.target,
  });
  return result;
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

function buildPredictiveAuditEstimate(selectedTargets) {
  if (selectedTargets >= VERY_LARGE_PREDICTIVE_AUDIT_THRESHOLD) {
    return "This may take 10+ minutes depending on repository lookups and child SBOM generation.";
  }
  if (selectedTargets >= LARGE_PREDICTIVE_AUDIT_THRESHOLD) {
    return "This may take several minutes depending on repository lookups and child SBOM generation.";
  }
  return undefined;
}

function buildPredictiveAuditPreflightMessage(extractedTargets, options) {
  const selectedTargets = extractedTargets?.targets?.length || 0;
  const availableTargets = extractedTargets?.stats?.availableTargets || 0;
  const requiredTargets = extractedTargets?.stats?.requiredTargets || 0;
  const trustedTargetsExcluded =
    extractedTargets?.stats?.trustedTargetsExcluded || 0;
  const truncatedTargets = extractedTargets?.stats?.truncatedTargets || 0;
  const estimate = buildPredictiveAuditEstimate(selectedTargets);
  const trustedHint = options?.trustedSelectionHelp
    ? ` ${options.trustedSelectionHelp}`
    : "";
  const trustedExclusionMessage = trustedTargetsExcluded
    ? ` Skipping ${trustedTargetsExcluded} trusted-publishing-backed package(s) by default.${trustedHint}`
    : "";
  if (!estimate && availableTargets < LARGE_PREDICTIVE_AUDIT_THRESHOLD) {
    return trustedTargetsExcluded ? trustedExclusionMessage.trim() : undefined;
  }
  if (options?.scope === "required") {
    return `Predictive audit will scan ${selectedTargets} required package(s). ${estimate || "Large required-only scans may still take a while depending on repository lookups and child SBOM generation."}${trustedExclusionMessage}`;
  }
  if (truncatedTargets > 0) {
    const additionalTargets = Math.max(0, selectedTargets - requiredTargets);
    return `Predictive audit selected ${selectedTargets} of ${availableTargets} package(s) (${requiredTargets} required${additionalTargets ? ` + ${additionalTargets} additional` : ""}) using required-first prioritization. ${estimate || "This run was trimmed to keep audit time reasonable."}${trustedExclusionMessage}`;
  }
  return `Predictive audit will scan ${selectedTargets} package(s). ${estimate || "Large predictive audits may still take a while depending on repository lookups and child SBOM generation."}${trustedExclusionMessage}`;
}

/**
 * Read a custom property from a target descriptor.
 *
 * @param {object} target audit target
 * @param {string} propertyName property name
 * @returns {string | undefined} property value
 */
function getTargetProperty(target, propertyName) {
  return target?.properties?.find((property) => property.name === propertyName)
    ?.value;
}

function getTargetNumberProperty(target, propertyName) {
  const value = getTargetProperty(target, propertyName);
  if (!value) {
    return undefined;
  }
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : undefined;
}

function getTargetTimestampProperty(target, propertyName) {
  const value = getTargetProperty(target, propertyName);
  if (!value) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

function getTargetListProperty(target, propertyName) {
  const value = getTargetProperty(target, propertyName);
  if (!value) {
    return [];
  }
  return [
    ...new Set(
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}

function isEstablishedPackage(target, propertyPrefix) {
  const packageCreatedTime = getTargetTimestampProperty(
    target,
    `${propertyPrefix}:packageCreatedTime`,
  );
  const versionCount = getTargetNumberProperty(
    target,
    `${propertyPrefix}:versionCount`,
  );
  if (!packageCreatedTime || !versionCount) {
    return false;
  }
  const packageAgeMs = Date.now() - packageCreatedTime;
  return packageAgeMs >= 1000 * 60 * 60 * 24 * 30 && versionCount >= 3;
}

function isRecentRelease(target, propertyPrefix) {
  const publishTime = getTargetTimestampProperty(
    target,
    `${propertyPrefix}:publishTime`,
  );
  if (!publishTime) {
    return false;
  }
  const releaseAgeMs = Date.now() - publishTime;
  return releaseAgeMs >= 0 && releaseAgeMs <= 1000 * 60 * 60 * 72;
}

function hasPublisherDrift(target, propertyPrefix) {
  return (
    getTargetProperty(target, `${propertyPrefix}:publisherDrift`) === "true"
  );
}

function hasMaintainerSetDrift(target, propertyPrefix) {
  return (
    getTargetProperty(target, `${propertyPrefix}:maintainerSetDrift`) ===
      "true" ||
    getTargetProperty(target, `${propertyPrefix}:uploaderSetDrift`) === "true"
  );
}

function hasPartialIdentitySetDrift(target, propertyPrefix) {
  const explicitPropertyName =
    propertyPrefix === "cdx:npm"
      ? `${propertyPrefix}:maintainerSetPartialDrift`
      : `${propertyPrefix}:uploaderSetPartialDrift`;
  if (getTargetProperty(target, explicitPropertyName) === "true") {
    return true;
  }
  const currentPropertyName =
    propertyPrefix === "cdx:npm"
      ? `${propertyPrefix}:maintainerSet`
      : `${propertyPrefix}:uploaderSet`;
  const priorPropertyName =
    propertyPrefix === "cdx:npm"
      ? `${propertyPrefix}:priorMaintainerSet`
      : `${propertyPrefix}:priorUploaderSet`;
  const currentSet = getTargetListProperty(target, currentPropertyName);
  const priorSet = getTargetListProperty(target, priorPropertyName);
  if (!currentSet.length || !priorSet.length) {
    return false;
  }
  const priorValues = new Set(priorSet);
  const overlapCount = currentSet.filter((value) =>
    priorValues.has(value),
  ).length;
  if (overlapCount === 0) {
    return false;
  }
  const unionCount = new Set([...currentSet, ...priorSet]).size;
  return (
    overlapCount < unionCount &&
    (overlapCount < currentSet.length || overlapCount < priorSet.length)
  );
}

function hasDormantReleaseGapAnomaly(target, propertyPrefix) {
  const currentGapDays = getTargetNumberProperty(
    target,
    `${propertyPrefix}:releaseGapDays`,
  );
  const baselineGapDays = getTargetNumberProperty(
    target,
    `${propertyPrefix}:releaseGapBaselineDays`,
  );
  const sampleSize = getTargetNumberProperty(
    target,
    `${propertyPrefix}:releaseGapSampleSize`,
  );
  if (!currentGapDays || !baselineGapDays || !sampleSize || sampleSize < 3) {
    return false;
  }
  return currentGapDays >= Math.max(90, baselineGapDays * 8);
}

function hasCompressedCadence(target, propertyPrefix) {
  if (
    getTargetProperty(target, `${propertyPrefix}:compressedCadence`) === "true"
  ) {
    return true;
  }
  const currentGapDays = getTargetNumberProperty(
    target,
    `${propertyPrefix}:releaseGapDays`,
  );
  const baselineGapDays = getTargetNumberProperty(
    target,
    `${propertyPrefix}:releaseGapBaselineDays`,
  );
  const sampleSize = getTargetNumberProperty(
    target,
    `${propertyPrefix}:releaseGapSampleSize`,
  );
  if (
    currentGapDays === undefined ||
    baselineGapDays === undefined ||
    sampleSize === undefined ||
    sampleSize < 3 ||
    currentGapDays <= 0 ||
    baselineGapDays <= 0 ||
    baselineGapDays < 21
  ) {
    return false;
  }
  return currentGapDays <= 14 && currentGapDays / baselineGapDays <= 0.33;
}

/**
 * Build low-noise provenance-aware contextual findings from the root BOM target.
 *
 * These are intentionally conservative and only fire when there is explicit risk
 * posture already present in the target metadata.
 *
 * @param {object} target audit target
 * @returns {object[]} contextual findings
 */
export function buildTargetContextFindings(target) {
  const findings = [];
  const hasTrustedPublishing = hasTrustedPublishingProperties(
    target?.properties,
  );
  const hasProvenanceEvidence = hasRegistryProvenanceEvidenceProperties(
    target?.properties,
  );
  if (target.type === "npm") {
    const hasInstallScript =
      getTargetProperty(target, "cdx:npm:hasInstallScript") === "true";
    const establishedPackage = isEstablishedPackage(target, "cdx:npm");
    const recentRelease = isRecentRelease(target, "cdx:npm");
    const publisherDrift = hasPublisherDrift(target, "cdx:npm");
    const maintainerSetDrift = hasMaintainerSetDrift(target, "cdx:npm");
    const partialMaintainerSetDrift = hasPartialIdentitySetDrift(
      target,
      "cdx:npm",
    );
    const dormantReleaseGapAnomaly = hasDormantReleaseGapAnomaly(
      target,
      "cdx:npm",
    );
    const compressedCadence = hasCompressedCadence(target, "cdx:npm");
    if (
      target.version &&
      hasInstallScript &&
      !hasTrustedPublishing &&
      !hasProvenanceEvidence
    ) {
      findings.push({
        category: "package-integrity",
        description:
          "Install-time execution combined with missing registry-visible provenance raises future tampering risk.",
        location: {
          bomRef: target.bomRefs?.[0],
          purl: target.purl,
        },
        message: `npm package '${target.name}@${target.version}' has install-time execution hooks but no registry-visible trusted publishing or provenance evidence.`,
        mitigation:
          "Prefer versions with registry-visible provenance evidence, review install scripts carefully, and pin/allowlist publishers for high-risk packages.",
        ruleId: "PROV-001",
        severity: "medium",
      });
    }
    if (
      target.version &&
      establishedPackage &&
      recentRelease &&
      hasInstallScript &&
      !hasTrustedPublishing &&
      !hasProvenanceEvidence
    ) {
      findings.push({
        category: "package-integrity",
        description:
          "A very recent release on a mature package, combined with install-time execution and missing provenance, deserves extra scrutiny before adoption.",
        location: {
          bomRef: target.bomRefs?.[0],
          purl: target.purl,
        },
        message: `npm package '${target.name}@${target.version}' is a very recent release on an established package and still lacks registry-visible provenance.`,
        mitigation:
          "Delay adoption briefly, verify publisher identity, and prefer registry-visible provenance for high-risk packages with install hooks.",
        ruleId: "PROV-003",
        severity: "low",
      });
    }
    if (
      target.version &&
      establishedPackage &&
      publisherDrift &&
      hasInstallScript &&
      !hasTrustedPublishing &&
      !hasProvenanceEvidence
    ) {
      findings.push({
        category: "package-integrity",
        description:
          "Publisher drift on mature packages can be legitimate, but becomes more concerning when install-time execution is present and provenance is weak.",
        location: {
          bomRef: target.bomRefs?.[0],
          purl: target.purl,
        },
        message: `npm package '${target.name}@${target.version}' was published by a different identity than the prior release and lacks registry-visible provenance.`,
        mitigation:
          "Review maintainer changes, compare the prior release publisher, and validate provenance before upgrading execution-capable packages.",
        ruleId: "PROV-004",
        severity: "medium",
      });
    }
    if (
      target.version &&
      establishedPackage &&
      maintainerSetDrift &&
      hasInstallScript &&
      !hasTrustedPublishing &&
      !hasProvenanceEvidence
    ) {
      findings.push({
        category: "package-integrity",
        description:
          "Maintainer-set drift on execution-capable packages is a triage signal when the resolved release also lacks registry-visible provenance.",
        location: {
          bomRef: target.bomRefs?.[0],
          purl: target.purl,
        },
        message: `npm package '${target.name}@${target.version}' has a fully different maintainer identity set than the prior release and lacks registry-visible provenance.`,
        mitigation:
          "Compare the prior and current maintainer sets, verify maintainer transitions, and prefer releases with provenance before upgrading packages with install hooks.",
        ruleId: "PROV-007",
        severity: "medium",
      });
    }
    if (
      target.version &&
      establishedPackage &&
      partialMaintainerSetDrift &&
      !maintainerSetDrift &&
      hasInstallScript &&
      !hasTrustedPublishing &&
      !hasProvenanceEvidence
    ) {
      findings.push({
        category: "package-integrity",
        description:
          "Partial maintainer-set drift is a low-severity triage signal when execution-capable releases retain some identities but also introduce maintainer churn without registry-visible provenance.",
        location: {
          bomRef: target.bomRefs?.[0],
          purl: target.purl,
        },
        message: `npm package '${target.name}@${target.version}' retains only part of the prior maintainer identity set and lacks registry-visible provenance.`,
        mitigation:
          "Review which maintainer identities changed, compare against the prior release, and validate the transition before upgrading packages with install hooks.",
        ruleId: "PROV-011",
        severity: "low",
      });
    }
    if (
      target.version &&
      establishedPackage &&
      dormantReleaseGapAnomaly &&
      hasInstallScript &&
      !hasTrustedPublishing &&
      !hasProvenanceEvidence
    ) {
      findings.push({
        category: "package-integrity",
        description:
          "A long dormant gap followed by a new execution-capable release can warrant a short review window when provenance is missing.",
        location: {
          bomRef: target.bomRefs?.[0],
          purl: target.purl,
        },
        message: `npm package '${target.name}@${target.version}' arrived after an unusually long release gap and lacks registry-visible provenance.`,
        mitigation:
          "Review the release diff, compare against the prior version, and validate maintainer continuity before adopting after long dormancy.",
        ruleId: "PROV-008",
        severity: "low",
      });
    }
    if (
      target.version &&
      establishedPackage &&
      compressedCadence &&
      hasInstallScript &&
      !hasTrustedPublishing &&
      !hasProvenanceEvidence
    ) {
      findings.push({
        category: "package-integrity",
        description:
          "A materially faster-than-usual release on a mature execution-capable package is a low-severity review signal when registry-visible provenance is absent.",
        location: {
          bomRef: target.bomRefs?.[0],
          purl: target.purl,
        },
        message: `npm package '${target.name}@${target.version}' arrived materially faster than its prior release cadence and lacks registry-visible provenance.`,
        mitigation:
          "Review the release diff, compare the release timing against prior cadence, and validate the publisher transition before rapid upgrades of execution-capable packages.",
        ruleId: "PROV-012",
        severity: "low",
      });
    }
  }
  if (target.type === "pypi") {
    const registry = getTargetProperty(target, "cdx:pypi:registry");
    const isDefaultRegistry =
      !registry ||
      ["https://pypi.org", "https://pypi.org/simple"].includes(registry);
    const uploaderVerified =
      getTargetProperty(target, "cdx:pypi:uploaderVerified") === "true";
    const establishedPackage = isEstablishedPackage(target, "cdx:pypi");
    const recentRelease = isRecentRelease(target, "cdx:pypi");
    const publisherDrift = hasPublisherDrift(target, "cdx:pypi");
    const maintainerSetDrift = hasMaintainerSetDrift(target, "cdx:pypi");
    const partialMaintainerSetDrift = hasPartialIdentitySetDrift(
      target,
      "cdx:pypi",
    );
    const dormantReleaseGapAnomaly = hasDormantReleaseGapAnomaly(
      target,
      "cdx:pypi",
    );
    const compressedCadence = hasCompressedCadence(target, "cdx:pypi");
    if (
      target.version &&
      isDefaultRegistry &&
      !hasTrustedPublishing &&
      !hasProvenanceEvidence &&
      !uploaderVerified
    ) {
      findings.push({
        category: "package-integrity",
        description:
          "Default-registry PyPI packages without provenance or verified uploader context are weaker candidates for publisher-trust decisions.",
        location: {
          bomRef: target.bomRefs?.[0],
          purl: target.purl,
        },
        message: `PyPI package '${target.name}@${target.version}' lacks registry-visible provenance and uploader verification signals.`,
        mitigation:
          "Prefer releases with provenance evidence or verified uploader metadata, especially for sensitive or newly introduced dependencies.",
        ruleId: "PROV-002",
        severity: "low",
      });
    }
    if (
      target.version &&
      isDefaultRegistry &&
      establishedPackage &&
      recentRelease &&
      !hasTrustedPublishing &&
      !hasProvenanceEvidence &&
      !uploaderVerified
    ) {
      findings.push({
        category: "package-integrity",
        description:
          "Very recent releases on mature packages can benefit from a short review window when provenance and uploader-verification signals are absent.",
        location: {
          bomRef: target.bomRefs?.[0],
          purl: target.purl,
        },
        message: `PyPI package '${target.name}@${target.version}' is a very recent release on an established package without provenance or uploader verification signals.`,
        mitigation:
          "Delay adoption briefly, compare the release to the previous known-good version, and prefer verified/provenance-backed uploads for sensitive dependencies.",
        ruleId: "PROV-005",
        severity: "low",
      });
    }
    if (
      target.version &&
      isDefaultRegistry &&
      establishedPackage &&
      publisherDrift &&
      !hasTrustedPublishing &&
      !hasProvenanceEvidence &&
      !uploaderVerified
    ) {
      findings.push({
        category: "package-integrity",
        description:
          "Uploader drift on established PyPI packages is usually a triage signal, but becomes more meaningful when provenance and verification are missing.",
        location: {
          bomRef: target.bomRefs?.[0],
          purl: target.purl,
        },
        message: `PyPI package '${target.name}@${target.version}' was uploaded by a different identity than the prior release and lacks provenance or uploader verification signals.`,
        mitigation:
          "Review the uploader change, compare the prior release uploader, and validate project ownership before upgrading critical dependencies.",
        ruleId: "PROV-006",
        severity: "low",
      });
    }
    if (
      target.version &&
      isDefaultRegistry &&
      establishedPackage &&
      maintainerSetDrift &&
      !hasTrustedPublishing &&
      !hasProvenanceEvidence &&
      !uploaderVerified
    ) {
      findings.push({
        category: "package-integrity",
        description:
          "Uploader-set drift on established PyPI packages is a triage signal when provenance and uploader verification are absent.",
        location: {
          bomRef: target.bomRefs?.[0],
          purl: target.purl,
        },
        message: `PyPI package '${target.name}@${target.version}' has a fully different uploader identity set than the prior release and lacks provenance or uploader verification signals.`,
        mitigation:
          "Review uploader transitions, compare the prior release uploader set, and validate project ownership before upgrading sensitive dependencies.",
        ruleId: "PROV-009",
        severity: "low",
      });
    }
    if (
      target.version &&
      isDefaultRegistry &&
      establishedPackage &&
      partialMaintainerSetDrift &&
      !maintainerSetDrift &&
      !hasTrustedPublishing &&
      !hasProvenanceEvidence &&
      !uploaderVerified
    ) {
      findings.push({
        category: "package-integrity",
        description:
          "Partial uploader-set drift is a low-severity review signal on established PyPI packages when provenance and uploader verification are absent.",
        location: {
          bomRef: target.bomRefs?.[0],
          purl: target.purl,
        },
        message: `PyPI package '${target.name}@${target.version}' retains only part of the prior uploader identity set and lacks provenance or uploader verification signals.`,
        mitigation:
          "Review which uploader identities changed, compare the release against the prior version, and validate project ownership before upgrading sensitive dependencies.",
        ruleId: "PROV-013",
        severity: "low",
      });
    }
    if (
      target.version &&
      isDefaultRegistry &&
      establishedPackage &&
      dormantReleaseGapAnomaly &&
      !hasTrustedPublishing &&
      !hasProvenanceEvidence &&
      !uploaderVerified
    ) {
      findings.push({
        category: "package-integrity",
        description:
          "Established packages resurfacing after a long dormant gap benefit from extra review when provenance is weak.",
        location: {
          bomRef: target.bomRefs?.[0],
          purl: target.purl,
        },
        message: `PyPI package '${target.name}@${target.version}' followed an unusually long release gap and lacks provenance or uploader verification signals.`,
        mitigation:
          "Compare the release to the prior known-good version and review maintainership continuity before adopting after long dormancy.",
        ruleId: "PROV-010",
        severity: "low",
      });
    }
    if (
      target.version &&
      isDefaultRegistry &&
      establishedPackage &&
      compressedCadence &&
      !hasTrustedPublishing &&
      !hasProvenanceEvidence &&
      !uploaderVerified
    ) {
      findings.push({
        category: "package-integrity",
        description:
          "Materially faster-than-usual release timing is a low-severity triage signal on mature PyPI packages when provenance and uploader verification remain weak.",
        location: {
          bomRef: target.bomRefs?.[0],
          purl: target.purl,
        },
        message: `PyPI package '${target.name}@${target.version}' arrived materially faster than its prior release cadence and lacks provenance or uploader verification signals.`,
        mitigation:
          "Compare the release timing and contents against prior versions, then validate uploader continuity before rapid upgrades of sensitive dependencies.",
        ruleId: "PROV-014",
        severity: "low",
      });
    }
  }
  return findings;
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
    const error = new Error(stderr.trim());
    error.retryable =
      /(timed out|unable to connect|could not resolve host|network is unreachable|connection reset|connection refused|temporary failure|remote end hung up unexpectedly|http 5\d\d|tls|econnreset|econnrefused|etimedout)/i.test(
        stderr,
      );
    error.errorType = error.retryable ? "network" : "clone";
    throw error;
  }
}

async function cloneRepositoryToDirWithRetry(repoUrl, cloneDir, gitRef) {
  let lastError;
  for (let attempt = 0; attempt <= CLONE_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      cloneRepositoryToDir(repoUrl, cloneDir, gitRef);
      return;
    } catch (error) {
      lastError = error;
      rmSync(cloneDir, { force: true, recursive: true });
      if (!error?.retryable || attempt >= CLONE_RETRY_DELAYS_MS.length) {
        break;
      }
      await sleep(CLONE_RETRY_DELAYS_MS[attempt]);
    }
  }
  const sanitizedRepoUrl = sanitizeRemoteUrlForLogs(repoUrl);
  const message = lastError?.message || "unknown git clone error";
  const error = new Error(
    `Unable to clone '${sanitizedRepoUrl}' after ${CLONE_RETRY_DELAYS_MS.length + 1} attempt(s): ${message}`,
  );
  error.errorType = lastError?.errorType || "clone";
  error.retryable = Boolean(lastError?.retryable);
  throw error;
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
async function ensureCheckout(target, resolution, workspaceDir, gitRef) {
  if (!workspaceDir) {
    const cloneDir = mkdtempSync(join(getTmpDir(), `${targetSlug(target)}-`));
    await cloneRepositoryToDirWithRetry(resolution.repoUrl, cloneDir, gitRef);
    return {
      cleanup: true,
      cloneDir,
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
    rmSync(cloneDir, { force: true, recursive: true });
  }
  await cloneRepositoryToDirWithRetry(resolution.repoUrl, cloneDir, gitRef);
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
  let processedBomJson;
  let resolution;
  let sourceSelection;
  let cacheHit = false;
  let sanitizedRepoUrl;
  let versionMatched = false;
  try {
    const cachedChildBom = loadCachedChildBom(options.workspaceDir, target);
    if (cachedChildBom) {
      cacheHit = true;
      processedBomJson = cachedChildBom.bomJson;
      resolution = cachedChildBom.resolution;
      sanitizedRepoUrl = cachedChildBom.repoUrl;
      sourceSelection = {
        confidence: cachedChildBom.sourceDirectoryConfidence,
        scanDir: cachedChildBom.scanDir,
      };
      versionMatched = cachedChildBom.versionMatched;
      emitProgress(options, {
        index: targetIndex,
        label: targetLabel,
        target,
        total: targetTotal,
        type: "target:stage",
        stage: "reusing cached child SBOM",
      });
    } else {
      emitProgress(options, {
        index: targetIndex,
        label: targetLabel,
        target,
        total: targetTotal,
        type: "target:stage",
        stage: "resolving repository metadata",
      });
      resolution = await resolveGitUrlFromPurl(target.purl);
      if (!resolution?.repoUrl) {
        return persistAuditArtifacts(
          {
            assessment: scoreTargetRisk([], target, {
              skipReason:
                "Unable to resolve repository URL from purl metadata.",
            }),
            error: "Unable to resolve repository URL from purl metadata.",
            findings: [],
            resolution,
            status: "skipped",
            target,
          },
          options,
        );
      }
      sanitizedRepoUrl = sanitizeRemoteUrlForLogs(resolution.repoUrl);
      thoughtLog("Preparing predictive audit target.", {
        purl: target.purl,
        repoUrl: sanitizedRepoUrl,
      });
      const gitRef = findGitRefForPurlVersion(resolution.repoUrl, resolution);
      versionMatched = Boolean(gitRef);
      emitProgress(options, {
        index: targetIndex,
        label: targetLabel,
        target,
        total: targetTotal,
        type: "target:stage",
        stage: gitRef ? `cloning source at ref ${gitRef}` : "cloning source",
      });
      checkout = await ensureCheckout(
        target,
        resolution,
        options.workspaceDir,
        gitRef,
      );
      sourceSelection = resolveTargetSourceDirectory(
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
        return persistAuditArtifacts(
          {
            assessment: scoreTargetRisk([], target, {
              errorMessage:
                "Unable to generate a child SBOM for the resolved source repository.",
              scanError: true,
            }),
            error:
              "Unable to generate a child SBOM for the resolved source repository.",
            errorType: "sbom-generation",
            findings: [],
            repoUrl: sanitizedRepoUrl,
            resolution,
            status: "error",
            target,
          },
          options,
        );
      }
      const processedBomNSData = postProcess(
        bomNSData,
        childOptions,
        sourceSelection.scanDir,
      );
      processedBomJson = processedBomNSData.bomJson;
      writeCachedChildBom(options.workspaceDir, target, {
        bomJson: processedBomJson,
        repoUrl: sanitizedRepoUrl,
        resolution,
        scanDir: sourceSelection.scanDir,
        sourceDirectoryConfidence: sourceSelection.confidence,
        versionMatched,
      });
    }
    emitProgress(options, {
      index: targetIndex,
      label: targetLabel,
      target,
      total: targetTotal,
      type: "target:stage",
      stage: "evaluating audit rules",
    });
    const findings = await auditBom(processedBomJson, {
      bomAuditCategories: categories.join(","),
      bomAuditMinSeverity: options.minSeverity || "low",
    });
    const contextualFindings = buildTargetContextFindings(target);
    const predictiveFindings = findings.concat(contextualFindings);
    const assessment = scoreTargetRisk(predictiveFindings, target, {
      bomJson: processedBomJson,
      repoReused: Boolean(checkout?.reused || cacheHit),
      resolution,
      sourceDirectoryConfidence: sourceSelection.confidence,
      versionMatched,
    });
    return persistAuditArtifacts(
      {
        assessment,
        cacheHit,
        findings: predictiveFindings,
        repoUrl: sanitizedRepoUrl,
        resolution,
        scanDir: sourceSelection.scanDir,
        sourceDirectoryConfidence: sourceSelection.confidence,
        status: "audited",
        target,
      },
      options,
      processedBomJson,
    );
  } catch (error) {
    return persistAuditArtifacts(
      {
        assessment: scoreTargetRisk([], target, {
          errorMessage: error.message,
          scanError: true,
        }),
        error: error.message,
        errorType: error?.errorType || "runtime",
        findings: [],
        repoUrl: sanitizedRepoUrl,
        resolution,
        sourceDirectoryConfidence: sourceSelection?.confidence,
        status: "error",
        target,
      },
      options,
      processedBomJson,
    );
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

function preferredResult(left, right) {
  const leftSeverity = SEVERITY_ORDER[left?.assessment?.severity] ?? -1;
  const rightSeverity = SEVERITY_ORDER[right?.assessment?.severity] ?? -1;
  if (leftSeverity !== rightSeverity) {
    return leftSeverity > rightSeverity ? left : right;
  }
  const leftScore = left?.assessment?.score || 0;
  const rightScore = right?.assessment?.score || 0;
  return leftScore >= rightScore ? left : right;
}

function dedupeFindings(findings) {
  const seen = new Set();
  const deduped = [];
  for (const finding of findings || []) {
    const key = [
      finding?.ruleId,
      finding?.message,
      finding?.location?.file,
      finding?.location?.purl,
      finding?.location?.bomRef,
    ].join("|");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(finding);
  }
  return deduped;
}

function getNamespaceGroupingKey(result) {
  if (
    result?.status !== "audited" ||
    result?.target?.type !== "npm" ||
    !result?.target?.namespace ||
    (result?.assessment?.severity || "none") === "none"
  ) {
    return undefined;
  }
  const categories = Object.keys(
    result.assessment?.categoryCounts || {},
  ).sort();
  const ruleIds = [
    ...new Set((result.findings || []).map((f) => f.ruleId).filter(Boolean)),
  ].sort();
  if (!categories.length || !ruleIds.length) {
    return undefined;
  }
  return `${result.target.namespace}|${categories.join(",")}|${ruleIds.join(",")}`;
}

function consolidateNamespaceResult(group) {
  const representative = group.reduce((best, result) =>
    preferredResult(best, result),
  );
  const allBomRefs = [
    ...new Set(group.flatMap((result) => result.target?.bomRefs || [])),
  ];
  const groupedPurls = [
    ...new Set(group.map((result) => result.target?.purl).filter(Boolean)),
  ];
  const mergedFindings = dedupeFindings(
    group.flatMap((result) => result.findings || []),
  );
  const categoryCounts = {};
  for (const result of group) {
    for (const [category, count] of Object.entries(
      result.assessment?.categoryCounts || {},
    )) {
      categoryCounts[category] = (categoryCounts[category] || 0) + count;
    }
  }
  const reasons = [
    `${group.length} npm packages under namespace '${representative.target.namespace}' shared the same predictive pattern and were consolidated into one alert.`,
    ...(representative.assessment?.reasons || []),
  ];
  return {
    ...representative,
    assessment: {
      ...representative.assessment,
      categoryCounts,
      findingsCount: mergedFindings.length,
      reasons: [...new Set(reasons)],
    },
    findings: mergedFindings,
    grouping: {
      kind: "npm-namespace",
      label: `npm:${representative.target.namespace}/*`,
      memberCount: group.length,
      namespace: representative.target.namespace,
      groupedPurls,
    },
    target: {
      ...representative.target,
      bomRefs: allBomRefs,
      name: "*",
      version: undefined,
    },
  };
}

export function groupAuditResults(results) {
  const groupedResults = [];
  const orderedEntries = [];
  const namespaceGroups = new Map();
  for (const result of results) {
    const groupKey = getNamespaceGroupingKey(result);
    if (!groupKey) {
      orderedEntries.push({ result, type: "single" });
      continue;
    }
    if (!namespaceGroups.has(groupKey)) {
      namespaceGroups.set(groupKey, []);
      orderedEntries.push({ groupKey, type: "group" });
    }
    namespaceGroups.get(groupKey).push(result);
  }
  for (const entry of orderedEntries) {
    if (entry.type === "single") {
      groupedResults.push(entry.result);
      continue;
    }
    const group = namespaceGroups.get(entry.groupKey) || [];
    groupedResults.push(
      group.length > 1 ? consolidateNamespaceResult(group) : group[0],
    );
  }
  return groupedResults;
}

function summarizeGroupedResults(results) {
  const severityCounts = {
    critical: 0,
    high: 0,
    low: 0,
    medium: 0,
    none: 0,
  };
  for (const result of results) {
    const severity = result?.assessment?.severity || "none";
    severityCounts[severity] = (severityCounts[severity] || 0) + 1;
  }
  return {
    groupedResultCount: results.length,
    groupedSeverityCounts: severityCounts,
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
  const extractedTargets = collectAuditTargets(inputBoms, {
    maxTargets: options.maxTargets,
    scope: options.scope,
    trusted: options.trusted,
  });
  const results = [];
  const preflightMessage = buildPredictiveAuditPreflightMessage(
    extractedTargets,
    options,
  );
  if (preflightMessage) {
    emitProgress(options, {
      message: preflightMessage,
      total: extractedTargets.targets.length,
      type: "run:info",
    });
  }
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
  const groupedResults = groupAuditResults(results);
  const report = {
    generatedAt: new Date().toISOString(),
    inputs: inputBoms.map((inputBom) => inputBom.source),
    groupedResults,
    results,
    skipped: extractedTargets.skipped,
    summary: summarizeAudit(inputBoms, results, extractedTargets.skipped),
    tool: {
      name: "cdx-audit",
      version: readPackageVersion(),
    },
  };
  Object.assign(report.summary, summarizeGroupedResults(groupedResults));
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
  const workspaceContext = prepareWorkspaceContext(options);
  try {
    return await runAuditFromBoms(inputBoms, {
      ...options,
      workspaceDir: workspaceContext.workspaceDir,
    });
  } finally {
    if (workspaceContext.cleanupOnFinish) {
      cleanupSourceDir(workspaceContext.workspaceDir);
    }
  }
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
  const effectiveResults = report.groupedResults?.length
    ? report.groupedResults
    : report.results;
  const shouldFail = effectiveResults.some((result) =>
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
