import { assert, describe, it } from "poku";

import { loadBomForAnalysis } from "../../inventory/cyclonedx20.js";
import {
  applySpecVersionCompatibility,
  collectFieldPaths,
  collectLeafValues,
  diffMissingLeafValues,
  diffRemovedFieldPaths,
} from "./specVersionCompat.js";

const buildBom = () => ({
  bomFormat: "CycloneDX",
  specVersion: "1.7",
  version: 1,
  citations: [{ timestamp: "2026-01-01T00:00:00Z", note: "generated" }],
  metadata: {
    component: { "bom-ref": "root", type: "application", name: "app" },
    distributionConstraints: [{ description: "internal only" }],
  },
  components: [
    {
      "bom-ref": "a@1",
      type: "library",
      name: "a",
      version: "1",
      isExternal: true,
      tags: ["runtime"],
      evidence: {
        identity: [
          { field: "purl", confidence: 1, concludedValue: "pkg:npm/a@1" },
          { field: "name", confidence: 0.5 },
        ],
      },
    },
    { "bom-ref": "b@1", type: "library", name: "b", version: "1" },
  ],
  dependencies: [
    { ref: "root", dependsOn: ["a@1"] },
    { ref: "a@1", provides: ["b@1"] },
  ],
});

describe("specVersionCompat", () => {
  it("collapses evidence identity to a single object below 1.6", () => {
    const bomJson = applySpecVersionCompatibility(buildBom(), {
      specVersion: "1.5",
    });
    const identity = bomJson.components[0].evidence.identity;
    assert.strictEqual(Array.isArray(identity), false);
    assert.strictEqual(identity.field, "purl");
    // concludedValue arrived in 1.6 alongside the array form.
    assert.strictEqual(identity.concludedValue, undefined);
  });

  it("keeps evidence identity as an array at 1.6 and above", () => {
    const bomJson = applySpecVersionCompatibility(buildBom(), {
      specVersion: "1.6",
    });
    assert.strictEqual(
      Array.isArray(bomJson.components[0].evidence.identity),
      true,
    );
  });

  it("strips version-only fields and rewrites the spec version", () => {
    const bomJson = applySpecVersionCompatibility(buildBom(), {
      specVersion: "1.6",
    });
    assert.strictEqual(bomJson.specVersion, "1.6");
    assert.strictEqual(bomJson.citations, undefined);
    assert.strictEqual(bomJson.metadata.distributionConstraints, undefined);
    assert.strictEqual(bomJson.components[0].isExternal, undefined);
    // tags and provides are 1.6 additions, so they survive a 1.6 target.
    assert.deepStrictEqual(bomJson.components[0].tags, ["runtime"]);
    assert.deepStrictEqual(bomJson.dependencies[1].provides, ["b@1"]);
  });

  it("strips 1.6 additions when targeting 1.5", () => {
    const bomJson = applySpecVersionCompatibility(buildBom(), {
      specVersion: "1.5",
    });
    assert.strictEqual(bomJson.components[0].tags, undefined);
    assert.strictEqual(bomJson.dependencies[1].provides, undefined);
  });

  it("keeps 1.7 crypto facts in the shapes 1.6 can carry", () => {
    const bomJson = applySpecVersionCompatibility(
      {
        bomFormat: "CycloneDX",
        specVersion: "1.7",
        version: 1,
        components: [
          {
            type: "cryptographic-asset",
            name: "EC",
            cryptoProperties: {
              assetType: "algorithm",
              algorithmProperties: {
                primitive: "key-wrap",
                algorithmFamily: "EC",
                ellipticCurve: "secg/secp256r1",
              },
            },
          },
          {
            type: "cryptographic-asset",
            name: "DTLSv1.2",
            cryptoProperties: {
              assetType: "protocol",
              protocolProperties: { type: "dtls", version: "1.2" },
            },
          },
        ],
      },
      { specVersion: "1.6" },
    );
    const [ec, dtls] = bomJson.components;
    assert.deepStrictEqual(ec.cryptoProperties.algorithmProperties, {
      primitive: "other",
      curve: "secp256r1",
    });
    assert.deepStrictEqual(dtls.cryptoProperties.protocolProperties, {
      type: "other",
      version: "1.2",
    });
  });

  it("leaves a BOM alone when the spec version is malformed", () => {
    const bomJson = applySpecVersionCompatibility(buildBom(), {
      specVersion: "not-a-version",
    });
    assert.strictEqual(bomJson.specVersion, "1.7");
    assert.ok(bomJson.citations);
  });

  it("collects field paths without array positions", () => {
    const paths = collectFieldPaths({
      components: [{ name: "a" }, { name: "b", purl: "pkg:npm/b" }],
    });
    assert.strictEqual(paths.has("components.name"), true);
    assert.strictEqual(paths.has("components.purl"), true);
    assert.strictEqual(paths.has("components[0].name"), false);
  });

  it("reports the field paths a downgrade removed", () => {
    const sourceBomJson = buildBom();
    const removed = diffRemovedFieldPaths(
      sourceBomJson,
      applySpecVersionCompatibility(buildBom(), { specVersion: "1.6" }),
    );
    assert.strictEqual(removed.includes("citations"), true);
    assert.strictEqual(removed.includes("components.isExternal"), true);
    // A field both versions define is never reported.
    assert.strictEqual(removed.includes("components.purl"), false);
    assert.strictEqual(removed.includes("components.name"), false);
  });

  it("reports nothing when the target keeps every field", () => {
    assert.deepStrictEqual(
      diffRemovedFieldPaths(
        buildBom(),
        applySpecVersionCompatibility(buildBom(), { specVersion: "1.7" }),
      ),
      [],
    );
  });
});

