/**
 * CycloneDX specification version compatibility.
 *
 * A BOM assembled in memory always carries the richest shape cdxgen knows how
 * to produce. Emitting it at an older specification version therefore means
 * removing elements that version does not define, and reshaping the ones it
 * models differently — CycloneDX forbids additional properties, so a stray
 * field fails schema validation outright.
 *
 * The reshaping is not purely subtractive. `evidence.identity` is a single
 * object up to 1.5 and an array from 1.6, and `metadata.tools` flips from a
 * `tools` object to component/service arrays at 2.0, so downgrades and upgrades
 * both rewrite structure rather than just delete keys.
 *
 * This module is the single home for that logic. It is applied to generated
 * BOMs by the postgen stage and to existing BOMs by `cdx-convert --to`, so both
 * paths produce byte-identical output for the same target version.
 */

import { thoughtLog } from "../../core/logger.js";
import {
  DEFAULT_CDX_SPEC_VERSION,
  getSupportedCycloneDxComponentTypes,
  isCycloneDx20SpecVersion,
  normalizeCycloneDxComponentTypeFilter,
  normalizeCycloneDxSpecVersion,
  setCycloneDxFormat,
  toCycloneDxSpecVersionString,
} from "../../inventory/bomUtils.js";

const COMPONENT_1_6_ONLY_FIELDS = new Set([
  "authors",
  "manufacturer",
  "omniborId",
  "swhid",
  "tags",
]);
const COMPONENT_1_7_ONLY_FIELDS = new Set([
  "isExternal",
  "patentAssertions",
  "versionRange",
]);
const SERVICE_1_6_ONLY_FIELDS = new Set(["tags"]);
const SERVICE_1_7_ONLY_FIELDS = new Set(["patentAssertions"]);
const METADATA_1_6_ONLY_FIELDS = new Set(["manufacturer"]);
const METADATA_1_7_ONLY_FIELDS = new Set(["distributionConstraints"]);
// Root-level (BOM) fields introduced by CycloneDX 1.7. These live directly on
// the document object, so the per-key recursion in downgradeSubjectForSpecVersion
// never sees them — they need an explicit root-level strip. `citations` is the
// only such field today. Ref: data/bom-1.7.schema.json (root `properties`).
const BOM_1_7_ONLY_FIELDS = new Set(["citations"]);
const DEPENDENCY_1_6_ONLY_FIELDS = new Set(["provides"]);
// License and license expression objects gained these attributes only in the
// given spec versions. CycloneDX forbids additional properties, so they must be
// removed when downgrading. Ref: data/bom-1.{4,5,6}.schema.json
// The protocol types CycloneDX 1.6 defines; 1.7 added more.
const SPEC_1_6_PROTOCOL_TYPES = new Set([
  "tls",
  "ssh",
  "ipsec",
  "ike",
  "sstp",
  "wpa",
  "other",
  "unknown",
]);
const LICENSE_1_5_ONLY_FIELDS = new Set(["bom-ref", "licensing", "properties"]);
const LICENSE_1_6_ONLY_FIELDS = new Set(["acknowledgement"]);
const LICENSE_EXPRESSION_1_5_ONLY_FIELDS = new Set(["bom-ref"]);
const LICENSE_EXPRESSION_1_6_ONLY_FIELDS = new Set(["acknowledgement"]);
const METADATA_2_0_REMOVED_FIELDS = new Set(["manufacture"]);
const COMPONENT_2_0_REMOVED_FIELDS = new Set(["author", "modified"]);

function deleteFields(subject, fields) {
  if (!subject || typeof subject !== "object") {
    return;
  }
  for (const fieldName of fields) {
    delete subject[fieldName];
  }
}

function isObjectRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeComponentForSpecVersion(subject, specVersion) {
  if (specVersion < 1.6) {
    deleteFields(subject, COMPONENT_1_6_ONLY_FIELDS);
  }
  if (specVersion < 1.7) {
    deleteFields(subject, COMPONENT_1_7_ONLY_FIELDS);
  }
}

