import { PackageURL } from "packageurl-js";

import { hasTrustedPublishingProperties } from "../helpers/provenanceUtils.js";
import {
  getCratesMetadata,
  getNpmMetadata,
  getPyMetadata,
} from "../helpers/utils.js";

const SUPPORTED_PURL_TYPES = new Set(["cargo", "npm", "pypi"]);
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
      prioritizeDirectRuntime: true,
      scope: undefined,
      trusted: "exclude",
    };
  }
  return {
    maxTargets: options?.maxTargets,
    prioritizeDirectRuntime: options?.prioritizeDirectRuntime ?? true,
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

function getComponentPropertyValues(component, propertyName) {
  return (component?.properties || [])
    .filter((property) => property?.name === propertyName)
    .map((property) => property?.value)
    .filter((propertyValue) => typeof propertyValue === "string")
    .map((propertyValue) => propertyValue.trim())
    .filter(Boolean);
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
  if (type === "cargo") {
    return ["cdx:cargo:target"].some((propertyName) =>
      hasNonEmptyComponentProperty(component, propertyName),
    );
  }
  return false;
}

function isDevelopmentOnlyComponent(component, type) {
  if (type === "npm") {
    return hasTruthyComponentProperty(component, "cdx:npm:package:development");
  }
  if (type === "cargo") {
    const dependencyKinds = getComponentPropertyValues(
      component,
      "cdx:cargo:dependencyKind",
    ).map((value) => value.toLowerCase());
    return dependencyKinds.length
      ? dependencyKinds.every((value) => value === "dev")
      : false;
  }
  return false;
}

function isBuildOnlyWorkspaceCargoComponent(component) {
  const dependencyKinds = getComponentPropertyValues(
    component,
    "cdx:cargo:dependencyKind",
  ).map((value) => value.toLowerCase());
  return (
    dependencyKinds.length > 0 &&
    dependencyKinds.every((value) => value === "build") &&
    hasTruthyComponentProperty(
      component,
      "cdx:cargo:workspaceDependencyResolved",
    )
  );
}

function isRuntimeFacingCargoComponent(component, directDependency) {
  const dependencyKinds = getComponentPropertyValues(
    component,
    "cdx:cargo:dependencyKind",
  ).map((value) => value.toLowerCase());
  if (dependencyKinds.includes("runtime")) {
    return true;
  }
  return Boolean(
    directDependency &&
      !isDevelopmentOnlyComponent(component, "cargo") &&
      !isBuildOnlyWorkspaceCargoComponent(component),
  );
}

function getComponentOccurrenceCount(component) {
  return Array.isArray(component?.evidence?.occurrences)
    ? component.evidence.occurrences.length
    : 0;
}

function triagePriorityScore(target) {
  // Triage should start with the most user-actionable packages:
  // direct runtime dependencies first, then other required deps, then
  // deprioritize dev-only and platform-constrained packages.
  let priority = 0;
  if (target?.directDependency) {
    priority += 16;
  }
  if (target?.explicitRequiredScope) {
    priority += 8;
  }
  if (target?.required) {
    priority += 4;
  }
  if (target?.type === "cargo" && target?.runtimeFacingCargo) {
    priority += 6;
  }
  priority += Math.min(target?.occurrenceCount || 0, 6);
  if (!target?.developmentOnly) {
    priority += 2;
  }
  if (!target?.platformSpecific) {
    priority += 1;
  }
  if (target?.type === "cargo" && target?.buildOnlyWorkspace) {
    priority -= 5;
  }
  return priority;
}

function registryMetadataPropertyName(propertyName) {
  return (
    propertyName?.startsWith("cdx:cargo:") ||
    propertyName?.startsWith("cdx:npm:trustedPublishing") ||
    propertyName?.startsWith("cdx:npm:provenance") ||
    propertyName?.startsWith("cdx:pypi:trustedPublishing") ||
    propertyName?.startsWith("cdx:pypi:provenance") ||
    propertyName === "cdx:pypi:uploaderVerified"
  );
}

function appendUniqueProperties(targetProperties, extraProperties) {
  const existing = new Set(
    (targetProperties || []).map((property) =>
      [property.name, property.value].join("="),
    ),
  );
  for (const property of extraProperties || []) {
    if (!property?.name) {
      continue;
    }
    const key = [property.name, property.value].join("=");
    if (existing.has(key)) {
      continue;
    }
    targetProperties.push(property);
    existing.add(key);
  }
}

function auditRegistryMetadataKey(type, namespace, name, version) {
  return [type, namespace || "", name || "", version || ""].join("|");
}

function buildRegistryMetadataCandidate(componentPurl, component) {
  let purlObj;
  try {
    purlObj = PackageURL.fromString(componentPurl);
  } catch {
    return undefined;
  }
  if (!SUPPORTED_PURL_TYPES.has(purlObj.type) || !purlObj.version) {
    return undefined;
  }
  const auditMetadataKey = auditRegistryMetadataKey(
    purlObj.type,
    purlObj.namespace,
    purlObj.name,
    purlObj.version,
  );
  return {
    _auditMetadataKey: auditMetadataKey,
    group: purlObj.namespace,
    name: purlObj.name,
    properties: Array.isArray(component?.properties)
      ? component.properties.map((property) => ({ ...property }))
      : [],
    type: purlObj.type,
    version: purlObj.version,
  };
}

function restoreFetchPackageMetadata(originalFetchPackageMetadata) {
  if (originalFetchPackageMetadata === undefined) {
    delete process.env.CDXGEN_FETCH_PKG_METADATA;
    return;
  }
  process.env.CDXGEN_FETCH_PKG_METADATA = originalFetchPackageMetadata;
}

/**
 * Enrich input BOM components with registry provenance/trusted-publishing
 * metadata so audit target filtering can exclude trusted packages even when the
 * input BOM was generated without --bom-audit.
 *
 * @param {{ source: string, bomJson: object }[]} inputBoms loaded input BOMs
 * @returns {Promise<void>}
 */
export async function enrichInputBomsWithRegistryMetadata(inputBoms) {
  const cargoCandidates = [];
  const npmCandidates = [];
  const pypiCandidates = [];
  const componentRefs = new Map();
  for (const inputBom of inputBoms || []) {
    const components = Array.isArray(inputBom?.bomJson?.components)
      ? inputBom.bomJson.components
      : [];
    for (const component of components) {
      const componentPurl = component?.purl;
      if (
        !componentPurl ||
        hasTrustedPublishingProperties(component?.properties || [])
      ) {
        continue;
      }
      const candidate = buildRegistryMetadataCandidate(
        componentPurl,
        component,
      );
      if (!candidate) {
        continue;
      }
      if (!componentRefs.has(candidate._auditMetadataKey)) {
        componentRefs.set(candidate._auditMetadataKey, []);
        if (candidate.type === "cargo") {
          cargoCandidates.push(candidate);
        } else if (candidate.type === "npm") {
          npmCandidates.push(candidate);
        } else if (candidate.type === "pypi") {
          pypiCandidates.push(candidate);
        }
      }
      componentRefs.get(candidate._auditMetadataKey).push(component);
    }
  }
  if (
    !cargoCandidates.length &&
    !npmCandidates.length &&
    !pypiCandidates.length
  ) {
    return;
  }
  const originalFetchPackageMetadata = process.env.CDXGEN_FETCH_PKG_METADATA;
  process.env.CDXGEN_FETCH_PKG_METADATA = "true";
  try {
    const enrichedCandidates = [
      ...(cargoCandidates.length
        ? await getCratesMetadata(cargoCandidates)
        : []),
      ...(npmCandidates.length ? await getNpmMetadata(npmCandidates) : []),
      ...(pypiCandidates.length
        ? await getPyMetadata(pypiCandidates, false)
        : []),
    ];
    for (const candidate of enrichedCandidates) {
      const matchedComponents =
        componentRefs.get(candidate._auditMetadataKey) || [];
      const registryProperties = (candidate.properties || []).filter(
        (property) => registryMetadataPropertyName(property?.name),
      );
      if (!registryProperties.length) {
        continue;
      }
      for (const component of matchedComponents) {
        component.properties = Array.isArray(component.properties)
          ? component.properties
          : [];
        appendUniqueProperties(component.properties, registryProperties);
      }
    }
  } finally {
    restoreFetchPackageMetadata(originalFetchPackageMetadata);
  }
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
      buildOnlyWorkspace:
        purlObj.type === "cargo"
          ? isBuildOnlyWorkspaceCargoComponent(component)
          : false,
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
      explicitRequiredScope: componentScope === "required",
      developmentOnly: isDevelopmentOnlyComponent(component, purlObj.type),
      occurrenceCount: getComponentOccurrenceCount(component),
      platformSpecific: isPlatformSpecificComponent(component, purlObj.type),
      required: isRequiredComponentScope(componentScope),
      runtimeFacingCargo:
        purlObj.type === "cargo"
          ? isRuntimeFacingCargoComponent(
              component,
              Boolean(component?.["bom-ref"]) &&
                rootDependencyRefs.has(component["bom-ref"]),
            )
          : false,
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
        existing.explicitRequiredScope = Boolean(
          existing.explicitRequiredScope || target.explicitRequiredScope,
        );
        // A package stays dev-only or platform-specific only when every observed
        // occurrence carries that constraint. Any runtime/general occurrence
        // should lift the deprioritization signal for triage ordering.
        existing.developmentOnly = Boolean(
          existing.developmentOnly && target.developmentOnly,
        );
        existing.occurrenceCount =
          (existing.occurrenceCount || 0) + (target.occurrenceCount || 0);
        existing.platformSpecific = Boolean(
          existing.platformSpecific && target.platformSpecific,
        );
        existing.buildOnlyWorkspace = Boolean(
          existing.buildOnlyWorkspace && target.buildOnlyWorkspace,
        );
        existing.required = Boolean(existing.required || target.required);
        existing.runtimeFacingCargo = Boolean(
          existing.runtimeFacingCargo || target.runtimeFacingCargo,
        );
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
  const buildOnlyWorkspaceTargets = targets.filter(
    (target) => target.type === "cargo" && target.buildOnlyWorkspace,
  );
  const cargoRuntimeFacingTargets = targets.filter(
    (target) => target.type === "cargo" && target.runtimeFacingCargo,
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
      buildOnlyWorkspaceTargets: buildOnlyWorkspaceTargets.length,
      cargoRuntimeFacingTargets: cargoRuntimeFacingTargets.length,
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
