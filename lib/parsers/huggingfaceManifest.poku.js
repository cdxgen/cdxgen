import { assert, describe, it } from "poku";

import {
  createHuggingFaceDatasetReference,
  createHuggingFaceModelCard,
  createHuggingFacePedigree,
  hasHuggingFaceCardSignals,
  parseHuggingFaceReadmeFrontmatter,
  repoIdFromFixtureDirectory,
} from "./huggingfaceManifest.js";

describe("Hugging Face manifest parser", () => {
  it("reads README frontmatter after blank padding and an unclosed opener in linear time", () => {
    assert.strictEqual(
      parseHuggingFaceReadmeFrontmatter("---  \r\nmodelId: a/b\r\n---\r\n")
        ?.modelId,
      "a/b",
    );
    const started = performance.now();
    parseHuggingFaceReadmeFrontmatter(`---${"\n".repeat(250000)}`);
    const elapsed = performance.now() - started;
    // Quadratic matching needs many seconds for this input.
    assert.ok(elapsed < 1500, `took ${Math.round(elapsed)} ms`);
  });

  it("parses README frontmatter and recognizes model-card signals", () => {
    const cardData = parseHuggingFaceReadmeFrontmatter(
      [
        "---",
        "modelId: HuggingFaceH4/zephyr-7b-beta",
        "pipeline_tag: text-generation",
        "datasets:",
        "  - HuggingFaceH4/ultrachat_200k",
        "---",
        "",
        "# Zephyr",
      ].join("\n"),
    );

    assert.ok(hasHuggingFaceCardSignals(cardData));
    assert.strictEqual(cardData.modelId, "HuggingFaceH4/zephyr-7b-beta");
  });

  it("creates reusable dataset references with stable bom-refs and dataset purls", () => {
    const datasetReference = createHuggingFaceDatasetReference({
      config: "default",
      name: "HuggingFaceH4/ultrachat_200k",
      split: "train",
      url: "https://huggingface.co/datasets/HuggingFaceH4/ultrachat_200k?download=1#fragment",
    });

    assert.ok(datasetReference, "expected dataset reference");
    assert.strictEqual(
      datasetReference.bomRef,
      "pkg:huggingface/HuggingFaceH4/ultrachat_200k?repository_url=https:%2F%2Fhuggingface.co%2Fdatasets",
    );
    assert.strictEqual(
      datasetReference.purl,
      "pkg:huggingface/HuggingFaceH4/ultrachat_200k?repository_url=https:%2F%2Fhuggingface.co%2Fdatasets",
    );
    assert.strictEqual(
      datasetReference.component.purl,
      "pkg:huggingface/HuggingFaceH4/ultrachat_200k?repository_url=https:%2F%2Fhuggingface.co%2Fdatasets",
    );
    assert.strictEqual(
      datasetReference.component.data[0].contents.url,
      "https://huggingface.co/datasets/HuggingFaceH4/ultrachat_200k",
    );
    assert.deepStrictEqual(
      datasetReference.component.supplier,
      { name: "HuggingFaceH4", url: ["https://huggingface.co/HuggingFaceH4"] },
      "the dataset namespace fills the producer element",
    );
  });

  it("builds a model card and pedigree from Hugging Face manifest metadata", () => {
    const datasetReference = createHuggingFaceDatasetReference(
      "HuggingFaceH4/ultrachat_200k",
    );
    const modelCard = createHuggingFaceModelCard(
      {
        finetuned_from: "mistralai/Mistral-7B-v0.1",
        language: ["en"],
        language_bcp47: ["en-US"],
        datasets: ["HuggingFaceH4/ultrachat_200k"],
        library_name: "transformers",
        model_index: [
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
        co2_eq_emissions: {
          emissions: 123.4,
          hardware_used: "1x A100",
          source: "AutoTrain",
          training_type: "fine-tuning",
        },
        extra_gated_fields: {
          company: "text",
          country: { type: "country" },
        },
        extra_gated_prompt: "Research access request",
        mask_token: "<mask>",
        pipeline_tag: "text-generation",
        tags: ["chat", "summarization"],
        widget: [
          {
            messages: [{ role: "user", content: "Hello" }],
            output: { text: "Hi" },
          },
        ],
      },
      {
        architectures: ["LlamaForCausalLM"],
        model_type: "llama",
      },
      () => datasetReference.ref,
    );
    const pedigree = createHuggingFacePedigree(
      {
        finetuned_from: "mistralai/Mistral-7B-v0.1",
        base_model_relation: "adapter",
      },
      {},
      "bnb 4-bit",
    );

    assert.strictEqual(modelCard.modelParameters.task, "text-generation");
    assert.strictEqual(
      modelCard.modelParameters.datasets[0].ref,
      "pkg:huggingface/HuggingFaceH4/ultrachat_200k?repository_url=https:%2F%2Fhuggingface.co%2Fdatasets",
    );
    assert.strictEqual(
      modelCard.quantitativeAnalysis.performanceMetrics[0].type,
      "MT-Bench",
    );
    assert.strictEqual(modelCard.modelParameters.inputs[0].format, "text");
    assert.strictEqual(modelCard.modelParameters.outputs[0].format, "text");
    assert.ok(modelCard.considerations.useCases.includes("text-generation"));
    assert.ok(modelCard.considerations.useCases.includes("summarization"));
    assert.ok(
      modelCard.properties.some(
        (property) =>
          property.name === "cdx:huggingface:language" &&
          property.value === "en",
      ),
    );
    assert.ok(
      modelCard.properties.some(
        (property) =>
          property.name === "cdx:huggingface:gatedFieldCount" &&
          property.value === "2",
      ),
    );
    assert.ok(
      modelCard.considerations.environmentalConsiderations.properties.some(
        (property) =>
          property.name === "cdx:huggingface:co2EmissionsGrams" &&
          property.value === "123.4",
      ),
    );
    assert.strictEqual(pedigree.ancestors[0].group, "mistralai");
    assert.match(pedigree.notes, /bnb 4-bit/u);
  });

  it("adds the properties of a card with many languages in linear time", () => {
    const languages = Array.from({ length: 40000 }, (_, n) => `l${n}`);
    const start = Date.now();
    const modelCard = createHuggingFaceModelCard({
      language: [...languages, ...languages],
      language_bcp47: languages,
    });
    const names = modelCard.properties.map((property) => property.name);
    assert.strictEqual(
      names.filter((name) => name === "cdx:huggingface:language").length,
      40000,
    );
    assert.strictEqual(
      names.filter((name) => name === "cdx:huggingface:languageBcp47").length,
      40000,
    );
    assert.ok(
      Date.now() - start < 5000,
      "appending properties must not search the list for every entry",
    );
  });

  it("bounds the dataset label repeated on every performance metric", () => {
    const modelCard = createHuggingFaceModelCard({
      "model-index": [
        {
          results: [
            {
              dataset: { name: "d".repeat(10000), split: "test" },
              metrics: [
                { type: "accuracy", value: 1 },
                { type: "f1", value: 2 },
              ],
            },
          ],
        },
      ],
    });
    const { performanceMetrics } = modelCard.quantitativeAnalysis;
    assert.strictEqual(performanceMetrics.length, 2);
    for (const metric of performanceMetrics) {
      assert.strictEqual(metric.slice, "d".repeat(256));
    }
    assert.deepStrictEqual(
      performanceMetrics.map((metric) => [metric.type, metric.value]),
      [
        ["accuracy", "1"],
        ["f1", "2"],
      ],
    );
  });

  it("infers repo ids from fixture directory names", () => {
    assert.strictEqual(
      repoIdFromFixtureDirectory(
        "/tmp/fixtures/HuggingFaceH4--zephyr-7b-beta/README.md",
      ),
      "HuggingFaceH4/zephyr-7b-beta",
    );
  });

  it("rejects frontmatter with duplicate keys", () => {
    const cardData = parseHuggingFaceReadmeFrontmatter(
      ["---", "license: mit", "license: gpl-3.0", "---"].join("\n"),
    );
    assert.strictEqual(cardData, undefined);
  });

  it("reads only scalar relation, quantization and task values", () => {
    const nested = Array.from({ length: 2000 }).reduce(
      (value) => [value, 0],
      "a".repeat(100000),
    );
    const started = Date.now();
    const pedigree = createHuggingFacePedigree(
      { base_model: "acme/base", base_model_relation: nested },
      {},
      nested,
    );
    const modelCard = createHuggingFaceModelCard({
      pipeline_tag: nested,
      tags: [nested],
    });
    assert.ok(Date.now() - started < 5000);
    assert.deepStrictEqual(Object.keys(pedigree), ["ancestors"]);
    assert.strictEqual(pedigree.notes, undefined);
    assert.ok(modelCard === undefined || typeof modelCard === "object");
  });
});
