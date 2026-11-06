/**
 * The 2.0 sections the renderer derives from the 1.x-shaped internal model
 * rather than converts: post-quantum migration risks (pqcMigration.js,
 * #4592), and the coding-agent parties and behavioral blueprint
 * (agentBlueprint.js, #4593).
 *
 * A model read from 2.0 carries its 2.0-only sections (risks, blueprints,
 * parties) for 2.0 output. Derived entries in them are recognised by refId
 * (`risk-pqc-*`, `blueprint-declared-agents`, agent parties `party-agent-*`
 * of system kind `agent`). The renderer drops carried derived entries and
 * derives them again from the model, so they follow edits to the model and
 * are never declared twice. Every other carried entry is kept, first, and a
 * derived entry never replaces a carried entry with the same refId.
 *
 * Only cdxgen's own analysis is derived: the sections are derived only when
 * the model's `metadata.tools` lists cdxgen with a bom-ref, the rule
 * identityClaimContext applies to cdxgen's identity claims. Another tool's
 * BOM converted with `cdx-convert --to 2.0` gets no derived section.
 */

import { isDeepStrictEqual } from "node:util";

import {
  AGENT_BLUEPRINT_REF_ID,
  AGENT_PARTY_REF_ID_PREFIX,
  collectAgentBehaviour,
} from "./agentBlueprint.js";
import { clone, isObjectRecord } from "./cyclonedx20Common.js";
import { identityClaimContext } from "./cyclonedx20RenderEvidence.js";
import { collectPqcRisks, PQC_RISK_REF_ID_PREFIX } from "./pqcMigration.js";

const startsWith = (value, prefix) =>
  typeof value === "string" && value.startsWith(prefix);

/** A risk entry renderCycloneDx20 derives (see collectPqcRisks). */
export const isDerivedRisk = (risk) =>
  startsWith(risk?.refId, PQC_RISK_REF_ID_PREFIX);

/** The blueprint renderCycloneDx20 derives (see collectAgentBehaviour). */
export const isDerivedBlueprint = (blueprint) =>
  blueprint?.refId === AGENT_BLUEPRINT_REF_ID;

/** An agent party renderCycloneDx20 derives (see collectAgentBehaviour). */
export const isDerivedAgentParty = (party) =>
  startsWith(party?.refId, AGENT_PARTY_REF_ID_PREFIX) &&
  party?.system?.kind === "agent";

/**
 * Does the model's `metadata.tools` list cdxgen with a bom-ref? The same
 * test decides whether cdxgen's identity claims are written.
 *
 * @param {object} internalBom The 1.x-shaped internal model
 * @returns {boolean} True when cdxgen is a listed tool
 */
export function isCdxgenListedTool(internalBom) {
  return identityClaimContext(internalBom).toolRefId !== undefined;
}

/**
 * Derive the 2.0 sections of an internal model; all empty unless cdxgen is a
 * listed tool (isCdxgenListedTool).
 *
 * @param {object} internalBom The 1.x-shaped internal model
 * @returns {{risks: object[], agentParties: object[], blueprints: object[]}}
 */
export function deriveCycloneDx20Sections(internalBom) {
  if (!isCdxgenListedTool(internalBom)) {
    return { risks: [], agentParties: [], blueprints: [] };
  }
  const { parties, blueprint } = collectAgentBehaviour(internalBom);
  return {
    risks: collectPqcRisks(internalBom),
    agentParties: parties,
    blueprints: blueprint ? [blueprint] : [],
  };
}

/** Carried entries that are not derived, then derived ones with new refIds. */
function mergeByRefId(carried, derived, isDerived) {
  const kept = (Array.isArray(carried) ? carried : []).filter(
    (entry) => !isDerived(entry),
  );
  const refIds = new Set(kept.map((entry) => entry?.refId));
  return [...kept, ...derived.filter((entry) => !refIds.has(entry.refId))];
}

/**
 * Add the derived risks and blueprint to a rendered document whose carried
 * 2.0 sections are already in place, and return the parties to declare: the
 * carried parties without derived agent parties, then the derived ones.
 *
 * @param {object} out The document being rendered
 * @param {object[]} carriedParties Parties carried from a 2.0 read
 * @param {object} internalBom The internal model the document renders
 * @returns {object[]} The parties to declare before the cdxgen party
 */
export function appendDerivedSections(out, carriedParties, internalBom) {
  const derived = deriveCycloneDx20Sections(internalBom);
  // For another tool's document cdxgen derives nothing, and entries that look
  // derived are that tool's own, so they are kept.
  const listed = isCdxgenListedTool(internalBom);
  const derivedOnly = (isDerived) => (entry) => listed && isDerived(entry);
  const risks = mergeByRefId(
    (isObjectRecord(out.risks) ? out.risks : {}).risks,
    derived.risks,
    derivedOnly(isDerivedRisk),
  );
  const risksSection = isObjectRecord(out.risks) ? out.risks : {};
  const { risks: _risks, ...riskMembers } = risksSection;
  if (risks.length) {
    out.risks = { ...riskMembers, risks };
  } else if (Object.keys(riskMembers).length) {
    out.risks = riskMembers;
  } else {
    delete out.risks;
  }
  const blueprints = mergeByRefId(
    out.blueprints,
    derived.blueprints,
    derivedOnly(isDerivedBlueprint),
  );
  if (blueprints.length) {
    out.blueprints = blueprints;
  } else {
    delete out.blueprints;
  }
  return mergeByRefId(
    carriedParties,
    derived.agentParties,
    derivedOnly(isDerivedAgentParty),
  );
}

/**
 * Split the derived entries out of a list read from 2.0. An entry that is
 * what the renderer derives again from the read model is dropped without a
 * loss; a derived-looking entry that differs is dropped too (the renderer
 * would replace it), and its index is returned so the reader reports the
 * loss.
 *
 * @param {object[]} entries The 2.0 list (risks, blueprints, parties)
 * @param {object[]} derived What the renderer derives from the read model
 * @param {Function} isDerived Recogniser for derived entries
 * @returns {{kept: object[], differing: number[]}} The entries to carry, and
 *   the indexes of dropped entries that differ from the derivation
 */
export function splitDerivedEntries(entries, derived, isDerived) {
  const byRefId = new Map(derived.map((entry) => [entry.refId, entry]));
  const kept = [];
  const differing = [];
  (Array.isArray(entries) ? entries : []).forEach((entry, index) => {
    if (!isDerived(entry)) {
      kept.push(entry);
    } else if (!isDeepStrictEqual(byRefId.get(entry.refId), entry)) {
      differing.push(index);
    }
  });
  return { kept: clone(kept), differing };
}
