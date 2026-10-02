import {
  accessSync,
  constants,
  lstatSync,
  readFileSync,
  statSync,
} from "node:fs";
import { platform as _platform, availableParallelism, homedir } from "node:os";
import { basename, join } from "node:path";
import process from "node:process";

import {
  cdxgenAgent,
  DEBUG_MODE,
  isAllowedHttpHost,
  isDryRun,
  readEnvironmentVariable,
  recordActivity,
  setActivityContext,
} from "../core/activity.js";
import { recordDegradation } from "../core/buildLedger.js";
import { hasAnyProjectType, PROJECT_TYPE_ALIASES } from "../core/env.js";
import {
  clearFileDiscoveryCache,
  getAllFiles,
  getTmpDir,
  safeExistsSync,
  safeRmSync,
  setDirWalkCacheRoot,
} from "../core/fs.js";
import { thoughtLog } from "../core/logger.js";
import { mapWithConcurrency } from "../core/parallel.js";
import { dirNameStr } from "../core/paths.js";
import { ui } from "../core/ui.js";
import { isElmProjectFile } from "../ecosystems/parsers-elm.js";
import {
  isJuliaManifestFile,
  isJuliaProjectFile,
} from "../ecosystems/parsers-julia.js";
import {
  parseBitbucketPipelinesFile,
  parseContainerFile,
  parseContainerSpecData,
  parseOpenapiSpecData,
  parsePrivadoFile,
} from "../ecosystems/parsers-misc.js";
import { isPyLockFile } from "../ecosystems/pylockutils.js";
import {
  buildDependencyTrackBomRequest,
  getDependencyTrackBomApiUrl,
} from "../helpers/remote/dependency-track.js";
import { optionIncludesAiInventoryProjectType } from "../inventory/aiInventory.js";
import { isCycloneDxComponentTypeEnabled } from "../inventory/bomUtils.js";
import {
  mergeDependencies,
  mergeServices,
  trimComponents,
} from "../inventory/depsUtils.js";
import { buildDynamicComponents } from "../inventory/dynamic.js";
import { convertOSQueryResults } from "../inventory/evidenceUtils.js";
import {
  createHbomDocument,
  ensureHbomRuntimeSupport,
  ensureNoMixedHbomProjectTypes,
  hasHbomProjectType,
} from "../inventory/hbom.js";
import { mergeHostInventoryBoms } from "../inventory/hostTopology.js";
// Imported directly rather than through the utils.js barrel: purl validity is
// checked in a hot path and the barrel is already the root of several import
// cycles.
import { applyPurl, ociPurl } from "../inventory/purl.js";
import { table } from "../inventory/table.js";

export { summarizeAiInventory } from "../inventory/aiInventory.js";

import {
  enrichOSComponentsWithTrustData,
  executeOsQuery,
  getOSPackages,
  getPluginToolComponents,
} from "../managers/binary.js";
import {
  addSkippedSrcFiles,
  exportArchive,
  exportImage,
  getPkgPathList,
  isImageReference,
  parseImageName,
} from "../managers/docker.js";
import {
  buildBomNSData,
  createAndroidBom,
  createBinaryBom,
  createDefaultParentComponent,
  dedupeBom,
  determineParentComponent,
} from "./bomAssembly.js";
import {
  createAgenticBom,
  createAsarBom,
  createCaxaBom,
  createChromeExtensionBom,
  createNodejsBom,
  createVscodeExtensionBom,
  getDirectAiInventoryType,
} from "./jsBom.js";
import {
  createJarBom,
  createJavaBom,
  GRADLE_CACHE_DIR,
  SBT_CACHE_DIR,
} from "./jvmBom.js";

export {
  createAndroidBom,
  createBinaryBom,
  dedupeBom,
  listComponents,
} from "./bomAssembly.js";
export {
  createAsarBom,
  createCaxaBom,
  createChromeExtensionBom,
  createNodejsBom,
  createVscodeExtensionBom,
} from "./jsBom.js";
export { createJarBom, createJavaBom } from "./jvmBom.js";

import {
  createCloudBuildBom,
  createCryptoCertsBom,
  createCsharpBom,
  createGitHubBom,
  createHelmBom,
  createJenkinsBom,
  createPerlBom,
  createPHPBom,
  createPythonBom,
  createRBom,
  createRubyBom,
  createTerraformBom,
} from "./managedBom.js";
import {
  createCargoCacheBom,
  createClojureBom,
  createCocoaBom,
  createCppBom,
  createCrystalBom,
  createDartBom,
  createElixirBom,
  createElmBom,
  createErlangBom,
  createGleamBom,
  createGoBom,
  createHaskellBom,
  createJuliaBom,
  createLuaBom,
  createNimBom,
  createNixBom,
  createOCamlBom,
  createRustBom,
  createSpackBom,
  createSwiftBom,
  createZigBom,
  findStackLockFiles,
  getCargoCacheDir,
} from "./nativeBom.js";

export {
  createCloudBuildBom,
  createCryptoCertsBom,
  createCsharpBom,
  createGitHubBom,
  createHelmBom,
  createJenkinsBom,
  createPerlBom,
  createPHPBom,
  createPixiBom,
  createPythonBom,
  createRBom,
  createRubyBom,
  createTerraformBom,
} from "./managedBom.js";
export {
  createClojureBom,
  createCocoaBom,
  createCppBom,
  createCrystalBom,
  createDartBom,
  createElixirBom,
  createElmBom,
  createErlangBom,
  createGleamBom,
  createGoBom,
  createHaskellBom,
  createJuliaBom,
  createLuaBom,
  createNimBom,
  createNixBom,
  createOCamlBom,
  createRustBom,
  createSpackBom,
  createSwiftBom,
  createZigBom,
} from "./nativeBom.js";

