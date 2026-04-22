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
  const autoCreate =
    typeof args.autoCreate === "boolean"
      ? args.autoCreate
      : args.autoCreate !== "false";
  const bomPayload = {
    autoCreate: String(autoCreate),
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
  const parentProjectId = args.parentProjectId || args.parentUUID;
  const hasParentUuidMode = typeof parentProjectId !== "undefined";
  const hasParentName = typeof args.parentProjectName !== "undefined";
  const hasParentVersion = typeof args.parentProjectVersion !== "undefined";
  const hasParentCoordsMode = hasParentName || hasParentVersion;
  if (hasParentUuidMode && hasParentCoordsMode) {
    return undefined;
  }
  if (!hasParentUuidMode && hasParentName !== hasParentVersion) {
    return undefined;
  }
  if (hasParentUuidMode) {
    bomPayload.parentUUID = parentProjectId;
  }
  if (hasParentName && hasParentVersion) {
    bomPayload.parentName = args.parentProjectName;
    bomPayload.parentVersion = args.parentProjectVersion;
  }
  if (
    typeof args.isLatest === "boolean" ||
    args.isLatest === "true" ||
    args.isLatest === "false"
  ) {
    bomPayload.isLatest =
      typeof args.isLatest === "boolean"
        ? args.isLatest
        : args.isLatest === "true";
  }
  if (typeof args.projectTag !== "undefined") {
    bomPayload.projectTags = (
      Array.isArray(args.projectTag) ? args.projectTag : [args.projectTag]
    ).map((tag) => ({ name: tag }));
  }
  return bomPayload;
}
