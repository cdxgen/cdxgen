import { Buffer } from "node:buffer";
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { platform as _platform, arch, homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import process from "node:process";

import got from "got";
import { PackageURL } from "packageurl-js";
import { gte, lte } from "semver";
import { parse } from "ssri";
import { table } from "table";
import { v4 as uuidv4 } from "uuid";
import { parse as loadYaml } from "yaml";

import { findJSImportsExports } from "../helpers/analyzer.js";
import { collectOSCryptoLibs } from "../helpers/cbomutils.js";
import {
  collectEnvInfo,
  getBranch,
  getOriginUrl,
  gitTreeHashes,
  listFiles,
} from "../helpers/envcontext.js";
import { thoughtLog } from "../helpers/logger.js";
import {
  addEvidenceForDotnet,
  addEvidenceForImports,
  addPlugin,
  buildGradleCommandArguments,
  buildObjectForCocoaPod,
  buildObjectForGradleModule,
  CARGO_CMD,
  CDXGEN_VERSION,
  CLJ_CMD,
  checksumFile,
  cleanupPlugin,
  collectGemModuleNames,
  collectGradleDependencies,
  collectJarNS,
  collectMvnDependencies,
  convertJarNSToPackages,
  convertOSQueryResults,
  createNpmWorkspacePurl,
  createUVLock,
  DEBUG_MODE,
  determineSbtVersion,
  dirNameStr,
  encodeForPurl,
  executeParallelGradleProperties,
  executePodCommand,
  extractJarArchive,
  frameworksList,
  generatePixiLockFile,
  getAllFiles,
  getCppModules,
  getGradleCommand,
  getLicenses,
  getMavenCommand,
  getMillCommand,
  getMvnMetadata,
  getNugetMetadata,
  getPipFrozenTree,
  getPipTreeForPackages,
  getPyMetadata,
  getPyModules,
  getSwiftPackageMetadata,
  getTimestamp,
  getTmpDir,
  hasAnyProjectType,
  includeMavenTestScope,
  isFeatureEnabled,
  isMac,
  isPackageManagerAllowed,
  isPartialTree,
  isSecureMode,
  isValidIriReference,
  LEIN_CMD,
  MAX_BUFFER,
  PREFER_MAVEN_DEPS_TREE,
  PROJECT_TYPE_ALIASES,
  parseBazelActionGraph,
  parseBazelSkyframe,
  parseBdistMetadata,
  parseBitbucketPipelinesFile,
  parseBowerJson,
  parseCabalData,
  parseCargoData,
  parseCargoDependencyData,
  parseCargoTomlData,
  parseCljDep,
  parseCloudBuildData,
  parseCmakeLikeFile,
  parseCocoaDependency,
  parseComposerJson,
  parseComposerLock,
  parseConanData,
  parseConanLockData,
  parseContainerFile,
  parseContainerSpecData,
  parseCsPkgData,
  parseCsPkgLockData,
  parseCsProjAssetsData,
  parseCsProjData,
  parseEdnData,
  parseFlakeLock,
  parseFlakeNix,
  parseGemfileLockData,
  parseGemspecData,
  parseGitHubWorkflowData,
  parseGoListDep,
  parseGoModData,
  parseGoModGraph,
  parseGoModulesTxt,
  parseGoModWhy,
  parseGopkgData,
  parseGosumData,
  parseGradleDep,
  parseGradleProperties,
  parseHelmYamlData,
  parseLeinDep,
  parseLeiningenData,
  parseMakeDFile,
  parseMavenTree,
  parseMillDependency,
  parseMinJs,
  parseMixLockData,
  parseNodeShrinkwrap,
  parseNupkg,
  parseOpenapiSpecData,
  parsePackageJsonName,
  parsePaketLockData,
  parsePiplockData,
  parsePixiLockFile,
  parsePixiTomlFile,
  parsePkgJson,
  parsePkgLock,
  parsePnpmLock,
  parsePnpmWorkspace,
  parsePodfileLock,
  parsePodfileTargets,
  parsePom,
  parsePrivadoFile,
  parsePubLockData,
  parsePubYamlData,
  parsePyLockData,
  parsePyProjectTomlFile,
  parseReqFile,
  parseSbtLock,
  parseSbtTree,
  parseSetupPyFile,
  parseSwiftJsonTree,
  parseSwiftResolved,
  parseYarnLock,
  parseYarnWorkspace,
  readZipEntry,
  recomputeScope,
  SWIFT_CMD,
  safeExistsSync,
  safeMkdirSync,
  safeSpawnSync,
  shouldFetchLicense,
  splitOutputByGradleProjects,
} from "../helpers/utils.js";
import {
  executeOsQuery,
  getBinaryBom,
  getDotnetSlices,
  getOSPackages,
} from "../managers/binary.js";
import {
  addSkippedSrcFiles,
  exportArchive,
  exportImage,
  getPkgPathList,
  parseImageName,
} from "../managers/docker.js";

const dirName = dirNameStr;

const isWin = _platform() === "win32";

let osQueries = {};
switch (_platform()) {
  case "win32":
    osQueries = JSON.parse(
      readFileSync(join(dirName, "data", "queries-win.json"), "utf-8"),
    );
    break;
  case "darwin":
    osQueries = JSON.parse(
      readFileSync(join(dirName, "data", "queries-darwin.json"), "utf-8"),
    );
    break;
  default:
    osQueries = JSON.parse(
      readFileSync(join(dirName, "data", "queries.json"), "utf-8"),
    );
    break;
}
const cosDbQueries = JSON.parse(
  readFileSync(join(dirName, "data", "cosdb-queries.json"), "utf-8"),
);

// Construct gradle cache directory
let GRADLE_CACHE_DIR =
  process.env.GRADLE_CACHE_DIR ||
  join(homedir(), ".gradle", "caches", "modules-2", "files-2.1");
if (process.env.GRADLE_USER_HOME) {
  GRADLE_CACHE_DIR = join(
    process.env.GRADLE_USER_HOME,
    "caches",
    "modules-2",
    "files-2.1",
  );
}

// Construct path to gradle init script
const GRADLE_INIT_SCRIPT = resolve(
  dirNameStr,
  "data",
  "helpers",
  "init.gradle",
);

// Construct sbt cache directory
const SBT_CACHE_DIR =
  process.env.SBT_CACHE_DIR || join(homedir(), ".ivy2", "cache");

// CycloneDX Hash pattern
const HASH_PATTERN =
  "^([a-fA-F0-9]{32}|[a-fA-F0-9]{40}|[a-fA-F0-9]{64}|[a-fA-F0-9]{96}|[a-fA-F0-9]{128})$";

/**
 * Creates a default parent component based on the directory name.
 *
 * @param {String} path Directory or file name
 * @param {String} type Package type
 * @param {Object} options CLI options
 * @returns component object
 */
const createDefaultParentComponent = (
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
    version: `${options.projectVersion}` || "latest",
    type: compName.endsWith(".tar") ? "container" : "application",
  };
  const ppurl = new PackageURL(
    type,
    parentComponent.group,
    parentComponent.name,
    parentComponent.version,
    null,
    null,
  ).toString();
  parentComponent["bom-ref"] = decodeURIComponent(ppurl);
  parentComponent["purl"] = ppurl;
  return parentComponent;
};

const determineParentComponent = (options) => {
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
    const ppurl = new PackageURL(
      parentComponent.type,
      parentComponent.group,
      parentComponent.name,
      parentComponent.version,
      null,
      null,
    ).toString();
    parentComponent["bom-ref"] = decodeURIComponent(ppurl);
    parentComponent["purl"] = ppurl;
  }
  return parentComponent;
};

