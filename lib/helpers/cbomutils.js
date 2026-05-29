import { readFileSync } from "node:fs";
import { join } from "node:path";

import { executeOsQuery } from "../managers/binary.js";
import { detectJsCryptoInventory } from "./analyzer.js";
import { analyzeDosaiCrypto } from "./dosai.js";
import {
  createOccurrenceEvidence,
  formatOccurrenceEvidence,
} from "./evidenceUtils.js";
import { convertOSQueryResults, dirNameStr } from "./utils.js";

const cbomosDbQueries = JSON.parse(
  readFileSync(join(dirNameStr, "data", "cbomosdb-queries.json"), "utf-8"),
);
const cbomCryptoOids = JSON.parse(
  readFileSync(join(dirNameStr, "data", "crypto-oid.json"), "utf-8"),
);

/**
 * Method to collect crypto and ssl libraries from the OS.
 *
 * @param {Object} options
 * @returns osPkgsList Array of OS crypto packages
 */
export function collectOSCryptoLibs(options) {
  let osPkgsList = [];
  for (const queryCategory of Object.keys(cbomosDbQueries)) {
    const queryObj = cbomosDbQueries[queryCategory];
    const results = executeOsQuery(queryObj.query);
    const dlist = convertOSQueryResults(
      queryCategory,
      queryObj,
      results,
      false,
    );
    if (dlist?.length) {
      osPkgsList = osPkgsList.concat(dlist);
      // Should we downgrade from cryptographic-asset to data for < 1.6 spec
      if (options?.specVersion && options.specVersion < 1.6) {
        for (const apkg of osPkgsList) {
          if (apkg.type === "cryptographic-asset") {
            apkg.type = "data";
          }
        }
      }
    }
  }
  return osPkgsList;
}

function cleanStr(str) {
  return str.toLowerCase().replace(/[^0-9a-z ]/gi, "");
}

function normalizeDetectedCryptoAlgorithmName(name, primitive, keyLength) {
  const trimmedName = String(name || "").trim();
  if (!trimmedName) {
    return undefined;
  }
  const upperName = trimmedName.toUpperCase();
  const compactName = upperName.replace(/[^A-Z0-9]/g, "");
  const lowerName = trimmedName.toLowerCase();
  const normalizedLower = lowerName.replace(/[ _]/g, "-");
  const jwtMappings = {
    ES256: "ecdsaWithSHA256",
    ES384: "ecdsaWithSHA384",
    ES512: "ecdsaWithSHA512",
    HS256: "hmacWithSHA256",
    HS384: "hmacWithSHA384",
    HS512: "hmacWithSHA512",
    RS256: "sha256WithRSAEncryption",
    RS384: "sha384WithRSAEncryption",
    RS512: "sha512WithRSAEncryption",
  };
  if (jwtMappings[upperName]) {
    return jwtMappings[upperName];
  }
  if (/^A(128|192|256)GCM$/.test(compactName)) {
    return `aes${compactName.slice(1, 4)}-GCM`;
  }
  if (/^SHA(1|224|256|384|512)$/.test(compactName)) {
    return `sha-${compactName.slice(3)}`;
  }
  if (/^SHA3(224|256|384|512)$/.test(compactName)) {
    return `sha3-${compactName.slice(4)}`;
  }
  if (compactName === "PBKDF2") {
    return "PBKDF2";
  }
  if (compactName === "SCRYPT") {
    return "scrypt";
  }
  if (
    normalizedLower === "aes-gcm" &&
    typeof keyLength === "number" &&
    [128, 192, 256].includes(keyLength)
  ) {
    return `aes${keyLength}-GCM`;
  }
  if (
    normalizedLower === "aes-cbc" &&
    typeof keyLength === "number" &&
    [128, 192, 256].includes(keyLength)
  ) {
    return `aes${keyLength}-CBC`;
  }
  if (
    normalizedLower === "aes-ctr" &&
    typeof keyLength === "number" &&
    [128, 192, 256].includes(keyLength)
  ) {
    return `aes${keyLength}-CTR`;
  }
  if (cbomCryptoOids[trimmedName]) {
    return trimmedName;
  }
  if (cbomCryptoOids[normalizedLower]) {
    return normalizedLower;
  }
  if (primitive === "algorithm" && cbomCryptoOids[upperName]) {
    return upperName;
  }
  return trimmedName;
}

