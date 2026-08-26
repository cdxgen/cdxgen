import fs from "node:fs";
import path, { basename, join, resolve } from "node:path";
import process from "node:process";

import { Purl } from "@cdxgen/cdx-purl";

import { DEBUG_MODE, readEnvironmentVariable } from "../core/activity.js";
import { PROJECT_TYPE_ALIASES } from "../core/env.js";
import {
  getAllFiles,
  getTimestamp,
  getTmpDir,
  safeExistsSync,
  safeMkdtempSync,
  safeRmSync,
  safeWriteSync,
} from "../core/fs.js";
import {
  analyzeGolemProject,
  collectGolemEvidence,
  isGolemGoLanguage,
} from "../ecosystems/golem.js";
import {
  collectGradleDependencies,
  getGradleCommand,
  getMavenCommand,
} from "../ecosystems/gradleutils.js";
import {
  analyzeRusiProject,
  collectRusiEvidence,
  isRusiRustLanguage,
} from "../ecosystems/rusi.js";
import {
  buildAtomCommandEnv,
  executeAtom,
  filterAtomSlicesByExcludePatterns,
} from "../inventory/atomUtils.js";
import {
  collectDosaiCryptoComponents,
  findCryptoAlgos,
} from "../inventory/cbomutils.js";
import { collectMvnDependencies } from "../inventory/deps.js";
import { mergeServices } from "../inventory/depsUtils.js";
import {
  collectDosaiDataFlowFrames,
  collectDosaiPurlEvidence,
  collectDosaiAiComponents,
  collectDosaiServiceComponents,
  collectDosaiServicesFromMethods,
  createDosaiDataFlowSlice,
  createDosaiMethodsSlice,
  isDosaiDotnetLanguage,
  persistDosaiSemanticsReport,
} from "../inventory/dosai.js";
import { parseOccurrenceEvidenceLocation } from "../inventory/evidenceUtils.js";
import { executeOsQuery } from "../managers/binary.js";
import { postProcess } from "../stages/postgen/postgen.js";
import { createOrLoad } from "./db.js";
import { findPurlLocations } from "./scalasem.js";
import { createSemanticsSlices } from "./swiftsem.js";

const typePurlsCache = {};

function appendUniqueProperty(properties, name, value) {
  if (value === undefined || value === null || value === "") {
    return;
  }
  const propertyValue = String(value);
  if (
    !properties.some(
      (property) => property.name === name && property.value === propertyValue,
    )
  ) {
    properties.push({ name, value: propertyValue });
  }
}

function appendComponentProperties(component, properties = []) {
  if (!component || !properties.length) {
    return;
  }
  component.properties ??= [];
  for (const property of properties) {
    appendUniqueProperty(component.properties, property.name, property.value);
  }
}

function filterAtomSliceData(sliceData, options = {}) {
  return filterAtomSlicesByExcludePatterns(sliceData, options.exclude);
}

/**
 * Function to create the db for the libraries referred in the sbom.
 *
 * @param {Object} options Command line options
 */
export async function prepareDB(options) {
  const dirPath = options._[0] || ".";
  const bomJsonFile = options.input;
  if (!safeExistsSync(bomJsonFile)) {
    console.log(
      "Bom file doesn't exist. Check if cdxgen was invoked with the correct type argument.",
    );
    if (!readEnvironmentVariable("CDXGEN_DEBUG_MODE")) {
      console.log(
        "Set the environment variable CDXGEN_DEBUG_MODE to debug to troubleshoot the issue further.",
      );
    }
    return;
  }
  const bomJson = JSON.parse(fs.readFileSync(bomJsonFile, "utf8"));
  if (bomJson.specVersion < 1.5) {
    console.log(
      "Evinse requires the input SBOM in CycloneDX 1.5 format or above. You can generate one by invoking cdxgen without any --spec-version argument.",
    );
    process.exit(0);
  }
  const components = bomJson.components || [];
  const { sequelize, Namespaces, Usages, DataFlows } = await createOrLoad();
  let hasMavenPkgs = false;
  // We need to slice only non-maven packages
  const purlsToSlice = {};
  const purlsJars = {};
  let usagesSlice;
  for (const comp of components) {
    if (!comp.purl) {
      continue;
    }
    usagesSlice = await Usages.findByPk(comp.purl);
    const namespaceSlice = await Namespaces.findByPk(comp.purl);
    if ((!usagesSlice && !namespaceSlice) || options.force) {
      if (comp.purl.startsWith("pkg:maven")) {
        hasMavenPkgs = true;
      }
    }
  }
  // If there are maven packages we collect and store the namespaces
  if (!options.skipMavenCollector && hasMavenPkgs) {
    const pomXmlFiles = getAllFiles(dirPath, "**/" + "pom.xml");
    const gradleFiles = getAllFiles(dirPath, "**/" + "build.gradle*");
    if (pomXmlFiles?.length) {
      await catalogMavenDeps(dirPath, purlsJars, Namespaces, options);
    }
    if (gradleFiles?.length) {
      await catalogGradleDeps(dirPath, purlsJars, Namespaces);
    }
  }
  for (const purl of Object.keys(purlsToSlice)) {
    await createAndStoreSlice(purl, purlsJars, Usages, options);
  }
  return { sequelize, Namespaces, Usages, DataFlows };
}

/**
 * Collect Maven jar namespace mappings for the purls found in the SBOM.
 *
 * If a previously generated `bom.json.map` is present in `dirPath` it is reused;
 * otherwise the maven command is invoked to collect the jar dependencies. Each
 * resolved purl is recorded in the `purlsJars` map and persisted in the
 * `Namespaces` model.
 *
 * @param {string} dirPath Project directory scanned by evinse
 * @param {Object<string, string>} purlsJars Map populated with purl -> jar file path
 * @param {Object} Namespaces Sequelize-like Namespaces model used to persist pom and namespaces
 * @param {object} options CLI options
 * @returns {Promise<void>}
 */
export async function catalogMavenDeps(
  dirPath,
  purlsJars,
  Namespaces,
  options = {},
) {
  let jarNSMapping;
  if (safeExistsSync(join(dirPath, "bom.json.map"))) {
    try {
      const mapData = JSON.parse(
        fs.readFileSync(join(dirPath, "bom.json.map"), "utf-8"),
      );
      if (mapData && Object.keys(mapData).length) {
        jarNSMapping = mapData;
      }
    } catch (_err) {
      // ignore
    }
  }
  if (!jarNSMapping) {
    console.log("About to collect jar dependencies for the path", dirPath);
    const mavenCmd = getMavenCommand(dirPath, dirPath);
    // collect all jars including from the cache if data-flow mode is enabled
    jarNSMapping = await collectMvnDependencies(
      mavenCmd,
      dirPath,
      false,
      options.withDeepJarCollector,
    );
  }
  if (jarNSMapping) {
    for (const purl of Object.keys(jarNSMapping)) {
      purlsJars[purl] = jarNSMapping[purl].jarFile;
      await Namespaces.findOrCreate({
        where: { purl },
        defaults: {
          purl,
          data: JSON.stringify(
            {
              pom: jarNSMapping[purl].pom,
              namespaces: jarNSMapping[purl].namespaces,
            },
            null,
            null,
          ),
        },
      });
    }
  }
}

/**
 * Collect Gradle cache jar namespace mappings for the purls found in the SBOM.
 *
 * Invokes the gradle command to collect all jars (including from the cache) and
 * records each resolved purl in the `purlsJars` map and the `Namespaces` model.
 *
 * @param {string} dirPath Project directory scanned by evinse
 * @param {Object<string, string>} purlsJars Map populated with purl -> jar file path
 * @param {Object} Namespaces Sequelize-like Namespaces model used to persist pom and namespaces
 * @returns {Promise<void>}
 */
export async function catalogGradleDeps(dirPath, purlsJars, Namespaces) {
  console.log(
    "About to collect jar dependencies from the gradle cache. This would take a while ...",
  );
  const gradleCmd = getGradleCommand(dirPath, dirPath);
  // collect all jars including from the cache if data-flow mode is enabled
  const jarNSMapping = await collectGradleDependencies(
    gradleCmd,
    dirPath,
    false,
    true,
  );
  if (jarNSMapping) {
    for (const purl of Object.keys(jarNSMapping)) {
      purlsJars[purl] = jarNSMapping[purl].jarFile;
      await Namespaces.findOrCreate({
        where: { purl },
        defaults: {
          purl,
          data: JSON.stringify(
            {
              pom: jarNSMapping[purl].pom,
              namespaces: jarNSMapping[purl].namespaces,
            },
            null,
            null,
          ),
        },
      });
    }
  }
  console.log(
    "To speed up successive re-runs, pass the argument --skip-maven-collector to evinse command.",
  );
}

/**
 * Generate a usage slice for the given purl and persist it in the Usages model.
 *
 * Delegates to {@link createSlice} to produce the slice file, then stores the
 * file contents in the `Usages` model keyed by purl. Any temporary directory
 * created under the cdxgen temp root is cleaned up afterwards.
 *
 * @param {string} purl Package URL to slice
 * @param {Object<string, string>} purlsJars Map of purl -> jar/file path
 * @param {Object} Usages Sequelize-like Usages model used to persist slice data
 * @param {object} options CLI options
 * @returns {Promise<Object|undefined>} The created or found Usages record
 */
export async function createAndStoreSlice(
  purl,
  purlsJars,
  Usages,
  options = {},
) {
  const retMap = createSlice(purl, purlsJars[purl], "usages", options);
  let sliceData;
  if (retMap?.slicesFile && safeExistsSync(retMap.slicesFile)) {
    sliceData = await Usages.findOrCreate({
      where: { purl },
      defaults: {
        purl,
        data: fs.readFileSync(retMap.slicesFile, "utf-8"),
      },
    });
  }
  if (retMap?.tempDir?.startsWith(getTmpDir())) {
    safeRmSync(retMap.tempDir, { recursive: true, force: true });
  }
  return sliceData;
}

/**
 * Name the option a slice type reads its output path from.
 *
 * The CLI flags are hyphenated (`--data-flow-slices-file`) and yargs hands them
 * over camel-cased, so a slice type containing a hyphen cannot be turned into
 * its option name by concatenation alone.
 *
 * @param {string} sliceType Slice type such as `usages` or `data-flow`
 * @returns {string} Matching option name
 */
