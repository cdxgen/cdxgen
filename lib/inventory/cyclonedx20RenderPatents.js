/**
 * Render-side conversion of 1.x patents, patent families and patent
 * assertions (#/$defs/cyclonedx-patent-2.0). The members are the same; the
 * 1.x `bom-ref` becomes `refId`, and organizations and contacts take the
 * 2.0 common shapes.
 */

import {
  clone,
  copyDefined,
  countDrop,
  countUnmapped,
  isNonEmptyString,
  isObjectRecord,
} from "./cyclonedx20Common.js";
import { toCommonContact, toCommonEntity } from "./cyclonedx20Parties.js";

const PATENT_FIELDS = [
  "patentNumber",
  "applicationNumber",
  "jurisdiction",
  "priorityApplication",
  "publicationNumber",
  "abstract",
  "filingDate",
  "grantDate",
  "patentExpirationDate",
  "patentLegalStatus",
  "externalReferences",
];
const PATENT_HANDLED = new Set([...PATENT_FIELDS, "bom-ref", "patentAssignee"]);

const PATENT_FAMILY_FIELDS = [
  "familyId",
  "priorityApplication",
  "members",
  "externalReferences",
];
const PATENT_FAMILY_HANDLED = new Set([...PATENT_FAMILY_FIELDS, "bom-ref"]);

const ASSERTION_FIELDS = ["assertionType", "patentRefs", "notes"];
const ASSERTION_HANDLED = new Set([...ASSERTION_FIELDS, "bom-ref", "asserter"]);

/** Start a converted object with the 1.x `bom-ref` as its `refId`. */
function withRefId(source) {
  return isNonEmptyString(source["bom-ref"])
    ? { refId: source["bom-ref"] }
    : {};
}

/**
 * A 1.x organizationalEntity or organizationalContact as its 2.0 common
 * shape, for the members whose schema is a oneOf of the two. Only a contact
 * has `email` or `phone`, only an organization `url`, `address` or
 * `contact`. With neither (a bare name) the value matches both branches of
 * the oneOf and so validates as neither; it is counted under `label` and
 * undefined is returned.
 */
function toCommonEntityOrContact(value, label, stats) {
  if (!isObjectRecord(value)) {
    countDrop(stats, `${label} (not an object)`);
    return undefined;
  }
  const isContact =
    (value.email !== undefined || value.phone !== undefined) &&
    value.url === undefined &&
    value.address === undefined &&
    value.contact === undefined;
  const converted = isContact
    ? toCommonContact(value, stats)
    : toCommonEntity(value, stats);
  if (
    !converted ||
    Object.keys(converted).every((key) => key === "refId" || key === "name")
  ) {
    countDrop(stats, `${label} (neither an organization nor a contact)`);
    return undefined;
  }
  return converted;
}

/**
 * Convert 1.x definitions.patents: patents and patent families.
 *
 * @param {object[]} patents 1.x patents and patent families
 * @param {object} stats Render counters
 * @returns {object[]|undefined} 2.0 patents
 */
export function convertPatents(patents, stats) {
  if (!Array.isArray(patents)) {
    if (patents !== undefined) {
      countDrop(stats, "definitions.patents (not a list)");
    }
    return undefined;
  }
  const converted = [];
  for (const patent of patents) {
    if (!isObjectRecord(patent)) {
      countDrop(stats, "definitions.patents (not an object)");
      continue;
    }
    const out = withRefId(patent);
    if (patent.familyId !== undefined) {
      copyDefined(out, patent, PATENT_FAMILY_FIELDS);
      countUnmapped(
        stats,
        "definitions.patents",
        patent,
        PATENT_FAMILY_HANDLED,
      );
    } else {
      copyDefined(out, patent, PATENT_FIELDS);
      if (Array.isArray(patent.patentAssignee)) {
        const assignees = patent.patentAssignee
          .map((assignee) =>
            toCommonEntityOrContact(
              assignee,
              "definitions.patents.patentAssignee",
              stats,
            ),
          )
          .filter(Boolean);
        if (assignees.length) {
          out.patentAssignee = assignees;
        }
      }
      countUnmapped(stats, "definitions.patents", patent, PATENT_HANDLED);
    }
    converted.push(out);
  }
  return converted.length ? converted : undefined;
}

/**
 * Convert 1.x patentAssertions
 * (#/$defs/cyclonedx-patent-2.0/$defs/patentAssertions): the asserter is an
 * organization, a contact or a refLinkType string.
 *
 * @param {object[]} assertions 1.x patent assertions
 * @param {object} stats Render counters
 * @returns {object[]|undefined} 2.0 patent assertions, or undefined when
 *   none is left
 */
export function convertPatentAssertions(assertions, stats) {
  if (!Array.isArray(assertions)) {
    return clone(assertions);
  }
  const converted = [];
  for (const assertion of assertions) {
    if (!isObjectRecord(assertion)) {
      countDrop(stats, "patentAssertions (not an object)");
      continue;
    }
    // `asserter` is required.
    const asserter =
      typeof assertion.asserter === "string"
        ? assertion.asserter
        : toCommonEntityOrContact(
            assertion.asserter,
            "patentAssertions.asserter",
            stats,
          );
    if (!asserter) {
      countDrop(stats, "patentAssertions (no asserter)");
      continue;
    }
    const out = withRefId(assertion);
    copyDefined(out, assertion, ASSERTION_FIELDS);
    out.asserter = asserter;
    countUnmapped(stats, "patentAssertions", assertion, ASSERTION_HANDLED);
    converted.push(out);
  }
  return converted.length ? converted : undefined;
}
