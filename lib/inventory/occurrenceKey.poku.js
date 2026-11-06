import { assert, describe, it } from "poku";

import {
  dropSubsumedOccurrenceKeys,
  occurrenceKeyLocation,
  occurrenceLocationKey,
} from "./occurrenceKey.js";

// The occurrence set of a purl is keyed by the place a use happened, and every
// evidence source keys its places through occurrenceLocationKey, so a place
// spelled `src\app\x.ts` in a Windows BOM and `src/app/x.ts` in a slice is one
// occurrence (issue 4726).
describe("occurrenceLocationKey()", () => {
  it("writes a backslash location with forward slashes", () => {
    assert.strictEqual(
      occurrenceLocationKey("src\\app\\x.ts", 3),
      "src/app/x.ts#3",
    );
  });

  it("keeps a forward-slash location as it is", () => {
    assert.strictEqual(
      occurrenceLocationKey("src/app/x.ts", 3),
      "src/app/x.ts#3",
    );
  });

  it("does not otherwise rewrite the path", () => {
    // No resolving, no case folding, no stripping of a leading ./
    assert.strictEqual(occurrenceLocationKey("./x.ts", 3), "./x.ts#3");
    assert.strictEqual(
      occurrenceLocationKey("C:\\Src\\X.ts", 3),
      "C:/Src/X.ts#3",
    );
  });

  it("keeps a location without a positive line number file-only", () => {
    assert.strictEqual(occurrenceLocationKey("src\\app\\x.ts"), "src/app/x.ts");
    assert.strictEqual(
      occurrenceLocationKey("src\\app\\x.ts", 0),
      "src/app/x.ts",
    );
    assert.strictEqual(
      occurrenceLocationKey("src\\app\\x.ts", -1),
      "src/app/x.ts",
    );
  });

  it("returns undefined for an empty location", () => {
    assert.strictEqual(occurrenceLocationKey(undefined, 3), undefined);
    assert.strictEqual(occurrenceLocationKey("", 3), undefined);
    assert.strictEqual(occurrenceLocationKey("  "), undefined);
  });

  it("keys a use site with its column and forward slashes", () => {
    assert.strictEqual(
      occurrenceLocationKey("src\\app\\x.ts", 3, 10),
      "src/app/x.ts:3:10",
    );
    assert.strictEqual(
      occurrenceLocationKey("src/app/x.ts", 3, 20),
      "src/app/x.ts:3:20",
    );
  });

  // atom counts columns from 0, so a use at the start of a line is column 0;
  // -1 is atom's unknown column
  it("keeps column 0 as a column", () => {
    assert.strictEqual(occurrenceLocationKey("x.ts", 3, 0), "x.ts:3:0");
  });

  it("treats a column that is not an integer of 0 or more as no column", () => {
    assert.strictEqual(occurrenceLocationKey("x.ts", 3, -1), "x.ts#3");
    assert.strictEqual(occurrenceLocationKey("x.ts", 3, 2.5), "x.ts#3");
    assert.strictEqual(occurrenceLocationKey("x.ts", 3, "4"), "x.ts#3");
    assert.strictEqual(occurrenceLocationKey("x.ts", 3, undefined), "x.ts#3");
  });
});

// A line-only key names no place of its own once a use site on that line
// exists: an occurrence seeded from an input BOM with only location and line
// is the same place as a callsites occurrence at that line (issue 4726).
describe("dropSubsumedOccurrenceKeys()", () => {
  it("drops the line-only key of a line a use-site key names", () => {
    assert.deepStrictEqual(
      dropSubsumedOccurrenceKeys([
        "src/app/w.ts#8",
        "src/app/x.ts#3",
        "src/app/x.ts:3:10",
        "src/app/x.ts:3:20",
      ]),
      ["src/app/w.ts#8", "src/app/x.ts:3:10", "src/app/x.ts:3:20"],
    );
  });

  it("keeps line-only keys of lines without a use site", () => {
    assert.deepStrictEqual(
      dropSubsumedOccurrenceKeys(["src/app/x.ts#3", "src/app/y.ts#4"]),
      ["src/app/x.ts#3", "src/app/y.ts#4"],
    );
  });

  it("keeps file-only keys", () => {
    assert.deepStrictEqual(
      dropSubsumedOccurrenceKeys(["src/app/x.ts", "src/app/x.ts:3:10"]),
      ["src/app/x.ts", "src/app/x.ts:3:10"],
    );
  });
});

describe("occurrenceKeyLocation()", () => {
  it("returns the location of every key shape", () => {
    assert.strictEqual(occurrenceKeyLocation("src/a.js:3:14"), "src/a.js");
    assert.strictEqual(occurrenceKeyLocation("src/a.js:3:0"), "src/a.js");
    assert.strictEqual(occurrenceKeyLocation("src/a.js#3"), "src/a.js");
    assert.strictEqual(occurrenceKeyLocation("angular.json"), "angular.json");
  });

  it("is the inverse of occurrenceLocationKey for the location", () => {
    for (const [location, line, offset] of [
      ["src/app/x.ts", 4, 9],
      ["src/app/x.ts", 4, undefined],
      ["src/app/x.ts", undefined, undefined],
      ["src\\app\\x.ts", 4, -1],
    ]) {
      assert.strictEqual(
        occurrenceKeyLocation(occurrenceLocationKey(location, line, offset)),
        "src/app/x.ts",
      );
    }
  });

  it("keeps a `#` that is not followed by a line number", () => {
    assert.strictEqual(occurrenceKeyLocation("docs/c#/a.cs"), "docs/c#/a.cs");
  });
});