export function sliceFileOption(sliceType) {
  const camelCased = sliceType.replace(/-([a-z])/g, (_match, letter) =>
    letter.toUpperCase(),
  );
  return `${camelCased}SlicesFile`;
}

/**
 * Run atom/sourcekitten/dosai to produce a usage or data-flow slice file for a purl or language.
 *
 * Accepts either a package url (resolved to a language via {@link purlToLanguage})
 * or an explicit language string. The chosen language is normalised to the
 * canonical atom language name and the requested slice type (`usages`,
 * `data-flow`, `reachables`, or `semantics`) is generated into a temporary
 * directory.
 *
 * @param {string|string[]} purlOrLanguages Package URL or language name (or array whose first entry is used)
 * @param {string} filePath Path to the source file, jar, or project directory to slice
 * @param {string} [sliceType="usages"] Slice type: `usages`, `data-flow`, `reachables`, or `semantics`
 * @param {object} [options={}] CLI options controlling slice generation
 * @returns {Promise<Object>} Result map with `slicesFile`, `atomFile`, `openapiSpecFile`, `semanticsSlicesFile`, `tempDir`, and `tempDirOwned`
 */
export async function createSlice(
  purlOrLanguages,
  filePath,
  sliceType = "usages",
  options = {},
) {
  if (!filePath) {
    return {};
  }
  const firstLanguage = Array.isArray(purlOrLanguages)
    ? purlOrLanguages[0]
    : purlOrLanguages;
  let language = firstLanguage.startsWith("pkg:")
    ? purlToLanguage(firstLanguage, filePath)
    : firstLanguage;
  if (!language) {
    return {};
  }
  // Handle language with version types
  if (language.startsWith("ruby")) {
    language = "ruby";
  } else if (language.startsWith("java") && language !== "javascript") {
    language = "java";
  } else if (language.startsWith("node")) {
    language = "js";
  } else if (language.startsWith("python")) {
    language = "python";
  } else if (PROJECT_TYPE_ALIASES.scala.includes(language)) {
    language = "scala";
  } else if (isDosaiDotnetLanguage(language)) {
    language = "csharp";
  }
  if (
    PROJECT_TYPE_ALIASES.swift.includes(language) &&
    sliceType !== "semantics"
  ) {
    return {};
  }

  let sliceOutputDir = safeMkdtempSync(join(getTmpDir(), `atom-${sliceType}-`));
  let tempDirOwned = true;
  if (options?.output) {
    const resolvedOutputPath = resolve(options.output);
    sliceOutputDir =
      safeExistsSync(resolvedOutputPath) &&
      fs.lstatSync(resolvedOutputPath).isDirectory()
        ? resolvedOutputPath
        : path.dirname(resolvedOutputPath);
    tempDirOwned = false;
  }
  const slicesFile =
    options[sliceFileOption(sliceType)] ||
    join(sliceOutputDir, `${language}-${sliceType}.slices.json`);
  const openapiSpecFile = basename(
    options.openapiSpecFile ||
      readEnvironmentVariable("ATOM_TOOLS_OPENAPI_FILENAME") ||
      join(sliceOutputDir, `${language}-openapi.json`),
  );
  // For some languages such as scala, semantics slices file would get created during usages slicing.
  let semanticsSlicesFile;
  if (sliceType === "semantics") {
    const slicesData = createSemanticsSlices(resolve(filePath), options);
    // Write the semantics slices data
    if (slicesData) {
      safeWriteSync(
        slicesFile,
        JSON.stringify(slicesData, null, options.jsonPretty ? 2 : null),
      );
    }
    return { tempDir: sliceOutputDir, tempDirOwned, slicesFile };
  }
  if (isDosaiDotnetLanguage(language)) {
    console.log(
      `Creating ${sliceType} slice for ${resolve(filePath)} using dosai. Please wait ...`,
    );
    const sliceResult =
      sliceType === "data-flow"
        ? createDosaiDataFlowSlice(
            resolve(filePath),
            resolve(slicesFile),
            options,
          )
        : createDosaiMethodsSlice(
            resolve(filePath),
            resolve(slicesFile),
            options,
          );
    if (!sliceResult) {
      console.warn(
        `Unable to generate ${sliceType} slice using dosai. Check if this is a supported .NET project.`,
      );
    }
    return {
      tempDir: sliceOutputDir,
      tempDirOwned,
      slicesFile,
    };
  }
  console.log(
    `Creating ${sliceType} slice for ${resolve(filePath)}. Please wait ...`,
  );
  const atomFile = join(sliceOutputDir, `${language}-app.atom`);
  let args = [sliceType];
  // Support for crypto slices aka CBOM
  if (sliceType === "reachables" && options.includeCrypto) {
    args.push("--include-crypto");
  }
  if (sliceType === "usages") {
    // Generate OpenAPI specification for endpoints. Needs atom-tools pypi package to be installed.
    args.push("--extract-endpoints");
    if (
      readEnvironmentVariable("CDXGEN_IN_CONTAINER") !== "true" &&
      !readEnvironmentVariable("DEVENV_NIX") &&
      !readEnvironmentVariable("NIX_STORE")
    ) {
      console.log(
        "Use an official cdxgen container image to improve the precision of endpoints detection (for SaaSBOM).",
      );
    }
    if (["ruby", "scala"].includes(language)) {
      args.push("--remove-atom");
    }
    if (["scala"].includes(language)) {
      semanticsSlicesFile = join(
        sliceOutputDir,
        basename(options.semanticsSlicesFile || "semantics.slices.json"),
      );
    }
  }
  args = args.concat([
    "-l",
    language,
    "-o",
    resolve(atomFile),
    "--slice-outfile",
    resolve(slicesFile),
  ]);
  // For projects with several layers, slice depth needs to be increased from the default 7 to 15 or 20
  // This would increase the time but would yield more deeper paths
  if (
    sliceType === "data-flow" &&
    readEnvironmentVariable("ATOM_SLICE_DEPTH")
  ) {
    args.push("--slice-depth");
    args.push(readEnvironmentVariable("ATOM_SLICE_DEPTH"));
  }
  args.push(resolve(filePath));
  const atomExcludeEnv = buildAtomCommandEnv(options, language);
  // Execute atom
  const result = executeAtom(filePath, args, {
    ...atomExcludeEnv,
    ATOM_TOOLS_OPENAPI_FILENAME: openapiSpecFile, // The file would get over-written
    ATOM_TOOLS_OPENAPI_FORMAT:
      readEnvironmentVariable("ATOM_TOOLS_OPENAPI_FORMAT") || "openapi3.1.0", // editor.swagger.io doesn't support 3.1.0 yet
    ATOM_TOOLS_WORK_DIR:
      readEnvironmentVariable("ATOM_TOOLS_WORK_DIR") || resolve(filePath), // This must be the directory containing semantics.slices.json
    OPENAPI_SERVER_URL: readEnvironmentVariable("OPENAPI_SERVER_URL"),
  });
  // A non-zero atom exit no longer discards a slices file that was written:
  // atom can fail a late phase (endpoint extraction, cleanup) after the slices
  // are on disk, and throwing that work away would be a regression against
  // atom 2.x, where the exit status was not observable at all.
  if (!safeExistsSync(slicesFile)) {
    if (!result) {
      console.warn(
        `atom reported a failure and produced no ${sliceType} slice for ${language}.`,
      );
    }
    console.warn(
      `Unable to generate ${sliceType} slice using atom. Check if this is a supported language.`,
    );
    if (!readEnvironmentVariable("CDXGEN_DEBUG_MODE")) {
      console.log(
        "Set the environment variable CDXGEN_DEBUG_MODE=debug to troubleshoot.",
      );
    } else {
      if (readEnvironmentVariable("CDXGEN_IN_CONTAINER") === "true") {
        console.log(
          "TIP: Try creating the slices using the official atom container image `ghcr.io/appthreat/atom:main` directly. Refer to the documentation: https://atom-docs.appthreat.dev/",
        );
        console.log(
          `evinse will automatically reuse any slices matching the name ${slicesFile}`,
        );
      } else {
        console.log(
          `TIP: Try using a cdxgen container image optimized for ${language}. Refer to the documentation or ask cdxgenGPT for the image details.`,
        );
      }
    }
  } else if (
    DEBUG_MODE &&
    sliceType === "usages" &&
    !safeExistsSync(join(filePath, openapiSpecFile))
  ) {
    console.log(
      `openapi spec file "${join(filePath, openapiSpecFile)}" was not generated successfully. Check if atom-tools pypi package is installed and available in PATH.`,
    );
  }
  if (
    ["scala"].includes(language) &&
    sliceType === "usages" &&
    !safeExistsSync(semanticsSlicesFile)
  ) {
    console.log(
      `Semantics slices file "${semanticsSlicesFile}" was not generated successfully. Try running atom cli in Java mode.`,
    );
  }
  return {
    tempDir: sliceOutputDir,
    tempDirOwned,
    slicesFile,
    atomFile,
    openapiSpecFile: resolve(join(filePath, openapiSpecFile)),
    semanticsSlicesFile,
  };
}

/**
 * Map a package URL type to an analysis language (java, python, js, …).
 *
 * @param {string} purl Package URL to inspect
 * @param {string} [filePath] Optional file path used to distinguish jar vs java for maven purls
 * @returns {string|undefined} Resolved language name or `undefined` when the purl type is unsupported
 */
export function purlToLanguage(purl, filePath) {
  let language;
  const purlObj = Purl.parse(purl);
  switch (purlObj.type) {
    case "maven":
      language = filePath?.endsWith(".jar") ? "jar" : "java";
      break;
    case "npm":
      language = "javascript";
      break;
    case "pypi":
      language = "python";
      break;
    case "composer":
      language = "php";
      break;
    case "gem":
      language = "ruby";
      break;
    case "nuget":
      language = "csharp";
      break;
    case "generic":
      language = "c";
  }
  return language;
}

/**
 * Seed purl-location and import maps from SBOM component evidence.
 *
 * Walks the supplied components reading `internal:ImportedModules` (or
 * `internal:Namespaces` for php/ruby) and `evidence.occurrences` properties
 * to construct lookup maps used during slice analysis.
 *
 * @param {Object[]} components CycloneDX components from the input SBOM
 * @param {string} language Application language used to select the import property name
 * @returns {{ purlLocationMap: Object<string, Set>, purlImportsMap: Object<string, string[]> }} Seeded purl location and import maps
 */
