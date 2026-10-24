import { assert, describe, it } from "poku";

import {
  attachBrotliDecoder,
  brotliDecoderProperties,
  createBrotliComponent,
  createBrotliInventory,
  finishBrotliInventory,
} from "./brotliDecoder.js";

const SHARED_REF =
  "pkg:generic/brotli?vcs_url=git+https://github.com/google/brotli";

describe("brotli decoder inventory", () => {
  it("names the shared component apart from a brotli executable", () => {
    const component = createBrotliComponent();
    assert.strictEqual(
      component.purl,
      "pkg:generic/brotli?vcs_url=git%2Bhttps:%2F%2Fgithub.com%2Fgoogle%2Fbrotli",
    );
    assert.strictEqual(component["bom-ref"], SHARED_REF);
    assert.notStrictEqual(component["bom-ref"], "pkg:generic/brotli");
    assert.strictEqual(component.type, "library");
    assert.strictEqual(component.version, undefined);
  });

  it("records each port's fix state and why a file was not read", () => {
    assert.deepStrictEqual(
      brotliDecoderProperties({
        c: { blockSwitchFix: "false", evidence: "error-names" },
        go: { blockSwitchFix: "true" },
      }),
      [
        { name: "cdx:brotli:c:blockSwitchFix", value: "false" },
        { name: "cdx:brotli:c:evidence", value: "error-names" },
        { name: "cdx:brotli:go:blockSwitchFix", value: "true" },
      ],
    );
    assert.deepStrictEqual(brotliDecoderProperties({ skipped: "too-large" }), [
      { name: "cdx:brotli:probe", value: "too-large" },
    ]);
    assert.deepStrictEqual(brotliDecoderProperties(undefined), []);
  });

  it("tags each file and counts the unpatched and unknown copies", () => {
    const inventory = createBrotliInventory();
    const node = { "bom-ref": "pkg:generic/node", properties: [] };
    const wheel = {
      "bom-ref": "pkg:generic/_brotli.so#usr/lib/_brotli.so",
      properties: [],
    };
    const go = { "bom-ref": "pkg:generic/app", properties: [] };
    const stripped = { "bom-ref": "pkg:generic/stripped", properties: [] };
    const huge = { "bom-ref": "pkg:generic/huge", properties: [] };
    attachBrotliDecoder(inventory, node, {
      c: { blockSwitchFix: "true", evidence: "error-names" },
    });
    attachBrotliDecoder(inventory, wheel, {
      c: { blockSwitchFix: "false", evidence: "error-names" },
    });
    attachBrotliDecoder(inventory, go, { go: { blockSwitchFix: "false" } });
    attachBrotliDecoder(inventory, stripped, {
      c: { blockSwitchFix: "unknown", evidence: "tables" },
    });
    attachBrotliDecoder(inventory, huge, { skipped: "too-large" });
    assert.deepStrictEqual(huge.properties, [
      { name: "cdx:brotli:probe", value: "too-large" },
    ]);
    const { components, dependencies } = finishBrotliInventory(inventory);
    assert.strictEqual(components.length, 1);
    assert.deepStrictEqual(components[0].properties, [
      { name: "cdx:brotli:embeddedCopies", value: "4" },
      { name: "cdx:brotli:unpatchedCopies", value: "2" },
      { name: "cdx:brotli:unknownCopies", value: "1" },
    ]);
    assert.deepStrictEqual(
      dependencies.map((d) => [d.ref, d.dependsOn]),
      [
        [SHARED_REF, []],
        ["pkg:generic/node", [SHARED_REF]],
        ["pkg:generic/_brotli.so#usr/lib/_brotli.so", [SHARED_REF]],
        ["pkg:generic/app", [SHARED_REF]],
        ["pkg:generic/stripped", [SHARED_REF]],
      ],
      "a file that was not read is not linked to the decoder",
    );
  });

  it("adds nothing when no decoder was found", () => {
    assert.deepStrictEqual(finishBrotliInventory(createBrotliInventory()), {
      components: [],
      dependencies: [],
    });
  });
});
