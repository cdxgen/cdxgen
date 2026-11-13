import process from "node:process";

import {
  isSensitiveEnvironmentVariableName,
  readEnvironmentVariable,
} from "./activity.js";
import { hasInlineCredential } from "./propertySanitizer.js";

// Names of environment variables that carry a package index URL, which may
// hold a token in its path or userinfo.
const INDEX_URL_ENV_SUFFIXES = ["_INDEX_URL", "_INDEX", "_DEFAULT_INDEX"];
// Short credential suffixes isSensitiveEnvironmentVariableName() leaves out.
const SHORT_CREDENTIAL_ENV_SUFFIXES = ["_PAT", "_PSW", "_PWD", "_PW"];
// Account names that hold no secret and would otherwise mask every home
// directory in the output.
const ACCOUNT_ENV_NAMES = new Set(["LOGNAME", "SUDO_USER", "USER", "USERNAME"]);
// Values shorter than this are too common to replace wherever they appear.
const MIN_REDACTED_ENV_VALUE_LENGTH = 8;

function isCredentialEnvName(name) {
  const upper = name.toUpperCase();
  if (ACCOUNT_ENV_NAMES.has(upper) || upper.endsWith("_EMAIL")) {
    return false;
  }
  return (
    isSensitiveEnvironmentVariableName(name) ||
    SHORT_CREDENTIAL_ENV_SUFFIXES.some((suffix) => upper.endsWith(suffix)) ||
    INDEX_URL_ENV_SUFFIXES.some((suffix) => upper.endsWith(suffix))
  );
}

// Values of credential-like environment variables, longest first so a value
// that contains another is replaced whole.
function credentialEnvValues() {
  const values = new Set();
  for (const name of Object.keys(process.env)) {
    if (!isCredentialEnvName(name)) {
      continue;
    }
    const value = readEnvironmentVariable(name, { sensitive: true });
    if (
      typeof value === "string" &&
      value.trim().length >= MIN_REDACTED_ENV_VALUE_LENGTH
    ) {
      values.add(value.trim());
    }
  }
  return [...values].sort((a, b) => b.length - a.length);
}

// A URL path segment that looks like an access token: long, made only of
// token characters, and mixing letters with digits. File names keep their
// dot and are left alone.
function isTokenLikePathSegment(segment) {
  if (segment.length < 20 || !/^[A-Za-z0-9_-]+$/.test(segment)) {
    return false;
  }
  return /[0-9]/.test(segment) && /[A-Za-z]/.test(segment);
}

// Replace token-like segments in the path of every URL in the text. The scan
// starts at each "://", so it stays linear in the length of the text.
function redactUrlPathTokens(text) {
  return text.replace(/:\/\/[^\s'"<>]+/g, (url) => {
    const pathStart = url.indexOf("/", 3);
    if (pathStart === -1) {
      return url;
    }
    let pathEnd = url.length;
    for (const delimiter of ["?", "#"]) {
      const index = url.indexOf(delimiter, pathStart);
      if (index !== -1 && index < pathEnd) {
        pathEnd = index;
      }
    }
    const segments = url
      .slice(pathStart, pathEnd)
      .split("/")
      .map((segment) =>
        isTokenLikePathSegment(segment) || hasInlineCredential(segment)
          ? "***"
          : segment,
      );
    return `${url.slice(0, pathStart)}${segments.join("/")}${url.slice(pathEnd)}`;
  });
}

/**
 * Remove credentials from the output of a package manager (npm, yarn, pnpm,
 * rush, pip, uv, poetry) before it is logged. A failed install names the URLs
 * it could not fetch, taken from the scanned manifest or expanded from the
 * environment, and these tools mask at most the password. The values of
 * credential-like environment variables (names ending in `_TOKEN`,
 * `_PASSWORD`, `_SECRET`, `_PAT` and the like, and index URL variables such
 * as `PIP_INDEX_URL`) are replaced by *** wherever they appear. Every URL
 * then loses its user name and password, path
 * segments that look like access tokens (as in `https://host/<token>/simple/`),
 * and its query string, since signed URLs and private tokens travel there.
 * pip prints retry lines as a bare `/path?query`, so the query rule applies
 * to any `?` run and not only inside a full URL. A fragment (`#sha256=...`) is
 * kept.
 *
 * An Error, such as the `error` of a spawn result, becomes its name and
 * message, redacted the same way.
 *
 * @param {string|Error|undefined} text Output of a package manager command
 * @returns {string|undefined} Output with credentials replaced by ***
 */
export function redactPackageManagerOutput(text) {
  if (text instanceof Error) {
    // Printing the error itself would also print its spawnargs.
    return redactPackageManagerOutput(`${text.name}: ${text.message}`);
  }
  if (!text || typeof text !== "string") {
    return text;
  }
  let redacted = text;
  for (const value of credentialEnvValues()) {
    redacted = redacted.split(value).join("***");
  }
  // One pass over each "://"; the class excludes "/", so a scan never runs
  // past the authority, and the greedy match ends at its last "@".
  redacted = redacted.replace(/:\/\/[^/?#'"<> \t\r\n]*@/g, "://***:***@");
  return redactUrlPathTokens(redacted).replace(/\?[^\s'"<>#]+/g, "?***");
}
