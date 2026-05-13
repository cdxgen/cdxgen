import { basename } from "node:path";

import { getHbomCommandDiagnosticSummary } from "./hbomAnalysis.js";
import { importHbomModule } from "./hbomLoader.js";
import { isAllowedPath } from "./source.js";
import {
  isDryRun,
  isSecureMode,
  readEnvironmentVariable,
  recordActivity,
} from "./utils.js";

const HBOM_PROJECT_TYPE_SET = new Set(["hardware", "hbom"]);
const HBOM_TRACE_PATH_ACTIVITY_KINDS = new Set([
  "dir-read",
  "file-read",
  "mkdir",
  "symlink-read",
]);

function parseAllowlistEntries(allowlistValue) {
  if (typeof allowlistValue !== "string") {
    return [];
  }
  return allowlistValue
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function getConfiguredHbomCommandAllowlist() {
  return readEnvironmentVariable("CDXGEN_ALLOWED_COMMANDS");
}

function getConfiguredHbomPathAllowlist() {
  return (
    readEnvironmentVariable("CDXGEN_ALLOWED_PATHS") ||
    readEnvironmentVariable("CDXGEN_SERVER_ALLOWED_PATHS")
  );
}

function isAllowedHbomCommand(command, allowlistValue = undefined) {
  const normalizedCommand = `${command ?? ""}`.trim();
  if (!normalizedCommand) {
    return true;
  }
  const effectiveAllowlist =
    allowlistValue ?? getConfiguredHbomCommandAllowlist();
  const allowlistEntries = parseAllowlistEntries(effectiveAllowlist);
  if (!allowlistEntries.length) {
    return true;
  }
  const commandName = basename(normalizedCommand);
  return allowlistEntries.some(
    (entry) => entry === normalizedCommand || entry === commandName,
  );
}

function formatHbomCommandTarget(command, args = []) {
  return `${command}${args.length ? ` ${args.join(" ")}` : ""}`;
}

function buildHbomPlanActivities(planEntry, normalizedOptions) {
  const baseArgs = [...(planEntry.args || [])];
  const baseTarget = formatHbomCommandTarget(planEntry.command, baseArgs);
  const activities = [
    {
      args: baseArgs,
      command: planEntry.command,
      id: planEntry.id,
      kind: "command",
      target: baseTarget,
    },
  ];
  if (
    normalizedOptions.includePrivilegedEnrichment === true &&
    planEntry.sudoRetryOnPermissionDenied === true
  ) {
    activities.push({
      args: ["-n", planEntry.command, ...baseArgs],
      command: "sudo",
      id: `${planEntry.id}:sudo-retry`,
      kind: "command-retry",
      target: formatHbomCommandTarget("sudo", [
        "-n",
        planEntry.command,
        ...baseArgs,
      ]),
    });
  }
  return activities;
}

function collectDisallowedHbomCommands(
  activities = [],
  allowlistValue = undefined,
) {
  const disallowedCommands = new Map();
  for (const activity of activities) {
    if (!new Set(["command", "command-retry"]).has(activity?.kind)) {
      continue;
    }
    const requestedCommand = `${
      activity.retryCommand ??
      activity.command ??
      activity.requestedCommand ??
      ""
    }`.trim();
    if (
      !requestedCommand ||
      isAllowedHbomCommand(requestedCommand, allowlistValue)
    ) {
      continue;
    }
    const existingEntry = disallowedCommands.get(requestedCommand) ?? {
      command: requestedCommand,
      commandName: basename(requestedCommand),
      ids: new Set(),
      targets: new Set(),
    };
    if (activity.id) {
      existingEntry.ids.add(`${activity.id}`);
    }
    const formattedTarget = `${
      activity.target ||
      formatHbomCommandTarget(requestedCommand, activity.args)
    }`.trim();
    if (formattedTarget) {
      existingEntry.targets.add(formattedTarget);
    }
    disallowedCommands.set(requestedCommand, existingEntry);
  }
  return [...disallowedCommands.values()].sort((leftEntry, rightEntry) =>
    leftEntry.command.localeCompare(rightEntry.command),
  );
}

function collectDisallowedHbomPaths(activities = []) {
  const disallowedPaths = new Map();
  for (const activity of activities) {
    if (!HBOM_TRACE_PATH_ACTIVITY_KINDS.has(activity?.kind)) {
      continue;
    }
    const declaredPath = `${activity.path ?? activity.target ?? ""}`.trim();
    if (!declaredPath || isAllowedPath(declaredPath)) {
      continue;
    }
    const existingEntry = disallowedPaths.get(declaredPath) ?? {
      activityKinds: new Set(),
      ids: new Set(),
      path: declaredPath,
    };
    existingEntry.activityKinds.add(`${activity.kind}`);
    if (activity.id) {
      existingEntry.ids.add(`${activity.id}`);
    }
    disallowedPaths.set(declaredPath, existingEntry);
  }
  return [...disallowedPaths.values()].sort((leftEntry, rightEntry) =>
    leftEntry.path.localeCompare(rightEntry.path),
  );
}

function createHbomAllowlistPreflightError(
  disallowedCommands,
  disallowedPaths,
) {
  const messageLines = [
    "HBOM secure-mode preflight blocked live collection because the dry-run plan includes resources outside the configured allowlists.",
  ];

  if (disallowedCommands.length) {
    messageLines.push("", "Commands not allowed by CDXGEN_ALLOWED_COMMANDS:");
    for (const commandEntry of disallowedCommands) {
      const commandSuffix =
        commandEntry.commandName !== commandEntry.command
          ? ` (basename: ${commandEntry.commandName})`
          : "";
      const detailParts = [];
      if (commandEntry.ids.size) {
        detailParts.push(`ids=${[...commandEntry.ids].join(",")}`);
      }
      if (commandEntry.targets.size) {
        detailParts.push(`targets=${[...commandEntry.targets].join(" | ")}`);
      }
      messageLines.push(
        `- ${commandEntry.command}${commandSuffix}${detailParts.length ? ` — ${detailParts.join("; ")}` : ""}`,
      );
    }
  }

  if (disallowedPaths.length) {
    messageLines.push("", "Paths not allowed by CDXGEN_ALLOWED_PATHS:");
    for (const pathEntry of disallowedPaths) {
      const detailParts = [];
      if (pathEntry.activityKinds.size) {
        detailParts.push(`kinds=${[...pathEntry.activityKinds].join(",")}`);
      }
      if (pathEntry.ids.size) {
        detailParts.push(`ids=${[...pathEntry.ids].join(",")}`);
      }
      messageLines.push(
        `- ${pathEntry.path}${detailParts.length ? ` — ${detailParts.join("; ")}` : ""}`,
      );
    }
  }

  messageLines.push(
    "",
    "Review 'hbom --dry-run' (or 'cdxgen --dry-run -t hbom') to inspect the planned commands and declared paths, then expand CDXGEN_ALLOWED_COMMANDS and CDXGEN_ALLOWED_PATHS before retrying secure mode.",
  );

  return new Error(messageLines.join("\n"));
}

async function enforceSecureModeHbomAllowlists(hbomModule, normalizedOptions) {
  if (isDryRun || normalizedOptions?.isDryRun || !isSecureMode) {
    return;
  }
  const commandAllowlistValue = getConfiguredHbomCommandAllowlist();
  const pathAllowlistValue = getConfiguredHbomPathAllowlist();
  const hasCommandAllowlist =
    parseAllowlistEntries(commandAllowlistValue).length > 0;
  const hasPathAllowlist = parseAllowlistEntries(pathAllowlistValue).length > 0;
  if (!hasCommandAllowlist && !hasPathAllowlist) {
    return;
  }

  let traceActivities = [];
  if (hasPathAllowlist || typeof hbomModule.getCommandPlan !== "function") {
    if (typeof hbomModule.createCollectorTrace !== "function") {
      throw new Error(
        "HBOM secure mode requires a cdx-hbom build with dry-run trace support to enforce the configured allowlists. Upgrade '@cdxgen/cdx-hbom' and retry.",
      );
    }
    const preflightTrace = hbomModule.createCollectorTrace();
    const preflightBom = await hbomModule.collectHardware({
      ...normalizedOptions,
      dryRun: true,
      trace: preflightTrace,
    });
    traceActivities = Array.isArray(
      hbomModule.getCollectorTrace?.(preflightBom)?.activities,
    )
      ? hbomModule.getCollectorTrace(preflightBom).activities
      : Array.isArray(preflightTrace?.activities)
        ? preflightTrace.activities
        : [];
  } else if (
    hasCommandAllowlist &&
    normalizedOptions.includeCommandEnrichment !== false
  ) {
    traceActivities = hbomModule
      .getCommandPlan(normalizedOptions)
      .flatMap((planEntry) =>
        buildHbomPlanActivities(planEntry, normalizedOptions),
      );
  }

  const disallowedCommands =
    hasCommandAllowlist && normalizedOptions.includeCommandEnrichment !== false
      ? collectDisallowedHbomCommands(traceActivities, commandAllowlistValue)
      : [];
  const disallowedPaths = hasPathAllowlist
    ? collectDisallowedHbomPaths(traceActivities)
    : [];

  if (!disallowedCommands.length && !disallowedPaths.length) {
    return;
  }

  for (const commandEntry of disallowedCommands) {
    recordActivity({
      kind: "policy",
      policyType: "hbom-command-allowlist",
      reason:
        "HBOM secure-mode preflight blocked a planned command outside CDXGEN_ALLOWED_COMMANDS.",
      status: "blocked",
      target: commandEntry.command,
    });
  }
  for (const pathEntry of disallowedPaths) {
    recordActivity({
      kind: "policy",
      policyType: "hbom-path-allowlist",
      reason:
        "HBOM secure-mode preflight blocked a declared path outside CDXGEN_ALLOWED_PATHS.",
      status: "blocked",
      target: pathEntry.path,
    });
  }

  throw createHbomAllowlistPreflightError(disallowedCommands, disallowedPaths);
}

/**
 * Determine whether the supplied project types include HBOM.
 *
 * @param {string|string[]|undefined|null} projectTypes Project types.
 * @returns {boolean} True when HBOM is requested.
 */
export function hasHbomProjectType(projectTypes) {
  return normalizeProjectTypes(projectTypes).some((projectType) =>
    HBOM_PROJECT_TYPE_SET.has(projectType),
  );
}

/**
 * Determine whether the supplied project types are exclusively HBOM-oriented.
 *
 * @param {string|string[]|undefined|null} projectTypes Project types.
 * @returns {boolean} True when at least one project type is supplied and all are HBOM-oriented.
 */
export function isHbomOnlyProjectTypes(projectTypes) {
  const normalizedProjectTypes = normalizeProjectTypes(projectTypes);
  return (
    normalizedProjectTypes.length > 0 &&
    normalizedProjectTypes.every((projectType) =>
      HBOM_PROJECT_TYPE_SET.has(projectType),
    )
  );
}

/**
 * Reject mixed HBOM and non-HBOM project types.
 *
 * @param {string|string[]|undefined|null} projectTypes Project types.
 */
export function ensureNoMixedHbomProjectTypes(projectTypes) {
  const normalizedProjectTypes = normalizeProjectTypes(projectTypes);
  if (
    !normalizedProjectTypes.length ||
    !hasHbomProjectType(normalizedProjectTypes)
  ) {
    return;
  }
  const nonHbomProjectTypes = normalizedProjectTypes.filter(
    (projectType) => !HBOM_PROJECT_TYPE_SET.has(projectType),
  );
  if (nonHbomProjectTypes.length) {
    throw new Error(
      `HBOM project types cannot be mixed with other project types: ${normalizedProjectTypes.join(", ")}. Generate HBOM separately using 'hbom' or 'cdxgen -t hbom'.`,
    );
  }
}

/**
 * Ensure HBOM generation uses the supported CycloneDX version.
 *
 * @param {number|string|undefined|null} specVersion Requested spec version.
 */
export function ensureSupportedHbomSpecVersion(specVersion) {
  if (specVersion === undefined || specVersion === null || specVersion === "") {
    return;
  }
  if (Number(specVersion) !== 1.7) {
    throw new Error("HBOM generation currently supports only CycloneDX 1.7.");
  }
}

/**
 * Translate cdxgen CLI options to cdx-hbom collector options.
 *
 * @param {object} [options={}] CLI options.
 * @returns {object} cdx-hbom collector options.
 */
export function normalizeHbomOptions(options = {}) {
  const timeoutValue = options.timeoutMs ?? options.timeout;
  const timeoutMs =
    timeoutValue === undefined || timeoutValue === null || timeoutValue === ""
      ? undefined
      : Number.parseInt(`${timeoutValue}`, 10);
  const includeCommandEnrichment =
    options.includeCommandEnrichment ?? !options.noCommandEnrichment;
  const allowPartial = options.allowPartial ?? !options.strict;

  return {
    allowPartial,
    architecture: options.arch ?? options.architecture,
    dryRun: options.dryRun ?? isDryRun,
    includeCommandEnrichment,
    includePlistEnrichment:
      options.includePlistEnrichment ?? options.plistEnrichment ?? false,
    includePrivilegedEnrichment:
      options.includePrivilegedEnrichment ?? options.privileged ?? false,
    includeSensitiveIdentifiers:
      options.includeSensitiveIdentifiers ?? options.sensitive ?? false,
    platform: options.platform,
    timeoutMs:
      Number.isNaN(timeoutMs) || timeoutMs <= 0 ? undefined : timeoutMs,
  };
}

function getHbomTraceKind(activity) {
  if (activity.kind === "command") {
    return "execute";
  }
  if (activity.kind === "file-read" || activity.kind === "symlink-read") {
    return "read";
  }
  if (activity.kind === "dir-read") {
    return "discover";
  }
  return activity.kind || "hbom";
}

function getHbomTraceReason(activity) {
  if (activity.reason) {
    return activity.reason;
  }
  if (activity.kind === "command") {
    if (activity.status === "completed") {
      return undefined;
    }
    return `HBOM command ${activity.id || activity.command || activity.target} did not complete successfully.`;
  }
  return undefined;
}

function recordHbomCollectorTrace(trace) {
  const activities = Array.isArray(trace?.activities) ? trace.activities : [];
  for (const activity of activities) {
    recordActivity({
      category: activity.category,
      commandId: activity.id,
      hbomActivityKind: activity.kind,
      parser: activity.parser,
      phase: activity.phase,
      purpose: activity.purpose,
      kind: getHbomTraceKind(activity),
      reason: getHbomTraceReason(activity),
      status: activity.status,
      target: activity.target,
    });
  }
}

/**
 * Build an activity target for the requested HBOM collection.
 *
 * @param {object} [options={}] CLI options.
 * @returns {string} Activity target description.
 */
function getHbomCollectionTarget(options = {}) {
  const platform = options.platform ? `${options.platform}`.trim() : "";
  const architecture = options.architecture ?? options.arch;
  const normalizedArchitecture = architecture ? `${architecture}`.trim() : "";
  if (platform && normalizedArchitecture) {
    return `${platform}/${normalizedArchitecture}`;
  }
  if (platform || normalizedArchitecture) {
    return platform || normalizedArchitecture;
  }
  return "current-host";
}

/**
 * Create a minimal CycloneDX HBOM document for dry-run mode.
 *
 * @param {object} [options={}] CLI options.
 * @returns {object} Synthetic CycloneDX HBOM document.
 */
function createDryRunHbomDocument(options = {}) {
  return {
    bomFormat: "CycloneDX",
    components: [],
    dependencies: [],
    metadata: {
      timestamp: new Date().toISOString(),
      tools: {
        components: [],
      },
    },
    specVersion: `${options.specVersion || "1.7"}`,
    version: 1,
  };
}

function addUniqueStringProperty(properties, propertyName, propertyValue) {
  if (propertyValue === undefined || propertyValue === null) {
    return;
  }
  const normalizedValue = `${propertyValue}`.trim();
  if (!normalizedValue) {
    return;
  }
  if (
    properties.some(
      (property) =>
        property?.name === propertyName &&
        `${property?.value ?? ""}` === normalizedValue,
    )
  ) {
    return;
  }
  properties.push({
    name: propertyName,
    value: normalizedValue,
  });
}

export function addHbomAnalysisProperties(bomJson) {
  if (!bomJson || typeof bomJson !== "object") {
    return bomJson;
  }

  const commandDiagnosticSummary = getHbomCommandDiagnosticSummary(bomJson);
  const retainedProperties = Array.isArray(bomJson.properties)
    ? bomJson.properties.filter(
        (property) =>
          !`${property?.name || ""}`.startsWith("cdx:hbom:analysis:"),
      )
    : [];

  addUniqueStringProperty(
    retainedProperties,
    "cdx:hbom:analysis:commandDiagnosticCount",
    commandDiagnosticSummary.commandDiagnosticCount,
  );
  addUniqueStringProperty(
    retainedProperties,
    "cdx:hbom:analysis:actionableDiagnosticCount",
    commandDiagnosticSummary.actionableDiagnosticCount,
  );
  addUniqueStringProperty(
    retainedProperties,
    "cdx:hbom:analysis:missingCommandCount",
    commandDiagnosticSummary.missingCommandCount,
  );
  addUniqueStringProperty(
    retainedProperties,
    "cdx:hbom:analysis:installHintCount",
    commandDiagnosticSummary.installHintCount,
  );
  addUniqueStringProperty(
    retainedProperties,
    "cdx:hbom:analysis:permissionDeniedCount",
    commandDiagnosticSummary.permissionDeniedCount,
  );
  addUniqueStringProperty(
    retainedProperties,
    "cdx:hbom:analysis:privilegeHintCount",
    commandDiagnosticSummary.privilegeHintCount,
  );
  addUniqueStringProperty(
    retainedProperties,
    "cdx:hbom:analysis:partialSupportCount",
    commandDiagnosticSummary.partialSupportCount,
  );
  addUniqueStringProperty(
    retainedProperties,
    "cdx:hbom:analysis:timeoutCount",
    commandDiagnosticSummary.timeoutCount,
  );
  addUniqueStringProperty(
    retainedProperties,
    "cdx:hbom:analysis:commandErrorCount",
    commandDiagnosticSummary.commandErrorCount,
  );
  if (commandDiagnosticSummary.diagnosticIssues.length) {
    addUniqueStringProperty(
      retainedProperties,
      "cdx:hbom:analysis:diagnosticIssues",
      commandDiagnosticSummary.diagnosticIssues.join(","),
    );
  }
  if (commandDiagnosticSummary.missingCommands.length) {
    addUniqueStringProperty(
      retainedProperties,
      "cdx:hbom:analysis:missingCommands",
      commandDiagnosticSummary.missingCommands.join(","),
    );
  }
  if (commandDiagnosticSummary.missingCommandIds.length) {
    addUniqueStringProperty(
      retainedProperties,
      "cdx:hbom:analysis:missingCommandIds",
      commandDiagnosticSummary.missingCommandIds.join(","),
    );
  }
  if (commandDiagnosticSummary.permissionDeniedCommands.length) {
    addUniqueStringProperty(
      retainedProperties,
      "cdx:hbom:analysis:permissionDeniedCommands",
      commandDiagnosticSummary.permissionDeniedCommands.join(","),
    );
  }
  if (commandDiagnosticSummary.permissionDeniedIds.length) {
    addUniqueStringProperty(
      retainedProperties,
      "cdx:hbom:analysis:permissionDeniedIds",
      commandDiagnosticSummary.permissionDeniedIds.join(","),
    );
  }
  if (commandDiagnosticSummary.partialSupportIds.length) {
    addUniqueStringProperty(
      retainedProperties,
      "cdx:hbom:analysis:partialSupportIds",
      commandDiagnosticSummary.partialSupportIds.join(","),
    );
  }
  if (commandDiagnosticSummary.timeoutIds.length) {
    addUniqueStringProperty(
      retainedProperties,
      "cdx:hbom:analysis:timeoutIds",
      commandDiagnosticSummary.timeoutIds.join(","),
    );
  }
  if (commandDiagnosticSummary.commandErrorIds.length) {
    addUniqueStringProperty(
      retainedProperties,
      "cdx:hbom:analysis:commandErrorIds",
      commandDiagnosticSummary.commandErrorIds.join(","),
    );
  }
  if (commandDiagnosticSummary.requiresPrivilegedEnrichment) {
    addUniqueStringProperty(
      retainedProperties,
      "cdx:hbom:analysis:requiresPrivileged",
      true,
    );
  }

  bomJson.properties = retainedProperties;
  return bomJson;
}

/**
 * Generate an HBOM using the optional cdx-hbom package.
 *
 * @param {object} [options={}] CLI options.
 * @returns {Promise<object>} CycloneDX HBOM document.
 */
export async function createHbomDocument(options = {}) {
  ensureSupportedHbomSpecVersion(options.specVersion);
  const hbomModule = await importHbomModule(options);
  if (typeof hbomModule.collectHardware !== "function") {
    throw new Error(
      "The installed '@cdxgen/cdx-hbom' package does not expose collectHardware().",
    );
  }
  const normalizedOptions = normalizeHbomOptions(options);
  await enforceSecureModeHbomAllowlists(hbomModule, normalizedOptions);
  if (isDryRun && typeof hbomModule.createCollectorTrace === "function") {
    normalizedOptions.trace = hbomModule.createCollectorTrace();
  } else if (isDryRun) {
    recordActivity({
      kind: "hbom",
      reason:
        "Dry run mode blocks HBOM collection and reports the requested host inventory instead.",
      status: "blocked",
      target: getHbomCollectionTarget(options),
    });
    return createDryRunHbomDocument(options);
  }
  const bomJson = addHbomAnalysisProperties(
    await hbomModule.collectHardware(normalizedOptions),
  );
  if (isDryRun) {
    recordHbomCollectorTrace(
      hbomModule.getCollectorTrace?.(bomJson) ?? normalizedOptions.trace,
    );
  }
  return bomJson;
}

/**
 * Normalize project types to lowercase strings.
 *
 * @param {string|string[]|undefined|null} projectTypes Project types.
 * @returns {string[]} Normalized project types.
 */
function normalizeProjectTypes(projectTypes) {
  if (!projectTypes) {
    return [];
  }
  const values = Array.isArray(projectTypes) ? projectTypes : [projectTypes];
  return values
    .flatMap((projectType) => `${projectType}`.split(","))
    .map((projectType) => projectType.trim().toLowerCase())
    .filter(Boolean);
}