import {
  deferFailOnError,
  isDeferredFailOnError,
} from "../core/deferredExit.js";

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

/**
 * Function to create obom string for the current OS using osquery
 *
 * @param {string} _path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} Promise resolving to BOM object
 */
export function createOSBom(_path, options) {
  console.warn(
    "About to generate OBOM for the current OS installation. This will take several minutes ...",
  );
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    console.warn(
      "Directories that are not readable by the current user will be skipped. Re-run with sudo for a complete OBOM.",
    );
  }
  let pkgList = [];
  let bomData = {};
  let parentComponent = {};
  let externalTools = getPluginToolComponents(["osquery"]);
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
  const hostTrustInventory = enrichOSComponentsWithTrustData(pkgList);
  if (hostTrustInventory?.components?.length) {
    pkgList = hostTrustInventory.components;
  }
  if (hostTrustInventory?.tools?.length) {
    externalTools = externalTools.concat(hostTrustInventory.tools);
  }
  if (externalTools.length) {
    options.tools = Array.from(
      new Map(
        externalTools.map((tool) => [tool["bom-ref"] || tool.name, tool]),
      ).values(),
    );
  }
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
 * Function to create bom string for docker compose
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} Promise resolving to BOM object
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
              name: "internal:SrcFile",
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
              name: "internal:ServiceName",
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
              name: "internal:SrcFile",
              value: af,
            },
          ];
        }
        services = mergeServices(services, servlist);
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
      services = mergeServices(services, servlist);
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
          services = mergeServices(services, mbomData.bomJson.services);
        }
      }
      if (DEBUG_MODE) {
        console.log(
          `Received ${components.length} unfiltered components ${dependencies.length} dependencies so far.`,
        );
      }
    }
  }
  options.services = mergeServices([], services);
  options.ociSpecs = ociSpecs;
  return dedupeBom(options, components, parentComponent, dependencies);
}

/**
 * Decide how many paths of a multi-path scan may be inspected at once.
 *
 * A container image contributes around twenty rootfs paths, each of which is
 * offered to every ecosystem, so overlapping them shortens the scan. Two
 * situations stay sequential. A single path has nothing to overlap. Dry run and
 * debug mode narrate their progress through one activity context and one log,
 * so their output describes the paths one at a time.
 *
 * The bound follows the processor count and stops at eight, matching the worker
 * pool. Every path also resolves packages over the network, where requests are
 * already batched per host, so a registry sees the product of the two bounds.
 *
 * @param {string[]} pathList Paths about to be scanned
 * @returns {number} Number of paths to scan at once
 */
function pathScanConcurrency(pathList) {
  if (!pathList || pathList.length < 2 || isDryRun || DEBUG_MODE) {
    return 1;
  }
  const defaultLimit = Math.min(availableParallelism() || 4, 8);
  const configured = Number.parseInt(
    readEnvironmentVariable("CDXGEN_MAX_PATH_SCANS") || String(defaultLimit),
    10,
  );
  const limit =
    Number.isNaN(configured) || configured < 1 ? defaultLimit : configured;
  return Math.min(pathList.length, limit);
}

/**
 * Function to create bom string for all languages
 *
 * @param {string[]} pathList list of to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} Promise resolving to BOM object
 */
/**
 * Join non-zero counts into a phase summary.
 *
 * Each entry carries its own plural form rather than having one appended, so
 * nouns like "shared library" read correctly.
 *
 * @param {Array<[number, string, string]>} entries Count, singular, and plural
 * @returns {string} Summary such as "412 OS packages, 3 services"
 */
export function summarizeCounts(entries) {
  return entries
    .filter(([count]) => count > 0)
    .map(
      ([count, singular, plural]) =>
        `${count} ${count === 1 ? singular : plural}`,
    )
    .join(", ");
}

/**
 * Summarize components by purl type, so a scan reports "412 npm, 88 pypi"
 * rather than an anonymous total.
 *
 * @param {object[]} components Components carrying purls
 * @returns {string} Comma-separated counts, busiest type first
 */
export function summarizePurlTypes(components) {
  const counts = new Map();
  for (const component of components) {
    const purlType = `${component?.purl || ""}`.split("/")[0].slice(4);
    const key = purlType || component?.type || "component";
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([type, count]) => `${count} ${type}`)
    .join(", ");
}

/**
 * Generates BOMs across multiple project types and/or paths, then merges and
 * deduplicates the results into a single BOM namespace data object. Handles
 * OCI/container inventory, per-path scans, formulation accumulation, and
 * parent-component reconciliation.
 *
 * @param {string|string[]} pathList Comma-separated string or array of paths
 * @param {object} options CLI options
 * @returns {Promise<object>} Promise resolving to a deduplicated BOM namespace
 *   data object (components, dependencies, bomJson, parentComponent, etc.)
 */
