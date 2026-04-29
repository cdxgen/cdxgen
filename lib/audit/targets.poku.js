import esmock from "esmock";
import { assert, describe, it } from "poku";

import {
  collectAuditTargets,
  extractPurlTargetsFromBom,
  isRequiredComponentScope,
  normalizePackageName,
} from "./targets.js";

function makeBom(components, extra = {}) {
  return {
    bomFormat: "CycloneDX",
    components,
    specVersion: "1.6",
    ...extra,
  };
}

describe("normalizePackageName()", () => {
  it("normalizes Python-style package separators", () => {
    assert.strictEqual(
      normalizePackageName("My_Package.Name"),
      "my-package-name",
    );
  });
});

describe("extractPurlTargetsFromBom()", () => {
  it("extracts supported npm, pypi, and cargo purls", () => {
    const bom = makeBom([
      {
        "bom-ref": "pkg:npm/left-pad@1.3.0",
        name: "left-pad",
        properties: [
          { name: "cdx:npm:trustedPublishing", value: "true" },
          { name: "cdx:npm:provenanceKeyId", value: "sigstore-key" },
        ],
        purl: "pkg:npm/left-pad@1.3.0",
      },
      {
        "bom-ref": "pkg:pypi/requests@2.32.3",
        name: "requests",
        purl: "pkg:pypi/requests@2.32.3",
      },
      {
        "bom-ref": "pkg:cargo/serde@1.0.217",
        name: "serde",
        properties: [{ name: "cdx:cargo:dependencyKind", value: "dev" }],
        purl: "pkg:cargo/serde@1.0.217",
      },
      {
        "bom-ref": "pkg:gem/rails@8.0.0",
        name: "rails",
        purl: "pkg:gem/rails@8.0.0",
      },
    ]);

    const extracted = extractPurlTargetsFromBom(bom, "bom.json");

    assert.strictEqual(extracted.targets.length, 3);
    assert.strictEqual(extracted.skipped.length, 1);
    assert.strictEqual(extracted.targets[0].type, "npm");
    assert.strictEqual(
      extracted.targets[0].properties[0].name,
      "cdx:npm:trustedPublishing",
    );
    assert.strictEqual(
      extracted.targets[0].properties[1].name,
      "cdx:npm:provenanceKeyId",
    );
    assert.strictEqual(extracted.targets[1].type, "pypi");
    assert.strictEqual(extracted.targets[2].type, "cargo");
    assert.strictEqual(extracted.targets[2].developmentOnly, true);
    assert.strictEqual(extracted.skipped[0].reason, "unsupported-ecosystem");
  });

  it("records invalid purls as skipped entries", () => {
    const bom = makeBom([
      {
        "bom-ref": "bad-ref",
        name: "broken",
        purl: "not-a-purl",
      },
    ]);

    const extracted = extractPurlTargetsFromBom(bom, "broken.json");

    assert.strictEqual(extracted.targets.length, 0);
    assert.strictEqual(extracted.skipped.length, 1);
    assert.strictEqual(extracted.skipped[0].reason, "invalid-purl");
  });
});

describe("isRequiredComponentScope()", () => {
  it("treats missing scope as required and excludes optional/excluded scopes", () => {
    assert.strictEqual(isRequiredComponentScope(undefined), true);
    assert.strictEqual(isRequiredComponentScope("required"), true);
    assert.strictEqual(isRequiredComponentScope("optional"), false);
    assert.strictEqual(isRequiredComponentScope("excluded"), false);
  });
});

