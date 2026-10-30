import { basename } from "node:path";

import { Purl } from "@cdxgen/cdx-purl";

import { mergeDependencies, trimComponents } from "./depsUtils.js";
import { mavenPurl } from "./purl.js";
import { publishedArtifactId, scalaCoordinateOfPurl } from "./scalaCoords.js";

const COMPILER_VERSION_PROPERTY = "cdx:scala:compilerVersion";

// A jar scan that read the coordinates from the jar's own pom.properties
// records them with this confidence; a guess from the file name or the
// manifest records less.
const DESCRIPTOR_CONFIDENCE = 0.5;

function compilerVersionsOf(component) {
  return (component.properties || [])
    .filter((property) => property.name === COMPILER_VERSION_PROPERTY)
    .map((property) => property.value)
    .filter(Boolean);
}

function parsedPurl(component) {
  try {
    return Purl.parse(component?.purl || "");
  } catch (_err) {
    return undefined;
  }
}

// The jar names a component was read from, without the extension.
function jarStems(component) {
  return (component.properties || [])
    .filter((property) => property.name === "internal:SrcFile")
    .map((property) => basename(String(property.value || "")))
    .filter((name) => name.toLowerCase().endsWith(".jar"))
    .map((name) => name.slice(0, -".jar".length));
}

function isJarSourced(component) {
  return jarStems(component).length > 0;
}

// Whether a jar scan guessed the coordinates rather than reading them from the
// jar's Maven descriptor. A jar with a descriptor names its own artifact, even
// when that artifact is spelled `<group>.<name>` like a staged copy.
function hasGuessedIdentity(component) {
  const identities = [component.evidence?.identity || []].flat();
  return !identities.some(
    (identity) =>
      (identity?.confidence ?? 0) >= DESCRIPTOR_CONFIDENCE ||
      (identity?.methods || []).some(
        (method) => (method?.confidence ?? 0) >= DESCRIPTOR_CONFIDENCE,
      ),
  );
}

// A classifier or a type other than jar names a different artifact of the same
// coordinates, which is not a duplicate.
function isPlainJar(component) {
  const purl = parsedPurl(component);
  if (!purl) {
    return false;
  }
  const qualifiers = purl.qualifiers || {};
  return (
    !qualifiers.classifier && (!qualifiers.type || qualifiers.type === "jar")
  );
}

// The Scala binary versions a component was built for: the suffix its name
// keeps, or the compiler versions a build tool recorded. Empty for a library
// that is not a Scala artifact.
function binaryVersionsOf(component) {
  const suffixVersion = scalaCoordinateOfPurl(component.purl)?.binaryVersion;
  return new Set(
    suffixVersion ? [suffixVersion] : compilerVersionsOf(component),
  );
}

// Two spellings name one artifact only when they were built for the same Scala
// binary version, or both for none. `kafka_2.12` and `kafka_2.13` share the
// normalized coordinates but are different artifacts.
function sameBinaryVersion(a, b) {
  const left = binaryVersionsOf(a);
  const right = binaryVersionsOf(b);
  if (!left.size || !right.size) {
    return !left.size && !right.size;
  }
  return [...left].some((version) => right.has(version));
}

// Lower is better. A component a build tool reported outranks one a jar scan
// named; then the name without a `<group>.` prefix, then the purl that names
// its repository, then the shorter purl, then the lexicographically first, so
// the choice never depends on the order of the BOM.
function rank(component) {
  return [
    isJarSourced(component) ? 1 : 0,
    component.name?.startsWith(`${component.group}.`) ? 1 : 0,
    component.purl.includes("repository_url=") ? 0 : 1,
    component.purl.length,
    component.purl,
  ];
}

function isBetter(candidate, component) {
  const a = rank(candidate);
  const b = rank(component);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return a[i] < b[i];
    }
  }
  return false;
}

function best(components) {
  let chosen;
  for (const component of components) {
    if (!chosen || isBetter(component, chosen)) {
      chosen = component;
    }
  }
  return chosen;
}

function refOf(component) {
  return component["bom-ref"] || component.purl;
}

// The file names sbt-native-packager gives a staged copy of a library,
// without the version: `<group>.<artifact>` with the artifact as published,
// once for each Scala binary version it was built for, and once as named,
// since a module of the build itself is staged without the suffix when it
// turns cross paths off.
function stagedStems(component) {
  return [
    ...new Set([
      `${component.group}.${component.name}`,
      ...compilerVersionsOf(component).map(
        (version) =>
          `${component.group}.${publishedArtifactId({
            name: component.name,
            properties: [{ name: COMPILER_VERSION_PROPERTY, value: version }],
          })}`,
      ),
    ]),
  ];
}

