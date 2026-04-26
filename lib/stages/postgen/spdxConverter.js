import { CDXGEN_SPDX_CREATED_BY, getTimestamp } from "../../helpers/utils.js";

export const SPDX_JSONLD_CONTEXT =
  "https://spdx.org/rdf/3.0.1/spdx-context.jsonld";
export const SPDX_SPEC_VERSION = "3.0.1";

const SPDX_DOCUMENT_PROFILES = ["core", "software"];
const SPDX_RELATIONSHIP_DEPENDS_ON = "dependsOn";
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
  const normalized = `${algorithm || ""}`
    .trim()
    .toLowerCase()
    .replace(/-/gu, "")
    .replace(/\//gu, "_");
  return SPDX_HASH_ALGORITHMS.has(normalized) ? normalized : undefined;
};

const encodeSpdxFragment = (value) =>
  `${value || "unknown"}`
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^-+/u, "")
    .replace(/-+$/u, "") || "unknown";

const createNamespace = (bomJson) => {
  const serial = `${bomJson?.serialNumber || ""}`.replace(/^urn:uuid:/u, "");
  const base =
    encodeSpdxFragment(serial) ||
    encodeSpdxFragment(bomJson?.metadata?.component?.name) ||
    `${Date.now()}`;
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

const toSpdxHashes = (component) => {
  const hashes = [];
  for (const hash of toArray(component?.hashes)) {
    const algorithm = normalizeHashAlgorithm(hash?.alg);
    if (!algorithm || !hash?.content) {
      continue;
    }
    hashes.push({
      type: "Hash",
      algorithm,
      hashValue: hash.content,
    });
  }
  return hashes;
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
  const hashes = toSpdxHashes(component);
  if (hashes.length) {
    spdxPackage.verifiedUsing = hashes;
  }
  const homepageReference = toArray(component?.externalReferences).find(
    (reference) =>
      ["website", "documentation", "distribution", "release-notes"].includes(
        reference?.type,
      ) && reference?.url,
  );
  if (homepageReference?.url && component?.type !== "file") {
    spdxPackage.software_homePage = homepageReference.url;
  }
  const downloadReference = toArray(component?.externalReferences).find(
    (reference) =>
      ["distribution", "download"].includes(reference?.type) && reference?.url,
  );
  if (downloadReference?.url && component?.type !== "file") {
    spdxPackage.software_downloadLocation = downloadReference.url;
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
    CDXGEN_SPDX_CREATED_BY ||
      `https://github.com/CycloneDX/cdxgen#${encodeSpdxFragment(options?.projectName || "cdxgen")}`,
  ];
  const creationInfo = {
    type: "CreationInfo",
    spdxId: creationInfoId,
    specVersion: SPDX_SPEC_VERSION,
    created: bomJson?.metadata?.timestamp || getTimestamp(),
    createdBy,
  };
  const rootComponent = selectRootComponent(bomJson);
  const allComponents = [];
  if (rootComponent) {
    allComponents.push(rootComponent);
  }
  for (const component of toArray(bomJson?.components)) {
    allComponents.push(component);
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
      bomJson?.metadata?.component?.version ||
      "cdxgen SPDX export",
    profileConformance: SPDX_DOCUMENT_PROFILES,
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
