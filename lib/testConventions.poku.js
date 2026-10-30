import { readFileSync } from "node:fs";

import { globSync } from "glob";
import { assert, describe, it } from "poku";

describe("test conventions", () => {
  it("takes assert from poku, which prints a failure that node:assert would hide", () => {
    // poku reports an AssertionError only from its own assert; one thrown by
    // node:assert inside an it() fails the file without a message.
    const offenders = globSync("{lib,bin}/**/*.poku.js").filter((file) =>
      /from "node:assert(?:\/strict)?"/u.test(readFileSync(file, "utf8")),
    );
    assert.deepStrictEqual(offenders, []);
  });
});
