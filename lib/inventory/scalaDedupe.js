import { basename } from "node:path";

import { mergeDependencies, trimComponents } from "./depsUtils.js";
import { mavenPurl } from "./purl.js";
import {
  parseScalaArtifact,
  publishedArtifactId,
  scalaCoordinateOfPurl,
} from "./scalaCoords.js";

const COMPILER_VERSION_PROPERTY = "cdx:scala:compilerVersion";

function compilerVersionsOf(component) {
  return (component.properties || [])
    .filter((property) => property.name === COMPILER_VERSION_PROPERTY)
    .map((property) => property.value)
    .filter(Boolean);
}

// The jar names a component was read from, without the extension.
function jarStems(component) {
  return (component.properties || [])
    .filter((property) => property.name === "internal:SrcFile")
    .map((property) => basename(String(property.value || "")))
    .filter((name) => name.endsWith(".jar"))
    .map((name) => name.slice(0, -".jar".length));
}

// sbt-native-packager and Coursier copy a dependency into a staging directory
// as `<group>.<artifact>-<version>.jar`. The group cannot be told from the
// artifact in such a name alone, but a component a build tool reported names
// both, so the stem is compared with theirs.
function stagedStem(anchor) {
  return `${anchor.group}.${publishedArtifactId(anchor)}`;
}

function isJarSourced(component) {
  return jarStems(component).length > 0;
}

// A classifier or a type other than jar names a different artifact of the same
// coordinates, which is not a duplicate.
function isPlainJar(component) {
  const purl = component?.purl || "";
  return (
    !purl.includes("classifier=") &&
    (!purl.includes("type=") || purl.includes("type=jar"))
  );
}

// Lower is better. A component a build tool reported outranks one a jar scan
// guessed from a file name; among equals the plain name, then the shorter
// purl, then the lexicographically first wins, so the choice never depends on
// the order of the BOM.
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

function rewriteReferences(dependencies, refMap) {
  if (!refMap.size) {
    return dependencies;
  }
  const rewritten = (dependencies || []).map((dependency) => ({
    ...dependency,
    ref: refMap.get(dependency.ref) || dependency.ref,
    ...(dependency.dependsOn
      ? {
          dependsOn: dependency.dependsOn.map((ref) => refMap.get(ref) || ref),
        }
      : {}),
  }));
  return mergeDependencies([], rewritten);
}

/**
 * Collapse the components that stand for one Scala library.
 *
 * A build tool such as sbt reports a library as `group:name@version` with the
 * Scala binary suffix moved into `cdx:scala:compilerVersion`. The jars a scan
 * finds on disk name the same library again, and not in the same way: with the
 * suffix (`cats-core_3`), without a repository, or only as the staged file name
 * `<group>.<artifact>-<version>.jar`, which a filename-based guess splits at the
 * wrong dot (`pkg:maven/cpg2-protos/io.appthreat.cpg2-protos_3`). Each of those
 * is merged into the component the build tool reported. A staged jar of another
 * version of a reported library, such as a stale build, keeps its own component
 * but is renamed to the coordinates the reported library has.
 *
 * Components that no reported library accounts for are left as they are.
 *
 * @param {Object[]} components BOM components
 * @param {Object[]} dependencies BOM dependencies
 * @returns {{components: Object[], dependencies: Object[]}} The collapsed
 *   components, and the dependencies with references to merged components
 *   pointed at the component that remains
 */
