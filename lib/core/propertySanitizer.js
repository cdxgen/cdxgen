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
  /\b(?:eyJ[a-z0-9_-]+\.[a-z0-9._-]+\.[a-z0-9._-]+)\b/giu,
];
const SENSITIVE_KEY_PATTERN =
  /(?:api[-_]?key|auth(?:orization)?|bearer|credential|passwd|password|secret|session|token)/iu;
const JSON_PROPERTY_NAMES = new Set([
  "cdx:agent:permission",
  "cdx:mcp:toolAnnotations",
  "cdx:skill:metadata",
  "cdx:ai:codegen:evidence:json",
]);
const URL_PATTERN = /https?:\/\/[^\s<>"'),\]}]+/giu;
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
// Characters that can close a quoted, bracketed or listed URL. One of them at
// the end of a removed query or fragment is kept.
const URL_TRAILERS = new Set([",", ";", '"', "'", "`", ")", "]", "}", ">"]);

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

/**
 * Remove the parts of every URL in a text that can carry a credential: the
 * userinfo before `@`, the query string and the fragment. Any scheme is
 * handled, such as `sparse+https://`, `ssh://` or `jdbc:postgresql://`.
 *
 * A userinfo or query may hold `;`, `,`, quotes and other characters that
 * also separate the items of a list, so none of them ends a URL early. The
 * authority and path of a URL end at white space, `?`, `#` or the scheme of
 * the next URL. A query or fragment ends at white space or at the scheme of a
 * next URL that follows a list separator, and a separator, quote or closing
 * bracket at its end is kept. A password that holds white space, `/`, `?` or
 * `#` cannot be told apart from the text around it and is not recognised.
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
      if (!trailer && end - 1 > pathEnd && URL_TRAILERS.has(text[end - 1])) {
        trailer = text[end - 1];
      }
    }
    result += `${text.slice(cursor, start)}${text.slice(hostStart, pathEnd)}${trailer}`;
    cursor = end;
    schemeEnd = text.indexOf("://", end);
  }
  return result + text.slice(cursor);
}

function sanitizeUrlForBom(value) {
  const input = String(value || "").trim();
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
    return stripUrlCredentials(input);
  }
}

function sanitizeTextForBom(value) {
  let sanitized = stripUrlCredentials(value);
  sanitized = sanitized.replace(URL_PATTERN, (match) =>
    sanitizeUrlForBom(match),
  );
  for (const pattern of INLINE_CREDENTIAL_PATTERNS) {
    sanitized = sanitized.replace(pattern, "[redacted]");
  }
  return sanitized;
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
  return INLINE_CREDENTIAL_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
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