export function initFromSbom(components, language) {
  const purlLocationMap = {};
  const purlImportsMap = {};
  for (const comp of components) {
    if (!comp?.evidence) {
      continue;
    }
    if (["php", "ruby"].includes(language)) {
      (comp.properties || [])
        .filter((v) => v.name === "internal:Namespaces")
        .forEach((v) => {
          purlImportsMap[comp.purl] = (v.value || "").split(", ");
        });
    } else {
      (comp.properties || [])
        .filter((v) => v.name === "internal:ImportedModules")
        .forEach((v) => {
          purlImportsMap[comp.purl] = (v.value || "").split(",");
        });
    }
    if (comp.evidence.occurrences) {
      purlLocationMap[comp.purl] = new Set(
        comp.evidence.occurrences.map((v) => v.location),
      );
    }
  }
  return {
    purlLocationMap,
    purlImportsMap,
  };
}

function usableSlicesFile(slicesFile) {
  if (!slicesFile || !safeExistsSync(slicesFile)) {
    return false;
  }
  const stats = fs.statSync(slicesFile);
  if (!stats.isFile()) {
    return false;
  }
  const fileSizeInBytes = stats.size;
  return fileSizeInBytes > 1024;
}

/**
 * Function to analyze the project
 *
 * @param {Object} dbObjMap DB and model instances
 * @param {Object} options Command line options
 */
export async function analyzeProject(dbObjMap, options) {
  const dirPath = options._[0] || ".";
  const languages = options.language;
  const language = Array.isArray(languages) ? languages[0] : languages;
  let usageSlice;
  let dataFlowSlice;
  let reachablesSlice;
  let semanticsSlice;
  let usagesSlicesFile;
  let dataFlowSlicesFile;
  let reachablesSlicesFile;
  let semanticsSlicesFile;
  let dataFlowFrames = {};
  let servicesMap = {};
  let retMap = {};
  let userDefinedTypesMap = {};
  const bomFile = options.input;
  const bomJson = JSON.parse(fs.readFileSync(bomFile, "utf8"));
  const components = bomJson.components || [];
  let cryptoComponents = [];
  let aiComponents = [];
  let cryptoGeneratePurls = {};
  let openapiSpecFile;
  // Load any existing purl-location information from the sbom.
  // For eg: cdxgen populates this information for javascript projects
  let { purlLocationMap, purlImportsMap } = initFromSbom(components, language);

  if (isGolemGoLanguage(language)) {
    const golemReport = analyzeGolemProject(dirPath, options);
    if (golemReport && Object.keys(golemReport).length) {
      const golemEvidence = collectGolemEvidence(golemReport, [
        bomJson.metadata?.component,
        ...components,
      ]);
      return {
        purlLocationMap: golemEvidence.purlLocationMap,
        dataFlowFrames: golemEvidence.dataFlowFrames,
        componentPropertiesMap: golemEvidence.componentPropertiesMap,
        metadataProperties: golemEvidence.metadataProperties,
        cryptoComponents: golemEvidence.cryptoComponents,
        cryptoGeneratePurls: golemEvidence.cryptoGeneratePurls,
        servicesMap,
        userDefinedTypesMap,
      };
    }
    return {
      purlLocationMap,
      servicesMap,
      dataFlowFrames,
      userDefinedTypesMap,
    };
  }

  if (isRusiRustLanguage(language)) {
    const rusiReport = analyzeRusiProject(dirPath, options);
    if (rusiReport && Object.keys(rusiReport).length) {
      const rusiEvidence = collectRusiEvidence(rusiReport, [
        bomJson.metadata?.component,
        ...components,
      ]);
      return {
        purlLocationMap: rusiEvidence.purlLocationMap,
        dataFlowFrames: rusiEvidence.dataFlowFrames,
        componentPropertiesMap: rusiEvidence.componentPropertiesMap,
        metadataProperties: rusiEvidence.metadataProperties,
        cryptoComponents: rusiEvidence.cryptoComponents,
        cryptoGeneratePurls: rusiEvidence.cryptoGeneratePurls,
        servicesMap,
        userDefinedTypesMap,
      };
    }
    return {
      purlLocationMap,
      servicesMap,
      dataFlowFrames,
      userDefinedTypesMap,
    };
  }

  if (isDosaiDotnetLanguage(language)) {
    if (options.profile === "research") {
      options.withDataFlow = true;
      options.includeCrypto = true;
    }
    if (
      options.usagesSlicesFile &&
      usableSlicesFile(options.usagesSlicesFile)
    ) {
      usageSlice = JSON.parse(
        fs.readFileSync(options.usagesSlicesFile, "utf-8"),
      );
      usagesSlicesFile = options.usagesSlicesFile;
    } else {
      retMap = await createSlice(language, dirPath, "usages", options);
      if (retMap?.slicesFile && safeExistsSync(retMap.slicesFile)) {
        usageSlice = JSON.parse(fs.readFileSync(retMap.slicesFile, "utf-8"));
        usagesSlicesFile = retMap.slicesFile;
      }
    }
    if (usageSlice && Object.keys(usageSlice).length) {
      const dosaiEvidence = collectDosaiPurlEvidence(usageSlice, components);
      for (const [purl, locations] of Object.entries(
        dosaiEvidence.purlLocationMap,
      )) {
        purlLocationMap[purl] ??= new Set();
        for (const location of locations) {
          purlLocationMap[purl].add(location);
        }
      }
      // Rich Services[] inventory first (bom-refs, trust zones, data); endpoint
      // derivation fills any services the providers did not emit.
      // AI components must be carried out of analyzeProject explicitly. Mutating the local
      // `components` array here had no effect: the return below omits it and createEvinseFile
      // re-reads the BOM from disk, so the whole AI-BOM contribution was silently discarded.
      collectDosaiAiComponents(usageSlice, aiComponents);
      servicesMap = collectDosaiServiceComponents(usageSlice, servicesMap);
      servicesMap = collectDosaiServicesFromMethods(usageSlice, servicesMap);
      userDefinedTypesMap = {};
    }
    if (options.withDataFlow) {
      if (
        options.dataFlowSlicesFile &&
        safeExistsSync(options.dataFlowSlicesFile)
      ) {
        dataFlowSlicesFile = options.dataFlowSlicesFile;
        dataFlowSlice = JSON.parse(
          fs.readFileSync(options.dataFlowSlicesFile, "utf-8"),
        );
      } else {
        retMap = await createSlice(language, dirPath, "data-flow", options);
        if (retMap?.slicesFile && safeExistsSync(retMap.slicesFile)) {
          dataFlowSlicesFile = retMap.slicesFile;
          dataFlowSlice = JSON.parse(
            fs.readFileSync(retMap.slicesFile, "utf-8"),
          );
        }
      }
      if (dataFlowSlice && Object.keys(dataFlowSlice).length) {
        dataFlowFrames = collectDosaiDataFlowFrames(dataFlowSlice, components);
      }
    }
    if (options.includeCrypto) {
      cryptoComponents = await collectDosaiCryptoComponents(dirPath, options);
    }
    // Persist the combined native dosai report (methods + dataflows) to the
    // semantics-slices path when one was provided (--semantics-slices-file).
    // Mirrors analyzeRusiProject/analyzeGolemProject on feat/rusi-persist-report:
    // dotnet does not otherwise use the semantics slice (atom is never run for
    // dotnet), so the path is free to carry the full native dosai report that
    // downstream tools (depscan) consume as the source of truth. Only the full
    // native report is persisted; the existing SBOM evidence projection below
    // is unchanged.
    semanticsSlicesFile = persistDosaiSemanticsReport(
      options,
      usageSlice,
      dataFlowSlice,
    );
    return {
      usagesSlicesFile,
      dataFlowSlicesFile,
      semanticsSlicesFile,
      purlLocationMap,
      servicesMap,
      dataFlowFrames,
      tempDir: retMap?.tempDir,
      tempDirOwned: retMap?.tempDirOwned,
      userDefinedTypesMap,
      cryptoComponents,
      aiComponents,
      cryptoGeneratePurls,
    };
  }
  // Do reachables first so that usages slicing can reuse the atom file
  // We need reachables slicing even when trying to infer crypto packages
  if (options.withReachables || options.includeCrypto) {
    if (
      options.reachablesSlicesFile &&
      usableSlicesFile(options.reachablesSlicesFile)
    ) {
      reachablesSlicesFile = options.reachablesSlicesFile;
      reachablesSlice = filterAtomSliceData(
        JSON.parse(fs.readFileSync(options.reachablesSlicesFile, "utf-8")),
        options,
      );
    } else {
      retMap = await createSlice(language, dirPath, "reachables", options);
      if (retMap?.slicesFile && safeExistsSync(retMap.slicesFile)) {
        reachablesSlicesFile = retMap.slicesFile;
        reachablesSlice = filterAtomSliceData(
          JSON.parse(fs.readFileSync(retMap.slicesFile, "utf-8")),
          options,
        );
      }
    }
  }
  if (reachablesSlice && Object.keys(reachablesSlice).length) {
    const retMap = collectReachableFrames(language, reachablesSlice);
    dataFlowFrames = retMap.dataFlowFrames;
    cryptoComponents = retMap.cryptoComponents;
    aiComponents = retMap.aiComponents || [];
    cryptoGeneratePurls = retMap.cryptoGeneratePurls;
  }
  // Reuse existing usages slices
  if (options.usagesSlicesFile && usableSlicesFile(options.usagesSlicesFile)) {
    usageSlice = filterAtomSliceData(
      JSON.parse(fs.readFileSync(options.usagesSlicesFile, "utf-8")),
      options,
    );
    usagesSlicesFile = options.usagesSlicesFile;
  } else {
    // Generate our own slices
    retMap = await createSlice(language, dirPath, "usages", options);
    if (retMap?.slicesFile && safeExistsSync(retMap.slicesFile)) {
      usageSlice = filterAtomSliceData(
        JSON.parse(fs.readFileSync(retMap.slicesFile, "utf-8")),
        options,
      );
      usagesSlicesFile = retMap.slicesFile;
    }
    if (retMap?.semanticsSlicesFile) {
      options.semanticsSlicesFile = retMap.semanticsSlicesFile;
      semanticsSlicesFile = retMap.semanticsSlicesFile;
      if (DEBUG_MODE) {
        console.log(
          `Reusing the generated semantics slices file "${semanticsSlicesFile}".`,
        );
      }
    }
    if (retMap.openapiSpecFile) {
      // Retain any generated openapi spec file
      openapiSpecFile = retMap.openapiSpecFile;
    }
  }
  // Support for semantics slicing
  if (
    (PROJECT_TYPE_ALIASES.swift.includes(language) ||
      PROJECT_TYPE_ALIASES.scala.includes(language)) &&
    components.length
  ) {
    // Reuse existing semantics slices for swift and scala
    if (
      options.semanticsSlicesFile &&
      safeExistsSync(options.semanticsSlicesFile)
    ) {
      semanticsSlice = JSON.parse(
        fs.readFileSync(options.semanticsSlicesFile, "utf-8"),
      );
      semanticsSlicesFile = options.semanticsSlicesFile;
    } else if (PROJECT_TYPE_ALIASES.swift.includes(language)) {
      // Generate our own slices for swift
      retMap = await createSlice(language, dirPath, "semantics", options);
      if (retMap?.slicesFile && safeExistsSync(retMap.slicesFile)) {
        semanticsSlice = JSON.parse(
          fs.readFileSync(retMap.slicesFile, "utf-8"),
        );
        semanticsSlicesFile = retMap.slicesFile;
      }
    }
  }
  // Parse usage slices
  if (usageSlice && Object.keys(usageSlice).length) {
    const retMap = await parseObjectSlices(
      language,
      usageSlice,
      dbObjMap,
      servicesMap,
      purlLocationMap,
      purlImportsMap,
      openapiSpecFile,
    );
    purlLocationMap = retMap.purlLocationMap;
    servicesMap = retMap.servicesMap;
    userDefinedTypesMap = retMap.userDefinedTypesMap;
  }
  // Parse the semantics slices for swift and scala
  if (
    semanticsSlice &&
    Object.keys(semanticsSlice).length &&
    components.length
  ) {
    // Identify the purl locations
    const retMap = parseSemanticSlices(language, components, semanticsSlice);
    purlLocationMap = retMap.purlLocationMap;
  }
  if (options.withDataFlow) {
    if (
      options.dataFlowSlicesFile &&
      safeExistsSync(options.dataFlowSlicesFile)
    ) {
      dataFlowSlicesFile = options.dataFlowSlicesFile;
      dataFlowSlice = filterAtomSliceData(
        JSON.parse(fs.readFileSync(options.dataFlowSlicesFile, "utf-8")),
        options,
      );
    } else if (!PROJECT_TYPE_ALIASES.scala.includes(language)) {
      retMap = await createSlice(language, dirPath, "data-flow", options);
      if (retMap?.slicesFile && safeExistsSync(retMap.slicesFile)) {
        dataFlowSlicesFile = retMap.slicesFile;
        dataFlowSlice = filterAtomSliceData(
          JSON.parse(fs.readFileSync(retMap.slicesFile, "utf-8")),
          options,
        );
      }
    }
  }
  if (dataFlowSlice && Object.keys(dataFlowSlice).length) {
    dataFlowFrames = await collectDataFlowFrames(
      language,
      userDefinedTypesMap,
      dataFlowSlice,
      dbObjMap,
      purlLocationMap,
      purlImportsMap,
    );
  }
  return {
    atomFile: retMap?.atomFile,
    usagesSlicesFile,
    dataFlowSlicesFile,
    reachablesSlicesFile,
    semanticsSlicesFile,
    purlLocationMap,
    servicesMap,
    dataFlowFrames,
    tempDir: retMap?.tempDir,
    tempDirOwned: retMap?.tempDirOwned,
    userDefinedTypesMap,
    cryptoComponents,
    aiComponents,
    cryptoGeneratePurls,
    openapiSpecFile,
  };
}

