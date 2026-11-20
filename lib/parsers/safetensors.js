import { closeSync, openSync, readSync, statSync } from "node:fs";

import { thoughtLog } from "../core/logger.js";

// A safetensors file begins with an 8-byte little-endian unsigned integer
// giving the byte length of a JSON header, followed by that JSON header, and
// then the raw tensor buffers. Only the header is parsed here: tensor data is
// never read, so inspection stays cheap and side-effect free. The layout rules
// follow https://github.com/huggingface/safetensors (README "Format" and
// `safetensors/src/tensor.rs`).
const HEADER_LENGTH_BYTES = 8;
// The reference parser accepts headers up to 100,000,000 bytes. A smaller
// limit is kept here because it bounds what JSON.parse builds from the header:
// V8 spends up to 64 bytes of heap on every object or array, even one written
// as `{}`, and running out of heap aborts the process instead of throwing, so
// the text must stay small enough for its densest possible object graph to fit
// comfortably. 8 MiB of text decodes to at most about 250 MB of heap and still
// holds some 60,000 tensor entries, which is the same budget gguf.js gives a
// header.
const MAX_HEADER_BYTES = 8 * 1024 * 1024;
// Tensor dtypes are short upper-case names such as F32, BF16, I64, BOOL or
// F8_E4M3. Other header text is not recorded as a dtype, and at most this
// many distinct dtypes are kept, so a crafted header cannot carry arbitrary
// or unbounded text into the BOM.
const DTYPE_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,15}$/u;
const MAX_DTYPES = 32;
// Bits per element for every dtype the reference implementation defines.
const DTYPE_BITS = new Map(
  Object.entries({
    BOOL: 8,
    F4: 4,
    F6_E2M3: 6,
    F6_E3M2: 6,
    U8: 8,
    I8: 8,
    F8_E5M2: 8,
    F8_E4M3: 8,
    F8_E8M0: 8,
    F8_E4M3FNUZ: 8,
    F8_E5M2FNUZ: 8,
    I16: 16,
    U16: 16,
    F16: 16,
    BF16: 16,
    I32: 32,
    U32: 32,
    F32: 32,
    C64: 64,
    F64: 64,
    I64: 64,
    U64: 64,
  }),
);
// `__metadata__.format` names the framework that wrote the file (pt, tf,
// flax, mlx, np). Only a short lower-case token is passed on.
const FORMAT_TOKEN_PATTERN = /^[a-z][a-z0-9_-]{0,15}$/u;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const JSON_WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d]);

/**
 * Read the JSON header of a safetensors file and check it against the format
 * rules: the tensors must tile the byte buffer without holes or overlaps, each
 * tensor's byte range must match its dtype and shape, and the file size must
 * equal the header length plus the buffer length.
 *
 * @param {string} filePath Path to a `.safetensors` file
 * @returns {{ok: true, header: Object}|{ok: false, reason: string}} Parsed
 *   header summary, or the reason the file was rejected
 */
export function inspectSafetensors(filePath) {
  const rejected = (reason) => {
    thoughtLog(`Rejecting the safetensors file ${filePath}: ${reason}.`);
    return { ok: false, reason };
  };
  let fd;
  try {
    const stats = statSync(filePath);
    if (!stats.isFile()) {
      return rejected("not a regular file");
    }
    if (stats.size < HEADER_LENGTH_BYTES) {
      return rejected("shorter than the 8-byte length prefix");
    }
    fd = openSync(filePath, "r");
    const lengthBuffer = Buffer.alloc(HEADER_LENGTH_BYTES);
    if (
      readSync(fd, lengthBuffer, 0, HEADER_LENGTH_BYTES, 0) !==
      HEADER_LENGTH_BYTES
    ) {
      return rejected("short read of the length prefix");
    }
    const declaredLength = lengthBuffer.readBigUInt64LE(0);
    if (declaredLength > BigInt(MAX_HEADER_BYTES)) {
      // The reference parser allows up to 100,000,000 bytes; this limit
      // protects the heap, see MAX_HEADER_BYTES.
      return rejected(
        `header length ${declaredLength} is above the ${MAX_HEADER_BYTES} byte limit`,
      );
    }
    const headerLength = Number(declaredLength);
    if (headerLength <= 0) {
      return rejected("empty header");
    }
    if (headerLength + HEADER_LENGTH_BYTES > stats.size) {
      return rejected("header length runs past the end of the file");
    }
    const headerBuffer = Buffer.alloc(headerLength);
    if (
      readSync(fd, headerBuffer, 0, headerLength, HEADER_LENGTH_BYTES) !==
      headerLength
    ) {
      return rejected("short read of the header");
    }
    let start = 0;
    while (start < headerLength && JSON_WHITESPACE.has(headerBuffer[start])) {
      start += 1;
    }
    if (headerBuffer[start] !== 0x7b) {
      return rejected("header does not start with '{'");
    }
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(headerBuffer);
    } catch {
      return rejected("header is not valid UTF-8");
    }
    let header;
    try {
      header = JSON.parse(text);
    } catch {
      return rejected("header is not valid JSON");
    }
    if (!header || typeof header !== "object" || Array.isArray(header)) {
      return rejected("header is not a JSON object");
    }
    if (hasDuplicateTopLevelKey(text)) {
      return rejected("header repeats a key");
    }
    const bufferSize = stats.size - HEADER_LENGTH_BYTES - headerLength;
    return summarizeHeader(header, bufferSize, rejected);
  } catch (error) {
    return rejected(`unreadable (${error?.code || "error"})`);
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore close failures
      }
    }
  }
}

