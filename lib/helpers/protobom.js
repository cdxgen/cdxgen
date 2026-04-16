import { readFileSync, writeFileSync } from "node:fs";

import { cdx_15, cdx_16, cdx_17 } from "@appthreat/cdx-proto";
import {
  fromBinary,
  fromJsonString,
  toBinary,
  toJson,
} from "@bufbuild/protobuf";

import { safeExistsSync } from "./utils.js";

/**
 * Stringify the given bom json based on the type.
 *
 * @param {string | Object} bomJson string or object
 * @returns {string} BOM json string
 */
const stringifyIfNeeded = (bomJson) => {
  if (typeof bomJson === "string" || bomJson instanceof String) {
    return bomJson;
  }
  return JSON.stringify(bomJson);
};

/**
 * Method to convert the given bom json to proto binary
 *
 * @param {string | Object} bomJson BOM Json
 * @param {string} binFile Binary file name
 */
export const writeBinary = (bomJson, binFile) => {
  if (bomJson && binFile) {
    let bomSchema;
    if (+bomJson.specVersion === 1.6) {
      bomSchema = cdx_16.BomSchema;
    } else {
      bomSchema = cdx_15.BomSchema;
    }
    writeFileSync(
      binFile,
      toBinary(
        bomSchema,
        fromJsonString(bomSchema, stringifyIfNeeded(bomJson), {
          ignoreUnknownFields: true,
        }),
      ),
      {
        writeUnknownFields: true,
      },
    );
  }
};

/**
 * Method to read a serialized binary
 *
 * @param {string} binFile Binary file name
 * @param {boolean} asJson Convert to JSON
 * @param {number} specVersion Specification version. Defaults to 1.6
 */
export const readBinary = (binFile, asJson = true, specVersion = 1.6) => {
  if (!safeExistsSync(binFile)) {
    return undefined;
  }
  let bomSchema;
  if (specVersion === 1.7) {
    bomSchema = cdx_17.BomSchema;
  } else {
    bomSchema = cdx_16.BomSchema;
  }
  const bomObject = fromBinary(bomSchema, readFileSync(binFile), {
    readUnknownFields: true,
  });
  if (asJson) {
    return toJson(bomSchema, bomObject, { emitDefaultValues: true });
  }
  return bomObject;
};