describe("collectAuditTargets()", () => {
  it("deduplicates targets across multiple BOMs while preserving sources", () => {
    const inputBoms = [
      {
        bomJson: makeBom([
          {
            "bom-ref": "pkg:npm/left-pad@1.3.0",
            name: "left-pad",
            properties: [{ name: "cdx:npm:trustedPublishing", value: "true" }],
            purl: "pkg:npm/left-pad@1.3.0",
          },
        ]),
        source: "one.json",
      },
      {
        bomJson: makeBom([
          {
            "bom-ref": "pkg:npm/left-pad@1.3.0",
            name: "left-pad",
            properties: [{ name: "cdx:npm:publisher", value: "octo" }],
            purl: "pkg:npm/left-pad@1.3.0",
          },
          {
            "bom-ref": "pkg:pypi/requests@2.32.3",
            name: "requests",
            purl: "pkg:pypi/requests@2.32.3",
          },
        ]),
        source: "two.json",
      },
    ];

    const collected = collectAuditTargets(inputBoms, { trusted: "include" });

    assert.strictEqual(collected.targets.length, 2);
    const npmTarget = collected.targets.find((target) => target.type === "npm");
    assert.deepStrictEqual(npmTarget.sources, ["one.json", "two.json"]);
    assert.strictEqual(npmTarget.bomRefs.length, 1);
    assert.strictEqual(npmTarget.properties.length, 2);
  });

  it("recognizes Cargo trusted-publishing and target-specific metadata", () => {
    const inputBoms = [
      {
        bomJson: makeBom([
          {
            "bom-ref": "pkg:cargo/ring@0.17.8",
            name: "ring",
            properties: [
              { name: "cdx:cargo:target", value: 'cfg(target_os = "linux")' },
              { name: "cdx:cargo:trustedPublishing", value: "true" },
            ],
            purl: "pkg:cargo/ring@0.17.8",
          },
          {
            "bom-ref": "pkg:cargo/serde@1.0.217",
            name: "serde",
            purl: "pkg:cargo/serde@1.0.217",
          },
        ]),
        source: "cargo-trusted.json",
      },
    ];

    const collected = collectAuditTargets(inputBoms, { trusted: "include" });

    assert.deepStrictEqual(
      collected.targets.map((target) => target.purl),
      ["pkg:cargo/serde@1.0.217", "pkg:cargo/ring@0.17.8"],
    );
    assert.strictEqual(collected.stats.trustedTargets, 1);
    assert.strictEqual(collected.stats.platformSpecificTargets, 1);
  });

  it("prioritizes runtime-facing Cargo crates ahead of build-only workspace crates", () => {
    const inputBoms = [
      {
        bomJson: makeBom(
          [
            {
              "bom-ref": "pkg:cargo/root@1.0.0",
              name: "root",
              purl: "pkg:cargo/root@1.0.0",
            },
            {
              "bom-ref": "pkg:cargo/runtime-helper@1.0.0",
              name: "runtime-helper",
              properties: [
                { name: "cdx:cargo:dependencyKind", value: "runtime" },
                {
                  name: "cdx:cargo:workspaceDependencyResolved",
                  value: "true",
                },
              ],
              purl: "pkg:cargo/runtime-helper@1.0.0",
            },
            {
              "bom-ref": "pkg:cargo/build-helper@1.0.0",
              name: "build-helper",
              properties: [
                { name: "cdx:cargo:dependencyKind", value: "build" },
                {
                  name: "cdx:cargo:workspaceDependencyResolved",
                  value: "true",
                },
              ],
              purl: "pkg:cargo/build-helper@1.0.0",
            },
          ],
          {
            dependencies: [
              {
                ref: "pkg:cargo/root@1.0.0",
                dependsOn: [
                  "pkg:cargo/runtime-helper@1.0.0",
                  "pkg:cargo/build-helper@1.0.0",
                ],
              },
            ],
            metadata: {
              component: {
                "bom-ref": "pkg:cargo/root@1.0.0",
              },
            },
          },
        ),
        source: "cargo-priority.json",
      },
    ];

    const collected = collectAuditTargets(inputBoms, {
      maxTargets: 2,
      trusted: "include",
    });

    assert.deepStrictEqual(
      collected.targets.map((target) => target.purl),
      ["pkg:cargo/runtime-helper@1.0.0", "pkg:cargo/build-helper@1.0.0"],
    );
    assert.strictEqual(collected.targets[0].runtimeFacingCargo, true);
    assert.strictEqual(collected.targets[1].buildOnlyWorkspace, true);
    assert.strictEqual(collected.stats.buildOnlyWorkspaceTargets, 1);
    assert.strictEqual(collected.stats.cargoRuntimeFacingTargets, 1);
  });

  it("respects maxTargets when supplied", () => {
    const inputBoms = [
      {
        bomJson: makeBom([
          {
            "bom-ref": "pkg:npm/a@1.0.0",
            name: "a",
            purl: "pkg:npm/a@1.0.0",
          },
          {
            "bom-ref": "pkg:npm/b@1.0.0",
            name: "b",
            purl: "pkg:npm/b@1.0.0",
          },
        ]),
        source: "limit.json",
      },
    ];

    const collected = collectAuditTargets(inputBoms, 1);

    assert.strictEqual(collected.targets.length, 1);
  });

  it("filters predictive audit targets to required scope when requested", () => {
    const inputBoms = [
      {
        bomJson: makeBom([
          {
            "bom-ref": "pkg:npm/core@1.0.0",
            name: "core",
            purl: "pkg:npm/core@1.0.0",
            scope: "required",
          },
          {
            "bom-ref": "pkg:npm/transitive@1.0.0",
            name: "transitive",
            purl: "pkg:npm/transitive@1.0.0",
          },
          {
            "bom-ref": "pkg:npm/optional-addon@1.0.0",
            name: "optional-addon",
            purl: "pkg:npm/optional-addon@1.0.0",
            scope: "optional",
          },
          {
            "bom-ref": "pkg:pypi/unused@1.0.0",
            name: "unused",
            purl: "pkg:pypi/unused@1.0.0",
            scope: "excluded",
          },
        ]),
        source: "required.json",
      },
    ];

    const collected = collectAuditTargets(inputBoms, { scope: "required" });

    assert.deepStrictEqual(
      collected.targets.map((target) => target.purl),
      ["pkg:npm/core@1.0.0", "pkg:npm/transitive@1.0.0"],
    );
    assert.strictEqual(collected.stats.requiredTargets, 2);
    assert.strictEqual(collected.stats.nonRequiredTargets, 0);
  });

  it("prioritizes required targets before optional ones when maxTargets is set", () => {
    const inputBoms = [
      {
        bomJson: makeBom([
          {
            "bom-ref": "pkg:npm/a-optional@1.0.0",
            name: "a-optional",
            purl: "pkg:npm/a-optional@1.0.0",
            scope: "optional",
          },
          {
            "bom-ref": "pkg:npm/z-required@1.0.0",
            name: "z-required",
            purl: "pkg:npm/z-required@1.0.0",
            scope: "required",
          },
        ]),
        source: "priority.json",
      },
    ];

    const collected = collectAuditTargets(inputBoms, { maxTargets: 1 });

    assert.strictEqual(collected.targets.length, 1);
    assert.strictEqual(collected.targets[0].purl, "pkg:npm/z-required@1.0.0");
    assert.strictEqual(collected.stats.truncatedTargets, 1);
  });

  it("can prioritize direct runtime dependencies ahead of transitive platform-specific packages", () => {
    const inputBoms = [
      {
        bomJson: makeBom(
          [
            {
              "bom-ref": "pkg:npm/direct-runtime@1.0.0",
              name: "direct-runtime",
              purl: "pkg:npm/direct-runtime@1.0.0",
              scope: "required",
            },
            {
              "bom-ref": "pkg:npm/transitive-platform@1.0.0",
              name: "transitive-platform",
              properties: [{ name: "cdx:npm:os", value: "darwin" }],
              purl: "pkg:npm/transitive-platform@1.0.0",
            },
          ],
          {
            dependencies: [
              {
                dependsOn: ["pkg:npm/direct-runtime@1.0.0"],
                ref: "pkg:application/root-app@1.0.0",
              },
            ],
            metadata: {
              component: {
                "bom-ref": "pkg:application/root-app@1.0.0",
                name: "root-app",
                type: "application",
              },
            },
          },
        ),
        source: "priority-runtime.json",
      },
    ];

    const collected = collectAuditTargets(inputBoms, {
      maxTargets: 1,
      prioritizeDirectRuntime: true,
      trusted: "include",
    });

    assert.strictEqual(collected.targets.length, 1);
    assert.strictEqual(
      collected.targets[0].purl,
      "pkg:npm/direct-runtime@1.0.0",
    );
    assert.strictEqual(collected.targets[0].directDependency, true);
    assert.strictEqual(collected.stats.directRuntimeTargets, 1);
    assert.strictEqual(collected.stats.platformSpecificTargets, 1);
  });

  it("prioritizes direct runtime dependencies by default", () => {
    const inputBoms = [
      {
        bomJson: makeBom(
          [
            {
              "bom-ref": "pkg:npm/direct-runtime@1.0.0",
              name: "direct-runtime",
              purl: "pkg:npm/direct-runtime@1.0.0",
              scope: "required",
            },
            {
              "bom-ref": "pkg:npm/transitive-platform@1.0.0",
              name: "transitive-platform",
              properties: [{ name: "cdx:npm:os", value: "darwin" }],
              purl: "pkg:npm/transitive-platform@1.0.0",
            },
          ],
          {
            dependencies: [
              {
                dependsOn: ["pkg:npm/direct-runtime@1.0.0"],
                ref: "pkg:application/root-app@1.0.0",
              },
            ],
            metadata: {
              component: {
                "bom-ref": "pkg:application/root-app@1.0.0",
                name: "root-app",
                type: "application",
              },
            },
          },
        ),
        source: "priority-runtime-default.json",
      },
    ];

    const collected = collectAuditTargets(inputBoms, {
      maxTargets: 1,
      trusted: "include",
    });

    assert.strictEqual(collected.targets.length, 1);
    assert.strictEqual(
      collected.targets[0].purl,
      "pkg:npm/direct-runtime@1.0.0",
    );
  });

  it("uses explicit required scope and evidence occurrences to improve prioritization", () => {
    const inputBoms = [
      {
        bomJson: makeBom([
          {
            "bom-ref": "pkg:npm/implicit-required@1.0.0",
            name: "implicit-required",
            purl: "pkg:npm/implicit-required@1.0.0",
          },
          {
            "bom-ref": "pkg:npm/evidence-backed@1.0.0",
            evidence: {
              occurrences: [
                { location: "src/a.js#1" },
                { location: "src/b.js#1" },
                { location: "src/c.js#1" },
              ],
            },
            name: "evidence-backed",
            purl: "pkg:npm/evidence-backed@1.0.0",
          },
          {
            "bom-ref": "pkg:npm/explicit-required@1.0.0",
            evidence: {
              occurrences: [{ location: "src/main.js#1" }],
            },
            name: "explicit-required",
            purl: "pkg:npm/explicit-required@1.0.0",
            scope: "required",
          },
        ]),
        source: "priority-evidence.json",
      },
    ];

    const collected = collectAuditTargets(inputBoms, {
      maxTargets: 3,
      trusted: "include",
    });

    assert.deepStrictEqual(
      collected.targets.map((target) => target.purl),
      [
        "pkg:npm/explicit-required@1.0.0",
        "pkg:npm/evidence-backed@1.0.0",
        "pkg:npm/implicit-required@1.0.0",
      ],
    );
    assert.strictEqual(collected.targets[0].explicitRequiredScope, true);
    assert.strictEqual(collected.targets[1].occurrenceCount, 3);
  });

  it("excludes trusted-publishing-backed targets by default", () => {
    const inputBoms = [
      {
        bomJson: makeBom([
          {
            "bom-ref": "pkg:npm/trusted@1.0.0",
            name: "trusted",
            properties: [
              {
                name: "cdx:npm:trustedPublishing",
                value: "true",
              },
            ],
            purl: "pkg:npm/trusted@1.0.0",
            scope: "required",
          },
          {
            "bom-ref": "pkg:npm/plain@1.0.0",
            name: "plain",
            purl: "pkg:npm/plain@1.0.0",
            scope: "required",
          },
        ]),
        source: "trusted.json",
      },
    ];

    const collected = collectAuditTargets(inputBoms);

    assert.deepStrictEqual(
      collected.targets.map((target) => target.purl),
      ["pkg:npm/plain@1.0.0"],
    );
    assert.strictEqual(collected.stats.trustedTargets, 1);
    assert.strictEqual(collected.stats.trustedTargetsExcluded, 1);
  });

  it("includes trusted-publishing-backed targets when explicitly requested", () => {
    const inputBoms = [
      {
        bomJson: makeBom([
          {
            "bom-ref": "pkg:npm/trusted@1.0.0",
            name: "trusted",
            properties: [
              {
                name: "cdx:npm:trustedPublishing",
                value: "true",
              },
            ],
            purl: "pkg:npm/trusted@1.0.0",
          },
          {
            "bom-ref": "pkg:pypi/plain@1.0.0",
            name: "plain",
            purl: "pkg:pypi/plain@1.0.0",
          },
        ]),
        source: "include-trusted.json",
      },
    ];

    const collected = collectAuditTargets(inputBoms, { trusted: "include" });

    assert.strictEqual(collected.targets.length, 2);
    assert.strictEqual(collected.stats.trustedTargetsExcluded, 0);
  });

  it("can restrict predictive audit targets to only trusted-publishing-backed packages", () => {
    const inputBoms = [
      {
        bomJson: makeBom([
          {
            "bom-ref": "pkg:npm/trusted@1.0.0",
            name: "trusted",
            properties: [
              {
                name: "cdx:npm:trustedPublishing",
                value: "true",
              },
            ],
            purl: "pkg:npm/trusted@1.0.0",
          },
          {
            "bom-ref": "pkg:npm/plain@1.0.0",
            name: "plain",
            purl: "pkg:npm/plain@1.0.0",
          },
        ]),
        source: "only-trusted.json",
      },
    ];

    const collected = collectAuditTargets(inputBoms, { trusted: "only" });

    assert.deepStrictEqual(
      collected.targets.map((target) => target.purl),
      ["pkg:npm/trusted@1.0.0"],
    );
    assert.strictEqual(collected.stats.availableTargets, 1);
    assert.strictEqual(collected.stats.trustedTargets, 1);
  });
});

