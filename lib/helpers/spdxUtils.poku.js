import { assert, describe, it } from "poku";

import {
  detectBomFormat,
  getNonCycloneDxErrorMessage,
  isCycloneDxBom,
  isSpdxJsonLd,
  toCycloneDxLikeBom,
} from "./spdxUtils.js";

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
  it("detects CycloneDX documents", () => {
    assert.strictEqual(
      isCycloneDxBom({
        bomFormat: "CycloneDX",
        specVersion: 1.7,
      }),
      true,
    );
    assert.strictEqual(isCycloneDxBom(sampleSpdx), false);
  });

  it("detects SPDX JSON-LD documents", () => {
    assert.strictEqual(isSpdxJsonLd(sampleSpdx), true);
    assert.strictEqual(isSpdxJsonLd({ bomFormat: "CycloneDX" }), false);
  });

  it("classifies BOM formats for CLI reuse", () => {
    assert.strictEqual(detectBomFormat(sampleSpdx), "spdx");
    assert.strictEqual(
      detectBomFormat({ bomFormat: "CycloneDX", specVersion: "1.6" }),
      "cyclonedx",
    );
    assert.strictEqual(detectBomFormat({ foo: "bar" }), "unknown");
  });

  it("generates clear CycloneDX-only command errors", () => {
    assert.strictEqual(
      getNonCycloneDxErrorMessage(sampleSpdx, "cdx-sign"),
      "cdx-sign expects a CycloneDX BOM. SPDX input is not supported for this command.",
    );
    assert.strictEqual(
      getNonCycloneDxErrorMessage({ foo: "bar" }, "cdx-sign"),
      "cdx-sign expects a CycloneDX JSON BOM.",
    );
  });

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
});
