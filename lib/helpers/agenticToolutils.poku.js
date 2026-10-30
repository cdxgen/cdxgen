import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";

import { assert, describe, it } from "poku";

import {
  AGENTIC_TOOL_PURL_TYPE,
  collectAgenticTools,
  collectToolSignals,
  componentForAgenticTool,
  countConfiguredMcpServers,
  discoverAgenticTools,
  getAgenticToolDirs,
  redactHomePath,
} from "./agenticToolutils.js";

const IDE_FIXTURES = resolve("test", "data", "ide-extensions");

const getProp = (subject, name) =>
  subject?.properties?.find((property) => property.name === name)?.value;

const createTempHome = () => mkdtempSync(join(os.tmpdir(), "cdxgen-agentic-"));

/** Build a fixture ~/.kiro layout, including a secret file that must be ignored. */
function writeKiroFixture(root) {
  const kiro = join(root, ".kiro");
  mkdirSync(join(kiro, "agents"), { recursive: true });
  mkdirSync(join(kiro, "settings"), { recursive: true });
  mkdirSync(join(kiro, "sessions", "cli"), { recursive: true });
  writeFileSync(
    join(kiro, "agents", "autonomous.json"),
    JSON.stringify({
      name: "autonomous",
      description: "Autonomous agent",
      prompt: "SECRET PROMPT TEXT THAT MUST NOT LEAK",
      model: "claude-sonnet-4-5",
      mcpServers: { fs: {}, git: {} },
      tools: ["fs_read", "fs_write", "execute_bash"],
      allowedTools: ["fs_read"],
    }),
  );
  // An example file that should be skipped.
  writeFileSync(join(kiro, "agents", "agent_config.json.example"), "{}");
  writeFileSync(
    join(kiro, "settings", "cli.json"),
    JSON.stringify({
      "chat.defaultAgent": "autonomous",
      "telemetry.enabled": true,
    }),
  );
  // A secret transcript that must never be read.
  writeFileSync(
    join(kiro, "sessions", "cli", "abc.jsonl"),
    '{"secret":"sk-do-not-read"}',
  );
  const support = join(root, "kiro-support");
  mkdirSync(join(support, "knowledge_bases", "kb1"), { recursive: true });
  mkdirSync(join(support, "knowledge_bases", "kb2"), { recursive: true });
  return { kiro, support };
}

