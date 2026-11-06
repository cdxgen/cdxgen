/**
 * Render-side conversion of 1.x component evidence and cryptoProperties to
 * the CycloneDX 2.0 shapes (#/$defs/cyclonedx-component-2.0/$defs/componentEvidence,
 * #/$defs/cyclonedx-cryptography-2.0/$defs/cryptoProperties).
 */

import { thoughtLog } from "../core/logger.js";
import { collectToolBomRefs } from "./citations.js";
import {
  clone,
  copyDefined,
  countDrop,
  countUnmapped,
  isNonEmptyString,
  isObjectRecord,
  peekShadow,
} from "./cyclonedx20Common.js";
import {
  ALGORITHM_FAMILY_ENUM,
  ANALYSIS_TECHNIQUE_ENUM,
  CDXGEN_PARTY_REF_ID,
  FORBIDDEN_IDENTITY_TECHNIQUES,
  IDENTITY_SCHEME_ENUM,
  LICENSE_EVIDENCE_DETAIL_FIELDS,
  PROTOCOL_FAMILY_ENUM,
} from "./cyclonedx20Tables.js";

/**
 * Convert 1.x `evidence.identity[].field` into the 2.0 `scheme`
 * (#/$defs/cyclonedx-component-2.0/$defs/identityScheme). Predefined schemes
 * pass through; anything else uses the custom `{name}` branch when it
 * validates, and is counted for the report either way.
 */
function toIdentityScheme(field, stats) {
  if (typeof field !== "string" || field.length === 0) {
    return undefined;
  }
  if (IDENTITY_SCHEME_ENUM.has(field)) {
    return field;
  }
  stats.customSchemes.add(field);
  // identityScheme oneOf: predefined enum or a custom object with a name.
  return { name: field };
}

/**
 * Convert one identity-evidence method to the 2.0 identificationMethod shape.
 * analysisMethod requires `[technique, confidence]`; a method without its own
 * confidence inherits the identity entry's, and one with neither is dropped
 * (never given an invented number).
 */
function convertIdentityMethod(method, identityConfidence, attributed, stats) {
  if (!isObjectRecord(method)) {
    return undefined;
  }
  let technique = method.technique;
  if (technique === "other") {
    technique = "unknown";
  }
  let reason;
  if (!ANALYSIS_TECHNIQUE_ENUM.has(technique)) {
    reason = "technique not in the 2.0 analysisTechnique enum";
  } else if (FORBIDDEN_IDENTITY_TECHNIQUES.has(technique)) {
    reason = "technique forbidden for identificationMethod";
  }
  const confidence =
    typeof method.confidence === "number"
      ? method.confidence
      : typeof identityConfidence === "number"
        ? identityConfidence
        : undefined;
  if (!reason && confidence === undefined) {
    reason = "method has no confidence and the identity entry has none";
  }
  if (reason) {
    stats.droppedMethods.push({ reason, technique: method.technique });
    countDrop(stats, "evidence.identity.methods");
    return undefined;
  }
  const converted = { technique, confidence };
  if (typeof method.value === "string") {
    converted.value = method.value;
    if (attributed) {
      // A method of cdxgen's own analysis that names its matched value found
      // the subject (#/$defs/cyclonedx-evidence-2.0/$defs/analysisResult:
      // "detected"). For another tool's entry the result is not cdxgen's to
      // claim.
      converted.result = "detected";
    }
  }
  if (typeof method.description === "string") {
    converted.description = method.description;
  }
  return converted;
}

/**
 * The refId prefix of the party derived for a tool other than cdxgen. Any
 * refId that starts with it is a valid refIdType
 * (#/$defs/cyclonedx-common-2.0/$defs/refIdType: non-empty and not starting
 * with the BOM-Link intro `urn:cdx:`), whatever the tool's own refId is, so
 * the tool refId is appended unchanged and the party refId stays readable and
 * deterministic.
 */
export const TOOL_PARTY_REF_ID_PREFIX = "party-tool-";

