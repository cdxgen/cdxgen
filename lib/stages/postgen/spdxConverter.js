import { CDXGEN_SPDX_CREATED_BY, getTimestamp } from "../../helpers/utils.js";

export const SPDX_JSONLD_CONTEXT =
  "https://spdx.org/rdf/3.0.1/spdx-context.jsonld";
export const SPDX_SPEC_VERSION = "3.0.1";

const SPDX_DOCUMENT_PROFILES = ["core", "software"];
const SPDX_RELATIONSHIP_DEPENDS_ON = "dependsOn";
const SPDX_EXTENSION_PROFILE = "extension";
const SPDX_EXTENSION_KEY = "extension";
const SPDX_CDX_PROPERTIES_EXTENSION_TYPE = "extension_CdxPropertiesExtension";
const SPDX_CDX_PROPERTY_ENTRY_TYPE = "extension_CdxPropertyEntry";
const SPDX_CDX_PROPERTY_KEY = "extension_cdxProperty";
const SPDX_CDX_PROPERTY_NAME_KEY = "extension_cdxPropName";
const SPDX_CDX_PROPERTY_VALUE_KEY = "extension_cdxPropValue";
const SPDX_EXTERNAL_REF_TYPE_MAP = Object.freeze({
  website: "altWebPage",
  documentation: "documentation",
  distribution: "altDownloadLocation",
  download: "altDownloadLocation",
  "issue-tracker": "issueTracker",
  "mailing-list": "mailingList",
  vcs: "vcs",
  "build-meta": "buildMeta",
  "build-system": "buildSystem",
  "release-notes": "releaseNotes",
  chat: "chat",
  social: "socialMedia",
  "social-media": "socialMedia",
  support: "support",
  license: "license",
  cwe: "cwe",
});
const SPDX_HASH_ALGORITHMS = new Set([
  "sha1",
  "sha224",
  "sha256",
  "sha384",
  "sha512",
  "sha3_256",
  "sha3_384",
  "sha3_512",
  "md2",
  "md4",
  "md5",
  "md6",
  "adler32",
  "blake2b_256",
  "blake2b_384",
  "blake2b_512",
  "blake3",
  "gost3411",
  "ripemd_160",
  "shake_256",
  "sm3",
  "streebog_256",
  "streebog_512",
]);

/**
 * Cache normalized SPDX hash algorithm names across conversions.
 *
 * This module-level cache intentionally lives for the process lifetime so
 * repeated convertCycloneDxToSpdx() calls avoid repeated normalization work.
 */
const normalizedHashAlgorithmCache = new Map();

const toArray = (value) => {
  if (Array.isArray(value)) {
    return value;
  }
  if (value) {
    return [value];
  }
  return [];
};

const normalizeHashAlgorithm = (algorithm) => {
  const cacheKey = `${algorithm || ""}`;
  if (normalizedHashAlgorithmCache.has(cacheKey)) {
    return normalizedHashAlgorithmCache.get(cacheKey);
  }
  const normalized = `${algorithm || ""}`
    .trim()
    .toLowerCase()
    .replace(/-/gu, "")
    .replace(/\//gu, "_");
  const normalizedAlgorithm = SPDX_HASH_ALGORITHMS.has(normalized)
    ? normalized
    : undefined;
  normalizedHashAlgorithmCache.set(cacheKey, normalizedAlgorithm);
  return normalizedAlgorithm;
};

const toSerializableValue = (value) => {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    const output = [];
    for (const item of value) {
      const mappedValue = toSerializableValue(item);
      if (mappedValue !== undefined) {
        output.push(mappedValue);
      }
    }
    return output;
  }
  if (typeof value === "object") {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      const mappedValue = toSerializableValue(item);
      if (mappedValue !== undefined) {
        output[key] = mappedValue;
      }
    }
    return output;
  }
  return `${value}`;
};

const addIfDefined = (obj, key, value) => {
  if (value !== undefined && value !== null) {
    obj[key] = value;
  }
};

