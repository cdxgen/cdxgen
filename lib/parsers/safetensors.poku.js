import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "poku";

import { readSafetensorsHeader } from "./safetensors.js";

const createTempDir = () =>
  mkdtempSync(join(os.tmpdir(), "cdxgen-safetensors-"));

/**
 * Write a minimal safetensors file: an 8-byte little-endian header length,
 * the JSON header, then a zero-filled tensor payload region.
 */
function writeSafetensors(filePath, header) {
  const headerJson = Buffer.from(JSON.stringify(header), "utf-8");
  const lengthBuffer = Buffer.alloc(8);
  lengthBuffer.writeBigUInt64LE(BigInt(headerJson.length));
  // A small payload so the declared data_offsets stay within the file.
  const payload = Buffer.alloc(64);
  writeFileSync(filePath, Buffer.concat([lengthBuffer, headerJson, payload]));
}

describe("readSafetensorsHeader()", () => {
  it("summarizes metadata, tensor count, dtypes, and parameters", () => {
    const tmpDir = createTempDir();
    try {
      const filePath = join(tmpDir, "model.safetensors");
      writeSafetensors(filePath, {
        __metadata__: { format: "pt", quant_method: "gptq" },
        "model.layer.0.weight": {
          dtype: "F16",
          shape: [4, 8],
          data_offsets: [0, 64],
        },
        "model.layer.0.bias": {
          dtype: "F16",
          shape: [8],
          data_offsets: [0, 0],
        },
      });

      const header = readSafetensorsHeader(filePath);
      assert.ok(header, "expected a parsed header");
      assert.strictEqual(header.tensorCount, 2);
      assert.deepStrictEqual(header.dtypes, ["F16"]);
      assert.strictEqual(header.totalParameters, 40);
      assert.strictEqual(header.metadata.quant_method, "gptq");
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("records only dtype values that look like dtype names", () => {
    const tmpDir = createTempDir();
    try {
      const filePath = join(tmpDir, "model.safetensors");
      const header = {
        a: { dtype: "F8_E4M3", shape: [2], data_offsets: [0, 2] },
        b: { dtype: "x".repeat(4096), shape: [2], data_offsets: [0, 2] },
        c: { dtype: "not a dtype", shape: [2], data_offsets: [0, 2] },
      };
      for (let index = 0; index < 100; index++) {
        header[`t${index}`] = {
          dtype: `Q${index}`,
          shape: [1],
          data_offsets: [0, 1],
        };
      }
      writeSafetensors(filePath, header);

      const parsed = readSafetensorsHeader(filePath);
      assert.ok(parsed, "expected a parsed header");
      assert.strictEqual(parsed.tensorCount, 103);
      assert.ok(parsed.dtypes.includes("F8_E4M3"));
      assert.ok(!parsed.dtypes.some((dtype) => dtype.length > 16));
      assert.strictEqual(parsed.dtypes.length, 32);
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("returns undefined for non-safetensors input", () => {
    const tmpDir = createTempDir();
    try {
      const filePath = join(tmpDir, "notmodel.safetensors");
      writeFileSync(filePath, Buffer.from("this is not safetensors"));
      assert.strictEqual(readSafetensorsHeader(filePath), undefined);
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });
});
