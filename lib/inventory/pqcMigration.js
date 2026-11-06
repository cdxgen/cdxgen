/**
 * Post-quantum migration risk for cryptographic assets (cdxgen/cdxgen#4592).
 *
 * The facts come from data/pqc-migration.json: the classes of NIST IR 8547
 * (final, October 2026) Tables 2, 4 and 8 and section 4.1.3, plus FIPS 186-5
 * for DSA, each with its members (algorithm families, OIDs and normalised
 * names), the transition the source states and the rationale text. This
 * module classifies a component and builds the risk entry; it adds no fact of
 * its own.
 *
 * Classification of an algorithm asset (cryptoProperties.assetType
 * `algorithm`), first match wins. A hybrid combiner (primitive `combiner`) is
 * not classified: IR 8547 section 3.2.1 approves a composite scheme with one
 * approved input, so the OID of one input does not decide it.
 *
 * 1. `algorithmProperties.algorithmFamily`. A quantum-safe family (SHA-2,
 *    SHA-3, AES, ML-KEM, …) is safe, except its 112-bit members (SHA-224,
 *    SHA-512/224, SHA3-224), which are recognised by OID or name.
 * 2. `cryptoProperties.oid` (rsaEncryption, id-ecPublicKey, the RSA, ECDSA,
 *    EdDSA and DSA signature OIDs, X25519/X448, DH, …).
 * 3. The component name, lower case with only letters and digits kept
 *    ("SHA-512/224" is `sha512224`), then resolveAlgorithmFamily(name).
 *
 * A class whose members have a key family (rsa, ff, ec) is checked against
 * the minimum key size of IR 8547 Tables 2 and 4 (112 bits of classical
 * strength: RSA and finite-field 2048, elliptic curve 224). An algorithm with
 * a known smaller key, and a public or private key asset
 * (`related-crypto-material`) whose size is smaller, is classed
 * `below-minimum-strength` instead. The key size of an algorithm comes from a
 * trailing number in its name ("RSA-1024"), its `parameterSetIdentifier`
 * when that is a plausible key size (at least 512 for rsa and ff, 160 to 571
 * for ec; a digest size such as "256" on an RSA signature is not a key size)
 * or the bit size in its curve name.
 *
 * The likelihood and impact levels are the fixed per-class rating the data
 * file records. No confidence is emitted (the rating is not a measurement)
 * and no organisational fact is invented: no owner, status or responses.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { dirNameStr } from "../core/paths.js";
import { resolveAlgorithmFamily } from "./cryptoAlgorithmFamily.js";

/** Prefix of every risk refId this module derives. */
export const PQC_RISK_REF_ID_PREFIX = "risk-pqc-";

const pqcData = JSON.parse(
  readFileSync(join(dirNameStr, "data", "pqc-migration.json"), "utf-8"),
);

const QUANTUM_SAFE_FAMILIES = new Set(pqcData.quantumSafeFamilies);
const UNCLASSIFIED_PRIMITIVES = new Set(pqcData.unclassifiedPrimitives);
const BELOW_MINIMUM_CLASS = "below-minimum-strength";
const SYMMETRIC_112_CLASS = "symmetric-112-bit";
const KEY_MATERIAL_TYPES = new Set(["public-key", "private-key", "key"]);
const PLAUSIBLE_KEY_SIZES = Object.freeze({
  rsa: [512, 65536],
  ff: [512, 65536],
  ec: [160, 571],
});

function buildLookup(member) {
  const lookup = new Map();
  for (const [className, definition] of Object.entries(pqcData.classes)) {
    for (const [key, keyFamily] of Object.entries(definition[member] || {})) {
      lookup.set(key, keyFamily ? { className, keyFamily } : { className });
    }
  }
  return lookup;
}

const BY_FAMILY = buildLookup("families");
const BY_OID = buildLookup("oids");
const BY_NAME = buildLookup("names");

const isDigits = (text) =>
  typeof text === "string" &&
  text.length > 0 &&
  [...text].every((ch) => ch >= "0" && ch <= "9");

/**
 * A name in lower case with only ASCII letters and digits kept, the form the
 * `names` tables of data/pqc-migration.json use.
 *
 * @param {string} name Algorithm or key name
 * @returns {string} The compact name, empty for no name
 */
