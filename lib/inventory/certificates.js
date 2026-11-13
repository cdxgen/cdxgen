// Certificate identity model shared by every cdxgen producer: the
// trustinspector rootfs/host reports, the source-directory scan, and (later)
// observed TLS chains. One certificate is one component wherever it appears,
// keyed by its whole-DER SHA-256; one public key is one component keyed by
// its SPKI SHA-256, so cross-signed twins share it. Design contract:
// ~/work/cbom-cert-distrust/PLAN.md section 2.

import { createHash, X509Certificate } from "node:crypto";
import { basename } from "node:path";

import { parseAllDocuments } from "yaml";

import { thoughtLog } from "../core/logger.js";
import { sanitizeBomUrl } from "../core/propertySanitizer.js";
import { xml2js } from "../parsers/xml.js";

// Post-quantum algorithms are named from their OIDs because the toolchains
// disagree: Go 1.26 prints ML-DSA, SLH-DSA and ML-KEM as "0", Go 1.27 knows
// only ML-DSA, and a Node linked against a system OpenSSL 3.0 cannot load the
// keys at all. OIDs and levels: RFC 9881 (ML-DSA, FIPS 204), RFC 9909
// (SLH-DSA, FIPS 205), RFC 9935 (ML-KEM, FIPS 203), NIST FIPS 204/205
// security categories. Composite ML-DSA is deliberately absent until its RFC
// is published; those OIDs stay dotted-OID names.
const PQ_ALGORITHM_BY_OID = {
  "2.16.840.1.101.3.4.3.17": ["ML-DSA-44", "signature", "44", 2],
  "2.16.840.1.101.3.4.3.18": ["ML-DSA-65", "signature", "65", 3],
  "2.16.840.1.101.3.4.3.19": ["ML-DSA-87", "signature", "87", 5],
  "2.16.840.1.101.3.4.3.20": ["SLH-DSA-SHA2-128s", "signature", "SHA2-128s", 1],
  "2.16.840.1.101.3.4.3.21": ["SLH-DSA-SHA2-128f", "signature", "SHA2-128f", 1],
  "2.16.840.1.101.3.4.3.22": ["SLH-DSA-SHA2-192s", "signature", "SHA2-192s", 3],
  "2.16.840.1.101.3.4.3.23": ["SLH-DSA-SHA2-192f", "signature", "SHA2-192f", 3],
  "2.16.840.1.101.3.4.3.24": ["SLH-DSA-SHA2-256s", "signature", "SHA2-256s", 5],
  "2.16.840.1.101.3.4.3.25": ["SLH-DSA-SHA2-256f", "signature", "SHA2-256f", 5],
  "2.16.840.1.101.3.4.3.26": [
    "SLH-DSA-SHAKE-128s",
    "signature",
    "SHAKE-128s",
    1,
  ],
  "2.16.840.1.101.3.4.3.27": [
    "SLH-DSA-SHAKE-128f",
    "signature",
    "SHAKE-128f",
    1,
  ],
  "2.16.840.1.101.3.4.3.28": [
    "SLH-DSA-SHAKE-192s",
    "signature",
    "SHAKE-192s",
    3,
  ],
  "2.16.840.1.101.3.4.3.29": [
    "SLH-DSA-SHAKE-192f",
    "signature",
    "SHAKE-192f",
    3,
  ],
  "2.16.840.1.101.3.4.3.30": [
    "SLH-DSA-SHAKE-256s",
    "signature",
    "SHAKE-256s",
    5,
  ],
  "2.16.840.1.101.3.4.3.31": [
    "SLH-DSA-SHAKE-256f",
    "signature",
    "SHAKE-256f",
    5,
  ],
  "2.16.840.1.101.3.4.4.1": ["ML-KEM-512", "kem", "512", 1],
  "2.16.840.1.101.3.4.4.2": ["ML-KEM-768", "kem", "768", 3],
  "2.16.840.1.101.3.4.4.3": ["ML-KEM-1024", "kem", "1024", 5],
};

// Classical signature OIDs to the names Go's crypto/x509 prints, so both
// producers agree (RFC 8017 for RSASSA, RFC 5480 for ECDSA, RFC 8410 for
// EdDSA).
const SIGNATURE_NAMES_BY_OID = {
  "1.2.840.113549.1.1.4": "MD5-RSA",
  "1.2.840.113549.1.1.5": "SHA1-RSA",
  "1.2.840.113549.1.1.11": "SHA256-RSA",
  "1.2.840.113549.1.1.12": "SHA384-RSA",
  "1.2.840.113549.1.1.13": "SHA512-RSA",
  "1.2.840.113549.1.1.14": "SHA224-RSA",
  "1.2.840.113549.1.1.10": "RSASSA-PSS",
  "1.2.840.10045.4.1": "ECDSA-SHA1",
  "1.2.840.10045.4.3.1": "ECDSA-SHA224",
  "1.2.840.10045.4.3.2": "ECDSA-SHA256",
  "1.2.840.10045.4.3.3": "ECDSA-SHA384",
  "1.2.840.10045.4.3.4": "ECDSA-SHA512",
  "1.3.101.112": "Ed25519",
  "1.3.101.113": "Ed448",
  "1.2.840.10040.4.3": "DSA-SHA1",
  "2.16.840.1.101.3.4.3.2": "DSA-SHA256",
};

// Public-key OIDs (RFC 8017, RFC 5480, RFC 8410, FIPS 186-4) and the curves
// that appear in SPKI parameters.
const KEY_NAMES_BY_OID = {
  "1.2.840.113549.1.1.1": "RSA",
  "1.2.840.113549.1.1.10": "RSA-PSS",
  "1.2.840.10045.2.1": "ECDSA",
  "1.2.840.10040.4.1": "DSA",
  "1.3.101.112": "Ed25519",
  "1.3.101.113": "Ed448",
};
// X9.62 prime curves (SEC 2 appendix C) and the NIST/SEC OIDs that carry
// them; bit sizes per SEC 2 section 2.
const CURVE_BITS_BY_OID = {
  "1.2.840.10045.3.1.1": 192,
  "1.2.840.10045.3.1.2": 192,
  "1.2.840.10045.3.1.3": 192,
  "1.2.840.10045.3.1.4": 239,
  "1.2.840.10045.3.1.5": 239,
  "1.2.840.10045.3.1.6": 239,
  "1.2.840.10045.3.1.7": 256,
  "1.3.132.0.10": 256,
  "1.3.132.0.33": 224,
  "1.3.132.0.34": 384,
  "1.3.132.0.35": 521,
};

// Bounded parsing: a certificate DER larger than this is rejected, and a PEM
// bundle yields at most this many certificates (the macOS system keychain
// reports 158, JDK truststores 144; large public bundles stay under 700).
const MAX_CERT_DER_BYTES = 1024 * 1024;
const MAX_PEM_CERTIFICATES = 2000;
// An OBJECT IDENTIFIER longer than this is not decoded: readOID accumulates
// a BigInt per subidentifier, so an unbounded one costs quadratic time. The
// longest form it caters for, a UUID arc (2.25.<128-bit>), is 20 content
// bytes; enterprise policy OIDs stay under 40.
const MAX_OID_BYTES = 64;
// Pairwise issuer verification is quadratic; past this many certificates in
// one collection the pass is skipped (trustinspector applies the same cap).
const ISSUER_LINK_LIMIT = 5000;
// Every certificate carrying a child's issuer name is a candidate issuer and
// one signature check costs up to milliseconds (P-521), so the checks in one
// collection are capped as well: a normal collection needs about one per
// certificate, while N same-named certificates would need N * (N - 1).
const ISSUER_VERIFY_LIMIT = 5000;
const SAN_DISPLAY_LIMIT = 20;

function isHex(value) {
  return typeof value === "string" && /^[0-9a-fA-F]+$/.test(value);
}

export function toLowerHex(value) {
  return isHex(value) ? value.toLowerCase() : undefined;
}

// A SHA-256 digest is 64 hex characters; anything else from a report is not
// a usable identity.
function toLowerSha256(value) {
  const hex = toLowerHex(value);
  return hex?.length === 64 ? hex : undefined;
}

// Serial numbers are lowercase hex with no colons and no DER zero padding
// (PLAN section 2.1); BigInt normalisation strips both.
export function normalizeSerialHex(value) {
  if (typeof value !== "string" || !/^[0-9a-fA-F]+$/.test(value)) {
    return undefined;
  }
  try {
    return BigInt(`0x${value}`).toString(16);
  } catch {
    return value.toLowerCase();
  }
}

export function serialDecimalToHex(value) {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
    return undefined;
  }
  try {
    return BigInt(value).toString(16);
  } catch {
    return undefined;
  }
}

// RFC 7468 PEM text encoding: the label on the encapsulation delimiter line
// names the type of the base64 body that follows.
const PEM_BEGIN = /-----BEGIN ([A-Z0-9 ]+)-----/;

/**
 * Split PEM text into labelled blocks without decoding them. Only the label
 * line and the matching END line matter; the caller decides which labels to
 * parse. Bounded by block count and total decoded size.
 *
 * @param {string} text file contents
 * @returns {{label: string, body: string}[]} blocks in file order
 */
export function splitPemBlocks(text) {
  if (typeof text !== "string" || !text.includes("-----BEGIN ")) {
    return [];
  }
  const blocks = [];
  const lines = text.split(/\r?\n/);
  let label;
  let body = [];
  for (const line of lines) {
    const begin = PEM_BEGIN.exec(line);
    if (begin) {
      label = begin[1];
      body = [];
      continue;
    }
    if (label && line.includes("-----END ")) {
      blocks.push({ label, body: body.join("") });
      label = undefined;
      body = [];
      continue;
    }
    if (label) {
      body.push(line.trim());
    }
    if (blocks.length >= MAX_PEM_CERTIFICATES) {
      return blocks;
    }
  }
  return blocks;
}

/**
 * Decode the CERTIFICATE blocks of a PEM bundle (RFC 7468) into DER buffers.
 * `TRUSTED CERTIFICATE` blocks (OpenSSL aux data after the DER) are not
 * decoded here; the trustinspector plugin parses their trust/reject lists.
 *
 * @param {string} text PEM file contents
 * @returns {Buffer[]} DER buffers in file order
 */
export function pemCertificateDerBlocks(text) {
  const ders = [];
  for (const block of splitPemBlocks(text)) {
    if (block.label !== "CERTIFICATE") {
      continue;
    }
    try {
      const der = Buffer.from(block.body, "base64");
      if (der.length > 0 && der.length <= MAX_CERT_DER_BYTES) {
        ders.push(der);
      }
    } catch {
      // base64 garbage between delimiters is skipped
    }
    if (ders.length >= MAX_PEM_CERTIFICATES) {
      break;
    }
  }
  return ders;
}

