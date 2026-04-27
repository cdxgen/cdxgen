import { PackageURL } from "packageurl-js";

const SUPPORTED_PURL_TYPES = new Set(["npm", "pypi"]);

/**
 * Normalize package names for safe matching and grouping.
 *
 * @param {string | undefined} packageName package name
 * @returns {string} normalized package name
 */
export function normalizePackageName(packageName) {
  if (!packageName || typeof packageName !== "string") {
    return "";
  }
  return packageName.toLowerCase().replace(/[-_.]+/g, "-");
}

/**
 * Extract npm and PyPI package-url targets from a CycloneDX BOM.
 *
 * @param {object} bomJson CycloneDX BOM
 * @param {string} sourceName source BOM path or label
 * @returns {{ targets: object[], skipped: object[] }} extracted targets and skipped components
 */
export function extractPurlTargetsFromBom(bomJson, sourceName) {
  const targets = [];
  const skipped = [];
  const components = Array.isArray(bomJson?.components)
    ? bomJson.components
    : [];
  for (const component of components) {
    const componentPurl = component?.purl;
    if (!componentPurl) {
      continue;
    }
    let purlObj;
    try {
      purlObj = PackageURL.fromString(componentPurl);
    } catch {
      skipped.push({
        reason: "invalid-purl",
        source: sourceName,
        purl: componentPurl,
        bomRef: component?.["bom-ref"],
        name: component?.name,
      });
      continue;
    }
    if (!SUPPORTED_PURL_TYPES.has(purlObj.type)) {
      skipped.push({
        reason: "unsupported-ecosystem",
        source: sourceName,
        purl: componentPurl,
        bomRef: component?.["bom-ref"],
        name: component?.name,
        type: purlObj.type,
      });
      continue;
    }
    targets.push({
      bomRef: component?.["bom-ref"],
      name: purlObj.name,
      namespace: purlObj.namespace,
      purl: componentPurl,
      qualifiers: purlObj.qualifiers,
      source: sourceName,
      type: purlObj.type,
      version: purlObj.version,
    });
  }
  return { skipped, targets };
}

/**
 * Merge targets across many BOMs by purl.
 *
 * @param {{ source: string, bomJson: object }[]} inputBoms input BOMs
 * @param {number | undefined} maxTargets optional upper bound for target count
 * @returns {{ targets: object[], skipped: object[] }} merged targets and skipped components
 */
export function collectAuditTargets(inputBoms, maxTargets) {
  const skipped = [];
  const targetMap = new Map();
  for (const inputBom of inputBoms) {
    const extracted = extractPurlTargetsFromBom(
      inputBom.bomJson,
      inputBom.source,
    );
    skipped.push(...extracted.skipped);
    for (const target of extracted.targets) {
      const existing = targetMap.get(target.purl);
      if (existing) {
        existing.sources.add(target.source);
        if (target.bomRef) {
          existing.bomRefs.add(target.bomRef);
        }
        continue;
      }
      targetMap.set(target.purl, {
        ...target,
        bomRefs: new Set(target.bomRef ? [target.bomRef] : []),
        sources: new Set([target.source]),
      });
    }
  }
  let targets = [...targetMap.values()].map((target) => ({
    ...target,
    bomRefs: [...target.bomRefs].sort(),
    normalizedName: normalizePackageName(target.name),
    sources: [...target.sources].sort(),
  }));
  targets.sort((left, right) => left.purl.localeCompare(right.purl));
  if (typeof maxTargets === "number" && maxTargets > 0) {
    targets = targets.slice(0, maxTargets);
  }
  return { skipped, targets };
}

export { SUPPORTED_PURL_TYPES };
