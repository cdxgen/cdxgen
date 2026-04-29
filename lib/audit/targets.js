import { PackageURL } from "packageurl-js";

import { hasTrustedPublishingProperties } from "../helpers/provenanceUtils.js";

const SUPPORTED_PURL_TYPES = new Set(["npm", "pypi"]);
const NON_REQUIRED_SCOPES = new Set(["excluded", "optional"]);

/**
 * Normalize predictive audit target selection options.
 *
 * @param {number | object | undefined} options selector options or legacy maxTargets value
 * @returns {{
 *   maxTargets: number | undefined,
 *   scope: string | undefined,
 *   trusted: "exclude" | "include" | "only",
 * }} normalized options
 */
function normalizeTargetSelectionOptions(options) {
  if (typeof options === "number") {
    return {
      maxTargets: options,
      prioritizeDirectRuntime: false,
      scope: undefined,
      trusted: "exclude",
    };
  }
  return {
    maxTargets: options?.maxTargets,
    prioritizeDirectRuntime: options?.prioritizeDirectRuntime === true,
    scope: options?.scope === "required" ? "required" : undefined,
    trusted:
      options?.trusted === "only"
        ? "only"
        : options?.trusted === "include"
          ? "include"
          : "exclude",
  };
}

/**
 * Determine whether a CycloneDX component scope should be treated as required.
 *
 * Missing scope is treated as required to match the main BOM filtering flow.
 *
 * @param {string | undefined} scope component scope
 * @returns {boolean} true when the component is required for predictive audit selection
 */
export function isRequiredComponentScope(scope) {
  if (!scope || typeof scope !== "string") {
    return true;
  }
  return !NON_REQUIRED_SCOPES.has(scope.toLowerCase());
}

function normalizeComponentScope(scope) {
  if (!scope || typeof scope !== "string") {
    return undefined;
  }
  return scope.toLowerCase();
}

function getComponentPropertyValue(component, propertyName) {
  return component?.properties?.find(
    (property) => property.name === propertyName,
  )?.value;
}

function hasTruthyComponentProperty(component, propertyName) {
  return getComponentPropertyValue(component, propertyName) === "true";
}

function hasNonEmptyComponentProperty(component, propertyName) {
  const propertyValue = getComponentPropertyValue(component, propertyName);
  return typeof propertyValue === "string" && propertyValue.trim().length > 0;
}

function extractRootDependencyRefs(bomJson) {
  const directRefs = new Set();
  const rootRef =
    bomJson?.metadata?.component?.["bom-ref"] ||
    bomJson?.metadata?.component?.bomRef ||
    bomJson?.metadata?.component?.purl;
  if (!rootRef || !Array.isArray(bomJson?.dependencies)) {
    return directRefs;
  }
  const rootDependency = bomJson.dependencies.find(
    (dependency) => dependency?.ref === rootRef,
  );
  if (!Array.isArray(rootDependency?.dependsOn)) {
    return directRefs;
  }
  for (const dependencyRef of rootDependency.dependsOn) {
    if (dependencyRef) {
      directRefs.add(dependencyRef);
    }
  }
  return directRefs;
}

function isPlatformSpecificComponent(component, type) {
  if (type === "npm") {
    return ["cdx:npm:cpu", "cdx:npm:libc", "cdx:npm:os"].some((propertyName) =>
      hasNonEmptyComponentProperty(component, propertyName),
    );
  }
  if (type === "pypi") {
    return [
      "cdx:pip:markers",
      "cdx:pypi:requiresPython",
      "cdx:python:requires_python",
    ].some((propertyName) =>
      hasNonEmptyComponentProperty(component, propertyName),
    );
  }
  return false;
}

function isDevelopmentOnlyComponent(component, type) {
  if (type === "npm") {
    return hasTruthyComponentProperty(component, "cdx:npm:package:development");
  }
  return false;
}

function triagePriorityScore(target) {
  let priority = 0;
  if (target?.directDependency) {
    priority += 8;
  }
  if (target?.required) {
    priority += 4;
  }
  if (!target?.developmentOnly) {
    priority += 2;
  }
  if (!target?.platformSpecific) {
    priority += 1;
  }
  return priority;
}

function mergeTargetScope(existingTarget, nextTarget) {
  const mergedRequired = Boolean(
    existingTarget.required || nextTarget.required,
  );
  const existingScope = normalizeComponentScope(existingTarget.scope);
  const nextScope = normalizeComponentScope(nextTarget.scope);
  if (mergedRequired) {
    return existingScope === "required" || nextScope === "required"
      ? "required"
      : existingScope || nextScope;
  }
  return existingScope === "optional" || nextScope === "optional"
    ? "optional"
    : existingScope || nextScope;
}

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
 * @param {number | object | undefined} [options] selector options
 * @returns {{ targets: object[], skipped: object[] }} extracted targets and skipped components
 */
