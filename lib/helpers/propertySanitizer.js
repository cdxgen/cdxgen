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
  /\b(?:eyJ[a-z0-9_-]+\.[a-z0-9._-]+\.[a-z0-9._-]+)\b/giu,
];
const SENSITIVE_KEY_PATTERN =
  /(?:api[-_]?key|auth(?:orization)?|bearer|credential|passwd|password|secret|session|token)/iu;
const JSON_PROPERTY_NAMES = new Set([
  "cdx:agent:permission",
  "cdx:mcp:toolAnnotations",
  "cdx:skill:metadata",
]);
const URL_PATTERN = /https?:\/\/[^\s<>"'),\]}]+/giu;
const MAX_STRUCTURE_DEPTH = 6;

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
    return input;
  }
}

function sanitizeTextForBom(value) {
  let sanitized = String(value ?? "");
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
 * Sanitize a URL value for safe BOM emission.
 *
 * @param {string} value URL value
 * @returns {string} sanitized URL
 */
export function sanitizeBomUrl(value) {
  return sanitizeUrlForBom(value);
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
