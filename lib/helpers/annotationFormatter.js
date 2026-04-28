function escapeMarkdownCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, "<br>")
    .trim();
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
  for (const property of properties) {
    lines.push(
      `| ${escapeMarkdownCell(property?.name)} | ${escapeMarkdownCell(property?.value)} |`,
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
  const lines = [message, ...details.filter(Boolean)];
  const markdownTable = propertiesToMarkdownTable(properties);
  if (markdownTable) {
    lines.push("", markdownTable);
  }
  return lines.join("\n");
}
