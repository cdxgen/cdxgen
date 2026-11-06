/**
 * Conversions between the 1.x organizational entities and contacts and the
 * CycloneDX 2.0 parties (#/$defs/cyclonedx-party-2.0) and common entities
 * (#/$defs/cyclonedx-common-2.0).
 */

import {
  authorStringToNames,
  clone,
  countDrop,
  countUnmapped,
  identifierValues,
  isNonEmptyString,
  isObjectRecord,
} from "./cyclonedx20Common.js";
import { reverseAddress } from "./cyclonedx20ReadCommon.js";
import {
  addLoss,
  jsonPointer,
  reportUnmapped,
  reverseList,
  reverseObject,
} from "./cyclonedx20ReadContext.js";
import {
  PARTY_ROLE_FIELDS_1X,
  POSTAL_ADDRESS_FIELDS,
} from "./cyclonedx20Tables.js";

/**
 * Convert a 1.x postalAddress. Party addresses
 * (#/$defs/cyclonedx-party-2.0/$defs/postalAddress) and common addresses
 * (#/$defs/cyclonedx-common-2.0/$defs/postalAddress) both rename `bom-ref`
 * to `refId`.
 */
function convertPostalAddress(address, stats) {
  if (!isObjectRecord(address)) {
    return undefined;
  }
  const converted = {};
  const refId = address.refId ?? address["bom-ref"];
  if (isNonEmptyString(refId)) {
    converted.refId = refId;
  }
  for (const field of POSTAL_ADDRESS_FIELDS) {
    if (typeof address[field] === "string") {
      converted[field] = address[field];
    }
  }
  countUnmapped(
    stats,
    "address",
    address,
    new Set([...POSTAL_ADDRESS_FIELDS, "bom-ref", "refId"]),
  );
  return Object.keys(converted).length ? converted : undefined;
}

/**
 * Convert a 1.x organizationalContact to a 2.0 party `person`
 * (#/$defs/cyclonedx-party-2.0/$defs/person: `email` and `phone` are arrays of
 * `{address}` / `{number}` objects, and there is no `bom-ref`).
 */
function contactToPerson(contact, stats) {
  if (isNonEmptyString(contact)) {
    return { name: contact };
  }
  if (!isObjectRecord(contact)) {
    return undefined;
  }
  const person = {};
  if (isNonEmptyString(contact.name)) {
    person.name = contact.name;
  }
  if (isNonEmptyString(contact.email)) {
    person.email = [{ address: contact.email }];
  }
  if (isNonEmptyString(contact.phone)) {
    person.phone = [{ number: contact.phone }];
  }
  countUnmapped(
    stats,
    "party.person",
    contact,
    new Set(["name", "email", "phone", "bom-ref"]),
  );
  return Object.keys(person).length ? person : undefined;
}

/**
 * A person party playing `role` for a 1.x contact. The contact's `bom-ref`
 * is the party's refId (#/$defs/cyclonedx-party-2.0/$defs/party).
 *
 * @param {object|string} contact 1.x organizationalContact
 * @param {string} role Predefined role
 * @param {object} stats Render counters
 * @returns {object|undefined} 2.0 party
 */
export function contactToParty(contact, role, stats) {
  const person = contactToPerson(contact, stats);
  if (!person) {
    return undefined;
  }
  const party = {};
  if (isNonEmptyString(contact?.["bom-ref"])) {
    party.refId = contact["bom-ref"];
  }
  party.roles = [{ role }];
  party.person = person;
  return party;
}

/**
 * Convert a 1.x organizationalEntity into 2.0 parties playing `role`
 * (#/$defs/cyclonedx-party-2.0/$defs/party, required `[roles]`, exactly one
 * identity sub-shape). The organization
 * (#/$defs/cyclonedx-party-2.0/$defs/organization) takes `url` as
 * `[{url}]` and `addresses` as an array and has no `bom-ref` or `contact`, so
 * every 1.x contact becomes its own person party with the same role.
 */
