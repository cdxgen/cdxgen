import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { dirNameStr, safeExistsSync } from "./utils.js";

const GTFOBINS_INDEX_FILE = join(dirNameStr, "data", "gtfobins-index.json");
const GTFOBINS_REFERENCE_PREFIX = "https://gtfobins.github.io/gtfobins/";
const PRIVILEGED_CONTEXTS = ["sudo", "suid", "capabilities"];
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
  if (!safeExistsSync(GTFOBINS_INDEX_FILE)) {
    return { entries: {}, source: GTFOBINS_REFERENCE_PREFIX, sourceRef: "" };
  }
  try {
    return JSON.parse(readFileSync(GTFOBINS_INDEX_FILE, "utf8"));
  } catch {
    return { entries: {}, source: GTFOBINS_REFERENCE_PREFIX, sourceRef: "" };
  }
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
      privilegedContexts: entry.contexts.filter((context) =>
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
