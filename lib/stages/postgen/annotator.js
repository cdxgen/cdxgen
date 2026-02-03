import { readFileSync } from "node:fs";
import { join } from "node:path";

import { thoughtLog } from "../../helpers/logger.js";
import { dirNameStr } from "../../helpers/utils.js";

// Tags per BOM type.
const componentTags = JSON.parse(
  readFileSync(join(dirNameStr, "data", "component-tags.json"), "utf-8"),
);

function humanifyTimestamp(timestamp) {
  const dateObj = new Date(Date.parse(timestamp));
  return dateObj.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  });
}

function toArticle(s) {
  return /^[aeiou]/i.test(s) ? "an" : "a";
}

function joinArray(arr) {
  if (!Array.isArray(arr)) {
    return arr;
  }
  if (arr.length <= 1) {
    return arr.join(", ");
  }
  const last = arr.pop();
  return `${arr.join(", ")}${arr.length > 1 ? "," : ""} and ${last}`;
}

function cleanNames(s) {
  return s?.replace(/[+]/g, " ");
}

function cleanTypes(s) {
  return s?.replace(/[+-_]/g, " ");
}

/**
 * Method to determine the type of the BOM.
 *
 * @param {Object} bomJson BOM JSON Object
 *
 * @returns {String} Type of the bom such as sbom, cbom, obom, ml-bom etc
 */
export function findBomType(bomJson) {
  let description = "Software Bill-of-Materials (SBOM)";
  let bomType = "SBOM";
  const metadata = bomJson.metadata;
  const lifecycles = metadata?.lifecycles || [];
  const cryptoAssetsCount = bomJson?.components?.filter(
    (c) => c.type === "cryptographic-asset",
  ).length;
  const dataCount = bomJson?.components?.filter(
    (c) =>
      c?.data?.length > 0 ||
      (c.modelCard && Object.keys(c?.modelCard).length > 0),
  ).length;
  // Is this an OBOM?
  if (lifecycles.filter((l) => l.phase === "operations").length > 0) {
    bomType = "OBOM";
    description = "Operations Bill-of-Materials (OBOM)";
  } else if (cryptoAssetsCount > 0) {
    bomType = "CBOM";
    description = "Cryptography Bill-of-Materials (CBOM)";
  } else if (dataCount > 0) {
    bomType = "ML-BOM";
    description = "Machine-Learning Bill-of-Materials (ML-BOM)";
  } else if (bomJson?.services?.length > 0) {
    bomType = "SaaSBOM";
    description = "Software-as-a-Service BOM (SaaSBOM)";
  } else if (bomJson.declarations?.attestations?.length > 0) {
    bomType = "CDXA";
    description = "CycloneDX Attestations (CDXA)";
  }
  return {
    bomType,
    bomTypeDescription: description,
  };
}

/**
 * Create the textual representation of the metadata section.
 *
 * @param {Object} bomJson BOM JSON Object
 *
 * @returns {String | undefined} Textual representation of the metadata
 */
