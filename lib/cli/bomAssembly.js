import { Buffer } from "node:buffer";
import { randomUUID as uuidv4 } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { build, Purl } from "@cdxgen/cdx-purl";
import { parse } from "ssri";

import {
  DEBUG_MODE,
  recordActivity,
  resetActivityContext,
  setActivityContext,
} from "../core/activity.js";
import { PROJECT_TYPE_ALIASES } from "../core/env.js";
import {
  getTimestamp,
  getTmpDir,
  safeExistsSync,
  safeMkdtempSync,
} from "../core/fs.js";
import {
  CDXGEN_TOOL_GROUP,
  CDXGEN_TOOL_NAME,
  CDXGEN_VERSION,
  frameworksList,
} from "../core/state.js";
import { getExecutedTools } from "../core/toolRegistry.js";
import {
  isPkgTypeOnlyImport,
  setNpmCleanedVersionProperty,
} from "../ecosystems/npmutils.js";
import { parsePackageJsonName } from "../ecosystems/parsers-js.js";
import {
  AI_INSTRUCTION_FILE_KINDS,
  AI_INVENTORY_PROJECT_TYPES,
  AI_SKILL_FILE_KIND,
  inventoryPropertyValue,
  MCP_CONFIG_FILE_KIND,
  optionIncludesAiInventoryProjectType,
  summarizeAiInventory,
} from "../inventory/aiInventory.js";
import { expandBomAuditCategories } from "../inventory/auditCategories.js";
import {
  DEFAULT_CDX_SPEC_VERSION,
  setCycloneDxFormat,
  toCycloneDxSpecVersionString,
} from "../inventory/bomUtils.js";
import { mergeDuplicateCryptoComponents } from "../inventory/certificates.js";
import { mergeServices, trimComponents } from "../inventory/depsUtils.js";
import {
  attachIdentityTools,
  extractToolRefs,
} from "../inventory/evidenceUtils.js";
import { enrichComponentWithMcpMetadata } from "../inventory/mcp.js";
import {
  applyPurl,
  canonicalPurlFromLooseString,
  npmPurl,
  tryBuildPurl,
} from "../inventory/purl.js";
import { repairPurl } from "../inventory/sbomDocument.js";
import { getLicenses } from "../inventory/spdx.js";
import { getBinaryBom, getPluginToolComponents } from "../managers/binary.js";
import { isValidIriReference } from "../parsers/iri.js";

/**
 * Determines whether the `node_modules` directory should be scanned for the
 * current run. Scanning is always performed in deep mode or when no project
 * type is selected; otherwise the selected types must include at least one of
 * the requested base project types.
 *
 * @param {object} options CLI options
 * @param {string[]} baseProjectTypes Base project types that require the scan
 * @returns {boolean} True when `node_modules` should be included in the scan
 */
export const shouldIncludeNodeModulesDir = (
  options = {},
  baseProjectTypes = [],
) => {
  if (options.deep) {
    return true;
  }
  const projectTypes = Array.isArray(options.projectType)
    ? options.projectType
    : options.projectType
      ? [options.projectType]
      : [];
  if (!projectTypes.length) {
    return true;
  }
  return baseProjectTypes.some((projectType) =>
    projectTypes.every((selectedProjectType) =>
      PROJECT_TYPE_ALIASES[projectType]?.includes(selectedProjectType),
    ),
  );
};

/**
 * Regex source string that matches hex digests of common lengths
 * (32, 40, 64, 96, or 128 characters) used for integrity validation.
 *
 * @type {string}
 */
export const HASH_PATTERN =
  "^([a-fA-F0-9]{32}|[a-fA-F0-9]{40}|[a-fA-F0-9]{64}|[a-fA-F0-9]{96}|[a-fA-F0-9]{128})$";

/**
 * Creates a default parent component based on the directory name.
 *
 * @param {String} path Directory or file name
 * @param {String} type Package type
 * @param {Object} options CLI options
 * @returns component object
 */
export const createDefaultParentComponent = (
  path,
  type = "application",
  options = {},
) => {
  // Expands any relative path such as dot
  path = resolve(path);
  // Create a parent component based on the directory name
  let dirNameStr =
    safeExistsSync(path) && lstatSync(path).isDirectory()
      ? basename(path)
      : dirname(path);
  const tmpA = dirNameStr.split(sep);
  dirNameStr = tmpA[tmpA.length - 1];
  const compName = "project-name" in options ? options.projectName : dirNameStr;
  const parentComponent = {
    group: options.projectGroup || "",
    name: compName,
    version: `${options.projectVersion || "latest"}`,
    type:
      type === "container" || compName.endsWith(".tar")
        ? "container"
        : "application",
  };
  // Strict purl validation (swift requires a namespace, maven a groupId)
  // rejects root application components that have no group. applyPurl then
  // omits the purl rather than inventing one, and derives a unique bom-ref.
  applyPurl(
    parentComponent,
    tryBuildPurl({
      type: type,
      namespace: parentComponent.group || null,
      name: parentComponent.name,
      version: parentComponent.version || null,
    }),
  );
  return parentComponent;
};

/**
 * Builds the parent (metadata.component) for the BOM from the
 * `--project-name`/`--project-version`/`--project-group` CLI options,
 * constructing a purl and bom-ref. Returns the caller-supplied
 * `options.parentComponent` unchanged when present.
 *
 * @param {object} options CLI options
 * @returns {object|undefined} Parent component object, or undefined when no
 *   project name/version is available
 */
export const determineParentComponent = (options) => {
  let parentComponent;
  if (options.parentComponent && Object.keys(options.parentComponent).length) {
    return options.parentComponent;
  }
  if (options.projectName && options.projectVersion) {
    parentComponent = {
      group: options.projectGroup || "",
      name: options.projectName,
      version: `${options.projectVersion}` || "",
      type: "application",
    };
    const ppurl = build({
      type: parentComponent.type,
      namespace: parentComponent.group || null,
      name: parentComponent.name,
      version: parentComponent.version || null,
    });
    parentComponent["bom-ref"] = decodeURIComponent(ppurl);
    parentComponent["purl"] = ppurl;
  }
  return parentComponent;
};

/**
 * Tells whether a `--project-name`/`--project-version` override names the very
 * project the generator detected, rather than a larger project containing it.
 *
 * The override is typed `application` because it can name anything. When its
 * name, group, and version match the detected parent, the two describe the same
 * project, and the detected parent is the better description of it: it carries
 * the ecosystem purl and the manifest metadata. Treating it as a subproject
 * would list the project as a dependency of itself under a second purl.
 *
 * @param {object|undefined} overrideParent Parent built from the options
 * @param {object|undefined} detectedParent Parent the generator derived
 * @returns {boolean} true when both describe the same project
 */
const overrideNamesDetectedParent = (overrideParent, detectedParent) => {
  if (!overrideParent || !detectedParent?.purl) {
    return false;
  }
  return (
    overrideParent.name === detectedParent.name &&
    (overrideParent.group || "") === (detectedParent.group || "") &&
    `${overrideParent.version}` === `${detectedParent.version}`
  );
};

/**
 * Re-anchor a dependency graph onto a caller-supplied parent component.
 *
 * A generator builds its `dependencies[]` around the parent it detected from
 * the manifest it read. `--project-name`/`--project-version` and an explicit
 * `parentComponent` replace that parent in `metadata.component`, which leaves
 * the graph rooted at a `bom-ref` that appears nowhere in the document — every
 * edge the generator produced hangs off a dangling ref.
 *
 * The detected parent is real: it is the project the manifest describes, and
 * the supplied parent is the larger thing that contains it. So it is kept as a
 * component and an edge is drawn from the supplied parent to it, which is the
 * CycloneDX way to express a subproject and preserves every edge below it.
 *
 * @param {object|undefined} overrideParent Parent supplied through the options
 * @param {object|undefined} detectedParent Parent the generator derived
 * @param {object[]} components The component list, appended to in place
 * @param {object[]} dependencies Edges the generator produced
 * @param {object} options CLI options
 * @param {string} ptype Package type
 * @returns {object[]} Edges to emit, re-anchored when an override applies
 */
