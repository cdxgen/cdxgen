import path from "node:path";

const DANGEROUS_OBJECT_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
const INLINE_CREDENTIAL_PATTERNS = [
  /\bAKIA[0-9A-Z]{16}\b/gu,
  /\bbearer\s+[a-z0-9._-]{16,}\b/giu,
  /\b(?:sk|rk|pk)_[a-z0-9_-]{8,}\b/giu,
  /\bgh[pousr]_[a-z0-9]{20,}\b/giu,
  /\bAIza[0-9A-Za-z_-]{20,}\b/gu,
];
const JSON_PROPERTY_NAMES = new Set([
  "cdx:agent:permission",
  "cdx:mcp:toolAnnotations",
  "cdx:skill:metadata",
]);
const URL_PATTERN = /https?:\/\/[^\s<>"'),\]}]+/giu;

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

function sanitizeStructuredValueForBom(value) {
  if (typeof value === "string") {
    return sanitizeTextForBom(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeStructuredValueForBom(entry));
  }
  if (value && typeof value === "object") {
    const sanitized = {};
    for (const [key, entryValue] of Object.entries(value)) {
      if (DANGEROUS_OBJECT_KEYS.has(key)) {
        continue;
      }
      sanitized[key] = sanitizeStructuredValueForBom(entryValue);
    }
    return sanitized;
  }
  return value;
}

function extractCommandExecutable(command) {
  const trimmedCommand = String(command || "").trim();
  if (!trimmedCommand) {
    return "";
  }
  const quotedMatch = trimmedCommand.match(/^(['"])(.*?)\1/u);
  if (quotedMatch?.[2]) {
    return quotedMatch[2];
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

export function sanitizeBomUrl(value) {
  return sanitizeUrlForBom(value);
}

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
