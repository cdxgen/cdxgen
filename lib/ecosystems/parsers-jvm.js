import { readdirSync, readFileSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

import { build } from "@cdxgen/cdx-purl";
import { parseEDNString } from "edn-data";

import { DEBUG_MODE, readEnvironmentVariable } from "../core/activity.js";
import { recordDegradation } from "../core/buildLedger.js";
import { includeMavenTestScope } from "../core/env.js";
import { safeExistsSync } from "../core/fs.js";
import { thoughtLog } from "../core/logger.js";
import { applyPurl } from "../inventory/purl.js";
import { parseScalaArtifact } from "../inventory/scalaCoords.js";
import { xml2js } from "../parsers/xml.js";

/** Bound on the `${...}` references one pom value may expand through. */
const POM_PROPERTY_EXPANSION_LIMIT = 10;

/**
 * Longest coordinate value taken from a pom, the CycloneDX limit for a
 * version. A property or a managed version is stated once and copied into
 * every dependency that refers to it, so its length is bounded here rather
 * than by the size of the pom. The reference count alone does not bound an
 * expansion either: every reference can stand for a property of any length.
 */
const POM_VALUE_MAX_LENGTH = 1024;

/**
 * Expand the `${name}` references in a pom value. The value is returned only
 * when every reference resolves and the result fits POM_VALUE_MAX_LENGTH, so
 * a version is never half expanded and never longer than a BOM accepts.
 *
 * @param {string} value Raw pom value
 * @param {Function} lookup Returns the value of a property name, or undefined
 * @returns {string|undefined} Expanded value, or undefined
 */
function expandPomValue(value, lookup) {
  let expanded = value;
  for (
    let i = 0;
    i < POM_PROPERTY_EXPANSION_LIMIT && expanded?.includes("${");
    i++
  ) {
    const start = expanded.indexOf("${");
    const end = expanded.indexOf("}", start + 2);
    if (end < 0) {
      return undefined;
    }
    const replacement = lookup(expanded.slice(start + 2, end));
    // Checked before concatenating, so an oversized value is never built
    if (
      typeof replacement !== "string" ||
      expanded.length - (end + 1 - start) + replacement.length >
        POM_VALUE_MAX_LENGTH
    ) {
      return undefined;
    }
    expanded = `${expanded.slice(0, start)}${replacement}${expanded.slice(end + 1)}`;
  }
  return expanded?.includes("${") || expanded?.length > POM_VALUE_MAX_LENGTH
    ? undefined
    : expanded;
}

/**
 * Parse pom file
 *
 * Versions resolve from the pom's own properties and dependencyManagement.
 * A caller that has read the pom's parents passes what they define in
 * `inherited`, so versions the parents manage resolve too. Imported BOMs and
 * parents outside the scanned directory are not read.
 *
 * @param {string} pomFile pom file to parse
 * @param {Object} [inherited] Properties and managed versions from parent poms
 * @param {Object} [inherited.properties] Property name to raw value
 * @param {Object} [inherited.managedVersions] `groupId:artifactId` to version
 * @returns {Object} Object containing pom properties, modules, the parent
 *   reference, the user properties and managed versions this pom defines, and
 *   array of dependencies
 */
export function parsePom(pomFile, inherited = {}) {
  const deps = [];
  let modules;
  let pomPurl;
  const properties = {};
  const userProperties = {};
  const managedVersions = {};
  let isQuarkus = false;
  const xmlData = readFileSync(pomFile, "utf-8");
  const project = xml2js(xmlData, {
    compact: true,
    spaces: 4,
    textKey: "_",
    attributesKey: "$",
    commentKey: "value",
  }).project;
  if (project?.modelVersion?._) {
    properties.modelVersion = project.modelVersion._;
  }
  if (project?.$?.root) {
    properties.mavenRoot = project.$.root;
  }
  if (project?.$?.["preserve.model.version"]) {
    properties.preserveModelVersion = project.$["preserve.model.version"];
  }
  for (const aprop of [
    "groupId",
    "artifactId",
    "version",
    "name",
    "description",
    "url",
    "packaging",
  ]) {
    if (project?.[aprop]?._) {
      properties[aprop] = project[aprop]._;
    }
  }
  // Take the version from the parent if available
  if (!properties.version && project?.parent?.version?._) {
    properties.version = project.parent.version._;
  }
  // Take the groupId from the parent if available
  if (!properties.groupId && project?.parent?.groupId?._) {
    properties.groupId = project.parent.groupId._;
  }
  let parent;
  if (project?.parent) {
    parent = {
      groupId: project.parent.groupId?._,
      artifactId: project.parent.artifactId?._,
      version: project.parent.version?._,
      // An empty <relativePath/> tells Maven not to look for the parent on
      // disk; a missing one means ../pom.xml.
      relativePath:
        project.parent.relativePath === undefined
          ? "../pom.xml"
          : project.parent.relativePath?._ || "",
    };
  }
  if (project?.scm?.url?._) {
    properties.scm = project.scm.url._;
  }
  const moduleEntries = [];
  if (project?.modules?.module) {
    moduleEntries.push(project.modules.module);
  }
  if (project?.subprojects?.subproject) {
    moduleEntries.push(project.subprojects.subproject);
  }
  if (moduleEntries.length) {
    modules = moduleEntries.flatMap((entry) => {
      if (Array.isArray(entry)) {
        return entry.map((m) => m?._).filter(Boolean);
      }
      return entry?._ ? [entry._] : [];
    });
  }
  if (project?.properties) {
    for (const aprop of Object.keys(project.properties)) {
      properties[aprop] = project.properties[aprop]?._;
      userProperties[aprop] = project.properties[aprop]?._;
      if (!isQuarkus && aprop.startsWith("quarkus.platform")) {
        isQuarkus = true;
      }
    }
  }
  const inheritedProperties = inherited?.properties || {};
  const lookupProperty = (name) => {
    switch (name) {
      case "project.version":
      case "pom.version":
      case "version":
        return properties.version;
      case "project.groupId":
      case "pom.groupId":
      case "groupId":
        return properties.groupId;
      case "project.artifactId":
      case "pom.artifactId":
      case "artifactId":
        return properties.artifactId;
      case "project.parent.version":
        return parent?.version;
      case "project.parent.groupId":
        return parent?.groupId;
      default:
        return Object.hasOwn(userProperties, name)
          ? userProperties[name]
          : inheritedProperties[name];
    }
  };
  // A property can refer to another, so each lookup expands its value too.
  const expand = (value) =>
    expandPomValue(value, (name) => {
      const raw = lookupProperty(name);
      return raw?.includes("${")
        ? expandPomValue(raw, (inner) =>
            inner === name ? undefined : lookupProperty(inner),
          )
        : raw;
    });
  let managedEntries = project?.dependencyManagement?.dependencies?.dependency;
  if (managedEntries && !Array.isArray(managedEntries)) {
    managedEntries = [managedEntries];
  }
  for (const amanaged of managedEntries || []) {
    // An imported BOM manages versions this pom cannot see without fetching it
    if (amanaged?.scope?._ === "import" || !amanaged?.version?._) {
      continue;
    }
    const group = expand(amanaged.groupId?._);
    const name = expand(amanaged.artifactId?._);
    const version = expand(amanaged.version._);
    if (group && name && version) {
      managedVersions[`${group}:${name}`] = version;
    }
  }
  const inheritedManagedVersions = inherited?.managedVersions || {};
  // CI friendly versions such as ${revision} resolve from the properties
  for (const coordinate of ["groupId", "version"]) {
    if (properties[coordinate]?.includes("${")) {
      properties[coordinate] =
        expand(properties[coordinate]) || properties[coordinate];
    }
  }
  if (properties.groupId || properties.artifactId) {
    pomPurl = build({
      type: "maven",
      namespace: properties.groupId || "" || null,
      name: properties.artifactId,
      version: properties.version || null,
      qualifiers: { type: properties.packaging || "jar" } || null,
    });
  }
  // Check the plugins for quarkus
  if (!isQuarkus && project?.build?.plugins?.plugin) {
    if (Array.isArray(project.build.plugins.plugin)) {
      for (const aplugin of project.build.plugins.plugin) {
        if (aplugin?.groupId?._?.includes("quarkus.platform")) {
          isQuarkus = true;
          break;
        }
      }
    } else if (
      Object.keys(project.build.plugins.plugin).length &&
      project.build.plugins.plugin?.groupId?._
    ) {
      if (project.build.plugins.plugin.groupId._.includes("quarkus.platform")) {
        isQuarkus = true;
      }
    }
  }
  if (project?.dependencies) {
    let dependencies = project.dependencies.dependency;
    // Convert to an array
    if (!dependencies) {
      dependencies = [];
    } else if (dependencies && !Array.isArray(dependencies)) {
      dependencies = [dependencies];
    }
    for (const adep of dependencies) {
      const version = adep.version;
      let versionStr;
      if (version?._) {
        versionStr = version._;
      }
      if (versionStr?.includes("$")) {
        versionStr = expand(versionStr);
      }
      let groupStr = adep.groupId ? adep.groupId._ : "";
      if (groupStr?.includes("${")) {
        groupStr = expand(groupStr) || groupStr;
      }
      const nameStr = adep.artifactId ? adep.artifactId._ : "";
      if (!versionStr && !version?._) {
        const managedKey = `${groupStr}:${nameStr}`;
        versionStr = Object.hasOwn(managedVersions, managedKey)
          ? managedVersions[managedKey]
          : inheritedManagedVersions[managedKey];
      }
      const scope = adep.scope?._;
      const type = adep.type?._ || "jar";
      const classifier = adep.classifier?._;
      const optional = adep.optional?._;
      const dependencyProperties = [
        {
          name: "internal:SrcFile",
          value: pomFile,
        },
      ];
      const qualifiers = { type };
      if (classifier) {
        qualifiers.classifier = classifier;
      }
      if (includeMavenTestScope || scope !== "test") {
        deps.push({
          group: groupStr,
          name: nameStr,
          version: versionStr,
          qualifiers,
          scope: mapMavenScope(scope, optional === "true"),
          properties: dependencyProperties,
          evidence: {
            identity: {
              field: "purl",
              confidence: 1,
              methods: [
                {
                  technique: "manifest-analysis",
                  confidence: !versionStr ? 0 : 0.6,
                  value: pomFile,
                },
              ],
            },
          },
        });
      }
    }
  }
  return {
    isQuarkus,
    pomPurl,
    modules,
    parent,
    properties,
    userProperties,
    managedVersions,
    dependencies: deps,
  };
}

/** Bound on the chain of parent poms read from disk. */
const LOCAL_PARENT_DEPTH_LIMIT = 10;

/**
 * The pom file a `<parent>` reference points at on disk, when it lies inside
 * the scanned directory and declares the coordinates the reference names.
 *
 * @param {string} pomFile Child pom file
 * @param {Object} parentRef Parent reference from parsePom
 * @param {string} rootDir Scanned directory
 * @param {Map} cache Shared by the poms of one scan, so a parent that many
 *   modules name is read once rather than once per module
 * @returns {string|undefined} Parent pom file
 */
function locateLocalParentPom(pomFile, parentRef, rootDir, cache) {
  if (!parentRef?.relativePath || !rootDir) {
    return undefined;
  }
  let candidate = resolve(dirname(pomFile), parentRef.relativePath);
  if (!candidate.endsWith(".xml")) {
    candidate = join(candidate, "pom.xml");
  }
  const rel = relative(resolve(rootDir), candidate);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    return undefined;
  }
  if (!safeExistsSync(candidate)) {
    return undefined;
  }
  const coordinates = localPomCoordinates(candidate, cache);
  if (
    !coordinates ||
    coordinates.artifactId !== parentRef.artifactId ||
    (parentRef.groupId && coordinates.groupId !== parentRef.groupId)
  ) {
    return undefined;
  }
  return candidate;
}

