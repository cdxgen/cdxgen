import path, { basename, extname, relative, resolve } from "node:path";
import process from "node:process";

import { createHttpClient, getDefaultHttpTimeoutMs } from "./httpClient.js";
import { traceLog } from "./logger.js";
import { getUserAgent } from "./userAgent.js";

/** True when CDXGEN_DEBUG_MODE or SCAN_DEBUG_MODE requests debug/verbose output. */
export const DEBUG_MODE =
  ["debug", "verbose"].includes(process.env.CDXGEN_DEBUG_MODE) ||
  process.env.SCAN_DEBUG_MODE === "debug";

/** True when cdxgen runs in secure/permission-restricted mode (CDXGEN_SECURE_MODE or Node.js --permission). */
export const isSecureMode =
  ["true", "1"].includes(process.env?.CDXGEN_SECURE_MODE) ||
  process.env?.NODE_OPTIONS?.includes("--permission");

// CLI dry-run must be detected during module initialization because some probes
// execute while modules are imported, before bin/cdxgen.js can thread options.
const hasDryRunArg = process.argv?.some(
  (arg) =>
    arg === "--dry-run" || arg === "--dry-run=true" || arg === "--dry-run=1",
);
/** Mutable flag indicating dry-run mode; when true, filesystem, network, and process activity is blocked and recorded instead of executed. */
export let isDryRun =
  ["true", "1"].includes(process.env?.CDXGEN_DRY_RUN) || hasDryRunArg;

/** Error code string attached to errors raised when an operation is blocked by dry-run mode. */
export const DRY_RUN_ERROR_CODE = "CDXGEN_DRY_RUN";
const activityLedger = [];
let activityCounter = 0;
let currentActivityContext = {};
const dryRunReadTraceState =
  globalThis.__cdxgenDryRunReadTraceState ||
  (globalThis.__cdxgenDryRunReadTraceState = {
    environmentReads: new Map(),
    observations: new Map(),
    recordActivity: undefined,
    sensitiveFileReads: new Map(),
  });

const SENSITIVE_ENV_VAR_PATTERN =
  /(^|_)(?:token|key|secret|pass(?:word)?|credential(?:s)?|cred|auth|session|cookie|email|user)$/i;