/**
 * Parse atom object slices into usages, user-defined types, services, and purl-location evidence.
 *
 * Iterates over the `objectSlices` and `userDefinedTypes` of an atom usage slice,
 * delegating to {@link parseSliceUsages} to record purl locations and imports.
 * Services are detected first from an OpenAPI spec (when present) and then from
 * usage slices or user-defined types as fallbacks.
 *
 * @param {string} language Application language
 * @param {Object} usageSlice Parsed atom usage slice object
 * @param {Object} dbObjMap DB models handle containing Namespaces and Usages models
 * @param {Object} [servicesMap={}] Map populated with detected service definitions
 * @param {Object<string, Set>} [purlLocationMap={}] Map populated with purl -> source locations
 * @param {Object<string, string[]>} [purlImportsMap={}] Map populated with purl -> imported modules
 * @param {string} [openapiSpecFile=undefined] Optional path to an OpenAPI spec used for service detection
 * @returns {Promise<Object>} Map with `purlLocationMap`, `servicesMap`, and `userDefinedTypesMap`
 */
export async function parseObjectSlices(
  language,
  usageSlice,
  dbObjMap,
  servicesMap = {},
  purlLocationMap = {},
  purlImportsMap = {},
  openapiSpecFile = undefined,
) {
  let openapiServicesMode = false;
  if (!usageSlice || !Object.keys(usageSlice).length) {
    return purlLocationMap;
  }
  const userDefinedTypesMap = {};
  (usageSlice.userDefinedTypes || []).forEach((ut) => {
    userDefinedTypesMap[ut.name] = true;
  });
  for (const slice of [
    ...(usageSlice.objectSlices || []),
    ...(usageSlice.userDefinedTypes || []),
  ]) {
    // Skip the library code typically without filename
    if (
      !slice.fileName?.trim().length ||
      slice.fileName === "<empty>" ||
      slice.fileName === "<unknown>"
    ) {
      continue;
    }
    await parseSliceUsages(
      language,
      userDefinedTypesMap,
      slice,
      dbObjMap,
      purlLocationMap,
      purlImportsMap,
    );
    // Prefer openapi for identifying services
    if (
      !openapiServicesMode &&
      openapiSpecFile &&
      safeExistsSync(openapiSpecFile)
    ) {
      detectServicesFromOpenAPI(language, openapiSpecFile, servicesMap);
      if (servicesMap && Object.keys(servicesMap).length) {
        openapiServicesMode = true;
      }
    }
    // Only identify services from usage slices as a fallback
    if (!openapiServicesMode) {
      detectServicesFromUsages(language, slice, servicesMap);
    }
  }
  // Only identify services from user defined types as a second fallback
  if (!openapiServicesMode) {
    detectServicesFromUDT(language, usageSlice.userDefinedTypes, servicesMap);
  }
  return {
    purlLocationMap,
    servicesMap,
    userDefinedTypesMap,
  };
}

/**
 * The implementation of this function is based on the logic proposed in the atom slices specification
 * https://github.com/AppThreat/atom/blob/main/specification/docs/slices.md#use
 *
 * @param {string} language Application language
 * @param {Object} userDefinedTypesMap User Defined types in the application
 * @param {Array} slice Usages array for each objectSlice
 * @param {Object} dbObjMap DB Models
 * @param {Object} purlLocationMap Object to track locations where purls are used
 * @param {Object} purlImportsMap Object to track package urls and their import aliases
 * @returns
 */