const hasEntries = (value) => {
  if (!value) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === "object") {
    return Object.keys(value).length > 0;
  }
  return true;
};

const isSimpleValue = (value) =>
  value === null ||
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean";

const stringifyExtensionPropertyValue = (value) =>
  typeof value === "string"
    ? value
    : JSON.stringify(toSerializableValue(value));

const encodeSpdxFragment = (value) =>
  `${value || "unknown"}`
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^-+/u, "")
    .replace(/-+$/u, "") || "unknown";

const createNamespace = (bomJson) => {
  const serial = `${bomJson?.serialNumber || ""}`.replace(/^urn:uuid:/u, "");
  const componentName = `${bomJson?.metadata?.component?.name || ""}`.trim();
  const serialFragment = serial ? encodeSpdxFragment(serial) : "";
  const componentNameFragment = componentName
    ? encodeSpdxFragment(componentName)
    : "";
  const base = serialFragment || componentNameFragment || `${Date.now()}`;
  return `urn:cdxgen:spdx:${base}#`;
};

const buildElementKey = (component) =>
  component?.["bom-ref"] ||
  component?.purl ||
  `${component?.name || "component"}@${component?.version || "0"}`;

const buildSpdxId = (namespace, prefix, value) =>
  `${namespace}${prefix}-${encodeSpdxFragment(value)}`;

const selectRootComponent = (bomJson) => {
  if (bomJson?.metadata?.component) {
    return bomJson.metadata.component;
  }
  return bomJson?.components?.[0];
};

const toSpdxHashes = (hashInput) => {
  const hashes = [];
  const originalHashes = [];
  for (const hash of toArray(hashInput)) {
    if (!hash?.content) {
      continue;
    }
    const algorithm = normalizeHashAlgorithm(hash?.alg);
    const originalHash = {
      algorithm: hash?.alg || "unknown",
      hashValue: hash.content,
    };
    if (algorithm) {
      originalHash.normalizedAlgorithm = algorithm;
    }
    originalHashes.push(originalHash);
    if (!algorithm) {
      continue;
    }
    hashes.push({
      type: "Hash",
      algorithm,
      hashValue: hash.content,
    });
  }
  return { hashes, originalHashes };
};

const toPropertyList = (propertyInput) => {
  const properties = [];
  for (const property of toArray(propertyInput)) {
    if (!property?.name) {
      continue;
    }
    properties.push({
      name: `${property.name}`,
      value: `${property.value ?? ""}`,
    });
  }
  return properties;
};

const toReferenceList = (referenceInput) => {
  const references = [];
  for (const reference of toArray(referenceInput)) {
    if (!reference?.url) {
      continue;
    }
    const serializedReference = {
      type: `${reference?.type || "other"}`,
      url: reference.url,
    };
    const refHashes = toSpdxHashes(reference?.hashes);
    if (reference?.comment) {
      serializedReference.comment = reference.comment;
    }
    if (refHashes.hashes.length) {
      serializedReference.verifiedUsing = refHashes.hashes;
    }
    if (refHashes.originalHashes.length) {
      serializedReference.originalHashes = refHashes.originalHashes;
    }
    references.push(serializedReference);
  }
  return references;
};

const toSpdxExternalRefList = (referenceInput) => {
  const references = [];
  for (const reference of toArray(referenceInput)) {
    if (!reference?.url) {
      continue;
    }
    const spdxReference = {
      type: "ExternalRef",
      externalRefType: SPDX_EXTERNAL_REF_TYPE_MAP[reference?.type] || "other",
      locator: [reference.url],
    };
    if (reference?.comment) {
      spdxReference.comment = reference.comment;
    }
    references.push(spdxReference);
  }
  return references;
};

const toSpdxExternalReferences = (component) => {
  const references = toSpdxExternalRefList(component?.externalReferences);
  const homepageReference = references.find((reference) =>
    [
      "altWebPage",
      "documentation",
      "altDownloadLocation",
      "releaseNotes",
    ].includes(reference?.externalRefType),
  );
  const downloadReference = references.find(
    (reference) => reference?.externalRefType === "altDownloadLocation",
  );
  return {
    references,
    homepageReference,
    downloadReference,
  };
};