const DIRECTORY_DISCOVERY_NAMES = new Set([
  ".cargo",
  ".docker",
  ".gem",
  ".github",
  ".m2",
  ".nuget",
  ".venv",
  ".yarn",
  "blobs",
  "extensions",
  "node_modules",
  "target",
  "vendor",
]);
const LOCKFILE_ACTIVITY_HINTS = new Map([
  [
    "bun.lock",
    { classification: "lockfile", ecosystem: "bun", label: "Bun lockfile" },
  ],
  [
    "cargo.lock",
    { classification: "lockfile", ecosystem: "cargo", label: "Cargo lockfile" },
  ],
  [
    "composer.lock",
    {
      classification: "lockfile",
      ecosystem: "composer",
      label: "Composer lockfile",
    },
  ],
  [
    "deno.lock",
    { classification: "lockfile", ecosystem: "deno", label: "Deno lockfile" },
  ],
  [
    "gemfile.lock",
    {
      classification: "lockfile",
      ecosystem: "rubygems",
      label: "Bundler lockfile",
    },
  ],
  [
    "cpanfile.snapshot",
    {
      classification: "lockfile",
      ecosystem: "cpan",
      label: "Carton snapshot",
    },
  ],
  [
    "manifest.toml",
    {
      classification: "lockfile",
      ecosystem: "gleam",
      label: "Gleam or Julia lockfile",
    },
  ],
  [
    "nimble.lock",
    {
      classification: "lockfile",
      ecosystem: "nim",
      label: "Nimble lockfile",
    },
  ],
  [
    "package-lock.json",
    { classification: "lockfile", ecosystem: "npm", label: "npm lockfile" },
  ],
  [
    "packages.lock.json",
    { classification: "lockfile", ecosystem: "nuget", label: "NuGet lockfile" },
  ],
  [
    "pdm.lock",
    { classification: "lockfile", ecosystem: "python", label: "PDM lockfile" },
  ],
  [
    "pnpm-lock.yaml",
    { classification: "lockfile", ecosystem: "pnpm", label: "pnpm lockfile" },
  ],
  [
    "poetry.lock",
    {
      classification: "lockfile",
      ecosystem: "python",
      label: "Poetry lockfile",
    },
  ],
  [
    "podfile.lock",
    {
      classification: "lockfile",
      ecosystem: "cocoapods",
      label: "CocoaPods lockfile",
    },
  ],
  [
    "pylock.toml",
    {
      classification: "lockfile",
      ecosystem: "python",
      label: "PEP 751 lockfile",
    },
  ],
  [
    "renv.lock",
    {
      classification: "lockfile",
      ecosystem: "cran",
      label: "renv lockfile",
    },
  ],
  [
    "rebar.lock",
    {
      classification: "lockfile",
      ecosystem: "hex",
      label: "rebar3 lockfile",
    },
  ],
  [
    "shard.lock",
    {
      classification: "lockfile",
      ecosystem: "crystal",
      label: "Crystal shards lockfile",
    },
  ],
  [
    "spack.lock",
    {
      classification: "lockfile",
      ecosystem: "spack",
      label: "Spack lockfile",
    },
  ],
  [
    "stack.lock",
    {
      classification: "lockfile",
      ecosystem: "hackage",
      label: "Stack lockfile",
    },
  ],
  [
    "stack.yaml.lock",
    {
      classification: "lockfile",
      ecosystem: "hackage",
      label: "Stack lockfile",
    },
  ],
  [
    ".terraform.lock.hcl",
    {
      classification: "lockfile",
      ecosystem: "terraform",
      label: "Terraform provider lockfile",
    },
  ],
  [
    "uv.lock",
    { classification: "lockfile", ecosystem: "python", label: "uv lockfile" },
  ],
  [
    "yarn.lock",
    { classification: "lockfile", ecosystem: "yarn", label: "Yarn lockfile" },
  ],
]);
const MANIFEST_ACTIVITY_HINTS = new Map([
  [
    "cargo.toml",
    { classification: "manifest", ecosystem: "cargo", label: "Cargo manifest" },
  ],
  [
    "composer.json",
    {
      classification: "manifest",
      ecosystem: "composer",
      label: "Composer manifest",
    },
  ],
  [
    "deno.json",
    { classification: "manifest", ecosystem: "deno", label: "Deno manifest" },
  ],
  [
    "gemfile",
    {
      classification: "manifest",
      ecosystem: "rubygems",
      label: "Gem manifest",
    },
  ],
  [
    "package.json",
    { classification: "manifest", ecosystem: "npm", label: "package manifest" },
  ],
  [
    "pom.xml",
    { classification: "manifest", ecosystem: "maven", label: "Maven manifest" },
  ],
  [
    "cpanfile",
    { classification: "manifest", ecosystem: "cpan", label: "CPAN manifest" },
  ],
  [
    "project.toml",
    {
      classification: "manifest",
      ecosystem: "julia",
      label: "Julia project manifest",
    },
  ],
  [
    "pyproject.toml",
    {
      classification: "manifest",
      ecosystem: "python",
      label: "Python project manifest",
    },
  ],
  [
    "requirements.txt",
    {
      classification: "manifest",
      ecosystem: "python",
      label: "Python requirements manifest",
    },
  ],
  [
    "setup.py",
    {
      classification: "manifest",
      ecosystem: "python",
      label: "Python setup manifest",
    },
  ],
]);
const SENSITIVE_CONFIG_ACTIVITY_HINTS = [
  {
    matcher: (lowerPath, baseName) =>
      baseName === ".terraformrc" ||
      baseName === "terraform.rc" ||
      baseName === "credentials.tfrc.json",
    metadata: {
      classification: "credential",
      ecosystem: "terraform",
      label: "Terraform CLI configuration",
      sensitive: true,
    },
  },
  {
    matcher: (lowerPath, _baseName) =>
      lowerPath.includes("/.cargo/config.toml") ||
      lowerPath.endsWith("/.cargo/credentials") ||
      lowerPath.endsWith("/.cargo/credentials.toml"),
    metadata: {
      classification: "config",
      ecosystem: "cargo",
      label: "Cargo registry configuration",
      sensitive: true,
    },
  },
  {
    matcher: (lowerPath, baseName) =>
      lowerPath.includes("/.docker/config.json") ||
      (baseName === "config.json" && lowerPath.includes("/docker")),
    metadata: {
      classification: "credential",
      ecosystem: "oci",
      label: "Docker credential file",
      sensitive: true,
    },
  },
  {
    matcher: (lowerPath) => lowerPath.endsWith("/.gem/credentials"),
    metadata: {
      classification: "credential",
      ecosystem: "rubygems",
      label: "RubyGems credentials file",
      sensitive: true,
    },
  },
  {
    matcher: (_lowerPath, baseName) =>
      baseName === ".npmrc" || baseName === ".pnpmrc" || baseName === ".yarnrc",
    metadata: {
      classification: "config",
      ecosystem: "npm",
      label: "JavaScript package manager configuration",
      sensitive: true,
    },
  },
  {
    matcher: (_lowerPath, baseName) => baseName === ".yarnrc.yml",
    metadata: {
      classification: "config",
      ecosystem: "yarn",
      label: "Yarn configuration",
      sensitive: true,
    },
  },
  {
    matcher: (_lowerPath, baseName) =>
      baseName === ".pypirc" || baseName === "pip.conf",
    metadata: {
      classification: "config",
      ecosystem: "python",
      label: "Python package publishing configuration",
      sensitive: true,
    },
  },
  {
    matcher: (_lowerPath, baseName) =>
      baseName === "uv.toml" || baseName === "poetry.toml",
    metadata: {
      classification: "config",
      ecosystem: "python",
      label: "Python package manager configuration",
      sensitive: true,
    },
  },
  {
    matcher: (_lowerPath, baseName) => baseName === "nuget.config",
    metadata: {
      classification: "config",
      ecosystem: "nuget",
      label: "NuGet configuration",
      sensitive: true,
    },
  },
  {
    matcher: (_lowerPath, baseName) => baseName === "settings.xml",
    metadata: {
      classification: "config",
      ecosystem: "maven",
      label: "Maven settings.xml",
      sensitive: true,
    },
  },
];
const CERTIFICATE_FILE_EXTENSIONS = new Set([".crt", ".cer", ".pem"]);
const KEY_FILE_EXTENSIONS = new Set([
  ".key",
  ".jks",
  ".keystore",
  ".p12",
  ".pfx",
]);

