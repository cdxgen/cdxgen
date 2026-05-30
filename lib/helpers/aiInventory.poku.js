import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { basename, join } from "node:path";

import { assert, describe, it } from "poku";

import {
  collectAiInventory,
  filterInventoryDependencies,
  inventoryTypesForSubject,
  matchesAiInventoryExcludeType,
  matchesAiInventoryType,
  summarizeAiInventory,
} from "./aiInventory.js";

const GGUF_METADATA_TYPES = {
  STRING: 8,
  UINT32: 4,
  UINT64: 10,
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
    const buffer = Buffer.from(value, "utf-8");
    pushU64(buffer.length);
    chunks.push(buffer);
  };
  const pushMetadataValue = (entry) => {
    switch (entry.type) {
      case GGUF_METADATA_TYPES.STRING:
        pushString(entry.value);
        return;
      case GGUF_METADATA_TYPES.UINT32:
        pushU32(entry.value);
        return;
      case GGUF_METADATA_TYPES.UINT64:
        pushU64(entry.value);
        return;
      default:
        throw new Error(`Unsupported GGUF test metadata type ${entry.type}`);
    }
  };
  chunks.push(Buffer.from("GGUF"));
  pushU32(3);
  pushU64(0);
  pushU64(metadataEntries.length);
  for (const entry of metadataEntries) {
    pushString(entry.key);
    pushU32(entry.type);
    pushMetadataValue(entry);
  }
  writeFileSync(filePath, Buffer.concat(chunks));
};

