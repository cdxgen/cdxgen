import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { basename, join } from "node:path";

import { assert, describe, it } from "poku";

import {
  collectAiInventory,
  filterInventoryDependencies,
  inventoryPropertyValue,
  inventoryTypesForSubject,
  matchesAiInventoryExcludeType,
  matchesAiInventoryType,
  summarizeAiInventory,
} from "./aiInventory.js";
import { enrichComponentWithMcpMetadata } from "./mcp.js";

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
    // Enrich the package through the real pipeline so it carries the cdx:mcp:*
    // properties (including cdx:mcp:role) that previously caused over-exclusion.
    const mcpPackage = enrichComponentWithMcpMetadata({
      "bom-ref": "pkg:npm/@modelcontextprotocol/server-filesystem@1.0.0",
      name: "@modelcontextprotocol/server-filesystem",
      purl: "pkg:npm/%40modelcontextprotocol/server-filesystem@1.0.0",
      type: "library",
    });
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
    // The enriched SDK package is classified as mcp by inclusion, yet exclusion
    // must retain it (real supply-chain component).
    assert.strictEqual(matchesAiInventoryType(mcpPackage, "mcp"), true);
    assert.strictEqual(matchesAiInventoryExcludeType(mcpPackage, "mcp"), false);
    assert.strictEqual(
      matchesAiInventoryExcludeType(mcpPrimitive, "mcp"),
      true,
    );
    assert.strictEqual(matchesAiInventoryExcludeType(mcpConfig, "mcp"), true);
    assert.strictEqual(matchesAiInventoryExcludeType(mcpService, "mcp"), true);
  });

  it("classifies mcp-config files as mcp so include/exclude stay symmetric", () => {
    // The core of fix #1: inclusion now owns the mcp-config file kind, so
    // --type mcp and --exclude-type mcp agree on the whole overlay.
    const mcpConfig = {
      "bom-ref": "file:/repo/.vscode/mcp.json",
      properties: [{ name: "cdx:file:kind", value: "mcp-config" }],
      type: "file",
    };
    assert.deepStrictEqual(inventoryTypesForSubject(mcpConfig), ["mcp"]);
    assert.strictEqual(matchesAiInventoryType(mcpConfig, "mcp"), true);
    assert.strictEqual(matchesAiInventoryExcludeType(mcpConfig, "mcp"), true);
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

// Genuine MCP SDK dependency packages across every supported ecosystem. After
// enrichment they carry cdx:mcp:package=true and are classified as mcp by
// inclusion, yet --exclude-type mcp must retain them (real components).
const MCP_SDK_PACKAGE_PURLS = [
  "pkg:npm/%40modelcontextprotocol/server-filesystem@1.0.0", // official npm
  "pkg:pypi/mcp@1.2.0", // official pypi
  "pkg:cargo/rmcp@0.1.0", // official cargo
  "pkg:maven/io.modelcontextprotocol.sdk/mcp@0.9.0", // official maven
  "pkg:nuget/ModelContextProtocol@0.3.0", // official nuget
  "pkg:golang/github.com/modelcontextprotocol/go-sdk@v0.2.0", // official golang
  "pkg:npm/%40acme/mcp-server@1.0.0", // non-official heuristic match
  "pkg:maven/org.springframework.ai/spring-ai-mcp@1.0.0", // known integration
];

// Inventory-overlay subjects that --exclude-type mcp must drop. Each is also
// expected to be classified as mcp by inclusion (include/exclude symmetry).
const MCP_OVERLAY_SUBJECTS = [
  {
    label: "primitive tool",
    subject: {
      "bom-ref": "urn:mcp:tool:docs:search",
      properties: [
        { name: "cdx:mcp:role", value: "tool" },
        { name: "cdx:mcp:serviceRef", value: "urn:service:mcp:docs:latest" },
      ],
      tags: ["mcp", "mcp-tool"],
      type: "application",
    },
  },
  {
    label: "primitive resource",
    subject: {
      "bom-ref": "urn:mcp:resource:docs:readme",
      properties: [
        { name: "cdx:mcp:role", value: "resource" },
        { name: "cdx:mcp:serviceRef", value: "urn:service:mcp:docs:latest" },
      ],
      tags: ["mcp", "mcp-resource"],
      type: "application",
    },
  },
  {
    label: "primitive prompt",
    subject: {
      "bom-ref": "urn:mcp:prompt:docs:summarize",
      properties: [
        { name: "cdx:mcp:role", value: "prompt" },
        { name: "cdx:mcp:serviceRef", value: "urn:service:mcp:docs:latest" },
      ],
      tags: ["mcp", "mcp-prompt"],
      type: "application",
    },
  },
  {
    label: "mcp-config file component",
    subject: {
      "bom-ref": "file:/repo/.vscode/mcp.json",
      properties: [{ name: "cdx:file:kind", value: "mcp-config" }],
      type: "file",
    },
  },
  {
    label: "configured server service",
    subject: {
      "bom-ref": "urn:service:mcp:docs:latest",
      group: "mcp",
      properties: [{ name: "cdx:mcp:inventorySource", value: "config-file" }],
    },
  },
  {
    label: "source-code discovered service",
    subject: {
      "bom-ref": "urn:service:mcp:api:latest",
      properties: [
        { name: "cdx:mcp:inventorySource", value: "source-code-analysis" },
      ],
    },
  },
  {
    label: "agent-file inferred endpoint",
    subject: {
      "bom-ref": "urn:service:mcp:agent:latest",
      group: "mcp",
      properties: [{ name: "cdx:mcp:inventorySource", value: "agent-file" }],
    },
  },
];

describe("matchesAiInventoryExcludeType — mcp", () => {
  for (const purl of MCP_SDK_PACKAGE_PURLS) {
    it(`retains enriched SDK package ${purl}`, () => {
      const pkg = enrichComponentWithMcpMetadata({
        "bom-ref": purl,
        purl,
        type: "library",
      });
      // Enrichment stamps the discriminating property the fix relies on.
      assert.strictEqual(
        inventoryPropertyValue(pkg, "cdx:mcp:package"),
        "true",
      );
      // Inclusion still counts it as mcp, yet exclusion keeps it.
      assert.strictEqual(matchesAiInventoryType(pkg, "mcp"), true);
      assert.strictEqual(matchesAiInventoryExcludeType(pkg, "mcp"), false);
    });
  }

  for (const { label, subject } of MCP_OVERLAY_SUBJECTS) {
    it(`excludes overlay: ${label}`, () => {
      // No overlay subject should ever carry the package marker.
      assert.strictEqual(
        inventoryPropertyValue(subject, "cdx:mcp:package"),
        undefined,
      );
      assert.strictEqual(matchesAiInventoryExcludeType(subject, "mcp"), true);
    });
  }

  it("retains a plain non-MCP package", () => {
    const pkg = enrichComponentWithMcpMetadata({
      "bom-ref": "pkg:npm/react@19.2.6",
      name: "react",
      purl: "pkg:npm/react@19.2.6",
      type: "library",
    });
    assert.strictEqual(matchesAiInventoryType(pkg, "mcp"), false);
    assert.strictEqual(matchesAiInventoryExcludeType(pkg, "mcp"), false);
  });

  it("keeps inclusion and exclusion symmetric for every overlay subject", () => {
    // With fix #1 the exclusion predicate is exactly the inclusion predicate
    // (minus the SDK-package escape hatch), so no special-casing can drift.
    for (const { label, subject } of MCP_OVERLAY_SUBJECTS) {
      assert.strictEqual(
        matchesAiInventoryType(subject, "mcp"),
        true,
        `${label} should be classified as mcp by inclusion`,
      );
      assert.strictEqual(
        matchesAiInventoryExcludeType(subject, "mcp"),
        true,
        `${label} should be excluded by --exclude-type mcp`,
      );
    }
  });

  it("excludes overlay recognized only by an mcp tag (no drift from inclusion)", () => {
    const subject = { "bom-ref": "urn:mcp:server:novel", tags: ["mcp-server"] };
    assert.strictEqual(matchesAiInventoryType(subject, "mcp"), true);
    assert.strictEqual(matchesAiInventoryExcludeType(subject, "mcp"), true);
  });

  it("excludes overlay recognized only by a novel cdx:mcp:* property", () => {
    const subject = {
      "bom-ref": "urn:mcp:endpoint:novel",
      properties: [{ name: "cdx:mcp:endpoint", value: "https://example" }],
    };
    assert.strictEqual(matchesAiInventoryType(subject, "mcp"), true);
    assert.strictEqual(matchesAiInventoryExcludeType(subject, "mcp"), true);
  });

  it("delegates non-mcp exclude types to the inclusion predicate", () => {
    const aiModel = {
      "bom-ref": "urn:cdx:ai:model:openai:gpt-4o-mini",
      properties: [{ name: "cdx:ai:provider", value: "openai" }],
      type: "machine-learning-model",
    };
    const skillFile = {
      "bom-ref": "file:/repo/.claude/skills/demo/SKILL.md",
      properties: [{ name: "cdx:file:kind", value: "skill-file" }],
      type: "file",
    };
    assert.strictEqual(matchesAiInventoryExcludeType(aiModel, "ai"), true);
    assert.strictEqual(
      matchesAiInventoryExcludeType(skillFile, "ai-skill"),
      true,
    );
    // An MCP SDK package is untouched by ai / ai-skill exclusion.
    const pkg = enrichComponentWithMcpMetadata({
      "bom-ref": "pkg:pypi/mcp@1.2.0",
      purl: "pkg:pypi/mcp@1.2.0",
      type: "library",
    });
    assert.strictEqual(matchesAiInventoryExcludeType(pkg, "ai"), false);
    assert.strictEqual(matchesAiInventoryExcludeType(pkg, "ai-skill"), false);
  });

  it("keeps Kiro V3 artifacts in the -t ai inventory", () => {
    const tmpDir = mkdtempSync(join(os.tmpdir(), "cdxgen-ai-kiro-"));
    try {
      mkdirSync(join(tmpDir, ".kiro", "steering"), { recursive: true });
      mkdirSync(join(tmpDir, ".kiro", "agents"), { recursive: true });
      mkdirSync(join(tmpDir, ".kiro", "settings"), { recursive: true });
      writeFileSync(
        join(tmpDir, ".kiro", "steering", "product.md"),
        "# Product\nBuild a safe deploy pipeline for the service.\n",
      );
      writeFileSync(
        join(tmpDir, ".kiro", "agents", "reviewer.json"),
        JSON.stringify({
          name: "reviewer",
          model: "claude-sonnet-4.5",
          tools: ["fs_read", "shell"],
          permissions: {
            rules: [{ capability: "all", effect: "allow" }],
          },
          kiroUpgrade: { revision: 2 },
        }),
      );
      writeFileSync(
        join(tmpDir, ".kiro", "settings", "permissions.yaml"),
        ["rules:", "- capability: shell", "  effect: allow"].join("\n"),
      );

      const inventory = collectAiInventory(tmpDir, {}, ["ai"]);
      const kinds = (kind) =>
        inventory.components.filter(
          (component) =>
            inventoryPropertyValue(component, "cdx:file:kind") === kind,
        );

      assert.strictEqual(kinds("agent-instructions").length, 1);
      assert.strictEqual(kinds("agent-definition").length, 1);
      assert.strictEqual(kinds("permission-policy").length, 1);
      const agent = kinds("agent-definition")[0];
      assert.strictEqual(
        inventoryPropertyValue(agent, "cdx:agent:permissionAllowsAll"),
        "true",
      );
      assert.strictEqual(
        inventoryPropertyValue(agent, "cdx:agent:upgradeRevision"),
        "2",
      );
      // An explicit ai-skill exclusion keeps the overlay out of an AI scan.
      const excluded = collectAiInventory(tmpDir, { excludeType: "ai-skill" }, [
        "ai",
      ]);
      assert.strictEqual(
        excluded.components.filter(
          (component) =>
            inventoryPropertyValue(component, "cdx:agent:framework") === "kiro",
        ).length,
        0,
      );
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("does not let the -t ai overlay widen other parsers' output", () => {
    const tmpDir = mkdtempSync(join(os.tmpdir(), "cdxgen-ai-overlay-"));
    try {
      writeFileSync(
        join(tmpDir, "CLAUDE.md"),
        "# Project rules\n\nRun the tests before committing.\n",
      );
      mkdirSync(join(tmpDir, ".kiro", "steering"), { recursive: true });
      writeFileSync(
        join(tmpDir, ".kiro", "steering", "product.md"),
        "# Product\nBuild a safe deploy pipeline for the service.\n",
      );
      // The agent-formulation parser runs for mcp and owns CLAUDE.md, which
      // classifies as ai-skill. Requesting ai and mcp must not keep it, while
      // the community overlay still contributes the steering document.
      const inventory = collectAiInventory(tmpDir, {}, ["ai", "mcp"]);
      const names = inventory.components.map((component) => component.name);
      assert.ok(!names.includes("CLAUDE.md"), names.join(", "));
      assert.ok(names.includes("Product"), names.join(", "));
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });
});
