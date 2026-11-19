import { assert, describe, it } from "poku";

import { evaluateRule } from "./ruleEngine.js";

const bom = {
  bomFormat: "CycloneDX",
  specVersion: "1.6",
  metadata: { component: { name: "test-app", version: "1.0.0" } },
  components: [],
};

// The rule matches once in every BOM, so its message is interpolated once.
const messageOf = async (message) => {
  const findings = await evaluateRule(
    { id: "TEST-TEMPLATE", condition: "metadata", message },
    bom,
  );
  assert.strictEqual(findings.length, 1);
  return findings[0].message;
};

describe("rule message templates", () => {
  it("replaces placeholders with or without padding", async () => {
    assert.strictEqual(
      await messageOf(
        '{{bom.bomFormat}} {{   bom.specVersion\n}} {{ "{" & component.name }}',
      ),
      "CycloneDX 1.6 {test-app",
    );
  });

  it("scans unclosed placeholders in linear time", async () => {
    // Neither run ever closes. A template scan that backtracks over them
    // needs many seconds, and a linear one a few milliseconds.
    const unclosed = `{{${" ".repeat(3000)}x ${"{{".repeat(30000)}`;
    const started = Date.now();
    const message = await messageOf(`{{ bom.specVersion }} ${unclosed}`);
    const elapsed = Date.now() - started;
    assert.ok(
      message === `1.6 ${unclosed}`,
      "the closed placeholder is replaced and the unclosed ones are kept",
    );
    assert.ok(
      elapsed < 2000,
      `unclosed {{ must not make the template scan backtrack, took ${elapsed}ms`,
    );
  });
});
