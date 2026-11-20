import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "poku";

import {
  writeRawSafetensors,
  writeSafetensorsFile,
} from "../../test/helpers/modelFixtures.js";
import { inspectSafetensors, readSafetensorsHeader } from "./safetensors.js";

const withFile = (callback) => {
  const tmpDir = mkdtempSync(join(os.tmpdir(), "cdxgen-safetensors-"));
  try {
    callback(join(tmpDir, "model.safetensors"));
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
  }
};

const tensor = (dtype, shape, begin, end) => ({
  dtype,
  shape,
  data_offsets: [begin, end],
});

// Writes a raw header and returns the inspection result.
const inspectRaw = (header, bufferBytes, options) => {
  let result;
  withFile((filePath) => {
    writeRawSafetensors(filePath, header, bufferBytes, options);
    result = inspectSafetensors(filePath);
  });
  return result;
};

describe("readSafetensorsHeader()", () => {
  it("summarizes metadata, tensor count, dtypes, and parameters", () => {
    withFile((filePath) => {
      writeSafetensorsFile(
        filePath,
        {
          "model.layer.0.weight": { dtype: "F16", shape: [4, 8] },
          "model.layer.0.bias": { dtype: "F16", shape: [8] },
        },
        { metadata: { format: "pt", quant_method: "gptq" } },
      );
      const header = readSafetensorsHeader(filePath);
      assert.ok(header, "expected a parsed header");
      assert.strictEqual(header.tensorCount, 2);
      assert.deepStrictEqual(header.dtypes, ["F16"]);
      assert.strictEqual(header.totalParameters, 40);
      assert.strictEqual(header.dataBytes, 80);
      assert.strictEqual(header.format, "pt");
      assert.strictEqual(header.metadataKeyCount, 2);
      assert.strictEqual(header.metadata.quant_method, "gptq");
    });
  });

  it("counts a scalar tensor as one element", () => {
    const result = inspectRaw({ s: tensor("F32", [], 0, 4) }, 4);
    assert.ok(result.ok);
    assert.strictEqual(result.header.totalParameters, 1);
  });

  it("accepts a zero-sized dimension that holds no bytes", () => {
    const result = inspectRaw(
      { z: tensor("F32", [0, 8], 0, 0), w: tensor("F32", [2], 0, 8) },
      8,
    );
    assert.ok(result.ok);
    assert.strictEqual(result.header.totalParameters, 2);
  });

  it("rejects holes, overlaps and size mismatches between offsets", () => {
    const hole = inspectRaw(
      { a: tensor("U8", [2], 0, 2), b: tensor("U8", [2], 4, 6) },
      6,
    );
    assert.ok(!hole.ok);
    assert.match(hole.reason, /hole/u);
    const overlap = inspectRaw(
      { a: tensor("U8", [4], 0, 4), b: tensor("U8", [4], 2, 6) },
      6,
    );
    assert.ok(!overlap.ok);
    assert.match(overlap.reason, /overlap/u);
    const late = inspectRaw({ a: tensor("U8", [2], 2, 4) }, 4);
    assert.ok(!late.ok);
    const wrongSize = inspectRaw({ a: tensor("F32", [2], 0, 4) }, 4);
    assert.ok(!wrongSize.ok);
    const backwards = inspectRaw({ a: tensor("U8", [0], 4, 2) }, 4);
    assert.ok(!backwards.ok);
  });

  it("rejects a buffer shorter or longer than the offsets declare", () => {
    const header = { a: tensor("U8", [8], 0, 8) };
    assert.ok(inspectRaw(header, 8).ok);
    assert.ok(!inspectRaw(header, 4).ok);
    assert.ok(!inspectRaw(header, 12).ok);
  });

  it("rejects a header that declares a huge shape without data", () => {
    const result = inspectRaw({ a: tensor("F32", [1e9, 1e9], 0, 4) }, 4);
    assert.ok(!result.ok);
    assert.strictEqual(readSafetensorsHeader("/nonexistent"), undefined);
  });

  it("rejects a parameter product above the safe integer range", () => {
    const result = inspectRaw({ a: tensor("U8", [2 ** 30, 2 ** 30], 0, 0) }, 0);
    assert.ok(!result.ok);
    assert.match(result.reason, /safe integer/u);
  });

  it("rejects negative and fractional dimensions", () => {
    assert.ok(!inspectRaw({ a: tensor("U8", [-1], 0, 0) }, 0).ok);
    assert.ok(!inspectRaw({ a: tensor("U8", [1.5], 0, 1) }, 1).ok);
  });

  it("rejects sub-byte tensors that are not a whole number of bytes", () => {
    assert.ok(!inspectRaw({ a: tensor("F4", [3], 0, 1) }, 1).ok);
    assert.ok(inspectRaw({ a: tensor("F4", [4], 0, 2) }, 2).ok);
    assert.ok(inspectRaw({ a: tensor("F6_E2M3", [4], 0, 3) }, 3).ok);
  });

  it("keeps a file with an unknown dtype and skips its size check", () => {
    const result = inspectRaw({ a: tensor("Q4_K", [4], 0, 3) }, 3);
    assert.ok(result.ok);
    assert.strictEqual(result.header.unknownDtypeTensors, 1);
    assert.strictEqual(result.header.totalParameters, 4);
    assert.deepStrictEqual(result.header.dtypes, ["Q4_K"]);
  });

  it("tolerates leading whitespace and trailing space padding", () => {
    const header = { a: tensor("U8", [2], 0, 2) };
    assert.ok(inspectRaw(header, 2, { padding: 6 }).ok);
    assert.ok(inspectRaw(header, 2, { leading: " \n", padding: 3 }).ok);
  });

  it("rejects a header that does not start with a brace", () => {
    const result = inspectRaw('["x"]', 0);
    assert.ok(!result.ok);
    assert.match(result.reason, /'\{'/u);
    assert.ok(!inspectRaw("x{}", 0).ok);
  });

  it("rejects duplicate keys in the header", () => {
    const text =
      '{"a":{"dtype":"U8","shape":[1],"data_offsets":[0,1]},' +
      '"a":{"dtype":"U8","shape":[1],"data_offsets":[1,2]}}';
    const result = inspectRaw(text, 2);
    assert.ok(!result.ok);
    assert.match(result.reason, /repeats a key/u);
  });

  it("ignores __metadata__ values that are not strings", () => {
    const result = inspectRaw(
      {
        __metadata__: {
          format: "pt",
          nested: { token: "ghp_secret" },
          count: 3,
          note: "kept",
        },
      },
      0,
    );
    assert.ok(result.ok);
    assert.strictEqual(result.header.metadataKeyCount, 2);
    assert.deepStrictEqual(Object.keys(result.header.metadata).sort(), [
      "format",
      "note",
    ]);
    const odd = inspectRaw({ __metadata__: { format: "Not A Token!" } }, 0);
    assert.strictEqual(odd.header.format, undefined);
  });

  it("records only dtype values that look like dtype names", () => {
    const header = {
      a: tensor("F8_E4M3", [2], 0, 2),
      b: tensor("x".repeat(4096), [2], 2, 4),
      c: tensor("not a dtype", [2], 4, 6),
    };
    let offset = 6;
    for (let index = 0; index < 100; index++) {
      header[`t${index}`] = tensor(`Q${index}`, [1], offset, offset + 1);
      offset += 1;
    }
    const result = inspectRaw(header, offset);
    assert.ok(result.ok);
    assert.strictEqual(result.header.tensorCount, 103);
    assert.ok(result.header.dtypes.includes("F8_E4M3"));
    assert.ok(!result.header.dtypes.some((dtype) => dtype.length > 16));
    assert.strictEqual(result.header.dtypes.length, 32);
  });

  it("returns undefined for non-safetensors input", () => {
    withFile((filePath) => {
      writeFileSync(filePath, Buffer.from("this is not safetensors"));
      assert.strictEqual(readSafetensorsHeader(filePath), undefined);
    });
  });

  it("rejects a file shorter than its declared header", () => {
    withFile((filePath) => {
      const length = Buffer.alloc(8);
      length.writeBigUInt64LE(100n);
      writeFileSync(filePath, Buffer.concat([length, Buffer.from("{}")]));
      assert.ok(!inspectSafetensors(filePath).ok);
    });
  });

  it("accepts an empty header and a large tensor table", () => {
    withFile((filePath) => {
      writeRawSafetensors(filePath, {}, 0);
      assert.strictEqual(readSafetensorsHeader(filePath)?.tensorCount, 0);
      const header = { __metadata__: {} };
      for (let i = 0; i < 10000; i++) {
        header[`model.layers.${i}.weight`] = tensor(
          "U8",
          [4],
          i * 4,
          i * 4 + 4,
        );
      }
      writeRawSafetensors(filePath, header, 40000);
      assert.strictEqual(readSafetensorsHeader(filePath)?.tensorCount, 10000);
    });
  });

  it("returns undefined for a header that is an array", () => {
    withFile((filePath) => {
      writeRawSafetensors(filePath, [tensor("F16", [8], 0, 16)], 16);
      assert.strictEqual(readSafetensorsHeader(filePath), undefined);
    });
  });

  it("returns undefined for a header longer than the limit", () => {
    withFile((filePath) => {
      writeRawSafetensors(filePath, `{}${" ".repeat(8 * 1024 * 1024)}`, 0);
      assert.strictEqual(readSafetensorsHeader(filePath), undefined);
    });
  });
});
