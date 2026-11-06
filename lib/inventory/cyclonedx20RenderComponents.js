/**
 * Render-side conversion of 1.x components, services and tools to CycloneDX
 * 2.0 components (#/$defs/cyclonedx-component-2.0/$defs/component).
 */

import {
  clone,
  copyDefined,
  countDrop,
  countUnmapped,
  identifierValues,
  isNonEmptyString,
  isObjectRecord,
  takeShadow,
  uniqueByValue,
} from "./cyclonedx20Common.js";
import {
  collectParties,
  contactToParty,
  entityToParties,
} from "./cyclonedx20Parties.js";
import {
  convertComponentEvidence,
  convertCryptoProperties,
  identifierPartyRefId,
} from "./cyclonedx20RenderEvidence.js";
import { applyHardwareMapping } from "./cyclonedx20RenderHardware.js";
import {
  CARRIED_SERVICE_PROPERTIES,
  COMPONENT_COPY_FIELDS,
  COMPONENT_DATA_FIELDS,
  COMPONENT_DATA_TYPE_ENUM,
  COMPONENT_ENTRY_ARRAY_KEYS,
  COMPONENT_HANDLED_FIELDS,
  DATA_CLASSIFICATION_ENUM,
  SERVICE_COPY_FIELDS,
  SERVICE_HANDLED_FIELDS,
} from "./cyclonedx20Tables.js";

/**
 * Convert identifier fields of a 1.x component into the identities array of
 * one `identifier` group
 * (#/$defs/cyclonedx-component-2.0/$defs/identifiers → identifier → identity,
 * required `[party, identities]` / `[scheme, value]`). The group's required
 * asserting party is identifierPartyRefId: the cdxgen party when cdxgen is
 * the listed tool, the party of the first other listed tool when cdxgen is
 * not listed, and, when the BOM lists no tool at all, cdxgen again: as the
 * converting tool it then asserts the identifiers it wrote.
 */
function collectIdentities(component) {
  const identities = [];
  const push = (scheme, value) => {
    if (isNonEmptyString(value)) {
      identities.push({ scheme, value });
    }
  };
  push("purl", component.purl);
  push("cpe", component.cpe);
  const swid = component.swid;
  if (isObjectRecord(swid) && typeof swid.tagId === "string") {
    // The swid identity value is the tagId (ISO/IEC 19770-2 tag identifier).
    push("swid", swid.tagId);
  } else if (typeof swid === "string") {
    push("swid", swid);
  }
  for (const oid of identifierValues(component.omniborId)) {
    push("omniborid", oid);
  }
  for (const swhidValue of identifierValues(component.swhid)) {
    push("swhid", swhidValue);
  }
  return uniqueByValue(identities);
}

/**
 * Convert license choices: 1.x license objects and expressions may carry
 * `bom-ref`, which the 2.0 licenseDeclaration renames to `refId`
 * (#/$defs/cyclonedx-license-2.0/$defs/licenseDeclaration).
 */
export function convertLicenses(licenses) {
  if (!Array.isArray(licenses)) {
    return undefined;
  }
  const renameRef = (entry) => {
    if (isObjectRecord(entry) && entry["bom-ref"] !== undefined) {
      entry.refId = entry["bom-ref"];
      delete entry["bom-ref"];
    }
  };
  return licenses.map((choice) => {
    const converted = clone(choice);
    if (isObjectRecord(converted?.license)) {
      renameRef(converted.license);
    } else {
      renameRef(converted);
    }
    return converted;
  });
}

/**
 * Convert a 1.x attachment ({contentType, encoding, content}) to the 2.0
 * attachment (#/$defs/cyclonedx-common-2.0/$defs/attachment, `mediaType`
 * instead of `contentType`, `content` required).
 */
function convertAttachment(attachment, stats, label) {
  if (!isObjectRecord(attachment) || typeof attachment.content !== "string") {
    countDrop(stats, `${label} (no content)`);
    return undefined;
  }
  const converted = {};
  if (
    typeof attachment.contentType === "string" &&
    attachment.contentType.indexOf("/") > 0
  ) {
    converted.mediaType = attachment.contentType;
  }
  if (attachment.encoding === "base64") {
    converted.encoding = "base64";
  }
  converted.content = attachment.content;
  return converted;
}

/** Map a 1.x free-text data classification onto the 2.0 enum or `{name}`. */
function toDataClassification(classification) {
  if (isNonEmptyString(classification)) {
    return DATA_CLASSIFICATION_ENUM.has(classification)
      ? classification
      : { name: classification };
  }
  if (isNonEmptyString(classification?.name)) {
    return { name: classification.name };
  }
  return undefined;
}

