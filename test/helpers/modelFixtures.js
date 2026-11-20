import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Builders for small model files used by the safetensors, ONNX and AI
// inventory tests, so no binary weights are stored in the repository.

const DTYPE_BYTES = { F16: 2, F32: 4, I8: 1, U8: 1, BF16: 2, I64: 8 };

/**
 * Write a safetensors file whose header and buffer agree with each other.
 *
 * @param {string} filePath Destination path; parent directories are created
 * @param {Object} tensors Map of tensor name to `{dtype, shape}`
 * @param {Object} [options] `metadata` for `__metadata__`, `padding` bytes of
 *   0x20 after the header, `bufferBytes` to override the buffer length
 */
export function writeSafetensorsFile(filePath, tensors, options = {}) {
  const header = {};
  if (options.metadata) {
    header.__metadata__ = options.metadata;
  }
  let offset = 0;
  for (const [name, tensor] of Object.entries(tensors)) {
    const elements = tensor.shape.reduce((product, size) => product * size, 1);
    const size = elements * DTYPE_BYTES[tensor.dtype];
    header[name] = {
      dtype: tensor.dtype,
      shape: tensor.shape,
      data_offsets: [offset, offset + size],
    };
    offset += size;
  }
  writeRawSafetensors(filePath, header, options.bufferBytes ?? offset, options);
}

/**
 * Write a safetensors file from an arbitrary header, with no consistency
 * checks, so tests can build invalid files.
 *
 * @param {string} filePath Destination path
 * @param {Object|string} header Header object or raw header text
 * @param {number} bufferBytes Length of the zero-filled buffer
 * @param {Object} [options] `padding` trailing 0x20 bytes, `leading` text
 */
export function writeRawSafetensors(
  filePath,
  header,
  bufferBytes,
  options = {},
) {
  const text =
    (options.leading || "") +
    (typeof header === "string" ? header : JSON.stringify(header)) +
    " ".repeat(options.padding || 0);
  const headerBuffer = Buffer.from(text, "utf-8");
  const lengthBuffer = Buffer.alloc(8);
  lengthBuffer.writeBigUInt64LE(BigInt(headerBuffer.length));
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    Buffer.concat([lengthBuffer, headerBuffer, Buffer.alloc(bufferBytes)]),
  );
}

/**
 * Encode a protobuf varint.
 *
 * @param {bigint|number} value Non-negative value, or a negative int64
 * @returns {Buffer} Encoded bytes
 */
export function varint(value) {
  let remaining = BigInt.asUintN(64, BigInt(value));
  const bytes = [];
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining) {
      byte |= 0x80;
    }
    bytes.push(byte);
  } while (remaining);
  return Buffer.from(bytes);
}

/** @returns {Buffer} A varint field */
export const pbVarint = (field, value) =>
  Buffer.concat([varint(field << 3), varint(value)]);

/** @returns {Buffer} A length-delimited field */
export const pbBytes = (field, payload) => {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  return Buffer.concat([varint((field << 3) | 2), varint(body.length), body]);
};

/** @returns {Buffer} A fixed 32-bit field */
export const pbFixed32 = (field) =>
  Buffer.concat([varint((field << 3) | 5), Buffer.alloc(4)]);

/** @returns {Buffer} A fixed 64-bit field */
export const pbFixed64 = (field) =>
  Buffer.concat([varint((field << 3) | 1), Buffer.alloc(8)]);

/** @returns {Buffer} An OperatorSetIdProto field 8 of a ModelProto */
export const pbOpset = (domain, version) =>
  pbBytes(8, Buffer.concat([pbBytes(1, domain), pbVarint(2, version)]));

/** @returns {Buffer} A StringStringEntryProto field 14 of a ModelProto */
export const pbMetadataProp = (key, value) =>
  pbBytes(14, Buffer.concat([pbBytes(1, key), pbBytes(2, value)]));

/**
 * Write an ONNX file from encoded ModelProto fields.
 *
 * @param {string} filePath Destination path; parent directories are created
 * @param {Buffer[]} fields Encoded fields in file order
 */
export function writeOnnxFile(filePath, fields) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, Buffer.concat(fields));
}

/**
 * A minimal valid ONNX model: ir_version 9, a pytorch producer and one opset.
 *
 * @param {Buffer[]} [extra] Fields appended after the defaults
 * @returns {Buffer[]} Encoded fields
 */
export const validOnnxFields = (extra = []) => [
  pbVarint(1, 9),
  pbBytes(2, "pytorch"),
  pbBytes(3, "2.4.0"),
  pbOpset("", 17),
  ...extra,
];
