import { spawnSync } from "node:child_process";
import process from "node:process";

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

  it("keeps the text between comments without a heap object per character", () => {
    // Measured in a fresh process, so that memory other tests freed cannot
    // hide the growth.
    const script = `
      const { parseJsonLike, stripJsonComments, stripJsonTrailingCommas } =
        await import(${JSON.stringify(new URL("./jsonLike.js", import.meta.url).href)});
      const text = '{"name": "x", /* note */' + " ".repeat(16 * 1024 * 1024) + "}";
      const before = process.memoryUsage().rss;
      const stripped = stripJsonTrailingCommas(stripJsonComments(text));
      const grown = process.memoryUsage().rss - before;
      console.log(JSON.stringify({ grown, name: parseJsonLike(stripped).name }));
    `;
    // Under Deno, process.execPath is the deno binary, which evaluates a
    // module with `deno eval`.
    const evalArgs = globalThis.Deno
      ? ["eval", script]
      : ["--input-type=module", "-e", script];
    const result = spawnSync(process.execPath, evalArgs, {
      encoding: "utf-8",
    });
    assert.strictEqual(result.status, 0, result.stderr);
    const { grown, name } = JSON.parse(result.stdout);
    assert.strictEqual(name, "x");
    assert.ok(
      grown < 256 * 1024 * 1024,
      `16 MB of text grew the process by ${Math.round(grown / 1048576)} MB`,
    );
  });
});
