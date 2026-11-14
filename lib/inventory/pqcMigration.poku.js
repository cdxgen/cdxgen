import { readFileSync } from "node:fs";
import { join } from "node:path";

import { assert, describe, it } from "poku";

import { assertRefIntegrity } from "../../test/helpers/cyclonedx20RefIntegrity.js";
import { createBom } from "../cli/index.js";
import { postProcess } from "../stages/postgen/postgen.js";
import precompiled20 from "../validator/generated/validate-2.0.mjs";
import { applyAlgorithmProperties } from "./cryptoAlgorithmFamily.js";
import { readCycloneDx20, renderCycloneDx20 } from "./cyclonedx20.js";
import {
  classifyPqcCryptoAsset,
  collectPqcRisks,
  compactAlgorithmName,
} from "./pqcMigration.js";

const pqcData = JSON.parse(
  readFileSync(join("data", "pqc-migration.json"), "utf-8"),
);

// The shapes the collectors emit: certificates.js algorithmComponent (name,
// OID, nistQuantumSecurityLevel 0, no family) and cbomutils (family and
// primitive from the OID table).
const algorithm = (name, oid, algorithmProperties) => ({
  "bom-ref": `crypto/algorithm/${name}@${oid || "none"}`,
  type: "cryptographic-asset",
  name,
  cryptoProperties: {
    assetType: "algorithm",
    ...(algorithmProperties ? { algorithmProperties } : {}),
    ...(oid ? { oid } : {}),
  },
});

const publicKey = (name, size, algorithmRef) => ({
  "bom-ref": `crypto/public-key/${name}@spki-sha256:00`,
  type: "cryptographic-asset",
  name,
  cryptoProperties: {
    assetType: "related-crypto-material",
    relatedCryptoMaterialProperties: {
      type: "public-key",
      size,
      ...(algorithmRef ? { algorithmRef } : {}),
    },
  },
});

const CERT_LEVEL = { nistQuantumSecurityLevel: 0 };