const buildCycloneDxExtensionData = (component, additionalData = {}) => {
  const extensionData = {};
  const properties = toPropertyList(component?.properties);
  const externalReferences = toReferenceList(component?.externalReferences);
  const hashMappings = toSpdxHashes(component?.hashes);

  addIfDefined(extensionData, "bomRef", component?.["bom-ref"]);
  addIfDefined(extensionData, "group", component?.group);
  addIfDefined(extensionData, "scope", component?.scope);
  if (properties.length) {
    extensionData.properties = properties;
  }
  if (externalReferences.length) {
    extensionData.externalReferences = externalReferences;
  }
  if (hashMappings.originalHashes.length) {
    extensionData.hashes = hashMappings.originalHashes;
  }
  addIfDefined(
    extensionData,
    "licenses",
    toSerializableValue(component?.licenses),
  );
  addIfDefined(
    extensionData,
    "supplier",
    toSerializableValue(component?.supplier),
  );
  addIfDefined(
    extensionData,
    "manufacturer",
    toSerializableValue(component?.manufacturer),
  );
  addIfDefined(extensionData, "author", toSerializableValue(component?.author));
  addIfDefined(
    extensionData,
    "authors",
    toSerializableValue(component?.authors),
  );
  addIfDefined(
    extensionData,
    "publisher",
    toSerializableValue(component?.publisher),
  );
  addIfDefined(
    extensionData,
    "maintainer",
    toSerializableValue(component?.maintainer),
  );
  addIfDefined(
    extensionData,
    "maintainers",
    toSerializableValue(component?.maintainers),
  );
  addIfDefined(extensionData, "tags", toSerializableValue(component?.tags));
  addIfDefined(
    extensionData,
    "releaseNotes",
    toSerializableValue(component?.releaseNotes),
  );
  addIfDefined(
    extensionData,
    "evidence",
    toSerializableValue(component?.evidence),
  );
  addIfDefined(
    extensionData,
    "pedigree",
    toSerializableValue(component?.pedigree),
  );
  addIfDefined(extensionData, "cpe", toSerializableValue(component?.cpe));
  addIfDefined(extensionData, "swid", toSerializableValue(component?.swid));
  addIfDefined(
    extensionData,
    "omniborId",
    toSerializableValue(component?.omniborId),
  );
  addIfDefined(extensionData, "swhid", toSerializableValue(component?.swhid));
  for (const [key, value] of Object.entries(additionalData)) {
    addIfDefined(extensionData, key, toSerializableValue(value));
  }
  return hasEntries(extensionData) ? extensionData : undefined;
};

const maybeAppendExtensionPropertyEntries = (propertyEntries, key, value) => {
  if (value === undefined || value === null) {
    return;
  }
  if (
    Array.isArray(value) &&
    value.every((entry) => entry?.name && isSimpleValue(entry?.value))
  ) {
    for (const entry of value) {
      propertyEntries.push({
        type: SPDX_CDX_PROPERTY_ENTRY_TYPE,
        [SPDX_CDX_PROPERTY_NAME_KEY]: `${key}.${entry.name}`,
        [SPDX_CDX_PROPERTY_VALUE_KEY]: `${entry.value}`,
      });
    }
    return;
  }
  propertyEntries.push({
    type: SPDX_CDX_PROPERTY_ENTRY_TYPE,
    [SPDX_CDX_PROPERTY_NAME_KEY]: key,
    [SPDX_CDX_PROPERTY_VALUE_KEY]: stringifyExtensionPropertyValue(value),
  });
};

const toSpdxExtensions = (extensionData) => {
  if (!hasEntries(extensionData)) {
    return undefined;
  }
  const propertyEntries = [];
  for (const [key, value] of Object.entries(extensionData)) {
    maybeAppendExtensionPropertyEntries(propertyEntries, key, value);
  }
  if (!propertyEntries.length) {
    return undefined;
  }
  return [
    {
      type: SPDX_CDX_PROPERTIES_EXTENSION_TYPE,
      [SPDX_CDX_PROPERTY_KEY]: propertyEntries,
    },
  ];
};

