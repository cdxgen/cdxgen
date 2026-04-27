import { PackageURL } from "packageurl-js";

const SPDX_CONTEXT_PREFIX = "https://spdx.org/rdf/";
const CYCLONEDX_FORMAT = "CycloneDX";
const BOM_FORMAT_CYCLONEDX = "cyclonedx";
const BOM_FORMAT_SPDX = "spdx";
const BOM_FORMAT_UNKNOWN = "unknown";

const toArray = (value) => {
  if (Array.isArray(value)) {
    return value;
  }
  if (value !== undefined && value !== null) {
    return [value];
  }
  return [];
};

export const isSpdxJsonLd = (bomJson) =>
  Boolean(
    bomJson?.["@context"]?.startsWith(SPDX_CONTEXT_PREFIX) &&
      Array.isArray(bomJson?.["@graph"]) &&
      bomJson["@graph"].some((element) => element?.type === "SpdxDocument"),
  );

export const isCycloneDxBom = (bomJson) =>
  bomJson?.bomFormat === CYCLONEDX_FORMAT && Boolean(bomJson?.specVersion);

export const detectBomFormat = (bomJson) => {
  if (isCycloneDxBom(bomJson)) {
    return BOM_FORMAT_CYCLONEDX;
  }
  if (isSpdxJsonLd(bomJson)) {
    return BOM_FORMAT_SPDX;
  }
  return BOM_FORMAT_UNKNOWN;
};

export const getNonCycloneDxErrorMessage = (
  bomJson,
  commandName = "This command",
) => {
  const detectedFormat = detectBomFormat(bomJson);
  if (detectedFormat === BOM_FORMAT_SPDX) {
    return `${commandName} expects a CycloneDX BOM. SPDX input is not supported for this command.`;
  }
  return `${commandName} expects a CycloneDX JSON BOM.`;
};

const toCycloneDxLikeComponent = (spdxElement) => {
  const purl = spdxElement?.software_packageUrl;
  let group = "";
  let name = spdxElement?.name || spdxElement?.spdxId || "unnamed-component";
  let version = spdxElement?.software_packageVersion || "";
  if (purl) {
    try {
      const purlObj = PackageURL.fromString(purl);
      group = purlObj.namespace || "";
      name = purlObj.name || name;
      version = purlObj.version || version;
    } catch (_err) {
      // Keep SPDX element values when purl parsing fails.
    }
  }
  return {
    type: spdxElement?.type === "software_File" ? "file" : "library",
    group,
    name,
    version,
    purl,
    "bom-ref": purl || spdxElement?.spdxId || name,
    description: spdxElement?.description,
  };
};

export const toCycloneDxLikeBom = (bomJson) => {
  if (!isSpdxJsonLd(bomJson)) {
    return bomJson;
  }
  const graphElements = toArray(bomJson?.["@graph"]);
  const packageElements = graphElements.filter((element) =>
    ["software_Package", "software_File"].includes(element?.type),
  );
  const components = packageElements.map(toCycloneDxLikeComponent);
  const spdxIdToRef = new Map();
  for (let index = 0; index < packageElements.length; index++) {
    const spdxId = packageElements[index]?.spdxId;
    if (spdxId) {
      spdxIdToRef.set(spdxId, components[index]["bom-ref"]);
    }
  }
  const dependencyMap = new Map();
  for (const component of components) {
    dependencyMap.set(component["bom-ref"], new Set());
  }
  for (const element of graphElements) {
    if (
      element?.type !== "Relationship" ||
      element?.relationshipType !== "dependsOn"
    ) {
      continue;
    }
    if (!element?.from || typeof element.from !== "string") {
      continue;
    }
    const fromRef = spdxIdToRef.get(element.from) || element.from;
    const toRefs = toArray(element?.to).map(
      (toRef) => spdxIdToRef.get(toRef) || toRef,
    );
    if (!dependencyMap.has(fromRef)) {
      dependencyMap.set(fromRef, new Set());
    }
    const dependsOnSet = dependencyMap.get(fromRef);
    for (const toRef of toRefs) {
      if (toRef) {
        dependsOnSet.add(toRef);
      }
    }
  }
  const dependencies = [];
  for (const [ref, dependsOnSet] of dependencyMap.entries()) {
    dependencies.push({
      ref,
      dependsOn: Array.from(dependsOnSet).sort(),
    });
  }
  return {
    ...bomJson,
    components,
    dependencies,
  };
};
