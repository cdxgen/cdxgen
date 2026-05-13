import { getPropertyValue } from "./inventoryStats.js";

function getPropertyValues(propertiesOrObject, propertyName) {
  const properties = Array.isArray(propertiesOrObject)
    ? propertiesOrObject
    : Array.isArray(propertiesOrObject?.properties)
      ? propertiesOrObject.properties
      : [];
  return properties
    .filter((property) => property?.name === propertyName)
    .map((property) => property.value)
    .filter(
      (value) => value !== undefined && value !== null && `${value}` !== "",
    );
}

function safeParseDiagnosticValue(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    const parsedValue = JSON.parse(value);
    if (!parsedValue || typeof parsedValue !== "object") {
      return undefined;
    }
    return parsedValue;
  } catch {
    return undefined;
  }
}

function uniqueSortedStrings(values = []) {
  return [
    ...new Set(values.map((value) => `${value}`.trim()).filter(Boolean)),
  ].sort((firstValue, secondValue) => firstValue.localeCompare(secondValue));
}

function getDiagnosticIdentifiers(commandDiagnostics = []) {
  return uniqueSortedStrings(
    commandDiagnostics
      .map((entry) => entry.id ?? entry.command)
      .filter((value) => value !== undefined && value !== null),
  );
}

export function getHbomCommandDiagnostics(bomJson) {
  return getPropertyValues(bomJson, "cdx:hbom:evidence:commandDiagnostic")
    .map((value) => safeParseDiagnosticValue(value))
    .filter(Boolean);
}

export function getHbomCommandDiagnosticSummary(bomJson) {
  const commandDiagnostics = getHbomCommandDiagnostics(bomJson);
  const missingCommandDiagnostics = commandDiagnostics.filter(
    (entry) => entry.issue === "missing-command",
  );
  const permissionDeniedDiagnostics = commandDiagnostics.filter(
    (entry) => entry.issue === "permission-denied",
  );
  const partialSupportDiagnostics = commandDiagnostics.filter(
    (entry) => entry.issue === "partial-support",
  );
  const timeoutDiagnostics = commandDiagnostics.filter(
    (entry) => entry.issue === "timeout",
  );
  const commandErrorDiagnostics = commandDiagnostics.filter(
    (entry) => entry.issue === "command-error",
  );
  const installHints = uniqueSortedStrings(
    missingCommandDiagnostics
      .map((entry) => entry.installHint)
      .filter((value) => value !== undefined && value !== null),
  );
  const privilegeHints = uniqueSortedStrings(
    permissionDeniedDiagnostics
      .map((entry) => entry.privilegeHint)
      .filter((value) => value !== undefined && value !== null),
  );
  const missingCommands = uniqueSortedStrings(
    missingCommandDiagnostics
      .map((entry) => entry.command ?? entry.id)
      .filter((value) => value !== undefined && value !== null),
  );
  const permissionDeniedCommands = uniqueSortedStrings(
    permissionDeniedDiagnostics
      .map((entry) => entry.command ?? entry.id)
      .filter((value) => value !== undefined && value !== null),
  );
  const diagnosticIssues = uniqueSortedStrings(
    commandDiagnostics
      .map((entry) => entry.issue)
      .filter((value) => value !== undefined && value !== null),
  );

  return {
    actionableDiagnosticCount:
      missingCommandDiagnostics.length + permissionDeniedDiagnostics.length,
    commandDiagnosticCount: commandDiagnostics.length,
    commandDiagnostics,
    commandErrorCount: commandErrorDiagnostics.length,
    commandErrorIds: getDiagnosticIdentifiers(commandErrorDiagnostics),
    diagnosticIssues,
    installHintCount: installHints.length,
    installHints,
    missingCommandCount: missingCommandDiagnostics.length,
    missingCommandIds: getDiagnosticIdentifiers(missingCommandDiagnostics),
    missingCommands,
    partialSupportCount: partialSupportDiagnostics.length,
    partialSupportIds: getDiagnosticIdentifiers(partialSupportDiagnostics),
    permissionDeniedCommands,
    permissionDeniedCount: permissionDeniedDiagnostics.length,
    permissionDeniedIds: getDiagnosticIdentifiers(permissionDeniedDiagnostics),
    privilegeHintCount: privilegeHints.length,
    privilegeHints,
    requiresPrivilegedEnrichment:
      permissionDeniedDiagnostics.length > 0 && privilegeHints.length > 0,
    timeoutIds: getDiagnosticIdentifiers(timeoutDiagnostics),
    timeoutCount: timeoutDiagnostics.length,
  };
}

export function isHbomLikeBom(bomJson) {
  if (!bomJson) {
    return false;
  }
  if (
    getPropertyValues(bomJson, "cdx:hbom:collectorProfile").length ||
    getPropertyValues(bomJson, "cdx:hbom:targetPlatform").length ||
    (bomJson?.properties || []).some((property) =>
      `${property?.name || ""}`.startsWith("cdx:hbom:"),
    )
  ) {
    return true;
  }
  if (
    (bomJson?.metadata?.component?.properties || []).some((property) =>
      `${property?.name || ""}`.startsWith("cdx:hbom:"),
    )
  ) {
    return true;
  }
  return (bomJson?.components || []).some((component) =>
    (component?.properties || []).some(
      (property) =>
        property?.name === "cdx:hbom:hardwareClass" ||
        `${property?.name || ""}`.startsWith("cdx:hbom:"),
    ),
  );
}