function cryptoAlgorithmBomRef(name, oid) {
  const version = oid || cleanStr(name) || "unknown";
  return `crypto/algorithm/${encodeURIComponent(name)}@${version}`;
}

function cryptoMaterialBomRef(id, materialType) {
  return `crypto/material/${encodeURIComponent(materialType || "unknown")}@${encodeURIComponent(id || "unknown")}`;
}

function dosaiMaterialCryptoType(materialType) {
  switch (String(materialType || "").toLowerCase()) {
    case "key-or-secret":
      return "secret-key";
    case "iv-or-nonce":
      return "initialization-vector";
    case "private-key-or-certificate":
      return "private-key";
    default:
      return "unknown";
  }
}

function usageLocationValue(usage) {
  if (typeof usage?.lineNumber !== "number") {
    return undefined;
  }
  return `${usage.fileName || "<inline>"}:${usage.lineNumber}${typeof usage.columnNumber === "number" ? `:${usage.columnNumber}` : ""}`;
}

function mergeAlgorithmComponentEvidence(component, usage, options) {
  if (!options?.evidence) {
    return component;
  }
  const locationValue = usageLocationValue(usage);
  const occurrence = createOccurrenceEvidence(usage.fileName || "<inline>", {
    additionalContext: usage.primitive,
    ...(typeof usage.lineNumber === "number" ? { line: usage.lineNumber } : {}),
    ...(usage.source ? { symbol: usage.source } : {}),
  });
  const evidence = component.evidence || {};
  const identity = Array.isArray(evidence.identity)
    ? (evidence.identity[0] ?? {
        field: "name",
        confidence: 1,
        concludedValue: component.name,
        methods: [],
      })
    : (evidence.identity ?? {
        field: "name",
        confidence: 1,
        concludedValue: component.name,
        methods: [],
      });
  const methodValue = occurrence
    ? formatOccurrenceEvidence(occurrence)
    : locationValue || component.name;
  if (
    !identity.methods?.some(
      (method) =>
        method.technique === "source-code-analysis" &&
        method.value === methodValue,
    )
  ) {
    identity.methods = identity.methods || [];
    identity.methods.push({
      technique: "source-code-analysis",
      confidence: 1,
      value: methodValue,
    });
  }
  evidence.identity = identity;
  if (occurrence) {
    const occurrences = evidence.occurrences || [];
    if (
      !occurrences.some(
        (existingOccurrence) =>
          formatOccurrenceEvidence(existingOccurrence) ===
          formatOccurrenceEvidence(occurrence),
      )
    ) {
      occurrences.push(occurrence);
    }
    evidence.occurrences = occurrences;
  }
  component.evidence = evidence;
  return component;
}

function normalizeCryptoComponentEvidence(component, options) {
  if (!component?.evidence?.identity) {
    return component;
  }
  if (
    options?.specVersion >= 1.6 &&
    !Array.isArray(component.evidence.identity)
  ) {
    component.evidence.identity = [component.evidence.identity];
  }
  if (
    options?.specVersion === 1.5 &&
    Array.isArray(component.evidence.identity)
  ) {
    component.evidence.identity = component.evidence.identity[0];
  }
  return component;
}

function mergeAlgorithmComponentUsage(component, usage, src, options) {
  const sourceFile = usage.fileName ? join(src, usage.fileName) : undefined;
  const properties = component.properties || [];
  const locationValue = usageLocationValue(usage);
  if (sourceFile) {
    if (
      !properties.some(
        (property) =>
          property.name === "SrcFile" && property.value === sourceFile,
      )
    ) {
      properties.push({ name: "SrcFile", value: sourceFile });
    }
  }
  if (usage.primitive) {
    if (
      !properties.some(
        (property) =>
          property.name === "cdx:crypto:primitive" &&
          property.value === usage.primitive,
      )
    ) {
      properties.push({ name: "cdx:crypto:primitive", value: usage.primitive });
    }
  }
  if (usage.source) {
    const sourceType =
      usage.source === "dosai" ? undefined : `js-ast:${usage.source}`;
    if (
      sourceType &&
      !properties.some(
        (property) =>
          property.name === "cdx:crypto:sourceType" &&
          property.value === sourceType,
      )
    ) {
      properties.push({
        name: "cdx:crypto:sourceType",
        value: sourceType,
      });
    }
  }
  if (locationValue) {
    if (
      !properties.some(
        (property) =>
          property.name === "cdx:crypto:sourceLocation" &&
          property.value === locationValue,
      )
    ) {
      properties.push({
        name: "cdx:crypto:sourceLocation",
        value: locationValue,
      });
    }
  }
  component.properties = properties;
  mergeAlgorithmComponentEvidence(component, usage, options);
  return component;
}

