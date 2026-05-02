import { assert, describe, it } from "poku";

import {
  filterInventoryDependencies,
  inventoryTypesForSubject,
  matchesAiInventoryExcludeType,
  matchesAiInventoryType,
  summarizeAiInventory,
} from "./aiInventory.js";

describe("aiInventory", () => {
  it("classifies agent-derived MCP services as both mcp and ai-skill", () => {
    const service = {
      "bom-ref": "urn:service:agent-mcp:demo:1",
      group: "mcp",
      properties: [
        { name: "cdx:mcp:inventorySource", value: "agent-file" },
        { name: "cdx:mcp:serviceType", value: "inferred-endpoint" },
      ],
    };
    assert.deepStrictEqual(inventoryTypesForSubject(service).sort(), [
      "ai-skill",
      "mcp",
    ]);
    assert.strictEqual(matchesAiInventoryType(service, "mcp"), true);
    assert.strictEqual(matchesAiInventoryType(service, "ai-skill"), true);
  });

  it("limits MCP exclusion matching to AI inventory services, files, and primitives", () => {
    const mcpPackage = {
      "bom-ref": "pkg:npm/@modelcontextprotocol/server-filesystem@1.0.0",
      name: "@modelcontextprotocol/server-filesystem",
      purl: "pkg:npm/%40modelcontextprotocol/server-filesystem@1.0.0",
    };
    const mcpPrimitive = {
      "bom-ref": "urn:mcp:tool:docs:search",
      properties: [{ name: "cdx:mcp:role", value: "tool" }],
      tags: ["mcp", "mcp-tool"],
    };
    const mcpConfig = {
      "bom-ref": "file:/repo/.vscode/mcp.json",
      properties: [{ name: "cdx:file:kind", value: "mcp-config" }],
      type: "file",
    };
    const mcpService = {
      "bom-ref": "urn:service:mcp:docs:latest",
      group: "mcp",
      properties: [{ name: "cdx:mcp:inventorySource", value: "config-file" }],
    };
    assert.strictEqual(matchesAiInventoryExcludeType(mcpPackage, "mcp"), false);
    assert.strictEqual(
      matchesAiInventoryExcludeType(mcpPrimitive, "mcp"),
      true,
    );
    assert.strictEqual(matchesAiInventoryExcludeType(mcpConfig, "mcp"), true);
    assert.strictEqual(matchesAiInventoryExcludeType(mcpService, "mcp"), true);
  });

  it("filters dependencies to retained component and service refs", () => {
    const components = [{ "bom-ref": "file:/repo/CLAUDE.md" }];
    const services = [{ "bom-ref": "urn:service:mcp:docs:latest" }];
    const filtered = filterInventoryDependencies(
      [
        {
          ref: "urn:service:mcp:docs:latest",
          provides: ["file:/repo/CLAUDE.md", "urn:service:mcp:other:latest"],
        },
        {
          ref: "urn:service:mcp:missing:latest",
          provides: ["file:/repo/CLAUDE.md"],
        },
      ],
      components,
      services,
    );
    assert.deepStrictEqual(filtered, [
      {
        ref: "urn:service:mcp:docs:latest",
        provides: ["file:/repo/CLAUDE.md"],
      },
    ]);
  });

  it("summarizes AI inventory counts for instructions, skills, configs, and services", () => {
    const summary = summarizeAiInventory({
      components: [
        {
          properties: [{ name: "cdx:file:kind", value: "agent-instructions" }],
        },
        {
          properties: [
            { name: "cdx:file:kind", value: "copilot-instructions" },
          ],
        },
        {
          properties: [{ name: "cdx:file:kind", value: "skill-file" }],
        },
        {
          properties: [{ name: "cdx:file:kind", value: "mcp-config" }],
        },
      ],
      services: [{ name: "releaseDocs" }, { name: "deployBot" }],
    });
    assert.deepStrictEqual(summary, {
      instructionCount: 2,
      mcpConfigCount: 1,
      mcpServiceCount: 2,
      skillCount: 1,
    });
  });
});