describe("classifyPqcCryptoAsset() against NIST IR 8547", () => {
  const cases = [
    // certificates.js output: no algorithmFamily, the OID decides.
    [
      "rsaEncryption key algorithm (certificates)",
      algorithm("RSA", "1.2.840.113549.1.1.1", CERT_LEVEL),
      { className: "quantum-vulnerable-public-key", keyFamily: "rsa" },
    ],
    [
      "SHA256-RSA signature (certificates)",
      algorithm("SHA256-RSA", "1.2.840.113549.1.1.11", CERT_LEVEL),
      { className: "quantum-vulnerable-signature", keyFamily: "rsa" },
    ],
    [
      "id-ecPublicKey (certificates)",
      algorithm("EC", "1.2.840.10045.2.1", CERT_LEVEL),
      { className: "quantum-vulnerable-public-key", keyFamily: "ec" },
    ],
    [
      "ecdsa-with-SHA256 by OID",
      algorithm("ECDSA-SHA256", "1.2.840.10045.4.3.2", CERT_LEVEL),
      { className: "quantum-vulnerable-signature", keyFamily: "ec" },
    ],
    [
      "X25519 by OID",
      algorithm("X25519", "1.3.101.110", CERT_LEVEL),
      { className: "quantum-vulnerable-key-establishment" },
    ],
    [
      "X448 by name only",
      algorithm("X448"),
      { className: "quantum-vulnerable-key-establishment" },
    ],
    [
      "Ed25519 by OID",
      algorithm("Ed25519", "1.3.101.112", CERT_LEVEL),
      { className: "quantum-vulnerable-signature" },
    ],
    [
      "Ed448 by OID",
      algorithm("Ed448", "1.3.101.113", CERT_LEVEL),
      { className: "quantum-vulnerable-signature" },
    ],
    [
      "X9.42 DH by OID",
      algorithm("DH", "1.2.840.10046.2.1", CERT_LEVEL),
      { className: "quantum-vulnerable-key-establishment", keyFamily: "ff" },
    ],
    [
      "ECMQV by name",
      algorithm("ECMQV"),
      { className: "quantum-vulnerable-key-establishment", keyFamily: "ec" },
    ],
    [
      "MQV by family",
      algorithm("mqv", undefined, { algorithmFamily: "MQV" }),
      { className: "quantum-vulnerable-key-establishment", keyFamily: "ff" },
    ],
    [
      "DSA by OID (FIPS 186-5, not IR 8547 Table 2)",
      algorithm("DSA", "1.2.840.10040.4.1", CERT_LEVEL),
      { className: "dsa-generation-not-approved" },
    ],
    // cbomutils output: family and primitive set.
    [
      "sha256WithRSAEncryption (cbomutils)",
      algorithm("sha256WithRSAEncryption", "1.2.840.113549.1.1.11", {
        algorithmFamily: "RSASSA-PKCS1",
        primitive: "signature",
      }),
      { className: "quantum-vulnerable-signature", keyFamily: "rsa" },
    ],
    [
      "sha-224 (cbomutils, family SHA-2)",
      algorithm("sha-224", "2.16.840.1.101.3.4.2.4", {
        algorithmFamily: "SHA-2",
        primitive: "signature",
      }),
      { className: "symmetric-112-bit" },
    ],
    [
      "SHA-512/224 by name, family SHA-2",
      algorithm("SHA-512/224", undefined, { algorithmFamily: "SHA-2" }),
      { className: "symmetric-112-bit" },
    ],
    [
      "SHA3-224 by name, family SHA-3",
      algorithm("SHA3-224", undefined, { algorithmFamily: "SHA-3" }),
      { className: "symmetric-112-bit" },
    ],
    [
      "SHA-1 by family",
      algorithm("sha-1", "1.3.14.3.2.26", {
        algorithmFamily: "SHA-1",
        primitive: "hash",
      }),
      { className: "hash-sha1" },
    ],
    [
      "RSA-1024 by name: below the IR 8547 minimum",
      algorithm("RSA-1024"),
      {
        className: "below-minimum-strength",
        keyFamily: "rsa",
        keySize: 1024,
        minimumKeySize: 2048,
      },
    ],
    [
      "ECDSA on P-192: below the IR 8547 minimum",
      algorithm("ecdsa", undefined, {
        algorithmFamily: "ECDSA",
        ellipticCurve: "nist/P-192",
      }),
      {
        className: "below-minimum-strength",
        keyFamily: "ec",
        keySize: 192,
        minimumKeySize: 224,
      },
    ],
    [
      "RSA signature whose parameter set is a digest size, not a key size",
      algorithm("sha256WithRSAEncryption", undefined, {
        algorithmFamily: "RSASSA-PKCS1",
        parameterSetIdentifier: "256",
      }),
      { className: "quantum-vulnerable-signature", keyFamily: "rsa" },
    ],
    // A trailing digest size is not a key size.
    [
      "RSASSA-PSS-SHA-512 by name",
      algorithm("RSASSA-PSS-SHA-512"),
      { className: "quantum-vulnerable-signature", keyFamily: "rsa" },
    ],
    [
      "RSA-OAEP-SHA-512 by name",
      algorithm("RSA-OAEP-SHA-512"),
      { className: "quantum-vulnerable-key-establishment", keyFamily: "rsa" },
    ],
    [
      "sha512WithRSAEncryption-512 by name",
      algorithm("sha512WithRSAEncryption-512"),
      { className: "quantum-vulnerable-signature", keyFamily: "rsa" },
    ],
    [
      "ECDSA-SHA-256 on P-192: the curve decides, not the digest",
      algorithm("ECDSA-SHA-256", undefined, { ellipticCurve: "nist/P-192" }),
      {
        className: "below-minimum-strength",
        keyFamily: "ec",
        keySize: 192,
        minimumKeySize: 224,
      },
    ],
    // A hash paired with a signature algorithm is that signature algorithm.
    [
      "SHA256withDSA by name",
      algorithm("SHA256withDSA"),
      { className: "dsa-generation-not-approved" },
    ],
    [
      "dsa-with-sha256 by name",
      algorithm("dsa-with-sha256"),
      { className: "dsa-generation-not-approved" },
    ],
    [
      "SHA1withDSA by name, not SHA-1",
      algorithm("SHA1withDSA"),
      { className: "dsa-generation-not-approved" },
    ],
    [
      "RSA-SHA-512 by name",
      algorithm("RSA-SHA-512"),
      { className: "quantum-vulnerable-signature", keyFamily: "rsa" },
    ],
    [
      "SHA256withECDSA by name",
      algorithm("SHA256withECDSA"),
      { className: "quantum-vulnerable-signature", keyFamily: "ec" },
    ],
    // NIST CSOR sigAlgs arc 2.16.840.1.101.3.4.3.
    [
      "id-dsa-with-sha384 by OID",
      algorithm("x", "2.16.840.1.101.3.4.3.3"),
      { className: "dsa-generation-not-approved" },
    ],
    [
      "id-dsa-with-sha512 by OID",
      algorithm("x", "2.16.840.1.101.3.4.3.4"),
      { className: "dsa-generation-not-approved" },
    ],
    [
      "id-dsa-with-sha3-256 by OID",
      algorithm("x", "2.16.840.1.101.3.4.3.6"),
      { className: "dsa-generation-not-approved" },
    ],
    [
      "id-ecdsa-with-sha3-384 by OID",
      algorithm("x", "2.16.840.1.101.3.4.3.11"),
      { className: "quantum-vulnerable-signature", keyFamily: "ec" },
    ],
    [
      "id-rsassa-pkcs1-v1_5-with-sha3-512 by OID",
      algorithm("x", "2.16.840.1.101.3.4.3.16"),
      { className: "quantum-vulnerable-signature", keyFamily: "rsa" },
    ],
    // RFC 7919 groups: the name carries the modulus size.
    [
      "ffdhe2048 by name",
      algorithm("ffdhe2048"),
      { className: "quantum-vulnerable-key-establishment", keyFamily: "ff" },
    ],
    [
      "ffdhe8192 whose name size wins over a parameter set",
      algorithm("ffdhe8192", undefined, { parameterSetIdentifier: "1024" }),
      { className: "quantum-vulnerable-key-establishment", keyFamily: "ff" },
    ],
    [
      "RSA-3072 key generator (parameter set is the key size)",
      algorithm("RSA", undefined, { parameterSetIdentifier: "3072" }),
      { className: "quantum-vulnerable-public-key", keyFamily: "rsa" },
    ],
  ];
  for (const [label, asset, expected] of cases) {
    it(`classifies ${label}`, () => {
      assert.deepStrictEqual(classifyPqcCryptoAsset(asset), expected);
    });
  }

  const unclassified = [
    [
      "SHA-256",
      algorithm("sha-256", "2.16.840.1.101.3.4.2.1", {
        algorithmFamily: "SHA-2",
      }),
    ],
    [
      "SHA3-256",
      algorithm("SHA3-256", undefined, { algorithmFamily: "SHA-3" }),
    ],
    [
      "AES-128",
      algorithm("aes128-CBC", undefined, {
        algorithmFamily: "AES",
        parameterSetIdentifier: "128",
      }),
    ],
    [
      "ML-KEM-768",
      algorithm("ML-KEM-768", undefined, {
        algorithmFamily: "ML-KEM",
        parameterSetIdentifier: "768",
      }),
    ],
    ["ML-DSA-65", algorithm("ML-DSA-65", "2.16.840.1.101.3.4.3.18")],
    // Not in IR 8547 Table 4: no class.
    [
      "RSAES-PKCS1",
      algorithm("rsaes-pkcs1", undefined, { algorithmFamily: "RSAES-PKCS1" }),
    ],
    ["X3DH", algorithm("x3dh", undefined, { algorithmFamily: "X3DH" })],
    // IR 8547 Sec. 3.2.1: a hybrid combiner is not judged by one input's OID.
    [
      "a hybrid X25519 combiner",
      algorithm("draft-ietf-tls-hybrid-design-13", "1.3.101.110", {
        primitive: "combiner",
      }),
    ],
    [
      "a certificate",
      {
        "bom-ref": "c",
        name: "c",
        cryptoProperties: { assetType: "certificate" },
      },
    ],
  ];
  for (const [label, asset] of unclassified) {
    it(`gives ${label} no class`, () => {
      assert.strictEqual(classifyPqcCryptoAsset(asset), undefined);
    });
  }

  it("classes a digest-paired DSA name as DSA after applyAlgorithmProperties", () => {
    // Collectors run applyAlgorithmProperties before classification, so the
    // digest-paired DSA names must arrive with family DSA rather than the
    // digest's SHA family.
    for (const [name, oid] of [
      ["SHA256withDSA", "2.16.840.1.101.3.4.3.2"],
      ["SHA224withDSA", "2.16.840.1.101.3.4.3.1"],
      ["SHA1withDSA", "1.2.840.10040.4.3"],
      ["dsaWithSha256", "2.16.840.1.101.3.4.3.2"],
      ["DSA-SHA256", "2.16.840.1.101.3.4.3.2"],
    ]) {
      const asset = algorithm(name, oid);
      applyAlgorithmProperties(asset, { name });
      assert.deepStrictEqual(classifyPqcCryptoAsset(asset), {
        className: "dsa-generation-not-approved",
      });
    }
  });

  it("classes a digest-paired RSA name as RSA after applyAlgorithmProperties", () => {
    // Collectors run applyAlgorithmProperties before classification, so the
    // digest-paired RSA names must arrive with family RSASSA-PKCS1 rather
    // than the digest's SHA family, which the classifier reads first and
    // treats as quantum-safe. rsaWithSHA1 would additionally be reported as
    // a SHA-1 hash.
    for (const [name, oid] of [
      ["RSA-SHA256", "1.2.840.113549.1.1.11"],
      ["RSA-SHA3-256", "2.16.840.1.101.3.4.3.14"],
      ["RSA_PKCS1_SHA256", "1.2.840.113549.1.1.11"],
      ["rsaWithSHA1", "1.2.840.113549.1.1.5"],
      ["SHA256withRSA", "1.2.840.113549.1.1.11"],
    ]) {
      const asset = algorithm(name, oid);
      applyAlgorithmProperties(asset, { name });
      assert.deepStrictEqual(classifyPqcCryptoAsset(asset), {
        className: "quantum-vulnerable-signature",
        keyFamily: "rsa",
      });
    }
  });

  it("classes a key below the minimum and leaves an approved key to its algorithm", () => {
    const rsa = algorithm("RSA", "1.2.840.113549.1.1.1", CERT_LEVEL);
    const byRef = new Map([[rsa["bom-ref"], rsa]]);
    assert.deepStrictEqual(
      classifyPqcCryptoAsset(
        publicKey("RSA-1024", 1024, rsa["bom-ref"]),
        byRef,
      ),
      {
        className: "below-minimum-strength",
        keyFamily: "rsa",
        keySize: 1024,
        minimumKeySize: 2048,
      },
    );
    assert.strictEqual(
      classifyPqcCryptoAsset(
        publicKey("RSA-2048", 2048, rsa["bom-ref"]),
        byRef,
      ),
      undefined,
    );
    // Without a resolvable algorithmRef the key name decides.
    assert.strictEqual(
      classifyPqcCryptoAsset(publicKey("RSA-1024", 1024)).className,
      "below-minimum-strength",
    );
  });

  it("checks a key's own size against its algorithm's base class", () => {
    const weakAlgorithm = algorithm("RSA-1024");
    const byRef = new Map([[weakAlgorithm["bom-ref"], weakAlgorithm]]);
    const strongKey = publicKey("rsa-key", 4096, weakAlgorithm["bom-ref"]);
    assert.strictEqual(classifyPqcCryptoAsset(strongKey, byRef), undefined);
    assert.deepStrictEqual(
      collectPqcRisks({ components: [weakAlgorithm, strongKey] }).map(
        (risk) => risk.affects[0],
      ),
      [weakAlgorithm["bom-ref"]],
    );
    const strongAlgorithm = algorithm("RSA-3072");
    const weakKey = publicKey("rsa-key", 1024, strongAlgorithm["bom-ref"]);
    assert.deepStrictEqual(
      classifyPqcCryptoAsset(
        weakKey,
        new Map([[strongAlgorithm["bom-ref"], strongAlgorithm]]),
      ),
      {
        className: "below-minimum-strength",
        keyFamily: "rsa",
        keySize: 1024,
        minimumKeySize: 2048,
      },
    );
  });

  it("normalises names to lower-case letters and digits", () => {
    assert.strictEqual(compactAlgorithmName("SHA-512/224"), "sha512224");
    assert.strictEqual(compactAlgorithmName("id-ecPublicKey"), "idecpublickey");
    assert.strictEqual(compactAlgorithmName(undefined), "");
  });
});

