import { readFileSync } from "node:fs";
import path, { basename } from "node:path";
import { fileURLToPath } from "node:url";

const LOLBAS_INDEX_FILE = fileURLToPath(
  new URL("../../data/lolbas-index.json", import.meta.url),
);
const LOLBAS_REFERENCE_PREFIX =
  "https://lolbas-project.github.io/lolbas/Binaries/";
const DIRECT_ALIASES = new Map([
  ["bitsadmin", "bitsadmin.exe"],
  ["certutil", "certutil.exe"],
  ["cmd", "cmd.exe"],
  ["cmdkey", "cmdkey.exe"],
  ["cmstp", "cmstp.exe"],
  ["cscript", "cscript.exe"],
  ["ftp", "ftp.exe"],
  ["installutil", "installutil.exe"],
  ["msbuild", "msbuild.exe"],
  ["mshta", "mshta.exe"],
  ["msiexec", "msiexec.exe"],
  ["odbcconf", "odbcconf.exe"],
  ["powershell", "powershell.exe"],
  ["pwsh", "pwsh.exe"],
  ["regsvr32", "regsvr32.exe"],
  ["rundll32", "rundll32.exe"],
  ["wmic", "wmic.exe"],
  ["wscript", "wscript.exe"],
]);
const MATCH_FIELDS = [
  "action",
  "arguments",
  "cmdline",
  "command",
  "command_line",
  "command_line_template",
  "description",
  "display_name",
  "executable",
  "name",
  "path",
  "program",
  "source",
];
const STANDALONE_COMMAND_PATTERN =
  /\b(bitsadmin|certutil|cmd|cmdkey|cmstp|cscript|ftp|installutil|msbuild|mshta|msiexec|odbcconf|powershell|pwsh|regsvr32|rundll32|wmic|wscript)\b/gi;