/**
 * The groupId and artifactId a pom declares, read once per scan. The pom is
 * untrusted and may be large, so its parse must not repeat for every module
 * that names it as a parent.
 *
 * @param {string} pomFile Pom file
 * @param {Map} cache Results by pom file; coordinates use their own key so
 *   they never collide with the inheritance entries
 * @returns {{groupId: string|undefined, artifactId: string|undefined}|undefined}
 *   Coordinates, or undefined when the pom cannot be read
 */
function localPomCoordinates(pomFile, cache) {
  // No file path contains NUL, so this key cannot be a pom file
  const key = `\0coordinates:${pomFile}`;
  if (cache.has(key)) {
    return cache.get(key);
  }
  let coordinates;
  try {
    const { groupId, artifactId } = parsePom(pomFile).properties || {};
    coordinates = { groupId, artifactId };
  } catch (_err) {
    // An unreadable pom is nobody's parent
  }
  cache.set(key, coordinates);
  return coordinates;
}

/**
 * What a pom passes on to its children: its user properties and managed
 * versions over those of its own local parents.
 *
 * @param {string} pomFile Pom file
 * @param {string} rootDir Scanned directory
 * @param {Map} cache Results by pom file
 * @param {number} depth Current depth of the parent chain
 * @returns {Object} Inherited properties and managed versions
 */
