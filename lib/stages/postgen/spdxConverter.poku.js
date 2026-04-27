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
        author: "Legacy Author",
        authors: [{ name: "Lodash Author", email: "author@lodash.com" }],
        publisher: "OpenJS Foundation",
        maintainers: [{ name: "Lodash Maintainer" }],
        tags: ["utility", "js"],
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

  it("converts CycloneDX 1.6 BOMs to valid SPDX 3.0.1 JSON-LD", () => {
    const bom16 = sampleBom();
    bom16.specVersion = 1.6;
    const spdxJson = convertCycloneDxToSpdx(bom16, {
      projectName: "demo-app",
    });
    assert.strictEqual(validateSpdx(spdxJson), true);
  });

  it("converts CycloneDX 1.7 BOMs to valid SPDX 3.0.1 JSON-LD", () => {
    const bom17 = sampleBom();
    bom17.specVersion = 1.7;
    const spdxJson = convertCycloneDxToSpdx(bom17, {
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
    assert.strictEqual(
      Object.hasOwn(packageElement["cdxgen:cyclonedx"], "originalHashes"),
      false,
    );
    assert.strictEqual(
      packageElement["cdxgen:cyclonedx"].author,
      "Legacy Author",
    );
    assert.strictEqual(
      packageElement["cdxgen:cyclonedx"].authors.some(
        (author) => author.name === "Lodash Author",
      ),
      true,
    );
    assert.strictEqual(
      packageElement["cdxgen:cyclonedx"].publisher,
      "OpenJS Foundation",
    );
    assert.strictEqual(
      packageElement["cdxgen:cyclonedx"].maintainers.some(
        (maintainer) => maintainer.name === "Lodash Maintainer",
      ),
      true,
    );
    assert.strictEqual(
      packageElement["cdxgen:cyclonedx"].tags.includes("utility"),
      true,
    );
    assert.strictEqual(
      packageElement["cdxgen:cyclonedx"].licenses.some(
        (licenseEntry) => licenseEntry.license.id === "MIT",
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
      documentElement["cdxgen:cyclonedx"].metadataProperties.some(
        (property) => property.name === "cdx:bom:componentTypes",
      ),
      true,
    );
  });

  it("uses component bom-ref as document name fallback before version", () => {
    const bom = sampleBom();
    delete bom.metadata.component.name;
    const spdxJson = convertCycloneDxToSpdx(bom);
    const documentElement = spdxJson["@graph"].find(
      (element) => element.type === "SpdxDocument",
    );
    assert.ok(documentElement);
    assert.strictEqual(documentElement.name, "pkg:generic/demo-app@1.0.0");
  });

  it("rejects malformed SPDX exports", () => {
    const spdxJson = convertCycloneDxToSpdx(sampleBom(), {
      projectName: "demo-app",
    });
    spdxJson["@context"] = "https://example.com/not-spdx";
    assert.strictEqual(validateSpdx(spdxJson), false);
  });

  it("rejects SPDX relationships with non-string from references", () => {
    const spdxJson = convertCycloneDxToSpdx(sampleBom(), {
      projectName: "demo-app",
    });
    const relationship = spdxJson["@graph"].find(
      (element) => element.type === "Relationship",
    );
    relationship.from = [relationship.from];
    assert.strictEqual(validateSpdx(spdxJson), false);
  });
});