// Private-key PEM labels are matched by header line only; the body is never
// decoded (PLAN section 1.7). `ENCRYPTED-` prefixes the format when the
// header says so.
const PRIVATE_KEY_LABELS = new Set([
  "RSA PRIVATE KEY",
  "EC PRIVATE KEY",
  "DSA PRIVATE KEY",
  "PRIVATE KEY",
  "ENCRYPTED PRIVATE KEY",
  "OPENSSH PRIVATE KEY",
]);

export function privateKeyPemFormat(text) {
  for (const block of splitPemBlocks(text)) {
    if (!PRIVATE_KEY_LABELS.has(block.label)) {
      continue;
    }
    switch (block.label) {
      case "RSA PRIVATE KEY":
        return "RSA";
      case "EC PRIVATE KEY":
        return "EC";
      case "DSA PRIVATE KEY":
        return "DSA";
      case "PRIVATE KEY":
        return "PKCS8";
      case "ENCRYPTED PRIVATE KEY":
        return "ENCRYPTED-PKCS8";
      default:
        return "OPENSSH";
    }
  }
  return undefined;
}

/**
 * A PEM public key (RFC 7468 PUBLIC KEY label) also classifies a matched
 * file as key material rather than a certificate.
 *
 * @param {string} text file contents
 * @returns {boolean} true when a PUBLIC KEY block is present
 */
export function hasPemPublicKey(text) {
  return splitPemBlocks(text).some((block) => block.label === "PUBLIC KEY");
}

/**
 * Read one DER tag-length-value header. Multi-byte tags are rejected (none of
 * the fields walked use them). X.690 BER/DER; certificate structure per
 * RFC 5280 section 4.1.
 *
 * @param {Buffer} der input buffer
 * @param {number} offset start of the TLV
 * @param {number} end exclusive end
 * @returns {object|undefined} `{tag, start, contentStart, contentEnd, next}` or undefined on malformed input
 */
function readTLV(der, offset, end) {
  if (offset < 0 || offset + 2 > end) {
    return undefined;
  }
  const tag = der[offset];
  if ((tag & 0x1f) === 0x1f) {
    return undefined;
  }
  const firstLengthByte = der[offset + 1];
  let headerSize = 2;
  let length;
  if (firstLengthByte < 0x80) {
    length = firstLengthByte;
  } else {
    const lengthBytes = firstLengthByte & 0x7f;
    // Indefinite lengths and lengths over 4 bytes never occur in a bounded
    // certificate walk and would allow absurd skips.
    if (lengthBytes === 0 || lengthBytes > 4) {
      return undefined;
    }
    if (offset + 2 + lengthBytes > end) {
      return undefined;
    }
    length = 0;
    for (let i = 0; i < lengthBytes; i++) {
      length = length * 256 + der[offset + 2 + i];
    }
    headerSize = 2 + lengthBytes;
  }
  if (length > end - offset - headerSize) {
    return undefined;
  }
  return {
    tag,
    start: offset,
    contentStart: offset + headerSize,
    contentEnd: offset + headerSize + length,
    next: offset + headerSize + length,
  };
}

function readOID(der, start, end) {
  if (start >= end || end - start > MAX_OID_BYTES) {
    return undefined;
  }
  const arcs = [];
  // BigInt: arcs such as UUID OIDs (2.25.<128-bit>) exceed 2^53.
  let acc = 0n;
  let closed = true;
  for (let i = start; i < end; i++) {
    const byte = der[i];
    acc = acc * 128n + BigInt(byte & 0x7f);
    if (byte & 0x80) {
      closed = false;
      continue;
    }
    closed = true;
    arcs.push(acc);
    acc = 0n;
  }
  if (!closed || arcs.length === 0) {
    return undefined;
  }
  // X.690 8.19.4: the first subidentifier packs the first two arcs; the
  // first arc is at most 2, and under 2 the second can exceed 39.
  const first = arcs[0] < 40n ? 0n : arcs[0] < 80n ? 1n : 2n;
  return [first, arcs[0] - first * 40n, ...arcs.slice(1)].join(".");
}

function readAlgorithmOid(der, seq) {
  const first = readTLV(der, seq.contentStart, seq.contentEnd);
  if (first?.tag !== 0x06) {
    return undefined;
  }
  return readOID(der, first.contentStart, first.contentEnd);
}

function hexSlice(der, start, end) {
  return Buffer.from(der.buffer, der.byteOffset + start, end - start)
    .toString("hex")
    .toLowerCase();
}

/**
 * Walk a certificate DER far enough to learn what the platform parsers may
 * not report: the SubjectPublicKeyInfo (for the SPKI hash and key algorithm
 * OID), the outer signature algorithm OID, the X.509 version, the subject and
 * issuer name DER (byte equality = self-issued), and the SKI/AKI key
 * identifiers (RFC 5280 sections 4.1, 4.2.1.1, 4.2.1.2). Malformed input
 * yields undefined; nothing throws.
 *
 * @param {Buffer} der certificate DER, at most MAX_CERT_DER_BYTES
 * @returns {object|undefined} parsed fields
 */
export function parseCertificateDer(der) {
  if (
    !Buffer.isBuffer(der) ||
    der.length === 0 ||
    der.length > MAX_CERT_DER_BYTES
  ) {
    return undefined;
  }
  const certificate = readTLV(der, 0, der.length);
  if (certificate?.tag !== 0x30) {
    return undefined;
  }
  const tbs = readTLV(der, certificate.contentStart, certificate.contentEnd);
  if (tbs?.tag !== 0x30) {
    return undefined;
  }
  let cursor = tbs.contentStart;
  let version = 1;
  const maybeVersion = readTLV(der, cursor, tbs.contentEnd);
  if (maybeVersion && maybeVersion.tag === 0xa0) {
    const inner = readTLV(
      der,
      maybeVersion.contentStart,
      maybeVersion.contentEnd,
    );
    if (inner?.tag !== 0x02 || inner.contentEnd !== inner.contentStart + 1) {
      return undefined;
    }
    version = der[inner.contentStart] + 1;
    cursor = maybeVersion.next;
  }
  const serial = readTLV(der, cursor, tbs.contentEnd);
  if (serial?.tag !== 0x02) {
    return undefined;
  }
  const tbsSignature = readTLV(der, serial.next, tbs.contentEnd);
  if (tbsSignature?.tag !== 0x30) {
    return undefined;
  }
  const issuer = readTLV(der, tbsSignature.next, tbs.contentEnd);
  if (issuer?.tag !== 0x30) {
    return undefined;
  }
  const validity = readTLV(der, issuer.next, tbs.contentEnd);
  if (validity?.tag !== 0x30) {
    return undefined;
  }
  const subject = readTLV(der, validity.next, tbs.contentEnd);
  if (subject?.tag !== 0x30) {
    return undefined;
  }
  const spki = readTLV(der, subject.next, tbs.contentEnd);
  if (spki?.tag !== 0x30) {
    return undefined;
  }
  const spkiAlgorithm = readTLV(der, spki.contentStart, spki.contentEnd);
  if (spkiAlgorithm?.tag !== 0x30) {
    return undefined;
  }
  const keyAlgorithmOid = readAlgorithmOid(der, spkiAlgorithm);
  if (!keyAlgorithmOid) {
    return undefined;
  }
  // Curve parameters sit inside the AlgorithmIdentifier as its second
  // element (RFC 5480 section 2.1.1), not beside it.
  const keyOidTlv = readTLV(
    der,
    spkiAlgorithm.contentStart,
    spkiAlgorithm.contentEnd,
  );
  const keyParameters = readTLV(der, keyOidTlv.next, spkiAlgorithm.contentEnd);
  const curveOid =
    keyParameters && keyParameters.tag === 0x06
      ? readOID(der, keyParameters.contentStart, keyParameters.contentEnd)
      : undefined;
  const outerSignature = readTLV(der, tbs.next, certificate.contentEnd);
  if (outerSignature?.tag !== 0x30) {
    return undefined;
  }
  const signatureAlgorithmOid = readAlgorithmOid(der, outerSignature);
  const rsaKeyBits = rsaModulusBitLength(der, spkiAlgorithm, spki);
  const ecKeyBits = ecCurveBitsFromSpki(der, spkiAlgorithm, spki);
  // Extensions live under tbsCertificate [3]; issuer/subjectUniqueID ([1],
  // [2]) may precede them and are skipped by tag.
  let extensions;
  let walkCursor = spki.next;
  while (walkCursor < tbs.contentEnd) {
    const entry = readTLV(der, walkCursor, tbs.contentEnd);
    if (!entry) {
      break;
    }
    if (entry.tag === 0xa3) {
      extensions = entry;
    }
    walkCursor = entry.next;
  }
  let subjectKeyId;
  let authorityKeyId;
  if (extensions) {
    const parsed = parseKeyIdentifierExtensions(der, extensions);
    subjectKeyId = parsed.subjectKeyId;
    authorityKeyId = parsed.authorityKeyId;
  }
  return {
    version,
    keyAlgorithmOid,
    curveOid,
    signatureAlgorithmOid,
    rsaKeyBits,
    ecKeyBits,
    spkiDer: der.subarray(spki.start, spki.next),
    subjectDer: der.subarray(subject.start, subject.next),
    issuerDer: der.subarray(issuer.start, issuer.next),
    subjectKeyId,
    authorityKeyId,
  };
}

// RSAPublicKey ::= SEQUENCE { modulus INTEGER, publicExponent INTEGER }
// (RFC 8017 appendix A.1.1); the modulus' significant bit length is the key
// size trustinspector reports.
function rsaModulusBitLength(der, spkiAlgorithm, spki) {
  const bitString = readTLV(der, spkiAlgorithm.next, spki.contentEnd);
  if (
    bitString?.tag !== 0x03 ||
    bitString.contentStart >= bitString.contentEnd ||
    der[bitString.contentStart] !== 0
  ) {
    return undefined;
  }
  const publicKey = readTLV(
    der,
    bitString.contentStart + 1,
    bitString.contentEnd,
  );
  if (publicKey?.tag !== 0x30) {
    return undefined;
  }
  const modulus = readTLV(der, publicKey.contentStart, publicKey.contentEnd);
  if (modulus?.tag !== 0x02 || modulus.contentEnd <= modulus.contentStart) {
    return undefined;
  }
  let start = modulus.contentStart;
  while (start < modulus.contentEnd - 1 && der[start] === 0) {
    start++;
  }
  const bits = (modulus.contentEnd - start) * 8;
  const lead = der[start];
  if (lead === 0) {
    return bits;
  }
  let leadZeros = 0;
  for (let mask = 0x80; mask > 0 && !(lead & mask); mask >>= 1) {
    leadZeros++;
  }
  return bits - leadZeros;
}