describe("collectPqcRisks() entries", () => {
  it("renders the rsaEncryption risk exactly, without confidence or organisational facts", () => {
    const risks = collectPqcRisks({
      components: [algorithm("RSA", "1.2.840.113549.1.1.1", CERT_LEVEL)],
    });
    assert.deepStrictEqual(risks, [
      {
        refId: "risk-pqc-crypto/algorithm/RSA@1.2.840.113549.1.1.1",
        name: "Post-quantum migration: RSA",
        statement:
          "This public-key algorithm is quantum-vulnerable whether it signs (NIST IR 8547 Table 2) or establishes keys (Table 4); both tables deprecate it after 2030 and disallow it after 2035.",
        domains: [{ type: "security" }],
        affects: ["crypto/algorithm/RSA@1.2.840.113549.1.1.1"],
        inherentRisk: {
          likelihood: { level: "high" },
          impacts: [{ level: "major" }],
          rationale:
            "RSA is a quantum-vulnerable public-key algorithm listed in NIST IR 8547 Table 2 and Table 4: deprecated after 2030, disallowed after 2035.",
        },
        properties: [
          {
            name: "cdx:crypto:pqc:class",
            value: "quantum-vulnerable-public-key",
          },
          { name: "cdx:crypto:pqc:deprecatedAfter", value: "2030" },
          { name: "cdx:crypto:pqc:disallowedAfter", value: "2035" },
          {
            name: "cdx:crypto:pqc:transition",
            value: "Deprecated after 2030; disallowed after 2035",
          },
          {
            name: "cdx:crypto:pqc:source",
            value: pqcData.classes["quantum-vulnerable-public-key"].source,
          },
        ],
        externalReferences: [
          {
            type: "documentation",
            url: "https://csrc.nist.gov/pubs/ir/8547/final",
          },
        ],
      },
    ]);
  });

  it("states the SHA-1 and 112-bit transitions as the IR does, with no invented year", () => {
    const [sha1, sha224] = collectPqcRisks({
      components: [
        algorithm("sha-1", "1.3.14.3.2.26", { algorithmFamily: "SHA-1" }),
        algorithm("sha-224", "2.16.840.1.101.3.4.2.4", {
          algorithmFamily: "SHA-2",
        }),
      ],
    });
    const asObject = (risk) =>
      Object.fromEntries(risk.properties.map((p) => [p.name, p.value]));
    assert.deepStrictEqual(asObject(sha1), {
      "cdx:crypto:pqc:class": "hash-sha1",
      "cdx:crypto:pqc:disallowedAfter": "2030",
      "cdx:crypto:pqc:transition":
        "Currently deprecated for all remaining technical applications; disallowed for use in FIPS-validated cryptographic modules after 2030",
      "cdx:crypto:pqc:source":
        "NIST IR 8547 Table 8 (hash functions and XOFs), footnote 4",
    });
    assert.deepStrictEqual(asObject(sha224), {
      "cdx:crypto:pqc:class": "symmetric-112-bit",
      "cdx:crypto:pqc:disallowedIn": "2030",
      "cdx:crypto:pqc:transition": "Disallowed in 2030",
      "cdx:crypto:pqc:source":
        "NIST IR 8547 Section 4.1.3 and Table 8: SHA-224, SHA-512/224 and SHA3-224 have 112 bits of collision security strength",
    });
    // SHA-1 and SHA-224 are weak hashes, not quantum-vulnerable algorithms.
    assert.ok(!sha1.inherentRisk.rationale.includes("quantum-vulnerable"));
    assert.ok(!sha224.inherentRisk.rationale.includes("quantum-vulnerable"));
    assert.strictEqual(
      sha224.inherentRisk.rationale,
      "sha-224 has 112 bits of collision security strength (NIST IR 8547 Table 8); section 4.1.3 says the 112-bit symmetric standards will be disallowed in 2030.",
    );
    assert.strictEqual(sha1.name, "Deprecated hash function: sha-1");
  });

  it("names the minimum in the rationale of a weak key", () => {
    const rsa = algorithm("RSA", "1.2.840.113549.1.1.1", CERT_LEVEL);
    const weak = publicKey("RSA-1024", 1024, rsa["bom-ref"]);
    const risks = collectPqcRisks({ components: [rsa, weak] });
    assert.deepStrictEqual(
      risks.map((risk) => [risk.refId, risk.properties[0].value]),
      [
        [`risk-pqc-${rsa["bom-ref"]}`, "quantum-vulnerable-public-key"],
        [`risk-pqc-${weak["bom-ref"]}`, "below-minimum-strength"],
      ],
    );
    assert.strictEqual(
      risks[1].inherentRisk.rationale,
      "RSA-1024 uses a 1024-bit key, below the 2048-bit minimum (112 bits of classical security strength) of the parameters NIST IR 8547 Table 2 and Table 4 list.",
    );
    assert.deepStrictEqual(risks[1].inherentRisk.likelihood, {
      level: "very-high",
    });
    assert.ok(
      !risks[1].properties.some((p) => p.name.endsWith("deprecatedAfter")),
    );
  });

  it("skips assets without a bom-ref and keeps one risk per refId", () => {
    const rsa = algorithm("RSA", "1.2.840.113549.1.1.1", CERT_LEVEL);
    const { "bom-ref": _ref, ...unreferenced } = algorithm(
      "ECDSA",
      "1.2.840.10045.4.3.2",
    );
    const risks = collectPqcRisks({
      components: [
        rsa,
        structuredClone(rsa),
        unreferenced,
        { components: [structuredClone(rsa)] },
      ],
    });
    assert.deepStrictEqual(
      risks.map((risk) => risk.refId),
      ["risk-pqc-crypto/algorithm/RSA@1.2.840.113549.1.1.1"],
    );
    for (const risk of risks) {
      assert.strictEqual(risk.inherentRisk.confidence, undefined);
      assert.strictEqual(risk.owner, undefined);
      assert.strictEqual(risk.status, undefined);
      assert.strictEqual(risk.responses, undefined);
    }
  });
});

