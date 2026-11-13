import { assert, describe, it } from "poku";

import {
  alignText,
  escapeControlCharacters,
  isFullWidthCodePoint,
  splitAnsiTokens,
  stringWidth,
  stripAnsi,
  wrapLineByChars,
  wrapLineByWords,
} from "./text.js";

describe("text helpers", () => {
  it("escapeControlCharacters writes control and line-break characters as escapes", () => {
    assert.strictEqual(
      escapeControlCharacters("a\u001b[2K\r\n\t\u0085\u2028b ✓"),
      "a\\u001b[2K\\u000d\\u000a\\u0009\\u0085\\u2028b ✓",
    );
    assert.strictEqual(escapeControlCharacters(undefined), "");
  });

  it("stripAnsi removes escape sequences", () => {
    assert.strictEqual(stripAnsi("\x1b[1;35mabc\x1b[0m"), "abc");
    assert.strictEqual(stripAnsi(undefined), "");
  });

  it("stringWidth measures visible cells", () => {
    assert.strictEqual(stringWidth("abc"), 3);
    assert.strictEqual(stringWidth("\x1b[1mab\x1b[0m"), 2);
    assert.strictEqual(stringWidth("a\nb"), 2);
  });

  it("stringWidth counts full-width code points as two cells", () => {
    assert.strictEqual(stringWidth("中"), 2);
    assert.ok(isFullWidthCodePoint("中".codePointAt(0)));
    assert.ok(!isFullWidthCodePoint("a".codePointAt(0)));
  });

  it("alignText pads left, right, and center", () => {
    assert.strictEqual(alignText("ab", 5), "ab   ");
    assert.strictEqual(alignText("ab", 5, "right"), "   ab");
    assert.strictEqual(alignText("ab", 6, "center"), "  ab  ");
    assert.strictEqual(alignText("abcdef", 3), "abcdef");
  });

  it("splitAnsiTokens preserves escape sequences as tokens", () => {
    const tokens = splitAnsiTokens("\x1b[1mab\x1b[0m");
    assert.strictEqual(tokens.length, 3);
    assert.strictEqual(tokens[0].isAnsi, true);
    assert.strictEqual(tokens[1].value, "ab");
    assert.strictEqual(tokens[2].isAnsi, true);
  });

  it("wrapLineByChars chunks to a width keeping ANSI attached", () => {
    const wrapped = wrapLineByChars("\x1b[1mabcdef\x1b[0m", 4);
    assert.strictEqual(wrapped.length, 2);
    assert.ok(wrapped[0].includes("abcd"));
    assert.ok(wrapped[1].includes("ef"));
  });

  it("wrapLineByWords wraps on word boundaries", () => {
    const wrapped = wrapLineByWords("the quick brown fox", 10);
    for (const line of wrapped) {
      assert.ok(stringWidth(line) <= 10);
    }
    assert.ok(wrapped.length > 1);
  });

  it("returns the input unchanged when it already fits", () => {
    assert.deepStrictEqual(wrapLineByChars("ab", 5), ["ab"]);
    assert.deepStrictEqual(wrapLineByWords("ab", 5), ["ab"]);
    assert.deepStrictEqual(wrapLineByChars("", 5), [""]);
  });
});
