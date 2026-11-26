import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DEBUG_MODE } from "../core/activity.js";
import { compareCodeUnits } from "../core/compare.js";
import { thoughtLog } from "../core/logger.js";
import { dirNameStr } from "../core/paths.js";
import { detectJsCryptoInventory } from "./analyzer.js";
import { applyAlgorithmProperties } from "./cryptoAlgorithmFamily.js";
import { appendUnique, appendUniqueProperty } from "./depsUtils.js";
import { analyzeDosaiCrypto } from "./dosai.js";
import {
  convertOSQueryResults,
  createOccurrenceEvidence,
  formatOccurrenceEvidence,
} from "./evidenceUtils.js";

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
export function collectOSCryptoLibs(options, executeOsQueryFn) {
  let osPkgsList = [];
  // `executeOsQueryFn` is injected from a layer above stages. A caller that
  // forgets to pass it should lose the OS crypto section, not abort the whole
  // SBOM part-way through post-processing.
  if (typeof executeOsQueryFn !== "function") {
    thoughtLog(
      "No osquery executor was injected, so OS crypto libraries are skipped.",
    );
    return osPkgsList;
  }
  for (const queryCategory of Object.keys(cbomosDbQueries)) {
    const queryObj = cbomosDbQueries[queryCategory];
    const results = executeOsQueryFn(queryObj.query);
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

// OpenSSL aliases and alternate spellings, lower-cased, mapped to the
// data/crypto-oid.json name that carries the same OID. The OIDs come from the
// OpenSSL object registry (crypto/objects/objects.txt), and an alias such as
// `des3` names the cipher OpenSSL resolves it to (`des-ede3-cbc`).
const OPENSSL_NAME_ALIASES = new Map([
  ["blake2b-512", "blake2b512"],
  ["blake2s-256", "blake2s256"],
  ["chacha20-poly1305", "chaCha20Poly1305"],
  ["des-ede", "des-EDE"],
  ["des-ede-ecb", "des-EDE"],
  ["des-ede3-cbc", "des-EDE3-CBC"],
  ["des3", "des-EDE3-CBC"],
  ["des3-wrap", "cms3DESwrap"],
  ["dh", "dhKeyAgreement"],
  ["ec", "ecPublicKey"],
  ["ecdh", "id-ecDH"],
  ["id-ecpublickey", "ecPublicKey"],
  ["id-smime-alg-cms3deswrap", "cms3DESwrap"],
  ["keccak-kmac-128", "kmacShake128"],
  ["keccak-kmac-256", "kmacShake256"],
  ["keccak-kmac128", "kmacShake128"],
  ["keccak-kmac256", "kmacShake256"],
  ["kmac128", "kmacShake128"],
  ["kmac256", "kmacShake256"],
  ["ripemd", "ripemd160"],
  ["ripemd-160", "ripemd160"],
  ["ripemd160withrsa", "rsaSignatureWithripemd160"],
  ["rmd160", "ripemd160"],
  ["rsa-md5", "md5WithRSAEncryption"],
  ["rsa-pss", "rsassa-pss"],
  ["rsa-ripemd160", "rsaSignatureWithripemd160"],
  ["rsa-sha1-2", "sha1WithRSA"],
  ["rsa-sha512/224", "sha512-224WithRSAEncryption"],
  ["rsa-sha512/256", "sha512-256WithRSAEncryption"],
  ["rsa-sm3", "sm3WithRSAEncryption"],
  ["sha-512/224", "sha-512/224"],
  ["sha-512/256", "sha-512/256"],
  ["sha2-224", "sha-224"],
  ["sha2-256", "sha-256"],
  ["sha2-384", "sha-384"],
  ["sha2-512", "sha-512"],
  ["sha2-512/224", "sha-512/224"],
  ["sha2-512/256", "sha-512/256"],
  ["sha512-224", "sha-512/224"],
  ["sha512-224withrsaencryption", "sha512-224WithRSAEncryption"],
  ["sha512-256", "sha-512/256"],
  ["sha512-256withrsaencryption", "sha512-256WithRSAEncryption"],
  ["shake-128", "shake128"],
  ["shake-256", "shake256"],
  ["sm3withrsaencryption", "sm3WithRSAEncryption"],
  ["sm4", "sm4-cbc"],
  ["sm4-cfb128", "sm4-cfb"],
  ["sm4-ecb", "sms4_ecb"],
  ["sm4-ofb128", "sm4-ofb"],
  ["ssl3-md5", "md5"],
  ["ssl3-sha1", "sha-1"],
  ["x448", "curveX448"],
  ...["224", "256", "384", "512"].map((bits) => [
    `rsa-sha3-${bits}`,
    `id-rsassa-pkcs1-v1_5-with-sha3-${bits}`,
  ]),
]);
// Block cipher families whose OpenSSL names are `<family>-<bits>-<mode>`,
// `<family><bits>-<mode>` or a bare `<family><bits>` (CBC), mapped to the
// table's spelling of the mode. A mode with no OID, such as AES-CTR, CFB1,
// CFB8, OCB, SIV or GCM-SIV, has no entry and stays unmapped.
const AES_TABLE_MODES = {
  cbc: "CBC",
  ccm: "CCM",
  cfb: "CFB",
  ecb: "ECB",
  gcm: "GCM",
  ofb: "OFB",
  wrap: "wrap",
  "wrap-pad": "wrap-pad",
  xts: "XTS",
};
const BLOCK_CIPHER_TABLE_NAMES = {
  aes: (bits, mode) =>
    Object.hasOwn(AES_TABLE_MODES, mode)
      ? `aes${bits}-${AES_TABLE_MODES[mode]}`
      : undefined,
  aria: (bits, mode) => `aria${bits}-${mode}`,
  camellia: (bits, mode) => `camellia${bits}-${mode}`,
};
const BLOCK_CIPHER_KEY_BITS = new Set(["128", "192", "256"]);
const RSA_SHA_BITS = new Set(["1", "224", "256", "384", "512"]);
const HKDF_TABLE_NAMES = {
  256: "hkdfWithSha256",
  384: "hkdfWithSha384",
  512: "hkdfWithSha512",
};

function rsaSignatureTableName(bits) {
  if (!RSA_SHA_BITS.has(bits)) {
    return undefined;
  }
  // The table names the SHA-1 scheme (1.2.840.113549.1.1.5) differently.
  return bits === "1"
    ? "sha1-with-rsa-signature"
    : `sha${bits}WithRSAEncryption`;
}

function blockCipherTableName(lowerName) {
  const cipherName = lowerName.startsWith("id-")
    ? lowerName.slice(3)
    : lowerName;
  for (const [family, tableName] of Object.entries(BLOCK_CIPHER_TABLE_NAMES)) {
    if (!cipherName.startsWith(family)) {
      continue;
    }
    let rest = cipherName.slice(family.length);
    if (rest.startsWith("-")) {
      rest = rest.slice(1);
    }
    const bits = rest.slice(0, 3);
    const modePart = rest.slice(3);
    if (!BLOCK_CIPHER_KEY_BITS.has(bits)) {
      return undefined;
    }
    let mode;
    if (modePart === "") {
      mode = "cbc";
    } else if (modePart.startsWith("-")) {
      mode = modePart.slice(1);
    } else {
      return undefined;
    }
    const candidate = tableName(bits, mode);
    return candidate && cbomCryptoOids[candidate] ? candidate : undefined;
  }
  return undefined;
}

/**
 * Map the OpenSSL algorithm names that Node.js crypto accepts
 * (`aes-256-gcm`, `id-aes256-GCM`, `camellia-128-cbc`, `RSA-SHA256`,
 * `sha1WithRSAEncryption`, `ec`, `des3`) to the names of
 * data/crypto-oid.json.
 *
 * @param {string} lowerName Lower-cased algorithm name
 * @returns {string|undefined} The table name, or undefined
 */
function normalizeOpenSslAlgorithmName(lowerName) {
  const aliasName = OPENSSL_NAME_ALIASES.get(lowerName);
  if (aliasName) {
    return aliasName;
  }
  const cipherName = blockCipherTableName(lowerName);
  if (cipherName) {
    return cipherName;
  }
  const parts = lowerName.split("-");
  if (parts.length === 2 && parts[0] === "rsa" && parts[1].startsWith("sha")) {
    return rsaSignatureTableName(parts[1].slice(3));
  }
  const compactName = lowerName.replaceAll("-", "");
  const rsaSuffix = "withrsaencryption";
  if (compactName.startsWith("sha") && compactName.endsWith(rsaSuffix)) {
    return rsaSignatureTableName(compactName.slice(3, -rsaSuffix.length));
  }
  return undefined;
}

function webCryptoHashBits(hash) {
  const compactHash = String(hash || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  return /^SHA(1|224|256|384|512)$/.test(compactHash)
    ? compactHash.slice(3)
    : undefined;
}

/**
 * Map a WebCrypto algorithm name, with the hash and key length its algorithm
 * object names, to a name of data/crypto-oid.json. `ECDSA` without a hash is
 * a key, and with one a signature scheme.
 *
 * @param {string} upperName Upper-cased algorithm name
 * @param {number|undefined} keyLength Key length in bits
 * @param {string|undefined} hash Hash name, such as `SHA-256`
 * @returns {string|undefined} The table name, or undefined
 */
function normalizeWebCryptoAlgorithmName(upperName, keyLength, hash) {
  const bits = webCryptoHashBits(hash);
  switch (upperName) {
    case "ECDSA":
      return bits ? `ecdsaWithSHA${bits}` : "ecPublicKey";
    case "HKDF":
      return HKDF_TABLE_NAMES[bits];
    case "HMAC":
      return bits ? `hmacWithSHA${bits}` : undefined;
    case "RSA-OAEP":
      return "id-RSAES-OAEP";
    case "RSA-PSS":
      return "rsassa-pss";
    case "RSASSA-PKCS1-V1_5":
      return bits ? rsaSignatureTableName(bits) : "rsaEncryption";
    case "AES-KW":
      return BLOCK_CIPHER_KEY_BITS.has(String(keyLength))
        ? `aes${keyLength}-wrap`
        : undefined;
    default:
      return undefined;
  }
}

function normalizeDetectedCryptoAlgorithmName(
  name,
  primitive,
  keyLength,
  hash,
) {
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
  const webCryptoName = normalizeWebCryptoAlgorithmName(
    upperName,
    keyLength,
    hash,
  );
  if (webCryptoName && cbomCryptoOids[webCryptoName]) {
    return webCryptoName;
  }
  const openSslName = normalizeOpenSslAlgorithmName(lowerName);
  if (openSslName) {
    return openSslName;
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

function cryptoAlgorithmBomRef(name, oid, parameterSetId) {
  const suffix = parameterSetId ? `-${encodeURIComponent(parameterSetId)}` : "";
  const version = `${oid || cleanStr(name) || "unknown"}${suffix}`;
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

/**
 * The parameters of a key that the algorithm name does not already state:
 * the RSA or Diffie-Hellman modulus length, a Diffie-Hellman group, or the
 * elliptic curve. Two keys of one algorithm with different parameters become
 * two components. The curve goes to ellipticCurve, the others to
 * parameterSetIdentifier.
 *
 * @param {Object} usage Detected algorithm usage
 * @returns {{id: string, parameterSetIdentifier?: string}|undefined} The parameter set
 */
function usageParameterSet(usage) {
  if (typeof usage?.modulusLength === "number") {
    const id = String(usage.modulusLength);
    return { id, parameterSetIdentifier: id };
  }
  if (
    typeof usage?.parameterSetIdentifier === "string" &&
    usage.parameterSetIdentifier
  ) {
    return {
      id: usage.parameterSetIdentifier,
      parameterSetIdentifier: usage.parameterSetIdentifier,
    };
  }
  if (typeof usage?.namedCurve === "string" && usage.namedCurve) {
    return { id: usage.namedCurve };
  }
  return undefined;
}

/**
 * Log a detected algorithm that is left out of the BOM because no OID maps
 * its name, so a skipped detection can be told apart from an unused
 * algorithm.
 *
 * @param {Set<string>} unmappedNames Distinct names skipped so far
 * @param {string} normalizedName The algorithm name without an OID
 * @param {Object} usage Detected algorithm usage
 */
function recordUnmappedAlgorithmName(unmappedNames, normalizedName, usage) {
  unmappedNames.add(normalizedName);
  thoughtLog(
    `Skipping algorithm "${normalizedName}" at ${usageLocationValue(usage) || "<unknown location>"}: no OID is known for it.`,
  );
}

function reportUnmappedAlgorithmNames(unmappedNames) {
  if (!unmappedNames.size || !DEBUG_MODE) {
    return;
  }
  const names = Array.from(unmappedNames).sort(compareCodeUnits);
  console.warn(
    `Skipped ${names.length} detected algorithm name(s) without an OID mapping: ${names.join(", ")}.`,
  );
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
  identity.methods = identity.methods || [];
  appendUnique(identity.methods, evidenceMethodKey, {
    technique: "source-code-analysis",
    confidence: 1,
    value: methodValue,
  });
  evidence.identity = identity;
  if (occurrence) {
    const occurrences = evidence.occurrences || [];
    appendUnique(occurrences, formatOccurrenceEvidence, occurrence);
    evidence.occurrences = occurrences;
  }
  component.evidence = evidence;
  return component;
}

// A stable key function, so that appendUnique() keeps one index per list.
const evidenceMethodKey = (method) =>
  JSON.stringify([method.technique, method.value]);

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
    appendUniqueProperty(properties, "internal:SrcFile", sourceFile);
  }
  if (usage.primitive) {
    appendUniqueProperty(properties, "cdx:crypto:primitive", usage.primitive);
  }
  if (usage.source) {
    const sourceType =
      usage.source === "dosai" ? undefined : `js-ast:${usage.source}`;
    if (sourceType) {
      appendUniqueProperty(properties, "cdx:crypto:sourceType", sourceType);
    }
  }
  if (locationValue) {
    appendUniqueProperty(
      properties,
      "cdx:crypto:sourceLocation",
      locationValue,
    );
  }
  if (usage.runtimeConfigurable) {
    appendUniqueProperty(properties, "cdx:crypto:runtimeConfigurable", "true");
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
  // dosai reports the post-quantum families under their generic names and no
  // generic OID exists for any of them, so the parameter set has to come from
  // the call-site context (dosai's Code field carries the source line, e.g.
  // "MLDsa.GenerateKey(MLDsaAlgorithm.MLDsa65)"). Without a parameter set the
  // asset stays unmapped and is skipped rather than emitted with a wrong OID.
  if (/^ML-?DSA$/i.test(cleanName)) {
    const parameterSet = context.match(/(?:MLDsa|ML-DSA-)(44|65|87)\b/i);
    if (parameterSet) {
      names.add(`ml-dsa-${parameterSet[1]}`);
    }
  }
  if (/^ML-?KEM$/i.test(cleanName)) {
    const parameterSet = context.match(/(?:MLKem|ML-KEM-)(512|768|1024)\b/i);
    if (parameterSet) {
      names.add(`ml-kem-${parameterSet[1]}`);
    }
  }
  if (/^SLH-?DSA$/i.test(cleanName)) {
    // .NET spells it SlhDsaSha2_128s; NIST SLH-DSA-SHA2-128s. The hash family
    // is required: SHA2 and SHAKE have distinct OIDs, so a context naming only
    // the size, such as SLH-DSA-192f, resolves to no single parameter set.
    const parameterSet = context.match(
      /(?:SlhDsa|SLH-DSA-)(SHA2|SHAKE)[-_]?(128|192|256)(s|f)\b/i,
    );
    if (parameterSet) {
      names.add(
        `slh-dsa-${parameterSet[1].toLowerCase()}-${parameterSet[2]}${parameterSet[3].toLowerCase()}`,
      );
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
    appendUniqueProperty(properties, name, value);
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

/**
 * Build cryptographic-asset components by running source-level JS crypto
 * detection over the given directory.
 *
 * @param {string} src Path to the source directory to scan.
 * @param {object} [options] Collection options forwarded to the detector and evidence normalizer.
 * @param {boolean} [options.deep] When true, perform a deep scan including nested directories.
 * @returns {Promise<Object[]>} Sorted array of cryptographic-asset component objects.
 */
export async function collectSourceCryptoComponents(src, options = {}) {
  const inventory = await detectJsCryptoInventory(src, {
    deep: Boolean(options.deep),
    exclude: options.exclude,
    noIgnore: options.noIgnore,
  });
  const componentsByRef = new Map();
  const unmappedNames = new Set();
  for (const usage of inventory.algorithms || []) {
    const normalizedName = normalizeDetectedCryptoAlgorithmName(
      usage.name,
      usage.primitive,
      usage.keyLength,
      usage.hash,
    );
    if (!normalizedName) {
      continue;
    }
    const algorithmMetadata =
      cbomCryptoOids[normalizedName] || cbomCryptoOids[usage.name];
    if (!algorithmMetadata?.oid) {
      recordUnmappedAlgorithmName(unmappedNames, normalizedName, usage);
      continue;
    }
    const componentName = normalizedName;
    const parameterSet = usageParameterSet(usage);
    const bomRef = cryptoAlgorithmBomRef(
      componentName,
      algorithmMetadata.oid,
      parameterSet?.id,
    );
    const component = componentsByRef.get(bomRef) || {
      type: "cryptographic-asset",
      name: componentName,
      "bom-ref": bomRef,
      description:
        algorithmMetadata.description ||
        `${usage.primitive || "cryptographic"} algorithm detected in source analysis`,
      cryptoProperties: {
        assetType: "algorithm",
        oid: algorithmMetadata.oid,
      },
      properties: [],
    };
    mergeAlgorithmComponentUsage(component, usage, src, options);
    if (parameterSet?.parameterSetIdentifier) {
      component.cryptoProperties.algorithmProperties ||= {};
      component.cryptoProperties.algorithmProperties.parameterSetIdentifier ||=
        parameterSet.parameterSetIdentifier;
    }
    applyAlgorithmProperties(component, {
      name: componentName,
      primitive: usage.primitive,
      curve: usage.namedCurve,
    });
    componentsByRef.set(bomRef, component);
  }
  reportUnmappedAlgorithmNames(unmappedNames);
  const components = Array.from(componentsByRef.values());
  components.forEach((component) => {
    normalizeCryptoComponentEvidence(component, options);
  });
  return components.sort((left, right) =>
    compareCodeUnits(
      `${left.name}:${left["bom-ref"]}`,
      `${right.name}:${right["bom-ref"]}`,
    ),
  );
}

/**
 * Build cryptographic-asset components from dosai crypto analysis output,
 * mapping detected algorithms, operations, and key materials into CycloneDX
 * components.
 *
 * @param {string} src Path to the source directory used for evidence attribution.
 * @param {object} [options] Collection options forwarded to the analyzer and evidence normalizer.
 * @returns {Promise<Object[]>} Sorted array of cryptographic-asset component objects (empty when dosai produces no output).
 */
export async function collectDosaiCryptoComponents(src, options = {}) {
  const dosaiCrypto = analyzeDosaiCrypto(src, options);
  if (!dosaiCrypto) {
    return [];
  }
  const componentsByRef = new Map();
  const unmappedNames = new Set();
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
        recordUnmappedAlgorithmName(
          unmappedNames,
          normalizedName || candidateName,
          dosaiCryptoUsage(cryptoObject),
        );
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
      applyAlgorithmProperties(component, {
        name: normalizedName,
        primitive: dosaiCryptoUsage(cryptoObject).primitive,
      });
      componentsByRef.set(bomRef, component);
    }
  }
  reportUnmappedAlgorithmNames(unmappedNames);
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
    compareCodeUnits(
      `${left.name}:${left["bom-ref"]}`,
      `${right.name}:${right["bom-ref"]}`,
    ),
  );
}

/**
 * Find crypto algorithm in the given code snippet
 *
 * cleanStr fuses the snippet's identifiers into one lowercase string
 * (`prepare_for_save(iv` becomes `prepareforsaveiv`), so a plain substring
 * test reads short algorithm names inside unrelated identifiers (`rsa` in
 * `for_save`). A name therefore matches only where a cleanStr word begins:
 * the snippet's start, right after any character cleanStr strips or keeps as
 * a separator, or at a lowercase-to-uppercase change in the original text
 * (`SHA256withRSA`, `HmacSHA256`, `PBKDF2WithHmacSHA256`,
 * `generateRsaKeyPair`). Boundaries are computed from the original string
 * before it is lowercased, so case changes survive the cleanStr fusion.
 * Letter/digit changes do not start a word: they added no match on any
 * reviewed form or corpus snippet, while splitting every digit-bearing
 * identifier (`md5`, `base64`) into false word starts. Fused forms the names
 * themselves are written in still match: `algorithms.AES(key)` and
 * `AESGCM(key)` yield `aes`, `AES-256-GCM` yields `aes256-GCM`,
 * `createHash("sha256")` yields `sha-256`. All-uppercase fused forms
 * (`HMACSHA256`) still hide every name but the run's first.
 *
 * @param {string} code Code snippet
 * @returns {Array} Arary of crypto algorithm objects with oid and description
 */
export function findCryptoAlgos(code) {
  if (typeof code !== "string" || !code) {
    return [];
  }
  const cleanChars = [];
  // canStart[i] is true when cleanChars[i] begins a maximal [0-9a-z] word,
  // either in the original text or at a lower-to-uppercase change in it
  const canStart = [];
  let inWord = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    const lower = ch.toLowerCase();
    const isWordChar =
      lower.length === 1 &&
      ((lower >= "0" && lower <= "9") || (lower >= "a" && lower <= "z"));
    if (isWordChar) {
      cleanChars.push(lower);
      const prev = i > 0 ? code[i - 1] : "";
      const caseStart = /[a-z]/.test(prev) && /[A-Z]/.test(ch);
      canStart.push(!inWord || caseStart);
      inWord = true;
    } else {
      inWord = false;
    }
  }
  const cleanCode = cleanChars.join("");
  const cryptoAlgos = [];
  for (const algoName of Object.keys(cbomCryptoOids)) {
    const needle = cleanStr(algoName);
    if (!needle) {
      continue;
    }
    let pos = cleanCode.indexOf(needle);
    for (; pos !== -1; pos = cleanCode.indexOf(needle, pos + 1)) {
      if (canStart[pos]) {
        cryptoAlgos.push({
          ...cbomCryptoOids[algoName],
          name: algoName,
          ref: `crypto/algorithm/${algoName}@${cbomCryptoOids[algoName].oid}`,
        });
        break;
      }
    }
  }
  return cryptoAlgos;
}
