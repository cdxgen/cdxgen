import { PackageURL } from "packageurl-js";

import { isSpdxJsonLd } from "./bomUtils.js";

const toArray = (value) => {
  if (Array.isArray(value)) {
    return value;
  }
  if (value !== undefined && value !== null) {
    return [value];
  }
  return [];
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