const addToolsSection = (options, context = {}) => {
  if (options.specVersion === 1.4) {
    return [
      {
        vendor: "cyclonedx",
        name: "cdxgen",
        version: CDXGEN_VERSION,
      },
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
  const cdxToolComponent = {
    group: "@cyclonedx",
    name: "cdxgen",
    version: CDXGEN_VERSION,
    purl: `pkg:npm/%40cyclonedx/cdxgen@${CDXGEN_VERSION}`,
    type: "application",
    "bom-ref": `pkg:npm/@cyclonedx/cdxgen@${CDXGEN_VERSION}`,
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

const componentToSimpleFullName = (comp) => {
  let fullName = comp.group?.length ? `${comp.group}/${comp.name}` : comp.name;
  if (comp.version?.length) {
    fullName = `${fullName}@${comp.version}`;
  }
  return fullName;
};

// Remove unwanted properties from parent component
// Bug #1519 - Retain licenses and external references
const cleanParentComponent = (comp) => {
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
  if (comp.repository || comp.homepage) {
    const externalReferences = addExternalReferences(comp);
    if (externalReferences?.length) {
      comp.externalReferences = externalReferences;
    }
  }
  delete comp.repository;
  delete comp.homepage;
  return comp;
};

const addAuthorsSection = (options) => {
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
const addLifecyclesSection = (options) => {
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
 * Method to generate the formulation section based on git metadata
 *
 * @param {Object} options
 * @param {Object} context Context
 * @returns {Array} formulation array
 */
const addFormulationSection = (options, context) => {
  const formulation = [];
  const provides = [];
  const gitBranch = getBranch();
  const originUrl = getOriginUrl();
  const gitFiles = listFiles();
  const treeHashes = gitTreeHashes();
  let parentOmniborId;
  let treeOmniborId;
  let components = [];
  const aformulation = {};
  // Reuse any existing formulation components
  // See: PR #1172
  if (context?.formulationList?.length) {
    components = components.concat(trimComponents(context.formulationList));
  }
  if (options.specVersion >= 1.6 && Object.keys(treeHashes).length === 2) {
    parentOmniborId = `gitoid:blob:sha1:${treeHashes.parent}`;
    treeOmniborId = `gitoid:blob:sha1:${treeHashes.tree}`;
    components.push({
      type: "file",
      name: "git-parent",
      description: "Git Parent Node.",
      "bom-ref": parentOmniborId,
      omniborId: [parentOmniborId],
      swhid: [`swh:1:rev:${treeHashes.parent}`],
    });
    components.push({
      type: "file",
      name: "git-tree",
      description: "Git Tree Node.",
      "bom-ref": treeOmniborId,
      omniborId: [treeOmniborId],
      swhid: [`swh:1:rev:${treeHashes.tree}`],
    });
    provides.push({
      ref: parentOmniborId,
      provides: [treeOmniborId],
    });
  }
  // Collect git related components
  if (gitBranch && gitFiles) {
    const gitFileComponents = gitFiles.map((f) =>
      options.specVersion >= 1.6
        ? {
            type: "file",
            name: f.name,
            version: f.hash,
            omniborId: [f.omniborId],
            swhid: [f.swhid],
          }
        : {
            type: "file",
            name: f.name,
            version: f.hash,
          },
    );
    components = components.concat(gitFileComponents);
    // Complete the Artifact Dependency Graph
    if (options.specVersion >= 1.6 && treeOmniborId) {
      provides.push({
        ref: treeOmniborId,
        provides: gitFiles.map((f) => f.ref),
      });
    }
  }
  // Collect build environment details
  const infoComponents = collectEnvInfo(options.path);
  if (infoComponents?.length) {
    components = components.concat(infoComponents);
  }
  // Should we include the OS crypto libraries
  if (options.includeCrypto) {
    const cryptoLibs = collectOSCryptoLibs(options);
    if (cryptoLibs?.length) {
      components = components.concat(cryptoLibs);
    }
  }
  aformulation["bom-ref"] = uuidv4();
  aformulation.components = trimComponents(components);
  let environmentVars = gitBranch?.length
    ? [{ name: "GIT_BRANCH", value: gitBranch }]
    : [];
  const envPrefixes = [
    "GIT",
    "ANDROID",
    "DENO",
    "DOTNET",
    "JAVA_",
    "SDKMAN",
    "CARGO",
    "CONDA",
    "RUST",
    "GEM_",
    "SCALA_",
    "MAVEN_",
    "GRADLE_",
    "NODE_",
  ];
  const envBlocklist = [
    "key",
    "token",
    "pass",
    "secret",
    "user",
    "email",
    "auth",
    "session",
    "proxy",
    "cred",
  ];

  for (const aevar of Object.keys(process.env)) {
    const lower = aevar.toLowerCase();
    const value = process.env[aevar] ?? "";
    if (
      envPrefixes.some((p) => aevar.startsWith(p)) &&
      !envBlocklist.some((b) => lower.includes(b)) &&
      !envBlocklist.some((b) => value.includes(b)) &&
      value.length
    ) {
      environmentVars.push({
        name: aevar,
        value,
      });
    }
  }
  if (!environmentVars.length) {
    environmentVars = undefined;
  }
  let sourceInput;
  if (environmentVars) {
    sourceInput = { environmentVars };
  }
  const sourceWorkflow = {
    "bom-ref": uuidv4(),
    uid: uuidv4(),
    taskTypes: originUrl ? ["build", "clone"] : ["build"],
  };
  if (sourceInput) {
    sourceWorkflow.inputs = [sourceInput];
  }
  aformulation.workflows = [sourceWorkflow];
  formulation.push(aformulation);
  return { formulation, provides };
};

/**
 * Function to create metadata block
 *
 */
function addMetadata(parentComponent = {}, options = {}, context = {}) {
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
      if (!parentComponent["purl"] && parentComponent["bom-ref"]) {
        parentComponent["purl"] = encodeForPurl(parentComponent["bom-ref"]);
      }
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
          if (fullName !== parentFullName) {
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
            for (const lang in [
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
    // Should we move these to formulation?
    if (options?.bundledSdks?.length) {
      for (const sdk of options.bundledSdks) {
        try {
          const purlObj = PackageURL.fromString(sdk);
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
function addExternalReferences(opkg) {
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
 * Given the specified package, create a CycloneDX component and add it to the list.
 */
function addComponent(
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
    let purl =
      pkg.purl ||
      new PackageURL(
        ptype,
        encodeForPurl(group),
        encodeForPurl(name),
        version,
        pkg.qualifiers,
        encodeForPurl(pkg.subpath),
      );
    let purlString = purl.toString();
    // There is no purl for cryptographic-asset
    if (ptype === "cryptographic-asset") {
      purl = undefined;
      purlString = undefined;
    }
    const description = pkg.description || undefined;
    let compScope = pkg.scope;
    if (allImports) {
      const impPkgs = Object.keys(allImports);
      if (
        impPkgs.includes(name) ||
        impPkgs.includes(`${group}/${name}`) ||
        impPkgs.includes(`@${group}/${name}`) ||
        impPkgs.includes(group) ||
        impPkgs.includes(`@${group}`)
      ) {
        compScope = "required";
      } else if (impPkgs.length && compScope !== "excluded") {
        compScope = "optional";
      }
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
    if (options.specVersion >= 1.5) {
      component.pedigree = pkg.pedigree || undefined;
    }
    if (options.specVersion >= 1.6) {
      component.releaseNotes = pkg.releaseNotes || undefined;
      component.modelCard = pkg.modelCard || undefined;
      component.data = pkg.data || undefined;
    }
    component["type"] = determinePackageType(pkg);
    component["bom-ref"] = decodeURIComponent(purlString);
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
        authorsList.push({ name: aauthor });
      }
      component.authors = authorsList;
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
    if (pkg.cryptoProperties?.length) {
      component.cryptoProperties = pkg.cryptoProperties;
    }
    // Retain nested components
    if (pkg.components) {
      component.components = pkg.components;
    }
    // Issue: 1353. We need to keep merging the properties
    if (compMap[component.purl]) {
      const mergedComponents = trimComponents([
        compMap[component.purl],
        component,
      ]);
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
    compMap[component.purl] = component;
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
function determinePackageType(pkg) {
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
      const purl = PackageURL.fromString(pkg.purl);
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
function processHashes(pkg, component) {
  if (pkg.hashes) {
    // This attribute would be available when we read a bom json directly
    // Eg: cyclonedx-maven-plugin. See: Bugs: #172, #175
    for (const ahash of pkg.hashes) {
      addComponentHash(ahash.alg, ahash.content, component);
    }
  } else if (pkg._shasum) {
    const ahash = { alg: "SHA-1", content: pkg._shasum };
    component.hashes.push(ahash);
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

/**
 * Adds a hash to component.
 */
function addComponentHash(alg, digest, component) {
  let hash;
  // If it is a valid hash simply use it
  if (new RegExp(HASH_PATTERN).test(digest)) {
    hash = digest;
  } else {
    // Check if base64 encoded
    const isBase64Encoded =
      Buffer.from(digest, "base64").toString("base64") === digest;
    hash = isBase64Encoded
      ? Buffer.from(digest, "base64").toString("hex")
      : digest;
  }
  const ahash = { alg: alg, content: hash };
  component.hashes.push(ahash);
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
const buildBomNSData = (options, pkgInfo, ptype, context) => {
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
  const dependencies = context.dependencies || [];
  const parentComponent =
    determineParentComponent(options) || context.parentComponent;
  const metadata = addMetadata(parentComponent, options, context);
  const components = listComponents(options, allImports, pkgInfo, ptype);
  if (components && (components.length || parentComponent)) {
    // CycloneDX Json Template
    const jsonTpl = {
      bomFormat: "CycloneDX",
      specVersion: `${options.specVersion || "1.5"}`,
      serialNumber: serialNum,
      version: 1,
      metadata: metadata,
      components,
      dependencies,
    };
    const formulationData =
      options.includeFormulation && options.specVersion >= 1.5
        ? addFormulationSection(options, context)
        : undefined;
    if (formulationData) {
      jsonTpl.formulation = formulationData.formulation;
    }
    bomNSData.bomJson = jsonTpl;
    bomNSData.nsMapping = nsMapping;
    bomNSData.dependencies = dependencies;
    bomNSData.parentComponent = parentComponent;
  }
  return bomNSData;
};

/**
 * Function to create bom string for Java jars
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 *
 * @returns {Object} BOM with namespace mapping
 */
export async function createJarBom(path, options) {
  let pkgList = [];
  let jarFiles;
  let nsMapping = {};
  if (!options.exclude) {
    options.exclude = [];
  }
  // We can look for jar files within node_modules directory
  if (typeof options.includeNodeModulesDir === "undefined" || options.deep) {
    options.includeNodeModulesDir = true;
  }
  // Exclude certain directories during oci sbom generation
  if (hasAnyProjectType(["oci"], options, false)) {
    options.exclude.push("**/android-sdk*/**");
    options.exclude.push("**/.sdkman/**");
  }
  const parentComponent = createDefaultParentComponent(path, "maven", options);
  if (options.useGradleCache) {
    nsMapping = await collectGradleDependencies(
      getGradleCommand(path, null),
      path,
      false,
      true,
    );
  } else if (options.useMavenCache) {
    nsMapping = await collectMvnDependencies(
      getMavenCommand(path, null),
      null,
      false,
      true,
    );
  }
  if (path.endsWith(".jar")) {
    jarFiles = [resolve(path)];
  } else {
    jarFiles = getAllFiles(
      path,
      `${options.multiProject ? "**/" : ""}*.[jw]ar`,
      options,
    );
  }
  // Jenkins plugins
  const hpiFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}*.hpi`,
    options,
  );
  if (hpiFiles.length) {
    jarFiles = jarFiles.concat(hpiFiles);
  }
  for (const jar of jarFiles) {
    const tempDir = mkdtempSync(join(getTmpDir(), "jar-deps-"));
    if (DEBUG_MODE) {
      console.log(`Parsing ${jar}`);
    }
    const dlist = await extractJarArchive(jar, tempDir);
    if (dlist?.length) {
      pkgList = pkgList.concat(dlist);
    }
    if (pkgList.length) {
      pkgList = await getMvnMetadata(pkgList);
    }
    // Clean up
    if (tempDir?.startsWith(getTmpDir()) && rmSync) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
  pkgList = pkgList.concat(await convertJarNSToPackages(nsMapping));
  return buildBomNSData(options, pkgList, "maven", {
    src: path,
    parentComponent,
  });
}

/**
 * Function to create bom string for Android apps using blint
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 */
export function createAndroidBom(path, options) {
  return createBinaryBom(path, options);
}

/**
 * Function to create bom string for binaries using blint
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 */
export function createBinaryBom(path, options) {
  const tempDir = mkdtempSync(join(getTmpDir(), "blint-tmp-"));
  const binaryBomFile = join(tempDir, "bom.json");
  getBinaryBom(path, binaryBomFile, options.deep);
  if (safeExistsSync(binaryBomFile)) {
    const binaryBom = JSON.parse(
      readFileSync(binaryBomFile, { encoding: "utf-8" }),
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
 * Function to create bom string for Java projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 */
export async function createJavaBom(path, options) {
  let jarNSMapping = {};
  let pkgList = [];
  let dependencies = [];
  // cyclone-dx-maven plugin creates a component for the app under metadata
  // This is subsequently referred to in the dependencies list
  let parentComponent = {};
  // Support for tracking all the tools that created the BOM
  // For java, this would correctly include the cyclonedx maven plugin.
  let tools;
  let possible_misses = false;
  // war/ear mode
  if (path.endsWith(".war") || path.endsWith(".jar")) {
    // Check if the file exists
    if (safeExistsSync(path)) {
      if (DEBUG_MODE) {
        console.log(`Retrieving packages from ${path}`);
      }
      const tempDir = mkdtempSync(join(getTmpDir(), "war-deps-"));
      jarNSMapping = await collectJarNS(tempDir);
      pkgList = await extractJarArchive(path, tempDir, jarNSMapping);
      if (pkgList.length) {
        pkgList = await getMvnMetadata(pkgList);
      }
      // Clean up
      if (tempDir?.startsWith(getTmpDir()) && rmSync) {
        console.log(`Cleaning up ${tempDir}`);
        rmSync(tempDir, { recursive: true, force: true });
      }
    } else {
      console.log(`${path} doesn't exist`);
    }
    return buildBomNSData(options, pkgList, "maven", {
      src: dirname(path),
      filename: path,
      nsMapping: jarNSMapping,
      dependencies,
      parentComponent,
    });
  }
  // -t quarkus is supported
  let isQuarkus = options?.projectType?.includes("quarkus");
  let useMavenDepsTree = isQuarkus ? false : PREFER_MAVEN_DEPS_TREE;
  // Is this a multi-module project
  let rootModules;
  // maven - pom.xml
  const pomFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}pom.xml`,
    options,
  );
  // gradle
  const gradleFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}build.gradle*`,
    options,
  );
  // mill
  const millFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}build.mill`,
    options,
  );
  let bomJsonFiles = [];
  if (
    pomFiles?.length &&
    isPackageManagerAllowed(
      "maven",
      ["bazel", "sbt", "gradle", "mill"],
      options,
    )
  ) {
    if (gradleFiles.length) {
      thoughtLog(
        `Is this a Gradle project? I recommend invoking cdxgen with the "-t gradle" option if you're encountering build errors.`,
      );
    }
    if (!isQuarkus) {
      // Quarkus projects require special treatment. To detect quarkus, we parse the first 3 maven file to look for a hit
      for (const pf of pomFiles.slice(0, 3)) {
        const pomMap = parsePom(pf);
        if (!rootModules && pomMap?.modules?.length) {
          rootModules = pomMap.modules;
        }
        // In quarkus mode, we cannot use the maven deps tree
        if (pomMap.isQuarkus) {
          isQuarkus = true;
          useMavenDepsTree = false;
          break;
        }
      }
    }
    let result;
    let mvnArgs;
    if (isQuarkus) {
      thoughtLog(
        "This appears to be a Quarkus project. Let's use the right Maven plugin.",
      );
      // disable analytics. See: https://quarkus.io/usage/
      mvnArgs = [
        "-fn",
        "quarkus:dependency-sbom",
        "-Dquarkus.analytics.disabled=true",
      ];
      if (options.specVersion) {
        mvnArgs = mvnArgs.concat(
          `-Dquarkus.dependency.sbom.schema-version=${options.specVersion}`,
        );
      }
    } else {
      const cdxMavenPlugin =
        process.env.CDX_MAVEN_PLUGIN ||
        "org.cyclonedx:cyclonedx-maven-plugin:2.9.1";
      const cdxMavenGoal = process.env.CDX_MAVEN_GOAL || "makeAggregateBom";
      mvnArgs = [
        "-fn",
        `${cdxMavenPlugin}:${cdxMavenGoal}`,
        "-DoutputName=bom",
      ];
      if (includeMavenTestScope) {
        mvnArgs.push("-DincludeTestScope=true");
      }
      // By using quiet mode we can reduce the maxBuffer used and avoid crashes
      if (!DEBUG_MODE) {
        mvnArgs.push("-q");
      }
      // Support for passing additional settings and profile to maven
      if (process.env.MVN_ARGS) {
        const addArgs = process.env.MVN_ARGS.split(" ");
        mvnArgs = mvnArgs.concat(addArgs);
      }
      // specVersion 1.4 doesn't support externalReferences.type=disribution-intake
      // so we need to run the plugin with the correct version
      if (options.specVersion) {
        mvnArgs = mvnArgs.concat(`-DschemaVersion=${options.specVersion}`);
      }
    }
    const firstPom = pomFiles.length ? pomFiles[0] : undefined;
    let mavenCmd = getMavenCommand(path, path);
    for (const f of pomFiles) {
      const basePath = dirname(f);
      if (
        isQuarkus &&
        !options.deep &&
        rootModules?.includes(basename(basePath))
      ) {
        if (DEBUG_MODE) {
          console.log("Skipped sub-module", basePath);
        }
        continue;
      }
      const settingsXml = join(basePath, "settings.xml");
      if (safeExistsSync(settingsXml)) {
        console.log(
          `maven settings.xml found in ${basePath}. Please set the MVN_ARGS environment variable based on the full mvn build command used for this project.\nExample: MVN_ARGS='--settings ${settingsXml}'`,
        );
      }
      if (mavenCmd?.endsWith("mvn")) {
        mavenCmd = getMavenCommand(basePath, path);
      }
      // Should we attempt to resolve class names
      if (options.resolveClass || options.deep) {
        const tmpjarNSMapping = await collectMvnDependencies(
          mavenCmd,
          basePath,
          true,
          false,
        );
        if (tmpjarNSMapping && Object.keys(tmpjarNSMapping).length) {
          jarNSMapping = { ...jarNSMapping, ...tmpjarNSMapping };
        }
      }
      // Use the cyclonedx maven plugin if there is no preference for maven deps tree
      if (!useMavenDepsTree) {
        thoughtLog("The user wants me to use the cyclonedx-maven plugin.");
        console.log(`Executing '${mavenCmd}' in`, basePath);
        result = safeSpawnSync(mavenCmd, mvnArgs, {
          cwd: basePath,
          shell: true,
        });
        // Check if the cyclonedx plugin created the required bom.json file
        // Sometimes the plugin fails silently for complex maven projects
        bomJsonFiles = getAllFiles(
          path,
          "**/target/*{cdx,bom,cyclonedx}*.json",
          options,
        );
        // Check if the bom json files got created in a directory other than target
        if (!bomJsonFiles.length) {
          bomJsonFiles = getAllFiles(
            path,
            "target/**/*{cdx,bom,cyclonedx}*.json",
            options,
          );
        }
      }
      // Also check if the user has a preference for maven deps tree command
      if (
        useMavenDepsTree ||
        !bomJsonFiles.length ||
        result?.status !== 0 ||
        result?.error
      ) {
        const tempMvnTree = join(basePath, "target", "cdxgen-mvn-tree.txt");
        const tempMvnParentTree = join(
          basePath,
          "target",
          "cdxgen-mvn-parent-tree.txt",
        );
        let mvnTreeArgs = ["dependency:tree", `-DoutputFile=${tempMvnTree}`];
        let addArgs = "";
        if (process.env.MVN_ARGS) {
          addArgs = process.env.MVN_ARGS.split(" ");
          mvnTreeArgs = mvnTreeArgs.concat(addArgs);
        }
        // Automatically use settings.xml to improve the success for fallback
        if (safeExistsSync(settingsXml)) {
          mvnTreeArgs.push("-s");
          mvnTreeArgs.push(settingsXml);
        }
        // For the first pom alone, we need to execute first in non-recursive mode to capture
        // the parent component. Then, we execute all of them in recursive mode
        if (f === firstPom) {
          thoughtLog(
            "What is the parent component here? Let's use maven command to find out.",
          );
          let findParentComponentArgs = [
            "dependency:tree",
            "-N",
            `-DoutputFile=${tempMvnParentTree}`,
          ];
          if (addArgs) {
            findParentComponentArgs = findParentComponentArgs.concat(addArgs);
          }
          result = safeSpawnSync("mvn", findParentComponentArgs, {
            cwd: basePath,
            shell: true,
          });
          if (result.status === 0) {
            if (safeExistsSync(tempMvnParentTree)) {
              const mvnTreeString = readFileSync(tempMvnParentTree, {
                encoding: "utf-8",
              });
              const parsedList = parseMavenTree(mvnTreeString, f);
              const dlist = parsedList.pkgList;
              const tmpParentComponent = dlist.splice(0, 1)[0];
              tmpParentComponent.type = "application";
              parentComponent = tmpParentComponent;
              parentComponent.components = [];
              if (parentComponent.name) {
                thoughtLog(
                  `Parent component is called ${parentComponent.name}!`,
                );
              }
            }
          }
        }
        thoughtLog(
          `**MAVEN**: Let's use Maven to collect packages from ${basePath}.`,
        );
        if (DEBUG_MODE) {
          console.log(`Executing 'mvn dependency:tree ...' in ${basePath}`);
        }
        // Prefer the built-in maven
        result = safeSpawnSync(
          PREFER_MAVEN_DEPS_TREE ? "mvn" : mavenCmd,
          mvnTreeArgs,
          {
            cwd: basePath,
            shell: true,
          },
        );
        if (result.status !== 0 || result.error) {
          possible_misses = true;
          // Our approach to recursively invoking the maven plugin for each sub-module is bound to result in failures
          // These could be due to a range of reasons that are covered below.
          if (pomFiles.length === 1 || DEBUG_MODE || PREFER_MAVEN_DEPS_TREE) {
            if (result.stdout) {
              console.log(result.stdout);
            }
            if (result.stderr) {
              console.log(result.stderr);
              console.log("The above build errors could be due to:\n");
            }
            if (
              result.stdout &&
              (result.stdout.includes("Non-resolvable parent POM") ||
                result.stdout.includes("points at wrong local POM"))
            ) {
              console.log(
                "1. Check if the pom.xml contains valid settings for parent and modules. Some projects can be built only from a specific directory.",
              );
            } else if (
              result.stdout &&
              (result.stdout.includes("Could not resolve dependencies") ||
                result.stdout.includes("no dependency information available") ||
                result.stdout.includes(
                  "The following artifacts could not be resolved",
                ))
            ) {
              console.log(
                "1. Try building the project with 'mvn package -Dmaven.test.skip=true' using the correct version of Java and maven before invoking cdxgen.",
              );
            } else if (
              result.stdout?.includes(
                "Could not resolve target platform specification",
              )
            ) {
              console.log(
                "1. Some projects can be built only from the root directory. Invoke cdxgen with --no-recurse option",
              );
            } else {
              console.log(
                "1. Java version requirement: cdxgen container image bundles Java 24 with maven 3.9 which might be incompatible. Try running cdxgen with the custom JDK11-based image `ghcr.io/cyclonedx/cdxgen-java11:v12`.",
              );
            }
            console.log(
              "2. Private dependencies cannot be downloaded: Check if any additional arguments must be passed to maven and set them via MVN_ARGS environment variable.",
            );
            console.log(
              "3. Check if all required environment variables including any maven profile arguments are passed correctly to this tool.",
            );
          }
          // Do not fall back to methods that can produce incomplete results when failOnError is set
          options.failOnError && process.exit(1);
          console.log(
            "\nFalling back to parsing pom.xml files. Only direct dependencies would get included!",
          );
          thoughtLog(
            "**MAVEN**: There appear to be build errors, so the SBOM will be incomplete.",
          );
          const dlist = parsePom(f);
          if (dlist?.length) {
            pkgList = pkgList.concat(dlist);
          }
        } else {
          if (safeExistsSync(tempMvnTree)) {
            const mvnTreeString = readFileSync(tempMvnTree, {
              encoding: "utf-8",
            });
            const parsedList = parseMavenTree(mvnTreeString, f);
            const dlist = parsedList.pkgList;
            const tmpParentComponent = dlist.splice(0, 1)[0];
            tmpParentComponent.type = "application";
            if (dlist?.length) {
              pkgList = pkgList.concat(dlist);
              if (dlist.length > 1) {
                thoughtLog(`Obtained ${dlist.length} components from maven.`);
              } else {
                thoughtLog(
                  `"Received very few components from the maven dependency tree command for ${basePath}."`,
                );
              }
            }
            // Retain the parent hierarchy
            if (!Object.keys(parentComponent).length) {
              parentComponent = tmpParentComponent;
              parentComponent.components = [];
            } else {
              parentComponent.components.push(tmpParentComponent);
            }
            if (parsedList?.dependenciesList?.length) {
              dependencies = mergeDependencies(
                dependencies,
                parsedList.dependenciesList,
                tmpParentComponent,
              );
            } else {
              if (dlist?.length) {
                thoughtLog(
                  `Hmm, I didn't find any dependencies after executing '${basename(mavenCmd)}'. However, I did get ${dlist.length} components, which is confusing.`,
                );
              }
            }
            if (!DEBUG_MODE) {
              unlinkSync(tempMvnTree);
            }
          }
        }
      }
    } // for
    // Locate and parse all bom.json files from the maven plugin
    if (!useMavenDepsTree) {
      for (const abjson of bomJsonFiles) {
        let bomJsonObj;
        try {
          if (DEBUG_MODE) {
            console.log(`Extracting data from generated bom file ${abjson}`);
          }
          bomJsonObj = JSON.parse(
            readFileSync(abjson, {
              encoding: "utf-8",
            }),
          );
          if (bomJsonObj) {
            if (
              !tools &&
              bomJsonObj.metadata &&
              bomJsonObj.metadata.tools &&
              (Array.isArray(bomJsonObj.metadata.tools) ||
                bomJsonObj.metadata.tools.components ||
                bomJsonObj.metadata.tools.services)
            ) {
              tools = bomJsonObj.metadata.tools;
            }
            if (
              bomJsonObj.metadata?.component &&
              !Object.keys(parentComponent).length
            ) {
              parentComponent = bomJsonObj.metadata.component;
              options.parentComponent = parentComponent;
            }
            if (bomJsonObj.components) {
              // Inject evidence into the components. #994
              if (options.specVersion >= 1.5) {
                // maven would usually generate a target directory closest to the pom.xml
                // I am sure there would be cases where this assumption is not true :)
                const srcPomFile = join(dirname(abjson), "..", "pom.xml");
                for (const acomp of bomJsonObj.components) {
                  if (!acomp.evidence) {
                    acomp.evidence = {
                      identity: {
                        field: "purl",
                        confidence: 0.8,
                        methods: [
                          {
                            technique: "manifest-analysis",
                            confidence: 0.8,
                            value: srcPomFile,
                          },
                        ],
                      },
                    };
                  }
                  if (!acomp.properties) {
                    acomp.properties = [];
                  }
                  acomp.properties.push({
                    name: "SrcFile",
                    value: srcPomFile,
                  });
                }
              }
              pkgList = pkgList.concat(bomJsonObj.components);
            }
            if (bomJsonObj.dependencies) {
              dependencies = mergeDependencies(
                dependencies,
                bomJsonObj.dependencies,
                parentComponent,
              );
            }
          }
        } catch (err) {
          if (options.failOnError || DEBUG_MODE) {
            console.log(err);
            options.failOnError && process.exit(1);
          }
        }
      }
    }
    if (possible_misses) {
      if (gradleFiles.length) {
        console.log(
          "Is this a gradle project? Try running cdxgen with `-t gradle`.",
        );
      } else if (!DEBUG_MODE) {
        console.warn(
          "Multiple errors occurred while building this project with maven. The SBOM is therefore incomplete!",
        );
      }
    }
  }
  const allProjects = [];
  const allProjectsAddedPurls = [];
  const rootDependsOn = new Set();
  const gradleModules = new Map();
  // Determine the root path for gradle
  // Fixes gradle invocation for microservices-demo
  let gradleRootPath = path;
  if (
    gradleFiles?.length &&
    !safeExistsSync(join(path, "settings.gradle")) &&
    !safeExistsSync(join(path, "settings.gradle.kts")) &&
    !safeExistsSync(join(path, "build.gradle")) &&
    !safeExistsSync(join(path, "build.gradle.kts"))
  ) {
    gradleRootPath = dirname(gradleFiles[0]);
  }
  if (safeExistsSync(join(gradleRootPath, "gradle.properties"))) {
    thoughtLog(
      "Hmm, there is a gradle.properties file. Do we need any private modules or custom JVM arguments for this project 🤔?",
    );
  }
  // Execute gradle properties
  if (
    gradleFiles?.length &&
    isPackageManagerAllowed(
      "gradle",
      ["maven", "bazel", "sbt", "mill"],
      options,
    )
  ) {
    let includedBuilds = [];
    let allProjectsStr = [];
    if (process.env.GRADLE_INCLUDED_BUILDS) {
      includedBuilds = process.env.GRADLE_INCLUDED_BUILDS.split(",").map((b) =>
        !b.startsWith(":") ? `:${b}` : b,
      );
    }
    let parallelPropTaskOut = executeParallelGradleProperties(
      gradleRootPath,
      [null].concat(includedBuilds),
      process.env.GRADLE_INCLUDED_BUILDS
        ? []
        : ["--init-script", GRADLE_INIT_SCRIPT],
    );
    if (process.env.GRADLE_INCLUDED_BUILDS === undefined) {
      const outputLines = parallelPropTaskOut.split("\n");
      for (const [_i, line] of outputLines.entries()) {
        if (line.startsWith("Root project '") || line.startsWith("Project '")) {
          break;
        }
        if (line.startsWith("<CDXGEN:includedBuild>")) {
          const includedBuild = line.split(">");
          if (!includedBuilds.includes(includedBuild[1].trim())) {
            includedBuilds.push(includedBuild[1].trim());
          }
        }
      }
      if (includedBuilds.length > 0) {
        thoughtLog(
          `Wait, this gradle project uses composite builds. I must carefully process these ${includedBuilds.length} projects, in addition to the root.`,
        );
        if (DEBUG_MODE) {
          console.log(`Composite builds: ${includedBuilds.join(" ").trim()}.`);
        }
        parallelPropTaskOut = parallelPropTaskOut.concat(
          "\n",
          executeParallelGradleProperties(gradleRootPath, includedBuilds),
        );
      }
    }
    const splitPropTaskOut = splitOutputByGradleProjects(parallelPropTaskOut, [
      "properties",
    ]);
    for (const [key, propTaskOut] of splitPropTaskOut.entries()) {
      const retMap = parseGradleProperties(propTaskOut);
      const rootProject = retMap.rootProject;
      if (rootProject) {
        const rootComponent = await buildObjectForGradleModule(
          rootProject,
          retMap.metadata,
        );
        if (!includedBuilds.includes(key)) {
          parentComponent = rootComponent;
        }
        gradleModules.set(key, rootComponent);
        if (!allProjectsAddedPurls.includes(rootComponent["purl"])) {
          allProjects.push(rootComponent);
          rootDependsOn.add(rootComponent["bom-ref"]);
          allProjectsAddedPurls.push(rootComponent["purl"]);
        }
        allProjectsStr = allProjectsStr.concat(retMap.projects);
      }
    }
    // Get the sub-project properties and set the root dependencies
    if (allProjectsStr?.length) {
      const modulesToSkip = process.env.GRADLE_SKIP_MODULES
        ? process.env.GRADLE_SKIP_MODULES.split(",")
        : [];
      if (modulesToSkip.length) {
        thoughtLog(
          `Good news. I know there are ${allProjectsStr.length} gradle modules at ${gradleRootPath}. I must skip ${modulesToSkip.length} out of these.`,
        );
      }
      const parallelPropTaskOut = executeParallelGradleProperties(
        gradleRootPath,
        allProjectsStr.filter((module) => !modulesToSkip.includes(module)),
      );
      const splitPropTaskOut = splitOutputByGradleProjects(
        parallelPropTaskOut,
        ["properties"],
      );

      for (const subProject of allProjectsStr) {
        const retMap = parseGradleProperties(
          splitPropTaskOut.get(subProject),
          subProject,
        );
        const rootSubProject = retMap.rootProject;
        if (rootSubProject) {
          const rootSubProjectObj = await buildObjectForGradleModule(
            rootSubProject === "root" ? subProject : rootSubProject,
            retMap.metadata,
          );
          if (!allProjectsAddedPurls.includes(rootSubProjectObj["purl"])) {
            allProjects.push(rootSubProjectObj);
            rootDependsOn.add(rootSubProjectObj["bom-ref"]);
            allProjectsAddedPurls.push(rootSubProjectObj["purl"]);
          }
          gradleModules.set(subProject, rootSubProjectObj);
        }
      }
      // Bug #317 fix
      parentComponent.components = allProjects.flatMap((s) => {
        delete s.qualifiers;
        delete s.evidence;
        return s;
      });
      dependencies.push({
        ref: parentComponent["bom-ref"],
        dependsOn: [...rootDependsOn].sort(),
      });
    }
  }
  if (
    gradleFiles?.length &&
    options.installDeps &&
    isPackageManagerAllowed(
      "gradle",
      ["maven", "bazel", "sbt", "mill"],
      options,
    )
  ) {
    allProjects.push(parentComponent);
    const gradleCmd = getGradleCommand(gradleRootPath, null);
    const gradleDepTask = process.env.GRADLE_DEPENDENCY_TASK
      ? process.env.GRADLE_DEPENDENCY_TASK
      : "dependencies";

    const gradleSubCommands = [];
    let modulesToSkip = process.env.GRADLE_SKIP_MODULES
      ? process.env.GRADLE_SKIP_MODULES.split(",")
      : [];
    if (process.env.GRADLE_SKIP_MODULE_DEPENDENCIES) {
      modulesToSkip = modulesToSkip.concat(
        process.env.GRADLE_SKIP_MODULE_DEPENDENCIES.split(","),
      );
    }
    if (!modulesToSkip.includes("root")) {
      gradleSubCommands.push(gradleDepTask);
    }
    for (const [key, sp] of gradleModules) {
      //create single command for dependencies tasks on all subprojects
      if (sp.purl !== parentComponent.purl && !modulesToSkip.includes(key)) {
        gradleSubCommands.push(`${key}:${gradleDepTask}`);
      }
    }
    const gradleArguments = buildGradleCommandArguments(
      process.env.GRADLE_ARGS ? process.env.GRADLE_ARGS.split(" ") : [],
      gradleSubCommands,
      process.env.GRADLE_ARGS_DEPENDENCIES
        ? process.env.GRADLE_ARGS_DEPENDENCIES.split(" ")
        : [],
      gradleCmd.length,
    );
    const allOutputs = [];
    for (const gradleArg of gradleArguments) {
      if (DEBUG_MODE) {
        console.log(
          `Executing ${gradleCmd} with arguments ${gradleArg.join(" ").substring(0, 150)}... in ${gradleRootPath}`,
        );
      }
      thoughtLog(
        `Let's invoke '${basename(gradleCmd)}' with the arguments '${gradleArg.join(" ").substring(0, 100)} ...'.`,
      );
      const sresult = safeSpawnSync(gradleCmd, gradleArg, {
        cwd: gradleRootPath,
        shell: isWin,
      });
      if (sresult.status !== 0 || sresult.error) {
        if (options.failOnError || DEBUG_MODE) {
          console.error(sresult.stdout, sresult.stderr);
        }
        options.failOnError && process.exit(1);
      }
      if (sresult.stdout !== null) {
        allOutputs.push(sresult.stdout);
      }
    }
    const sstdout = allOutputs.join("\n");
    if (sstdout) {
      const cmdOutput = Buffer.from(sstdout).toString();
      const perProjectOutput = splitOutputByGradleProjects(cmdOutput, [
        gradleDepTask,
      ]);
      for (const key of gradleModules.keys()) {
        const parsedList = await parseGradleDep(
          perProjectOutput.has(key) ? perProjectOutput.get(key) : "",
          key,
          gradleModules,
          gradleRootPath,
        );
        const dlist = parsedList.pkgList;
        if (parsedList?.dependenciesList?.length) {
          dependencies = mergeDependencies(
            dependencies,
            parsedList.dependenciesList,
            parentComponent,
          );
        } else {
          if (dlist?.length) {
            thoughtLog(
              `Hmm, I didn't find any dependencies after executing '${basename(gradleCmd)}' for the project ${key}. However, I did get ${dlist.length} components, which is confusing.`,
            );
          }
        }
        if (dlist?.length) {
          pkgList = pkgList.concat(dlist);
        }
      }
    }
    if (pkgList.length) {
      if (parentComponent.components?.length) {
        for (const subProj of parentComponent.components) {
          pkgList = pkgList.filter(
            (pkg) =>
              pkg["bom-ref"] !== subProj["bom-ref"] &&
              pkg["bom-ref"] !== parentComponent["bom-ref"],
          );
        }
      }
      thoughtLog(
        `Obtained ${pkgList.length} components by executing the '${basename(gradleCmd)}' command.`,
      );
      if (DEBUG_MODE) {
        console.log("Obtained", pkgList.length, "from this gradle project.");
      }
    } else {
      thoughtLog(
        "**GRADLE:** SBOM is incomplete. I recommend troubleshooting the issue to improve the BOM precision.",
      );
      if (!DEBUG_MODE) {
        console.log(
          "No packages found. Set the environment variable 'CDXGEN_DEBUG_MODE=debug' to troubleshoot any gradle related errors.",
        );
      }
      options.failOnError && process.exit(1);
    }
    if (
      (!process.env.GRADLE_STOP_DAEMON &&
        (!process.env.GRADLE_USE_DAEMON ||
          ["true", "1"].includes(process.env.GRADLE_USE_DAEMON))) ||
      ["true", "1"].includes(process.env.GRADLE_STOP_DAEMON)
    ) {
      if (DEBUG_MODE) {
        console.log("Stopping gradle daemon...");
      }
      const sresult = safeSpawnSync(gradleCmd, ["--stop"], {
        cwd: gradleRootPath,
        shell: isWin,
      });
      if (sresult.status !== 0 || sresult.error) {
        if (options.failOnError || DEBUG_MODE) {
          console.error(sresult.stdout, sresult.stderr);
        }
        options.failOnError && process.exit(1);
      }
    }
    // Should we attempt to resolve class names
    if (options.resolveClass || options.deep) {
      const tmpjarNSMapping = await collectJarNS(GRADLE_CACHE_DIR);
      if (tmpjarNSMapping && Object.keys(tmpjarNSMapping).length) {
        jarNSMapping = { ...jarNSMapping, ...tmpjarNSMapping };
      }
    }
  }

  // Bazel
  // Look for the BUILD file only in the root directory
  // NOTE: This can match BUILD files used by perl, so could lead to errors in some projects
  const bazelFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}{WORKSPACE{,.bazel},MODULE.bazel}`,
    options,
  );
  if (
    bazelFiles?.length &&
    !hasAnyProjectType(["docker", "oci", "container", "os"], options, false) &&
    isPackageManagerAllowed(
      "bazel",
      ["maven", "gradle", "sbt", "mill"],
      options,
    )
  ) {
    let BAZEL_CMD = "bazel";
    if (process.env.BAZEL_HOME) {
      BAZEL_CMD = join(process.env.BAZEL_HOME, "bin", "bazel");
    }
    for (const f of bazelFiles) {
      const basePath = dirname(f);
      // Invoke bazel build first
      const bazelTarget = process.env.BAZEL_TARGET || "//...";
      let bArgs = [
        ...(process.env?.BAZEL_ARGS?.split(" ") || []),
        "build",
        bazelTarget,
      ];
      // Automatically load any bazelrc file
      if (
        !process.env.BAZEL_ARGS &&
        safeExistsSync(join(basePath, ".bazelrc"))
      ) {
        bArgs = ["--bazelrc=.bazelrc", "build", bazelTarget];
      }
      console.log("Executing", BAZEL_CMD, "in", basePath);
      let result = safeSpawnSync(BAZEL_CMD, bArgs, {
        cwd: basePath,
        shell: true,
      });
      if (result.status !== 0 || result.error) {
        if (result.stderr) {
          console.error(result.stdout, result.stderr);
        }
        console.log(
          "1. Check if bazel is installed and available in PATH.\n2. Try building your app with bazel prior to invoking cdxgen",
        );
        options.failOnError && process.exit(1);
      } else {
        const target = process.env.BAZEL_TARGET || "//...";
        let query = [...(process.env?.BAZEL_ARGS?.split(" ") || [])];
        let bazelParser;
        // Automatically load any bazelrc file
        if (
          !process.env.BAZEL_ARGS &&
          safeExistsSync(join(basePath, ".bazelrc"))
        ) {
          query = ["--bazelrc=.bazelrc"];
        }
        if (["true", "1"].includes(process.env.BAZEL_USE_ACTION_GRAPH)) {
          query = query.concat(["query", `deps(${target})`, "--output=label"]);
          bazelParser = parseBazelActionGraph;
        } else {
          query = query.concat([
            "aquery",
            "--output=textproto",
            "--skyframe_state",
          ]);
          bazelParser = parseBazelSkyframe;
        }
        console.log("Executing", BAZEL_CMD, `${query.join(" ")} in`, basePath);
        result = safeSpawnSync(BAZEL_CMD, query, {
          cwd: basePath,
        });
        if (result.status !== 0 || result.error) {
          console.error(result.stdout, result.stderr);
          options.failOnError && process.exit(1);
        }
        const stdout = result.stdout;
        if (stdout) {
          const cmdOutput = Buffer.from(stdout).toString();
          const dlist = bazelParser(cmdOutput);
          if (dlist?.length) {
            pkgList = pkgList.concat(dlist);
          } else {
            console.log(
              "No packages were detected.\n1. Build your project using bazel build command before running cdxgen\n2. Try running the bazel aquery command manually to see if skyframe state can be retrieved.",
            );
            console.log(
              "If your project requires a different query, please file a bug at cyclonedx/cdxgen repo!",
            );
            options.failOnError && process.exit(1);
          }
        } else {
          console.log("Bazel unexpectedly didn't produce any output");
          options.failOnError && process.exit(1);
        }
      }
    }
  }

  // scala sbt
  // Identify sbt projects via its `project` directory:
  // - all SBT project _should_ define build.properties file with sbt version info
  // - SBT projects _typically_ have some configs/plugins defined in .sbt files
  // - SBT projects that are still on 0.13.x, can still use the old approach,
  //   where configs are defined via Scala files
  // Detecting one of those should be enough to determine an SBT project.
  let sbtProjectFiles = getAllFiles(
    path,
    `${
      options.multiProject ? "**/" : ""
    }project/{build.properties,*.sbt,*.scala}`,
    options,
  );

  let sbtProjects = [];
  for (const i in sbtProjectFiles) {
    // parent dir of sbtProjectFile is the `project` directory
    // parent dir of `project` is the sbt root project directory
    const baseDir = dirname(dirname(sbtProjectFiles[i]));
    sbtProjects = sbtProjects.concat(baseDir);
  }

  // Fallback in case sbt's project directory is non-existent
  if (!sbtProjects.length) {
    sbtProjectFiles = getAllFiles(
      path,
      `${options.multiProject ? "**/" : ""}*.sbt`,
      options,
    );
    for (const i in sbtProjectFiles) {
      const baseDir = dirname(sbtProjectFiles[i]);
      sbtProjects = sbtProjects.concat(baseDir);
    }
  }
  // eliminate duplicates and ignore project directories
  sbtProjects = [...new Set(sbtProjects)].filter(
    (p) => !p.endsWith(`${sep}project`) && !p.includes(`target${sep}`),
  );
  const sbtLockFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}build.sbt.lock`,
    options,
  );
  const tempCacheDir = mkdtempSync(join(getTmpDir(), "sbt-cache-"));
  safeMkdirSync(tempCacheDir, { recursive: true });
  if (
    sbtProjects?.length &&
    isPackageManagerAllowed(
      "sbt",
      ["bazel", "maven", "gradle", "mill"],
      options,
    )
  ) {
    // If the project use sbt lock files
    if (sbtLockFiles?.length) {
      for (const f of sbtLockFiles) {
        const dlist = parseSbtLock(f);
        if (dlist?.length) {
          pkgList = pkgList.concat(dlist);
        }
      }
    } else {
      const SBT_CMD = process.env.SBT_CMD || "sbt";
      let sbtVersion = determineSbtVersion(path);
      // If can't find sbt version at the root of repository then search in
      // sbt project array too because sometimes the project folder isn't at
      // root of repository
      if (sbtVersion == null) {
        for (const i in sbtProjects) {
          sbtVersion = determineSbtVersion(sbtProjects[i]);
          if (sbtVersion != null) {
            break;
          }
        }
      }
      if (DEBUG_MODE) {
        console.log(`Detected sbt version: ${sbtVersion}`);
      }
      // Introduced in 1.2.0 https://www.scala-sbt.org/1.x/docs/sbt-1.2-Release-Notes.html#addPluginSbtFile+command,
      // however working properly for real only since 1.3.4: https://github.com/sbt/sbt/releases/tag/v1.3.4
      const standalonePluginFile =
        sbtVersion != null &&
        gte(sbtVersion, "1.3.4") &&
        lte(sbtVersion, "1.4.0");
      const useSlashSyntax = !sbtVersion || gte(sbtVersion, "1.5.0");
      const isDependencyTreeBuiltIn =
        sbtVersion != null && gte(sbtVersion, "1.4.0");
      const tempDir = mkdtempSync(join(getTmpDir(), "cdxsbt-"));
      const tempSbtgDir = mkdtempSync(join(getTmpDir(), "cdxsbtg-"));
      safeMkdirSync(tempSbtgDir, { recursive: true });
      // Create temporary plugins file
      const tempSbtPlugins = join(tempSbtgDir, "dep-plugins.sbt");

      // Requires a custom version of `sbt-dependency-graph` that
      // supports `--append` for `toFile` subtask.
      let sbtPluginDefinition = `\naddSbtPlugin("io.shiftleft" % "sbt-dependency-graph" % "0.10.0-append-to-file3")\n`;
      if (isDependencyTreeBuiltIn) {
        sbtPluginDefinition = "\naddDependencyTreePlugin\n";
        if (DEBUG_MODE) {
          console.log("Using addDependencyTreePlugin as the custom plugin");
        }
      }
      writeFileSync(tempSbtPlugins, sbtPluginDefinition);
      let sbtExtraArgs = "";
      const env = { ...process.env };
      // We need to collect the jars from the cache
      if (options.deep) {
        sbtExtraArgs = " updateClassifiers";
        env["COURSIER_CACHE"] = tempCacheDir;
        env["SBT_IVY_HOME"] = tempCacheDir;
      }
      for (const i in sbtProjects) {
        const basePath = sbtProjects[i];
        const dlFile = join(tempDir, `dl-${i}.tmp`);
        let sbtArgs = [];
        let pluginFile = null;
        if (standalonePluginFile) {
          sbtArgs = [
            `-addPluginSbtFile=${tempSbtPlugins}`,
            `"dependencyList::toFile ${dlFile} --force"`,
          ];
        } else {
          // write to the existing plugins file
          if (useSlashSyntax) {
            sbtArgs = [
              `'set ThisBuild / asciiGraphWidth := 800'${sbtExtraArgs} "dependencyTree / toFile ${dlFile} --force"`,
            ];
          } else {
            sbtArgs = [
              `'set asciiGraphWidth in ThisBuild := 800'${sbtExtraArgs} "dependencyTree::toFile ${dlFile} --force"`,
            ];
          }
          pluginFile = addPlugin(basePath, sbtPluginDefinition);
        }
        console.log(
          "Executing",
          SBT_CMD,
          sbtArgs.join(" "),
          "in",
          basePath,
          "using plugins",
          tempSbtgDir,
        );
        // Note that the command has to be invoked with `shell: true` to properly execut sbt
        const result = safeSpawnSync(SBT_CMD, sbtArgs, {
          cwd: basePath,
          shell: true,
          env,
        });
        if (result.status !== 0 || result.error) {
          console.error(result.stdout, result.stderr);
          console.log(
            "1. Check if scala and sbt is installed and available in PATH. Only scala 2.10 + sbt 0.13.6+ and 2.12 + sbt 1.0+ is supported for now.",
          );
          console.log(
            "2. Check if the plugin net.virtual-void:sbt-dependency-graph 0.10.0-RC1 can be used in the environment",
          );
          console.log(
            "3. Consider creating a lockfile using sbt-dependency-lock plugin. See https://github.com/stringbean/sbt-dependency-lock",
          );
          options.failOnError && process.exit(1);
        }
        if (!standalonePluginFile) {
          cleanupPlugin(basePath, pluginFile);
        }
        if (safeExistsSync(dlFile)) {
          const retMap = parseSbtTree(dlFile);
          if (retMap.pkgList?.length) {
            const tmpParentComponent = retMap.pkgList.splice(0, 1)[0];
            tmpParentComponent.type = "application";
            pkgList = pkgList.concat(retMap.pkgList);
            if (!parentComponent || !Object.keys(parentComponent).length) {
              parentComponent = tmpParentComponent;
            }
          }
          if (retMap.dependenciesList) {
            dependencies = mergeDependencies(
              dependencies,
              retMap.dependenciesList,
              parentComponent,
            );
          }
        } else {
          if (options.failOnError || DEBUG_MODE) {
            console.log(`sbt dependencyList did not yield ${dlFile}`);
          }
          options.failOnError && process.exit(1);
        }
      }

      // Cleanup
      unlinkSync(tempSbtPlugins);
    } // else

    if (DEBUG_MODE) {
      console.log(`Found ${pkgList.length} packages`);
    }
    // Should we attempt to resolve class names
    if (options.resolveClass || options.deep) {
      const tmpjarNSMapping = await collectJarNS(tempCacheDir);
      if (tmpjarNSMapping && Object.keys(tmpjarNSMapping).length) {
        jarNSMapping = { ...jarNSMapping, ...tmpjarNSMapping };
      }
      // sbt can store jars in the target directory
      const jarNSData = await createJarBom(path, options);
      if (jarNSData?.bomJson?.components) {
        pkgList = pkgList.concat(jarNSData?.bomJson?.components);
        const targetJarNSMapping = {};
        for (const p of jarNSData.bomJson.components) {
          if (!p?.purl || !p?.properties?.length) {
            continue;
          }
          const nsProp = p.properties.filter(
            (prop) => prop.name === "Namespaces",
          );
          if (nsProp.length) {
            targetJarNSMapping[p.purl] = nsProp[0].value;
          }
        }
        jarNSMapping = { ...jarNSMapping, ...targetJarNSMapping };
      }
    }
  }
  if (tempCacheDir?.startsWith(getTmpDir())) {
    rmSync(tempCacheDir, {
      recursive: true,
      force: true,
    });
  }

  if (
    millFiles?.length &&
    isPackageManagerAllowed(
      "mill",
      ["bazel", "sbt", "gradle", "maven"],
      options,
    )
  ) {
    const millRootPath = dirname(millFiles[0]);
    parentComponent = createDefaultParentComponent(
      millRootPath,
      "maven",
      options,
    );
    const millCmd = getMillCommand(millRootPath);
    const millCommonArgs = [
      "--color",
      "false",
      "--disable-callgraph",
      "--disable-prompt",
      "--keep-going",
      "--silent",
    ];
    if (!["true", "1"].includes(process.env.MILL_USE_SERVER)) {
      millCommonArgs.unshift("--no-server");
    }
    const millArgs = [...millCommonArgs, "__.ivyDepsTree"];
    if (DEBUG_MODE) {
      console.log("Executing", millCmd, "in", millRootPath);
    }
    let sresult = safeSpawnSync(millCmd, millArgs, {
      cwd: millRootPath,
      shell: isWin,
      maxBuffer: MAX_BUFFER * 10,
    });
    if (sresult.status !== 0 || sresult.error) {
      if (options.failOnError || DEBUG_MODE) {
        console.error(sresult.stdout, sresult.stderr);
      }
      options.failOnError && process.exit(1);
    }
    const millResolveArgs = [...millCommonArgs, "resolve", "__.ivyDepsTree"];
    if (DEBUG_MODE) {
      console.log(
        "Executing",
        millCmd,
        millResolveArgs.join(" "),
        "in",
        millRootPath,
      );
    }
    sresult = safeSpawnSync(millCmd, millResolveArgs, {
      cwd: millRootPath,
      shell: isWin,
    });
    if (sresult.status !== 0 || sresult.error) {
      if (options.failOnError || DEBUG_MODE) {
        console.error(sresult.stdout, sresult.stderr);
      }
      options.failOnError && process.exit(1);
    }
    const sstdout = sresult.stdout;
    if (sstdout) {
      parentComponent.components = [];
      const modules = sstdout
        .trim()
        .split("\n")
        .map((a) => a.substring(0, a.lastIndexOf(".")))
        .filter((a) =>
          ["true", "1"].includes(process.env.MILL_EXCLUDE_TEST)
            ? !a.endsWith(".test")
            : true,
        );
      const moduleBomRefs = [];
      const packages = new Map();
      const relations = new Map();
      relations.set(parentComponent["bom-ref"], []);
      for (const module of modules) {
        moduleBomRefs.push(
          parseMillDependency(module, packages, relations, millRootPath),
        );
      }
      for (const module of moduleBomRefs) {
        parentComponent.components.push(packages.get(module));
        relations.get(parentComponent["bom-ref"]).push(module);
        packages.delete(module);
      }
      const newDependencies = [];
      for (const [ref, dependsOn] of relations.entries()) {
        newDependencies.push({
          ref,
          dependsOn,
        });
      }
      if (DEBUG_MODE) {
        console.log(
          `Obtained ${packages.size} components and ${relations.size} dependencies from mill.`,
        );
      }
      pkgList = pkgList.concat(...packages.values());
      dependencies = mergeDependencies(
        dependencies,
        newDependencies,
        parentComponent,
      );
    }
    if (
      (!process.env.MILL_SHUTDOWN_SERVER &&
        ["true", "1"].includes(process.env.MILL_USE_SERVER)) ||
      ["true", "1"].includes(process.env.MILL_SHUTDOWN_SERVER)
    ) {
      if (DEBUG_MODE) {
        console.log("Shutting down mill server...");
      }
      const sresult = safeSpawnSync(millCmd, ["shutdown"], {
        cwd: millRootPath,
        shell: isWin,
      });
      if (sresult.status !== 0 || sresult.error) {
        if (options.failOnError || DEBUG_MODE) {
          console.error(sresult.stdout, sresult.stderr);
        }
        options.failOnError && process.exit(1);
      }
    }
  }

  pkgList = trimComponents(pkgList);
  pkgList = await getMvnMetadata(pkgList, jarNSMapping, options.deep);
  return buildBomNSData(options, pkgList, "maven", {
    src: path,
    nsMapping: jarNSMapping,
    dependencies,
    parentComponent,
    tools,
  });
}

/**
 * Function to create bom string for Node.js projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 */
export async function createNodejsBom(path, options) {
  let pkgList = [];
  let manifestFiles = [];
  let dependencies = [];
  let parentComponent = {};
  const parentSubComponents = [];
  let ppurl = "";
  // Docker mode requires special handling
  if (hasAnyProjectType(["docker", "oci", "container", "os"], options, false)) {
    const pkgJsonFiles = getAllFiles(path, "**/package.json", options);
    // Are there any package.json files in the container?
    if (pkgJsonFiles.length) {
      for (const pj of pkgJsonFiles) {
        const dlist = await parsePkgJson(pj);
        if (dlist?.length) {
          pkgList = pkgList.concat(dlist);
        }
      }
      return buildBomNSData(options, pkgList, "npm", {
        allImports: {},
        src: path,
        filename: "package.json",
        parentComponent,
      });
    }
  }
  let allImports = {};
  let allExports = {};
  if (
    !hasAnyProjectType(["docker", "oci", "container", "os"], options, false) &&
    !options.noBabel
  ) {
    if (DEBUG_MODE) {
      console.log(
        `Performing babel-based package usage analysis with source code at ${path}`,
      );
    }
    const retData = await findJSImportsExports(path, options.deep);
    allImports = retData.allImports;
    allExports = retData.allExports;
  }
  let yarnLockFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}yarn.lock`,
    options,
  );
  const shrinkwrapFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}npm-shrinkwrap.json`,
    options,
  );
  let pkgLockFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}package-lock.json`,
    options,
  );
  if (shrinkwrapFiles.length) {
    pkgLockFiles = pkgLockFiles.concat(shrinkwrapFiles);
  }
  let pnpmLockFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}pnpm-lock.yaml`,
    options,
  );
  const pnpmWorkspaceFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}pnpm-workspace.yaml`,
    options,
  );
  const minJsFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}*min.js`,
    options,
  );
  const bowerFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}bower.json`,
    options,
  );
  // Parse min js files
  if (minJsFiles?.length) {
    manifestFiles = manifestFiles.concat(minJsFiles);
    for (const f of minJsFiles) {
      const dlist = await parseMinJs(f);
      if (dlist?.length) {
        pkgList = pkgList.concat(dlist);
      }
    }
  }
  // Parse bower json files
  if (bowerFiles?.length) {
    manifestFiles = manifestFiles.concat(bowerFiles);
    for (const f of bowerFiles) {
      const dlist = await parseBowerJson(f);
      if (dlist?.length) {
        pkgList = pkgList.concat(dlist);
      }
    }
  }
  const pkgJsonLockFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}package-lock.json`,
    options,
  );
  const pkgJsonFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}package.json`,
    options,
  );
  const npmInstallCount =
    Number.parseInt(process.env.NPM_INSTALL_COUNT, 10) || 2;
  // Automatic npm install logic.
  // Only perform npm install for smaller projects (< 2 package.json) without the correct number of lock files
  if (
    (pkgJsonLockFiles?.length === 0 ||
      pkgJsonLockFiles?.length < pkgJsonFiles?.length) &&
    yarnLockFiles?.length === 0 &&
    pnpmLockFiles?.length === 0 &&
    pkgJsonFiles?.length <= npmInstallCount &&
    options.installDeps
  ) {
    let anyInstallSuccess = false;
    for (const apkgJson of pkgJsonFiles) {
      let pkgMgr = "npm";
      const supPkgMgrs = ["npm", "yarn", "yarnpkg", "pnpm", "pnpx"];
      const pkgData = JSON.parse(readFileSync(apkgJson, "utf8"));
      const mgrData = pkgData.packageManager;
      let mgr = "";
      if (mgrData) {
        mgr = mgrData.split("@")[0];
      }
      // Try harder to identify the correct package manager
      if (options?.projectType?.includes("npm")) {
        pkgMgr = "npm";
      } else if (supPkgMgrs.includes(mgr)) {
        pkgMgr = mgr;
      } else if (pkgData?.engines?.yarn) {
        pkgMgr = "yarn";
      } else if (
        isPackageManagerAllowed("npm", ["yarn", "pnpm", "rush"], options)
      ) {
        pkgMgr = "npm";
      } else if (
        isPackageManagerAllowed("yarn", ["npm", "pnpm", "rush"], options)
      ) {
        pkgMgr = "yarn";
      } else if (
        isPackageManagerAllowed("pnpm", ["npm", "yarn", "rush"], options)
      ) {
        pkgMgr = "pnpm";
      }
      let installCommand = "install";
      if (pkgMgr === "npm" && isSecureMode && pkgJsonLockFiles?.length > 0) {
        installCommand = "ci";
      }
      let installArgs = [installCommand];
      // Support for passing additional args to the install command
      if (process.env[`${pkgMgr.toUpperCase()}_INSTALL_ARGS`]) {
        const addArgs =
          process.env[`${pkgMgr.toUpperCase()}_INSTALL_ARGS`].split(" ");
        installArgs = installArgs.concat(addArgs);
      }
      if (pkgMgr === "npm" && isSecureMode) {
        if (!installArgs.includes("--ignore-scripts")) {
          installArgs.push("--ignore-scripts");
        }
        if (!installArgs.includes("--no-audit")) {
          installArgs.push("--no-audit");
        }
      }
      const basePath = dirname(apkgJson);
      // juice-shop mode
      // Projects such as juice-shop prevent lockfile creations using .npmrc files
      // Plus, they might require specific npm install args such as --legacy-peer-deps that could lead to strange node_modules structure
      // To keep life simple, let's look for any .npmrc file that has package-lock=false to toggle before npm install
      if (pkgMgr === "npm" && safeExistsSync(join(basePath, ".npmrc"))) {
        const npmrcData = readFileSync(join(basePath, ".npmrc"));
        if (
          npmrcData?.includes("package-lock=false") &&
          !installArgs.includes("--package-lock")
        ) {
          installArgs.push("--package-lock");
        }
      }
      if (pkgMgr === "npm" && yarnLockFiles.length) {
        thoughtLog(
          `Wait, there are ${yarnLockFiles.length} yarn.lock files in this project; however, I'm about to invoke the '${pkgMgr} ${installArgs[0]}' command.`,
        );
      }
      if (pkgMgr !== "npm") {
        thoughtLog(
          `**PACKAGE MANAGER**: Let's run the '${pkgMgr}' command with the arguments '${installArgs.join(" ")}' to generate the needed lock files.`,
        );
      }
      console.log(
        `Executing '${pkgMgr} ${installArgs.join(" ")}' in`,
        basePath,
      );
      const result = safeSpawnSync(pkgMgr, installArgs, {
        cwd: basePath,
        shell: isWin,
      });
      if (result.status !== 0 || result.error) {
        console.error(
          `${pkgMgr} install has failed. Generated SBOM will be empty or with a lower precision.`,
        );
        thoughtLog(
          "It looks like the install command has failed. I'm considering some troubleshooting ideas.",
        );
        if (DEBUG_MODE && result.stdout) {
          if (result.stdout.includes("EBADENGINE Unsupported engine")) {
            console.log(
              "TIP: Try using the custom `ghcr.io/cyclonedx/cdxgen-node20:v12` container image, which bundles node.js 20. The current version of node.js is incompatible for this project.",
            );
            console.log(
              "Alternatively, run cdxgen with the custom node with version types. Eg: `-t node20`",
            );
          }
          console.log("---------------");
          console.log(result.stdout);
        }
        if (result.stderr) {
          if (result.stderr.includes("--legacy-peer-deps")) {
            console.log(
              "Set the environment variable `NPM_INSTALL_ARGS=--legacy-peer-deps` to resolve the dependency resolution issue reported.",
            );
          }
          if (
            result.stderr.includes(
              "npm error command sh -c node-pre-gyp install",
            )
          ) {
            console.log(
              "cdxgen has detected errors with the native build using node-gyp.",
            );
            if (process.env?.CDXGEN_IN_CONTAINER === "true") {
              if (arch() !== "x64") {
                console.log(
                  `INFO: Many npm packages have limited support for ${arch()} architecture. Run the cdxgen container image with --platform=linux/amd64 for best experience.`,
                );
              } else {
                console.log(
                  "TIP: Try using the custom `ghcr.io/cyclonedx/cdxgen-node20:v12` container image, which bundles node.js 20. The default image bundles node >= 23, which might be incompatible.",
                );
              }
            } else {
              console.log(
                "TIP: Try using the custom `ghcr.io/cyclonedx/cdxgen-node20:v12` container image with --platform=linux/amd64, which bundles node.js 20.",
              );
            }
          }
          console.log("---------------");
          console.log(result.stderr);
        }
        options.failOnError && process.exit(1);
      } else {
        anyInstallSuccess = true;
      }
    }
    pkgLockFiles = getAllFiles(
      path,
      `${options.multiProject ? "**/" : ""}package-lock.json`,
      options,
    );
    pnpmLockFiles = getAllFiles(
      path,
      `${options.multiProject ? "**/" : ""}pnpm-lock.yaml`,
      options,
    );
    yarnLockFiles = getAllFiles(
      path,
      `${options.multiProject ? "**/" : ""}yarn.lock`,
      options,
    );
    if (
      anyInstallSuccess &&
      !pkgLockFiles.length &&
      !pnpmLockFiles.length &&
      !yarnLockFiles.length
    ) {
      thoughtLog(
        `Despite a successful installation step, I didn't find any lock files. Perhaps they're being created elsewhere, such as in the root directory. I am currently checking the directory at ${path}.`,
      );
    }
  }
  if (
    pnpmLockFiles?.length &&
    isPackageManagerAllowed("pnpm", ["npm", "yarn", "rush"], options)
  ) {
    manifestFiles = manifestFiles.concat(pnpmLockFiles);
    const workspacePackages = [];
    const workspaceSrcFiles = {};
    const workspaceDirectDeps = {};
    const depsWorkspaceRefs = {};
    let workspaceCatalogs = {};
    let workspaceWarningShown = false;
    const seenPkgJsonFiles = {};
    // Is this a pnpm workspace?
    for (const f of pnpmWorkspaceFiles) {
      if (DEBUG_MODE) {
        console.log(`Parsing workspace definition ${f}`);
      }
      const workspaceObj = parsePnpmWorkspace(f);
      if (workspaceObj?.packages) {
        // We need the precise purl for all workspace packages and their direct dependencies
        for (const awp of workspaceObj.packages) {
          const wpkgJsonFiles = getAllFiles(awp, "**/package.json", options);
          if (!wpkgJsonFiles?.length) {
            if (!workspaceWarningShown) {
              workspaceWarningShown = true;
              console.log(
                `Unable to find any package.json files belonging to the workspace '${awp}' referred in ${f}. To improve SBOM precision, run cdxgen from the directory containing the complete source code.`,
              );
            }
            continue;
          }
          for (const apj of wpkgJsonFiles) {
            if (seenPkgJsonFiles[apj]) {
              continue;
            }
            seenPkgJsonFiles[apj] = true;
            const pkgData = JSON.parse(readFileSync(apj, "utf-8"));
            if (pkgData?.name) {
              const relativePkgJsonFile = relative(path, apj);
              let workspaceRef = `pkg:npm/${pkgData.name}`;
              if (pkgData?.version) {
                workspaceRef = `${workspaceRef}@${pkgData.version}`;
              }
              // Track all workspace purls. When we face duplicates, let's try to expand the purl to
              // include the subpath.
              if (!workspacePackages.includes(workspaceRef)) {
                workspacePackages.push(workspaceRef);
              } else {
                console.log(
                  `Found a duplicate workspace with the name: ${pkgData.name}, ref: ${workspaceRef} at ${relativePkgJsonFile} and ${workspaceSrcFiles[workspaceRef]}. This is likely an error in the project that needs fixing.`,
                );
                workspaceRef = `${workspaceRef}#${relativePkgJsonFile.replace(`${sep}package.json`, "")}`;
                if (!workspacePackages.includes(workspaceRef)) {
                  workspacePackages.push(workspaceRef);
                  console.log(
                    `Duplicate workspace tracked as ${workspaceRef} under metadata.component.components`,
                  );
                }
              }
              workspaceSrcFiles[workspaceRef] = relativePkgJsonFile;
              // Track the direct dependencies of each workspace and workspace refs for each direct deps.
              const allDeps = {
                ...(pkgData.dependencies || {}),
                ...(pkgData.devDependencies || {}),
                ...(pkgData.peerDependencies || {}),
              };
              for (const adep of Object.keys(allDeps)) {
                if (!workspaceDirectDeps[workspaceRef]) {
                  workspaceDirectDeps[workspaceRef] = new Set();
                }
                const apkgRef = `pkg:npm/${adep}`;
                workspaceDirectDeps[workspaceRef].add(apkgRef);
                if (!depsWorkspaceRefs[apkgRef]) {
                  depsWorkspaceRefs[apkgRef] = [];
                }
                depsWorkspaceRefs[apkgRef].push(workspaceRef);
              }
            }
          }
        }
      }
      workspaceCatalogs = {
        ...workspaceCatalogs,
        ...(workspaceObj.catalogs || {}),
      };
    }
    if (DEBUG_MODE && Object.keys(seenPkgJsonFiles).length) {
      console.log(
        `${Object.keys(seenPkgJsonFiles).length} package.json files were parsed to identify workspace names. Total number of package.json files: ${pkgJsonFiles.length}`,
      );
      if (Object.keys(seenPkgJsonFiles).length < pkgJsonFiles.length - 1) {
        const seenfilenames = Object.keys(seenPkgJsonFiles);
        console.log(
          "Following files were not parsed:",
          pkgJsonFiles.filter((p) => !seenfilenames.includes(p)),
        );
        console.log(
          "TIP: Check the configuration in pnpm-workspace.yaml to ensure all the required workspaces are included correctly.",
        );
      }
    }
    for (const f of pnpmLockFiles) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      const basePath = dirname(f);
      // Determine the parent component
      const packageJsonF = join(basePath, "package.json");
      const pnpmHooks = join(basePath, ".pnpmfile.cjs");
      if (safeExistsSync(pnpmHooks)) {
        thoughtLog("Wait, this pnpm project uses install hooks.");
      }
      if (!Object.keys(parentComponent).length) {
        if (safeExistsSync(packageJsonF)) {
          const pcs = await parsePkgJson(packageJsonF, true);
          if (pcs.length && Object.keys(pcs[0]).length) {
            parentComponent = { ...pcs[0] };
            parentComponent.type = "application";
            ppurl = new PackageURL(
              "npm",
              options.projectGroup || parentComponent.group,
              parentComponent.name,
              options.projectVersion || parentComponent.version,
              null,
              null,
            ).toString();
            parentComponent["bom-ref"] = decodeURIComponent(ppurl);
            parentComponent["purl"] = ppurl;
          }
        } else {
          let dirName = dirname(f);
          const tmpA = dirName.split(sep);
          dirName = tmpA[tmpA.length - 1];
          parentComponent = {
            group: "",
            name: dirName,
            type: "application",
          };
          ppurl = new PackageURL(
            "npm",
            options.projectGroup || parentComponent.group,
            "project-name" in options
              ? options.projectName
              : parentComponent.name,
            options.projectVersion || parentComponent.version,
            null,
            null,
          ).toString();
          parentComponent["bom-ref"] = decodeURIComponent(ppurl);
          parentComponent["purl"] = ppurl;
        }
      }
      // Parse the pnpm file
      const parsedList = await parsePnpmLock(
        f,
        parentComponent,
        workspacePackages,
        workspaceSrcFiles,
        workspaceCatalogs,
        workspaceDirectDeps,
        depsWorkspaceRefs,
      );
      const dlist = parsedList.pkgList;
      if (dlist?.length) {
        pkgList = pkgList.concat(dlist);
      }
      if (parsedList?.parentSubComponents?.length) {
        parentComponent.components = parsedList.parentSubComponents;
      }
      if (parsedList?.dependenciesList?.length) {
        dependencies = mergeDependencies(
          dependencies,
          parsedList.dependenciesList,
          parentComponent,
        );
      }
    }
  }
  if (
    pkgLockFiles?.length &&
    isPackageManagerAllowed("npm", ["pnpm", "yarn"], options)
  ) {
    manifestFiles = manifestFiles.concat(pkgLockFiles);
    for (const f of pkgLockFiles) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      // Parse package-lock.json if available
      const parsedList = await parsePkgLock(f, options);
      const dlist = parsedList.pkgList;
      let tmpParentComponent = dlist.splice(0, 1)[0] || {};
      if (!Object.keys(parentComponent).length) {
        const basePath = dirname(f);
        const packageJsonF = join(basePath, "package.json");
        if (safeExistsSync(packageJsonF)) {
          const pcs = await parsePkgJson(packageJsonF, true);
          if (pcs.length && Object.keys(pcs[0]).length) {
            tmpParentComponent = { ...pcs[0] };
            tmpParentComponent.type = "application";
            tmpParentComponent.name =
              "project-name" in options
                ? options.projectName
                : tmpParentComponent.name;
            ppurl = new PackageURL(
              "npm",
              options.projectGroup || tmpParentComponent.group,
              "project-name" in options
                ? options.projectName
                : tmpParentComponent.name,
              options.projectVersion || tmpParentComponent.version,
              null,
              null,
            ).toString();
            tmpParentComponent["bom-ref"] = decodeURIComponent(ppurl);
            tmpParentComponent["purl"] = ppurl;
          }
        }
        parentComponent = tmpParentComponent;
      } else {
        parentSubComponents.push(tmpParentComponent);
      }
      if (dlist?.length) {
        pkgList = pkgList.concat(dlist);
      }
      if (parsedList?.dependenciesList?.length) {
        dependencies = mergeDependencies(
          dependencies,
          parsedList.dependenciesList,
          parentComponent,
        );
      }
    }
  }
  if (
    safeExistsSync(join(path, "rush.json")) &&
    isPackageManagerAllowed("rush", ["npm", "yarn", "pnpm"], options)
  ) {
    // Rush.js creates node_modules inside common/temp directory
    const nmDir = join(path, "common", "temp", "node_modules");
    // Do rush install if we don't have node_modules directory
    if (!safeExistsSync(nmDir)) {
      console.log("Executing 'rush install --no-link'", path);
      const result = safeSpawnSync(
        "rush",
        ["install", "--no-link", "--bypass-policy"],
        {
          cwd: path,
          shell: isWin,
        },
      );
      if (result.status === 1 || result.error) {
        console.error(result.stdout, result.stderr);
        options.failOnError && process.exit(1);
      }
    }
    // Look for shrinkwrap file
    const swFile = join(
      path,
      "tools",
      "build-tasks",
      ".rush",
      "temp",
      "shrinkwrap-deps.json",
    );
    const pnpmLock = join(path, "common", "config", "rush", "pnpm-lock.yaml");
    if (safeExistsSync(swFile)) {
      let pkgList = await parseNodeShrinkwrap(swFile);
      if (allImports && Object.keys(allImports).length) {
        pkgList = await addEvidenceForImports(
          pkgList,
          allImports,
          allExports,
          options.deep,
        );
      }
      return buildBomNSData(options, pkgList, "npm", {
        allImports,
        src: path,
        filename: "shrinkwrap-deps.json",
      });
    }
    if (safeExistsSync(pnpmLock)) {
      const pnpmLockObj = await parsePnpmLock(pnpmLock);
      if (allImports && Object.keys(allImports).length) {
        pkgList = await addEvidenceForImports(
          pnpmLockObj.pkgList,
          allImports,
          allExports,
          options.deep,
        );
      }
      return buildBomNSData(options, pkgList, "npm", {
        allImports,
        allExports,
        src: path,
        filename: "pnpm-lock.yaml",
      });
    }
    console.log(
      "Neither shrinkwrap file: ",
      swFile,
      " nor pnpm lockfile",
      pnpmLock,
      "was found!",
    );
    options.failOnError && process.exit(1);
  }
  if (
    yarnLockFiles?.length &&
    isPackageManagerAllowed("yarn", ["npm", "pnpm"], options)
  ) {
    manifestFiles = manifestFiles.concat(yarnLockFiles);
    const workspacePackages = [];
    const workspaceSrcFiles = {};
    const workspaceDirectDeps = {};
    const depsWorkspaceRefs = {};
    let workspaceWarningShown = false;
    const seenPkgJsonFiles = {};

    // Check if this is a yarn workspace by examining package.json files for workspace definitions
    const packageJsonFilesWithWorkspaces = yarnLockFiles
      .map((f) => join(dirname(f), "package.json"))
      .filter((pkgFile) => safeExistsSync(pkgFile));

    for (const packageJsonFile of packageJsonFilesWithWorkspaces) {
      const workspaceObj = parseYarnWorkspace(packageJsonFile);
      if (workspaceObj?.packages) {
        if (DEBUG_MODE) {
          console.log(`Found yarn workspace definition in ${packageJsonFile}`);
        }
        // We need the precise purl for all workspace packages and their direct dependencies
        const workspaceBasePath = dirname(packageJsonFile);
        for (const awp of workspaceObj.packages) {
          let wpkgJsonFiles = [];

          // Handle different yarn workspace patterns
          if (awp.includes("*")) {
            // Replace all '*' with '**' for recursive glob matching and ensure package.json suffix
            const pattern =
              awp.replaceAll("*", "**") +
              (awp.endsWith(".json") ? "" : "/package.json");
            wpkgJsonFiles = getAllFiles(workspaceBasePath, pattern, {
              ...options,
              includeNodeModulesDir: false,
            });
          } else {
            // Direct path pattern
            wpkgJsonFiles = getAllFiles(
              join(workspaceBasePath, awp),
              "**/package.json",
              {
                ...options,
                includeNodeModulesDir: false,
              },
            );
          }

          if (!wpkgJsonFiles?.length) {
            if (!workspaceWarningShown) {
              workspaceWarningShown = true;
              console.log(
                `Unable to find any package.json files belonging to the workspace '${awp}' referred in ${packageJsonFile}. To improve SBOM precision, run cdxgen from the directory containing the complete source code.`,
              );
            }
            continue;
          }
          for (const apj of wpkgJsonFiles) {
            if (seenPkgJsonFiles[apj]) {
              continue;
            }
            seenPkgJsonFiles[apj] = true;
            const pkgData = JSON.parse(readFileSync(apj, "utf-8"));
            if (pkgData?.name) {
              const relativePkgJsonFile = relative(path, apj);
              // Create properly encoded PURL using helper function
              const workspaceRef = createNpmWorkspacePurl(
                pkgData.name,
                pkgData.version,
              );
              workspacePackages.push(workspaceRef);
              workspaceSrcFiles[workspaceRef] = relativePkgJsonFile;
              if (pkgData?.dependencies || pkgData?.devDependencies) {
                const dlist = new Set();
                for (const [k, v] of Object.entries({
                  ...(pkgData.dependencies || {}),
                  ...(pkgData.devDependencies || {}),
                })) {
                  if (v.match(/^\d/)) {
                    dlist.add(`pkg:npm/${k}@${v}`);
                  } else {
                    dlist.add(`pkg:npm/${k}`);
                  }
                }
                workspaceDirectDeps[workspaceRef] = Array.from(dlist);
                for (const dep of workspaceDirectDeps[workspaceRef]) {
                  if (!depsWorkspaceRefs[dep]) {
                    depsWorkspaceRefs[dep] = [];
                  }
                  depsWorkspaceRefs[dep].push(workspaceRef);
                }
              }
            }
          }
        }
      }
    }
    for (const f of yarnLockFiles) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      const basePath = dirname(f);
      // Determine the parent component
      const packageJsonF = join(basePath, "package.json");
      if (safeExistsSync(packageJsonF)) {
        const pcs = await parsePkgJson(packageJsonF, true);
        if (pcs.length && Object.keys(pcs[0]).length) {
          const tmpParentComponent = { ...pcs[0] };
          tmpParentComponent.type = "application";
          ppurl = new PackageURL(
            "npm",
            options.projectGroup || tmpParentComponent.group,
            tmpParentComponent.name,
            options.projectVersion || tmpParentComponent.version,
            null,
            null,
          ).toString();
          tmpParentComponent["bom-ref"] = decodeURIComponent(ppurl);
          tmpParentComponent["purl"] = ppurl;
          if (!Object.keys(parentComponent).length) {
            parentComponent = tmpParentComponent;
          } else {
            parentSubComponents.push(tmpParentComponent);
          }
        }
      } else {
        let dirName = dirname(f);
        const tmpA = dirName.split(sep);
        dirName = tmpA[tmpA.length - 1];
        const tmpParentComponent = {
          group: options.projectGroup || "",
          name: "project-name" in options ? options.projectName : dirName,
          type: "application",
        };
        ppurl = new PackageURL(
          "npm",
          tmpParentComponent.group,
          tmpParentComponent.name,
          options.projectVersion || tmpParentComponent.version,
          null,
          null,
        ).toString();
        tmpParentComponent["bom-ref"] = decodeURIComponent(ppurl);
        tmpParentComponent["purl"] = ppurl;
        if (!Object.keys(parentComponent).length) {
          parentComponent = tmpParentComponent;
        } else {
          parentSubComponents.push(tmpParentComponent);
        }
      }
      // Parse yarn.lock if available. This check is after rush.json since
      // rush.js could include yarn.lock :(
      const parsedList = await parseYarnLock(
        f,
        parentComponent,
        workspacePackages,
        workspaceSrcFiles,
        workspaceDirectDeps,
        depsWorkspaceRefs,
      );
      const dlist = parsedList.pkgList;
      if (dlist?.length) {
        pkgList = pkgList.concat(dlist);
      }
      const rdeplist = [];
      if (parsedList?.dependenciesList?.length) {
        // Inject parent component to the dependency tree to make it complete
        // In case of yarn, yarn list command lists every root package as a direct dependency
        // The same logic is matched with this for loop although this is incorrect since even dev dependencies would get included here
        for (const dobj of parsedList.dependenciesList) {
          rdeplist.push(dobj.ref);
        }
        // Fixes: 212. Handle case where there are no package.json to determine the parent package
        // Bug fix: We need to consistently override the parent component group, name and version here
        if (Object.keys(parentComponent).length && parentComponent.name) {
          const ppurl = new PackageURL(
            "npm",
            options.projectGroup || parentComponent.group,
            parentComponent.name,
            options.projectVersion || parentComponent.version,
            null,
            null,
          ).toString();
          parsedList.dependenciesList.push({
            ref: decodeURIComponent(ppurl),
            dependsOn: [...new Set(rdeplist)].sort(),
          });
        }
        dependencies = mergeDependencies(
          dependencies,
          parsedList.dependenciesList,
          parentComponent,
        );
      }
    }
  }
  // We might reach here if the project has no lock files
  // Eg: juice-shop
  if (!pkgList.length && safeExistsSync(join(path, "node_modules"))) {
    // Collect all package.json files from all node_modules directory
    const pkgJsonFiles = getAllFiles(
      path,
      "**/node_modules/**/package.json",
      options,
    );
    manifestFiles = manifestFiles.concat(pkgJsonFiles);
    for (const pkgjf of pkgJsonFiles) {
      const dlist = await parsePkgJson(pkgjf);
      if (dlist?.length) {
        pkgList = pkgList.concat(dlist);
      }
    }
    if (!parentComponent || !Object.keys(parentComponent).length) {
      if (safeExistsSync(join(path, "package.json"))) {
        const pcs = await parsePkgJson(join(path, "package.json"), true);
        if (pcs.length && Object.keys(pcs[0]).length) {
          parentComponent = { ...pcs[0] };
          parentComponent.type = "application";
          ppurl = new PackageURL(
            "npm",
            options.projectGroup || parentComponent.group,
            parentComponent.name,
            options.projectVersion || parentComponent.version,
            null,
            null,
          ).toString();
          parentComponent["bom-ref"] = decodeURIComponent(ppurl);
          parentComponent["purl"] = ppurl;
        }
      }
    }
  }
  if (!pkgList.length && (yarnLockFiles.length || pkgLockFiles.length)) {
    if (options.projectType?.length) {
      thoughtLog(
        `Despite seeing some lock files, I didn't find any components in this Node.js project. Is there an issue with the project type '${options.projectType?.join(", ")}' used 🤔? I recommend trying again with a different type.`,
      );
    } else {
      thoughtLog(
        "Despite seeing some lock files, I didn't find any components in this Node.js project. Feels like a bug.",
      );
    }
  }
  // Retain the components of parent component
  if (parentSubComponents.length) {
    parentComponent.components = parentSubComponents;
  }
  // We need to set this to force our version to be used rather than the directory name based one.
  // Fix #1550. Do not blindly force the npm parent to always become the overall parent.
  if ("project-name" in options && !options.parentComponent) {
    options.parentComponent = parentComponent;
  }
  if (allImports && Object.keys(allImports).length) {
    pkgList = await addEvidenceForImports(
      pkgList,
      allImports,
      allExports,
      options.deep,
    );
  }
  return buildBomNSData(options, pkgList, "npm", {
    src: path,
    filename: manifestFiles.join(", "),
    dependencies,
    parentComponent,
  });
}

