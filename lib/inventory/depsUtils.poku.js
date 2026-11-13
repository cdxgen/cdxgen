import { assert, describe, it } from "poku";

import {
  appendUnique,
  appendUniqueProperty,
  filterInvalidCryptoComponents,
  isPartialTree,
  markNpmTypesPackagesAsExcluded,
  markTypeOnlyDependenciesOptional,
  mergeDependencies,
  mergeServices,
  propagateRequiredScopeFromDependencies,
  recomputeScope,
  trimComponents,
} from "./depsUtils.js";

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

  it("filters out null and undefined entries from dependsOn", () => {
    const deps = [
      {
        ref: "pkg:composer/foo/bar",
        dependsOn: [null, undefined, "pkg:composer/vendor/lib@1.0"],
      },
    ];
    const result = mergeDependencies(deps, []);
    assert.strictEqual(result.length, 1);
    assert.deepStrictEqual(result[0].dependsOn, [
      "pkg:composer/vendor/lib@1.0",
    ]);
    assert.ok(!result[0].dependsOn.includes(null), "null must be filtered");
    assert.ok(
      !result[0].dependsOn.includes(undefined),
      "undefined must be filtered",
    );
  });

  it("filters out null and undefined from dependsOn even with a parentComponent", () => {
    const parent = { "bom-ref": "pkg:composer/foo/bar" };
    const deps = [
      {
        ref: "pkg:composer/foo/bar",
        dependsOn: [null, "pkg:composer/vendor/lib@1.0"],
      },
    ];
    const result = mergeDependencies(deps, [], parent);
    const entry = result.find((d) => d.ref === "pkg:composer/foo/bar");
    assert.ok(entry);
    assert.deepStrictEqual(entry.dependsOn, ["pkg:composer/vendor/lib@1.0"]);
    assert.ok(!entry.dependsOn.includes(null), "null must be filtered");
  });
});

describe("propagateRequiredScopeFromDependencies()", () => {
  it("marks transitive dependencies of required components as required", () => {
    const components = [
      {
        name: "app-lib",
        "bom-ref": "pkg:npm/app-lib@1.0.0",
        scope: "required",
      },
      {
        name: "runtime-a",
        "bom-ref": "pkg:npm/runtime-a@1.0.0",
        scope: "optional",
      },
      {
        name: "runtime-b",
        "bom-ref": "pkg:npm/runtime-b@1.0.0",
        scope: "optional",
      },
    ];
    const dependencies = [
      { ref: "pkg:npm/app-lib@1.0.0", dependsOn: ["pkg:npm/runtime-a@1.0.0"] },
      {
        ref: "pkg:npm/runtime-a@1.0.0",
        dependsOn: ["pkg:npm/runtime-b@1.0.0"],
      },
    ];

    propagateRequiredScopeFromDependencies(components, dependencies);

    assert.strictEqual(components[1].scope, "required");
    assert.strictEqual(components[2].scope, "required");
  });

  it("preserves known development, optional, and peer-only packages", () => {
    const components = [
      {
        name: "app-lib",
        "bom-ref": "pkg:npm/app-lib@1.0.0",
        scope: "required",
      },
      {
        name: "dev-tool",
        "bom-ref": "pkg:npm/dev-tool@1.0.0",
        scope: "optional",
        properties: [{ name: "cdx:npm:package:development", value: "true" }],
      },
      {
        name: "optional-runtime",
        "bom-ref": "pkg:npm/optional-runtime@1.0.0",
        scope: "optional",
        properties: [{ name: "cdx:npm:package:optional", value: "true" }],
      },
      {
        name: "peer-runtime",
        "bom-ref": "pkg:npm/peer-runtime@1.0.0",
        scope: "optional",
        properties: [{ name: "cdx:npm:package:peer", value: "true" }],
      },
    ];
    const dependencies = [
      {
        ref: "pkg:npm/app-lib@1.0.0",
        dependsOn: [
          "pkg:npm/dev-tool@1.0.0",
          "pkg:npm/optional-runtime@1.0.0",
          "pkg:npm/peer-runtime@1.0.0",
        ],
      },
    ];

    propagateRequiredScopeFromDependencies(components, dependencies);

    assert.strictEqual(components[1].scope, "optional");
    assert.strictEqual(components[2].scope, "optional");
    assert.strictEqual(components[3].scope, "optional");
  });

  it("handles decoded and encoded bom-ref variants", () => {
    const components = [
      {
        name: "scoped",
        "bom-ref": "pkg:npm/@scope/scoped@1.0.0",
        scope: "required",
      },
      { name: "child", purl: "pkg:npm/@scope/child@1.0.0", scope: "optional" },
    ];
    const dependencies = [
      {
        ref: "pkg:npm/%40scope/scoped@1.0.0",
        dependsOn: ["pkg:npm/%40scope/child@1.0.0"],
      },
    ];

    propagateRequiredScopeFromDependencies(components, dependencies);

    assert.strictEqual(components[1].scope, "required");
  });

  it("does not promote type-only scope components to required during propagation", () => {
    const components = [
      {
        name: "app-lib",
        "bom-ref": "pkg:npm/app-lib@1.0.0",
        scope: "required",
      },
      {
        name: "type-only-dep",
        "bom-ref": "pkg:npm/type-only-dep@1.0.0",
        scope: "excluded",
        properties: [{ name: "cdx:npm:package:type-only", value: "true" }],
      },
    ];
    const dependencies = [
      {
        ref: "pkg:npm/app-lib@1.0.0",
        dependsOn: ["pkg:npm/type-only-dep@1.0.0"],
      },
    ];

    propagateRequiredScopeFromDependencies(components, dependencies);

    assert.strictEqual(components[1].scope, "excluded");
  });
});

