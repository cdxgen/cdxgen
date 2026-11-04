import { assert, describe, it } from "poku";

import { occurrenceLocationKey } from "./occurrenceKey.js";

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
});
