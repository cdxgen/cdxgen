import { DEBUG_MODE } from "./utils.js";

/**
 * Merges two CycloneDX dependency arrays into a single deduplicated list.
 * For each unique ref, the dependsOn and provides sets from both arrays are
 * combined. Self-referential entries pointing to the parent component are
 * removed from all dependsOn and provides lists.
 *
 * @param {Object[]} dependencies First array of dependency objects
 * @param {Object[]} newDependencies Second array of dependency objects to merge
 * @param {Object} parentComponent Parent component whose bom-ref is used to filter self-references
 * @returns {Object[]} Merged and deduplicated array of dependency objects
 */
export function mergeDependencies(
  dependencies,
  newDependencies,
  parentComponent = {},
) {
  if (!parentComponent && DEBUG_MODE) {
    console.log(
      "Unable to determine parent component. Dependencies will be flattened.",
    );
  }
  let providesFound = false;
  const deps_map = {};
  const provides_map = {};
  const parentRef = parentComponent?.["bom-ref"]
    ? parentComponent["bom-ref"]
    : undefined;
  const combinedDeps = dependencies.concat(newDependencies || []);
  for (const adep of combinedDeps) {
    if (!deps_map[adep.ref]) {
      deps_map[adep.ref] = new Set();
    }
    if (!provides_map[adep.ref]) {
      provides_map[adep.ref] = new Set();
    }
    if (adep["dependsOn"]) {
      for (const eachDepends of adep["dependsOn"]) {
        if (!eachDepends) {
          continue;
        }
        if (parentRef) {
          if (eachDepends.toLowerCase() !== parentRef.toLowerCase()) {
            deps_map[adep.ref].add(eachDepends);
          }
        } else {
          deps_map[adep.ref].add(eachDepends);
        }
      }
    }
    if (adep["provides"]) {
      providesFound = true;
      for (const eachProvides of adep["provides"]) {
        // Add the entry unless it is the parent itself:
        // when there is no parentRef every entry is kept (!parentRef is true),
        // when parentRef exists only entries that differ from it are kept.
        if (
          !parentRef ||
          eachProvides?.toLowerCase() !== parentRef?.toLowerCase()
        ) {
          provides_map[adep.ref].add(eachProvides);
        }
      }
    }
  }
  const retlist = [];
  for (const akey of Object.keys(deps_map)) {
    if (providesFound) {
      retlist.push({
        ref: akey,
        dependsOn: Array.from(deps_map[akey]).sort(),
        provides: Array.from(provides_map[akey]).sort(),
      });
    } else {
      retlist.push({
        ref: akey,
        dependsOn: Array.from(deps_map[akey]).sort(),
      });
    }
  }
  return retlist;
}

const NPM_NON_RUNTIME_SCOPE_PROPERTIES = new Set([
  "cdx:npm:package:development",
  "cdx:npm:package:optional",
  "cdx:npm:package:peer",
]);

function hasNonRuntimeNpmScope(component) {
  return (component?.properties || []).some(
    (property) =>
      NPM_NON_RUNTIME_SCOPE_PROPERTIES.has(property.name) &&
      property.value === "true",
  );
}

function normalizeBomRef(ref) {
  const refString = String(ref || "");
  try {
    return decodeURIComponent(refString).toLowerCase();
  } catch {
    return refString.toLowerCase();
  }
}

function isNpmTypesOnlyComponent(component) {
  if (!component) {
    return false;
  }
  if (component.group === "@types") {
    return true;
  }
  const purlOrRef = component.purl || component["bom-ref"];
  if (typeof purlOrRef !== "string") {
    return false;
  }
  const normalized = normalizeBomRef(purlOrRef);
  return (
    normalized.startsWith("pkg:npm/%40types/") ||
    normalized.startsWith("pkg:npm/@types/")
  );
}

/**
 * Marks npm @types packages as excluded from runtime scope.
 *
 * @param {Object[]} components CycloneDX component objects
 * @returns {Object[]} The same component array with scopes updated in place
 */
export function markNpmTypesPackagesAsExcluded(components = []) {
  if (!components?.length) {
    return components;
  }
  for (const component of components) {
    if (isNpmTypesOnlyComponent(component)) {
      component.scope = "excluded";
    }
  }
  return components;
}

/**
 * Propagates required scope through a dependency graph.
 *
 * If component A has `scope: "required"` and dependency metadata says A depends
 * on B, B is also runtime-relevant. Keep packages optional when lockfile/parser
 * metadata explicitly identifies them as development, optional, or peer-only.
 *
 * @param {Object[]} components CycloneDX component objects
 * @param {Object[]} dependencies CycloneDX dependency entries
 * @returns {Object[]} The same component array with scopes updated in place
 */
