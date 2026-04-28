import { assert, describe, it } from "poku";

import {
  collectAuditTargets,
  extractPurlTargetsFromBom,
  isRequiredComponentScope,
  normalizePackageName,
} from "./targets.js";

function makeBom(components) {
  return {
    bomFormat: "CycloneDX",
    components,
    specVersion: "1.6",
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
  it("extracts only npm and pypi purls", () => {
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
        "bom-ref": "pkg:gem/rails@8.0.0",
        name: "rails",
        purl: "pkg:gem/rails@8.0.0",
      },
    ]);

    const extracted = extractPurlTargetsFromBom(bom, "bom.json");

    assert.strictEqual(extracted.targets.length, 2);
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