describe("specVersionCompat crypto certificates", () => {
  const certificateBom = () => ({
    specVersion: "1.7",
    bomFormat: "CycloneDX",
    components: [
      {
        type: "cryptographic-asset",
        "bom-ref": "crypto/certificate/root@sha256:aa",
        name: "root",
        cryptoProperties: {
          assetType: "certificate",
          certificateProperties: {
            serialNumber: "abcd",
            certificateFileExtension: "crt",
            fingerprint: { alg: "SHA-256", content: "aa" },
            relatedCryptographicAssets: [
              { type: "publicKey", ref: "crypto/public-key/k@spki-sha256:ff" },
              { type: "algorithm", ref: "crypto/algorithm/A@1.2.3" },
            ],
            certificateExtensions: [
              {
                commonExtensionName: "basicConstraints",
                commonExtensionValue: "CA:TRUE",
              },
            ],
          },
        },
        properties: [{ name: "cdx:crypto:spkiSha256", value: "ff" }],
      },
      {
        type: "cryptographic-asset",
        "bom-ref": "crypto/public-key/k@spki-sha256:ff",
        name: "RSA-2048",
        cryptoProperties: {
          assetType: "related-crypto-material",
          relatedCryptoMaterialProperties: {
            type: "public-key",
            format: "SPKI",
            fingerprint: { alg: "SHA-256", content: "ff" },
            algorithmRef: "crypto/algorithm/A@1.2.3",
          },
        },
        properties: [{ name: "cdx:crypto:spkiSha256", value: "ff" }],
      },
    ],
  });

  it("maps relatedCryptographicAssets to the 1.6 deprecated refs", () => {
    const downgraded = applySpecVersionCompatibility(certificateBom(), {
      specVersion: "1.6",
    });
    const cert = downgraded.components.find((c) =>
      c["bom-ref"].startsWith("crypto/certificate/"),
    );
    const certificateProperties = cert.cryptoProperties.certificateProperties;
    assert.strictEqual(
      certificateProperties.subjectPublicKeyRef,
      "crypto/public-key/k@spki-sha256:ff",
    );
    assert.strictEqual(
      certificateProperties.signatureAlgorithmRef,
      "crypto/algorithm/A@1.2.3",
    );
    assert.strictEqual(
      certificateProperties.relatedCryptographicAssets,
      undefined,
    );
    assert.strictEqual(certificateProperties.certificateExtensions, undefined);
    assert.strictEqual(certificateProperties.serialNumber, undefined);
    assert.strictEqual(certificateProperties.fingerprint, undefined);
    assert.strictEqual(certificateProperties.certificateExtension, "crt");
    // The matching facts survive as properties.
    assert.ok(cert.properties.some((p) => p.name === "cdx:crypto:spkiSha256"));
    const key = downgraded.components.find((c) =>
      c["bom-ref"].startsWith("crypto/public-key/"),
    );
    assert.strictEqual(
      key.cryptoProperties.relatedCryptoMaterialProperties.fingerprint,
      undefined,
      "the public-key fingerprint object is 1.7-only",
    );
    assert.strictEqual(
      key.cryptoProperties.relatedCryptoMaterialProperties.algorithmRef,
      "crypto/algorithm/A@1.2.3",
    );
    assert.ok(key.properties.some((p) => p.name === "cdx:crypto:spkiSha256"));
  });

  it("keeps the 1.7 shape intact at 1.7", () => {
    const kept = applySpecVersionCompatibility(certificateBom(), {
      specVersion: "1.7",
    });
    const cert = kept.components.find((c) =>
      c["bom-ref"].startsWith("crypto/certificate/"),
    );
    assert.strictEqual(
      cert.cryptoProperties.certificateProperties.relatedCryptographicAssets
        .length,
      2,
    );
    assert.ok(
      cert.cryptoProperties.certificateProperties.certificateExtensions,
    );
  });
});

