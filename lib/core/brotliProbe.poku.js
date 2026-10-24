import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "poku";

import { readBrotliDecoder } from "./brotliProbe.js";

// Every byte layout below is built here. Each mirrors how a real build stores
// the decoder's error names, as read from the binaries of the corpus this was
// developed against: Node.js 24.22.0 and 24.22.1, the Brotli and brotlicffi
// wheels, Debian bookworm's libbrotli1 1.0.9-2+b6 and +deb12u1, the PHP and
// Ruby extensions, .NET 8.0.32 and andybalholm/brotli v1.2.6 and v1.2.7.
const NUL = "\0";
const UPSTREAM_ERRORS = [
  "_ERROR_FORMAT_EXUBERANT_NIBBLE",
  "_ERROR_FORMAT_RESERVED",
  "_ERROR_FORMAT_EXUBERANT_META_NIBBLE",
];
const GO_MAGIC = "\xff Go buildinf:";

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

describe("readBrotliDecoder()", () => {
  it("reads an upstream C decoder without and with the fix", () => {
    withFile(cStrings(UPSTREAM_ERRORS), (file, root) => {
      assert.deepStrictEqual(readBrotliDecoder(file, root), {
        blockSwitchFix: false,
        port: "c",
      });
    });
    withFile(
      cStrings([...UPSTREAM_ERRORS, "_ERROR_FORMAT_BLOCK_SWITCH"]),
      (file, root) => {
        assert.deepStrictEqual(readBrotliDecoder(file, root), {
          blockSwitchFix: true,
          port: "c",
        });
      },
    );
  });

  it("reads a Debian-style backport that keeps the bare names", () => {
    // 1.0.9 stores the names without the _ERROR_FORMAT_ prefix.
    withFile(cStrings(["EXUBERANT_NIBBLE", "RESERVED"]), (file) => {
      assert.strictEqual(readBrotliDecoder(file).blockSwitchFix, false);
    });
    withFile(
      cStrings(["EXUBERANT_NIBBLE", "RESERVED", "BLOCK_SWITCH"]),
      (file) => {
        assert.strictEqual(readBrotliDecoder(file).blockSwitchFix, true);
      },
    );
  });

  it("does not take an embedded BLOCK_SWITCH in a C file for the fix", () => {
    withFile(
      `${cStrings(UPSTREAM_ERRORS)}STATE_BLOCK_SWITCHING${NUL}`,
      (file) => {
        assert.strictEqual(readBrotliDecoder(file).blockSwitchFix, false);
      },
    );
  });

  it("reads the Go port from its undelimited string table", () => {
    const table = "BLOCK_TYPE_TREESEXUBERANT_NIBBLENEEDS_MORE_INPUT";
    withFile(`${GO_MAGIC}${NUL.repeat(16)}${table}`, (file) => {
      assert.deepStrictEqual(readBrotliDecoder(file), {
        blockSwitchFix: false,
        port: "go",
      });
    });
    // Go sorts its strings by length, so the fix name lands far from the rest.
    withFile(
      `${GO_MAGIC}${NUL.repeat(16)}${table}${"x".repeat(4000)}PADDING_2BLOCK_SWITCHSTREAM`,
      (file) => {
        assert.deepStrictEqual(readBrotliDecoder(file), {
          blockSwitchFix: true,
          port: "go",
        });
      },
    );
  });

  it("ignores the Node.js zlib constant names, which a shared-brotli build carries", () => {
    withFile(
      cStrings([
        "BROTLI_DECODER_ERROR_FORMAT_EXUBERANT_NIBBLE",
        "BROTLI_DECODER_ERROR_FORMAT_RESERVED",
      ]),
      (file) => {
        assert.strictEqual(readBrotliDecoder(file), undefined);
      },
    );
  });

  it("does not take a fixed constant table for a fixed decoder", () => {
    withFile(
      cStrings([
        ...UPSTREAM_ERRORS,
        "BROTLI_DECODER_ERROR_FORMAT_EXUBERANT_NIBBLE",
        "BROTLI_DECODER_ERROR_FORMAT_BLOCK_SWITCH",
      ]),
      (file) => {
        assert.strictEqual(readBrotliDecoder(file).blockSwitchFix, false);
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
