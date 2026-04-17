/**
 * CycloneDX annotation reporter — embeds findings as `annotations[]` entries
 * on a copy of the input BOM. Can be reused by `bom-audit`.
 *
 * CycloneDX supports the annotation schema from spec version 1.5 onward.
 */

import { DEBUG_MODE, getTimestamp } from "../../helpers/utils.js";

const SUPPORTED_FROM = 1.5;
const CODE_BLOCK = "```";

/**
 * Render a set of findings into CycloneDX annotations.
 *
 * @param {Array<object>} findings Finding objects emitted by the validator or auditBom engine.
 * @param {object} bomJson Full CycloneDX BOM (needed for annotator/subject wiring).
 * @returns {Array<object>} CycloneDX annotation objects.
 */
export function buildAnnotations(findings, bomJson) {
  if (!findings?.length || !bomJson) {
    return [];
  }
  const specVersion = Number.parseFloat(bomJson.specVersion);
  if (Number.isNaN(specVersion) || specVersion < SUPPORTED_FROM) {
    return [];
  }
  const cdxgenAnnotator =
    bomJson?.metadata?.tools?.components?.filter((c) => c?.name === "cdxgen") ??
    [];
  if (!cdxgenAnnotator.length) {
    if (DEBUG_MODE) {
      console.warn(
        "Cannot create audit annotations: cdxgen tool component not found in metadata",
      );
    }
    return [];
  }
  const subjects = [bomJson.serialNumber];
  const timestamp = getTimestamp();
  return findings.map((f) => {
    const properties = [
      { name: "cdx:validate:engine", value: f.engine || "compliance" },
      { name: "cdx:validate:ruleId", value: f.ruleId },
      { name: "cdx:validate:status", value: f.status },
      { name: "cdx:validate:severity", value: f.severity },
    ];
    if (f.standard) {
      properties.push({ name: "cdx:validate:standard", value: f.standard });
    }
    if (f.standardRefs?.length) {
      properties.push({
        name: "cdx:validate:standardRefs",
        value: f.standardRefs.join(","),
      });
    }
    if (f.category) {
      properties.push({ name: "cdx:validate:category", value: f.category });
    }
    if (f.mitigation) {
      properties.push({ name: "cdx:validate:mitigation", value: f.mitigation });
    }
    if (f.scvsLevels?.length) {
      properties.push({
        name: "cdx:validate:scvsLevels",
        value: f.scvsLevels.join(","),
      });
    }
    if (f.evidence && typeof f.evidence === "object") {
      for (const [key, value] of Object.entries(f.evidence)) {
        properties.push({
          name: `cdx:validate:evidence:${key}`,
          value:
            typeof value === "object" ? JSON.stringify(value) : String(value),
        });
      }
    }
    return {
      subjects,
      annotator: {
        component: cdxgenAnnotator[0],
      },
      timestamp,
      text: `${f.message}\n${CODE_BLOCK}\n${JSON.stringify(properties)}\n${CODE_BLOCK}`,
    };
  });
}

/**
 * Produce a new BOM object with findings embedded as annotations. The caller
 * is responsible for writing the result to disk.
 *
 * @param {object} bomJson
 * @param {Array<object>} findings
 * @returns {object}
 */
export function renderBom(bomJson, findings) {
  if (!bomJson) {
    return bomJson;
  }
  const annotations = buildAnnotations(findings, bomJson);
  const next = { ...bomJson };
  next.annotations = [...(bomJson.annotations || []), ...annotations];
  return next;
}

/**
 * Convenience wrapper matching the signature of the other reporters. The
 * second argument expects `{ bomJson }` because annotations are BOM-shaped,
 * not report-shaped.
 *
 * @param {object} report Output of validateBomAdvanced().
 * @param {object} options
 * @param {object} options.bomJson The BOM to annotate.
 * @returns {string} JSON string of the annotated BOM.
 */
export function render(report, options = {}) {
  const { bomJson } = options;
  const annotated = renderBom(bomJson, report.findings || []);
  return JSON.stringify(annotated, null, null);
}
