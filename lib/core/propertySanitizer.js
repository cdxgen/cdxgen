import path from "node:path";

const DANGEROUS_OBJECT_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
const INLINE_CREDENTIAL_PATTERNS = [
  /\bAKIA[0-9A-Z]{16}\b/gu,
  /\bASIA[0-9A-Z]{16}\b/gu,
  /\bbearer\s+[a-z0-9._-]{16,}\b/giu,
  /\b(?:sk|rk|pk)(?:-[a-z0-9]+)?_[a-z0-9_-]{8,}\b/giu,
  /\bgh[pousr]_[a-z0-9]{20,}\b/giu,
  /\bAIza[0-9A-Za-z_-]{20,}\b/gu,
  /\bxox[baprs]-[a-z0-9-]{10,}\b/giu,
  /\bnpm_[a-z0-9]{20,}\b/giu,
  /\bglpat-[a-z0-9_-]{20,}/giu,
];
const SENSITIVE_KEY_PATTERN =
  /(?:api[-_]?key|auth(?:orization)?|bearer|credential|passwd|password|secret|session|token)/iu;
const JSON_PROPERTY_NAMES = new Set([
  "cdx:agent:permission",
  "cdx:mcp:toolAnnotations",
  "cdx:skill:metadata",
  "cdx:ai:codegen:evidence:json",
]);
const URL_PATTERN = /https?:\/\/[^\s<>"'),\]]+/giu;
const MAX_STRUCTURE_DEPTH = 6;
// What an RFC 3986 path may hold as it is: unreserved characters, sub-delims,
// ":", "@", "/" and well-formed percent-escapes. A query or fragment may also
// hold "?". Everything else is percent-encoded.
const URI_PATH_UNSAFE =
  /%(?![0-9A-Fa-f]{2})|[^A-Za-z0-9\-._~!$&'()*+,;=:@/%]/gu;
const URI_QUERY_UNSAFE =
  /%(?![0-9A-Fa-f]{2})|[^A-Za-z0-9\-._~!$&'()*+,;=:@/?%]/gu;
const URI_SCHEME_AUTHORITY = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*/u;
const UTF8_ENCODER = new TextEncoder();
const URL_WHITESPACE = new Set([" ", "\t", "\n", "\r", "\f", "\v"]);
// Characters that separate the items of a list of URLs.
const URL_LIST_SEPARATORS = new Set([",", ";", "|", '"', "'", "`"]);
// Characters that can close a quoted, bracketed, listed or sentence-final
// URL. A run of them at the end of a removed query or fragment is kept.
const URL_TRAILERS = new Set([
  ",",
  ";",
  ".",
  '"',
  "'",
  "`",
  ")",
  "]",
  "}",
  ">",
]);

function isUrlSchemeChar(character) {
  return (
    (character >= "a" && character <= "z") ||
    (character >= "A" && character <= "Z") ||
    (character >= "0" && character <= "9") ||
    character === "+" ||
    character === "-" ||
    character === "."
  );
}

// Index of the first character of the scheme whose "://" is at schemeEnd,
// never before floor.
function urlSchemeStart(text, schemeEnd, floor) {
  let start = schemeEnd;
  while (start > floor && isUrlSchemeChar(text[start - 1])) {
    start -= 1;
  }
  return start;
}

const BRACKET_OPENERS = new Map([
  [")", "("],
  ["]", "["],
  ["}", "{"],
  [">", "<"],
]);
const OPENING_BRACKETS = new Set(BRACKET_OPENERS.values());

// The separators, quotes and closing brackets at the end of a removed query
// or fragment (text[start, end)) that belong to the text around the URL. A
// closing bracket that closes one left open inside the query, as in the `{t}`
// of `?token={t}`, is part of the query.
function closingTrailer(text, start, end) {
  let trailerStart = end;
  while (trailerStart - 1 > start && URL_TRAILERS.has(text[trailerStart - 1])) {
    trailerStart -= 1;
  }
  const open = new Map();
  for (let index = start; index < trailerStart; index += 1) {
    const character = text[index];
    const opener = BRACKET_OPENERS.get(character);
    if (opener) {
      open.set(opener, Math.max(0, (open.get(opener) ?? 0) - 1));
    } else if (OPENING_BRACKETS.has(character)) {
      open.set(character, (open.get(character) ?? 0) + 1);
    }
  }
  let trailer = "";
  for (const character of text.slice(trailerStart, end)) {
    const opener = BRACKET_OPENERS.get(character);
    if (opener && (open.get(opener) ?? 0) > 0) {
      open.set(opener, open.get(opener) - 1);
    } else {
      trailer += character;
    }
  }
  return trailer;
}

/**
 * Remove the parts of every URL in a text that can carry a credential: the
 * userinfo before `@`, the query string and the fragment. Any scheme is
 * handled, such as `sparse+https://`, `ssh://` or `jdbc:postgresql://`.
 *
 * A userinfo or query may hold `;`, `,`, quotes and other characters that
 * also separate the items of a list, so none of them ends a URL early. The
 * authority and path of a URL end at white space, `?`, `#` or the scheme of
 * the next URL. A query or fragment ends at white space or at the scheme of a
 * next URL that follows a list separator. The separators, quotes, periods and
 * closing brackets at its end are kept, except a bracket that closes one
 * opened inside the query, as in `?token={t}`. A password that holds white
 * space, `/`, `?` or `#` cannot be told apart from the text around it and is
 * not recognised.
 *
 * The text is scanned once, so the work stays linear in its length.
 *
 * @param {unknown} value Text that may contain URLs
 * @returns {string} The text with URL userinfo, queries and fragments removed
 */
export function stripUrlCredentials(value) {
  const text = String(value ?? "");
  let schemeEnd = text.indexOf("://");
  if (schemeEnd === -1) {
    return text;
  }
  let result = "";
  let cursor = 0;
  while (schemeEnd !== -1) {
    const start = schemeEnd + 3;
    const nextSchemeEnd = text.indexOf("://", start);
    const limit =
      nextSchemeEnd === -1
        ? text.length
        : urlSchemeStart(text, nextSchemeEnd, start);
    let hostStart = start;
    let inAuthority = true;
    let pathEnd = start;
    while (pathEnd < limit) {
      const character = text[pathEnd];
      if (
        URL_WHITESPACE.has(character) ||
        character === "?" ||
        character === "#"
      ) {
        break;
      }
      if (inAuthority) {
        if (character === "/") {
          inAuthority = false;
        } else if (character === "@") {
          hostStart = pathEnd + 1;
        }
      }
      pathEnd += 1;
    }
    let end = pathEnd;
    let trailer = "";
    if (text[pathEnd] === "?" || text[pathEnd] === "#") {
      end = pathEnd + 1;
      while (end < text.length && !URL_WHITESPACE.has(text[end])) {
        end += 1;
      }
      let nested = text.indexOf("://", pathEnd);
      while (nested !== -1 && nested < end) {
        const nestedStart = urlSchemeStart(text, nested, pathEnd);
        if (
          nestedStart > pathEnd + 1 &&
          URL_LIST_SEPARATORS.has(text[nestedStart - 1])
        ) {
          end = nestedStart;
          trailer = text[nestedStart - 1];
          break;
        }
        nested = text.indexOf("://", nested + 3);
      }
      if (!trailer) {
        trailer = closingTrailer(text, pathEnd, end);
      }
    }
    result += `${text.slice(cursor, start)}${text.slice(hostStart, pathEnd)}${trailer}`;
    cursor = end;
    schemeEnd = text.indexOf("://", end);
  }
  return result + text.slice(cursor);
}

function sanitizeUrlForBom(value) {
  // The URL parser reads `jdbc:mysql://user:pass@host` as an opaque path, so
  // every `scheme://` authority loses its userinfo first.
  const input = stripUrlCredentials(String(value || "").trim());
  if (!input) {
    return input;
  }
  try {
    const parsed = new URL(input);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return stripUnparsedHttpUrl(input);
  }
}

/**
 * Remove the user-info, query and fragment of an http(s) URL that the URL
 * parser rejects, such as one with a non-numeric port, by position in the
 * text. Other schemes go through stripUrlCredentials().
 *
 * @param {string} input URL text
 * @returns {string} The URL without user-info, query and fragment
 */
function stripUnparsedHttpUrl(input) {
  const schemeEnd = input.indexOf("://");
  const scheme = input.slice(0, schemeEnd).toLowerCase();
  if (scheme !== "http" && scheme !== "https") {
    return stripUrlCredentials(input);
  }
  const authorityStart = schemeEnd + 3;
  let end = input.length;
  for (const delimiter of ["?", "#"]) {
    const delimiterIndex = input.indexOf(delimiter, authorityStart);
    if (delimiterIndex !== -1 && delimiterIndex < end) {
      end = delimiterIndex;
    }
  }
  const pathStart = input.indexOf("/", authorityStart);
  const authorityEnd = pathStart === -1 || pathStart > end ? end : pathStart;
  const userInfoEnd = input.lastIndexOf("@", authorityEnd - 1);
  const hostStart =
    userInfoEnd >= authorityStart ? userInfoEnd + 1 : authorityStart;
  return input.slice(0, authorityStart) + input.slice(hostStart, end);
}

function isJwtWordChar(character) {
  return (
    (character >= "a" && character <= "z") ||
    (character >= "A" && character <= "Z") ||
    (character >= "0" && character <= "9") ||
    character === "_"
  );
}

function isJwtChar(character) {
  return isJwtWordChar(character) || character === "-" || character === ".";
}

/**
 * Find the JSON Web Token shapes in a text: `eyJ` (any case) at a word
 * boundary, then a segment of `[A-Za-z0-9_-]`, a dot, and at least two more
 * dot-separated parts, ending at a word character. A regular expression for
 * this shape backtracks over every `eyJ` in a long run without dots, so the
 * text is scanned once instead: each run of token characters is visited once
 * and its dots are found with pointers that only move forward.
 *
 * @param {string} text Text to search
 * @returns {Array<[number, number]>} Start and end offsets of each match
 */
function findJwtSpans(text) {
  const spans = [];
  let index = 0;
  while (index < text.length) {
    if (!isJwtChar(text[index])) {
      index += 1;
      continue;
    }
    const runStart = index;
    while (index < text.length && isJwtChar(text[index])) {
      index += 1;
    }
    const runEnd = index;
    let lastWord = runEnd - 1;
    while (lastWord >= runStart && !isJwtWordChar(text[lastWord])) {
      lastWord -= 1;
    }
    let firstDot = runStart;
    let secondDot = runStart;
    let candidate = runStart;
    while (candidate + 3 <= lastWord) {
      const head = text.slice(candidate, candidate + 3).toLowerCase();
      const boundary = candidate === 0 || !isJwtWordChar(text[candidate - 1]);
      if (head !== "eyj" || !boundary) {
        candidate += 1;
        continue;
      }
      if (firstDot < candidate + 3) {
        firstDot = candidate + 3;
      }
      while (firstDot < runEnd && text[firstDot] !== ".") {
        firstDot += 1;
      }
      if (secondDot < firstDot + 2) {
        secondDot = firstDot + 2;
      }
      while (secondDot < runEnd && text[secondDot] !== ".") {
        secondDot += 1;
      }
      if (
        firstDot > candidate + 3 &&
        firstDot < runEnd &&
        secondDot < lastWord
      ) {
        spans.push([candidate, lastWord + 1]);
        break;
      }
      candidate += 1;
    }
  }
  return spans;
}

function redactJwts(text) {
  const spans = findJwtSpans(text);
  if (!spans.length) {
    return text;
  }
  let result = "";
  let cursor = 0;
  for (const [start, end] of spans) {
    result += `${text.slice(cursor, start)}[redacted]`;
    cursor = end;
  }
  return result + text.slice(cursor);
}

function sanitizeTextForBom(value) {
  let sanitized = stripUrlCredentials(value);
  // A URL template such as `https://h/users/{id}` is kept as written once
  // stripUrlCredentials() has removed its userinfo, query and fragment; the
  // parser would percent-encode its braces.
  sanitized = sanitized.replace(URL_PATTERN, (match) =>
    match.includes("{") || match.includes("}")
      ? match
      : sanitizeUrlForBom(match),
  );
  for (const pattern of INLINE_CREDENTIAL_PATTERNS) {
    sanitized = sanitized.replace(pattern, "[redacted]");
  }
  return redactJwts(sanitized);
}

/**
 * Recursively sanitize structured values before embedding them in a BOM.
 *
 * @param {unknown} value structured value
 * @returns {unknown} sanitized value
 */
export function sanitizeStructuredValueForBom(value) {
  return sanitizeStructuredValueEntryForBom(value, 0, new WeakSet());
}

function sanitizeStructuredValueEntryForBom(value, depth, seen) {
  if (typeof value === "string") {
    return sanitizeTextForBom(value);
  }
  if (depth >= MAX_STRUCTURE_DEPTH) {
    return "[truncated]";
  }
  if (Array.isArray(value)) {
    return value.map((entry) =>
      sanitizeStructuredValueEntryForBom(entry, depth + 1, seen),
    );
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) {
      return "[circular]";
    }
    seen.add(value);
    const sanitized = {};
    for (const [key, entryValue] of Object.entries(value)) {
      if (DANGEROUS_OBJECT_KEYS.has(key)) {
        continue;
      }
      sanitized[key] = SENSITIVE_KEY_PATTERN.test(key)
        ? "[redacted]"
        : sanitizeStructuredValueEntryForBom(entryValue, depth + 1, seen);
    }
    seen.delete(value);
    return sanitized;
  }
  return value;
}

function extractCommandExecutable(command) {
  let trimmedCommand = String(command || "").trim();
  if (!trimmedCommand) {
    return "";
  }
  trimmedCommand = trimmedCommand.replace(
    /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)\s+)+/u,
    "",
  );
  const quotedMatch = trimmedCommand.match(/^(['"])(.*?)\1/u);
  if (quotedMatch?.[2]) {
    return quotedMatch[2];
  }
  const envExecutableMatch = trimmedCommand.match(
    /^(?:\/usr\/bin\/env\s+)?([A-Za-z0-9_./\\-]+)(?=\s|$)/u,
  );
  if (envExecutableMatch?.[1]) {
    return envExecutableMatch[1];
  }
  const absolutePathMatch = trimmedCommand.match(
    /^((?:[A-Za-z]:\\|\/).*?\.(?:bat|bin|cjs|cmd|com|exe|jar|js|mjs|ps1|py|rb|sh|ts|tsx))(?=\s|$)/iu,
  );
  if (absolutePathMatch?.[1]) {
    return absolutePathMatch[1];
  }
  return trimmedCommand.split(/\s+/u)[0];
}

function summarizeExecutable(command) {
  const executable = extractCommandExecutable(command);
  if (!executable) {
    return "configured";
  }
  if (executable.includes("\\")) {
    return path.win32.basename(executable) || "configured";
  }
  return path.posix.basename(executable) || "configured";
}

/**
 * Sanitize free text, such as a name or a command line copied from a scanned
 * file, before it is embedded in a BOM: URL userinfo, queries and fragments
 * are removed and known token shapes are redacted.
 *
 * @param {unknown} value Text to sanitize
 * @returns {string} sanitized text
 */
export function sanitizeBomText(value) {
  return sanitizeTextForBom(value);
}

/**
 * Sanitize a URL value for safe BOM emission.
 *
 * @param {string} value URL value
 * @returns {string} sanitized URL
 */
export function sanitizeBomUrl(value) {
  return sanitizeUrlForBom(value);
}

/**
 * Sanitize a service endpoint URL, such as an MCP server URL, for safe BOM
 * emission. Besides what {@link sanitizeBomUrl} removes, `;name=value` path
 * parameters such as `;jsessionid=` and `;token=` are dropped and the path
 * ends before the first segment holding a token shape the BOM sanitizer
 * recognises, because endpoints that authenticate by their path carry the
 * credential there. No `[redacted]` marker is spliced in, as
 * `services[].endpoints[]` must stay an iri-reference. A value that is not
 * a URL with a path is returned as {@link sanitizeBomUrl} returns it.
 *
 * @param {string} value URL value
 * @returns {string} sanitized URL
 */
export function sanitizeBomEndpointUrl(value) {
  const sanitized = sanitizeUrlForBom(value);
  let parsed;
  try {
    parsed = new URL(sanitized);
  } catch {
    return sanitized;
  }
  if (!parsed.pathname.startsWith("/")) {
    return sanitized;
  }
  const segments = [];
  for (const segment of parsed.pathname.split("/").slice(1)) {
    const bare = segment.split(";", 1)[0];
    let decoded = bare;
    try {
      decoded = decodeURIComponent(bare);
    } catch {
      // A malformed escape is checked as written.
    }
    if (hasInlineCredential(decoded)) {
      break;
    }
    segments.push(bare);
  }
  parsed.pathname = `/${segments.join("/")}`;
  return parsed.toString();
}

function percentEncodeUnsafe(text, unsafe) {
  return text.replace(unsafe, (character) =>
    Array.from(
      UTF8_ENCODER.encode(character),
      (byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`,
    ).join(""),
  );
}

/**
 * Percent-encode what an RFC 3986 URI reference cannot hold as it is, so a
 * route template or URL can be emitted where CycloneDX expects an
 * iri-reference, such as `services[].endpoints[]`. The braces of a route
 * template, spaces, `<>`, `[]` outside an IPv6 host, `|`, `^`, non-ASCII
 * characters and a `%` that starts no escape are encoded:
 * `/users/{id}` becomes `/users/%7Bid%7D`. The scheme and authority of an
 * absolute URL are kept as written, the query and fragment stay a query and
 * fragment, and existing escapes are kept, so encoding twice changes
 * nothing. Nothing is removed; strip credentials with {@link sanitizeBomUrl}
 * first.
 *
 * @param {unknown} value Route template, path or URL
 * @returns {string} The encoded reference
 */
export function encodeUriReference(value) {
  const text = String(value ?? "");
  const authority = URI_SCHEME_AUTHORITY.exec(text)?.[0] ?? "";
  const rest = text.slice(authority.length);
  const queryStart = rest.indexOf("?");
  const fragmentStart = rest.indexOf("#");
  const pathEnd = Math.min(
    queryStart < 0 ? rest.length : queryStart,
    fragmentStart < 0 ? rest.length : fragmentStart,
  );
  let encoded =
    authority + percentEncodeUnsafe(rest.slice(0, pathEnd), URI_PATH_UNSAFE);
  if (pathEnd === queryStart) {
    const queryEnd = fragmentStart > queryStart ? fragmentStart : rest.length;
    encoded += `?${percentEncodeUnsafe(rest.slice(queryStart + 1, queryEnd), URI_QUERY_UNSAFE)}`;
  }
  if (fragmentStart >= 0) {
    encoded += `#${percentEncodeUnsafe(rest.slice(fragmentStart + 1), URI_QUERY_UNSAFE)}`;
  }
  return encoded;
}

/**
 * Whether a value carries a token shape the BOM sanitizer redacts: cloud
 * access keys, bearer tokens, GitHub, Slack and npm tokens, JWTs and the
 * like. Callers that cannot splice a `[redacted]` marker into the value, such
 * as a URL path segment, use it to drop the value instead.
 *
 * @param {unknown} value Value to check
 * @returns {boolean} true when the value holds an inline credential
 */
export function hasInlineCredential(value) {
  const text = String(value ?? "");
  return (
    INLINE_CREDENTIAL_PATTERNS.some((pattern) => {
      pattern.lastIndex = 0;
      return pattern.test(text);
    }) || findJwtSpans(text).length > 0
  );
}

/**
 * Sanitize a property value before serializing it into BOM properties.
 *
 * @param {string} name property name
 * @param {unknown} value property value
 * @returns {string|unknown} sanitized property value
 */
export function sanitizeBomPropertyValue(name, value) {
  if (value === undefined || value === null || value === "") {
    return value;
  }
  if (name === "cdx:mcp:command") {
    const sanitizedCommand = sanitizeTextForBom(value).trim();
    if (!sanitizedCommand) {
      return sanitizedCommand;
    }
    return summarizeExecutable(sanitizedCommand);
  }
  if (JSON_PROPERTY_NAMES.has(name) || typeof value === "object") {
    return JSON.stringify(sanitizeStructuredValueForBom(value));
  }
  if (typeof value === "string") {
    return sanitizeTextForBom(value);
  }
  return value;
}

const COMMAND_SEPARATORS = new Set(["|", "||", "&&", ";", "&"]);
const COMMAND_PREFIXES = new Set([
  "command",
  "env",
  "exec",
  "nice",
  "nohup",
  "sudo",
  "time",
]);
// Words of a flag or variable name that mark its value as a credential.
const CREDENTIAL_NAME_WORDS = new Set([
  "apikey",
  "auth",
  "authorization",
  "bearer",
  "cookie",
  "credential",
  "credentials",
  "pass",
  "passphrase",
  "passwd",
  "password",
  "pat",
  "psw",
  "pw",
  "pwd",
  "secret",
  "token",
]);
// Words that turn a credential flag into one that names a file, a variable
// or standard input rather than holding the value.
const CREDENTIAL_INDIRECT_WORDS = new Set([
  "env",
  "file",
  "path",
  "stdin",
  "var",
]);
const CREDENTIAL_HEADER_NAMES = [
  "authorization",
  "cookie",
  "job-token",
  "private-token",
  "proxy-authorization",
  "x-api-key",
  "x-auth-token",
  "x-jfrog-art-api",
  "x-vault-token",
];
// Tools whose `-u` or `-U` flag takes `user:password`.
const USERPASS_FLAG_TOOLS = new Set(["curl", "curl.exe"]);
// Clients whose `-p` always takes a password.
const PASSWORD_FLAG_TOOLS = new Set(["sshpass", "twine"]);
// Container, registry and cloud clients whose `login -p` takes a password.
const LOGIN_PASSWORD_TOOLS = new Set([
  "az",
  "buildah",
  "crane",
  "docker",
  "finch",
  "helm",
  "nerdctl",
  "oras",
  "podman",
  "regctl",
  "skopeo",
]);
// Clients that read the password attached to `-p`, as in `-psecret`.
const ATTACHED_PASSWORD_TOOLS = new Set([
  "mariadb",
  "mariadb-dump",
  "mysql",
  "mysqladmin",
  "mysqldump",
]);
const SHELL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;

// Split a command line into words, keeping quoted text inside its word and
// the white space before each word, so the line can be put back together.
function splitCommandWords(text) {
  const words = [];
  let index = 0;
  while (index < text.length) {
    const start = index;
    while (index < text.length && URL_WHITESPACE.has(text[index])) {
      index += 1;
    }
    const before = text.slice(start, index);
    const wordStart = index;
    let quote = "";
    while (index < text.length) {
      const character = text[index];
      if (quote) {
        if (character === quote) {
          quote = "";
        }
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (URL_WHITESPACE.has(character)) {
        break;
      }
      index += 1;
    }
    words.push({ before, word: text.slice(wordStart, index) });
  }
  return words;
}

function unquoteWord(word) {
  return word.replaceAll('"', "").replaceAll("'", "");
}

// A shell or CI variable reference names a secret without holding it.
function isValueReference(value) {
  const bare = unquoteWord(value).trim();
  return bare.startsWith("$") || bare.startsWith("%");
}

function nameWords(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .toLowerCase()
    .split(/[-_.]/u)
    .filter(Boolean)
    .map((word) => word.replace(/\d+$/u, ""));
}

function isCredentialName(name, value) {
  const words = nameWords(name);
  if (words.some((word) => CREDENTIAL_INDIRECT_WORDS.has(word))) {
    return false;
  }
  const joined = words.join("");
  if (
    words.some((word) => CREDENTIAL_NAME_WORDS.has(word)) ||
    joined.includes("apikey") ||
    joined.includes("accesskey") ||
    joined.includes("password") ||
    joined.includes("secret") ||
    joined.includes("token")
  ) {
    return true;
  }
  // `--user user:password`, as curl and wget take it.
  return words.includes("user") && unquoteWord(value ?? "").includes(":");
}

function redactedValue(value) {
  const quote = value[0] === '"' || value[0] === "'" ? value[0] : "";
  return `${quote}[redacted]${quote}`;
}

function redactHeaderValue(word) {
  const lower = word.toLowerCase();
  for (const header of CREDENTIAL_HEADER_NAMES) {
    const headerIndex = lower.indexOf(`${header}:`);
    if (headerIndex === -1) {
      continue;
    }
    const valueStart = headerIndex + header.length + 1;
    const rest = word.slice(valueStart);
    const trailer = rest.match(/["']$/u)?.[0] ?? "";
    const value = rest.slice(0, rest.length - trailer.length).trim();
    const parts = value.split(/\s+/u).filter(Boolean);
    if (!parts.length || isValueReference(parts[parts.length - 1])) {
      return word;
    }
    return `${word.slice(0, valueStart)} [redacted]${trailer}`;
  }
  return word;
}

function programName(word) {
  const bare = unquoteWord(word);
  const base = bare.includes("\\")
    ? path.win32.basename(bare)
    : path.posix.basename(bare);
  return base.toLowerCase();
}

/**
 * Redact credential values passed as literal arguments in a command line
 * copied from a CI file or a build script: the value after flags such as
 * `--password`, `--token` or `--api-key` (spaced or with `=`), curl's
 * `-u user:password`, `login -p` of container registry clients, a password
 * attached to the `-p` of the MySQL clients, credential-bearing header
 * values such as `Authorization:`, and `NAME=value` assignments whose name
 * marks a credential. The executable and the other arguments are kept, and
 * a value that is a variable reference such as `$TOKEN` or
 * `${{ secrets.TOKEN }}` is kept because it holds no secret.
 *
 * The line is scanned once, so the work stays linear in its length.
 *
 * @param {unknown} value Command line
 * @returns {string} The command line with credential values redacted
 */
export function redactCommandCredentials(value) {
  const text = String(value ?? "");
  if (!text.trim()) {
    return text;
  }
  const words = splitCommandWords(text);
  const state = { program: "", sawLogin: false, redactNext: false };
  for (const entry of words) {
    if (!entry.word) {
      continue;
    }
    // A `;` at the end of a word ends the command as a word of its own does.
    const endsCommand = entry.word.length > 1 && entry.word.endsWith(";");
    if (endsCommand) {
      entry.word = entry.word.slice(0, -1);
      entry.after = ";";
    }
    redactCommandWord(entry, state);
    if (endsCommand) {
      state.program = "";
      state.sawLogin = false;
      state.redactNext = false;
    }
  }
  return words
    .map(({ before, word, after }) => `${before}${word}${after ?? ""}`)
    .join("");
}

function redactCommandWord(entry, state) {
  const { word } = entry;
  if (COMMAND_SEPARATORS.has(word)) {
    state.program = "";
    state.sawLogin = false;
    state.redactNext = false;
    return;
  }
  if (state.redactNext) {
    state.redactNext = false;
    if (!word.startsWith("-") && !isValueReference(word)) {
      entry.word = redactedValue(word);
      return;
    }
  }
  const equalsIndex = word.indexOf("=");
  if (!word.startsWith("-") && equalsIndex > 0) {
    const name = word.slice(0, equalsIndex);
    const assigned = word.slice(equalsIndex + 1);
    if (
      SHELL_IDENTIFIER.test(name) &&
      assigned &&
      !isValueReference(assigned) &&
      isCredentialName(name, assigned)
    ) {
      entry.word = `${name}=${redactedValue(assigned)}`;
      return;
    }
    if (!state.program && SHELL_IDENTIFIER.test(name)) {
      return;
    }
  }
  if (!state.program) {
    const name = programName(word);
    if (!COMMAND_PREFIXES.has(name)) {
      state.program = name;
    }
    return;
  }
  if (word === "login") {
    state.sawLogin = true;
  }
  if (word.startsWith("--")) {
    const flagEnd = equalsIndex === -1 ? word.length : equalsIndex;
    const flag = word.slice(2, flagEnd);
    if (equalsIndex !== -1) {
      const assigned = word.slice(equalsIndex + 1);
      if (
        assigned &&
        !isValueReference(assigned) &&
        isCredentialName(flag, assigned)
      ) {
        entry.word = `${word.slice(0, equalsIndex + 1)}${redactedValue(assigned)}`;
        return;
      }
    } else if (isCredentialName(flag, ":")) {
      state.redactNext = true;
      return;
    }
  } else if (
    (word.startsWith("-D") || word.startsWith("-P")) &&
    equalsIndex > 2
  ) {
    // A Java system property or Gradle project property.
    const assigned = word.slice(equalsIndex + 1);
    if (
      assigned &&
      !isValueReference(assigned) &&
      isCredentialName(word.slice(2, equalsIndex), assigned)
    ) {
      entry.word = `${word.slice(0, equalsIndex + 1)}${redactedValue(assigned)}`;
      return;
    }
  } else if (word.startsWith("-") && word.length >= 2) {
    const flag = word[1];
    const attached = word.slice(2);
    const userPass =
      USERPASS_FLAG_TOOLS.has(state.program) && (flag === "u" || flag === "U");
    const loginPassword =
      flag === "p" &&
      (PASSWORD_FLAG_TOOLS.has(state.program) ||
        (LOGIN_PASSWORD_TOOLS.has(state.program) && state.sawLogin));
    const attachedPassword =
      ATTACHED_PASSWORD_TOOLS.has(state.program) && flag === "p";
    if (userPass || loginPassword || attachedPassword) {
      if (attached) {
        if (!isValueReference(attached)) {
          entry.word = `-${flag}${redactedValue(attached)}`;
        }
      } else if (!attachedPassword) {
        state.redactNext = true;
      }
      return;
    }
  }
  entry.word = redactHeaderValue(word);
}

// User names that git hosts use for SSH access and that hold no secret.
const SSH_ACCOUNT_NAMES = new Set(["git", "hg"]);

/**
 * Remove what can carry a credential from a reference URL copied from a
 * scanned manifest, such as a homepage, repository, issue tracker or
 * download URL: the userinfo (except the `git@` of an SSH URL), the query
 * string, and a fragment that holds `=` or a token shape. A fragment naming
 * a git ref, as in `git+https://host/repo.git#v1.2.0`, is kept. The URL is
 * not otherwise rewritten, so a value without credentials comes back as it
 * was. A value without `://` is returned unchanged, except that an scp-like
 * `user:password@host:path` loses its userinfo.
 *
 * @param {unknown} value URL text
 * @returns {string} The URL without credentials
 */
export function sanitizeBomReferenceUrl(value) {
  const text = String(value ?? "");
  const schemeEnd = text.indexOf("://");
  const authorityStart = schemeEnd === -1 ? 0 : schemeEnd + 3;
  let authorityEnd = text.length;
  for (const delimiter of ["/", "?", "#"]) {
    const index = text.indexOf(delimiter, authorityStart);
    if (index !== -1 && index < authorityEnd) {
      authorityEnd = index;
    }
  }
  const userInfoEnd = text.lastIndexOf("@", authorityEnd - 1);
  if (schemeEnd === -1) {
    // Not a URL: only an scp-like `user:password@host:path` changes.
    const userInfo = userInfoEnd > 0 ? text.slice(0, userInfoEnd) : "";
    const colon = userInfo.indexOf(":");
    return colon > 0 && colon < userInfo.length - 1
      ? text.slice(userInfoEnd + 1)
      : text;
  }
  let result = text;
  if (
    userInfoEnd >= authorityStart &&
    !SSH_ACCOUNT_NAMES.has(text.slice(authorityStart, userInfoEnd))
  ) {
    result = text.slice(0, authorityStart) + text.slice(userInfoEnd + 1);
  }
  const fragmentStart = result.indexOf("#");
  let fragment = fragmentStart === -1 ? "" : result.slice(fragmentStart);
  let rest = fragmentStart === -1 ? result : result.slice(0, fragmentStart);
  if (fragment.includes("=") || hasInlineCredential(fragment)) {
    fragment = "";
  }
  const queryStart = rest.indexOf("?");
  if (queryStart !== -1) {
    rest = rest.slice(0, queryStart);
  }
  return rest + fragment;
}
