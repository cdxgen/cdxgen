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
  const findModel = (inventory, modelId) =>
    inventory.components.find(
      (component) =>
        component.type === "machine-learning-model" &&
        (component.name === modelId ||
          `${component.group}/${component.name}` === modelId),
    );

  const META = { name: "Meta" };
  const OPENAI = { name: "OpenAI" };
  const ANTHROPIC = { name: "Anthropic" };
  const GOOGLE = { name: "Google" };
  const MISTRAL = { name: "Mistral AI" };

  it("reads import lines in time proportional to their size", () => {
    // Each of these took seconds when an import pattern was tried at every
    // position of a line or every blank of a run; now each takes milliseconds.
    const shapes = {
      "spaces-after-import": `import os${" ".repeat(160000)}x\n`,
      "import-then-spaces": `import${" ".repeat(160000)}\n`,
      "repeated-imports": `${"import a ".repeat(40000)}\n`,
      "blank-lines": `${"\n".repeat(160000)}from openai import OpenAI\n`,
    };
    for (const [shape, source] of Object.entries(shapes)) {
      const tmpDir = createTempDir();
      try {
        writeFileSync(join(tmpDir, "app.py"), source);
        writeFileSync(join(tmpDir, "app.js"), source);
        const start = process.hrtime.bigint();
        collectPythonAiInventory(tmpDir, {});
        collectJsAiInventory(tmpDir, {});
        const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
        assert.ok(elapsedMs < 5000, `${shape} took ${elapsedMs} ms`);
      } finally {
        rmSync(tmpDir, { force: true, recursive: true });
      }
    }
  });

  it("finds imports at the start of a line only", () => {
    const tmpDir = createTempDir();
    try {
      writeFileSync(
        join(tmpDir, "app.js"),
        [
          "  import   OpenAI   from 'openai';",
          "const note = \"import Anthropic from '@anthropic-ai/sdk'\";",
        ].join("\n"),
      );
      const inventory = collectJsAiInventory(tmpDir, {});
      const text = JSON.stringify(inventory);
      assert.ok(text.includes("openai"));
      assert.ok(!text.toLowerCase().includes("anthropic"));
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("records the model creator as manufacturer and never the hosting provider", () => {
    const cases = [
      ['import OpenAI from "openai";', "gpt-4o-mini", OPENAI],
      [
        'import Anthropic from "@anthropic-ai/sdk";',
        "claude-3-5-sonnet-20241022",
        ANTHROPIC,
      ],
      // A hosted catalogue keeps the creator the model id names; a local
      // runtime tag names nobody.
      ['import Groq from "groq-sdk";', "llama-3.1-70b-versatile", META],
      ['import Groq from "groq-sdk";', "mixtral-8x7b-32768", MISTRAL],
      ['import { Ollama } from "ollama";', "llama3.2", undefined],
    ];
    for (const [importLine, modelName, expectedManufacturer] of cases) {
      const tmpDir = createTempDir();
      try {
        writeFileSync(
          join(tmpDir, "index.js"),
          `${importLine}\nconst model = "${modelName}";\n`,
        );
        const model = findModel(collectJsAiInventory(tmpDir, {}), modelName);
        assert.ok(model, `expected a ${modelName} model component`);
        assert.deepStrictEqual(
          model.manufacturer,
          expectedManufacturer,
          modelName,
        );
        // Neither the SDK nor the host supplied a Hub artifact.
        assert.strictEqual(model.supplier, undefined, modelName);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  });

  it("credits a model creator only when the code agrees with the model name", () => {
    const cases = [
      [
        "mixed-imports",
        [
          "import openai",
          "import anthropic",
          "a = anthropic.Anthropic()",
          'a.messages.create(model="claude-3-5-sonnet-latest", messages=[])',
          "o = openai.OpenAI()",
          'o.chat.completions.create(model="gpt-4o", messages=[])',
        ],
        { "claude-3-5-sonnet-latest": ANTHROPIC, "gpt-4o": OPENAI },
      ],
      [
        "openai-compatible-env-base-url",
        [
          "import os",
          "from openai import OpenAI",
          'client = OpenAI(base_url=os.environ["LLM_BASE_URL"])',
          'client.chat.completions.create(model="meta-llama-3.1-8b-instruct", messages=[])',
          'client.chat.completions.create(model="deepseek-chat", messages=[])',
          'client.chat.completions.create(model="claude-3-5-sonnet-latest", messages=[])',
          'client.chat.completions.create(model="qwen2.5-72b-instruct", messages=[])',
          'client.chat.completions.create(model="openhermes-2.5-mistral-7b", messages=[])',
        ],
        {
          "meta-llama-3.1-8b-instruct": undefined,
          "deepseek-chat": undefined,
          "claude-3-5-sonnet-latest": undefined,
          "qwen2.5-72b-instruct": undefined,
          "openhermes-2.5-mistral-7b": undefined,
        },
      ],
      [
        "literal-ollama-base-url",
        [
          "from openai import OpenAI",
          'client = OpenAI(base_url="http://localhost:11434/v1", api_key="x")',
          'client.chat.completions.create(model="llama3.1:8b", messages=[])',
        ],
        { "llama3.1:8b": undefined },
      ],
      [
        "literal-vllm-base-url",
        [
          "from openai import OpenAI",
          'client = OpenAI(base_url="http://localhost:8000/v1")',
          'client.chat.completions.create(model="llama-3.1-8b-instruct")',
        ],
        { "llama-3.1-8b-instruct": undefined },
      ],
      [
        "literal-lm-studio-base-url",
        [
          "from openai import OpenAI",
          'client = OpenAI(base_url="http://localhost:1234/v1")',
          'client.chat.completions.create(model="mistral-7b-instruct-v0.3")',
        ],
        { "mistral-7b-instruct-v0.3": undefined },
      ],
      [
        "literal-together-base-url",
        [
          "from openai import OpenAI",
          'client = OpenAI(base_url="https://api.together.xyz/v1")',
          'client.chat.completions.create(model="mistral-large", messages=[])',
        ],
        { "mistral-large": MISTRAL },
      ],
      [
        "no-recognised-import",
        [
          'cfg = dict(model="openhermes-2.5-mistral-7b")',
          'cfg2 = dict(model="tinyllama-1.1b-chat")',
          'cfg3 = dict(model="claude-3-5-sonnet-latest")',
        ],
        {
          "openhermes-2.5-mistral-7b": undefined,
          "tinyllama-1.1b-chat": undefined,
          "claude-3-5-sonnet-latest": ANTHROPIC,
        },
      ],
      [
        "litellm-and-langchain-community",
        [
          "import litellm",
          "from langchain_community.llms import VLLM",
          'litellm.completion(model="dolphin-2.6-mistral-7b")',
        ],
        { "dolphin-2.6-mistral-7b": undefined },
      ],
      [
        "gpt-named-open-weight-families",
        [
          "from transformers import AutoModelForCausalLM",
          'a = AutoModelForCausalLM.from_pretrained("gpt-neox-20b")',
          'b = AutoModelForCausalLM.from_pretrained("gpt-j-6b")',
          'c = AutoModelForCausalLM.from_pretrained("gpt4all-j")',
          'd = AutoModelForCausalLM.from_pretrained("gpt2")',
          'e = dict(model="gpt-4o-mini")',
        ],
        {
          "gpt-neox-20b": undefined,
          "gpt-j-6b": undefined,
          "gpt4all-j": undefined,
          gpt2: OPENAI,
          "gpt-4o-mini": OPENAI,
        },
      ],
      [
        // A name no creator owns is credited only to an API that serves
        // nothing but its own models. An OpenAI embedding model called next
        // to the anthropic SDK is not Anthropic's.
        "single-catalogue-fallback",
        [
          "import anthropic",
          "import cohere",
          'a = dict(model="text-embedding-3-small")',
          'b = dict(model="internal-ranker-v2")',
        ],
        {
          "text-embedding-3-small": undefined,
          "internal-ranker-v2": { name: "Anthropic" },
        },
      ],
      [
        "dashscope-hosts-other-creators",
        [
          "import dashscope",
          'a = dict(model="baichuan2-7b-chat-v1")',
          'b = dict(model="qwen-max")',
        ],
        {
          "baichuan2-7b-chat-v1": undefined,
          "qwen-max": { name: "Alibaba Cloud" },
        },
      ],
      [
        "unambiguous-name-prefixes",
        [
          'a = dict(model="o4-mini")',
          'b = dict(model="gemma-2-9b-it")',
          'c = dict(model="codestral-latest")',
          'd = dict(model="command-r-plus")',
          'e = dict(model="grok-2")',
          'f = dict(model="qwen2.5-72b-instruct")',
          'g = dict(model="glm-4")',
        ],
        {
          "o4-mini": OPENAI,
          "gemma-2-9b-it": GOOGLE,
          "codestral-latest": MISTRAL,
          "command-r-plus": { name: "Cohere" },
          "grok-2": { name: "xAI" },
          "qwen2.5-72b-instruct": { name: "Alibaba Cloud" },
          "glm-4": { name: "Zhipu AI" },
        },
      ],
    ];
    for (const [label, lines, expectedManufacturers] of cases) {
      const tmpDir = createTempDir();
      try {
        writeFileSync(join(tmpDir, "app.py"), `${lines.join("\n")}\n`);
        const inventory = collectPythonAiInventory(tmpDir, {});
        for (const [modelName, expectedManufacturer] of Object.entries(
          expectedManufacturers,
        )) {
          const model = findModel(inventory, modelName);
          assert.ok(model, `${label}: expected a ${modelName} model component`);
          assert.deepStrictEqual(
            model.manufacturer,
            expectedManufacturer,
            `${label}: ${modelName}`,
          );
          assert.strictEqual(
            model.supplier,
            undefined,
            `${label}: ${modelName}`,
          );
        }
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  });

  it("does not treat Google API hosts other than Gemini as a creator", () => {
    const cases = [
      [
        'URL = "https://storage.googleapis.com/my-bucket/weights.bin"',
        "my-classifier",
        undefined,
        undefined,
      ],
      [
        'URL = "https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/l/endpoints/e:predict"',
        "my-classifier",
        "vertex-ai",
        undefined,
      ],
      [
        'URL = "https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/l/endpoints/e:predict"',
        "gemini-1.5-pro",
        "vertex-ai",
        GOOGLE,
      ],
    ];
    for (const [urlLine, modelName, expectedProvider, expected] of cases) {
      const tmpDir = createTempDir();
      try {
        writeFileSync(
          join(tmpDir, "app.py"),
          `${urlLine}\ncfg = dict(model="${modelName}")\n`,
        );
        const model = findModel(
          collectPythonAiInventory(tmpDir, {}),
          modelName,
        );
        assert.ok(model, `expected a ${modelName} model component`);
        assert.strictEqual(getProp(model, "cdx:ai:provider"), expectedProvider);
        assert.deepStrictEqual(model.manufacturer, expected, urlLine);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  });

  it("does not read litellm routes or Google resource names as Hub repositories", () => {
    const tmpDir = createTempDir();
    try {
      writeFileSync(
        join(tmpDir, "app.py"),
        [
          "import litellm",
          'litellm.completion(model="groq/llama3-8b-8192")',
          'litellm.completion(model="ollama/llama3")',
          'litellm.completion(model="bedrock/anthropic.claude-v2")',
          'litellm.completion(model="azure/my-deployment")',
          'litellm.completion(model="gemini/gemini-1.5-pro")',
          'a = dict(model="models/gemini-1.5-flash")',
          'b = dict(model_name="tunedModels/my-tuned")',
          'c = dict(model="projects/p/locations/us-central1/publishers/google/models/gemini-1.5-pro")',
          "",
        ].join("\n"),
      );
      const inventory = collectPythonAiInventory(tmpDir, {});
      const expected = {
        "groq/llama3-8b-8192": [META, "groq"],
        "ollama/llama3": [undefined, "ollama"],
        "bedrock/anthropic.claude-v2": [undefined, "aws-bedrock"],
        "azure/my-deployment": [undefined, "azure-openai"],
        "gemini/gemini-1.5-pro": [GOOGLE, "gemini"],
        "models/gemini-1.5-flash": [GOOGLE, "google"],
        "tunedModels/my-tuned": [undefined, undefined],
        "projects/p/locations/us-central1/publishers/google/models/gemini-1.5-pro":
          [GOOGLE, "google"],
      };
      for (const [modelId, [manufacturer, provider]] of Object.entries(
        expected,
      )) {
        const model = inventory.components.find(
          (component) =>
            component.type === "machine-learning-model" &&
            component.name === modelId,
        );
        assert.ok(model, `expected a ${modelId} model component`);
        assert.deepStrictEqual(model.manufacturer, manufacturer, modelId);
        assert.strictEqual(
          getProp(model, "cdx:ai:provider"),
          provider,
          modelId,
        );
        assert.strictEqual(model.supplier, undefined, modelId);
        assert.strictEqual(model.purl, undefined, modelId);
      }
      assert.ok(
        !inventory.components.some((component) =>
          component.purl?.startsWith("pkg:huggingface/"),
        ),
        "no route or resource name becomes a Hugging Face purl",
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("credits a Hub namespace as manufacturer only when it is the creator's own organisation", () => {
    const tmpDir = createTempDir();
    try {
      writeFileSync(
        join(tmpDir, "app.py"),
        [
          "from transformers import AutoModelForCausalLM",
          'a = AutoModelForCausalLM.from_pretrained("meta-llama/Llama-3.1-8B")',
          'b = AutoModelForCausalLM.from_pretrained("mistralai/Mistral-7B-v0.1")',
          'c = AutoModelForCausalLM.from_pretrained("Qwen/Qwen2.5-7B-Instruct")',
          'd = AutoModelForCausalLM.from_pretrained("TheBloke/Llama-2-7B-Chat-GGUF")',
          'e = AutoModelForCausalLM.from_pretrained("unsloth/Meta-Llama-3.1-8B-bnb-4bit")',
          'f = AutoModelForCausalLM.from_pretrained("mlx-community/Mistral-7B-Instruct-v0.3-4bit")',
          "",
        ].join("\n"),
      );
      const inventory = collectPythonAiInventory(tmpDir, {});
      const expected = {
        "meta-llama/Llama-3.1-8B": META,
        "mistralai/Mistral-7B-v0.1": MISTRAL,
        "Qwen/Qwen2.5-7B-Instruct": { name: "Alibaba Cloud" },
        // Re-packagers supply the artifact but did not create the model.
        "TheBloke/Llama-2-7B-Chat-GGUF": undefined,
        "unsloth/Meta-Llama-3.1-8B-bnb-4bit": undefined,
        "mlx-community/Mistral-7B-Instruct-v0.3-4bit": undefined,
      };
      for (const [repoId, manufacturer] of Object.entries(expected)) {
        const model = findModel(inventory, repoId);
        assert.ok(model, `expected a ${repoId} model component`);
        assert.deepStrictEqual(model.manufacturer, manufacturer, repoId);
        assert.strictEqual(model.supplier?.name, repoId.split("/")[0], repoId);
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("fills a missing manufacturer from a later file that names the creator", () => {
    for (const [openaiOnlyFile, bothSdksFile] of [
      ["a.py", "b.py"],
      ["b.py", "a.py"],
    ]) {
      const tmpDir = createTempDir();
      try {
        writeFileSync(
          join(tmpDir, openaiOnlyFile),
          'import openai\nx = dict(model="claude-3-5-sonnet-latest")\n',
        );
        writeFileSync(
          join(tmpDir, bothSdksFile),
          'import openai\nimport anthropic\nx = dict(model="claude-3-5-sonnet-latest")\n',
        );
        const model = findModel(
          collectPythonAiInventory(tmpDir, {}),
          "claude-3-5-sonnet-latest",
        );
        assert.ok(model, "expected the claude model component");
        assert.deepStrictEqual(
          model.manufacturer,
          ANTHROPIC,
          `openai-only file ${openaiOnlyFile}`,
        );
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  });

  it("records the creator a GGUF file declares as the model manufacturer", () => {
    const inventory = collectJsAiInventory("./test/data/gguf-ai-repotest", {});
    const model = inventory.components.find(
      (component) =>
        component.type === "machine-learning-model" &&
        component.name === "Mixtral-8x7B-Instruct",
    );
    assert.ok(model, "expected the GGUF fixture model component");
    // general.organization is mistralai, written with the full name.
    assert.deepStrictEqual(model.manufacturer, MISTRAL);
    assert.strictEqual(model.supplier, undefined);
  });

  it("trims a declared GGUF creator, keeps an unknown one and drops an oversized one", () => {
    const cases = [
      ["  mistralai  ", MISTRAL],
      ["Meta Llama", META],
      ["Example Labs", { name: "Example Labs" }],
      ["x".repeat(129), undefined],
    ];
    for (const [organization, expectedManufacturer] of cases) {
      const tmpDir = createTempDir();
      try {
        writeGgufFixture(join(tmpDir, "tiny-model-Q4_0.gguf"), [
          {
            key: "general.name",
            type: GGUF_METADATA_TYPES.STRING,
            value: "tiny-model",
          },
          {
            key: "general.organization",
            type: GGUF_METADATA_TYPES.STRING,
            value: organization,
          },
        ]);
        const inventory = collectJsAiInventory(tmpDir, {});
        const model = inventory.components.find(
          (component) =>
            component.type === "machine-learning-model" &&
            component.name === "tiny-model",
        );
        assert.ok(model, "expected the GGUF model component");
        assert.deepStrictEqual(model.manufacturer, expectedManufacturer);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  });

  it("leaves the Hub url off the supplier of a model routed through another provider", () => {
    const tmpDir = createTempDir();
    try {
      writeFileSync(
        join(tmpDir, "index.js"),
        'import Together from "together-ai";\nconst model = "meta-llama/Llama-3-70b";\n',
      );
      const inventory = collectJsAiInventory(tmpDir, {});
      const model = inventory.components.find(
        (component) =>
          component.type === "machine-learning-model" &&
          component.group === "meta-llama" &&
          getProp(component, "cdx:ai:provider") === "together",
      );
      assert.ok(model, "expected the routed model component");
      assert.deepStrictEqual(model.supplier, { name: "meta-llama" });
      assert.deepStrictEqual(model.manufacturer, META);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

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
    assert.deepStrictEqual(
      model.supplier,
      { name: "HuggingFaceH4", url: ["https://huggingface.co/HuggingFaceH4"] },
      "the scanned model carries its namespace as the supplier",
    );
    assert.deepStrictEqual(
      dataset.supplier,
      { name: "HuggingFaceH4", url: ["https://huggingface.co/HuggingFaceH4"] },
      "the dataset carries its namespace as the supplier",
    );
    // HuggingFaceH4 is the Hugging Face team, not a model creator in the
    // creator table, so the namespace supplies the model without being its
    // manufacturer.
    assert.strictEqual(model.manufacturer, undefined);
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

  it("does not invent a model from prose around an inline model label", () => {
    const tmpDir = createTempDir();
    try {
      mkdirSync(join(tmpDir, "agents"), { recursive: true });
      // The aws-samples/sample-kiro-cli-multiagent-development prose that made
      // master record a machine-learning-model named "field. Run". The quoted
      // frontmatter id in the same file must still be found.
      writeFileSync(
        join(tmpDir, "agents", "technical-lead.md"),
        [
          "---",
          "description: Technical lead agent",
          "model: claude-opus-4.8",
          "---",
          "",
          "> **Model portability note**: `claude-opus-4.8` reflects the author's environment. Substitute a model",
          "> available to you by editing the `model:` field. Run `kiro-cli chat --list-models` for what your",
          "> account offers.",
          "",
          "Set `model:` like owner/repo, or use `https://huggingface.co/meta-llama/Llama-3-8B`.",
          "",
        ].join("\n"),
      );

      const inventory = collectPromptConfigAiInventory(tmpDir, {});
      const modelNames = inventory.components
        .filter((component) => component.type === "machine-learning-model")
        .map((component) => component.name);

      assert.ok(
        modelNames.includes("claude-opus-4.8"),
        `expected the frontmatter model, got ${modelNames.join(", ")}`,
      );
      assert.ok(
        modelNames.every((name) => !name.includes(" ")),
        `expected no whitespace-bearing model name, got ${modelNames.join(", ")}`,
      );
      assert.ok(
        !inventory.components.some(
          (component) => component.name === "field. Run",
        ),
        "the prose after the inline `model:` label must not become a model",
      );
      assert.ok(
        modelNames.includes("Llama-3-8B") ||
          inventory.components.some(
            (component) =>
              component.type === "machine-learning-model" &&
              `${component.group}/${component.name}` ===
                "meta-llama/Llama-3-8B",
          ),
        "expected the Hugging Face URL reference to survive",
      );
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("keeps scoped model ids such as Cloudflare Workers AI models", () => {
    const tmpDir = createTempDir();
    try {
      mkdirSync(join(tmpDir, "prompts"), { recursive: true });
      writeFileSync(
        join(tmpDir, "prompts", "routing.yaml"),
        'model: "@cf/meta/llama-3.1-8b-instruct"\n',
      );
      const inventory = collectPromptConfigAiInventory(tmpDir, {});
      const modelNames = inventory.components
        .filter((component) => component.type === "machine-learning-model")
        .map((component) => `${component.group || ""}/${component.name}`);
      assert.ok(
        modelNames.some((name) => name.includes("llama-3.1-8b-instruct")),
        `expected the scoped model id, got ${modelNames.join(", ")}`,
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