describe("aiInventory", () => {
  it("classifies agent-derived MCP services as both mcp and ai-skill", () => {
    const service = {
      "bom-ref": "urn:service:agent-mcp:demo:1",
      group: "mcp",
      properties: [
        { name: "cdx:mcp:inventorySource", value: "agent-file" },
        { name: "cdx:mcp:serviceType", value: "inferred-endpoint" },
      ],
    };
    assert.deepStrictEqual(inventoryTypesForSubject(service).sort(), [
      "ai-skill",
      "mcp",
    ]);
    assert.strictEqual(matchesAiInventoryType(service, "mcp"), true);
    assert.strictEqual(matchesAiInventoryType(service, "ai-skill"), true);
  });

  it("classifies cdx:ai properties as AI inventory subjects", () => {
    const model = {
      "bom-ref": "urn:cdx:ai:model:openai:gpt-4o-mini",
      properties: [
        { name: "cdx:ai:provider", value: "openai" },
        { name: "cdx:ai:source", value: "source-code-analysis" },
      ],
      type: "machine-learning-model",
    };
    assert.deepStrictEqual(inventoryTypesForSubject(model), ["ai"]);
    assert.strictEqual(matchesAiInventoryType(model, "ai"), true);
  });

  it("limits MCP exclusion matching to AI inventory services, files, and primitives", () => {
    const mcpPackage = {
      "bom-ref": "pkg:npm/@modelcontextprotocol/server-filesystem@1.0.0",
      name: "@modelcontextprotocol/server-filesystem",
      purl: "pkg:npm/%40modelcontextprotocol/server-filesystem@1.0.0",
    };
    const mcpPrimitive = {
      "bom-ref": "urn:mcp:tool:docs:search",
      properties: [{ name: "cdx:mcp:role", value: "tool" }],
      tags: ["mcp", "mcp-tool"],
    };
    const mcpConfig = {
      "bom-ref": "file:/repo/.vscode/mcp.json",
      properties: [{ name: "cdx:file:kind", value: "mcp-config" }],
      type: "file",
    };
    const mcpService = {
      "bom-ref": "urn:service:mcp:docs:latest",
      group: "mcp",
      properties: [{ name: "cdx:mcp:inventorySource", value: "config-file" }],
    };
    assert.strictEqual(matchesAiInventoryExcludeType(mcpPackage, "mcp"), false);
    assert.strictEqual(
      matchesAiInventoryExcludeType(mcpPrimitive, "mcp"),
      true,
    );
    assert.strictEqual(matchesAiInventoryExcludeType(mcpConfig, "mcp"), true);
    assert.strictEqual(matchesAiInventoryExcludeType(mcpService, "mcp"), true);
  });

  it("filters dependencies to retained component and service refs", () => {
    const components = [{ "bom-ref": "file:/repo/CLAUDE.md" }];
    const services = [{ "bom-ref": "urn:service:mcp:docs:latest" }];
    const filtered = filterInventoryDependencies(
      [
        {
          ref: "urn:service:mcp:docs:latest",
          provides: ["file:/repo/CLAUDE.md", "urn:service:mcp:other:latest"],
        },
        {
          ref: "urn:service:mcp:missing:latest",
          provides: ["file:/repo/CLAUDE.md"],
        },
      ],
      components,
      services,
    );
    assert.deepStrictEqual(filtered, [
      {
        ref: "urn:service:mcp:docs:latest",
        provides: ["file:/repo/CLAUDE.md"],
      },
    ]);
  });

  it("summarizes AI inventory counts for instructions, skills, configs, and services", () => {
    const summary = summarizeAiInventory({
      components: [
        {
          properties: [{ name: "cdx:file:kind", value: "agent-instructions" }],
        },
        {
          properties: [
            { name: "cdx:file:kind", value: "copilot-instructions" },
          ],
        },
        {
          properties: [{ name: "cdx:file:kind", value: "skill-file" }],
        },
        {
          properties: [{ name: "cdx:file:kind", value: "mcp-config" }],
        },
      ],
      services: [
        { group: "mcp", name: "releaseDocs" },
        { group: "mcp", name: "deployBot" },
      ],
    });
    assert.deepStrictEqual(summary, {
      aiComponentCount: 0,
      aiServiceCount: 0,
      instructionCount: 2,
      mcpConfigCount: 1,
      mcpServiceCount: 2,
      skillCount: 1,
    });
  });

  it("merges AI collectors and filters retained AI relationships", () => {
    const tmpDir = mkdtempSync(join(os.tmpdir(), "cdxgen-ai-inventory-"));
    try {
      writeFileSync(
        join(tmpDir, "agent.py"),
        ["from openai import OpenAI", 'model = "gpt-4o-mini"'].join("\n"),
      );
      writeFileSync(
        join(tmpDir, "assistant.ipynb"),
        JSON.stringify({
          cells: [
            {
              cell_type: "code",
              source: ["import anthropic\n", 'model = "claude-3-5-sonnet"\n'],
            },
          ],
        }),
      );
      writeFileSync(
        join(tmpDir, "system-prompt.yaml"),
        "model: gpt-4.1-mini\nendpoint: https://api.openai.com/v1/responses\n",
      );

      const inventory = collectAiInventory(tmpDir, {}, ["ai"]);

      assert.ok(
        inventory.components.some(
          (component) => component.name === "gpt-4o-mini",
        ),
      );
      assert.ok(
        inventory.components.some((component) =>
          component.properties?.some(
            (property) =>
              property.name === "cdx:file:kind" &&
              property.value === "prompt-config-file",
          ),
        ),
      );
      assert.ok(
        inventory.dependencies.every((dependency) => {
          const refs = new Set(
            inventory.components
              .concat(inventory.services)
              .map((subject) => subject["bom-ref"]),
          );
          return (
            refs.has(dependency.ref) &&
            (dependency.dependsOn || []).every((ref) => refs.has(ref))
          );
        }),
      );
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("uses Hugging Face purls for discovered model repository references", () => {
    const tmpDir = mkdtempSync(join(os.tmpdir(), "cdxgen-ai-hf-inventory-"));
    try {
      writeFileSync(
        join(tmpDir, "Modelfile"),
        "FROM microsoft/deberta-v3-base\n",
      );

      const inventory = collectAiInventory(tmpDir, {}, ["ai"]);
      const model = inventory.components.find(
        (component) =>
          component.type === "machine-learning-model" &&
          component.purl === "pkg:huggingface/microsoft/deberta-v3-base",
      );

      assert.ok(model, "expected Hugging Face model component");
      assert.strictEqual(model.group, "microsoft");
      assert.strictEqual(model.name, "deberta-v3-base");
      assert.strictEqual(
        model.purl,
        "pkg:huggingface/microsoft/deberta-v3-base",
      );
      assert.strictEqual(model["bom-ref"], model.purl);
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("collects exact AI inventory from a direct Modelfile path", () => {
    const tmpDir = mkdtempSync(join(os.tmpdir(), "cdxgen-ai-direct-model-"));
    const modelFile = join(tmpDir, "Modelfile");
    try {
      writeFileSync(
        modelFile,
        [
          "FROM deepseek-ai/DeepSeek-R1-Distill-Qwen-7B",
          "PARAMETER num_ctx 32768",
        ].join("\n"),
      );

      const inventory = collectAiInventory(modelFile, {}, ["ai"]);
      assert.ok(
        inventory.components.some(
          (component) =>
            component.type === "machine-learning-model" &&
            component.purl ===
              "pkg:huggingface/deepseek-ai/DeepSeek-R1-Distill-Qwen-7B",
        ),
      );
      assert.ok(
        inventory.components.some(
          (component) =>
            component.type === "file" && component.name === "Modelfile",
        ),
      );
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("collects exact AI inventory from a direct GGUF path", () => {
    const tmpDir = mkdtempSync(join(os.tmpdir(), "cdxgen-ai-direct-gguf-"));
    const modelFile = join(
      tmpDir,
      "Mixtral-8x7B-Instruct-v0.1-Q5_K_M-00001-of-00002.gguf",
    );
    try {
      writeGgufFixture(modelFile, [
        {
          key: "general.name",
          type: GGUF_METADATA_TYPES.STRING,
          value: "Mixtral-8x7B-Instruct",
        },
        {
          key: "general.architecture",
          type: GGUF_METADATA_TYPES.STRING,
          value: "llama",
        },
        {
          key: "general.version",
          type: GGUF_METADATA_TYPES.STRING,
          value: "v0.1",
        },
        {
          key: "tokenizer.ggml.model",
          type: GGUF_METADATA_TYPES.STRING,
          value: "llama",
        },
        {
          key: "tokenizer.chat_template",
          type: GGUF_METADATA_TYPES.STRING,
          value:
            "{% for message in messages %}{{ message['content'] }}{% endfor %}",
        },
        {
          key: "general.file_type",
          type: GGUF_METADATA_TYPES.UINT32,
          value: 17,
        },
        {
          key: "llama.context_length",
          type: GGUF_METADATA_TYPES.UINT64,
          value: 32768,
        },
      ]);

      const inventory = collectAiInventory(modelFile, {}, ["ai"]);
      const ggufModel = inventory.components.find(
        (component) =>
          component.type === "machine-learning-model" &&
          component.name === "Mixtral-8x7B-Instruct",
      );
      const ggufArtifact = inventory.components.find(
        (component) =>
          component.type === "file" && component.name === basename(modelFile),
      );

      assert.ok(
        ggufModel,
        "expected GGUF model component from direct file input",
      );
      assert.ok(
        ggufArtifact,
        "expected GGUF file component from direct file input",
      );
      assert.ok(
        ggufModel.properties.some(
          (property) =>
            property.name === "cdx:ai:quantization" &&
            property.value === "Q5_K_M",
        ),
      );
      assert.strictEqual(
        ggufModel.modelCard.modelParameters.inputs[0].format,
        "text",
      );
      assert.strictEqual(
        ggufModel.modelCard.modelParameters.outputs[0].format,
        "text",
      );
      assert.ok(
        ggufArtifact.properties.some(
          (property) =>
            property.name === "cdx:gguf:shard" &&
            property.value === "00001-of-00002",
        ),
      );
      assert.ok(
        inventory.dependencies.some(
          (dependency) =>
            dependency.ref === ggufArtifact["bom-ref"] &&
            dependency.dependsOn?.includes(ggufModel["bom-ref"]),
        ),
      );
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });
});
