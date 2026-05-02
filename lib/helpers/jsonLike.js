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

export function stripJsonComments(raw) {
  let output = "";
  let inString = false;
  let stringQuote = "";
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    const nextChar = raw[index + 1];
    if (inString) {
      output += char;
      if (char === stringQuote && !isEscapedQuote(raw, index)) {
        inString = false;
        stringQuote = "";
      }
      continue;
    }
    if (char === '"' || char === "'") {
      inString = true;
      stringQuote = char;
      output += char;
      continue;
    }
    if (char === "/" && nextChar === "/") {
      while (index < raw.length && raw[index] !== "\n") {
        index += 1;
      }
      if (index < raw.length) {
        output += raw[index];
      }
      continue;
    }
    if (char === "/" && nextChar === "*") {
      index += 2;
      while (
        index < raw.length &&
        !(raw[index] === "*" && raw[index + 1] === "/")
      ) {
        index += 1;
      }
      index += 1;
      continue;
    }
    output += char;
  }
  return output;
}

export function stripJsonTrailingCommas(raw) {
  let output = "";
  let inString = false;
  let stringQuote = "";
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    if (inString) {
      output += char;
      if (char === stringQuote && !isEscapedQuote(raw, index)) {
        inString = false;
        stringQuote = "";
      }
      continue;
    }
    if (char === '"' || char === "'") {
      inString = true;
      stringQuote = char;
      output += char;
      continue;
    }
    if (char === ",") {
      let lookAhead = index + 1;
      while (lookAhead < raw.length && /\s/u.test(raw[lookAhead])) {
        lookAhead += 1;
      }
      if (raw[lookAhead] === "}" || raw[lookAhead] === "]") {
        continue;
      }
    }
    output += char;
  }
  return output;
}

export function parseJsonLike(raw) {
  return JSON.parse(stripJsonTrailingCommas(stripJsonComments(raw)));
}
