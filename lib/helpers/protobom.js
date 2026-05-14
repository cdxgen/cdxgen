import { readFileSync } from "node:fs";

import {
  createBom,
  decodeBomBinary,
  decodeBomJson,
  encodeBomBinary,
  encodeBomJson,
  parseBomBinary,
  parseBomJson,
  supportedSpecVersions,
} from "@appthreat/cdx-proto";

import { safeExistsSync, safeWriteSync } from "./utils.js";

const JSON_READ_OPTIONS = {
  ignoreUnknownFields: true,
};

const BINARY_READ_OPTIONS = {
  readUnknownFields: true,
};

const BINARY_WRITE_OPTIONS = {
  writeUnknownFields: true,
};

const PROTO_BOM_FILE_EXTENSIONS = [".cdx", ".cdx.bin", ".proto"];

const DEFAULT_SPEC_VERSION =
  supportedSpecVersions[supportedSpecVersions.length - 1];

const isProtoMessageBom = (bom) =>
  Boolean(
    bom &&
      typeof bom === "object" &&
      !Array.isArray(bom) &&
      typeof bom.$typeName === "string" &&
      bom.specVersion,
  );

const hasExplicitSpecVersion = (bomJson) =>
  Boolean(
    bomJson &&
      typeof bomJson === "object" &&
      !Array.isArray(bomJson) &&
      (bomJson.specVersion !== undefined || bomJson.spec_version !== undefined),
  );

const resolveBomMessage = (bomJson, specVersion = DEFAULT_SPEC_VERSION) => {
  if (isProtoMessageBom(bomJson)) {
    return bomJson;
  }
  if (typeof bomJson === "string" || bomJson instanceof String) {
    const parsedBomJson = JSON.parse(`${bomJson}`);
    if (hasExplicitSpecVersion(parsedBomJson)) {
      return parseBomJson(parsedBomJson, JSON_READ_OPTIONS);
    }
    return decodeBomJson(specVersion, parsedBomJson, JSON_READ_OPTIONS);
  }
  if (bomJson && typeof bomJson === "object" && !Array.isArray(bomJson)) {
    if (hasExplicitSpecVersion(bomJson)) {
      return parseBomJson(bomJson, JSON_READ_OPTIONS);
    }
    return decodeBomJson(specVersion, bomJson, JSON_READ_OPTIONS);
  }
  return createBom(specVersion);
};

/**
 * Determine whether a path looks like a CycloneDX protobuf file.
 *
 * @param {string} filePath File path
 * @returns {boolean} true when the path looks like a protobuf BOM file
 */
export const isProtoBomFile = (filePath) => {
  const normalizedPath = `${filePath || ""}`.toLowerCase();
  return PROTO_BOM_FILE_EXTENSIONS.some((extension) =>
    normalizedPath.endsWith(extension),
  );
};

/**
 * Method to convert the given bom json to proto binary
 *
 * @param {string | Object} bomJson BOM Json
 * @param {string} binFile Binary file name
 * @param {string | number} [specVersion] CycloneDX spec version fallback for BOMs without specVersion
 */
export const writeBinary = (
  bomJson,
  binFile,
  specVersion = DEFAULT_SPEC_VERSION,
) => {
  if (bomJson && binFile) {
    const bomMessage = resolveBomMessage(bomJson, specVersion);
    safeWriteSync(binFile, encodeBomBinary(bomMessage, BINARY_WRITE_OPTIONS));
  }
};

/**
 * Method to read a serialized binary
 *
 * @param {string} binFile Binary file name
 * @param {boolean} asJson Convert to JSON
 * @param {string | number} [specVersion] Optional specification version. When omitted, cdxgen auto-detects the matching schema.
 */
export const readBinary = (binFile, asJson, specVersion) => {
  asJson = asJson ?? true;
  if (!safeExistsSync(binFile)) {
    return undefined;
  }
  const binaryData = readFileSync(binFile);
  const bomObject =
    specVersion !== undefined && specVersion !== null && specVersion !== ""
      ? decodeBomBinary(specVersion, binaryData, BINARY_READ_OPTIONS)
      : parseBomBinary(binaryData, BINARY_READ_OPTIONS);
  if (asJson) {
    return encodeBomJson(bomObject);
  }
  return bomObject;
};
