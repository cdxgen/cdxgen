import { Buffer } from "node:buffer";

/**
 * Returns the Dependency-Track BOM API URL.
 *
 * @param {string} serverUrl Dependency-Track server URL
 * @returns {string} API URL to submit BOM payload
 */
export function getDependencyTrackBomUrl(serverUrl) {
  return `${serverUrl.replace(/\/$/, "")}/api/v1/bom`;
}

/**
 * Build the payload for Dependency-Track BOM submission.
 *
 * @param {Object} args CLI/server arguments
 * @param {Object} bomContents BOM Json
 * @returns {Object | undefined} payload object if project coordinates are valid
 */
export function buildDependencyTrackBomPayload(args, bomContents) {
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
  if (
    typeof args.projectId !== "undefined" ||
    typeof args.projectName !== "undefined"
  ) {
    if (typeof args.projectId !== "undefined") {
      bomPayload.project = args.projectId;
    }
    if (typeof args.projectName !== "undefined") {
      bomPayload.projectName = args.projectName;
    }
    // Dependency-Track submissions use "main" as fallback when no version is provided.
    bomPayload.projectVersion = args.projectVersion || "main";
  } else {
    return undefined;
  }
  if (
    typeof args.parentProjectId !== "undefined" ||
    typeof args.parentUUID !== "undefined"
  ) {
    bomPayload.parentUUID = args.parentProjectId || args.parentUUID;
  }
  if (
    typeof args.parentProjectName !== "undefined" &&
    typeof args.parentProjectVersion !== "undefined"
  ) {
    bomPayload.parentName = args.parentProjectName;
    bomPayload.parentVersion = args.parentProjectVersion;
  }
  if (typeof args.projectTag !== "undefined") {
    bomPayload.projectTags = (
      Array.isArray(args.projectTag) ? args.projectTag : [args.projectTag]
    ).map((tag) => ({ name: tag }));
  }
  return bomPayload;
}
