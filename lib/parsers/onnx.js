import { closeSync, openSync, readSync, statSync } from "node:fs";

import { thoughtLog } from "../core/logger.js";

// An ONNX model is a protobuf-encoded ModelProto. Only the header fields are
// read here; the graph payload is skipped by offset, so inspection stays
// cheap for multi-gigabyte files and never loads tensors.
//
// ModelProto fields (onnx/onnx.proto):
//   1 ir_version (int64), 2 producer_name, 3 producer_version, 4 domain,
//   5 model_version (int64), 6 doc_string, 7 graph, 8 opset_import (repeated),
//   14 metadata_props (repeated), 20 training_info, 25 functions,
//   26 configuration.
// OperatorSetIdProto: 1 domain (string), 2 version (int64).
// StringStringEntryProto: 1 key, 2 value.

/** Fields are walked from the front; a hostile file cannot force a scan
 * deeper than this many top-level entries. */
const MAX_TOP_LEVEL_FIELDS = 128;
/** Largest single field payload that will actually be read into memory. */
const MAX_FIELD_BYTES = 4096;
/** Longest string kept from a header field. */
const MAX_STRING_CHARS = 256;
/** IR versions run from 1 to 13 at the time of writing (IR_VERSION_2025_11_06).
 * A value above this bound is taken as evidence that the file is not an ONNX
 * model, with headroom for versions released after this code. */
const MAX_IR_VERSION = 64;
/** metadata_props keys that are known not to carry secrets. Only the names of
 * keys on this list are reported, never any value. */
const ALLOWED_METADATA_KEYS = new Set([
  "converted_from",
  "onnx_runtime_version",
  "onnx_converter",
  "producer_commit",
]);
const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LENGTH = 2;
const WIRE_FIXED32 = 5;
// The wire type each known ModelProto field must use.
const MODEL_FIELD_WIRE_TYPES = new Map([
  [1, WIRE_VARINT],
  [2, WIRE_LENGTH],
  [3, WIRE_LENGTH],
  [4, WIRE_LENGTH],
  [5, WIRE_VARINT],
  [6, WIRE_LENGTH],
  [7, WIRE_LENGTH],
  [8, WIRE_LENGTH],
  [14, WIRE_LENGTH],
  [20, WIRE_LENGTH],
  [25, WIRE_LENGTH],
  [26, WIRE_LENGTH],
]);
const INT64_SIGN_BIT = 1n << 63n;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Whether text holds a C0 or C1 control character.
 *
 * @param {string} text Text to check
 * @returns {boolean} true when a control character is present
 */
function hasControlCharacter(text) {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

/**
 * Convert a protobuf int64 varint to a non-negative safe integer.
 *
 * @param {bigint} value Decoded varint
 * @returns {number|undefined} The number, or undefined when it is negative or
 *   not a safe integer
 */
function nonNegativeSafeInteger(value) {
  if (value >= INT64_SIGN_BIT || value > MAX_SAFE) {
    return undefined;
  }
  return Number(value);
}

/**
 * Decode a string field. Text that is not valid UTF-8, holds control
 * characters or is longer than the bound is dropped.
 *
 * @param {Buffer} payload Field payload
 * @returns {string|undefined} The string, or undefined when it is not usable
 */
function decodeText(payload) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
  } catch {
    return undefined;
  }
  if (text.length > MAX_STRING_CHARS || hasControlCharacter(text)) {
    return undefined;
  }
  return text;
}

/**
 * Read the identifying header fields of an ONNX model file and check that they
 * form a plausible ModelProto.
 *
 * Only `ir_version`, `producer_name`, `producer_version`, `domain`,
 * `model_version`, `opset_import` and `metadata_props` are extracted. The graph
 * and every other payload are skipped by offset without being read, so no
 * tensor data is ever loaded and no model code is executed.
 *
 * A file is accepted when every known field uses the wire type the schema
 * gives it, `ir_version` is present and between 1 and 64, every opset version
 * is a non-negative safe integer, and the file names at least one
 * `opset_import` or carries a `graph`.
 *
 * @param {string} filePath Path to the `.onnx` file
 * @returns {{
 *   irVersion: number,
 *   producerName: string,
 *   producerVersion: string,
 *   domain: string,
 *   modelVersion: number,
 *   opsets: Array<{domain: string, version: number}>,
 *   metadataPropsCount: number,
 *   metadataKeys: string[],
 *   hasGraph: boolean,
 * } | undefined} Header summary, or undefined when the file is not an ONNX
 *   model
 */
