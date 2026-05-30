import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { basename, join } from "node:path";

import { assert, describe, it } from "poku";

import {
  collectHuggingFaceRepoAiInventory,
  collectJsAiInventory,
  collectNotebookAiInventory,
  collectPromptConfigAiInventory,
  collectPythonAiInventory,
} from "./aiCollector.js";

const createTempDir = () =>
  mkdtempSync(join(os.tmpdir(), "cdxgen-ai-collector-"));

const getProp = (subject, name) =>
  subject?.properties?.find((property) => property.name === name)?.value;

const GGUF_METADATA_TYPES = {
  ARRAY: 9,
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

const writeGgufFixture = (filePath, metadataEntries = []) => {
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
  pushU64(0);
  pushU64(metadataEntries.length);
  for (const entry of metadataEntries) {
    pushKeyValue(entry.key, entry.type, () =>
      writeMetadataValue(chunks, entry, writers),
    );
  }
  writeFileSync(filePath, Buffer.concat(chunks));
};

describe("aiCollector", () => {
  it("collects JavaScript AI services, model references, Modelfiles, and GGUF assets", () => {
    const tmpDir = createTempDir();
    try {
      mkdirSync(join(tmpDir, "src"), { recursive: true });
      writeFileSync(
        join(tmpDir, "src", "index.ts"),
        [
          'import OpenAI from "openai";',
          'import { InferenceClient } from "@huggingface/inference";',
          'import { pipeline } from "@huggingface/transformers";',
          'import "langchain";',
          'const model = "gpt-4o-mini";',
          'const repo_id = "openai/whisper-small";',
          'const client = new InferenceClient("sentence-transformers/all-MiniLM-L6-v2");',
          'await fetch("https://api.openai.com/v1/responses");',
          'await fetch("https://huggingface.co/datasets/argilla/databricks-dolly-15k");',
          'pipeline("text-generation", "openai/whisper-small");',
          'const mixtralArtifact = "https://huggingface.co/mistralai/Mixtral-8x7B-Instruct-v0.1/resolve/main/Mixtral-8x7B-Instruct-v0.1-Q5_K_M.gguf";',
        ].join("\n"),
      );
      writeFileSync(
        join(tmpDir, "Modelfile"),
        "FROM llama3.2\nPARAMETER temperature 0.1\nLICENSE Apache-2.0\n",
      );
      const ggufPath = join(
        tmpDir,
        "Mixtral-8x7B-Instruct-v0.1-Q5_K_M-00001-of-00002.gguf",
      );
      writeGgufFixture(ggufPath, [
        {
          key: "general.name",
          type: GGUF_METADATA_TYPES.STRING,
          value: "Mixtral-8x7B-Instruct",
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
          value:
            "{% for message in messages %}{{ message['content'] }}{% endfor %}",
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
      ]);

      const inventory = collectJsAiInventory(tmpDir, {});
      const openAiService = inventory.services.find(
        (service) => service.group === "openai",
      );
      const gptModel = inventory.components.find(
        (component) => component.name === "gpt-4o-mini",
      );
      const hfDataset = inventory.components.find(
        (component) =>
          component.group === "argilla" &&
          component.name === "databricks-dolly-15k",
      );
      const modelfileModel = inventory.components.find((component) =>
        component.properties?.some(
          (property) =>
            property.name === "cdx:ai:artifactFormat" &&
            property.value === "modelfile",
        ),
      );
      const ggufModel = inventory.components.find(
        (component) =>
          component.name === "Mixtral-8x7B-Instruct" &&
          component.properties?.some(
            (property) =>
              property.name === "cdx:ai:artifactFormat" &&
              property.value === "gguf",
          ),
      );
      const ggufFile = inventory.components.find(
        (component) =>
          component.type === "file" && component.name === basename(ggufPath),
      );
      const remoteGgufModel = inventory.components.find(
        (component) =>
          component.purl ===
          "pkg:huggingface/mistralai/Mixtral-8x7B-Instruct-v0.1",
      );

      assert.ok(openAiService, "expected OpenAI service");
      assert.ok(gptModel, "expected OpenAI model component");
      assert.ok(hfDataset, "expected Hugging Face dataset component");
      assert.ok(modelfileModel, "expected Modelfile-derived model component");
      assert.ok(ggufModel, "expected GGUF-derived model component");
      assert.ok(ggufFile, "expected GGUF file component");
      assert.ok(
        remoteGgufModel,
        "expected Hugging Face model component from standard GGUF artifact URL",
      );
      assert.ok(
        openAiService.properties.some(
          (property) =>
            property.name === "cdx:ai:modelId" &&
            property.value === "gpt-4o-mini",
        ),
      );
      assert.ok(Number(getProp(openAiService, "cdx:ai:modelCount")) >= 1);
      assert.strictEqual(
        getProp(openAiService, "cdx:ai:modelSelection"),
        "explicit",
      );
      assert.strictEqual(getProp(openAiService, "cdx:ai:deployment"), "remote");
      assert.strictEqual(
        getProp(openAiService, "cdx:ai:transportSecurity"),
        "https",
      );
      assert.ok(
        inventory.dependencies.some(
          (dependency) =>
            dependency.ref === openAiService["bom-ref"] &&
            dependency.dependsOn?.includes(gptModel["bom-ref"]),
        ),
      );
      assert.ok(
        hfDataset.externalReferences?.some((reference) =>
          reference.url.includes(
            "huggingface.co/datasets/argilla/databricks-dolly-15k",
          ),
        ),
      );
      assert.ok(
        ggufModel.properties.some(
          (property) =>
            property.name === "cdx:ai:contextWindow" &&
            property.value === "32768",
        ),
      );
      assert.strictEqual(getProp(ggufModel, "cdx:ai:quantization"), "Q5_K_M");
      assert.strictEqual(getProp(ggufModel, "cdx:gguf:sizeLabel"), "8x7B");
      assert.strictEqual(
        getProp(ggufModel, "cdx:gguf:tokenizerModel"),
        "llama",
      );
      assert.strictEqual(
        getProp(ggufModel, "cdx:gguf:tokenizerTokenCount"),
        "4",
      );
      assert.strictEqual(
        getProp(ggufModel, "cdx:gguf:tokenizerMergeCount"),
        "2",
      );
      assert.strictEqual(
        getProp(ggufModel, "cdx:gguf:tokenizerAddedTokenCount"),
        "1",
      );
      assert.strictEqual(
        getProp(ggufModel, "cdx:gguf:chatTemplateDetected"),
        "true",
      );
      assert.strictEqual(
        getProp(ggufModel, "cdx:gguf:huggingFaceTokenizer"),
        "true",
      );
      assert.strictEqual(getProp(ggufModel, "cdx:gguf:bosTokenId"), "1");
      assert.strictEqual(getProp(ggufModel, "cdx:gguf:paddingTokenId"), "0");
      assert.strictEqual(ggufModel.version, "v0.1");
      assert.strictEqual(
        ggufModel.modelCard.modelParameters.architectureFamily,
        "llama",
      );
      assert.strictEqual(
        ggufModel.modelCard.modelParameters.task,
        "text-generation",
      );
      assert.strictEqual(
        ggufModel.modelCard.modelParameters.datasets[0].contents.url,
        "https://huggingface.co/datasets/mistralai/mixtral-pretrain",
      );
      assert.strictEqual(
        ggufModel.modelCard.modelParameters.datasets[1].name,
        "internal-curated-corpus",
      );
      assert.strictEqual(
        ggufModel.modelCard.modelParameters.inputs[0].format,
        "text",
      );
      assert.strictEqual(
        ggufModel.modelCard.modelParameters.outputs[0].format,
        "text",
      );
      assert.strictEqual(
        ggufModel.pedigree.ancestors[0].purl,
        "pkg:huggingface/mistralai/Mistral-7B-Instruct-v0.2",
      );
      assert.ok(
        ggufModel.externalReferences.some(
          (reference) =>
            reference.type === "vcs" &&
            reference.url ===
              "https://huggingface.co/mistralai/Mixtral-8x7B-Instruct-v0.1",
        ),
      );
      assert.strictEqual(getProp(ggufFile, "cdx:gguf:shard"), "00001-of-00002");
      assert.strictEqual(getProp(ggufFile, "cdx:gguf:alignment"), "64");
      assert.strictEqual(
        getProp(ggufFile, "cdx:gguf:chatTemplateDetected"),
        "true",
      );
      assert.strictEqual(
        getProp(remoteGgufModel, "cdx:ai:quantization"),
        "Q5_K_M",
      );
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("ignores string literals that only look like AI SDK imports", () => {
    const tmpDir = createTempDir();
    try {
      writeFileSync(
        join(tmpDir, "index.js"),
        'const msg = "import { OpenAI } from \'openai\'";\nconst note = "from openai import OpenAI";\n',
      );

      const inventory = collectJsAiInventory(tmpDir, {});

      assert.strictEqual(inventory.components.length, 0);
      assert.strictEqual(inventory.services.length, 0);
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("collects GitHub-derived sample app fixtures with Hugging Face artifact details", () => {
    const localpilotInventory = collectPythonAiInventory(
      "./test/data/ai-huggingface/github-apps/localpilot",
      {},
    );
    const heavenBanBotInventory = collectPythonAiInventory(
      "./test/data/ai-huggingface/github-apps/heaven-ban-bot",
      {},
    );
    const lobeVidolInventory = collectJsAiInventory(
      "./test/data/ai-huggingface/github-apps/lobe-vidol",
      {},
    );

    const localpilotModel = localpilotInventory.components.find(
      (component) => component.group === "TheBloke",
    );
    const heavenBanBotModel = heavenBanBotInventory.components.find(
      (component) => component.group === "meta-llama",
    );

    assert.ok(localpilotModel, "expected model from localpilot fixture");
    assert.strictEqual(
      getProp(localpilotModel, "cdx:ai:artifactFormat"),
      "gguf",
    );
    assert.strictEqual(
      getProp(localpilotModel, "cdx:ai:quantization"),
      "Q5_K_S",
    );
    assert.ok(heavenBanBotModel, "expected model from heaven-ban-bot fixture");
    assert.strictEqual(heavenBanBotModel.name, "Llama-2-7b-chat-hf");
    assert.ok(
      lobeVidolInventory.services.some(
        (service) => service.group === "huggingface",
      ),
      "expected Hugging Face service from lobe-vidol fixture",
    );
  });

  it("collects local Hugging Face repository metadata into pedigree and model cards", () => {
    const inventory = collectHuggingFaceRepoAiInventory(
      "./test/data/ai-huggingface/repos",
      {},
    );
    const model = inventory.components.find(
      (component) =>
        component.type === "machine-learning-model" &&
        component.group === "HuggingFaceH4",
    );
    const dataset = inventory.components.find(
      (component) =>
        component.type === "data" &&
        component.group === "HuggingFaceH4" &&
        component.name === "ultrachat_200k",
    );

    assert.ok(model, "expected local Hugging Face repo model");
    assert.strictEqual(model.name, "zephyr-7b-beta");
    assert.strictEqual(model.pedigree.ancestors[0].group, "mistralai");
    assert.strictEqual(model.modelCard.modelParameters.task, "text-generation");
    assert.strictEqual(
      model.modelCard.modelParameters.datasets[0].ref,
      "pkg:huggingface/HuggingFaceH4/ultrachat_200k?repository_url=https%3A%2F%2Fhuggingface.co%2Fdatasets",
    );
    assert.strictEqual(
      model.modelCard.modelParameters.inputs[0].format,
      "text",
    );
    assert.strictEqual(
      model.modelCard.modelParameters.outputs[0].format,
      "text",
    );
    assert.ok(dataset, "expected referenced dataset component");
    assert.strictEqual(
      dataset.purl,
      "pkg:huggingface/HuggingFaceH4/ultrachat_200k?repository_url=https%3A%2F%2Fhuggingface.co%2Fdatasets",
    );
    assert.strictEqual(
      model.modelCard.quantitativeAnalysis.performanceMetrics[0].type,
      "MT-Bench",
    );
    assert.strictEqual(getProp(model, "cdx:ai:quantization"), "bnb 4-bit");
    assert.match(model.pedigree.notes, /adapter/u);
    assert.match(model.pedigree.notes, /quantized/u);
    assert.ok(
      model.modelCard.properties.some(
        (property) =>
          property.name === "cdx:huggingface:language" &&
          property.value === "en",
      ),
    );
    assert.ok(
      inventory.dependencies.some(
        (dependency) =>
          dependency.ref === model["bom-ref"] &&
          dependency.dependsOn?.includes(dataset["bom-ref"]),
      ),
    );
  });

  it("sanitizes local Hugging Face model-card dataset URLs before emitting BOM data", () => {
    const tmpDir = createTempDir();
    try {
      const repoDir = join(tmpDir, "team--model");
      mkdirSync(repoDir, { recursive: true });
      writeFileSync(
        join(repoDir, "README.md"),
        [
          "---",
          "modelId: team/model",
          "library_name: transformers",
          "datasets:",
          "  - name: team/dataset",
          "    url: https://huggingface.co/datasets/team/dataset?download=1#fragment",
          "---",
          "",
          "# team/model",
        ].join("\n"),
      );
      writeFileSync(
        join(repoDir, "config.json"),
        JSON.stringify({
          model_type: "llama",
          architectures: ["LlamaForCausalLM"],
        }),
      );

      const inventory = collectHuggingFaceRepoAiInventory(tmpDir, {});
      const model = inventory.components.find(
        (component) => component.group === "team" && component.name === "model",
      );

      assert.ok(model, "expected sanitized local Hugging Face model");
      const dataset = inventory.components.find(
        (component) =>
          component.type === "data" &&
          component.group === "team" &&
          component.name === "dataset",
      );
      assert.ok(dataset, "expected referenced dataset component");
      assert.strictEqual(
        model.modelCard.modelParameters.datasets[0].ref,
        "pkg:huggingface/team/dataset?repository_url=https%3A%2F%2Fhuggingface.co%2Fdatasets",
      );
      assert.strictEqual(
        dataset.externalReferences[0].url,
        "https://huggingface.co/datasets/team/dataset",
      );
      assert.strictEqual(
        dataset.purl,
        "pkg:huggingface/team/dataset?repository_url=https%3A%2F%2Fhuggingface.co%2Fdatasets",
      );
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("collects Python, notebook, and prompt-config AI signals with file relationships", () => {
    const tmpDir = createTempDir();
    try {
      mkdirSync(join(tmpDir, "prompts"), { recursive: true });
      writeFileSync(
        join(tmpDir, "app.py"),
        [
          "from openai import OpenAI",
          "from langchain_openai import ChatOpenAI",
          "client = OpenAI()",
          'model_name = "gpt-4.1-mini"',
          'endpoint = "https://api.openai.com/v1/responses"',
        ].join("\n"),
      );
      writeFileSync(
        join(tmpDir, "analysis.ipynb"),
        JSON.stringify({
          cells: [
            {
              cell_type: "code",
              source: [
                "import anthropic\n",
                'model = "claude-3-7-sonnet"\n',
                'url = "https://api.anthropic.com/v1/messages"\n',
              ],
            },
          ],
        }),
      );
      writeFileSync(
        join(tmpDir, "prompts", "system-prompt.yaml"),
        [
          "provider: openai",
          "model: gpt-4o-mini",
          "endpoint: https://api.openai.com/v1/chat/completions",
        ].join("\n"),
      );

      const pythonInventory = collectPythonAiInventory(tmpDir, {});
      const notebookInventory = collectNotebookAiInventory(tmpDir, {});
      const promptInventory = collectPromptConfigAiInventory(tmpDir, {});

      assert.ok(
        pythonInventory.components.some(
          (component) => component.name === "gpt-4.1-mini",
        ),
      );
      assert.ok(
        notebookInventory.components.some((component) =>
          component.properties?.some(
            (property) =>
              property.name === "cdx:file:kind" &&
              property.value === "notebook-file",
          ),
        ),
      );
      const promptFile = promptInventory.components.find((component) =>
        component.properties?.some(
          (property) =>
            property.name === "cdx:file:kind" &&
            property.value === "prompt-config-file",
        ),
      );
      const promptModel = promptInventory.components.find(
        (component) => component.name === "gpt-4o-mini",
      );
      assert.ok(promptFile, "expected prompt config file component");
      assert.ok(promptModel, "expected prompt config model component");
      assert.ok(
        promptInventory.dependencies.some(
          (dependency) =>
            dependency.ref === promptFile["bom-ref"] &&
            dependency.dependsOn?.includes(promptModel["bom-ref"]),
        ),
      );
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });
});
