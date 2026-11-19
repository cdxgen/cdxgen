import { relative, resolve } from "node:path";

import { occurrenceLocationKey } from "../inventory/occurrenceKey.js";

/**
 * Characters of occurrence text that one `findPurlLocations` call may record
 * across all components. Each occurrence counts its location plus the JSON
 * framing around it.
 */
const MAX_LOCATION_CHARS = 8 * 1024 * 1024;
const OCCURRENCE_FRAMING_CHARS = 16;

function buildNSCache(components) {
  const typePurlsCache = Object.create(null);
  for (const comp of components) {
    if (!comp.purl || !comp.properties) {
      continue;
    }
    const nsProps = comp.properties.filter(
      (p) => p.name === "internal:Namespaces",
    );
    if (nsProps.length) {
      const nsList = nsProps[0].value?.split("\n") || [];
      for (const ns of nsList) {
        const sns = ns.split("$")[0];
        if (!typePurlsCache[sns]) {
          typePurlsCache[sns] = new Set();
        }
        typePurlsCache[sns].add(comp.purl);
      }
    }
  }
  return typePurlsCache;
}

/**
 * Map Scala semantic-slice used types back to purls and their source locations.
 *
 * Builds a type-to-purl cache from the component `internal:Namespaces`
 * properties, then for each `.scala` entry in the semantic slice records the
 * source file locations where each used type's purl appears.
 *
 * The location of an entry is its key, as the path below the project
 * directory: that is what `analyzeScalaProject` checked to be a file of the
 * project. The entry's own `sourceFile` is free text and is not read. The
 * total size of the recorded locations is bounded; entries that would exceed
 * the bound are skipped and a warning says so.
 *
 * @param {Object[]} components CycloneDX components carrying namespace properties
 * @param {Object} semanticsSlice Parsed Scala semantic slice object keyed by source file
 * @param {string} [projectDir] Project directory the slice keys are relative to; the working directory when omitted
 * @returns {{ purlLocationMap: Object<string, string[]> }} Map of purl to sorted source location arrays
 */
export function findPurlLocations(
  components,
  semanticsSlice,
  projectDir = ".",
) {
  const purlLocationsSet = {};
  if (!semanticsSlice || !Object.keys(semanticsSlice).length) {
    return {};
  }
  const typePurlsCache = buildNSCache(components);
  let budget = MAX_LOCATION_CHARS;
  let skipped = 0;
  for (const key of Object.keys(semanticsSlice)) {
    if (key === "config" || !key.endsWith(".scala")) {
      continue;
    }
    const usedTypes = semanticsSlice[key]?.usedTypes;
    if (!Array.isArray(usedTypes) || !usedTypes.length) {
      continue;
    }
    const location = occurrenceLocationKey(
      relative(projectDir, resolve(projectDir, key)),
    );
    if (!location) {
      continue;
    }
    const cost = location.length + OCCURRENCE_FRAMING_CHARS;
    const simpleTypes = new Set();
    for (const t of usedTypes) {
      if (typeof t === "string") {
        simpleTypes.add(t.split("$")[0]);
      }
    }
    for (const simpleType of simpleTypes) {
      const matchPurls = Object.hasOwn(typePurlsCache, simpleType)
        ? typePurlsCache[simpleType]
        : undefined;
      if (!matchPurls) {
        continue;
      }
      for (const apurl of matchPurls) {
        if (purlLocationsSet[apurl]?.has(location)) {
          continue;
        }
        if (cost > budget) {
          skipped++;
          continue;
        }
        if (!purlLocationsSet[apurl]) {
          purlLocationsSet[apurl] = new Set();
        }
        purlLocationsSet[apurl].add(location);
        budget -= cost;
      }
    }
  }
  if (skipped) {
    console.warn(
      `scalasem: left out ${skipped} source locations of the semantics slice because they exceed the ${MAX_LOCATION_CHARS} character limit.`,
    );
  }
  const purlLocationMap = {};
  for (const apurl of Object.keys(purlLocationsSet)) {
    purlLocationMap[apurl] = Array.from(purlLocationsSet[apurl]).sort();
  }
  return { purlLocationMap };
}