export function readOnnxHeader(filePath) {
  let fd;
  const reject = (reason) => {
    thoughtLog(`Rejecting the ONNX file ${filePath}: ${reason}.`);
    return undefined;
  };
  try {
    const stats = statSync(filePath);
    if (!stats.isFile() || stats.size < 2) {
      return reject("not a regular file of at least two bytes");
    }
    fd = openSync(filePath, "r");
    // The whole file is not buffered; fields are fetched by offset. A small
    // scratch buffer is re-used for varints.
    const reader = new OffsetReader(fd, stats.size);
    const result = {
      irVersion: 0,
      producerName: "",
      producerVersion: "",
      domain: "",
      modelVersion: 0,
      opsets: [],
      metadataPropsCount: 0,
      metadataKeys: [],
      hasGraph: false,
    };
    const seenOpsets = new Set();
    const metadataKeys = new Set();
    for (let i = 0; i < MAX_TOP_LEVEL_FIELDS; i += 1) {
      if (reader.offset >= stats.size) {
        break;
      }
      const tag = reader.readVarint();
      if (tag === undefined) {
        return reject("truncated field tag");
      }
      const fieldNumber = tag >> 3n;
      const wireType = Number(tag & 7n);
      if (fieldNumber === 0n || fieldNumber > 0x1fffffffn) {
        return reject("invalid field number");
      }
      const expectedWireType = MODEL_FIELD_WIRE_TYPES.get(Number(fieldNumber));
      if (expectedWireType !== undefined && expectedWireType !== wireType) {
        return reject(`field ${fieldNumber} has the wrong wire type`);
      }
      const field = Number(fieldNumber);
      if (wireType === WIRE_VARINT) {
        const value = reader.readVarint();
        if (value === undefined) {
          return reject("truncated varint");
        }
        if (field === 1) {
          const irVersion = nonNegativeSafeInteger(value);
          if (irVersion === undefined) {
            return reject("ir_version is negative or not a safe integer");
          }
          result.irVersion = irVersion;
        } else if (field === 5) {
          // A model_version that cannot be stored is left out.
          result.modelVersion = nonNegativeSafeInteger(value) ?? 0;
        }
        continue;
      }
      if (wireType === WIRE_FIXED64 || wireType === WIRE_FIXED32) {
        if (!reader.skip(wireType === WIRE_FIXED64 ? 8 : 4)) {
          return reject("fixed-width field runs past the end of the file");
        }
        continue;
      }
      if (wireType !== WIRE_LENGTH) {
        // Group wire types are not part of proto3 and have no length.
        return reject(`unsupported wire type ${wireType}`);
      }
      const length = reader.readVarint();
      if (length === undefined) {
        return reject("truncated length");
      }
      const byteLength = nonNegativeSafeInteger(length);
      if (byteLength === undefined) {
        return reject("invalid field length");
      }
      if (reader.offset + byteLength > stats.size) {
        return reject("field runs past the end of the file");
      }
      if (field === 7) {
        result.hasGraph = true;
      }
      const wanted = [2, 3, 4, 8, 14].includes(field);
      if (wanted && byteLength <= MAX_FIELD_BYTES) {
        const payload = reader.readBytes(byteLength);
        if (!payload) {
          return reject("short read");
        }
        if (field === 8) {
          const opset = parseOperatorSetEntry(payload);
          if (!opset) {
            return reject("malformed opset_import entry");
          }
          const opsetKey = `${opset.domain}:${opset.version}`;
          if (!seenOpsets.has(opsetKey)) {
            seenOpsets.add(opsetKey);
            result.opsets.push(opset);
          }
        } else if (field === 14) {
          const key = parseMetadataKey(payload);
          result.metadataPropsCount += 1;
          if (key !== undefined && ALLOWED_METADATA_KEYS.has(key)) {
            metadataKeys.add(key);
          }
        } else {
          const text = decodeText(payload) ?? "";
          if (field === 2) {
            result.producerName = text;
          } else if (field === 3) {
            result.producerVersion = text;
          } else {
            result.domain = text;
          }
        }
        continue;
      }
      // Skip anything else (notably the graph and doc_string) by offset.
      if (!reader.skip(byteLength)) {
        return reject("field runs past the end of the file");
      }
    }
    if (result.irVersion < 1 || result.irVersion > MAX_IR_VERSION) {
      return reject("ir_version is missing or out of range");
    }
    if (!result.opsets.length && !result.hasGraph) {
      return reject("neither an opset_import nor a graph was found");
    }
    result.metadataKeys = Array.from(metadataKeys).sort();
    return result;
  } catch {
    return reject("unreadable");
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

/**
 * Reader that fetches bytes from a file descriptor by absolute offset.
 *
 * @param {number} fd Open file descriptor
 * @param {number} fileSize Total file size
 */
class OffsetReader {
  constructor(fd, fileSize) {
    this.fd = fd;
    this.fileSize = fileSize;
    this.offset = 0;
    this.buffer = Buffer.alloc(16);
  }

  /**
   * Read a protobuf varint at the cursor.
   *
   * @returns {bigint|undefined} Value, or undefined at end of input or for a
   *   varint longer than ten bytes
   */
  readVarint() {
    let result = 0n;
    let shift = 0n;
    for (let i = 0; i < 10; i += 1) {
      if (!this.fillBuffer(1)) {
        return undefined;
      }
      const byte = this.buffer[0];
      this.offset += 1;
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) {
        // The tenth byte may only carry the top bit of a 64-bit value.
        return i === 9 && byte > 1 ? undefined : result;
      }
      shift += 7n;
    }
    return undefined;
  }

  /**
   * Read a length-delimited payload at the cursor.
   *
   * @param {number} length Payload length
   * @returns {Buffer|undefined} Payload, or undefined when unavailable
   */
  readBytes(length) {
    const payload = Buffer.alloc(length);
    const bytesRead = readSync(this.fd, payload, 0, length, this.offset);
    if (bytesRead !== length) {
      return undefined;
    }
    this.offset += length;
    return payload;
  }

  /**
   * Advance the cursor without reading the payload.
   *
   * @param {number} length Bytes to skip
   * @returns {boolean} true when the skip stayed within the file
   */
  skip(length) {
    const next = this.offset + length;
    if (next > this.fileSize) {
      return false;
    }
    this.offset = next;
    return true;
  }

  /**
   * Ensure `length` bytes are available in the scratch buffer.
   *
   * @param {number} length Bytes needed
   * @returns {boolean} true when the read succeeded
   */
  fillBuffer(length) {
    if (this.offset + length > this.fileSize) {
      return false;
    }
    const bytesRead = readSync(this.fd, this.buffer, 0, length, this.offset);
    return bytesRead === length;
  }
}

/**
 * Walk the fields of a small embedded message.
 *
 * @param {Buffer} payload Message bytes
 * @param {Function} onField Called with (fieldNumber, wireType, value) where
 *   value is a bigint for varints and a Buffer for length-delimited fields
 * @returns {boolean} false when the bytes are not a well-formed message
 */
function walkMessage(payload, onField) {
  let pos = 0;
  while (pos < payload.length) {
    const tag = readVarintFrom(payload, pos);
    if (!tag) {
      return false;
    }
    pos = tag.next;
    const fieldNumber = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);
    if (fieldNumber === 0) {
      return false;
    }
    if (wireType === WIRE_VARINT) {
      const value = readVarintFrom(payload, pos);
      if (!value) {
        return false;
      }
      pos = value.next;
      onField(fieldNumber, wireType, value.value);
    } else if (wireType === WIRE_LENGTH) {
      const length = readVarintFrom(payload, pos);
      if (!length) {
        return false;
      }
      pos = length.next;
      const byteLength = Number(length.value);
      if (length.value > MAX_SAFE || pos + byteLength > payload.length) {
        return false;
      }
      onField(fieldNumber, wireType, payload.subarray(pos, pos + byteLength));
      pos += byteLength;
    } else if (wireType === WIRE_FIXED64 || wireType === WIRE_FIXED32) {
      pos += wireType === WIRE_FIXED64 ? 8 : 4;
      if (pos > payload.length) {
        return false;
      }
    } else {
      return false;
    }
  }
  return true;
}

