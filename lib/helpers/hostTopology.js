import {
  mergeDependencies,
  mergeServices,
  trimComponents,
} from "./depsUtils.js";
import { getHbomHardwareClass, isHbomLikeBom } from "./hbomAnalysis.js";
import { getPropertyValue } from "./inventoryStats.js";

const HOST_VIEW_PROPERTY_PREFIX = "cdx:hostview:";
const NETWORK_HARDWARE_CLASSES = new Set([
  "network-interface",
  "wireless-adapter",
]);
const STORAGE_HARDWARE_CLASSES = new Set([
  "storage",
  "storage-device",
  "storage-volume",
]);
const OBOM_HOST_ANCHOR_TYPES = new Set(["device", "operating-system"]);
const HBOM_NETWORK_IDENTITY_PROPS = Object.freeze([
  "cdx:hbom:interface",
  "cdx:hbom:interfaceName",
]);
const RUNTIME_STORAGE_IDENTITY_PROPS = Object.freeze([
  "volume_uuid",
  "persistent_volume_id",
  "uuid",
  "device_id",
]);
const HBOM_STORAGE_IDENTITY_PROPS = Object.freeze([
  "cdx:hbom:volumeUuid",
  "cdx:hbom:uuid",
  "cdx:hbom:deviceNode",
]);
const HBOM_STORAGE_DEVICE_PROPS = Object.freeze([
  "cdx:hbom:deviceNode",
  "cdx:hbom:devicePath",
]);
const HBOM_STORAGE_MOUNT_PATH_PROPS = Object.freeze([
  "cdx:hbom:mountPoint",
  "cdx:hbom:mountPath",
  "cdx:hbom:path",
]);
const SECURE_BOOT_HOST_IDENTITY_PROPS = Object.freeze([
  [
    "path",
    Object.freeze([
      "cdx:hbom:secureBootCertificatePath",
      "cdx:hbom:secureBootDbPath",
      "cdx:hbom:secureBootDbxPath",
    ]),
  ],
  [
    "serial",
    Object.freeze([
      "cdx:hbom:secureBootCertificateSerial",
      "cdx:hbom:secureBootDbSerial",
      "cdx:hbom:secureBootDbxSerial",
      "cdx:hbom:secureBootSerial",
    ]),
  ],
  [
    "sha1",
    Object.freeze([
      "cdx:hbom:secureBootCertificateSha1",
      "cdx:hbom:secureBootDbSha1",
      "cdx:hbom:secureBootDbxSha1",
      "cdx:hbom:secureBootSha1",
    ]),
  ],
  [
    "subject_key_id",
    Object.freeze([
      "cdx:hbom:secureBootCertificateSubjectKeyId",
      "cdx:hbom:secureBootDbSubjectKeyId",
      "cdx:hbom:secureBootDbxSubjectKeyId",
      "cdx:hbom:secureBootSubjectKeyId",
    ]),
  ],
  [
    "authority_key_id",
    Object.freeze([
      "cdx:hbom:secureBootCertificateAuthorityKeyId",
      "cdx:hbom:secureBootDbAuthorityKeyId",
      "cdx:hbom:secureBootDbxAuthorityKeyId",
      "cdx:hbom:secureBootAuthorityKeyId",
    ]),
  ],
]);

function getPropertyValues(propertiesOrObject, propertyName) {
  const properties = Array.isArray(propertiesOrObject)
    ? propertiesOrObject
    : Array.isArray(propertiesOrObject?.properties)
      ? propertiesOrObject.properties
      : [];
  return properties
    .filter((property) => property?.name === propertyName)
    .map((property) => property.value)
    .filter(
      (value) =>
        value !== undefined && value !== null && `${value}`.trim() !== "",
    );
}

function removePropertiesByPrefix(subject, propertyPrefix) {
  if (!Array.isArray(subject?.properties)) {
    return;
  }
  subject.properties = subject.properties.filter(
    (property) => !`${property?.name || ""}`.startsWith(propertyPrefix),
  );
}

function addUniqueProperty(subject, name, value) {
  if (
    !subject ||
    value === undefined ||
    value === null ||
    `${value}`.trim() === ""
  ) {
    return;
  }
  if (!Array.isArray(subject.properties)) {
    subject.properties = [];
  }
  if (
    subject.properties.some(
      (property) => property?.name === name && property?.value === `${value}`,
    )
  ) {
    return;
  }
  subject.properties.push({
    name,
    value: `${value}`,
  });
}

