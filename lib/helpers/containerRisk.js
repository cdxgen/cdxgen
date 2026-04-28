import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { getGtfoBinsMetadata } from "./gtfobins.js";
import { dirNameStr, safeExistsSync } from "./utils.js";

const CONTAINER_RISK_INDEX_FILE = join(
  dirNameStr,
  "data",
  "container-knowledge-index.json",
);
const DEFAULT_CONTAINER_RISK_INDEX = { entries: {}, sources: {} };
const CONTAINER_RISK_INDEX = loadContainerRiskIndex();

function loadContainerRiskIndex() {
  if (!safeExistsSync(CONTAINER_RISK_INDEX_FILE)) {
    return DEFAULT_CONTAINER_RISK_INDEX;
  }
  try {
    return JSON.parse(readFileSync(CONTAINER_RISK_INDEX_FILE, "utf8"));
  } catch {
    return DEFAULT_CONTAINER_RISK_INDEX;
  }
}

function normalizeCandidate(candidate) {
  if (!candidate || typeof candidate !== "string") {
    return undefined;
  }
  const trimmed = basename(candidate.trim()).toLowerCase();
  if (!trimmed) {
    return undefined;
  }
  return trimmed;
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

function resolveContainerEntry(name, linkedName, gtfoMetadata) {
  const directCandidate = normalizeCandidate(name);
  if (directCandidate && CONTAINER_RISK_INDEX.entries?.[directCandidate]) {
    return {
      canonicalName: directCandidate,
      entry: CONTAINER_RISK_INDEX.entries[directCandidate],
      matchSource: "basename",
    };
  }
  const linkedCandidate = normalizeCandidate(linkedName);
  if (linkedCandidate && CONTAINER_RISK_INDEX.entries?.[linkedCandidate]) {
    return {
      canonicalName: linkedCandidate,
      entry: CONTAINER_RISK_INDEX.entries[linkedCandidate],
      matchSource: "symlink",
    };
  }
  const gtfoCandidate = normalizeCandidate(gtfoMetadata?.canonicalName);
  if (gtfoCandidate && CONTAINER_RISK_INDEX.entries?.[gtfoCandidate]) {
    return {
      canonicalName: gtfoCandidate,
      entry: CONTAINER_RISK_INDEX.entries[gtfoCandidate],
      matchSource: "gtfobins",
    };
  }
  return undefined;
}

function resolveKnowledgeSourceRefs(sourceKeys) {
  const refs = [];
  for (const sourceKey of sourceKeys || []) {
    const ref = CONTAINER_RISK_INDEX.sources?.[sourceKey];
    if (ref) {
      refs.push(ref);
    }
  }
  return uniqueSortedStrings(refs);
}

export function getContainerRiskMetadata(name, linkedName) {
  const gtfoMetadata = getGtfoBinsMetadata(name, linkedName);
  const resolvedEntry = resolveContainerEntry(name, linkedName, gtfoMetadata);
  if (!resolvedEntry) {
    return undefined;
  }
  const attackTactics = uniqueSortedStrings(
    resolvedEntry.entry.attackTactics || [],
  );
  const attackTechniques = uniqueSortedStrings([
    ...(resolvedEntry.entry.attackTechniques || []),
    ...(gtfoMetadata?.mitreTechniques || []),
  ]);
  const knowledgeSources = uniqueSortedStrings(
    resolvedEntry.entry.sourceKeys || [],
  );
  const knowledgeSourceRefs = resolveKnowledgeSourceRefs(knowledgeSources);
  const offenseTools = uniqueSortedStrings(
    resolvedEntry.entry.offenseTools || [],
  );
  const riskTags = uniqueSortedStrings([
    ...(resolvedEntry.entry.riskTags || []),
    ...(gtfoMetadata?.riskTags || []),
  ]);
  const seccompBlockedSyscalls = uniqueSortedStrings(
    resolvedEntry.entry.seccompBlockedSyscalls || [],
  );
  return {
    attackTactics,
    attackTechniques,
    canonicalName: resolvedEntry.canonicalName,
    knowledgeSourceRefs,
    knowledgeSources,
    matchSource: resolvedEntry.matchSource,
    offenseTools,
    riskTags,
    seccompBlockedSyscalls,
    seccompProfile: resolvedEntry.entry.seccompProfile || "",
  };
}

export function createContainerRiskProperties(name, linkedName) {
  const metadata = getContainerRiskMetadata(name, linkedName);
  if (!metadata) {
    return [];
  }
  const properties = [
    { name: "cdx:container:matched", value: "true" },
    { name: "cdx:container:name", value: metadata.canonicalName },
    { name: "cdx:container:matchSource", value: metadata.matchSource },
  ];
  if (metadata.attackTactics.length) {
    properties.push({
      name: "cdx:container:attackTactics",
      value: metadata.attackTactics.join(","),
    });
  }
  if (metadata.attackTechniques.length) {
    properties.push({
      name: "cdx:container:attackTechniques",
      value: metadata.attackTechniques.join(","),
    });
  }
  if (metadata.knowledgeSources.length) {
    properties.push({
      name: "cdx:container:knowledgeSources",
      value: metadata.knowledgeSources.join(","),
    });
  }
  if (metadata.knowledgeSourceRefs.length) {
    properties.push({
      name: "cdx:container:knowledgeSourceRefs",
      value: metadata.knowledgeSourceRefs.join(","),
    });
  }
  if (metadata.offenseTools.length) {
    properties.push({
      name: "cdx:container:offenseTools",
      value: metadata.offenseTools.join(","),
    });
  }
  if (metadata.riskTags.length) {
    properties.push({
      name: "cdx:container:riskTags",
      value: metadata.riskTags.join(","),
    });
  }
  if (metadata.seccompBlockedSyscalls.length) {
    properties.push({
      name: "cdx:container:seccompBlockedSyscalls",
      value: metadata.seccompBlockedSyscalls.join(","),
    });
  }
  if (metadata.seccompProfile) {
    properties.push({
      name: "cdx:container:seccompProfile",
      value: metadata.seccompProfile,
    });
  }
  return properties;
}
