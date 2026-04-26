import esmock from "esmock";
import { assert, describe, it } from "poku";
import sinon from "sinon";

describe("validateSpdx()", () => {
  it("lazy-loads the bundled SPDX model on first validation call", async () => {
    const readFileSyncStub = sinon.stub().returns("[{}]");
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

  it("caches the bundled SPDX model between validation calls", async () => {
    const readFileSyncStub = sinon.stub().returns("[{}]");
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