function addHostViewSummaryProperty(bomJson, name, value) {
  addUniqueProperty(bomJson, name, value);
  addUniqueProperty(bomJson?.metadata?.component, name, value);
}

function sanitizeRefToken(value, fallback = "unknown") {
  let normalizedValue = `${value || ""}`
    .trim()
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\s+/gu, "-")
    .replace(/[^a-zA-Z0-9._:-]+/gu, "-")
    .replace(/-+/gu, "-");
  while (normalizedValue.startsWith("-") || normalizedValue.startsWith(":")) {
    normalizedValue = normalizedValue.slice(1);
  }
  while (normalizedValue.endsWith("-") || normalizedValue.endsWith(":")) {
    normalizedValue = normalizedValue.slice(0, -1);
  }
  return normalizedValue || fallback;
}

function createSyntheticMetadataRef(metadataComponent) {
  return [
    "urn:cdxgen:host",
    sanitizeRefToken(metadataComponent?.type || "device"),
    sanitizeRefToken(metadataComponent?.name || "host"),
    sanitizeRefToken(
      getPropertyValue(metadataComponent, "cdx:hbom:platform") ||
        getPropertyValue(metadataComponent, "cdx:hbom:architecture") ||
        metadataComponent?.version ||
        "live",
    ),
  ].join(":");
}

function createSyntheticComponentRef(component) {
  const hbomClass = getHbomHardwareClass(component);
  const runtimeCategory = getPropertyValue(component, "cdx:osquery:category");
  const identityValue =
    getPropertyValue(component, "cdx:hbom:busInfo") ||
    getPropertyValue(component, "interface") ||
    getPropertyValue(component, "path") ||
    getPropertyValue(component, "uuid") ||
    component?.version ||
    "unknown";
  return [
    "urn:cdxgen:component",
    sanitizeRefToken(component?.type || "component"),
    sanitizeRefToken(hbomClass || runtimeCategory || "component"),
    sanitizeRefToken(component?.name || "unnamed"),
    sanitizeRefToken(identityValue),
  ].join(":");
}

function assignSyntheticBomRef(subject, usedRefs, createRef) {
  if (!subject || typeof subject !== "object") {
    return;
  }
  const existingRef = subject["bom-ref"];
  if (existingRef) {
    usedRefs.add(existingRef.toLowerCase());
    return;
  }
  const baseRef = createRef(subject);
  let candidateRef = baseRef;
  let collisionCounter = 1;
  while (usedRefs.has(candidateRef.toLowerCase())) {
    collisionCounter += 1;
    candidateRef = `${baseRef}:${collisionCounter}`;
  }
  subject["bom-ref"] = candidateRef;
  usedRefs.add(candidateRef.toLowerCase());
}

function ensureBomRefs(bomJson) {
  const usedRefs = new Set();
  if (bomJson?.metadata?.component?.["bom-ref"]) {
    usedRefs.add(bomJson.metadata.component["bom-ref"].toLowerCase());
  }
  for (const component of bomJson?.components || []) {
    if (component?.["bom-ref"]) {
      usedRefs.add(component["bom-ref"].toLowerCase());
    }
  }
  if (bomJson?.metadata?.component) {
    assignSyntheticBomRef(
      bomJson.metadata.component,
      usedRefs,
      createSyntheticMetadataRef,
    );
  }
  for (const component of bomJson?.components || []) {
    assignSyntheticBomRef(component, usedRefs, createSyntheticComponentRef);
  }
  return bomJson;
}

function appendMapEntry(map, key, value) {
  if (!key || !value) {
    return;
  }
  if (!map.has(key)) {
    map.set(key, new Set());
  }
  map.get(key).add(value);
}

function toNormalizedIdentity(value) {
  const normalizedValue = `${value || ""}`.trim().toLowerCase();
  if (!normalizedValue || normalizedValue.startsWith("redacted:")) {
    return undefined;
  }
  return normalizedValue;
}

function getNormalizedPropertyValues(subject, propertyName) {
  return getPropertyValues(subject, propertyName)
    .map((value) => toNormalizedIdentity(value))
    .filter(Boolean);
}

function getNormalizedCandidateValues(values = []) {
  return Array.from(
    new Set(values.map((value) => toNormalizedIdentity(value)).filter(Boolean)),
  );
}

