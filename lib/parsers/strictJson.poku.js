import { strict as assert, describe, it } from "poku";

import { parseStrictJson, StrictJsonError } from "./strictJson.js";

const rejects = (text, pattern) =>
  assert.throws(
    () => parseStrictJson(text),
    (err) => err instanceof StrictJsonError && pattern.test(err.message),
  );

describe("parseStrictJson()", () => {
  it("returns what JSON.parse returns for conforming text", () => {
    const text = JSON.stringify({
      bomFormat: "CycloneDX",
      version: 1,
      components: [{ name: "a", score: 9.8, nested: [[], {}, [1, 2.5]] }],
      empty: {},
      text: 'quote " backslash \\ astral 𝔘',
      flags: [true, false, null],
    });
    assert.deepStrictEqual(parseStrictJson(text), JSON.parse(text));
  });

  it("raises SyntaxError for text that is not JSON", () => {
    assert.throws(() => parseStrictJson("{"), SyntaxError);
    assert.throws(() => parseStrictJson("{'a':1}"), SyntaxError);
  });

  it("rejects a repeated member name and points at it", () => {
    let caught;
    try {
      parseStrictJson('{"components":[{"name":"evil"}],"components":[]}');
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof StrictJsonError);
    assert.strictEqual(caught.pointer, "/components");
    assert.match(caught.message, /Duplicate member name at \/components/);
  });

  it("compares member names after unescaping", () => {
    rejects('{"a":1,"\\u0061":2}', /Duplicate member name at \/a/);
    rejects('{"\\/":1,"/":2}', /Duplicate member name at \/~1/);
  });

  it("finds repeated names in nested objects and builds JSON Pointers", () => {
    let caught;
    try {
      parseStrictJson('{"a/b":[0,{"x~y":{"k":1,"k":2}}]}');
    } catch (err) {
      caught = err;
    }
    assert.strictEqual(caught.pointer, "/a~1b/1/x~0y/k");
  });

  it("allows the same name in sibling and nested objects", () => {
    const text =
      '{"name":"a","child":{"name":"b"},"list":[{"name":1},{"name":2}]}';
    assert.deepStrictEqual(parseStrictJson(text), JSON.parse(text));
  });

  it("keeps an own __proto__ member and checks it like any other name", () => {
    const value = parseStrictJson('{"__proto__":{"x":1},"a":1}');
    assert.deepStrictEqual(Object.keys(value), ["__proto__", "a"]);
    rejects(
      '{"__proto__":1,"__proto__":2}',
      /Duplicate member name at \/__proto__/,
    );
  });

  it("does not treat a string value as a member name", () => {
    const text = '{"a":"a","b":["a","a"],"c":{"a":"b"}}';
    assert.deepStrictEqual(parseStrictJson(text), JSON.parse(text));
  });

  it("rejects integers a double cannot hold exactly", () => {
    let caught;
    try {
      parseStrictJson('{"version":9007199254740993}');
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof StrictJsonError);
    assert.strictEqual(caught.pointer, "/version");
    assert.match(caught.message, /reads it as 9007199254740992/);
    rejects("[123456789012345678901234567890]", /\/0/);
  });

  it("rejects fractions with more precision than a double", () => {
    rejects('{"score":1.0000000000000001}', /reads it as 1\b/);
    rejects('{"x":0.1000000000000000055511151231257827}', /\/x/);
  });

  it("rejects numbers outside the range of a double", () => {
    rejects('{"a":1e999}', /outside the range/);
    rejects('{"a":-1e999}', /outside the range/);
    rejects('{"a":1e-400}', /reads it as 0/);
  });

  it("accepts every spelling of an exactly representable number", () => {
    for (const text of [
      "0",
      "-0",
      "0.0",
      "-0.0e5",
      "0e999999999999999999",
      "1",
      "1.0",
      "1.50",
      "1e2",
      "1E+2",
      "100e-2",
      "0.1",
      "9.8",
      "-273.15",
      "5e-324",
      "1.7976931348623157e308",
      "9007199254740992",
      "-9007199254740991",
      "1e21",
      "100000000000000000000000",
      "123456789012345",
    ]) {
      assert.strictEqual(parseStrictJson(text), JSON.parse(text), text);
    }
  });

  it("reports the root for a bare number", () => {
    rejects("9007199254740993", /at the document root/);
  });

  it("checks deeply nested documents without recursion", () => {
    const depth = 200000;
    const nested = `${"[".repeat(depth)}1${"]".repeat(depth)}`;
    assert.doesNotThrow(() => parseStrictJson(nested));
    const objects = `${'{"a":'.repeat(depth)}1${"}".repeat(depth)}`;
    assert.doesNotThrow(() => parseStrictJson(objects));
    const deepDuplicate = `${'{"a":'.repeat(1000)}{"k":1,"k":2}${"}".repeat(1000)}`;
    rejects(deepDuplicate, /Duplicate member name at (\/a){1000}\/k/);
  });

  it("handles escapes at the end of strings", () => {
    const text = '{"a\\\\":"b\\\\","c\\"":"\\""}';
    assert.deepStrictEqual(parseStrictJson(text), JSON.parse(text));
    rejects('{"a\\\\":1,"a\\u005c":2}', /Duplicate member name/);
  });

  it("checks a multi-megabyte BOM in linear time", () => {
    const bom = {
      bomFormat: "CycloneDX",
      components: Array.from({ length: 20000 }, (_, i) => ({
        name: `pkg${i}`,
        version: `1.0.${i}`,
        score: i / 7,
        description: "x".repeat(100),
      })),
    };
    const text = JSON.stringify(bom);
    const started = performance.now();
    parseStrictJson(text);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 5000, `took ${elapsed} ms for ${text.length} bytes`);
  });
});

describe("parseStrictJson() on raw bytes and surrogates", () => {
  it("decodes UTF-8 bytes and refuses invalid UTF-8", () => {
    assert.deepStrictEqual(parseStrictJson(Buffer.from('{"a":"é𝔘"}')), {
      a: "é𝔘",
    });
    for (const bytes of [
      [0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d],
      [0x22, 0xed, 0xa0, 0x80, 0x22],
      [0x22, 0xc0, 0xaf, 0x22],
    ]) {
      assert.throws(
        () => parseStrictJson(Buffer.from(bytes)),
        (err) =>
          err instanceof StrictJsonError && /not valid UTF-8/.test(err.message),
      );
    }
  });

  it("keeps a leading byte order mark, which JSON.parse refuses", () => {
    assert.throws(() => parseStrictJson(Buffer.from("﻿{}")), SyntaxError);
  });

  it("refuses unpaired surrogates in strings and member names", () => {
    rejects(
      '{"a":"\\ud800"}',
      /string at \/a holds an unpaired UTF-16 surrogate/,
    );
    rejects('{"a":"\\udc00x"}', /string at \/a/);
    rejects('["\\ud800\\ud800"]', /string at \/0/);
    rejects('["\\ud83d\\\\"]', /string at \/0/);
    rejects('{"\\ud800":1}', /member name at \//);
    rejects('"\\udfff"', /at the document root/);
    rejects('["\uD800"]', /string at \/0/);
  });

  it("accepts paired surrogates written raw or escaped", () => {
    for (const text of [
      '"\\ud83d\\ude00"',
      '"😀"',
      '"\\\\ud800"',
      '{"\\ud835\\udd18":"\\ud835\\udd18"}',
    ]) {
      assert.deepStrictEqual(parseStrictJson(text), JSON.parse(text), text);
    }
  });
});
