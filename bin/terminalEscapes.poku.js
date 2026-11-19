import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { assert, describe, it } from "poku";

const binFor = (command) => join(process.cwd(), "bin", `${command}.js`);

// process.execPath, not argv0: Deno turns a spawn of its own executable with
// a script path into `deno run` with the parent's permissions.
const run = (args) =>
  spawnSync(process.execPath, args, { cwd: process.cwd(), encoding: "utf8" });

describe("cdx-validate and cdx-sign terminal output", () => {
  it("writes control characters from a document as escapes", () => {
    const dir = mkdtempSync(join(tmpdir(), "cdxgen-terminal-escapes-"));
    try {
      const input = join(dir, "bom.json");
      writeFileSync(input, '{"a": \u001b[2K\u001b[8m}');
      for (const command of ["validate", "sign"]) {
        const result = run([binFor(command), "-i", input]);
        assert.notStrictEqual(result.status, 0, `${command} must fail`);
        const output = `${result.stdout}${result.stderr}`;
        assert.ok(
          !output.includes("\u001b"),
          `${command} printed a raw escape character`,
        );
        assert.ok(output.includes("\\u001b"), `${command} shows the escape`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cdxgen config file warnings", () => {
  it("writes control characters from the config file as escapes", () => {
    const dir = mkdtempSync(join(tmpdir(), "cdxgen-config-escapes-"));
    try {
      writeFileSync(
        join(dir, ".cdxgenrc"),
        JSON.stringify({
          "metadata-property": [{ name: "cdx:x\r\u001b[2Kforged", value: "1" }],
          "unknown\u001b[8mkey": 1,
        }),
      );
      const result = spawnSync(
        process.execPath,
        [binFor("cdxgen"), "--version"],
        {
          cwd: dir,
          encoding: "utf8",
        },
      );
      const warnings = `${result.stdout}${result.stderr}`
        .split("\n")
        .filter((line) => line.includes("Config file"));
      assert.ok(warnings.length >= 2, warnings.join("\n"));
      for (const line of warnings) {
        // biome-ignore lint/suspicious/noControlCharactersInRegex: only cdxgen's own colour codes may remain.
        const withoutColour = line.replace(/\u001b\[[0-9;]*m/g, "");
        assert.ok(!withoutColour.includes("\u001b"), JSON.stringify(line));
        assert.ok(!withoutColour.includes("\r"), JSON.stringify(line));
      }
      assert.ok(warnings.join("\n").includes("\\u001b[2Kforged"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
