/**
 * ANSI-aware text measurement, stripping, and wrapping helpers.
 *
 * Layer 0: this module imports nothing outside `lib/core`. It is the shared
 * home for the width/wrap primitives that `lib/inventory/table.js` (layer 2)
 * and `lib/core/ui.js` (layer 0) both need, so neither has to reach across a
 * layer boundary for them.
 */

/** String source of a regex matching ANSI escape sequences (CSI forms). */
const ANSI_PATTERN = "\\u001B\\[[0-?]*[ -/]*[@-~]";
/** Global regex constructed from {@link ANSI_PATTERN}, used to strip ANSI escapes. */
const ANSI_REGEX = new RegExp(ANSI_PATTERN, "g");
/** Regex matching Unicode combining mark characters (the `\p{Mark}` category). */
const COMBINING_MARK_REGEX = /\p{Mark}/u;

/**
 * Write the control and line-break characters of untrusted text (Unicode Cc,
 * U+2028 and U+2029) as JSON `\u` escapes, so that printing it to a terminal
 * cannot move the cursor, rewrite a line, or start a new one.
 *
 * @param {string} input Text taken from a document or another untrusted source
 * @returns {string} The text with control characters escaped
 */
export const escapeControlCharacters = (input) =>
  `${input ?? ""}`.replace(
    /[\p{Cc}\u2028\u2029]/gu,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

/**
 * Strip ANSI escape sequences from a string.
 *
 * @param {string} input Input possibly containing ANSI escapes
 * @returns {string} Visible text only
 */
export const stripAnsi = (input) => `${input ?? ""}`.replace(ANSI_REGEX, "");

/**
 * Detect full-width East-Asian-Wide and emoji code points so they occupy two
 * cells instead of one. The ranges mirror the EastAsianWidth+F/EV definitions
 * used by mainstream terminal width libraries.
 *
 * @param {number} codePoint Code point to test
 * @returns {boolean} True when the code point is double-width
 */
export const isFullWidthCodePoint = (codePoint) => {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
      (codePoint >= 0x1f900 && codePoint <= 0x1f9ff))
  );
};

/**
 * Measure the visible cell width of a string, accounting for ANSI escapes,
 * combining marks, and full-width code points.
 *
 * @param {string} input Input to measure
 * @returns {number} Visible width in terminal cells
 */
export const stringWidth = (input) => {
  const clean = stripAnsi(input);
  let width = 0;
  for (const char of clean) {
    if (char === "\n" || char === "\r") {
      continue;
    }
    if (COMBINING_MARK_REGEX.test(char)) {
      continue;
    }
    const codePoint = char.codePointAt(0);
    width += isFullWidthCodePoint(codePoint) ? 2 : 1;
  }
  return width;
};

/**
 * Pad/align text to a target visible width.
 *
 * @param {string} text Text to align
 * @param {number} width Target cell width
 * @param {"left"|"right"|"center"} [alignment="left"] Alignment
 * @returns {string} Padded text
 */
export const alignText = (text, width, alignment = "left") => {
  const visibleWidth = stringWidth(text);
  if (visibleWidth >= width) {
    return text;
  }
  const totalPad = width - visibleWidth;
  if (alignment === "right") {
    return `${" ".repeat(totalPad)}${text}`;
  }
  if (alignment === "center") {
    const left = Math.floor(totalPad / 2);
    const right = totalPad - left;
    return `${" ".repeat(left)}${text}${" ".repeat(right)}`;
  }
  return `${text}${" ".repeat(totalPad)}`;
};

/**
 * Split a single line into ANSI and non-ANSI tokens, preserving the escape
 * sequences so wrappers can re-emit them attached to the right chunk.
 *
 * @param {string} line Input line
 * @returns {{isAnsi: boolean, value: string}[]} Tokens in order
 */
export const splitAnsiTokens = (line) => {
  const tokens = [];
  const ansiRegex = new RegExp(ANSI_PATTERN, "g");
  let cursor = 0;
  for (const match of line.matchAll(ansiRegex)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      tokens.push({ isAnsi: false, value: line.slice(cursor, index) });
    }
    tokens.push({ isAnsi: true, value: match[0] });
    cursor = index + match[0].length;
  }
  if (cursor < line.length) {
    tokens.push({ isAnsi: false, value: line.slice(cursor) });
  }
  return tokens;
};

/**
 * Wrap a single line by character count, keeping ANSI sequences attached to
 * the current chunk.
 *
 * @param {string} line Input line (no embedded newlines)
 * @param {number} width Target cell width
 * @returns {string[]} Wrapped lines
 */
export const wrapLineByChars = (line, width) => {
  if (line === "") {
    return [""];
  }
  if (width <= 0 || stringWidth(line) <= width) {
    return [line];
  }
  const wrapped = [];
  let chunk = "";
  let chunkWidth = 0;
  for (const token of splitAnsiTokens(line)) {
    if (token.isAnsi) {
      chunk += token.value;
      continue;
    }
    for (const char of token.value) {
      const charWidth = stringWidth(char);
      if (chunkWidth + charWidth > width && chunk) {
        wrapped.push(chunk);
        chunk = "";
        chunkWidth = 0;
      }
      chunk += char;
      chunkWidth += charWidth;
    }
  }
  if (chunk) {
    wrapped.push(chunk);
  }
  return wrapped.length ? wrapped : [""];
};

/**
 * Wrap a single line by word boundaries, falling back to character wrapping
 * for words longer than the width.
 *
 * @param {string} line Input line
 * @param {number} width Target cell width
 * @returns {string[]} Wrapped lines
 */
export const wrapLineByWords = (line, width) => {
  if (!line) {
    return [""];
  }
  if (width <= 0 || stringWidth(line) <= width) {
    return [line];
  }
  const words = line.split(/\s+/).filter(Boolean);
  if (!words.length) {
    return wrapLineByChars(line, width);
  }
  const wrapped = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (stringWidth(candidate) <= width) {
      current = candidate;
      continue;
    }
    if (current) {
      wrapped.push(current);
    }
    if (stringWidth(word) > width) {
      wrapped.push(...wrapLineByChars(word, width));
      current = "";
    } else {
      current = word;
    }
  }
  if (current) {
    wrapped.push(current);
  }
  return wrapped.length ? wrapped : [""];
};

export { ANSI_PATTERN, ANSI_REGEX, COMBINING_MARK_REGEX };