describe("agenticToolutils", () => {
  it("lists known agentic tool home directories", () => {
    const entries = getAgenticToolDirs();
    const tools = entries.map((entry) => entry.tool);
    for (const tool of [
      "kiro-cli",
      "zcode",
      "opencode",
      "claude-code",
      "cursor",
      "windsurf",
      "goose",
      "amp",
      "copilot-cli",
      "crush",
    ]) {
      assert.ok(tools.includes(tool), `expected ${tool} in the tool map`);
    }
    for (const entry of entries) {
      assert.ok(Array.isArray(entry.dirs) && entry.dirs.length > 0);
    }
    assert.strictEqual(AGENTIC_TOOL_PURL_TYPE, "generic");
  });

  it("collects redacted kiro signals without reading secrets", () => {
    const root = createTempHome();
    try {
      const { kiro, support } = writeKiroFixture(root);
      const signals = collectToolSignals("kiro-cli", kiro, support);
      assert.strictEqual(signals.agentCount, 1);
      assert.strictEqual(signals.knowledgeBaseCount, 2);
      assert.strictEqual(signals.defaultAgent, "autonomous");
      assert.strictEqual(signals.hasSessions, true);
      // Ensure no secret value leaked into the signal map.
      const serialized = JSON.stringify(signals);
      assert.ok(!serialized.includes("sk-do-not-read"));
      assert.ok(!serialized.includes("SECRET PROMPT"));
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("builds a generic-purl component with kiro agent children", () => {
    const root = createTempHome();
    try {
      const { kiro, support } = writeKiroFixture(root);
      const component = componentForAgenticTool({
        tool: "kiro-cli",
        name: "Kiro CLI",
        dir: kiro,
        supportDir: support,
      });
      assert.strictEqual(component.type, "application");
      // The display name is used for the component name; the tool key lives on
      // cdx:agentic:tool.
      assert.strictEqual(component.name, "Kiro CLI");
      assert.strictEqual(getProp(component, "cdx:agentic:tool"), "kiro-cli");
      // No declarative version file, so the namespaced purl carries no version.
      assert.strictEqual(component.purl, "pkg:generic/cdxgen-agentic/kiro-cli");
      assert.strictEqual(getProp(component, "cdx:agentic:agentCount"), "1");
      assert.ok((component.tags || []).includes("agentic-cli"));
      // The whole component must be free of secret content.
      const serialized = JSON.stringify(component);
      assert.ok(!serialized.includes("SECRET PROMPT"));
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("counts opencode providers and zcode plugins", () => {
    const root = createTempHome();
    try {
      const oc = join(root, "opencode");
      mkdirSync(join(oc, "plugins"), { recursive: true });
      writeFileSync(
        join(oc, "opencode.json"),
        JSON.stringify({
          provider: { openai: {}, anthropic: {} },
          model: "openai/gpt-4o",
        }),
      );
      writeFileSync(
        join(oc, "package.json"),
        JSON.stringify({
          dependencies: { "@opencode-ai/plugin": "1.15.0" },
        }),
      );
      writeFileSync(join(oc, "plugins", "git-ai.ts"), "export const x = 1;");
      const ocSignals = collectToolSignals("opencode", oc);
      assert.strictEqual(ocSignals.providerCount, 2);
      assert.strictEqual(ocSignals.hasDefaultModel, true);
      assert.strictEqual(ocSignals.pluginCount, 1);

      const ocComponent = componentForAgenticTool({
        tool: "opencode",
        name: "opencode",
        dir: oc,
      });
      assert.strictEqual(ocComponent.version, "1.15.0");
      assert.strictEqual(
        ocComponent.purl,
        "pkg:generic/cdxgen-agentic/opencode@1.15.0",
      );

      const zc = join(root, "zcode");
      const pluginDir = join(
        zc,
        "cli",
        "plugins",
        "cache",
        "official",
        "docs",
        "0.1.0",
        ".zcode-plugin",
      );
      mkdirSync(pluginDir, { recursive: true });
      writeFileSync(
        join(pluginDir, "plugin.json"),
        JSON.stringify({
          name: "docs",
          version: "0.1.0",
          license: "MIT",
          skills: "skills/docs.md",
          mcpServers: { docs: {} },
        }),
      );
      mkdirSync(join(zc, "cli"), { recursive: true });
      writeFileSync(
        join(zc, "cli", "config.json"),
        JSON.stringify({
          plugins: {
            enabledPlugins: { "docs@official": true, "x@official": false },
          },
        }),
      );
      const zcSignals = collectToolSignals("zcode", zc);
      assert.strictEqual(zcSignals.pluginCount, 2);
      assert.strictEqual(zcSignals.enabledPluginCount, 1);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("redacts the home directory prefix to a ~-relative path", () => {
    const home = os.homedir();
    assert.strictEqual(redactHomePath(join(home, ".kiro")), "~/.kiro");
    assert.strictEqual(redactHomePath(home), "~");
    // Paths outside the home directory are returned unchanged.
    assert.strictEqual(redactHomePath("/opt/tools/x"), "/opt/tools/x");
  });

  it("counts codex TOML and gemini settings MCP servers", () => {
    const root = createTempHome();
    try {
      const codex = join(root, ".codex");
      mkdirSync(codex, { recursive: true });
      writeFileSync(
        join(codex, "config.toml"),
        [
          "[mcp_servers.fs]",
          'command = "npx"',
          "",
          "[mcp_servers.git]",
          'command = "uvx"',
        ].join("\n"),
      );
      const codexSignals = collectToolSignals("codex", codex);
      assert.strictEqual(codexSignals.mcpServerCount, 2);

      const gemini = join(root, ".gemini");
      mkdirSync(gemini, { recursive: true });
      writeFileSync(
        join(gemini, "settings.json"),
        JSON.stringify({ mcpServers: { docs: {} } }),
      );
      const geminiSignals = collectToolSignals("gemini-cli", gemini);
      assert.strictEqual(geminiSignals.mcpServerCount, 1);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("collects mcp and agent counts for cursor, windsurf, goose, and crush", () => {
    const root = createTempHome();
    try {
      const cursor = join(root, ".cursor");
      mkdirSync(join(cursor, "agents"), { recursive: true });
      writeFileSync(
        join(cursor, "mcp.json"),
        JSON.stringify({ mcpServers: { fs: {}, git: {} } }),
      );
      writeFileSync(join(cursor, "agents", "reviewer.md"), "# reviewer");
      const cursorSignals = collectToolSignals("cursor", cursor);
      assert.strictEqual(cursorSignals.mcpServerCount, 2);
      assert.strictEqual(cursorSignals.agentCount, 1);

      const windsurf = join(root, "windsurf");
      mkdirSync(windsurf, { recursive: true });
      writeFileSync(
        join(windsurf, "mcp_config.json"),
        JSON.stringify({ mcpServers: { fs: {} } }),
      );
      assert.strictEqual(
        collectToolSignals("windsurf", windsurf).mcpServerCount,
        1,
      );

      const goose = join(root, "goose");
      mkdirSync(goose, { recursive: true });
      writeFileSync(
        join(goose, "config.yaml"),
        "extensions:\n  - developer\n  - computercontroller\n",
      );
      assert.strictEqual(collectToolSignals("goose", goose).extensionCount, 2);

      const crush = join(root, "crush");
      mkdirSync(crush, { recursive: true });
      writeFileSync(join(crush, "crush.json"), JSON.stringify({}));
      const crushSignals = collectToolSignals("crush", crush);
      // The fixture declares no MCP servers, so the property is absent
      // rather than zero.
      assert.strictEqual(crushSignals.mcpServerCount, undefined);
      writeFileSync(
        join(crush, "crush.json"),
        JSON.stringify({ mcp: { fs: {}, git: {} } }),
      );
      assert.strictEqual(collectToolSignals("crush", crush).mcpServerCount, 2);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("reads opencode.jsonc with comments and trailing commas", () => {
    const root = createTempHome();
    try {
      const oc = join(root, "opencode");
      mkdirSync(oc, { recursive: true });
      writeFileSync(
        join(oc, "opencode.jsonc"),
        [
          "{",
          "  // default model",
          '  "model": "openai/gpt-4o",',
          '  "provider": { "openai": {}, },',
          "}",
        ].join("\n"),
      );
      const signals = collectToolSignals("opencode", oc);
      assert.strictEqual(signals.providerCount, 1);
      assert.strictEqual(signals.hasDefaultModel, true);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("covers the AI editors and agent CLIs", () => {
    const tools = getAgenticToolDirs(os.tmpdir()).map((entry) => entry.tool);
    for (const tool of [
      "cursor",
      "kiro",
      "devin-desktop",
      "trae",
      "antigravity",
      "qoder",
      "void",
      "qwen-code",
      "factory-droid",
      "auggie",
      "continue",
      "cline-cli",
      "claude-desktop",
    ]) {
      assert.ok(tools.includes(tool), `expected ${tool}`);
    }
  });

  it("describes Cursor from a real home layout without copying secrets", () => {
    const home = join(IDE_FIXTURES, "cursor-macos-home");
    const found = discoverAgenticTools(home);
    const cursor = found.find((entry) => entry.tool === "cursor");
    assert.ok(cursor, "Cursor discovered");
    assert.strictEqual(cursor.ide, "cursor");
    const component = componentForAgenticTool(cursor, home);
    assert.strictEqual(getProp(component, "cdx:agentic:ide"), "cursor");
    assert.strictEqual(getProp(component, "cdx:agentic:mcpServerCount"), "2");
    assert.strictEqual(getProp(component, "cdx:agentic:extensionCount"), "4");
    assert.strictEqual(getProp(component, "cdx:agentic:ruleCount"), "1");
    assert.strictEqual(getProp(component, "cdx:agentic:skillCount"), "1");
    assert.strictEqual(
      getProp(component, "cdx:agentic:cliAllowRuleCount"),
      "2",
    );
    assert.strictEqual(getProp(component, "cdx:agentic:cliDenyRuleCount"), "1");
    assert.ok(component.tags.includes("ai-ide"));
    const serialized = JSON.stringify(component);
    assert.ok(!serialized.includes("fixture-not-a-token"));
    assert.ok(!serialized.includes("Shell(rm)"));
  });

  it("tells the Kiro editor apart from Kiro CLI on a host with both", () => {
    const home = join(IDE_FIXTURES, "linux-ide-lab-home");
    const tools = discoverAgenticTools(home).map((entry) => entry.tool);
    assert.ok(tools.includes("kiro"));
    assert.ok(!tools.includes("kiro-cli"), "no ~/.kiro/agents, so no CLI");
    assert.ok(tools.includes("devin-desktop"));
    assert.ok(tools.includes("trae"));
    const { components } = collectAgenticTools({ home });
    const kiro = components.find(
      (c) => getProp(c, "cdx:agentic:tool") === "kiro",
    );
    assert.strictEqual(getProp(kiro, "cdx:agentic:extensionCount"), "5");
    assert.strictEqual(getProp(kiro, "cdx:agentic:home"), "~/.kiro");
    // A fixture home is not this machine, so no installed Kiro is reported.
    assert.strictEqual(kiro.purl, "pkg:generic/cdxgen-agentic/kiro");
    assert.strictEqual(getProp(kiro, "cdx:agentic:ideInstallDir"), undefined);
  });

  it("counts MCP servers named across several files once", () => {
    const root = createTempHome();
    try {
      writeFileSync(
        join(root, "a.json"),
        JSON.stringify({ mcpServers: { git: {}, fs: {} } }),
      );
      writeFileSync(
        join(root, "b.json"),
        JSON.stringify({ "amp.mcpServers": { git: {}, web: {} } }),
      );
      writeFileSync(
        join(root, "c.json"),
        JSON.stringify({ amp: { mcpServers: { db: {} } } }),
      );
      assert.strictEqual(
        countConfiguredMcpServers(root, [
          { file: "a.json", key: "mcpServers" },
          { file: "b.json", key: "amp.mcpServers" },
          { file: "c.json", key: "amp.mcpServers" },
        ]),
        4,
      );
      assert.strictEqual(
        countConfiguredMcpServers(root, [
          { file: "missing.json", key: "mcpServers" },
        ]),
        undefined,
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("reads the Claude Code and Codex versions from their release links", () => {
    const root = createTempHome();
    try {
      const claudeRelease = join(
        root,
        ".local",
        "share",
        "claude",
        "versions",
        "2.1.278",
      );
      mkdirSync(claudeRelease, { recursive: true });
      mkdirSync(join(root, ".local", "bin"), { recursive: true });
      mkdirSync(join(root, ".claude"), { recursive: true });
      const codexRelease = join(
        root,
        ".codex",
        "packages",
        "standalone",
        "releases",
        "0.137.0-aarch64-apple-darwin",
      );
      mkdirSync(codexRelease, { recursive: true });
      try {
        symlinkSync(claudeRelease, join(root, ".local", "bin", "claude"));
        symlinkSync(
          codexRelease,
          join(root, ".codex", "packages", "standalone", "current"),
          "dir",
        );
      } catch (err) {
        // Windows without symlink rights cannot build this layout.
        if (os.platform() === "win32") {
          return;
        }
        throw err;
      }
      const claude = componentForAgenticTool(
        {
          tool: "claude-code",
          name: "Claude Code",
          dir: join(root, ".claude"),
        },
        root,
      );
      assert.strictEqual(claude.version, "2.1.278");
      assert.strictEqual(
        claude.purl,
        "pkg:generic/cdxgen-agentic/claude-code@2.1.278",
      );
      const codex = componentForAgenticTool(
        { tool: "codex", name: "OpenAI Codex CLI", dir: join(root, ".codex") },
        root,
      );
      assert.strictEqual(codex.version, "0.137.0");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("ignores the current user's XDG and APPDATA folders for another home", () => {
    const saved = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = join(os.tmpdir(), "not-this-home");
    try {
      const home = join(os.tmpdir(), "cdxgen-agentic-other-home");
      const crush = getAgenticToolDirs(home).find((e) => e.tool === "crush");
      assert.deepStrictEqual(crush.dirs.slice(0, 2), [
        join(home, ".config", "crush"),
        join(home, ".config", "crush"),
      ]);
    } finally {
      if (saved === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = saved;
      }
    }
  });

  it("names the editor only when it is installed", () => {
    const root = createTempHome();
    try {
      // The Cursor CLI alone creates ~/.cursor with its config.
      mkdirSync(join(root, ".cursor"), { recursive: true });
      writeFileSync(
        join(root, ".cursor", "cli-config.json"),
        JSON.stringify({ permissions: { allow: [], deny: [] } }),
      );
      const [cursor] = discoverAgenticTools(root).filter(
        (entry) => entry.tool === "cursor",
      );
      const component = componentForAgenticTool(cursor, root);
      assert.strictEqual(getProp(component, "cdx:agentic:ide"), undefined);
      assert.ok(!component.tags.includes("ai-ide"));
      assert.strictEqual(
        getProp(component, "cdx:agentic:cliAllowRuleCount"),
        "0",
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("does not block on a FIFO in place of a config file", () => {
    if (os.platform() === "win32") {
      return;
    }
    const root = createTempHome();
    try {
      mkdirSync(join(root, ".cursor"), { recursive: true });
      execFileSync("mkfifo", [join(root, ".cursor", "mcp.json")]);
      const started = Date.now();
      const signals = collectToolSignals(
        "cursor",
        join(root, ".cursor"),
        undefined,
        undefined,
        root,
      );
      assert.ok(Date.now() - started < 5000);
      assert.strictEqual(signals.mcpServerCount, undefined);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
