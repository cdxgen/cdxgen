import { assert, describe, it } from "poku";

import {
  filterInventoryDependencies,
  inventoryTypesForSubject,
  matchesAiInventoryType,
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
});
