/**
 * Hardware components at 2.0 (cdxgen/cdxgen#4755). What each `cdx:hbom:*`
 * property means in the 2.0 draft is owned by @cdxgen/cdx-hbom, whose
 * optional `./cdx20` export provides `toCdx20HardwareComponent(component,
 * {partyRefId, includeSensitiveIdentifiers, identifierPolicy})`. The caller
 * loads it (lib/inventory/hbomLoader.js: hardwareRenderContext) and passes
 * it, with those options, to renderCycloneDx20 in the render context, so the
 * render stays a pure function of its arguments.
 *
 * The renderer converts the component as usual and then takes only these
 * members from the mapper's result, each checked against the pinned schema:
 *
 * - `identifiers`: only groups asserted by the party the renderer passed
 *   (the one its own identifiers use, which it declares when referenced).
 *   Their identities are appended to that party's group, or added as a new
 *   group, so a purl identity is never replaced. Only identities with a
 *   scheme from the identityScheme enum (or a custom `{name}`) and a
 *   non-empty value are taken.
 * - `classification` (#/$defs/cyclonedx-physical-2.0/$defs/classification):
 *   `category`, `subcategory`, and `codes` that are taxonomyCode objects
 *   (`{standard, value}`); a bare string code is dropped and counted.
 * - a manufacturer party, when the generic conversion produced none.
 *
 * Every `cdx:hbom:*` property stays: the hbom audit rules read them.
 */

import { thoughtLog } from "../core/logger.js";
import {
  clone,
  countDrop,
  isNonEmptyString,
  isObjectRecord,
  uniqueByValue,
} from "./cyclonedx20Common.js";
import { identifierPartyRefId } from "./cyclonedx20RenderEvidence.js";
import { IDENTITY_SCHEME_ENUM } from "./cyclonedx20Tables.js";

const TAXONOMY_CODE_FIELDS = Object.freeze(["description", "url"]);

/** True when the 1.x component carries at least one cdx:hbom:* property. */
export function isHardwareComponent(component) {
  return (
    Array.isArray(component?.properties) ? component.properties : []
  ).some(
    (property) =>
      typeof property?.name === "string" &&
      property.name.startsWith("cdx:hbom:"),
  );
}

function isValidIdentity(identity) {
  if (!isObjectRecord(identity) || !isNonEmptyString(identity.value)) {
    return false;
  }
  const { scheme } = identity;
  return (
    (typeof scheme === "string" && IDENTITY_SCHEME_ENUM.has(scheme)) ||
    (isObjectRecord(scheme) && isNonEmptyString(scheme.name))
  );
}

function appendIdentifiers(converted, groups, partyRefId, stats) {
  for (const group of Array.isArray(groups) ? groups : []) {
    if (!isObjectRecord(group) || group.party !== partyRefId) {
      // Any other party would have no declaration in this document.
      countDrop(stats, "hardware identifier (undeclared party)");
      continue;
    }
    const identities = (Array.isArray(group.identities) ? group.identities : [])
      .filter((identity) => {
        const valid = isValidIdentity(identity);
        if (!valid) {
          countDrop(stats, "hardware identity (not a 2.0 identity)");
        }
        return valid;
      })
      .map((identity) => ({
        scheme: clone(identity.scheme),
        value: identity.value,
      }));
    if (!identities.length) {
      continue;
    }
    converted.identifiers = Array.isArray(converted.identifiers)
      ? converted.identifiers
      : [];
    const existing = converted.identifiers.find(
      (entry) => entry.party === group.party,
    );
    if (existing) {
      existing.identities = uniqueByValue([
        ...existing.identities,
        ...identities,
      ]);
    } else {
      converted.identifiers.push({ party: group.party, identities });
    }
  }
}

function taxonomyCode(code, stats) {
  if (
    !isObjectRecord(code) ||
    !isNonEmptyString(code.standard) ||
    !isNonEmptyString(code.value)
  ) {
    countDrop(stats, "hardware classification code (not a taxonomyCode)");
    return undefined;
  }
  const converted = { standard: code.standard, value: code.value };
  for (const field of TAXONOMY_CODE_FIELDS) {
    if (typeof code[field] === "string") {
      converted[field] = code[field];
    }
  }
  return converted;
}

function setClassification(converted, classification, stats) {
  if (!isObjectRecord(classification) || converted.classification) {
    return;
  }
  const result = {};
  if (isNonEmptyString(classification.category)) {
    result.category = classification.category;
  }
  if (typeof classification.subcategory === "string") {
    result.subcategory = classification.subcategory;
  }
  const codes = uniqueByValue(
    (Array.isArray(classification.codes) ? classification.codes : [])
      .map((code) => taxonomyCode(code, stats))
      .filter(Boolean),
  );
  if (codes.length) {
    result.codes = codes;
  }
  if (Object.keys(result).length) {
    converted.classification = result;
  }
}

function addManufacturerParty(converted, parties) {
  const hasManufacturer = (converted.parties || []).some((party) =>
    (party?.roles || []).some((role) => role?.role === "manufacturer"),
  );
  if (hasManufacturer) {
    return;
  }
  const mapped = (Array.isArray(parties) ? parties : []).find(
    (party) =>
      (party?.roles || []).some((role) => role?.role === "manufacturer") &&
      isNonEmptyString(party?.organization?.name),
  );
  if (mapped) {
    converted.parties = [
      ...(converted.parties || []),
      {
        roles: [{ role: "manufacturer" }],
        organization: { name: mapped.organization.name },
      },
    ];
  }
}

/**
 * Add the hardware mapper's 2.0 members to a converted hardware component.
 * Without a mapper, or for a component without cdx:hbom:* properties, the
 * converted component is returned unchanged. The mapper gets a clone of the
 * 1.x component, the asserting party refId the generic identifiers use (so
 * its identifiers resolve to the party the renderer declares) and the
 * identifier options of the render context (`stats.hardwareOptions`).
 *
 * @param {object} component The 1.x component
 * @param {object} converted Its generic 2.0 conversion, extended in place
 * @param {object} stats Render counters with the optional `hardwareMapper`
 * @returns {object} The converted component
 */
export function applyHardwareMapping(component, converted, stats) {
  const mapper = stats.hardwareMapper;
  if (typeof mapper !== "function" || !isHardwareComponent(component)) {
    return converted;
  }
  const partyRefId = identifierPartyRefId(stats.claims);
  let mapped;
  try {
    mapped = mapper(clone(component), {
      ...stats.hardwareOptions,
      partyRefId,
    });
  } catch (error) {
    countDrop(stats, "hardware mapping (mapper failed)");
    thoughtLog(`CycloneDX 2.0 hardware mapping failed: ${error?.message}`);
    return converted;
  }
  if (!isObjectRecord(mapped)) {
    return converted;
  }
  appendIdentifiers(converted, mapped.identifiers, partyRefId, stats);
  setClassification(converted, mapped.classification, stats);
  addManufacturerParty(converted, mapped.parties);
  return converted;
}