// subjectKeyIdentifier (2.5.29.14) is an OCTET STRING wrapping the key
// identifier OCTET STRING; authorityKeyIdentifier (2.5.29.35) is a SEQUENCE
// whose [0] IMPLICIT field carries the identifier (RFC 5280 sections
// 4.2.1.1/4.2.1.2).
function parseKeyIdentifierExtensions(der, extensions) {
  let subjectKeyId;
  let authorityKeyId;
  const container = readTLV(
    der,
    extensions.contentStart,
    extensions.contentEnd,
  );
  if (container?.tag !== 0x30) {
    return {};
  }
  let cursor = container.contentStart;
  while (cursor < container.contentEnd) {
    const extension = readTLV(der, cursor, container.contentEnd);
    if (!extension) {
      break;
    }
    cursor = extension.next;
    if (extension.tag !== 0x30) {
      continue;
    }
    const extnID = readTLV(der, extension.contentStart, extension.contentEnd);
    if (extnID?.tag !== 0x06) {
      continue;
    }
    const oid = readOID(der, extnID.contentStart, extnID.contentEnd);
    let valueCursor = extnID.next;
    const maybeCritical = readTLV(der, valueCursor, extension.contentEnd);
    if (maybeCritical && maybeCritical.tag === 0x01) {
      valueCursor = maybeCritical.next;
    }
    const extnValue = readTLV(der, valueCursor, extension.contentEnd);
    if (extnValue?.tag !== 0x04) {
      continue;
    }
    if (oid === "2.5.29.14") {
      const inner = readTLV(der, extnValue.contentStart, extnValue.contentEnd);
      if (inner && inner.tag === 0x04) {
        subjectKeyId = hexSlice(der, inner.contentStart, inner.contentEnd);
      }
    } else if (oid === "2.5.29.35") {
      const inner = readTLV(der, extnValue.contentStart, extnValue.contentEnd);
      if (inner && inner.tag === 0x30) {
        const keyId = readTLV(der, inner.contentStart, inner.contentEnd);
        if (keyId && keyId.tag === 0x80) {
          authorityKeyId = hexSlice(der, keyId.contentStart, keyId.contentEnd);
        }
      }
    }
  }
  return { subjectKeyId, authorityKeyId };
}

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Name a key algorithm the way the BOM model requires: the post-quantum table
 * first, then classical names derived from the SPKI OID and key size, never
 * the platform's own name for an algorithm it may not know. Names agree with
 * trustinspector's (`RSA-2048`, `ECDSA-P256`, `Ed25519`, `ML-DSA-65`);
 * unknown algorithms keep their dotted OID.
 *
 * @param {object} context `{oid, curveOid, bits}` from the DER walk or report
 * @returns {string|undefined} key name such as `ML-DSA-65`, `RSA-2048`, `ECDSA-P256`
 */
/**
 * The family name for a key algorithm component: like
 * {@link keyAlgorithmName} but without the key-size suffix, so every key
 * size sharing an OID (RSA-1024 and RSA-2048, ECDSA P-256 and P-384)
 * references the same single algorithm component. Post-quantum names are
 * already family names (`ML-DSA-65`).
 *
 * @param {string} oid SPKI algorithm OID
 * @returns {string|undefined} family name such as `RSA`, `ECDSA`, `ML-DSA-65`
 */
export function keyAlgorithmFamilyName(oid) {
  const name = keyAlgorithmName({ oid });
  if (!name) {
    return undefined;
  }
  if (PQ_ALGORITHM_BY_OID[oid]) {
    return name;
  }
  const KEY_FAMILY_BY_NAME = {
    RSA: "RSA",
    "RSA-PSS": "RSA-PSS",
    ECDSA: "ECDSA",
    DSA: "DSA",
    Ed25519: "Ed25519",
    Ed448: "Ed448",
  };
  return KEY_FAMILY_BY_NAME[name.replace(/-\d+$/, "")] || name;
}

export function keyAlgorithmName(context) {
  const oid = context?.oid;
  if (!oid) {
    return undefined;
  }
  const pq = PQ_ALGORITHM_BY_OID[oid];
  if (pq) {
    return pq[0];
  }
  const bits = Number(context?.bits);
  const hasBits = Number.isInteger(bits) && bits > 0;
  if (oid === "1.2.840.113549.1.1.1" || oid === "1.2.840.113549.1.1.10") {
    return hasBits ? `RSA-${bits}` : "RSA";
  }
  if (oid === "1.2.840.10045.2.1") {
    const curveBits = context?.curveOid
      ? CURVE_BITS_BY_OID[context.curveOid]
      : undefined;
    return curveBits
      ? `ECDSA-P${curveBits}`
      : hasBits
        ? `ECDSA-P${bits}`
        : "ECDSA";
  }
  const base = KEY_NAMES_BY_OID[oid];
  if (!base) {
    return oid;
  }
  return base;
}

/**
 * Name a signature algorithm: the post-quantum table, then Go's classical
 * names, then the dotted OID. Never "0" or "unknown".
 *
 * @param {object} context `{oid}` or a trusted producer name
 * @returns {string|undefined} signature name such as `ML-DSA-65`, `SHA256-RSA`
 */
export function signatureAlgorithmName(context) {
  const oid = context?.oid;
  if (!oid) {
    return undefined;
  }
  return PQ_ALGORITHM_BY_OID[oid]?.[0] || SIGNATURE_NAMES_BY_OID[oid] || oid;
}

// The name an algorithm component carries for an OID. Key algorithms are
// named by family so one OID yields exactly one component whichever key sizes
// were seen; certificates must reference the same name.
function algorithmComponentName(oid, name) {
  const isSignatureOnly = !KEY_NAMES_BY_OID[oid] && !PQ_ALGORITHM_BY_OID[oid];
  return isSignatureOnly ? name : keyAlgorithmFamilyName(oid) || name;
}

/**
 * Metadata for an algorithm component: primitive, parameter set and NIST
 * quantum security level from the post-quantum table; classical algorithms
 * carry level 0, which is a fact, not a policy.
 *
 * @param {string} oid dotted algorithm OID
 * @param {string} kind `"signature"` or `"kem"`/key use
 * @returns {object} `{primitive, parameterSetIdentifier, nistQuantumSecurityLevel}` when known
 */
export function algorithmComponentMetadata(oid) {
  const pq = PQ_ALGORITHM_BY_OID[oid];
  if (pq) {
    return {
      primitive: pq[1],
      parameterSetIdentifier: pq[2],
      nistQuantumSecurityLevel: pq[3],
    };
  }
  if (SIGNATURE_NAMES_BY_OID[oid] || KEY_NAMES_BY_OID[oid]) {
    return { nistQuantumSecurityLevel: 0 };
  }
  return undefined;
}

function certificateBomRef(name, certSha256) {
  return `crypto/certificate/${encodeURIComponent(name)}@sha256:${certSha256}`;
}

function publicKeyBomRef(keyName, spkiSha256) {
  return `crypto/public-key/${encodeURIComponent(keyName)}@spki-sha256:${spkiSha256}`;
}

function algorithmBomRef(name, oid) {
  return `crypto/algorithm/${encodeURIComponent(name)}@${oid}`;
}

function prop(name, value) {
  return { name, value: String(value) };
}

function sortedUnique(values) {
  return [...new Set(values.filter((value) => value !== undefined))].sort();
}

// Node renders the subject as one RDN per line in certificate order; Go's
// pkix.Name.String() (the contract's format) emits the reverse order joined
// by commas. Reversing Node's lines reproduces Go's string byte for byte for
// the attributes Node exposes.
function normalizeDn(dn) {
  if (typeof dn !== "string") {
    return undefined;
  }
  const lines = dn
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) {
    return undefined;
  }
  return lines.reverse().join(",");
}

export function commonNameFromDn(dn) {
  if (typeof dn !== "string") {
    return undefined;
  }
  // Both Node's newline-per-RDN form and the joined single-line form; a
  // comma escaped per RFC 4514 ("Foo\, Inc") stays inside its value.
  const parts = dn
    .split(/\n|(?<!\\),/)
    .map((part) => part.trim().replace(/\\(.)/g, "$1"))
    .filter(Boolean);
  const cn = parts.find((part) => part.startsWith("CN="));
  if (cn) {
    return cn.slice(3);
  }
  const first = parts.find(Boolean);
  if (!first) {
    return undefined;
  }
  const eq = first.indexOf("=");
  return eq >= 0 ? first.slice(eq + 1) : first;
}

function rfc3339(date) {
  if (
    date === undefined ||
    date === null ||
    (typeof date !== "string" && !(date instanceof Date))
  ) {
    return undefined;
  }
  const parsed = date instanceof Date ? date : new Date(date.trim());
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  const iso = parsed.toISOString().replace(/\.\d{3}Z$/, "Z");
  // RFC 3339 date-time allows a four-digit year only; toISOString prints
  // expanded years as +YYYYYY/-YYYYYY, which no schema date-time accepts.
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(iso) ? iso : undefined;
}

// An uncompressed EC point is 0x04 followed by two equal-length coordinates
// (SEC 1 section 2.3.3); the coordinate length gives the curve size. Used
// when the curve OID is unknown to the table above.
function ecCurveBitsFromSpki(der, spkiAlgorithm, spki) {
  const bitString = readTLV(der, spkiAlgorithm.next, spki.contentEnd);
  if (
    bitString?.tag !== 0x03 ||
    bitString.contentStart >= bitString.contentEnd ||
    der[bitString.contentStart] !== 0
  ) {
    return undefined;
  }
  const pointLength = bitString.contentEnd - bitString.contentStart - 1;
  if (pointLength < 1 || (pointLength - 1) % 2 !== 0) {
    return undefined;
  }
  return ((pointLength - 1) / 2) * 8;
}

// ---------------------------------------------------------------------------
// Certificate records and the collector
// ---------------------------------------------------------------------------

function emptyRecord(certSha256) {
  return {
    certSha256,
    spkiSha256: undefined,
    spkiSha256Base64: undefined,
    name: undefined,
    subject: undefined,
    issuer: undefined,
    serialHex: undefined,
    version: undefined,
    isCA: undefined,
    selfSigned: undefined,
    selfSignedUnverified: undefined,
    role: undefined,
    pathLen: undefined,
    subjectKeyId: undefined,
    authorityKeyId: undefined,
    notValidBefore: undefined,
    notValidAfter: undefined,
    fileExtension: undefined,
    keyName: undefined,
    keyBits: undefined,
    keyAlgorithmOid: undefined,
    signatureAlgorithm: undefined,
    signatureAlgorithmOid: undefined,
    keyUsage: undefined,
    extKeyUsage: undefined,
    dnsNames: undefined,
    ocspServers: undefined,
    issuingCertificateUrls: undefined,
    crlDistributionPoints: undefined,
    policyOids: undefined,
    hasNameConstraints: undefined,
    trustAcceptedPurposes: undefined,
    trustRejectedPurposes: undefined,
    hostStores: undefined,
    issuers: undefined,
    issuersUnverified: undefined,
    hashes: undefined,
    algorithm: undefined,
    keyStrength: undefined,
    trustDomain: undefined,
    occurrences: [],
  };
}

/**
 * Normalise a trustinspector material (report-1 or report-2) into a
 * certificate record. Returns undefined for non-certificate kinds.
 *
 * @param {object} material trustinspector material
 * @param {object} [context] `{locationRoot}` to relativise container paths
 * @returns {object|undefined} record
 */
