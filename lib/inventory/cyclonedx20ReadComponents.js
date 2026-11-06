/**
 * Reader converters for CycloneDX 2.0 components
 * (#/$defs/cyclonedx-component-2.0/$defs/component) back to 1.x components
 * and, for `type: service`, 1.x services. Each frozen spec is the allowlist
 * of the members 1.x carries; everything else is reported as a loss.
 */

import { isDeepStrictEqual } from "node:util";

import {
  createRenderStats,
  isNonEmptyString,
  isObjectRecord,
  shadowKey,
} from "./cyclonedx20Common.js";
import { readParty, reverseParties } from "./cyclonedx20Parties.js";
import {
  ATTACHMENT_RULE,
  EXTERNAL_REFERENCES_RULE,
  HASHES_RULE,
  LICENSES_RULE,
  PATENT_ASSERTIONS_RULE,
  PROPERTIES_RULE,
  RESOLVES_RULE,
  reverseAttachment,
  reverseProperty,
  reverseReleaseNotes,
} from "./cyclonedx20ReadCommon.js";
import {
  addLoss,
  jsonPointer,
  listOf,
  objectOf,
  registerShadowKey,
  reportUnmapped,
  reverseFields,
  reverseList,
  reverseObject,
} from "./cyclonedx20ReadContext.js";
import {
  reverseCryptoProperties,
  reverseEvidence,
} from "./cyclonedx20ReadEvidence.js";
import {
  convertComponent,
  convertService,
} from "./cyclonedx20RenderComponents.js";
import { identifierPartyRefId } from "./cyclonedx20RenderEvidence.js";
import {
  CARRIED_SERVICE_PROPERTIES,
  COMPONENT_TYPES_1X,
  IDENTITY_SCHEME_FIELDS_1X,
} from "./cyclonedx20Tables.js";

const COMPONENT_ROLES = Object.freeze({
  supplier: "supplier",
  manufacturer: "manufacturer",
  author: "authors",
  publisher: "publisher",
});
const SERVICE_ROLES = Object.freeze({ provider: "provider" });

// The 1.x mime-type pattern (data/bom-1.7.schema.json component.mime-type).
const isMimeType1x = (value) => {
  if (typeof value !== "string") {
    return false;
  }
  const slash = value.indexOf("/");
  const token = (part) =>
    part.length > 0 &&
    [...part].every(
      (char) =>
        (char >= "a" && char <= "z") ||
        (char >= "0" && char <= "9") ||
        char === "-" ||
        char === "+" ||
        char === ".",
    );
  return (
    slash > 0 &&
    value.indexOf("/", slash + 1) === -1 &&
    token(value.slice(0, slash)) &&
    token(value.slice(slash + 1))
  );
};

/** One identity of an identifier group onto the 1.x fields. */
function reverseIdentity(ctx, fields, identity, pointer, componentName) {
  if (!isObjectRecord(identity) || typeof identity.value !== "string") {
    addLoss(ctx, pointer, "identity has no value");
    return;
  }
  reportUnmapped(ctx, "identity", identity, pointer, IDENTITY_KEYS);
  const scheme = identity.scheme;
  const field =
    typeof scheme === "string" &&
    Object.hasOwn(IDENTITY_SCHEME_FIELDS_1X, scheme)
      ? IDENTITY_SCHEME_FIELDS_1X[scheme]
      : undefined;
  if (!field) {
    addLoss(
      ctx,
      jsonPointer(pointer, "scheme"),
      "identity scheme has no 1.x field",
    );
    return;
  }
  if (field === "omniborId" || field === "swhid") {
    (fields[field] ||= []).push(identity.value);
    return;
  }
  if (fields[field] !== undefined) {
    addLoss(ctx, pointer, `1.x holds one ${field}; only the first is kept`);
    return;
  }
  if (field !== "swid") {
    fields[field] = identity.value;
  } else if (isNonEmptyString(componentName)) {
    // 1.x swid requires tagId and name; the swid name is the software name.
    fields.swid = { tagId: identity.value, name: componentName };
  } else {
    addLoss(ctx, pointer, "a 1.x swid needs the component name");
  }
}
const IDENTITY_KEYS = Object.freeze(new Set(["scheme", "value"]));
const IDENTIFIER_KEYS = Object.freeze(new Set(["party", "identities"]));