function isFilesystemIdentity(value) {
  const normalizedValue = `${value || ""}`.trim();
  return (
    normalizedValue.startsWith("/") ||
    /^[a-z]:$/iu.test(normalizedValue) ||
    /^[a-z]:[\\/]/iu.test(normalizedValue)
  );
}

function createRuntimeIndexes(runtimeComponents) {
  const interfaceAddressesByName = new Map();
  const kernelModulesByName = new Map();
  const mountPathsByDevice = new Map();
  const mountPathsByPath = new Map();
  const runtimeByStorageIdentity = new Map();
  const secureBootCertificatesByField = {
    authority_key_id: new Map(),
    path: new Map(),
    serial: new Map(),
    sha1: new Map(),
    subject_key_id: new Map(),
  };

  for (const component of runtimeComponents) {
    const runtimeCategory = getPropertyValue(component, "cdx:osquery:category");
    if (!runtimeCategory || !component?.["bom-ref"]) {
      continue;
    }
    if (runtimeCategory === "interface_addresses") {
      appendMapEntry(
        interfaceAddressesByName,
        toNormalizedIdentity(getPropertyValue(component, "interface")),
        component["bom-ref"],
      );
    }
    if (runtimeCategory === "kernel_modules") {
      appendMapEntry(
        kernelModulesByName,
        toNormalizedIdentity(component.name),
        component["bom-ref"],
      );
    }
    if (runtimeCategory === "mount_hardening") {
      appendMapEntry(
        mountPathsByDevice,
        toNormalizedIdentity(getPropertyValue(component, "device")),
        component["bom-ref"],
      );
      appendMapEntry(
        mountPathsByPath,
        toNormalizedIdentity(getPropertyValue(component, "path")),
        component["bom-ref"],
      );
    }
    if (runtimeCategory === "secureboot_certificates") {
      for (const fieldName of Object.keys(secureBootCertificatesByField)) {
        appendMapEntry(
          secureBootCertificatesByField[fieldName],
          toNormalizedIdentity(getPropertyValue(component, fieldName)),
          component["bom-ref"],
        );
      }
    }
    for (const propertyName of RUNTIME_STORAGE_IDENTITY_PROPS) {
      appendMapEntry(
        runtimeByStorageIdentity,
        toNormalizedIdentity(getPropertyValue(component, propertyName)),
        component["bom-ref"],
      );
    }
  }

  return {
    interfaceAddressesByName,
    kernelModulesByName,
    mountPathsByDevice,
    mountPathsByPath,
    runtimeByStorageIdentity,
    secureBootCertificatesByField,
  };
}

function addCategoryRefs(linkedRefs, linkedCategoryRefs, category, refs = []) {
  if (!category || !refs?.length) {
    return;
  }
  if (!linkedCategoryRefs.has(category)) {
    linkedCategoryRefs.set(category, new Set());
  }
  const categoryRefs = linkedCategoryRefs.get(category);
  for (const ref of refs) {
    if (!ref) {
      continue;
    }
    linkedRefs.add(ref);
    categoryRefs.add(ref);
  }
}

function annotateLinkedComponent(component, linkedCategoryRefs, linkedRefs) {
  removePropertiesByPrefix(component, HOST_VIEW_PROPERTY_PREFIX);
  const sortedCategories = Array.from(linkedCategoryRefs.keys()).sort();
  addUniqueProperty(
    component,
    "cdx:hostview:linkedRuntimeCategoryCount",
    `${sortedCategories.length}`,
  );
  addUniqueProperty(
    component,
    "cdx:hostview:topologyLinkCount",
    `${linkedRefs.size}`,
  );
  if (linkedCategoryRefs.has("interface_addresses")) {
    addUniqueProperty(
      component,
      "cdx:hostview:runtimeAddressCount",
      `${linkedCategoryRefs.get("interface_addresses").size}`,
    );
  }
  for (const category of sortedCategories) {
    addUniqueProperty(
      component,
      "cdx:hostview:linkedRuntimeCategory",
      category,
    );
    addUniqueProperty(
      component,
      `cdx:hostview:${category}:count`,
      `${linkedCategoryRefs.get(category).size}`,
    );
  }
}