/**
 * Function to create bom string for Projects that use Pixi package manager.
 * createPixiBom is based on createPythonBom.
 * Pixi package manager utilizes many languages like python, rust, C/C++, ruby, etc.
 * It produces a Lockfile which help produce reproducible envs across operating systems.
 * This code will look at the operating system of our machine and create a BOM specific to that machine.
 *
 *
 * @param {String} path
 * @param {Object} options
 */
export function createPixiBom(path, options) {
  const allImports = {};
  let metadataFilename = "";
  let dependencies = [];
  let pkgList = [];
  let formulationList = [];
  let parentComponent = createDefaultParentComponent(path, "pypi", options);
  let PixiLockData = {};

  const pixiToml = join(path, "pixi.toml");

  // if pixi.toml file found then we
  // Add parentComponent Details
  const pixiTomlMode = safeExistsSync(pixiToml);
  if (pixiTomlMode) {
    parentComponent = parsePixiTomlFile(pixiToml);
    parentComponent.type = "application";
    const ppurl = new PackageURL(
      "pypi",
      parentComponent.group || "",
      parentComponent.name,
      parentComponent.version || "latest",
      null,
      null,
    ).toString();
    parentComponent["bom-ref"] = decodeURIComponent(ppurl);
    parentComponent["purl"] = ppurl;
  }

  const pixiLockFile = join(path, "pixi.lock");
  const pixiFilesMode = safeExistsSync(pixiLockFile);
  if (pixiFilesMode) {
    // Instead of what we do in createPythonBOM
    // where we install packages and run `getPipFrozenTree`
    // here I assume `pixi.lock` file to contain the accuracte version information
    // across all platforms
    PixiLockData = parsePixiLockFile(pixiLockFile, path);
    metadataFilename = "pixi.lock";
  } else {
    if (options.installDeps) {
      generatePixiLockFile(path);

      const pixiLockFile = join(path, "pixi.lock");
      if (!safeExistsSync(pixiLockFile) && DEBUG_MODE) {
        console.log(
          "Unexpected Error tried to generate pixi.lock file but failed.",
        );
        console.log("This will result in creations of empty BOM.");
      }
      PixiLockData = parsePixiLockFile(pixiLockFile);
      metadataFilename = "pixi.lock";
    } else {
      // If no pixi.lock and installDeps is false
      // then return None and let `createPythonBOM()` handle generation of BOM.
      return null;
    }
  }

  pkgList = PixiLockData.pkgList;
  formulationList = PixiLockData.formulationList;
  dependencies = PixiLockData.dependencies;

  return buildBomNSData(options, pkgList, "pypi", {
    allImports,
    src: path,
    filename: metadataFilename,
    dependencies,
    parentComponent,
    formulationList,
  });
}

