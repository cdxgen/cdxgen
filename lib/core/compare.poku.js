import { assert, describe, it } from "poku";

import { compareCodeUnits } from "./compare.js";

describe("compareCodeUnits()", () => {
  it("orders by UTF-16 code units", () => {
    assert.deepStrictEqual(
      ["b", "B", "a", "a_b", "a-b", "", "\u00e0"].sort(compareCodeUnits),
      ["", "B", "a", "a-b", "a_b", "b", "\u00e0"],
    );
    assert.strictEqual(compareCodeUnits("x", "x"), 0);
    assert.strictEqual(compareCodeUnits(undefined, ""), 0);
    assert.strictEqual(compareCodeUnits(undefined, "a"), -1);
    assert.strictEqual(compareCodeUnits("a", null), 1);
  });

  it("compares text that makes collation slow", () => {
    // Two strings that differ only in an accent and continue with the same
    // run of out-of-order combining marks.
    const tail = `${"\u0F71".repeat(5000)}${"\u0334".repeat(5000)}`;
    const left = `\u0301${tail}`;
    const right = `\u0300${tail}`;
    assert.strictEqual(compareCodeUnits(left, right), 1);
  });
});