function createHostTrustLinks(metadataComponent, indexes) {
  const linkedRefs = new Set();
  const linkedCategoryRefs = new Map();

  for (const [fieldName, propertyNames] of SECURE_BOOT_HOST_IDENTITY_PROPS) {
    const fieldIndex = indexes.secureBootCertificatesByField[fieldName];
    if (!fieldIndex) {
      continue;
    }
    for (const propertyName of propertyNames) {
      const identityValues = getNormalizedPropertyValues(
        metadataComponent,
        propertyName,
      );
      for (const identityValue of identityValues) {
        addCategoryRefs(
          linkedRefs,
          linkedCategoryRefs,
          "secureboot_certificates",
          Array.from(fieldIndex.get(identityValue) || []),
        );
      }
    }
  }

  return {
    linkedCategoryRefs,
    linkedRefs,
  };
}

function createDependencyEdgeList(
  hostRef,
  metadataComponent,
  hbomComponents,
  runtimeAnchorRefs,
  indexes,
) {
  const newDependencies = [];
  const linkedRuntimeCategories = new Set();
  let linkedHardwareComponentCount = 0;
  let topologyLinkCount = 0;

  const hostTrustLinks = createHostTrustLinks(metadataComponent, indexes);
  const hostDependsOn = [
    ...hbomComponents.map((component) => component["bom-ref"]),
    ...runtimeAnchorRefs,
    ...hostTrustLinks.linkedRefs,
  ].sort();

  if (hostRef && hostDependsOn.length) {
    newDependencies.push({
      ref: hostRef,
      dependsOn: hostDependsOn,
    });
  }
  if (hostTrustLinks.linkedRefs.size) {
    topologyLinkCount += hostTrustLinks.linkedRefs.size;
    for (const runtimeCategory of hostTrustLinks.linkedCategoryRefs.keys()) {
      linkedRuntimeCategories.add(runtimeCategory);
    }
    annotateLinkedComponent(
      metadataComponent,
      hostTrustLinks.linkedCategoryRefs,
      hostTrustLinks.linkedRefs,
    );
  }

  for (const component of hbomComponents) {
    const linkedRefs = new Set();
    const linkedCategoryRefs = new Map();
    const hardwareClass = getHbomHardwareClass(component);

    if (NETWORK_HARDWARE_CLASSES.has(hardwareClass)) {
      const interfaceKeys = getNormalizedCandidateValues([
        component.name,
        component.version,
        ...HBOM_NETWORK_IDENTITY_PROPS.flatMap((propertyName) =>
          getPropertyValues(component, propertyName),
        ),
      ]);
      for (const interfaceKey of interfaceKeys) {
        addCategoryRefs(
          linkedRefs,
          linkedCategoryRefs,
          "interface_addresses",
          Array.from(indexes.interfaceAddressesByName.get(interfaceKey) || []),
        );
      }
      const driverKey = toNormalizedIdentity(
        getPropertyValue(component, "cdx:hbom:driver"),
      );
      addCategoryRefs(
        linkedRefs,
        linkedCategoryRefs,
        "kernel_modules",
        Array.from(indexes.kernelModulesByName.get(driverKey) || []),
      );
    }

    if (STORAGE_HARDWARE_CLASSES.has(hardwareClass)) {
      for (const propertyName of HBOM_STORAGE_IDENTITY_PROPS) {
        const storageIdentity = toNormalizedIdentity(
          getPropertyValue(component, propertyName),
        );
        addCategoryRefs(
          linkedRefs,
          linkedCategoryRefs,
          "runtime-storage",
          Array.from(
            indexes.runtimeByStorageIdentity.get(storageIdentity) || [],
          ),
        );
      }
      for (const propertyName of HBOM_STORAGE_DEVICE_PROPS) {
        const devicePath = toNormalizedIdentity(
          getPropertyValue(component, propertyName),
        );
        addCategoryRefs(
          linkedRefs,
          linkedCategoryRefs,
          "mount_hardening",
          Array.from(indexes.mountPathsByDevice.get(devicePath) || []),
        );
      }
      for (const propertyName of HBOM_STORAGE_MOUNT_PATH_PROPS) {
        const mountPath = toNormalizedIdentity(
          getPropertyValue(component, propertyName),
        );
        addCategoryRefs(
          linkedRefs,
          linkedCategoryRefs,
          "mount_hardening",
          Array.from(indexes.mountPathsByPath.get(mountPath) || []),
        );
      }
      const explicitFilesystemIdentity = isFilesystemIdentity(component.version)
        ? toNormalizedIdentity(component.version)
        : undefined;
      addCategoryRefs(
        linkedRefs,
        linkedCategoryRefs,
        "mount_hardening",
        Array.from(
          indexes.mountPathsByDevice.get(explicitFilesystemIdentity) || [],
        ),
      );
      addCategoryRefs(
        linkedRefs,
        linkedCategoryRefs,
        "mount_hardening",
        Array.from(
          indexes.mountPathsByPath.get(explicitFilesystemIdentity) || [],
        ),
      );
    }

    if (!linkedRefs.size) {
      removePropertiesByPrefix(component, HOST_VIEW_PROPERTY_PREFIX);
      continue;
    }

    linkedHardwareComponentCount += 1;
    topologyLinkCount += linkedRefs.size;
    for (const runtimeCategory of linkedCategoryRefs.keys()) {
      linkedRuntimeCategories.add(runtimeCategory);
    }
    annotateLinkedComponent(component, linkedCategoryRefs, linkedRefs);
    newDependencies.push({
      ref: component["bom-ref"],
      dependsOn: Array.from(linkedRefs).sort(),
    });
  }

  return {
    linkedHardwareComponentCount,
    linkedRuntimeCategories: Array.from(linkedRuntimeCategories).sort(),
    newDependencies,
    topologyLinkCount,
  };
}

