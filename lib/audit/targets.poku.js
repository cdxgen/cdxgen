import { assert, describe, it } from "poku";

import {
  collectAuditTargets,
  extractPurlTargetsFromBom,
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

describe("collectAuditTargets()", () => {
  it("deduplicates targets across multiple BOMs while preserving sources", () => {
    const inputBoms = [
      {
        bomJson: makeBom([
          {
            "bom-ref": "pkg:npm/left-pad@1.3.0",
            name: "left-pad",
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

    const collected = collectAuditTargets(inputBoms);

    assert.strictEqual(collected.targets.length, 2);
    const npmTarget = collected.targets.find((target) => target.type === "npm");
    assert.deepStrictEqual(npmTarget.sources, ["one.json", "two.json"]);
    assert.strictEqual(npmTarget.bomRefs.length, 1);
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
});
