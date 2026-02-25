import { readFileSync } from "node:fs";
import { join } from "node:path";

import Ajv from "ajv";
import addFormats from "ajv-formats";
import { PackageURL } from "packageurl-js";

import { thoughtLog } from "./logger.js";
import { DEBUG_MODE, dirNameStr, isPartialTree } from "./utils.js";

const dirName = dirNameStr;

/**
 * Validate the generated bom using jsonschema
 *
 * @param {object} bomJson content
 *
 * @returns {Boolean} true if the BOM is valid. false otherwise.
 */
export const validateBom = (bomJson) => {
  if (!bomJson) {
    return true;
  }
  const specVersion = bomJson.specVersion;
  const schema = JSON.parse(
    readFileSync(
      join(dirName, "data", `bom-${specVersion}.schema.json`),
      "utf-8",
    ),
  );
  const defsSchema = JSON.parse(
    readFileSync(join(dirName, "data", "jsf-0.82.schema.json"), "utf-8"),
  );
  const spdxSchema = JSON.parse(
    readFileSync(join(dirName, "data", "spdx.schema.json"), "utf-8"),
  );
  const cryptoDefSchema = JSON.parse(
    readFileSync(
      join(dirName, "data", "cryptography-defs.schema.json"),
      "utf-8",
    ),
  );
  const schemas = [schema, defsSchema, spdxSchema];
  if (specVersion >= 1.7) {
    schemas.push(cryptoDefSchema);
  }
  const ajv = new Ajv({
    schemas,
    strict: false,
    logger: false,
    verbose: true,
    code: {
      source: true,
      lines: true,
      optimize: true,
    },
  });
  addFormats(ajv);
  const validate = ajv.getSchema(
    `http://cyclonedx.org/schema/bom-${specVersion}.schema.json`,
  );
  const isValid = validate(bomJson);
  if (!isValid) {
    console.log(
      `Schema validation failed for ${bomJson.metadata.component.name}`,
    );
    console.log(validate.errors);
    return false;
  }
  // Deep validation tests
  return (
    validateMetadata(bomJson) &&
    validatePurls(bomJson) &&
    validateRefs(bomJson) &&
    validateProps(bomJson)
  );
};

/**
 * Validate the metadata object
 *
 * @param {object} bomJson Bom json object
 */
export const validateMetadata = (bomJson) => {
  const errorList = [];
  const warningsList = [];
  if (bomJson?.metadata) {
    if (
      !bomJson.metadata.component ||
      !Object.keys(bomJson.metadata.component).length
    ) {
      warningsList.push(
        "metadata.component is missing. Run cdxgen with both --project-name and --project-version argument.",
      );
    }
    if (bomJson.metadata.component) {
      // Do we have a purl and bom-ref for metadata.component
      if (!bomJson.metadata.component.purl) {
        warningsList.push("purl is missing for metadata.component");
      }
      if (!bomJson.metadata.component["bom-ref"]) {
        warningsList.push("bom-ref is missing for metadata.component");
      }
      // Do we have a version for metadata.component
      if (!bomJson.metadata.component.version) {
        warningsList.push(
          "Version is missing for metadata.component. Pass the version using --project-version argument.",
        );
      }
      // Is the same component getting repeated inside the components block
      if (bomJson.metadata.component.components?.length) {
        for (const comp of bomJson.metadata.component.components) {
          if (comp["bom-ref"] === bomJson.metadata.component["bom-ref"]) {
            warningsList.push(
              `Found parent component with ref ${comp["bom-ref"]} in metadata.component.components`,
            );
          } else if (
            (!comp["bom-ref"] || !bomJson.metadata.component["bom-ref"]) &&
            comp["name"] === bomJson.metadata.component["name"]
          ) {
            warningsList.push(
              `Found parent component with name ${comp["name"]} in metadata.component.components`,
            );
          }
        }
      }
    }
  }
  if (DEBUG_MODE && warningsList.length !== 0) {
    console.log("===== WARNINGS =====");
    console.log(warningsList);
    thoughtLog(
      "**VALIDATION**: There are some warnings regarding the BOM Metadata.",
    );
  }
  if (errorList.length !== 0) {
    console.log(errorList);
    return false;
  }
  return true;
};

/**
 * Validate the format of all purls
 *
 * @param {object} bomJson Bom json object
 */