export function compactAlgorithmName(name) {
  let compact = "";
  for (const ch of `${name ?? ""}`.toLowerCase()) {
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) {
      compact += ch;
    }
  }
  return compact;
}

/** "RSA-2048" is `{base: "RSA", size: 2048}`; other names have no size. */
function splitNamedKeySize(name) {
  const text = `${name ?? ""}`;
  const index = Math.max(text.lastIndexOf("-"), text.lastIndexOf("_"));
  const tail = index > 0 ? text.slice(index + 1) : "";
  if (!isDigits(tail) || tail.length > 5) {
    return { base: text };
  }
  return { base: text.slice(0, index), size: Number(tail) };
}

function lookupCompactName(name) {
  const compact = compactAlgorithmName(name);
  return compact ? BY_NAME.get(compact) : undefined;
}

function lookupName(name) {
  const { base } = splitNamedKeySize(name);
  const byName = lookupCompactName(name) ?? lookupCompactName(base);
  if (byName) {
    return byName;
  }
  const family = resolveAlgorithmFamily(name) ?? resolveAlgorithmFamily(base);
  return family ? BY_FAMILY.get(family) : undefined;
}

/** The first run of digits in a curve name ("secg/secp192r1" is 192). */
function curveBits(curve) {
  const text = `${curve ?? ""}`;
  let digits = "";
  for (const ch of text.slice(text.lastIndexOf("/") + 1)) {
    if (ch >= "0" && ch <= "9") {
      digits += ch;
    } else if (digits) {
      break;
    }
  }
  return digits && digits.length <= 4 ? Number(digits) : undefined;
}

function plausibleKeySize(size, keyFamily) {
  const range = PLAUSIBLE_KEY_SIZES[keyFamily];
  return range && size >= range[0] && size <= range[1] ? size : undefined;
}

function algorithmKeySize(component, keyFamily) {
  const algorithm = component.cryptoProperties?.algorithmProperties || {};
  const named = splitNamedKeySize(component.name).size;
  if (named !== undefined) {
    return plausibleKeySize(named, keyFamily);
  }
  const parameterSet = `${algorithm.parameterSetIdentifier ?? ""}`;
  if (isDigits(parameterSet)) {
    return plausibleKeySize(Number(parameterSet), keyFamily);
  }
  if (keyFamily === "ec") {
    const bits = curveBits(algorithm.ellipticCurve ?? algorithm.curve);
    return bits === undefined ? undefined : plausibleKeySize(bits, keyFamily);
  }
  return undefined;
}

/** Apply the IR 8547 minimum key size to a key-family classification. */
function withStrengthCheck(match, keySize) {
  const minimumKeySize = pqcData.minimumKeySizes[match.keyFamily];
  if (keySize !== undefined && minimumKeySize && keySize < minimumKeySize) {
    return {
      className: BELOW_MINIMUM_CLASS,
      keyFamily: match.keyFamily,
      keySize,
      minimumKeySize,
    };
  }
  return { ...match };
}

function classifyAlgorithm(component) {
  const cryptoProperties = component.cryptoProperties;
  const family = cryptoProperties.algorithmProperties?.algorithmFamily;
  if (
    UNCLASSIFIED_PRIMITIVES.has(cryptoProperties.algorithmProperties?.primitive)
  ) {
    return undefined;
  }
  if (family && QUANTUM_SAFE_FAMILIES.has(family)) {
    const refined =
      BY_OID.get(cryptoProperties.oid) ?? lookupCompactName(component.name);
    return refined?.className === SYMMETRIC_112_CLASS
      ? { ...refined }
      : undefined;
  }
  const match =
    (family && BY_FAMILY.get(family)) ||
    BY_OID.get(cryptoProperties.oid) ||
    lookupName(component.name);
  if (!match) {
    return undefined;
  }
  return match.keyFamily
    ? withStrengthCheck(match, algorithmKeySize(component, match.keyFamily))
    : { ...match };
}

function classifyKey(component, algorithmsByRef) {
  const material = component.cryptoProperties.relatedCryptoMaterialProperties;
  if (!KEY_MATERIAL_TYPES.has(material?.type)) {
    return undefined;
  }
  const algorithm = algorithmsByRef.get(material.algorithmRef);
  const match = algorithm?.cryptoProperties
    ? classifyAlgorithm(algorithm)
    : lookupName(component.name);
  const keySize =
    typeof material.size === "number"
      ? material.size
      : splitNamedKeySize(component.name).size;
  if (!match?.keyFamily || keySize === undefined) {
    return undefined;
  }
  const checked = withStrengthCheck(match, keySize);
  return checked.className === BELOW_MINIMUM_CLASS ? checked : undefined;
}