function anchorDetectedParent(
  overrideParent,
  detectedParent,
  components,
  dependencies,
  options,
  ptype,
) {
  const detectedRef = detectedParent?.["bom-ref"];
  const overrideRef = overrideParent?.["bom-ref"];
  if (!detectedRef || !overrideRef || detectedRef === overrideRef) {
    return dependencies;
  }
  if (!dependencies.some((dep) => dep.ref === detectedRef)) {
    return dependencies;
  }
  if (
    Array.isArray(components) &&
    !components.some((comp) => comp["bom-ref"] === detectedRef)
  ) {
    // The detected parent carries transient keys (`license`, `evidence`,
    // `_integrity`, `qualifiers`, `repository`, `homepage`) that only
    // `metadata.component` is cleaned of. As a regular component it must go
    // through the same conversion or schema validation rejects the document
    // (issue #4320). The copy keeps the caller's context object untouched.
    //
    // Its workspace members go through `listComponents`, the same conversion
    // `addMetadata` gives them when the detected parent is the one reaching
    // `metadata.component`. Without it they keep the raw parser shape
    // (`homepage: { url }`) that the nested Component schema rejects
    // (issue #4326).
    components.push(
      cleanParentComponent({
        ...detectedParent,
        components: detectedParent.components?.length
          ? listComponents(options, {}, detectedParent.components, ptype)
          : undefined,
      }),
    );
  }
  // The caller owns the array it passed, and postProcess merges these edges
  // across generators, so the re-anchoring is returned rather than spliced in.
  const anchored = [];
  let linked = false;
  for (const dep of dependencies) {
    if (dep.ref !== overrideRef) {
      anchored.push(dep);
      continue;
    }
    linked = true;
    anchored.push({
      ...dep,
      dependsOn: Array.from(new Set([...(dep.dependsOn || []), detectedRef])),
    });
  }
  if (!linked) {
    anchored.unshift({ ref: overrideRef, dependsOn: [detectedRef] });
  }
  return anchored;
}

/**
 * Builds the tool components for the external helpers and build tools this
 * run executed, from the run-scoped registry (issue #598). Bundled plugin
 * helpers are enriched with the manifest component of the plugin package that
 * ships them, so the plugin package's version and identity travel with the
 * helper. Empty when the run spawned nothing external, which keeps such BOMs
 * byte-identical to the previous behaviour.
 *
 * @returns {object[]} Sorted CycloneDX tool components
 */
export const buildExternalToolComponents = () => {
  const recordedTools = getExecutedTools();
  if (!recordedTools.length) {
    return [];
  }
  const recordedNames = recordedTools.map((tool) => tool.name);
  const pluginComponents = getPluginToolComponents(recordedNames);
  const pluginByName = new Map(
    pluginComponents.map((component) => [component.name, component]),
  );
  const components = [];
  for (const tool of recordedTools) {
    const pluginComponent = pluginByName.get(tool.name);
    if (pluginComponent?.["bom-ref"]) {
      components.push(pluginComponent);
      continue;
    }
    const component = {
      type: "application",
      name: tool.name,
    };
    if (tool.version) {
      component.version = tool.version;
    }
    components.push(component);
  }
  return components;
};

/**
 * Drops the executed tools that are already present: a tool whose bom-ref or
 * name matches an explicitly passed context tool, or whose bom-ref an earlier
 * executed tool already carries (several bundled helpers can share one plugin
 * package component). The context tools themselves are never touched.
 *
 * @param {object[]} contextTools Tool components passed in by the caller
 * @param {object[]} executedTools Tool components from the run's registry
 * @returns {object[]} The executed tools to append
 */
const newExecutedTools = (contextTools, executedTools) => {
  const seenRefs = new Set();
  const seenNames = new Set();
  for (const component of contextTools) {
    if (component?.["bom-ref"]) {
      seenRefs.add(component["bom-ref"]);
    }
    if (component?.name) {
      seenNames.add(component.name);
    }
  }
  const unique = [];
  for (const component of executedTools) {
    const ref = component["bom-ref"];
    if ((ref && seenRefs.has(ref)) || seenNames.has(component.name)) {
      continue;
    }
    if (ref) {
      seenRefs.add(ref);
    }
    unique.push(component);
  }
  return unique;
};

/**
 * Assembles the `metadata.tools` block, including the cdxgen tool entry and,
 * for spec versions prior to 1.5, the legacy tools array. For spec version
 * 1.6+ the author field is converted to the authors array. The tools this run
 * executed follow the context tools, sorted by name, and cdxgen comes last.
 *
 * @param {object} options CLI options
 * @param {object} [context={}] Additional context carrying existing components
 * @returns {{ components?: object[], tools?: object[] }} Object containing the
 *   tools array (1.4) or a components array with tool components (1.5+)
 */
export const addToolsSection = (options, context = {}) => {
  const externalTools = buildExternalToolComponents();
  if (options.specVersion === 1.4) {
    return [
      {
        vendor: "cyclonedx",
        name: "cdxgen",
        version: CDXGEN_VERSION,
      },
      ...newExecutedTools([], externalTools).map((tool) =>
        tool.version
          ? { name: tool.name, version: tool.version }
          : { name: tool.name },
      ),
    ];
  }
  let components = [];
  const tools = options.tools || context.tools || [];
  // tools can be an object or array
  if (Array.isArray(tools) && tools.length) {
    // cyclonedx-maven-plugin has the legacy tools metadata which needs to be patched
    for (const tool of tools) {
      if (!tool.type) {
        tool.type = "application";
        if (tool.vendor) {
          tool.publisher = tool.vendor;
          delete tool.vendor;
        }
      }
    }
    components = components.concat(tools);
  } else if (tools && Object.keys(tools).length && tools.components) {
    components = components.concat(tools.components);
  }
  components = components.concat(newExecutedTools(components, externalTools));
  const cdxToolComponent = {
    group: CDXGEN_TOOL_GROUP,
    name: CDXGEN_TOOL_NAME,
    version: CDXGEN_VERSION,
    purl: npmPurl(`${CDXGEN_TOOL_GROUP}/${CDXGEN_TOOL_NAME}`, CDXGEN_VERSION),
    type: "application",
    "bom-ref": `pkg:npm/${CDXGEN_TOOL_GROUP}/${CDXGEN_TOOL_NAME}@${CDXGEN_VERSION}`,
    author: "OWASP Foundation",
    publisher: "OWASP Foundation",
  };
  if (options.specVersion >= 1.6) {
    cdxToolComponent.authors = [{ name: "OWASP Foundation" }];
    delete cdxToolComponent.author;
  }
  components.push(cdxToolComponent);
  return { components };
};

/**
 * Renders a component's group/name@version as a simple display string.
 *
 * @param {object} comp Component object
 * @returns {string} `group/name@version`, `name@version`, or `name`
 */
export const componentToSimpleFullName = (comp) => {
  let fullName = comp.group?.length ? `${comp.group}/${comp.name}` : comp.name;
  if (comp.version?.length) {
    fullName = `${fullName}@${comp.version}`;
  }
  return fullName;
};

/**
 * Strips transient keys (`evidence`, `_integrity`, `license`, `qualifiers`,
 * `repository`, `homepage`) from a parent component while preserving licenses
 * and external references (bug #1519). External references whose URL is not a
 * valid IRI reference are dropped.
 *
 * @param {object} comp Parent component to clean in place
 * @returns {object} The cleaned parent component
 */
// Remove unwanted properties from parent component
// Bug #1519 - Retain licenses and external references
export const cleanParentComponent = (comp) => {
  delete comp.evidence;
  delete comp._integrity;
  if (comp.license) {
    const licenses = getLicenses(comp);
    if (licenses?.length) {
      comp.licenses = licenses;
    }
  }
  delete comp.license;
  delete comp.qualifiers;
  // Components get their references validated in listComponents. The parent
  // skips that conversion, so validate here too: an unusable URL taken from a
  // manifest must not make the whole document invalid.
  if (comp.repository || comp.homepage || comp.externalReferences?.length) {
    const externalReferences = addExternalReferences(comp);
    if (externalReferences?.length) {
      comp.externalReferences = externalReferences;
    } else {
      delete comp.externalReferences;
    }
  }
  delete comp.repository;
  delete comp.homepage;
  return comp;
};

/**
 * Builds the `metadata.authors` array from `options.author`, which may be a
 * single string or an array of author strings. Entries shorter than two
 * characters are ignored.
 *
 * @param {object} options CLI options
 * @returns {object[]} Author objects of the form `{ name }`
 */
export const addAuthorsSection = (options) => {
  const authors = [];
  if (options.author) {
    const oauthors = Array.isArray(options.author)
      ? options.author
      : [options.author];
    for (const aauthor of oauthors) {
      if (aauthor.trim().length < 2) {
        continue;
      }
      authors.push({ name: aauthor });
    }
  }
  return authors;
};