/**
 * Convert 1.x dataGovernance ({custodians, stewards, owners} of
 * organization-or-contact entries) into the 2.0 array of parties
 * (#/$defs/cyclonedx-data-2.0/$defs/dataGovernance) with the matching roles.
 */
function convertGovernance(governance, stats) {
  if (!isObjectRecord(governance)) {
    return undefined;
  }
  const parties = [];
  for (const [field, role] of [
    ["custodians", "custodian"],
    ["stewards", "steward"],
    ["owners", "owner"],
  ]) {
    for (const entry of Array.isArray(governance[field])
      ? governance[field]
      : []) {
      if (isObjectRecord(entry?.organization)) {
        parties.push(...entityToParties(entry.organization, role, stats));
        continue;
      }
      const party = contactToParty(entry?.contact, role, stats);
      if (party) {
        parties.push(party);
      } else {
        countDrop(stats, "data.governance (empty)");
      }
    }
  }
  const unique = uniqueByValue(parties);
  return unique.length ? unique : undefined;
}

/** Convert 1.x data contents ({attachment, url, properties}). */
function convertDataContents(contents, stats) {
  if (!isObjectRecord(contents)) {
    return undefined;
  }
  const converted = {};
  if (contents.attachment !== undefined) {
    const attachment = convertAttachment(
      contents.attachment,
      stats,
      "data.contents.attachment",
    );
    if (attachment) {
      converted.attachment = attachment;
    }
  }
  copyDefined(converted, contents, ["url", "properties"]);
  countUnmapped(
    stats,
    "data.contents",
    contents,
    new Set(["attachment", "url", "properties"]),
  );
  return Object.keys(converted).length ? converted : undefined;
}

/** Convert a 1.x graphics collection; each 2.0 graphic requires `image`. */
function convertGraphics(graphics, stats) {
  if (!isObjectRecord(graphics) || !Array.isArray(graphics.collection)) {
    return undefined;
  }
  const collection = [];
  for (const graphic of graphics.collection) {
    const image = convertAttachment(graphic?.image, stats, "data.graphics");
    if (!image) {
      continue;
    }
    collection.push(
      typeof graphic.name === "string"
        ? { name: graphic.name, image }
        : { image },
    );
  }
  return collection.length ? { collection } : undefined;
}

/**
 * Convert 1.x component data to componentData
 * (#/$defs/cyclonedx-component-2.0/$defs/componentData, required `[type]`).
 * 2.0 has no `description` here.
 */
function convertComponentData(data, stats) {
  if (!Array.isArray(data)) {
    return undefined;
  }
  const converted = [];
  for (const entry of data) {
    if (!isObjectRecord(entry) || !COMPONENT_DATA_TYPE_ENUM.has(entry.type)) {
      countDrop(stats, "component.data (type outside the 2.0 enum)");
      continue;
    }
    const item = {};
    if (isNonEmptyString(entry["bom-ref"])) {
      item.refId = entry["bom-ref"];
    }
    item.type = entry.type;
    if (typeof entry.name === "string") {
      item.name = entry.name;
    }
    const contents = convertDataContents(entry.contents, stats);
    if (contents) {
      item.contents = contents;
    }
    const classification = toDataClassification(entry.classification);
    if (classification !== undefined) {
      item.classification = classification;
    }
    copyDefined(item, entry, ["sensitiveData"]);
    const graphics = convertGraphics(entry.graphics, stats);
    if (graphics) {
      item.graphics = graphics;
    }
    const governance = convertGovernance(entry.governance, stats);
    if (governance) {
      item.governance = governance;
    }
    countUnmapped(stats, "component.data", entry, COMPONENT_DATA_FIELDS);
    converted.push(item);
  }
  return converted.length ? converted : undefined;
}

/**
 * Convert pedigree (#/$defs/cyclonedx-component-2.0/$defs/pedigree): the
 * ancestor, descendant and variant entries are components or references.
 */
function convertPedigree(pedigree, stats) {
  if (!isObjectRecord(pedigree)) {
    return clone(pedigree);
  }
  const converted = {};
  for (const [key, value] of Object.entries(pedigree)) {
    if (COMPONENT_ENTRY_ARRAY_KEYS.has(key) && Array.isArray(value)) {
      converted[key] = value.map((entry) =>
        convertComponentEntry(entry, stats),
      );
    } else if (key === "commits" || key === "patches") {
      converted[key] = clone(value);
    } else if (value !== undefined) {
      countDrop(stats, `component.pedigree.${key}`);
    }
  }
  return converted;
}

/**
 * Convert a nested entry: componentReference ({ref}) and component-choice
 * wrappers (#/$defs/cyclonedx-component-2.0/$defs/componentEntry oneOf) pass
 * through, everything else is a component.
 */