export function textualMetadata(bomJson) {
  if (!bomJson?.metadata) {
    return undefined;
  }
  let text = "";
  const { bomType, bomTypeDescription } = findBomType(bomJson);
  const metadata = bomJson.metadata;
  const lifecycles = metadata?.lifecycles || [];
  const tlpClassification = metadata.distribution;
  const cryptoAssetsCount = bomJson?.components?.filter(
    (c) => c.type === "cryptographic-asset",
  ).length;
  const vsixCount = bomJson?.components?.filter((c) =>
    c?.purl?.startsWith("pkg:vsix"),
  ).length;
  const swidCount = bomJson?.components?.filter((c) =>
    c?.purl?.startsWith("pkg:swid"),
  ).length;
  if (metadata?.timestamp) {
    text = `This ${bomTypeDescription} document was created on ${humanifyTimestamp(metadata.timestamp)}`;
  }
  if (metadata?.tools) {
    const tools = metadata.tools.components;
    // Only components would be supported. If you need support for services, send a PR!
    if (tools && Array.isArray(tools)) {
      if (tools.length === 1) {
        text = `${text} with ${tools[0].name}.`;
      } else {
        text = `${text}. The xBOM tools used are: ${joinArray(tools.map((t) => t.name))}.`;
      }
    }
  }
  if (tlpClassification) {
    text = `${text} The Traffic Light Protocol (TLP) classification for this document is '${tlpClassification}'.`;
  }
  if (lifecycles && Array.isArray(lifecycles)) {
    if (lifecycles.length === 1) {
      const thePhase = lifecycles[0].phase;
      if (thePhase === "pre-build") {
        text = `${text} The data was captured during the ${thePhase} lifecycle phase without building the application.`;
      } else {
        text = `${text} The data was captured during the ${thePhase} lifecycle phase.`;
      }
    } else {
      text = `${text} The lifecycles phases represented are: ${joinArray(lifecycles.map((l) => l.phase))}.`;
    }
  }
  if (metadata?.component) {
    const parentVersion = metadata.component.version;
    const cleanTypeName = cleanTypes(metadata.component.type);
    if (
      parentVersion &&
      !["", "unspecified", "latest", "master", "main"].includes(parentVersion)
    ) {
      let versionType = "version";
      if (parentVersion.includes(" ") || parentVersion.includes("(")) {
        versionType = "the build name";
      } else if (
        parentVersion.toLowerCase().includes("dev") ||
        parentVersion.toLowerCase().includes("snapshot")
      ) {
        versionType = "the dev version";
      } else if (
        parentVersion.toLowerCase().includes("release") ||
        parentVersion.toLowerCase().includes("final")
      ) {
        versionType = "the release version";
      }
      text = `${text} The document describes ${toArticle(metadata.component.type)} ${cleanTypeName} named '${cleanNames(metadata.component.name)}' with ${versionType} '${parentVersion}'.`;
    } else {
      text = `${text} The document describes ${toArticle(metadata.component.type)} ${cleanTypeName} named '${cleanNames(metadata.component.name)}'.`;
    }
    if (cryptoAssetsCount) {
      text = `${text} There are ${cryptoAssetsCount} cryptographic assets listed under components in this ${bomType}.`;
    }
    if (
      metadata?.component.components &&
      Array.isArray(metadata.component?.components)
    ) {
      text = `${text} The ${cleanTypeName} also has ${metadata.component.components.length} child modules/components.`;
    }
  }
  let metadataProperties = metadata.properties || [];
  if (
    metadata?.component?.properties &&
    Array.isArray(metadata.component.properties)
  ) {
    metadataProperties = metadataProperties.concat(
      metadata.component.properties,
    );
  }
  let bomPkgTypes = [];
  let bomPkgNamespaces = [];
  let componentSrcFiles = [];
  let imageRepoTag;
  let imageArch;
  let imageOs;
  let imageComponentTypes;
  let osBuildVersion;
  const bundledSdks = [];
  let appLanguage;
  for (const aprop of metadataProperties) {
    switch (aprop.name) {
      case "cdx:bom:componentTypes":
        bomPkgTypes = aprop?.value.split("\\n");
        break;
      case "cdx:bom:componentNamespaces":
        bomPkgNamespaces = aprop?.value.split("\\n");
        break;
      case "cdx:bom:componentSrcFiles":
        componentSrcFiles = aprop?.value.split("\\n");
        break;
      case "oci:image:RepoTag":
        imageRepoTag = aprop.value;
        break;
      case "arch":
      case "oci:image:Architecture":
        imageArch = aprop.value;
        break;
      case "oci:image:Os":
        imageOs = aprop.value;
        break;
      case "oci:image:componentTypes":
        imageComponentTypes = aprop.value.split("\\n");
        break;
      case "build_version":
        osBuildVersion = aprop.value;
        break;
      case "oci:image:bundles:AndroidSdk":
      case "oci:image:bundles:Sdkman":
      case "oci:image:bundles:Nvm":
      case "oci:image:bundles:Rbenv":
      case "oci:image:bundles:DotnetSdk":
        bundledSdks.push(
          aprop.name.split(":").pop().replace(/Sdk$/, "").toLowerCase(),
        );
        break;
      case "oci:image:appLanguage":
        appLanguage = aprop.value;
        break;
      default:
        break;
    }
  }
  if (bomJson?.components?.length) {
    text = `${text} There are ${bomJson.components.length} components.`;
  } else {
    text = `${text} BOM file is empty without components.`;
    thoughtLog(
      "It looks like I didn't find any components, so the BOM is empty.",
    );
    if (bomJson?.dependencies?.length) {
      thoughtLog(
        `There are ${bomJson.dependencies.length} dependencies and no components; this is confusing 😵‍💫.`,
      );
    } else if (
      metadata?.component?.components &&
      Array.isArray(metadata.component?.components) &&
      metadata?.component.components.length > 1
    ) {
      thoughtLog(
        `I did find ${metadata.component.components.length} child modules, so I'm confident things will work with some troubleshooting.`,
      );
    }
  }
  if (appLanguage) {
    text = `${text} This container image is for a ${appLanguage} application.`;
  }
  if (imageOs && imageArch && imageRepoTag) {
    text = `${text} The ${imageOs} image uses the ${imageArch} architecture and has the registry tag ${imageRepoTag}.`;
  }
  if (imageArch && osBuildVersion) {
    text = `${text} The OS uses the ${imageArch} architecture and has the build version '${osBuildVersion}'.`;
  }
  if (imageComponentTypes && imageComponentTypes.length > 0) {
    text = `${text} The OS components are of types ${joinArray(imageComponentTypes)}.`;
  }
  if (bundledSdks.length) {
    text = `${text} Furthermore, the container image bundles the following SDKs: ${bundledSdks.join(", ")}.`;
  }
  if (bomPkgTypes.length && bomPkgNamespaces.length) {
    if (bomPkgTypes.length === 1) {
      if (bomPkgNamespaces.length === 1) {
        text = `${text} The package type in this ${bomType} is ${joinArray(bomPkgTypes)} with a single purl namespace '${bomPkgNamespaces.join(", ")}' described under components.`;
      } else {
        text = `${text} The package type in this ${bomType} is ${joinArray(bomPkgTypes)} with ${bomPkgNamespaces.length} purl namespaces described under components.`;
      }
      if (componentSrcFiles.length) {
        if (componentSrcFiles.length <= 2) {
          text = `${text} The components were identified from the source files: ${componentSrcFiles.join(", ")}.`;
        } else {
          text = `${text} The components were identified from ${componentSrcFiles.length} source files.`;
        }
      }
    } else {
      text = `${text} ${bomPkgTypes.length} package type(s) and ${bomPkgNamespaces.length} purl namespaces are described in the document under components.`;
    }
  }
  if (bomType === "OBOM") {
    if (vsixCount > 0) {
      text = `${text} The system appears to be set up for remote development, with ${vsixCount} Visual Studio Code extensions installed.`;
    }
    if (swidCount > 0) {
      text = `${text} In addition, there are ${swidCount} applications installed on the system.`;
    }
  }
  if (bomType === "SaaSBOM") {
    text = `${text} ${bomJson.services.length} are described in this ${bomType} under services.`;
  }
  if (bomType === "CDXA") {
    text = `${text} ${bomJson.declarations.attestations.length} attestations are found under declarations.`;
  }
  if (bomJson?.formulation?.length > 0) {
    text = `${text} Further, there is a formulation section with components, workflows and steps for reproducibility.`;
  }
  thoughtLog(`Let me summarize this xBOM:\n${text}`);
  return text;
}

