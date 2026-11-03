import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { assert, it } from "poku";

import { setDryRunMode } from "../core/activity.js";
import { getTmpDir } from "../core/fs.js";
import { getAarClasses } from "./deps.js";

// Dry run mode is a process-wide flag, and the async tests of one file run
// concurrently, so this test has a file to itself. Other test files run in
// parallel and read aar files too, so the temporary directory is private to
// this file; otherwise their aar-classes-* directories show up in the count.
const privateTmpDir = mkdtempSync(path.join(tmpdir(), "cdxgen-aar-dry-run-"));
process.env.CDXGEN_TEMP_DIR = privateTmpDir;
process.on("exit", () => {
  rmSync(privateTmpDir, { recursive: true, force: true });
});

const supportV13Aar = path.resolve(
  "test",
  "data",
  "gradle-aar-cache",
  "modules-2",
  "files-2.1",
  "com.android.support",
  "support-v13",
  "23.0.1",
  "208b4644629446a334fae6a8c5fa7ade8b983ae6",
  "support-v13-23.0.1.aar",
);

const aarTempDirs = () =>
  readdirSync(getTmpDir()).filter((name) => name.startsWith("aar-classes-"));

it("getAarClasses writes nothing in dry run mode", async () => {
  assert.strictEqual(getTmpDir(), privateTmpDir);
  setDryRunMode(true);
  try {
    // Reading the inner jars needs a temporary copy, which a dry run blocks.
    assert.deepStrictEqual(await getAarClasses(supportV13Aar), []);
  } finally {
    setDryRunMode(false);
  }
  assert.deepStrictEqual(aarTempDirs(), []);
  // Outside a dry run the temporary directory is removed after the read.
  assert.strictEqual((await getAarClasses(supportV13Aar)).length, 20);
  assert.deepStrictEqual(aarTempDirs(), []);
});
