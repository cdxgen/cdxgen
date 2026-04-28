import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, describe, it } from "poku";

import { addFormulationSection } from "./formulationParsers.js";

function getProp(obj, name) {
  return obj?.properties?.find((property) => property.name === name)?.value;
}

describe("addFormulationSection()", () => {
  it("adds README file components when hidden Unicode is detected", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "cdxgen-formulation-"));
    writeFileSync(
      path.join(tmpDir, "README.md"),
      "# Demo\n<!-- hidden \u200B comment -->\nContent",
    );

    try {
      const result = addFormulationSection(tmpDir, { specVersion: 1.7 });
      const formulation = result.formulation[0];
      const readmeComponent = formulation.components.find(
        (component) => getProp(component, "cdx:file:kind") === "readme",
      );
      assert.ok(readmeComponent, "expected README formulation component");
      assert.strictEqual(
        getProp(readmeComponent, "cdx:file:hasHiddenUnicode"),
        "true",
      );
      assert.strictEqual(
        getProp(readmeComponent, "cdx:file:hiddenUnicodeInComments"),
        "true",
      );
      assert.match(
        getProp(readmeComponent, "cdx:file:hiddenUnicodeCodePoints"),
        /U\+200B/,
      );
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });
});
