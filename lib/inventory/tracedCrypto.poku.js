import { readFileSync } from "node:fs";
import { join } from "node:path";

import { assert, describe, it } from "poku";

import {
  CertificateCollector,
  certRecordFromDer,
  certRecordFromObservedChainEntry,
  linkFallbackIssuers,
  mergeDuplicateCryptoComponents,
  pemCertificateDerBlocks,
} from "./certificates.js";
import {
  cryptoLibrariesByPath,
  normalizeTracedCryptoComponents,
  observedChainComponents,
  suiteCipher,
} from "./tracedCrypto.js";

// The CBOM safer-exec 1.1.0 writes for `curl.exe https://example.com` through
// its egress proxy on Windows, trimmed to one library.
const windowsCbom = [
  {
    type: "cryptographic-asset",
    name: "Windows Schannel",
    version: "6.2.26100.9444",
    cryptoProperties: {
      assetType: "related-crypto-material",
      relatedCryptoMaterialProperties: { type: "library" },
    },
  },
  {
    type: "cryptographic-asset",
    name: "TLS_AES_256_GCM_SHA384",
    version: "TLSv1.3",
    cryptoProperties: {
      assetType: "algorithm",
      algorithmProperties: {
        primitive: "aead",
        parameterSetIdentifier: "SHA384",
        mode: "GCM",
        cryptoFunctions: ["encrypt", "decrypt"],
        classicalSecurityLevel: 256,
      },
    },
  },
  {
    type: "cryptographic-asset",
    name: "x25519",
    cryptoProperties: {
      assetType: "algorithm",
      algorithmProperties: {
        primitive: "key-agree",
        cryptoFunctions: ["keygen", "keyagree"],
      },
    },
  },
  {
    type: "cryptographic-asset",
    name: "TLSv1.3",
    version: "1.3",
    cryptoProperties: {
      assetType: "protocol",
      protocolProperties: {
        type: "tls",
        version: "1.3",
        cipherSuites: [
          {
            name: "TLS_AES_256_GCM_SHA384",
            algorithms: ["ECDHE", "AES", "SHA384"],
          },
        ],
      },
    },
  },
];