describe("markTypeOnlyDependenciesOptional()", () => {
  const typeOnly = [{ name: "cdx:npm:package:type-only", value: "true" }];
  const component = (name, extra = {}) => ({
    name,
    "bom-ref": `pkg:npm/${name}@1.0.0`,
    ...extra,
  });
  const edge = (ref, ...dependsOn) => ({
    ref: `pkg:npm/${ref}@1.0.0`,
    dependsOn: dependsOn.map((name) => `pkg:npm/${name}@1.0.0`),
  });
  const scopes = (components) =>
    Object.fromEntries(components.map((c) => [c.name, c.scope]));

  it("scopes what only a type-only package depends on as optional", () => {
    const components = [
      component("is-even", { scope: "required" }),
      component("is-odd", { scope: "excluded", properties: typeOnly }),
      component("is-number"),
      component("kind-of"),
    ];
    markTypeOnlyDependenciesOptional(components, [
      edge("app", "is-even", "is-odd"),
      edge("is-odd", "is-number"),
      edge("is-number", "kind-of"),
    ]);

    assert.deepStrictEqual(scopes(components), {
      "is-even": "required",
      "is-odd": "excluded",
      "is-number": "optional",
      "kind-of": "optional",
    });
  });

  it("leaves a dependency that a runtime package also depends on", () => {
    const components = [
      component("is-even"),
      component("is-odd", { scope: "excluded", properties: typeOnly }),
      component("is-number"),
    ];
    markTypeOnlyDependenciesOptional(components, [
      edge("app", "is-even", "is-odd"),
      edge("is-even", "is-number"),
      edge("is-odd", "is-number"),
    ]);

    assert.strictEqual(components[2].scope, undefined);
  });

  it("scopes a dependency shared by two type-only packages", () => {
    const components = [
      component("types-a", { scope: "excluded", properties: typeOnly }),
      component("types-b", { scope: "excluded", properties: typeOnly }),
      component("shared"),
    ];
    markTypeOnlyDependenciesOptional(components, [
      edge("app", "types-a", "types-b"),
      edge("types-a", "shared"),
      edge("types-b", "shared"),
    ]);

    assert.strictEqual(components[2].scope, "optional");
  });

  it("keeps a scope that the manifest or usage evidence assigned", () => {
    const components = [
      component("is-odd", { scope: "excluded", properties: typeOnly }),
      component("imported", { scope: "required" }),
      component("dev-tool", { scope: "optional" }),
    ];
    markTypeOnlyDependenciesOptional(components, [
      edge("app", "is-odd"),
      edge("is-odd", "imported", "dev-tool"),
    ]);

    assert.strictEqual(components[1].scope, "required");
    assert.strictEqual(components[2].scope, "optional");
  });

  it("treats @types packages as type-only", () => {
    const components = [
      {
        group: "@types",
        name: "react",
        "bom-ref": "pkg:npm/@types/react@19.0.0",
        scope: "excluded",
      },
      component("csstype"),
    ];
    markTypeOnlyDependenciesOptional(components, [
      {
        ref: "pkg:npm/%40types/react@19.0.0",
        dependsOn: ["pkg:npm/csstype@1.0.0"],
      },
    ]);

    assert.strictEqual(components[1].scope, "optional");
  });

  it("ignores excluded packages that are not type-only", () => {
    const components = [
      component("test-only", { scope: "excluded" }),
      component("helper"),
    ];
    markTypeOnlyDependenciesOptional(components, [edge("test-only", "helper")]);

    assert.strictEqual(components[1].scope, undefined);
  });

  it("scopes a cycle that only a type-only package reaches", () => {
    const components = [
      component("is-even", { scope: "required" }),
      component("is-odd", { scope: "excluded", properties: typeOnly }),
      component("a"),
      component("b"),
    ];
    markTypeOnlyDependenciesOptional(components, [
      edge("app", "is-even", "is-odd"),
      edge("is-odd", "a"),
      edge("a", "b"),
      edge("b", "a"),
    ]);

    assert.strictEqual(components[2].scope, "optional");
    assert.strictEqual(components[3].scope, "optional");
  });

  it("keeps a cycle that a runtime package also reaches", () => {
    const components = [
      component("is-even"),
      component("is-odd", { scope: "excluded", properties: typeOnly }),
      component("a"),
      component("b"),
    ];
    markTypeOnlyDependenciesOptional(components, [
      edge("app", "is-even", "is-odd"),
      edge("is-odd", "a"),
      edge("a", "b"),
      edge("b", "a"),
      edge("is-even", "b"),
    ]);

    assert.strictEqual(components[2].scope, undefined);
    assert.strictEqual(components[3].scope, undefined);
  });
});