export async function parseSliceUsages(
  language,
  userDefinedTypesMap,
  slice,
  dbObjMap,
  purlLocationMap,
  purlImportsMap,
) {
  const fileName = slice.fileName;
  const typesToLookup = new Set();
  const lKeyOverrides = {};
  const usages = slice.usages || [];
  // What should be the line number to use. slice.lineNumber would be quite coarse and could lead to reports such as
  // #1670. Line numbers under targetObj and definedBy is a safe bet for dynamic languages, but occassionally leads to
  // confusion when inter-procedural tracking works better than expected.
  let sliceLineNumber;
  if (["java", "jar"].includes(language)) {
    sliceLineNumber = slice.lineNumber;
  }
  // Annotations from usages
  if (slice.signature?.startsWith("@") && !usages.length) {
    typesToLookup.add(slice.fullName);
    addToOverrides(lKeyOverrides, slice.fullName, fileName, slice.lineNumber);
  }
  // PHP imports from usages
  if (slice.code?.startsWith("use") && !usages.length) {
    typesToLookup.add(slice.fullName);
    addToOverrides(lKeyOverrides, slice.fullName, fileName, slice.lineNumber);
  }
  for (const ausage of usages) {
    const ausageLine =
      sliceLineNumber ||
      ausage?.targetObj?.lineNumber ||
      ausage?.definedBy?.lineNumber;
    // First capture the types in the targetObj and definedBy
    for (const atype of [
      [ausage?.targetObj?.isExternal, ausage?.targetObj?.typeFullName],
      [ausage?.targetObj?.isExternal, ausage?.targetObj?.resolvedMethod],
      [ausage?.definedBy?.name?.includes("::"), ausage?.definedBy?.name],
      [ausage?.definedBy?.isExternal, ausage?.definedBy?.typeFullName],
      [ausage?.definedBy?.isExternal, ausage?.definedBy?.resolvedMethod],
      ...(ausage?.fields || []).map((f) => [f?.isExternal, f?.typeFullName]),
    ]) {
      if (
        !atype[0] &&
        (!atype[1] || ["ANY", "(...)", "<empty>"].includes(atype[1]))
      ) {
        continue;
      }
      if (
        atype[0] !== false &&
        !isFilterableType(language, userDefinedTypesMap, atype[1])
      ) {
        if (!atype[1].includes("(") && !atype[1].includes(".py")) {
          typesToLookup.add(simplifyType(atype[1]));
          // Javascript and Ruby calls can be resolved to a precise line number only from the call nodes
          if (
            ["javascript", "js", "ts", "typescript", "ruby"].includes(
              language,
            ) &&
            ausageLine
          ) {
            if (atype[1].includes(":")) {
              typesToLookup.add(
                simplifyType(atype[1].split("::")[0].replace(/:/g, "/")),
              );
            }
            addToOverrides(lKeyOverrides, atype[1], fileName, ausageLine);
          }
        }
        const maybeClassType = getClassTypeFromSignature(language, atype[1]);
        typesToLookup.add(maybeClassType);
        if (ausageLine) {
          addToOverrides(lKeyOverrides, maybeClassType, fileName, ausageLine);
        }
      }
    }
    // Now capture full method signatures from invokedCalls, argToCalls including the paramtypes
    for (const acall of []
      .concat(ausage?.invokedCalls || [])
      .concat(ausage?.argToCalls || [])
      .concat(ausage?.procedures || [])) {
      if (
        acall.resolvedMethod?.startsWith("@") ||
        acall?.callName?.includes("::")
      ) {
        typesToLookup.add(acall.callName);
        if (acall.lineNumber) {
          addToOverrides(
            lKeyOverrides,
            acall.callName,
            fileName,
            acall.lineNumber,
          );
        }
      } else if (acall.isExternal === false) {
        continue;
      }
      if (
        !isFilterableType(language, userDefinedTypesMap, acall?.resolvedMethod)
      ) {
        if (
          !acall?.resolvedMethod.includes("(") &&
          !acall?.resolvedMethod.includes(".py")
        ) {
          typesToLookup.add(simplifyType(acall?.resolvedMethod));
          // Javascript calls can be resolved to a precise line number only from the call nodes
          if (acall.lineNumber) {
            addToOverrides(
              lKeyOverrides,
              acall?.resolvedMethod,
              fileName,
              acall.lineNumber,
            );
          }
        }
        const maybeClassType = getClassTypeFromSignature(
          language,
          acall?.resolvedMethod,
        );
        typesToLookup.add(maybeClassType);
        if (acall.lineNumber) {
          addToOverrides(
            lKeyOverrides,
            maybeClassType,
            fileName,
            acall.lineNumber,
          );
        }
      }
      for (const aparamType of acall?.paramTypes || []) {
        if (!isFilterableType(language, userDefinedTypesMap, aparamType)) {
          if (!aparamType.includes("(") && !aparamType.includes(".py")) {
            typesToLookup.add(simplifyType(aparamType));
            if (acall.lineNumber) {
              if (aparamType.includes(":")) {
                typesToLookup.add(
                  simplifyType(aparamType.split("::")[0].replace(/:/g, "/")),
                );
              }
              addToOverrides(
                lKeyOverrides,
                aparamType,
                fileName,
                acall.lineNumber,
              );
            }
          }
          const maybeClassType = getClassTypeFromSignature(
            language,
            aparamType,
          );
          typesToLookup.add(maybeClassType);
          if (acall.lineNumber) {
            addToOverrides(
              lKeyOverrides,
              maybeClassType,
              fileName,
              acall.lineNumber,
            );
          }
        }
      }
    }
  }
  for (const atype of typesToLookup) {
    if (isFilterableType(language, userDefinedTypesMap, atype)) {
      continue;
    }
    if (purlImportsMap && Object.keys(purlImportsMap).length) {
      for (const apurl of Object.keys(purlImportsMap)) {
        const apurlImports = purlImportsMap[apurl];
        if (["php", "python", "ruby"].includes(language)) {
          for (const aimp of apurlImports) {
            if (
              atype.startsWith(aimp) ||
              (language === "ruby" && aimp.startsWith(atype))
            ) {
              if (!purlLocationMap[apurl]) {
                purlLocationMap[apurl] = new Set();
              }
              if (lKeyOverrides[atype]) {
                purlLocationMap[apurl].add(...lKeyOverrides[atype]);
              }
            }
          }
        } else {
          if (apurlImports?.includes(atype)) {
            if (!purlLocationMap[apurl]) {
              purlLocationMap[apurl] = new Set();
            }
            if (lKeyOverrides[atype]) {
              purlLocationMap[apurl].add(...lKeyOverrides[atype]);
            }
          }
        }
      }
    } else {
      // Check the namespaces db
      let nsHits = typePurlsCache[atype];
      if (!nsHits && ["java", "jar"].includes(language)) {
        nsHits = await dbObjMap.Namespaces.findAll({
          attributes: ["purl"],
          where: {
            data: {
              like: `%${atype}%`,
            },
          },
        });
      }
      if (nsHits?.length) {
        for (const ns of nsHits) {
          if (!purlLocationMap[ns.purl]) {
            purlLocationMap[ns.purl] = new Set();
          }
          if (lKeyOverrides[atype]) {
            purlLocationMap[ns.purl].add(...lKeyOverrides[atype]);
          }
        }
        typePurlsCache[atype] = nsHits;
      } else {
        // Avoid persistent lookups
        typePurlsCache[atype] = [];
      }
    }
  }
}

/**
 * Method to parse semantic slice data. Currently supported for swift and scala languages.
 *
 * @param {String} language Project language.
 * @param {Array} components Components from the input SBOM
 * @param {Object} semanticsSlice Semantic slice data
 * @returns {Object} Parsed metadata
 */
export function parseSemanticSlices(language, components, semanticsSlice) {
  // For scala, use the dedicated scalasem module.
  if (language === "scala") {
    return findPurlLocations(components, semanticsSlice);
  }
  if (!components) {
    return undefined;
  }
  const componentNamePurlMap = {};
  const componentSymbolsMap = {};
  const allObfuscationsMap = {};
  // We have two attributes in the semantics slice to expand a given module to its constituent symbols
  // - A less precise buildSymbols, which is obtained by parsing the various output-file-map.json files
  // - A granular and precise moduleInfos, which has the exact classes, protocols, enums etc belonging to each module
  // The objective then is to build the purlLocationMap, which is the list of locations where a given purl is used
  // For this, we have two attributes:
  // - A simpler fileStructures attribute that has the mapping between a swift file and the list of referenced types
  // - A granular fileIndexes attribute that contains information about the clang modules and line number information

  // We first need to map out the component names to their purls
  // This is because the semantics slice use the module names everywhere
  for (const comp of components) {
    componentNamePurlMap[comp.name] = comp.purl;
    if (!componentSymbolsMap[comp.name]) {
      componentSymbolsMap[comp.name] = new Set();
    }
    if (semanticsSlice?.buildSymbols[comp.name]) {
      for (const asym of semanticsSlice.buildSymbols[comp.name]) {
        componentSymbolsMap[comp.name].add(asym);
      }
    }
    const moduleInfo = semanticsSlice?.moduleInfos[comp.name] || {};
    if (moduleInfo.classes) {
      for (const asym of moduleInfo.classes) {
        componentSymbolsMap[comp.name].add(asym);
      }
    }
    if (moduleInfo.protocols) {
      for (const asym of moduleInfo.protocols) {
        componentSymbolsMap[comp.name].add(asym);
      }
    }
    if (moduleInfo.enums) {
      for (const asym of moduleInfo.enums) {
        componentSymbolsMap[comp.name].add(asym);
      }
    }
    // Now collect the method signatures from class and protocol methods
    if (moduleInfo.classMethods) {
      for (const aclassName of Object.keys(moduleInfo.classMethods)) {
        for (const asym of moduleInfo.classMethods[aclassName]) {
          componentSymbolsMap[comp.name].add(asym);
        }
      }
    }
    if (moduleInfo.protocolMethods) {
      for (const aclassName of Object.keys(moduleInfo.protocolMethods)) {
        for (const asym of moduleInfo.protocolMethods[aclassName]) {
          componentSymbolsMap[comp.name].add(asym);
        }
      }
    }
    // Build a large obfuscation map
    if (moduleInfo.obfuscationMap) {
      for (const asym of Object.keys(moduleInfo.obfuscationMap)) {
        allObfuscationsMap[asym] = moduleInfo.obfuscationMap[asym];
      }
    }
  }
  const purlLocationsSet = {};
  // We now have a good set of data in componentSymbolsMap and allObfuscationsMap
  // We can iterate these symbols and check if they exist under fileIndexes.symbolLocations
  for (const compName of Object.keys(componentSymbolsMap)) {
    const compSymbols = Array.from(componentSymbolsMap[compName]);
    const searchHits = searchSymbolLocations(
      compSymbols,
      semanticsSlice?.fileIndexes,
    );
    // We have an occurrence hit. Let's populate the purlLocationMap
    if (searchHits?.length) {
      const locations =
        purlLocationsSet[componentNamePurlMap[compName]] || new Set();
      for (const ahit of searchHits) {
        for (const aline of ahit.lineNumbers) {
          locations.add(`${ahit.file}#${aline}`);
        }
      }
      purlLocationsSet[componentNamePurlMap[compName]] = locations;
    }
  }
  const purlLocationMap = {};
  for (const apurl of Object.keys(purlLocationsSet)) {
    purlLocationMap[apurl] = Array.from(purlLocationsSet[apurl]).sort();
  }
  return { purlLocationMap };
}

function searchSymbolLocations(compSymbols, fileIndexes) {
  const searchHits = [];
  if (!fileIndexes) {
    return undefined;
  }
  for (const aswiftFile of Object.keys(fileIndexes)) {
    if (!fileIndexes[aswiftFile].symbolLocations) {
      continue;
    }
    for (const asym of Object.keys(fileIndexes[aswiftFile].symbolLocations)) {
      const lineNumbers = fileIndexes[aswiftFile].symbolLocations[asym];
      if (compSymbols.includes(asym)) {
        searchHits.push({
          file: aswiftFile,
          symbol: asym,
          lineNumbers,
        });
      }
    }
  }
  return searchHits;
}

/**
 * Decide whether a type name should be ignored during slice analysis.
 *
 * Returns `true` for placeholder/builtin/unresolved names and for language
 * specific primitives and JDK/runtime packages. User-defined types recorded in
 * `userDefinedTypesMap` are also considered filterable.
 *
 * @param {string} language Application language
 * @param {Object<string, boolean>} userDefinedTypesMap Known user-defined type names
 * @param {string} typeFullName Full type name to test
 * @returns {boolean} `true` when the type should be filtered out
 */
export function isFilterableType(language, userDefinedTypesMap, typeFullName) {
  if (
    !typeFullName ||
    ["ANY", "UNKNOWN", "VOID", "IMPORT"].includes(typeFullName.toUpperCase())
  ) {
    return true;
  }
  for (const ab of [
    "<operator",
    "<unresolved",
    "<unknownFullName",
    "__builtin",
    "LAMBDA",
    "../",
  ]) {
    if (typeFullName.startsWith(ab)) {
      return true;
    }
  }
  if (language && ["java", "jar"].includes(language)) {
    if (
      !typeFullName.includes(".") ||
      typeFullName.startsWith("@") ||
      typeFullName.startsWith("java.") ||
      typeFullName.startsWith("sun.") ||
      typeFullName.startsWith("jdk.") ||
      typeFullName.startsWith("org.w3c.") ||
      typeFullName.startsWith("org.xml.") ||
      typeFullName.startsWith("javax.xml.")
    ) {
      return true;
    }
  }
  if (["javascript", "js", "ts", "typescript"].includes(language)) {
    if (
      typeFullName.includes(".js") ||
      typeFullName.includes("=>") ||
      typeFullName.startsWith("__") ||
      typeFullName.startsWith("{ ") ||
      typeFullName.startsWith("JSON") ||
      typeFullName.startsWith("void:") ||
      typeFullName.startsWith("node:")
    ) {
      return true;
    }
  }
  if (["python", "py"].includes(language)) {
    if (
      typeFullName.startsWith("tmp") ||
      typeFullName.startsWith("self.") ||
      typeFullName.startsWith("_") ||
      typeFullName.startsWith("def ")
    ) {
      return true;
    }
  }
  if (["php"].includes(language)) {
    if (!typeFullName.includes("\\") && !typeFullName.startsWith("use")) {
      return true;
    }
  }
  if (["ruby"].includes(language)) {
    if (
      !typeFullName ||
      ["<empty>"].includes(typeFullName) ||
      typeFullName.startsWith("__core.") ||
      typeFullName.startsWith("@") ||
      typeFullName.toLowerCase() === typeFullName
    ) {
      return true;
    }
  }
  return !!userDefinedTypesMap[typeFullName];
}