/**
 * component.identifiers → purl, cpe, swid, omniborId and swhid. 1.x has no
 * attribution, so an identifier asserted by a party other than the one the
 * renderer derives from the document's tools (identifierPartyRefId) is a
 * loss, as is any scheme without a 1.x field.
 */
function reverseIdentifiers(ctx, value, pointer, component) {
  const fields = {};
  reverseList(ctx, value, pointer, (_ctx, group, groupPointer) => {
    if (!isObjectRecord(group)) {
      addLoss(ctx, groupPointer, "identifier is not an object");
      return undefined;
    }
    reportUnmapped(ctx, "identifier", group, groupPointer, IDENTIFIER_KEYS);
    if (group.party !== identifierPartyRefId(ctx.claims)) {
      addLoss(
        ctx,
        jsonPointer(groupPointer, "party"),
        "1.x identifiers carry no asserting party",
      );
    }
    (Array.isArray(group.identities) ? group.identities : []).forEach(
      (identity, index) => {
        reverseIdentity(
          ctx,
          fields,
          identity,
          jsonPointer(groupPointer, "identities", index),
          component.name,
        );
      },
    );
    return undefined;
  });
  return fields;
}

/** data classification: a 2.0 enum value or custom `{name}` → 1.x string. */
function reverseClassification(ctx, value, pointer) {
  if (typeof value === "string") {
    return value;
  }
  if (isObjectRecord(value) && isNonEmptyString(value.name)) {
    reportUnmapped(ctx, "classification", value, pointer, NAME_KEYS);
    return value.name;
  }
  addLoss(ctx, pointer, "classification has no 1.x form");
  return undefined;
}
const NAME_KEYS = Object.freeze(new Set(["name"]));
const CLASSIFICATION_RULE = Object.freeze({ convert: reverseClassification });

const GOVERNANCE_ROLE_FIELDS = Object.freeze({
  custodian: "custodians",
  steward: "stewards",
  owner: "owners",
});

/**
 * dataGovernance parties → the 1.x {custodians, stewards, owners} lists of
 * `{organization}` or `{contact}` entries, the inverse of convertGovernance.
 */
function reverseGovernance(ctx, value, pointer) {
  const governance = {};
  reverseList(ctx, value, pointer, (_ctx, entry, entryPointer) => {
    const read = readParty(ctx, entry, entryPointer, GOVERNANCE_ROLE_FIELDS);
    for (const role of read?.roles || []) {
      const responsible =
        read.identity.kind === "organization"
          ? { organization: structuredClone(read.identity.identity) }
          : { contact: structuredClone(read.identity.identity) };
      (governance[GOVERNANCE_ROLE_FIELDS[role]] ||= []).push(responsible);
    }
    return undefined;
  });
  return Object.keys(governance).length ? governance : undefined;
}

const DATA_CONTENTS_SPEC = Object.freeze({
  attachment: ATTACHMENT_RULE,
  url: true,
  properties: PROPERTIES_RULE,
});

/** graphics collection: graphic references have no 1.x form. */
function reverseGraphic(ctx, value, pointer) {
  if (isObjectRecord(value) && typeof value.ref === "string") {
    addLoss(ctx, pointer, "graphic reference has no 1.x form");
    return undefined;
  }
  return reverseObject(ctx, "graphic", value, pointer, {
    name: true,
    image: Object.freeze({ convert: reverseAttachment }),
  });
}

const GRAPHICS_SPEC = Object.freeze({
  description: true,
  collection: listOf(reverseGraphic),
});

const COMPONENT_DATA_SPEC = Object.freeze({
  refId: "bom-ref",
  type: true,
  name: true,
  contents: objectOf("data.contents", DATA_CONTENTS_SPEC),
  classification: CLASSIFICATION_RULE,
  sensitiveData: true,
  graphics: objectOf("data.graphics", GRAPHICS_SPEC),
  description: true,
  governance: Object.freeze({ convert: reverseGovernance }),
});

/** componentData → 1.x componentData. */
function reverseComponentData(ctx, value, pointer) {
  return reverseObject(
    ctx,
    "componentData",
    value,
    pointer,
    COMPONENT_DATA_SPEC,
  );
}

const SERVICE_DATA_SPEC = Object.freeze({
  type: true,
  name: true,
  description: true,
  classification: CLASSIFICATION_RULE,
  governance: Object.freeze({ convert: reverseGovernance }),
});

/**
 * Service componentData → 1.x serviceData, which requires `flow` and
 * `classification`. 2.0 has no flow, so it reads as `unknown`; an entry with
 * no classification cannot be 1.x service data.
 */
