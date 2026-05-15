import esmock from "esmock";
import { assert, describe, it } from "poku";
import sinon from "sinon";

import { validateBom } from "./bomValidator.js";

describe("validateBom()", () => {
  it("validates CycloneDX 2.0-dev JSON against the bundled schema", () => {
    const bomJson = {
      specFormat: "CycloneDX",
      specVersion: "2.0",
      serialNumber: "urn:uuid:3e671687-395b-41f5-a30f-a58921a69b79",
      version: 1,
      metadata: {
        component: {
          "bom-ref": "pkg:generic/demo@1.0.0",
          name: "demo",
          purl: "pkg:generic/demo@1.0.0",
          type: "application",
          version: "1.0.0",
        },
        tools: {
          components: [
            { type: "application", name: "cdxgen", version: "12.4.0" },
          ],
        },
      },
      components: [
        {
          "bom-ref": "pkg:npm/lodash@4.17.21",
          name: "lodash",
          purl: "pkg:npm/lodash@4.17.21",
          type: "library",
          version: "4.17.21",
        },
      ],
      dependencies: [
        {
          ref: "pkg:generic/demo@1.0.0",
          dependsOn: ["pkg:npm/lodash@4.17.21"],
        },
        { ref: "pkg:npm/lodash@4.17.21", dependsOn: [] },
      ],
    };
    assert.strictEqual(validateBom(bomJson), true);
  });
});

describe("validateSpdx()", () => {
  it("lazy-loads the bundled SPDX export schema on first validation call", async () => {
    const readFileSyncStub = sinon
      .stub()
      .returns(
        '{"type":"object","properties":{"@context":{"const":"https://spdx.org/rdf/3.0.1/spdx-context.jsonld"},"@graph":{"type":"array"}}}',
      );
    const { validateSpdx } = await esmock("./bomValidator.js", {
      "node:fs": {
        readFileSync: readFileSyncStub,
      },
      "../helpers/utils.js": {
        DEBUG_MODE: false,
        dirNameStr: "/tmp",
        isPartialTree: sinon.stub().returns(false),
      },
      "../stages/postgen/spdxConverter.js": {
        SPDX_JSONLD_CONTEXT: "https://spdx.org/rdf/3.0.1/spdx-context.jsonld",
        SPDX_SPEC_VERSION: "3.0.1",
      },
    });

    sinon.assert.notCalled(readFileSyncStub);
    assert.strictEqual(
      validateSpdx({
        "@context": "https://spdx.org/rdf/3.0.1/spdx-context.jsonld",
        "@graph": [],
      }),
      false,
    );
    sinon.assert.calledOnce(readFileSyncStub);
  });

  it("caches the bundled SPDX export schema between validation calls", async () => {
    const readFileSyncStub = sinon
      .stub()
      .returns(
        '{"type":"object","properties":{"@context":{"const":"https://spdx.org/rdf/3.0.1/spdx-context.jsonld"},"@graph":{"type":"array"}}}',
      );
    const { validateSpdx } = await esmock("./bomValidator.js", {
      "node:fs": {
        readFileSync: readFileSyncStub,
      },
      "../helpers/utils.js": {
        DEBUG_MODE: false,
        dirNameStr: "/tmp",
        isPartialTree: sinon.stub().returns(false),
      },
      "../stages/postgen/spdxConverter.js": {
        SPDX_JSONLD_CONTEXT: "https://spdx.org/rdf/3.0.1/spdx-context.jsonld",
        SPDX_SPEC_VERSION: "3.0.1",
      },
    });

    validateSpdx({
      "@context": "https://spdx.org/rdf/3.0.1/spdx-context.jsonld",
      "@graph": [],
    });
    validateSpdx({
      "@context": "https://spdx.org/rdf/3.0.1/spdx-context.jsonld",
      "@graph": [],
    });

    sinon.assert.calledOnce(readFileSyncStub);
  });
});
