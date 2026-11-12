import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { assert, describe, it } from "poku";

import {
  androidNetworkSecurityConfigPins,
  CertificateCollector,
  certRecordFromDer,
  certRecordFromObservedChainEntry,
  certRecordFromTrustInspector,
  classifyCryptoFile,
  commonNameFromDn,
  keyAlgorithmName,
  kubernetesTlsSecretRecords,
  linkFallbackIssuers,
  mergeDuplicateCryptoComponents,
  parseCertificateDer,
  pemCertificateDerBlocks,
  signatureAlgorithmName,
  srcFileOfLocation,
} from "./certificates.js";

const FIXTURES = join("test", "data", "cbom-certs");
const GENERATED = join(FIXTURES, "generated");

function readFixture(name) {
  return readFileSync(join(GENERATED, name));
}

function pemBlocks(name) {
  return pemCertificateDerBlocks(readFileSync(join(GENERATED, name), "utf-8"));
}

function prop(component, name) {
  return component.properties?.find((property) => property.name === name)
    ?.value;
}

describe("parseCertificateDer()", () => {
  it("walks a real certificate", () => {
    const der = pemBlocks("rootA.crt")[0];
    const parsed = parseCertificateDer(der);
    assert.ok(parsed);
    assert.strictEqual(parsed.version, 3);
    assert.strictEqual(parsed.keyAlgorithmOid, "1.2.840.113549.1.1.1");
    assert.strictEqual(parsed.signatureAlgorithmOid, "1.2.840.113549.1.1.11");
    assert.ok(parsed.rsaKeyBits >= 2047 && parsed.rsaKeyBits <= 2048);
    assert.ok(parsed.subjectKeyId);
    assert.ok(parsed.spkiDer.length > 200);
  });

  it("reads SKI and AKI from extensions", () => {
    const der = pemBlocks("intA.crt")[0];
    const parsed = parseCertificateDer(der);
    assert.ok(parsed.subjectKeyId);
    assert.strictEqual(
      parsed.authorityKeyId,
      parseCertificateDer(pemBlocks("rootA.crt")[0]).subjectKeyId,
    );
  });

  it("returns undefined for malformed input instead of throwing", () => {
    const der = pemBlocks("leaf.crt")[0];
    const truncated = der.subarray(0, Math.floor(der.length / 2));
    assert.strictEqual(parseCertificateDer(truncated), undefined);
    assert.strictEqual(
      parseCertificateDer(Buffer.from([0x30, 0x82, 0xff, 0xff, 0x00])),
      undefined,
    );
    assert.strictEqual(parseCertificateDer(Buffer.alloc(0)), undefined);
    assert.strictEqual(
      parseCertificateDer(Buffer.from("not der at all")),
      undefined,
    );
    // A huge declared length must not be followed.
    const bomb = Buffer.concat([
      Buffer.from([0x30, 0x84, 0x7f, 0xff, 0xff, 0xff]),
      Buffer.alloc(16),
    ]);
    assert.strictEqual(parseCertificateDer(bomb), undefined);
  });

  it("rejects input over the size cap", () => {
    assert.strictEqual(
      parseCertificateDer(Buffer.alloc(2 * 1024 * 1024, 0x30)),
      undefined,
    );
  });
});

describe("keyAlgorithmName() / signatureAlgorithmName()", () => {
  it("names post-quantum algorithms from the table", () => {
    assert.strictEqual(
      keyAlgorithmName({ oid: "2.16.840.1.101.3.4.3.18" }),
      "ML-DSA-65",
    );
    assert.strictEqual(
      keyAlgorithmName({ oid: "2.16.840.1.101.3.4.3.20" }),
      "SLH-DSA-SHA2-128s",
    );
    assert.strictEqual(
      keyAlgorithmName({ oid: "2.16.840.1.101.3.4.4.2" }),
      "ML-KEM-768",
    );
    assert.strictEqual(
      signatureAlgorithmName({ oid: "2.16.840.1.101.3.4.3.17" }),
      "ML-DSA-44",
    );
  });

  it("names classical algorithms with sizes", () => {
    assert.strictEqual(
      keyAlgorithmName({ oid: "1.2.840.113549.1.1.1", bits: 2048 }),
      "RSA-2048",
    );
    assert.strictEqual(
      keyAlgorithmName({
        oid: "1.2.840.10045.2.1",
        curveOid: "1.2.840.10045.3.1.7",
      }),
      "ECDSA-P256",
    );
    assert.strictEqual(keyAlgorithmName({ oid: "1.3.101.112" }), "Ed25519");
    assert.strictEqual(
      signatureAlgorithmName({ oid: "1.2.840.113549.1.1.11" }),
      "SHA256-RSA",
    );
  });

  it("names unknown algorithms by their dotted OID, never '0'", () => {
    assert.strictEqual(
      keyAlgorithmName({ oid: "2.16.840.1.114027.80.6.2" }),
      "2.16.840.1.114027.80.6.2",
    );
    assert.strictEqual(
      signatureAlgorithmName({ oid: "2.16.840.1.114027.80.6.2" }),
      "2.16.840.1.114027.80.6.2",
    );
  });
});

