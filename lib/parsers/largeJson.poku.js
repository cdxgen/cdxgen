import { constants } from "node:buffer";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "poku";

import {
  indexJsonObject,
  MAX_JSON_TEXT_BYTES,
  readJsonFile,
  readJsonMember,
  readJsonRange,
} from "./largeJson.js";

// Small enough that every array and object in the fixtures below goes through
// the streamed path, and chunk boundaries fall inside strings, escapes and
// multi-byte characters.
const SIZES = [
  { chunkBytes: 1, batchBytes: 1 },
  { chunkBytes: 3, batchBytes: 7 },
  { chunkBytes: 5, batchBytes: 64 },
  { chunkBytes: 64, batchBytes: 3 },
];
const streamed = (sizes) => ({ ...sizes, maxTextBytes: 0 });

const document = {
  Metadata: { Tool: "Dosai", SchemaVersion: "5.1.0", Nested: { Deep: [1] } },
  Strings: [
    "plain",
    'quote " inside',
    "backslash \\ and \\\\ pairs",
    'ends with backslash quote \\"',
    "brackets ] } [ { , : inside",
    "tab\tnewline\nreturn\r",
    "multi-byte: é ü 漢字 🎉 𝄞",
    "\u0000 control \u001f",
    "",
  ],
  Numbers: [0, -1, 3.25, -0.5e-7, 1e21, 123456789012],
  Literals: [true, false, null],
  Empty: { Array: [], Object: {} },
  Mixed: [[], {}, [[1, 2], [3]], { a: [{ b: null }] }, "s", 7, null],
  // Computed, so it is an own property as in parsed JSON.
  ["__proto__"]: { polluted: true },
  'key with "quotes" and \\': "value",
  Methods: Array.from({ length: 40 }, (_, i) => ({
    Id: `m${i}`,
    Name: `Method${i}`,
    Parameters: [{ Name: "x", Type: "int" }],
  })),
};

