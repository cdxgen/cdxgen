import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { assert, describe, it } from "poku";

import { dirNameStr } from "../ecosystems/utils.js";

const dataDir = join(dirNameStr, "data");

const SCHEMAS = [
  "bom-1.6.schema.json",
  "bom-1.7.schema.json",
  "jsf-0.82.schema.json",
  "spdx.schema.json",
  "cryptography-defs.schema.json",
];

const EXPECTED = {
  "bom-1.6.schema.json":
    "25dea08cd6f87451a8d2b3bf328e04d88cdb5ab149be0f3865f616900c28208b",
  "bom-1.7.schema.json":
    "df472ef4aaf593904c479293723a1a5c191d6672715c93b3c0b5c318f3914221",
  "cryptography-defs.schema.json":
    "018ea7f78b5208ec647cfd10f669cc9c26aba6aceb79c4da7f9c0ef4c99b60de",
  "jsf-0.82.schema.json":
    "679d39def1f9b4fddbaf5b2466862718a0299ea8190ac19cd9173a8e20a37527",
  "spdx.schema.json":
    "4b345e2329f209f34e960ae2a8e7cb46a166907e6a45e94978565925dc47b359",
};

/**
 * Hash a schema's *content*, independent of checkout line endings.
 *
 * Hashing the raw bytes makes this guard fail on Windows for a reason that has
 * nothing to do with drift: git checks these JSON files out with CRLF there, so
 * every hash differs (`bom-1.6.schema.json` hashes to 25dea08c… with LF and
 * b82391bf… with CRLF). Normalising first keeps the guard about what it is
 * supposed to catch — a schema diverging from its vendored copy in
 * cdxgen-plugins-bin — rather than about how the tree was checked out.
 *
 * Note the vendored side stores the same normalised digests in
 * `thirdparty/cdxrs/schemas/checksums.sha256`, so both must be regenerated
 * together when a schema legitimately changes.
 */
function sha256(filePath) {
  const normalized = readFileSync(filePath, "utf-8").replaceAll("\r\n", "\n");
  return createHash("sha256").update(normalized, "utf-8").digest("hex");
}

describe("schema drift guard (cdxgen data/ ↔ cdxrs schemas/)", () => {
  for (const name of SCHEMAS) {
    it(`${name} matches committed checksum`, () => {
      const actual = sha256(join(dataDir, name));
      assert.strictEqual(
        actual,
        EXPECTED[name],
        `${name} has drifted. Re-copy to cdxgen-plugins-bin/thirdparty/cdxrs/schemas/ and update both checksums.sha256 and this test.`,
      );
    });
  }
});
