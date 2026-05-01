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

  it("classifies official npm import strings using the package root", () => {
    const classification = classifyMcpReference(
      "@modelcontextprotocol/client/stdio",
    );
    assert.strictEqual(classification.isMcp, true);
    assert.strictEqual(classification.isOfficial, true);
    assert.strictEqual(classification.role, "client-sdk");
    assert.strictEqual(
      classification.packageName,
      "@modelcontextprotocol/client",
    );
  });

  it("detects known maven integrations separately from official SDKs", () => {
    const classification = classifyMcpReference({
      purl: "pkg:maven/org.springframework.ai/spring-ai-mcp@1.0.0",
    });
    assert.strictEqual(classification.isMcp, true);
    assert.strictEqual(classification.isOfficial, false);
    assert.strictEqual(classification.isKnownIntegration, true);
    assert.strictEqual(classification.catalogSource, "known-integration");
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

  it("is idempotent when metadata enrichment is applied multiple times", () => {
    const component = {
      type: "library",
      name: "client",
      group: "@modelcontextprotocol",
      purl: "pkg:npm/%40modelcontextprotocol/client@1.0.0",
      properties: [],
      tags: [],
      version: "1.0.0",
    };
    enrichComponentWithMcpMetadata(component);
    enrichComponentWithMcpMetadata(component);
    assert.strictEqual(component.tags.filter((tag) => tag === "mcp").length, 1);
    assert.strictEqual(
      component.properties.filter((prop) => prop.name === "cdx:mcp:package")
        .length,
      1,
    );
  });

  it("leaves non-MCP components unchanged", () => {
    const component = {
      name: "lodash",
      purl: "pkg:npm/lodash@4.17.21",
      properties: [{ name: "existing", value: "true" }],
      tags: ["utility"],
      type: "library",
      version: "4.17.21",
    };
    const enriched = enrichComponentWithMcpMetadata(component);
    assert.deepStrictEqual(enriched.properties, [
      { name: "existing", value: "true" },
    ]);
    assert.deepStrictEqual(enriched.tags, ["utility"]);
  });
});