function normalizeServiceForSpecVersion(subject, specVersion) {
  if (specVersion < 1.6) {
    deleteFields(subject, SERVICE_1_6_ONLY_FIELDS);
  }
  if (specVersion < 1.7) {
    deleteFields(subject, SERVICE_1_7_ONLY_FIELDS);
  }
  if (specVersion < 2) {
    delete subject.evidence;
  }
}

function normalizeMetadataForSpecVersion(subject, specVersion) {
  if (specVersion < 1.6) {
    deleteFields(subject, METADATA_1_6_ONLY_FIELDS);
  }
  if (specVersion < 1.7) {
    deleteFields(subject, METADATA_1_7_ONLY_FIELDS);
  }
}

function normalizeBomForSpecVersion(subject, specVersion) {
  if (specVersion < 1.7) {
    deleteFields(subject, BOM_1_7_ONLY_FIELDS);
  }
}

function normalizeDependencyForSpecVersion(subject, specVersion) {
  if (specVersion < 1.6) {
    deleteFields(subject, DEPENDENCY_1_6_ONLY_FIELDS);
  }
}

/**
 * Removes license attributes that are unsupported by the requested spec version.
 * Named (non-SPDX) licenses are commonly enriched with `properties`, which is
 * invalid for CycloneDX 1.4 and below.
 *
 * @param {Object} subject A single entry of a `licenses` array
 * @param {Number} specVersion Requested spec version
 */
function normalizeLicenseForSpecVersion(subject, specVersion) {
  if (!isObjectRecord(subject)) {
    return;
  }
  if (isObjectRecord(subject.license)) {
    if (specVersion < 1.6) {
      deleteFields(subject.license, LICENSE_1_6_ONLY_FIELDS);
    }
    if (specVersion < 1.5) {
      deleteFields(subject.license, LICENSE_1_5_ONLY_FIELDS);
    }
  }
  if (subject.expression) {
    if (specVersion < 1.6) {
      deleteFields(subject, LICENSE_EXPRESSION_1_6_ONLY_FIELDS);
    }
    if (specVersion < 1.5) {
      deleteFields(subject, LICENSE_EXPRESSION_1_5_ONLY_FIELDS);
    }
  }
}

function filterComponentArrayByType(components, allowedTypes) {
  if (!Array.isArray(components) || !allowedTypes?.size) {
    return components;
  }
  const filteredComponents = [];
  for (const component of components) {
    if (!isObjectRecord(component)) {
      filteredComponents.push(component);
      continue;
    }
    if (component.type && !allowedTypes.has(component.type)) {
      continue;
    }
    if (Array.isArray(component.components)) {
      component.components = filterComponentArrayByType(
        component.components,
        allowedTypes,
      );
    }
    filteredComponents.push(component);
  }
  return filteredComponents;
}

function filterComponentObjectByType(component, allowedTypes) {
  if (!isObjectRecord(component) || !allowedTypes?.size) {
    return component;
  }
  if (component.type && !allowedTypes.has(component.type)) {
    return undefined;
  }
  if (Array.isArray(component.components)) {
    component.components = filterComponentArrayByType(
      component.components,
      allowedTypes,
    );
  }
  return component;
}

function filterComponentArrayProperty(subject, propertyName, allowedTypes) {
  if (!isObjectRecord(subject) || !Object.hasOwn(subject, propertyName)) {
    return;
  }
  const filteredComponents = filterComponentArrayByType(
    subject[propertyName],
    allowedTypes,
  );
  if (filteredComponents === undefined) {
    delete subject[propertyName];
    return;
  }
  subject[propertyName] = filteredComponents;
}

function filterComponentObjectProperty(subject, propertyName, allowedTypes) {
  if (!isObjectRecord(subject) || !Object.hasOwn(subject, propertyName)) {
    return;
  }
  const filteredComponent = filterComponentObjectByType(
    subject[propertyName],
    allowedTypes,
  );
  if (filteredComponent === undefined) {
    delete subject[propertyName];
    return;
  }
  subject[propertyName] = filteredComponent;
}

