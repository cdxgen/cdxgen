import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { assert, describe, it, log } from "poku";

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
      assert.strictEqual(
        getProp(readmeComponent, "internal:SrcFile"),
        "README.md",
      );
      assert.strictEqual(readmeComponent["bom-ref"], "file:README.md");
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("keeps discovered AI agent inventory out of formulation", () => {
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
      assert.ok(
        !formulation.components?.some(
          (component) =>
            getProp(component, "cdx:agent:inventorySource") === "agent-file",
        ),
        "expected AI agent inventory to stay out of formulation components",
      );
      assert.ok(
        !formulation.services?.some(
          (service) =>
            getProp(service, "cdx:mcp:inventorySource") === "agent-file",
        ),
        "expected inferred MCP services to stay out of formulation services",
      );
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("keeps MCP config inventory out of formulation", () => {
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
      assert.ok(
        !formulation.components?.some(
          (component) => getProp(component, "cdx:file:kind") === "mcp-config",
        ),
        "expected MCP config inventory to stay out of formulation components",
      );
      assert.ok(
        !formulation.services?.some(
          (service) => service.name === "remoteGateway",
        ),
        "expected MCP config services to stay out of formulation services",
      );
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("keeps community AI inventory out of formulation", () => {
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
        !formulation.components?.some((component) =>
          ["opencode", "nanocoder", "langgraph", "crewai"].includes(
            getProp(component, "cdx:agent:framework"),
          ),
        ),
        "expected community AI inventory to stay out of formulation components",
      );
      assert.ok(
        !formulation.services?.some((service) =>
          ["remoteDocs", "planner", "nanocoderFs"].includes(service.name),
        ),
        "expected community AI services to stay out of formulation services",
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
        getProp(cargoComponent, "internal:SrcFile"),
        "Cargo.toml",
      );
      assert.strictEqual(
        cargoComponent["bom-ref"],
        "urn:cdxgen:formulation:cargo:Cargo.toml",
      );
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

describe("addFormulationSection() toolchains", () => {
  it("probes the scanning host's toolchains only when it describes that host", async () => {
    const esmock = (await import("esmock")).default;
    const collectEnvInfo = () => [
      {
        type: "platform",
        name: "ruby",
        version: "3.4.8",
        purl: "pkg:generic/ruby@3.4.8",
      },
    ];
    const collectOSCryptoLibs = () => [
      { type: "library", name: "libssl3", version: "3.0.13" },
    ];
    const { addFormulationSection: mocked } = await esmock(
      "./formulationParsers.js",
      {
        "./envcontext.js": { collectEnvInfo },
        "./cbomutils.js": { collectOSCryptoLibs },
      },
    );
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "cdxgen-formulation-"));
    try {
      const names = (options) =>
        mocked(tmpDir, { specVersion: 1.7, includeCrypto: true, ...options })
          .formulation[0].components.map((component) => component.name)
          .filter((name) => ["ruby", "libssl3"].includes(name))
          .sort();
      assert.deepStrictEqual(names({ projectType: ["ruby"] }), [
        "libssl3",
        "ruby",
      ]);
      assert.deepStrictEqual(names({ projectType: ["os"] }), [
        "libssl3",
        "ruby",
      ]);
      // universal matches every type, but a universal scan runs on the host
      assert.deepStrictEqual(names({ projectType: ["universal"] }), [
        "libssl3",
        "ruby",
      ]);
      assert.deepStrictEqual(names({ projectType: "js,docker" }), []);
      // An image was built elsewhere: the scanner's Ruby is not its Ruby
      for (const projectType of [["docker"], ["oci"], ["rootfs"]]) {
        assert.deepStrictEqual(names({ projectType }), [], projectType[0]);
      }
      // Formulation that CI, a profile or the cbom command turned on keeps
      // the toolchains but not the host's crypto material.
      assert.deepStrictEqual(
        names({ projectType: ["ruby"], formulationAutomatic: true }),
        ["ruby"],
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

const buildInputFixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "test",
  "data",
  "formulation-build-inputs",
);

// The toolchain probes spawn every build tool on the host; these tests are
// about file discovery, so the probes are replaced with an empty result.
async function addFormulationWithoutProbes() {
  const esmock = (await import("esmock")).default;
  const { addFormulationSection: mocked } = await esmock(
    "./formulationParsers.js",
    { "./envcontext.js": { collectEnvInfo: () => [] } },
  );
  return mocked;
}

function copyBuildInputFixtures(tmpDir) {
  for (const name of readdirSync(buildInputFixtures)) {
    copyFileSync(path.join(buildInputFixtures, name), path.join(tmpDir, name));
  }
  mkdirSync(path.join(tmpDir, "native"));
  copyFileSync(
    path.join(buildInputFixtures, "Makefile"),
    path.join(tmpDir, "native", "Makefile"),
  );
}

describe("addFormulationSection() build inputs", () => {
  it("adds make, CMake, go.mod, pip and .NET build inputs with relative paths", async () => {
    const addFormulation = await addFormulationWithoutProbes();
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "cdxgen-formulation-"));
    try {
      copyBuildInputFixtures(tmpDir);
      const components = addFormulation(tmpDir, {
        specVersion: 1.7,
        projectType: ["universal"],
      }).formulation[0].components.filter((component) =>
        getProp(component, "cdx:build:tool"),
      );
      const sources = components
        .map(
          (component) =>
            `${getProp(component, "cdx:build:tool")}:${getProp(component, "internal:SrcFile")}`,
        )
        .sort();
      assert.deepStrictEqual(sources, [
        "cmake:CMakeLists.txt",
        "go:go.mod",
        "make:Makefile",
        "make:native/Makefile",
        "nuget:Demo.csproj",
        "nuget:project.assets.json",
        "pip:constraints.txt",
        "pip:requirements.txt",
      ]);
      for (const component of components) {
        assert.ok(
          !JSON.stringify(component).includes(tmpDir),
          `${component["bom-ref"]} must not carry the scan directory`,
        );
        assert.ok(
          component["bom-ref"].endsWith(
            `:${getProp(component, "internal:SrcFile")}`,
          ),
        );
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("skips build-input, CI and README discovery for an OS inventory", async () => {
    const addFormulation = await addFormulationWithoutProbes();
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "cdxgen-formulation-"));
    try {
      copyBuildInputFixtures(tmpDir);
      mkdirSync(path.join(tmpDir, ".github", "workflows"), { recursive: true });
      writeFileSync(
        path.join(tmpDir, ".github", "workflows", "ci.yml"),
        "on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n",
      );
      writeFileSync(path.join(tmpDir, "README.md"), "# Demo\n\u200B\n");
      for (const projectType of [["os"], ["linux"], "windows"]) {
        const formulation = addFormulation(tmpDir, {
          specVersion: 1.7,
          projectType,
        }).formulation[0];
        assert.ok(
          !formulation.components.some(
            (component) =>
              getProp(component, "cdx:build:tool") ||
              getProp(component, "cdx:file:kind") === "readme",
          ),
          `${projectType} must not read build inputs or READMEs`,
        );
        assert.ok(
          !formulation.workflows.some((workflow) => workflow.name === "ci"),
          `${projectType} must not read CI workflow files`,
        );
      }
      // A mixed request still describes a project tree.
      const mixed = addFormulation(tmpDir, {
        specVersion: 1.7,
        projectType: ["os", "js"],
      }).formulation[0];
      assert.ok(
        mixed.components.some((component) =>
          getProp(component, "cdx:build:tool"),
        ),
      );
      assert.ok(mixed.workflows.some((workflow) => workflow.name === "ci"));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("removes userinfo, query strings and fragments from environment URLs", async () => {
    const addFormulation = await addFormulationWithoutProbes();
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "cdxgen-formulation-"));
    const variables = {
      CARGO_REGISTRIES_INTERNAL_INDEX:
        "sparse+https://ci:hunter2@registry.example.com/index/",
      MAVEN_MIRROR_URL:
        "https://repo.example.com/maven2?sig=abc123#frag https://ci:hunter2@mirror.example.com:8443",
      GRADLE_DIST:
        "file:///opt/gradle,https://ci:hunter2@dl.example.com/g.zip?x=1",
      // URL parsers accept these characters in a userinfo and a query.
      GEM_MIRROR: "https://ci:hun;ter2@gems.example.com/a",
      CONDA_MIRROR: "https://ci:hun,ter2@conda.example.com/b",
      SCALA_MIRROR: "https://ci:hun'ter2@scala.example.com/c",
      RUSTUP_DIST_SERVER: 'https://ci:hun"ter2@rust.example.com',
      DENO_MIRROR: "https://deno.example.com/d;v=1?sv=1;sig=abc123 tail",
      GIT_MIRRORS: "https://a.example.com,https://ci:hunter2@b.example.com/x",
    };
    const saved = Object.fromEntries(
      Object.keys(variables).map((name) => [name, process.env[name]]),
    );
    try {
      Object.assign(process.env, variables);
      const environmentVars =
        addFormulation(tmpDir, { specVersion: 1.7 }).formulation[0].workflows[0]
          .inputs?.[0]?.environmentVars || [];
      const value = (name) =>
        environmentVars.find((variable) => variable.name === name)?.value;
      assert.strictEqual(
        value("CARGO_REGISTRIES_INTERNAL_INDEX"),
        "sparse+https://registry.example.com/index/",
      );
      assert.strictEqual(
        value("MAVEN_MIRROR_URL"),
        "https://repo.example.com/maven2 https://mirror.example.com:8443",
      );
      assert.strictEqual(
        value("GRADLE_DIST"),
        "file:///opt/gradle,https://dl.example.com/g.zip",
      );
      assert.strictEqual(value("GEM_MIRROR"), "https://gems.example.com/a");
      assert.strictEqual(value("CONDA_MIRROR"), "https://conda.example.com/b");
      assert.strictEqual(value("SCALA_MIRROR"), "https://scala.example.com/c");
      assert.strictEqual(
        value("RUSTUP_DIST_SERVER"),
        "https://rust.example.com",
      );
      assert.strictEqual(
        value("DENO_MIRROR"),
        "https://deno.example.com/d;v=1 tail",
      );
      assert.strictEqual(
        value("GIT_MIRRORS"),
        "https://a.example.com,https://b.example.com/x",
      );
      const text = JSON.stringify(environmentVars);
      for (const secret of ["hunter2", "ter2", "abc123", "frag"]) {
        assert.ok(!text.includes(secret), `${secret} must not be recorded`);
      }
    } finally {
      for (const [name, original] of Object.entries(saved)) {
        if (original === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = original;
        }
      }
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("addFormulationSection() parser output", () => {
  it("sanitizes the text a registered parser returns", async () => {
    const esmock = (await import("esmock")).default;
    // A module instance of its own, so the parser stays out of other tests.
    const { addFormulationSection: addFormulation, registerParser } =
      await esmock("./formulationParsers.js", {
        "./envcontext.js": { collectEnvInfo: () => [] },
      });
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "cdxgen-formulation-"));
    try {
      writeFileSync(path.join(tmpDir, "cdxgen-test-pipeline.txt"), "x");
      registerParser({
        id: "cdxgen-test-pipeline",
        patterns: ["**/cdxgen-test-pipeline.txt"],
        parse: () => ({
          workflows: [
            {
              "bom-ref": "test-workflow",
              uid: "test-workflow",
              name: "deploy to https://ci:hunter2@deploy.example.com/",
              taskTypes: ["build"],
              tasks: [
                {
                  "bom-ref": "test-task",
                  uid: "test-task",
                  name: "push",
                  taskTypes: ["build"],
                  steps: [
                    {
                      name: "push",
                      commands: [
                        { executed: "curl https://h.example.com/x?sig=abc123" },
                      ],
                    },
                  ],
                  properties: [
                    { name: "cdx:test:url", value: "https://ci:hunter2@h/" },
                  ],
                },
              ],
            },
          ],
        }),
      });
      const workflow = addFormulation(tmpDir, {
        specVersion: 1.7,
      }).formulation[0].workflows.find((w) => w["bom-ref"] === "test-workflow");
      const text = JSON.stringify(workflow);
      assert.ok(!text.includes("hunter2"));
      assert.ok(!text.includes("abc123"));
      assert.strictEqual(
        workflow.name,
        "deploy to https://deploy.example.com/",
      );
      assert.strictEqual(
        workflow.tasks[0].steps[0].commands[0].executed,
        "curl https://h.example.com/x",
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// The formulation records the branch and the tracked files of a git working
// tree. A directory git cannot describe has neither, and git's own error text
// must not appear in their place.
function assertNoGitErrorText(result) {
  const formulation = result.formulation[0];
  const environmentVars =
    formulation.workflows?.[0]?.inputs?.[0]?.environmentVars ?? [];
  assert.strictEqual(
    environmentVars.find((variable) => variable.name === "internal:GIT_BRANCH"),
    undefined,
    "internal:GIT_BRANCH must be absent",
  );
  const errorTextComponents = formulation.components.filter(
    (component) =>
      component.name === ".git" ||
      component.name === "HEAD" ||
      component.version === "a",
  );
  assert.deepEqual(errorTextComponents, []);
}

describe("addFormulationSection() without git metadata", () => {
  it("records no branch or git file components outside a git working tree", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "cdxgen-formulation-"));
    try {
      const probe = spawnSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: tmpDir,
        encoding: "utf-8",
      });
      if (probe.status === 0) {
        // The assertions need a directory no repository claims. A host that
        // keeps its temporary directory inside a git work tree fails this
        // condition; the test yields rather than report a broken builder.
        log(
          `not running outside a git working tree: ${tmpDir} belongs to ${probe.stdout.trim()}`,
        );
        return;
      }
      assertNoGitErrorText(addFormulationSection(tmpDir, { specVersion: 1.6 }));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("records no branch or git file components in a repository with no commit", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "cdxgen-formulation-"));
    try {
      const init = spawnSync("git", ["init", "-q", tmpDir], {
        encoding: "utf-8",
      });
      assert.ok(init.status === 0, `git init failed: ${init.stderr}`);
      assertNoGitErrorText(addFormulationSection(tmpDir, { specVersion: 1.6 }));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
