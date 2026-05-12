import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

const GTFOBINS_INDEX_FILE = fileURLToPath(
  new URL("../../data/gtfobins-index.json", import.meta.url),
);
const GTFOBINS_REFERENCE_PREFIX = "https://gtfobins.github.io/gtfobins/";
const PRIVILEGED_CONTEXTS = ["sudo", "suid", "capabilities"];
const MATCH_FIELDS = [
  "name",
  "path",
  "cmdline",
  "parent_cmdline",
  "action",
  "program",
  "executable",
  "description",
];
const UNIX_PATH_PATTERN = /(?:^|[\s'"`=;|&(])((?:\.{0,2}\/|\/)[^\s'"`|;&()]+)/g;
const STANDALONE_COMMAND_PATTERN =
  /(?:^|[\s;|&(])([a-z_][a-z0-9+._-]{1,})(?=$|[\s'"`|;&()])/gi;
const CONTAINER_ESCAPE_HELPERS = new Set([
  "chroot",
  "ctr",
  "docker",
  "kubectl",
  "mount",
  "nsenter",
  "tar",
  "unshare",
]);
const DIRECT_ALIASES = new Map([["nodejs", "node"]]);
const VERSIONED_ALIASES = [
  { pattern: /^python(?:\d+(?:\.\d+)*)?$/i, target: "python" },
  { pattern: /^perl(?:\d+(?:\.\d+)*)?$/i, target: "perl" },
  { pattern: /^ruby(?:\d+(?:\.\d+)*)?$/i, target: "ruby" },
  { pattern: /^php(?:\d+(?:\.\d+)*)?$/i, target: "php" },
  { pattern: /^lua(?:\d+(?:\.\d+)*)?$/i, target: "lua" },
  { pattern: /^node(?:\d+(?:\.\d+)*)?$/i, target: "node" },
];

const GTFOBINS_INDEX = loadGtfoBinsIndex();

function loadGtfoBinsIndex() {
  try {
    return JSON.parse(readFileSync(GTFOBINS_INDEX_FILE, "utf8"));
  } catch {
    return { entries: {}, source: GTFOBINS_REFERENCE_PREFIX, sourceRef: "" };
  }
}

function uniqueSortedStrings(values) {
  return [...new Set((values || []).filter(Boolean))].sort();
}

function collectValueCandidates(value) {
  if (!value || typeof value !== "string") {
    return [];
  }
  const candidates = new Set();
  const trimmedValue = value.trim();
  if (trimmedValue) {
    candidates.add(trimmedValue);
  }
  for (const match of value.matchAll(UNIX_PATH_PATTERN)) {
    if (match[1]) {
      candidates.add(match[1]);
    }
  }
  for (const match of value.matchAll(STANDALONE_COMMAND_PATTERN)) {
    if (match[1]) {
      candidates.add(match[1]);
    }
  }
  return Array.from(candidates);
}

function resolveCandidateName(candidate) {
  if (!candidate || typeof candidate !== "string") {
    return undefined;
  }
  const trimmed = basename(candidate.trim());
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed.toLowerCase();
  if (GTFOBINS_INDEX.entries?.[trimmed]) {
    return { canonicalName: trimmed, matchSource: "basename" };
  }
  if (GTFOBINS_INDEX.entries?.[normalized]) {
    return { canonicalName: normalized, matchSource: "basename" };
  }
  const directAlias = DIRECT_ALIASES.get(normalized);
  if (directAlias && GTFOBINS_INDEX.entries?.[directAlias]) {
    return { canonicalName: directAlias, matchSource: "alias" };
  }
  for (const aliasRule of VERSIONED_ALIASES) {
    if (
      aliasRule.pattern.test(normalized) &&
      GTFOBINS_INDEX.entries?.[aliasRule.target]
    ) {
      return { canonicalName: aliasRule.target, matchSource: "alias" };
    }
  }
  return undefined;
}

function deriveRiskTags(entry, canonicalName) {
  const functions = new Set(entry?.functions || []);
  const contexts = new Set(entry?.contexts || []);
  const riskTags = new Set();
  const hasExecPrimitive =
    functions.has("shell") ||
    functions.has("command") ||
    functions.has("reverse-shell") ||
    functions.has("bind-shell");
  const hasNetworkPrimitive =
    functions.has("upload") ||
    functions.has("download") ||
    functions.has("reverse-shell") ||
    functions.has("bind-shell");
  if (functions.has("privilege-escalation")) {
    riskTags.add("privilege-escalation");
  }
  if (
    contexts.has("sudo") ||
    contexts.has("suid") ||
    contexts.has("capabilities")
  ) {
    riskTags.add("privilege-escalation");
  }
  if (hasExecPrimitive && hasNetworkPrimitive) {
    riskTags.add("lateral-movement");
  }
  if (functions.has("upload") || functions.has("file-read")) {
    riskTags.add("data-exfiltration");
  }
  if (functions.has("file-write") || functions.has("library-load")) {
    riskTags.add("persistence");
  }
  if (
    CONTAINER_ESCAPE_HELPERS.has(canonicalName) &&
    (hasExecPrimitive ||
      functions.has("privilege-escalation") ||
      functions.has("library-load"))
  ) {
    riskTags.add("container-escape");
  }
  return Array.from(riskTags).sort();
}

export function getGtfoBinsMetadata(name, linkedName) {
  const directMatch = resolveCandidateName(name);
  if (directMatch) {
    const entry = GTFOBINS_INDEX.entries[directMatch.canonicalName];
    return {
      canonicalName: directMatch.canonicalName,
      contexts: entry.contexts,
      functions: entry.functions,
      matchSource: directMatch.matchSource,
      mitreTechniques: entry.mitreTechniques,
      privilegedContexts: entry?.contexts?.filter((context) =>
        PRIVILEGED_CONTEXTS.includes(context),
      ),
      reference: `${GTFOBINS_REFERENCE_PREFIX}${encodeURIComponent(directMatch.canonicalName)}/`,
      riskTags: deriveRiskTags(entry, directMatch.canonicalName),
      source: GTFOBINS_INDEX.source,
      sourceRef: GTFOBINS_INDEX.sourceRef,
    };
  }
  const linkedMatch = resolveCandidateName(linkedName);
  if (!linkedMatch) {
    return undefined;
  }
  const entry = GTFOBINS_INDEX.entries[linkedMatch.canonicalName];
  return {
    canonicalName: linkedMatch.canonicalName,
    contexts: entry.contexts,
    functions: entry.functions,
    matchSource: "symlink",
    mitreTechniques: entry.mitreTechniques,
    privilegedContexts: entry.contexts.filter((context) =>
      PRIVILEGED_CONTEXTS.includes(context),
    ),
    reference: `${GTFOBINS_REFERENCE_PREFIX}${encodeURIComponent(linkedMatch.canonicalName)}/`,
    riskTags: deriveRiskTags(entry, linkedMatch.canonicalName),
    source: GTFOBINS_INDEX.source,
    sourceRef: GTFOBINS_INDEX.sourceRef,
  };
}

export function createGtfoBinsProperties(name, linkedName) {
  const metadata = getGtfoBinsMetadata(name, linkedName);
  if (!metadata) {
    return [];
  }
  const properties = [
    { name: "cdx:gtfobins:matched", value: "true" },
    { name: "cdx:gtfobins:name", value: metadata.canonicalName },
    { name: "cdx:gtfobins:matchSource", value: metadata.matchSource },
    { name: "cdx:gtfobins:functions", value: metadata.functions.join(",") },
    { name: "cdx:gtfobins:contexts", value: metadata.contexts.join(",") },
    { name: "cdx:gtfobins:reference", value: metadata.reference },
    { name: "cdx:gtfobins:sourceRef", value: metadata.sourceRef || "" },
  ];
  if (metadata.mitreTechniques.length) {
    properties.push({
      name: "cdx:gtfobins:mitreTechniques",
      value: metadata.mitreTechniques.join(","),
    });
  }
  if (metadata.privilegedContexts.length) {
    properties.push({
      name: "cdx:gtfobins:privilegedContexts",
      value: metadata.privilegedContexts.join(","),
    });
  }
  if (metadata.riskTags.length) {
    properties.push({
      name: "cdx:gtfobins:riskTags",
      value: metadata.riskTags.join(","),
    });
  }
  return properties;
}

/**
 * Resolve GTFOBins properties for a live Linux osquery row.
 *
 * @param {string} queryCategory Osquery query category
 * @param {object} row Osquery row
 * @returns {Array<object>} CycloneDX custom properties
 */
export function createGtfoBinsPropertiesFromRow(queryCategory, row) {
  const matches = new Map();
  for (const field of MATCH_FIELDS) {
    const fieldValue = row?.[field];
    if (!fieldValue) {
      continue;
    }
    for (const candidate of collectValueCandidates(String(fieldValue))) {
      const metadata = getGtfoBinsMetadata(candidate);
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
  const names = uniqueSortedStrings(Array.from(matches.keys()));
  const matchFields = uniqueSortedStrings(
    Array.from(matches.values()).flatMap((match) => Array.from(match.fields)),
  );
  const functions = uniqueSortedStrings(
    Array.from(matches.values()).flatMap((match) => match.metadata.functions),
  );
  const contexts = uniqueSortedStrings(
    Array.from(matches.values()).flatMap((match) => match.metadata.contexts),
  );
  const privilegedContexts = uniqueSortedStrings(
    Array.from(matches.values()).flatMap(
      (match) => match.metadata.privilegedContexts,
    ),
  );
  const references = uniqueSortedStrings(
    Array.from(matches.values()).map((match) => match.metadata.reference),
  );
  const riskTags = uniqueSortedStrings(
    Array.from(matches.values()).flatMap((match) => match.metadata.riskTags),
  );
  const mitreTechniques = uniqueSortedStrings(
    Array.from(matches.values()).flatMap(
      (match) => match.metadata.mitreTechniques,
    ),
  );
  const properties = [
    { name: "cdx:gtfobins:matched", value: "true" },
    { name: "cdx:gtfobins:names", value: names.join(",") },
    { name: "cdx:gtfobins:matchFields", value: matchFields.join(",") },
    { name: "cdx:gtfobins:queryCategory", value: queryCategory },
    { name: "cdx:gtfobins:reference", value: references.join(",") },
    { name: "cdx:gtfobins:sourceRef", value: GTFOBINS_INDEX.sourceRef || "" },
  ];
  if (functions.length) {
    properties.push({
      name: "cdx:gtfobins:functions",
      value: functions.join(","),
    });
  }
  if (contexts.length) {
    properties.push({
      name: "cdx:gtfobins:contexts",
      value: contexts.join(","),
    });
  }
  if (privilegedContexts.length) {
    properties.push({
      name: "cdx:gtfobins:privilegedContexts",
      value: privilegedContexts.join(","),
    });
  }
  if (riskTags.length) {
    properties.push({
      name: "cdx:gtfobins:riskTags",
      value: riskTags.join(","),
    });
  }
  if (mitreTechniques.length) {
    properties.push({
      name: "cdx:gtfobins:mitreTechniques",
      value: mitreTechniques.join(","),
    });
  }
  return properties;
}
