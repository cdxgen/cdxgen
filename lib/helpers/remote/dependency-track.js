import { Buffer } from "node:buffer";

import { hasDangerousUnicode } from "../utils.js";

/**
 * Returns the Dependency-Track BOM API URL as a sanitized URL object.
 *
 * @param {string} serverUrl Dependency-Track server URL
 * @returns {URL | undefined} API URL to submit BOM payload
 */
export function getDependencyTrackBomApiUrl(serverUrl) {
  const rawServerUrl = `${serverUrl || ""}`.trim();
  if (!rawServerUrl || hasDangerousUnicode(rawServerUrl)) {
    return undefined;
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(rawServerUrl);
  } catch {
    return undefined;
  }
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    return undefined;
  }
  if (!parsedUrl.hostname || hasDangerousUnicode(parsedUrl.hostname)) {
    return undefined;
  }
  parsedUrl.username = "";
  parsedUrl.password = "";
  parsedUrl.search = "";
  parsedUrl.hash = "";
  parsedUrl.pathname = `${parsedUrl.pathname.replace(/\/+$/, "")}/api/v1/bom`;
  return parsedUrl;
}

/**
 * Returns the Dependency-Track BOM API URL string.
 *
 * @param {string} serverUrl Dependency-Track server URL
 * @returns {string | undefined} API URL to submit BOM payload
 */
export function getDependencyTrackBomUrl(serverUrl) {
  return getDependencyTrackBomApiUrl(serverUrl)?.toString();
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
