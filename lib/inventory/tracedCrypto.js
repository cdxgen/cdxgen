import { readFileSync } from "node:fs";
import { join } from "node:path";

import { thoughtLog } from "../core/logger.js";
import { dirNameStr } from "../core/paths.js";
import {
  CertificateCollector,
  certRecordFromObservedChainEntry,
  toWellFormedText,
} from "./certificates.js";
import { applyAlgorithmProperties } from "./cryptoAlgorithmFamily.js";

const cryptoOids = JSON.parse(
  readFileSync(join(dirNameStr, "data", "crypto-oid.json"), "utf-8"),
);

// TLS key-exchange groups by their IANA registry name. A hybrid group pairs a
// classical curve with ML-KEM: each half has an OID, the pair has none, so the
// group is recorded as both algorithms.
const GROUP_ALGORITHMS = {
  X25519MLKEM768: ["x25519", "ml-kem-768"],
  SecP256r1MLKEM768: ["secp256r1", "ml-kem-768"],
  SecP384r1MLKEM1024: ["secp384r1", "ml-kem-1024"],
  X25519Kyber768Draft00: ["x25519"],
  MLKEM512: ["ml-kem-512"],
  MLKEM768: ["ml-kem-768"],
  MLKEM1024: ["ml-kem-1024"],
  x448: ["curveX448"],
};

const MLKEM_SECURITY_LEVELS = {
  "ml-kem-512": 1,
  "ml-kem-768": 3,
  "ml-kem-1024": 5,
};

// The curve each classical key-exchange algorithm is defined over.
const KEY_AGREEMENT_CURVES = {
  x25519: "x25519",
  curveX448: "x448",
};

// Closed enums of cryptoProperties.algorithmProperties in bom-1.7.schema.json.
const MODES = new Set(["cbc", "ecb", "ccm", "gcm", "cfb", "ofb", "ctr"]);
const CRYPTO_FUNCTIONS = new Set([
  "generate",
  "keygen",
  "encrypt",
  "decrypt",
  "digest",
  "tag",
  "keyderive",
  "sign",
  "verify",
  "encapsulate",
  "decapsulate",
]);

/**
 * Names the bulk cipher of a TLS cipher suite as a crypto-oid.json key, from
 * either its IANA name (TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256) or its OpenSSL
 * name (ECDHE-RSA-AES128-GCM-SHA256).
 *
 * @param {string} suiteName Cipher suite name
 * @returns {{name: string, bits: number, mode: string|undefined}|undefined} The cipher, when it has an OID
 */
export function suiteCipher(suiteName) {
  const tokens = String(suiteName || "")
    .toUpperCase()
    .split(/[-_]/);
  let cipher;
  if (tokens.includes("CHACHA20")) {
    cipher = { name: "chaCha20Poly1305", bits: 256, mode: undefined };
  } else if (tokens.includes("3DES") || tokens.includes("CBC3")) {
    cipher = { name: "des-EDE3-CBC", bits: 112, mode: "cbc" };
  } else {
    const aesIdx = tokens.findIndex((t) => t.startsWith("AES"));
    if (aesIdx < 0) {
      return undefined;
    }
    const bits =
      Number.parseInt(tokens[aesIdx].substring(3), 10) ||
      Number.parseInt(tokens[aesIdx + 1], 10);
    // OpenSSL names the _CCM_8 suites with one token ("AES128-CCM8").
    const mode =
      ["GCM", "CCM"].find(
        (m) => tokens.includes(m) || (m === "CCM" && tokens.includes("CCM8")),
      ) || "CBC";
    cipher = { name: `aes${bits}-${mode}`, bits, mode: mode.toLowerCase() };
  }
  return cryptoOids[cipher.name]?.oid ? cipher : undefined;
}

function oidKey(name) {
  if (!name) {
    return undefined;
  }
  if (cryptoOids[name]?.oid) {
    return name;
  }
  const lower = String(name).toLowerCase();
  return cryptoOids[lower]?.oid ? lower : undefined;
}

