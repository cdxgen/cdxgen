import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "poku";

import {
  ggufFileTypeName,
  parseGgufFilename,
  parseGgufMetadataBuffer,
  readGgufMetadata,
} from "./gguf.js";

const createTempDir = () =>
  mkdtempSync(join(os.tmpdir(), "cdxgen-gguf-parser-"));

const GGUF_METADATA_TYPES = {
  ARRAY: 9,
  BOOL: 7,
  STRING: 8,
  UINT32: 4,
  UINT64: 10,
};

const writeMetadataValue = (chunks, entry, writers) => {
  if (entry.type === GGUF_METADATA_TYPES.ARRAY) {
    writers.pushU32(entry.itemType);
    writers.pushU64(entry.value.length);
    for (const item of entry.value) {
      writeMetadataValue(
        chunks,
        {
          type: entry.itemType,
          value: item,
        },
        writers,
      );
    }
    return;
  }
  switch (entry.type) {
    case GGUF_METADATA_TYPES.BOOL:
      chunks.push(Buffer.from([entry.value ? 1 : 0]));
      return;
    case GGUF_METADATA_TYPES.STRING:
      writers.pushString(entry.value);
      return;
    case GGUF_METADATA_TYPES.UINT32:
      writers.pushU32(entry.value);
      return;
    case GGUF_METADATA_TYPES.UINT64:
      writers.pushU64(entry.value);
      return;
    default:
      throw new Error(`Unsupported GGUF test metadata type ${entry.type}`);
  }
};

const createGgufFixtureBuffer = (metadataEntries = [], tensorCount = 0) => {
  const chunks = [];
  const pushU32 = (value) => {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32LE(value);
    chunks.push(buffer);
  };
  const pushU64 = (value) => {
    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64LE(BigInt(value));
    chunks.push(buffer);
  };
  const pushString = (value) => {
    const buffer = Buffer.from(value, "utf-8");
    pushU64(buffer.length);
    chunks.push(buffer);
  };
  const pushKeyValue = (key, type, writer) => {
    pushString(key);
    pushU32(type);
    writer();
  };
  const writers = {
    pushString,
    pushU32,
    pushU64,
  };

  chunks.push(Buffer.from("GGUF"));
  pushU32(3);
  pushU64(tensorCount);
  pushU64(metadataEntries.length);
  for (const entry of metadataEntries) {
    pushKeyValue(entry.key, entry.type, () =>
      writeMetadataValue(chunks, entry, writers),
    );
  }
  return Buffer.concat(chunks);
};

describe("GGUF parser", () => {
  it("parses GGUF metadata from an in-memory header buffer", () => {
    const metadata = parseGgufMetadataBuffer(
      createGgufFixtureBuffer([
        {
          key: "general.name",
          type: GGUF_METADATA_TYPES.STRING,
          value: "TinyLlama-1.1B",
        },
        {
          key: "general.license",
          type: GGUF_METADATA_TYPES.STRING,
          value: "Apache-2.0",
        },
        {
          key: "general.tags",
          type: GGUF_METADATA_TYPES.ARRAY,
          itemType: GGUF_METADATA_TYPES.STRING,
          value: ["gguf", "chat"],
        },
        {
          key: "llama.context_length",
          type: GGUF_METADATA_TYPES.UINT32,
          value: 8192,
        },
        {
          key: "general.file_type",
          type: GGUF_METADATA_TYPES.UINT32,
          value: 15,
        },
      ]),
    );

    assert.strictEqual(metadata["general.name"], "TinyLlama-1.1B");
    assert.strictEqual(metadata["general.license"], "Apache-2.0");
    assert.strictEqual(metadata["llama.context_length"], 8192);
    assert.deepStrictEqual(metadata["general.tags"], ["gguf", "chat"]);
    assert.strictEqual(metadata["gguf.metadataCount"], 5);
    assert.strictEqual(
      ggufFileTypeName(metadata["general.file_type"]),
      "Q4_K_M",
    );
  });

  it("reads GGUF metadata from disk even when the header exceeds the initial prefix", () => {
    const tmpDir = createTempDir();
    try {
      const ggufFile = join(tmpDir, "tiny.gguf");
      writeFileSync(
        ggufFile,
        createGgufFixtureBuffer([
          {
            key: "general.name",
            type: GGUF_METADATA_TYPES.STRING,
            value: "TinyLlama-1.1B",
          },
          {
            key: "general.description",
            type: GGUF_METADATA_TYPES.STRING,
            value: "A".repeat(80 * 1024),
          },
          {
            key: "general.file_type",
            type: GGUF_METADATA_TYPES.UINT32,
            value: 17,
          },
        ]),
      );

      const metadata = readGgufMetadata(ggufFile);

      assert.strictEqual(metadata["general.name"], "TinyLlama-1.1B");
      assert.strictEqual(metadata["general.file_type"], 17);
      assert.strictEqual(
        String(metadata["general.description"]).length,
        80 * 1024,
      );
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("parses spec-compliant GGUF filenames into stable structured fields", () => {
    const shardedModel = parseGgufFilename(
      "Mixtral-8x7B-Instruct-v0.1-Q5_K_M-00003-of-00009.gguf",
    );
    const sidecar = parseGgufFilename("mmproj-Qwen2-VL-7B-v1.0-F16.gguf");
    const loraArtifact = parseGgufFilename("Qwen-7B-Chat-v1.0-F16-LoRA.gguf");
    const malformed = parseGgufFilename(`-${"\t-".repeat(512)}bad.gguf`);

    assert.deepStrictEqual(shardedModel, {
      baseName: "Mixtral",
      encoding: "Q5_K_M",
      fileName: "Mixtral-8x7B-Instruct-v0.1-Q5_K_M-00003-of-00009.gguf",
      fineTune: "Instruct",
      shard: "00003-of-00009",
      shardCount: 9,
      shardIndex: 3,
      sizeLabel: "8x7B",
      version: "v0.1",
    });
    assert.deepStrictEqual(sidecar, {
      baseName: "Qwen2-VL",
      encoding: "F16",
      fileName: "mmproj-Qwen2-VL-7B-v1.0-F16.gguf",
      sidecar: "mmproj",
      sizeLabel: "7B",
      version: "v1.0",
    });
    assert.deepStrictEqual(loraArtifact, {
      baseName: "Qwen",
      encoding: "F16",
      fileName: "Qwen-7B-Chat-v1.0-F16-LoRA.gguf",
      fineTune: "Chat",
      sizeLabel: "7B",
      type: "LoRA",
      version: "v1.0",
    });
    assert.strictEqual(malformed, undefined);
    assert.strictEqual(
      parseGgufFilename("codellama-7b.Q5_K_S.gguf"),
      undefined,
    );
  });
});
