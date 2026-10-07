import { assert, describe, it } from "poku";

import {
  applySpecVersionCompatibility,
  collectFieldPaths,
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
