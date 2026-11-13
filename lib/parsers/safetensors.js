import { closeSync, openSync, readSync, statSync } from "node:fs";

// A safetensors file begins with an 8-byte little-endian unsigned integer
// giving the byte length of a JSON header, followed by that JSON header, and
// then the raw tensor buffers. Only the header is parsed here: tensor data is
// never read, so inspection stays cheap and side-effect free.
const HEADER_LENGTH_BYTES = 8;
// A header longer than this almost certainly indicates a non-safetensors file
// or a corrupt/hostile input; refuse to allocate for it.
const MAX_HEADER_BYTES = 100 * 1024 * 1024;
// Tensor dtypes are short upper-case names such as F32, BF16, I64, BOOL or
// F8_E4M3. Other header text is not recorded as a dtype, and at most this
// many distinct dtypes are kept, so a crafted header cannot carry arbitrary
// or unbounded text into the BOM.
const DTYPE_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,15}$/u;
const MAX_DTYPES = 32;

/**
 * Read and parse the JSON header of a safetensors model file.
 *
 * Only the leading header is read; tensor payloads are ignored. The returned
 * object separates the optional `__metadata__` map from the per-tensor
 * descriptors.
 *
 * @param {string} filePath Path to a `.safetensors` file
 * @returns {{
 *   metadata: Object,
 *   tensorCount: number,
 *   dtypes: string[],
 *   totalParameters: number,
 * } | undefined} Parsed header summary, or undefined when it cannot be read
 */
export function readSafetensorsHeader(filePath) {
  let fd;
  try {
    const stats = statSync(filePath);
    if (stats.size < HEADER_LENGTH_BYTES) {
      return undefined;
    }
    fd = openSync(filePath, "r");
    const lengthBuffer = Buffer.alloc(HEADER_LENGTH_BYTES);
    readSync(fd, lengthBuffer, 0, HEADER_LENGTH_BYTES, 0);
    const headerLength = Number(lengthBuffer.readBigUInt64LE(0));
    if (
      !Number.isSafeInteger(headerLength) ||
      headerLength <= 0 ||
      headerLength > MAX_HEADER_BYTES ||
      headerLength + HEADER_LENGTH_BYTES > stats.size
    ) {
      return undefined;
    }
    const headerBuffer = Buffer.alloc(headerLength);
    readSync(fd, headerBuffer, 0, headerLength, HEADER_LENGTH_BYTES);
    const header = JSON.parse(headerBuffer.toString("utf-8"));
    if (!header || typeof header !== "object") {
      return undefined;
    }
    return summarizeHeader(header);
  } catch {
    return undefined;
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
 * Summarize a parsed safetensors header into metadata and tensor statistics.
 *
 * @param {Object} header Parsed safetensors JSON header
 * @returns {{
 *   metadata: Object,
 *   tensorCount: number,
 *   dtypes: string[],
 *   totalParameters: number,
 * }} Header summary
 */
function summarizeHeader(header) {
  const metadata =
    header.__metadata__ && typeof header.__metadata__ === "object"
      ? header.__metadata__
      : {};
  const dtypes = new Set();
  let tensorCount = 0;
  let totalParameters = 0;
  for (const [key, descriptor] of Object.entries(header)) {
    if (
      key === "__metadata__" ||
      !descriptor ||
      typeof descriptor !== "object"
    ) {
      continue;
    }
    tensorCount++;
    if (
      typeof descriptor.dtype === "string" &&
      dtypes.size < MAX_DTYPES &&
      DTYPE_NAME_PATTERN.test(descriptor.dtype)
    ) {
      dtypes.add(descriptor.dtype);
    }
    if (Array.isArray(descriptor.shape) && descriptor.shape.length) {
      const elements = descriptor.shape.reduce(
        (product, dimension) =>
          Number.isFinite(dimension) ? product * dimension : product,
        1,
      );
      if (Number.isFinite(elements)) {
        totalParameters += elements;
      }
    }
  }
  return {
    metadata,
    tensorCount,
    dtypes: Array.from(dtypes).sort(),
    totalParameters,
  };
}