/**
 * Method to generate metadata.lifecycles section. We assume that we operate during "build"
 * most of the time and under "post-build" for containers.
 *
 * @param {Object} options
 * @returns {Array} Lifecycles array
 */
export const addLifecyclesSection = (options) => {
  // If lifecycle was set via CLI arguments, reuse the value
  if (options.lifecycle) {
    return [{ phase: options.lifecycle }];
  }
  const lifecycles = [{ phase: options.installDeps ? "build" : "pre-build" }];
  if (options.exportData) {
    const inspectData = options.exportData.inspectData;
    if (inspectData) {
      lifecycles.push({ phase: "post-build" });
    }
  } else if (
    options?.projectType?.length &&
    options?.projectType?.includes("binary")
  ) {
    lifecycles.push({ phase: "post-build" });
  }
  if (options.projectType?.includes("os")) {
    lifecycles.push({ phase: "operations" });
  }
  return lifecycles;
};

/**
 * Function to create metadata block
 *
 * @param {Object} [parentComponent] Component the BOM describes
 * @param {Object} [options] CLI options
 * @param {Object} [context] Generator context. `context.metadataProperties`
 *   holds facts of a manifest that has no component to carry them, such as the
 *   platform data of a composer.lock whose composer.json names no project.
 */
export function addMetadata(parentComponent = {}, options = {}, context = {}) {
  // DO NOT fork this project to just change the vendor or author's name
  // Try to contribute to this project by sending PR or filing issues
  const tools = addToolsSection(options, context);
  const authors = addAuthorsSection(options);
  const lifecycles =
    options.specVersion >= 1.5 ? addLifecyclesSection(options) : undefined;
  const metadata = {
    timestamp: getTimestamp(),
    tools,
    authors,
    supplier: undefined,
  };
  if (lifecycles) {
    metadata.lifecycles = lifecycles;
  }
  // TLP classification
  if (options.specVersion >= 1.7 && options?.tlpClassification) {
    metadata.distributionConstraints = { tlp: options.tlpClassification };
  }
  if (parentComponent && Object.keys(parentComponent).length) {
    if (parentComponent) {
      cleanParentComponent(parentComponent);
      // Recover a purl from the bom-ref only when the bom-ref genuinely is
      // one. Parsers that cannot build a valid purl (a swift package with no
      // remote URL, a maven module with no groupId) deliberately fall back to a
      // name-based bom-ref, and blindly copying that here manufactured invalid
      // purls such as `"purl": "swift-smoke"`. CycloneDX requires `purl` to be
      // a valid Package URL when present, so absent is the only correct answer.
      // A bom-ref holds the decoded purl (`pkg:npm/app@1.0.0+build`), so it is
      // split on its separators and rebuilt rather than escaped wholesale,
      // which would also escape the `@` before the version.
      if (!parentComponent["purl"] && parentComponent["bom-ref"]) {
        const candidate = canonicalPurlFromLooseString(
          parentComponent["bom-ref"],
        );
        if (candidate) {
          parentComponent["purl"] = candidate;
        }
      }
      setNpmCleanedVersionProperty(parentComponent);
    }
    if (parentComponent?.components) {
      parentComponent.components = listComponents(
        options,
        {},
        parentComponent.components,
      );
      const parentFullName = componentToSimpleFullName(parentComponent);
      const subComponents = [];
      const addedSubComponents = {};
      for (const comp of parentComponent.components) {
        cleanParentComponent(comp);
        if (comp.name && comp.type) {
          const fullName = componentToSimpleFullName(comp);
          // Fixes #479
          // Prevent the parent component from also appearing as a sub-component
          // We cannot use purl or bom-ref here since they would not match
          // purl - could have application on one side and a different type
          // bom-ref could have qualifiers on one side
          // A purl subpath marks a separate project that declares the
          // parent's coordinates, such as a second Maven project or a Gradle
          // subproject with the same group, name and version.
          const separateProject =
            comp.purl?.includes("#") &&
            comp.purl.split("#")[1] !== parentComponent.purl?.split("#")[1];
          if (fullName !== parentFullName || separateProject) {
            if (!comp["bom-ref"]) {
              comp["bom-ref"] = `pkg:${comp.type}/${decodeURIComponent(
                fullName,
              )}`;
            }
            if (!addedSubComponents[comp["bom-ref"]]) {
              subComponents.push(comp);
              addedSubComponents[comp["bom-ref"]] = true;
            }
          }
        }
      } // for
      // Avoid creating empty component.components attribute
      if (subComponents.length) {
        parentComponent.components = subComponents;
      } else {
        parentComponent.components = undefined;
      }
    }
    // Convert authors to author for specVersion < 1.6
    const parentComponentCopy = { ...parentComponent };

    if (options.specVersion < 1.6 && parentComponent?.authors) {
      parentComponentCopy.author = parentComponentCopy.authors
        .map((a) => (a.email ? `${a.name} <${a.email}>` : a.name))
        .join(",");
      delete parentComponentCopy.authors;
    }

    metadata.component = parentComponent;
  }
  // Have we already captured the oci properties
  if (metadata?.properties?.some((prop) => prop.name === "oci:image:Id")) {
    return metadata;
  }
  if (options) {
    const mproperties = [];
    if (options.exportData) {
      const inspectData = options.exportData.inspectData;
      if (inspectData) {
        if (inspectData.Id) {
          mproperties.push({
            name: "oci:image:Id",
            value: inspectData.Id,
          });
        }
        if (
          inspectData.RepoTags &&
          Array.isArray(inspectData.RepoTags) &&
          inspectData.RepoTags.length
        ) {
          mproperties.push({
            name: "oci:image:RepoTag",
            value: inspectData.RepoTags[0],
          });
        }
        if (
          inspectData.RepoDigests &&
          Array.isArray(inspectData.RepoDigests) &&
          inspectData.RepoDigests.length
        ) {
          mproperties.push({
            name: "oci:image:RepoDigest",
            value: inspectData.RepoDigests[0],
          });
        }
        if (inspectData.Created) {
          mproperties.push({
            name: "oci:image:Created",
            value: inspectData.Created,
          });
        }
        if (inspectData.Architecture) {
          mproperties.push({
            name: "oci:image:Architecture",
            value: inspectData.Architecture,
          });
        }
        if (inspectData.Os) {
          mproperties.push({
            name: "oci:image:Os",
            value: inspectData.Os,
          });
        }
      }
      const manifestList = options.exportData.manifest;
      if (manifestList && Array.isArray(manifestList) && manifestList.length) {
        const manifest = manifestList[0] || {};
        if (manifest.Config) {
          mproperties.push({
            name: "oci:image:manifest:Config",
            value: manifest.Config,
          });
        }
        if (
          manifest.Layers &&
          Array.isArray(manifest.Layers) &&
          manifest.Layers.length
        ) {
          mproperties.push({
            name: "oci:image:manifest:Layers",
            value: manifest.Layers.join("\\n"),
          });
        }
      }
      const lastLayerConfig = options.exportData.lastLayerConfig;
      if (lastLayerConfig) {
        if (lastLayerConfig.id) {
          mproperties.push({
            name: "oci:image:lastLayer:Id",
            value: lastLayerConfig.id,
          });
        }
        if (lastLayerConfig.parent) {
          mproperties.push({
            name: "oci:image:lastLayer:ParentId",
            value: lastLayerConfig.parent,
          });
        }
        if (lastLayerConfig.created) {
          mproperties.push({
            name: "oci:image:lastLayer:Created",
            value: lastLayerConfig.created,
          });
        }
      }
      const layerConfig =
        lastLayerConfig?.config || options.exportData?.inspectData;
      if (layerConfig) {
        const env = layerConfig?.config?.Env || layerConfig?.Config?.Env;
        if (env && Array.isArray(env) && env.length) {
          mproperties.push({
            name: "oci:image:lastLayer:Env",
            value: env.join("\\n"),
          });
          // Does the image have any special packages that cdxgen cannot detect such as android-sdk and sdkman
          const evalue = env.join(":");
          if (
            evalue.includes("android-sdk") ||
            evalue.includes("commandlinetools")
          ) {
            mproperties.push({
              name: "oci:image:bundles:AndroidSdk",
              value: "true",
            });
          }
          // Track the use of special environment variables that could influence the search paths for libraries
          // This list was generated by repeatedly prompting ChatGPT with examples.
          // FIXME: Move these to a config file
          for (const senvValue of [
            "LD_LIBRARY_PATH",
            "DYLD_LIBRARY_PATH",
            "LD_PRELOAD",
            "PYTHONPATH",
            "CLASSPATH",
            "PERL5LIB",
            "PERLLIB",
            "RUBYLIB",
            "NODE_PATH",
            "LUA_PATH",
            "JULIA_LOAD_PATH",
            "R_LIBS",
            "R_LIBS_USER",
            "GEM_PATH",
            "DOTNET_ROOT",
            "DOTNET_ADDITIONAL_DEPS",
            "DOTNET_SHARED_STORE",
            "DOTNET_STARTUP_HOOKS",
            "DOTNET_BUNDLE_EXTRACT_BASE_DIR",
            "JAVA_OPTIONS",
            "JAVA_TOOL_OPTIONS",
            "NODE_OPTIONS",
            "PYTHONSTARTUP",
            "RUBYOPT",
            "WGETRC",
            "APT_CONFIG",
            "NPM_CONFIG_PREFIX",
            "NPM_CONFIG_REGISTRY",
            "YARN_CACHE_FOLDER",
            "PNPM_STORE_PATH",
            "PNPM_HOME",
            "PNPM_CONFIG_",
            "GIO_MODULE_DIR",
            "GST_PLUGIN_PATH",
            "GST_PLUGIN_SYSTEM_PATH",
            "APPDIR_LIBRARY_PATH", // appimage specific which gets prepended to LD_LIBRARY_PATH
          ]) {
            if (evalue.includes(senvValue)) {
              mproperties.push({
                name: `oci:image:env:${senvValue}`,
                value: "true",
              });
            }
          }
          // This value represents a filtered and expanded path
          if (options?.binPaths?.length) {
            mproperties.push({
              name: "oci:image:env:PATH",
              value: options.binPaths.join(":"),
            });
          }
          if (evalue.includes(".sdkman")) {
            mproperties.push({
              name: "oci:image:bundles:Sdkman",
              value: "true",
            });
          }
          if (evalue.includes(".nvm")) {
            mproperties.push({
              name: "oci:image:bundles:Nvm",
              value: "true",
            });
          }
          if (evalue.includes(".rbenv")) {
            mproperties.push({
              name: "oci:image:bundles:Rbenv",
              value: "true",
            });
          }
        }
        const ccmd =
          layerConfig?.config?.Cmd ||
          layerConfig?.Config?.Cmd ||
          layerConfig?.Config?.EntryPoint;
        if (ccmd) {
          if (Array.isArray(ccmd) && ccmd.length) {
            const fullCommand = ccmd.join(" ");
            mproperties.push({
              name: "oci:image:lastLayer:Cmd",
              value: fullCommand,
            });
            let appLanguage;
            // TODO: Move these lists to a config file.
            for (const lang of [
              "java",
              "node",
              "dotnet",
              "python",
              "python3",
              "ruby",
              "php",
              "php7",
              "php8",
              "perl",
            ]) {
              if (fullCommand.includes(`${lang} `)) {
                appLanguage = lang;
                break;
              }
            }
            if (appLanguage) {
              mproperties.push({
                name: "oci:image:appLanguage",
                value: appLanguage,
              });
            }
          } else {
            mproperties.push({
              name: "oci:image:lastLayer:Cmd",
              value: ccmd.toString(),
            });
          }
        }
      }
    }
    if (options.allOSComponentTypes?.length) {
      mproperties.push({
        name: "oci:image:componentTypes",
        value: options.allOSComponentTypes.sort().join("\\n"),
      });
    }
    if (Number.isInteger(options?.unpackagedExecutableCount)) {
      mproperties.push({
        name: "cdx:container:unpackagedExecutableCount",
        value: String(options.unpackagedExecutableCount),
      });
    }
    if (Number.isInteger(options?.unpackagedSharedLibraryCount)) {
      mproperties.push({
        name: "cdx:container:unpackagedSharedLibraryCount",
        value: String(options.unpackagedSharedLibraryCount),
      });
    }
    // Should we move these to formulation?
    if (options?.bundledSdks?.length) {
      for (const sdk of options.bundledSdks) {
        try {
          const purlObj = Purl.parse(sdk);
          const sdkName = purlObj.name.split("-")[0].toLowerCase();
          mproperties.push({
            name: `oci:image:bundles:${sdkName}Sdk`,
            value: "true",
          });
        } catch (_e) {
          // ignore
        }
      }
    }
    if (options?.bundledRuntimes?.length) {
      for (const runt of options.bundledRuntimes) {
        mproperties.push({
          name: `oci:image:bundles:${runt}Runtime`,
          value: "true",
        });
      }
    }
    // AI provenance/oversight detection (`-t ai-provenance`) is injected into the
    // BOM document root (bomJson.properties) after post-processing, not into
    // metadata.properties. See ensureAiProvenanceProperties/ensureAiOversightProperties.
    if (context?.metadataProperties?.length) {
      mproperties.push(...context.metadataProperties);
    }
    if (mproperties.length) {
      metadata.properties = mproperties;
    }
  }
  return metadata;
}

