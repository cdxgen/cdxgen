import { assert, describe, it } from "poku";

import { parseJsonLike, stripJsonComments } from "./jsonLike.js";

describe("jsonLike", () => {
  it("preserves escaped quotes while stripping comments", () => {
    const parsedMessage = 'escaped quote: " // not a comment';
    const rawMessage = String.raw`escaped quote: \" // not a comment`;
    const raw = String.raw`{
      "message": "escaped quote: \" // not a comment",
      // trailing comment
      "enabled": true
    }`;
    const stripped = stripJsonComments(raw);
    assert.ok(stripped.includes(rawMessage));
    assert.ok(!stripped.includes("trailing comment"));
    assert.deepStrictEqual(parseJsonLike(raw), {
      enabled: true,
      message: parsedMessage,
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
