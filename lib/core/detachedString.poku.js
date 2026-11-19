import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import { assert, describe, it } from "poku";

import { detachString, truncateDetached } from "./detachedString.js";

describe("detachString()", () => {
  it("returns an equal string, lone surrogates included", () => {
    assert.strictEqual(
      detachString("plain value of some length"),
      "plain value of some length",
    );
    assert.strictEqual(
      detachString("\ud800 and \udc00 alone"),
      "\ud800 and \udc00 alone",
    );
    assert.strictEqual(detachString(""), "");
    assert.strictEqual(detachString(undefined), undefined);
  });

  it("does not keep the text a value was cut from in memory", () => {
    // Bun runs JavaScriptCore, which has no V8 flags, and collects through
    // its own call.
    let collectGarbage;
    if (globalThis.Bun) {
      collectGarbage = () => globalThis.Bun.gc(true);
    } else {
      setFlagsFromString("--expose-gc");
      collectGarbage = runInNewContext("gc");
    }
    const kept = [];
    collectGarbage();
    const heapBefore = process.memoryUsage().heapUsed;
    for (let i = 0; i < 16; i++) {
      const text = `Summary: a value of package ${i}\n${"a".repeat(4 * 1024 * 1024)}`;
      kept.push(detachString(text.slice(0, text.indexOf("\n"))));
    }
    collectGarbage();
    const heapGrowth = process.memoryUsage().heapUsed - heapBefore;
    assert.strictEqual(kept[15], "Summary: a value of package 15");
    assert.ok(
      heapGrowth < 16 * 1024 * 1024,
      `heap growth of ${heapGrowth} bytes stays under 16 MiB for 64 MiB of text`,
    );
  });
});

describe("truncateDetached()", () => {
  it("cuts at the limit and leaves shorter text alone", () => {
    assert.strictEqual(truncateDetached("abcdef", 3), "abc");
    assert.strictEqual(truncateDetached("abc", 3), "abc");
    assert.strictEqual(truncateDetached(42, 3), 42);
  });
});
