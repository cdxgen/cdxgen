/**
 * Reader converters for the CycloneDX 2.0 common objects
 * (#/$defs/cyclonedx-common-2.0, #/$defs/cyclonedx-license-2.0,
 * #/$defs/cyclonedx-release-notes-2.0) back to their 1.x shapes. Each frozen
 * spec is the allowlist of the members 1.x carries; anything else is a loss.
 */

import {
  clone,
  isNonEmptyString,
  isObjectRecord,
} from "./cyclonedx20Common.js";
import {
  addLoss,
  jsonPointer,
  listOf,
  objectOf,
  reverseList,
  reverseObject,
} from "./cyclonedx20ReadContext.js";
import { EXTERNAL_REFERENCE_TYPES_1X } from "./cyclonedx20Tables.js";

const HASH_SPEC = Object.freeze({ alg: true, content: true });

/** hash (#/$defs/cyclonedx-common-2.0/$defs/hash) → 1.x hash. */
export function reverseHash(ctx, value, pointer) {
  return reverseObject(ctx, "hash", value, pointer, HASH_SPEC);
}

/** A list of hashes. */
export const HASHES_RULE = listOf(reverseHash);

const PROPERTY_SPEC = Object.freeze({ name: true, value: true });

/** property (#/$defs/cyclonedx-common-2.0/$defs/property) → 1.x property. */
export function reverseProperty(ctx, value, pointer) {
  return reverseObject(ctx, "property", value, pointer, PROPERTY_SPEC);
}

/** A list of properties. */
export const PROPERTIES_RULE = listOf(reverseProperty);

/**
 * externalReference type: 2.0 adds types 1.7 does not list; those become
 * `other` and are reported.
 */
function reverseExternalReferenceType(ctx, value, pointer) {
  if (EXTERNAL_REFERENCE_TYPES_1X.has(value)) {
    return value;
  }
  addLoss(
    ctx,
    pointer,
    `externalReference.type '${value}' is not a 1.x type; written as 'other'`,
  );
  return "other";
}

const EXTERNAL_REFERENCE_SPEC = Object.freeze({
  url: true,
  comment: true,
  type: Object.freeze({ convert: reverseExternalReferenceType }),
  hashes: HASHES_RULE,
  properties: PROPERTIES_RULE,
});

/** externalReference → 1.x externalReference. */
export function reverseExternalReference(ctx, value, pointer) {
  return reverseObject(
    ctx,
    "externalReference",
    value,
    pointer,
    EXTERNAL_REFERENCE_SPEC,
  );
}

/** A list of external references. */
export const EXTERNAL_REFERENCES_RULE = listOf(reverseExternalReference);

const ATTACHMENT_SPEC = Object.freeze({
  mediaType: "contentType",
  encoding: true,
  content: true,
});

/** attachment: `mediaType` is the 1.x `contentType`. */
export function reverseAttachment(ctx, value, pointer) {
  return reverseObject(ctx, "attachment", value, pointer, ATTACHMENT_SPEC);
}

/** An attachment-valued member. */
export const ATTACHMENT_RULE = Object.freeze({ convert: reverseAttachment });

const ADDRESS_SPEC = Object.freeze({
  refId: "bom-ref",
  country: true,
  region: true,
  locality: true,
  postOfficeBoxNumber: true,
  postalCode: true,
  streetAddress: true,
});

/** postalAddress (common or party) → 1.x postalAddress. */
export function reverseAddress(ctx, value, pointer) {
  return reverseObject(ctx, "postalAddress", value, pointer, ADDRESS_SPEC);
}

const CONTACT_SPEC = Object.freeze({
  refId: "bom-ref",
  name: true,
  email: true,
  phone: true,
});

/** organizationalContact → 1.x organizationalContact. */
export function reverseContact(ctx, value, pointer) {
  return reverseObject(
    ctx,
    "organizationalContact",
    value,
    pointer,
    CONTACT_SPEC,
  );
}

