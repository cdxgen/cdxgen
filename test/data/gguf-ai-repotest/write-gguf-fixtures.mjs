import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const GGUF_METADATA_TYPES = {
  ARRAY: 9,
  STRING: 8,
  UINT32: 4,
  UINT64: 10,
};

const fixtureDirectory = dirname(fileURLToPath(import.meta.url));

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
      throw new Error(`Unsupported GGUF fixture metadata type ${entry.type}`);
  }
};

const writeGgufFixture = (filePath, metadataEntries) => {
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
    const buffer = Buffer.from(String(value), "utf-8");
    pushU64(buffer.length);
    chunks.push(buffer);
  };
  const writers = {
    pushString,
    pushU32,
    pushU64,
  };
  chunks.push(Buffer.from("GGUF"));
  pushU32(3);
  pushU64(0);
  pushU64(metadataEntries.length);
  for (const entry of metadataEntries) {
    pushString(entry.key);
    pushU32(entry.type);
    writeMetadataValue(chunks, entry, writers);
  }
  writeFileSync(filePath, Buffer.concat(chunks));
};

writeGgufFixture(
  join(
    fixtureDirectory,
    "Mixtral-8x7B-Instruct-v0.1-Q5_K_M-00001-of-00002.gguf",
  ),
  [
    {
      key: "general.name",
      type: GGUF_METADATA_TYPES.STRING,
      value: "Mixtral-8x7B-Instruct",
    },
    {
      key: "general.description",
      type: GGUF_METADATA_TYPES.STRING,
      value: "Fixture GGUF used by repotests to validate AI-BOM enrichment.",
    },
    {
      key: "general.license",
      type: GGUF_METADATA_TYPES.STRING,
      value: "Apache-2.0",
    },
    {
      key: "general.architecture",
      type: GGUF_METADATA_TYPES.STRING,
      value: "llama",
    },
    {
      key: "general.basename",
      type: GGUF_METADATA_TYPES.STRING,
      value: "Mixtral",
    },
    {
      key: "general.size_label",
      type: GGUF_METADATA_TYPES.STRING,
      value: "8x7B",
    },
    {
      key: "general.finetune",
      type: GGUF_METADATA_TYPES.STRING,
      value: "Instruct",
    },
    {
      key: "general.version",
      type: GGUF_METADATA_TYPES.STRING,
      value: "v0.1",
    },
    {
      key: "general.organization",
      type: GGUF_METADATA_TYPES.STRING,
      value: "mistralai",
    },
    {
      key: "general.repo_url",
      type: GGUF_METADATA_TYPES.STRING,
      value: "https://huggingface.co/mistralai/Mixtral-8x7B-Instruct-v0.1",
    },
    {
      key: "general.base_model.count",
      type: GGUF_METADATA_TYPES.UINT32,
      value: 1,
    },
    {
      key: "general.base_model.0.repo_url",
      type: GGUF_METADATA_TYPES.STRING,
      value: "https://huggingface.co/mistralai/Mistral-7B-Instruct-v0.2",
    },
    {
      key: "general.base_model.0.name",
      type: GGUF_METADATA_TYPES.STRING,
      value: "Mistral-7B-Instruct-v0.2",
    },
    {
      key: "general.base_model.0.organization",
      type: GGUF_METADATA_TYPES.STRING,
      value: "mistralai",
    },
    {
      key: "general.base_model.0.version",
      type: GGUF_METADATA_TYPES.STRING,
      value: "v0.2",
    },
    {
      key: "general.quantization_version",
      type: GGUF_METADATA_TYPES.UINT32,
      value: 2,
    },
    {
      key: "general.alignment",
      type: GGUF_METADATA_TYPES.UINT32,
      value: 64,
    },
    {
      key: "general.tags",
      type: GGUF_METADATA_TYPES.ARRAY,
      itemType: GGUF_METADATA_TYPES.STRING,
      value: ["mixture-of-experts", "gguf", "text-generation"],
    },
    {
      key: "general.languages",
      type: GGUF_METADATA_TYPES.ARRAY,
      itemType: GGUF_METADATA_TYPES.STRING,
      value: ["en", "fr"],
    },
    {
      key: "general.datasets",
      type: GGUF_METADATA_TYPES.ARRAY,
      itemType: GGUF_METADATA_TYPES.STRING,
      value: [
        "https://huggingface.co/datasets/mistralai/mixtral-pretrain",
        "internal-curated-corpus",
      ],
    },
    {
      key: "tokenizer.ggml.model",
      type: GGUF_METADATA_TYPES.STRING,
      value: "llama",
    },
    {
      key: "tokenizer.ggml.tokens",
      type: GGUF_METADATA_TYPES.ARRAY,
      itemType: GGUF_METADATA_TYPES.STRING,
      value: ["<s>", "</s>", "hello", "world"],
    },
    {
      key: "tokenizer.ggml.scores",
      type: GGUF_METADATA_TYPES.ARRAY,
      itemType: GGUF_METADATA_TYPES.UINT32,
      value: [1, 2, 3, 4],
    },
    {
      key: "tokenizer.ggml.token_type",
      type: GGUF_METADATA_TYPES.ARRAY,
      itemType: GGUF_METADATA_TYPES.UINT32,
      value: [3, 3, 1, 1],
    },
    {
      key: "tokenizer.ggml.merges",
      type: GGUF_METADATA_TYPES.ARRAY,
      itemType: GGUF_METADATA_TYPES.STRING,
      value: ["h e", "he llo"],
    },
    {
      key: "tokenizer.ggml.added_tokens",
      type: GGUF_METADATA_TYPES.ARRAY,
      itemType: GGUF_METADATA_TYPES.STRING,
      value: ["<tool_call>"],
    },
    {
      key: "tokenizer.ggml.bos_token_id",
      type: GGUF_METADATA_TYPES.UINT32,
      value: 1,
    },
    {
      key: "tokenizer.ggml.eos_token_id",
      type: GGUF_METADATA_TYPES.UINT32,
      value: 2,
    },
    {
      key: "tokenizer.ggml.padding_token_id",
      type: GGUF_METADATA_TYPES.UINT32,
      value: 0,
    },
    {
      key: "tokenizer.chat_template",
      type: GGUF_METADATA_TYPES.STRING,
      value: "{% for message in messages %}{{ message['content'] }}{% endfor %}",
    },
    {
      key: "tokenizer.huggingface.json",
      type: GGUF_METADATA_TYPES.STRING,
      value: '{"version":"1.0"}',
    },
    {
      key: "llama.context_length",
      type: GGUF_METADATA_TYPES.UINT64,
      value: 32768,
    },
    {
      key: "general.file_type",
      type: GGUF_METADATA_TYPES.UINT32,
      value: 17,
    },
  ],
);
