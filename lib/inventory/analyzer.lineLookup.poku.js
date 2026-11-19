import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { assert, describe, it } from "poku";

import { findJSImportsExports } from "./analyzer.js";

// Kept apart from analyzer.poku.js: the async tests there share one event loop,
// so elapsed time measured inside one of them includes the others.
describe("findJSImportsExports() source positions", () => {
  it("locates many style and rune matches behind many lines without re-splitting the file", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "cdxgen-line-lookup-"));
    try {
      const emptyLines = "\n".repeat(100000);
      for (const [fileName, content] of Object.entries({
        "angular.json": "{}",
        "src/main.ts":
          "import { bootstrapApplication } from '@angular/platform-browser';\n",
        "src/styles.scss": `${emptyLines}${"@use 'bootstrap/a'; ".repeat(10000)}\n`,
        "src/App.svelte": `<script>${emptyLines}${"$state(1); ".repeat(10000)}</script>\n`,
        "src/store.svelte.js": `${emptyLines}${"$state(1); ".repeat(10000)}\n`,
      })) {
        mkdirSync(dirname(join(projectDir, fileName)), { recursive: true });
        writeFileSync(join(projectDir, fileName), content);
      }
      const start = Date.now();
      const { allImports } = await findJSImportsExports(projectDir, false);
      const elapsed = Date.now() - start;
      for (const [packageName, fileName, matchLength] of [
        ["bootstrap", "src/styles.scss", 20],
        ["svelte", "src/App.svelte", 11],
        ["svelte", "src/store.svelte.js", 11],
      ]) {
        const occurrences = Array.from(allImports[packageName] || []).filter(
          (occurrence) =>
            occurrence.fileName.replaceAll("\\", "/") === fileName &&
            occurrence.lineNumber === 100001,
        );
        assert.strictEqual(occurrences.length, 10000, fileName);
        assert.strictEqual(
          occurrences.at(-1).columnNumber,
          9999 * matchLength,
          fileName,
        );
      }
      assert.ok(elapsed < 10000, `expected a quick scan, took ${elapsed}ms`);
    } finally {
      rmSync(projectDir, { force: true, recursive: true });
    }
  });
});
