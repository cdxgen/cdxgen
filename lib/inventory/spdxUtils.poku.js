import { assert, describe, it } from "poku";

import { toCycloneDxLikeBom } from "./spdxUtils.js";

const sampleSpdx = {
  "@context": "https://spdx.org/rdf/3.0.1/spdx-context.jsonld",
  "@graph": [
    { type: "CreationInfo", spdxId: "urn:demo#CreationInfo-main" },
    { type: "SpdxDocument", spdxId: "urn:demo#SPDXRef-DOCUMENT" },
    {
      type: "software_Package",
      spdxId: "urn:demo#SPDXRef-app",
      name: "app",
      software_packageUrl: "pkg:npm/@acme/app@1.2.3",
      software_packageVersion: "1.2.3",
    },
    {
      type: "software_Package",
      spdxId: "urn:demo#SPDXRef-lib",
      name: "lib",
      software_packageUrl: "pkg:npm/lodash@4.17.21",
      software_packageVersion: "4.17.21",
    },
    {
      type: "Relationship",
      spdxId: "urn:demo#Relationship-1",
      relationshipType: "dependsOn",
      from: "urn:demo#SPDXRef-app",
      to: ["urn:demo#SPDXRef-lib"],
    },
  ],
};

describe("spdxUtils", () => {
  it("returns non-SPDX BOMs unchanged", () => {
    const cyclonedxBom = { bomFormat: "CycloneDX", components: [] };
    assert.strictEqual(toCycloneDxLikeBom(cyclonedxBom), cyclonedxBom);
  });

  it("converts SPDX package and relationship graph into CycloneDX-like components/dependencies", () => {
    const converted = toCycloneDxLikeBom(sampleSpdx);
    assert.strictEqual(Array.isArray(converted.components), true);
    assert.strictEqual(converted.components.length, 2);
    assert.strictEqual(converted.components[0].name, "app");
    assert.strictEqual(converted.components[0].version, "1.2.3");
    assert.strictEqual(Array.isArray(converted.dependencies), true);
    const appDependency = converted.dependencies.find(
      (dep) => dep.ref === "pkg:npm/@acme/app@1.2.3",
    );
    assert.ok(appDependency);
    assert.deepStrictEqual(appDependency.dependsOn, ["pkg:npm/lodash@4.17.21"]);
  });

  it("ignores invalid SPDX relationships where 'from' is not a string", () => {
    const malformedSpdx = structuredClone(sampleSpdx);
    malformedSpdx["@graph"].push({
      type: "Relationship",
      spdxId: "urn:demo#Relationship-2",
      relationshipType: "dependsOn",
      from: ["urn:demo#SPDXRef-app"],
      to: ["urn:demo#SPDXRef-lib"],
    });
    const converted = toCycloneDxLikeBom(malformedSpdx);
    const appDependency = converted.dependencies.find(
      (dep) => dep.ref === "pkg:npm/@acme/app@1.2.3",
    );
    assert.ok(appDependency);
    assert.deepStrictEqual(appDependency.dependsOn, ["pkg:npm/lodash@4.17.21"]);
  });

  it("bounds the references the relationships resolve to when asked", () => {
    const longPurl = `pkg:generic/${"x".repeat(1000)}@1`;
    const graph = [
      { type: "SpdxDocument", spdxId: "doc" },
      {
        type: "software_Package",
        spdxId: "core",
        name: "core",
        software_packageUrl: longPurl,
      },
    ];
    for (let index = 0; index < 100; index++) {
      graph.push({
        type: "Relationship",
        relationshipType: "dependsOn",
        from: `p${index}`,
        to: ["core"],
      });
    }
    const spdx = { "@context": sampleSpdx["@context"], "@graph": graph };
    // 100 relationships name `core` in four characters each and resolve to
    // 100 copies of its purl.
    assert.throws(
      () => toCycloneDxLikeBom(spdx, { maxResolvedRefLength: 50_000 }),
      RangeError,
    );
    assert.strictEqual(
      toCycloneDxLikeBom(spdx, { maxResolvedRefLength: 200_000 }).dependencies
        .length,
      101,
    );
    assert.strictEqual(toCycloneDxLikeBom(spdx).dependencies.length, 101);
  });

  it("does not take a purl that is not a string as the bom-ref", () => {
    const spdx = structuredClone(sampleSpdx);
    spdx["@graph"][3].software_packageUrl = { purl: "pkg:npm/lodash@4.17.21" };
    const converted = toCycloneDxLikeBom(spdx);
    assert.strictEqual(converted.components[1].purl, undefined);
    assert.strictEqual(
      converted.components[1]["bom-ref"],
      "urn:demo#SPDXRef-lib",
    );
    assert.deepStrictEqual(
      converted.dependencies.find(
        (dep) => dep.ref === "pkg:npm/@acme/app@1.2.3",
      ).dependsOn,
      ["urn:demo#SPDXRef-lib"],
    );
  });
});
