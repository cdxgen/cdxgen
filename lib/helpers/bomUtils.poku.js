import { assert, describe, it } from "poku";

import {
  detectBomFormat,
  getNonCycloneDxErrorMessage,
  isCycloneDxBom,
  isSpdxJsonLd,
} from "./bomUtils.js";

const sampleSpdx = {
  "@context": "https://spdx.org/rdf/3.0.1/spdx-context.jsonld",
  "@graph": [{ type: "SpdxDocument", spdxId: "urn:demo#SPDXRef-DOCUMENT" }],
};

describe("bomUtils", () => {
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
});
