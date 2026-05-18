import { assert, describe, it } from "poku";

import { importProtobomModule, isProtoBomPath } from "./protobomLoader.js";

describe("protobomLoader", () => {
  it("detects protobuf BOM file extensions", () => {
    assert.strictEqual(isProtoBomPath("bom.cdx"), true);
    assert.strictEqual(isProtoBomPath("bom.CDX.BIN"), true);
    assert.strictEqual(isProtoBomPath("bom.proto"), true);
    assert.strictEqual(isProtoBomPath("bom.json"), false);
    assert.strictEqual(isProtoBomPath(""), false);
  });

  it("imports the protobuf BOM helper when optional support is installed", async () => {
    const protobomModule = await importProtobomModule(
      "cdx-test",
      "protobuf BOM input",
    );
    assert.strictEqual(typeof protobomModule.readBinary, "function");
    assert.strictEqual(typeof protobomModule.writeBinary, "function");
  });
});