describe("diffMissingLeafValues()", () => {
  const component = () => ({ type: "library", refId: "a", name: "a" });
  const withComponents = (count) => ({
    specFormat: "CycloneDX",
    specVersion: "2.0",
    definitions: {
      components: Array.from({ length: count }, component),
    },
  });

  it("counts a repeated leaf once per occurrence", () => {
    const leaves = collectLeafValues(withComponents(2));
    assert.strictEqual(leaves.get('definitions.components.name="a"'), 2);
    assert.strictEqual(leaves.get('specVersion="2.0"'), 1);
  });

  it("reports one entry per dropped duplicate", () => {
    assert.deepStrictEqual(
      diffMissingLeafValues(withComponents(2), withComponents(1)),
      [
        'definitions.components.name="a"',
        'definitions.components.refId="a"',
        'definitions.components.type="library"',
      ],
    );
    assert.deepStrictEqual(
      diffMissingLeafValues(withComponents(3), withComponents(1)).length,
      6,
    );
  });

  it("still ignores member order and reports nothing for an identical copy", () => {
    const source = withComponents(2);
    source.definitions.components[1].name = "b";
    const reordered = structuredClone(source);
    reordered.definitions.components.reverse();
    assert.deepStrictEqual(diffMissingLeafValues(source, reordered), []);
    assert.deepStrictEqual(
      diffMissingLeafValues(withComponents(1), withComponents(2)),
      [],
    );
  });
});

describe("the 2.0 compatibility pass and loadBomForAnalysis", () => {
  it("marks its result as the internal model", () => {
    const model = applySpecVersionCompatibility(buildBom(), {
      specVersion: "2.0",
    });
    const { internalBom, losses } = loadBomForAnalysis(model);
    assert.strictEqual(internalBom, model);
    assert.deepStrictEqual(losses, []);
  });

  it("leaves a 1.x result unmarked", () => {
    const model = applySpecVersionCompatibility(buildBom(), {
      specVersion: "1.6",
    });
    assert.deepStrictEqual(Object.getOwnPropertySymbols(model), []);
  });
});
