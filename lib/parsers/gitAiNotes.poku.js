import { assert, describe, it } from "poku";

import { parseGitAiNote } from "./gitAiNotes.js";

describe("parseGitAiNote()", () => {
  it("handles empty/malformed inputs gracefully without throwing", () => {
    const emptyResult = parseGitAiNote("");
    assert.strictEqual(emptyResult.agent, "");
    assert.deepStrictEqual(emptyResult.lines, []);

    const nullResult = parseGitAiNote(null);
    assert.strictEqual(nullResult.agent, "");

    const gibberish = parseGitAiNote("asdfjkl;");
    assert.strictEqual(gibberish.agent, "");
  });

  it("parses valid JSON git-ai notes", () => {
    const rawJson = JSON.stringify({
      agent: "claude-code",
      model: "claude-3-5-sonnet",
      session: "session-xyz",
      prompt: "Add new validation rule",
      lines: [10, 11, 12],
      ranges: ["10-12"],
    });

    const parsed = parseGitAiNote(rawJson);
    assert.strictEqual(parsed.agent, "claude-code");
    assert.strictEqual(parsed.model, "claude-3-5-sonnet");
    assert.strictEqual(parsed.session, "session-xyz");
    assert.strictEqual(parsed.prompt, "Add new validation rule");
    assert.deepStrictEqual(parsed.lines, [10, 11, 12]);
    assert.deepStrictEqual(parsed.ranges, ["10-12"]);
    assert.strictEqual(parsed.aiAttributionCount, 4);
    assert.deepStrictEqual(parsed.agents, []);
    assert.deepStrictEqual(parsed.models, []);
    assert.deepStrictEqual(parsed.sessions, {});
    assert.deepStrictEqual(parsed.prompts, {});
  });

  it("parses line-oriented text git-ai notes as fallback", () => {
    const rawText = [
      "# Git-AI metadata",
      "agent: copilot",
      "model = gpt-4o",
      "session: 98765",
      "prompt: optimize loop",
      "lines: [1,2,3]",
      "ranges: 1-3",
    ].join("\n");

    const parsed = parseGitAiNote(rawText);
    assert.strictEqual(parsed.agent, "copilot");
    assert.strictEqual(parsed.model, "gpt-4o");
    assert.strictEqual(parsed.session, "98765");
    assert.strictEqual(parsed.prompt, "optimize loop");
    assert.deepStrictEqual(parsed.lines, [1, 2, 3]);
    assert.deepStrictEqual(parsed.ranges, ["1-3"]);
    assert.strictEqual(parsed.aiAttributionCount, 4);
  });

  // Git AI Standard v3.0.0: attestation section + `---` + JSON metadata.
  it("parses the git-ai authorship/3.0.0 sessions format (excludes humans)", () => {
    const note = [
      "src/main.rs",
      "  s_c9883b05a2487d::t_9f8e7d6c5b4a32 1-10,15-20",
      "  s_c9883b05a2487d::t_a1b2c3d4e5f678 25,30-35",
      "  h_31dce776f88375 42-50",
      "src/lib.rs",
      "  s_e7f2a90b31cc48::t_deadbeef012345 1-50",
      "---",
      JSON.stringify({
        schema_version: "authorship/3.0.0",
        base_commit_sha: "x",
        prompts: {},
        humans: { h_31dce776f88375: { author: "Dev <d@e.com>" } },
        sessions: {
          s_c9883b05a2487d: {
            agent_id: { tool: "cursor", model: "claude-sonnet-4-5" },
          },
          s_e7f2a90b31cc48: {
            agent_id: { tool: "claude", model: "claude-sonnet-4-5" },
          },
        },
      }),
    ].join("\n");

    const parsed = parseGitAiNote(note);
    assert.strictEqual(parsed.agent, "cursor");
    assert.strictEqual(parsed.model, "claude-sonnet-4-5");
    // AI session ranges only; the human (h_) 42-50 range is excluded.
    assert.deepStrictEqual(parsed.ranges, [
      "1-10",
      "15-20",
      "25",
      "30-35",
      "1-50",
    ]);
    // New enhanced fields
    assert.deepStrictEqual(parsed.agents, ["claude", "cursor"]);
    assert.deepStrictEqual(parsed.models, ["claude-sonnet-4-5"]);
    assert.strictEqual(parsed.aiAttributionCount, 5);
    assert.strictEqual(
      Object.keys(parsed.sessions).length,
      2,
      "should have 2 sessions",
    );
    assert.strictEqual(
      Object.keys(parsed.prompts).length,
      0,
      "should have 0 prompts",
    );
  });

  it("parses legacy prompt keys and honors mixed formats", () => {
    const legacy = [
      "src/main.rs",
      "  abcd1234abcd1234 1-10,15-20",
      "---",
      JSON.stringify({
        schema_version: "authorship/3.0.0",
        base_commit_sha: "x",
        prompts: {
          abcd1234abcd1234: { agent_id: { tool: "cursor", model: "gpt-4" } },
        },
      }),
    ].join("\n");
    const p1 = parseGitAiNote(legacy);
    assert.strictEqual(p1.agent, "cursor");
    assert.deepStrictEqual(p1.ranges, ["1-10", "15-20"]);
    assert.deepStrictEqual(p1.agents, ["cursor"]);
    assert.deepStrictEqual(p1.models, ["gpt-4"]);
    assert.strictEqual(p1.aiAttributionCount, 2);

    // Mixed: session (AI) + human (excluded) + legacy prompt (AI).
    const mixed = [
      "src/main.rs",
      "  s_c9883b05a2487d::t_9f8e7d6c5b4a32 1-10",
      "  h_31dce776f88375 15-20",
      "src/lib.rs",
      "  abcd1234abcd1234 1-50",
      "---",
      JSON.stringify({
        schema_version: "authorship/3.0.0",
        base_commit_sha: "x",
        prompts: {
          abcd1234abcd1234: { agent_id: { tool: "cursor", model: "gpt-4" } },
        },
        humans: { h_31dce776f88375: { author: "Dev <d@e.com>" } },
        sessions: {
          s_c9883b05a2487d: { agent_id: { tool: "claude", model: "m" } },
        },
      }),
    ].join("\n");
    const p2 = parseGitAiNote(mixed);
    assert.deepStrictEqual(p2.ranges, ["1-10", "1-50"]);
    assert.deepStrictEqual(p2.agents, ["claude", "cursor"]);
    assert.deepStrictEqual(p2.models, ["gpt-4", "m"]);
    assert.strictEqual(p2.aiAttributionCount, 2);
    assert.strictEqual(Object.keys(p2.sessions).length, 1, "mixed: 1 session");
    assert.strictEqual(Object.keys(p2.prompts).length, 1, "mixed: 1 prompt");
  });

  it("treats a metadata-only authorship note (human commit) as non-AI", () => {
    const note = [
      "---",
      JSON.stringify({
        schema_version: "authorship/3.0.0",
        base_commit_sha: "x",
        prompts: {},
      }),
    ].join("\n");
    const parsed = parseGitAiNote(note);
    assert.strictEqual(parsed.agent, "");
    assert.deepStrictEqual(parsed.ranges, []);
    assert.deepStrictEqual(parsed.lines, []);
    assert.deepStrictEqual(parsed.agents, []);
    assert.deepStrictEqual(parsed.models, []);
    assert.strictEqual(parsed.aiAttributionCount, 0);
  });
});
