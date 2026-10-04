import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import esmock from "esmock";
import { assert, describe, it } from "poku";
import sinon from "sinon";

import {
  getRecordedActivities,
  resetRecordedActivities,
  setDryRunMode,
} from "../ecosystems/utils.js";
import { auditBom } from "../stages/postgen/auditBom.js";
import { postProcess } from "../stages/postgen/postgen.js";
import { validateBom } from "../validator/bomValidator.js";
import {
  cacheDisableFixtureDir,
  getProp,
  mcpFixtureDir,
  pyLockSmokeFixtureDir,
  uvSmokeFixtureDir,
} from "./bomTestHelpers.poku.js";
import { createBom } from "./index.js";
import { createNodejsBom } from "./jsBom.js";
import {
  createCsharpBom,
  createPythonBom,
  createRubyBom,
} from "./managedBom.js";

describe("managedBom", () => {
  describe("createBom() Collider lock support", () => {
    it("preserves Collider integrity metadata and dependency nodes in the BOM", async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cdxgen-collider-"));
      writeFileSync(
        join(tmpDir, "collider.lock"),
        JSON.stringify(
          {
            version: 1,
            dependencies: {
              fmt: {
                version: "11.0.2",
                wrap_hash: `sha256:${"a".repeat(64)}`,
                origin: "https://packages.example.com/collider/v2/",
              },
            },
            packages: {
              fast_float: {
                version: "8.0.2",
                wrap_hash: `sha256:${"b".repeat(64)}`,
                origin: "https://wrapdb.mesonbuild.com/v2/",
              },
            },
          },
          null,
          2,
        ),
      );
      try {
        const bomNSData = await createBom(tmpDir, {
          failOnError: true,
          installDeps: false,
          multiProject: false,
          projectType: ["collider"],
          specVersion: 1.7,
        });
        const bomJson = bomNSData?.bomJson || {};
        const fmtComponent = (bomJson.components || []).find(
          (component) => component.name === "fmt",
        );
        const transitiveComponent = (bomJson.components || []).find(
          (component) => component.name === "fast_float",
        );
        assert.ok(fmtComponent);
        assert.ok(transitiveComponent);
        assert.deepStrictEqual(
          getProp(fmtComponent, "cdx:collider:origin"),
          "https://packages.example.com/collider/v2/",
        );
        assert.deepStrictEqual(
          getProp(fmtComponent, "cdx:collider:hasWrapHash"),
          "true",
        );
        assert.deepStrictEqual(
          getProp(transitiveComponent, "cdx:collider:dependencyKind"),
          "transitive",
        );
        assert.deepStrictEqual(fmtComponent.hashes, [
          {
            alg: "SHA-256",
            content: "a".repeat(64),
          },
        ]);
        assert.deepStrictEqual(fmtComponent.externalReferences, [
          {
            type: "distribution",
            url: "https://packages.example.com/collider/v2/",
          },
        ]);
        const parentDependency = (bomJson.dependencies || []).find(
          (dependency) =>
            dependency.ref === bomJson.metadata.component["bom-ref"],
        );
        assert.ok(parentDependency);
        assert.deepStrictEqual(parentDependency.dependsOn, [
          "pkg:generic/fmt@11.0.2",
        ]);
        assert.ok(
          (bomJson.dependencies || []).some(
            (dependency) =>
              dependency.ref === "pkg:generic/fmt@11.0.2" &&
              dependency.dependsOn.length === 0,
          ),
        );
        assert.ok(
          (bomJson.dependencies || []).some(
            (dependency) =>
              dependency.ref === "pkg:generic/fast_float@8.0.2" &&
              dependency.dependsOn.length === 0,
          ),
        );
      } finally {
        rmSync(tmpDir, { force: true, recursive: true });
      }
    });
  });

  describe("createBom() MCP inventory support", () => {
    it("catalogs MCP services, primitives, and audit findings for JavaScript projects", async () => {
      const options = {
        bomAudit: true,
        bomAuditCategories: "mcp-server",
        bomAuditMinSeverity: "low",
        failOnError: true,
        installDeps: false,
        multiProject: false,
        projectType: ["js"],
        specVersion: 1.7,
      };
      const bomNSData = await createBom(mcpFixtureDir, options);
      const processedBomNSData = await postProcess(
        bomNSData,
        options,
        mcpFixtureDir,
      );
      const bomJson = processedBomNSData?.bomJson || {};
      const officialSdk = (bomJson.components || []).find(
        (component) =>
          component.purl ===
          "pkg:npm/%40modelcontextprotocol/server@2.0.0-alpha.0",
      );
      const wrapperSdk = (bomJson.components || []).find(
        (component) => component.purl === "pkg:npm/%40acme/mcp-server@0.1.0",
      );
      assert.ok(officialSdk);
      assert.ok(
        officialSdk.tags?.includes("official-mcp-sdk"),
        "expected official MCP SDK tags",
      );
      assert.ok(wrapperSdk);
      assert.ok(
        wrapperSdk.properties?.some(
          (property) =>
            property.name === "cdx:mcp:official" && property.value === "false",
        ),
        "expected non-official MCP wrapper signal",
      );
      assert.strictEqual((bomJson.services || []).length, 2);
      const unsafeService = (bomJson.services || []).find(
        (service) => service.name === "unsafe-http-server",
      );
      const authService = (bomJson.services || []).find(
        (service) => service.name === "auth-http-server",
      );
      assert.ok(unsafeService);
      assert.strictEqual(unsafeService.authenticated, false);
      assert.ok(authService);
      assert.strictEqual(authService.authenticated, true);
      assert.ok(
        (bomJson.dependencies || []).some(
          (dependency) =>
            dependency.ref === unsafeService["bom-ref"] &&
            dependency.provides.length >= 1,
        ),
      );
      const findings = await auditBom(bomJson, {
        bomAuditCategories: "mcp-server",
        bomAuditMinSeverity: "low",
      });
      assert.ok(findings.some((finding) => finding.ruleId === "MCP-001"));
      assert.ok(findings.some((finding) => finding.ruleId === "MCP-002"));
      assert.ok(findings.some((finding) => finding.ruleId === "MCP-003"));
    });

    it("supports the ai-inventory audit category alias for MCP discovery", async () => {
      const options = {
        bomAudit: true,
        bomAuditCategories: "ai-inventory",
        bomAuditMinSeverity: "low",
        failOnError: true,
        installDeps: false,
        multiProject: false,
        projectType: ["js"],
        specVersion: 1.7,
      };
      const bomNSData = await createBom(mcpFixtureDir, options);
      const processedBomNSData = await postProcess(
        bomNSData,
        options,
        mcpFixtureDir,
      );
      const bomJson = processedBomNSData?.bomJson || {};
      assert.ok(
        (bomJson.services || []).some(
          (service) => service.name === "unsafe-http-server",
        ),
      );
      const findings = await auditBom(bomJson, {
        bomAuditCategories: "ai-inventory",
        bomAuditMinSeverity: "low",
      });
      assert.ok(findings.some((finding) => finding.ruleId === "MCP-001"));
    });

    it("supports the dedicated mcp project type alias", async () => {
      const options = {
        bomAudit: false,
        failOnError: true,
        installDeps: false,
        multiProject: false,
        projectType: ["mcp"],
        specVersion: 1.7,
      };
      const bomNSData = await createBom(mcpFixtureDir, options);
      const processedBomNSData = await postProcess(
        bomNSData,
        options,
        mcpFixtureDir,
      );
      const bomJson = processedBomNSData?.bomJson || {};
      assert.ok(
        (bomJson.services || []).some(
          (service) => service.name === "unsafe-http-server",
        ),
      );
      assert.ok(
        (bomJson.components || []).some(
          (component) =>
            component.purl ===
            "pkg:npm/%40modelcontextprotocol/server@2.0.0-alpha.0",
        ),
      );
    });

    it("flags disabled setup caches for npm, Python, and Cargo fixtures", async () => {
      const options = {
        bomAudit: true,
        bomAuditCategories: "ci-permission",
        bomAuditMinSeverity: "low",
        failOnError: true,
        includeFormulation: true,
        installDeps: false,
        multiProject: true,
        projectType: ["js", "python", "cargo", "github"],
        specVersion: 1.7,
      };
      const bomNSData = await createBom(cacheDisableFixtureDir, options);
      const processedBomNSData = await postProcess(
        bomNSData,
        options,
        cacheDisableFixtureDir,
      );
      const bomJson = processedBomNSData?.bomJson || {};
      const setupNodeComponent = (bomJson.components || []).find(
        (component) =>
          getProp(component, "cdx:github:action:uses") ===
          "actions/setup-node@v4",
      );
      const setupPythonComponent = (bomJson.components || []).find(
        (component) =>
          getProp(component, "cdx:github:action:uses") ===
          "actions/setup-python@v5",
      );
      const setupRustComponent = (bomJson.components || []).find(
        (component) =>
          getProp(component, "cdx:github:action:uses") ===
          "moonrepo/setup-rust@v1",
      );
      const npmComponent = (bomJson.components || []).find((component) =>
        component.purl?.startsWith("pkg:npm/left-pad@1.3.0"),
      );
      const pythonComponent = (bomJson.components || []).find((component) =>
        component.purl?.startsWith("pkg:pypi/anyio@4.6.0"),
      );
      const cargoComponent = (bomJson.components || []).find(
        (component) =>
          component.name === "git-crate" &&
          getProp(component, "cdx:cargo:git") ===
            "https://github.com/acme/git-crate.git",
      );
      const cargoRunComponent = (bomJson.components || []).find((component) =>
        component.properties?.some(
          (property) =>
            property.name === "cdx:github:step:cargoSubcommands" &&
            property.value === "build",
        ),
      );
      assert.ok(setupNodeComponent, "expected setup-node workflow component");
      assert.ok(
        setupPythonComponent,
        "expected setup-python workflow component",
      );
      assert.ok(setupRustComponent, "expected setup-rust workflow component");
      assert.strictEqual(
        getProp(setupNodeComponent, "cdx:github:action:disablesBuildCache"),
        "true",
      );
      assert.strictEqual(
        getProp(setupPythonComponent, "cdx:github:action:disablesBuildCache"),
        "true",
      );
      assert.strictEqual(
        getProp(setupRustComponent, "cdx:github:action:disablesBuildCache"),
        "true",
      );
      assert.strictEqual(
        getProp(setupRustComponent, "cdx:github:action:buildCacheEcosystem"),
        "cargo",
      );
      assert.strictEqual(
        getProp(setupRustComponent, "cdx:github:action:buildCacheDisableInput"),
        "cache",
      );
      assert.ok(npmComponent, "expected npm dependency from package-lock");
      assert.ok(pythonComponent, "expected PyPI dependency from uv.lock");
      assert.ok(cargoComponent, "expected Cargo dependency from Cargo.toml");
      assert.ok(cargoRunComponent, "expected Cargo run step component");
      assert.strictEqual(
        getProp(npmComponent, "cdx:npm:manifestSourceType"),
        "url",
      );
      assert.strictEqual(
        getProp(pythonComponent, "cdx:pypi:manifestSourceType"),
        "url",
      );
      assert.strictEqual(
        getProp(cargoComponent, "cdx:cargo:git"),
        "https://github.com/acme/git-crate.git",
      );
      assert.strictEqual(
        getProp(cargoComponent, "cdx:cargo:gitBranch"),
        "main",
      );
      assert.strictEqual(
        getProp(cargoRunComponent, "cdx:github:step:usesCargo"),
        "true",
      );

      const findings = await auditBom(bomJson, {
        bomAuditCategories: "ci-permission",
        bomAuditMinSeverity: "low",
      });
      assert.ok(
        findings.some((finding) => finding.ruleId === "CI-022"),
        "expected npm disabled cache finding",
      );
      assert.ok(
        findings.some((finding) => finding.ruleId === "CI-023"),
        "expected Python disabled cache finding",
      );
      assert.ok(
        findings.some((finding) => finding.ruleId === "CI-024"),
        "expected Cargo disabled cache finding",
      );
    });

    it("requires explicit opt-in for AI inventory in js and python scans", async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cdxgen-ai-inventory-"));
      const writeGgufFixture = (filePath) => {
        const chunks = [];
        const pushU32 = (value) => {
          const buffer = Buffer.alloc(4);
          buffer.writeUInt32LE(value);
          chunks.push(buffer);
        };
        const pushU64 = (value) => {
          const buffer = Buffer.alloc(8);
          buffer.writeBigUInt64LE(BigInt(value));
          chunks.push(buffer);
        };
        const pushString = (value) => {
          const buffer = Buffer.from(value, "utf-8");
          pushU64(buffer.length);
          chunks.push(buffer);
        };
        const pushKeyValue = (key, type, writer) => {
          pushString(key);
          pushU32(type);
          writer();
        };
        chunks.push(Buffer.from("GGUF"));
        pushU32(3);
        pushU64(0);
        pushU64(4);
        pushKeyValue("general.name", 8, () => pushString("TinyLlama-1.1B"));
        pushKeyValue("general.license", 8, () => pushString("Apache-2.0"));
        pushKeyValue("llama.context_length", 4, () => pushU32(8192));
        pushKeyValue("general.file_type", 4, () => pushU32(15));
        writeFileSync(filePath, Buffer.concat(chunks));
      };
      mkdirSync(join(tmpDir, ".claude", "skills", "release"), {
        recursive: true,
      });
      mkdirSync(join(tmpDir, ".vscode"), { recursive: true });
      mkdirSync(join(tmpDir, "src"), { recursive: true });
      writeFileSync(
        join(tmpDir, "package.json"),
        JSON.stringify(
          {
            dependencies: {
              "left-pad": "1.3.0",
            },
            name: "ai-inventory-demo",
            version: "1.0.0",
          },
          null,
          2,
        ),
      );
      writeFileSync(
        join(tmpDir, "package-lock.json"),
        JSON.stringify(
          {
            lockfileVersion: 3,
            name: "ai-inventory-demo",
            packages: {
              "": {
                dependencies: {
                  "left-pad": "1.3.0",
                },
                name: "ai-inventory-demo",
                version: "1.0.0",
              },
              "node_modules/left-pad": {
                resolved:
                  "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
                version: "1.3.0",
              },
            },
            requires: true,
            version: "1.0.0",
          },
          null,
          2,
        ),
      );
      writeFileSync(
        join(tmpDir, "CLAUDE.md"),
        "Use the release skill before publishing artifacts.",
      );
      writeFileSync(
        join(tmpDir, ".claude", "skills", "release", "SKILL.md"),
        [
          "---",
          "name: release",
          "description: Prepare release artifacts",
          "---",
          "Use this skill before shipping.",
        ].join("\n"),
      );
      writeFileSync(
        join(tmpDir, ".vscode", "mcp.json"),
        JSON.stringify(
          {
            mcpServers: {
              releaseDocs: {
                endpoint: "https://example.com/mcp",
                transport: "http",
              },
            },
          },
          null,
          2,
        ),
      );
      writeFileSync(
        join(tmpDir, "src", "index.ts"),
        [
          'import OpenAI from "openai";',
          'const model = "gpt-4o-mini";',
          'await fetch("https://api.openai.com/v1/responses");',
        ].join("\n"),
      );
      writeFileSync(
        join(tmpDir, "pyproject.toml"),
        [
          "[project]",
          'name = "demo-python-app"',
          'version = "0.1.0"',
          'requires-python = ">=3.10"',
        ].join("\n"),
      );
      writeFileSync(
        join(tmpDir, "server.py"),
        [
          "import mcp.server.stdio",
          "import mcp.types as mtypes",
          "from mcp.server import Server",
          "",
          'server = Server("python-release-docs", version="0.2.0")',
          "",
          "@server.list_tools()",
          "async def handle_list_tools():",
          '    return [mtypes.Tool(name="summarize_vulns", description="Summarize vulns", inputSchema={"type": "object"})]',
          "",
          "async with mcp.server.stdio.stdio_server() as (read_stream, write_stream):",
          "    await server.run(read_stream, write_stream, None)",
        ].join("\n"),
      );
      try {
        const baseOptions = {
          installDeps: false,
          multiProject: false,
          specVersion: 1.7,
        };
        const jsOptions = {
          ...baseOptions,
          projectType: ["js"],
        };
        const jsBomJson = (
          await postProcess(
            await createBom(tmpDir, jsOptions),
            jsOptions,
            tmpDir,
          )
        ).bomJson;
        assert.ok(
          !(jsBomJson.components || []).some((component) =>
            ["agent-instructions", "mcp-config", "skill-file"].includes(
              getProp(component, "cdx:file:kind"),
            ),
          ),
          "did not expect AI inventory components in js scan without opt-in",
        );
        assert.ok(
          !(jsBomJson.services || []).some((service) =>
            service.properties?.some((property) =>
              property.name.startsWith("cdx:mcp:"),
            ),
          ),
          "did not expect MCP services in js scan without opt-in",
        );

        const dockerOptions = {
          ...baseOptions,
          projectType: ["js", "docker"],
        };
        const dockerBomJson = (
          await postProcess(
            await createNodejsBom(tmpDir, dockerOptions),
            dockerOptions,
            tmpDir,
          )
        ).bomJson;
        assert.ok(
          !(dockerBomJson.components || []).some((component) =>
            ["agent-instructions", "mcp-config", "skill-file"].includes(
              getProp(component, "cdx:file:kind"),
            ),
          ),
          "did not expect AI inventory components in docker js scan without opt-in",
        );

        const exactAiSkillOptions = {
          ...baseOptions,
          projectType: ["ai-skill"],
        };
        const aiSkillBomJson = (
          await postProcess(
            await createBom(tmpDir, exactAiSkillOptions),
            exactAiSkillOptions,
            tmpDir,
          )
        ).bomJson;
        assert.ok(
          (aiSkillBomJson.components || []).some(
            (component) =>
              component.name === "CLAUDE.md" &&
              getProp(component, "cdx:file:kind") === "agent-instructions",
          ),
          "expected CLAUDE.md in exact ai-skill scan",
        );
        assert.ok(
          !(aiSkillBomJson.components || []).some(
            (component) => getProp(component, "cdx:file:kind") === "mcp-config",
          ),
          "did not expect MCP configs in exact ai-skill scan",
        );

        const directAiOptions = {
          ...baseOptions,
          projectType: ["ai"],
        };
        const directModelfile = join(tmpDir, "Modelfile");
        writeFileSync(
          directModelfile,
          [
            "FROM deepseek-ai/DeepSeek-R1-Distill-Qwen-7B",
            "PARAMETER num_ctx 65536",
          ].join("\n"),
        );
        const directModelfileBomJson = (
          await postProcess(
            await createBom(directModelfile, directAiOptions),
            directAiOptions,
            tmpDir,
          )
        ).bomJson;
        assert.ok(
          (directModelfileBomJson.components || []).some(
            (component) =>
              component.purl ===
              "pkg:huggingface/deepseek-ai/DeepSeek-R1-Distill-Qwen-7B",
          ),
          "expected Hugging Face model component in direct Modelfile AI-BOM",
        );
        const directModelfileFindings = await auditBom(directModelfileBomJson, {
          bomAuditCategories: "ai-bom",
          bomAuditMinSeverity: "low",
        });
        assert.ok(Array.isArray(directModelfileFindings));

        const directGguf = join(tmpDir, "tinyllama.gguf");
        writeGgufFixture(directGguf);
        const directGgufBomJson = (
          await postProcess(
            await createBom(directGguf, directAiOptions),
            directAiOptions,
            tmpDir,
          )
        ).bomJson;
        assert.ok(
          (directGgufBomJson.components || []).some(
            (component) =>
              component.name === "TinyLlama-1.1B" &&
              getProp(component, "cdx:ai:artifactFormat") === "gguf",
          ),
          "expected GGUF model component in direct GGUF AI-BOM",
        );
        const directGgufFindings = await auditBom(directGgufBomJson, {
          bomAuditCategories: "ai-bom",
          bomAuditMinSeverity: "low",
        });
        assert.ok(Array.isArray(directGgufFindings));

        const directHfDatasetPurl =
          "pkg:huggingface/rohitnagareddy/python-coding-instructions?repository_url=https:%2F%2Fhuggingface.co%2Fdatasets";
        const directHfDatasetResolvedBomRef =
          "pkg:huggingface/rohitnagareddy/python-coding-instructions@data123?repository_url=https:%2F%2Fhuggingface.co%2Fdatasets";
        const directHfModelPurl =
          "pkg:huggingface/rohitnagareddy/Qwen3-0.6B-Coding-Finetuned-v1@fixture-sha";
        const directHfModelRef =
          "pkg:huggingface/rohitnagareddy/Qwen3-0.6B-Coding-Finetuned-v1";
        const directHfSpacePurl =
          "pkg:huggingface/rohitnagareddy/qwen-coding-demo-space@space456?repository_url=https:%2F%2Fhuggingface.co%2Fspaces";
        const { cdxgenAgent } = await import("../ecosystems/utils.js");
        const fetchStub = sinon
          .stub(cdxgenAgent, "get")
          .callsFake(async (url) => {
            if (
              url.includes(
                "/api/datasets/rohitnagareddy/python-coding-instructions/revision/HEAD?",
              )
            ) {
              return {
                body: {
                  id: "rohitnagareddy/python-coding-instructions",
                  sha: "DATA123",
                  description: "Coding dataset fixture",
                  downloads: 321,
                  private: false,
                  tags: ["coding"],
                },
              };
            }
            if (
              url.includes(
                "/api/spaces/rohitnagareddy/qwen-coding-demo-space/revision/HEAD?",
              )
            ) {
              return {
                body: {
                  id: "rohitnagareddy/qwen-coding-demo-space",
                  sha: "SPACE456",
                  datasets: ["rohitnagareddy/python-coding-instructions"],
                  likes: 7,
                  models: ["rohitnagareddy/Qwen3-0.6B-Coding-Finetuned-v1"],
                  private: false,
                  runtime: {
                    stage: "RUNNING",
                  },
                  sdk: "gradio",
                  subdomain: "qwen-coding-demo-space",
                  tags: ["demo"],
                },
              };
            }
            return {
              body: {
                id: "rohitnagareddy/Qwen3-0.6B-Coding-Finetuned-v1",
                sha: "fixture-sha",
                license: "apache-2.0",
                pipeline_tag: "text-generation",
                cardData: {
                  base_model: "Qwen/Qwen3-0.6B",
                  base_model_relation: "finetune",
                  datasets: ["rohitnagareddy/python-coding-instructions"],
                  quantization: "GGUF Q4_K_M",
                },
                siblings: [{ rfilename: "LICENSE" }],
                tags: ["qwen3", "finetune"],
              },
            };
          });
        try {
          const directHfBomJson = (
            await postProcess(
              await createBom(
                "pkg:huggingface/rohitnagareddy/Qwen3-0.6B-Coding-Finetuned-v1",
                directAiOptions,
              ),
              directAiOptions,
              tmpDir,
            )
          ).bomJson;
          const directHfComponent = (directHfBomJson.components || []).find(
            (component) => component?.purl === directHfModelPurl,
          );
          assert.ok(
            directHfComponent,
            "expected direct Hugging Face component",
          );
          assert.ok(
            directHfComponent.pedigree?.ancestors?.some((component) =>
              component?.purl?.startsWith("pkg:huggingface/Qwen/Qwen3-0.6B"),
            ),
          );
          assert.ok(
            directHfComponent.pedigree?.notes?.includes("fine-tuned"),
            "expected direct Hugging Face pedigree notes to record the detected fine-tuned variant",
          );
          assert.ok(
            (directHfBomJson.dependencies || []).some(
              (dependency) =>
                dependency.ref === directHfComponent["bom-ref"] &&
                dependency.dependsOn?.includes(directHfDatasetPurl),
            ),
            "expected direct Hugging Face BOM to link the encoded dataset purl dependency",
          );
          const directFindings = await auditBom(directHfBomJson, {
            bomAuditCategories: "ai-bom",
            bomAuditMinSeverity: "low",
          });
          assert.ok(Array.isArray(directFindings));

          const directHfUrlBomJson = (
            await postProcess(
              await createBom(
                "https://huggingface.co/rohitnagareddy/Qwen3-0.6B-Coding-Finetuned-v1",
                directAiOptions,
              ),
              directAiOptions,
              tmpDir,
            )
          ).bomJson;
          assert.ok(
            (directHfUrlBomJson.components || []).some(
              (component) => component?.purl === directHfModelPurl,
            ),
            "expected direct Hugging Face URL component",
          );
          const directUrlFindings = await auditBom(directHfUrlBomJson, {
            bomAuditCategories: "ai-bom",
            bomAuditMinSeverity: "low",
          });
          assert.ok(Array.isArray(directUrlFindings));

          const directHfDatasetBomJson = (
            await postProcess(
              await createBom(
                "https://huggingface.co/datasets/rohitnagareddy/python-coding-instructions",
                directAiOptions,
              ),
              directAiOptions,
              tmpDir,
            )
          ).bomJson;
          assert.ok(
            (directHfDatasetBomJson.components || []).some(
              (component) =>
                component?.type === "data" &&
                component?.["bom-ref"] === directHfDatasetResolvedBomRef,
            ),
            "expected direct Hugging Face dataset URL component with the resolved encoded dataset bom-ref",
          );

          const directHfSpaceBomJson = (
            await postProcess(
              await createBom(
                "https://huggingface.co/spaces/rohitnagareddy/qwen-coding-demo-space",
                directAiOptions,
              ),
              directAiOptions,
              tmpDir,
            )
          ).bomJson;
          assert.ok(
            (directHfSpaceBomJson.components || []).some(
              (component) =>
                component?.type === "application" &&
                component?.purl === directHfSpacePurl,
            ),
            "expected direct Hugging Face Space URL component with encoded repository_url qualifier",
          );
          assert.ok(
            (directHfSpaceBomJson.dependencies || []).some(
              (dependency) =>
                dependency.ref === directHfSpacePurl &&
                dependency.dependsOn?.includes(directHfDatasetPurl) &&
                dependency.dependsOn?.includes(directHfModelRef),
            ),
            "expected direct Hugging Face Space BOM to keep dataset and model dependency refs",
          );
        } finally {
          fetchStub.restore();
        }

        const optedInJsOptions = {
          ...baseOptions,
          projectType: ["js", "ai-skill", "mcp"],
        };
        const optedInJsBomJson = (
          await postProcess(
            await createBom(tmpDir, optedInJsOptions),
            optedInJsOptions,
            tmpDir,
          )
        ).bomJson;
        assert.ok(
          (optedInJsBomJson.components || []).some(
            (component) =>
              getProp(component, "cdx:file:kind") === "skill-file" &&
              getProp(component, "cdx:skill:name") === "release",
          ),
          "expected skill file in opted-in js scan",
        );
        assert.ok(
          (optedInJsBomJson.components || []).some(
            (component) => getProp(component, "cdx:file:kind") === "mcp-config",
          ),
          "expected MCP config in opted-in js scan",
        );
        assert.ok(
          (optedInJsBomJson.services || []).some(
            (service) =>
              service.name === "releaseDocs" &&
              getProp(service, "cdx:mcp:inventorySource") === "config-file",
          ),
          "expected MCP config service in opted-in js scan",
        );

        const auditAliasJsOptions = {
          ...baseOptions,
          bomAuditCategories: "ai-inventory",
          projectType: ["js"],
        };
        const auditAliasJsBomJson = (
          await postProcess(
            await createBom(tmpDir, auditAliasJsOptions),
            auditAliasJsOptions,
            tmpDir,
          )
        ).bomJson;
        assert.ok(
          (auditAliasJsBomJson.components || []).some(
            (component) =>
              getProp(component, "cdx:file:kind") === "skill-file" &&
              getProp(component, "cdx:skill:name") === "release",
          ),
          "expected skill file in ai-inventory audit-category js scan",
        );
        assert.ok(
          (auditAliasJsBomJson.components || []).some(
            (component) => getProp(component, "cdx:file:kind") === "mcp-config",
          ),
          "expected MCP config in ai-inventory audit-category js scan",
        );
        assert.ok(
          (auditAliasJsBomJson.services || []).some(
            (service) =>
              service.name === "releaseDocs" &&
              getProp(service, "cdx:mcp:inventorySource") === "config-file",
          ),
          "expected MCP config service in ai-inventory audit-category js scan",
        );
        assert.ok(
          (auditAliasJsBomJson.components || []).some(
            (component) =>
              component.type === "machine-learning-model" &&
              component.name === "gpt-4o-mini" &&
              getProp(component, "cdx:ai:provider") === "openai",
          ),
          "expected AI model component in ai-inventory audit-category js scan",
        );
        assert.ok(
          (auditAliasJsBomJson.services || []).some(
            (service) =>
              service.group === "openai" &&
              getProp(service, "cdx:ai:modelId") === "gpt-4o-mini",
          ),
          "expected AI provider service in ai-inventory audit-category js scan",
        );

        const auditAgentJsOptions = {
          ...baseOptions,
          bomAuditCategories: "ai-agent",
          projectType: ["js"],
        };
        const auditAgentJsBomJson = (
          await postProcess(
            await createBom(tmpDir, auditAgentJsOptions),
            auditAgentJsOptions,
            tmpDir,
          )
        ).bomJson;
        assert.ok(
          (auditAgentJsBomJson.components || []).some(
            (component) =>
              getProp(component, "cdx:file:kind") === "skill-file" &&
              getProp(component, "cdx:skill:name") === "release",
          ),
          "expected skill file in ai-agent audit-category js scan",
        );
        assert.ok(
          !(auditAgentJsBomJson.components || []).some(
            (component) => getProp(component, "cdx:file:kind") === "mcp-config",
          ),
          "did not expect MCP config in ai-agent audit-category js scan",
        );
        assert.ok(
          (auditAgentJsBomJson.components || []).some(
            (component) =>
              component.type === "machine-learning-model" &&
              component.name === "gpt-4o-mini",
          ),
          "expected AI model component in ai-agent audit-category js scan",
        );

        const filteredOptions = {
          ...baseOptions,
          excludeType: ["ai-skill", "mcp"],
          projectType: ["js", "ai-skill", "mcp"],
        };
        const filteredBomJson = (
          await postProcess(
            await createBom(tmpDir, filteredOptions),
            filteredOptions,
            tmpDir,
          )
        ).bomJson;
        assert.ok(
          !(filteredBomJson.components || []).some((component) =>
            ["agent-instructions", "mcp-config", "skill-file"].includes(
              getProp(component, "cdx:file:kind"),
            ),
          ),
          "did not expect AI inventory components after exclude-type filtering",
        );
        assert.ok(
          !(filteredBomJson.services || []).some((service) =>
            service.properties?.some((property) =>
              property.name.startsWith("cdx:mcp:"),
            ),
          ),
          "did not expect MCP services after exclude-type filtering",
        );

        const pyOptions = {
          ...baseOptions,
          projectType: ["py"],
        };
        const pyBomJson = (
          await postProcess(
            await createBom(tmpDir, pyOptions),
            pyOptions,
            tmpDir,
          )
        ).bomJson;
        assert.ok(
          !(pyBomJson.components || []).some((component) =>
            ["agent-instructions", "mcp-config", "skill-file"].includes(
              getProp(component, "cdx:file:kind"),
            ),
          ),
          "did not expect AI inventory components in python scan without opt-in",
        );
        assert.ok(
          !(pyBomJson.services || []).some((service) =>
            service.properties?.some((property) =>
              property.name.startsWith("cdx:mcp:"),
            ),
          ),
          "did not expect MCP services in python scan without opt-in",
        );

        const optedInPyOptions = {
          ...baseOptions,
          projectType: ["py", "ai-skill", "mcp"],
        };
        const optedInPyBomJson = (
          await postProcess(
            await createPythonBom(tmpDir, optedInPyOptions),
            optedInPyOptions,
            tmpDir,
          )
        ).bomJson;
        assert.ok(
          (optedInPyBomJson.components || []).some(
            (component) =>
              getProp(component, "cdx:file:kind") === "skill-file" &&
              getProp(component, "cdx:skill:name") === "release",
          ),
          "expected skill file in opted-in python scan",
        );
        assert.ok(
          (optedInPyBomJson.components || []).some(
            (component) => getProp(component, "cdx:file:kind") === "mcp-config",
          ),
          "expected MCP config in opted-in python scan",
        );
        assert.ok(
          (optedInPyBomJson.services || []).some(
            (service) =>
              service.name === "python-release-docs" &&
              getProp(service, "cdx:mcp:inventorySource") ===
                "source-code-analysis",
          ),
          "expected Python MCP service in opted-in python scan",
        );

        const auditMcpPyOptions = {
          ...baseOptions,
          bomAuditCategories: "mcp-server",
          projectType: ["py"],
        };
        const auditMcpPyBomJson = (
          await postProcess(
            await createPythonBom(tmpDir, auditMcpPyOptions),
            auditMcpPyOptions,
            tmpDir,
          )
        ).bomJson;
        assert.ok(
          (auditMcpPyBomJson.services || []).some(
            (service) =>
              service.name === "python-release-docs" &&
              getProp(service, "cdx:mcp:inventorySource") ===
                "source-code-analysis",
          ),
          "expected Python MCP service in mcp-server audit-category scan",
        );
        assert.ok(
          !(auditMcpPyBomJson.components || []).some(
            (component) => getProp(component, "cdx:file:kind") === "skill-file",
          ),
          "did not expect skill file in mcp-server audit-category python scan",
        );
      } finally {
        rmSync(tmpDir, { force: true, recursive: true });
      }
    });

    it("does not trace an npm registry config read when opening .npmrc fails", async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cdxgen-npmrc-read-fail-"));
      writeFileSync(
        join(tmpDir, "package.json"),
        JSON.stringify({
          name: "npmrc-read-fail",
          version: "1.0.0",
        }),
      );
      mkdirSync(join(tmpDir, ".npmrc"), { recursive: true });
      setDryRunMode(true);
      resetRecordedActivities();
      try {
        await assert.rejects(() =>
          createNodejsBom(tmpDir, {
            installDeps: true,
            multiProject: false,
            projectType: ["npm"],
          }),
        );
        const readActivities = getRecordedActivities().filter(
          (activity) =>
            activity.kind === "read" &&
            activity.target === join(tmpDir, ".npmrc"),
        );
        assert.deepStrictEqual(readActivities, []);
      } finally {
        setDryRunMode(false);
        resetRecordedActivities();
        rmSync(tmpDir, { force: true, recursive: true });
      }
    });
  });

  describe("createCsharpBom() multi-project manifests", () => {
    const dataDir = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "test",
      "data",
    );

    it("does not drop packages.config when a sibling project has project.assets.json", async () => {
      // Regression test for SIQ-290: in a multi-project scan, a modern
      // project.assets.json / packages.lock.json in one project used to cause
      // packages.config dependencies of unrelated projects to be dropped.
      const tempDir = mkdtempSync(join(tmpdir(), "cdxgen-dotnet-multiproj-"));
      try {
        const legacyDir = join(tempDir, "LegacyProj");
        const modernObjDir = join(tempDir, "ModernProj", "obj");
        mkdirSync(legacyDir, { recursive: true });
        mkdirSync(modernObjDir, { recursive: true });
        copyFileSync(
          join(dataDir, "packages.config"),
          join(legacyDir, "packages.config"),
        );
        copyFileSync(
          join(dataDir, "project.assets.json"),
          join(modernObjDir, "project.assets.json"),
        );

        const bomNSData = await createCsharpBom(tempDir, {
          multiProject: true,
          projectType: ["dotnet"],
        });
        const componentNames = (bomNSData.bomJson.components || []).map(
          (c) => c.name,
        );
        // From LegacyProj/packages.config
        assert.ok(
          componentNames.includes("Antlr"),
          "packages.config dependencies should be retained",
        );
        assert.ok(
          componentNames.includes("EntityFramework"),
          "packages.config dependencies should be retained",
        );
        // From ModernProj/obj/project.assets.json
        assert.ok(
          componentNames.includes("log4net"),
          "project.assets.json dependencies should be retained",
        );
      } finally {
        rmSync(tempDir, { force: true, recursive: true });
      }
    });

    it("does not double-count packages.config when the same project has a modern manifest", async () => {
      // When a single project directory has both packages.config and a
      // project.assets.json, the modern manifest takes precedence and the
      // packages.config is skipped for that project.
      const tempDir = mkdtempSync(join(tmpdir(), "cdxgen-dotnet-sameproj-"));
      try {
        const projDir = join(tempDir, "Proj");
        const objDir = join(projDir, "obj");
        mkdirSync(objDir, { recursive: true });
        copyFileSync(
          join(dataDir, "packages.config"),
          join(projDir, "packages.config"),
        );
        copyFileSync(
          join(dataDir, "project.assets.json"),
          join(objDir, "project.assets.json"),
        );

        const bomNSData = await createCsharpBom(tempDir, {
          multiProject: true,
          projectType: ["dotnet"],
        });
        const componentNames = (bomNSData.bomJson.components || []).map(
          (c) => c.name,
        );
        // packages.config-only package must NOT appear since assets supersede it
        assert.ok(
          !componentNames.includes("Antlr"),
          "packages.config should be skipped when project.assets.json covers the same project",
        );
        assert.ok(
          componentNames.includes("log4net"),
          "project.assets.json dependencies should be retained",
        );
      } finally {
        rmSync(tempDir, { force: true, recursive: true });
      }
    });

    const mixedDataDir = join(dataDir, "csharp-mixed-manifests");
    // evidence.identity is an object for a single manifest and an array once
    // trimComponents merges evidence from multiple manifests
    const identityList = (comp) => {
      const identity = comp?.evidence?.identity;
      if (!identity) {
        return [];
      }
      return Array.isArray(identity) ? identity : [identity];
    };

    it("tracks both versions when packages.config and packages.lock.json disagree", async () => {
      const bomNSData = await createCsharpBom(
        join(mixedDataDir, "DiffVersion"),
        {
          multiProject: true,
          projectType: ["dotnet"],
          specVersion: 1.7,
        },
      );
      const components = bomNSData.bomJson.components || [];
      const njVersions = components
        .filter((c) => c.name === "Newtonsoft.Json")
        .map((c) => c.version)
        .sort();
      assert.deepStrictEqual(
        njVersions,
        ["12.0.3", "13.0.3"],
        "both the packages.config and the packages.lock.json versions must be tracked",
      );
      assert.ok(
        components.some(
          (c) => c.name === "EntityFramework" && c.version === "6.4.4",
        ),
        "packages.config-only dependencies must be retained",
      );
      // Each version must stay attributable to the manifest it came from
      const legacyNj = components.find(
        (c) => c.name === "Newtonsoft.Json" && c.version === "12.0.3",
      );
      const legacyIdentities = identityList(legacyNj);
      assert.deepStrictEqual(legacyIdentities[0].confidence, 0.7);
      assert.ok(
        legacyIdentities[0].methods[0].value.endsWith("packages.config"),
        "the packages.config version must carry packages.config evidence",
      );
      const modernNj = components.find(
        (c) => c.name === "Newtonsoft.Json" && c.version === "13.0.3",
      );
      const modernIdentities = identityList(modernNj);
      assert.deepStrictEqual(modernIdentities[0].confidence, 1);
      assert.ok(
        modernIdentities[0].methods[0].value.endsWith("packages.lock.json"),
        "the packages.lock.json version must carry packages.lock.json evidence",
      );
    });

    it("merges properties and evidence when packages.config and packages.lock.json agree", async () => {
      const bomNSData = await createCsharpBom(
        join(mixedDataDir, "SameVersion"),
        {
          multiProject: true,
          projectType: ["dotnet"],
          specVersion: 1.7,
        },
      );
      const components = (bomNSData.bomJson.components || []).filter(
        (c) => c.name === "Newtonsoft.Json",
      );
      assert.deepStrictEqual(
        components.length,
        1,
        "same package and version from two manifests must merge into one component",
      );
      const srcFiles = (components[0].properties || [])
        .filter((p) => p.name === "internal:SrcFile")
        .map((p) => p.value);
      assert.ok(
        srcFiles.some((v) => v.endsWith("packages.lock.json")),
        "SrcFile property from packages.lock.json must be retained",
      );
      assert.ok(
        srcFiles.some((v) => v.endsWith("packages.config")),
        "SrcFile property from packages.config must be retained",
      );
      const identities = identityList(components[0]);
      const methodValues = identities
        .flatMap((i) => i.methods || [])
        .map((m) => m.value);
      assert.ok(
        methodValues.some((v) => v.endsWith("packages.lock.json")),
        "evidence from packages.lock.json must be retained",
      );
      assert.ok(
        methodValues.some((v) => v.endsWith("packages.config")),
        "evidence from packages.config must be retained",
      );
      // Merging the lower-confidence packages.config evidence must not
      // degrade the confidence established by the lock file
      assert.deepStrictEqual(identities.length, 1);
      assert.deepStrictEqual(
        identities[0].confidence,
        1,
        "merged identity must retain the highest confidence",
      );
    });

    it("lowers the confidence for imprecise packages.config versions", async () => {
      const bomNSData = await createCsharpBom(
        join(mixedDataDir, "ImpreciseVersions"),
        {
          multiProject: true,
          projectType: ["dotnet"],
          specVersion: 1.7,
        },
      );
      const components = bomNSData.bomJson.components || [];
      const confidenceFor = (name) => {
        const comp = components.find((c) => c.name === name);
        assert.ok(comp, `component ${name} must be present`);
        const identities = identityList(comp);
        assert.ok(identities.length, `component ${name} must carry evidence`);
        return identities[0].confidence;
      };
      assert.deepStrictEqual(
        confidenceFor("Antlr"),
        0.7,
        "exact versions keep the regular manifest confidence",
      );
      assert.deepStrictEqual(
        confidenceFor("Moq"),
        0.7,
        "prerelease versions are precise",
      );
      assert.deepStrictEqual(
        confidenceFor("Castle.Core"),
        0.7,
        "exact-pin ranges such as [4.4.1] are precise",
      );
      assert.deepStrictEqual(
        confidenceFor("NUnit"),
        0.5,
        "range versions must get a lower confidence",
      );
      assert.deepStrictEqual(
        confidenceFor("log4net"),
        0.5,
        "wildcard versions must get a lower confidence",
      );
      assert.deepStrictEqual(
        confidenceFor("jQuery"),
        0.5,
        "bare wildcard versions must get a lower confidence",
      );
      // Packages without a resolvable version must still be tracked
      for (const name of [
        "Newtonsoft.Json",
        "Serilog",
        "WebGrease",
        "bootstrap",
      ]) {
        assert.ok(
          components.some((c) => c.name === name),
          `${name} must be tracked even without a precise version`,
        );
      }
      assert.ok(
        !components.some((c) => c.purl?.includes("$(")),
        "templated versions must not leak into purls",
      );
      assert.ok(
        !components.some(
          (c) => c.purl?.includes("@undefined") || c.purl?.endsWith("@"),
        ),
        "missing versions must not produce bogus purls",
      );
    });

    it("backfills templated packages.config versions from resolved manifests", async () => {
      const bomNSData = await createCsharpBom(
        join(mixedDataDir, "TemplatedBackfill"),
        {
          multiProject: true,
          projectType: ["dotnet"],
          specVersion: 1.7,
        },
      );
      const components = (bomNSData.bomJson.components || []).filter(
        (c) => c.name === "Newtonsoft.Json",
      );
      assert.deepStrictEqual(
        components.length,
        1,
        "backfilled packages.config component must merge with the packages.lock.json component",
      );
      assert.deepStrictEqual(components[0].version, "13.0.3");
      const identities = identityList(components[0]);
      const methodValues = identities
        .flatMap((i) => i.methods || [])
        .map((m) => m.value);
      assert.ok(
        methodValues.some((v) => v.endsWith("packages.config")),
        "evidence from packages.config must be retained after backfill",
      );
      assert.deepStrictEqual(
        identities[0].confidence,
        1,
        "the lock file confidence must win over the backfilled evidence",
      );
    });

    it("resolves versions from a Directory.Packages.props above the scanned directory", async () => {
      // The user in #4303 pointed cdxgen at ./src while Directory.Packages.props sat
      // at the repository root, so the props file is deliberately outside the scan.
      const bomNSData = await createCsharpBom(
        join(mixedDataDir, "CentralPackageManagement", "src"),
        {
          multiProject: true,
          projectType: ["dotnet"],
          specVersion: 1.7,
        },
      );
      const byName = {};
      for (const c of bomNSData.bomJson.components || []) {
        byName[c.name] = c;
      }
      assert.deepStrictEqual(byName.WiX.version, "3.14.1");
      assert.deepStrictEqual(byName.WiX.purl, "pkg:nuget/WiX@3.14.1");
      assert.deepStrictEqual(byName.Serilog.version, "3.1.1");
      assert.deepStrictEqual(byName["Newtonsoft.Json"].version, "13.0.3");
      assert.deepStrictEqual(byName.Moq.version, "4.18.4");
      assert.ok(
        byName["Unlisted.Package"],
        "a package with no central version must still be tracked",
      );
      assert.ok(
        !(bomNSData.bomJson.components || []).some(
          (c) => c.purl?.includes("@undefined") || c.purl?.endsWith("@"),
        ),
        "missing versions must not produce bogus purls",
      );
    });

    it("builds a complete dependency graph across legacy and modern manifests", async () => {
      const bomNSData = await createCsharpBom(join(mixedDataDir, "DepGraph"), {
        multiProject: true,
        projectType: ["dotnet"],
        specVersion: 1.7,
      });
      const componentNames = (bomNSData.bomJson.components || []).map(
        (c) => c.name,
      );
      for (const name of ["EntityFramework", "Serilog.Sinks.File", "Serilog"]) {
        assert.ok(
          componentNames.includes(name),
          `component ${name} must be present`,
        );
      }
      const dependencies = bomNSData.bomJson.dependencies || [];
      const parentRef = bomNSData.bomJson.metadata.component["bom-ref"];
      const parentEntry = dependencies.find((d) => d.ref === parentRef);
      assert.ok(
        parentEntry,
        "the parent component must have a dependency entry",
      );
      assert.ok(
        parentEntry.dependsOn.includes("pkg:nuget/EntityFramework@6.4.4"),
        "packages.config dependencies must be attached to the parent",
      );
      assert.ok(
        parentEntry.dependsOn.includes("pkg:nuget/Serilog.Sinks.File@5.0.0"),
        "direct packages.lock.json dependencies must be attached to the parent",
      );
      const sinksEntry = dependencies.find(
        (d) => d.ref === "pkg:nuget/Serilog.Sinks.File@5.0.0",
      );
      assert.ok(
        sinksEntry,
        "packages.lock.json components must have dependency entries",
      );
      assert.deepStrictEqual(
        sinksEntry.dependsOn,
        ["pkg:nuget/Serilog@2.10.0"],
        "transitive edges from packages.lock.json must be preserved",
      );
    });

    it("gives a single project with a packages.lock.json one root dependency entry", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "cdxgen-dotnet-lockroot-"));
      try {
        writeFileSync(
          join(tempDir, "app.csproj"),
          '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework><Version>1.0.0</Version></PropertyGroup><ItemGroup><PackageReference Include="Foo.Meta" Version="1.2.3" /></ItemGroup></Project>',
        );
        writeFileSync(
          join(tempDir, "packages.lock.json"),
          JSON.stringify({
            version: 1,
            dependencies: {
              "net8.0": {
                "Foo.Meta": {
                  type: "Direct",
                  requested: "[1.2.3, )",
                  resolved: "1.2.3",
                  contentHash: "AAAA",
                },
              },
            },
          }),
        );
        const bomNSData = await createCsharpBom(tempDir, {
          multiProject: true,
          projectType: ["dotnet"],
          installDeps: false,
          specVersion: 1.6,
        });
        assert.strictEqual(
          bomNSData.parentComponent["bom-ref"],
          "pkg:nuget/app@1.0.0",
        );
        assert.deepStrictEqual(bomNSData.dependencies, [
          {
            ref: "pkg:nuget/app@1.0.0",
            dependsOn: ["pkg:nuget/Foo.Meta@1.2.3"],
          },
          { ref: "pkg:nuget/Foo.Meta@1.2.3", dependsOn: [] },
        ]);
        assert.ok(validateBom(bomNSData.bomJson));
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    // Writes the files of a scan under a fresh directory.
    const writeTree = (files) => {
      const tempDir = mkdtempSync(join(tmpdir(), "cdxgen-dotnet-tree-"));
      for (const [relativePath, text] of Object.entries(files)) {
        const file = join(tempDir, relativePath);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(
          file,
          typeof text === "string" ? text : JSON.stringify(text),
        );
      }
      return tempDir;
    };
    const lockFile = (packages) => ({
      version: 1,
      dependencies: {
        "net8.0": Object.fromEntries(
          Object.entries(packages).map(([name, version]) => [
            name,
            { type: "Direct", requested: `[${version}, )`, resolved: version },
          ]),
        ),
      },
    });
    const sdkProject = (version, references) =>
      `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework><Version>${version}</Version></PropertyGroup><ItemGroup>${references}</ItemGroup></Project>`;

    it("gives each project the versions it restored, and its own direct dependencies", async () => {
      // Two projects of one tree restore two versions of Moq, and neither
      // project file states a version. Each project's Moq is its own.
      const tempDir = writeTree({
        "src/A/A.csproj": sdkProject(
          "1.0.0",
          '<PackageReference Include="Moq" />',
        ),
        "src/A/packages.lock.json": lockFile({ Moq: "4.18.4" }),
        // NuGet ids are case-insensitive: this is the restored Moq
        "src/B/B.csproj": sdkProject(
          "2.0.0",
          '<PackageReference Include="moq" />',
        ),
        "src/B/packages.lock.json": lockFile({ Moq: "4.20.69" }),
      });
      try {
        const bomNSData = await createCsharpBom(tempDir, {
          multiProject: true,
          projectType: ["dotnet"],
          installDeps: false,
          specVersion: 1.6,
        });
        const purls = (bomNSData.bomJson.components || [])
          .map((c) => c.purl)
          .filter((purl) => purl.toLowerCase().startsWith("pkg:nuget/moq"))
          .sort();
        // No third, made-up version and no versionless leftover
        assert.deepStrictEqual(purls, [
          "pkg:nuget/Moq@4.18.4",
          "pkg:nuget/Moq@4.20.69",
        ]);
        const dependsOn = (ref) =>
          bomNSData.dependencies.find((d) => d.ref === ref)?.dependsOn;
        assert.deepStrictEqual(dependsOn("pkg:nuget/A@1.0.0"), [
          "pkg:nuget/Moq@4.18.4",
        ]);
        assert.deepStrictEqual(dependsOn("pkg:nuget/B@2.0.0"), [
          "pkg:nuget/Moq@4.20.69",
        ]);
        // Every edge points at a component: no second spelling of Moq
        const refs = new Set(
          (bomNSData.bomJson.components || []).map((c) => c["bom-ref"]),
        );
        for (const d of bomNSData.dependencies) {
          for (const ref of d.dependsOn) {
            assert.ok(
              refs.has(ref) ||
                ref.startsWith("pkg:nuget/A@") ||
                ref.startsWith("pkg:nuget/B@"),
              ref,
            );
          }
        }
        // The scan root does not claim the projects' packages as its own
        const root = dependsOn(bomNSData.parentComponent["bom-ref"]) || [];
        assert.ok(!root.some((ref) => ref.startsWith("pkg:nuget/Moq")));
        assert.ok(validateBom(bomNSData.bomJson));
      } finally {
        rmSync(tempDir, { force: true, recursive: true });
      }
    });

    it("backfills packages.config only from a version every manifest agrees on", async () => {
      const config = (packages) =>
        `<?xml version="1.0" encoding="utf-8"?><packages>${packages}</packages>`;
      const tempDir = writeTree({
        "src/A/packages.lock.json": lockFile({
          Moq: "4.18.4",
          Serilog: "3.1.1",
        }),
        "src/B/packages.lock.json": lockFile({ Moq: "4.20.69" }),
        // A legacy project names both packages with a build-time version
        "src/Legacy/packages.config": config(
          '<package id="Moq" version="$(MoqVersion)" /><package id="Serilog" version="$(SerilogVersion)" />',
        ),
      });
      try {
        const bomNSData = await createCsharpBom(tempDir, {
          multiProject: true,
          projectType: ["dotnet"],
          installDeps: false,
          specVersion: 1.6,
        });
        const fromConfig = (bomNSData.bomJson.components || []).filter((c) =>
          c.properties?.some(
            (p) =>
              p.name === "internal:SrcFile" &&
              p.value.endsWith("packages.config"),
          ),
        );
        const purlOf = (name) => fromConfig.find((c) => c.name === name)?.purl;
        // Two projects restored two versions: neither is the legacy project's
        assert.strictEqual(purlOf("Moq"), "pkg:nuget/Moq");
        assert.strictEqual(purlOf("Serilog"), "pkg:nuget/Serilog@3.1.1");
      } finally {
        rmSync(tempDir, { force: true, recursive: true });
      }
    });

    it("points nupkg dependency edges at installed versions only", async () => {
      // Two versions of Castle.Core are installed; Moq's nuspec asks for at
      // least 5.1.1 and Serilog's for a version nobody installed.
      const nuspec = (id, version, dependencies) =>
        `<?xml version="1.0"?><package><metadata><id>${id}</id><version>${version}</version><description>d</description><dependencies>${dependencies}</dependencies></metadata></package>`;
      const nuspecs = {
        "moq.4.20.69.nupkg": nuspec(
          "Moq",
          "4.20.69",
          '<group targetFramework="net6.0"><dependency id="castle.core" version="5.1.1" /></group>',
        ),
        "castle.core.5.0.0.nupkg": nuspec("Castle.Core", "5.0.0", ""),
        "castle.core.5.1.1.nupkg": nuspec("Castle.Core", "5.1.1", ""),
        "serilog.3.1.1.nupkg": nuspec(
          "Serilog",
          "3.1.1",
          '<dependency id="System.Diagnostics.DiagnosticSource" version="7.0.2" />',
        ),
      };
      const tempDir = writeTree(
        Object.fromEntries(
          Object.keys(nuspecs).map((name) => [`packages/${name}`, "zip"]),
        ),
      );
      try {
        const real = await import("../ecosystems/parsers-dotnet.js");
        const { createCsharpBom: createWithNupkgs } = await esmock(
          "./managedBom.js",
          {
            "../ecosystems/parsers-dotnet.js": {
              parseNupkg: async (file) =>
                real.parseNuspecData(file, nuspecs[file.split(/[\\/]/).pop()]),
            },
          },
        );
        const bomNSData = await createWithNupkgs(tempDir, {
          multiProject: true,
          projectType: ["dotnet"],
          installDeps: false,
          specVersion: 1.6,
        });
        const purls = (bomNSData.bomJson.components || [])
          .map((c) => c.purl)
          .sort();
        // Only what is installed; DiagnosticSource 7.0.2 was never installed
        assert.deepStrictEqual(purls, [
          "pkg:nuget/Castle.Core@5.0.0",
          "pkg:nuget/Castle.Core@5.1.1",
          "pkg:nuget/Moq@4.20.69",
          "pkg:nuget/Serilog@3.1.1",
        ]);
        const dependsOn = (ref) =>
          bomNSData.dependencies.find((d) => d.ref === ref)?.dependsOn;
        assert.deepStrictEqual(dependsOn("pkg:nuget/Moq@4.20.69"), [
          "pkg:nuget/Castle.Core@5.1.1",
        ]);
        assert.deepStrictEqual(dependsOn("pkg:nuget/Serilog@3.1.1"), []);
        assert.ok(validateBom(bomNSData.bomJson));
      } finally {
        rmSync(tempDir, { force: true, recursive: true });
      }
    });
  });
  describe("createCsharpBom() --deep slices file resolution (issue 4394)", () => {
    // A realistic minimal .NET project: pinned PackageReferences so components
    // exist without needing msbuild to resolve version labels, plus one
    // (Serilog) left versionless, which the slice's AssemblyInformation must
    // not fill in.
    const writeCsProj = (dir) => {
      writeFileSync(
        join(dir, "CatalogService.csproj"),
        `<?xml version="1.0" encoding="utf-8"?>
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <RootNamespace>CatalogService</RootNamespace>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
    <PackageReference Include="RestSharp" Version="110.2.0" />
    <PackageReference Include="Serilog" />
  </ItemGroup>
</Project>
`,
      );
    };

    // Shape mirrors dosai's methods slice: PascalCase fields, package purls,
    // .cs source locations, reachability facts, and assembly versions.
    const dosaiMethodsSlice = (scanDir) => ({
      Dependencies: [
        {
          Name: "JsonConvert",
          Namespace: "Newtonsoft.Json",
          Purl: "pkg:nuget/Newtonsoft.Json@13.0.3",
          Module: "Newtonsoft.Json.dll",
          Path: join(scanDir, "Services", "CatalogService.cs"),
          LineNumber: 12,
        },
        {
          Name: "DefaultJsonSerializerSettings",
          Namespace: "RestSharp.Serializers.NewtonsoftJson",
          Purl: "pkg:nuget/RestSharp@110.2.0",
          Module: "RestSharp.dll",
          Path: join(scanDir, "Program.cs"),
          LineNumber: 27,
        },
      ],
      PackageReachability: [
        {
          Purl: "pkg:nuget/Newtonsoft.Json@13.0.3",
          ReachabilityKind: "Reachable",
          Confidence: 1.0,
          EvidenceKinds: ["SourceLocation", "CallGraph"],
          ConfidenceReasons: ["called from CatalogService.cs line 12"],
          SourceLocations: [
            {
              Path: join(scanDir, "Services", "CatalogService.cs"),
              LineNumber: 12,
            },
          ],
          EdgeIds: [],
          NodeIds: [],
        },
      ],
      AssemblyInformation: [{ Name: "Serilog", Version: "3.1.1" }],
      Services: [
        {
          Id: "catalog-service:catalogdb",
          Name: "catalogdb",
          Group: "CatalogService",
          Direction: "outbound",
          Provider: "npgsql",
        },
      ],
    });

    const assertSliceEvidenceApplied = (bomNSData, scanDir) => {
      const components = bomNSData.bomJson.components || [];
      const newtonsoft = components.find(
        (c) => c.purl === "pkg:nuget/Newtonsoft.Json@13.0.3",
      );
      const restsharp = components.find(
        (c) => c.purl === "pkg:nuget/RestSharp@110.2.0",
      );
      assert.ok(newtonsoft, "Newtonsoft.Json component should exist");
      assert.ok(restsharp, "RestSharp component should exist");
      assert.ok(
        newtonsoft.evidence?.occurrences?.some(
          (o) =>
            o.location === join(scanDir, "Services", "CatalogService.cs") &&
            o.line === 12,
        ),
        "occurrence evidence from the slices file should be attached",
      );
      assert.ok(
        restsharp.evidence?.occurrences?.some(
          (o) => o.location === join(scanDir, "Program.cs") && o.line === 27,
        ),
        "occurrence evidence from the slices file should be attached",
      );
      assert.strictEqual(newtonsoft.scope, "required");
      assert.ok(
        (newtonsoft.properties || []).some(
          (p) =>
            p.name === "cdx:dosai:reachability:kind" && p.value === "Reachable",
        ),
        "reachability facts from the slices file should be attached",
      );
      const services = bomNSData.bomJson.services || [];
      assert.ok(
        services.some((s) => s.name === "catalogdb"),
        "services from the slices file should be attached",
      );
    };

    it("uses an absolute --deps-slices-file as-is instead of joining it onto the scan path", async () => {
      // Regression test for issue 4394: joining an absolute path onto the
      // scan path produced an invalid path (C:\src\repo\C:\reports\... on
      // Windows), dosai failed to write it, and the BOM silently lost all
      // .NET evidence while the scan still exited 0.
      const scanDir = mkdtempSync(join(tmpdir(), "cdxgen-dotnet-abs-slices-"));
      const reportsDir = mkdtempSync(join(tmpdir(), "cdxgen-dotnet-reports-"));
      try {
        writeCsProj(scanDir);
        const slicesPath = join(reportsDir, "dotnet-deps.slices.json");
        writeFileSync(slicesPath, JSON.stringify(dosaiMethodsSlice(scanDir)));
        const bomNSData = await createCsharpBom(scanDir, {
          projectType: ["csharp"],
          deep: true,
          specVersion: 1.7,
          depsSlicesFile: slicesPath,
        });
        assertSliceEvidenceApplied(bomNSData, scanDir);
      } finally {
        rmSync(scanDir, { force: true, recursive: true });
        rmSync(reportsDir, { force: true, recursive: true });
      }
    });

    it("resolves a relative --deps-slices-file against the scan path", async () => {
      // The relative form is the documented default (the CLI ships
      // "deps.slices.json"); it must keep resolving against the scan path
      // after the absolute-path fix.
      const scanDir = mkdtempSync(join(tmpdir(), "cdxgen-dotnet-rel-slices-"));
      try {
        writeCsProj(scanDir);
        writeFileSync(
          join(scanDir, "custom-deps.slices.json"),
          JSON.stringify(dosaiMethodsSlice(scanDir)),
        );
        const bomNSData = await createCsharpBom(scanDir, {
          projectType: ["csharp"],
          deep: true,
          specVersion: 1.7,
          depsSlicesFile: "custom-deps.slices.json",
        });
        assertSliceEvidenceApplied(bomNSData, scanDir);
      } finally {
        rmSync(scanDir, { force: true, recursive: true });
      }
    });

    it("warns when dosai slicing fails so missing .NET evidence is not silent", async () => {
      // The issue also reports that the failure was only visible under
      // DEBUG_MODE: without a warning, the BOM quietly ships without .NET
      // evidence and the scan exits 0.
      const scanDir = mkdtempSync(join(tmpdir(), "cdxgen-dotnet-slice-fail-"));
      const warnStub = sinon.stub(console, "warn");
      try {
        writeCsProj(scanDir);
        const slicesFile = join(scanDir, "unwritable-deps.slices.json");
        const dosaiRunWasStopped = sinon.stub().returns(false);
        const { createCsharpBom: mockedCreateCsharpBom } = await esmock(
          "./managedBom.js",
          {
            "../inventory/dosai.js": {
              createDosaiMethodsSlice: sinon.stub().returns(false),
              dosaiRunWasStopped,
            },
          },
        );
        const bomNSData = await mockedCreateCsharpBom(scanDir, {
          projectType: ["csharp"],
          deep: true,
          specVersion: 1.7,
          depsSlicesFile: slicesFile,
        });
        assert.ok(
          warnStub.calledWith(
            sinon.match(/Slicing with dosai was unsuccessful/),
          ),
          "the dosai failure should be visible without --debug",
        );
        // A run stopped at a limit has already warned and named what to
        // change, and the debug output would show no dosai error for it, so
        // the advice is only for other failures (issue 4438).
        sinon.assert.calledWith(dosaiRunWasStopped, slicesFile);
        warnStub.resetHistory();
        dosaiRunWasStopped.returns(true);
        await mockedCreateCsharpBom(scanDir, {
          projectType: ["csharp"],
          deep: true,
          specVersion: 1.7,
          depsSlicesFile: slicesFile,
        });
        assert.ok(
          !warnStub.calledWith(
            sinon.match(/Slicing with dosai was unsuccessful/),
          ),
          "a stopped run gets no advice meant for other failures",
        );
        const components = bomNSData.bomJson.components || [];
        const newtonsoft = components.find(
          (c) => c.purl === "pkg:nuget/Newtonsoft.Json@13.0.3",
        );
        assert.ok(
          !newtonsoft?.evidence?.occurrences?.length,
          "a failed slice run must not fabricate evidence",
        );
      } finally {
        warnStub.restore();
        rmSync(scanDir, { force: true, recursive: true });
      }
    });

    it("slices into a directory of its own and removes it, even when the run fails", async () => {
      // A fixed dosai.json in the shared temp directory was reused by every
      // later scan, of any project, as if it were that project's evidence.
      const scanDir = mkdtempSync(join(tmpdir(), "cdxgen-dotnet-own-slices-"));
      const slicePaths = [];
      try {
        writeCsProj(scanDir);
        const createDosaiMethodsSlice = sinon.stub().callsFake((_src, out) => {
          slicePaths.push(out);
          writeFileSync(out, JSON.stringify(dosaiMethodsSlice(scanDir)));
          return true;
        });
        const { createCsharpBom: mockedCreateCsharpBom } = await esmock(
          "./managedBom.js",
          { "../inventory/dosai.js": { createDosaiMethodsSlice } },
        );
        const options = {
          projectType: ["csharp"],
          deep: true,
          specVersion: 1.7,
        };
        const first = await mockedCreateCsharpBom(scanDir, options);
        assertSliceEvidenceApplied(first, scanDir);
        await mockedCreateCsharpBom(scanDir, options);
        assert.strictEqual(slicePaths.length, 2);
        assert.notStrictEqual(dirname(slicePaths[0]), dirname(slicePaths[1]));
        for (const slicePath of slicePaths) {
          assert.ok(
            dirname(slicePath).split(/[\\/]/).pop().startsWith("cdxgen-dosai-"),
          );
          assert.ok(
            !existsSync(dirname(slicePath)),
            "the run's directory is removed",
          );
        }
        // A failure while slicing still removes the directory
        createDosaiMethodsSlice.callsFake((_src, out) => {
          slicePaths.push(out);
          throw new Error("dosai crashed");
        });
        await assert.rejects(
          mockedCreateCsharpBom(scanDir, options),
          /dosai crashed/,
        );
        assert.ok(!existsSync(dirname(slicePaths[2])));
      } finally {
        rmSync(scanDir, { force: true, recursive: true });
      }
    });

    it("keeps an assembly version out of a versionless package", async () => {
      // The slice's AssemblyInformation says Serilog's assembly is 3.1.1. An
      // assembly version is not the package version, so Serilog stays
      // versionless rather than gaining one the project never stated.
      const scanDir = mkdtempSync(join(tmpdir(), "cdxgen-dotnet-asm-version-"));
      try {
        writeCsProj(scanDir);
        writeFileSync(
          join(scanDir, "deps.slices.json"),
          JSON.stringify(dosaiMethodsSlice(scanDir)),
        );
        const bomNSData = await createCsharpBom(scanDir, {
          projectType: ["csharp"],
          deep: true,
          specVersion: 1.7,
          depsSlicesFile: "deps.slices.json",
        });
        const serilog = (bomNSData.bomJson.components || []).find(
          (c) => c.name === "Serilog",
        );
        assert.strictEqual(serilog.version, undefined);
        assert.strictEqual(serilog.purl, "pkg:nuget/Serilog");
      } finally {
        rmSync(scanDir, { force: true, recursive: true });
      }
    });
  });

  describe("createCryptoCertsBom() dosai crypto analysis", () => {
    it("does not invoke dosai crypto analysis for non-.NET CBOM scans", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "cdxgen-cbom-non-dotnet-"));
      const collectDosaiCryptoComponents = sinon.stub().resolves([]);
      try {
        const { createCryptoCertsBom } = await esmock("./managedBom.js", {
          "../inventory/cbomutils.js": {
            collectDosaiCryptoComponents,
            collectSourceCryptoComponents: sinon.stub().resolves([]),
          },
        });

        await createCryptoCertsBom(tempDir, {
          projectType: ["js"],
          specVersion: 1.7,
        });

        sinon.assert.notCalled(collectDosaiCryptoComponents);
      } finally {
        rmSync(tempDir, { force: true, recursive: true });
      }
    });

    it("invokes dosai crypto analysis for explicit .NET CBOM scans", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "cdxgen-cbom-dotnet-"));
      const collectDosaiCryptoComponents = sinon.stub().resolves([
        {
          name: "sha-256",
          type: "cryptographic-asset",
          "bom-ref": "crypto/algorithm/sha-256@2.16.840.1.101.3.4.2.1",
          cryptoProperties: {
            assetType: "algorithm",
            oid: "2.16.840.1.101.3.4.2.1",
          },
        },
      ]);
      try {
        const { createCryptoCertsBom } = await esmock("./managedBom.js", {
          "../inventory/cbomutils.js": {
            collectDosaiCryptoComponents,
            collectSourceCryptoComponents: sinon.stub().resolves([]),
          },
        });

        const bomData = await createCryptoCertsBom(tempDir, {
          projectType: ["dotnet"],
          specVersion: 1.7,
        });

        sinon.assert.calledOnce(collectDosaiCryptoComponents);
        assert.strictEqual(bomData.bomJson.components[0].name, "sha-256");
      } finally {
        rmSync(tempDir, { force: true, recursive: true });
      }
    });

    it("invokes dosai crypto analysis when universal scans contain .NET project files", async () => {
      const tempDir = mkdtempSync(
        join(tmpdir(), "cdxgen-cbom-dotnet-indicator-"),
      );
      const collectDosaiCryptoComponents = sinon.stub().resolves([]);
      try {
        writeFileSync(join(tempDir, "app.csproj"), "<Project />");
        const { createCryptoCertsBom } = await esmock("./managedBom.js", {
          "../inventory/cbomutils.js": {
            collectDosaiCryptoComponents,
            collectSourceCryptoComponents: sinon.stub().resolves([]),
          },
        });

        await createCryptoCertsBom(tempDir, {
          projectType: ["universal"],
          specVersion: 1.7,
        });

        sinon.assert.calledOnce(collectDosaiCryptoComponents);
      } finally {
        rmSync(tempDir, { force: true, recursive: true });
      }
    });
  });

  describe("createPythonBom() lock file root dependencies", () => {
    const expectedDirectDeps = [
      "pkg:pypi/certifi@2022.12.7",
      "pkg:pypi/charset-normalizer@2.0.12",
      "pkg:pypi/idna@3.3",
      "pkg:pypi/requests@2.28.0",
      "pkg:pypi/urllib3@1.26.13",
    ];

    for (const [lockName, fixtureDirPath] of [
      ["uv.lock", uvSmokeFixtureDir],
      ["pylock.toml", pyLockSmokeFixtureDir],
    ]) {
      it(`makes the parent component depend on the first level from ${lockName}`, async () => {
        const options = { installDeps: false, projectType: ["python"] };
        const bomJson = (await createPythonBom(fixtureDirPath, options))
          .bomJson;
        const parentRef = bomJson.metadata.component["bom-ref"];
        assert.strictEqual(parentRef, "pkg:pypi/uv-smoke@1.0.0");
        const parentEntry = bomJson.dependencies.find(
          (adep) => adep.ref === parentRef,
        );
        assert.ok(
          parentEntry,
          `expected a dependencies entry for ${parentRef}`,
        );
        assert.deepStrictEqual(parentEntry.dependsOn, expectedDirectDeps);
        assert.strictEqual(
          bomJson.dependencies.filter((adep) => adep.ref === parentRef).length,
          1,
          "expected a single entry for the parent component",
        );
      });
    }
  });

  describe("createRubyBom() metadata component from the root gemspec", () => {
    // Fixture files are verbatim from the
    // open-telemetry/opentelemetry-ruby-contrib instrumentation/action_mailer
    // gem: the gemspec assigns the version from a constant and builds its
    // metadata URIs with `#{spec.name}` interpolation (discussions 4388,
    // 4389, and 4390).
    const otelFixtureDir = "./test/data/otel-action-mailer";
    const gemName = "opentelemetry-instrumentation-action_mailer";
    const gemPurl = `pkg:gem/${gemName}@0.8.1`;
    const activeSupportRef =
      "pkg:gem/opentelemetry-instrumentation-active_support@0.12.1";
    const gemDescription =
      "ActionMailer instrumentation for the OpenTelemetry framework";

    const scanRuby = async (dir, extraOptions = {}) => {
      const { bomJson } = await createRubyBom(dir, {
        installDeps: false,
        projectType: ["ruby"],
        ...extraOptions,
      });
      assert.strictEqual(await validateBom(bomJson), true);
      return bomJson;
    };
    const danglingRefs = (bomJson) => {
      const known = new Set([
        bomJson.metadata.component["bom-ref"],
        ...bomJson.components.map((comp) => comp["bom-ref"]),
      ]);
      return bomJson.dependencies
        .flatMap((dep) => [dep.ref, ...(dep.dependsOn || [])])
        .filter((ref) => !known.has(ref));
    };
    const parentDependsOn = (bomJson) =>
      bomJson.dependencies.find(
        (dep) => dep.ref === bomJson.metadata.component["bom-ref"],
      )?.dependsOn || [];
    // Copy the fixture, optionally without its version file, into a
    // temporary directory. The caller removes it.
    const copyOtelFixture = ({ withVersionFile = true } = {}) => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cdxgen-ruby-"));
      for (const file of ["Gemfile", "Gemfile.lock", `${gemName}.gemspec`]) {
        copyFileSync(join(otelFixtureDir, file), join(tmpDir, file));
      }
      if (withVersionFile) {
        const versionFile =
          "lib/opentelemetry/instrumentation/action_mailer/version.rb";
        mkdirSync(dirname(join(tmpDir, versionFile)), { recursive: true });
        copyFileSync(
          join(otelFixtureDir, versionFile),
          join(tmpDir, versionFile),
        );
      }
      return tmpDir;
    };

    it("describes the gem being built in metadata.component", async () => {
      const bomJson = await scanRuby(otelFixtureDir);
      const parent = bomJson.metadata.component;
      assert.strictEqual(parent.name, gemName);
      assert.strictEqual(parent.version, "0.8.1");
      assert.strictEqual(parent["bom-ref"], gemPurl);
      assert.strictEqual(parent.purl, gemPurl);
      assert.strictEqual(parent.description, gemDescription);
      assert.deepStrictEqual(parent.authors, [
        {
          name: "OpenTelemetry Authors",
          email: "cncf-opentelemetry-contributors@lists.cncf.io",
        },
      ]);
      assert.deepStrictEqual(parent.licenses, [
        { license: { name: "Apache-2.0" } },
      ]);
      // The interpolated gemspec metadata URIs survive as external references
      assert.deepStrictEqual(
        (parent.externalReferences || []).map((ref) => ref.type).sort(),
        ["documentation", "issue-tracker", "release-notes", "vcs", "website"],
      );
      // The gemspec's own gem properties move with it
      assert.strictEqual(
        getProp(parent, "cdx:gem:rubyVersionSpecifiers"),
        ">= 3.3",
      );
    });

    it("does not repeat the gem as a component and keeps the graph rooted at it", async () => {
      const bomJson = await scanRuby(otelFixtureDir);
      assert.deepStrictEqual(
        bomJson.components.filter((comp) => comp.name === gemName),
        [],
        "the gem itself must only appear as metadata.component",
      );
      const refs = [
        bomJson.metadata.component["bom-ref"],
        ...bomJson.components.map((comp) => comp["bom-ref"]),
      ];
      assert.deepStrictEqual(
        refs.filter((ref, i) => refs.indexOf(ref) !== i),
        [],
        "bom-refs must be unique across the document",
      );
      assert.deepStrictEqual(danglingRefs(bomJson), []);
      assert.ok(
        parentDependsOn(bomJson).includes(activeSupportRef),
        "expected the gem's runtime dependency in dependsOn",
      );
      assert.ok(!parentDependsOn(bomJson).includes(gemPurl));
    });

    it("adopts the lockfile version when the version constant cannot be resolved", async () => {
      const tmpDir = copyOtelFixture({ withVersionFile: false });
      try {
        const bomJson = await scanRuby(tmpDir);
        const parent = bomJson.metadata.component;
        // No lib/**/version.rb here, so the version comes from the lockfile
        assert.strictEqual(parent.version, "0.8.1");
        assert.strictEqual(parent["bom-ref"], gemPurl);
        // The URIs built from the version resolve against the adopted one
        assert.ok(
          parent.externalReferences.some(
            (ref) =>
              ref.url ===
              `https://rubydoc.info/gems/${gemName}/0.8.1/file/CHANGELOG.md`,
          ),
        );
        assert.deepStrictEqual(
          bomJson.components.filter((comp) => comp.name === gemName),
          [],
          "both the versioned and unversioned sightings must be folded into the parent",
        );
        assert.deepStrictEqual(danglingRefs(bomJson), []);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("describes the gem for an explicit --project-name naming it", async () => {
      const bomJson = await scanRuby(otelFixtureDir, {
        "project-name": gemName,
        projectName: gemName,
        projectVersion: "0.8.1",
      });
      const parent = bomJson.metadata.component;
      assert.strictEqual(parent.purl, gemPurl);
      // Naming the gem must not cost its metadata (the third scenario of
      // discussion 4388)
      assert.strictEqual(parent.description, gemDescription);
      assert.deepStrictEqual(parent.licenses, [
        { license: { name: "Apache-2.0" } },
      ]);
      assert.strictEqual(parent.authors?.length, 1);
      assert.deepStrictEqual(
        bomJson.components.filter((comp) => comp.name === gemName),
        [],
      );
      assert.deepStrictEqual(danglingRefs(bomJson), []);
    });

    it("moves the gem's edges to a parent versioned by --project-version", async () => {
      const bomJson = await scanRuby(otelFixtureDir, {
        projectVersion: "0.9.0",
      });
      const parent = bomJson.metadata.component;
      assert.strictEqual(parent.purl, `pkg:gem/${gemName}@0.9.0`);
      // The lockfile still calls the local gem 0.8.1, and that sighting is
      // the project too
      assert.deepStrictEqual(
        bomJson.components.filter((comp) => comp.name === gemName),
        [],
      );
      assert.ok(parentDependsOn(bomJson).includes(activeSupportRef));
      assert.deepStrictEqual(danglingRefs(bomJson), []);
      // Checksums of another release do not describe this one
      assert.strictEqual(parent.hashes, undefined);
    });

    it("keeps the gem as a component when --project-name names another project", async () => {
      const bomJson = await scanRuby(otelFixtureDir, {
        "project-name": "umbrella",
        projectName: "umbrella",
        projectVersion: "1.0.0",
      });
      assert.strictEqual(
        bomJson.metadata.component.purl,
        "pkg:gem/umbrella@1.0.0",
      );
      const gem = bomJson.components.find((comp) => comp.purl === gemPurl);
      assert.ok(gem, "expected the gem to remain a component");
      // Its lockfile and gemspec sightings are one component with metadata
      assert.strictEqual(gem.description, gemDescription);
      assert.strictEqual(
        bomJson.components.filter((comp) => comp.name === gemName).length,
        1,
      );
      assert.ok(parentDependsOn(bomJson).includes(gemPurl));
      assert.deepStrictEqual(danglingRefs(bomJson), []);
    });

    it("keeps another release of the gem that a nested project depends on", async () => {
      const tmpDir = copyOtelFixture();
      try {
        mkdirSync(join(tmpDir, "examples", "app"), { recursive: true });
        writeFileSync(
          join(tmpDir, "examples", "app", "Gemfile.lock"),
          `GEM
  remote: https://rubygems.org/
  specs:
    ${gemName} (0.7.0)

PLATFORMS
  ruby

DEPENDENCIES
  ${gemName} (= 0.7.0)

BUNDLED WITH
   2.5.16
`,
        );
        const bomJson = await scanRuby(tmpDir, { multiProject: true });
        assert.strictEqual(bomJson.metadata.component.purl, gemPurl);
        // The published 0.7.0 release is a real dependency, not the project
        assert.deepStrictEqual(
          bomJson.components
            .filter((comp) => comp.name === gemName)
            .map((comp) => comp.purl),
          [`pkg:gem/${gemName}@0.7.0`],
        );
        assert.deepStrictEqual(danglingRefs(bomJson), []);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    describe("the Ruby runtime (discussion 4409)", () => {
      // The installed rake 13.4.2 gemspec requires Ruby >= 2.3 and ships the
      // `rake` executable; the compact index cache is emptied so no gem on
      // the machine running the tests adds a requirement of its own
      const scanWithCaches = async (extraOptions) => {
        const saved = {
          CDXGEN_GEM_HOME: process.env.CDXGEN_GEM_HOME,
          CDXGEN_COMPACT_INDEX_CACHE_DIR:
            process.env.CDXGEN_COMPACT_INDEX_CACHE_DIR,
        };
        const emptyCache = mkdtempSync(join(tmpdir(), "cdxgen-ruby-cache-"));
        process.env.CDXGEN_GEM_HOME = "./test/data/ruby-cache/gemhome";
        process.env.CDXGEN_COMPACT_INDEX_CACHE_DIR = emptyCache;
        try {
          return await scanRuby(otelFixtureDir, extraOptions);
        } finally {
          for (const [name, value] of Object.entries(saved)) {
            if (value === undefined) {
              delete process.env[name];
            } else {
              process.env[name] = value;
            }
          }
          rmSync(emptyCache, { recursive: true, force: true });
        }
      };
      const rakeRef = "pkg:gem/rake@13.4.2";
      const dependsOnOf = (bomJson, ref) =>
        bomJson.dependencies.find((dep) => dep.ref === ref)?.dependsOn || [];

      it("describes the runtime once, with the intersected range, at 1.7", async () => {
        const bomJson = await scanWithCaches({ specVersion: 1.7 });
        const runtimes = bomJson.components.filter(
          (comp) => comp.name === "ruby",
        );
        assert.strictEqual(runtimes.length, 1);
        const [runtime] = runtimes;
        assert.strictEqual(runtime.type, "platform");
        assert.strictEqual(runtime.purl, "pkg:generic/ruby");
        assert.strictEqual(runtime["bom-ref"], "pkg:generic/ruby");
        assert.strictEqual(runtime.isExternal, true);
        assert.strictEqual(runtime.scope, "required");
        assert.strictEqual(runtime.version, undefined);
        // `>= 3.3` from the gemspec and `>= 2.3` from rake intersect
        assert.strictEqual(runtime.versionRange, "vers:gem/>=3.3");
        assert.ok(parentDependsOn(bomJson).includes("pkg:generic/ruby"));
        assert.ok(dependsOnOf(bomJson, rakeRef).includes("pkg:generic/ruby"));
        assert.deepStrictEqual(dependsOnOf(bomJson, "pkg:generic/ruby"), []);
        assert.deepStrictEqual(danglingRefs(bomJson), []);
        // The installed gemspec's executable makes rake an application
        // (discussion 4408), and its authors survive offline (discussion 4403)
        const rake = bomJson.components.find(
          (comp) => comp["bom-ref"] === rakeRef,
        );
        assert.strictEqual(rake.type, "application");
        assert.deepStrictEqual(
          rake.authors.map((author) => author.name),
          ["Hiroshi SHIBATA", "Eric Hodel", "Jim Weirich"],
        );
        assert.strictEqual(
          getProp(rake, "cdx:gem:rubyVersionSpecifiers"),
          ">= 2.3",
        );
      });

      it("leaves the runtime out of a BOM that cannot call it external", async () => {
        const bomJson = await scanWithCaches({ specVersion: 1.6 });
        assert.deepStrictEqual(
          bomJson.components.filter((comp) => comp.name === "ruby"),
          [],
        );
        assert.ok(!parentDependsOn(bomJson).includes("pkg:generic/ruby"));
        assert.deepStrictEqual(danglingRefs(bomJson), []);
        // The requirement itself is still recorded
        assert.strictEqual(
          getProp(bomJson.metadata.component, "cdx:gem:rubyVersionSpecifiers"),
          ">= 3.3",
        );
      });
    });
  });
});