/**
 * Method to create external references
 *
 * @param {Array | Object} opkg
 * @returns {Array}
 */
export function addExternalReferences(opkg) {
  let externalReferences = [];
  let pkgList;
  if (Array.isArray(opkg)) {
    pkgList = opkg;
  } else {
    pkgList = [opkg];
  }
  for (const pkg of pkgList) {
    if (pkg.externalReferences) {
      externalReferences = externalReferences.concat(pkg.externalReferences);
    } else {
      if (pkg.homepage?.url) {
        externalReferences.push({
          type: pkg.homepage.url.includes("git") ? "vcs" : "website",
          url: pkg.homepage.url,
        });
      }
      if (pkg.bugs?.url) {
        externalReferences.push({
          type: "issue-tracker",
          url: pkg.bugs.url,
        });
      }
      if (pkg.repository?.url) {
        externalReferences.push({
          type: "vcs",
          url: pkg.repository.url,
        });
      }
      if (pkg.distribution?.url) {
        externalReferences.push({
          type: "distribution",
          url: pkg.distribution.url,
        });
      }
    }
  }
  return externalReferences
    .filter((reference) => typeof reference?.url === "string")
    .map((reference) => ({ ...reference, url: reference.url.trim() }))
    .filter((reference) => isValidIriReference(reference.url));
}

/**
 * For all modules in the specified package, creates a list of
 * component objects from each one.
 *
 * @param {Object} options CLI options
 * @param {Object} allImports All imports
 * @param {Object} pkg Package object
 * @param {string} ptype Package type
 * @returns {Object[]} Array of component objects
 */
export function listComponents(options, allImports, pkg, ptype = "npm") {
  const compMap = {};
  const isRootPkg = ptype === "npm";
  if (Array.isArray(pkg)) {
    pkg.forEach((p) => {
      addComponent(options, allImports, p, ptype, compMap, false);
    });
  } else {
    addComponent(options, allImports, pkg, ptype, compMap, isRootPkg);
  }

  return Object.keys(compMap).map((k) => compMap[k]);
}

/**
 * Component types that never receive an ecosystem purl.
 *
 * @type {string[]}
 */
// These component types do not have PURLs
export const NON_PURL_TYPES = ["cryptographic-asset", "file", "data"];

/**
 * Property-name prefix used to key npm bin-command import evidence
 * (`cdx:npm:bin/`).
 *
 * @type {string}
 */
export const NPM_BIN_IMPORT_PREFIX = "cdx:npm:bin/";

/**
 * Returns all non-empty property values for a given property name on a package.
 *
 * @param {object} pkg Package/component object with an optional `properties` array
 * @param {string} propertyName Property name to match
 * @returns {string[]} Matching property values as strings
 */
export function getPackagePropertyValues(pkg, propertyName) {
  if (!Array.isArray(pkg?.properties)) {
    return [];
  }
  return pkg.properties
    .filter((property) => property.name === propertyName && property.value)
    .map((property) => String(property.value));
}

/**
 * Splits a comma-separated property value into a trimmed, non-empty string array.
 *
 * @param {string} value Comma-separated value
 * @returns {string[]} Trimmed list entries
 */
export function splitPackagePropertyList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Collects the set of bin command names an npm package exposes, derived from
 * the `bin` field and the `cdx:npm:bin` / `cdx:npm:binPaths` properties.
 *
 * @param {object} pkg Package object
 * @returns {Set<string>} Bin command names
 */
