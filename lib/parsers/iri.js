const IREG_NAME_CHAR_REGEX =
  /^([a-zA-Z0-9\-._~!$&'()*+,;=\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF]|%[a-fA-F0-9]{2})*$/u;

/**
 * Represents the parsed components of an IRI.
 * @typedef {Object} IRIComponents
 * @property {string} scheme
 * @property {string} [userinfo]
 * @property {string} [host]
 * @property {string} [port]
 * @property {string} path
 * @property {string} [query]
 * @property {string} [fragment]
 * @property {boolean} valid
 * @property {string} [error]
 */

/**
 * Parses an IRI string according to RFC 3987.
 * @param {string} iri The IRI string to parse.
 * @returns {IRIComponents} An object containing the parsed components and validity status.
 */
export function parseIRI(iri) {
  // Initialize result object
  const result = {
    scheme: "",
    path: "",
    valid: false,
    hasAuthority: false,
    error: "Parsing not started",
  };

  if (typeof iri !== "string") {
    result.error = "Input must be a string";
    return result;
  }

  if (iri.length === 0) {
    result.error = "Input IRI is empty";
    return result;
  }

  if (iri.trim() !== iri) {
    result.error = "Input IRI is not trimmed";
    return result;
  }

  let index = 0;
  const len = iri.length;

  // --- 1. Parse Scheme ---
  // scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )
  const schemeStart = index;
  if (index >= len || !isAlpha(iri.codePointAt(index))) {
    result.error = "IRI must start with a scheme";
    return result;
  }
  index++; // Consume the first ALPHA
  while (index < len) {
    const code = iri.codePointAt(index);
    if (
      isAlpha(code) ||
      isDigit(code) ||
      code === 0x2b ||
      code === 0x2d ||
      code === 0x2e
    ) {
      // + - .
      // Move index by the character's UTF-16 code unit length
      index += code >= 0x10000 ? 2 : 1;
    } else {
      break;
    }
  }
  if (index === schemeStart) {
    result.error = "Scheme parsing failed";
    return result;
  }
  result.scheme = iri.substring(schemeStart, index);

  // Expect ':'
  if (index >= len || iri.codePointAt(index) !== 0x3a) {
    // ':'
    result.error = "Scheme must be followed by a colon";
    return result;
  }
  index++; // Consume ':'

  // --- 2. Parse Hierarchical Part (ihier-part) ---
  // ihier-part = "//" iauthority ipath-abempty / ipath-absolute / ipath-rootless / ipath-empty
  // Check for "//" indicating authority is present
  let hasAuthority = false;
  let authorityEnd;
  if (
    index + 1 < len &&
    iri.codePointAt(index) === 0x2f &&
    iri.codePointAt(index + 1) === 0x2f
  ) {
    // "//"
    hasAuthority = true;
    index += 2; // Consume "//"

    // --- 2a. Parse Authority (iauthority) ---
    // iauthority = [ iuserinfo "@" ] ihost [ ":" port ]
    const authorityStart = index;
    authorityEnd = index;
    // Find the end of the authority component
    // It ends at the first '/', '?', or '#' or at the end of the string
    while (authorityEnd < len) {
      const code = iri.codePointAt(authorityEnd);
      if (code === 0x2f || code === 0x3f || code === 0x23) {
        // '/', '?', '#'
        break;
      }
      authorityEnd += code >= 0x10000 ? 2 : 1;
    }

    if (authorityStart < authorityEnd) {
      const authority = iri.substring(authorityStart, authorityEnd);
      const userInfoEndIdx = findUserInfoEnd(authority);

      let host_part;
      let port_part;

      if (userInfoEndIdx !== -1) {
        result.userinfo = authority.substring(0, userInfoEndIdx);
        const hostPortStr = authority.substring(userInfoEndIdx + 1);
        [host_part, port_part] = parseHostPort(hostPortStr);
      } else {
        [host_part, port_part] = parseHostPort(authority);
      }

      // --- Validation: Check if host_part is a valid ireg-name ---
      // Only validate if it's not an IP-literal (doesn't start with '[')
      // parseHostPort should handle IPv4 structural checks.
      if (host_part && !host_part.startsWith("[")) {
        // Trim potential trailing colon from empty port (e.g., "host:")
        // This can happen if the authority ends with ':'
        const trimmedHost = host_part.endsWith(":")
          ? host_part.slice(0, -1)
          : host_part;
        if (!IREG_NAME_CHAR_REGEX.test(trimmedHost)) {
          // Find a specific character that failed? Not strictly necessary for boolean check,
          // but helpful for error message. Let's keep it simple for now.
          result.error = `Invalid character in host (ireg-name) '${trimmedHost}' for IRI '${iri}'`;
          return result; // valid remains false
        }
      }
      // --- End Validation ---

      result.host = host_part;
      result.port = port_part;
    }
    index = authorityEnd;
  } // else hasAuthority remains false, index is right after ':'

  // --- 3. Parse Path (one of ipath-abempty, ipath-absolute, ipath-rootless)
  const pathStart = hasAuthority ? authorityEnd : index;
  // Path ends at the first '?' or '#' or at the end of the string
  while (index < len) {
    const code = iri.codePointAt(index);
    if (code === 0x3f || code === 0x23) {
      // '?' '#'
      break;
    }
    index += code >= 0x10000 ? 2 : 1;
  }
  result.path = iri.substring(pathStart, index);

  // --- 4. Parse Query (?)
  if (index < len && iri.codePointAt(index) === 0x3f) {
    // '?'
    index++; // Consume '?'
    const queryStart = index;
    // Query ends at the first '#' or at the end of the string
    while (index < len && iri.codePointAt(index) !== 0x23) {
      // '#'
      const code = iri.codePointAt(index);
      index += code >= 0x10000 ? 2 : 1;
    }
    result.query = iri.substring(queryStart, index);
  }

  // --- 5. Parse Fragment (#)
  if (index < len && iri.codePointAt(index) === 0x23) {
    // '#'
    index++; // Consume '#'
    const fragmentStart = index;
    // Fragment ends at the end of the string
    index = len;
    result.fragment = iri.substring(fragmentStart, index);
  }
  result.hasAuthority = hasAuthority;
  // --- Final Validation ---
  result.valid = true;
  delete result.error;
  return result;
}

// --- Helper Functions ---

function isAlpha(code) {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a); // A-Z or a-z
}

function isDigit(code) {
  return code >= 0x30 && code <= 0x39; // 0-9
}

/**
 * Finds the index of the last '@' character that is not inside an IPv6 literal [ ... ].
 * Returns -1 if no such '@' is found.
 */
function findUserInfoEnd(authority) {
  let inIPv6Literal = false;
  let userInfoEndIndex = -1;

  for (let i = 0; i < authority.length; ) {
    const code = authority.codePointAt(i);
    const charLength = code >= 0x10000 ? 2 : 1;

    if (code === 0x5b) {
      // '['
      inIPv6Literal = true;
    } else if (code === 0x5d) {
      // ']'
      inIPv6Literal = false;
    } else if (code === 0x40 && !inIPv6Literal) {
      // '@'
      userInfoEndIndex = i; // Keep track of the last one outside brackets
    }
    i += charLength; // Move by the actual character length
  }
  return userInfoEndIndex;
}

/**
 * Parses the host and port from a string like "example.com:8080" or "[::1]:3000".
 * Returns an array [host, port], where port can be undefined.
 */
function parseHostPort(hostPortStr) {
  if (hostPortStr.length === 0) {
    return ["", undefined];
  }

  // Check for IPv6 literal [ ... ]
  if (hostPortStr.codePointAt(0) === 0x5b) {
    // '['
    const endBracketIdx = hostPortStr.indexOf("]");
    if (endBracketIdx === -1) {
      // Malformed IPv6 literal - no closing bracket
      return [hostPortStr, undefined];
    }
    const host = hostPortStr.substring(0, endBracketIdx + 1); // Include ']'

    // Check if there's anything after the closing bracket
    const afterBracket = hostPortStr.substring(endBracketIdx + 1);

    // If there's content after the bracket, it must start with a colon (for port)
    if (afterBracket.length > 0 && afterBracket[0] !== ":") {
      // Invalid character after closing bracket - return the whole string as host
      // This will cause validation to fail later
      return [hostPortStr, undefined];
    }

    if (afterBracket.length > 0) {
      // It starts with a colon, parse the port
      const port = afterBracket.substring(1); // Everything after the colon
      return [host, port || undefined];
    }
    return [host, undefined]; // No port
  }
  // Not an IPv6 literal, look for the last ':' not %-encoded
  let portSepIdx = -1;
  for (let i = hostPortStr.length - 1; i >= 0; i--) {
    if (hostPortStr.codePointAt(i) === 0x3a) {
      // ':'
      // Check if it's percent-encoded (e.g., %3A)
      // Ensure we have at least 3 chars before ':'
      if (
        i >= 3 &&
        hostPortStr.codePointAt(i - 1) === 0x25 && // '%'
        isHexDigit(hostPortStr.codePointAt(i - 2)) &&
        isHexDigit(hostPortStr.codePointAt(i - 3))
      ) {
        // ignore
      } else {
        // This is the separator we are looking for
        portSepIdx = i;
        break;
      }
    }
    // Adjust index for potential surrogate pairs when moving backwards
    // This simple backward loop is okay for ASCII ':' check,
    // but full Unicode backward iteration is complex.
    // For ':' (U+003A), simple `i--` works.
  }

  if (portSepIdx !== -1) {
    const host = hostPortStr.substring(0, portSepIdx);
    const port = hostPortStr.substring(portSepIdx + 1);
    return [host, port || undefined]; // Handle case like "host:" (port is empty)
  }
  return [hostPortStr, undefined]; // No port separator found
}

function isHexDigit(code) {
  return (
    (code >= 0x30 && code <= 0x39) || // 0-9
    (code >= 0x41 && code <= 0x46) || // A-F
    (code >= 0x61 && code <= 0x66)
  ); // a-f
}

// --- Helper functions for detailed RFC 3987 validation ---
// RFC 3987 unreserved characters (including Unicode)
const UNRESERVED_CHARS =
  "a-zA-Z0-9\\-._~\\u00A0-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFEF\\u0400-\\u04FF\\u0590-\\u05FF\\u0600-\\u06FF\\u0900-\\u097F\\u4E00-\\u9FFF\\uAC00-\\uD7AF";

// RFC 3987 sub-delims
const SUB_DELIMS_CHARS = "!$&'()*+,;=";

// Percent-encoded pattern
const PCT_ENCODED_PATTERN = "%[a-fA-F0-9]{2}";

// ipchar = iunreserved / pct-encoded / sub-delims / ":" / "@"
const IPCHAR_PATTERN = `(?:[${UNRESERVED_CHARS}${SUB_DELIMS_CHARS}:@]|${PCT_ENCODED_PATTERN})`;

// ireg-name = *( iunreserved / pct-encoded / sub-delims )
const IREG_NAME_PATTERN = `(?:[${UNRESERVED_CHARS}${SUB_DELIMS_CHARS}]|${PCT_ENCODED_PATTERN})*`;

// Compile regexes
const IPCHAR_REGEX = new RegExp(`^${IPCHAR_PATTERN}*$`, "u");
const IREG_NAME_REGEX = new RegExp(`^${IREG_NAME_PATTERN}$`, "u");

function isValidIpCharSequence(str) {
  if (str === null || str === undefined) {
    return true;
  }
  return IPCHAR_REGEX.test(str);
}

function isValidIPv6(ipv6Address) {
  // Simplified regex for IPv6 address validation
  const IPV6_REGEX =
    /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$|^::$|^(?:[0-9a-fA-F]{1,4}:){1,7}:$|^::(?:[0-9a-fA-F]{1,4}:){0,6}[0-9a-fA-F]{1,4}$|^(?:[0-9a-fA-F]{1,4}:){1,6}::[0-9a-fA-F]{1,4}$|^(?:[0-9a-fA-F]{1,4}:){1,5}(?::[0-9a-fA-F]{1,4}){1,2}$|^(?:[0-9a-fA-F]{1,4}:){1,4}(?::[0-9a-fA-F]{1,4}){1,3}$|^(?:[0-9a-fA-F]{1,4}:){1,3}(?::[0-9a-fA-F]{1,4}){1,4}$|^(?:[0-9a-fA-F]{1,4}:){1,2}(?::[0-9a-fA-F]{1,4}){1,5}$|^[0-9a-fA-F]{1,4}:(?::[0-9a-fA-F]{1,4}){1,6}$|^:(?::[0-9a-fA-F]{1,4}){1,7}$/;
  return IPV6_REGEX.test(ipv6Address);
}

function isValidIregName(hostStr) {
  if (hostStr === null || hostStr === undefined || hostStr === "") {
    return true;
  }
  // Check if it's an IPv6 literal
  if (hostStr.startsWith("[") && hostStr.endsWith("]")) {
    // Extract the IPv6 address without the brackets
    const ipv6Address = hostStr.slice(1, -1);
    // Validate the IPv6 address
    return isValidIPv6(ipv6Address);
  }

  // Check if it's an IPv4 address
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(hostStr)) {
    return true;
  }

  // For internationalized domain names, we need to be more permissive
  // Allow Unicode characters in domain names
  return IREG_NAME_REGEX.test(hostStr);
}