/** @param {number} count Number of times an activity was observed. @returns {string} Suffix string indicating repeat count, or empty string. */
const buildReadCountSuffix = (count) => (count > 1 ? ` (${count} times)` : "");

const buildEnvironmentReadReason = (varName, count, sensitive) =>
  `Read ${sensitive ? "sensitive " : ""}environment variable ${varName}${buildReadCountSuffix(count)}.`;

const buildSensitiveFileReadReason = (filePath, count, label) =>
  `Read ${label} ${filePath}${buildReadCountSuffix(count)}.`;

function emitActivity(activity) {
  if (typeof dryRunReadTraceState.recordActivity !== "function") {
    return undefined;
  }
  return dryRunReadTraceState.recordActivity(activity);
}

/**
 * Classify a filesystem path into an activity metadata object describing its
 * classification (lockfile, manifest, certificate, key, cache, etc.), ecosystem,
 * label, and whether it is sensitive.
 *
 * @param {string} filePath File path to classify.
 * @returns {Object|undefined} Metadata object, or undefined when the path does not match a known pattern.
 */
function classifyActivityPath(filePath) {
  if (typeof filePath !== "string" || !filePath.length) {
    return undefined;
  }
  const normalizedPath = filePath.replaceAll("\\", "/");
  const lowerPath = normalizedPath.toLowerCase();
  const baseName = basename(lowerPath);
  if (LOCKFILE_ACTIVITY_HINTS.has(baseName)) {
    return LOCKFILE_ACTIVITY_HINTS.get(baseName);
  }
  if (MANIFEST_ACTIVITY_HINTS.has(baseName)) {
    return MANIFEST_ACTIVITY_HINTS.get(baseName);
  }
  for (const { matcher, metadata } of SENSITIVE_CONFIG_ACTIVITY_HINTS) {
    if (matcher(lowerPath, baseName)) {
      return metadata;
    }
  }
  if (
    lowerPath.includes("/cache/") ||
    lowerPath.includes("/.cache/") ||
    lowerPath.includes("/caches/")
  ) {
    return {
      classification: "cache",
      label: "cache path",
    };
  }
  if (
    CERTIFICATE_FILE_EXTENSIONS.has(extname(baseName)) ||
    baseName === "cert.pem"
  ) {
    return {
      classification: "certificate",
      label: "certificate file",
      sensitive: true,
    };
  }
  if (
    KEY_FILE_EXTENSIONS.has(extname(baseName)) ||
    baseName === "key.pem" ||
    baseName.startsWith("id_")
  ) {
    return {
      classification: "key",
      label: "private key file",
      sensitive: true,
    };
  }
  const trimmedPath = normalizedPath.endsWith("/")
    ? normalizedPath.slice(0, -1)
    : normalizedPath;
  const directoryName = basename(trimmedPath.toLowerCase());
  if (DIRECTORY_DISCOVERY_NAMES.has(directoryName)) {
    return {
      classification: "directory",
      label: "directory discovery path",
    };
  }
  return undefined;
}

/**
 * Classify a discovery glob pattern into a discovery type and human-readable label.
 *
 * @param {string|string[]} pattern Glob pattern (or array of patterns) used for discovery.
 * @returns {{discoveryType: string, label: string}} Discovery metadata with a `discoveryType` and `label`.
 */