function localPomInheritance(pomFile, rootDir, cache, depth) {
  if (cache.has(pomFile)) {
    return cache.get(pomFile);
  }
  const empty = { properties: {}, managedVersions: {} };
  // A parent chain that loops back reads as having no parent
  cache.set(pomFile, empty);
  let inherited = empty;
  try {
    const parentPom =
      depth < LOCAL_PARENT_DEPTH_LIMIT
        ? locateLocalParentPom(
            pomFile,
            parsePom(pomFile).parent,
            rootDir,
            cache,
          )
        : undefined;
    if (parentPom) {
      inherited = localPomInheritance(parentPom, rootDir, cache, depth + 1);
    }
    const own = parsePom(pomFile, inherited);
    const result = {
      properties: { ...inherited.properties, ...own.userProperties },
      managedVersions: { ...inherited.managedVersions, ...own.managedVersions },
    };
    cache.set(pomFile, result);
    return result;
  } catch (_err) {
    return empty;
  }
}

/**
 * Parse a pom file together with the parent poms it names that are present
 * inside the scanned directory, without running Maven. Properties and
 * dependencyManagement versions from those parents resolve the versions the
 * pom leaves to them. Parents outside the directory and imported BOMs are not
 * read, so the versions they manage stay empty.
 *
 * @param {string} pomFile Pom file to parse
 * @param {string} rootDir Scanned directory; parents outside it are ignored
 * @param {Map} [cache] Reused across the poms of one scan
 * @returns {Object} Same shape as parsePom
 */
export function parsePomWithLocalParents(pomFile, rootDir, cache = new Map()) {
  const pomPath = resolve(pomFile);
  const parentPom = locateLocalParentPom(
    pomPath,
    parsePom(pomPath).parent,
    rootDir,
    cache,
  );
  if (!parentPom) {
    return parsePom(pomFile);
  }
  return parsePom(pomFile, localPomInheritance(parentPom, rootDir, cache, 1));
}

/** Bound on the reactor walk. A pom's module list is untrusted input, so the
 * walk cannot trust it to stay finite. */
const REACTOR_MODULE_LIMIT = 500;

/**
 * Every pom file of the reactor an aggregator pom builds: its own modules,
 * recursively through nested aggregators. A recursive dependency:tree run
 * from the aggregator resolves all of them, so their own runs repeat it.
 *
 * A module entry names a directory relative to its pom, sometimes a direct
 * path to a pom file. Entries that are absolute, or that climb out of the
 * aggregator's directory, are ignored: the scan never listed them, and the
 * walk must not follow a pom's pointers outside its own tree.
 *
 * @param {string} rootPom Path of the aggregator pom.
 * @returns {Set<string>} Pom files of the reactor, excluding the aggregator.
 */