function convertComponentEntry(entry, stats) {
  if (
    isObjectRecord(entry) &&
    (entry.type === "component-choice" ||
      (typeof entry.ref === "string" && !entry.name))
  ) {
    return clone(entry);
  }
  return convertComponent(entry, stats);
}

/** Copy the media type and the model card under their 2.0 names. */
function convertComponentRenames(component, converted, stats) {
  if (component.mimeType !== undefined) {
    converted.mediaType = clone(component.mimeType);
  } else if (component["mime-type"] !== undefined) {
    converted.mediaType = clone(component["mime-type"]);
  }
  const modelCard = component.modelCard ?? component.modelProperties;
  if (modelCard !== undefined) {
    const modelProperties = convertModelCard(modelCard, stats);
    if (modelProperties) {
      converted.modelProperties = modelProperties;
    }
  }
}

/**
 * Convert a 1.x modelCard to 2.0 modelProperties
 * (#/$defs/cyclonedx-ai-ml-2.0/$defs/modelProperties). The two share only
 * `properties`; modelParameters, quantitativeAnalysis and considerations
 * have a different 2.0 structure and are counted.
 */
function convertModelCard(modelCard, stats) {
  if (!isObjectRecord(modelCard)) {
    countDrop(stats, "component.modelCard (not an object)");
    return undefined;
  }
  const converted = {};
  copyDefined(converted, modelCard, ["properties"]);
  countUnmapped(stats, "component.modelCard", modelCard, MODEL_CARD_FIELDS);
  return Object.keys(converted).length ? converted : undefined;
}
const MODEL_CARD_FIELDS = new Set(["properties"]);

/** Convert evidence, cryptoProperties and data of a component. */
function convertComponentDetails(component, converted, stats) {
  const evidence = convertComponentEvidence(component.evidence, stats);
  if (evidence) {
    converted.evidence = evidence;
  }
  const cryptoProperties = convertCryptoProperties(
    component.cryptoProperties,
    stats,
  );
  if (cryptoProperties) {
    converted.cryptoProperties = cryptoProperties;
  }
  const data = convertComponentData(component.data, stats);
  if (data) {
    converted.data = data;
  }
}

/** Nested components and services both become 2.0 `components`. */
function convertNestedEntries(component, converted, stats) {
  if (Array.isArray(component.components)) {
    converted.components = component.components.map((child) =>
      convertComponentEntry(child, stats),
    );
  }
  if (Array.isArray(component.services)) {
    const nestedServices = component.services.map((service) =>
      convertService(service, stats),
    );
    converted.components = [...(converted.components || []), ...nestedServices];
  }
}

/**
 * Convert one 1.x component to the 2.0 component shape
 * (#/$defs/cyclonedx-component-2.0/$defs/component). Fields with no 2.0
 * home (`signature`, the deprecated `modified`, …) are counted.
 */
export function convertComponent(component, stats) {
  if (!isObjectRecord(component)) {
    return clone(component);
  }
  // A component read from 2.0 is restored while unchanged.
  const shadow = takeShadow(stats, "component", component);
  if (shadow) {
    return shadow;
  }
  const converted = {};
  if (isNonEmptyString(component["bom-ref"])) {
    converted.refId = component["bom-ref"];
  }
  copyDefined(converted, component, COMPONENT_COPY_FIELDS);
  if (component.pedigree !== undefined) {
    converted.pedigree = convertPedigree(component.pedigree, stats);
  }
  const identities = collectIdentities(component);
  if (identities.length) {
    converted.identifiers = [
      { party: identifierPartyRefId(stats.claims), identities },
    ];
  }
  const parties = collectParties(component, stats);
  if (parties.length) {
    converted.parties = parties;
  }
  const licenses = convertLicenses(component.licenses);
  if (licenses) {
    converted.licenses = licenses;
  }
  convertComponentRenames(component, converted, stats);
  convertComponentDetails(component, converted, stats);
  convertNestedEntries(component, converted, stats);
  countUnmapped(stats, "component", component, COMPONENT_HANDLED_FIELDS);
  return applyHardwareMapping(component, converted, stats);
}

/**
 * Convert 1.x service data to componentData entries of type `other`. 2.0 has
 * no data flow, source or destination on componentData, so those are
 * counted.
 */
function convertServiceData(data, stats) {
  if (!Array.isArray(data)) {
    return undefined;
  }
  const converted = [];
  for (const entry of data) {
    if (!isObjectRecord(entry)) {
      countDrop(stats, "service.data (not an object)");
      continue;
    }
    const item = { type: "other" };
    if (typeof entry.name === "string") {
      item.name = entry.name;
    }
    const classification = toDataClassification(entry.classification);
    if (classification !== undefined) {
      item.classification = classification;
    }
    copyDefined(item, entry, ["sensitiveData", "description"]);
    const governance = convertGovernance(entry.governance, stats);
    if (governance) {
      item.governance = governance;
    }
    countUnmapped(
      stats,
      "service.data",
      entry,
      new Set([
        "name",
        "classification",
        "sensitiveData",
        "description",
        "governance",
      ]),
    );
    converted.push(item);
  }
  return converted.length ? converted : undefined;
}