/**
 * Function to create bom string for Python projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 */
export async function createPythonBom(path, options) {
  let allImports = {};
  let metadataFilename = "";
  let dependencies = [];
  let pkgList = [];
  let formulationList = [];
  const tempDir = mkdtempSync(join(getTmpDir(), "cdxgen-venv-"));
  let parentComponent = createDefaultParentComponent(path, "pypi", options);
  // We are checking only the root here for pipenv
  const pipenvMode = safeExistsSync(join(path, "Pipfile"));

  // If pixi is used then just return that as output instead
  const pixiLockFile = join(path, "pixi.lock");
  const pixiFilesMode = safeExistsSync(pixiLockFile);
  const pixiToml = join(path, "pixi.toml");
  const pixiTomlMode = safeExistsSync(pixiToml);
  if (pixiTomlMode || pixiFilesMode) {
    const BomNSData = createPixiBom(path, options);
    if (BomNSData) {
      return BomNSData;
    }
  }

  let poetryFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}poetry.lock`,
    options,
  );
  const pdmLockFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}pdm.lock`,
    options,
  );
  if (pdmLockFiles?.length) {
    poetryFiles = poetryFiles.concat(pdmLockFiles);
  }
  let uvLockFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}uv.lock`,
    options,
  );
  if (uvLockFiles?.length) {
    poetryFiles = poetryFiles.concat(uvLockFiles);
  }
  let reqFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}*requirements*.txt`,
    options,
  );
  reqFiles = reqFiles.filter(
    (f) => !f.includes(join("mercurial", "helptext", "internals")),
  );
  const reqDirFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}requirements/*.txt`,
    options,
  );
  const metadataFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/site-packages/**/" : ""}METADATA`,
    options,
  );
  const whlFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}*.whl`,
    options,
  );
  const eggInfoFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}*.egg-info`,
    options,
  );

  // Is this a pyproject based project.
  // TODO: Support nested directories
  const pyProjectFile = join(path, "pyproject.toml");
  const pyProjectMode = safeExistsSync(pyProjectFile);
  if (pyProjectMode) {
    const pyProjMap = parsePyProjectTomlFile(pyProjectFile);
    const tmpParentComponent = pyProjMap.parentComponent;
    if (tmpParentComponent?.name) {
      // Bug fix. Version could be missing in pyproject.toml
      if (!tmpParentComponent.version && parentComponent.version) {
        tmpParentComponent.version = parentComponent.version;
      }
      tmpParentComponent.properties = tmpParentComponent.properties || [];
      tmpParentComponent.properties.push({
        name: "SrcFile",
        value: pyProjectFile,
      });
      parentComponent = tmpParentComponent;
      delete parentComponent.homepage;
      delete parentComponent.repository;
    }
    // Is this a uv project without a lock file?
    if (options.installDeps && pyProjMap.uvMode && !uvLockFiles.length) {
      createUVLock(path, options);
      uvLockFiles = getAllFiles(
        path,
        `${options.multiProject ? "**/" : ""}uv.lock`,
        options,
      );
      if (uvLockFiles?.length) {
        poetryFiles = poetryFiles.concat(uvLockFiles);
      }
    }
  }
  // When we identify uv lock files, do not parse requirements files
  const requirementsMode =
    (reqFiles?.length || reqDirFiles?.length) && !uvLockFiles.length;
  const poetryMode = poetryFiles?.length;

  // TODO: Support for nested directories
  const setupPy = join(path, "setup.py");
  const setupPyMode = safeExistsSync(setupPy);
  // Poetry sets up its own virtual env containing site-packages so
  // we give preference to poetry lock file. Issue# 129
  if (poetryMode) {
    for (const f of poetryFiles) {
      const basePath = dirname(f);
      const lockData = readFileSync(f, { encoding: "utf-8" });
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      let retMap = await parsePyLockData(lockData, f);
      // Should we exit for workspace errors
      if (retMap?.workspaceWarningShown) {
        options.failOnError && process.exit(1);
      }
      if (retMap.pkgList?.length) {
        pkgList = pkgList.concat(retMap.pkgList);
        pkgList = trimComponents(pkgList);
      }
      // Retain the parent hierarchy
      if (retMap?.parentComponent?.components?.length) {
        if (!parentComponent.components) {
          parentComponent.components = [];
        }
        parentComponent.components = parentComponent.components.concat(
          retMap?.parentComponent?.components,
        );
      }
      if (retMap.dependenciesList?.length) {
        dependencies = mergeDependencies(
          dependencies,
          retMap.dependenciesList,
          parentComponent,
        );
      }
      // Retrieve the tree using virtualenv in deep mode and as a fallback
      // This is a slow operation
      if ((options.deep || !dependencies.length) && !f.endsWith("uv.lock")) {
        retMap = await getPipFrozenTree(basePath, f, tempDir, parentComponent);
        if (retMap.pkgList?.length) {
          pkgList = pkgList.concat(retMap.pkgList);
        }
        if (retMap.formulationList?.length) {
          formulationList = formulationList.concat(retMap.formulationList);
        }
        if (retMap.dependenciesList) {
          dependencies = mergeDependencies(
            dependencies,
            retMap.dependenciesList,
            parentComponent,
          );
        }
      }
      if (retMap.rootList) {
        const parentDependsOn = new Set();
        // Complete the dependency tree by making parent component depend on the first level
        for (const p of retMap.rootList) {
          parentDependsOn.add(`pkg:pypi/${p.name.toLowerCase()}@${p.version}`);
        }
        const pdependencies = {
          ref: parentComponent["bom-ref"],
          dependsOn: [...parentDependsOn].sort(),
        };
        dependencies.splice(0, 0, pdependencies);
      }
    }
    options.parentComponent = parentComponent;
  } // poetryMode
  if (metadataFiles?.length) {
    // dist-info directories
    for (const mf of metadataFiles) {
      const mData = readFileSync(mf, {
        encoding: "utf-8",
      });
      const dlist = parseBdistMetadata(mData);
      if (dlist?.length) {
        pkgList = pkgList.concat(dlist);
      }
    }
  }
  // .whl files. Zip file containing dist-info directory
  if (whlFiles?.length) {
    for (const wf of whlFiles) {
      const mData = await readZipEntry(wf, "METADATA");
      if (mData) {
        const dlist = parseBdistMetadata(mData);
        if (dlist?.length) {
          pkgList = pkgList.concat(dlist);
        }
      }
    }
  }
  // .egg-info files
  if (eggInfoFiles?.length) {
    for (const ef of eggInfoFiles) {
      const dlist = parseBdistMetadata(readFileSync(ef, { encoding: "utf-8" }));
      if (dlist?.length) {
        pkgList = pkgList.concat(dlist);
      }
    }
  }
  if (requirementsMode || pipenvMode) {
    if (pipenvMode) {
      // TODO: Support for nested directories
      safeSpawnSync("pipenv", ["install"], { cwd: path, shell: isWin });
      const piplockFile = join(path, "Pipfile.lock");
      if (safeExistsSync(piplockFile)) {
        const lockData = JSON.parse(readFileSync(piplockFile));
        const dlist = await parsePiplockData(lockData);
        if (dlist?.length) {
          pkgList = pkgList.concat(dlist);
        }
      } else {
        console.error("Pipfile.lock not found at", path);
        options.failOnError && process.exit(1);
      }
    } else if (reqDirFiles?.length) {
      for (const j in reqDirFiles) {
        const f = reqDirFiles[j];
        const dlist = await parseReqFile(f, false);
        if (dlist?.length) {
          pkgList = pkgList.concat(dlist);
        }
      }
      metadataFilename = reqDirFiles.join(", ");
    } else if (reqFiles?.length) {
      for (const f of reqFiles) {
        const dlist = await parseReqFile(f, true);
        if (dlist?.length) {
          pkgList = pkgList.concat(dlist);
        }
      }
    }
  }

  const parentDependsOn = new Set();

  // Use atom in requirements, setup.py and pyproject.toml mode
  if (requirementsMode || setupPyMode || pyProjectMode || options.deep) {
    /**
     * The order of preference is pyproject.toml (newer) and then setup.py
     */
    if (options.installDeps) {
      let pkgMap;
      if (pyProjectMode && !poetryMode) {
        pkgMap = await getPipFrozenTree(
          path,
          pyProjectFile,
          tempDir,
          parentComponent,
        );
      } else if (setupPyMode) {
        pkgMap = await getPipFrozenTree(
          path,
          setupPy,
          tempDir,
          parentComponent,
        );
      } else if (requirementsMode && reqFiles?.length) {
        if (options.installDeps && DEBUG_MODE) {
          console.log(
            "cdxgen will now attempt to generate an SBOM for 'build' lifecycle phase for Python. This would take some time ...\nTo speed up this step, invoke cdxgen from within a virtual environment with all the dependencies installed.\nAlternatively, pass the argument '--lifecycle pre-build' to generate a faster but less precise SBOM.",
          );
        }
        for (const f of reqFiles) {
          const basePath = dirname(f);
          if (options.installDeps) {
            const pkgMap = await getPipFrozenTree(
              basePath,
              f,
              tempDir,
              parentComponent,
            );
            if (pkgMap.pkgList?.length) {
              pkgList = pkgList.concat(pkgMap.pkgList);
              pkgList = trimComponents(pkgList);
            }
            if (pkgMap.formulationList?.length) {
              formulationList = formulationList.concat(pkgMap.formulationList);
              formulationList = trimComponents(formulationList);
            }
            if (pkgMap.dependenciesList) {
              dependencies = mergeDependencies(
                dependencies,
                pkgMap.dependenciesList,
                parentComponent,
              );
            }
            // Add the root packages from this file to the parent's dependencies
            for (const p of pkgMap.rootList) {
              if (
                parentComponent &&
                p.name === parentComponent.name &&
                (p.version === parentComponent.version ||
                  p.version === "latest")
              ) {
                continue;
              }
              parentDependsOn.add(
                `pkg:pypi/${p.name.toLowerCase()}@${p.version}`,
              );
            }
          }
        }
      } else if (!poetryMode) {
        pkgMap = await getPipFrozenTree(
          path,
          undefined,
          tempDir,
          parentComponent,
        );
      }

      // ATOM parsedeps block
      // Atom parsedeps slices can be used to identify packages that are not declared in manifests
      // Since it is a slow operation, we only use it as a fallback or in deep mode
      // This change was made in 10.9.2 release onwards
      if (options.deep || !pkgList.length) {
        const retMap = await getPyModules(path, pkgList, options);
        // We need to patch the existing package list to add ImportedModules for evinse to work
        if (retMap.modList?.length) {
          const iSymbolsMap = {};
          retMap.modList.forEach((v) => {
            iSymbolsMap[v.name] = v.importedSymbols;
            iSymbolsMap[v.name.replace(/_/g, "-")] = v.importedSymbols;
          });
          for (const apkg of pkgList) {
            if (iSymbolsMap[apkg.name]) {
              apkg.scope = "required";
              apkg.properties = apkg.properties || [];
              apkg.properties.push({
                name: "ImportedModules",
                value: iSymbolsMap[apkg.name],
              });
            }
          }
        }
        if (retMap.pkgList?.length) {
          pkgList = pkgList.concat(retMap.pkgList);
          for (const p of retMap.pkgList) {
            if (
              !p.version ||
              (parentComponent &&
                p.name === parentComponent.name &&
                (p.version === parentComponent.version ||
                  p.version === "latest"))
            ) {
              continue;
            }
            parentDependsOn.add(
              `pkg:pypi/${p.name.toLowerCase()}@${p.version}`,
            );
          }
        }
        if (retMap.dependenciesList) {
          dependencies = mergeDependencies(
            dependencies,
            retMap.dependenciesList,
            parentComponent,
          );
        }
        if (retMap.allImports) {
          allImports = { ...allImports, ...retMap.allImports };
        }
      }
      // ATOM parsedeps block
      if (pkgMap) {
        // Complete the dependency tree by making parent component depend on the first level
        for (const p of pkgMap.rootList) {
          if (
            parentComponent &&
            p.name === parentComponent.name &&
            (p.version === parentComponent.version || p.version === "latest")
          ) {
            continue;
          }
          parentDependsOn.add(`pkg:pypi/${p.name.toLowerCase()}@${p.version}`);
        }
        if (pkgMap?.pkgList?.length) {
          pkgList = pkgList.concat(pkgMap.pkgList);
        }
        if (pkgMap?.formulationList?.length) {
          formulationList = formulationList.concat(pkgMap.formulationList);
        }
        if (pkgMap?.dependenciesList) {
          dependencies = mergeDependencies(
            dependencies,
            pkgMap.dependenciesList,
            parentComponent,
          );
        }
      }
      let parentPresent = false;
      for (const d of dependencies) {
        if (d.ref === parentComponent["bom-ref"]) {
          parentPresent = true;
          break;
        }
      }
      if (!parentPresent) {
        const pdependencies = {
          ref: parentComponent["bom-ref"],
          dependsOn: Array.from(parentDependsOn).filter(
            (r) => parentComponent && r !== parentComponent["bom-ref"],
          ),
        };
        dependencies.splice(0, 0, pdependencies);
      }
    }
  }

  // Final fallback is to manually parse setup.py if we still
  // have an empty list
  if (!pkgList.length && setupPyMode) {
    const setupPyData = readFileSync(setupPy, { encoding: "utf-8" });
    const dlist = await parseSetupPyFile(setupPyData);
    if (dlist?.length) {
      pkgList = pkgList.concat(dlist);
    }
  }
  // Check and complete the dependency tree
  if (
    isFeatureEnabled(options, "safe-pip-install") &&
    pkgList.length &&
    isPartialTree(dependencies, pkgList.length)
  ) {
    // Trim the current package list first
    pkgList = trimComponents(pkgList);
    console.log(
      `Attempting to recover the pip dependency tree from ${pkgList.length} packages. Please wait ...`,
    );
    const newPkgMap = getPipTreeForPackages(
      path,
      pkgList,
      tempDir,
      parentComponent,
    );
    if (DEBUG_MODE && newPkgMap?.failedPkgList?.length) {
      if (newPkgMap.failedPkgList.length < pkgList.length) {
        console.log(
          `${newPkgMap.failedPkgList.length} packages failed to install.`,
        );
      }
    }
    if (newPkgMap?.pkgList?.length) {
      pkgList = pkgList.concat(newPkgMap.pkgList);
      pkgList = trimComponents(pkgList);
    }
    if (newPkgMap.dependenciesList) {
      dependencies = mergeDependencies(
        dependencies,
        newPkgMap.dependenciesList,
        parentComponent,
      );
      if (DEBUG_MODE && dependencies.length > 1) {
        console.log("Recovered", dependencies.length, "dependencies.");
      }
    }
  }
  // Clean up
  if (tempDir?.startsWith(getTmpDir()) && rmSync) {
    rmSync(tempDir, { recursive: true, force: true });
  }
  // Re-compute the component scope
  pkgList = recomputeScope(pkgList, dependencies);
  if (shouldFetchLicense()) {
    pkgList = await getPyMetadata(pkgList, false);
  }
  return buildBomNSData(options, pkgList, "pypi", {
    allImports,
    src: path,
    filename: metadataFilename,
    dependencies,
    parentComponent,
    formulationList,
  });
}

/**
 * Function to create bom string for Go projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 */
