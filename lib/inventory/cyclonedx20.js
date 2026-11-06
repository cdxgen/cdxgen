/**
 * CycloneDX 2.0 rendering and reading.
 *
 * cdxgen assembles every BOM in the CycloneDX 1.x shape and converts to the
 * requested spec version at the end of the pipeline (see
 * lib/stages/postgen/specVersionCompat.js). The 2.0 draft is a structural
 * rewrite rather than an additive change, so the conversion lives here, as two
 * pure functions plus small helpers, instead of inside the compat walker:
 *
 * - `renderCycloneDx20(internalBom, context)` turns the 1.x-shaped internal
 *   model into a 2.0 document. It never mutates its input, and its output
 *   depends only on the model and the optional context (the cdx-hbom
 *   hardware mapper, see hbomLoader.js: hardwareRenderContext).
 *   `renderCycloneDx20WithReport(internalBom, context)` does the same and
 *   also returns the counts of everything the render could not carry.
 * - `readCycloneDx20(bom20)` turns a 2.0 document into the internal 1.x-shaped
 *   model, reporting everything it could not carry in `losses`.
 * - `loadBomForAnalysis(bomJson)` is the single entry point every BOM reader
 *   uses; it returns the document as is for 1.x and calls readCycloneDx20 for
 *   2.0, so no reader learns the 2.0 shape.
 * - `getInternalBom(bomNSData)` and `refreshRenderedBom(bomNSData, options)`
 *   are the generation-side half: postProcess keeps the 1.x model on
 *   `bomNSData.internalBomJson` at 2.0, and the writer re-renders once after
 *   the last mutation.
 *
 * Every field name below is quoted from the pinned draft schema
 * (data/cyclonedx-2.0-bundled.schema.json, CycloneDX/specification 2.0-dev at
 * ea8c3605829d1da13339a0790b6da73548e42a6b); citations give the `$defs` path.
 */

import { isCycloneDx20SpecVersion } from "./bomUtils.js";
import { isObjectRecord } from "./cyclonedx20Common.js";
import { readCycloneDx20 } from "./cyclonedx20Read.js";
import { renderCycloneDx20 } from "./cyclonedx20Render.js";

export { readCycloneDx20 } from "./cyclonedx20Read.js";
export {
  renderCycloneDx20,
  renderCycloneDx20WithReport,
} from "./cyclonedx20Render.js";
export {
  CDX20_INTERNAL_SECTIONS_KEY,
  CDXGEN_PARTY_REF_ID,
  DEPENDENCY_TRACK_CDX20_ERROR,
} from "./cyclonedx20Tables.js";

/**
 * Load any CycloneDX BOM for analysis: the document as is for 1.x, the
 * internal 1.x-shaped model for 2.0.
 *
 * @param {object} bomJson Parsed CycloneDX BOM
 * @returns {{internalBom: object, specVersion: string, losses: Array<{pointer: string, reason: string}>}}
 */
export function loadBomForAnalysis(bomJson) {
  const specVersion = isObjectRecord(bomJson)
    ? `${bomJson.specVersion ?? ""}`.trim() || "1.5"
    : "1.5";
  // At 2.0 the internal model also says specVersion "2.0" and specFormat, but
  // it keeps the 1.x root components, services and metadata.component, which
  // the 2.0 schema forbids in a rendered document. Such a model is already
  // what the readers need.
  const isInternalModel =
    isObjectRecord(bomJson) &&
    (Array.isArray(bomJson.components) ||
      Array.isArray(bomJson.services) ||
      isObjectRecord(bomJson.metadata?.component));
  if (isInternalModel) {
    return { internalBom: bomJson, specVersion, losses: [] };
  }
  if (isCycloneDx20SpecVersion(specVersion) || bomJson?.specFormat) {
    const { internalBom, losses } = readCycloneDx20(bomJson);
    return { internalBom, specVersion: "2.0", losses };
  }
  return { internalBom: bomJson, specVersion, losses: [] };
}

/**
 * The one-line notice a reader prints when loading a 2.0 document lost
 * data: the number of losses, with the details left to thoughtLog.
 *
 * @param {Array<{pointer: string, reason: string}>} losses Reader losses
 * @returns {string} The notice
 */
export function formatReadLossNotice(losses) {
  const count = losses?.length || 0;
  return `CycloneDX 2.0 input: reading it into the 1.x model reported ${count} loss${count === 1 ? "" : "es"}; those parts were not analysed. Set CDXGEN_THINK_MODE=true to list them.`;
}

/**
 * Return the 1.x-shaped model of a generation run. At 1.x the rendered BOM is
 * the internal model, so this always yields something readers can walk.
 *
 * @param {{bomJson?: object, internalBomJson?: object}} bomNSData
 * @returns {object} The 1.x-shaped BOM
 */
export function getInternalBom(bomNSData) {
  return bomNSData?.internalBomJson ?? bomNSData?.bomJson;
}

/**
 * Re-render the 2.0 document after a post-postProcess mutation of the
 * internal model, with the render context postProcess used
 * (`bomNSData.renderContext`). A no-op at 1.x, which keeps those versions
 * byte-identical.
 *
 * @param {{bomJson?: object, internalBomJson?: object, renderContext?: object}} bomNSData
 * @param {object} options CLI options carrying `specVersion`
 * @returns {{bomJson?: object, internalBomJson?: object}} The same bomNSData
 */
export function refreshRenderedBom(bomNSData, options) {
  if (
    !bomNSData?.internalBomJson ||
    !isCycloneDx20SpecVersion(
      options?.specVersion ?? bomNSData.bomJson?.specVersion,
    )
  ) {
    return bomNSData;
  }
  bomNSData.bomJson = renderCycloneDx20(
    bomNSData.internalBomJson,
    bomNSData.renderContext,
  );
  return bomNSData;
}