export function getPackageBinCommandNames(pkg) {
  const binNames = new Set();
  if (pkg?.bin && typeof pkg.bin === "object") {
    for (const binName of Object.keys(pkg.bin)) {
      binNames.add(binName);
    }
  } else if (typeof pkg?.bin === "string") {
    binNames.add(pkg.name);
  }
  for (const binValue of getPackagePropertyValues(pkg, "cdx:npm:bin")) {
    for (const binName of splitPackagePropertyList(binValue)) {
      binNames.add(binName);
    }
  }
  for (const binPathValue of getPackagePropertyValues(
    pkg,
    "cdx:npm:binPaths",
  )) {
    for (const binPath of splitPackagePropertyList(binPathValue)) {
      const normalizedBinPath = binPath.replaceAll("\\", "/");
      const binName = normalizedBinPath.split("/").filter(Boolean).pop();
      if (binName) {
        binNames.add(binName);
      }
    }
  }
  return binNames;
}

/**
 * Checks whether any bin command of a package appears in the analyzer import
 * evidence (keyed under `cdx:npm:bin/`).
 *
 * @param {object} allImports Map of import names to usage counts
 * @param {object} pkg Package object
 * @returns {boolean} True when at least one bin command is imported
 */
export function hasNpmBinCommandEvidence(allImports, pkg) {
  const binCommandNames = getPackageBinCommandNames(pkg);
  if (!binCommandNames.size) {
    return false;
  }
  for (const importName of Object.keys(allImports || {})) {
    if (!importName.startsWith(NPM_BIN_IMPORT_PREFIX)) {
      continue;
    }
    const commandName = importName.slice(NPM_BIN_IMPORT_PREFIX.length);
    if (binCommandNames.has(commandName)) {
      return true;
    }
  }
  return false;
}

/**
 * Given the specified package, create a CycloneDX component and add it to the list.
 */
export function addComponent(
  options,
  allImports,
  pkg,
  ptype,
  compMap,
  isRootPkg = false,
) {
  if (!pkg || pkg.extraneous) {
    return;
  }
  if (!isRootPkg) {
    const pkgIdentifier = parsePackageJsonName(pkg.name);
    const author = pkg.author || undefined;
    const authors = pkg.authors || undefined;
    const publisher = pkg.publisher || undefined;
    let group = pkg.group || pkgIdentifier.scope;
    // Create empty group
    group = group || "";
    const name = pkgIdentifier.fullName || pkg.name || "";
    // name is mandatory
    if (!name) {
      return;
    }
    // Do we need this still?
    if (
      !ptype &&
      ["jar", "war", "ear", "pom"].includes(pkg?.qualifiers?.type)
    ) {
      ptype = "maven";
    }
    const version = pkg.version || "";
    const licenses = pkg.licenses || getLicenses(pkg);
    let purl = pkg.purl;
    if (!purl && ptype) {
      try {
        // Raw values: cdx-purl escapes each component itself, so escaping
        // them here first turned `@scope` into `%2540scope` and
        // `libstdc++6` into `libstdc%252B%252B6`.
        purl = new Purl({
          type: ptype,
          namespace: group || null,
          name,
          version: version || null,
          qualifiers: pkg.qualifiers || null,
          subpath: pkg.subpath || null,
        });
      } catch {
        // purl construction may fail for types requiring a namespace (maven,
        // swift) when the component has no group; fall through without a purl.
      }
    }
    let purlString = purl?.toString();
    // These types get no purl derived from the ecosystem being scanned, since a
    // file or a crypto asset is not a package of that ecosystem. A collector
    // that set a purl itself — file components carry `pkg:generic/...` — is
    // taken at its word.
    if (
      !pkg.purl &&
      (NON_PURL_TYPES.includes(ptype) || NON_PURL_TYPES.includes(pkg.type))
    ) {
      purl = undefined;
      purlString = undefined;
    }
    // Some applications like github workflow steps and commands do not have purl
    if (
      pkg.purl === undefined &&
      !pkg?.["bom-ref"]?.startsWith("pkg:") &&
      pkg?.type === "application"
    ) {
      purl = undefined;
      purlString = undefined;
    }
    const description = pkg.description || undefined;
    let compScope = pkg.scope;
    let isTypeOnlyPkg = false;
    if (allImports) {
      const impPkgs = Object.keys(allImports);
      const hasBinCommandEvidence = hasNpmBinCommandEvidence(allImports, pkg);
      if (
        impPkgs.includes(name) ||
        impPkgs.includes(`${group}/${name}`) ||
        impPkgs.includes(`@${group}/${name}`) ||
        (group.length > 0 && impPkgs.includes(group)) ||
        (group.length > 0 && impPkgs.includes(`@${group}`)) ||
        hasBinCommandEvidence
      ) {
        if (
          !hasBinCommandEvidence &&
          isPkgTypeOnlyImport(allImports, group, name)
        ) {
          compScope = "excluded";
          isTypeOnlyPkg = true;
        } else {
          compScope = "required";
        }
      }
      // A package missing from the imports keeps its scope. Usage analysis
      // only promotes: the ecosystem passes have already scoped the package
      // list, and a missing import is not evidence that a package is optional.
    }
    let component = {
      author,
      authors,
      publisher,
      group,
      name,
      version,
      description,
      scope: compScope,
      hashes: [],
      licenses,
      purl: purlString,
      externalReferences: addExternalReferences(pkg),
    };
    // A CPE from the collector (caxa records one for the bundled Node.js
    // runtime) is how NVD-based scanners match the component.
    if (typeof pkg.cpe === "string" && pkg.cpe.length) {
      component.cpe = pkg.cpe;
    }
    if (options.specVersion >= 1.5) {
      component.pedigree = pkg.pedigree || undefined;
    }
    if (options.specVersion >= 1.6) {
      component.releaseNotes = pkg.releaseNotes || undefined;
      component.modelCard = pkg.modelCard || undefined;
      component.data = pkg.data || undefined;
    }
    if (options.specVersion >= 1.7) {
      // An external component is provided by the deployment environment rather
      // than bundled with the product. The schema defaults it to false, so it
      // is only worth emitting when true.
      component.isExternal = pkg.isExternal ? true : undefined;
      // A range describes an external dependency named without a resolved
      // version, such as the Ruby a gem requires. The schema allows it only
      // on an external component, and never next to a version.
      component.versionRange =
        pkg.isExternal && !pkg.version
          ? pkg.versionRange || undefined
          : undefined;
    }
    component["type"] = determinePackageType(pkg);
    // `version` is optional in every spec version cdxgen emits. An empty string
    // is not a version, and a consumer reading one has to guess whether it means
    // "unknown" or "the empty release"; leaving the field out says it plainly.
    if (!component.version) {
      delete component.version;
    }
    if (pkg["bom-ref"]) {
      component["bom-ref"] = pkg["bom-ref"];
    } else if (purlString) {
      component["bom-ref"] = decodeURIComponent(purlString);
    }

    if (
      component.externalReferences === undefined ||
      component.externalReferences.length === 0
    ) {
      delete component.externalReferences;
    }
    if (options.specVersion < 1.6) {
      delete component.omniborId;
      delete component.swhid;
    }
    processHashes(pkg, component);
    // Upgrade authors section
    if (options.specVersion >= 1.6 && component.author) {
      const authorsList = [];
      for (const aauthor of component.author.split(",")) {
        // Registries hand out comma separated lists without a consistent
        // spacing, so `A, B` and `A,B` must produce the same names
        const name = aauthor.trim();
        if (name.length) {
          authorsList.push({ name });
        }
      }
      if (authorsList.length) {
        component.authors = authorsList;
      }
      delete component.author;
    }
    // Downgrade authors section for < 1.5 :(
    if (options.specVersion < 1.6) {
      if (component?.authors?.length) {
        component.author = component.authors
          .map((a) => (a.email ? `${a.name} <${a.email}>` : a.name))
          .join(",");
      }
      delete component.authors;
    }
    // Downgrade from 1.7
    if (options.specVersion < 1.7) {
      if (component.isExternal) {
        delete component.isExternal;
      }
      if (component.versionRange) {
        console.warn(
          `Version Range is not supported in ${options.specVersion} specifications. Please run cdxgen with --spec-version 1.7`,
        );
        delete component.versionRange;
      }
    }
    // Retain any tags
    if (
      options.specVersion >= 1.6 &&
      pkg.tags &&
      Object.keys(pkg.tags).length
    ) {
      component.tags = pkg.tags;
    }
    // Retain any component properties and crypto properties
    if (pkg.properties?.length) {
      component.properties = pkg.properties;
    }
    setNpmCleanedVersionProperty(component);
    if (isTypeOnlyPkg) {
      component.properties = component.properties || [];
      if (
        !component.properties.some(
          (p) => p.name === "cdx:npm:package:type-only",
        )
      ) {
        component.properties.push({
          name: "cdx:npm:package:type-only",
          value: "true",
        });
      }
    }
    if (pkg.cryptoProperties && typeof pkg.cryptoProperties === "object") {
      component.cryptoProperties = pkg.cryptoProperties;
    }
    // Retain nested components
    if (pkg.components) {
      component.components = pkg.components;
    }
    component = enrichComponentWithMcpMetadata(component);
    const compMapKey = component.purl || component["bom-ref"];
    // Issue: 1353. We need to keep merging the properties
    if (compMap[compMapKey]) {
      const mergedComponents = trimComponents([compMap[compMapKey], component]);
      if (mergedComponents?.length === 1) {
        component = mergedComponents[0];
      }
    }
    // Retain evidence
    if (
      options.specVersion >= 1.5 &&
      pkg.evidence &&
      Object.keys(pkg.evidence).length
    ) {
      component.evidence = pkg.evidence;
      // Convert evidence.identity section to an array for 1.6 and above
      if (
        options.specVersion >= 1.6 &&
        pkg.evidence &&
        pkg.evidence.identity &&
        !Array.isArray(pkg.evidence.identity)
      ) {
        // Automatically add concludedValue
        if (pkg.evidence.identity?.methods?.length === 1) {
          pkg.evidence.identity.concludedValue =
            pkg.evidence.identity.methods[0].value;
        }
        component.evidence.identity = [pkg.evidence.identity];
      }
      // Convert evidence.identity section to an object for 1.5
      if (
        options.specVersion === 1.5 &&
        pkg.evidence &&
        pkg.evidence.identity &&
        Array.isArray(pkg.evidence.identity)
      ) {
        component.evidence.identity = pkg.evidence.identity[0];
      }
    }
    compMap[compMapKey] = component;
  }
  if (pkg.dependencies) {
    Object.keys(pkg.dependencies)
      .map((x) => pkg.dependencies[x])
      .filter((x) => typeof x !== "string") //remove cycles
      .map((x) => addComponent(options, allImports, x, ptype, compMap, false));
  }
}