describe("enrichInputBomsWithRegistryMetadata()", () => {
  it("adds registry trusted-publishing properties for npm targets so default selection can exclude them", async () => {
    const inputBoms = [
      {
        bomJson: makeBom([
          {
            "bom-ref": "pkg:npm/@sec-ant/readable-stream@0.4.1",
            name: "readable-stream",
            purl: "pkg:npm/%40sec-ant/readable-stream@0.4.1",
          },
          {
            "bom-ref": "pkg:npm/plain@1.0.0",
            name: "plain",
            purl: "pkg:npm/plain@1.0.0",
          },
        ]),
        source: "registry-enrichment.json",
      },
    ];
    const { enrichInputBomsWithRegistryMetadata: enrichWithMock } =
      await esmock("./targets.js", {
        "../helpers/utils.js": {
          getCratesMetadata: async (pkgList) => pkgList,
          getNpmMetadata: async (pkgList) =>
            pkgList.map((pkg) =>
              pkg.name === "readable-stream"
                ? {
                    ...pkg,
                    properties: [
                      ...(pkg.properties || []),
                      { name: "cdx:npm:trustedPublishing", value: "true" },
                      {
                        name: "cdx:npm:provenanceUrl",
                        value:
                          "https://registry.npmjs.org/-/npm/v1/attestations/readable-stream",
                      },
                    ],
                  }
                : pkg,
            ),
          getPyMetadata: async (pkgList) => pkgList,
        },
      });

    await enrichWithMock(inputBoms);

    const enrichedProperties = inputBoms[0].bomJson.components[0].properties;
    assert.ok(
      enrichedProperties.some(
        (property) => property.name === "cdx:npm:trustedPublishing",
      ),
    );
    const collected = collectAuditTargets(inputBoms);
    assert.deepStrictEqual(
      collected.targets.map((target) => target.purl),
      ["pkg:npm/plain@1.0.0"],
    );
  });

  it("adds registry trusted-publishing properties for pypi targets", async () => {
    const inputBoms = [
      {
        bomJson: makeBom([
          {
            "bom-ref": "pkg:pypi/example@1.0.0",
            name: "example",
            purl: "pkg:pypi/example@1.0.0",
          },
        ]),
        source: "pypi-enrichment.json",
      },
    ];
    const { enrichInputBomsWithRegistryMetadata: enrichWithMock } =
      await esmock("./targets.js", {
        "../helpers/utils.js": {
          getCratesMetadata: async (pkgList) => pkgList,
          getNpmMetadata: async (pkgList) => pkgList,
          getPyMetadata: async (pkgList) =>
            pkgList.map((pkg) => ({
              ...pkg,
              properties: [
                ...(pkg.properties || []),
                { name: "cdx:pypi:trustedPublishing", value: "true" },
                { name: "cdx:pypi:uploaderVerified", value: "true" },
              ],
            })),
        },
      });

    await enrichWithMock(inputBoms);

    assert.ok(
      inputBoms[0].bomJson.components[0].properties.some(
        (property) => property.name === "cdx:pypi:trustedPublishing",
      ),
    );
  });

  it("adds registry metadata for cargo targets", async () => {
    const inputBoms = [
      {
        bomJson: makeBom([
          {
            "bom-ref": "pkg:cargo/serde@1.0.217",
            name: "serde",
            purl: "pkg:cargo/serde@1.0.217",
          },
        ]),
        source: "cargo-enrichment.json",
      },
    ];
    const { enrichInputBomsWithRegistryMetadata: enrichWithMock } =
      await esmock("./targets.js", {
        "../helpers/utils.js": {
          getCratesMetadata: async (pkgList) =>
            pkgList.map((pkg) => ({
              ...pkg,
              properties: [
                ...(pkg.properties || []),
                { name: "cdx:cargo:trustedPublishing", value: "true" },
                { name: "cdx:cargo:yanked", value: "true" },
              ],
            })),
          getNpmMetadata: async (pkgList) => pkgList,
          getPyMetadata: async (pkgList) => pkgList,
        },
      });

    await enrichWithMock(inputBoms);

    assert.ok(
      inputBoms[0].bomJson.components[0].properties.some(
        (property) => property.name === "cdx:cargo:trustedPublishing",
      ),
    );
    assert.ok(
      inputBoms[0].bomJson.components[0].properties.some(
        (property) => property.name === "cdx:cargo:yanked",
      ),
    );
  });
});
