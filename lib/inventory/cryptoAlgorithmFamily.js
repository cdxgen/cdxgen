// Maps cdxgen's detected cryptographic-algorithm names onto the CycloneDX 1.7
// `cryptoProperties.algorithmProperties.algorithmFamily` enum and curve names
// onto the `ellipticCurve` enum, both defined in
// data/cryptography-defs.schema.json.
//
// Losing cryptographic data to satisfy an enum is the wrong trade, so an
// unmappable curve name falls back to the deprecated 1.6 free-text `curve`
// property rather than being dropped. An unmappable algorithm family is left
// unset: the algorithm is still represented by its OID/primitive, and a wrong
// family is worse than none.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { dirNameStr } from "../core/paths.js";

const cryptoDefs = JSON.parse(
  readFileSync(
    join(dirNameStr, "data", "cryptography-defs.schema.json"),
    "utf-8",
  ),
);
const ALGORITHM_FAMILIES = new Set(
  cryptoDefs.definitions.algorithmFamiliesEnum.enum,
);
const ELLIPTIC_CURVES = new Set(cryptoDefs.definitions.ellipticCurvesEnum.enum);
// The `primitive` enum lives on `algorithmProperties` in bom-1.7.schema.json.
// Source the allowed values once so a non-conforming detected primitive (for
// example a rusi "key-generation" kind) is not written into a field the schema
// constrains to a closed enum.
const bom17 = JSON.parse(
  readFileSync(join(dirNameStr, "data", "bom-1.7.schema.json"), "utf-8"),
);
const VALID_PRIMITIVES = new Set(
  bom17.definitions.cryptoProperties.properties.algorithmProperties.properties
    .primitive.enum,
);

// Every family name in its compact form, so a detected name that *is* a family
// resolves without a hand-written rule. This covers the long tail of the enum
// — MD5, RIPEMD, ARIA, Twofish, Serpent, Whirlpool and the rest — which no
// rule below mentions. Matching is exact: a name equal to a family is that
// family, no substring guessing.
const FAMILY_BY_COMPACT_NAME = new Map(
  [...ALGORITHM_FAMILIES].map((family) => [compactUpperCase(family), family]),
);

// Ordered rules for names that are not themselves a family: OID spellings,
// suffixed variants and vendor aliases. Order matters because some OID names
// combine a hash with a signature scheme (e.g. "sha256WithRSAEncryption" is
// RSA, not SHA-2). The first match wins. Compact names strip every character
// outside [A-Z0-9].
const FAMILY_RULES = [
  ["ML-DSA", (c) => c.includes("MLDSA") || c.includes("DILITHIUM")],
  ["ML-KEM", (c) => c.includes("MLKEM") || c.includes("KYBER")],
  ["SLH-DSA", (c) => c.includes("SLHDSA") || c.includes("SPHINCS")],
  ["RSASSA-PSS", (c) => c.includes("RSA") && c.includes("PSS")],
  ["RSASSA-PKCS1", (c) => c.includes("WITHRSA") || c.includes("RSASSA")],
  ["RSAES-OAEP", (c) => c.includes("RSA") && c.includes("OAEP")],
  ["RSAES-PKCS1", (c) => c.includes("RSAESPKCS1")],
  ["ECDSA", (c) => c.includes("ECDSA")],
  ["ECDH", (c) => c.includes("ECDH")],
  ["EdDSA", (c) => c.includes("EDDSA") || c === "ED25519" || c === "ED448"],
  // A digest paired with DSA names a DSA signature ("SHA256withDSA",
  // "dsaWithSha256"), not a hash of that family. OpenSSL also spells the
  // scheme with a hyphen ("DSA-SHA256", "DSA-SHA3-256"). KCDSA is a
  // different scheme and stays out.
  [
    "DSA",
    (c) =>
      !c.includes("KCDSA") &&
      (c.includes("WITHDSA") ||
        c.includes("DSAWITH") ||
        /^DSA(SHA|RIPEMD)/.test(c)),
  ],
  ["HKDF", (c) => c.includes("HKDF")],
  ["PBKDF2", (c) => c.includes("PBKDF2")],
  ["PBKDF1", (c) => c.includes("PBKDF1")],
  ["PBES2", (c) => c.includes("PBES2")],
  ["PBES1", (c) => c.includes("PBES1")],
  ["HMAC", (c) => c.includes("HMAC")],
  ["SHA-3", (c) => /SHA3\d{3}/.test(c)],
  ["SHA-2", (c) => /SHA(224|256|384|512)/.test(c) || c.includes("SHA2")],
  ["SHA-1", (c) => c === "SHA" || c.includes("SHA1")],
  ["RIPEMD", (c) => c.startsWith("RIPEMD")],
  ["ChaCha20", (c) => c.includes("CHACHA20")],
  ["ChaCha", (c) => c.includes("CHACHA")],
  ["Poly1305", (c) => c.includes("POLY1305")],
  ["BLAKE3", (c) => c.includes("BLAKE3")],
  ["BLAKE2", (c) => c.includes("BLAKE2")],
  ["AES", (c) => c.includes("AES")],
  ["3DES", (c) => c.includes("3DES") || c.includes("DESEDE")],
  ["DES", (c) => c.startsWith("DES")],
  ["DSA", (c) => c === "DSA"],
  ["SEED", (c) => c.includes("SEED")],
  ["CAMELLIA", (c) => c.includes("CAMELLIA")],
  ["GOST", (c) => c.includes("GOST")],
  ["Salsa20", (c) => c.includes("SALSA20")],
  ["Twofish", (c) => c.includes("TWOFISH")],
  ["Blowfish", (c) => c.includes("BLOWFISH")],
  ["Serpent", (c) => c.includes("SERPENT")],
  ["ARIA", (c) => c.startsWith("ARIA")],
  ["IDEA", (c) => c.startsWith("IDEA")],
  ["Whirlpool", (c) => c.includes("WHIRLPOOL")],
  ["bcrypt", (c) => c.includes("BCRYPT")],
  ["ElGamal", (c) => c.includes("ELGAMAL")],
  ["XMSS", (c) => c.startsWith("XMSS")],
  ["LMS", (c) => c.startsWith("LMS")],
  ["FFDH", (c) => c === "DH" || c.includes("DIFFIEHELLMAN")],
];