export function propagateRequiredScopeFromDependencies(
  components = [],
  dependencies = [],
) {
  if (!components?.length || !dependencies?.length) {
    return components;
  }
  const componentByRef = new Map();
  for (const component of components) {
    for (const ref of [component?.["bom-ref"], component?.purl]) {
      if (ref) {
        componentByRef.set(normalizeBomRef(ref), component);
      }
    }
  }
  if (!componentByRef.size) {
    return components;
  }
  const dependencyMap = new Map();
  for (const dependency of dependencies || []) {
    const ref = normalizeBomRef(dependency?.ref);
    if (!ref) {
      continue;
    }
    const dependsOn = (dependency.dependsOn || [])
      .map((depRef) => normalizeBomRef(depRef))
      .filter(Boolean);
    dependencyMap.set(
      ref,
      Array.from(new Set([...(dependencyMap.get(ref) || []), ...dependsOn])),
    );
  }
  const requiredStack = [];
  const visited = new Set();
  for (const component of components) {
    if (component?.scope === "required") {
      const ref = normalizeBomRef(component["bom-ref"] || component.purl);
      if (ref) {
        requiredStack.push(ref);
      }
    }
  }
  while (requiredStack.length) {
    const requiredRef = requiredStack.pop();
    if (visited.has(requiredRef)) {
      continue;
    }
    visited.add(requiredRef);
    for (const childRef of dependencyMap.get(requiredRef) || []) {
      const childComponent = componentByRef.get(childRef);
      if (!childComponent || hasNonRuntimeNpmScope(childComponent)) {
        continue;
      }
      if (childComponent.scope !== "required") {
        childComponent.scope = "required";
      }
      requiredStack.push(childRef);
    }
  }
  return components;
}

function serviceIdentityKey(service) {
  if (service?.["bom-ref"]) {
    return service["bom-ref"].toLowerCase();
  }
  return `${service?.group || ""}:${service?.name || ""}:${service?.version || ""}`.toLowerCase();
}

function mergeServiceProperties(existingProps = [], newProps = []) {
  const merged = [...existingProps];
  for (const newProp of newProps) {
    if (
      !merged.find(
        (prop) =>
          prop?.name === newProp?.name && prop?.value === newProp?.value,
      )
    ) {
      merged.push(newProp);
    }
  }
  return merged;
}

function normalizeServiceEndpoints(endpoints) {
  if (Array.isArray(endpoints)) {
    return endpoints.filter(
      (endpoint) => typeof endpoint === "string" && endpoint,
    );
  }
  if (typeof endpoints === "string" && endpoints) {
    return [endpoints];
  }
  return [];
}

/**
 * Merge CycloneDX services using bom-ref or group/name/version identity.
 *
 * @param {Object[]|Object} services Existing service list
 * @param {Object[]|Object} newServices New service list
 * @returns {Object[]} Merged and deduplicated services
 */
export function mergeServices(services, newServices) {
  const combined = []
    .concat(services || [])
    .concat(newServices || [])
    .filter(Boolean);
  const serviceMap = new Map();
  for (const service of combined) {
    const key = serviceIdentityKey(service);
    if (!serviceMap.has(key)) {
      serviceMap.set(key, {
        ...service,
        endpoints: Array.from(
          new Set(normalizeServiceEndpoints(service.endpoints)),
        ),
        properties: mergeServiceProperties([], service.properties || []),
        services: Array.isArray(service.services)
          ? mergeServices([], service.services)
          : undefined,
      });
      continue;
    }
    const existing = serviceMap.get(key);
    existing.description = existing.description || service.description;
    existing.group = existing.group || service.group;
    existing.name = existing.name || service.name;
    existing.version = existing.version || service.version;
    existing.provider = existing.provider || service.provider;
    existing.trustZone = existing.trustZone || service.trustZone;
    if (service.authenticated === true) {
      existing.authenticated = true;
    } else if (
      typeof existing.authenticated === "undefined" &&
      typeof service.authenticated !== "undefined"
    ) {
      existing.authenticated = service.authenticated;
    }
    if (service["x-trust-boundary"] === true) {
      existing["x-trust-boundary"] = true;
    } else if (
      typeof existing["x-trust-boundary"] === "undefined" &&
      typeof service["x-trust-boundary"] !== "undefined"
    ) {
      existing["x-trust-boundary"] = service["x-trust-boundary"];
    }
    const incomingEndpoints = normalizeServiceEndpoints(service.endpoints);
    if (incomingEndpoints.length) {
      existing.endpoints = Array.from(
        new Set([
          ...normalizeServiceEndpoints(existing.endpoints),
          ...incomingEndpoints,
        ]),
      );
    }
    existing.properties = mergeServiceProperties(
      existing.properties || [],
      service.properties || [],
    );
    if (Array.isArray(service.services) && service.services.length) {
      existing.services = mergeServices(
        existing.services || [],
        service.services,
      );
    }
  }
  return Array.from(serviceMap.values());
}

/**
 * Trim duplicate components by retaining all the properties
 *
 * @param {Array} components Components
 *
 * @returns {Array} Filtered components
 */
