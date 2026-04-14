import { readFileSync, rmSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import process from "node:process";

import { PackageURL } from "packageurl-js";

import { mergeDependencies } from "../../helpers/depsUtils.js";
import { addFormulationSection } from "../../helpers/formulationParsers.js";
import { thoughtLog } from "../../helpers/logger.js";
import {
  DEBUG_MODE,
  dirNameStr,
  getTimestamp,
  getTmpDir,
  hasAnyProjectType,
  safeExistsSync,
} from "../../helpers/utils.js";
import { extractTags, findBomType, textualMetadata } from "./annotator.js";

/**
 * Convert directories to relative dir format carefully avoiding arbitrary relativization for unrelated directories.
 *
 * @param d Directory to convert
 * @param options CLI options
 *
 * @returns {string} Relative directory
 */
function relativeDir(d, options) {
  // Container images might have such directories
  if (/^\/(usr|lib|root|bin)/.test(d)) {
    return d;
  }
  const tmpDir = getTmpDir();
  if (d.startsWith(tmpDir)) {
    const rd = relative(tmpDir, d);
    return rd.includes("all-layers") ? rd.split("all-layers").pop() : rd;
  }
  const baseDir = options.filePath || process.cwd();
  if (safeExistsSync(baseDir)) {
    const rdir = relative(baseDir, d);
    return rdir.startsWith(join("..", "..")) ? d : rdir;
  }
  return d;
}

/**
 * Attach the CycloneDX formulation section to an already-built BOM JSON object.
 *
 * This is intentionally called once, from {@link postProcess}, so that the
 * formulation section is added exactly once regardless of how many per-language
 * `buildBomNSData` calls were made during BOM generation.
 *
 * @param {Object} bomJson       The assembled BOM JSON object (mutated in place).
 * @param {Object} options       CLI options.
 * @param {Array}  [formulationList]  Optional language-specific formulation
 *                               data (e.g. from Pixi) carried on `bomNSData`.
 * @returns {Object} The same `bomJson` with `formulation` populated.
 */
function applyFormulation(bomJson, options, formulationList) {
  if (
    !options.includeFormulation ||
    options.specVersion < 1.5 ||
    !bomJson ||
    bomJson.formulation !== undefined
  ) {
    return bomJson;
  }
  const context = formulationList?.length ? { formulationList } : {};
  const formulationData = addFormulationSection(options, context);
  if (!formulationData) {
    return bomJson;
  }
  bomJson.formulation = formulationData.formulation;
  if (formulationData.dependencies?.length) {
    bomJson.dependencies = mergeDependencies(
      bomJson.dependencies || [],
      formulationData.dependencies,
    );
  }
  return bomJson;
}

/**
 * Filter and enhance BOM post generation.
 *
 * @param {Object} bomNSData BOM with namespaces object
 * @param {Object} options CLI options
 *
 * @returns {Object} Modified bomNSData
 */
export function postProcess(bomNSData, options) {
  let jsonPayload = bomNSData.bomJson;
  if (
    typeof bomNSData.bomJson === "string" ||
    bomNSData.bomJson instanceof String
  ) {
    jsonPayload = JSON.parse(bomNSData.bomJson);
  }

  bomNSData.bomJson = filterBom(jsonPayload, options);
  bomNSData.bomJson = applyStandards(bomNSData.bomJson, options);
  bomNSData.bomJson = applyMetadata(bomNSData.bomJson, options);
  bomNSData.bomJson = applyFormulation(
    bomNSData.bomJson,
    options,
    bomNSData.formulationList,
  );
  // Support for automatic annotations
  if (options.specVersion >= 1.6) {
    bomNSData.bomJson = annotate(bomNSData.bomJson, options);
  }
  cleanupEnv(options);
  cleanupTmpDir();
  return bomNSData;
}

/**
 * Apply additional metadata based on components
 *
 * @param {Object} bomJson BOM JSON Object
 * @param {Object} options CLI options
 *
 * @returns {Object} Filtered BOM JSON
 */
export function applyMetadata(bomJson, options) {
  if (!bomJson?.components) {
    return bomJson;
  }
  const bomPkgTypes = new Set();
  const bomPkgNamespaces = new Set();
  const bomSrcFiles = new Set();
  for (const comp of bomJson.components) {
    if (comp.purl) {
      try {
        const purlObj = PackageURL.fromString(comp.purl);
        if (purlObj?.type) {
          bomPkgTypes.add(purlObj.type);
        }
        if (purlObj?.namespace) {
          bomPkgNamespaces.add(purlObj.namespace);
        }
      } catch (_e) {
        // ignore
      }
    }
    if (comp.properties) {
      for (const aprop of comp.properties) {
        if (aprop.name === "SrcFile" && aprop.value) {
          const rdir = relativeDir(aprop.value, options);
          if (comp.type !== "file") {
            bomSrcFiles.add(rdir);
          }
          // Fix the filename to use relative directory
          if (rdir !== aprop.value) {
            aprop.value = rdir;
          }
        }
      }
    }
    if (comp?.evidence?.identity && Array.isArray(comp.evidence.identity)) {
      for (const aidentityEvidence of comp.evidence.identity) {
        if (aidentityEvidence.concludedValue) {
          const rdir = relativeDir(aidentityEvidence.concludedValue, options);
          if (comp.type !== "file") {
            bomSrcFiles.add(rdir);
          }
          if (rdir !== aidentityEvidence.concludedValue) {
            aidentityEvidence.concludedValue = rdir;
          }
        }
        if (
          aidentityEvidence.methods &&
          Array.isArray(aidentityEvidence.methods)
        ) {
          for (const amethod of aidentityEvidence.methods) {
            const rdir = relativeDir(amethod.value, options);
            if (
              comp.type !== "file" &&
              ["manifest-analysis"].includes(amethod.technique) &&
              amethod.value
            ) {
              bomSrcFiles.add(rdir);
            }
            // Fix the filename to use relative directory
            if (rdir !== amethod.value) {
              amethod.value = rdir;
            }
          }
        }
      }
    }
  }
  if (!bomJson.metadata.properties) {
    bomJson.metadata.properties = [];
  }
  if (bomPkgTypes.size) {
    const componentTypesArray = Array.from(bomPkgTypes).sort();
    // Check if cdx:bom:componentTypes property already exists
    const existingTypesProperty = bomJson.metadata.properties.find(
      (p) => p.name === "cdx:bom:componentTypes",
    );
    if (!existingTypesProperty) {
      bomJson.metadata.properties.push({
        name: "cdx:bom:componentTypes",
        value: componentTypesArray.join("\\n"),
      });
    }
    if (componentTypesArray.length > 1) {
      thoughtLog(
        `BOM includes the ${componentTypesArray.length} component types: ${componentTypesArray.join(", ")}`,
      );
    }
  }
  if (bomPkgNamespaces.size) {
    // Check if cdx:bom:componentNamespaces property already exists
    const existingNamespacesProperty = bomJson.metadata.properties.find(
      (p) => p.name === "cdx:bom:componentNamespaces",
    );
    if (!existingNamespacesProperty) {
      bomJson.metadata.properties.push({
        name: "cdx:bom:componentNamespaces",
        value: Array.from(bomPkgNamespaces).sort().join("\\n"),
      });
    }
  }
  if (bomSrcFiles.size) {
    const bomSrcFilesArray = Array.from(bomSrcFiles).sort();
    // Check if cdx:bom:componentSrcFiles property already exists
    const existingSrcFilesProperty = bomJson.metadata.properties.find(
      (p) => p.name === "cdx:bom:componentSrcFiles",
    );
    if (!existingSrcFilesProperty) {
      bomJson.metadata.properties.push({
        name: "cdx:bom:componentSrcFiles",
        value: bomSrcFilesArray.join("\\n"),
      });
    }
    if (bomSrcFilesArray.length > 1 && bomSrcFilesArray.length < 5) {
      thoughtLog(
        `BOM includes information from ${bomSrcFilesArray.length} manifest files: ${bomSrcFilesArray.join(", ")}`,
      );
    }
  } else {
    if (!bomPkgTypes.has("oci")) {
      thoughtLog("BOM lacks package manifest details. Please help us improve!");
    }
  }
  return bomJson;
}

/**
 * Apply definitions.standards based on options
 *
 * @param {Object} bomJson BOM JSON Object
 * @param {Object} options CLI options
 *
 * @returns {Object} Filtered BOM JSON
 */
export function applyStandards(bomJson, options) {
  if (options.standard && Array.isArray(options.standard)) {
    for (let astandard of options.standard) {
      // See issue: #1953
      if (astandard.includes(sep)) {
        astandard = basename(astandard);
      }
      const templateFile = join(
        dirNameStr,
        "data",
        "templates",
        `${astandard}.cdx.json`,
      );
      if (safeExistsSync(templateFile)) {
        const templateData = JSON.parse(readFileSync(templateFile, "utf-8"));
        if (templateData?.metadata?.licenses) {
          if (!bomJson.metadata.licenses) {
            bomJson.metadata.licenses = [];
          }
          bomJson.metadata.licenses = bomJson.metadata.licenses.concat(
            templateData.metadata.licenses,
          );
        }
        if (templateData?.definitions?.standards) {
          if (!bomJson.definitions) {
            bomJson.definitions = { standards: [] };
          }
          bomJson.definitions.standards = bomJson.definitions.standards.concat(
            templateData.definitions.standards,
          );
        }
      }
    }
  }
  return bomJson;
}

/**
 * Method to normalize the identity field from a component's evidence block.
 *
 * In different versions of CycloneDX, the `identity` field can be either a single object or an array of objects.
 * This function ensures that the result is always an array for consistent processing.
 *
 * @param {Object} comp - The component object potentially containing evidence.identity.
 * @returns {Array} An array of identity objects (empty if none are present).
 */
function normalizeIdentities(comp) {
  const identity = comp?.evidence?.identity;
  if (Array.isArray(identity)) {
    return identity;
  }
  if (identity) {
    return [identity];
  }
  return [];
}

/**
 * Method to get the purl identity confidence.
 *
 * @param comp Component
 * @returns {undefined|number} Max of all the available purl identity confidence or undefined
 */
function getIdentityConfidence(comp) {
  if (!comp.evidence) {
    return undefined;
  }
  let confidence;
  for (const aidentity of normalizeIdentities(comp)) {
    if (aidentity?.field === "purl") {
      if (confidence === undefined) {
        confidence = aidentity.confidence || 0;
      } else {
        confidence = Math.max(aidentity.confidence, confidence);
      }
    }
  }
  return confidence;
}

/**
 * Method to get the list of techniques used for identity.
 *
 * @param comp Component
 * @returns {Set|undefined} Set of technique. evidence.identity.methods.technique
 */
function getIdentityTechniques(comp) {
  if (!comp.evidence) {
    return undefined;
  }
  const techniques = new Set();
  for (const aidentity of normalizeIdentities(comp)) {
    if (aidentity?.field === "purl") {
      for (const amethod of aidentity.methods || []) {
        techniques.add(amethod?.technique);
      }
    }
  }
  return techniques;
}

/**
 * Filter BOM based on options
 *
 * @param {Object} bomJson BOM JSON Object
 * @param {Object} options CLI options
 *
 * @returns {Object} Filtered BOM JSON
 */
export function filterBom(bomJson, options) {
  const newPkgMap = {};
  let filtered = false;
  let anyFiltered = false;
  if (!bomJson?.components) {
    return bomJson;
  }
  for (const comp of bomJson.components) {
    // minimum confidence filter
    if (options?.minConfidence > 0) {
      const confidence = Math.min(options.minConfidence, 1);
      const identityConfidence = getIdentityConfidence(comp);
      if (identityConfidence !== undefined && identityConfidence < confidence) {
        filtered = true;
        continue;
      }
    }
    // identity technique filter
    if (options?.technique?.length && !options.technique.includes("auto")) {
      const allowedTechniques = new Set(
        Array.isArray(options.technique)
          ? options.technique
          : [options.technique],
      );
      const usedTechniques = getIdentityTechniques(comp);
      // Set.intersection is only available in node >= 22. See Bug# 1651
      if (
        usedTechniques &&
        ![...usedTechniques].some((i) => allowedTechniques.has(i))
      ) {
        filtered = true;
        continue;
      }
    }
    if (
      options.requiredOnly &&
      comp.scope &&
      ["optional", "excluded"].includes(comp.scope)
    ) {
      filtered = true;
    } else if (options.only?.length) {
      if (!Array.isArray(options.only)) {
        options.only = [options.only];
      }
      // See issue: #1962
      let purlfiltered = true;
      for (const filterstr of options.only) {
        if (
          filterstr.length &&
          comp.purl.toLowerCase().includes(filterstr.toLowerCase())
        ) {
          filtered = true;
          purlfiltered = false;
          break;
        }
      }
      if (!purlfiltered) {
        newPkgMap[comp["bom-ref"]] = comp;
      }
    } else if (options.filter?.length) {
      if (!Array.isArray(options.filter)) {
        options.filter = [options.filter];
      }
      let purlfiltered = false;
      for (const filterstr of options.filter) {
        // Check the purl
        if (
          filterstr.length &&
          comp.purl.toLowerCase().includes(filterstr.toLowerCase())
        ) {
          filtered = true;
          purlfiltered = true;
          continue;
        }
        // Look for any properties value matching the string
        const properties = comp.properties || [];
        for (const aprop of properties) {
          if (
            filterstr.length &&
            aprop?.value?.toLowerCase().includes(filterstr.toLowerCase())
          ) {
            filtered = true;
            purlfiltered = true;
          }
        }
      }
      if (!purlfiltered) {
        newPkgMap[comp["bom-ref"]] = comp;
      }
    } else {
      newPkgMap[comp["bom-ref"]] = comp;
    }
  }
  if (filtered) {
    if (!anyFiltered) {
      anyFiltered = true;
    }
    const newcomponents = [];
    const newdependencies = [];
    for (const aref of Object.keys(newPkgMap).sort()) {
      newcomponents.push(newPkgMap[aref]);
    }
    if (bomJson.metadata?.component?.["bom-ref"]) {
      newPkgMap[bomJson.metadata.component["bom-ref"]] =
        bomJson.metadata.component;
    }
    if (bomJson.metadata?.component?.components) {
      for (const comp of bomJson.metadata.component.components) {
        newPkgMap[comp["bom-ref"]] = comp;
      }
    }
    for (const adep of bomJson.dependencies) {
      if (newPkgMap[adep.ref]) {
        const newdepson = (adep.dependsOn || []).filter((d) => newPkgMap[d]);
        const obj = {
          ref: adep.ref,
          dependsOn: newdepson,
        };
        // Filter provides array if needed
        if (adep.provides?.length) {
          obj.provides = adep.provides.filter((d) => newPkgMap[d]);
        }
        newdependencies.push(obj);
      }
    }
    bomJson.components = newcomponents;
    bomJson.dependencies = newdependencies;
    // We set the compositions.aggregate to incomplete by default
    if (
      options.specVersion >= 1.5 &&
      options.autoCompositions &&
      bomJson.metadata?.component
    ) {
      if (!bomJson.compositions) {
        bomJson.compositions = [];
      }
      bomJson.compositions.push({
        "bom-ref": bomJson.metadata.component["bom-ref"],
        aggregate: options.only ? "incomplete_first_party_only" : "incomplete",
      });
    }
  }
  if (!anyFiltered && DEBUG_MODE) {
    if (
      options.requiredOnly &&
      !options.deep &&
      hasAnyProjectType(["python"], options, false)
    ) {
      console.log(
        "TIP: Try running cdxgen with --deep argument to identify component usages with atom.",
      );
    } else if (
      options.requiredOnly &&
      options.noBabel &&
      hasAnyProjectType(["js"], options, false)
    ) {
      console.log(
        "Enable babel by removing the --no-babel argument to improve usage detection.",
      );
    }
  }
  return bomJson;
}

/**
 * Clean up
 */
export function cleanupEnv(_options) {
  if (process.env?.PIP_TARGET?.startsWith(getTmpDir())) {
    rmSync(process.env.PIP_TARGET, { recursive: true, force: true });
  }
}

/**
 * Removes the cdxgen temporary directory if it was created inside the system
 * temp directory (as indicated by `CDXGEN_TMP_DIR`). No-ops when the variable
 * is unset or points outside the system temp directory.
 *
 * @returns {void}
 */
export function cleanupTmpDir() {
  if (process.env?.CDXGEN_TMP_DIR?.startsWith(getTmpDir())) {
    rmSync(process.env.CDXGEN_TMP_DIR, { recursive: true, force: true });
  }
}

function stripBomLink(serialNumber, version, ref) {
  return ref.replace(`${serialNumber}/${version - 1}/`, "");
}

/**
 * Annotate the document with annotator
 *
 * @param {Object} bomJson BOM JSON Object
 * @param {Object} options CLI options
 *
 * @returns {Object} Annotated BOM JSON
 */
export function annotate(bomJson, options) {
  if (!bomJson?.components) {
    return bomJson;
  }
  const bomAnnotations = bomJson?.annotations || [];
  const cdxgenAnnotator = bomJson.metadata.tools.components.filter(
    (c) => c.name === "cdxgen",
  );
  if (!cdxgenAnnotator.length) {
    return bomJson;
  }
  const { bomType } = findBomType(bomJson);
  const requiresContextTuning = [
    "deep-learning",
    "machine-learning",
    "ml",
    "ml-deep",
    "ml-tiny",
  ].includes(options?.profile);
  const requiresContextTrimming =
    (requiresContextTuning && ["saasbom"].includes(bomType.toLowerCase())) ||
    ["ml-tiny"].includes(options?.profile);
  // Construct the bom-link prefix to use for context tuning
  const bomLinkPrefix = `${bomJson.serialNumber}/${bomJson.version}/`;
  const metadataAnnotations = textualMetadata(bomJson);
  let parentBomRef;
  if (bomJson.metadata?.component?.["bom-ref"]) {
    if (requiresContextTuning) {
      bomJson.metadata.component["bom-ref"] =
        `${bomLinkPrefix}${stripBomLink(bomJson.serialNumber, bomJson.version, bomJson.metadata.component["bom-ref"])}`;
    }
    parentBomRef = bomJson.metadata.component["bom-ref"];
  }
  if (metadataAnnotations) {
    bomAnnotations.push({
      "bom-ref": "metadata-annotations",
      subjects: parentBomRef ? [parentBomRef] : [bomJson.serialNumber],
      annotator: {
        component: cdxgenAnnotator[0],
      },
      timestamp: getTimestamp(),
      text: metadataAnnotations,
    });
  }
  bomJson.annotations = bomAnnotations;
  // Shall we trim the metadata section
  if (requiresContextTrimming) {
    if (bomJson?.metadata?.component?.components) {
      bomJson.metadata.component.components = undefined;
    }
    if (bomJson?.metadata?.component?.["bom-ref"]) {
      bomJson.metadata.component["bom-ref"] = undefined;
    }
    if (bomJson?.metadata?.component?.properties) {
      bomJson.metadata.component.properties = undefined;
    }
    if (bomJson?.metadata?.properties) {
      bomJson.metadata.properties = undefined;
    }
  }
  // Tag the components
  for (const comp of bomJson.components) {
    const tags = extractTags(comp, bomType, bomJson.metadata?.component?.type);
    if (tags?.length) {
      comp.tags = tags;
    }
    if (requiresContextTuning) {
      comp["bom-ref"] =
        `${bomLinkPrefix}${stripBomLink(bomJson.serialNumber, bomJson.version, comp["bom-ref"])}`;
      comp.description = undefined;
      comp.properties = undefined;
      comp.evidence = undefined;
    }
    if (requiresContextTrimming) {
      comp.authors = undefined;
      comp.supplier = undefined;
      comp.publisher = undefined;
      comp["bom-ref"] = undefined;
      comp.externalReferences = undefined;
      comp.description = undefined;
      comp.properties = undefined;
      comp.evidence = undefined;
      // We will lose information about nested components, such as the files in case of poetry.lock
      comp.components = undefined;
    }
  }
  // For tiny models, we can remove the dependencies section
  if (requiresContextTrimming) {
    bomJson.dependencies = undefined;
    if (bomType.toLowerCase() === "saasbom") {
      bomJson.components = undefined;
      let i = 0;
      for (const aserv of bomJson.services) {
        aserv.name = `service-${i++}`;
      }
    }
  }
  // Problem: information such as the dependency tree are specific to an sbom
  // To prevent the models from incorrectly learning about the trees, we automatically convert all bom-ref
  // references to [bom-link](https://cyclonedx.org/capabilities/bomlink/) format
  if (requiresContextTuning && bomJson?.dependencies?.length) {
    const newDeps = [];
    for (const dep of bomJson.dependencies) {
      const newRef = `${bomLinkPrefix}${stripBomLink(bomJson.serialNumber, bomJson.version, dep.ref)}`;
      const newDependsOn = [];
      for (const adon of dep.dependsOn) {
        newDependsOn.push(
          `${bomLinkPrefix}${stripBomLink(bomJson.serialNumber, bomJson.version, adon)}`,
        );
      }
      newDeps.push({
        ref: newRef,
        dependsOn: newDependsOn.sort(),
      });
    }
    // Overwrite the dependencies
    bomJson.dependencies = newDeps;
  }
  return bomJson;
}