/**
 * What the claims cdxgen writes at 2.0 are attributed with (#4591). cdxgen
 * claims only analysis it did:
 *
 * - `toolRefId` is the refId of the cdxgen tool component, present only when
 *   the BOM's `metadata.tools` lists cdxgen with a `bom-ref`.
 *   findCdxgenToolBomRef (lib/inventory/citations.js) returns the first tool
 *   bom-ref containing "cdxgen", which is a cdxgen-plugins-bin helper such as
 *   `trustinspector-cdxgen` whenever one is listed first, so the tool is
 *   matched by name among the same refs. Identity evidence carries cdxgen's
 *   assertion, its tool and method results only when this is set.
 * - `assertingTool` is set only without `toolRefId`: the first other tool
 *   component with a `bom-ref` (`{refId, toolRefId, label?}`), whose party
 *   asserts the component identifiers (`identifiers[].party` is required).
 *   With neither, cdxgen, as the converting tool, asserts the identifiers it
 *   wrote.
 * - `timestamp` is the BOM timestamp when it has one.
 *
 * Nothing is invented: absent members stay absent.
 *
 * @param {object} bom BOM in the 1.x shape (only `metadata` is read)
 * @returns {{toolRefId?: string, assertingTool?: {refId: string, toolRefId: string, label?: string}, timestamp?: string}} Claim context
 */
export function identityClaimContext(bom) {
  const toolRefs = new Set(collectToolBomRefs(bom));
  const tools = bom?.metadata?.tools;
  const candidates = Array.isArray(tools) ? tools : tools?.components || [];
  const declaredTools = candidates.filter(
    (tool) =>
      isObjectRecord(tool) &&
      isNonEmptyString(tool["bom-ref"]) &&
      toolRefs.has(tool["bom-ref"]),
  );
  const cdxgenTool = declaredTools.find((tool) => tool.name === "cdxgen");
  const claims = {};
  if (cdxgenTool) {
    claims.toolRefId = cdxgenTool["bom-ref"];
  } else {
    const otherTool = declaredTools.find((tool) => tool.name !== "cdxgen");
    if (otherTool) {
      claims.assertingTool = {
        refId: `${TOOL_PARTY_REF_ID_PREFIX}${otherTool["bom-ref"]}`,
        toolRefId: otherTool["bom-ref"],
      };
      if (isNonEmptyString(otherTool.name)) {
        claims.assertingTool.label = otherTool.name;
      }
    }
  }
  if (isNonEmptyString(bom?.metadata?.timestamp)) {
    claims.timestamp = bom.metadata.timestamp;
  }
  return claims;
}

/**
 * The refId of the party asserting the component identifiers: the cdxgen
 * party when cdxgen is the listed tool or no tool is listed, else the party
 * of the first other listed tool (see identityClaimContext).
 *
 * @param {object} claims Claim context from identityClaimContext
 * @returns {string} Party refId
 */
export function identifierPartyRefId(claims) {
  return claims?.assertingTool?.refId || CDXGEN_PARTY_REF_ID;
}

/**
 * The parties the renderer derives from the claim context, in the order it
 * appends them: the cdxgen party, then the asserting tool's party when there
 * is one. Each is a party (#/$defs/cyclonedx-party-2.0/$defs/party) with the
 * `asserter` role and a system identity
 * (#/$defs/cyclonedx-party-2.0/$defs/system, kind `automation`) whose `ref`
 * names the tool component only when that refId is declared. The renderer
 * declares one only when the document references it; the reader drops one
 * that matches exactly, since the render derives it again.
 *
 * @param {object} claims Claim context from identityClaimContext
 * @param {Set<string>} declared refIds declared in the document
 * @returns {object[]} Party declarations
 */
