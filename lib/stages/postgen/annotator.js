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
 * Count GitHub workflow components and extract security-relevant stats
 *
 * @param {Array} components BOM components array
 *
 * @returns {Object} Statistics about GitHub workflow components
 */
function getGitHubWorkflowStats(components) {
  const stats = {
    totalActions: 0,
    officialActions: 0,
    verifiedActions: 0,
    shaPinned: 0,
    tagPinned: 0,
    branchPinned: 0,
    unknownPinned: 0,
    workflowCount: 0,
    jobCount: 0,
    hasWritePermissions: 0,
    hasIdTokenWrite: 0,
    continueOnError: 0,
    workflows: new Set(),
    jobs: new Set(),
    runners: new Set(),
    environments: new Set(),
  };

  if (!components || !Array.isArray(components)) {
    return stats;
  }

  for (const comp of components) {
    if (comp?.scope === "excluded") {
      continue;
    }
    if (comp?.purl?.startsWith("pkg:github/")) {
      stats.totalActions++;
      const props = comp.properties || [];
      const propMap = {};
      for (const prop of props) {
        propMap[prop.name] = prop.value;
      }
      if (propMap["cdx:github:workflow:name"]) {
        stats.workflows.add(propMap["cdx:github:workflow:name"]);
      }
      if (propMap["cdx:github:job:name"]) {
        stats.jobs.add(propMap["cdx:github:job:name"]);
      }
      if (propMap["cdx:actions:isOfficial"] === "true") {
        stats.officialActions++;
      }
      if (propMap["cdx:actions:isVerified"] === "true") {
        stats.verifiedActions++;
      }
      const pinningType = propMap["cdx:github:action:versionPinningType"];
      if (pinningType === "sha") {
        stats.shaPinned++;
      } else if (pinningType === "tag") {
        stats.tagPinned++;
      } else if (pinningType === "branch") {
        stats.branchPinned++;
      } else {
        stats.unknownPinned++;
      }
      if (propMap["cdx:github:workflow:hasWritePermissions"] === "true") {
        stats.hasWritePermissions++;
      }
      if (propMap["cdx:github:workflow:hasIdTokenWrite"] === "true") {
        stats.hasIdTokenWrite++;
      }
      if (propMap["cdx:github:step:continueOnError"] === "true") {
        stats.continueOnError++;
      }
      if (propMap["cdx:github:job:runner"]) {
        propMap["cdx:github:job:runner"]
          .split(",")
          .filter((r) => r.includes("$"))
          .forEach((r) => {
            stats.runners.add(r.trim());
          });
      }
      if (propMap["cdx:github:job:environment"]) {
        stats.environments.add(propMap["cdx:github:job:environment"]);
      }
    }
  }
  stats.workflowCount = stats.workflows.size;
  stats.jobCount = stats.jobs.size;
  stats.workflows = Array.from(stats.workflows);
  stats.jobs = Array.from(stats.jobs);
  stats.runners = Array.from(stats.runners);
  stats.environments = Array.from(stats.environments);
  return stats;
}

/**
 * Generate security assessment text based on GitHub workflow properties
 *
 * @param {Object} stats GitHub workflow statistics
 *
 * @returns {String} Security assessment text
 */
