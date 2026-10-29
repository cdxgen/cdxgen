import { Buffer, constants } from "node:buffer";
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";

/**
 * The largest file that `JSON.parse(readFileSync(file, "utf-8"))` can always
 * decode. V8 caps a string at this many UTF-16 code units, and UTF-8 never
 * decodes to more code units than it has bytes.
 */
export const MAX_JSON_TEXT_BYTES = constants.MAX_STRING_LENGTH;

// A value at most this large is decoded with one JSON.parse. A larger object is
// decoded member by member, and a larger array in runs of elements of about
// this size, so no string ever holds more than one run.
const BATCH_BYTES = 16 * 1024 * 1024;
const CHUNK_BYTES = 8 * 1024 * 1024;

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const COLON = 0x3a;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;

const isWhitespace = (byte) =>
  byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09;

// "-", a digit, or the first letter of true, false or null.
const isScalarStart = (byte) =>
  byte === 0x2d ||
  (byte >= 0x30 && byte <= 0x39) ||
  byte === 0x74 ||
  byte === 0x66 ||
  byte === 0x6e;

// Assign like JSON.parse does: "__proto__" becomes an own property instead of
// replacing the prototype.
function defineMember(target, key, value) {
  if (key === "__proto__") {
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
  } else {
    target[key] = value;
  }
}

function applySpec(value, spec) {
  if (!spec || value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    let elements = value;
    if (spec.map) {
      const mapped = [];
      for (const element of elements) {
        const transformed = spec.map(element);
        if (transformed !== undefined) {
          mapped.push(transformed);
        }
      }
      elements = mapped;
    }
    return spec.filter
      ? elements.filter((element) => spec.filter(element))
      : elements;
  }
  if (!spec.members) {
    return value;
  }
  const picked = {};
  for (const key of Object.keys(value)) {
    if (Object.hasOwn(spec.members, key)) {
      defineMember(picked, key, applySpec(value[key], spec.members[key]));
    }
  }
  return picked;
}

/**
 * Reads bytes [start, end) of an open file a chunk at a time, and can capture
 * the bytes of a span that crosses chunk boundaries.
 */
class ByteCursor {
  constructor(fd, start, end, chunkBytes) {
    this.fd = fd;
    this.end = end;
    this.buf = Buffer.allocUnsafe(
      Math.max(1, Math.min(chunkBytes, end - start)),
    );
    this.bufStart = start;
    this.len = 0;
    this.pos = 0;
    this.captureFrom = -1;
    this.parts = [];
    this.partsBytes = 0;
  }

  get offset() {
    return this.bufStart + this.pos;
  }

  fill() {
    if (this.captureFrom >= 0) {
      if (this.len > this.captureFrom) {
        const part = Buffer.from(this.buf.subarray(this.captureFrom, this.len));
        this.parts.push(part);
        this.partsBytes += part.length;
      }
      this.captureFrom = 0;
    }
    this.bufStart += this.len;
    const want = Math.min(this.buf.length, this.end - this.bufStart);
    this.len =
      want > 0 ? readSync(this.fd, this.buf, 0, want, this.bufStart) : 0;
    this.pos = 0;
    return this.len > 0;
  }

  peek() {
    if (this.pos >= this.len && !this.fill()) {
      return -1;
    }
    return this.buf[this.pos];
  }

  // The next byte that is not whitespace, left unconsumed; -1 at the end.
  peekToken() {
    for (;;) {
      const byte = this.peek();
      if (!isWhitespace(byte)) {
        return byte;
      }
      this.pos++;
    }
  }

  nextToken() {
    const byte = this.peekToken();
    if (byte >= 0) {
      this.pos++;
    }
    return byte;
  }

  fail(message) {
    throw new SyntaxError(`${message} at byte ${this.offset} of the JSON file`);
  }

  beginCapture() {
    this.peek();
    this.captureFrom = this.pos;
    this.parts = [];
    this.partsBytes = 0;
  }

  capturedBytes() {
    return this.partsBytes + this.pos - this.captureFrom;
  }

  // The captured text up to `until`, an index into the current chunk.
  endCapture(until = this.pos) {
    const tail = this.buf.subarray(this.captureFrom, until);
    const text = this.parts.length
      ? Buffer.concat([...this.parts, tail]).toString("utf8")
      : tail.toString("utf8");
    this.captureFrom = -1;
    this.parts = [];
    this.partsBytes = 0;
    return text;
  }

  // Move past one JSON value without decoding it. Brackets are balanced and
  // strings are honoured, but the value is not otherwise validated; whatever
  // decodes it later does that.
  skipValue() {
    const first = this.peekToken();
    if (first === QUOTE) {
      this.pos++;
      this.skipStringBody();
      return;
    }
    if (first === OPEN_BRACE || first === OPEN_BRACKET) {
      this.skipContainer();
      return;
    }
    if (!isScalarStart(first)) {
      this.fail("Unexpected token");
    }
    // A number, true, false or null runs to the next delimiter.
    for (;;) {
      const byte = this.peek();
      if (
        byte < 0 ||
        byte === COMMA ||
        byte === CLOSE_BRACE ||
        byte === CLOSE_BRACKET ||
        isWhitespace(byte)
      ) {
        return;
      }
      this.pos++;
    }
  }