export function certRecordFromTrustInspector(material, context = {}) {
  if (material?.kind !== "certificate") {
    return undefined;
  }
  const certSha256 =
    toLowerSha256(material.certSha256) ||
    toLowerSha256(material.fingerprint) ||
    toLowerSha256(material.sha256);
  if (!certSha256) {
    return undefined;
  }
  const record = emptyRecord(certSha256);
  record.spkiSha256 = toLowerSha256(material.spkiSha256);
  record.spkiSha256Base64 = material.spkiSha256Base64;
  record.serialHex =
    normalizeSerialHex(material.serialHex) ||
    serialDecimalToHex(material.serial);
  record.subject =
    typeof material.subject === "string" ? material.subject : undefined;
  record.issuer =
    typeof material.issuer === "string" ? material.issuer : undefined;
  // The name is part of the bom-ref, so it comes from the subject by the rule
  // the Node reader applies, and a certificate is named alike with or without
  // the plugin. trustinspector 4.2.0 names a certificate without a CN after
  // the first RDN in DER order, its country ("ES" for
  // "OU=AC RAIZ FNMT-RCM,O=FNMT-RCM,C=ES"), where the most specific RDN names
  // it; its name is only used when the subject gives none.
  record.name =
    commonNameFromDn(record.subject || "") ||
    (typeof material.name === "string" && material.name) ||
    undefined;
  record.notValidBefore = rfc3339(material.createdAt);
  record.notValidAfter = rfc3339(material.expiresAt);
  record.fileExtension = material.fileExtension;
  record.version = material.version;
  record.isCA = typeof material.isCA === "boolean" ? material.isCA : undefined;
  record.selfSigned =
    material.selfSigned === undefined
      ? undefined
      : Boolean(material.selfSigned);
  record.selfSignedUnverified = material.selfSignedUnverified
    ? true
    : undefined;
  record.role = material.role;
  record.pathLen = material.pathLen;
  record.subjectKeyId = toLowerHex(material.subjectKeyId);
  record.authorityKeyId = toLowerHex(material.authorityKeyId);
  record.keyName = material.keyName;
  record.keyBits = material.keyBits;
  record.keyAlgorithmOid = material.keyAlgorithmOid;
  record.signatureAlgorithm = material.signatureAlgorithm;
  record.signatureAlgorithmOid = material.signatureAlgorithmOid;
  record.keyUsage = Array.isArray(material.keyUsage)
    ? [...material.keyUsage]
    : undefined;
  record.extKeyUsage = Array.isArray(material.extKeyUsage)
    ? [...material.extKeyUsage]
    : undefined;
  record.dnsNames = Array.isArray(material.dnsNames)
    ? [...material.dnsNames]
    : undefined;
  record.ocspServers = Array.isArray(material.ocspServers)
    ? [...material.ocspServers]
    : undefined;
  record.issuingCertificateUrls = Array.isArray(material.issuingCertificateUrls)
    ? [...material.issuingCertificateUrls]
    : undefined;
  record.crlDistributionPoints = Array.isArray(material.crlDistributionPoints)
    ? [...material.crlDistributionPoints]
    : undefined;
  record.policyOids = Array.isArray(material.policyOids)
    ? [...material.policyOids]
    : undefined;
  record.hasNameConstraints = material.hasNameConstraints ? true : undefined;
  record.trustAcceptedPurposes = Array.isArray(material.trustAcceptedPurposes)
    ? [...material.trustAcceptedPurposes]
    : undefined;
  record.trustRejectedPurposes = Array.isArray(material.trustRejectedPurposes)
    ? [...material.trustRejectedPurposes]
    : undefined;
  record.hostStores = Array.isArray(material.hostStores)
    ? [...material.hostStores]
    : undefined;
  record.issuers = Array.isArray(material.issuers)
    ? [...material.issuers]
    : undefined;
  record.issuersUnverified = Array.isArray(material.issuersUnverified)
    ? [...material.issuersUnverified]
    : undefined;
  record.algorithm = material.algorithm;
  record.keyStrength = material.keyStrength;
  record.trustDomain = material.trustDomain;
  // File digests describe a file, not a certificate: they only survive on a
  // single-occurrence certificate, where that one file is the cert.
  const paths =
    Array.isArray(material.paths) && material.paths.length
      ? material.paths
      : material.path
        ? [material.path]
        : [];
  if (paths.length === 1 && material.sha256) {
    record.hashes = [
      ...(material.sha1 && isHex(material.sha1)
        ? [{ alg: "SHA-1", content: material.sha1.toLowerCase() }]
        : []),
      { alg: "SHA-256", content: material.sha256.toLowerCase() },
    ];
  }
  for (const location of paths) {
    record.occurrences.push({
      location: containerRelativePath(location, context.locationRoot),
      sourceType: material.sourceType,
    });
  }
  if (Array.isArray(material.sourceTypes) && material.sourceTypes.length) {
    record.sourceTypes = [...material.sourceTypes];
  } else if (material.sourceType) {
    record.sourceTypes = [material.sourceType];
  }
  return record;
}

/**
 * Build a certificate record from a parsed certificate (Node fallback path).
 * The DER walk supplies the SPKI, algorithm OIDs, version and key
 * identifiers; the X509Certificate supplies names, validity and, on runtimes
 * that expose them, the signature algorithm. Fields the platform cannot
 * provide (key usage bits, path length) stay unset and are documented as
 * fallback limits.
 *
 * @param {Buffer} der certificate DER
 * @param {object} context `{location, sourceType, pem}`
 * @returns {object|undefined} record
 */
export function certRecordFromDer(der, context = {}) {
  const walked = parseCertificateDer(der);
  if (!walked) {
    return undefined;
  }
  const spkiSha256 = sha256Hex(walked.spkiDer);
  const record = emptyRecord(sha256Hex(der));
  record.spkiSha256 = spkiSha256;
  record.spkiSha256Base64 = createHash("sha256")
    .update(walked.spkiDer)
    .digest("base64");
  record.subjectKeyId = walked.subjectKeyId;
  record.authorityKeyId = walked.authorityKeyId;
  record.version = walked.version;
  record.keyAlgorithmOid = walked.keyAlgorithmOid;
  record.signatureAlgorithmOid = walked.signatureAlgorithmOid;
  record.der = der;
  record.walked = walked;
  let x509;
  try {
    x509 = new X509Certificate(der);
  } catch {
    x509 = undefined;
  }
  if (x509) {
    record.subject = normalizeDn(x509.subject);
    record.issuer = normalizeDn(x509.issuer);
    record.serialHex = normalizeSerialHex(x509.serialNumber);
    record.notValidBefore = rfc3339(x509.validFrom);
    record.notValidAfter = rfc3339(x509.validTo);
    record.isCA = x509.ca === undefined ? undefined : Boolean(x509.ca);
    if (typeof x509.signatureAlgorithmOid === "string") {
      record.signatureAlgorithmOid = x509.signatureAlgorithmOid;
      record.signatureAlgorithm = signatureAlgorithmName({
        oid: x509.signatureAlgorithmOid,
      });
    }
    try {
      const bits = x509.publicKey?.asymmetricKeySize;
      if (Number.isInteger(bits) && bits > 0) {
        record.keyBits = bits;
      }
    } catch {
      // The runtime cannot load this key (post-quantum on an older OpenSSL);
      // the OID-based names already carry what is known.
    }
    if (x509.subjectAltName) {
      record.dnsNames = x509.subjectAltName
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.startsWith("DNS:"))
        .map((entry) => entry.slice(4));
    }
  }
  if (!record.keyBits) {
    if (walked.rsaKeyBits) {
      record.keyBits = walked.rsaKeyBits;
    } else if (walked.keyAlgorithmOid === "1.2.840.10045.2.1") {
      // Node reports no size for EC keys; the point size carries it.
      record.keyBits = walked.ecKeyBits;
    } else if (walked.keyAlgorithmOid === "1.3.101.112") {
      // Ed25519 keys are 256 bits (RFC 8410 section 4).
      record.keyBits = 256;
    }
  }
  record.keyName = keyAlgorithmName({
    oid: record.keyAlgorithmOid,
    curveOid: walked.curveOid,
    bits: record.keyBits,
  });
  if (!record.name) {
    record.name =
      commonNameFromDn(record.subject || "") ||
      basename(String(context.location || "")) ||
      undefined;
  }
  if (!record.signatureAlgorithm) {
    record.signatureAlgorithm = signatureAlgorithmName({
      oid: record.signatureAlgorithmOid,
    });
  }
  record.x509 = x509;
  classifySelfIssued(record);
  if (context.location) {
    record.occurrences.push({
      location: context.location,
      sourceType: context.sourceType,
    });
    record.sourceTypes = context.sourceType ? [context.sourceType] : [];
  }
  return record;
}

// JSON legally carries unpaired surrogates, which encodeURIComponent (the
// bom-ref builders) rejects with URIError; a presenter's free-text fields are
// made well-formed (unpaired surrogates become U+FFFD) instead of failing
// the whole BOM.
export function toWellFormedText(value) {
  return typeof value === "string" && value ? value.toWellFormed() : undefined;
}

// Serial numbers are at most 20 octets (RFC 5280 section 4.1.2.2); a longer
// hex string is not a serial any conformant certificate carries.
const MAX_SERIAL_HEX_CHARS = 64;

/**
 * Normalise one certificate of the chain a server presented in a TLS ≤ 1.2
 * handshake, as safer-exec's crypto result relays it (leaf first). The entry
 * carries no DER: identity is the two SHA-256 digests, and the server's
 * ordering is untrusted input, so the record carries no issuer edges and no
 * SKI/AKI. Fields safer-exec already classified per PLAN section 2.5
 * (selfSigned, keyName, signatureAlgorithm) are taken as given; `role` is
 * re-derived from them with the same rule as the DER path.
 *
 * @param {object} entry safer-exec CertChainEntry
 * @param {object} [context] `{host}` the safer-exec `host:port` the chain was
 *   presented to; the occurrence `tls://<host>` is omitted without it
 * @returns {object|undefined} record, or undefined when the entry has no
 *   usable certificate hash
 */