export function derivedPartyDeclarations(claims, declared) {
  const cdxgenSystem = { kind: "automation", label: "cdxgen" };
  if (claims?.toolRefId && declared.has(claims.toolRefId)) {
    cdxgenSystem.ref = claims.toolRefId;
  }
  const parties = [
    {
      refId: CDXGEN_PARTY_REF_ID,
      roles: [{ role: "asserter" }],
      system: cdxgenSystem,
    },
  ];
  const tool = claims?.assertingTool;
  if (tool) {
    const system = { kind: "automation" };
    if (tool.label) {
      system.label = tool.label;
    }
    if (declared.has(tool.toolRefId)) {
      system.ref = tool.toolRefId;
    }
    parties.push({ refId: tool.refId, roles: [{ role: "asserter" }], system });
  }
  return parties;
}

/**
 * Convert one 1.x identity entry to componentIdentityEvidence
 * (#/$defs/cyclonedx-component-2.0/$defs/componentIdentityEvidence). When
 * cdxgen is the listed tool (#4591), the entry is cdxgen's attributed claim:
 * `tools` names the helper recorded on the entry or, failing that, the cdxgen
 * tool; `assertion` credits the cdxgen party as asserter
 * (#/$defs/cyclonedx-evidence-2.0/$defs/assertion); and a method with a
 * matched value has the result `detected`. For another tool's BOM cdxgen did
 * not do that analysis, so none of these is added; the entry's own `tools`
 * are kept. `timestamp` is the BOM's own when it has one.
 *
 * @param {object} entry 1.x identity evidence entry
 * @param {object} stats Render counters from createRenderStats
 * @returns {object|undefined} The 2.0 entry, or undefined without a field
 */
export function convertIdentityEntry(entry, stats) {
  if (!isObjectRecord(entry)) {
    return undefined;
  }
  const scheme = toIdentityScheme(entry.field, stats);
  if (scheme === undefined) {
    countDrop(stats, "evidence.identity (no field)");
    return undefined;
  }
  const attributed = isNonEmptyString(stats.claims.toolRefId);
  const converted = { scheme };
  if (typeof entry.concludedValue === "string") {
    converted.concludedValue = entry.concludedValue;
  }
  if (typeof entry.confidence === "number") {
    converted.confidence = entry.confidence;
  }
  if (Array.isArray(entry.methods)) {
    const methods = entry.methods
      .map((method) =>
        convertIdentityMethod(method, entry.confidence, attributed, stats),
      )
      .filter(Boolean);
    if (methods.length) {
      converted.methods = methods;
    }
  }
  if (Array.isArray(entry.tools) && entry.tools.length) {
    converted.tools = clone(entry.tools);
  } else if (attributed) {
    converted.tools = [stats.claims.toolRefId];
  }
  if (attributed) {
    converted.assertion = {
      parties: [
        { party: { ref: CDXGEN_PARTY_REF_ID }, role: { role: "asserter" } },
      ],
    };
  }
  if (isNonEmptyString(stats.claims.timestamp)) {
    converted.timestamp = stats.claims.timestamp;
  }
  return converted;
}

/**
 * Convert 1.x `evidence.identity` (an array or a single 1.5 object). An
 * entry read from 2.0 whose 1.x projection is unchanged gets its 2.0
 * original back (a foreign assertion stays the foreign party's); an edited
 * one renders from the 1.x model.
 */
function convertIdentityEvidence(identity, stats) {
  const identities = [];
  for (const entry of Array.isArray(identity) ? identity : [identity]) {
    const converted =
      peekShadow(stats, "identity", entry) ??
      convertIdentityEntry(entry, stats);
    if (converted) {
      identities.push(converted);
    }
  }
  return identities;
}

/**
 * Convert occurrences
 * (#/$defs/cyclonedx-evidence-2.0/$defs/occurrence, required `[location]`):
 * the 1.x `bom-ref` becomes `refId`, every other 1.x field keeps its name.
 */
function convertOccurrences(occurrences, stats) {
  const converted = [];
  for (const occurrence of occurrences) {
    if (!isObjectRecord(occurrence) || !isNonEmptyString(occurrence.location)) {
      countDrop(stats, "evidence.occurrences (no location)");
      continue;
    }
    const entry = clone(occurrence);
    if (entry["bom-ref"] !== undefined) {
      if (isNonEmptyString(entry["bom-ref"])) {
        entry.refId = entry["bom-ref"];
      }
      delete entry["bom-ref"];
    }
    converted.push(entry);
  }
  return converted;
}