function classifyDiscoveryPattern(pattern) {
  const patternValue = Array.isArray(pattern)
    ? pattern.join(",")
    : String(pattern);
  const lowerPattern = patternValue.toLowerCase();
  if (
    lowerPattern.includes("package-lock.json") ||
    lowerPattern.includes("pnpm-lock.yaml") ||
    lowerPattern.includes("yarn.lock") ||
    lowerPattern.includes("poetry.lock") ||
    lowerPattern.includes("uv.lock") ||
    lowerPattern.includes("cargo.lock") ||
    lowerPattern.includes("gemfile.lock")
  ) {
    return {
      discoveryType: "lockfile-discovery",
      label: "lockfile discovery",
    };
  }
  if (
    lowerPattern.includes("package.json") ||
    lowerPattern.includes("pom.xml") ||
    lowerPattern.includes("pyproject.toml") ||
    lowerPattern.includes("cargo.toml") ||
    lowerPattern.includes("composer.json")
  ) {
    return {
      discoveryType: "manifest-discovery",
      label: "manifest discovery",
    };
  }
  return {
    discoveryType: "directory-enumeration",
    label: "directory enumeration",
  };
}

function recordDeduplicatedRead(traceMap, traceKey, activity, createReason) {
  const existingTrace = traceMap.get(traceKey);
  if (existingTrace) {
    existingTrace.count += 1;
    if (existingTrace.entry) {
      existingTrace.entry.count = existingTrace.count;
      existingTrace.entry.reason = createReason(existingTrace.count);
    }
    return existingTrace.entry;
  }
  const entry = emitActivity({
    ...activity,
    reason: createReason(1),
  });
  if (entry) {
    entry.count = 1;
  }
  traceMap.set(traceKey, {
    count: 1,
    entry,
  });
  return entry;
}

/**
 * Tests whether an environment variable name matches sensitive patterns
 * (token, key, secret, password, credential, auth, session, cookie, etc.).
 *
 * @param {string} varName Environment variable name to test.
 * @returns {boolean} True when the name matches a sensitive pattern.
 */
export function isSensitiveEnvironmentVariableName(varName) {
  return typeof varName === "string" && SENSITIVE_ENV_VAR_PATTERN.test(varName);
}

/**
 * Record a deduplicated observed activity entry (filesystem, environment, or
 * discovery). No-op unless dry-run or debug mode is active.
 *
 * @param {string} kind Activity kind (e.g. "inspect", "discover", "decision").
 * @param {string} target Activity target (path, host, or identifier).
 * @param {Object} [options] Optional metadata including `status`, `reason`, `reasonBuilder`, `metadata`, `traceKey`, and `traceDetail`.
 * @returns {Object|undefined} The recorded activity entry, or undefined.
 */
export function recordObservedActivity(kind, target, options = {}) {
  if (!(isDryRun || DEBUG_MODE) || !kind || !target) {
    return undefined;
  }
  const status = options.status || "completed";
  const traceKey =
    options.traceKey ||
    `${kind}:${status}:${target}:${options.traceDetail || ""}`;
  const metadata = options.metadata || {};
  const reasonBuilder =
    options.reasonBuilder ||
    ((count) =>
      options.reason
        ? `${options.reason}${buildReadCountSuffix(count)}`
        : `Recorded ${kind} activity for ${target}${buildReadCountSuffix(count)}.`);
  return recordDeduplicatedRead(
    dryRunReadTraceState.observations,
    traceKey,
    {
      kind,
      status,
      target,
      ...metadata,
    },
    reasonBuilder,
  );
}

/** @param {string} target Activity target. @param {Object} [options] Options forwarded to recordObservedActivity. @returns {Object|undefined} Recorded activity entry. */
export function recordDecisionActivity(target, options = {}) {
  return recordObservedActivity(options.kind || "decision", target, options);
}

/** @param {string} target Activity target. @param {Object} [options] Options forwarded to recordObservedActivity. @returns {Object|undefined} Recorded activity entry. */
export function recordDiscoveryActivity(target, options = {}) {
  return recordObservedActivity(options.kind || "discover", target, options);
}

/** @param {string} target Activity target. @param {Object} [options] Options forwarded to recordObservedActivity. @returns {Object|undefined} Recorded activity entry. */
export function recordPolicyActivity(target, options = {}) {
  return recordObservedActivity(options.kind || "policy", target, options);
}