// The listed libraries a staged file name can be a copy of, with the version
// the name carries: every split of the name at a hyphen whose left side is the
// staged stem of a library.
function stagedOwners(stem, ownersByStem) {
  const found = [];
  for (
    let index = stem.indexOf("-");
    index > 0;
    index = stem.indexOf("-", index + 1)
  ) {
    const owners = ownersByStem.get(stem.slice(0, index));
    if (owners) {
      found.push({ owners, version: stem.slice(index + 1) });
    }
  }
  return found;
}

function rewriteReferences(dependencies, refMap) {
  if (!refMap.size) {
    return dependencies;
  }
  const rewritten = (dependencies || []).map((dependency) => {
    const ref = refMap.get(dependency.ref) || dependency.ref;
    return {
      ...dependency,
      ref,
      ...(dependency.dependsOn
        ? {
            dependsOn: [
              ...new Set(
                dependency.dependsOn.map(
                  (dependsOn) => refMap.get(dependsOn) || dependsOn,
                ),
              ),
            ].filter((dependsOn) => dependsOn !== ref),
          }
        : {}),
    };
  });
  return mergeDependencies([], rewritten);
}

/**
 * Collapse the components that stand for one Scala library.
 *
 * A build tool such as sbt reports a library as `group:name@version` with the
 * Scala binary suffix moved into `cdx:scala:compilerVersion`. The jars a scan
 * finds on disk name the same library again, and not in the same way: with the
 * suffix (`cats-core_3`), without a repository, or, for a jar without a Maven
 * descriptor, only as the staged file name `<group>.<artifact>-<version>.jar`,
 * which a filename-based guess splits at the wrong dot
 * (`pkg:maven/cpg2-protos/io.appthreat.cpg2-protos_3`). Each of those is merged
 * into the component the build tool reported. A staged jar of another version
 * of a reported library, such as a stale build, keeps its own component but is
 * renamed to the coordinates the reported library has.
 *
 * Spellings of the same coordinates merge only when they were built for the
 * same Scala binary version, so the `_2.12` and `_2.13` artifacts of one
 * library stay two components. Components that no reported library accounts
 * for are left as they are.
 *
 * @param {Object[]} components BOM components
 * @param {Object[]} dependencies BOM dependencies
 * @returns {{components: Object[], dependencies: Object[], purlMap: Map<string, string>}}
 *   The collapsed components, the dependencies with references to merged
 *   components pointed at the component that remains, and the purl each
 *   merged or renamed component now has, keyed by the purl it had
 */
export function mergeScalaDuplicateComponents(components, dependencies) {
  const purlMap = new Map();
  const candidates = (components || []).filter(
    (component) =>
      component?.purl?.startsWith("pkg:maven/") &&
      isPlainJar(component) &&
      component.group &&
      component.version,
  );
  if (candidates.length < 2) {
    return { components, dependencies, purlMap };
  }
  const byKey = new Map();
  const ownersByStem = new Map();
  for (const component of candidates) {
    const key = scalaCoordinateOfPurl(component.purl)?.key;
    if (key) {
      byKey.set(key, [...(byKey.get(key) || []), component]);
    }
    for (const stem of stagedStems(component)) {
      ownersByStem.set(stem, [...(ownersByStem.get(stem) || []), component]);
    }
  }
  // Which component each one is a duplicate of.
  const duplicateOf = new Map();
  const repoints = new Map();
  for (const component of candidates) {
    const matches = new Set();
    // The same coordinates, spelled with or without the Scala suffix, with or
    // without a repository.
    for (const other of byKey.get(scalaCoordinateOfPurl(component.purl)?.key) ||
      []) {
      if (other !== component && sameBinaryVersion(component, other)) {
        matches.add(other);
      }
    }
    // The staged file name of another listed library, whatever group and name
    // the guess made of it. A jar that names itself in its Maven descriptor is
    // the artifact it says it is.
    if (isJarSourced(component) && hasGuessedIdentity(component)) {
      for (const stem of jarStems(component)) {
        for (const { owners, version } of stagedOwners(stem, ownersByStem)) {
          const sameVersion = owners.filter(
            (owner) => owner !== component && owner.version === version,
          );
          if (sameVersion.length) {
            for (const owner of sameVersion) {
              matches.add(owner);
            }
            continue;
          }
          // Another version of a library a build tool reported, when the guess
          // agrees on it. A version that extends a known one
          // (`4.1.100.Final-linux-x86_64`) can as well be that version with a
          // classifier, so it is left alone.
          const reportedOwners = owners.filter(
            (owner) => owner !== component && !isJarSourced(owner),
          );
          const extendsKnown = owners.some((owner) =>
            version.startsWith(`${owner.version}-`),
          );
          if (
            reportedOwners.length &&
            version === component.version &&
            /^\d/.test(version) &&
            !extendsKnown
          ) {
            const owner = best(reportedOwners);
            const known = repoints.get(component);
            if (!known || isBetter(owner, known)) {
              repoints.set(component, owner);
            }
          }
        }
      }
    }
    const target = best(
      [...matches].filter((other) => isBetter(other, component)),
    );
    if (target) {
      duplicateOf.set(component, target);
    }
  }
  // A chain of merges never carries a component past one built for another
  // Scala binary version.
  const root = (component) => {
    let current = component;
    while (duplicateOf.has(current)) {
      const next = duplicateOf.get(current);
      if (current !== component && !sameBinaryVersion(component, next)) {
        break;
      }
      current = next;
    }
    return current;
  };
  const refMap = new Map();
  const survivors = new Set(components);
  for (const [component] of duplicateOf) {
    const target = root(component);
    const duplicate = { ...component };
    const targetRef = refOf(target);
    if (refOf(component) && targetRef && refOf(component) !== targetRef) {
      refMap.set(refOf(component), targetRef);
    }
    if (component.purl !== target.purl) {
      purlMap.set(component.purl, target.purl);
    }
    duplicate.purl = target.purl;
    duplicate["bom-ref"] = target["bom-ref"];
    trimComponents([target, duplicate]);
    survivors.delete(component);
  }
  for (const [component, owner] of repoints) {
    if (survivors.has(component)) {
      repointToAnchor(component, root(owner), refMap, purlMap);
    }
  }
  // A component merged into one that was renamed afterwards follows it.
  resolveChains(refMap);
  resolveChains(purlMap);
  // Repointed components can now spell the same coordinates twice.
  return {
    components: trimComponents([...survivors]),
    dependencies: rewriteReferences(dependencies, refMap),
    purlMap,
  };
}

