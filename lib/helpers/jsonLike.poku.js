import { assert, describe, it } from "poku";

import { parseJsonLike, stripJsonComments } from "./jsonLike.js";

describe("jsonLike", () => {
  it("preserves escaped quotes while stripping comments", () => {
    const raw = `{
      "message": "escaped quote: \\\" // not a comment",
      // trailing comment
      "enabled": true
    }`;
    const stripped = stripJsonComments(raw);
    assert.match(stripped, /escaped quote: \\\\" \/\/ not a comment/u);
    assert.deepStrictEqual(parseJsonLike(raw), {
      enabled: true,
      message: 'escaped quote: \\" // not a comment',
    });
  });

  it("preserves comment markers after escaped backslashes inside strings", () => {
    const raw = `{
      "path": "C:\\\\\\\\temp\\\\\\\\file // keep",
      /* block comment */
      "count": 1
    }`;
    assert.deepStrictEqual(parseJsonLike(raw), {
      count: 1,
      path: "C:\\\\temp\\\\file // keep",
    });
  });
});