export function certRecordFromObservedChainEntry(entry, context = {}) {
  const certSha256 = toLowerSha256(entry?.certSha256);
  if (!certSha256) {
    return undefined;
  }
  const record = emptyRecord(certSha256);
  record.spkiSha256 = toLowerSha256(entry.spkiSha256);
  record.spkiSha256Base64 =
    typeof entry.spkiSha256Base64 === "string"
      ? entry.spkiSha256Base64
      : undefined;
  record.subject = toWellFormedText(entry.subject);
  record.issuer = toWellFormedText(entry.issuer);
  // Named from the subject exactly as the DER path names it, so a CN-less
  // certificate gets one bom-ref from both producers (safer-exec's own name
  // takes the first RDN in DER order, cdxgen the first in RFC 4514 order).
  record.name =
    (record.subject && commonNameFromDn(record.subject)) ||
    toWellFormedText(entry.name);
  record.serialHex =
    typeof entry.serialNumber === "string" &&
    entry.serialNumber.length <= MAX_SERIAL_HEX_CHARS
      ? normalizeSerialHex(entry.serialNumber)
      : undefined;
  record.version = Number.isInteger(entry.version) ? entry.version : undefined;
  record.notValidBefore = rfc3339(entry.notValidBefore);
  record.notValidAfter = rfc3339(entry.notValidAfter);
  record.signatureAlgorithm = toWellFormedText(entry.signatureAlgorithm);
  record.signatureAlgorithmOid =
    typeof entry.signatureAlgorithmOid === "string" &&
    entry.signatureAlgorithmOid
      ? entry.signatureAlgorithmOid
      : undefined;
  record.keyName = toWellFormedText(entry.keyName);
  record.keyBits =
    Number.isInteger(entry.keyBits) &&
    entry.keyBits > 0 &&
    entry.keyBits <= 16384
      ? entry.keyBits
      : undefined;
  record.keyAlgorithmOid =
    typeof entry.keyAlgorithmOid === "string" && entry.keyAlgorithmOid
      ? entry.keyAlgorithmOid
      : undefined;
  record.isCA = typeof entry.isCA === "boolean" ? entry.isCA : undefined;
  record.selfSigned =
    typeof entry.selfSigned === "boolean" ? entry.selfSigned : undefined;
  record.selfSignedUnverified = entry.selfSignedUnverified ? true : undefined;
  record.role =
    record.selfSigned && (record.isCA || record.version === 1)
      ? "root"
      : record.isCA
        ? "intermediate"
        : "leaf";
  const host = typeof context.host === "string" ? context.host.trim() : "";
  if (host) {
    record.occurrences.push({
      location: `tls://${host}`,
      sourceType: "observed-tls",
    });
    record.sourceTypes = ["observed-tls"];
  }
  return record;
}

// Determine selfSigned/role per PLAN section 2.3/2.5. Signature verification
// uses the platform only inside try/catch; when it cannot check (unsupported
// algorithm, MD5), a self-issued certificate (subject DER == issuer DER, AKI
// absent or equal to SKI) still counts as self-signed and is marked
// selfSignedUnverified.
function classifySelfIssued(record) {
  const walked = record.walked;
  if (!walked) {
    return;
  }
  const selfIssued =
    walked.subjectDer.length === walked.issuerDer.length &&
    walked.subjectDer.equals(walked.issuerDer);
  let verified = false;
  let couldNotCheck = false;
  if (selfIssued && record.x509) {
    try {
      verified =
        record.x509.checkIssued(record.x509) &&
        record.x509.verify(record.x509.publicKey);
    } catch {
      // The runtime cannot check this signature (unsupported algorithm); a
      // signature that was checked and failed is NOT self-signed.
      couldNotCheck = true;
    }
  }
  let unverified = false;
  if (selfIssued && !verified && couldNotCheck) {
    // PLAN 2.5: the AKI is absent or equals the SKI.
    const keyIdsChain =
      !walked.authorityKeyId || walked.authorityKeyId === walked.subjectKeyId;
    if (keyIdsChain) {
      unverified = true;
    }
  }
  record.selfIssued = selfIssued;
  if (verified || unverified) {
    record.selfSigned = true;
    record.selfSignedUnverified = unverified && !verified ? true : undefined;
  } else {
    record.selfSigned = false;
  }
  if (record.selfSigned) {
    record.role = record.isCA || record.version === 1 ? "root" : "leaf";
  } else if (record.isCA) {
    record.role = "intermediate";
  } else {
    record.role = "leaf";
  }
}

/**
 * Pairwise issuer linking over records parsed in one collection
 * (`certRecordFromDer` output). A verified edge needs the signature to check;
 * an uncheckable signature over chained names and key identifiers goes to
 * issuersUnverified. A certificate seen more than once is linked once and
 * its other sightings get the same result. Capped at ISSUER_LINK_LIMIT
 * certificates and ISSUER_VERIFY_LIMIT signature checks; past either cap the
 * remaining records stay unlinked.
 *
 * @param {object[]} records records from certRecordFromDer
 */
export function linkFallbackIssuers(records) {
  const parsed = records.filter((record) => record?.x509 && record?.walked);
  if (parsed.length > ISSUER_LINK_LIMIT) {
    return;
  }
  // One record per certificate: another sighting of the same DER is neither
  // another candidate issuer nor another child to check.
  const firstBySha = new Map();
  for (const record of parsed) {
    if (!firstBySha.has(record.certSha256)) {
      firstBySha.set(record.certSha256, record);
    }
  }
  const parentsBySubject = new Map();
  for (const record of firstBySha.values()) {
    const subject = record.walked.subjectDer.toString("hex");
    if (!parentsBySubject.has(subject)) {
      parentsBySubject.set(subject, []);
    }
    parentsBySubject.get(subject).push(record);
  }
  let checksLeft = ISSUER_VERIFY_LIMIT;
  let budgetSpent = false;
  for (const child of firstBySha.values()) {
    const verified = [];
    const unverified = [];
    const candidates =
      parentsBySubject.get(child.walked.issuerDer.toString("hex")) || [];
    for (const parent of candidates) {
      if (parent === child) {
        continue;
      }
      const keyIdsChain =
        !child.walked.authorityKeyId ||
        !parent.walked.subjectKeyId ||
        child.walked.authorityKeyId === parent.walked.subjectKeyId;
      if (!keyIdsChain) {
        // checkIssued() rejects mismatched key identifiers too.
        continue;
      }
      if (checksLeft === 0) {
        budgetSpent = true;
        break;
      }
      checksLeft--;
      let signatureOk = false;
      let threw = false;
      try {
        signatureOk =
          child.x509.checkIssued(parent.x509) &&
          child.x509.verify(parent.x509.publicKey);
      } catch {
        threw = true;
      }
      if (signatureOk) {
        verified.push(parent.certSha256);
      } else if (threw && !child.selfIssued) {
        // Only a signature the runtime cannot check lands here; one that was
        // checked and failed means "not signed by this key" and is dropped.
        unverified.push(parent.spkiSha256);
      }
    }
    if (budgetSpent) {
      // As past ISSUER_LINK_LIMIT: this child and the ones after it stay
      // unlinked rather than carrying a partial answer.
      thoughtLog(
        `Issuer linking stopped after ${ISSUER_VERIFY_LIMIT} signature checks; the remaining certificates of this collection are left unlinked.`,
      );
      break;
    }
    child.issuers = verified.sort();
    child.fallbackUnverifiedIssuerSpkis = sortedUnique(unverified);
  }
  for (const record of parsed) {
    const first = firstBySha.get(record.certSha256);
    if (record !== first && Array.isArray(first.issuers)) {
      record.issuers = [...first.issuers];
      record.fallbackUnverifiedIssuerSpkis = [
        ...first.fallbackUnverifiedIssuerSpkis,
      ];
    }
  }
}

/**
 * Relativise a host path against a scan root so producers agree on
 * locations: `/tmp/x/rootfs/etc/ssl` with root `/tmp/x/rootfs` becomes
 * `/etc/ssl` (PLAN section 4.4, G18).
 *
 * @param {string} location host or already-relative path
 * @param {string} [root] scan root to strip
 * @returns {string} normalised container-style path
 */
export function containerRelativePath(location, root) {
  if (typeof location !== "string" || !location) {
    return undefined;
  }
  let normalized = location.replace(/\\/g, "/");
  if (root) {
    let cleanedRoot = root.replace(/\\/g, "/");
    let end = cleanedRoot.length;
    while (end > 1 && cleanedRoot[end - 1] === "/") {
      end--;
    }
    cleanedRoot = cleanedRoot.slice(0, end);
    const rootPrefix = `${cleanedRoot}/`;
    if (normalized.startsWith(rootPrefix)) {
      normalized = normalized.slice(rootPrefix.length - 1);
    }
  }
  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }
  return normalized;
}

function mergeRecords(existing, incoming, seenLocations) {
  const fieldNames = [
    "spkiSha256",
    "spkiSha256Base64",
    "subject",
    "issuer",
    "serialHex",
    "version",
    "isCA",
    "selfSigned",
    "role",
    "pathLen",
    "subjectKeyId",
    "authorityKeyId",
    "notValidBefore",
    "notValidAfter",
    "fileExtension",
    "keyName",
    "keyBits",
    "keyAlgorithmOid",
    "signatureAlgorithm",
    "signatureAlgorithmOid",
    "keyUsage",
    "extKeyUsage",
    "dnsNames",
    "ocspServers",
    "issuingCertificateUrls",
    "crlDistributionPoints",
    "policyOids",
    "hasNameConstraints",
    "trustAcceptedPurposes",
    "trustRejectedPurposes",
    "hostStores",
    "algorithm",
    "keyStrength",
    "trustDomain",
    "name",
  ];
  for (const fieldName of fieldNames) {
    if (
      existing[fieldName] === undefined &&
      incoming[fieldName] !== undefined
    ) {
      existing[fieldName] = incoming[fieldName];
    }
  }
  if (
    existing.selfSignedUnverified === undefined &&
    incoming.selfSignedUnverified
  ) {
    existing.selfSignedUnverified = incoming.selfSignedUnverified;
  }
  if (existing.issuers === undefined && Array.isArray(incoming.issuers)) {
    existing.issuers = incoming.issuers;
  } else if (
    Array.isArray(existing.issuers) &&
    Array.isArray(incoming.issuers)
  ) {
    existing.issuers = sortedUnique(existing.issuers.concat(incoming.issuers));
  }
  if (Array.isArray(incoming.fallbackUnverifiedIssuerSpkis)) {
    existing.fallbackUnverifiedIssuerSpkis = sortedUnique(
      (existing.fallbackUnverifiedIssuerSpkis || []).concat(
        incoming.fallbackUnverifiedIssuerSpkis,
      ),
    );
  }
  if (Array.isArray(incoming.issuersUnverified)) {
    existing.issuersUnverified = sortedUnique(
      (existing.issuersUnverified || []).concat(incoming.issuersUnverified),
    );
  }
  if (!existing.k8sSecretName && incoming.k8sSecretName) {
    existing.k8sSecretName = incoming.k8sSecretName;
  }
  // Insertion order is preserved (deduplicated): the report's "first"
  // sourceType stays the first.
  existing.sourceTypes = [
    ...new Set((existing.sourceTypes || []).concat(incoming.sourceTypes || [])),
  ];
  for (const occurrence of incoming.occurrences) {
    if (!seenLocations.has(occurrence.location)) {
      existing.occurrences.push(occurrence);
      seenLocations.add(occurrence.location);
    }
  }
  if (!existing.hashes?.length && incoming.hashes?.length) {
    existing.hashes = incoming.hashes;
  }
  // File digests describe one file; a certificate merged across producers
  // with several locations carries none.
  if (existing.hashes?.length && existing.occurrences.length > 1) {
    delete existing.hashes;
  }
}