const ENTITY_SPEC = Object.freeze({
  refId: "bom-ref",
  name: true,
  url: true,
  address: Object.freeze({ convert: reverseAddress }),
  contact: listOf(reverseContact),
});

/** organizationalEntity (common) → 1.x organizationalEntity. */
export function reverseEntity(ctx, value, pointer) {
  return reverseObject(
    ctx,
    "organizationalEntity",
    value,
    pointer,
    ENTITY_SPEC,
  );
}

const LICENSING_PARTY_SPEC = Object.freeze({
  organization: Object.freeze({ convert: reverseEntity }),
  individual: Object.freeze({ convert: reverseContact }),
});

const LICENSING_SPEC = Object.freeze({
  altIds: true,
  licensor: objectOf("licensing.licensor", LICENSING_PARTY_SPEC),
  licensee: objectOf("licensing.licensee", LICENSING_PARTY_SPEC),
  purchaser: objectOf("licensing.purchaser", LICENSING_PARTY_SPEC),
  purchaseOrder: true,
  licenseTypes: true,
  lastRenewal: true,
  expiration: true,
});

const LICENSE_SPEC = Object.freeze({
  refId: "bom-ref",
  id: true,
  name: true,
  acknowledgement: true,
  text: ATTACHMENT_RULE,
  url: true,
  licensing: objectOf("licensing", LICENSING_SPEC),
  properties: PROPERTIES_RULE,
});

const EXPRESSION_DETAIL_SPEC = Object.freeze({
  licenseIdentifier: true,
  refId: "bom-ref",
  text: ATTACHMENT_RULE,
  url: true,
});

const EXPRESSION_SPEC = Object.freeze({
  expression: true,
  expressionDetails: listOf((ctx, value, pointer) =>
    reverseObject(
      ctx,
      "expressionDetail",
      value,
      pointer,
      EXPRESSION_DETAIL_SPEC,
    ),
  ),
  acknowledgement: true,
  refId: "bom-ref",
  licensing: objectOf("licensing", LICENSING_SPEC),
  properties: PROPERTIES_RULE,
});

const LICENSE_CHOICE_SPEC = Object.freeze({
  license: objectOf("license", LICENSE_SPEC),
});

/**
 * One licenseChoice entry. A licenseReference (`{ref}`) resolves against
 * definitions.licenses; 1.x has no license references, so the declaration
 * is inlined and the reference itself reported.
 */
export function reverseLicenseChoice(ctx, value, pointer) {
  if (!isObjectRecord(value)) {
    addLoss(ctx, pointer, "license entry is not an object");
    return undefined;
  }
  if (typeof value.ref === "string") {
    const declared = ctx.licenseIndex.get(value.ref)?.entry;
    addLoss(
      ctx,
      jsonPointer(pointer, "ref"),
      declared
        ? "license reference has no 1.x form; the declaration is inlined"
        : `license reference '${value.ref}' could not be resolved`,
    );
    if (!declared) {
      return undefined;
    }
    // The inlined copy drops the declaration's refId: it may be inlined in
    // several places, and a 1.x bom-ref must be unique.
    const declaration = clone(declared);
    delete declaration.refId;
    if (isObjectRecord(declaration.license)) {
      delete declaration.license.refId;
    }
    return reverseLicenseChoice(
      ctx,
      declaration,
      ctx.licenseIndex.get(value.ref).pointer,
    );
  }
  if (value.license !== undefined) {
    return reverseObject(ctx, "license", value, pointer, LICENSE_CHOICE_SPEC);
  }
  return reverseObject(
    ctx,
    "licenseExpression",
    value,
    pointer,
    EXPRESSION_SPEC,
  );
}

/** A licenses member. */
export const LICENSES_RULE = listOf(reverseLicenseChoice);

/**
 * Issues a patch or release resolves. 1.x lists issues only; a reference to a
 * weakness, vulnerability or requirement has no 1.x form.
 */
