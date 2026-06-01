import { assert, describe, it } from "poku";

import { parseOllamaModelfile } from "./ollama.js";

describe("parseOllamaModelfile()", () => {
  it("parses common directives into structured metadata", () => {
    const parsed = parseOllamaModelfile(
      [
        "# comment",
        "FROM llama3.2",
        "PARAMETER temperature 0.1",
        "PARAMETER num_ctx 8192",
        "SYSTEM You are helpful.",
        "TEMPLATE {{ .Prompt }}",
        "ADAPTER team/adapter",
        "LICENSE Apache-2.0",
      ].join("\n"),
    );

    assert.strictEqual(parsed.from, "llama3.2");
    assert.strictEqual(parsed.parameters.temperature, "0.1");
    assert.strictEqual(parsed.parameters.num_ctx, "8192");
    assert.strictEqual(parsed.system, "You are helpful.");
    assert.strictEqual(parsed.template, "{{ .Prompt }}");
    assert.deepStrictEqual(parsed.adapters, ["team/adapter"]);
    assert.strictEqual(parsed.license, "Apache-2.0");
  });

  it("normalizes local traversal paths in FROM and ADAPTER directives", () => {
    const parsed = parseOllamaModelfile(
      [
        "FROM ../models/./llama3.1-8b.Q4_K_M.gguf",
        "ADAPTER ..\\adapters\\lora.gguf",
      ].join("\n"),
    );

    assert.strictEqual(parsed.from, "models/llama3.1-8b.Q4_K_M.gguf");
    assert.deepStrictEqual(parsed.adapters, ["adapters/lora.gguf"]);
  });

  it("preserves absolute path semantics when normalizing traversal paths", () => {
    const parsed = parseOllamaModelfile("FROM /models/../foo.gguf");

    assert.strictEqual(parsed.from, "/foo.gguf");
  });
});