export async function createGoBom(path, options) {
  let pkgList = [];
  let dependencies = [];
  const allImports = {};
  let parentComponent = createDefaultParentComponent(path, "golang", options);
  // Is this a binary file
  let maybeBinary;
  try {
    maybeBinary = statSync(path).isFile();
  } catch (_err) {
    maybeBinary = false;
  }
  if (maybeBinary || options?.lifecycle?.includes("post-build")) {
    return createBinaryBom(path, options);
  }

  // Read in go.sum and merge all go.sum files.
  const gosumFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}go.sum`,
    options,
  );

  // If USE_GOSUM is true|1, generate BOM components only using go.sum.
  const useGosum =
    process.env.USE_GOSUM && ["true", "1"].includes(process.env.USE_GOSUM);
  if (useGosum && gosumFiles.length) {
    console.warn(
      "Using go.sum to generate BOMs for go projects may return an inaccurate representation of transitive dependencies.\nSee: https://github.com/golang/go/wiki/Modules#is-gosum-a-lock-file-why-does-gosum-include-information-for-module-versions-i-am-no-longer-using\n",
      "Set USE_GOSUM=false to generate BOMs using go.mod as the dependency source of truth.",
    );
    for (const f of gosumFiles) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      const gosumData = readFileSync(f, { encoding: "utf-8" });
      const dlist = await parseGosumData(gosumData);
      if (dlist?.length) {
        pkgList = pkgList.concat(dlist);
      }
    }
    const doneList = {};
    let circuitBreak = false;
    if (DEBUG_MODE) {
      console.log(
        `Attempting to detect required packages using "go mod why" command for ${pkgList.length} packages`,
      );
    }
    // Using go mod why detect required packages
    for (const apkg of pkgList) {
      if (circuitBreak) {
        break;
      }
      const pkgFullName = `${apkg.name}`;
      if (apkg.scope === "required") {
        allImports[pkgFullName] = true;
        continue;
      }
      if (
        apkg.scope === "optional" ||
        allImports[pkgFullName] ||
        doneList[pkgFullName]
      ) {
        continue;
      }
      if (DEBUG_MODE) {
        console.log(`go mod why -m -vendor ${pkgFullName}`);
      }
      const mresult = safeSpawnSync(
        "go",
        ["mod", "why", "-m", "-vendor", pkgFullName],
        {
          cwd: path,
        },
      );
      if (mresult.status !== 0 || mresult.error) {
        if (DEBUG_MODE) {
          if (mresult.stdout) {
            console.log(mresult.stdout);
          }
          if (mresult.stderr) {
            console.log(mresult.stderr);
          }
        }
        circuitBreak = true;
      } else {
        const mstdout = mresult.stdout;
        if (mstdout) {
          const cmdOutput = Buffer.from(mstdout).toString();
          const whyPkg = parseGoModWhy(cmdOutput);
          // whyPkg would include this package string
          // github.com/golang/protobuf/proto github.com/golang/protobuf
          // golang.org/x/tools/cmd/goimports golang.org/x/tools
          if (whyPkg?.includes(pkgFullName)) {
            allImports[pkgFullName] = true;
          }
          doneList[pkgFullName] = true;
        }
      }
    }
    if (DEBUG_MODE) {
      console.log(`Required packages: ${Object.keys(allImports).length}`);
    }
    return buildBomNSData(options, pkgList, "golang", {
      src: path,
      dependencies,
      parentComponent,
      filename: gosumFiles.join(", "),
    });
  }

  // If USE_GOSUM is false, generate BOM components using go.mod.
  const gosumMap = {};
  if (gosumFiles.length) {
    for (const f of gosumFiles) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      const gosumData = readFileSync(f, { encoding: "utf-8" });
      const dlist = await parseGosumData(gosumData);
      if (dlist?.length) {
        dlist.forEach((pkg) => {
          gosumMap[`${pkg.name}@${pkg.version}`] = pkg._integrity;
        });
      }
    }
  }

  // Read in data from Gopkg.lock files if they exist
  const gopkgLockFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}Gopkg.lock`,
    options,
  );

  // Read in go.mod files and parse BOM components with checksums from gosumData
  const gomodFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}go.mod`,
    options,
  );
  // Collect any vendored dependencies
  const modulesTxtFiles = getAllFiles(path, "vendor/**/modules.txt", options);
  for (const f of modulesTxtFiles) {
    const dlist = await parseGoModulesTxt(f, gosumMap);
    pkgList = pkgList.concat(dlist);
  }
  if (gomodFiles.length) {
    let shouldManuallyParse = false;
    // Sort go.mod files by depth (shallowest first) to prioritize root modules
    const sortedGomodFiles = gomodFiles.sort((a, b) => {
      const relativePathA = relative(path, a);
      const relativePathB = relative(path, b);
      const depthA = relativePathA.split("/").length;
      const depthB = relativePathB.split("/").length;
      return depthA - depthB;
    });

    let rootParentComponent = null;
    // Use the go list -deps and go mod why commands to generate a good quality BOM for non-docker invocations
    if (
      !hasAnyProjectType(["docker", "oci", "container", "os"], options, false)
    ) {
      for (const f of sortedGomodFiles) {
        const basePath = dirname(f);
        // Ignore vendor packages
        if (
          basePath.includes("/vendor/") ||
          basePath.includes("/build/") ||
          basePath.includes("/test-fixtures/")
        ) {
          continue;
        }
        // First we execute the go list -deps command which gives the correct list of dependencies
        if (DEBUG_MODE) {
          console.log("Executing go list -deps in", basePath);
        }
        let result = safeSpawnSync(
          "go",
          [
            "list",
            "-deps",
            "-f",
            "'{{with .Module}}{{.Path}} {{.Version}} {{.Indirect}} {{.GoMod}} {{.GoVersion}} {{.Main}}{{end}}'",
            "./...",
          ],
          {
            cwd: basePath,
          },
        );
        if (result.status !== 0 || result.error) {
          // go list -deps command may not work when private packages are involved
          // So we support a fallback to only operate with go mod graph command output in such instances
          console.log("go list -deps command has failed for", basePath);
          shouldManuallyParse = true;
          if (DEBUG_MODE && result.stdout) {
            console.log(result.stdout);
          }
          if (DEBUG_MODE && result.stderr) {
            console.log(result.stderr);
          }
          options.failOnError && process.exit(1);
        }
        const stdout = result.stdout;
        if (stdout) {
          let cmdOutput = Buffer.from(stdout).toString();
          const retMap = await parseGoListDep(cmdOutput, gosumMap);
          if (retMap.pkgList?.length) {
            pkgList = pkgList.concat(retMap.pkgList);
          }
          // Prioritize the shallowest module as the root component
          if (
            retMap.parentComponent &&
            Object.keys(retMap.parentComponent).length
          ) {
            if (!rootParentComponent) {
              // First (shallowest) module becomes the root
              rootParentComponent = retMap.parentComponent;
              rootParentComponent.type = "application";
              parentComponent = rootParentComponent;
            } else {
              // Subsequent modules become subcomponents
              if (!parentComponent.components) {
                parentComponent.components = [];
              }
              parentComponent.components.push(retMap.parentComponent);
            }
          }
          if (DEBUG_MODE) {
            console.log("Executing go mod graph in", basePath);
          }
          // Next we use the go mod graph command to construct the dependency tree
          result = safeSpawnSync("go", ["mod", "graph"], {
            cwd: basePath,
          });
          // Check if got a mod graph successfully
          if (result.status !== 0 || result.error) {
            console.log("go mod graph command has failed.");
            if (DEBUG_MODE && result.stdout) {
              console.log(result.stdout);
              if (result?.stdout.includes("unrecognized import path")) {
                console.log(
                  "go couldn't download all the modules, including any private modules. Dependency tree would be missing.",
                );
              }
            }
            if (DEBUG_MODE && result.stderr) {
              console.log(result.stderr);
            }
            options.failOnError && process.exit(1);
          }
          if (result.stdout) {
            cmdOutput = Buffer.from(result.stdout).toString();
            const retMap = await parseGoModGraph(
              cmdOutput,
              f,
              gosumMap,
              pkgList,
              parentComponent,
            );
            if (retMap.pkgList?.length) {
              pkgList = pkgList.concat(retMap.pkgList);
              pkgList = trimComponents(pkgList);
            }
            if (retMap.dependenciesList?.length) {
              dependencies = mergeDependencies(
                dependencies,
                retMap.dependenciesList,
                parentComponent,
              );
            }
            // Retain the parent component hierarchy
            if (Object.keys(retMap.parentComponent).length) {
              parentComponent.components = parentComponent.components || [];
              parentComponent.components.push(retMap.parentComponent);
            }
          }
        } else {
          if (DEBUG_MODE) {
            console.log("Executing go mod graph in", basePath);
          }
          // Next we use the go mod graph command to construct the dependency tree
          result = safeSpawnSync("go", ["mod", "graph"], {
            cwd: basePath,
            shell: isWin,
          });
          if (result.stdout) {
            const cmdOutput = Buffer.from(result.stdout).toString();
            // The arguments to parseGoModGraph are slightly different to force inclusion of all packages
            const retMap = await parseGoModGraph(
              cmdOutput,
              f,
              gosumMap,
              [],
              {},
            );
            if (retMap.pkgList?.length) {
              pkgList = pkgList.concat(retMap.pkgList);
              pkgList = trimComponents(pkgList);
            }
            if (retMap.dependenciesList?.length) {
              dependencies = mergeDependencies(
                dependencies,
                retMap.dependenciesList,
                parentComponent,
              );
            }
            // Retain the parent component hierarchy, prioritizing the shallowest module
            if (Object.keys(retMap.parentComponent).length) {
              if (!rootParentComponent) {
                // First (shallowest) module becomes the root
                rootParentComponent = retMap.parentComponent;
                parentComponent = rootParentComponent;
              } else {
                // Subsequent modules become subcomponents
                parentComponent.components = parentComponent.components || [];
                parentComponent.components.push(retMap.parentComponent);
              }
            }
          } else {
            shouldManuallyParse = true;
            console.log(
              "1. Check if the correct version of golang is installed. Try building the application using go build or make command to troubleshoot.",
            );
            console.log(
              "2. If the application uses private go modules, ensure the environment variable GOPRIVATE is set with the comma-separated repo names.\nEnsure $HOME/.netrc file contains a valid username and password for the private repos.",
            );
            console.log(
              "3. Alternatively, consider generating a post-build SBOM from the built binary using blint. Use the official container image and invoke cdxgen with the arguments `-t binary --lifecycle post-build`.",
            );
            options.failOnError && process.exit(1);
          }
        }
      }
      if (pkgList.length && !shouldManuallyParse) {
        return buildBomNSData(options, pkgList, "golang", {
          allImports,
          dependencies,
          parentComponent,
          src: path,
          filename: sortedGomodFiles.join(", "),
        });
      }
    }
    // Parse the gomod files manually. The resultant BOM would be incomplete
    if (
      !hasAnyProjectType(["docker", "oci", "container", "os"], options, false)
    ) {
      console.log(
        "Manually parsing go.mod files. The resultant BOM would be incomplete.",
      );
    }
    for (const f of sortedGomodFiles) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      const gomodData = readFileSync(f, { encoding: "utf-8" });
      const retMap = await parseGoModData(gomodData, gosumMap);
      if (retMap?.pkgList?.length) {
        pkgList = pkgList.concat(retMap.pkgList);
      }
      // Retain the parent component hierarchy, prioritizing the shallowest module
      if (Object.keys(retMap.parentComponent).length) {
        if (!rootParentComponent) {
          // First (shallowest) module becomes the root
          rootParentComponent = retMap.parentComponent;
          parentComponent = rootParentComponent;
        } else {
          // Subsequent modules become subcomponents
          parentComponent.components = parentComponent.components || [];
          parentComponent.components.push(retMap.parentComponent);
        }
        if (retMap?.rootList?.length) {
          const thisParentDependsOn = [
            {
              ref: retMap.parentComponent["bom-ref"],
              dependsOn: [
                ...new Set(retMap.rootList.map((c) => c["bom-ref"])),
              ].sort(),
            },
          ];
          dependencies = mergeDependencies(
            dependencies,
            thisParentDependsOn,
            parentComponent,
          );
        }
      }
    }
    return buildBomNSData(options, pkgList, "golang", {
      src: path,
      dependencies,
      parentComponent,
      filename: sortedGomodFiles.join(", "),
    });
  }
  if (gopkgLockFiles.length) {
    for (const f of gopkgLockFiles) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      const gopkgData = readFileSync(f, {
        encoding: "utf-8",
      });
      const dlist = await parseGopkgData(gopkgData);
      if (dlist?.length) {
        pkgList = pkgList.concat(dlist);
      }
    }
    return buildBomNSData(options, pkgList, "golang", {
      src: path,
      dependencies,
      parentComponent,
      filename: gopkgLockFiles.join(", "),
    });
  }
  return {};
}

/**
 * Function to create bom string for Rust projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 */
export async function createRustBom(path, options) {
  let pkgList = [];
  let parentComponent = {};
  // Is this a binary file
  let maybeBinary;
  try {
    maybeBinary = statSync(path).isFile();
  } catch (_err) {
    maybeBinary = false;
  }
  if (maybeBinary || options?.lifecycle?.includes("post-build")) {
    return createBinaryBom(path, options);
  }

  // This function assumes that the given path is prioritized, i.e that the
  // Cargo.toml-file directly inside the directory `path` (or the one in the
  // shortest distance from the `path` directory) will be the first returned
  // object. If that assumption is broken, the parent component may be
  // inaccurate.
  const cargoFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}Cargo.toml`,
    options,
  );
  // Attempt to build or generate lock files automatically
  for (const f of cargoFiles) {
    // If there are no cargo.lock files, we can attempt a cargo install when
    //    options.deep is true or options.lifecycle == build or post-build with installDeps
    // Why the need for installDeps? It currently defaults to true, so let's obey if someone wants no installs
    if (
      (options.deep && !hasAnyProjectType(["oci"], options, false)) ||
      (options.installDeps &&
        !safeExistsSync(f.replace(".toml", ".lock")) &&
        ["build", "post-build"].includes(options.lifecycle))
    ) {
      const basePath = dirname(f);
      const cargoArgs = options.deep
        ? ["check", "--all-features", "--manifest-path", f]
        : ["generate-lockfile", "--manifest-path", f];
      if (!DEBUG_MODE) {
        cargoArgs.push("--quiet");
      }
      if (DEBUG_MODE) {
        console.log(
          "Executing ",
          CARGO_CMD,
          cargoArgs.join(" "),
          "in",
          basePath,
        );
      }
      const cargoInstallResult = safeSpawnSync(CARGO_CMD, cargoArgs, {
        cwd: basePath,
        shell: isWin,
      });
      if (cargoInstallResult.status !== 0 || cargoInstallResult.error) {
        console.error("Error running the cargo command");
        console.log(cargoInstallResult.error, cargoInstallResult.stderr);
        options.failOnError && process.exit(1);
      }
    }
  }
  // After running cargo check, .d files would get created
  let pkgFilesMap = {};
  if (options.deep || ["build", "post-build"].includes(options.lifecycle)) {
    const makeDFiles = getAllFiles(path, "target/**/*.d", options);
    for (const dfile of makeDFiles) {
      pkgFilesMap = { ...pkgFilesMap, ...parseMakeDFile(dfile) };
    }
  }
  const cargoLockFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}Cargo.lock`,
    options,
  );
  const cargoLockMode = cargoLockFiles.length;
  for (const f of cargoFiles) {
    if (DEBUG_MODE) {
      console.log(`Parsing ${f}`);
    }
    const dlist = await parseCargoTomlData(f, cargoLockMode, pkgFilesMap);
    if (dlist?.length) {
      if (!cargoLockMode) {
        pkgList = pkgList.concat(dlist);
      } else {
        if (!Object.keys(parentComponent).length) {
          parentComponent = dlist[0];
          parentComponent.type = "application";
          parentComponent.components = [];
          if (DEBUG_MODE) {
            console.log(
              `Assigning parent component "${parentComponent.name}" from ${f}`,
            );
          }
        } else {
          parentComponent.components.push(dlist[0]);
        }
      }
    }
  }
  let dependencyTree = [];
  if (cargoLockMode) {
    for (const f of cargoLockFiles) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      const dlist = await parseCargoData(f, false, pkgFilesMap);
      if (dlist?.length) {
        pkgList = pkgList.concat(dlist);
      }

      if (DEBUG_MODE) {
        console.log(`Constructing dependency tree from ${f}`);
      }
      const cargoLockData = readFileSync(f, { encoding: "utf-8" });
      const fileDependencylist = parseCargoDependencyData(cargoLockData);
      if (fileDependencylist?.length) {
        dependencyTree = mergeDependencies(
          dependencyTree,
          fileDependencylist,
          parentComponent,
        );
      }
    }
  }
  return buildBomNSData(options, pkgList, "cargo", {
    src: path,
    filename: cargoLockFiles.join(", "),
    dependencies: dependencyTree,
    parentComponent,
  });
}

/**
 * Function to create bom string for Dart projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 */
export async function createDartBom(path, options) {
  const pubFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}pubspec.lock`,
    options,
  );
  const pubSpecYamlFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}pubspec.yaml`,
    options,
  );
  let dependencies = [];
  let pkgList = [];
  let parentComponent;
  if (pubSpecYamlFiles.length) {
    for (const f of pubSpecYamlFiles) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      const pubYamlData = readFileSync(f, { encoding: "utf-8" });
      const dlist = parsePubYamlData(pubYamlData);
      if (dlist?.length) {
        pkgList = pkgList.concat(dlist);
        if (!parentComponent) {
          parentComponent = pkgList[0];
          parentComponent.type = "application";
        }
      }
    }
  }
  if (pubFiles.length) {
    for (const f of pubFiles) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      const pubLockData = readFileSync(f, { encoding: "utf-8" });
      const retMap = await parsePubLockData(pubLockData, f);
      if (retMap.pkgList?.length) {
        pkgList = pkgList.concat(retMap.pkgList);
      }
      if (retMap?.rootList?.length) {
        const thisParentDependsOn = [
          {
            ref: parentComponent["bom-ref"],
            dependsOn: [
              ...new Set(retMap.rootList.map((c) => c["bom-ref"])),
            ].sort(),
          },
        ];
        dependencies = mergeDependencies(
          dependencies,
          thisParentDependsOn,
          parentComponent,
        );
      }
    }
  }
  return buildBomNSData(options, pkgList, "pub", {
    src: path,
    dependencies,
    parentComponent,
    filename: pubFiles.join(", "),
  });
}

/**
 * Function to create bom string for cpp projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 */
export function createCppBom(path, options) {
  let parentComponent;
  let dependencies = [];
  const addedParentComponentsMap = {};
  const conanLockFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}conan.lock`,
    options,
  );
  const conanFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}conanfile.txt`,
    options,
  );
  let cmakeLikeFiles = [];
  const mesonBuildFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}meson.build`,
    options,
  );
  if (mesonBuildFiles?.length) {
    cmakeLikeFiles = cmakeLikeFiles.concat(mesonBuildFiles);
  }
  cmakeLikeFiles = cmakeLikeFiles.concat(
    getAllFiles(
      path,
      `${options.multiProject ? "**/" : ""}CMakeLists.txt`,
      options,
    ),
  );
  const cmakeFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}*.cmake`,
    options,
  );
  if (cmakeFiles?.length) {
    cmakeLikeFiles = cmakeLikeFiles.concat(cmakeFiles);
  }
  let pkgList = [];
  let parentComponentDependencies = [];
  if (conanLockFiles.length) {
    for (const f of conanLockFiles) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      const conanLockData = readFileSync(f, { encoding: "utf-8" });
      const {
        pkgList: conanPkgList,
        dependencies: conanDependencies,
        parentComponentDependencies: parentCompDeps,
      } = parseConanLockData(conanLockData);

      if (conanPkgList.length) {
        pkgList = pkgList.concat(conanPkgList);
      }

      if (Object.keys(conanDependencies).length) {
        dependencies = mergeDependencies(
          dependencies,
          Object.keys(conanDependencies).map((dependentBomRef) => ({
            ref: dependentBomRef,
            dependsOn: conanDependencies[dependentBomRef],
          })),
        );
      }

      parentComponentDependencies = parentCompDeps;
    }
  } else if (conanFiles.length) {
    for (const f of conanFiles) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      const conanData = readFileSync(f, { encoding: "utf-8" });
      const dlist = parseConanData(conanData);
      if (dlist?.length) {
        pkgList = pkgList.concat(dlist);
      }
    }
  }
  if (cmakeLikeFiles.length) {
    for (const f of cmakeLikeFiles) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      const basePath = dirname(f);
      const retMap = parseCmakeLikeFile(f, "generic");
      if (retMap.pkgList?.length) {
        pkgList = pkgList.concat(retMap.pkgList);
      }
      if (
        basePath === path &&
        retMap.parentComponent &&
        Object.keys(retMap.parentComponent).length
      ) {
        if (!parentComponent) {
          parentComponent = retMap.parentComponent;
        } else {
          parentComponent.components = parentComponent.components || [];
          if (!addedParentComponentsMap[retMap.parentComponent.name]) {
            parentComponent.components.push(retMap.parentComponent);
            addedParentComponentsMap[retMap.parentComponent.name] = true;
          }
        }
      } else if (
        retMap.parentComponent &&
        Object.keys(retMap.parentComponent).length &&
        !addedParentComponentsMap[retMap.parentComponent.name]
      ) {
        retMap.parentComponent.type = "library";
        pkgList.push(retMap.parentComponent);
      }
      // Retain the dependency tree from cmake
      if (retMap.dependenciesList) {
        if (dependencies.length) {
          dependencies = mergeDependencies(
            dependencies,
            retMap.dependenciesList,
            parentComponent,
          );
        } else {
          dependencies = retMap.dependenciesList;
        }
      }
    }
  }
  // The need for java >= 21 with atom is causing confusions since there could be C projects
  // inside of other project types. So we currently limit this analyis only when -t argument
  // is used.
  if (
    !hasAnyProjectType(["docker", "oci", "container", "os"], options, false) &&
    (!options.createMultiXBom || options.deep)
  ) {
    let osPkgsList = [];
    // Case 1: Development libraries installed in this OS environment might be used for build
    // We collect OS packages with the word dev in the name using osquery here
    // rpm, deb and ebuild are supported
    // TODO: For archlinux and alpine users we need a different mechanism to collect this information
    for (const queryCategory of Object.keys(cosDbQueries)) {
      const queryObj = cosDbQueries[queryCategory];
      const results = executeOsQuery(queryObj.query);
      const dlist = convertOSQueryResults(
        queryCategory,
        queryObj,
        results,
        true,
      );
      if (dlist?.length) {
        osPkgsList = osPkgsList.concat(dlist);
      }
    }
    // Now we check with atom and attempt to detect all external modules via usages
    // We pass the current list of packages so that we enhance the current list and replace
    // components inadvertently. For example, we might resolved a name, version and url information already via cmake
    const retMap = getCppModules(path, options, osPkgsList, pkgList);
    if (retMap.pkgList?.length) {
      pkgList = pkgList.concat(retMap.pkgList);
    }
    if (retMap.dependenciesList) {
      if (dependencies.length) {
        dependencies = mergeDependencies(
          dependencies,
          retMap.dependenciesList,
          parentComponent,
        );
      } else {
        dependencies = retMap.dependenciesList;
      }
    }
    if (!parentComponent) {
      parentComponent = retMap.parentComponent;
    } else {
      parentComponent.components = parentComponent.components || [];
      if (
        retMap?.parentComponent?.name &&
        !addedParentComponentsMap[retMap.parentComponent.name]
      ) {
        parentComponent.components.push(retMap.parentComponent);
        addedParentComponentsMap[retMap.parentComponent.name] = true;
      }
    }
  }
  if (!options.createMultiXBom) {
    if (!parentComponent) {
      parentComponent = createDefaultParentComponent(path, "generic", options);
    }
    options.parentComponent = parentComponent;
  }

  if (parentComponent && parentComponentDependencies.length) {
    dependencies = mergeDependencies(dependencies, [
      {
        ref: parentComponent["bom-ref"],
        dependsOn: parentComponentDependencies,
      },
    ]);
  }

  return buildBomNSData(options, pkgList, "generic", {
    src: path,
    parentComponent,
    dependencies,
  });
}

/**
 * Function to create bom string for clojure projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 */
export function createClojureBom(path, options) {
  const ednFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}deps.edn`,
    options,
  );
  const leinFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}project.clj`,
    options,
  );
  let pkgList = [];
  if (leinFiles.length) {
    let LEIN_ARGS = ["deps", ":tree-data"];
    if (process.env.LEIN_ARGS) {
      LEIN_ARGS = process.env.LEIN_ARGS.split(" ");
    }
    for (const f of leinFiles) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      const basePath = dirname(f);
      console.log("Executing", LEIN_CMD, "in", basePath);
      const result = safeSpawnSync(LEIN_CMD, LEIN_ARGS, {
        cwd: basePath,
      });
      if (result.status !== 0 || result.error) {
        if (result.stderr) {
          console.error(result.stdout, result.stderr);
          options.failOnError && process.exit(1);
        }
        console.log(
          "Check if the correct version of lein is installed and available in PATH. Falling back to manual parsing.",
        );
        if (DEBUG_MODE) {
          console.log(`Parsing ${f}`);
        }
        const leinData = readFileSync(f, { encoding: "utf-8" });
        const dlist = parseLeiningenData(leinData);
        if (dlist?.length) {
          pkgList = pkgList.concat(dlist);
        }
      } else {
        const stdout = result.stdout;
        if (stdout) {
          const cmdOutput = Buffer.from(stdout).toString();
          const dlist = parseLeinDep(cmdOutput);
          if (dlist?.length) {
            pkgList = pkgList.concat(dlist);
          }
        } else {
          console.error("lein unexpectedly didn't return any output");
          options.failOnError && process.exit(1);
        }
      }
    }
    return buildBomNSData(options, pkgList, "clojars", {
      src: path,
      filename: leinFiles.join(", "),
    });
  }
  if (ednFiles.length && !hasAnyProjectType(["oci"], options, false)) {
    let CLJ_ARGS = ["-Stree"];
    if (process.env.CLJ_ARGS) {
      CLJ_ARGS = process.env.CLJ_ARGS.split(" ");
    }
    for (const f of ednFiles) {
      const basePath = dirname(f);
      console.log("Executing", CLJ_CMD, "in", basePath);
      const result = safeSpawnSync(CLJ_CMD, CLJ_ARGS, {
        cwd: basePath,
      });
      if (result.status !== 0 || result.error) {
        if (result.stderr) {
          console.error(result.stdout, result.stderr);
          options.failOnError && process.exit(1);
        }
        console.log(
          "Check if the correct version of clojure cli is installed and available in PATH. Falling back to manual parsing.",
        );
        if (DEBUG_MODE) {
          console.log(`Parsing ${f}`);
        }
        const ednData = readFileSync(f, { encoding: "utf-8" });
        const dlist = parseEdnData(ednData);
        if (dlist?.length) {
          pkgList = pkgList.concat(dlist);
        }
      } else {
        const stdout = result.stdout;
        if (stdout) {
          const cmdOutput = Buffer.from(stdout).toString();
          const dlist = parseCljDep(cmdOutput);
          if (dlist?.length) {
            pkgList = pkgList.concat(dlist);
          }
        } else {
          console.error("clj unexpectedly didn't return any output");
          options.failOnError && process.exit(1);
        }
      }
    }
    return buildBomNSData(options, pkgList, "clojars", {
      src: path,
      filename: ednFiles.join(", "),
    });
  }

  return {};
}

/**
 * Function to create bom string for Haskell projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 */
export function createHaskellBom(path, options) {
  const cabalFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}cabal.project.freeze`,
    options,
  );
  let pkgList = [];
  if (cabalFiles.length) {
    for (const f of cabalFiles) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      const cabalData = readFileSync(f, { encoding: "utf-8" });
      const dlist = parseCabalData(cabalData);
      if (dlist?.length) {
        pkgList = pkgList.concat(dlist);
      }
    }
    return buildBomNSData(options, pkgList, "hackage", {
      src: path,
      filename: cabalFiles.join(", "),
    });
  }
  return {};
}

/**
 * Function to create bom string for Elixir projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 */
export function createElixirBom(path, options) {
  const mixFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}mix.lock`,
    options,
  );
  let pkgList = [];
  if (mixFiles.length) {
    for (const f of mixFiles) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      const mixData = readFileSync(f, { encoding: "utf-8" });
      const dlist = parseMixLockData(mixData);
      if (dlist?.length) {
        pkgList = pkgList.concat(dlist);
      }
    }
    return buildBomNSData(options, pkgList, "hex", {
      src: path,
      filename: mixFiles.join(", "),
    });
  }
  return {};
}

/**
 * Function to create bom string for GitHub action workflows
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 */
export function createGitHubBom(path, options) {
  const ghactionFiles = getAllFiles(
    path,
    ".github/workflows/" + "*.{yml,yaml}",
    options,
  );
  let pkgList = [];
  if (ghactionFiles.length) {
    for (const f of ghactionFiles) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      const dlist = parseGitHubWorkflowData(f);
      if (dlist?.length) {
        pkgList = pkgList.concat(dlist);
      }
    }
    return buildBomNSData(options, pkgList, "github", {
      src: path,
      filename: ghactionFiles.join(", "),
    });
  }
  return {};
}

/**
 * Function to create bom string for cloudbuild yaml
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 */
export function createCloudBuildBom(path, options) {
  const cbFiles = getAllFiles(path, "cloudbuild.yml", options);
  let pkgList = [];
  if (cbFiles.length) {
    for (const f of cbFiles) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      const cbwData = readFileSync(f, { encoding: "utf-8" });
      const dlist = parseCloudBuildData(cbwData);
      if (dlist?.length) {
        pkgList = pkgList.concat(dlist);
      }
    }
    return buildBomNSData(options, pkgList, "cloudbuild", {
      src: path,
      filename: cbFiles.join(", "),
    });
  }
  return {};
}

/**
 * Function to create obom string for the current OS using osquery
 *
 * @param {string} _path to the project
 * @param {Object} options Parse options from the cli
 */
export function createOSBom(_path, options) {
  console.warn(
    "About to generate OBOM for the current OS installation. This will take several minutes ...",
  );
  let pkgList = [];
  let bomData = {};
  let parentComponent = {};
  for (const queryCategory of Object.keys(osQueries)) {
    const queryObj = osQueries[queryCategory];
    const results = executeOsQuery(queryObj.query);
    const dlist = convertOSQueryResults(
      queryCategory,
      queryObj,
      results,
      false,
    );
    if (dlist?.length) {
      if (!Object.keys(parentComponent).length) {
        parentComponent = dlist.splice(0, 1)[0];
      }
      pkgList = pkgList.concat(
        dlist.sort((a, b) => a.name.localeCompare(b.name)),
      );
    }
  } // for
  if (pkgList.length) {
    bomData = buildBomNSData(options, pkgList, "", {
      src: "",
      filename: "",
      parentComponent,
    });
  }
  options.bomData = bomData;
  options.multiProject = true;
  options.installDeps = false;
  options.parentComponent = parentComponent;
  // Force the project type to os
  options.projectType = ["os"];
  options.lastWorkingDir = undefined;
  options.allLayersExplodedDir = isWin ? "C:\\" : "";
  const exportData = {
    lastWorkingDir: undefined,
    allLayersDir: options.allLayersExplodedDir,
    allLayersExplodedDir: options.allLayersExplodedDir,
  };
  const pkgPathList = [];
  if (options.deep) {
    getPkgPathList(exportData, undefined);
  }
  return createMultiXBom(pkgPathList, options);
}

/**
 * Function to create bom string for Jenkins plugins
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 */
export async function createJenkinsBom(path, options) {
  let pkgList = [];
  const hpiFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}*.hpi`,
    options,
  );
  const tempDir = mkdtempSync(join(getTmpDir(), "hpi-deps-"));
  if (hpiFiles.length) {
    for (const f of hpiFiles) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      const dlist = await extractJarArchive(f, tempDir);
      if (dlist?.length) {
        pkgList = pkgList.concat(dlist);
      }
    }
  }
  const jsFiles = getAllFiles(tempDir, "**/*.js", options);
  if (jsFiles.length) {
    for (const f of jsFiles) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      const dlist = await parseMinJs(f);
      if (dlist?.length) {
        pkgList = pkgList.concat(dlist);
      }
    }
  }
  // Clean up
  if (tempDir?.startsWith(getTmpDir()) && rmSync) {
    console.log(`Cleaning up ${tempDir}`);
    rmSync(tempDir, { recursive: true, force: true });
  }
  return buildBomNSData(options, pkgList, "maven", {
    src: path,
    filename: hpiFiles.join(", "),
    nsMapping: {},
  });
}

/**
 * Function to create bom string for Helm charts
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 */
export function createHelmBom(path, options) {
  let pkgList = [];
  const yamlFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}*.yaml`,
    options,
  );
  if (yamlFiles.length) {
    for (const f of yamlFiles) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      const helmData = readFileSync(f, { encoding: "utf-8" });
      const dlist = parseHelmYamlData(helmData);
      if (dlist?.length) {
        pkgList = pkgList.concat(dlist);
      }
    }
    return buildBomNSData(options, pkgList, "helm", {
      src: path,
      filename: yamlFiles.join(", "),
    });
  }
  return {};
}

/**
 * Function to create bom string for swift projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 */
export async function createSwiftBom(path, options) {
  const swiftFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}Package*.swift`,
    options,
  );
  const pkgResolvedFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}Package.resolved`,
    options,
  );
  let pkgList = [];
  let dependencies = [];
  let parentComponent = {};
  const completedPath = [];
  let packageArgsMessageShown = false;
  if (pkgResolvedFiles.length) {
    for (const f of pkgResolvedFiles) {
      if (!parentComponent || !Object.keys(parentComponent).length) {
        parentComponent = createDefaultParentComponent(f, "swift", options);
      }
      if (DEBUG_MODE) {
        console.log("Parsing", f);
      }
      const dlist = parseSwiftResolved(f);
      if (dlist?.length) {
        pkgList = pkgList.concat(dlist);
      }
    }
    thoughtLog(
      `It looks like we have ${pkgResolvedFiles.length} Package.resolved files, which is good. To compute the dependency tree, let's try using the swift package command 📦.`,
    );
  }
  if (swiftFiles.length) {
    for (const f of swiftFiles) {
      const basePath = dirname(f);
      if (completedPath.includes(basePath)) {
        continue;
      }
      let treeData;
      let packageArgs = ["package"];
      // Additional arguments to pass to the swift package command.
      // Example: --swift-sdks-path <swift-sdks-path> --jobs <jobs>
      if (process.env.SWIFT_PACKAGE_ARGS) {
        packageArgs = packageArgs.concat(
          process.env.SWIFT_PACKAGE_ARGS.split(" "),
        );
        if (!packageArgsMessageShown) {
          thoughtLog(
            `Wait, let's use the additional arguments '${process.env.SWIFT_PACKAGE_ARGS}' for the swift package command.`,
          );
          packageArgsMessageShown = true;
        }
      }
      packageArgs = packageArgs.concat([
        "show-dependencies",
        "--format",
        "json",
      ]);
      let swiftCommand = SWIFT_CMD;
      if (swiftCommand.startsWith("xcrun")) {
        swiftCommand = "xcrun";
        packageArgs = ["swift"].concat(packageArgs);
      }
      if (DEBUG_MODE) {
        console.log(
          `Executing '${swiftCommand} ${packageArgs.join(" ")}' in ${basePath}. Please wait ...`,
        );
      }
      const result = safeSpawnSync(swiftCommand, packageArgs, {
        cwd: basePath,
      });
      if (result.stdout) {
        completedPath.push(basePath);
        treeData = Buffer.from(result.stdout).toString();
        const retData = parseSwiftJsonTree(treeData, f);
        if (retData.rootList?.length) {
          if (!Object.keys(parentComponent).length) {
            parentComponent = retData.rootList[0];
            if (retData.rootList.length > 1) {
              if (!parentComponent.components) {
                parentComponent.components = [];
              }
              for (const p of retData.rootList.splice(0, 1)) {
                parentComponent.components.push(p);
              }
            }
          } else {
            if (!parentComponent.components) {
              parentComponent.components = [];
            }
            parentComponent.components.concat(retData.rootList);
          }
        }
        pkgList = pkgList.concat(retData.pkgList);
        if (retData.dependenciesList) {
          dependencies = mergeDependencies(
            dependencies,
            retData.dependenciesList,
            parentComponent,
          );
        }
      }
      if (result.status !== 0 || result.error) {
        if (result?.stderr?.includes("Source files for target")) {
          console.log(
            "The Sources directory is missing. Please run cdxgen from the directory that contains the complete source code.",
          );
          thoughtLog(
            `It looks like the 'Sources' directory is missing, so we are missing the components and dependencies for '${basename(basePath)}'.`,
          );
        } else if (process.env.CDXGEN_IN_CONTAINER !== "true") {
          console.log(
            "Consider using the cdxgen container image (`ghcr.io/cyclonedx/cdxgen`), which includes Swift and additional build tools.",
          );
          if (!isMac) {
            console.log("Alternatively, try building this project from a Mac.");
            thoughtLog(
              "I'm wondering if the results might be better on a Mac 🤔.",
            );
          }
        }
        console.error(result.stderr);
        options.failOnError && process.exit(1);
      }
    }
  }
  if (shouldFetchLicense()) {
    pkgList = await getSwiftPackageMetadata(pkgList);
  }
  return buildBomNSData(options, pkgList, "swift", {
    src: path,
    filename: swiftFiles.join(", "),
    parentComponent,
    dependencies,
  });
}

