import esmock from "esmock";
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

describe("registry SBOM lookups", () => {
  const container = (name) => ({
    type: "container",
    name: `registry.example.com/${name}:1`,
    "bom-ref": `registry.example.com/${name}:1`,
  });
  const bomOf = (names) => ({
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    metadata: { component: { name: "test-app", version: "1.0.0" } },
    components: names.map(container),
  });
  const ruleOf = (id) => ({
    id,
    severity: "medium",
    condition:
      id === "CTR-010"
        ? "components[type = 'container' and $hasSbom($) and $not($hasSignedSbom($))]"
        : "components[type = 'container' and $not($hasSbom($))]",
    message: "{{ name }}",
  });

  it("looks the images up side by side and keeps those that have an SBOM", async () => {
    let active = 0;
    let peak = 0;
    const getBomWithOras = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 100));
      active--;
      return { bomFormat: "CycloneDX", components: [] };
    };
    const names = Array.from({ length: 24 }, (_, index) => `app${index}`);
    const started = Date.now();
    const findings = await evaluateRule(ruleOf("CTR-009"), bomOf(names), {
      getBomWithOras,
    });
    assert.strictEqual(findings.length, 0);
    assert.ok(peak > 1, "expected lookups to overlap");
    assert.ok(Date.now() - started < 2400, "expected lookups to overlap");
  });

  it("looks an image up once for the rules that ask about it twice", async () => {
    const probed = [];
    const getBomWithOras = async (image) => {
      probed.push(image);
      return { bomFormat: "CycloneDX", components: [] };
    };
    const findings = await evaluateRule(
      ruleOf("CTR-010"),
      bomOf(["app", "app"]),
      { getBomWithOras },
    );
    assert.strictEqual(findings.length, 2);
    assert.deepStrictEqual(probed, ["registry.example.com/app:1"]);
  });

  it("raises no finding for images whose lookups never answer, and stops asking when the budget is spent", async () => {
    let calls = 0;
    const getBomWithOras = () => {
      calls++;
      return new Promise(() => undefined);
    };
    const names = Array.from({ length: 30 }, (_, index) => `app${index}`);
    for (const id of ["CTR-009", "CTR-010"]) {
      calls = 0;
      const findings = await evaluateRule(ruleOf(id), bomOf(names), {
        getBomWithOras,
      });
      assert.strictEqual(findings.length, 0, id);
      assert.ok(calls < names.length, `${calls} lookups were started`);
    }
  });

  it("raises no finding for an image whose lookup fails", async () => {
    const getBomWithOras = async () => {
      throw new Error("registry unreachable");
    };
    for (const id of ["CTR-009", "CTR-010"]) {
      const findings = await evaluateRule(ruleOf(id), bomOf(["app"]), {
        getBomWithOras,
      });
      assert.strictEqual(findings.length, 0, id);
    }
  });

  it("reports an image the registry answered has no SBOM, next to one it never answered", async () => {
    const getBomWithOras = (image) =>
      image.includes("silent")
        ? new Promise(() => undefined)
        : Promise.resolve(undefined);
    const findings = await evaluateRule(
      ruleOf("CTR-009"),
      bomOf(["bare", "silent"]),
      { getBomWithOras },
    );
    assert.deepStrictEqual(
      findings.map((finding) => finding.message),
      ["registry.example.com/bare:1"],
    );
  });

  it("asks the registry to report errors, so a failure is not an answer", async () => {
    const seen = [];
    const getBomWithOras = async (_image, _platform, options) => {
      seen.push(options);
      return undefined;
    };
    const findings = await evaluateRule(ruleOf("CTR-009"), bomOf(["app"]), {
      getBomWithOras,
    });
    assert.strictEqual(findings.length, 1);
    assert.deepStrictEqual(seen, [{ reportErrors: true }]);
  });

  it("logs the images it leaves unchecked", async () => {
    const messages = [];
    const { evaluateRule: evaluateMocked } = await esmock("./ruleEngine.js", {
      "../../core/logger.js": {
        thoughtLog: (message) => messages.push(String(message)),
      },
    });
    await evaluateMocked(ruleOf("CTR-009"), bomOf(["silent"]), {
      getBomWithOras: () => new Promise(() => undefined),
    });
    assert.ok(
      messages.some((message) =>
        message.includes("registry.example.com/silent:1"),
      ),
      messages.join("\n"),
    );
  });
});
