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

  it("does not emit out-of-range GGUF alignment values", () => {
    const tmpDir = createTempDir();
    try {
      writeFileSync(join(tmpDir, "index.js"), "console.log('ok');\n");
      const ggufPath = join(tmpDir, "test-model.Q5_K_M.gguf");
      writeGgufFixture(ggufPath, [
        {
          key: "general.name",
          type: GGUF_METADATA_TYPES.STRING,
          value: "test-model",
        },
        {
          key: "general.alignment",
          type: GGUF_METADATA_TYPES.UINT64,
          value: 1048577,
        },
      ]);

      const inventory = collectJsAiInventory(tmpDir, {});
      const ggufFile = inventory.components.find(
        (component) =>
          component.type === "file" && component.name === basename(ggufPath),
      );

      assert.ok(ggufFile);
      assert.strictEqual(getProp(ggufFile, "cdx:gguf:alignment"), undefined);
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("does not emit malformed string GGUF alignment values", () => {
    const tmpDir = createTempDir();
    try {
      writeFileSync(join(tmpDir, "index.js"), "console.log('ok');\n");
      const ggufPath = join(tmpDir, "test-model.Q5_K_M.gguf");
      writeGgufFixture(ggufPath, [
        {
          key: "general.name",
          type: GGUF_METADATA_TYPES.STRING,
          value: "test-model",
        },
        {
          key: "general.alignment",
          type: GGUF_METADATA_TYPES.STRING,
          value: "64evil",
        },
      ]);

      const inventory = collectJsAiInventory(tmpDir, {});
      const ggufFile = inventory.components.find(
        (component) =>
          component.type === "file" && component.name === basename(ggufPath),
      );

      assert.ok(ggufFile);
      assert.strictEqual(getProp(ggufFile, "cdx:gguf:alignment"), undefined);
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("scans app.config.ts and skips tool configs of every module extension", () => {
    const tmpDir = createTempDir();
    try {
      // An Angular app registers its root providers in src/app/app.config.ts,
      // including configuration values such as an AI endpoint.
      mkdirSync(join(tmpDir, "src", "app"), { recursive: true });
      writeFileSync(
        join(tmpDir, "src", "app", "app.config.ts"),
        [
          "import { ApplicationConfig, InjectionToken } from '@angular/core';",
          "export const AI_API_URL = new InjectionToken<string>('AI_API_URL');",
          "export const appConfig: ApplicationConfig = {",
          "  providers: [{ provide: AI_API_URL, useValue: 'https://api.openai.com/v1' }],",
          "};",
        ].join("\n"),
      );
      // A test-runner config is tooling, whichever extension it has.
      writeFileSync(
        join(tmpDir, "vitest.config.mts"),
        [
          "import { defineConfig } from 'vitest/config';",
          "export default defineConfig({ test: { env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } } });",
        ].join("\n"),
      );

      const inventory = collectJsAiInventory(tmpDir, {});
      const serviceNames = inventory.services.map((service) => service.name);

      assert.deepStrictEqual(serviceNames, ["OpenAI API"]);
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
      "pkg:huggingface/HuggingFaceH4/ultrachat_200k?repository_url=https:%2F%2Fhuggingface.co%2Fdatasets",
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
      "pkg:huggingface/HuggingFaceH4/ultrachat_200k?repository_url=https:%2F%2Fhuggingface.co%2Fdatasets",
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
        "pkg:huggingface/team/dataset?repository_url=https:%2F%2Fhuggingface.co%2Fdatasets",
      );
      assert.strictEqual(
        dataset.externalReferences[0].url,
        "https://huggingface.co/datasets/team/dataset",
      );
      assert.strictEqual(
        dataset.purl,
        "pkg:huggingface/team/dataset?repository_url=https:%2F%2Fhuggingface.co%2Fdatasets",
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

  it("classifies provider-linked agent SDK imports into services", () => {
    const tmpDir = createTempDir();
    try {
      writeFileSync(
        join(tmpDir, "agent.py"),
        [
          "from claude_agent_sdk import query",
          "from smolagents import CodeAgent",
          'model = "claude-sonnet-4-5"',
        ].join("\n"),
      );
      const inventory = collectPythonAiInventory(tmpDir, {});
      const anthropicService = inventory.services.find(
        (service) => service.group === "anthropic",
      );
      assert.ok(
        anthropicService,
        "expected an Anthropic service from claude-agent-sdk import",
      );
      assert.ok(
        anthropicService.tags.includes("claude-agent-sdk"),
        "expected claude-agent-sdk framework tag on the Anthropic service",
      );
      const huggingFaceService = inventory.services.find(
        (service) => service.group === "huggingface",
      );
      assert.ok(
        huggingFaceService,
        "expected a Hugging Face service from smolagents import",
      );
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("attaches framework-only agent SDKs to co-located provider services", () => {
    const tmpDir = createTempDir();
    try {
      mkdirSync(join(tmpDir, "src"), { recursive: true });
      writeFileSync(
        join(tmpDir, "src", "graph.py"),
        [
          "import openai",
          "from pydantic_ai import Agent",
          "import langgraph",
          "import agno",
          "import dspy",
          'model = "gpt-4o"',
        ].join("\n"),
      );
      const inventory = collectPythonAiInventory(tmpDir, {});
      const openaiService = inventory.services.find(
        (service) => service.group === "openai",
      );
      assert.ok(openaiService, "expected an OpenAI service");
      for (const framework of ["pydantic-ai", "langgraph", "agno", "dspy"]) {
        assert.ok(
          openaiService.tags.includes(framework),
          `expected ${framework} framework tag on the OpenAI service`,
        );
      }
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("does not merge consecutive import statements into a single token", () => {
    const tmpDir = createTempDir();
    try {
      // Each import is on its own line; a greedy scanner could otherwise merge
      // them into one unmatchable token and miss every provider after the first.
      writeFileSync(
        join(tmpDir, "multi.py"),
        [
          "import openai",
          "import anthropic",
          "import cohere",
          'model = "gpt-4o"',
        ].join("\n"),
      );
      const inventory = collectPythonAiInventory(tmpDir, {});
      const groups = inventory.services.map((service) => service.group).sort();
      assert.ok(groups.includes("openai"), "expected OpenAI service");
      assert.ok(groups.includes("anthropic"), "expected Anthropic service");
      assert.ok(groups.includes("cohere"), "expected Cohere service");
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("detects newly supported inference-provider endpoints from source URLs", () => {
    const tmpDir = createTempDir();
    try {
      writeFileSync(
        join(tmpDir, "providers.py"),
        [
          'a = "https://api.x.ai/v1/chat/completions"',
          'b = "https://openrouter.ai/api/v1/chat/completions"',
          'c = "https://api.cerebras.ai/v1/chat/completions"',
          'd = "https://dashscope.aliyuncs.com/compatible-mode/v1"',
          'e = "https://integrate.api.nvidia.com/v1"',
          'f = "https://bedrock-runtime.us-east-1.amazonaws.com/model/x/invoke"',
        ].join("\n"),
      );
      const inventory = collectPythonAiInventory(tmpDir, {});
      const groups = inventory.services.map((service) => service.group).sort();
      for (const provider of [
        "xai",
        "openrouter",
        "cerebras",
        "dashscope",
        "nvidia-nim",
        "aws-bedrock",
      ]) {
        assert.ok(
          groups.includes(provider),
          `expected a ${provider} inference service`,
        );
      }
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("disambiguates local inference endpoints by port instead of guessing Ollama", () => {
    const tmpDir = createTempDir();
    try {
      writeFileSync(
        join(tmpDir, "local.py"),
        [
          'a = "http://localhost:1234/v1/chat/completions"',
          'b = "http://127.0.0.1:8000/v1/completions"',
          'c = "http://localhost:9999/v1/chat/completions"',
        ].join("\n"),
      );
      const inventory = collectPythonAiInventory(tmpDir, {});
      const groups = inventory.services.map((service) => service.group).sort();
      assert.ok(groups.includes("lm-studio"), "expected LM Studio on :1234");
      assert.ok(groups.includes("vllm"), "expected vLLM on :8000");
      assert.ok(
        groups.includes("local-inference"),
        "expected a generic local-inference label for the unknown port",
      );
      assert.ok(
        !groups.includes("ollama"),
        "must not guess Ollama for arbitrary local endpoints",
      );
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("inventories safetensors, onnx, and pickle model artifacts", () => {
    const tmpDir = createTempDir();
    try {
      // safetensors: 8-byte LE header length + JSON header + payload
      const header = {
        __metadata__: { quant_method: "awq" },
        "w.0": { dtype: "F16", shape: [2, 3], data_offsets: [0, 12] },
      };
      const headerJson = Buffer.from(JSON.stringify(header), "utf-8");
      const lengthBuffer = Buffer.alloc(8);
      lengthBuffer.writeBigUInt64LE(BigInt(headerJson.length));
      writeFileSync(
        join(tmpDir, "model.safetensors"),
        Buffer.concat([lengthBuffer, headerJson, Buffer.alloc(32)]),
      );
      writeFileSync(
        join(tmpDir, "graph.onnx"),
        Buffer.from("onnx-placeholder"),
      );
      // A real-looking pickle checkpoint: model-like name and above the size
      // floor so it is not mistaken for a shim.
      writeFileSync(join(tmpDir, "pytorch_model.bin"), Buffer.alloc(8192, 1));

      const inventory = collectJsAiInventory(tmpDir, {});
      const getComp = (fmt) =>
        inventory.components.find((component) =>
          component.properties?.some(
            (property) =>
              property.name === "cdx:ai:artifactFormat" &&
              property.value === fmt,
          ),
        );

      const safetensors = getComp("safetensors");
      assert.ok(safetensors, "expected a safetensors model component");
      assert.strictEqual(
        getProp(safetensors, "cdx:ai:quantizationMethod"),
        "awq",
      );

      assert.ok(getComp("onnx"), "expected an onnx model component");

      const pickle = getComp("pytorch-pickle");
      assert.ok(pickle, "expected a pytorch pickle model component");
      assert.strictEqual(
        getProp(pickle, "cdx:ai:unsafeDeserialization"),
        "true",
      );
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("does not treat .pth path-config files or venv shims as models", () => {
    const tmpDir = createTempDir();
    try {
      // A Python path-configuration file: must never be a model artifact.
      writeFileSync(
        join(tmpDir, "distutils-precedence.pth"),
        "import sys; sys.path...",
      );
      // A model-like .bin but inside site-packages: dependency payload, skip.
      const sitePackages = join(tmpDir, ".venv", "site-packages", "torch");
      mkdirSync(sitePackages, { recursive: true });
      writeFileSync(join(sitePackages, "model.bin"), Buffer.alloc(8192, 1));
      // A model-like .bin but tiny: a shim, not a checkpoint.
      writeFileSync(join(tmpDir, "model_stub.bin"), Buffer.from("tiny"));

      const inventory = collectJsAiInventory(tmpDir, {});
      const pickleComponents = inventory.components.filter((component) =>
        component.properties?.some(
          (property) =>
            property.name === "cdx:ai:artifactFormat" &&
            property.value === "pytorch-pickle",
        ),
      );
      assert.strictEqual(
        pickleComponents.length,
        0,
        "expected no pickle model components from .pth/venv/shim files",
      );
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("groups sharded safetensors into a single model component", () => {
    const tmpDir = createTempDir();
    try {
      const makeShard = (name) => {
        const header = {
          "w.0": { dtype: "F16", shape: [1024, 1024], data_offsets: [0, 2] },
        };
        const headerJson = Buffer.from(JSON.stringify(header), "utf-8");
        const lengthBuffer = Buffer.alloc(8);
        lengthBuffer.writeBigUInt64LE(BigInt(headerJson.length));
        writeFileSync(
          join(tmpDir, name),
          Buffer.concat([lengthBuffer, headerJson, Buffer.alloc(8)]),
        );
      };
      makeShard("model-00001-of-00003.safetensors");
      makeShard("model-00002-of-00003.safetensors");
      makeShard("model-00003-of-00003.safetensors");
      writeFileSync(
        join(tmpDir, "config.json"),
        JSON.stringify({ _name_or_path: "meta-llama/Llama-3-8B" }),
      );

      const inventory = collectJsAiInventory(tmpDir, {});
      const models = inventory.components.filter(
        (component) => component.type === "machine-learning-model",
      );
      assert.strictEqual(models.length, 1, "expected exactly one model");
      const model = models[0];
      assert.strictEqual(model.name, "Llama-3-8B");
      // Parameters summed across the three shards (3 * 1024 * 1024).
      assert.strictEqual(
        getProp(model, "cdx:ai:parameterCount"),
        String(3 * 1024 * 1024),
      );
      // The model depends on all three shard file components.
      const edge = inventory.dependencies.find(
        (dependency) => dependency.ref === model["bom-ref"],
      );
      assert.ok(edge, "expected a dependency edge from the model");
      assert.strictEqual(edge.dependsOn.length, 3);
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });
});