function validateParsedComponents(components) {
  if (!components.valid) {
    return components;
  }

  // 1. Validate Authority (host part)
  if (
    components.host !== undefined &&
    components.host !== null &&
    components.host !== ""
  ) {
    if (!isValidIregName(components.host)) {
      return {
        ...components,
        valid: false,
        error: `Invalid character in ireg-name host: '${components.host}'`,
      };
    }
  }

  // 2. Validate Path segments
  if (components.path !== undefined && components.path !== null) {
    const segments = components.path.split("/");
    const isValidPath = segments.every((segment) =>
      isValidIpCharSequence(segment),
    );
    if (!isValidPath) {
      const failingSegment = segments.find((s) => !isValidIpCharSequence(s));
      return {
        ...components,
        valid: false,
        error: `Invalid character in path segment: '${failingSegment}' (Path: '${components.path}')`,
      };
    }
  }

  // 3. Validate Query
  if (components.query !== undefined && components.query !== null) {
    // iquery allows ipchar, /, ?
    const IQUERY_PATTERN = `(?:${IPCHAR_PATTERN}|[/?])*`;
    const IQUERY_REGEX = new RegExp(`^${IQUERY_PATTERN}$`, "u");
    if (!IQUERY_REGEX.test(components.query)) {
      return {
        ...components,
        valid: false,
        error: `Invalid character in query: '${components.query}'`,
      };
    }
  }

  // 4. Validate Fragment
  if (components.fragment !== undefined && components.fragment !== null) {
    // ifragment allows ipchar, /, ?
    const IFRAGMENT_PATTERN = `(?:${IPCHAR_PATTERN}|[/?])*`;
    const IFRAGMENT_REGEX = new RegExp(`^${IFRAGMENT_PATTERN}$`, "u");
    if (!IFRAGMENT_REGEX.test(components.fragment)) {
      return {
        ...components,
        valid: false,
        error: `Invalid character in fragment: '${components.fragment}'`,
      };
    }
  }

  // Special handling for IPv6 literals
  if (
    components.scheme &&
    components.host?.startsWith("[") &&
    components.host.endsWith("]")
  ) {
    return components;
  }

  if (
    components.scheme &&
    !components.host &&
    !components.path &&
    !components.query
  ) {
    return {
      ...components,
      valid: false,
      error: "No hostname",
    };
  }
  return components;
}

