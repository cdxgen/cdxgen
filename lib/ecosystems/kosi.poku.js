import { assert, describe, it } from "poku";

import {
  collectKosiEvidence,
  collectKosiServices,
  isKosiKotlinLanguage,
  kosiDisabled,
  mergeKosiEvidence,
} from "./kosi.js";

// The BOM side of the join: cdxgen resolves Kotlin dependencies to maven
// purls, while kosi — which reads an OFFLINE classpath and never runs the
// build — names the same jars pkg:generic/<file>@<version>. Every join in
// this module has to bridge those two namings by name.
const components = [
  {
    name: "kotlin-sample-app",
    purl: "pkg:maven/com.example/kotlin-sample-app@1.0.0?type=jar",
  },
  {
    name: "timber",
    purl: "pkg:maven/com.jakewharton.timber/timber@5.0.1?type=jar",
  },
];

const workspacePurl = "pkg:generic/kotlin-sample-app@unspecified";
const timberPurl = "pkg:generic/timber-5.0.1@unspecified";

function propertyValues(map, purl, name) {
  return (map[purl] || [])
    .filter((property) => property.name === name)
    .map((property) => property.value);
}

describe("kosi helpers", () => {
  it("recognizes Kotlin language aliases", () => {
    assert.strictEqual(isKosiKotlinLanguage("kotlin"), true);
    assert.strictEqual(isKosiKotlinLanguage("kt"), true);
    assert.strictEqual(isKosiKotlinLanguage("KOTLIN"), true);
    assert.strictEqual(isKosiKotlinLanguage("java"), false);
    assert.strictEqual(isKosiKotlinLanguage(undefined), false);
  });

  it("is disabled by CDXGEN_KOSI_DISABLE, and only by its documented values", () => {
    const previous = process.env.CDXGEN_KOSI_DISABLE;
    try {
      for (const value of ["1", "true", "all", "TRUE"]) {
        process.env.CDXGEN_KOSI_DISABLE = value;
        assert.strictEqual(
          kosiDisabled(),
          true,
          `expected ${value} to disable kosi`,
        );
      }
      for (const value of ["0", "false", ""]) {
        process.env.CDXGEN_KOSI_DISABLE = value;
        assert.strictEqual(
          kosiDisabled(),
          false,
          `expected ${value} to leave kosi enabled`,
        );
      }
    } finally {
      if (previous === undefined) {
        delete process.env.CDXGEN_KOSI_DISABLE;
      } else {
        process.env.CDXGEN_KOSI_DISABLE = previous;
      }
    }
  });

  it("joins a workspace-local crypto flow to the project component", () => {
    // The regression this test exists for: crypto-flow was the one evidence
    // kind that resolved purls by EXACT match while the other four used the
    // name fallback, so a `hardcoded-secret -> crypto-asset` flow — always
    // workspace-local, hence always a pkg:generic purl — attached to
    // nothing, and the end-to-end gate failed on `no crypto-flow evidence`.
    const report = {
      crypto: {
        materials: [{ name: "apiKey", kind: "secret", function: "loadConfig" }],
      },
      dataFlow: {
        slices: [
          {
            sourceCategory: "hardcoded-secret",
            sinkCategory: "crypto-asset",
            purls: [workspacePurl],
          },
        ],
      },
    };
    const evidence = collectKosiEvidence(report, components);
    assert.deepStrictEqual(
      propertyValues(
        evidence.componentPropertiesMap,
        "pkg:maven/com.example/kotlin-sample-app@1.0.0?type=jar",
        "cdx:kosi:cryptoFlow",
      ),
      ["hardcoded-secret->crypto-asset"],
    );
    assert.strictEqual(evidence.cryptoComponents.length, 1);
    assert.strictEqual(
      evidence.cryptoComponents[0].cryptoProperties.assetType,
      "related-crypto-material",
    );
  });

  it("joins an offline pkg:generic jar purl to its resolved maven component", () => {
    const report = {
      usages: [
        {
          purl: timberPurl,
          position: { filename: "src/main/kotlin/App.kt", line: 12, column: 3 },
        },
      ],
    };
    const evidence = collectKosiEvidence(report, components);
    assert.deepStrictEqual(
      Array.from(
        evidence.purlLocationMap[
          "pkg:maven/com.jakewharton.timber/timber@5.0.1?type=jar"
        ] || [],
      ),
      ["src/main/kotlin/App.kt#12"],
    );
  });

  it("invents no purl for a dependency the BOM does not carry", () => {
    const report = {
      usages: [
        {
          purl: "pkg:generic/not-in-the-bom-1.0@unspecified",
          position: { filename: "src/main/kotlin/App.kt", line: 1 },
        },
      ],
    };
    const evidence = collectKosiEvidence(report, components);
    assert.deepStrictEqual(Object.keys(evidence.purlLocationMap), []);
  });

  it("merges the reachable pass without duplicating what the all pass found", () => {
    const report = {
      usages: [
        {
          purl: timberPurl,
          position: { filename: "src/main/kotlin/App.kt", line: 12 },
        },
      ],
    };
    const all = collectKosiEvidence(report, components);
    const merged = mergeKosiEvidence(
      all,
      collectKosiEvidence(report, components),
    );
    const maven = "pkg:maven/com.jakewharton.timber/timber@5.0.1?type=jar";
    assert.strictEqual(merged.purlLocationMap[maven].size, 1);
    assert.strictEqual(merged.cryptoComponents.length, 0);
  });

  it("carries services[] rows through, skipping rows without an id or name", () => {
    const servicesMap = collectKosiServices(
      {
        services: [
          {
            id: "svc-1",
            name: "orders",
            endpoints: ["/orders", "/orders/{id}"],
          },
          { id: "svc-2" },
          { name: "no-id" },
        ],
      },
      {},
    );
    assert.deepStrictEqual(Object.keys(servicesMap), ["svc-1"]);
    assert.deepStrictEqual(Array.from(servicesMap["svc-1"].endpoints).sort(), [
      "/orders",
      "/orders/{id}",
    ]);
  });

  it("returns empty evidence for an empty report rather than throwing", () => {
    const evidence = collectKosiEvidence({}, components);
    assert.deepStrictEqual(evidence.purlLocationMap, {});
    assert.deepStrictEqual(evidence.componentPropertiesMap, {});
    assert.deepStrictEqual(evidence.cryptoComponents, []);
  });
});
