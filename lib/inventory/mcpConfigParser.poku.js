import esmock from "esmock";
import { assert, describe, it } from "poku";
import sinon from "sinon";

function getProp(obj, name) {
  return obj?.properties?.find((property) => property.name === name)?.value;
}

describe("mcpConfigParser", () => {
  it("normalizes Windows paths for config format detection and treats jsonc as json", async () => {
    const readFileSync = sinon.stub();
    const scanTextForHiddenUnicode = sinon.stub().returns({
      hasHiddenUnicode: false,
    });
    readFileSync.withArgs("C:\\repo\\.vscode\\mcp.json", "utf-8").returns(
      JSON.stringify({
        mcpServers: {
          localDocs: {
            transport: "streamable-http",
            url: "https://docs.example.com/mcp",
          },
        },
      }),
    );
    readFileSync.withArgs("C:\\repo\\opencode.jsonc", "utf-8").returns(`{
        // JSONC config
        "mcp": {
          "remoteDocs": {
            "type": "remote",
            "url": "https://example.com/mcp"
          }
        }
      }`);
    const { mcpConfigParser } = await esmock("./mcpConfigParser.js", {
      "../core/boundedFile.js": {
        readRegularTextFile: (filePath) => readFileSync(filePath, "utf-8"),
      },
      "./unicodeScan.js": { scanTextForHiddenUnicode },
    });

    const result = mcpConfigParser.parse([
      "C:\\repo\\.vscode\\mcp.json",
      "C:\\repo\\opencode.jsonc",
    ]);

    assert.ok(
      result.components.some(
        (component) => getProp(component, "cdx:mcp:configFormat") === "vscode",
      ),
    );
    assert.ok(
      result.components.some(
        (component) =>
          getProp(component, "cdx:mcp:configFormat") === "opencode",
      ),
    );
    sinon.assert.calledWithMatch(scanTextForHiddenUnicode, sinon.match.string, {
      syntax: "json",
    });
  });

  it("records credential exposure without embedding raw secret metadata", async () => {
    const readFileSync = sinon.stub();
    const scanTextForHiddenUnicode = sinon.stub().returns({
      hasHiddenUnicode: false,
    });
    readFileSync.withArgs("/repo/.vscode/mcp.json", "utf-8").returns(
      JSON.stringify({
        mcpServers: {
          releaseDocs: {
            args: [
              "--token",
              "sk_test_super_secret_value",
              "https://user:pass@docs.example.com/mcp?access_token=secret#frag",
            ],
            command: "npx",
            env: {
              API_KEY: "$" + "{API_KEY}",
            },
            headers: {
              Authorization: "Bearer sk_test_another_secret_value",
            },
            transport: "http",
          },
        },
      }),
    );
    const { mcpConfigParser } = await esmock("./mcpConfigParser.js", {
      "../core/boundedFile.js": {
        readRegularTextFile: (filePath) => readFileSync(filePath, "utf-8"),
      },
      "./unicodeScan.js": { scanTextForHiddenUnicode },
    });

    const result = mcpConfigParser.parse(["/repo/.vscode/mcp.json"]);
    const service = result.services[0];
    const component = result.components[0];

    assert.strictEqual(getProp(service, "cdx:mcp:credentialExposure"), "true");
    assert.strictEqual(
      getProp(service, "cdx:mcp:credentialIndicatorCount"),
      "3",
    );
    assert.strictEqual(
      getProp(service, "cdx:mcp:credentialExposureFieldCount"),
      "4",
    );
    assert.strictEqual(
      getProp(service, "cdx:mcp:credentialReferenceCount"),
      "1",
    );
    assert.strictEqual(
      getProp(component, "cdx:mcp:credentialExposedServiceCount"),
      "1",
    );
    assert.strictEqual(getProp(service, "cdx:mcp:command"), "npx");
    assert.deepStrictEqual(service.endpoints, ["https://docs.example.com/mcp"]);
    assert.strictEqual(
      getProp(component, "cdx:mcp:configuredEndpoints"),
      "https://docs.example.com/mcp",
    );
    assert.strictEqual(
      getProp(service, "cdx:mcp:credentialRiskIndicators"),
      undefined,
    );
    assert.strictEqual(
      getProp(service, "cdx:mcp:credentialExposureFields"),
      undefined,
    );
    assert.strictEqual(getProp(service, "cdx:mcp:credentialRefs"), undefined);
    assert.strictEqual(
      getProp(component, "cdx:mcp:credentialExposedServices"),
      undefined,
    );
  });

  it("summarizes Windows executable paths with spaces safely", async () => {
    const readFileSync = sinon.stub();
    const scanTextForHiddenUnicode = sinon.stub().returns({
      hasHiddenUnicode: false,
    });
    readFileSync.withArgs("/repo/.vscode/mcp.json", "utf-8").returns(
      JSON.stringify({
        mcpServers: {
          releaseDocs: {
            args: ["--inspect"],
            command: "C:\\Program Files\\nodejs\\node.exe --inspect",
            mcp: true,
            transport: "stdio",
          },
        },
      }),
    );
    const { mcpConfigParser } = await esmock("./mcpConfigParser.js", {
      "../core/boundedFile.js": {
        readRegularTextFile: (filePath) => readFileSync(filePath, "utf-8"),
      },
      "./unicodeScan.js": { scanTextForHiddenUnicode },
    });

    const result = mcpConfigParser.parse(["/repo/.vscode/mcp.json"]);

    assert.strictEqual(
      getProp(result.services[0], "cdx:mcp:command") ||
        getProp(result.components[0], "cdx:mcp:command"),
      "node.exe",
    );
  });

  it("captures protocol version, deprecated features, and hardened auth", async () => {
    const readFileSync = sinon.stub();
    const scanTextForHiddenUnicode = sinon.stub().returns({
      hasHiddenUnicode: false,
    });
    readFileSync.withArgs("/repo/.mcp.json", "utf-8").returns(
      JSON.stringify({
        mcpServers: {
          legacy: {
            type: "sse",
            url: "https://legacy.example.com/sse",
            protocolVersion: "2025-06-18",
            registration_endpoint: "https://legacy.example.com/register",
          },
          hardened: {
            type: "streamable-http",
            url: "https://api.example.com/mcp",
            protocolVersion: "2026-07-28",
            clientIdMetadataDocumentEnabled: true,
            resourceMetadata: {
              resource: "https://api.example.com/mcp",
              authorization_servers: ["https://auth.example.com"],
            },
          },
        },
      }),
    );
    const { mcpConfigParser } = await esmock("./mcpConfigParser.js", {
      "../core/boundedFile.js": {
        readRegularTextFile: (filePath) => readFileSync(filePath, "utf-8"),
      },
      "./unicodeScan.js": { scanTextForHiddenUnicode },
    });

    const result = mcpConfigParser.parse(["/repo/.mcp.json"]);
    const legacy = result.services.find(
      (service) => getProp(service, "cdx:mcp:protocolVersion") === "2025-06-18",
    );
    assert.ok(legacy, "expected the legacy service");
    const deprecated = getProp(legacy, "cdx:mcp:deprecatedFeatures") || "";
    assert.ok(
      deprecated.includes("sse-transport"),
      "expected the SSE transport to be flagged deprecated",
    );
    assert.ok(
      deprecated.includes("dynamic-client-registration"),
      "expected DCR to be flagged deprecated",
    );

    const hardened = result.services.find(
      (service) => getProp(service, "cdx:mcp:protocolVersion") === "2026-07-28",
    );
    assert.ok(hardened, "expected the hardened service");
    assert.strictEqual(getProp(hardened, "cdx:mcp:auth:cimd"), "true");
    assert.strictEqual(getProp(hardened, "cdx:mcp:auth:audienceBound"), "true");
  });

  it("does not flag deprecated features from names or unrelated keys", async () => {
    const readFileSync = sinon.stub();
    const scanTextForHiddenUnicode = sinon.stub().returns({
      hasHiddenUnicode: false,
    });
    // A server merely named for sampling, a legitimate roots path, and a plain
    // http transport must not be flagged as using deprecated MCP features.
    readFileSync.withArgs("/repo/.mcp.json", "utf-8").returns(
      JSON.stringify({
        mcpServers: {
          "data-sampling-mcp": {
            type: "streamable-http",
            url: "https://api.example.com/mcp",
            roots: ["/workspace"],
            logging: { level: "info" },
          },
        },
      }),
    );
    const { mcpConfigParser } = await esmock("./mcpConfigParser.js", {
      "../core/boundedFile.js": {
        readRegularTextFile: (filePath) => readFileSync(filePath, "utf-8"),
      },
      "./unicodeScan.js": { scanTextForHiddenUnicode },
    });

    const result = mcpConfigParser.parse(["/repo/.mcp.json"]);
    const service = result.services[0];
    assert.ok(service, "expected the sampling-named service");
    assert.strictEqual(
      getProp(service, "cdx:mcp:deprecatedFeatures"),
      undefined,
      "a server named for sampling must not be flagged as deprecated",
    );
  });

  it("flags declared capability objects as deprecated features", async () => {
    const readFileSync = sinon.stub();
    const scanTextForHiddenUnicode = sinon.stub().returns({
      hasHiddenUnicode: false,
    });
    readFileSync.withArgs("/repo/.mcp.json", "utf-8").returns(
      JSON.stringify({
        mcpServers: {
          full: {
            type: "streamable-http",
            url: "https://api.example.com/mcp",
            capabilities: { sampling: {}, logging: {}, roots: {} },
          },
        },
      }),
    );
    const { mcpConfigParser } = await esmock("./mcpConfigParser.js", {
      "../core/boundedFile.js": {
        readRegularTextFile: (filePath) => readFileSync(filePath, "utf-8"),
      },
      "./unicodeScan.js": { scanTextForHiddenUnicode },
    });

    const result = mcpConfigParser.parse(["/repo/.mcp.json"]);
    const deprecated =
      getProp(result.services[0], "cdx:mcp:deprecatedFeatures") || "";
    for (const feature of ["sampling", "logging", "roots"]) {
      assert.ok(
        deprecated.includes(feature),
        `expected declared capability ${feature} to be flagged`,
      );
    }
  });

  it("parses Gemini settings and Codex TOML MCP server configs", async () => {
    const readFileSync = sinon.stub();
    const scanTextForHiddenUnicode = sinon.stub().returns({
      hasHiddenUnicode: false,
    });
    readFileSync.withArgs("/repo/.gemini/settings.json", "utf-8").returns(
      JSON.stringify({
        mcpServers: {
          docs: {
            type: "streamable-http",
            url: "https://docs.example.com/mcp",
          },
        },
      }),
    );
    readFileSync
      .withArgs("/repo/.codex/config.toml", "utf-8")
      .returns(
        [
          "[mcp_servers.filesystem]",
          'command = "npx"',
          'args = ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"]',
          "",
          "[mcp_servers.remote]",
          'url = "https://tools.example.com/mcp"',
          'type = "streamable-http"',
        ].join("\n"),
      );
    const { mcpConfigParser } = await esmock("./mcpConfigParser.js", {
      "../core/boundedFile.js": {
        readRegularTextFile: (filePath) => readFileSync(filePath, "utf-8"),
      },
      "./unicodeScan.js": { scanTextForHiddenUnicode },
    });

    const result = mcpConfigParser.parse([
      "/repo/.gemini/settings.json",
      "/repo/.codex/config.toml",
    ]);

    assert.ok(
      result.components.some(
        (component) => getProp(component, "cdx:mcp:configFormat") === "gemini",
      ),
      "expected a gemini config component",
    );
    const codexComponent = result.components.find(
      (component) => getProp(component, "cdx:mcp:configFormat") === "codex",
    );
    assert.ok(codexComponent, "expected a codex config component");
    const codexServices = result.services.filter(
      (service) => getProp(service, "cdx:mcp:configFormat") === "codex",
    );
    assert.strictEqual(
      codexServices.length,
      2,
      "expected both Codex TOML servers",
    );
  });

  it("labels the Kiro workspace MCP config", async () => {
    const readFileSync = sinon.stub();
    const scanTextForHiddenUnicode = sinon.stub().returns({
      hasHiddenUnicode: false,
    });
    readFileSync
      .withArgs("C:\\repo\\.kiro\\settings\\mcp.json", "utf-8")
      .returns(
        JSON.stringify({
          mcpServers: {
            docs: {
              url: "https://knowledge-mcp.example.com/mcp",
              type: "http",
            },
          },
        }),
      );
    const { mcpConfigParser } = await esmock("./mcpConfigParser.js", {
      "../core/boundedFile.js": {
        readRegularTextFile: (filePath) => readFileSync(filePath, "utf-8"),
      },
      "./unicodeScan.js": { scanTextForHiddenUnicode },
    });
    assert.ok(
      mcpConfigParser.patterns.includes("**/.kiro/settings/mcp.json"),
      "expected a Kiro MCP config pattern",
    );
    const result = mcpConfigParser.parse([
      "C:\\repo\\.kiro\\settings\\mcp.json",
    ]);
    assert.ok(
      result.components.some(
        (component) => getProp(component, "cdx:mcp:configFormat") === "kiro",
      ),
      "expected a kiro config component",
    );
    assert.ok(
      result.services.some(
        (service) => getProp(service, "cdx:mcp:configFormat") === "kiro",
      ),
      "expected the configured Kiro MCP server",
    );
  });
});