export async function createMultiXBom(pathList, options) {
  let components = [];
  let dependencies = [];
  let bomData;
  let formulationList = [];
  let parentComponent = determineParentComponent(options) || {};
  let parentSubComponents = [];
  const setProjectTypeActivityContext = (projectType, sourcePath) => {
    setActivityContext({
      projectType,
      sourcePath,
    });
  };
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
    const osPhase = ui.phase("Inventorying OS packages");
    const {
      osPackages,
      osPackageFiles,
      dependenciesList,
      allTypes,
      bundledSdks,
      bundledRuntimes,
      binPaths,
      executables,
      sharedLibs,
      services,
      tools,
    } = await getOSPackages(
      options.allLayersExplodedDir,
      options.exportData?.inspectData?.Config,
      options,
    );
    osPhase.succeed(
      summarizeCounts([
        [osPackages.length, "OS package", "OS packages"],
        [osPackageFiles?.length, "package-owned file", "package-owned files"],
        [executables?.length, "executable", "executables"],
        [sharedLibs?.length, "shared library", "shared libraries"],
        [services?.length, "service", "services"],
      ]),
    );
    // TODO: Need to test these with docker-compose type where multiple images could have different values.
    // This is also clearly misusing options, which must become immutable at some point.
    options.bundledSdks = bundledSdks;
    options.bundledRuntimes = bundledRuntimes;
    options.binPaths = binPaths;
    options.unpackagedExecutableCount = executables?.length || 0;
    options.unpackagedSharedLibraryCount = sharedLibs?.length || 0;
    if (DEBUG_MODE) {
      console.log(
        `**OS**: Found ${osPackages.length} OS packages, ${osPackageFiles?.length} package-owned files, ${executables?.length} unpackaged executables, ${sharedLibs.length} unpackaged shared libraries, and ${services?.length || 0} packaged services at ${options.allLayersExplodedDir}`,
      );
    }
    if (osPackages.length) {
      thoughtLog(
        `I found ${osPackages.length} OS packages, ${osPackageFiles?.length || 0} package-owned files, and ${services?.length || 0} packaged services at ${options.allLayersExplodedDir}`,
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
    if (tools?.length) {
      options.tools = (
        Array.isArray(options.tools)
          ? options.tools
          : options.tools?.components || []
      ).concat(tools);
    }
    components = components.concat(osPackages);
    components = components.concat(osPackageFiles || []);
    components = components.concat(executables);
    components = components.concat(sharedLibs);
    if (dependenciesList?.length) {
      dependencies = mergeDependencies(dependencies, dependenciesList);
    }
    if (services?.length) {
      options.services = mergeServices(options.services || [], services);
    }
    if (parentComponent && Object.keys(parentComponent).length) {
      // Make the parent oci image depend on all os components
      const parentDependsOn = new Set(
        osPackages.concat(osPackageFiles || []).map((p) => p["bom-ref"]),
      );
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
  const sharedOptions = options;
  // The exploded image layers are written once by the extractor and only read
  // from here on, so repeated walks of them can share one view of the tree.
  setDirWalkCacheRoot(options.allLayersExplodedDir);
  const scanOnePath = async (path) => {
    try {
      return await scanOnePathInner(path);
    } catch (err) {
      if (!isDeferredFailOnError(err)) {
        throw err;
      }
      // The failing path contributes nothing, and the remaining paths still
      // do: fail-on-error scopes the loss to the leg that failed.
      return {
        components: [],
        dependencies: [],
        options: { ...sharedOptions },
        parentSubComponents: [],
      };
    }
  };
  const scanOnePathInner = async (path) => {
    // Each path accumulates into its own lists and its own view of options, so
    // that legs which record a parent component or a tool cannot overwrite
    // another path's. The lists are merged below in pathList order.
    const options = { ...sharedOptions };
    let bomData;
    let components = [];
    let dependencies = [];
    let parentSubComponents = [];
    setActivityContext({
      projectType: Array.isArray(options.projectType)
        ? options.projectType.join(",")
        : options.projectType,
      sourcePath: path,
    });
    recordActivity({
      kind: "read",
      reason:
        "Scanning project path for supported languages and package managers.",
      status: "completed",
      target: path,
    });
    if (DEBUG_MODE) {
      console.log("Scanning", path);
    }
    if (pathList.length > 2) {
      thoughtLog(`Let's thoroughly check the path ${path}.`);
    }
    // Node.js and AI inventory
    if (
      hasAnyProjectType(["oci", "js"], options) ||
      hasAnyProjectType(["mcp", "ai-skill", "ai"], options) ||
      getDirectAiInventoryType(path, options)
    ) {
      const exactAiInventoryType = getDirectAiInventoryType(path, options);
      if (!hasAnyProjectType(["oci"], options, false)) {
        if (exactAiInventoryType === "mcp") {
          thoughtLog(
            "**MCP**: Looking for MCP services, MCP configs, and related AI control-plane artifacts.",
          );
        } else if (exactAiInventoryType === "ai") {
          thoughtLog(
            "**AI-BOM**: Looking for AI models, direct model metadata, pedigree, quantization, and operator-facing AI context.",
          );
        } else if (exactAiInventoryType === "ai-skill") {
          thoughtLog(
            "**AI-SKILL**: Looking for AI instruction, skill, and agent-definition files that can influence build or release flows.",
          );
        } else {
          thoughtLog(
            "**JS**: Now looking for JavaScript projects (npm, yarn, pnpm) and files.",
          );
        }
      }
      setProjectTypeActivityContext(exactAiInventoryType || "js", path);
      bomData = await createNodejsBom(path, options);
      if (bomData?.bomJson?.components?.length) {
        if (exactAiInventoryType) {
          thoughtLog(
            `I found ${bomData.bomJson.components.length} ${exactAiInventoryType} component(s). Let's keep looking.`,
          );
        } else {
          thoughtLog(
            `I found ${bomData.bomJson.components.length} npm packages. Let's keep looking.`,
          );
        }
        if (DEBUG_MODE) {
          console.log(
            `Found ${bomData.bomJson.components.length} ${exactAiInventoryType || "npm"} components at ${path}`,
          );
        }
        components = components.concat(bomData.bomJson.components);
        dependencies = mergeDependencies(
          dependencies,
          bomData.bomJson.dependencies,
        );
        if (bomData?.bomJson?.services?.length) {
          options.services = mergeServices(
            options.services || [],
            bomData.bomJson.services,
          );
        }
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
      setProjectTypeActivityContext("java", path);
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
          if (
            !["false", "0"].includes(
              readEnvironmentVariable("GRADLE_RESOLVE_FROM_NODE"),
            )
          ) {
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
      if (
        readEnvironmentVariable("CDXGEN_IN_CONTAINER") !== "true" &&
        pathList.length <= 2
      ) {
        thoughtLog(
          "I'm running in a non-container environment. Let's hope the correct build tools are available ✌️.",
        );
      }
      setProjectTypeActivityContext("py", path);
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
      if (bomData?.formulationList?.length) {
        formulationList = formulationList.concat(bomData.formulationList);
      }
    }
    if (hasAnyProjectType(["oci", "go"], options)) {
      if (!hasAnyProjectType(["oci"], options, false)) {
        thoughtLog(
          "**GO**: Looking for go projects. I need to be cautious about purl namespaces and potential failures with the 'go list' command.",
        );
      }
      setProjectTypeActivityContext("go", path);
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
      setProjectTypeActivityContext("rust", path);
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
      setProjectTypeActivityContext("php", path);
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
      setProjectTypeActivityContext("ruby", path);
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
      setProjectTypeActivityContext("csharp", path);
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
      setProjectTypeActivityContext("dart", path);
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
      setProjectTypeActivityContext("haskell", path);
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
      setProjectTypeActivityContext("elixir", path);
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
      setProjectTypeActivityContext("c", path);
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
      // presets and compilers describe the build, whatever it depends on
      if (bomData?.formulationList?.length) {
        formulationList = formulationList.concat(bomData.formulationList);
      }
    }
    if (hasAnyProjectType(["oci", "clojure"], options)) {
      if (!hasAnyProjectType(["oci"], options, false)) {
        thoughtLog(
          "**CLOJURE**: Looking for Clojure projects. Should I warn the user that the purl namespace 'clojars' isn't widely supported by tools like Dependency-Track?",
        );
      }
      setProjectTypeActivityContext("clojure", path);
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
      setProjectTypeActivityContext("github", path);
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
      setProjectTypeActivityContext("cloudbuild", path);
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
      setProjectTypeActivityContext("swift", path);
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
      setProjectTypeActivityContext("jar", path);
      recordDegradation("jvm.jar.heuristic", {
        ecosystem: "java",
        tool: "jar",
        impact: "versions",
        path,
        detail:
          "Components are being inferred by scanning jar/war/ear files from disk.",
      });
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
      setProjectTypeActivityContext("cocoa", path);
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
      setProjectTypeActivityContext("nix", path);
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
    if (hasAnyProjectType(["caxa"], options, false)) {
      setProjectTypeActivityContext("caxa", path);
      bomData = await createCaxaBom(path, options);
      if (bomData?.bomJson?.components?.length) {
        if (DEBUG_MODE) {
          console.log(
            `Found ${bomData.bomJson.components.length} caxa packages at ${path}`,
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
    if (hasAnyProjectType(["asar"], options, false)) {
      setProjectTypeActivityContext("asar", path);
      bomData = await createAsarBom(path, options);
      if (bomData?.bomJson?.components?.length) {
        if (DEBUG_MODE) {
          console.log(
            `Found ${bomData.bomJson.components.length} ASAR component(s) at ${path}`,
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
    if (hasAnyProjectType(["vscode-extension"], options, false)) {
      setProjectTypeActivityContext("vscode-extension", path);
      bomData = await createVscodeExtensionBom(path, options);
      if (bomData?.bomJson?.components?.length) {
        if (DEBUG_MODE) {
          console.log(
            `Found ${bomData.bomJson.components.length} VS Code extension(s) at ${path}`,
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
    if (hasAnyProjectType(["chrome-extension"], options, false)) {
      let isExplicitChromeExtensionPath = false;
      if (safeExistsSync(path)) {
        if (basename(path) === "manifest.json") {
          isExplicitChromeExtensionPath = true;
        } else {
          try {
            isExplicitChromeExtensionPath =
              statSync(path).isDirectory() &&
              safeExistsSync(join(path, "manifest.json"));
          } catch (_err) {
            isExplicitChromeExtensionPath = false;
          }
        }
      }
      if (
        isExplicitChromeExtensionPath ||
        !sharedOptions.__didScanChromeExtensions
      ) {
        if (!isExplicitChromeExtensionPath) {
          sharedOptions.__didScanChromeExtensions = true;
        }
        setProjectTypeActivityContext("chrome-extension", path);
        bomData = await createChromeExtensionBom(path, options);
        if (bomData?.bomJson?.components?.length) {
          if (DEBUG_MODE) {
            console.log(
              `Found ${bomData.bomJson.components.length} Chrome extension(s) on this host`,
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
    }
    // Collect any crypto keys
    if (
      options.specVersion >= 1.6 &&
      options.includeCrypto &&
      isCycloneDxComponentTypeEnabled("cryptographic-asset", options)
    ) {
      if (!hasAnyProjectType(["oci"], options, false)) {
        thoughtLog(
          "**CBOM**: Wait, the user wants me to look for cryptographic assets. Let's check thoroughly.",
        );
      }
      setProjectTypeActivityContext("cbom", path);
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
    return { components, dependencies, options, parentSubComponents };
  };
  const pathResults = [];
  // A container scan walks hundreds of paths, so the phase carries a bar and
  // names the path in flight rather than sitting silent for minutes.
  const scanPhase = ui.phase(
    `Scanning ${pathList.length} ${pathList.length === 1 ? "path" : "paths"}`,
  );
  let scannedPaths = 0;
  let foundComponents = 0;
  // Layer paths live under a temp directory whose name carries no information.
  // Reporting them relative to the exploded root shows the path as it exists
  // inside the image.
  const explodedRoot = options.allLayersExplodedDir;
  const displayPath = (path) =>
    explodedRoot && path.startsWith(explodedRoot)
      ? path.slice(explodedRoot.length) || "/"
      : path;
  const trackedScanOnePath = async (path) => {
    scanPhase.detail(displayPath(path));
    try {
      const result = await scanOnePath(path);
      // Paths that yielded nothing stay silent, so the scrollback above the
      // live region reads as a running list of what was actually found.
      if (result.components.length) {
        foundComponents += result.components.length;
        ui.print(
          `  ${summarizePurlTypes(result.components)} in ${displayPath(path)}`,
        );
      }
      return result;
    } finally {
      scannedPaths += 1;
      scanPhase.progress(scannedPaths, pathList.length);
    }
  };
  if (pathScanConcurrency(pathList) > 1) {
    pathResults.push(
      ...(await mapWithConcurrency(
        pathList,
        trackedScanOnePath,
        pathScanConcurrency(pathList),
      )),
    );
  } else {
    for (const path of pathList) {
      pathResults.push(await trackedScanOnePath(path));
    }
  }
  scanPhase.succeed(
    summarizeCounts([[foundComponents, "component", "components"]]),
  );
  setDirWalkCacheRoot(undefined);
  for (const pathResult of pathResults) {
    components = components.concat(pathResult.components);
    dependencies = mergeDependencies(
      dependencies,
      pathResult.dependencies,
      parentComponent,
    );
    parentSubComponents = parentSubComponents.concat(
      pathResult.parentSubComponents,
    );
    if (pathResult.options.services?.length) {
      sharedOptions.services = mergeServices(
        sharedOptions.services || [],
        pathResult.options.services,
      );
    }
  }
  if (
    options.lastWorkingDir &&
    options.lastWorkingDir !== "" &&
    options.lastWorkingDir !== "/" &&
    !options.lastWorkingDir.includes("/opt/") &&
    !options.lastWorkingDir.includes("/home/")
  ) {
    setProjectTypeActivityContext("jar", options.lastWorkingDir);
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
      safeRmSync(path, { recursive: true, force: true });
    }
  }
  const multiResult = dedupeBom(
    options,
    components,
    parentComponent,
    dependencies,
  );
  if (formulationList.length) {
    multiResult.formulationList = formulationList;
  }
  return multiResult;
}

/**
 * Function to create a dynamic SBOM by executing a command and tracing the
 * shared libraries it loads at runtime via instrumentation.
 *
 * Components receive scope=required, evidence.identity[].methods[].technique=
 * instrumentation, and confidence 0.8 (version known) or 0.5 (version unknown).
 *
 * @param {string} path - Target path (used as working directory fallback)
 * @param {Object} options - CLI options; must include options.traceCmd
 * @returns {Promise<Object>} Promise resolving to BOM data object
 */
export async function createDynamicBom(path, options) {
  const commandStr = options.traceCmd;
  const workingDir = options.traceWorkingDir || path || process.cwd();

  if (!commandStr) {
    console.error(
      "Missing required --trace-cmd option for dynamic project type.",
    );
    return buildBomNSData(options, [], "generic", {
      src: workingDir,
      projectType: "dynamic",
    });
  }

  const traceOptions = {
    readPaths: options.traceReadPaths,
    writePaths: options.traceWritePaths,
    maxMemoryMB: options.traceMaxMemoryMB,
    maxCPUCores: options.traceMaxCPUCores,
    maxProcesses: options.traceMaxProcesses,
    timeoutMs: options.traceTimeoutMs,
    disableNetwork: options.traceDisableNetwork ?? true,
    traceHTTPURLs: options.traceHTTPURLs,
    tracePeriod: options.tracePeriod,
    allowEnvs: options.traceAllowEnvs,
    allowHidden: options.traceAllowHidden,
    allowListen: options.traceAllowListen,
    cryptoProbeMode: options.traceCryptoProbeMode,
    enableDiff: options.traceEnableDiff,
    strict: options.traceStrict,
    allowHosts: options.traceAllowHosts,
    allowPorts: options.traceAllowPorts,
    allowUrls: options.traceAllowUrls,
    blockFork: options.traceBlockFork,
    traceExec: options.traceTraceExec,
    allowExec: options.traceAllowExec,
    blockExec: options.traceBlockExec,
    traceCrypto: options.traceCrypto,
    cbom: options.cbom,
    proxyEgress: options.traceProxyEgress,
    allowLoopback: options.traceAllowLoopback,
    dryRun: options.traceDryRun,
    policy: options.tracePolicy,
    policyFile: options.tracePolicyFile,
    blockInterpreters: options.traceBlockInterpreters,
    denyPersistenceWrites: options.traceDenyPersistenceWrites,
    privateTmp: options.tracePrivateTmp,
    protectHome: options.traceProtectHome,
  };

  const {
    components: pkgList,
    services: traceServices,
    dryRunSummary,
  } = await buildDynamicComponents(commandStr, workingDir, traceOptions);

  const bomNSData = buildBomNSData(options, pkgList, "generic", {
    src: workingDir,
    projectType: "dynamic",
    filename: commandStr,
    services: traceServices,
  });
  // A dry run denies every side effect, so the attempted-operation counts are
  // the result. Only counts are recorded, never the paths or targets.
  if (dryRunSummary && bomNSData?.bomJson?.metadata) {
    const metadata = bomNSData.bomJson.metadata;
    metadata.properties = metadata.properties || [];
    metadata.properties.push({ name: "cdx:dynamic:dryRun", value: "true" });
    metadata.properties.push({
      name: "cdx:dynamic:dryRun:captured",
      value: dryRunSummary.captured === false ? "false" : "true",
    });
    for (const [key, value] of Object.entries(dryRunSummary)) {
      if (Number.isInteger(value)) {
        metadata.properties.push({
          name: `cdx:dynamic:dryRun:${key}`,
          value: String(value),
        });
      }
    }
  }
  return bomNSData;
}

/**
 * Function to create bom string for various languages
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object|undefined>} Promise resolving to BOM object, or undefined if path is not readable
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
    safeExistsSync(join(path, "yarn.lock")) ||
    safeExistsSync(join(path, "bun.lock")) ||
    safeExistsSync(join(path, "bun.lockb")) ||
    safeExistsSync(join(path, "deno.lock")) ||
    safeExistsSync(join(path, "deno.json")) ||
    safeExistsSync(join(path, "deno.jsonc"))
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
  const pyLockFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}pylock*.toml`,
    options,
  ).filter((f) => isPyLockFile(f));
  const pyLockMode = pyLockFiles.length > 0;
  const pyProjectMode =
    !poetryMode && !pyLockMode && safeExistsSync(join(path, "pyproject.toml"));
  const setupPyMode = safeExistsSync(join(path, "setup.py"));
  if (pipenvMode || poetryMode || pyLockMode || pyProjectMode || setupPyMode) {
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
  const stackLockDetectFiles = findStackLockFiles(path, options);
  if (hackageFiles.length || stackLockDetectFiles.length) {
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
  const colliderLockFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}collider.lock`,
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
    colliderLockFiles.length ||
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

  // VS Code extensions (.vsix files)
  const vsixFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}*.vsix`,
    options,
  );
  if (vsixFiles.length) {
    return await createVscodeExtensionBom(path, options);
  }

  // Electron ASAR archives
  const asarFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}*.asar`,
    options,
  );
  if (asarFiles.length) {
    return await createAsarBom(path, options);
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

  // Zig
  const zigZonFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}build.zig.zon`,
    options,
  );
  if (zigZonFiles.length) {
    return await createZigBom(path, options);
  }

  // Gleam
  const gleamTomlFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}gleam.toml`,
    options,
  );
  if (gleamTomlFiles.length) {
    return await createGleamBom(path, options);
  }

  // Julia
  const juliaProjectFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}Project.toml`,
    options,
  );
  const juliaManifestFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}Manifest.toml`,
    options,
  );
  // `Project.toml` is not a name Julia owns — Cloud Native Buildpacks use it
  // too — so dispatch only when a file actually declares a Julia environment.
  if (
    juliaManifestFiles.some(isJuliaManifestFile) ||
    juliaProjectFiles.some(isJuliaProjectFile)
  ) {
    return await createJuliaBom(path, options);
  }

  // Erlang with rebar3
  const rebarLockFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}rebar.lock`,
    options,
  );
  if (rebarLockFiles.length) {
    return await createErlangBom(path, options);
  }

  // OCaml with opam
  const opamLockedFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}*.opam.locked`,
    options,
  );
  if (opamLockedFiles.length) {
    return await createOCamlBom(path, options);
  }

  // Elm with elm.json (0.19) or elm-package.json (0.18)
  const elmJsonFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}elm.json`,
    options,
  ).filter(isElmProjectFile);
  const legacyElmFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}elm-package.json`,
    options,
  );
  if (elmJsonFiles.length || legacyElmFiles.length) {
    return await createElmBom(path, options);
  }

  // Crystal with shards
  const shardYmlFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}shard.yml`,
    options,
  );
  if (shardYmlFiles.length) {
    return await createCrystalBom(path, options);
  }

  // Nim with nimble
  const nimbleFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}*.nimble`,
    options,
  );
  if (nimbleFiles.length) {
    return await createNimBom(path, options);
  }

  // Lua with LuaRocks
  const rockspecFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}*.rockspec`,
    options,
  );
  if (rockspecFiles.length) {
    return await createLuaBom(path, options);
  }

  // Spack environments
  const spackLockFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}spack.lock`,
    options,
  );
  if (spackLockFiles.length) {
    return await createSpackBom(path, options);
  }

  // R with renv
  const renvLockFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}renv.lock`,
    options,
  );
  if (renvLockFiles.length) {
    return createRBom(path, options);
  }

  // Perl with Carton
  const cpanSnapshotFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}cpanfile.snapshot`,
    options,
  );
  if (cpanSnapshotFiles.length) {
    return createPerlBom(path, options);
  }

  // Terraform and OpenTofu providers
  const tfLockFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}.terraform.lock.hcl`,
    options,
  );
  if (tfLockFiles.length) {
    return createTerraformBom(path, options);
  }
}

/**
 * Function to create a hardware BOM for the current host.
 *
 * @param {string} _path Source path (unused for live host HBOM generation)
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} Promise resolving to BOM object
 */
export async function createHBom(_path, options) {
  ensureHbomRuntimeSupport(options, options.commandName || "hbom");
  let bomJson = await createHbomDocument(options);
  if (options.includeRuntime) {
    const runtimeOptions = {
      ...options,
      includeRuntime: false,
      multiProject: false,
      projectType: ["os"],
    };
    const obomData = await createOSBom(_path, runtimeOptions);
    bomJson = mergeHostInventoryBoms(bomJson, obomData);
  } else {
    bomJson = mergeHostInventoryBoms(bomJson);
  }
  return {
    bomJson,
    dependencies: bomJson.dependencies || [],
    parentComponent: bomJson.metadata?.component,
  };
}

/**
 * Function to create bom string for various languages
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} Promise resolving to BOM object
 */
/**
 * Generate a BOM for one path, letting a deferred fail-on-error abort return
 * the empty BOM the flag promises rather than unwinding past the reports.
 *
 * @param {string} path Source path.
 * @param {Object} options CLI options.
 * @returns {Promise<Object>} BOM NS data.
 */
export async function createBom(path, options) {
  try {
    return await createBomForPath(path, options);
  } catch (err) {
    if (!isDeferredFailOnError(err)) {
      throw err;
    }
    // fail-on-error forbids an incomplete result, so the extractor kept
    // nothing; the CLI still writes the reports and exits non-zero.
    return buildBomNSData(options, [], "", { src: path, filename: "" });
  }
}

async function createBomForPath(path, options) {
  clearFileDiscoveryCache();
  let { projectType } = options;
  if (!projectType) {
    projectType = [];
  }
  ensureNoMixedHbomProjectTypes(projectType);
  if (hasHbomProjectType(projectType)) {
    const selectedHbomProjectType = Array.isArray(projectType)
      ? projectType[0]
      : `${projectType}`.split(",")[0];
    options.projectType = [selectedHbomProjectType];
    setActivityContext({
      projectType: selectedHbomProjectType,
      sourcePath: path,
    });
    thoughtLog(
      "The user wants a Hardware Bill-of-Materials (HBOM) for the current host. Let's use the dedicated hardware collector.",
    );
    return await createHBom(path, options);
  }
  let exportData;
  let isContainerMode = false;
  const isLocalDirectoryInput =
    !options.projectType?.includes("universal") &&
    safeExistsSync(path) &&
    lstatSync(path).isDirectory();
  // Docker and image archive support
  // TODO: Support any source archive
  if (path.endsWith(".tar") || path.endsWith(".tar.gz")) {
    exportData = await exportArchive(path, options);
    if (!exportData) {
      console.log(
        `OS BOM generation has failed due to problems with exporting the image ${path}`,
      );
      deferFailOnError(options, {
        ecosystem: "container",
        tool: "docker",
        detail: "exporting the image for the OS BOM failed",
      });
      return {};
    }
    isContainerMode = true;
  } else if (
    isLocalDirectoryInput &&
    (hasAnyProjectType(["oci-dir"], options, false) ||
      hasAnyProjectType(["oci"], options, false))
  ) {
    isContainerMode = true;
    exportData = {
      inspectData: undefined,
      lastWorkingDir: "",
      allLayersDir: path,
      allLayersExplodedDir: path,
    };
    if (safeExistsSync(join(path, "all-layers"))) {
      exportData.allLayersExplodedDir = join(path, "all-layers");
    }
    exportData.pkgPathList = getPkgPathList(exportData, undefined);
  } else if (
    (options.projectType &&
      !options.projectType?.includes("universal") &&
      hasAnyProjectType(["oci"], options, false) &&
      // Explicit container types accept every documented image reference
      // style (postgres:15-alpine, shiftleft/scan-slim, registry:5000/ns/img),
      // but only for inputs that cannot be a local path: existing files and
      // directories keep flowing to the tar, oci-dir and source scanners.
      !safeExistsSync(path) &&
      isImageReference(path)) ||
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
        deferFailOnError(options, {
          ecosystem: "container",
          tool: "docker",
          detail: "exporting the image for the OCI BOM failed",
        });
        return {};
      }
      if (DEBUG_MODE) {
        console.log(path, "doesn't appear to be a valid container image.");
      }
    }
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
            _integrity: inspectData.RepoDigests[0].replace(
              "sha256:",
              "sha256-",
            ),
          };
          applyPurl(
            options.parentComponent,
            ociPurl(inspectData.RepoDigests[0], tmpA[1]),
          );
        }
      } else if (inspectData.Id) {
        options.parentComponent = {
          name: inspectData.RepoDigests[0].split("@")[0],
          version: inspectData.RepoDigests[0]
            .split("@")[1]
            .replace("sha256:", ""),
          type: "container",
          _integrity: inspectData.RepoDigests[0].replace("sha256:", "sha256-"),
        };
        applyPurl(options.parentComponent, ociPurl(inspectData.RepoDigests[0]));
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
  if (!projectType.length && path.endsWith(".asar")) {
    projectType = ["asar"];
  }
  if (projectType.length > 1) {
    setActivityContext({
      projectType: projectType.join(","),
      sourcePath: path,
    });
    thoughtLog(
      `The user has specified multiple project types: ${projectType.join(", ")}. Let's focus on the types one at a time.`,
    );
    console.log("Generate BOM for project types:", projectType.join(", "));
    return await createMultiXBom(path, options);
  }
  if (projectType.length === 1) {
    setActivityContext({ projectType: projectType[0], sourcePath: path });
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
  if (PROJECT_TYPE_ALIASES["mcp"].includes(projectType[0])) {
    return await createNodejsBom(path, options);
  }
  if (PROJECT_TYPE_ALIASES["ai-skill"].includes(projectType[0])) {
    return await createNodejsBom(path, options);
  }
  if (optionIncludesAiInventoryProjectType(projectType, "ai")) {
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
  if (PROJECT_TYPE_ALIASES["cargo-cache"].includes(projectType[0])) {
    return await createCargoCacheBom(getCargoCacheDir(), options);
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
  if (PROJECT_TYPE_ALIASES["zig"].includes(projectType[0])) {
    return await createZigBom(path, options);
  }
  if (PROJECT_TYPE_ALIASES["gleam"].includes(projectType[0])) {
    return await createGleamBom(path, options);
  }
  if (PROJECT_TYPE_ALIASES["julia"].includes(projectType[0])) {
    return await createJuliaBom(path, options);
  }
  if (PROJECT_TYPE_ALIASES["erlang"].includes(projectType[0])) {
    return await createErlangBom(path, options);
  }
  if (PROJECT_TYPE_ALIASES["ocaml"].includes(projectType[0])) {
    return await createOCamlBom(path, options);
  }
  if (PROJECT_TYPE_ALIASES["elm"].includes(projectType[0])) {
    return await createElmBom(path, options);
  }
  if (PROJECT_TYPE_ALIASES["crystal"].includes(projectType[0])) {
    return await createCrystalBom(path, options);
  }
  if (PROJECT_TYPE_ALIASES["nim"].includes(projectType[0])) {
    return await createNimBom(path, options);
  }
  if (PROJECT_TYPE_ALIASES["lua"].includes(projectType[0])) {
    return await createLuaBom(path, options);
  }
  if (PROJECT_TYPE_ALIASES["spack"].includes(projectType[0])) {
    return await createSpackBom(path, options);
  }
  if (PROJECT_TYPE_ALIASES["r"].includes(projectType[0])) {
    return createRBom(path, options);
  }
  if (PROJECT_TYPE_ALIASES["perl"].includes(projectType[0])) {
    return createPerlBom(path, options);
  }
  if (PROJECT_TYPE_ALIASES["terraform"].includes(projectType[0])) {
    return createTerraformBom(path, options);
  }
  if (PROJECT_TYPE_ALIASES["caxa"].includes(projectType[0])) {
    return await createCaxaBom(path, options);
  }
  if (PROJECT_TYPE_ALIASES["asar"].includes(projectType[0])) {
    return await createAsarBom(path, options);
  }
  if (PROJECT_TYPE_ALIASES["vscode-extension"].includes(projectType[0])) {
    return await createVscodeExtensionBom(path, options);
  }
  if (PROJECT_TYPE_ALIASES["agentic"].includes(projectType[0])) {
    return await createAgenticBom(path, options);
  }
  if (PROJECT_TYPE_ALIASES["chrome-extension"].includes(projectType[0])) {
    return await createChromeExtensionBom(path, options);
  }
  if (PROJECT_TYPE_ALIASES["dynamic"].includes(projectType[0])) {
    return await createDynamicBom(path, options);
  }
  if (PROJECT_TYPE_ALIASES["ai-provenance"].includes(projectType[0])) {
    return buildBomNSData(options, [], "ai-provenance", { src: path });
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
        readEnvironmentVariable("MAVEN_CACHE_DIR") ||
          join(homedir(), ".m2", "repository"),
        options,
      );
    default:
      // In recurse mode return multi-language Bom
      // https://github.com/cdxgen/cdxgen/issues/95
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
  const dependencyTrackApiUrl = getDependencyTrackBomApiUrl(args.serverUrl);
  const serverUrl = dependencyTrackApiUrl?.toString();
  if (!dependencyTrackApiUrl || !serverUrl) {
    console.log(
      "Invalid Dependency-Track server URL. Provide an absolute http(s) URL without dangerous characters.",
    );
    args.failOnError && process.exit(1);
    return undefined;
  }
  const serverHost = dependencyTrackApiUrl.hostname;
  if (!isAllowedHttpHost(serverHost)) {
    console.log(
      `Dependency-Track server host '${serverHost}' is not allowed by CDXGEN_ALLOWED_HOSTS.`,
    );
    args.failOnError && process.exit(1);
    return undefined;
  }
  if (isDryRun) {
    recordActivity({
      kind: "network",
      reason:
        "Dry run mode blocks Dependency-Track submission and reports the request instead.",
      status: "blocked",
      target: serverUrl,
    });
    return undefined;
  }
  const bomRequest = buildDependencyTrackBomRequest(args, bomContents);
  if (!bomRequest) {
    console.log(
      "Invalid Dependency-Track submission arguments. Provide projectId or projectName (projectVersion defaults to main) and specify parent project either by UUID or by parent project name + version.",
    );
    args.failOnError && process.exit(1);
    return;
  }
  if (DEBUG_MODE) {
    console.log(
      "Submitting BOM to",
      serverUrl,
      "params",
      args.projectName,
      args.projectVersion || "main",
    );
  }
  try {
    const requestOptions = {
      method: "POST",
      followRedirect: false,
      https: {
        rejectUnauthorized: !args.skipDtTlsCheck,
      },
      headers: {
        "X-Api-Key": (args.apiKey || "").replace(/[\r\n]/g, ""),
        "Content-Type": bomRequest.contentType,
      },
      body: bomRequest.body,
      responseType: "json",
      context: {
        activityIntent: "bom-submit",
      },
    };
    if (DEBUG_MODE && args.skipDtTlsCheck) {
      console.log(
        "Calling ",
        serverUrl,
        "with --skip-dt-tls-check argument: Skip DT TLS check.",
      );
    }
    // See issue #1963 regarding CRLF hardening
    return await cdxgenAgent(dependencyTrackApiUrl, requestOptions).json();
  } catch (error) {
    if (error.response && error.response.statusCode === 401) {
      // Unauthorized
      console.log(
        "Received Unauthorized error. Check the API key used is valid and has necessary permissions to create projects and upload bom.",
      );
    } else if (error.response && error.response.statusCode === 405) {
      console.log(
        `The server at ${serverUrl} does not accept a multipart/form-data POST on /api/v1/bom. Check that the URL points to a Dependency-Track 4.x or later API server.`,
      );
    } else if (DEBUG_MODE) {
      console.log(
        "Unable to submit the SBOM to the Dependency-Track server",
        error,
      );
    } else {
      console.log("Unable to submit the SBOM to the Dependency-Track server");
    }
    // rethrow error as function is async and we should try to catch it in the caller
    throw error;
  }
}