function normalizeRecordedPathForComparison(
  candidatePath,
  basePath = undefined,
) {
  if (typeof candidatePath !== "string" || !candidatePath.length) {
    return undefined;
  }
  let normalizedPath = candidatePath.replaceAll("\\", "/");
  if (basePath && path.isAbsolute(candidatePath)) {
    const resolvedBasePath = resolve(basePath);
    const normalizedBasePath = resolvedBasePath.replaceAll("\\", "/");
    const isWithinBasePath = (candidate) => {
      const normalizedCandidate = candidate.replaceAll("\\", "/");
      return (
        normalizedCandidate === normalizedBasePath ||
        normalizedCandidate.startsWith(`${normalizedBasePath}/`)
      );
    };

    const resolvedCandidatePath = resolve(candidatePath);
    if (isWithinBasePath(resolvedCandidatePath)) {
      normalizedPath = relative(
        resolvedBasePath,
        resolvedCandidatePath,
      ).replaceAll("\\", "/");
    } else {
      const rebasedCandidatePath = resolve(
        resolvedBasePath,
        candidatePath.replace(/^([A-Za-z]:)?[\\/]+/, ""),
      );
      if (isWithinBasePath(rebasedCandidatePath)) {
        normalizedPath = relative(
          resolvedBasePath,
          rebasedCandidatePath,
        ).replaceAll("\\", "/");
      }
    }
  }
  return normalizedPath;
}

/**
 * Record a symlink resolution outcome, normalizing both paths relative to an
 * optional base path.
 *
 * @param {string} sourcePath The symlink source path.
 * @param {string} resolvedPath The resolved target path.
 * @param {Object} [options] Options including `basePath`, `status`, `reason`, `errorCode`, and `metadata`.
 * @returns {Object|undefined} Recorded activity entry, or undefined.
 */
export function recordSymlinkResolution(
  sourcePath,
  resolvedPath,
  options = {},
) {
  const normalizedSourcePath = normalizeRecordedPathForComparison(
    sourcePath,
    options.basePath,
  );
  const normalizedResolvedPath = normalizeRecordedPathForComparison(
    resolvedPath,
    options.basePath,
  );
  const status = options.status || "completed";
  if (
    !normalizedSourcePath ||
    (status === "completed" &&
      (!normalizedResolvedPath ||
        normalizedSourcePath === normalizedResolvedPath))
  ) {
    return undefined;
  }
  const metadata = {
    capability: "symlink-resolution",
    ...(normalizedResolvedPath ? { resolvedPath: normalizedResolvedPath } : {}),
    ...(options.errorCode ? { errorCode: options.errorCode } : {}),
    ...(options.metadata || {}),
  };
  return recordObservedActivity("symlink-resolution", normalizedSourcePath, {
    metadata,
    reason:
      options.reason ||
      (status === "failed"
        ? `Failed to resolve symlink ${normalizedSourcePath}.`
        : `Resolved symlink ${normalizedSourcePath} to ${normalizedResolvedPath}.`),
    status,
  });
}

/**
 * Record a deduplicated environment-variable read, flagging names that match
 * sensitive patterns.
 *
 * @param {string} varName Environment variable name that was read.
 * @param {Object} [options] Options including `source`, `sensitive`, `status`, and `reason`.
 * @returns {Object|undefined} Recorded activity entry, or undefined.
 */
export function recordEnvironmentRead(varName, options = {}) {
  // Read tracing intentionally mirrors the activity ledger's dry-run/debug behavior.
  if (!(isDryRun || DEBUG_MODE) || !varName) {
    return undefined;
  }
  const source = options.source || "process.env";
  const sensitive =
    options.sensitive ?? isSensitiveEnvironmentVariableName(varName);
  const status = options.status || "completed";
  const traceKey = `${source}:${varName}:${status}`;
  const target = `${source}:${varName}`;
  return recordDeduplicatedRead(
    dryRunReadTraceState.environmentReads,
    traceKey,
    {
      kind: "env",
      redacted: sensitive,
      secretCategory: sensitive ? "environment-variable" : undefined,
      sensitive,
      status,
      target,
    },
    (count) =>
      options.reason || buildEnvironmentReadReason(varName, count, sensitive),
  );
}

/**
 * Record a sensitive-file read, deriving classification metadata from the path.
 *
 * @param {string} filePath Path of the sensitive file that was read.
 * @param {Object} [options] Options including `kind`, `label`, `status`, and `reason`.
 * @returns {Object|undefined} Recorded activity entry, or undefined.
 */
export function recordSensitiveFileRead(filePath, options = {}) {
  // Read tracing intentionally mirrors the activity ledger's dry-run/debug behavior.
  if (!(isDryRun || DEBUG_MODE) || !filePath) {
    return undefined;
  }
  const kind = options.kind || "read";
  const pathMetadata = classifyActivityPath(filePath) || {};
  const label = options.label || pathMetadata.label || "sensitive file";
  const status = options.status || "completed";
  const traceKey = `${kind}:${status}:${filePath}`;
  return recordDeduplicatedRead(
    dryRunReadTraceState.sensitiveFileReads,
    traceKey,
    {
      classification: pathMetadata.classification,
      ecosystem: pathMetadata.ecosystem,
      kind,
      redacted: pathMetadata.sensitive ?? true,
      secretCategory:
        pathMetadata.classification === "key"
          ? "private-key"
          : pathMetadata.classification === "certificate"
            ? "certificate"
            : "credential-file",
      status,
      target: filePath,
    },
    (count) =>
      options.reason || buildSensitiveFileReadReason(filePath, count, label),
  );
}

