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
      "node:fs": { readFileSync },
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
});
