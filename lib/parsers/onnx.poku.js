import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "poku";

import {
  pbBytes,
  pbFixed32,
  pbFixed64,
  pbMetadataProp,
  pbOpset,
  pbVarint,
  validOnnxFields,
  writeOnnxFile,
} from "../../test/helpers/modelFixtures.js";
import { readOnnxHeader } from "./onnx.js";

const withTempDir = (callback) => {
  const tmpDir = mkdtempSync(join(os.tmpdir(), "cdxgen-onnx-"));
  try {
    callback(tmpDir);
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
  }
};

const read = (fields) => {
  let result;
  withTempDir((tmpDir) => {
    const filePath = join(tmpDir, "model.onnx");
    writeOnnxFile(filePath, fields);
    result = readOnnxHeader(filePath);
  });
  return result;
};

describe("readOnnxHeader", () => {
  it("reads ir version, producer, and opsets from a minimal model", () => {
    const header = readOnnxHeader("./test/data/onnx-model.onnx");
    assert.ok(header);
    assert.strictEqual(header.irVersion, 9);
    assert.strictEqual(header.producerName, "cdxgen-test");
    assert.strictEqual(header.producerVersion, "1.2.3");
    assert.strictEqual(header.modelVersion, 42);
    assert.deepStrictEqual(header.opsets, [
      { domain: "ai.onnx", version: 17 },
      { domain: "com.microsoft", version: 1 },
    ]);
  });

  it("returns undefined for non-onnx input", () => {
    assert.strictEqual(readOnnxHeader("./package.json"), undefined);
    withTempDir((tmpDir) => {
      const filePath = join(tmpDir, "model.onnx");
      writeFileSync(filePath, "hello world");
      assert.strictEqual(readOnnxHeader(filePath), undefined);
    });
  });

  it("returns undefined for missing files", () => {
    assert.strictEqual(readOnnxHeader("./test/data/missing.onnx"), undefined);
  });

  it("rejects the two bytes 08 01 that carry only an ir_version", () => {
    assert.strictEqual(read([Buffer.from([0x08, 0x01])]), undefined);
  });

  it("reads fields that follow a fixed-width field", () => {
    for (const fixed of [pbFixed32(30), pbFixed64(31)]) {
      const header = read([pbVarint(1, 9), fixed, pbOpset("", 17)]);
      assert.ok(header);
      assert.deepStrictEqual(header.opsets, [
        { domain: "ai.onnx", version: 17 },
      ]);
    }
  });

  it("reads fields in any order and keeps interleaved opsets", () => {
    const header = read([
      pbOpset("com.microsoft", 1),
      pbBytes(7, Buffer.alloc(50, 1)),
      pbBytes(2, "pytorch"),
      pbOpset("", 18),
      pbVarint(1, 10),
      pbBytes(4, "ai.example"),
      pbVarint(5, 3),
    ]);
    assert.ok(header);
    assert.strictEqual(header.irVersion, 10);
    assert.strictEqual(header.domain, "ai.example");
    assert.strictEqual(header.modelVersion, 3);
    assert.strictEqual(header.hasGraph, true);
    assert.deepStrictEqual(header.opsets, [
      { domain: "com.microsoft", version: 1 },
      { domain: "ai.onnx", version: 18 },
    ]);
  });

  it("labels the empty and the explicit default domain alike", () => {
    const header = read([
      pbVarint(1, 9),
      pbOpset("", 17),
      pbOpset("ai.onnx", 17),
    ]);
    assert.deepStrictEqual(header.opsets, [{ domain: "ai.onnx", version: 17 }]);
  });

  it("accepts a graph without any opset_import", () => {
    const header = read([pbVarint(1, 9), pbBytes(7, Buffer.alloc(8))]);
    assert.ok(header);
    assert.deepStrictEqual(header.opsets, []);
  });

  it("rejects a header with neither opset_import nor graph", () => {
    assert.strictEqual(read([pbVarint(1, 9), pbBytes(2, "x")]), undefined);
  });

  it("rejects ir_version values that are zero, negative or too large", () => {
    assert.strictEqual(read([pbVarint(1, 0), pbOpset("", 1)]), undefined);
    assert.strictEqual(read([pbVarint(1, -1), pbOpset("", 1)]), undefined);
    assert.strictEqual(read([pbVarint(1, 65), pbOpset("", 1)]), undefined);
    assert.strictEqual(
      read([pbVarint(1, 2n ** 60n), pbOpset("", 1)]),
      undefined,
    );
    assert.ok(read([pbVarint(1, 13), pbOpset("", 1)]));
  });

  it("rejects opset versions that are negative or unsafe", () => {
    assert.strictEqual(read([pbVarint(1, 9), pbOpset("", -1)]), undefined);
    assert.strictEqual(
      read([pbVarint(1, 9), pbOpset("", 2n ** 60n)]),
      undefined,
    );
  });

  it("rejects a varint that is longer than ten bytes", () => {
    const tooLong = Buffer.concat([
      Buffer.from([0x08]),
      Buffer.alloc(10, 0xff),
      Buffer.from([0x01]),
    ]);
    assert.strictEqual(read([tooLong, pbOpset("", 1)]), undefined);
  });

  it("rejects known fields with the wrong wire type", () => {
    // ir_version written as a length-delimited field.
    assert.strictEqual(read([pbBytes(1, "9"), pbOpset("", 17)]), undefined);
    // producer_name written as a varint.
    assert.strictEqual(
      read([pbVarint(1, 9), pbVarint(2, 1), pbOpset("", 17)]),
      undefined,
    );
  });

  it("drops strings that are not UTF-8 or hold control characters", () => {
    const header = read(
      validOnnxFields([
        pbBytes(4, Buffer.from([0xff, 0xfe])),
        pbBytes(3, "1.0\u0007"),
      ]),
    );
    assert.ok(header);
    assert.strictEqual(header.domain, "");
    assert.strictEqual(header.producerVersion, "");
    assert.strictEqual(header.producerName, "pytorch");
  });

  it("rejects an opset whose domain is not plain text", () => {
    const opset = Buffer.concat([
      pbBytes(1, Buffer.from([0xff, 0xfe])),
      pbVarint(2, 17),
    ]);
    assert.strictEqual(read([pbVarint(1, 9), pbBytes(8, opset)]), undefined);
  });

  it("counts metadata_props and reports only allowlisted keys", () => {
    const header = read(
      validOnnxFields([
        pbMetadataProp("converted_from", "tf"),
        pbMetadataProp("api_token", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"),
        pbMetadataProp("onnx_runtime_version", "1.19"),
      ]),
    );
    assert.strictEqual(header.metadataPropsCount, 3);
    assert.deepStrictEqual(header.metadataKeys, [
      "converted_from",
      "onnx_runtime_version",
    ]);
    assert.ok(!JSON.stringify(header).includes("ghp_"));
  });

  it("stops at the top-level field cap without failing", () => {
    const fields = [pbVarint(1, 9), pbOpset("", 17)];
    for (let index = 0; index < 300; index += 1) {
      fields.push(pbBytes(25, "f"));
    }
    assert.ok(read(fields));
  });

  it("rejects a field that runs past the end of the file", () => {
    assert.strictEqual(
      read([pbVarint(1, 9), Buffer.from([0x3a, 0x7f, 0x01])]),
      undefined,
    );
  });
});
