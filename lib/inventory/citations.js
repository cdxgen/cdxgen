import { readFileSync } from "node:fs";
import { join } from "node:path";

import { dirNameStr } from "../core/paths.js";

// CycloneDX 1.7 introduced a root-level `citations` array. A citation records
// which entity or process supplied a given piece of BOM data, and points at the
// field(s) it vouches for via JSON Pointer(s) or JSONPath expression(s).
//
// Schema constraints (data/bom-1.7.schema.json#/definitions/citation):
//   - `timestamp` is required.
//   - Exactly one of `pointers` or `expressions` must be present (oneOf).
//   - At least one of `attributedTo` or `process` must be present (anyOf).
//   - `attributedTo` / `process` hold the `bom-ref` of an object already present
//     in the BOM (a component, service, tool, organisational entity or person,
//     or a formulation process).
//
// Because `attributedTo`/`process` reference other BOM entries by bom-ref, a
// citation is never self-contained: it must be emitted alongside the entity it
// names. The helpers below preserve that linkage and never invent refs.

const CDXGEN_VERSION_JSON = JSON.parse(
  readFileSync(join(dirNameStr, "package.json"), "utf-8"),
);

/**
 * Build a schema-valid CycloneDX 1.7 citation object.
 *
 * Either `pointers` or `expressions` must be supplied (mutually exclusive), and
 * either `attributedTo` or `process` must be supplied. The caller is expected to
 * pass the bom-ref of an entity that actually exists in the BOM; this helper
 * does not fabricate refs.
 *
 * @param {Object} input Citation fields
 * @param {string[]} [input.pointers] JSON Pointer strings (RFC 6901) targeting the attributed fields
 * @param {string[]} [input.expressions] JSONPath strings (RFC 9535) targeting the attributed fields
 * @param {string} [input.attributedTo] bom-ref of the component/service/tool/entity that supplied the data
 * @param {string} [input.process] bom-ref of a formulation process that produced the data
 * @param {string} [input.bomRef] Optional bom-ref for the citation itself
 * @param {string} [input.note] Free-form context or quality note
 * @param {string} [input.timestamp] ISO-8601 timestamp; defaults to now. Pass
 *   `citationTimestamp(bomJson)` so repeated renders of one BOM agree.
 * @returns {Object|null} A citation object, or null when the required oneOf/anyOf pairs are not satisfied
 */
export function createCitation({
  pointers,
  expressions,
  attributedTo,
  process,
  bomRef,
  note,
  timestamp,
} = {}) {
  const hasPointers = Array.isArray(pointers) && pointers.length > 0;
  const hasExpressions = Array.isArray(expressions) && expressions.length > 0;
  // oneOf: exactly one targeting mechanism.
  if (hasPointers === hasExpressions) {
    return null;
  }
  // anyOf: at least one attribution target.
  if (!attributedTo && !process) {
    return null;
  }
  // A citation left without a timestamp is completed by `attachCitations` from
  // the document's own metadata.timestamp, so two renders of one BOM agree.
  const citation = timestamp ? { timestamp } : {};
  if (hasPointers) {
    citation.pointers = [...pointers];
  } else {
    citation.expressions = [...expressions];
  }
  if (attributedTo) {
    citation.attributedTo = attributedTo;
  }
  if (process) {
    citation.process = process;
  }
  if (bomRef) {
    citation["bom-ref"] = bomRef;
  }
  if (note) {
    citation.note = note;
  }
  return citation;
}

/**
 * Compute a stable identity for a citation so duplicate attributions can be
 * merged without producing near-identical entries. Two citations are considered
 * equivalent when they attribute the same target (entity/process) to the same
 * field selector(s).
 *
 * @param {Object} citation A citation object
 * @returns {string} Identity key
 */
function citationIdentity(citation) {
  const target = citation.attributedTo || citation.process || "";
  const selectors = (citation.pointers || citation.expressions || []).join(
    "\n",
  );
  return `${target}\u0000${selectors}`;
}

/**
 * Merge two citation arrays, dropping exact duplicates. When two citations share
 * an identity but differ in note/bom-ref, the first one wins and the second is
 * discarded to keep the array small and stable.
 *
 * @param {Object[]} existing Citations already present on the BOM
 * @param {Object[]} additions Citations produced by a collector
 * @returns {Object[]} De-duplicated citation array
 */
export function mergeCitations(existing = [], additions = []) {
  const seen = new Set();
  const merged = [];
  for (const citation of [...(existing || []), ...(additions || [])]) {
    if (!citation || typeof citation !== "object") {
      continue;
    }
    const key = citation["bom-ref"] || citationIdentity(citation);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(citation);
  }
  return merged;
}

