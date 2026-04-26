import path from "node:path";

const SUPPORTED_EXPORT_FORMATS = new Set(["cyclonedx", "spdx"]);
const EXPORT_FORMAT_ALIASES = {
  cdx: "cyclonedx",
  cyclonedx: "cyclonedx",
  spdx: "spdx",
  "spdx-json": "spdx",
  spdx3: "spdx",
  "spdx3-json": "spdx",
};

/**
 * Normalize the requested export formats.
 *
 * @param {string|string[]|undefined|null} format Raw format value
 * @returns {string[]} Normalized export formats
 */
export function normalizeOutputFormats(format) {
  if (format === undefined || format === null || format === "") {
    return [];
  }
  const values = Array.isArray(format) ? format : [format];
  const normalized = new Set();
  for (const value of values) {
    if (!value) {
      continue;
    }
    for (const token of `${value}`.split(",")) {
      const normalizedToken = EXPORT_FORMAT_ALIASES[token.trim().toLowerCase()];
      if (normalizedToken && SUPPORTED_EXPORT_FORMATS.has(normalizedToken)) {
        normalized.add(normalizedToken);
      }
    }
  }
  return Array.from(normalized);
}

/**
 * Derive the SPDX output path from a base output path.
 *
 * @param {string} outputPath Output path
 * @returns {string} SPDX output path
 */
export function deriveSpdxOutputPath(outputPath) {
  if (!outputPath) {
    return "bom.spdx.json";
  }
  if (outputPath.endsWith(".spdx.json")) {
    return outputPath;
  }
  if (outputPath.endsWith(".cdx.json")) {
    return outputPath.replace(/\.cdx\.json$/u, ".spdx.json");
  }
  if (outputPath.endsWith(".json")) {
    return outputPath.replace(/\.json$/u, ".spdx.json");
  }
  return `${outputPath}.spdx.json`;
}

/**
 * Derive the CycloneDX output path from a base output path.
 *
 * @param {string} outputPath Output path
 * @returns {string} CycloneDX output path
 */
export function deriveCycloneDxOutputPath(outputPath) {
  if (!outputPath) {
    return "bom.json";
  }
  if (outputPath.endsWith(".spdx.json")) {
    return outputPath.replace(/\.spdx\.json$/u, ".cdx.json");
  }
  return outputPath;
}

/**
 * Determine the final output plan for the requested export formats.
 *
 * @param {object} options CLI options
 * @returns {{ formats: Set<string>, outputs: Record<string, string>, explicitFormat: boolean }} Output plan
 */
export function createOutputPlan(options) {
  const explicitFormat =
    options?.format !== undefined &&
    options?.format !== null &&
    options?.format !== "";
  const requestedFormats = normalizeOutputFormats(options?.format);
  const outputPath = options?.output || "bom.json";
  const formats = new Set(
    requestedFormats.length
      ? requestedFormats
      : [outputPath.endsWith(".spdx.json") ? "spdx" : "cyclonedx"],
  );
  const outputs = {};
  if (formats.has("cyclonedx")) {
    outputs.cyclonedx =
      outputPath.endsWith(".spdx.json") && formats.size > 1
        ? deriveCycloneDxOutputPath(outputPath)
        : outputPath;
  }
  if (formats.has("spdx")) {
    if (!formats.has("cyclonedx") || outputPath.endsWith(".spdx.json")) {
      outputs.spdx =
        outputPath === "bom.json"
          ? deriveSpdxOutputPath(outputPath)
          : outputPath;
    } else {
      outputs.spdx = deriveSpdxOutputPath(outputPath);
    }
  }
  return { formats, outputs, explicitFormat };
}

/**
 * Return the output directory for a planned export path.
 *
 * @param {string} outputPath Output path
 * @returns {string} Output directory
 */
export function getOutputDirectory(outputPath) {
  return path.dirname(outputPath);
}