/**
 * Extract service and endpoint definitions from an OpenAPI spec file.
 *
 * Parses the JSON spec and, for every operation under `paths`, records a
 * service entry keyed by the URL pattern and HTTP method into `servicesMap`.
 *
 * @param {string} _language Application language (unused; reserved for future use)
 * @param {string} openapiSpecFile Path to the OpenAPI JSON spec file
 * @param {Object} servicesMap Map populated with detected services
 * @returns {void}
 */
export function detectServicesFromOpenAPI(
  _language,
  openapiSpecFile,
  servicesMap,
) {
  try {
    const specData = JSON.parse(
      fs.readFileSync(openapiSpecFile, { encoding: "utf-8" }),
    );
    if (!specData?.paths || !Object.keys(specData.paths).length) {
      return;
    }
    for (const aurlPattern of Object.keys(specData.paths)) {
      const httpMethodObj = specData.paths[aurlPattern];
      for (const httpMethod of Object.keys(httpMethodObj)) {
        const hobj = httpMethodObj[httpMethod];
        const serviceName = `service-${aurlPattern.replaceAll("/", "")}-${httpMethod}`;
        const operationId = hobj["operationId"];
        const properties = [
          { name: "cdx:service:httpMethod", value: httpMethod },
        ];
        if (operationId) {
          properties.push({ name: "internal:operationId", value: operationId });
        }
        servicesMap[serviceName] = {
          endpoints: new Set([aurlPattern]),
          authenticated: undefined,
          xTrustBoundary: undefined,
          properties,
        };
      }
    }
  } catch (_e) {
    // Ignore malformed or unsupported OpenAPI files and fall back to usage slices.
  }
}

/**
 * Method to detect services from annotation objects in the usage slice
 *
 * @param {string} language Application language
 * @param {Array} slice Usages array for each objectSlice
 * @param {Object} servicesMap Existing service map
 */
export function detectServicesFromUsages(language, slice, servicesMap = {}) {
  const usages = slice.usages;
  if (!usages) {
    return [];
  }
  for (const usage of usages) {
    const targetObj = usage?.targetObj;
    const definedBy = usage?.definedBy;
    let endpoints = [];
    let authenticated;
    if (language === "ruby" && definedBy?.name?.includes("/")) {
      endpoints = extractEndpoints(language, definedBy.name);
    } else if (targetObj?.resolvedMethod) {
      if (language !== "php") {
        endpoints = extractEndpoints(language, targetObj?.resolvedMethod);
      }
      if (targetObj?.resolvedMethod.toLowerCase().includes("auth")) {
        authenticated = true;
      }
    } else if (definedBy?.resolvedMethod) {
      if (language !== "php") {
        endpoints = extractEndpoints(language, definedBy?.resolvedMethod);
      }
      if (definedBy?.resolvedMethod.toLowerCase().includes("auth")) {
        authenticated = true;
      }
    }
    if (usage.invokedCalls) {
      for (const acall of usage.invokedCalls) {
        if (acall.resolvedMethod) {
          if (language !== "php") {
            const tmpEndpoints = extractEndpoints(
              language,
              acall.resolvedMethod,
            );
            if (acall.resolvedMethod.toLowerCase().includes("auth")) {
              authenticated = true;
            }
            if (tmpEndpoints?.length) {
              endpoints = (endpoints || []).concat(tmpEndpoints);
            }
          }
        }
      }
    }
    if (endpoints?.length) {
      const serviceName = constructServiceName(language, slice);
      if (!servicesMap[serviceName]) {
        servicesMap[serviceName] = {
          endpoints: new Set(),
          authenticated,
          xTrustBoundary: authenticated === true ? true : undefined,
        };
      }
      for (const endpoint of endpoints) {
        servicesMap[serviceName].endpoints.add(endpoint);
      }
    }
  }
}

/**
 * Method to detect services from user defined types in the usage slice
 *
 * @param {string} language Application language
 * @param {Array} userDefinedTypes User defined types
 * @param {Object} servicesMap Existing service map
 */
export function detectServicesFromUDT(language, userDefinedTypes, servicesMap) {
  if (
    ["python", "py", "c", "cpp", "c++", "php", "ruby"].includes(language) &&
    userDefinedTypes?.length
  ) {
    for (const audt of userDefinedTypes) {
      if (
        audt.name.toLowerCase().includes("route") ||
        audt.name.toLowerCase().includes("path") ||
        audt.name.toLowerCase().includes("url") ||
        audt.name.toLowerCase().includes("registerhandler") ||
        audt.name.toLowerCase().includes("endpoint") ||
        audt.name.toLowerCase().includes("api") ||
        audt.name.toLowerCase().includes("add_method") ||
        audt.name.toLowerCase().includes("get") ||
        audt.name.toLowerCase().includes("post") ||
        audt.name.toLowerCase().includes("delete") ||
        audt.name.toLowerCase().includes("put") ||
        audt.name.toLowerCase().includes("head") ||
        audt.name.toLowerCase().includes("options") ||
        audt.name.toLowerCase().includes("addRoute") ||
        audt.name.toLowerCase().includes("connect")
      ) {
        const fields = audt.fields || [];
        if (fields.length && fields[0]?.name && fields[0].name.length > 1) {
          const endpoints = extractEndpoints(language, fields[0].name);
          let serviceName = "service";
          if (audt.fileName) {
            serviceName = `${path.basename(
              audt.fileName.replace(".py", ""),
            )}-service`;
          }
          if (endpoints?.length) {
            if (!servicesMap[serviceName]) {
              servicesMap[serviceName] = {
                endpoints: new Set(),
                authenticated: false,
                xTrustBoundary: undefined,
              };
            }
            for (const endpoint of endpoints) {
              servicesMap[serviceName].endpoints.add(endpoint);
            }
          }
        }
      }
    }
  }
}

/**
 * Derive a service name from a slice's fullName or file name.
 *
 * Uses the portion of `slice.fullName` before the first `:` (dots replaced with
 * hyphens), falling back to the file basename. A `-service` suffix is appended
 * when not already present.
 *
 * @param {string} _language Application language (unused; reserved for future use)
 * @param {Object} slice Object slice containing `fullName` and/or `fileName`
 * @returns {string} Constructed service name
 */
export function constructServiceName(_language, slice) {
  let serviceName = "service";
  if (slice?.fullName) {
    serviceName = slice.fullName.split(":")[0].replace(/\./g, "-");
  } else if (slice?.fileName) {
    serviceName = path.basename(slice.fileName).split(".")[0];
  }
  if (!serviceName.endsWith("service")) {
    serviceName = `${serviceName}-service`;
  }
  return serviceName;
}

/**
 * Extract HTTP endpoint paths from source code annotations for a given language.
 *
 * Examines the supplied code snippet for framework-specific routing annotations
 * (e.g. Spring `@*Mapping`, Express `app.`/`route`, Rails route verbs) and
 * returns the matched endpoint path strings.
 *
 * @param {string} language Application language such as `java`, `js`, or `ruby`
 * @param {string} code Source code snippet to inspect
 * @returns {string[]|undefined} Array of endpoint paths or `undefined` when none are found
 */