export function entityToParties(entity, role, stats) {
  if (!isObjectRecord(entity)) {
    return [];
  }
  const organization = {};
  if (isNonEmptyString(entity.name)) {
    organization.name = entity.name;
  }
  // A 2.0-shaped organization read back from a 2.0 document already has
  // `{url}` objects and `addresses`; both shapes are accepted.
  const urls = identifierValues(entity.url)
    .map((url) =>
      isNonEmptyString(url)
        ? { url }
        : isNonEmptyString(url?.url)
          ? clone(url)
          : undefined,
    )
    .filter(Boolean);
  if (urls.length) {
    organization.url = urls;
  }
  const addresses = [
    entity.address,
    ...(Array.isArray(entity.addresses) ? entity.addresses : []),
  ]
    .map((address) => convertPostalAddress(address, stats))
    .filter(Boolean);
  if (addresses.length) {
    organization.addresses = addresses;
  }
  countUnmapped(
    stats,
    "party.organization",
    entity,
    new Set(["name", "url", "address", "addresses", "contact", "bom-ref"]),
  );
  const parties = [];
  if (Object.keys(organization).length) {
    // The entity's bom-ref identifies the organization party.
    parties.push(
      isNonEmptyString(entity["bom-ref"])
        ? { refId: entity["bom-ref"], roles: [{ role }], organization }
        : { roles: [{ role }], organization },
    );
  } else if (entity["bom-ref"] !== undefined) {
    countDrop(stats, "party.organization.bom-ref");
  }
  for (const contact of Array.isArray(entity.contact) ? entity.contact : []) {
    const party = contactToParty(contact, role, stats);
    if (party) {
      parties.push(party);
    } else {
      countDrop(stats, "party.contact (empty)");
    }
  }
  if (!parties.length) {
    countDrop(stats, "party.organization (empty)");
  }
  return parties;
}

/**
 * Convert a 1.x organizationalContact to the 2.0 common organizationalContact
 * (#/$defs/cyclonedx-common-2.0/$defs/organizationalContact), which renames
 * `bom-ref` to `refId`. Used by metadata authors and annotators.
 */
export function toCommonContact(contact, stats) {
  if (isNonEmptyString(contact)) {
    return { name: contact };
  }
  if (!isObjectRecord(contact)) {
    return undefined;
  }
  const converted = {};
  const refId = contact.refId ?? contact["bom-ref"];
  if (isNonEmptyString(refId)) {
    converted.refId = refId;
  }
  for (const field of ["name", "email", "phone"]) {
    if (isNonEmptyString(contact[field])) {
      converted[field] = contact[field];
    }
  }
  countUnmapped(
    stats,
    "contact",
    contact,
    new Set(["name", "email", "phone", "bom-ref", "refId"]),
  );
  return Object.keys(converted).length ? converted : undefined;
}

/**
 * Convert a 1.x organizationalEntity to the 2.0 common organizationalEntity
 * (#/$defs/cyclonedx-common-2.0/$defs/organizationalEntity), used by
 * metadata.supplier, metadata.manufacturer and annotator.organization. It
 * keeps `url` strings and `contact`, and renames `bom-ref` to `refId`.
 */
export function toCommonEntity(entity, stats) {
  if (!isObjectRecord(entity)) {
    return undefined;
  }
  const converted = {};
  const refId = entity.refId ?? entity["bom-ref"];
  if (isNonEmptyString(refId)) {
    converted.refId = refId;
  }
  if (typeof entity.name === "string") {
    converted.name = entity.name;
  }
  const address = convertPostalAddress(entity.address, stats);
  if (address) {
    converted.address = address;
  }
  const urls = identifierValues(entity.url).filter(isNonEmptyString);
  if (urls.length) {
    converted.url = urls;
  }
  const contacts = (Array.isArray(entity.contact) ? entity.contact : [])
    .map((contact) => toCommonContact(contact, stats))
    .filter(Boolean);
  if (contacts.length) {
    converted.contact = contacts;
  }
  countUnmapped(
    stats,
    "organization",
    entity,
    new Set(["name", "url", "address", "contact", "bom-ref", "refId"]),
  );
  return converted;
}

/**
 * Convert the 1.x party-ish component fields into `parties`
 * (#/$defs/cyclonedx-party-2.0/$defs/party). `author` strings and `authors`
 * contacts become persons with the `author` role, `publisher` an organization
 * with the `publisher` role, and supplier/manufacturer organizations keep
 * their roles.
 */
export function collectParties(component, stats) {
  const parties = [];
  for (const name of authorStringToNames(component.author)) {
    parties.push({ roles: [{ role: "author" }], person: { name } });
  }
  for (const contact of Array.isArray(component.authors)
    ? component.authors
    : []) {
    const party = contactToParty(contact, "author", stats);
    if (party) {
      parties.push(party);
    } else {
      countDrop(stats, "component.authors (empty)");
    }
  }
  if (isNonEmptyString(component.publisher)) {
    parties.push({
      roles: [{ role: "publisher" }],
      organization: { name: component.publisher },
    });
  }
  parties.push(...entityToParties(component.supplier, "supplier", stats));
  parties.push(
    ...entityToParties(component.manufacturer, "manufacturer", stats),
  );
  return parties;
}

