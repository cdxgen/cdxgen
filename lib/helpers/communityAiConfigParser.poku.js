import esmock from "esmock";
import { assert, describe, it } from "poku";
import sinon from "sinon";

function getProp(obj, name) {
  return obj?.properties?.find((property) => property.name === name)?.value;
}

describe("communityAiConfigParser", () => {
  it("normalizes Windows paths for community ecosystem discovery", async () => {
    const readFileSync = sinon.stub();
    readFileSync
      .withArgs("C:\\repo\\.opencode\\agents\\review.md", "utf-8")
      .returns(
        [
          "---",
          "description: Reviews code for bugs and quality",
          "mode: subagent",
          "model: anthropic/claude-sonnet-4-20250514",
          "---",
          "Focus on code review findings.",
        ].join("\n"),
      );
    readFileSync
      .withArgs("C:\\repo\\.nanocoder\\commands\\fix.md", "utf-8")
      .returns(
        [
          "---",
          "description: Apply the standard fix workflow",
          "category: engineering",
          "tags: [bugfix, workflow]",
          "---",
          "1. Reproduce the issue",
        ].join("\n"),
      );
    const { communityAiConfigParser } = await esmock(
      "./communityAiConfigParser.js",
      {
        "node:fs": { readFileSync },
      },
    );

    const result = communityAiConfigParser.parse([
      "C:\\repo\\.opencode\\agents\\review.md",
      "C:\\repo\\.nanocoder\\commands\\fix.md",
    ]);

    assert.ok(
      result.components.some(
        (component) =>
          getProp(component, "cdx:agent:framework") === "opencode" &&
          getProp(component, "cdx:file:kind") === "agent-definition",
      ),
    );
    assert.ok(
      result.components.some(
        (component) =>
          getProp(component, "cdx:agent:framework") === "nanocoder" &&
          getProp(component, "cdx:file:kind") === "custom-command",
      ),
    );
  });
});
