import { assert, describe, it } from "poku";

import { classifyMcpReference, enrichComponentWithMcpMetadata } from "./mcp.js";

describe("classifyMcpReference()", () => {
  it("detects official MCP SDK packages", () => {
    const classification = classifyMcpReference({
      purl: "pkg:npm/%40modelcontextprotocol/server@2.0.0-alpha.0",
    });
    assert.strictEqual(classification.isMcp, true);
    assert.strictEqual(classification.isOfficial, true);
    assert.strictEqual(classification.role, "server-sdk");
  });

  it("detects non-official MCP-like packages heuristically", () => {
    const classification = classifyMcpReference({
      purl: "pkg:npm/%40acme/mcp-server@1.0.0",
    });
    assert.strictEqual(classification.isMcp, true);
    assert.strictEqual(classification.isOfficial, false);
    assert.strictEqual(classification.catalogSource, "heuristic");
  });
});

describe("enrichComponentWithMcpMetadata()", () => {
  it("adds MCP properties and tags to official SDK components", () => {
    const component = enrichComponentWithMcpMetadata({
      type: "library",
      name: "server",
      group: "@modelcontextprotocol",
      purl: "pkg:npm/%40modelcontextprotocol/server@2.0.0-alpha.0",
      version: "2.0.0-alpha.0",
    });
    assert.ok(component.tags.includes("mcp"));
    assert.ok(component.tags.includes("official-mcp-sdk"));
    assert.ok(
      component.properties.some(
        (prop) => prop.name === "cdx:mcp:official" && prop.value === "true",
      ),
    );
  });
});
