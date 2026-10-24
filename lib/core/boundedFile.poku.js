import { execFileSync } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "poku";

import {
  openRegularFile,
  readRegularTextFile,
  scanFileMarkers,
} from "./boundedFile.js";

const CHUNK = 1024 * 1024;

function withWork(fn) {
  const work = mkdtempSync(join(tmpdir(), "cdxgen-boundedfile-"));
  try {
    return fn(work);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

describe("openRegularFile()", () => {
  it("opens a regular file inside the root and refuses everything else", () => {
    withWork((work) => {
      const root = join(work, "root");
      mkdirSync(root);
      writeFileSync(join(root, "inside"), "data");
      writeFileSync(join(work, "outside"), "secret");
      const opened = openRegularFile(join(root, "inside"), root);
      assert.ok(opened, "a regular file inside the root opens");
      assert.strictEqual(opened.size, 4);
      closeSync(opened.fd);
      assert.strictEqual(
        openRegularFile(join(root, "missing"), root),
        undefined,
      );
      assert.strictEqual(openRegularFile(root, root), undefined, "directory");
      assert.strictEqual(openRegularFile("", root), undefined);
      try {
        symlinkSync(join(work, "outside"), join(root, "escape"));
        assert.strictEqual(
          openRegularFile(join(root, "escape"), root),
          undefined,
          "a symlink is never followed",
        );
      } catch (err) {
        if (err.code !== "EPERM") {
          throw err;
        }
      }
    });
  });

  it("does not open a FIFO", () => {
    if (process.platform === "win32") {
      return;
    }
    withWork((work) => {
      execFileSync("mkfifo", [join(work, "fifo")]);
      assert.strictEqual(openRegularFile(join(work, "fifo"), work), undefined);
    });
  });
});

describe("scanFileMarkers()", () => {
  it("finds a marker split across the read boundary, with its context", () => {
    withWork((work) => {
      const file = join(work, "big.bin");
      const buffer = Buffer.alloc(CHUNK * 2 + 100, 0x41);
      // MARKER straddles the first 1 MiB window edge.
      buffer.write("\0MARKER:1.2.3\0", CHUNK - 4, "latin1");
      writeFileSync(file, buffer);
      const {
        hits: [hits],
      } = scanFileMarkers(file, work, [Buffer.from("MARKER:")], {
        beforeBytes: 4,
        contextBytes: 5,
      });
      assert.strictEqual(hits.length, 1, "seen once, not once per window");
      assert.strictEqual(hits[0].offset, CHUNK - 3);
      assert.strictEqual(hits[0].after.toString("latin1"), "1.2.3");
      assert.deepStrictEqual(
        [...hits[0].before],
        [0x41, 0x41, 0x41, 0x00],
        "the bytes before come from the previous window",
      );
    });
  });

  it("keeps the bytes before a hit that starts a new window", () => {
    withWork((work) => {
      const file = join(work, "edge.bin");
      const buffer = Buffer.alloc(CHUNK + 64, 0x42);
      buffer.write("ab", CHUNK - 2, "latin1");
      buffer.write("TOKEN", CHUNK, "latin1");
      writeFileSync(file, buffer);
      const {
        hits: [hits],
      } = scanFileMarkers(file, work, [Buffer.from("TOKEN")], {
        beforeBytes: 2,
      });
      assert.strictEqual(hits.length, 1);
      assert.strictEqual(hits[0].before.toString("latin1"), "ab");
    });
  });

  it("returns empty hits for an empty file and nothing over the cap", () => {
    withWork((work) => {
      writeFileSync(join(work, "empty"), "");
      writeFileSync(join(work, "small"), "xxMARKERyy");
      assert.deepStrictEqual(
        scanFileMarkers(join(work, "empty"), work, [Buffer.from("MARKER")]),
        { hits: [[]], size: 0 },
      );
      assert.deepStrictEqual(
        scanFileMarkers(join(work, "small"), work, [Buffer.from("MARKER")], {
          maxBytes: 4,
        }),
        { hits: [[]], size: 10, skipped: "too-large" },
        "a file over the cap is skipped whole, never read in part",
      );
      assert.strictEqual(
        scanFileMarkers(join(work, "small"), work, []),
        undefined,
      );
    });
  });

  it("caps the hits kept per marker", () => {
    withWork((work) => {
      writeFileSync(join(work, "many"), "M,".repeat(100));
      const {
        hits: [hits],
      } = scanFileMarkers(join(work, "many"), work, [Buffer.from("M")], {
        maxHits: 3,
      });
      assert.strictEqual(hits.length, 3);
    });
  });
});

describe("readRegularTextFile()", () => {
  it("reads a small regular file and nothing else", () => {
    withWork((work) => {
      writeFileSync(join(work, "vcpkg.json"), '{"name":"x"}');
      assert.strictEqual(
        readRegularTextFile(join(work, "vcpkg.json"), 1024, work),
        '{"name":"x"}',
      );
      assert.strictEqual(
        readRegularTextFile(join(work, "vcpkg.json"), 4, work),
        undefined,
        "over the cap",
      );
      assert.strictEqual(readRegularTextFile(work, 1024), undefined);
      if (process.platform !== "win32") {
        execFileSync("mkfifo", [join(work, "fifo.wrap")]);
        assert.strictEqual(
          readRegularTextFile(join(work, "fifo.wrap"), 1024, work),
          undefined,
          "a FIFO is never opened, so the read cannot block",
        );
      }
    });
  });
});
