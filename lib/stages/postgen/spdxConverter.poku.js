import { assert, describe, it } from "poku";

import { validateSpdx } from "../../validator/bomValidator.js";
import {
  convertCycloneDxToSpdx,
  SPDX_JSONLD_CONTEXT,
} from "./spdxConverter.js";

function sampleBom() {
  return {
    bomFormat: "CycloneDX",
    specVersion: 1.7,
    serialNumber: "urn:uuid:1b671687-395b-41f5-a30f-a58921a69b79",
    version: 1,
    metadata: {
      timestamp: "2024-02-02T00:00:00Z",
      component: {
        type: "application",
        name: "demo-app",
        version: "1.0.0",
        "bom-ref": "pkg:generic/demo-app@1.0.0",
      },
    },
    components: [
      {
        type: "library",
        name: "lodash",
        version: "4.17.21",
        purl: "pkg:npm/lodash@4.17.21",
        "bom-ref": "pkg:npm/lodash@4.17.21",
        hashes: [{ alg: "SHA-256", content: "abc123" }],
      },
    ],
    dependencies: [
      {
        ref: "pkg:generic/demo-app@1.0.0",
        dependsOn: ["pkg:npm/lodash@4.17.21"],
      },
      { ref: "pkg:npm/lodash@4.17.21", dependsOn: [] },
    ],
  };
}

describe("convertCycloneDxToSpdx", () => {
  it("converts a CycloneDX BOM into SPDX 3.0.1 JSON-LD", () => {
    const spdxJson = convertCycloneDxToSpdx(sampleBom(), {
      projectName: "demo-app",
    });
    assert.strictEqual(spdxJson["@context"], SPDX_JSONLD_CONTEXT);
    assert.ok(Array.isArray(spdxJson["@graph"]));
    assert.ok(
      spdxJson["@graph"].some((element) => element.type === "SpdxDocument"),
    );
    assert.ok(
      spdxJson["@graph"].some((element) => element.type === "Relationship"),
    );
  });

  it("produces an export accepted by the bundled validator", () => {
    const spdxJson = convertCycloneDxToSpdx(sampleBom(), {
      projectName: "demo-app",
    });
    assert.strictEqual(validateSpdx(spdxJson), true);
  });

  it("rejects malformed SPDX exports", () => {
    const spdxJson = convertCycloneDxToSpdx(sampleBom(), {
      projectName: "demo-app",
    });
    spdxJson["@context"] = "https://example.com/not-spdx";
    assert.strictEqual(validateSpdx(spdxJson), false);
  });
});
