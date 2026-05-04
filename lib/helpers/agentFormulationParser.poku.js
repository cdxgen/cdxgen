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
        "node:fs": { readFileSync },
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
});
