import { assert, describe, it } from "poku";

import {
  MODEL_CREATOR_NAMES,
  modelCreatorEntity,
  modelCreatorFromName,
  modelCreatorFromOrganization,
  resolveModelCreator,
  splitModelReference,
} from "./aiProviders.js";

describe("aiProviders", () => {
  it("writes every creator with its full organisation name", () => {
    assert.deepStrictEqual(
      [...MODEL_CREATOR_NAMES.values()].sort(),
      [
        "Alibaba Cloud",
        "Anthropic",
        "Cohere",
        "DeepSeek",
        "Google",
        "Meta",
        "Mistral AI",
        "OpenAI",
        "xAI",
        "Zhipu AI",
      ].sort(),
    );
    assert.deepStrictEqual(modelCreatorEntity("mistral"), {
      name: "Mistral AI",
    });
    assert.strictEqual(modelCreatorEntity("groq"), undefined);
    assert.strictEqual(modelCreatorEntity(undefined), undefined);
  });

  it("splits routes and Google resource names from Hub repository ids", () => {
    assert.deepStrictEqual(splitModelReference("groq/llama3-8b-8192"), {
      name: "llama3-8b-8192",
      nonHub: true,
      route: "groq",
      routeProvider: "groq",
    });
    assert.deepStrictEqual(splitModelReference("models/gemini-1.5-flash"), {
      name: "gemini-1.5-flash",
      nonHub: true,
    });
    assert.deepStrictEqual(
      splitModelReference(
        "projects/p/locations/l/publishers/google/models/gemini-1.5-pro",
      ),
      { name: "gemini-1.5-pro", nonHub: true },
    );
    // Real Hub organisations stay Hub ids, including ones that share a
    // route name in another case.
    for (const repoId of [
      "meta-llama/Llama-3.1-8B",
      "Groq/Llama-3-Groq-8B-Tool-Use",
      "openai/whisper-large-v3",
      "google/gemma-2-9b-it",
    ]) {
      assert.deepStrictEqual(
        splitModelReference(repoId),
        { name: repoId, nonHub: false },
        repoId,
      );
    }
  });

  it("names a creator only for unambiguous model name prefixes", () => {
    const cases = {
      "claude-3-5-sonnet": "anthropic",
      "gpt-4o": "openai",
      "gpt-35-turbo": "openai",
      o1: "openai",
      "o3-mini": "openai",
      "o4-mini": "openai",
      "gemini-2.0-flash": "google",
      "gemma-2-9b-it": "google",
      "mixtral-8x7b": "mistral",
      "codestral-latest": "mistral",
      "command-r-plus": "cohere",
      "grok-2": "xai",
      "qwen2.5-72b": "alibaba",
      "glm-4": "zhipu",
      "text-embedding-3-small": "openai",
      "gpt-j-6b": undefined,
      "gpt4all-j": undefined,
      "openhermes-2.5-mistral-7b": undefined,
      "polo1-mini": undefined,
    };
    for (const [name, creator] of Object.entries(cases)) {
      assert.strictEqual(modelCreatorFromName(name), creator, name);
    }
  });

  it("resolves creator spellings from Hub organisations and GGUF metadata", () => {
    assert.strictEqual(modelCreatorFromOrganization("meta-llama"), "meta");
    assert.strictEqual(modelCreatorFromOrganization("Meta Llama"), "meta");
    assert.strictEqual(modelCreatorFromOrganization("Mistralai"), "mistral");
    assert.strictEqual(modelCreatorFromOrganization("Qwen"), "alibaba");
    assert.strictEqual(modelCreatorFromOrganization("TheBloke"), undefined);
    assert.strictEqual(modelCreatorFromOrganization("unsloth"), undefined);
  });

  it("resolves the creator only when the provider agrees with the model name", () => {
    const cases = [
      ["gpt-4o", { provider: "openai" }, "openai"],
      ["llama3.2", { provider: "openai" }, undefined],
      ["claude-3", { provider: "openai" }, undefined],
      [
        "claude-3",
        { provider: "openai", fileProviders: ["openai", "anthropic"] },
        "anthropic",
      ],
      ["qwen-max", { provider: "dashscope" }, "alibaba"],
      ["baichuan2-7b", { provider: "dashscope" }, undefined],
      ["my-model", { provider: "google" }, undefined],
      ["my-model", { provider: "anthropic" }, "anthropic"],
      ["my-model", { provider: "openai" }, undefined],
      ["mixtral-8x7b", { provider: "groq" }, "mistral"],
      ["llama-3.1-8b", { provider: "vllm" }, undefined],
      ["llama-3.1-8b", { provider: "lm-studio" }, undefined],
      ["llama-3.1-8b", { runtimes: ["llama.cpp"] }, undefined],
      ["groq/llama3-8b-8192", {}, "meta"],
      ["ollama/llama3", {}, undefined],
      ["hosted_vllm/llama-3", {}, undefined],
      ["gemini/gemini-1.5-pro", {}, "google"],
      ["models/gemini-1.5-flash", { provider: "google" }, "google"],
    ];
    for (const [modelId, context, creator] of cases) {
      assert.strictEqual(
        resolveModelCreator(modelId, context),
        creator,
        `${modelId} ${JSON.stringify(context)}`,
      );
    }
  });
});