/**
 * Classify one cryptographic-asset component. Algorithm assets get their
 * IR 8547 class; key assets are classified only when their size is below the
 * IR 8547 minimum (the algorithm asset carries the quantum risk).
 *
 * @param {object} component A component with cryptoProperties
 * @param {Map<string, object>} [algorithmsByRef] Components by bom-ref, to
 *   resolve a key's `algorithmRef`
 * @returns {{className: string, keyFamily?: string, keySize?: number, minimumKeySize?: number}|undefined}
 *   The class, or undefined when the asset is quantum-safe or unclassified
 */
export function classifyPqcCryptoAsset(component, algorithmsByRef = new Map()) {
  const assetType = component?.cryptoProperties?.assetType;
  if (assetType === "algorithm") {
    return classifyAlgorithm(component);
  }
  if (assetType === "related-crypto-material") {
    return classifyKey(component, algorithmsByRef);
  }
  return undefined;
}

function flattenComponents(components, into = []) {
  for (const component of Array.isArray(components) ? components : []) {
    if (component && typeof component === "object") {
      into.push(component);
      flattenComponents(component.components, into);
    }
  }
  return into;
}

/**
 * Build the risks.risks[] entries for the quantum-vulnerable and weak
 * cryptographic assets of a 1.x-shaped internal BOM: one per asset with a
 * bom-ref (an asset without one could not be referenced from `affects`), in
 * component order, unique by refId.
 *
 * @param {object} internalBom The internal model
 * @returns {object[]} Risk entries shaped for the draft's
 *   #/$defs/cyclonedx-risk-2.0/$defs/risk; empty when nothing is at risk
 */
export function collectPqcRisks(internalBom) {
  const components = flattenComponents(internalBom?.components);
  const byRef = new Map();
  for (const component of components) {
    if (typeof component["bom-ref"] === "string") {
      byRef.set(component["bom-ref"], component);
    }
  }
  const risks = [];
  const seen = new Set();
  for (const component of components) {
    const bomRef = component["bom-ref"];
    if (typeof bomRef !== "string" || !bomRef.length) {
      continue;
    }
    const classification = classifyPqcCryptoAsset(component, byRef);
    const refId = `${PQC_RISK_REF_ID_PREFIX}${bomRef}`;
    if (classification && !seen.has(refId)) {
      seen.add(refId);
      risks.push(buildRiskEntry(component, classification, refId));
    }
  }
  return risks;
}

const fillTemplate = (template, values) =>
  Object.entries(values).reduce(
    (text, [key, value]) => text.split(`{${key}}`).join(`${value}`),
    template,
  );

const PROPERTY_FIELDS = Object.freeze([
  ["deprecatedAfter", "cdx:crypto:pqc:deprecatedAfter"],
  ["disallowedAfter", "cdx:crypto:pqc:disallowedAfter"],
  ["disallowedIn", "cdx:crypto:pqc:disallowedIn"],
  ["transition", "cdx:crypto:pqc:transition"],
  ["source", "cdx:crypto:pqc:source"],
]);

function buildRiskEntry(component, classification, refId) {
  const definition = pqcData.classes[classification.className];
  const label =
    typeof component.name === "string" && component.name.length
      ? component.name
      : component.cryptoProperties?.algorithmProperties?.algorithmFamily ||
        "algorithm";
  const properties = [
    { name: "cdx:crypto:pqc:class", value: classification.className },
  ];
  for (const [field, name] of PROPERTY_FIELDS) {
    if (definition[field]) {
      properties.push({ name, value: definition[field] });
    }
  }
  return {
    refId,
    name: `${definition.riskName}: ${label}`,
    statement: definition.statement,
    domains: [{ type: "security" }],
    affects: [component["bom-ref"]],
    inherentRisk: {
      likelihood: { level: definition.likelihood },
      impacts: [{ level: definition.impact }],
      rationale: fillTemplate(definition.rationale, {
        algorithm: label,
        size: classification.keySize,
        minimum: classification.minimumKeySize,
      }),
    },
    properties,
    externalReferences: [
      { type: "documentation", url: definition.url || pqcData.source.url },
    ],
  };
}