function reverseServiceData(ctx, value, pointer) {
  if (!isObjectRecord(value) || value.classification === undefined) {
    addLoss(
      ctx,
      pointer,
      "service data without a classification has no 1.x form",
    );
    return undefined;
  }
  const entry = reverseFields(
    ctx,
    "serviceData",
    value,
    pointer,
    SERVICE_DATA_SPEC,
  );
  if (entry.type !== "other") {
    addLoss(
      ctx,
      jsonPointer(pointer, "type"),
      "service data type has no 1.x field",
    );
  }
  delete entry.type;
  if (entry.classification === undefined) {
    return undefined;
  }
  return { flow: "unknown", ...entry };
}

/** A pedigree ancestor, descendant or variant entry → a 1.x component. */
function reversePedigreeEntry(ctx, value, pointer) {
  const resolved = resolveComponentEntry(ctx, value, pointer);
  if (!resolved) {
    return undefined;
  }
  if (resolved.component.type === "service") {
    addLoss(ctx, pointer, "a service has no 1.x pedigree form");
    return undefined;
  }
  return reverseComponent(ctx, resolved.component, resolved.pointer);
}

const COMMIT_SPEC = Object.freeze({
  uid: true,
  url: true,
  author: true,
  committer: true,
  message: true,
});

/** patch: a patch reference has no 1.x form, nor does the patch refId. */
function reversePatch(ctx, value, pointer) {
  if (isObjectRecord(value) && typeof value.ref === "string") {
    addLoss(ctx, pointer, "patch reference has no 1.x form");
    return undefined;
  }
  return reverseObject(ctx, "patch", value, pointer, {
    type: true,
    diff: objectOf("diff", { text: ATTACHMENT_RULE, url: true }),
    resolves: RESOLVES_RULE,
  });
}

const PEDIGREE_SPEC = Object.freeze({
  ancestors: listOf(reversePedigreeEntry),
  descendants: listOf(reversePedigreeEntry),
  variants: listOf(reversePedigreeEntry),
  commits: listOf((ctx, value, pointer) =>
    reverseObject(ctx, "commit", value, pointer, COMMIT_SPEC),
  ),
  patches: listOf(reversePatch),
  notes: true,
});

/** Nested componentEntries → the 1.x `components` and `services`. */
function reverseNestedEntries(ctx, value, pointer) {
  const components = [];
  const services = [];
  reverseList(ctx, value, pointer, (_ctx, entry, entryPointer) => {
    const resolved = resolveComponentEntry(ctx, entry, entryPointer);
    if (!resolved) {
      return undefined;
    }
    if (resolved.component.type === "service") {
      const service = reverseService(ctx, resolved.component, resolved.pointer);
      if (service) {
        services.push(service);
      }
    } else {
      const component = reverseComponent(
        ctx,
        resolved.component,
        resolved.pointer,
      );
      if (component) {
        components.push(component);
      }
    }
    return undefined;
  });
  const fields = {};
  if (components.length) {
    fields.components = components;
  }
  if (services.length) {
    fields.services = services;
  }
  return fields;
}

/** modelProperties: only `properties` matches the 1.x modelCard. */
function reverseModelProperties(ctx, value, pointer) {
  const modelCard = reverseObject(ctx, "modelProperties", value, pointer, {
    properties: PROPERTIES_RULE,
  });
  return modelCard;
}

const COMPONENT_SPEC = Object.freeze({
  type: true,
  mediaType: Object.freeze({
    to: "mime-type",
    convert: (ctx, value, pointer) => {
      if (isMimeType1x(value)) {
        return value;
      }
      addLoss(
        ctx,
        pointer,
        "mediaType does not match the 1.x mime-type pattern",
      );
      return undefined;
    },
  }),
  refId: "bom-ref",
  parties: Object.freeze({
    spread: true,
    convert: (ctx, value, pointer) =>
      reverseParties(ctx, value, pointer, COMPONENT_ROLES),
  }),
  group: true,
  name: true,
  version: true,
  versionRange: true,
  isExternal: true,
  description: true,
  scope: true,
  hashes: HASHES_RULE,
  licenses: LICENSES_RULE,
  copyright: true,
  patentAssertions: PATENT_ASSERTIONS_RULE,
  identifiers: Object.freeze({ spread: true, convert: reverseIdentifiers }),
  pedigree: objectOf("pedigree", PEDIGREE_SPEC),
  components: Object.freeze({ spread: true, convert: reverseNestedEntries }),
  evidence: Object.freeze({ convert: reverseEvidence }),
  releaseNotes: Object.freeze({ convert: reverseReleaseNotes }),
  modelProperties: Object.freeze({
    to: "modelCard",
    convert: reverseModelProperties,
  }),
  data: listOf(reverseComponentData),
  cryptoProperties: Object.freeze({ convert: reverseCryptoProperties }),
  tags: true,
  properties: PROPERTIES_RULE,
  externalReferences: EXTERNAL_REFERENCES_RULE,
});