describe("markNpmTypesPackagesAsExcluded()", () => {
  it("marks @types scoped components as excluded", () => {
    const components = [
      {
        group: "@types",
        name: "node",
        "bom-ref": "pkg:npm/@types/node@25.0.0",
        scope: "required",
      },
      {
        name: "react",
        "bom-ref": "pkg:npm/react@19.2.6",
        scope: "required",
      },
    ];

    markNpmTypesPackagesAsExcluded(components);

    assert.strictEqual(components[0].scope, "excluded");
    assert.strictEqual(components[1].scope, "required");
  });

  it("marks encoded npm @types purls as excluded", () => {
    const components = [
      {
        name: "react",
        purl: "pkg:npm/%40types/react@19.2.15",
        scope: "required",
      },
    ];

    markNpmTypesPackagesAsExcluded(components);

    assert.strictEqual(components[0].scope, "excluded");
  });
});

describe("trimComponents()", () => {
  it("retains hashes from duplicate components", () => {
    const components = [
      {
        name: "jquery",
        version: "3.5.1",
        purl: "pkg:npm/jquery@3.5.1",
        type: "library",
        properties: [
          { name: "internal:SrcFile", value: "Scripts/jquery.min.js" },
        ],
      },
      {
        name: "jquery",
        version: "3.5.1",
        purl: "pkg:npm/jquery@3.5.1",
        type: "framework",
        hashes: [{ alg: "SHA-512", content: "abc123" }],
        properties: [{ name: "internal:SrcFile", value: "package-lock.json" }],
      },
    ];
    const result = trimComponents(components);
    assert.strictEqual(result.length, 1);
    assert.deepStrictEqual(result[0].hashes, [
      { alg: "SHA-512", content: "abc123" },
    ]);
  });

  it("merges and deduplicates hashes from duplicate components", () => {
    const components = [
      {
        name: "jquery",
        version: "3.5.1",
        purl: "pkg:npm/jquery@3.5.1",
        type: "library",
        hashes: [{ alg: "SHA-512", content: "abc123" }],
        properties: [
          { name: "internal:SrcFile", value: "Scripts/jquery.min.js" },
        ],
      },
      {
        name: "jquery",
        version: "3.5.1",
        purl: "pkg:npm/jquery@3.5.1",
        type: "framework",
        hashes: [
          { alg: "SHA-512", content: "abc123" },
          { alg: "SHA-256", content: "def456" },
        ],
        properties: [{ name: "internal:SrcFile", value: "package-lock.json" }],
      },
    ];
    const result = trimComponents(components);
    assert.strictEqual(result.length, 1);
    assert.deepStrictEqual(result[0].hashes, [
      { alg: "SHA-512", content: "abc123" },
      { alg: "SHA-256", content: "def456" },
    ]);
  });

  it("retains identity tool references when merging duplicate components", () => {
    const components = [
      {
        name: "openssl",
        version: "3.0.0",
        purl: "pkg:rpm/redhat/openssl@3.0.0",
        type: "library",
        evidence: {
          identity: [
            {
              field: "purl",
              confidence: 1,
              methods: [
                {
                  technique: "binary-analysis",
                  confidence: 1,
                  value: "openssl",
                },
              ],
              tools: ["pkg:generic/trivy@0.1.0"],
            },
          ],
        },
      },
      {
        name: "openssl",
        version: "3.0.0",
        purl: "pkg:rpm/redhat/openssl@3.0.0",
        type: "library",
        evidence: {
          identity: [
            {
              field: "purl",
              confidence: 1,
              methods: [
                {
                  technique: "binary-analysis",
                  confidence: 1,
                  value: "openssl",
                },
              ],
              tools: ["pkg:generic/blint@1.2.3"],
            },
          ],
        },
      },
    ];
    const result = trimComponents(components);
    assert.strictEqual(result.length, 1);
    assert.deepStrictEqual(result[0].evidence.identity[0].tools, [
      "pkg:generic/trivy@0.1.0",
      "pkg:generic/blint@1.2.3",
    ]);
  });

  it("retains descriptive metadata when a manifest sighting follows a lockfile sighting (discussion 4389)", () => {
    // The lockfile is parsed first and knows only the identity, while the
    // gemspec sighting carries the description, authors, licenses, and
    // external references that must survive the merge.
    const components = [
      {
        name: "opentelemetry-instrumentation-action_mailer",
        version: "0.8.1",
        purl: "pkg:gem/opentelemetry-instrumentation-action_mailer@0.8.1",
        type: "library",
        description: "",
        hashes: [{ alg: "SHA-256", content: "abc123" }],
        properties: [{ name: "internal:SrcFile", value: "Gemfile.lock" }],
      },
      {
        name: "opentelemetry-instrumentation-action_mailer",
        version: "0.8.1",
        purl: "pkg:gem/opentelemetry-instrumentation-action_mailer@0.8.1",
        type: "framework",
        description:
          "ActionMailer instrumentation for the OpenTelemetry framework",
        authors: [{ name: "OpenTelemetry Authors" }],
        licenses: [{ license: { name: "Apache-2.0" } }],
        externalReferences: [
          {
            type: "issue-tracker",
            url: "https://github.com/open-telemetry/opentelemetry-ruby-contrib/issues",
            comment: "bug_tracker_uri",
          },
        ],
        properties: [
          {
            name: "internal:SrcFile",
            value: "opentelemetry-instrumentation-action_mailer.gemspec",
          },
        ],
      },
    ];
    const result = trimComponents(components);
    assert.strictEqual(result.length, 1);
    assert.deepStrictEqual(
      result[0].description,
      "ActionMailer instrumentation for the OpenTelemetry framework",
    );
    assert.deepStrictEqual(result[0].authors, [
      { name: "OpenTelemetry Authors" },
    ]);
    assert.deepStrictEqual(result[0].licenses, [
      { license: { name: "Apache-2.0" } },
    ]);
    assert.deepStrictEqual(result[0].externalReferences, [
      {
        type: "issue-tracker",
        url: "https://github.com/open-telemetry/opentelemetry-ruby-contrib/issues",
        comment: "bug_tracker_uri",
      },
    ]);
    // The lockfile sighting's checksums are still retained
    assert.deepStrictEqual(result[0].hashes, [
      { alg: "SHA-256", content: "abc123" },
    ]);
  });

  it("keeps the retained sighting's own descriptive values and unions its links", () => {
    const components = [
      {
        name: "loofah",
        version: "2.3.1",
        purl: "pkg:gem/loofah@2.3.1",
        type: "library",
        authors: [{ name: "Mike Dalessio" }],
        licenses: [{ expression: "MIT OR Apache-2.0" }],
        externalReferences: [
          { type: "website", url: "https://github.com/flavorjones/loofah" },
        ],
      },
      {
        name: "loofah",
        version: "2.3.1",
        purl: "pkg:gem/loofah@2.3.1",
        type: "library",
        authors: [
          { name: "Mike Dalessio", email: "mike@example.com" },
          { name: "Bryan Helmkamp" },
        ],
        licenses: [{ license: { id: "MIT" } }],
        externalReferences: [
          {
            type: "website",
            url: "https://github.com/flavorjones/loofah",
            comment: "homepage_uri",
          },
          {
            type: "issue-tracker",
            url: "https://github.com/flavorjones/loofah/issues",
          },
        ],
      },
    ];
    const result = trimComponents(components);
    assert.strictEqual(result.length, 1);
    // Unioning would list Mike Dalessio twice, and put a license object next
    // to an expression, which the CycloneDX licenseChoice schema rejects
    assert.deepStrictEqual(result[0].authors, [{ name: "Mike Dalessio" }]);
    assert.deepStrictEqual(result[0].licenses, [
      { expression: "MIT OR Apache-2.0" },
    ]);
    // The same link is not repeated for a differing comment
    assert.deepStrictEqual(result[0].externalReferences, [
      { type: "website", url: "https://github.com/flavorjones/loofah" },
      {
        type: "issue-tracker",
        url: "https://github.com/flavorjones/loofah/issues",
      },
    ]);
  });

  it("does not add a converted field next to its raw spelling", () => {
    // Conversion prefers `licenses` over a raw `license` and a raw `author`
    // over `authors`, so filling either would replace the retained value
    const result = trimComponents([
      { purl: "pkg:npm/left-pad@1.3.0", license: "WTFPL", author: "azer" },
      {
        purl: "pkg:npm/left-pad@1.3.0",
        licenses: [{ license: { id: "MIT" } }],
        authors: [{ name: "someone else" }],
        description: "String left pad",
      },
    ]);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].license, "WTFPL");
    assert.strictEqual(result[0].licenses, undefined);
    assert.strictEqual(result[0].author, "azer");
    assert.strictEqual(result[0].authors, undefined);
    assert.strictEqual(result[0].description, "String left pad");
  });

  it("carries a raw spelling over when the retained sighting has none", () => {
    const result = trimComponents([
      { purl: "pkg:npm/left-pad@1.3.0" },
      { purl: "pkg:npm/left-pad@1.3.0", license: "WTFPL", author: "azer" },
    ]);
    assert.strictEqual(result[0].license, "WTFPL");
    assert.strictEqual(result[0].author, "azer");
    assert.strictEqual(result[0].licenses, undefined);
    assert.strictEqual(result[0].authors, undefined);
  });

  it("does not write to Object.prototype for a component keyed __proto__", () => {
    const result = trimComponents([
      { purl: "__proto__", description: "polluted" },
      {
        purl: "__proto__",
        properties: [{ name: "internal:SrcFile", value: "x" }],
      },
    ]);
    assert.strictEqual({}.description, undefined);
    assert.strictEqual({}.properties, undefined);
    // Both sightings still merge into one component like any other key
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].description, "polluted");
    assert.deepStrictEqual(result[0].properties, [
      { name: "internal:SrcFile", value: "x" },
    ]);
  });

  it("does not modify an external reference list shared with another sighting", () => {
    const shared = [{ type: "website", url: "https://example.com" }];
    const other = { purl: "pkg:gem/a@1", externalReferences: shared };
    trimComponents([
      other,
      {
        purl: "pkg:gem/a@1",
        externalReferences: [{ type: "vcs", url: "https://example.com/a.git" }],
      },
    ]);
    assert.deepStrictEqual(shared, [
      { type: "website", url: "https://example.com" },
    ]);
    assert.strictEqual(other.externalReferences.length, 2);
  });
});