export function resolveReactorPomFiles(rootPom) {
  const pomFiles = new Set();
  const visited = new Set();
  const rootDir = dirname(resolve(rootPom));
  const queue = [resolve(rootPom)];
  while (queue.length > 0 && pomFiles.size < REACTOR_MODULE_LIMIT) {
    const pom = queue.shift();
    if (visited.has(pom)) {
      continue;
    }
    visited.add(pom);
    let modules;
    try {
      modules = parsePom(pom)?.modules;
    } catch (_err) {
      // An unreadable module pom ends this branch of the walk.
      continue;
    }
    for (const module of modules || []) {
      if (typeof module !== "string") {
        continue;
      }
      const cleaned = module.trim().replaceAll("\\", "/");
      if (
        !cleaned ||
        cleaned.includes("\0") ||
        cleaned.startsWith("/") ||
        /^[A-Za-z]:/.test(cleaned)
      ) {
        continue;
      }
      const modulePom = resolve(
        dirname(pom),
        cleaned.endsWith(".xml") ? cleaned : join(cleaned, "pom.xml"),
      );
      const withinRoot = relative(rootDir, modulePom);
      if (
        !withinRoot ||
        withinRoot.startsWith("..") ||
        isAbsolute(withinRoot) ||
        !safeExistsSync(modulePom)
      ) {
        continue;
      }
      if (visited.has(modulePom)) {
        continue;
      }
      pomFiles.add(modulePom);
      queue.push(modulePom);
    }
  }
  return pomFiles;
}

/**
 * File name stem for the trees of one recursive dependency:tree run. Maven
 * expands the project expressions for each reactor module, so every module
 * writes its own file; a fixed name would hold only the last module's tree.
 */
export const MAVEN_MODULE_TREE_STEM =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Maven expands these project expressions itself
  "${project.groupId}-${project.artifactId}";

/**
 * The groupId-artifactId key a module's tree file is named by.
 *
 * @param {string} pomFile Path of the module pom.
 * @returns {string|undefined} The key, or undefined when the pom cannot be read.
 */
function moduleTreeKey(pomFile) {
  try {
    const { groupId, artifactId } = parsePom(pomFile)?.properties || {};
    return groupId && artifactId ? `${groupId}-${artifactId}` : undefined;
  } catch (_err) {
    return undefined;
  }
}

/**
 * Read the trees one dependency:tree run wrote, one file per reactor module
 * (see MAVEN_MODULE_TREE_STEM), and tell which of the reactor's pom files
 * they cover. The pom the run started from comes first, then its modules in
 * reactor order. A module pom counts as covered only when its own tree is
 * among the files, so a module the run left out still runs on its own.
 *
 * @param {string} treeDir Directory the run wrote its trees into.
 * @param {string} rootPom The pom file the run started from.
 * @returns {{trees: Array<{pomFile: string, text: string}>, covered: Set<string>}}
 */
export function readMavenModuleTrees(treeDir, rootPom) {
  const trees = [];
  const covered = new Set();
  let names;
  try {
    names = readdirSync(treeDir).sort();
  } catch (_err) {
    return { trees, covered };
  }
  const byKey = new Map();
  for (const name of names) {
    const stem = name.replace(/\.(json|txt)$/, "");
    if (stem !== name && !byKey.has(stem)) {
      byKey.set(stem, name);
    }
  }
  // A run that failed wrote no tree, so there is nothing to match the
  // reactor's poms against. The caller reads the trees after every run, so
  // walking here would repeat the reactor walk for each pom of the scan.
  if (!byKey.size) {
    return { trees, covered };
  }
  const take = (key, pomFile) => {
    const name = byKey.get(key);
    if (!name) {
      return false;
    }
    byKey.delete(key);
    trees.push({
      pomFile,
      text: readFileSync(join(treeDir, name), { encoding: "utf-8" }),
    });
    return true;
  };
  const rootKey = moduleTreeKey(rootPom);
  if (rootKey) {
    take(rootKey, rootPom);
  }
  for (const modulePom of resolveReactorPomFiles(rootPom)) {
    const key = moduleTreeKey(modulePom);
    if (key && take(key, modulePom)) {
      covered.add(modulePom);
    }
  }
  // Trees no pom of the reactor names, such as the single file of a Maven
  // that did not expand the expressions, are kept under the root pom.
  for (const key of [...byKey.keys()]) {
    take(key, rootPom);
  }
  return { trees, covered };
}

function mapMavenScope(componentScope, isOptional = false) {
  if (isOptional || componentScope === "test") {
    return "optional";
  }
  if (["compile", "runtime", "import"].includes(componentScope)) {
    return "required";
  }
  if (["provided", "system"].includes(componentScope)) {
    return "excluded";
  }
  return undefined;
}

function createMavenComponentFromCoordinateParts(pkgArr, pomFile, isOptional) {
  let versionStr = pkgArr[pkgArr.length - 2];
  const componentScope = pkgArr[pkgArr.length - 1];
  let classifier;
  if (
    pkgArr.length >= 6 &&
    pkgArr[3] !== versionStr &&
    !pkgArr[3].includes(".jar")
  ) {
    classifier = pkgArr[3];
  }
  if (pkgArr.length === 4) {
    versionStr = pkgArr[pkgArr.length - 1];
  }
  const qualifiers = { type: pkgArr[2] };
  if (classifier) {
    qualifiers.classifier = classifier;
  }
  const purlString = build({
    type: "maven",
    namespace: pkgArr[0] || null,
    name: pkgArr[1],
    version: versionStr || null,
    qualifiers: qualifiers || null,
  });
  const bomRef = decodeURIComponent(purlString);
  const scope = mapMavenScope(componentScope, isOptional);
  const properties = [];
  const apkg = {
    group: pkgArr[0],
    name: pkgArr[1],
    version: versionStr,
    qualifiers,
    scope,
    properties,
    purl: purlString,
    "bom-ref": bomRef,
  };
  if (pomFile) {
    properties.push({
      name: "internal:SrcFile",
      value: pomFile,
    });
    apkg.evidence = {
      identity: {
        field: "purl",
        confidence: 0.5,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 0.5,
            value: pomFile,
          },
        ],
      },
    };
  }
  return apkg;
}