/**
 * Possible ways of validating an IRI.
 */
export const IriValidationStrategy = Object.freeze({
  /**
   * Validates the IRI according to RFC 3987 using a custom parser.
   */
  Parse: "parse",

  /**
   * Validates that the IRI has a valid scheme and does not contain any character forbidden by the Turtle specification.
   */
  Pragmatic: "pragmatic",

  /**
   * Does not validate the IRI at all.
   */
  None: "none",
});

// biome-ignore-start lint/suspicious/noControlCharactersInRegex: parser
// Using the regex from the original code
const PRAGMATIC_IRI_REGEX =
  /^[A-Za-z][\d+-.A-Za-z]*:[^\u0000-\u0020"<>\\^`{|}]*$/u;
// biome-ignore-end lint/suspicious/noControlCharactersInRegex: parser

/**
 * Validate a given IRI according to the given strategy.
 *
 * @param {string} iri a string that may be an IRI.
 * @param {IriValidationStrategy} strategy IRI validation strategy.
 * @return {Error | undefined} An error if the IRI is invalid, or undefined if it is valid.
 */
export function validateIri(iri, strategy = IriValidationStrategy.Parse) {
  switch (strategy) {
    case IriValidationStrategy.Parse: {
      // console.log(`DEBUG: Validating IRI: '${iri}' with Parse strategy`);
      let parseResult = parseIRI(iri);
      // console.log(
      //   "DEBUG: parseIRI result:",
      //   JSON.stringify(parseResult, null, 2),
      // ); // Log full result

      if (parseResult.valid) {
        // console.log(
        //   "DEBUG: IRI is structurally valid, performing detailed checks...",
        // );
        parseResult = validateParsedComponents(parseResult);
        // console.log(
        //   "DEBUG: validateParsedComponents result:",
        //   JSON.stringify(parseResult, null, 2),
        // ); // Log full result after detailed checks
      }

      if (parseResult.valid) {
        // console.log(`DEBUG: Final result for '${iri}': VALID`);
        return undefined;
      }
      const errorMessage =
        parseResult.error ||
        `IRI failed detailed RFC 3987 validation: '${iri}'`;
      // console.log(
      //   `DEBUG: Final result for '${iri}': INVALID - ${errorMessage}`,
      // );
      return new Error(
        `Invalid IRI according to RFC 3987 parsing: ${errorMessage}`,
      );
    }
    case IriValidationStrategy.Pragmatic:
      return PRAGMATIC_IRI_REGEX.test(iri)
        ? undefined
        : new Error(`Invalid IRI: '${iri}'`);
    case IriValidationStrategy.None:
      return undefined;
    default:
      return new Error(`Not supported validation strategy "${strategy}"`);
  }
}
