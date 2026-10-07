import { readFileSync } from "node:fs";
import { platform as _platform } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";

import { build } from "@cdxgen/cdx-purl";

import { DEBUG_MODE, readEnvironmentVariable } from "../core/activity.js";
import { recordDegradation } from "../core/buildLedger.js";
import { deferFailOnError } from "../core/deferredExit.js";
import {
  DOTNET_CMD,
  hasAnyProjectType,
  isFeatureEnabled,
  shouldFetchLicense,
  shouldFetchPackageMetadata,
} from "../core/env.js";
import {
  checksumFile,
  getAllFiles,
  getTmpDir,
  safeExistsSync,
  safeMkdtempSync,
  safeRmSync,
  safeSpawnSync,
  safeWriteSync,
} from "../core/fs.js";
import { thoughtLog } from "../core/logger.js";
import { mapWithConcurrency } from "../core/parallel.js";
import {
  extractJarArchive,
  getNugetMetadata,
  getPyMetadata,
  parseBdistMetadata,
} from "../ecosystems/ecosystems.js";
import {
  agreedNugetVersions,
  dotnetManifestProjectDir,
  getCentralPackageVersions,
  indexPropsProperties,
  parseCsPkgData,
  parseCsPkgLockData,
  parseCsProjAssetsData,
  parseCsProjData,
  parseNupkg,
  parsePaketLockData,
  projectPropertyCandidates,
  resolveInstalledNugetVersion,
} from "../ecosystems/parsers-dotnet.js";
import { parseMinJs } from "../ecosystems/parsers-js.js";
import {
  parseCloudBuildData,
  parseComposerJson,
  parseComposerLock,
  parseGitHubWorkflowData,
  parseHelmYamlData,
} from "../ecosystems/parsers-misc.js";
import { parseCpanSnapshot } from "../ecosystems/parsers-perl.js";
import {
  generatePixiLockFile,
  parseMojoProject,
  parsePiplockData,
  parsePixiLockFile,
  parsePixiTomlFile,
  parsePyLockData,
  parsePyProjectTomlFile,
  parseReqFile,
  parseSetupPyFile,
} from "../ecosystems/parsers-python.js";
import { parseRenvLock } from "../ecosystems/parsers-r.js";
import { parseTerraformWorkspace } from "../ecosystems/parsers-terraform.js";
import { collectEmbeddedSboms } from "../ecosystems/pep770.js";
import { isPyLockFile } from "../ecosystems/pylockutils.js";
import {
  createUVLock,
  getPipFrozenTree,
  getPipTreeForPackages,
  getPyModules,
} from "../ecosystems/pythonutils.js";
import {
  addRubyGemsDistributionUrls,
  addRubyRuntimeComponent,
  collectGemModuleNames,
  describeProjectGem,
  enrichGemsFromLocalCache,
  parseBundleConfig,
  parseGemfileLockData,
  parseGemspecData,
} from "../ecosystems/rubyutils.js";
import { getTerraformRegistryMetadata } from "../ecosystems/terraformRegistry.js";
import {
  collectAiInventory,
  summarizeAiInventory,
} from "../inventory/aiInventory.js";
import { detectPythonMcpInventory } from "../inventory/analyzer.js";
import { isCycloneDxComponentTypeEnabled } from "../inventory/bomUtils.js";
import {
  collectDosaiCryptoComponents,
  collectSourceCryptoComponents,
} from "../inventory/cbomutils.js";
import { readZipEntry } from "../inventory/deps.js";
import {
  filterInvalidCryptoComponents,
  isPartialTree,
  mergeDependencies,
  mergeServices,
  recomputeScope,
  trimComponents,
} from "../inventory/depsUtils.js";
import {
  collectDosaiServiceComponents,
  collectDosaiServicesFromMethods,
  createDosaiMethodsSlice,
  dosaiRunWasStopped,
  isDosaiDotnetLanguage,
  normalizeDosaiServiceMap,
  readDosaiMethodsReport,
} from "../inventory/dosai.js";
import { addEvidenceForDotnet } from "../inventory/evidenceUtils.js";
import { nugetPurl, pypiBomRef } from "../inventory/purl.js";
import { classifyProbeResult } from "../inventory/toolRequirements.js";
import { getPluginToolComponents } from "../managers/binary.js";
import { getTreeWithPlugin } from "../managers/piptree.js";
import {
  buildBomNSData,
  createBinaryBom,
  createDefaultParentComponent,
  emitAiInventorySummary,
  getIncludedAiInventoryTypes,
  shouldIncludeNodeModulesDir,
} from "./bomAssembly.js";

const isWin = _platform() === "win32";

/**
 * Checks whether a directory contains .NET project or solution files
 * (`*.csproj`, `*.fsproj`, `*.vbproj`, `*.sln`).
 *
 * @param {string} src Directory to inspect
 * @param {object} [options={}] CLI options
 * @returns {boolean} True when at least one .NET project/solution file exists
 */
export const hasDotnetProjectIndicators = (src, options = {}) => {
  return Boolean(
    getAllFiles(src, "**/*.{csproj,fsproj,vbproj,sln}", options)?.length,
  );
};

/**
 * Decides whether dosai crypto collection should run for a .NET source. Returns
 * true when an explicit dosai .NET project type is selected, or when no project
 * type (or `universal`) is selected and .NET project indicators are present.
 *
 * @param {string} src Directory to inspect
 * @param {object} [options={}] CLI options
 * @returns {boolean} True when dosai crypto collection should run
 */
export const shouldCollectDosaiCrypto = (src, options = {}) => {
  const projectTypes = Array.isArray(options.projectType)
    ? options.projectType
    : options.projectType
      ? [options.projectType]
      : [];
  if (projectTypes.some((projectType) => isDosaiDotnetLanguage(projectType))) {
    return true;
  }
  if (!projectTypes.length || projectTypes.includes("universal")) {
    return hasDotnetProjectIndicators(src, options);
  }
  return false;
};

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
 * @returns {Object | null} BOM object, or `null` when `pixi.lock` is absent and `options.installDeps` is false
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
    const ppurl = build({
      type: "pypi",
      namespace: parentComponent.group || "" || null,
      name: parentComponent.name,
      version: parentComponent.version || "latest" || null,
    });
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
 * @returns {Promise<Object>} Promise resolving to BOM object
 */
