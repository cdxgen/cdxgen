import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { assert, describe, it } from "poku";

import {
  auditBom,
  formatAnnotations,
  hasCriticalFindings,
} from "./auditBom.js";
import { evaluateRule, evaluateRules, loadRules } from "./ruleEngine.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const RULES_DIR = join(__dirname, "..", "..", "..", "data", "rules");

function makeBom(components = [], workflows = []) {
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    serialNumber: "urn:uuid:test-bom",
    metadata: {
      tools: {
        components: [
          {
            type: "application",
            name: "cdxgen",
            version: "11.0.0",
            "bom-ref": "pkg:npm/%40cyclonedx/cdxgen@11.0.0",
          },
        ],
      },
      component: {
        name: "test-project",
        type: "application",
        "bom-ref": "pkg:npm/test-project@1.0.0",
      },
    },
    components,
    formulation: workflows.length ? [{ workflows }] : undefined,
  };
}

function makeComponent(name, version, properties) {
  return {
    type: "library",
    name,
    version,
    purl: `pkg:npm/${name}@${version}`,
    "bom-ref": `pkg:npm/${name}@${version}`,
    properties: properties.map(([k, v]) => ({ name: k, value: v })),
  };
}

describe("loadRules", () => {
  it("should load built-in rules from the data/rules directory", async () => {
    const rules = await loadRules(RULES_DIR);
    assert.ok(rules.length > 0, "Should load at least one rule");
    for (const rule of rules) {
      assert.ok(rule.id, "Each rule must have an id");
      assert.ok(rule.condition, "Each rule must have a condition");
      assert.ok(rule.message, "Each rule must have a message");
      assert.ok(
        ["critical", "high", "medium", "low"].includes(rule.severity),
        `Rule ${rule.id} severity must be valid`,
      );
    }
  });

  it("should return empty array for non-existent directory", async () => {
    const rules = await loadRules("/tmp/non-existent-rules-dir-12345");
    assert.deepStrictEqual(rules, []);
  });

  it("should load rules with all required fields", async () => {
    const rules = await loadRules(RULES_DIR);
    const ciRules = rules.filter((r) => r.category === "ci-permission");
    assert.ok(ciRules.length > 0, "Should have CI permission rules");
    const depRules = rules.filter((r) => r.category === "dependency-source");
    assert.ok(depRules.length > 0, "Should have dependency source rules");
    const intRules = rules.filter((r) => r.category === "package-integrity");
    assert.ok(intRules.length > 0, "Should have package integrity rules");
  });
});