function buildCertificateExtensions(record) {
  if (
    record.role === undefined &&
    !record.keyUsage?.length &&
    !record.extKeyUsage?.length
  ) {
    return undefined;
  }
  const extensions = [];
  // Extensions are only emitted when the certificate can carry them and the
  // producer observed the constraint positively: a v1 certificate has no
  // extensions at all (RFC 5280 section 4.1.2.1), and "not a CA" is not the
  // same statement as "basicConstraints says CA:FALSE".
  const isCA =
    record.role === "root" || record.role === "intermediate" || record.isCA;
  if (record.version !== 1 && isCA) {
    // RFC 5280 section 4.2.1.9.
    let value = "CA:TRUE";
    if (Number.isInteger(record.pathLen)) {
      value += `, pathlen:${record.pathLen}`;
    }
    extensions.push({
      commonExtensionName: "basicConstraints",
      commonExtensionValue: value,
    });
  }
  if (record.keyUsage?.length) {
    // RFC 5280 section 4.2.1.3 names.
    extensions.push({
      commonExtensionName: "keyUsage",
      commonExtensionValue: record.keyUsage.join(","),
    });
  }
  if (record.extKeyUsage?.length) {
    // RFC 5280 section 4.2.1.12; unknown purposes keep their dotted OID.
    extensions.push({
      commonExtensionName: "extendedKeyUsage",
      commonExtensionValue: record.extKeyUsage.join(","),
    });
  }
  if (record.subjectKeyId) {
    extensions.push({
      commonExtensionName: "subjectKeyIdentifier",
      commonExtensionValue: record.subjectKeyId,
    });
  }
  if (record.authorityKeyId) {
    extensions.push({
      commonExtensionName: "authorityKeyIdentifier",
      commonExtensionValue: record.authorityKeyId,
    });
  }
  // RFC 5280 sections 4.2.1.13 and 4.2.2.1. The URLs are text chosen by the
  // issuer and may carry a userinfo or a signed query string, so they are
  // emitted without either.
  const aia = [];
  for (const url of record.issuingCertificateUrls || []) {
    aia.push(`caIssuers=${sanitizeBomUrl(url)}`);
  }
  for (const url of record.ocspServers || []) {
    aia.push(`ocsp=${sanitizeBomUrl(url)}`);
  }
  if (aia.length) {
    extensions.push({
      commonExtensionName: "authorityInformationAccess",
      commonExtensionValue: aia.join("; "),
    });
  }
  if (record.crlDistributionPoints?.length) {
    extensions.push({
      commonExtensionName: "crlDistributionPoints",
      commonExtensionValue: record.crlDistributionPoints
        .map((url) => sanitizeBomUrl(url))
        .join(" "),
    });
  }
  if (record.policyOids?.length) {
    extensions.push({
      commonExtensionName: "certificatePolicies",
      commonExtensionValue: record.policyOids.join(","),
    });
  }
  if (record.role === "leaf" && record.dnsNames?.length) {
    const shown = record.dnsNames.slice(0, SAN_DISPLAY_LIMIT);
    const suffix =
      record.dnsNames.length > SAN_DISPLAY_LIMIT
        ? ` +${record.dnsNames.length - SAN_DISPLAY_LIMIT} more`
        : "";
    extensions.push({
      commonExtensionName: "subjectAlternativeName",
      commonExtensionValue: `${shown.join(", ")}${suffix}`,
    });
  }
  if (record.hasNameConstraints) {
    extensions.push({
      customExtensionName: "nameConstraints",
      customExtensionValue: "present",
    });
  }
  return extensions.length ? extensions : undefined;
}

function certificateComponent(
  record,
  issuerSpkis,
  unverifiedIssuerSpkis,
  publicKeyRef,
) {
  const name = record.name || "certificate";
  const ref = certificateBomRef(name, record.certSha256);
  const occurrences = record.occurrences
    .slice()
    .sort((left, right) => left.location.localeCompare(right.location));
  const extensions = buildCertificateExtensions(record);
  const signatureAlgorithmRef =
    record.signatureAlgorithmOid &&
    algorithmComponentMetadata(record.signatureAlgorithmOid)
      ? algorithmBomRef(
          algorithmComponentName(
            record.signatureAlgorithmOid,
            signatureAlgorithmName({ oid: record.signatureAlgorithmOid }),
          ),
          record.signatureAlgorithmOid,
        )
      : undefined;
  const relatedAssets = [
    ...(publicKeyRef ? [{ type: "publicKey", ref: publicKeyRef }] : []),
    ...(signatureAlgorithmRef && record.signatureAlgorithm
      ? [{ type: "algorithm", ref: signatureAlgorithmRef }]
      : []),
  ];
  const properties = [
    ...(record.spkiSha256
      ? [prop("cdx:crypto:spkiSha256", record.spkiSha256)]
      : []),
    prop("cdx:crypto:fingerprint", record.certSha256),
    ...(record.role ? [prop("cdx:crypto:certRole", record.role)] : []),
    ...(record.selfSigned === undefined
      ? []
      : [prop("cdx:crypto:selfSigned", record.selfSigned)]),
    ...(record.selfSignedUnverified
      ? [prop("cdx:crypto:selfSignedUnverified", true)]
      : []),
    ...(record.isCA === undefined
      ? []
      : [prop("cdx:crypto:isCA", record.isCA)]),
    ...(Number.isInteger(record.pathLen)
      ? [prop("cdx:crypto:pathLen", record.pathLen)]
      : []),
    ...(record.subjectKeyId
      ? [prop("cdx:crypto:subjectKeyId", record.subjectKeyId)]
      : []),
    ...(record.authorityKeyId
      ? [prop("cdx:crypto:authorityKeyId", record.authorityKeyId)]
      : []),
    ...issuerSpkis.map((spki) => prop("cdx:crypto:issuerSpkiSha256", spki)),
    ...unverifiedIssuerSpkis.map((spki) =>
      prop("cdx:crypto:unverifiedIssuerSpkiSha256", spki),
    ),
    ...(record.signatureAlgorithm
      ? [prop("cdx:crypto:signatureAlgorithm", record.signatureAlgorithm)]
      : []),
    ...(record.signatureAlgorithmOid
      ? [prop("cdx:crypto:signatureAlgorithmOid", record.signatureAlgorithmOid)]
      : []),
    ...(record.keyAlgorithmOid
      ? [prop("cdx:crypto:publicKeyAlgorithmOid", record.keyAlgorithmOid)]
      : []),
    ...(record.trustAcceptedPurposes?.length
      ? [
          prop(
            "cdx:crypto:trustAcceptedPurposes",
            record.trustAcceptedPurposes.join(","),
          ),
        ]
      : []),
    ...(record.trustRejectedPurposes?.length
      ? [
          prop(
            "cdx:crypto:trustRejectedPurposes",
            record.trustRejectedPurposes.join(","),
          ),
        ]
      : []),
    ...(record.hostStores?.length
      ? [prop("cdx:crypto:hostStore", record.hostStores.join(","))]
      : []),
    ...(record.algorithm
      ? [prop("cdx:crypto:algorithm", record.algorithm)]
      : []),
    ...(record.keyStrength
      ? [prop("cdx:crypto:keyStrength", record.keyStrength)]
      : []),
    ...(record.trustDomain
      ? [prop("cdx:crypto:trustDomain", record.trustDomain)]
      : []),
    ...(record.k8sSecretName
      ? [prop("cdx:crypto:k8sSecretName", record.k8sSecretName)]
      : []),
    ...sourceTypeProperties(record.sourceTypes),
    ...(occurrences.length
      ? [prop("internal:SrcFile", srcFileOfLocation(occurrences[0].location))]
      : []),
  ];
  const component = {
    "bom-ref": ref,
    name,
    type: "cryptographic-asset",
    version: record.certSha256,
    ...(record.hashes?.length ? { hashes: record.hashes } : {}),
    description: record.subject || occurrences[0]?.location,
    cryptoProperties: {
      assetType: "certificate",
      algorithmProperties: {
        executionEnvironment: "unknown",
        implementationPlatform: "unknown",
      },
      certificateProperties: {
        ...(record.serialHex ? { serialNumber: record.serialHex } : {}),
        ...(record.subject ? { subjectName: record.subject } : {}),
        ...(record.issuer ? { issuerName: record.issuer } : {}),
        ...(record.notValidBefore
          ? { notValidBefore: record.notValidBefore }
          : {}),
        ...(record.notValidAfter
          ? { notValidAfter: record.notValidAfter }
          : {}),
        certificateFormat: "X.509",
        ...(record.fileExtension
          ? { certificateFileExtension: record.fileExtension }
          : {}),
        fingerprint: { alg: "SHA-256", content: record.certSha256 },
        ...(relatedAssets.length
          ? { relatedCryptographicAssets: relatedAssets }
          : {}),
      },
    },
    ...(occurrences.length
      ? {
          evidence: {
            occurrences: occurrences.map(({ location }) => ({ location })),
          },
        }
      : {}),
    properties,
  };
  if (extensions?.length) {
    component.cryptoProperties.certificateProperties.certificateExtensions =
      extensions;
  }
  return component;
}

function publicKeyComponent(keyRecord) {
  const keyName = keyRecord.keyName || "public-key";
  const ref = publicKeyBomRef(keyName, keyRecord.spkiSha256);
  const algorithmRef =
    keyRecord.keyAlgorithmOid &&
    algorithmComponentMetadata(keyRecord.keyAlgorithmOid)
      ? algorithmBomRef(
          keyAlgorithmFamilyName(keyRecord.keyAlgorithmOid),
          keyRecord.keyAlgorithmOid,
        )
      : undefined;
  const occurrences = keyRecord.occurrences
    .slice()
    .sort((left, right) => left.location.localeCompare(right.location));
  const properties = [
    prop("cdx:crypto:spkiSha256", keyRecord.spkiSha256),
    ...(keyRecord.spkiSha256Base64
      ? [prop("cdx:crypto:spkiSha256Base64", keyRecord.spkiSha256Base64)]
      : []),
    ...(keyRecord.keyAlgorithmOid
      ? [prop("cdx:crypto:publicKeyAlgorithmOid", keyRecord.keyAlgorithmOid)]
      : []),
    ...sourceTypeProperties(keyRecord.sourceTypes || [keyRecord.sourceType]),
  ];
  const isPostQuantum =
    keyRecord.keyAlgorithmOid && PQ_ALGORITHM_BY_OID[keyRecord.keyAlgorithmOid];
  return {
    "bom-ref": ref,
    name: keyName,
    type: "cryptographic-asset",
    version: keyRecord.spkiSha256,
    cryptoProperties: {
      assetType: "related-crypto-material",
      relatedCryptoMaterialProperties: {
        type: "public-key",
        ...(!isPostQuantum && Number.isInteger(keyRecord.keyBits)
          ? { size: keyRecord.keyBits }
          : {}),
        format: "SPKI",
        fingerprint: { alg: "SHA-256", content: keyRecord.spkiSha256 },
        ...(keyRecord.subjectKeyId && !keyRecord.pin
          ? { id: keyRecord.subjectKeyId }
          : {}),
        ...(algorithmRef ? { algorithmRef } : {}),
      },
    },
    ...(occurrences.length
      ? {
          evidence: {
            occurrences: occurrences.map(({ location }) => ({ location })),
          },
        }
      : {}),
    properties,
  };
}