/**
 * A 2.0 component (not a service) → a 1.x component, or undefined when its
 * type has no 1.x equivalent (a loss).
 *
 * @param {object} ctx Reader context
 * @param {object} component 2.0 component
 * @param {string} pointer JSON pointer of `component`
 * @returns {object|undefined} 1.x component
 */
export function reverseComponent(ctx, component, pointer) {
  if (!COMPONENT_TYPES_1X.has(component.type)) {
    addLoss(
      ctx,
      jsonPointer(pointer, "type"),
      `component type '${component.type}' has no 1.x equivalent; component dropped`,
    );
    return undefined;
  }
  return reverseFields(ctx, "component", component, pointer, COMPONENT_SPEC);
}

const SERVICE_SPEC = Object.freeze({
  type: Object.freeze({ convert: () => undefined }),
  refId: "bom-ref",
  parties: Object.freeze({
    spread: true,
    convert: (ctx, value, pointer) =>
      reverseParties(ctx, value, pointer, SERVICE_ROLES),
  }),
  group: true,
  name: true,
  version: true,
  description: true,
  endpoints: true,
  licenses: LICENSES_RULE,
  patentAssertions: PATENT_ASSERTIONS_RULE,
  externalReferences: EXTERNAL_REFERENCES_RULE,
  data: listOf(reverseServiceData),
  components: Object.freeze({
    to: "services",
    convert: (ctx, value, pointer) => {
      const nested = reverseNestedEntries(ctx, value, pointer);
      if (nested.components) {
        addLoss(ctx, pointer, "1.x services cannot nest components");
      }
      return nested.services;
    },
  }),
  releaseNotes: Object.freeze({ convert: reverseReleaseNotes }),
  tags: true,
  properties: Object.freeze({
    spread: true,
    convert: reverseServiceProperties,
  }),
});

/** CARRIED_SERVICE_PROPERTIES keyed by property name. */
const CARRIED_SERVICE_PROPERTY_BY_NAME = Object.freeze(
  Object.fromEntries(
    CARRIED_SERVICE_PROPERTIES.map(([field, name, kind]) => [
      name,
      Object.freeze({ field, kind }),
    ]),
  ),
);

/** A carried property value as its 1.x field value, or undefined. */
function parseCarriedServiceValue(kind, value) {
  if (typeof value !== "string") {
    return undefined;
  }
  if (kind === "boolean") {
    return value === "true" ? true : value === "false" ? false : undefined;
  }
  return value;
}

/**
 * Service properties: the cdx:service:* properties the renderer adds for the
 * 1.x `authenticated`, `x-trust-boundary` and `trustZone` become those fields
 * again (booleans for the first two) and leave the property list, so a
 * render of the read model does not add them twice. A value that does not
 * parse (or a repeat of a name already restored) stays a property.
 */
function reverseServiceProperties(ctx, value, pointer) {
  const properties = reverseList(ctx, value, pointer, reverseProperty);
  if (!properties) {
    return undefined;
  }
  const out = {};
  const kept = [];
  for (const property of properties) {
    const carried = Object.hasOwn(
      CARRIED_SERVICE_PROPERTY_BY_NAME,
      property?.name ?? "",
    )
      ? CARRIED_SERVICE_PROPERTY_BY_NAME[property.name]
      : undefined;
    const parsed = carried
      ? parseCarriedServiceValue(carried.kind, property.value)
      : undefined;
    if (parsed !== undefined && !Object.hasOwn(out, carried.field)) {
      out[carried.field] = parsed;
    } else {
      kept.push(property);
    }
  }
  if (kept.length) {
    out.properties = kept;
  }
  return out;
}

/**
 * A 2.0 component of type `service` → a 1.x service.
 *
 * @param {object} ctx Reader context
 * @param {object} component 2.0 service component
 * @param {string} pointer JSON pointer of `component`
 * @returns {object} 1.x service
 */
