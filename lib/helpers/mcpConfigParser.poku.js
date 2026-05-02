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
              "https://docs.example.com/mcp",
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
      "node:fs": { readFileSync },
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
      "3",
    );
    assert.strictEqual(
      getProp(service, "cdx:mcp:credentialReferenceCount"),
      "1",
    );
    assert.strictEqual(
      getProp(component, "cdx:mcp:credentialExposedServiceCount"),
      "1",
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
});
