import process from "node:process";

import esmock from "esmock";
import { assert, describe, it } from "poku";
import sinon from "sinon";

import { quantizationValueFromConfig } from "../huggingfaceUtils.js";
import {
  normalizeHuggingFaceReference,
  toHuggingFacePurl,
} from "./huggingface.js";

const HUGGING_FACE_TOKEN_ENV_KEYS = [
  "HF_TOKEN",
  "HUGGING_FACE_HUB_TOKEN",
  "HUGGINGFACE_TOKEN",
];

const withClearedHuggingFaceTokenEnv = async (callback) => {
  const previousEnv = new Map();
  for (const envKey of HUGGING_FACE_TOKEN_ENV_KEYS) {
    previousEnv.set(envKey, process.env[envKey]);
    delete process.env[envKey];
  }
  try {
    return await callback();
  } finally {
    for (const [envKey, envValue] of previousEnv.entries()) {
      if (envValue === undefined) {
        delete process.env[envKey];
      } else {
        process.env[envKey] = envValue;
      }
    }
  }
};

describe("huggingface remote helper", () => {
  it("normalizes direct repo ids and Hugging Face URLs", () => {
    assert.deepStrictEqual(
      normalizeHuggingFaceReference("openai/whisper-small"),
      {
        assetType: "model",
        repoId: "openai/whisper-small",
      },
    );
    assert.deepStrictEqual(
      normalizeHuggingFaceReference(
        "https://huggingface.co/datasets/argilla/databricks-dolly-15k",
      ),
      {
        assetType: "dataset",
        repoId: "argilla/databricks-dolly-15k",
      },
    );
    assert.deepStrictEqual(
      normalizeHuggingFaceReference(
        "pkg:huggingface/openai/whisper-small@ABC123",
      ),
      {
        assetType: "model",
        repoId: "openai/whisper-small",
        version: "ABC123",
      },
    );
    assert.deepStrictEqual(
      normalizeHuggingFaceReference(
        "https://huggingface.co/api/models/openai/whisper-small/revision/refs%2Fpr%2F7",
      ),
      {
        assetType: "model",
        repoId: "openai/whisper-small",
        version: "refs/pr/7",
      },
    );
    assert.strictEqual(
      normalizeHuggingFaceReference("/tmp/cdxgen-ai-inventory-1234"),
      undefined,
    );
  });

  it("creates PackageURL-based Hugging Face purls", () => {
    assert.strictEqual(
      toHuggingFacePurl("HuggingFaceH4/zephyr-7b-beta", "ABC123"),
      "pkg:huggingface/HuggingFaceH4/zephyr-7b-beta@abc123",
    );
    assert.strictEqual(
      toHuggingFacePurl("HuggingFaceH4/ultrachat_200k"),
      "pkg:huggingface/HuggingFaceH4/ultrachat_200k",
    );
    assert.strictEqual(
      toHuggingFacePurl(
        "HuggingFaceH4/ultrachat_200k",
        undefined,
        "https://huggingface.co/datasets",
      ),
      "pkg:huggingface/HuggingFaceH4/ultrachat_200k?repository_url=https%3A%2F%2Fhuggingface.co%2Fdatasets",
    );
  });

  it("derives readable quantization labels from config objects", () => {
    assert.strictEqual(
      quantizationValueFromConfig({ quant_method: "bnb", load_in_4bit: true }),
      "bnb 4-bit",
    );
    assert.strictEqual(
      quantizationValueFromConfig({ quant_type: "nf4", bits: 8 }),
      "nf4 8-bit",
    );
    assert.strictEqual(
      quantizationValueFromConfig("gguf-q5_k_m"),
      "gguf-q5_k_m",
    );
  });

  it("fetches Hugging Face inventory, links dataset components, and honors cache reset", async () => {
    const getStub = sinon.stub().callsFake(async (url) => {
      if (url.includes("mistralai/Mistral-7B-v0.1")) {
        return {
          body: {
            id: "mistralai/Mistral-7B-v0.1",
            sha: "BASE123",
            cardData: {},
            config: {},
            likes: 1,
            downloads: 1,
            gated: false,
            private: false,
          },
        };
      }
      return {
        body: {
          id: "HuggingFaceH4/zephyr-7b-beta",
          sha: "ABC123",
          author: "HuggingFaceH4",
          arxivIds: ["2401.00001"],
          description: "Helpful assistant model",
          disabled: false,
          downloads: 1234,
          downloadsAllTime: 67890,
          gated: false,
          inferenceProviderMapping: [
            {
              provider: "hf-inference",
              status: "live",
              task: "text-generation",
            },
          ],
          lastModified: "2025-01-01T00:00:00.000Z",
          library_name: "transformers",
          likes: 99,
          likesRecent: 12,
          private: false,
          spaces: ["HuggingFaceH4/zephyr-chat"],
          tags: ["chat"],
          doi: { id: "10.5555/example-doi", commit: "abc123" },
          siblings: [{ rfilename: "README.md" }, { rfilename: "LICENSE" }],
          cardData: {
            base_model: ["mistralai/Mistral-7B-v0.1"],
            base_model_relation: "adapter",
            datasets: [
              {
                config: "default",
                name: "HuggingFaceH4/ultrachat_200k",
                split: "train",
              },
            ],
            extra_gated_fields: { company: "text" },
            extra_gated_prompt: "Research access request",
            language: ["en"],
            license: "Apache-2.0",
            mask_token: "<mask>",
            "model-index": [
              {
                results: [
                  {
                    dataset: {
                      name: "HuggingFaceH4/ultrachat_200k",
                      split: "train",
                    },
                    metrics: [{ type: "MT-Bench", value: 7.5 }],
                  },
                ],
              },
            ],
            pipeline_tag: "text-generation",
            tags: ["summarization"],
            widget: [
              {
                messages: [{ role: "user", content: "Hello" }],
                output: { text: "Hi" },
              },
            ],
          },
          config: {
            architectures: ["LlamaForCausalLM"],
            model_type: "llama",
            quantization_config: {
              load_in_4bit: true,
              quant_method: "bnb",
            },
          },
        },
      };
    });
    const { fetchHuggingFaceAssetInventory, resetHuggingFaceRemoteCaches } =
      await withClearedHuggingFaceTokenEnv(async () =>
        esmock("./huggingface.js", {
          "../utils.js": {
            cdxgenAgent: { get: getStub },
            getLicenses: ({ license }) =>
              license
                ? [
                    {
                      license: {
                        id: Array.isArray(license) ? license[0]?.type : license,
                      },
                    },
                  ]
                : undefined,
            isDryRun: false,
            recordActivity: sinon.stub(),
          },
        }),
      );

    resetHuggingFaceRemoteCaches();
    const inventory = await fetchHuggingFaceAssetInventory(
      "model",
      "HuggingFaceH4/zephyr-7b-beta",
      {},
    );
    const cachedInventory = await fetchHuggingFaceAssetInventory(
      "model",
      "HuggingFaceH4/zephyr-7b-beta",
      {},
    );

    assert.ok(inventory, "expected remote inventory");
    assert.strictEqual(getStub.callCount, 2);
    assert.match(
      getStub.firstCall.args[0],
      /\/api\/models\/HuggingFaceH4\/zephyr-7b-beta\/revision\/HEAD\?/u,
    );
    assert.match(getStub.firstCall.args[0], /expand=downloadsAllTime/u);
    assert.strictEqual(
      cachedInventory?.primaryComponent?.name,
      "zephyr-7b-beta",
    );
    assert.strictEqual(
      inventory.primaryComponent.purl,
      "pkg:huggingface/HuggingFaceH4/zephyr-7b-beta@abc123",
    );
    assert.strictEqual(
      inventory.primaryComponent.modelCard.modelParameters.datasets[0].ref,
      "pkg:huggingface/HuggingFaceH4/ultrachat_200k?repository_url=https%3A%2F%2Fhuggingface.co%2Fdatasets",
    );
    assert.ok(
      inventory.components.some(
        (component) =>
          component.type === "data" &&
          component.group === "HuggingFaceH4" &&
          component.name === "ultrachat_200k" &&
          component.purl ===
            "pkg:huggingface/HuggingFaceH4/ultrachat_200k?repository_url=https%3A%2F%2Fhuggingface.co%2Fdatasets",
      ),
    );
    assert.deepStrictEqual(inventory.dependencies, [
      {
        ref: "pkg:huggingface/HuggingFaceH4/zephyr-7b-beta@abc123",
        dependsOn: [
          "pkg:huggingface/HuggingFaceH4/ultrachat_200k?repository_url=https%3A%2F%2Fhuggingface.co%2Fdatasets",
        ],
      },
    ]);
    assert.ok(
      inventory.primaryComponent.properties.some(
        (property) =>
          property.name === "cdx:ai:quantization" &&
          property.value === "bnb 4-bit",
      ),
    );
    assert.ok(
      inventory.primaryComponent.properties.some(
        (property) =>
          property.name === "cdx:huggingface:downloadsAllTime" &&
          property.value === "67890",
      ),
    );
    assert.ok(
      inventory.primaryComponent.properties.some(
        (property) =>
          property.name === "cdx:huggingface:inferenceProvider" &&
          property.value === "hf-inference",
      ),
    );
    assert.ok(
      inventory.primaryComponent.modelCard.properties.some(
        (property) =>
          property.name === "cdx:huggingface:maskToken" &&
          property.value === "<mask>",
      ),
    );
    assert.strictEqual(
      inventory.primaryComponent.modelCard.modelParameters.inputs[0].format,
      "text",
    );
    assert.ok(
      inventory.primaryComponent.externalReferences.some(
        (reference) =>
          reference.type === "citation" &&
          reference.url === "https://doi.org/10.5555/example-doi",
      ),
    );

    resetHuggingFaceRemoteCaches();
    await fetchHuggingFaceAssetInventory(
      "model",
      "HuggingFaceH4/zephyr-7b-beta",
      {},
    );
    assert.strictEqual(getStub.callCount, 4);
  });

  it("resolves Hugging Face spaces into application components with model and dataset dependencies", async () => {
    const getStub = sinon.stub().resolves({
      body: {
        id: "team/demo-space",
        sha: "SPACE123",
        createdAt: "2025-02-01T00:00:00.000Z",
        lastModified: "2025-02-02T00:00:00.000Z",
        likes: 42,
        private: false,
        sdk: "gradio",
        subdomain: "team-demo-space",
        datasets: ["HuggingFaceH4/ultrachat_200k"],
        models: ["HuggingFaceH4/zephyr-7b-beta"],
        runtime: {
          stage: "RUNNING",
          sdkVersion: "5.0.0",
          hardware: { current: "cpu-basic", requested: "cpu-basic" },
        },
        tags: ["chatbot"],
      },
    });
    const { fetchHuggingFaceAssetInventory, resetHuggingFaceRemoteCaches } =
      await withClearedHuggingFaceTokenEnv(async () =>
        esmock("./huggingface.js", {
          "../utils.js": {
            cdxgenAgent: { get: getStub },
            getLicenses: ({ license }) =>
              license
                ? [
                    {
                      license: {
                        id: Array.isArray(license) ? license[0]?.type : license,
                      },
                    },
                  ]
                : undefined,
            isDryRun: false,
            recordActivity: sinon.stub(),
          },
        }),
      );

    resetHuggingFaceRemoteCaches();
    const inventory = await fetchHuggingFaceAssetInventory(
      "space",
      "team/demo-space",
      {},
    );

    assert.ok(inventory, "expected space inventory");
    assert.strictEqual(inventory.primaryComponent.type, "application");
    assert.ok(
      inventory.primaryComponent.properties.some(
        (property) =>
          property.name === "cdx:huggingface:runtimeStage" &&
          property.value === "RUNNING",
      ),
    );
    assert.ok(
      inventory.components.some(
        (component) =>
          component.type === "machine-learning-model" &&
          component.purl === "pkg:huggingface/HuggingFaceH4/zephyr-7b-beta",
      ),
    );
    assert.ok(
      inventory.components.some(
        (component) =>
          component.type === "data" &&
          component.purl ===
            "pkg:huggingface/HuggingFaceH4/ultrachat_200k?repository_url=https%3A%2F%2Fhuggingface.co%2Fdatasets",
      ),
    );
    assert.deepStrictEqual(inventory.dependencies, [
      {
        ref: "pkg:huggingface/team/demo-space@space123?repository_url=https%3A%2F%2Fhuggingface.co%2Fspaces",
        dependsOn: [
          "pkg:huggingface/HuggingFaceH4/ultrachat_200k?repository_url=https%3A%2F%2Fhuggingface.co%2Fdatasets",
          "pkg:huggingface/HuggingFaceH4/zephyr-7b-beta",
        ],
      },
    ]);
  });
});