describe("data/pqc-migration.json against NIST IR 8547 (final)", () => {
  // IR 8547 (final, October 2026) section 4.1.1 deprecates all
  // quantum-vulnerable digital signature algorithms after 2030 and disallows
  // them after 2035; Table 2 gives that transition to ECDSA and RSA at
  // >= 112 bits and EdDSA at >= 128 bits, and Table 4 to every
  // key-establishment row at >= 112 bits. The initial public draft
  // (November 2024) deprecated only the 112-bit rows after 2030.
  it("gives every Table 2 and Table 4 class, EdDSA included, the final transition", () => {
    for (const className of [
      "quantum-vulnerable-signature",
      "quantum-vulnerable-key-establishment",
      "quantum-vulnerable-public-key",
    ]) {
      assert.strictEqual(pqcData.classes[className].deprecatedAfter, "2030");
      assert.strictEqual(pqcData.classes[className].disallowedAfter, "2035");
    }
    const [ed25519] = collectPqcRisks({
      components: [algorithm("Ed25519", "1.3.101.112", CERT_LEVEL)],
    });
    assert.deepStrictEqual(
      ed25519.properties
        .filter((p) => p.name.endsWith("After"))
        .map((p) => [p.name, p.value]),
      [
        ["cdx:crypto:pqc:deprecatedAfter", "2030"],
        ["cdx:crypto:pqc:disallowedAfter", "2035"],
      ],
    );
    assert.strictEqual(
      pqcData.source.document,
      "NIST IR 8547 (final, October 2026)",
    );
  });

  it("states the FIPS 186-5 DSA rule as the standard does", () => {
    const [dsa] = collectPqcRisks({
      components: [algorithm("DSA", "1.2.840.10040.4.1", CERT_LEVEL)],
    });
    assert.strictEqual(
      dsa.statement,
      "FIPS 186-5 no longer approves DSA for digital signature generation; DSA may be used only to verify signatures generated prior to the implementation date of FIPS 186-5 (section 4).",
    );
    assert.match(
      dsa.properties.find((p) => p.name === "cdx:crypto:pqc:source").value,
      /^FIPS 186-5 \(February 2023\), section 4 /u,
    );
    assert.deepStrictEqual(dsa.externalReferences, [
      {
        type: "documentation",
        url: "https://csrc.nist.gov/pubs/fips/186-5/final",
      },
    ]);
  });

  it("lists only the IR's own members in the Table 2 and Table 4 classes", () => {
    assert.deepStrictEqual(
      Object.keys(
        pqcData.classes["quantum-vulnerable-signature"].families,
      ).sort(),
      ["ECDSA", "EdDSA", "RSA-X931", "RSASSA-PKCS1", "RSASSA-PSS"],
    );
    assert.deepStrictEqual(
      Object.keys(
        pqcData.classes["quantum-vulnerable-key-establishment"].families,
      ).sort(),
      ["ECDH", "FFDH", "MQV", "RSAES-OAEP"],
    );
    const table24 = [
      "quantum-vulnerable-signature",
      "quantum-vulnerable-key-establishment",
      "quantum-vulnerable-public-key",
    ];
    for (const className of table24) {
      const definition = pqcData.classes[className];
      for (const absent of ["DSA", "X3DH", "RSAES-PKCS1"]) {
        assert.ok(!(absent in definition.families), `${className}: ${absent}`);
      }
      assert.match(definition.source, /NIST IR 8547 Table [24]/u);
    }
  });

  it("invents no year and cites a source for every class", () => {
    const raw = readFileSync(join("data", "pqc-migration.json"), "utf-8");
    assert.ok(!raw.includes('2026"'), "no 2026 deprecation year");
    for (const [className, definition] of Object.entries(pqcData.classes)) {
      assert.ok(definition.source, `${className} cites its source`);
      assert.ok(definition.transition, `${className} states its transition`);
      assert.ok(definition.rationale, `${className} has its own rationale`);
      for (const field of [
        "deprecatedAfter",
        "disallowedAfter",
        "disallowedIn",
      ]) {
        if (definition[field] !== undefined) {
          assert.ok(
            definition.transition.includes(definition[field]),
            `${className}.${field} appears in its transition text`,
          );
        }
      }
      assert.strictEqual(definition.confidence, undefined);
    }
    assert.strictEqual(pqcData.classes["hash-sha1"].deprecatedAfter, undefined);
    assert.strictEqual(
      pqcData.classes["symmetric-112-bit"].disallowedAfter,
      undefined,
    );
  });
});

