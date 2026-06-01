import { closeSync, openSync, readSync, statSync } from "node:fs";
import { basename } from "node:path";

const GGUF_METADATA_TYPES = {
  UINT8: 0,
  INT8: 1,
  UINT16: 2,
  INT16: 3,
  UINT32: 4,
  INT32: 5,
  FLOAT32: 6,
  BOOL: 7,
  STRING: 8,
  ARRAY: 9,
  UINT64: 10,
  INT64: 11,
  FLOAT64: 12,
};

const GGUF_FILE_TYPE_NAMES = new Map([
  [0, "F32"],
  [1, "F16"],
  [2, "Q4_0"],
  [3, "Q4_1"],
  [7, "Q8_0"],
  [8, "Q5_0"],
  [9, "Q5_1"],
  [10, "Q2_K"],
  [11, "Q3_K_S"],
  [12, "Q3_K_M"],
  [13, "Q3_K_L"],
  [14, "Q4_K_S"],
  [15, "Q4_K_M"],
  [16, "Q5_K_S"],
  [17, "Q5_K_M"],
  [18, "Q6_K"],
  [19, "IQ2_XXS"],
  [20, "IQ2_XS"],
  [21, "Q2_K_S"],
  [22, "IQ3_XS"],
  [23, "IQ3_XXS"],
  [24, "IQ1_S"],
  [25, "IQ4_NL"],
  [26, "IQ3_S"],
  [27, "IQ3_M"],
  [28, "IQ2_S"],
  [29, "IQ2_M"],
  [30, "IQ4_XS"],
  [31, "IQ1_M"],
  [32, "BF16"],
  [36, "TQ1_0"],
  [37, "TQ2_0"],
  [38, "MXFP4_MOE"],
  [39, "NVFP4"],
  [40, "Q1_0"],
]);

const GGUF_SIDECAR_NAMES = new Set(["mmproj", "mtp"]);
const GGUF_TYPE_NAMES = new Set(["LoRA", "vocab"]);
const GGUF_TEXT_TOKEN_REGEX = /^[A-Za-z0-9\s]+$/u;
const GGUF_ENCODING_TOKEN_REGEX = /^[A-Za-z0-9_]+$/u;
const GGUF_SIZE_LABEL_REGEX = /^(?:\d+x)?(?:\d+\.)?\d+[A-Za-z]$/u;
const GGUF_SIZE_LABEL_SUFFIX_REGEX = /^[A-Za-z]+(?:\d+\.)?\d+[A-Za-z]+$/u;

const GGUF_INITIAL_READ_BYTES = 64 * 1024;
const GGUF_MAX_HEADER_READ_BYTES = 8 * 1024 * 1024;
const GGUF_MAX_STRING_LENGTH = 1024 * 1024;
const GGUF_MAX_ARRAY_LENGTH = 64 * 1024;
const GGUF_MAX_METADATA_COUNT = 16 * 1024;
const GGUF_TEXT_DECODER = new TextDecoder();
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);
const GGUF_MAX_METADATA_TYPE = GGUF_METADATA_TYPES.FLOAT64;

const isDigits = (value) => value.length > 0 && /^[0-9]+$/u.test(value);

const isFiveDigitToken = (value) => value.length === 5 && isDigits(value);

const isValidGgufTextToken = (value) =>
  value.length > 0 && GGUF_TEXT_TOKEN_REGEX.test(value);

const isVersionToken = (value) => {
  if (!value?.startsWith("v")) {
    return false;
  }
  return value
    .slice(1)
    .split(".")
    .every((segment) => isDigits(segment));
};

const parseShardSuffix = (tokens) => {
  if (tokens.length < 3) {
    return {
      tokens,
    };
  }
  const shardCountToken = tokens.at(-1);
  const ofToken = tokens.at(-2);
  const shardIndexToken = tokens.at(-3);
  if (
    ofToken !== "of" ||
    !isFiveDigitToken(shardIndexToken) ||
    !isFiveDigitToken(shardCountToken)
  ) {
    return {
      tokens,
    };
  }
  return {
    shard: `${shardIndexToken}-of-${shardCountToken}`,
    shardCount: Number.parseInt(shardCountToken, 10),
    shardIndex: Number.parseInt(shardIndexToken, 10),
    tokens: tokens.slice(0, -3),
  };
};