export function trimComponents(components) {
  const keyCache = {};
  const filteredComponents = [];
  for (const comp of components) {
    const key = (
      comp.purl ||
      comp["bom-ref"] ||
      comp.name + comp.version
    ).toLowerCase();
    if (!keyCache[key]) {
      keyCache[key] = comp;
    } else {
      const existingComponent = keyCache[key];
      // We need to retain any properties that differ
      if (comp.properties) {
        if (existingComponent.properties) {
          for (const newprop of comp.properties) {
            if (
              !existingComponent.properties.find(
                (prop) =>
                  prop.name === newprop.name && prop.value === newprop.value,
              )
            ) {
              existingComponent.properties.push(newprop);
            }
          }
        } else {
          existingComponent.properties = comp.properties;
        }
      }
      if (comp.hashes) {
        if (existingComponent.hashes) {
          for (const newhash of comp.hashes) {
            if (
              !existingComponent.hashes.find(
                (hash) =>
                  hash.alg === newhash.alg && hash.content === newhash.content,
              )
            ) {
              existingComponent.hashes.push(newhash);
            }
          }
        } else {
          existingComponent.hashes = comp.hashes;
        }
      }
      // Retain all component.evidence.identity
      if (comp?.evidence?.identity) {
        if (!existingComponent.evidence) {
          existingComponent.evidence = { identity: [] };
        } else if (!existingComponent?.evidence?.identity) {
          existingComponent.evidence.identity = [];
        } else if (
          existingComponent?.evidence?.identity &&
          !Array.isArray(existingComponent.evidence.identity)
        ) {
          existingComponent.evidence.identity = [
            existingComponent.evidence.identity,
          ];
        }
        // comp.evidence.identity can be an array or object
        // Merge the evidence.identity based on methods or objects
        const isIdentityArray = Array.isArray(comp.evidence.identity);
        const identities = isIdentityArray
          ? comp.evidence.identity
          : [comp.evidence.identity];
        for (const aident of identities) {
          let methodBasedMerge = false;
          if (aident?.methods?.length) {
            for (const amethod of aident.methods) {
              for (const existIdent of existingComponent.evidence.identity) {
                if (existIdent.field === aident.field) {
                  if (!existIdent.methods) {
                    existIdent.methods = [];
                  }
                  if (aident.tools?.length) {
                    existIdent.tools = Array.from(
                      new Set([...(existIdent.tools || []), ...aident.tools]),
                    );
                  }
                  let isDup = false;
                  for (const emethod of existIdent.methods) {
                    if (emethod?.value === amethod?.value) {
                      isDup = true;
                      break;
                    }
                  }
                  if (!isDup) {
                    existIdent.methods.push(amethod);
                  }
                  methodBasedMerge = true;
                }
              }
            }
          }
          if (!methodBasedMerge && aident.field && aident.confidence) {
            existingComponent.evidence.identity.push(aident);
          }
        }
        if (!isIdentityArray) {
          const firstIdentity = existingComponent.evidence.identity[0];
          let identConfidence = firstIdentity?.confidence;
          // We need to set the confidence to the max of all confidences
          if (firstIdentity?.methods?.length > 1) {
            for (const aidentMethod of firstIdentity.methods) {
              if (
                aidentMethod?.confidence &&
                aidentMethod.confidence > identConfidence
              ) {
                identConfidence = aidentMethod.confidence;
              }
            }
          }
          firstIdentity.confidence = identConfidence;
          existingComponent.evidence = {
            identity: firstIdentity,
          };
        }
      }
      // If the component is required in any of the child projects, then make it required
      if (
        existingComponent?.scope !== "required" &&
        comp?.scope === "required"
      ) {
        existingComponent.scope = "required";
      }
    }
  }
  for (const akey of Object.keys(keyCache)) {
    filteredComponents.push(keyCache[akey]);
  }
  return filteredComponents;
}

/**
 * Filter out invalid cryptographic-asset components from a component list.
 * Removes algorithm components without a valid cryptoProperties.oid and
 * certificate components without cryptoProperties.algorithmProperties.
 *
 * @param {Object[] | undefined | null} components Array of CycloneDX components
 * @returns {Object[]} Filtered array with invalid crypto components removed
 */
export function filterInvalidCryptoComponents(components) {
  if (!components?.length) {
    return [];
  }
  return components.filter((comp) => {
    if (comp.type !== "cryptographic-asset") {
      return true;
    }
    if (!comp.cryptoProperties) {
      if (DEBUG_MODE) {
        console.log(
          `Removing cryptographic-asset '${comp.name}' without cryptoProperties`,
        );
      }
      return false;
    }
    if (
      comp.cryptoProperties.assetType === "algorithm" &&
      !comp.cryptoProperties.oid
    ) {
      if (DEBUG_MODE) {
        console.log(
          `Removing cryptographic-asset algorithm '${comp.name}' without OID`,
        );
      }
      return false;
    }
    if (
      comp.cryptoProperties.assetType === "certificate" &&
      !comp.cryptoProperties.algorithmProperties
    ) {
      if (DEBUG_MODE) {
        console.log(
          `Removing cryptographic-asset certificate '${comp.name}' without algorithmProperties`,
        );
      }
      return false;
    }
    return true;
  });
}