async function generate20(fixture) {
  const options = {
    projectType: ["universal"],
    includeCrypto: true,
    installDeps: false,
    specVersion: "2.0",
  };
  const bomNSData = await createBom(fixture, options);
  await postProcess(bomNSData, options, fixture);
  return bomNSData.bomJson;
}

const riskSummary = (bom20) =>
  (bom20.risks?.risks || []).map((risk) => [
    risk.refId,
    risk.properties.find((p) => p.name === "cdx:crypto:pqc:class").value,
  ]);

describe("post-quantum risks in rendered 2.0 documents (#4592)", () => {
  it("derives the cbom-js fixture's risks", async () => {
    const bom20 = await generate20(join("test", "data", "cbom-js-repotest"));
    assert.ok(precompiled20(bom20), "the risk-carrying document validates");
    assertRefIntegrity(bom20, "cbom-js");
    assert.deepStrictEqual(riskSummary(bom20), [
      [
        "risk-pqc-crypto/algorithm/sha-224@2.16.840.1.101.3.4.2.4",
        "symmetric-112-bit",
      ],
      [
        "risk-pqc-crypto/algorithm/sha256WithRSAEncryption@1.2.840.113549.1.1.11",
        "quantum-vulnerable-signature",
      ],
      [
        "risk-pqc-crypto/algorithm/sha512WithRSAEncryption@1.2.840.113549.1.1.13",
        "quantum-vulnerable-signature",
      ],
    ]);
  });

  it("derives the cbom-certs fixture's risks from certificate algorithms", async () => {
    const bom20 = await generate20(
      join("test", "data", "cbom-certs", "rootfs"),
    );
    assert.ok(precompiled20(bom20));
    assertRefIntegrity(bom20, "cbom-certs");
    assert.deepStrictEqual(riskSummary(bom20), [
      [
        "risk-pqc-crypto/algorithm/RSA@1.2.840.113549.1.1.1",
        "quantum-vulnerable-public-key",
      ],
      [
        "risk-pqc-crypto/algorithm/SHA256-RSA@1.2.840.113549.1.1.11",
        "quantum-vulnerable-signature",
      ],
    ]);
  });
});