/**
 * Collect the bom-refs of all tool components recorded under metadata.tools.
 * Tool components are the natural attribution target for data that cdxgen
 * itself produced or resolved.
 *
 * @param {Object} bomJson CycloneDX BOM
 * @returns {string[]} bom-ref strings, in document order
 */
export function collectToolBomRefs(bomJson) {
  const refs = [];
  const tools = bomJson?.metadata?.tools;
  const pushComponent = (component) => {
    if (component?.["bom-ref"]) {
      refs.push(component["bom-ref"]);
    }
  };
  if (Array.isArray(tools)) {
    tools.forEach(pushComponent);
  } else if (tools && Array.isArray(tools.components)) {
    tools.components.forEach(pushComponent);
  }
  return refs;
}

// npm purl prefixes cdxgen's own tool entry has used as its bom-ref.
const CDXGEN_TOOL_REF_PREFIXES = [
  "pkg:npm/@cdxgen/cdxgen@",
  "pkg:npm/%40cdxgen/cdxgen@",
  "pkg:npm/@cyclonedx/cdxgen@",
  "pkg:npm/%40cyclonedx/cdxgen@",
];

/**
 * Resolve the bom-ref of the cdxgen tool component, if present. This is the
 * canonical attribution target for inventory that cdxgen collected itself.
 *
 * The tool component named "cdxgen" wins; a bare bom-ref (legacy array-style
 * tools) counts when it is cdxgen's own npm purl. A helper whose bom-ref only
 * mentions cdxgen, such as a cdxgen-plugins-bin tool like trustinspector, is
 * never the cdxgen tool.
 *
 * @param {Object} bomJson CycloneDX BOM
 * @returns {string|undefined} bom-ref of the cdxgen tool, or undefined
 */
export function findCdxgenToolBomRef(bomJson) {
  const tools = bomJson?.metadata?.tools;
  const components = Array.isArray(tools)
    ? tools
    : Array.isArray(tools?.components)
      ? tools.components
      : [];
  const named = components.find(
    (component) =>
      component?.name === "cdxgen" &&
      typeof component["bom-ref"] === "string" &&
      component["bom-ref"].length > 0,
  );
  if (named) {
    return named["bom-ref"];
  }
  return collectToolBomRefs(bomJson).find((ref) =>
    CDXGEN_TOOL_REF_PREFIXES.some((prefix) => ref.startsWith(prefix)),
  );
}

/**
 * The timestamp every citation on a document shares. Deriving it from the
 * document rather than the clock keeps two renders of one BOM identical, the
 * same rule the annotator follows.
 *
 * @param {Object} bomJson CycloneDX BOM
 * @returns {string} ISO-8601 timestamp
 */
export function citationTimestamp(bomJson) {
  return bomJson?.metadata?.timestamp || new Date().toISOString();
}

/**
 * Attach a citations array to the BOM root, but only when the spec version can
 * carry it. At 1.6 and below the field is not allowed and the downgrade path
 * strips it; this guard keeps callers from emitting data that would immediately
 * be removed.
 *
 * @param {Object} bomJson CycloneDX BOM (mutated)
 * @param {Object[]} citations Citations to attach
 * @param {Object} options CLI options (for specVersion)
 * @returns {Object} The mutated BOM
 */
export function attachCitations(bomJson, citations, options = {}) {
  if (!bomJson) {
    return bomJson;
  }
  const specVersion = options.specVersion || bomJson.specVersion;
  if (!specVersion || Number(specVersion) < 1.7) {
    return bomJson;
  }
  const documentTimestamp = citationTimestamp(bomJson);
  for (const citation of citations || []) {
    if (citation && !citation.timestamp) {
      citation.timestamp = documentTimestamp;
    }
  }
  const merged = mergeCitations(bomJson.citations, citations);
  if (merged.length) {
    bomJson.citations = merged;
  } else {
    delete bomJson.citations;
  }
  return bomJson;
}

/**
 * Build a citation that attributes the BOM's component inventory to the cdxgen
 * tool. This is the baseline provenance statement: cdxgen collected the
 * components, so the inventory is attributed to cdxgen's tool component.
 *
 * @param {Object} bomJson CycloneDX BOM (read for the tool bom-ref)
 * @param {Object} [context] Extra context
 * @param {string} [context.note] Optional note appended to the attribution
 * @returns {Object|null} A citation, or null when no cdxgen tool is referenced
 */
export function buildInventoryCitation(bomJson, context = {}) {
  const attributedTo = findCdxgenToolBomRef(bomJson);
  if (!attributedTo) {
    return null;
  }
  return createCitation({
    expressions: ["$.components"],
    attributedTo,
    note:
      context.note ||
      `Component inventory collected by cdxgen ${CDXGEN_VERSION_JSON.version}.`,
  });
}
