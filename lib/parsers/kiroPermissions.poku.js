import { assert, describe, it } from "poku";

import {
  kiroPermissionSummaryEntries,
  summarizeKiroPermissions,
} from "./kiroPermissions.js";

describe("summarizeKiroPermissions", () => {
  it("summarizes effect counts and capabilities from a rules array", () => {
    const summary = summarizeKiroPermissions({
      rules: [
        { capability: "shell", effect: "allow" },
        { capability: "fs_write", effect: "deny", match: ["**/.env"] },
        { capability: "web_fetch", effect: "ask" },
        { capability: "mcp", effect: "evaluate" },
        { capability: "shell", effect: "allow", match: ["git *"] },
      ],
    });
    assert.strictEqual(summary.ruleCount, 5);
    assert.strictEqual(summary.allowRuleCount, 2);
    assert.strictEqual(summary.denyRuleCount, 1);
    assert.strictEqual(summary.askRuleCount, 1);
    assert.strictEqual(summary.evaluateRuleCount, 1);
    assert.deepStrictEqual(summary.capabilities, [
      "fs_write",
      "mcp",
      "shell",
      "web_fetch",
    ]);
    assert.strictEqual(summary.allowsAllCapabilities, false);
    assert.deepStrictEqual(summary.unrestrictedAllowCapabilities, ["shell"]);
    assert.strictEqual(summary.workspaceTrusted, undefined);
    assert.deepStrictEqual(summary.policyPresets, []);
  });

  it("flags an unrestricted allow-all rule", () => {
    const summary = summarizeKiroPermissions({
      rules: [{ capability: "all", effect: "allow" }],
    });
    assert.strictEqual(summary.allowsAllCapabilities, true);
    assert.deepStrictEqual(summary.unrestrictedAllowCapabilities, ["all"]);
    // A match list keeps the same rule out of the unrestricted set.
    const scoped = summarizeKiroPermissions({
      rules: [{ capability: "all", effect: "allow", match: ["git *"] }],
    });
    assert.strictEqual(scoped.allowsAllCapabilities, false);
    assert.deepStrictEqual(scoped.unrestrictedAllowCapabilities, []);
    // An empty match list is not a restriction.
    const emptyMatch = summarizeKiroPermissions({
      rules: [{ capability: "all", effect: "allow", match: [] }],
    });
    assert.strictEqual(emptyMatch.allowsAllCapabilities, true);
  });

  it("reads policy presets and workspace trust from a permissions.yaml document", () => {
    const summary = summarizeKiroPermissions({
      policies: ["approve-for-me", "some-undocumented-preset"],
      rules: [{ capability: "fs_read", effect: "allow" }],
      workspaceTrusted: true,
    });
    assert.deepStrictEqual(summary.policyPresets, ["approve-for-me"]);
    assert.strictEqual(summary.unknownPolicyPresetCount, 1);
    const entries = kiroPermissionSummaryEntries(summary);
    assert.strictEqual(entries.permissionUnknownPolicyPresetCount, 1);
    assert.ok(
      !JSON.stringify(entries).includes("some-undocumented-preset"),
      "an unknown preset name must not be copied",
    );
    assert.strictEqual(summary.workspaceTrusted, true);
    // A non-boolean trust value is never copied.
    const coerced = summarizeKiroPermissions({
      rules: [],
      workspaceTrusted: "true",
    });
    assert.strictEqual(coerced.workspaceTrusted, undefined);
  });

  it("accepts a bare rules array like an agent permissions.rules value", () => {
    const summary = summarizeKiroPermissions([
      { capability: "all", effect: "allow" },
    ]);
    assert.strictEqual(summary.ruleCount, 1);
    assert.strictEqual(summary.allowsAllCapabilities, true);
  });

  it("survives malformed rules without copying their values", () => {
    assert.deepStrictEqual(
      summarizeKiroPermissions(undefined).capabilities,
      [],
    );
    assert.strictEqual(summarizeKiroPermissions(undefined).ruleCount, 0);
    assert.strictEqual(summarizeKiroPermissions(null).ruleCount, 0);
    // A non-array rules value carries no rules.
    const nonArray = summarizeKiroPermissions({ rules: "everything" });
    assert.strictEqual(nonArray.ruleCount, 0);
    const objectRules = summarizeKiroPermissions({ rules: { all: "allow" } });
    assert.strictEqual(objectRules.ruleCount, 0);
    // Null and primitive entries are skipped, not counted.
    const nullEntries = summarizeKiroPermissions({
      rules: [null, "allow everything", 42, { capability: "shell" }],
    });
    assert.strictEqual(nullEntries.ruleCount, 1);
    assert.deepStrictEqual(nullEntries.capabilities, ["shell"]);
    // A non-string capability contributes no capability token.
    const nonString = summarizeKiroPermissions({
      rules: [
        { capability: 42, effect: "allow" },
        { capability: "All", effect: "allow" },
        { capability: "shell command", effect: "allow" },
      ],
    });
    assert.strictEqual(nonString.ruleCount, 3);
    assert.strictEqual(nonString.allowRuleCount, 3);
    assert.deepStrictEqual(nonString.capabilities, []);
    assert.strictEqual(nonString.allowsAllCapabilities, false);
    assert.deepStrictEqual(nonString.unrestrictedAllowCapabilities, []);
    // An unknown effect is counted once, and by no per-effect counter.
    const unknownEffect = summarizeKiroPermissions({
      rules: [{ capability: "shell", effect: "sometimes" }],
    });
    assert.strictEqual(unknownEffect.ruleCount, 1);
    assert.strictEqual(unknownEffect.allowRuleCount, 0);
    assert.strictEqual(unknownEffect.denyRuleCount, 0);
    assert.strictEqual(unknownEffect.askRuleCount, 0);
    assert.strictEqual(unknownEffect.evaluateRuleCount, 0);
  });

  it("never returns match patterns, excludes, reasons, or paths", () => {
    const summary = summarizeKiroPermissions({
      policies: ["approve-for-me"],
      reason: "so the agent can work unattended",
      rules: [
        {
          capability: "shell",
          effect: "deny",
          match: ["rm -rf /*", "git push *--force*"],
          exclude: ["rm -rf /tmp/*"],
        },
        { capability: "fs_write", effect: "deny", match: ["**/.env"] },
      ],
      workspaceTrusted: false,
    });
    const serialized = JSON.stringify(summary);
    assert.ok(!serialized.includes("rm -rf"));
    assert.ok(!serialized.includes("git push"));
    assert.ok(!serialized.includes(".env"));
    assert.ok(!serialized.includes("/tmp"));
    assert.ok(!serialized.includes("unattended"));
    assert.ok(!("reason" in summary));
    assert.strictEqual(summary.workspaceTrusted, false);
    assert.deepStrictEqual(summary.policyPresets, ["approve-for-me"]);
  });
});

describe("kiroPermissionSummaryEntries", () => {
  it("omits list properties that would be empty", () => {
    const entries = kiroPermissionSummaryEntries(
      summarizeKiroPermissions({
        rules: [{ capability: "shell", effect: "deny", match: ["sudo *"] }],
      }),
    );
    assert.strictEqual(entries.permissionCapabilities, "shell");
    assert.strictEqual(entries.permissionRuleCount, 1);
    assert.strictEqual(entries.permissionAllowsAll, false);
    assert.ok(!("permissionUnrestrictedAllowCapabilities" in entries));
    assert.ok(!("permissionPolicyPresets" in entries));
    const empty = kiroPermissionSummaryEntries(summarizeKiroPermissions({}));
    assert.ok(!("permissionCapabilities" in empty));
    assert.ok(Object.values(empty).every((value) => value !== ""));
  });
});
