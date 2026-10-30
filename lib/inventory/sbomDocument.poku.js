import { strict as assert, describe, it } from "poku";

import {
  MAX_SBOM_DOCUMENT_BYTES,
  parseSbomDocument,
  repairPurl,
  tagSbomComponents,
} from "./sbomDocument.js";

describe("parseSbomDocument()", () => {
  it("reads components, dependencies and the root ref from CycloneDX", () => {
    const parsed = parseSbomDocument(
      JSON.stringify({
        bomFormat: "CycloneDX",
        specVersion: "1.6",
        metadata: { component: { "bom-ref": "root-ref", name: "dist" } },
        components: [{ name: "bundled", "bom-ref": "bundled-ref" }],
        dependencies: [{ ref: "root-ref", dependsOn: ["bundled-ref"] }],
      }),
      { source: "wheel" },
    );
    assert.strictEqual(parsed.format, "cyclonedx-1.6");
    assert.strictEqual(parsed.rootRef, "root-ref");
    assert.strictEqual(parsed.components.length, 1);
    assert.deepStrictEqual(parsed.dependencies[0].dependsOn, ["bundled-ref"]);
  });

  it("reads packages out of SPDX 2.x JSON", () => {
    const parsed = parseSbomDocument(
      JSON.stringify({
        spdxVersion: "SPDX-2.3",
        packages: [
          {
            name: "libfoo",
            SPDXID: "SPDXRef-libfoo",
            versionInfo: "1.2.3",
            externalRefs: [
              {
                referenceType: "purl",
                referenceLocator: "pkg:generic/libfoo@1.2.3",
              },
            ],
          },
        ],
      }),
      { source: "sboms/libfoo.spdx.json" },
    );
    assert.strictEqual(parsed.format, "spdx-SPDX-2.3");
    assert.strictEqual(parsed.components[0].purl, "pkg:generic/libfoo@1.2.3");
    assert.strictEqual(
      parsed.components[0]["bom-ref"],
      "pkg:generic/libfoo@1.2.3",
    );
  });

  it("rejects a document that is not JSON, not an SBOM, or empty", () => {
    assert.strictEqual(parseSbomDocument("not json", {}), null);
    assert.strictEqual(parseSbomDocument("", {}), null);
    assert.strictEqual(parseSbomDocument(JSON.stringify({ a: 1 }), {}), null);
    // CycloneDX without a specVersion is unusable, however well-formed.
    assert.strictEqual(
      parseSbomDocument(
        JSON.stringify({ bomFormat: "CycloneDX", components: [{ name: "x" }] }),
        {},
      ),
      null,
    );
  });

  it("refuses a document over the size bound instead of parsing it", () => {
    const oversized = `{"bomFormat":"CycloneDX","specVersion":"1.6","note":"${"x".repeat(
      MAX_SBOM_DOCUMENT_BYTES,
    )}"}`;
    assert.strictEqual(parseSbomDocument(oversized, { source: "big" }), null);
  });
});

describe("repairPurl()", () => {
  const repaired = (purl) => {
    const component = { purl };
    repairPurl(component);
    return component.purl;
  };

  it("escapes a reserved character anywhere a producer left it raw", () => {
    assert.strictEqual(
      repaired("pkg:file/libstdc++.so.6"),
      "pkg:file/libstdc%2B%2B.so.6",
    );
    assert.strictEqual(
      repaired("pkg:file/libc++.1.dylib@1300.36.0?compatibility_version=1.0.0"),
      "pkg:file/libc%2B%2B.1.dylib@1300.36.0?compatibility_version=1.0.0",
    );
    assert.strictEqual(
      repaired("pkg:cargo/toml@1.1.3+spec-1.1.0"),
      "pkg:cargo/toml@1.1.3%2Bspec-1.1.0",
    );
    assert.strictEqual(
      repaired("pkg:npm/@scope/pkg@1.0.0"),
      "pkg:npm/%40scope/pkg@1.0.0",
    );
  });

  it("escapes a download_url but drops a file: one", () => {
    assert.strictEqual(
      repaired("pkg:generic/openssl@4.0.1?download_url=https://example/o.tgz"),
      "pkg:generic/openssl@4.0.1?download_url=https:%2F%2Fexample%2Fo.tgz",
    );
    assert.strictEqual(
      repaired("pkg:cargo/uv-audit@0.0.70?download_url=file://../uv-audit"),
      "pkg:cargo/uv-audit@0.0.70",
    );
  });

  it("leaves a well-formed purl and a non-purl alone", () => {
    assert.strictEqual(
      repaired("pkg:golang/github.com/a/b@v1.2.3#sub/dir"),
      "pkg:golang/github.com/a/b@v1.2.3#sub/dir",
    );
    assert.strictEqual(repaired("not-a-purl"), "not-a-purl");
    assert.strictEqual(repaired(undefined), undefined);
  });
});

describe("tagSbomComponents()", () => {
  it("appends provenance properties and skips valueless ones", () => {
    const components = [{ name: "a" }, null, { name: "b", properties: [] }];
    tagSbomComponents(components, [
      { name: "cdx:tea:source", value: "https://example/bom.json" },
      { name: "cdx:tea:collection", value: undefined },
    ]);
    assert.deepStrictEqual(components[0].properties, [
      { name: "cdx:tea:source", value: "https://example/bom.json" },
    ]);
    assert.strictEqual(components[2].properties.length, 1);
  });
});