const createSyntheticElement = (
  namespace,
  source,
  entryType,
  index,
  formulationIndex,
) => {
  const name =
    source?.name || source?.["bom-ref"] || `${entryType}-${index + 1}`;
  const bomRef =
    source?.["bom-ref"] ||
    `urn:cdxgen:${entryType}:${formulationIndex ?? "root"}:${index}`;
  const synthetic = {
    type: "library",
    name,
    version: source?.version,
    description: source?.description,
    "bom-ref": bomRef,
    properties: source?.properties,
    externalReferences: source?.externalReferences,
    hashes: source?.hashes,
    cdxgenSyntheticSource: {
      entryType,
      source: toSerializableValue(source),
    },
  };
  const syntheticKey = buildElementKey(synthetic);
  const syntheticSpdxId = buildSpdxId(
    namespace,
    "SPDXRef",
    `${entryType}-${syntheticKey}`,
  );
  return { synthetic, syntheticSpdxId };
};

const collectSyntheticComponents = (bomJson, namespace) => {
  const syntheticComponents = [];
  const syntheticRefs = [];
  for (const [index, service] of toArray(bomJson?.services).entries()) {
    const syntheticEntry = createSyntheticElement(
      namespace,
      service,
      "service",
      index,
    );
    syntheticComponents.push(syntheticEntry.synthetic);
    syntheticRefs.push(syntheticEntry.syntheticSpdxId);
  }
  for (const [formulationIndex, formulation] of toArray(
    bomJson?.formulation,
  ).entries()) {
    for (const [serviceIndex, service] of toArray(
      formulation?.services,
    ).entries()) {
      const syntheticEntry = createSyntheticElement(
        namespace,
        service,
        "formulation-service",
        serviceIndex,
        formulationIndex,
      );
      syntheticComponents.push(syntheticEntry.synthetic);
      syntheticRefs.push(syntheticEntry.syntheticSpdxId);
    }
    for (const [workflowIndex, workflow] of toArray(
      formulation?.workflows,
    ).entries()) {
      const workflowEntry = createSyntheticElement(
        namespace,
        workflow,
        "workflow",
        workflowIndex,
        formulationIndex,
      );
      syntheticComponents.push(workflowEntry.synthetic);
      syntheticRefs.push(workflowEntry.syntheticSpdxId);
      for (const [taskIndex, task] of toArray(workflow?.tasks).entries()) {
        const taskEntry = createSyntheticElement(
          namespace,
          task,
          "task",
          taskIndex,
          `${formulationIndex}-${workflowIndex}`,
        );
        syntheticComponents.push(taskEntry.synthetic);
        syntheticRefs.push(taskEntry.syntheticSpdxId);
      }
    }
    for (const [componentIndex, component] of toArray(
      formulation?.components,
    ).entries()) {
      const syntheticEntry = createSyntheticElement(
        namespace,
        component,
        "formulation-component",
        componentIndex,
        formulationIndex,
      );
      syntheticComponents.push(syntheticEntry.synthetic);
      syntheticRefs.push(syntheticEntry.syntheticSpdxId);
    }
  }
  return { syntheticComponents, syntheticRefs };
};