// Curve alias → canonical enum value. Every value on the right is present in
// the ellipticCurvesEnum. Aliases cover the names most commonly seen in
// libraries (RFC 8446, OpenSSL, NIST, SEC, Brainpool, Ed/Curve families).
const CURVE_ALIASES = new Map([
  ["P-192", "nist/P-192"],
  ["P192", "nist/P-192"],
  ["P-224", "nist/P-224"],
  ["P224", "nist/P-224"],
  ["P-256", "nist/P-256"],
  ["P256", "nist/P-256"],
  ["PRIME256V1", "x962/prime256v1"],
  ["SECP256R1", "secg/secp256r1"],
  ["P-384", "nist/P-384"],
  ["P384", "nist/P-384"],
  ["SECP384R1", "secg/secp384r1"],
  ["P-521", "nist/P-521"],
  ["P521", "nist/P-521"],
  ["SECP521R1", "secg/secp521r1"],
  ["SECP256K1", "secg/secp256k1"],
  ["SECP224K1", "secg/secp224k1"],
  ["SECP192K1", "secg/secp192k1"],
  ["ED25519", "other/Ed25519"],
  ["ED448", "other/Ed448"],
  ["CURVE25519", "other/Curve25519"],
  ["X25519", "other/Curve25519"],
  ["CURVE448", "other/Curve448"],
  ["X448", "other/Curve448"],
  ["BRAINPOOLP256R1", "brainpool/brainpoolP256r1"],
  ["BRAINPOOLP384R1", "brainpool/brainpoolP384r1"],
  ["BRAINPOOLP512R1", "brainpool/brainpoolP512r1"],
  ["BRAINPOOLP256T1", "brainpool/brainpoolP256t1"],
  ["BRAINPOOLP384T1", "brainpool/brainpoolP384t1"],
  ["BRAINPOOLP512T1", "brainpool/brainpoolP512t1"],
  ["SM2", "oscaa/SM2"],
  ["BLS12381", "bls/BLS12-381"],
  ["BLS12-381", "bls/BLS12-381"],
  ["BLS12377", "bls/BLS12-377"],
  ["BLS12-377", "bls/BLS12-377"],
  ["BN254", "bn/bn254"],
  ["BN254G1", "bn/bn254"],
  ["JUBJUB", "other/JubJub"],
  ["BANDERSNATCH", "bls/Bandersnatch"],
  ["PALLAS", "other/Pallas"],
  ["VESTA", "other/Vesta"],
]);