describe("appendUnique()", () => {
  it("appends only entries whose key is new, including after outside appends", () => {
    const keyOf = (entry) => entry.id;
    const list = [{ id: "a" }];
    assert.strictEqual(appendUnique(list, keyOf, { id: "a" }), false);
    assert.strictEqual(appendUnique(list, keyOf, { id: "b" }), true);
    list.push({ id: "c" });
    assert.strictEqual(appendUnique(list, keyOf, { id: "c" }), false);
    assert.strictEqual(appendUnique(list, keyOf, { id: "d" }), true);
    assert.deepStrictEqual(
      list.map((entry) => entry.id),
      ["a", "b", "c", "d"],
    );
  });

  it("stays linear on a long list", () => {
    const keyOf = (entry) => entry.id;
    const list = [];
    const start = performance.now();
    for (let i = 0; i < 100000; i++) {
      appendUnique(list, keyOf, { id: `k${i % 50000}` });
    }
    assert.ok(performance.now() - start < 5000, "finishes quickly");
    assert.strictEqual(list.length, 50000);
  });
});

describe("appendUniqueProperty()", () => {
  it("appends new name and value pairs as strings and skips empty values", () => {
    const properties = [{ name: "cdx:a", value: "1" }];
    appendUniqueProperty(properties, "cdx:a", 1);
    appendUniqueProperty(properties, "cdx:a", 2);
    appendUniqueProperty(properties, "cdx:b", "");
    appendUniqueProperty(properties, "cdx:b", undefined);
    assert.deepStrictEqual(properties, [
      { name: "cdx:a", value: "1" },
      { name: "cdx:a", value: "2" },
    ]);
  });

  it("does not scan the list on every append", () => {
    // The properties already in the list count the reads of their name.
    // Scanning the list per append read every one of them for each of the
    // 1,000 appends below: about 1,000,000 reads.
    let nameReads = 0;
    const properties = [];
    for (let i = 0; i < 1000; i++) {
      properties.push({
        get name() {
          nameReads++;
          return "cdx:x";
        },
        value: `old${i}`,
      });
    }
    for (let i = 0; i < 1000; i++) {
      appendUniqueProperty(properties, "cdx:x", `new${i}`);
    }
    assert.ok(nameReads < 10 * 1000, `${nameReads} property name reads`);
    assert.strictEqual(properties.length, 2000);
  });
});