/**
 * Read an environment variable while recording the read for activity tracing.
 *
 * @param {string} varName Environment variable name to read.
 * @param {Object} [options] Options forwarded to recordEnvironmentRead.
 * @returns {string|undefined} The variable value, or undefined when unset.
 */
export function readEnvironmentVariable(varName, options = {}) {
  recordEnvironmentRead(varName, options);
  return process.env[varName];
}

/**
 * Toggle dry-run mode on or off and keep the CDXGEN_DRY_RUN environment variable in sync.
 *
 * @param {boolean} enabled True to enable dry-run mode, false to disable.
 * @returns {void}
 */
export function setDryRunMode(enabled) {
  isDryRun = !!enabled;
  if (enabled) {
    process.env.CDXGEN_DRY_RUN = "true";
    return;
  }
  delete process.env.CDXGEN_DRY_RUN;
}

/**
 * Construct an Error tagged as a dry-run-blocked operation.
 *
 * @param {string} action Action that was blocked (e.g. "network", "execute").
 * @param {string} target Target of the blocked action.
 * @param {string} [reason] Optional human-readable reason; defaults to a generic message.
 * @returns {Error} Error with `code`, `action`, `target`, and `dryRun` properties set.
 */
export function createDryRunError(action, target, reason) {
  const message =
    reason || `Dry run mode blocked the attempted ${action} operation.`;
  const error = new Error(message);
  error.code = DRY_RUN_ERROR_CODE;
  error.name = "DryRunError";
  error.action = action;
  error.target = target;
  error.dryRun = true;
  return error;
}

/**
 * Returns true when the given error was produced by dry-run blocking.
 *
 * @param {Error} error Error to inspect.
 * @returns {boolean} True when the error carries the dry-run code or flag.
 */
export function isDryRunError(error) {
  return !!(error?.dryRun || error?.code === DRY_RUN_ERROR_CODE);
}

/** Error code string attached to errors raised when a request is blocked by the host allow-list or secure-mode policy. */
export const BLOCKED_HOST_ERROR_CODE = "CDXGEN_HOST_BLOCKED";

/**
 * Create an error used to abort a request to a host that policy disallows
 * (CDXGEN_ALLOWED_HOSTS or the secure-mode https-only restriction). The
 * beforeRequest hook must throw this so the request is actually aborted;
 * returning does not stop the request.
 *
 * @param {string} target The blocked request URL.
 * @param {string} reason Human readable reason for the block.
 * @returns {Error} Error carrying the blocked-host code.
 */
export function createBlockedHostError(target, reason) {
  const error = new Error(reason);
  error.code = BLOCKED_HOST_ERROR_CODE;
  error.name = "BlockedHostError";
  error.target = target;
  error.blockedHost = true;
  return error;
}

/**
 * Merge context metadata into the current activity context applied to every recorded activity.
 *
 * @param {Object} [context] Context properties to merge.
 * @returns {void}
 */
export function setActivityContext(context = {}) {
  currentActivityContext = {
    ...currentActivityContext,
    ...context,
  };
}

/** Clear the current activity context. @returns {void} */
export function resetActivityContext() {
  currentActivityContext = {};
}

/**
 * Append a timestamped activity entry to the ledger and emit a trace log.
 * No-op unless dry-run or debug mode is active.
 *
 * @param {Object} activity Activity properties to record.
 * @returns {Object|undefined} The recorded, identified entry, or undefined when recording is inactive.
 */
export function recordActivity(activity) {
  if (!(isDryRun || DEBUG_MODE)) {
    return undefined;
  }
  const identifier = `ACT-${String(++activityCounter).padStart(4, "0")}`;
  const entry = {
    identifier,
    ...currentActivityContext,
    timestamp: new Date().toISOString(),
    ...activity,
  };
  activityLedger.push(entry);
  traceLog("activity", entry);
  return entry;
}

dryRunReadTraceState.recordActivity = recordActivity;

/** @returns {Object[]} Shallow copy of the recorded activity ledger. */
export function getRecordedActivities() {
  return [...activityLedger];
}

/** Clear the activity ledger and all dedup maps. @returns {void} */
export function resetRecordedActivities() {
  activityLedger.length = 0;
  activityCounter = 0;
  dryRunReadTraceState.environmentReads.clear();
  dryRunReadTraceState.observations.clear();
  dryRunReadTraceState.sensitiveFileReads.clear();
}

