import { assert, describe, it } from "poku";

import {
  findDangerousUnicodeMatches,
  scanTextForHiddenUnicode,
} from "./unicodeScan.js";

describe("findDangerousUnicodeMatches()", () => {
  it("finds bidirectional and zero-width characters with code points", () => {
    const matches = findDangerousUnicodeMatches("safe\u202Evalue\u200Bhidden");

    assert.strictEqual(matches.length, 2);
    assert.deepStrictEqual(
      matches.map((match) => match.codePoint),
      ["U+202E", "U+200B"],
    );
  });
});

describe("scanTextForHiddenUnicode()", () => {
  it("tracks markdown comment context for hidden Unicode", () => {
    const scan = scanTextForHiddenUnicode(
      "Visible line\n<!-- sneaky \u200B marker -->\nTrailing line",
      { syntax: "markdown" },
    );

    assert.strictEqual(scan.hasHiddenUnicode, true);
    assert.strictEqual(scan.inComments, true);
    assert.deepStrictEqual(scan.commentCodePoints, ["U+200B"]);
    assert.deepStrictEqual(scan.lineNumbers, [2]);
    assert.deepStrictEqual(scan.contexts, ["comment"]);
  });

  it("tracks yaml comment context for hidden Unicode", () => {
    const scan = scanTextForHiddenUnicode(
      "name: build\n# hidden \u202E comment\njobs:\n  test:\n    runs-on: ubuntu-latest",
      { syntax: "yaml" },
    );

    assert.strictEqual(scan.hasHiddenUnicode, true);
    assert.strictEqual(scan.inComments, true);
    assert.deepStrictEqual(scan.commentCodePoints, ["U+202E"]);
    assert.deepStrictEqual(scan.lineNumbers, [2]);
  });
});