describe("normalizeTracedCryptoComponents()", () => {
  it("gives every asset a bom-ref and an OID, and drops library entries", () => {
    const comps = normalizeTracedCryptoComponents(windowsCbom);
    assert.deepEqual(
      comps.map((c) => c["bom-ref"]),
      [
        "crypto/algorithm/aes256-GCM@2.16.840.1.101.3.4.1.46",
        "crypto/algorithm/x25519@1.3.101.110",
        "crypto/protocol/TLSv1.3@1.3",
      ],
    );
    const aes = comps[0];
    assert.strictEqual(aes.cryptoProperties.oid, "2.16.840.1.101.3.4.1.46");
    assert.strictEqual(
      aes.cryptoProperties.algorithmProperties.primitive,
      "ae",
    );
    assert.strictEqual(aes.cryptoProperties.algorithmProperties.mode, "gcm");
    assert.strictEqual(
      aes.cryptoProperties.algorithmProperties.parameterSetIdentifier,
      "256",
    );
    assert.deepEqual(
      comps[1].cryptoProperties.algorithmProperties.cryptoFunctions,
      ["keygen"],
    );
  });

  it("refers to the suite's cipher by bom-ref from the protocol", () => {
    const protocol = normalizeTracedCryptoComponents(windowsCbom).at(-1);
    assert.deepEqual(
      protocol.cryptoProperties.protocolProperties.cipherSuites,
      [
        {
          name: "TLS_AES_256_GCM_SHA384",
          algorithms: ["crypto/algorithm/aes256-GCM@2.16.840.1.101.3.4.1.46"],
        },
      ],
    );
  });

  it("records a hybrid post-quantum group as its two algorithms", () => {
    const comps = normalizeTracedCryptoComponents([
      {
        type: "cryptographic-asset",
        name: "X25519MLKEM768",
        cryptoProperties: {
          assetType: "algorithm",
          algorithmProperties: {
            primitive: "kem",
            nistQuantumSecurityLevel: 3,
          },
        },
      },
    ]);
    assert.deepEqual(
      comps.map((c) => [
        c.name,
        c.cryptoProperties.algorithmProperties.primitive,
      ]),
      [
        ["x25519", "key-agree"],
        ["ml-kem-768", "kem"],
      ],
    );
    assert.strictEqual(
      comps[1].cryptoProperties.algorithmProperties.nistQuantumSecurityLevel,
      3,
    );
  });

  it("drops invalid enum values and algorithms without an OID", () => {
    const comps = normalizeTracedCryptoComponents([
      {
        type: "cryptographic-asset",
        name: "ffdhe2048",
        cryptoProperties: { assetType: "algorithm" },
      },
      {
        type: "cryptographic-asset",
        name: "ECDHE-RSA-AES128-GCM-SHA256",
        version: "TLSv1.2",
        cryptoProperties: {
          assetType: "algorithm",
          algorithmProperties: {
            primitive: "aead",
            mode: "GCM",
            executionEnvironment: "openssl",
            implementationPlatform: "openssl",
          },
        },
      },
    ]);
    assert.strictEqual(comps.length, 1);
    assert.strictEqual(comps[0].name, "aes128-GCM");
    const props = comps[0].cryptoProperties.algorithmProperties;
    assert.strictEqual(props.executionEnvironment, undefined);
    assert.strictEqual(props.implementationPlatform, undefined);
  });

  it("merges the suites of repeated protocol entries", () => {
    const tls12 = (suite) => ({
      type: "cryptographic-asset",
      name: "TLSv1.2",
      version: "1.2",
      cryptoProperties: {
        assetType: "protocol",
        protocolProperties: { type: "tls", cipherSuites: [{ name: suite }] },
      },
    });
    const comps = normalizeTracedCryptoComponents([
      tls12("ECDHE-RSA-AES256-GCM-SHA384"),
      tls12("ECDHE-RSA-CHACHA20-POLY1305"),
    ]);
    const protocol = comps.find((c) => c.name === "TLSv1.2");
    assert.deepEqual(
      protocol.cryptoProperties.protocolProperties.cipherSuites.map(
        (s) => s.algorithms[0],
      ),
      [
        "crypto/algorithm/aes256-GCM@2.16.840.1.101.3.4.1.46",
        `crypto/algorithm/chaCha20Poly1305@${comps.find((c) => c.name === "chaCha20Poly1305").cryptoProperties.oid}`,
      ],
    );
  });
});

describe("suiteCipher()", () => {
  it("reads IANA and OpenSSL suite names", () => {
    assert.strictEqual(
      suiteCipher("TLS_AES_128_GCM_SHA256").name,
      "aes128-GCM",
    );
    assert.strictEqual(
      suiteCipher("TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA").name,
      "aes256-CBC",
    );
    assert.strictEqual(suiteCipher("AES256-SHA").name, "aes256-CBC");
    assert.strictEqual(
      suiteCipher("TLS_CHACHA20_POLY1305_SHA256").name,
      "chaCha20Poly1305",
    );
    assert.strictEqual(
      suiteCipher("TLS_RSA_WITH_3DES_EDE_CBC_SHA").name,
      "des-EDE3-CBC",
    );
    assert.strictEqual(suiteCipher("TLS_NULL_WITH_NULL_NULL"), undefined);
  });

  it("reads the CCM suites from both spellings of the 8-byte tag", () => {
    const cases = [
      ["AES128-CCM8", "aes128-CCM"],
      ["AES256-CCM8", "aes256-CCM"],
      ["DHE-RSA-AES128-CCM8", "aes128-CCM"],
      ["ECDHE-ECDSA-AES256-CCM8", "aes256-CCM"],
      ["TLS_ECDHE_ECDSA_WITH_AES_128_CCM_8", "aes128-CCM"],
      ["TLS_AES_128_CCM_8_SHA256", "aes128-CCM"],
    ];
    for (const [suite, name] of cases) {
      assert.strictEqual(suiteCipher(suite).name, name, suite);
      assert.strictEqual(suiteCipher(suite).mode, "ccm", suite);
    }
  });

  it("normalizes an OpenSSL CCM8 suite component to AES-CCM", () => {
    const comps = normalizeTracedCryptoComponents([
      {
        type: "cryptographic-asset",
        name: "ECDHE-ECDSA-AES128-CCM8",
        cryptoProperties: {
          assetType: "algorithm",
          algorithmProperties: { primitive: "aead" },
        },
      },
    ]);
    assert.strictEqual(comps.length, 1);
    assert.strictEqual(comps[0].name, "aes128-CCM");
    assert.strictEqual(comps[0].cryptoProperties.oid, "2.16.840.1.101.3.4.1.7");
    assert.strictEqual(
      comps[0].cryptoProperties.algorithmProperties.primitive,
      "ae",
    );
  });
});