  skipStringBody() {
    let escaped = false;
    for (;;) {
      if (this.pos >= this.len && !this.fill()) {
        this.fail("Unterminated string");
      }
      const { buf, len } = this;
      for (let i = this.pos; i < len; i++) {
        const byte = buf[i];
        if (escaped) {
          escaped = false;
        } else if (byte === BACKSLASH) {
          escaped = true;
        } else if (byte === QUOTE) {
          this.pos = i + 1;
          return;
        }
      }
      this.pos = len;
    }
  }

  skipContainer() {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (;;) {
      if (this.pos >= this.len && !this.fill()) {
        this.fail("Unterminated container");
      }
      const { buf, len } = this;
      for (let i = this.pos; i < len; i++) {
        const byte = buf[i];
        if (inString) {
          if (escaped) {
            escaped = false;
          } else if (byte === BACKSLASH) {
            escaped = true;
          } else if (byte === QUOTE) {
            inString = false;
          }
        } else if (byte === QUOTE) {
          inString = true;
        } else if (byte === OPEN_BRACE || byte === OPEN_BRACKET) {
          depth++;
        } else if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) {
          depth--;
          if (depth === 0) {
            this.pos = i + 1;
            return;
          }
        }
      }
      this.pos = len;
    }
  }
}

// The members of the object at the cursor, as { key, start, end } byte ranges
// of their values, in file order. A repeated key keeps its first position and
// its last range, which is what JSON.parse does. With `stopAt`, the scan ends
// at the first member of that name, leaving the rest of the object unread.
function scanObjectMembers(cursor, stopAt = undefined) {
  if (cursor.nextToken() !== OPEN_BRACE) {
    cursor.fail("Expected an object");
  }
  const members = new Map();
  if (cursor.peekToken() === CLOSE_BRACE) {
    cursor.pos++;
    return members;
  }
  for (;;) {
    if (cursor.peekToken() !== QUOTE) {
      cursor.fail("Expected a member name");
    }
    cursor.beginCapture();
    cursor.skipValue();
    const key = JSON.parse(cursor.endCapture());
    if (cursor.nextToken() !== COLON) {
      cursor.fail("Expected ':'");
    }
    cursor.peekToken();
    const start = cursor.offset;
    cursor.skipValue();
    members.set(key, { start, end: cursor.offset });
    if (key === stopAt) {
      return members;
    }
    const delimiter = cursor.nextToken();
    if (delimiter === CLOSE_BRACE) {
      return members;
    }
    if (delimiter !== COMMA) {
      cursor.fail("Expected ',' or '}'");
    }
  }
}

// Decode the array at the cursor in runs of whole elements, mapping each one
// through `spec.map` (an undefined result drops it) and keeping those that
// `spec.filter` accepts.
function readArrayElements(cursor, spec, batchBytes) {
  if (cursor.nextToken() !== OPEN_BRACKET) {
    cursor.fail("Expected an array");
  }
  const elements = [];
  if (cursor.peekToken() === CLOSE_BRACKET) {
    cursor.pos++;
    return elements;
  }
  const flush = () => {
    // Everything captured but the delimiter just consumed.
    for (const element of JSON.parse(
      `[${cursor.endCapture(cursor.pos - 1)}]`,
    )) {
      const mapped = spec?.map ? spec.map(element) : element;
      if (mapped === undefined) {
        continue;
      }
      if (!spec?.filter || spec.filter(mapped)) {
        elements.push(mapped);
      }
    }
  };
  cursor.beginCapture();
  for (;;) {
    cursor.skipValue();
    const delimiter = cursor.nextToken();
    if (delimiter === CLOSE_BRACKET) {
      flush();
      return elements;
    }
    if (delimiter !== COMMA) {
      cursor.fail("Expected ',' or ']'");
    }
    if (cursor.capturedBytes() >= batchBytes) {
      flush();
      cursor.peekToken();
      cursor.beginCapture();
    }
  }
}

function readBytes(fd, start, end) {
  const bytes = Buffer.allocUnsafe(end - start);
  let read = 0;
  while (read < bytes.length) {
    const count = readSync(fd, bytes, read, bytes.length - read, start + read);
    if (!count) {
      throw new SyntaxError("Unexpected end of the JSON file");
    }
    read += count;
  }
  return bytes.toString("utf8");
}