const parseGgufSizeAndFineTune = (tokens) => {
  if (!tokens.length || !GGUF_SIZE_LABEL_REGEX.test(tokens[0])) {
    return undefined;
  }
  let sizeLabel = tokens[0];
  let fineTuneTokens = tokens.slice(1);
  if (
    fineTuneTokens.length > 0 &&
    GGUF_SIZE_LABEL_SUFFIX_REGEX.test(fineTuneTokens[0])
  ) {
    sizeLabel = `${sizeLabel}-${fineTuneTokens[0]}`;
    fineTuneTokens = fineTuneTokens.slice(1);
  }
  if (fineTuneTokens.some((token) => !isValidGgufTextToken(token))) {
    return undefined;
  }
  return {
    fineTune: fineTuneTokens.length ? fineTuneTokens.join("-") : undefined,
    sizeLabel,
  };
};

const parseGgufPrefixTokens = (tokens) => {
  for (let baseLength = tokens.length - 1; baseLength >= 1; baseLength--) {
    const baseTokens = tokens.slice(0, baseLength);
    if (baseTokens.some((token) => !isValidGgufTextToken(token))) {
      continue;
    }
    const sizeAndFineTune = parseGgufSizeAndFineTune(tokens.slice(baseLength));
    if (!sizeAndFineTune) {
      continue;
    }
    return {
      baseName: baseTokens.join("-"),
      fineTune: sizeAndFineTune.fineTune,
      sizeLabel: sizeAndFineTune.sizeLabel,
    };
  }
  return undefined;
};

const ensureReadableBytes = (dataView, state, byteLength, label) => {
  if (state.offset + byteLength > dataView.byteLength) {
    throw new RangeError(
      `Truncated GGUF header while reading ${label} at byte ${state.offset}`,
    );
  }
};

const readLengthValue = (
  dataView,
  state,
  label,
  maxValue = Number.MAX_SAFE_INTEGER,
) => {
  ensureReadableBytes(dataView, state, 8, label);
  const value = dataView.getBigUint64(state.offset, true);
  state.offset += 8;
  if (value > MAX_SAFE_BIGINT) {
    throw new RangeError(
      `GGUF ${label} ${value.toString()} exceeds supported JavaScript limits`,
    );
  }
  const numericValue = Number(value);
  if (numericValue > maxValue) {
    throw new RangeError(`GGUF ${label} ${numericValue} exceeds allowed limit`);
  }
  return numericValue;
};

const bigIntToMetadataNumber = (value) => {
  if (value <= MAX_SAFE_BIGINT && value >= MIN_SAFE_BIGINT) {
    return Number(value);
  }
  return value.toString();
};