describe("cryptoLibrariesByPath()", () => {
  it("keys crypto-library audit entries by path", () => {
    const libs = cryptoLibrariesByPath([
      {
        type: "crypto-library",
        name: "Windows Schannel",
        version: "6.2.26100.9444",
        path: "C:\\Windows\\System32\\schannel.dll",
      },
      { type: "crypto-cipher", name: "TLS_AES_128_GCM_SHA256" },
      { type: "crypto-library", name: "OpenSSL" },
    ]);
    assert.deepEqual(Array.from(libs.entries()), [
      [
        "C:\\Windows\\System32\\schannel.dll",
        { name: "Windows Schannel", version: "6.2.26100.9444" },
      ],
    ]);
  });
});

// The observed-chain fixtures safer-exec 1.2.0 really produced against the
// generated servers (test/data/tracebom-chain/README.md): two TLS 1.2 chains
// (classical and ML-DSA hybrid) and one TLS 1.3 server with no chain.
const TRACEBOM_CHAIN = join("test", "data", "tracebom-chain");
const TLS12_PROTOCOL_REF = "crypto/protocol/TLSv1.2@1.2";

function readTracebomCryptoResult() {
  return JSON.parse(
    readFileSync(join(TRACEBOM_CHAIN, "crypto-result.json"), "utf-8"),
  );
}

function tracebomObservedModel() {
  return observedChainComponents(
    readTracebomCryptoResult(),
    new Set([TLS12_PROTOCOL_REF, "crypto/protocol/TLSv1.3@1.3"]),
  );
}

function componentProps(component) {
  return Object.fromEntries(
    (component.properties || []).map((property) => [
      property.name,
      property.value,
    ]),
  );
}

