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
        properties: [{ name: "cdx:app:tier", value: "backend" }],
      },
      properties: [{ name: "cdx:bom:componentTypes", value: "library" }],
    },
    components: [
      {
        type: "library",
        name: "lodash",
        version: "4.17.21",
        purl: "pkg:npm/lodash@4.17.21",
        "bom-ref": "pkg:npm/lodash@4.17.21",
        hashes: [
          { alg: "SHA-256", content: "abc123" },
          { alg: "BLAKE2s", content: "def456" },
        ],
        properties: [{ name: "cdx:npm:hasInstallScript", value: "true" }],
        externalReferences: [
          { type: "website", url: "https://lodash.com" },
          { type: "vcs", url: "https://github.com/lodash/lodash.git" },
        ],
        licenses: [{ license: { id: "MIT" } }],
      },
    ],
    dependencies: [
      {
        ref: "pkg:generic/demo-app@1.0.0",
        dependsOn: ["pkg:npm/lodash@4.17.21"],
      },
      { ref: "pkg:npm/lodash@4.17.21", dependsOn: [] },
    ],
    formulation: [
      {
        services: [
          {
            "bom-ref": "urn:example:service:api",
            name: "api-service",
            properties: [{ name: "cdx:service:httpMethod", value: "GET" }],
          },
        ],
        workflows: [
          {
            "bom-ref": "urn:example:workflow:build",
            name: "build-workflow",
            tasks: [
              {
                "bom-ref": "urn:example:task:build",
                name: "build-task",
                properties: [
                  {
                    name: "cdx:github:workflow:hasWritePermissions",
                    value: "true",
                  },
                ],
              },
            ],
          },
        ],
      },
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
    assert.deepStrictEqual(spdxJson["@graph"][0].createdBy, [
      "https://github.com/cdxgen/cdxgen",
    ]);
  });

  it("produces an export accepted by the bundled validator", () => {
    const spdxJson = convertCycloneDxToSpdx(sampleBom(), {
      projectName: "demo-app",
    });
    assert.strictEqual(validateSpdx(spdxJson), true);
  });

  it("preserves advanced CycloneDX data in SPDX extension fields", () => {
    const spdxJson = convertCycloneDxToSpdx(sampleBom(), {
      projectName: "demo-app",
    });
    const packageElement = spdxJson["@graph"].find(
      (element) => element.software_packageUrl === "pkg:npm/lodash@4.17.21",
    );
    assert.ok(packageElement);
    assert.ok(Array.isArray(packageElement.externalRefs));
    assert.strictEqual(
      packageElement["cdxgen:cyclonedx"].properties.some(
        (property) => property.name === "cdx:npm:hasInstallScript",
      ),
      true,
    );
    assert.strictEqual(
      packageElement["cdxgen:cyclonedx"].hashes.some(
        (hash) => hash.algorithm === "BLAKE2s",
      ),
      true,
    );
    const documentElement = spdxJson["@graph"].find(
      (element) => element.type === "SpdxDocument",
    );
    assert.ok(documentElement);
    assert.strictEqual(
      Array.isArray(documentElement["cdxgen:cyclonedx"].formulation),
      true,
    );
    assert.strictEqual(
      documentElement["cdxgen:cyclonedx"].bomProperties.some(
        (property) => property.name === "cdx:bom:componentTypes",
      ),
      true,
    );
  });

  it("rejects malformed SPDX exports", () => {
    const spdxJson = convertCycloneDxToSpdx(sampleBom(), {
      projectName: "demo-app",
    });
    spdxJson["@context"] = "https://example.com/not-spdx";
    assert.strictEqual(validateSpdx(spdxJson), false);
  });
});
