import { assert, describe, it } from "poku";

import {
  createOutputPlan,
  deriveCycloneDxOutputPath,
  deriveSpdxOutputPath,
  normalizeOutputFormats,
} from "./exportUtils.js";

describe("exportUtils", () => {
  it("normalizes comma-separated export formats", () => {
    assert.deepStrictEqual(normalizeOutputFormats("cyclonedx,spdx-json"), [
      "cyclonedx",
      "spdx",
    ]);
  });

  it("normalizes repeated format flags", () => {
    assert.deepStrictEqual(normalizeOutputFormats(["cyclonedx", "spdx"]), [
      "cyclonedx",
      "spdx",
    ]);
  });

  it("derives SPDX and CycloneDX sibling paths", () => {
    assert.strictEqual(
      deriveSpdxOutputPath("/tmp/bom.cdx.json"),
      "/tmp/bom.spdx.json",
    );
    assert.strictEqual(
      deriveCycloneDxOutputPath("/tmp/bom.spdx.json"),
      "/tmp/bom.cdx.json",
    );
  });

  it("chooses SPDX automatically for .spdx.json outputs", () => {
    const plan = createOutputPlan({ output: "/tmp/app.spdx.json" });
    assert.strictEqual(plan.formats.has("spdx"), true);
    assert.strictEqual(plan.formats.has("cyclonedx"), false);
    assert.strictEqual(plan.outputs.spdx, "/tmp/app.spdx.json");
  });

  it("creates sibling outputs for dual exports", () => {
    const plan = createOutputPlan({
      format: "cyclonedx,spdx",
      output: "/tmp/app.cdx.json",
    });
    assert.strictEqual(plan.outputs.cyclonedx, "/tmp/app.cdx.json");
    assert.strictEqual(plan.outputs.spdx, "/tmp/app.spdx.json");
  });

  it("creates sibling outputs for repeated format flags", () => {
    const plan = createOutputPlan({
      format: ["cyclonedx", "spdx"],
      output: "/tmp/app.cdx.json",
    });
    assert.strictEqual(plan.outputs.cyclonedx, "/tmp/app.cdx.json");
    assert.strictEqual(plan.outputs.spdx, "/tmp/app.spdx.json");
  });
});