describe("mergeServices()", () => {
  it("reads each property of many duplicates a bounded number of times", () => {
    // Every property counts the reads of its name. Rebuilding the merged
    // lists per duplicate read all earlier properties again for each one:
    // about 2,000,000 reads for these 2,000 duplicates.
    let nameReads = 0;
    const countedProperty = (value) => ({
      get name() {
        nameReads++;
        return "cdx:p";
      },
      value,
    });
    const duplicates = [];
    for (let i = 0; i < 2000; i++) {
      duplicates.push({
        name: "api",
        endpoints: [`/e${i}`],
        properties: [countedProperty(`v${i}`)],
        tags: [`t${i}`],
        data: [{ flow: "inbound", classification: `c${i}` }],
        evidence: {
          occurrences: [{ location: { path: "a.js", line: i } }],
        },
        services: [{ name: `child${i % 10}` }],
      });
    }
    const [merged] = mergeServices([], duplicates);
    assert.ok(nameReads < 10 * 2000, `${nameReads} property name reads`);
    assert.strictEqual(merged.endpoints.length, 2000);
    assert.strictEqual(merged.properties.length, 2000);
    assert.strictEqual(merged.tags.length, 2000);
    assert.strictEqual(merged.data.length, 2000);
    assert.strictEqual(merged.evidence.occurrences.length, 2000);
    assert.strictEqual(merged.services.length, 10);
    assert.deepStrictEqual(duplicates[0].endpoints, ["/e0"]);
    assert.strictEqual(duplicates[0].evidence.occurrences.length, 1);
  });

  it("merges matching services and deduplicates endpoints and properties", () => {
    const result = mergeServices(
      [
        {
          "bom-ref": "urn:service:mcp:demo:1.0.0",
          name: "demo",
          version: "1.0.0",
          endpoints: ["/mcp"],
          authenticated: false,
          properties: [{ name: "cdx:mcp:transport", value: "streamable-http" }],
        },
      ],
      [
        {
          "bom-ref": "urn:service:mcp:demo:1.0.0",
          name: "demo",
          version: "1.0.0",
          endpoints: ["/mcp", "/.well-known/oauth-authorization-server"],
          authenticated: true,
          "x-trust-boundary": true,
          properties: [
            { name: "cdx:mcp:transport", value: "streamable-http" },
            { name: "cdx:mcp:capabilities:tools", value: "true" },
          ],
        },
      ],
    );
    assert.strictEqual(result.length, 1);
    assert.deepStrictEqual(result[0].endpoints, [
      "/mcp",
      "/.well-known/oauth-authorization-server",
    ]);
    assert.strictEqual(result[0].authenticated, true);
    assert.strictEqual(result[0]["x-trust-boundary"], true);
    assert.strictEqual(result[0].properties.length, 2);
  });

  it("merges a service with many properties in linear time", () => {
    // An init script of the scanned image decides how many properties its
    // service carries.
    const properties = [];
    for (let i = 0; i < 40000; i++) {
      properties.push({ name: "cdx:service:Required-Start", value: `s${i}` });
    }
    const service = {
      "bom-ref": "urn:service:sysvinit:demo:svc",
      name: "svc",
      properties,
    };
    const start = performance.now();
    const result = mergeServices([service], [{ ...service }]);
    assert.ok(performance.now() - start < 5000, "finishes quickly");
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].properties.length, 40000);
    assert.deepStrictEqual(
      mergeServices(
        [
          {
            "bom-ref": "urn:service:a",
            properties: [
              { name: "x", value: "1" },
              { name: "x", value: "1" },
            ],
          },
        ],
        [
          {
            "bom-ref": "urn:service:a",
            properties: [
              { name: "x", value: "2" },
              { name: "x", value: "1" },
            ],
          },
        ],
      )[0].properties,
      [
        { name: "x", value: "1" },
        { name: "x", value: "2" },
      ],
    );
  });

  it("retains distinct services", () => {
    const result = mergeServices(
      [{ "bom-ref": "urn:service:mcp:stdio:1.0.0", name: "stdio" }],
      [{ "bom-ref": "urn:service:mcp:http:1.0.0", name: "http" }],
    );
    assert.strictEqual(result.length, 2);
  });

  it("normalizes string endpoints when merging matching services", () => {
    const result = mergeServices(
      [
        {
          "bom-ref": "urn:service:mcp:demo:1.0.0",
          endpoints: "/mcp",
          name: "demo",
        },
      ],
      [
        {
          "bom-ref": "urn:service:mcp:demo:1.0.0",
          endpoints: ["/mcp", "/health"],
          name: "demo",
        },
      ],
    );
    assert.deepStrictEqual(result[0].endpoints, ["/mcp", "/health"]);
  });

  it("unions evidence occurrences instead of keeping whichever side arrived first", () => {
    const result = mergeServices(
      [
        {
          name: "CounterService",
          group: "Server.examples",
          evidence: {
            occurrences: [
              { location: { path: "Server/CounterService.cs", line: 14 } },
            ],
          },
        },
      ],
      [
        {
          name: "CounterService",
          group: "Server.examples",
          evidence: {
            occurrences: [
              { location: { path: "Server/CounterService.cs", line: 14 } },
              { location: { path: "Server/CounterGrpc.cs", line: 31 } },
            ],
          },
        },
      ],
    );

    assert.strictEqual(result.length, 1);
    assert.deepStrictEqual(
      result[0].evidence.occurrences.map((occurrence) => [
        occurrence.location.path,
        occurrence.location.line,
      ]),
      [
        ["Server/CounterService.cs", 14],
        ["Server/CounterGrpc.cs", 31],
      ],
    );
  });
});

