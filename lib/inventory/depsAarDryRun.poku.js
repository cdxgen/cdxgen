import { readdirSync } from "node:fs";
import path from "node:path";

import { assert, it } from "poku";

import { setDryRunMode } from "../core/activity.js";
import { getTmpDir } from "../core/fs.js";
import { getAarClasses } from "./deps.js";

// Dry run mode is a process-wide flag, and the async tests of one file run
// concurrently, so this test has a file to itself.

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
  const before = aarTempDirs();
  setDryRunMode(true);
  try {
    // Reading the inner jars needs a temporary copy, which a dry run blocks.
    assert.deepStrictEqual(await getAarClasses(supportV13Aar), []);
  } finally {
    setDryRunMode(false);
  }
  assert.deepStrictEqual(aarTempDirs(), before);
  // Outside a dry run the temporary directory is removed after the read.
  assert.strictEqual((await getAarClasses(supportV13Aar)).length, 20);
  assert.deepStrictEqual(aarTempDirs(), before);
});