const withTempDir = (callback) => {
  const dir = mkdtempSync(join(tmpdir(), "cdxgen-large-json-"));
  try {
    return callback(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const writeJson = (dir, name, text) => {
  const file = join(dir, name);
  writeFileSync(file, text);
  return file;
};

describe("readJsonFile()", () => {
  it("decodes the same value as JSON.parse, compact or pretty-printed", () => {
    withTempDir((dir) => {
      for (const text of [
        JSON.stringify(document),
        JSON.stringify(document, null, 2),
        `\n\t ${JSON.stringify(document, null, "\t")}\r\n `,
      ]) {
        const file = writeJson(dir, "doc.json", text);
        const expected = JSON.parse(text);
        for (const sizes of SIZES) {
          const actual = readJsonFile(file, undefined, streamed(sizes));
          assert.deepStrictEqual(actual, expected, JSON.stringify(sizes));
          assert.ok(Object.hasOwn(actual, "__proto__"));
          assert.strictEqual(Object.getPrototypeOf(actual), Object.prototype);
        }
        assert.deepStrictEqual(readJsonFile(file), expected);
      }
    });
  });

  it("decodes top-level arrays and scalars", () => {
    withTempDir((dir) => {
      for (const value of [document.Mixed, [], "a string", -12.5, true, null]) {
        const file = writeJson(dir, "value.json", JSON.stringify(value));
        for (const sizes of SIZES) {
          assert.deepStrictEqual(
            readJsonFile(file, undefined, streamed(sizes)),
            value,
          );
        }
      }
    });
  });

  it("keeps the last value and first position of a repeated key, as JSON.parse does", () => {
    withTempDir((dir) => {
      const text =
        '{"a":[1,2,3,4,5,6,7,8],"b":{"x":1},"a":[9],"c":{"y":2,"y":[3]}}';
      const file = writeJson(dir, "dupes.json", text);
      for (const sizes of SIZES) {
        const actual = readJsonFile(file, undefined, streamed(sizes));
        assert.deepStrictEqual(actual, JSON.parse(text));
        assert.deepStrictEqual(Object.keys(actual), ["a", "b", "c"]);
      }
    });
  });

  it("applies members and filter specs the same way on both paths", () => {
    withTempDir((dir) => {
      const file = writeJson(dir, "doc.json", JSON.stringify(document));
      const spec = {
        members: {
          Metadata: undefined,
          Methods: { filter: (method) => method.Id.endsWith("7") },
          Empty: { members: { Array: undefined } },
          Missing: undefined,
        },
      };
      const expected = {
        Metadata: document.Metadata,
        Empty: { Array: [] },
        Methods: document.Methods.filter((method) => method.Id.endsWith("7")),
      };
      assert.deepStrictEqual(readJsonFile(file, spec), expected);
      for (const sizes of SIZES) {
        const actual = readJsonFile(file, spec, streamed(sizes));
        assert.deepStrictEqual(actual, expected);
        // Streamed members keep file order.
        assert.deepStrictEqual(Object.keys(actual), [
          "Metadata",
          "Empty",
          "Methods",
        ]);
      }
    });
  });

  it("rejects malformed JSON on the streamed path", () => {
    withTempDir((dir) => {
      for (const text of [
        '{"a":[1,2,]}',
        '{"a":[1 2]}',
        '{"a" 1}',
        '{"a":"unterminated}',
        '{"a":[1,2',
        '{"a":1,}',
        '{"a":1} trailing',
        '{"a":{"b":1,}}',
        "",
      ]) {
        const file = writeJson(dir, "bad.json", text);
        for (const sizes of SIZES) {
          assert.throws(
            () => readJsonFile(file, undefined, streamed(sizes)),
            SyntaxError,
            text,
          );
        }
      }
    });
  });
});

describe("indexJsonObject() and readJsonRange()", () => {
  it("returns the byte range of each member value", () => {
    withTempDir((dir) => {
      const text = JSON.stringify(document, null, 1);
      const file = writeJson(dir, "doc.json", text);
      const bytes = readFileSync(file);
      for (const { chunkBytes } of SIZES) {
        const index = indexJsonObject(file, { chunkBytes });
        assert.deepStrictEqual([...index.keys()], Object.keys(document));
        for (const [key, range] of index) {
          const expected = JSON.parse(text)[key];
          assert.deepStrictEqual(
            JSON.parse(bytes.subarray(range.start, range.end).toString()),
            expected,
          );
          for (const sizes of SIZES) {
            assert.deepStrictEqual(
              readJsonRange(file, range, undefined, sizes),
              expected,
            );
          }
        }
      }
    });
  });

  it("filters array elements by predicate without keeping the rest", () => {
    withTempDir((dir) => {
      const elements = Array.from({ length: 5000 }, (_, i) => ({
        Id: i,
        Label: `node ${i} "quoted" ü`,
      }));
      const file = writeJson(
        dir,
        "graph.json",
        JSON.stringify({ Graph: { Nodes: elements, Edges: [] } }),
      );
      const index = indexJsonObject(file, { chunkBytes: 4096 });
      const seen = [];
      const graph = readJsonRange(
        file,
        index.get("Graph"),
        {
          members: {
            Nodes: {
              filter: (node) => {
                seen.push(node.Id);
                return node.Id % 1000 === 0;
              },
            },
          },
        },
        { chunkBytes: 4096, batchBytes: 1024 },
      );
      assert.deepStrictEqual(graph, {
        Nodes: elements.filter((node) => node.Id % 1000 === 0),
      });
      assert.strictEqual(seen.length, elements.length);
    });
  });

  it("rejects a top-level value that is not an object", () => {
    withTempDir((dir) => {
      const file = writeJson(dir, "array.json", "[1,2]");
      assert.throws(() => indexJsonObject(file), SyntaxError);
    });
  });
});

describe("readJsonMember()", () => {
  it("decodes one member and reads no further than its end", () => {
    withTempDir((dir) => {
      const text = JSON.stringify(document, null, 1);
      // Everything after Metadata is cut off mid-value: a reader that went on
      // to scan the rest of the object would throw.
      const truncated = writeJson(
        dir,
        "truncated.json",
        `{"Metadata":${JSON.stringify(document.Metadata, null, 1)},"Methods":[{"Id":`,
      );
      const whole = writeJson(dir, "doc.json", text);
      for (const sizes of SIZES) {
        assert.deepStrictEqual(
          readJsonMember(truncated, "Metadata", sizes),
          document.Metadata,
        );
        assert.deepStrictEqual(
          readJsonMember(whole, "Numbers", sizes),
          document.Numbers,
        );
        assert.strictEqual(readJsonMember(whole, "Missing", sizes), undefined);
      }
      // A member that does not exist means reading to the end, which still
      // reports a malformed file.
      assert.throws(() => readJsonMember(truncated, "Missing"), SyntaxError);
    });
  });

  it("uses the runtime's string ceiling as the default whole-parse limit", () => {
    // 0x1fffffe8 on node and deno (V8); bun (JavaScriptCore) allows 2^31 - 1.
    assert.strictEqual(MAX_JSON_TEXT_BYTES, constants.MAX_STRING_LENGTH);
    assert.ok(MAX_JSON_TEXT_BYTES >= 0x1fffffe8);
  });
});

describe("readJsonFile() and files that are not regular", () => {
  it("refuses a device reached through a link", () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "cdxgen-json-device-"));
    try {
      // A device reports a size of zero, which bounds nothing.
      symlinkSync("/dev/null", join(dir, "compile_commands.json"));
      assert.throws(
        () => readJsonFile(join(dir, "compile_commands.json")),
        /not a regular file/,
      );
      writeFileSync(join(dir, "ok.json"), '{"a":1}');
      symlinkSync(join(dir, "ok.json"), join(dir, "linked.json"));
      assert.deepStrictEqual(readJsonFile(join(dir, "linked.json")), { a: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