export function mergeScalaDuplicateComponents(components, dependencies) {
  const candidates = (components || []).filter(
    (component) =>
      component?.purl?.startsWith("pkg:maven/") &&
      isPlainJar(component) &&
      component.group &&
      component.version,
  );
  if (candidates.length < 2) {
    return { components, dependencies };
  }
  const byKey = new Map();
  const byGroupVersion = new Map();
  const reportedByStem = new Map();
  for (const component of candidates) {
    const key = scalaCoordinateOfPurl(component.purl)?.key;
    if (key && isPlainJar(component)) {
      byKey.set(key, [...(byKey.get(key) || []), component]);
    }
    const groupVersion = `${component.group}@${component.version}`;
    byGroupVersion.set(groupVersion, [
      ...(byGroupVersion.get(groupVersion) || []),
      component,
    ]);
    if (!isJarSourced(component)) {
      const stem = stagedStem(component);
      reportedByStem.set(stem, [
        ...(reportedByStem.get(stem) || []),
        component,
      ]);
    }
  }
  // Which component each one is a duplicate of.
  const duplicateOf = new Map();
  const repoints = [];
  for (const component of candidates) {
    const coordinate = scalaCoordinateOfPurl(component.purl);
    const matches = new Set();
    // The same coordinates, spelled with or without the Scala suffix, with or
    // without a repository.
    if (isPlainJar(component)) {
      for (const other of byKey.get(coordinate?.key) || []) {
        if (
          !coordinate?.binaryVersion ||
          !compilerVersionsOf(other).length ||
          compilerVersionsOf(other).includes(coordinate.binaryVersion)
        ) {
          matches.add(other);
        }
      }
    }
    // A name the staging copy prefixed with the group.
    for (const other of byGroupVersion.get(
      `${component.group}@${component.version}`,
    ) || []) {
      if (
        other !== component &&
        [
          `${other.group}.${other.name}`,
          `${other.group}.${publishedArtifactId(other)}`,
        ].includes(component.name)
      ) {
        matches.add(other);
      }
    }
    // The staged file name of a reported library, whatever group the guess
    // made of it.
    for (const stem of jarStems(component)) {
      const versionSuffix = `-${component.version}`;
      if (stem.endsWith(versionSuffix)) {
        const owners = reportedByStem.get(stem.slice(0, -versionSuffix.length));
        if (owners?.length === 1 && owners[0] !== component) {
          if (owners[0].version === component.version) {
            matches.add(owners[0]);
          } else {
            repoints.push([component, owners[0]]);
          }
        }
      }
    }
    let best;
    for (const other of matches) {
      if (other !== component && isBetter(other, component)) {
        if (!best || isBetter(other, best)) {
          best = other;
        }
      }
    }
    if (best) {
      duplicateOf.set(component, best);
    }
  }
  const root = (component) => {
    let current = component;
    while (duplicateOf.has(current)) {
      current = duplicateOf.get(current);
    }
    return current;
  };
  const refMap = new Map();
  const survivors = new Set(components);
  for (const [component] of duplicateOf) {
    const target = root(component);
    const duplicate = { ...component };
    refMap.set(component["bom-ref"] || component.purl, target["bom-ref"]);
    duplicate.purl = target.purl;
    duplicate["bom-ref"] = target["bom-ref"];
    trimComponents([target, duplicate]);
    survivors.delete(component);
  }
  for (const [component, owner] of repoints) {
    if (survivors.has(component)) {
      repointToAnchor(component, root(owner), refMap);
    }
  }
  // Repointed components can now spell the same coordinates twice.
  return {
    components: trimComponents([...survivors]),
    dependencies: rewriteReferences(dependencies, refMap),
  };
}

// Give a staged jar of another version the group and artifact the reported
// library has, so it is the same library at an older or newer version and not a
// differently named one.
function repointToAnchor(component, anchor, refMap) {
  const scalaInfo = parseScalaArtifact(anchor.name);
  const purl = mavenPurl(anchor.group, scalaInfo.purlName, component.version, {
    type: "jar",
  });
  if (!purl) {
    return;
  }
  const previousRef = component["bom-ref"];
  component.group = anchor.group;
  component.name = anchor.name;
  component.purl = purl;
  component["bom-ref"] = decodeURIComponent(purl);
  if (!compilerVersionsOf(component).length) {
    component.properties = [
      ...(component.properties || []),
      ...(anchor.properties || []).filter(
        (property) => property.name === COMPILER_VERSION_PROPERTY,
      ),
    ];
  }
  if (previousRef && previousRef !== component["bom-ref"]) {
    refMap.set(previousRef, component["bom-ref"]);
  }
}