export async function createPythonBom(path, options) {
  let allImports = {};
  let metadataFilename = "";
  let dependencies = [];
  let pkgList = [];
  let formulationList = [];
  let embeddedSbomCitations = [];
  const includedAiInventoryTypes = getIncludedAiInventoryTypes(options);
  let aiInventory = { components: [], dependencies: [], services: [] };
  let mcpInventory = { components: [], dependencies: [], services: [] };
  const tempDir = safeMkdtempSync(join(getTmpDir(), "cdxgen-venv-"));
  let parentComponent = createDefaultParentComponent(path, "pypi", options);
  // We are checking only the root here for pipenv
  const pipenvMode = safeExistsSync(join(path, "Pipfile"));

  // If pixi is used then just return that as output instead
  const pixiLockFile = join(path, "pixi.lock");
  const pixiFilesMode = safeExistsSync(pixiLockFile);
  const pixiToml = join(path, "pixi.toml");
  const pixiTomlMode = safeExistsSync(pixiToml);
  // Mojo projects are pixi-managed and carry a `mojoproject.toml` manifest.
  // Its Mojo-specific dependencies use the unregistered `mojo` type, so they
  // are emitted as generic with a proposedType marker; conda/PyPI deps pulled
  // through pixi.lock keep their correct types via the pixi path.
  const mojoProjectFile = join(path, "mojoproject.toml");
  const mojoMode = safeExistsSync(mojoProjectFile);
  let mojoPackages = [];
  let mojoParent = {};
  if (mojoMode) {
    const mojoResult = parseMojoProject(mojoProjectFile);
    mojoPackages = mojoResult.pkgList || [];
    if (mojoResult.parentComponent?.name) {
      mojoParent = mojoResult.parentComponent;
    }
  }
  if (pixiTomlMode || pixiFilesMode) {
    const BomNSData = createPixiBom(path, options);
    if (BomNSData) {
      // Merge Mojo's own packages into the pixi-derived component list.
      if (mojoPackages.length) {
        const existing = BomNSData.bomJson?.components || [];
        BomNSData.bomJson.components = existing.concat(mojoPackages);
      }
      return BomNSData;
    }
  } else if (mojoMode) {
    // A mojoproject.toml without pixi.lock: emit the Mojo manifest packages.
    if (mojoParent.name) {
      parentComponent = mojoParent;
    }
    pkgList = pkgList.concat(mojoPackages);
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
  const pyLockFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}pylock*.toml`,
    options,
  )?.filter((f) => isPyLockFile(f));
  if (pyLockFiles?.length) {
    poetryFiles = poetryFiles.concat(pyLockFiles);
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
    { ...options, includeDot: true },
  );
  const whlFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}*.whl`,
    { ...options, includeDot: true },
  );
  const eggInfoFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}*.egg-info`,
    { ...options, includeDot: true },
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
        name: "internal:SrcFile",
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
    (reqFiles?.length || reqDirFiles?.length) &&
    !uvLockFiles.length &&
    !pyLockFiles?.length;
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
      if (retMap?.workspaceWarningShown) {
        deferFailOnError(options, {
          ecosystem: "python",
          tool: "python",
          detail: "the python lock file could not be parsed",
        });
      }
      if (retMap?.pyLockProperties?.length) {
        parentComponent.properties = parentComponent.properties || [];
        parentComponent.properties = parentComponent.properties.concat(
          retMap.pyLockProperties,
        );
      }
      if (retMap.pkgList?.length) {
        pkgList = pkgList.concat(retMap.pkgList);
        pkgList = trimComponents(pkgList);
      }
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
      if (
        (options.deep || !dependencies.length) &&
        !f.endsWith("uv.lock") &&
        !isPyLockFile(f)
      ) {
        if (options.installDeps) {
          retMap = await getPipFrozenTree(
            basePath,
            f,
            tempDir,
            parentComponent,
            path,
            getTreeWithPlugin,
          );
          if (retMap.pkgList?.length) pkgList = pkgList.concat(retMap.pkgList);
          if (retMap.formulationList?.length)
            formulationList = formulationList.concat(retMap.formulationList);
          if (retMap.dependenciesList)
            dependencies = mergeDependencies(
              dependencies,
              retMap.dependenciesList,
              parentComponent,
            );
        } else {
          let exportedReqs = "";
          if (f.endsWith("poetry.lock")) {
            thoughtLog(
              "Using poetry export as a safe, static alternative to pip install.",
            );
            const expCmd = safeSpawnSync(
              "poetry",
              ["export", "-f", "requirements.txt"],
              { cwd: basePath, shell: false },
            );
            if (expCmd.status === 0 && expCmd.stdout)
              exportedReqs = expCmd.stdout.toString();
          } else if (f.endsWith("pdm.lock")) {
            thoughtLog(
              "Using pdm export as a safe, static alternative to pip install.",
            );
            const expCmd = safeSpawnSync(
              "pdm",
              ["export", "-f", "requirements"],
              { cwd: basePath, shell: false },
            );
            if (expCmd.status === 0 && expCmd.stdout)
              exportedReqs = expCmd.stdout.toString();
          }
          if (exportedReqs) {
            // The export contains the resolved closure, not just the first
            // level, so it contributes components only. The root edge comes
            // from parsePyLockData (seeded from the manifest); for locks
            // without a neighbouring pyproject.toml the generic postgen
            // parent-edge repair keeps the tree reachable.
            const tmpReqFile = join(
              tempDir,
              `exported-${basename(basePath)}-reqs.txt`,
            );
            safeWriteSync(tmpReqFile, exportedReqs);
            const dlist = await parseReqFile(tmpReqFile, false);
            if (dlist?.length) {
              pkgList = pkgList.concat(dlist);
            }
          }
        }
      }
    }
    options.parentComponent = parentComponent;
  } // poetryMode
  if (metadataFiles?.length) {
    // dist-info directories
    for (const mf of metadataFiles) {
      const dlist = parseBdistMetadata(mf);
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
        const dlist = parseBdistMetadata(join(wf, "METADATA"), mData);
        if (dlist?.length) {
          pkgList = pkgList.concat(dlist);
        }
      }
    }
  }
  // .egg-info files
  if (eggInfoFiles?.length) {
    for (const ef of eggInfoFiles) {
      const dlist = parseBdistMetadata(ef);
      if (dlist?.length) {
        pkgList = pkgList.concat(dlist);
      }
    }
  }
  // PEP 770: discover SBOMs embedded under `<dist>.dist-info/sboms/` in
  // installed distributions and wheels. An embedded SBOM is stronger than
  // cdxgen's inference, so its components are merged as dependencies *of* the
  // distribution that supplied them. The data is untrusted third-party input,
  // so the collector bounds its size, validates it, and skips anything invalid.
  const embedded = await collectEmbeddedSboms({
    metadataFiles,
    whlFiles,
  });
  if (embedded.components.length) {
    // Embedded components come first so the later trimComponents dedupe keeps
    // them when they conflict with an inferred component: an embedded SBOM is a
    // stronger assertion than cdxgen's inference, and the union records the
    // conflict rather than discarding it.
    pkgList = embedded.components.concat(pkgList);
  }
  if (embedded.dependencies.length) {
    dependencies = mergeDependencies(
      dependencies,
      embedded.dependencies,
      parentComponent,
    );
  }
  if (embedded.citations.length) {
    embeddedSbomCitations = embedded.citations;
  }
  if (requirementsMode || pipenvMode) {
    if (pipenvMode) {
      // `pipenv install` builds and installs the project's own dependencies
      // (including `-e .` self-references that execute setup.py), so unlike
      // the lockfile parsing below it must honor --no-install-deps and the
      // pre-build lifecycle.
      if (options.installDeps !== false) {
        safeSpawnSync("pipenv", ["install"], { cwd: path, shell: isWin });
      } else {
        console.log(
          "Skipping 'pipenv install' since dependency installation is disabled.",
        );
      }
      const piplockFile = join(path, "Pipfile.lock");
      if (safeExistsSync(piplockFile)) {
        let dlist;
        try {
          const lockData = JSON.parse(readFileSync(piplockFile));
          dlist = await parsePiplockData(lockData);
        } catch (err) {
          recordDegradation("python.lockfile-unparseable.pipenv", {
            ecosystem: "python",
            impact: "transitive-deps",
            path: piplockFile,
            detail:
              "The Pipfile.lock could not be parsed, so no locked versions were captured from it.",
          });
          console.log(`Error while parsing the lock file ${piplockFile}.`, err);
        }
        if (dlist?.length) {
          pkgList = pkgList.concat(dlist);
        }
      } else {
        console.error("Pipfile.lock not found at", path);
        deferFailOnError(options, {
          ecosystem: "python",
          tool: "pipenv",
          detail: "Pipfile.lock was not found",
        });
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
        const dlist = await parseReqFile(f, false);
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
          path,
          getTreeWithPlugin,
        );
      } else if (setupPyMode) {
        pkgMap = await getPipFrozenTree(
          path,
          setupPy,
          tempDir,
          parentComponent,
          path,
          getTreeWithPlugin,
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
            const rpkgMap = await getPipFrozenTree(
              basePath,
              f,
              tempDir,
              parentComponent,
              path,
              getTreeWithPlugin,
            );
            if (rpkgMap.pkgList?.length) {
              pkgList = pkgList.concat(rpkgMap.pkgList);
              pkgList = trimComponents(pkgList);
            }
            if (rpkgMap.formulationList?.length) {
              formulationList = formulationList.concat(rpkgMap.formulationList);
              formulationList = trimComponents(formulationList);
            }
            if (rpkgMap.dependenciesList) {
              dependencies = mergeDependencies(
                dependencies,
                rpkgMap.dependenciesList,
                parentComponent,
              );
            }
            // Add the root packages from this file to the parent's dependencies
            for (const p of rpkgMap.rootList) {
              if (
                parentComponent &&
                p.name === parentComponent.name &&
                (p.version === parentComponent.version ||
                  p.version === "latest")
              ) {
                continue;
              }
              parentDependsOn.add(pypiBomRef(p.name, p.version));
            }
          }
        }
      } else if (!poetryMode) {
        pkgMap = await getPipFrozenTree(
          path,
          undefined,
          tempDir,
          parentComponent,
          path,
          getTreeWithPlugin,
        );
      }
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
          parentDependsOn.add(pypiBomRef(p.name, p.version));
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
    }
    // ATOM parsedeps block
    // Atom parsedeps slices can be used to identify packages that are not declared in manifests
    // Since it is a slow operation, we only use it as a fallback or in deep mode
    // This change was made in 10.9.2 release onwards. It reads the sources and
    // installs nothing, so it runs whether or not dependencies are installed.
    if (options.deep || !pkgList.length) {
      if (!pkgList.length) {
        thoughtLog(
          "I couldn't find any components yet. Let's try static analysis with atom parsedeps command.",
        );
      }
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
              name: "internal:ImportedModules",
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
              (p.version === parentComponent.version || p.version === "latest"))
          ) {
            continue;
          }
          parentDependsOn.add(pypiBomRef(p.name, p.version));
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
    let parentPresent = false;
    for (const d of dependencies) {
      if (d.ref === parentComponent["bom-ref"]) {
        parentPresent = true;
        break;
      }
    }
    // Without an install, the parent's dependencies are known only when the
    // import scan found some: an empty list would claim it has none.
    if (!parentPresent && (options.installDeps || parentDependsOn.size)) {
      const pdependencies = {
        ref: parentComponent["bom-ref"],
        dependsOn: Array.from(parentDependsOn).filter(
          (r) => parentComponent && r !== parentComponent["bom-ref"],
        ),
      };
      dependencies.splice(0, 0, pdependencies);
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
  if (includedAiInventoryTypes.length) {
    aiInventory = collectAiInventory(path, options, includedAiInventoryTypes);
    if (includedAiInventoryTypes.includes("mcp")) {
      mcpInventory = detectPythonMcpInventory(path, options.deep);
    }
  }
  const aiInventorySummary = summarizeAiInventory(aiInventory);
  if (aiInventorySummary.instructionCount || aiInventorySummary.skillCount) {
    thoughtLog(
      `I found ${aiInventorySummary.instructionCount + aiInventorySummary.skillCount} AI skill/instruction file component(s). Use '--exclude-type ai-skill' for a package-only BOM, or '--bom-audit --bom-audit-categories ai-inventory' for review-friendly reporting.`,
    );
  }
  if (aiInventorySummary.mcpConfigCount) {
    thoughtLog(
      `I found ${aiInventorySummary.mcpConfigCount} MCP config component(s). Use '--exclude-type mcp' to drop them, or '--bom-audit --bom-audit-categories ai-inventory --tlp-classification AMBER' to keep and flag them.`,
    );
  }
  emitAiInventorySummary(aiInventory, path);
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
      getTreeWithPlugin,
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
  if (tempDir?.startsWith(getTmpDir())) {
    safeRmSync(tempDir, { recursive: true, force: true });
  }
  // Re-compute the component scope
  pkgList = recomputeScope(pkgList, dependencies);
  if (shouldFetchLicense()) {
    pkgList = await getPyMetadata(pkgList, false);
  }
  if (mcpInventory.components?.length) {
    pkgList = trimComponents(pkgList.concat(mcpInventory.components));
  }
  if (mcpInventory.dependencies?.length) {
    dependencies = mergeDependencies(
      dependencies,
      mcpInventory.dependencies,
      parentComponent,
    );
  }
  if (aiInventory.components?.length) {
    pkgList = trimComponents(pkgList.concat(aiInventory.components));
  }
  if (aiInventory.dependencies?.length) {
    dependencies = mergeDependencies(
      dependencies,
      aiInventory.dependencies,
      parentComponent,
    );
  }
  const inventoryServices = mergeServices(
    mergeServices([], mcpInventory.services || []),
    aiInventory.services || [],
  );
  return buildBomNSData(options, pkgList, "pypi", {
    allImports,
    src: path,
    filename: metadataFilename,
    dependencies,
    parentComponent,
    formulationList,
    citations: embeddedSbomCitations,
    services: inventoryServices,
  });
}

/**
 * Function to create bom string for GitHub action workflows
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Object} BOM object
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
 * @returns {Object} BOM object
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
 * Function to create bom string for Jenkins plugins
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} Promise resolving to BOM object
 */
export async function createJenkinsBom(path, options) {
  let pkgList = [];
  const hpiFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}*.hpi`,
    options,
  );
  const tempDir = safeMkdtempSync(join(getTmpDir(), "hpi-deps-"));
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
  if (tempDir?.startsWith(getTmpDir())) {
    console.log(`Cleaning up ${tempDir}`);
    safeRmSync(tempDir, { recursive: true, force: true });
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
 * @returns {Object} BOM object
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
 * Function to create bom string for php projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Object} BOM object
 */