export const validatePurls = (bomJson) => {
  const errorList = [];
  const warningsList = [];
  let frameworksCount = 0;
  if (bomJson?.components) {
    for (const comp of bomJson.components) {
      if (comp.type === "framework") {
        frameworksCount += 1;
      }
      if (comp.type === "cryptographic-asset") {
        if (comp.purl?.length) {
          errorList.push(
            `purl should not be defined for cryptographic-asset ${comp.purl}`,
          );
        }
        if (!comp.cryptoProperties) {
          errorList.push(
            `cryptoProperties is missing for cryptographic-asset ${comp.purl}`,
          );
        } else if (
          comp.cryptoProperties.assetType === "algorithm" &&
          !comp.cryptoProperties.oid
        ) {
          errorList.push(
            `cryptoProperties.oid is missing for cryptographic-asset of type algorithm ${comp.purl}`,
          );
        } else if (
          comp.cryptoProperties.assetType === "certificate" &&
          !comp.cryptoProperties.algorithmProperties
        ) {
          errorList.push(
            `cryptoProperties.algorithmProperties is missing for cryptographic-asset of type certificate ${comp.purl}`,
          );
        }
      } else {
        try {
          const purlObj = PackageURL.fromString(comp.purl);
          if (purlObj.type && purlObj.type !== purlObj.type.toLowerCase()) {
            warningsList.push(
              `purl type is not normalized to lower case ${comp.purl}`,
            );
          }
          if (
            ["npm", "golang"].includes(purlObj.type) &&
            purlObj.name.includes("%2F") &&
            !purlObj.namespace
          ) {
            errorList.push(
              `purl does not include namespace but includes encoded slash in name for npm type. ${comp.purl}`,
            );
          }
          // Catch the trivy version hack that removes the epoch from version
          const qualifiers = purlObj.qualifiers || {};
          if (
            Object.keys(qualifiers).length &&
            [
              "cargo",
              "cocoapods",
              "composer",
              "cran",
              "github",
              "golang",
              "hackage",
              "nuget",
              "opam",
              "pub",
              "qpkg",
              "swift",
            ].includes(purlObj.type)
          ) {
            warningsList.push(
              `Qualifiers are usually not expected for the PURL type: ${purlObj.type}. Qualifiers: ${Object.keys(qualifiers).join(", ")}.`,
            );
          }
          if (
            qualifiers.epoch &&
            !comp.version.startsWith(`${qualifiers.epoch}:`)
          ) {
            errorList.push(
              `'${comp.name}' version '${comp.version}' doesn't include epoch '${qualifiers.epoch}'.`,
            );
          }
        } catch (_ex) {
          errorList.push(`Invalid purl ${comp.purl}`);
        }
      }
    }
  }
  if (frameworksCount > 20) {
    warningsList.push(
      `BOM likey has too many framework components. Count: ${frameworksCount}`,
    );
  }
  if (DEBUG_MODE && warningsList.length !== 0) {
    console.log("===== WARNINGS =====");
    console.log(warningsList);
    thoughtLog(
      "**VALIDATION**: There are some warnings regarding the purls in our SBOM. These could be bugs.",
    );
  }
  if (errorList.length !== 0) {
    console.log(errorList);
    return false;
  }
  return true;
};

const buildRefs = (bomJson) => {
  const refMap = {};
  if (bomJson) {
    if (bomJson.metadata) {
      if (bomJson.metadata.component) {
        refMap[bomJson.metadata.component["bom-ref"]] = true;
        if (bomJson.metadata.component.components) {
          for (const comp of bomJson.metadata.component.components) {
            refMap[comp["bom-ref"]] = true;
          }
        }
      }
    }
    if (bomJson.components) {
      for (const comp of bomJson.components) {
        refMap[comp["bom-ref"]] = true;
      }
    }
  }
  return refMap;
};

/**
 * Validate the refs in dependencies block
 *
 * @param {object} bomJson Bom json object
 */