function mergeToolComponents(firstComponents = [], secondComponents = []) {
  const mergedByKey = new Map();
  for (const component of [...firstComponents, ...secondComponents]) {
    if (!component) {
      continue;
    }
    const key =
      `${component["bom-ref"] || ""}:${component.group || ""}:${component.name || ""}:${component.version || ""}`.toLowerCase();
    if (!mergedByKey.has(key)) {
      mergedByKey.set(key, component);
    }
  }
  return Array.from(mergedByKey.values());
}

function mergeMetadataProperties(firstProperties = [], secondProperties = []) {
  const mergedProperties = [];
  for (const property of [...firstProperties, ...secondProperties]) {
    if (
      !property?.name ||
      property?.value === undefined ||
      property?.value === null
    ) {
      continue;
    }
    if (
      !mergedProperties.find(
        (existingProperty) =>
          existingProperty.name === property.name &&
          existingProperty.value === property.value,
      )
    ) {
      mergedProperties.push(property);
    }
  }
  return mergedProperties;
}

export function isMergedHostViewBom(bomJson) {
  return (
    getPropertyValue(bomJson, "cdx:hostview:mode") === "hbom-obom-merged" ||
    (isHbomLikeBom(bomJson) &&
      (bomJson?.components || []).some((component) =>
        getPropertyValue(component, "cdx:osquery:category"),
      ))
  );
}

export function getHostViewSummary(bomJson) {
  return {
    linkedHardwareComponentCount: Number.parseInt(
      `${getPropertyValue(bomJson, "cdx:hostview:linkedHardwareComponentCount") || 0}`,
      10,
    ),
    linkedRuntimeCategories: getPropertyValues(
      bomJson,
      "cdx:hostview:linkedRuntimeCategory",
    ),
    mode: getPropertyValue(bomJson, "cdx:hostview:mode"),
    runtimeAnchorCount: Number.parseInt(
      `${getPropertyValue(bomJson, "cdx:hostview:runtimeAnchorCount") || 0}`,
      10,
    ),
    runtimeComponentCount: Number.parseInt(
      `${getPropertyValue(bomJson, "cdx:hostview:runtimeComponentCount") || 0}`,
      10,
    ),
    topologyLinkCount: Number.parseInt(
      `${getPropertyValue(bomJson, "cdx:hostview:topologyLinkCount") || 0}`,
      10,
    ),
  };
}

function ensureHostViewCategoryProperties(bomJson, linkedRuntimeCategories) {
  for (const runtimeCategory of linkedRuntimeCategories || []) {
    addHostViewSummaryProperty(
      bomJson,
      "cdx:hostview:linkedRuntimeCategory",
      runtimeCategory,
    );
  }
}