export function getHbomHardwareClass(component) {
  return getPropertyValue(component, "cdx:hbom:hardwareClass");
}

export function getHbomHardwareClassCounts(components = []) {
  const counts = new Map();
  for (const component of components || []) {
    const hardwareClass = getHbomHardwareClass(component);
    if (!hardwareClass) {
      continue;
    }
    counts.set(hardwareClass, (counts.get(hardwareClass) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([hardwareClass, count]) => ({ hardwareClass, count }))
    .sort(
      (firstEntry, secondEntry) =>
        secondEntry.count - firstEntry.count ||
        firstEntry.hardwareClass.localeCompare(secondEntry.hardwareClass),
    );
}

export function formatHbomHardwareClassSummary(hardwareClassCounts = []) {
  return hardwareClassCounts
    .slice(0, 5)
    .map(({ hardwareClass, count }) => `${hardwareClass} (${count})`)
    .join(", ");
}

export function getHbomSummary(bomJson) {
  const metadataComponent = bomJson?.metadata?.component;
  const hardwareClassCounts = getHbomHardwareClassCounts(
    bomJson?.components || [],
  );
  const commandDiagnosticSummary = getHbomCommandDiagnosticSummary(bomJson);
  const evidenceCommands = getPropertyValues(
    bomJson,
    "cdx:hbom:evidence:command",
  );
  const evidenceFiles = getPropertyValues(bomJson, "cdx:hbom:evidence:file");
  const commandCountValue = getPropertyValue(
    bomJson,
    "cdx:hbom:evidence:commandCount",
  );
  const fileCountValue = getPropertyValue(
    bomJson,
    "cdx:hbom:evidence:fileCount",
  );
  const evidenceCommandCount = Number.parseInt(
    `${commandCountValue ?? evidenceCommands.length}`,
    10,
  );
  const evidenceFileCount = Number.parseInt(
    `${fileCountValue ?? evidenceFiles.length}`,
    10,
  );

  return {
    actionableDiagnosticCount:
      commandDiagnosticSummary.actionableDiagnosticCount,
    architecture:
      getPropertyValue(metadataComponent, "cdx:hbom:architecture") ||
      getPropertyValue(bomJson, "cdx:hbom:targetArchitecture") ||
      getPropertyValue(bomJson, "cdx:hbom:architecture"),
    collectorProfile: getPropertyValue(bomJson, "cdx:hbom:collectorProfile"),
    commandDiagnosticCount: commandDiagnosticSummary.commandDiagnosticCount,
    commandDiagnostics: commandDiagnosticSummary.commandDiagnostics,
    commandErrorCount: commandDiagnosticSummary.commandErrorCount,
    commandErrorIds: commandDiagnosticSummary.commandErrorIds,
    componentCount: (bomJson?.components || []).length,
    diagnosticIssues: commandDiagnosticSummary.diagnosticIssues,
    evidenceCommandCount: Number.isNaN(evidenceCommandCount)
      ? evidenceCommands.length
      : evidenceCommandCount,
    evidenceCommands,
    evidenceFileCount: Number.isNaN(evidenceFileCount)
      ? evidenceFiles.length
      : evidenceFileCount,
    evidenceFiles,
    hardwareClassCount: hardwareClassCounts.length,
    hardwareClassCounts,
    identifierPolicy:
      getPropertyValue(metadataComponent, "cdx:hbom:identifierPolicy") ||
      getPropertyValue(bomJson, "cdx:hbom:identifierPolicy"),
    installHintCount: commandDiagnosticSummary.installHintCount,
    installHints: commandDiagnosticSummary.installHints,
    manufacturer: metadataComponent?.manufacturer?.name,
    metadataName: metadataComponent?.name,
    metadataType: metadataComponent?.type,
    missingCommandCount: commandDiagnosticSummary.missingCommandCount,
    missingCommandIds: commandDiagnosticSummary.missingCommandIds,
    missingCommands: commandDiagnosticSummary.missingCommands,
    partialSupportCount: commandDiagnosticSummary.partialSupportCount,
    partialSupportIds: commandDiagnosticSummary.partialSupportIds,
    platform:
      getPropertyValue(metadataComponent, "cdx:hbom:platform") ||
      getPropertyValue(bomJson, "cdx:hbom:targetPlatform") ||
      getPropertyValue(bomJson, "cdx:hbom:platform"),
    permissionDeniedCommands: commandDiagnosticSummary.permissionDeniedCommands,
    permissionDeniedCount: commandDiagnosticSummary.permissionDeniedCount,
    permissionDeniedIds: commandDiagnosticSummary.permissionDeniedIds,
    privilegeHintCount: commandDiagnosticSummary.privilegeHintCount,
    privilegeHints: commandDiagnosticSummary.privilegeHints,
    requiresPrivilegedEnrichment:
      commandDiagnosticSummary.requiresPrivilegedEnrichment,
    timeoutIds: commandDiagnosticSummary.timeoutIds,
    timeoutCount: commandDiagnosticSummary.timeoutCount,
    topHardwareClasses: hardwareClassCounts.slice(0, 5),
  };
}