export const validateRefs = (bomJson) => {
  const errorList = [];
  const warningsList = [];
  const refMap = buildRefs(bomJson);
  const parentComponentRef = bomJson?.metadata?.component?.["bom-ref"];
  if (bomJson?.dependencies) {
    if (isPartialTree(bomJson.dependencies, bomJson?.components?.length)) {
      warningsList.push(
        "Dependency tree has multiple empty dependsOn attributes.",
      );
    }
    for (const dep of bomJson.dependencies) {
      if (
        dep.ref.includes("%40") ||
        dep.ref.includes("%3A") ||
        dep.ref.includes("%2F")
      ) {
        errorList.push(`Invalid encoded ref in dependencies ${dep.ref}`);
      }
      if (!refMap[dep.ref]) {
        warningsList.push(`Invalid ref in dependencies ${dep.ref}`);
      }
      let parentPurlType;
      try {
        const purlObj = PackageURL.fromString(dep.ref);
        parentPurlType = purlObj.type;
      } catch (_e) {
        // pass
      }
      if (
        parentComponentRef &&
        dep.ref === parentComponentRef &&
        dep.dependsOn.length === 0 &&
        bomJson.dependencies.length > 1
      ) {
        warningsList.push(
          `Parent component ${parentComponentRef} doesn't have any children. The dependency tree must contain dangling nodes, which are unsupported by tools such as Dependency-Track.`,
        );
      }
      if (dep.dependsOn) {
        for (const don of dep.dependsOn) {
          if (!refMap[don]) {
            warningsList.push(
              `Invalid ref in dependencies.dependsOn ${don}. Parent: ${dep.ref}`,
            );
          }
          let childPurlType;
          try {
            const purlObj = PackageURL.fromString(don);
            childPurlType = purlObj.type;
          } catch (_e) {
            // pass
          }
          if (
            parentPurlType &&
            childPurlType &&
            parentPurlType !== childPurlType &&
            !["oci", "generic", "container"].includes(parentPurlType)
          ) {
            warningsList.push(
              `The parent package '${dep.ref}' (type ${parentPurlType}) depends on the child package '${don}' (type ${childPurlType}). This is a bug in cdxgen if this project is not a monorepo.`,
            );
          }
        }
      }
      if (dep.provides) {
        for (const don of dep.provides) {
          if (!refMap[don]) {
            warningsList.push(`Invalid ref in dependencies.provides ${don}`);
          }
        }
      }
    }
  }
  if (DEBUG_MODE && warningsList.length !== 0) {
    console.log("===== WARNINGS =====");
    console.log(warningsList);
    thoughtLog(
      "**VALIDATION**: There are some warnings regarding the dependency tree in our BOM.",
    );
  }
  if (errorList.length !== 0) {
    console.log(errorList);
    return false;
  }
  return true;
};

/**
 * Validate the component properties
 *
 * @param {object} bomJson Bom json object
 */
export function validateProps(bomJson) {
  const errorList = [];
  const warningsList = [];
  let isWorkspaceMode = false;
  let lacksProperties = false;
  let lacksEvidence = false;
  let lacksRelativePath = false;
  if (
    !["application", "framework", "library"].includes(
      bomJson?.metadata?.component?.type,
    )
  ) {
    return true;
  }
  if (bomJson?.components) {
    for (const comp of bomJson.components) {
      if (!["library", "framework"].includes(comp.type)) {
        continue;
      }
      // Limit to only npm and pypi for now
      if (
        !comp.purl?.startsWith("pkg:npm") &&
        !comp.purl?.startsWith("pkg:pypi")
      ) {
        continue;
      }
      if (!comp.properties) {
        if (!lacksProperties) {
          warningsList.push(`${comp["bom-ref"]} lacks properties.`);
          lacksProperties = true;
        }
      } else {
        let srcFilePropFound = false;
        let workspacePropFound = false;
        for (const p of comp.properties) {
          if (p.name === "SrcFile") {
            srcFilePropFound = true;
            // Quick linux/unix only check for relative paths.
            if (!lacksRelativePath && p.value?.startsWith("/")) {
              lacksRelativePath = true;
            }
          }
          if (p.name === "internal:workspaceRef") {
            isWorkspaceMode = true;
            workspacePropFound = true;
          }
        }
        if (
          isWorkspaceMode &&
          !workspacePropFound &&
          !srcFilePropFound &&
          comp?.scope !== "optional"
        ) {
          warningsList.push(
            `${comp["bom-ref"]} lacks workspace-related properties.`,
          );
        }
        if (!srcFilePropFound && !lacksProperties) {
          warningsList.push(`${comp["bom-ref"]} lacks SrcFile property.`);
          lacksProperties = true;
        }
      }
      if (!comp.evidence && !lacksEvidence) {
        lacksEvidence = true;
        warningsList.push(`${comp["bom-ref"]} lacks evidence.`);
      }
    }
  }
  if (lacksRelativePath) {
    warningsList.push(
      "BOM includes absolute paths for properties like SrcFile.",
    );
    thoughtLog(
      "BOM still includes absolute paths for properties like SrcFile. My postgen optimizations didn't work completely.",
    );
  }
  if (DEBUG_MODE && warningsList.length !== 0) {
    console.log("===== WARNINGS =====");
    console.log(warningsList);
    thoughtLog(
      "**VALIDATION**: There are some warnings regarding the evidence attribute in our BOM, which can be safely ignored.",
    );
  }
  if (errorList.length !== 0) {
    console.log(errorList);
    return false;
  }
  return true;
}
