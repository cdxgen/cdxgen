import { getHbomCommandDiagnosticSummary } from "./hbomAnalysis.js";
import { importHbomModule } from "./hbomLoader.js";
import { isDryRun, recordActivity } from "./utils.js";

const HBOM_PROJECT_TYPE_SET = new Set(["hardware", "hbom"]);

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