const WINDOWS_EXECUTABLE_PATTERN =
  /(?:[a-z]:\\[^\s"'`,;|]+|\\\\[^\s"'`,;|]+|[a-z0-9._-]+)\.(?:exe|cmd|bat|dll|hta|js|jse|ps1|vbs|vbe|wsf|wsh)\b/gi;

const LOLBAS_INDEX = loadLolbasIndex();

function loadLolbasIndex() {
  try {
    return JSON.parse(readFileSync(LOLBAS_INDEX_FILE, "utf8"));
  } catch {
    return { entries: {}, source: "", sourceRef: "" };
  }
}

function normalizeCandidate(candidate) {
  if (!candidate || typeof candidate !== "string") {
    return undefined;
  }
  const trimmed = candidate
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\\/g, "/");
  if (!trimmed) {
    return undefined;
  }
  return basename(trimmed).toLowerCase();
}

function uniqueSortedStrings(values) {
  return Array.from(
    new Set(
      values.filter(
        (value) => typeof value === "string" && value.trim().length,
      ),
    ),
  ).sort();
}

function resolveLolbasCandidate(candidate) {
  const normalized = normalizeCandidate(candidate);
  if (!normalized) {
    return undefined;
  }
  if (LOLBAS_INDEX.entries?.[normalized]) {
    return normalized;
  }
  const alias = DIRECT_ALIASES.get(normalized);
  if (alias && LOLBAS_INDEX.entries?.[alias]) {
    return alias;
  }
  return undefined;
}

function deriveRiskTags(entry) {
  const riskTags = new Set(entry?.riskTags || []);
  const functions = new Set(entry?.functions || []);
  const contexts = new Set(entry?.contexts || []);
  if (
    functions.has("proxy-execution") ||
    functions.has("library-load") ||
    functions.has("script-execution")
  ) {
    riskTags.add("proxy-execution");
  }
  if (
    functions.has("download") ||
    functions.has("upload") ||
    functions.has("credential-access")
  ) {
    riskTags.add("high-signal");
  }
  if (contexts.has("uac-bypass")) {
    riskTags.add("uac-bypass");
  }
  if (functions.has("download") || functions.has("upload")) {
    riskTags.add("network-transfer");
  }
  return Array.from(riskTags).sort();
}

function collectValueCandidates(value) {
  if (!value || typeof value !== "string") {
    return [];
  }
  const candidates = new Set();
  for (const match of value.matchAll(WINDOWS_EXECUTABLE_PATTERN)) {
    candidates.add(match[0]);
  }
  for (const match of value.matchAll(STANDALONE_COMMAND_PATTERN)) {
    candidates.add(match[1]);
  }
  return Array.from(candidates);
}

/**
 * Resolve LOLBAS metadata for a binary or script name.
 *
 * @param {string} candidate Binary or script path/name
 * @returns {object|undefined} Matched LOLBAS metadata
 */
export function getLolbasMetadata(candidate) {
  const canonicalName = resolveLolbasCandidate(candidate);
  if (!canonicalName) {
    return undefined;
  }
  const entry = LOLBAS_INDEX.entries[canonicalName];
  return {
    attackTactics: uniqueSortedStrings(entry.attackTactics || []),
    attackTechniques: uniqueSortedStrings(entry.attackTechniques || []),
    canonicalName,
    contexts: uniqueSortedStrings(entry.contexts || []),
    functions: uniqueSortedStrings(entry.functions || []),
    reference:
      entry.reference ||
      `${LOLBAS_REFERENCE_PREFIX}${encodeURIComponent(path.parse(canonicalName).name)}/`,
    riskTags: deriveRiskTags(entry),
    source: LOLBAS_INDEX.source,
    sourceRef: LOLBAS_INDEX.sourceRef,
  };
}

/**
 * Resolve LOLBAS properties for an osquery row.
 *
 * @param {string} queryCategory Osquery query category
 * @param {object} row Osquery row
 * @returns {Array<object>} CycloneDX custom properties
 */
export function createLolbasProperties(queryCategory, row) {
  const matches = new Map();
  for (const field of MATCH_FIELDS) {
    const fieldValue = row?.[field];
    if (!fieldValue) {
      continue;
    }
    for (const candidate of collectValueCandidates(String(fieldValue))) {
      const metadata = getLolbasMetadata(candidate);
      if (!metadata) {
        continue;
      }
      const existing = matches.get(metadata.canonicalName) || {
        fields: new Set(),
        metadata,
      };
      existing.fields.add(field);
      matches.set(metadata.canonicalName, existing);
    }
  }
  if (!matches.size) {
    return [];
  }
  const attackTactics = uniqueSortedStrings(
    Array.from(matches.values()).flatMap(
      (match) => match.metadata.attackTactics,
    ),
  );
  const attackTechniques = uniqueSortedStrings(
    Array.from(matches.values()).flatMap(
      (match) => match.metadata.attackTechniques,
    ),
  );
  const contexts = uniqueSortedStrings(
    Array.from(matches.values()).flatMap((match) => match.metadata.contexts),
  );
  const functions = uniqueSortedStrings(
    Array.from(matches.values()).flatMap((match) => match.metadata.functions),
  );
  const references = uniqueSortedStrings(
    Array.from(matches.values()).map((match) => match.metadata.reference),
  );
  const riskTags = uniqueSortedStrings(
    Array.from(matches.values()).flatMap((match) => match.metadata.riskTags),
  );
  const matchFields = uniqueSortedStrings(
    Array.from(matches.values()).flatMap((match) => Array.from(match.fields)),
  );
  const names = uniqueSortedStrings(Array.from(matches.keys()));
  const properties = [
    { name: "cdx:lolbas:matched", value: "true" },
    { name: "cdx:lolbas:names", value: names.join(",") },
    { name: "cdx:lolbas:matchFields", value: matchFields.join(",") },
    { name: "cdx:lolbas:queryCategory", value: queryCategory },
    { name: "cdx:lolbas:sourceRef", value: LOLBAS_INDEX.sourceRef || "" },
  ];
  if (functions.length) {
    properties.push({
      name: "cdx:lolbas:functions",
      value: functions.join(","),
    });
  }
  if (contexts.length) {
    properties.push({
      name: "cdx:lolbas:contexts",
      value: contexts.join(","),
    });
  }
  if (riskTags.length) {
    properties.push({
      name: "cdx:lolbas:riskTags",
      value: riskTags.join(","),
    });
  }
  if (attackTactics.length) {
    properties.push({
      name: "cdx:lolbas:attackTactics",
      value: attackTactics.join(","),
    });
  }
  if (attackTechniques.length) {
    properties.push({
      name: "cdx:lolbas:attackTechniques",
      value: attackTechniques.join(","),
    });
  }
  if (references.length) {
    properties.push({
      name: "cdx:lolbas:references",
      value: references.join(","),
    });
  }
  return properties;
}