/**
 * Convert 1.x call stacks: the `callstack` object (or an array of them)
 * becomes the `callStacks` array, and frames need `module`
 * (#/$defs/cyclonedx-evidence-2.0/$defs/frame, required `[module]`).
 */
function convertCallStacks(callstack, stats) {
  const callStacks = [];
  for (const entry of Array.isArray(callstack) ? callstack : [callstack]) {
    if (!isObjectRecord(entry)) {
      continue;
    }
    const frames = [];
    for (const frame of entry.frames || []) {
      if (isObjectRecord(frame) && typeof frame.module === "string") {
        frames.push(clone(frame));
      } else {
        countDrop(stats, "evidence.callstack.frames (no module)");
      }
    }
    if (frames.length) {
      callStacks.push({ frames });
    }
  }
  return callStacks;
}

/** Carry the licenseEvidence details; a 1.x `bom-ref` becomes `refId`. */
function withLicenseEvidenceDetails(entry, choice, stats) {
  const converted = { ...entry };
  if (isNonEmptyString(choice["bom-ref"]) && choice.refId === undefined) {
    converted.refId = choice["bom-ref"];
  }
  copyDefined(converted, choice, LICENSE_EVIDENCE_DETAIL_FIELDS);
  countUnmapped(
    stats,
    "evidence.licenses",
    choice,
    new Set([
      "license",
      "expression",
      "bom-ref",
      ...LICENSE_EVIDENCE_DETAIL_FIELDS,
    ]),
  );
  return converted;
}

/**
 * Convert evidence licenses to licenseEvidence
 * (#/$defs/cyclonedx-component-2.0/$defs/licenseEvidence): a license may
 * carry only `id` or `name`, or the entry is an `expression`.
 */
function convertEvidenceLicenses(licenses, stats) {
  const converted = [];
  for (const choice of licenses) {
    if (isObjectRecord(choice?.license)) {
      const { id, name } = choice.license;
      const license = isNonEmptyString(id)
        ? { id }
        : isNonEmptyString(name)
          ? { name }
          : undefined;
      if (!license) {
        countDrop(stats, "evidence.licenses (no id or name)");
        continue;
      }
      for (const key of Object.keys(choice.license)) {
        if (!Object.hasOwn(license, key)) {
          countDrop(stats, `evidence.licenses.license.${key}`);
        }
      }
      converted.push(withLicenseEvidenceDetails({ license }, choice, stats));
    } else if (isNonEmptyString(choice?.expression)) {
      converted.push(
        withLicenseEvidenceDetails(
          { expression: choice.expression },
          choice,
          stats,
        ),
      );
    } else {
      countDrop(stats, "evidence.licenses (not a license or expression)");
    }
  }
  return converted;
}

/**
 * Convert component evidence
 * (#/$defs/cyclonedx-component-2.0/$defs/componentEvidence). The 1.x
 * `callstack` object becomes the `callStacks` array; identity `field` becomes
 * `scheme`. Every nested object is cloned, so nothing is shared with the
 * input.
 */