/**
 * Extract interesting tags from the component attribute
 *
 * @param {Object} component CycloneDX component
 * @param {String} bomType BOM type
 * @param {String} parentComponentType Parent component type
 *
 * @returns {Array | undefined} Array of string tags
 */
export function extractTags(
  component,
  bomType = "all",
  parentComponentType = "application",
) {
  if (
    !component ||
    (!component.description && !component.properties && !component.name)
  ) {
    return undefined;
  }
  bomType = bomType?.toLowerCase();
  const tags = new Set();
  if (
    component.type &&
    !["library", "application", "file"].includes(component.type)
  ) {
    tags.add(component.type);
  }
  (component?.tags || []).forEach((tag) => {
    if (tag.length) {
      tags.add(tag);
    }
  });
  const desc = component?.description?.toLowerCase();
  const compProps = component.properties || [];
  // Collect both the BOM specific tags and all tags
  let compNameTags = (componentTags.name[bomType] || []).concat(
    componentTags.name.all || [],
  );
  // For SBOMs with a container component as parent, utilize the tags
  // from OBOM
  if (bomType === "sbom" && parentComponentType === "container") {
    compNameTags = compNameTags.concat(componentTags.name.obom || []);
  }
  const compDescTags = (componentTags.description[bomType] || []).concat(
    componentTags.description.all || [],
  );
  const compPropsTags = (componentTags.properties[bomType] || []).concat(
    componentTags.properties.all || [],
  );
  if (component?.name) {
    // {"devel": ["/-(dev|devel|headers)$/"]}
    for (const anameTagObject of compNameTags) {
      for (const compCategoryTag of Object.keys(anameTagObject)) {
        for (const catRegexStr of anameTagObject[compCategoryTag]) {
          // Regex-based search on the name
          if (new RegExp(catRegexStr, "ig").test(component.name)) {
            tags.add(compCategoryTag);
          }
        }
      }
    }
  }
  // Identify tags from description
  if (desc) {
    for (const adescTag of compDescTags) {
      if (desc.includes(` ${adescTag} `) || desc.includes(` ${adescTag}.`)) {
        tags.add(adescTag);
      }
      const stemmedTag = adescTag.replace(/(ion|ed|er|en|ing)$/, "");
      const stemmedDesc = adescTag.replace(/(ion|ed|er|en|ing) $/, " ");
      if (
        stemmedDesc.includes(` ${stemmedTag} `) ||
        stemmedDesc.includes(` ${stemmedTag}.`)
      ) {
        tags.add(adescTag);
      }
    }
  }
  // Identify tags from properties as a fallback
  if (!tags.size) {
    for (const adescTag of compPropsTags) {
      for (const aprop of compProps) {
        if (
          aprop.name !== "SrcFile" &&
          aprop?.value?.toLowerCase().includes(adescTag)
        ) {
          tags.add(adescTag);
        }
      }
    }
  }
  return Array.from(tags).sort();
}
