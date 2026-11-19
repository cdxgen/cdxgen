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

  it("reads only scalar relation and signal values", () => {
    const nested = Array.from({ length: 2000 }).reduce(
      (value) => [value, 0],
      "a".repeat(100000),
    );
    const started = Date.now();
    assert.deepStrictEqual(
      detectAiModelVariants({
        description: nested,
        modelName: { toString: 1 },
        notes: [nested],
        relation: nested,
        tags: [{ kind: nested }, "gptq"],
      }),
      ["quantized"],
    );
    assert.deepStrictEqual(
      detectAiModelVariants({ relation: { toString: 1 } }),
      [],
    );
    assert.ok(Date.now() - started < 5000);
  });
});