/**
 * If the author has described the module as a 'framework', the take their
 * word for it, otherwise, identify the module as a 'library'.
 */
export function determinePackageType(pkg) {
  // Retain the exact component type in certain cases.
  if (
    [
      "container",
      "platform",
      "operating-system",
      "device",
      "device-driver",
      "firmware",
      "file",
      "machine-learning-model",
      "data",
      "cryptographic-asset",
    ].includes(pkg.type)
  ) {
    return pkg.type;
  }
  if (pkg.type === "application") {
    if (pkg?.name?.endsWith(".tar")) {
      return "container";
    }
    return pkg.type;
  }
  if (pkg.purl) {
    try {
      const purl = Purl.parse(pkg.purl);
      if (purl.type) {
        if (["docker", "oci", "container"].includes(purl.type)) {
          return "container";
        }
        if (["github"].includes(purl.type)) {
          return "application";
        }
      }
      // See #1760
      if (
        purl.namespace?.startsWith("@types") ||
        (purl.namespace?.includes("-types") && pkg?.type === "npm")
      ) {
        return "library";
      }
      // A gem is a framework only when the curated list names that very gem:
      // the prefix matches below took rails-html-sanitizer and sinatra-contrib
      // for their frameworks, and the bare words meant for other ecosystems
      // turned childprocess ("chi") and jquery-rails ("jquery") into
      // frameworks. Any other gem is a library, unless it ships executables,
      // which makes it an application (discussions 4405 and 4408). A
      // description or keyword that merely mentions a framework is no evidence
      // of one: every gem whose summary says "tracing framework" would
      // otherwise become a framework component.
      if (purl.type === "gem") {
        if (frameworksList.all.includes(`pkg:gem/${purl.name}`)) {
          return "framework";
        }
        const hasExecutables = pkg.properties?.some(
          (prop) =>
            prop.name === "cdx:gem:executables" && prop.value?.trim().length,
        );
        return hasExecutables ? "application" : "library";
      }
      for (const cf of frameworksList.all) {
        if (
          pkg.purl.startsWith(cf) ||
          purl.namespace?.includes(cf) ||
          purl.name.toLowerCase().startsWith(cf)
        ) {
          return "framework";
        }
      }
    } catch (_e) {
      // continue regardless of error
    }
  } else if (pkg.group) {
    if (["actions"].includes(pkg.group)) {
      return "application";
    }
  }
  if (Object.hasOwn(pkg, "description")) {
    if (pkg.description?.toLowerCase().includes("framework")) {
      return "framework";
    }
  }
  if (Object.hasOwn(pkg, "keywords")) {
    for (const keyword of pkg.keywords) {
      if (keyword && keyword.toLowerCase() === "framework") {
        return "framework";
      }
    }
  }
  if (Object.hasOwn(pkg, "tags")) {
    for (const tag of pkg.tags) {
      if (tag && tag.toLowerCase() === "framework") {
        return "framework";
      }
    }
  }
  return "library";
}

/**
 * Uses the SHA1 shasum (if present) otherwise utilizes Subresource Integrity
 * of the package with support for multiple hashing algorithms.
 */
export function processHashes(pkg, component) {
  if (pkg.hashes) {
    // This attribute would be available when we read a bom json directly
    // Eg: cyclonedx-maven-plugin. See: Bugs: #172, #175
    for (const ahash of pkg.hashes) {
      addComponentHash(ahash.alg, ahash.content, component);
    }
  } else if (pkg._shasum) {
    addComponentHash("SHA-1", pkg._shasum, component);
  } else if (pkg._integrity) {
    const integrity = parse(pkg._integrity) || {};
    // Components may have multiple hashes with various lengths. Check each one
    // that is supported by the CycloneDX specification.
    if (Object.hasOwn(integrity, "sha512")) {
      addComponentHash("SHA-512", integrity.sha512[0].digest, component);
    }
    if (Object.hasOwn(integrity, "sha384")) {
      addComponentHash("SHA-384", integrity.sha384[0].digest, component);
    }
    if (Object.hasOwn(integrity, "sha256")) {
      addComponentHash("SHA-256", integrity.sha256[0].digest, component);
    }
    if (Object.hasOwn(integrity, "sha1")) {
      addComponentHash("SHA-1", integrity.sha1[0].digest, component);
    }
  }
  if (component.hashes.length === 0) {
    delete component.hashes; // If no hashes exist, delete the hashes node (it's optional)
  }
}

// Digest length in hex characters for each algorithm CycloneDX names. A digest
// that decodes to the wrong length for its algorithm is corrupt, whatever
// encoding it arrived in.
const HASH_HEX_LENGTHS = {
  MD5: 32,
  "SHA-1": 40,
  "SHA-256": 64,
  "SHA-384": 96,
  "SHA-512": 128,
  "SHA3-256": 64,
  "SHA3-384": 96,
  "SHA3-512": 128,
  "BLAKE2b-256": 64,
  "BLAKE2b-384": 96,
  "BLAKE2b-512": 128,
};

// Lengths the CycloneDX hash-content pattern accepts, for algorithms not in the
// table above.
const HASH_HEX_LENGTHS_ANY = new Set([32, 40, 64, 96, 128]);

/**
 * Adds a hash to component.
 *
 * Registries hand out digests in hex or in the base64 form npm uses for
 * `integrity`, and both are accepted. A digest that is neither, or that decodes
 * to the wrong length for its algorithm, is dropped rather than copied through:
 * CycloneDX constrains `hash.content` to a hex digest, so emitting it anyway
 * fails schema validation for the whole document over one bad package.
 */
export function addComponentHash(alg, digest, component) {
  const hash = normalizeHashContent(alg, digest);
  if (!hash) {
    return;
  }
  component.hashes.push({ alg: alg, content: hash });
}

/**
 * Normalize a digest to the lower-case hex form CycloneDX requires.
 *
 * @param {string} alg Hash algorithm name
 * @param {string} digest Digest in hex or base64
 * @returns {string|undefined} Hex digest, or undefined when it cannot be trusted
 */