function createMavenComponentFromTreeNode(node, pomFile) {
  const type = node.type || "jar";
  const qualifiers = { type };
  if (node.classifier) {
    qualifiers.classifier = node.classifier;
  }
  const purlString = build({
    type: "maven",
    namespace: node.groupId || null,
    name: node.artifactId,
    version: node.version || null,
    qualifiers: qualifiers || null,
  });
  const bomRef = decodeURIComponent(purlString);
  const isOptional = node.optional === true || node.optional === "true";
  const properties = [];
  const apkg = {
    group: node.groupId,
    name: node.artifactId,
    version: node.version,
    qualifiers,
    scope: mapMavenScope(node.scope, isOptional),
    properties,
    purl: purlString,
    "bom-ref": bomRef,
  };
  if (pomFile) {
    properties.push({
      name: "internal:SrcFile",
      value: pomFile,
    });
    apkg.evidence = {
      identity: {
        field: "purl",
        confidence: 0.5,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 0.5,
            value: pomFile,
          },
        ],
      },
    };
  }
  return apkg;
}

/**
 * Parse maven dependency:tree json output
 *
 * @param rawOutput
 * @param pomFile
 * @returns {{parentComponent: {}, pkgList: *[], dependenciesList: *[]}|{}|{}|*|{parentComponent: {[p: string]: *}|{}, pkgList: [], dependenciesList: []}}
 */
export function parseMavenTreeJson(rawOutput, pomFile) {
  if (!rawOutput) {
    return {};
  }
  let rootNode = rawOutput;
  if (typeof rawOutput === "string") {
    try {
      rootNode = JSON.parse(rawOutput);
    } catch (_err) {
      recordDegradation("jvm.maven.tree-unparseable", {
        ecosystem: "java",
        tool: "maven",
        impact: "transitive-deps",
        path: pomFile,
        detail:
          "The maven dependency:tree JSON output could not be parsed, so the text output is parsed instead.",
      });
      thoughtLog("Unable to parse Maven dependency:tree JSON output");
      return {};
    }
  }
  const deps = [];
  const dependenciesList = [];
  const keysCache = new Set();
  const levelTrees = {};
  let parentComponent = {};
  const visitNode = (node, parentRef) => {
    if (!node?.groupId || !node?.artifactId || !node?.version) {
      return undefined;
    }
    const component = createMavenComponentFromTreeNode(node, pomFile);
    const bomRef = component["bom-ref"];
    if (!Object.keys(parentComponent).length) {
      parentComponent = { ...component, type: "application" };
    }
    if (!keysCache.has(bomRef)) {
      keysCache.add(bomRef);
      deps.push(component);
    }
    if (!levelTrees[bomRef]) {
      levelTrees[bomRef] = [];
    }
    if (parentRef) {
      const cnodes = levelTrees[parentRef] || [];
      cnodes.push(bomRef);
      levelTrees[parentRef] = cnodes;
    }
    for (const child of node.children || []) {
      visitNode(child, bomRef);
    }
    return bomRef;
  };
  visitNode(rootNode);
  for (const lk of Object.keys(levelTrees)) {
    dependenciesList.push({
      ref: lk,
      dependsOn: [...new Set(levelTrees[lk])].sort(),
    });
  }
  return {
    parentComponent,
    pkgList: deps,
    dependenciesList,
  };
}

// Suffix that dependency:tree appends to optional dependencies in text output.
const OPTIONAL_MARKER = "(optional)";

/**
 * Parse maven tree output
 * @param {string} rawOutput Raw string output
 * @param {string} pomFile .pom file for evidence
 *
 * @returns {Object} Object containing packages and dependencies
 */
export function parseMavenTree(rawOutput, pomFile) {
  if (!rawOutput) {
    return {};
  }
  if (rawOutput.trim().startsWith("{")) {
    return parseMavenTreeJson(rawOutput, pomFile);
  }
  const deps = [];
  const dependenciesList = [];
  const keys_cache = {};
  const level_trees = {};
  const tmpA = rawOutput.split("\n");
  let last_level = 0;
  let last_purl = "";
  let first_ref;
  const stack = [];
  tmpA.forEach((l) => {
    l = l.replaceAll("\r", "");
    // Strip a trailing " (optional)" marker with plain string operations, which
    // stay linear on the long runs of blanks a dependency's classifier can hold.
    const trimmedLine = l.trimEnd();
    const markerStart = trimmedLine.length - OPTIONAL_MARKER.length;
    const isOptional =
      markerStart > 0 &&
      trimmedLine.endsWith(OPTIONAL_MARKER) &&
      /\s/.test(trimmedLine.charAt(markerStart - 1));
    if (isOptional) {
      l = trimmedLine.slice(0, markerStart).trimEnd();
    }
    if (!includeMavenTestScope && l.trim().endsWith(":test")) {
      return;
    }
    let level = 0;
    const tmpline = l.split(" ");
    if (tmpline?.length) {
      if (l.includes(" ")) {
        level = l.replace(tmpline[tmpline.length - 1], "").length / 3;
      }
      l = tmpline[tmpline.length - 1];
      const pkgArr = l.split(":");
      if (pkgArr && pkgArr.length > 2) {
        const componentScope = pkgArr[pkgArr.length - 1];
        // Ignore test scope
        if (!includeMavenTestScope && componentScope === "test") {
          return;
        }
        const apkg = createMavenComponentFromCoordinateParts(
          pkgArr,
          pomFile,
          isOptional,
        );
        const bomRef = apkg["bom-ref"];
        const key = bomRef;
        if (!first_ref) {
          first_ref = bomRef;
        }
        if (!keys_cache[key]) {
          keys_cache[key] = key;
          deps.push(apkg);
        }
        if (!level_trees[bomRef]) {
          level_trees[bomRef] = [];
        }
        if (level === 0 || last_purl === "") {
          stack.push(bomRef);
        } else if (level > last_level) {
          const cnodes = level_trees[last_purl] || [];
          cnodes.push(bomRef);
          level_trees[last_purl] = cnodes;
          if (stack[stack.length - 1] !== bomRef) {
            stack.push(bomRef);
          }
        } else {
          for (let i = level; i <= last_level; i++) {
            stack.pop();
          }
          const last_stack = stack.length ? stack[stack.length - 1] : first_ref;
          const cnodes = level_trees[last_stack] || [];
          cnodes.push(bomRef);
          level_trees[last_stack] = cnodes;
          stack.push(bomRef);
        }
        last_level = level;
        last_purl = bomRef;
      }
    }
  });
  for (const lk of Object.keys(level_trees)) {
    dependenciesList.push({
      ref: lk,
      dependsOn: [...new Set(level_trees[lk])].sort(),
    });
  }
  const parentComponent = deps?.length
    ? { ...deps[0], type: "application" }
    : {};
  return {
    parentComponent,
    pkgList: deps,
    dependenciesList,
  };
}

