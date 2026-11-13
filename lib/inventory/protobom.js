import { readFileSync } from "node:fs";

import {
  bomStats,
  convertBom,
  decodeBomBinary,
  encodeBomBinary,
  encodeBomJson,
  isSupportedSpecVersion,
  parseBomBinary,
  supportedSpecVersions,
  toBomMessage,
} from "@cdxgen/cdx-proto";
import { isProtoBomFile } from "@cdxgen/cdx-proto/node";

import { safeExistsSync, safeWriteSync } from "../core/fs.js";

export { isProtoBomFile };

const JSON_READ_OPTIONS = {
  ignoreUnknownFields: true,
};

const BINARY_READ_OPTIONS = {
  readUnknownFields: true,
};

const BINARY_WRITE_OPTIONS = {
  writeUnknownFields: true,
};

const DEFAULT_SPEC_VERSION =
  supportedSpecVersions[supportedSpecVersions.length - 1];

const hasProvidedSpecVersion = (specVersion) =>
  specVersion !== undefined &&
  specVersion !== null &&
  `${specVersion}`.trim() !== "";

/**
 * Determine whether a spec version is supported for protobuf serialization.
 *
 * Delegates to cdx-proto's `isSupportedSpecVersion`, which accepts the
 * spellings seen in the wild (`v1.6`, `1.6`, `1.6.0`) in addition to the
 * canonical strings.
 *
 * @param {string|undefined} specVersion CycloneDX spec version string
 * @returns {boolean} `true` when supported by `@cdxgen/cdx-proto`, or when no spec version is provided
 */
export const isProtoSupportedSpecVersion = (specVersion) =>
  !hasProvidedSpecVersion(specVersion) || isSupportedSpecVersion(specVersion);

/**
 * Assert that a spec version is supported by `@cdxgen/cdx-proto`.
 *
 * Throws an `Error` naming the unsupported version and the operation when the
 * spec version cannot be serialized to protobuf; returns without effect
 * otherwise.
 *
 * @param {string|undefined} specVersion CycloneDX spec version string
 * @param {string} [operation="protobuf operations"] Operation label used in the error message
 */
export const assertProtoSupportedSpecVersion = (
  specVersion,
  operation = "protobuf operations",
) => {
  if (isProtoSupportedSpecVersion(specVersion)) {
    return;
  }
  throw new Error(
    `CycloneDX ${`${specVersion}`.trim()} is not currently supported for ${operation}. @cdxgen/cdx-proto supports ${supportedSpecVersions.join(", ")} only.`,
  );
};

const resolveExplicitInputSpecVersion = (bomJson) => {
  if (bomJson && typeof bomJson === "object" && !Array.isArray(bomJson)) {
    const explicitSpecVersion = bomJson.specVersion ?? bomJson.spec_version;
    if (hasProvidedSpecVersion(explicitSpecVersion)) {
      return explicitSpecVersion;
    }
  }
  return undefined;
};

/**
 * Translate environmentVars entries into the shape the protobuf schema
 * expects. The JSON schema allows a bare name, a variable whose value is
 * withheld, or a property object; the protobuf message holds a oneof of the
 * property and the bare name. A bare string becomes the oneof's value arm,
 * an object with a name becomes its property arm (without this, the object's
 * value would land on the string arm and the name would be lost), and an
 * entry already in either proto shape is left alone.
 *
 * @param {Object} bomJson BOM Json object
 * @returns {Object} The same object, with the entries translated
 */
const coerceEnvironmentVarsForProto = (bomJson) => {
  for (const formula of bomJson?.formulation || []) {
    for (const workflow of formula?.workflows || []) {
      for (const io of [
        ...(workflow?.inputs || []),
        ...(workflow?.outputs || []),
      ]) {
        if (!Array.isArray(io?.environmentVars)) {
          continue;
        }
        io.environmentVars = io.environmentVars.map((entry) => {
          if (typeof entry === "string") {
            return { value: entry };
          }
          if (
            entry &&
            typeof entry === "object" &&
            Object.hasOwn(entry, "name")
          ) {
            return { property: { ...entry } };
          }
          return entry;
        });
      }
    }
  }
  return bomJson;
};

/**
 * Coerce a BOM input into a decoded message via cdx-proto's `toBomMessage`
 * (messages pass through, JSON strings are parsed, canonical JSON objects are
 * decoded, anything else yields an empty BOM). The version is asserted first
 * so an unsupported BOM keeps failing with cdxgen's operation-specific error
 * rather than cdx-proto's generic one.
 *
 * @param {string | Object} bomJson BOM Json, BOM Json string, or proto message
 * @param {string | number} specVersion CycloneDX spec version fallback for BOMs without specVersion
 * @param {string} operation Operation label used in the error message
 * @returns {Object} Decoded BOM message
 */