function cipherProperties(cipher) {
  const props = {
    primitive: cipher.mode === "cbc" ? "block-cipher" : "ae",
    parameterSetIdentifier: String(cipher.bits),
    cryptoFunctions: ["encrypt", "decrypt"],
    classicalSecurityLevel: cipher.bits,
  };
  if (cipher.mode) {
    props.mode = cipher.mode;
  }
  return props;
}

function keyExchangeProperties(name) {
  const level = MLKEM_SECURITY_LEVELS[name];
  if (level) {
    return {
      primitive: "kem",
      cryptoFunctions: ["keygen", "encapsulate", "decapsulate"],
      nistQuantumSecurityLevel: level,
    };
  }
  return { primitive: "key-agree", cryptoFunctions: ["keygen"] };
}

// Keeps the values of an algorithm the traced CBOM described that fit the
// schema; the primitive itself is checked by applyAlgorithmProperties.
function knownAlgorithmProperties(props) {
  const known = {};
  if (typeof props?.primitive === "string") {
    known.primitive = props.primitive === "aead" ? "ae" : props.primitive;
  }
  const mode = String(props?.mode || "").toLowerCase();
  if (MODES.has(mode)) {
    known.mode = mode;
  }
  const functions = (props?.cryptoFunctions || []).filter((f) =>
    CRYPTO_FUNCTIONS.has(f),
  );
  if (functions.length) {
    known.cryptoFunctions = functions;
  }
  for (const level of ["classicalSecurityLevel", "nistQuantumSecurityLevel"]) {
    if (Number.isInteger(props?.[level])) {
      known[level] = props[level];
    }
  }
  return known;
}

/**
 * Turns the CBOM safer-exec writes for a traced command into components that
 * cdxgen can merge and validate:
 *
 * - every asset gets a bom-ref, without which the assets merge into one
 * - algorithms carry their OID, and those without one are left out
 * - hybrid key-exchange groups become their classical and ML-KEM halves
 * - cipher suites become their bulk cipher, which the protocol's suites refer
 *   to by bom-ref
 * - algorithm properties keep only values the schema allows
 * - crypto libraries are left out: they are the traced library components,
 *   marked with cdx:dynamic:cryptoLibrary
 *
 * @param {Object[]} cbomComponents Components of the safer-exec CBOM
 * @returns {Object[]} Normalized cryptographic-asset components
 */