/**
 * Parse mill dependencies from file
 *
 * Scala artifacts are emitted in the sbt purl form: the Scala binary suffix
 * is stripped from the artifact name and the version it carried is recorded
 * in the cdx:scala:compilerVersion property, so one library keeps a single
 * purl whichever build tool reported it.
 *
 * @param {string} module name of the module
 * @param {map} dependencies the parsed dependencies
 * @param {map} relations a map containing all relations
 * @param {string} millRootPath root of the project
 * @param {string} logFileName name of the tree log the module wrote
 *
 * @returns the bom-ref of the module
 */
export function parseMillDependency(
  module,
  dependencies,
  relations,
  millRootPath,
  logFileName = "ivyDepsTree.log",
) {
  const treeRegex = /^(?<treeIndentation>(?:[?├│└─ ]{3})+)(?<dependency>.*)/m;
  const ESC = "\\x1B";
  const versionRegex = new RegExp(
    `^(?:${ESC}\\[\\d+m.+ -> )?(?<version>[^\\ ${ESC}]+)(?:.*${ESC}\\[0m)?`,
    "m",
  );
  const levelCache = new Map();
  const moduleComponent = completeComponent({
    name: module,
    version: "latest",
  });
  dependencies.set(moduleComponent["bom-ref"], moduleComponent);
  relations.set(moduleComponent["bom-ref"], []);
  levelCache.set(0, moduleComponent["bom-ref"]);
  let moduleFilePath = module;
  const versionNumbers = [];
  let indexOfBracket = moduleFilePath.indexOf("[");
  for (let versionIndex = 0; indexOfBracket !== -1; versionIndex++) {
    // Special handling for modules called something like 'main.init.sbt.models[2.12.20]'
    // This needs to be turned into a path like 'main/init/sbt/models/2.12.20'
    // However, since all other periods need to be changed to slashes, this needs something more...
    versionNumbers.push(
      moduleFilePath.substring(
        indexOfBracket + 1,
        moduleFilePath.indexOf("]", indexOfBracket + 1),
      ),
    );
    moduleFilePath = moduleFilePath.replace(
      `[${versionNumbers[versionIndex]}]`,
      "[]",
    );
    indexOfBracket = moduleFilePath.indexOf("[", indexOfBracket + 1);
  }
  moduleFilePath = moduleFilePath.replaceAll(".", "/");
  for (const versionNumber of versionNumbers) {
    // Now put the versions we removed above back into the path and replace the brackets at the same time
    moduleFilePath = moduleFilePath.replace("[]", `/${versionNumber}/`);
  }
  moduleFilePath = resolve(millRootPath, "out", moduleFilePath, logFileName);
  moduleComponent.properties = [
    {
      name: "internal:SrcFile",
      value: moduleFilePath,
    },
  ];
  moduleComponent.evidence = {
    identity: {
      field: "purl",
      confidence: 0.6,
      methods: [
        {
          technique: "manifest-analysis",
          confidence: 0.6,
          value: moduleFilePath,
        },
      ],
    },
  };
  let dependencyTreeLog;
  try {
    dependencyTreeLog = readFileSync(moduleFilePath, "utf-8");
  } catch (_err) {
    // A cross-published module writes its log under the dotted version
    // directory (0.23.38) while the resolve output prints it with
    // underscores (0_23_38)
    try {
      dependencyTreeLog = readFileSync(
        moduleFilePath.replace(/(\d+)_(\d+)_(\d+)/, "$1.$2.$3"),
        "utf-8",
      );
    } catch (_err2) {
      if (DEBUG_MODE) {
        console.log(
          `No Mill dependency tree log was written for the module ${module}.`,
        );
      }
      return moduleComponent["bom-ref"];
    }
  }
  const dependencyTreeLines = dependencyTreeLog
    .trim()
    .split("\n")
    .map((dependency) => dependency.replaceAll("\r", ""));
  for (const line of dependencyTreeLines) {
    const match = treeRegex.exec(line);
    if (match === null) {
      continue;
    }
    const level = match.groups.treeIndentation.length / 3;
    let group;
    let name;
    let version;
    if (match.groups.dependency.indexOf(":") === -1) {
      name = match.groups.dependency;
      version = "latest";
    } else {
      [group, name, version] = match.groups.dependency.split(":");
      version = versionRegex.exec(version).groups.version;
    }
    const scalaInfo = parseScalaArtifact(name);
    const component = completeComponent({
      group,
      name: scalaInfo.purlName,
      version,
    });
    if (scalaInfo.binaryVersion) {
      component.properties = [
        {
          name: "cdx:scala:compilerVersion",
          value: scalaInfo.binaryVersion,
        },
      ];
    }
    if (!dependencies.has(component["bom-ref"])) {
      dependencies.set(component["bom-ref"], component);
      relations.set(component["bom-ref"], []);
    }
    if (
      !relations.get(levelCache.get(level - 1)).includes(component["bom-ref"])
    ) {
      relations.get(levelCache.get(level - 1)).push(component["bom-ref"]);
    }
    levelCache.set(level, component["bom-ref"]);
  }
  return moduleComponent["bom-ref"];
}