export function normalizeHashContent(alg, digest) {
  if (!digest || typeof digest !== "string") {
    return undefined;
  }
  const expectedLength = HASH_HEX_LENGTHS[alg];
  const isExpectedLength = (value) =>
    expectedLength
      ? value.length === expectedLength
      : HASH_HEX_LENGTHS_ANY.has(value.length);

  if (new RegExp(HASH_PATTERN).test(digest)) {
    return isExpectedLength(digest) ? digest : undefined;
  }
  // npm and friends carry the digest base64-encoded. Node decodes leniently, so
  // the decoded length is the check that matters: a truncated or invented value
  // decodes to something, just not to a digest of the right size.
  const decoded = Buffer.from(digest, "base64").toString("hex");
  return isExpectedLength(decoded) ? decoded : undefined;
}

/**
 * Return the BOM in json format including any namespace mapping
 *
 * @param {Object} options Options
 * @param {Object} pkgInfo Package information
 * @param {string} ptype Package type
 * @param {Object} context Context
 *
 * @returns {Object} BOM with namespace mapping
 */
export const buildBomNSData = (options, pkgInfo, ptype, context) => {
  // Many create*Bom call sites provide only a source directory (`src`) when
  // there is no single manifest/lock file to report, so activity records must
  // fall back to that directory to keep the target populated.
  const sourcePath =
    context?.srcDir || context?.src || options.path || options.filePath;
  const activityProjectType =
    context?.projectType ||
    (Array.isArray(options.projectType)
      ? options.projectType.length === 1
        ? options.projectType[0]
        : undefined
      : options.projectType);
  setActivityContext({
    packageType: ptype,
    sourcePath,
    ...(activityProjectType ? { projectType: activityProjectType } : {}),
  });
  const bomNSData = {
    bomJson: undefined,
    bomJsonFiles: undefined,
    nsMapping: undefined,
    dependencies: undefined,
    parentComponent: undefined,
  };
  const serialNum = `urn:uuid:${uuidv4()}`;
  let allImports = {};
  if (context?.allImports) {
    allImports = context.allImports;
  }
  const nsMapping = context.nsMapping || {};
  const services = context.services || [];
  let overrideParent = determineParentComponent(options);
  // A caller-supplied parentComponent is always honoured as given
  if (
    overrideParent !== options.parentComponent &&
    overrideNamesDetectedParent(overrideParent, context.parentComponent)
  ) {
    overrideParent = undefined;
  }
  const parentComponent = overrideParent || context.parentComponent;
  const metadata = addMetadata(parentComponent, options, context);
  const components = listComponents(options, allImports, pkgInfo, ptype);
  const dependencies = anchorDetectedParent(
    overrideParent,
    context.parentComponent,
    components,
    context.dependencies || [],
    options,
    ptype,
  );
  if (
    components &&
    (components.length ||
      parentComponent ||
      options.projectType?.includes("dynamic") ||
      options.projectType?.includes("ai-provenance"))
  ) {
    // CycloneDX Json Template
    const jsonTpl = {
      bomFormat: "CycloneDX",
      specVersion: toCycloneDxSpecVersionString(
        options.specVersion || DEFAULT_CDX_SPEC_VERSION,
      ),
      serialNumber: serialNum,
      version: 1,
      metadata: metadata,
      components,
      dependencies,
    };
    setCycloneDxFormat(jsonTpl, jsonTpl.specVersion, {
      preserveLegacyBomFormat: true,
    });
    if (services.length) {
      jsonTpl.services = mergeServices([], services);
    }
    bomNSData.bomJson = jsonTpl;
    bomNSData.nsMapping = nsMapping;
    bomNSData.dependencies = dependencies;
    bomNSData.parentComponent = parentComponent;
    // Carry language-specific formulation data (e.g. Pixi) so that
    // postProcess can merge it when building the final formulation section.
    if (context?.formulationList?.length) {
      bomNSData.formulationList = context.formulationList;
    }
    // createMultiXBom rebuilds the metadata block, so these are handed on.
    if (context?.metadataProperties?.length) {
      bomNSData.metadataProperties = context.metadataProperties;
    }
    // Carry language-specific provenance citations (e.g. PEP 770 embedded
    // SBOMs) so postProcess can attach them in the single root-level citations
    // section it builds.
    if (Array.isArray(context?.citations) && context.citations.length) {
      bomNSData.citations = context.citations;
    }
  }
  recordActivity({
    kind: "read",
    reason: `Collected ${ptype || "generic"} component metadata.`,
    status: components?.length || parentComponent ? "completed" : "failed",
    target: context?.filename || sourcePath,
  });
  resetActivityContext();
  return bomNSData;
};

/**
 * Function to create bom string for Android apps using blint
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Object|undefined} BOM object
 */
export function createAndroidBom(path, options) {
  return createBinaryBom(path, options);
}

/**
 * Escape the purls of a blint BOM and carry the change through its graph.
 *
 * blint composes purls by string interpolation, so a name holding a character
 * a purl reserves — `libstdc++.so.6` and its kin — arrives unescaped. blint
 * also uses the purl as the bom-ref, so every ref that quoted the old string,
 * in `dependencies` and in the parent component alike, moves with it.
 *
 * @param {Object} binaryBom BOM read from blint, rewritten in place
 */
function repairBinaryBomPurls(binaryBom) {
  const renamed = new Map();
  const repair = (component) => {
    const before = component?.purl;
    if (!before) {
      return;
    }
    repairPurl(component);
    if (component.purl === before) {
      return;
    }
    renamed.set(before, component.purl);
    if (component["bom-ref"] === before) {
      component["bom-ref"] = component.purl;
    }
  };
  for (const component of binaryBom?.components || []) {
    repair(component);
  }
  repair(binaryBom?.parentComponent);
  repair(binaryBom?.metadata?.component);
  if (!renamed.size) {
    return;
  }
  const rename = (ref) => renamed.get(ref) || ref;
  for (const dependency of binaryBom?.dependencies || []) {
    if (dependency?.ref) {
      dependency.ref = rename(dependency.ref);
    }
    for (const key of ["dependsOn", "provides"]) {
      if (Array.isArray(dependency?.[key])) {
        dependency[key] = dependency[key].map(rename);
      }
    }
  }
}

/**
 * Function to create bom string for binaries using blint
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Object|undefined} BOM object
 */
export function createBinaryBom(path, options) {
  const tempDir = safeMkdtempSync(join(getTmpDir(), "blint-tmp-"));
  const binaryBomFile = join(tempDir, "bom.json");
  getBinaryBom(path, binaryBomFile, options.deep);
  if (safeExistsSync(binaryBomFile)) {
    const binaryBom = JSON.parse(
      readFileSync(binaryBomFile, { encoding: "utf-8" }),
    );
    repairBinaryBomPurls(binaryBom);
    attachIdentityTools(
      binaryBom?.components,
      extractToolRefs(
        binaryBom?.metadata?.tools,
        (tool) => tool?.name !== "cdxgen",
      ),
    );
    return {
      bomJson: binaryBom,
      dependencies: binaryBom.dependencies,
      parentComponent: binaryBom.parentComponent,
    };
  }
  return undefined;
}

/**
 * Identify the requested AI inventory project types.
 *
 * @param {Object} options Parse options from the cli
 * @returns {string[]} Requested AI inventory types
 */
export function getRequestedAiInventoryTypes(options) {
  return AI_INVENTORY_PROJECT_TYPES.filter((type) =>
    optionIncludesAiInventoryProjectType(options?.projectType, type),
  );
}

/**
 * Returns the AI inventory types excluded via `--exclude-type`.
 *
 * @param {object} options CLI options
 * @returns {string[]} Excluded AI inventory types
 */
export function getExcludedAiInventoryTypes(options) {
  return AI_INVENTORY_PROJECT_TYPES.filter((type) =>
    optionIncludesAiInventoryProjectType(options?.excludeType, type),
  );
}

/**
 * Removes the excluded AI inventory types from the included list.
 *
 * @param {string[]} includedAiInventoryTypes Types selected for collection
 * @param {string[]} excludedAiInventoryTypes Types excluded by the user
 * @returns {string[]} Filtered list of AI inventory types
 */
export function filterIncludedAiInventoryTypes(
  includedAiInventoryTypes,
  excludedAiInventoryTypes,
) {
  return [...new Set(includedAiInventoryTypes)].filter(
    (type) => !excludedAiInventoryTypes.includes(type),
  );
}

