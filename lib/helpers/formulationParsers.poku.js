import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  it("adds AI agent instruction components and inferred MCP endpoints", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "cdxgen-formulation-"));
    mkdirSync(path.join(tmpDir, ".github"), { recursive: true });
    writeFileSync(
      path.join(tmpDir, "AGENTS.md"),
      [
        "# Agent policy",
        "",
        "Connect to http://localhost:3000/mcp for local testing.",
        "Connect to https://demo.ngrok-free.app/mcp for remote validation.",
        "Use @acme/mcp-server if you need a wrapper.",
        "Bearer sk_test_agent_token_value",
        "<!-- hidden \u200B prompt -->",
      ].join("\n"),
    );
    writeFileSync(
      path.join(tmpDir, ".github", "copilot-instructions.md"),
      "Use Anthropic and Gemini for model routing.",
    );

    try {
      const result = addFormulationSection(tmpDir, { specVersion: 1.7 });
      const formulation = result.formulation[0];
      const agentComponent = formulation.components.find(
        (component) =>
          getProp(component, "cdx:agent:inventorySource") === "agent-file",
      );
      assert.ok(agentComponent, "expected AI agent formulation component");
      assert.strictEqual(
        getProp(agentComponent, "cdx:file:hasHiddenUnicode"),
        "true",
      );
      assert.strictEqual(
        getProp(agentComponent, "cdx:agent:hasPublicMcpEndpoint"),
        "true",
      );
      assert.strictEqual(
        getProp(agentComponent, "cdx:agent:hasTunnelReference"),
        "true",
      );
      assert.strictEqual(
        getProp(agentComponent, "cdx:agent:hasNonOfficialMcpReference"),
        "true",
      );
      assert.strictEqual(
        getProp(agentComponent, "cdx:agent:credentialExposure"),
        "true",
      );
      assert.match(getProp(agentComponent, "cdx:agent:hiddenMcpUrls"), /ngrok/);
      assert.ok(
        formulation.services?.some(
          (service) =>
            getProp(service, "cdx:mcp:inventorySource") === "agent-file" &&
            service.endpoints?.some((endpoint) => endpoint.includes("/mcp")),
        ),
        "expected inferred MCP service from AI agent file",
      );
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("adds MCP config components and configured services from client config files", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "cdxgen-formulation-"));
    mkdirSync(path.join(tmpDir, ".vscode"), { recursive: true });
    writeFileSync(
      path.join(tmpDir, ".vscode", "mcp.json"),
      JSON.stringify(
        {
          mcpServers: {
            localFs: {
              args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
              command: "npx",
              env: {
                OPENAI_API_KEY: "$OPENAI_API_KEY",
              },
            },
            remoteGateway: {
              auth: {
                registration_endpoint: "https://auth.example.com/register",
              },
              client_id: "shared-static-client",
              endpoint: "https://demo.ngrok-free.app/mcp",
              headers: {
                Authorization: "Bearer sk_test_config_token_value",
              },
              passthroughToken: true,
              transport: "http",
            },
          },
        },
        null,
        2,
      ),
    );

    try {
      const result = addFormulationSection(tmpDir, { specVersion: 1.7 });
      const formulation = result.formulation[0];
      const configComponent = formulation.components.find(
        (component) => getProp(component, "cdx:file:kind") === "mcp-config",
      );
      assert.ok(configComponent, "expected MCP config formulation component");
      assert.strictEqual(
        getProp(configComponent, "cdx:mcp:configuredServiceCount"),
        "2",
      );
      assert.strictEqual(
        getProp(configComponent, "cdx:mcp:credentialExposure"),
        "true",
      );
      const remoteService = formulation.services?.find(
        (service) => service.name === "remoteGateway",
      );
      assert.ok(remoteService, "expected remote configured MCP service");
      assert.strictEqual(
        getProp(remoteService, "cdx:mcp:inventorySource"),
        "config-file",
      );
      assert.strictEqual(
        getProp(remoteService, "cdx:mcp:security:confusedDeputyRisk"),
        "high",
      );
      assert.strictEqual(
        getProp(remoteService, "cdx:mcp:security:tokenPassthroughRisk"),
        "high",
      );
      assert.strictEqual(
        getProp(remoteService, "cdx:mcp:credentialExposure"),
        "true",
      );
      assert.strictEqual(
        getProp(remoteService, "cdx:mcp:auth:supportsDCR"),
        "true",
      );
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("discovers community provider agents, tools, skills, and config-derived services", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "cdxgen-formulation-"));
    mkdirSync(path.join(tmpDir, ".opencode", "agents"), { recursive: true });
    mkdirSync(path.join(tmpDir, ".opencode", "tools"), { recursive: true });
    mkdirSync(path.join(tmpDir, ".opencode", "skills", "git-release"), {
      recursive: true,
    });
    mkdirSync(path.join(tmpDir, ".nanocoder", "agents"), { recursive: true });
    mkdirSync(path.join(tmpDir, ".nanocoder", "commands"), {
      recursive: true,
    });
    mkdirSync(path.join(tmpDir, "config"), { recursive: true });
    writeFileSync(
      path.join(tmpDir, "opencode.jsonc"),
      `{
        // opencode project config
        "agent": {
          "reviewer": {
            "description": "Review changes for security issues",
            "mode": "subagent",
            "model": "anthropic/claude-sonnet-4-20250514"
          }
        },
        "mcp": {
          "remoteDocs": {
            "type": "remote",
            "url": "https://docs.example.com/mcp",
            "oauth": {}
          }
        }
      }`,
    );
    writeFileSync(
      path.join(tmpDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          nanocoderFs: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "./src"],
            env: {
              GITHUB_TOKEN: "$GITHUB_TOKEN",
            },
            transport: "stdio",
          },
        },
      }),
    );
    writeFileSync(
      path.join(tmpDir, ".opencode", "agents", "review.md"),
      [
        "---",
        "description: Reviews code for bugs and quality",
        "mode: subagent",
        "model: anthropic/claude-sonnet-4-20250514",
        "---",
        "Focus on code review findings.",
      ].join("\n"),
    );
    writeFileSync(
      path.join(tmpDir, ".opencode", "tools", "database.ts"),
      [
        'import { tool } from "@opencode-ai/plugin";',
        "",
        "export default tool({",
        '  description: "Query the project database",',
        "  args: {},",
        "  async execute() {",
        '    return "ok";',
        "  },",
        "});",
      ].join("\n"),
    );
    writeFileSync(
      path.join(tmpDir, ".opencode", "skills", "git-release", "SKILL.md"),
      [
        "---",
        "name: git-release",
        "description: Prepare consistent releases",
        "license: MIT",
        "compatibility: opencode",
        "---",
        "Use this skill when preparing a release.",
      ].join("\n"),
    );
    writeFileSync(
      path.join(tmpDir, ".nanocoder", "agents", "researcher.md"),
      [
        "---",
        "name: researcher",
        "description: Researches code and docs",
        "model: inherit",
        "tools:",
        "  - read_file",
        "  - search_file_contents",
        "---",
        "Search first, then summarize.",
      ].join("\n"),
    );
    writeFileSync(
      path.join(tmpDir, ".nanocoder", "commands", "fix.md"),
      [
        "---",
        "description: Apply the standard fix workflow",
        "category: engineering",
        "tags: [bugfix, workflow]",
        "triggers: [fix bug, repair issue]",
        "---",
        "1. Reproduce the issue",
        "2. Fix it",
      ].join("\n"),
    );
    writeFileSync(
      path.join(tmpDir, "langgraph.json"),
      JSON.stringify({
        dependencies: ["langchain_openai", "./graphs"],
        env: ".env",
        graphs: {
          planner: "./graphs/planner.py:graph",
        },
      }),
    );
    writeFileSync(
      path.join(tmpDir, "config", "agents.yaml"),
      [
        "researcher:",
        '  role: "Researcher"',
        '  goal: "Find the best answer"',
        '  backstory: "Helpful teammate"',
        "  tools:",
        "    - search_docs",
      ].join("\n"),
    );
    writeFileSync(
      path.join(tmpDir, "agents.py"),
      [
        "from crewai import Agent",
        "",
        "class CustomAgents:",
        "    def researcher(self):",
        "        return Agent(",
        '            role="Researcher",',
        '            goal="Find answers",',
        '            backstory="Helpful teammate",',
        "        )",
      ].join("\n"),
    );

    try {
      const result = addFormulationSection(tmpDir, { specVersion: 1.7 });
      const formulation = result.formulation[0];
      assert.ok(
        formulation.components.some(
          (component) =>
            getProp(component, "cdx:agent:framework") === "opencode" &&
            getProp(component, "cdx:file:kind") === "agent-definition",
        ),
        "expected OpenCode agent component",
      );
      assert.ok(
        formulation.components.some(
          (component) =>
            getProp(component, "cdx:file:kind") === "skill-file" &&
            getProp(component, "cdx:skill:name") === "git-release",
        ),
        "expected skill file component",
      );
      assert.ok(
        formulation.components.some(
          (component) =>
            getProp(component, "cdx:agent:framework") === "nanocoder" &&
            getProp(component, "cdx:file:kind") === "custom-command",
        ),
        "expected Nanocoder custom command component",
      );
      assert.ok(
        formulation.components.some(
          (component) =>
            getProp(component, "cdx:agent:framework") === "langgraph" &&
            getProp(component, "cdx:agent:role") === "langgraph-graph",
        ),
        "expected LangGraph graph component",
      );
      assert.ok(
        formulation.components.some(
          (component) =>
            getProp(component, "cdx:agent:framework") === "crewai" &&
            getProp(component, "cdx:agent:role") === "crew-agent",
        ),
        "expected CrewAI agent component",
      );
      assert.ok(
        formulation.services?.some(
          (service) =>
            service.name === "remoteDocs" &&
            getProp(service, "cdx:mcp:inventorySource") === "config-file",
        ),
        "expected OpenCode MCP service",
      );
      assert.ok(
        formulation.services?.some(
          (service) =>
            service.name === "planner" &&
            getProp(service, "cdx:agent:framework") === "langgraph",
        ),
        "expected LangGraph service",
      );
      assert.ok(
        formulation.services?.some(
          (service) =>
            service.name === "nanocoderFs" &&
            getProp(service, "cdx:mcp:configFormat") === "dot-mcp-json",
        ),
        "expected .mcp.json service",
      );
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("adds Cargo and maturin formulation components for Rust build context", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "cdxgen-formulation-"));
    writeFileSync(
      path.join(tmpDir, "Cargo.toml"),
      `[package]
name = "cargo-demo"
version = "1.0.0"
build = "build.rs"
rust-version = "1.78"

[build-dependencies]
cc = "1.0.0"
openssl-sys = "0.9.0"

[profile.release]
lto = true
`,
    );
    writeFileSync(
      path.join(tmpDir, "build.rs"),
      [
        'println!("cargo:rustc-link-lib=ssl");',
        'std::process::Command::new("cc");',
        'std::fs::write("generated.rs", "");',
      ].join("\n"),
    );
    writeFileSync(
      path.join(tmpDir, "pyproject.toml"),
      `[build-system]
requires = ["maturin>=1.0,<2.0"]
build-backend = "maturin"

[project]
name = "maturin-demo"

[tool.maturin]
bindings = "pyo3"
module-name = "maturin_demo._native"
features = ["pyo3/extension-module"]
`,
    );

    try {
      const result = addFormulationSection(tmpDir, { specVersion: 1.7 });
      const formulation = result.formulation[0];
      const cargoComponent = formulation.components.find(
        (component) => getProp(component, "cdx:rust:buildTool") === "cargo",
      );
      const maturinComponent = formulation.components.find(
        (component) => getProp(component, "cdx:rust:buildTool") === "maturin",
      );
      assert.ok(cargoComponent, "expected cargo formulation component");
      assert.strictEqual(
        getProp(cargoComponent, "cdx:cargo:hasNativeBuild"),
        "true",
      );
      assert.strictEqual(
        getProp(cargoComponent, "cdx:cargo:nativeBuildIndicators"),
        "cc, openssl-sys",
      );
      assert.strictEqual(
        getProp(cargoComponent, "cdx:cargo:hasBuildScript"),
        "true",
      );
      assert.match(
        getProp(cargoComponent, "cdx:cargo:buildScriptCapabilities"),
        /process-execution/,
      );
      assert.match(
        getProp(cargoComponent, "cdx:cargo:buildScriptCapabilities"),
        /linker-directives/,
      );
      assert.match(
        getProp(cargoComponent, "cdx:cargo:buildScriptCapabilities"),
        /file-generation/,
      );
      assert.strictEqual(
        getProp(cargoComponent, "cdx:cargo:rustVersion"),
        "1.78",
      );
      assert.strictEqual(
        getProp(cargoComponent, "cdx:cargo:releaseProfiles"),
        "release",
      );
      assert.ok(maturinComponent, "expected maturin formulation component");
      assert.strictEqual(
        getProp(maturinComponent, "cdx:maturin:buildBackend"),
        "maturin",
      );
      assert.strictEqual(
        getProp(maturinComponent, "cdx:maturin:bindings"),
        "pyo3",
      );
      assert.strictEqual(
        getProp(maturinComponent, "cdx:maturin:moduleName"),
        "maturin_demo._native",
      );
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("adds virtual-workspace formulation metadata for Cargo workspaces", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "cdxgen-formulation-"));
    const memberDir = path.join(tmpDir, "crates", "member-a");
    mkdirSync(memberDir, { recursive: true });
    writeFileSync(
      path.join(tmpDir, "Cargo.toml"),
      `[workspace]
members = ["crates/*"]
`,
    );
    writeFileSync(
      path.join(memberDir, "Cargo.toml"),
      `[package]
name = "member-a"
version = "1.0.0"
`,
    );

    try {
      const result = addFormulationSection(tmpDir, { specVersion: 1.7 });
      const formulation = result.formulation[0];
      const workspaceComponent = formulation.components.find(
        (component) =>
          getProp(component, "cdx:cargo:manifestMode") === "workspace",
      );
      assert.ok(
        workspaceComponent,
        "expected cargo workspace formulation component",
      );
      assert.strictEqual(
        getProp(workspaceComponent, "cdx:cargo:hasWorkspaceMembers"),
        "true",
      );
      assert.strictEqual(
        getProp(workspaceComponent, "cdx:cargo:workspaceMembers"),
        "crates/*",
      );
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });
});