function normalizeDosaiCryptoNames(cryptoObject) {
  const rawName = cryptoObject?.Name || cryptoObject;
  const names = new Set([rawName]);
  const cleanName = String(rawName || "").trim();
  if (!cleanName) {
    return [];
  }
  if (cleanName.includes("/")) {
    for (const part of cleanName
      .split("/")
      .map((candidate) => candidate.trim())
      .filter(Boolean)) {
      names.add(part);
    }
  }
  if (/^SHA-?256$/i.test(cleanName)) {
    names.add("sha-256");
  } else if (/^SHA-?384$/i.test(cleanName)) {
    names.add("sha-384");
  } else if (/^SHA-?512$/i.test(cleanName)) {
    names.add("sha-512");
  } else if (/^SHA-?1$/i.test(cleanName)) {
    names.add("sha-1");
  }
  const context = [
    cryptoObject?.Symbol,
    cryptoObject?.Code,
    cryptoObject?.Algorithm,
  ]
    .filter(Boolean)
    .join(" ");
  if (/^SHA-?2$/i.test(cleanName)) {
    if (/SHA-?256/i.test(context)) {
      names.add("sha-256");
    }
    if (/SHA-?384/i.test(context)) {
      names.add("sha-384");
    }
    if (/SHA-?512/i.test(context)) {
      names.add("sha-512");
    }
  }
  return Array.from(names);
}

function dosaiCryptoUsage(assetOrOperation) {
  const location = assetOrOperation.Location || {};
  return {
    fileName: location.Path || location.FileName,
    lineNumber: location.LineNumber || undefined,
    columnNumber: location.ColumnNumber || undefined,
    primitive: assetOrOperation.Family || assetOrOperation.OperationType,
    source: "dosai",
  };
}

function addDosaiProperties(component, dosaiObject, evidenceType) {
  const properties = component.properties || [];
  const addProperty = (name, value) => {
    if (value === undefined || value === null || value === "") {
      return;
    }
    if (
      !properties.some(
        (property) =>
          property.name === name && property.value === String(value),
      )
    ) {
      properties.push({ name, value: String(value) });
    }
  };
  addProperty("cdx:crypto:sourceType", `dosai:${evidenceType}`);
  addProperty("cdx:dosai:crypto:id", dosaiObject.Id);
  addProperty("cdx:dosai:crypto:strength", dosaiObject.Strength);
  addProperty("cdx:dosai:crypto:storage", dosaiObject.Storage);
  addProperty(
    "cdx:dosai:crypto:reachableFromEntryPoint",
    dosaiObject.ReachableFromEntryPoint,
  );
  if (dosaiObject.EntryPointIds?.length) {
    addProperty(
      "cdx:dosai:crypto:entryPointCount",
      dosaiObject.EntryPointIds.length,
    );
  }
  if (dosaiObject.DataFlowSliceIds?.length) {
    addProperty(
      "cdx:dosai:crypto:dataFlowSliceIds",
      dosaiObject.DataFlowSliceIds.join(","),
    );
  }
  component.properties = properties;
}

export async function collectSourceCryptoComponents(src, options = {}) {
  const inventory = await detectJsCryptoInventory(src, Boolean(options.deep));
  const componentsByRef = new Map();
  for (const usage of inventory.algorithms || []) {
    const normalizedName = normalizeDetectedCryptoAlgorithmName(
      usage.name,
      usage.primitive,
      usage.keyLength,
    );
    if (!normalizedName) {
      continue;
    }
    const algorithmMetadata =
      cbomCryptoOids[normalizedName] || cbomCryptoOids[usage.name];
    if (!algorithmMetadata?.oid) {
      continue;
    }
    const componentName = algorithmMetadata ? normalizedName : usage.name;
    const bomRef = cryptoAlgorithmBomRef(componentName, algorithmMetadata?.oid);
    const component = componentsByRef.get(bomRef) || {
      type: "cryptographic-asset",
      name: componentName,
      "bom-ref": bomRef,
      description:
        algorithmMetadata?.description ||
        `${usage.primitive || "cryptographic"} algorithm detected in source analysis`,
      cryptoProperties: {
        assetType: "algorithm",
        ...(algorithmMetadata?.oid ? { oid: algorithmMetadata.oid } : {}),
      },
      properties: [],
    };
    mergeAlgorithmComponentUsage(component, usage, src, options);
    componentsByRef.set(bomRef, component);
  }
  const components = Array.from(componentsByRef.values());
  components.forEach((component) => {
    normalizeCryptoComponentEvidence(component, options);
  });
  return components.sort((left, right) =>
    `${left.name}:${left["bom-ref"]}`.localeCompare(
      `${right.name}:${right["bom-ref"]}`,
    ),
  );
}