function filterTypedComponentCollections(
  subject,
  allowedTypes,
  { includeMetadata = true } = {},
) {
  if (!isObjectRecord(subject) || !allowedTypes?.size) {
    return subject;
  }
  filterComponentArrayProperty(subject, "components", allowedTypes);
  if (includeMetadata && isObjectRecord(subject.metadata)) {
    filterComponentObjectProperty(subject.metadata, "component", allowedTypes);
    if (isObjectRecord(subject.metadata.tools)) {
      filterComponentArrayProperty(
        subject.metadata.tools,
        "components",
        allowedTypes,
      );
    } else if (Array.isArray(subject.metadata.tools)) {
      subject.metadata.tools = filterComponentArrayByType(
        subject.metadata.tools,
        allowedTypes,
      );
    }
  }
  if (Array.isArray(subject.formulation)) {
    for (const formula of subject.formulation) {
      filterTypedComponentCollections(formula, allowedTypes, {
        includeMetadata,
      });
    }
  }
  if (isObjectRecord(subject.definitions)) {
    filterComponentArrayProperty(
      subject.definitions,
      "components",
      allowedTypes,
    );
  }
  if (Array.isArray(subject.vulnerabilities)) {
    for (const vulnerability of subject.vulnerabilities) {
      if (isObjectRecord(vulnerability?.tools)) {
        filterComponentArrayProperty(
          vulnerability.tools,
          "components",
          allowedTypes,
        );
      }
    }
  }
  return subject;
}

function collectRetainedBomRefs(subject, retainedRefs = new Set()) {
  if (!subject || typeof subject !== "object") {
    return retainedRefs;
  }
  if (Array.isArray(subject)) {
    subject.forEach((entry) => {
      collectRetainedBomRefs(entry, retainedRefs);
    });
    return retainedRefs;
  }
  if (subject["bom-ref"]) {
    retainedRefs.add(subject["bom-ref"]);
  }
  for (const value of Object.values(subject)) {
    collectRetainedBomRefs(value, retainedRefs);
  }
  return retainedRefs;
}

function pruneDependenciesToRetainedRefs(bomJson) {
  if (!Array.isArray(bomJson?.dependencies)) {
    return;
  }
  const retainedRefs = collectRetainedBomRefs({
    components: bomJson.components,
    metadata: bomJson.metadata,
    services: bomJson.services,
  });
  bomJson.dependencies = bomJson.dependencies
    .filter((dependency) => retainedRefs.has(dependency.ref))
    .map((dependency) => {
      const prunedDependency = {
        ref: dependency.ref,
        dependsOn: (dependency.dependsOn || []).filter((ref) =>
          retainedRefs.has(ref),
        ),
      };
      if (dependency.provides?.length) {
        prunedDependency.provides = dependency.provides.filter((ref) =>
          retainedRefs.has(ref),
        );
      }
      return prunedDependency;
    });
}

/**
 * Restrict a BOM to the component types the caller asked for.
 *
 * Dependencies referencing pruned components are dropped so the graph never
 * points at a `bom-ref` that no longer exists.
 *
 * @param {Object} bomJson CycloneDX BOM, mutated in place
 * @param {Object} options CLI options carrying `componentType`
 * @returns {Object} The mutated BOM
 */
export function applyComponentTypeFilter(bomJson, options) {
  const componentTypes = normalizeCycloneDxComponentTypeFilter(
    options?.componentType,
  );
  if (!componentTypes.length) {
    return bomJson;
  }
  filterTypedComponentCollections(bomJson, new Set(componentTypes), {
    includeMetadata: false,
  });
  pruneDependenciesToRetainedRefs(bomJson);
  return bomJson;
}

function filterUnsupportedComponentTypesForSpecVersion(bomJson, specVersion) {
  const supportedTypes = new Set(
    getSupportedCycloneDxComponentTypes(specVersion),
  );
  filterTypedComponentCollections(bomJson, supportedTypes);
  pruneDependenciesToRetainedRefs(bomJson);
  return bomJson;
}

function authorStringToAuthors(authorValue) {
  if (typeof authorValue !== "string") {
    return undefined;
  }
  const authors = authorValue
    .split(",")
    .map((author) => author.trim())
    .filter(Boolean)
    .map((name) => ({ name }));
  return authors.length ? authors : undefined;
}