describe("evaluateRule", () => {
  it("should detect unpinned action with write permissions (CI-001)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "CI-001");
    assert.ok(rule, "CI-001 rule should exist");

    const bom = makeBom([
      makeComponent("actions/setup-node", "v3", [
        ["cdx:github:action:isShaPinned", "false"],
        ["cdx:github:workflow:hasWritePermissions", "true"],
        ["cdx:github:action:uses", "actions/setup-node@v3"],
        ["cdx:github:action:versionPinningType", "tag"],
      ]),
    ]);

    const findings = await evaluateRule(rule, bom);
    assert.ok(findings.length > 0, "Should find unpinned action");
    assert.strictEqual(findings[0].ruleId, "CI-001");
    assert.strictEqual(findings[0].severity, "high");
  });

  it("should not flag SHA-pinned actions for CI-001", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "CI-001");

    const bom = makeBom([
      makeComponent("actions/setup-node", "v3", [
        ["cdx:github:action:isShaPinned", "true"],
        ["cdx:github:workflow:hasWritePermissions", "true"],
        ["cdx:github:action:uses", "actions/setup-node@abc123"],
      ]),
    ]);

    const findings = await evaluateRule(rule, bom);
    assert.strictEqual(
      findings.length,
      0,
      "SHA-pinned action should not trigger",
    );
  });

  it("should detect npm install script from non-registry source (PKG-001)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "PKG-001");
    assert.ok(rule, "PKG-001 rule should exist");

    const bom = makeBom([
      makeComponent("sketchy-pkg", "1.0.0", [
        ["cdx:npm:hasInstallScript", "true"],
        ["cdx:npm:isRegistryDependency", "false"],
      ]),
    ]);

    const findings = await evaluateRule(rule, bom);
    assert.ok(findings.length > 0, "Should detect install script risk");
    assert.strictEqual(findings[0].severity, "high");
  });

  it("should detect npm name mismatch (INT-002)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "INT-002");
    assert.ok(rule, "INT-002 rule should exist");

    const bom = makeBom([
      makeComponent("suspicious-pkg", "1.0.0", [
        [
          "cdx:npm:nameMismatchError",
          "Expected 'real-pkg', found 'suspicious-pkg'",
        ],
      ]),
    ]);

    const findings = await evaluateRule(rule, bom);
    assert.ok(findings.length > 0, "Should detect name mismatch");
    assert.strictEqual(findings[0].severity, "high");
  });

  it("should detect yanked Ruby gem (INT-004)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "INT-004");
    assert.ok(rule, "INT-004 rule should exist");

    const bom = makeBom([
      {
        type: "library",
        name: "bad-gem",
        version: "0.5.0",
        purl: "pkg:gem/bad-gem@0.5.0",
        "bom-ref": "pkg:gem/bad-gem@0.5.0",
        properties: [{ name: "cdx:gem:yanked", value: "true" }],
      },
    ]);

    const findings = await evaluateRule(rule, bom);
    assert.ok(findings.length > 0, "Should detect yanked gem");
    assert.strictEqual(findings[0].severity, "high");
  });

  it("should return empty findings when no components match", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "CI-001");

    const bom = makeBom([]);
    const findings = await evaluateRule(rule, bom);
    assert.strictEqual(findings.length, 0, "No components means no findings");
  });
});

describe("evaluateRules", () => {
  it("should sort findings by severity (high before medium before low)", async () => {
    const rules = await loadRules(RULES_DIR);
    const bom = makeBom([
      makeComponent("actions/checkout", "v3", [
        ["cdx:github:action:isShaPinned", "false"],
        ["cdx:github:workflow:hasWritePermissions", "true"],
        ["cdx:github:action:uses", "actions/checkout@v3"],
        ["cdx:github:action:versionPinningType", "tag"],
      ]),
      makeComponent("deprecated-go-mod", "1.0.0", [
        ["cdx:go:deprecated", "use other-module instead"],
      ]),
    ]);

    const findings = await evaluateRules(rules, bom);
    if (findings.length >= 2) {
      const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      for (let i = 1; i < findings.length; i++) {
        const prev = severityOrder[findings[i - 1].severity] ?? 4;
        const curr = severityOrder[findings[i].severity] ?? 4;
        assert.ok(
          prev <= curr,
          `Finding ${i - 1} severity (${findings[i - 1].severity}) should be >= severity of finding ${i} (${findings[i].severity})`,
        );
      }
    }
  });
});

describe("auditBom", () => {
  it("should run audit and return findings", async () => {
    const bom = makeBom([
      makeComponent("actions/setup-node", "v3", [
        ["cdx:github:action:isShaPinned", "false"],
        ["cdx:github:workflow:hasWritePermissions", "true"],
        ["cdx:github:action:uses", "actions/setup-node@v3"],
        ["cdx:github:action:versionPinningType", "tag"],
      ]),
    ]);

    const findings = await auditBom(bom, {});
    assert.ok(findings.length > 0, "Should find at least one issue");
  });

  it("should return empty array for null bom", async () => {
    const findings = await auditBom(null, {});
    assert.deepStrictEqual(findings, []);
  });

  it("should filter by category", async () => {
    const bom = makeBom([
      makeComponent("actions/setup-node", "v3", [
        ["cdx:github:action:isShaPinned", "false"],
        ["cdx:github:workflow:hasWritePermissions", "true"],
        ["cdx:github:action:uses", "actions/setup-node@v3"],
        ["cdx:github:action:versionPinningType", "tag"],
      ]),
      makeComponent("sketchy-pkg", "1.0.0", [
        ["cdx:npm:hasInstallScript", "true"],
        ["cdx:npm:isRegistryDependency", "false"],
      ]),
    ]);

    const ciOnly = await auditBom(bom, {
      bomAuditCategories: "ci-permission",
    });
    for (const f of ciOnly) {
      assert.strictEqual(f.category, "ci-permission");
    }
  });

  it("should filter by minimum severity", async () => {
    const bom = makeBom([
      makeComponent("actions/setup-node", "v3", [
        ["cdx:github:action:isShaPinned", "false"],
        ["cdx:github:workflow:hasWritePermissions", "true"],
        ["cdx:github:action:uses", "actions/setup-node@v3"],
        ["cdx:github:action:versionPinningType", "tag"],
      ]),
    ]);

    const highOnly = await auditBom(bom, {
      bomAuditMinSeverity: "high",
    });
    for (const f of highOnly) {
      assert.strictEqual(f.severity, "high");
    }
  });
});