/**
 * Read and validate the JSON header of a safetensors model file.
 *
 * @param {string} filePath Path to a `.safetensors` file
 * @returns {{
 *   metadata: Object,
 *   metadataKeyCount: number,
 *   format: string|undefined,
 *   tensorCount: number,
 *   dtypes: string[],
 *   totalParameters: number,
 *   dataBytes: number,
 *   unknownDtypeTensors: number,
 * } | undefined} Header summary, or undefined when the file is not a valid
 *   safetensors file
 */
export function readSafetensorsHeader(filePath) {
  const result = inspectSafetensors(filePath);
  return result.ok ? result.header : undefined;
}

/**
 * Report whether the top-level object of a JSON text repeats a key. JSON.parse
 * keeps the last of two equal keys, which would hide a second tensor entry.
 *
 * @param {string} text JSON text of a single object
 * @returns {boolean} true when a top-level key occurs twice
 */
function hasDuplicateTopLevelKey(text) {
  const seen = new Set();
  let depth = 0;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"') {
        end += text[end] === "\\" ? 2 : 1;
      }
      if (depth === 1) {
        let after = end + 1;
        while (after < text.length && /\s/u.test(text[after])) {
          after += 1;
        }
        if (text[after] === ":") {
          let key;
          try {
            key = JSON.parse(text.slice(index, end + 1));
          } catch {
            key = text.slice(index, end + 1);
          }
          if (seen.has(key)) {
            return true;
          }
          seen.add(key);
        }
      }
      index = end + 1;
      continue;
    }
    if (char === "{" || char === "[") {
      depth += 1;
    } else if (char === "}" || char === "]") {
      depth -= 1;
    }
    index += 1;
  }
  return false;
}

/**
 * Check a parsed header and summarize it.
 *
 * @param {Object} header Parsed safetensors JSON header
 * @param {number} bufferSize Bytes after the header
 * @param {Function} rejected Builds the rejection result
 * @returns {{ok: true, header: Object}|{ok: false, reason: string}} Result
 */
function summarizeHeader(header, bufferSize, rejected) {
  // `__metadata__` is a map of strings to strings. Entries of any other type
  // are invalid and are not read.
  const metadata = {};
  let metadataKeyCount = 0;
  if (
    header.__metadata__ &&
    typeof header.__metadata__ === "object" &&
    !Array.isArray(header.__metadata__)
  ) {
    for (const key of Object.keys(header.__metadata__)) {
      if (typeof header.__metadata__[key] === "string") {
        metadata[key] = header.__metadata__[key];
        metadataKeyCount += 1;
      }
    }
  }
  const format =
    typeof metadata.format === "string" &&
    FORMAT_TOKEN_PATTERN.test(metadata.format)
      ? metadata.format
      : undefined;
  const dtypes = new Set();
  const ranges = [];
  let totalParameters = 0n;
  let unknownDtypeTensors = 0;
  // Object.keys rather than Object.entries: the latter materializes a pair
  // array for every member up front, before the loop sees the first one.
  for (const key of Object.keys(header)) {
    if (key === "__metadata__") {
      continue;
    }
    const descriptor = header[key];
    if (!descriptor || typeof descriptor !== "object") {
      return rejected("a tensor entry is not an object");
    }
    if (typeof descriptor.dtype !== "string") {
      return rejected("a tensor entry has no dtype");
    }
    if (!Array.isArray(descriptor.shape)) {
      return rejected("a tensor entry has no shape");
    }
    const offsets = descriptor.data_offsets;
    if (
      !Array.isArray(offsets) ||
      offsets.length !== 2 ||
      !offsets.every((offset) => Number.isSafeInteger(offset) && offset >= 0)
    ) {
      return rejected("a tensor entry has invalid data_offsets");
    }
    const [begin, end] = offsets;
    if (end < begin) {
      return rejected("a tensor entry ends before it begins");
    }
    let elements = 1n;
    for (const dimension of descriptor.shape) {
      if (!Number.isSafeInteger(dimension) || dimension < 0) {
        return rejected("a tensor entry has an invalid dimension");
      }
      elements *= BigInt(dimension);
      if (elements > MAX_SAFE) {
        return rejected("a tensor entry has more elements than a safe integer");
      }
    }
    // A scalar (`shape: []`) holds one element.
    const bits = DTYPE_BITS.get(descriptor.dtype);
    if (bits === undefined) {
      // The byte size of an unknown dtype cannot be checked. The tensor still
      // takes part in the offset checks and its elements are counted.
      unknownDtypeTensors += 1;
    } else {
      const totalBits = elements * BigInt(bits);
      if (totalBits % 8n !== 0n) {
        return rejected("a tensor entry is not a whole number of bytes");
      }
      if (totalBits / 8n !== BigInt(end - begin)) {
        return rejected("a tensor entry's data_offsets do not match its shape");
      }
    }
    if (dtypes.size < MAX_DTYPES && DTYPE_NAME_PATTERN.test(descriptor.dtype)) {
      dtypes.add(descriptor.dtype);
    }
    totalParameters += elements;
    ranges.push([begin, end]);
  }
  if (totalParameters > MAX_SAFE) {
    return rejected("the parameter count is not a safe integer");
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cursor = 0;
  for (const [begin, end] of ranges) {
    if (begin !== cursor) {
      return rejected(
        begin > cursor
          ? "the tensor buffer has a hole"
          : "tensor data_offsets overlap",
      );
    }
    cursor = end;
  }
  if (cursor !== bufferSize) {
    return rejected(
      `the tensors cover ${cursor} bytes but the file holds ${bufferSize}`,
    );
  }
  return {
    ok: true,
    header: {
      metadata,
      metadataKeyCount,
      format,
      tensorCount: ranges.length,
      dtypes: Array.from(dtypes).sort(),
      totalParameters: Number(totalParameters),
      dataBytes: cursor,
      unknownDtypeTensors,
    },
  };
}