const readGgufValue = (dataView, state, type) => {
  switch (type) {
    case GGUF_METADATA_TYPES.UINT8:
      ensureReadableBytes(dataView, state, 1, "uint8 metadata value");
      return dataView.getUint8(state.offset++);
    case GGUF_METADATA_TYPES.INT8:
      ensureReadableBytes(dataView, state, 1, "int8 metadata value");
      return dataView.getInt8(state.offset++);
    case GGUF_METADATA_TYPES.UINT16: {
      ensureReadableBytes(dataView, state, 2, "uint16 metadata value");
      const value = dataView.getUint16(state.offset, true);
      state.offset += 2;
      return value;
    }
    case GGUF_METADATA_TYPES.INT16: {
      ensureReadableBytes(dataView, state, 2, "int16 metadata value");
      const value = dataView.getInt16(state.offset, true);
      state.offset += 2;
      return value;
    }
    case GGUF_METADATA_TYPES.UINT32: {
      ensureReadableBytes(dataView, state, 4, "uint32 metadata value");
      const value = dataView.getUint32(state.offset, true);
      state.offset += 4;
      return value;
    }
    case GGUF_METADATA_TYPES.INT32: {
      ensureReadableBytes(dataView, state, 4, "int32 metadata value");
      const value = dataView.getInt32(state.offset, true);
      state.offset += 4;
      return value;
    }
    case GGUF_METADATA_TYPES.FLOAT32: {
      ensureReadableBytes(dataView, state, 4, "float32 metadata value");
      const value = dataView.getFloat32(state.offset, true);
      state.offset += 4;
      return value;
    }
    case GGUF_METADATA_TYPES.BOOL: {
      ensureReadableBytes(dataView, state, 1, "bool metadata value");
      const value = dataView.getUint8(state.offset);
      state.offset += 1;
      if (value !== 0 && value !== 1) {
        throw new Error(`Invalid GGUF boolean metadata value ${value}`);
      }
      return value === 1;
    }
    case GGUF_METADATA_TYPES.STRING: {
      const length = readLengthValue(
        dataView,
        state,
        "string length",
        GGUF_MAX_STRING_LENGTH,
      );
      ensureReadableBytes(dataView, state, length, "string bytes");
      const bytes = new Uint8Array(
        dataView.buffer,
        dataView.byteOffset + state.offset,
        length,
      );
      state.offset += length;
      return GGUF_TEXT_DECODER.decode(bytes);
    }
    case GGUF_METADATA_TYPES.ARRAY: {
      ensureReadableBytes(dataView, state, 4, "array item type");
      const itemType = dataView.getUint32(state.offset, true);
      state.offset += 4;
      if (itemType > GGUF_MAX_METADATA_TYPE) {
        throw new Error(`Unsupported GGUF metadata type ${itemType}`);
      }
      const length = readLengthValue(
        dataView,
        state,
        "array length",
        GGUF_MAX_ARRAY_LENGTH,
      );
      const values = [];
      for (let index = 0; index < length; index++) {
        values.push(readGgufValue(dataView, state, itemType));
      }
      return values;
    }
    case GGUF_METADATA_TYPES.UINT64: {
      ensureReadableBytes(dataView, state, 8, "uint64 metadata value");
      const value = dataView.getBigUint64(state.offset, true);
      state.offset += 8;
      return bigIntToMetadataNumber(value);
    }
    case GGUF_METADATA_TYPES.INT64: {
      ensureReadableBytes(dataView, state, 8, "int64 metadata value");
      const value = dataView.getBigInt64(state.offset, true);
      state.offset += 8;
      return bigIntToMetadataNumber(value);
    }
    case GGUF_METADATA_TYPES.FLOAT64: {
      ensureReadableBytes(dataView, state, 8, "float64 metadata value");
      const value = dataView.getFloat64(state.offset, true);
      state.offset += 8;
      return value;
    }
    default:
      throw new Error(`Unsupported GGUF metadata type ${type}`);
  }
};

const readGgufPrefix = (filePath, readLength) => {
  const fileDescriptor = openSync(filePath, "r");
  try {
    const prefix = Buffer.alloc(readLength);
    const bytesRead = readSync(fileDescriptor, prefix, 0, readLength, 0);
    return prefix.subarray(0, bytesRead);
  } finally {
    closeSync(fileDescriptor);
  }
};

/**
 * Convert a GGUF `general.file_type` enumeration value to a stable encoding label.
 *
 * The mapping follows the current `llama_ftype` enumeration used by GGUF writers.
 * Unknown values intentionally return `undefined` so callers can fall back to
 * filename-derived or executor-specific hints.
 *
 * @param {number|string|undefined} fileType numeric GGUF file type value
 * @returns {string|undefined} encoding label such as `Q5_K_M` or `BF16`
 */
export function ggufFileTypeName(fileType) {
  const normalizedFileType = Number(fileType);
  if (!Number.isInteger(normalizedFileType)) {
    return undefined;
  }
  return GGUF_FILE_TYPE_NAMES.get(normalizedFileType);
}

/**
 * Parse a GGUF filename using the upstream naming convention documented by the
 * GGUF specification.
 *
 * The convention is intentionally strict and will return `undefined` for files
 * that do not follow the recommended layout. Callers that need to support older
 * or community-specific names can use this as a first pass and then fall back to
 * project-specific heuristics.
 *
 * @param {string} filePathOrName absolute path or bare filename
 * @returns {Object|undefined} parsed filename details when recognized
 */