export const RESOLVES_RULE = listOf((ctx, value, pointer) => {
  if (isObjectRecord(value) && typeof value.ref === "string") {
    addLoss(ctx, pointer, "a resolved reference has no 1.x form");
    return undefined;
  }
  return clone(value);
});

const NOTE_SPEC = Object.freeze({ locale: true, text: ATTACHMENT_RULE });

const RELEASE_NOTES_SPEC = Object.freeze({
  type: true,
  title: true,
  featuredImage: true,
  socialImage: true,
  description: true,
  timestamp: true,
  aliases: true,
  tags: true,
  resolves: RESOLVES_RULE,
  notes: listOf((ctx, value, pointer) =>
    reverseObject(ctx, "note", value, pointer, NOTE_SPEC),
  ),
  properties: PROPERTIES_RULE,
});

/**
 * releaseNotes, inline or a releaseNotesReference resolved against
 * definitions.releaseNotes (1.x has no reference form).
 */
export function reverseReleaseNotes(ctx, value, pointer) {
  if (isObjectRecord(value) && typeof value.ref === "string") {
    const notes = Array.isArray(ctx.doc.definitions?.releaseNotes)
      ? ctx.doc.definitions.releaseNotes
      : [];
    const index = notes.findIndex(
      (entry) => isObjectRecord(entry) && entry.refId === value.ref,
    );
    const declared = index >= 0 ? notes[index] : undefined;
    addLoss(
      ctx,
      jsonPointer(pointer, "ref"),
      declared
        ? "release notes reference has no 1.x form; the notes are inlined"
        : `release notes reference '${value.ref}' could not be resolved`,
    );
    return declared
      ? reverseObject(
          ctx,
          "releaseNotes",
          declared,
          jsonPointer("/definitions/releaseNotes", index),
          RELEASE_NOTES_SPEC,
        )
      : undefined;
  }
  return reverseObject(ctx, "releaseNotes", value, pointer, RELEASE_NOTES_SPEC);
}

/**
 * patentAssertions: the 2.0 asserter is a party reference string or party
 * object; 1.x takes a refLink string, an organizationalEntity or a contact.
 */
function reversePatentAsserter(ctx, value, pointer) {
  if (isNonEmptyString(value)) {
    return value;
  }
  if (isObjectRecord(value)) {
    // organizationalEntity and organizationalContact are both allowed; the
    // members say which one this is.
    const isContact =
      value.email !== undefined ||
      (value.phone !== undefined &&
        value.contact === undefined &&
        value.url === undefined &&
        value.address === undefined);
    return isContact
      ? reverseContact(ctx, value, pointer)
      : reverseEntity(ctx, value, pointer);
  }
  addLoss(ctx, pointer, "patentAssertion.asserter has no 1.x form");
  return undefined;
}

const PATENT_ASSERTION_SPEC = Object.freeze({
  refId: "bom-ref",
  assertionType: true,
  patentRefs: Object.freeze({
    convert: (ctx, value, pointer) =>
      reverseList(ctx, value, pointer, (_ctx, ref, refPointer) => {
        if (isNonEmptyString(ref)) {
          return ref;
        }
        if (isNonEmptyString(ref?.ref)) {
          return ref.ref;
        }
        addLoss(ctx, refPointer, "patent reference has no 1.x form");
        return undefined;
      }),
  }),
  asserter: Object.freeze({ convert: reversePatentAsserter }),
  notes: true,
});

/** A patentAssertions member; 1.x requires `asserter` and `assertionType`. */
export const PATENT_ASSERTIONS_RULE = listOf((ctx, value, pointer) => {
  const assertion = reverseObject(
    ctx,
    "patentAssertion",
    value,
    pointer,
    PATENT_ASSERTION_SPEC,
  );
  if (assertion && assertion.asserter === undefined) {
    addLoss(ctx, pointer, "a 1.x patent assertion needs an asserter; dropped");
    return undefined;
  }
  return assertion;
});