function generateSecurityAssessment(stats) {
  let text = "";
  const securityIssues = [];
  const securityStrengths = [];
  if (stats.branchPinned > 0) {
    securityIssues.push(
      `${stats.branchPinned} action(s) use branch references instead of pinned versions, which may introduce supply chain risks`,
    );
  }
  if (stats.unknownPinned > 0) {
    securityIssues.push(
      `${stats.unknownPinned} action(s) have unknown version pinning types`,
    );
  }
  if (stats.shaPinned > 0) {
    securityStrengths.push(
      `${stats.shaPinned} action(s) are pinned to specific commit SHAs for maximum security`,
    );
  }
  if (stats.tagPinned > 0) {
    securityStrengths.push(
      `${stats.tagPinned} action(s) are pinned to version tags`,
    );
  }
  if (stats.hasWritePermissions > 0) {
    securityIssues.push(
      `${stats.hasWritePermissions} workflow(s) have write permissions to repository resources`,
    );
  }
  if (stats.hasIdTokenWrite > 0) {
    securityIssues.push(
      `${stats.hasIdTokenWrite} workflow(s) have id-token write access, enabling OIDC authentication`,
    );
  }
  if (stats.officialActions > 0) {
    securityStrengths.push(
      `${stats.officialActions} action(s) are official GitHub Actions from github.com org`,
    );
  }
  if (stats.verifiedActions > 0) {
    securityStrengths.push(
      `${stats.verifiedActions} action(s) are from verified creators`,
    );
  }
  if (stats.continueOnError > 0) {
    securityIssues.push(
      `${stats.continueOnError} step(s) continue on error, which may mask failures`,
    );
  }
  if (securityStrengths.length > 0) {
    text = `${text} Security strengths: ${joinArray(securityStrengths)}.`;
  }
  if (securityIssues.length > 0) {
    text = `${text} Security considerations: ${joinArray(securityIssues)}.`;
  }
  const totalActions = stats.totalActions || 1;
  const securePinned = stats.shaPinned + stats.tagPinned;
  const pinningScore = (securePinned / totalActions) * 100;
  if (pinningScore >= 80) {
    text = `${text} Overall, the workflow demonstrates good version pinning practices.`;
  } else if (pinningScore >= 50) {
    text = `${text} Overall, the workflow has moderate version pinning practices with room for improvement.`;
  } else {
    text = `${text} Overall, the workflow would benefit from improved version pinning practices.`;
  }
  return text;
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
  const githubActionCount = bomJson?.components?.filter((c) =>
    c?.purl?.startsWith("pkg:github/"),
  ).length;
  const hasWorkflowProperties = bomJson?.components?.some((c) =>
    c?.properties?.some(
      (p) =>
        p.name?.startsWith("cdx:github:") || p.name?.startsWith("cdx:actions:"),
    ),
  );
  // Is this a GitHub Workflow BOM?
  if (githubActionCount > 0 && hasWorkflowProperties) {
    bomType = "SBOM";
    description = "Software Bill-of-Materials (SBOM) including GitHub Actions";
  }
  // Is this an OBOM?
  else if (lifecycles.filter((l) => l.phase === "operations").length > 0) {
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
  const githubStats = getGitHubWorkflowStats(bomJson?.components);
  const isGitHubBom = bomType === "SBOM";
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
  if (isGitHubBom && githubStats.totalActions > 0) {
    text = `${text} This ${bomType} contains ${githubStats.totalActions} GitHub Action references across ${githubStats.workflowCount} workflow(s) and ${githubStats.jobCount} job(s).`;
    if (githubStats.workflows.length > 0) {
      if (githubStats.workflows.length <= 3) {
        text = `${text} The workflows are: ${joinArray(githubStats.workflows)}.`;
      } else {
        text = `${text} There are ${githubStats.workflows.length} workflows including ${joinArray(githubStats.workflows.slice(0, 3))}${githubStats.workflows.length > 3 ? " and others" : ""}.`;
      }
    }
    if (githubStats.environments.length > 0) {
      text = `${text} Jobs are deployed to ${joinArray(githubStats.environments)} environment(s).`;
    }
    const pinningText = [];
    if (githubStats.shaPinned > 0) {
      pinningText.push(`${githubStats.shaPinned} SHA-pinned`);
    }
    if (githubStats.tagPinned > 0) {
      pinningText.push(`${githubStats.tagPinned} tag-pinned`);
    }
    if (githubStats.branchPinned > 0) {
      pinningText.push(`${githubStats.branchPinned} branch-referenced`);
    }
    if (githubStats.unknownPinned > 0) {
      pinningText.push(`${githubStats.unknownPinned} with unknown pinning`);
    }
    if (pinningText.length > 0) {
      text = `${text} Version pinning breakdown: ${pinningText.join(", ")}.`;
    }
    if (githubStats.officialActions > 0 || githubStats.verifiedActions > 0) {
      const trustText = [];
      if (githubStats.officialActions > 0) {
        trustText.push(`${githubStats.officialActions} official`);
      }
      if (githubStats.verifiedActions > 0) {
        trustText.push(`${githubStats.verifiedActions} verified`);
      }
      text = `${text} ${joinArray(trustText)} action(s) are from trusted sources.`;
    }
    const securityText = generateSecurityAssessment(githubStats);
    if (securityText) {
      text = `${text}${securityText}`;
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
    if (!isGitHubBom) {
      text = `${text} There are ${bomJson.components.length} components.`;
    }
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
  // GitHub workflow specific tags from properties
  if (bomType === "sbom" || bomType === "all") {
    for (const aprop of compProps) {
      // Security-related tags
      if (
        aprop.name === "cdx:github:action:isShaPinned" &&
        aprop.value === "true"
      ) {
        tags.add("sha-pinned");
        tags.add("secure-versioning");
      }
      if (
        aprop.name === "cdx:github:action:versionPinningType" &&
        aprop.value !== "sha"
      ) {
        tags.add(`pinning-${aprop.value}`);
      }
      if (aprop.name === "cdx:actions:isOfficial" && aprop.value === "true") {
        tags.add("official-action");
        tags.add("trusted-source");
      }
      if (aprop.name === "cdx:actions:isVerified" && aprop.value === "true") {
        tags.add("verified-action");
        tags.add("trusted-source");
      }
      if (
        aprop.name === "cdx:github:workflow:hasWritePermissions" &&
        aprop.value === "true"
      ) {
        tags.add("write-permissions");
        tags.add("elevated-access");
      }
      if (
        aprop.name === "cdx:github:workflow:hasIdTokenWrite" &&
        aprop.value === "true"
      ) {
        tags.add("id-token-write");
        tags.add("oidc-enabled");
      }
      if (
        aprop.name === "cdx:github:step:continueOnError" &&
        aprop.value === "true"
      ) {
        tags.add("continue-on-error");
      }
    }
  }
  return Array.from(tags).sort();
}