describe("filterInvalidCryptoComponents()", () => {
  it("removes algorithm components without OID", () => {
    const components = [
      {
        name: "sha-256",
        type: "cryptographic-asset",
        cryptoProperties: {
          assetType: "algorithm",
          oid: "2.16.840.1.101.3.4.2.1",
        },
      },
      {
        name: "unknown-algo",
        type: "cryptographic-asset",
        cryptoProperties: { assetType: "algorithm" },
      },
      { name: "express", type: "library", purl: "pkg:npm/express@4.18.0" },
    ];
    const result = filterInvalidCryptoComponents(components);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].name, "sha-256");
    assert.strictEqual(result[1].name, "express");
  });

  it("removes crypto components without cryptoProperties", () => {
    const components = [
      { name: "bad-cert", type: "cryptographic-asset" },
      {
        name: "good-cert",
        type: "cryptographic-asset",
        cryptoProperties: {
          assetType: "certificate",
          algorithmProperties: {
            executionEnvironment: "unknown",
            implementationPlatform: "unknown",
          },
        },
      },
    ];
    const result = filterInvalidCryptoComponents(components);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, "good-cert");
  });

  it("removes certificate components without algorithmProperties", () => {
    const components = [
      {
        name: "bad-cert",
        type: "cryptographic-asset",
        cryptoProperties: { assetType: "certificate" },
      },
    ];
    const result = filterInvalidCryptoComponents(components);
    assert.strictEqual(result.length, 0);
  });

  it("preserves related-crypto-material components", () => {
    const components = [
      {
        name: "gpg-key",
        type: "cryptographic-asset",
        cryptoProperties: {
          assetType: "related-crypto-material",
          relatedCryptoMaterialProperties: {
            type: "public-key",
            id: "abc",
            state: "active",
          },
        },
      },
    ];
    const result = filterInvalidCryptoComponents(components);
    assert.strictEqual(result.length, 1);
  });

  it("returns an empty array for empty/falsy input", () => {
    assert.strictEqual(filterInvalidCryptoComponents([]).length, 0);
    assert.deepStrictEqual(filterInvalidCryptoComponents(undefined), []);
    assert.deepStrictEqual(filterInvalidCryptoComponents(null), []);
  });
});

