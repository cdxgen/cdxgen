import { assert, describe, it } from "poku";

import { mergeDependencies } from "./depsUtils.js";

describe("mergeDependencies()", () => {
  it("merges two non-overlapping dependency arrays", () => {
    const a = [{ ref: "pkg:npm/a@1", dependsOn: ["pkg:npm/b@1"] }];
    const b = [{ ref: "pkg:npm/c@1", dependsOn: ["pkg:npm/d@1"] }];
    const result = mergeDependencies(a, b);
    assert.strictEqual(result.length, 2);
    const aEntry = result.find((d) => d.ref === "pkg:npm/a@1");
    assert.ok(aEntry);
    assert.deepStrictEqual(aEntry.dependsOn, ["pkg:npm/b@1"]);
  });

  it("merges dependsOn sets for the same ref", () => {
    const a = [{ ref: "pkg:npm/a@1", dependsOn: ["pkg:npm/b@1"] }];
    const b = [{ ref: "pkg:npm/a@1", dependsOn: ["pkg:npm/c@1"] }];
    const result = mergeDependencies(a, b);
    assert.strictEqual(result.length, 1);
    const entry = result[0];
    assert.ok(entry.dependsOn.includes("pkg:npm/b@1"));
    assert.ok(entry.dependsOn.includes("pkg:npm/c@1"));
  });

  it("deduplicates identical dependsOn entries", () => {
    const a = [{ ref: "pkg:npm/a@1", dependsOn: ["pkg:npm/b@1"] }];
    const b = [
      { ref: "pkg:npm/a@1", dependsOn: ["pkg:npm/b@1", "pkg:npm/c@1"] },
    ];
    const result = mergeDependencies(a, b);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(
      result[0].dependsOn.filter((x) => x === "pkg:npm/b@1").length,
      1,
    );
  });

  it("handles undefined newDependencies gracefully", () => {
    const a = [{ ref: "pkg:npm/a@1", dependsOn: ["pkg:npm/b@1"] }];
    const result = mergeDependencies(a, undefined);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].ref, "pkg:npm/a@1");
  });

  it("handles empty arrays", () => {
    assert.deepStrictEqual(mergeDependencies([], []), []);
    assert.deepStrictEqual(mergeDependencies([], undefined), []);
  });

  it("merges a single dependency object (non-array)", () => {
    const a = [{ ref: "pkg:npm/a@1", dependsOn: ["pkg:npm/b@1"] }];
    const single = { ref: "pkg:npm/c@1", dependsOn: ["pkg:npm/d@1"] };
    const result = mergeDependencies(a, single);
    assert.strictEqual(result.length, 2);
  });

  it("handles the provides field for OmniBOR / ADG links", () => {
    const a = [
      {
        ref: "gitoid:commit:sha1:abc",
        dependsOn: [],
        provides: ["gitoid:commit:sha1:def"],
      },
    ];
    const b = [
      {
        ref: "gitoid:commit:sha1:def",
        provides: ["gitoid:blob:sha1:001", "gitoid:blob:sha1:002"],
      },
    ];
    const result = mergeDependencies(a, b);
    assert.ok(
      result.every((d) => Array.isArray(d.provides)),
      "all entries should have provides",
    );
    const defEntry = result.find((d) => d.ref === "gitoid:commit:sha1:def");
    assert.ok(defEntry);
    assert.ok(defEntry.provides.includes("gitoid:blob:sha1:001"));
    assert.ok(defEntry.provides.includes("gitoid:blob:sha1:002"));
  });

  it("excludes parent component from dependsOn", () => {
    const parentComponent = { "bom-ref": "pkg:npm/myapp@1.0.0" };
    const a = [
      {
        ref: "pkg:npm/a@1",
        dependsOn: ["pkg:npm/myapp@1.0.0", "pkg:npm/b@1"],
      },
    ];
    const result = mergeDependencies(a, [], parentComponent);
    const entry = result.find((d) => d.ref === "pkg:npm/a@1");
    assert.ok(
      !entry.dependsOn.includes("pkg:npm/myapp@1.0.0"),
      "parent should be excluded",
    );
    assert.ok(entry.dependsOn.includes("pkg:npm/b@1"));
  });

  it("merges parser-returned dependencies into BOM dependencies", () => {
    const bomDeps = [{ ref: "pkg:npm/app@1", dependsOn: ["pkg:npm/lib@2"] }];
    const parserDeps = [
      {
        ref: "workflow-bom-ref-1",
        dependsOn: ["task-bom-ref-1", "task-bom-ref-2"],
      },
      { ref: "task-bom-ref-1", dependsOn: ["pkg:github/actions/checkout@v4"] },
    ];
    const result = mergeDependencies(bomDeps, parserDeps);
    assert.strictEqual(result.length, 3);
    const wfEntry = result.find((d) => d.ref === "workflow-bom-ref-1");
    assert.ok(wfEntry);
    assert.ok(wfEntry.dependsOn.includes("task-bom-ref-1"));
    assert.ok(wfEntry.dependsOn.includes("task-bom-ref-2"));
  });
});