function decodeRange(fd, start, end, spec, options) {
  if (end - start <= options.batchBytes) {
    return applySpec(JSON.parse(readBytes(fd, start, end)), spec);
  }
  const cursor = new ByteCursor(fd, start, end, options.chunkBytes);
  const first = cursor.peekToken();
  let value;
  if (first === OPEN_BRACE) {
    value = {};
    for (const [key, range] of scanObjectMembers(cursor)) {
      if (spec?.members && !Object.hasOwn(spec.members, key)) {
        continue;
      }
      defineMember(
        value,
        key,
        decodeRange(fd, range.start, range.end, spec?.members?.[key], options),
      );
    }
  } else if (first === OPEN_BRACKET) {
    value = readArrayElements(cursor, spec, options.batchBytes);
  } else {
    // A string or number this large has no smaller parts; JSON.parse reports
    // it the way it would for the whole file.
    return JSON.parse(readBytes(fd, start, end));
  }
  if (cursor.peekToken() !== -1) {
    cursor.fail("Unexpected data after the JSON value");
  }
  return value;
}

function withFile(filePath, callback) {
  const fd = openSync(filePath, "r");
  try {
    return callback(fd);
  } finally {
    closeSync(fd);
  }
}

function resolveOptions(options = {}) {
  return {
    batchBytes: options.batchBytes ?? BATCH_BYTES,
    chunkBytes: options.chunkBytes ?? CHUNK_BYTES,
  };
}

/**
 * Locate the value of each member of the top-level object in a JSON file,
 * without decoding any of them.
 *
 * @param {string} filePath JSON file whose top-level value is an object
 * @param {Object} [options] Chunk size override, for tests
 * @returns {Map<string, {start: number, end: number}>} Byte range of each member's value, in file order. A repeated key keeps its last value, as JSON.parse does.
 * @throws {SyntaxError} When the top-level value is not a well-formed object
 */
export function indexJsonObject(filePath, options = {}) {
  const { chunkBytes } = resolveOptions(options);
  return withFile(filePath, (fd) => {
    const cursor = new ByteCursor(fd, 0, statSync(filePath).size, chunkBytes);
    const members = scanObjectMembers(cursor);
    if (cursor.peekToken() !== -1) {
      cursor.fail("Unexpected data after the JSON value");
    }
    return members;
  });
}

/**
 * Decode one member of the top-level object in a JSON file, reading the file
 * only up to the end of that member. A member near the start of a large file
 * costs a few bounded reads, however large the rest of the file is; the rest
 * is not checked for well-formedness.
 *
 * @param {string} filePath JSON file whose top-level value is an object
 * @param {string} name Member to decode
 * @param {Object} [options] Batch and chunk size overrides, for tests
 * @returns {*} The decoded value, or undefined when the object has no such member
 * @throws {SyntaxError} When the object is malformed before the member ends
 */
export function readJsonMember(filePath, name, options = {}) {
  const resolved = resolveOptions(options);
  return withFile(filePath, (fd) => {
    const cursor = new ByteCursor(
      fd,
      0,
      statSync(filePath).size,
      resolved.chunkBytes,
    );
    const range = scanObjectMembers(cursor, name).get(name);
    return range
      ? decodeRange(fd, range.start, range.end, undefined, resolved)
      : undefined;
  });
}

/**
 * Decode the JSON value stored in a byte range of a file, without ever holding
 * more than a bounded run of it in one string.
 *
 * `spec` narrows what is kept. `{ members: { name: spec } }` keeps only the
 * named members of an object, each narrowed by its own spec. `{ map }`
 * transforms each element of an array, an undefined result dropping it, and
 * `{ filter }` keeps the mapped elements that `filter(element)` accepts.
 * Anything else keeps the whole value.
 *
 * @param {string} filePath JSON file
 * @param {{start: number, end: number}} range Byte range of the value, such as one returned by indexJsonObject
 * @param {Object} [spec] What to keep
 * @param {Object} [options] Batch and chunk size overrides, for tests
 * @returns {*} The decoded value
 * @throws {SyntaxError} When the value is malformed
 */
export function readJsonRange(filePath, range, spec = undefined, options = {}) {
  return withFile(filePath, (fd) =>
    decodeRange(fd, range.start, range.end, spec, resolveOptions(options)),
  );
}

/**
 * Parse a JSON file of any size. A file that fits in one string is decoded
 * with JSON.parse, and a larger one is streamed through readJsonRange, so the
 * result is the same either way.
 *
 * @param {string} filePath JSON file
 * @param {Object} [spec] What to keep, as for readJsonRange
 * @param {Object} [options] Size overrides, for tests: maxTextBytes, batchBytes, chunkBytes
 * @returns {*} The decoded value
 * @throws {SyntaxError} When the file is malformed
 */
export function readJsonFile(filePath, spec = undefined, options = {}) {
  const size = statSync(filePath).size;
  if (size <= (options.maxTextBytes ?? MAX_JSON_TEXT_BYTES)) {
    return applySpec(JSON.parse(readFileSync(filePath, "utf-8")), spec);
  }
  return readJsonRange(filePath, { start: 0, end: size }, spec, options);
}