/**
 * Parse one OperatorSetIdProto payload. An empty or absent domain is the
 * default ONNX operator set and is reported as `ai.onnx`.
 *
 * @param {Buffer} payload Field payload
 * @returns {{domain: string, version: number}|undefined} Parsed entry, or
 *   undefined when it is malformed
 */
function parseOperatorSetEntry(payload) {
  let domain = "";
  let version = 0;
  let valid = true;
  const wellFormed = walkMessage(payload, (field, wireType, value) => {
    if (field === 1) {
      if (wireType !== WIRE_LENGTH) {
        valid = false;
        return;
      }
      const text = decodeText(value);
      // A domain that is not plain text must not be read as the default set.
      if (text === undefined) {
        valid = false;
        return;
      }
      domain = text;
    } else if (field === 2) {
      if (wireType !== WIRE_VARINT) {
        valid = false;
        return;
      }
      const parsed = nonNegativeSafeInteger(value);
      if (parsed === undefined) {
        valid = false;
        return;
      }
      version = parsed;
    }
  });
  if (!wellFormed || !valid) {
    return undefined;
  }
  return { domain: domain || "ai.onnx", version };
}

/**
 * Read the key of one StringStringEntryProto payload.
 *
 * @param {Buffer} payload Field payload
 * @returns {string|undefined} The key, when it is plain text
 */
function parseMetadataKey(payload) {
  let key;
  walkMessage(payload, (field, wireType, value) => {
    if (field === 1 && wireType === WIRE_LENGTH) {
      key = decodeText(value);
    }
  });
  return key;
}

/**
 * Read a varint from a buffer at a position.
 *
 * @param {Buffer} buffer Source buffer
 * @param {number} pos Start position
 * @returns {{value: bigint, next: number}|undefined} Result, or undefined
 */
function readVarintFrom(buffer, pos) {
  let value = 0n;
  let shift = 0n;
  let cursor = pos;
  for (let i = 0; i < 10 && cursor < buffer.length; i += 1) {
    const byte = buffer[cursor];
    cursor += 1;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return i === 9 && byte > 1 ? undefined : { value, next: cursor };
    }
    shift += 7n;
  }
  return undefined;
}