export function normalizeTracedCryptoComponents(cbomComponents) {
  const byRef = new Map();
  const addAlgorithm = (name, algorithmProperties, curve) => {
    const oid = cryptoOids[name].oid;
    const ref = `crypto/algorithm/${encodeURIComponent(name)}@${oid}`;
    if (!byRef.has(ref)) {
      const component = {
        type: "cryptographic-asset",
        name,
        "bom-ref": ref,
        description: cryptoOids[name].description,
        cryptoProperties: {
          assetType: "algorithm",
          algorithmProperties,
          oid,
        },
      };
      applyAlgorithmProperties(component, { name, curve });
      byRef.set(ref, component);
    }
    return ref;
  };
  const protocols = [];
  for (const comp of cbomComponents || []) {
    const props = comp?.cryptoProperties;
    if (comp?.type !== "cryptographic-asset" || !props) {
      continue;
    }
    if (props.assetType === "protocol") {
      protocols.push(comp);
      continue;
    }
    if (props.assetType !== "algorithm") {
      continue;
    }
    const groupHalves = GROUP_ALGORITHMS[comp.name];
    if (groupHalves) {
      for (const half of groupHalves) {
        addAlgorithm(
          half,
          keyExchangeProperties(half),
          KEY_AGREEMENT_CURVES[half] ||
            (MLKEM_SECURITY_LEVELS[half] ? "" : half),
        );
      }
      continue;
    }
    const name = oidKey(comp.name);
    if (name) {
      addAlgorithm(
        name,
        MLKEM_SECURITY_LEVELS[name] || KEY_AGREEMENT_CURVES[name]
          ? keyExchangeProperties(name)
          : knownAlgorithmProperties(props.algorithmProperties),
        KEY_AGREEMENT_CURVES[name] ||
          (/^(secp|brainpool)/.test(name) ? name : ""),
      );
      continue;
    }
    const cipher = suiteCipher(comp.name);
    if (cipher) {
      addAlgorithm(cipher.name, cipherProperties(cipher));
      continue;
    }
    thoughtLog(`Skipping traced algorithm '${comp.name}' without an OID.`);
  }
  for (const comp of protocols) {
    const ref = `crypto/protocol/${encodeURIComponent(comp.name)}@${encodeURIComponent(comp.version || "unknown")}`;
    const protocolProperties = {
      ...comp.cryptoProperties.protocolProperties,
    };
    // The traced suites list algorithm names; the schema wants bom-refs.
    const cipherSuites = (protocolProperties.cipherSuites || []).map(
      ({ algorithms: _names, ...suite }) => {
        const cipher = suiteCipher(suite.name);
        return cipher
          ? {
              ...suite,
              algorithms: [addAlgorithm(cipher.name, cipherProperties(cipher))],
            }
          : suite;
      },
    );
    const existing = byRef.get(ref);
    if (existing) {
      const suites = existing.cryptoProperties.protocolProperties.cipherSuites;
      for (const suite of cipherSuites) {
        if (!suites.some((s) => s.name === suite.name)) {
          suites.push(suite);
        }
      }
      continue;
    }
    protocolProperties.cipherSuites = cipherSuites;
    const component = {
      type: "cryptographic-asset",
      name: comp.name,
      "bom-ref": ref,
      cryptoProperties: {
        assetType: "protocol",
        protocolProperties,
      },
    };
    if (comp.version) {
      component.version = comp.version;
    }
    byRef.set(ref, component);
  }
  return Array.from(byRef.values());
}

// safer-exec walks at most this many certificates of one server's chain
// (tlsobserve maxChainCerts); a longer array did not come from it, so only the
// first entries are read.
const MAX_CHAIN_CERTS = 10;

/**
 * The bom-ref normalizeTracedCryptoComponents gives the protocol component of
 * a negotiated TLS version: safer-exec's CBOM names it "TLSv1.2" with the
 * version the prefix leaves ("1.2").
 *
 * @param {string} protocol negotiated protocol name from the crypto result
 * @returns {string} protocol component bom-ref
 */
function tracedProtocolBomRef(protocol) {
  const name = String(protocol || "");
  const version = name.startsWith("TLSv") ? name.slice("TLSv".length) : name;
  return `crypto/protocol/${encodeURIComponent(name)}@${encodeURIComponent(version || "unknown")}`;
}

/**
 * Builds the shared certificate model for the chains servers presented in TLS
 * ≤ 1.2 handshakes, from the `chain` arrays of safer-exec's crypto result
 * (report channel, safer-exec ≥ 1.2.0; earlier releases and TLS 1.3 entries
 * carry no chain and yield nothing). The records go through the shared
 * certificate collector, so bom-refs, properties and dedup match certificates
 * found on disk. A presented chain is untrusted server input: no issuer edges
 * are inferred from it, and the certificate and public-key components link
 * through the collector as every producer's do. Each TLS protocol component
 * provides the certificates and keys presented under it — the edge safer-
 * exec's own CBOM records — which answers which servers presented a key.
 *
 * @param {Object} cryptoResult safer-exec CRYPTO result (`result.crypto`)
 * @param {Set<string>} protocolRefs bom-refs of the protocol components in the BOM;
 *   a provides edge is only emitted for a protocol that is actually present
 * @returns {{components: Object[], dependencies: Object[]}} certificate,
 *   public-key and algorithm components, and the protocol provides edges
 */