export function parseGgufFilename(filePathOrName) {
  const fileName = basename(String(filePathOrName || "").trim());
  if (!fileName.endsWith(".gguf")) {
    return undefined;
  }
  let tokens = basename(fileName, ".gguf").split("-");
  const parsed = {
    fileName,
  };
  if (!tokens.length || tokens.some((token) => token.length === 0)) {
    return undefined;
  }
  if (GGUF_SIDECAR_NAMES.has(tokens[0])) {
    parsed.sidecar = tokens[0];
    tokens = tokens.slice(1);
  }
  const shardDetails = parseShardSuffix(tokens);
  tokens = shardDetails.tokens;
  if (shardDetails.shard) {
    parsed.shard = shardDetails.shard;
    parsed.shardCount = shardDetails.shardCount;
    parsed.shardIndex = shardDetails.shardIndex;
  }
  if (tokens.length && GGUF_TYPE_NAMES.has(tokens.at(-1))) {
    parsed.type = tokens.at(-1);
    tokens = tokens.slice(0, -1);
  }
  if (!tokens.length) {
    return undefined;
  }
  const versionIndex = tokens.findLastIndex((token) => isVersionToken(token));
  if (versionIndex < 1) {
    return undefined;
  }
  parsed.version = tokens[versionIndex];
  const suffixTokens = tokens.slice(versionIndex + 1);
  if (suffixTokens.length > 1) {
    return undefined;
  }
  if (suffixTokens.length === 1) {
    const encodingToken = suffixTokens[0];
    if (
      !GGUF_ENCODING_TOKEN_REGEX.test(encodingToken) ||
      GGUF_TYPE_NAMES.has(encodingToken)
    ) {
      return undefined;
    }
    parsed.encoding = encodingToken;
  }
  const prefixDetails = parseGgufPrefixTokens(tokens.slice(0, versionIndex));
  if (!prefixDetails) {
    return undefined;
  }
  parsed.baseName = prefixDetails.baseName;
  parsed.sizeLabel = prefixDetails.sizeLabel;
  if (prefixDetails.fineTune) {
    parsed.fineTune = prefixDetails.fineTune;
  }
  return parsed;
}

/**
 * Parse GGUF metadata from an in-memory header buffer.
 *
 * @param {Uint8Array|Buffer} buffer GGUF header buffer
 * @returns {Object} parsed metadata map
 */
export function parseGgufMetadataBuffer(buffer) {
  if (!buffer?.byteLength || buffer.byteLength < 24) {
    throw new RangeError("Truncated GGUF header: need at least 24 bytes");
  }
  const dataView = new DataView(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength,
  );
  if (
    String.fromCharCode(
      dataView.getUint8(0),
      dataView.getUint8(1),
      dataView.getUint8(2),
      dataView.getUint8(3),
    ) !== "GGUF"
  ) {
    throw new Error("Invalid GGUF magic");
  }
  const state = { offset: 4 };
  ensureReadableBytes(dataView, state, 4, "format version");
  const version = dataView.getUint32(state.offset, true);
  state.offset += 4;
  const tensorCount = readLengthValue(dataView, state, "tensor count");
  const metadataCount = readLengthValue(
    dataView,
    state,
    "metadata count",
    GGUF_MAX_METADATA_COUNT,
  );
  const metadata = {
    "gguf.version": version,
    "gguf.tensorCount": tensorCount,
    "gguf.metadataCount": metadataCount,
  };
  for (let index = 0; index < metadataCount; index++) {
    const key = readGgufValue(dataView, state, GGUF_METADATA_TYPES.STRING);
    ensureReadableBytes(dataView, state, 4, "metadata value type");
    const valueType = dataView.getUint32(state.offset, true);
    state.offset += 4;
    if (valueType > GGUF_MAX_METADATA_TYPE) {
      throw new Error(`Unsupported GGUF metadata type ${valueType}`);
    }
    metadata[key] = readGgufValue(dataView, state, valueType);
  }
  return metadata;
}

/**
 * Read selected GGUF metadata keys from a model artifact without loading the whole file.
 *
 * @param {string} filePath GGUF file path
 * @returns {Object|undefined} parsed GGUF metadata
 */
export function readGgufMetadata(filePath) {
  const fileSize = statSync(filePath).size;
  let readLength = Math.min(
    Math.max(GGUF_INITIAL_READ_BYTES, 24),
    fileSize || GGUF_INITIAL_READ_BYTES,
  );
  let lastError;
  while (
    readLength > 0 &&
    readLength <= Math.min(fileSize, GGUF_MAX_HEADER_READ_BYTES)
  ) {
    try {
      return parseGgufMetadataBuffer(readGgufPrefix(filePath, readLength));
    } catch (error) {
      lastError = error;
      if (
        !(error instanceof RangeError) ||
        readLength >= fileSize ||
        readLength >= GGUF_MAX_HEADER_READ_BYTES
      ) {
        throw error;
      }
      readLength = Math.min(
        readLength * 2,
        fileSize,
        GGUF_MAX_HEADER_READ_BYTES,
      );
    }
  }
  throw lastError || new RangeError("Unable to read GGUF metadata header");
}