export function completeComponent(component) {
  component["type"] = component.group ? "library" : "application";
  try {
    const purl = build({
      type: "maven",
      namespace: component.group || null,
      name: component.name,
      version: component.version || null,
      qualifiers: { type: "jar" },
    });
    applyPurl(component, purl);
  } catch {
    applyPurl(component, null);
  }
  return component;
}

/**
 * Parse clojure cli dependencies output
 * @param {string} rawOutput Raw string output
 */
export function parseCljDep(rawOutput) {
  if (typeof rawOutput === "string") {
    const deps = [];
    const keys_cache = {};
    const tmpA = rawOutput.split("\n");
    tmpA.forEach((l) => {
      l = l.trim();
      if (!l.startsWith("Downloading") || !l.startsWith("X ")) {
        if (l.startsWith(". ")) {
          l = l.replace(". ", "");
        }
        const tmpArr = l.split(" ");
        if (tmpArr.length === 2) {
          let group = dirname(tmpArr[0]);
          if (group === ".") {
            group = "";
          }
          const name = basename(tmpArr[0]);
          const version = tmpArr[1];
          const cacheKey = `${group}-${name}-${version}`;
          if (!keys_cache[cacheKey]) {
            keys_cache[cacheKey] = true;
            deps.push({
              group,
              name,
              version,
            });
          }
        }
      }
    });
    return deps;
  }
  return [];
}

/**
 * Parse lein dependency tree output
 * @param {string} rawOutput Raw string output
 */
export function parseLeinDep(rawOutput) {
  if (typeof rawOutput === "string") {
    const deps = [];
    const keys_cache = {};
    if (rawOutput.includes("{[") && !rawOutput.startsWith("{[")) {
      rawOutput = `{[${rawOutput.split("{[")[1]}`;
    }
    const ednData = parseEDNString(rawOutput);
    return parseLeinMap(ednData, keys_cache, deps);
  }
  return [];
}

/**
 * Recursively walks a parsed EDN map node produced by the Leiningen dependency
 * tree and collects unique dependency entries into the deps array.
 *
 * @param {Object} node Parsed EDN node (expected to have a "map" property)
 * @param {Object} keys_cache Cache object used to deduplicate entries by group-name-version key
 * @param {Object[]} deps Accumulator array of dependency objects with group, name, and version fields
 * @returns {Object[]} The populated deps array
 */
export function parseLeinMap(node, keys_cache, deps) {
  if (node["map"]) {
    for (const n of node["map"]) {
      if (n.length === 2) {
        const rootNode = n[0];
        const psym = rootNode[0].sym;
        const version = rootNode[1];
        let group = dirname(psym);
        if (group === ".") {
          group = "";
        }
        const name = basename(psym);
        const cacheKey = `${group}-${name}-${version}`;
        if (!keys_cache[cacheKey]) {
          keys_cache[cacheKey] = true;
          deps.push({ group, name, version });
        }
        if (n[1]) {
          parseLeinMap(n[1], keys_cache, deps);
        }
      }
    }
  }
  return deps;
}

/**
 * Parse bazel action graph output
 * @param {string} rawOutput Raw string output
 */
export function parseBazelActionGraph(rawOutput) {
  const mavenPrefixRegex = /^@maven\/\/:(.*)\/(.*)\/(.*)\/(.*\.jar)$/g;

  if (typeof rawOutput === "string") {
    const deps = [];
    const keys_cache = {};
    const tmpA = rawOutput.split("\n");
    tmpA.forEach((l) => {
      l = l.replaceAll("\r", "");
      if (l.trim().startsWith("@maven//:")) {
        const matches = Array.from(l.matchAll(mavenPrefixRegex));

        if (matches[0]?.[1]) {
          const group = matches[0][1].split("/").join(".");
          const name = matches[0][2];
          const version = matches[0][3];

          const key = `${group}:${name}:${version}`;

          if (!keys_cache[key]) {
            keys_cache[key] = true;
            deps.push({
              group,
              name,
              version,
              qualifiers: { type: "jar" },
            });
          }
        }
      }
    });
    return deps;
  }
  return [];
}

/**
 * Parse bazel skyframe state output
 * @param {string} rawOutput Raw string output
 */
