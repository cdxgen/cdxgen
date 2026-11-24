/**
 * The JSON Schema string formats the pre-compiled CycloneDX validators assert
 * (`date`, `date-time` and `uri`), plus the two small helpers the generated
 * code calls (`equal` and `ucs2length`). They are written from the RFCs and
 * every check is a bounded pass over the input with no backtracking regular
 * expression. `idn-email` lives in `lib/parsers/email.js`.
 */

import { isIPv4, isIPv6 } from "node:net";

const DAYS_IN_MONTH = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const SCHEME_EXTRA = "+-.";
const UNRESERVED_EXTRA = "-._~";
const SUB_DELIMS = "!$&'()*+,;=";

/**
 * Whether the string is made only of ASCII digits and has the given length.
 *
 * @param {string} str Text to check
 * @param {number} length Required number of digits
 * @returns {boolean} True when the text is exactly `length` digits
 */
function isDigits(str, length) {
  if (str.length !== length) {
    return false;
  }
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 48 || code > 57) {
      return false;
    }
  }
  return true;
}

function isAlpha(ch) {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z");
}

function isDigit(ch) {
  return ch >= "0" && ch <= "9";
}

function isHexDigit(ch) {
  return isDigit(ch) || (ch >= "a" && ch <= "f") || (ch >= "A" && ch <= "F");
}

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/**
 * RFC 3339 `full-date` (section 5.6): `YYYY-MM-DD` naming a real day.
 *
 * @param {string} str Candidate value
 * @returns {boolean} True for a valid calendar date
 */
export function isValidDate(str) {
  if (typeof str !== "string" || str.length !== 10) {
    return false;
  }
  if (str[4] !== "-" || str[7] !== "-") {
    return false;
  }
  const yearText = str.slice(0, 4);
  const monthText = str.slice(5, 7);
  const dayText = str.slice(8);
  if (!isDigits(yearText, 4) || !isDigits(monthText, 2)) {
    return false;
  }
  if (!isDigits(dayText, 2)) {
    return false;
  }
  const month = Number(monthText);
  const day = Number(dayText);
  if (month < 1 || month > 12 || day < 1) {
    return false;
  }
  const maxDay =
    month === 2 && isLeapYear(Number(yearText)) ? 29 : DAYS_IN_MONTH[month];
  return day <= maxDay;
}

/**
 * RFC 3339 `full-time`: `HH:MM:SS`, an optional fraction and a mandatory
 * offset (`Z` or `+HH:MM`/`-HH:MM`). Second 60 is accepted only when the
 * instant is 23:59:60 UTC, the one place a leap second can fall.
 *
 * @param {string} str Candidate value
 * @returns {boolean} True for a valid time with offset
 */
function isValidFullTime(str) {
  if (str.length < 9 || str[2] !== ":" || str[5] !== ":") {
    return false;
  }
  const hourText = str.slice(0, 2);
  const minuteText = str.slice(3, 5);
  const secondText = str.slice(6, 8);
  if (
    !isDigits(hourText, 2) ||
    !isDigits(minuteText, 2) ||
    !isDigits(secondText, 2)
  ) {
    return false;
  }
  let pos = 8;
  if (str[pos] === ".") {
    const fractionStart = ++pos;
    while (pos < str.length && isDigit(str[pos])) {
      pos++;
    }
    if (pos === fractionStart) {
      return false;
    }
  }
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (hour > 23 || minute > 59 || second > 60) {
    return false;
  }
  const offset = str.slice(pos);
  let offsetMinutes = 0;
  if (offset === "Z" || offset === "z") {
    offsetMinutes = 0;
  } else if (
    offset.length === 6 &&
    (offset[0] === "+" || offset[0] === "-") &&
    offset[3] === ":" &&
    isDigits(offset.slice(1, 3), 2) &&
    isDigits(offset.slice(4), 2)
  ) {
    const offsetHour = Number(offset.slice(1, 3));
    const offsetMinute = Number(offset.slice(4));
    if (offsetHour > 23 || offsetMinute > 59) {
      return false;
    }
    offsetMinutes =
      (offsetHour * 60 + offsetMinute) * (offset[0] === "-" ? -1 : 1);
  } else {
    return false;
  }
  if (second < 60) {
    return true;
  }
  const utcMinuteOfDay =
    (((hour * 60 + minute - offsetMinutes) % 1440) + 1440) % 1440;
  return utcMinuteOfDay === 23 * 60 + 59;
}

/**
 * RFC 3339 `date-time` (section 5.6). The separator is `T`, `t` or a single
 * space, as section 5.6 permits.
 *
 * @param {string} str Candidate value
 * @returns {boolean} True for a valid date-time
 */
export function isValidDateTime(str) {
  if (typeof str !== "string" || str.length < 11) {
    return false;
  }
  const separator = str[10];
  if (separator !== "T" && separator !== "t" && separator !== " ") {
    return false;
  }
  return isValidDate(str.slice(0, 10)) && isValidFullTime(str.slice(11));
}

/**
 * Whether every character is one of `allowed`, an unreserved character, or a
 * percent-encoded octet (RFC 3986 section 2).
 *
 * @param {string} str Text to check
 * @param {string} extra Further permitted ASCII punctuation
 * @returns {boolean} True when the text is a run of permitted characters
 */