function normalizeLegacyToolComponent(tool) {
  if (!isObjectRecord(tool)) {
    return tool;
  }
  if (!tool.type) {
    tool.type = "application";
  }
  if (tool.vendor && !tool.publisher) {
    tool.publisher = tool.vendor;
  }
  delete tool.vendor;
  if (!tool.authors && tool.author) {
    tool.authors = authorStringToAuthors(tool.author);
  }
  deleteFields(tool, COMPONENT_2_0_REMOVED_FIELDS);
  normalizeComponentsForSpecVersion(tool.components);
  return tool;
}

function hasExplicitSpecVersion(specVersion) {
  return (
    specVersion !== undefined &&
    specVersion !== null &&
    `${specVersion}`.trim() !== ""
  );
}

function resolveSpecVersionForCompatibility(bomJson, options) {
  if (hasExplicitSpecVersion(options?.specVersion)) {
    return options.specVersion;
  }
  if (hasExplicitSpecVersion(bomJson?.specVersion)) {
    return bomJson.specVersion;
  }
  return DEFAULT_CDX_SPEC_VERSION;
}

function normalizeLegacyToolService(service) {
  if (!isObjectRecord(service)) {
    return service;
  }
  if (service.vendor && !service.provider) {
    service.provider =
      typeof service.vendor === "string"
        ? { name: service.vendor }
        : service.vendor;
  }
  delete service.vendor;
  deleteFields(service, COMPONENT_2_0_REMOVED_FIELDS);
  normalizeServicesForSpecVersion(service.services);
  return service;
}

function normalizeComponentsForSpecVersion(components) {
  if (!Array.isArray(components)) {
    return;
  }
  for (const component of components) {
    normalizeComponentForSpecVersion20(component);
  }
}

function normalizeComponentForSpecVersion20(component) {
  if (!isObjectRecord(component)) {
    return;
  }
  if (!component.authors && component.author) {
    component.authors = authorStringToAuthors(component.author);
  }
  deleteFields(component, COMPONENT_2_0_REMOVED_FIELDS);
  normalizeComponentsForSpecVersion(component.components);
}

function normalizeServicesForSpecVersion(services) {
  if (!Array.isArray(services)) {
    return;
  }
  for (const service of services) {
    normalizeLegacyToolService(service);
  }
}

function normalizeFormulationForSpecVersion(formulation) {
  if (!Array.isArray(formulation)) {
    return;
  }
  for (const formula of formulation) {
    if (!isObjectRecord(formula)) {
      continue;
    }
    normalizeComponentsForSpecVersion(formula.components);
    normalizeServicesForSpecVersion(formula.services);
  }
}

function normalizeVulnerabilitiesForSpecVersion(vulnerabilities) {
  if (!Array.isArray(vulnerabilities)) {
    return;
  }
  for (const vulnerability of vulnerabilities) {
    if (!isObjectRecord(vulnerability?.tools)) {
      continue;
    }
    normalizeComponentsForSpecVersion(vulnerability.tools.components);
    normalizeServicesForSpecVersion(vulnerability.tools.services);
  }
}

function normalizeDefinitionsForSpecVersion(definitions) {
  if (!isObjectRecord(definitions)) {
    return;
  }
  normalizeComponentsForSpecVersion(definitions.components);
  normalizeServicesForSpecVersion(definitions.services);
}

function migrateLegacyManufactureForSpecVersion(metadata) {
  if (!metadata.manufacture) {
    return;
  }
  if (isObjectRecord(metadata.component) && !metadata.component.manufacturer) {
    metadata.component.manufacturer = metadata.manufacture;
    return;
  }
  if (!metadata.manufacturer) {
    metadata.manufacturer = metadata.manufacture;
  }
}

function normalizeToolsForSpecVersion(subject, specVersion) {
  if (!subject || !isCycloneDx20SpecVersion(specVersion)) {
    return;
  }
  if (Array.isArray(subject.tools)) {
    subject.tools = {
      components: subject.tools.map((tool) =>
        normalizeLegacyToolComponent(isObjectRecord(tool) ? { ...tool } : tool),
      ),
    };
    return;
  }
  if (!isObjectRecord(subject.tools)) {
    return;
  }
  if (Array.isArray(subject.tools.components)) {
    subject.tools.components = subject.tools.components.map((tool) =>
      normalizeLegacyToolComponent(tool),
    );
  }
  if (Array.isArray(subject.tools.services)) {
    subject.tools.services = subject.tools.services.map((service) =>
      normalizeLegacyToolService(service),
    );
  }
}

