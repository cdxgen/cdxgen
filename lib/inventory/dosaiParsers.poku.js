import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, it } from "poku";

import {
  addDosaiSetValue,
  buildDosaiPurlAliasMap,
  createDosaiEvidenceBudget,
  pickDosaiComponentByLocation,
  resolveDosaiComponentPurl,
} from "./dosaiParsers.js";

const srcPath = join(tmpdir(), "cdxgen-dosai-resolver");

function nugetComponent(name, version, projectDir) {
  return {
    name,
    version,
    purl: `pkg:nuget/${name}@${version}`,
    properties: [
      {
        name: "internal:SrcFile",
        value: join(srcPath, projectDir, "packages.lock.json"),
      },
    ],
  };
}

it("resolves a versionless dosai purl to the version of the nearest project", () => {
  const components = [
    nugetComponent("Moq", "4.18.4", "src/A"),
    nugetComponent("Moq", "4.20.69", "src/B"),
    // nested inside src/A: its files belong to it, not to src/A
    nugetComponent("Moq", "4.16.0", "src/A/Nested"),
    // two versions in one project: neither can be told from a location
    nugetComponent("Moq", "4.10.0", "src/C"),
    nugetComponent("Moq", "4.11.0", "src/C"),
  ];
  const aliasMap = buildDosaiPurlAliasMap(components, { srcPath });
  const resolveAt = (location) =>
    resolveDosaiComponentPurl("pkg:nuget/Moq", aliasMap, location);
  assert.strictEqual(resolveAt("src/A/Tests.cs#3"), "pkg:nuget/Moq@4.18.4");
  assert.strictEqual(resolveAt("src/B/x/y/Tests.cs"), "pkg:nuget/Moq@4.20.69");
  assert.strictEqual(
    resolveAt("src/A/Nested/Tests.cs#9"),
    "pkg:nuget/Moq@4.16.0",
  );
  assert.strictEqual(resolveAt("src/C/Tests.cs#1"), undefined);
  assert.strictEqual(resolveAt("Shared.cs#1"), undefined);
  // a sibling directory that only shares a prefix is not inside the project
  assert.strictEqual(resolveAt("src/AB/Tests.cs#1"), undefined);
  assert.strictEqual(resolveAt(undefined), undefined);
  // a version the BOM holds wins without a location, in any case
  assert.strictEqual(
    resolveDosaiComponentPurl("pkg:nuget/moq@4.20.69", aliasMap),
    "pkg:nuget/Moq@4.20.69",
  );
  assert.strictEqual(
    pickDosaiComponentByLocation(
      new Set(["pkg:nuget/Moq@4.18.4", "pkg:nuget/Moq@4.20.69"]),
      aliasMap,
      "src/B/Tests.cs#2",
    ),
    "pkg:nuget/Moq@4.20.69",
  );
});

it("resolves a versionless dosai purl without walking every version for every record", () => {
  // Many versions of one package, each restored by its own project, and many
  // records naming the package without a version
  const versions = 3000;
  const components = Array.from({ length: versions }, (_, i) =>
    nugetComponent("A", `1.0.${i}`, `p${i}`),
  );
  const aliasMap = buildDosaiPurlAliasMap(components, { srcPath });
  for (let i = 0; i < 30000; i++) {
    const project = i % versions;
    assert.strictEqual(
      resolveDosaiComponentPurl(
        "pkg:nuget/A",
        aliasMap,
        `p${project}/F.cs#${i}`,
      ),
      `pkg:nuget/A@1.0.${project}`,
    );
  }
});

it("keeps dosai evidence values within their length and the report's budget", () => {
  const map = {};
  addDosaiSetValue(map, "pkg:nuget/A@1.0.0", "a.cs#1");
  addDosaiSetValue(map, "pkg:nuget/A@1.0.0", "x".repeat(4097));
  assert.deepStrictEqual([...map["pkg:nuget/A@1.0.0"]], ["a.cs#1"]);
  // at least 4 Mi characters, or four times the report
  assert.strictEqual(createDosaiEvidenceBudget(0).remaining, 4 * 1024 * 1024);
  assert.strictEqual(
    createDosaiEvidenceBudget(10 * 1024 * 1024).remaining,
    40 * 1024 * 1024,
  );
  const budget = { remaining: 10, dropped: 0 };
  const budgeted = {};
  addDosaiSetValue(budgeted, "k1", "abcdef", budget);
  // a value already held costs nothing
  addDosaiSetValue(budgeted, "k1", "abcdef", budget);
  addDosaiSetValue(budgeted, "k2", "abcdef", budget);
  addDosaiSetValue(budgeted, "k2", "abcd", budget);
  assert.deepStrictEqual([...budgeted.k1], ["abcdef"]);
  assert.deepStrictEqual([...budgeted.k2], ["abcd"]);
  assert.strictEqual(budget.remaining, 0);
  assert.strictEqual(budget.dropped, 1);
});
