import { Purl } from "@cdxgen/cdx-purl";

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
  // Only a string is a purl. Anything else would become the bom-ref as it is,
  // and be written out again for every relationship that names the element.
  const purl =
    typeof spdxElement?.software_packageUrl === "string"
      ? spdxElement.software_packageUrl
      : undefined;
  let group = "";
  let name = spdxElement?.name || spdxElement?.spdxId || "unnamed-component";
  let version = spdxElement?.software_packageVersion || "";
  if (purl) {
    try {
      const purlObj = Purl.parse(purl);
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

/**
 * Convert an SPDX 3.x JSON-LD document into a CycloneDX-like BOM object.
 *
 * Maps `software_Package` and `software_File` graph elements to components and
 * `dependsOn` relationships to a dependency list. Input that is not SPDX
 * JSON-LD is returned unchanged.
 *
 * A relationship names its elements by `spdxId`, and each one is written out
 * as the bom-ref of the component, which is its purl. The dependency list can
 * therefore be many times the size of the document: the purl a package states
 * once is repeated for every relationship that names the package.
 * `maxResolvedRefLength` bounds the characters written this way for a caller
 * that converts a document it does not trust.
 *
 * @param {Object} bomJson SPDX JSON-LD or CycloneDX-like document
 * @param {Object} [options] Conversion options
 * @param {number} [options.maxResolvedRefLength] Most characters of bom-refs the relationships may resolve to. Unbounded by default
 * @returns {Object} BOM object carrying `components` and `dependencies`
 * @throws {RangeError} When the relationships resolve to more than `maxResolvedRefLength` characters
 */
export const toCycloneDxLikeBom = (
  bomJson,
  { maxResolvedRefLength = Number.POSITIVE_INFINITY } = {},
) => {
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
  let resolvedRefLength = 0;
  const resolveRef = (spdxId) => {
    const ref = spdxIdToRef.get(spdxId);
    if (!ref) {
      return spdxId;
    }
    // Counted per use, repeats included, and before the ref is looked up or
    // compared anywhere: those steps cost its length again each time.
    resolvedRefLength += String(ref).length;
    if (resolvedRefLength > maxResolvedRefLength) {
      throw new RangeError(
        `relationships resolve to more than ${maxResolvedRefLength} characters of references`,
      );
    }
    return ref;
  };
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
    const fromRef = resolveRef(element.from);
    const toRefs = toArray(element?.to).map(resolveRef);
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
