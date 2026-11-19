import { assert, describe, it } from "poku";

import { scalarText } from "./scalar.js";

describe("scalarText()", () => {
  it("reads strings, finite numbers and booleans", () => {
    assert.strictEqual(scalarText("gptq"), "gptq");
    assert.strictEqual(scalarText(4), "4");
    assert.strictEqual(scalarText(0.2), "0.2");
    assert.strictEqual(scalarText(false), "false");
  });

  it("returns an empty string for any other value", () => {
    for (const value of [
      undefined,
      null,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      ["a"],
      [["a", 0], 0],
      { name: "a" },
      { toString: 1 },
      10n,
    ]) {
      assert.strictEqual(scalarText(value), "");
    }
  });

  it("cuts a string to the longest length", () => {
    assert.strictEqual(scalarText("abcdef", 3), "abc");
    assert.strictEqual(scalarText("abc", 3), "abc");
  });
});
