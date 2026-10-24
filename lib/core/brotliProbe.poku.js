import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "poku";

import { readBrotliDecoder } from "./brotliProbe.js";

// Every byte layout below is built here. Each mirrors how a real build stores
// the decoder's error names and tables, as read from Node.js 24.22.0 and
// 24.22.1, the Brotli and brotlicffi wheels, Debian bookworm's libbrotli1
// 1.0.9-2+b6 and +deb12u1, the PHP and Ruby extensions, .NET 8.0.32,
// andybalholm/brotli v1.2.6 and v1.2.7, brotli-decompressor 5.0.3, and brotli
// 1.2.0 linked with --gc-sections, LTO and -dead_strip.
const NUL = "\0";
const UPSTREAM_ERRORS = [
  "_ERROR_FORMAT_EXUBERANT_NIBBLE",
  "_ERROR_FORMAT_RESERVED",
  "_ERROR_FORMAT_EXUBERANT_META_NIBBLE",
];
const GO_MAGIC = "\xff Go buildinf:";
// kCodeLengthCodeOrder and kCodeLengthPrefixValue, c/dec/decode.c.
const ORDER = String.fromCharCode(
  1,
  2,
  3,
  4,
  0,
  5,
  17,
  6,
  16,
  7,
  8,
  9,
  10,
  11,
  12,
  13,
  14,
  15,
);
const PREFIX_VALUE = String.fromCharCode(
  0,
  4,
  3,
  2,
  0,
  4,
  3,
  1,
  0,
  4,
  3,
  2,
  0,
  4,
  3,
  5,
);
const TABLES = `${ORDER}\x90\x90${PREFIX_VALUE}`;

