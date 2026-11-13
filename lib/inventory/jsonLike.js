/**
 * Returns whether the quote at `index` is escaped by an odd-length run of
 * backslashes immediately preceding it.
 *
 * @param {string} raw Raw JSON-like text being scanned
 * @param {number} index Index of the quote character to evaluate
 * @returns {boolean} `true` when the quote is escaped and should not terminate
 * the current string literal
 */
function isEscapedQuote(raw, index) {
  let backslashCount = 0;
  let lookBehind = index - 1;
  while (lookBehind >= 0 && raw[lookBehind] === "\\") {
    backslashCount += 1;
    lookBehind -= 1;
  }
  return backslashCount % 2 === 1;
}

/**
 * Strip line (`//`) and block comments from JSON-like text without altering
 * string literals.
 *
 * @param {string} raw Raw JSON-like text
 * @returns {string} Text with comments removed
 */
export function stripJsonComments(raw) {
  // Kept text is copied as whole slices rather than one character at a time,
  // which would hold a heap object per character until the result is flattened.
  const parts = [];
  let runStart = 0;
  let inString = false;
  let stringQuote = "";
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    const nextChar = raw[index + 1];
    if (inString) {
      if (char === stringQuote && !isEscapedQuote(raw, index)) {
        inString = false;
        stringQuote = "";
      }
      continue;
    }
    if (char === '"' || char === "'") {
      inString = true;
      stringQuote = char;
      continue;
    }
    if (char === "/" && nextChar === "/") {
      parts.push(raw.slice(runStart, index));
      while (index < raw.length && raw[index] !== "\n") {
        index += 1;
      }
      // The newline ending the comment is kept.
      runStart = index;
      continue;
    }
    if (char === "/" && nextChar === "*") {
      parts.push(raw.slice(runStart, index));
      index += 2;
      while (
        index < raw.length &&
        !(raw[index] === "*" && raw[index + 1] === "/")
      ) {
        index += 1;
      }
      index += 1;
      runStart = index + 1;
    }
  }
  parts.push(raw.slice(runStart));
  return parts.join("");
}

/**
 * Remove trailing commas before `}` or `]` without altering string literals.
 *
 * @param {string} raw Raw JSON-like text
 * @returns {string} Text with trailing commas removed
 */
export function stripJsonTrailingCommas(raw) {
  const parts = [];
  let runStart = 0;
  let inString = false;
  let stringQuote = "";
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    if (inString) {
      if (char === stringQuote && !isEscapedQuote(raw, index)) {
        inString = false;
        stringQuote = "";
      }
      continue;
    }
    if (char === '"' || char === "'") {
      inString = true;
      stringQuote = char;
      continue;
    }
    if (char === ",") {
      let lookAhead = index + 1;
      while (lookAhead < raw.length && /\s/u.test(raw[lookAhead])) {
        lookAhead += 1;
      }
      if (raw[lookAhead] === "}" || raw[lookAhead] === "]") {
        parts.push(raw.slice(runStart, index));
        runStart = index + 1;
      }
    }
  }
  parts.push(raw.slice(runStart));
  return parts.join("");
}

/**
 * Parse JSONC/JSON5-like text (comments and trailing commas allowed) into a value.
 *
 * @param {string} raw Raw JSON-like text
 * @returns {*} Parsed value; throws when the normalized text is not valid JSON
 */
export function parseJsonLike(raw) {
  return JSON.parse(stripJsonTrailingCommas(stripJsonComments(raw)));
}