export function createPHPBom(path, options) {
  let dependencies = [];
  let parentComponent = {};
  const searchOptions = {
    ...options,
    includeNodeModulesDir:
      typeof options.includeNodeModulesDir === "undefined"
        ? shouldIncludeNodeModulesDir(options, ["php"])
        : options.includeNodeModulesDir,
  };
  const composerLockSearchOptions = {
    ...searchOptions,
    exclude: [...(options.exclude || []), "**/vendor/**"],
  };
  const composerJsonFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}composer.json`,
    searchOptions,
  );
  let composerLockFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}composer.lock`,
    composerLockSearchOptions,
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
      // A composer the runtime or a policy denied is not an unavailable
      // composer; the version probes report that as degraded evidence.
      if (classifyProbeResult(versionResult) === "missing") {
        recordDegradation("php.composer.missing", {
          ecosystem: "php",
          tool: "composer",
          impact: "components",
          command: "composer --version",
          exitCode:
            typeof versionResult.status === "number"
              ? versionResult.status
              : undefined,
          detail:
            "The composer executable could not be run, so the composer.lock generation could not be attempted.",
        });
      }
      console.error(
        "No composer version found. Check if composer is installed and available in PATH.",
      );
      if (DEBUG_MODE) {
        console.log(versionResult.error, versionResult.stderr);
      }
      deferFailOnError(options, {
        ecosystem: "php",
        tool: "composer",
        detail: "the composer version command failed",
      });
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
        deferFailOnError(options, {
          ecosystem: "php",
          tool: "composer",
          detail: "the composer install command failed",
        });
      }
    }
  }
  composerLockFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}composer.lock`,
    composerLockSearchOptions,
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
        } else if (moduleParent?.["bom-ref"]) {
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
              ...new Set(
                retMap.rootList.map((p) => p["bom-ref"]).filter(Boolean),
              ),
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
      const parentDependsOn = parentComponent.components
        .map((d) => d["bom-ref"])
        .filter(Boolean);
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
  if (composerJsonMode && !composerLockMode) {
    recordDegradation("php.no-lockfile", {
      ecosystem: "php",
      tool: "composer",
      impact: "components",
      detail:
        "No composer.lock was found or generated, and the lock file is the source the Composer parser reads.",
    });
  }
  return {};
}

/**
 * Function to create bom string for ruby projects
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} Promise resolving to BOM object
 */
export async function createRubyBom(path, options) {
  // We can look for gem files within node_modules directory
  if (typeof options.includeNodeModulesDir === "undefined" || options.deep) {
    options.includeNodeModulesDir = true;
  }
  const excludeList = (options.exclude || []).concat(["**/vendor/cache/**"]);
  const gemLockExcludeList = (options.exclude || []).concat([
    "**/vendor/bundle/ruby/**/Gemfile.lock",
    "**/test/data/**/Gemfile*.lock",
    "**/.rbenv/versions/**/Gemfile.lock",
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
  let gemHome =
    readEnvironmentVariable("CDXGEN_GEM_HOME") ||
    readEnvironmentVariable("GEM_HOME");
  if (
    !gemHome &&
    (readEnvironmentVariable("BUNDLE_PATH") ||
      readEnvironmentVariable("GEM_PATH"))
  ) {
    gemHome =
      readEnvironmentVariable("BUNDLE_PATH") ||
      readEnvironmentVariable("GEM_PATH");
  }
  // Bundler records the install path and the excluded groups in .bundle/config,
  // so honour it to locate the gems and to warn about an incomplete BOM.
  const bundleConfig = parseBundleConfig(join(path, ".bundle", "config"));
  if (!gemHome && bundleConfig.BUNDLE_PATH) {
    gemHome = isAbsolute(bundleConfig.BUNDLE_PATH)
      ? bundleConfig.BUNDLE_PATH
      : join(path, bundleConfig.BUNDLE_PATH);
    if (DEBUG_MODE) {
      console.log(`Using the BUNDLE_PATH from .bundle/config: ${gemHome}`);
    }
  }
  const bundleWithout =
    bundleConfig.BUNDLE_WITHOUT || readEnvironmentVariable("BUNDLE_WITHOUT");
  if (bundleWithout?.length) {
    console.log(
      `NOTE: The bundle groups '${bundleWithout.replaceAll(":", ", ")}' were excluded by bundler, so these gems might be missing from the BOM.`,
    );
  }
  let isGemHomeEmpty = true;
  // In deep mode, let's collect all gems that got installed in our custom GEM_HOME directory.
  // This would improve the accuracy of any security analysis downstream at cost of a slight increase in time.
  if (options.deep && readEnvironmentVariable("CDXGEN_GEM_HOME")) {
    const gemHomeSpecFiles = getAllFiles(
      readEnvironmentVariable("CDXGEN_GEM_HOME") ||
        readEnvironmentVariable("BUNDLE_PATH"),
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
  const projectGemRefs = [];
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
        deferFailOnError(options, {
          ecosystem: "ruby",
          tool: "bundler",
          detail: "the bundler command failed",
        });
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
      // `PATH remote: .` is relative to the lockfile, so only the lockfiles
      // of the scanned directory can serve the gem the root gemspec builds
      if (
        retMap.projectGemRefs?.length &&
        dirname(resolve(f)) === resolve(path)
      ) {
        projectGemRefs.push(...retMap.projectGemRefs);
      }
    }
  }
  // Parsing .gemspec files would help us get more metadata such as description, authors, licenses etc
  let projectGem;
  if (gemspecFiles.length) {
    if (!gemLockFiles.length && !hasAnyProjectType(["oci"], options, false)) {
      console.log(
        "SBOM generation using only gemspec files is imprecise and results in an inaccurate dependency tree.",
      );
      deferFailOnError(options, {
        ecosystem: "ruby",
        tool: "bundler",
        detail: "only gemspec files were available to parse",
      });
    }
    // Bundler evaluated the root gemspec to lock it under `PATH remote: .`,
    // so the locked release stands in for a version computed at runtime. It
    // is resolved before the merge, so that the gemspec and lockfile
    // sightings of the gem reconcile into one component.
    const lockedVersions = Object.create(null);
    for (const p of pkgList) {
      if (p.version && projectGemRefs.includes(p["bom-ref"])) {
        lockedVersions[p.name] = p.version;
      }
    }
    for (const f of gemspecFiles) {
      const gemspecData = readFileSync(f, { encoding: "utf-8" });
      const isRootGemspec = dirname(resolve(f)) === resolve(path);
      const gpkgList = await parseGemspecData(
        gemspecData,
        f,
        isRootGemspec ? { lockedVersions, projectGemspec: true } : {},
      );
      if (!gpkgList.length) {
        continue;
      }
      // The gemspec in the scanned directory is the gem the project builds
      if (!projectGem && isRootGemspec && gpkgList[0]?.name) {
        projectGem = gpkgList[0];
      }
      pkgList = trimComponents(pkgList.concat(gpkgList));
    }
  }
  // Describe that gem in metadata.component, unless `--project-name` names a
  // different project or an image is being scanned
  if (
    projectGem &&
    !hasAnyProjectType(["oci"], options, false) &&
    (!("project-name" in options) || options.projectName === projectGem.name)
  ) {
    ({ pkgList, dependencies, rootList } = describeProjectGem(
      parentComponent,
      projectGem,
      pkgList,
      dependencies,
      rootList,
      projectGemRefs,
      options,
    ));
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
        readEnvironmentVariable("CDXGEN_RUBY_CMD") ||
        readEnvironmentVariable("RUBY_CMD") ||
        "ruby";
      const bundleCommand =
        readEnvironmentVariable("CDXGEN_BUNDLE_CMD") || "bundle";
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
            name: "internal:Namespaces",
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
              "Tried everything to get the `--deep` mode working? Please create an issue with a sample repo to reproduce this problem. https://github.com/cdxgen/cdxgen/issues",
            );
          }
          break;
        }
      }
      if (DEBUG_MODE && atleastOneHit) {
        console.log(
          "Successfully obtained the module names for some component gems. You can find them under a property named `internal:Namespaces`.",
        );
      }
      // Clean up
      if (readEnvironmentVariable("CDXGEN_GEM_HOME")?.startsWith(getTmpDir())) {
        safeRmSync(readEnvironmentVariable("CDXGEN_GEM_HOME"), {
          recursive: true,
          force: true,
        });
      }
    } else {
      if (readEnvironmentVariable("CDXGEN_GEM_HOME")) {
        console.log(
          `${readEnvironmentVariable("CDXGEN_GEM_HOME")} was empty. Ensure "bundle install" command was successful prior to invoking cdxgen.`,
        );
      } else {
        console.log(
          "Set the environment variable CDXGEN_GEM_HOME or GEM_HOME to collect the module names for installed gems.",
        );
      }
    }
  }
  // Enrich from the caches on this machine. This is free compared to a registry
  // lookup, gives us the sha256 of the exact native build, and unlike the
  // registry lookups it also works in dry-run mode.
  pkgList = await enrichGemsFromLocalCache(pkgList, { gemHome });
  // The download URL of a gem from the public registry needs no network call
  pkgList = addRubyGemsDistributionUrls(pkgList);
  // Gems declare the Ruby they run on; surface it as the runtime they depend
  // on. The component says the runtime is external, which only CycloneDX 1.7
  // can express, and a container image ships its own Ruby.
  if (
    options.specVersion >= 1.7 &&
    !hasAnyProjectType(["oci"], options, false)
  ) {
    ({ pkgList, dependencies } = addRubyRuntimeComponent(
      pkgList,
      parentComponent,
      dependencies,
    ));
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
 * @returns {Promise<Object|undefined>} Promise resolving to BOM object
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
  const propsFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}*.props`,
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
          if (readEnvironmentVariable("CDXGEN_IN_CONTAINER") !== "true") {
            console.log(
              "Ensure the restore step is performed prior to invoking cdxgen.",
            );
          } else {
            console.log(
              "TIP: msbuild is not available for Linux. Try using a Windows build agent to generate an SBOM for this project.",
            );
          }
          deferFailOnError(options, {
            ecosystem: "csharp",
            tool: "dotnet",
            detail: "the dotnet command failed",
          });
        }
        if (result?.stderr?.includes("To install missing framework")) {
          console.log(
            "This project requires a specific version of dotnet sdk to be installed. The cdxgen container image bundles dotnet SDK 8.0, which might be incompatible.",
          );
          console.log(
            "TIP: Try using the custom `ghcr.io/cdxgen/cdxgen-debian-dotnet8:v13` or `ghcr.io/cdxgen/cdxgen-debian-dotnet9:v13` container images.",
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
          if (readEnvironmentVariable("CDXGEN_IN_CONTAINER") !== "true") {
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
          if (readEnvironmentVariable("CDXGEN_IN_CONTAINER") !== "true") {
            console.log(
              "Alternatively, try using the custom `ghcr.io/cdxgen/cdxgen-debian-dotnet8:v13` container image, which bundles nuget (mono) and a range of dotnet SDKs.",
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
        deferFailOnError(options, {
          ecosystem: "csharp",
          tool: "dotnet",
          detail: "the dotnet restore did not produce a usable assets file",
        });
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
    // A nuspec states the range each dependency accepts, not the version
    // installed. The installed packages are the components, and a dependency
    // edge points at the installed version its range resolves to; a minimum
    // version nobody installed is not a component.
    const installedVersions = {};
    const installedNames = {};
    let dependencyRanges = {};
    for (const nf of nupkgFiles) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${nf}`);
      }
      const retMap = await parseNupkg(nf);
      const installed = retMap?.pkgList?.[0];
      if (installed) {
        pkgList.push(installed);
        parentDependsOn.add(installed["bom-ref"]);
        const key = installed.name.toLowerCase();
        installedNames[key] ??= installed.name;
        installedVersions[key] ??= [];
        if (installed.version) {
          installedVersions[key].push(installed.version);
        }
      }
      if (retMap?.dependencyRanges) {
        dependencyRanges = { ...dependencyRanges, ...retMap.dependencyRanges };
      }
    } // end for
    for (const [ref, ranges] of Object.entries(dependencyRanges)) {
      const dependsOn = new Set();
      for (const [name, range] of Object.entries(ranges)) {
        const key = name.toLowerCase();
        const version = resolveInstalledNugetVersion(
          range,
          installedVersions[key],
        );
        const purl = version ? nugetPurl(installedNames[key], version) : null;
        if (purl) {
          dependsOn.add(decodeURIComponent(purl));
        }
      }
      dependencies.push({ ref, dependsOn: [...dependsOn].sort() });
    }
  }
  // Versions each project restored, by project directory and lowercased
  // package id. Two projects of one tree routinely restore different versions
  // of a package, so a version missing from one project's manifest is taken
  // from that project's restore output, never from another project's.
  // The restore output also spells each package id the way its nuspec does.
  const projectVersions = {};
  const projectNames = {};
  const recordProjectVersions = (projectDir, pkgs) => {
    projectVersions[projectDir] ??= {};
    projectNames[projectDir] ??= {};
    for (const p of pkgs || []) {
      if (
        p?.name &&
        p.version &&
        !["application", "project"].includes(p.type)
      ) {
        projectVersions[projectDir][p.name.toLowerCase()] ??= p.version;
        projectNames[projectDir][p.name.toLowerCase()] ??= p.name;
      }
    }
  };
  // Direct dependencies of each project directory from its lock file or
  // packages.config, attached to that project once the project files are read.
  const rootsByProjectDir = {};
  const recordRoots = (projectDir, pkgs) => {
    rootsByProjectDir[projectDir] ??= new Set();
    for (const p of pkgs || []) {
      if (p?.["bom-ref"]) {
        rootsByProjectDir[projectDir].add(p["bom-ref"]);
      }
    }
  };
  // In a multi-project scan, different projects may use different manifest
  // formats: modern SDK-style (project.assets.json / packages.lock.json) or
  // legacy (packages.config). Apply the assets > lock > config precedence per
  // project directory instead of across the whole scan, so dependencies from
  // one project's manifest are not dropped just because another format exists
  // elsewhere in the scan.
  const assetsProjectDirs = new Set();
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
      // Restore output names its project; an artifacts layout keeps it outside
      // the project directory.
      const projectDir = dotnetManifestProjectDir(af, results.projectPath);
      assetsProjectDirs.add(projectDir);
      recordProjectVersions(projectDir, dlist);
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
        "Alternatively, try using the custom `ghcr.io/cdxgen/cdxgen-dotnet:v13` container image, which bundles a range of dotnet SDKs.",
      );
      deferFailOnError(options, {
        ecosystem: "csharp",
        tool: "dotnet",
        detail: "no dotnet dependency evidence could be collected",
      });
    }
  }
  const lockProjectDirs = new Set(
    pkgLockFiles.map((af) => dotnetManifestProjectDir(af)),
  );
  // packages.lock.json parsing for any project without a project.assets.json
  const pkgLockToParse = pkgLockFiles.filter(
    (af) => !assetsProjectDirs.has(dotnetManifestProjectDir(af)),
  );
  if (pkgLockToParse.length) {
    manifestFiles = manifestFiles.concat(pkgLockToParse);
    // packages.lock.json from nuget
    for (const af of pkgLockToParse) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${af}`);
      }
      pkgData = readFileSync(af, { encoding: "utf-8" });
      const results = parseCsPkgLockData(pkgData, af);
      const deps = results["dependenciesList"];
      const dlist = results["pkgList"];
      const rootList = results["rootList"];
      const projectDir = dotnetManifestProjectDir(af);
      recordProjectVersions(projectDir, dlist);
      if (dlist?.length) {
        pkgList = pkgList.concat(dlist);
      }
      if (deps?.length) {
        dependencies = mergeDependencies(dependencies, deps, parentComponent);
      }
      recordRoots(projectDir, rootList);
    }
  }
  // packages.config parsing for any project without a modern manifest
  // (project.assets.json / packages.lock.json) covering the same directory
  const pkgConfigToParse = pkgConfigFiles.filter((f) => {
    const projDir = dotnetManifestProjectDir(f);
    return !assetsProjectDirs.has(projDir) && !lockProjectDirs.has(projDir);
  });
  if (pkgConfigToParse.length) {
    manifestFiles = manifestFiles.concat(pkgConfigToParse);
    // A templated or missing version is backfilled only from a version every
    // other manifest of the scan agrees on: these projects restored nothing of
    // their own, and another project's version may not be theirs.
    const resolvedVersions = agreedNugetVersions(pkgList);
    // packages.config parsing
    for (const f of pkgConfigToParse) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      pkgData = readFileSync(f, { encoding: "utf-8" });
      const dlist = parseCsPkgData(pkgData, f, resolvedVersions);
      const projectDir = dotnetManifestProjectDir(f);
      recordProjectVersions(projectDir, dlist);
      if (dlist?.length) {
        pkgList = pkgList.concat(dlist);
        recordRoots(projectDir, dlist);
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
  const projectRefByDir = {};
  let services = [];
  if (csProjFiles.length) {
    manifestFiles = manifestFiles.concat(csProjFiles);
    // Parsing csproj is quite error-prone. Some project files may not have
    // versions specified. Such a version comes from what this project restored,
    // then from central package management, and only then from a version the
    // whole scan agrees on.
    const agreedVersions = agreedNugetVersions(pkgList);
    let msbuildInstalled = false;
    const result = safeSpawnSync(DOTNET_CMD, ["msbuild", "--version"], {
      shell: isWin,
    });
    if (result.status === 0 && !result.error && result.stdout?.trim()) {
      msbuildInstalled = true;
    }
    // `$(Name)` version labels resolve from the props files that can apply to
    // each project (beside and above it), read once for the whole scan.
    // msbuild evaluates only what they leave unresolved.
    const propsIndex = indexPropsProperties(propsFiles);
    // Directory.Packages.props can sit above the directory being scanned, so it is
    // resolved per project file by walking up rather than from the props glob below.
    // The cache keeps a repository with many projects from re-parsing the same file.
    const centralVersionsCache = {};
    // .csproj parsing
    for (const f of csProjFiles) {
      if (DEBUG_MODE) {
        console.log(`Parsing ${f}`);
      }
      const csProjData = readFileSync(f, { encoding: "utf-8" });
      const projectDir = dotnetManifestProjectDir(f);
      const retMap = parseCsProjData(
        csProjData,
        f,
        projectVersions[projectDir] || {},
        msbuildInstalled,
        projectPropertyCandidates(f, propsIndex),
        getCentralPackageVersions(f, centralVersionsCache),
        agreedVersions,
        projectNames[projectDir] || {},
      );
      if (retMap?.parentComponent?.purl) {
        projectRefByDir[projectDir] ??= retMap.parentComponent["bom-ref"];
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
  // A lock file's or packages.config's direct dependencies belong to the
  // project in that directory; without a project file there, to the parent.
  for (const [projectDir, roots] of Object.entries(rootsByProjectDir)) {
    if (!roots.size) {
      continue;
    }
    const projectRef = projectRefByDir[projectDir];
    if (projectRef && projectRef !== parentComponent?.["bom-ref"]) {
      dependencies = mergeDependencies(
        dependencies,
        [{ ref: projectRef, dependsOn: [...roots].sort() }],
        parentComponent,
      );
    } else {
      for (const ref of roots) {
        parentDependsOn.add(ref);
      }
    }
  }
  if (pkgList.length) {
    pkgList = trimComponents(pkgList);
    // Perform deep analysis using dosai
    if (options.deep) {
      // resolve (not join) so a fully-qualified --deps-slices-file is used
      // as-is: join would append it to the scan path, which is never a valid
      // path on Windows and silently loses the .NET evidence elsewhere
      // (issue 4394). A relative value still resolves against the scan path.
      // Without --deps-slices-file the slice goes to a directory of this run:
      // a fixed name in the shared temp directory was reused by every later
      // scan, of any project, as if it were that project's evidence.
      const slicesDir = options.depsSlicesFile
        ? undefined
        : safeMkdtempSync(join(getTmpDir(), "cdxgen-dosai-"));
      const slicesFile = options.depsSlicesFile
        ? resolve(path, options.depsSlicesFile)
        : join(slicesDir, "dosai.json");
      try {
        // Create the slices file if it doesn't exist
        if (!safeExistsSync(slicesFile)) {
          thoughtLog(
            "Alright, the next step is to invoke the dosai command to identify evidence of occurrences for various components.",
          );
          const sliceResult = createDosaiMethodsSlice(
            resolve(path),
            resolve(slicesFile),
            options,
          );
          // A stopped run has already said so and what to change; the debug
          // output would show no dosai error for it (issue 4438).
          if (!sliceResult && !dosaiRunWasStopped(resolve(slicesFile))) {
            // Visible without debug output: otherwise the components silently
            // lose the dependency-slice evidence while the scan still exits 0.
            // --evidence (which implies --deep) runs dosai again during evinse
            // and can still add occurrences, so this names only what is lost.
            // Debug output comes from the environment, not a CLI flag (issue
            // 4438).
            console.warn(
              "Slicing with dosai was unsuccessful, so the .NET components get no occurrence, reachability, or services evidence from the dependency slice. Re-run with CDXGEN_DEBUG_MODE=debug for the dosai errors.",
            );
          }
        } else if (DEBUG_MODE) {
          console.log(
            `Reusing the existing dosai methods slice "${slicesFile}" without checking whether it honours the current --exclude patterns. Delete the file to force a fresh run.`,
          );
        }
        pkgList = addEvidenceForDotnet(pkgList, slicesFile, {
          srcPath: resolve(path),
        });
        const methodsSlice = readDosaiMethodsReport(slicesFile, {
          sections: ["Metadata", "Services", "ApiEndpoints"],
        });
        // Provider-backed Services[] first so bom-refs, trust zones, and data
        // classifications survive; ApiEndpoints derivation fills in the rest.
        const servicesMap = collectDosaiServiceComponents(methodsSlice, {});
        collectDosaiServicesFromMethods(methodsSlice, servicesMap);
        services = normalizeDosaiServiceMap(servicesMap);
      } finally {
        if (slicesDir) {
          safeRmSync(slicesDir, { recursive: true, force: true });
        }
      }
    }
  }
  // Parent dependency tree. A single project file already contributed an
  // entry for the same parent, so the lock file roots are merged into it
  // rather than added as a second entry for the same ref.
  if (parentDependsOn.size && parentComponent?.["bom-ref"]) {
    dependencies = mergeDependencies(
      [
        {
          ref: parentComponent["bom-ref"],
          dependsOn: Array.from(parentDependsOn).sort(),
        },
      ],
      dependencies,
      parentComponent,
    );
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
    services,
    tools: options.deep ? getPluginToolComponents(["dosai"]) : [],
  });
}

/**
 * Function to create bom object for cryptographic certificate files
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} Promise resolving to BOM object
 */
export async function createCryptoCertsBom(path, options) {
  if (!isCycloneDxComponentTypeEnabled("cryptographic-asset", options)) {
    return {
      bomJson: {
        components: [],
      },
    };
  }
  const pkgList = [];
  const certFiles = getAllFiles(
    path,
    `${
      options.multiProject ? "**/" : ""
    }*.{p12,jks,jceks,bks,keystore,key,pem,cer,gpg,pub}`,
    options,
  );
  const certHashes = await mapWithConcurrency(certFiles, (f) =>
    checksumFile("sha256", f),
  );
  for (let ci = 0; ci < certFiles.length; ci++) {
    const f = certFiles[ci];
    const fileHash = certHashes[ci];
    const name = basename(f);
    let evidence;
    if (options.evidence) {
      const identityEvidence = {
        field: "name",
        confidence: 1,
        concludedValue: name,
        methods: [
          {
            technique: "filename",
            confidence: 1,
            value: f,
          },
        ],
      };
      evidence = {
        identity:
          options.specVersion >= 1.6 ? [identityEvidence] : identityEvidence,
        occurrences: [{ location: f }],
      };
    }
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
      ...(evidence ? { evidence } : {}),
      properties: [{ name: "internal:SrcFile", value: f }],
    };
    pkgList.push(apkg);
  }
  const sourceCryptoComponents = await collectSourceCryptoComponents(
    path,
    options,
  );
  if (sourceCryptoComponents.length) {
    pkgList.push(...sourceCryptoComponents);
  }
  if (shouldCollectDosaiCrypto(path, options)) {
    const dosaiCryptoComponents = await collectDosaiCryptoComponents(
      path,
      options,
    );
    if (dosaiCryptoComponents.length) {
      pkgList.push(...dosaiCryptoComponents);
    }
  }
  return {
    bomJson: {
      components: filterInvalidCryptoComponents(pkgList),
    },
  };
}

/**
 * Function to create bom string for R projects using renv.
 *
 * The `renv.lock` file carries the resolved package set for the project
 * library, including the R version it was produced under.
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Object} BOM object
 */
export function createRBom(path, options) {
  let pkgList = [];
  let dependencies = [];
  let rootInputs = [];
  let rVersion;
  const renvLockFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}renv.lock`,
    options,
  );
  for (const renvLockFile of renvLockFiles) {
    if (DEBUG_MODE) {
      console.log(`Parsing ${renvLockFile}`);
    }
    const result = parseRenvLock(renvLockFile);
    if (result.pkgList?.length) {
      pkgList = pkgList.concat(result.pkgList);
    }
    if (result.dependencies?.length) {
      dependencies = dependencies.concat(result.dependencies);
    }
    if (result.rootInputs?.length) {
      rootInputs = rootInputs.concat(result.rootInputs);
    }
    if (!rVersion) {
      rVersion = result.rVersion;
    }
  }
  if (!pkgList.length) {
    return {};
  }
  // renv locks the library, not the project: they carry no project name, so
  // the directory is the name the project is already known by. The R version
  // the library was resolved under is a property of that project.
  const projectName = basename(resolve(path));
  const parentComponent = {
    type: "application",
    name: projectName,
    "bom-ref": `application:${projectName}:latest`,
    description: `R project: ${projectName}`,
    properties: [
      { name: "internal:SrcFile", value: renvLockFiles.join(", ") },
      ...(rVersion ? [{ name: "cdx:renv:rVersion", value: rVersion }] : []),
    ],
  };
  if (rootInputs.length) {
    dependencies.push({
      ref: parentComponent["bom-ref"],
      dependsOn: [...new Set(rootInputs)].sort(),
    });
  }
  return buildBomNSData(options, pkgList, "cran", {
    src: path,
    filename: renvLockFiles.join(", "),
    dependencies,
    parentComponent,
  });
}

/**
 * Function to create bom string for Perl projects using Carton.
 *
 * The `cpanfile.snapshot` carries the resolved install set; the declared
 * `cpanfile` is consulted to distinguish direct dependencies.
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Object} BOM object
 */
export function createPerlBom(path, options) {
  let pkgList = [];
  let dependencies = [];
  const snapshotFiles = getAllFiles(
    path,
    `${options.multiProject ? "**/" : ""}cpanfile.snapshot`,
    options,
  );
  for (const snapshotFile of snapshotFiles) {
    if (DEBUG_MODE) {
      console.log(`Parsing ${snapshotFile}`);
    }
    const baseDir = dirname(snapshotFile);
    const cpanfile = join(baseDir, "cpanfile");
    const result = parseCpanSnapshot(
      snapshotFile,
      safeExistsSync(cpanfile) ? cpanfile : undefined,
    );
    if (result.pkgList?.length) {
      pkgList = pkgList.concat(result.pkgList);
    }
    if (result.dependencies?.length) {
      dependencies = dependencies.concat(result.dependencies);
    }
  }
  if (pkgList.length) {
    return buildBomNSData(options, pkgList, "cpan", {
      src: path,
      filename: snapshotFiles.join(", "),
      dependencies,
    });
  }
  return {};
}

/**
 * Function to create bom string for Terraform and OpenTofu projects.
 *
 * The workspace assembly turns the provider lock file, the module manifest
 * `init` writes and the configuration files into module and provider
 * components with a dependency graph and offline licenses. When metadata
 * fetching is enabled, the public registries add licenses, repository URLs
 * and registry flags to components the offline pass could not resolve.
 *
 * @param {string} path to the project
 * @param {Object} options Parse options from the cli
 * @returns {Promise<Object>} BOM object
 */
export async function createTerraformBom(path, options) {
  const parentComponent = createDefaultParentComponent(
    path,
    "generic",
    options,
  );
  const { pkgList, dependencies, parentProperties, srcFiles } =
    parseTerraformWorkspace(path, options, parentComponent["bom-ref"]);
  // No module or provider found (for example, resources only, or a stray
  // .tf in a JS repo): emit nothing, including no root applications, so
  // multi-type scans do not gain an empty Terraform parent.
  if (!pkgList.some((p) => p.type === "library")) {
    return {};
  }
  parentComponent.properties = [
    ...(parentComponent.properties || []),
    ...parentProperties,
  ];
  if (pkgList.length && shouldFetchPackageMetadata()) {
    await getTerraformRegistryMetadata(pkgList);
  }
  return buildBomNSData(options, pkgList, "terraform", {
    src: path,
    filename: srcFiles.join(", "),
    dependencies,
    parentComponent,
  });
}