describe("observedChainComponents()", () => {
  it("builds one certificate and public-key component per chain entry", () => {
    const { components } = tracebomObservedModel();
    const cryptoResult = readTracebomCryptoResult();
    const chainEntries = cryptoResult.ciphers.flatMap(
      (cipher) => cipher.chain || [],
    );
    const certificates = components.filter(
      (component) => component.cryptoProperties.assetType === "certificate",
    );
    const publicKeys = components.filter(
      (component) =>
        component.cryptoProperties.assetType === "related-crypto-material",
    );
    // Six distinct certificates (3 per TLS 1.2 server) and six keys.
    assert.strictEqual(
      certificates.length,
      new Set(chainEntries.map((entry) => entry.certSha256)).size,
    );
    assert.strictEqual(
      publicKeys.length,
      new Set(chainEntries.map((entry) => entry.spkiSha256)).size,
    );
    for (const certificate of certificates) {
      const properties = componentProps(certificate);
      assert.strictEqual(properties["cdx:crypto:sourceType"], "observed-tls");
      assert.match(
        certificate["bom-ref"],
        /^crypto\/certificate\/[^@]+@sha256:[0-9a-f]{64}$/,
      );
      // The chain relays no SKI/AKI and proves no issuer, so the certificate
      // carries neither issuer properties nor issuer edges.
      assert.strictEqual(properties["cdx:crypto:issuerSpkiSha256"], undefined);
      assert.strictEqual(properties["cdx:crypto:authorityKeyId"], undefined);
    }
    for (const publicKey of publicKeys) {
      assert.strictEqual(
        componentProps(publicKey)["cdx:crypto:sourceType"],
        "certificate",
      );
    }
  });

  it("records the server as an occurrence of every certificate it presented", () => {
    const { components } = tracebomObservedModel();
    const cryptoResult = readTracebomCryptoResult();
    for (const cipher of cryptoResult.ciphers) {
      const chain = cipher.chain || [];
      for (const entry of chain) {
        const certificate = components.find(
          (component) => component.version === entry.certSha256,
        );
        assert.ok(certificate, entry.name);
        const locations = certificate.evidence.occurrences.map(
          (occurrence) => occurrence.location,
        );
        assert.ok(
          locations.includes(`tls://${cipher.host}`),
          `${entry.name} missing tls://${cipher.host}`,
        );
        const publicKey = components.find(
          (component) => component.version === entry.spkiSha256,
        );
        assert.ok(publicKey, entry.keyName);
        assert.ok(
          publicKey.evidence.occurrences
            .map((occurrence) => occurrence.location)
            .includes(`tls://${cipher.host}`),
        );
      }
    }
    // The TLS 1.3 server presented its chain too, but its Certificate
    // message is encrypted: the entry carries no chain (omitempty) and no
    // certificate carries its host.
    const tls13Cipher = cryptoResult.ciphers.find(
      (cipher) => cipher.protocol === "TLSv1.3",
    );
    assert.ok(tls13Cipher);
    assert.ok(
      !tls13Cipher.chain || tls13Cipher.chain.length === 0,
      "TLS 1.3 entries carry no chain",
    );
    assert.strictEqual(
      components.some((component) =>
        component.evidence?.occurrences?.some(
          (occurrence) => occurrence.location === `tls://${tls13Cipher.host}`,
        ),
      ),
      false,
    );
  });

  it("names post-quantum chain keys by their OID with their NIST level", () => {
    const { components } = tracebomObservedModel();
    const mldsa44 = components.find(
      (component) =>
        component.cryptoProperties.assetType === "algorithm" &&
        component.name === "ML-DSA-44",
    );
    const mldsa65 = components.find(
      (component) =>
        component.cryptoProperties.assetType === "algorithm" &&
        component.name === "ML-DSA-65",
    );
    assert.ok(mldsa44, "ML-DSA-44 algorithm component");
    assert.ok(mldsa65, "ML-DSA-65 algorithm component");
    assert.strictEqual(
      mldsa44.cryptoProperties.algorithmProperties.nistQuantumSecurityLevel,
      2,
    );
    assert.strictEqual(
      mldsa65.cryptoProperties.algorithmProperties.nistQuantumSecurityLevel,
      3,
    );
    // Post-quantum public keys carry no size.
    for (const name of ["ML-DSA-44", "ML-DSA-65"]) {
      const key = components.find(
        (component) => component.name === name && component.version,
      );
      assert.ok(key, name);
      assert.strictEqual(
        key.cryptoProperties.relatedCryptoMaterialProperties.size,
        undefined,
      );
    }
  });

  it("links the protocol component to the presented chain by a provides edge", () => {
    const { components, dependencies } = tracebomObservedModel();
    const provides = dependencies.find(
      (dependency) => dependency.ref === TLS12_PROTOCOL_REF,
    );
    assert.ok(provides, "TLSv1.2 provides edge");
    const cryptoResult = readTracebomCryptoResult();
    // The leaf is the first entry of a presented chain, leaf first.
    const leafEntry = cryptoResult.ciphers.find(
      (cipher) => (cipher.chain || []).length > 0,
    ).chain[0];
    const leafRef = provides.provides.find((ref) =>
      ref.endsWith(`@sha256:${leafEntry.certSha256}`),
    );
    assert.ok(leafRef, "the leaf certificate is provided");
    // Every provided ref is a component in the model.
    for (const ref of provides.provides) {
      assert.ok(
        components.some((component) => component["bom-ref"] === ref),
        ref,
      );
    }
    // The only edges are the protocol provides; no issuer dependsOn edges
    // are inferred from a server-presented order.
    assert.strictEqual(dependencies.length, 1);
  });

  it("emits no provides edge for a protocol component that is absent", () => {
    const { dependencies } = observedChainComponents(
      readTracebomCryptoResult(),
      new Set(),
    );
    assert.deepStrictEqual(dependencies, []);
  });

  it("yields nothing for results without chains (safer-exec <= 1.1.2)", () => {
    // A 1.1.2-shaped result: ciphers carry host and protocol but no chain.
    const legacy = {
      ciphers: [
        {
          name: "ECDHE-RSA-AES128-GCM-SHA256",
          protocol: "TLSv1.2",
          host: "a.test:443",
        },
      ],
      libraries: [{ name: "OpenSSL", version: "3" }],
    };
    assert.deepStrictEqual(
      observedChainComponents(legacy, new Set([TLS12_PROTOCOL_REF])),
      { components: [], dependencies: [] },
    );
    assert.deepStrictEqual(observedChainComponents(undefined, new Set()), {
      components: [],
      dependencies: [],
    });
    assert.deepStrictEqual(
      observedChainComponents({ ciphers: [] }, new Set()),
      { components: [], dependencies: [] },
    );
  });

  it("skips malformed chain entries without failing the valid ones", () => {
    const good = {
      name: "good",
      subject: "CN=good",
      certSha256: "ab".repeat(32),
      spkiSha256: "cd".repeat(32),
      keyName: "RSA-2048",
      keyBits: 2048,
    };
    const model = observedChainComponents(
      {
        ciphers: [
          {
            protocol: "TLSv1.2",
            host: "evil.test:443",
            chain: [
              "not an object",
              null,
              {},
              { certSha256: "short" },
              { certSha256: "zz".repeat(32) },
              { certSha256: 12345, spkiSha256: "ef".repeat(32) },
              {
                certSha256: "ab".repeat(32),
                subject: 7,
                issuer: [8],
                serialNumber: {},
              },
              good,
            ],
          },
        ],
      },
      new Set([TLS12_PROTOCOL_REF]),
    );
    const certificates = model.components.filter(
      (component) => component.cryptoProperties.assetType === "certificate",
    );
    // The duplicate of `good` and the junk-typed variant merge into one.
    assert.strictEqual(certificates.length, 1);
    assert.strictEqual(certificates[0].name, "good");
    assert.strictEqual(
      certificates[0].cryptoProperties.certificateProperties.subjectName,
      "CN=good",
    );
    assert.deepStrictEqual(certificates[0].evidence.occurrences, [
      { location: "tls://evil.test:443" },
    ]);
  });

  it("caps one connection's chain at the ten certificates safer-exec records", () => {
    const chain = Array.from({ length: 15 }, (_, index) => ({
      name: `cert-${index}`,
      certSha256: String(index + 1)
        .padStart(2, "0")
        .repeat(32),
      spkiSha256: String(index + 41)
        .padStart(2, "0")
        .repeat(32),
      keyName: "RSA-2048",
    }));
    const { components } = observedChainComponents(
      { ciphers: [{ protocol: "TLSv1.2", host: "many.test:443", chain }] },
      new Set(),
    );
    const certificates = components.filter(
      (component) => component.cryptoProperties.assetType === "certificate",
    );
    assert.strictEqual(certificates.length, 10);
    assert.ok(
      certificates.every(
        (certificate) => Number(certificate.name.split("-")[1]) < 10,
      ),
    );
  });

  it("is deterministic regardless of the connection order reported", () => {
    const cryptoResult = readTracebomCryptoResult();
    const protocolRefs = new Set([
      TLS12_PROTOCOL_REF,
      "crypto/protocol/TLSv1.3@1.3",
    ]);
    const first = observedChainComponents(cryptoResult, protocolRefs);
    const reordered = observedChainComponents(
      {
        ...cryptoResult,
        ciphers: [...cryptoResult.ciphers]
          .reverse()
          .concat(cryptoResult.ciphers),
      },
      protocolRefs,
    );
    assert.strictEqual(
      JSON.stringify(reordered),
      JSON.stringify(first),
      "reversed and duplicated connections give byte-identical output",
    );
  });

  it("does not let a second server's conflicting fields depend on order", () => {
    const leafCipher = readTracebomCryptoResult().ciphers.find(
      (cipher) => cipher.chain?.length,
    );
    const evil = {
      ...leafCipher,
      host: "other:1",
      chain: [
        {
          ...leafCipher.chain[0],
          subject: "CN=evil",
          name: "evil",
          keyBits: 4096,
        },
      ],
    };
    const forward = observedChainComponents({ ciphers: [leafCipher, evil] });
    const backward = observedChainComponents({ ciphers: [evil, leafCipher] });
    assert.strictEqual(JSON.stringify(backward), JSON.stringify(forward));
  });

  it("names a CN-less certificate from its subject as the disk path does", () => {
    const leafCipher = readTracebomCryptoResult().ciphers.find(
      (cipher) => cipher.chain?.length,
    );
    const { components } = observedChainComponents({
      ciphers: [
        {
          ...leafCipher,
          chain: [
            {
              ...leafCipher.chain[0],
              subject: "OU=Ops,O=Foo\\, Inc,C=US",
              name: "US",
            },
          ],
        },
      ],
    });
    const certificate = components.find(
      (component) => component.cryptoProperties.assetType === "certificate",
    );
    assert.strictEqual(certificate.name, "Ops");
  });

  it("references only algorithm components that exist", () => {
    const leafCipher = readTracebomCryptoResult().ciphers.find(
      (cipher) => cipher.chain?.length,
    );
    for (const oid of [
      "1.2.840.10045.4.1",
      "1.2.840.113549.1.1.1",
      "1.2.840.10040.4.3",
    ]) {
      const { components } = observedChainComponents({
        ciphers: [
          {
            ...leafCipher,
            chain: [{ ...leafCipher.chain[0], signatureAlgorithmOid: oid }],
          },
        ],
      });
      const refs = new Set(components.map((component) => component["bom-ref"]));
      for (const component of components) {
        for (const ref of [
          component.cryptoProperties?.certificateProperties
            ?.signatureAlgorithmRef,
          ...(
            component.cryptoProperties?.certificateProperties
              ?.relatedCryptographicAssets || []
          ).map((asset) => asset.ref),
        ].filter(Boolean)) {
          assert.ok(refs.has(ref), `${oid}: ${ref} has a component`);
        }
      }
    }
  });

  it("merges an observed certificate with the same certificate found on disk", () => {
    // The on-disk producer: the committed fixture certificates as a CA
    // bundle, with verified issuer edges (the real fallback path).
    const collector = new CertificateCollector();
    for (const pem of ["c-leaf.pem", "c-int.pem", "c-root.pem"]) {
      const der = pemCertificateDerBlocks(
        readFileSync(join(TRACEBOM_CHAIN, pem), "utf-8"),
      )[0];
      collector.addRecord(
        certRecordFromDer(der, {
          location: "/etc/ssl/certs/ca-certificates.crt",
          sourceType: "ca-store",
        }),
      );
    }
    const diskRecords = [...collector.recordsBySha.values()];
    linkFallbackIssuers(diskRecords);
    const disk = new CertificateCollector();
    disk.addRecords(diskRecords);
    const diskModel = disk.build();
    const observed = tracebomObservedModel();
    // dedupeBom merges producer component lists exactly this way.
    const merged = mergeDuplicateCryptoComponents([
      ...observed.components,
      ...diskModel.components,
    ]);
    const cryptoResult = readTracebomCryptoResult();
    const classicalHost = cryptoResult.ciphers.find((cipher) =>
      (cipher.chain || []).some((entry) => entry.name === "Tracebom Test Root"),
    ).host;
    // Both chains' leaves are named localhost and observed over TLS; the
    // classical one is the leaf that also carries the disk occurrence, so
    // match on both instead of relying on the components' hash sort order
    // (the hashes change with every fixture regeneration).
    const leaf = merged.find(
      (component) =>
        component.cryptoProperties.assetType === "certificate" &&
        component.evidence.occurrences.some((occurrence) =>
          occurrence.location.startsWith("tls://"),
        ) &&
        component.evidence.occurrences.some(
          (occurrence) =>
            occurrence.location === "/etc/ssl/certs/ca-certificates.crt",
        ) &&
        componentProps(component)["cdx:crypto:certRole"] === "leaf",
    );
    assert.ok(leaf, "the classical leaf observed over TLS and on disk");
    assert.deepStrictEqual(
      leaf.evidence.occurrences.map((occurrence) => occurrence.location).sort(),
      [`tls://${classicalHost}`, "/etc/ssl/certs/ca-certificates.crt"].sort(),
    );
    const leafProps = componentProps(leaf);
    // The disk producer's verified issuer edge survives the merge and is
    // what lets a deny-list rule reach the server (Q3).
    assert.strictEqual(
      leafProps["cdx:crypto:issuerSpkiSha256"],
      cryptoResult.ciphers
        .flatMap((cipher) => cipher.chain || [])
        .find((entry) => entry.name === "Tracebom Test Intermediate")
        .spkiSha256,
    );
    assert.strictEqual(
      merged.filter((c) => c["bom-ref"] === leaf["bom-ref"]).length,
      1,
    );
  });

  it("matches the committed tracebom BOM for the same crypto result", () => {
    const bom = JSON.parse(
      readFileSync(join(TRACEBOM_CHAIN, "bom.json"), "utf-8"),
    );
    const cryptoResult = readTracebomCryptoResult();
    const byRef = new Map(
      (bom.components || []).map((component) => [
        component["bom-ref"],
        component,
      ]),
    );
    for (const cipher of cryptoResult.ciphers) {
      for (const entry of cipher.chain || []) {
        const ref = `crypto/certificate/${encodeURIComponent(entry.name)}@sha256:${entry.certSha256}`;
        const certificate = byRef.get(ref);
        assert.ok(certificate, `${entry.name} in the committed BOM`);
        assert.ok(
          certificate.evidence.occurrences.some(
            (occurrence) => occurrence.location === `tls://${cipher.host}`,
          ),
          `${entry.name} observed on ${cipher.host}`,
        );
      }
    }
    // The assembly kept one algorithm component per OID: the post-quantum
    // chain algorithms follow the certificate model's names (PLAN section
    // 2.5), and no OID appears twice.
    const algorithmOids = (bom.components || [])
      .filter(
        (component) =>
          component.cryptoProperties?.assetType === "algorithm" &&
          component.name.toLowerCase().startsWith("ml-dsa"),
      )
      .map((component) => component.cryptoProperties.oid);
    assert.ok(algorithmOids.length >= 2);
    assert.strictEqual(
      new Set(algorithmOids).size,
      algorithmOids.length,
      "no duplicate PQ algorithm OIDs",
    );
    const mldsa44 = bom.components.find(
      (component) =>
        component["bom-ref"] ===
        "crypto/algorithm/ML-DSA-44@2.16.840.1.101.3.4.3.17",
    );
    assert.ok(mldsa44, "the certificate model's ML-DSA-44 component");
    assert.strictEqual(
      mldsa44.cryptoProperties.algorithmProperties.nistQuantumSecurityLevel,
      2,
    );
    // The certificates' algorithm refs resolve: the hybrid leaf is signed
    // with ML-DSA-44.
    const hybridLeaf = (cryptoResult.ciphers.find((cipher) =>
      (cipher.chain || []).some(
        (entry) => entry.name === "Tracebom PQ Issuing ML-DSA-44",
      ),
    ).chain || [])[0];
    const hybridCert = byRef.get(
      `crypto/certificate/${encodeURIComponent(hybridLeaf.name)}@sha256:${hybridLeaf.certSha256}`,
    );
    const algorithmRef =
      hybridCert.cryptoProperties.certificateProperties.relatedCryptographicAssets.find(
        (asset) => asset.type === "algorithm",
      ).ref;
    assert.ok(byRef.has(algorithmRef), `${algorithmRef} resolves`);
  });

  it("survives a report channel that is not shaped like a crypto result", () => {
    // The report channel is parsed JSON of whatever the engine wrote; only
    // the shape safer-exec produces is meaningful, and anything else must
    // degrade to an empty model instead of failing the BOM.
    for (const hostile of [
      { ciphers: {} },
      { ciphers: 5 },
      { ciphers: true },
      { ciphers: "cipher" },
      42,
    ]) {
      assert.deepStrictEqual(
        observedChainComponents(hostile, new Set([TLS12_PROTOCOL_REF])),
        { components: [], dependencies: [] },
        JSON.stringify(hostile),
      );
    }
  });

  it("replaces unpaired surrogates instead of failing the bom-ref encoding", () => {
    // JSON legally carries lone surrogates, which encodeURIComponent rejects.
    const model = observedChainComponents(
      {
        ciphers: [
          {
            protocol: "TLSv1.2",
            host: "surrogate.test:443",
            chain: [
              {
                name: "evi\ud800l",
                subject: "CN=evi\ud800l",
                issuer: "CN=issuer",
                certSha256: "ab".repeat(32),
                spkiSha256: "cd".repeat(32),
                keyName: "RSA\ud800",
                notValidBefore: "2026-01-01T00:00:00Z",
                notValidAfter: "2027-01-01T00:00:00Z",
              },
            ],
          },
          {
            // A hostile protocol name crashes nothing, even when no protocol
            // component exists to receive the edge.
            protocol: "TLS\ud800v1.2",
            host: "surrogate.test:443",
            chain: [
              { certSha256: "ef".repeat(32), spkiSha256: "01".repeat(32) },
            ],
          },
        ],
      },
      new Set(),
    );
    const certificate = model.components.find(
      (component) =>
        component.cryptoProperties.assetType === "certificate" &&
        component.version === "ab".repeat(32),
    );
    assert.ok(certificate);
    assert.ok(!certificate["bom-ref"].includes("%ED"));
    assert.match(
      certificate["bom-ref"],
      /^crypto\/certificate\/evi.+l@sha256:[0-9a-f]{64}$/,
    );
    // The lone surrogate became U+FFFD, which percent-encodes normally.
    assert.ok(certificate["bom-ref"].includes("%EF%BF%BD"));
    const key = model.components.find(
      (component) =>
        component.cryptoProperties.assetType === "related-crypto-material" &&
        component.version === "cd".repeat(32),
    );
    assert.match(
      key["bom-ref"],
      /^crypto\/public-key\/RSA%EF%BF%BD@spki-sha256:/,
    );
    assert.deepStrictEqual(model.dependencies, []);
  });

  it("drops validity bounds no RFC 3339 date-time can express", () => {
    const record = certRecordFromObservedChainEntry(
      {
        certSha256: "ab".repeat(32),
        // A number is not an RFC 3339 string, and expanded years print as
        // +YYYYYY, which the schema's date-time format rejects.
        notValidBefore: 1761029111000,
        notValidAfter: "+275760-09-13T00:00:00.000Z",
      },
      {},
    );
    assert.strictEqual(record.notValidBefore, undefined);
    assert.strictEqual(record.notValidAfter, undefined);
  });

  it("caps a presenter's serial and key size claims", () => {
    const record = certRecordFromObservedChainEntry(
      {
        certSha256: "ab".repeat(32),
        serialNumber: "1".repeat(65),
        keyBits: 2 ** 53,
      },
      {},
    );
    assert.strictEqual(record.serialHex, undefined);
    assert.strictEqual(record.keyBits, undefined);
  });

  it("deduplicates a shared key's occurrences in linear time", () => {
    // A CA key every observed server presented: the public-key component
    // collects one occurrence per host, and the collector must not rescan
    // them all for each addition (the review measured minutes at 40k hosts).
    const hosts = 12000;
    const chain = [
      {
        name: "shared-root",
        certSha256: "ab".repeat(32),
        spkiSha256: "cd".repeat(32),
        keyName: "RSA-2048",
        keyBits: 2048,
        selfSigned: true,
        isCA: true,
      },
    ];
    const model = observedChainComponents(
      {
        ciphers: Array.from({ length: hosts }, (_, index) => ({
          protocol: "TLSv1.2",
          host: `host-${index}.test:443`,
          chain,
        })),
      },
      new Set(),
    );
    const key = model.components.find(
      (component) =>
        component.cryptoProperties.assetType === "related-crypto-material",
    );
    assert.strictEqual(key.evidence.occurrences.length, hosts);
    const certificate = model.components.find(
      (component) => component.cryptoProperties.assetType === "certificate",
    );
    assert.strictEqual(certificate.evidence.occurrences.length, hosts);
  });
});
