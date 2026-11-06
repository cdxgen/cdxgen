import { assert, describe, it } from "poku";

import {
  agentToolName,
  agentToolNames,
  splitAllowList,
  summarizeAgentToolList,
} from "./agentToolNames.js";

describe("agent tool allow lists", () => {
  it("splits on the commas outside parentheses", () => {
    assert.deepStrictEqual(
      splitAllowList("Read, Bash(curl -u admin,hunter2,-X POST), Edit"),
      ["Read", "Bash(curl -u admin,hunter2,-X POST)", "Edit"],
    );
    assert.deepStrictEqual(splitAllowList(["Read", "Bash(a,b)", 3]), [
      "Read",
      "Bash(a,b)",
    ]);
  });

  it("keeps tool names and drops anything else", () => {
    for (const name of [
      "Read",
      "mcp__github__*",
      "fs_write",
      "@git/git_status",
      "Bash",
    ]) {
      assert.strictEqual(agentToolName(name), name);
    }
    assert.strictEqual(agentToolName("Bash(rm -rf /tmp/x)"), "Bash");
    for (const unsafe of [
      "ghp_0123456789abcdefghijklmnopqrstuvwxyz",
      "AKIAIOSFODNN7EXAMPLE",
      "a1b2c3d4e5f6a7b8c9d0e1f2a3b4",
      "/etc/passwd",
      "@a/b/c",
      "curl -u admin",
      "x".repeat(65),
      "",
    ]) {
      assert.strictEqual(agentToolName(unsafe), undefined, unsafe);
    }
  });

  it("summarizes a list without copying any scope", () => {
    const value =
      "Read, Bash(git status:*), Bash, Bash(curl -u admin,hunter2canary), ghp_0123456789abcdefghijklmnopqrstuv";
    const summary = summarizeAgentToolList(value);
    assert.strictEqual(summary, "Read,Bash(...),Bash");
    assert.ok(!summary.includes("hunter2canary"));
    assert.ok(!summary.includes("git status"));
    assert.deepStrictEqual(agentToolNames(value), ["Bash", "Read"]);
    assert.strictEqual(summarizeAgentToolList(undefined), undefined);
    assert.strictEqual(summarizeAgentToolList("ghp_abc"), undefined);
  });
});
