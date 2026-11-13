import { DEBUG_MODE } from "../core/activity.js";

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
  "cdx:npm:package:type-only",
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

function isTypeOnlyExcludedComponent(component) {
  if (component?.scope !== "excluded") {
    return false;
  }
  return (
    isNpmTypesOnlyComponent(component) ||
    (component.properties || []).some(
      (property) =>
        property.name === "cdx:npm:package:type-only" &&
        property.value === "true",
    )
  );
}

/**
 * Scopes the dependencies of type-only npm packages as optional.
 *
 * A package imported only for its TypeScript types, like an `@types` package,
 * is erased at compile time, and so is what it depends on unless a runtime
 * package depends on it too. A component below a type-only package becomes
 * optional when no dependency path from a root of the graph reaches it without
 * passing through a type-only package. A component that already has a scope,
 * from its manifest or from usage evidence, keeps it.
 *
 * @param {Object[]} components CycloneDX component objects
 * @param {Object[]} dependencies CycloneDX dependency entries
 * @returns {Object[]} The same component array with scopes updated in place
 */
export function markTypeOnlyDependenciesOptional(
  components = [],
  dependencies = [],
) {
  if (!components?.length || !dependencies?.length) {
    return components;
  }
  const componentByRef = new Map();
  const typeOnlyRefs = new Set();
  for (const component of components) {
    for (const ref of [component?.["bom-ref"], component?.purl]) {
      if (!ref) {
        continue;
      }
      const normalizedRef = normalizeBomRef(ref);
      componentByRef.set(normalizedRef, component);
      if (isTypeOnlyExcludedComponent(component)) {
        typeOnlyRefs.add(normalizedRef);
      }
    }
  }
  if (!typeOnlyRefs.size) {
    return components;
  }
  const childrenByRef = new Map();
  const dependentRefs = new Set();
  for (const dependency of dependencies) {
    const ref = normalizeBomRef(dependency?.ref);
    if (!ref) {
      continue;
    }
    if (!childrenByRef.has(ref)) {
      childrenByRef.set(ref, new Set());
    }
    for (const dependsOnRef of dependency.dependsOn || []) {
      const childRef = normalizeBomRef(dependsOnRef);
      if (childRef && childRef !== ref) {
        childrenByRef.get(ref).add(childRef);
        dependentRefs.add(childRef);
      }
    }
  }
  const walk = (startRefs) => {
    const seen = new Set();
    const stack = [...startRefs];
    while (stack.length) {
      const ref = stack.pop();
      if (seen.has(ref)) {
        continue;
      }
      seen.add(ref);
      for (const childRef of childrenByRef.get(ref) || []) {
        if (!typeOnlyRefs.has(childRef)) {
          stack.push(childRef);
        }
      }
    }
    return seen;
  };
  // Every ref nothing depends on is a root, so a partial graph errs towards
  // keeping a component rather than scoping it optional.
  const runtimeRefs = walk(
    [...childrenByRef.keys()].filter(
      (ref) => !dependentRefs.has(ref) && !typeOnlyRefs.has(ref),
    ),
  );
  for (const ref of walk(typeOnlyRefs)) {
    if (typeOnlyRefs.has(ref) || runtimeRefs.has(ref)) {
      continue;
    }
    const component = componentByRef.get(ref);
    if (component && !component.scope) {
      component.scope = "optional";
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

/**
 * Union two services[].data[] lists, keyed by flow + classification + name so that repeated
 * classifications of the same payload do not accumulate duplicates.
 *
 * @param {Array} existingData Data entries already on the service
 * @param {Array} newData Data entries being merged in
 * @returns {Array} Merged data entries
 */
function mergeServiceData(existingData = [], newData = []) {
  const seen = new Map();
  for (const entry of [...existingData, ...newData]) {
    if (!entry?.flow || !entry?.classification) {
      continue;
    }
    const key = `${entry.flow}|${entry.classification}|${entry.name || ""}`;
    if (!seen.has(key)) {
      seen.set(key, entry);
    }
  }
  return Array.from(seen.values());
}

const uniqueListIndexes = new WeakMap();

/**
 * Append an entry to a list unless an entry with the same key is already in
 * it. The keys of each list are kept in an index, so the check costs the same
 * however long the list grows, where scanning the list per append would be
 * quadratic. The list must only be changed by appending: a list whose length
 * differs from the last call, because other code appended to it, is indexed
 * again.
 *
 * @param {Object[]} list List to append to, changed in place
 * @param {(entry: Object) => string} keyOf Key of an entry
 * @param {Object} entry Entry to append
 * @returns {boolean} true when the entry was appended
 */
export function appendUnique(list, keyOf, entry) {
  let index = uniqueListIndexes.get(list);
  if (index?.keyOf !== keyOf || index.length !== list.length) {
    index = { keyOf, keys: new Set(list.map(keyOf)), length: list.length };
    uniqueListIndexes.set(list, index);
  }
  const key = keyOf(entry);
  if (index.keys.has(key)) {
    return false;
  }
  index.keys.add(key);
  index.length = list.push(entry);
  return true;
}

const namedValueKey = (property) =>
  JSON.stringify([property?.name, property?.value]);

/**
 * Append a `{ name, value }` property unless the same name and value pair is
 * already in the list. Empty values are not appended. The check goes through
 * `appendUnique()`, so it does not scan the list on every call.
 *
 * @param {Object[]} properties Property list, changed in place
 * @param {string} name Property name
 * @param {*} value Property value, converted to a string
 * @returns {void}
 */
export function appendUniqueProperty(properties, name, value) {
  if (value === undefined || value === null || value === "") {
    return;
  }
  appendUnique(properties, namedValueKey, { name, value: String(value) });
}

function servicePropertyKey(prop) {
  return JSON.stringify([prop?.name, prop?.value]);
}

function mergeServiceProperties(existingProps = [], newProps = []) {
  const merged = [...existingProps];
  // A Set of the name/value pairs already present keeps the merge linear in
  // the property count, which a scanned image or project controls.
  const seen = new Set(merged.map(servicePropertyKey));
  for (const newProp of newProps) {
    const key = servicePropertyKey(newProp);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(newProp);
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

function evidenceOccurrenceKey(occurrence) {
  const location = occurrence?.location || {};
  return `${location.path || ""}#${location.line ?? ""}#${location.column ?? ""}`;
}

/**
 * Union two service evidence objects by their occurrences so a collision keeps
 * every call site instead of whichever side arrived first.
 *
 * @param {Object} [existingEvidence] Evidence already on the service
 * @param {Object} [newEvidence] Evidence being merged in
 * @returns {Object} Evidence covering both inputs
 */
function mergeServiceEvidence(existingEvidence, newEvidence) {
  if (!existingEvidence) {
    return newEvidence;
  }
  const occurrences = [...(existingEvidence.occurrences || [])];
  const seen = new Set(occurrences.map(evidenceOccurrenceKey));
  for (const occurrence of newEvidence?.occurrences || []) {
    const key = evidenceOccurrenceKey(occurrence);
    if (!seen.has(key)) {
      seen.add(key);
      occurrences.push(occurrence);
    }
  }
  if (!occurrences.length) {
    return existingEvidence;
  }
  return { ...existingEvidence, occurrences };
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
    // Carry the richer fields through a collision too. Without these, a dosai service that collided
    // with one derived from endpoints lost precisely what schema 4.0.0 adds: its bom-ref, its data
    // classifications, and its evidence.
    existing["bom-ref"] = existing["bom-ref"] || service["bom-ref"];
    if (Array.isArray(service.data) && service.data.length) {
      existing.data = mergeServiceData(existing.data || [], service.data);
    }
    if (service.evidence) {
      existing.evidence = mergeServiceEvidence(
        existing.evidence,
        service.evidence,
      );
    }
    if (Array.isArray(service.tags) && service.tags.length) {
      existing.tags = Array.from(
        new Set([...(existing.tags || []), ...service.tags]),
      );
    }
    if (Array.isArray(service.services) && service.services.length) {
      existing.services = mergeServices(
        existing.services || [],
        service.services,
      );
    }
  }
  return Array.from(serviceMap.values());
}

// Descriptive fields, each listed with the raw spellings that collectors set
// before component conversion. Conversion prefers the converted `licenses`
// over a raw `license`, and a raw `author` over `authors`, so a field is only
// filled in, under the spelling the duplicate uses, when the retained
// component has no spelling of it.
const DESCRIPTIVE_FIELDS = [
  ["description"],
  ["publisher"],
  ["copyright"],
  ["authors", "author"],
  ["licenses", "license"],
];

const hasFieldValue = (value) =>
  value !== undefined &&
  value !== null &&
  value !== "" &&
  !(Array.isArray(value) && !value.length);

/**
 * Carry the descriptive metadata of a duplicate sighting over to the retained
 * component. A lockfile is usually parsed first and knows only the identity,
 * while a manifest seen later, such as a gemspec, knows the description,
 * authors, licenses, and project links (discussion 4389).
 *
 * The retained sighting keeps its own values. Lists are not unioned because
 * two sightings spell the same fact differently: one license as an SPDX id and
 * as a name, or as an expression that must never share the `licenses` array
 * with license objects. External references are unioned, since each one is a
 * distinct link.
 *
 * @param {object} existingComponent Retained component, updated in place
 * @param {object} comp Duplicate sighting of the same component
 */
function mergeDescriptiveFields(existingComponent, comp) {
  for (const spellings of DESCRIPTIVE_FIELDS) {
    if (
      spellings.some((spelling) => hasFieldValue(existingComponent[spelling]))
    ) {
      continue;
    }
    const spelling = spellings.find((aspelling) =>
      hasFieldValue(comp[aspelling]),
    );
    if (spelling) {
      existingComponent[spelling] = comp[spelling];
    }
  }
  if (!comp.externalReferences?.length) {
    return;
  }
  // A copy, as the array may be shared with another sighting
  const existingRefs = [...(existingComponent.externalReferences || [])];
  for (const newref of comp.externalReferences) {
    if (
      !existingRefs.some(
        (ref) => ref.type === newref.type && ref.url === newref.url,
      )
    ) {
      existingRefs.push(newref);
    }
  }
  existingComponent.externalReferences = existingRefs;
}

/**
 * Trim duplicate components by retaining all the properties
 *
 * @param {Array} components Components
 *
 * @returns {Array} Filtered components
 */
export function trimComponents(components) {
  // The keys come from the scanned manifests. In a plain object, a key such as
  // `__proto__` would resolve to Object.prototype and the merge below would
  // write to it.
  const keyCache = new Map();
  for (const comp of components) {
    const key = (
      comp.purl ||
      comp["bom-ref"] ||
      comp.name + comp.version
    ).toLowerCase();
    if (!keyCache.has(key)) {
      keyCache.set(key, comp);
    } else {
      const existingComponent = keyCache.get(key);
      mergeDescriptiveFields(existingComponent, comp);
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
  return Array.from(keyCache.values());
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

/**
 * Method to check if a given dependency tree is partial or not.
 *
 * @param {Array} dependencies List of dependencies
 * @param {Number} componentsCount Number of components
 * @returns {Boolean} True if the dependency tree lacks any non-root parents without children. False otherwise.
 */
export function isPartialTree(dependencies, componentsCount = 1) {
  if (componentsCount <= 1) {
    return false;
  }
  if (dependencies?.length <= 1) {
    return true;
  }
  let isCbom = false;
  let parentsWithChildsCount = 0;
  for (const adep of dependencies) {
    // Producers such as protobuf omit empty dependsOn lists
    if (adep?.dependsOn?.length > 0) {
      parentsWithChildsCount++;
    }
    if (!isCbom && adep?.provides?.length > 0) {
      isCbom = true;
    }
  }
  return (
    !isCbom &&
    parentsWithChildsCount <
      Math.min(Math.round(componentsCount / 3), componentsCount)
  );
}

/**
 * Re-compute and set the scope based on the dependency tree
 *
 * @param {Array} pkgList List of components
 * @param {Array} dependencies List of dependencies
 *
 * @returns {Array} Updated list
 */
export function recomputeScope(pkgList, dependencies) {
  const requiredPkgs = {};
  if (!pkgList || !dependencies) {
    return pkgList;
  }
  for (const pkg of pkgList) {
    if (!pkg.scope || !pkg["bom-ref"]) {
      continue;
    }
    if (pkg.scope === "required") {
      requiredPkgs[pkg["bom-ref"]] = true;
    }
  }
  for (const adep of dependencies) {
    if (requiredPkgs[adep.ref]) {
      for (const ado of adep.dependsOn || []) {
        requiredPkgs[ado] = true;
      }
    }
  }
  // Prevent marking every component as optional
  if (!Object.keys(requiredPkgs).length) {
    return pkgList;
  }
  for (const pkg of pkgList) {
    if (requiredPkgs[pkg["bom-ref"]]) {
      pkg.scope = "required";
    } else if (!pkg.scope) {
      pkg.scope = "optional";
    }
  }
  return pkgList;
}