export async function collectDosaiCryptoComponents(src, options = {}) {
  const dosaiCrypto = analyzeDosaiCrypto(src, options);
  if (!dosaiCrypto) {
    return [];
  }
  const componentsByRef = new Map();
  const cryptoObjects = [
    ...(dosaiCrypto.Assets || []).filter(
      (asset) => asset.AssetType === "algorithm",
    ),
    ...(dosaiCrypto.Operations || []).map((operation) => ({
      ...operation,
      Name: operation.Algorithm,
      Family: operation.OperationType,
    })),
  ];
  for (const cryptoObject of cryptoObjects) {
    for (const candidateName of normalizeDosaiCryptoNames(cryptoObject)) {
      const normalizedName = normalizeDetectedCryptoAlgorithmName(
        candidateName,
        "algorithm",
      );
      const algorithmMetadata =
        cbomCryptoOids[normalizedName] || cbomCryptoOids[candidateName];
      if (!algorithmMetadata?.oid) {
        continue;
      }
      const bomRef = cryptoAlgorithmBomRef(
        normalizedName,
        algorithmMetadata.oid,
      );
      const component = componentsByRef.get(bomRef) || {
        type: "cryptographic-asset",
        name: normalizedName,
        "bom-ref": bomRef,
        description:
          algorithmMetadata.description ||
          "Cryptographic algorithm detected by dosai source analysis",
        cryptoProperties: {
          assetType: "algorithm",
          oid: algorithmMetadata.oid,
        },
        properties: [],
      };
      mergeAlgorithmComponentUsage(
        component,
        dosaiCryptoUsage(cryptoObject),
        src,
        options,
      );
      addDosaiProperties(
        component,
        cryptoObject,
        cryptoObject.OperationType ? "operation" : "asset",
      );
      componentsByRef.set(bomRef, component);
    }
  }
  for (const material of dosaiCrypto.Materials || []) {
    if (!material.Id) {
      continue;
    }
    const cdxMaterialType = dosaiMaterialCryptoType(material.MaterialType);
    const bomRef = cryptoMaterialBomRef(material.Id, material.MaterialType);
    const materialName =
      material.Name || material.Id || `dosai-${material.MaterialType}`;
    const component = componentsByRef.get(bomRef) || {
      type: "cryptographic-asset",
      name: materialName,
      "bom-ref": bomRef,
      cryptoProperties: {
        assetType: "related-crypto-material",
        relatedCryptoMaterialProperties: {
          type: cdxMaterialType,
          ...(material.Fingerprint ? { id: material.Fingerprint } : {}),
        },
      },
      properties: [],
    };
    mergeAlgorithmComponentUsage(
      component,
      dosaiCryptoUsage(material),
      src,
      options,
    );
    addDosaiProperties(component, material, "material");
    componentsByRef.set(bomRef, component);
  }
  const components = Array.from(componentsByRef.values());
  components.forEach((component) => {
    normalizeCryptoComponentEvidence(component, options);
  });
  return components.sort((left, right) =>
    `${left.name}:${left["bom-ref"]}`.localeCompare(
      `${right.name}:${right["bom-ref"]}`,
    ),
  );
}

/**
 * Find crypto algorithm in the given code snippet
 *
 * @param {string} code Code snippet
 * @returns {Array} Arary of crypto algorithm objects with oid and description
 */
export function findCryptoAlgos(code) {
  const cleanCode = cleanStr(code);
  const cryptoAlgos = [];
  for (const algoName of Object.keys(cbomCryptoOids)) {
    if (cleanCode.includes(cleanStr(algoName))) {
      cryptoAlgos.push({
        ...cbomCryptoOids[algoName],
        name: algoName,
        ref: `crypto/algorithm/${algoName}@${cbomCryptoOids[algoName].oid}`,
      });
    }
  }
  return cryptoAlgos;
}
