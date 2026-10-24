import { assert, describe, it } from "poku";

import {
  attachBrotliDecoder,
  brotliDecoderProperties,
  createBrotliComponent,
  createBrotliInventory,
  finishBrotliInventory,
} from "./brotliDecoder.js";

describe("brotli decoder inventory", () => {
  it("names the shared component without a version", () => {
    const component = createBrotliComponent();
    assert.strictEqual(component.purl, "pkg:generic/brotli");
    assert.strictEqual(component["bom-ref"], "pkg:generic/brotli");
    assert.strictEqual(component.version, undefined);
  });

  it("tags each file and counts the unpatched copies", () => {
    const inventory = createBrotliInventory();
    const node = { "bom-ref": "pkg:generic/node", properties: [] };
    const wheel = {
      "bom-ref": "pkg:generic/_brotli.so#usr/lib/_brotli.so",
      properties: [],
    };
    const go = { "bom-ref": "pkg:generic/app", properties: [] };
    attachBrotliDecoder(inventory, node, { blockSwitchFix: true, port: "c" });
    attachBrotliDecoder(inventory, wheel, { blockSwitchFix: false, port: "c" });
    attachBrotliDecoder(inventory, go, { blockSwitchFix: false, port: "go" });
    assert.deepStrictEqual(wheel.properties, [
      { name: "cdx:brotli:decoder", value: "c" },
      { name: "cdx:brotli:blockSwitchFix", value: "false" },
    ]);
    assert.deepStrictEqual(
      go.properties,
      brotliDecoderProperties({ blockSwitchFix: false, port: "go" }),
    );
    const { components, dependencies } = finishBrotliInventory(inventory);
    assert.strictEqual(components.length, 1);
    assert.deepStrictEqual(components[0].properties, [
      { name: "cdx:brotli:embeddedCopies", value: "3" },
      { name: "cdx:brotli:unpatchedCopies", value: "2" },
    ]);
    assert.deepStrictEqual(
      dependencies.map((d) => [d.ref, d.dependsOn]),
      [
        ["pkg:generic/brotli", []],
        ["pkg:generic/node", ["pkg:generic/brotli"]],
        ["pkg:generic/_brotli.so#usr/lib/_brotli.so", ["pkg:generic/brotli"]],
        ["pkg:generic/app", ["pkg:generic/brotli"]],
      ],
    );
  });

  it("adds nothing when no decoder was found", () => {
    assert.deepStrictEqual(finishBrotliInventory(createBrotliInventory()), {
      components: [],
      dependencies: [],
    });
  });
});
