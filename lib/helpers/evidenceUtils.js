export function createOccurrenceEvidence(location, details = {}) {
  const normalizedLocation = String(location || "").trim();
  if (!normalizedLocation) {
    return undefined;
  }
  const occurrence = {
    location: normalizedLocation,
  };
  for (const [key, value] of Object.entries(details || {})) {
    if (value !== undefined && value !== null && value !== "") {
      occurrence[key] = value;
    }
  }
  return occurrence;
}

export function parseOccurrenceEvidenceLocation(location, details = {}) {
  const normalizedLocation = String(location || "").trim();
  if (!normalizedLocation) {
    return undefined;
  }
  const hashMatch = normalizedLocation.match(/^(.*)#(\d+)$/);
  if (hashMatch) {
    return createOccurrenceEvidence(hashMatch[1], {
      ...details,
      line: Number(hashMatch[2]),
    });
  }
  const lineOffsetMatch = normalizedLocation.match(/^(.*):(\d+):(\d+)$/);
  if (lineOffsetMatch) {
    return createOccurrenceEvidence(lineOffsetMatch[1], {
      ...details,
      line: Number(lineOffsetMatch[2]),
      offset: Number(lineOffsetMatch[3]),
    });
  }
  const lineMatch = normalizedLocation.match(/^(.*):(\d+)$/);
  if (lineMatch) {
    return createOccurrenceEvidence(lineMatch[1], {
      ...details,
      line: Number(lineMatch[2]),
    });
  }
  return createOccurrenceEvidence(normalizedLocation, details);
}

export function formatOccurrenceEvidence(occurrence) {
  if (!occurrence?.location) {
    return "";
  }
  if (typeof occurrence.line === "number") {
    if (typeof occurrence.offset === "number") {
      return `${occurrence.location}:${occurrence.line}:${occurrence.offset}`;
    }
    return `${occurrence.location}#${occurrence.line}`;
  }
  return occurrence.location;
}