function withFile(content, fn) {
  const work = mkdtempSync(join(tmpdir(), "cdxgen-brotliprobe-"));
  try {
    const file = join(work, "subject");
    const filler = Buffer.alloc(512, 0x90);
    writeFileSync(
      file,
      Buffer.concat([filler, Buffer.from(content, "latin1"), filler]),
    );
    return fn(file, work);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function cStrings(names) {
  return `${NUL}${names.join(NUL)}${NUL}`;
}

const decoders = (result) => result && { c: result.c, go: result.go };

describe("readBrotliDecoder()", () => {
  it("reads an upstream C decoder without and with the fix", () => {
    withFile(`${TABLES}${cStrings(UPSTREAM_ERRORS)}`, (file, root) => {
      assert.deepStrictEqual(decoders(readBrotliDecoder(file, root)), {
        c: { blockSwitchFix: "false", evidence: "error-names" },
        go: undefined,
      });
    });
    withFile(
      `${TABLES}${cStrings([...UPSTREAM_ERRORS, "_ERROR_FORMAT_BLOCK_SWITCH"])}`,
      (file, root) => {
        assert.strictEqual(
          readBrotliDecoder(file, root).c.blockSwitchFix,
          "true",
        );
      },
    );
  });

  it("reads a Debian-style backport that keeps the bare names", () => {
    withFile(cStrings(["EXUBERANT_NIBBLE", "RESERVED"]), (file) => {
      assert.strictEqual(readBrotliDecoder(file).c.blockSwitchFix, "false");
    });
    withFile(
      cStrings(["EXUBERANT_NIBBLE", "RESERVED", "BLOCK_SWITCH"]),
      (file) => {
        assert.strictEqual(readBrotliDecoder(file).c.blockSwitchFix, "true");
      },
    );
  });

  it("does not take an embedded BLOCK_SWITCH in a C file for the fix", () => {
    withFile(
      `${cStrings(UPSTREAM_ERRORS)}STATE_BLOCK_SWITCHING${NUL}`,
      (file) => {
        assert.strictEqual(readBrotliDecoder(file).c.blockSwitchFix, "false");
      },
    );
  });

  it("finds a decoder whose error names the linker dropped, by its tables", () => {
    withFile(`${TABLES}${cStrings(["unrelated", "strings"])}`, (file) => {
      assert.deepStrictEqual(decoders(readBrotliDecoder(file)), {
        c: { blockSwitchFix: "unknown", evidence: "tables" },
        go: undefined,
      });
    });
    // The encoder keeps the code-length order but not the prefix values.
    withFile(`${ORDER}${cStrings(["encoder only"])}`, (file) => {
      assert.strictEqual(readBrotliDecoder(file), undefined);
    });
  });

  it("reads a decoder whose names were merged into Node's constant table", () => {
    // lld -O2 and lld-link /OPT:ICF store _ERROR_FORMAT_EXUBERANT_NIBBLE as the
    // tail of BROTLI_DECODER_ERROR_FORMAT_EXUBERANT_NIBBLE.
    const constants = (names) =>
      cStrings(names.map((name) => `BROTLI_DECODER_ERROR_FORMAT_${name}`));
    withFile(
      `${TABLES}${constants(["EXUBERANT_NIBBLE", "RESERVED"])}`,
      (file) => {
        assert.deepStrictEqual(readBrotliDecoder(file).c, {
          blockSwitchFix: "false",
          evidence: "constant-names",
        });
      },
    );
    withFile(
      `${TABLES}${constants(["EXUBERANT_NIBBLE", "BLOCK_SWITCH"])}`,
      (file) => {
        assert.strictEqual(readBrotliDecoder(file).c.blockSwitchFix, "true");
      },
    );
  });

  it("ignores the Node.js constant table when no decoder is beside it", () => {
    // A Node.js linked to a shared libbrotlidec carries only the constants.
    withFile(
      cStrings([
        "BROTLI_DECODER_ERROR_FORMAT_EXUBERANT_NIBBLE",
        "BROTLI_DECODER_ERROR_FORMAT_BLOCK_SWITCH",
      ]),
      (file) => {
        assert.strictEqual(readBrotliDecoder(file), undefined);
      },
    );
  });

  it("does not take a fixed constant table for a fixed decoder", () => {
    withFile(
      `${TABLES}${cStrings([
        ...UPSTREAM_ERRORS,
        "BROTLI_DECODER_ERROR_FORMAT_EXUBERANT_NIBBLE",
        "BROTLI_DECODER_ERROR_FORMAT_BLOCK_SWITCH",
      ])}`,
      (file) => {
        assert.strictEqual(readBrotliDecoder(file).c.blockSwitchFix, "false");
      },
    );
  });

  it("reads the Go port from its undelimited string table", () => {
    const table = "BLOCK_TYPE_TREESEXUBERANT_NIBBLENEEDS_MORE_INPUT";
    withFile(`${GO_MAGIC}${NUL.repeat(16)}${TABLES}${table}`, (file) => {
      assert.deepStrictEqual(decoders(readBrotliDecoder(file)), {
        c: undefined,
        go: { blockSwitchFix: "false" },
      });
    });
    // Go sorts its strings by length, so the fix name lands far from the rest.
    withFile(
      `${GO_MAGIC}${NUL.repeat(16)}${table}${"x".repeat(4000)}PADDING_2BLOCK_SWITCHSTREAM`,
      (file) => {
        assert.deepStrictEqual(readBrotliDecoder(file).go, {
          blockSwitchFix: "true",
        });
      },
    );
  });

  it("keeps a cgo-linked C decoder and the Go port apart in one binary", () => {
    const goTable =
      "BLOCK_TYPE_TREESEXUBERANT_NIBBLENEEDS_MORE_INPUTPADDING_2BLOCK_SWITCHSTREAM";
    withFile(
      `${GO_MAGIC}${NUL.repeat(16)}${TABLES}${cStrings(UPSTREAM_ERRORS)}${goTable}`,
      (file) => {
        assert.deepStrictEqual(decoders(readBrotliDecoder(file)), {
          c: { blockSwitchFix: "false", evidence: "error-names" },
          go: { blockSwitchFix: "true" },
        });
      },
    );
    // A Go binary that only links the C decoder has no Go port.
    withFile(
      `${GO_MAGIC}${NUL.repeat(16)}${TABLES}${cStrings(UPSTREAM_ERRORS)}`,
      (file) => {
        assert.deepStrictEqual(decoders(readBrotliDecoder(file)), {
          c: { blockSwitchFix: "false", evidence: "error-names" },
          go: undefined,
        });
      },
    );
  });

  it("ignores the Rust port, which is not affected", () => {
    withFile(
      cStrings([
        "ERROR_FORMAT_EXUBERANT_NIBBLE",
        "ERROR_FORMAT_EXUBERANT_META_NIBBLE",
      ]),
      (file) => {
        assert.strictEqual(readBrotliDecoder(file), undefined);
      },
    );
    // Its tables are the same as the C decoder's; its crate name marks it.
    withFile(
      `${TABLES}${cStrings(["_ZN19brotli_decompressor6decode15ReadHuffmanCode17h0123456789abcdefE"])}`,
      (file) => {
        assert.strictEqual(readBrotliDecoder(file), undefined);
      },
    );
  });

  it("does not search bytes a previous read left in the buffer", () => {
    const work = mkdtempSync(join(tmpdir(), "cdxgen-brotliprobe-"));
    try {
      // The file ends 200 bytes past the 1 MiB edge, so the second read is
      // short and the buffer still holds the first read past byte 200. The
      // file's last bytes, "\0_ERROR_FORMAT_EXUBERANT_", meet the stale
      // "NIBBLE" the first read left at offset 200: a decoder name the file
      // does not contain.
      const chunk = 1024 * 1024;
      const tail = "\0_ERROR_FORMAT_EXUBERANT_";
      const buffer = Buffer.alloc(chunk + 200, 0x41);
      buffer.write("NIBBLE\0", 200, "latin1");
      buffer.write(tail, chunk + 200 - tail.length, "latin1");
      const file = join(work, "subject");
      writeFileSync(file, buffer);
      assert.strictEqual(readBrotliDecoder(file), undefined);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("returns nothing for a file without a decoder or that cannot be read", () => {
    withFile(cStrings(["BrotliDecoderDecompressStream"]), (file, root) => {
      assert.strictEqual(
        readBrotliDecoder(file, root),
        undefined,
        "an imported symbol name is no decoder",
      );
      assert.strictEqual(
        readBrotliDecoder(join(root, "missing"), root),
        undefined,
      );
    });
  });
});
