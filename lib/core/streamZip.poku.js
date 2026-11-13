import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { strict as assert, describe, it } from "poku";

import { closeZip, openZip } from "./streamZip.js";

// The smallest valid zip: an end of central directory record without entries.
const EMPTY_ZIP = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x05, 0x06]),
  Buffer.alloc(18),
]);

/**
 * Descriptors of this process that point into `dir`, where the platform lists
 * them.
 */
function descriptorsInto(dir) {
  if (!existsSync("/proc/self/fd")) {
    return 0;
  }
  return readdirSync("/proc/self/fd").filter((fd) => {
    try {
      return readlinkSync(join("/proc/self/fd", fd)).startsWith(dir);
    } catch (_err) {
      return false;
    }
  }).length;
}

describe("openZip() and closeZip()", () => {
  const dir = mkdtempSync(join(tmpdir(), "cdxgen-streamzip-poku-"));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

  it("release archives that could not be read", async () => {
    const emptyZip = join(dir, "empty.whl");
    const notZip = join(dir, "text.nupkg");
    writeFileSync(emptyZip, EMPTY_ZIP);
    writeFileSync(notZip, "not a zip archive\n");

    const empty = await openZip(emptyZip);
    assert.strictEqual(await empty.entriesCount, 0);
    await closeZip(empty);

    const broken = await openZip(notZip);
    await assert.rejects(broken.entries());
    await closeZip(broken);
    await closeZip(broken);

    assert.strictEqual(descriptorsInto(dir), 0);
  });

  it("does nothing for an archive that was never opened", async () => {
    await assert.rejects(openZip(join(dir, "missing.zip")));
    await closeZip(undefined);
  });
});
