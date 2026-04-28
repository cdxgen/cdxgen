import { assert, describe, it } from "poku";

import {
  buildAnnotationText,
  propertiesToMarkdownTable,
} from "./annotationFormatter.js";

describe("annotationFormatter", () => {
  it("escapes markdown tables for untrusted annotation properties", () => {
    const table = propertiesToMarkdownTable([
      {
        name: "<script>alert(1)</script>",
        value: "[click](javascript:alert(1))\nnext|cell & more",
      },
    ]);

    assert.strictEqual(
      table,
      [
        "| Property | Value |",
        "| --- | --- |",
        String.raw`| &lt;script&gt;alert\(1\)&lt;/script&gt; | \[click\]\(javascript:alert\(1\)\)<br>next\|cell &amp; more |`,
      ].join("\n"),
    );
  });

  it("escapes markdown and HTML-sensitive content in annotation messages", () => {
    const htmlLikeMessage =
      String.fromCharCode(60) +
      "img src=x onerror=alert(1)" +
      String.fromCharCode(62);
    const text = buildAnnotationText(
      htmlLikeMessage,
      [{ name: "cdx:test", value: "safe" }],
      ["[open](javascript:alert(1))", "line\nbreak"],
    );

    assert.ok(text.startsWith("&lt;img src=x onerror=alert\\(1\\)&gt;"));
    assert.ok(text.includes("\\[open\\]\\(javascript:alert\\(1\\)\\)"));
    assert.ok(text.includes("line<br>break"));
    assert.ok(text.includes("| cdx:test | safe |"));
    assert.ok(!text.includes(htmlLikeMessage));
  });
});
