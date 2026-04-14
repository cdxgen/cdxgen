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
        if (parentRef && eachDepends) {
          if (eachDepends?.toLowerCase() !== parentRef?.toLowerCase()) {
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