// ---------------------------------------------------------------------------
// Reverse: 2.0 parties back to the 1.x supplier, manufacturer, authors,
// publisher and provider fields.
// ---------------------------------------------------------------------------

/** organization url entries `{name?, url}` back to 1.x url strings. */
function reverseOrganizationUrls(ctx, value, pointer) {
  return reverseList(ctx, value, pointer, (_ctx, entry, entryPointer) => {
    if (isNonEmptyString(entry)) {
      return entry;
    }
    if (!isObjectRecord(entry) || !isNonEmptyString(entry.url)) {
      addLoss(ctx, entryPointer, "organization url has no url");
      return undefined;
    }
    reportUnmapped(ctx, "organization.url", entry, entryPointer, URL_KEYS);
    return entry.url;
  });
}
const URL_KEYS = Object.freeze(new Set(["url"]));

/** The first entry of a 2.0 list as one 1.x value; the rest are losses. */
function firstOfList(kind, convertEntry) {
  return (ctx, value, pointer) => {
    const converted = reverseList(ctx, value, pointer, convertEntry);
    if (converted && converted.length > 1) {
      for (let index = 1; index < converted.length; index++) {
        addLoss(
          ctx,
          jsonPointer(pointer, index),
          `${kind}: 1.x holds one value; only the first is kept`,
        );
      }
    }
    return converted?.[0];
  };
}

const ORGANIZATION_SPEC = Object.freeze({
  name: true,
  url: Object.freeze({ convert: reverseOrganizationUrls }),
  addresses: Object.freeze({
    to: "address",
    convert: firstOfList("organization.addresses", reverseAddress),
  }),
});

const EMAIL_KEYS = Object.freeze(new Set(["address"]));
const PHONE_KEYS = Object.freeze(new Set(["number"]));

/** A person's `[{name?, address}]` / `[{name?, number}]` list → one string. */
function contactValue(member, keys) {
  return firstOfList(`person.${member}`, (ctx, entry, pointer) => {
    const field = member === "email" ? "address" : "number";
    if (!isObjectRecord(entry) || !isNonEmptyString(entry[field])) {
      addLoss(ctx, pointer, `person.${member} entry has no ${field}`);
      return undefined;
    }
    reportUnmapped(ctx, `person.${member}`, entry, pointer, keys);
    return entry[field];
  });
}

const PERSON_SPEC = Object.freeze({
  name: true,
  email: Object.freeze({ convert: contactValue("email", EMAIL_KEYS) }),
  phone: Object.freeze({ convert: contactValue("phone", PHONE_KEYS) }),
});

const PARTY_KEYS = Object.freeze(
  new Set(["refId", "roles", "organization", "person"]),
);

/** Resolve a partyReference (`{ref}`) against definitions.parties. */
function resolveParty(ctx, entry, pointer) {
  if (!isObjectRecord(entry)) {
    addLoss(ctx, pointer, "party is not an object");
    return undefined;
  }
  if (typeof entry.ref !== "string") {
    return { party: entry, pointer };
  }
  const declared = ctx.partyIndex.get(entry.ref);
  if (!declared) {
    addLoss(
      ctx,
      jsonPointer(pointer, "ref"),
      `party reference '${entry.ref}' could not be resolved`,
    );
    return undefined;
  }
  return { party: declared.entry, pointer: declared.pointer };
}

/** The predefined roles of a party that `roleFields` maps to 1.x fields. */
function mappedRoles(ctx, party, pointer, roleFields) {
  const roles = [];
  (Array.isArray(party.roles) ? party.roles : []).forEach((role, index) => {
    const rolePointer = jsonPointer(pointer, "roles", index);
    if (!isObjectRecord(role) || typeof role.role !== "string") {
      addLoss(ctx, rolePointer, "custom party role has no 1.x field");
      return;
    }
    if (role.order !== undefined) {
      addLoss(
        ctx,
        jsonPointer(rolePointer, "order"),
        "role.order has no 1.x field",
      );
    }
    if (!Object.hasOwn(roleFields, role.role)) {
      addLoss(ctx, rolePointer, `party role '${role.role}' has no 1.x field`);
      return;
    }
    roles.push(role.role);
  });
  if (roles.length > 1) {
    addLoss(
      ctx,
      jsonPointer(pointer, "roles"),
      "a party with several roles becomes one 1.x entry per role",
    );
  }
  return roles;
}

