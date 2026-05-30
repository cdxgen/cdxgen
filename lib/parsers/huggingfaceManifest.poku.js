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
      "pkg:huggingface/HuggingFaceH4/ultrachat_200k?repository_url=https%3A%2F%2Fhuggingface.co%2Fdatasets",
    );
    assert.strictEqual(
      datasetReference.purl,
      "pkg:huggingface/HuggingFaceH4/ultrachat_200k?repository_url=https%3A%2F%2Fhuggingface.co%2Fdatasets",
    );
    assert.strictEqual(
      datasetReference.component.purl,
      "pkg:huggingface/HuggingFaceH4/ultrachat_200k?repository_url=https%3A%2F%2Fhuggingface.co%2Fdatasets",
    );
    assert.strictEqual(
      datasetReference.component.data[0].contents.url,
      "https://huggingface.co/datasets/HuggingFaceH4/ultrachat_200k",
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
      "pkg:huggingface/HuggingFaceH4/ultrachat_200k?repository_url=https%3A%2F%2Fhuggingface.co%2Fdatasets",
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

  it("infers repo ids from fixture directory names", () => {
    assert.strictEqual(
      repoIdFromFixtureDirectory(
        "/tmp/fixtures/HuggingFaceH4--zephyr-7b-beta/README.md",
      ),
      "HuggingFaceH4/zephyr-7b-beta",
    );
  });
});