const buildDocumentExtensionData = (bomJson) => {
  const documentExtension = {};
  const metadataProperties = toPropertyList(bomJson?.metadata?.properties);
  const bomProperties = toPropertyList(bomJson?.properties);
  if (metadataProperties.length) {
    documentExtension.metadataProperties = metadataProperties;
  }
  if (bomProperties.length) {
    documentExtension.bomProperties = bomProperties;
  }
  addIfDefined(
    documentExtension,
    "metadataTools",
    toSerializableValue(bomJson?.metadata?.tools),
  );
  addIfDefined(
    documentExtension,
    "metadataAuthors",
    toSerializableValue(bomJson?.metadata?.authors),
  );
  addIfDefined(
    documentExtension,
    "metadataAuthor",
    toSerializableValue(bomJson?.metadata?.author),
  );
  addIfDefined(
    documentExtension,
    "metadataPublisher",
    toSerializableValue(bomJson?.metadata?.publisher),
  );
  addIfDefined(
    documentExtension,
    "metadataMaintainer",
    toSerializableValue(bomJson?.metadata?.maintainer),
  );
  addIfDefined(
    documentExtension,
    "metadataMaintainers",
    toSerializableValue(bomJson?.metadata?.maintainers),
  );
  addIfDefined(
    documentExtension,
    "metadataTags",
    toSerializableValue(bomJson?.metadata?.tags),
  );
  addIfDefined(
    documentExtension,
    "metadataSupplier",
    toSerializableValue(bomJson?.metadata?.supplier),
  );
  addIfDefined(
    documentExtension,
    "metadataManufacturer",
    toSerializableValue(bomJson?.metadata?.manufacturer),
  );
  addIfDefined(
    documentExtension,
    "metadataLicenses",
    toSerializableValue(bomJson?.metadata?.licenses),
  );
  addIfDefined(
    documentExtension,
    "services",
    toSerializableValue(bomJson?.services),
  );
  addIfDefined(
    documentExtension,
    "formulation",
    toSerializableValue(bomJson?.formulation),
  );
  return hasEntries(documentExtension) ? documentExtension : undefined;
};

const toSpdxPackage = (component, creationInfoId, spdxId) => {
  const spdxPackage = {
    type: component?.type === "file" ? "software_File" : "software_Package",
    spdxId,
    creationInfo: creationInfoId,
    name: component?.name || "unnamed-component",
  };
  if (component?.description) {
    spdxPackage.description = component.description;
  }
  if (component?.version && component?.type !== "file") {
    spdxPackage.software_packageVersion = component.version;
  }
  if (component?.purl && component?.type !== "file") {
    spdxPackage.software_packageUrl = component.purl;
  }
  const hashMappings = toSpdxHashes(component?.hashes);
  if (hashMappings.hashes.length) {
    spdxPackage.verifiedUsing = hashMappings.hashes;
  }
  const externalReferenceData = toSpdxExternalReferences(component);
  if (
    externalReferenceData.homepageReference?.locator?.[0] &&
    component?.type !== "file"
  ) {
    spdxPackage.software_homePage =
      externalReferenceData.homepageReference.locator[0];
  }
  if (
    externalReferenceData.downloadReference?.locator?.[0] &&
    component?.type !== "file"
  ) {
    spdxPackage.software_downloadLocation =
      externalReferenceData.downloadReference.locator[0];
  }
  if (externalReferenceData.references.length) {
    spdxPackage.externalRef = externalReferenceData.references;
  }
  const additionalExtensionData = {};
  if (component?.cdxgenSyntheticSource) {
    additionalExtensionData.syntheticSource = component.cdxgenSyntheticSource;
  }
  const extensionData = buildCycloneDxExtensionData(
    component,
    additionalExtensionData,
  );
  const extensions = toSpdxExtensions(extensionData);
  if (extensions) {
    spdxPackage[SPDX_EXTENSION_KEY] = extensions;
  }
  return spdxPackage;
};

const buildRelationship = (creationInfoId, from, to, relationshipId) => ({
  type: "Relationship",
  spdxId: relationshipId,
  creationInfo: creationInfoId,
  from,
  to,
  relationshipType: SPDX_RELATIONSHIP_DEPENDS_ON,
});

/**
 * Convert a CycloneDX BOM JSON document into an SPDX 3.0.1 JSON-LD document.
 *
 * @param {object|string} bomJson CycloneDX BOM JSON
 * @param {object} [options] CLI options
 * @returns {object|undefined} SPDX 3.0.1 JSON-LD document
 */
