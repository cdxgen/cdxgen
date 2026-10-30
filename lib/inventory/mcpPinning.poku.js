import { strict as assert, describe, it } from "poku";

import { applyMcpPinningState } from "./mcpPinning.js";

function mcpPackageComponent(overrides = {}) {
  return {
    type: "library",
    name: "@modelcontextprotocol/server-everything",
    purl: "pkg:npm/@modelcontextprotocol/server-everything@1.0.0",
    properties: [{ name: "cdx:mcp:package", value: "true" }],
    ...overrides,
  };
}

describe("applyMcpPinningState()", () => {
  it("does nothing when the experimental flag is off", () => {
    const bomJson = {
      components: [mcpPackageComponent()],
      services: [],
    };
    const citations = applyMcpPinningState(bomJson, {
      experimentalMcpPinning: false,
    });
    assert.strictEqual(citations.length, 0);
    assert.strictEqual(
      bomJson.components[0].properties.some(
        (p) => p.name === "cdx:mcp:pinning",
      ),
      false,
    );
  });

  it("marks a hashed package component as pinned and emits a citation", () => {
    const component = mcpPackageComponent({
      hashes: [{ alg: "SHA-512", content: "a".repeat(128) }],
    });
    const bomJson = {
      metadata: {
        tools: {
          components: [
            { "bom-ref": "pkg:npm/@cdxgen/cdxgen@13.0.0", name: "cdxgen" },
          ],
        },
      },
      components: [component],
      services: [],
    };
    const citations = applyMcpPinningState(bomJson, {
      experimentalMcpPinning: true,
    });
    const pinning = component.properties.find(
      (p) => p.name === "cdx:mcp:pinning",
    );
    assert.strictEqual(pinning.value, "pinned");
    assert.strictEqual(citations.length, 1);
    // Attribution must name an object that exists in the BOM.
    assert.strictEqual(
      citations[0].attributedTo,
      "pkg:npm/@cdxgen/cdxgen@13.0.0",
    );
    assert.ok(citations[0].expressions.length > 0);
  });

  it("drops the citation when the BOM names no cdxgen tool to attribute it to", () => {
    const component = mcpPackageComponent({
      hashes: [{ alg: "SHA-512", content: "a".repeat(128) }],
    });
    const bomJson = { components: [component], services: [] };
    const citations = applyMcpPinningState(bomJson, {
      experimentalMcpPinning: true,
    });
    assert.deepStrictEqual(citations, []);
    // The pinning state itself is still recorded.
    assert.strictEqual(
      component.properties.find((p) => p.name === "cdx:mcp:pinning").value,
      "pinned",
    );
  });

  it("marks a hash-less package component as unpinned (absence is explicit)", () => {
    const component = mcpPackageComponent();
    const bomJson = { components: [component], services: [] };
    applyMcpPinningState(bomJson, { experimentalMcpPinning: true });
    const pinning = component.properties.find(
      (p) => p.name === "cdx:mcp:pinning",
    );
    assert.strictEqual(pinning.value, "unpinned");
  });

  it("treats an ssri _integrity as a pin", () => {
    const component = mcpPackageComponent({ _integrity: "sha512-abc=" });
    const bomJson = { components: [component], services: [] };
    applyMcpPinningState(bomJson, { experimentalMcpPinning: true });
    const pinning = component.properties.find(
      (p) => p.name === "cdx:mcp:pinning",
    );
    assert.strictEqual(pinning.value, "pinned");
    delete component._integrity;
  });

  it("marks a remote package-less MCP service as composition-unknown and unhashable", () => {
    const service = {
      name: "remote-mcp",
      properties: [
        { name: "cdx:mcp:transport", value: "streamable-http" },
        { name: "cdx:mcp:packageRefs", value: "" },
      ],
    };
    const bomJson = { components: [], services: [service] };
    applyMcpPinningState(bomJson, { experimentalMcpPinning: true });
    const composition = service.properties.find(
      (p) => p.name === "cdx:mcp:composition",
    );
    const pinning = service.properties.find(
      (p) => p.name === "cdx:mcp:pinning",
    );
    assert.strictEqual(composition.value, "unknown");
    assert.strictEqual(pinning.value, "unhashable");
  });

  it("inherits transport from a service that references the package", () => {
    const component = mcpPackageComponent();
    const service = {
      name: "configured-server",
      properties: [
        { name: "cdx:mcp:transport", value: "stdio" },
        {
          name: "cdx:mcp:packageRefs",
          value: "@modelcontextprotocol/server-everything",
        },
      ],
    };
    const bomJson = { components: [component], services: [service] };
    applyMcpPinningState(bomJson, { experimentalMcpPinning: true });
    const transport = component.properties.find(
      (p) => p.name === "cdx:mcp:transport",
    );
    assert.strictEqual(transport.value, "stdio");
  });
});
