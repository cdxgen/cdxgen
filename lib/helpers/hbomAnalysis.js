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
    architecture:
      getPropertyValue(metadataComponent, "cdx:hbom:architecture") ||
      getPropertyValue(bomJson, "cdx:hbom:targetArchitecture") ||
      getPropertyValue(bomJson, "cdx:hbom:architecture"),
    collectorProfile: getPropertyValue(bomJson, "cdx:hbom:collectorProfile"),
    componentCount: (bomJson?.components || []).length,
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
    manufacturer: metadataComponent?.manufacturer?.name,
    metadataName: metadataComponent?.name,
    metadataType: metadataComponent?.type,
    platform:
      getPropertyValue(metadataComponent, "cdx:hbom:platform") ||
      getPropertyValue(bomJson, "cdx:hbom:targetPlatform") ||
      getPropertyValue(bomJson, "cdx:hbom:platform"),
    topHardwareClasses: hardwareClassCounts.slice(0, 5),
  };
}