/** The 1.x organization or contact of one party, or undefined. */
function partyIdentity(ctx, party, pointer) {
  reportUnmapped(ctx, "party", party, pointer, PARTY_KEYS);
  let identity;
  let kind;
  if (isObjectRecord(party.organization)) {
    kind = "organization";
    identity = reverseObject(
      ctx,
      "organization",
      party.organization,
      jsonPointer(pointer, "organization"),
      ORGANIZATION_SPEC,
    );
  } else if (isObjectRecord(party.person)) {
    kind = "person";
    identity = reverseObject(
      ctx,
      "person",
      party.person,
      jsonPointer(pointer, "person"),
      PERSON_SPEC,
    );
  }
  if (!identity) {
    return undefined;
  }
  if (isNonEmptyString(party.refId)) {
    identity = { "bom-ref": party.refId, ...identity };
  }
  return { kind, identity };
}

/** Put one party identity into the 1.x field for `role`. */
function assignPartyRole(ctx, fields, role, entry, pointer) {
  const { kind, identity } = entry;
  const field = PARTY_ROLE_FIELDS_1X[role];
  if (field === "authors") {
    if (kind === "person") {
      (fields.authors ||= []).push(identity);
    } else {
      addLoss(ctx, pointer, "an organization author has no 1.x field");
    }
    return;
  }
  if (field === "publisher") {
    if (fields.publisher !== undefined || !isNonEmptyString(identity.name)) {
      addLoss(ctx, pointer, "publisher: 1.x holds one name");
      return;
    }
    fields.publisher = identity.name;
    const extra = Object.keys(identity).filter((key) => key !== "name");
    if (extra.length) {
      addLoss(
        ctx,
        pointer,
        `publisher keeps only the name (${extra.join(", ")})`,
      );
    }
    if (kind === "person") {
      addLoss(ctx, pointer, "a person publisher is written as a name");
    }
    return;
  }
  const entity = (fields[field] ||= {});
  if (kind === "person") {
    (entity.contact ||= []).push(identity);
    return;
  }
  if (entity.name !== undefined || entity.url !== undefined) {
    addLoss(ctx, pointer, `${field}: 1.x holds one organization`);
    return;
  }
  const contact = entity.contact;
  Object.assign(entity, identity);
  if (contact) {
    delete entity.contact;
    entity.contact = contact;
  }
}

/**
 * Read 2.0 component or service `parties` into the 1.x fields
 * (`supplier`, `manufacturer`, `authors`, `publisher`, `provider`). A person
 * playing the supplier, manufacturer or provider role becomes a contact of
 * that organization, the inverse of entityToParties. Party references resolve
 * against definitions.parties. Everything else is a loss.
 *
 * @param {object} ctx Reader context
 * @param {Array} parties 2.0 parties
 * @param {string} pointer JSON pointer of `parties`
 * @param {object} roleFields Roles to read (subset of PARTY_ROLE_FIELDS_1X)
 * @returns {object} 1.x fields by name
 */
export function reverseParties(ctx, parties, pointer, roleFields) {
  const fields = {};
  if (!Array.isArray(parties)) {
    addLoss(ctx, pointer, "expected an array");
    return fields;
  }
  parties.forEach((entry, index) => {
    const read = readParty(ctx, entry, jsonPointer(pointer, index), roleFields);
    for (const role of read?.roles || []) {
      assignPartyRole(
        ctx,
        fields,
        role,
        structuredClone(read.identity),
        read.pointer,
      );
    }
  });
  return fields;
}

/**
 * Read one 2.0 party (inline or a partyReference) whose roles `roleFields`
 * lists: its roles, the 1.x organization or contact it describes, and the
 * pointer of the party object. Unlisted roles and members are losses.
 *
 * @param {object} ctx Reader context
 * @param {object} entry 2.0 party or partyReference
 * @param {string} pointer JSON pointer of `entry`
 * @param {object} roleFields Role names to read, as keys
 * @returns {{roles: string[], identity: {kind: string, identity: object}, pointer: string}|undefined}
 */
export function readParty(ctx, entry, pointer, roleFields) {
  const resolved = resolveParty(ctx, entry, pointer);
  if (!resolved) {
    return undefined;
  }
  const roles = mappedRoles(ctx, resolved.party, resolved.pointer, roleFields);
  if (!roles.length) {
    return undefined;
  }
  const identity = partyIdentity(ctx, resolved.party, resolved.pointer);
  return identity ? { roles, identity, pointer: resolved.pointer } : undefined;
}