const toSerializableBomMessage = (bomJson, specVersion, operation) => {
  assertProtoSupportedSpecVersion(
    resolveExplicitInputSpecVersion(bomJson) ?? specVersion,
    operation,
  );
  // A bare-name environmentVars entry is valid JSON and not a protobuf
  // message (see coerceEnvironmentVarsForProto), so the entries are
  // translated before the decoding. A string input is parsed here for the
  // same walk; a malformed one is left for cdx-proto to report.
  let input = bomJson;
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      // cdx-proto reports the malformed JSON.
    }
  }
  if (input && typeof input === "object" && !Array.isArray(input)) {
    coerceEnvironmentVarsForProto(input);
    return toBomMessage(input, specVersion, JSON_READ_OPTIONS);
  }
  return toBomMessage(bomJson, specVersion, JSON_READ_OPTIONS);
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
    const bomMessage = toSerializableBomMessage(
      bomJson,
      specVersion,
      "protobuf serialization",
    );
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
  assertProtoSupportedSpecVersion(specVersion, "protobuf decoding");
  if (!safeExistsSync(binFile)) {
    return undefined;
  }
  const binaryData = readFileSync(binFile);
  const bomObject =
    specVersion !== undefined && specVersion !== null && specVersion !== ""
      ? decodeBomBinary(specVersion, binaryData, BINARY_READ_OPTIONS)
      : parseBomBinary(binaryData, BINARY_READ_OPTIONS);
  if (asJson) {
    const bomJson = encodeBomJson(bomObject);
    // Protobuf omits empty repeated fields, so a round-trip drops empty
    // dependsOn lists. Restore them so JSON and protobuf inputs yield
    // identical documents.
    for (const adep of bomJson?.dependencies || []) {
      adep.dependsOn ??= [];
    }
    return bomJson;
  }
  return bomObject;
};

/**
 * Method to compute size and count statistics for a BOM.
 *
 * @param {string | Object} bomJson BOM Json, BOM Json string, or proto message
 * @param {string | number} [specVersion] CycloneDX spec version fallback for BOMs without specVersion
 * @returns {Object} Component and dependency counts with JSON/binary byte sizes and compression ratio
 */
export const getBomStats = (bomJson, specVersion = DEFAULT_SPEC_VERSION) =>
  bomStats(
    toSerializableBomMessage(bomJson, specVersion, "protobuf statistics"),
  );

/**
 * Method to cross-convert a BOM between CycloneDX specification versions using
 * the protobuf schemas.
 *
 * cdx-proto's conversion is cardinality-safe: fields that change shape between
 * versions (`metadata.licenses` and `evidence.identity`, singular in 1.5 and an
 * array since 1.6) are reshaped automatically — wrapped on upgrade, collapsed
 * to their first entry on downgrade — including `evidence.identity` on nested
 * components, `metadata.component`, `metadata.tools.components[]`, and
 * `formulation[].components[]`. Downgrades are otherwise lossy: fields the
 * target version does not define are dropped and reported in `warnings` as
 * field paths, alongside collapsed list siblings.
 *
 * Only the protobuf-supported versions (1.5–1.7) can be targeted here. For the
 * full JSON-level normalization across every version cdxgen emits (component
 * types, license attributes, 1.4/2.0 reshaping), prefer
 * `applySpecVersionCompatibility` from the postgen stage.
 *
 * @param {string | Object} bomJson BOM Json, BOM Json string, or proto message
 * @param {string | number} targetSpecVersion Target CycloneDX spec version
 * @param {string | number} [specVersion] CycloneDX spec version fallback for BOMs without specVersion
 * @returns {{bomJson: Object, warnings: string[]}} Converted BOM Json and the field paths dropped
 */
export const convertBomSpecVersion = (
  bomJson,
  targetSpecVersion,
  specVersion = DEFAULT_SPEC_VERSION,
) => {
  assertProtoSupportedSpecVersion(targetSpecVersion, "protobuf conversion");
  const { bom, warnings } = convertBom(
    toSerializableBomMessage(bomJson, specVersion, "protobuf conversion"),
    targetSpecVersion,
  );
  return { bomJson: encodeBomJson(bom), warnings };
};