/**
 * Function to create bom string for cocoa projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 */
export async function createCocoaBom(path, options) {
  const cocoaFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}Podfile`,
    options,
  );
  if (cocoaFiles.length > 1) {
    thoughtLog(
      `There are ${cocoaFiles.length} pod files. I will carefully process each one.`,
    );
  }
  let excludeMessageShown = false;
  for (const podFile of cocoaFiles) {
    const projectPath = dirname(podFile);
    const lockFile = `${podFile}.lock`;
    if (!existsSync(lockFile) || options.deep) {
      if (options.installDeps) {
        executePodCommand(["install"], projectPath, options);
      } else {
        console.log(
          "No 'Podfile.lock' found and '--no-install-deps' is set -- A Podfile.lock is needed to parse dependencies!",
        );
        options.failOnError && process.exit(1);
      }
    }
    const parentComponent = await buildObjectForCocoaPod(
      {
        name: basename(projectPath),
        version: "latest",
      },
      undefined,
      "application",
    );
    const podfileLock = loadYaml(readFileSync(lockFile, "utf-8"));
    const pods = await parsePodfileLock(podfileLock, projectPath);
    const allObjects = new Map();
    for (const [name, pod] of pods) {
      allObjects.set(name, await buildObjectForCocoaPod(pod.metadata, options));
    }
    const allDependencies = new Map();
    for (const [name, pod] of pods) {
      const podDependencies = new Set();
      if (pod.dependencies) {
        for (const podDependency of pod.dependencies) {
          podDependencies.add(podDependency.name);
        }
      }
      allDependencies.set(name, podDependencies);
    }
    const targetDependencies = new Map();
    if (
      !process.env.COCOA_INCLUDED_TARGETS &&
      !process.env.COCOA_EXCLUDED_TARGETS
    ) {
      targetDependencies.set("Pods", podfileLock["DEPENDENCIES"]);
    } else {
      const result = executePodCommand(
        ["ipc", "podfile-json", "--silent", podFile],
        projectPath,
        options,
      );
      const resolvedPodFile = JSON.parse(result.stdout);
      parsePodfileTargets(
        resolvedPodFile["target_definitions"][0],
        targetDependencies,
      );
    }
    const usedTargets = new Set(
      process.env.COCOA_INCLUDED_TARGETS
        ? process.env.COCOA_INCLUDED_TARGETS.split(",")
        : targetDependencies.keys(),
    );
    if (process.env.COCOA_EXCLUDED_TARGETS) {
      process.env.COCOA_EXCLUDED_TARGETS.split(",").forEach(
        (excludedTarget) => {
          usedTargets.delete(excludedTarget);
        },
      );
      if (!excludeMessageShown) {
        thoughtLog(
          "Wait, the user wants me to exclude certain targets from this CocoaPods project. Perhaps they don't want dev and test projects included in the SBOM 🤔?",
        );
        excludeMessageShown = true;
      }
    }
    let addedObjects = new Set();
    for (const target of usedTargets) {
      if (targetDependencies.has(target)) {
        for (const dependency of targetDependencies.get(target)) {
          let dependencyName = parseCocoaDependency(dependency, false).name;
          if (!["false", "0"].includes(process.env.COCOA_MERGE_SUBSPECS)) {
            dependencyName = dependencyName.split("/")[0];
          }
          addedObjects.add(dependencyName);
        }
      }
    }
    let includedDependencies = [
      {
        ref: parentComponent["bom-ref"],
        dependsOn: [
          ...new Set(
            [...addedObjects].map((obj) => allObjects.get(obj)["bom-ref"]),
          ),
        ],
      },
    ];
    const includedObjects = new Set(addedObjects);
    while (addedObjects.size !== 0) {
      const newlyAddedObjects = new Set();
      for (const addedObject of addedObjects) {
        for (const dependency of allDependencies.get(addedObject)) {
          if (!includedObjects.has(dependency)) {
            includedObjects.add(dependency);
            newlyAddedObjects.add(dependency);
          }
        }
      }
      addedObjects = newlyAddedObjects;
    }
    for (const object of includedObjects) {
      includedDependencies = mergeDependencies(includedDependencies, [
        {
          ref: allObjects.get(object)["bom-ref"],
          dependsOn: [
            ...new Set(
              [...allDependencies.get(object)].map(
                (obj) => allObjects.get(obj)["bom-ref"],
              ),
            ),
          ],
        },
      ]);
    }
    return buildBomNSData(
      options,
      [...includedObjects].map((obj) => allObjects.get(obj)),
      "cocoapods",
      {
        src: path,
        filename: lockFile,
        dependencies: includedDependencies,
        parentComponent,
      },
    );
  }
}

/**
 * Function to create bom string for Nix flakes
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 */
export async function createNixBom(path, options) {
  let pkgList = [];
  let dependencies = [];
  let parentComponent = {};

  const flakeNixFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}flake.nix`,
    options,
  );
  const flakeLockFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}flake.lock`,
    options,
  );

  for (const flakeNixFile of flakeNixFiles) {
    if (DEBUG_MODE) {
      console.log(`Parsing ${flakeNixFile}`);
    }
    const { pkgList: nixPkgs, dependencies: nixDeps } =
      parseFlakeNix(flakeNixFile);
    if (nixPkgs?.length) {
      pkgList = pkgList.concat(nixPkgs);
    }
    if (nixDeps?.length) {
      dependencies = dependencies.concat(nixDeps);
    }
  }

  for (const flakeLockFile of flakeLockFiles) {
    if (DEBUG_MODE) {
      console.log(`Parsing ${flakeLockFile}`);
    }
    const { pkgList: lockPkgs, dependencies: lockDeps } =
      parseFlakeLock(flakeLockFile);
    if (lockPkgs?.length) {
      const mergedPkgs = [];
      const existingNames = new Set();

      for (const lockPkg of lockPkgs) {
        mergedPkgs.push(lockPkg);
        existingNames.add(lockPkg.name);
      }

      for (const nixPkg of pkgList) {
        if (!existingNames.has(nixPkg.name)) {
          mergedPkgs.push(nixPkg);
        }
      }

      pkgList = mergedPkgs;
    }
    if (lockDeps?.length) {
      dependencies = dependencies.concat(lockDeps);
    }

    // Create parent component from flake.lock if found
    if (!Object.keys(parentComponent).length) {
      const flakeDir = dirname(flakeLockFile);
      const projectName = basename(flakeDir);
      parentComponent = {
        type: "application",
        name: projectName,
        version: "latest",
        description: `Nix flake project: ${projectName}`,
        "bom-ref": `pkg:nix/${projectName}@latest`,
        properties: [
          {
            name: "SrcFile",
            value: flakeLockFile,
          },
          {
            name: "cdx:nix:flake_dir",
            value: flakeDir,
          },
        ],
      };
    }
  }

  // If no parent component was created from flake.lock, create one from flake.nix
  if (!Object.keys(parentComponent).length && flakeNixFiles.length > 0) {
    const flakeDir = dirname(flakeNixFiles[0]);
    const projectName = basename(flakeDir);
    parentComponent = {
      type: "application",
      name: projectName,
      version: "latest",
      description: `Nix flake project: ${projectName}`,
      "bom-ref": `pkg:nix/${projectName}@latest`,
      properties: [
        {
          name: "SrcFile",
          value: flakeNixFiles[0],
        },
        {
          name: "cdx:nix:flake_dir",
          value: flakeDir,
        },
      ],
    };
  }

  if (pkgList.length || Object.keys(parentComponent).length) {
    return buildBomNSData(options, pkgList, "nix", {
      src: path,
      filename: [...flakeNixFiles, ...flakeLockFiles].join(", "),
      dependencies,
      parentComponent,
    });
  }

  return {};
}

/**
 * Function to create bom string for docker compose
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 */
export async function createContainerSpecLikeBom(path, options) {
  let services = [];
  const ociSpecs = [];
  let components = [];
  let parentComponent = {};
  let dependencies = [];
  const doneimages = [];
  const skippedImageSrcs = [];
  const doneservices = [];
  const origProjectType = options.projectType;
  let dcFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}*.yml`,
    options,
  );
  const dfFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}*Dockerfile*`,
    options,
  );
  const bbPipelineFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}bitbucket-pipelines.yml`,
    options,
  );
  const cfFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}*Containerfile*`,
    options,
  );
  const yamlFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}*.yaml`,
    options,
  );
  let oapiFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}open*.json`,
    options,
  );
  const oapiYamlFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}open*.yaml`,
    options,
  );
  if (oapiYamlFiles?.length) {
    oapiFiles = oapiFiles.concat(oapiYamlFiles);
  }
  if (yamlFiles.length) {
    dcFiles = dcFiles.concat(yamlFiles);
  }
  // Privado.ai json files
  const privadoFiles = getAllFiles(path, ".privado/" + "*.json", options);

  // Parse yaml manifest files, dockerfiles, containerfiles or bitbucket pipeline files
  if (
    dcFiles.length ||
    dfFiles.length ||
    cfFiles.length ||
    bbPipelineFiles.length
  ) {
    for (const f of [...dcFiles, ...dfFiles, ...cfFiles, ...bbPipelineFiles]) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }

      const dData = readFileSync(f, { encoding: "utf-8" });
      let imgList = [];
      // parse yaml manifest files
      if (f.endsWith("bitbucket-pipelines.yml")) {
        imgList = parseBitbucketPipelinesFile(dData);
      } else if (f.endsWith(".yml") || f.endsWith(".yaml")) {
        imgList = parseContainerSpecData(dData);
      } else {
        imgList = parseContainerFile(dData);
      }

      if (imgList?.length) {
        if (DEBUG_MODE) {
          console.log("Images identified in", f, "are", imgList);
        }
        for (const img of imgList) {
          const commonProperties = [
            {
              name: "SrcFile",
              value: f,
            },
          ];
          if (img.image) {
            commonProperties.push({
              name: "oci:SrcImage",
              value: img.image,
            });
          }
          if (img.service) {
            commonProperties.push({
              name: "ServiceName",
              value: img.service,
            });
          }

          // img could have .service, .ociSpec or .image
          if (img.ociSpec) {
            console.log(
              `NOTE: ${img.ociSpec} needs to built using docker or podman and referred with a name to get included in this SBOM.`,
            );
            ociSpecs.push({
              group: "",
              name: img.ociSpec,
              version: "latest",
              properties: commonProperties,
            });
          }
          if (img.service) {
            let version = "latest";
            let name = img.service;
            if (img.service.includes(":")) {
              const tmpA = img.service.split(":");
              if (tmpA && tmpA.length === 2) {
                name = tmpA[0];
                version = tmpA[1];
              }
            }
            const servbomRef = `urn:service:${name}:${version}`;
            if (!doneservices.includes(servbomRef)) {
              services.push({
                "bom-ref": servbomRef,
                name: name,
                version: version,
                group: "",
                properties: commonProperties,
              });
              doneservices.push(servbomRef);
            }
          }
          if (img.image) {
            if (doneimages.includes(img.image)) {
              if (DEBUG_MODE) {
                console.log(
                  "Skipping image as it's already been processed",
                  img.image,
                );
              }

              skippedImageSrcs.push({ image: img.image, src: f });

              continue;
            }
            if (DEBUG_MODE) {
              console.log(`Parsing image ${img.image}`);
            }
            const imageObj = parseImageName(img.image);

            const pkg = {
              name: imageObj.name,
              group: imageObj.group,
              version:
                imageObj.tag ||
                (imageObj.digest ? `sha256:${imageObj.digest}` : "latest"),
              qualifiers: {},
              properties: commonProperties,
              type: "container",
            };
            if (imageObj.registry) {
              // Skip adding repository_url if the registry or repo contains variables.
              if (
                imageObj.registry.includes("${") ||
                imageObj.repo.includes("${")
              ) {
                if (DEBUG_MODE) {
                  console.warn(
                    "Skipping adding repository_url qualifier as it contains variables, which are not yet supported",
                    img.image,
                  );
                }
              } else {
                pkg["qualifiers"]["repository_url"] =
                  `${imageObj.registry}/${imageObj.repo}`;
              }
            }
            if (imageObj.platform) {
              pkg["qualifiers"]["platform"] = imageObj.platform;
            }
            if (imageObj.tag) {
              pkg["qualifiers"]["tag"] = imageObj.tag;
            }
            // Create an entry for the oci image
            const imageBomData = buildBomNSData(options, [pkg], "oci", {
              src: img.image,
              filename: f,
              nsMapping: {},
            });
            if (imageBomData?.bomJson?.components) {
              components = components.concat(imageBomData.bomJson.components);
            }
            const bomData = await createBom(img.image, {
              specVersion: options.specVersion,
              projectType: ["oci"],
            });
            doneimages.push(img.image);
            if (bomData) {
              if (bomData.components?.length) {
                // Inject properties
                for (const co of bomData.components) {
                  co.properties = commonProperties;
                }
                components = components.concat(bomData.components);
              }
            }
          } // img.image
        } // for img
      }
    } // for

    // Add additional SrcFile property to skipped image components
    addSkippedSrcFiles(skippedImageSrcs, components);
  } // if
  // Parse openapi files
  if (oapiFiles.length) {
    for (const af of oapiFiles) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${af}`);
      }
      const oaData = readFileSync(af, { encoding: "utf-8" });
      const servlist = parseOpenapiSpecData(oaData);
      if (servlist?.length) {
        // Inject SrcFile property
        for (const se of servlist) {
          se.properties = [
            {
              name: "SrcFile",
              value: af,
            },
          ];
        }
        services = services.concat(servlist);
      }
    }
  }
  // Parse privado files
  if (privadoFiles.length) {
    console.log(
      "Enriching your SBOM with information from privado.ai scan reports",
    );
    let rows = [["Classification", "Flow"]];
    const config = {
      header: {
        alignment: "center",
        content: "Data Privacy Insights from privado.ai",
      },
      columns: [{ width: 50 }, { width: 10 }],
    };
    for (const f of privadoFiles) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      const servlist = parsePrivadoFile(f);
      services = services.concat(servlist);
      if (servlist.length) {
        const aservice = servlist[0];
        if (aservice.data) {
          for (const d of aservice.data) {
            rows.push([d.classification, d.flow]);
          }
          console.log(table(rows, config));
        }
        if (aservice.endpoints) {
          rows = [["Leaky Endpoints"]];
          for (const e of aservice.endpoints) {
            rows.push([e]);
          }
          console.log(
            table(rows, {
              columnDefault: {
                width: 50,
              },
            }),
          );
        }
      }
    }
  }
  if (origProjectType?.includes("universal")) {
    // In case of universal, repeat to collect multiX Boms
    const mbomData = await createMultiXBom(path, {
      ...options,
      projectType: [],
      multiProject: true,
      excludeType: options.excludeType,
    });
    if (mbomData) {
      if (mbomData.components?.length) {
        components = components.concat(mbomData.components);
      }
      // We need to retain the parentComponent. See #527
      // Parent component returned by multi X search is usually good
      parentComponent = mbomData.parentComponent;
      options.parentComponent = parentComponent;
      if (mbomData.bomJson) {
        if (mbomData.bomJson.dependencies) {
          dependencies = mergeDependencies(
            dependencies,
            mbomData.bomJson.dependencies,
            parentComponent,
          );
        }
        if (mbomData.bomJson.services) {
          services = services.concat(mbomData.bomJson.services);
        }
      }
      if (DEBUG_MODE) {
        console.log(
          `Received ${components.length} unfiltered components ${dependencies.length} dependencies so far.`,
        );
      }
    }
  }
  options.services = services;
  options.ociSpecs = ociSpecs;
  return dedupeBom(options, components, parentComponent, dependencies);
}

/**
 * Function to create bom string for php projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 */
export function createPHPBom(path, options) {
  let dependencies = [];
  let parentComponent = {};
  // We can look for composer files within node_modules directory
  if (typeof options.includeNodeModulesDir === "undefined" || options.deep) {
    options.includeNodeModulesDir = true;
  }
  const composerJsonFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}composer.json`,
    options,
  );
  if (!options.exclude) {
    options.exclude = [];
  }
  // Ignore vendor directories for lock files
  options.exclude.push("**/vendor/**");
  let composerLockFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}composer.lock`,
    options,
  );
  let pkgList = [];
  const composerJsonMode = composerJsonFiles.length;
  const composerLockMode = composerLockFiles.length;
  // Create a composer.lock file for each composer.json file if needed.
  if (!composerLockMode && composerJsonMode && options.installDeps) {
    if (DEBUG_MODE) {
      console.log("About to invoke composer --version");
    }
    const versionResult = safeSpawnSync("composer", ["--version"], {
      shell: isWin,
    });
    if (versionResult.status !== 0 || versionResult.error) {
      console.error(
        "No composer version found. Check if composer is installed and available in PATH.",
      );
      if (DEBUG_MODE) {
        console.log(versionResult.error, versionResult.stderr);
      }
      options.failOnError && process.exit(1);
    }
    let composerVersion;
    if (DEBUG_MODE) {
      console.log("Parsing version", versionResult.stdout);
    }
    let tmpV;
    if (versionResult?.stdout) {
      tmpV = versionResult.stdout.split(" ");
    }
    if (tmpV && tmpV.length > 1) {
      composerVersion = tmpV[1];
    }
    for (const f of composerJsonFiles) {
      const basePath = dirname(f);
      let args = [];
      if (composerVersion && !composerVersion.startsWith("1")) {
        console.log("Generating composer.lock in", basePath);
        args = ["update", "--no-install", "--ignore-platform-reqs"];
      } else {
        console.log("Executing 'composer install' in", basePath);
        args = ["install", "--ignore-platform-reqs"];
      }
      const result = safeSpawnSync("composer", args, {
        cwd: basePath,
        shell: isWin,
      });
      if (result.status !== 0 || result.error) {
        console.error("Error running composer:");
        if (result.stdout) {
          console.log(result.stdout);
        }
        if (result.stderr) {
          console.log(result.stderr);
        }
        console.log(result.error);
        options.failOnError && process.exit(1);
      }
    }
  }
  composerLockFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}composer.lock`,
    options,
  );
  if (composerLockFiles.length) {
    // Look for any root composer.json to capture the parentComponent
    if (safeExistsSync(join(path, "composer.json"))) {
      const { moduleParent } = parseComposerJson(join(path, "composer.json"));
      parentComponent = moduleParent;
    }
    for (const f of composerLockFiles) {
      const basePath = dirname(f);
      let moduleParent;
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      let rootRequires = [];
      // Is there a composer.json to find the module parent component
      if (safeExistsSync(join(basePath, "composer.json"))) {
        const retMap = parseComposerJson(join(basePath, "composer.json"));
        moduleParent = retMap.moduleParent;
        rootRequires = retMap.rootRequires;
        // Track all the modules in a mono-repo
        if (!Object.keys(parentComponent).length) {
          parentComponent = { ...moduleParent };
        } else {
          parentComponent.components = parentComponent.components || [];
          parentComponent.components.push(moduleParent);
        }
      }
      const retMap = parseComposerLock(f, rootRequires);
      if (retMap.pkgList?.length) {
        pkgList = pkgList.concat(retMap.pkgList);
        pkgList = trimComponents(pkgList);
      }
      if (retMap.dependenciesList) {
        if (moduleParent?.["bom-ref"]) {
          // Complete the dependency tree by making parent component depend on the first level
          dependencies.splice(0, 0, {
            ref: moduleParent["bom-ref"],
            dependsOn: [
              ...new Set(retMap.rootList.map((p) => p["bom-ref"])),
            ].sort(),
          });
        }
        dependencies = mergeDependencies(
          dependencies,
          retMap.dependenciesList,
          parentComponent,
        );
      }
    }
    // Complete the root dependency tree
    if (parentComponent?.components?.length) {
      const parentDependsOn = parentComponent.components.map(
        (d) => d["bom-ref"],
      );
      dependencies = mergeDependencies(
        [{ ref: parentComponent["bom-ref"], dependsOn: parentDependsOn }],
        dependencies,
        parentComponent,
      );
    }
    return buildBomNSData(options, pkgList, "composer", {
      src: path,
      filename: composerLockFiles.join(", "),
      dependencies,
      parentComponent,
    });
  }
  return {};
}

/**
 * Function to create bom string for ruby projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 */
export async function createRubyBom(path, options) {
  // We can look for gem files within node_modules directory
  if (typeof options.includeNodeModulesDir === "undefined" || options.deep) {
    options.includeNodeModulesDir = true;
  }
  const excludeList = (options.exclude || []).concat(["**/vendor/cache/**"]);
  const gemLockExcludeList = (options.exclude || []).concat([
    "**/vendor/bundle/ruby/**/Gemfile.lock",
  ]);
  if (!hasAnyProjectType(["oci"], options, false)) {
    excludeList.push("**/vendor/bundle/**");
    gemLockExcludeList.push("**/vendor/cache/**");
  }
  const gemFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}Gemfile`,
    {
      ...options,
      exclude: excludeList,
    },
  );
  let gemLockFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}Gemfile*.lock`,
    {
      ...options,
      exclude: gemLockExcludeList,
    },
  );
  let gemspecFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}*.gemspec`,
    {
      ...options,
      exclude: excludeList,
    },
  );
  let gemHome = process.env.CDXGEN_GEM_HOME || process.env.GEM_HOME;
  if (!gemHome && (process.env.BUNDLE_PATH || process.env.GEM_PATH)) {
    gemHome = process.env.BUNDLE_PATH || process.env.GEM_PATH;
  }
  let isGemHomeEmpty = true;
  // In deep mode, let's collect all gems that got installed in our custom GEM_HOME directory.
  // This would improve the accuracy of any security analysis downstream at cost of a slight increase in time.
  if (options.deep && process.env.CDXGEN_GEM_HOME) {
    const gemHomeSpecFiles = getAllFiles(
      process.env.CDXGEN_GEM_HOME || process.env.BUNDLE_PATH,
      "**/specifications/**/*.gemspec",
      options,
    );
    if (gemHomeSpecFiles?.length) {
      isGemHomeEmpty = false;
      gemspecFiles = gemspecFiles.concat(gemHomeSpecFiles);
    }
  }
  let pkgList = [];
  let dependencies = [];
  let rootList = [];
  const parentComponent = createDefaultParentComponent(path, "gem", options);
  const gemFileMode = gemFiles.length;
  const gemLockMode = gemLockFiles.length;
  if (gemFileMode && !gemLockMode && options.installDeps) {
    for (const f of gemFiles) {
      const basePath = dirname(f);
      console.log("Executing 'bundle install' in", basePath);
      const result = safeSpawnSync("bundle", ["install"], {
        cwd: basePath,
        shell: isWin,
      });
      if (result.status !== 0 || result.error) {
        console.error(
          "Bundle install has failed. Check if bundle is installed and available in PATH.",
        );
        console.log(result.error, result.stderr);
        options.failOnError && process.exit(1);
      }
    }
  }
  gemLockFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}Gemfile*.lock`,
    {
      ...options,
      exclude: gemLockExcludeList,
    },
  );
  if (gemLockFiles.length) {
    for (const f of gemLockFiles) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      const gemLockData = readFileSync(f, { encoding: "utf-8" });
      const retMap = await parseGemfileLockData(gemLockData, f);
      if (retMap.pkgList?.length) {
        pkgList = pkgList.concat(retMap.pkgList);
        pkgList = trimComponents(pkgList);
      }
      if (retMap.dependenciesList?.length) {
        dependencies = mergeDependencies(
          dependencies,
          retMap.dependenciesList,
          parentComponent,
        );
      }
      if (retMap.rootList?.length) {
        rootList = rootList.concat(retMap.rootList);
      }
    }
  }
  // Parsing .gemspec files would help us get more metadata such as description, authors, licenses etc
  if (gemspecFiles.length) {
    if (!gemLockFiles.length && !hasAnyProjectType(["oci"], options, false)) {
      console.log(
        "SBOM generation using only gemspec files is imprecise and results in an inaccurate dependency tree.",
      );
      options.failOnError && process.exit(1);
    }
    for (const f of gemspecFiles) {
      const gemspecData = readFileSync(f, { encoding: "utf-8" });
      const gpkgList = await parseGemspecData(gemspecData, f);
      if (gpkgList.length) {
        pkgList = pkgList.concat(gpkgList);
        pkgList = trimComponents(pkgList);
      }
    }
  }
  if (rootList.length) {
    dependencies = mergeDependencies(
      dependencies,
      [
        {
          ref: parentComponent["bom-ref"],
          dependsOn: [...new Set(rootList)].sort(),
        },
      ],
      parentComponent,
    );
  }
  // Should we collect the module names for the gems
  if (
    options.resolveClass ||
    (options.deep && !hasAnyProjectType(["oci"], options, false))
  ) {
    if (gemHome && !isGemHomeEmpty) {
      const rubyCommand =
        process.env.CDXGEN_RUBY_CMD || process.env.RUBY_CMD || "ruby";
      const bundleCommand = process.env.CDXGEN_BUNDLE_CMD || "bundle";
      let emptyCount = 0;
      let atleastOneHit = false;
      console.log(
        `About the collect the module names for ${pkgList.length} gems. This would take a while ...`,
      );
      const gemFilePath = gemFiles?.length > 0 ? dirname(gemFiles[0]) : path;
      for (const apkg of pkgList) {
        if (!apkg.name || !apkg.version || apkg.name.startsWith("/")) {
          continue;
        }
        const moduleNames = collectGemModuleNames(
          rubyCommand,
          bundleCommand,
          gemHome,
          apkg.name,
          gemFilePath,
        );
        if (moduleNames.length) {
          emptyCount = 0;
          atleastOneHit = true;
          if (!apkg.properties) {
            apkg.properties = [];
          }
          apkg.properties.push({
            name: "Namespaces",
            value: moduleNames.join(", "),
          });
        } else {
          emptyCount++;
        }
        // Circuit breaker
        if (!atleastOneHit && emptyCount >= 5) {
          console.log(
            "Unable to collect the module names for all the gems. Resolve the errors reported and re-run cdxgen.",
          );
          if (DEBUG_MODE) {
            console.log(
              "Tried everything to get the `--deep` mode working? Please create an issue with a sample repo to reproduce this problem. https://github.com/CycloneDX/cdxgen/issues",
            );
          }
          break;
        }
      }
      if (DEBUG_MODE && atleastOneHit) {
        console.log(
          "Successfully obtained the module names for some component gems. You can find them under a property named `Namespaces`.",
        );
      }
      // Clean up
      if (process.env?.CDXGEN_GEM_HOME?.startsWith(getTmpDir())) {
        rmSync(process.env.CDXGEN_GEM_HOME, { recursive: true, force: true });
      }
    } else {
      if (process.env.CDXGEN_GEM_HOME) {
        console.log(
          `${process.env.CDXGEN_GEM_HOME} was empty. Ensure "bundle install" command was successful prior to invoking cdxgen.`,
        );
      } else {
        console.log(
          "Set the environment variable CDXGEN_GEM_HOME or GEM_HOME to collect the module names for installed gems.",
        );
      }
    }
  }
  return buildBomNSData(options, pkgList, "gem", {
    src: path,
    dependencies,
    parentComponent,
    filename: gemLockFiles.join(", "),
  });
}

/**
 * Function to create bom string for csharp projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 */