describe("formatAnnotations", () => {
  it("should create CycloneDX annotations from findings", () => {
    const bom = makeBom([]);
    const findings = [
      {
        ruleId: "CI-001",
        name: "Unpinned action",
        severity: "high",
        category: "ci-permission",
        message: "Unpinned GitHub Action detected",
        mitigation: "Pin to SHA",
      },
    ];
    const annotations = formatAnnotations(findings, bom);
    assert.strictEqual(annotations.length, 1);
    assert.ok(
      annotations[0].text.startsWith("Unpinned GitHub Action detected"),
    );
    assert.ok(
      annotations[0].annotator.component,
      "Annotation should have annotator component",
    );
    assert.ok(annotations[0].subjects.includes(bom.serialNumber));
  });

  it("should return empty array when cdxgen tool component is missing", () => {
    const bom = {
      serialNumber: "urn:uuid:test",
      metadata: { tools: { components: [] } },
      components: [],
    };
    const findings = [
      {
        ruleId: "CI-001",
        severity: "high",
        category: "ci-permission",
        message: "test",
      },
    ];
    const annotations = formatAnnotations(findings, bom);
    assert.deepStrictEqual(annotations, []);
  });

  it("should return empty array when metadata.tools is undefined", () => {
    const bom = {
      serialNumber: "urn:uuid:test",
      metadata: {},
      components: [],
    };
    const annotations = formatAnnotations(
      [{ ruleId: "X", severity: "low", category: "test", message: "test" }],
      bom,
    );
    assert.deepStrictEqual(annotations, []);
  });
});

describe("hasCriticalFindings", () => {
  it("should return true when high severity findings exist", () => {
    const findings = [{ severity: "high" }];
    assert.ok(hasCriticalFindings(findings, {}));
  });

  it("should return false when only low severity findings exist", () => {
    const findings = [{ severity: "low" }];
    assert.ok(!hasCriticalFindings(findings, {}));
  });

  it("should use threshold semantics (at or above)", () => {
    const findings = [{ severity: "high" }];
    // medium threshold should catch high findings
    assert.ok(
      hasCriticalFindings(findings, { bomAuditFailSeverity: "medium" }),
    );
    // high threshold should catch high findings
    assert.ok(hasCriticalFindings(findings, { bomAuditFailSeverity: "high" }));
    // critical threshold should NOT catch high findings
    assert.ok(
      !hasCriticalFindings(findings, { bomAuditFailSeverity: "critical" }),
    );
  });

  it("should respect custom fail severity for medium", () => {
    const findings = [{ severity: "medium" }];
    assert.ok(
      hasCriticalFindings(findings, { bomAuditFailSeverity: "medium" }),
    );
    assert.ok(!hasCriticalFindings(findings, { bomAuditFailSeverity: "high" }));
  });

  it("should return false for empty findings", () => {
    assert.ok(!hasCriticalFindings([], {}));
    assert.ok(!hasCriticalFindings(null, {}));
  });
});
