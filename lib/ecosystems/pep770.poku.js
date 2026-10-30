import { join } from "node:path";

import { strict as assert, describe, it } from "poku";

import { _internals, collectEmbeddedSboms } from "./pep770.js";

const fixtureRoot = join(
  import.meta.dirname,
  "..",
  "..",
  "test",
  "data",
  "pep770-repotest",
);
const metadataFile = join(
  fixtureRoot,
  "lib",
  "site-packages",
  "demo_pkg-1.0.0.dist-info",
  "METADATA",
);

describe("collectEmbeddedSboms()", () => {
  it("discovers and parses a CycloneDX SBOM embedded under .dist-info/sboms/", async () => {
    const result = await collectEmbeddedSboms({
      metadataFiles: [metadataFile],
      whlFiles: [],
    });
    assert.strictEqual(result.components.length, 1);
    const component = result.components[0];
    assert.strictEqual(component.name, "bundled-lib");
    // Provenance is recorded on every embedded component.
    assert.ok(
      component.properties.some(
        (p) =>
          p.name === "cdx:embeddedSbom:source" && p.value === "demo_pkg-1.0.0",
      ),
    );
    assert.ok(
      component.properties.some(
        (p) =>
          p.name === "cdx:embeddedSbom:format" && p.value === "cyclonedx-1.5",
      ),
    );
    // The dependency graph from the embedded SBOM is preserved, rebased onto
    // the distribution's own bom-ref so bundled components are children of it.
    assert.strictEqual(result.dependencies.length, 1);
    assert.strictEqual(result.dependencies[0].ref, "pkg:pypi/demo-pkg@1.0.0");
    assert.deepStrictEqual(result.dependencies[0].dependsOn, [
      "pkg:pypi/bundled-lib@2.3.4",
    ]);
    // A citation attributes the embedded data to the distribution component.
    assert.strictEqual(result.citations.length, 1);
    assert.strictEqual(
      result.citations[0].attributedTo,
      "pkg:pypi/demo-pkg@1.0.0",
    );
    assert.ok(result.citations[0].note.includes("PEP 770"));
  });

  it("returns nothing for a distribution with no sboms directory", async () => {
    const result = await collectEmbeddedSboms({
      metadataFiles: [join(fixtureRoot, "nonexistent.dist-info", "METADATA")],
      whlFiles: [],
    });
    assert.strictEqual(result.components.length, 0);
    assert.strictEqual(result.citations.length, 0);
  });

  it("discovers embedded SBOMs inside a wheel archive", async () => {
    const whlFile = join(fixtureRoot, "demo_pkg-1.0.0-py3-none-any.whl");
    const result = await collectEmbeddedSboms({
      metadataFiles: [],
      whlFiles: [whlFile],
    });
    assert.strictEqual(result.components.length, 1);
    assert.strictEqual(result.components[0].name, "bundled-lib");
    assert.ok(
      result.components[0].properties.some(
        (p) => p.name === "cdx:embeddedSbom:source",
      ),
    );
    // The distribution ref is resolved from the wheel's METADATA entry.
    assert.strictEqual(result.dependencies[0].ref, "pkg:pypi/demo-pkg@1.0.0");
    assert.strictEqual(
      result.citations[0].attributedTo,
      "pkg:pypi/demo-pkg@1.0.0",
    );
  });
});

describe("parseEmbeddedSbom() (internals)", () => {
  it("skips an oversized document", () => {
    const huge = "x".repeat(_internals.MAX_EMBEDDED_SBOM_BYTES + 1);
    assert.strictEqual(
      _internals.parseEmbeddedSbom(huge, "big.bin", "demo"),
      null,
    );
  });

  it("skips invalid JSON", () => {
    assert.strictEqual(
      _internals.parseEmbeddedSbom("{not json", "bad.json", "demo"),
      null,
    );
  });

  it("skips a CycloneDX document missing specVersion", () => {
    assert.strictEqual(
      _internals.parseEmbeddedSbom(
        JSON.stringify({ bomFormat: "CycloneDX" }),
        "bad.cdx.json",
        "demo",
      ),
      null,
    );
  });

  it("parses an SPDX 2.x document into components", () => {
    const spdx = {
      spdxVersion: "SPDX-2.3",
      packages: [
        {
          name: "spdx-lib",
          SPDXID: "SPDXRef-Package",
          versionInfo: "9.9.9",
          externalRefs: [
            {
              referenceType: "purl",
              referenceLocator: "pkg:pypi/spdx-lib@9.9.9",
            },
          ],
        },
      ],
    };
    const parsed = _internals.parseEmbeddedSbom(
      JSON.stringify(spdx),
      "spdx.json",
      "demo",
    );
    assert.ok(parsed);
    assert.strictEqual(parsed.components[0].name, "spdx-lib");
    assert.strictEqual(parsed.components[0].purl, "pkg:pypi/spdx-lib@9.9.9");
    assert.ok(parsed.format.startsWith("spdx"));
  });
});

describe("rebaseDependencies()", () => {
  it("rewrites the embedded root ref to the cdxgen distribution ref", () => {
    const deps = [
      { ref: "embedded-root", dependsOn: ["pkg:pypi/bundled@1.0.0"] },
      { ref: "pkg:pypi/bundled@1.0.0", dependsOn: [] },
    ];
    const rebased = _internals.rebaseDependencies(
      deps,
      "pkg:pypi/demo@1.0.0",
      "embedded-root",
    );
    assert.strictEqual(rebased[0].ref, "pkg:pypi/demo@1.0.0");
    assert.strictEqual(rebased[1].ref, "pkg:pypi/bundled@1.0.0");
  });
});