function upgradeSubjectForSpecVersion(subject, specVersion) {
  if (!isObjectRecord(subject) || !isCycloneDx20SpecVersion(specVersion)) {
    return;
  }
  if (isObjectRecord(subject.metadata)) {
    migrateLegacyManufactureForSpecVersion(subject.metadata);
    deleteFields(subject.metadata, METADATA_2_0_REMOVED_FIELDS);
    normalizeToolsForSpecVersion(subject.metadata, specVersion);
    normalizeComponentForSpecVersion20(subject.metadata.component);
  }
  normalizeComponentsForSpecVersion(subject.components);
  normalizeFormulationForSpecVersion(subject.formulation);
  normalizeDefinitionsForSpecVersion(subject.definitions);
  normalizeVulnerabilitiesForSpecVersion(subject.vulnerabilities);
}

function downgradeSubjectForSpecVersion(subject, specVersion, parentKey) {
  if (!subject || typeof subject !== "object") {
    return;
  }
  if (Array.isArray(subject)) {
    subject.forEach((entry) => {
      downgradeSubjectForSpecVersion(entry, specVersion, parentKey);
    });
    return;
  }
  if (parentKey === "metadata") {
    normalizeMetadataForSpecVersion(subject, specVersion);
  }
  if (parentKey === "component" || parentKey === "components") {
    normalizeComponentForSpecVersion(subject, specVersion);
  }
  if (parentKey === "service" || parentKey === "services") {
    normalizeServiceForSpecVersion(subject, specVersion);
  }
  if (parentKey === "dependencies") {
    normalizeDependencyForSpecVersion(subject, specVersion);
  }
  if (parentKey === "licenses") {
    normalizeLicenseForSpecVersion(subject, specVersion);
  }
  if (specVersion < 1.6) {
    if (subject.cryptoProperties) {
      delete subject.cryptoProperties;
    }
    if (
      subject?.evidence?.occurrences &&
      Array.isArray(subject.evidence.occurrences)
    ) {
      subject.evidence.occurrences.forEach((occurrence) => {
        delete occurrence.line;
        delete occurrence.offset;
        delete occurrence.symbol;
        delete occurrence.additionalContext;
      });
    }
    if (
      subject?.evidence?.identity &&
      Array.isArray(subject.evidence.identity)
    ) {
      subject.evidence.identity = subject.evidence.identity[0];
      if (subject.evidence.identity?.concludedValue) {
        delete subject.evidence.identity.concludedValue;
      }
    }
  } else if (
    specVersion < 1.7 &&
    subject.cryptoProperties?.assetType === "certificate" &&
    subject.cryptoProperties.certificateProperties
  ) {
    const certificateProperties =
      subject.cryptoProperties.certificateProperties;
    if (
      !certificateProperties.certificateExtension &&
      certificateProperties.certificateFileExtension
    ) {
      certificateProperties.certificateExtension =
        certificateProperties.certificateFileExtension;
    }
    delete certificateProperties.serialNumber;
    delete certificateProperties.certificateFileExtension;
    delete certificateProperties.fingerprint;
  }
  if (specVersion < 1.7 && subject.cryptoProperties?.algorithmProperties) {
    // `algorithmFamily` and `ellipticCurve` are CycloneDX 1.7 additions to
    // cryptoProperties.algorithmProperties. 1.6 keeps the deprecated free-text
    // `curve`, so that one is preserved. Ref: data/bom-1.6.schema.json.
    const algorithmProperties = subject.cryptoProperties.algorithmProperties;
    // The curve stays known through the free-text field, by its name without
    // the registry prefix (`secg/secp256r1` is `secp256r1`).
    if (algorithmProperties.ellipticCurve && !algorithmProperties.curve) {
      algorithmProperties.curve = String(algorithmProperties.ellipticCurve)
        .split("/")
        .pop();
    }
    delete algorithmProperties.algorithmFamily;
    delete algorithmProperties.ellipticCurve;
    // `key-wrap` joined the primitive enum in 1.7.
    if (algorithmProperties.primitive === "key-wrap") {
      algorithmProperties.primitive = "other";
    }
  }
  if (
    specVersion < 1.7 &&
    subject.cryptoProperties?.protocolProperties?.type &&
    !SPEC_1_6_PROTOCOL_TYPES.has(
      subject.cryptoProperties.protocolProperties.type,
    )
  ) {
    // 1.7 added protocol types such as `dtls` and `quic`.
    subject.cryptoProperties.protocolProperties.type = "other";
  }
  Object.entries(subject).forEach(([key, value]) => {
    downgradeSubjectForSpecVersion(value, specVersion, key);
  });
}

