export function stripJsonComments(raw) {
  let output = "";
  let inString = false;
  let stringQuote = "";
  let escaped = false;
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    const nextChar = raw[index + 1];
    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === stringQuote) {
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
  let escaped = false;
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === stringQuote) {
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
