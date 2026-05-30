import { assert, describe, it } from "poku";

import {
  detectAiModelVariants,
  normalizeDetectedVariants,
} from "./aiModelVariants.js";

describe("aiModelVariants helpers", () => {
  it("normalizes duplicate detected variant labels", () => {
    assert.deepStrictEqual(
      normalizeDetectedVariants(["adapter", undefined, "adapter", "quantized"]),
      ["adapter", "quantized"],
    );
  });

  it("detects ordered normalized variant labels from model signals", () => {
    assert.deepStrictEqual(
      detectAiModelVariants({
        modelName: "team/model-awq",
        notes: ["fine-tuned and merged for chat"],
        quantization: "awq 4-bit",
        relation: "adapter",
        tags: ["uncensored"],
      }),
      ["fine-tuned", "quantized", "adapter", "merged", "unlocked"],
    );
  });
});
