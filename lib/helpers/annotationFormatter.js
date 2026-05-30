const MAX_DETAIL_LINES = 12;
const MAX_PROPERTY_ROWS = 40;
const MAX_CELL_LENGTH = 160;

function truncateText(value, maxLength = MAX_CELL_LENGTH) {
  const normalized = String(value ?? "").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function escapeMarkdownText(value) {
  return truncateText(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([\\`*_{}\[\]()#+!|])/g, "\\$1")
    .replace(/\r?\n/g, "<br>")
    .trim();
}

function escapeMarkdownCell(value) {
  return escapeMarkdownText(value);
}

/**
 * Format annotation properties as a markdown table for CycloneDX annotations.
 *
 * @param {{ name: string, value: string }[]} properties annotation properties
 * @returns {string} markdown table text
 */
export function propertiesToMarkdownTable(properties) {
  if (!properties?.length) {
    return "";
  }
  const lines = ["| Property | Value |", "| --- | --- |"];
  const normalizedProperties = [...properties]
    .filter((property) => property?.name || property?.value)
    .sort((left, right) =>
      `${left?.name || ""}\u0000${left?.value || ""}`.localeCompare(
        `${right?.name || ""}\u0000${right?.value || ""}`,
      ),
    )
    .slice(0, MAX_PROPERTY_ROWS);
  for (const property of normalizedProperties) {
    lines.push(
      `| ${escapeMarkdownCell(property?.name)} | ${escapeMarkdownCell(property?.value)} |`,
    );
  }
  if ((properties?.length || 0) > normalizedProperties.length) {
    lines.push(
      `| _truncated_ | ${properties.length - normalizedProperties.length} more properties omitted |`,
    );
  }
  return lines.join("\n");
}

/**
 * Build production-ready markdown annotation text.
 *
 * @param {string} message leading message text
 * @param {{ name: string, value: string }[]} properties annotation properties
 * @param {string[]} [details] optional detail lines shown before the table
 * @returns {string} annotation text
 */
export function buildAnnotationText(message, properties, details = []) {
  const lines = [
    message,
    ...details.filter(Boolean).slice(0, MAX_DETAIL_LINES),
  ].map(escapeMarkdownText);
  if (details.filter(Boolean).length > MAX_DETAIL_LINES) {
    lines.push(
      escapeMarkdownText(
        `${details.filter(Boolean).length - MAX_DETAIL_LINES} more details omitted`,
      ),
    );
  }
  const markdownTable = propertiesToMarkdownTable(properties);
  if (markdownTable) {
    lines.push("", markdownTable);
  }
  return lines.join("\n");
}