describe("isPartialTree()", () => {
  it("treats a missing dependsOn as empty instead of throwing", () => {
    // Protobuf legitimately omits empty repeated fields, so round-tripped
    // BOMs carry dependency entries without a dependsOn key.
    const dependencies = [
      { ref: "root", dependsOn: ["pkg:npm/a@1"] },
      { ref: "pkg:npm/a@1" },
      { ref: "pkg:npm/b@1" },
    ];
    assert.strictEqual(isPartialTree(dependencies, 3), false);
  });

  it("flags a tree where most entries lack children as partial", () => {
    const dependencies = [
      { ref: "root", dependsOn: ["pkg:npm/a@1"] },
      { ref: "pkg:npm/a@1" },
      { ref: "pkg:npm/b@1" },
      { ref: "pkg:npm/c@1" },
      { ref: "pkg:npm/d@1" },
      { ref: "pkg:npm/e@1" },
    ];
    assert.strictEqual(isPartialTree(dependencies, 6), true);
  });
});

describe("recomputeScope()", () => {
  it("treats a missing dependsOn as empty instead of throwing", () => {
    const pkgList = [
      { "bom-ref": "pkg:npm/a@1", scope: "required" },
      { "bom-ref": "pkg:npm/b@1" },
    ];
    const result = recomputeScope(pkgList, [{ ref: "pkg:npm/a@1" }]);
    assert.strictEqual(result[0].scope, "required");
    assert.strictEqual(result[1].scope, "optional");
  });
});

it("mergeDependencies() keeps refs named after Object.prototype members", () => {
  const merged = mergeDependencies(
    [
      { ref: "constructor", dependsOn: ["toString"] },
      { ref: "__proto__", dependsOn: ["valueOf"] },
    ],
    [{ ref: "toString", dependsOn: [] }],
  );
  const byRef = Object.fromEntries(merged.map((d) => [d.ref, d.dependsOn]));
  assert.deepStrictEqual(Object.keys(byRef).sort(), [
    "__proto__",
    "constructor",
    "toString",
  ]);
  assert.deepStrictEqual(byRef.constructor, ["toString"]);
  assert.strictEqual({}.valueOf, Object.prototype.valueOf);
});