export function extractPurlTargetsFromBom(bomJson, sourceName, options) {
  const selectorOptions = normalizeTargetSelectionOptions(options);
  const targets = [];
  const skipped = [];
  const components = Array.isArray(bomJson?.components)
    ? bomJson.components
    : [];
  const rootDependencyRefs = extractRootDependencyRefs(bomJson);
  for (const component of components) {
    const componentScope = normalizeComponentScope(component?.scope);
    if (
      selectorOptions.scope === "required" &&
      !isRequiredComponentScope(componentScope)
    ) {
      continue;
    }
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
      properties: Array.isArray(component?.properties)
        ? component.properties.map((property) => ({ ...property }))
        : [],
      qualifiers: purlObj.qualifiers,
      directDependency:
        Boolean(component?.["bom-ref"]) &&
        rootDependencyRefs.has(component["bom-ref"]),
      developmentOnly: isDevelopmentOnlyComponent(component, purlObj.type),
      platformSpecific: isPlatformSpecificComponent(component, purlObj.type),
      required: isRequiredComponentScope(componentScope),
      scope: componentScope,
      source: sourceName,
      trustedPublishing: hasTrustedPublishingProperties(component?.properties),
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
 * @param {number | object | undefined} [options] selector options or a legacy maxTargets value
 * @returns {{
 *   skipped: object[],
 *   stats: {
 *     availableTargets: number,
 *     nonRequiredTargets: number,
 *     requiredTargets: number,
 *     trustedTargets: number,
 *     trustedTargetsExcluded: number,
 *     truncatedTargets: number,
 *   },
 *   targets: object[],
 * }} merged targets and skipped components
 */
export function collectAuditTargets(inputBoms, options) {
  const selectorOptions = normalizeTargetSelectionOptions(options);
  const skipped = [];
  const targetMap = new Map();
  for (const inputBom of inputBoms) {
    const extracted = extractPurlTargetsFromBom(
      inputBom.bomJson,
      inputBom.source,
      selectorOptions,
    );
    skipped.push(...extracted.skipped);
    for (const target of extracted.targets) {
      const existing = targetMap.get(target.purl);
      if (existing) {
        existing.directDependency = Boolean(
          existing.directDependency || target.directDependency,
        );
        // A package stays dev-only or platform-specific only when every observed
        // occurrence carries that constraint. Any runtime/general occurrence
        // should lift the deprioritization signal for triage ordering.
        existing.developmentOnly = Boolean(
          existing.developmentOnly && target.developmentOnly,
        );
        existing.platformSpecific = Boolean(
          existing.platformSpecific && target.platformSpecific,
        );
        existing.required = Boolean(existing.required || target.required);
        existing.scope = mergeTargetScope(existing, target);
        existing.trustedPublishing = Boolean(
          existing.trustedPublishing || target.trustedPublishing,
        );
        existing.sources.add(target.source);
        if (target.bomRef) {
          existing.bomRefs.add(target.bomRef);
        }
        for (const property of target.properties || []) {
          const alreadyPresent = existing.properties.some(
            (existingProperty) =>
              existingProperty.name === property.name &&
              existingProperty.value === property.value,
          );
          if (!alreadyPresent) {
            existing.properties.push(property);
          }
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
  targets.sort((left, right) => {
    if (selectorOptions.prioritizeDirectRuntime) {
      const scoreDelta = triagePriorityScore(right) - triagePriorityScore(left);
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
    }
    return left.purl.localeCompare(right.purl);
  });
  const trustedTargets = targets.filter((target) => target.trustedPublishing);
  if (selectorOptions.trusted === "only") {
    targets = trustedTargets;
  } else if (selectorOptions.trusted === "exclude") {
    targets = targets.filter((target) => !target.trustedPublishing);
  }
  const requiredTargets = targets.filter((target) => target.required);
  const nonRequiredTargets = targets.filter((target) => !target.required);
  const directRuntimeTargets = targets.filter(
    (target) =>
      target.directDependency &&
      target.required &&
      !target.developmentOnly &&
      !target.platformSpecific,
  );
  const developmentOnlyTargets = targets.filter(
    (target) => target.developmentOnly,
  );
  const platformSpecificTargets = targets.filter(
    (target) => target.platformSpecific,
  );
  const availableTargets = targets.length;
  if (
    typeof selectorOptions.maxTargets === "number" &&
    selectorOptions.maxTargets > 0
  ) {
    targets = [...requiredTargets, ...nonRequiredTargets].slice(
      0,
      selectorOptions.maxTargets,
    );
  }
  return {
    skipped,
    stats: {
      availableTargets,
      directRuntimeTargets: directRuntimeTargets.length,
      developmentOnlyTargets: developmentOnlyTargets.length,
      nonRequiredTargets: nonRequiredTargets.length,
      platformSpecificTargets: platformSpecificTargets.length,
      requiredTargets: requiredTargets.length,
      trustedTargets: trustedTargets.length,
      trustedTargetsExcluded:
        selectorOptions.trusted === "exclude" ? trustedTargets.length : 0,
      truncatedTargets: Math.max(0, availableTargets - targets.length),
    },
    targets,
  };
}

export { SUPPORTED_PURL_TYPES };