function algorithmComponent(name, oid) {
  const metadata = algorithmComponentMetadata(oid);
  return {
    "bom-ref": algorithmBomRef(name, oid),
    name,
    type: "cryptographic-asset",
    cryptoProperties: {
      assetType: "algorithm",
      oid,
      ...(metadata ? { algorithmProperties: { ...metadata } } : {}),
    },
    properties: [],
  };
}

/**
 * Collects certificate records from any producer, deduplicates them by
 * certificate SHA-256 and builds the shared component model: one certificate
 * component per certificate, one public-key component per SPKI, algorithm
 * components, and verified issuer `dependsOn` edges.
 */
export class CertificateCollector {
  constructor() {
    this.recordsBySha = new Map();
    // Seen occurrence locations per merged certificate, kept between merges
    // so a certificate found in many files (the same TLS secret in thousands
    // of manifests) deduplicates in linear, not quadratic, time.
    this.locationsBySha = new Map();
    this.pins = [];
  }

  addRecord(record) {
    if (!record?.certSha256) {
      return;
    }
    const existing = this.recordsBySha.get(record.certSha256);
    if (existing) {
      let seenLocations = this.locationsBySha.get(record.certSha256);
      if (!seenLocations) {
        seenLocations = new Set(
          existing.occurrences.map((occ) => occ.location),
        );
        this.locationsBySha.set(record.certSha256, seenLocations);
      }
      mergeRecords(existing, record, seenLocations);
    } else {
      this.recordsBySha.set(record.certSha256, record);
    }
  }

  addRecords(records) {
    for (const record of records || []) {
      this.addRecord(record);
    }
  }

  addTrustInspectorMaterials(materials, context) {
    for (const material of materials || []) {
      this.addRecord(certRecordFromTrustInspector(material, context));
    }
  }

  addPin({ spkiSha256, location }) {
    const normalized = toLowerHex(spkiSha256);
    if (normalized && location) {
      this.pins.push({ spkiSha256: normalized, location });
    }
  }

  /**
   * Build the shared model. Deterministic: components and dependency lists
   * are sorted, and no map iteration order reaches the output.
   *
   * @returns {{components: object[], dependencies: object[]}}
   */
  build() {
    const records = [...this.recordsBySha.values()];
    const bySha = this.recordsBySha;
    const components = [];
    const dependencies = [];
    const publicKeyRecords = new Map();
    // Seen occurrence locations per public key, so a key shared by many
    // certificates (a CA key every observed server presented) deduplicates
    // in linear, not quadratic, time.
    const keyRecordLocations = new Map();
    const algorithmOids = new Map();
    for (const record of records) {
      if (record.spkiSha256) {
        let keyRecord = publicKeyRecords.get(record.spkiSha256);
        if (!keyRecord) {
          keyRecord = {
            spkiSha256: record.spkiSha256,
            spkiSha256Base64: record.spkiSha256Base64,
            keyName: record.keyName,
            keyBits: record.keyBits,
            keyAlgorithmOid: record.keyAlgorithmOid,
            subjectKeyId: record.subjectKeyId,
            sourceType: "certificate",
            sourceTypes: ["certificate"],
            occurrences: [],
          };
          publicKeyRecords.set(record.spkiSha256, keyRecord);
          keyRecordLocations.set(record.spkiSha256, new Set());
        }
        if (!keyRecord.keyName && record.keyName) {
          keyRecord.keyName = record.keyName;
        }
        if (keyRecord.keyBits === undefined && record.keyBits !== undefined) {
          keyRecord.keyBits = record.keyBits;
        }
        if (!keyRecord.keyAlgorithmOid && record.keyAlgorithmOid) {
          keyRecord.keyAlgorithmOid = record.keyAlgorithmOid;
        }
        if (!keyRecord.spkiSha256Base64 && record.spkiSha256Base64) {
          keyRecord.spkiSha256Base64 = record.spkiSha256Base64;
        }
        const seenLocations = keyRecordLocations.get(record.spkiSha256);
        for (const occurrence of record.occurrences) {
          if (!seenLocations.has(occurrence.location)) {
            seenLocations.add(occurrence.location);
            keyRecord.occurrences.push(occurrence);
          }
        }
        if (record.keyAlgorithmOid) {
          algorithmOids.set(
            record.keyAlgorithmOid,
            keyAlgorithmFamilyName(record.keyAlgorithmOid) ||
              keyRecord.keyName ||
              record.keyAlgorithmOid,
          );
        }
      }
      if (record.signatureAlgorithmOid) {
        algorithmOids.set(
          record.signatureAlgorithmOid,
          signatureAlgorithmName({ oid: record.signatureAlgorithmOid }),
        );
      }
    }
    for (const pin of this.pins) {
      let keyRecord = publicKeyRecords.get(pin.spkiSha256);
      if (!keyRecord) {
        keyRecord = {
          spkiSha256: pin.spkiSha256,
          sourceType: "pin",
          sourceTypes: [],
          pin: true,
          occurrences: [],
        };
        publicKeyRecords.set(pin.spkiSha256, keyRecord);
        keyRecordLocations.set(pin.spkiSha256, new Set());
      }
      keyRecord.pin = true;
      keyRecord.sourceType = "pin";
      if (!keyRecord.sourceTypes.includes("pin")) {
        keyRecord.sourceTypes.push("pin");
      }
      const seenLocations = keyRecordLocations.get(pin.spkiSha256);
      if (!seenLocations.has(pin.location)) {
        seenLocations.add(pin.location);
        keyRecord.occurrences.push({ location: pin.location });
      }
    }
    const publicKeyRefs = new Map(
      [...publicKeyRecords.values()].map((keyRecord) => [
        keyRecord.spkiSha256,
        publicKeyBomRef(
          keyRecord.keyName || "public-key",
          keyRecord.spkiSha256,
        ),
      ]),
    );
    for (const record of records) {
      const issuerSpkis = [];
      const unverifiedSpkis = [];
      for (const issuerSha of record.issuers || []) {
        const issuer = bySha.get(issuerSha);
        if (issuer?.spkiSha256) {
          issuerSpkis.push(issuer.spkiSha256);
        }
      }
      for (const issuerSha of record.issuersUnverified || []) {
        const issuer = bySha.get(issuerSha);
        if (issuer?.spkiSha256) {
          unverifiedSpkis.push(issuer.spkiSha256);
        }
      }
      unverifiedSpkis.push(...(record.fallbackUnverifiedIssuerSpkis || []));
      components.push(
        certificateComponent(
          record,
          sortedUnique(issuerSpkis),
          sortedUnique(unverifiedSpkis),
          record.spkiSha256 ? publicKeyRefs.get(record.spkiSha256) : undefined,
        ),
      );
      const issuerRefs = sortedUnique(
        (record.issuers || [])
          .map((issuerSha) => bySha.get(issuerSha))
          .filter((issuer) => issuer)
          .map((issuer) =>
            certificateBomRef(issuer.name || "certificate", issuer.certSha256),
          ),
      );
      if (issuerRefs.length) {
        dependencies.push({
          ref: certificateBomRef(
            record.name || "certificate",
            record.certSha256,
          ),
          dependsOn: issuerRefs,
        });
      }
    }
    for (const keyRecord of publicKeyRecords.values()) {
      components.push(publicKeyComponent(keyRecord));
    }
    for (const [oid, name] of algorithmOids) {
      // An unknown OID gets no algorithm component; its OID stays a property.
      if (algorithmComponentMetadata(oid)) {
        components.push(
          algorithmComponent(algorithmComponentName(oid, name), oid),
        );
      }
    }
    components.sort((left, right) =>
      left["bom-ref"].localeCompare(right["bom-ref"]),
    );
    dependencies.sort((left, right) => left.ref.localeCompare(right.ref));
    return { components, dependencies };
  }
}

// Properties the model defines as repeatable (PLAN section 2.3): one entry
// per issuer key, so a merge keeps every value.
const REPEATABLE_PROPERTIES = new Set([
  "cdx:crypto:issuerSpkiSha256",
  "cdx:crypto:unverifiedIssuerSpkiSha256",
  "cdx:crypto:sourceType",
]);

const SOURCE_TYPE_PROPERTY = "cdx:crypto:sourceType";

/**
 * The file a certificate occurrence lives in. A Kubernetes secret occurrence
 * is `<file>#data.tls.crt` (or `#stringData.ca.crt`); the file path is what
 * internal:SrcFile records.
 *
 * @param {string} location occurrence location
 * @returns {string} file path without the secret key fragment
 */
export function srcFileOfLocation(location) {
  // Secrets are only read from YAML files, so a certificate file whose own
  // name contains "#data." keeps its full path.
  return String(location).replace(
    /(\.ya?ml)#(?:data|stringData)\.[^#/]+$/i,
    "$1",
  );
}

/**
 * One `cdx:crypto:sourceType` property per distinct producer, sorted, so the
 * value set (not the order the producers ran in) is what a BOM records.
 *
 * @param {string[]} [values] sourceType values
 * @returns {{name: string, value: string}[]} properties
 */
function sourceTypeProperties(values) {
  return [...new Set((values || []).filter(Boolean))]
    .sort()
    .map((value) => ({ name: SOURCE_TYPE_PROPERTY, value }));
}

// Collapse every sourceType property of a component into one sorted,
// deduplicated block at the position of the first.
function normalizeSourceTypeProperties(component) {
  const properties = component.properties;
  if (!Array.isArray(properties)) {
    return;
  }
  const first = properties.findIndex((p) => p?.name === SOURCE_TYPE_PROPERTY);
  if (first === -1) {
    return;
  }
  const block = sourceTypeProperties(
    properties
      .filter((p) => p?.name === SOURCE_TYPE_PROPERTY)
      .map((p) => p.value),
  );
  component.properties = [
    ...properties.slice(0, first),
    ...block,
    ...properties.slice(first).filter((p) => p?.name !== SOURCE_TYPE_PROPERTY),
  ];
}

/**
 * Index built certificate components by occurrence location, so a keystore
 * file can be linked to the certificates it holds with one lookup. A scan of
 * every component per keystore would be quadratic in a root filesystem made
 * of thousands of one-certificate keystore files.
 *
 * @param {object[]} components built components, certificates included
 * @param {(location: string) => string} [normalizeLocation] location normaliser, applied to every occurrence
 * @returns {Map<string, string[]>} sorted certificate bom-refs per location
 */