/**
 * Determine which AI inventory types should be collected for a scan.
 *
 * This combines explicit project-type opt-ins with BOM audit category-driven
 * opt-ins, then removes any explicitly excluded inventory types.
 *
 * @param {Object} options Parse options from the CLI
 * @returns {string[]} AI inventory types to collect
 */
export function getIncludedAiInventoryTypes(options) {
  const requestedAiInventoryTypes = getRequestedAiInventoryTypes(options);
  const excludedAiInventoryTypes = getExcludedAiInventoryTypes(options);
  const exactAiInventoryType = getExactAiInventoryType(options);
  if (exactAiInventoryType) {
    return filterIncludedAiInventoryTypes(
      requestedAiInventoryTypes,
      excludedAiInventoryTypes,
    );
  }
  const auditCategories = expandBomAuditCategories(options?.bomAuditCategories);
  const includedAiInventoryTypes = [...requestedAiInventoryTypes];
  if (auditCategories.includes("ai-agent")) {
    includedAiInventoryTypes.push("ai-skill");
    includedAiInventoryTypes.push("ai");
  }
  if (auditCategories.includes("mcp-server")) {
    includedAiInventoryTypes.push("mcp");
  }
  return filterIncludedAiInventoryTypes(
    includedAiInventoryTypes,
    excludedAiInventoryTypes,
  );
}

/**
 * Returns the single AI inventory type when exactly one project type alias is
 * selected, otherwise undefined.
 *
 * @param {object} options CLI options
 * @returns {string|undefined} The exact AI inventory type or undefined
 */
export function getExactAiInventoryType(options) {
  const requestedAiInventoryTypes = getRequestedAiInventoryTypes(options);
  return requestedAiInventoryTypes.length === 1 &&
    Array.isArray(options?.projectType) &&
    options.projectType.length === 1
    ? requestedAiInventoryTypes[0]
    : undefined;
}

/**
 * Determine whether MCP source-code analysis should run for the current scan.
 *
 * @param {string[]} includedAiInventoryTypes AI inventory types selected for collection
 * @returns {boolean} True when MCP inventory collection is enabled
 */
export function shouldDetectMcpInventory(includedAiInventoryTypes) {
  return includedAiInventoryTypes.includes("mcp");
}

/**
 * Collects sorted, unique relative file names for AI inventory subjects whose
 * `cdx:file:kind` property matches one of the given kinds.
 *
 * @param {object[]} subjects Component or service subjects to inspect
 * @param {string} discoveryPath Base path used to compute relative file names
 * @param {Set<string>} kindSet Accepted kind values
 * @returns {string[]} Sorted unique relative file names
 */
export function summarizeAiInventoryNames(subjects, discoveryPath, kindSet) {
  return [
    ...new Set(
      (subjects || [])
        .filter((subject) =>
          kindSet.has(inventoryPropertyValue(subject, "cdx:file:kind")),
        )
        .map((subject) => inventoryPropertyValue(subject, "internal:SrcFile"))
        .filter(Boolean)
        .map(
          (filePath) => relative(discoveryPath, filePath) || basename(filePath),
        ),
    ),
  ].sort();
}

/**
 * Collects sorted unique service names from an AI inventory services list.
 *
 * @param {object[]} services Services with a `name` property
 * @returns {string[]} Sorted unique service names
 */
export function summarizeAiInventoryServiceNames(services) {
  return [
    ...new Set(
      (services || []).map((service) => service?.name).filter(Boolean),
    ),
  ].sort();
}

/**
 * Formats one padded summary line for the AI inventory console output.
 *
 * @param {string} label Left-aligned label (padded to 20 chars)
 * @param {number} count Item count
 * @param {string[]} nameList Optional list of names to append in parentheses
 * @returns {string} The formatted summary line
 */
export function formatAiInventorySummaryLine(label, count, nameList) {
  return `  ${label.padEnd(20)} ${count}${nameList.length ? ` (${nameList.join(", ")})` : ""}`;
}

/**
 * Prints a human-readable AI inventory summary to stderr, including counts and
 * names for instruction files, skill files, MCP configs, and MCP services.
 * Returns without printing when the inventory is empty.
 *
 * @param {object} aiInventory AI inventory object with components and services
 * @param {string} discoveryPath Base path used to compute relative file names
 * @returns {void}
 */
export function emitAiInventorySummary(aiInventory, discoveryPath) {
  const summary = summarizeAiInventory(aiInventory);
  const totalInventory =
    summary.instructionCount +
    summary.skillCount +
    summary.mcpConfigCount +
    summary.mcpServiceCount;
  if (!totalInventory) {
    return;
  }
  const instructionNames = summarizeAiInventoryNames(
    aiInventory.components,
    discoveryPath,
    AI_INSTRUCTION_FILE_KINDS,
  );
  const skillNames = summarizeAiInventoryNames(
    aiInventory.components,
    discoveryPath,
    new Set([AI_SKILL_FILE_KIND]),
  );
  const mcpConfigNames = summarizeAiInventoryNames(
    aiInventory.components,
    discoveryPath,
    new Set([MCP_CONFIG_FILE_KIND]),
  );
  const mcpServiceNames = summarizeAiInventoryServiceNames(
    aiInventory.services,
  );
  console.warn(
    [
      "AI Inventory Summary:",
      formatAiInventorySummaryLine(
        "AI instruction files:",
        summary.instructionCount,
        instructionNames,
      ),
      formatAiInventorySummaryLine(
        "Skill files:",
        summary.skillCount,
        skillNames,
      ),
      formatAiInventorySummaryLine(
        "MCP configs:",
        summary.mcpConfigCount,
        mcpConfigNames,
      ),
      formatAiInventorySummaryLine(
        "MCP services:",
        summary.mcpServiceCount,
        mcpServiceNames,
      ),
      "",
      "Run --bom-audit --bom-audit-categories ai-inventory to audit these surfaces.",
    ].join("\n"),
  );
}

/**
 * Dedupe components
 *
 * @param {Object} options Options
 * @param {Array} components Components
 * @param {Object} parentComponent Parent component
 * @param {Array} dependencies Dependencies
 * @param {Array} [metadataProperties] Properties for the metadata block, from
 *   generators whose manifest has no component to carry them
 *
 * @returns {Object} Object including BOM Json
 */
export function dedupeBom(
  options,
  components,
  parentComponent,
  dependencies,
  metadataProperties = [],
) {
  if (!components) {
    return {};
  }
  if (!dependencies) {
    dependencies = [];
  }
  // Certificate components from different producers (trustinspector rootfs,
  // the source-directory scan, observed chains) share a bom-ref; merge their
  // occurrences and properties before the generic trim.
  components = mergeDuplicateCryptoComponents(components);
  components = trimComponents(components);
  // Let's apply some common tweaks
  // Convert evidence.identity section to an object for 1.5
  if (options.specVersion === 1.5) {
    for (const comp of components) {
      if (comp?.evidence?.identity && Array.isArray(comp.evidence.identity)) {
        comp.evidence.identity = comp.evidence.identity[0];
        delete comp.evidence.identity.concludedValue;
      }
    }
  }
  if (DEBUG_MODE) {
    console.log(
      `Obtained ${components.length} components and ${dependencies.length} dependencies after dedupe.`,
    );
  }
  const serialNum = `urn:uuid:${uuidv4()}`;
  return {
    options,
    parentComponent,
    components,
    bomJson: setCycloneDxFormat(
      {
        specVersion: toCycloneDxSpecVersionString(
          options.specVersion || DEFAULT_CDX_SPEC_VERSION,
        ),
        serialNumber: serialNum,
        version: 1,
        metadata: addMetadata(parentComponent, options, { metadataProperties }),
        components,
        services: options.services || [],
        dependencies,
      },
      options.specVersion || DEFAULT_CDX_SPEC_VERSION,
      { preserveLegacyBomFormat: true },
    ),
  };
}

/**
 * Checks whether the user explicitly selected a project type alias that
 * belongs to the given base project type.
 *
 * @param {object} options CLI options
 * @param {string} baseProjectType Base project type to check against
 * @returns {boolean} True when an explicit alias selection matches
 */
export const hasExplicitProjectTypeSelection = (options, baseProjectType) => {
  options = options || {};
  const projectTypes = Array.isArray(options.projectType)
    ? options.projectType
    : options.projectType
      ? [options.projectType]
      : [];
  return projectTypes.some((selectedProjectType) =>
    PROJECT_TYPE_ALIASES[baseProjectType]?.includes(selectedProjectType),
  );
};