describe("certRecordFromDer() on generated fixtures", () => {
  it("builds records with roles, keys and subject names", () => {
    const records = [
      certRecordFromDer(pemBlocks("rootA.crt")[0], {
        location: "/rootA",
        sourceType: "ca-store",
      }),
      certRecordFromDer(pemBlocks("intA.crt")[0], {
        location: "/intA",
        sourceType: "ca-store",
      }),
      certRecordFromDer(pemBlocks("leaf.crt")[0], {
        location: "/leaf",
        sourceType: "server-config",
      }),
    ];
    assert.strictEqual(records[0].role, "root");
    assert.strictEqual(records[0].selfSigned, true);
    assert.strictEqual(records[1].role, "intermediate");
    assert.strictEqual(records[2].role, "leaf");
    assert.strictEqual(records[2].subject, "CN=api.example.test");
    assert.strictEqual(records[2].issuer, "CN=Shady Issuing CA 1,O=Shady CA");
    assert.strictEqual(records[2].keyName, "RSA-2048");
    assert.strictEqual(records[2].signatureAlgorithm, "SHA256-RSA");
    assert.ok(records[2].serialHex);
    assert.ok(!records[2].serialHex.includes(":"));
    linkFallbackIssuers(records);
    assert.deepStrictEqual(records[2].issuers, [records[1].certSha256]);
    assert.deepStrictEqual(records[1].issuers, [records[0].certSha256]);
  });

  it("gives cross-signed twins one SPKI", () => {
    const intA = certRecordFromDer(pemBlocks("intA.crt")[0], {
      location: "/a",
    });
    const intB = certRecordFromDer(pemBlocks("intB.crt")[0], {
      location: "/b",
    });
    assert.strictEqual(intA.spkiSha256, intB.spkiSha256);
    assert.notStrictEqual(intA.certSha256, intB.certSha256);
  });

  it("classifies the SHA-1 root as a root, not an intermediate", () => {
    const sha1Root = certRecordFromDer(pemBlocks("sha1-root.pem")[0], {
      location: "/sha1",
    });
    assert.strictEqual(sha1Root.role, "root");
    assert.strictEqual(sha1Root.signatureAlgorithm, "SHA1-RSA");
  });

  it("names post-quantum certificates from their OIDs", () => {
    const root = certRecordFromDer(pemBlocks("mldsa65-root.pem")[0], {
      location: "/pq",
    });
    const intermediate = certRecordFromDer(pemBlocks("mldsa44-int.pem")[0], {
      location: "/pq",
    });
    const ecdsaLeaf = certRecordFromDer(pemBlocks("ecdsa-leaf.pem")[0], {
      location: "/pq",
    });
    const kemLeaf = certRecordFromDer(pemBlocks("mlkem768-leaf.pem")[0], {
      location: "/pq",
    });
    const slhRoot = certRecordFromDer(pemBlocks("slhdsa-root.pem")[0], {
      location: "/pq",
    });
    assert.strictEqual(root.keyName, "ML-DSA-65");
    assert.strictEqual(root.signatureAlgorithm, "ML-DSA-65");
    assert.strictEqual(intermediate.keyName, "ML-DSA-44");
    assert.strictEqual(ecdsaLeaf.keyName, "ECDSA-P256");
    assert.strictEqual(kemLeaf.keyName, "ML-KEM-768");
    assert.strictEqual(kemLeaf.signatureAlgorithm, "ML-DSA-44");
    assert.strictEqual(slhRoot.keyName, "SLH-DSA-SHA2-128s");
    // SLH-DSA cannot be verified by every runtime; the self-issued fallback
    // still makes it a root.
    assert.strictEqual(slhRoot.role, "root");
    assert.strictEqual(slhRoot.selfSigned, true);
  });

  it("falls back to self-issued when verification throws", async () => {
    const { X509Certificate } = await import("node:crypto");
    const original = X509Certificate.prototype.verify;
    X509Certificate.prototype.verify = () => {
      throw new Error("unsupported algorithm");
    };
    try {
      const root = certRecordFromDer(pemBlocks("rootA.crt")[0], {
        location: "/r",
      });
      assert.strictEqual(root.selfSigned, true);
      assert.strictEqual(root.selfSignedUnverified, true);
      assert.strictEqual(root.role, "root");
    } finally {
      X509Certificate.prototype.verify = original;
    }
  });

  it("names a hand-mutated unknown OID by the OID itself", () => {
    // Not from a real issuer: the test flips the signature algorithm's last
    // OID arc (sha256WithRSA's .11) to an unassigned arc of the same encoded
    // length, so the DER stays well formed while the OID becomes unknown.
    const der = pemBlocks("leaf.crt")[0];
    const oidPattern = Buffer.from([
      0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b,
    ]);
    let last = -1;
    for (
      let at = der.indexOf(oidPattern);
      at !== -1;
      at = der.indexOf(oidPattern, at + 1)
    ) {
      last = at;
    }
    assert.ok(last > 0, "signature OID found in the certificate");
    const mutated = Buffer.from(der);
    mutated[last + oidPattern.length - 1] = 0x63;
    const record = certRecordFromDer(mutated, { location: "/mutated" });
    assert.strictEqual(record.signatureAlgorithmOid, "1.2.840.113549.1.1.99");
    assert.strictEqual(record.signatureAlgorithm, "1.2.840.113549.1.1.99");
  });
});

