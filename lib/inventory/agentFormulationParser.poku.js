import esmock from "esmock";
import { assert, describe, it } from "poku";
import sinon from "sinon";

function getProp(obj, name) {
  return obj?.properties?.find((property) => property.name === name)?.value;
}

describe("agentFormulationParser", () => {
  it("sanitizes inferred MCP URLs before emitting them", async () => {
    const readFileSync = sinon.stub();
    const scanTextForHiddenUnicode = sinon.stub().returns({
      hasHiddenUnicode: false,
    });
    readFileSync
      .withArgs("/repo/AGENTS.md", "utf-8")
      .returns(
        [
          "Use the remote MCP endpoint at",
          "https://user:pass@example.com/mcp?access_token=abc#frag",
          "during release preparation.",
        ].join(" "),
      );
    const { agentFormulationParser } = await esmock(
      "./agentFormulationParser.js",
      {
        "../core/boundedFile.js": {
          readRegularTextFile: (filePath) => readFileSync(filePath, "utf-8"),
        },
        "./unicodeScan.js": { scanTextForHiddenUnicode },
      },
    );

    const result = agentFormulationParser.parse(["/repo/AGENTS.md"]);

    assert.strictEqual(
      getProp(result.components[0], "cdx:agent:hiddenMcpUrls"),
      "https://example.com/mcp",
    );
    assert.deepStrictEqual(result.services[0].endpoints, [
      "https://example.com/mcp",
    ]);
  });

  it("keeps path tokens of MCP URLs out of the BOM", async () => {
    const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const readFileSync = sinon.stub();
    const scanTextForHiddenUnicode = sinon.stub().returns({
      hasHiddenUnicode: false,
    });
    readFileSync
      .withArgs("/repo/AGENTS.md", "utf-8")
      .returns(
        [
          `Run npx @acme/mcp-server and connect to https://bot@mcp.example.com/mcp/${token}/sse now.`,
          "Or use deno run npm:@evil/mcp-wrapper with node_modules/@modelcontextprotocol/sdk",
        ].join("\n"),
      );
    const { agentFormulationParser } = await esmock(
      "./agentFormulationParser.js",
      {
        "../core/boundedFile.js": {
          readRegularTextFile: (filePath) => readFileSync(filePath, "utf-8"),
        },
        "./unicodeScan.js": { scanTextForHiddenUnicode },
      },
    );

    const result = agentFormulationParser.parse(["/repo/AGENTS.md"]);

    assert.strictEqual(
      getProp(result.components[0], "cdx:agent:hiddenMcpUrls"),
      "https://mcp.example.com/mcp",
    );
    assert.strictEqual(
      getProp(result.components[0], "cdx:agent:mcpPackageRefs"),
      "@acme/mcp-server,@evil/mcp-wrapper,@modelcontextprotocol/sdk",
    );
    assert.strictEqual(
      getProp(result.components[0], "cdx:agent:credentialRiskIndicators"),
      "github-token",
    );
    assert.deepStrictEqual(result.services[0].endpoints, [
      "https://mcp.example.com/mcp",
    ]);
    assert.ok(!JSON.stringify(result).includes(token));
  });

  it("classifies newly recognized agent instruction and config files", async () => {
    const readFileSync = sinon.stub();
    const scanTextForHiddenUnicode = sinon.stub().returns({
      hasHiddenUnicode: false,
    });
    readFileSync
      .withArgs("/repo/GEMINI.md", "utf-8")
      .returns("# Gemini CLI project instructions\n\nBuild carefully.");
    readFileSync
      .withArgs("/repo/QWEN.md", "utf-8")
      .returns("# Qwen Code instructions\n");
    readFileSync
      .withArgs("/repo/.cursorrules", "utf-8")
      .returns("Always write tests.");
    readFileSync
      .withArgs("/repo/.aider.conf.yml", "utf-8")
      .returns("model: gpt-4o\nauto-commits: false\n");
    const { agentFormulationParser } = await esmock(
      "./agentFormulationParser.js",
      {
        "../core/boundedFile.js": {
          readRegularTextFile: (filePath) => readFileSync(filePath, "utf-8"),
        },
        "./unicodeScan.js": { scanTextForHiddenUnicode },
      },
    );

    const result = agentFormulationParser.parse([
      "/repo/GEMINI.md",
      "/repo/QWEN.md",
      "/repo/.cursorrules",
      "/repo/.aider.conf.yml",
    ]);

    const kindByName = new Map(
      result.components.map((component) => [
        component.name,
        getProp(component, "cdx:file:kind"),
      ]),
    );
    assert.strictEqual(kindByName.get("GEMINI.md"), "agent-instructions");
    assert.strictEqual(kindByName.get("QWEN.md"), "agent-instructions");
    assert.strictEqual(kindByName.get(".cursorrules"), "agent-instructions");
    assert.strictEqual(kindByName.get(".aider.conf.yml"), "agent-config");
  });

  it("only treats CONVENTIONS.md as agent instructions with an Aider marker", async () => {
    const readFileSync = sinon.stub();
    const scanTextForHiddenUnicode = sinon.stub().returns({
      hasHiddenUnicode: false,
    });
    readFileSync
      .withArgs("/plain/CONVENTIONS.md", "utf-8")
      .returns("# Coding conventions\n\nUse two spaces.");
    readFileSync
      .withArgs("/aider/CONVENTIONS.md", "utf-8")
      .returns("# Conventions\n\nPrefer small functions.");
    // Only the /aider directory has an Aider marker beside CONVENTIONS.md, and
    // the one in /linked is a symbolic link, which does not count.
    const lstatSync = sinon.stub().callsFake((path) => {
      const normalized = String(path).replaceAll("\\", "/");
      if (normalized === "/aider/.aider.conf.yml") {
        return { isFile: () => true };
      }
      if (normalized === "/linked/.aider.conf.yml") {
        return { isFile: () => false };
      }
      return undefined;
    });
    const { agentFormulationParser } = await esmock(
      "./agentFormulationParser.js",
      {
        "../core/boundedFile.js": {
          readRegularTextFile: (filePath) => readFileSync(filePath, "utf-8"),
        },
        "node:fs": { lstatSync },
        "./unicodeScan.js": { scanTextForHiddenUnicode },
      },
    );

    readFileSync
      .withArgs("/linked/CONVENTIONS.md", "utf-8")
      .returns("# Conventions\n\nKeep functions short.");
    const result = agentFormulationParser.parse([
      "/plain/CONVENTIONS.md",
      "/aider/CONVENTIONS.md",
      "/linked/CONVENTIONS.md",
    ]);
    const byPath = new Map(
      result.components.map((component) => [
        getProp(component, "internal:SrcFile"),
        getProp(component, "cdx:file:kind"),
      ]),
    );
    assert.strictEqual(byPath.get("/plain/CONVENTIONS.md"), "ai-agent-file");
    assert.strictEqual(
      byPath.get("/aider/CONVENTIONS.md"),
      "agent-instructions",
    );
    assert.strictEqual(byPath.get("/linked/CONVENTIONS.md"), "ai-agent-file");
  });

  it("classifies .clinerules on Windows-style backslash paths", async () => {
    const readFileSync = sinon.stub();
    const scanTextForHiddenUnicode = sinon.stub().returns({
      hasHiddenUnicode: false,
    });
    readFileSync
      .withArgs("C:\\repo\\.clinerules\\rules.md", "utf-8")
      .returns("Follow the house style.");
    const { agentFormulationParser } = await esmock(
      "./agentFormulationParser.js",
      {
        "../core/boundedFile.js": {
          readRegularTextFile: (filePath) => readFileSync(filePath, "utf-8"),
        },
        "./unicodeScan.js": { scanTextForHiddenUnicode },
      },
    );

    const result = agentFormulationParser.parse([
      "C:\\repo\\.clinerules\\rules.md",
    ]);
    assert.strictEqual(
      getProp(result.components[0], "cdx:file:kind"),
      "agent-instructions",
      "expected .clinerules to be recognized on a Windows path",
    );
  });
});