export async function createCsharpBom(path, options) {
  let manifestFiles = [];
  let pkgData;
  let dependencies = [];
  if (options?.lifecycle?.includes("post-build")) {
    return createBinaryBom(path, options);
  }
  let parentComponent = createDefaultParentComponent(path, "nuget", options);
  const slnFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}*.sln*`,
    options,
  );
  const csProjFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}*.{cs,vb,fs,ts,hmi,plc}proj`,
    options,
  );
  const pkgConfigFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}packages.config`,
    options,
  );
  let projAssetsFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}project.assets.json`,
    options,
  );
  let pkgLockFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}packages.lock.json`,
    options,
  );
  const paketLockFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}paket.lock`,
    options,
  );
  let nupkgFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}*.nupkg`,
    options,
  );
  // Support for detecting and suggesting build tools for this project
  // We parse all the .csproj files to collect the target framework strings
  if (isFeatureEnabled(options, "suggest-build-tools")) {
    const targetFrameworks = new Set();
    for (const f of csProjFiles) {
      const csProjData = readFileSync(f, { encoding: "utf-8" });
      const retMap = parseCsProjData(csProjData, f, {});
      if (retMap?.parentComponent?.properties) {
        retMap.parentComponent.properties
          .filter(
            (p) =>
              p.name === "cdx:dotnet:target_framework" && p.value.trim().length,
          )
          .forEach((p) => {
            p.value
              .split(";")
              .filter((v) => v.trim().length && !v.startsWith("$("))
              .forEach((v) => {
                targetFrameworks.add(v);
              });
          });
      }
    }
    console.log("Target frameworks found:", Array.from(targetFrameworks));
  }
  // Support for automatic restore for .Net projects
  if (
    options.installDeps &&
    !projAssetsFiles.length &&
    !pkgLockFiles.length &&
    !paketLockFiles.length
  ) {
    const filesToRestore = slnFiles.concat(csProjFiles);
    for (const f of filesToRestore) {
      let buildCmd = options.projectType?.includes("dotnet-framework")
        ? "nuget"
        : "dotnet";
      let buildArgs = options.projectType?.includes("dotnet-framework")
        ? [
            "restore",
            "-NonInteractive",
            "-PackageSaveMode",
            "nuspec;nupkg",
            "-Verbosity",
            "quiet",
          ]
        : ["restore", "--force", "--ignore-failed-sources", f];
      if (isWin && options.projectType?.includes("dotnet-framework")) {
        buildCmd = "msbuild";
        buildArgs = ["-t:restore", "-p:RestorePackagesConfig=true"];
      }
      if (DEBUG_MODE) {
        const basePath = dirname(f);
        console.log(
          `Executing '${buildCmd} ${buildArgs.join(" ")}' in ${basePath}`,
        );
      }
      const result = safeSpawnSync(buildCmd, buildArgs, {
        cwd: path,
        shell: isWin,
        env: { ...process.env, DOTNET_ROLL_FORWARD: "Major" },
      });
      if (DEBUG_MODE && (result.status !== 0 || result.error)) {
        if (
          result?.stderr?.includes(
            "only packages.config files will be restored",
          ) &&
          buildCmd === "nuget"
        ) {
          console.log(
            `This project needs to be restored using msbuild. Example: 'msbuild -t:restore -p:RestorePackagesConfig=true'. cdxgen is attempting to use ${buildCmd}, which might result in an incomplete SBOM!`,
          );
          if (process.env?.CDXGEN_IN_CONTAINER !== "true") {
            console.log(
              "Ensure the restore step is performed prior to invoking cdxgen.",
            );
          } else {
            console.log(
              "TIP: msbuild is not available for Linux. Try using a Windows build agent to generate an SBOM for this project.",
            );
          }
          options.failOnError && process.exit(1);
        }
        if (result?.stderr?.includes("To install missing framework")) {
          console.log(
            "This project requires a specific version of dotnet sdk to be installed. The cdxgen container image bundles dotnet SDK 8.0, which might be incompatible.",
          );
          console.log(
            "TIP: Try using the custom `ghcr.io/cyclonedx/cdxgen-debian-dotnet6:v12` or `ghcr.io/cyclonedx/cdxgen-debian-dotnet8:v12` container images.",
          );
        } else if (
          result?.stderr?.includes("is not found on source") ||
          result?.stderr?.includes("Unable to find version")
        ) {
          console.log(
            `The project ${f} refers to private packages that are not available on nuget.org!`,
          );
          console.log(
            "TIP: Authenticate with any private registries such as Azure Artifacts feed before running cdxgen. Alternatively, commit the contents of the 'packages' folder to the repository.",
          );
        } else if (result?.stderr?.includes("but the current NuGet version")) {
          if (process.env?.CDXGEN_IN_CONTAINER !== "true") {
            console.log(
              "TIP: Try downloading the correct version from here: https://learn.microsoft.com/en-us/nuget/install-nuget-client-tools",
            );
          } else {
            console.log(
              "TIP: This project requires a specific version of nuget client to be installed. Try using a Windows build agent to generate an SBOM for this project.",
            );
          }
        } else {
          console.error(
            `Restore has failed. Check if ${buildCmd} is installed and available in PATH.`,
          );
          console.log(
            "Authenticate with any private registries such as Azure Artifacts feed before running cdxgen.",
          );
          if (process.env?.CDXGEN_IN_CONTAINER !== "true") {
            console.log(
              "Alternatively, try using the custom `ghcr.io/cyclonedx/cdxgen-debian-dotnet6:v12` container image, which bundles nuget (mono) and a range of dotnet SDKs.",
            );
          }
        }
        console.log("---------");
        if (result.stderr) {
          console.log(result.stderr);
        } else if (result.stdout) {
          console.log(result.stdout);
        }
        console.log("---------");
        options.failOnError && process.exit(1);
      }
    }
    // Collect the assets, lock, and nupkg files generated from restore
    projAssetsFiles = getAllFiles(
      path,
      `${options.multiProject ? "**/" : ""}project.assets.json`,
      options,
    );
    pkgLockFiles = getAllFiles(
      path,
      `${options.multiProject ? "**/" : ""}packages.lock.json`,
      options,
    );
    nupkgFiles = getAllFiles(
      path,
      `${options.multiProject ? "**/" : ""}*.nupkg`,
      options,
    );
  }
  let pkgList = [];
  const parentDependsOn = new Set();
  if (nupkgFiles.length && projAssetsFiles.length === 0) {
    manifestFiles = manifestFiles.concat(nupkgFiles);
    // When parsing nupkg files, only version ranges will be specified under dependencies
    // To resolve the version, we need to track the mapping between name and resolved versions here
    let dependenciesMap = {};
    const pkgNameVersions = {};
    for (const nf of nupkgFiles) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${nf}`);
      }
      const retMap = await parseNupkg(nf);
      if (retMap?.pkgList?.length) {
        pkgList = pkgList.concat(retMap.pkgList);
        for (const d of retMap.pkgList) {
          parentDependsOn.add(d["bom-ref"]);
          pkgNameVersions[d.name] = d.version;
        }
      }
      if (retMap?.dependenciesMap) {
        dependenciesMap = { ...dependenciesMap, ...retMap.dependenciesMap };
      }
    } // end for
    for (const k of Object.keys(dependenciesMap)) {
      const dependsOn = dependenciesMap[k].map(
        (p) => `pkg:nuget/${p}@${pkgNameVersions[p] || "latest"}`,
      );
      dependencies.push({ ref: k, dependsOn: [...new Set(dependsOn)].sort() });
    }
  }
  // project.assets.json parsing
  if (projAssetsFiles.length) {
    manifestFiles = manifestFiles.concat(projAssetsFiles);
    for (const af of projAssetsFiles) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${af}`);
      }
      pkgData = readFileSync(af, { encoding: "utf-8" });
      const results = parseCsProjAssetsData(pkgData, af);
      const deps = results["dependenciesList"];
      const dlist = results["pkgList"];
      if (dlist?.length) {
        pkgList = pkgList.concat(dlist);
      }
      if (deps?.length) {
        dependencies = mergeDependencies(dependencies, deps, parentComponent);
      }
    }
    // We are now in a scenario where the restore operation didn't yield correct project.assets.json files.
    // This usually happens when restore was performed with an incorrect version of the SDK.
    if (!pkgList.length || dependencies.length < 2) {
      console.log(
        "Unable to obtain the correct dependency tree from the project.assets.json files. Ensure the correct version of the dotnet SDK was installed and used.",
      );
      console.log(
        "1. Create a global.json file in the project directory to specify the required version of the dotnet SDK.",
      );
      console.log(
        "2. Use the environment variable `DOTNET_ROLL_FORWARD` to roll forward to a closest available SDK such as .Net core or dotnet 6.",
      );
      console.log(
        "3. If the project uses the legacy .Net Framework 4.6/4.7/4.8, it might require execution on Windows.",
      );
      console.log(
        "Alternatively, try using the custom `ghcr.io/cyclonedx/cdxgen-dotnet:v12` container image, which bundles a range of dotnet SDKs.",
      );
      options.failOnError && process.exit(1);
    }
  } else if (pkgLockFiles.length) {
    manifestFiles = manifestFiles.concat(pkgLockFiles);
    // packages.lock.json from nuget
    for (const af of pkgLockFiles) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${af}`);
      }
      pkgData = readFileSync(af, { encoding: "utf-8" });
      const results = parseCsPkgLockData(pkgData, af);
      const deps = results["dependenciesList"];
      const dlist = results["pkgList"];
      const rootList = results["rootList"];
      if (dlist?.length) {
        pkgList = pkgList.concat(dlist);
      }
      if (deps?.length) {
        dependencies = mergeDependencies(dependencies, deps, parentComponent);
      }
      // Keep track of the direct dependencies so that we can construct one complete
      // list after processing all lock files
      if (rootList?.length) {
        for (const p of rootList) {
          parentDependsOn.add(p["bom-ref"]);
        }
      }
    }
  } else if (pkgConfigFiles.length) {
    manifestFiles = manifestFiles.concat(pkgConfigFiles);
    // packages.config parsing
    for (const f of pkgConfigFiles) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      pkgData = readFileSync(f, { encoding: "utf-8" });
      const dlist = parseCsPkgData(pkgData, f);
      if (dlist?.length) {
        pkgList = pkgList.concat(dlist);
        for (const d of dlist) {
          parentDependsOn.add(d["bom-ref"]);
        }
      }
    }
  }
  if (paketLockFiles.length) {
    manifestFiles = manifestFiles.concat(paketLockFiles);
    // paket.lock parsing
    for (const f of paketLockFiles) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      pkgData = readFileSync(f, { encoding: "utf-8" });
      const results = parsePaketLockData(pkgData, f);
      const dlist = results.pkgList;
      const deps = results.dependenciesList;
      if (dlist?.length) {
        pkgList = pkgList.concat(dlist);
      }
      if (deps?.length) {
        dependencies = mergeDependencies(dependencies, deps, parentComponent);
      }
    }
  }
  const pkgNameVersions = {};
  if (csProjFiles.length) {
    manifestFiles = manifestFiles.concat(csProjFiles);
    // Parsing csproj is quite error-prone. Some project files may not have versions specified
    // To work around this, we make use of the version from the existing list
    for (const p of pkgList) {
      if (p.version) {
        pkgNameVersions[p.name] = p.version;
      }
    }
    // .csproj parsing
    for (const f of csProjFiles) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      const csProjData = readFileSync(f, { encoding: "utf-8" });
      const retMap = parseCsProjData(csProjData, f, pkgNameVersions);
      if (retMap?.parentComponent?.purl) {
        // If there are multiple project files, track the parent components using nested components
        if (csProjFiles.length > 1) {
          if (!parentComponent.components) {
            parentComponent.components = [];
          }
          parentComponent.components.push(retMap.parentComponent);
        } else {
          // There is only one project file. Make it the parent.
          parentComponent = retMap.parentComponent;
        }
      }
      if (retMap?.pkgList?.length) {
        pkgList = pkgList.concat(retMap.pkgList);
      }
      if (retMap.dependencies?.length) {
        dependencies = mergeDependencies(
          dependencies,
          retMap.dependencies,
          parentComponent,
        );
      }
    }
  }
  if (pkgList.length) {
    pkgList = trimComponents(pkgList);
    // Perform deep analysis using dosai
    if (options.deep) {
      const slicesFile = resolve(
        join(path, options.depsSlicesFile) || join(getTmpDir(), "dosai.json"),
      );
      // Create the slices file if it doesn't exist
      if (!safeExistsSync(slicesFile)) {
        thoughtLog(
          "Alright, the next step is to invoke the dosai command to identify evidence of occurrences for various components.",
        );
        const sliceResult = getDotnetSlices(resolve(path), resolve(slicesFile));
        if (!sliceResult && DEBUG_MODE) {
          console.log(
            "Slicing with dosai was unsuccessful. Check the errors reported in the logs above.",
          );
        }
      }
      pkgList = addEvidenceForDotnet(pkgList, slicesFile, options);
    }
  }
  // Parent dependency tree
  if (parentDependsOn.size && parentComponent && parentComponent["bom-ref"]) {
    dependencies.splice(0, 0, {
      ref: parentComponent["bom-ref"],
      dependsOn: Array.from(parentDependsOn).sort(),
    });
  }
  if (shouldFetchLicense()) {
    const retMap = await getNugetMetadata(pkgList, dependencies);
    if (retMap.dependencies?.length) {
      dependencies = mergeDependencies(
        dependencies,
        retMap.dependencies,
        parentComponent,
      );
    }
    pkgList = trimComponents(pkgList);
  }
  return buildBomNSData(options, pkgList, "nuget", {
    src: path,
    filename: manifestFiles.join(", "),
    dependencies,
    parentComponent,
  });
}

/**
 * Function to create bom object for cryptographic certificate files
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 */
export async function createCryptoCertsBom(path, options) {
  const pkgList = [];
  const certFiles = getAllFiles(
    path,
    `${
      options.multiProject ? "**/" : ""
    }*.{p12,jks,jceks,bks,keystore,key,pem,cer,gpg,pub}`,
    options,
  );
  for (const f of certFiles) {
    const name = basename(f);
    const fileHash = await checksumFile("sha256", f);
    const apkg = {
      name,
      type: "cryptographic-asset",
      version: fileHash,
      "bom-ref": `crypto/certificate/${name}@sha256:${fileHash}`,
      cryptoProperties: {
        assetType: "certificate",
        algorithmProperties: {
          executionEnvironment: "unknown",
          implementationPlatform: "unknown",
        },
      },
      properties: [{ name: "SrcFile", value: f }],
    };
    pkgList.push(apkg);
  }
  return {
    bomJson: {
      components: pkgList,
    },
  };
}

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
        if (
          parentRef &&
          eachProvides.toLowerCase() !== parentRef.toLowerCase()
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

/**
 * Dedupe components
 *
 * @param {Object} options Options
 * @param {Array} components Components
 * @param {Object} parentComponent Parent component
 * @param {Array} dependencies Dependencies
 *
 * @returns {Object} Object including BOM Json
 */
export function dedupeBom(options, components, parentComponent, dependencies) {
  if (!components) {
    return {};
  }
  if (!dependencies) {
    dependencies = [];
  }
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
    bomJson: {
      bomFormat: "CycloneDX",
      specVersion: `${options.specVersion || 1.5}`,
      serialNumber: serialNum,
      version: 1,
      metadata: addMetadata(parentComponent, options, {}),
      components,
      services: options.services || [],
      dependencies,
    },
  };
}

/**
 * Function to create bom string for all languages
 *
 * @param {string[]} pathList list of to the project
 * @param {Object} options Parse options from the cli
 */
export async function createMultiXBom(pathList, options) {
  let components = [];
  let dependencies = [];
  let bomData;
  let parentComponent = determineParentComponent(options) || {};
  let parentSubComponents = [];
  options.createMultiXBom = true;
  // Convert single path to an array
  if (!Array.isArray(pathList)) {
    pathList = pathList.split(",");
  }
  if (
    options.projectType &&
    hasAnyProjectType(["oci"], options, false) &&
    options.allLayersExplodedDir
  ) {
    const {
      osPackages,
      dependenciesList,
      allTypes,
      bundledSdks,
      bundledRuntimes,
      binPaths,
      executables,
      sharedLibs,
    } = await getOSPackages(
      options.allLayersExplodedDir,
      options.exportData?.inspectData?.Config,
    );
    // TODO: Need to test these with docker-compose type where multiple images could have different values.
    // This is also clearly misusing options, which must become immutable at some point.
    options.bundledSdks = bundledSdks;
    options.bundledRuntimes = bundledRuntimes;
    options.binPaths = binPaths;
    if (DEBUG_MODE) {
      console.log(
        `**OS**: Found ${osPackages.length} OS packages, ${executables?.length} executables, and ${sharedLibs.length} shared libraries at ${options.allLayersExplodedDir}`,
      );
    }
    if (osPackages.length) {
      thoughtLog(
        `I found ${osPackages.length} OS packages and ${executables?.length} executables at ${options.allLayersExplodedDir}`,
      );
    } else if (executables?.length || sharedLibs?.length) {
      thoughtLog(
        `I couldn't find any OS packages, but I found ${executables.length} executables and ${sharedLibs.length} shared libraries at ${options.allLayersExplodedDir}. Perhaps the binary plugin wasn't available, or the architecture is unsupported.`,
      );
    } else {
      thoughtLog(
        `I couldn't find any OS packages at ${options.allLayersExplodedDir}. Perhaps the binary plugin wasn't available, or the architecture is unsupported.`,
      );
    }
    if (allTypes?.length) {
      options.allOSComponentTypes = allTypes;
    }
    components = components.concat(osPackages);
    components = components.concat(executables);
    components = components.concat(sharedLibs);
    if (dependenciesList?.length) {
      dependencies = dependencies.concat(dependenciesList);
    }
    if (parentComponent && Object.keys(parentComponent).length) {
      // Make the parent oci image depend on all os components
      const parentDependsOn = new Set(osPackages.map((p) => p["bom-ref"]));
      dependencies.splice(0, 0, {
        ref: parentComponent["bom-ref"],
        dependsOn: Array.from(parentDependsOn).sort(),
      });
    }
  }
  if (hasAnyProjectType(["os"], options, false) && options.bomData) {
    bomData = options.bomData;
    if (bomData?.bomJson?.components) {
      if (DEBUG_MODE) {
        console.log(`Found ${bomData.bomJson.components.length} OS components`);
      }
      if (bomData.bomJson.components.length) {
        thoughtLog(
          `I found ${bomData.bomJson.components.length} OS packages 😎.`,
        );
      }
      components = components.concat(bomData.bomJson.components);
    }
  }
  for (const path of pathList) {
    if (DEBUG_MODE) {
      console.log("Scanning", path);
    }
    if (pathList.length > 2) {
      thoughtLog(`Let's thoroughly check the path ${path}.`);
    }
    // Node.js
    if (hasAnyProjectType(["oci", "js"], options)) {
      if (!hasAnyProjectType(["oci"], options, false)) {
        thoughtLog(
          "**JS**: Now looking for JavaScript projects (npm, yarn, pnpm) and files.",
        );
      }
      bomData = await createNodejsBom(path, options);
      if (bomData?.bomJson?.components?.length) {
        thoughtLog(
          `I found ${bomData.bomJson.components.length} npm packages. Let's keep looking.`,
        );
        if (DEBUG_MODE) {
          console.log(
            `Found ${bomData.bomJson.components.length} npm packages at ${path}`,
          );
        }
        components = components.concat(bomData.bomJson.components);
        dependencies = mergeDependencies(
          dependencies,
          bomData.bomJson.dependencies,
        );
        if (
          bomData.parentComponent &&
          Object.keys(bomData.parentComponent).length
        ) {
          parentSubComponents.push(bomData.parentComponent);
        }
        // Retain metadata.component.components
        if (bomData.parentComponent.components?.length) {
          parentSubComponents = parentSubComponents.concat(
            bomData.parentComponent.components,
          );
          delete bomData.parentComponent.components;
        }
      }
    }
    // Java
    if (hasAnyProjectType(["oci", "java"], options)) {
      if (!hasAnyProjectType(["oci"], options, false)) {
        thoughtLog(
          "**JAVA**: Looking for Java projects (e.g., Maven, Gradle, SBT). I hope all configurations—from Java version to individual build settings—are correctly aligned.",
        );
      }
      bomData = await createJavaBom(path, options);
      if (bomData?.bomJson?.components?.length) {
        thoughtLog(
          `I found ${bomData.bomJson.components.length} java packages.`,
        );
        if (DEBUG_MODE) {
          console.log(
            `Found ${bomData.bomJson.components.length} java packages at ${path}`,
          );
        }
        components = components.concat(bomData.bomJson.components);
        dependencies = mergeDependencies(
          dependencies,
          bomData.bomJson.dependencies,
        );
        if (
          bomData.parentComponent &&
          Object.keys(bomData.parentComponent).length
        ) {
          parentSubComponents.push(bomData.parentComponent);
        }
        // Retain metadata.component.components, but add duplicates to the list of current components
        // and removing them from metadata.component.components -- the components are merged later
        if (bomData.parentComponent.components?.length) {
          let bomSubComponents = bomData.parentComponent.components;
          if (!["false", "0"].includes(process.env.GRADLE_RESOLVE_FROM_NODE)) {
            thoughtLog(
              "Wait, the user wants me to resolve gradle projects from npm.",
            );
            const allRefs = components.map((c) => c["bom-ref"]);
            const duplicateComponents = bomSubComponents.filter((c) =>
              allRefs.includes(c["bom-ref"]),
            );
            components = components.concat(duplicateComponents);
            const duplicateComponentRefs = duplicateComponents.map(
              (c) => c["bom-ref"],
            );
            bomSubComponents = bomSubComponents.filter(
              (c) => !duplicateComponentRefs.includes(c["bom-ref"]),
            );
          }
          parentSubComponents = parentSubComponents.concat(bomSubComponents);
          delete bomData.parentComponent.components;
        }
      }
    }
    if (hasAnyProjectType(["oci", "py"], options)) {
      if (!hasAnyProjectType(["oci"], options, false)) {
        thoughtLog(
          "**PYTHON**: Looking for Python projects with package managers such as pip, poetry, uv, etc. Wish me good luck!",
        );
      }
      if (process.env?.CDXGEN_IN_CONTAINER !== "true" && pathList.length <= 2) {
        thoughtLog(
          "I'm running in a non-container environment. Let's hope the correct build tools are available ✌️.",
        );
      }
      bomData = await createPythonBom(path, options);
      if (bomData?.bomJson?.components?.length) {
        thoughtLog(
          `I found ${bomData.bomJson.components.length} python packages.`,
        );
        if (DEBUG_MODE) {
          console.log(
            `Found ${bomData.bomJson.components.length} python packages at ${path}`,
          );
        }
        components = components.concat(bomData.bomJson.components);
        dependencies = mergeDependencies(
          dependencies,
          bomData.bomJson.dependencies,
        );
        if (
          bomData.parentComponent &&
          Object.keys(bomData.parentComponent).length
        ) {
          parentSubComponents.push(bomData.parentComponent);
        }
      }
    }
    if (hasAnyProjectType(["oci", "go"], options)) {
      if (!hasAnyProjectType(["oci"], options, false)) {
        thoughtLog(
          "**GO**: Looking for go projects. I need to be cautious about purl namespaces and potential failures with the 'go list' command.",
        );
      }
      bomData = await createGoBom(path, options);
      if (bomData?.bomJson?.components?.length) {
        thoughtLog(`I found ${bomData.bomJson.components.length} go packages.`);
        if (DEBUG_MODE) {
          console.log(
            `Found ${bomData.bomJson.components.length} go packages at ${path}`,
          );
        }
        components = components.concat(bomData.bomJson.components);
        dependencies = mergeDependencies(
          dependencies,
          bomData.bomJson.dependencies,
        );
        if (
          bomData.parentComponent &&
          Object.keys(bomData.parentComponent).length
        ) {
          parentSubComponents.push(bomData.parentComponent);
        }
      }
    }
    if (hasAnyProjectType(["oci", "rust"], options)) {
      if (!hasAnyProjectType(["oci"], options, false)) {
        thoughtLog(
          "**RUST**: Let's search for Cargo/Rust projects. Should I warn the user that we don't support Cargo 'features' and native dependencies, which may lead to both false positives and false negatives? 🤔?",
        );
      }
      bomData = await createRustBom(path, options);
      if (bomData?.bomJson?.components?.length) {
        thoughtLog(
          `I found ${bomData.bomJson.components.length} rust packages.`,
        );
        if (DEBUG_MODE) {
          console.log(
            `Found ${bomData.bomJson.components.length} rust packages at ${path}`,
          );
        }
        components = components.concat(bomData.bomJson.components);
        dependencies = mergeDependencies(
          dependencies,
          bomData.bomJson.dependencies,
        );
        if (
          bomData.parentComponent &&
          Object.keys(bomData.parentComponent).length
        ) {
          parentSubComponents.push(bomData.parentComponent);
        }
        // Retain metadata.component.components
        if (bomData.parentComponent?.components?.length) {
          parentSubComponents = parentSubComponents.concat(
            bomData.parentComponent.components,
          );
          delete bomData.parentComponent.components;
        }
      }
    }
    if (hasAnyProjectType(["oci", "php"], options)) {
      if (!hasAnyProjectType(["oci"], options, false)) {
        thoughtLog(
          "**PHP**: About to search for Composer-based projects. I hope lock files are available; otherwise, the 'composer install' command might fail for various reasons.",
        );
      }
      bomData = createPHPBom(path, options);
      if (bomData?.bomJson?.components?.length) {
        thoughtLog(
          `I found ${bomData.bomJson.components.length} php packages.`,
        );
        if (DEBUG_MODE) {
          console.log(
            `Found ${bomData.bomJson.components.length} php packages at ${path}`,
          );
        }
        components = components.concat(bomData.bomJson.components);
        dependencies = mergeDependencies(
          dependencies,
          bomData.bomJson.dependencies,
        );
        if (
          bomData.parentComponent &&
          Object.keys(bomData.parentComponent).length
        ) {
          parentSubComponents.push(bomData.parentComponent);
        }
        // Retain metadata.component.components
        if (bomData.parentComponent?.components?.length) {
          parentSubComponents = parentSubComponents.concat(
            bomData.parentComponent.components,
          );
          delete bomData.parentComponent.components;
        }
      }
    }
    if (hasAnyProjectType(["oci", "ruby"], options)) {
      if (!hasAnyProjectType(["oci"], options, false)) {
        thoughtLog(
          "**RUBY**: Are there any Ruby projects in this path? There's only one way to know.",
        );
      }
      bomData = await createRubyBom(path, options);
      if (bomData?.bomJson?.components?.length) {
        thoughtLog(
          `We got ${bomData.bomJson.components.length} ruby packages.`,
        );
        if (DEBUG_MODE) {
          console.log(
            `Found ${bomData.bomJson.components.length} ruby packages at ${path}`,
          );
        }
        components = components.concat(bomData.bomJson.components);
        dependencies = mergeDependencies(
          dependencies,
          bomData.bomJson.dependencies,
          bomData.parentComponent,
        );
        if (
          bomData.parentComponent &&
          Object.keys(bomData.parentComponent).length
        ) {
          parentSubComponents.push(bomData.parentComponent);
        }
        // Retain metadata.component.components
        if (bomData.parentComponent?.components?.length) {
          parentSubComponents = parentSubComponents.concat(
            bomData.parentComponent.components,
          );
          delete bomData.parentComponent.components;
        }
      }
    }
    if (hasAnyProjectType(["oci", "csharp"], options)) {
      if (!hasAnyProjectType(["oci"], options, false)) {
        thoughtLog("**CSHARP**: What about csharp and fsharp projects?");
      }
      bomData = await createCsharpBom(path, options);
      if (bomData?.bomJson?.components?.length) {
        thoughtLog(
          `There are ${bomData.bomJson.components.length} csharp packages.`,
        );
        if (DEBUG_MODE) {
          console.log(
            `Found ${bomData.bomJson.components.length} csharp packages at ${path}`,
          );
        }
        components = components.concat(bomData.bomJson.components);
        dependencies = mergeDependencies(
          dependencies,
          bomData.bomJson.dependencies,
        );
        if (
          bomData.parentComponent &&
          Object.keys(bomData.parentComponent).length
        ) {
          parentSubComponents.push(bomData.parentComponent);
        }
        // Retain metadata.component.components
        if (bomData.parentComponent?.components?.length) {
          parentSubComponents = parentSubComponents.concat(
            bomData.parentComponent.components,
          );
          delete bomData.parentComponent.components;
        }
      }
    }
    if (hasAnyProjectType(["oci", "dart"], options)) {
      if (!hasAnyProjectType(["oci"], options, false)) {
        thoughtLog(
          "**DART**: Looking for Dart projects. These are rare ones. Should I inform the user that they can pass the types argument via the command-line to speed things up?",
        );
      }
      bomData = await createDartBom(path, options);
      if (bomData?.bomJson?.components?.length) {
        thoughtLog(
          `I found ${bomData.bomJson.components.length} pub packages.`,
        );
        if (DEBUG_MODE) {
          console.log(
            `Found ${bomData.bomJson.components.length} pub packages at ${path}`,
          );
        }
        components = components.concat(bomData.bomJson.components);
        dependencies = mergeDependencies(
          dependencies,
          bomData.bomJson.dependencies,
        );
        if (
          bomData.parentComponent &&
          Object.keys(bomData.parentComponent).length
        ) {
          parentSubComponents.push(bomData.parentComponent);
        }
      }
    }
    if (hasAnyProjectType(["oci", "haskell"], options)) {
      if (!hasAnyProjectType(["oci"], options, false)) {
        thoughtLog(
          "**HASKELL**: Looking for Haskell projects. They're rarely encountered.",
        );
      }
      bomData = createHaskellBom(path, options);
      if (bomData?.bomJson?.components?.length) {
        thoughtLog(
          `I found ${bomData.bomJson.components.length} hackage packages.`,
        );
        if (DEBUG_MODE) {
          console.log(
            `Found ${bomData.bomJson.components.length} hackage packages at ${path}`,
          );
        }
        components = components.concat(bomData.bomJson.components);
        dependencies = mergeDependencies(
          dependencies,
          bomData.bomJson.dependencies,
        );
        if (
          bomData.parentComponent &&
          Object.keys(bomData.parentComponent).length
        ) {
          parentSubComponents.push(bomData.parentComponent);
        }
      }
    }
    if (hasAnyProjectType(["oci", "elixir"], options)) {
      if (!hasAnyProjectType(["oci"], options, false)) {
        thoughtLog(
          "**ELIXIR**: Looking for Elixir projects—they're quite rare as well.",
        );
      }
      bomData = createElixirBom(path, options);
      if (bomData?.bomJson?.components?.length) {
        thoughtLog(
          `I found ${bomData.bomJson.components.length} mix packages.`,
        );
        if (DEBUG_MODE) {
          console.log(
            `Found ${bomData.bomJson.components.length} mix packages at ${path}`,
          );
        }
        components = components.concat(bomData.bomJson.components);
        dependencies = mergeDependencies(
          dependencies,
          bomData.bomJson.dependencies,
        );
        if (
          bomData.parentComponent &&
          Object.keys(bomData.parentComponent).length
        ) {
          parentSubComponents.push(bomData.parentComponent);
        }
      }
    }
    if (hasAnyProjectType(["oci", "c"], options)) {
      if (!hasAnyProjectType(["oci"], options, false)) {
        thoughtLog(
          "**C/C++**: Looking for C/C++ projects. Should I warn the user that the generated SBOM might have low accuracy and contain errors?",
        );
      }
      bomData = createCppBom(path, options);
      if (bomData?.bomJson?.components?.length) {
        thoughtLog(
          `I found ${bomData.bomJson.components.length} cpp packages.`,
        );
        if (DEBUG_MODE) {
          console.log(
            `Found ${bomData.bomJson.components.length} cpp packages at ${path}`,
          );
        }
        components = components.concat(bomData.bomJson.components);
        dependencies = mergeDependencies(
          dependencies,
          bomData.bomJson.dependencies,
        );
        if (
          bomData.parentComponent &&
          Object.keys(bomData.parentComponent).length
        ) {
          parentSubComponents.push(bomData.parentComponent);
        }
      }
    }
    if (hasAnyProjectType(["oci", "clojure"], options)) {
      if (!hasAnyProjectType(["oci"], options, false)) {
        thoughtLog(
          "**CLOJURE**: Looking for Clojure projects. Should I warn the user that the purl namespace 'clojars' isn't widely supported by tools like Dependency-Track?",
        );
      }
      bomData = createClojureBom(path, options);
      if (bomData?.bomJson?.components?.length) {
        thoughtLog(
          `I found ${bomData.bomJson.components.length} clojure packages.`,
        );
        if (DEBUG_MODE) {
          console.log(
            `Found ${bomData.bomJson.components.length} clojure packages at ${path}`,
          );
        }
        components = components.concat(bomData.bomJson.components);
        dependencies = mergeDependencies(
          dependencies,
          bomData.bomJson.dependencies,
        );
        if (
          bomData.parentComponent &&
          Object.keys(bomData.parentComponent).length
        ) {
          parentSubComponents.push(bomData.parentComponent);
        }
      }
    }
    if (hasAnyProjectType(["oci", "github"], options)) {
      if (!hasAnyProjectType(["oci"], options, false)) {
        thoughtLog(
          "**GITHUB**: Looking for any github packages and workflows.",
        );
      }
      bomData = createGitHubBom(path, options);
      if (bomData?.bomJson?.components?.length) {
        thoughtLog(
          `I found ${bomData.bomJson.components.length} github action packages as well. Should I convert these to formulation instead 🤔`,
        );
        if (DEBUG_MODE) {
          console.log(
            `Found ${bomData.bomJson.components.length} GitHub action packages at ${path}`,
          );
        }
        components = components.concat(bomData.bomJson.components);
        dependencies = mergeDependencies(
          dependencies,
          bomData.bomJson.dependencies,
        );
        if (
          bomData.parentComponent &&
          Object.keys(bomData.parentComponent).length
        ) {
          parentSubComponents.push(bomData.parentComponent);
        }
      }
    }
    if (hasAnyProjectType(["oci", "cloudbuild"], options)) {
      if (!hasAnyProjectType(["oci"], options, false)) {
        thoughtLog(
          "**CLOUDBUILD**: Let's check for CloudBuild configuration files that include package dependencies.",
        );
      }
      bomData = createCloudBuildBom(path, options);
      if (bomData?.bomJson?.components?.length) {
        thoughtLog(
          `I found ${bomData.bomJson.components.length} cloudbuild packages.`,
        );
        if (DEBUG_MODE) {
          console.log(
            `Found ${bomData.bomJson.components.length} CloudBuild configuration at ${path}`,
          );
        }
        components = components.concat(bomData.bomJson.components);
        dependencies = mergeDependencies(
          dependencies,
          bomData.bomJson.dependencies,
        );
        if (
          bomData.parentComponent &&
          Object.keys(bomData.parentComponent).length
        ) {
          parentSubComponents.push(bomData.parentComponent);
        }
      }
    }
    if (hasAnyProjectType(["oci", "swift"], options)) {
      if (!hasAnyProjectType(["oci"], options, false)) {
        thoughtLog(
          "**SWIFT**: Now checking for Swift projects. We don't support CocoaPods, Objective-C, or pure Xcode projects, so the SBOM will be incomplete.",
        );
      }
      bomData = await createSwiftBom(path, options);
      if (bomData?.bomJson?.components?.length) {
        thoughtLog(
          `I found ${bomData.bomJson.components.length} swift packages here.`,
        );
        if (DEBUG_MODE) {
          console.log(
            `Found ${bomData.bomJson.components.length} Swift packages at ${path}`,
          );
        }
        components = components.concat(bomData.bomJson.components);
        dependencies = mergeDependencies(
          dependencies,
          bomData.bomJson.dependencies,
        );
        if (
          bomData.parentComponent &&
          Object.keys(bomData.parentComponent).length
        ) {
          parentSubComponents.push(bomData.parentComponent);
        }
      }
    }
    if (hasAnyProjectType(["oci", "jar", "war", "ear"], options)) {
      if (!hasAnyProjectType(["oci"], options, false)) {
        thoughtLog(
          "**JAR**: Let's check for any bundled jar/war/ear files to improve the SBOM accuracy.",
        );
      }
      bomData = await createJarBom(path, options);
      if (bomData?.bomJson?.components?.length) {
        thoughtLog(
          `I found ${bomData.bomJson.components.length} jar packages as well.`,
        );
        if (DEBUG_MODE) {
          console.log(
            `Found ${bomData.bomJson.components.length} jar packages at ${path}`,
          );
        }
        components = components.concat(bomData.bomJson.components);
        dependencies = mergeDependencies(
          dependencies,
          bomData.bomJson.dependencies,
        );
        if (
          bomData.parentComponent &&
          Object.keys(bomData.parentComponent).length
        ) {
          parentSubComponents.push(bomData.parentComponent);
        }
      }
    }
    if (hasAnyProjectType(["oci", "cocoa"], options)) {
      bomData = await createCocoaBom(path, options);
      if (bomData?.bomJson?.components?.length) {
        if (DEBUG_MODE) {
          console.log(
            `Found ${bomData.bomJson.components.length} Cocoa packages at ${path}`,
          );
        }
        components = components.concat(bomData.bomJson.components);
        dependencies = dependencies.concat(bomData.bomJson.dependencies);
        if (
          bomData.parentComponent &&
          Object.keys(bomData.parentComponent).length
        ) {
          parentSubComponents.push(bomData.parentComponent);
        }
      }
    }
    if (hasAnyProjectType(["oci", "nix"], options)) {
      bomData = await createNixBom(path, options);
      if (bomData?.bomJson?.components?.length) {
        if (DEBUG_MODE) {
          console.log(
            `Found ${bomData.bomJson.components.length} Nix flake packages at ${path}`,
          );
        }
        components = components.concat(bomData.bomJson.components);
        dependencies = mergeDependencies(
          dependencies,
          bomData.bomJson.dependencies,
        );
        if (
          bomData.parentComponent &&
          Object.keys(bomData.parentComponent).length
        ) {
          parentSubComponents.push(bomData.parentComponent);
        }
      }
    }
    // Collect any crypto keys
    if (options.specVersion >= 1.6 && options.includeCrypto) {
      if (!hasAnyProjectType(["oci"], options, false)) {
        thoughtLog(
          "**CBOM**: Wait, the user wants me to look for cryptographic assets. Let's check thoroughly.",
        );
      }
      bomData = await createCryptoCertsBom(path, options);
      if (bomData?.bomJson?.components?.length) {
        thoughtLog(
          `I found ${bomData.bomJson.components.length} crypto assets.`,
        );
        if (DEBUG_MODE) {
          console.log(
            `Found ${bomData.bomJson.components.length} crypto assets at ${path}`,
          );
        }
        components = components.concat(bomData.bomJson.components);
      }
    }
  } // for
  if (
    options.lastWorkingDir &&
    options.lastWorkingDir !== "" &&
    !options.lastWorkingDir.includes("/opt/") &&
    !options.lastWorkingDir.includes("/home/")
  ) {
    bomData = createJarBom(options.lastWorkingDir, options);
    if (bomData?.bomJson?.components?.length) {
      if (DEBUG_MODE) {
        console.log(
          `Found ${bomData.bomJson.components.length} jar packages at ${options.lastWorkingDir}`,
        );
      }
      components = components.concat(bomData.bomJson.components);
      dependencies = mergeDependencies(
        dependencies,
        bomData.bomJson.dependencies,
      );
      if (
        bomData.parentComponent &&
        Object.keys(bomData.parentComponent).length
      ) {
        parentSubComponents.push(bomData.parentComponent);
      }
    }
  }
  // Retain the components of parent component
  if (parentSubComponents.length) {
    if (!hasAnyProjectType(["oci"], options, false)) {
      thoughtLog("**METADATA**: Tweaking the parent component hierarchy.");
    }
    if (!parentComponent || !Object.keys(parentComponent).length) {
      parentComponent = parentSubComponents[0];
    }
    // Our naive approach to appending to sub-components could result in same parent being included as a child
    // This is filtered out here
    parentSubComponents = parentSubComponents.filter(
      (c) => c["bom-ref"] !== parentComponent["bom-ref"],
    );
    parentComponent.components = trimComponents(parentSubComponents);
    if (
      parentComponent.components.length === 1 &&
      parentComponent.components[0].name === parentComponent.name &&
      !parentComponent.purl.startsWith("pkg:container")
    ) {
      parentComponent = parentComponent.components[0];
      delete parentComponent.components;
    }
    // Add references between the multiple sub-boms
    let parentDependencies = dependencies.find(
      (d) => d["ref"] === parentComponent["bom-ref"],
    );
    if (!parentDependencies) {
      parentDependencies = {
        ref: parentComponent["bom-ref"],
      };
      dependencies = mergeDependencies(dependencies, parentDependencies);
    }
    if (!parentDependencies["dependsOn"]) {
      parentDependencies["dependsOn"] = [];
    }
    for (const parentSub of parentSubComponents) {
      // Issue: 1622. We might have already captured this parent component dependency
      if (!parentDependencies["dependsOn"].includes(parentSub["bom-ref"])) {
        parentDependencies["dependsOn"].push(parentSub["bom-ref"]);
      }
    }
  }
  // some cleanup, but not complete
  for (const path of pathList) {
    if (path.startsWith(join(getTmpDir(), "docker-images-"))) {
      if (rmSync) {
        rmSync(path, { recursive: true, force: true });
      }
    }
  }
  return dedupeBom(options, components, parentComponent, dependencies);
}