export function extractEndpoints(language, code) {
  if (!code) {
    return undefined;
  }
  let endpoints;
  switch (language) {
    case "java":
    case "jar":
      if (
        code.startsWith("@") &&
        (code.includes("Mapping") || code.includes("Path")) &&
        code.includes("(")
      ) {
        const matches = code.match(/['"](.*?)['"]/gi) || [];
        endpoints = matches
          .map((v) => v.replace(/["']/g, ""))
          .filter(
            (v) =>
              v.length &&
              !v.startsWith(".") &&
              v.includes("/") &&
              !v.startsWith("@"),
          );
      }
      break;
    case "js":
    case "ts":
    case "javascript":
    case "typescript":
      if (code.includes("app.") || code.includes("route")) {
        const matches = code.match(/['"](.*?)['"]/gi) || [];
        endpoints = matches
          .map((v) => v.replace(/["']/g, ""))
          .filter(
            (v) =>
              v.length &&
              !v.startsWith(".") &&
              v.includes("/") &&
              !v.startsWith("@") &&
              !v.startsWith("application/") &&
              !v.startsWith("text/"),
          );
      }
      break;
    case "ruby":
    case "rb": {
      let urlPrefix = "";
      let urlSuffix = "";
      // Remove the ellipsis added by the frontend
      code = code.replaceAll("...", "");
      if (code.includes("namespace ")) {
        urlPrefix = code.split("namespace ").pop().split(" ")[0];
      } else if (code.includes("collection do get ")) {
        urlPrefix = code.split("collection do get ").pop().split(" ")[0];
      }
      for (const m of ["get", "post", "delete", "options", "put", "head"]) {
        if (code.includes(`${m} `)) {
          urlSuffix = code.split(`${m} `).pop().split(" ")[0];
        }
      }
      if (code.includes("http") && code.includes('"')) {
        endpoints = code.split('"').filter((s) => s.startsWith("http"));
      }
      if (urlPrefix !== "" || urlSuffix !== "") {
        if (!endpoints) {
          endpoints = [];
        }
        endpoints.push(
          `${urlPrefix.replace(/['"]/g, "")}${urlSuffix.replace(/['"]/g, "")}`,
        );
      }
      endpoints =
        endpoints && Array.isArray(endpoints)
          ? endpoints.filter(
              (u) => u.length > 1 && !u.startsWith(".") && u !== "https:/",
            )
          : endpoints;
      break;
    }
    default:
      endpoints = (code.match(/['"](.*?)['"]/gi) || [])
        .map((v) => v.replace(/["']/g, "").replace("\n", ""))
        .filter((v) => v.length > 2 && v.includes("/"));
      break;
  }
  return endpoints;
}

/**
 * Method to create the SBOM with evidence file called evinse file.
 *
 * @param {Object} sliceArtefacts Various artefacts from the slice operation
 * @param {Object} options Command line options
 * @returns
 */
export function createEvinseFile(sliceArtefacts, options) {
  const {
    tempDir,
    tempDirOwned,
    usagesSlicesFile,
    dataFlowSlicesFile,
    reachablesSlicesFile,
    purlLocationMap,
    servicesMap,
    dataFlowFrames,
    componentPropertiesMap = {},
    metadataProperties = [],
    cryptoComponents,
    aiComponents,
    cryptoGeneratePurls,
  } = sliceArtefacts;
  const bomFile = options.input;
  const evinseOutFile = options.output;
  const bomJson = JSON.parse(fs.readFileSync(bomFile, "utf8"));
  const components = bomJson.components || [];
  // Clear existing annotations
  bomJson.annotations = [];
  appendComponentProperties(bomJson.metadata?.component, metadataProperties);
  let occEvidencePresent = false;
  let csEvidencePresent = false;
  let servicesPresent = false;
  const propertyEvidencePresent =
    metadataProperties.length || Object.keys(componentPropertiesMap).length;
  for (const comp of [bomJson.metadata?.component, ...components]) {
    if (!comp?.purl) {
      continue;
    }
    delete comp.signature;
    appendComponentProperties(comp, componentPropertiesMap[comp.purl]);
    const locationOccurrences = Array.from(
      purlLocationMap[comp.purl] || [],
    ).sort();
    if (locationOccurrences.length) {
      if (!comp.evidence) {
        comp.evidence = {};
      }
      // This step would replace any existing occurrences
      // This is fine as long as the input sbom was also generated by cdxgen
      comp.evidence.occurrences = locationOccurrences
        .filter((l) => !!l)
        .map((l) => parseOccurrenceEvidenceLocation(l));
      occEvidencePresent = true;
    }
    const dfFrames = dataFlowFrames[comp.purl];
    if (dfFrames?.length) {
      if (!comp.evidence) {
        comp.evidence = {};
      }
      if (!comp.evidence.callstack) {
        comp.evidence.callstack = {};
      }
      if (!comp.evidence.callstack.frames) {
        comp.evidence.callstack.frames = framePicker(dfFrames);
        csEvidencePresent = true;
      }
    }
    // Add crypto tags if this purl offers any generation algorithm
    if (
      cryptoGeneratePurls?.[comp.purl] &&
      Array.from(cryptoGeneratePurls[comp.purl]).length
    ) {
      comp.tags = ["crypto", "crypto-generate"];
    }
  } // for
  if (servicesMap && Object.keys(servicesMap).length) {
    const services = [];
    for (const serviceName of Object.keys(servicesMap)) {
      const definition = servicesMap[serviceName];
      // Dosai's provider inventory (schema 4.0.0) supplies stable bom-refs, trust
      // zones, providers, data classifications, and evidence occurrences.
      const service = {
        name: definition.name || serviceName,
        endpoints: Array.from(definition.endpoints || []),
        authenticated: definition.authenticated,
        // Both spellings: the OpenAPI, Java and Python service detectors above all set the camelCase
        // `xTrustBoundary`, and only dosai's Services[] path sets the hyphenated CycloneDX key.
        "x-trust-boundary":
          definition["x-trust-boundary"] ?? definition.xTrustBoundary,
        properties: definition.properties,
      };
      if (definition.bomRef) {
        service["bom-ref"] = definition.bomRef;
      }
      if (definition.group) {
        service.group = definition.group;
      }
      if (definition.version) {
        service.version = definition.version;
      }
      if (definition.trustZone) {
        service.trustZone = definition.trustZone;
      }
      if (definition.provider) {
        service.provider = definition.provider;
      }
      if (definition.data) {
        service.data = definition.data;
      }
      if (definition.evidence) {
        service.evidence = definition.evidence;
      }
      services.push(service);
    }
    // Add to existing services while preserving CycloneDX uniqueItems validity
    bomJson.services = mergeServices(bomJson.services || [], services);
    servicesPresent = true;
  }
  // Add the crypto components to the components list
  if (cryptoComponents?.length) {
    bomJson.components = bomJson.components.concat(cryptoComponents);
  }
  // Add the AI components (machine-learning-model, dataset) discovered by dosai
  if (aiComponents?.length) {
    bomJson.components = bomJson.components.concat(aiComponents);
  }
  // Fix the dependencies section with provides information
  if (
    cryptoGeneratePurls &&
    Object.keys(cryptoGeneratePurls).length &&
    bomJson.dependencies
  ) {
    const newDependencies = [];
    for (const depObj of bomJson.dependencies) {
      if (depObj.ref && cryptoGeneratePurls[depObj.ref]) {
        const providedAlgos = Array.from(cryptoGeneratePurls[depObj.ref]);
        if (providedAlgos.length) {
          depObj.provides = providedAlgos;
        }
      }
      newDependencies.push(depObj);
    }
    bomJson.dependencies = newDependencies;
  }
  if (options.annotate) {
    if (usagesSlicesFile && safeExistsSync(usagesSlicesFile)) {
      bomJson.annotations.push({
        subjects: [bomJson.serialNumber],
        annotator: { component: bomJson.metadata.tools.components[0] },
        timestamp: getTimestamp(),
        text: fs.readFileSync(usagesSlicesFile, "utf8"),
      });
    }
    if (dataFlowSlicesFile && safeExistsSync(dataFlowSlicesFile)) {
      bomJson.annotations.push({
        subjects: [bomJson.serialNumber],
        annotator: { component: bomJson.metadata.tools.components[0] },
        timestamp: getTimestamp(),
        text: fs.readFileSync(dataFlowSlicesFile, "utf8"),
      });
    }
    if (reachablesSlicesFile && safeExistsSync(reachablesSlicesFile)) {
      bomJson.annotations.push({
        subjects: [bomJson.serialNumber],
        annotator: { component: bomJson.metadata.tools.components[0] },
        timestamp: getTimestamp(),
        text: fs.readFileSync(reachablesSlicesFile, "utf8"),
      });
    }
  }
  // Increment the version
  bomJson.version = (bomJson.version || 1) + 1;
  // Set the current timestamp to indicate this is newer
  bomJson.metadata.timestamp = getTimestamp();
  delete bomJson.signature;
  // Redo post-processing with evinse data. `executeOsQuery` has to be injected
  // because postgen no longer imports it directly (stages is below managers);
  // without it the crypto formulation path receives `undefined` and throws.
  const bomNSData = postProcess({ bomJson }, { ...options, executeOsQuery });
  safeWriteSync(
    evinseOutFile,
    JSON.stringify(bomNSData.bomJson, null, options.jsonPretty ? 2 : null),
  );
  if (
    occEvidencePresent ||
    csEvidencePresent ||
    servicesPresent ||
    propertyEvidencePresent
  ) {
    console.log(evinseOutFile, "created successfully.");
  } else {
    console.log(
      "Unable to identify component evidence for the input SBOM based on the slices from atom. The slices are either empty or lack appropriate tags.",
    );
    if (DEBUG_MODE) {
      console.log(
        "1. Ensure cdxgen was installed without omitting any optional dependencies.",
      );
      console.log(
        "2. Retry after removing the following files from the root directory: app.atom, usages.slices.json, reachables.slices.json.",
      );
      if (readEnvironmentVariable("CDXGEN_IN_CONTAINER") !== "true") {
        console.log(
          "3. Additional environment variables may have to be set for local invocations. Check the documentation for atom and evinse.",
        );
      } else {
        console.log(
          "TIP: Try creating the slices using the official atom container image `ghcr.io/appthreat/atom:main` directly. Refer to the documentation: https://atom-docs.appthreat.dev/",
        );
      }
      console.log(
        "Large projects may require more memory. Consider increasing the memory to 16GB or higher.",
      );
    }
  }
  if (tempDirOwned && tempDir?.startsWith(getTmpDir())) {
    safeRmSync(tempDir, { recursive: true, force: true });
  }
  return bomNSData?.bomJson;
}

/**
 * Method to convert dataflow slice into usable callstack frames
 * Implemented based on the logic proposed here - https://github.com/AppThreat/atom/blob/main/specification/docs/slices.md#data-flow-slice
 *
 * @param {string} language Application language
 * @param {Object} userDefinedTypesMap User Defined types in the application
 * @param {Object} dataFlowSlice Data flow slice object from atom
 * @param {Object} dbObjMap DB models
 * @param {Object} _purlLocationMap Object to track locations where purls are used
 * @param {Object} purlImportsMap Object to track package urls and their import aliases
 */
export async function collectDataFlowFrames(
  language,
  userDefinedTypesMap,
  dataFlowSlice,
  dbObjMap,
  _purlLocationMap,
  purlImportsMap,
) {
  const nodes = dataFlowSlice?.graph?.nodes || [];
  // Cache the nodes based on the id to improve lookup
  const nodeCache = {};
  // purl key and an array of frames array
  // CycloneDX 1.5 currently accepts only 1 frame as evidence
  // so this method is more future-proof
  const dfFrames = {};
  for (const n of nodes) {
    nodeCache[n.id] = n;
  }
  const paths = dataFlowSlice?.paths || [];
  for (const apath of paths) {
    const aframe = [];
    let referredPurls = new Set();
    for (const nid of apath) {
      const theNode = nodeCache[nid];
      if (!theNode) {
        continue;
      }
      let typeFullName = theNode.typeFullName;
      if (
        ["javascript", "js", "ts", "typescript"].includes(language) &&
        typeFullName === "ANY"
      ) {
        if (
          theNode.code &&
          (theNode.code.startsWith("new ") ||
            ["METHOD_PARAMETER_IN", "IDENTIFIER"].includes(theNode.label))
        ) {
          typeFullName = theNode.code.split("(")[0].replace("new ", "");
        } else {
          typeFullName = theNode.fullName || theNode.name;
        }
      }
      const maybeClassType = getClassTypeFromSignature(language, typeFullName);
      if (!isFilterableType(language, userDefinedTypesMap, typeFullName)) {
        if (purlImportsMap && Object.keys(purlImportsMap).length) {
          for (const apurl of Object.keys(purlImportsMap)) {
            const apurlImports = purlImportsMap[apurl];
            if (
              apurlImports &&
              (apurlImports.includes(typeFullName) ||
                apurlImports.includes(maybeClassType))
            ) {
              referredPurls.add(apurl);
            }
          }
        } else {
          // Check the namespaces db
          let nsHits = typePurlsCache[typeFullName];
          if (["java", "jar"].includes(language)) {
            nsHits = await dbObjMap.Namespaces.findAll({
              attributes: ["purl"],
              where: {
                data: {
                  like: `%${typeFullName}%`,
                },
              },
            });
          }
          if (nsHits?.length) {
            for (const ns of nsHits) {
              referredPurls.add(ns.purl);
            }
            typePurlsCache[typeFullName] = nsHits;
          } else if (DEBUG_MODE) {
            console.log("Unable to identify purl for", typeFullName);
          }
        }
      }
      let parentPackageName = theNode.parentPackageName || "";
      if (
        parentPackageName === "<global>" &&
        theNode.parentClassName &&
        theNode.parentClassName.includes("::")
      ) {
        parentPackageName = theNode.parentClassName.split("::")[0];
        if (parentPackageName.includes(".js")) {
          const tmpA = parentPackageName.split("/");
          if (tmpA.length > 1) {
            tmpA.pop();
          }
          parentPackageName = tmpA.join("/");
        }
      }
      aframe.push({
        package: parentPackageName,
        module: theNode.parentClassName || "",
        function: theNode.parentMethodName || "",
        line: theNode.lineNumber || undefined,
        column: theNode.columnNumber || undefined,
        fullFilename: theNode.parentFileName || "",
      });
    }
    referredPurls = Array.from(referredPurls);
    if (referredPurls.length) {
      for (const apurl of referredPurls) {
        if (!dfFrames[apurl]) {
          dfFrames[apurl] = [];
        }
        // Store this frame as an evidence for this purl
        dfFrames[apurl].push(aframe);
      }
    }
  }
  return dfFrames;
}

/**
 * Method to convert reachable slice into usable callstack frames and crypto components
 *
 * Implemented based on the logic proposed here - https://github.com/AppThreat/atom/blob/main/specification/docs/slices.md#data-flow-slice
 *
 * @param {string} _language Application language
 * @param {Object} reachablesSlice Reachables slice object from atom
 */
export function collectReachableFrames(_language, reachablesSlice) {
  const reachableNodes = Array.isArray(reachablesSlice)
    ? reachablesSlice
    : reachablesSlice?.reachables || [];
  // purl key and an array of frames array
  // CycloneDX 1.5 currently accepts only 1 frame as evidence
  // so this method is more future-proof
  const dfFrames = {};
  const cryptoComponentsMap = {};
  // Track purls which provide the specific generate algorithm
  const cryptoGeneratePurls = {};
  for (const anode of reachableNodes) {
    const aframe = [];
    let referredPurls = new Set(anode.purls || []);
    let isCryptoFlow = false;
    let codeSnippets = "";
    let cpurls = [];
    for (const fnode of anode.flows) {
      const tagStr = fnode.tags || "";
      if (tagStr.includes("crypto")) {
        isCryptoFlow = true;
      }
      if (isCryptoFlow && fnode.code) {
        codeSnippets = `${codeSnippets}\\n${fnode.code}`;
      }
      if (
        tagStr.includes("crypto-generate") ||
        fnode.code.includes("encrypt") ||
        fnode.code.includes("decrypt") ||
        fnode.code.includes("sign")
      ) {
        cpurls = tagStr.split(", ").filter((t) => t.startsWith("pkg:"));
        for (const cpurl of cpurls) {
          if (!cryptoGeneratePurls[cpurl]) {
            cryptoGeneratePurls[cpurl] = new Set();
          }
        }
      }
      if (!fnode.parentFileName || fnode.parentFileName === "<unknown>") {
        continue;
      }
      aframe.push({
        package: fnode.parentPackageName,
        module: fnode.parentClassName || "",
        function: fnode.parentMethodName || "",
        line: fnode.lineNumber || undefined,
        column: fnode.columnNumber || undefined,
        fullFilename: fnode.parentFileName || "",
      });
    }
    referredPurls = Array.from(referredPurls);
    if (referredPurls.length) {
      for (const apurl of referredPurls) {
        if (!dfFrames[apurl]) {
          dfFrames[apurl] = [];
        }
        // Store this frame as an evidence for this purl
        dfFrames[apurl].push(aframe);
      }
    }
    // Detect crypto algorithms used in a crypto flow
    if (isCryptoFlow && codeSnippets.length) {
      const cryptoAlgos = findCryptoAlgos(codeSnippets);
      for (const algo of cryptoAlgos) {
        cryptoComponentsMap[algo.ref] = algo;
        for (const cpurl of cpurls) {
          cryptoGeneratePurls[cpurl].add(algo.ref);
        }
      }
    }
  }
  const cryptoComponents = [];
  for (const cref of Object.keys(cryptoComponentsMap)) {
    const algoObj = cryptoComponentsMap[cref];
    cryptoComponents.push({
      type: "cryptographic-asset",
      name: algoObj.name,
      "bom-ref": algoObj.ref,
      description: algoObj.description || "",
      cryptoProperties: {
        assetType: "algorithm",
        oid: algoObj.oid,
      },
    });
  }
  return {
    dataFlowFrames: dfFrames,
    cryptoComponents,
    cryptoGeneratePurls,
  };
}

/**
 * Method to pick a callstack frame as an evidence. This method is required since CycloneDX 1.5 accepts only a single frame as evidence.
 *
 * @param {Array} dfFrames Data flow frames
 * @returns
 */
export function framePicker(dfFrames) {
  if (!dfFrames?.length) {
    return undefined;
  }
  const normalizedStacks = dfFrames
    .filter((stack) => Array.isArray(stack) && stack.length)
    .map((stack) =>
      stack.filter(
        (frame) => frame?.fullFilename && frame.fullFilename !== "<unknown>",
      ),
    )
    .filter((stack) => stack.length);
  if (!normalizedStacks.length) {
    return undefined;
  }
  const frameKey = (frame) =>
    `${frame.fullFilename}#${frame.line || ""}#${frame.column || ""}`;
  const dedupeFrames = (frames) => {
    const seen = new Set();
    const out = [];
    for (const frame of frames) {
      const key = frameKey(frame);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push(frame);
    }
    return out;
  };
  const stackScore = (stack) => {
    const deduped = dedupeFrames(stack);
    const uniqueFiles = new Set(deduped.map((frame) => frame.fullFilename))
      .size;
    return uniqueFiles * 100 + deduped.length;
  };
  const rankedStacks = normalizedStacks
    .map((stack) => dedupeFrames(stack))
    .sort((left, right) => stackScore(right) - stackScore(left));
  const best = rankedStacks[0];
  const bestUniqueFiles = new Set(best.map((frame) => frame.fullFilename)).size;
  if (bestUniqueFiles >= 2 || best.length >= 2) {
    return best;
  }
  const synthesized = [];
  const seen = new Set();
  for (const stack of rankedStacks) {
    for (const frame of stack) {
      const key = frameKey(frame);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      synthesized.push(frame);
      if (synthesized.length >= 8) {
        return synthesized;
      }
    }
  }
  return synthesized.length ? synthesized : best;
}

/**
 * Method to simplify types. For example, arrays ending with [] could be simplified.
 *
 * @param {string} typeFullName Full name of the type to simplify
 * @returns Simplified type string
 */
export function simplifyType(typeFullName) {
  return typeFullName.replace("[]", "");
}

/**
 * Reduce a full type signature to its enclosing class type for a given language.
 *
 * Strips method, call, and member qualifiers from the signature using language
 * specific rules (e.g. java method selectors, javascript `::`/`new`/`await`,
 * python module/body suffixes) and returns the simplified class type via
 * {@link simplifyType}.
 *
 * @param {string} language Application language
 * @param {string} typeFullName Full type signature to reduce
 * @returns {string|undefined} Enclosing class type or `undefined` when it cannot be resolved
 */
export function getClassTypeFromSignature(language, typeFullName) {
  if (["java", "jar"].includes(language) && typeFullName.includes(":")) {
    typeFullName = typeFullName.split(":")[0];
    const tmpA = typeFullName.split(".");
    tmpA.pop();
    typeFullName = tmpA.join(".");
  } else if (["javascript", "js", "ts", "typescript"].includes(language)) {
    typeFullName = typeFullName.replace("new: ", "").replace("await ", "");
    if (typeFullName.includes(":")) {
      const tmpA = typeFullName.split("::")[0].replace(/:/g, "/").split("/");
      if (tmpA.length > 1) {
        tmpA.pop();
      }
      typeFullName = tmpA.join("/");
    }
  } else if (["python", "py"].includes(language)) {
    if (typeFullName.includes("/")) {
      typeFullName = typeFullName.split("/").pop();
    }
    typeFullName = typeFullName
      .replace(".py:<module>", "")
      .replace(/\//g, ".")
      .replace(".<metaClassCallHandler>", "")
      .replace(".<fakeNew>", "")
      .replace(".<body>", "")
      .replace(".__iter__", "")
      .replace(".__init__", "");
  } else if (["php"].includes(language)) {
    typeFullName = typeFullName.split("->")[0].split("::")[0];
  } else if (["ruby"].includes(language)) {
    if (
      ["<empty>"].includes(typeFullName) ||
      typeFullName.startsWith("__core.")
    ) {
      return undefined;
    }
    typeFullName = typeFullName.split("::")[0].split(" ").pop();
  }
  if (
    typeFullName.startsWith("<unresolved") ||
    typeFullName.startsWith("<operator") ||
    typeFullName.startsWith("<unknownFullName")
  ) {
    return undefined;
  }
  if (typeFullName.includes("$")) {
    typeFullName = typeFullName.split("$")[0];
  }
  return simplifyType(typeFullName);
}

function addToOverrides(lKeyOverrides, atype, fileName, ausageLineNumber) {
  if (!lKeyOverrides[atype]) {
    lKeyOverrides[atype] = new Set();
  }
  lKeyOverrides[atype].add(`${fileName}#${ausageLineNumber}`);
}