/**
 * The cdx:service:* properties that carry a 1.x service's `authenticated`,
 * `x-trust-boundary` and `trustZone` at 2.0, in CARRIED_SERVICE_PROPERTIES
 * order.
 */
function carriedServiceProperties(service) {
  const carried = [];
  for (const [field, name] of CARRIED_SERVICE_PROPERTIES) {
    if (service[field] !== undefined && service[field] !== null) {
      carried.push({ name, value: `${service[field]}` });
    }
  }
  return carried;
}

/**
 * Convert one 1.x service into a 2.0 component of type `service`
 * (#/$defs/cyclonedx-component-2.0/$defs/component/properties/type). The
 * provider becomes a party with the `provider` role. `authenticated`,
 * `x-trust-boundary` and `trustZone` have no 2.0 field; they ride as the
 * cdx:service:* properties of CARRIED_SERVICE_PROPERTIES, after the service's
 * own properties, and the reader turns them back into the 1.x fields.
 */
export function convertService(service, stats) {
  if (!isObjectRecord(service)) {
    return clone(service);
  }
  const shadow = takeShadow(stats, "component", service);
  if (shadow) {
    return shadow;
  }
  const converted = { type: "service" };
  if (isNonEmptyString(service["bom-ref"])) {
    converted.refId = service["bom-ref"];
  }
  copyDefined(converted, service, SERVICE_COPY_FIELDS);
  const carried = carriedServiceProperties(service);
  if (carried.length) {
    converted.properties = [
      ...(Array.isArray(converted.properties) ? converted.properties : []),
      ...carried,
    ];
  }
  if (service.licenses !== undefined) {
    converted.licenses =
      convertLicenses(service.licenses) ?? converted.licenses;
  }
  const providers = entityToParties(service.provider, "provider", stats);
  if (providers.length) {
    converted.parties = providers;
  }
  const data = convertServiceData(service.data, stats);
  if (data) {
    converted.data = data;
  }
  const evidence = convertComponentEvidence(service.evidence, stats);
  if (evidence) {
    converted.evidence = evidence;
  }
  if (Array.isArray(service.services)) {
    converted.components = service.services.map((nested) =>
      convertService(nested, stats),
    );
  }
  countUnmapped(stats, "service", service, SERVICE_HANDLED_FIELDS);
  return converted;
}

/**
 * Convert a legacy 1.5 `metadata.tools` array of {vendor, name, version,
 * hashes, externalReferences} into components of type `application`, the way
 * specVersionCompat maps `vendor` to `publisher`.
 */
function convertLegacyTools(tools, stats) {
  const components = [];
  for (const tool of tools) {
    if (!isObjectRecord(tool) || !isNonEmptyString(tool.name)) {
      countDrop(stats, "metadata.tools (legacy entry without a name)");
      continue;
    }
    const asComponent = { type: "application", name: tool.name };
    if (isNonEmptyString(tool["bom-ref"])) {
      asComponent["bom-ref"] = tool["bom-ref"];
    }
    copyDefined(asComponent, tool, ["version", "hashes", "externalReferences"]);
    if (isNonEmptyString(tool.vendor)) {
      asComponent.publisher = tool.vendor;
    }
    countUnmapped(
      stats,
      "metadata.tools",
      tool,
      new Set([
        "bom-ref",
        "vendor",
        "name",
        "version",
        "hashes",
        "externalReferences",
      ]),
    );
    components.push(convertComponent(asComponent, stats));
  }
  return components.length ? { components } : undefined;
}

/**
 * Convert metadata.tools: the 1.x {components, services} object, or the
 * legacy 1.5 array. 2.0 tools hold only `components`
 * (#/$defs/cyclonedx-metadata-2.0/$defs/metadata/properties/tools).
 */
export function convertTools(tools, stats) {
  if (Array.isArray(tools)) {
    return convertLegacyTools(tools, stats);
  }
  if (!isObjectRecord(tools)) {
    if (tools !== undefined) {
      countDrop(stats, "metadata.tools");
    }
    return undefined;
  }
  const components = [];
  if (Array.isArray(tools.components)) {
    components.push(...tools.components.map((c) => convertComponent(c, stats)));
  }
  if (Array.isArray(tools.services)) {
    components.push(...tools.services.map((s) => convertService(s, stats)));
  }
  countUnmapped(stats, "tools", tools, new Set(["components", "services"]));
  return components.length ? { components } : undefined;
}