function compactUpperCase(name) {
  return String(name || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

/**
 * Resolve a detected algorithm name to a CycloneDX 1.7 `algorithmFamily` enum
 * value. Returns undefined when no rule matches, so the caller can leave the
 * field unset rather than emitting an invalid value.
 *
 * @param {string} name Detected or OID algorithm name
 * @returns {string|undefined} A valid algorithmFamily enum value, or undefined
 */
export function resolveAlgorithmFamily(name) {
  const compact = compactUpperCase(name);
  if (!compact) {
    return undefined;
  }
  // A name that already is a family wins, whatever its spelling ("AES",
  // "ml-dsa", "Whirlpool").
  if (ALGORITHM_FAMILIES.has(name)) {
    return name;
  }
  const exact = FAMILY_BY_COMPACT_NAME.get(compact);
  if (exact) {
    return exact;
  }
  for (const [family, matches] of FAMILY_RULES) {
    if (matches(compact)) {
      return family;
    }
  }
  return undefined;
}

/**
 * Resolve a curve name to the CycloneDX 1.7 `ellipticCurve` enum. When the
 * name cannot be mapped to the enum, the deprecated 1.6 free-text `curve`
 * property is returned instead so the cryptographic fact is preserved.
 *
 * @param {string} curveName Detected curve name
 * @returns {Object} `{ ellipticCurve }` when mappable, `{ curve }` when only
 *   the deprecated free-text form is available, or `{}` when no curve is named.
 */
export function resolveEllipticCurve(curveName) {
  const raw = String(curveName || "").trim();
  if (!raw) {
    return {};
  }
  if (ELLIPTIC_CURVES.has(raw)) {
    return { ellipticCurve: raw };
  }
  const compact = compactUpperCase(raw);
  const aliased = CURVE_ALIASES.get(compact);
  if (aliased) {
    return { ellipticCurve: aliased };
  }
  // Fallback: keep the curve fact via the deprecated free-text property rather
  // than dropping it. Ref: cryptography-defs.schema.json marks `curve` as
  // deprecated in favour of `ellipticCurve`.
  return { curve: raw };
}

/**
 * Apply resolved algorithm-family and curve properties to a cryptographic
 * component's `cryptoProperties.algorithmProperties`. The component is mutated
 * in place; the primitive is preserved when already set.
 *
 * @param {Object} component A CycloneDX cryptographic-asset component
 * @param {Object} context Detected context
 * @param {string} [context.name] Algorithm name used to resolve the family
 * @param {string} [context.primitive] Cryptographic primitive (e.g. "signature")
 * @param {string} [context.curve] Curve name to resolve
 * @returns {Object} The mutated component
 */
export function applyAlgorithmProperties(component, context = {}) {
  if (!component || typeof component !== "object") {
    return component;
  }
  component.cryptoProperties = component.cryptoProperties || {};
  const cryptoProps = component.cryptoProperties;
  if (cryptoProps.assetType !== "algorithm") {
    return component;
  }
  cryptoProps.algorithmProperties = cryptoProps.algorithmProperties || {};
  const algoProps = cryptoProps.algorithmProperties;
  if (context.primitive && !algoProps.primitive) {
    algoProps.primitive = context.primitive;
  }
  // The schema closes `primitive` to a fixed enum; a collector may have written
  // a free-form value (e.g. a rusi "key-generation" kind). Drop a non-conforming
  // value from the structured field; collectors keep the raw value on a
  // property (`cdx:crypto:primitive`, `cdx:rusi:crypto:kind`), which is not
  // enum-constrained, so the detection is recorded either way.
  if (algoProps.primitive && !VALID_PRIMITIVES.has(algoProps.primitive)) {
    delete algoProps.primitive;
  }
  if (!algoProps.algorithmFamily) {
    const family = resolveAlgorithmFamily(context.name || component.name);
    if (family) {
      algoProps.algorithmFamily = family;
    }
  }
  const curveResolution = resolveEllipticCurve(context.curve);
  if (curveResolution.ellipticCurve && !algoProps.ellipticCurve) {
    algoProps.ellipticCurve = curveResolution.ellipticCurve;
  } else if (curveResolution.curve && !algoProps.curve) {
    algoProps.curve = curveResolution.curve;
  }
  return component;
}
