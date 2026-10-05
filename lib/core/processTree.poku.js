import process from "node:process";

import { assert, it } from "poku";

import { formatDuration, reapProcessTree } from "./processTree.js";

it("formatDuration() reads seconds below a minute and minutes from there", () => {
  assert.strictEqual(formatDuration(1500), "1.5 seconds");
  assert.strictEqual(formatDuration(59_000), "59 seconds");
  assert.strictEqual(formatDuration(60_000), "1 minute");
  assert.strictEqual(formatDuration(90_000), "1.5 minutes");
  assert.strictEqual(formatDuration(1_200_000), "20 minutes");
});

it("reapProcessTree() stops nothing for an invalid pid", () => {
  assert.deepStrictEqual(reapProcessTree(undefined, Date.now()), []);
  assert.deepStrictEqual(reapProcessTree(0, Date.now()), []);
  assert.deepStrictEqual(reapProcessTree(-1, Date.now()), []);
});

it("reapProcessTree() does nothing outside Windows", () => {
  if (process.platform === "win32") {
    return;
  }
  assert.deepStrictEqual(reapProcessTree(process.pid, Date.now()), []);
});
