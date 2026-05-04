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

  it("sanitizes secret-bearing AI inventory properties before emission", async () => {
    const readFileSync = sinon.stub();
    readFileSync.withArgs("/repo/opencode.json", "utf-8").returns(
      JSON.stringify({
        agent: {
          release: {
            description:
              "Deploy with https://user:pass@example.com/release?access_token=abc#frag and sk_test_super_secret_value",
            permission: {
              endpoints: [
                "https://user:pass@example.com/private?token=abc#frag",
              ],
              __proto__: {
                polluted: true,
              },
            },
          },
        },
      }),
    );
    readFileSync
      .withArgs("/repo/.claude/skills/release/SKILL.md", "utf-8")
      .returns(
        [
          "---",
          "name: release",
          "description: Publish release notes",
          "metadata:",
          "  endpoint: https://user:pass@example.com/skill?token=abc#frag",
          "  apiKey: sk_test_skill_secret_value",
          "---",
          "Use the release workflow.",
        ].join("\n"),
      );
    const { communityAiConfigParser } = await esmock(
      "./communityAiConfigParser.js",
      {
        "node:fs": { readFileSync },
      },
    );

    const result = communityAiConfigParser.parse([
      "/repo/opencode.json",
      "/repo/.claude/skills/release/SKILL.md",
    ]);
    const agent = result.components.find(
      (component) => getProp(component, "cdx:file:kind") === "agent-config",
    );
    const skill = result.components.find(
      (component) => getProp(component, "cdx:file:kind") === "skill-file",
    );

    assert.strictEqual(
      getProp(agent, "cdx:agent:description"),
      "Deploy with https://example.com/release and [redacted]",
    );
    assert.strictEqual(
      getProp(agent, "cdx:agent:permission"),
      JSON.stringify({
        endpoints: ["https://example.com/private"],
      }),
    );
    assert.strictEqual(
      getProp(skill, "cdx:skill:metadata"),
      JSON.stringify({
        endpoint: "https://example.com/skill",
        apiKey: "[redacted]",
      }),
    );
  });
});
