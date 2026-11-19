import { inspect } from "node:util";

import { assert, describe, it } from "poku";

import { parseToml } from "./toml.js";

describe("parseToml()", () => {
  it("returns plain objects", () => {
    assert.deepStrictEqual(parseToml('[a]\nb = { c = 1 }\nd = ["x"]\n'), {
      a: { b: { c: 1 }, d: ["x"] },
    });
  });

  it("reports where a document is invalid", () => {
    assert.throws(() => parseToml("a = 1\nb = 1 2\n"), {
      name: "SyntaxError",
      message: /must be followed by an end-of-line at line 2, column 7$/,
    });
  });

  it("keeps the text of the document out of the error", () => {
    for (const source of [
      'url = "https://user:s3cr3t@example.com/simple"\n<<<<<<< HEAD\n',
      '<<<<<<< HEAD\nurl = "https://user:s3cr3t@example.com/simple"\n',
      'url = "https://user:s3cr3t@example.com/simple\n',
      "TOKEN=s3cr3t\0HOME=/root\0",
    ]) {
      let error;
      try {
        parseToml(source);
      } catch (err) {
        error = err;
      }
      assert.ok(error instanceof SyntaxError);
      assert.ok(!inspect(error).includes("s3cr3t"));
      assert.ok(!`${error.message}${error.stack}`.includes("s3cr3t"));
    }
  });
});