export function convertComponentEvidence(evidence, stats) {
  if (!isObjectRecord(evidence)) {
    return undefined;
  }
  const converted = {};
  if (evidence.identity !== undefined) {
    const identities = convertIdentityEvidence(evidence.identity, stats);
    if (identities.length) {
      converted.identity = identities;
    }
  }
  if (Array.isArray(evidence.occurrences)) {
    const occurrences = convertOccurrences(evidence.occurrences, stats);
    if (occurrences.length) {
      converted.occurrences = occurrences;
    }
  }
  if (evidence.callstack !== undefined) {
    const callStacks = convertCallStacks(evidence.callstack, stats);
    if (callStacks.length) {
      converted.callStacks = callStacks;
    }
  }
  if (Array.isArray(evidence.licenses) && evidence.licenses.length) {
    const licenses = convertEvidenceLicenses(evidence.licenses, stats);
    if (licenses.length) {
      converted.licenses = licenses;
    }
  }
  if (Array.isArray(evidence.copyright) && evidence.copyright.length) {
    // copyrightEvidence requires `text`; drop entries without it.
    const copyright = [];
    for (const entry of evidence.copyright) {
      if (isObjectRecord(entry) && typeof entry.text === "string") {
        copyright.push(clone(entry));
      } else {
        countDrop(stats, "evidence.copyright (no text)");
      }
    }
    if (copyright.length) {
      converted.copyright = copyright;
    }
  }
  countUnmapped(
    stats,
    "evidence",
    evidence,
    new Set(["identity", "occurrences", "callstack", "licenses", "copyright"]),
  );
  return Object.keys(converted).length ? converted : undefined;
}

/**
 * Convert cryptoProperties
 * (#/$defs/cyclonedx-cryptography-2.0/$defs/cryptoProperties, required
 * `[assetType]`): drop the deprecated free-text `curve` (2.0 keeps only
 * `ellipticCurve`), algorithm families and protocol types the pinned 2.0 enums
 * do not list, and move `algorithmRef` under `securedBy`.
 */
export function convertCryptoProperties(cryptoProperties, stats) {
  if (!isObjectRecord(cryptoProperties)) {
    return undefined;
  }
  const converted = clone(cryptoProperties);
  const algorithmProperties = converted.algorithmProperties;
  if (isObjectRecord(algorithmProperties)) {
    if (algorithmProperties.curve !== undefined) {
      countDrop(stats, "cryptoProperties.algorithmProperties.curve");
      delete algorithmProperties.curve;
    }
    if (
      algorithmProperties.algorithmFamily !== undefined &&
      !ALGORITHM_FAMILY_ENUM.has(algorithmProperties.algorithmFamily)
    ) {
      countDrop(stats, "cryptoProperties.algorithmProperties.algorithmFamily");
      thoughtLog(
        `CycloneDX 2.0 render dropped the algorithm family '${algorithmProperties.algorithmFamily}', which the pinned 2.0 cryptography defs do not list.`,
      );
      delete algorithmProperties.algorithmFamily;
    }
    // algorithmProperties.implementationPlatform and cryptoFunctions are
    // arrays at 2.0; tolerate a 1.x emitter that wrote a plain string.
    for (const listField of ["implementationPlatform", "cryptoFunctions"]) {
      if (typeof algorithmProperties[listField] === "string") {
        algorithmProperties[listField] = [algorithmProperties[listField]];
      }
    }
  }
  const protocolProperties = converted.protocolProperties;
  if (
    isObjectRecord(protocolProperties) &&
    protocolProperties.type !== undefined &&
    !PROTOCOL_FAMILY_ENUM.has(protocolProperties.type)
  ) {
    delete protocolProperties.type;
    countDrop(stats, "cryptoProperties.protocolProperties.type");
  }
  const related = converted.relatedCryptoMaterialProperties;
  // 1.7 securedBy.algorithmRef is one refType; 2.0 holds a list of refIds.
  if (
    isObjectRecord(related?.securedBy) &&
    typeof related.securedBy.algorithmRef === "string"
  ) {
    related.securedBy.algorithmRef = [related.securedBy.algorithmRef];
  }
  if (isObjectRecord(related) && related.algorithmRef !== undefined) {
    // 1.7 keeps `algorithmRef` directly on relatedCryptoMaterialProperties;
    // 2.0 moved it under securedBy.algorithmRef, an array of refIds.
    const algorithmRef = related.algorithmRef;
    delete related.algorithmRef;
    const securedBy = isObjectRecord(related.securedBy)
      ? related.securedBy
      : {};
    if (securedBy.algorithmRef === undefined) {
      securedBy.algorithmRef = [algorithmRef];
      related.securedBy = securedBy;
    }
  }
  return converted;
}