function resolveChains(map) {
  for (const [key, value] of map) {
    let current = value;
    const seen = new Set([key]);
    while (map.has(current) && !seen.has(current)) {
      seen.add(current);
      current = map.get(current);
    }
    map.set(key, current);
  }
}

// Give a staged jar of another version the group, name and purl shape the
// reported library has, so it is the same library at an older or newer version
// and not a differently named one.
function repointToAnchor(component, anchor, refMap, purlMap) {
  const anchorPurl = parsedPurl(anchor);
  if (!anchorPurl) {
    return;
  }
  // The repository the reported version came from says nothing about where
  // this one came from.
  const { repository_url: _repository, ...qualifiers } =
    anchorPurl.qualifiers || {};
  const purl = mavenPurl(
    anchor.group,
    anchorPurl.name,
    component.version,
    qualifiers,
  );
  if (!purl) {
    return;
  }
  const previousRef = refOf(component);
  purlMap.set(component.purl, purl);
  component.group = anchor.group;
  component.name = anchor.name;
  component.purl = purl;
  component["bom-ref"] = decodeURIComponent(purl);
  const known = new Set(compilerVersionsOf(component));
  component.properties = [
    ...(component.properties || []),
    ...(anchor.properties || []).filter(
      (property) =>
        property.name === COMPILER_VERSION_PROPERTY &&
        !known.has(property.value),
    ),
  ];
  if (previousRef && previousRef !== component["bom-ref"]) {
    refMap.set(previousRef, component["bom-ref"]);
  }
}

/**
 * Key the jar namespace map by the purls the components have after
 * {@link mergeScalaDuplicateComponents}, so a merged or renamed jar still
 * finds its namespaces. A purl that already has an entry keeps it, with the
 * namespaces of the merged entry added.
 *
 * @param {Object} mapping Jar namespace map keyed by purl
 * @param {Map<string, string>} purlMap New purl keyed by old purl
 * @returns {Object} The re-keyed map
 */
export function rekeyNamespaceMapping(mapping, purlMap) {
  if (!mapping || !purlMap?.size) {
    return mapping;
  }
  const rekeyed = { ...mapping };
  for (const [oldPurl, newPurl] of purlMap) {
    const entry = rekeyed[oldPurl];
    if (!entry || oldPurl === newPurl) {
      continue;
    }
    delete rekeyed[oldPurl];
    const existing = rekeyed[newPurl];
    if (!existing) {
      rekeyed[newPurl] = entry;
      continue;
    }
    rekeyed[newPurl] = {
      ...existing,
      namespaces: [
        ...new Set([
          ...(existing.namespaces || []),
          ...(entry.namespaces || []),
        ]),
      ],
    };
  }
  return rekeyed;
}