function isUriChars(str, extra) {
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === "%") {
      if (!isHexDigit(str[i + 1] || "") || !isHexDigit(str[i + 2] || "")) {
        return false;
      }
      i += 2;
    } else if (
      !isAlpha(ch) &&
      !isDigit(ch) &&
      !UNRESERVED_EXTRA.includes(ch) &&
      !extra.includes(ch)
    ) {
      return false;
    }
  }
  return true;
}

function isIpLiteral(host) {
  const inner = host.slice(1, -1);
  if (inner[0] === "v" || inner[0] === "V") {
    const dot = inner.indexOf(".");
    if (dot < 2 || dot === inner.length - 1) {
      return false;
    }
    for (let i = 1; i < dot; i++) {
      if (!isHexDigit(inner[i])) {
        return false;
      }
    }
    return (
      isUriChars(inner.slice(dot + 1), `${SUB_DELIMS}:`) && !inner.includes("%")
    );
  }
  return !inner.includes("%") && isIPv6(inner);
}

/**
 * RFC 3986 `authority`: `[userinfo "@"] host [":" port]`.
 *
 * @param {string} authority Text between `//` and the path
 * @returns {boolean} True for a well-formed authority
 */
function isValidAuthority(authority) {
  let hostPort = authority;
  const at = authority.indexOf("@");
  if (at !== -1) {
    if (!isUriChars(authority.slice(0, at), `${SUB_DELIMS}:`)) {
      return false;
    }
    hostPort = authority.slice(at + 1);
  }
  let host = hostPort;
  let port = "";
  if (hostPort[0] === "[") {
    const close = hostPort.indexOf("]");
    if (close === -1) {
      return false;
    }
    host = hostPort.slice(0, close + 1);
    const rest = hostPort.slice(close + 1);
    if (rest !== "") {
      if (rest[0] !== ":") {
        return false;
      }
      port = rest.slice(1);
    }
    if (!isIpLiteral(host)) {
      return false;
    }
  } else {
    const colon = hostPort.indexOf(":");
    if (colon !== -1) {
      host = hostPort.slice(0, colon);
      port = hostPort.slice(colon + 1);
    }
    // An IPv4 address is also a reg-name; the name check covers both.
    if (!isUriChars(host, SUB_DELIMS)) {
      return false;
    }
  }
  for (let i = 0; i < port.length; i++) {
    if (!isDigit(port[i])) {
      return false;
    }
  }
  return true;
}

/**
 * RFC 3986 `URI` (section 3): `scheme ":" hier-part ["?" query] ["#" fragment]`.
 * A relative reference has no scheme and is rejected, and so is a bare scheme
 * with an empty hier-part, which names nothing.
 *
 * @param {string} str Candidate value
 * @returns {boolean} True for a valid URI
 */
export function isValidUri(str) {
  if (typeof str !== "string") {
    return false;
  }
  const colon = str.indexOf(":");
  if (colon < 1 || !isAlpha(str[0])) {
    return false;
  }
  for (let i = 1; i < colon; i++) {
    if (
      !isAlpha(str[i]) &&
      !isDigit(str[i]) &&
      !SCHEME_EXTRA.includes(str[i])
    ) {
      return false;
    }
  }
  let rest = str.slice(colon + 1);
  const hash = rest.indexOf("#");
  if (hash !== -1) {
    if (!isUriChars(rest.slice(hash + 1), `${SUB_DELIMS}:@/?`)) {
      return false;
    }
    rest = rest.slice(0, hash);
  }
  const question = rest.indexOf("?");
  if (question !== -1) {
    if (!isUriChars(rest.slice(question + 1), `${SUB_DELIMS}:@/?`)) {
      return false;
    }
    rest = rest.slice(0, question);
  }
  if (rest === "") {
    return false;
  }
  let path = rest;
  if (rest.startsWith("//")) {
    const slash = rest.indexOf("/", 2);
    const authority = slash === -1 ? rest.slice(2) : rest.slice(2, slash);
    if (!isValidAuthority(authority)) {
      return false;
    }
    path = slash === -1 ? "" : rest.slice(slash);
  }
  return isUriChars(path, `${SUB_DELIMS}:@/`);
}

/**
 * The number of Unicode code points in a string, which is how JSON Schema
 * counts `minLength` and `maxLength` (a surrogate pair is one character).
 *
 * @param {string} str Text to measure
 * @returns {number} Code point count
 */
export function ucs2length(str) {
  let length = 0;
  let pos = 0;
  while (pos < str.length) {
    length++;
    const value = str.charCodeAt(pos++);
    if (value >= 0xd800 && value <= 0xdbff && pos < str.length) {
      if ((str.charCodeAt(pos) & 0xfc00) === 0xdc00) {
        pos++;
      }
    }
  }
  return length;
}

/**
 * Deep equality of two parsed JSON values, used by the `const` and `enum`
 * keywords.
 *
 * @param {*} a First value
 * @param {*} b Second value
 * @returns {boolean} True when both hold the same JSON data
 */
export function equal(a, b) {
  if (a === b) {
    return true;
  }
  if (!a || !b || typeof a !== "object" || typeof b !== "object") {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    return false;
  }
  if (Array.isArray(a)) {
    if (a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i++) {
      if (!equal(a[i], b[i])) {
        return false;
      }
    }
    return true;
  }
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) {
    return false;
  }
  for (const key of keys) {
    if (!Object.hasOwn(b, key) || !equal(a[key], b[key])) {
      return false;
    }
  }
  return true;
}