export function certificateRefsByLocation(
  components,
  normalizeLocation = (location) => location,
) {
  const refsByLocation = new Map();
  for (const component of components || []) {
    if (
      component?.cryptoProperties?.assetType !== "certificate" ||
      !component["bom-ref"]
    ) {
      continue;
    }
    const locations = new Set(
      (component.evidence?.occurrences || []).map((occurrence) =>
        normalizeLocation(occurrence.location),
      ),
    );
    for (const location of locations) {
      const refs = refsByLocation.get(location);
      if (refs) {
        refs.push(component["bom-ref"]);
      } else {
        refsByLocation.set(location, [component["bom-ref"]]);
      }
    }
  }
  for (const refs of refsByLocation.values()) {
    refs.sort();
  }
  return refsByLocation;
}

/**
 * Merge already-built certificate/public-key components that describe the
 * same asset (same bom-ref), unioning occurrences and properties. Used at the
 * final assembly step where producer component lists meet.
 *
 * @param {object[]} components component list, possibly with crypto duplicates
 * @returns {object[]} component list with certificate duplicates merged
 */
export function mergeDuplicateCryptoComponents(components) {
  if (!Array.isArray(components)) {
    return components;
  }
  const output = [];
  const cryptoByRef = new Map();
  for (const component of components) {
    if (component?.type !== "cryptographic-asset" || !component["bom-ref"]) {
      output.push(component);
      continue;
    }
    const existing = cryptoByRef.get(component["bom-ref"]);
    if (!existing) {
      cryptoByRef.set(component["bom-ref"], component);
      output.push(component);
      continue;
    }
    const occurrences = [
      ...(existing.evidence?.occurrences || []),
      ...(component.evidence?.occurrences || []),
    ];
    const seen = new Set();
    existing.evidence = existing.evidence || {};
    existing.evidence.occurrences = occurrences
      .filter((occurrence) => {
        if (!occurrence?.location || seen.has(occurrence.location)) {
          return false;
        }
        seen.add(occurrence.location);
        return true;
      })
      .sort((left, right) => left.location.localeCompare(right.location));
    // The component builder keys internal:SrcFile on the first sorted
    // occurrence; keep a merged component consistent with its own evidence.
    const srcFileProperty = (existing.properties || []).find(
      (property) => property.name === "internal:SrcFile",
    );
    if (srcFileProperty && existing.evidence.occurrences.length) {
      srcFileProperty.value = srcFileOfLocation(
        existing.evidence.occurrences[0].location,
      );
    }
    // File digests describe one file; a certificate found in several no
    // longer has one.
    if (existing.evidence.occurrences.length > 1) {
      delete existing.hashes;
    }
    const propertyNames = new Set(
      (existing.properties || []).map((property) => property.name),
    );
    const seenValues = new Set(
      (existing.properties || []).map(
        (property) => `${property.name}=${property.value}`,
      ),
    );
    for (const property of component.properties || []) {
      const key = `${property.name}=${property.value}`;
      // Repeatable properties (one entry per issuer key) merge by value,
      // everything else by name.
      const duplicate = REPEATABLE_PROPERTIES.has(property.name)
        ? seenValues.has(key)
        : propertyNames.has(property.name);
      if (!duplicate) {
        (existing.properties ||= []).push(property);
        propertyNames.add(property.name);
        seenValues.add(key);
      }
    }
    normalizeSourceTypeProperties(existing);
  }
  return output;
}

// ---------------------------------------------------------------------------
// Kubernetes TLS secrets and Android certificate pins (PLAN section 4.4)
// ---------------------------------------------------------------------------

// A kubernetes.io/tls Secret carries `tls.crt` (a PEM bundle) and `ca.crt`
// either base64-encoded in `.data` or as plain PEM text in `.stringData`;
// when both define a key, `stringData` wins, as the API server applies it
// over `data`. `tls.key` is private and never read.
// https://kubernetes.io/docs/concepts/configuration/secret/#tls-secrets
function parseYamlDocuments(yamlText) {
  const documents = [];
  for (const doc of parseAllDocuments(yamlText)) {
    // A malformed document does not hide the ones around it.
    if (doc.errors?.length) {
      continue;
    }
    try {
      documents.push(doc.toJS());
    } catch {
      // alias limits and the like: skip this document only
    }
  }
  return documents;
}

const K8S_CERT_KEYS = ["tls.crt", "ca.crt"];

export function kubernetesTlsSecretRecords(yamlText, { file } = {}) {
  let documents;
  try {
    documents = parseYamlDocuments(yamlText);
  } catch {
    return [];
  }
  const results = [];
  for (const doc of documents) {
    if (
      !doc ||
      typeof doc !== "object" ||
      doc.kind !== "Secret" ||
      doc.type !== "kubernetes.io/tls"
    ) {
      continue;
    }
    const data = doc.data && typeof doc.data === "object" ? doc.data : {};
    const stringData =
      doc.stringData && typeof doc.stringData === "object"
        ? doc.stringData
        : {};
    const secretName =
      typeof doc.metadata?.name === "string" ? doc.metadata.name : "";
    for (const key of K8S_CERT_KEYS) {
      let pem;
      let section;
      if (typeof stringData[key] === "string" && stringData[key]) {
        pem = stringData[key];
        section = "stringData";
      } else if (typeof data[key] === "string" && data[key]) {
        try {
          pem = Buffer.from(data[key], "base64").toString("utf-8");
        } catch {
          continue;
        }
        section = "data";
      } else {
        continue;
      }
      for (const der of pemCertificateDerBlocks(pem)) {
        const record = certRecordFromDer(der, {
          location: file ? `${file}#${section}.${key}` : `${section}.${key}`,
          sourceType: "k8s-secret",
        });
        if (record) {
          record.fileExtension = "crt";
          if (secretName) {
            record.k8sSecretName = secretName;
          }
          results.push(record);
        }
      }
    }
  }
  return results;
}

// Android network security config pins the base64 SHA-256 of a SPKI:
// <pin-set><pin digest="SHA-256">BASE64==</pin></pin-set> under
// <domain-config>. https://developer.android.com/privacy-and-security/security-config
export function androidNetworkSecurityConfigPins(xmlText, { file } = {}) {
  let parsed;
  try {
    parsed = xml2js(xmlText, {
      compact: true,
      textKey: "_",
      attributesKey: "$",
    });
  } catch {
    return [];
  }
  const root = parsed?.["network-security-config"];
  if (!root) {
    return [];
  }
  const pins = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") {
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) {
        visit(child);
      }
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "pin" && typeof value === "object") {
        const entries = Array.isArray(value) ? value : [value];
        for (const entry of entries) {
          const digest = entry?.$?.digest;
          const text = typeof entry?._ === "string" ? entry._.trim() : "";
          if (digest === "SHA-256" && text) {
            try {
              const digestBuffer = Buffer.from(text, "base64");
              // A SHA-256 digest is exactly 32 bytes; anything else is not
              // a usable pin.
              if (digestBuffer.length === 32) {
                pins.push({
                  spkiSha256: digestBuffer.toString("hex"),
                  location: file,
                });
              }
            } catch {
              // invalid base64 pin is skipped
            }
          }
        }
      } else {
        visit(value);
      }
    }
  };
  visit(root);
  return pins;
}

// ---------------------------------------------------------------------------
// Content classification for the source-directory scan (PLAN section 4.4)
// ---------------------------------------------------------------------------

const GPG_LABELS = new Set([
  "PGP PUBLIC KEY BLOCK",
  "PGP PRIVATE KEY BLOCK",
  "PGP MESSAGE",
]);

function sniffDerContainer(der) {
  // PKCS containers are DER SEQUENCEs. A PKCS #7 file is a ContentInfo
  // (RFC 5652 section 5.1): SEQUENCE { contentType OID, [0] content }, so
  // the signedData OID comes first. A PKCS #12 file is a PFX (RFC 7292
  // section 4): SEQUENCE { version INTEGER, authSafe ContentInfo, ... },
  // so the data OID sits inside the second element.
  const outer = readTLV(der, 0, der.length);
  if (outer?.tag !== 0x30) {
    return undefined;
  }
  let candidate = readTLV(der, outer.contentStart, outer.contentEnd);
  if (candidate?.tag === 0x02) {
    candidate = readTLV(der, candidate.next, outer.contentEnd);
  }
  if (candidate?.tag !== 0x30) {
    return undefined;
  }
  const contentType = readTLV(
    der,
    candidate.contentStart,
    candidate.contentEnd,
  );
  if (contentType?.tag !== 0x06) {
    return undefined;
  }
  const oid = readOID(der, contentType.contentStart, contentType.contentEnd);
  if (oid === "1.2.840.113549.1.7.1") {
    return "PKCS12";
  }
  if (oid === "1.2.840.113549.1.7.2") {
    return "PKCS7";
  }
  return undefined;
}

/**
 * Classify a matched file by its content: certificates (PEM bundle or DER),
 * a PEM private-key header, a GPG key, a PEM public key, or a keystore
 * container the fallback cannot read. Nothing is decoded beyond what the
 * header lines and a bounded DER walk reveal.
 *
 * @param {Buffer} bytes file contents (already size-capped by the caller)
 * @returns {object} one of `{kind:"certificates", ders}`,
 *   `{kind:"private-key", format}`, `{kind:"gpg"}`, `{kind:"public-key"}`,
 *   `{kind:"keystore", format}` or `{kind:"unknown"}`
 */
export function classifyCryptoFile(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    return { kind: "unknown" };
  }
  const asText = bytes.toString("utf-8");
  if (asText.includes("-----BEGIN ")) {
    const blocks = splitPemBlocks(asText);
    const ders = pemCertificateDerBlocks(asText);
    if (ders.length) {
      return { kind: "certificates", ders };
    }
    const privateFormat = privateKeyPemFormat(asText);
    if (privateFormat) {
      return { kind: "private-key", format: privateFormat };
    }
    if (blocks.some((block) => GPG_LABELS.has(block.label))) {
      return { kind: "gpg" };
    }
    if (hasPemPublicKey(asText)) {
      return { kind: "public-key" };
    }
    // A TRUSTED CERTIFICATE block is certificate material only the plugin
    // parses (its aux trust data has no Node parser); report the container
    // as an unreadable bundle rather than calling it a certificate.
    if (blocks.some((block) => block.label === "TRUSTED CERTIFICATE")) {
      return { kind: "keystore", format: "PEM-TRUSTED" };
    }
    return { kind: "unknown" };
  }
  if (bytes.length >= 4 && bytes[0] === 0xfe && bytes[1] === 0xed) {
    // OpenJDK JavaKeyStore.engineLoad magic 0xfeedfeed.
    return { kind: "keystore", format: "JKS" };
  }
  if (bytes.length >= 4 && bytes[0] === 0xce && bytes[1] === 0xce) {
    return { kind: "keystore", format: "JCEKS" };
  }
  if (bytes[0] === 0x30) {
    const container = sniffDerContainer(bytes);
    if (container) {
      return { kind: "keystore", format: container };
    }
    // A structural walk decides: an unknown key algorithm OID (GOST, SM2,
    // pre-standard) is still a real certificate.
    if (parseCertificateDer(bytes)) {
      return { kind: "certificates", ders: [bytes] };
    }
  }
  return { kind: "unknown" };
}