export function applyHostInventoryTopology(bomJson) {
  if (!bomJson || !isHbomLikeBom(bomJson)) {
    return bomJson;
  }

  ensureBomRefs(bomJson);
  removePropertiesByPrefix(bomJson, HOST_VIEW_PROPERTY_PREFIX);
  removePropertiesByPrefix(
    bomJson.metadata?.component,
    HOST_VIEW_PROPERTY_PREFIX,
  );

  const runtimeComponents = (bomJson.components || []).filter((component) =>
    getPropertyValue(component, "cdx:osquery:category"),
  );
  const hbomComponents = (bomJson.components || []).filter((component) =>
    getHbomHardwareClass(component),
  );
  const runtimeAnchorRefs = (bomJson.components || [])
    .filter(
      (component) =>
        component?.["bom-ref"] &&
        OBOM_HOST_ANCHOR_TYPES.has(component.type) &&
        getPropertyValue(component, "cdx:osquery:category") === undefined &&
        getHbomHardwareClass(component) === undefined,
    )
    .map((component) => component["bom-ref"]);

  const indexes = createRuntimeIndexes(runtimeComponents);
  const hostRef = bomJson?.metadata?.component?.["bom-ref"];
  const {
    linkedHardwareComponentCount,
    linkedRuntimeCategories,
    newDependencies,
    topologyLinkCount,
  } = createDependencyEdgeList(
    hostRef,
    bomJson?.metadata?.component,
    hbomComponents,
    runtimeAnchorRefs,
    indexes,
  );

  bomJson.dependencies = mergeDependencies(
    bomJson.dependencies || [],
    newDependencies,
  );
  addHostViewSummaryProperty(
    bomJson,
    "cdx:hostview:mode",
    runtimeComponents.length ? "hbom-obom-merged" : "hbom-topology",
  );
  addHostViewSummaryProperty(
    bomJson,
    "cdx:hostview:hardwareComponentCount",
    `${hbomComponents.length}`,
  );
  addHostViewSummaryProperty(
    bomJson,
    "cdx:hostview:runtimeComponentCount",
    `${runtimeComponents.length}`,
  );
  addHostViewSummaryProperty(
    bomJson,
    "cdx:hostview:runtimeAnchorCount",
    `${runtimeAnchorRefs.length}`,
  );
  addHostViewSummaryProperty(
    bomJson,
    "cdx:hostview:linkedHardwareComponentCount",
    `${linkedHardwareComponentCount}`,
  );
  addHostViewSummaryProperty(
    bomJson,
    "cdx:hostview:topologyLinkCount",
    `${topologyLinkCount}`,
  );
  ensureHostViewCategoryProperties(bomJson, linkedRuntimeCategories);
  return bomJson;
}

export function mergeHostInventoryBoms(hbomJson, obomData) {
  if (!hbomJson) {
    return hbomJson;
  }
  if (!obomData?.bomJson) {
    return applyHostInventoryTopology(hbomJson);
  }

  const runtimeComponents = [...(obomData.bomJson.components || [])];
  if (obomData.parentComponent?.name && obomData.parentComponent?.type) {
    runtimeComponents.unshift(obomData.parentComponent);
  }
  const mergedBomJson = {
    ...hbomJson,
    components: trimComponents([
      ...(hbomJson.components || []),
      ...runtimeComponents,
    ]),
    dependencies: mergeDependencies(
      hbomJson.dependencies || [],
      obomData.bomJson.dependencies || [],
    ),
    services: mergeServices(
      hbomJson.services || [],
      obomData.bomJson.services || [],
    ),
    metadata: {
      ...hbomJson.metadata,
      lifecycles: Array.from(
        new Set([
          ...(hbomJson.metadata?.lifecycles || []).map((entry) =>
            JSON.stringify(entry),
          ),
          ...(obomData.bomJson.metadata?.lifecycles || []).map((entry) =>
            JSON.stringify(entry),
          ),
        ]),
      ).map((entry) => JSON.parse(entry)),
      properties: mergeMetadataProperties(
        hbomJson.metadata?.properties || [],
        obomData.bomJson.metadata?.properties || [],
      ),
      tools: {
        ...(hbomJson.metadata?.tools || {}),
        components: mergeToolComponents(
          hbomJson.metadata?.tools?.components || [],
          obomData.bomJson.metadata?.tools?.components || [],
        ),
      },
    },
    properties: mergeMetadataProperties(
      hbomJson.properties || [],
      obomData.bomJson.properties || [],
    ),
  };
  return applyHostInventoryTopology(mergedBomJson);
}
