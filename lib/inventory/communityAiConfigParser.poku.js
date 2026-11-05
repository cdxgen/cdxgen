import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

import esmock from "esmock";
import { assert, describe, it } from "poku";
import sinon from "sinon";

import { communityAiConfigParser } from "./communityAiConfigParser.js";

function getProp(obj, name) {
  return obj?.properties?.find((property) => property.name === name)?.value;
}

describe("communityAiConfigParser", () => {
  it("normalizes Windows paths for community ecosystem discovery", async () => {
    const readFileSync = sinon.stub();
    readFileSync
      .withArgs("C:\\repo\\.opencode\\agents\\review.md", "utf-8")
      .returns(
        [
          "---",
          "description: Reviews code for bugs and quality",
          "mode: subagent",
          "model: anthropic/claude-sonnet-4-20250514",
          "---",
          "Focus on code review findings.",
        ].join("\n"),
      );
    readFileSync
      .withArgs("C:\\repo\\.nanocoder\\commands\\fix.md", "utf-8")
      .returns(
        [
          "---",
          "description: Apply the standard fix workflow",
          "category: engineering",
          "tags: [bugfix, workflow]",
          "---",
          "1. Reproduce the issue",
        ].join("\n"),
      );
    const { communityAiConfigParser } = await esmock(
      "./communityAiConfigParser.js",
      {
        "node:fs": { readFileSync },
      },
    );

    const result = communityAiConfigParser.parse([
      "C:\\repo\\.opencode\\agents\\review.md",
      "C:\\repo\\.nanocoder\\commands\\fix.md",
    ]);

    assert.ok(
      result.components.some(
        (component) =>
          getProp(component, "cdx:agent:framework") === "opencode" &&
          getProp(component, "cdx:file:kind") === "agent-definition",
      ),
    );
    assert.ok(
      result.components.some(
        (component) =>
          getProp(component, "cdx:agent:framework") === "nanocoder" &&
          getProp(component, "cdx:file:kind") === "custom-command",
      ),
    );
  });

  it("sanitizes secret-bearing AI inventory properties before emission", async () => {
    const readFileSync = sinon.stub();
    readFileSync.withArgs("/repo/opencode.json", "utf-8").returns(
      JSON.stringify({
        agent: {
          release: {
            description:
              "Deploy with https://user:pass@example.com/release?access_token=abc#frag and sk_test_super_secret_value",
            permission: {
              endpoints: [
                "https://user:pass@example.com/private?token=abc#frag",
              ],
              __proto__: {
                polluted: true,
              },
            },
          },
        },
      }),
    );
    readFileSync
      .withArgs("/repo/.claude/skills/release/SKILL.md", "utf-8")
      .returns(
        [
          "---",
          "name: release",
          "description: Publish release notes",
          "metadata:",
          "  endpoint: https://user:pass@example.com/skill?token=abc#frag",
          "  apiKey: sk_test_skill_secret_value",
          "---",
          "Use the release workflow.",
        ].join("\n"),
      );
    const { communityAiConfigParser } = await esmock(
      "./communityAiConfigParser.js",
      {
        "node:fs": { readFileSync },
      },
    );

    const result = communityAiConfigParser.parse([
      "/repo/opencode.json",
      "/repo/.claude/skills/release/SKILL.md",
    ]);
    const agent = result.components.find(
      (component) => getProp(component, "cdx:file:kind") === "agent-config",
    );
    const skill = result.components.find(
      (component) => getProp(component, "cdx:file:kind") === "skill-file",
    );

    assert.strictEqual(
      getProp(agent, "cdx:agent:description"),
      "Deploy with https://example.com/release and [redacted]",
    );
    assert.strictEqual(
      getProp(agent, "cdx:agent:permission"),
      JSON.stringify({
        endpoints: ["https://example.com/private"],
      }),
    );
    assert.strictEqual(
      getProp(skill, "cdx:skill:metadata"),
      JSON.stringify({
        endpoint: "https://example.com/skill",
        apiKey: "[redacted]",
      }),
    );
  });

  it("detects additional community AI rule ecosystems", async () => {
    const readFileSync = sinon.stub();
    readFileSync
      .withArgs("/repo/.cursor/rules/review.mdc", "utf-8")
      .returns("# Review\nFocus on correctness and security.\n");
    readFileSync
      .withArgs("/repo/.gemini/commands/release.md", "utf-8")
      .returns(
        [
          "---",
          "description: Publish a release safely",
          "---",
          "# Release",
        ].join("\n"),
      );
    const { communityAiConfigParser } = await esmock(
      "./communityAiConfigParser.js",
      {
        "node:fs": { readFileSync },
      },
    );

    const result = communityAiConfigParser.parse([
      "/repo/.cursor/rules/review.mdc",
      "/repo/.gemini/commands/release.md",
    ]);

    assert.ok(
      result.components.some(
        (component) =>
          getProp(component, "cdx:agent:framework") === "cursor" &&
          getProp(component, "cdx:file:kind") === "agent-instructions",
      ),
    );
    assert.ok(
      result.components.some(
        (component) =>
          getProp(component, "cdx:agent:framework") === "gemini" &&
          getProp(component, "cdx:file:kind") === "custom-command",
      ),
    );
  });

  it("discovers Agent Skills, Claude plugins, and subagents", async () => {
    const readFileSync = sinon.stub();
    readFileSync
      .withArgs("/repo/skills/pdf-processing/SKILL.md", "utf-8")
      .returns(
        [
          "---",
          "name: pdf-processing",
          "description: Extract and summarize text from PDF documents on request.",
          "---",
          "# PDF processing",
          "Use pdftotext then summarize.",
        ].join("\n"),
      );
    readFileSync
      .withArgs("/repo/.codex/skills/lint/SKILL.md", "utf-8")
      .returns(
        [
          "---",
          "name: lint",
          "description: Run the project linter and report findings.",
          "---",
          "Run biome.",
        ].join("\n"),
      );
    readFileSync.withArgs("/repo/.claude-plugin/plugin.json", "utf-8").returns(
      JSON.stringify({
        name: "cdxgen-tools",
        version: "1.2.0",
        description: "SBOM helper commands",
        commands: ["sbom", "audit"],
        skills: { "sbom-fidelity": {} },
      }),
    );
    readFileSync
      .withArgs("/repo/.claude-plugin/marketplace.json", "utf-8")
      .returns(
        JSON.stringify({
          name: "cdxgen-plugins",
          plugins: [
            { name: "cdxgen-tools", description: "SBOM helpers" },
            { name: "extra", source: "./extra" },
          ],
        }),
      );
    readFileSync
      .withArgs("/repo/.claude/agents/reviewer.md", "utf-8")
      .returns(
        [
          "---",
          "name: reviewer",
          "description: Reviews diffs for regressions",
          "model: claude-sonnet-4-5",
          "tools: [Read, Grep]",
          "---",
          "Review carefully.",
        ].join("\n"),
      );
    const { communityAiConfigParser } = await esmock(
      "./communityAiConfigParser.js",
      {
        "node:fs": { readFileSync },
      },
    );

    const result = communityAiConfigParser.parse([
      "/repo/skills/pdf-processing/SKILL.md",
      "/repo/.codex/skills/lint/SKILL.md",
      "/repo/.claude-plugin/plugin.json",
      "/repo/.claude-plugin/marketplace.json",
      "/repo/.claude/agents/reviewer.md",
    ]);

    const genericSkill = result.components.find(
      (component) => getProp(component, "cdx:skill:name") === "pdf-processing",
    );
    assert.ok(genericSkill, "expected generic Agent Skills SKILL.md component");
    assert.strictEqual(
      getProp(genericSkill, "cdx:agent:framework"),
      "agent-skills",
    );
    assert.strictEqual(getProp(genericSkill, "cdx:skill:specValid"), "true");

    assert.ok(
      result.components.some(
        (component) =>
          getProp(component, "cdx:skill:name") === "lint" &&
          getProp(component, "cdx:agent:framework") === "codex",
      ),
      "expected Codex skill component",
    );

    const plugin = result.components.find(
      (component) => getProp(component, "cdx:file:kind") === "agent-plugin",
    );
    assert.ok(plugin, "expected plugin manifest component");
    assert.strictEqual(plugin.version, "1.2.0");
    assert.strictEqual(getProp(plugin, "cdx:plugin:commandCount"), "2");

    const listings = result.components.filter(
      (component) =>
        getProp(component, "cdx:file:kind") === "agent-plugin-listing",
    );
    assert.strictEqual(listings.length, 2, "expected two marketplace listings");

    const subagent = result.components.find(
      (component) => getProp(component, "cdx:agent:role") === "claude-subagent",
    );
    assert.ok(subagent, "expected Claude subagent component");
    assert.strictEqual(getProp(subagent, "cdx:agent:tools"), "Read,Grep");
  });

  it("inventories every Kiro V3 artifact of the issue reproduction", () => {
    const tmpDir = mkdtempSync(join(os.tmpdir(), "cdxgen-kiro-v3-"));
    try {
      mkdirSync(join(tmpDir, ".kiro", "steering"), { recursive: true });
      mkdirSync(join(tmpDir, ".kiro", "agents"), { recursive: true });
      mkdirSync(join(tmpDir, ".kiro", "settings"), { recursive: true });
      mkdirSync(join(tmpDir, ".kiro", "hooks"), { recursive: true });
      mkdirSync(join(tmpDir, ".kiro", "workflows"), { recursive: true });
      mkdirSync(join(tmpDir, ".kiro", "specs", "auth"), { recursive: true });
      writeFileSync(
        join(tmpDir, ".kiro", "steering", "product.md"),
        "# Product\nBuild a safe deploy pipeline for the service.\n",
      );
      writeFileSync(
        join(tmpDir, ".kiro", "agents", "reviewer.json"),
        JSON.stringify({
          name: "reviewer",
          model: "claude-sonnet-4.5",
          prompt: "Review code carefully.",
          resources: [{ name: "guide", uri: "file:///docs.md" }],
          toolsSettings: { fs_write: { disabled: false } },
          tools: ["fs_read", "fs_write", "shell"],
          allowedTools: ["fs_read"],
          mcpServers: { context7: {} },
          permissions: {
            rules: [
              { capability: "all", effect: "allow" },
              {
                capability: "fs_write",
                effect: "deny",
                match: ["**/.env"],
              },
            ],
          },
          kiroUpgrade: {
            revision: 2,
            fingerprint: "SECRET-FINGERPRINT",
            source: "built-in",
          },
        }),
      );
      writeFileSync(
        join(tmpDir, ".kiro", "settings", "permissions.yaml"),
        [
          "rules:",
          "  - capability: shell",
          "    effect: allow",
          "  - capability: fs_write",
          "    effect: deny",
          '    match: ["**/.ssh/**"]',
        ].join("\n"),
      );
      writeFileSync(
        join(tmpDir, ".kiro", "hooks", "pre-commit.sh"),
        "#!/bin/bash\necho ok\n",
      );
      writeFileSync(
        join(tmpDir, ".kiro", "workflows", "deploy.yaml"),
        "steps:\n  - build\n",
      );
      writeFileSync(
        join(tmpDir, ".kiro", "specs", "auth", "design.md"),
        "# Design\nAuth flows for the login service.\n",
      );

      const result = communityAiConfigParser.parse([
        join(tmpDir, ".kiro", "steering", "product.md"),
        join(tmpDir, ".kiro", "agents", "reviewer.json"),
        join(tmpDir, ".kiro", "settings", "permissions.yaml"),
        join(tmpDir, ".kiro", "hooks", "pre-commit.sh"),
        join(tmpDir, ".kiro", "workflows", "deploy.yaml"),
        join(tmpDir, ".kiro", "specs", "auth", "design.md"),
      ]);
      const byKind = (kind) =>
        result.components.filter(
          (component) => getProp(component, "cdx:file:kind") === kind,
        );

      assert.strictEqual(result.components.length, 6);
      for (const component of result.components) {
        assert.strictEqual(
          getProp(component, "cdx:agent:framework"),
          "kiro",
          component.name,
        );
      }
      const steering = byKind("agent-instructions");
      assert.strictEqual(steering.length, 1);
      assert.strictEqual(steering[0].name, "Product");

      const spec = byKind("agent-spec");
      assert.strictEqual(spec.length, 1);
      assert.strictEqual(spec[0].name, "Design");

      const agents = byKind("agent-definition");
      assert.strictEqual(agents.length, 1);
      const agent = agents[0];
      assert.strictEqual(agent.name, "reviewer");
      assert.strictEqual(
        getProp(agent, "cdx:agent:model"),
        "claude-sonnet-4.5",
      );
      assert.strictEqual(getProp(agent, "cdx:agent:mcpServerCount"), "1");
      assert.strictEqual(getProp(agent, "cdx:agent:toolCount"), "3");
      assert.strictEqual(getProp(agent, "cdx:agent:allowedToolCount"), "1");
      assert.strictEqual(getProp(agent, "cdx:agent:permissionRuleCount"), "2");
      assert.strictEqual(
        getProp(agent, "cdx:agent:permissionAllowRuleCount"),
        "1",
      );
      assert.strictEqual(
        getProp(agent, "cdx:agent:permissionDenyRuleCount"),
        "1",
      );
      assert.strictEqual(
        getProp(agent, "cdx:agent:permissionAllowsAll"),
        "true",
      );
      assert.strictEqual(
        getProp(agent, "cdx:agent:permissionCapabilities"),
        "all,fs_write",
      );
      assert.strictEqual(
        getProp(agent, "cdx:agent:permissionUnrestrictedAllowCapabilities"),
        "all",
      );
      assert.strictEqual(getProp(agent, "cdx:agent:upgradeRevision"), "2");
      const agentSerialized = JSON.stringify(agent);
      assert.ok(!agentSerialized.includes("Review code carefully"));
      assert.ok(!agentSerialized.includes("SECRET-FINGERPRINT"));
      assert.ok(!agentSerialized.includes("guide"));

      const policies = byKind("permission-policy");
      assert.strictEqual(policies.length, 1);
      assert.strictEqual(
        getProp(policies[0], "cdx:agent:permissionRuleCount"),
        "2",
      );
      assert.strictEqual(
        getProp(policies[0], "cdx:agent:permissionDenyRuleCount"),
        "1",
      );
      assert.ok(!JSON.stringify(policies[0]).includes(".ssh"));

      assert.strictEqual(byKind("hook-file").length, 1);
      assert.strictEqual(byKind("workflow-file").length, 1);
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("reads Kiro files from Windows-style paths", async () => {
    const readFileSync = sinon.stub();
    readFileSync
      .withArgs("C:\\repo\\.kiro\\steering\\product.md", "utf-8")
      .returns("# Product\nStanding guidance for the project.\n");
    readFileSync
      .withArgs("C:\\repo\\.kiro\\agents\\reviewer.json", "utf-8")
      .returns(
        JSON.stringify({
          name: "reviewer",
          model: "claude-sonnet-4.5",
          permissions: {
            rules: [{ capability: "fs_read", effect: "allow" }],
          },
        }),
      );
    readFileSync
      .withArgs("C:\\repo\\.kiro\\settings\\permissions.yaml", "utf-8")
      .returns(["rules:", "- capability: shell", "  effect: deny"].join("\n"));
    const { communityAiConfigParser } = await esmock(
      "./communityAiConfigParser.js",
      {
        "node:fs": { readFileSync },
      },
    );

    const result = communityAiConfigParser.parse([
      "C:\\repo\\.kiro\\steering\\product.md",
      "C:\\repo\\.kiro\\agents\\reviewer.json",
      "C:\\repo\\.kiro\\settings\\permissions.yaml",
    ]);

    assert.strictEqual(result.components.length, 3);
    for (const component of result.components) {
      assert.strictEqual(getProp(component, "cdx:agent:framework"), "kiro");
    }
    const kinds = result.components.map((component) =>
      getProp(component, "cdx:file:kind"),
    );
    assert.ok(kinds.includes("agent-instructions"));
    assert.ok(kinds.includes("agent-definition"));
    assert.ok(kinds.includes("permission-policy"));
  });

  it("picks up a Kiro configuration root that keeps content outside .kiro", () => {
    const tmpDir = mkdtempSync(join(os.tmpdir(), "cdxgen-kiro-root-"));
    try {
      mkdirSync(join(tmpDir, "settings"), { recursive: true });
      mkdirSync(join(tmpDir, "steering"), { recursive: true });
      mkdirSync(join(tmpDir, "hooks"), { recursive: true });
      writeFileSync(
        join(tmpDir, "settings", "permissions.yaml"),
        [
          "rules:",
          "  - { capability: builtin, effect: allow }",
          "  - capability: fs_write",
          "    effect: deny",
          '    match: ["**/*.pem"]',
        ].join("\n"),
      );
      writeFileSync(
        join(tmpDir, "settings", "cli.json"),
        JSON.stringify({
          "chat.defaultAgent": "software-engineer",
          "chat.enableSubagent": true,
          "app.beta": false,
        }),
      );
      writeFileSync(
        join(tmpDir, "steering", "delivery-workflow.md"),
        "# Delivery workflow\nShip in small steps.\n",
      );
      writeFileSync(
        join(tmpDir, "steering", "testing.md"),
        "# Testing\nTest before shipping.\n",
      );
      writeFileSync(
        join(tmpDir, "hooks", "01-check-secrets.json"),
        JSON.stringify({
          version: "v1",
          hooks: [
            {
              name: "check-secrets",
              description: "Block credential-shaped writes",
              trigger: "PreToolUse",
              matcher: "fs_write|write|str_replace",
              action: {
                type: "command",
                command: "hooks/scripts/check-secrets.sh",
              },
              timeout: 10,
            },
          ],
        }),
      );

      const result = communityAiConfigParser.parse([
        join(tmpDir, "settings", "permissions.yaml"),
        join(tmpDir, "settings", "cli.json"),
      ]);
      const byKind = (kind) =>
        result.components.filter(
          (component) => getProp(component, "cdx:file:kind") === kind,
        );

      // Both settings files, both steering documents, and the hook manifest,
      // with no component parsed twice.
      assert.strictEqual(result.components.length, 5);
      for (const component of result.components) {
        assert.strictEqual(
          getProp(component, "cdx:agent:framework"),
          "kiro",
          component.name,
        );
      }
      assert.strictEqual(byKind("agent-instructions").length, 2);
      assert.strictEqual(byKind("permission-policy").length, 1);
      assert.strictEqual(byKind("settings").length, 1);
      const hooks = byKind("hook-file");
      assert.strictEqual(hooks.length, 1);
      assert.strictEqual(getProp(hooks[0], "cdx:agent:hookCount"), "1");
      assert.strictEqual(
        getProp(hooks[0], "cdx:agent:hookEvents"),
        "PreToolUse",
      );
      assert.strictEqual(
        getProp(hooks[0], "cdx:agent:hookActionTypes"),
        "command",
      );
      const hookSerialized = JSON.stringify(hooks[0]);
      assert.ok(!hookSerialized.includes("check-secrets.sh"));
      assert.ok(!hookSerialized.includes("fs_write|write"));
      const settings = byKind("settings");
      assert.strictEqual(
        getProp(settings[0], "cdx:agent:defaultAgent"),
        "software-engineer",
      );
      assert.strictEqual(
        getProp(settings[0], "cdx:agent:booleanFeatureFlagCount"),
        "2",
      );
      assert.strictEqual(
        getProp(
          byKind("permission-policy")[0],
          "cdx:agent:permissionRuleCount",
        ),
        "2",
      );
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("yields nothing for a plain steering folder without Kiro settings", () => {
    const tmpDir = mkdtempSync(join(os.tmpdir(), "cdxgen-kiro-negative-"));
    try {
      mkdirSync(join(tmpDir, "steering"), { recursive: true });
      mkdirSync(join(tmpDir, "settings"), { recursive: true });
      writeFileSync(
        join(tmpDir, "steering", "plan.md"),
        "# Plan\nA plain documentation folder.\n",
      );
      writeFileSync(
        join(tmpDir, "settings", "permissions.yaml"),
        ["rules:", "  - some plain documentation list"].join("\n"),
      );
      writeFileSync(
        join(tmpDir, "settings", "cli.json"),
        JSON.stringify({ theme: "dark", telemetry: true }),
      );

      const result = communityAiConfigParser.parse([
        join(tmpDir, "steering", "plan.md"),
        join(tmpDir, "settings", "permissions.yaml"),
        join(tmpDir, "settings", "cli.json"),
      ]);
      assert.deepStrictEqual(result.components, []);
      assert.deepStrictEqual(result.services, []);
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("never copies a planted token from Kiro hooks, prompts, or match lists", () => {
    const tmpDir = mkdtempSync(join(os.tmpdir(), "cdxgen-kiro-secret-"));
    try {
      const token = "ghp_abc012def345ghi789jkl012mno";
      mkdirSync(join(tmpDir, ".kiro", "hooks"), { recursive: true });
      mkdirSync(join(tmpDir, ".kiro", "agents"), { recursive: true });
      mkdirSync(join(tmpDir, ".kiro", "settings"), { recursive: true });
      writeFileSync(
        join(tmpDir, ".kiro", "hooks", "deploy.sh"),
        `#!/bin/bash\necho "TOKEN=${token}"\n`,
      );
      writeFileSync(
        join(tmpDir, ".kiro", "agents", "leaky.json"),
        JSON.stringify({
          name: "leaky",
          prompt: `Use ${token} when deploying.`,
          permissions: {
            rules: [{ capability: "shell", effect: "allow", match: [token] }],
          },
        }),
      );
      writeFileSync(
        join(tmpDir, ".kiro", "settings", "permissions.yaml"),
        [
          "rules:",
          "- capability: shell",
          "  effect: deny",
          `  match: ["${token}"]`,
        ].join("\n"),
      );

      const result = communityAiConfigParser.parse([
        join(tmpDir, ".kiro", "hooks", "deploy.sh"),
        join(tmpDir, ".kiro", "agents", "leaky.json"),
        join(tmpDir, ".kiro", "settings", "permissions.yaml"),
      ]);
      assert.strictEqual(result.components.length, 3);
      const serialized = JSON.stringify(result);
      assert.ok(!serialized.includes(token), "the token must not be emitted");

      // The hook script is still flagged for review through indicator labels,
      // never through its content.
      const hook = result.components.find(
        (component) => getProp(component, "cdx:file:kind") === "hook-file",
      );
      assert.strictEqual(getProp(hook, "cdx:agent:credentialExposure"), "true");
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });
});