export function convertCycloneDxToSpdx(bomJson, options = {}) {
  if (!bomJson) {
    return undefined;
  }
  if (typeof bomJson === "string" || bomJson instanceof String) {
    bomJson = JSON.parse(bomJson);
  }
  const namespace = createNamespace(bomJson);
  const creationInfoId = buildSpdxId(namespace, "CreationInfo", "main");
  const createdBy = [
    CDXGEN_SPDX_CREATED_BY || "https://github.com/cdxgen/cdxgen",
  ];
  const creationInfo = {
    type: "CreationInfo",
    "@id": creationInfoId,
    specVersion: SPDX_SPEC_VERSION,
    created: bomJson?.metadata?.timestamp || getTimestamp(),
    createdBy,
  };
  const rootComponent = selectRootComponent(bomJson);
  const syntheticComponentData = collectSyntheticComponents(bomJson, namespace);
  const allComponents = [];
  if (rootComponent) {
    allComponents.push(rootComponent);
  }
  for (const component of toArray(bomJson?.components)) {
    allComponents.push(component);
  }
  for (const syntheticComponent of syntheticComponentData.syntheticComponents) {
    allComponents.push(syntheticComponent);
  }
  const dedupedComponents = new Map();
  const refToSpdxId = new Map();
  const graphElements = [];
  for (const component of allComponents) {
    const elementKey = buildElementKey(component);
    if (dedupedComponents.has(elementKey)) {
      continue;
    }
    const spdxId = buildSpdxId(namespace, "SPDXRef", elementKey);
    dedupedComponents.set(elementKey, component);
    refToSpdxId.set(elementKey, spdxId);
    graphElements.push(toSpdxPackage(component, creationInfoId, spdxId));
  }
  const relationshipElements = [];
  let relationshipIndex = 0;
  for (const dependency of toArray(bomJson?.dependencies)) {
    const sourceSpdxId = refToSpdxId.get(dependency?.ref);
    if (
      !sourceSpdxId ||
      !Array.isArray(dependency?.dependsOn) ||
      !dependency.dependsOn.length
    ) {
      continue;
    }
    const toIds = dependency.dependsOn
      .map((dependsOn) => refToSpdxId.get(dependsOn))
      .filter(Boolean);
    if (!toIds.length) {
      continue;
    }
    relationshipIndex += 1;
    relationshipElements.push(
      buildRelationship(
        creationInfoId,
        sourceSpdxId,
        toIds,
        buildSpdxId(
          namespace,
          "Relationship",
          `${dependency.ref}-${relationshipIndex}`,
        ),
      ),
    );
  }
  const rootElementId = rootComponent
    ? refToSpdxId.get(buildElementKey(rootComponent))
    : undefined;
  const documentId = buildSpdxId(namespace, "SPDXRef", "DOCUMENT");
  const spdxDocument = {
    type: "SpdxDocument",
    spdxId: documentId,
    creationInfo: creationInfoId,
    name:
      options?.projectName ||
      bomJson?.metadata?.component?.name ||
      bomJson?.metadata?.component?.["bom-ref"] ||
      "cdxgen SPDX export",
    profileConformance: [...SPDX_DOCUMENT_PROFILES],
    element: [
      ...graphElements.map((element) => element.spdxId),
      ...relationshipElements.map((element) => element.spdxId),
    ],
  };
  if (rootElementId) {
    spdxDocument.rootElement = [rootElementId];
  }
  if (bomJson?.metadata?.component?.description) {
    spdxDocument.description = bomJson.metadata.component.description;
  }
  const documentExtensionData = buildDocumentExtensionData(bomJson);
  const documentExtensions = toSpdxExtensions(documentExtensionData);
  if (documentExtensions) {
    spdxDocument[SPDX_EXTENSION_KEY] = documentExtensions;
  }
  if (
    documentExtensions ||
    graphElements.some((element) =>
      Array.isArray(element?.[SPDX_EXTENSION_KEY]),
    )
  ) {
    spdxDocument.profileConformance.push(SPDX_EXTENSION_PROFILE);
  }
  return {
    "@context": SPDX_JSONLD_CONTEXT,
    "@graph": [
      creationInfo,
      spdxDocument,
      ...graphElements,
      ...relationshipElements,
    ],
  };
}
