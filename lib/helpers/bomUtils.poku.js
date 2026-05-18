import { assert, describe, it } from "poku";

import {
  detectBomFormat,
  getCycloneDxFormat,
  getCycloneDxRootFormatKey,
  getNonCycloneDxErrorMessage,
  isCycloneDx20SpecVersion,
  isCycloneDxBom,
  isCycloneDxSpecVersionAtLeast,
  isSpdxJsonLd,
  normalizeCycloneDxSpecVersion,
  setCycloneDxFormat,
  toCycloneDxSpecVersionString,
} from "./bomUtils.js";

const sampleSpdx = {
  "@context": "https://spdx.org/rdf/3.0.1/spdx-context.jsonld",
  "@graph": [{ type: "SpdxDocument", spdxId: "urn:demo#SPDXRef-DOCUMENT" }],
};

describe("bomUtils", () => {
  it("detects CycloneDX documents across root format styles", () => {
    assert.strictEqual(
      isCycloneDxBom({
        bomFormat: "CycloneDX",
        specVersion: 1.7,
      }),
      true,
    );
    assert.strictEqual(
      isCycloneDxBom({
        specFormat: "CycloneDX",
        specVersion: "2.0",
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
    assert.strictEqual(
      detectBomFormat({ specFormat: "CycloneDX", specVersion: "2.0" }),
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

  it("normalizes CycloneDX spec versions and capability checks", () => {
    assert.strictEqual(normalizeCycloneDxSpecVersion("2.0"), 2);
    assert.strictEqual(normalizeCycloneDxSpecVersion(undefined), undefined);
    assert.strictEqual(normalizeCycloneDxSpecVersion("2.0.1"), undefined);
    assert.strictEqual(toCycloneDxSpecVersionString(2), "2.0");
    assert.strictEqual(toCycloneDxSpecVersionString("1.10"), "1.10");
    assert.strictEqual(toCycloneDxSpecVersionString("2.0.1"), undefined);
    assert.strictEqual(isCycloneDx20SpecVersion("2.0"), true);
    assert.strictEqual(isCycloneDx20SpecVersion("1.7"), false);
    assert.strictEqual(isCycloneDxSpecVersionAtLeast("2.0", 1.7), true);
    assert.strictEqual(isCycloneDxSpecVersionAtLeast("1.10", "1.7"), true);
    assert.strictEqual(isCycloneDxSpecVersionAtLeast(undefined, 1.7), false);
  });

  it("selects and writes the correct CycloneDX root format key", () => {
    assert.strictEqual(getCycloneDxRootFormatKey("1.7"), "bomFormat");
    assert.strictEqual(getCycloneDxRootFormatKey("2.0"), "specFormat");

    const bom17 = setCycloneDxFormat(
      { name: "demo", specVersion: "1.7" },
      "1.7",
    );
    assert.strictEqual(bom17.bomFormat, "CycloneDX");
    assert.strictEqual(bom17.specFormat, undefined);
    assert.strictEqual(getCycloneDxFormat(bom17), "CycloneDX");
    assert.deepStrictEqual(Object.keys(bom17), [
      "bomFormat",
      "specVersion",
      "name",
    ]);

    const bom20Input = { name: "demo", specVersion: 2 };
    const bom20 = setCycloneDxFormat(bom20Input, 2);
    assert.strictEqual(bom20, bom20Input);
    assert.strictEqual(bom20.specFormat, "CycloneDX");
    assert.strictEqual(bom20.bomFormat, undefined);
    assert.strictEqual(bom20.specVersion, "2.0");
    assert.deepStrictEqual(Object.keys(bom20), [
      "specFormat",
      "specVersion",
      "name",
    ]);

    const internalBom20 = setCycloneDxFormat(
      { name: "demo", specVersion: 2 },
      2,
      {
        preserveLegacyBomFormat: true,
      },
    );
    assert.strictEqual(internalBom20.specFormat, "CycloneDX");
    assert.strictEqual(internalBom20.bomFormat, "CycloneDX");
    assert.deepStrictEqual(Object.keys(internalBom20), [
      "bomFormat",
      "specVersion",
      "specFormat",
      "name",
    ]);
  });
});