/**
 * Record a filesystem activity entry with the given kind, target, and status.
 *
 * @param {string} kind Activity kind (e.g. "write", "mkdir", "cleanup").
 * @param {string} target Filesystem target path.
 * @param {string} status Activity status (e.g. "completed", "blocked").
 * @param {string} [reason] Optional human-readable reason.
 * @param {Object} [metadata] Optional additional metadata.
 * @returns {Object|undefined} Recorded activity entry, or undefined.
 */
function recordFilesystemActivity(
  kind,
  target,
  status,
  reason = undefined,
  metadata = {},
) {
  return recordActivity({
    kind,
    ...metadata,
    reason,
    status,
    target,
  });
}

/** Set accumulating hostnames of remote hosts contacted during a scan. */
export const remoteHostsAccessed = new Set();

/**
 * Test a hostname against the CDXGEN_ALLOWED_HOSTS allow-list, supporting exact
 * matches and `*.suffix` wildcards. When no allow-list is configured, all hosts are allowed.
 *
 * @param {string} hostname Hostname to test.
 * @param {string} [allowedHostsEnv] Comma-separated allow-list string; defaults to the CDXGEN_ALLOWED_HOSTS env var.
 * @returns {boolean} True when the hostname is permitted.
 */
export function isAllowedHttpHost(
  hostname,
  allowedHostsEnv = readEnvironmentVariable("CDXGEN_ALLOWED_HOSTS"),
) {
  if (!allowedHostsEnv) {
    return true;
  }
  if (!hostname || hasDangerousUnicode(hostname)) {
    return false;
  }
  const normalizedHostname = hostname.toLowerCase();
  const allow_hosts = allowedHostsEnv
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  for (const ahost of allow_hosts) {
    if (normalizedHostname === ahost) {
      return true;
    }
    // wildcard support
    if (
      ahost.startsWith("*.") &&
      normalizedHostname.length > ahost.length - 1 &&
      normalizedHostname.endsWith(`.${ahost.slice(2)}`)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Checks for dangerous Unicode characters that could enable homograph attacks
 *
 * @param {string} str String to check
 * @returns {boolean} true if dangerous Unicode is found
 */
// biome-ignore-start lint/suspicious/noControlCharactersInRegex: validation
export function hasDangerousUnicode(str) {
  // Check for bidirectional control characters
  const bidiChars = /[\u202A-\u202E\u2066-\u2069]/;
  if (bidiChars.test(str)) {
    return true;
  }

  // Check for zero-width characters that could be used for obfuscation
  const zeroWidthChars = /[\u200B-\u200D\uFEFF]/;
  if (zeroWidthChars.test(str)) {
    return true;
  }

  // Check for control characters (except common ones like \n, \r, \t)
  const controlChars = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
  return controlChars.test(str);
}
// biome-ignore-end lint/suspicious/noControlCharactersInRegex: validation

function hostnameMatches(hostname, candidateHost) {
  return hostname === candidateHost || hostname.endsWith(`.${candidateHost}`);
}

function inferNetworkIntent(requestUrl) {
  const hostname = requestUrl?.hostname?.toLowerCase() || "";
  const pathname = requestUrl?.pathname?.toLowerCase() || "";
  if (pathname.includes("/api/v1/bom")) {
    return "sbom-submit";
  }
  if (pathname.includes("/manifests/")) {
    return "oci-manifest-access";
  }
  if (pathname.includes("/blobs/")) {
    return "oci-layer-access";
  }
  if (
    pathname.includes("license") ||
    hostnameMatches(hostname, "spdx.org") ||
    hostnameMatches(hostname, "opensource.org")
  ) {
    return "license-fetch";
  }
  if (
    hostnameMatches(hostname, "registry.npmjs.org") ||
    hostnameMatches(hostname, "pypi.org") ||
    hostnameMatches(hostname, "rubygems.org") ||
    hostnameMatches(hostname, "repo.maven.apache.org") ||
    hostnameMatches(hostname, "repo1.maven.org") ||
    hostnameMatches(hostname, "crates.io") ||
    hostnameMatches(hostname, "pub.dev") ||
    hostnameMatches(hostname, "nuget.org")
  ) {
    return "registry-lookup";
  }
  if (hostnameMatches(hostname, "github.com") && pathname.endsWith(".git")) {
    return "git-fetch";
  }
  return "metadata-fetch";
}

/**
 * Set the request's user-agent to the value resolved for its destination host,
 * so that a `CDXGEN_USER_AGENT_<REGISTRY>` override reaches the registry it
 * names. A user-agent a caller set explicitly is left alone; only the client's
 * own default, which carries no host context, is replaced.
 *
 * @param {Object} options Request options being prepared by the HTTP client.
 * @returns {void}
 */
function applyUserAgent(options) {
  const headers = options.headers || (options.headers = {});
  const existingKey = Object.keys(headers).find(
    (name) => name.toLowerCase() === "user-agent",
  );
  if (existingKey && headers[existingKey] !== getUserAgent()) {
    return;
  }
  if (existingKey) {
    delete headers[existingKey];
  }
  headers["user-agent"] = getUserAgent(options.url?.hostname);
}

/** The shared got-compatible HTTP client for all outbound requests, enforcing dry-run, host-allow-list, and secure-mode policies via beforeRequest/afterResponse/beforeError hooks. */
export const cdxgenAgent = createHttpClient({
  headers: {
    // Per-host overrides are applied in beforeRequest; this is the fallback for
    // any code path that reads the client's configured headers directly.
    "user-agent": getUserAgent(),
  },
  // Bound every request so an unresponsive host cannot hang a scan. Overridable
  // via CDXGEN_HTTP_TIMEOUT_MS; individual calls may pass a smaller `timeout`.
  timeout: getDefaultHttpTimeoutMs(),
  retry: {
    limit: 0,
  },
  followRedirect: !isSecureMode,
  hooks: {
    beforeRequest: [
      (options) => {
        const networkIntent =
          options.context?.activityIntent || inferNetworkIntent(options.url);
        applyUserAgent(options);
        const allowedHostsEnv = readEnvironmentVariable("CDXGEN_ALLOWED_HOSTS");
        const hostAllowed = isAllowedHttpHost(
          options.url.hostname,
          allowedHostsEnv,
        );
        options.context = {
          ...options.context,
          activityIntent: networkIntent,
          activityTarget: options.url.toString(),
        };
        if (allowedHostsEnv) {
          recordPolicyActivity(options.url.hostname, {
            metadata: {
              allowed: hostAllowed,
              allowlist: allowedHostsEnv,
              networkIntent,
              policyType: "host-allowlist",
            },
            reason: `${hostAllowed ? "Allowed" : "Blocked"} host ${options.url.hostname} against CDXGEN_ALLOWED_HOSTS.`,
            status: hostAllowed ? "completed" : "blocked",
            traceDetail: "host-allowlist",
          });
        }
        if (isDryRun) {
          const error = createDryRunError(
            "network",
            options.url.toString(),
            `Dry run mode blocks outbound network access (${networkIntent}).`,
          );
          recordActivity({
            kind: "network",
            networkIntent,
            reason: error.message,
            status: "blocked",
            target: options.url.toString(),
          });
          options.context.activityBlocked = true;
          throw error;
        }
        if (!hostAllowed) {
          console.log(
            `Access to the remote host '${options.url.hostname}' is not permitted.`,
          );
          recordActivity({
            kind: "network",
            networkIntent,
            reason: "The remote host is not permitted.",
            status: "blocked",
            target: options.url.toString(),
          });
          options.context.activityBlocked = true;
          throw createBlockedHostError(
            options.url.toString(),
            `The remote host '${options.url.hostname}' is not permitted by CDXGEN_ALLOWED_HOSTS.`,
          );
        }
        // Only allow https protocol in secure mode
        if (isSecureMode && options.url.protocol !== "https:") {
          console.log(
            `Access to the remote host '${options.url.hostname}' is not permitted via the '${options.url.protocol}' protocol.`,
          );
          recordActivity({
            kind: "network",
            networkIntent,
            reason: `The '${options.url.protocol}' protocol is not permitted in secure mode.`,
            status: "blocked",
            target: options.url.toString(),
          });
          options.context.activityBlocked = true;
          throw createBlockedHostError(
            options.url.toString(),
            `The '${options.url.protocol}' protocol is not permitted in secure mode.`,
          );
        }
        remoteHostsAccessed.add(options.url.hostname);
        traceLog("http", {
          protocol: options.url.protocol,
          pathname: options.url.pathname,
          host: options.url.host,
        });
      },
    ],
    afterResponse: [
      (response) => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          return response;
        }
        const activityTarget =
          response.request.options.context?.activityTarget ||
          response.request.options.url?.toString() ||
          response.url;
        recordActivity({
          kind: "network",
          networkIntent: response.request.options.context?.activityIntent,
          status: "completed",
          target: activityTarget,
        });
        return response;
      },
    ],
    beforeError: [
      (error) => {
        if (error.options?.context?.activityBlocked) {
          return error;
        }
        recordActivity({
          kind: "network",
          networkIntent: error.options?.context?.activityIntent,
          reason: error.message,
          status: "failed",
          target:
            error.options?.context?.activityTarget ||
            error.options?.url?.toString(),
        });
        return error;
      },
    ],
  },
});

export {
  buildReadCountSuffix,
  classifyActivityPath,
  classifyDiscoveryPattern,
  recordFilesystemActivity,
};