describe("CertificateCollector", () => {
  it("builds the contract model from report-2 materials", () => {
    const report = JSON.parse(
      readFileSync(join(FIXTURES, "report-2-rootfs.json"), "utf-8"),
    );
    assert.strictEqual(report.schema, "trustinspector/report-2");
    const collector = new CertificateCollector();
    collector.addTrustInspectorMaterials(report.materials);
    const { components, dependencies } = collector.build();
    const certificates = components.filter(
      (component) => component.cryptoProperties.assetType === "certificate",
    );
    assert.strictEqual(certificates.length, 5);
    const twins = certificates.filter(
      (component) => component.name === "Shady Issuing CA 1",
    );
    assert.strictEqual(twins.length, 2, "both twins survive (G2)");
    const keys = components.filter(
      (component) =>
        component.cryptoProperties.assetType === "related-crypto-material",
    );
    // Four distinct SPKIs: rootA, rootB, the shared intermediate key, leaf.
    assert.strictEqual(keys.length, 4);
    const sharedKey = keys.find(
      (component) =>
        component["bom-ref"].startsWith("crypto/public-key/") &&
        component.version ===
          twins[0].properties.find(
            (property) => property.name === "cdx:crypto:spkiSha256",
          ).value,
    );
    assert.ok(sharedKey, "twins share one public-key component");
    assert.ok(
      sharedKey.cryptoProperties.relatedCryptoMaterialProperties.fingerprint
        .content,
    );
    // Leaf depends on both twins; each twin depends on its own root.
    const leaf = certificates.find(
      (component) => component.name === "api.example.test",
    );
    const leafEdge = dependencies.find(
      (dependency) => dependency.ref === leaf["bom-ref"],
    );
    assert.strictEqual(leafEdge.dependsOn.length, 2);
    const issuerSpkis = leaf.properties.filter(
      (property) => property.name === "cdx:crypto:issuerSpkiSha256",
    );
    assert.strictEqual(issuerSpkis.length, 1, "one key, one property");
    const extensions =
      leaf.cryptoProperties.certificateProperties.certificateExtensions;
    assert.deepStrictEqual(
      extensions
        .map((extension) => extension.commonExtensionName)
        .filter(Boolean),
      [
        // No fabricated basicConstraints: the fallback knows the leaf is not
        // a CA, but not that the certificate carries the extension.
        "keyUsage",
        "extendedKeyUsage",
        "subjectKeyIdentifier",
        "authorityKeyIdentifier",
        "subjectAlternativeName",
      ],
    );
    // Determinism: a second build is byte-identical.
    const again = new CertificateCollector();
    again.addTrustInspectorMaterials(report.materials);
    assert.deepStrictEqual(
      JSON.stringify(again.build()),
      JSON.stringify({ components, dependencies }),
    );
  });

  it("keeps report-1 input working with cert-hash bom-refs", () => {
    const report = JSON.parse(
      readFileSync(join(FIXTURES, "report-1-rootfs.json"), "utf-8"),
    );
    const collector = new CertificateCollector();
    collector.addTrustInspectorMaterials(report.materials);
    const { components } = collector.build();
    const certificates = components.filter(
      (component) => component.cryptoProperties.assetType === "certificate",
    );
    assert.ok(certificates.length >= 3);
    for (const certificate of certificates) {
      assert.match(
        certificate["bom-ref"],
        /^crypto\/certificate\/.+@sha256:[0-9a-f]{64}$/,
      );
      assert.ok(!certificate["bom-ref"].includes("undefined"));
    }
    assert.strictEqual(
      components.filter(
        (component) =>
          component.cryptoProperties.assetType === "related-crypto-material",
      ).length,
      0,
      "report-1 has no SPKI, so no public-key components",
    );
  });

  it("deduplicates certificates across producers with merged occurrences", () => {
    const report = JSON.parse(
      readFileSync(join(FIXTURES, "report-2-rootfs.json"), "utf-8"),
    );
    const collector = new CertificateCollector();
    const fallback = certRecordFromDer(pemBlocks("rootA.crt")[0], {
      location: "/extra/location.crt",
      sourceType: "generic",
    });
    collector.addRecords([fallback]);
    collector.addTrustInspectorMaterials(report.materials);
    const { components } = collector.build();
    const rootA = components.find(
      (component) => component.name === "Demo Root A",
    );
    const locations = rootA.evidence.occurrences.map((o) => o.location);
    assert.ok(locations.includes("/extra/location.crt"));
    assert.ok(locations.includes("/etc/ssl/certs/ca-certificates.crt"));
    assert.strictEqual(
      locations.length,
      new Set(locations).size,
      "occurrences are deduplicated and sorted",
    );
  });

  it("records Android pins as public-key components", () => {
    const pins = androidNetworkSecurityConfigPins(
      readFileSync(join(GENERATED, "network_security_config.xml"), "utf-8"),
      { file: "/res/xml/network_security_config.xml" },
    );
    assert.strictEqual(pins.length, 1);
    const collector = new CertificateCollector();
    collector.addPin(pins[0]);
    const { components } = collector.build();
    const pinKey = components.find(
      (component) =>
        component.cryptoProperties.assetType === "related-crypto-material",
    );
    assert.strictEqual(prop(pinKey, "cdx:crypto:sourceType"), "pin");
    assert.strictEqual(
      pinKey.cryptoProperties.relatedCryptoMaterialProperties.size,
      undefined,
    );
    assert.deepStrictEqual(pinKey.evidence.occurrences, [
      { location: "/res/xml/network_security_config.xml" },
    ]);
  });

  it("parses kubernetes TLS secrets without touching tls.key", () => {
    const records = kubernetesTlsSecretRecords(
      readFileSync(join(GENERATED, "tls-secret.yaml"), "utf-8"),
      { file: "/deploy/tls-secret.yaml" },
    );
    assert.strictEqual(records.length, 2);
    assert.deepStrictEqual(
      records.map((record) => record.occurrences[0].location),
      [
        "/deploy/tls-secret.yaml#data.tls.crt",
        "/deploy/tls-secret.yaml#data.tls.crt",
      ],
    );
    assert.ok(records.every((record) => record.k8sSecretName === "api-tls"));
    const yamlText = readFileSync(join(GENERATED, "tls-secret.yaml"), "utf-8");
    assert.ok(!yamlText.includes("tls.key"), "fixture never carries tls.key");
  });
});