export function reverseService(ctx, component, pointer) {
  return reverseFields(ctx, "service", component, pointer, SERVICE_SPEC);
}

/**
 * Resolve a componentEntry (component, componentReference or
 * component-choice) to a concrete component. A reference resolves against
 * every declared component; a choice keeps its first resolvable member.
 *
 * @param {object} ctx Reader context (with `componentIndex`)
 * @param {object} entry 2.0 componentEntry
 * @param {string} pointer JSON pointer of `entry`
 * @returns {{component: object, pointer: string}|undefined}
 */
export function resolveComponentEntry(ctx, entry, pointer, depth = 0) {
  if (!isObjectRecord(entry) || depth > 32) {
    addLoss(ctx, pointer, "component entry is not an object");
    return undefined;
  }
  if (typeof entry.ref === "string" && entry.name === undefined) {
    const declared = ctx.componentIndex.get(entry.ref);
    if (!declared) {
      addLoss(
        ctx,
        jsonPointer(pointer, "ref"),
        `component reference '${entry.ref}' could not be resolved`,
      );
      return undefined;
    }
    return resolveComponentEntry(
      ctx,
      declared.entry,
      declared.pointer,
      depth + 1,
    );
  }
  if (entry.type === "component-choice") {
    const members = Array.isArray(entry.components) ? entry.components : [];
    for (let index = 0; index < members.length; index++) {
      const memberPointer = jsonPointer(pointer, "components", index);
      const resolved = resolveComponentEntry(
        ctx,
        members[index],
        memberPointer,
        depth + 1,
      );
      if (resolved) {
        addLoss(
          ctx,
          pointer,
          "component-choice has no 1.x form; its first member is kept",
        );
        return resolved;
      }
    }
    addLoss(ctx, pointer, "component-choice has no resolvable member");
    return undefined;
  }
  return { component: entry, pointer };
}

/**
 * Read one top-level component entry (an inventory entry, subject, tool,
 * definitions component, formula component or annotator) into 1.x, as a
 * component or a service. `needsShadow` is set when the 1.x value does not
 * render back to the same 2.0 entry; a caller that keeps the entry passes the
 * result to keepComponentShadow.
 *
 * @param {object} ctx Reader context
 * @param {object} entry 2.0 componentEntry
 * @param {string} pointer JSON pointer of `entry`
 * @returns {{internal: object, isService: boolean, refId?: string, entry: object, needsShadow: boolean}|undefined}
 */
export function readComponentEntry(ctx, entry, pointer) {
  const before = ctx.losses.length;
  const resolved = resolveComponentEntry(ctx, entry, pointer);
  if (!resolved) {
    return undefined;
  }
  const isService = resolved.component.type === "service";
  const internal = isService
    ? reverseService(ctx, resolved.component, resolved.pointer)
    : reverseComponent(ctx, resolved.component, resolved.pointer);
  if (!internal) {
    return undefined;
  }
  const stats = createRenderStats(undefined, ctx.claims);
  const rendered = isService
    ? convertService(internal, stats)
    : convertComponent(internal, stats);
  return {
    internal,
    isService,
    refId: resolved.component.refId,
    entry,
    needsShadow:
      ctx.losses.length > before || !isDeepStrictEqual(rendered, entry),
  };
}

/**
 * Note a kept component entry for the shadows. Entries read inside a section
 * entry that is itself restored whole (annotations, vulnerabilities) are not
 * noted, since the renderer never converts them.
 *
 * @param {object} ctx Reader context
 * @param {object} read Result of readComponentEntry
 */
export function keepComponentShadow(ctx, read) {
  if (!read || ctx.shadowSuspended) {
    return;
  }
  ctx.keptComponents.push({
    key: shadowKey(read.internal),
    original: read.entry,
    needsShadow: read.needsShadow,
  });
}

/**
 * Register the component shadows. Kept entries whose 1.x values are
 * identical share a key; when any of them needs a shadow, all of them are
 * registered in document order, which is the order the renderer converts
 * them in, so each gets its own original back.
 *
 * @param {object} ctx Reader context
 */
export function flushComponentShadows(ctx) {
  const needed = new Set(
    ctx.keptComponents
      .filter((kept) => kept.needsShadow)
      .map((kept) => kept.key),
  );
  for (const kept of ctx.keptComponents) {
    if (needed.has(kept.key)) {
      registerShadowKey(ctx, "component", kept.key, kept.original);
    }
  }
}
