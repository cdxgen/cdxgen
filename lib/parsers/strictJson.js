/**
 * Strict JSON reading for signed documents.
 *
 * JSF signs the RFC 8785 (JCS) form of a document, and JCS is defined over
 * I-JSON (RFC 7493) input. `JSON.parse` and lenient UTF-8 decoding accept
 * things I-JSON rules out, and each lets two parsers read different values
 * from the same signed bytes:
 *
 * - a member name repeated within one object, where `JSON.parse` keeps the last
 *   value and other parsers keep the first or refuse the document;
 * - a number an IEEE 754 double cannot hold exactly, which JavaScript rounds
 *   while arbitrary-precision parsers keep every digit;
 * - bytes that are not UTF-8, which lenient decoders turn into U+FFFD while
 *   others refuse them or read another encoding;
 * - an unpaired UTF-16 surrogate escape, which some parsers keep and others
 *   replace.
 *
 * {@link parseStrictJson} rejects all of them, so the values a verifier checks
 * are the values every consumer of the document reads.
 */

import { escapeControlCharacters } from "../core/text.js";

/**
 * Raised when JSON text is well-formed but breaks one of the rules above.
 */
export class StrictJsonError extends Error {
  /**
   * @param {string} message - Description of the problem
   * @param {string} pointer - RFC 6901 JSON Pointer to the offending member or value
   */
  constructor(message, pointer) {
    super(message);
    this.name = "StrictJsonError";
    this.pointer = pointer;
  }
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_OBJECT = 0x7b;
const CLOSE_OBJECT = 0x7d;
const OPEN_ARRAY = 0x5b;
const CLOSE_ARRAY = 0x5d;
const COMMA = 0x2c;
const MINUS = 0x2d;
const PLUS = 0x2b;
const DOT = 0x2e;
const DIGIT_0 = 0x30;
const DIGIT_9 = 0x39;
const LOWER_E = 0x65;
const UPPER_E = 0x45;
const LOWER_U = 0x75;

// Integers with at most 15 digits are below 2^53, so a double holds them exactly.
const EXACT_INTEGER_DIGITS = 15;
const MAX_SHOWN_NUMBER_LENGTH = 40;

function isDigit(code) {
  return code >= DIGIT_0 && code <= DIGIT_9;
}

function escapePointerToken(token) {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
}

function pointerOf(frames, depth) {
  let pointer = "";
  for (let i = 0; i < depth; i++) {
    const frame = frames[i];
    pointer += `/${frame.object ? escapePointerToken(frame.key) : frame.index}`;
  }
  return pointer;
}

function showNumber(token) {
  return token.length > MAX_SHOWN_NUMBER_LENGTH
    ? `${token.slice(0, MAX_SHOWN_NUMBER_LENGTH)}…`
    : token;
}

/**
 * Reduces a JSON or ECMAScript number literal to its exact decimal value as a
 * significand without leading or trailing zeros and a power-of-ten exponent.
 * The sign is ignored: a finite non-zero double keeps the sign of its literal,
 * and zero compares equal to negative zero.
 */
function decimalValue(literal) {
  let i = literal.charCodeAt(0) === MINUS ? 1 : 0;
  let digits = "";
  let fractionLength = 0;
  while (i < literal.length && isDigit(literal.charCodeAt(i))) {
    digits += literal[i++];
  }
  if (literal.charCodeAt(i) === DOT) {
    i++;
    while (i < literal.length && isDigit(literal.charCodeAt(i))) {
      digits += literal[i++];
      fractionLength++;
    }
  }
  let exponent = 0;
  const marker = literal.charCodeAt(i);
  if (marker === LOWER_E || marker === UPPER_E) {
    exponent = Number(literal.slice(i + 1));
  }
  let start = 0;
  while (start < digits.length && digits.charCodeAt(start) === DIGIT_0) {
    start++;
  }
  let end = digits.length;
  while (end > start && digits.charCodeAt(end - 1) === DIGIT_0) {
    end--;
  }
  if (start === end) {
    return { significand: "", exponent: 0 };
  }
  return {
    significand: digits.slice(start, end),
    exponent: exponent - fractionLength + (digits.length - end),
  };
}

/**
 * Returns a description of why a JSON number token does not denote exactly the
 * double that `JSON.parse` produces for it, or undefined when it does.
 */
function numberProblem(token) {
  const negative = token.charCodeAt(0) === MINUS;
  const digitCount = token.length - (negative ? 1 : 0);
  if (digitCount <= EXACT_INTEGER_DIGITS) {
    let integer = true;
    for (let i = negative ? 1 : 0; i < token.length; i++) {
      if (!isDigit(token.charCodeAt(i))) {
        integer = false;
        break;
      }
    }
    if (integer) {
      return undefined;
    }
  }
  const value = Number(token);
  if (!Number.isFinite(value)) {
    return "is outside the range of an IEEE 754 double";
  }
  const written = decimalValue(token);
  const parsed = decimalValue(String(value));
  if (
    written.significand === parsed.significand &&
    (written.significand === "" || written.exponent === parsed.exponent)
  ) {
    return undefined;
  }
  return `cannot be held exactly by an IEEE 754 double; JSON.parse reads it as ${String(value)}`;
}

function isHighSurrogate(unit) {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit) {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

/**
 * Finds the end of the string token starting at `start`, and whether it holds
 * escapes or a UTF-16 surrogate, written raw or as `\u` escape, without its
 * other half.
 */
function stringEnd(text, start) {
  let i = start + 1;
  let escaped = false;
  let unpaired = false;
  let pendingHigh = false;
  for (;;) {
    const code = text.charCodeAt(i);
    if (code === QUOTE) {
      return { end: i + 1, escaped, unpaired: unpaired || pendingHigh };
    }
    let unit = code;
    let width = 1;
    if (code === BACKSLASH) {
      escaped = true;
      if (text.charCodeAt(i + 1) === LOWER_U) {
        unit = Number.parseInt(text.slice(i + 2, i + 6), 16);
        width = 6;
      } else {
        unit = 0;
        width = 2;
      }
    }
    const low = isLowSurrogate(unit);
    if (pendingHigh !== low) {
      unpaired = true;
    }
    pendingHigh = isHighSurrogate(unit);
    i += width;
  }
}

function numberEnd(text, start) {
  let i = start;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (
      isDigit(code) ||
      code === MINUS ||
      code === PLUS ||
      code === DOT ||
      code === LOWER_E ||
      code === UPPER_E
    ) {
      i++;
    } else {
      break;
    }
  }
  return i;
}

/**
 * Walks well-formed JSON text without recursion and throws a StrictJsonError
 * at the first repeated member name, inexact number, or unpaired surrogate.
 */
function checkStrictJson(text) {
  const frames = [];
  let i = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code === OPEN_OBJECT || code === OPEN_ARRAY) {
      frames.push({
        object: code === OPEN_OBJECT,
        names: code === OPEN_OBJECT ? new Set() : undefined,
        key: undefined,
        index: 0,
        expectName: code === OPEN_OBJECT,
      });
      i++;
    } else if (code === CLOSE_OBJECT || code === CLOSE_ARRAY) {
      frames.pop();
      i++;
    } else if (code === COMMA) {
      const top = frames.at(-1);
      if (top.object) {
        top.expectName = true;
      } else {
        top.index++;
      }
      i++;
    } else if (code === QUOTE) {
      const { end, escaped, unpaired } = stringEnd(text, i);
      const top = frames.at(-1);
      const isName = Boolean(top?.object && top.expectName);
      if (unpaired) {
        const pointer = isName
          ? `${pointerOf(frames, frames.length - 1)}/${escapePointerToken(JSON.parse(text.slice(i, end)))}`
          : pointerOf(frames, frames.length);
        throw new StrictJsonError(
          `The ${isName ? "member name" : "string"} at ${escapeControlCharacters(pointer) || "the document root"} holds an unpaired UTF-16 surrogate, which JSON parsers keep, replace, or reject differently.`,
          pointer,
        );
      }
      if (isName) {
        const name = escaped
          ? JSON.parse(text.slice(i, end))
          : text.slice(i + 1, end - 1);
        if (top.names.has(name)) {
          const pointer = `${pointerOf(frames, frames.length - 1)}/${escapePointerToken(name)}`;
          throw new StrictJsonError(
            `Duplicate member name at ${escapeControlCharacters(pointer)}. JSON parsers disagree on which of the repeated values the document holds.`,
            pointer,
          );
        }
        top.names.add(name);
        top.key = name;
        top.expectName = false;
      }
      i = end;
    } else if (code === MINUS || isDigit(code)) {
      const end = numberEnd(text, i);
      const token = text.slice(i, end);
      const problem = numberProblem(token);
      if (problem) {
        const pointer = pointerOf(frames, frames.length);
        throw new StrictJsonError(
          `The number ${showNumber(token)} at ${escapeControlCharacters(pointer) || "the document root"} ${problem}.`,
          pointer,
        );
      }
      i = end;
    } else {
      i++;
    }
  }
}

/**
 * Parses JSON the way `JSON.parse` does, but refuses bytes that are not UTF-8,
 * repeated member names within an object, numbers that an IEEE 754 double
 * cannot hold exactly, and unpaired UTF-16 surrogates.
 *
 * Pass the raw bytes of a document rather than text decoded elsewhere, so that
 * invalid UTF-8 is detected instead of being replaced by U+FFFD.
 *
 * @param {string|Uint8Array} input - JSON text, or its UTF-8 bytes
 * @returns {any} - The parsed value
 * @throws {SyntaxError} When the text is not JSON
 * @throws {StrictJsonError} When the input breaks one of the rules above
 */
export function parseStrictJson(input) {
  let text = input;
  if (typeof input !== "string") {
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        input,
      );
    } catch {
      throw new StrictJsonError("The document is not valid UTF-8.", "");
    }
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    // JSON.parse quotes the text around the character it stopped at.
    error.message = escapeControlCharacters(error.message);
    throw error;
  }
  checkStrictJson(text);
  return value;
}