/**
 * Reshape a BOM so it is valid at the requested specification version.
 *
 * Component types the target version does not define are filtered out first,
 * then root-level version-only fields are stripped, then the document is walked
 * key by key to downgrade (below 2.0) or upgrade (2.0 and above) each subject.
 * The BOM's `specVersion` and `$schema` are rewritten last.
 *
 * The target version is taken from `options.specVersion` when set, falling back
 * to the BOM's own `specVersion`. A malformed explicit version is left alone
 * rather than guessed at.
 *
 * @param {Object} bomJson CycloneDX BOM, mutated in place
 * @param {Object} options CLI options carrying the requested `specVersion`
 * @returns {Object} The mutated BOM
 */
export function applySpecVersionCompatibility(bomJson, options) {
  const requestedSpecVersion = resolveSpecVersionForCompatibility(
    bomJson,
    options,
  );
  const normalizedSpecVersion =
    toCycloneDxSpecVersionString(requestedSpecVersion);
  if (!normalizedSpecVersion) {
    thoughtLog(
      "Skipping CycloneDX specVersion compatibility updates for malformed explicit specVersion.",
      {
        specVersion: requestedSpecVersion,
      },
    );
    return bomJson;
  }
  const specVersion = normalizeCycloneDxSpecVersion(normalizedSpecVersion);
  filterUnsupportedComponentTypesForSpecVersion(bomJson, specVersion);
  // Root-level 1.7-only fields (e.g. `citations`) are not reachable by the
  // key-based recursion below, so strip them before recursing into children.
  normalizeBomForSpecVersion(bomJson, specVersion);
  if (specVersion < 2) {
    downgradeSubjectForSpecVersion(bomJson, specVersion);
  } else if (isCycloneDx20SpecVersion(specVersion)) {
    upgradeSubjectForSpecVersion(bomJson, specVersion);
  }
  return setCycloneDxFormat(bomJson, normalizedSpecVersion);
}

/**
 * Collect the set of field paths present in a BOM.
 *
 * Array nesting does not extend the path, so the result describes which fields
 * a document carries rather than where they sit. That keeps a comparison
 * between two BOMs meaningful across a compatibility pass, which both drops
 * array entries and reshapes fields whose cardinality changed between spec
 * versions — `evidence.identity` reads the same whether it holds one object or
 * an array of them.
 *
 * @param {Object} subject BOM or BOM fragment
 * @param {string} [prefix] Path accumulated so far
 * @param {Set<string>} [paths] Accumulator
 * @returns {Set<string>} Field paths, e.g. `components.evidence.identity`
 */
export function collectFieldPaths(subject, prefix = "", paths = new Set()) {
  if (Array.isArray(subject)) {
    for (const entry of subject) {
      collectFieldPaths(entry, prefix, paths);
    }
    return paths;
  }
  if (!isObjectRecord(subject)) {
    return paths;
  }
  for (const [key, value] of Object.entries(subject)) {
    const path = prefix ? `${prefix}.${key}` : key;
    paths.add(path);
    collectFieldPaths(value, path, paths);
  }
  return paths;
}

/**
 * Report which field paths a compatibility pass removed.
 *
 * @param {Object} sourceBomJson BOM before normalization
 * @param {Object} normalizedBomJson BOM after normalization
 * @returns {string[]} Sorted field paths that no longer appear
 */
export function diffRemovedFieldPaths(sourceBomJson, normalizedBomJson) {
  const retainedPaths = collectFieldPaths(normalizedBomJson);
  return [...collectFieldPaths(sourceBomJson)]
    .filter((path) => !retainedPaths.has(path))
    .sort();
}