/**
 * Function to create bom string for various languages
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 */
export async function createXBom(path, options) {
  try {
    accessSync(path, constants.R_OK);
  } catch (_err) {
    return undefined;
  }
  if (
    safeExistsSync(join(path, "package.json")) ||
    safeExistsSync(join(path, "rush.json")) ||
    safeExistsSync(join(path, "yarn.lock"))
  ) {
    return await createNodejsBom(path, options);
  }
  // maven - pom.xml
  const pomFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}pom.xml`,
    options,
  );
  // gradle
  const gradleFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}build.gradle*`,
    options,
  );
  // scala sbt
  const sbtFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}{build.sbt,Build.scala}*`,
    options,
  );
  if (pomFiles.length || gradleFiles.length || sbtFiles.length) {
    return await createJavaBom(path, options);
  }
  // python
  const pipenvMode = safeExistsSync(join(path, "Pipfile"));
  const poetryMode = safeExistsSync(join(path, "poetry.lock"));
  const pyProjectMode =
    !poetryMode && safeExistsSync(join(path, "pyproject.toml"));
  const setupPyMode = safeExistsSync(join(path, "setup.py"));
  if (pipenvMode || poetryMode || pyProjectMode || setupPyMode) {
    return await createPythonBom(path, options);
  }
  const reqFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}*requirements*.txt`,
    options,
  );
  const reqDirFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}requirements/*.txt`,
    options,
  );
  const requirementsMode = reqFiles?.length || reqDirFiles?.length;
  const whlFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}*.whl`,
    options,
  );
  if (requirementsMode || whlFiles.length) {
    return await createPythonBom(path, options);
  }
  // go
  const gosumFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}go.sum`,
    options,
  );
  const gomodFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}go.mod`,
    options,
  );
  const gopkgLockFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}Gopkg.lock`,
    options,
  );
  if (gomodFiles.length || gosumFiles.length || gopkgLockFiles.length) {
    return await createGoBom(path, options);
  }

  // rust
  const cargoLockFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}Cargo.lock`,
    options,
  );
  const cargoFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}Cargo.toml`,
    options,
  );
  if (cargoLockFiles.length || cargoFiles.length) {
    return await createRustBom(path, options);
  }

  // php
  const composerJsonFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}composer.json`,
    options,
  );
  const composerLockFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}composer.lock`,
    options,
  );
  if (composerJsonFiles.length || composerLockFiles.length) {
    return createPHPBom(path, options);
  }

  // Ruby
  const gemFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}Gemfile`,
    options,
  );
  const gemLockFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}Gemfile*.lock`,
    options,
  );
  if (gemFiles.length || gemLockFiles.length) {
    return await createRubyBom(path, options);
  }

  // .Net
  const csProjFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}*.{cs,vb,fs,ts,hmi,plc}proj`,
    options,
  );
  if (csProjFiles.length) {
    return await createCsharpBom(path, options);
  }

  // Dart
  const pubFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}pubspec.lock`,
    options,
  );
  const pubSpecFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}pubspec.yaml`,
    options,
  );
  if (pubFiles.length || pubSpecFiles.length) {
    return await createDartBom(path, options);
  }

  // Haskell
  const hackageFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}cabal.project.freeze`,
    options,
  );
  if (hackageFiles.length) {
    return createHaskellBom(path, options);
  }

  // Elixir
  const mixFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}mix.lock`,
    options,
  );
  if (mixFiles.length) {
    return createElixirBom(path, options);
  }

  // cpp
  const conanLockFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}conan.lock`,
    options,
  );
  const conanFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}conanfile.txt`,
    options,
  );
  const cmakeListFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}CMakeLists.txt`,
    options,
  );
  const mesonBuildFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}meson.build`,
    options,
  );
  if (
    conanLockFiles.length ||
    conanFiles.length ||
    cmakeListFiles.length ||
    mesonBuildFiles.length
  ) {
    return createCppBom(path, options);
  }

  // clojure
  const ednFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}deps.edn`,
    options,
  );
  const leinFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}project.clj`,
    options,
  );
  if (ednFiles.length || leinFiles.length) {
    return createClojureBom(path, options);
  }

  // GitHub actions
  const ghactionFiles = getAllFiles(
    path,
    ".github/workflows/" + "*.{yml,yaml}",
    options,
  );
  if (ghactionFiles.length) {
    return createGitHubBom(path, options);
  }

  // Jenkins plugins
  const hpiFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}*.hpi`,
    options,
  );
  if (hpiFiles.length) {
    return await createJenkinsBom(path, options);
  }

  // Helm charts
  const chartFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}Chart.yaml`,
    options,
  );
  const yamlFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}values.yaml`,
    options,
  );
  if (chartFiles.length || yamlFiles.length) {
    return createHelmBom(path, options);
  }

  // Docker compose, dockerfile, containerfile, kubernetes and skaffold
  const dcFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}docker-compose*.yml`,
    options,
  );
  const dfFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}*Dockerfile*`,
    options,
  );
  const cfFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}*Containerfile*`,
    options,
  );
  const skFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}skaffold.yaml`,
    options,
  );
  const deplFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}deployment.yaml`,
    options,
  );
  if (
    dcFiles.length ||
    dfFiles.length ||
    cfFiles.length ||
    skFiles.length ||
    deplFiles.length
  ) {
    return await createContainerSpecLikeBom(path, options);
  }

  // Google CloudBuild
  const cbFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}cloudbuild.yaml`,
    options,
  );
  if (cbFiles.length) {
    return createCloudBuildBom(path, options);
  }

  // Swift
  const swiftFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}Package*.swift`,
    options,
  );
  const pkgResolvedFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}Package.resolved`,
    options,
  );
  if (swiftFiles.length || pkgResolvedFiles.length) {
    return await createSwiftBom(path, options);
  }

  // Cocoa
  const cocoaFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}Podfile`,
    options,
  );
  if (cocoaFiles.length) {
    return await createCocoaBom(path, options);
  }

  // Nix flakes
  const flakeNixFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}flake.nix`,
    options,
  );
  const flakeLockFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}flake.lock`,
    options,
  );
  if (flakeNixFiles.length || flakeLockFiles.length) {
    return await createNixBom(path, options);
  }
}

/**
 * Function to create bom string for various languages
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 */
export async function createBom(path, options) {
  let { projectType } = options;
  if (!projectType) {
    projectType = [];
  }
  let exportData;
  let isContainerMode = false;
  // Docker and image archive support
  // TODO: Support any source archive
  if (path.endsWith(".tar") || path.endsWith(".tar.gz")) {
    exportData = await exportArchive(path, options);
    if (!exportData) {
      console.log(
        `OS BOM generation has failed due to problems with exporting the image ${path}`,
      );
      options.failOnError && process.exit(1);
      return {};
    }
    isContainerMode = true;
  } else if (
    (options.projectType &&
      !options.projectType?.includes("universal") &&
      hasAnyProjectType(["oci"], options, false)) ||
    path.startsWith("docker.io") ||
    path.startsWith("quay.io") ||
    path.startsWith("ghcr.io") ||
    path.startsWith("mcr.microsoft.com") ||
    path.includes("@sha256") ||
    path.includes(":latest")
  ) {
    exportData = await exportImage(path, options);
    if (exportData) {
      isContainerMode = true;
    } else {
      // Fail early for oci types
      if (hasAnyProjectType(["oci"], options, false)) {
        console.log(
          `OCI BOM generation has failed due to problems with exporting the image ${path}.`,
        );
        options.failOnError && process.exit(1);
        return {};
      }
      if (DEBUG_MODE) {
        console.log(path, "doesn't appear to be a valid container image.");
      }
    }
  } else if (
    !options.projectType?.includes("universal") &&
    hasAnyProjectType(["oci-dir"], options, false)
  ) {
    isContainerMode = true;
    exportData = {
      inspectData: undefined,
      lastWorkingDir: "",
      allLayersDir: path,
      allLayersExplodedDir: path,
    };
    if (safeExistsSync(join(path, "all-layers"))) {
      exportData.allLayersDir = join(path, "all-layers");
    }
    exportData.pkgPathList = getPkgPathList(exportData, undefined);
  }
  if (isContainerMode) {
    options.multiProject = true;
    options.installDeps = false;
    // Force the project type to oci
    options.projectType = ["oci"];
    // Pass the original path
    options.path = path;
    options.parentComponent = {};
    // Create parent component based on the inspect config
    const inspectData = exportData?.inspectData;
    if (
      inspectData?.RepoDigests &&
      inspectData.RepoTags &&
      Array.isArray(inspectData.RepoDigests) &&
      Array.isArray(inspectData.RepoTags) &&
      inspectData.RepoDigests.length &&
      inspectData.RepoTags.length
    ) {
      const repoTag = inspectData.RepoTags[0];
      if (repoTag) {
        const tmpA = repoTag.split(":");
        if (tmpA && tmpA.length === 2) {
          options.parentComponent = {
            name: tmpA[0],
            version: tmpA[1],
            type: "container",
            purl: `pkg:oci/${inspectData.RepoDigests[0]}`,
            _integrity: inspectData.RepoDigests[0].replace(
              "sha256:",
              "sha256-",
            ),
          };
          options.parentComponent["bom-ref"] = decodeURIComponent(
            options.parentComponent.purl,
          );
        }
      } else if (inspectData.Id) {
        options.parentComponent = {
          name: inspectData.RepoDigests[0].split("@")[0],
          version: inspectData.RepoDigests[0]
            .split("@")[1]
            .replace("sha256:", ""),
          type: "container",
          purl: `pkg:oci/${inspectData.RepoDigests[0]}`,
          _integrity: inspectData.RepoDigests[0].replace("sha256:", "sha256-"),
        };
        options.parentComponent["bom-ref"] = decodeURIComponent(
          options.parentComponent.purl,
        );
      }
    } else {
      options.parentComponent = createDefaultParentComponent(
        path,
        "container",
        options,
      );
    }
    // Pass the entire export data about the image layers
    options.exportData = exportData;
    if (exportData?.binPaths) {
      options.binPaths = exportData.binPaths;
    }
    options.lastWorkingDir = exportData?.lastWorkingDir;
    options.allLayersExplodedDir = exportData?.allLayersExplodedDir;
    return await createMultiXBom(
      [...new Set(exportData?.pkgPathList)],
      options,
    );
  }
  if (path.endsWith(".war")) {
    projectType = ["java"];
  }
  if (projectType.length > 1) {
    thoughtLog(
      `The user has specified multiple project types: ${projectType.join(", ")}. Let's focus on the types one at a time.`,
    );
    console.log("Generate BOM for project types:", projectType.join(", "));
    return await createMultiXBom(path, options);
  }
  if (projectType.length === 1) {
    if (hasAnyProjectType(["oci"], options, false)) {
      thoughtLog(
        "Okay, we're generating an SBOM for the OCI type. We'll need a compatible tool like Docker, Podman, or Nerdctl, along with the binary plugins.",
      );
    } else {
      thoughtLog(
        `The user wants me to focus on a single type, '${projectType}'.`,
      );
    }
  }
  // Use the project type alias to return any singular BOM
  if (PROJECT_TYPE_ALIASES["java"].includes(projectType[0])) {
    return await createJavaBom(path, options);
  }
  if (PROJECT_TYPE_ALIASES["android"].includes(projectType[0])) {
    return createAndroidBom(path, options);
  }
  if (
    PROJECT_TYPE_ALIASES["js"].includes(projectType[0]) ||
    projectType?.[0]?.startsWith("node")
  ) {
    return await createNodejsBom(path, options);
  }
  if (
    PROJECT_TYPE_ALIASES["py"].includes(projectType[0]) ||
    projectType?.[0]?.startsWith("python")
  ) {
    return await createPythonBom(path, options);
  }
  if (PROJECT_TYPE_ALIASES["go"].includes(projectType[0])) {
    return await createGoBom(path, options);
  }
  if (PROJECT_TYPE_ALIASES["rust"].includes(projectType[0])) {
    return await createRustBom(path, options);
  }
  if (PROJECT_TYPE_ALIASES["php"].includes(projectType[0])) {
    return createPHPBom(path, options);
  }
  if (
    PROJECT_TYPE_ALIASES["ruby"].includes(projectType[0]) ||
    projectType?.[0]?.startsWith("ruby")
  ) {
    return await createRubyBom(path, options);
  }
  if (PROJECT_TYPE_ALIASES["csharp"].includes(projectType[0])) {
    return await createCsharpBom(path, options);
  }
  if (PROJECT_TYPE_ALIASES["dart"].includes(projectType[0])) {
    return await createDartBom(path, options);
  }
  if (PROJECT_TYPE_ALIASES["haskell"].includes(projectType[0])) {
    return createHaskellBom(path, options);
  }
  if (PROJECT_TYPE_ALIASES["elixir"].includes(projectType[0])) {
    return createElixirBom(path, options);
  }
  if (PROJECT_TYPE_ALIASES["c"].includes(projectType[0])) {
    return createCppBom(path, options);
  }
  if (PROJECT_TYPE_ALIASES["clojure"].includes(projectType[0])) {
    return createClojureBom(path, options);
  }
  if (PROJECT_TYPE_ALIASES["github"].includes(projectType[0])) {
    return createGitHubBom(path, options);
  }
  if (PROJECT_TYPE_ALIASES["os"].includes(projectType[0])) {
    return await createOSBom(path, options);
  }
  if (PROJECT_TYPE_ALIASES["jenkins"].includes(projectType[0])) {
    return await createJenkinsBom(path, options);
  }
  if (PROJECT_TYPE_ALIASES["helm"].includes(projectType[0])) {
    return createHelmBom(path, options);
  }
  if (PROJECT_TYPE_ALIASES["helm-index"].includes(projectType[0])) {
    return createHelmBom(
      join(homedir(), ".cache", "helm", "repository"),
      options,
    );
  }
  if (PROJECT_TYPE_ALIASES["universal"].includes(projectType[0])) {
    return await createContainerSpecLikeBom(path, options);
  }
  if (PROJECT_TYPE_ALIASES["cloudbuild"].includes(projectType[0])) {
    return createCloudBuildBom(path, options);
  }
  if (PROJECT_TYPE_ALIASES["swift"].includes(projectType[0])) {
    return await createSwiftBom(path, options);
  }
  if (PROJECT_TYPE_ALIASES["binary"].includes(projectType[0])) {
    return createBinaryBom(path, options);
  }
  if (PROJECT_TYPE_ALIASES["cocoa"].includes(projectType[0])) {
    return await createCocoaBom(path, options);
  }
  if (PROJECT_TYPE_ALIASES["nix"].includes(projectType[0])) {
    return await createNixBom(path, options);
  }
  switch (projectType[0]) {
    case "jar":
      return createJarBom(path, options);
    case "gradle-index":
    case "gradle-cache":
      options.useGradleCache = true;
      return createJarBom(GRADLE_CACHE_DIR, options);
    case "sbt-index":
    case "sbt-cache":
      options.useSbtCache = true;
      return createJarBom(SBT_CACHE_DIR, options);
    case "maven-index":
    case "maven-cache":
    case "maven-repo":
      options.useMavenCache = true;
      return createJarBom(
        process.env.MAVEN_CACHE_DIR || join(homedir(), ".m2", "repository"),
        options,
      );
    default:
      // In recurse mode return multi-language Bom
      // https://github.com/cyclonedx/cdxgen/issues/95
      if (options.multiProject) {
        return await createMultiXBom(path, options);
      }
      return await createXBom(path, options);
  }
}

/**
 * Method to submit the generated bom to dependency-track or cyclonedx server
 *
 * @param {Object} args CLI args
 * @param {Object} bomContents BOM Json
 * @return {Promise<{ token: string } | undefined>} a promise with a token (if request was successful) or undefined (in case of invalid arguments)
 * @throws {Error} if the request fails
 */
export async function submitBom(args, bomContents) {
  const serverUrl = `${args.serverUrl.replace(/\/$/, "")}/api/v1/bom`;
  let encodedBomContents = Buffer.from(JSON.stringify(bomContents)).toString(
    "base64",
  );
  if (encodedBomContents.startsWith("77u/")) {
    encodedBomContents = encodedBomContents.substring(4);
  }
  const bomPayload = {
    autoCreate: "true",
    bom: encodedBomContents,
  };
  const projectVersion = args.projectVersion || "main";
  if (
    typeof args.projectId !== "undefined" ||
    (typeof args.projectName !== "undefined" &&
      typeof projectVersion !== "undefined")
  ) {
    if (typeof args.projectId !== "undefined") {
      bomPayload.project = args.projectId;
    }
    if (typeof args.projectName !== "undefined") {
      bomPayload.projectName = args.projectName;
    }
    if (typeof projectVersion !== "undefined") {
      bomPayload.projectVersion = projectVersion;
    }
  } else {
    console.log(
      "projectId, projectName and projectVersion, or all three must be provided.",
    );
    args.failOnError && process.exit(1);
    return;
  }
  if (
    typeof args.parentProjectId !== "undefined" ||
    typeof args.parentUUID !== "undefined"
  ) {
    bomPayload.parentUUID = args.parentProjectId || args.parentUUID;
  }
  if (DEBUG_MODE) {
    console.log(
      "Submitting BOM to",
      serverUrl,
      "params",
      args.projectName,
      projectVersion,
    );
  }
  try {
    if (DEBUG_MODE && args.skipDtTlsCheck) {
      console.log(
        "Calling ",
        serverUrl,
        "with --skip-dt-tls-check argument: Skip DT TLS check.",
      );
    }
    // See issue #1963 regarding CRLF hardening
    return await got(serverUrl, {
      method: "PUT",
      https: {
        rejectUnauthorized: !args.skipDtTlsCheck,
      },
      headers: {
        "X-Api-Key": (args.apiKey || "").replace(/[\r\n]/g, ""),
        "Content-Type": "application/json",
        "user-agent": `@CycloneDX/cdxgen ${CDXGEN_VERSION}`,
      },
      json: bomPayload,
      responseType: "json",
    }).json();
  } catch (error) {
    if (error.response && error.response.statusCode === 401) {
      // Unauthorized
      console.log(
        "Received Unauthorized error. Check the API key used is valid and has necessary permissions to create projects and upload bom.",
      );
    } else if (error.response && error.response.statusCode === 405) {
      console.log(
        "Method PUT not allowed on Dependency-Track server. Trying with POST ...",
      );
      // Method not allowed errors
      try {
        return await got(serverUrl, {
          method: "POST",
          https: {
            rejectUnauthorized: !args.skipDtTlsCheck,
          },
          headers: {
            "X-Api-Key": args.apiKey,
            "Content-Type": "application/json",
            "user-agent": `@CycloneDX/cdxgen ${CDXGEN_VERSION}`,
          },
          json: bomPayload,
          responseType: "json",
        }).json();
      } catch (error) {
        if (DEBUG_MODE) {
          console.log(
            "Unable to submit the SBOM to the Dependency-Track server using POST method",
            error,
          );
        } else {
          console.log(
            "Unable to submit the SBOM to the Dependency-Track server using POST method",
          );
        }
      }
    } else {
      if (DEBUG_MODE) {
        console.log(
          "Unable to submit the SBOM to the Dependency-Track server using POST method",
          error,
        );
      } else {
        console.log("Unable to submit the SBOM to the Dependency-Track server");
      }
    }
    // rethrow error as function is async and we should try to catch it in the caller
    throw error;
  }
}