export function observedChainComponents(
  cryptoResult,
  protocolRefs = new Set(),
) {
  const collector = new CertificateCollector();
  // Protocol name -> {certSha256, spkiSha256} pairs in presentation order,
  // leaf first; sorted to refs at the end so the output never depends on the
  // connection order the engine happened to report.
  const chainEntriesByProtocol = new Map();
  // The collector keeps the first record's fields for a certSha256, so two
  // servers presenting one hash with conflicting text would otherwise make
  // the name (and bom-ref) depend on connection order; sort first.
  const ciphers = (
    Array.isArray(cryptoResult?.ciphers) ? cryptoResult.ciphers : []
  )
    .map((cipher) => [JSON.stringify(cipher) ?? "", cipher])
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, cipher]) => cipher);
  for (const cipher of ciphers) {
    const chain = cipher?.chain;
    if (!Array.isArray(chain) || chain.length === 0) {
      // safer-exec ≤ 1.1.2, or a TLS 1.3 handshake (encrypted Certificate
      // message): no chain was observed.
      continue;
    }
    const host = typeof cipher.host === "string" ? cipher.host : "";
    for (const entry of chain.slice(0, MAX_CHAIN_CERTS)) {
      const record = certRecordFromObservedChainEntry(entry, { host });
      if (record) {
        collector.addRecord(record);
      }
    }
    // A protocol name is free text from the report channel; it only reaches a
    // bom-ref through encodeURIComponent, so it must be well-formed.
    const protocol = toWellFormedText(cipher.protocol);
    if (protocol) {
      let entries = chainEntriesByProtocol.get(protocol);
      if (!entries) {
        entries = [];
        chainEntriesByProtocol.set(protocol, entries);
      }
      for (const entry of chain.slice(0, MAX_CHAIN_CERTS)) {
        const certSha256 = String(entry?.certSha256 || "").toLowerCase();
        const spkiSha256 = String(entry?.spkiSha256 || "").toLowerCase();
        if (certSha256.length === 64) {
          entries.push({ certSha256, spkiSha256 });
        }
      }
    }
  }
  const { components, dependencies } = collector.build();
  // The collector's components identify their asset by the hash in `version`
  // (certSha256 for certificates, spkiSha256 for public keys).
  const certRefBySha = new Map();
  const keyRefBySpki = new Map();
  for (const component of components) {
    const assetType = component.cryptoProperties?.assetType;
    if (assetType === "certificate") {
      certRefBySha.set(component.version, component["bom-ref"]);
    } else if (assetType === "related-crypto-material") {
      keyRefBySpki.set(component.version, component["bom-ref"]);
    }
  }
  const outputDependencies = [...dependencies];
  for (const [protocol, entries] of chainEntriesByProtocol) {
    const protocolRef = tracedProtocolBomRef(protocol);
    if (!protocolRefs.has(protocolRef)) {
      continue;
    }
    const provides = [
      ...new Set(
        entries.flatMap(({ certSha256, spkiSha256 }) => [
          certRefBySha.get(certSha256),
          keyRefBySpki.get(spkiSha256),
        ]),
      ),
    ]
      .filter((ref) => ref)
      .sort();
    if (provides.length) {
      outputDependencies.push({ ref: protocolRef, provides });
    }
  }
  outputDependencies.sort((left, right) => left.ref.localeCompare(right.ref));
  return { components, dependencies: outputDependencies };
}

/**
 * Maps the crypto libraries safer-exec reported to the paths they were loaded
 * from.
 *
 * @param {Object[]} cryptoEntries safer-exec crypto-library and crypto-cipher audit entries
 * @returns {Map<string, {name: string, version: string}>} Crypto libraries by path
 */
export function cryptoLibrariesByPath(cryptoEntries) {
  const libraries = new Map();
  for (const entry of cryptoEntries || []) {
    if (entry?.type !== "crypto-library" || !entry.path || !entry.name) {
      continue;
    }
    if (!libraries.has(entry.path)) {
      libraries.set(entry.path, {
        name: String(entry.name),
        version: entry.version ? String(entry.version) : "",
      });
    }
  }
  return libraries;
}