describe("classifyCryptoFile()", () => {
  it("classifies bundles, keys, keystores and unknown content", () => {
    assert.strictEqual(
      classifyCryptoFile(readFixture("ca-certificates.crt")).kind,
      "certificates",
    );
    assert.strictEqual(
      classifyCryptoFile(readFixture("twins-bundle.crt")).ders.length,
      3,
    );
    assert.deepStrictEqual(
      classifyCryptoFile(readFixture("fullchain.pem")).ders.length,
      2,
    );
    const privkey = Buffer.concat([
      Buffer.from("-----BEGIN PRIVATE KEY-----\n"),
      Buffer.from("A".repeat(64), "utf-8"),
      Buffer.from("\n-----END PRIVATE KEY-----\n"),
    ]);
    assert.deepStrictEqual(classifyCryptoFile(privkey), {
      kind: "private-key",
      format: "PKCS8",
    });
    assert.strictEqual(
      classifyCryptoFile(readFixture("cacerts.p12")).kind,
      "keystore",
    );
    assert.strictEqual(
      classifyCryptoFile(readFixture("cacerts.p12")).format,
      "PKCS12",
    );
    assert.strictEqual(
      classifyCryptoFile(Buffer.from([0xfe, 0xed, 0xfe, 0xed, 0, 0, 0, 1]))
        .format,
      "JKS",
    );
    assert.strictEqual(
      classifyCryptoFile(Buffer.from([0xce, 0xce, 0xce, 0xce, 0, 0, 0, 1]))
        .format,
      "JCEKS",
    );
    assert.strictEqual(
      classifyCryptoFile(Buffer.from("plain text")).kind,
      "unknown",
    );
  });

  it("never throws on hostile input", () => {
    assert.doesNotThrow(() => classifyCryptoFile(Buffer.alloc(0)));
    assert.doesNotThrow(() =>
      classifyCryptoFile(Buffer.from([0x30, 0x82, 0xff, 0xff])),
    );
    assert.doesNotThrow(() =>
      classifyCryptoFile(
        Buffer.from(
          "-----BEGIN CERTIFICATE-----\nzzzz\n-----END CERTIFICATE-----\n",
        ),
      ),
    );
  });

  it("bounds OID decoding on an unterminated subidentifier", () => {
    // SEQUENCE { SEQUENCE { OBJECT IDENTIFIER } }, the PKCS #7 shape, with a
    // 400,000-byte OID whose every byte but the last carries the
    // continuation bit: one subidentifier that never closes.
    const oidLength = 400_000;
    const oid = Buffer.alloc(oidLength, 0xff);
    oid[oidLength - 1] = 0x7f;
    const lengthOf = (n) =>
      Buffer.from([0x83, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
    const inner = Buffer.concat([
      Buffer.from([0x06]),
      lengthOf(oidLength),
      oid,
    ]);
    const middle = Buffer.concat([
      Buffer.from([0x30]),
      lengthOf(inner.length),
      inner,
    ]);
    const der = Buffer.concat([
      Buffer.from([0x30]),
      lengthOf(middle.length),
      middle,
    ]);
    const started = performance.now();
    const classification = classifyCryptoFile(der);
    const elapsed = performance.now() - started;
    assert.strictEqual(classification.kind, "unknown");
    assert.ok(elapsed < 5000, `took ${elapsed} ms for ${der.length} bytes`);
  });
});

describe("mergeDuplicateCryptoComponents()", () => {
  it("merges same-ref crypto components, unioning occurrences", () => {
    const left = {
      "bom-ref": "crypto/certificate/a@sha256:x",
      type: "cryptographic-asset",
      cryptoProperties: { assetType: "certificate" },
      evidence: { occurrences: [{ location: "/one" }] },
      properties: [{ name: "cdx:crypto:certRole", value: "root" }],
    };
    const right = {
      "bom-ref": "crypto/certificate/a@sha256:x",
      type: "cryptographic-asset",
      cryptoProperties: { assetType: "certificate" },
      evidence: { occurrences: [{ location: "/two" }, { location: "/one" }] },
      properties: [{ name: "cdx:crypto:isCA", value: "true" }],
    };
    const merged = mergeDuplicateCryptoComponents([left, right]);
    assert.strictEqual(merged.length, 1);
    assert.deepStrictEqual(
      merged[0].evidence.occurrences.map((o) => o.location),
      ["/one", "/two"],
    );
    assert.strictEqual(merged[0].properties.length, 2);
  });
});

describe("secrets never reach the output", () => {
  it("emits no private-key material from any producer", () => {
    const report = JSON.parse(
      readFileSync(join(FIXTURES, "report-2-rootfs.json"), "utf-8"),
    );
    const collector = new CertificateCollector();
    collector.addTrustInspectorMaterials(report.materials);
    const output = JSON.stringify(collector.build());
    assert.ok(!output.includes("PRIVATE KEY"));
    assert.ok(!output.includes("BEGIN RSA"));
    assert.ok(!output.includes("changeit"));
    // The private-key material contributes only its path and header format.
    const privateKey = report.materials.find((m) => m.kind === "private-key");
    assert.ok(privateKey);
    assert.ok(Object.keys(privateKey).includes("format"));
    assert.strictEqual(privateKey.path, "/etc/nginx/ssl/privkey.pem");
  });
});

describe("review regressions", () => {
  it("a corrupted self-signed root is not reported as self-signed", () => {
    const der = Buffer.from(pemBlocks("rootA.crt")[0]);
    // Corrupt two signature bytes without breaking the DER structure.
    const corrupted = Buffer.from(der);
    corrupted[corrupted.length - 3] ^= 0xff;
    corrupted[corrupted.length - 5] ^= 0xff;
    const record = certRecordFromDer(corrupted, { location: "/corrupted" });
    assert.strictEqual(record.selfSigned, false);
    assert.strictEqual(record.selfSignedUnverified, undefined);
    assert.strictEqual(record.role, "intermediate");
  });

  it("one algorithm component per OID across mixed key sizes", async () => {
    const { execFileSync } = await import("node:child_process");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const work = mkdtempSync(join(tmpdir(), "cdxgen-mixed-"));
    try {
      const opensslBin = process.env.OPENSSL_BIN || "openssl";
      const keyPath = join(work, "k.key");
      execFileSync(
        opensslBin,
        [
          "genpkey",
          "-algorithm",
          "RSA",
          "-pkeyopt",
          "rsa_keygen_bits:1024",
          "-out",
          keyPath,
        ],
        { stdio: "ignore" },
      );
      execFileSync(
        opensslBin,
        [
          "req",
          "-x509",
          "-new",
          "-key",
          keyPath,
          "-subj",
          "/CN=Tiny Root",
          "-days",
          "30",
          "-out",
          join(work, "tiny.pem"),
        ],
        { stdio: "ignore" },
      );
      const tinyDer = pemCertificateDerBlocks(
        readFileSync(join(work, "tiny.pem"), "utf-8"),
      )[0];
      const collector = new CertificateCollector();
      collector.addRecords([
        certRecordFromDer(pemBlocks("rootA.crt")[0], { location: "/a" }),
        certRecordFromDer(tinyDer, { location: "/b" }),
      ]);
      const { components } = collector.build();
      const rsaAlgorithms = components.filter(
        (component) =>
          component.cryptoProperties.assetType === "algorithm" &&
          component.cryptoProperties.oid === "1.2.840.113549.1.1.1",
      );
      assert.strictEqual(
        rsaAlgorithms.length,
        1,
        "one RSA algorithm component",
      );
      assert.strictEqual(rsaAlgorithms[0].name, "RSA");
      const refs = new Set(components.map((component) => component["bom-ref"]));
      for (const component of components) {
        const algorithmRef =
          component.cryptoProperties?.relatedCryptoMaterialProperties
            ?.algorithmRef;
        if (algorithmRef) {
          assert.ok(
            refs.has(algorithmRef),
            `algorithmRef ${algorithmRef} resolves`,
          );
        }
        for (const asset of component.cryptoProperties?.certificateProperties
          ?.relatedCryptographicAssets || []) {
          assert.ok(refs.has(asset.ref), `related asset ${asset.ref} resolves`);
        }
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("sizes EC keys the point walk cannot name", async () => {
    const { execFileSync } = await import("node:child_process");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const work = mkdtempSync(join(tmpdir(), "cdxgen-p384-"));
    try {
      const opensslBin = process.env.OPENSSL_BIN || "openssl";
      execFileSync(
        opensslBin,
        [
          "req",
          "-x509",
          "-newkey",
          "ec",
          "-pkeyopt",
          "ec_paramgen_curve:P-384",
          "-nodes",
          "-keyout",
          join(work, "k.key"),
          "-subj",
          "/CN=P384 Root",
          "-days",
          "30",
          "-out",
          join(work, "p384.pem"),
        ],
        { stdio: "ignore" },
      );
      const der = pemCertificateDerBlocks(
        readFileSync(join(work, "p384.pem"), "utf-8"),
      )[0];
      const record = certRecordFromDer(der, { location: "/p384" });
      assert.strictEqual(record.keyName, "ECDSA-P384");
      assert.strictEqual(record.keyBits, 384);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("names ECDSA curves only from the real curve table", () => {
    assert.strictEqual(
      keyAlgorithmName({
        oid: "1.2.840.10045.2.1",
        curveOid: "1.2.840.10045.3.1.5",
      }),
      "ECDSA-P239",
    );
    assert.strictEqual(
      keyAlgorithmName({ oid: "1.2.840.10045.2.1", curveOid: "1.3.132.0.34" }),
      "ECDSA-P384",
    );
  });

  it("classifies a DER certificate with an unknown key OID", () => {
    const der = Buffer.from(pemBlocks("rootA.crt")[0]);
    const mutated = Buffer.from(der);
    const oidPattern = Buffer.from([
      0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
    ]);
    mutated[der.indexOf(oidPattern) + oidPattern.length - 1] = 0x3d;
    const classification = classifyCryptoFile(mutated);
    assert.strictEqual(classification.kind, "certificates");
    const record = certRecordFromDer(mutated, { location: "/x" });
    assert.strictEqual(record.keyName, "1.2.840.113549.1.1.61");
  });

  it("keeps repeatable issuer properties through component merges", () => {
    const left = {
      "bom-ref": "crypto/certificate/leaf@sha256:x",
      type: "cryptographic-asset",
      cryptoProperties: { assetType: "certificate" },
      evidence: { occurrences: [{ location: "/one" }] },
      properties: [
        { name: "cdx:crypto:issuerSpkiSha256", value: "11" },
        { name: "cdx:crypto:spkiSha256", value: "aa" },
      ],
    };
    const right = {
      "bom-ref": "crypto/certificate/leaf@sha256:x",
      type: "cryptographic-asset",
      cryptoProperties: { assetType: "certificate" },
      evidence: { occurrences: [{ location: "/two" }] },
      properties: [
        { name: "cdx:crypto:issuerSpkiSha256", value: "22" },
        { name: "cdx:crypto:issuerSpkiSha256", value: "11" },
      ],
    };
    const merged = mergeDuplicateCryptoComponents([left, right]);
    const issuers = merged[0].properties
      .filter((property) => property.name === "cdx:crypto:issuerSpkiSha256")
      .map((property) => property.value);
    assert.deepStrictEqual(issuers, ["11", "22"]);
  });

  it("deduplicates pin occurrences and rejects non-32-byte pins", () => {
    const collector = new CertificateCollector();
    collector.addPin({ spkiSha256: "aa", location: "/pin.xml" });
    collector.addPin({ spkiSha256: "aa", location: "/pin.xml" });
    collector.addPin({ spkiSha256: "bb", location: "/other.xml" });
    const { components } = collector.build();
    const pinned = components.filter(
      (component) =>
        component.cryptoProperties.assetType === "related-crypto-material",
    );
    const aa = pinned.find((component) => component.version === "aa");
    assert.strictEqual(aa.evidence.occurrences.length, 1);
    assert.strictEqual(pinned.length, 2);
    // A pin block with a digest that is not 32 bytes is ignored.
    const pins = androidNetworkSecurityConfigPins(
      `<?xml version="1.0"?>
       <network-security-config><pin-set>
         <pin digest="SHA-256">${Buffer.alloc(64).fill(1).toString("base64")}</pin>
         <pin digest="SHA-1">AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=</pin>
       </pin-set></network-security-config>`,
      { file: "/x.xml" },
    );
    assert.strictEqual(pins.length, 0);
  });

  it("drops file hashes once a certificate merges across locations", () => {
    const collector = new CertificateCollector();
    const fromReport = certRecordFromDer(pemBlocks("rootA.crt")[0], {
      location: "/one",
      sourceType: "ca-store",
    });
    collector.addRecords([fromReport]);
    const second = certRecordFromDer(pemBlocks("rootA.crt")[0], {
      location: "/two",
      sourceType: "server-config",
    });
    second.hashes = [{ alg: "SHA-256", content: "ab" }];
    collector.addRecords([second]);
    const { components } = collector.build();
    const rootA = components.find(
      (component) => component.name === "Demo Root A",
    );
    assert.strictEqual(rootA.evidence.occurrences.length, 2);
    assert.strictEqual(
      rootA.hashes,
      undefined,
      "hashes describe one file only",
    );
  });

  it("rejects materials whose digests are not SHA-256 length", () => {
    const collector = new CertificateCollector();
    collector.addTrustInspectorMaterials([
      { kind: "certificate", certSha256: "deadbeef", path: "/short.pem" },
      { kind: "certificate", certSha256: "z".repeat(64), path: "/nonhex.pem" },
    ]);
    const { components } = collector.build();
    assert.strictEqual(
      components.filter(
        (component) => component.cryptoProperties?.assetType === "certificate",
      ).length,
      0,
    );
  });

  it("ignores non-string and non-boolean material fields", () => {
    const collector = new CertificateCollector();
    collector.addTrustInspectorMaterials([
      {
        kind: "certificate",
        certSha256: "a".repeat(64),
        subject: 12345,
        issuer: null,
        name: "",
        isCA: "yes",
        path: "/hostile.pem",
      },
    ]);
    const { components } = collector.build();
    const certificate = components.find(
      (component) => component.cryptoProperties.assetType === "certificate",
    );
    assert.strictEqual(
      certificate.cryptoProperties.certificateProperties.subjectName,
      undefined,
    );
    assert.strictEqual(
      certificate.cryptoProperties.certificateProperties.issuerName,
      undefined,
    );
    assert.ok(certificate.name);
  });
});

describe("second review regressions", () => {
  it("keeps an RFC 4514 escaped comma inside the common name", () => {
    assert.strictEqual(commonNameFromDn("CN=Foo\\, Inc,O=Acme"), "Foo, Inc");
    assert.strictEqual(commonNameFromDn("O=Acme\nCN=Foo\\, Inc"), "Foo, Inc");
  });
  it("names a plugin certificate without a CN as the Node reader does, not after its country", () => {
    // The material trustinspector 4.2.0 reports for the Mozilla root
    // AC RAIZ FNMT-RCM in an Alpine CA bundle.
    const material = {
      kind: "certificate",
      name: "ES",
      subject: "OU=AC RAIZ FNMT-RCM,O=FNMT-RCM,C=ES",
      issuer: "OU=AC RAIZ FNMT-RCM,O=FNMT-RCM,C=ES",
      sha256:
        "ebc5570c29018c4d67b1aa127baf12f703b4611ebc17b7dab5573894179b93fa",
      path: "/etc/ssl/certs/ca-certificates.crt",
    };
    assert.strictEqual(
      certRecordFromTrustInspector(material).name,
      "AC RAIZ FNMT-RCM",
    );
    assert.strictEqual(
      certRecordFromTrustInspector({
        ...material,
        name: "Leaf",
        subject: "CN=Leaf,O=Acme",
      }).name,
      "Leaf",
    );
    // With no subject to name it, the plugin's name stands.
    assert.strictEqual(
      certRecordFromTrustInspector({ ...material, subject: undefined }).name,
      "ES",
    );
  });
  it("merges duplicate components without keeping one file's digests", () => {
    const a = {
      type: "cryptographic-asset",
      "bom-ref": "crypto/certificate/x@sha256:00",
      hashes: [{ alg: "SHA-256", content: "11" }],
      evidence: { occurrences: [{ location: "/a" }, { line: 3 }] },
    };
    const b = {
      type: "cryptographic-asset",
      "bom-ref": "crypto/certificate/x@sha256:00",
      hashes: [{ alg: "SHA-256", content: "22" }],
      evidence: { occurrences: [{ location: "/b" }] },
    };
    const [merged] = mergeDuplicateCryptoComponents([a, b]);
    assert.deepStrictEqual(
      merged.evidence.occurrences.map((o) => o.location),
      ["/a", "/b"],
    );
    assert.strictEqual(merged.hashes, undefined);
  });
  it("re-points internal:SrcFile at the first sorted occurrence after a merge", () => {
    // An observed-tls certificate merged with its on-disk twin: occurrences
    // sort the file path first, and SrcFile must agree with them.
    const observed = {
      type: "cryptographic-asset",
      "bom-ref": "crypto/certificate/x@sha256:00",
      properties: [{ name: "internal:SrcFile", value: "tls://a.test:443" }],
      evidence: { occurrences: [{ location: "tls://a.test:443" }] },
    };
    const onDisk = {
      type: "cryptographic-asset",
      "bom-ref": "crypto/certificate/x@sha256:00",
      properties: [
        { name: "internal:SrcFile", value: "/etc/ssl/certs/ca.crt" },
        { name: "cdx:crypto:issuerSpkiSha256", value: "ff".repeat(32) },
      ],
      evidence: { occurrences: [{ location: "/etc/ssl/certs/ca.crt" }] },
    };
    const [merged] = mergeDuplicateCryptoComponents([observed, onDisk]);
    assert.strictEqual(
      merged.properties.find((p) => p.name === "internal:SrcFile").value,
      "/etc/ssl/certs/ca.crt",
    );
    // The disk producer's issuer property still merges in.
    assert.strictEqual(
      merged.properties.find((p) => p.name === "cdx:crypto:issuerSpkiSha256")
        .value,
      "ff".repeat(32),
    );
  });
});

// The observed-chain fixtures safer-exec 1.2.0 really produced against the
// generated servers (test/data/tracebom-chain/README.md). The chain entries
// are the server's own claim about itself, so these tests also pin the
// untrusted-input handling.
const TRACEBOM_CHAIN = join("test", "data", "tracebom-chain");

function readTracebomCryptoResult() {
  return JSON.parse(
    readFileSync(join(TRACEBOM_CHAIN, "crypto-result.json"), "utf-8"),
  );
}

// The cipher entry whose chain contains a certificate with the given name.
function tracebomChainEntryByCertName(name) {
  for (const cipher of readTracebomCryptoResult().ciphers) {
    const entry = (cipher.chain || []).find(
      (chainEntry) => chainEntry.name === name,
    );
    if (entry) {
      return { cipher, entry };
    }
  }
  return assert.fail(`no chain entry named ${name} in the fixture`);
}

describe("certRecordFromObservedChainEntry()", () => {
  it("maps every field of a real observed leaf", () => {
    const { cipher, entry } = tracebomChainEntryByCertName("localhost");
    // The TLS 1.3 server presents no chain at all, so this entry is TLS 1.2.
    assert.strictEqual(cipher.protocol, "TLSv1.2");
    const record = certRecordFromObservedChainEntry(entry, {
      host: cipher.host,
    });
    assert.ok(record);
    assert.match(record.certSha256, /^[0-9a-f]{64}$/);
    assert.match(record.spkiSha256, /^[0-9a-f]{64}$/);
    assert.strictEqual(record.subject, entry.subject);
    assert.strictEqual(record.issuer, entry.issuer);
    assert.strictEqual(record.name, "localhost");
    assert.strictEqual(record.serialHex, entry.serialNumber);
    assert.strictEqual(record.notValidBefore, entry.notValidBefore);
    assert.strictEqual(record.notValidAfter, entry.notValidAfter);
    assert.strictEqual(record.version, 3);
    assert.strictEqual(record.signatureAlgorithm, entry.signatureAlgorithm);
    assert.strictEqual(
      record.signatureAlgorithmOid,
      entry.signatureAlgorithmOid,
    );
    assert.strictEqual(record.keyName, entry.keyName);
    assert.strictEqual(record.keyBits, entry.keyBits);
    assert.strictEqual(record.role, "leaf");
    assert.deepStrictEqual(record.occurrences, [
      { location: `tls://${cipher.host}`, sourceType: "observed-tls" },
    ]);
    assert.deepStrictEqual(record.sourceTypes, ["observed-tls"]);
  });

  it("agrees with the on-disk parse of the same certificate", () => {
    // Both chains have a leaf named localhost, so the fixture entries are
    // matched by the certificate hash of the committed PEM.
    const cryptoResult = readTracebomCryptoResult();
    const chainEntries = cryptoResult.ciphers.flatMap(
      (cipher) => cipher.chain || [],
    );
    for (const pem of [
      "c-leaf.pem",
      "c-int.pem",
      "c-root.pem",
      "h-leaf.pem",
      "h-int.pem",
      "h-root.pem",
    ]) {
      const onDisk = certRecordFromDer(
        pemCertificateDerBlocks(
          readFileSync(join(TRACEBOM_CHAIN, pem), "utf-8"),
        )[0],
        { location: "/etc/ssl/certs/ca.crt", sourceType: "ca-store" },
      );
      assert.ok(onDisk, pem);
      const entry = chainEntries.find(
        (chainEntry) => chainEntry.certSha256 === onDisk.certSha256,
      );
      assert.ok(entry, `${pem} missing from the observed chains`);
      const observed = certRecordFromObservedChainEntry(entry, {
        host: "localhost:9440",
      });
      // Same identity, so the same bom-ref and one merged component.
      assert.strictEqual(observed.certSha256, onDisk.certSha256, pem);
      assert.strictEqual(observed.spkiSha256, onDisk.spkiSha256, pem);
      assert.strictEqual(observed.serialHex, onDisk.serialHex, pem);
      assert.strictEqual(observed.subject, onDisk.subject, pem);
      assert.strictEqual(observed.keyName, onDisk.keyName, pem);
      assert.strictEqual(observed.role, onDisk.role, pem);
      assert.strictEqual(observed.name, onDisk.name, pem);
    }
  });

  it("classifies root, intermediate and leaf from the server's claim", () => {
    const leaf = certRecordFromObservedChainEntry(
      tracebomChainEntryByCertName("localhost").entry,
      {},
    );
    const intermediate = certRecordFromObservedChainEntry(
      tracebomChainEntryByCertName("Tracebom Test Intermediate").entry,
      {},
    );
    const root = certRecordFromObservedChainEntry(
      tracebomChainEntryByCertName("Tracebom Test Root").entry,
      {},
    );
    assert.strictEqual(leaf.role, "leaf");
    // safer-exec omits a false selfSigned (Go omitempty), so a non-self-
    // signed claim stays unset rather than asserted as false.
    assert.strictEqual(leaf.selfSigned, undefined);
    assert.strictEqual(intermediate.role, "intermediate");
    assert.strictEqual(root.role, "root");
    assert.strictEqual(root.selfSigned, true);
    assert.strictEqual(root.selfSignedUnverified, undefined);
  });

  it("marks a self-signed claim the observer could not verify", () => {
    const record = certRecordFromObservedChainEntry(
      {
        certSha256: "ab".repeat(32),
        selfSigned: true,
        selfSignedUnverified: true,
        isCA: true,
      },
      {},
    );
    assert.strictEqual(record.role, "root");
    assert.strictEqual(record.selfSignedUnverified, true);
  });

  it("keeps a version 1 self-signed claim a root", () => {
    const record = certRecordFromObservedChainEntry(
      { certSha256: "cd".repeat(32), selfSigned: true, version: 1 },
      {},
    );
    assert.strictEqual(record.role, "root");
  });

  it("rejects entries without a usable certificate hash", () => {
    assert.strictEqual(
      certRecordFromObservedChainEntry({ subject: "CN=x" }, {}),
      undefined,
    );
    assert.strictEqual(certRecordFromObservedChainEntry(null, {}), undefined);
    assert.strictEqual(
      certRecordFromObservedChainEntry({ certSha256: "nothex" }, {}),
      undefined,
    );
    assert.strictEqual(
      certRecordFromObservedChainEntry({ certSha256: "ab" }, {}),
      undefined,
    );
  });

  it("ignores junk fields instead of throwing", () => {
    const record = certRecordFromObservedChainEntry(
      {
        certSha256: "AB".repeat(32),
        spkiSha256: 42,
        subject: ["not", "a", "string"],
        issuer: { evil: true },
        serialNumber: "zz",
        version: "3",
        notValidBefore: "not a date",
        notValidAfter: Number.NaN,
        keyBits: "2048",
        isCA: "yes",
        selfSigned: 1,
        keyName: 65,
        signatureAlgorithm: null,
        spkiSha256Base64: false,
      },
      { host: "  example.test:443  " },
    );
    assert.strictEqual(record.certSha256, "ab".repeat(32));
    assert.strictEqual(record.spkiSha256, undefined);
    assert.strictEqual(record.subject, undefined);
    assert.strictEqual(record.serialHex, undefined);
    assert.strictEqual(record.version, undefined);
    assert.strictEqual(record.notValidBefore, undefined);
    assert.strictEqual(record.notValidAfter, undefined);
    assert.strictEqual(record.keyBits, undefined);
    assert.strictEqual(record.isCA, undefined);
    assert.strictEqual(record.selfSigned, undefined);
    assert.strictEqual(record.keyName, undefined);
    assert.strictEqual(record.signatureAlgorithm, undefined);
    assert.strictEqual(record.spkiSha256Base64, undefined);
    assert.strictEqual(record.role, "leaf");
    assert.deepStrictEqual(record.occurrences, [
      { location: "tls://example.test:443", sourceType: "observed-tls" },
    ]);
  });

  it("omits the occurrence when the connection has no host", () => {
    const record = certRecordFromObservedChainEntry(
      { certSha256: "ef".repeat(32) },
      {},
    );
    assert.deepStrictEqual(record.occurrences, []);
    assert.strictEqual(record.sourceTypes, undefined);
  });
});

describe("multi-valued cdx:crypto:sourceType", () => {
  const sourceTypes = (component) =>
    component.properties
      .filter((p) => p.name === "cdx:crypto:sourceType")
      .map((p) => p.value);
  const certComponent = (sourceType, location) => {
    const collector = new CertificateCollector();
    collector.addRecord(
      certRecordFromDer(pemBlocks("rootA.crt")[0], { location, sourceType }),
    );
    return collector
      .build()
      .components.find((c) => c.cryptoProperties.assetType === "certificate");
  };

  it("keeps every producer's sourceType, sorted, whatever the merge order", () => {
    const disk = () => certComponent("ca-store", "/etc/ssl/certs/a.crt");
    const observed = () =>
      certComponent("observed-tls", "tls://example.test:443");
    const container = () => certComponent("java-truststore", "/opt/cacerts");
    const forward = mergeDuplicateCryptoComponents([
      disk(),
      observed(),
      container(),
    ]);
    const backward = mergeDuplicateCryptoComponents([
      container(),
      observed(),
      disk(),
    ]);
    assert.strictEqual(forward.length, 1);
    assert.deepStrictEqual(sourceTypes(forward[0]), [
      "ca-store",
      "java-truststore",
      "observed-tls",
    ]);
    assert.deepStrictEqual(sourceTypes(backward[0]), sourceTypes(forward[0]));
  });

  it("does not duplicate values when merging twice", () => {
    const once = mergeDuplicateCryptoComponents([
      certComponent("ca-store", "/a.crt"),
      certComponent("observed-tls", "tls://h:443"),
    ]);
    const twice = mergeDuplicateCryptoComponents([
      ...once,
      certComponent("observed-tls", "tls://h:443"),
      certComponent("ca-store", "/a.crt"),
    ]);
    assert.deepStrictEqual(sourceTypes(twice[0]), ["ca-store", "observed-tls"]);
  });

  it("a collector that sees one certificate from two producers records both", () => {
    const collector = new CertificateCollector();
    const der = pemBlocks("rootA.crt")[0];
    collector.addRecord(
      certRecordFromDer(der, { location: "/x", sourceType: "ca-store" }),
    );
    collector.addRecord(
      certRecordFromDer(der, {
        location: "tls://h:1",
        sourceType: "observed-tls",
      }),
    );
    const cert = collector
      .build()
      .components.find((c) => c.cryptoProperties.assetType === "certificate");
    assert.deepStrictEqual(sourceTypes(cert), ["ca-store", "observed-tls"]);
  });

  it("a public key that is both certified and pinned records both", () => {
    const collector = new CertificateCollector();
    const der = pemBlocks("intA.crt")[0];
    const record = certRecordFromDer(der, {
      location: "/x",
      sourceType: "ca-store",
    });
    collector.addRecord(record);
    collector.addPin({
      spkiSha256: record.spkiSha256,
      location: "/res/xml/n.xml",
    });
    const key = collector
      .build()
      .components.find(
        (c) => c.cryptoProperties.assetType === "related-crypto-material",
      );
    assert.deepStrictEqual(sourceTypes(key), ["certificate", "pin"]);
  });

  it("a rule matching on any sourceType value still matches", async () => {
    const { evaluateRule, loadRules } = await import(
      "../stages/postgen/ruleEngine.js"
    );
    const component = mergeDuplicateCryptoComponents([
      certComponent("ca-store", "/a.crt"),
      certComponent("observed-tls", "tls://h:443"),
    ])[0];
    const rule = {
      id: "TEST-SRC",
      name: "any sourceType",
      description: "d",
      severity: "low",
      category: "cbom-security",
      condition:
        "components[$hasProp($, 'cdx:crypto:sourceType', 'observed-tls') and 'ca-store' in $propValues($, 'cdx:crypto:sourceType')]",
      location: '{"bomRef": $."bom-ref"}',
      message: "m",
    };
    assert.ok(loadRules);
    const findings = await evaluateRule(rule, { components: [component] });
    assert.strictEqual(findings.length, 1);
  });
});

describe("kubernetes TLS secrets: stringData, locations, hostile input", () => {
  const pemText = (name) => readFileSync(join(GENERATED, name), "utf-8");
  const b64 = (text) => Buffer.from(text).toString("base64");
  const indent = (text) =>
    text
      .trimEnd()
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n");
  // Private key bodies are generated at test time and never committed.
  const fakeKeyBody = randomBytes(24).toString("base64");
  const fakeKey = `-----BEGIN PRIVATE KEY-----\n${fakeKeyBody}\n-----END PRIVATE KEY-----\n`;

  it("reads stringData as plain PEM and lets it win over data", () => {
    const yaml = `apiVersion: v1
kind: Secret
type: kubernetes.io/tls
metadata:
  name: both
data:
  tls.crt: ${b64(pemText("rootB.crt"))}
stringData:
  tls.crt: |
${indent(pemText("rootA.crt"))}
`;
    const records = kubernetesTlsSecretRecords(yaml, { file: "/s.yaml" });
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].subject.includes("Demo Root A"), true);
    assert.strictEqual(
      records[0].occurrences[0].location,
      "/s.yaml#stringData.tls.crt",
    );
  });

  it("gives tls.crt and ca.crt their own locations and keeps the file path", () => {
    const yaml = `kind: Secret
type: kubernetes.io/tls
metadata: {name: pair}
data:
  tls.crt: ${b64(pemText("leaf.crt"))}
  ca.crt: ${b64(pemText("rootA.crt"))}
`;
    const collector = new CertificateCollector();
    collector.addRecords(
      kubernetesTlsSecretRecords(yaml, { file: "/deploy/s.yaml" }),
    );
    const certs = collector
      .build()
      .components.filter((c) => c.cryptoProperties.assetType === "certificate");
    const locations = certs.flatMap((c) =>
      c.evidence.occurrences.map((o) => o.location),
    );
    assert.deepStrictEqual(locations.sort(), [
      "/deploy/s.yaml#data.ca.crt",
      "/deploy/s.yaml#data.tls.crt",
    ]);
    for (const cert of certs) {
      assert.strictEqual(prop(cert, "internal:SrcFile"), "/deploy/s.yaml");
      assert.strictEqual(prop(cert, "cdx:crypto:k8sSecretName"), "pair");
    }
  });

  it("never writes tls.key, its body or its name into the output", () => {
    const yaml = `kind: Secret
type: kubernetes.io/tls
metadata: {name: keyed}
data:
  tls.crt: ${b64(pemText("leaf.crt"))}
  tls.key: ${b64(fakeKey)}
stringData:
  tls.key: |
${indent(fakeKey)}
`;
    const collector = new CertificateCollector();
    collector.addRecords(kubernetesTlsSecretRecords(yaml, { file: "/s.yaml" }));
    const built = JSON.stringify(collector.build());
    assert.ok(built.includes("api.example.test"));
    assert.ok(!built.includes("tls.key"));
    assert.ok(!built.includes(fakeKeyBody));
    assert.ok(!built.includes(b64(fakeKey)));
    assert.ok(!built.includes("PRIVATE KEY"));
  });

  it("reads the documents around a malformed one", () => {
    const yaml = `kind: Secret
type: kubernetes.io/tls
metadata: {name: first}
data:
  tls.crt: ${b64(pemText("rootA.crt"))}
---
kind: [unclosed
type: {{ broken
---
kind: Secret
type: kubernetes.io/tls
metadata: {name: last}
stringData:
  ca.crt: |
${indent(pemText("rootB.crt"))}
`;
    const records = kubernetesTlsSecretRecords(yaml, { file: "/m.yaml" });
    assert.deepStrictEqual(
      records.map((r) => r.occurrences[0].location).sort(),
      ["/m.yaml#data.tls.crt", "/m.yaml#stringData.ca.crt"],
    );
  });

  it("ignores other secret types, bad base64 and non-string values", () => {
    const yaml = `kind: Secret
type: Opaque
data:
  tls.crt: ${b64(pemText("rootA.crt"))}
---
kind: Secret
type: kubernetes.io/tls
data:
  tls.crt: "!!!not base64!!!"
  ca.crt: 12
stringData:
  tls.crt: [a, b]
`;
    assert.deepStrictEqual(
      kubernetesTlsSecretRecords(yaml, { file: "/x.yaml" }),
      [],
    );
  });
});

describe("srcFileOfLocation()", () => {
  it("strips a secret key only after a YAML file name", () => {
    assert.strictEqual(
      srcFileOfLocation("/k8s/tls.yaml#data.tls.crt"),
      "/k8s/tls.yaml",
    );
    assert.strictEqual(
      srcFileOfLocation("/k8s/tls.yml#stringData.ca.crt"),
      "/k8s/tls.yml",
    );
    assert.strictEqual(
      srcFileOfLocation("/r/certs/ca#data.crt"),
      "/r/certs/ca#data.crt",
    );
  });
});