describe("post-quantum risks after a 2.0 read (#4592)", () => {
  const rsa = algorithm("RSA", "1.2.840.113549.1.1.1", CERT_LEVEL);
  const ecdsa = algorithm("ECDSA-SHA256", "1.2.840.10045.4.3.2", CERT_LEVEL);
  const foreignRisk = {
    refId: "risk-foreign",
    name: "Foreign risk",
    statement: "Recorded by another tool.",
    affects: [rsa["bom-ref"]],
  };
  const cdxgenTool = {
    type: "application",
    name: "cdxgen",
    version: "12.9.1",
    "bom-ref": "pkg:npm/@cdxgen/cdxgen@12.9.1",
  };
  const baseModel = (tools = { components: [cdxgenTool] }) => ({
    bomFormat: "CycloneDX",
    specVersion: "1.7",
    ...(tools ? { metadata: { tools: structuredClone(tools) } } : {}),
    components: [structuredClone(rsa)],
  });

  it("derives risks only when cdxgen is a listed tool", () => {
    assert.deepStrictEqual(
      renderCycloneDx20(baseModel()).risks.risks.map((risk) => risk.refId),
      [`risk-pqc-${rsa["bom-ref"]}`],
    );
    const syft = {
      type: "application",
      name: "syft",
      version: "1.20.0",
      "bom-ref": "pkg:golang/github.com/anchore/syft@v1.20.0",
    };
    // A cdxgen entry without a bom-ref is not a listed tool either.
    const { "bom-ref": _ref, ...unreferencedCdxgen } = cdxgenTool;
    for (const tools of [
      { components: [syft] },
      { components: [unreferencedCdxgen, syft] },
      null,
    ]) {
      const rendered = renderCycloneDx20(baseModel(tools));
      assert.strictEqual(rendered.risks, undefined);
      assert.ok(precompiled20(rendered));
    }
    // A foreign 2.0 document keeps its own risks and gains none.
    const foreign = renderCycloneDx20(baseModel({ components: [syft] }));
    foreign.risks = { risks: [structuredClone(foreignRisk)] };
    const { internalBom } = readCycloneDx20(foreign);
    assert.deepStrictEqual(
      renderCycloneDx20(internalBom).risks.risks.map((risk) => risk.refId),
      ["risk-foreign"],
    );
  });

  it("carries another tool's risk-pqc-* entries unchanged", () => {
    const syft = {
      type: "application",
      name: "syft",
      version: "1.20.0",
      "bom-ref": "pkg:golang/github.com/anchore/syft@v1.20.0",
    };
    const foreign = renderCycloneDx20(baseModel({ components: [syft] }));
    const lookalike = {
      ...structuredClone(foreignRisk),
      refId: `risk-pqc-${rsa["bom-ref"]}`,
      name: "Another tool's PQC assessment",
    };
    foreign.risks = { risks: [lookalike] };
    const { internalBom, losses } = readCycloneDx20(foreign);
    assert.ok(
      !losses.some((loss) => loss.pointer.startsWith("/risks/risks/")),
      JSON.stringify(losses),
    );
    assert.deepStrictEqual(renderCycloneDx20(internalBom).risks.risks, [
      lookalike,
    ]);
  });

  it("reads its own risks back without a loss and renders them once", () => {
    const bom20 = renderCycloneDx20(baseModel());
    const { internalBom, losses } = readCycloneDx20(bom20);
    assert.deepStrictEqual(losses, []);
    assert.strictEqual(internalBom.cdx20Sections?.risks, undefined);
    assert.deepStrictEqual(renderCycloneDx20(internalBom), bom20);
  });

  it("re-derives risks for added and removed assets and keeps a foreign risk", () => {
    const bom20 = renderCycloneDx20(baseModel());
    bom20.risks.risks.push(foreignRisk);
    const { internalBom, losses } = readCycloneDx20(bom20);
    assert.deepStrictEqual(
      losses.map((loss) => loss.pointer),
      ["/risks"],
    );
    internalBom.components = [structuredClone(ecdsa)];
    const rendered = renderCycloneDx20(internalBom);
    assert.deepStrictEqual(
      rendered.risks.risks.map((risk) => risk.refId),
      ["risk-foreign", `risk-pqc-${ecdsa["bom-ref"]}`],
    );
    assert.ok(precompiled20(rendered));
  });

  it("reports a carried derived risk that no longer matches, and replaces it", () => {
    const bom20 = renderCycloneDx20(baseModel());
    bom20.risks.risks[0].statement = "Edited elsewhere.";
    const { internalBom, losses } = readCycloneDx20(bom20);
    assert.deepStrictEqual(
      losses.map((loss) => loss.pointer),
      ["/risks/risks/0"],
    );
    const rendered = renderCycloneDx20(internalBom);
    assert.deepStrictEqual(rendered, renderCycloneDx20(baseModel()));
  });

  it("drops a carried derived risk the model no longer supports", () => {
    const model = baseModel();
    model.cdx20Sections = {
      risks: {
        risks: [
          { ...foreignRisk },
          {
            refId: "risk-pqc-gone",
            name: "Stale",
            statement: "Stale",
            affects: ["gone"],
          },
        ],
      },
    };
    const rendered = renderCycloneDx20(model);
    assert.deepStrictEqual(
      rendered.risks.risks.map((risk) => risk.refId),
      ["risk-foreign", `risk-pqc-${rsa["bom-ref"]}`],
    );
  });
});