export function parseBazelSkyframe(rawOutput) {
  if (typeof rawOutput === "string") {
    const deps = [];
    const keys_cache = {};
    const tmpA = rawOutput.split("\n");
    tmpA.forEach((l) => {
      l = l.replaceAll("\r", "");
      if (l.indexOf("external/maven") >= 0) {
        l = l.replace("arguments: ", "").replace(/"/g, "");
        // Skyframe could have duplicate entries
        if (l.includes("@@maven//")) {
          l = l.split(",")[0];
        }
        const mparts = l.split("external/maven/v1/");
        if (mparts?.[mparts.length - 1].endsWith(".jar")) {
          // Example
          // https/jcenter.bintray.com/com/google/guava/failureaccess/1.0.1/failureaccess-1.0.1.jar
          // https/repo1.maven.org/maven2/org/simpleflatmapper/sfm-util/8.2.2/header_sfmutil-8.2.2.jar
          const jarPath = mparts[mparts.length - 1];
          let jarPathParts = jarPath.split("/");
          if (jarPathParts.length) {
            // Remove the protocol, registry url and then file name
            let prefix_slice_count = 2;
            // Bug: #169
            const prefix =
              readEnvironmentVariable("BAZEL_STRIP_MAVEN_PREFIX") || "/maven2/";
            if (l.includes(prefix)) {
              prefix_slice_count = prefix.split("/").length;
            }
            jarPathParts = jarPathParts.slice(prefix_slice_count, -1);
            // The last part would be the version
            const version = jarPathParts[jarPathParts.length - 1];
            // Last but one would be the name
            const name = jarPathParts[jarPathParts.length - 2].toLowerCase();
            // Rest would be the group
            const group = jarPathParts.slice(0, -2).join(".").toLowerCase();
            const key = `${group}:${name}:${version}`;
            if (!keys_cache[key]) {
              keys_cache[key] = true;
              deps.push({
                group,
                name,
                version,
                qualifiers: { type: "jar" },
              });
            }
          }
        }
      }
    });
    return deps;
  }
  return [];
}

/**
 * Parse bazel BUILD file
 * @param {string} rawOutput Raw string output
 */
export function parseBazelBuild(rawOutput) {
  if (typeof rawOutput === "string") {
    const projs = [];
    const tmpA = rawOutput.split("\n");
    tmpA.forEach((l) => {
      if (l.includes("name =")) {
        const name = l.split("name =")[1].replace(/[",]/g, "").trim();
        if (!name.includes("test")) {
          projs.push(name);
        }
      }
    });
    return projs;
  }
  return [];
}

/**
 * Parse dependencies in Key:Value format
 */
export function parseKVDep(rawOutput) {
  if (typeof rawOutput === "string") {
    const deps = [];
    rawOutput.split("\n").forEach((l) => {
      l = l.replaceAll("\r", "");
      const tmpA = l.split(":");
      let group = "";
      let name = "";
      let version = "";
      if (tmpA.length === 3) {
        group = tmpA[0];
        name = tmpA[1];
        version = tmpA[2];
      } else if (tmpA.length === 2) {
        name = tmpA[0];
        version = tmpA[1];
      }
      const purlString = build({
        type: "maven",
        namespace: group || null,
        name: name,
        version: version || null,
        qualifiers: { type: "jar" } || null,
      });
      deps.push({
        group,
        name,
        version,
        purl: purlString,
        "bom-ref": decodeURIComponent(purlString),
      });
    });
    return deps;
  }
  return [];
}

/**
 * Parse Leiningen project.clj data and extract dependency packages.
 *
 * @param {string} leinData Raw text contents of a Leiningen project.clj file
 * @returns {Object[]} Array of package objects with group, name, and version
 */
export function parseLeiningenData(leinData) {
  const pkgList = [];
  if (!leinData) {
    return pkgList;
  }
  const tmpArr = leinData.split("(defproject");
  if (tmpArr.length > 1) {
    leinData = `(defproject${tmpArr[1]}`;
  }
  const ednData = parseEDNString(leinData);
  for (const k of Object.keys(ednData)) {
    if (k === "list") {
      ednData[k].forEach((jk) => {
        if (Array.isArray(jk)) {
          jk.forEach((pobjl) => {
            if (Array.isArray(pobjl) && pobjl.length > 1) {
              const psym = pobjl[0].sym;
              if (psym) {
                let group = dirname(psym) || "";
                if (group === ".") {
                  group = "";
                }
                const name = basename(psym);
                pkgList.push({ group, name, version: pobjl[1] });
              }
            }
          });
        }
      });
    }
  }
  return pkgList;
}

/**
 * Parse EDN (Extensible Data Notation) deps.edn data and extract dependency packages.
 *
 * Handles Clojure deps.edn files, extracting packages listed under the `:deps` key.
 *
 * @param {string} rawEdnData Raw EDN text contents of a deps.edn file
 * @returns {Object[]} Array of package objects with group, name, and version
 */
export function parseEdnData(rawEdnData) {
  const pkgList = [];
  if (!rawEdnData) {
    return pkgList;
  }
  const ednData = parseEDNString(rawEdnData);
  const pkgCache = {};
  for (const k of Object.keys(ednData)) {
    if (k === "map") {
      ednData[k].forEach((jk) => {
        if (Array.isArray(jk)) {
          if (Array.isArray(jk)) {
            if (jk.length > 1) {
              if (jk[0].key === "deps") {
                const deps = jk[1].map;
                if (deps) {
                  deps.forEach((d) => {
                    if (Array.isArray(d)) {
                      let psym = "";
                      d.forEach((e) => {
                        if (e.sym) {
                          psym = e.sym;
                        }
                        if (e["map"]) {
                          if (e["map"][0].length > 1) {
                            const version = e["map"][0][1];
                            let group = dirname(psym) || "";
                            if (group === ".") {
                              group = "";
                            }
                            const name = basename(psym);
                            const cacheKey = `${group}-${name}-${version}`;
                            if (!pkgCache[cacheKey]) {
                              pkgList.push({ group, name, version });
                              pkgCache[cacheKey] = true;
                            }
                          }
                        }
                      });
                    }
                  });
                }
              }
            }
          }
        }
      });
    }
  }
  return pkgList;
}
